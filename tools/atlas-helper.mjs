// Atlas helper daemon: a local CORS proxy for data sources that refuse browser
// requests. Currently just ADS-B (adsb.lol sends no Access-Control-Allow-Origin,
// so the wallpaper page cannot fetch it directly; this proxy adds the header).
//
//   node tools/atlas-helper.mjs         ->  http://127.0.0.1:8766/adsb/{lat}/{lon}/{distNm}
//
// Responses are cached for 8s per rounded position so multiple panels/instances
// (wallpaper + screensaver) share one upstream request. If this daemon is not
// running, the planes layer is simply absent — everything else is unaffected.
import http from "node:http";

const PORT = 8766;
const UPSTREAM = "https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{dist}";
const CACHE_MS = 8000;
const cache = new Map(); // key -> { ts, body }

http.createServer(async (req, res) => {
  const m = req.url.match(/^\/adsb\/(-?[\d.]+)\/(-?[\d.]+)\/(\d+)$/);
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (!m) { res.writeHead(404, headers); return res.end('{"error":"use /adsb/{lat}/{lon}/{distNm}"}'); }
  const key = Math.round(m[1] * 10) + ":" + Math.round(m[2] * 10) + ":" + m[3];
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_MS) { res.writeHead(200, headers); return res.end(hit.body); }
  try {
    const url = UPSTREAM.replace("{lat}", m[1]).replace("{lon}", m[2]).replace("{dist}", Math.min(250, m[3]));
    const up = await fetch(url, { headers: { "User-Agent": "project-atlas-helper/0.1 (personal wallpaper)" } });
    if (!up.ok) throw new Error("upstream HTTP " + up.status);
    const body = await up.text();
    cache.set(key, { ts: Date.now(), body });
    res.writeHead(200, headers); res.end(body);
  } catch (e) {
    res.writeHead(502, headers); res.end(JSON.stringify({ error: String(e.message || e) }));
  }
}).listen(PORT, "127.0.0.1", () => console.log("atlas-helper on http://127.0.0.1:" + PORT));
