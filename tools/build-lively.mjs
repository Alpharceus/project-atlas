// Assemble a self-contained Lively wallpaper bundle from app/ + config/ + maps/*.js
// and drop it into Lively's Library, then (optionally) set it as the wallpaper.
//
//   node tools/build-lively.mjs          # build only
//   node tools/build-lively.mjs --set    # build + `Lively.exe --layout span` + setwp
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(process.env.LOCALAPPDATA, "Lively Wallpaper", "Library", "wallpapers", "project-atlas");
const LIVELY = "C:\\Program Files\\Lively Wallpaper\\Lively.exe";

await fs.rm(LIB, { recursive: true, force: true });
await fs.mkdir(path.join(LIB, "config"), { recursive: true });
await fs.mkdir(path.join(LIB, "maps"), { recursive: true });

for (const f of await fs.readdir(path.join(ROOT, "app"))) {
  if ((await fs.stat(path.join(ROOT, "app", f))).isDirectory()) continue;
  let src = await fs.readFile(path.join(ROOT, "app", f));
  if (f === "index.html") src = Buffer.from(src.toString("utf8").replaceAll('src="../', 'src="'));
  await fs.writeFile(path.join(LIB, f), src);
}
for (const f of await fs.readdir(path.join(ROOT, "config"))) await fs.copyFile(path.join(ROOT, "config", f), path.join(LIB, "config", f));
for (const f of await fs.readdir(path.join(ROOT, "app/modules"))) { await fs.mkdir(path.join(LIB, "modules"), { recursive: true }); await fs.copyFile(path.join(ROOT, "app/modules", f), path.join(LIB, "modules", f)); }
for (const f of (await fs.readdir(path.join(ROOT, "maps"))).filter((f) => f.endsWith(".js"))) await fs.copyFile(path.join(ROOT, "maps", f), path.join(LIB, "maps", f));
console.log("built", LIB);

if (process.argv.includes("--set")) {
  spawnSync(LIVELY, ["--layout", "span"], { stdio: "inherit" });
  await new Promise((r) => setTimeout(r, 2000));
  spawnSync(LIVELY, ["setwp", "--file", LIB], { stdio: "inherit" });
  console.log("setwp sent");
}
