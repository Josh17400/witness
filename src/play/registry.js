// Witness play: the machine-wide session registry (<tmpdir>/witness-play/<name>.json), so `witness play` commands
// find a session from any working directory, and the process cap counts every live session on the machine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REG_DIR = process.env.WITNESS_PLAY_REGISTRY || path.join(os.tmpdir(), "witness-play");
export const MAX_SESSIONS = Math.max(1, +(process.env.WITNESS_PLAY_MAX || 2));
// web games: each session is a headless browser (several processes and hundreds of MB), so one at a time by default
export const MAX_WEB_SESSIONS = Math.max(1, +(process.env.WITNESS_PLAY_MAX_WEB || 1));
/** A `claude -p` tester run by `play batch` (it sets this): no --force, --all, clean or batch from inside one. */
export const isTester = () => !!process.env.WITNESS_PLAY_TESTER;

/** An ISO timestamp as this machine's local "YYYY-MM-DD HH:MM" (registry times are stored in UTC). */
export const localTime = (iso) => { const d = new Date(iso); return isNaN(d) ? String(iso).slice(0, 16) : d.toLocaleString("sv").slice(0, 16); };

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
// the machine's boot (1 min slack for clock drift): anything started before it is dead whatever its PID says (Windows
// hands old PIDs to new processes after a reboot). The PID alone is never proof enough to kill: client.js asks the
// daemon's control port for its token first.
export const BOOT = Date.now() - os.uptime() * 1000 - 60000;
const sinceBoot = (iso) => { const t = Date.parse(iso || ""); return !t || t >= BOOT; };
/** An entry's daemon may still be running: not ended/failed, its PID exists, and it started since the boot. */
export const entryLive = (e) => !!e && e.state !== "ended" && e.state !== "failed" && e.state !== "dead" && pidAlive(e.pid) && sinceBoot(e.started);

/** A session name: letters, digits, - _ . (up to 40), and not all dots ("." / ".." would name a folder above it). */
export const validName = (n) => typeof n === "string" && /^[\w.-]{1,40}$/.test(n) && !/^\.+$/.test(n);

const file = (name) => path.join(REG_DIR, `${name.replace(/[^\w.-]+/g, "_")}.json`);

export function readEntry(name) { try { return JSON.parse(fs.readFileSync(file(name), "utf8")); } catch { return null; } }
/** Write JSON whole: a temp file renamed over the old one, so a reader never sees it half written (a rename refused on Windows while it is open: written in place). */
export function writeJson(f, v) {
  const t = `${f}.${process.pid}.tmp`, txt = JSON.stringify(v, null, 1);
  try { fs.writeFileSync(t, txt); fs.renameSync(t, f); } catch { try { fs.rmSync(t, { force: true }); } catch { /* gone */ } fs.writeFileSync(f, txt); }
}
export function writeEntry(e) { fs.mkdirSync(REG_DIR, { recursive: true }); writeJson(file(e.name), e); }
export function updateEntry(name, patch) { const e = readEntry(name) || { name }; Object.assign(e, patch); writeEntry(e); return e; }
export function removeEntry(name) { for (const f of [file(name), shimPath(name), `${shimPath(name)}.cmd`]) { try { fs.unlinkSync(f); } catch { /* gone */ } } }

/**
 * A tiny per-session command next to the registry, so a tester types `./t1 "fight wolf"` instead of the full
 * `node ".../witness.js" play do "fight wolf" -s t1` (output tokens are most of a model's turn time).
 * A first word that isn't a play command means `do`. Written for sh (Git Bash, macOS, Linux) and cmd.
 */
export const shimPath = (name) => path.join(REG_DIR, name.replace(/[^\w.-]+/g, "_"));
/**
 * The short command as a tester types it: the shim's absolute path (forward slashes, quoted only when it has spaces).
 * No `cd` first: Claude Code's dontAsk mode denies a cd outside the tester's working folder even when Bash(cd:*) is
 * allowed (a 0.7.1 batch tester ran `cd <registry> && ./name …` and got 0 orders).
 */
export function shimCommand(name) {
  const p = shimPath(name).replace(/\\/g, "/");
  return /[\s"'$&|;<>()]/.test(p) ? `"${p}"` : p;
}
export function writeShim(name, cliJs) {
  const node = process.execPath.replace(/\\/g, "/"), js = cliJs.replace(/\\/g, "/"), sub = "do|next|look|shot|note|end|status|stop";
  fs.mkdirSync(REG_DIR, { recursive: true });
  fs.writeFileSync(shimPath(name), `#!/bin/sh\ncase "$1" in ${sub}) ;; *) set -- do "$@" ;; esac\nexec "${node}" "${js}" play "$@" -s ${name}\n`, { mode: 0o755 });
  // cmd: %~1 drops a quoted order's quotes ("fight wolf"), so the test below stays one quoted word
  fs.writeFileSync(`${shimPath(name)}.cmd`, `@echo off\r\nset "s=%~1"\r\nfor %%c in (${sub.split("|").join(" ")}) do if /i "%s%"=="%%c" goto run\r\n"${node}" "${js}" play do %* -s ${name}\r\ngoto :eof\r\n:run\r\n"${node}" "${js}" play %* -s ${name}\r\n`);
  return shimPath(name);
}

/** All registry entries, with `live` = the daemon process may still be running (entryLive). */
export function listEntries() {
  let names = [];
  try { names = fs.readdirSync(REG_DIR).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of names) {
    try { const e = JSON.parse(fs.readFileSync(path.join(REG_DIR, f), "utf8")); e.live = entryLive(e); out.push(e); } catch { /* skip */ }
  }
  return out.sort((a, b) => String(b.started || "").localeCompare(String(a.started || "")));
}
export const liveEntries = () => listEntries().filter((e) => e.live);

/**
 * The machine-wide batch lock (<registry>/locks/batch.json: a subfolder, so registry pruning leaves it alone): one
 * `play batch` at a time, and while it's held `play start` doesn't prune old playtests (a big batch would delete its
 * own first reports). Stale-safe: the holder touches it every 30 s (beat()), so a lock not touched for 2 min is a
 * batch killed without its exit handlers (taskkill /F, SIGKILL) whatever its PID says now (Windows reuses PIDs); so is
 * one whose PID is gone or that started before the boot. acquireBatchLock() → {ok: true, release(), beat()} or {ok: false, holder}.
 */
export const batchLockPath = () => path.join(REG_DIR, "locks", "batch.json");
export const LOCK_BEAT_MS = 30000, LOCK_STALE_MS = 120000;
const lockLive = (l, mtimeMs) => !!l && pidAlive(l.pid) && sinceBoot(l.started) && Date.now() - mtimeMs < LOCK_STALE_MS;
const readLock = (f) => { try { const raw = fs.readFileSync(f, "utf8"); return { raw, l: JSON.parse(raw), mtime: fs.statSync(f).mtimeMs }; } catch { return null; } };
export function readBatchLock() { const c = readLock(batchLockPath()); return c && lockLive(c.l, c.mtime) ? c.l : null; }
/** Remove a stale batch lock (`play list --clean`); true if one was removed. */
export function clearStaleBatchLock() {
  const f = batchLockPath();
  if (!fs.existsSync(f) || readBatchLock()) return false;
  return withTakeover(f, () => { const c = readLock(f); if (c && lockLive(c.l, c.mtime)) return false; try { fs.unlinkSync(f); return true; } catch { return false; } }) === true;
}
const nap = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait */ } };
/**
 * Run fn while holding <f>.takeover (created exclusively): only one process at a time may delete a stale lock and
 * replace it, so two racers can't both take over (one deleting the other's fresh lock). A takeover file is held for
 * milliseconds: one older than 10 s is a crashed taker's. → fn's result, or undefined when another process holds it.
 */
function withTakeover(f, fn) {
  const t = `${f}.takeover`;
  try { fs.writeFileSync(t, String(process.pid), { flag: "wx" }); }
  catch (e) { if (e.code !== "EEXIST") throw e; try { if (Date.now() - fs.statSync(t).mtimeMs > 10000) fs.unlinkSync(t); } catch { /* gone */ } return undefined; }
  try { return fn(); } finally { try { fs.unlinkSync(t); } catch { /* gone */ } }
}
export function acquireBatchLock(info = {}) {
  const f = batchLockPath(), me = { pid: process.pid, started: new Date().toISOString(), ...info }, body = JSON.stringify(me);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const mine = () => { const c = readLock(f); return !!c && c.l.pid === me.pid && c.l.started === me.started; };
  const won = { ok: true, release() { try { if (mine()) fs.unlinkSync(f); } catch { /* gone */ } }, beat() { try { if (mine()) { const t = new Date(); fs.utimesSync(f, t, t); } } catch { /* gone */ } } };
  for (let i = 0; i < 40; i++) {
    try { fs.writeFileSync(f, body, { flag: "wx" }); return won; }
    catch (e) { if (e.code !== "EEXIST") throw e; }
    const cur = readLock(f);
    if (cur && lockLive(cur.l, cur.mtime)) return { ok: false, holder: cur.l };
    // stale (or half-written): replace it under the takeover lock, re-checking there that it's still the stale one
    const r = withTakeover(f, () => {
      const now = readLock(f);
      if (now && lockLive(now.l, now.mtime)) return { ok: false, holder: now.l };
      try { fs.unlinkSync(f); } catch { /* gone */ }
      try { fs.writeFileSync(f, body, { flag: "wx" }); return won; } catch { return null; }
    });
    if (r) return r;
    nap(50);   // another process is taking over: look again
  }
  return { ok: false, holder: readBatchLock() || { pid: null } };
}
