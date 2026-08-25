/* ISS + day/night terminator on the country maps (US, NM, Nepal).
 * CelesTrak TLE fetched at most daily (localStorage cache); satellite.js
 * (app/modules/vendor.satellite.min.js) propagates locally — zero network
 * per frame. Terminator = warm wash on the sunlit side + soft boundary line,
 * recomputed once a minute. Drawn in the shared 30fps canvas pass. */
(function () {
  "use strict";
  const MAPS = ["us", "nm", "nepal"];
  const TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=tle";
  const TLE_KEY = "atlas-tle-25544";
  const TLE_MAX_AGE_H = 20;

  let satrec = null;
  async function loadTle() {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(TLE_KEY)); } catch (e) {}
    const fresh = cached && (Date.now() - cached.ts) / 36e5 < TLE_MAX_AGE_H;
    if (!fresh) {
      try {
        const text = await (await fetch(TLE_URL)).text();
        const lines = text.trim().split("\n").map((l) => l.trim());
        if (lines.length >= 3 && lines[1][0] === "1") {
          cached = { l1: lines[1], l2: lines[2], ts: Date.now() };
          try { localStorage.setItem(TLE_KEY, JSON.stringify(cached)); } catch (e) {}
        }
      } catch (e) { /* fall back to stale cache if any */ }
    }
    if (cached && window.satellite) satrec = satellite.twoline2satrec(cached.l1, cached.l2);
  }

  // Solar declination + equation of time (same approximation as atlas.js drift).
  function sunState(date) {
    const rad = Math.PI / 180;
    const d = (date - Date.UTC(date.getUTCFullYear(), 0, 1)) / 864e5;
    const decl = -23.44 * Math.cos(rad * (360 / 365) * (d + 10));
    const eot = 7.5 * Math.sin(rad * (360 / 365) * (d - 4)) - 9.9 * Math.sin(2 * rad * (360 / 365) * (d - 81));
    const utcH = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    const subLon = -15 * (utcH + eot / 60 - 12); // subsolar longitude
    return { decl, subLon };
  }

  // ISS position + short leading groundtrack, refreshed once a second / minute.
  let issNow = null, issTrack = [], lastPos = 0, lastTrack = 0, lastTerm = 0;
  const termPaths = new Map(); // mapId -> {wash: Path2D, line: Path2D}

  function issGeo(date) {
    const pv = satellite.propagate(satrec, date);
    if (!pv || !pv.position) return null;
    const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(date));
    return [satellite.degreesLong(geo.longitude), satellite.degreesLat(geo.latitude)];
  }

  function refresh(atlas) {
    const nowMs = Date.now();
    if (satrec && nowMs - lastPos > 1000) { lastPos = nowMs; issNow = issGeo(new Date()); }
    if (satrec && nowMs - lastTrack > 60000) {
      lastTrack = nowMs;
      issTrack = [];
      for (let m = 0; m <= 45; m += 1.5) {
        const g = issGeo(new Date(nowMs + m * 60000));
        if (g) issTrack.push(g);
      }
    }
    if (nowMs - lastTerm > 60000) {
      lastTerm = nowMs;
      const { decl, subLon } = sunState(new Date());
      const d = Math.abs(decl) < 0.6 ? Math.sign(decl || 1) * 0.6 : decl; // avoid tan(0) blowup
      const rad = Math.PI / 180;
      for (const p of atlas.panels) {
        for (const slot of Object.values(p.slots)) {
          if (!MAPS.includes(slot.mapId)) continue;
          const wash = new Path2D(), line = new Path2D();
          let first = true;
          const pts = [];
          for (let lon = -180; lon <= 180; lon += 3) {
            const H = (lon - subLon) * rad;
            let lat = Math.atan(-Math.cos(H) / Math.tan(d * rad)) / rad;
            lat = Math.max(-84, Math.min(84, lat));
            pts.push([lon, lat]);
          }
          const poleLat = decl >= 0 ? 84 : -84; // sunlit pole closes the day polygon
          for (const [lon, lat] of pts) {
            const [x, y] = atlas.project(slot.mapId, lon, lat, p.monitor);
            if (first) { wash.moveTo(x, y); line.moveTo(x, y); first = false; }
            else { wash.lineTo(x, y); line.lineTo(x, y); }
          }
          const [xe, ye] = atlas.project(slot.mapId, 180, poleLat, p.monitor);
          const [xw, yw] = atlas.project(slot.mapId, -180, poleLat, p.monitor);
          wash.lineTo(xe, ye); wash.lineTo(xw, yw); wash.closePath();
          termPaths.set(slot.mapId + ":" + p.monitor.id, { wash, line });
        }
      }
    }
  }

  function start(atlas) {
    loadTle();
    setInterval(loadTle, 3 * 36e5); // re-check TLE age every 3h
    const modules = atlas.site.modules;
    for (const p of atlas.panels) {
      if (!Object.values(p.slots).some((s) => MAPS.includes(s.mapId))) continue;
      p.canvasHooks.push(function (ctx, panel, mapId) {
        if (!MAPS.includes(mapId)) return;
        refresh(atlas);
        const paths = termPaths.get(mapId + ":" + panel.monitor.id);
        if (modules.terminator !== false && paths) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = "rgba(255, 224, 150, 0.05)"; // sunlit-side warmth
          ctx.fill(paths.wash);
          ctx.strokeStyle = "rgba(255, 224, 150, 0.22)";
          ctx.lineWidth = 2;
          ctx.stroke(paths.line);
        }
        if (modules.iss === false || !issNow) return;
        const W = panel.monitor.w, H = panel.monitor.h;
        // leading groundtrack (faint), broken at the dateline
        ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        let pen = false;
        let prev = null;
        for (const [lon, lat] of issTrack) {
          if (prev && Math.abs(lon - prev) > 90) pen = false;
          const [x, y] = atlas.project(mapId, lon, lat, panel.monitor);
          if (x < -50 || x > W + 50 || y < -50 || y > H + 50) { pen = false; prev = lon; continue; }
          if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
          prev = lon;
        }
        ctx.stroke();
        const [x, y] = atlas.project(mapId, issNow[0], issNow[1], panel.monitor);
        if (x < -20 || x > W + 20 || y < -20 || y > H + 20) return;
        ctx.fillStyle = "#FFFFFF";
        ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.arc(x, y, 3, 0, 6.2832); ctx.fill();
        ctx.globalAlpha = 0.45;
        ctx.strokeStyle = "#FFFFFF"; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(x, y, 7, 0, 6.2832); ctx.stroke();
        ctx.globalAlpha = 0.7;
        ctx.font = "600 13px Segoe UI, sans-serif";
        ctx.fillText("ISS", x + 11, y + 4);
        ctx.globalAlpha = 1;
      });
    }
  }

  window.ATLAS.register("iss", { start });
})();
