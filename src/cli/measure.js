// Witness CLI: measure — exact numbers instead of eyeballing.
//   pixels:  scale, box, contrast, motion, align, registration; ui, colorblind, palette (measure-look.js)
//   state:   curve, jump, move, hitstop  (an expression sampled every frame of a scripted run)
import fs from "node:fs";
import path from "node:path";
import { begin, stepTo, frameAt } from "../core/runner.js";
import { sampleExprs, frameGrid } from "../core/sample.js";
import { summarize, frozenSpans, response, lag, stutters, analyzeJump, analyzeMove, numeric } from "../core/signal.js";
import { parseWitnessInput } from "../core/input-spec.js";
import { inputSpans, errorLines } from "./ask.js";
import { parseRect } from "./see.js";
import { WitnessError } from "../core/session.js";
import { lookMeasure } from "./measure-look.js";
import { formatAnim } from "./anim.js";
import {
  die, withGame, runOpts, media, printLogs, splitTop, framesOf, fmtT, shotImage, envelope, emit,
} from "./common.js";

const r3 = (x) => (x == null ? x : Math.round(x * 1000) / 1000);
const ms = (frames, fps) => `${Math.round((frames * 1000) / fps)} ms`;

export const STATE_MEASURES = ["curve", "jump", "move", "hitstop"];

export async function measureCommand(pos, opt) {
  const what = pos[0], files = pos.slice(1);
  if (what === "anim") { const { animMeasure } = await import("./anim.js"); return animMeasure(files, opt); }
  if (what === "perf") { const { perfMeasure } = await import("./perf.js"); return perfMeasure(opt); }
  if (STATE_MEASURES.includes(what)) {
    let res;
    await withGame(opt, async (s, cfg) => {
      res = await measureState(s, what, opt, runOpts(opt, cfg));
      printLogs(await s.drainLogs());
    });
    return emit(res.env, res.text, opt);
  }
  return pixelMeasure(what, files, opt);
}

// ------------------------------------------------------------------ pixel measures

async function pixelMeasure(what, files, opt) {
  const m = await media();
  const read = (f) => { const p = path.resolve(String(f)); if (!fs.existsSync(p)) die(`no such image: ${f}`); return fs.readFileSync(p); };
  const region = opt.region && opt.region !== true ? parseRect(opt.region) : undefined;
  const out = (env, lines) => emit(env, lines.filter(Boolean).join("\n"), opt);
  const box = (b) => (b ? `x=${b.x} y=${b.y} ${b.w}×${b.h}` : "none");
  if (what === "scale") {
    if (!files[0]) die("usage: witness measure scale <shot.png> [--k 3]");
    const img = m.decodePNG(read(files[0]));
    const k = opt.k && opt.k !== true ? +opt.k : m.detectScale(img, { region, tolerance: +(opt.tolerance || 0) });
    const r = m.blockScale(img, k, { region, tolerance: +(opt.tolerance || 0) });
    out(envelope("measure scale", { ok: !r.blurry, verdict: r.blurry ? "blurry or fractionally scaled" : r.k > 1 ? `exact ×${r.k} integer scaling` : "no pixel grid larger than 1", summary: { k: r.k, offset: r.offset, nonUniformPercent: r.nonUniformPercent, blurry: r.blurry }, data: r }), [`${files[0]}: ${img.width}×${img.height}, ${opt.k ? "checked" : "detected"} scale ×${r.k}, grid offset [${r.offset}]`,
      `  ${r.cells} cells, ${r.nonUniform} not one colour (${r.nonUniformPercent}%) → ${r.blurry ? "✖ BLURRY or fractionally scaled" : r.k > 1 ? "✔ exact integer scaling" : "no pixel grid larger than 1"}`,
      ...r.worst.slice(0, 5).map((c) => `  worst cell ${box(c)}: ${c.colors} colours, spread ${c.spread}`)]);
  } else if (what === "box") {
    if (files.length < 2) die("usage: witness measure box <with.png> <without.png>");
    const r = m.maskDiff(read(files[0]), read(files[1]), { threshold: +(opt.threshold || 16), region });
    out(envelope("measure box", { verdict: r.count ? `${r.count} px differ` : "identical", summary: { count: r.count, width: r.bbox ? r.bbox.w : 0, height: r.bbox ? r.bbox.h : 0, bbox: r.bbox, centroid: r.centroid }, data: { count: r.count, bbox: r.bbox, centroid: r.centroid } }), [r.count ? `✔ ${r.count} px differ: box ${box(r.bbox)} (height ${r.bbox.h} px, width ${r.bbox.w} px), centroid [${r.centroid}]` : "the two images are the same (nothing to measure)"]);
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
    out(envelope("measure contrast", { verdict: `contrast ${r.ratio.toFixed(2)}:1, ΔE ${r.deltaE.toFixed(1)}`, summary: { ratio: r.ratio, deltaE: r.deltaE, lumA: r.lumA, lumB: r.lumB }, data: r }), [`contrast ${r.ratio.toFixed(2)}:1 (WCAG: 3 for large shapes, 4.5 for text) · ΔE ${r.deltaE.toFixed(1)} · luminance ${r.lumA.toFixed(3)} vs ${r.lumB.toFixed(3)} · ${r.countA} vs ${r.countB} px`]);
  } else if (what === "motion") {
    return motionMeasure(m, files.map(read), opt, region);
  } else if (what === "align") {
    return alignMeasure(m, opt);
  } else if (what === "registration" || what === "slide") {
    return registrationMeasure(m, opt);
  } else if (["ui", "colorblind", "cvd", "palette"].includes(what)) {
    return lookMeasure(what, files, opt);
  } else die("usage: witness measure scale|box|contrast|motion|anim|align|registration|ui|colorblind|palette|perf|curve|jump|move|hitstop ...  (witness help measure)");
}

export async function motionMeasure(m, fileFrames, opt, region) {
  const bgOpt = opt.background && opt.background !== true ? String(opt.background) : "auto";
  const named = ["auto", "first", "median"].includes(bgOpt);
  const bgImage = named ? null : (() => { const p = path.resolve(bgOpt); if (!fs.existsSync(p)) die(`no such image: ${bgOpt}`); return fs.readFileSync(p); })();
  const camOpt = opt.camera && opt.camera !== true ? String(opt.camera) : "auto";
  if (!["auto", "static", "moving", "state"].includes(camOpt)) die("--camera is auto, static, moving or state");
  const threshold = +(opt.threshold || 16);
  const minObject = opt["min-size"] && opt["min-size"] !== true ? Math.max(1, +opt["min-size"]) : 6;
  const copy = (im) => ({ width: im.width, height: im.height, data: Uint8Array.from(im.data) });
  let r, f0 = null, fps = null, camera = null, choice = "";
  // the plate and camera, then one streamed pass that finds every mover
  const plan = (N, cam) => {
    if (cam && cam.moving && camOpt !== "static") return "mosaic";
    if (bgImage) return "image";
    if (bgOpt === "auto") return N >= m.AUTO_MEDIAN_FRAMES ? "median" : "first";
    return bgOpt;
  };
  const describe = (mode, N) => (mode === "mosaic" ? `a world mosaic (the camera moves)` : bgOpt === "auto" ? (mode === "median" ? `auto → median (${N} frames)` : `auto → first (only ${N} frames; median needs ${m.AUTO_MEDIAN_FRAMES})`) : mode);
  if (fileFrames.length) {
    if (fileFrames.length < 2) die("motion needs at least 2 frames");
    const imgs = fileFrames.map((b) => m.decodePNG(b));
    camera = camOpt === "static" ? null : m.cameraPath(imgs, { region });
    const mode = plan(imgs.length, camera);
    const st = mode === "mosaic"
      ? m.motionStream({ region, threshold, objects: true, minObject, crops: !!opt.anim, mosaic: m.mosaicPlate(imgs, camera.positions), offsets: camera.positions })
      : m.motionStream({ region, threshold, objects: true, minObject, crops: !!opt.anim, plate: mode === "image" ? m.decodePNG(bgImage) : mode === "median" ? m.medianPlate(imgs, region) : "first" });
    for (const im of imgs) st.push(im);
    r = st.finish(mode === "image" ? "image" : mode);
    choice = describe(mode, imgs.length);
  } else {
    await withGame(opt, async (s, cfg) => {
      if (!s.has("screenshot")) die("this game's adapter doesn't support 'screenshot'");
      fps = s.fps;
      f0 = framesOf(opt.at && opt.at !== true ? String(opt.at) : "0", fps);
      const f1 = f0 + framesOf(opt.time && opt.time !== true ? String(opt.time) : "0.5", fps);
      const N = f1 - f0 + 1;
      if (N > 601) die("motion captures every frame: keep --time under 10 s");
      if (N < 2) die("motion needs at least 2 frames (--time)");
      if (!s.has("reset")) die("measure motion needs 'reset' (one pass finds the camera and background, a second measures)");
      const grab = async () => shotImage(await s.screenshot());
      // pass 1: every frame in order: the camera's motion, and the frames a plate is built from
      const want = new Set(m.medianSampleIndices(N).map((i) => f0 + i));
      const picks = [], pickIdx = [], steps = [], positions = [[0, 0]];
      let prev = null, stateCam0 = null;
      let st = await begin(s, runOpts(opt, cfg));
      for (let f = f0; f <= f1; f++) {
        await stepTo(s, st, f);
        const im = await grab();
        if (camOpt === "state") {
          // the game's own camera: exact, no estimation
          const h = cameraHint(await s.snapshot());
          if (!h) die("--camera state needs state.camera = { pos: [x, y], zoom? } in the snapshot");
          if (f === f0) stateCam0 = h;
          const p = [-(h.ox - stateCam0.ox), -(h.oy - stateCam0.oy)];
          if (f > f0) { const q = positions[positions.length - 1]; steps.push({ i: f - f0, dx: p[0] - q[0], dy: p[1] - q[1], score: 0 }); positions.push(p); }
        } else if (prev && camOpt !== "static") {
          const sh = m.estimateShift(prev, im, { region, stillShare: 0.02 });
          steps.push({ i: f - f0, dx: -sh.dx, dy: -sh.dy, score: sh.score });
          const p = positions[positions.length - 1];
          positions.push([p[0] - sh.dx, p[1] - sh.dy]);
        } else if (prev) positions.push([0, 0]);
        if (want.has(f)) { picks.push(copy(im)); pickIdx.push(f - f0); }
        if (camOpt !== "static" && camOpt !== "state") prev = copy(im);
        else if (!prev) prev = true;
      }
      await s.drainLogs();
      camera = camOpt === "static" ? null : m.summarizeCamera(steps, positions);
      if (camOpt === "moving" && camera) camera.moving = true;
      const mode = plan(N, camera);
      const plate = mode === "mosaic" ? null : mode === "image" ? m.decodePNG(bgImage) : mode === "median" ? m.medianPlate(picks, region) : "first";
      const mosaic = mode === "mosaic" ? m.mosaicPlate(picks, pickIdx.map((i) => positions[i])) : null;
      // pass 2: stream every frame against the plate
      const tracker = m.motionStream({ region, threshold, objects: true, minObject, crops: !!opt.anim, plate, mosaic, offsets: mode === "mosaic" ? positions : null });
      st = await begin(s, runOpts(opt, cfg));
      for (let f = f0; f <= f1; f++) { await stepTo(s, st, f); tracker.push(await grab()); }
      r = tracker.finish(mode);
      choice = describe(mode, N);
      printLogs(await s.drainLogs());
    });
  }
  r.backgroundChoice = choice;
  if (opt.anim) { const { animForObjects } = await import("./anim.js"); animForObjects(m, r, f0, fps || (opt.fps && opt.fps !== true ? +opt.fps : 60), opt.tolerance && opt.tolerance !== true ? +opt.tolerance : 0.05); }
  r.camera = camera ? { moving: camera.moving, perFrame: camera.perFrame, total: camera.total, jitter: camera.jitter, uneven: camera.uneven, steps: camera.steps.map(({ i, dx, dy }) => ({ i, dx, dy })) } : null;
  const out = reportMotion(r, opt, f0, fps);
  emit(out.env, out.text, opt);
}

/** measure anim on tracked objects: pose timing per moving object (the motion pipeline found and followed them). */
function reportAnim(r, opt, f0, fps) {
  const objs = (r.objects || []).filter((o) => o.anim);
  let pick = objs[0] || null;
  if (opt.track && opt.track !== true) pick = objs.find((o) => o.rank === +opt.track) || die(`--track ${opt.track}: animation is measured for the ${objs.length} biggest objects`);
  const rate = fps || (opt.fps && opt.fps !== true ? +opt.fps : 60);
  const lines = [];
  const res = [];
  for (const o of objs) {
    const vis = o.frames.filter((q) => !q.missing);
    const f = formatAnim(o.anim, { fps: rate, what: `object #${o.rank} (~${o.size} px, ${o.meanStep} px/f)`, name: (l) => `#${l}`, first: (f0 ?? 0) + vis[0].i, last: (f0 ?? 0) + vis[vis.length - 1].i });
    lines.push(...f.lines);
    res.push({ rank: o.rank, ...f.summary });
  }
  if (!objs.length) lines.push("anim: no moving object found (for a sprite that animates in place, use --region x,y,w,h or --follow \"state.player.pos\")");
  lines.push("  poses come from each object's own pixels (its mask inside its box), matched with a 1 px shift allowed; a new pose = over 5% of them differ (--tolerance)");
  const main = pick ? res.find((x) => x.rank === pick.rank) : null;
  const env = envelope("measure anim", {
    verdict: lines[0],
    summary: { ...(main || { poses: 0, animated: false }), objects: objs.length, source: "pixels" },
    data: { objects: objs.map((o) => ({ rank: o.rank, size: o.size, first: o.first, last: o.last, anim: o.anim })), firstFrame: f0, fps: rate },
  });
  return { env, text: lines.join("\n") };
}

function reportMotion(r, opt, f0, fps) {
  if (opt.anim) return reportAnim(r, opt, f0, fps);
  const sm = r.summary;
  const objs = r.objects || [];
  const fl = (i) => (f0 != null ? `f${f0 + i}` : `#${i}`);
  const box = (b) => (b ? `x=${b.x} y=${b.y} ${b.w}×${b.h}` : "-");
  // which object's frames to list: --track N (rank), --near x,y (closest in its first frame), else the main one
  let pick = objs[0] || null;
  if (opt.track && opt.track !== true) { pick = objs.find((o) => o.rank === +opt.track) || die(`--track ${opt.track}: there are ${objs.length} objects`); }
  if (opt.near && opt.near !== true) {
    const [nx, ny] = String(opt.near).split(",").map(Number);
    const firstPos = (o) => o.frames.find((f) => !f.missing).centroid;
    pick = [...objs].sort((a, b) => Math.hypot(firstPos(a)[0] - nx, firstPos(a)[1] - ny) - Math.hypot(firstPos(b)[0] - nx, firstPos(b)[1] - ny))[0] || pick;
  }
  const world = r.camera && r.camera.moving ? " (world px, camera removed)" : "";
  const env = envelope("measure motion", {
      verdict: `${objs.length} moving object${objs.length === 1 ? "" : "s"}${pick ? `; #${pick.rank}: ${pick.meanStep} px/f, jitter ${pick.jitter}` : ""}; camera ${r.camera ? (r.camera.moving ? `moves ${r.camera.perFrame} px/f` : "static") : "not checked"}`,
      summary: {
        objects: objs.length, framesWithObject: sm.framesWithObject, pathLength: sm.pathLength, netDistance: sm.netDistance, meanStep: sm.meanStep, maxStep: sm.maxStep, jitter: sm.jitter,
        main: pick ? { rank: pick.rank, meanStep: pick.meanStep, jitter: pick.jitter, stutters: pick.stutters.length, flicker: pick.flicker.length } : null,
        camera: r.camera ? { moving: r.camera.moving, perFrame: r.camera.perFrame, jitter: r.camera.jitter, uneven: r.camera.uneven.length } : null,
      },
      data: { ...r, firstFrame: f0, fps },
  });
  if (opt.json) return { env, text: "" };
  const N = r.frames.length;
  const lines = [`motion ${f0 != null ? `f${f0}..f${f0 + N - 1}` : `${N} images`} (${N} frames, background ${r.backgroundChoice || r.background}): ${objs.length} moving object${objs.length === 1 ? "" : "s"}${r.camera ? ` · camera ${r.camera.moving ? `moves [${r.camera.perFrame}] px/f` : "static"}` : ""}`];
  for (const o of objs.slice(0, 8)) {
    const fate = o.last < N - 1 ? ` · gone after ${fl(o.last)}` : "";
    const born = o.first > 0 ? ` · appears ${fl(o.first)}` : "";
    lines.push(`  #${o.rank}  ${fl(o.first)}–${fl(o.last)}  ~${o.size} px · net [${o.net}]${world} · ${o.meanStep} px/f${fps ? ` (${r3(o.meanStep * fps)} px/s)` : ""} · jitter ${o.jitter ?? "n/a"} · stutter ${o.stutters.length ? o.stutters.map((q) => `${q.kind} at ${fl(q.i)}`).join(", ") : "none"}${o.flicker.length ? ` · ⚠ flickers: gone ${o.flicker.map((q) => `${fl(q.from)}${q.to > q.from ? `–${fl(q.to)}` : ""}`).join(", ")}` : ""}${o.occluded ? ` · hidden ${o.occluded}f (overlapping another)` : ""}${o.irregular.length ? ` · merged/cut ${o.irregular.length}f (${fl(o.irregular[0])}${o.irregular.length > 1 ? `…${fl(o.irregular[o.irregular.length - 1])}` : ""}: left out of the steps)` : ""}${born}${fate}`);
  }
  if (objs.length > 8) lines.push(`  … ${objs.length - 8} more (--json)`);
  const stat = r.static || [];
  if (stat.length) lines.push(`  static changes (appear or vanish without moving: props, pickups, or a background patch the plate got wrong): ${stat.slice(0, 5).map((q) => `${box(q.bbox)} ${fl(q.first)}–${fl(q.last)}`).join(" · ")}${stat.length > 5 ? " · …" : ""}`);
  if (r.camera && r.camera.moving) {
    const u = r.camera.uneven;
    lines.push(`  camera: [${r.camera.perFrame}] px/f on average (net [${r.camera.total}] px) · jitter ${r.camera.jitter} px/f${u.length ? ` · uneven steps: ${u.slice(0, 6).map((q) => `${fl(q.i)} [${q.got}] instead of ~[${q.expected.map(r3)}]`).join(", ")}${u.length > 6 ? ", …" : ""}` : " · steady"}`);
  }
  lines.push(...r.warnings.map((w) => `⚠ ${w}`));
  lines.push(`  all movers as one mask: path ${sm.pathLength} px · net [${sm.net}] · step mean ${sm.meanStep} / max ${sm.maxStep} · jitter ${sm.jitter ?? "n/a"}`);
  if (pick) {
    lines.push(`  frames of #${pick.rank}${objs.length > 1 ? " (--track N or --near x,y for another)" : ""}:`);
    let prevC = null;
    const rows = pick.frames.map((f) => {
      if (f.missing) { prevC = null; return `  ${fl(f.i)}  ${f.missing === "occluded" ? "hidden (merged with another object)" : "GONE"}`; }
      if (pick.irregular.includes(f.i)) { prevC = null; return `  ${fl(f.i)}  box ${box(f.bbox)}  (merged or cut: ${f.count} px vs ~${pick.size})`; }
      const st = prevC ? `  step [${r3(f.centroid[0] - prevC[0])},${r3(f.centroid[1] - prevC[1])}]` : "";
      prevC = f.centroid;
      return `  ${fl(f.i)}  box ${box(f.bbox)}  centroid [${f.centroid}]${st}`;
    });
    lines.push(...(rows.length > 60 ? [...rows.slice(0, 30), `  … ${rows.length - 60} frames (--json) …`, ...rows.slice(-30)] : rows));
  } else {
    // nothing tracked (e.g. specks below --min-size): the whole-mask table as before
    const rows = r.frames.map((f, i) => `  ${fl(i)}  box ${box(f.bbox)}  centroid ${f.centroid ? `[${f.centroid}]` : "-"}  lowest row ${f.lowestRowSpan ? `y=${f.lowestRowSpan.y} x=${f.lowestRowSpan.x0}..${f.lowestRowSpan.x1}` : "-"}${r.steps[i - 1] ? `  step [${r.steps[i - 1]}]` : ""}`);
    lines.push(...(rows.length > 60 ? [...rows.slice(0, 30), `  … ${rows.length - 60} frames (--json) …`, ...rows.slice(-30)] : rows));
  }
  return { env, text: lines.join("\n") };
}

// ------------------------------------------------------------------ align: state ↔ pixels

/** Entities of a snapshot as { id, type, x, y, box, screen }, optionally only some types. */
export function entitiesOf(snap, types = null) {
  const ents = Array.isArray(snap?.state?.entities) ? snap.state.entities : [];
  const want = types ? new Set(types) : null;
  return ents.map((e) => {
    const p = Array.isArray(e.pos) ? e.pos : e && typeof e === "object" && "x" in e ? [e.x, e.y] : null;
    return { id: e.id, type: e.type ?? e.kind ?? "?", x: p ? +p[0] : NaN, y: p ? +p[1] : NaN, box: e.box, screen: e.screen, raw: e };
  }).filter((e) => !want || want.has(e.type));
}

/** The projection a state.camera convention implies: screen = (world - camera.pos) × zoom. */
export function cameraHint(snap) {
  const c = snap?.state?.camera;
  if (!c || !Array.isArray(c.pos)) return null;
  const z = Number.isFinite(+c.zoom) && +c.zoom > 0 ? +c.zoom : 1;
  return { scale: z, ox: -c.pos[0] * z, oy: -c.pos[1] * z };
}

async function alignMeasure(m, opt) {
  const types = opt.types && opt.types !== true ? String(opt.types).split(",").map((t) => t.trim()).filter(Boolean) : null;
  let res;
  await withGame(opt, async (s, cfg) => {
    if (!s.has("screenshot")) die("this game's adapter doesn't support 'screenshot'");
    const fps = s.fps;
    const f = framesOf(opt.at && opt.at !== true ? String(opt.at) : "1", fps);
    const st = await begin(s, runOpts(opt, cfg));
    await stepTo(s, st, f);
    const img = await shotImage(await s.screenshot());
    const snap = await s.snapshot();
    printLogs(await s.drainLogs());
    const ents = entitiesOf(snap, types);
    if (!ents.length) die(`no entities${types ? ` of type ${types.join(", ")}` : ""} with a position in state.entities at f${f}`);
    // a clean plate from the frames before (--clip S): for textured scenes; finds what moved, not the scenery
    let plate = null;
    if (opt.clip && opt.clip !== true) {
      const n = Math.min(240, Math.max(4, framesOf(String(opt.clip), fps)));
      if (f - n < 0) die(`--clip ${opt.clip} reaches before frame 0 (at f${f})`);
      const frames = [];
      const st2 = await begin(s, runOpts(opt, cfg));
      for (let k = f - n; k <= f; k++) { await stepTo(s, st2, k); const im = await shotImage(await s.screenshot()); frames.push({ width: im.width, height: im.height, data: Uint8Array.from(im.data) }); }
      const cam = m.cameraPath(frames);
      if (cam.moving) {
        const mos = m.mosaicPlate(frames, cam.positions);
        const off = cam.positions[cam.positions.length - 1], P = mos.plate, data = new Uint8Array(img.width * img.height * 4);
        for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) { const q = ((y + off[1] - mos.origin[1]) * P.width + x + off[0] - mos.origin[0]) * 4, o = (y * img.width + x) * 4; for (let c = 0; c < 4; c++) data[o + c] = P.data[q + c]; }
        plate = { width: img.width, height: img.height, data };
      } else plate = m.medianPlate(frames);
      await s.drainLogs();
    }
    const blobs = m.findBlobs({ width: img.width, height: img.height, data: Uint8Array.from(img.data) }, { threshold: +(opt.threshold || 24), plate });
    const hint = cameraHint(snap);
    const fit = m.fitProjection(ents, blobs, { tol: +(opt.tol || 2.5), hint });
    res = { f, fps, img: { width: img.width, height: img.height }, ents, blobs: blobs.length, hint, fit, hb: fit.ok ? m.hitboxes(fit) : [] };
  });
  const { f, fit, hint, hb, img } = res;
  const name = (e) => `#${e.id} ${e.type}`;
  const lines = [];
  const sgn = (v) => (v >= 0 ? `+ ${r3(v)}` : `− ${r3(-v)}`);
  if (!fit.ok) lines.push(`✖ state → screen: ${fit.reason} (f${f}, ${res.ents.length} entities, ${res.blobs} sprite-sized blobs)`);
  else {
    const onScreen = fit.total - fit.missing.filter((q) => q.at[0] < 0 || q.at[1] < 0 || q.at[0] >= img.width || q.at[1] >= img.height).length;
    const good = fit.residual != null && fit.residual <= 1 && (fit.fromHint ? fit.matched >= 1 : fit.matched >= Math.max(2, Math.round(onScreen * 0.5)));
    lines.push(`state → screen at f${f}: x' = ${fit.ax.toFixed(3)}·x ${sgn(fit.bx)}, y' = ${fit.ay.toFixed(3)}·y ${sgn(fit.by)} (${fit.matched} of ${fit.total} entities on a sprite, residual ${fit.residual} px) ${good ? "✔" : "⚠"}${fit.fromHint ? " — from state.camera, confirmed by the sprites found (too few to fit alone)" : ""}`);
    if (hint) {
      const same = Math.abs(hint.scale - fit.ax) < 0.02 && Math.abs(hint.ox - fit.bx) <= 1 && Math.abs(hint.oy - fit.by) <= 1;
      lines.push(`  state.camera says x' = ${hint.scale}·x ${sgn(hint.ox)}, y' = ${hint.scale}·y ${sgn(hint.oy)}: ${same ? "✔ the same" : "✖ different: the camera in the state doesn't match what's drawn"}`);
    }
    const dir = (dx, dy) => [Math.abs(dx) >= 1 ? `${Math.abs(r3(dx))} px ${dx < 0 ? "left" : "right"}` : "", Math.abs(dy) >= 1 ? `${Math.abs(r3(dy))} px ${dy < 0 ? "up" : "down"}` : ""].filter(Boolean).join(" and ");
    if (fit.offsets.length) lines.push(`  drawn away from its state position: ${fit.offsets.slice(0, 8).map((o) => `${name(o.entity)} ${dir(o.dx, o.dy)}`).join(" · ")}  (a sprite anchor or art offset? the cause of "it hit me but I wasn't touching it")`);
    const off = fit.missing.filter((q) => q.at[0] < 0 || q.at[1] < 0 || q.at[0] >= img.width || q.at[1] >= img.height);
    const lost = fit.missing.filter((q) => !off.includes(q));
    if (lost.length) lines.push(`  not found near where the state puts them: ${lost.slice(0, 8).map((q) => `${name(q.entity)} (expected x=${Math.round(q.at[0])} y=${Math.round(q.at[1])})`).join(" · ")}  (${opt.clip ? "with --clip only things that moved during the clip are found" : "not drawn, hidden, drawn as part of the scenery, or the same colour as the background"})`);
    if (off.length) lines.push(`  off screen: ${off.length} (${[...new Set(off.map((q) => q.entity.type))].slice(0, 6).join(", ")})`);
    if (hb.length) {
      const groups = new Map();
      for (const h of hb) { const k = `${h.entity.type}|${h.box}|${h.art}|${h.verdict}`; groups.set(k, (groups.get(k) || []).concat(h)); }
      lines.push(`  hitboxes: ${[...groups.values()].map((g) => `${g[0].entity.type}${g.length > 1 ? ` ×${g.length}` : ""} box ${g[0].box.join("×")} vs art ${g[0].art.join("×")} ${g[0].verdict === "matches the art" ? "✔" : `✖ ${g[0].verdict}`}`).join(" · ")}`);
    }
  }
  const env = envelope("measure align", {
    ok: fit.ok,
    verdict: lines[0].replace(/^✖ /, ""),
    summary: fit.ok ? { ax: fit.ax, bx: fit.bx, ay: fit.ay, by: fit.by, residual: fit.residual, matched: fit.matched, total: fit.total, offsets: fit.offsets.length, missing: fit.missing.length, hitboxMismatches: hb.filter((h) => h.verdict !== "matches the art").length } : {},
    data: fit.ok ? {
      frame: f, cameraHint: hint,
      offsets: fit.offsets.map((o) => ({ id: o.entity.id, type: o.entity.type, dx: o.dx, dy: o.dy })),
      missing: fit.missing.map((q) => ({ id: q.entity.id, type: q.entity.type, at: q.at })),
      matches: fit.all.map((q) => ({ id: q.entity.id, type: q.entity.type, at: q.at, sprite: [r3(q.blob.cx), r3(q.blob.cy)], bbox: q.blob.bbox, dist: q.dist })),
      hitboxes: hb.map((h) => ({ id: h.entity.id, type: h.entity.type, box: h.box, art: h.art, verdict: h.verdict })),
    } : { reason: fit.reason },
  });
  emit(env, lines.join("\n"), opt);
}

// ------------------------------------------------------------------ registration: the sprite against its state position

/**
 * measure registration --pos "state.player.pos" --at 1 --time 1 [--input ...] [--hold-camera]
 * Per frame: the sprite nearest the state position (projected with state.camera, else as pixels), its centroid's
 * offset from that position (registration), and its lowest row (the feet): how the feet move in the world against
 * how the body moves (planted feet stay put while the body walks; gliding feet move with it).
 */
async function registrationMeasure(m, opt) {
  const posExpr = opt.pos && opt.pos !== true ? String(opt.pos) : null;
  if (!posExpr) die('usage: witness measure registration --pos "state.player.pos" --at 1 --time 1 --input "right@0-2" [--hold-camera]');
  const { evaluate } = await import("../core/expr.js");
  let res;
  await withGame(opt, async (s, cfg) => {
    if (!s.has("screenshot")) die("this game's adapter doesn't support 'screenshot'");
    if (!s.has("reset")) die("measure registration needs 'reset' (one pass builds the background, a second measures)");
    const fps = s.fps;
    const f0 = framesOf(opt.at && opt.at !== true ? String(opt.at) : "0", fps);
    const f1 = f0 + framesOf(opt.time && opt.time !== true ? String(opt.time) : "1", fps);
    if (f1 - f0 > 600) die("registration screenshots every frame: keep --time under 10 s");
    const copy = (im) => ({ width: im.width, height: im.height, data: Uint8Array.from(im.data) });
    // pass 1: the frames a clean plate is built from, and the camera (from the state when it says, else estimated)
    const N = f1 - f0 + 1, want = new Set(m.medianSampleIndices(N).map((i) => f0 + i));
    const picks = [], pickIdx = [], cams = [];
    let st = await begin(s, runOpts(opt, cfg));
    let prev = null, est = [[0, 0]];
    for (let f = f0; f <= f1; f++) {
      await stepTo(s, st, f);
      const snap = await s.snapshot(), im = copy(await shotImage(await s.screenshot()));
      cams.push(cameraHint(snap));
      if (prev && !cams[0]) { const sh = m.estimateShift(prev, im); const p = est[est.length - 1]; est.push([p[0] - sh.dx, p[1] - sh.dy]); }
      if (want.has(f)) { picks.push(im); pickIdx.push(f - f0); }
      prev = im;
    }
    await s.drainLogs();
    // camera offsets in screen pixels, relative to the first frame
    const offs = cams[0] ? cams.map((c) => [-(c.ox - cams[0].ox), -(c.oy - cams[0].oy)]) : est;
    const moving = offs.some((o) => o[0] || o[1]);
    const plate = moving ? null : m.medianPlate(picks);
    const mosaic = moving ? m.mosaicPlate(picks, pickIdx.map((i) => offs[i])) : null;
    // pass 2: per frame, the blob nearest the projected state position
    st = await begin(s, runOpts(opt, cfg));
    const rows = [];
    for (let f = f0; f <= f1; f++) {
      await stepTo(s, st, f);
      const snap = await s.snapshot(), im = await shotImage(await s.screenshot());
      let p;
      try { p = evaluate(posExpr, snap); } catch (e) { die(`--pos: ${e.message}`); }
      const pos = Array.isArray(p) ? p : p && Array.isArray(p.pos) ? p.pos : null;
      if (!pos) die(`--pos "${posExpr}" gave ${JSON.stringify(p)} at f${f}, not a position [x, y]`);
      const h = cams[f - f0] || { scale: 1, ox: 0, oy: 0 };
      const sx = h.scale * pos[0] + h.ox, sy = h.scale * pos[1] + h.oy;
      const k = f - f0;
      const mask = moving ? m.maskAgainstMosaic(im, mosaic, offs[k], null, 16) : (() => { const mm = new Uint8Array(im.width * im.height); for (let i = 0, o = 0; i < mm.length; i++, o += 4) if (Math.abs(im.data[o] - plate.data[o]) > 16 || Math.abs(im.data[o + 1] - plate.data[o + 1]) > 16 || Math.abs(im.data[o + 2] - plate.data[o + 2]) > 16) mm[i] = 1; return mm; })();
      const comps = m.components(mask, im.width, im.height, { minPixels: 6 });
      let best = null;
      for (const c of comps) { const d = Math.hypot(c.cx - sx, c.cy - sy); if (d < 48 && (!best || d < best.d)) best = { c, d }; }
      if (!best) { rows.push({ f, state: [sx, sy], missing: true }); continue; }
      const c = best.c, y = c.bbox.y + c.bbox.h - 1;
      let x0 = -1, x1 = -1;
      for (let x = c.bbox.x; x < c.bbox.x + c.bbox.w; x++) if (mask[y * im.width + x]) { if (x0 < 0) x0 = x; x1 = x; }
      rows.push({ f, state: [sx, sy], world: [pos[0] * h.scale, pos[1] * h.scale], cam: offs[k], centroid: [c.cx, c.cy], foot: [(x0 + x1) / 2, y], count: c.count });
    }
    printLogs(await s.drainLogs());
    res = { fps, f0, f1, rows, moving, fromState: !!cams[0] };
  });
  const { rows, fps, moving, fromState } = res;
  const seen = rows.filter((q) => !q.missing);
  if (seen.length < 2) die(`the sprite near ${posExpr} was found in only ${seen.length} frame(s): is it drawn there? (try measure align; a sprite that never moves is part of the clean background, so it can't be measured here)`);
  const reg = seen.map((q) => [q.centroid[0] - q.state[0], q.centroid[1] - q.state[1]]);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const sd = (a) => { const mu = mean(a); return Math.sqrt(mean(a.map((v) => (v - mu) ** 2))); };
  const rx = reg.map((v) => v[0]), ry = reg.map((v) => v[1]);
  // feet vs body, in world pixels (camera removed), frame to frame
  let movingFrames = 0, planted = 0, gliding = 0;
  const steps = [];
  for (let i = 1; i < seen.length; i++) {
    const a = seen[i - 1], b = seen[i];
    if (b.f !== a.f + 1) continue;
    const body = Math.hypot(b.world[0] - a.world[0], b.world[1] - a.world[1]);
    const fx = (b.foot[0] + b.cam[0]) - (a.foot[0] + a.cam[0]), fy = (b.foot[1] + b.cam[1]) - (a.foot[1] + a.cam[1]);
    if (body < 0.25) continue;
    movingFrames++;
    const ratio = Math.hypot(fx, fy) / body;   // 0: the foot stays put in the world; 1: it moves with the body
    if (ratio < 0.25) planted++; else if (ratio > 0.75) gliding++;
    steps.push({ f: b.f, body: r3(body), foot: [r3(fx), r3(fy)] });
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  const lines = [];
  lines.push(`registration of ${posExpr} f${res.f0}..f${res.f1} (${seen.length} frames with its sprite${moving ? `, camera ${fromState ? "from state.camera" : "estimated"} and removed` : ", camera still"}):`);
  lines.push(`  sprite centre vs state position: offset [${r2(mean(rx))}, ${r2(mean(ry))}] px on average, spread ±[${r2(sd(rx))}, ${r2(sd(ry))}] (range x ${r2(Math.min(...rx))}..${r2(Math.max(...rx))}, y ${r2(Math.min(...ry))}..${r2(Math.max(...ry))}) ${Math.max(sd(rx), sd(ry)) <= 0.75 ? "✔ stays registered" : "✖ drifts against its state position"}`);
  if (movingFrames) lines.push(`  feet (the sprite's lowest row) while the body moves: planted in ${planted} of ${movingFrames} frames, gliding with the body in ${gliding}${gliding > 0.75 * movingFrames ? " → no planted frames: the feet slide (no walk cycle, or one that doesn't match the speed)" : planted ? " → the walk plants its feet" : ""}`);
  else lines.push("  the body doesn't move in this window: nothing to say about foot slide");
  if (rows.some((q) => q.missing)) lines.push(`  ⚠ no sprite near the state position at ${rows.filter((q) => q.missing).length} frame(s)`);
  const env = envelope("measure registration", {
    verdict: lines[1].trim(),
    summary: { frames: seen.length, offset: [r2(mean(rx)), r2(mean(ry))], spread: [r2(sd(rx)), r2(sd(ry))], movingFrames, planted, gliding },
    data: { expr: posExpr, fps, cameraMoving: moving, cameraFromState: fromState, frames: rows.map((q) => (q.missing ? { f: q.f, missing: true } : { f: q.f, state: q.state.map(r3), centroid: q.centroid.map(r3), foot: q.foot.map(r3), cam: q.cam })), steps },
  });
  emit(env, lines.join("\n"), opt);
}

// ------------------------------------------------------------------ state measures (sampled every frame)

const JUMPY = /^(space|up|w|z|x|k|c|j|jump|action:jump|pad:a)$/i;
const fail = (msg) => { throw new WitnessError(msg); };

/** Sample the expressions every frame from `from` to the end of the scenario (on an open session). */
async function sampleOn(s, ro, opt, exprs, { defaultTail = 2 } = {}) {
  const fps = s.fps;
  let evs = [];
  try { evs = parseWitnessInput(ro.input, fps); } catch (e) { fail(e.message); }
  const lastInput = evs.length ? Math.max(...evs.map((e) => e.frame)) : 0;
  const F = (t) => { try { return frameAt(t, fps); } catch (e) { return fail(e.message); } };
  const from = F(opt.from != null && opt.from !== true ? String(opt.from) : "0");
  const to = opt.to != null && opt.to !== true ? F(String(opt.to))
    : opt.time != null && opt.time !== true ? from + F(String(opt.time))
    : Math.max(from + fps, lastInput + Math.round(defaultTail * fps));
  if (to - from > 36000) fail("that is more than 10 minutes of frames: shorten --time");
  const st = await begin(s, ro);
  const sample = await sampleExprs(s, st, exprs, frameGrid(from, to, 1));
  const errs = errorLines(exprs, sample);
  if (errs.length) fail(errs.join("\n"));
  return { fps, sample, spans: inputSpans(ro.input, fps), from, to, name: s.hello.name };
}

const series = (sample, i) => sample.frames.map((f, k) => ({ f, v: sample.values[i][k] }));
function oneAxis(sample, i, expr) {
  const pts = series(sample, i);
  const first = pts.find((p) => p.v != null)?.v;
  if (Array.isArray(first)) fail(`"${expr}" is a vector (${JSON.stringify(first)}): pick one axis, e.g. ${expr}[0] or ${expr}[1]`);
  if (first != null && typeof first !== "number" && typeof first !== "boolean") fail(`"${expr}" is not a number (got ${JSON.stringify(first)})`);
  return pts;
}

/**
 * Run a state measure (jump | move | hitstop | curve) on an open session: its own scripted run from reset (ro =
 * { seed, scene, params, input }), the expressions from opt (y, x, of, vs, paths, key, up, from, to, time).
 * Returns { env, text }. Errors throw WitnessError (the CLI prints them; tests record them).
 */
export async function measureState(s, what, opt, ro) {
  const get = (k) => (opt[k] != null && opt[k] !== true ? String(opt[k]) : null);
  if (what === "jump") {
    const y = get("y") || get("of");
    if (!y) fail('usage: witness measure jump --y "state.player.pos[1]" --input "space@1" [--x "state.player.pos[0]"] [--up -1]');
    const x = get("x");
    const { fps, sample, spans, from, to } = await sampleOn(s, ro, opt, x ? [y, x] : [y], { defaultTail: 3 });
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
    if (!x) fail('usage: witness measure move --x "state.player.pos[0]" --input "right@1-2"');
    const { fps, sample, spans, from, to } = await sampleOn(s, ro, opt, [x], { defaultTail: 2 });
    const key = get("key");
    const span = spans.find((sp) => sp.f0 >= from && (!key || sp.label === key));
    if (!span) fail(key ? `no "${key}" press in --input` : "measure move needs a held input, e.g. --input \"right@1-2\"");
    const mv = analyzeMove(oneAxis(sample, 0, x), { press: span.f0, release: span.f1, fps });
    return reportMove(mv, { x, span, fps, from, to, opt });
  }
  if (what === "hitstop") {
    const paths = splitTop(get("paths") || get("of") || "");
    if (!paths.length) fail('usage: witness measure hitstop --paths "state.player.pos, state.enemy.pos" --input "right@0-2, j@1"');
    const { fps, sample, spans, from, to } = await sampleOn(s, ro, opt, paths, { defaultTail: 1.5 });
    const fr = frozenSpans(paths.map((_, i) => series(sample, i)));
    return reportHitstop(fr, { paths, spans, fps, from, to, opt });
  }
  // curve
  const of = get("of");
  if (!of) fail('usage: witness measure curve --of "state.camera.pos[0]" [--vs "state.player.pos[0]"] --input "right@1-3"');
  const vs = get("vs");
  const { fps, sample, spans, from, to } = await sampleOn(s, ro, opt, vs ? [of, vs] : [of], { defaultTail: 2 });
  const a = oneAxis(sample, 0, of), b = vs ? oneAxis(sample, 1, vs) : null;
  return reportCurve({ of, vs, a, b, fps, from, to, spans, opt });
}

function reportJump(j, { y, x, press, fps, from, to, opt }) {
  if (!j.ok) return { env: envelope("measure jump", { ok: false, verdict: `no jump found in ${y} over f${from}..f${to}: ${j.reason}`, data: j }), text: `✖ no jump found in ${y} over f${from}..f${to}: ${j.reason}` };
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
  const env = envelope("measure jump", {
    verdict: lines[0],
    summary: { apexPx: j.apex.height, apexAfter: j.apex.after, takeoffAfter: j.takeoff.after, airtimeFrames: j.airtime?.frames ?? null, airtimeSeconds: j.airtime?.seconds ?? null, hangFrames: j.hang.frames, riseFrames: j.rise.frames, fallFrames: j.fall?.frames ?? null, gravityRise: g.rise, gravityFall: g.fall, distance: j.distance ?? null },
    data: { ...j, expr: y, x, fps, from, to },
  });
  return { env, text: lines.join("\n") };
}

function reportMove(mv, { x, span, fps, from, to, opt }) {
  if (!mv.ok) return { env: envelope("measure move", { ok: false, verdict: `no movement found in ${x}: ${mv.reason}`, data: mv }), text: `✖ no movement found in ${x}: ${mv.reason}` };
  const dirWord = mv.dir > 0 ? "+" : "-";
  const lines = [`move (${span.label} held f${span.f0}..f${span.f1 ?? "end"}): top speed ${mv.top.perSecond} px/s (${mv.top.perFrame} px/f, ${dirWord}${x.replace(/^state\./, "")}) reached at +${mv.top.after}f — first moves +${mv.firstMove.after}f, accelerates over ${mv.top.accelFrames}f (${ms(mv.top.accelFrames, fps)})`];
  if (span.f1 != null) {
    if (mv.stop) lines.push(`  after release (f${span.f1}): ${mv.stop.after <= 0 && Math.abs(mv.stop.slide) < 1e-9 ? `stops at once (the release frame f${span.f1} doesn't move)` : `stops at +${mv.stop.after}f (f${mv.stop.f}, ${ms(mv.stop.after, fps)}) · slides ${mv.stop.slide} px`}${mv.stop.overshoot ? ` · overshoots and comes back ${mv.stop.overshoot} px` : " · no overshoot"}`);
    else lines.push(`  after release (f${span.f1}): still moving at the end of the run (f${to}) — add --time`);
  }
  const env = envelope("measure move", {
    verdict: lines[0],
    summary: { topSpeed: mv.top.perSecond, topSpeedPerFrame: mv.top.perFrame, reachedAfter: mv.top.after, accelFrames: mv.top.accelFrames, firstMoveAfter: mv.firstMove.after, stopAfter: mv.stop?.after ?? null, slide: mv.stop?.slide ?? null, overshoot: mv.stop?.overshoot ?? null },
    data: { ...mv, expr: x, fps, from, to, input: span },
  });
  return { env, text: lines.join("\n") };
}

function reportHitstop(fr, { paths, spans, fps, from, to, opt }) {
  const pauses = fr.filter((s) => s.bounded);
  const near = (s) => { const p = spans.filter((sp) => sp.f0 <= s.from).pop(); return p ? ` (+${s.from - p.f0}f after ${p.label} at f${p.f0})` : ""; };
  const lines = [pauses.length
    ? `hitstop: ${pauses.length} freeze${pauses.length === 1 ? "" : "s"} where ${paths.length === 1 ? paths[0] : `all ${paths.length} paths`} stop and then move again: ${pauses.map((s) => `f${s.from}–f${s.to} (${s.frames}f, ${ms(s.frames, fps)})${near(s)}`).join(", ")}`
    : `hitstop: no freeze between motion in f${from}..f${to} (${paths.join(", ")} never stop and resume together)`];
  const other = fr.filter((s) => !s.bounded && s.frames >= 2);
  if (other.length) lines.push(`  other still spans (not between motion): ${other.slice(0, 6).map((s) => `f${s.from}–f${s.to}${!s.afterMotion ? " (before moving)" : !s.resumed ? " (never resumed)" : ""}`).join(", ")}`);
  const env = envelope("measure hitstop", {
    verdict: lines[0],
    summary: { freezes: pauses.length, frames: pauses.map((s) => s.frames), first: pauses[0] ? { from: pauses[0].from, to: pauses[0].to, frames: pauses[0].frames } : null },
    data: { paths, spans: fr, fps, from, to },
  });
  return { env, text: lines.join("\n") };
}

function reportCurve({ of, vs, a, b, fps, from, to, spans, opt }) {
  const s = summarize(a);
  if (!s) fail(`"${of}" gave no numbers over f${from}..f${to}`);
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
  const env = envelope("measure curve", {
    verdict: lines[0],
    summary: { start: s.start.v, end: s.end.v, min: s.min.v, max: s.max.v, stepMin: s.step?.min.d ?? null, stepMax: s.step?.max.d ?? null, riseFrames: resp?.rise?.frames ?? null, settleFrame: resp?.settle.f ?? null, overshoot: resp?.overshoot.value ?? null, stutters: st.length, lag: lg ? lg.lag : null },
    data: { expr: of, vs, fps, from, to, summary: s, response: resp, holds: fz, stutters: st, lag: lg, settleAfter },
  });
  return { env, text: lines.join("\n") };
}
