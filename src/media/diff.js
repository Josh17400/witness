// Witness media: screenshot diffs (for `witness shot --diff`).
//
//   diffImages(a, b, { threshold = 16, ignore = [], title, align = false, resize = true }) ->
//     { identical, changedPercent, changedPixels, boxes: [{ x, y, w, h, pixels, kind, moved? }], maxDelta,
//       ssim, shift: null | { dx, dy, rawPercent }, width, height, sizeMismatch: null | { a, b }, moves: [...], png }
//
// a and b: PNG Buffers, decoded { width, height, data } images, or Rasters. A pixel counts as changed when any RGBA
// channel differs by more than `threshold` (0..255). Changed pixels are clustered into boxes (pixels within ~16 px of
// each other share a box), largest first, and each box gets a kind:
//   appeared — something is in B that wasn't in A (A shows background there), gone — the reverse,
//   moved    — a gone box whose content shows up as an appeared box elsewhere (moved: [dx, dy], from: the old box),
//              or a box whose content in B is A's content shifted a little (moved within the box),
//   changed  — anything else (recoloured, animated, replaced).
// align: when the whole picture moved (a camera shift), compare after undoing it and report the shift.
// ignore: regions ([{ x, y, w, h }] in A's pixels, e.g. an FPS counter) are never compared.
// resize: when the sizes differ, B is scaled to A's size (bilinear) and the mismatch reported; false throws instead.
// ssim: the structural similarity of the luminance (8×8 windows, stride 4): 1 = identical, tolerant of tiny noise.
// png: A │ B │ changes side by side, the same numbered boxes on all three (coloured by kind), and a header.

import { Raster } from "./raster.js";
import { decodePNG } from "./png.js";
import { backgroundPalette } from "./align.js";
import { estimateShift } from "./track.js";

const MAGENTA = [255, 43, 214], BG = "#0b1020", TEXT = "#e6ebff", DIM = "#8b93b8", WARN = "#ff5d73", GOOD = "#3ddc97";
const KIND_COLOR = { appeared: "#3ddc97", gone: "#ff5d73", moved: "#4cc9f0", changed: "#ffd166" };
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

/** The change mask of A vs B (B read at x + dx, y + dy), outside the ignore mask; pixels outside B's overlap don't count. */
function changeMask(A, B, w, h, thr, skip, dx = 0, dy = 0) {
  const mask = new Uint8Array(w * h), delta = new Uint8Array(w * h);
  const da = A.data, db = B.data;
  let changed = 0, maxDelta = 0;
  for (let y = 0; y < h; y++) {
    const y2 = y + dy;
    if (y2 < 0 || y2 >= h) continue;
    for (let x = 0; x < w; x++) {
      const x2 = x + dx, i = y * w + x;
      if (x2 < 0 || x2 >= w || skip[i]) continue;
      const o = i * 4, q = (y2 * w + x2) * 4;
      const d = Math.max(Math.abs(da[o] - db[q]), Math.abs(da[o + 1] - db[q + 1]), Math.abs(da[o + 2] - db[q + 2]), Math.abs(da[o + 3] - db[q + 3]));
      delta[i] = d;
      if (d > maxDelta) maxDelta = d;
      if (d > thr) { mask[i] = 1; changed++; }
    }
  }
  return { mask, delta, changed, maxDelta };
}

/** Mean SSIM of the luminance, 8×8 windows every 4 px (ignored pixels count as equal). */
export function ssim(A, B, w, h, skip = null) {
  const L = (img) => { const out = new Float64Array(w * h), d = img.data; for (let i = 0; i < w * h; i++) out[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]; return out; };
  const a = L(A), b = L(B);
  if (skip) for (let i = 0; i < w * h; i++) if (skip[i]) b[i] = a[i];
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  let sum = 0, n = 0;
  for (let y = 0; y + 8 <= h; y += 4) for (let x = 0; x + 8 <= w; x += 4) {
    let ma = 0, mb = 0;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const k = (y + j) * w + x + i; ma += a[k]; mb += b[k]; }
    ma /= 64; mb /= 64;
    let va = 0, vb = 0, cov = 0;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const k = (y + j) * w + x + i, p = a[k] - ma, q = b[k] - mb; va += p * p; vb += q * q; cov += p * q; }
    va /= 63; vb /= 63; cov /= 63;
    sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2)); n++;
  }
  return n ? Math.round((sum / n) * 10000) / 10000 : 1;
}

/** Share of a box's changed pixels that are not background (palette) colours in image X. */
function objectness(X, mask, w, box, pal, thr) {
  let n = 0, obj = 0;
  const d = X.data;
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
    const i = y * w + x;
    if (!mask[i]) continue;
    n++;
    const o = i * 4;
    if (!pal.some((c) => Math.abs(d[o] - c[0]) <= thr && Math.abs(d[o + 1] - c[1]) <= thr && Math.abs(d[o + 2] - c[2]) <= thr)) obj++;
  }
  return n ? obj / n : 0;
}

/** Mean absolute RGB difference between A's pixels in box a and B's pixels in box b (same size, top-left aligned). */
function contentDiff(A, B, w, h, a, b) {
  const W = Math.min(a.w, b.w), H = Math.min(a.h, b.h);
  let s = 0, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ax = a.x + x, ay = a.y + y, bx = b.x + x, by = b.y + y;
    if (ax >= w || ay >= h || bx >= w || by >= h) continue;
    const o = (ay * w + ax) * 4, q = (by * w + bx) * 4;
    s += Math.abs(A.data[o] - B.data[q]) + Math.abs(A.data[o + 1] - B.data[q + 1]) + Math.abs(A.data[o + 2] - B.data[q + 2]);
    n++;
  }
  return n ? s / (3 * n) : Infinity;
}

/**
 * A shift inside one box (old and new silhouettes close enough to share it): the (dx, dy) within ±r that best maps
 * A's object pixels (not background) in the box onto B, and B's back onto A. Null unless it explains the change.
 */
function shiftInside(A, B, w, h, box, r, pal, thr) {
  const isBg = (img, o) => pal.some((c) => Math.abs(img.data[o] - c[0]) <= thr && Math.abs(img.data[o + 1] - c[1]) <= thr && Math.abs(img.data[o + 2] - c[2]) <= thr);
  const SA = [], SB = [];
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
    const o = (y * w + x) * 4;
    if (!isBg(A, o)) SA.push([x, y]);
    if (!isBg(B, o)) SB.push([x, y]);
  }
  if (!SA.length || !SB.length) return null;
  const px = (img, x, y) => { if (x < 0 || y < 0 || x >= w || y >= h) return null; const o = (y * w + x) * 4; return [img.data[o], img.data[o + 1], img.data[o + 2]]; };
  const err = (dx, dy) => {
    let s = 0, n = 0;
    for (const [x, y] of SA) { const p = px(A, x, y), q = px(B, x + dx, y + dy); s += q ? Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) : 765; n++; }
    for (const [x, y] of SB) { const p = px(B, x, y), q = px(A, x - dx, y - dy); s += q ? Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) : 765; n++; }
    return s / n;
  };
  const e0 = err(0, 0);
  let best = { dx: 0, dy: 0, e: e0 };
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { if (!dx && !dy) continue; const e = err(dx, dy); if (e < best.e) best = { dx, dy, e }; }
  return best.e < 0.25 * e0 && best.e < 30 && (best.dx || best.dy) ? best : null;
}

/** Compare two images. See the header for the result. */
export function diffImages(imgA, imgB, { threshold = 16, ignore = [], title = "screenshot diff", align = false, resize = true } = {}) {
  const A = toImage(imgA, "A");
  let B = toImage(imgB, "B");
  const w = A.width, h = A.height;
  const sizeMismatch = B.width !== w || B.height !== h ? { a: [w, h], b: [B.width, B.height] } : null;
  if (sizeMismatch) {
    if (!resize) throw new RangeError(`diffImages: sizes differ (A ${w}×${h}, B ${B.width}×${B.height}): pass resize to scale B to A's size`);
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
  let cm = changeMask(A, B, w, h, thr, skip);
  // a camera shift turns everything into a change: undo it when that explains most of the difference
  let shift = null;
  if (align && cm.changed > 0 && !sizeMismatch) {
    const s = estimateShift(A, B, { maxShift: 32 });
    if (s.dx || s.dy) {
      const al = changeMask(A, B, w, h, thr, skip, s.dx, s.dy);   // B(x + d) = A(x)
      // pixels that scrolled out of view don't count against the aligned comparison
      if (al.changed < 0.5 * cm.changed) { shift = { dx: s.dx, dy: s.dy, rawPercent: Math.round((cm.changed / (w * h)) * 1e6) / 1e4 }; cm = al; }
    }
  }
  const { mask, delta, changed, maxDelta } = cm;
  const allBoxes = changed ? clusterBoxes(mask, w, h) : [];
  const boxes = allBoxes.slice(0, MAX_BOXES);
  // what each region is: appeared / gone / moved / changed
  const moves = [];
  if (boxes.length && !shift) {
    const pal = backgroundPalette(A);
    for (const b of boxes) {
      const oa = objectness(A, mask, w, b, pal, 24), ob = objectness(B, mask, w, b, pal, 24);
      b.kind = oa < 0.35 && ob >= 0.5 ? "appeared" : oa >= 0.5 && ob < 0.35 ? "gone" : "changed";
    }
    // a gone box whose content reappears in an appeared box of about the same size: one thing that moved
    for (const g of boxes.filter((b) => b.kind === "gone")) {
      let best = null;
      for (const p of boxes.filter((b) => b.kind === "appeared" && !b.from)) {
        if (Math.abs(p.w - g.w) > Math.max(2, 0.2 * g.w) || Math.abs(p.h - g.h) > Math.max(2, 0.2 * g.h)) continue;
        const e = contentDiff(A, B, w, h, g, p);
        if (e < 20 && (!best || e < best.e)) best = { p, e };
      }
      if (best) {
        const p = best.p;
        p.kind = "moved"; p.moved = [p.x - g.x, p.y - g.y]; p.from = { x: g.x, y: g.y, w: g.w, h: g.h };
        g.kind = "moved"; g.movedTo = { x: p.x, y: p.y }; g.moved = p.moved; g.isFrom = true;
        moves.push({ from: { x: g.x, y: g.y, w: g.w, h: g.h }, to: { x: p.x, y: p.y, w: p.w, h: p.h }, by: p.moved });
      }
    }
    // a changed box whose content is A's shifted a little: it moved within its box
    for (const b of boxes.filter((q) => q.kind === "changed")) {
      const s = shiftInside(A, B, w, h, b, Math.max(16, Math.min(64, Math.max(b.w, b.h))), pal, 24);
      if (s) { b.kind = "moved"; b.moved = [s.dx, s.dy]; b.within = true; moves.push({ from: { x: b.x, y: b.y, w: b.w, h: b.h }, to: { x: b.x + s.dx, y: b.y + s.dy, w: b.w, h: b.h }, by: [s.dx, s.dy], within: true }); }
    }
  } else for (const b of boxes) b.kind = "changed";
  const changedPercent = Math.round((changed / (w * h)) * 1e6) / 1e4;
  const result = { identical: changed === 0 && !sizeMismatch && !shift, changedPercent, changedPixels: changed, boxes, moves, maxDelta, width: w, height: h, threshold: thr, sizeMismatch, shift, ssim: ssim(A, shift ? shifted(B, w, h, shift) : B, w, h, skip) };
  result.png = visualize({ A, B, w, h, mask, delta, skip, result, moreBoxes: allBoxes.length - boxes.length, title });
  return result;
}

/** B moved back by a camera shift (B(x + d) placed at x, for SSIM after alignment); pixels that scrolled in keep B's own values. */
function shifted(B, w, h, s) {
  const out = { width: w, height: h, data: Uint8Array.from(B.data.subarray(0, w * h * 4)) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x2 = x + s.dx, y2 = y + s.dy;
    if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h) continue;
    const o = (y * w + x) * 4, q = (y2 * w + x2) * 4;
    for (let c = 0; c < 4; c++) out.data[o + c] = B.data[q + c];
  }
  return out;
}

function visualize({ A, B, w, h, mask, delta, skip, result, moreBoxes, title }) {
  // the changes panel: B dimmed, changed pixels magenta (stronger for bigger changes), ignored regions hatched
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
  // three panels side by side: small screenshots are enlarged (crisp), large ones shrunk, all within ~1600 px
  const pad = 16, gap = 12;
  const k = w * 3 < 900 ? Math.min(3, Math.floor(1560 / (3 * w))) || 1 : Math.min(1, (1560 - 2 * gap) / (3 * w));
  const vw = Math.round(w * k), vh = Math.round(h * k);
  const header = result.sizeMismatch || result.shift ? 86 : 64, label = 18;
  const W = Math.max(3 * vw + 2 * gap + pad * 2, 720), H = header + label + vh + pad;
  const g = new Raster(W, H, BG);
  const ox = Math.round((W - (3 * vw + 2 * gap)) / 2), oy = header + label;
  const panels = [[A, "A (reference)"], [B, "B (now)"], [base, "changes"]];
  panels.forEach(([img, name], p) => {
    const px = ox + p * (vw + gap);
    g.drawImage(img, { dx: px, dy: oy, dw: vw, dh: vh, smooth: k < 1 ? "bilinear" : "nearest" });
    g.strokeRect(px - 1, oy - 1, vw + 2, vh + 2, "rgba(255,255,255,0.18)");
    g.text(name, px, oy - 4, { color: DIM, baseline: "bottom" });
  });

  // header
  const r = result;
  const fmtN = (n) => n.toLocaleString("en-US");
  g.text(g.fitText(title, W - 300), pad, 22, { scale: 2, bold: true, color: TEXT, baseline: "middle" });
  const pct = r.changedPercent, shownPct = pct >= 10 ? pct.toFixed(1) : pct >= 0.1 ? pct.toFixed(2) : pct >= 0.001 ? pct.toFixed(3) : "<0.001";
  const verdict = r.changedPixels === 0 ? (r.shift ? "only the camera moved" : "identical") : `${shownPct}% changed`;
  g.text(verdict, W - pad, 22, { scale: 2, bold: true, color: r.changedPixels === 0 ? GOOD : "#ff2bd6", align: "right", baseline: "middle" });
  const kinds = {};
  for (const b of r.boxes) if (!b.isFrom) kinds[b.kind] = (kinds[b.kind] || 0) + 1;
  const stats = `${fmtN(r.changedPixels)} px over threshold ${r.threshold} · ${r.boxes.length + moreBoxes} region${r.boxes.length + moreBoxes === 1 ? "" : "s"}${Object.keys(kinds).length ? ` (${Object.entries(kinds).map(([kk, n]) => `${n} ${kk}`).join(", ")})` : ""} · SSIM ${r.ssim} · max Δ ${r.maxDelta} · ${w}×${h}${k !== 1 ? ` (shown ×${+k.toFixed(2)})` : ""}`;
  g.text(g.fitText(stats, W - pad * 2), pad, 50, { color: DIM, baseline: "middle" });
  if (r.sizeMismatch) g.text(g.fitText(`size differs: A ${r.sizeMismatch.a.join("×")} vs B ${r.sizeMismatch.b.join("×")} — B was scaled to A's size to compare`, W - pad * 2), pad, 72, { color: WARN, bold: true, baseline: "middle" });
  else if (r.shift) g.text(g.fitText(`the camera moved ${r.shift.dx > 0 ? "left" : r.shift.dx < 0 ? "right" : ""}${r.shift.dx && r.shift.dy ? " and " : ""}${r.shift.dy > 0 ? "up" : r.shift.dy < 0 ? "down" : ""} (picture shifted ${r.shift.dx},${r.shift.dy}); compared after undoing it (${r.shift.rawPercent}% differed before)`, W - pad * 2), pad, 72, { color: "#4cc9f0", bold: true, baseline: "middle" });

  // boxes, numbered (largest = 1), the same on all three panels, coloured by kind
  r.boxes.forEach((b, i) => {
    const col = KIND_COLOR[b.kind] || "#4cc9f0";
    for (let p = 0; p < 3; p++) {
      const px = ox + p * (vw + gap);
      g.save().clip(px - 3, oy - 3, vw + 6, vh + 6);
      const x = px + b.x * k, y = oy + b.y * k, bw = Math.max(3, b.w * k), bh = Math.max(3, b.h * k);
      g.strokeRect(Math.round(x) - 2, Math.round(y) - 2, Math.round(bw) + 4, Math.round(bh) + 4, col, 2);
      if (i < 20) {
        const lab = String(i + 1), lw = g.measureText(lab) + 8;
        const lx = Math.min(px + vw - lw, Math.max(px, Math.round(x) - 2)), ly = Math.round(y) - 22 >= oy ? Math.round(y) - 22 : Math.round(y + bh) + 4;
        g.roundRect(lx, ly, lw, 18, 3, col);
        g.text(lab, lx + 4, ly + 9, { color: BG, bold: true, baseline: "middle" });
      }
      g.restore();
    }
  });
  return g.toPNG();
}
