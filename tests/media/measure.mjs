// Pixel measurement tests: `node tests/media/measure.mjs`
// Every image is synthesized so the right answer is known by construction.
import {
  blockScale, detectScale, maskDiff, maskFromColor, maskFromRect, maskBBox, maskInfo, maskStats,
  ringMask, contrast, motion, motionStream, medianPlate,
} from "../../src/media/measure.js";
import { encodePNG } from "../../src/media/png.js";
import { Raster } from "../../src/media/raster.js";
import { ok, show, done } from "./harness.mjs";

console.log("measure");

// ---- tiny pixel helpers (no anti-aliasing anywhere: every edge is exact) ----------------------
function image(w, h, rgb = [0, 0, 0]) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255; }
  return { width: w, height: h, data };
}
const get = (im, x, y) => Array.from(im.data.subarray((y * im.width + x) * 4, (y * im.width + x) * 4 + 4));
function put(im, x, y, c) { const o = (y * im.width + x) * 4; im.data[o] = c[0]; im.data[o + 1] = c[1]; im.data[o + 2] = c[2]; im.data[o + 3] = c[3] ?? 255; }
function rect(im, x, y, w, h, c) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (i >= 0 && j >= 0 && i < im.width && j < im.height) put(im, i, j, c); }
const clone = (im) => ({ width: im.width, height: im.height, data: Uint8Array.from(im.data) });
function blit(dst, src, dx, dy) { for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) put(dst, dx + x, dy + y, get(src, x, y)); }
function hash(x, y, s = 0) {
  let n = Math.imul(x + 1, 374761393) ^ Math.imul(y + 7, 668265263) ^ Math.imul(s + 3, 2246822519);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return (n ^ (n >>> 16)) >>> 0;
}
const PALETTE = [[20, 24, 46], [230, 57, 70], [241, 250, 238], [168, 218, 220], [69, 123, 157], [255, 183, 3]];
/** Busy pixel art: every pixel a palette colour picked by a hash. */
function sprite(w, h, seed = 0) { const im = image(w, h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(im, x, y, PALETTE[hash(x, y, seed) % PALETTE.length]); return im; }
/** Nearest-neighbour scale by any factor f (destination pixel x samples source floor(x / f)). */
function scaleNearest(src, f) {
  const w = Math.round(src.width * f), h = Math.round(src.height * f), out = image(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(out, x, y, get(src, Math.min(src.width - 1, Math.floor(x / f)), Math.min(src.height - 1, Math.floor(y / f))));
  return out;
}
/** "Bilinear-ish" blur: each pixel becomes the average of its 3×3 neighbourhood. */
function boxBlur(src) {
  const out = clone(src), { width: w, height: h } = src;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = [0, 0, 0]; let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const p = get(src, nx, ny); s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; n++;
    }
    put(out, x, y, s.map((v) => Math.round(v / n)));
  }
  return out;
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const sameBox = (b, x, y, w, h) => !!b && b.x === x && b.y === y && b.w === w && b.h === h;

// ---- blockScale / detectScale -------------------------------------------------------------------
const art = sprite(40, 30);
const x3 = scaleNearest(art, 3);                                   // 120×90, crisp ×3
{
  const r = blockScale(x3, 3);
  show("×3 sprite", `k ${r.k} offset ${r.offset} · ${r.cells} cells · ${r.nonUniformPercent}% non-uniform · blurry ${r.blurry}`);
  ok("×3: k = 3", r.k === 3);
  ok("×3: offset [0,0]", r.offset[0] === 0 && r.offset[1] === 0, r.offset);
  ok("×3: 40×30 = 1200 cells", r.cells === 1200, r.cells);
  ok("×3: 0% non-uniform", r.nonUniform === 0 && r.nonUniformPercent === 0, r);
  ok("×3: not blurry, nothing worst", r.blurry === false && r.worst.length === 0);
  ok("×3: detectScale = 3", detectScale(x3) === 3, detectScale(x3));
  ok("×3: k = 2 is not clean", blockScale(x3, 2).blurry === true);
  ok("×3: k = 6 is not clean", blockScale(x3, 6).blurry === true);
  ok("×3: k = 1 is trivially clean", blockScale(x3, 1).nonUniform === 0 && !blockScale(x3, 1).blurry);
  ok("×3: PNG Buffer input works the same", blockScale(encodePNG(x3.width, x3.height, x3.data), 3).nonUniform === 0);
  const ras = Raster.from(encodePNG(x3.width, x3.height, x3.data));
  ok("×3: Raster input works the same", detectScale(ras) === 3);
}
{
  // the same art drawn 1 px right and 2 px down: the grid offset is found
  const shifted = image(123, 93, [9, 9, 9]);
  blit(shifted, x3, 1, 2);
  const r = blockScale(shifted, 3);
  show("×3 shifted (1, 2)", `offset ${r.offset} · ${r.cells} cells · ${r.nonUniformPercent}% non-uniform`);
  ok("shifted: offset [1,2] detected", r.offset[0] === 1 && r.offset[1] === 2, r.offset);
  ok("shifted: 0 non-uniform cells", r.nonUniform === 0 && r.cells === 1200, r);
  ok("shifted: detectScale = 3", detectScale(shifted) === 3, detectScale(shifted));
  ok("shifted: forced wrong offset is blurry", blockScale(shifted, 3, { offset: [0, 0] }).blurry === true);
}
{
  const blurred = boxBlur(x3);
  const r = blockScale(blurred, 3);
  show("×3 then 3×3 box blur", `${r.nonUniformPercent}% non-uniform · blurry ${r.blurry} · worst ${JSON.stringify(r.worst[0])}`);
  ok("blurred: blurry", r.blurry === true);
  ok("blurred: most cells mixed", r.nonUniformPercent > 50, r.nonUniformPercent);
  ok("blurred: 10 worst cells reported", r.worst.length === 10, r.worst.length);
  ok("blurred: worst cells sorted by spread", r.worst.every((c, i) => i === 0 || r.worst[i - 1].spread >= c.spread));
  ok("blurred: worst cell is k×k with several colours", r.worst[0].w === 3 && r.worst[0].h === 3 && r.worst[0].colors > 1 && r.worst[0].spread > 0, r.worst[0]);
  ok("blurred: detectScale = 1", detectScale(blurred) === 1, detectScale(blurred));
}
{
  // fractional nearest scaling (×2.5): columns alternate 2 and 3 px wide, so neither k = 2 nor 3 is clean
  const f = scaleNearest(art, 2.5);
  const b2 = blockScale(f, 2), b3 = blockScale(f, 3);
  show("×2.5 nearest", `k2 ${b2.nonUniformPercent}% · k3 ${b3.nonUniformPercent}% non-uniform · detect ${detectScale(f)}`);
  ok("×2.5: blurry at k = 2 and k = 3", b2.blurry && b3.blurry);
  ok("×2.5: detectScale = 1", detectScale(f) === 1, detectScale(f));
}
{
  // capture noise of ±2 per channel: fails exactly, passes with tolerance 4
  const noisy = clone(x3);
  for (let i = 0; i < noisy.width * noisy.height; i++) for (let c = 0; c < 3; c++) {
    const o = i * 4 + c; noisy.data[o] = Math.max(0, Math.min(255, noisy.data[o] + (hash(i, c, 9) % 5) - 2));
  }
  ok("noise: exact test fails", blockScale(noisy, 3).blurry === true);
  const r = blockScale(noisy, 3, { tolerance: 4 });
  ok("noise: tolerance 4 passes", r.nonUniform === 0 && !r.blurry, r);
  ok("noise: detectScale with tolerance 4 = 3", detectScale(noisy, { tolerance: 4 }) === 3, detectScale(noisy, { tolerance: 4 }));
}
{
  // left half drawn at native resolution, right half ×3: region picks the scaled part
  const comp = image(240, 90);
  blit(comp, sprite(120, 90, 5), 0, 0);
  blit(comp, x3, 120, 0);
  const whole = blockScale(comp, 3), right = blockScale(comp, 3, { region: { x: 120, y: 0, w: 120, h: 90 } });
  show("native | ×3 composite", `whole ${whole.nonUniformPercent}% · right half ${right.nonUniformPercent}% non-uniform`);
  ok("region: whole image is blurry", whole.blurry === true);
  ok("region: right half is clean", right.nonUniform === 0 && right.cells === 1200 && sameBox(right.region, 120, 0, 120, 90), right);
  ok("region: detectScale on the right half = 3", detectScale(comp, { region: { x: 120, y: 0, w: 120, h: 90 } }) === 3);
  let msg = "";
  try { blockScale(comp, 3, { region: { x: 500, y: 0, w: 10, h: 10 } }); } catch (e) { msg = e.message; }
  ok("region outside the image: clear error", /does not overlap/.test(msg), msg);
}
{
  // a sparse ×4 scene (flat sky and ground, two small sprites): the ×8 grid passes the cell test
  // because almost every cell is flat, yet the true scale is 4
  const native = image(160, 90, [92, 148, 252]);
  rect(native, 0, 70, 160, 20, [60, 160, 60]);
  blit(native, sprite(6, 6, 1), 40, 50);
  blit(native, sprite(5, 4, 2), 100, 30);
  const scene = scaleNearest(native, 4);                           // 640×360
  const at8 = blockScale(scene, 8);
  show("sparse ×4 scene", `k8 alone ${at8.nonUniformPercent}% non-uniform · detectScale ${detectScale(scene)}`);
  ok("sparse: the ×8 grid alone looks clean", at8.nonUniformPercent <= 0.5, at8.nonUniformPercent);
  ok("sparse: detectScale = 4, not a multiple", detectScale(scene) === 4, detectScale(scene));
  ok("flat image: detectScale = 1 (nothing to judge)", detectScale(image(64, 64, [1, 2, 3])) === 1);
}
{
  let msg = "";
  try { blockScale(x3, 2.5); } catch (e) { msg = e.message; }
  ok("fractional k: clear error", /whole number/.test(msg), msg);
  msg = "";
  try { blockScale(Buffer.from("nope"), 3); } catch (e) { msg = e.message; }
  ok("bad input: clear error", /not a readable PNG/.test(msg), msg);
}

// ---- maskDiff: a figure on a textured background vs the background alone ------------------------
function scenery(w, h) {
  const im = image(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (y < h * 0.6) put(im, x, y, [40 + y, 80 + y, 160]);                                    // sky gradient
    else put(im, x, y, ((x >> 2) + (y >> 2)) % 2 ? [46, 110, 52] : [58, 128, 62]);           // checker grass
  }
  return im;
}
const FIGURE = [  // head, body, two legs (exclusive rects): x 68..81, y 30..77
  [70, 30, 10, 10, [250, 200, 170]], [68, 40, 14, 20, [200, 30, 40]], [69, 60, 4, 18, [20, 20, 120]], [77, 60, 4, 18, [20, 20, 120]],
];
const bg = scenery(160, 120);
const withFigure = clone(bg);
for (const [x, y, w, h, c] of FIGURE) rect(withFigure, x, y, w, h, c);
{
  const m = maskDiff(withFigure, bg);
  let n = 0, sx = 0, sy = 0;
  for (const [x, y, w, h] of FIGURE) for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) { n++; sx += i; sy += j; }
  show("figure vs background", `count ${m.count} · bbox ${JSON.stringify(m.bbox)} · centroid ${m.centroid}`);
  ok("figure: exact bbox (height 48)", sameBox(m.bbox, 68, 30, 14, 48), m.bbox);
  ok("figure: exact pixel count 524", m.count === 524 && n === 524, m.count);
  ok("figure: exact centroid", near(m.centroid[0], sx / n, 0.001) && near(m.centroid[1], sy / n, 0.001), m.centroid);
  ok("figure: mask is w*h", m.mask.length === 160 * 120 && m.width === 160 && m.height === 120);
  ok("figure: mask matches its count", m.mask.reduce((a, b) => a + b, 0) === 524);
  const top = maskDiff(withFigure, bg, { region: { x: 0, y: 0, w: 160, h: 40 } });
  ok("figure: region keeps only the head", top.count === 100 && sameBox(top.bbox, 70, 30, 10, 10), top);
  ok("identical images: empty", maskDiff(bg, bg).count === 0 && maskDiff(bg, bg).bbox === null && maskDiff(bg, bg).centroid === null);
  let msg = "";
  try { maskDiff(bg, image(10, 10)); } catch (e) { msg = e.message; }
  ok("size mismatch: clear error", /sizes differ/.test(msg), msg);
}

// ---- mask helpers ---------------------------------------------------------------------------------
{
  const r = maskFromRect(10, 10, { x: -2, y: 3, w: 5, h: 2 });
  ok("maskFromRect: clipped to the image", maskInfo(r, 10, 10).count === 6 && sameBox(maskBBox(r, 10, 10), 0, 3, 3, 2), maskBBox(r, 10, 10));
  ok("maskFromRect: fully outside is empty", maskInfo(maskFromRect(10, 10, { x: 20, y: 0, w: 5, h: 5 }), 10, 10).count === 0);
  ok("maskBBox: empty mask -> null", maskBBox(new Uint8Array(100), 10, 10) === null);
  const head = maskFromColor(withFigure, [250, 200, 170]);
  ok("maskFromColor: the head", maskInfo(head, 160, 120).count === 100 && sameBox(maskBBox(head, 160, 120), 70, 30, 10, 10));
  ok("maskFromColor: hex string", maskInfo(maskFromColor(withFigure, "#fac8aa"), 160, 120).count === 100);
  ok("maskFromColor: tolerance widens the match", maskInfo(maskFromColor(withFigure, [245, 205, 165], 5), 160, 120).count === 100 && maskInfo(maskFromColor(withFigure, [245, 205, 165], 4), 160, 120).count === 0);
  const legs = maskFromColor(withFigure, [20, 20, 120]);
  ok("maskInfo: two legs, centroid between them", near(maskInfo(legs, 160, 120).centroid[0], (70.5 + 78.5) / 2, 0.001) && near(maskInfo(legs, 160, 120).centroid[1], 68.5, 0.001), maskInfo(legs, 160, 120));
  const st = maskStats(withFigure, head);
  const L = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  ok("maskStats: mean colour of the head", st.count === 100 && st.mean.join() === "250,200,170,255", st.mean);
  ok("maskStats: luminance", near(st.luminance, 0.2126 * L(250) + 0.7152 * L(200) + 0.0722 * L(170), 1e-4), st.luminance);
  ok("maskStats: empty mask -> nulls", maskStats(withFigure, new Uint8Array(160 * 120)).mean === null);

  const sq = maskFromRect(30, 30, { x: 10, y: 10, w: 10, h: 10 });
  const ring1 = ringMask(sq, 30, 30, 1), ring2 = ringMask(sq, 30, 30, 2);
  ok("ringMask r1: 4 sides × 10 = 40 px", maskInfo(ring1, 30, 30).count === 40 && sameBox(maskBBox(ring1, 30, 30), 9, 9, 12, 12), maskInfo(ring1, 30, 30));
  ok("ringMask r2: 80 side px + 4 corners = 84 px", maskInfo(ring2, 30, 30).count === 84, maskInfo(ring2, 30, 30).count);
  ok("ringMask: never overlaps the mask", ring2.every((v, i) => !(v && sq[i])));
  const corner = ringMask(maskFromRect(30, 30, { x: 0, y: 0, w: 5, h: 5 }), 30, 30, 1);
  ok("ringMask: clipped at the image edge", maskInfo(corner, 30, 30).count === 10);
  let msg = "";
  try { ringMask(new Uint8Array(5), 30, 30, 1); } catch (e) { msg = e.message; }
  ok("ringMask: wrong mask size, clear error", /900 entries/.test(msg), msg);
}

// ---- contrast: black outline on green ground ------------------------------------------------------
function outlinedSprite(ground) {
  const im = image(64, 48, ground);
  rect(im, 25, 15, 14, 18, [0, 0, 0]);          // 1 px black outline ...
  rect(im, 26, 16, 12, 16, [200, 40, 40]);      // ... around a red body
  return im;
}
const wcag = (c1, c2) => {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const a = lum(c1), b = lum(c2);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
for (const ground of [[0, 255, 0], [76, 153, 60]]) {
  const im = outlinedSprite(ground);
  const outline = maskFromColor(im, [0, 0, 0]);
  const silhouette = maskDiff(im, image(64, 48, ground)).mask;
  const around = ringMask(silhouette, 64, 48, 3);
  const c = contrast(im, outline, around);
  const expected = wcag([0, 0, 0], ground);
  show(`outline vs ground rgb(${ground})`, `ratio ${c.ratio} (expect ${expected.toFixed(3)}) · ΔE ${c.deltaE} · ${c.countA} vs ${c.countB} px`);
  ok(`contrast ${ground}: outline is 60 px`, c.countA === 14 * 18 - 12 * 16, c.countA);
  ok(`contrast ${ground}: ground ring is all ground`, c.meanB.slice(0, 3).join() === ground.join(), c.meanB);
  ok(`contrast ${ground}: WCAG ratio within 0.01`, near(c.ratio, expected, 0.01), `${c.ratio} vs ${expected}`);
  ok(`contrast ${ground}: outline luminance 0`, c.lumA === 0, c.lumA);
  if (ground[1] === 255 && ground[0] === 0) {
    ok("contrast: pure green vs black = 15.304", near(c.ratio, 15.304, 0.01), c.ratio);
    ok("contrast: ΔE76 black vs sRGB green ≈ 148.47", near(c.deltaE, 148.47, 0.1), c.deltaE);
  }
}
{
  const im = image(20, 10, [255, 255, 255]);
  rect(im, 0, 0, 10, 10, [0, 0, 0]);
  const c = contrast(im, maskFromRect(20, 10, { x: 0, y: 0, w: 10, h: 10 }), maskFromRect(20, 10, { x: 10, y: 0, w: 10, h: 10 }));
  ok("contrast: black vs white = 21", c.ratio === 21 && near(c.deltaE, 100, 0.01), c);
  ok("contrast: symmetric", contrast(im, maskFromRect(20, 10, { x: 10, y: 0, w: 10, h: 10 }), maskFromRect(20, 10, { x: 0, y: 0, w: 10, h: 10 })).ratio === 21);
  let msg = "";
  try { contrast(im, new Uint8Array(200), maskFromRect(20, 10, { x: 0, y: 0, w: 1, h: 1 })); } catch (e) { msg = e.message; }
  ok("contrast: empty mask, clear error", /maskA selects no pixels/.test(msg), msg);
}

// ---- motion ---------------------------------------------------------------------------------------
const stage = scenery(120, 60);
function framesOf(positions, { size = 8, y = 30, hud = false } = {}) {
  return positions.map((x, i) => {
    const f = clone(stage);
    rect(f, x, y, size, size, [255, 80, 160]);
    if (hud) rect(f, 100, 0, 20, 6, [i * 20, 255 - i * 20, 0]);   // a HUD counter that changes every frame
    return f;
  });
}
{
  const xs = Array.from({ length: 10 }, (_, i) => 10 + 2 * i);
  const m = motion(framesOf(xs), { background: stage });
  const s = m.summary;
  show("square 2 px/frame × 10", `path ${s.pathLength} · net ${s.net} · max ${s.maxStep} · jitter ${s.jitter}`);
  ok("motion: path length 18", s.pathLength === 18, s.pathLength);
  ok("motion: net [18, 0]", s.net[0] === 18 && s.net[1] === 0, s.net);
  ok("motion: jitter 0", s.jitter === 0, s.jitter);
  ok("motion: max/mean step 2, 9 steps", s.maxStep === 2 && s.meanStep === 2 && s.steps === 9 && s.netDistance === 18, s);
  ok("motion: every step [2, 0]", m.steps.length === 9 && m.steps.every((d) => d[0] === 2 && d[1] === 0), m.steps);
  ok("motion: exact boxes", m.frames.every((f, i) => sameBox(f.bbox, 10 + 2 * i, 30, 8, 8) && f.count === 64), m.frames.map((f) => f.bbox));
  ok("motion: lowest row span", m.frames.every((f, i) => f.lowestRowSpan.y === 37 && f.lowestRowSpan.x0 === 10 + 2 * i && f.lowestRowSpan.x1 === 17 + 2 * i), m.frames[0].lowestRowSpan);
  ok("motion: reports its setup", m.background === "image" && m.threshold === 16 && m.frames.length === 10 && m.width === 120);

  // frames[0] as the plate (default)
  const f = motion([stage, ...framesOf(xs)]);
  ok("motion first-frame plate: frame 0 empty", f.frames[0].count === 0 && f.frames[0].centroid === null && f.steps[0] === null, f.frames[0]);
  ok("motion first-frame plate: same path", f.summary.pathLength === 18 && f.summary.net.join() === "18,0" && f.summary.jitter === 0 && f.summary.framesWithObject === 10, f.summary);
}
{
  // no plate at all: a small fast square never covers a pixel twice, so the median frame is the background
  const xs = Array.from({ length: 10 }, (_, i) => 4 + 8 * i);
  const m = motion(framesOf(xs, { size: 4 }), { background: "median" });
  ok("motion median plate: path 72, net [72, 0], jitter 0", m.summary.pathLength === 72 && m.summary.net.join() === "72,0" && m.summary.jitter === 0, m.summary);
  ok("motion median plate: exact boxes", m.frames.every((f, i) => sameBox(f.bbox, 4 + 8 * i, 30, 4, 4)), m.frames.map((f) => f.bbox));
}
{
  // uneven steps 2, 4, 2, 4 -> mean 3, step spread (stddev) 1; jitter = off the smooth path: 6 vs 186/35
  const m = motion(framesOf([10, 12, 16, 18, 22]), { background: stage });
  ok("motion: steps 2,4,2,4 spread 1", m.summary.stepSpread === 1 && m.summary.meanStep === 3 && m.summary.maxStep === 4, m.summary);
  ok("motion: steps 2,4,2,4 jitter 0.686 (6 - 186/35)", m.summary.jitter === 0.686, m.summary.jitter);
}
{
  // B4: smooth acceleration is not jitter (steps 0,1,2,3,4,5,6), a single hitch in steady motion is
  const acc = [10, 10, 11, 13, 16, 20, 25, 31];
  const a = motion(framesOf(acc), { background: stage });
  show("accelerating square (steps 0..6)", `jitter ${a.summary.jitter} · step spread ${a.summary.stepSpread}`);
  ok("motion B4: accelerating square has jitter 0", a.summary.jitter === 0, a.summary);
  ok("motion B4: its step spread is large (2)", a.summary.stepSpread === 2, a.summary.stepSpread);
  const hitch = motion(framesOf([10, 12, 14, 16, 16, 18, 20, 22, 24]), { background: stage });   // frame 4 repeats frame 3
  ok("motion B4: a repeated frame in steady motion shows as jitter", hitch.summary.jitter > 0.3, hitch.summary);
  ok("motion: under 5 frames there is no jitter figure", motion(framesOf([10, 12, 14]), { background: stage }).summary.jitter === null);
}
{
  // B3: the object is on screen in frame 0 (no clean plate). "first" halves every step (old ∪ new silhouette);
  // "auto" picks the median for 8+ frames and gets the true 2 px/frame
  const xs = Array.from({ length: 20 }, (_, i) => 6 + 2 * i);
  const frames = framesOf(xs, { size: 6 });
  const first = motion(frames, { background: "first" });
  const auto = motion(frames);
  show("object visible in frame 0", `first: mean step ${first.summary.meanStep} · auto: ${auto.backgroundChoice}, mean step ${auto.summary.meanStep}`);
  ok("motion B3: 'first' with the object in frame 0 halves the step (the old bug)", first.summary.meanStep === 1 && first.warnings.length === 1, first.summary);
  ok("motion B3: auto → median, true step 2", auto.background === "median" && auto.summary.meanStep === 2 && auto.steps.slice(1).every((d) => d[0] === 2 && d[1] === 0) && /median/.test(auto.backgroundChoice), auto.summary);
  ok("motion B3: auto boxes are the real 6×6 sprite", auto.frames.every((f, i) => sameBox(f.bbox, 6 + 2 * i, 30, 6, 6)), auto.frames.slice(0, 3).map((f) => f.bbox));
  const short = motion(frames.slice(0, 5));
  ok("motion B3: auto on a short clip falls back to first, with a warning", short.background === "first" && /first \(only 5 frames/.test(short.backgroundChoice) && short.warnings.length === 1, short.backgroundChoice);
  const crawl = motion(framesOf(Array.from({ length: 10 }, (_, i) => 20 + (i % 2)), { size: 8 }), { background: "median" });
  ok("motion: median warns when the object moves less than its size", crawl.warnings.some((w) => /less than its own size/.test(w)), crawl.warnings);
  // streaming gives the same result as the array version (only the plate is kept)
  const st = motionStream({ plate: medianPlate(frames) });
  frames.forEach((f) => st.push(f));
  const sr = st.finish("median");
  ok("motionStream = motion", JSON.stringify(sr.frames) === JSON.stringify(auto.frames) && JSON.stringify(sr.summary) === JSON.stringify(auto.summary));
}
{
  // a HUD counter ticking in the corner: region keeps it out
  const xs = Array.from({ length: 10 }, (_, i) => 10 + 2 * i);
  const frames = framesOf(xs, { hud: true });
  const polluted = motion(frames, { background: stage });
  const clean = motion(frames, { background: stage, region: { x: 0, y: 10, w: 120, h: 50 } });
  ok("motion: HUD pollutes the whole-frame boxes", polluted.frames[3].bbox.w > 8);
  ok("motion: region keeps the HUD out", clean.summary.pathLength === 18 && clean.frames.every((f, i) => sameBox(f.bbox, 10 + 2 * i, 30, 8, 8)), clean.frames.map((f) => f.bbox));
  ok("motion: minPixels drops specks", motion(framesOf([10, 12], { size: 2 }), { background: stage, minPixels: 5 }).summary.framesWithObject === 0);
}
{
  // foot slide: the body moves 2 px/frame; a planted foot keeps its x, a sliding one moves with the body
  const walker = (bodyX, footX) => { const f = clone(stage); rect(f, bodyX, 20, 6, 10, [255, 80, 160]); rect(f, footX, 30, 3, 2, [255, 255, 255]); return f; };
  const bodyXs = [20, 22, 24, 26, 28];
  const planted = motion(bodyXs.map((x) => walker(x, 22)), { background: stage });
  const sliding = motion(bodyXs.map((x) => walker(x, x + 2)), { background: stage });
  const footDx = (m) => m.frames.slice(1).map((f, i) => f.lowestRowSpan.x0 - m.frames[i].lowestRowSpan.x0);
  show("foot slide", `planted foot dx ${footDx(planted)} vs body dx ${planted.steps.map((d) => d[0])} · sliding foot dx ${footDx(sliding)}`);
  ok("foot: planted foot does not move while the body does", footDx(planted).every((d) => d === 0) && planted.steps.every((d) => d[0] > 0), footDx(planted));
  ok("foot: sliding foot moves with the body", footDx(sliding).every((d) => d === 2), footDx(sliding));
  ok("foot: lowest row is the foot row", planted.frames.every((f) => f.lowestRowSpan.y === 31 && f.lowestRowSpan.x1 - f.lowestRowSpan.x0 === 2));
}
{
  let msg = "";
  try { motion([stage, image(10, 10)]); } catch (e) { msg = e.message; }
  ok("motion: frame size mismatch, clear error", /frame #1 is 10×10/.test(msg), msg);
  msg = "";
  try { motion([]); } catch (e) { msg = e.message; }
  ok("motion: empty frames, clear error", /non-empty array/.test(msg), msg);
}

done("measure");
