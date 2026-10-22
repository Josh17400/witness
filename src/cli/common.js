// Witness CLI: helpers shared by the commands (launching, run options, shots, logs, output).
import fs from "node:fs";
import path from "node:path";
import { findConfig, openGame, runBuild, CONFIG_NAME } from "../core/launch.js";
import { frameAt, secondsOf } from "../core/runner.js";
import { ExprError, fmt } from "../core/expr.js";
import { WitnessError } from "../core/session.js";
import { markGenerated } from "../core/clean.js";

export const CLI = { json: false };   // with --json, human-readable extras go to stderr so stdout stays valid JSON

/** A die() inside withGame: thrown up to withGame, which stops the game (graceful quit, process tree) before exiting. */
export class DieError extends Error { constructor(msg, code = 1) { super(msg); this.code = code; } }
let gameDepth = 0, pendingDie = null;
export const die = (msg, code = 1) => {
  if (gameDepth > 0) { const e = new DieError(msg, code); pendingDie = pendingDie || e; throw e; }
  console.error(`✖ ${msg}`);
  process.exit(code);
};
/** A caller that turns a die() into something else (a test's failure) takes it off the pending list. */
export const forgetDie = (e) => { if (e === pendingDie) pendingDie = null; };
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

const shq = (c) => (/[\s"'$&|;<>(){}]/.test(c) ? `"${c.replace(/"/g, '\\"')}"` : c);
/** The launch flags that were passed (" --device iphone-15 --engine webkit --safe-insets"), else "". */
export const launchFlags = (opt) => {
  if (!opt) return "";
  let f = "";
  for (const k of ["device", "engine", "capture", "color-scheme"]) if (opt[k] !== undefined && opt[k] !== true) f += ` --${k} ${shq(String(opt[k]))}`;
  for (const k of ["no-auto-unlock", "auto-unlock", "safe-insets", "safe-overlay", "reduced-motion"]) if (opt[k]) f += ` --${k}${opt[k] !== true ? ` ${shq(String(opt[k]))}` : ""}`;
  return f;
};
/** " --config <what was passed>" plus the launch flags that were passed, for follow-up commands printed to the user
 *  (they must load the same config and launch the same device and engine), else "". */
export const configFlag = (opt) => {
  if (!opt) return "";
  const c = opt.config && opt.config !== true ? ` --config ${shq(String(opt.config))}` : "";
  return c + launchFlags(opt);
};

export function loadConfig(opt) {
  if (opt.cmd) {
    // ad-hoc launch: the whole command line goes to the shell as one string
    return { cfg: { name: "game", launch: { command: String(opt.cmd), args: [], shell: true }, tests: "witness", seed: 1, timeout: +(opt.timeout || 60), shots: "witness/shots", replays: "witness/replays" }, root: process.cwd() };
  }
  if (opt.config === true) die(`--config needs a folder or a file (--config web/witness.web.json)`);
  if (opt.config && !fs.existsSync(path.resolve(String(opt.config)))) die(`--config ${opt.config}: no such ${/\.json$/i.test(String(opt.config)) ? "file" : "folder"}`);
  const found = findConfig(opt.config ? path.resolve(String(opt.config)) : process.cwd());
  if (!found) die(`no ${CONFIG_NAME} found here or in any parent folder — run 'witness init' (or pass --cmd "<how to start the game>")`);
  return { cfg: browserOverrides(found.config, opt), root: found.root, file: found.file };
}

/** --device / --engine / --no-auto-unlock / --capture / --safe-insets / --safe-overlay: browser launch options from the command line (they win over
 *  witness.json launch.device / engine / audioUnlock / capture). */
export function browserOverrides(cfg, opt) {
  const want = { device: opt.device, engine: opt.engine, capture: opt.capture };
  const any = Object.values(want).some((v) => v !== undefined) || opt["no-auto-unlock"] || opt["auto-unlock"] || opt["safe-insets"] || opt["safe-overlay"] || opt["reduced-motion"] || opt["color-scheme"] !== undefined;
  if (!any) return cfg;
  for (const [k, v] of Object.entries(want)) if (v === true) die(`--${k} needs a value (e.g. --device iphone-15, --engine webkit, --capture element)`);
  if (!cfg.launch || !cfg.launch.url) die(`--device, --engine, --capture, --no-auto-unlock, --safe-insets, --safe-overlay, --reduced-motion and --color-scheme are for browser games (${CONFIG_NAME} launch.url); this launch is ${cfg.launch && cfg.launch.attach ? "attach" : "a command"}`);
  const launch = { ...cfg.launch };
  if (want.device !== undefined) {
    const d = String(want.device);
    if (d.trim().startsWith("{")) { try { launch.device = JSON.parse(d); } catch (e) { die(`--device: bad JSON (${e.message})`); } }
    else launch.device = d === "none" || d === "desktop" ? null : d;
  }
  if (want.engine !== undefined) launch.engine = String(want.engine);
  if (want.capture !== undefined) launch.capture = String(want.capture);
  if (opt["no-auto-unlock"]) launch.audioUnlock = false;
  else if (opt["auto-unlock"]) launch.audioUnlock = true;
  if (opt["safe-insets"]) launch.safeInsets = opt["safe-insets"] === true ? true : String(opt["safe-insets"]);
  if (opt["safe-overlay"]) launch.safeOverlay = true;
  // --reduced-motion / --color-scheme dark|light: launch.media (prefers-reduced-motion, prefers-color-scheme)
  if (opt["color-scheme"] === true) die("--color-scheme needs a value: dark or light");
  if (opt["reduced-motion"] || opt["color-scheme"] !== undefined) launch.media = { ...(launch.media || {}), ...(opt["reduced-motion"] ? { reducedMotion: "reduce" } : {}), ...(opt["color-scheme"] !== undefined ? { colorScheme: String(opt["color-scheme"]) } : {}) };
  return { ...cfg, launch };
}

export async function withGame(opt, fn) {
  const { cfg, root } = loadConfig(opt);
  if (opt.build) runBuild(cfg, root, { quiet: !!opt.json });
  let g;
  try {
    g = await openGame(cfg, root, { attach: !!opt.attach, port: opt.port ? +opt.port : undefined, timeout: opt.timeout ? +opt.timeout : undefined, quiet: !!opt.json, env: opt.__env });
  } catch (e) {
    die(e.message);
  }
  // die() inside fn throws a DieError up to here (process.exit would skip the stop and leak the game); one that
  // something caught and swallowed still ends the command once fn returns
  gameDepth++;
  let result, failure = null;
  try {
    result = await fn(g.session, cfg, root, g);
  } catch (e) {
    if (e instanceof WitnessError || e instanceof ExprError) {
      const tail = g.output().trim().split("\n").slice(-15).join("\n");
      failure = new DieError(`${e.message}${tail ? `\n--- last game output ---\n${tail}` : ""}`);
    } else failure = e;
  } finally {
    gameDepth--;
  }
  if (!failure && pendingDie) failure = pendingDie;
  try { await g.stop(); } catch { /* best effort: the exit hook kills what's left */ }
  if (failure) {
    if (!(failure instanceof DieError) || gameDepth > 0) throw failure;
    pendingDie = null;
    die(failure.message, failure.code);
  }
  return result;
}

/**
 * Commands that place game-pixel coordinates (crops, follows, entity boxes, state.ui rects, positions) on a
 * screenshot: refuse when --capture element|screen made the screenshots device-pixel pictures of the page.
 */
export function gamePixels(s, what, opt = null) {
  const mode = s && s.web && s.web.captureMode;
  if (mode && mode !== "canvas") die(`${what} works in game pixels, but --capture ${mode} makes screenshots of the page at device pixels (DPR ${s.web.device ? s.web.device.dpr : 1}, a different size and origin): run it without --capture (launch.capture "canvas", the game's own pixels), or use the device-pixel PNG from witness shot --capture ${mode}${configFlag({ ...opt, capture: undefined })} with measure scale`);
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
  // reserved: "camera": "hold" asks the game to keep its camera still this run (pixel registration, foot slide)
  if (opt["hold-camera"]) params = { ...params, camera: "hold" };
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
 * Record files a command wrote in their project's shots-folder manifest (src/core/clean.js), so the files it names
 * itself (trace --out jump.png, <shot>-protan.png beside a test shot, lvl1/a.png) are pruned like shot.png; a file
 * outside a shots folder is left alone. shotsDir: the folder when known, else found from each file's witness.json.
 */
export function markOutputs(files, shotsDir = null) {
  const dirs = new Map();
  for (const f0 of [].concat(files || [])) {
    const f = typeof f0 === "string" ? f0 : f0 && (f0.file || f0.path);
    if (!f) continue;
    let d = shotsDir;
    if (!d) {
      const at = path.dirname(path.resolve(f));
      if (!dirs.has(at)) { let s = null; try { const c = findConfig(at); if (c) s = path.resolve(c.root, c.config.shots); } catch { /* no project */ } dirs.set(at, s); }
      d = dirs.get(at);
    }
    if (d) markGenerated(d, f);
  }
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

/**
 * Check an --expect over a command's result: an expression over the envelope's summary fields (also `summary`,
 * `data`, `verdict`). Sugar: "airtimeFrames between 36 and 44", and frame counts written "36f" mean 36.
 * Returns { expr, ok, detail }.
 */
export function checkExpect(src, env) {
  const expr = String(src).trim();
  const frames = (s) => s.replace(/(^|[^\w.$"'])(\d+(?:\.\d+)?)f\b/g, "$1$2");
  const scope = { ...(env.data && typeof env.data === "object" ? env.data : {}), ...(env.summary || {}), summary: env.summary, data: env.data, verdict: env.verdict };
  const names = Object.keys(env.summary || {});
  const run = (code) => {
    try {
      // eslint-disable-next-line no-new-func
      return { v: new Function("S", `with (S) { return (${code}\n); }`)(scope) };
    } catch (e) {
      const m = /^(\w+) is not defined/.exec(e.message);
      return { err: m ? `"${m[1]}" is not in this result (fields: ${names.join(", ")})` : e.message };
    }
  };
  const b = /^(.+?)\s+between\s+(.+?)\s+and\s+(.+)$/i.exec(expr);
  if (b) {
    const L = run(frames(b[1])), A = run(frames(b[2])), B = run(frames(b[3]));
    const err = L.err || A.err || B.err;
    if (err) return { expr, ok: false, detail: err };
    const ok = typeof L.v === "number" && L.v >= A.v && L.v <= B.v;
    return { expr, ok, detail: `got ${fmtV(L.v)} (want ${fmtV(A.v)}..${fmtV(B.v)})` };
  }
  const code = frames(expr);
  const all = run(code);
  if (all.err) return { expr, ok: false, detail: all.err };
  const ok = !!all.v;
  const cmp = /^(.+?)\s*(===|!==|==|!=|<=|>=|<|>)\s*(.+)$/.exec(code);
  if (cmp && !/&&|\|\|/.test(code)) { const l = run(cmp[1]), r = run(cmp[3]); if (!l.err && !r.err) return { expr, ok, detail: `got ${fmtV(l.v)} ${cmp[2]} ${fmtV(r.v)}` }; }
  return { expr, ok, detail: `got ${fmtV(all.v)}` };
}
const fmtV = (v) => fmt(v, 60);

/**
 * Print a command's result: the text, or with --json the envelope. --expect (unless the command uses it for
 * something else) is checked against the result: a failure is printed and the exit code becomes 1.
 * env.ok === false also sets exit code 1.
 */
export function emit(env, text, opt, { expectable = true, json = null } = {}) {
  markOutputs(env.files);
  let exp = null;
  if (expectable && opt.expect && opt.expect !== true) {
    exp = checkExpect(String(opt.expect), env);
    env.expect = exp;
    if (!exp.ok) env.ok = false;
  }
  if (opt.json) (json || printJSON)(env);
  else {
    if (text) console.log(text);
    if (exp) console.log(`${exp.ok ? "✔" : "✖"} expect ${exp.expr}: ${exp.detail}`);
  }
  if (env.ok === false) process.exitCode = 1;
}
