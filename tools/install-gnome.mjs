// GNOME counterpart of build-lively.mjs: installs the Shell extension (pointing
// it at this checkout), the planes CORS helper as a systemd user service, and
// refreshes monitor geometry.
//
//   node tools/install-gnome.mjs            install/update + enable
//   node tools/install-gnome.mjs --remove   disable and uninstall both
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UUID = "atlas@alpharceus.github.io";
const EXT_DIR = path.join(os.homedir(), ".local/share/gnome-shell/extensions", UUID);
const UNIT_DIR = path.join(os.homedir(), ".config/systemd/user");
const UNIT = "atlas-helper.service";
const run = (cmd, args, opts = {}) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }); } catch (e) { return null; } };

if (process.argv.includes("--remove")) {
  run("gnome-extensions", ["disable", UUID]);
  fs.rmSync(EXT_DIR, { recursive: true, force: true });
  run("systemctl", ["--user", "disable", "--now", UNIT]);
  fs.rmSync(path.join(UNIT_DIR, UNIT), { force: true });
  run("systemctl", ["--user", "daemon-reload"]);
  console.log("removed extension and helper service");
  process.exit(0);
}

execFileSync(process.execPath, [path.join(ROOT, "tools/detect-monitors.mjs")], { stdio: "inherit" });

// Extension: copy, and record where the checkout lives so it can find the host.
fs.mkdirSync(EXT_DIR, { recursive: true });
fs.copyFileSync(path.join(ROOT, "gnome/extension/extension.js"), path.join(EXT_DIR, "extension.js"));
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "gnome/extension/metadata.json"), "utf8"));
meta["atlas-root"] = ROOT;
fs.writeFileSync(path.join(EXT_DIR, "metadata.json"), JSON.stringify(meta, null, 2) + "\n");
console.log("installed extension ->", EXT_DIR);

// Planes helper (localhost CORS proxy for adsb.lol) as a user service.
fs.mkdirSync(UNIT_DIR, { recursive: true });
fs.writeFileSync(path.join(UNIT_DIR, UNIT), `[Unit]
Description=Project Atlas helper (local CORS proxy for aircraft data)
After=network-online.target

[Service]
ExecStart=${process.execPath} ${path.join(ROOT, "tools/atlas-helper.mjs")}
Restart=on-failure
RestartSec=10
Nice=10

[Install]
WantedBy=default.target
`);
run("systemctl", ["--user", "daemon-reload"]);
run("systemctl", ["--user", "enable", "--now", UNIT]);
run("systemctl", ["--user", "restart", UNIT]);
console.log("helper service:", (run("systemctl", ["--user", "is-active", UNIT]) || "inactive").trim());

// The running shell only discovers newly installed extensions at login; updates
// to an already-loaded one also need a re-login on Wayland.
const known = run("gnome-extensions", ["info", UUID]);
if (known && run("gnome-extensions", ["enable", UUID]) !== null) {
  console.log("extension enabled. If it was already running, log out and back in to load the new code.");
} else {
  run("gsettings", ["set", "org.gnome.shell", "disable-user-extensions", "false"]);
  const cur = run("gsettings", ["get", "org.gnome.shell", "enabled-extensions"]) || "@as []";
  if (!cur.includes(UUID)) {
    const list = cur.replace(/^@as /, "").trim();
    const next = list === "[]" ? `['${UUID}']` : list.replace(/]$/, `, '${UUID}']`);
    run("gsettings", ["set", "org.gnome.shell", "enabled-extensions", next]);
  }
  console.log("extension marked enabled; log out and back in for GNOME Shell to load it.");
}
