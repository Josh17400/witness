// Witness media: animated PNG (APNG) clips, no dependencies (node:zlib only).
//
//   encodeAPNG(frames, { delays, fps, plays, maxBytes })  -> { png, stored, delays, bytes }
//   decodeAPNG(buffer)                                    -> { width, height, plays, frames: [...], chunks }
//
// APNG = a normal PNG (IHDR, IDAT = the first frame, which every PNG viewer shows) plus three chunk types:
// acTL (frame count, loop count), fcTL (each frame's rectangle, delay and dispose/blend ops) and fdAT (the later
// frames' pixel data, like IDAT with a sequence number). fcTL and fdAT share one sequence counter starting at 0.
// Frames after the first store only the rectangle that changed since the frame before (dispose NONE, blend
// SOURCE), and frames identical to the one before are merged into its delay, so a mostly static clip stays small.

import zlib from "node:zlib";
import { SIGNATURE, pngChunk, crc32, isOpaque, ihdrData, filterRows, unfilter, writeRow } from "./png.js";

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** The bounding box of the pixels that differ between two same-size RGBA images, or null. */
export function changedBox(a, b) {
  const { width: w, height: h } = a;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  const A = a.data, B = b.data;
  for (let y = 0; y < h; y++) {
    let row = y * w * 4;
    for (let x = 0; x < w; x++, row += 4) {
      if (A[row] !== B[row] || A[row + 1] !== B[row + 1] || A[row + 2] !== B[row + 2] || A[row + 3] !== B[row + 3]) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function cropRGBA(img, r) {
  const out = new Uint8Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) out.set(img.data.subarray(((r.y + y) * img.width + r.x) * 4, ((r.y + y) * img.width + r.x + r.w) * 4), y * r.w * 4);
  return out;
}

function fcTL(seq, r, num, den) {
  const d = Buffer.alloc(26);
  d.writeUInt32BE(seq, 0); d.writeUInt32BE(r.w, 4); d.writeUInt32BE(r.h, 8); d.writeUInt32BE(r.x, 12); d.writeUInt32BE(r.y, 16);
  d.writeUInt16BE(num, 20); d.writeUInt16BE(den, 22);
  d[24] = 0;   // dispose_op NONE: the next frame draws over this one
  d[25] = 0;   // blend_op SOURCE: the rectangle replaces what was there
  return pngChunk("fcTL", d);
}

/**
 * Encode same-size RGBA frames ({ width, height, data }) as an animated PNG.
 * delays: per frame, how many 1/fps units it stays on screen (default 1 each); fps: the delay denominator.
 * plays: 0 = loop forever. Returns { png: Buffer, stored: frames written (identical neighbours merged),
 * delays: [[num, den], ...] per stored frame, sourceIndex: [i of the source frame each stored frame starts at],
 * bytes }.
 */
export function encodeAPNG(frames, { delays = null, fps = 60, plays = 0, level = 6 } = {}) {
  if (!Array.isArray(frames) || !frames.length) throw new TypeError("encodeAPNG: no frames");
  const { width, height } = frames[0];
  for (const [i, f] of frames.entries()) if (f.width !== width || f.height !== height) throw new RangeError(`encodeAPNG: frame ${i} is ${f.width}×${f.height}, frame 0 is ${width}×${height}`);
  const den = Math.max(1, Math.min(65535, Math.round(fps)));
  const delay = (i) => Math.max(1, Math.round(delays ? delays[i] ?? 1 : 1));
  const opaque = frames.every((f) => isOpaque(f.data, width * height));
  // stored frames: the first whole, later ones as the changed rectangle; identical frames extend the delay
  const stored = [{ rect: { x: 0, y: 0, w: width, h: height }, src: 0, num: delay(0) }];
  for (let i = 1; i < frames.length; i++) {
    const r = changedBox(frames[i - 1], frames[i]);
    if (!r) { stored[stored.length - 1].num += delay(i); continue; }
    stored.push({ rect: r, src: i, num: delay(i) });
  }
  // a delay is 16 bits (over 18 minutes at 60 fps): cap it
  for (const s of stored) s.num = Math.min(65535, s.num);
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(stored.length, 0); actl.writeUInt32BE(plays, 4);
  const parts = [SIGNATURE, pngChunk("IHDR", ihdrData(width, height, opaque)), pngChunk("acTL", actl)];
  let seq = 0;
  stored.forEach((s, k) => {
    parts.push(fcTL(seq++, s.rect, s.num, den));
    const img = frames[s.src];
    const px = k === 0 ? img.data : cropRGBA(img, s.rect);
    const z = zlib.deflateSync(filterRows(s.rect.w, s.rect.h, px, opaque), { level });
    if (k === 0) parts.push(pngChunk("IDAT", z));
    else { const sq = Buffer.alloc(4); sq.writeUInt32BE(seq++, 0); parts.push(pngChunk("fdAT", Buffer.concat([sq, z]))); }
  });
  parts.push(pngChunk("IEND", Buffer.alloc(0)));
  const png = Buffer.concat(parts);
  return { png, stored: stored.length, delays: stored.map((s) => [s.num, den]), sourceIndex: stored.map((s) => s.src), rects: stored.map((s) => s.rect), bytes: png.length, opaque };
}

/**
 * Decode an APNG (or a plain PNG, as one frame): checks the chunk CRCs and the fcTL/fdAT sequence, and composites
 * every frame. Returns { width, height, plays, numFrames, frames: [{ x, y, w, h, delay: [num, den], delayMs,
 * dispose, blend, image: full-canvas RGBA after this frame }], chunks: [type, ...], defaultIsFirst }.
 */
export function decodeAPNG(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("decodeAPNG: not a PNG file");
  let pos = 8, hdr = null, actl = null, palette = null, trns = null, seqWant = 0, cur = null, sawIDAT = false;
  const chunks = [], raw = [];
  const frames = [];   // { ctl, data: [Buffer] }
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString("latin1", pos + 4, pos + 8);
    if (pos + 12 + len > buf.length) throw new Error(`decodeAPNG: truncated ${type} chunk`);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (crc32(buf, pos + 4, pos + 8 + len) !== buf.readUInt32BE(pos + 8 + len)) throw new Error(`decodeAPNG: bad CRC in ${type}`);
    chunks.push(type);
    if (type === "IHDR") hdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "acTL") actl = { numFrames: data.readUInt32BE(0), plays: data.readUInt32BE(4) };
    else if (type === "fcTL") {
      const sq = data.readUInt32BE(0);
      if (sq !== seqWant++) throw new Error(`decodeAPNG: fcTL sequence ${sq}, expected ${seqWant - 1}`);
      cur = { ctl: { w: data.readUInt32BE(4), h: data.readUInt32BE(8), x: data.readUInt32BE(12), y: data.readUInt32BE(16), num: data.readUInt16BE(20), den: data.readUInt16BE(22), dispose: data[24], blend: data[25] }, data: [], beforeIDAT: !sawIDAT };
      frames.push(cur);
    } else if (type === "IDAT") { sawIDAT = true; raw.push(data); if (cur && cur.beforeIDAT && frames.length === 1) cur.data.push(data); }
    else if (type === "fdAT") {
      const sq = data.readUInt32BE(0);
      if (sq !== seqWant++) throw new Error(`decodeAPNG: fdAT sequence ${sq}, expected ${seqWant - 1}`);
      if (!cur) throw new Error("decodeAPNG: fdAT before any fcTL");
      cur.data.push(data.subarray(4));
    } else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!hdr) throw new Error("decodeAPNG: missing IHDR");
  const { width, height, depth, color } = hdr;
  if (hdr.interlace) throw new Error("decodeAPNG: interlaced APNG is not supported");
  const channels = CHANNELS[color];
  const bitsPP = channels * depth, bpp = Math.max(1, bitsPP >> 3);
  const decodeRect = (zs, w, h) => {
    const inflated = zlib.inflateSync(Buffer.concat(zs));
    const out = new Uint8Array(w * h * 4);
    const stride = Math.ceil((w * bitsPP) / 8);
    if (inflated.length < h * (stride + 1)) throw new Error("decodeAPNG: frame data is shorter than its rectangle");
    let prev = new Uint8Array(stride), row = new Uint8Array(stride);
    for (let r = 0; r < h; r++) {
      const o = r * (stride + 1);
      unfilter(inflated[o], inflated.subarray(o + 1, o + 1 + stride), row, prev, bpp);
      writeRow({ width: w, depth, color, channels, palette, trns, out }, row, w, r, 0, 1);
      [prev, row] = [row, prev];
    }
    return out;
  };
  if (!actl || !frames.length) {
    const img = decodeRect(raw, width, height);
    return { width, height, plays: 0, numFrames: 1, frames: [{ x: 0, y: 0, w: width, h: height, delay: [0, 0], delayMs: 0, dispose: 0, blend: 0, image: img }], chunks, defaultIsFirst: true };
  }
  if (actl.numFrames !== frames.length) throw new Error(`decodeAPNG: acTL says ${actl.numFrames} frames, found ${frames.length}`);
  const canvas = new Uint8Array(width * height * 4);
  const out = [];
  for (const f of frames) {
    const c = f.ctl;
    if (c.x + c.w > width || c.y + c.h > height) throw new Error("decodeAPNG: a frame rectangle leaves the canvas");
    const px = decodeRect(f.data, c.w, c.h);
    const before = c.dispose === 2 ? Uint8Array.from(canvas) : null;
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      const s = (y * c.w + x) * 4, d = ((c.y + y) * width + c.x + x) * 4;
      if (c.blend === 0 || px[s + 3] === 255) { canvas[d] = px[s]; canvas[d + 1] = px[s + 1]; canvas[d + 2] = px[s + 2]; canvas[d + 3] = px[s + 3]; }
      else if (px[s + 3]) {
        const a = px[s + 3] / 255, ab = canvas[d + 3] / 255, ao = a + ab * (1 - a);
        for (let k = 0; k < 3; k++) canvas[d + k] = Math.round((px[s + k] * a + canvas[d + k] * ab * (1 - a)) / ao);
        canvas[d + 3] = Math.round(ao * 255);
      }
    }
    const den = c.den || 100;
    out.push({ x: c.x, y: c.y, w: c.w, h: c.h, delay: [c.num, c.den], delayMs: (1000 * c.num) / den, dispose: c.dispose, blend: c.blend, image: Uint8Array.from(canvas) });
    if (c.dispose === 1) for (let y = 0; y < c.h; y++) canvas.fill(0, ((c.y + y) * width + c.x) * 4, ((c.y + y) * width + c.x + c.w) * 4);
    else if (c.dispose === 2) canvas.set(before);
  }
  return { width, height, plays: actl.plays, numFrames: frames.length, frames: out, chunks, defaultIsFirst: frames[0].beforeIDAT };
}
