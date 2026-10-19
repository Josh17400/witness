// Witness media: colour-vision deficiency, key colours and palettes (witness measure colorblind | palette).
//
//   CVD_TYPES                                   -> ["protan", "deutan", "tritan", "achroma"]
//   cvdMatrix(type)                             -> 3×3 matrix (rows) applied to linear RGB (Machado et al. 2009,
//                                                  severity 1.0; achroma = WCAG luminance on every channel)
//   simulateColor([r, g, b], type)              -> [r, g, b] as a viewer with that deficiency sees it (0..255)
//   simulateCVD(img, type)                      -> a new image (alpha kept)
//   deltaE(c1, c2)                              -> CIE76 ΔE between two sRGB colours (the same ΔE `contrast` reports)
//   contrastRatio(c1, c2)                       -> WCAG ratio of two sRGB colours, 1..21
//   dominantColors(img, { max, minShare, region, mergeDE }) -> [{ color, hex, count, share }] most common first
//   pairsUnderCVD(colors, { types, minDE })     -> every pair's ΔE and ratio normally and under each type
//   parsePalette(text, kind)                    -> [[r, g, b]] from .hex/.txt lines, GIMP .gpl, JSON or "#a,#b"
//   paletteOfImage(img)                         -> the distinct opaque colours of an image (a palette strip PNG)
//   colorCounts(img, region)                    -> Map(key -> { color, count, x0, y0, x1, y1, first })
//   paletteCheck(img, palette, { tolerance, region, list }) -> off-palette pixels and colours
//   colorBudget(img, max, { region })           -> distinct colours vs a maximum, least used colours + merge targets
//   offPaletteImage(img, offMask)               -> the picture dimmed, off-palette pixels in magenta (PNG-ready image)
//
// Colours are [r, g, b] 0..255. Pixels with alpha 0 are ignored by counts and palettes.

import { LINEAR, labOf, luminanceOf } from "./measure.js";
import { parseColor } from "./raster.js";

const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;

export const CVD_TYPES = ["protan", "deutan", "tritan", "achroma"];

// Machado, Oliveira & Fernandes (2009), "A Physiologically-based Model for Simulation of Color Vision
// Deficiency", severity 1.0 (protanopia, deuteranopia, tritanopia). Rows sum to 1, so greys stay grey.
const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
  achroma: [[0.2126, 0.7152, 0.0722], [0.2126, 0.7152, 0.0722], [0.2126, 0.7152, 0.0722]],
};
export const TYPE_NAMES = { protan: "protanopia (no red cones)", deutan: "deuteranopia (no green cones)", tritan: "tritanopia (no blue cones)", achroma: "achromatopsia (no colour)" };

export function cvdMatrix(type) {
  const m = MACHADO[type];
  if (!m) throw new RangeError(`colour-vision type is ${CVD_TYPES.join(", ")} (got ${type})`);
  return m.map((row) => row.slice());
}

/** linear light 0..1 -> sRGB 0..255 (rounded, clamped) */
const encode = (v) => { const c = Math.min(1, Math.max(0, v)); return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255); };

/** How a viewer with the given deficiency sees an sRGB colour (simulated in linear RGB). */
export function simulateColor(c, type) {
  const m = MACHADO[type];
  if (!m) throw new RangeError(`colour-vision type is ${CVD_TYPES.join(", ")} (got ${type})`);
  const R = LINEAR[c[0] | 0], G = LINEAR[c[1] | 0], B = LINEAR[c[2] | 0];
  return m.map((row) => encode(row[0] * R + row[1] * G + row[2] * B));
}

/** The whole image as seen with the deficiency (a new { width, height, data }; alpha kept). */
export function simulateCVD(img, type) {
  cvdMatrix(type);
  const d = img.data, out = new Uint8Array(img.width * img.height * 4), cache = new Map();
  for (let o = 0; o < out.length; o += 4) {
    const key = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
    let s = cache.get(key);
    if (!s) { s = simulateColor([d[o], d[o + 1], d[o + 2]], type); if (cache.size < 1 << 18) cache.set(key, s); }
    out[o] = s[0]; out[o + 1] = s[1]; out[o + 2] = s[2]; out[o + 3] = d[o + 3];
  }
  return { width: img.width, height: img.height, data: out };
}

export function deltaE(a, b) {
  const A = labOf(a[0] | 0, a[1] | 0, a[2] | 0), B = labOf(b[0] | 0, b[1] | 0, b[2] | 0);
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}
export function contrastRatio(a, b) {
  const la = luminanceOf(a[0] | 0, a[1] | 0, a[2] | 0), lb = luminanceOf(b[0] | 0, b[1] | 0, b[2] | 0);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
export const hex = (c) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

function clip(region, w, h) {
  if (!region) return { x0: 0, y0: 0, x1: w, y1: h };
  const x0 = Math.max(0, Math.floor(region.x)), y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(w, Math.ceil(region.x + region.w)), y1 = Math.min(h, Math.ceil(region.y + region.h));
  if (x1 <= x0 || y1 <= y0) throw new RangeError(`region ${JSON.stringify(region)} does not overlap the ${w}×${h} image`);
  return { x0, y0, x1, y1 };
}

/** Every distinct opaque colour: count, bounding box and the first pixel (row-major) that has it. */
export function colorCounts(img, region = null) {
  const { x0, y0, x1, y1 } = clip(region, img.width, img.height), d = img.data, m = new Map();
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * img.width + x) * 4;
    if (d[o + 3] === 0) continue;
    const key = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
    const e = m.get(key);
    if (e) { e.count++; if (x < e.x0) e.x0 = x; if (x > e.x1) e.x1 = x; e.y1 = y; }
    else m.set(key, { color: [d[o], d[o + 1], d[o + 2]], count: 1, x0: x, x1: x, y0: y, y1: y, first: [x, y] });
  }
  return m;
}

/**
 * The picture's key colours: 4-bit-per-channel buckets holding at least minShare of the pixels, as their mean
 * colours, most common first; buckets whose means are within mergeDE of a more common one are merged into it.
 */
export function dominantColors(img, { max = 8, minShare = 0.005, region = null, mergeDE = 6 } = {}) {
  const { x0, y0, x1, y1 } = clip(region, img.width, img.height), d = img.data, buckets = new Map();
  let total = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * img.width + x) * 4;
    if (d[o + 3] === 0) continue;
    total++;
    const k = ((d[o] >> 4) << 8) | ((d[o + 1] >> 4) << 4) | (d[o + 2] >> 4);
    const b = buckets.get(k);
    if (b) { b.n++; b.r += d[o]; b.g += d[o + 1]; b.b += d[o + 2]; } else buckets.set(k, { n: 1, r: d[o], g: d[o + 1], b: d[o + 2] });
  }
  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n).map((b) => ({ color: [b.r / b.n, b.g / b.n, b.b / b.n], count: b.n }));
  const out = [];
  for (const b of sorted) {
    const into = out.find((o) => deltaE(o.color.map(Math.round), b.color.map(Math.round)) < mergeDE);
    if (into) { const n = into.count + b.count; into.color = into.color.map((v, i) => (v * into.count + b.color[i] * b.count) / n); into.count = n; }
    else out.push({ ...b });
  }
  out.sort((a, b) => b.count - a.count);   // merging grows colours: most common first again before cutting to max
  return out.filter((o) => o.count >= total * minShare).slice(0, max).map((o) => {
    const color = o.color.map(Math.round);
    return { color, hex: hex(color), count: o.count, share: r4(o.count / total) };
  });
}

/**
 * Every pair of named colours: ΔE and contrast ratio normally and under each deficiency. A pair is "lost" under a
 * type when it is distinct normally (ΔE ≥ minDE) and confusable under that type (ΔE < minDE).
 * colors: [{ name, color: [r, g, b] }]
 */
export function pairsUnderCVD(colors, { types = ["protan", "deutan", "tritan"], minDE = 20 } = {}) {
  const sim = colors.map((c) => Object.fromEntries(types.map((t) => [t, simulateColor(c.color, t)])));
  const pairs = [];
  for (let i = 0; i < colors.length; i++) for (let j = i + 1; j < colors.length; j++) {
    const a = colors[i], b = colors[j];
    const p = { a: a.name, b: b.name, colorA: hex(a.color), colorB: hex(b.color), normal: { deltaE: r2(deltaE(a.color, b.color)), ratio: r2(contrastRatio(a.color, b.color)) }, types: {}, lost: [] };
    for (const t of types) {
      const e = deltaE(sim[i][t], sim[j][t]);
      p.types[t] = { deltaE: r2(e), ratio: r2(contrastRatio(sim[i][t], sim[j][t])), a: hex(sim[i][t]), b: hex(sim[j][t]) };
      if (p.normal.deltaE >= minDE && e < minDE) p.lost.push(t);
    }
    pairs.push(p);
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// palettes
// ---------------------------------------------------------------------------

/**
 * A palette from text: "#a1b2c3,#fff" (inline), Lospec .hex (one RRGGBB per line, '#' optional), Paint.NET .txt
 * (Lospec's "PAINT.NET TXT": ';' comment lines, AARRGGBB values), GIMP .gpl ("R G B name" lines), or JSON (an array
 * of colours, or { colors: [...] }). Lines starting with ';' or '//' are comments. 8-digit values are AARRGGBB in a
 * .txt file or after a paint.net header, else RRGGBBAA. Duplicates are dropped.
 */
export function parsePalette(text, kind = "") {
  const s = String(text).trim();
  let list = [];
  if (kind === "json" || /^[[{]/.test(s)) {
    const j = JSON.parse(s);
    list = (Array.isArray(j) ? j : j.colors || j.palette || []).map((c) => parseColor(typeof c === "string" && /^[0-9a-f]{6}$/i.test(c) ? "#" + c : c));
  } else if (kind === "gpl" || /^GIMP Palette/.test(s)) {
    for (const line of s.split(/\r?\n/)) { const m = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line); if (m) list.push([+m[1], +m[2], +m[3]]); }
  } else {
    const argb = kind === "txt" || /paint\.net/i.test(s);
    const body = s.split(/\r?\n/).filter((line) => !/^\s*(;|\/\/)/.test(line)).join("\n");
    for (const tok of body.split(/[\s,;]+/).filter(Boolean)) {
      const t = tok.replace(/^#/, "").replace(/^0x/i, "");
      if (!/^([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t)) throw new Error(`palette: "${tok}" is not a hex colour`);
      list.push(parseColor("#" + (t.length === 8 ? (argb ? t.slice(2) : t.slice(0, 6)) : t)));
    }
  }
  const seen = new Set(), out = [];
  for (const c of list) { const k = hex(c); if (!seen.has(k)) { seen.add(k); out.push([c[0], c[1], c[2]]); } }
  if (!out.length) throw new Error("palette: no colours found");
  return out;
}

/** The distinct opaque colours of an image, in first-seen order (a palette strip or swatch PNG). */
export function paletteOfImage(img) {
  return [...colorCounts(img).values()].sort((a, b) => a.first[1] - b.first[1] || a.first[0] - b.first[0]).map((e) => e.color);
}

/**
 * Pixels whose colour is not in the palette. tolerance (0..255, per channel): a pixel matches a palette colour when
 * every channel is within it. Returns { pixels, colors, offPixels, offPercent, offColors: [{ hex, count, nearest,
 * deltaE, bbox, first }], sample: [[x, y]] (the first `list` off pixels, row-major), bbox, unused: [hex], mask }.
 */
export function paletteCheck(img, palette, { tolerance = 0, region = null, list = 20 } = {}) {
  const counts = colorCounts(img, region);
  const pal = palette.map((c) => [c[0], c[1], c[2]]);
  const used = new Set();
  const offColors = [];
  let pixels = 0, off = 0;
  const offKeys = new Set();
  for (const [key, e] of counts) {
    pixels += e.count;
    let match = -1;
    for (let i = 0; i < pal.length; i++) {
      const p = pal[i];
      if (Math.abs(p[0] - e.color[0]) <= tolerance && Math.abs(p[1] - e.color[1]) <= tolerance && Math.abs(p[2] - e.color[2]) <= tolerance) { match = i; break; }
    }
    if (match >= 0) { used.add(match); continue; }
    off += e.count; offKeys.add(key);
    let best = 0, bestE = Infinity;
    pal.forEach((p, i) => { const de = deltaE(e.color, p); if (de < bestE) { bestE = de; best = i; } });
    offColors.push({ hex: hex(e.color), color: e.color, count: e.count, nearest: hex(pal[best]), deltaE: r2(bestE), bbox: { x: e.x0, y: e.y0, w: e.x1 - e.x0 + 1, h: e.y1 - e.y0 + 1 }, first: e.first });
  }
  offColors.sort((a, b) => b.count - a.count || a.first[1] - b.first[1] || a.first[0] - b.first[0]);
  const { x0, y0, x1, y1 } = clip(region, img.width, img.height), d = img.data;
  const mask = new Uint8Array(img.width * img.height), sample = [];
  let bx0 = Infinity, by0 = Infinity, bx1 = -1, by1 = -1;
  if (off) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * img.width + x) * 4;
    if (d[o + 3] === 0 || !offKeys.has((d[o] << 16) | (d[o + 1] << 8) | d[o + 2])) continue;
    mask[y * img.width + x] = 1;
    if (sample.length < list) sample.push([x, y]);
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
  }
  return {
    pixels, colors: counts.size, paletteSize: pal.length, offPixels: off, offPercent: pixels ? r4((100 * off) / pixels) : 0,
    offColors, sample, bbox: off ? { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 } : null,
    unused: pal.filter((_, i) => !used.has(i)).map(hex), mask,
  };
}

/**
 * Distinct colours against a budget: { colors, max, over, top: [{ hex, count, share }], rare: { colors, pixels }
 * (colours under 0.1% of the pixels each: blending, anti-aliasing or scaling blur in pixel art), leastUsed:
 * [{ hex, count, nearest, deltaE }] (merge candidates when over budget) }.
 */
export function colorBudget(img, max = null, { region = null } = {}) {
  const counts = [...colorCounts(img, region).values()].sort((a, b) => b.count - a.count);
  const pixels = counts.reduce((s, e) => s + e.count, 0);
  const top = counts.slice(0, 12).map((e) => ({ hex: hex(e.color), count: e.count, share: r4(e.count / pixels) }));
  const rareList = counts.filter((e) => e.count < pixels * 0.001);
  const over = max != null && counts.length > max;
  let leastUsed = [];
  if (over) {
    // merge targets come only from the colours that stay (the max most used), never from others being removed
    const keep = counts.slice(0, max);
    leastUsed = counts.slice(-Math.min(10, counts.length - max)).reverse().map((e) => {
      let best = null, bestE = Infinity;
      for (const k of keep) { if (k === e) continue; const de = deltaE(e.color, k.color); if (de < bestE) { bestE = de; best = k; } }
      return { hex: hex(e.color), count: e.count, first: e.first, nearest: best ? hex(best.color) : null, deltaE: best ? r2(bestE) : null };
    });
  }
  return { pixels, colors: counts.length, max, over, top, rare: { colors: rareList.length, pixels: rareList.reduce((s, e) => s + e.count, 0) }, leastUsed };
}

/** The picture at 35% brightness in grey, with the masked pixels in magenta (for the AI reader to look at). */
export function offPaletteImage(img, mask) {
  const d = img.data, out = new Uint8Array(img.width * img.height * 4);
  for (let i = 0, o = 0; i < mask.length; i++, o += 4) {
    if (mask[i]) { out[o] = 255; out[o + 1] = 0; out[o + 2] = 255; }
    else { const y = Math.round(0.35 * (0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2])); out[o] = out[o + 1] = out[o + 2] = y; }
    out[o + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

// ---------------------------------------------------------------------------
// figure vs ground (witness measure figure)
// ---------------------------------------------------------------------------

/**
 * Greedy colour clusters: distinct colours (key = r<<16|g<<8|b -> count) taken most common first, each joining the
 * first cluster whose seed (its most common colour) is within `tol` ΔE, else starting a new one. Returns
 * { clusters: [{ seed: lab, color: mean [r, g, b] (unrounded), count }], of: Map(key -> cluster index) }.
 */
export function clusterColors(counts, tol = 12) {
  const clusters = [], of = new Map();
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
    const r = k >> 16, g = (k >> 8) & 255, b = k & 255, lab = labOf(r, g, b);
    let best = -1, bd = Infinity;
    for (let i = 0; i < clusters.length; i++) { const s = clusters[i].seed, dd = Math.hypot(lab[0] - s[0], lab[1] - s[1], lab[2] - s[2]); if (dd < bd) { bd = dd; best = i; } }
    if (best < 0 || bd > tol) { clusters.push({ seed: lab, key: k, sum: [0, 0, 0], count: 0 }); best = clusters.length - 1; }
    const c = clusters[best];
    c.sum[0] += r * n; c.sum[1] += g * n; c.sum[2] += b * n; c.count += n;
    of.set(k, best);
  }
  for (const c of clusters) c.color = c.sum.map((v) => v / c.count);
  return { clusters, of };
}

/** The value at fraction q of an ascending array (nearest rank). */
const rank = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];

/**
 * A figure's (a sprite's) edge contrast against every kind of ground around it. mask: its silhouette (1 = figure).
 * Ground pixels are the pixels outside the mask touching it (8-neighbours); each is compared with the figure pixels
 * within `edge` px (Chebyshev) of it and keeps the strongest (the edge the eye sees there: WCAG ratio and ΔE, each its
 * own maximum). edge 1 = the silhouette's own rim (exact for pixel art); edge 2 also reaches past a 1 px
 * anti-aliased rim. Ground colours are clustered into surfaces (ΔE ≤ merge); a surface under minShare of the ring is minor.
 * Per surface: count, share, mean colour, worst / p10 / median ratio and ΔE, the share of its edge under `min`, and
 * where the worst edge is. label(x, y) -> string|null names the ground under a pixel (a map tile); a surface takes
 * its most common label. Returns null when the mask is empty or touches no ground.
 */
export function figureGround(img, mask, { edge = 1, merge = 12, minShare = 0.05, min = 3, label = null } = {}) {
  const W = img.width, H = img.height, d = img.data, E = Math.max(1, Math.round(edge));
  let x0 = W, y0 = H, x1 = -1, y1 = -1, figure = 0;
  for (let i = 0; i < W * H; i++) if (mask[i]) { const x = i % W, y = (i - x) / W; figure++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (!figure) return null;
  const lum = new Map(), lab = new Map();
  const keyAt = (i) => (d[i * 4] << 16) | (d[i * 4 + 1] << 8) | d[i * 4 + 2];
  const L = (k) => { let v = lum.get(k); if (v === undefined) { v = luminanceOf(k >> 16, (k >> 8) & 255, k & 255); lum.set(k, v); } return v; };
  const B = (k) => { let v = lab.get(k); if (!v) { v = labOf(k >> 16, (k >> 8) & 255, k & 255); lab.set(k, v); } return v; };
  const ground = [];   // { i, k, ratio, de, fk }
  const counts = new Map();
  for (let y = Math.max(0, y0 - 1); y <= Math.min(H - 1, y1 + 1); y++) for (let x = Math.max(0, x0 - 1); x <= Math.min(W - 1, x1 + 1); x++) {
    const i = y * W + x;
    if (mask[i]) continue;
    let touches = false;   // the ground ring: pixels touching the silhouette (8-neighbours)
    for (let dy = -1; dy <= 1 && !touches; dy++) for (let dx = -1; dx <= 1 && !touches; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && mask[yy * W + xx]) touches = true; }
    if (!touches) continue;
    const k = keyAt(i), lg = L(k), bg = B(k);
    let ratio = 0, de = 0, fk = -1;
    for (let dy = -E; dy <= E; dy++) for (let dx = -E; dx <= E; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H || !mask[yy * W + xx]) continue;
      const f = keyAt(yy * W + xx), lf = L(f), bf = B(f);
      const r = (Math.max(lf, lg) + 0.05) / (Math.min(lf, lg) + 0.05);
      if (r > ratio) { ratio = r; fk = f; }
      const e = Math.hypot(bf[0] - bg[0], bf[1] - bg[1], bf[2] - bg[2]);
      if (e > de) de = e;
    }
    if (fk < 0) continue;
    ground.push({ i, k, ratio, de, fk });
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  if (!ground.length) return null;
  const { clusters, of } = clusterColors(counts, merge);
  const per = clusters.map(() => []);
  for (const g of ground) per[of.get(g.k)].push(g);
  const stats = (list) => {
    const rs = list.map((g) => g.ratio).sort((a, b) => a - b), es = list.map((g) => g.de).sort((a, b) => a - b);
    const worst = list.reduce((a, g) => (g.ratio < a.ratio ? g : a));
    return {
      ratio: { worst: r2(rs[0]), p10: r2(rank(rs, 0.1)), median: r2(rank(rs, 0.5)) },
      deltaE: { worst: r2(es[0]), p10: r2(rank(es, 0.1)), median: r2(rank(es, 0.5)) },
      under: r2((100 * rs.filter((r) => r < min).length) / rs.length),
      worstAt: [worst.i % W, Math.floor(worst.i / W)], worstGround: hex([worst.k >> 16, (worst.k >> 8) & 255, worst.k & 255]), worstFigure: hex([worst.fk >> 16, (worst.fk >> 8) & 255, worst.fk & 255]),
    };
  };
  const surfaces = clusters.map((c, j) => {
    const list = per[j], color = c.color.map(Math.round);
    let lab0 = null;
    if (label) {
      const lc = new Map();
      for (const g of list) { const l = label(g.i % W, Math.floor(g.i / W)); if (l != null) lc.set(l, (lc.get(l) || 0) + 1); }
      const top = [...lc].sort((a, b) => b[1] - a[1])[0];
      if (top) lab0 = { label: top[0], labelShare: r2(top[1] / list.length) };
    }
    return { cluster: j, color, hex: hex(color), count: list.length, share: r4(list.length / ground.length), minor: list.length / ground.length < minShare, ...(lab0 || {}), ...stats(list) };
  }).sort((a, b) => b.count - a.count);
  const sorted = new Map(surfaces.map((s, n) => [s.cluster, n]));
  for (const s of surfaces) delete s.cluster;
  // textured ground splits the ring into many small surfaces, each under minShare: the small ones together are judged
  // as one (all of the ring when none is big enough), so a figure is never passed with nothing judged
  const small = surfaces.filter((s) => s.minor);
  const smallN = small.reduce((a, s) => a + s.count, 0);
  if (smallN && (smallN / ground.length >= 0.25 || small.length === surfaces.length)) {
    const set = new Set(clusters.map((c, j) => j).filter((j) => per[j].length / ground.length < minShare));
    const list = ground.filter((g) => set.has(of.get(g.k)));
    surfaces.push({ combined: small.length, color: null, hex: small.length === surfaces.length ? "the whole ring" : `${small.length} small surfaces`, count: list.length, share: r4(list.length / ground.length), minor: false, ...stats(list) });
  }
  // [pixel index, ratio, surface index] per ground pixel (for pictures and matching surfaces across shots; not JSON)
  const ring = new Float32Array(ground.length * 3);
  ground.forEach((g, n) => { ring[3 * n] = g.i; ring[3 * n + 1] = g.ratio; ring[3 * n + 2] = sorted.get(of.get(g.k)); });
  return { figure, ground: ground.length, edge: E, min, merge, bbox: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, surfaces, all: stats(ground), ring };
}
