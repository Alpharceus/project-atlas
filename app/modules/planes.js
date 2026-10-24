/* Aircraft module (city maps only). adsb.lol bounding queries every 15s per city,
 * only while the city map is visible, dead-reckoned (in pixel space) between polls
 * and drawn into the shared 30fps canvas pass.
 * KTM coverage is patchy — gaps are expected and handled (planes just age out).
 * No public ADS-B API sends CORS headers, so requests go through the local
 * atlas-helper daemon (tools/atlas-helper.mjs); without it, planes are absent. */
(function () {
  "use strict";
  const POLL_MS = 15000;
  const RADIUS_NM = 40;      // city views are ~50 km across; margin for planes entering
  const MAX_SEEN_S = 30;     // ignore fixes already stale when received
  const DR_CAP_S = 12;       // dead-reckoning cap
  const FADE_START_S = 30;   // alpha fades 1 -> 0 between these ages
  const FADE_END_S = 45;     // older planes are pruned and never drawn
  const VIEW_MARGIN = 150;   // px around the panel kept in the store
  const M_PER_DEG = 111320;
  const KT_TO_MS = 0.5144;
  const DEG = Math.PI / 180;

  function start(atlas) {
    const cities = [];

    function prune(st, now) {
      for (const [hex, pl] of st.planes) if (now - pl.ts > FADE_END_S * 1000) st.planes.delete(hex);
    }

    async function poll(st) {
      prune(st, performance.now());
      if (st.busy) return;
      st.busy = true;
      try {
        const res = await fetch("http://127.0.0.1:8766/adsb/" + st.lat + "/" + st.lon + "/" + RADIUS_NM);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        const now = performance.now();
        const mon = st.panel.monitor;
        for (const ac of data.ac || []) {
          if (ac.lat == null || ac.lon == null || ac.alt_baro === "ground") continue;
          const seen = ac.seen_pos || 0;
          if (seen > MAX_SEEN_S) continue;
          const xy = atlas.project(st.mapId, ac.lon, ac.lat, mon); // once per poll, not per frame
          if (xy[0] < -VIEW_MARGIN || xy[1] < -VIEW_MARGIN || xy[0] > mon.w + VIEW_MARGIN || xy[1] > mon.h + VIEW_MARGIN) continue;
          let pl = st.planes.get(ac.hex);
          if (!pl) { pl = {}; st.planes.set(ac.hex, pl); }
          pl.ts = now - seen * 1000;
          pl.x0 = xy[0]; pl.y0 = xy[1];
          if (ac.track == null || isNaN(ac.track)) {
            pl.vx = 0; pl.vy = 0; pl.rot = 0;
          } else {
            const tr = ac.track * DEG;
            const pxPerM = st.pxPerDeg / (M_PER_DEG * Math.cos(ac.lat * DEG)); // mercator px per metre
            const v = (ac.gs || 0) * KT_TO_MS * pxPerM;
            pl.vx = v * Math.sin(tr); pl.vy = -v * Math.cos(tr); pl.rot = tr;
          }
        }
      } catch (e) { /* keep last known picture (pruned by age); next poll retries */ }
      finally { st.busy = false; prune(st, performance.now()); }
    }

    function stop(st) {
      if (st.timer) { clearInterval(st.timer); st.timer = 0; }
    }

    function sync(st) { // poll only while this city's map is visible
      const want = atlas.mode !== "idle" && !document.hidden;
      if (!want) { stop(st); return; }
      if (st.timer) return;
      poll(st);
      st.timer = setInterval(function () {
        if (atlas.mode === "idle" || document.hidden) { stop(st); return; }
        poll(st);
      }, POLL_MS);
    }

    for (const p of atlas.panels.filter((q) => q.slots.active)) {
      const mapId = p.slots.active.mapId;
      const city = atlas.config.maps[mapId];
      const st = {
        panel: p, mapId, planes: new Map(), lat: city.center[1], lon: city.center[0],
        timer: 0, busy: false, pxPerDeg: (512 * Math.pow(2, city.zoom)) / 360
      };
      cities.push(st);

      p.canvasHooks.push(function (ctx, panel, curMap) {
        if (curMap !== mapId || st.planes.size === 0) return;
        const now = performance.now();
        const base = 0.55 + 0.35 * panel.night;
        const w = panel.monitor.w, h = panel.monitor.h;
        let drew = false;
        for (const pl of st.planes.values()) {
          const age = (now - pl.ts) / 1000;
          if (age > FADE_END_S) continue;
          const dt = age < DR_CAP_S ? age : DR_CAP_S;
          const x = pl.x0 + pl.vx * dt, y = pl.y0 + pl.vy * dt;
          if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
          const alpha = base * (age <= FADE_START_S ? 1 : (FADE_END_S - age) / (FADE_END_S - FADE_START_S));
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(pl.rot);
          ctx.globalAlpha = alpha * 0.25;
          ctx.beginPath(); ctx.arc(0, 0, 6, 0, 6.2832); ctx.fillStyle = "#FFE9A8"; ctx.fill();
          ctx.globalAlpha = alpha;
          ctx.fillStyle = "#FFF3C4";
          ctx.beginPath(); // small arrow pointing along track
          ctx.moveTo(0, -5); ctx.lineTo(3.4, 4.4); ctx.lineTo(0, 2.3); ctx.lineTo(-3.4, 4.4); ctx.closePath();
          ctx.fill();
          ctx.restore();
          drew = true;
        }
        if (drew) ctx.globalAlpha = 1;
      });
    }

    function syncAll() { for (const st of cities) sync(st); }
    document.addEventListener("visibilitychange", syncAll);
    start.syncAll = syncAll;
    syncAll();
  }

  window.ATLAS.register("planes", {
    start,
    onMode(mode) { if (start.syncAll) start.syncAll(); }
  });
})();
