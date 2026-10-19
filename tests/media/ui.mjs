// UI layout tests: `node tests/media/ui.mjs` — geometry checks on a planted layout, text contrast with anti-aliased
// edges, and text-like rows found from pixels alone (drawn with the embedded 8×16 font, so the glyph boxes are known).
import { normalizeUI, layoutChecks, textContrast, findTextRows, safePreset, duplicateTexts, pixelDuplicates, textTimeline, repeatedTexts, plateCheck } from "../../src/media/ui.js";
import { contrastRatio } from "../../src/media/color.js";
import { glyph } from "../../src/media/font.js";
import { ok, show, done } from "./harness.mjs";

console.log("ui");

const img = (w, h, c) => { const d = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) d.set([c[0], c[1], c[2], 255], i * 4); return { width: w, height: h, data: d }; };
const put = (im, x, y, c) => { if (x >= 0 && y >= 0 && x < im.width && y < im.height) im.data.set([c[0], c[1], c[2], 255], (y * im.width + x) * 4); };
const rect = (im, x, y, w, h, c) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) put(im, i, j, c); };
/** Draw text with the 8×16 font; returns the ink bounding box. */
function text(im, s, x0, y0, c) {
  let bx0 = Infinity, by0 = Infinity, bx1 = -1, by1 = -1;
  [...s].forEach((ch, i) => { const g = glyph(ch); for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) if (g[y * 8 + x]) { const px = x0 + i * 8 + x, py = y0 + y; put(im, px, py, c); bx0 = Math.min(bx0, px); by0 = Math.min(by0, py); bx1 = Math.max(bx1, px); by1 = Math.max(by1, py); } });
  return { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 };
}

// ---- geometry: the mock game's planted layout (tests/mock-game.mjs MOCK_UI), 320×180
const LAYOUT = [
  { id: "hud", kind: "panel", rect: [16, 10, 140, 20] },
  { id: "score", kind: "text", rect: [20, 12, 40, 16], text: "SCORE", fontPx: 16 },
  { id: "lives", kind: "text", rect: [70, 12, 32, 16], text: "HP 3", fontPx: 16 },
  { id: "hint", kind: "text", rect: [100, 150, 56, 16], text: "PRESS E", fontPx: 16 },
  { id: "tiny", kind: "text", rect: [200, 150, 30, 4], text: "tiny", fontPx: 3 },
  { id: "btn_a", kind: "button", rect: [200, 40, 60, 20] },
  { id: "btn_b", kind: "button", rect: [240, 50, 60, 20] },
  { id: "btn_c", kind: "button", rect: [202, 74, 60, 20], text: "QUIT", fontPx: 16 },
  { id: "minimap", kind: "panel", rect: [290, 120, 40, 40] },
  { id: "badge", kind: "icon", rect: [10, 100, 12, 12] },
  { id: "toast", kind: "text", rect: [330, 20, 48, 16], text: "SAVED!", fontPx: 16 },
];
{
  const els = normalizeUI(LAYOUT);
  const c = layoutChecks(els, { width: 320, height: 180, safe: 0.05, minText: 3.6 });
  ok("margins 5% of 320×180 = 16×9", c.margins.x === 16 && c.margins.y === 9);
  ok("clipped: minimap 10 px past the right edge, 75% visible", c.clipped.length === 1 && c.clipped[0].id === "minimap" && c.clipped[0].past.right === 10 && c.clipped[0].visiblePercent === 75, c.clipped);
  ok("off screen: toast", c.offscreen.length === 1 && c.offscreen[0].id === "toast");
  ok("safe area: badge 6 px into the left margin (only)", c.unsafe.length === 1 && c.unsafe[0].id === "badge" && c.unsafe[0].into.left === 6 && Object.keys(c.unsafe[0].into).length === 1, c.unsafe);
  ok("overlaps: btn_a × btn_b 20×10 at 240,50; text inside the hud panel is not an overlap", c.overlaps.length === 1 && c.overlaps[0].a === "btn_a" && c.overlaps[0].b === "btn_b" && c.overlaps[0].rect.join() === "240,50,20,10" && c.overlaps[0].area === 200, c.overlaps);
  ok("small text: tiny (3 px < 3.6)", c.small.length === 1 && c.small[0].id === "tiny" && c.small[0].fontPx === 3 && !c.small[0].estimated, c.small);
  ok("almost aligned: tiny/btn_c left, btn_a/btn_c left+right+centre-x, 2 px; nested pairs skipped", c.aligned.length === 2 && c.aligned[0].a === "tiny" && c.aligned[0].b === "btn_c" && c.aligned[0].edges.map((e) => e.edge).join() === "left" && c.aligned[1].edges.map((e) => `${e.edge}:${e.diff}`).join() === "left:2,right:2,centre-x:2", c.aligned);
  const t = layoutChecks(els, { width: 280, height: 180, safe: 0.05, minText: 3.6 });
  ok("at 280 wide btn_b is clipped (20 px, 66.67% visible) and the minimap (x 290) is off screen", t.clipped.map((x) => x.id).join() === "btn_b" && t.clipped[0].past.right === 20 && t.clipped[0].visiblePercent === 66.67 && t.offscreen.map((x) => x.id).join() === "minimap,toast", [t.clipped, t.offscreen]);
  ok("safe in px and other layers", layoutChecks(normalizeUI([{ id: "a", rect: [5, 5, 10, 10], layer: 1 }, { id: "b", rect: [8, 8, 10, 10], layer: 2 }]), { width: 100, height: 100, safe: { x: 4, y: 6 } }).unsafe.map((u) => `${u.id}:${JSON.stringify(u.into)}`).join() === 'a:{"top":1}' && layoutChecks(normalizeUI([{ id: "a", rect: [5, 5, 10, 10], layer: 1 }, { id: "b", rect: [8, 8, 10, 10], layer: 2 }]), { width: 100, height: 100 }).overlaps.length === 0);
  ok("a label inside another label still overlaps (only panels and buttons hold others)", layoutChecks(normalizeUI([{ id: "a", kind: "text", text: "x", rect: [10, 10, 40, 10] }, { id: "b", kind: "text", text: "y", rect: [12, 12, 8, 6] }]), { width: 100, height: 100 }).overlaps.length === 1);
  ok("text with no fontPx: the rect height, marked estimated", (() => { const s = layoutChecks(normalizeUI([{ id: "a", kind: "text", text: "x", rect: [20, 20, 30, 5] }]), { width: 100, height: 100, minText: 8 }).small; return s.length === 1 && s[0].fontPx === 5 && s[0].estimated; })());
  ok("normalizeUI: a malformed rect is named", (() => { try { normalizeUI([{ id: "x", rect: [1, 2, 3] }]); return false; } catch (e) { return /state\.ui\[0\] \(x\)/.test(e.message); } })());
  ok("normalizeUI: hidden elements are left out, kind guessed from text", (() => { const n = normalizeUI([{ id: "a", rect: [0, 0, 1, 1], hidden: true }, { id: "b", rect: [0, 0, 1, 1], text: "hi" }]); return n.length === 1 && n[0].kind === "text"; })());
}

// ---- text contrast: crisp text is exact; anti-aliased edges don't dilute it; a flat rect is null
{
  const bg = [20, 24, 40], fg = [70, 70, 90];
  const im = img(80, 30, bg);
  text(im, "PRESS E", 10, 7, fg);
  const r = textContrast(im, { x: 10, y: 7, w: 56, h: 16 });
  const want = Math.round(contrastRatio(fg, bg) * 1000) / 1000;
  show("low-contrast text", `${r.ratio}:1 (want ${want}) fg ${r.fg} bg ${r.bg}`);
  ok("crisp text: the exact ratio of its two colours", r.ratio === want && r.fg.join() === fg.join() && r.bg.join() === bg.join(), r);
  const aa = img(80, 30, [255, 255, 255]);
  const box = text(aa, "HELLO", 10, 7, [0, 0, 0]);
  for (let x = box.x; x < box.x + box.w; x++) put(aa, x, box.y + box.h, [128, 128, 128]);   // a grey anti-aliased row
  const ra = textContrast(aa, { x: 8, y: 5, w: 48, h: 20 });
  ok("anti-aliased pixels are left out: still 21:1", ra.ratio === 21 && ra.fg.join() === "0,0,0", ra);
  ok("a flat rect has no text: null", textContrast(img(20, 20, bg), { x: 0, y: 0, w: 20, h: 20 }) === null);
  ok("a rect off the image: null", textContrast(im, { x: 200, y: 0, w: 10, h: 10 }) === null);
}

// ---- text rows from pixels: font glyph boxes are known, sprites and fences are not text
{
  const bg = [20, 24, 40], im = img(320, 180, bg);
  const b1 = text(im, "SCORE 120", 20, 10, [255, 255, 255]);
  rect(im, 150, 100, 100, 30, [60, 90, 160]);                      // a button (2.6% of the picture: not background)
  const b2 = text(im, "PLAY", 184, 107, [255, 255, 255]);
  for (let i = 0; i < 6; i++) rect(im, 40 + i * 3, 150, 1, 10, [200, 200, 200]);   // a fence: 1 px bars
  for (const [cx, cy] of [[100, 60], [115, 60], [130, 60]]) for (let y = -5; y <= 5; y++) for (let x = -5; x <= 5; x++) if (x * x + y * y <= 25) put(im, cx + x, cy + y, [255, 210, 60]);   // 3 coins in a row
  const { rows, panels } = findTextRows(im);
  show("rows", rows.map((r) => `${r.x},${r.y} ${r.w}×${r.h} ${r.glyphs}g ${r.glyphPx}px`).join(" · "));
  const r1 = rows.find((r) => r.y < 50), r2 = rows.find((r) => r.y > 100 && r.y < 130);
  ok("row: 'SCORE 120' as one row with its exact ink box, glyphs 10 px (capitals)", r1 && r1.x === b1.x && r1.y === b1.y && r1.w === b1.w && r1.h === b1.h && r1.glyphs === 8 && r1.glyphPx === 10, r1);
  ok("row: 'PLAY' found inside the solid button", r2 && r2.x === b2.x && r2.w === b2.w && r2.glyphPx === 10 && panels.some((p) => p.x === 150 && p.w === 100 && p.h === 30), [r2, panels]);
  ok("not text: a fence of 1 px bars, a row of identical coins (icons): exactly the 2 text rows", rows.length === 2, rows);
}

// ---- regressions: rows don't depend on unrelated shapes elsewhere; outlined text is judged by its edges
{
  const im = img(200, 150, [10, 10, 20]);
  rect(im, 40, 15, 4, 4, [255, 255, 255]); rect(im, 52, 10, 5, 9, [255, 255, 255]); rect(im, 60, 13, 4, 6, [255, 255, 255]);
  const before = findTextRows(im).rows;
  rect(im, 50, 100, 3, 4, [255, 255, 255]);   // far below, but between the glyphs in x order
  const after = findTextRows(im).rows;
  ok("findTextRows: a small shape far away doesn't break the row (was: rows = [])", before.length === 1 && after.length === 1 && after[0].x === 40 && after[0].y === 10 && after[0].w === 24 && after[0].h === 9 && after[0].glyphs === 3, after);

  // yellow letters with a 1 px black outline on light grey: unreadable without the outline, plainly readable with it
  const o = img(60, 20, [200, 200, 200]), ink = new Set();
  [..."HELLO"].forEach((ch, i) => { const g = glyph(ch); for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) if (g[y * 8 + x]) ink.add(`${4 + i * 10 + x},${2 + y}`); });
  for (const k of ink) { const [x, y] = k.split(",").map(Number); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!ink.has(`${x + dx},${y + dy}`)) put(o, x + dx, y + dy, [0, 0, 0]); }
  for (const k of ink) { const [x, y] = k.split(",").map(Number); put(o, x, y, [255, 255, 0]); }
  const tc = textContrast(o, { x: 0, y: 0, w: 60, h: 20 });
  const yb = contrastRatio([255, 255, 0], [0, 0, 0]), bg2 = contrastRatio([0, 0, 0], [200, 200, 200]), plain = contrastRatio([255, 255, 0], [200, 200, 200]);
  ok("textContrast: an outline is measured (yellow/black 19.56, black/grey 12.55; 1.56 without it)", tc && tc.outline && Math.abs(tc.ratio - yb) < 0.01 && Math.abs(tc.outline.outlineVsBg - bg2) < 0.01 && Math.abs(tc.outline.plainRatio - plain) < 0.01 && tc.outline.color.join() === "0,0,0", tc);
  const p2 = img(60, 20, [200, 200, 200]);
  for (const k of ink) { const [x, y] = k.split(",").map(Number); put(p2, x, y, [255, 255, 0]); }
  const tp = textContrast(p2, { x: 0, y: 0, w: 60, h: 20 });
  ok("textContrast: the same letters without an outline stay low contrast, no outline reported", tp && !tp.outline && Math.abs(tp.ratio - plain) < 0.01, tp);
}

// ---- device safe areas: points × (screenshot px / device pt), per side
{
  const p = safePreset("iphone-portrait", 1179, 2556);   // an iPhone 15 screenshot at @3x
  ok("iphone-portrait at device pixels: top 59 pt = 177 px, bottom 34 pt = 102 px, sides 0", p.px.top === 177 && p.px.bottom === 102 && p.px.left === 0 && p.px.right === 0 && p.devicePx.top === 177 && !p.mismatch, p);
  const l = safePreset("iphone-landscape", 852, 393);   // a game rendering at 1 px per point
  ok("iphone-landscape at 852×393: left/right 59, bottom 21, top 0; zones named", l.px.left === 59 && l.px.right === 59 && l.px.bottom === 21 && l.px.top === 0 && l.zones.bottom === "home indicator" && /Dynamic Island/.test(l.zones.left) && !l.zones.top, l);
  const g = safePreset("iphone-landscape", 1280, 720);
  ok("a 16:9 game on a landscape iPhone: insets scaled per axis and the aspect flagged", g.px.left === Math.round(59 * 1280 / 852 * 100) / 100 && g.px.bottom === Math.round(21 * 720 / 393 * 100) / 100 && /aspect 1.78/.test(g.mismatch), g);
  ok("iphone-portrait on a landscape shot: flagged", /landscape \(1280×720\) but iphone-portrait is portrait/.test(safePreset("iphone-portrait", 1280, 720).mismatch));
  ok("iphone-se follows the shot: portrait top 20 pt (×2 = 40 px at 750×1334), landscape none", safePreset("iphone-se", 750, 1334).px.top === 40 && Object.values(safePreset("iphone-se", 1334, 750).px).every((v) => v === 0));
  ok("ipad landscape 2360×1640: top 24 pt = 48 px, bottom 20 pt = 40 px", (() => { const q = safePreset("ipad", 2360, 1640); return q.px.top === 48 && q.px.bottom === 40 && q.orientation === "landscape"; })());
  ok("unknown preset: a clear error", (() => { try { safePreset("pixel-8", 1, 1); return false; } catch (e) { return /iphone-portrait, iphone-landscape, iphone-se, ipad/.test(e.message); } })());
  const els = normalizeUI([{ id: "hp", kind: "text", text: "HP", rect: [10, 10, 40, 12] }, { id: "pause", kind: "button", rect: [790, 300, 50, 80] }, { id: "mid", kind: "text", text: "ok", rect: [300, 150, 40, 12] }]);
  const c = layoutChecks(els, { width: 852, height: 393, safe: l.px });
  ok("per-side margins: hp 49 px into the left inset; pause 47 px into the right one and 8 px into the bottom one", c.unsafe.length === 2 && c.unsafe[0].id === "hp" && c.unsafe[0].into.left === 49 && !c.unsafe[0].into.top && c.unsafe[1].id === "pause" && c.unsafe[1].into.right === 47 && c.unsafe[1].into.bottom === 8 && c.margins.right === 59 && c.margins.bottom === 21, c.unsafe);
}

// ---- the same text twice at once; a toast that shows again
{
  const els = normalizeUI([
    { id: "q1", kind: "text", text: "Quest updated: Find the key", rect: [10, 10, 200, 12] },
    { id: "q2", kind: "text", text: "quest  updated: find the key ", rect: [10, 30, 200, 12] },
    { id: "btn", kind: "button", text: "Quit", rect: [300, 10, 60, 20] }, { id: "btnlabel", kind: "text", text: "QUIT", rect: [310, 14, 40, 12] },
    { id: "n1", kind: "text", text: "3", rect: [0, 100, 8, 8] }, { id: "n2", kind: "text", text: "3", rect: [20, 100, 8, 8] },
    { id: "off", kind: "text", text: "Quest updated: Find the key", rect: [500, 10, 200, 12] },
  ]);
  const d = duplicateTexts(els, { width: 400, height: 200 });
  ok("duplicateTexts: the quest line twice (case/spaces ignored) with both rects; not a button's own label, not a digit, not off screen", d.length === 1 && d[0].ids.join() === "q1,q2" && d[0].rects[1].join() === "10,30,200,12", d);
  const mk = (f, list) => ({ f, els: normalizeUI(list) });
  const toast = { id: "toast", kind: "text", text: "Quest updated", rect: [100, 20, 90, 12] };
  const samples = [];
  for (let f = 0; f <= 600; f += 6) samples.push(mk(f, (f >= 60 && f <= 180) || (f >= 300 && f <= 360) || f >= 594 ? [toast] : []));
  const tl = textTimeline(samples);
  ok("textTimeline: three showings f60-f180, f300-f360, f594-f600", tl.get("quest updated").shows.map((s) => `${s.f0}-${s.f1}`).join() === "60-180,300-360,594-600");
  const rep = repeatedTexts(tl, { within: 5, fps: 60 });
  ok("repeatedTexts within 5 s: again at f300, 4 s after it first showed, hidden 2 s; f594 is 4.9 s after f300", rep.length === 2 && rep[0].again.f0 === 300 && rep[0].sinceStart === 4 && rep[0].hidden === 2 && rep[1].sinceStart === 4.9, rep);
  ok("repeatedTexts within 3 s: none", repeatedTexts(tl, { within: 3, fps: 60 }).length === 0);
  // pixel mode: two identical rendered rows are duplicates, a different word is not
  const bg = [20, 24, 40], im = img(200, 80, bg);
  const a = text(im, "SAVED", 10, 5, [255, 255, 255]), b = text(im, "SAVED", 100, 40, [255, 255, 255]), c = text(im, "SAVES", 10, 40, [255, 255, 255]);
  const pd = pixelDuplicates(im, [a, b, c]);
  ok("pixelDuplicates: SAVED twice (IoU 1), SAVES is not a copy", pd.length === 1 && pd[0].a === a && pd[0].b === b && pd[0].iou === 1, pd.map((p) => [p.a, p.b, p.iou]));
}

// ---- text without a plate: worst contrast over the glyph edge, not the average
{
  const white = [240, 240, 240], grass = [40, 90, 40], sand = [222, 205, 160];
  const im = img(120, 30, grass);
  rect(im, 60, 0, 60, 30, sand);                      // the world: dark grass on the left, bright sand on the right
  const box = text(im, "WEARY", 36, 7, white);        // straddles both
  const r = plateCheck(im, box);
  const wantWorst = Math.round(contrastRatio(white, sand) * 100) / 100, wantBest = Math.round(contrastRatio(white, grass) * 100) / 100;
  show("WEARY over grass|sand", `worst ${r.edge.worst} (want ${wantWorst}) at ${r.edge.at} best ${r.edge.best} (want ${wantBest}) bgShare ${r.bgShare}`);
  ok("no plate: busy background, worst edge = white on sand, best = white on grass", r.busy && r.text.join() === white.join() && r.edge.worst === wantWorst && r.edge.best === wantBest && r.edge.bgAt.join() === sand.join() && r.edge.at[0] >= 60, r);
  const tc = textContrast(im, box);
  ok("…while the averaged textContrast passes it (6.13:1 ≥ 4.5): why busy backgrounds use the worst edge", tc && tc.ratio === 6.129, tc);
  const plate = img(120, 30, grass); rect(plate, 30, 3, 50, 24, [10, 10, 30]); rect(plate, 60, 0, 60, 3, sand);
  const box2 = text(plate, "WEARY", 36, 7, white);
  const p2 = plateCheck(plate, box2);
  ok("on a plate: not busy, every edge the same ratio", p2 && !p2.busy && p2.edge.worst === p2.edge.best && p2.edge.worst === Math.round(contrastRatio(white, [10, 10, 30]) * 100) / 100, p2);
  // anti-aliased: a half-way ring between white text and sand is skipped for the sand behind it (outer edges; a 1 px
  // gap between two strokes has no ground behind it and counts as it is)
  const aa = img(120, 30, grass); rect(aa, 60, 0, 60, 30, sand);
  const box3 = text(aa, "WEARY", 36, 7, white), ink = new Set();
  for (let y = box3.y; y < box3.y + box3.h; y++) for (let x = box3.x; x < box3.x + box3.w; x++) { const o = (y * 120 + x) * 4; if (aa.data[o] === 240) ink.add(y * 120 + x); }
  const mid = (p, q) => p.map((v, i) => Math.round((v + q[i]) / 2));
  for (const k of ink) { const x = k % 120, y = (k - x) / 120; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = (y + dy) * 120 + x + dx; if (!ink.has(n) && !ink.has(n + dy * 120 + dx) && x + dx >= 62) put(aa, x + dx, y + dy, mid(white, sand)); } }
  const p3 = plateCheck(aa, box3);
  ok("anti-aliased edge pixels are skipped: worst is still white vs sand", p3 && p3.edge.worst === wantWorst, p3 && p3.edge);
}

done("ui");
