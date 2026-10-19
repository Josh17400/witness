// Screenshot diff tests: `node tests/media/diff.mjs` (writes out/diff-*.png to look at)
import { diffImages } from "../../src/media/diff.js";
import { Raster } from "../../src/media/raster.js";
import { decodePNG } from "../../src/media/png.js";
import { ok, show, save, done } from "./harness.mjs";

console.log("diff");

/** A small game-like frame: sky, ground, a HUD, and a player square at (px, py). */
function frame(px, py, { w = 320, h = 180, score = "SCORE 0120" } = {}) {
  const r = new Raster(w, h, "#1b2a4a");
  r.fillRect(0, h * 0.75, w, h * 0.25, "#2e5e3a");
  for (let i = 0; i < 6; i++) r.circle(30 + i * 52, 30 + (i % 2) * 12, 9, "#e8ecf4");
  r.text(score, 8, 4, { color: "#ffd166" });
  r.fillRect(px, py, 20, 20, "#ff4d8d");
  return r;
}

{
  const a = frame(60, 100), b = frame(140, 100);
  const d = diffImages(a.toPNG(), b.toPNG(), { title: "player moved" });
  save("diff-moved.png", d.png);
  show("moved square", `${d.changedPercent}% · boxes ${JSON.stringify(d.boxes.map(({ x, y, w, h }) => [x, y, w, h]))} · max Δ ${d.maxDelta}`);
  ok("moved: 2 regions (where it was, where it is)", d.boxes.length === 2, d.boxes);
  const sorted = [...d.boxes].sort((p, q) => p.x - q.x);
  ok("moved: old position boxed exactly", sorted[0] && sorted[0].x === 60 && sorted[0].y === 100 && sorted[0].w === 20 && sorted[0].h === 20, sorted[0]);
  ok("moved: new position boxed exactly", sorted[1] && sorted[1].x === 140 && sorted[1].y === 100 && sorted[1].w === 20 && sorted[1].h === 20, sorted[1]);
  ok("moved: 800 px changed", d.changedPixels === 800, d.changedPixels);
  ok("moved: percent matches", Math.abs(d.changedPercent - (800 / (320 * 180)) * 100) < 0.01, d.changedPercent);
  ok("moved: max delta is large", d.maxDelta > 150, d.maxDelta);
  const viz = decodePNG(d.png);
  ok("moved: visualization enlarged for legibility", viz.width >= 640 + 32, viz.width);
}
{
  const a = frame(60, 100), b = frame(60, 100);
  const d = diffImages(a.toPNG(), b.toPNG());
  ok("identical: zero change", d.identical && d.changedPixels === 0 && d.boxes.length === 0 && d.maxDelta === 0);
  save("diff-identical.png", d.png);
}
{
  // a nearby pair of changes merges into one box; a far one stays separate
  const a = frame(60, 100), b = frame(60, 100);
  b.fillRect(200, 60, 6, 6, "#ffffff"); b.fillRect(210, 60, 6, 6, "#ffffff"); b.fillRect(20, 150, 4, 4, "#000000");
  const d = diffImages(a, b);
  ok("clustering: near changes share a box", d.boxes.length === 2 && d.boxes.some((x) => x.x === 200 && x.w === 16), d.boxes);
}
{
  // threshold: a faint brightness shift is ignored by default, caught at threshold 0
  const a = frame(60, 100), b = frame(60, 100);
  for (let i = 0; i < b.data.length; i += 4) b.data[i] = Math.min(255, b.data[i] + 6);
  ok("threshold: faint shift ignored", diffImages(a, b).changedPixels === 0);
  ok("threshold 0 catches it", diffImages(a, b, { threshold: 0 }).changedPercent > 90);
}
{
  // ignore regions: the HUD score ticks up but we told it not to look there
  const a = frame(60, 100), b = frame(60, 100, { score: "SCORE 0130" });
  ok("HUD change detected", diffImages(a, b).boxes.length === 1);
  const d = diffImages(a, b, { ignore: [{ x: 0, y: 0, w: 100, h: 20 }] });
  ok("ignore region masks it", d.changedPixels === 0, d.changedPixels);
}
{
  // size mismatch: reported, B scaled to A's size, still comparable
  const a = frame(60, 100), b = frame(120, 200, { w: 640, h: 360 });
  const d = diffImages(a.toPNG(), b.toPNG(), { title: "resolution changed" });
  save("diff-size.png", d.png);
  ok("size mismatch reported", d.sizeMismatch && d.sizeMismatch.a.join() === "320,180" && d.sizeMismatch.b.join() === "640,360", d.sizeMismatch);
  ok("size mismatch: compared at A's size", d.width === 320 && d.height === 180);
  ok("size mismatch: not identical", !d.identical);
}
{
  // a big screenshot is shrunk for viewing; the boxes stay in original pixels
  const a = new Raster(1920, 1080, "#202020"), b = new Raster(1920, 1080, "#202020");
  b.fillRect(1500, 900, 100, 50, "#ffffff");
  const d = diffImages(a, b, { title: "1080p" });
  save("diff-1080p.png", d.png);
  ok("1080p: box in original coordinates", d.boxes.length === 1 && d.boxes[0].x === 1500 && d.boxes[0].w === 100, d.boxes);
  ok("1080p: the three-panel picture fits 1600 px", decodePNG(d.png).width <= 1600, decodePNG(d.png).width);
}
{
  let msg = "";
  try { diffImages(Buffer.from("nope"), frame(0, 0)); } catch (e) { msg = e.message; }
  ok("bad input: clear error", /image A is not a readable PNG/.test(msg), msg);
}

// ---- diff v2: what each region is, camera shifts, SSIM
{
  const a = frame(60, 100), b = frame(140, 100);
  const d = diffImages(a, b);
  const mv = d.boxes.filter((x) => x.kind === "moved");
  show("v2 moved square", d.moves.map((m) => `${m.from.x},${m.from.y} → ${m.to.x},${m.to.y} by ${m.by}`).join(" · "));
  ok("v2: the two regions are one move of +80,0", mv.length === 2 && d.moves.length === 1 && d.moves[0].by.join() === "80,0" && d.moves[0].from.x === 60 && d.moves[0].to.x === 140, d.boxes);
}
{
  const a = frame(60, 100), b = frame(60, 100);
  b.circle(250, 80, 6, "#ffd166");                     // a coin appears
  const c = frame(60, 100); c.fillRect(60, 100, 20, 20, "#1b2a4a");   // the player is gone (sky colour)
  const d = diffImages(a, b), e = diffImages(a, c);
  ok("v2: a new coin is 'appeared'", d.boxes.length === 1 && d.boxes[0].kind === "appeared", d.boxes);
  ok("v2: a vanished square is 'gone'", e.boxes.length === 1 && e.boxes[0].kind === "gone", e.boxes);
  const f = frame(60, 100); f.fillRect(60, 100, 20, 20, "#4cc9f0");   // recoloured in place
  ok("v2: a recoloured square is 'changed'", diffImages(a, f).boxes[0].kind === "changed");
  const g = frame(62, 100);                                            // moved 2 px: one box, moved within it
  const gd = diffImages(a, g);
  ok("v2: a 2 px move inside one box is 'moved' +2,0", gd.boxes.length === 1 && gd.boxes[0].kind === "moved" && gd.boxes[0].moved.join() === "2,0", gd.boxes);
}
{
  // the camera moved 1 px: everything changes, but after aligning nothing did
  const a = frame(60, 100);
  for (let i = 0; i < 400; i++) a.fillRect((i * 37) % 320, 140 + ((i * 13) % 40), 2, 2, i % 2 ? "#3a6e4a" : "#24502f");   // grass texture
  const b = new Raster(320, 180, "#1b2a4a");
  b.drawImage(a, { dx: 1, dy: 0 });
  const raw = diffImages(a, b), al = diffImages(a, b, { align: true });
  show("1 px camera shift", `raw ${raw.changedPercent}% → aligned ${al.changedPercent}% · shift ${al.shift && [al.shift.dx, al.shift.dy]} · SSIM ${al.ssim}`);
  ok("shift: without aligning, every edge changes", raw.changedPercent > 1, raw.changedPercent);
  ok("shift: found (+1, 0); after aligning ~0% changed", al.shift && al.shift.dx === 1 && al.shift.dy === 0 && al.changedPercent < 0.1 && al.shift.rawPercent === raw.changedPercent, [al.shift, al.changedPercent]);
}
{
  // SSIM: 1 for identical images, falling as noise grows
  const a = frame(60, 100);
  const noisy = (amt) => { const b = new Raster(320, 180); b.data.set(a.data); let s = 9; for (let i = 0; i < b.data.length; i += 4) { s = (s * 1103515245 + 12345) & 0x7fffffff; const n = ((s / 0x7fffffff) * 2 - 1) * amt; for (let c = 0; c < 3; c++) b.data[i + c] = Math.max(0, Math.min(255, b.data[i + c] + n)); } return b; };
  const v = [0, 8, 24, 64].map((amt) => diffImages(a, amt ? noisy(amt) : a).ssim);
  show("SSIM vs noise 0/8/24/64", v.join(" / "));
  ok("ssim: 1 for identical, falling monotonically with noise", v[0] === 1 && v[1] < 1 && v[1] > v[2] && v[2] > v[3], v);
  let msg = "";
  try { diffImages(frame(0, 0), frame(0, 0, { w: 640, h: 360 }), { resize: false }); } catch (e) { msg = e.message; }
  ok("resize: false refuses different sizes", /sizes differ/.test(msg), msg);
}

done("diff");
