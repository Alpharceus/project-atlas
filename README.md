# Atlas — living map wallpapers across three monitors

Five map posters — United States, New Mexico, Albuquerque, Nepal, Kathmandu — rendered as one
animated wallpaper page spanning three monitors. Tiny lights travel the actual road geometry, water shimmers,
the gold shifts from pale daylight champagne to glowing night gold with the local sun, and live
weather draws rain, snow, fog and desert dust over the city panels (idle country maps included). Black and gold, true vector, one codebase.

The center monitor always shows the US. The side panels are state-driven, not timer-rotated:
while you're at the keyboard they show the cities (Albuquerque, Kathmandu); go idle and they
crossfade to the country maps (New Mexico, Nepal). The switch happens *inside* the page — the
wallpaper process never restarts, so weather caches and animation phase survive every transition.

## Why this shape

- **Vector or nothing.** Map-poster generators export raster layers; you can't run a
  `stroke-dashoffset` pulse along a PNG. So `tools/export/export-map.mjs` builds the posters
  itself: it fetches OpenFreeMap vector tiles (OpenMapTiles schema), decodes them, and writes a
  layered SVG per map with real `<path>` groups —
  `layer-water, layer-road-{path,low,mid,high,major}, layer-rail, …` — styled by a theme, with
  every rule scoped to `svg[data-map="…"]` so five inlined posters don't fight. Layer model,
  road tiers and theme schema mirror [Terraink](https://github.com/yousifamanuel/terraink)'s,
  so its themes drop straight in (the black-and-gold `atlas_gold` theme lives in the config).
- **One page, span mode.** A single WebView2 process (~300–400 MB) instead of three per-monitor
  ones (~1 GB). Panels are absolutely positioned from your real monitor rects — detected by
  `tools/detect-monitors.ps1`, not hard-coded — including negative coordinates and portrait
  panels.
- **Everything loops in 60 s.** Pulses (6 s / 4 s), shimmer (12 s), rain (1 s), snow (20 s), dust (30 s),
  fog (30 s), storm flash (20 s) all divide one minute, so the identical page can later be
  captured to seamless video loops for machines that can't run live HTML (GNOME/Wayland tier —
  planned).
- **Poll-and-diff, not push.** Weather polls [Open-Meteo](https://open-meteo.com/) (free, no
  key) every 10 min per city and only touches the DOM when the derived state
  (clear/cloudy/fog/rain/snow/storm/dust) or rounded temperature actually changes. Rain is gray
  streak lines, snow is slow white spheres, dust — no WMO code exists for it — is derived from
  strong gusts on a dry sky and drifts as tan smoke banks. Day/night keeps the black-and-gold
  theme by moving the *metal*, not an overlay: night is city lights (pure black, rich gold,
  road glow, full-strength pulses), day is white gold on slightly lifted black.

## The moving parts

```
config/atlas.config.js     maps (center/zoom/theme), themes, sites (panel roles + modules), loop period
tools/detect-monitors.ps1  writes config/monitors.local.js (generated, gitignored)
tools/export/export-map.mjs  OpenFreeMap tiles -> maps/<id>.svg + maps/<id>.js (generated, gitignored)
tools/build-lively.mjs     bundles app/+config/+maps into Lively's Library and sets it (span)
app/                       the page: atlas.js (panels, animation, idle crossfade), modules/weather.js
```

## Run it

```
npm install
npm run detect          # monitor geometry -> config/monitors.local.js
npm run export:all      # build the five posters (tiles are cached in .cache/)
node tools/serve.mjs    # preview: http://localhost:8765/app/index.html?site=home&fit=1
npm run lively          # bundle into Lively Wallpaper and set as span wallpaper
```

Preview/capture query params: `site=home|work`, `fit=1` (scale to window), `mode=active|idle`,
`idleMinutes=N`, `wx=rain|snow|storm|dust|fog|cloudy` (force weather), `night=0..1` (force sun state).

[Lively Wallpaper](https://github.com/rocksdanister/lively) v2.2.1: the CLI only loads wallpapers
from its own Library, hence the bundling step. `--layout span` does not survive a Lively restart —
`WallpaperArrangement=1` must be set in `%LOCALAPPDATA%\Lively Wallpaper\Settings.json` while
Lively is closed (`npm run lively` handles the running session). The optional screensaver plugin
(`Lively.scr` in `C:\Windows`, registered via `HKCU\Control Panel\Desktop`) shows the same page;
note it spawns a second page instance, so the in-page idle crossfade is the state-keeping
mechanism and the screensaver is just a layer on top.

## Controls

Lively tray icon -> open Lively -> hover the Project Atlas tile -> "..." -> **Customize**:

- **Mode** — auto / active / idle (auto = mouse-driven idle timer)
- **Idle threshold** — minutes before the country maps fade in
- **Weather** — auto (live Open-Meteo data) or force clear/cloudy/fog/rain/snow/dust/storm
- **Sun** — auto (local solar time) or force day/night

Everything else is config: map centers/zooms/themes and panel assignments live in
`config/atlas.config.js`; overlay looks in `app/atlas.css`. After editing either, run
`npm run export:all` (only if maps changed) and `npm run lively` to redeploy.

## Performance

Measured at desktop: well under 1 % total CPU and ~3 % of one GPU 3D engine for the whole span.
Traffic is CSS Motion Path: each light is a tiny composited layer animating `offset-distance`
along the real road path — smooth 60 fps with near-zero paint, unlike `stroke-dashoffset`
which repaints the whole span-sized layer. Shimmer steps at 4 Hz with imperceptible per-step
deltas. `npm run lively` closes existing wallpapers before setting the new one — replacing a running web
wallpaper on Lively 2.2.1 can otherwise leave the old player process alive as a zombie, silently
doubling compositor cost. All
weather layers are oversized tiling SVG patterns moved by whole-tile transforms (compositor-only,
zero repaint), road pulses run at 15 fps via `steps()`, shimmer is opacity-only, and the night
glow is a static widened stroke clone instead of a `drop-shadow` filter. The Windows screensaver
spawns a second page instance while active — expect roughly double cost during it, and nothing
after it closes.

## Hardware (what I run it on)

Ryzen 7 9800X3D · RTX 5070 Ti · triple monitors: 1920×1080 landscape (Kathmandu/Nepal),
2560×1440 primary (US), 1080×1920 portrait (Albuquerque/New Mexico).

## Roadmap

- Aircraft overlays (adsb.lol bounding-box queries) for the city panels
- ISS pass + day/night terminator on the country maps (CelesTrak TLE + local propagation)
- Baked-video tier for GNOME/Wayland at a second site: headless capture of this same page,
  NVENC-encoded seamless loops, swapped by a D-Bus idle watcher

## Data & licenses

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL), served
as vector tiles by [OpenFreeMap](https://openfreemap.org/). Poster layer model and theme schema
after Terraink (AGPL-3.0; referenced, not redistributed — the exporter here is an independent
implementation). Weather by Open-Meteo (CC BY 4.0).
