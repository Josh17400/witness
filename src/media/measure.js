// Witness media: pixel measurements a judge can trust (for `witness measure`).
//
// Images: PNG Buffers, Rasters or decoded { width, height, data: Uint8Array RGBA }.
// Masks:  Uint8Array(width * height) of 0/1, row-major (mask[y * width + x]).
// Boxes are { x, y, w, h } in image pixels. A centroid is [x, y], the mean of the selected pixels'
// integer coordinates (a square covering x 10..29 has centroid x 19.5). Nothing here touches the disk.
//
//   blockScale(img, k, { tolerance = 0, region, offset, minUniform = 99.5 }) ->
//     { k, offset: [ox, oy], region: { x, y, w, h }, cells, nonUniform, nonUniformPercent, blurry,
//       worst: [{ x, y, w, h, colors, spread }] }                        up to 10, worst first
//   detectScale(img, { tolerance = 0, region, maxK = 16, minUniform = 99.5 }) -> k   (1 if none)
//   maskDiff(a, b, { threshold = 16, region }) -> { mask, width, height, count, bbox, centroid }
//   maskFromColor(img, color, tolerance = 0) -> mask
//   maskFromRect(width, height, { x, y, w, h }) -> mask
//   maskBBox(mask, width, height) -> { x, y, w, h } | null
//   maskInfo(mask, width, height) -> { count, bbox, centroid }
//   maskStats(img, mask) -> { count, mean: [r, g, b, a], luminance, lab: [L, a, b] }
//   ringMask(mask, width, height, radius = 2) -> mask
//   contrast(img, maskA, maskB) -> { countA, countB, meanA, meanB, lumA, lumB, ratio, deltaE }
//   motion(frames, { region, threshold = 16, background = "first", minPixels = 1 }) ->
//     { width, height, region, background, threshold,
//       frames: [{ index, count, bbox, centroid, lowestRowSpan: { y, x0, x1 } | null }],
//       steps: [[dx, dy] | null],
//       summary: { framesWithObject, steps, pathLength, net: [dx, dy] | null, netDistance, maxStep, meanStep, jitter } }
//
// Regions ({ x, y, w, h }) are clipped to the image; a region entirely outside it is an error.
// Pixel comparisons (`threshold`, `tolerance`) are per channel, 0..255: two pixels differ when any
// RGBA channel differs by more than the threshold. Colour maths (luminance, Lab) ignores alpha.
// Fractional outputs are rounded (coordinates/lengths to 0.001, percents to 0.0001).

import { decodePNG } from "./png.js";
import { parseColor } from "./raster.js";
import { components, trackObjects, trackReport, maskAgainstMosaic } from "./track.js";

const MAX_WORST = 10;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const r4 = (v) => Math.round(v * 10000) / 10000;
const mod = (a, k) => ((a % k) + k) % k;

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

function toImage(img, fn, which = "") {
  const label = `${fn}: ${which ? `image ${which}` : "image"}`;
  if (img && !ArrayBuffer.isView(img) && img.width > 0 && img.height > 0 && img.data && img.data.length >= img.width * img.height * 4) return img;
  if (Buffer.isBuffer(img) || img instanceof Uint8Array) {
    try { return decodePNG(img); } catch (e) { throw new Error(`${label} is not a readable PNG (${e.message})`); }
  }
  throw new TypeError(`${label} must be a PNG Buffer, a Raster or { width, height, data }`);
}

function clipRegion(region, w, h, fn) {
  if (region == null) return { x: 0, y: 0, w, h };
  const rx = Number(region.x ?? 0), ry = Number(region.y ?? 0), rw = Number(region.w ?? w - rx), rh = Number(region.h ?? h - ry);
  if (![rx, ry, rw, rh].every(Number.isFinite)) throw new TypeError(`${fn}: region must be { x, y, w, h } numbers, got ${JSON.stringify(region)}`);
  const x0 = Math.max(0, Math.floor(rx)), y0 = Math.max(0, Math.floor(ry));
  const x1 = Math.min(w, Math.ceil(rx + rw)), y1 = Math.min(h, Math.ceil(ry + rh));
  if (x1 <= x0 || y1 <= y0) throw new RangeError(`${fn}: region ${JSON.stringify(region)} does not overlap the ${w}×${h} image`);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function checkMask(mask, w, h, fn, which = "mask") {
  if (!mask || typeof mask.length !== "number" || mask.length !== w * h) {
    throw new RangeError(`${fn}: ${which} must be a Uint8Array of ${w}×${h} = ${w * h} entries, got ${mask ? mask.length : mask}`);
  }
}

const clampThreshold = (t, fn, name = "threshold") => {
  const v = Number(t);
  if (!Number.isFinite(v)) throw new TypeError(`${fn}: ${name} must be a number 0..255, got ${t}`);
  return Math.max(0, Math.min(255, Math.round(v)));
};

/** One 32-bit word per pixel (for fast exact comparisons): a view when aligned, else a copy. */
function packed(img) {
  const d = img.data, n = img.width * img.height;
  if (ArrayBuffer.isView(d) && d.BYTES_PER_ELEMENT === 1 && d.byteOffset % 4 === 0) return new Uint32Array(d.buffer, d.byteOffset, n);
  const p = new Uint32Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 4) p[i] = (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
  return p;
}

/** Largest per-channel absolute difference between pixel i of A and pixel j of B. */
function delta(da, i, db, j) {
  const o = i * 4, q = j * 4;
  const r = Math.abs(da[o] - db[q]), g = Math.abs(da[o + 1] - db[q + 1]), b = Math.abs(da[o + 2] - db[q + 2]), a = Math.abs(da[o + 3] - db[q + 3]);
  return r > g ? (r > b ? (r > a ? r : a) : b > a ? b : a) : g > b ? (g > a ? g : a) : b > a ? b : a;
}

// ---------------------------------------------------------------------------
// integer scale (nearest-neighbour upscaling)
// ---------------------------------------------------------------------------

/**
 * Colour edges per column and per row inside region R: col[x] counts the pixel pairs (x-1, x) that
 * differ, row[y] the pairs (y-1, y). A k-grid with offset ox puts cell boundaries at x ≡ ox (mod k),
 * so for a true nearest-neighbour upscale every edge lands on a boundary column/row.
 */
function edgeCounts(img, P, R, tol) {
  const W = img.width, d = img.data;
  const col = new Float64Array(img.width), row = new Float64Array(img.height);
  let total = 0;
  for (let y = R.y; y < R.y + R.h; y++) {
    for (let x = R.x; x < R.x + R.w; x++) {
      const i = y * W + x;
      if (x > R.x && (tol === 0 ? P[i] !== P[i - 1] : delta(d, i, d, i - 1) > tol)) { col[x]++; total++; }
      if (y > R.y && (tol === 0 ? P[i] !== P[i - W] : delta(d, i, d, i - W) > tol)) { row[y]++; total++; }
    }
  }
  return { col, row, total };
}

/** Edge histogram by boundary residue: h[r] = edges at positions p (from < p < to) with p mod k = r. */
function residueHist(counts, k, from, to) {
  const h = new Float64Array(k);
  for (let p = from + 1; p < to; p++) h[p % k] += counts[p];
  return h;
}

/** The two residues carrying the most edges (ties -> smaller residue). */
function topResidues(h) {
  const order = [...h.keys()].sort((a, b) => h[b] - h[a] || a - b);
  return order.slice(0, Math.min(2, order.length));
}

function offsetCandidates(E, R, k) {
  if (k === 1) return [[0, 0]];
  const xs = topResidues(residueHist(E.col, k, R.x, R.x + R.w)), ys = topResidues(residueHist(E.row, k, R.y, R.y + R.h));
  const out = [];
  for (const ox of xs) for (const oy of ys) out.push([ox, oy]);
  return out;
}

function gridOf(R, k, ox, oy) {
  const x0 = R.x + mod(ox - R.x, k), y0 = R.y + mod(oy - R.y, k);
  const nx = Math.max(0, Math.floor((R.x + R.w - x0) / k)), ny = Math.max(0, Math.floor((R.y + R.h - y0) / k));
  return { x0, y0, nx, ny, cells: nx * ny };
}

/** Is the k×k cell at (bx, by) one colour (every channel's range <= tol)? */
function cellUniform(img, P, bx, by, k, tol) {
  const W = img.width;
  if (tol === 0) {
    const v = P[by * W + bx];
    for (let y = by; y < by + k; y++) for (let i = y * W + bx, e = i + k; i < e; i++) if (P[i] !== v) return false;
    return true;
  }
  const d = img.data, o0 = (by * W + bx) * 4;
  let r0 = d[o0], r1 = r0, g0 = d[o0 + 1], g1 = g0, b0 = d[o0 + 2], b1 = b0, a0 = d[o0 + 3], a1 = a0;
  for (let y = by; y < by + k; y++) {
    for (let o = (y * W + bx) * 4, e = o + k * 4; o < e; o += 4) {
      const r = d[o], g = d[o + 1], b = d[o + 2], a = d[o + 3];
      if (r < r0) r0 = r; else if (r > r1) r1 = r;
      if (g < g0) g0 = g; else if (g > g1) g1 = g;
      if (b < b0) b0 = b; else if (b > b1) b1 = b;
      if (a < a0) a0 = a; else if (a > a1) a1 = a;
      if (r1 - r0 > tol || g1 - g0 > tol || b1 - b0 > tol || a1 - a0 > tol) return false;
    }
  }
  return true;
}

/** Distinct colours and largest channel range in a cell (only computed for non-uniform cells). */
function cellDetail(img, P, bx, by, k) {
  const W = img.width, d = img.data, seen = new Set();
  const lo = [255, 255, 255, 255], hi = [0, 0, 0, 0];
  for (let y = by; y < by + k; y++) {
    for (let i = y * W + bx, e = i + k; i < e; i++) {
      seen.add(P[i]);
      for (let c = 0; c < 4; c++) { const v = d[i * 4 + c]; if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; }
    }
  }
  return { x: bx, y: by, w: k, h: k, colors: seen.size, spread: Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], hi[3] - lo[3]) };
}

const worse = (p, q) => q.spread - p.spread || q.colors - p.colors || p.y - q.y || p.x - q.x;

/**
 * Check every complete k×k cell of the grid at (ox, oy) inside R. Stops early once more than
 * `budget` cells are non-uniform (exceeded: true). With `detail`, keeps the 10 worst cells.
 */
function scanCells(img, P, k, ox, oy, R, tol, budget = Infinity, detail = false) {
  const g = gridOf(R, k, ox, oy);
  const worst = [];
  let nonUniform = 0;
  for (let cy = 0; cy < g.ny; cy++) {
    for (let cx = 0; cx < g.nx; cx++) {
      const bx = g.x0 + cx * k, by = g.y0 + cy * k;
      if (k === 1 || cellUniform(img, P, bx, by, k, tol)) continue;
      nonUniform++;
      if (nonUniform > budget) return { ...g, nonUniform, exceeded: true, worst };
      if (detail) {
        const c = cellDetail(img, P, bx, by, k);
        if (worst.length < MAX_WORST || worse(c, worst[worst.length - 1]) < 0) {
          worst.push(c);
          worst.sort(worse);
          if (worst.length > MAX_WORST) worst.pop();
        }
      }
    }
  }
  return { ...g, nonUniform, exceeded: false, worst };
}

/**
 * Exact integer-scale test: if the image is a nearest-neighbour upscale by k, every k×k cell of the
 * grid aligned to (ox, oy) is one colour. The offset is found automatically (pass `offset: [ox, oy]`
 * to force one): the columns/rows where colour edges pile up are the cell boundaries, and the best of
 * the top two candidates per axis (fewest non-uniform cells) wins. Only complete cells inside
 * `region` are checked. `tolerance` allows that much per-channel spread inside a cell (lossy captures).
 *
 * blurry: k > 1 and fewer than `minUniform` % of cells are uniform, i.e. the art was scaled by a
 * fractional factor or filtered (bilinear) instead of drawn with crisp k×k pixels.
 * worst: the most mixed cells (largest channel spread, then most colours), to point at the damage.
 */
export function blockScale(input, k, { tolerance = 0, region, offset, minUniform = 99.5 } = {}) {
  const img = toImage(input, "blockScale");
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`blockScale: k must be a whole number >= 1, got ${k}`);
  const tol = clampThreshold(tolerance, "blockScale", "tolerance");
  const R = clipRegion(region, img.width, img.height, "blockScale");
  const P = packed(img);
  let candidates;
  if (offset != null) {
    if (!Array.isArray(offset) || offset.length !== 2 || !offset.every(Number.isInteger)) throw new TypeError(`blockScale: offset must be [ox, oy] whole numbers, got ${JSON.stringify(offset)}`);
    candidates = [[mod(offset[0], k), mod(offset[1], k)]];
  } else candidates = offsetCandidates(edgeCounts(img, P, R, tol), R, k);

  let best = null;
  for (const [ox, oy] of candidates) {
    const s = scanCells(img, P, k, ox, oy, R, tol, Infinity, true);
    const frac = s.cells ? s.nonUniform / s.cells : 0;
    if (!best || frac < best.frac || (frac === best.frac && s.cells > best.cells)) best = { ox, oy, frac, ...s };
  }
  const pct = best.frac * 100;
  return {
    k, offset: [best.ox, best.oy], region: R,
    cells: best.cells, nonUniform: best.nonUniform, nonUniformPercent: r4(pct),
    blurry: k > 1 && best.cells > 0 && pct > 100 - minUniform,
    worst: best.worst,
  };
}

/** Smallest prime factors of k (for the "is k just a multiple of a finer grid?" check). */
function primeFactors(k) {
  const out = [];
  for (let p = 2, n = k; n > 1; p++) if (n % p === 0) { out.push(p); while (n % p === 0) n /= p; }
  return out;
}

/**
 * True when the edges show a finer grid inside the k-cells: for a prime p | k with d = k/p, the
 * extra boundary lines of the d-grid carry at least a quarter as many edges as the k-grid's own line.
 * A sparse ×4 scene (mostly flat sky) passes the cell test at k = 8 or 16 too, but its sprites still
 * change colour every 4 px — this is what tells the true scale from its multiples.
 */
function finerGridInside(E, R, k, ox, oy) {
  const hx = residueHist(E.col, k, R.x, R.x + R.w), hy = residueHist(E.row, k, R.y, R.y + R.h);
  for (const p of primeFactors(k)) {
    const d = k / p;
    for (const [h, o] of [[hx, ox], [hy, oy]]) {
      let off = 0;
      for (let j = 1; j < p; j++) off += h[(o + j * d) % k];
      off /= p - 1;
      if (off > 0 && off >= 0.25 * h[o]) return true;
    }
  }
  return false;
}

/**
 * The largest k <= maxK at which the image (or region) is a clean k× nearest-neighbour upscale:
 * at least `minUniform` % of complete k×k cells are uniform at the best offset, and the colour edges
 * don't reveal a finer grid inside the cells (so a ×4 game isn't reported as ×8 because its sky is
 * flat). Needs at least 2 cells per axis. Returns 1 when no k >= 2 qualifies, including for an image
 * with no colour edges at all (nothing to judge).
 */
export function detectScale(input, { tolerance = 0, region, maxK = 16, minUniform = 99.5 } = {}) {
  const img = toImage(input, "detectScale");
  const tol = clampThreshold(tolerance, "detectScale", "tolerance");
  const R = clipRegion(region, img.width, img.height, "detectScale");
  const P = packed(img);
  const E = edgeCounts(img, P, R, tol);
  if (E.total === 0) return 1;
  const top = Math.min(Math.floor(Number(maxK) || 16), Math.floor(R.w / 2), Math.floor(R.h / 2));
  for (let k = top; k >= 2; k--) {
    for (const [ox, oy] of offsetCandidates(E, R, k)) {
      const g = gridOf(R, k, ox, oy);
      if (g.cells === 0) continue;
      const budget = Math.floor(g.cells * (100 - minUniform) / 100 + 1e-9);
      const s = scanCells(img, P, k, ox, oy, R, tol, budget, false);
      if (s.exceeded || finerGridInside(E, R, k, ox, oy)) continue;
      return k;
    }
  }
  return 1;
}

// ---------------------------------------------------------------------------
// masks
// ---------------------------------------------------------------------------

/** Count, tight box and centroid of a mask, from raw sums (not rounded). */
function maskSums(mask, w, h) {
  let count = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (!mask[i]) continue;
      count++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return count
    ? { count, bbox: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, cx: sx / count, cy: sy / count }
    : { count: 0, bbox: null, cx: null, cy: null };
}

/** { count, bbox: { x, y, w, h } | null, centroid: [x, y] | null } of a mask. */
export function maskInfo(mask, width, height) {
  checkMask(mask, width, height, "maskInfo");
  const s = maskSums(mask, width, height);
  return { count: s.count, bbox: s.bbox, centroid: s.count ? [r3(s.cx), r3(s.cy)] : null };
}

/** Tight bounding box { x, y, w, h } of a mask, or null when it selects nothing. */
export function maskBBox(mask, width, height) {
  checkMask(mask, width, height, "maskBBox");
  return maskSums(mask, width, height).bbox;
}

/** Diff two same-size images inside region R into a fresh mask (pixels that differ by > thr). */
function diffMask(A, B, R, thr) {
  const w = A.width, mask = new Uint8Array(w * A.height), da = A.data, db = B.data;
  for (let y = R.y; y < R.y + R.h; y++) for (let i = y * w + R.x, e = i + R.w; i < e; i++) if (delta(da, i, db, i) > thr) mask[i] = 1;
  return mask;
}

/**
 * Pixels that differ between a and b (any RGBA channel by more than `threshold`), only inside
 * `region` if given. Screenshot with the actor vs the same scene without it = the actor's exact
 * silhouette (mask), box (bbox; bbox.h is its height in pixels), size (count) and centroid.
 * The images must be the same size (no silent rescaling when measuring).
 */
export function maskDiff(a, b, { threshold = 16, region } = {}) {
  const A = toImage(a, "maskDiff", "A"), B = toImage(b, "maskDiff", "B");
  if (A.width !== B.width || A.height !== B.height) throw new RangeError(`maskDiff: sizes differ (A ${A.width}×${A.height}, B ${B.width}×${B.height}); measure same-size screenshots`);
  const R = clipRegion(region, A.width, A.height, "maskDiff");
  const mask = diffMask(A, B, R, clampThreshold(threshold, "maskDiff"));
  return { mask, width: A.width, height: A.height, ...maskInfo(mask, A.width, A.height) };
}

/**
 * Pixels whose colour is within `tolerance` (per RGB channel, 0..255) of `color`.
 * color: [r, g, b], "#rrggbb", "rgb(...)" or anything parseColor reads. Alpha is not compared.
 */
export function maskFromColor(input, color, tolerance = 0) {
  const img = toImage(input, "maskFromColor");
  let c = null;
  try { c = parseColor(color); } catch { /* reported below */ }
  if (!c || !c.slice(0, 3).every(Number.isFinite)) throw new TypeError(`maskFromColor: unreadable color ${JSON.stringify(color)}`);
  const tol = clampThreshold(tolerance, "maskFromColor", "tolerance");
  const n = img.width * img.height, d = img.data, mask = new Uint8Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    if (Math.abs(d[o] - c[0]) <= tol && Math.abs(d[o + 1] - c[1]) <= tol && Math.abs(d[o + 2] - c[2]) <= tol) mask[i] = 1;
  }
  return mask;
}

/** A width×height mask selecting the rectangle { x, y, w, h } (clipped; empty if fully outside). */
export function maskFromRect(width, height, rect) {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) throw new RangeError(`maskFromRect: invalid size ${width}×${height}`);
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) throw new TypeError(`maskFromRect: rect must be { x, y, w, h } numbers, got ${JSON.stringify(rect)}`);
  const mask = new Uint8Array(width * height);
  const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w)), y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  for (let y = y0; y < y1; y++) mask.fill(1, y * width + x0, y * width + Math.max(x0, x1));
  return mask;
}

/**
 * Pixels outside the mask within `radius` px (Euclidean, pixel centres) of it: "the ground around it".
 * Pass the whole silhouette (e.g. maskDiff(withActor, withoutActor).mask), not just its outline —
 * the ring of an outline mask also includes the pixels just inside it.
 */
export function ringMask(mask, width, height, radius = 2) {
  checkMask(mask, width, height, "ringMask");
  const r = Number(radius);
  if (!Number.isFinite(r) || r < 0) throw new RangeError(`ringMask: radius must be a number >= 0, got ${radius}`);
  const ri = Math.floor(r), r2max = r * r, offs = [];
  for (let dy = -ri; dy <= ri; dy++) for (let dx = -ri; dx <= ri; dx++) if ((dx || dy) && dx * dx + dy * dy <= r2max) offs.push(dx, dy);
  const out = new Uint8Array(width * height);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      if (!mask[i]) continue;
      // the nearest mask pixel to any outside pixel always has an outside 4-neighbour, so only stamp from those
      const edge = (x > 0 && !mask[i - 1]) || (x < width - 1 && !mask[i + 1]) || (y > 0 && !mask[i - width]) || (y < height - 1 && !mask[i + width]);
      if (!edge) continue;
      for (let j = 0; j < offs.length; j += 2) {
        const nx = x + offs[j], ny = y + offs[j + 1];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (!mask[n]) out[n] = 1;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// colour statistics and contrast
// ---------------------------------------------------------------------------

// sRGB channel (0..255) -> linear light (IEC 61966-2-1)
const LINEAR = Float64Array.from({ length: 256 }, (_, v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });

/** WCAG relative luminance (0 = black, 1 = white) of an sRGB colour. */
const luminanceOf = (r, g, b) => 0.2126 * LINEAR[r] + 0.7152 * LINEAR[g] + 0.0722 * LINEAR[b];

/** CIE L*a*b* (D65) of an sRGB colour. */
function labOf(r, g, b) {
  const R = LINEAR[r], G = LINEAR[g], B = LINEAR[b];
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Unrounded mean colour, mean luminance and mean Lab of the masked pixels. */
function rawStats(img, mask, fn, which) {
  checkMask(mask, img.width, img.height, fn, which);
  const d = img.data, n = img.width * img.height;
  let count = 0, sr = 0, sg = 0, sb = 0, sa = 0, sl = 0, sL = 0, sA = 0, sB = 0;
  const labCache = new Map();
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    if (!mask[i]) continue;
    const r = d[o], g = d[o + 1], b = d[o + 2];
    count++; sr += r; sg += g; sb += b; sa += d[o + 3];
    sl += luminanceOf(r, g, b);
    const key = (r << 16) | (g << 8) | b;
    let lab = labCache.get(key);
    if (!lab) { lab = labOf(r, g, b); if (labCache.size < 65536) labCache.set(key, lab); }
    sL += lab[0]; sA += lab[1]; sB += lab[2];
  }
  if (!count) return { count: 0, mean: null, luminance: null, lab: null };
  return { count, mean: [sr / count, sg / count, sb / count, sa / count], luminance: sl / count, lab: [sL / count, sA / count, sB / count] };
}

/**
 * Colour statistics of the masked pixels: mean RGBA, mean WCAG relative luminance (of each pixel,
 * then averaged) and mean CIE L*a*b*. An empty mask gives count 0 and nulls.
 */
export function maskStats(input, mask) {
  const img = toImage(input, "maskStats");
  const s = rawStats(img, mask, "maskStats", "mask");
  if (!s.count) return s;
  return { count: s.count, mean: s.mean.map(r2), luminance: r4(s.luminance), lab: s.lab.map(r2) };
}

/**
 * How well two sets of pixels stand apart, e.g. an outline (maskA) against the ground around the
 * sprite (maskB = ringMask(silhouette, w, h, 3)).
 *   ratio:  WCAG contrast (L1 + 0.05) / (L2 + 0.05) of the mean luminances, lighter over darker, 1..21
 *           (WCAG asks 3 for large graphics, 4.5 for text)
 *   deltaE: CIE76 distance between the mean Lab colours (~2.3 just noticeable, > 40 very distinct)
 * Throws if either mask selects no pixels.
 */
export function contrast(input, maskA, maskB) {
  const img = toImage(input, "contrast");
  const A = rawStats(img, maskA, "contrast", "maskA"), B = rawStats(img, maskB, "contrast", "maskB");
  if (!A.count) throw new RangeError("contrast: maskA selects no pixels");
  if (!B.count) throw new RangeError("contrast: maskB selects no pixels");
  const hi = Math.max(A.luminance, B.luminance), lo = Math.min(A.luminance, B.luminance);
  const deltaE = Math.hypot(A.lab[0] - B.lab[0], A.lab[1] - B.lab[1], A.lab[2] - B.lab[2]);
  return {
    countA: A.count, countB: B.count,
    meanA: A.mean.map(r2), meanB: B.mean.map(r2),
    lumA: r4(A.luminance), lumB: r4(B.luminance),
    ratio: r3((hi + 0.05) / (lo + 0.05)),
    deltaE: r2(deltaE),
  };
}

// ---------------------------------------------------------------------------
// motion across frames
// ---------------------------------------------------------------------------

const MEDIAN_SAMPLES = 15;

/** Pick up to 15 evenly spaced indices of N frames (the frames a median plate is built from). */
export function medianSampleIndices(N) {
  const S = Math.min(N, MEDIAN_SAMPLES);
  return Array.from({ length: S }, (_, i) => (S === 1 ? 0 : Math.round((i * (N - 1)) / (S - 1))));
}

/** Per-pixel, per-channel median of the given frames (up to 15 used), inside R (a clean plate). */
export function medianPlate(frames, region) {
  const imgs = frames.map((f, i) => toImage(f, "medianPlate", `#${i}`));
  const R = clipRegion(region, imgs[0].width, imgs[0].height, "medianPlate");
  const pick = medianSampleIndices(imgs.length).map((i) => imgs[i]);
  const S = pick.length;
  const Ps = pick.map(packed), w = imgs[0].width;
  const out = { width: w, height: imgs[0].height, data: Uint8Array.from(imgs[0].data.subarray(0, w * imgs[0].height * 4)) };
  const vals = new Uint8Array(S);
  for (let y = R.y; y < R.y + R.h; y++) {
    for (let i = y * w + R.x, e = i + R.w; i < e; i++) {
      const v0 = Ps[0][i];
      let same = true;
      for (let s = 1; s < S && same; s++) same = Ps[s][i] === v0;
      for (let c = 0; c < 4; c++) {
        if (same) { out.data[i * 4 + c] = pick[0].data[i * 4 + c]; continue; }
        for (let s = 0; s < S; s++) {
          const v = pick[s].data[i * 4 + c];
          let j = s - 1;
          while (j >= 0 && vals[j] > v) { vals[j + 1] = vals[j]; j--; }
          vals[j + 1] = v;
        }
        out.data[i * 4 + c] = vals[S >> 1];
      }
    }
  }
  return out;
}

/** Savitzky–Golay smoothing (quadratic, 5 points): a constant acceleration passes through unchanged. */
const SG5 = [-3, 12, 17, 12, -3].map((c) => c / 35);

/**
 * Jitter of a centroid path: RMS distance of each position from a quadratic fitted through it and its two
 * neighbours on each side. Steady motion and smooth acceleration/braking give 0; an uneven step (a hitch, a
 * duplicated frame, a 2× step) does not. Null when no 5 consecutive frames have the object.
 */
export function pathJitter(points) {
  let sum = 0, n = 0;
  for (let i = 2; i + 2 < points.length; i++) {
    const win = points.slice(i - 2, i + 3);
    if (win.some((p) => !p)) continue;
    const sx = win.reduce((a, p, k) => a + SG5[k] * p[0], 0), sy = win.reduce((a, p, k) => a + SG5[k] * p[1], 0);
    sum += (points[i][0] - sx) ** 2 + (points[i][1] - sy) ** 2; n++;
  }
  return n ? Math.sqrt(sum / n) : null;
}

/**
 * Streaming version of motion(): push frames one at a time (only the plate is kept), then finish().
 * plate: a clean background image, or "first" (the first pushed frame becomes the plate).
 */
export function motionStream({ region, threshold = 16, plate = "first", minPixels = 1, objects = false, minObject = 6, mosaic = null, offsets = null } = {}) {
  const thr = clampThreshold(threshold, "motion");
  const minPx = Math.max(1, Math.floor(Number(minPixels) || 1));
  let P = mosaic ? null : plate === "first" || plate == null ? null : toImage(plate, "motion", "background");
  let R = null, w = 0, h = 0;
  const raw = [];
  return {
    push(frame) {
      const im = toImage(frame, "motion", `#${raw.length}`);
      if (!R) { w = im.width; h = im.height; R = clipRegion(region, w, h, "motion"); }
      if (im.width !== w || im.height !== h) throw new RangeError(`motion: frame #${raw.length} is ${im.width}×${im.height}, frame #0 is ${w}×${h}`);
      let mask;
      if (mosaic) mask = maskAgainstMosaic(im, mosaic, offsets[raw.length] || [0, 0], R, thr);
      else {
        if (!P) P = { width: w, height: h, data: Uint8Array.from(im.data.subarray(0, w * h * 4)) };
        if (P.width !== w || P.height !== h) throw new RangeError(`motion: background is ${P.width}×${P.height}, frames are ${w}×${h}`);
        mask = diffMask(P, im, R, thr);
      }
      const s = maskSums(mask, w, h);
      const comps = objects ? components(mask, w, h, { region: R, minPixels: minObject }) : null;
      if (s.count < minPx) { raw.push({ count: s.count, bbox: null, cx: null, cy: null, low: null, comps }); return; }
      const y = s.bbox.y + s.bbox.h - 1;
      let x0 = -1, x1 = -1;
      for (let x = s.bbox.x; x < s.bbox.x + s.bbox.w; x++) if (mask[y * w + x]) { if (x0 < 0) x0 = x; x1 = x; }
      raw.push({ ...s, low: { y, x0, x1 }, comps });
    },
    finish(mode = mosaic ? "mosaic" : plate === "first" || plate == null ? "first" : "image") {
      if (!raw.length) throw new TypeError("motion: no frames");
      const r = motionResult(raw, { w, h, R, mode, thr });
      if (objects) {
        // several movers: blobs of each frame's mask, followed across frames (steps in world space under a camera)
        const tracks = trackObjects(raw.map((f) => f.comps || []));
        const off = offsets ? (i) => offsets[i] || [0, 0] : null;
        const reps = tracks.map((t) => ({ ...trackReport(t, off), frames: t.frames.map((f) => (f.missing ? { i: f.i, missing: f.missing } : { i: f.i, bbox: f.bbox, centroid: [r3(f.cx), r3(f.cy)], count: f.count })) }));
        // things that never move (a prop that appears or vanishes, a stale patch of the plate) are listed apart
        r.static = reps.filter((o) => o.static).map(({ id, first, last, size, frames }) => ({ id, first, last, size, bbox: frames.find((f) => !f.missing).bbox }));
        r.objects = reps.filter((o) => !o.static).sort((a, b) => b.seen * b.size - a.seen * a.size).map((o, k) => ({ ...o, rank: k + 1 }));
      }
      return r;
    },
  };
}

function motionResult(raw, { w, h, R, mode, thr }) {
  const steps = [], lengths = [];
  for (let i = 0; i + 1 < raw.length; i++) {
    const p = raw[i], q = raw[i + 1];
    if (p.cx == null || q.cx == null) { steps.push(null); continue; }
    const dx = q.cx - p.cx, dy = q.cy - p.cy;
    steps.push([r3(dx), r3(dy)]);
    lengths.push(Math.hypot(dx, dy));
  }
  const present = raw.filter((f) => f.cx != null);
  const pathLength = lengths.reduce((a, b) => a + b, 0);
  const meanStep = lengths.length ? pathLength / lengths.length : 0;
  const stepSpread = lengths.length ? Math.sqrt(lengths.reduce((a, l) => a + (l - meanStep) ** 2, 0) / lengths.length) : 0;
  const jitter = pathJitter(raw.map((f) => (f.cx == null ? null : [f.cx, f.cy])));
  const first = present[0], last = present[present.length - 1];
  const net = first ? [last.cx - first.cx, last.cy - first.cy] : null;
  // how far the object travelled compared with its own size (a median plate needs it to move its size)
  const size = present.length ? Math.max(...present.map((f) => Math.max(f.bbox.w, f.bbox.h))) : 0;
  const warnings = [];
  if (mode === "median" && present.length && net && Math.hypot(net[0], net[1]) < size) {
    warnings.push(`the object moved ${r3(Math.hypot(net[0], net[1]))} px, less than its own size (${size} px): the median plate may contain it, so boxes can be wrong — pass a clean background (--background <file.png>)`);
  }
  if (mode === "first" && raw.length > 1 && raw[0].count === 0 && raw[1].count > 0) {
    warnings.push("compared with frame 0 as the clean plate: if the object is already visible there, every box covers its old and new position (steps come out halved) — use --background median or a clean <file.png>");
  }
  return {
    width: w, height: h, region: R, background: mode, threshold: thr, warnings,
    frames: raw.map((f, index) => ({ index, count: f.count, bbox: f.bbox, centroid: f.cx == null ? null : [r3(f.cx), r3(f.cy)], lowestRowSpan: f.low })),
    steps,
    summary: {
      framesWithObject: present.length,
      steps: lengths.length,
      pathLength: r3(pathLength),
      net: net && net.map(r3),
      netDistance: net ? r3(Math.hypot(net[0], net[1])) : 0,
      maxStep: r3(lengths.length ? Math.max(...lengths) : 0),
      meanStep: r3(meanStep),
      jitter: jitter == null ? null : r3(jitter),
      stepSpread: r3(stepSpread),
    },
  };
}

/**
 * Track one moving object across consecutive frames. Each frame's object mask = the pixels that
 * differ (by > threshold) from a background plate, only inside `region` (use it to keep HUD
 * counters and other movers out):
 *   background: an image  — a clean plate (the scene without the object): exact silhouettes
 *               "auto"    — "median" for 8 frames or more, else "first" (default)
 *               "median"  — per-pixel median of the frames; works without a plate when the object
 *                           moves more than its own size over the clip (no pixel covered > half the time)
 *               "first"   — frames[0] is the plate; it must not contain the object, and its own
 *                           entry comes out empty
 * Frames whose mask has fewer than `minPixels` pixels count as "no object" (bbox/centroid null).
 *
 * Per frame: { index, count, bbox, centroid, lowestRowSpan: { y, x0, x1 } } — lowestRowSpan is the
 * leftmost/rightmost mask pixel on the bottom-most mask row (the feet, for a standing character).
 * steps[i] = centroid(i + 1) - centroid(i) as [dx, dy] (null if either frame has no object).
 * summary: pathLength (sum of step lengths), net ([dx, dy] first->last frame with an object),
 * netDistance, maxStep, meanStep, jitter (RMS px off a smooth quadratic path: 0 for steady motion
 * and for smooth acceleration; null under 5 frames), stepSpread (stddev of step lengths: also
 * counts acceleration). warnings: reasons the boxes may be wrong (a plate that contains the object).
 *
 * Measuring foot slide: while a foot is planted its x must not change even though the body moves.
 * Give a clean plate and a region around the feet (or use the whole sprite), then for each step
 * compare the planted foot's movement — lowestRowSpan.x0 / x1 (or their midpoint) frame to frame —
 * with the body's centroid dx. Planted: foot dx ≈ 0 while body dx ≠ 0 during the contact frames;
 * sliding: foot dx ≈ body dx on every step ("moonwalking" = the foot moves against the body).
 */
export function motion(frames, { region, threshold = 16, background = "auto", minPixels = 1 } = {}) {
  if (!Array.isArray(frames) || frames.length === 0) throw new TypeError("motion: frames must be a non-empty array of images");
  const imgs = frames.map((f, i) => toImage(f, "motion", `#${i}`));
  const w = imgs[0].width, h = imgs[0].height;
  imgs.forEach((im, i) => { if (im.width !== w || im.height !== h) throw new RangeError(`motion: frame #${i} is ${im.width}×${im.height}, frame #0 is ${w}×${h}`); });
  let mode = background == null ? "auto" : background;
  if (mode === "auto") mode = imgs.length >= AUTO_MEDIAN_FRAMES ? "median" : "first";
  let plate;
  if (mode === "first") plate = "first";
  else if (mode === "median") plate = medianPlate(imgs, region);
  else { plate = toImage(background, "motion", "background"); mode = "image"; }
  const st = motionStream({ region, threshold, plate, minPixels });
  for (const im of imgs) st.push(im);
  const r = st.finish(mode);
  if (background === "auto" || background == null) {
    r.backgroundChoice = mode === "median" ? `auto → median (${imgs.length} frames)` : `auto → first (only ${imgs.length} frames; median needs ${AUTO_MEDIAN_FRAMES})`;
  }
  return r;
}

/** With "auto", clips of at least this many frames use a median plate. */
export const AUTO_MEDIAN_FRAMES = 8;
