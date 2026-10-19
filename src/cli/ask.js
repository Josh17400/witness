// Witness CLI: ask the game's state — eval (at times, --when, --diff, --keys) and trace (values over time + chart).
import fs from "node:fs";
import path from "node:path";
import { begin, stepTo, loadReplay } from "../core/runner.js";
import { evaluate, fmt, usesPrev } from "../core/expr.js";
import { diffStates } from "../core/compare.js";
import { describeState } from "../core/schema.js";
import { sampleExprs, frameGrid } from "../core/sample.js";
import { summarize, changes, spans, steps as perFrame } from "../core/signal.js";
import { parseWitnessInput } from "../core/input-spec.js";
import {
  CLI, die, say, withGame, runOpts, media, printLogs, summarizeState, splitTop, timeList, framesOf, fmtT, fmtF,
  envelope, printJSON, compactSeriesJSON, resolveReplay,
} from "./common.js";

// ------------------------------------------------------------------ helpers shared with listen/measure

/** Named state events "land: rose(state.player.grounded), hurt: fell(state.player.hp)" -> [{ name, expr }]. */
export function parseNamedEvents(spec) {
  if (!spec || spec === true) return [];
  return splitTop(String(spec)).map((item, i) => {
    const m = /^([A-Za-z_][\w -]*?)\s*:\s*(.+)$/.exec(item);
    return m && !/^(state|prev|first|all|count|near)$/.test(m[1]) ? { name: m[1].trim(), expr: m[2].trim() } : { name: `event ${i + 1}`, expr: item };
  });
}

/** Frames where each named event's expression becomes true (rising edges, from per-frame samples). */
export function eventFrames(named, sample) {
  const out = [];
  named.forEach((ev, i) => {
    let before = null;
    sample.values[i].forEach((v, k) => {
      const now = !!v;
      // rose()/fell()/changed() already describe an edge: every true sample is an event
      const edgeExpr = /^(rose|fell|changed)\s*\(/.test(ev.expr);
      if (edgeExpr ? now : now && before === false) out.push({ name: ev.name, f: sample.frames[k], t: sample.times[k] });
      before = now;
    });
  });
  return out.sort((a, b) => a.f - b.f);
}

/** Held inputs from a --input spec as spans for charts and reports: [{ label, f0, f1 }] (frames). */
export function inputSpans(spec, fps) {
  if (!spec) return [];
  let evs;
  try { evs = parseWitnessInput(spec, fps); } catch { return []; }
  const open = new Map(), out = [];
  const keyOf = (e) => (e.type === "key" ? e.key : e.type === "action" ? `action:${e.action}` : e.type === "pad" ? `pad:${e.button}` : e.type === "mouse" && e.down !== undefined ? (e.button === 2 ? "rclick" : "click") : e.type === "touch" ? `touch${e.id ? e.id + 1 : ""}` : null);
  for (const e of evs) {
    const k = keyOf(e);
    if (!k) continue;
    const down = e.type === "touch" ? e.phase === "down" : e.down === true;
    const up = e.type === "touch" ? e.phase === "up" || e.phase === "cancel" : e.down === false;
    if (down && !open.has(k)) open.set(k, e.frame);
    else if (up && open.has(k)) { out.push({ label: k, f0: open.get(k), f1: e.frame }); open.delete(k); }
  }
  for (const [k, f0] of open) out.push({ label: k, f0, f1: null });
  return out.sort((a, b) => a.f0 - b.f0);
}

/** Key-down (press) events from a --input spec: [{ label, f }]. */
export const inputPresses = (spec, fps) => inputSpans(spec, fps).map((s) => ({ label: s.label, f: s.f0 }));

const fmtV = (v) => fmt(v, 60);
const tr = (x) => +(+x).toFixed(3);

/** Text lines summarizing one sampled series (numbers, vectors per axis, or values that change). */
export function seriesLines(label, frames, vals, fps) {
  const pts = frames.map((f, i) => ({ f, v: vals[i] }));
  const present = pts.filter((p) => p.v != null);
  if (!present.length) return [`  ${label}: no data`];
  const sample = present[0].v;
  const numLine = (name, p) => {
    const s = summarize(p);
    if (!s) return `  ${name}: no numbers`;
    if (s.constant) return `  ${name}: ${fmtV(s.start.v)} (constant over f${s.start.f}..f${s.end.f})`;
    const st = s.step ? ` · per frame ${tr(s.step.min.d)}..${tr(s.step.max.d)} (${tr(s.step.min.d * fps)}..${tr(s.step.max.d * fps)}/s)` : "";
    return `  ${name}: ${fmtV(s.start.v)} → ${fmtV(s.end.v)} · min ${fmtV(s.min.v)} @f${s.min.f} · max ${fmtV(s.max.v)} @f${s.max.f}${st}`;
  };
  if (typeof sample === "number" && present.every((p) => typeof p.v === "number")) return [numLine(label, pts)];
  if (Array.isArray(sample) && sample.length && sample.length <= 4 && sample.every((x) => typeof x === "number") && present.every((p) => Array.isArray(p.v))) {
    return ["x", "y", "z", "w"].slice(0, sample.length).map((ax, k) => numLine(`${label}.${ax}`, pts.map((p) => ({ f: p.f, v: p.v == null ? null : p.v[k] }))));
  }
  const ch = changes(present);
  const head = `  ${label}: ${fmtV(present[0].v)}${ch.length ? ` → ${fmtV(present[present.length - 1].v)} · ${ch.length} change${ch.length === 1 ? "" : "s"}` : " (constant)"}`;
  return [head, ...ch.slice(0, 10).map((c) => `     f${c.f} (${fmtT(c.f / fps)}): ${fmtV(c.from)} → ${fmtV(c.to)}`), ...(ch.length > 10 ? [`     … ${ch.length - 10} more (--json)`] : [])];
}

/** Report expression errors once per expression (B1): "✖ expr: message (all 121 samples / from f30, 12 of 121)". */
export function errorLines(exprs, sample) {
  const out = [];
  exprs.forEach((x, i) => {
    const e = sample.errors[i], n = sample.frames.length;
    if (e) out.push(`✖ ${x}: ${e.message.replace(/^"[^"]*": /, "")} (${e.count === n ? `all ${n} samples` : `${e.count} of ${n} samples, first at f${e.f}`})`);
    else if (sample.missing[i] === n) out.push(`✖ ${x}: undefined on every sample (no such field? check the path with 'witness eval --keys')`);
  });
  return out;
}

/** Chart series from sampled values: numbers/booleans as lines, vectors split per axis, all-null kept as "no data". */
export function chartSeriesOf(exprs, sample) {
  const out = [];
  exprs.forEach((x, i) => {
    const vals = sample.values[i], t = sample.times;
    const first = vals.find((v) => v != null);
    if (Array.isArray(first) && first.length <= 4 && first.every((v) => typeof v === "number")) {
      ["x", "y", "z", "w"].slice(0, first.length).forEach((ax, k) => out.push({ label: `${x}.${ax}`, points: vals.map((v, j) => [t[j], Array.isArray(v) ? v[k] : null]) }));
    } else out.push({ label: x, points: vals.map((v, j) => [t[j], typeof v === "boolean" || typeof v === "number" ? v : null]) });
  });
  return out;
}

// ------------------------------------------------------------------ eval

export async function evalCommand(pos, opt) {
  if (opt.when) return evalWhen(pos, opt);
  if (opt.diff) return evalDiff(pos, opt);
  const exprs = pos;
  const out = [];
  await withGame(opt, async (s, cfg) => {
    const fps = s.fps;
    const frames = [...new Set(timeList(opt.at, [opt.time && opt.time !== true ? String(opt.time) : opt.keys && !exprs.length ? "1" : "0.5"]).map((t) => framesOf(t, fps)))].sort((a, b) => a - b);
    const st = await begin(s, runOpts(opt, cfg));
    const needPrev = exprs.some(usesPrev);
    const ref = opt.keys && frames[0] > 0 ? await s.snapshot() : null;   // frame 0: marks the live paths
    let keysShown = false;
    for (const f of frames) {
      let prev = null;
      if (needPrev && f > 0) { await stepTo(s, st, f - 1); prev = await s.snapshot(); }
      await stepTo(s, st, f);
      const snap = await s.snapshot();
      if ((opt.keys || (!exprs.length && !opt.summary)) && !keysShown) {
        keysShown = true;
        say(`— snapshot at ${fmtF(f, fps)}: paths for expressions${ref ? " (~ = changed since frame 0)" : ""} —`);
        for (const l of describeState(snap.state || {}, ref ? ref.state || {} : undefined)) say(` ${l}`);
      }
      if (opt.summary) say(summarizeState(snap));
      if (!exprs.length) continue;
      const row = { t: tr(snap.time ?? f / fps), frame: f, values: {} };
      for (const x of exprs) {
        let v;
        try { v = evaluate(x, snap, prev); } catch (e) { v = { error: e.message }; }
        row.values[x] = v === undefined ? null : v;
      }
      out.push(row);
      if (!opt.json) {
        console.log(`— ${fmtF(f, fps)}`);
        for (const x of exprs) { const v = row.values[x]; console.log(`   ${x}  =  ${v && v.error ? `✖ ${v.error}` : fmt(v, 200)}`); }
      }
    }
    const errs = printLogs(await s.drainLogs());
    if (errs && !opt.json) console.log("(the game logged errors — values may be affected)");
  });
  if (opt.json) console.log(JSON.stringify(out, null, 1));
}

/** eval --when "cond, cond2" [--time 5]: the frames where each condition holds (sampled every frame). */
async function evalWhen(pos, opt) {
  const conds = [...splitTop(String(opt.when)), ...pos];
  let result;
  await withGame(opt, async (s, cfg) => {
    const fps = s.fps;
    const endF = framesOf(opt.time && opt.time !== true ? String(opt.time) : "5", fps);
    const every = opt.every && opt.every !== true ? framesOf(String(opt.every), fps) : 1;
    const st = await begin(s, runOpts(opt, cfg));
    const sample = await sampleExprs(s, st, conds, frameGrid(0, endF, every));
    printLogs(await s.drainLogs());
    const items = conds.map((x, i) => {
      const pts = sample.frames.map((f, k) => ({ f, v: sample.values[i][k] }));
      const sp = spans(pts);
      const first = sp.length ? sp[0].from : null;
      return { expr: x, first, firstT: first == null ? null : tr(first / fps), spans: sp.map((q) => ({ from: q.from, to: q.to, frames: q.to - q.from + 1, toEnd: !!q.toEnd })), last: sample.values[i][sample.values[i].length - 1] };
    });
    const lines = errorLines(conds, sample);
    for (const it of items) {
      if (it.first == null) { lines.push(`${it.expr}: never true in f0..f${endF} (${fmtT(endF / fps)})${every > 1 ? ` (sampled every ${every}f)` : ""}; last value ${fmtV(it.last)}`); continue; }
      const sp = it.spans;
      if (sp.length === 1 && sp[0].toEnd) lines.push(`${it.expr}: first true at frame ${it.first} (t=${fmtT(it.first / fps)}), stays true to the end (f${endF}, ${fmtT(endF / fps)})`);
      else if (sp.length === 1) lines.push(`${it.expr}: true from frame ${sp[0].from} to ${sp[0].to} (${sp[0].frames}f, t=${fmtT(sp[0].from / fps)}–${fmtT(sp[0].to / fps)}), false after`);
      else lines.push(`${it.expr}: first true at frame ${it.first} (t=${fmtT(it.first / fps)}); true in ${sp.length} spans: ${sp.slice(0, 8).map((q) => `f${q.from}–${q.toEnd ? "end" : `f${q.to}`} (${q.frames}f)`).join(", ")}${sp.length > 8 ? ", …" : ""}`);
    }
    result = { items, lines, endF, fps, every };
  });
  if (opt.json) {
    printJSON(envelope("eval --when", {
      verdict: result.lines.filter((l) => !l.startsWith("✖")).join(" | "),
      summary: Object.fromEntries(result.items.map((it) => [it.expr, { first: it.first, firstT: it.firstT, spans: it.spans.length }])),
      data: { frames: [0, result.endF], every: result.every, fps: result.fps, conditions: result.items },
    }));
    return;
  }
  console.log(result.lines.join("\n"));
}

/** eval --diff 1,3: what changed in the state between two moments (entities matched by id). */
async function evalDiff(pos, opt) {
  const ts = timeList(opt.diff, []);
  if (ts.length !== 2) die('usage: witness eval --diff 1,3 [--input ...]   (two times: seconds or frames like 90f)');
  let res;
  await withGame(opt, async (s, cfg) => {
    const fps = s.fps;
    const [fa, fb] = ts.map((t) => framesOf(t, fps));
    if (fb <= fa) die("--diff wants an earlier time first, e.g. --diff 1,3");
    const st = await begin(s, runOpts(opt, cfg));
    await stepTo(s, st, fa);
    const a = await s.snapshot();
    await stepTo(s, st, fb);
    const b = await s.snapshot();
    printLogs(await s.drainLogs());
    const d = diffStates(a.state ?? null, b.state ?? null);
    res = { fa, fb, fps, d };
  });
  const { fa, fb, fps, d } = res;
  const short = (v) => (v === undefined ? "(none)" : fmt(v, 50));
  const label = (x) => (x.kind === "added" ? `${x.path}: added ${short(x.b)}` : x.kind === "removed" ? `${x.path}: removed (was ${short(x.a)})` : `${x.path}: ${short(x.a)} → ${short(x.b)}`);
  if (opt.json) {
    printJSON(envelope("eval --diff", {
      verdict: `${d.length} path${d.length === 1 ? "" : "s"} changed between frames ${fa} and ${fb}`,
      summary: { changed: d.length, added: d.filter((x) => x.kind === "added").length, removed: d.filter((x) => x.kind === "removed").length },
      data: { from: { frame: fa, t: tr(fa / fps) }, to: { frame: fb, t: tr(fb / fps) }, changes: d },
    }));
    return;
  }
  console.log(`between t=${fmtT(fa / fps)} and t=${fmtT(fb / fps)} (frames ${fa}→${fb}), ${d.length >= 500 ? "500+" : d.length} path${d.length === 1 ? "" : "s"} changed${d.length ? ":" : " (identical state)"}`);
  for (const x of d.slice(0, 40)) console.log(`  ${label(x)}`);
  if (d.length > 40) console.log(`  … ${d.length - 40} more (--json)`);
}

// ------------------------------------------------------------------ trace

export async function traceCommand(pos, opt) {
  if (!opt.watch || opt.watch === true) die('usage: witness trace --watch "state.player.pos[1], state.score" [--time 5] [--every 1f]');
  const exprs = splitTop(String(opt.watch));
  const named = parseNamedEvents(opt.events);
  let res;
  await withGame(opt, async (s, cfg, root) => {
    const fps = s.fps;
    let replay = null;
    if (opt.replay) replay = loadReplay(resolveReplay(opt.replay, cfg, root));
    const endF = framesOf(opt.time && opt.time !== true ? String(opt.time) : replay ? `${replay.frames}f` : "5", fps, replay ? replay.dts : null);
    // every frame by default (velocity from consecutive samples is exact); long runs thin out to <= 600 samples
    const every = opt.every && opt.every !== true ? Math.max(1, framesOf(String(opt.every), fps)) : Math.max(1, Math.ceil(endF / 600));
    const st = await begin(s, { ...runOpts(opt, cfg), replay });
    const all = [...exprs, ...named.map((n) => n.expr)];
    const sample = await sampleExprs(s, st, all, frameGrid(0, endF, every), { dts: st.dts });
    printLogs(await s.drainLogs());
    const outFile = path.resolve(opt.out || path.join(root, cfg.shots, "trace.png"));
    const evs = named.length ? eventFrames(named, { ...sample, values: sample.values.slice(exprs.length) }) : [];
    const main = { ...sample, values: sample.values.slice(0, exprs.length), errors: sample.errors.slice(0, exprs.length), missing: sample.missing.slice(0, exprs.length) };
    let chart = null;
    if (!opt["no-chart"]) {
      try {
        const m = await media();
        const markers = [...(replay ? replay.marks : []), ...evs.map((e) => ({ t: e.t, label: e.name, color: "#ffd166" }))];
        const inputs = inputSpans(runOpts(opt, cfg).input, fps).map((sp) => ({ label: sp.label, t0: sp.f0 / fps, t1: (sp.f1 ?? endF) / fps }));
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, m.lineChart({ title: `${s.hello.name}: ${exprs.join(", ")}`, series: chartSeriesOf(exprs, main), markers, inputs, fps }));
        chart = outFile;
      } catch (e) { say(`(no chart: ${e.message})`); }
    }
    res = { fps, endF, every, sample: main, evs, chart };
  });
  const { fps, endF, every, sample, evs, chart } = res;
  if (opt.json) {
    // compact: one [t, value, frame] sample per line
    console.log(compactSeriesJSON(Object.fromEntries(exprs.map((x, i) => [x, sample.frames.map((f, k) => [tr(sample.times[k]), sample.values[i][k], f])]))));
    for (const l of errorLines(exprs, sample)) console.error(l);
    return;
  }
  console.log(`${sample.frames.length} samples, f0..f${endF} (${fmtT(endF / fps)})${every > 1 ? `, every ${every} frames` : ", every frame"}`);
  for (const l of errorLines(exprs, sample)) console.log(l);
  exprs.forEach((x, i) => { if (!sample.errors[i] || sample.errors[i].count < sample.frames.length) for (const l of seriesLines(x, sample.frames, sample.values[i], fps)) console.log(l); });
  if (evs.length) console.log(`  events: ${evs.slice(0, 12).map((e) => `${e.name} @f${e.f}`).join(", ")}${evs.length > 12 ? ", …" : ""}`);
  if (chart) console.log(`chart → ${chart}  (view it with your image tool)`);
}

export { perFrame };
