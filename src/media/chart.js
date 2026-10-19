// Witness media: line charts as PNG (for `witness trace`), ported from Lumen's chart.js.
//
//   lineChart(spec)   -> PNG Buffer
//   renderChart(spec) -> Raster (to composite further)
//
// spec = { title, series: [{ label, points: [[t, value], ...], color?, step?, dash?, lane? }],
//          width: 1280, height: 640, markers?: [{ t, label, color? }], subtitle?,
//          inputs?: [{ label, t0, t1 }] (held inputs: one row per label under the plot, a tick line at each press),
//          fps? (names frames on the time axis) }
// dash: true draws the line dashed (the "B" / "before" run of an overlay); series with the same `lane` key always
// share one lane and value axis (an overlay of two runs of the same expression).
//
// Dark style: one time axis in seconds shared by all series, gridlines, a legend with each
// series' final value, and dashed marker lines (e.g. replay F8 marks). Series whose value
// ranges differ a lot (more than ~6x in span, or far apart in level) get their own lane
// with their own value axis, so a 0..1 flag and a 0..900 position are both readable;
// similar series share a lane.
// Values: numbers plot as lines; booleans as 0/1 steps (axis labelled false/true);
// null, undefined, NaN, ±Infinity and non-numeric strings leave a gap in the line. A series with no
// numeric sample at all stays in the legend as "no data" (so a typo in an expression is visible).

import { Raster } from "./raster.js";

export const COLORS = ["#4cc9f0", "#ff4d8d", "#ffd166", "#3ddc97", "#a78bfa", "#ff9f43", "#8ecae6", "#f15bb5"];
const BG = "#0b1020", PANEL = "#111833", TEXT = "#e6ebff", DIM = "#8b93b8", GRID = "rgba(255,255,255,0.07)";
const FRAME = "rgba(255,255,255,0.16)", MARK = "rgba(255,90,120,0.9)";
const MIN_LANE_H = 72, MIN_BOOL_LANE_H = 48, INSET = 10;

/** A "nice" tick step (1, 2, 2.5, 5 x 10^k) giving about `n` ticks over `span`. */
export function niceStep(span, n) {
  if (!(span > 0)) return 1;
  const raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/** A nice step for about `n` ticks in [lo, hi], refined until at least 3 land inside (room permitting). */
function tickStep(lo, hi, n, maxTicks) {
  let step = niceStep(hi - lo, n);
  const count = (st) => Math.floor(hi / st + 1e-9) - Math.ceil(lo / st - 1e-9) + 1;
  for (let i = 0; i < 4 && count(step) < 3; i++) {
    const p = Math.pow(10, Math.floor(Math.log10(step) + 1e-9)), m = Math.round((step / p) * 10) / 10;
    const next = (m === 1 ? 0.5 : m === 2 ? 1 : m === 2.5 ? 2 : 2.5) * p;
    if (count(next) > maxTicks) break;
    step = next;
  }
  return step;
}

/**
 * A tick value with as many decimals as the step needs. `ref` (the largest magnitude on the
 * axis) picks one unit for the whole axis: k from 10 000, M from 1 000 000.
 */
export function fmtTick(v, step, ref = Math.abs(v)) {
  if (Math.abs(v) < step * 1e-6) v = 0;
  const unit = ref >= 1e6 ? 1e6 : ref >= 1e4 ? 1e3 : 1, suffix = unit === 1e6 ? "M" : unit === 1e3 ? "k" : "";
  if (v === 0 && unit !== 1) return "0";
  // as many decimals as the step really has (0.25 -> 2, 2.5 -> 1, 0.5 -> 1, 5 -> 0), so every tick is exact
  const x = step / unit;
  let d = 0;
  while (d < 6 && Math.abs(x * 10 ** d - Math.round(x * 10 ** d)) > 1e-6 * Math.max(1, x * 10 ** d)) d++;
  return (v / unit).toFixed(d) + suffix;
}

/** A final value for the legend: exact when short, compact (3 significant digits) when huge. */
function fmtValue(v, isBool) {
  if (isBool) return v ? "true" : "false";
  const a = Math.abs(v);
  if (a >= 1e6) return `${+(v / 1e6).toPrecision(3)}M`;
  if (a >= 1e5) return `${+(v / 1e3).toPrecision(3)}k`;
  return Number.isInteger(v) ? String(v) : String(+v.toFixed(a >= 100 ? 1 : 3));
}

/** A sample value as a number, or null for a gap. */
function numeric(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(+v)) return +v;
  return null;
}

/** Normalize the spec's series: sorted points, gaps as null, booleans flagged (series without numbers included). */
function prepareAll(series) {
  return (Array.isArray(series) ? series : []).map((s, i) => {
    const raw = (Array.isArray(s?.points) ? s.points : []).filter((p) => Array.isArray(p) && Number.isFinite(+p[0]));
    const present = raw.filter((p) => p[1] !== null && p[1] !== undefined);
    const isBool = present.length > 0 && present.every((p) => typeof p[1] === "boolean");
    const points = raw.map((p) => [+p[0], numeric(p[1])]).sort((a, b) => a[0] - b[0]);
    const valid = points.filter((p) => p[1] !== null);
    return {
      label: String(s?.label ?? `series ${i + 1}`),
      color: s?.color || COLORS[i % COLORS.length],
      step: !!s?.step || isBool, isBool, points, valid, dash: !!s?.dash, lane: s?.lane ?? null,
      last: valid.length ? valid[valid.length - 1][1] : null,
    };
  });
}
const prepare = (series) => prepareAll(series).filter((s) => s.valid.length);

function rangeOf(points) {
  let lo = Infinity, hi = -Infinity;
  for (const p of points) { const v = p[1]; if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}

/** Group series into lanes: similar ranges share, very different ones split, booleans stay apart. */
export function lanesFor(series) {
  if (series.length <= 1) return [series];
  const lanes = [];
  for (const s of series) {
    const [lo, hi] = rangeOf(s.valid), span = Math.max(hi - lo, 1e-9);
    let lane = null;
    // an explicit lane key: series that share it always share a lane (overlays of two runs)
    if (s.lane != null) {
      lane = lanes.find((L) => L.key === s.lane) || null;
      if (lane) { lane.lo = Math.min(lane.lo, lo); lane.hi = Math.max(lane.hi, hi); lane.span = Math.max(lane.span, span); lane.items.push(s); }
      else lanes.push({ key: s.lane, lo, hi, span, isBool: s.isBool, items: [s] });
      continue;
    }
    for (const L of lanes) {
      if (L.key != null) continue;
      if (L.isBool !== s.isBool) continue;   // flags get their own lane, labelled false/true
      const jlo = Math.min(L.lo, lo), jhi = Math.max(L.hi, hi), jspan = Math.max(jhi - jlo, 1e-9);
      // joining must not squash either side below 1/6 of the lane
      if (jspan <= Math.min(L.span, span) * 6) { lane = L; L.lo = jlo; L.hi = jhi; L.span = Math.max(L.span, span); break; }
    }
    if (lane) lane.items.push(s);
    else lanes.push({ lo, hi, span, isBool: s.isBool, items: [s] });
  }
  return lanes.map((L) => L.items);
}

/** Greedy rows for labels at x positions so none overlap. Returns the row of each item. */
function labelRows(items, maxRows) {
  const ends = [];
  return items.map((it) => {
    let r = ends.findIndex((e) => e <= it.x);
    if (r < 0) r = ends.length < maxRows ? ends.length : ends.indexOf(Math.min(...ends));
    ends[r] = it.x + it.w + 6;
    return r;
  });
}

/** Draw the chart into a Raster. */
export function renderChart(spec = {}) {
  const W = Math.max(320, Math.min(4096, Math.round(spec.width ?? 1280)));
  let H = Math.max(200, Math.min(4096, Math.round(spec.height ?? 640)));
  const everything = prepareAll(spec.series);
  const series = everything.filter((s) => s.valid.length);
  const markers = (Array.isArray(spec.markers) ? spec.markers : []).filter((m) => m && Number.isFinite(+m.t)).map((m) => ({ t: +m.t, label: String(m.label ?? "mark"), color: m.color || MARK }));
  const inputs = (Array.isArray(spec.inputs) ? spec.inputs : []).filter((x) => x && Number.isFinite(+x.t0)).map((x) => ({ label: String(x.label ?? "input"), t0: +x.t0, t1: Number.isFinite(+x.t1) ? Math.max(+x.t0, +x.t1) : +x.t0 }));
  const inputRows = [...new Set(inputs.map((x) => x.label))];
  const ROW = 16, stripH = inputRows.length ? inputRows.length * ROW + 10 : 0;
  const lanes = series.length ? lanesFor(series) : [];

  // ---- measure the header first so the picture can grow to fit every lane ------------
  const probe = new Raster(1, 1);
  const legend = [];
  {
    let x = 24, row = 0;
    for (const s of everything) {
      const name = probe.fitText(s.label, W * 0.4), value = !s.valid.length ? "no data" : s.last === null ? "—" : fmtValue(s.last, s.isBool);
      const w = 26 + probe.measureText(name) + 10 + probe.measureText(value);
      if (x + w > W - 24 && x > 24) { x = 24; row++; }
      legend.push({ s, name, value, x, row, w });
      x += w + 22;
    }
  }
  const legendRows = legend.length ? legend[legend.length - 1].row + 1 : 0;
  const top = 64 + legendRows * 22 + (legendRows ? 14 : 0);
  const gap = 12, head = lanes.length > 1 ? 22 : 0;   // split lanes get a caption strip above the panel
  const weights = lanes.map((items) => (items.every((x) => x.isBool) ? 0.4 : 1));
  const minLane = (w) => (w < 1 ? MIN_BOOL_LANE_H : MIN_LANE_H);
  H = Math.min(4096, Math.max(H, top + weights.reduce((a, w) => a + minLane(w), 0) + (lanes.length - 1) * gap + lanes.length * head + 60 + stripH));
  const g = new Raster(W, H, BG);

  // ---- title, subtitle, legend ----------------------------------------------------------
  let t0 = Infinity, t1 = -Infinity, samples = 0;
  for (const s of series) { t0 = Math.min(t0, s.points[0][0]); t1 = Math.max(t1, s.points[s.points.length - 1][0]); samples += s.valid.length; }
  for (const m of markers) { t0 = Math.min(t0, m.t); t1 = Math.max(t1, m.t); }
  for (const x of inputs) { t0 = Math.min(t0, x.t0); t1 = Math.max(t1, x.t1); }
  const subtitle = spec.subtitle ?? (series.length
    ? `${series.length} series · ${samples.toLocaleString("en-US")} samples · ${t0.toFixed(2)}–${t1.toFixed(2)} s${markers.length ? ` · ${markers.length} mark${markers.length === 1 ? "" : "s"}` : ""}`
    : "");
  const subW = subtitle ? g.measureText(subtitle) + 24 : 0;
  g.text(g.fitText(String(spec.title ?? "trace"), W - 48 - subW, { scale: 2 }), 24, 34, { scale: 2, bold: true, color: TEXT, baseline: "middle" });
  if (subtitle) g.text(subtitle, W - 24, 36, { color: DIM, align: "right", baseline: "middle" });
  for (const it of legend) {
    const y = 72 + it.row * 22;
    if (it.s.dash) g.line(it.x, y, it.x + 18, y, it.s.color, 3, { dash: [5, 3] });
    else g.roundRect(it.x, y - 2, 18, 4, 2, it.s.color);
    g.text(it.name, it.x + 26, y, { color: TEXT, baseline: "middle" });
    g.text(it.value, it.x + 26 + g.measureText(it.name) + 10, y, { color: it.s.valid.length ? it.s.color : DIM, bold: true, baseline: "middle" });
  }

  const bottom = H - 52 - stripH;
  if (!series.length) {
    g.roundRect(24, top, W - 48, bottom - top, 8, PANEL);
    g.text("no numeric samples to plot", W / 2, (top + bottom) / 2, { color: DIM, scale: 2, align: "center", baseline: "middle" });
    return g;
  }
  if (t1 - t0 < 1e-6) { t0 -= 0.5; t1 += 0.5; }

  // ---- lanes: value ranges and tick labels decide the left margin ------------------------
  const unit = (bottom - top - (gap + head) * (lanes.length - 1) - head) / weights.reduce((a, w) => a + w, 0);
  let laneY = top + head;
  const laneInfo = lanes.map((items, li) => {
    const laneH = Math.max(minLane(weights[li]), unit * weights[li]);
    const ly0 = laneY, ly1 = Math.min(bottom, ly0 + laneH);
    laneY = ly1 + gap + head;
    const allBool = items.every((s) => s.isBool);
    let lo = Infinity, hi = -Infinity;
    for (const s of items) { const [a, b] = rangeOf(s.valid); lo = Math.min(lo, a); hi = Math.max(hi, b); }
    if (allBool) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) { const pad = Math.abs(hi) * 0.1 || 1; lo -= pad; hi += pad; }
    const padV = (hi - lo) * (allBool ? 0.18 : 0.08); lo -= padV; hi += padV;
    const ticks = [];
    if (allBool) ticks.push([0, "false"], [1, "true"]);
    else {
      const vStep = tickStep(lo, hi, Math.max(3, Math.min(8, Math.floor(laneH / 28))), laneH / 22);
      const ref = Math.max(Math.abs(lo), Math.abs(hi));
      for (let v = Math.ceil(lo / vStep - 1e-9) * vStep; v <= hi + 1e-9; v += vStep) ticks.push([v, fmtTick(v, vStep, ref)]);
    }
    return { items, ly0, ly1, lo, hi, ticks };
  });
  const left = Math.max(64, 24 + Math.max(...laneInfo.flatMap((L) => L.ticks.map(([, s]) => g.measureText(s))), ...inputRows.map((r) => Math.min(160, g.measureText(r)))));
  const right = W - 28;
  const tx = (t) => left + INSET + ((t - t0) / (t1 - t0)) * (right - left - 2 * INSET);
  const tStep = niceStep(t1 - t0, Math.max(4, Math.floor((right - left) / 120)));
  const tTicks = [];
  for (let t = Math.ceil(t0 / tStep - 1e-9) * tStep; t <= t1 + 1e-9; t += tStep) tTicks.push(t);

  for (const L of laneInfo) {
    const { items, ly0, ly1, lo, hi } = L;
    const vy = (v) => ly1 - ((v - lo) / (hi - lo)) * (ly1 - ly0);
    g.roundRect(left, ly0, right - left, ly1 - ly0, 6, PANEL);
    for (const [v, s] of L.ticks) {
      const yy = Math.round(vy(v));
      g.fillRect(left + 1, yy, right - left - 2, 1, GRID);
      g.text(s, left - 10, yy, { color: DIM, align: "right", baseline: "middle" });
    }
    for (const t of tTicks) g.fillRect(Math.round(tx(t)), ly0 + 1, 1, ly1 - ly0 - 2, GRID);

    // lines (clipped to the lane)
    g.save().clip(left, ly0, right - left, ly1 - ly0);
    for (const s of items) {
      const pts = [];
      let prev = null;
      for (const [t, v] of s.points) {
        if (v === null) { pts.push(null); prev = null; continue; }
        if (s.step && prev !== null) pts.push([tx(t), vy(prev)]);
        pts.push([tx(t), vy(v)]);
        prev = v;
      }
      // a step series holds its last value to the end of the time axis
      if (s.step && prev !== null && s.points[s.points.length - 1][1] !== null) pts.push([tx(t1), vy(prev)]);
      g.polyline(pts, s.color, 2.25, s.dash ? { dash: [7, 5] } : {});
      if (s.valid.length < 40) for (const [t, v] of s.valid) { g.circle(tx(t), vy(v), 4.5, PANEL); g.circle(tx(t), vy(v), 3.2, s.color); }
      else if (!s.step) { const [t, v] = s.valid[s.valid.length - 1]; g.circle(tx(t), vy(v), 3.5, s.color); }
    }
    g.restore();
    g.strokeRoundRect(left, ly0, right - left, ly1 - ly0, 6, FRAME, 1);

    // lane caption (when lanes are split), in the strip above the panel
    if (head) {
      let cx = left + 2;
      for (const s of items) {
        const name = g.fitText(s.label, right - cx);
        if (!name) break;
        if (s.dash) g.line(cx, ly0 - 11, cx + 10, ly0 - 11, s.color, 3, { dash: [4, 2] });
        else g.roundRect(cx, ly0 - 13, 10, 4, 2, s.color);
        g.text(name, cx + 16, ly0 - 11, { color: s.color, bold: true, baseline: "middle" });
        cx += 16 + g.measureText(name) + 18;
      }
    }
  }

  // ---- held inputs: a row per input under the plot, a faint line at each press across the lanes -----
  if (inputs.length) {
    const sy = bottom + 6;
    inputRows.forEach((r, i) => {
      const y = sy + i * ROW;
      g.text(g.fitText(r, left - 14), left - 10, y + ROW / 2, { color: DIM, align: "right", baseline: "middle" });
      g.fillRect(left, y + ROW / 2, right - left, 1, GRID);
    });
    for (const x of inputs) {
      const i = inputRows.indexOf(x.label), y = sy + i * ROW;
      const xa = tx(x.t0), xb = Math.max(xa + 2, tx(x.t1));
      g.roundRect(xa, y + 3, xb - xa, ROW - 6, 2, "rgba(142,202,230,0.85)");
      g.fillRect(Math.round(xa), laneInfo[0].ly0, 1, bottom - laneInfo[0].ly0, "rgba(142,202,230,0.28)");
    }
  }

  // ---- markers ----------------------------------------------------------------------------
  if (markers.length) {
    const items = markers.map((m) => ({ m, x: tx(m.t), w: g.measureText(m.label) + 12 })).sort((a, b) => a.x - b.x);
    const rows = labelRows(items.map((it) => ({ x: Math.min(right - it.w, it.x + 4), w: it.w })), 3);
    items.forEach((it, i) => {
      const xx = Math.round(it.x) + 0.5;
      g.line(xx, laneInfo[0].ly0, xx, bottom, it.m.color, 1.5, { dash: [6, 5] });
      const bx = Math.min(right - it.w, Math.round(it.x) + 4), by = laneInfo[0].ly0 + 6 + rows[i] * 24;
      g.roundRect(bx, by, it.w, 20, 4, it.m.color);
      g.text(it.m.label, bx + 6, by + 10, { color: it.m.color === MARK ? "#ffffff" : BG, bold: true, baseline: "middle" });
    });
  }

  // ---- time labels ------------------------------------------------------------------------
  const ty = bottom + stripH + 10;
  for (const t of tTicks) g.text(fmtTick(t, tStep, 0), tx(t), ty, { color: DIM, align: "center" });
  const fps = +spec.fps > 0 ? +spec.fps : 0;
  g.text(fps ? `seconds  (frame = seconds × ${fps})` : "seconds", (left + right) / 2, ty + 20, { color: DIM, align: "center" });
  return g;
}

/** Render a line chart to a PNG Buffer. */
export function lineChart(spec = {}) {
  return renderChart(spec).toPNG();
}
