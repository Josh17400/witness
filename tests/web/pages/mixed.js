// Two scales in one picture, like an SDL/Emscripten game: the canvas has one backing pixel per device pixel (shown
// 1:1), the world is drawn at a whole ×5 and the UI layer (622×287 UI pixels) is stretched over the whole canvas at
// ×4.11, so a bottom bar (UI rows 230+) has uneven pixels. state.layers names the two.
import witness from "/witness/witness.js";

const canvas = document.getElementById("game");
const W = Math.round(innerWidth * devicePixelRatio), H = Math.round(innerHeight * devicePixelRatio);
canvas.width = W; canvas.height = H;
const ctx = canvas.getContext("2d");
const hash = (x, y, s) => { let n = Math.imul(x + 1, 374761393) ^ Math.imul(y + 7, 668265263) ^ Math.imul(s + 3, 2246822519); n = Math.imul(n ^ (n >>> 13), 1274126177); return (n ^ (n >>> 16)) >>> 0; };
function layer(w, h, paint) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"), im = g.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = paint(x, y); if (p) im.data.set([p[0], p[1], p[2], 255], (y * w + x) * 4); }
  g.putImageData(im, 0, 0);
  return c;
}
const PAL = [[20, 24, 46], [230, 57, 70], [241, 250, 238], [168, 218, 220], [69, 123, 157], [255, 183, 3]];
const UIPAL = [[250, 250, 250], [40, 40, 60], [200, 160, 40], [90, 200, 120]];
const WK = 5, UW = 622, UH = 287, BAR = 230;
const world = layer(Math.ceil(W / WK), Math.ceil(H / WK), (x, y) => PAL[hash(x, y, 2) % PAL.length]);
const ui = layer(UW, UH, (x, y) => (y >= BAR ? UIPAL[hash(x, y, 5) % UIPAL.length] : null));
let t = 0;
function render() {
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(world, 0, 0, world.width * WK, world.height * WK);
  ctx.drawImage(ui, 0, 0, W, H);
}
render();
await witness.start({
  name: "Two scales", fps: 60, size: [W, H], canvas,
  reset: () => { t = 0; render(); },
  step: () => { t++; },
  snapshot: () => ({ t, layers: [{ name: "world", rect: [0, 0, W, H] }, { name: "ui", rect: [0, Math.ceil((BAR * H) / UH - 0.5), W, H - Math.ceil((BAR * H) / UH - 0.5)] }] }),
});
