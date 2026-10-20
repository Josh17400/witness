// Witness core: keep generated files from piling up. Playtests, human recordings and screenshots are useful while a
// bug is being looked at and dead weight after, so old ones are pruned automatically (on `play start` and `test`),
// and `witness clean` / `witness play clean` remove them on demand.
// Limits come from witness.json "retention" (any part may be left out):
//   { "playtests": { "keep": 5, "days": 7, "hours": 24 }, "replays": { "keep": 10, "days": 14 }, "shots": { "days": 3 }, "movies": { "days": 3 } }
// Only what Witness itself wrote is ever removed: in the shots folder the files it names by default (shot.png,
// sheet.png, trace-xy.png, mismatch-*.png, ...) and those listed in its manifest (.witness-generated: test step
// shots, in subfolders too, --out files and measure pictures there); in the replays folder *.jsonl recordings and their .state.json. Anything else (a
// picture you put there) stays, and witness/refs (named baselines: shot --save-ref) is never touched. witness/movies
// (Godot --write-movie output): its .avi/.png/.wav files go, the folder and its .gdignore stay. A shots or
// replays folder outside the project, the project folder itself, or the Witness install (its top level and code; a
// project inside it, such as an example, is fine) is refused, not pruned.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REG_DIR, listEntries, removeEntry } from "../play/registry.js";

const WITNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WITNESS_CODE = ["src", "bin", "adapters", "docs", "skills", "agents", "hooks", "commands", ".claude-plugin", "node_modules"];
export const REFS_DIR = "witness/refs";
export const MANIFEST = ".witness-generated";
/** Names Witness gives its outputs in the shots folder (top level): shot-2_5.png, trace-xy.png, ab/, listen/, x-diff.png ... */
export const GENERATED = /^(shot|sheet|clip|trace|effect|heatmap|mismatch|replay|figure|ui|colorblind|palette|ab|listen)([-_.]|$)|-diff\.png$/i;

// playtests.hours: a playtest written within that many hours always stays (a judge may still cite its report), only
// --all or `play clean <name>` removes it
export const RETENTION = { playtests: { keep: 5, days: 7, hours: 24 }, replays: { keep: 10, days: 14 }, shots: { days: 3 }, movies: { days: 3 } };
export const MOVIES_DIR = "witness/movies";
const MOVIE = /\.(avi|png|wav)$/i;

function sizeOf(p) {
  let st; try { st = fs.statSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let n = 0; for (const e of fs.readdirSync(p)) n += sizeOf(path.join(p, e));
  return n;
}
function remove(p, out) { const n = sizeOf(p); try { if (!out.dry) fs.rmSync(p, { recursive: true, force: true }); out.removed.push(p); out.bytes += n; } catch { /* in use */ } }
// a playtest's age: its folder or report, whichever changed last
const playtestAgeDays = (p) => Math.min(ageDays(p), ...["report.md", "report.json"].map((f) => (fs.existsSync(path.join(p, f)) ? ageDays(path.join(p, f)) : Infinity)));
const ageDays = (p) => { try { return (Date.now() - fs.statSync(p).mtimeMs) / 864e5; } catch { return 0; } };
const entries = (dir) => { try { return fs.readdirSync(dir).map((n) => path.join(dir, n)); } catch { return []; } };
const limits = (cfg) => {
  const r = (cfg && cfg.retention) || {};
  return Object.fromEntries(Object.keys(RETENTION).map((k) => [k, { ...RETENTION[k], ...(r[k] || {}) }]));
};
/** Newest-first; the first `keep` survive unless older than `days`; everything past `keep` goes. A kept path counts toward `keep` but stays. */
function pruneList(paths, { keep, days }, out, skip = () => false, kept = () => false) {
  const sorted = paths.filter((p) => !skip(p)).sort((a, b) => ageDays(a) - ageDays(b));
  sorted.forEach((p, i) => { if (!kept(p) && (i >= keep || ageDays(p) > days)) remove(p, out); });
}

/** A playtest folder whose daemon is still running must never be touched. */
function liveDirs() {
  return new Set(listEntries().filter((e) => e.live && e.dir).map((e) => path.resolve(e.dir)));
}

const inside = (dir, parent) => { const r = path.relative(parent, dir); return !!r && !r.startsWith("..") && !path.isAbsolute(r); };
/**
 * Why a configured output folder must not be pruned (null when it may): it has to be a folder inside the project, not
 * the project itself, and neither the Witness install nor a folder holding it.
 */
export function unsafeDir(dir, root) {
  const d = path.resolve(dir), r = path.resolve(root);
  if (d === r) return "is the project folder itself";
  if (!inside(d, r)) return "is outside the project";
  // the install, a folder holding it, one of its top-level folders (examples/, tests/) or anything in its code; a project
  // of its own inside it (examples/js-node, a test fixture) keeps its witness/shots prunable
  if (d === WITNESS_ROOT || inside(WITNESS_ROOT, d) || path.dirname(d) === WITNESS_ROOT || WITNESS_CODE.some((c) => inside(d, path.join(WITNESS_ROOT, c)))) return "is (or holds) the Witness install";
  if (d === path.resolve(r, REFS_DIR) || inside(d, path.resolve(r, REFS_DIR))) return "is (or is inside) the named-baseline folder witness/refs";
  return null;
}

/**
 * Record a file Witness wrote with a name of its own choosing (a test step's shot, an --out, a measure picture) in
 * dir's manifest, so pruning knows it is generated. A file in a subfolder is recorded by its relative path
 * (lvl1/a.png), unless the top folder already has a generated name (ab/, listen/). Files outside dir: ignored.
 */
export function markGenerated(dir, file) {
  try {
    const d = path.resolve(dir), f = path.resolve(file);
    if (!inside(f, d)) return;
    const m = path.join(d, MANIFEST), name = path.relative(d, f).split(path.sep).join("/"), top = name.split("/")[0];
    if (GENERATED.test(top) || top === MANIFEST) return;
    const have = fs.existsSync(m) ? fs.readFileSync(m, "utf8").split(/\r?\n/) : [];
    if (!have.includes(name)) fs.appendFileSync(m, `${name}\n`);
  } catch { /* best effort */ }
}
const manifest = (dir) => { try { return new Set(fs.readFileSync(path.join(dir, MANIFEST), "utf8").split(/\r?\n/).filter(Boolean)); } catch { return new Set(); } };

/**
 * Prune generated files under a project root. opts: {all} removes everything generated (playtests, replays, shots,
 * movies), {only: "playtests"|"replays"|"shots"|"movies"} limits it to one kind, {keep: [playtest folders]} are never
 * removed but count toward "keep" (a batch's own reports), {dryRun} only lists what would go. Returns {removed: [paths], bytes, warnings: [why a folder was skipped]}.
 */
export function prune(cfg, root, { all = false, only = null, keep = [], dryRun = false } = {}) {
  const out = { removed: [], bytes: 0, warnings: [], dry: dryRun }, L = limits(cfg), live = liveDirs(), kept = new Set(keep.map((p) => path.resolve(p)));
  const isLive = (p) => live.has(path.resolve(p)), isKept = (p) => kept.has(path.resolve(p));
  const want = (k) => !only || only === k;
  const guarded = (key, def) => {
    const dir = path.resolve(root, (cfg && cfg[key]) || def), why = unsafeDir(dir, root);
    if (why) { out.warnings.push(`not pruning witness.json "${key}": ${dir} ${why}`); return null; }
    return dir;
  };
  if (want("playtests")) {
    const dirs = entries(path.join(root, "witness", "playtests")).filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
    if (all) dirs.filter((p) => !isLive(p) && !isKept(p)).forEach((p) => remove(p, out)); else pruneList(dirs, L.playtests, out, isLive, (p) => isKept(p) || playtestAgeDays(p) * 24 < L.playtests.hours);
  }
  const dir = want("replays") ? guarded("replays", "witness/replays") : null;
  if (dir) {
    // a recording and its .state.json go together
    const recs = entries(dir).filter((p) => p.endsWith(".jsonl"));
    const before = new Set(out.removed);
    if (all) recs.forEach((p) => remove(p, out)); else pruneList(recs, L.replays, out);
    for (const p of out.removed) if (!before.has(p) && p.endsWith(".jsonl")) remove(`${p}.state.json`, out);
    // an end state whose recording is gone
    if (all) entries(dir).filter((p) => p.endsWith(".jsonl.state.json") && !fs.existsSync(p.slice(0, -11))).forEach((p) => remove(p, out));
  }
  const shots = want("shots") ? guarded("shots", "witness/shots") : null;
  if (shots) {
    const listed = manifest(shots), refs = path.resolve(root, REFS_DIR);
    for (const p of entries(shots)) {
      const name = path.basename(p);
      if (name === MANIFEST || path.resolve(p) === refs || !(GENERATED.test(name) || listed.has(name))) continue;
      if (all || ageDays(p) > L.shots.days) remove(p, out);
    }
    // files Witness wrote in subfolders (a test step's "shot": "lvl1/a.png"): the file, then its folder once empty
    for (const n of listed) {
      if (!n.includes("/")) continue;
      const p = path.join(shots, ...n.split("/"));
      if (!inside(p, shots) || path.resolve(p) === refs || inside(p, refs) || !fs.existsSync(p)) continue;
      if (!(all || ageDays(p) > L.shots.days)) continue;
      remove(p, out);
      if (!out.dry) for (let d = path.dirname(p); inside(d, shots); d = path.dirname(d)) { try { fs.rmdirSync(d); } catch { break; } }
    }
    // the manifest keeps only names still there
    if (listed.size && !out.dry) {
      const keep = [...listed].filter((n) => fs.existsSync(path.join(shots, n)));
      try { if (keep.length) fs.writeFileSync(path.join(shots, MANIFEST), keep.map((n) => `${n}\n`).join("")); else fs.rmSync(path.join(shots, MANIFEST), { force: true }); } catch { /* busy */ }
    }
  }
  const movies = want("movies") ? path.resolve(root, MOVIES_DIR) : null;
  if (movies && !unsafeDir(movies, root)) for (const p of entries(movies)) if (MOVIE.test(p) && (all || ageDays(p) > L.movies.days)) remove(p, out);
  out.removed = out.removed.filter((p) => !p.endsWith(".state.json") || !out.removed.includes(p.slice(0, -11)));
  delete out.dry;
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
  // stray short commands without an entry (files only: locks/ holds the batch lock)
  for (const p of entries(REG_DIR)) {
    if (/\.json$/.test(p) || fs.existsSync(`${p.replace(/\.cmd$/, "")}.json`)) continue;
    try { if (fs.statSync(p).isFile()) { fs.unlinkSync(p); n++; } } catch { /* in use */ }
  }
  return n;
}

export const fmtBytes = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
