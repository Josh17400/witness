// Witness media: motion v2 — several objects, camera scroll, stutter and flicker.
//
//   components(mask, w, h, { region, minPixels })     -> blobs of a change mask (8-connected): { count, bbox, cx, cy }
//   trackObjects(perFrame, { maxDist, gap })            -> tracks across frames (greedy nearest predicted centroid)
//   estimateShift(a, b, { region, maxShift })           -> how far the picture moved from a to b: { dx, dy, sub, score }
//   cameraPath(frames, opts)                            -> per-frame camera motion + jitter (deviation from smooth)
//   mosaicPlate(frames, offsets, region)                -> a clean background in world space for a scrolling camera
//   trackReport(track)                                  -> path, steps, jitter, stutters (repeated frame / 2× step)
//
// Images are { width, height, data: RGBA }. A camera that moves right shows the world moving left: dx < 0.
// "camera" figures below are the camera's own motion (the negative of the picture shift).

import { fft } from "./audio-analysis.js";

const r3 = (x) => Math.round(x * 1000) / 1000;

// ---------------------------------------------------------------------------
// connected components
// ---------------------------------------------------------------------------

/** 8-connected blobs of a 0/1 mask inside region R (default: the whole mask), largest first. */
export function components(mask, w, h, { region = null, minPixels = 4 } = {}) {
  const R = region || { x: 0, y: 0, w, h };
  const label = new Int32Array(w * h).fill(-1);
  const out = [], stack = [];
  for (let y = R.y; y < R.y + R.h; y++) {
    for (let x = R.x; x < R.x + R.w; x++) {
      const i0 = y * w + x;
      if (!mask[i0] || label[i0] >= 0) continue;
      const id = out.length;
      let count = 0, sx = 0, sy = 0, x0 = x, x1 = x, y0 = y, y1 = y;
      label[i0] = id; stack.push(i0);
      while (stack.length) {
        const i = stack.pop(), px = i % w, py = (i / w) | 0;
        count++; sx += px; sy += py;
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy;
          if (ny < R.y || ny >= R.y + R.h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx;
            if (nx < R.x || nx >= R.x + R.w) continue;
            const n = ny * w + nx;
            if (mask[n] && label[n] < 0) { label[n] = id; stack.push(n); }
          }
        }
      }
      out.push({ count, bbox: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, cx: sx / count, cy: sy / count });
    }
  }
  return out.filter((c) => c.count >= minPixels).sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// tracking
// ---------------------------------------------------------------------------

/**
 * Follow blobs across frames. perFrame[i] = components of frame i. Each live track predicts its next centroid
 * (last position + last step); pairs (track, blob) are matched greedily by distance up to maxDist. A track that
 * finds no blob is "occluded" when its predicted position lies inside another blob's box (two sprites merged
 * while crossing) and "gone" otherwise; after more than `gap` missing frames it ends. A track that comes back after
 * being gone 1..gap frames has flickered.
 * Returns [{ id, first, last, frames: [{ i, cx, cy, count, bbox } | { i, missing: "occluded" | "gone" }], flicker: [{ from, to }] }]
 */
export function trackObjects(perFrame, { maxDist = null, gap = 3 } = {}) {
  const sizes = perFrame.flat().map((c) => Math.max(c.bbox.w, c.bbox.h)).sort((a, b) => a - b);
  const md = maxDist ?? Math.max(24, 2 * (sizes[sizes.length >> 1] || 8));
  const tracks = [];
  let nextId = 1;
  perFrame.forEach((comps, i) => {
    const live = tracks.filter((t) => !t.ended);
    const pairs = [];
    for (const t of live) {
      const seen = t.frames.filter((f) => !f.missing);
      const last = seen[seen.length - 1], prev = seen[seen.length - 2];
      const lag = i - last.i;
      const vx = prev ? (last.cx - prev.cx) / (last.i - prev.i) : 0, vy = prev ? (last.cy - prev.cy) / (last.i - prev.i) : 0;
      t.pred = { x: last.cx + vx * lag, y: last.cy + vy * lag };
      comps.forEach((c, k) => { const d = Math.hypot(c.cx - t.pred.x, c.cy - t.pred.y); if (d <= md * lag) pairs.push({ t, k, d }); });
    }
    // a blob that holds the predicted positions of 2+ tracks and is clearly bigger than they are: sprites that
    // merged (crossing, overlapping). Its centroid belongs to none of them, so they are occluded this frame.
    const usedT = new Set(), usedC = new Set();
    const typical = (t) => { const c = t.frames.filter((f) => !f.missing).map((f) => f.count).sort((a, b) => a - b); return c[c.length >> 1] || 1; };
    const insideBox = (p, b) => p.x >= b.x - 2 && p.x <= b.x + b.w + 1 && p.y >= b.y - 2 && p.y <= b.y + b.h + 1;
    comps.forEach((c, k) => {
      const holders = live.filter((t) => insideBox(t.pred, c.bbox) && c.count > 1.3 * typical(t));
      if (holders.length < 2) return;
      usedC.add(k);
      for (const t of holders) { usedT.add(t); t.frames.push({ i, missing: "occluded" }); }
    });
    pairs.sort((a, b) => a.d - b.d);
    for (const p of pairs) {
      if (usedT.has(p.t) || usedC.has(p.k)) continue;
      usedT.add(p.t); usedC.add(p.k);
      const c = comps[p.k];
      // back after missing frames: a flicker when it was simply gone (not hidden inside another blob)
      const missed = p.t.frames.slice(p.t.frames.findLastIndex((f) => !f.missing) + 1);
      if (missed.length && missed.every((f) => f.missing === "gone")) p.t.flicker.push({ from: missed[0].i, to: missed[missed.length - 1].i });
      p.t.frames.push({ i, cx: c.cx, cy: c.cy, count: c.count, bbox: c.bbox });
      p.t.last = i;
    }
    for (const t of live) {
      if (usedT.has(t)) continue;
      const inside = comps.some((c) => insideBox(t.pred, c.bbox));
      t.frames.push({ i, missing: inside ? "occluded" : "gone" });
      if (i - t.last > gap) t.ended = true;
    }
    comps.forEach((c, k) => {
      if (usedC.has(k)) return;
      tracks.push({ id: nextId++, first: i, last: i, frames: [{ i, cx: c.cx, cy: c.cy, count: c.count, bbox: c.bbox }], flicker: [], ended: false });
    });
  });
  for (const t of tracks) {
    while (t.frames.length && t.frames[t.frames.length - 1].missing) t.frames.pop();   // trailing misses: it left
    delete t.pred; delete t.ended;
  }
  return tracks;
}

/** Savitzky–Golay (quadratic, 5 points): smooth paths keep constant acceleration exactly. */
const SG5 = [-3, 12, 17, 12, -3].map((c) => c / 35);

/** Residuals of a path from a smooth quadratic fit (5-point windows): [{ k, r }] for every point with a full window. */
function residuals(points) {
  const out = [];
  for (let k = 2; k + 2 < points.length; k++) {
    const w = points.slice(k - 2, k + 3);
    if (w.some((p) => !p)) continue;
    const sx = w.reduce((a, p, j) => a + SG5[j] * p[0], 0), sy = w.reduce((a, p, j) => a + SG5[j] * p[1], 0);
    out.push({ k, r: Math.hypot(points[k][0] - sx, points[k][1] - sy) });
  }
  return out;
}

/**
 * Facts about one track: frames seen, path length, net move, step stats, jitter (RMS px off a smooth path), and
 * stutters: a repeated frame (no movement between moving frames) or a step about twice its neighbours.
 * `offset(i)` (optional) gives the camera position at frame i so steps are in world space.
 */
export function trackReport(track, offset = null) {
  // frames where the blob is far bigger or smaller than usual: merged with something (another sprite, a stale patch
  // of background) or partly hidden; their centroid isn't the object's, so they don't count as steps
  const vis = track.frames.filter((f) => !f.missing);
  const med = (a) => { const b = [...a].sort((p, q) => p - q); return b[b.length >> 1] || 0; };
  const typical = med(vis.map((f) => f.count)), tw = med(vis.map((f) => f.bbox.w)), th = med(vis.map((f) => f.bbox.h));
  const grown = (f) => f.bbox.w >= tw + Math.max(2, 0.1 * tw) || f.bbox.h >= th + Math.max(2, 0.1 * th);
  const odd = new Set(vis.filter((f) => f.count > 1.4 * typical || f.count < 0.6 * typical || grown(f)).map((f) => f.i));
  const pts = [];
  for (const f of track.frames) {
    if (f.missing || odd.has(f.i)) { pts[f.i - track.first] = null; continue; }
    const o = offset ? offset(f.i) : [0, 0];
    pts[f.i - track.first] = [f.cx + o[0], f.cy + o[1]];
  }
  const steps = [];
  for (let k = 1; k < pts.length; k++) if (pts[k] && pts[k - 1]) steps.push({ i: track.first + k, dx: pts[k][0] - pts[k - 1][0], dy: pts[k][1] - pts[k - 1][1] });
  const len = steps.map((s) => Math.hypot(s.dx, s.dy));
  const path = len.reduce((a, b) => a + b, 0);
  const seen = pts.filter(Boolean);
  const net = seen.length ? [seen[seen.length - 1][0] - seen[0][0], seen[seen.length - 1][1] - seen[0][1]] : [0, 0];
  const res = residuals(pts);
  const jitter = res.length ? Math.sqrt(res.reduce((a, q) => a + q.r * q.r, 0) / res.length) : null;
  const stutters = [];
  for (let k = 1; k + 1 < len.length; k++) {
    if (steps[k - 1].i !== steps[k].i - 1 || steps[k + 1].i !== steps[k].i + 1) continue;
    const a = len[k - 1], b = len[k + 1], m = (a + b) / 2;
    if (a < 0.5 || b < 0.5 || Math.abs(a - b) > 0.5 * m) continue;   // only inside a steady motion
    if (len[k] < 0.25 * m) stutters.push({ i: steps[k].i, kind: "repeated frame", step: r3(len[k]), expected: r3(m) });
    else if (len[k] > 1.75 * m) stutters.push({ i: steps[k].i, kind: "double step", step: r3(len[k]), expected: r3(m) });
  }
  const sizes = track.frames.filter((f) => !f.missing).map((f) => f.count);
  const all = track.frames.filter((f) => !f.missing);
  // static (in the world, when a camera offset is given): no step and no net move
  const wpos = all.map((f) => { const o = offset ? offset(f.i) : [0, 0]; return [f.cx + o[0], f.cy + o[1]]; });
  const span = wpos.length ? Math.hypot(wpos[wpos.length - 1][0] - wpos[0][0], wpos[wpos.length - 1][1] - wpos[0][1]) : 0;
  return {
    id: track.id, first: track.first, last: track.last, seen: all.length,
    irregular: [...odd].sort((a, b) => a - b),
    static: path < 1 && span < 1,
    occluded: track.frames.filter((f) => f.missing === "occluded").length,
    path: r3(path), net: net.map(r3), meanStep: r3(len.length ? path / len.length : 0), maxStep: r3(len.length ? Math.max(...len) : 0),
    jitter: jitter == null ? null : r3(jitter), stutters, flicker: track.flicker,
    size: sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0,
  };
}

// ---------------------------------------------------------------------------
// camera: global shift between frames
// ---------------------------------------------------------------------------

const pow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

/** Luminance of an image region, downsampled by k (box average), as Float64Array rows. */
function luma(img, R, k) {
  const w = Math.floor(R.w / k), h = Math.floor(R.h / k), out = new Float64Array(w * h), d = img.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) { const o = ((R.y + y * k + j) * img.width + R.x + x * k + i) * 4; s += 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]; }
    out[y * w + x] = s / (k * k);
  }
  return { w, h, v: out };
}

/** 2-D FFT in place on N×M (both powers of two) row-major arrays. */
function fft2(re, im, N, M) {
  const rr = new Float64Array(N), ri = new Float64Array(N);
  for (let y = 0; y < M; y++) { const o = y * N; const r = re.subarray(o, o + N), i = im.subarray(o, o + N); fft(r, i); }
  const cr = new Float64Array(M), ci = new Float64Array(M);
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < M; y++) { cr[y] = re[y * N + x]; ci[y] = im[y * N + x]; }
    fft(cr, ci);
    for (let y = 0; y < M; y++) { re[y * N + x] = cr[y]; im[y * N + x] = ci[y]; }
  }
  void rr; void ri;
}

/** Phase correlation of two equal-size luminance planes: the integer shift (dx, dy) with b(x) ≈ a(x - d). */
function phaseCorrelate(A, B, maxShift) {
  const N = pow2(A.w), M = pow2(A.h);
  const mk = (P) => {
    const re = new Float64Array(N * M), im = new Float64Array(N * M);
    let mean = 0;
    for (let i = 0; i < P.v.length; i++) mean += P.v[i];
    mean /= P.v.length || 1;
    for (let y = 0; y < P.h; y++) {
      const wy = 0.5 - 0.5 * Math.cos((2 * Math.PI * (y + 0.5)) / P.h);
      for (let x = 0; x < P.w; x++) re[y * N + x] = (P.v[y * P.w + x] - mean) * wy * (0.5 - 0.5 * Math.cos((2 * Math.PI * (x + 0.5)) / P.w));
    }
    fft2(re, im, N, M);
    return { re, im };
  };
  const FA = mk(A), FB = mk(B);
  const re = new Float64Array(N * M), im = new Float64Array(N * M);
  for (let i = 0; i < N * M; i++) {
    // conj(FA) * FB: the peak sits at the shift d with b(x) = a(x - d)
    const xr = FA.re[i] * FB.re[i] + FA.im[i] * FB.im[i], xi = FA.re[i] * FB.im[i] - FA.im[i] * FB.re[i];
    const mag = Math.hypot(xr, xi) || 1e-12;
    re[i] = xr / mag; im[i] = -(xi / mag);   // conjugate: the inverse FFT via the forward one
  }
  fft2(re, im, N, M);
  let best = -Infinity, bx = 0, by = 0;
  for (let y = 0; y < M; y++) for (let x = 0; x < N; x++) {
    const sx = x > N / 2 ? x - N : x, sy = y > M / 2 ? y - M : y;
    if (Math.abs(sx) > maxShift || Math.abs(sy) > maxShift) continue;
    const v = re[y * N + x];
    if (v > best) { best = v; bx = sx; by = sy; }
  }
  return { dx: bx, dy: by, peak: best / (N * M) };
}

/** Mean absolute luminance difference between a(x, y) and b(x + dx, y + dy) over their overlap in R (every 2nd px). */
function sad(a, b, R, dx, dy) {
  let s = 0, n = 0;
  const da = a.data, db = b.data, W = a.width;
  for (let y = R.y; y < R.y + R.h; y += 2) {
    const y2 = y + dy;
    if (y2 < R.y || y2 >= R.y + R.h) continue;
    for (let x = R.x; x < R.x + R.w; x += 2) {
      const x2 = x + dx;
      if (x2 < R.x || x2 >= R.x + R.w) continue;
      const o = (y * W + x) * 4, q = (y2 * W + x2) * 4;
      s += Math.abs(da[o] - db[q]) + Math.abs(da[o + 1] - db[q + 1]) + Math.abs(da[o + 2] - db[q + 2]);
      n++;
    }
  }
  return n ? s / n : Infinity;
}

/** The share of pixels (every 2nd px) of R that differ by more than 16 on some channel between a and b, unshifted. */
/** The share of pixels that changed (every 2nd pixel each way) and how many separate blobs they form. */
function changedShare(a, b, R) {
  let c = 0, n = 0;
  const da = a.data, db = b.data, W = a.width, gw = Math.ceil(R.w / 2), gh = Math.ceil(R.h / 2), mask = new Uint8Array(gw * gh);
  for (let y = R.y, gy = 0; y < R.y + R.h; y += 2, gy++) for (let x = R.x, gx = 0; x < R.x + R.w; x += 2, gx++) {
    const o = (y * W + x) * 4;
    if (Math.abs(da[o] - db[o]) > 16 || Math.abs(da[o + 1] - db[o + 1]) > 16 || Math.abs(da[o + 2] - db[o + 2]) > 16) { c++; mask[gy * gw + gx] = 1; }
    n++;
  }
  // blobs only matter when few pixels changed (the case they decide); cap the work
  const blobs = c && c <= 20000 ? components(mask, gw, gh, { minPixels: 1 }).length : null;
  return { share: n ? c / n : 0, blobs };
}

/**
 * How far the picture moved from a to b: b(x) ≈ a(x - [dx, dy]) (integer px, from phase correlation at half
 * resolution refined by a full-resolution search), with a sub-pixel estimate (parabola through the match errors)
 * and score = the remaining mean difference (0 = a perfect match).
 */
export function estimateShift(a, b, { region = null, maxShift = 32, stillShare = 0 } = {}) {
  const R = region || { x: 0, y: 0, w: a.width, h: a.height };
  const k = R.w >= 160 && R.h >= 120 ? 2 : 1;
  const pc = phaseCorrelate(luma(a, R, k), luma(b, R, k), Math.ceil(maxShift / k));
  // refine: the best full-resolution match around the coarse shift (sad(a, b, d) compares a(x) with b(x + d))
  let best = { dx: pc.dx * k, dy: pc.dy * k, e: Infinity };
  for (let ey = -k; ey <= k; ey++) for (let ex = -k; ex <= k; ex++) {
    const dx = pc.dx * k + ex, dy = pc.dy * k + ey;
    if (Math.abs(dx) > maxShift || Math.abs(dy) > maxShift) continue;
    const e = sad(a, b, R, dx, dy);
    if (e < best.e) best = { dx, dy, e };
  }
  // zero motion is the common case: prefer it when it matches as well, or when almost all of the picture stayed
  // put (under stillShare of it changed; cameraPath and measure motion use 2%) in a few blobs (up to 4): then what
  // moved is a sprite or two on a plain background, not the camera. Many scattered changes that one shift explains
  // far better than no shift (best error under half of it) are a sparse scene scrolling: a starfield, a sky.
  const e0 = sad(a, b, R, 0, 0);
  let still = e0 <= best.e + 1e-9;
  if (!still && stillShare > 0) {
    const ch = changedShare(a, b, R);
    if (ch.share < stillShare) still = ch.blobs != null && ch.blobs <= 4 ? true : !(best.e < 0.5 * e0);
  }
  if (still) best = { dx: 0, dy: 0, e: e0 };
  const para = (em, e0_, ep) => { const den = em - 2 * e0_ + ep; return den > 1e-9 ? Math.max(-0.5, Math.min(0.5, (em - ep) / (2 * den))) : 0; };
  const sx = para(sad(a, b, R, best.dx - 1, best.dy), best.e, sad(a, b, R, best.dx + 1, best.dy));
  const sy = para(sad(a, b, R, best.dx, best.dy - 1), best.e, sad(a, b, R, best.dx, best.dy + 1));
  return { dx: best.dx, dy: best.dy, sub: [r3(best.dx + sx), r3(best.dy + sy)], score: r3(best.e), coarse: [pc.dx * k, pc.dy * k] };
}

/**
 * The camera's motion over a clip: per step, camera = -(picture shift). Each step is compared with the straight line
 * through the (up to) 4 steps around it: jitter = the RMS of those deviations (px per frame; 0 for a steady or
 * smoothly accelerating scroll), uneven = the steps that deviate by >= 0.75 px (a hitch or a shake in the scroll).
 * Returns { moving, steps: [{ i, dx, dy }], positions: [[x, y] per frame] (camera offset vs frame 0), jitter, uneven,
 * total, perFrame }.
 */
export function cameraPath(frames, { region = null, maxShift = 32 } = {}) {
  const steps = [], positions = [[0, 0]];
  for (let i = 1; i < frames.length; i++) {
    const s = estimateShift(frames[i - 1], frames[i], { region, maxShift, stillShare: 0.02 });
    const st = { i, dx: -s.dx, dy: -s.dy, score: s.score };
    steps.push(st);
    positions.push([positions[i - 1][0] + st.dx, positions[i - 1][1] + st.dy]);
  }
  return summarizeCamera(steps, positions);
}

/** Camera facts from per-step moves (also used by the streaming CLI). */
export function summarizeCamera(steps, positions) {
  const moving = steps.some((s) => s.dx || s.dy);
  // what a smooth scroll would do at step k: the straight line through the (up to) 4 steps around it
  const trend = (ks, vs, k) => {
    const mk = ks.reduce((a, b) => a + b, 0) / ks.length, mv = vs.reduce((a, b) => a + b, 0) / vs.length;
    let sxy = 0, sxx = 0;
    ks.forEach((x, j) => { sxy += (x - mk) * (vs[j] - mv); sxx += (x - mk) ** 2; });
    return mv + (sxx > 0 ? (sxy / sxx) * (k - mk) : 0);
  };
  const devs = [];
  for (let k = 0; k < steps.length; k++) {
    const ks = [k - 2, k - 1, k + 1, k + 2].filter((j) => j >= 0 && j < steps.length);
    if (ks.length < 2) continue;
    const ex = trend(ks, ks.map((j) => steps[j].dx), k), ey = trend(ks, ks.map((j) => steps[j].dy), k);
    devs.push({ i: steps[k].i, d: Math.hypot(steps[k].dx - ex, steps[k].dy - ey), expected: [ex, ey], got: [steps[k].dx, steps[k].dy] });
  }
  const jitter = devs.length ? Math.sqrt(devs.reduce((a, q) => a + q.d * q.d, 0) / devs.length) : null;
  const uneven = devs.filter((q) => q.d >= 0.75).map((q) => ({ i: q.i, got: q.got, expected: q.expected }));
  const total = positions[positions.length - 1];
  return { moving, steps, positions, jitter: jitter == null ? null : r3(jitter), uneven, total, perFrame: steps.length ? [r3(total[0] / steps.length), r3(total[1] / steps.length)] : [0, 0] };
}

// ---------------------------------------------------------------------------
// a clean background for a scrolling camera
// ---------------------------------------------------------------------------

/**
 * A world-space background from frames with known integer camera offsets (offsets[i] = [x, y] of frame i's
 * top-left in the world): the per-pixel median of up to 15 frames covering each world pixel. Returns
 * { plate: { width, height, data }, origin: [x0, y0] } (world coordinate of the plate's top-left).
 */
export function mosaicPlate(frames, offsets, { maxSamples = 15 } = {}) {
  const w = frames[0].width, h = frames[0].height;
  const xs = offsets.map((o) => o[0]), ys = offsets.map((o) => o[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), W = Math.max(...xs) - x0 + w, H = Math.max(...ys) - y0 + h;
  const S = Math.min(frames.length, maxSamples);
  const pick = Array.from({ length: S }, (_, i) => (S === 1 ? 0 : Math.round((i * (frames.length - 1)) / (S - 1))));
  const data = new Uint8Array(W * H * 4), vals = [];
  for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
    const o = (Y * W + X) * 4;
    for (let c = 0; c < 4; c++) {
      vals.length = 0;
      for (const fi of pick) {
        const x = X + x0 - offsets[fi][0], y = Y + y0 - offsets[fi][1];
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        vals.push(frames[fi].data[(y * w + x) * 4 + c]);
      }
      if (!vals.length) { data[o + c] = c === 3 ? 0 : 0; continue; }
      vals.sort((p, q) => p - q);
      data[o + c] = vals[vals.length >> 1];
    }
  }
  return { plate: { width: W, height: H, data }, origin: [x0, y0] };
}

/** The change mask of a frame against a world plate at camera offset `off` (pixels the plate lacks never count). */
export function maskAgainstMosaic(frame, mosaic, off, region, threshold = 16) {
  const w = frame.width, h = frame.height, P = mosaic.plate, [ox, oy] = mosaic.origin;
  const R = region || { x: 0, y: 0, w, h };
  const mask = new Uint8Array(w * h);
  for (let y = R.y; y < R.y + R.h; y++) for (let x = R.x; x < R.x + R.w; x++) {
    const X = x + off[0] - ox, Y = y + off[1] - oy;
    if (X < 0 || Y < 0 || X >= P.width || Y >= P.height) continue;
    const o = (y * w + x) * 4, q = (Y * P.width + X) * 4;
    if (P.data[q + 3] === 0) continue;
    if (Math.abs(frame.data[o] - P.data[q]) > threshold || Math.abs(frame.data[o + 1] - P.data[q + 1]) > threshold || Math.abs(frame.data[o + 2] - P.data[q + 2]) > threshold) mask[y * w + x] = 1;
  }
  return mask;
}
