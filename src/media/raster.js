// Witness media: a small Canvas-like rasterizer on an RGBA buffer (no browser needed).
//
//   const r = new Raster(640, 360, "#0d0f14");
//   r.fillRect(10, 10, 100, 40, "#4cc9f0");
//   r.polyline([[0, 0], [50, 80], [90, 20]], "#ff4d8d", 2.25);
//   r.text("Hello", 20, 20, { scale: 2, bold: true, color: "#fff" });
//   fs.writeFileSync("out.png", r.toPNG());
//
// Everything is anti-aliased by exact coverage (rects, round rects, circles, polygons) or by
// distance to the stroke (lines), and composited source-over. Text uses the embedded 8x16
// bitmap font, crisp at 1x and smoothed with Scale2x/Scale3x at 2x and 3x.
// Colors: "#rgb", "#rrggbb", "#rrggbbaa", "rgb(...)", "rgba(...)", [r, g, b, a?] (a 0..1).

import { encodePNG, decodePNG } from "./png.js";
import { glyph, CELL_W, CELL_H, BASELINE } from "./font.js";

// ---------------------------------------------------------------------------
// colors
// ---------------------------------------------------------------------------

const colorCache = new Map();

/** Parse a color into [r, g, b, a] with r/g/b 0..255 and a 0..1. */
export function parseColor(c) {
  if (Array.isArray(c)) return [c[0] | 0, c[1] | 0, c[2] | 0, c[3] ?? 1];
  if (c && typeof c === "object" && "r" in c) return [c.r | 0, c.g | 0, c.b | 0, c.a ?? 1];
  const key = String(c ?? "#000");
  let v = colorCache.get(key);
  if (v) return v;
  const s = key.trim().toLowerCase();
  let m;
  if (s[0] === "#") {
    const h = s.slice(1);
    const x = h.length <= 4 ? [...h].map((d) => parseInt(d + d, 16)) : h.match(/../g).map((d) => parseInt(d, 16));
    v = [x[0], x[1], x[2], x.length > 3 ? x[3] / 255 : 1];
  } else if ((m = s.match(/^rgba?\(([^)]+)\)$/))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    v = [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  } else if (s === "transparent") v = [0, 0, 0, 0];
  else if (s === "white") v = [255, 255, 255, 1];
  else if (s === "black") v = [0, 0, 0, 1];
  if (!v || v.some((n) => !Number.isFinite(n))) throw new Error(`raster: cannot parse color ${JSON.stringify(c)}`);
  colorCache.set(key, v);
  return v;
}

/** The same color with its alpha multiplied by `a`. */
export const withAlpha = (c, a) => { const [r, g, b, a0] = parseColor(c); return [r, g, b, a0 * a]; };

/** Linear blend of two colors (t = 0 → a, 1 → b). */
export const mixColor = (a, b, t) => { const x = parseColor(a), y = parseColor(b); return x.map((v, i) => (i < 3 ? Math.round(v + (y[i] - v) * t) : v + (y[i] - v) * t)); };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------------------
// glyph masks (scaled and emboldened on demand, cached)
// ---------------------------------------------------------------------------

/** Scale2x / Scale3x (EPX): pixel-art upscaling that rounds diagonals instead of stair-stepping. */
function epx(src, w, h, s) {
  const W = w * s, out = new Uint8Array(W * h * s);
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : src[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const E = at(x, y), B = at(x, y - 1), D = at(x - 1, y), F = at(x + 1, y), H = at(x, y + 1);
      let blk;
      if (s === 2) {
        blk = B !== H && D !== F
          ? [D === B ? D : E, B === F ? F : E, D === H ? D : E, H === F ? F : E]
          : [E, E, E, E];
      } else {
        const A = at(x - 1, y - 1), C = at(x + 1, y - 1), G = at(x - 1, y + 1), I = at(x + 1, y + 1);
        if (B !== H && D !== F) {
          blk = [
            D === B ? D : E, (D === B && E !== C) || (B === F && E !== A) ? B : E, B === F ? F : E,
            (D === B && E !== G) || (D === H && E !== A) ? D : E, E, (B === F && E !== I) || (H === F && E !== C) ? F : E,
            D === H ? D : E, (D === H && E !== I) || (H === F && E !== G) ? H : E, H === F ? F : E,
          ];
        } else blk = new Array(9).fill(E);
      }
      for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) out[(y * s + j) * W + x * s + i] = blk[j * s + i];
    }
  }
  return out;
}

const maskCache = new Map();

/**
 * Ink mask for a character at an integer scale: { w, h, m }. Bold thickens strokes to the
 * right, except ink already in the cell's last column grows left, so bold text keeps its gaps.
 */
function glyphMask(ch, scale, bold) {
  const key = `${ch}\u0000${scale}${bold ? "b" : ""}`;
  let g = maskCache.get(key);
  if (g) return g;
  const base = glyph(ch);
  let m = scale === 1 ? base : scale === 2 || scale === 3 ? epx(base, CELL_W, CELL_H, scale) : null;
  if (!m) {   // larger scales: plain nearest-neighbour blocks
    m = new Uint8Array(CELL_W * scale * CELL_H * scale);
    for (let y = 0; y < CELL_H * scale; y++) for (let x = 0; x < CELL_W * scale; x++) m[y * CELL_W * scale + x] = base[((y / scale) | 0) * CELL_W + ((x / scale) | 0)];
  }
  const w = CELL_W * scale, h = CELL_H * scale, shift = bold ? Math.max(1, Math.round(scale * 0.6)) : 0;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      const from = x + shift < w ? x : x - shift;
      for (let k = 0; k <= shift; k++) out[y * w + from + k] = 1;
    }
  }
  g = { w, h, m: out };
  maskCache.set(key, g);
  return g;
}

// ---------------------------------------------------------------------------
// the raster
// ---------------------------------------------------------------------------

export class Raster {
  /**
   * @param width, height  size in pixels
   * @param background     optional fill color (default transparent)
   */
  constructor(width, height, background = null) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.data = new Uint8Array(this.width * this.height * 4);
    this._clip = { x0: 0, y0: 0, x1: this.width, y1: this.height };
    this._stack = [];
    if (background != null) this.fill(background);
  }

  /** Wrap decoded pixels ({ width, height, data }) or decode a PNG buffer. */
  static from(img) {
    if (Buffer.isBuffer(img) || img instanceof Uint8Array) img = decodePNG(img);
    const r = new Raster(img.width, img.height);
    r.data.set(img.data.subarray(0, r.data.length));
    return r;
  }

  toPNG() { return encodePNG(this.width, this.height, this.data); }

  clone() { const r = new Raster(this.width, this.height); r.data.set(this.data); return r; }

  // ---- clipping -------------------------------------------------------------------

  /** Push the current clip; restore() pops it. */
  save() { this._stack.push({ ...this._clip }); return this; }
  restore() { if (this._stack.length) this._clip = this._stack.pop(); return this; }

  /** Intersect the clip with a rectangle (integer pixel bounds). */
  clip(x, y, w, h) {
    const c = this._clip;
    c.x0 = Math.max(c.x0, Math.floor(x)); c.y0 = Math.max(c.y0, Math.floor(y));
    c.x1 = Math.min(c.x1, Math.ceil(x + w)); c.y1 = Math.min(c.y1, Math.ceil(y + h));
    return this;
  }

  // ---- pixels --------------------------------------------------------------------------

  /** Composite (r, g, b) at opacity `a` (0..1) over pixel (x, y); no clip test. */
  _blend(x, y, r, g, b, a) {
    if (a <= 0) return;
    const o = (y * this.width + x) * 4, d = this.data;
    if (a >= 1) { d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255; return; }
    const da = d[o + 3] / 255;
    if (da === 1) {
      d[o] = d[o] + (r - d[o]) * a + 0.5; d[o + 1] = d[o + 1] + (g - d[o + 1]) * a + 0.5; d[o + 2] = d[o + 2] + (b - d[o + 2]) * a + 0.5;
      return;
    }
    const oa = a + da * (1 - a);
    if (oa <= 0) return;
    d[o] = (r * a + d[o] * da * (1 - a)) / oa + 0.5;
    d[o + 1] = (g * a + d[o + 1] * da * (1 - a)) / oa + 0.5;
    d[o + 2] = (b * a + d[o + 2] * da * (1 - a)) / oa + 0.5;
    d[o + 3] = oa * 255 + 0.5;
  }

  /** Blend a color at pixel (x, y) with extra coverage (respects the clip). */
  blendPixel(x, y, color, coverage = 1) {
    x |= 0; y |= 0;
    const c = this._clip;
    if (x < c.x0 || y < c.y0 || x >= c.x1 || y >= c.y1) return this;
    const [r, g, b, a] = parseColor(color);
    this._blend(x, y, r, g, b, a * coverage);
    return this;
  }

  /** [r, g, b, a] (a 0..255) of a pixel, or null outside the image. */
  getPixel(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    const o = ((y | 0) * this.width + (x | 0)) * 4;
    return [this.data[o], this.data[o + 1], this.data[o + 2], this.data[o + 3]];
  }

  /** Replace a block of pixels with raw RGBA (no blending; respects the clip). */
  putRGBA(x, y, w, h, rgba) {
    x = Math.round(x); y = Math.round(y);
    const c = this._clip;
    for (let j = Math.max(0, c.y0 - y); j < h && y + j < c.y1; j++) {
      const i0 = Math.max(0, c.x0 - x), i1 = Math.min(w, c.x1 - x);
      if (i1 <= i0) continue;
      this.data.set(rgba.subarray((j * w + i0) * 4, (j * w + i1) * 4), ((y + j) * this.width + x + i0) * 4);
    }
    return this;
  }

  // ---- fills ------------------------------------------------------------------------------

  /** Fill the clip region (the whole image by default), replacing pixels. */
  fill(color) {
    const [r, g, b, a] = parseColor(color), A = Math.round(a * 255), c = this._clip, d = this.data;
    for (let y = c.y0; y < c.y1; y++) for (let x = c.x0, o = (y * this.width + x) * 4; x < c.x1; x++, o += 4) { d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = A; }
    return this;
  }

  /** Filled rectangle; fractional edges get partial coverage. */
  fillRect(x, y, w, h, color) {
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    if (!(w > 0 && h > 0)) return this;
    const [r, g, b, a] = parseColor(color), c = this._clip;
    const x1 = x + w, y1 = y + h;
    const px0 = Math.max(c.x0, Math.floor(x)), px1 = Math.min(c.x1, Math.ceil(x1));
    const py0 = Math.max(c.y0, Math.floor(y)), py1 = Math.min(c.y1, Math.ceil(y1));
    for (let py = py0; py < py1; py++) {
      const cy = Math.min(py + 1, y1) - Math.max(py, y);
      for (let px = px0; px < px1; px++) {
        const cx = Math.min(px + 1, x1) - Math.max(px, x);
        this._blend(px, py, r, g, b, a * cx * cy);
      }
    }
    return this;
  }
  /** Alias of fillRect. */
  rect(x, y, w, h, color) { return this.fillRect(x, y, w, h, color); }

  /** Rectangle outline drawn inside (x, y, w, h). */
  strokeRect(x, y, w, h, color, width = 1) {
    const t = Math.min(width, w / 2, h / 2);
    this.fillRect(x, y, w, t, color);
    this.fillRect(x, y + h - t, w, t, color);
    this.fillRect(x, y + t, t, h - 2 * t, color);
    this.fillRect(x + w - t, y + t, t, h - 2 * t, color);
    return this;
  }

  /** Signed-distance shape fill over a bounding box: cov(px+0.5, py+0.5) in 0..1. */
  _coverage(bx0, by0, bx1, by1, color, cov) {
    const [r, g, b, a] = parseColor(color), c = this._clip;
    const x0 = Math.max(c.x0, Math.floor(bx0)), x1 = Math.min(c.x1, Math.ceil(bx1));
    const y0 = Math.max(c.y0, Math.floor(by0)), y1 = Math.min(c.y1, Math.ceil(by1));
    for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
      const v = cov(px + 0.5, py + 0.5);
      if (v > 0) this._blend(px, py, r, g, b, a * (v > 1 ? 1 : v));
    }
    return this;
  }

  /** Filled rounded rectangle (anti-aliased corners). */
  roundRect(x, y, w, h, radius, color) {
    if (!(w > 0 && h > 0)) return this;
    const rr = Math.max(0, Math.min(radius, w / 2, h / 2)), cx = x + w / 2, cy = y + h / 2, hx = w / 2 - rr, hy = h / 2 - rr;
    return this._coverage(x, y, x + w, y + h, color, (px, py) => 0.5 - sdRoundBox(px - cx, py - cy, hx, hy, rr));
  }

  /** Rounded rectangle outline of `width` px, drawn inside the box. */
  strokeRoundRect(x, y, w, h, radius, color, width = 1) {
    if (!(w > 0 && h > 0)) return this;
    const rr = Math.max(0, Math.min(radius, w / 2, h / 2)), cx = x + w / 2, cy = y + h / 2, hx = w / 2 - rr, hy = h / 2 - rr, hw = width / 2;
    return this._coverage(x, y, x + w, y + h, color, (px, py) => 0.5 - (Math.abs(sdRoundBox(px - cx, py - cy, hx, hy, rr) + hw) - hw));
  }

  /** Filled circle. */
  circle(cx, cy, radius, color) {
    return this._coverage(cx - radius - 1, cy - radius - 1, cx + radius + 1, cy + radius + 1, color, (px, py) => radius + 0.5 - Math.hypot(px - cx, py - cy));
  }

  /** Circle outline centred on the radius. */
  strokeCircle(cx, cy, radius, color, width = 1) {
    const hw = width / 2, R = radius + hw + 1;
    return this._coverage(cx - R, cy - R, cx + R, cy + R, color, (px, py) => hw + 0.5 - Math.abs(Math.hypot(px - cx, py - cy) - radius));
  }

  /**
   * Filled polygon (even-odd), anti-aliased with 5 sub-scanlines and exact horizontal coverage.
   * points: [[x, y], ...]
   */
  polygon(points, color) {
    const pts = normPoints(points);
    if (pts.length < 3) return this;
    const [r, g, b, a] = parseColor(color), c = this._clip;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const x0 = Math.max(c.x0, Math.floor(minX)), x1 = Math.min(c.x1, Math.ceil(maxX));
    const y0 = Math.max(c.y0, Math.floor(minY)), y1 = Math.min(c.y1, Math.ceil(maxY));
    if (x1 <= x0 || y1 <= y0) return this;
    const S = 5, rowCov = new Float32Array(x1 - x0 + 1), xs = [];
    for (let py = y0; py < y1; py++) {
      rowCov.fill(0);
      for (let k = 0; k < S; k++) {
        const sy = py + (k + 0.5) / S;
        xs.length = 0;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xa, ya] = pts[j], [xb, yb] = pts[i];
          if ((ya <= sy && yb > sy) || (yb <= sy && ya > sy)) xs.push(xa + ((sy - ya) / (yb - ya)) * (xb - xa));
        }
        xs.sort((p, q) => p - q);
        for (let i = 0; i + 1 < xs.length; i += 2) addSpan(rowCov, xs[i] - x0, xs[i + 1] - x0, 1 / S);
      }
      for (let px = x0; px < x1; px++) { const v = rowCov[px - x0]; if (v > 0) this._blend(px, py, r, g, b, a * (v > 1 ? 1 : v)); }
    }
    return this;
  }

  // ---- strokes -------------------------------------------------------------------------------

  /** Anti-aliased line with round caps. opts: { dash: [on, off] } */
  line(x0, y0, x1, y1, color, width = 1, opts = {}) {
    return this.polyline([[x0, y0], [x1, y1]], color, width, opts);
  }

  /**
   * Anti-aliased polyline with round joins and caps. The stroke's coverage is the union of
   * its segments, so joins never double-blend even with translucent colors.
   * points: [[x, y], ...] (non-finite points split the line into separate runs)
   * opts: { dash: [on, off, ...], closed: false }
   */
  polyline(points, color, width = 1, { dash = null, closed = false } = {}) {
    const runs = [];
    let cur = [];
    for (const p of points) {
      if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) cur.push([p[0], p[1]]);
      else { if (cur.length) runs.push(cur); cur = []; }
    }
    if (cur.length) runs.push(cur);
    if (closed && runs.length === 1 && runs[0].length > 2) runs[0].push(runs[0][0]);
    let segs = [];
    for (const run of runs) {
      if (run.length === 1) segs.push([run[0][0], run[0][1], run[0][0], run[0][1]]);
      for (let i = 1; i < run.length; i++) segs.push([run[i - 1][0], run[i - 1][1], run[i][0], run[i][1]]);
    }
    if (dash && dash.length) segs = dashSegments(runs, dash);
    if (!segs.length) return this;
    const [r, g, b, a] = parseColor(color), c = this._clip;
    const hw = Math.max(0.5, width / 2), alphaScale = width < 1 ? a * Math.max(0.05, width) : a;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const s of segs) {
      minX = Math.min(minX, s[0], s[2]); maxX = Math.max(maxX, s[0], s[2]);
      minY = Math.min(minY, s[1], s[3]); maxY = Math.max(maxY, s[1], s[3]);
    }
    const bx0 = Math.max(c.x0, Math.floor(minX - hw - 1)), bx1 = Math.min(c.x1, Math.ceil(maxX + hw + 1));
    const by0 = Math.max(c.y0, Math.floor(minY - hw - 1)), by1 = Math.min(c.y1, Math.ceil(maxY + hw + 1));
    if (bx1 <= bx0 || by1 <= by0) return this;
    const bw = bx1 - bx0, cov = scratch(bw * (by1 - by0));
    let ux0 = bx1, ux1 = bx0, uy0 = by1, uy1 = by0;   // touched area
    for (const [ax, ay, ex, ey] of segs) {
      const sx0 = Math.max(bx0, Math.floor(Math.min(ax, ex) - hw - 1)), sx1 = Math.min(bx1, Math.ceil(Math.max(ax, ex) + hw + 1));
      const sy0 = Math.max(by0, Math.floor(Math.min(ay, ey) - hw - 1)), sy1 = Math.min(by1, Math.ceil(Math.max(ay, ey) + hw + 1));
      if (sx1 <= sx0 || sy1 <= sy0) continue;
      ux0 = Math.min(ux0, sx0); ux1 = Math.max(ux1, sx1); uy0 = Math.min(uy0, sy0); uy1 = Math.max(uy1, sy1);
      const dx = ex - ax, dy = ey - ay, len2 = dx * dx + dy * dy;
      for (let py = sy0; py < sy1; py++) {
        const cyy = py + 0.5 - ay;
        for (let px = sx0; px < sx1; px++) {
          const cxx = px + 0.5 - ax;
          const t = len2 > 0 ? clamp01((cxx * dx + cyy * dy) / len2) : 0;
          const qx = cxx - t * dx, qy = cyy - t * dy;
          const v = hw + 0.5 - Math.sqrt(qx * qx + qy * qy);
          if (v <= 0) continue;
          const i = (py - by0) * bw + px - bx0;
          if (v > cov[i]) cov[i] = v > 1 ? 1 : v;
        }
      }
    }
    for (let py = uy0; py < uy1; py++) {
      for (let px = ux0; px < ux1; px++) {
        const i = (py - by0) * bw + px - bx0, v = cov[i];
        if (v > 0) { this._blend(px, py, r, g, b, alphaScale * v); cov[i] = 0; }
      }
    }
    return this;
  }

  // ---- images ------------------------------------------------------------------------------------

  /**
   * Draw (part of) another image, scaled.
   * src: a Raster, { width, height, data } or a PNG Buffer
   * opts: { sx, sy, sw, sh (crop, default whole), dx, dy, dw, dh (destination, default crop size),
   *         smooth: "nearest" | "bilinear" (bilinear averages areas when shrinking), alpha: 0..1 }
   */
  drawImage(src, opts = {}) {
    if (Buffer.isBuffer(src)) src = decodePNG(src);
    const sx = opts.sx ?? 0, sy = opts.sy ?? 0, sw = opts.sw ?? src.width - sx, sh = opts.sh ?? src.height - sy;
    const dx = opts.dx ?? 0, dy = opts.dy ?? 0, dw = opts.dw ?? sw, dh = opts.dh ?? sh;
    const alpha = opts.alpha ?? 1, bilinear = (opts.smooth ?? "nearest") === "bilinear";
    if (!(sw > 0 && sh > 0 && dw > 0 && dh > 0)) return this;
    const c = this._clip, S = src.data, W = src.width;
    const x0 = Math.max(c.x0, Math.floor(dx)), x1 = Math.min(c.x1, Math.ceil(dx + dw));
    const y0 = Math.max(c.y0, Math.floor(dy)), y1 = Math.min(c.y1, Math.ceil(dy + dh));
    const kx = sw / dw, ky = sh / dh;
    const cx0 = Math.max(0, Math.floor(sx)), cy0 = Math.max(0, Math.floor(sy));
    const cx1 = Math.min(src.width, Math.ceil(sx + sw)) - 1, cy1 = Math.min(src.height, Math.ceil(sy + sh)) - 1;
    if (cx1 < cx0 || cy1 < cy0) return this;
    const px = [0, 0, 0, 0];
    const sample = (u, v) => {   // bilinear at source coords (pixel centres at +0.5), clamped to the crop
      u -= 0.5; v -= 0.5;
      let iu = Math.floor(u), iv = Math.floor(v);
      const fu = u - iu, fv = v - iv;
      const u0 = Math.min(cx1, Math.max(cx0, iu)), u1 = Math.min(cx1, Math.max(cx0, iu + 1));
      const v0 = Math.min(cy1, Math.max(cy0, iv)), v1 = Math.min(cy1, Math.max(cy0, iv + 1));
      const o00 = (v0 * W + u0) * 4, o10 = (v0 * W + u1) * 4, o01 = (v1 * W + u0) * 4, o11 = (v1 * W + u1) * 4;
      const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;
      // premultiplied so transparent neighbours don't darken edges
      const a00 = S[o00 + 3] * w00, a10 = S[o10 + 3] * w10, a01 = S[o01 + 3] * w01, a11 = S[o11 + 3] * w11, A = a00 + a10 + a01 + a11;
      for (let k = 0; k < 3; k++) px[k] = A > 0 ? (S[o00 + k] * a00 + S[o10 + k] * a10 + S[o01 + k] * a01 + S[o11 + k] * a11) / A : 0;
      px[3] = A;
    };
    const area = (u0, v0, u1, v1) => {   // box average over a source rectangle (shrinking)
      const i0 = Math.max(cx0, Math.floor(u0)), i1 = Math.min(cx1, Math.ceil(u1) - 1);
      const j0 = Math.max(cy0, Math.floor(v0)), j1 = Math.min(cy1, Math.ceil(v1) - 1);
      let r = 0, g = 0, b = 0, A = 0, n = 0;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const o = (j * W + i) * 4, al = S[o + 3];
        r += S[o] * al; g += S[o + 1] * al; b += S[o + 2] * al; A += al; n++;
      }
      px[0] = A ? r / A : 0; px[1] = A ? g / A : 0; px[2] = A ? b / A : 0; px[3] = n ? A / n : 0;
    };
    const shrink = bilinear && (kx > 1.5 || ky > 1.5);
    for (let y = y0; y < y1; y++) {
      const v = sy + (y + 0.5 - dy) * ky;
      for (let x = x0; x < x1; x++) {
        const u = sx + (x + 0.5 - dx) * kx;
        if (shrink) area(u - kx / 2, v - ky / 2, u + kx / 2, v + ky / 2);
        else if (bilinear) sample(u, v);
        else {
          const iu = Math.min(cx1, Math.max(cx0, Math.floor(u))), iv = Math.min(cy1, Math.max(cy0, Math.floor(v)));
          const o = (iv * W + iu) * 4;
          px[0] = S[o]; px[1] = S[o + 1]; px[2] = S[o + 2]; px[3] = S[o + 3];
        }
        if (px[3] > 0) this._blend(x, y, px[0] + 0.5 | 0, px[1] + 0.5 | 0, px[2] + 0.5 | 0, (px[3] / 255) * alpha);
      }
    }
    return this;
  }

  // ---- text ------------------------------------------------------------------------------------------

  /** Width in pixels of `str` (the widest line) in the bitmap font. */
  measureText(str, { scale = 1 } = {}) {
    const s = intScale(scale);
    return Math.max(0, ...String(str).split("\n").map((l) => [...l].length)) * CELL_W * s;
  }

  /** Line height in pixels for a scale. */
  lineHeight(scale = 1) { return CELL_H * intScale(scale); }

  /** `str` shortened with "…" so it fits in `maxWidth` pixels. */
  fitText(str, maxWidth, { scale = 1 } = {}) {
    const chars = [...String(str)], fit = Math.floor(maxWidth / (CELL_W * intScale(scale)));
    if (chars.length <= fit) return chars.join("");
    return fit <= 0 ? "" : chars.slice(0, fit - 1).join("").trimEnd() + "…";
  }

  /**
   * Draw text. Returns the drawn width.
   * opts: { color = "#fff", scale = 1 | 2 | 3, bold = false, align = "left" | "center" | "right",
   *         baseline = "top" | "middle" | "alphabetic" | "bottom", maxWidth (truncates with …),
   *         lineGap = 2 (extra px between lines of a multi-line string) }
   * "middle" centres capitals on y; "alphabetic" puts the baseline on y.
   */
  text(str, x, y, { color = "#ffffff", scale = 1, bold = false, align = "left", baseline = "top", maxWidth = null, lineGap = 2 } = {}) {
    const s = intScale(scale);
    const lines = String(str ?? "").split("\n");
    const [r, g, b, a] = parseColor(color), c = this._clip;
    const lh = CELL_H * s + lineGap;
    let top = y - (baseline === "middle" ? 8 * s : baseline === "alphabetic" ? BASELINE * s : baseline === "bottom" ? CELL_H * s : 0);
    if (baseline === "middle" || baseline === "alphabetic" || baseline === "bottom") top -= ((lines.length - 1) * lh) * (baseline === "middle" ? 0.5 : 1);
    top = Math.round(top);
    let widest = 0;
    for (const raw of lines) {
      const line = maxWidth != null ? this.fitText(raw, maxWidth, { scale: s }) : raw;
      const chars = [...line], w = chars.length * CELL_W * s;
      widest = Math.max(widest, w);
      let left = Math.round(align === "center" ? x - w / 2 : align === "right" ? x - w : x);
      for (const ch of chars) {
        if (ch !== " ") {
          const gm = glyphMask(ch, s, bold);
          const gx0 = Math.max(0, c.x0 - left), gx1 = Math.min(gm.w, c.x1 - left);
          const gy0 = Math.max(0, c.y0 - top), gy1 = Math.min(gm.h, c.y1 - top);
          for (let gy = gy0; gy < gy1; gy++) for (let gx = gx0; gx < gx1; gx++) if (gm.m[gy * gm.w + gx]) this._blend(left + gx, top + gy, r, g, b, a);
        }
        left += CELL_W * s;
      }
      top += lh;
    }
    return widest;
  }

  /** Text rotated 90° counter-clockwise (reading bottom to top), centred on (cx, cy). Same opts as text(). */
  textUp(str, cx, cy, opts = {}) {
    const s = intScale(opts.scale ?? 1), w = this.measureText(str, { scale: s }), h = CELL_H * s;
    if (!w) return this;
    const tmp = new Raster(w, h);
    tmp.text(str, 0, 0, { ...opts, scale: s, align: "left", baseline: "top", maxWidth: null });
    const [r, g, b] = parseColor(opts.color ?? "#ffffff"), c = this._clip;
    const ox = Math.round(cx - 8 * s), oy = Math.round(cy + w / 2);   // capitals centred on cx
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = tmp.data[(y * w + x) * 4 + 3];
        if (!a) continue;
        const dx = ox + y, dy = oy - 1 - x;
        if (dx >= c.x0 && dy >= c.y0 && dx < c.x1 && dy < c.y1) this._blend(dx, dy, r, g, b, a / 255);
      }
    }
    return this;
  }

  /** Text on a rounded "pill" background. Returns { x, y, w, h } of the pill. */
  label(str, x, y, { color = "#ffffff", background = "#000000", padX = 6, padY = 3, radius = 4, scale = 1, bold = false, align = "left", baseline = "top" } = {}) {
    const s = intScale(scale), w = this.measureText(str, { scale: s }) + padX * 2, h = 10 * s + padY * 2;   // cap height + padding
    let bx = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
    let by = baseline === "middle" ? y - h / 2 : baseline === "bottom" ? y - h : y;
    bx = Math.round(bx); by = Math.round(by);
    this.roundRect(bx, by, w, h, radius, background);
    this.text(str, bx + padX, by + padY - 3 * s, { color, scale: s, bold });
    return { x: bx, y: by, w, h };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const intScale = (s) => Math.max(1, Math.min(8, Math.round(s) || 1));

function sdRoundBox(px, py, hx, hy, r) {
  const qx = Math.abs(px) - hx, qy = Math.abs(py) - hy;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function normPoints(points) {
  if (!points.length) return [];
  if (typeof points[0] === "number") { const out = []; for (let i = 0; i + 1 < points.length; i += 2) out.push([points[i], points[i + 1]]); return out; }
  return points.filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

/** Add coverage for the horizontal span [a, b) (in row-local pixels) with weight w. */
function addSpan(row, a, b, w) {
  const n = row.length - 1;
  a = Math.max(0, a); b = Math.min(n, b);
  if (b <= a) return;
  const ia = Math.floor(a), ib = Math.floor(b);
  if (ia === ib) { row[ia] += (b - a) * w; return; }
  row[ia] += (ia + 1 - a) * w;
  for (let i = ia + 1; i < ib; i++) row[i] += w;
  if (ib < n) row[ib] += (b - ib) * w;
}

/** Cut runs of points into dash segments following the on/off pattern (continuous across vertices). */
function dashSegments(runs, pattern) {
  const pat = pattern.map((v) => Math.max(0.5, +v || 0));
  if (pat.length % 2) pat.push(...pat);
  const segs = [];
  for (const run of runs) {
    let k = 0, left = pat[0], on = true;
    for (let i = 1; i < run.length; i++) {
      let [ax, ay] = run[i - 1];
      const [bx, by] = run[i];
      let len = Math.hypot(bx - ax, by - ay);
      const ux = len ? (bx - ax) / len : 0, uy = len ? (by - ay) / len : 0;
      while (len > 0) {
        const step = Math.min(left, len), nx = ax + ux * step, ny = ay + uy * step;
        if (on) segs.push([ax, ay, nx, ny]);
        ax = nx; ay = ny; len -= step; left -= step;
        if (left <= 1e-9) { k = (k + 1) % pat.length; left = pat[k]; on = !on; }
      }
    }
  }
  return segs;
}

let scratchBuf = new Float32Array(0);
function scratch(n) {
  if (scratchBuf.length < n) scratchBuf = new Float32Array(n);
  return scratchBuf;
}
