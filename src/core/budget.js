// Witness core: a machine-wide budget of heavy processes, so parallel agents, test runs and playtests can't pile up
// games and headless browsers (a PC once crashed from ~100 headless browsers). Every launch (a game command or a
// browser page; not --attach) takes a slot first and gives it back when the game stops or the CLI exits.
//   <tmpdir>/witness-budget/ (beside the play registry; WITNESS_BUDGET_DIR moves it)
//   slot-<i>.json      any launch, i < WITNESS_MAX_PROCS (default 3; 0 = no limit)
//   browser-<i>.json   headless browsers also take one of these, i < WITNESS_MAX_BROWSERS (default 1)
// A slot file names its owner by pid AND the OS's start time for that pid, so a crashed owner's slot is taken back
// and a pid the OS gave to another process doesn't keep holding it. A launch waits for a free slot (saying so once),
// then fails after WITNESS_BUDGET_WAIT seconds (default 90: under the 120 s an agent's Bash tool waits for a command).
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
export const budgetLimits = () => ({ max: envInt("WITNESS_MAX_PROCS", 3), maxBrowsers: envInt("WITNESS_MAX_BROWSERS", 1), waitMs: envInt("WITNESS_BUDGET_WAIT", 90) * 1000 });

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
    try { fs.writeFileSync(file, JSON.stringify({ ...me, kind }), { flag: "wx" }); return file; } catch (e) { if (e.code !== "EEXIST") throw e; }
  }
  return null;
}
function drop(file, token) { const o = readSlot(file); if (o && o.token === token) { try { fs.unlinkSync(file); } catch { /* gone */ } } }

const who = (o) => (o ? `pid ${o.pid}${o.label ? ` (${o.label})` : ""}` : "a launch starting");

/**
 * Take a heavy-process slot (and a browser slot when `browser`). Waits while the machine is at its limit, then throws.
 * Returns { release() } (also released when the process exits). opts override the environment (tests).
 */
export async function acquireSlot({ browser = false, label = "", log = (m) => console.error(m), dir = budgetDir(), max, maxBrowsers, waitMs, pollMs = 1000 } = {}) {
  const L = budgetLimits();
  max = max ?? L.max; maxBrowsers = maxBrowsers ?? L.maxBrowsers; waitMs = waitMs ?? L.waitMs;
  if (!max) return { release() {}, files: [] };
  fs.mkdirSync(dir, { recursive: true });
  const me = { pid: process.pid, key: myKey(), token: crypto.randomBytes(8).toString("hex"), at: new Date().toISOString(), browser, label: String(label).slice(0, 160) };
  const known = new Map(), t0 = Date.now();
  let told = false;
  for (;;) {
    const rows = scanSlots(dir, known);
    for (const r of rows) if (r.stale) reclaim(r, me.token);
    const a = take(dir, "slot", max, me);
    const b = a && browser && maxBrowsers ? take(dir, "browser", maxBrowsers, me) : null;
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
    const holders = [...new Map(busy.filter((r) => (a ? r.kind === "browser" : r.kind === "slot")).map((r) => [r.owner ? r.owner.pid : r.file, r.owner])).values()];
    if (holders.length && holders.every((o) => o && o.pid === process.pid)) throw new WitnessError(`this command already holds every slot for ${what}: it can't start another until it stops one`);
    if (Date.now() - t0 >= waitMs) throw new WitnessError(`no free slot after ${Math.round((Date.now() - t0) / 1000)} s: this machine is already running ${what}, held by ${holders.map(who).join(", ") || "other launches"}. Wait for them to finish (or stop them: 'witness play stop --all' for playtests), or raise the limit with the environment variable (budget folder: ${dir})`);
    if (!told) { told = true; log(`▸ waiting for a free slot: the machine-wide limit is ${what}, in use by ${holders.map(who).join(", ") || "other launches"} (gives up after ${Math.round(waitMs / 1000)} s)`); }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
