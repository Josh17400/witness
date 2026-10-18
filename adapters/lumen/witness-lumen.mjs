#!/usr/bin/env node
// Witness bridge for Lumen games: starts Lumen's Electron shell in "witness" mode (a hidden
// window, deterministic test boot), which connects to WITNESS_ADDR and serves the Witness
// protocol on top of the Lumen.* test API. No dependencies beyond Lumen itself.
//
//   node witness-lumen.mjs <game.lum | game folder> [--lumen <lumen folder>] [--fps 60]
//                          [--width 1280 --height 720] [--scene Name]
//
// Lumen is found through --lumen, then LUMEN_HOME, then the folders above the game (games inside
// the Lumen repo), then an installed `lumen-lang` package, then a `lumen` folder next to Witness.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const die = (msg) => { console.error(`witness-lumen: ${msg}`); process.exit(2); };

function parseArgs(argv) {
  const opt = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) opt[a.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    else opt._.push(a);
  }
  return opt;
}

const isLumen = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name === "lumen-lang" && fs.existsSync(path.join(dir, "src", "desktop", "main.cjs"));
  } catch { return false; }
};

function findLumen(opt, gameDir) {
  const tried = [];
  const check = (dir, why) => { if (!dir) return null; const d = path.resolve(dir); tried.push(`${d} (${why})`); return isLumen(d) ? d : null; };
  let hit = check(opt.lumen, "--lumen") || check(process.env.LUMEN_HOME, "LUMEN_HOME");
  for (let d = gameDir; !hit; d = path.dirname(d)) {
    if (isLumen(d)) hit = d;
    if (path.dirname(d) === d) break;
  }
  if (!hit) {
    for (const base of [path.join(gameDir, "package.json"), path.join(process.cwd(), "package.json")]) {
      try { hit = check(path.dirname(createRequire(base).resolve("lumen-lang/package.json")), "lumen-lang package"); } catch { /* not installed */ }
      if (hit) break;
    }
  }
  hit = hit || check(path.join(here, "..", "..", "..", "lumen"), "next to Witness");
  if (!hit) die(`can't find Lumen. Pass --lumen <folder> or set LUMEN_HOME. Tried:\n  ${tried.join("\n  ")}`);
  return hit;
}

function findGame(target) {
  if (!target) die("usage: node witness-lumen.mjs <game.lum | game folder> [--lumen <folder>]");
  const p = path.resolve(target);
  if (!fs.existsSync(p)) die(`no such file or folder: ${p}`);
  if (fs.statSync(p).isFile()) return { dir: path.dirname(p), main: path.basename(p) };
  if (fs.existsSync(path.join(p, "game.lum"))) return { dir: p, main: "game.lum" };
  const withGame = fs.readdirSync(p).filter((f) => f.endsWith(".lum") && /^\s*game\s*\{/m.test(fs.readFileSync(path.join(p, f), "utf8")));
  if (withGame.length === 1) return { dir: p, main: withGame[0] };
  die(`${p} has no game.lum${withGame.length ? ` (several files declare a game: ${withGame.join(", ")}; pass one)` : ""}`);
}

/** Rebuild dist/lumen-runtime.js when it's missing or older than the runtime sources (like `lumen` does). */
function ensureRuntime(root) {
  const runtime = path.join(root, "dist", "lumen-runtime.js");
  let newest = 0;
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith("_")) walk(f); } else if (f.endsWith(".js")) newest = Math.max(newest, fs.statSync(f).mtimeMs);
    }
  };
  ["src/runtime", "src/compiler", "src/shared"].forEach((d) => walk(path.join(root, d)));
  if (fs.existsSync(runtime) && (process.env.LUMEN_NO_BUILD || fs.statSync(runtime).mtimeMs >= newest)) return runtime;
  console.error("witness-lumen: building the Lumen runtime (node build.mjs)…");
  const r = spawnSync(process.execPath, [path.join(root, "build.mjs")], { cwd: root, stdio: ["ignore", "ignore", "inherit"], windowsHide: true });
  if (r.status !== 0 || !fs.existsSync(runtime)) die("building the Lumen runtime failed (run 'node build.mjs' in the Lumen folder)");
  return runtime;
}

const opt = parseArgs(process.argv.slice(2));
const game = findGame(opt._[0]);
const root = findLumen(opt, game.dir);
let electron;
try { electron = createRequire(path.join(root, "package.json"))("electron"); }
catch { die(`Electron isn't installed in ${root}: run 'npm install' there`); }
const addr = process.env.WITNESS_ADDR || "127.0.0.1:7357";
if (!process.env.WITNESS_ADDR) console.error(`witness-lumen: WITNESS_ADDR isn't set, connecting to ${addr} (witness attach)`);

const config = {
  mode: "witness",
  witnessAddr: addr,
  gameDir: game.dir,
  main: game.main,
  runtimePath: ensureRuntime(root),
  playerHtml: path.join(root, "src", "runtime", "player.html"),
  fps: +opt.fps || 60,
  test: {
    width: +opt.width || 1280,
    height: +opt.height || 720,
    ...(opt.scene && opt.scene !== true ? { start: { scene: String(opt.scene), params: {} } } : {}),
  },
};
const env = { ...process.env, LUMEN_CONFIG: JSON.stringify(config) };
delete env.ELECTRON_RUN_AS_NODE;
const errLog = path.join(os.tmpdir(), "lumen-electron-errors.log");
const errBefore = fs.existsSync(errLog) ? fs.statSync(errLog).size : 0;

// boot.cjs is Lumen's headless launcher: it never shows error dialogs (errors go to errLog).
const child = spawn(electron, [path.join(root, "src", "desktop", "boot.cjs")], { env, stdio: "inherit", windowsHide: true });
const stop = () => { try { child.kill(); } catch { /* gone */ } };
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { stop(); process.exit(1); });
process.on("exit", stop);
child.on("error", (e) => die(`couldn't start Electron: ${e.message}`));
child.on("exit", (code) => {
  if (code && fs.existsSync(errLog) && fs.statSync(errLog).size > errBefore) {
    const fd = fs.openSync(errLog, "r"), n = fs.statSync(errLog).size - errBefore, b = Buffer.alloc(Math.min(n, 4000));
    fs.readSync(fd, b, 0, b.length, errBefore + n - b.length);
    fs.closeSync(fd);
    console.error(`witness-lumen: Electron failed:\n${b.toString("utf8").trim()}`);
  }
  process.exit(code ?? 1);
});
