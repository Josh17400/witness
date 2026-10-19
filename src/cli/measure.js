// Witness CLI: measure — exact numbers instead of eyeballing.
//   pixels:  scale, box, contrast, motion
//   state:   curve, jump, move, hitstop  (an expression sampled every frame of a scripted run)
import fs from "node:fs";
import path from "node:path";
import { begin, stepTo } from "../core/runner.js";
import { sampleExprs, frameGrid } from "../core/sample.js";
import { summarize, frozenSpans, response, lag, stutters, analyzeJump, analyzeMove, numeric } from "../core/signal.js";
import { parseWitnessInput } from "../core/input-spec.js";
import { inputSpans, errorLines } from "./ask.js";
import { parseRect } from "./see.js";
import {
  die, say, withGame, runOpts, media, printLogs, splitTop, framesOf, fmtT, shotImage, envelope, printJSON,
} from "./common.js";

const r3 = (x) => (x == null ? x : Math.round(x * 1000) / 1000);
const ms = (frames, fps) => `${Math.round((frames * 1000) / fps)} ms`;

export async function measureCommand(pos, opt) {
  const what = pos[0], files = pos.slice(1);
  if (["curve", "jump", "move", "hitstop"].includes(what)) return stateMeasure(what, opt);
  return pixelMeasure(what, files, opt);
}

// ------------------------------------------------------------------ pixel measures

async function pixelMeasure(what, files, opt) {
  const m = await media();
  const read = (f) => { const p = path.resolve(String(f)); if (!fs.existsSync(p)) die(`no such image: ${f}`); return fs.readFileSync(p); };
  const region = opt.region && opt.region !== true ? parseRect(opt.region) : undefined;
  const out = (obj, lines) => { if (opt.json) printJSON(obj); else console.log(lines.filter(Boolean).join("\n")); };
  const box = (b) => (b ? `x=${b.x} y=${b.y} ${b.w}×${b.h}` : "none");
  if (what === "scale") {
    if (!files[0]) die("usage: witness measure scale <shot.png> [--k 3]");
    const img = m.decodePNG(read(files[0]));
    const k = opt.k && opt.k !== true ? +opt.k : m.detectScale(img, { region, tolerance: +(opt.tolerance || 0) });
    const r = m.blockScale(img, k, { region, tolerance: +(opt.tolerance || 0) });
    out(r, [`${files[0]}: ${img.width}×${img.height}, ${opt.k ? "checked" : "detected"} scale ×${r.k}, grid offset [${r.offset}]`,
      `  ${r.cells} cells, ${r.nonUniform} not one colour (${r.nonUniformPercent}%) → ${r.blurry ? "✖ BLURRY or fractionally scaled" : r.k > 1 ? "✔ exact integer scaling" : "no pixel grid larger than 1"}`,
      ...r.worst.slice(0, 5).map((c) => `  worst cell ${box(c)}: ${c.colors} colours, spread ${c.spread}`)]);
  } else if (what === "box") {
    if (files.length < 2) die("usage: witness measure box <with.png> <without.png>");
    const r = m.maskDiff(read(files[0]), read(files[1]), { threshold: +(opt.threshold || 16), region });
    out({ count: r.count, bbox: r.bbox, centroid: r.centroid }, [r.count ? `✔ ${r.count} px differ: box ${box(r.bbox)} (height ${r.bbox.h} px, width ${r.bbox.w} px), centroid [${r.centroid}]` : "the two images are the same (nothing to measure)"]);
  } else if (what === "contrast") {
    if (!files[0] || !opt.a || !opt.b) die("usage: witness measure contrast <shot.png> --a <mask> --b <mask|ring[:r]>");
    const img = m.decodePNG(read(files[0]));
    const mask = (spec) => {
      const s = String(spec);
      if (s.startsWith("#") || s.startsWith("rgb")) { const [c, tol] = s.split("~"); return m.maskFromColor(img, c, +(tol || 0)); }
      if (s.startsWith("diff:")) return m.maskDiff(img, read(s.slice(5)), { threshold: +(opt.threshold || 16) }).mask;
      return m.maskFromRect(img.width, img.height, parseRect(s));
    };
    const A = mask(opt.a);
    const B = /^ring(:\d+)?$/.test(String(opt.b)) ? m.ringMask(A, img.width, img.height, +(String(opt.b).split(":")[1] || 2)) : mask(opt.b);
    const r = m.contrast(img, A, B);
    out(r, [`contrast ${r.ratio.toFixed(2)}:1 (WCAG: 3 for large shapes, 4.5 for text) · ΔE ${r.deltaE.toFixed(1)} · luminance ${r.lumA.toFixed(3)} vs ${r.lumB.toFixed(3)} · ${r.countA} vs ${r.countB} px`]);
  } else if (what === "motion") {
    return motionMeasure(m, files.map(read), opt, region);
  } else die("usage: witness measure scale|box|contrast|motion|curve|jump|move|hitstop ...  (witness help measure)");
}

async function motionMeasure(m, fileFrames, opt, region) {
  const bgOpt = opt.background && opt.background !== true ? String(opt.background) : "auto";
  const named = ["auto", "first", "median"].includes(bgOpt);
  const bgImage = named ? null : (() => { const p = path.resolve(bgOpt); if (!fs.existsSync(p)) die(`no such image: ${bgOpt}`); return fs.readFileSync(p); })();
  const threshold = +(opt.threshold || 16);
  let r, f0 = null, fps = null;
  if (fileFrames.length) {
    if (fileFrames.length < 2) die("motion needs at least 2 frames");
    r = m.motion(fileFrames, { region, threshold, background: bgImage || bgOpt });
  } else {
    await withGame(opt, async (s, cfg) => {
      if (!s.has("screenshot")) die("this game's adapter doesn't support 'screenshot'");
      fps = s.fps;
      f0 = framesOf(opt.at && opt.at !== true ? String(opt.at) : "0", fps);
      const f1 = f0 + framesOf(opt.time && opt.time !== true ? String(opt.time) : "0.5", fps);
      const N = f1 - f0 + 1;
      if (N > 601) die("motion captures every frame: keep --time under 10 s");
      if (N < 2) die("motion needs at least 2 frames (--time)");
      let mode = bgOpt === "auto" ? (N >= m.AUTO_MEDIAN_FRAMES ? "median" : "first") : bgImage ? "image" : bgOpt;
      const grab = async () => shotImage(await s.screenshot());
      let plate = mode === "image" ? bgImage : mode === "first" ? "first" : null;
      if (mode === "median" && !s.has("reset")) {
        // no reset: no second pass, so keep the frames (capped above)
        const st = await begin(s, runOpts(opt, cfg));
        const frames = [];
        for (let f = f0; f <= f1; f++) { await stepTo(s, st, f); const im = await grab(); frames.push({ width: im.width, height: im.height, data: Uint8Array.from(im.data) }); }
        r = m.motion(frames, { region, threshold, background: "median" });
      } else {
        if (mode === "median") {
          // pass 1: only the 15 frames the median plate is built from
          const want = new Set(m.medianSampleIndices(N).map((i) => f0 + i));
          const st = await begin(s, runOpts(opt, cfg));
          const picks = [];
          for (const f of [...want].sort((a, b) => a - b)) { await stepTo(s, st, f); const im = await grab(); picks.push({ width: im.width, height: im.height, data: Uint8Array.from(im.data) }); }
          plate = m.medianPlate(picks, region);
          await s.drainLogs();
        }
        // stream every frame against the plate (nothing else is kept)
        const tracker = m.motionStream({ region, threshold, plate });
        const st = await begin(s, runOpts(opt, cfg));
        for (let f = f0; f <= f1; f++) { await stepTo(s, st, f); tracker.push(await grab()); }
        r = tracker.finish(mode);
      }
      if (bgOpt === "auto") r.backgroundChoice = mode === "median" ? `auto → median (${N} frames)` : `auto → first (only ${N} frames; median needs ${m.AUTO_MEDIAN_FRAMES})`;
      printLogs(await s.drainLogs());
    });
  }
  const sm = r.summary;
  const fl = (i) => (f0 != null ? `f${f0 + i}` : `#${i}`);
  const box = (b) => (b ? `x=${b.x} y=${b.y} ${b.w}×${b.h}` : "-");
  if (opt.json) {
    printJSON(envelope("measure motion", {
      verdict: `object in ${sm.framesWithObject}/${r.frames.length} frames, mean step ${sm.meanStep} px, jitter ${sm.jitter}`,
      summary: { framesWithObject: sm.framesWithObject, pathLength: sm.pathLength, netDistance: sm.netDistance, meanStep: sm.meanStep, maxStep: sm.maxStep, jitter: sm.jitter },
      data: { ...r, firstFrame: f0, fps },
    }));
    return;
  }
  const lines = [
    `motion ${f0 != null ? `f${f0}..f${f0 + r.frames.length - 1}` : `${r.frames.length} images`} (${r.frames.length} frames, background ${r.backgroundChoice || r.background}): object in ${sm.framesWithObject} · path ${sm.pathLength} px · net [${sm.net}] (${sm.netDistance} px) · step mean ${sm.meanStep} / max ${sm.maxStep}${fps ? ` (${r3(sm.meanStep * fps)} px/s)` : ""} · jitter ${sm.jitter ?? "n/a (<5 frames)"}${sm.jitter != null ? " px off a smooth path" : ""}`,
    ...r.warnings.map((w) => `⚠ ${w}`),
  ];
  const rows = r.frames.map((f, i) => `  ${fl(i)}  box ${box(f.bbox)}  centroid ${f.centroid ? `[${f.centroid}]` : "-"}  lowest row ${f.lowestRowSpan ? `y=${f.lowestRowSpan.y} x=${f.lowestRowSpan.x0}..${f.lowestRowSpan.x1}` : "-"}${r.steps[i - 1] ? `  step [${r.steps[i - 1]}]` : ""}`);
  lines.push(...(rows.length > 60 ? [...rows.slice(0, 30), `  … ${rows.length - 60} frames (--json) …`, ...rows.slice(-30)] : rows));
  console.log(lines.join("\n"));
}

// ------------------------------------------------------------------ state measures (sampled every frame)

const JUMPY = /^(space|up|w|z|x|k|c|j|jump|action:jump|pad:a)$/i;

/** Sample the expressions every frame from `from` to the end of the scenario. */
async function sampleScenario(opt, exprs, { defaultTail = 2 } = {}) {
  let res;
  await withGame(opt, async (s, cfg) => {
    const fps = s.fps;
    const ro = runOpts(opt, cfg);
    let evs = [];
    try { evs = parseWitnessInput(ro.input, fps); } catch (e) { die(e.message); }
    const lastInput = evs.length ? Math.max(...evs.map((e) => e.frame)) : 0;
    const from = framesOf(opt.from && opt.from !== true ? String(opt.from) : "0", fps);
    const to = opt.to && opt.to !== true ? framesOf(String(opt.to), fps)
      : opt.time && opt.time !== true ? from + framesOf(String(opt.time), fps)
      : Math.max(from + fps, lastInput + Math.round(defaultTail * fps));
    if (to - from > 36000) die("that is more than 10 minutes of frames: shorten --time");
    const st = await begin(s, ro);
    const sample = await sampleExprs(s, st, exprs, frameGrid(from, to, 1));
    printLogs(await s.drainLogs());
    const errs = errorLines(exprs, sample);
    if (errs.length) die(errs.join("\n"));
    res = { fps, sample, spans: inputSpans(ro.input, fps), from, to, name: s.hello.name };
  });
  return res;
}

const series = (sample, i) => sample.frames.map((f, k) => ({ f, v: sample.values[i][k] }));
function oneAxis(sample, i, expr) {
  const pts = series(sample, i);
  const first = pts.find((p) => p.v != null)?.v;
  if (Array.isArray(first)) die(`"${expr}" is a vector (${JSON.stringify(first)}): pick one axis, e.g. ${expr}[0] or ${expr}[1]`);
  if (first != null && typeof first !== "number" && typeof first !== "boolean") die(`"${expr}" is not a number (got ${JSON.stringify(first)})`);
  return pts;
}

async function stateMeasure(what, opt) {
  const get = (k) => (opt[k] && opt[k] !== true ? String(opt[k]) : null);
  if (what === "jump") {
    const y = get("y") || get("of");
    if (!y) die('usage: witness measure jump --y "state.player.pos[1]" --input "space@1" [--x "state.player.pos[0]"] [--up -1]');
    const x = get("x");
    const { fps, sample, spans, from, to } = await sampleScenario(opt, x ? [y, x] : [y], { defaultTail: 3 });
    const ys = oneAxis(sample, 0, y), xs = x ? oneAxis(sample, 1, x) : null;
    // the press: --key, else the press that comes last before the height first changes
    const key = get("key");
    let presses = spans.filter((sp) => sp.f0 >= from && (!key || sp.label === key));
    const moved = (() => { const p = numeric(ys); const start = presses.length ? presses[0].f0 : from; const i0 = p.findIndex((q) => q.f >= start); if (i0 < 0) return null; for (let i = i0 + 1; i < p.length; i++) if (Math.abs(p[i].v - p[i0].v) > 0.01) return p[i].f; return null; })();
    if (!key && presses.length > 1) { const jp = presses.filter((sp) => JUMPY.test(sp.label) && (moved == null || sp.f0 < moved)); presses = jp.length ? jp : presses.filter((sp) => moved == null || sp.f0 < moved); }
    const press = presses.length ? presses[presses.length - 1] : null;
    const up = get("up") ? Math.sign(+get("up")) : null;
    const j = analyzeJump(ys, { press: press ? press.f0 : null, up, xs, fps });
    return reportJump(j, { y, x, press, fps, from, to, opt });
  }
  if (what === "move") {
    const x = get("x") || get("of");
    if (!x) die('usage: witness measure move --x "state.player.pos[0]" --input "right@1-2"');
    const { fps, sample, spans, from, to } = await sampleScenario(opt, [x], { defaultTail: 2 });
    const key = get("key");
    const span = spans.find((sp) => sp.f0 >= from && (!key || sp.label === key));
    if (!span) die(key ? `no "${key}" press in --input` : "measure move needs a held input, e.g. --input \"right@1-2\"");
    const mv = analyzeMove(oneAxis(sample, 0, x), { press: span.f0, release: span.f1, fps });
    return reportMove(mv, { x, span, fps, from, to, opt });
  }
  if (what === "hitstop") {
    const paths = splitTop(get("paths") || get("of") || "");
    if (!paths.length) die('usage: witness measure hitstop --paths "state.player.pos, state.enemy.pos" --input "right@0-2, j@1"');
    const { fps, sample, spans, from, to } = await sampleScenario(opt, paths, { defaultTail: 1.5 });
    const fr = frozenSpans(paths.map((_, i) => series(sample, i)));
    return reportHitstop(fr, { paths, spans, fps, from, to, opt });
  }
  // curve
  const of = get("of");
  if (!of) die('usage: witness measure curve --of "state.camera.pos[0]" [--vs "state.player.pos[0]"] --input "right@1-3"');
  const vs = get("vs");
  const { fps, sample, spans, from, to } = await sampleScenario(opt, vs ? [of, vs] : [of], { defaultTail: 2 });
  const a = oneAxis(sample, 0, of), b = vs ? oneAxis(sample, 1, vs) : null;
  return reportCurve({ of, vs, a, b, fps, from, to, spans, opt });
}

function reportJump(j, { y, x, press, fps, from, to, opt }) {
  if (!j.ok) {
    if (opt.json) { printJSON(envelope("measure jump", { ok: false, verdict: j.reason, data: j })); process.exitCode = 1; return; }
    die(`no jump found in ${y} over f${from}..f${to}: ${j.reason}`);
  }
  const P = j.press;
  const lines = [];
  lines.push(`jump ${press ? `(${press.label} pressed at f${P})` : `(from f${P}, no press in --input)`}: takeoff +${j.takeoff.after}f · apex ${j.apex.height} px at +${j.apex.after}f (f${j.apex.f}, ${fmtT(j.apex.after / fps)})${j.apex.holds > 1 ? `, held ${j.apex.holds}f` : ""} · hang ${j.hang.frames}f within 10% of the apex`);
  if (j.landed) lines.push(`  airtime ${j.airtime.frames}f (${j.airtime.seconds}s) · landed at f${j.landed.f} (+${j.landed.after}f)${Math.abs(j.landed.height) > 0.5 ? `, ${Math.abs(j.landed.height)} px ${j.landed.height > 0 ? "above" : "below"} the takeoff height` : ""} · rise ${j.rise.frames}f / fall ${j.fall.frames}f`);
  else lines.push(`  still in the air at f${to} (the end of the run): no landing found (landing = holds still for 3 frames) — add --time`);
  const g = j.gravity;
  if (g.rise != null || g.fall != null) {
    const ratio = g.rise && g.fall ? g.fall / g.rise : null;
    lines.push(`  takeoff speed ${j.takeoffSpeed} px/f (${r3(j.takeoffSpeed * fps)} px/s) · gravity ${g.rise ?? "-"} px/f² rising, ${g.fall ?? "-"} falling (${r3((g.mean ?? 0) * fps * fps)} px/s² mean)${ratio ? ` → ${Math.abs(ratio - 1) < 0.05 ? "same both ways (no fast-fall)" : ratio > 1 ? `falls ${r3(ratio)}× faster (fast-fall)` : `falls ${r3(1 / ratio)}× slower (floaty fall)`}` : ""}`);
  }
  if (x) lines.push(`  horizontal distance ${j.distance ?? "-"} px (${x})`);
  lines.push(`  up = ${j.up < 0 ? "-y" : "+y"}${j.upAuto ? " (from the takeoff direction; --up to force)" : ""} · sampled every frame f${from}..f${to} of ${y}`);
  if (opt.json) {
    printJSON(envelope("measure jump", {
      verdict: lines[0],
      summary: { apexPx: j.apex.height, apexAfter: j.apex.after, takeoffAfter: j.takeoff.after, airtimeFrames: j.airtime?.frames ?? null, airtimeSeconds: j.airtime?.seconds ?? null, hangFrames: j.hang.frames, riseFrames: j.rise.frames, fallFrames: j.fall?.frames ?? null, gravityRise: g.rise, gravityFall: g.fall, distance: j.distance ?? null },
      data: { ...j, expr: y, x, fps, from, to },
    }));
    return;
  }
  console.log(lines.join("\n"));
}

function reportMove(mv, { x, span, fps, from, to, opt }) {
  if (!mv.ok) {
    if (opt.json) { printJSON(envelope("measure move", { ok: false, verdict: mv.reason, data: mv })); process.exitCode = 1; return; }
    die(`no movement found in ${x}: ${mv.reason}`);
  }
  const dirWord = mv.dir > 0 ? "+" : "-";
  const lines = [`move (${span.label} held f${span.f0}..f${span.f1 ?? "end"}): top speed ${mv.top.perSecond} px/s (${mv.top.perFrame} px/f, ${dirWord}${x.replace(/^state\./, "")}) reached at +${mv.top.after}f — first moves +${mv.firstMove.after}f, accelerates over ${mv.top.accelFrames}f (${ms(mv.top.accelFrames, fps)})`];
  if (span.f1 != null) {
    if (mv.stop) lines.push(`  after release (f${span.f1}): ${mv.stop.after <= 0 && Math.abs(mv.stop.slide) < 1e-9 ? `stops at once (the release frame f${span.f1} doesn't move)` : `stops at +${mv.stop.after}f (f${mv.stop.f}, ${ms(mv.stop.after, fps)}) · slides ${mv.stop.slide} px`}${mv.stop.overshoot ? ` · overshoots and comes back ${mv.stop.overshoot} px` : " · no overshoot"}`);
    else lines.push(`  after release (f${span.f1}): still moving at the end of the run (f${to}) — add --time`);
  }
  if (opt.json) {
    printJSON(envelope("measure move", {
      verdict: lines[0],
      summary: { topSpeed: mv.top.perSecond, topSpeedPerFrame: mv.top.perFrame, reachedAfter: mv.top.after, accelFrames: mv.top.accelFrames, firstMoveAfter: mv.firstMove.after, stopAfter: mv.stop?.after ?? null, slide: mv.stop?.slide ?? null, overshoot: mv.stop?.overshoot ?? null },
      data: { ...mv, expr: x, fps, from, to, input: span },
    }));
    return;
  }
  console.log(lines.join("\n"));
}

function reportHitstop(fr, { paths, spans, fps, from, to, opt }) {
  const pauses = fr.filter((s) => s.bounded);
  const near = (s) => { const p = spans.filter((sp) => sp.f0 <= s.from).pop(); return p ? ` (+${s.from - p.f0}f after ${p.label} at f${p.f0})` : ""; };
  const lines = [pauses.length
    ? `hitstop: ${pauses.length} freeze${pauses.length === 1 ? "" : "s"} where ${paths.length === 1 ? paths[0] : `all ${paths.length} paths`} stop and then move again: ${pauses.map((s) => `f${s.from}–f${s.to} (${s.frames}f, ${ms(s.frames, fps)})${near(s)}`).join(", ")}`
    : `hitstop: no freeze between motion in f${from}..f${to} (${paths.join(", ")} never stop and resume together)`];
  const other = fr.filter((s) => !s.bounded && s.frames >= 2);
  if (other.length) lines.push(`  other still spans (not between motion): ${other.slice(0, 6).map((s) => `f${s.from}–f${s.to}${!s.afterMotion ? " (before moving)" : !s.resumed ? " (never resumed)" : ""}`).join(", ")}`);
  if (opt.json) {
    printJSON(envelope("measure hitstop", {
      verdict: lines[0],
      summary: { freezes: pauses.length, frames: pauses.map((s) => s.frames), first: pauses[0] ? { from: pauses[0].from, to: pauses[0].to, frames: pauses[0].frames } : null },
      data: { paths, spans: fr, fps, from, to },
    }));
    return;
  }
  console.log(lines.join("\n"));
}

function reportCurve({ of, vs, a, b, fps, from, to, spans, opt }) {
  const s = summarize(a);
  if (!s) die(`"${of}" gave no numbers over f${from}..f${to}`);
  const fz = frozenSpans([a]).filter((q) => q.frames >= 2);
  const resp = response(a);
  const st = stutters(a);
  const lines = [];
  lines.push(`${of} over f${from}..f${to} (${fmtT((to - from) / fps)}): ${r3(s.start.v)} → ${r3(s.end.v)} · min ${r3(s.min.v)} @f${s.min.f} · max ${r3(s.max.v)} @f${s.max.f}`);
  if (s.step) lines.push(`  per frame ${s.step.min.d}..${s.step.max.d} (fastest at f${Math.abs(s.step.max.d) >= Math.abs(s.step.min.d) ? s.step.max.f : s.step.min.f}) = ${r3(s.step.min.d * fps)}..${r3(s.step.max.d * fps)} per second`);
  if (resp) lines.push(`  change ${resp.change}: rise 10–90% ${resp.rise ? `${resp.rise.frames}f (f${resp.rise.from}–f${resp.rise.to})` : "-"} · settles within 2% at f${resp.settle.f} · overshoot ${resp.overshoot.value}${resp.overshoot.value ? ` (${resp.overshoot.percent}%, at f${resp.overshoot.f})` : ""}`);
  if (fz.length) lines.push(`  holds still: ${fz.slice(0, 6).map((q) => `f${q.from}–f${q.to} (${q.frames}f${!q.resumed ? ", to the end" : ""})`).join(", ")}${fz.length > 6 ? ", …" : ""}`);
  lines.push(`  stutter: ${st.length ? `${st.length} frame${st.length === 1 ? " breaks" : "s break"} the smooth motion: ${st.slice(0, 6).map((q) => `f${q.f} step ${q.d} (expected ~${q.expected})`).join(", ")}` : "none (every step fits its neighbours)"}`);
  let lg = null, settleAfter = null;
  if (b) {
    lg = lag(a, b, { maxLag: Math.min(120, Math.floor((to - from) / 2)) });
    const bs = frozenSpans([b]).filter((q) => q.afterMotion && !q.resumed);
    const bStop = bs.length ? bs[bs.length - 1].from : null;
    if (bStop != null && resp) settleAfter = resp.settle.f - bStop;
    lines.push(`  vs ${vs}: ${lg ? `${lg.lag > 0 ? `lags behind by ${lg.lag}f (${ms(lg.lag, fps)})` : lg.lag < 0 ? `leads by ${-lg.lag}f` : "moves on the same frame"} (step correlation ${lg.r})` : "no lag measurable (one of them barely moves)"}${settleAfter != null ? ` · settles ${settleAfter}f (${ms(Math.max(0, settleAfter), fps)}) after ${vs} stops` : ""}`);
  }
  if (spans.length) lines.push(`  input: ${spans.slice(0, 6).map((sp) => `${sp.label} f${sp.f0}–${sp.f1 ?? "end"}`).join(", ")}`);
  if (opt.json) {
    printJSON(envelope("measure curve", {
      verdict: lines[0],
      summary: { start: s.start.v, end: s.end.v, min: s.min.v, max: s.max.v, stepMin: s.step?.min.d ?? null, stepMax: s.step?.max.d ?? null, riseFrames: resp?.rise?.frames ?? null, settleFrame: resp?.settle.f ?? null, overshoot: resp?.overshoot.value ?? null, stutters: st.length, lag: lg ? lg.lag : null },
      data: { expr: of, vs, fps, from, to, summary: s, response: resp, holds: fz, stutters: st, lag: lg, settleAfter },
    }));
    return;
  }
  console.log(lines.join("\n"));
}
