// Witness core: a machine-wide budget of heavy processes, so parallel agents, test runs and playtests can't pile up
// games and headless browsers (a PC once crashed from ~100 headless browsers). Every launch (a game command or a
// browser page; not --attach) takes a slot first and gives it back when the game stops or the CLI exits.
//   <tmpdir>/witness-budget/ (beside the play registry; WITNESS_BUDGET_DIR moves it)
//   slot-<i>.json      any launch, i < WITNESS_MAX_PROCS (default 3; 0 = no limit)
//   browser-<i>.json   headless browsers also take one of these, i < WITNESS_MAX_BROWSERS (default 1)
// A slot file names its owner by pid AND the OS's start time for that pid, so a crashed owner's slot is taken back
// and a pid the OS gave to another process doesn't keep holding it; `at` (when the slot was taken, not when it began waiting; an older file without it: its
// mtime) shows how long each holder has run. A launch waits for a free slot (saying so, then every ~60 s), then fails
// after WITNESS_BUDGET_WAIT seconds: default 600 for the long batch commands (test, doctor, play batch), else 90
// (under the 120 s an agent's Bash tool waits for a quick command: play start/do, shot, eval ...).
// While the owner has a game open (they're playing: RAM is theirs), the caps drop to WITNESS_MAX_PROCS_GAMING (default
// 2; 0 or WITNESS_GAMING_PROBE=0 = off): min(WITNESS_MAX_PROCS, it), min(WITNESS_MAX_BROWSERS, it). Checked at every
// acquire and while waiting; running holders are never touched, only new launches wait. "A game is open": a process
// whose executable lives in a store's game folder (GAME_DIRS; WITNESS_GAME_RE adds, WITNESS_GAME_EXCLUDE_RE removes),
// not a crash handler/launcher/updater; one probe per ~30 s machine-wide (gaming.json here), a failed probe = no game.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { WitnessError } from "./session.js";
import { atExit } from "./procs.js";

const envInt = (k, d) => { const v = process.env[k]; return v !== undefined && v !== "" && Number.isFinite(+v) ? Math.max(0, Math.floor(+v)) : d; };
export const budgetDir = () => process.env.WITNESS_BUDGET_DIR
  || path.join(process.env.WITNESS_PLAY_REGISTRY ? path.dirname(path.resolve(process.env.WITNESS_PLAY_REGISTRY)) : os.tmpdir(), "witness-budget");
export const budgetLimits = () => ({ max: envInt("WITNESS_MAX_PROCS", 3), maxBrowsers: envInt("WITNESS_MAX_BROWSERS", 1), waitMs: envInt("WITNESS_BUDGET_WAIT", defaultWaitSec()) * 1000 });
/** The default wait (s) of a command line: 600 for the long batch commands (run in the background anyway), else 90. */
export const defaultWaitSec = (argv = process.argv.slice(2)) => (/^(test|doctor)$/.test(argv[0]) || (argv[0] === "play" && argv[1] === "batch") ? 600 : 90);
/** 40 s, 4 min, 1 h 5 min */
export const fmtAge = (ms) => { const s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60); return s < 60 ? `${s} s` : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/**
 * The OS's start time of each pid, as an opaque string (equal only for the same process): /proc on Linux, one
 * PowerShell call on Windows, ps elsewhere. A pid missing from the map couldn't be read (gone, or not allowed).
 */
export function startKeys(pids) {
  const out = new Map();
  pids = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  if (!pids.length) return out;
  try {
    if (process.platform === "linux") {
      for (const p of pids) { try { const s = fs.readFileSync(`/proc/${p}/stat`, "utf8"); const f = s.slice(s.lastIndexOf(")") + 2).split(" "); if (f[19]) out.set(p, `t${f[19]}`); } catch { /* gone */ } }
      return out;
    }
    const r = process.platform === "win32"
      ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { try { '{0} {1}' -f $_.Id, $_.StartTime.ToUniversalTime().Ticks } catch { } }`], { encoding: "utf8", windowsHide: true, timeout: 20000 })
      // lstart is strftime("%c", localtime): a fixed locale and zone, so every Witness process writes and reads the same key
      : spawnSync("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], { encoding: "utf8", timeout: 10000, env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" } });
    for (const line of String(r.stdout || "").split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (m && pids.includes(+m[1])) out.set(+m[1], m[2]);
    }
  } catch { /* unreadable: callers fall back to the pid alone */ }
  return out;
}
// ---- "a game is open": the gaming cap
export const GAME_DIRS = /[\\/](steamapps[\\/]common|Epic Games|GOG Galaxy[\\/]Games|GOG Games|XboxGames|EA Games)[\\/]|[\\/]Desktop[\\/]Embervale\.exe$/i;
// helper exe names (crash handlers by their forms only: Crashlands.exe is a game) and tray tools that live in a game folder
export const NOT_GAME = /crash(pad|handler|report|sender|_?reporter|dump)|^crs-|launcher|helper|updater|easyanticheat|redist|webhelper/i;
export const NOT_GAME_DIR = /[\\/](Epic Games[\\/](Launcher|Epic Online Services)|steamapps[\\/]common[\\/](Steamworks Shared|Lossless Scaling|wallpaper_engine|SteamVR|Steam Controller Configs))[\\/]/i;
const envRe = (k) => { const v = process.env[k]; if (!v) return null; try { return new RegExp(v, "i"); } catch { return null; } };
/** The executable name if this path is a running game's (else null): under a game folder or WITNESS_GAME_RE, not a helper. */
export function gameExe(p) {
  if (!p || typeof p !== "string") return null;
  const name = p.split(/[\\/]/).pop(), inc = envRe("WITNESS_GAME_RE"), exc = envRe("WITNESS_GAME_EXCLUDE_RE");
  if (!(GAME_DIRS.test(p) || (inc && inc.test(p))) || NOT_GAME.test(name) || NOT_GAME_DIR.test(p) || (exc && exc.test(p))) return null;
  return name;
}
/** The executable paths of running processes (one CIM query on Windows: ~0.3-0.8 s; Get-Process .Path took ~10 s under load). */
export function exePaths(timeout = 15000) {
  if (process.platform === "linux") {
    const out = [];
    for (const n of fs.readdirSync("/proc")) if (/^\d+$/.test(n)) { try { out.push(fs.readlinkSync(`/proc/${n}/exe`)); } catch { /* not ours / gone */ } }
    return out;
  }
  const r = process.platform === "win32"
    ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Property ExecutablePath | ForEach-Object { $_.ExecutablePath }"], { encoding: "utf8", windowsHide: true, timeout })
    : spawnSync("ps", ["-axo", "comm="], { encoding: "utf8", timeout });   // macOS: comm is the full path
  if (r.error || (r.status !== 0 && !r.stdout)) throw new Error(r.error ? r.error.message : `exit ${r.status}`);
  return String(r.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}
/** Run the probe now: { game: exe name or null, path, ms, error }. A failure or timeout is "no game" (never blocks). */
export function probeGame() {
  const t0 = Date.now();
  try { for (const p of exePaths()) { const g = gameExe(p); if (g) return { game: g, path: p, ms: Date.now() - t0 }; } return { game: null, ms: Date.now() - t0 }; }
  catch (e) { return { game: null, ms: Date.now() - t0, error: e.message }; }
}
/**
 * The open game's exe name, or null: WITNESS_GAMING_FORCE (tests: 0 = none, 1 = "a game", else that name) first, then
 * <dir>/gaming.json if under maxAgeMs old (written atomically; unreadable/stale = probe again), else a fresh probe.
 */
export function openGame({ dir = budgetDir(), maxAgeMs = 30000, probe = probeGame } = {}) {
  const f = process.env.WITNESS_GAMING_FORCE;
  if (f !== undefined && f !== "") return f === "0" ? null : f === "1" ? "a game" : f;
  if (process.env.WITNESS_GAMING_PROBE === "0" || envInt("WITNESS_MAX_PROCS_GAMING", 2) === 0) return null;
  const file = path.join(dir, "gaming.json"), c = readSlot(file), age = c && Date.now() - c.at;
  if (c && Number.isFinite(age) && age >= 0 && age < maxAgeMs) return c.game || null;
  const r = probe(), tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), game: r.game || null, path: r.path || null, ms: r.ms, error: r.error || undefined }));
    fs.renameSync(tmp, file);
  } catch { try { fs.unlinkSync(tmp); } catch { /* never written */ } /* locked or read-only: the next acquire probes again */ }
  return r.game || null;
}
/**
 * The caps in force: {max, maxBrowsers, game, gamingMax, lowered, loweredBrowsers}. With a game open, each becomes
 * min(it, gamingMax) (an unlimited 0 becomes gamingMax). `game` undefined = ask openGame().
 */
export function effectiveLimits({ max, maxBrowsers, gamingMax, game, dir } = {}) {
  const L = budgetLimits();
  max = max ?? L.max; maxBrowsers = maxBrowsers ?? L.maxBrowsers; gamingMax = gamingMax ?? envInt("WITNESS_MAX_PROCS_GAMING", 2);
  if (game === undefined) game = gamingMax ? openGame({ dir }) : null;
  const cap = (n) => (game && gamingMax ? (n ? Math.min(n, gamingMax) : gamingMax) : n);
  const m = cap(max), b = cap(maxBrowsers);
  return { max: m, maxBrowsers: b, game: game || null, gamingMax, lowered: m !== max, loweredBrowsers: b !== maxBrowsers };
}

let ownKey;
const myKey = () => (ownKey !== undefined ? ownKey : (ownKey = startKeys([process.pid]).get(process.pid) ?? null));

const readSlot = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const ageMs = (f) => { try { return Date.now() - fs.statSync(f).mtimeMs; } catch { return 0; } };

/**
 * The slot files of a budget folder with their owners: [{file, kind, owner, stale}]. stale: the owner's pid is gone,
 * or the pid now belongs to a process that started at another time, or the file is unreadable and over 10 s old
 * (a writer that died between creating and filling it). `known` caches start keys across polls.
 */
export function scanSlots(dir, known = new Map()) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^(slot|browser)-\d+\.json$/.test(n)); } catch { return []; }
  const rows = names.map((n) => { const file = path.join(dir, n); return { file, kind: n.split("-")[0], owner: readSlot(file) }; });
  const ask = rows.filter((r) => r.owner && r.owner.pid !== process.pid && r.owner.key && pidAlive(r.owner.pid) && !known.has(r.owner.pid)).map((r) => r.owner.pid);
  for (const [p, k] of startKeys(ask)) known.set(p, k);
  for (const r of rows) {
    const o = r.owner;
    if (!o) r.stale = ageMs(r.file) > 10000;
    else if (!pidAlive(o.pid)) r.stale = true;
    else if (o.pid === process.pid) r.stale = !!(o.key && myKey() && o.key !== myKey());
    else r.stale = !!(o.key && known.has(o.pid) && known.get(o.pid) !== o.key);
  }
  return rows;
}

/** Remove a stale slot without racing another reclaimer: move it aside, and put it back if it was already replaced. */
function reclaim(row, token) {
  const aside = `${row.file}.reap-${token}`;
  try { fs.renameSync(row.file, aside); } catch { return; }
  const got = readSlot(aside);
  const same = row.owner ? got && got.token === row.owner.token : !got;
  if (!same) { try { fs.linkSync(aside, row.file); } catch { /* someone took the place meanwhile */ } }
  try { fs.unlinkSync(aside); } catch { /* gone */ }
}

function take(dir, kind, n, me) {
  for (let i = 0; i < n; i++) {
    const file = path.join(dir, `${kind}-${i}.json`);
    try { fs.writeFileSync(file, JSON.stringify({ ...me, kind, at: new Date().toISOString() }), { flag: "wx" }); return file; } catch (e) { if (e.code !== "EEXIST") throw e; }
  }
  return null;
}
function drop(file, token) { const o = readSlot(file); if (o && o.token === token) { try { fs.unlinkSync(file); } catch { /* gone */ } } }

/** A holder row as "the-fort: witness play _daemon b1 (pid 123, running 4 min)"; `at`, else the file's mtime (older files). */
export function who(r, now = Date.now()) {
  const o = r.owner;
  if (!o) return "a launch starting";
  let since = Date.parse(o.at || "");
  if (!Number.isFinite(since)) { try { since = fs.statSync(r.file).mtimeMs; } catch { since = NaN; } }
  const run = Number.isFinite(since) ? `, running ${fmtAge(now - since)}` : "";
  return o.label ? `${o.label} (pid ${o.pid}${run})` : `pid ${o.pid}${run ? ` (${run.slice(2)})` : ""}`;
}

/**
 * Take a heavy-process slot (and a browser slot when `browser`). Waits while the machine is at its limit, then throws.
 * Returns { release() } (also released when the process exits). opts override the environment (tests); game: the open
 * game's name / null / a function asked on each poll (default: openGame()), gamingMax: WITNESS_MAX_PROCS_GAMING.
 */
export async function acquireSlot({ browser = false, label = "", log = (m) => console.error(m), dir = budgetDir(), max: max0, maxBrowsers: maxB0, gamingMax, game: game0, waitMs, pollMs = 1000, progressMs = 60000 } = {}) {
  const L = budgetLimits();
  max0 = max0 ?? L.max; maxB0 = maxB0 ?? L.maxBrowsers; waitMs = waitMs ?? L.waitMs;
  // the caps in force now (a game open lowers them; asked again on every poll: cached ~30 s machine-wide)
  const limits = () => effectiveLimits({ max: max0, maxBrowsers: maxB0, gamingMax, game: typeof game0 === "function" ? game0() : game0, dir });
  let E = limits(), max = E.max, maxBrowsers = E.maxBrowsers;
  if (!max) return { release() {}, files: [] };
  fs.mkdirSync(dir, { recursive: true });
  const me = { pid: process.pid, key: myKey(), token: crypto.randomBytes(8).toString("hex"), browser, label: String(label).slice(0, 160) };
  const known = new Map(), t0 = Date.now();
  let told = 0;
  // under a lowered cap the slot files of earlier holders (taken under the full cap, maybe at higher indices) still
  // count: keep a taken slot only if fewer than `n` live holders of that kind took theirs before it (a slot still
  // being written, no owner yet, counts as ahead: two at the same instant both drop and retry on the next poll)
  const within = (file, kind, n) => {
    if (!file) return null;
    const mine = readSlot(file), at = (o) => Date.parse((o && o.at) || "") || 0, idx = (f) => +/-(\d+)\.json$/.exec(f)[1];
    const ahead = scanSlots(dir, known).filter((r) => r.kind === kind && !r.stale && r.file !== file
      && (!r.owner || at(r.owner) < at(mine) || (at(r.owner) === at(mine) && idx(r.file) < idx(file)))).length;
    if (ahead < n) return file;
    drop(file, me.token); return null;
  };
  for (;;) {
    if (told) { E = limits(); if (!E.max) return { release() {}, files: [] }; max = E.max; maxBrowsers = E.maxBrowsers; }
    const rows = scanSlots(dir, known);
    for (const r of rows) if (r.stale) reclaim(r, me.token);
    let a = take(dir, "slot", Math.max(max, max0), me);
    if (E.lowered) a = within(a, "slot", max);
    let b = a && browser && maxBrowsers ? take(dir, "browser", Math.max(maxBrowsers, maxB0), me) : null;
    if (b && E.loweredBrowsers) b = within(b, "browser", maxBrowsers);
    if (a && (!browser || !maxBrowsers || b)) {
      const files = [a, b].filter(Boolean);
      let done = false;
      const release = () => { if (done) return; done = true; cancel(); for (const f of files) drop(f, me.token); };
      const cancel = atExit(release);
      return { release, files };
    }
    if (a) drop(a, me.token);   // a browser launch waits holding nothing
    const busy = scanSlots(dir, known).filter((r) => !r.stale && (r.kind === "slot" || browser));
    const what = a ? `${maxBrowsers} headless browser${maxBrowsers === 1 ? "" : "s"} (WITNESS_MAX_BROWSERS)` : `${max} game/browser process${max === 1 ? "" : "es"} (WITNESS_MAX_PROCS)`;
    // a game open lowered the cap that's full: say so (and wait for it even when this command holds every slot: the game may close)
    const gamed = a ? E.loweredBrowsers : E.lowered, n = a ? maxBrowsers : max;
    const limit = gamed ? `a game is open (${E.game}), so the limit is ${n}${a ? ` headless browser${n === 1 ? "" : "s"}` : ""} (WITNESS_MAX_PROCS_GAMING)` : `the machine-wide limit is ${what}`;
    const holders = [...new Map(busy.filter((r) => (a ? r.kind === "browser" : r.kind === "slot")).map((r) => [r.owner ? r.owner.pid : r.file, r])).values()];
    if (!gamed && holders.length && holders.every((r) => r.owner && r.owner.pid === process.pid)) throw new WitnessError(`this command already holds every slot for ${what}: it can't start another until it stops one`);
    const by = holders.map((r) => who(r)).join(", ") || "other launches", el = Date.now() - t0, cap = Math.round(waitMs / 1000);
    if (el >= waitMs) throw new WitnessError(gamed
      ? `no free slot after ${Math.round(el / 1000)} s: ${limit}, held by ${by}. Close the game, wait for them to finish, or turn this off with WITNESS_MAX_PROCS_GAMING=0 (budget folder: ${dir})`
      : `no free slot after ${Math.round(el / 1000)} s: this machine is already running ${what}, held by ${by}. Wait for them to finish (or stop them: 'witness play stop --all' for playtests), or raise the limit with the environment variable (budget folder: ${dir})`);
    if (!told) {
      told = Date.now();
      // over 110 s an agent's Bash call (120 s by default) would be cut off first: say how to wait that long
      log(`▸ waiting for a free slot: ${limit}, in use by ${by} (gives up after ${cap} s${waitMs > 110000 ? `: more than an agent's Bash call waits (120 s by default), so run this command in the background (or set WITNESS_BUDGET_WAIT=<seconds> and a Bash timeout to match)` : ""})`);
    } else if (Date.now() - told >= progressMs) { told = Date.now(); log(`▸ still waiting for a free slot (${fmtAge(el)} of ${fmtAge(waitMs)}): in use by ${by}`); }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
