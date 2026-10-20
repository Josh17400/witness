// Witness CLI: window — sweep an input's timing and find where it still works (coyote time, jump buffer, parry and
// i-frame windows, combo windows). One deterministic run per value; the passing values are reported as windows.
import { begin, stepTo } from "../core/runner.js";
import { check, ExprError, fmt } from "../core/expr.js";
import { sampleExprs, frameGrid } from "../core/sample.js";
import { splitItems, parseWitnessInput } from "../core/input-spec.js";
import { WitnessError } from "../core/session.js";
import { frameAt } from "../core/runner.js";
import { withGame, runOpts, printLogs, splitTop, fmtT, envelope, emit } from "./common.js";

const fail = (msg) => { throw new WitnessError(msg); };
const framesAt = (t, fps) => { try { return frameAt(t, fps); } catch (e) { return fail(e.message); } };

const MAX_RUNS = 600;

/** "a..b" (seconds with decimals, or frames: "0.9..1.3", "50f..80f") -> ["a", "b"], or null. */
export function splitRange(s) {
  const parts = String(s).split("..").map((x) => x.trim());
  return parts.length === 2 && parts[0] && parts[1] ? parts : null;
}

/** "a..b" -> [a, b] as frames. */
function parseRange(s, fps) {
  const p = splitRange(s);
  if (!p) fail(`--t wants a range like 0.9..1.3 or 50f..80f (got ${s})`);
  return [framesAt(p[0], fps), framesAt(p[1], fps)];
}

/** "{t}+0.4" / "{t}-5f" / "2.5" -> a function of the swept frame. */
function parseAt(s, fps) {
  const str = String(s).replace(/\s+/g, "");
  const m = /^\{t\}(?:([+-])(.+))?$/.exec(str);
  if (m) { const off = m[2] ? framesAt(m[2], fps) * (m[1] === "-" ? -1 : 1) : 0; return { rel: true, off, of: (v) => v + off }; }
  if (str.includes("{t}")) fail(`--at is "{t}+offset", "{t}-offset" or a plain time (got ${s})`);
  const f = framesAt(str, fps);
  return { rel: false, off: f, of: () => f };
}

/** Contiguous runs of `true` in a list of { v, ok }: [{ from, to, frames }]. */
export function windowsOf(results) {
  const out = [];
  let cur = null;
  for (const r of results) {
    if (r.ok) { if (cur && r.v === cur.to + cur.step) cur.to = r.v; else { if (cur) out.push(cur); cur = { from: r.v, to: r.v, step: r.step }; } }
    else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.map((w) => ({ from: w.from, to: w.to, frames: (w.to - w.from) / w.step + 1 }));
}

const sgn = (n) => (n >= 0 ? `+${n}` : `${n}`);

export async function windowCommand(pos, opt) {
  const tpl = opt.input && opt.input !== true ? String(opt.input) : "";
  if (!tpl.includes("{t}")) fail('usage: witness window --input "right@0-2, space@{t}" --t 0.9..1.3 [--step 1f] --expect "expr" --at "{t}+0.4" [--ref "fell(state.player.grounded)"]');
  if (!opt.expect || opt.expect === true) fail('window needs --expect "expr" (what must be true when the input works)');
  if (!opt.t || opt.t === true) fail("window needs --t a..b (the range to sweep, seconds or frames)");
  let res;
  await withGame(opt, async (s, cfg) => {
    res = await computeWindow(s, opt, runOpts(opt, cfg));
  });
  for (const e of res.errorRuns.slice(0, 3)) { console.error(`(run t=f${e.v})`); printLogs(e.logs); }
  const out = report(res, opt);
  emit(out.env, out.text, opt, { expectable: false });
}

/** One run per swept value on an open session (ro: seed/scene/params). Returns the raw result. */
export async function computeWindow(s, opt, ro) {
  const tpl = opt.input && opt.input !== true ? String(opt.input) : "";
  if (!tpl.includes("{t}")) fail("window needs an --input with {t} in it");
  if (!opt.expect || opt.expect === true) fail("window needs --expect");
  if (!opt.t || opt.t === true) fail("window needs --t a..b");
  const expects = splitTop(String(opt.expect));
  {
    if (!s.has("reset")) fail("window needs the adapter's 'reset' (one deterministic run per value)");
    const fps = s.fps;
    const [a, b] = parseRange(opt.t, fps);
    if (b < a) fail("--t: the range ends before it starts");
    const step = Math.max(1, framesAt(opt.step && opt.step !== true ? String(opt.step) : "1f", fps));
    const at = parseAt(opt.at && opt.at !== true ? String(opt.at) : "{t}+0.5", fps);
    const values = [];
    for (let v = a; v <= b; v += step) values.push(v);
    if (values.length > MAX_RUNS) fail(`${values.length} runs is too many (max ${MAX_RUNS}): raise --step or narrow --t`);
    const inputFor = (v) => tpl.split("{t}").join(`${v}f`);
    try { parseWitnessInput(inputFor(values[0]), fps); } catch (e) { fail(`--input: ${e.message}`); }
    const t0 = Date.now();
    const results = [], errorRuns = [];
    for (const v of values) {
      const f = at.of(v);
      if (f < 0) fail(`--at gives frame ${f} for t=f${v}`);
      const st = await begin(s, { ...ro, input: inputFor(v) });
      await stepTo(s, st, f);
      const snap = await s.snapshot();
      let ok = true, detail = null;
      for (const x of expects) {
        try { const c = check(x, snap); if (!c.ok) { ok = false; detail = `${x} — ${c.detail}`; break; } }
        catch (e) { if (!(e instanceof ExprError)) throw e; ok = false; detail = e.message; break; }
      }
      // every run logs the same lines: keep only errors, once per run that had them
      const errs = (await s.drainLogs()).filter((l) => l.level === "error");
      if (errs.length) errorRuns.push({ v, logs: errs });
      results.push({ v, step, at: f, ok, detail });
    }
    const elapsed = (Date.now() - t0) / 1000;
    // the reference event, in a run without the swept input: its step (the frame before the snapshot showing it)
    let ref = null;
    if (opt.ref && opt.ref !== true) {
      const base = splitItems(tpl).filter((it) => !it.includes("{t}")).join(", ");
      const endF = Math.max(b, ...results.map((r) => r.at)) + fps;
      const st = await begin(s, { ...ro, input: base || undefined });
      const sample = await sampleExprs(s, st, [String(opt.ref)], frameGrid(0, endF, 1));
      if (sample.errors[0]) fail(`--ref: ${sample.errors[0].message}`);
      const vals = sample.values[0];
      const k = vals.findIndex((v, i) => i > 0 && !!v && !vals[i - 1]);   // the first frame it becomes true
      ref = { expr: String(opt.ref), base, seen: k < 0 ? null : sample.frames[k], step: k < 0 ? null : sample.frames[k] - 1 };
    }
    await s.drainLogs();
    return { fps, a, b, step, at, values, results, elapsed, ref, tpl, expects, errorRuns };
  }
}

function report(r, opt) {
  const { fps, results, ref } = r;
  const wins = windowsOf(results);
  const fails = results.filter((x) => !x.ok);
  const atText = r.at.rel ? `{t}${r.at.off ? sgn(r.at.off) + "f" : ""}` : `f${r.at.off}`;
  const lines = [`window: "${r.tpl}" for t = f${r.a}..f${r.b}${r.step > 1 ? ` every ${r.step}f` : ""} (${results.length} runs, ${r.elapsed.toFixed(2)}s) · expect ${r.expects.join(" && ")} at ${atText}`];
  if (!wins.length) lines.push(`  passes for no t in the range`);
  else lines.push(`  passes at t = ${wins.map((w) => (w.from === w.to ? `f${w.from}` : `f${w.from}..f${w.to}`) + ` (${w.frames} value${w.frames === 1 ? "" : "s"}, ${fmtT(w.from / fps)}–${fmtT(w.to / fps)})`).join(", ")}${fails.length ? ` · fails at ${windowsOf(results.map((x) => ({ ...x, ok: !x.ok }))).map((w) => (w.from === w.to ? `f${w.from}` : `f${w.from}..f${w.to}`)).join(", ")}` : " · never fails"}`);
  let rel = null;
  if (ref) {
    if (ref.step == null) lines.push(`  reference ${ref.expr}: never true in the run without the swept input (${ref.base || "no input"})`);
    else {
      rel = wins.map((w) => ({ from: w.from - ref.step, to: w.to - ref.step }));
      const around = wins.find((w) => w.from <= ref.step + 1 && w.to >= ref.step - 1) || null;
      let txt = `  vs ${ref.expr} (true from f${ref.seen}, so it happened in step f${ref.step}, in the run without the swept input):`;
      txt += ` passing t relative to that step: ${rel.map((q) => `${sgn(q.from)}f..${sgn(q.to)}f`).join(", ")}`;
      lines.push(txt);
      if (around) {
        const after = around.to >= ref.step ? (around.to - Math.max(ref.step, around.from)) / r.step + 1 : 0;
        const before = around.from < ref.step ? (Math.min(ref.step - r.step, around.to) - around.from) / r.step + 1 : 0;
        const bits = [];
        if (after > 0 && around.to < r.b) bits.push(`${after} value${after === 1 ? "" : "s"} at or after it (up to ${sgn(around.to - ref.step)}f: that's the grace window, e.g. coyote time)`);
        if (before > 0 && around.from > r.a) bits.push(`${before} value${before === 1 ? "" : "s"} before it (from ${sgn(around.from - ref.step)}f: an early-press window, e.g. a jump buffer)`);
        if (bits.length) lines.push(`  → ${bits.join("; ")}`);
      }
    }
  }
  const edges = [];
  for (let i = 1; i < results.length; i++) if (results[i].ok !== results[i - 1].ok) edges.push(results[i]);
  const firstFail = fails[0];
  if (firstFail) lines.push(`  ${firstFail === results[0] ? "first" : "first failing"} run (t=f${firstFail.v}): ${firstFail.detail}`);
  const wobble = wins.length > 1 ? `  ⚠ ${wins.length} separate windows: the input works, stops working, then works again` : "";
  if (wobble) lines.push(wobble);
  const env = envelope("window", {
      verdict: lines[1].trim(),
      summary: { runs: results.length, windows: wins.map((w) => [w.from, w.to]), passing: results.filter((x) => x.ok).length, first: wins[0]?.from ?? null, last: wins.length ? wins[wins.length - 1].to : null, ref: ref ? ref.step : null, relative: rel ? rel.map((q) => [q.from, q.to]) : null },
      data: { input: r.tpl, expect: r.expects, at: atText, fps, step: r.step, results: results.map(({ v, at, ok, detail }) => ({ t: v, at, ok, detail })), ref },
  });
  return { env, text: lines.join("\n") };
}
export { report as reportWindow };
