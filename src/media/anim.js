// Witness media: sprite poses from pixels (measure anim). Each frame's crop of one object ({ width, height, data }
// RGBA; alpha 0 = not part of the object) is matched against the poses seen so far: the same pose when at most
// `tolerance` of its pixels differ (allowing a 1 px shift either way, for sub-pixel motion), else a new pose.

/** Fraction of pixels that differ between two crops, best over ±1 px shifts; Infinity when sizes differ by > 1 px. */
export function poseDistance(a, b, { colorThreshold = 24, shift = 1 } = {}) {
  if (!a || !b) return Infinity;
  if (Math.abs(a.width - b.width) > shift || Math.abs(a.height - b.height) > shift) return Infinity;
  const opaque = (im) => { let n = 0; for (let i = 3; i < im.data.length; i += 4) if (im.data[i] > 127) n++; return n; };
  const na = opaque(a), nb = opaque(b), denom = Math.max(1, na, nb);
  let best = Infinity;
  for (let dy = -shift; dy <= shift; dy++) for (let dx = -shift; dx <= shift; dx++) {
    // compare a at (x, y) with b at (x - dx, y - dy) over the union of both rectangles
    let bad = 0;
    const x0 = Math.min(0, dx), y0 = Math.min(0, dy), x1 = Math.max(a.width, b.width + dx), y1 = Math.max(a.height, b.height + dy);
    for (let y = y0; y < y1 && bad < best * denom; y++) for (let x = x0; x < x1; x++) {
      const ia = x >= 0 && y >= 0 && x < a.width && y < a.height ? (y * a.width + x) * 4 : -1;
      const bx = x - dx, by = y - dy;
      const ib = bx >= 0 && by >= 0 && bx < b.width && by < b.height ? (by * b.width + bx) * 4 : -1;
      const pa = ia >= 0 && a.data[ia + 3] > 127, pb = ib >= 0 && b.data[ib + 3] > 127;
      if (!pa && !pb) continue;
      if (pa !== pb) { bad++; continue; }
      if (Math.abs(a.data[ia] - b.data[ib]) > colorThreshold || Math.abs(a.data[ia + 1] - b.data[ib + 1]) > colorThreshold || Math.abs(a.data[ia + 2] - b.data[ib + 2]) > colorThreshold) bad++;
    }
    best = Math.min(best, bad / denom);
  }
  return best;
}

/**
 * Group crops into poses. Returns { labels: [pose number (1-based, in order of first appearance) | null], poses:
 * [{ id, first (index), count, crop }], nearest: per crop the distance to its pose's exemplar }.
 */
export function poseLabels(crops, { tolerance = 0.05, colorThreshold = 24 } = {}) {
  const poses = [], labels = [], nearest = [];
  crops.forEach((c, i) => {
    if (!c) { labels.push(null); nearest.push(null); return; }
    let best = null, bd = Infinity;
    for (const p of poses) { const d = poseDistance(c, p.crop, { colorThreshold }); if (d < bd) { bd = d; best = p; } }
    if (best && bd <= tolerance) { best.count++; labels.push(best.id); nearest.push(+bd.toFixed(3)); return; }
    const p = { id: poses.length + 1, first: i, count: 1, crop: c };
    poses.push(p); labels.push(p.id); nearest.push(0);
  });
  return { labels, poses, nearest };
}

/** The RGBA crop of `rect` from a frame, with pixels outside `mask` (when given) made transparent. */
export function maskedCrop(img, rect, mask = null) {
  const { x, y, w, h } = rect, out = new Uint8Array(w * h * 4);
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    const sx = x + xx, sy = y + yy, o = (yy * w + xx) * 4;
    if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
    const k = sy * img.width + sx;
    if (mask && !mask[k]) continue;
    out[o] = img.data[k * 4]; out[o + 1] = img.data[k * 4 + 1]; out[o + 2] = img.data[k * 4 + 2]; out[o + 3] = 255;
  }
  return { width: w, height: h, data: out };
}
