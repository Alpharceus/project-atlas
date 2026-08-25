/* Project Atlas — one page, three panels, five posters.
 * Milestones 2–4: static layout, ambient animation, state-driven mode switching.
 * Data modules (weather, planes, iss, terminator) register via ATLAS.modules. */
(function () {
  "use strict";
  const CFG = window.ATLAS_CONFIG;
  const MAPS = window.ATLAS_MAPS || {};
  const qs = new URLSearchParams(location.search);

  const siteId = qs.get("site") || window.ATLAS_SITE || CFG.defaultSite;
  const site = CFG.sites[siteId];
  if (!site) throw new Error("unknown site " + siteId);
  site.monitors = CFG.resolveMonitors(siteId);

  // ---- Layout: virtual desktop -> page coordinates -----------------------
  const minX = Math.min(...site.monitors.map((m) => m.x));
  const minY = Math.min(...site.monitors.map((m) => m.y));
  const maxX = Math.max(...site.monitors.map((m) => m.x + m.w));
  const maxY = Math.max(...site.monitors.map((m) => m.y + m.h));
  const root = document.getElementById("atlas");
  root.style.width = maxX - minX + "px";
  root.style.height = maxY - minY + "px";

  // `?fit=1` scales the whole span page into the browser window for development.
  function fit() {
    if (!qs.get("fit")) return;
    const s = Math.min(innerWidth / (maxX - minX), innerHeight / (maxY - minY));
    root.style.transform = "scale(" + s + ")";
  }
  addEventListener("resize", fit); fit();

  // ---- Panels ------------------------------------------------------------
  const ATLAS = (window.ATLAS = { config: CFG, site, siteId, panels: [], modules: {}, mode: "active" });

  function inlineSvg(slot, mapId) {
    const src = MAPS[mapId];
    if (!src) {
      slot.innerHTML = '<div class="missing">' + mapId + "<br><small>run: npm run export -- " + mapId + "</small></div>";
      return null;
    }
    slot.innerHTML = src;
    const svg = slot.querySelector("svg");
    svg.removeAttribute("width"); svg.removeAttribute("height");
    animate(svg);
    return svg;
  }

  // Ambient motion: traffic pulses on major/high roads, shimmer on water.
  function animate(svg) {
    const clone = (sel, cls, before) => {
      const g = svg.querySelector(sel); if (!g) return null;
      const c = g.cloneNode(true);
      c.removeAttribute("id"); c.setAttribute("class", cls);
      c.querySelectorAll("path").forEach((p) => p.removeAttribute("class"));
      if (before) g.before(c); else g.after(c);
      return c;
    };
    clone("#layer-road-major", "glowline", true); // static night glow (no filters)
    clone("#layer-water", "shimmer");
    clone("#layer-waterway", "shimmer line");
  }

  site.monitors.forEach((mon) => {
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.dataset.id = mon.id;
    Object.assign(panel.style, { left: mon.x - minX + "px", top: mon.y - minY + "px", width: mon.w + "px", height: mon.h + "px" });
    const entry = { monitor: mon, el: panel, slots: {} };
    const slotIds = mon.fixed ? { fixed: mon.fixed } : { idle: mon.idle, active: mon.active };
    for (const [role, mapId] of Object.entries(slotIds)) {
      const slot = document.createElement("div");
      slot.className = "slot " + role;
      slot.dataset.map = mapId;
      panel.appendChild(slot);
      entry.slots[role] = { el: slot, mapId, svg: inlineSvg(slot, mapId) };
    }
    const tint = document.createElement("div");
    tint.className = "tint";
    panel.appendChild(tint);
    entry.tint = tint;
    root.appendChild(panel);
    ATLAS.panels.push(entry);
  });

  // ---- Traffic lights (single canvas per panel, 30fps, loop-exact 60s) ----
  // getPointAtLength is sampled ONCE at startup into uniform-by-length point
  // arrays; each frame draws all dots into one canvas layer. No per-dot DOM,
  // no per-dot compositor layers; rAF stops automatically when Lively hides us.
  const TRAFFIC = { speed: { major: 90, high: 60 }, radius: { major: 2.2, high: 1.7 }, budget: 90, divisors: [5, 6, 10, 12, 15, 20, 30, 60], step: 24 };
  function samplePaths(layer) {
    // A single <path> may hold several disjoint subpaths (the exporter merges
    // rings). Split wherever consecutive samples jump farther than the step
    // allows, or a dot would draw straight chords between distant roads.
    const frags = [];
    for (const path of layer.querySelectorAll("path")) {
      const len = path.getTotalLength();
      if (len < 100) continue;
      const n = Math.floor(len / TRAFFIC.step) + 1;
      let pts = [];
      let px = 0, py = 0;
      for (let i = 0; i <= n; i++) {
        const pt = path.getPointAtLength(Math.min(i * TRAFFIC.step, len));
        if (pts.length && Math.hypot(pt.x - px, pt.y - py) > TRAFFIC.step * 2.5) {
          if (pts.length >= 6) frags.push(pts);
          pts = [];
        }
        pts.push(pt.x, pt.y);
        px = pt.x; py = pt.y;
      }
      if (pts.length >= 6) frags.push(pts);
    }
    return frags;
  }
  // The exporter splits roads at tile borders; without stitching, lights would
  // vanish mid-screen at invisible seams. Join fragments whose endpoints touch.
  function stitch(frags) {
    const key = (x, y) => Math.round(x / 3) * 100000 + Math.round(y / 3);
    const rev = (f) => { const o = []; for (let i = f.length - 2; i >= 0; i -= 2) o.push(f[i], f[i + 1]); return o; };
    const heads = new Map(), tails = new Map();
    const addTo = (m, k, v) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
    frags.forEach((f, i) => { addTo(heads, key(f[0], f[1]), i); addTo(tails, key(f[f.length - 2], f[f.length - 1]), i); });
    const used = new Array(frags.length).fill(false);
    const take = (m, k) => { const a = m.get(k); if (!a) return -1; while (a.length) { const i = a[a.length - 1]; if (used[i]) a.pop(); else return i; } return -1; };
    const chains = [];
    for (let i = 0; i < frags.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      let chain = frags[i].slice();
      for (let g = 0; g < 400; g++) { // forward
        const k = key(chain[chain.length - 2], chain[chain.length - 1]);
        let j = take(heads, k), r = false;
        if (j < 0) { j = take(tails, k); r = true; }
        if (j < 0) break;
        used[j] = true;
        const f = r ? rev(frags[j]) : frags[j];
        chain = chain.concat(f.slice(2));
      }
      for (let g = 0; g < 400; g++) { // backward
        const k = key(chain[0], chain[1]);
        let j = take(tails, k), r = false;
        if (j < 0) { j = take(heads, k); r = true; }
        if (j < 0) break;
        used[j] = true;
        const f = r ? rev(frags[j]) : frags[j];
        chain = f.slice(0, f.length - 2).concat(chain);
      }
      chains.push(chain);
    }
    return chains;
  }
  function buildDots(svg) {
    if (!svg) return [];
    const dots = []; let budget = TRAFFIC.budget;
    for (const tier of ["major", "high"]) {
      const layer = svg.querySelector("#layer-road-" + tier);
      if (!layer) continue;
      const chains = stitch(samplePaths(layer));
      chains.sort((a, b) => b.length - a.length);
      for (const c of chains) {
        if (budget <= 0) break;
        const len = (c.length / 2 - 1) * TRAFFIC.step;
        if (len < 300) continue;
        const ideal = len / TRAFFIC.speed[tier];
        const T = TRAFFIC.divisors.reduce((x, y) => (Math.abs(y - ideal) < Math.abs(x - ideal) ? y : x));
        const n = Math.min(Math.max(1, Math.round(len / 900)), budget);
        const pts = Float32Array.from(c);
        const loop = Math.hypot(c[0] - c[c.length - 2], c[1] - c[c.length - 1]) < 6;
        for (let k = 0; k < n; k++) { dots.push({ pts, T, off: k / n, tier, loop }); budget--; }
      }
    }
    return dots;
  }
  for (const p of ATLAS.panels) {
    const canvas = document.createElement("canvas");
    canvas.width = p.monitor.w; canvas.height = p.monitor.h;
    canvas.style.cssText = "position:absolute;inset:0;pointer-events:none";
    p.el.insertBefore(canvas, p.tint);
    p.trafficCtx = canvas.getContext("2d");
    p.trafficDots = {};
    for (const slot of Object.values(p.slots)) p.trafficDots[slot.mapId] = buildDots(slot.svg);
    p.night = 0;
  }
  function dotPos(d, fi, out) {
    const m = d.pts.length / 2 - 1;
    if (d.loop) fi = ((fi % m) + m) % m; else fi = Math.max(0, Math.min(m, fi));
    const i = Math.floor(fi), f = fi - i, i2 = Math.min(i + 1, m);
    out[0] = d.pts[2 * i] + (d.pts[2 * i2] - d.pts[2 * i]) * f;
    out[1] = d.pts[2 * i + 1] + (d.pts[2 * i2 + 1] - d.pts[2 * i + 1]) * f;
  }
  let lastFrame = 0;
  const P0 = [0, 0], P1 = [0, 0], P2 = [0, 0];
  function drawTraffic(ts) {
    requestAnimationFrame(drawTraffic);
    if (ts - lastFrame < 32) return; // ~30fps
    lastFrame = ts;
    const t = (performance.now() / 1000) % CFG.loopSeconds;
    for (const p of ATLAS.panels) {
      const ctx = p.trafficCtx;
      if (!ctx) continue;
      ctx.clearRect(0, 0, p.monitor.w, p.monitor.h);
      const mapId = p.slots.fixed ? p.slots.fixed.mapId : p.slots[ATLAS.mode].mapId;
      const dots = p.trafficDots[mapId];
      if (!dots || !dots.length) continue;
      const base = 0.5 + 0.45 * p.night;
      ctx.fillStyle = ctx.strokeStyle = "#FFE9A8";
      ctx.lineCap = "round";
      for (const d of dots) {
        const phase = ((t / d.T) + d.off) % 1;
        const m = d.pts.length / 2 - 1;
        const fi = phase * m;
        const ends = d.loop ? 1 : Math.min(1, phase * 12, (1 - phase) * 12); // fade at route ends, never pop
        const A = base * ends;
        if (A <= 0.02) continue;
        const r = TRAFFIC.radius[d.tier];
        dotPos(d, fi, P0); dotPos(d, fi - 1.2, P1); dotPos(d, fi - 2.4, P2);
        ctx.globalAlpha = A * 0.2; ctx.lineWidth = r * 1.5;
        ctx.beginPath(); ctx.moveTo(P2[0], P2[1]); ctx.lineTo(P1[0], P1[1]); ctx.lineTo(P0[0], P0[1]); ctx.stroke();
        ctx.globalAlpha = A * 0.45; ctx.lineWidth = r * 1.9;
        ctx.beginPath(); ctx.moveTo(P1[0], P1[1]); ctx.lineTo(P0[0], P0[1]); ctx.stroke();
        ctx.globalAlpha = A;
        ctx.beginPath(); ctx.arc(P0[0], P0[1], r, 0, 6.2832); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }
  requestAnimationFrame(drawTraffic);

  // ---- Mode switching (active <-> idle) ----------------------------------
  let forced = qs.get("mode") || null; // "active" | "idle" | null (auto)
  let idleMs = (Number(qs.get("idleMinutes")) || site.idleMinutes) * 60000;
  let lastInput = Date.now();

  function applyMode(mode) {
    if (mode === ATLAS.mode) return;
    ATLAS.mode = mode;
    root.dataset.mode = mode;
    for (const p of ATLAS.panels) {
      if (!p.slots.active) continue;
      p.slots.active.el.classList.toggle("hidden", mode === "idle");
    }
    for (const m of Object.values(ATLAS.modules)) m.onMode && m.onMode(mode);
  }
  function tick() {
    applyMode(forced || (Date.now() - lastInput > idleMs ? "idle" : "active"));
  }
  ["mousemove", "mousedown", "keydown", "wheel", "touchstart"].forEach((ev) =>
    addEventListener(ev, () => { lastInput = Date.now(); if (!forced) applyMode("active"); }, { passive: true }));
  setInterval(tick, 1000);
  root.dataset.mode = "active";
  if (forced) applyMode(forced);

  // Lively custom properties (app/LivelyProperties.json) and CLI `--property`.
  window.livelyPropertyListener = function (name, val) {
    if (name === "mode") { forced = ["auto", "active", "idle"][val] === "auto" ? null : ["auto", "active", "idle"][val]; tick(); }
    if (name === "idleMinutes") { idleMs = Number(val) * 60000; tick(); }
    if (name === "weather") {
      const states = ["auto", "clear", "cloudy", "fog", "rain", "snow", "dust", "storm"];
      const wx = states[val] || "auto";
      ATLAS.modules.weather && ATLAS.modules.weather.setForce(wx === "auto" ? null : wx);
    }
    if (name === "sun") { forcedNight = [null, 0, 1][val]; if (typeof drift === "function") drift(); }
  };

  // ---- Day/night "city lights" drift (no network) ------------------------
  // Solar elevation from a compact NOAA approximation drives a lerp of the gold
  // palette per panel: day = pale champagne on lifted black, night = rich gold on
  // pure black with road glow. Debug: ?night=0..1 forces every panel.
  function solarElevation(lon, lat, date) {
    const rad = Math.PI / 180;
    const d = (date - Date.UTC(date.getUTCFullYear(), 0, 1)) / 864e5;
    const decl = -23.44 * Math.cos(rad * (360 / 365) * (d + 10));
    const eot = 7.5 * Math.sin(rad * (360 / 365) * (d - 4)) - 9.9 * Math.sin(2 * rad * (360 / 365) * (d - 81)); // minutes, rough
    const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
    const solarMin = utcMin + lon * 4 + eot;
    const ha = (solarMin / 4 - 180) * rad;
    const sin = Math.sin(lat * rad) * Math.sin(decl * rad) + Math.cos(lat * rad) * Math.cos(decl * rad) * Math.cos(ha);
    return Math.asin(Math.max(-1, Math.min(1, sin))) / rad;
  }
  function nightAmount(elev) { // 1 below -12°, 0 above +8°, smooth between
    const t = Math.max(0, Math.min(1, (elev + 12) / 20));
    return 1 - t * t * (3 - 2 * t);
  }
  const DAY_NIGHT = { // [day, night] per CSS var; inline vars on the svg beat its scoped <style>
    "--road-major": ["#EDE3BC", "#E2B23F"],
    "--road-high": ["#CDBF93", "#B08A2A"],
    "--road-mid": ["#7A7154", "#6E5518"],
    "--rail": ["#8C8266", "#7A5E1C"],
    "--waterway": ["#4A4430", "#3A2F12"],
    "--text": ["#E8DCAE", "#D4A537"],
    "--land": ["#0B0904", "#000000"],
  };
  const lerpHex = (a, b, t) => {
    const c = (h, i) => parseInt(h.slice(i, i + 2), 16);
    const mix = (i) => Math.round(c(a, i) + (c(b, i) - c(a, i)) * t).toString(16).padStart(2, "0");
    return "#" + mix(1) + mix(3) + mix(5);
  };
  let forcedNight = qs.get("night") !== null ? Number(qs.get("night")) : null;
  function drift() {
    const now = new Date();
    for (const p of ATLAS.panels) {
      for (const slot of Object.values(p.slots)) {
        if (!slot.svg) continue;
        const map = CFG.maps[slot.mapId];
        const night = forcedNight !== null ? forcedNight
          : nightAmount(solarElevation(map.center[0], map.center[1], now));
        for (const [v, [day, nite]] of Object.entries(DAY_NIGHT)) slot.svg.style.setProperty(v, lerpHex(day, nite, night));
        slot.svg.classList.toggle("night", night > 0.55);
      }
      const ref = CFG.maps[(p.slots.fixed || p.slots.active).mapId];
      p.night = forcedNight !== null ? forcedNight
        : nightAmount(solarElevation(ref.center[0], ref.center[1], now));
    }
  }
  drift(); setInterval(drift, 60000);

  // ---- Module registry (milestone 5+) ------------------------------------
  ATLAS.register = function (name, mod) {
    if (site.modules[name] === false) return;
    ATLAS.modules[name] = mod;
    mod.start && mod.start(ATLAS);
  };
})();
