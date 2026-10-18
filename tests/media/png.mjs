// PNG codec tests: `node tests/media/png.mjs`
// Round trips through our encoder, plus hand-built files in every color type, bit depth,
// filter and interlacing a screenshot tool might write.
import zlib from "node:zlib";
import { encodePNG, decodePNG, isPNG } from "../../src/media/png.js";
import { ok, show, done } from "./harness.mjs";

console.log("png");

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---- round trips through encodePNG -----------------------------------------------------
function pattern(w, h, alpha) {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    d[o] = (x * 7 + y * 3) & 255; d[o + 1] = (x * y) & 255; d[o + 2] = (255 - x * 5) & 255;
    d[o + 3] = alpha ? (x * 11 + y * 13) & 255 : 255;
  }
  return d;
}
for (const [w, h, alpha] of [[1, 1, false], [3, 2, true], [64, 48, false], [127, 31, true], [640, 360, false]]) {
  const src = pattern(w, h, alpha);
  const png = encodePNG(w, h, src);
  const back = decodePNG(png);
  ok(`round trip ${w}x${h}${alpha ? " rgba" : " rgb"}`, back.width === w && back.height === h && same(back.data, src));
}
{
  // a flat image compresses to almost nothing; noise does not
  const flat = new Uint8Array(512 * 512 * 4).fill(200);
  const noise = new Uint8Array(512 * 512 * 4);
  let st = 2463534242;
  for (let i = 0; i < noise.length; i++) { st ^= st << 13; st ^= st >>> 17; st ^= st << 5; noise[i] = st & 255; }
  const a = encodePNG(512, 512, flat), b = encodePNG(512, 512, noise);
  show("512² flat / noise", `${a.length} B / ${b.length} B`);
  ok("flat image compresses", a.length < 3000, a.length);
  ok("noise stays big (no false compression)", b.length > 512 * 512 * 3, b.length);
  ok("noise round trips", same(decodePNG(b).data, noise));
  ok("isPNG", isPNG(a) && !isPNG(Buffer.from("GIF89a....")));
}

// ---- hand-built files: every color type and depth ------------------------------------------
function crc(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
}
/** Build a PNG from rows of raw samples (each row = array of bytes, already packed). */
function build(w, h, depth, color, rows, { plte, trns, interlace = 0, filter = 0 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = color; ihdr[12] = interlace;
  const raw = Buffer.concat(rows.map((r) => Buffer.from([filter, ...r])));
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr)];
  if (plte) parts.push(chunk("PLTE", Buffer.from(plte)));
  if (trns) parts.push(chunk("tRNS", Buffer.from(trns)));
  const z = zlib.deflateSync(raw);
  // split IDAT in two to check concatenation
  parts.push(chunk("IDAT", z.subarray(0, z.length >> 1)), chunk("IDAT", z.subarray(z.length >> 1)), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}
const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
{
  const g8 = decodePNG(build(2, 1, 8, 0, [[0, 200]]));
  ok("gray 8-bit", same(px(g8, 1, 0), [200, 200, 200, 255]));
  const g1 = decodePNG(build(9, 1, 1, 0, [[0b10100000, 0b10000000]]));
  ok("gray 1-bit", px(g1, 0, 0)[0] === 255 && px(g1, 1, 0)[0] === 0 && px(g1, 2, 0)[0] === 255 && px(g1, 8, 0)[0] === 255);
  const g4 = decodePNG(build(2, 1, 4, 0, [[0x5f]]));
  ok("gray 4-bit", px(g4, 0, 0)[0] === 85 && px(g4, 1, 0)[0] === 255);
  const g16 = decodePNG(build(1, 1, 16, 0, [[0x12, 0x34]]));
  ok("gray 16-bit -> high byte", px(g16, 0, 0)[0] === 0x12);
  const gt = decodePNG(build(2, 1, 8, 0, [[7, 8]], { trns: [0, 7] }));
  ok("gray tRNS key", px(gt, 0, 0)[3] === 0 && px(gt, 1, 0)[3] === 255);
  const ga = decodePNG(build(1, 1, 8, 4, [[90, 128]]));
  ok("gray+alpha 8-bit", same(px(ga, 0, 0), [90, 90, 90, 128]));
  const rgb = decodePNG(build(1, 1, 8, 2, [[10, 20, 30]]));
  ok("rgb 8-bit", same(px(rgb, 0, 0), [10, 20, 30, 255]));
  const rgb16 = decodePNG(build(1, 1, 16, 2, [[1, 2, 3, 4, 5, 6]]));
  ok("rgb 16-bit", same(px(rgb16, 0, 0), [1, 3, 5, 255]));
  const rgba16 = decodePNG(build(1, 1, 16, 6, [[9, 0, 8, 0, 7, 0, 6, 0]]));
  ok("rgba 16-bit", same(px(rgba16, 0, 0), [9, 8, 7, 6]));
  const pal = decodePNG(build(3, 1, 2, 3, [[0b00011000]], { plte: [255, 0, 0, 0, 255, 0, 0, 0, 255], trns: [255, 100] }));
  ok("palette 2-bit + tRNS", same(px(pal, 0, 0), [255, 0, 0, 255]) && same(px(pal, 1, 0), [0, 255, 0, 100]) && same(px(pal, 2, 0), [0, 0, 255, 255]));
  const pal8 = decodePNG(build(2, 1, 8, 3, [[1, 0]], { plte: [1, 2, 3, 4, 5, 6] }));
  ok("palette 8-bit", same(px(pal8, 0, 0), [4, 5, 6, 255]) && same(px(pal8, 1, 0), [1, 2, 3, 255]));
  // filters 1..4 on a two-row image: sub, up, average, paeth all reconstruct
  for (const f of [1, 2, 3, 4]) {
    const img = decodePNG(build(2, 2, 8, 0, [[10, 5], [3, 4]], { filter: f }));
    const want = {
      1: [10, 15, 3, 7],
      2: [10, 5, 13, 9],
      3: [10, 10, 8, 13],
      4: [10, 15, 13, 19],
    }[f];
    ok(`filter ${f}`, same([px(img, 0, 0)[0], px(img, 1, 0)[0], px(img, 0, 1)[0], px(img, 1, 1)[0]], want), [px(img, 0, 0)[0], px(img, 1, 0)[0], px(img, 0, 1)[0], px(img, 1, 1)[0]]);
  }
}
{
  // Adam7: a 3x3 gray image; passes 1, 2(empty), 3(empty), 4, 5, 6, 7 hold the pixels in a known order
  // values = 10*y + x, so every pixel is checked
  const v = (x, y) => 10 * y + x;
  const rows = [
    [v(0, 0)],              // pass 1: (0,0)
    // pass 2 (x0=4) and pass 3 (y0=4) are empty for 3x3
    [v(2, 0)],              // pass 4: x=2,y=0 (step 4,4)
    [v(0, 2), v(2, 2)],     // pass 5: y=2, x=0,2
    [v(1, 0)], [v(1, 2)],   // pass 6: x=1, y=0 and y=2
    [v(0, 1), v(1, 1), v(2, 1)],   // pass 7: y=1, all x
  ];
  const img = decodePNG(build(3, 3, 8, 0, rows, { interlace: 1 }));
  let good = true;
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) if (px(img, x, y)[0] !== v(x, y)) good = false;
  ok("Adam7 interlaced", good, Array.from({ length: 9 }, (_, i) => px(img, i % 3, (i / 3) | 0)[0]));
}
{
  const bad = (buf) => { try { decodePNG(buf); return null; } catch (e) { return e.message; } };
  ok("rejects non-PNG", /signature/.test(bad(Buffer.from("hello world, not a png")) || ""));
  const good = encodePNG(4, 4, new Uint8Array(64).fill(255));
  ok("rejects truncated data", /truncated|shorter|corrupt/.test(bad(good.subarray(0, good.length - 20)) || ""), bad(good.subarray(0, good.length - 20)));
  let threw = false;
  try { encodePNG(4, 4, new Uint8Array(10)); } catch { threw = true; }
  ok("encode checks buffer size", threw);
}

done("png");
