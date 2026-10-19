// Align tests: `node tests/media/align.mjs` — fitting state positions to sprites without knowing which is which,
// on synthesized pictures with a planted transform, a planted art offset, junk blobs and hitboxes.
import { findBlobs, fitProjection, hitboxes, backgroundPalette, annotate } from "../../src/media/align.js";
import { decodePNG } from "../../src/media/png.js";
import { ok, show, save, done } from "./harness.mjs";

console.log("align");

const img = (w, h, c) => { const d = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255; } return { width: w, height: h, data: d }; };
const rect = (im, x, y, w, h, c) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) { if (i < 0 || j < 0 || i >= im.width || j >= im.height) continue; const o = (j * im.width + i) * 4; im.data[o] = c[0]; im.data[o + 1] = c[1]; im.data[o + 2] = c[2]; } return im; };

{
  // a floor, walls and grid lines (the background palette), sprites drawn at screen = 3·state + (12, -30)
  const W = 400, H = 300, pic = img(W, H, [126, 118, 102]);
  for (let x = 0; x < W; x += 16) rect(pic, x, 0, 1, H, [113, 105, 91]);
  rect(pic, 0, 0, W, 40, [44, 46, 62]);   // a wall band
  const ents = [{ id: 1, type: "P", x: 20, y: 30 }, { id: 2, type: "E", x: 60, y: 40 }, { id: 3, type: "E", x: 100, y: 70 }, { id: 4, type: "C", x: 40, y: 90 }, { id: 5, type: "C", x: 90, y: 100, box: [6, 6] }, { id: 6, type: "G", x: 300, y: 300 }];
  const at = (e) => [3 * e.x + 12, 3 * e.y - 30];
  for (const e of ents.slice(0, 5)) { const [sx, sy] = at(e); const dx = e.id === 4 ? -7 : 0; rect(pic, sx - 6 + dx, sy - 6, 13, 13, [255, 80 + e.id * 20, 40]); }   // 13 px: centred on the point
  rect(pic, 350, 250, 8, 8, [0, 255, 0]);   // a junk sprite no entity owns
  const pal = backgroundPalette(pic);
  ok("palette: floor and wall (the 1 px grid lines are within the threshold of the floor)", pal.length === 2, pal);
  const blobs = findBlobs(pic);
  ok("blobs: the 6 sprites, nothing from the floor or walls", blobs.length === 6, blobs.map((b) => b.bbox));
  const fit = fitProjection(ents, blobs);
  show("planted x' = 3x + 12, y' = 3y - 30", `x' = ${fit.ax}x + ${fit.bx}, y' = ${fit.ay}y + ${fit.by} · ${fit.matched}/${fit.total} · residual ${fit.residual}`);
  ok("fit: the planted transform exactly", fit.ok && fit.ax === 3 && fit.bx === 12 && fit.ay === 3 && fit.by === -30 && fit.residual === 0, fit);
  ok("fit: the sprite drawn 7 px left is an offset, the off-screen entity is missing", fit.offsets.length === 1 && fit.offsets[0].entity.id === 4 && fit.offsets[0].dx === -7 && fit.offsets[0].dy === 0 && fit.missing.length === 1 && fit.missing[0].entity.id === 6, [fit.offsets.map((o) => [o.entity.id, o.dx]), fit.missing.map((q) => q.entity.id)]);
  const hb = hitboxes(fit);
  ok("hitbox: a 6×6 box at scale 3 is 18×18 vs 13×13 art: larger than the art", hb.length === 1 && hb[0].box.join() === "18,18" && hb[0].art.join() === "13,13" && hb[0].verdict === "hitbox larger than the art", hb);
  const png = annotate(pic, fit.all.map((q) => ({ x: q.blob.bbox.x, y: q.blob.bbox.y, w: q.blob.bbox.w, h: q.blob.bbox.h, label: `#${q.entity.id}`, group: q.entity.type })), { title: "align", zoom: 1 });
  save("align-annotated.png", png);
  ok("annotate: a picture at the source size plus its title strip", decodePNG(png).width === W && decodePNG(png).height === H + 28);
}
{
  // a hint (the game's state.camera) confirms a fit even when only one sprite is visible
  const pic = img(200, 100, [20, 24, 40]);
  rect(pic, 64, 44, 13, 13, [255, 255, 0]);
  const blobs = findBlobs(pic);
  const ents = [{ id: 1, type: "P", x: 50, y: 50 }, { id: 2, type: "C", x: 500, y: 50 }];
  ok("one sprite alone can't fit", fitProjection(ents, blobs).ok === false);
  const f = fitProjection(ents, blobs, { hint: { scale: 1, ox: 20, oy: 0 } });
  ok("one sprite confirms the camera hint", f.ok && f.fromHint && f.bx === 20 && f.by === 0 && f.matched === 1, f);
}

done("align");
