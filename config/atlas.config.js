// Project Atlas — shared config. Loaded by both the browser page (as a plain
// <script>) and the Node exporter (import + globalThis.ATLAS_CONFIG), so it
// must stay plain ES5-ish and side-effect free apart from the global.
(function (g) {
  var LOOP_SECONDS = 60; // every ambient animation period must divide this

  // Custom themes (same shape as Terraink's themes.json entries). A map's `theme`
  // is looked up here first, then in tools/terraink/src/data/themes.json.
  var themes = {
    atlas_gold: {
      name: "Atlas Gold",
      ui: { bg: "#000000", text: "#D4A537" },
      map: {
        land: "#000000", landcover: "#070707", water: "#0B0B0B", waterway: "#3A2F12",
        parks: "#0D0D0D", buildings: "#2A2213", aeroway: "#111111", rail: "#7A5E1C",
        roads: { major: "#E2B23F", minor_high: "#B08A2A", minor_mid: "#6E5518", minor_low: "#3F3110", path: "#241D0A", outline: "#000000" }
      }
    }
  };

  // Five posters. `zoom` follows MapLibre semantics (512px tiles).
  var maps = {
    us:    { title: "United States", subtitle: "39.8°N 98.6°W",    center: [-98.6, 39.8],    zoom: 4.35, theme: "atlas_gold" },
    nm:    { title: "New Mexico",    subtitle: "34.5°N 106.0°W",   center: [-106.0, 34.3],   zoom: 6.3,  theme: "atlas_gold" },
    abq:   { title: "Albuquerque",   subtitle: "35.08°N 106.65°W", center: [-106.62, 35.10], zoom: 11.3, theme: "atlas_gold" },
    nepal: { title: "Nepal",         subtitle: "28.4°N 84.1°E",    center: [84.15, 28.35],   zoom: 6.9,  theme: "atlas_gold" },
    ktm:   { title: "Kathmandu",     subtitle: "27.71°N 85.32°E",  center: [85.32, 27.70],   zoom: 12.2, theme: "atlas_gold" }
  };

  // Panels are roles ordered left -> right. Geometry comes from config/monitors.local.js
  // (run tools/detect-monitors.ps1) when present; the x/y/w/h here are only a fallback.
  // `fixed` shows one map always; `active`/`idle` crossfade by input state.
  var sites = {
    home: {
      idleMinutes: 5,
      modules: { weather: true, planes: true, iss: true, terminator: true },
      monitors: [
        { id: "left",   x: -1920, y: 267,  w: 1920, h: 1080, active: "ktm", idle: "nepal" },
        { id: "center", x: 0,     y: 0,    w: 2560, h: 1440, fixed: "us" },
        { id: "right",  x: 2560,  y: -476, w: 1080, h: 1920, active: "abq", idle: "nm" }
      ]
    },
    work: {
      idleMinutes: 5,
      modules: { weather: true, planes: false, iss: true, terminator: true },
      monitors: [
        { id: "left",   x: 0,    y: 0, w: 1920, h: 1080, active: "ktm", idle: "nepal" },
        { id: "center", x: 1920, y: 0, w: 1920, h: 1080, fixed: "us" },
        { id: "right",  x: 3840, y: 0, w: 1920, h: 1080, active: "abq", idle: "nm" }
      ]
    }
  };

  // Overlay detected geometry (sorted left->right) onto the role list of a site.
  function resolveMonitors(siteId) {
    var site = sites[siteId];
    var detected = g.ATLAS_MONITORS && g.ATLAS_MONITORS[siteId];
    if (!detected || detected.length !== site.monitors.length) return site.monitors;
    return site.monitors.map(function (role, i) {
      var d = detected[i];
      var out = {}; for (var k in role) out[k] = role[k];
      out.x = d.x; out.y = d.y; out.w = d.w; out.h = d.h; out.device = d.device;
      return out;
    });
  }

  g.ATLAS_CONFIG = { loopSeconds: LOOP_SECONDS, themes: themes, maps: maps, sites: sites, defaultSite: "home", resolveMonitors: resolveMonitors };
})(typeof window !== "undefined" ? window : globalThis);
