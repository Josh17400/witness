// Motion v2 tests: `node tests/media/track.mjs` — several objects, crossings, flicker, stutter, camera scroll and
// jitter, objects on a scrolling background. Every frame is synthesized, so the right answers are known.
import { components, trackObjects, trackReport, estimateShift, cameraPath, mosaicPlate, maskAgainstMosaic } from "../../src/media/track.js";
import { ok, show, done } from "./harness.mjs";

console.log("track");

const W = 160, H = 90;
const blank = (w = W, h = H, c = [20, 24, 40]) => { const d = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255; } return { width: w, height: h, data: d }; };
const rect = (img, x, y, w, h, c) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) { if (i < 0 || j < 0 || i >= img.width || j >= img.height) continue; const o = (j * img.width + i) * 4; img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255; } return img; };
const maskOf = (img, bg) => { const m = new Uint8Array(img.width * img.height); for (let i = 0; i < m.length; i++) m[i] = Math.abs(img.data[i * 4] - bg.data[i * 4]) > 16 || Math.abs(img.data[i * 4 + 1] - bg.data[i * 4 + 1]) > 16 || Math.abs(img.data[i * 4 + 2] - bg.data[i * 4 + 2]) > 16 ? 1 : 0; return m; };
const plate = blank();
const comps = (frames) => frames.map((f) => components(maskOf(f, plate), W, H, { minPixels: 4 }));

{
  const f = rect(rect(blank(), 10, 10, 6, 6, [255, 0, 0]), 50, 40, 8, 4, [0, 255, 0]);
  rect(f, 100, 70, 1, 1, [255, 255, 255]);   // a 1 px speck
  const c = components(maskOf(f, plate), W, H, { minPixels: 4 });
  ok("components: two blobs, exact boxes, speck dropped", c.length === 2 && c[0].count === 36 && c[0].bbox.x === 10 && c[0].bbox.w === 6 && c[1].bbox.w === 8 && c[1].bbox.h === 4 && c[0].cx === 12.5, c);
}
{
  // two squares crossing: A → 3 px/f from x=10, B ← 3 px/f from x=130, same row: they merge for a few frames
  const frames = Array.from({ length: 41 }, (_, i) => rect(rect(blank(), 10 + 3 * i, 40, 8, 8, [255, 80, 160]), 130 - 3 * i, 40, 8, 8, [80, 200, 255]));
  const tracks = trackObjects(comps(frames));
  const reps = tracks.map((t) => trackReport(t));
  show("two squares crossing", reps.map((r) => `#${r.id} seen ${r.seen} occluded ${r.occluded} net ${r.net}`).join(" · "));
  ok("tracks: exactly two, ids kept through the crossing", tracks.length === 2 && reps[0].net[0] === 120 && reps[1].net[0] === -120, reps);
  ok("tracks: the merged frames count as occluded, not flicker", reps.every((r) => r.seen + r.occluded === 41 && r.occluded > 0 && r.flicker.length === 0), reps);
}
{
  // flicker: a square missing for exactly one frame (f5) and for two frames (f12, f13)
  const frames = Array.from({ length: 20 }, (_, i) => (i === 5 || i === 12 || i === 13 ? blank() : rect(blank(), 10 + 2 * i, 30, 8, 8, [255, 210, 60])));
  const tracks = trackObjects(comps(frames));
  const r = trackReport(tracks[0]);
  ok("flicker: one track, gone at f5 and f12–f13", tracks.length === 1 && JSON.stringify(r.flicker) === JSON.stringify([{ from: 5, to: 5 }, { from: 12, to: 13 }]), [tracks.length, r.flicker]);
  ok("flicker: steps across the gaps are not counted", r.seen === 17 && r.meanStep === 2, r);
}
{
  // stutter: steady 2 px/f with one repeated frame (f6 = f5) and one double step (f13: +4)
  const xs = [];
  let x = 10;
  for (let i = 0; i < 20; i++) { xs.push(x); x += i === 5 ? 0 : i === 12 ? 4 : 2; }
  const frames = xs.map((p) => rect(blank(), p, 30, 8, 8, [255, 80, 160]));
  const r = trackReport(trackObjects(comps(frames))[0]);
  ok("stutter: the repeated frame and the double step, at their frames", JSON.stringify(r.stutters.map((q) => [q.i, q.kind])) === JSON.stringify([[6, "repeated frame"], [13, "double step"]]), r.stutters);
  const smooth = trackReport(trackObjects(comps([0, 0, 1, 3, 6, 10, 15, 21, 28].map((d) => rect(blank(), 10 + d, 30, 8, 8, [255, 80, 160]))))[0]);
  ok("stutter: the uneven motion jitters, smooth acceleration doesn't", r.jitter > 0.1 && smooth.jitter === 0 && smooth.stutters.length === 0, [r.jitter, smooth.jitter]);
}

// a textured world (every pixel random) so a shifted crop has one exact match
let seed = 3;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const WORLD = blank(700, 140);
for (let i = 0; i < 700 * 140; i++) { const v = 60 + Math.floor(rnd() * 120); WORLD.data[i * 4] = v; WORLD.data[i * 4 + 1] = Math.floor(v * 0.8); WORLD.data[i * 4 + 2] = 255 - v; }
const view = (cx, cy, w = W, h = H) => { const out = blank(w, h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4, q = ((y + cy) * WORLD.width + x + cx) * 4; for (let c = 0; c < 4; c++) out.data[o + c] = WORLD.data[q + c]; } return out; };
{
  const s = estimateShift(view(10, 20), view(13, 18));
  ok("shift: camera +3,-2 → picture -3,+2, exact match", s.dx === -3 && s.dy === 2 && s.score === 0, s);
  ok("shift: no motion is 0,0", (() => { const z = estimateShift(view(5, 5), view(5, 5)); return z.dx === 0 && z.dy === 0; })());
  // a scroll of 3 px/f with one 4 px step (the planted jitter) and a vertical shake of 1 px
  const camX = [0], camY = [0];
  const dxs = [3, 3, 3, 3, 4, 3, 3, 3, 3, 3, 3, 3], dys = [0, 0, 0, 0, 0, 0, 0, 1, -1, 0, 0, 0];
  dxs.forEach((d, i) => { camX.push(camX[i] + d); camY.push(camY[i] + dys[i]); });
  const frames = camX.map((x, i) => view(20 + x, 20 + camY[i]));
  const cam = cameraPath(frames);
  show("camera 3 px/f, one 4 px step, a 1 px shake", `steps ${cam.steps.map((q) => `${q.dx},${q.dy}`).join(" ")} · jitter ${cam.jitter} · uneven ${cam.uneven.map((u) => u.i).join(",")}`);
  ok("camera: every step recovered exactly", cam.steps.every((q, k) => q.dx === dxs[k] && q.dy === dys[k]), cam.steps);
  ok("camera: the 4 px step (f5) and the shake (f8, f9) are flagged", JSON.stringify(cam.uneven.map((u) => u.i)) === JSON.stringify([5, 8, 9]), cam.uneven);
  ok("camera: total and per-frame motion", cam.total[0] === 37 && cam.total[1] === 0 && cam.perFrame[0] === 3.083, cam);
  const steady = cameraPath([0, 3, 6, 9, 12, 15].map((x) => view(30 + x, 10)));
  ok("camera: a steady scroll has jitter 0 and nothing uneven", steady.jitter === 0 && steady.uneven.length === 0, steady);
  const accel = cameraPath([0, 1, 3, 6, 10, 15, 21].map((x) => view(30 + x, 10)));
  ok("camera: a smoothly accelerating scroll has jitter 0", accel.jitter === 0 && accel.uneven.length === 0, accel);
}
{
  // a square walking +1 px/f through a world the camera scrolls past at +3 px/f: on screen it goes -2 px/f
  const N = 24, cams = Array.from({ length: N }, (_, i) => [3 * i, 0]);
  const frames = cams.map((c, i) => rect(view(c[0], 20), 120 + i - c[0] + 0, 40, 8, 8, [255, 0, 255]));
  const cam = cameraPath(frames);
  const offs = cam.positions.map((p) => [p[0], p[1]]);
  const mosaic = mosaicPlate(frames, offs);
  const perFrame = frames.map((f, i) => components(maskAgainstMosaic(f, mosaic, offs[i], null, 16), W, H, { minPixels: 8 }));
  const tracks = trackObjects(perFrame);
  const world = trackReport(tracks[0], (i) => offs[i]);
  show("square on a scrolling world", `camera ${cam.perFrame} px/f · ${tracks.length} track · world step ${world.meanStep} · screen net ${trackReport(tracks[0]).net}`);
  ok("scrolling: the camera's 3 px/f found despite the moving square", cam.steps.every((q) => q.dx === 3 && q.dy === 0), cam.steps.slice(0, 4));
  ok("scrolling: one object, found against the world mosaic", tracks.length === 1 && world.seen === N && perFrame.every((c) => c.length === 1 && c[0].count === 64), perFrame.map((c) => c.length));
  ok("scrolling: its world motion is +1 px/f, its screen motion -2 px/f", world.net[0] === N - 1 && world.meanStep === 1 && trackReport(tracks[0]).net[0] === -2 * (N - 1), [world.net, trackReport(tracks[0]).net]);
}

done("track");
