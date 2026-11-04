// Atlas wallpaper for GNOME Shell (Wayland). Launches the WebKitGTK host
// (gnome/host/atlas-host.js), adopts its windows (titled
// "atlas-wallpaper|<connector>", owned by the child we spawned) and paints a
// live Clutter.Clone of each onto that monitor's background actor — the desktop,
// the overview and the workspace thumbnails alike. The real windows are
// minimized and hidden from every switcher, so they never take input or focus
// and never count as "fullscreen"; the clone keeps them rendering.
//
// Nobody-can-see-it pausing: once a second, each monitor is checked for a window
// covering its work area (maximized/fullscreen); the host is told over its stdin
// pipe and that page stops producing frames.
//
// Lock screen (Super+L): GNOME normally fades it to black and reports the
// screensaver active, which makes gnome-settings-daemon switch the monitors off
// at once. Instead the maps stay up — sharp (GNOME's blur is switched off) and
// live — until LOCK_SHOW_MS without input, then GNOME's own fade and blank run
// as usual and the pages pause.
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Clutter from "gi://Clutter";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as Background from "resource:///org/gnome/shell/ui/background.js";
import * as UnlockDialog from "resource:///org/gnome/shell/ui/unlockDialog.js";
import * as ScreenShield from "resource:///org/gnome/shell/ui/screenShield.js";
import { Extension, InjectionManager } from "resource:///org/gnome/shell/extensions/extension.js";

const TITLE_PREFIX = "atlas-wallpaper|";
const RESPAWN_LIMIT = 5; // host crashes tolerated per RESPAWN_WINDOW_S before giving up
const RESPAWN_WINDOW_S = 120;
const COVER_POLL_MS = 1000;
const CLONE_NAME = "atlas-wallpaper-clone";
const LOCK_SHOW_MS = 60 * 60 * 1000; // how long a locked, untouched screen keeps showing the maps
const LOCK_DIM = "background-color: rgba(0, 0, 0, 0.25);"; // keeps the lock-screen clock readable

export default class AtlasExtension extends Extension {
  enable() {
    this._windows = new Map(); // connector -> Meta.Window
    this._signals = [];
    this._crashes = [];
    this._timeouts = new Set();
    this._skipOverrides = new Map(); // prototype -> original skip_taskbar descriptor
    this._injections = new InjectionManager();
    this._hideFromShell();
    this._patchBackgrounds();
    this._patchLockScreen();

    this._connect(global.display, "window-created", (_d, win) => this._watch(win));
    this._connect(global.display, "notify::focus-window", () => {
      // A minimized window can't normally be focused, but never let ours keep it.
      const f = global.display.focus_window;
      if (f && this._isOurs(f)) global.display.unset_input_focus?.(global.get_current_time());
    });
    this._connect(Main.layoutManager, "monitors-changed", () => this._refreshBackgrounds());
    this._paused = new Map(); // connector -> last state sent to the host
    this._coverId = GLib.timeout_add(GLib.PRIORITY_LOW, COVER_POLL_MS, () => { this._updateCoverage(); return GLib.SOURCE_CONTINUE; });
    this._spawn();
  }

  disable() {
    for (const [obj, id] of this._signals) { try { obj.disconnect(id); } catch (e) {} }
    this._signals = [];
    if (this._respawnId) { GLib.source_remove(this._respawnId); this._respawnId = 0; }
    for (const id of this._timeouts) GLib.source_remove(id);
    this._timeouts.clear();
    if (this._refreshId) { GLib.source_remove(this._refreshId); this._refreshId = 0; }
    if (this._coverId) { GLib.source_remove(this._coverId); this._coverId = 0; }
    this._endLockHold();
    this._injections.clear();
    this._injections = null;
    this._restoreSkipTaskbar();
    const proc = this._proc;
    this._proc = null; // before force_exit, so the wait callback doesn't respawn
    this._stdin = null;
    proc?.force_exit();
    this._windows.clear();
    this._syncAllClones(); // strips every clone
  }

  // ---- host process ------------------------------------------------------
  _spawn() {
    const root = this.metadata["atlas-root"];
    const argv = ["gjs", "-m", GLib.build_filenamev([root, "gnome/host/atlas-host.js"]), "--managed"];
    try {
      const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDIN_PIPE });
      launcher.set_cwd(root);
      this._proc = launcher.spawnv(argv);
    } catch (e) {
      console.error("[atlas] could not start host: " + e.message);
      return;
    }
    this._pid = Number(this._proc.get_identifier());
    this._stdin = this._proc.get_stdin_pipe();
    this._outbox = [];
    this._writing = false;
    this._paused.clear();
    const proc = this._proc;
    proc.wait_async(null, () => {
      if (this._proc !== proc) return; // disabled or replaced
      this._proc = null;
      this._stdin = null;
      this._windows.clear();
      this._refreshBackgrounds();
      const now = GLib.get_monotonic_time() / 1e6;
      this._crashes = this._crashes.filter((t) => now - t < RESPAWN_WINDOW_S).concat(now);
      if (this._crashes.length > RESPAWN_LIMIT) {
        console.error("[atlas] host keeps exiting; giving up until the extension is re-enabled");
        return;
      }
      this._respawnId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
        this._respawnId = 0;
        this._spawn();
        return GLib.SOURCE_REMOVE;
      });
    });
  }

  // ---- adopting the host's windows ---------------------------------------
  _isOurs(win) {
    return !!this._proc && win.get_pid() === this._pid && (win.title || "").startsWith(TITLE_PREFIX);
  }

  _watch(win) {
    if (this._proc && win.get_pid() === this._pid) {
      if (!this._adopt(win)) this._connect(win, "notify::title", () => this._adopt(win));
    }
  }

  _adopt(win) {
    if (!this._isOurs(win)) return false;
    const connector = win.title.slice(TITLE_PREFIX.length);
    if (this._windows.get(connector) === win) return true;
    this._windows.set(connector, win);
    this._paused.delete(connector); // a fresh page starts unpaused; resend our view of it
    this._overrideSkipTaskbar(Object.getPrototypeOf(win));
    win.stick(); // on every workspace, and never keeps a dynamic workspace alive
    // Minimize once the first frame is in (or after 3 s), so the clone has content to show.
    const actor = win.get_compositor_private();
    let settled = false;
    const settle = () => {
      if (settled || this._windows.get(connector) !== win) return;
      settled = true;
      if (!win.minimized) win.minimize();
      this._refreshBackgrounds();
    };
    if (actor) this._connect(actor, "first-frame", settle);
    const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => { this._timeouts.delete(id); settle(); return GLib.SOURCE_REMOVE; });
    this._timeouts.add(id);
    this._connect(win, "unmanaged", () => {
      if (this._windows.get(connector) === win) { this._windows.delete(connector); this._refreshBackgrounds(); }
    });
    this._connect(win, "notify::minimized", () => { if (!win.minimized && this._isOurs(win)) win.minimize(); });
    return true;
  }

  // ---- painting: one clone per background actor --------------------------
  // New background actors (desktop rebuilds, overview, lock screen) get clones
  // as they're created; existing ones are found by walking the stage.
  _patchBackgrounds() {
    const ext = this;
    // Lock screen: GNOME blurs its background (90 px, 65% brightness) into a smear.
    this._injections.overrideMethod(UnlockDialog.UnlockDialog.prototype, "_updateBackgroundEffects", (orig) => function (...args) {
      orig.call(this, ...args);
      if (!ext._windows.size) return; // no live maps: keep GNOME's look for the stock wallpaper
      for (const widget of this._backgroundGroup) widget.get_effect("blur")?.set_enabled(false);
    });
    this._injections.overrideMethod(Background.BackgroundManager.prototype, "_createBackgroundActor", (orig) => function (...args) {
      const bg = orig.call(this, ...args);
      try { ext._syncClones(bg); } catch (e) { console.error("[atlas] " + e.message); }
      return bg;
    });
  }

  _syncClones(bg) {
    for (const c of bg.get_children()) if (c.name === CLONE_NAME) c.destroy();
    const mm = global.backend.get_monitor_manager();
    for (const [connector, win] of this._windows) {
      if (mm.get_monitor_for_connector(connector) !== bg.monitor) continue;
      const source = win.get_compositor_private();
      if (!source) continue;
      const clone = new Clutter.Clone({ source, name: CLONE_NAME, reactive: false });
      clone.add_constraint(new Clutter.BindConstraint({ source: bg, coordinate: Clutter.BindCoordinate.SIZE }));
      bg.add_child(clone);
      if (bg.get_parent()?.has_style_class_name?.("screen-shield-background")) {
        const dim = new St.Widget({ name: CLONE_NAME, style: LOCK_DIM, reactive: false });
        dim.add_constraint(new Clutter.BindConstraint({ source: bg, coordinate: Clutter.BindCoordinate.SIZE }));
        bg.add_child(dim);
      }
    }
  }

  // Desktop, overview workspaces, workspace thumbnails, lock screen: every
  // Meta.BackgroundActor currently on the stage.
  _refreshBackgrounds() {
    if (this._refreshId) return;
    this._refreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      this._refreshId = 0;
      this._syncAllClones();
      return GLib.SOURCE_REMOVE;
    });
  }

  _syncAllClones() {
    const walk = (actor) => {
      if (actor instanceof Meta.BackgroundActor) this._syncClones(actor);
      else for (const child of actor.get_children()) walk(child);
    };
    walk(global.stage);
  }

  // ---- lock screen: keep the maps up instead of fading straight to black ----
  // Private ScreenShield internals (GNOME 50): _lockScreenShown() fades to black
  // and calls _setActive(true); "active" is what gsd-power blanks on. While a
  // hold is on, the fade is skipped and active(true) deferred to an idle watch.
  _patchLockScreen() {
    const ext = this;
    const proto = ScreenShield.ScreenShield.prototype;
    this._injections.overrideMethod(proto, "_lockScreenShown", (orig) => function (params) {
      if (ext._windows.size && params?.fadeToBlack) {
        ext._startLockHold(this);
        params = { ...params, fadeToBlack: false, animateFade: false };
      }
      return orig.call(this, params);
    });
    this._injections.overrideMethod(proto, "_setActive", (orig) => function (active) {
      if (active && ext._lockHold) return; // deferred until the idle watch fires
      if (!active) ext._endLockHold();
      return orig.call(this, active);
    });
  }

  _startLockHold(shield) {
    this._endLockHold();
    const idle = global.backend.get_core_idle_monitor();
    this._lockHold = { idle, watch: idle.add_idle_watch(LOCK_SHOW_MS, () => {
      this._endLockHold();
      if (!Main.sessionMode.isLocked) return;
      shield._activateFade(shield._shortLightbox, 300); // GNOME's MANUAL_FADE_TIME
      shield._setActive(true); // gsd-power blanks the monitors as usual
    }) };
  }

  _endLockHold() {
    if (!this._lockHold) return;
    this._lockHold.idle.remove_watch(this._lockHold.watch);
    this._lockHold = null;
  }

  // ---- pause what nobody can see ------------------------------------------
  _updateCoverage() {
    if (!this._stdin || !this._windows.size) return;
    const locked = Main.sessionMode.isLocked;
    const blanked = locked && Main.screenShield.active; // GNOME faded/blanked the lock screen
    const overview = Main.overview.visible || Main.overview.animationInProgress;
    const mm = global.backend.get_monitor_manager();
    const ws = global.workspace_manager.get_active_workspace();
    for (const connector of this._windows.keys()) {
      const index = mm.get_monitor_for_connector(connector);
      let paused = blanked;
      if (!locked && !overview && index >= 0) {
        const area = Main.layoutManager.getWorkAreaForMonitor(index);
        paused = global.display.get_monitor_in_fullscreen(index) || ws.list_windows().some((w) => {
          if (w.minimized || this._isOurs(w) || !w.showing_on_its_workspace() || w.get_monitor() !== index) return false;
          const r = w.get_frame_rect();
          return r.x <= area.x && r.y <= area.y && r.x + r.width >= area.x + area.width && r.y + r.height >= area.y + area.height;
        });
      }
      if (this._paused.get(connector) === paused) continue;
      this._paused.set(connector, paused);
      this._send(`pause ${connector} ${paused ? 1 : 0}\n`);
    }
  }

  // Async so a wedged host can never block the compositor on a full pipe;
  // one write in flight at a time (GIO streams refuse concurrent operations).
  _send(line) {
    this._outbox.push(line);
    if (this._writing) return;
    const stdin = this._stdin;
    const next = () => {
      const msg = this._outbox.shift();
      if (!msg || this._stdin !== stdin) { this._writing = false; return; }
      this._writing = true;
      stdin.write_bytes_async(new GLib.Bytes(new TextEncoder().encode(msg)), GLib.PRIORITY_DEFAULT, null, (_s, res) => {
        try { stdin.write_bytes_finish(res); } catch (e) { console.error("[atlas] host pipe: " + e.message); }
        next();
      });
    };
    next();
  }


  // ---- invisibility: overview, workspace thumbnails, Alt-Tab, dash ----------
  _hideFromShell() {
    const ext = this;
    // Nearly every shell list filters on skip_taskbar; answer "yes" for ours.
    // GJS defines the accessor on each concrete class prototype
    // (MetaWindowWayland as well as MetaWindow), so each one gets the override.
    this._overrideSkipTaskbar(Meta.Window.prototype);
    // The host app must not appear as a running app in the dash / app switcher.
    this._injections.overrideMethod(Shell.AppSystem.prototype, "get_running", (orig) => function () {
      return orig.call(this).filter((app) => !app.get_windows().some((w) => ext._isOurs(w)));
    });
  }

  _overrideSkipTaskbar(proto) {
    for (; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      const desc = Object.getOwnPropertyDescriptor(proto, "skip_taskbar");
      if (!desc || this._skipOverrides.has(proto)) continue;
      this._skipOverrides.set(proto, desc);
      const ext = this;
      Object.defineProperty(proto, "skip_taskbar", {
        configurable: true,
        get() { return ext._isOurs(this) || desc.get.call(this); },
      });
    }
  }

  _restoreSkipTaskbar() {
    for (const [proto, desc] of this._skipOverrides) Object.defineProperty(proto, "skip_taskbar", desc);
    this._skipOverrides.clear();
  }

  _connect(obj, sig, fn) {
    this._signals.push([obj, obj.connect(sig, fn)]);
  }
}
