/* Weather module. Open-Meteo (free, no key), poll-and-diff: fetch current
 * conditions every 10 min per city panel, derive a coarse state
 * (clear/cloudy/fog/rain/snow/storm/dust), and only touch the DOM when it
 * changes. Overlay animation periods all divide ATLAS_CONFIG.loopSeconds (60s).
 * Overlays attach to the panel, so idle maps (NM/Nepal) get them too.
 * Debug: ?wx=rain|snow|storm|dust|fog|cloudy|clear forces every panel. */
(function () {
  "use strict";
  const POLL_MS = 10 * 60 * 1000;
  const API = "https://api.open-meteo.com/v1/forecast";
  const qs = new URLSearchParams(location.search);
  const forced = qs.get("wx");

  // WMO weather interpretation codes -> coarse visual state + intensity 0..1.
  function classify(code) {
    if (code <= 2) return { state: "clear", intensity: 0 };
    if (code === 3) return { state: "cloudy", intensity: 0.6 };
    if (code <= 48) return { state: "fog", intensity: 0.7 };
    if (code <= 55) return { state: "rain", intensity: 0.4 }; // drizzle
    if (code <= 57) return { state: "rain", intensity: 0.55 };
    if (code <= 63) return { state: "rain", intensity: 0.7 };
    if (code <= 65) return { state: "rain", intensity: 1 };
    if (code <= 67) return { state: "snow", intensity: 0.6 }; // freezing rain ~ sleet
    if (code <= 75) return { state: "snow", intensity: code === 71 ? 0.5 : 0.85 };
    if (code === 77) return { state: "snow", intensity: 0.55 };
    if (code <= 82) return { state: "rain", intensity: 0.85 }; // showers
    if (code <= 86) return { state: "snow", intensity: 0.95 };
    return { state: "storm", intensity: 1 }; // 95-99 thunderstorm
  }

  // Open-Meteo has no WMO dust code, so derive it: dry sky + strong wind/gusts.
  // Tuned for ABQ spring winds; harmless elsewhere.
  function dustify(wx, windKmh, gustKmh) {
    if (wx.state !== "clear" && wx.state !== "cloudy") return wx;
    const g = Math.max(gustKmh || 0, windKmh || 0);
    if (g < 40) return wx;
    return { state: "dust", intensity: Math.min(1, 0.5 + (g - 40) / 50) };
  }

  const mod = {
    panels: [], // { panel, mapId, lon, lat, el, readout, state, temp }
    timer: null,

    start(atlas) {
      for (const p of atlas.panels) {
        if (!p.slots.active) continue; // city panels only (US stays clean)
        const mapId = p.slots.active.mapId;
        const map = atlas.config.maps[mapId];
        const el = document.createElement("div");
        el.className = "weather";
        el.innerHTML = '<div class="wx-rain"></div><div class="wx-snow"></div><div class="wx-dust"></div><div class="wx-fog"></div><div class="wx-flash"></div>';
        const readout = document.createElement("div");
        readout.className = "wx-readout";
        el.appendChild(readout);
        p.el.insertBefore(el, p.tint); // above both slots -> idle maps get weather too
        this.panels.push({ panel: p, mapId, lon: map.center[0], lat: map.center[1], el, readout, state: null, temp: null });
      }
      if (!this.panels.length) return;
      const poll = () => this.pollAll();
      poll();
      this.timer = setInterval(poll, POLL_MS);
    },

    async pollAll() {
      for (const c of this.panels) {
        try {
          if (forced) { this.apply(c, { state: forced, intensity: 0.85 }, 21, true); continue; }
          const url = API + "?latitude=" + c.lat + "&longitude=" + c.lon +
            "&current=temperature_2m,weather_code,wind_speed_10m,wind_gusts_10m,is_day&timezone=auto";
          const res = await fetch(url);
          if (!res.ok) throw new Error("HTTP " + res.status);
          const cur = (await res.json()).current;
          const wx = dustify(classify(cur.weather_code), cur.wind_speed_10m, cur.wind_gusts_10m);
          this.apply(c, wx, cur.temperature_2m, cur.is_day);
        } catch (e) {
          // Keep the last known state on network failure; try again next poll.
          console.warn("weather:", c.mapId, e.message);
        }
      }
    },

    apply(c, wx, temp, isDay) {
      const t = Math.round(temp);
      if (wx.state === c.state && t === c.temp) return; // poll-and-diff: no change
      c.state = wx.state; c.temp = t;
      c.el.className = "weather wx-state-" + wx.state;
      c.el.style.setProperty("--wx", wx.intensity.toFixed(2));
      c.readout.textContent = t + "° · " + wx.state;
      document.dispatchEvent(new CustomEvent("atlas:weather", { detail: { map: c.mapId, state: wx.state, temp: t, isDay } }));
    },

    onMode() { /* overlays live on the panel, not the slot — nothing to do */ },
  };

  window.ATLAS.register("weather", mod);
})();
