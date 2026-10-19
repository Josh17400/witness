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
  // three letter-like outlines (1 px strokes; filled blocks are not letters) on one baseline
  const box = (x, y, w, h) => { rect(im, x, y, w, 1, [255, 255, 255]); rect(im, x, y + h - 1, w, 1, [255, 255, 255]); rect(im, x, y, 1, h, [255, 255, 255]); rect(im, x + w - 1, y, 1, h, [255, 255, 255]); };
  box(40, 15, 4, 4); box(52, 10, 5, 9); box(60, 13, 4, 6);
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
  // a 16:9 game on a landscape iPhone is fitted to the height (contain): 393/720 pt per px, 1280 px = 698.67 pt wide,
  // (852 − 698.67)/2 = 76.67 pt bars: the 59 pt side insets end inside the bars (0 px); bottom 21 pt = 38.47 px
  const g = safePreset("iphone-landscape", 1280, 720);
  ok("a 16:9 game on a landscape iPhone (contain): sides inside the 76.67 pt bars = 0 px, bottom 21 pt = 38.47 px", g.px.left === 0 && g.px.right === 0 && g.px.bottom === Math.round((21 * 720) / 393 * 100) / 100 && g.bars.x === 76.67 && /aspect 1.78/.test(g.mismatch) && !g.demote, g);
  const gs = safePreset("iphone-landscape", 1280, 720, { fit: "stretch" });
  ok("--fit stretch: per axis (59 pt = 88.64 px across) and demoted to warnings", gs.px.left === Math.round((59 * 1280) / 852 * 100) / 100 && gs.demote && /warnings/.test(gs.mismatch), gs);
  const gc = safePreset("iphone-landscape", 1280, 720, { fit: "cover" });
  // cover: 852/1280 pt per px, 479.25 pt tall: 43.125 pt cut off top and bottom; the bottom inset plus the cut-off
  // strip = 64.125 pt = 96.34 px of the picture lost at the bottom; sides 59 pt = 88.64 px
  ok("--fit cover: sides 88.64 px, bottom 96.34 px (21 pt inset + 43.13 pt cut off)", gc.px.left === 88.64 && gc.px.bottom === 96.34 && gc.bars.y < -43.1 && gc.bars.y > -43.2, gc);
  // examples/arena: 480×288 (5:3) on a landscape iPhone 15: 1.3646 pt per px, 98.5 pt bars: only the bottom applies
  const ar = safePreset("iphone-landscape", 480, 288);
  ok("arena 480×288 on iphone-landscape: left/right 0 (98.5 pt bars), bottom 21/1.3646 = 15.39 px", ar.px.left === 0 && ar.px.right === 0 && ar.px.bottom === 15.39 && ar.bars.x === 98.5, ar);
  // a Safari tab (the team's setup): the toolbars are outside the page, no insets
  const sf = safePreset("iphone-safari-portrait", 393, 659);
  ok("iphone-safari-portrait at 393×659: no insets, no mismatch", Object.values(sf.px).every((v) => v === 0) && !sf.mismatch, sf);
  // iPhone 15 Pro Max at @3x (1290×2796): the Max preset gives 177 px; the 393 pt preset says it doesn't fit
  const mx = safePreset("iphone-max-portrait", 1290, 2796);
  ok("iphone-max-portrait at 1290×2796: top 59 pt = 177 px, bottom 34 pt = 102 px", mx.px.top === 177 && mx.px.bottom === 102 && !mx.sizeNote, mx);
  // the game's own logical canvas (639×295, the device's aspect): no "not a whole multiple" warning, one line on the
  // mapping: contain = min(852/639, 393/295) = 1.3322 pt per px, (852 − 639 × 1.3322)/2 = 0.36 pt bars left and right
  const cv = safePreset("iphone-landscape", 639, 295, { canvas: true }), cf = safePreset("iphone-landscape", 639, 295);
  ok("a game canvas 639×295: no size warning, the mapping said once; insets (59 − 0.36)/1.3322 = 44.02 px, 21/1.3322 = 15.76 px", !cv.sizeNote && cv.canvasNote === "the game's 639×295 canvas, scaled to the 852×393 pt screen (contain, 1.3322 pt per canvas px, 0.36 pt bars left and right): canvas px = (inset pt − bar) ÷ 1.3322" && cv.px.left === 44.02 && cv.px.bottom === 15.76 && /0.75 px per pt/.test(cf.sizeNote) && /game's own canvas/.test(cf.sizeNote), [cv.canvasNote, cv.px, cf.sizeNote]);
  const mw = safePreset("iphone-portrait", 1290, 2796);
  ok("iphone-portrait on a 1290 px wide shot: warned (3.28 px per pt) and pointed at iphone-max-portrait", /3\.28 px per pt/.test(mw.sizeNote) && /--safe iphone-max-portrait/.test(mw.sizeNote), mw);
  const p16 = safePreset("iphone-16-pro-portrait", 1206, 2622);
  ok("iphone-16-pro-portrait at @3x: top 62 pt = 186 px", p16.px.top === 186 && p16.px.bottom === 102, p16);
  ok("iphone-portrait on a landscape shot: flagged", /landscape \(1280×720\) but iphone-portrait is portrait/.test(safePreset("iphone-portrait", 1280, 720).mismatch));
  ok("iphone-se follows the shot: portrait top 20 pt (×2 = 40 px at 750×1334), landscape none", safePreset("iphone-se", 750, 1334).px.top === 40 && Object.values(safePreset("iphone-se", 1334, 750).px).every((v) => v === 0));
  ok("ipad landscape 2360×1640: top 24 pt = 48 px, bottom 20 pt = 40 px", (() => { const q = safePreset("ipad", 2360, 1640); return q.px.top === 48 && q.px.bottom === 40 && q.orientation === "landscape"; })());
  ok("unknown preset: a clear error", (() => { try { safePreset("pixel-8", 1, 1); return false; } catch (e) { return /iphone-portrait, iphone-landscape, .*iphone-safari-portrait, .*iphone-se, ipad/.test(e.message); } })());
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
  // labels that repeat on purpose: two BUY buttons, BUY text inside buttons, three LOCKED tiles, two LOCKED cards
  const shop = normalizeUI([
    { id: "b1", kind: "button", rect: [10, 10, 40, 16], text: "BUY" }, { id: "b2", kind: "button", rect: [10, 40, 40, 16], text: "BUY" },
    { id: "c1", kind: "button", rect: [60, 10, 40, 16] }, { id: "t1", kind: "text", rect: [62, 12, 30, 10], text: "SELL" },
    { id: "c2", kind: "button", rect: [60, 40, 40, 16] }, { id: "t2", kind: "text", rect: [62, 42, 30, 10], text: "SELL" },
    { id: "l1", kind: "text", rect: [120, 10, 40, 10], text: "LOCKED" }, { id: "l2", kind: "text", rect: [170, 10, 40, 10], text: "LOCKED" }, { id: "l3", kind: "text", rect: [220, 10, 40, 10], text: "LOCKED" },
    { id: "card1", kind: "panel", rect: [120, 40, 50, 30] }, { id: "k1", kind: "text", rect: [125, 50, 40, 10], text: "SOLD OUT" },
    { id: "card2", kind: "panel", rect: [180, 40, 50, 30] }, { id: "k2", kind: "text", rect: [185, 50, 40, 10], text: "SOLD OUT" },
  ]);
  ok("duplicateTexts: two BUY buttons, SELL labels in buttons, 3 LOCKED tiles, SOLD OUT on two same-size cards: none", duplicateTexts(shop).length === 0, duplicateTexts(shop));
  const mk = (f, list) => ({ f, els: normalizeUI(list) });
  const toast = { id: "toast", kind: "text", text: "Quest updated", rect: [100, 20, 90, 12] };
  const samples = [];
  for (let f = 0; f <= 600; f += 6) samples.push(mk(f, (f >= 60 && f <= 180) || (f >= 300 && f <= 360) || f >= 594 ? [toast] : []));
  const tl = textTimeline(samples);
  ok("textTimeline: three showings f60-f180, f300-f360, f594-f600", tl.get("id:toast").shows.map((s) => `${s.f0}-${s.f1}`).join() === "60-180,300-360,594-600");
  const rep = repeatedTexts(tl, { within: 5, fps: 60 });
  ok("repeatedTexts within 5 s: again at f300, 4 s after it first showed, hidden 2 s; f594 is 4.9 s after f300", rep.length === 2 && rep[0].again.f0 === 300 && rep[0].sinceStart === 4 && rep[0].hidden === 2 && rep[1].sinceStart === 4.9, rep);
  ok("repeatedTexts within 3 s: none", repeatedTexts(tl, { within: 3, fps: 60 }).length === 0);
  // a HUD value that returns to an earlier value while the element stays on screen is not a repeated toast
  const hp = [];
  for (let f = 0; f < 180; f += 6) hp.push(mk(f, [{ id: "hp", kind: "text", text: f < 60 || f >= 120 ? "HP 10" : "HP 9", rect: [4, 4, 40, 10] }]));
  ok("repeatedTexts: HP 10 → HP 9 → HP 10 on one element is no repeat", repeatedTexts(textTimeline(hp), { within: 10, fps: 60 }).length === 0, [...textTimeline(hp).values()]);
  // the same element hiding and coming back with another text is no repeat either; with the same text it is
  const sw = [];
  for (let f = 0; f < 240; f += 6) sw.push(mk(f, f < 60 ? [{ ...toast, text: "SAVED" }] : f >= 120 && f < 180 ? [{ ...toast, text: "LEVEL UP" }] : []));
  ok("repeatedTexts: a toast id showing SAVED then LEVEL UP is no repeat", repeatedTexts(textTimeline(sw), { within: 10, fps: 60 }).length === 0);
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
  ok("no plate over sand: most of the right half's glyph edges are under 4.5 (share > 10%: a real failure)", r.edge.underShare > 0.1 && r.edge.under > 3 && r.edge.need === 4.5, r.edge);
  // white strokes over a busy navy / dark-grass world: fine. ONE pale pixel (a flower) touching a stroke makes the
  // worst edge 1.27:1, but p10 and the share under 4.5 stay: one bad pixel isn't unreadable text
  const navy = [20, 24, 60], dgrass = [30, 60, 30];
  const busy = img(120, 30, navy); rect(busy, 60, 0, 60, 30, dgrass);
  const bb = text(busy, "WEARY", 36, 7, white);
  const clean = plateCheck(busy, bb);
  let fx = -1, fy = -1;
  for (let y = bb.y; y < bb.y + bb.h && fx < 0; y++) for (let x = bb.x + 1; x < bb.x + bb.w; x++) { const o = (y * 120 + x) * 4, q = o - 4; if (busy.data[o] === navy[0] && busy.data[o + 2] === navy[2] && busy.data[q] === 240) { fx = x; fy = y; break; } }
  put(busy, fx, fy, [225, 215, 170]);
  const one = plateCheck(busy, bb);
  show("one pale pixel", `clean worst ${clean.edge.worst} p10 ${clean.edge.p10}; with it worst ${one.edge.worst} p10 ${one.edge.p10} under ${one.edge.under}/${one.edge.n}`);
  ok("one pale pixel next to a stroke: worst drops, but 1 edge of " + one.edge.n + " is under 4.5 (share ≤ 10%), p10 unchanged", clean.busy && clean.edge.under === 0 && one.edge.worst < 1.5 && one.edge.under <= 2 && one.edge.underShare <= 0.1 && one.edge.p10 === clean.edge.p10, one.edge);
}

// ---- a village with a HUD and no state.ui: world sprites are not text (trees, houses, villagers, flowers, tufts,
// path stones); the 3 real text rows are
function village() {
  const im = img(320, 180, [60, 140, 60]);
  let s = 5;
  const rnd = (n) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
  for (let gy = 20; gy < 176; gy += 9) for (let gx = 4; gx < 316; gx += 11) { const x = gx + rnd(5), y = gy + rnd(4); rect(im, x, y, 2 + rnd(2), 2, [40, 105, 40]); }   // grass tufts on a jittered grid
  for (let i = 0; i < 18; i++) { const x = 10 + rnd(300), y = 30 + rnd(140), c = [[220, 60, 60], [240, 220, 70], [240, 240, 255]][i % 3]; put(im, x, y, c); put(im, x - 1, y, c); put(im, x + 1, y, c); put(im, x, y - 1, c); put(im, x, y + 1, c); }   // flowers
  for (let i = 0; i < 9; i++) rect(im, 20 + i * 12 + rnd(3), 120 + rnd(2), 6 + rnd(3), 4, [150, 150, 140]);   // path stones in a row
  const tree = (x, y) => { for (let j = 0; j < 14; j++) for (let i = 0; i < 14; i++) if ((i - 6.5) ** 2 + (j - 6.5) ** 2 <= 49) put(im, x + i, y + j, [20, 80 + ((i * j) % 3) * 10, 30]); rect(im, x + 6, y + 14, 3, 5, [110, 70, 30]); };
  for (const [x, y] of [[200, 40], [217, 42], [234, 39], [251, 41]]) tree(x, y);   // a row of trees
  const house = (x, y) => { rect(im, x, y + 8, 28, 16, [210, 180, 130]); for (let j = 0; j < 9; j++) rect(im, x + 13 - j * 1.6, y + j, 2 + j * 3.2, 1, [170, 50, 40]); rect(im, x + 11, y + 14, 6, 10, [90, 60, 30]); rect(im, x + 3, y + 12, 5, 4, [120, 170, 220]); rect(im, x + 20, y + 12, 5, 4, [120, 170, 220]); };
  house(40, 60); house(76, 62); house(112, 59);
  const npc = (x, y, shirt) => { rect(im, x + 2, y, 4, 4, [240, 200, 160]); rect(im, x + 1, y + 4, 6, 5, shirt); rect(im, x + 2, y + 9, 2, 3, [60, 50, 120]); rect(im, x + 5, y + 9, 2, 3, [60, 50, 120]); };
  npc(160, 100, [200, 40, 40]); npc(171, 101, [40, 90, 200]); npc(182, 99, [230, 200, 50]);   // villagers side by side
  rect(im, 4, 4, 92, 30, [20, 20, 30]);   // the HUD plate
  const hp = text(im, "HP 10/10", 8, 2, [255, 255, 255]), gold = text(im, "GOLD 25", 8, 17, [255, 220, 80]);
  const title = text(im, "OAKVALE", 230, 2, [255, 255, 255]);   // a place name straight on the grass
  return { im, want: [hp, gold, title] };
}
{
  const { im, want } = village();
  const { rows } = findTextRows(im);
  show("village rows", rows.map((r) => `${r.x},${r.y} ${r.w}×${r.h} ${r.glyphs}g`).join(" · "));
  ok("village: exactly the 3 text rows (HP, GOLD, OAKVALE), no world sprites", rows.length === 3 && want.every((b) => rows.some((r) => r.x === b.x && r.y === b.y && r.w === b.w && r.h === b.h)), rows.map((r) => [r.x, r.y, r.w, r.h, r.glyphs]));
}

done("ui");
