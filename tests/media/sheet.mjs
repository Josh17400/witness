// Filmstrip tests: `node tests/media/sheet.mjs` — crops, crisp zoom, contact sheets and key-frame picking,
// all on synthesized frames whose right answer is known.
import { cropImage, zoomImage, frameDiffScore, pickKeyFrames, contactSheet } from "../../src/media/sheet.js";
import { decodePNG } from "../../src/media/png.js";
import { ok, show, save, done } from "./harness.mjs";

console.log("sheet");

const image = (w, h, f) => { const d = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = f(x, y), o = (y * w + x) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; } return { width: w, height: h, data: d }; };
const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// a gradient frame: every pixel is unique, so a misplaced pixel can't pass
const grad = (k = 0) => image(64, 40, (x, y) => [(x * 4 + k) & 255, y * 6, (x + y * 3) & 255]);
{
  const g = grad();
  const c = cropImage(g, { x: 10, y: 5, w: 20, h: 12 });
  let exact = c.width === 20 && c.height === 12;
  for (let y = 0; y < 12 && exact; y++) for (let x = 0; x < 20 && exact; x++) exact = same(px(c, x, y), px(g, 10 + x, 5 + y));
  ok("crop: equals a manual slice", exact);
  const edge = cropImage(g, { x: -4, y: -2, w: 8, h: 4 }, { pad: [1, 2, 3, 255] });
  ok("crop: outside the source is padded", same(px(edge, 0, 0), [1, 2, 3, 255]) && same(px(edge, 4, 2), px(g, 0, 0)));
  const z = zoomImage(c, 3);
  let crisp = z.width === 60 && z.height === 36;
  for (let y = 0; y < 36 && crisp; y++) for (let x = 0; x < 60 && crisp; x++) crisp = same(px(z, x, y), px(c, (x / 3) | 0, (y / 3) | 0));
  ok("zoom ×3: every source pixel is a 3×3 block", crisp);
}
{
  // a sheet of 11 frames: layout, size, and each cell holds its frame's exact pixels
  const frames = Array.from({ length: 11 }, (_, i) => grad(i * 10));
  const sh = contactSheet(frames.map((img, i) => ({ img, label: `f${i}` })), { title: "t", subtitle: "s" });
  save("sheet-11.png", sh.png);
  const L = sh.layout, img = decodePNG(sh.png);
  show("11 frames", `${L.cols}×${L.rows} grid, ${img.width}×${img.height}, cell ${L.cellW}×${L.cellH}`);
  ok("sheet: 11 frames → 6×2, full-size cells", L.cols === 6 && L.rows === 2 && L.cellW === 64 && L.cellH === 40 && L.scale === 1);
  ok("sheet: picture size from the layout", img.width === 2 * 12 + 6 * 64 + 5 * 8 && img.height === 44 + 12 + 2 * (40 + 20) + 8 + 12, [img.width, img.height]);
  let cells = true;
  for (const i of [0, 5, 6, 10]) {
    const cx = L.x0 + (i % L.cols) * L.pitchX, cy = L.y0 + Math.floor(i / L.cols) * L.pitchY;
    for (const [x, y] of [[0, 0], [63, 39], [17, 23]]) cells = cells && same(px(img, cx + x, cy + y), px(frames[i], x, y));
  }
  ok("sheet: a known offset in cell i is frame i's pixel", cells);
  const big = Array.from({ length: 4 }, () => ({ img: zoomImage(grad(), 10), label: "" }));   // 640×400 cells
  const auto = contactSheet(big), forced = contactSheet(big, { cols: 4 });
  ok("sheet: big cells wrap to fit 1600 px at full size", auto.layout.cols === 2 && auto.layout.scale === 1 && decodePNG(auto.png).width <= 1600, auto.layout);
  ok("sheet: forced 4 columns shrink the cells to stay within 1600 px", forced.layout.scale < 1 && decodePNG(forced.png).width <= 1600, forced.layout);
  let threw = "";
  try { contactSheet([]); } catch (e) { threw = e.message; }
  ok("sheet: no frames is a clear error", /no frames/.test(threw));
}
{
  // key frames: one big change among small ones is picked; spacing keeps picks apart
  const base = image(50, 50, () => [20, 20, 20]);
  const frames = [];
  for (let i = 0; i < 30; i++) frames.push(image(50, 50, (x, y) => (i >= 12 && x < 30 && y < 30 ? [250, 200, 0] : (x === i % 50 && y === 0 ? [255, 255, 255] : [20, 20, 20]))));
  const scores = frames.map((f, i) => (i ? frameDiffScore(frames[i - 1], f) : 0));
  ok("frameDiffScore: counts changed pixels", frameDiffScore(base, frames[12]) === 900 && frameDiffScore(base, frames[40 % 30]) === 1 && frameDiffScore(base, base) === 0, frameDiffScore(base, frames[12]));
  ok("pickKeyFrames: --auto 1 picks the big change", pickKeyFrames(scores, 1).join() === "12", pickKeyFrames(scores, 1));
  ok("pickKeyFrames: spacing suppresses neighbours, result sorted", pickKeyFrames([0, 5, 9, 8, 0, 0, 7, 0], 2, 3).join() === "2,6");
  ok("pickKeyFrames: never picks a zero", pickKeyFrames([0, 0, 3, 0], 3).join() === "2");
}

done("sheet");
