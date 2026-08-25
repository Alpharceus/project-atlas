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
    const clone = (sel, cls) => {
      const g = svg.querySelector(sel); if (!g) return null;
      const c = g.cloneNode(true);
      c.removeAttribute("id"); c.setAttribute("class", cls);
      g.after(c);
      return c;
    };
    ["major", "high"].forEach((tier) => {
      const g = clone("#layer-road-" + tier, "pulse " + tier);
      if (!g) return;
      const period = tier === "major" ? 6 : 4;
      g.querySelectorAll("path").forEach((p, i) => {
        p.removeAttribute("class");
        p.style.animationDelay = -((i * 0.618 * period) % period).toFixed(3) + "s";
      });
    });
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
  const forcedNight = qs.get("night") !== null ? Number(qs.get("night")) : null;
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
      p.el.style.setProperty("--atlas-night", "0");
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
