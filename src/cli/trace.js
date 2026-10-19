// Witness CLI: trace — values over time (table + chart), and chart v2:
//   --compare <variant> / --against base.json   two runs on one chart (B − A deltas, first frame they differ)
//   --xy "state.player.pos"                      the path over the level, with start / end / death markers
//   --hist                                       how each value spread over the run (histograms)
import fs from "node:fs";
import path from "node:path";
import { begin, loadReplay } from "../core/runner.js";
import { fmt } from "../core/expr.js";
import { sampleExprs, frameGrid } from "../core/sample.js";
import { summarize } from "../core/signal.js";
import { die, say, withGame, runOpts, media, printLogs, splitTop, framesOf, fmtT, envelope, compactSeriesJSON, resolveReplay, emit, shotImage } from "./common.js";
import { parseNamedEvents, eventFrames, inputSpans, seriesLines, errorLines, chartSeriesOf } from "./ask.js";
import { parseVariant } from "./ab.js";

const tr = (x) => +(+x).toFixed(3);
const fv = (v) => fmt(typeof v === "number" ? tr(v) : v, 40);
const sg = (v) => (v > 0 ? `+${tr(v)}` : `${tr(v)}`);

// ------------------------------------------------------------------ helpers shared with heatmap

/** A position from a value: [x, y], {x, y} or something with .pos. */
export function posOf(v) {
  if (Array.isArray(v)) return v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number" && Number.isFinite(v[0]) && Number.isFinite(v[1]) ? [v[0], v[1]] : null;
  if (v && typeof v === "object") {
    if (Array.isArray(v.pos)) return posOf(v.pos);
    if (typeof v.x === "number" && typeof v.y === "number" && Number.isFinite(v.x) && Number.isFinite(v.y)) return [v.x, v.y];
  }
  return null;
}

/** The death flag a snapshot offers by convention (state.dead, state.player.dead), or null. */
export function autoDeathExpr(state) {
  if (state && typeof state.dead === "boolean") return "state.dead";
  if (state && state.player && typeof state.player.dead === "boolean") return "state.player.dead";
  return null;
}

/** The level behind a world plot: state.map (with a cell size) if the game has one. */
export function mapOf(state) {
  const m = state && state.map;
  if (!m || !Array.isArray(m.rows) || !m.rows.length || !m.rows.every((r) => typeof r === "string")) return null;
  return { cell: +(m.cell || 1), origin: Array.isArray(m.origin) ? m.origin.slice(0, 2).map(Number) : [0, 0], rows: m.rows, solid: String(m.solid ?? "#") };
}

/**
 * What to draw behind world positions: `--bg map|shot|none` (default: the map if there is one, else the screenshot
 * when its mapping is known (state.camera) or every point fits inside it as screen pixels). Returns
 * { map?, image?, note }.
 */
export async function backgroundFor(s, snap, points, bg, frame) {
  const want = bg && bg !== true ? String(bg) : "auto";
  if (!["auto", "map", "shot", "none"].includes(want)) die(`--bg is map, shot or none (got ${bg})`);
  if (want === "none") return { note: "" };
  const map = mapOf(snap && snap.state);
  if (map && want !== "shot") return { map, note: `background: state.map, ${Math.max(...map.rows.map((r) => r.length))}×${map.rows.length} cells of ${map.cell}`, short: "background: state.map" };
  if (want === "map") return { note: "no state.map in the snapshot: plain axes" };
  if (!s.has("screenshot")) return { note: "" };
  const img = await shotImage(await s.screenshot());
  const c = snap && snap.state && snap.state.camera;
  let scale = 1, ox = 0, oy = 0, how = "state units as screen pixels";
  if (c && Array.isArray(c.pos)) { scale = Number.isFinite(+c.zoom) && +c.zoom > 0 ? +c.zoom : 1; ox = -c.pos[0] * scale; oy = -c.pos[1] * scale; how = "placed by state.camera"; }
  else if (want === "auto" && !points.every((p) => p[0] >= 0 && p[1] >= 0 && p[0] <= img.width && p[1] <= img.height)) return { note: "" };
  const image = { img: { width: img.width, height: img.height, data: Uint8Array.from(img.data) }, x0: -ox / scale, y0: -oy / scale, x1: (img.width - ox) / scale, y1: (img.height - oy) / scale };
  return { image, note: `background: the screenshot at f${frame}, ${how} (--bg none hides it)`, short: `background: the screenshot at f${frame}, ${how}` };
}

/**
 * The path's time dots: for each k*tickEvery (k >= 1) the first sample at or after it, within half a tick (samples
 * every --every frames rarely land on the exact frame). Never the last point (it has the end marker).
 */
export function tickPoints(points, tickEvery) {
  const out = [];
  if (!points.length) return out;
  const lastF = points[points.length - 1][2];
  let j = 0;
  for (let t = tickEvery; t < lastF; t += tickEvery) {
    while (j < points.length && points[j][2] < t) j++;
    if (j >= points.length) break;
    const q = points[j];
    if (q[2] - t <= tickEvery / 2 && q[2] !== lastF && (!out.length || out[out.length - 1] !== q)) out.push(q);
  }
  return out;
}

/** A colour mixed 45% towards white (the A / "before" run of an overlay). */
const lighten = (hex) => { const h = String(hex).replace("#", ""); return `#${[0, 2, 4].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) * 0.55 + 255 * 0.45).toString(16).padStart(2, "0")).join("")}`; };

const DEATHY = /^(death|deaths|die|died|dead|killed|ko)$/i;

// ------------------------------------------------------------------ runs

/** Plan shared by every run of one trace: fps, frames to sample, the replays each side uses. */
function makePlan(s, cfg, root, opt, A, B) {
  const fps = s.fps;
  const repOf = (v) => (v && v.replay ? loadReplay(path.resolve(String(v.replay))) : opt.replay ? loadReplay(resolveReplay(opt.replay, cfg, root)) : null);
  const repA = repOf(A), repB = B ? repOf(B) : null;
  const reps = [repA, repB].filter(Boolean);
  const timeGiven = opt.time && opt.time !== true;
  const endF = timeGiven ? framesOf(String(opt.time), fps, repA ? repA.dts : null) : reps.length ? Math.min(...reps.map((r) => r.frames)) : framesOf("5", fps);
  const every = opt.every && opt.every !== true ? Math.max(1, framesOf(String(opt.every), fps)) : Math.max(1, Math.ceil(endF / 600));
  if (repA && repB && repA.frames !== repB.frames && !timeGiven) say(`(the replays are ${repA.frames} and ${repB.frames} frames long: compared over the first ${endF})`);
  return { fps, endF, every, frames: frameGrid(0, endF, every), repA, repB };
}

/** One run: sample the expressions (+ events, xy, deaths) on the plan's frames. */
async function runOnce(s, cfg, opt, v, plan, side, q) {
  const ro = runOpts(opt, cfg);
  const replay = side === "B" ? plan.repB : plan.repA;
  const run = { seed: v && v.seed !== undefined ? v.seed : ro.seed, scene: v && v.scene !== undefined ? v.scene : ro.scene, params: v && v.params ? { ...(ro.params || {}), ...v.params } : ro.params, input: [ro.input, v && v.input].filter(Boolean).join(", ") || undefined, replay };
  const st = await begin(s, run);
  const first = await s.snapshot();
  const deathExpr = q.xy ? (q.deaths || autoDeathExpr(first.state)) : null;
  const all = [...q.exprs, ...q.named.map((n) => n.expr), ...(q.xy ? [q.xy] : []), ...(deathExpr ? [deathExpr] : [])];
  let last = null;
  const sample = await sampleExprs(s, st, all, plan.frames, { dts: st.dts, onFrame: (snap) => { last = snap; } });
  printLogs(await s.drainLogs());
  const n = q.exprs.length, k = q.named.length;
  const main = { ...sample, values: sample.values.slice(0, n), errors: sample.errors.slice(0, n), missing: sample.missing.slice(0, n) };
  const evs = k ? eventFrames(q.named, { ...sample, values: sample.values.slice(n, n + k) }) : [];
  let xy = null;
  if (q.xy) {
    const vals = sample.values[n + k];
    const pts = [];
    sample.frames.forEach((f, i) => { const p = posOf(vals[i]); if (p) pts.push([p[0], p[1], f]); });
    const dvals = deathExpr ? sample.values[n + k + 1] : null;
    const deaths = deathExpr ? eventFrames([{ name: "death", expr: deathExpr }], { ...sample, values: [dvals] }).map((d) => deathAt(sample.frames, vals, d)) : [];
    const evPts = evs.map((e) => { const w = lastPos(sample.frames, vals, sample.frames.indexOf(e.f)); return { ...e, pos: w ? w.pos : null }; });
    xy = { points: pts, deaths, deathExpr, events: evPts, breakAt: respawnFrames(sample.frames, vals, dvals), error: sample.errors[n + k], bad: vals.filter((x) => x != null && !posOf(x)).length, sampleOf: vals.find((x) => x != null) };
    if (q.wantBg && side === "A") xy.bg = await backgroundFor(s, last, pts, opt.bg, plan.endF);
  }
  const label = v && v.replay !== undefined && v.label.trim() === `replay=${v.replay}` ? `replay ${path.basename(String(v.replay))}` : v ? v.label : replay ? `replay ${path.basename(replay.file)}` : "(as given)";
  return { label, main, evs, xy, replay, input: run.input, last };
}

/** The last position at or before sample i (games often null or remove the player while dead): { pos, f } or null. */
export function lastPos(frames, vals, i) {
  for (let j = Math.min(i, vals.length - 1); j >= 0; j--) { const p = posOf(vals[j]); if (p) return { pos: p, f: frames[j] }; }
  return null;
}

/** A death event with its position: the one at its frame, else the last one seen before it (seenAt), else null. */
export function deathAt(frames, vals, d) {
  const w = lastPos(frames, vals, frames.indexOf(d.f));
  return { f: d.f, t: tr(d.t), pos: w ? w.pos : null, ...(w && w.f !== d.f ? { seenAt: w.f } : {}) };
}

/**
 * Frames where the path resumes after the death flag was on (respawns): the first position sampled alive after a
 * dead sample. The step into such a frame is a teleport, not distance walked.
 */
export function respawnFrames(frames, vals, dvals) {
  if (!dvals) return [];
  const out = [];
  let deadSince = false;
  frames.forEach((f, i) => {
    const dead = !!dvals[i], p = posOf(vals[i]);
    if (p && !dead) { if (deadSince) out.push(f); deadSince = false; }
    if (dead) deadSince = true;
  });
  return out;
}

/** A run rebuilt from a saved trace (--save), aligned to frames. */
function loadSaved(file, exprs) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")); } catch (e) { die(`--against ${file}: ${e.message}`); }
  if (!j || j.command !== "trace" || !j.data || !j.data.series) die(`--against ${file}: not a saved trace (make one with 'witness trace ... --save ${file}')`);
  const missing = exprs.filter((x) => !(x in j.data.series));
  if (missing.length) die(`--against ${file}: it has no series for ${missing.join(", ")} (it has: ${Object.keys(j.data.series).join(", ")})`);
  const byF = exprs.map((x) => new Map(j.data.series[x].map((p) => [p[2], p[1]])));
  const xy = j.data.xy && j.data.xy.runs && j.data.xy.runs[0] ? { points: j.data.xy.runs[0].points || [], deaths: j.data.xy.runs[0].deaths || [], breakAt: j.data.xy.runs[0].breakAt || [], events: [] } : { points: [], deaths: [], events: [], saved: true };
  return { label: `before (${path.basename(file)})`, byF, xy, fps: j.data.fps, every: j.data.every, saved: j };
}

// ------------------------------------------------------------------ comparing two runs

/** Per-axis numeric views of the sampled values: [{ label, expr, vals }]. */
function flatSeries(exprs, main) {
  const out = [];
  exprs.forEach((x, i) => {
    const vals = main.values[i], first = vals.find((v) => v != null);
    if (Array.isArray(first) && first.length && first.length <= 4 && first.every((v) => typeof v === "number")) ["x", "y", "z", "w"].slice(0, first.length).forEach((ax, k) => out.push({ label: `${x}.${ax}`, expr: x, vals: vals.map((v) => (Array.isArray(v) ? v[k] : null)) }));
    else out.push({ label: x, expr: x, vals });
  });
  return out;
}

/** How series b differs from series a on the same frames. */
export function compareSeries(frames, a, b) {
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  const numeric = a.some(num) || b.some(num);
  let first = null, differ = 0, maxGap = null;
  for (let i = 0; i < frames.length; i++) {
    const x = a[i], y = b[i];
    const same = num(x) && num(y) ? Math.abs(x - y) <= 1e-9 : JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
    if (!same) { differ++; if (!first) first = { f: frames[i], a: x ?? null, b: y ?? null }; }
    if (num(x) && num(y) && (!maxGap || Math.abs(y - x) > Math.abs(maxGap.d))) maxGap = { f: frames[i], d: y - x };
  }
  const res = { samples: frames.length, differ, first };
  if (numeric) {
    const sa = summarize(frames.map((f, i) => ({ f, v: a[i] }))), sb = summarize(frames.map((f, i) => ({ f, v: b[i] })));
    const pick = (s) => (s ? { start: s.start.v, end: s.end.v, min: s.min.v, minFrame: s.min.f, max: s.max.v, maxFrame: s.max.f } : null);
    res.a = pick(sa); res.b = pick(sb);
    if (sa && sb) res.delta = { start: tr(sb.start.v - sa.start.v), end: tr(sb.end.v - sa.end.v), min: tr(sb.min.v - sa.min.v), max: tr(sb.max.v - sa.max.v) };
    res.maxGap = maxGap && Math.abs(maxGap.d) > 1e-9 ? { f: maxGap.f, d: tr(maxGap.d) } : null;
  }
  return res;
}

function compareLine(label, c, fps) {
  if (!c.differ) return `  ${label}: identical on all ${c.samples} samples`;
  const at = c.first ? ` · first differs at f${c.first.f} (${fmtT(c.first.f / fps)}): ${fv(c.first.a)} vs ${fv(c.first.b)}` : "";
  if (c.a && c.b) {
    const rng = (s) => `${fv(s.start)} → ${fv(s.end)} (min ${fv(s.min)} @f${s.minFrame}, max ${fv(s.max)} @f${s.maxFrame})`;
    const d = c.delta;
    const ds = [d.start ? `start ${sg(d.start)}` : "", `end ${sg(d.end)}`, d.min ? `min ${sg(d.min)}` : "", d.max ? `max ${sg(d.max)}` : ""].filter(Boolean).join(", ");
    return `  ${label}: A ${rng(c.a)} · B ${rng(c.b)} · B − A: ${ds}${at}${c.maxGap ? ` · largest gap ${sg(c.maxGap.d)} @f${c.maxGap.f}` : ""}`;
  }
  return `  ${label}: differs on ${c.differ} of ${c.samples} samples${at}`;
}

// ------------------------------------------------------------------ the command

export async function traceCommand(pos, opt) {
  const xyExpr = opt.xy && opt.xy !== true ? String(opt.xy) : null;
  if ((!opt.watch || opt.watch === true) && !xyExpr) die('usage: witness trace --watch "state.player.pos[1], state.score" [--time 5] [--every 1f] [--compare VAR=1 | --against base.json] [--xy "state.player.pos"] [--hist]');
  if (opt.compare && opt.against) die("use --compare or --against, not both");
  const exprs = opt.watch && opt.watch !== true ? splitTop(String(opt.watch)) : [];
  const named = parseNamedEvents(opt.events);
  const A = opt.a && opt.a !== true ? parseVariant(opt.a, "a") : null;
  const B = opt.compare ? parseVariant(opt.compare === true ? "" : opt.compare, "compare") : null;
  if (B && !opt.a && B.label === "(baseline)") die('--compare wants a variant: KEY=VALUE items joined by ";" (e.g. LIFT=1, params={"big":true}, seed=3, input=j@1, replay=b.jsonl)');
  const q = { exprs, named, xy: xyExpr, deaths: opt.deaths && opt.deaths !== true ? String(opt.deaths) : null, wantBg: !!xyExpr };
  const separate = B && [A, B].some((v) => v && (Object.keys(v.env).length || v.cmd !== undefined));
  let plan = null, runs = [], shots = null, name = "game";
  const go = async (s, cfg, root, v, side) => {
    if (!plan) { plan = makePlan(s, cfg, root, opt, A, B); shots = path.join(root, cfg.shots); name = s.hello.name; }
    else if (s.fps !== plan.fps) die(`A runs at ${plan.fps} fps and B at ${s.fps}: they can't be compared frame by frame`);
    runs.push(await runOnce(s, cfg, opt, v, plan, side, q));
  };
  const withVariant = (v, fn) => withGame({ ...opt, cmd: v && v.cmd !== undefined ? v.cmd : opt.cmd, __env: v ? v.env : undefined }, fn);
  if (separate) {
    await withVariant(A, (s, cfg, root) => go(s, cfg, root, A, "A"));
    await withVariant(B, (s, cfg, root) => go(s, cfg, root, B, "B"));
  } else {
    await withVariant(A, async (s, cfg, root) => { await go(s, cfg, root, A, "A"); if (B) await go(s, cfg, root, B, "B"); });
  }
  const { fps, endF, every } = plan;
  const frames = runs[0].main.frames, times = runs[0].main.times;

  // --against: the saved run is A (before), this run is B (now)
  let saved = null;
  if (opt.against) {
    saved = loadSaved(String(opt.against), exprs);
    if (saved.fps && saved.fps !== fps) die(`--against: the saved trace ran at ${saved.fps} fps, this one at ${fps}`);
    const now = runs[0];
    const before = { label: saved.label, main: { ...now.main, values: saved.byF.map((m) => frames.map((f) => (m.has(f) ? m.get(f) : null))), errors: exprs.map(() => null), missing: exprs.map(() => 0) }, evs: [], xy: saved.xy };
    now.label = "now";
    runs = [before, now];
    const common = frames.filter((f) => saved.byF[0] && saved.byF[0].has(f)).length;
    if (exprs.length && common < frames.length) say(`(the saved trace has ${common} of these ${frames.length} frames: the others count as missing)`);
  }
  const two = runs.length === 2;
  const [RA, RB] = runs;

  // ---- comparisons
  const comps = two ? (() => {
    const fa = flatSeries(exprs, RA.main), fb = flatSeries(exprs, RB.main);
    const out = fa.map((s, i) => ({ label: s.label, expr: s.expr, ...compareSeries(frames, s.vals, (fb.find((x) => x.label === s.label) || fb[i] || { vals: [] }).vals) }));
    // --xy: its position per axis is compared too (unless --watch already has the same expression)
    if (xyExpr && !exprs.includes(xyExpr)) {
      const at = (r) => { const m2 = new Map(((r.xy && r.xy.points) || []).map((p) => [p[2], p])); return frames.map((f) => m2.get(f) || null); };
      const pa = at(RA), pb = at(RB);
      const same = (u, v) => u.length === v.length && u.every((x, i) => x === v[i]);
      ["x", "y"].forEach((ax, k) => { const va = pa.map((p) => (p ? p[k] : null)), vb = pb.map((p) => (p ? p[k] : null)); if (!fa.some((sa, i) => same(sa.vals, va) && fb[i] && same(fb[i].vals, vb))) out.push({ label: `${xyExpr}.${ax}`, expr: xyExpr, ...compareSeries(frames, va, vb) }); });
    }
    return out;
  })() : [];

  // ---- pictures
  const files = [];
  const outFile = path.resolve(opt.out && opt.out !== true ? String(opt.out) : path.join(shots, "trace.png"));
  const sibling = (suffix) => outFile.replace(/(\.png)?$/i, `-${suffix}.png`);
  let m = null;
  const labelAB = (r, i) => (two ? (i === 0 ? `A ${RA.label}` : `B ${RB.label}`) : "");
  if (!opt["no-chart"]) m = await media();
  if (m && exprs.length) {
    try {
      const markers = [...(RA.replay ? RA.replay.marks : []), ...runs.flatMap((r, i) => r.evs.map((e) => ({ t: e.t, label: two ? `${e.name} (${i ? "B" : "A"})` : e.name, color: i ? "#ff9f43" : "#ffd166" })))];
      const inputs = inputSpans(runOpts(opt, { seed: 1 }).input, fps).map((sp) => ({ label: sp.label, t0: sp.f0 / fps, t1: (sp.f1 ?? endF) / fps }));
      // a variant's own input (input=...) gets its own rows, marked with its side
      [[A, "A"], [B, "B"]].forEach(([v, side]) => { if (v && v.input) for (const sp of inputSpans(v.input, fps)) inputs.push({ label: `${sp.label} (${side})`, t0: sp.f0 / fps, t1: (sp.f1 ?? endF) / fps }); });
      let series = chartSeriesOf(exprs, RA.main);
      if (two) {
        const sb = chartSeriesOf(exprs, RB.main);
        const COL = m.CHART_COLORS;
        series = series.flatMap((s, i) => [
          { ...s, label: `${s.label} (A)`, lane: s.label, color: lighten(COL[i % COL.length]), dash: true },
          { ...(sb.find((x) => x.label === s.label) || sb[i]), label: `${s.label} (B)`, lane: s.label, color: COL[i % COL.length] },
        ]);
      }
      const title = `${name}: ${exprs.join(", ")}`;
      const subtitle = two ? `A dashed: ${RA.label}  ·  B solid: ${RB.label}` : undefined;
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, m.lineChart({ title, subtitle, series, markers, inputs, fps }));
      files.push(outFile);
    } catch (e) { say(`(no chart: ${e.message})`); }
  }

  // ---- xy
  let xyOut = null;
  if (xyExpr) {
    const per = runs.map((r, i) => ({ label: two ? labelAB(r, i) : xyExpr, xy: r.xy || { points: [], deaths: [], events: [] } }));
    const pm = m || await media();   // the numbers don't need the picture (--no-chart)
    const stats = per.map((p) => pm.pathStats(p.xy.points, { breakAt: p.xy.breakAt || [] }));
    if (m) {
      const mk = [];
      per.forEach((p, i) => {
        const pts = p.xy.points, tag = two ? (i ? " B" : " A") : "";
        if (!pts.length) return;
        mk.push({ x: pts[0][0], y: pts[0][1], kind: "start", label: `start${tag} f${pts[0][2]}` });
        mk.push({ x: pts.at(-1)[0], y: pts.at(-1)[1], kind: "end", label: `end${tag} f${pts.at(-1)[2]}` });
        for (const d of p.xy.deaths) if (d.pos) mk.push({ x: d.pos[0], y: d.pos[1], kind: "death", label: `death${tag} f${d.f}` });
        for (const e of p.xy.events || []) if (e.pos) mk.push({ x: e.pos[0], y: e.pos[1], kind: DEATHY.test(e.name) ? "death" : "event", label: `${e.name}${tag} f${e.f}` });
      });
      // a dot every second on each path (labelled when there are few)
      const tickEvery = Math.max(1, Math.round(fps * Math.max(1, Math.ceil(endF / fps / 12))));
      const COL = m.CHART_COLORS;
      const paths = per.map((p, i) => ({
        label: p.label, points: p.xy.points, breakAt: p.xy.breakAt || [], color: two ? (i ? COL[0] : "#c9d3ff") : COL[0], dash: two && i === 0,
        ticks: tickPoints(p.xy.points, tickEvery).map((q) => ({ x: q[0], y: q[1], label: i === 0 || !two ? `${tr(q[2] / fps)}s` : "" })),
      }));
      const live = runs.find((r) => r.xy && r.xy.bg) || runs.find((r) => r.xy && r.xy.deathExpr) || RA;
      const bg = live.xy && live.xy.bg ? live.xy.bg : { note: "" };
      const deathNote = live.xy && live.xy.deathExpr ? `deaths: ${live.xy.deathExpr}${q.deaths ? "" : " (found in the snapshot; --deaths to choose)"}` : "";
      const spec = { title: `${name}: ${xyExpr}`, subtitle: two ? `A dashed: ${RA.label} · B solid: ${RB.label}` : `f0..f${endF} · dots every ${tr(tickEvery / fps)}s${tickEvery % every ? " (the nearest sample)" : ""}`, map: bg.map, image: bg.image, paths, markers: mk, yUp: !!opt["y-up"], notes: [bg.note, deathNote].filter(Boolean) };
      xyOut = sibling("xy");
      fs.mkdirSync(path.dirname(xyOut), { recursive: true });
      fs.writeFileSync(xyOut, m.worldPNG(spec));
      files.push(xyOut);
    }
    const withBg = runs.find((r) => r.xy && r.xy.bg);
    q.xyResult = { per, stats, bgNote: withBg ? withBg.xy.bg.short || withBg.xy.bg.note : "" };
  }

  // ---- histograms
  let hists = null;
  if (opt.hist) {
    const mm = m || await media();
    const fa = flatSeries(exprs, RA.main), fb = two ? flatSeries(exprs, RB.main) : null;
    const bins = opt.bins && opt.bins !== true ? Math.max(2, Math.min(200, +opt.bins)) : 20;
    hists = fa.map((s, i) => {
      const sets = [s.vals, ...(fb ? [(fb.find((x) => x.label === s.label) || fb[i]).vals] : [])];
      const numericish = sets[0].some((v) => typeof v === "number" || typeof v === "boolean");
      const bool = sets.every((vals) => vals.every((v) => v == null || typeof v === "boolean"));
      return { label: s.label, bool, hs: numericish ? mm.sharedHistograms(sets, { bins }) : null };
    }).filter((h) => h.hs && h.hs[0].n + (h.hs[1] ? h.hs[1].n : 0) > 0);
    if (hists.length && !opt["no-chart"]) {
      const panels = hists.slice(0, 8).map((h) => ({ label: h.label, bool: h.bool, series: h.hs.map((x, i) => ({ label: two ? (i ? "B" : "A") : h.label, hist: x, color: two ? (i ? mm.CHART_COLORS[0] : "#c9d3ff") : mm.CHART_COLORS[0], dash: two && i === 0 })) }));
      const histOut = sibling("hist");
      fs.mkdirSync(path.dirname(histOut), { recursive: true });
      fs.writeFileSync(histOut, mm.histPNG({ title: `${name}: how values spread`, subtitle: `${frames.length} samples, f0..f${endF}${every > 1 ? `, every ${every} frames` : ""}${two ? ` · A ${RA.label} · B ${RB.label}` : ""}`, panels }));
      files.push(histOut);
    }
  }

  // ---- result
  // per series (vectors per axis: "state.player.pos.x"): start/end/min/max with frames; a failing expression: its error
  const sumOf = (main) => {
    const out = {};
    for (const fs2 of flatSeries(exprs, main)) {
      const sm = summarize(main.frames.map((f, k) => ({ f, v: fs2.vals[k] })));
      const i = exprs.indexOf(fs2.expr);
      out[fs2.label] = sm ? { start: sm.start.v, end: sm.end.v, min: sm.min.v, minFrame: sm.min.f, max: sm.max.v, maxFrame: sm.max.f } : { error: main.errors[i] ? main.errors[i].message : null };
    }
    return out;
  };
  let summary = two ? { a: sumOf(RA.main), b: sumOf(RB.main) } : sumOf(RA.main);
  const data = { fps, every, events: RA.evs, errors: errorLines(exprs, RA.main), series: "__SERIES__" };
  let verdict = `${frames.length} samples, f0..f${endF}`;
  const lines = [`${frames.length} samples, f0..f${endF} (${fmtT(endF / fps)})${every > 1 ? `, every ${every} frames` : ", every frame"}`];
  for (const l of errorLines(exprs, RA.main)) lines.push(l);
  if (two) {
    const differs = comps.filter((c) => c.differ).length;
    const firstDiff = comps.filter((c) => c.first).map((c) => c.first.f).sort((a, b) => a - b)[0] ?? null;
    summary = { ...summary, differs, firstDiffFrame: firstDiff, deltas: Object.fromEntries(comps.filter((c) => c.delta).map((c) => [c.label, c.delta])) };
    data.compare = { a: RA.label, b: RB.label, series: Object.fromEntries(comps.map(({ label, expr, ...c }) => [label, c])) };
    data.seriesB = "__SERIESB__";
    verdict = differs ? `${differs} of ${comps.length} series differ, first at f${firstDiff}` : comps.length ? `A and B identical on all ${comps.length} series` : "nothing to compare (no numeric series)";
    lines.push(`compare: A = ${RA.label} · B = ${RB.label}${separate ? " (two game processes)" : ""}`);
    for (const c of comps) lines.push(compareLine(c.label, c, fps));
  } else {
    exprs.forEach((x, i) => { if (!RA.main.errors[i] || RA.main.errors[i].count < frames.length) for (const l of seriesLines(x, frames, RA.main.values[i], fps)) lines.push(l); });
  }
  runs.forEach((r, i) => { if (r.evs && r.evs.length) lines.push(`  events${two ? ` (${i ? "B" : "A"})` : ""}: ${r.evs.slice(0, 12).map((e) => `${e.name} @f${e.f}`).join(", ")}${r.evs.length > 12 ? ", …" : ""}`); });
  if (xyExpr) {
    const { per, stats } = q.xyResult;
    const xyData = { expr: xyExpr, background: q.xyResult.bgNote || null, runs: [] };
    per.forEach((p, i) => {
      const s = stats[i], tag = two ? `${i ? "B" : "A"} ` : "";
      if (!s) {
        const X = runs[i].xy;
        const why = X && X.error ? X.error.message : X && X.sampleOf != null ? `got ${fmt(X.sampleOf, 40)}, not a position [x, y] or {x, y}` : X && X.saved ? "the saved trace has no xy path" : "no samples";
        lines.push(`✖ xy ${xyExpr}${two ? ` (${i ? "B" : "A"})` : ""}: ${why}`);
        xyData.runs.push({ label: p.label, points: [], deaths: [] });
        return;
      }
      const pt = (q2) => `(${tr(q2[0])}, ${tr(q2[1])})`;
      const jumps = s.jumps.length ? ` (${s.jumps.length} teleport${s.jumps.length === 1 ? "" : "s"} left out: ${s.jumps.slice(0, 4).map((j) => `f${j.f}`).join(", ")}${s.jumps.length > 4 ? ", …" : ""})` : "";
      lines.push(`xy ${tag}${xyExpr}: ${pt(s.start)} f${s.start[2]} → ${pt(s.end)} f${s.end[2]} · path ${tr(s.length)}${jumps} over ${s.samples} samples · x ${tr(s.bounds.x0)}..${tr(s.bounds.x1)}, y ${tr(s.bounds.y0)}..${tr(s.bounds.y1)} · net (${sg(s.net[0])}, ${sg(s.net[1])})`);
      if (p.xy.deaths.length) lines.push(`  deaths${p.xy.deathExpr ? ` (${p.xy.deathExpr})` : ""}: ${p.xy.deaths.slice(0, 10).map((d) => (d.pos ? `f${d.f} at ${pt(d.pos)}${d.seenAt != null ? ` (last seen f${d.seenAt})` : ""}` : `f${d.f} (no position)`)).join(", ")}${p.xy.deaths.length > 10 ? ", …" : ""}`);
      else if (p.xy.deathExpr) lines.push(`  deaths (${p.xy.deathExpr}): none`);
      xyData.runs.push({ label: p.label, length: tr(s.length), start: s.start.slice(0, 2), end: s.end.slice(0, 2), bounds: s.bounds, net: s.net.map(tr), deaths: p.xy.deaths, jumps: s.jumps.map((j) => ({ f: j.f, from: j.from.map(tr), to: j.to.map(tr) })), breakAt: p.xy.breakAt || [], points: "__XY" + i + "__" });
    });
    if (two && stats[0] && stats[1]) lines.push(`  end B − A: (${sg(stats[1].end[0] - stats[0].end[0])}, ${sg(stats[1].end[1] - stats[0].end[1])}) · path length ${sg(stats[1].length - stats[0].length)}`);
    if (xyOut) lines.push(`xy → ${xyOut}${q.xyResult.bgNote ? `  (${q.xyResult.bgNote})` : ""}`);
    const s0 = stats[two ? 1 : 0] || stats[0];
    summary = { ...summary, xy: s0 ? { length: tr(s0.length), end: s0.end.slice(0, 2).map(tr), net: s0.net.map(tr), deaths: per[two ? 1 : 0].xy.deaths.length } : null };
    data.xy = xyData;
  }
  if (hists) {
    const hs = {};
    for (const h of hists) {
      const one = (x) => (x.stats ? { n: x.n, mean: tr(x.stats.mean), median: tr(x.stats.median), p5: tr(x.stats.p5), p95: tr(x.stats.p95), min: x.stats.min, max: x.stats.max, mode: x.mode ? [x.mode.x0, x.mode.x1] : null } : { n: 0 });
      const line = (x, tag) => {
        if (!x.stats) return `hist ${h.label}${tag}: no numbers`;
        const mid = x.integer ? `${Math.round((x.mode.x0 + x.mode.x1) / 2)}` : `${tr(x.mode.x0)}..${tr(x.mode.x1)}`;
        return `hist ${h.label}${tag}: n ${x.n} · mean ${tr(x.stats.mean)} · median ${tr(x.stats.median)} · p5 ${tr(x.stats.p5)} · p95 ${tr(x.stats.p95)} · min ${tr(x.stats.min)} · max ${tr(x.stats.max)} · most common ${mid} (${x.mode.count} samples, ${Math.round((100 * x.mode.count) / x.n)}%)`;
      };
      lines.push(line(h.hs[0], two ? " (A)" : ""));
      if (two) { lines.push(line(h.hs[1], " (B)")); if (h.hs[0].stats && h.hs[1].stats) lines.push(`  B − A: mean ${sg(h.hs[1].stats.mean - h.hs[0].stats.mean)} · median ${sg(h.hs[1].stats.median - h.hs[0].stats.median)} · p95 ${sg(h.hs[1].stats.p95 - h.hs[0].stats.p95)}`); }
      hs[h.label] = two ? { a: one(h.hs[0]), b: one(h.hs[1]) } : one(h.hs[0]);
    }
    if (every > 1) lines.push(`  (histograms count samples: one every ${every} frames)`);
    summary = { ...summary, hist: hs };
    data.hist = hists.map((h) => ({ label: h.label, bins: h.hs.map((x) => x.bins.map((b) => [b.x0, b.x1, b.count])) }));
  }
  const chartFile = files.find((f) => f === outFile);
  if (chartFile) lines.push(`chart → ${chartFile}  (view it with your image tool)`);
  const histFile = files.find((f) => /-hist\.png$/.test(f));
  if (histFile) lines.push(`hist → ${histFile}`);

  const env = envelope("trace", { verdict, summary, data, files });
  const seriesObj = (main) => Object.fromEntries(exprs.map((x, i) => [x, main.frames.map((f, k) => [tr(main.times[k]), main.values[i][k], f])]));
  const indent = (s) => s.split("\n").map((l, j) => (j ? `  ${l}` : l)).join("\n");
  const toText = (e) => {
    let t = JSON.stringify(e, null, 1).replace('"__SERIES__"', indent(compactSeriesJSON(seriesObj(RA.main))));
    if (two) t = t.replace('"__SERIESB__"', indent(compactSeriesJSON(seriesObj(RB.main))));
    if (xyExpr) q.xyResult.per.forEach((p, i) => { t = t.replace(`"__XY${i}__"`, indent(compactSeriesJSON({ p: p.xy.points.map((v) => [tr(v[0]), tr(v[1]), v[2]]) })).replace(/^\{\n\s*"p": /, "").replace(/\n\s*\}$/, "")); });
    return t;
  };
  if (opt.save && opt.save !== true) {
    const f = path.resolve(String(opt.save));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    let text = toText(env);
    if (saved) {
      // --against: A is the loaded baseline; the file gets this run (B) as a plain single-run trace
      const d = { ...data, events: RB.evs, errors: errorLines(exprs, RB.main), series: "__SERIESNOW__" };
      delete d.compare; delete d.seriesB;
      if (d.xy) d.xy = { ...d.xy, runs: d.xy.runs.slice(1) };
      const one = envelope("trace", { verdict: `${frames.length} samples, f0..f${endF}`, summary: { ...summary.b, ...(summary.xy ? { xy: summary.xy } : {}) }, data: d, files });
      text = toText(one).replace('"__SERIESNOW__"', indent(compactSeriesJSON(seriesObj(RB.main))));
    }
    fs.writeFileSync(f, text);
    lines.push(`saved → ${f}  (compare a later run with --against ${path.basename(f)})`);
  }
  void times;
  emit(env, lines.join("\n"), opt, { json: (e) => { console.log(toText(e)); for (const l of errorLines(exprs, RA.main)) console.error(l); } });
}
