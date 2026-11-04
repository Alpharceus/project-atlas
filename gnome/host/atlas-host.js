#!/usr/bin/env -S gjs -m
// Atlas host for GNOME/Wayland: one borderless WebKitGTK view per monitor, each
// loading app/index.html?panel=<role>. The Atlas Shell extension launches this,
// finds the windows by title and paints them as the desktop background; run it
// by hand with --preview to see the views as ordinary windows.
//
//   gjs -m gnome/host/atlas-host.js [--preview] [--query "wx=rain&night=1"]
//
// Wayland gives clients no global input, so the page's own idle timer can't see
// the pointer: this process polls Mutter's IdleMonitor and forwards idle time
// into every view (ATLAS.reportIdle). All views share one web process.
//
// --managed (how the extension runs it): stdin is a control pipe. Lines are
// "pause <connector> 0|1"; EOF means the shell went away, and the host exits.
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Gdk from "gi://Gdk?version=4.0";
import Gtk from "gi://Gtk?version=4.0";
import WebKit from "gi://WebKit?version=6.0";
import System from "system";

const ROOT = GLib.path_get_dirname(GLib.path_get_dirname(GLib.path_get_dirname(
  Gio.File.new_for_uri(import.meta.url).get_path())));
const TITLE = "atlas-wallpaper"; // the extension matches "atlas-wallpaper|<connector>"
const IDLE_POLL_MS = 2000;

const argv = ARGV.slice();
const preview = argv.includes("--preview");
const extraQuery = argv.includes("--query") ? argv[argv.indexOf("--query") + 1] : "";
const managed = argv.includes("--managed");
const snapshotDir = argv.includes("--snapshot") ? argv[argv.indexOf("--snapshot") + 1] : null; // debug: PNG per view after 20 s

// The config files are plain scripts that set globals; evaluate them the same
// way the page does so panel roles and monitor rects come from one place.
function loadConfig() {
  for (const f of ["config/site.local.js", "config/monitors.local.js", "config/atlas.config.js"]) {
    try {
      const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([ROOT, f]));
      (0, eval)(new TextDecoder().decode(bytes));
    } catch (e) {
      if (f === "config/atlas.config.js") throw e;
    }
  }
  const cfg = globalThis.ATLAS_CONFIG;
  return cfg.resolveMonitors(cfg.defaultSite);
}

// Panel role for each Gdk monitor: by connector when monitors.local.js knows it,
// otherwise by left-to-right order (the same rule resolveMonitors uses).
function assignPanels(roles) {
  const model = Gdk.Display.get_default().get_monitors();
  const mons = [];
  for (let i = 0; i < model.get_n_items(); i++) mons.push(model.get_item(i));
  mons.sort((a, b) => a.get_geometry().x - b.get_geometry().x);
  return mons.map((mon, i) => {
    const role = roles.find((r) => r.device === mon.get_connector()) || roles[i];
    return role ? { mon, role } : null;
  }).filter(Boolean);
}

const app = new Gtk.Application({ application_id: "io.github.alpharceus.AtlasHost", flags: Gio.ApplicationFlags.NON_UNIQUE });
let windows = [];
let views = [];
const viewByConnector = new Map();
const pausedWanted = new Map(); // connector -> bool, re-applied whenever a page (re)loads

function applyPause(connector) {
  const view = viewByConnector.get(connector);
  if (view) view.evaluate_javascript(`window.ATLAS && ATLAS.setPaused && ATLAS.setPaused(${!!pausedWanted.get(connector)})`, -1, null, null, null, null);
}

function build() {
  for (const w of windows) w.destroy();
  windows = []; views = []; viewByConnector.clear();
  const roles = loadConfig();
  let first = null;
  for (const { mon, role } of assignPanels(roles)) {
    const geo = mon.get_geometry();
    const view = first ? new WebKit.WebView({ related_view: first }) : new WebKit.WebView();
    first = first || view;
    view.set_background_color(new Gdk.RGBA({ red: 0, green: 0, blue: 0, alpha: 1 }));
    const s = view.get_settings();
    s.enable_developer_extras = preview;
    s.allow_file_access_from_file_urls = true;
    s.enable_back_forward_navigation_gestures = false;
    s.enable_smooth_scrolling = false;
    s.hardware_acceleration_policy = WebKit.HardwareAccelerationPolicy.ALWAYS;
    const q = "panel=" + encodeURIComponent(role.id) + (extraQuery ? "&" + extraQuery : "");
    const connector = mon.get_connector();
    viewByConnector.set(connector, view);
    view.connect("load-changed", (_v, ev) => { if (ev === WebKit.LoadEvent.FINISHED) applyPause(connector); });
    view.load_uri(Gio.File.new_for_path(GLib.build_filenamev([ROOT, "app/index.html"])).get_uri() + "?" + q);

    const win = new Gtk.ApplicationWindow({
      application: app,
      title: TITLE + "|" + connector,
      decorated: preview,
      default_width: geo.width,
      default_height: geo.height,
      child: view,
    });
    if (preview) win.set_default_size(Math.round(geo.width / 2), Math.round(geo.height / 2));
    // Fullscreen is the only way to get exactly the monitor's size (a plain window
    // is clamped to the work area under the top bar). The extension minimizes it
    // right after, so it never counts as a fullscreen app on that monitor.
    else win.fullscreen_on_monitor(mon);
    win.present();
    windows.push(win); views.push(view);
    if (snapshotDir) GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
      view.get_snapshot(WebKit.SnapshotRegion.VISIBLE, WebKit.SnapshotOptions.NONE, null, (v, res) => {
        v.get_snapshot_finish(res).save_to_png(GLib.build_filenamev([snapshotDir, role.id + ".png"]));
      });
      return GLib.SOURCE_REMOVE;
    });
  }
}

// Idle time from Mutter (ms since last user input), pushed into every page.
const idleMonitor = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES, null,
  "org.gnome.Mutter.IdleMonitor", "/org/gnome/Mutter/IdleMonitor/Core", "org.gnome.Mutter.IdleMonitor", null);
function pollIdle() {
  idleMonitor.call("GetIdletime", null, Gio.DBusCallFlags.NONE, 1000, null, (p, res) => {
    let ms;
    try { [ms] = p.call_finish(res).deepUnpack(); } catch (e) { return; }
    const js = "window.ATLAS && ATLAS.reportIdle && ATLAS.reportIdle(" + Number(ms) + ")";
    for (const v of views) v.evaluate_javascript(js, -1, null, null, null, null);
  });
  return GLib.SOURCE_CONTINUE;
}

function readControl() {
  let stdin;
  try {
    const GioUnix = imports.gi.GioUnix; // GLib >= 2.80 moved the Unix streams here
    stdin = new GioUnix.InputStream({ fd: 0, close_fd: false });
  } catch (e) {
    stdin = new Gio.UnixInputStream({ fd: 0, close_fd: false });
  }
  const lines = new Gio.DataInputStream({ base_stream: stdin });
  const next = () => lines.read_line_async(GLib.PRIORITY_DEFAULT, null, (_s, res) => {
    let line;
    try { [line] = lines.read_line_finish_utf8(res); } catch (e) { line = null; }
    if (line === null) { app.quit(); return; } // extension/shell gone
    const [cmd, connector, val] = line.trim().split(/\s+/);
    if (cmd === "pause") { pausedWanted.set(connector, val === "1"); applyPause(connector); }
    next();
  });
  next();
}

app.connect("activate", () => {
  build();
  if (managed) readControl();
  GLib.timeout_add(GLib.PRIORITY_LOW, IDLE_POLL_MS, pollIdle);
  // Monitors plugged/unplugged/rearranged: rebuild all views (debounced).
  let pending = 0;
  Gdk.Display.get_default().get_monitors().connect("items-changed", () => {
    if (pending) GLib.source_remove(pending);
    pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => { pending = 0; build(); return GLib.SOURCE_REMOVE; });
  });
  app.hold();
});

GLib.set_prgname("atlas-host");
app.run([System.programInvocationName]);
