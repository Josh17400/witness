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
//
// Rects are screen pixels, [x, y) to [x + w, y + h).

import { contrast, labOf } from "./measure.js";
import { components } from "./track.js";
import { backgroundPalette } from "./align.js";

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
  const mx = typeof safe === "object" ? safe.x : safe * width, my = typeof safe === "object" ? safe.y : safe * height;
  const out = { margins: { x: r2(mx), y: r2(my) }, minText: r2(minText), clipped: [], offscreen: [], unsafe: [], overlaps: [], small: [], aligned: [] };
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
    const into = { left: mx - e.x, right: e.x + e.w - (width - mx), top: my - e.y, bottom: e.y + e.h - (height - my) };
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
