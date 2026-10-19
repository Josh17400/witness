// Witness media: UI layout checks (witness measure ui).
//
//   normalizeUI(list)                          -> [{ id, kind, x, y, w, h, text, fontPx, layer }] from the state.ui
//                                                 convention ({id, kind, rect: [x, y, w, h], text?, fontPx?, layer?});
//                                                 throws on a malformed entry
//   layoutChecks(els, { width, height, safe, minText, alignTol })
//        -> { margins, minText, clipped, offscreen, unsafe, overlaps, small, aligned }   (geometry only)
//   textContrast(img, rect)                    -> { ratio, deltaE, fg, bg, fgCount, bgCount, outline? } | null (one
//                                                 flat colour): the rect's pixels split in two colour groups (2-means
//                                                 in Lab), the smaller one is the text; only each group's core pixels
//                                                 (closer to their own centre than a third of the gap) are compared, so
//                                                 anti-aliased edges don't dilute the ratio. A third colour hugging the
//                                                 text (an outline) is measured too: ratio is then the stronger edge,
//                                                 text vs outline or outline vs background (outline has all three).
//   findTextRows(img, { threshold, minGlyphs }) -> text-like rows (no state.ui): [{ x, y, w, h, glyphs, glyphPx }]
//                                                 and panel-like solid rects: { rows, panels }
//   SAFE_PRESETS, safePreset(name, W, H)      -> per-side safe-area margins of a phone/tablet (env(safe-area-inset-*)
//                                                 in points, scaled to the screenshot): { px: { left, right, top,
//                                                 bottom }, insetsPt, zones, scale, mismatch }
//   duplicateTexts(els, { width, height })     -> the same text shown twice at once: [{ text, ids, rects }]
//   pixelDuplicates(img, rows)                 -> pixel text rows with near-identical ink: [{ a, b, iou }]
//   textTimeline(samples) / repeatedTexts(timeline, { within, fps })
//                                              -> when each text shows and hides over a sweep; texts that show
//                                                 again within `within` seconds (a repeated toast)
//   plateCheck(img, rect, { pad })             -> text over the world without a backing plate: is the background
//                                                 around the glyphs busy, and the worst contrast over the glyph edge
//
// Rects are screen pixels, [x, y) to [x + w, y + h).

import { contrast, labOf } from "./measure.js";
import { components } from "./track.js";
import { backgroundPalette } from "./align.js";
import { clusterColors, contrastRatio, deltaE } from "./color.js";

const r2 = (v) => Math.round(v * 100) / 100;
const KINDS = new Set(["text", "button", "panel", "icon"]);

export function normalizeUI(list) {
  if (!Array.isArray(list)) throw new TypeError("state.ui must be an array of { id, kind, rect: [x, y, w, h] }");
  return list.map((e, i) => {
    const r = Array.isArray(e?.rect) ? e.rect : e && "x" in e ? [e.x, e.y, e.w, e.h] : null;
    if (!r || r.length !== 4 || r.some((v) => !Number.isFinite(+v))) throw new TypeError(`state.ui[${i}]${e?.id != null ? ` (${e.id})` : ""}: rect must be [x, y, w, h] numbers`);
    const kind = KINDS.has(e.kind) ? e.kind : e.text != null ? "text" : "panel";
    return {
      id: String(e.id ?? `ui${i}`), kind, x: +r[0], y: +r[1], w: Math.max(0, +r[2]), h: Math.max(0, +r[3]),
      text: e.text != null ? String(e.text) : null, fontPx: Number.isFinite(+e.fontPx) && e.fontPx != null ? +e.fontPx : null,
      layer: e.layer ?? 0, hidden: !!e.hidden,
    };
  }).filter((e) => !e.hidden);
}

const inter = (a, b) => {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
};
const contains = (a, b) => b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;

/**
 * Geometry checks. safe: fraction of each dimension kept clear at every edge (0.05 = 5%), or { x, y } px.
 * minText: px. alignTol: edges this close (but at least alignMin apart) count as "almost aligned"; alignEdges limits
 * the edges compared (left, right, centre-x, top, bottom, centre-y), alignKinds the kinds of element.
 *   clipped:   partly past a screen edge   { id, past: { left, right, top, bottom }, visiblePercent }
 *   offscreen: entirely outside the screen { id }
 *   unsafe:    on screen but inside the safe margin  { id, into: { left, ... } } (px into the margin)
 *   overlaps:  same layer, intersecting, neither inside the other (a panel or button may hold others) { a, b, rect, area }
 *   small:     fontPx (else the rect height, marked estimated) below minText { id, fontPx, estimated }
 *   aligned:   pairs with edges 0 < Δ ≤ alignTol  { a, b, edges: [{ edge, a, b, diff }] }
 */
export function layoutChecks(els, { width, height, safe = 0.05, minText = 8, alignTol = 3, alignEdges = null, alignMin = 0.5, alignKinds = null } = {}) {
  // safe: a fraction, { x, y } px, or per side { left, right, top, bottom } px (a device preset: safePreset)
  const sides = typeof safe === "object" && "left" in safe;
  const mx = sides ? safe.left : typeof safe === "object" ? safe.x : safe * width, my = sides ? safe.top : typeof safe === "object" ? safe.y : safe * height;
  const S = sides ? { left: safe.left, right: safe.right, top: safe.top, bottom: safe.bottom } : { left: mx, right: mx, top: my, bottom: my };
  const out = { margins: { x: r2(mx), y: r2(my), ...(sides ? { left: r2(S.left), right: r2(S.right), top: r2(S.top), bottom: r2(S.bottom) } : {}) }, minText: r2(minText), clipped: [], offscreen: [], unsafe: [], overlaps: [], small: [], aligned: [] };
  const screen = { x: 0, y: 0, w: width, h: height };
  const onScreen = new Set();
  for (const e of els) {
    if (!(e.w > 0 && e.h > 0)) continue;
    const vis = inter(e, screen);
    if (!vis) { out.offscreen.push({ id: e.id }); continue; }
    onScreen.add(e);
    const past = { left: Math.max(0, -e.x), right: Math.max(0, e.x + e.w - width), top: Math.max(0, -e.y), bottom: Math.max(0, e.y + e.h - height) };
    if (past.left || past.right || past.top || past.bottom) {
      out.clipped.push({ id: e.id, past: Object.fromEntries(Object.entries(past).filter(([, v]) => v > 0).map(([k, v]) => [k, r2(v)])), visiblePercent: r2((100 * vis.w * vis.h) / (e.w * e.h)) });
      continue;
    }
    const into = { left: S.left - e.x, right: e.x + e.w - (width - S.right), top: S.top - e.y, bottom: e.y + e.h - (height - S.bottom) };
    const sides = Object.entries(into).filter(([, v]) => v > 1e-9).map(([k, v]) => [k, r2(v)]);
    if (sides.length) out.unsafe.push({ id: e.id, into: Object.fromEntries(sides) });
  }
  for (const e of els) {
    if (e.kind !== "text" && e.fontPx == null) continue;
    if (e.kind !== "text" && !e.text) continue;
    const px = e.fontPx ?? e.h;
    if (px < minText) out.small.push({ id: e.id, fontPx: px, estimated: e.fontPx == null });
  }
  const list = els.filter((e) => onScreen.has(e));
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    const nested = contains(a, b) || contains(b, a);
    if (String(a.layer) === String(b.layer)) {
      const r = inter(a, b);
      const holder = contains(a, b) ? a : contains(b, a) ? b : null;
      if (r && !(holder && (holder.kind === "panel" || holder.kind === "button"))) out.overlaps.push({ a: a.id, b: b.id, rect: [r.x, r.y, r.w, r.h], area: r2(r.w * r.h) });
    }
    if (nested || (alignKinds && !(alignKinds.includes(a.kind) && alignKinds.includes(b.kind)))) continue;
    const E = (e) => ({ left: e.x, right: e.x + e.w, "centre-x": e.x + e.w / 2, top: e.y, bottom: e.y + e.h, "centre-y": e.y + e.h / 2 });
    const ea = E(a), eb = E(b), edges = [];
    for (const k of alignEdges || Object.keys(ea)) { const d = Math.abs(ea[k] - eb[k]); if (d >= alignMin && d <= alignTol) edges.push({ edge: k, a: r2(ea[k]), b: r2(eb[k]), diff: r2(d) }); }
    if (edges.length) out.aligned.push({ a: a.id, b: b.id, edges });
  }
  return out;
}

/** Contrast of the text inside a rect against its background (see the header). null when the rect is one colour. */
export function textContrast(img, rect) {
  const W = img.width, H = img.height, d = img.data;
  const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(W, Math.ceil(rect.x + rect.w)), y1 = Math.min(H, Math.ceil(rect.y + rect.h));
  if (x1 <= x0 || y1 <= y0) return null;
  const idx = [], labs = [];
  const cache = new Map();
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * W + x, o = i * 4, k = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
    let lab = cache.get(k);
    if (!lab) { lab = labOf(d[o], d[o + 1], d[o + 2]); cache.set(k, lab); }
    idx.push(i); labs.push(lab);
  }
  // 2-means in Lab, seeded with the darkest and the lightest pixel
  let lo = 0, hi = 0;
  labs.forEach((l, i) => { if (l[0] < labs[lo][0]) lo = i; if (l[0] > labs[hi][0]) hi = i; });
  let c = [labs[lo].slice(), labs[hi].slice()];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  if (dist(c[0], c[1]) < 3) {
    // no lightness spread: seed with the colour farthest from the first pixel
    let far = 0; labs.forEach((l, i) => { if (dist(l, labs[0]) > dist(labs[far], labs[0])) far = i; });
    c = [labs[0].slice(), labs[far].slice()];
    if (dist(c[0], c[1]) < 3) return null;
  }
  const lab = new Uint8Array(labs.length);
  for (let it = 0; it < 12; it++) {
    const s = [[0, 0, 0, 0], [0, 0, 0, 0]];
    labs.forEach((l, i) => { const g = dist(l, c[0]) <= dist(l, c[1]) ? 0 : 1; lab[i] = g; s[g][0] += l[0]; s[g][1] += l[1]; s[g][2] += l[2]; s[g][3]++; });
    if (!s[0][3] || !s[1][3]) return null;
    const n = s.map((v) => [v[0] / v[3], v[1] / v[3], v[2] / v[3]]);
    const moved = dist(n[0], c[0]) + dist(n[1], c[1]);
    c = n;
    if (moved < 1e-6) break;
  }
  const gap = dist(c[0], c[1]);
  if (gap < 3) return null;
  const n0 = lab.reduce((s, g) => s + (g === 0 ? 1 : 0), 0), fgGroup = n0 <= labs.length - n0 ? 0 : 1;
  const fg = new Uint8Array(W * H), bg = new Uint8Array(W * H);
  let fgCount = 0, bgCount = 0;
  labs.forEach((l, i) => {
    const g = lab[i];
    if (dist(l, c[g]) > gap / 3) return;
    if (g === fgGroup) { fg[idx[i]] = 1; fgCount++; } else { bg[idx[i]] = 1; bgCount++; }
  });
  if (!fgCount || !bgCount) return null;
  const r = contrast(img, fg, bg);
  const res = { ratio: r.ratio, deltaE: r.deltaE, fg: r.meanA.slice(0, 3).map(Math.round), bg: r.meanB.slice(0, 3).map(Math.round), fgCount, bgCount };
  // an outline (a third colour hugging the text: black around yellow letters): pixels in neither core that are far
  // from the text-background line in Lab (so not anti-aliased edges between the two). The glyph edge the eye reads
  // is then text vs outline or outline vs background, whichever is stronger.
  const c0 = c[fgGroup], c1 = c[1 - fgGroup], v = [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]], vv = gap * gap;
  const ol = new Uint8Array(W * H);
  let olCount = 0, hugging = 0;
  labs.forEach((l, i) => {
    if (fg[idx[i]] || bg[idx[i]]) return;
    const t = Math.max(0, Math.min(1, ((l[0] - c0[0]) * v[0] + (l[1] - c0[1]) * v[1] + (l[2] - c0[2]) * v[2]) / vv));
    if (dist(l, [c0[0] + t * v[0], c0[1] + t * v[1], c0[2] + t * v[2]]) <= gap / 3) return;
    ol[idx[i]] = 1; olCount++;
  });
  if (olCount >= Math.max(8, 0.25 * fgCount)) {
    for (let i = 0; i < W * H; i++) {
      if (!ol[i]) continue;
      const x = i % W, y = (i - x) / W;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && fg[yy * W + xx]) near = true; }
      if (near) hugging++;
    }
    if (hugging >= 0.5 * olCount) {
      const to = contrast(img, fg, ol), ob = contrast(img, ol, bg);
      res.outline = { color: to.meanB.slice(0, 3).map(Math.round), count: olCount, textVsOutline: to.ratio, outlineVsBg: ob.ratio, plainRatio: r.ratio };
      res.ratio = Math.max(to.ratio, ob.ratio);
    }
  }
  return res;
}

/**
 * Text-like rows found from pixels alone (the fallback when the game has no state.ui): small components that differ
 * from the background (the picture's background palette, and inside solid panels the panel's own colour), grouped
 * into rows of at least minGlyphs components of similar height that sit side by side. glyphPx is the row's tallest
 * glyph after dropping outliers (the cap height for capitals). Rows of 1 px bars (fences) and of identical shapes (a
 * row of hearts or coins) are not text. Also returns the solid panels it looked inside.
 */
export function findTextRows(img, { threshold = 24, minGlyphs = 3 } = {}) {
  const W = img.width, H = img.height, d = img.data;
  const near = (o, c) => Math.abs(d[o] - c[0]) <= threshold && Math.abs(d[o + 1] - c[1]) <= threshold && Math.abs(d[o + 2] - c[2]) <= threshold;
  const pal = backgroundPalette(img);
  const mask = new Uint8Array(W * H);
  for (let i = 0, o = 0; i < W * H; i++, o += 4) if (!pal.some((c) => near(o, c))) mask[i] = 1;
  let comps = components(mask, W, H, { minPixels: 1 });
  const panels = [], glyphs = [];
  for (const c of comps) {
    const b = c.bbox;
    // a solid rect (a panel, a button): look for glyphs inside it against its own most common colour
    if (b.w >= 12 && b.h >= 8 && c.count >= 0.9 * b.w * b.h) {
      panels.push({ x: b.x, y: b.y, w: b.w, h: b.h });
      const counts = new Map();
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) { const o = (y * W + x) * 4; const k = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2]; counts.set(k, (counts.get(k) || 0) + 1); }
      const top = [...counts].sort((p, q) => q[1] - p[1])[0][0], pc = [top >> 16, (top >> 8) & 255, top & 255];
      const inner = new Uint8Array(W * H);
      for (let y = b.y + 1; y < b.y + b.h - 1; y++) for (let x = b.x + 1; x < b.x + b.w - 1; x++) { const i = y * W + x; if (mask[i] && !near(i * 4, pc)) inner[i] = 1; }
      glyphs.push(...components(inner, W, H, { region: { x: b.x + 1, y: b.y + 1, w: b.w - 2, h: b.h - 2 }, minPixels: 1 }));
      continue;
    }
    glyphs.push(c);
  }
  const cand = glyphs.filter((g) => g.bbox.h >= 2 && g.bbox.h <= 64 && g.bbox.w <= 3 * g.bbox.h + 2).map((g) => ({ ...g.bbox, count: g.count })).sort((a, b) => a.x - b.x);
  // union glyphs that sit side by side on a line
  const parent = cand.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  // candidates are sorted by x over the whole screen: stop at a bound that doesn't depend on the candidate (1.3x the
  // tallest glyph allowed), so a small shape elsewhere on screen can't end the search before a's real neighbour
  for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
    const a = cand[i], b = cand[j];
    const gap = b.x - (a.x + a.w);
    if (gap > 1.3 * 64) break;
    const h = Math.max(a.h, b.h);
    if (gap > 1.3 * h) continue;   // a word space after punctuation still joins; a double space splits
    const ov = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ov >= 0.5 * Math.min(a.h, b.h) && Math.max(a.h, b.h) <= 2.5 * Math.min(a.h, b.h)) parent[find(j)] = find(i);
  }
  const groups = new Map();
  cand.forEach((c, i) => { const r = find(i); groups.set(r, (groups.get(r) || []).concat(c)); });
  const rows = [];
  for (const g of groups.values()) {
    if (g.length < minGlyphs || g.filter((c) => c.w <= 1).length * 2 >= g.length) continue;   // mostly 1 px bars: a fence or planks, not letters
    if (g.every((c) => c.w === g[0].w && c.h === g[0].h && c.count === g[0].count)) continue;   // identical shapes: a row of icons (hearts, coins)
    const hs = g.map((c) => c.h).sort((a, b) => a - b), med = hs[hs.length >> 1];
    const glyphPx = Math.max(...hs.filter((h) => h <= 1.5 * med));
    const x0 = Math.min(...g.map((c) => c.x)), y0 = Math.min(...g.map((c) => c.y));
    const x1 = Math.max(...g.map((c) => c.x + c.w)), y1 = Math.max(...g.map((c) => c.y + c.h));
    rows.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, glyphs: g.length, glyphPx });
  }
  rows.sort((a, b) => a.y - b.y || a.x - b.x);
  return { rows, panels };
}

// ---------------------------------------------------------------------------
// device safe areas
// ---------------------------------------------------------------------------

/**
 * env(safe-area-inset-*) in CSS points, as WebKit reports them for a full-screen page (viewport-fit=cover, a Home
 * Screen web app with a black-translucent status bar): the UIKit safeAreaInsets of each device. iPhone 14 Pro, 15,
 * 15 Pro, 16 and 16 Plus (Dynamic Island, 393×852 pt @3x): portrait top 59 (status bar + island), bottom 34 (home
 * indicator); landscape left and right 59 (the island may be on either side), bottom 21. iPhone 16 Pro / Pro Max
 * report 62 instead of 59; notched iPhones 12–14 report 47 (the X / 11 Pro: 44). iPhone SE 2/3 (Touch ID, 375×667 pt
 * @2x): the 20 pt status bar in portrait, nothing in landscape. iPad (10th gen) / iPad Air 11" (no Home button,
 * 820×1180 pt @2x): top 24 (status bar), bottom 20 (home indicator) in both orientations.
 */
export const SAFE_PRESETS = {
  "iphone-portrait": { device: "iPhone 14 Pro/15/16 (Dynamic Island)", dpr: 3, only: "portrait", portrait: { pt: [393, 852], insets: { top: 59, bottom: 34, left: 0, right: 0 } } },
  "iphone-landscape": { device: "iPhone 14 Pro/15/16 (Dynamic Island)", dpr: 3, only: "landscape", landscape: { pt: [852, 393], insets: { top: 0, bottom: 21, left: 59, right: 59 } } },
  "iphone-se": { device: "iPhone SE 2nd/3rd gen (Home button)", dpr: 2, portrait: { pt: [375, 667], insets: { top: 20, bottom: 0, left: 0, right: 0 } }, landscape: { pt: [667, 375], insets: { top: 0, bottom: 0, left: 0, right: 0 } } },
  ipad: { device: "iPad 10th gen / iPad Air 11-inch (no Home button)", dpr: 2, portrait: { pt: [820, 1180], insets: { top: 24, bottom: 20, left: 0, right: 0 } }, landscape: { pt: [1180, 820], insets: { top: 24, bottom: 20, left: 0, right: 0 } } },
};
const ZONES = {
  "iphone-portrait": { top: "status bar + Dynamic Island", bottom: "home indicator" },
  "iphone-landscape": { left: "Dynamic Island / rounded corner", right: "Dynamic Island / rounded corner", bottom: "home indicator" },
  "iphone-se": { top: "status bar" },
  ipad: { top: "status bar", bottom: "home indicator" },
};

/** A preset's insets for a W×H screenshot (the screenshot fills the device screen: each axis scaled on its own). */
export function safePreset(name, W, H) {
  const p = SAFE_PRESETS[name];
  if (!p) throw new RangeError(`safe-area preset is ${Object.keys(SAFE_PRESETS).join(", ")} or a percentage (got ${name})`);
  const orientation = p.only || (W > H ? "landscape" : "portrait");
  const o = p[orientation], sx = W / o.pt[0], sy = H / o.pt[1];
  const I = o.insets;
  const px = { left: I.left * sx, right: I.right * sx, top: I.top * sy, bottom: I.bottom * sy };
  let mismatch = null;
  if (p.only && (W > H) !== (orientation === "landscape")) mismatch = `the screenshot is ${W > H ? "landscape" : "portrait"} (${W}×${H}) but ${name} is ${orientation}`;
  else if (Math.abs(W / H / (o.pt[0] / o.pt[1]) - 1) > 0.03) mismatch = `the screenshot's aspect ${r2(W / H)} is not the device's ${r2(o.pt[0] / o.pt[1])} (${o.pt[0]}×${o.pt[1]} pt): insets scaled per axis (${r2(sx)} px/pt across, ${r2(sy)} down)`;
  const zones = Object.fromEntries(Object.entries(ZONES[name]).filter(([k]) => I[k] > 0));
  return { name, device: p.device, orientation, pt: o.pt, dpr: p.dpr, insetsPt: { ...I }, devicePx: Object.fromEntries(Object.entries(I).map(([k, v]) => [k, v * p.dpr])), scale: { x: r2(sx), y: r2(sy) }, px: Object.fromEntries(Object.entries(px).map(([k, v]) => [k, r2(v)])), zones, mismatch };
}

// ---------------------------------------------------------------------------
// the same text twice
// ---------------------------------------------------------------------------

export const normText = (s) => String(s).trim().replace(/\s+/g, " ").toLowerCase();
const meaningful = (k) => k.length >= 3 && /\p{L}/u.test(k);
const visibleIn = (e, W, H) => e.w > 0 && e.h > 0 && e.x < W && e.y < H && e.x + e.w > 0 && e.y + e.h > 0;

/**
 * Visible elements showing the same text (trimmed, case and spacing ignored; at least 3 characters with a letter),
 * leaving out an element that sits inside another of the group (a button and its own label listed twice).
 */
export function duplicateTexts(els, { width = Infinity, height = Infinity } = {}) {
  const groups = new Map();
  for (const e of els) {
    if (e.text == null || !visibleIn(e, width, height)) continue;
    const k = normText(e.text);
    if (!meaningful(k)) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const out = [];
  for (const g of groups.values()) {
    // drop an element inside another of the group (for identical rects keep the first)
    const keep = g.filter((e, i) => !g.some((o, j) => j !== i && contains(o, e) && (!contains(e, o) || j < i)));
    if (keep.length > 1) out.push({ text: keep[0].text, ids: keep.map((e) => e.id), rects: keep.map((e) => [e.x, e.y, e.w, e.h]) });
  }
  return out;
}

/** The ink of a rect: pixels differing by more than `threshold` (any channel) from the rect's most common colour. */
function inkOf(img, r, threshold) {
  const W = img.width, d = img.data, counts = new Map();
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { const o = (y * W + x) * 4, k = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2]; counts.set(k, (counts.get(k) || 0) + 1); }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0][0], c = [top >> 16, (top >> 8) & 255, top & 255];
  const ink = new Set();
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const o = (y * W + x) * 4;
    if (Math.abs(d[o] - c[0]) > threshold || Math.abs(d[o + 1] - c[1]) > threshold || Math.abs(d[o + 2] - c[2]) > threshold) ink.add((y - r.y) * 4096 + (x - r.x));
  }
  return ink;
}

/** Pixel text rows of about the same size whose ink matches (IoU ≥ minIoU at a shift of up to 1 px): [{ a, b, iou }]. */
export function pixelDuplicates(img, rows, { threshold = 24, minIoU = 0.95 } = {}) {
  const inks = rows.map((r) => inkOf(img, r, threshold));
  const out = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i], b = rows[j];
    if (Math.abs(a.w - b.w) > 1 || Math.abs(a.h - b.h) > 1 || !inks[i].size || !inks[j].size) continue;
    let best = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      let both = 0;
      for (const p of inks[i]) { const y = Math.floor(p / 4096) + dy, x = (p % 4096) + dx; if (inks[j].has(y * 4096 + x)) both++; }
      best = Math.max(best, both / (inks[i].size + inks[j].size - both));
    }
    if (best >= minIoU) out.push({ a, b, iou: r2(best) });
  }
  return out;
}

/**
 * samples: [{ f, els }] in frame order (els: normalized UI elements). Returns Map(text key -> { text, shows: [{ f0,
 * f1, id, rect }] }): a show starts when the text is visible at a sample and was not at the one before.
 */
export function textTimeline(samples, { width = Infinity, height = Infinity } = {}) {
  const tl = new Map();
  let prev = new Set();
  for (const s of samples) {
    const now = new Set();
    for (const e of s.els) {
      if (e.text == null || !visibleIn(e, width, height)) continue;
      const k = normText(e.text);
      if (!meaningful(k) || now.has(k)) continue;
      now.add(k);
      if (!tl.has(k)) tl.set(k, { text: e.text, shows: [] });
      const shows = tl.get(k).shows;
      if (prev.has(k)) shows[shows.length - 1].f1 = s.f;
      else shows.push({ f0: s.f, f1: s.f, id: e.id, rect: [e.x, e.y, e.w, e.h] });
    }
    prev = now;
  }
  return tl;
}

/** Texts shown again within `within` s of their previous showing's start: [{ text, first, again, sinceStart, hidden }]. */
export function repeatedTexts(tl, { within = 10, fps = 60 } = {}) {
  const out = [];
  for (const { text, shows } of tl.values()) for (let i = 1; i < shows.length; i++) {
    const a = shows[i - 1], b = shows[i], since = (b.f0 - a.f0) / fps;
    if (since <= within + 1e-9) out.push({ text, first: a, again: b, sinceStart: r2(since), hidden: r2((b.f0 - a.f1) / fps), shows: shows.length });
  }
  return out.sort((x, y) => x.again.f0 - y.again.f0);
}

// ---------------------------------------------------------------------------
// text without a plate
// ---------------------------------------------------------------------------

/**
 * Text drawn straight over the world: the text colour is the colour cluster (ΔE ≤ 10) that sits inside the rect but
 * not in the `pad` px around it, in thin strokes (most of its pixels touch another colour). The background is every
 * other pixel of the rect + pad: busy when its most common colour cluster covers under 80% of it. Every glyph edge
 * (a text pixel and its 4-neighbour background pixel; an anti-aliased in-between pixel is skipped for the one
 * behind it) gives one WCAG ratio: worst / p10 / median / best, where the worst one is and the colours there.
 * null when no text colour stands out.
 */
export function plateCheck(img, rect, { pad = 2, tol = 10 } = {}) {
  const W = img.width, H = img.height, d = img.data;
  const ix0 = Math.max(0, Math.floor(rect.x)), iy0 = Math.max(0, Math.floor(rect.y)), ix1 = Math.min(W, Math.ceil(rect.x + rect.w)), iy1 = Math.min(H, Math.ceil(rect.y + rect.h));
  if (ix1 <= ix0 || iy1 <= iy0) return null;
  const ox0 = Math.max(0, ix0 - pad), oy0 = Math.max(0, iy0 - pad), ox1 = Math.min(W, ix1 + pad), oy1 = Math.min(H, iy1 + pad);
  const bw = ox1 - ox0, bh = oy1 - oy0, keys = new Int32Array(bw * bh), inside = new Uint8Array(bw * bh);
  const counts = new Map();
  for (let y = oy0; y < oy1; y++) for (let x = ox0; x < ox1; x++) {
    const o = (y * W + x) * 4, k = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2], j = (y - oy0) * bw + (x - ox0);
    keys[j] = k; inside[j] = x >= ix0 && x < ix1 && y >= iy0 && y < iy1 ? 1 : 0;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const { clusters, of } = clusterColors(counts, tol);
  const cl = Int32Array.from(keys, (k) => of.get(k));
  const nIn = (ix1 - ix0) * (iy1 - iy0), nRing = bw * bh - nIn;
  const inC = new Float64Array(clusters.length), ringC = new Float64Array(clusters.length), edgy = new Float64Array(clusters.length);
  for (let j = 0; j < keys.length; j++) {
    if (!inside[j]) { ringC[cl[j]]++; continue; }
    inC[cl[j]]++;
    const x = j % bw, y = (j - x) / bw;
    if ((x > 0 && cl[j - 1] !== cl[j]) || (x < bw - 1 && cl[j + 1] !== cl[j]) || (y > 0 && cl[j - bw] !== cl[j]) || (y < bh - 1 && cl[j + bw] !== cl[j])) edgy[cl[j]]++;
  }
  let text = -1, best = 0;
  for (let c = 0; c < clusters.length; c++) {
    if (inC[c] < 3) continue;
    const score = (inC[c] / nIn - (nRing ? ringC[c] / nRing : 0)) * (edgy[c] / inC[c]);
    if (score > best) { best = score; text = c; }
  }
  if (text < 0) return null;
  const isText = (j) => inside[j] === 1 && cl[j] === text;
  const rgbOf = (k) => [k >> 16, (k >> 8) & 255, k & 255];
  // the background: everything else
  const bgCounts = new Map();
  let bgN = 0;
  for (let j = 0; j < keys.length; j++) { if (isText(j)) continue; bgN++; bgCounts.set(cl[j], (bgCounts.get(cl[j]) || 0) + 1); }
  if (!bgN) return null;
  const bgSorted = [...bgCounts.values()].sort((a, b) => b - a);
  const bgShare = bgSorted[0] / bgN;
  const majorList = [...bgCounts].filter(([, n]) => n >= 0.1 * bgN).sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const major = new Set();
  // glyph edges
  const labs = new Map();
  const labK = (k) => { let v = labs.get(k); if (!v) { v = labOf(k >> 16, (k >> 8) & 255, k & 255); labs.set(k, v); } return v; };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  /** How far colour n is from the Lab segment t→q (Infinity unless it lies strictly between them). */
  const between = (t, n, q) => {
    const A = labK(t), N = labK(n), Q = labK(q), v = [Q[0] - A[0], Q[1] - A[1], Q[2] - A[2]], vv = v[0] ** 2 + v[1] ** 2 + v[2] ** 2;
    if (vv < 1) return Infinity;
    const s = ((N[0] - A[0]) * v[0] + (N[1] - A[1]) * v[1] + (N[2] - A[2]) * v[2]) / vv;
    if (s <= 0 || s >= 1) return Infinity;
    const off = dist(N, [A[0] + s * v[0], A[1] + s * v[1], A[2] + s * v[2]]);
    return off <= Math.max(4, 0.15 * Math.sqrt(vv)) ? off : Infinity;
  };
  // a main background colour lying between the text colour and a bigger main one is an anti-aliased rim, not ground
  for (const c of majorList) if (![...major].some((m) => between(clusters[text].key, clusters[c].key, clusters[m].key) < Infinity)) major.add(c);
  const pairs = [];
  for (let j = 0; j < keys.length; j++) {
    if (!isText(j)) continue;
    const x = j % bw, y = (j - x) / bw;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
      const n = ny * bw + nx;
      if (isText(n)) continue;
      // an anti-aliased pixel (its colour between the text's and a main background colour's) stands for that colour
      let b = keys[n];
      if (!major.has(cl[n])) {
        let bestD = Infinity;
        for (const c of major) { const dd = between(keys[j], keys[n], clusters[c].key); if (dd < bestD) { bestD = dd; b = clusters[c].key; } }
      }
      pairs.push({ r: contrastRatio(rgbOf(keys[j]), rgbOf(b)), t: keys[j], b, x: ox0 + nx, y: oy0 + ny });
    }
  }
  if (!pairs.length) return null;
  const rs = pairs.map((p) => p.r).sort((a, b) => a - b);
  const worst = pairs.reduce((a, p) => (p.r < a.r ? p : a));
  const q = (f) => rs[Math.min(rs.length - 1, Math.round(f * (rs.length - 1)))];
  return {
    text: clusters[text].color.map(Math.round), textPixels: inC[text], background: bgN, bgShare: r2(bgShare), bgColors: bgSorted.filter((n) => n >= 0.1 * bgN).length,
    busy: bgShare < 0.8,
    edge: { n: pairs.length, worst: r2(rs[0]), p10: r2(q(0.1)), median: r2(q(0.5)), best: r2(rs[rs.length - 1]), worstDeltaE: r2(deltaE(rgbOf(worst.t), rgbOf(worst.b))), at: [worst.x, worst.y], textAt: rgbOf(worst.t), bgAt: rgbOf(worst.b) },
  };
}
