// Atlas helper daemon: a local CORS proxy for data sources that refuse browser
// requests. Currently just ADS-B (adsb.lol sends no Access-Control-Allow-Origin,
// so the wallpaper page cannot fetch it directly; this proxy adds the header).
//
//   node tools/atlas-helper.mjs         ->  http://127.0.0.1:8766/adsb/{lat}/{lon}/{distNm}
//
// Responses are cached for 8s per rounded position so multiple panels/instances
// (wallpaper + screensaver) share one upstream request; concurrent identical
// requests share one in-flight fetch. On upstream 429/5xx the key backs off
// (60s, doubling to 15min) and is answered with 503 + Retry-After without
// contacting upstream. If this daemon is not running, the planes layer is simply
// absent — everything else is unaffected.
// Env overrides (for tests): ATLAS_HELPER_PORT, ATLAS_UPSTREAM ({lat}/{lon}/{dist} template).
import http from "node:http";

const PORT = Number(process.env.ATLAS_HELPER_PORT) || 8766;
const UPSTREAM = process.env.ATLAS_UPSTREAM || "https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{dist}";
const CACHE_MS = 8000;
const EVICT_MS = 60000;
const BACKOFF_START_MS = 60000;
const BACKOFF_MAX_MS = 15 * 60000;
const FETCH_TIMEOUT_MS = 10000;
const cache = new Map();    // key -> { ts, body }
const inflight = new Map(); // key -> Promise<body>
const backoff = new Map();  // key -> { until, ms }

class UpstreamError extends Error {
  constructor(status, retryAfterMs) { super("upstream HTTP " + status); this.status = status; this.retryAfterMs = retryAfterMs; }
}

function evict() {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.ts > EVICT_MS) cache.delete(k);
  for (const [k, v] of backoff) if (now > v.until + EVICT_MS && !inflight.has(k)) backoff.delete(k);
}
setInterval(evict, EVICT_MS).unref();

async function fetchUpstream(key, m) {
  const url = UPSTREAM.replace("{lat}", m[1]).replace("{lon}", m[2]).replace("{dist}", Math.min(250, m[3]));
  try {
    const up = await fetch(url, {
      headers: { "User-Agent": "project-atlas-helper/0.1 (personal wallpaper)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (up.status === 429 || up.status >= 500) {
      const prev = backoff.get(key);
      const ms = up.status === 429 && prev ? Math.min(prev.ms * 2, BACKOFF_MAX_MS) : (prev ? prev.ms : BACKOFF_START_MS);
      const ra = Number(up.headers.get("retry-after"));
      const wait = Math.max(ms, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0);
      backoff.set(key, { until: Date.now() + wait, ms });
      throw new UpstreamError(up.status, wait);
    }
    if (!up.ok) throw new UpstreamError(up.status, 0);
    const body = await up.text();
    backoff.delete(key);
    cache.set(key, { ts: Date.now(), body });
    return body;
  } finally {
    inflight.delete(key);
  }
}

http.createServer(async (req, res) => {
  const m = req.url.match(/^\/adsb\/(-?[\d.]+)\/(-?[\d.]+)\/(\d+)$/);
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (!m) { res.writeHead(404, headers); return res.end('{"error":"use /adsb/{lat}/{lon}/{distNm}"}'); }
  const key = Math.round(m[1] * 10) + ":" + Math.round(m[2] * 10) + ":" + m[3];
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_MS) { res.writeHead(200, headers); return res.end(hit.body); }
  const bo = backoff.get(key);
  if (bo && Date.now() < bo.until) {
    res.writeHead(503, { ...headers, "Retry-After": String(Math.ceil((bo.until - Date.now()) / 1000)) });
    return res.end('{"error":"upstream backoff"}');
  }
  try {
    let p = inflight.get(key);
    if (!p) { p = fetchUpstream(key, m); inflight.set(key, p); }
    const body = await p;
    res.writeHead(200, headers); res.end(body);
  } catch (e) {
    if (e instanceof UpstreamError && e.retryAfterMs) {
      res.writeHead(502, { ...headers, "Retry-After": String(Math.ceil(e.retryAfterMs / 1000)) });
    } else res.writeHead(502, headers);
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
}).listen(PORT, "127.0.0.1", () => console.log("atlas-helper on http://127.0.0.1:" + PORT));
