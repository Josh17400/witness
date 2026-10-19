// APNG clip tests: `node tests/media/apng.mjs`
// Frames with known content and known delays: the chunk structure, sequence numbers, merged identical frames,
// changed-rectangle storage, and every composited frame equal to its source.
import { encodeAPNG, decodeAPNG, changedBox } from "../../src/media/apng.js";
import { decodePNG, encodePNG } from "../../src/media/png.js";
import { scaleImage } from "../../src/media/sheet.js";
import { ok, show, done } from "./harness.mjs";

console.log("apng");
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const W = 40, H = 30;
// a 6×6 square moving 3 px right per frame on a plain background; frames 3 and 4 are identical (a hold)
const frame = (x, alpha = 255) => {
  const d = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { d[i * 4] = 20; d[i * 4 + 1] = 24; d[i * 4 + 2] = 40; d[i * 4 + 3] = alpha; }
  for (let y = 10; y < 16; y++) for (let k = 0; k < 6; k++) { const o = (y * W + x + k) * 4; d[o] = 250; d[o + 1] = 200; d[o + 2] = 0; d[o + 3] = 255; }
  return { width: W, height: H, data: d };
};
const xs = [2, 5, 8, 11, 11, 14];
const frames = xs.map((x) => frame(x));
const r = encodeAPNG(frames, { fps: 60, delays: [2, 2, 2, 2, 2, 2] });
show("6 frames (one repeated) → bytes", `${r.bytes} B, ${r.stored} stored`);
ok("identical neighbour merged into the delay", r.stored === 5 && JSON.stringify(r.delays) === "[[2,60],[2,60],[2,60],[4,60],[2,60]]", r.delays);
ok("later frames store only the changed rectangle", r.rects[1].x === 2 && r.rects[1].w === 9 && r.rects[1].y === 10 && r.rects[1].h === 6, r.rects[1]);
ok("changedBox: none for identical frames", changedBox(frames[3], frames[4]) === null);

const d = decodeAPNG(r.png);
ok("chunk order: IHDR acTL fcTL IDAT (fcTL fdAT)… IEND", d.chunks.join(" ") === "IHDR acTL fcTL IDAT fcTL fdAT fcTL fdAT fcTL fdAT fcTL fdAT IEND", d.chunks.join(" "));
ok("acTL: frame count and loop forever", d.numFrames === 5 && d.plays === 0);
ok("delays decode to ms", d.frames.map((f) => Math.round(f.delayMs * 100) / 100).join(",") === "33.33,33.33,33.33,66.67,33.33", d.frames.map((f) => f.delayMs));
ok("the first frame is the default image (what PNG viewers and image tools show)", d.defaultIsFirst);
ok("every composited frame equals its source", d.frames.every((f, k) => same(f.image, frames[r.sourceIndex[k]].data)));
const plain = decodePNG(r.png);
ok("a plain PNG decoder reads frame 1", same(plain.data, frames[0].data) && plain.width === W);
ok("total time preserved: 12 frames at 60 fps", d.frames.reduce((a, f) => a + f.delay[0], 0) === 12);

// transparency: an RGBA clip round trips too
const tf = [frame(2, 0), frame(6, 0), frame(10, 128)];
const t = decodeAPNG(encodeAPNG(tf, { fps: 30 }).png);
ok("RGBA frames round trip (blend SOURCE keeps alpha exact)", t.frames.every((f, k) => same(f.image, tf[k].data)) && t.frames[0].delay[1] === 30);
// a corrupted CRC is caught
const bad = Buffer.from(r.png); bad[bad.length - 20] ^= 0xff;
ok("bad CRC is reported", (() => { try { decodeAPNG(bad); return false; } catch (e) { return /CRC/.test(e.message); } })());
// a plain PNG decodes as one frame
ok("plain PNG = one frame", decodeAPNG(encodePNG(W, H, frames[0].data)).numFrames === 1);
ok("size mismatch is an error", (() => { try { encodeAPNG([frames[0], { width: 2, height: 2, data: new Uint8Array(16) }]); return false; } catch (e) { return /frame 1 is 2×2/.test(e.message); } })());
// scaleImage (shot --clip --scale): a 2×2 checker of 0/200 averages to 100 at 0.5; ×2 is nearest-neighbour
{
  const c = { width: 4, height: 2, data: new Uint8Array(32) };
  for (let i = 0; i < 8; i++) { const v = (i % 2) ? 200 : 0; c.data.fill(v, i * 4, i * 4 + 3); c.data[i * 4 + 3] = 255; }
  const h = scaleImage(c, 0.5);
  ok("scaleImage 0.5 averages each 2×2 block", h.width === 2 && h.height === 1 && h.data[0] === 100 && h.data[4] === 100 && h.data[3] === 255, Array.from(h.data));
  const z = scaleImage(c, 2);
  ok("scaleImage 2 is nearest-neighbour", z.width === 8 && z.data[0] === 0 && z.data[4] === 0 && z.data[8] === 200);
}
// a still stretch longer than the 16-bit delay: carried on in repeats, never cut to 65535 units
{
  const f = { width: 3, height: 2, data: new Uint8Array(24).fill(200) };
  const enc = encodeAPNG([f, f, f], { fps: 1000, delays: [65535, 65535, 20000] });
  const d = decodeAPNG(enc.png);
  const total = d.frames.reduce((a, x) => a + x.delay[0], 0);
  ok("encodeAPNG: a merged delay of 151070 units stays 151070 (65535 + 65535 + 20000 over 3 stored frames)", total === 151070 && enc.stored === 3 && d.frames.every((x) => Buffer.from(x.image).equals(Buffer.from(f.data))) && enc.rects[1].w === 1, { total, stored: enc.stored });
}
done("apng");
