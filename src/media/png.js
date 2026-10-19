// Witness media: a dependency-free PNG codec (node:zlib only).
//
//   encodePNG(width, height, rgba)  -> Buffer   8-bit RGBA, adaptive per-row filters
//   decodePNG(buffer)               -> { width, height, data: Uint8Array RGBA }
//
// The decoder reads what engines and screenshot tools write: grayscale, RGB, palette,
// grayscale+alpha and RGBA at 1/2/4/8/16 bits (16-bit is reduced to 8), tRNS
// transparency, and both non-interlaced and Adam7-interlaced images.

import zlib from "node:zlib";

export const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PIXELS = 16384 * 16384;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf, start = 0, end = buf.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// ---------------------------------------------------------------------------
// encode
// ---------------------------------------------------------------------------

/**
 * Encode 8-bit RGBA pixels (top-to-bottom rows) as a PNG.
 * Each row gets the filter with the smallest sum of absolute residuals (the libpng heuristic).
 * Fully opaque images are written as RGB, which makes typical charts ~25% smaller.
 */
export function encodePNG(width, height, rgba, { level = 6 } = {}) {
  width = width | 0; height = height | 0;
  if (width < 1 || height < 1) throw new RangeError(`encodePNG: invalid size ${width}x${height}`);
  if (!rgba || rgba.length < width * height * 4) throw new RangeError(`encodePNG: expected ${width * height * 4} bytes of RGBA, got ${rgba ? rgba.length : 0}`);
  const opaque = isOpaque(rgba, width * height);
  return Buffer.concat([SIGNATURE, pngChunk("IHDR", ihdrData(width, height, opaque)), pngChunk("IDAT", zlib.deflateSync(filterRows(width, height, rgba, opaque), { level })), pngChunk("IEND", Buffer.alloc(0))]);
}

/** Is every pixel of the first `n` RGBA pixels fully opaque? */
export function isOpaque(rgba, n) {
  for (let i = 3; i < n * 4; i += 4) if (rgba[i] !== 255) return false;
  return true;
}

/** The 13-byte IHDR payload for 8-bit RGB (opaque) or RGBA. */
export function ihdrData(width, height, opaque) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return ihdr;
}

/**
 * Filtered scanlines (before deflate) of 8-bit RGBA pixels written as RGB (opaque) or RGBA. Each row gets the
 * filter with the smallest sum of absolute residuals (the libpng heuristic).
 */
export function filterRows(width, height, rgba, opaque) {
  const bpp = opaque ? 3 : 4, stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const src = y * width * 4;
    if (opaque) for (let x = 0, o = 0; x < width; x++, o += 3) { const s = src + x * 4; cur[o] = rgba[s]; cur[o + 1] = rgba[s + 1]; cur[o + 2] = rgba[s + 2]; }
    else for (let i = 0; i < stride; i++) cur[i] = rgba[src + i];
    let best = 0, bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = cand[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (cur[i] - pred) & 0xff;
        out[i] = v;
        score += v < 128 ? v : 256 - v;
        if (score >= bestScore) break;
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    const o = y * (stride + 1);
    raw[o] = best;
    raw.set(cand[best], o + 1);
    [prev, cur] = [cur, prev];
  }
  return raw;
}

// ---------------------------------------------------------------------------
// decode
// ---------------------------------------------------------------------------

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

/** Decode a PNG into 8-bit RGBA. Throws a readable Error on anything malformed. */
export function decodePNG(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : buffer);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("decodePNG: not a PNG file (bad signature)");
  let pos = 8, hdr = null, palette = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString("latin1", pos + 4, pos + 8);
    if (pos + 12 + len > buf.length) throw new Error(`decodePNG: truncated ${type} chunk`);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      hdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!hdr) throw new Error("decodePNG: missing IHDR");
  const { width, height, depth, color, interlace } = hdr;
  const channels = CHANNELS[color];
  if (!channels) throw new Error(`decodePNG: unsupported color type ${color}`);
  if (![1, 2, 4, 8, 16].includes(depth) || (depth < 8 && color !== 0 && color !== 3) || (depth === 16 && color === 3)) {
    throw new Error(`decodePNG: invalid bit depth ${depth} for color type ${color}`);
  }
  if (!width || !height || width * height > MAX_PIXELS) throw new Error(`decodePNG: unsupported size ${width}x${height}`);
  if (color === 3 && !palette) throw new Error("decodePNG: palette image without PLTE");
  if (!idat.length) throw new Error("decodePNG: no image data");
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (e) { throw new Error(`decodePNG: corrupt image data (${e.message})`); }

  const bitsPP = channels * depth, bpp = Math.max(1, bitsPP >> 3);
  const out = new Uint8Array(width * height * 4);
  const ctx = { width, depth, color, channels, palette, trns, out };
  let offset = 0;
  const pass = (x0, y0, dx, dy) => {
    const pw = Math.ceil((width - x0) / dx), ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) return;
    const stride = Math.ceil((pw * bitsPP) / 8);
    if (offset + ph * (stride + 1) > raw.length) throw new Error("decodePNG: image data is shorter than the image");
    let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
    for (let r = 0; r < ph; r++) {
      const f = raw[offset];
      unfilter(f, raw.subarray(offset + 1, offset + 1 + stride), cur, prev, bpp);
      offset += stride + 1;
      writeRow(ctx, cur, pw, y0 + r * dy, x0, dx);
      [prev, cur] = [cur, prev];
    }
  };
  if (interlace === 1) for (const p of ADAM7) pass(...p);
  else pass(0, 0, 1, 1);
  return { width, height, data: out };
}

export function unfilter(f, src, cur, prev, bpp) {
  const n = src.length;
  switch (f) {
    case 0: cur.set(src); break;
    case 1: for (let i = 0; i < n; i++) cur[i] = (src[i] + (i >= bpp ? cur[i - bpp] : 0)) & 0xff; break;
    case 2: for (let i = 0; i < n; i++) cur[i] = (src[i] + prev[i]) & 0xff; break;
    case 3: for (let i = 0; i < n; i++) cur[i] = (src[i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1)) & 0xff; break;
    case 4: for (let i = 0; i < n; i++) cur[i] = (src[i] + paeth(i >= bpp ? cur[i - bpp] : 0, prev[i], i >= bpp ? prev[i - bpp] : 0)) & 0xff; break;
    default: throw new Error(`decodePNG: bad filter type ${f}`);
  }
}

export function writeRow({ width, depth, color, channels, palette, trns, out }, row, pw, y, x0, dx) {
  const sample = (i) => {   // i-th sample of the row, scaled to 0..255
    if (depth === 8) return row[i];
    if (depth === 16) return row[i * 2];
    const perByte = 8 / depth, b = row[Math.floor(i / perByte)], shift = 8 - depth * (1 + (i % perByte));
    return (b >> shift) & ((1 << depth) - 1);
  };
  const scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1;
  const raw16 = (i) => (row[i * 2] << 8) | row[i * 2 + 1];
  for (let k = 0; k < pw; k++) {
    const x = x0 + k * dx;
    if (x >= width) break;
    const o = (y * width + x) * 4, s = k * channels;
    let r, g, b, a = 255;
    if (color === 3) {
      const idx = sample(s);
      r = palette[idx * 3] ?? 0; g = palette[idx * 3 + 1] ?? 0; b = palette[idx * 3 + 2] ?? 0;
      if (trns && idx < trns.length) a = trns[idx];
    } else if (color === 0 || color === 4) {
      const v = sample(s);
      r = g = b = Math.round(v * scale);
      if (color === 4) a = sample(s + 1);
      else if (trns && trns.length >= 2) {
        const key = (trns[0] << 8) | trns[1];
        if ((depth === 16 ? raw16(s) : v) === key) a = 0;
      }
    } else {
      r = sample(s); g = sample(s + 1); b = sample(s + 2);
      if (color === 6) a = sample(s + 3);
      else if (trns && trns.length >= 6) {
        const eq = depth === 16
          ? raw16(s) === ((trns[0] << 8) | trns[1]) && raw16(s + 1) === ((trns[2] << 8) | trns[3]) && raw16(s + 2) === ((trns[4] << 8) | trns[5])
          : r === trns[1] && g === trns[3] && b === trns[5];
        if (eq) a = 0;
      }
    }
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
  }
}

/** True when `buf` starts with the PNG signature. */
export const isPNG = (buf) => !!buf && buf.length >= 8 && Buffer.from(buf.subarray(0, 8)).equals(SIGNATURE);
