// Witness CLI: measure anim — animation timing: frames per pose, loop length, irregular holds and broken cycles.
//   --of "state.player.anim"        from a state field (exact)
//   --region x,y,w,h | --follow ... from pixels in a fixed or followed box (idle animations, sprites in place)
//   (neither)                       from pixels of the moving objects that measure motion tracks
import fs from "node:fs";
import path from "node:path";
import { begin, stepTo } from "../core/runner.js";
import { sampleExprs, frameGrid } from "../core/sample.js";
import { analyzeAnim } from "../core/anim.js";
import { evaluate, hint } from "../core/expr.js";
import { parseRect } from "./see.js";
import { die, withGame, gamePixels, runOpts, media, printLogs, framesOf, shotImage, envelope, emit, fmtT } from "./common.js";

const r3 = (x) => (x == null ? x : Math.round(x * 1000) / 1000);
const posOf = (p) => (Array.isArray(p) ? p : p && Array.isArray(p.pos) ? p.pos : p && typeof p === "object" && "x" in p ? [p.x, p.y] : null);

/** The text lines and summary for one analyzeAnim result. name(label) shows a pose. */
export function formatAnim(a, { fps, what, name = (l) => String(l), first, last }) {
  const ms = (f) => `${Math.round((f * 1000) / fps)} ms`;
  const lines = [];
  const clean = a.animated && !a.irregular.length && !a.breaks.length && a.loops.every((l) => l.frames === a.loopFrames && l.clean);
  const range = first != null ? ` f${first}..f${last}` : "";
  if (!a.animated) lines.push(`anim ${what}${range}: ${a.poses ? "one pose the whole time (no animation seen)" : "nothing to measure (never visible)"}`);
  else {
    const head = `anim ${what}${range}: ${a.poses} pose${a.poses === 1 ? "" : "s"}${a.framesPerPose ? `, usually ${a.framesPerPose}f each (${ms(a.framesPerPose)}, ${+(fps / a.framesPerPose).toFixed(2)} poses/s)` : ""}`;
    const loop = a.period ? ` · loop ${a.period} poses = ${a.loopFrames != null ? `${a.loopFrames}f (${fmtT(a.loopFrames / fps)})` : "?"}, ${a.cycles} loops seen${a.confidence === "unsure" ? " (too few to be sure)" : ""}${clean ? ", clean" : ""}` : " · no repeating cycle in this window";
    lines.push(head + loop);
    if (a.shimmer) lines.push(`  ⚠ probably not an animation: the shape repeats every ${a.shimmer.loopFrames}f, exactly when its ${a.shimmer.step} px/f motion lands on the same sub-pixel phase again (${+(a.shimmer.step * a.shimmer.loopFrames).toFixed(2)} px): sub-pixel positions rasterized differently (shimmer). Round draw positions to whole pixels, or check with --of on the game's animation field`);
    for (const q of a.irregular.slice(0, 6)) lines.push(`  ⚠ pose ${name(q.label)} held ${q.len}f at f${q.start}–f${q.start + q.len - 1} (usual ${q.usual}f): ${q.len > q.usual ? "a doubled frame or a stall?" : "a dropped frame?"}`);
    if (a.irregular.length > 6) lines.push(`  … ${a.irregular.length - 6} more irregular holds (--json)`);
    const odd = a.loops.filter((l) => l.frames !== a.loopFrames);
    if (odd.length) lines.push(`  ⚠ loop${odd.length === 1 ? "" : "s"} ${odd.slice(0, 4).map((l) => `at f${l.start} took ${l.frames}f`).join(", ")} (usual ${a.loopFrames}f)`);
    for (const b of a.breaks.slice(0, 4)) lines.push(`  ⚠ the order breaks at f${b.start}: pose ${name(b.label)} where pose ${name(b.expected)} comes in the cycle (a skipped or extra pose?)`);
    const holds = Object.entries(a.holds);
    if (holds.length && holds.some(([, h]) => h !== a.framesPerPose)) lines.push(`  holds per pose: ${holds.map(([l, h]) => `${name(l)} ${h}f`).join(" · ")}`);
    lines.push(`  sequence: ${a.runs.slice(0, 16).map((r) => `${name(r.label)}×${r.len}`).join(" ")}${a.runs.length > 16 ? " …" : ""}  (first and last holds are cut by the window)`);
  }
  const summary = {
    poses: a.poses, animated: a.animated, framesPerPose: a.framesPerPose, msPerPose: a.framesPerPose ? r3((a.framesPerPose * 1000) / fps) : null,
    period: a.period, loopFrames: a.loopFrames, cycles: a.cycles, irregular: a.irregular.length, breaks: a.breaks.length, clean, confidence: a.confidence, shimmer: !!a.shimmer,
  };
  return { lines, summary };
}

export async function animMeasure(files, opt) {
  if (opt.of && opt.of !== true) return stateAnim(opt);
  if (opt.region || opt.follow) return boxAnim(files, opt);
  const { motionMeasure } = await import("./measure.js");
  const m = await media();
  const read = (f) => { const p = path.resolve(String(f)); if (!fs.existsSync(p)) die(`no such image: ${f}`); return fs.readFileSync(p); };
  return motionMeasure(m, files.map(read), { ...opt, anim: true }, undefined);
}

/** From a state field: the value each frame is the pose. */
async function stateAnim(opt) {
  let out;
  await withGame(opt, async (s, cfg) => {
    const fps = s.fps;
    const f0 = framesOf(opt.at !== undefined && opt.at !== true ? String(opt.at) : opt.from !== undefined && opt.from !== true ? String(opt.from) : "0", fps);
    const f1 = f0 + framesOf(opt.time && opt.time !== true ? String(opt.time) : "2", fps);
    const expr = String(opt.of);
    const st = await begin(s, runOpts(opt, cfg));
    const sample = await sampleExprs(s, st, [expr], frameGrid(f0, f1, 1));
    printLogs(await s.drainLogs());
    if (sample.errors[0] && sample.errors[0].count === sample.frames.length) die(`--of ${expr}: ${sample.errors[0].message}`);
    if (sample.missing[0] === sample.frames.length) die(`--of ${expr}: undefined on every frame (f${f0}..f${f1}): check the path with 'witness eval --keys${hint.flags}'`);
    const labels = sample.values[0].map((v) => (v == null ? null : typeof v === "object" ? JSON.stringify(v) : v));
    const a = analyzeAnim(labels, sample.frames);
    const f = formatAnim(a, { fps, what: expr, first: f0, last: f1 });
    out = { text: f.lines.join("\n"), env: envelope("measure anim", { verdict: f.lines[0], summary: { ...f.summary, source: "state" }, data: { ...a, frames: sample.frames, expr } }) };
  });
  emit(out.env, out.text, opt);
}

/** From pixels in a fixed box (--region) or one that follows a position (--follow expr [--size 32]). */
async function boxAnim(files, opt) {
  const m = await media();
  const tol = opt.tolerance && opt.tolerance !== true ? +opt.tolerance : 0.05;
  let size = [32, 32];
  if (opt.size && opt.size !== true) { const q = /^(\d+)(?:[x×,](\d+))?$/.exec(String(opt.size)); if (!q) die(`--size wants N or WxH (got ${opt.size})`); size = [+q[1], +(q[2] ?? q[1])]; }
  const region = opt.region && opt.region !== true ? parseRect(opt.region) : null;
  const crops = [], frames = [];
  let fps = 60, what = region ? `box ${region.x},${region.y} ${region.w}×${region.h}` : `${size.join("×")} around ${opt.follow}`, f0 = 0;
  if (files.length) {
    if (!region) die("from PNG files, measure anim needs --region x,y,w,h (or no option: the moving objects)");
    fps = opt.fps && opt.fps !== true ? +opt.fps : 60;
    files.forEach((f, i) => { const p = path.resolve(String(f)); if (!fs.existsSync(p)) die(`no such image: ${f}`); crops.push(m.cropImage(m.decodePNG(fs.readFileSync(p)), region)); frames.push(i); });
  } else {
    await withGame(opt, async (s, cfg) => {
      if (!s.has("screenshot")) die("this game's adapter doesn't support 'screenshot'");
      gamePixels(s, "measure anim --region / --follow", opt);
      fps = s.fps;
      f0 = framesOf(opt.at !== undefined && opt.at !== true ? String(opt.at) : opt.from !== undefined && opt.from !== true ? String(opt.from) : "0", fps);
      const f1 = f0 + framesOf(opt.time && opt.time !== true ? String(opt.time) : "2", fps);
      if (f1 - f0 > 1800) die("measure anim screenshots every frame: keep --time under 30 s");
      const st = await begin(s, runOpts(opt, cfg));
      for (let f = f0; f <= f1; f++) {
        await stepTo(s, st, f);
        const img = await shotImage(await s.screenshot());
        let rect = region;
        if (!rect) {
          let v;
          try { v = evaluate(String(opt.follow), await s.snapshot()); } catch (e) { die(`--follow: ${e.message}`); }
          const p = posOf(v);
          if (!p) die(`--follow "${opt.follow}" gave ${JSON.stringify(v)}, not a position in screen pixels`);
          rect = { x: Math.round(+p[0] - size[0] / 2), y: Math.round(+p[1] - size[1] / 2), w: size[0], h: size[1] };
        }
        crops.push(m.cropImage(img, rect)); frames.push(f);
      }
      printLogs(await s.drainLogs());
    });
  }
  const P = m.poseLabels(crops, { tolerance: tol });
  const a = analyzeAnim(P.labels, frames);
  const f = formatAnim(a, { fps, what, name: (l) => `#${l}`, first: frames[0], last: frames[frames.length - 1] });
  f.lines.push(`  poses: ${P.poses.map((p) => `#${p.id} first f${frames[p.first]} (${p.count}f)`).join(" · ")} — a new pose = over ${Math.round(tol * 100)}% of the pixels differ (--tolerance)`);
  emit(envelope("measure anim", { verdict: f.lines[0], summary: { ...f.summary, source: "pixels" }, data: { ...a, frames, poses: P.poses.map(({ id, first, count }) => ({ id, first: frames[first], count })) } }), f.lines.join("\n"), opt);
}

/** Pose timing for the moving objects of a motion result (pixel route without a box). */
export function animForObjects(m, r, f0, fps, tol = 0.05) {
  if (!r.cropsOf) return;
  for (const o of (r.objects || []).slice(0, 3)) {
    // frames where it merged with something or was cut (o.irregular) don't show its own pose
    const bad = new Set(o.irregular || []);
    const crops = r.cropsOf(o).map((c, j) => (bad.has(o.frames[j].i) ? null : c));
    const P = m.poseLabels(crops, { tolerance: tol });
    o.anim = { ...analyzeAnim(P.labels, o.frames.map((q) => (f0 ?? 0) + q.i)), poseCount: P.poses.map(({ id, count }) => ({ id, count })) };
    // poses that change every frame or two, in step with a fractional speed (1.33 px/f repeats every 3 frames):
    // the sprite is re-rasterized at sub-pixel positions (shapes snap differently), not animated
    const a = o.anim, step = o.meanStep || 0, frac = Math.abs(step - Math.round(step));
    if (a.animated && a.framesPerPose && a.framesPerPose <= 2 && a.loopFrames && frac > 0.05 && Math.abs(step * a.loopFrames - Math.round(step * a.loopFrames)) < 0.1) a.shimmer = { step, loopFrames: a.loopFrames };
  }
  delete r.cropsOf;
}
