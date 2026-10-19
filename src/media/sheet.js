// Witness media: crops, crisp zoom and contact sheets (filmstrips) — one picture that shows a whole motion.
//
//   cropImage(img, { x, y, w, h }, { pad })   -> image (pixels outside the source are filled with `pad`)
//   zoomImage(img, k)                          -> image enlarged k× with nearest-neighbour (crisp pixels)
//   frameDiffScore(a, b, threshold)            -> how many pixels differ between two same-size images
//   pickKeyFrames(scores, n, spacing)          -> indices of the n biggest changes, at least `spacing` apart
//   contactSheet(cells, opts)                  -> { png, raster, layout } a labelled grid of frames
//
// Images are { width, height, data: RGBA bytes } (decodePNG output, Raster, or a decoded screenshot).

import { Raster } from "./raster.js";

const BG = "#0b1020", TEXT = "#e6ebff", DIM = "#8b93b8", CELL_BG = "#111833";

/** A w×h crop at (x, y); parts outside the source are filled with `pad` (RGBA). */
export function cropImage(img, { x, y, w, h }, { pad = [11, 16, 32, 255] } = {}) {
  x = Math.round(x); y = Math.round(y); w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const out = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    const sy = y + j;
    for (let i = 0; i < w; i++) {
      const sx = x + i, o = (j * w + i) * 4;
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) { out[o] = pad[0]; out[o + 1] = pad[1]; out[o + 2] = pad[2]; out[o + 3] = pad[3]; continue; }
      const s = (sy * img.width + sx) * 4;
      out[o] = img.data[s]; out[o + 1] = img.data[s + 1]; out[o + 2] = img.data[s + 2]; out[o + 3] = img.data[s + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/** Enlarge k× (integer) with nearest-neighbour: every source pixel becomes a crisp k×k block. */
export function zoomImage(img, k) {
  k = Math.max(1, Math.round(k));
  if (k === 1) return img;
  const W = img.width * k, H = img.height * k, out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = (y / k) | 0;
    for (let x = 0; x < W; x++) {
      const s = (sy * img.width + ((x / k) | 0)) * 4, o = (y * W + x) * 4;
      out[o] = img.data[s]; out[o + 1] = img.data[s + 1]; out[o + 2] = img.data[s + 2]; out[o + 3] = img.data[s + 3];
    }
  }
  return { width: W, height: H, data: out };
}

/** Pixels whose RGB differs by more than `threshold` on any channel (same-size images). */
export function frameDiffScore(a, b, threshold = 16) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return Infinity;
  let n = 0;
  const A = a.data, B = b.data;
  for (let o = 0, e = a.width * a.height * 4; o < e; o += 4) {
    if (Math.abs(A[o] - B[o]) > threshold || Math.abs(A[o + 1] - B[o + 1]) > threshold || Math.abs(A[o + 2] - B[o + 2]) > threshold) n++;
  }
  return n;
}

/**
 * The `n` indices with the biggest scores, each at least `spacing` away from a stronger pick (non-maximum
 * suppression), returned in index order. Zero scores are never picked.
 */
export function pickKeyFrames(scores, n, spacing = 1) {
  const order = scores.map((s, i) => [s, i]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const picked = [];
  for (const [, i] of order) {
    if (picked.length >= n) break;
    if (picked.every((p) => Math.abs(p - i) >= spacing)) picked.push(i);
  }
  return picked.sort((a, b) => a - b);
}

/**
 * A labelled grid of same-size frames.
 * cells: [{ img, label }] (all images the same size; a smaller one is centred in its cell)
 * opts: { cols, title, subtitle, maxWidth = 1600, gap = 8 }
 * Cells are shown at their size, or shrunk (bilinear) so the sheet stays within maxWidth.
 * Returns { png, raster, layout: { cols, rows, cellW, cellH, scale, x0, y0, pitchX, pitchY } }:
 * cell i's image starts at (x0 + (i % cols) * pitchX, y0 + floor(i / cols) * pitchY) in the sheet.
 */
export function contactSheet(cells, { cols, title = "frames", subtitle = "", maxWidth = 1600, gap = 8 } = {}) {
  const n = cells.length;
  if (!n) throw new Error("contactSheet: no frames");
  const iw = Math.max(...cells.map((c) => c.img.width)), ih = Math.max(...cells.map((c) => c.img.height));
  const pad = 12;
  const maxCols = Math.max(1, Math.floor((maxWidth - 2 * pad + gap) / (Math.min(iw, maxWidth) + gap)));
  if (!cols) cols = Math.min(n, Math.max(1, Math.ceil(n / Math.ceil(n / Math.max(1, Math.min(6, maxCols))))));
  cols = Math.max(1, Math.min(n, Math.round(cols)));
  const rows = Math.ceil(n / cols);
  const scale = Math.min(1, (maxWidth - 2 * pad - (cols - 1) * gap) / (cols * iw));
  const cw = Math.max(1, Math.floor(iw * scale)), ch = Math.max(1, Math.floor(ih * scale));
  const labelH = 20, header = title || subtitle ? 44 : 0;
  const W = Math.max(2 * pad + cols * cw + (cols - 1) * gap, 320);
  const H = header + pad + rows * (ch + labelH) + (rows - 1) * gap + pad;
  const g = new Raster(W, H, BG);
  if (title) g.text(g.fitText(title, W - 2 * pad), pad, 16, { bold: true, color: TEXT, baseline: "middle" });
  if (subtitle) g.text(g.fitText(subtitle, W - 2 * pad), pad, 34, { color: DIM, baseline: "middle" });
  const x0 = pad, y0 = header + pad, pitchX = cw + gap, pitchY = ch + labelH + gap;
  cells.forEach((c, i) => {
    const cx = x0 + (i % cols) * pitchX, cy = y0 + Math.floor(i / cols) * pitchY;
    g.fillRect(cx, cy, cw, ch, CELL_BG);
    const w = Math.max(1, Math.round(c.img.width * scale)), h = Math.max(1, Math.round(c.img.height * scale));
    g.drawImage(c.img, { dx: cx + Math.floor((cw - w) / 2), dy: cy + Math.floor((ch - h) / 2), dw: w, dh: h, smooth: scale < 1 ? "bilinear" : "nearest" });
    if (c.label) g.text(g.fitText(String(c.label), cw), cx, cy + ch + 3, { color: c.color || TEXT, baseline: "top" });
  });
  return { png: g.toPNG(), raster: g, layout: { cols, rows, cellW: cw, cellH: ch, scale, x0, y0, pitchX, pitchY } };
}
