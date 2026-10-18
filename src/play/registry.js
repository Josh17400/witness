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
export function removeEntry(name) { try { fs.unlinkSync(file(name)); } catch { /* gone */ } }

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
