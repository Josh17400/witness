// Witness media: screenshot diffs (for `witness shot --diff`).
//
//   diffImages(a, b, { threshold = 16, ignore = [], title }) ->
//     { identical, changedPercent, changedPixels, boxes: [{ x, y, w, h, pixels }], maxDelta,
//       width, height, sizeMismatch: null | { a: [w, h], b: [w, h] }, png }
//
// a and b: PNG Buffers, decoded { width, height, data } images, or Rasters. A pixel counts as
// changed when any RGBA channel differs by more than `threshold` (0..255). Changed pixels are
// clustered into boxes (pixels within ~16 px of each other share a box), largest first.
// `ignore` regions ([{ x, y, w, h }] in A's pixels, e.g. an FPS counter) are never compared.
// When the sizes differ, B is scaled to A's size (bilinear) and the mismatch is reported.
// png: B dimmed, changed pixels in magenta, boxes outlined and numbered, a header with stats;
// small screenshots are enlarged (crisp, integer factor) and large ones shrunk to fit 1280 px.

import { Raster } from "./raster.js";
import { decodePNG } from "./png.js";

const MAGENTA = [255, 43, 214], BOX = "#4cc9f0", BG = "#0b1020", TEXT = "#e6ebff", DIM = "#8b93b8", WARN = "#ff5d73", GOOD = "#3ddc97";
const CELL = 8, MAX_BOXES = 64;

function toImage(img, which) {
  if (img instanceof Raster) return img;
  if (Buffer.isBuffer(img) || img instanceof Uint8Array) {
    try { return decodePNG(img); } catch (e) { throw new Error(`diffImages: image ${which} is not a readable PNG (${e.message})`); }
  }
  if (img && img.width > 0 && img.height > 0 && img.data && img.data.length >= img.width * img.height * 4) return img;
  throw new TypeError(`diffImages: image ${which} must be a PNG Buffer, a Raster or { width, height, data }`);
}

/** Connected clusters of changed pixels -> tight boxes, largest first. */
function clusterBoxes(mask, w, h) {
  const cw = Math.ceil(w / CELL), chh = Math.ceil(h / CELL);
  const cells = new Uint8Array(cw * chh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) cells[((y / CELL) | 0) * cw + ((x / CELL) | 0)] = 1;
  // grow by one cell so changes up to ~2 cells apart join the same cluster
  const grown = new Uint8Array(cells.length);
  for (let cy = 0; cy < chh; cy++) for (let cx = 0; cx < cw; cx++) {
    if (!cells[cy * cw + cx]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if (nx >= 0 && ny >= 0 && nx < cw && ny < chh) grown[ny * cw + nx] = 1;
    }
  }
  const label = new Int32Array(cells.length).fill(-1);
  const boxes = [];
  const stack = [];
  for (let start = 0; start < cells.length; start++) {
    if (!grown[start] || label[start] >= 0) continue;
    const id = boxes.length, members = [];
    label[start] = id; stack.push(start);
    while (stack.length) {
      const c = stack.pop();
      members.push(c);
      const cx = c % cw, cy = (c / cw) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= chh) continue;
        const n = ny * cw + nx;
        if (grown[n] && label[n] < 0) { label[n] = id; stack.push(n); }
      }
    }
    // tight bounds of the actually changed pixels inside this cluster's original cells
    let x0 = w, y0 = h, x1 = -1, y1 = -1, pixels = 0;
    for (const c of members) {
      if (!cells[c]) continue;
      const bx = (c % cw) * CELL, by = ((c / cw) | 0) * CELL;
      for (let y = by; y < Math.min(h, by + CELL); y++) for (let x = bx; x < Math.min(w, bx + CELL); x++) {
        if (!mask[y * w + x]) continue;
        pixels++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    boxes.push(pixels ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, pixels } : null);
  }
  return boxes.filter(Boolean).sort((p, q) => q.pixels - p.pixels || p.y - q.y || p.x - q.x);
}

/** Compare two images. See the header for the result. */
export function diffImages(imgA, imgB, { threshold = 16, ignore = [], title = "screenshot diff" } = {}) {
  const A = toImage(imgA, "A");
  let B = toImage(imgB, "B");
  const w = A.width, h = A.height;
  const sizeMismatch = B.width !== w || B.height !== h ? { a: [w, h], b: [B.width, B.height] } : null;
  if (sizeMismatch) {
    const scaled = new Raster(w, h);
    scaled.drawImage(B, { dw: w, dh: h, smooth: "bilinear" });
    B = scaled;
  }
  const thr = Math.max(0, Math.min(254, Math.round(threshold)));
  const skip = new Uint8Array(w * h);
  for (const r of Array.isArray(ignore) ? ignore : []) {
    if (!r) continue;
    for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(h, Math.ceil(r.y + r.h)); y++) for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(w, Math.ceil(r.x + r.w)); x++) skip[y * w + x] = 1;
  }
  const mask = new Uint8Array(w * h), delta = new Uint8Array(w * h);
  const da = A.data, db = B.data;
  let changed = 0, maxDelta = 0;
  for (let i = 0, o = 0; i < w * h; i++, o += 4) {
    if (skip[i]) continue;
    const d = Math.max(Math.abs(da[o] - db[o]), Math.abs(da[o + 1] - db[o + 1]), Math.abs(da[o + 2] - db[o + 2]), Math.abs(da[o + 3] - db[o + 3]));
    delta[i] = d;
    if (d > maxDelta) maxDelta = d;
    if (d > thr) { mask[i] = 1; changed++; }
  }
  const allBoxes = changed ? clusterBoxes(mask, w, h) : [];
  const boxes = allBoxes.slice(0, MAX_BOXES);
  const changedPercent = Math.round((changed / (w * h)) * 1e6) / 1e4;
  const result = { identical: changed === 0 && !sizeMismatch, changedPercent, changedPixels: changed, boxes, maxDelta, width: w, height: h, threshold: thr, sizeMismatch };
  result.png = visualize({ B, w, h, mask, delta, skip, result, moreBoxes: allBoxes.length - boxes.length, title });
  return result;
}

function visualize({ B, w, h, mask, delta, skip, result, moreBoxes, title }) {
  // B dimmed, changed pixels magenta (stronger for bigger changes), ignored regions hatched
  const base = new Raster(w, h);
  const d = base.data, src = B.data;
  for (let i = 0, o = 0; i < w * h; i++, o += 4) {
    const a = src[o + 3] / 255;
    let r = src[o] * a * 0.32 + 11 * (1 - a), g = src[o + 1] * a * 0.32 + 16 * (1 - a), b = src[o + 2] * a * 0.32 + 32 * (1 - a);
    if (mask[i]) {
      const k = 0.65 + 0.35 * (delta[i] / 255);
      r = r + (MAGENTA[0] - r) * k; g = g + (MAGENTA[1] - g) * k; b = b + (MAGENTA[2] - b) * k;
    } else if (skip[i] && ((i % w) + ((i / w) | 0)) % 8 < 2) { r = 70; g = 76; b = 100; }
    d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
  }
  // display scale: small screenshots are enlarged (crisp), huge ones shrunk
  const k = w < 640 ? Math.min(4, Math.ceil(640 / w)) : w > 1248 ? 1248 / w : 1;   // the whole picture stays <= 1280 wide
  const vw = Math.round(w * k), vh = Math.round(h * k);
  const pad = 16, header = result.sizeMismatch ? 86 : 64;
  const W = Math.max(vw + pad * 2, 720), H = header + vh + pad;
  const g = new Raster(W, H, BG);
  const ox = Math.round((W - vw) / 2), oy = header;
  g.drawImage(base, { dx: ox, dy: oy, dw: vw, dh: vh, smooth: k < 1 ? "bilinear" : "nearest" });
  g.strokeRect(ox - 1, oy - 1, vw + 2, vh + 2, "rgba(255,255,255,0.18)");

  // header
  const r = result;
  const fmtN = (n) => n.toLocaleString("en-US");
  g.text(title, pad, 22, { scale: 2, bold: true, color: TEXT, baseline: "middle" });
  const pct = r.changedPercent, shownPct = pct >= 10 ? pct.toFixed(1) : pct >= 0.1 ? pct.toFixed(2) : pct >= 0.001 ? pct.toFixed(3) : "<0.001";
  const verdict = r.changedPixels === 0 ? "identical" : `${shownPct}% changed`;
  g.text(verdict, W - pad, 22, { scale: 2, bold: true, color: r.changedPixels === 0 ? GOOD : "#ff2bd6", align: "right", baseline: "middle" });
  const stats = `${fmtN(r.changedPixels)} px over threshold ${r.threshold} · ${r.boxes.length + moreBoxes} region${r.boxes.length + moreBoxes === 1 ? "" : "s"} · max Δ ${r.maxDelta} · ${w}×${h}${k !== 1 ? ` (shown ×${+k.toFixed(2)})` : ""}`;
  g.text(g.fitText(stats, W - pad * 2), pad, 50, { color: DIM, baseline: "middle" });
  if (r.sizeMismatch) {
    g.text(g.fitText(`size differs: A ${r.sizeMismatch.a.join("×")} vs B ${r.sizeMismatch.b.join("×")} — B was scaled to A's size to compare`, W - pad * 2), pad, 72, { color: WARN, bold: true, baseline: "middle" });
  }

  // boxes, numbered (largest = 1)
  g.save().clip(ox - 3, oy - 3, vw + 6, vh + 6);
  r.boxes.forEach((b, i) => {
    const x = ox + b.x * k, y = oy + b.y * k, bw = Math.max(3, b.w * k), bh = Math.max(3, b.h * k);
    g.strokeRect(Math.round(x) - 2, Math.round(y) - 2, Math.round(bw) + 4, Math.round(bh) + 4, BOX, 2);
    if (i < 20) {
      const label = String(i + 1), lw = g.measureText(label) + 8;
      const lx = Math.min(ox + vw - lw, Math.max(ox, Math.round(x) - 2)), ly = Math.round(y) - 22 >= oy ? Math.round(y) - 22 : Math.round(y + bh) + 4;
      g.roundRect(lx, ly, lw, 18, 3, BOX);
      g.text(label, lx + 4, ly + 9, { color: BG, bold: true, baseline: "middle" });
    }
  });
  g.restore();
  return g.toPNG();
}
