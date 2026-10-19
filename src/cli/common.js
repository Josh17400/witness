// Witness CLI: helpers shared by the commands (launching, run options, shots, logs, output).
import fs from "node:fs";
import path from "node:path";
import { findConfig, openGame, runBuild, CONFIG_NAME } from "../core/launch.js";
import { frameAt, secondsOf } from "../core/runner.js";
import { ExprError, fmt } from "../core/expr.js";
import { WitnessError } from "../core/session.js";

export const CLI = { json: false };   // with --json, human-readable extras go to stderr so stdout stays valid JSON

export const die = (msg, code = 1) => { console.error(`✖ ${msg}`); process.exit(code); };
export const say = (...a) => (CLI.json ? console.error : console.log)(...a);

/** "1,2.5,90f" -> ["1", "2.5", "90f"] (times stay strings so "90f" keeps meaning frames). */
export const timeList = (s, def) => (s === undefined || s === true ? def : String(s).split(",").map((x) => x.trim()).filter(Boolean));
export const nums = (s, def) => (s === undefined || s === true ? def : String(s).split(",").map(Number));
export const fmtT = (t) => `${+(+t).toFixed(3)}s`;
/** "f60 (1s)" */
export const fmtF = (f, fps) => `f${f} (${fmtT(f / fps)})`;
/** Frames a user time means ("1.5" seconds or "90f"); dies with a clear message on a bad value. */
export function framesOf(t, fps, dts) {
  try { return frameAt(t, fps, dts); } catch (e) { die(e.message); }
}
export function secs(t, fps) { try { return secondsOf(t, fps); } catch (e) { die(e.message); } }
/** A count of frames from a user duration ("0.5" s or "30f"), at least `min`. */
export const durFrames = (t, fps, min = 1) => Math.max(min, framesOf(t, fps));

export function loadConfig(opt) {
  if (opt.cmd) {
    // ad-hoc launch: the whole command line goes to the shell as one string
    return { cfg: { name: "game", launch: { command: String(opt.cmd), args: [], shell: true }, tests: "witness", seed: 1, timeout: +(opt.timeout || 60), shots: "witness/shots", replays: "witness/replays" }, root: process.cwd() };
  }
  const found = findConfig(opt.config ? path.resolve(opt.config) : process.cwd());
  if (!found) die(`no ${CONFIG_NAME} found here or in any parent folder — run 'witness init' (or pass --cmd "<how to start the game>")`);
  return { cfg: found.config, root: found.root, file: found.file };
}

export async function withGame(opt, fn) {
  const { cfg, root } = loadConfig(opt);
  if (opt.build) runBuild(cfg, root, { quiet: !!opt.json });
  let g;
  try {
    g = await openGame(cfg, root, { attach: !!opt.attach, port: opt.port ? +opt.port : undefined, timeout: opt.timeout ? +opt.timeout : undefined, quiet: !!opt.json });
  } catch (e) {
    die(e.message);
  }
  try {
    return await fn(g.session, cfg, root, g);
  } catch (e) {
    if (e instanceof WitnessError || e instanceof ExprError) {
      const tail = g.output().trim().split("\n").slice(-15).join("\n");
      die(`${e.message}${tail ? `\n--- last game output ---\n${tail}` : ""}`);
    }
    throw e;
  } finally {
    await g.stop();
  }
}

export function runOpts(opt, cfg) {
  let params = opt.params && opt.params !== true ? JSON.parse(opt.params) : undefined;
  // reserved params (docs/PROTOCOL.md): window size and pixel density for games that can vary them per run
  if (opt.window && opt.window !== true) {
    const m = /^(\d+)[x×,](\d+)$/.exec(String(opt.window));
    if (!m) die(`--window wants WIDTHxHEIGHT, e.g. 1920x1080 (got ${opt.window})`);
    params = { ...params, window: [+m[1], +m[2]] };
  }
  if (opt.dpi && opt.dpi !== true) params = { ...params, dpi: +opt.dpi };
  return {
    seed: opt.seed !== undefined ? +opt.seed : cfg.seed ?? 1,
    scene: opt.scene && opt.scene !== true ? String(opt.scene) : undefined,
    params,
    input: opt.input && opt.input !== true ? String(opt.input) : undefined,
  };
}

export async function media() {
  try { return await import("../media/index.js"); }
  catch (e) { die(`the media module isn't available (${e.message})`); }
}

/** A protocol screenshot reply as an RGBA image { width, height, data } (rgba8, png or a file path). */
export async function shotImage(shot) {
  if (shot.path) { const m = await media(); return m.decodePNG(fs.readFileSync(path.resolve(shot.path))); }
  const buf = Buffer.from(shot.data, "base64");
  if (shot.format === "png") { const m = await media(); return m.decodePNG(buf); }
  return { width: shot.width, height: shot.height, data: new Uint8Array(buf.buffer, buf.byteOffset, buf.length) };
}

export async function writeShot(shot, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (shot.path) { fs.copyFileSync(path.resolve(shot.path), file); return file; }
  const buf = Buffer.from(shot.data, "base64");
  if (shot.format === "png") { fs.writeFileSync(file, buf); return file; }
  const m = await media();
  fs.writeFileSync(file, m.encodePNG(shot.width, shot.height, new Uint8Array(buf.buffer, buf.byteOffset, buf.length)));
  return file;
}

export function printLogs(logs) {
  const out = CLI.json ? console.error : console.log;
  const errs = logs.filter((l) => l.level === "error"), other = logs.filter((l) => l.level !== "error");
  for (const l of errs) out(`✖ game error${l.frame != null ? ` (frame ${l.frame})` : ""}: ${l.message}`);
  if (other.length) {
    out(`— game log (${other.length > 30 ? `last 30 of ${other.length}` : other.length}) —`);
    for (const l of other.slice(-30)) out(`  ${l.frame != null ? `[f${l.frame}] ` : ""}${l.level === "warn" ? "⚠ " : ""}${l.message}`);
  }
  return errs.length;
}

export function summarizeState(snap) {
  const s = snap.state || {};
  const ents = Array.isArray(s.entities) ? s.entities : [];
  const counts = {};
  for (const e of ents) { const t = e.type ?? e.kind ?? "?"; counts[t] = (counts[t] || 0) + 1; }
  const top = Object.entries(s).filter(([k, v]) => k !== "entities" && (v === null || typeof v !== "object")).map(([k, v]) => `${k}=${fmt(v, 30)}`);
  const lines = [`— frame ${snap.frame}  t=${fmtT(snap.time ?? 0)}${ents.length ? `  [${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(", ")}]` : ""}`];
  if (top.length) lines.push(`   ${top.slice(0, 14).join("  ")}`);
  for (const e of ents.filter((e) => (counts[e.type ?? e.kind ?? "?"] || 0) <= 3).slice(0, 12)) {
    const extra = Object.entries(e).filter(([k]) => !["id", "type", "kind", "pos"].includes(k)).map(([k, v]) => `${k}=${fmt(v, 24)}`).join(" ");
    lines.push(`   #${e.id ?? "?"} ${e.type ?? e.kind ?? "?"}${e.pos ? ` pos=${fmt(e.pos.map ? e.pos.map((x) => +(+x).toFixed(2)) : e.pos, 40)}` : ""} ${extra}`);
  }
  return lines.join("\n");
}

/** Split "a, f(b, c), d" at top-level commas. */
export function splitTop(s) {
  const out = []; let depth = 0, q = null, cur = "";
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; cur += c; continue; }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * The one JSON shape new commands print with --json:
 * { ok, command, verdict, summary: {the few numbers that matter}, data: {details}, files: [] }
 */
export function envelope(command, { ok = true, verdict = "", summary = {}, data = {}, files = [] } = {}) {
  return { ok, command, verdict, summary, data, files };
}
export function printJSON(obj) {
  console.log(JSON.stringify(obj, (k, v) => (v instanceof Uint8Array || v instanceof Float32Array ? undefined : typeof v === "number" && !Number.isFinite(v) ? null : v), 1));
}

/** Compact JSON: one series sample per line ([t, v, f]), the rest indented normally. */
export function compactSeriesJSON(obj) {
  const lines = ["{"];
  const keys = Object.keys(obj);
  keys.forEach((k, i) => {
    const pts = obj[k];
    lines.push(` ${JSON.stringify(k)}: [`);
    pts.forEach((p, j) => lines.push(`  ${JSON.stringify(p)}${j < pts.length - 1 ? "," : ""}`));
    lines.push(` ]${i < keys.length - 1 ? "," : ""}`);
  });
  lines.push("}");
  return lines.join("\n");
}

export function resolveReplay(spec, cfg, root) {
  if (spec && spec !== "last" && spec !== true) {
    const f = path.resolve(String(spec));
    if (!fs.existsSync(f)) die(`no such replay: ${spec}`);
    return f;
  }
  const dir = path.resolve(root, cfg.replays);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs) : [];
  if (!files.length) die(`no replays in ${dir} — record one by playing with WITNESS_RECORD=<file.jsonl>`);
  return files[0];
}
