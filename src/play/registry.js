// Witness play: the machine-wide session registry (<tmpdir>/witness-play/<name>.json), so `witness play` commands
// find a session from any working directory, and the process cap counts every live session on the machine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REG_DIR = process.env.WITNESS_PLAY_REGISTRY || path.join(os.tmpdir(), "witness-play");
export const MAX_SESSIONS = Math.max(1, +(process.env.WITNESS_PLAY_MAX || 2));

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

const file = (name) => path.join(REG_DIR, `${name.replace(/[^\w.-]+/g, "_")}.json`);

export function readEntry(name) { try { return JSON.parse(fs.readFileSync(file(name), "utf8")); } catch { return null; } }
export function writeEntry(e) { fs.mkdirSync(REG_DIR, { recursive: true }); fs.writeFileSync(file(e.name), JSON.stringify(e, null, 1)); }
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
  fs.writeFileSync(`${shimPath(name)}.cmd`, `@echo off\r\nset s=%1\r\nfor %%c in (${sub.split("|").join(" ")}) do if "%s%"=="%%c" goto run\r\n"${node}" "${js}" play do %* -s ${name}\r\ngoto :eof\r\n:run\r\n"${node}" "${js}" play %* -s ${name}\r\n`);
  return shimPath(name);
}

/** All registry entries, with `live` = the daemon process is still running. */
export function listEntries() {
  let names = [];
  try { names = fs.readdirSync(REG_DIR).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of names) {
    try { const e = JSON.parse(fs.readFileSync(path.join(REG_DIR, f), "utf8")); e.live = pidAlive(e.pid) && e.state !== "ended" && e.state !== "failed"; out.push(e); } catch { /* skip */ }
  }
  return out.sort((a, b) => String(b.started || "").localeCompare(String(a.started || "")));
}
export const liveEntries = () => listEntries().filter((e) => e.live);
