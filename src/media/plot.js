// Witness media: pictures of where things went and how values spread (chart v2).
//
//   histogram(values, opts)        -> { n, stats, lo, step, integer, bins, mode }      (pure numbers)
//   sharedHistograms(sets, opts)   -> the same for several value sets on one set of bins (A/B overlays)
//   percentile(sorted, p)          -> linear interpolation between closest ranks (type 7, like numpy's default)
//   heatGrid(points, opts)         -> cells of a world grid with a count (or weight) each                (pure numbers)
//   pathSegments(points, opts)     -> the path cut at teleports (respawns, portals): { segments, jumps }
//   pathStats(points, opts)        -> { length (teleports left out), bounds, start, end, net, jumps }
//   renderWorld(spec) / worldPNG   -> an XY map: paths, start/end/death markers, a heat layer, the level behind
//   renderHist(spec)  / histPNG    -> histogram panels (one per series, A/B overlaid)
//
// Same dark style as chart.js. World plots keep one scale for x and y (a square in the game is a square here),
// y grows downwards like screen coordinates unless spec.yUp.

import { Raster } from "./raster.js";
import { niceStep, fmtTick, COLORS } from "./chart.js";

const BG = "#0b1020", PANEL = "#111833", TEXT = "#e6ebff", DIM = "#8b93b8", GRID = "rgba(255,255,255,0.07)";
const FRAME = "rgba(255,255,255,0.16)";
export const MARK_COLORS = { start: "#3ddc97", end: "#ffffff", death: "#ff4d5e", event: "#ffd166" };
// a magma-like sequential ramp (dark purple → orange → pale yellow), readable on the dark panel
const RAMP = [[59, 15, 112], [140, 41, 129], [222, 73, 104], [254, 159, 109], [252, 253, 191]];

// ------------------------------------------------------------------ numbers

/** Value at fraction p (0..1) of an ascending array: linear between closest ranks. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const h = (sorted.length - 1) * Math.min(1, Math.max(0, p)), lo = Math.floor(h);
  return lo + 1 < sorted.length ? sorted[lo] + (h - lo) * (sorted[lo + 1] - sorted[lo]) : sorted[lo];
}

const finiteNums = (values) => (Array.isArray(values) ? values : []).map((v) => (typeof v === "boolean" ? +v : typeof v === "number" ? v : NaN)).filter(Number.isFinite);

function statsOf(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { n: xs.length, min: s[0], max: s[s.length - 1], mean, median: percentile(s, 0.5), p5: percentile(s, 0.05), p95: percentile(s, 0.95) };
}

/** Bins for the union of value sets: one per integer when the values are small integers, else a nice step. */
const minOf = (xs) => { let m = Infinity; for (const v of xs) if (v < m) m = v; return m; };
const maxOf = (xs) => { let m = -Infinity; for (const v of xs) if (v > m) m = v; return m; };

function binsFor(all, { bins = 20, step = null } = {}) {
  const lo = minOf(all), hi = maxOf(all);
  const integer = all.every(Number.isInteger);
  if (step > 0) return { lo: Math.floor(lo / step + 1e-9) * step, step, integer: false };
  if (integer && hi - lo <= 40) return { lo: lo - 0.5, step: 1, integer: true };
  if (hi - lo < 1e-12) return { lo: lo - 0.5, step: 1, integer: false, constant: true };
  const st = niceStep(hi - lo, bins);
  return { lo: Math.floor(lo / st + 1e-9) * st, step: st, integer: false };
}

function fill(xs, b, nb) {
  const counts = new Array(nb).fill(0);
  for (const v of xs) counts[Math.min(nb - 1, Math.max(0, Math.floor((v - b.lo) / b.step + 1e-9)))]++;
  return counts;
}

function pack(xs, b, nb) {
  const counts = fill(xs, b, nb);
  const bins = counts.map((count, i) => ({ x0: +(b.lo + i * b.step).toFixed(10), x1: +(b.lo + (i + 1) * b.step).toFixed(10), count }));
  let mode = null;
  for (const q of bins) if (!mode || q.count > mode.count) mode = q;
  return { n: xs.length, stats: statsOf(xs), lo: b.lo, step: b.step, integer: b.integer, bins, mode };
}

/**
 * A histogram of the finite numbers in `values` (booleans count as 0/1; null, NaN and strings are skipped).
 * opts: { bins: about how many (20), step: a fixed bin width }. Bins are [x0, x1); the maximum lands in the last.
 * Small integer data (range <= 40) gets one bin per integer, centred on it.
 */
export function histogram(values, opts = {}) {
  const xs = finiteNums(values);
  if (!xs.length) return { n: 0, stats: null, lo: 0, step: 1, integer: false, bins: [], mode: null };
  const b = binsFor(xs, opts);
  return pack(xs, b, Math.max(1, Math.floor((maxOf(xs) - b.lo) / b.step + 1e-9) + 1));
}

/** Histograms of several value sets on the same bins (for overlays). */
export function sharedHistograms(sets, opts = {}) {
  const lists = sets.map(finiteNums), all = lists.flat();
  if (!all.length) return lists.map(() => histogram([], opts));
  const b = binsFor(all, opts), nb = Math.max(1, Math.floor((maxOf(all) - b.lo) / b.step + 1e-9) + 1);
  return lists.map((xs) => (xs.length ? pack(xs, b, nb) : { n: 0, stats: null, lo: b.lo, step: b.step, integer: b.integer, bins: new Array(nb).fill(0).map((_, i) => ({ x0: b.lo + i * b.step, x1: b.lo + (i + 1) * b.step, count: 0 })), mode: null }));
}

/**
 * Count points into square world cells. points: [[x, y, weight?], ...]; opts: { cell, origin: [ox, oy] }.
 * Cell (ix, iy) covers [ox + ix·cell, ox + (ix+1)·cell) × [oy + iy·cell, …). Returns { cell, ox, oy, cells (sorted,
 * most first: { ix, iy, x0, y0, x1, y1, count }), total, max }.
 */
export function heatGrid(points, { cell, origin = [0, 0] } = {}) {
  const pts = (points || []).filter((p) => p && Number.isFinite(+p[0]) && Number.isFinite(+p[1]));
  if (!(cell > 0)) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    // about 1/16 of the longer side of the visited area, but never a speck: at least 1 world unit when the
    // coordinates are 16+ (pixel-like worlds), else 1/16 of their size (an idle player has no extent at all)
    const big = Math.max(Math.abs(x0), Math.abs(x1), Math.abs(y0), Math.abs(y1));
    const floor = big >= 16 ? 1 : big > 0 ? niceStep(big, 16) : 1;
    cell = pts.length ? Math.max(niceStep(Math.max(x1 - x0, y1 - y0, 1e-9), 16), floor) : 1;
  }
  const [ox, oy] = origin, m = new Map();
  let total = 0;
  for (const p of pts) {
    const w = p.length > 2 && Number.isFinite(+p[2]) ? +p[2] : 1;
    const ix = Math.floor((+p[0] - ox) / cell + 1e-9), iy = Math.floor((+p[1] - oy) / cell + 1e-9), k = `${ix},${iy}`;
    m.set(k, (m.get(k) || 0) + w);
    total += w;
  }
  const cells = [...m].map(([k, count]) => {
    const [ix, iy] = k.split(",").map(Number);
    return { ix, iy, x0: ox + ix * cell, y0: oy + iy * cell, x1: ox + (ix + 1) * cell, y1: oy + (iy + 1) * cell, count };
  }).sort((a, b) => b.count - a.count || a.iy - b.iy || a.ix - b.ix);
  return { cell, ox, oy, cells, total, max: cells.length ? cells[0].count : 0 };
}

/**
 * A path cut where the thing teleported: a step into a frame listed in opts.breakAt (respawns), or a step far longer
 * than the usual one (over 10x the median moving step, both per step and per frame; needs 5+ moving steps).
 * points: [[x, y, frame?], ...]. Returns { segments: [[points]], jumps: [{ f, from, to, d }] }.
 */
export function pathSegments(points, { breakAt = [] } = {}) {
  const pts = (points || []).filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!pts.length) return { segments: [], jumps: [] };
  const brk = new Set(breakAt);
  const steps = pts.slice(1).map((p, i) => { const q = pts[i], d = Math.hypot(p[0] - q[0], p[1] - q[1]), df = Number.isFinite(p[2]) && Number.isFinite(q[2]) ? Math.max(1, p[2] - q[2]) : 1; return { d, v: d / df }; });
  const med = (xs) => { const s = xs.filter((x) => x > 1e-9).sort((a, b) => a - b); return s.length >= 5 ? s[Math.floor((s.length - 1) / 2)] : null; };
  const md = med(steps.map((s) => s.d)), mv = med(steps.map((s) => s.v));
  const segments = [[pts[0]]], jumps = [];
  steps.forEach((st, i) => {
    const p = pts[i + 1];
    const far = md != null && st.d > 10 * md && st.v > 10 * mv;
    if ((brk.has(p[2]) && st.d > 1e-9) || far) { jumps.push({ f: p[2], from: pts[i].slice(0, 2), to: p.slice(0, 2), d: st.d }); segments.push([p]); }
    else segments[segments.length - 1].push(p);
  });
  return { segments, jumps };
}

/**
 * Length (sum of steps, teleports left out: see pathSegments), bounds, start/end and net displacement of a path
 * [[x, y, frame?], ...]. opts.breakAt: frames a teleport lands on (respawns).
 */
export function pathStats(points, opts = {}) {
  const { segments, jumps } = pathSegments(points, opts);
  const pts = segments.flat();
  if (!pts.length) return null;
  let len = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const seg of segments) seg.forEach((p, i) => { if (i) len += Math.hypot(p[0] - seg[i - 1][0], p[1] - seg[i - 1][1]); });
  for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const s = pts[0], e = pts[pts.length - 1];
  return { length: len, bounds: { x0, x1, y0, y1 }, start: s, end: e, net: [e[0] - s[0], e[1] - s[1]], samples: pts.length, jumps };
}

/** Ramp colour for t in 0..1. */
export function heatColor(t) {
  t = Math.min(1, Math.max(0, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(t)), f = t - i, a = RAMP[i], b = RAMP[i + 1];
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f));
}

// ------------------------------------------------------------------ world plot

function placeLabel(placed, x, y, w, h, box) {
  for (const [dx, dy] of [[8, -h - 4], [8, 4], [-w - 8, -h - 4], [-w - 8, 4], [-w / 2, -h - 10], [-w / 2, 10]]) {
    const r = { x: x + dx, y: y + dy, w, h };
    if (r.x < box.x0 || r.y < box.y0 || r.x + w > box.x1 || r.y + h > box.y1) continue;
    if (placed.some((q) => r.x < q.x + q.w + 2 && q.x < r.x + w + 2 && r.y < q.y + q.h + 2 && q.y < r.y + h + 2)) continue;
    placed.push(r);
    return r;
  }
  return null;
}

/**
 * Draw an XY world plot into a Raster.
 * spec = { title, subtitle, width (1000), yUp,
 *          map?: { cell, origin, rows: ["#..#"], solid: "#" }            the level, solid cells drawn as walls
 *          image?: { img: {width,height,data}, x0, y0, x1, y1 }           a picture covering that world rect
 *          heat?: { grid: heatGrid(), label: "s", value: (count) => number }   a heat layer
 *          paths?: [{ label, points: [[x, y, frame?], ...], color, dash, ticks: [{ x, y, label }], breakAt: [frame] }],
 *          markers?: [{ x, y, kind: "start"|"end"|"death"|"event", label, color }],
 *          notes?: ["background: …"] (a dim line under the plot) }
 */
export function renderWorld(spec = {}) {
  const W = Math.max(480, Math.min(4096, Math.round(spec.width ?? 1000)));
  const paths = (spec.paths || []).map((p, i) => ({ ...p, color: p.color || COLORS[i % COLORS.length], points: (p.points || []).filter((q) => q && Number.isFinite(q[0]) && Number.isFinite(q[1])) }));
  const markers = (spec.markers || []).filter((m) => m && Number.isFinite(m.x) && Number.isFinite(m.y));
  const heat = spec.heat && spec.heat.grid && spec.heat.grid.cells.length ? spec.heat : null;
  const map = spec.map && Array.isArray(spec.map.rows) && spec.map.rows.length && +spec.map.cell > 0 ? spec.map : null;
  const image = !spec.yUp && spec.image && spec.image.img ? spec.image : null;

  // ---- world bounds ---------------------------------------------------------------------
  let X0 = Infinity, X1 = -Infinity, Y0 = Infinity, Y1 = -Infinity;
  const grow = (x, y) => { X0 = Math.min(X0, x); X1 = Math.max(X1, x); Y0 = Math.min(Y0, y); Y1 = Math.max(Y1, y); };
  for (const p of paths) for (const q of p.points) grow(q[0], q[1]);
  for (const m of markers) grow(m.x, m.y);
  if (heat) for (const c of heat.grid.cells) { grow(c.x0, c.y0); grow(c.x1, c.y1); }
  if (map) { const [ox, oy] = map.origin || [0, 0]; grow(ox, oy); grow(ox + Math.max(...map.rows.map((r) => r.length)) * map.cell, oy + map.rows.length * map.cell); }
  if (image) { grow(image.x0, image.y0); grow(image.x1, image.y1); }
  const empty = !Number.isFinite(X0);
  if (empty) { X0 = 0; X1 = 1; Y0 = 0; Y1 = 1; }
  const padOf = (lo, hi) => (hi - lo > 1e-9 ? (hi - lo) * 0.04 : Math.max(1, Math.abs(lo) * 0.1));
  const px = padOf(X0, X1), py = padOf(Y0, Y1);
  if (!map && !image) { X0 -= px; X1 += px; Y0 -= py; Y1 += py; }
  else if (X1 - X0 < 1e-9 || Y1 - Y0 < 1e-9) { X0 -= px; X1 += px; Y0 -= py; Y1 += py; }

  // ---- legend (measured first) -----------------------------------------------------------
  const probe = new Raster(1, 1);
  const kinds = ["start", "end", "death", "event"].filter((k) => markers.some((m) => m.kind === k));
  const items = [
    ...paths.map((p) => ({ type: "path", p, text: probe.fitText(p.label, W * 0.45) })),
    ...kinds.map((k) => ({ type: "mark", k, text: k === "event" ? "event" : k })),
  ];
  const heatW = heat ? 300 : 0;
  let lx = 24, row = 0;
  for (const it of items) {
    it.w = 30 + probe.measureText(it.text);
    if (lx + it.w > W - 24 - (row === 0 ? heatW : 0) && lx > 24) { lx = 24; row++; }
    it.x = lx; it.row = row; lx += it.w + 20;
  }
  const legendRows = items.length ? row + 1 : heat ? 1 : 0;
  const top = 64 + legendRows * 22 + (legendRows ? 16 : 0);

  // ---- layout: equal scale ------------------------------------------------------------------
  const tickLabelW = Math.max(probe.measureText(fmtTick(Y0, niceStep(Y1 - Y0, 6), Math.max(Math.abs(Y0), Math.abs(Y1)))), probe.measureText(fmtTick(Y1, niceStep(Y1 - Y0, 6), Math.max(Math.abs(Y0), Math.abs(Y1)))));
  const left = 40 + tickLabelW, right = 28, noteH = (spec.notes || []).length * 18;
  let PW = W - left - right, PH = PW * ((Y1 - Y0) / (X1 - X0));
  const MAXH = 860, MINH = 180;
  if (PH > MAXH) { PH = MAXH; PW = PH * ((X1 - X0) / (Y1 - Y0)); }
  if (PH < MINH) { const need = (MINH / PW) * (X1 - X0), c = (Y0 + Y1) / 2; Y0 = c - need / 2; Y1 = c + need / 2; PH = MINH; }
  if (PW < 240) { const need = (240 / PH) * (Y1 - Y0), c = (X0 + X1) / 2; X0 = c - need / 2; X1 = c + need / 2; PW = 240; }
  const H = Math.round(top + PH + 52 + noteH);
  const g = new Raster(W, H, BG);
  const px0 = Math.round(left + (W - left - right - PW) / 2), py0 = top, px1 = Math.round(px0 + PW), py1 = Math.round(py0 + PH);
  const k = (px1 - px0) / (X1 - X0);
  const wx = (x) => px0 + (x - X0) * k;
  const wy = spec.yUp ? (y) => py1 - (y - Y0) * k : (y) => py0 + (y - Y0) * k;

  // ---- header -----------------------------------------------------------------------------
  const subtitle = spec.subtitle || "";
  const subW = subtitle ? g.measureText(subtitle) + 24 : 0;
  g.text(g.fitText(String(spec.title ?? "path"), W - 48 - subW, { scale: 2 }), 24, 34, { scale: 2, bold: true, color: TEXT, baseline: "middle" });
  if (subtitle) g.text(g.fitText(subtitle, W * 0.55), W - 24, 36, { color: DIM, align: "right", baseline: "middle" });
  for (const it of items) {
    const y = 72 + it.row * 22;
    if (it.type === "path") g.line(it.x, y, it.x + 20, y, it.p.color, 3, it.p.dash ? { dash: [5, 4] } : {});
    else drawMarker(g, it.x + 10, y, it.k, MARK_COLORS[it.k], 0.8);
    g.text(it.text, it.x + 30, y, { color: TEXT, baseline: "middle" });
  }
  if (heat) {
    const bx = W - 24 - 200, by = 66, max = heat.grid.max, val = heat.value || ((c) => c), unit = heat.label || "";
    for (let i = 0; i < 200; i++) g.fillRect(bx + i, by, 1, 10, heatColor(Math.sqrt((i + 1) / 200)));
    g.strokeRect(bx, by, 200, 10, FRAME, 1);
    const fv = (v) => { const a = Math.abs(v); return a >= 100 ? String(Math.round(v)) : String(+v.toFixed(a >= 10 ? 1 : 2)); };
    for (const f of [0, 0.25, 1]) g.text(fv(val(max * f)) + (f === 1 && unit ? ` ${unit}` : ""), bx + Math.sqrt(f) * 200, by + 14, { color: DIM, align: f === 0 ? "left" : f === 1 ? "right" : "center" });
    g.text(heat.title || "per cell (sqrt scale)", bx - 10, by + 5, { color: DIM, align: "right", baseline: "middle" });
  }

  // ---- panel, background layers --------------------------------------------------------------
  g.roundRect(px0, py0, px1 - px0, py1 - py0, 6, PANEL);
  g.save().clip(px0, py0, px1 - px0, py1 - py0);
  if (image) g.drawImage(image.img, { dx: wx(image.x0), dy: wy(image.y0), dw: (image.x1 - image.x0) * k, dh: (image.y1 - image.y0) * k, alpha: 0.55, smooth: "bilinear" });
  if (map) {
    const [ox, oy] = map.origin || [0, 0], solid = String(map.solid ?? "#");
    map.rows.forEach((r, j) => [...String(r)].forEach((ch, i) => {
      if (!solid.includes(ch)) return;
      // edges rounded once each, so neighbouring cells meet without seams
      const xa = Math.round(wx(ox + i * map.cell)), xb = Math.round(wx(ox + (i + 1) * map.cell));
      const ya = Math.round(wy(oy + (spec.yUp ? j + 1 : j) * map.cell)), yb = Math.round(wy(oy + (spec.yUp ? j : j + 1) * map.cell));
      g.fillRect(xa, ya, xb - xa, yb - ya, "#2f3658");
    }));
  }
  // grid lines + ticks
  const xs = niceStep(X1 - X0, Math.max(3, Math.floor((px1 - px0) / 110))), ys = niceStep(Y1 - Y0, Math.max(3, Math.floor((py1 - py0) / 60)));
  const xT = [], yT = [];
  for (let v = Math.ceil(X0 / xs - 1e-9) * xs; v <= X1 + 1e-9; v += xs) xT.push(v);
  for (let v = Math.ceil(Y0 / ys - 1e-9) * ys; v <= Y1 + 1e-9; v += ys) yT.push(v);
  for (const v of xT) g.fillRect(Math.round(wx(v)), py0, 1, py1 - py0, GRID);
  for (const v of yT) g.fillRect(px0, Math.round(wy(v)), px1 - px0, 1, GRID);
  if (heat) {
    const val = heat.grid.max;
    for (const c of heat.grid.cells) {
      const xa = Math.round(wx(c.x0)), xb = Math.round(wx(c.x1)), ya = Math.round(wy(spec.yUp ? c.y1 : c.y0)), yb = Math.round(wy(spec.yUp ? c.y0 : c.y1));
      const [r, gg, b] = heatColor(Math.sqrt(c.count / val));
      g.fillRect(xa, ya, Math.max(1, xb - xa), Math.max(1, yb - ya), [r, gg, b, 0.82]);
    }
  }
  // paths: one line per segment (cut at teleports: p.breakAt frames or far jumps), each teleport a thin dotted hop
  for (const p of paths) {
    const { segments, jumps } = pathSegments(p.points, { breakAt: p.breakAt || [] });
    for (const j of jumps) g.line(wx(j.from[0]), wy(j.from[1]), wx(j.to[0]), wy(j.to[1]), [255, 255, 255, 0.35], 1, { dash: [2, 4] });
    for (const seg of segments) {
      const pts = seg.map((q) => [wx(q[0]), wy(q[1])]);
      if (pts.length < 2) continue;
      g.polyline(pts, [0, 0, 0, 0.55], 4.5, p.dash ? { dash: [7, 5] } : {});
      g.polyline(pts, p.color, 2.25, p.dash ? { dash: [7, 5] } : {});
    }
  }
  g.restore();
  g.strokeRoundRect(px0, py0, px1 - px0, py1 - py0, 6, FRAME, 1);

  // frame ticks on the paths, then markers, labels kept apart
  const placed = [], box = { x0: px0 + 2, y0: py0 + 2, x1: px1 - 2, y1: py1 - 2 };
  for (const p of paths) for (const t of p.ticks || []) {
    const x = wx(t.x), y = wy(t.y);
    g.circle(x, y, 3.2, BG); g.circle(x, y, 2.2, p.color);
    if (t.label) { const w = g.measureText(t.label) + 6, r = placeLabel(placed, x, y, w, 14, box); if (r) g.text(t.label, r.x + 3, r.y + 7, { color: p.color, baseline: "middle" }); }
  }
  const labelled = markers.length <= 24;
  for (const m of markers) {
    const x = wx(m.x), y = wy(m.y), col = m.color || MARK_COLORS[m.kind] || MARK_COLORS.event;
    drawMarker(g, x, y, m.kind, col, 1);
    placed.push({ x: x - 8, y: y - 8, w: 16, h: 16 });
  }
  if (labelled) for (const m of markers) {
    if (!m.label) continue;
    const x = wx(m.x), y = wy(m.y), col = m.color || MARK_COLORS[m.kind] || MARK_COLORS.event;
    const w = g.measureText(m.label) + 12, r = placeLabel(placed, x, y, w, 18, box);
    if (r) { g.roundRect(r.x, r.y, w, 18, 4, [11, 16, 32, 0.85]); g.text(m.label, r.x + 6, r.y + 9, { color: col, bold: true, baseline: "middle" }); }
  }

  // ---- axes ---------------------------------------------------------------------------------
  const xref = Math.max(Math.abs(X0), Math.abs(X1)), yref = Math.max(Math.abs(Y0), Math.abs(Y1));
  for (const v of xT) g.text(fmtTick(v, xs, xref), wx(v), py1 + 8, { color: DIM, align: "center" });
  for (const v of yT) g.text(fmtTick(v, ys, yref), px0 - 8, wy(v), { color: DIM, align: "right", baseline: "middle" });
  g.text(`${spec.xLabel || "x"} (world units; same scale on both axes${spec.yUp ? ", y up" : ", y down"})`, (px0 + px1) / 2, py1 + 28, { color: DIM, align: "center" });
  (spec.notes || []).forEach((n, i) => g.text(g.fitText(String(n), W - 48), 24, py1 + 52 + i * 18, { color: DIM }));
  if (empty) g.text("no positions to plot", (px0 + px1) / 2, (py0 + py1) / 2, { color: DIM, scale: 2, align: "center", baseline: "middle" });
  return g;
}

function drawMarker(g, x, y, kind, col, s) {
  if (kind === "death") {
    const r = 7 * s;
    g.line(x - r, y - r, x + r, y + r, BG, 6 * s); g.line(x - r, y + r, x + r, y - r, BG, 6 * s);
    g.line(x - r, y - r, x + r, y + r, col, 3 * s); g.line(x - r, y + r, x + r, y - r, col, 3 * s);
  } else if (kind === "end") {
    g.roundRect(x - 7 * s, y - 7 * s, 14 * s, 14 * s, 2, BG); g.strokeRoundRect(x - 6 * s, y - 6 * s, 12 * s, 12 * s, 2, col, 2.5);
  } else if (kind === "start") {
    g.circle(x, y, 8 * s, BG); g.circle(x, y, 6 * s, col);
  } else { g.circle(x, y, 6 * s, BG); g.circle(x, y, 4.5 * s, col); }
}

export const worldPNG = (spec) => renderWorld(spec).toPNG();

// ------------------------------------------------------------------ histogram panels

const fmtStat = (v) => (v == null ? "—" : Math.abs(v) >= 1e5 ? v.toExponential(2) : String(+(+v).toFixed(Math.abs(v) >= 100 ? 1 : 3)));

/**
 * spec = { title, subtitle, width (1000), panels: [{ label, bool?, series: [{ label, hist: histogram(), color, dash }] }] }
 * (bool: the values were flags, so the 0 and 1 bins are labelled false / true)
 * Each panel: bars per bin (one series filled; two or more drawn translucent with outlines), the mean (dashed) and
 * median (solid) of each series, counts on the left axis and n/mean/median/p5/p95 in the caption.
 */
export function renderHist(spec = {}) {
  const W = Math.max(480, Math.min(4096, Math.round(spec.width ?? 1000)));
  const panels = (spec.panels || []).filter((p) => p && p.series && p.series.length);
  const PH = 170, CAP = 22 + 18, GAP = 40, top = 64;
  const H = Math.max(200, top + panels.reduce((h, p) => h + PH + CAP + GAP + (p.series.length - 1) * 18, 0) + 10);
  const g = new Raster(W, H, BG);
  g.text(g.fitText(String(spec.title ?? "histogram"), W * 0.6, { scale: 2 }), 24, 34, { scale: 2, bold: true, color: TEXT, baseline: "middle" });
  if (spec.subtitle) g.text(g.fitText(spec.subtitle, W * 0.38), W - 24, 36, { color: DIM, align: "right", baseline: "middle" });
  if (!panels.length) { g.text("no numeric samples", W / 2, H / 2, { color: DIM, scale: 2, align: "center", baseline: "middle" }); return g; }
  let y = top;
  for (const P of panels) {
    const ser = P.series.map((s, i) => ({ ...s, color: s.color || COLORS[i % COLORS.length] })).filter((s) => s.hist && s.hist.bins.length);
    // caption: panel name, then one stats line per series
    g.text(g.fitText(P.label, W - 48), 24, y + 8, { color: TEXT, bold: true, baseline: "middle" });
    let cy = y + 26;
    for (const s of ser) {
      const st = s.hist.stats;
      const line = `${ser.length > 1 ? `${s.label}: ` : ""}n ${s.hist.n} · mean ${fmtStat(st && st.mean)} · median ${fmtStat(st && st.median)} · p5 ${fmtStat(st && st.p5)} · p95 ${fmtStat(st && st.p95)} · min ${fmtStat(st && st.min)} · max ${fmtStat(st && st.max)}`;
      g.roundRect(24, cy - 2, 14, 4, 2, s.color);
      g.text(g.fitText(line, W - 80), 46, cy, { color: DIM, baseline: "middle" });
      cy += 18;
    }
    const py0 = y + CAP + (ser.length - 1) * 18, py1 = py0 + PH;
    if (!ser.length) { y = py1 + GAP; continue; }
    const bins = ser[0].hist.bins, lo = bins[0].x0, hi = bins[bins.length - 1].x1;
    const cmax = Math.max(1, ...ser.flatMap((s) => s.hist.bins.map((b) => b.count)));
    const cStep = niceStep(cmax, 4), cTop = Math.ceil(cmax / cStep) * cStep;
    const left = 40 + g.measureText(String(cTop)), right = W - 28;
    const vx = (v) => left + 8 + ((v - lo) / (hi - lo)) * (right - left - 16);
    const cyv = (c) => py1 - (c / cTop) * (py1 - py0 - 8);
    g.roundRect(left, py0, right - left, py1 - py0, 6, PANEL);
    for (let c = 0; c <= cTop + 1e-9; c += cStep) { const yy = Math.round(cyv(c)); g.fillRect(left + 1, yy, right - left - 2, 1, GRID); g.text(String(+c.toFixed(6)), left - 8, yy, { color: DIM, align: "right", baseline: "middle" }); }
    ser.forEach((s, si) => {
      const alpha = ser.length === 1 ? 0.85 : 0.38;
      const [r, gg, b] = parseHex(s.color);
      for (const q of s.hist.bins) {
        if (!q.count) continue;
        const xa = vx(q.x0) + 1, xb = vx(q.x1) - 1, ya = cyv(q.count);
        g.fillRect(Math.round(xa), Math.round(ya), Math.max(1, Math.round(xb - xa)), Math.round(py1 - ya), [r, gg, b, alpha]);
        if (ser.length > 1) g.polyline([[xa, py1], [xa, ya], [xb, ya], [xb, py1]], s.color, 1.6, s.dash ? { dash: [4, 3] } : {});
      }
      const st = s.hist.stats;
      if (st) {
        g.line(vx(st.mean), py0 + 4, vx(st.mean), py1, s.color, 1.5, { dash: [5, 4] });
        g.line(vx(st.median), py0 + 4, vx(st.median), py1, s.color, 1.5);
        const lbl = `${ser.length > 1 ? `${s.label} ` : ""}median ${fmtStat(st.median)}`;
        g.text(lbl, Math.min(right - g.measureText(lbl) - 6, vx(st.median) + 5), py0 + 8 + si * 16, { color: s.color, bold: true, baseline: "middle" });
      }
    });
    g.strokeRoundRect(left, py0, right - left, py1 - py0, 6, FRAME, 1);
    // value ticks: integer bins label their integers, else nice ticks
    const first = ser[0].hist;
    if (first.integer && bins.length <= 24) for (const q of bins) { const c = Math.round((q.x0 + q.x1) / 2); g.text(P.bool && (c === 0 || c === 1) ? (c ? "true" : "false") : String(c), vx((q.x0 + q.x1) / 2), py1 + 6, { color: DIM, align: "center" }); }
    else {
      const st = niceStep(hi - lo, Math.max(3, Math.floor((right - left) / 110))), ref = Math.max(Math.abs(lo), Math.abs(hi));
      for (let v = Math.ceil(lo / st - 1e-9) * st; v <= hi + 1e-9; v += st) g.text(fmtTick(v, st, ref), vx(v), py1 + 6, { color: DIM, align: "center" });
    }
    g.text("samples per bin · dashed = mean, solid = median", right, py1 + 22, { color: DIM, align: "right" });
    y = py1 + GAP;
  }
  return g;
}

function parseHex(c) {
  const h = String(c).replace("#", "");
  return h.length >= 6 ? [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)] : [200, 200, 200];
}

export const histPNG = (spec) => renderHist(spec).toPNG();
