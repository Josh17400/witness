// Raster drawing tests: `node tests/media/raster.mjs` (writes tests/media/out/raster.png to look at)
import fs from "node:fs";
import { Raster, parseColor } from "../../src/media/raster.js";
import { decodePNG } from "../../src/media/png.js";
import { CHARSET, hasGlyph } from "../../src/media/font.js";
import { ok, show, save, done } from "./harness.mjs";

console.log("raster");

const px = (r, x, y) => r.getPixel(x, y);
const near = (a, b, tol = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

// ---- colors ----------------------------------------------------------------------------------
ok("color #rgb", near(parseColor("#f80"), [255, 136, 0, 1], 0));
ok("color #rrggbbaa", near(parseColor("#10203080"), [16, 32, 48, 128 / 255], 0.01));
ok("color rgba()", near(parseColor("rgba(1, 2, 3, 0.5)"), [1, 2, 3, 0.5], 0));
ok("color array", near(parseColor([9, 8, 7]), [9, 8, 7, 1], 0));
{ let threw = false; try { parseColor("chartreuse-ish"); } catch { threw = true; } ok("color: bad input throws", threw); }

// ---- fills, blending, clipping -----------------------------------------------------------------
{
  const r = new Raster(20, 10, "#000000");
  r.fillRect(2, 2, 4, 4, "#ff0000");
  ok("fillRect inside", near(px(r, 3, 3), [255, 0, 0, 255], 0));
  ok("fillRect outside", near(px(r, 7, 3), [0, 0, 0, 255], 0));
  r.fillRect(10.5, 2, 2, 1, "#ffffff");
  ok("fillRect fractional edge = half coverage", near(px(r, 10, 2), [128, 128, 128, 255], 1), px(r, 10, 2));
  r.fillRect(0, 8, 20, 2, "rgba(0, 0, 255, 0.5)");
  ok("alpha blend over opaque", near(px(r, 1, 8), [0, 0, 128, 255], 1), px(r, 1, 8));
  r.save().clip(0, 0, 5, 10).fillRect(0, 0, 20, 1, "#00ff00").restore();
  ok("clip limits drawing", near(px(r, 4, 0), [0, 255, 0, 255], 0) && near(px(r, 5, 0), [0, 0, 0, 255], 0));
  r.fillRect(15, 0, 3, 3, "#00ff00");
  ok("restore lifts the clip", near(px(r, 16, 1), [0, 255, 0, 255], 0));
  const t = new Raster(2, 1);
  t.blendPixel(0, 0, "rgba(255, 0, 0, 0.5)");
  ok("blend onto transparent keeps color, sets alpha", near(px(t, 0, 0), [255, 0, 0, 128], 1), px(t, 0, 0));
}

// ---- shapes are anti-aliased and the right size ----------------------------------------------------
{
  const r = new Raster(64, 64, "#000000");
  r.circle(32, 32, 10, "#ffffff");
  let ink = 0;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) ink += px(r, x, y)[0] / 255;
  show("circle r=10 area", `${ink.toFixed(1)} (π·r² = ${(Math.PI * 100).toFixed(1)})`);
  ok("circle area within 2%", Math.abs(ink - Math.PI * 100) / (Math.PI * 100) < 0.02, ink);
  const edge = px(r, 38, 39)[0];   // pixel centre 9.9 px from the centre: partly covered
  ok("circle edge is anti-aliased", edge > 20 && edge < 235, edge);

  const q = new Raster(64, 64, "#000000");
  q.polygon([[10, 10], [50, 10], [10, 50]], "#ffffff");
  let tri = 0;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) tri += px(q, x, y)[0] / 255;
  ok("triangle area within 2%", Math.abs(tri - 800) / 800 < 0.02, tri);

  const rr = new Raster(40, 40, "#000000");
  rr.roundRect(5, 5, 30, 30, 8, "#ffffff");
  ok("round rect: centre filled, corner empty", px(rr, 20, 20)[0] === 255 && px(rr, 5, 5)[0] < 40, [px(rr, 20, 20)[0], px(rr, 5, 5)[0]]);
}
{
  const r = new Raster(100, 20, "#000000");
  r.line(10, 10.5, 90, 10.5, "#ffffff", 1);
  ok("1px horizontal line is crisp", px(r, 50, 10)[0] > 240 && px(r, 50, 9)[0] < 15 && px(r, 50, 11)[0] < 15, [px(r, 50, 9)[0], px(r, 50, 10)[0], px(r, 50, 11)[0]]);
  const w = new Raster(100, 30, "#000000");
  w.line(10, 15, 90, 15, "#ffffff", 6);
  let col = 0;
  for (let y = 0; y < 30; y++) col += px(w, 50, y)[0] / 255;
  ok("6px line covers 6 px", Math.abs(col - 6) < 0.3, col);
  // translucent polyline: joints are not darker/brighter than the segments (union, not overlap)
  const p = new Raster(100, 100, "#000000");
  p.polyline([[10, 50], [50, 50], [50, 90]], "rgba(255, 255, 255, 0.5)", 4);
  ok("translucent polyline joint blends once", Math.abs(px(p, 50, 50)[0] - px(p, 30, 50)[0]) <= 2, [px(p, 50, 50)[0], px(p, 30, 50)[0]]);
  const d = new Raster(100, 10, "#000000");
  d.line(0, 5, 100, 5, "#ffffff", 2, { dash: [10, 10] });
  ok("dashed line has gaps", px(d, 5, 5)[0] > 200 && px(d, 15, 5)[0] < 30 && px(d, 25, 5)[0] > 200, [px(d, 5, 5)[0], px(d, 15, 5)[0], px(d, 25, 5)[0]]);
  const g = new Raster(100, 10, "#000000");
  g.polyline([[0, 5], [40, 5], null, [60, 5], [100, 5]], "#ffffff", 2);
  ok("null point leaves a gap", px(g, 20, 5)[0] > 200 && px(g, 50, 5)[0] < 10 && px(g, 80, 5)[0] > 200);
}

// ---- images --------------------------------------------------------------------------------------
{
  const src = new Raster(4, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) src.fillRect(x, y, 1, 1, (x + y) % 2 ? "#ffffff" : "#000000");
  const n = new Raster(8, 8, "#808080");
  n.drawImage(src, { dw: 8, dh: 8 });
  ok("drawImage nearest ×2", near(px(n, 0, 0), [0, 0, 0, 255], 0) && near(px(n, 2, 0), [255, 255, 255, 255], 0) && near(px(n, 1, 1), [0, 0, 0, 255], 0));
  const c = new Raster(2, 2, "#808080");
  c.drawImage(src, { sx: 1, sy: 0, sw: 2, sh: 2, dx: 0, dy: 0 });
  ok("drawImage crop", near(px(c, 0, 0), [255, 255, 255, 255], 0) && near(px(c, 1, 0), [0, 0, 0, 255], 0));
  const b = new Raster(2, 2, "#000000");
  b.drawImage(src, { dw: 2, dh: 2, smooth: "bilinear" });
  ok("drawImage bilinear shrink averages", near(px(b, 0, 0), [128, 128, 128, 255], 2), px(b, 0, 0));
  const up = new Raster(8, 1, "#000000");
  const ramp = new Raster(2, 1); ramp.fillRect(0, 0, 1, 1, "#000000"); ramp.fillRect(1, 0, 1, 1, "#ffffff");
  up.drawImage(ramp, { dw: 8, dh: 1, smooth: "bilinear" });
  ok("drawImage bilinear enlarge is a ramp", px(up, 0, 0)[0] < px(up, 3, 0)[0] && px(up, 3, 0)[0] < px(up, 4, 0)[0] && px(up, 4, 0)[0] < px(up, 7, 0)[0]);
  const round = Raster.from(src.toPNG());
  ok("Raster.from(PNG) round trip", round.data.every((v, i) => v === src.data[i]));
}

// ---- text ------------------------------------------------------------------------------------------
{
  const r = new Raster(200, 60, "#000000");
  ok("font covers ASCII 32–126", [...Array(95)].every((_, i) => hasGlyph(String.fromCharCode(32 + i))));
  ok("font covers report symbols", [..."·—…×→↔±▲✓µΔ♪≈≤≥"].every(hasGlyph) && hasGlyph("−") && !hasGlyph("漢"));
  ok("measureText: 8 px per char", r.measureText("hello") === 40 && r.measureText("hi", { scale: 2 }) === 32 && r.measureText("ab\nlonger") === 48);
  const w = r.text("Hi", 10, 10, { color: "#ffffff" });
  ok("text returns its width", w === 16);
  let ink = 0;
  for (let y = 10; y < 26; y++) for (let x = 10; x < 26; x++) if (px(r, x, y)[0] > 128) ink++;
  ok("text draws ink inside its cell", ink > 20, ink);
  const c = new Raster(100, 20, "#000000");
  c.text("X", 50, 0, { align: "center", color: "#ffffff" });
  let lo = 100, hi = -1;
  for (let x = 0; x < 100; x++) for (let y = 0; y < 20; y++) if (px(c, x, y)[0] > 128) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  ok("center alignment", Math.abs((lo + hi) / 2 - 50) <= 1.5, [lo, hi]);
  const rt = new Raster(100, 20, "#000000");
  rt.text("X", 100, 0, { align: "right", color: "#ffffff" });
  let maxX = -1;
  for (let x = 0; x < 100; x++) for (let y = 0; y < 20; y++) if (px(rt, x, y)[0] > 128) maxX = Math.max(maxX, x);
  ok("right alignment ends at x", maxX >= 96 && maxX <= 99, maxX);
  const bold = new Raster(40, 20, "#000000"), norm = new Raster(40, 20, "#000000");
  bold.text("Ml", 0, 0, { bold: true }); norm.text("Ml", 0, 0);
  const count = (q) => { let n = 0; for (let i = 0; i < q.data.length; i += 4) if (q.data[i] > 128) n++; return n; };
  ok("bold has more ink", count(bold) > count(norm) * 1.5, [count(bold), count(norm)]);
  ok("fitText truncates with …", r.fitText("abcdefghij", 48) === "abcde…" && r.fitText("abc", 48) === "abc");
}

// ---- a specimen to look at --------------------------------------------------------------------------
{
  const r = new Raster(1280, 440, "#0d0f14");
  r.text("Witness raster — specimen", 24, 32, { scale: 2, bold: true, color: "#e8ecf4", baseline: "middle" });
  r.text("anti-aliased shapes, translucent blending, Scale2x/3x text, bilinear images", 24, 62, { color: "#8a93a6", baseline: "middle" });
  let y = 96;
  for (const s of [1, 2]) for (const bold of [false, true]) {
    const per = Math.floor(1232 / (8 * s));
    for (let i = 0; i < CHARSET.length; i += per) { r.text(CHARSET.slice(i, i + per), 24, y, { scale: s, bold, color: "#e8ecf4" }); y += 16 * s + 2; }
    y += 4;
  }
  y += 10;
  r.text("Scale ×3", 24, y, { scale: 3, bold: true, color: "#ffd166" });
  r.roundRect(360, y, 180, 60, 12, "#4cc9f0");
  r.roundRect(400, y + 20, 180, 60, 12, "rgba(255,77,141,0.75)");
  r.strokeRoundRect(620, y, 160, 70, 14, "#3ddc97", 3);
  r.circle(850, y + 35, 30, "#a78bfa"); r.strokeCircle(850, y + 35, 38, "rgba(255,255,255,0.4)", 2);
  r.polygon([[930, y + 70], [970, y], [1010, y + 70]], "#ff9f43");
  const wave = []; for (let x = 0; x <= 200; x += 2) wave.push([1050 + x, y + 35 + 25 * Math.sin(x / 15)]);
  r.polyline(wave, "#4cc9f0", 2.5);
  r.line(1050, y + 80, 1250, y + 80, "#ff5a78", 1.5, { dash: [6, 5] });
  for (const [i, a] of ["left", "center", "right"].entries()) {
    const x = [24, 640, 1256][i];
    r.text(`${a} aligned`, x, 420, { align: a, color: "#8a93a6", baseline: "middle" });
  }
  const file = save("raster.png", r.toPNG());
  ok("specimen written", decodePNG(fs.readFileSync(file)).width === 1280);
}

done("raster");
