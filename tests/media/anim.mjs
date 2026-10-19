// Sprite pose tests: `node tests/media/anim.mjs` — pose matching on synthetic sprites with known poses, sub-pixel
// jitter and masks, and the camera check that a lone sprite on a plain background is not a scroll.
import { poseDistance, poseLabels, maskedCrop } from "../../src/media/anim.js";
import { cameraPath } from "../../src/media/track.js";
import { ok, show, done } from "./harness.mjs";

console.log("anim");
// a 12×12 sprite: a filled disc with a dark 4×4 mark in one quadrant (pose 0..3), drawn at (ox, oy) in a 20×20 crop
const sprite = (pose, ox = 4, oy = 4) => {
  const W = 20, d = new Uint8Array(W * W * 4);
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
    if ((x - 5.5) ** 2 + (y - 5.5) ** 2 > 36) continue;
    const o = ((oy + y) * W + ox + x) * 4;
    const mx = [1, 6, 6, 1][pose], my = [1, 1, 6, 6][pose];
    const dark = x >= mx && x < mx + 4 && y >= my && y < my + 4;
    d[o] = dark ? 10 : 80; d[o + 1] = dark ? 10 : 200; d[o + 2] = dark ? 10 : 255; d[o + 3] = 255;
  }
  return { width: W, height: W, data: d };
};
ok("poseDistance: identical = 0", poseDistance(sprite(0), sprite(0)) === 0);
ok("poseDistance: the same pose 1 px to the right = 0 (shift allowed)", poseDistance(sprite(1), sprite(1, 5, 4)) === 0);
const dd = poseDistance(sprite(0), sprite(2));
show("pose 0 vs pose 2", dd.toFixed(3));
ok("poseDistance: another pose differs by over 5%", dd > 0.05, dd);
ok("poseDistance: sizes 2+ px apart are different poses", poseDistance(sprite(0), { width: 17, height: 20, data: new Uint8Array(17 * 20 * 4) }) === Infinity);
// a walk: poses 0 0 1 1 2 2 3 3 0 0 with a 1 px bob on odd frames; a missing frame stays unknown
const seq = [0, 0, 1, 1, 2, 2, 3, 3, 0, 0];
const crops = seq.map((p, i) => sprite(p, 4, 4 + (i % 2)));
crops.splice(5, 1, null);
const P = poseLabels(crops);
ok("poseLabels: 4 poses numbered by first appearance, the bob ignored, null kept", P.poses.length === 4 && P.labels.join() === "1,1,2,2,3,,4,4,1,1", P.labels.join());
// maskedCrop: pixels outside the mask become transparent
{
  const img = { width: 4, height: 2, data: new Uint8Array(32).fill(200) };
  const mask = new Uint8Array(8); mask[1] = 1; mask[6] = 1;
  const c = maskedCrop(img, { x: 1, y: 0, w: 2, h: 2 }, mask);
  ok("maskedCrop: only masked pixels are opaque", c.width === 2 && [...c.data.filter((_, i) => i % 4 === 3)].join() === "255,0,0,255", [...c.data.filter((_, i) => i % 4 === 3)].join());
}
// camera: a 10×10 square moving 2 px/frame on a plain background is a sprite, not a scrolling camera
{
  const frames = Array.from({ length: 10 }, (_, f) => {
    const W = 120, H = 80, d = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) { d[i * 4] = 20; d[i * 4 + 1] = 24; d[i * 4 + 2] = 40; d[i * 4 + 3] = 255; }
    for (let y = 30; y < 40; y++) for (let x = 10 + 2 * f; x < 20 + 2 * f; x++) { const o = (y * W + x) * 4; d[o] = 250; d[o + 1] = 200; d[o + 2] = 0; }
    return { width: W, height: H, data: d };
  });
  const cam = cameraPath(frames);
  ok("cameraPath: a lone sprite on a plain background → camera still", cam.moving === false, cam.steps.map((s) => [s.dx, s.dy]));
}
done("anim");
