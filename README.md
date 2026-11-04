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
tools/detect-monitors.mjs  writes config/monitors.local.js (generated, gitignored): Mutter D-Bus on GNOME, detect-monitors.ps1 on Windows
tools/export/export-map.mjs  OpenFreeMap tiles -> maps/<id>.svg + maps/<id>.js (generated, gitignored)
tools/build-lively.mjs     bundles app/+config/+maps into Lively's Library and sets it (span)
tools/install-gnome.mjs    installs the GNOME Shell extension + planes helper user service
gnome/host/atlas-host.js   GJS/GTK4/WebKitGTK host: one view per monitor (GNOME)
gnome/extension/           Shell extension that paints the host's views onto the desktop background
config/site.local.js       optional, gitignored: `globalThis.ATLAS_SITE = "work"` picks this machine's site
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

## GNOME / Wayland (second site)

The `work` site runs on a Fedora/GNOME 50 laptop (three 1080p panels). Wayland has no Lively and no way for a
normal app to draw on the desktop, so it works differently but keeps the same page and every live layer:

```
echo 'globalThis.ATLAS_SITE = "work";' > config/site.local.js
npm install && npm run export:all
npm run gnome           # detect monitors, install extension + atlas-helper.service, enable
                        # first install: log out and back in (Wayland loads new extensions at login)
npm run gnome:preview   # the views as ordinary windows, for development
```

- **Host** (`gnome/host/atlas-host.js`): one borderless WebKitGTK view per monitor loading
  `app/index.html?panel=<role>`, all in one web process. Wayland windows can't span outputs, hence per-panel pages.
  Idle comes from Mutter's IdleMonitor (`ATLAS.reportIdle`), since the page never sees the pointer.
- **Extension** (`gnome/extension/`): spawns the host with `--managed` (stdin control pipe; EOF → host exits), adopts its
  windows (title `atlas-wallpaper|<connector>` + our child's pid), minimizes them and paints a `Clutter.Clone` of each
  onto every `Meta.BackgroundActor` for that monitor: desktop, overview, workspace thumbnails, lock screen. The
  windows answer `skip_taskbar` (overridden on every prototype GJS defines it on), so they never show in the overview,
  Alt-Tab or the dash; a mapped clone is what keeps Mutter from suspending a minimized window.
- **Pausing**: once a second the extension checks each monitor for a window covering its work area (maximized or
  fullscreen) or a locked screen and sends `pause <connector> 0|1`; the page stops its canvas loop and freezes CSS
  animations (`ATLAS.setPaused`). Measured in a headless GNOME 50 shell, three panels: ~33% of one core visible (with live
  rain on one panel), **0.3% covered or locked**.
- **Frame rate**: the `work` site runs at `fps: 15` (config), canvas and weather steps alike; Windows keeps 30.
  Live on the laptop: ~36% → ~24% of one core (host + WebKit + GNOME Shell compositing), iGPU 22% → 15%,
  and the NVIDIA GPU drops back to its idle P8 state.
- **Lock screen (Super+L)**: the clones land on the lock-screen backgrounds too; the extension turns GNOME's 90 px blur
  off for them and adds a light dim for the clock. GNOME normally fades a manual lock to black and reports the
  screensaver active, which makes gnome-settings-daemon switch the monitors off at once (hardcoded, no setting); the
  extension holds that off, so the maps stay up and live until 60 min without input, then GNOME's own fade and blank
  run as usual and the pages pause (`LOCK_SHOW_MS`).
- **Planes**: `atlas-helper.service` (systemd user unit) replaces the Startup-folder `.vbs`.

WebKitGTK notes (what it costs to not be Chromium): an opacity animation on a `<g>` inside an inline SVG repaints the
whole poster every step, so the water shimmer is now a separate overlay `<svg>` animated as its own composited layer
(92% → 31% of a core); the 30 s dusk glow transition is skipped on first paint (it was 30 s of full repaints at startup).
Every composited frame has a real fixed cost, so frames that nobody sees are the thing to avoid.

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
Traffic lights are a single canvas per panel: road geometry is sampled once at startup
(`getPointAtLength` into uniform point arrays), then one 30 fps rAF pass draws every light as a comet streak (head + tapered tail) —
one composited layer per panel, no per-dot DOM, and it pauses automatically when the page is
hidden. Road fragments are stitched across the exporter's tile seams (and split at subpath
jumps) so lights travel whole routes instead of popping at invisible boundaries, and fade
out at true dead ends. (CSS Motion Path was tried first: `offset-distance` is not compositor-accelerated in
WebView2, costing 14% of a core; the canvas costs ~0.4%.) Shimmer steps at 4 Hz with
imperceptible per-step deltas. `npm run lively` closes existing wallpapers before setting the new one — replacing a running web
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

## Live layers

- **Aircraft** (`app/modules/planes.js`): adsb.lol point queries every 10 s per city,
  dead-reckoned between polls, drawn as small arrows in the shared canvas pass. No public
  ADS-B API sends CORS headers, so requests go through `tools/atlas-helper.mjs` — a local
  proxy on `127.0.0.1:8766` with an 8 s cache, autostarted from the Startup folder
  (`atlas-helper.vbs`) on Windows, `atlas-helper.service` on GNOME. Without it, planes are simply absent.
- **ISS + terminator** (`app/modules/iss.js`): CelesTrak TLE cached in localStorage (max daily
  fetch), propagated locally with a vendored satellite.js v5 UMD — zero network per frame.
  The country maps (US/NM/Nepal) get a warm wash on the sunlit side of the terminator plus
  the ISS marker and its 45-minute leading groundtrack when it crosses the map.

## Roadmap

- Baked-video fallback for machines that can't afford live WebKit: headless capture of this same page into
  seamless loops, shown by the same extension (the live GNOME tier made it unnecessary on the work laptop)

## Data & licenses

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL), served
as vector tiles by [OpenFreeMap](https://openfreemap.org/). Poster layer model and theme schema
after Terraink (AGPL-3.0; referenced, not redistributed — the exporter here is an independent
implementation). Weather by Open-Meteo (CC BY 4.0). Aircraft data via [adsb.lol](https://adsb.lol) (ODbL).
Orbital elements from [CelesTrak](https://celestrak.org); propagation by satellite.js (MIT, vendored).
