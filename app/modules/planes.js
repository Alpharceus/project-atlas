/* Aircraft module (home only). adsb.lol bounding queries every 10s per city,
 * dead-reckoned between polls, drawn into the shared 30fps canvas pass.
 * KTM coverage is patchy — gaps are expected and handled (planes just age out).
 * No public ADS-B API sends CORS headers, so requests go through the local
 * atlas-helper daemon (tools/atlas-helper.mjs); without it, planes are absent. */
(function () {
  "use strict";
  const POLL_MS = 10000;
  const MAX_AGE_S = 60;     // drop aircraft not seen for a minute
  const RADIUS_NM = 250;    // one wide query serves both city and country maps

  function start(atlas) {
    const panels = atlas.panels.filter((p) => p.slots.active);
    for (const p of panels) {
      const city = atlas.config.maps[p.slots.active.mapId];
      const state = { planes: new Map(), lat: city.center[1], lon: city.center[0] };

      async function poll() {
        try {
          const res = await fetch("http://127.0.0.1:8766/adsb/" + state.lat + "/" + state.lon + "/" + RADIUS_NM);
          if (!res.ok) throw new Error("HTTP " + res.status);
          const now = performance.now();
          for (const ac of (await res.json()).ac || []) {
            if (ac.lat == null || ac.lon == null) continue;
            state.planes.set(ac.hex, { lat: ac.lat, lon: ac.lon, gs: ac.gs || 0, track: ac.track || 0, ts: now });
          }
          for (const [hex, pl] of state.planes) if ((now - pl.ts) / 1000 > MAX_AGE_S) state.planes.delete(hex);
        } catch (e) { /* keep last known picture; next poll retries */ }
      }
      poll();
      setInterval(poll, POLL_MS);

      p.canvasHooks.push(function (ctx, panel, mapId) {
        const now = performance.now();
        const alpha = 0.55 + 0.35 * panel.night;
        for (const pl of state.planes.values()) {
          const dt = Math.min((now - pl.ts) / 1000, 30); // dead reckoning, capped
          const v = pl.gs * 0.5144;                      // knots -> m/s
          const tr = (pl.track * Math.PI) / 180;
          const lat = pl.lat + (v * Math.cos(tr) * dt) / 111320;
          const lon = pl.lon + (v * Math.sin(tr) * dt) / (111320 * Math.cos((pl.lat * Math.PI) / 180));
          const [x, y] = atlas.project(mapId, lon, lat, panel.monitor);
          if (x < -20 || y < -20 || x > panel.monitor.w + 20 || y > panel.monitor.h + 20) continue;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(tr);
          ctx.globalAlpha = alpha * 0.25;
          ctx.beginPath(); ctx.arc(0, 0, 6, 0, 6.2832); ctx.fillStyle = "#FFE9A8"; ctx.fill();
          ctx.globalAlpha = alpha;
          ctx.fillStyle = "#FFF3C4";
          ctx.beginPath(); // small arrow pointing along track
          ctx.moveTo(0, -5); ctx.lineTo(3.4, 4.4); ctx.lineTo(0, 2.3); ctx.lineTo(-3.4, 4.4); ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
        ctx.globalAlpha = 1;
      });
    }
  }

  window.ATLAS.register("planes", { start });
})();
