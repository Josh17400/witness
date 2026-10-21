// Witness core: find witness.json, start the game in witness mode, return a connected Session.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { listen, WitnessError } from "./session.js";
import { acquireSlot } from "./budget.js";
import { track, untrack } from "./procs.js";

export const CONFIG_NAME = "witness.json";
export const DEFAULT_ATTACH_PORT = 7357;

// A Windows path written with single backslashes is still valid JSON but silently wrong: "tools\build.bat" holds a
// backspace (\b), "src\new" a newline. No real command or path contains control characters, so refuse them.
function checkControlChars(v, file, at = "") {
  if (typeof v === "string") {
    const m = /[\u0000-\u001f]/.exec(v);
    if (m) {
      const shown = JSON.stringify(v), esc = { "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" }[m[0]] || `\\u${m[0].charCodeAt(0).toString(16).padStart(4, "0")}`;
      throw new WitnessError(`${file}: ${at || "a value"} is ${shown}: it contains ${esc}, which JSON reads as a control character — ` +
        "a Windows path needs doubled backslashes (\"tools\\\\build.bat\") or forward slashes (\"tools/build.bat\")");
    }
  } else if (Array.isArray(v)) v.forEach((x, i) => checkControlChars(x, file, `${at}[${i}]`));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) checkControlChars(x, file, at ? `${at}.${k}` : k);
}

function readConfig(f) {
  let config;
  try { config = JSON.parse(fs.readFileSync(f, "utf8")); }
  catch (e) { throw new WitnessError(`${f} isn't valid JSON: ${e.message}`); }
  checkControlChars(config, f);
  return { config: normalize(config), root: path.dirname(f), file: f };
}

/** `start` is a folder (walk up from it to a witness.json) or a config file of any name (witness.web.json beside
 *  witness.json): that file is loaded, and its folder is the project root. */
export function findConfig(start = process.cwd()) {
  let dir = path.resolve(start);
  if (fs.existsSync(dir) && fs.statSync(dir).isFile()) {
    if (/\.json$/i.test(dir)) return readConfig(dir);
    dir = path.dirname(dir);
  }
  for (;;) {
    const f = path.join(dir, CONFIG_NAME);
    if (fs.existsSync(f)) return readConfig(f);
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function normalize(c) {
  return {
    name: c.name || "game",
    launch: c.launch || null,       // {command, args, cwd, env} | {attach: true, port} | {url, server?}
    build: c.build || null,         // shell command run by --build
    tests: c.tests || "witness",    // folder (or file) with *.witness.json / *.witness.mjs
    fps: c.fps || null,             // overrides the adapter's hello.fps
    seed: c.seed ?? 1,
    timeout: c.timeout || 60,       // seconds to wait for the game to connect
    shots: c.shots || "witness/shots",
    replays: c.replays || "witness/replays",
    ...c,
  };
}

export function runBuild(cfg, root, { quiet = false } = {}) {
  if (!cfg.build) return true;
  if (!quiet) console.error(`▸ build: ${cfg.build}`);
  const r = spawnSync(cfg.build, { cwd: root, shell: true, stdio: quiet ? "pipe" : "inherit" });
  if (r.status !== 0) throw new WitnessError(`build failed (exit ${r.status}): ${cfg.build}${quiet && r.stderr ? "\n" + r.stderr.toString().slice(-2000) : ""}`);
  return true;
}

// The virtual clock's Date epoch (JS adapter): witness.json "clock": {"epoch": "2026-06-15" | "2026-06-15T09:00:00Z" |
// "today" | ms}. "today" is this run's date at 00:00 UTC, resolved once per config and pinned for every reset and
// relaunch of the run; the CLI sends it with each reset (and in the page URL / WITNESS_EPOCH so boot code sees it too),
// and play recordings keep it in their header so a replay restarts the Date exactly there. null: the adapter's own
// default (2026-01-01T00:00:00Z for the JS adapter).
export const DEFAULT_EPOCH = Date.UTC(2026, 0, 1);
const pinnedEpochs = new WeakMap();
export function resolveEpoch(cfg) {
  if (pinnedEpochs.has(cfg)) return pinnedEpochs.get(cfg);
  const v = cfg && cfg.clock && typeof cfg.clock === "object" ? cfg.clock.epoch : null;
  let ms = null;
  if (v != null && v !== "") {
    if (typeof v === "number" || /^-?\d+$/.test(String(v))) ms = Math.floor(+v);
    else if (String(v).toLowerCase() === "today") { const d = new Date(); ms = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }
    else {
      const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? `${v}T00:00:00Z` : String(v));
      if (!Number.isFinite(t)) throw new WitnessError(`${CONFIG_NAME}: clock.epoch ${JSON.stringify(v)} isn't a date: use an ISO date ("2026-06-15" or "2026-06-15T09:00:00Z"), "today" or ms since 1970`);
      ms = t;
    }
  }
  pinnedEpochs.set(cfg, ms);
  return ms;
}
/** One line about the virtual Date for doctor (JS adapter games). */
export function epochNote(session) {
  const ms = session.epoch != null ? session.epoch : DEFAULT_EPOCH;
  const iso = new Date(ms).toISOString().replace(/T00:00:00\.000Z$/, "").replace(/\.000Z$/, "Z");
  return session.epoch != null
    ? `clock: the game's Date starts at ${iso} at every reset (witness.json clock.epoch), then follows simulated time`
    : `clock: the game's Date is virtual and starts at ${iso} (the default): countdowns to real dates read from there; set "clock": {"epoch": "today"} (or an ISO date) in ${CONFIG_NAME}`;
}

/**
 * Browser launches: session.web (device, engine, audio policy, page facts), the auto-unlock gesture at connect, and
 * screenshots from the screen (capture "element" / "screen") instead of the adapter's canvas readback.
 */
async function attachWeb(session, web) {
  session.web = web;
  if (web.policy === "auto") { try { web.autoUnlocked = await web.unlock(); } catch { web.autoUnlocked = 0; } }
  // a DOM game (no visible <canvas>): screenshots are of the viewport, unless launch.capture says otherwise
  if (web.captureMode === "canvas" && !web.captureSet) {
    try {
      const info = await web.info();
      if (info && !(info.canvases || []).some((c) => c.rect[2] * c.rect[3] > 0)) { web.captureMode = "screen"; web.dom = true; }
    } catch { /* attached page */ }
  }
  if (web.captureMode !== "canvas") {
    const caps = session.hello.capabilities || (session.hello.capabilities = []);
    if (!caps.includes("screenshot")) caps.push("screenshot");
    session.screenshot = async () => {
      const c = await web.capture(web.captureMode);
      return { width: c.width, height: c.height, format: "png", data: c.png.toString("base64") };
    };
  }
  // --safe-overlay: the island, home indicator and rounded corners drawn over every screenshot after capture, mapped
  // from the viewport onto what was captured (the viewport, the canvas element, or the game's own canvas pixels)
  if (web.safeOverlay) {
    const base = session.screenshot.bind(session);
    session.screenshot = async (...a) => {
      const sh = await base(...a);
      const [{ decodePNG, encodePNG }, { drawSafeOverlay }] = await Promise.all([import("../media/png.js"), import("../media/safe-overlay.js")]);
      const buf = sh.path ? fs.readFileSync(path.resolve(sh.path)) : Buffer.from(sh.data, "base64");
      const img = sh.path || sh.format === "png" ? decodePNG(buf) : { width: sh.width, height: sh.height, data: new Uint8Array(buf.buffer, buf.byteOffset, buf.length).slice() };
      const info = await web.info();
      let best = null;
      for (const c of (info && info.canvases) || []) if (c.rect[2] * c.rect[3] > 0 && (!best || c.rect[2] * c.rect[3] > best.rect[2] * best.rect[3])) best = c;
      const vw = info.viewport[0], vh = info.viewport[1];
      const map = web.captureMode === "screen" || !best ? { ox: 0, oy: 0, kx: img.width / vw, ky: img.height / vh }
        : { ox: best.rect[0], oy: best.rect[1], kx: img.width / best.rect[2], ky: img.height / best.rect[3] };
      web.overlayDrawn = drawSafeOverlay(img, web.safeOverlay, vw, vh, map);
      return { width: img.width, height: img.height, format: "png", data: Buffer.from(encodePNG(img.width, img.height, img.data)).toString("base64") };
    };
  }
}

/**
 * launch.reset (browser games): "auto" (default) reloads the page for a reset when the game registered no reset
 * handler, "reload" always does, "handler" never does. A reload clears localStorage / sessionStorage first (keep them
 * with launch.keepStorage: true), loads the page again with ?witness_seed=<seed> (and the epoch), waits for the new
 * hello and goes on over the new connection: the same Session, fresh in-memory state, the Date back at the epoch.
 * A reset right after the page (re)loaded, before any step, doesn't reload again.
 */
function setupReload(session, web, launch, srv, timeoutMs) {
  const mode = String(launch.reset || "auto").toLowerCase();
  if (!["auto", "reload", "handler"].includes(mode)) throw new WitnessError(`launch.reset ${JSON.stringify(launch.reset)}: use "auto" (reload the page when the game has no reset handler), "reload" or "handler"`);
  const handler = session.has("reset");
  if (mode === "handler" || (mode === "auto" && handler)) return;
  web.resetMode = "reload";
  if (!handler) (session.hello.capabilities || (session.hello.capabilities = [])).push("reset");
  let fresh = true;   // nothing ran since the page loaded
  for (const m of ["step", "input", "call"]) {
    const f = session[m].bind(session);
    session[m] = (...a) => { fresh = false; return f(...a); };
  }
  web.reloads = 0;
  session.reset = async (seed, scene, params, epoch = session.epoch) => {
    if (!fresh) {
      const next = srv.nextSession(timeoutMs);
      next.catch(() => {});
      await web.reload({ witness_seed: seed ?? 1, witness_epoch: epoch }, { keepStorage: !!launch.keepStorage });
      const s2 = await next;
      session.adopt(s2);
      web.reloads++;
      if (web.policy === "auto") { try { await web.unlock(); } catch { /* none */ } }
    }
    fresh = true;   // until the next step / input / call
    return session.request("reset", { seed, ...(scene ? { scene } : {}), ...(params ? { params } : {}), ...(epoch != null ? { epoch } : {}), reloaded: true });
  };
}

const tail = (out, n = 3000) => out.join("").slice(-n);

/**
 * Godot's --write-movie creates no folders, and a missing one crashes current Godot at startup: make the folder of a
 * relative movie path (against --path, else the launch folder). user:// and res:// paths are Godot's own business.
 */
export function movieDirs(args, cwd) {
  const a = (args || []).map(String), i = a.indexOf("--write-movie"), p = i >= 0 ? a[i + 1] : null;
  if (!p || /^[a-z]+:\/\//i.test(p)) return [];
  const j = a.indexOf("--path"), base = j >= 0 && a[j + 1] ? path.resolve(cwd, a[j + 1]) : cwd;
  const dir = path.dirname(path.resolve(base, p));
  try { fs.mkdirSync(dir, { recursive: true }); return [dir]; } catch { return []; }
}

/**
 * Start (or attach to) the game and return {session, stop(), restart(), proc, output()}.
 * opts: {attach, port, timeout, env, quiet}. A launch (not --attach) first takes a machine-wide heavy-process slot
 * (src/core/budget.js); the game and its dev server are killed with their process trees on stop, and when the CLI
 * exits for any reason (src/core/procs.js). restart(): stop, then launch again (a fresh process: tests on an adapter
 * without 'reset'); the returned object is updated in place.
 */
export async function openGame(cfg, root, opts = {}) {
  const launch = cfg.launch || {};
  const attach = opts.attach || launch.attach;
  if (!attach && !launch.url && !launch.command) throw new WitnessError(`${CONFIG_NAME} has no "launch" — add {"launch": {"command": "path/to/game", "args": []}} (or "attach": true, or "url": "..."). Run 'witness init' for a template.`);
  const slot = attach ? null : await acquireSlot({ browser: !!launch.url, label: `${cfg.name || "game"}: witness ${process.argv.slice(2).join(" ")}`.slice(0, 160) });
  let srv;
  try { srv = await listen({ port: attach ? (opts.port || launch.port || DEFAULT_ATTACH_PORT) : 0 }); }
  catch (e) { if (slot) slot.release(); throw e.code === "EADDRINUSE" ? new WitnessError(`port ${e.port || opts.port || launch.port || DEFAULT_ATTACH_PORT} is in use: another Witness is waiting there (or pass --port)`) : e; }
  const addr = `127.0.0.1:${srv.port}`;
  const epoch = resolveEpoch(cfg);
  let proc = null, browser = null, server = null, web = null;
  const out = [];
  const keep = (d) => { out.push(d.toString()); if (out.length > 400) out.splice(0, out.length - 400); };
  const killAll = async (grace = 2000) => {
    if (proc) {
      if (proc.exitCode === null && proc.signalCode === null && proc.pid != null) {
        await new Promise((r) => { const t = setTimeout(() => { proc.kill(); r(); }, grace); proc.once("exit", () => { clearTimeout(t); r(); }); });
      }
      proc.kill("SIGKILL");   // the rest of its tree (posix: its process group; a no-op once it's gone on Windows)
      untrack(proc);
    }
    if (browser) await browser.close().catch(() => {});
    if (server) { server.kill(); untrack(server); }
    srv.close();
    if (slot) slot.release();
  };

  try {
    if (attach) {
      if (!opts.quiet) console.error(`▸ waiting for a game to connect on ${addr} (start it with WITNESS_ADDR=${addr}, or the adapter's default)…`);
    } else if (launch.url) {
      // Browser games: optional dev server + headless browser (see src/core/browser.js).
      const { openBrowserGame } = await import("./browser.js");
      ({ browser, server, web } = await openBrowserGame(launch, root, addr, keep, { query: { witness_epoch: epoch } }));
    } else {
      const env = { ...process.env, ...(launch.env || {}), ...(opts.env || {}), WITNESS_ADDR: addr, WITNESS: "1", ...(epoch != null ? { WITNESS_EPOCH: String(epoch) } : {}) };
      movieDirs(launch.args, path.resolve(root, launch.cwd || "."));
      // posix: its own process group, so a stop or Ctrl-C takes the whole tree (a shell's game, a launcher's child)
      proc = track(spawn(launch.command, launch.args || [], {
        cwd: path.resolve(root, launch.cwd || "."), env, shell: !!launch.shell, windowsHide: true, detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      }));
      proc.stdout.on("data", keep);
      proc.stderr.on("data", keep);
    }

    // the game exiting (or failing to start at all: ENOENT never emits "exit") ends the wait at once
    const exited = proc ? new Promise((res) => { proc.on("exit", (code) => res({ code })); proc.on("error", (error) => res({ error })); }) : new Promise(() => {});
    const next = srv.nextSession((opts.timeout || cfg.timeout || 60) * 1000);
    next.catch(() => {});   // when the exit wins the race, its timeout must not fire later as an unhandled rejection
    const session = await Promise.race([
      next,
      exited.then(({ code, error }) => {
        if (error) throw new WitnessError(`couldn't start the game: ${error.message} (launch.command ${JSON.stringify(launch.command)}${launch.cwd ? ` in ${launch.cwd}` : ""}: is it built, and is the path right?)${out.length ? `\n--- game output ---\n${tail(out)}` : ""}`);
        throw new WitnessError(`the game exited (code ${code}) before connecting to Witness.\n--- game output ---\n${tail(out)}`);
      }),
    ]);
    if (cfg.fps) session.hello.fps = cfg.fps;
    session.epoch = epoch;
    if (web) {
      await attachWeb(session, web);
      setupReload(session, web, launch, srv, (opts.timeout || cfg.timeout || 60) * 1000);
    }
    const handle = {
      session, proc, output: () => out.join(""),
      stop: async () => { await session.quit(); session.close(); await killAll(); },
      restart: async () => {
        if (attach) throw new WitnessError("can't restart a game Witness didn't launch (--attach): add 'reset' to the adapter");
        await handle.stop();
        // keep this restart: the fresh handle's own would update it, not the one the caller holds (3rd+ restart)
        const { restart: _r, ...fresh } = await openGame(cfg, root, opts);
        Object.assign(handle, fresh);
        return handle.session;
      },
    };
    return handle;
  } catch (e) {
    await killAll(0).catch(() => {});
    // what the game (or the page) printed is often the reason it never connected
    if (e instanceof WitnessError && out.length && !/--- game output ---/.test(e.message)) e.message += `\n--- game output ---\n${tail(out)}`;
    throw e;
  }
}
