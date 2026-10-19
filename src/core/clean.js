// Witness core: keep generated files from piling up. Playtests, human recordings and screenshots are useful while a
// bug is being looked at and dead weight after, so old ones are pruned automatically (on `play start` and `test`),
// and `witness clean` / `witness play clean` remove them on demand.
// Limits come from witness.json "retention" (any part may be left out):
//   { "playtests": { "keep": 5, "days": 7 }, "replays": { "keep": 10, "days": 14 }, "shots": { "days": 3 } }
import fs from "node:fs";
import path from "node:path";
import { REG_DIR, listEntries, removeEntry } from "../play/registry.js";

export const RETENTION = { playtests: { keep: 5, days: 7 }, replays: { keep: 10, days: 14 }, shots: { days: 3 } };

function sizeOf(p) {
  let st; try { st = fs.statSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let n = 0; for (const e of fs.readdirSync(p)) n += sizeOf(path.join(p, e));
  return n;
}
function remove(p, out) { const n = sizeOf(p); try { fs.rmSync(p, { recursive: true, force: true }); out.removed.push(p); out.bytes += n; } catch { /* in use */ } }
const ageDays = (p) => { try { return (Date.now() - fs.statSync(p).mtimeMs) / 864e5; } catch { return 0; } };
const entries = (dir) => { try { return fs.readdirSync(dir).map((n) => path.join(dir, n)); } catch { return []; } };
const limits = (cfg) => {
  const r = (cfg && cfg.retention) || {};
  return { playtests: { ...RETENTION.playtests, ...(r.playtests || {}) }, replays: { ...RETENTION.replays, ...(r.replays || {}) }, shots: { ...RETENTION.shots, ...(r.shots || {}) } };
};
/** Newest-first; the first `keep` survive unless older than `days`; everything past `keep` goes. */
function pruneList(paths, { keep, days }, out, skip = () => false) {
  const sorted = paths.filter((p) => !skip(p)).sort((a, b) => ageDays(a) - ageDays(b));
  sorted.forEach((p, i) => { if (i >= keep || ageDays(p) > days) remove(p, out); });
}

/** A playtest folder whose daemon is still running must never be touched. */
function liveDirs() {
  return new Set(listEntries().filter((e) => e.live && e.dir).map((e) => path.resolve(e.dir)));
}

/**
 * Prune generated files under a project root. opts: {all} removes everything generated (playtests, replays, shots),
 * {only: "playtests"|"replays"|"shots"} limits it to one kind. Returns {removed: [paths], bytes}.
 */
export function prune(cfg, root, { all = false, only = null } = {}) {
  const out = { removed: [], bytes: 0 }, L = limits(cfg), live = liveDirs();
  const isLive = (p) => live.has(path.resolve(p));
  const want = (k) => !only || only === k;
  if (want("playtests")) {
    const dirs = entries(path.join(root, "witness", "playtests")).filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
    if (all) dirs.filter((p) => !isLive(p)).forEach((p) => remove(p, out)); else pruneList(dirs, L.playtests, out, isLive);
  }
  if (want("replays")) {
    // a recording and its .state.json go together
    const dir = path.resolve(root, (cfg && cfg.replays) || "witness/replays");
    const recs = entries(dir).filter((p) => p.endsWith(".jsonl"));
    const before = new Set(out.removed);
    if (all) recs.forEach((p) => remove(p, out)); else pruneList(recs, L.replays, out);
    for (const p of out.removed) if (!before.has(p) && p.endsWith(".jsonl")) remove(`${p}.state.json`, out);
    if (all) entries(dir).forEach((p) => remove(p, out));
  }
  if (want("shots")) {
    const dir = path.resolve(root, (cfg && cfg.shots) || "witness/shots");
    for (const p of entries(dir)) if (all || ageDays(p) > L.shots.days) remove(p, out);
  }
  out.removed = out.removed.filter((p) => !p.endsWith(".state.json") || !out.removed.includes(p.slice(0, -11)));
  return out;
}

/** Ended sessions in the machine-wide registry (and their short commands) older than a day, or whose folder is gone. */
export function pruneRegistry() {
  let n = 0;
  for (const e of listEntries()) {
    if (e.live) continue;
    const old = Date.now() - Date.parse(e.endedAt || e.started || 0) > 864e5;
    if (old || (e.dir && !fs.existsSync(e.dir))) { removeEntry(e.name); n++; }
  }
  // stray short commands without an entry
  for (const p of entries(REG_DIR)) if (!/\.json$/.test(p) && !fs.existsSync(`${p.replace(/\.cmd$/, "")}.json`)) { try { fs.unlinkSync(p); n++; } catch { /* in use */ } }
  return n;
}

export const fmtBytes = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
