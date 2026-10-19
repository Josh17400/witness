// UI layout tests: `node tests/media/ui.mjs` — geometry checks on a planted layout, text contrast with anti-aliased
// edges, and text-like rows found from pixels alone (drawn with the embedded 8×16 font, so the glyph boxes are known).
import { normalizeUI, layoutChecks, textContrast, findTextRows } from "../../src/media/ui.js";
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

done("ui");
