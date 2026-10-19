// Witness media: line the game's state up with its pixels (measure align, shot --annotate).
//
//   findBlobs(img, { plate, threshold, minPixels, maxPixels })  -> sprite-sized blobs: against a clean plate, or
//                                                                 against the picture's most common colour
//   fitProjection(entities, blobs, { scales, tol })             -> screen = a·state + b per axis, the matches, the
//                                                                 entities drawn away from their state position,
//                                                                 and the ones not found
//   annotate(img, items, { zoom, title })                       -> a PNG with boxes and labels drawn over the shot
//
// entities: [{ id, type, x, y, box?: [w, h] | [x, y, w, h] }] in state units.

import { Raster } from "./raster.js";
import { components } from "./track.js";

const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * The background as a small palette: the most common colours (4 bits per channel), each at least 1% of the picture,
 * taken until they cover 90% of it (a flat colour, or floor + walls + grid lines). Returns their mean colours.
 */
export function backgroundPalette(img) {
  const counts = new Map(), d = img.data, n = img.width * img.height;
  const key = (o) => ((d[o] >> 4) << 8) | ((d[o + 1] >> 4) << 4) | (d[o + 2] >> 4);
  for (let o = 0; o < d.length; o += 4) { const k = key(o); counts.set(k, (counts.get(k) || 0) + 1); }
  const sorted = [...counts].sort((x, y) => y[1] - x[1]);
  const keys = [];
  let cov = 0;
  for (const [k, c] of sorted) { if (c < n * 0.01 || cov >= 0.9 * n) break; keys.push(k); cov += c; }
  const sums = new Map(keys.map((k) => [k, [0, 0, 0, 0]]));
  for (let o = 0; o < d.length; o += 4) { const acc = sums.get(key(o)); if (acc) { acc[0] += d[o]; acc[1] += d[o + 1]; acc[2] += d[o + 2]; acc[3]++; } }
  return keys.map((k) => { const a = sums.get(k); return [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
}

/**
 * Blobs that could be sprites: pixels that differ from a clean plate (when given) or from every colour of the
 * background palette, grouped 8-connected, between minPixels and maxPixels in size (walls and floors are dropped).
 */
export function findBlobs(img, { plate = null, threshold = 24, minPixels = 6, maxPixels = null } = {}) {
  const w = img.width, h = img.height, d = img.data, mask = new Uint8Array(w * h);
  const pal = plate ? null : backgroundPalette(img);
  const near = (r, g, b, c) => Math.abs(r - c[0]) <= threshold && Math.abs(g - c[1]) <= threshold && Math.abs(b - c[2]) <= threshold;
  for (let i = 0, o = 0; i < w * h; i++, o += 4) {
    if (plate) { if (!near(d[o], d[o + 1], d[o + 2], [plate.data[o], plate.data[o + 1], plate.data[o + 2]])) mask[i] = 1; continue; }
    let bg = false;
    for (const c of pal) if (near(d[o], d[o + 1], d[o + 2], c)) { bg = true; break; }
    if (!bg) mask[i] = 1;
  }
  const max = maxPixels ?? Math.round(w * h * 0.04);
  return components(mask, w, h, { minPixels }).filter((c) => c.count <= max);
}

/** Least squares for v' = a·v + b over pairs. */
function lsq(pairs) {
  const n = pairs.length, mx = pairs.reduce((s, p) => s + p[0], 0) / n, my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  const a = sxx > 1e-9 ? sxy / sxx : 1;
  return { a, b: my - a * mx };
}

/**
 * Fit screen = (ax·x + bx, ay·y + by) from entity state positions to blob centroids, without knowing which blob is
 * which entity: for each candidate scale, every (entity, blob) pair votes for an offset; the offset with the most
 * entities landing within `tol` px of a blob wins; then least squares over those matches refines it.
 * Returns { ok, ax, bx, ay, by, residual, matched, total, matches: [{ entity, blob, dx, dy, dist }], offsets: [...],
 * missing: [entity] } — offsets are matched entities drawn more than `tol` but at most `far` px from their state
 * position (sprite anchors, art offsets), missing are entities with no blob near them at all.
 */
export function fitProjection(entities, blobs, { scales = [1, 2, 3, 4, 0.5, 1.5], tol = 2.5, far = 12, hint = null } = {}) {
  const ents = entities.filter((e) => Number.isFinite(e.x) && Number.isFinite(e.y));
  if (!ents.length || !blobs.length) return { ok: false, reason: !ents.length ? "no entities with a position" : "no sprite-sized blobs in the picture" };
  const cands = [...new Set([...(hint ? [hint.scale] : []), ...scales])];
  const nearest = (px, py) => { let best = null; for (const b of blobs) { const dd = Math.hypot(b.cx - px, b.cy - py); if (!best || dd < best.d) best = { b, d: dd }; } return best; };
  const scoreOf = (s, ox, oy) => { let n = 0, err = 0; for (const e of ents) { const q = nearest(s * e.x + ox, s * e.y + oy); if (q && q.d <= tol) { n++; err += q.d; } } return { n, err }; };
  let best = null;
  for (const s of cands) {
    const votes = new Map();
    for (const e of ents) for (const b of blobs) {
      const k = `${Math.round(b.cx - s * e.x)},${Math.round(b.cy - s * e.y)}`;
      votes.set(k, (votes.get(k) || 0) + 1);
    }
    const top = [...votes].sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (hint && s === hint.scale) top.unshift([`${Math.round(hint.ox)},${Math.round(hint.oy)}`, Infinity]);
    for (const [k] of top) {
      const [ox, oy] = k.split(",").map(Number);
      const sc = scoreOf(s, ox, oy);
      if (!best || sc.n > best.n || (sc.n === best.n && sc.err < best.err)) best = { s, ox, oy, ...sc };
    }
  }
  if (!best || best.n < Math.min(2, ents.length)) {
    // one sprite can't determine a fit, but it can confirm the game's own camera
    const h = hint && scoreOf(hint.scale, hint.ox, hint.oy);
    if (h && h.n >= 1) best = { s: hint.scale, ox: hint.ox, oy: hint.oy, ...h, fromHint: true };
    else return { ok: false, reason: "no consistent placement: fewer than 2 entities land on a blob under any simple scale + offset (pass --project, or a state.camera)" };
  }
  // refine with least squares over the pairs that agree, then classify every entity
  const pairsX = [], pairsY = [];
  for (const e of ents) { const q = nearest(best.s * e.x + best.ox, best.s * e.y + best.oy); if (q && q.d <= tol) { pairsX.push([e.x, q.b.cx]); pairsY.push([e.y, q.b.cy]); } }
  let fx = lsq(pairsX), fy = lsq(pairsY);
  if (best.fromHint) { fx = { a: best.s, b: best.ox + (pairsX.length ? pairsX.reduce((t, p) => t + p[1] - best.s * p[0] - best.ox, 0) / pairsX.length : 0) }; fy = { a: best.s, b: best.oy + (pairsY.length ? pairsY.reduce((t, p) => t + p[1] - best.s * p[0] - best.oy, 0) / pairsY.length : 0) }; }
  if (!best.fromHint && new Set(pairsX.map((p) => p[0])).size < 2) fx = { a: best.s, b: best.ox };   // one x value: keep the scale
  if (!best.fromHint && new Set(pairsY.map((p) => p[0])).size < 2) fy = { a: best.s, b: best.oy };
  const matches = [], offsets = [], missing = [];
  const used = new Set();
  for (const e of ents) {
    const px = fx.a * e.x + fx.b, py = fy.a * e.y + fy.b;
    const q = nearest(px, py);
    if (!q || q.d > far) { missing.push({ entity: e, at: [r3(px), r3(py)] }); continue; }
    const m = { entity: e, blob: q.b, at: [r3(px), r3(py)], dx: r3(q.b.cx - px), dy: r3(q.b.cy - py), dist: r3(q.d) };
    used.add(q.b);
    if (q.d <= tol) matches.push(m); else offsets.push(m);
  }
  const all = [...matches, ...offsets];
  const residual = matches.length ? Math.sqrt(matches.reduce((s, m) => s + m.dist ** 2, 0) / matches.length) : null;
  return { ok: true, fromHint: !!best.fromHint, ax: r3(fx.a), bx: r3(fx.b), ay: r3(fy.a), by: r3(fy.b), residual: residual == null ? null : r3(residual), matched: matches.length, total: ents.length, matches, offsets, missing, all, unusedBlobs: blobs.filter((b) => !used.has(b)).length };
}

/**
 * Hitbox vs art for matched entities with a box ([w, h] or [x, y, w, h], state units): the box in screen pixels
 * against the blob's bounding box. [{ entity, box: [w, h], art: [w, h], dw, dh, verdict }]
 */
export function hitboxes(fit) {
  const out = [];
  for (const m of fit.all || []) {
    const bx = m.entity.box;
    if (!Array.isArray(bx) || bx.length < 2) continue;
    const bw = (bx.length >= 4 ? bx[2] : bx[0]) * Math.abs(fit.ax), bh = (bx.length >= 4 ? bx[3] : bx[1]) * Math.abs(fit.ay);
    const aw = m.blob.bbox.w, ah = m.blob.bbox.h;
    const dw = r3(bw - aw), dh = r3(bh - ah);
    const verdict = dw > 2 || dh > 2 ? "hitbox larger than the art" : dw < -2 || dh < -2 ? "hitbox smaller than the art" : "matches the art";
    out.push({ entity: m.entity, box: [r3(bw), r3(bh)], art: [aw, ah], dw, dh, verdict });
  }
  return out;
}

const PALETTE = ["#4cc9f0", "#ffd166", "#3ddc97", "#ff4d8d", "#a78bfa", "#ff9f43", "#8ecae6", "#f15bb5"];

/**
 * Draw items over a picture: [{ x, y, w, h, label, color? }] in the picture's pixels (w/h 0 = a cross). Small pictures
 * are enlarged (crisp) so labels stay readable. Returns a PNG Buffer.
 */
export function annotate(img, items, { zoom = null, title = "" } = {}) {
  const k = zoom ?? (img.width < 640 ? Math.min(4, Math.ceil(640 / img.width)) : 1);
  const head = title ? 28 : 0;
  const g = new Raster(img.width * k, img.height * k + head, "#0b1020");
  g.drawImage(img, { dx: 0, dy: head, dw: img.width * k, dh: img.height * k, smooth: "nearest" });
  if (title) g.text(g.fitText(title, g.width - 16), 8, 14, { color: "#e6ebff", bold: true, baseline: "middle" });
  const types = [...new Set(items.map((it) => it.group ?? it.label))];
  items.forEach((it) => {
    const c = it.color || PALETTE[types.indexOf(it.group ?? it.label) % PALETTE.length];
    const x = it.x * k, y = it.y * k + head;
    if (it.w > 0 && it.h > 0) g.strokeRect(Math.round(x), Math.round(y), Math.round(it.w * k), Math.round(it.h * k), c, 2);
    else { g.line(x - 6, y, x + 6, y, c, 2); g.line(x, y - 6, x, y + 6, c, 2); }
    if (it.label) {
      const lw = g.measureText(it.label) + 6, ly = Math.max(head, Math.round(y) - 18);
      const lx = Math.min(g.width - lw, Math.max(0, Math.round(x)));
      g.fillRect(lx, ly, lw, 16, "rgba(11,16,32,0.8)");
      g.text(it.label, lx + 3, ly + 8, { color: c, baseline: "middle" });
    }
  });
  return g.toPNG();
}
