// Poster pass: fetch OpenFreeMap vector tiles (the same source Terraink uses),
// decode, project, and write a true-vector layered SVG per map.
//
//   node tools/export/export-map.mjs abq            # one map, home panel size
//   node tools/export/export-map.mjs --all          # every map
//   node tools/export/export-map.mjs abq --site work
//
// Output: maps/<id>.svg (open in a browser/Inkscape) and maps/<id>.js
// (the same SVG registered on window.ATLAS_MAPS so the page works from file://).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Pbf from "pbf";
import { VectorTile } from "@mapbox/vector-tile";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
try { await import(pathToFileURL(path.join(ROOT, "config/monitors.local.js")).href); } catch {}
await import(pathToFileURL(path.join(ROOT, "config/atlas.config.js")).href);
const CONFIG = globalThis.ATLAS_CONFIG;
const THEMES = { ...JSON.parse(await fs.readFile(path.join(ROOT, "tools/terraink/src/data/themes.json"), "utf8")).themes, ...CONFIG.themes };

const TILE = 512, EXTENT = 4096, MAX_TILE_ZOOM = 14;
const TILE_URL = "https://tiles.openfreemap.org/planet/20260816_080001_pt/{z}/{x}/{y}.pbf";
const CACHE = path.join(ROOT, ".cache/tiles");

// Road tiers mirror Terraink's maplibreStyle.ts so its themes map 1:1.
const ROAD_TIERS = {
  major: ["motorway"],
  high: ["primary", "primary_link", "secondary", "secondary_link", "motorway_link", "trunk", "trunk_link"],
  mid: ["tertiary", "tertiary_link", "minor"],
  low: ["residential", "living_street", "unclassified", "road", "street", "street_limited", "service"],
  path: ["path", "pedestrian", "cycleway", "track"],
};
const RAIL = ["rail", "transit"];
const tierOf = (cls) => Object.keys(ROAD_TIERS).find((t) => ROAD_TIERS[t].includes(cls));

// Which layers/tiers to draw and stroke widths (px) per map-zoom band.
function styleFor(zoom) {
  if (zoom < 7)  return { tiers: ["major", "high"],                      w: { major: 1.6, high: 0.7, mid: 0,   low: 0,   path: 0,   rail: 0.5, waterway: 0.8 }, buildings: false, landcover: true };
  if (zoom < 10) return { tiers: ["major", "high", "mid"],               w: { major: 2.2, high: 1.2, mid: 0.6, low: 0,   path: 0,   rail: 0.6, waterway: 1.0 }, buildings: false, landcover: true };
  if (zoom < 12) return { tiers: ["major", "high", "mid", "low"],        w: { major: 3.2, high: 2.0, mid: 1.2, low: 0.6, path: 0,   rail: 0.8, waterway: 1.4 }, buildings: false, landcover: true };
  return              { tiers: ["major", "high", "mid", "low", "path"], w: { major: 4.5, high: 3.0, mid: 1.8, low: 1.0, path: 0.5, rail: 1.0, waterway: 1.8 }, buildings: true,  landcover: false };
}

const worldSize = (z) => TILE * Math.pow(2, z);
function project(lon, lat, z) {
  const s = worldSize(z);
  const x = ((lon + 180) / 360) * s;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * s;
  return [x, y];
}

async function fetchTile(z, x, y) {
  const file = path.join(CACHE, `${z}-${x}-${y}.pbf`);
  try { return await fs.readFile(file); } catch {}
  const url = TILE_URL.replace("{z}", z).replace("{x}", x).replace("{y}", y);
  const res = await fetch(url, { headers: { "User-Agent": "project-atlas-export/0.1 (personal wallpaper)" } });
  await fs.mkdir(CACHE, { recursive: true });
  if (res.status === 404 || res.status === 204) { await fs.writeFile(file, Buffer.alloc(0)); return Buffer.alloc(0); }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(file, buf);
  return buf;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export async function exportMap(id, { site = CONFIG.defaultSite } = {}) {
  const map = CONFIG.maps[id];
  if (!map) throw new Error(`unknown map "${id}"`);
  const mon = CONFIG.resolveMonitors(site).find((m) => [m.fixed, m.active, m.idle].includes(id));
  if (!mon) throw new Error(`map "${id}" is not assigned to a monitor at site "${site}"`);
  const W = mon.w, H = mon.h, zoom = map.zoom;
  const theme = THEMES[map.theme];
  if (!theme) throw new Error(`unknown theme "${map.theme}"`);
  const style = styleFor(zoom);

  const tz = Math.min(MAX_TILE_ZOOM, Math.floor(zoom));
  const scale = Math.pow(2, zoom - tz); // tile-zoom px -> map px
  const [cx, cy] = project(map.center[0], map.center[1], tz);
  const left = cx - W / 2 / scale, top = cy - H / 2 / scale;
  const right = cx + W / 2 / scale, bottom = cy + H / 2 / scale;
  const tx0 = Math.floor(left / TILE), tx1 = Math.floor((right - 1e-9) / TILE);
  const ty0 = Math.floor(top / TILE), ty1 = Math.floor((bottom - 1e-9) / TILE);
  const n = Math.pow(2, tz);

  const groups = { landcover: [], park: [], water: [], waterway: [], aeroway: [], building: [], rail: [] };
  for (const t of Object.keys(ROAD_TIERS)) groups["road-" + t] = [];

  const toPx = (tx, ty, pt) => [
    (tx * TILE + (pt.x / EXTENT) * TILE - left) * scale,
    (ty * TILE + (pt.y / EXTENT) * TILE - top) * scale,
  ];
  const pathData = (tx, ty, rings, close) => {
    let d = "", any = false;
    for (const ring of rings) {
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, s = "";
      let lx, ly;
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = toPx(tx, ty, ring[i]);
        const rx = Math.round(x * 10) / 10, ry = Math.round(y * 10) / 10;
        if (i && rx === lx && ry === ly) continue;
        s += (s ? "L" : "M") + rx + " " + ry;
        lx = rx; ly = ry;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
      if (maxx < -8 || minx > W + 8 || maxy < -8 || miny > H + 8) continue; // off-canvas
      d += s + (close ? "Z" : "");
      any = true;
    }
    return any ? d : null;
  };

  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
  console.log(`[${id}] ${W}x${H} zoom ${zoom} theme ${map.theme} — ${jobs.length} tiles at z${tz}`);

  const worker = async () => {
    for (;;) {
      const job = jobs.shift(); if (!job) return;
      const [tx, ty] = job;
      const buf = await fetchTile(tz, ((tx % n) + n) % n, ty);
      if (!buf.length) continue;
      const tile = new VectorTile(new Pbf(buf));
      const each = (layerName, fn) => {
        const layer = tile.layers[layerName]; if (!layer) return;
        for (let i = 0; i < layer.length; i++) fn(layer.feature(i));
      };
      const push = (key, f, close, extra = "") => {
        const d = pathData(tx, ty, f.loadGeometry(), close);
        if (d) groups[key].push(`<path${extra} d="${d}"/>`);
      };
      if (style.landcover) each("landcover", (f) => f.type === 3 && push("landcover", f, true));
      each("park", (f) => f.type === 3 && push("park", f, true));
      each("water", (f) => f.type === 3 && push("water", f, true));
      each("waterway", (f) => f.type === 2 && ["river", "canal", "stream", "ditch"].includes(f.properties.class) && push("waterway", f, false));
      each("aeroway", (f) => f.type === 3 && push("aeroway", f, true));
      if (style.buildings) each("building", (f) => f.type === 3 && push("building", f, true));
      each("transportation", (f) => {
        if (f.type !== 2) return;
        const cls = f.properties.class;
        if (RAIL.includes(cls)) return push("rail", f, false);
        const tier = tierOf(cls);
        if (tier && style.tiers.includes(tier)) push("road-" + tier, f, false, ` class="${cls}"`);
      });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  const m = theme.map, r = m.roads, w = style.w;
  const S = `svg[data-map="${id}"]`;
  const css = `
    ${S}{--land:${m.land};--landcover:${m.landcover};--water:${m.water};--waterway:${m.waterway};--parks:${m.parks};--buildings:${m.buildings};--aeroway:${m.aeroway};--rail:${m.rail};--road-major:${r.major};--road-high:${r.minor_high};--road-mid:${r.minor_mid};--road-low:${r.minor_low};--road-path:${r.path};--road-outline:${r.outline};--text:${theme.ui.text}}
    ${S} .land{fill:var(--land)} ${S} .landcover path{fill:var(--landcover);fill-opacity:.7} ${S} .park path{fill:var(--parks)} ${S} .water path{fill:var(--water)}
    ${S} .aeroway path{fill:var(--aeroway);fill-opacity:.85} ${S} .building path{fill:var(--buildings);fill-opacity:.9}
    ${S} .line path{fill:none;stroke-linecap:round;stroke-linejoin:round}
    ${S} .waterway path{stroke:var(--waterway);stroke-width:${w.waterway}}
    ${S} .rail path{stroke:var(--rail);stroke-width:${w.rail};stroke-opacity:.6;stroke-dasharray:${w.rail * 2} ${w.rail * 1.6}}
    ${S} .road-path path{stroke:var(--road-path);stroke-width:${w.path}} ${S} .road-low path{stroke:var(--road-low);stroke-width:${w.low}}
    ${S} .road-mid path{stroke:var(--road-mid);stroke-width:${w.mid}} ${S} .road-high path{stroke:var(--road-high);stroke-width:${w.high}}
    ${S} .road-major path{stroke:var(--road-major);stroke-width:${w.major}}
    ${S} .label{fill:var(--text);font-family:"Instrument Sans","Segoe UI",sans-serif}
  `.replace(/\s+/g, " ").trim();

  const order = ["landcover", "park", "water", "waterway", "aeroway", "building", "rail", "road-path", "road-low", "road-mid", "road-high", "road-major"];
  const lineKeys = new Set(["waterway", "rail", "road-path", "road-low", "road-mid", "road-high", "road-major"]);
  const body = order
    .filter((k) => groups[k].length)
    .map((k) => `<g id="layer-${k}" class="${k}${lineKeys.has(k) ? " line" : ""}" data-count="${groups[k].length}">\n${groups[k].join("\n")}\n</g>`)
    .join("\n");
  const fadeH = Math.round(H * 0.22);
  const big = Math.min(W, H);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" data-map="${id}" data-theme="${map.theme}" data-zoom="${zoom}">
<style>${css}</style>
<defs>
  <linearGradient id="fade-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${m.land}" stop-opacity="1"/><stop offset="1" stop-color="${m.land}" stop-opacity="0"/></linearGradient>
</defs>
<rect id="layer-land" class="land" width="${W}" height="${H}"/>
${body}
<g id="layer-fades"><rect width="${W}" height="${fadeH}" fill="url(#fade-${id})"/><rect width="${W}" height="${fadeH}" fill="url(#fade-${id})" transform="translate(0 ${H}) scale(1 -1)"/></g>
<g id="layer-labels">
  <text class="label" x="${W / 2}" y="${H - Math.round(H * 0.085)}" text-anchor="middle" font-size="${Math.round(big * 0.075)}" letter-spacing="${Math.round(big * 0.02)}" font-weight="600">${esc(map.title.toUpperCase())}</text>
  <text class="label" x="${W / 2}" y="${H - Math.round(H * 0.05)}" text-anchor="middle" font-size="${Math.round(big * 0.02)}" letter-spacing="${Math.round(big * 0.006)}" fill-opacity=".8">${esc(map.subtitle)}</text>
</g>
</svg>`;

  await fs.mkdir(path.join(ROOT, "maps"), { recursive: true });
  const suffix = site === CONFIG.defaultSite ? "" : "." + site;
  await fs.writeFile(path.join(ROOT, `maps/${id}${suffix}.svg`), svg);
  await fs.writeFile(path.join(ROOT, `maps/${id}${suffix}.js`), `(window.ATLAS_MAPS=window.ATLAS_MAPS||{})[${JSON.stringify(id)}]=${JSON.stringify(svg)};\n`);
  const counts = Object.fromEntries(order.filter((k) => groups[k].length).map((k) => [k, groups[k].length]));
  console.log(`[${id}] wrote maps/${id}${suffix}.svg (${(svg.length / 1048576).toFixed(1)} MB)`, counts);
}

const args = process.argv.slice(2);
const siteIdx = args.indexOf("--site");
const site = siteIdx >= 0 ? args[siteIdx + 1] : CONFIG.defaultSite;
const ids = args.includes("--all") ? Object.keys(CONFIG.maps) : args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--site");
if (!ids.length) { console.error("usage: export-map.mjs <mapId...>|--all [--site home|work]"); process.exit(1); }
for (const id of ids) await exportMap(id, { site });
