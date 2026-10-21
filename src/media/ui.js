// Witness media: UI layout checks (witness measure ui).
//
//   normalizeUI(list)                          -> [{ id, kind, x, y, w, h, text, fontPx, layer, tap, hit, scroll,
//                                                 parent, clip, fill }] from the state.ui convention ({id, kind,
//                                                 rect: [x, y, w, h], text?, fontPx?, layer?, tap?, role?, hit?,
//                                                 scroll?, parent?, clip?, fill?}); throws on a malformed entry
//   scaleUI(els, { kx, ky, ox, oy })           -> the same elements mapped to screenshot px (x' = ox + x * kx)
//   tapTargets(els, { minX, minY })            -> tappable elements (kind button, tap: true, role button) whose hit
//                                                 box (hit, else rect) is under the minimum: [{ id, w, h }]
//   layoutChecks(els, { width, height, safe, minText, alignTol })
//        -> { margins, minText, clipped, offscreen, unsafe, overlaps, small, aligned, scrolled }   (geometry only;
//           scrolled: elements cut by their scroll container, not reported as clipped / off screen)
//   textContrast(img, rect)                    -> { ratio, deltaE, fg, bg, fgCount, bgCount, outline?, unreliable? } | null (one
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
//                                              -> when each element (by id) shows and hides over a sweep; elements
//                                                 that come back with the same text within `within` s (a toast)
//   plateCheck(img, rect, { pad, need })       -> text over the world without a backing plate: is the background
//                                                 around the glyphs busy, the glyph-edge contrasts, the share under need
//
// Rects are screen pixels, [x, y) to [x + w, y + h).

import { contrast, labOf } from "./measure.js";
import { components } from "./track.js";
import { backgroundPalette } from "./align.js";
import { clusterColors, contrastRatio, deltaE } from "./color.js";

const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;
const KINDS = new Set(["text", "button", "panel", "icon"]);

export function normalizeUI(list) {
  if (!Array.isArray(list)) throw new TypeError("state.ui must be an array of { id, kind, rect: [x, y, w, h] }");
  return list.map((e, i) => {
    const r = Array.isArray(e?.rect) ? e.rect : e && "x" in e ? [e.x, e.y, e.w, e.h] : null;
    if (!r || r.length !== 4 || r.some((v) => !Number.isFinite(+v))) throw new TypeError(`state.ui[${i}]${e?.id != null ? ` (${e.id})` : ""}: rect must be [x, y, w, h] numbers`);
    const kind = KINDS.has(e.kind) ? e.kind : e.text != null ? "text" : "panel";
    const rectOf = (v, what) => {
      if (v == null) return null;
      const q = Array.isArray(v) ? v : typeof v === "object" && "x" in v ? [v.x, v.y, v.w ?? v.width, v.h ?? v.height] : null;
      if (!q || q.length !== 4 || q.some((n) => !Number.isFinite(+n))) throw new TypeError(`state.ui[${i}]${e?.id != null ? ` (${e.id})` : ""}: ${what} must be [x, y, w, h] numbers`);
      return { x: +q[0], y: +q[1], w: Math.max(0, +q[2]), h: Math.max(0, +q[3]) };
    };
    const role = e.role != null ? String(e.role).toLowerCase() : null;
    const fill = e.fill != null ? String(e.fill).toLowerCase() : e.gradient ? "gradient" : e.textFill != null && /transparent/i.test(String(e.textFill)) ? "gradient" : null;
    const scroll = e.scroll === true ? "both" : ["x", "y", "both"].includes(e.scroll) ? e.scroll : null;
    return {
      id: String(e.id ?? `ui${i}`), autoId: e.id == null, kind, x: +r[0], y: +r[1], w: Math.max(0, +r[2]), h: Math.max(0, +r[3]),
      text: e.text != null ? String(e.text) : null, fontPx: Number.isFinite(+e.fontPx) && e.fontPx != null ? +e.fontPx : null,
      layer: e.layer ?? 0, hidden: !!e.hidden,
      // tappable: a button, or anything marked tap: true / role "button" | "link" | "tab" | "checkbox" ...
      tap: e.tap === false ? false : e.tap === true || kind === "button" || (role != null && /^(button|link|tab|checkbox|radio|switch|menuitem|option)$/.test(role)),
      hit: rectOf(e.hit, "hit"), scroll, parent: e.parent != null ? String(e.parent) : e.in != null ? String(e.in) : null, clip: rectOf(e.clip, "clip"),
      fill: fill && /gradient|transparent|clip|image/.test(fill) ? "gradient" : null,
    };
  }).filter((e) => !e.hidden);
}

/** Elements mapped into screenshot px: x' = ox + x * kx, y' = oy + y * ky (rects, hit boxes, clips; fontPx × ky). */
export function scaleUI(els, { kx = 1, ky = kx, ox = 0, oy = 0 } = {}) {
  if (kx === 1 && ky === 1 && !ox && !oy) return els;
  const R = (q) => (q ? { x: r4(ox + q.x * kx), y: r4(oy + q.y * ky), w: r4(q.w * kx), h: r4(q.h * ky) } : q);
  return els.map((e) => ({ ...e, ...R(e), fontPx: e.fontPx != null ? r4(e.fontPx * ky) : null, hit: R(e.hit), clip: R(e.clip) }));
}

/**
 * Where each element is cut by a scroll container: Map id -> { rect (the visible window), container (id | null) }.
 * An element's own clip rect wins; else its parent chain up to a scroll: true element; else (only for elements that
 * leave such a container's rect along its scroll axis while staying inside it across) the nearest such container.
 */
export function scrollClips(els) {
  const byId = new Map(els.map((e) => [e.id, e])), out = new Map();
  const scrollers = els.filter((e) => e.scroll && e.w > 0 && e.h > 0);
  for (const e of els) {
    if (e.clip) { out.set(e.id, { rect: e.clip, container: e.parent }); continue; }
    let p = e.parent ? byId.get(e.parent) : null, guard = 0, clip = null, container = null;
    while (p && guard++ < 64) {
      if (p.scroll || p.clip) { const r = p.clip ? (inter(p, p.clip) || { ...p.clip, w: 0, h: 0 }) : p; clip = clip ? (inter(clip, r) || { x: r.x, y: r.y, w: 0, h: 0 }) : r; container = container || p.id; }
      p = p.parent ? byId.get(p.parent) : null;
    }
    if (clip) { out.set(e.id, { rect: clip, container }); continue; }
    if (e.scroll || e.parent) continue;   // a container itself, or an element placed under a non-scrolling parent
    let best = null;
    for (const s of scrollers) {
      if (s === e || contains(e, s)) continue;
      const ax = s.scroll === "x" || s.scroll === "both", ay = s.scroll === "y" || s.scroll === "both";
      const inX = e.x >= s.x - 1 && e.x + e.w <= s.x + s.w + 1, inY = e.y >= s.y - 1 && e.y + e.h <= s.y + s.h + 1;
      if (inX && inY) { if (!best || s.w * s.h < best.w * best.h) best = s; continue; }   // inside it: clipped by it if it scrolls
      const outY = !inY && ay && inX, outX = !inX && ax && inY;
      if ((outY || outX) && (!best || s.w * s.h < best.w * best.h)) best = s;
    }
    if (best) out.set(e.id, { rect: best, container: best.id, guessed: true });
  }
  return out;
}

/**
 * Tappable elements (e.tap) whose hit box (e.hit, else the rect) is smaller than minX × minY px. A tappable inside
 * another tappable is skipped (a button in a clickable tile: one target, counted once). Skips: hidden (ids in skip).
 */
export function tapTargets(els, { minX = 44, minY = minX, skip = null } = {}) {
  const taps = els.filter((e) => e.tap && !(skip && skip.has(e.id))).map((e) => ({ e, b: e.hit || e }));
  const out = [];
  for (const t of taps) {
    if (!(t.b.w > 0 && t.b.h > 0)) continue;
    if (taps.some((o) => o !== t && contains(o.b, t.b) && !(contains(t.b, o.b) && taps.indexOf(o) > taps.indexOf(t)))) continue;
    if (t.b.w + 1e-6 < minX || t.b.h + 1e-6 < minY) out.push({ id: t.e.id, w: r2(t.b.w), h: r2(t.b.h), hit: !!t.e.hit });
  }
  return out;
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
  const out = { margins: { x: r2(mx), y: r2(my), ...(sides ? { left: r2(S.left), right: r2(S.right), top: r2(S.top), bottom: r2(S.bottom) } : {}) }, minText: r2(minText), clipped: [], offscreen: [], unsafe: [], overlaps: [], small: [], aligned: [], scrolled: [] };
  const screen = { x: 0, y: 0, w: width, h: height };
  const onScreen = new Set();
  const clips = scrollClips(els);
  for (const e of els) {
    if (!(e.w > 0 && e.h > 0)) continue;
    // inside a scroll container: what lies outside its window is scrolled away, not clipped or off screen
    const c = clips.get(e.id);
    if (c && !contains(c.rect, e) && !(c.guessed && contains(screen, e))) {
      const v = inter(inter(e, c.rect) || { x: 0, y: 0, w: 0, h: 0 }, screen);
      out.scrolled.push({ id: e.id, container: c.container, visible: v ? [r2(v.x), r2(v.y), r2(v.w), r2(v.h)] : null, visiblePercent: v ? r2((100 * v.w * v.h) / (e.w * e.h)) : 0, ...(c.guessed ? { guessed: true } : {}) });
      continue;
    }
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
  // gradient text (background-clip: text, a fill that changes across the glyphs): the "text colour" is a mean of
  // many colours, so the ratio means little. The ink (everything not background core) changes colour steadily with
  // position: one channel follows x or y closely (R² ≥ 0.5) over 40+ levels. Anti-aliasing and outlines don't.
  const grad = inkGradient(img, labs, idx, lab, fgGroup, bg, W);
  if (grad) res.unreliable = { why: "gradient text", axis: grad.axis, channel: grad.channel, r2: grad.r2, range: grad.range };
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

/** The strongest linear trend of an ink colour channel over x or y: { axis, channel, r2, range } when R² ≥ 0.5 and the
 *  fitted colour changes 40+ levels across the ink, else null. */
function inkGradient(img, labs, idx, lab, fgGroup, bgCore, W) {
  const d = img.data, pts = [];
  for (let i = 0; i < idx.length; i++) if (lab[i] === fgGroup && !bgCore[idx[i]]) pts.push(idx[i]);
  if (pts.length < 24) return null;
  let best = null;
  for (const axis of ["x", "y"]) {
    const pos = pts.map((p) => (axis === "x" ? p % W : (p - (p % W)) / W));
    const n = pts.length, mp = pos.reduce((s, v) => s + v, 0) / n;
    const vp = pos.reduce((s, v) => s + (v - mp) ** 2, 0);
    if (vp <= 0) continue;
    const lo = Math.min(...pos), hi = Math.max(...pos);
    for (let ch = 0; ch < 3; ch++) {
      const cv = pts.map((p) => d[p * 4 + ch]), mc = cv.reduce((s, v) => s + v, 0) / n;
      let sxy = 0, vc = 0;
      for (let k = 0; k < n; k++) { sxy += (pos[k] - mp) * (cv[k] - mc); vc += (cv[k] - mc) ** 2; }
      if (vc <= 0) continue;
      const rr = (sxy * sxy) / (vp * vc), range = Math.abs((sxy / vp) * (hi - lo));
      if (rr >= 0.5 && range >= 40 && (!best || rr > best.r2)) best = { axis, channel: "rgb"[ch], r2: r2(rr), range: Math.round(range) };
    }
  }
  return best;
}

/**
 * Text-like rows found from pixels alone (the fallback when the game has no state.ui): small components that differ
 * from the background (the picture's background palette, and inside solid panels the panel's own colour), grouped
 * into rows of at least minGlyphs components of similar height that sit side by side. glyphPx is the row's tallest
 * glyph after dropping outliers (the cap height for capitals). Rows of 1 px bars (fences) and of identical shapes (a
 * row of hearts or coins) are not text. Also returns the solid panels it looked inside.
 */
/**
 * Did the ink inside rect move with the world between two frames (a sign or sprite scrolled by the camera, not HUD)?
 * Ink = pixels unlike the background palette of img. Static (80%+ of the ink unchanged in place) → null; else the
 * shift within ±range px (not 0,0) where 90%+ of it matches → { dx, dy }; else null (changed in place: animated, or
 * HUD text that changed).
 */
export const backgroundPaletteOf = (img) => backgroundPalette(img);

export function worldMotion(img, other, rect, { threshold = 24, range = 32, palette = null } = {}) {
  if (!other || other.width !== img.width || other.height !== img.height) return null;
  const W = img.width, H = img.height, a = img.data, b = other.data, pal = palette || backgroundPalette(img);
  const near = (o, c) => Math.abs(a[o] - c[0]) <= threshold && Math.abs(a[o + 1] - c[1]) <= threshold && Math.abs(a[o + 2] - c[2]) <= threshold;
  const ink = [];
  for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) { const o = (y * W + x) * 4; if (x >= 0 && y >= 0 && x < W && y < H && !pal.some((c) => near(o, c))) ink.push([x, y, o]); }
  if (!ink.length) return null;
  const share = (dx, dy) => {
    let n = 0;
    for (const [x, y, o] of ink) {
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const q = (Y * W + X) * 4;
      if (Math.abs(a[o] - b[q]) <= threshold && Math.abs(a[o + 1] - b[q + 1]) <= threshold && Math.abs(a[o + 2] - b[q + 2]) <= threshold) n++;
    }
    return n / ink.length;
  };
  if (share(0, 0) >= 0.8) return null;
  let best = null;
  for (let dy = -range; dy <= range; dy++) for (let dx = -range; dx <= range; dx++) {
    if (!dx && !dy) continue;
    const v = share(dx, dy);
    if (v >= 0.9 && (!best || v > best.v)) best = { dx, dy, v };
  }
  return best ? { dx: best.dx, dy: best.dy } : null;
}

/** Median over a shape's ink pixels of the shorter of the horizontal and vertical ink runs through it (px). */
function strokeWidth(mask, W, b) {
  const hr = new Uint16Array(b.w * b.h), out = [];
  for (let y = 0; y < b.h; y++) {
    let x = 0;
    while (x < b.w) {
      if (!mask[(b.y + y) * W + b.x + x]) { x++; continue; }
      let e = x;
      while (e < b.w && mask[(b.y + y) * W + b.x + e]) e++;
      for (let k = x; k < e; k++) hr[y * b.w + k] = e - x;
      x = e;
    }
  }
  for (let x = 0; x < b.w; x++) {
    let y = 0;
    while (y < b.h) {
      if (!mask[(b.y + y) * W + b.x + x]) { y++; continue; }
      let e = y;
      while (e < b.h && mask[(b.y + e) * W + b.x + x]) e++;
      for (let k = y; k < e; k++) out.push(Math.min(e - y, hr[k * b.w + x]));
      y = e;
    }
  }
  out.sort((a, c) => a - c);
  return out.length ? out[out.length >> 1] : 0;
}

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
      glyphs.push(...components(inner, W, H, { region: { x: b.x + 1, y: b.y + 1, w: b.w - 2, h: b.h - 2 }, minPixels: 1 }).map((g) => ({ ...g, src: inner })));
      continue;
    }
    glyphs.push({ ...c, src: mask });
  }
  const cand = glyphs.filter((g) => g.bbox.h >= 2 && g.bbox.h <= 64 && g.bbox.w <= 3 * g.bbox.h + 2).map((g) => ({ ...g.bbox, count: g.count, stroke: strokeWidth(g.src, W, g.bbox) })).sort((a, b) => a.x - b.x);
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
    // letters are strokes: their typical stroke (the shorter of the horizontal and vertical runs through each ink
    // pixel) is thin for their height; trees, houses, villagers and stones are filled shapes
    const strokes = g.map((c) => c.stroke).sort((a, b) => a - b), stroke = strokes[strokes.length >> 1];
    if (stroke > Math.max(2, 0.25 * glyphPx)) continue;
    // and they share a baseline: most glyph bottoms within 1 px of the row's (descenders and punctuation aside)
    const bots = g.map((c) => c.y + c.h).sort((a, b) => a - b), base = bots[bots.length >> 1];
    if (bots.filter((y) => Math.abs(y - base) <= 1).length * 2 < g.length) continue;
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
 * env(safe-area-inset-*) in CSS points, as WebKit reports them, per device and orientation (the UIKit safeAreaInsets).
 * The Home Screen presets assume a full-screen page (a web app added to the Home Screen, viewport-fit=cover, a
 * black-translucent status bar): that page draws under the status bar, the Dynamic Island and the home indicator.
 *   iphone-portrait / -landscape: iPhone 14 Pro, 15, 15 Pro, 16 (Dynamic Island, 393×852 pt @3x): portrait top 59
 *     (status bar + island), bottom 34 (home indicator); landscape left and right 59 (the island may be on either
 *     side), bottom 21.
 *   iphone-max-portrait / -landscape: iPhone 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus (430×932 pt @3x): the same insets.
 *   iphone-16-pro-portrait / -landscape (402×874 pt @3x) and iphone-16-pro-max-* (440×956 pt @3x): 62 instead of 59.
 *   iphone-safari-portrait / -landscape: an iPhone 15 Safari TAB (viewport 393×659 / 734×343 pt): the status bar and
 *     the toolbars are outside the page and a page without viewport-fit=cover is kept inside the safe area: no insets.
 *   iphone-se: iPhone SE 2nd/3rd gen (Touch ID, 375×667 pt @2x): the 20 pt status bar in portrait, nothing in landscape.
 *   ipad: iPad 10th gen / iPad Air 11" (no Home button, 820×1180 pt @2x): top 24 (status bar), bottom 20 (home
 *     indicator) in both orientations.
 * Not listed: notched iPhones X–14 (44–50 pt top: the 12/13 mini 50, the XR/11 48, the 12–14 47, the X/XS/11 Pro 44).
 */
const IPH = (top, side) => ({ portrait: { top, bottom: 34, left: 0, right: 0 }, landscape: { top: 0, bottom: 21, left: side, right: side } });
const DI = IPH(59, 59), DI62 = IPH(62, 62);
const family = (name, device, pt, ins) => ({
  [`${name}-portrait`]: { device, dpr: 3, only: "portrait", portrait: { pt, insets: ins.portrait } },
  [`${name}-landscape`]: { device, dpr: 3, only: "landscape", landscape: { pt: [pt[1], pt[0]], insets: ins.landscape } },
});
export const SAFE_PRESETS = {
  ...family("iphone", "iPhone 14 Pro/15/15 Pro/16 (Dynamic Island), Home Screen web app", [393, 852], DI),
  ...family("iphone-max", "iPhone 14 Pro Max/15 Plus/15 Pro Max/16 Plus (Dynamic Island), Home Screen web app", [430, 932], DI),
  ...family("iphone-16-pro", "iPhone 16 Pro (Dynamic Island), Home Screen web app", [402, 874], DI62),
  ...family("iphone-16-pro-max", "iPhone 16 Pro Max (Dynamic Island), Home Screen web app", [440, 956], DI62),
  "iphone-safari-portrait": { device: "iPhone 15, Safari tab (toolbars outside the page)", dpr: 3, only: "portrait", portrait: { pt: [393, 659], insets: { top: 0, bottom: 0, left: 0, right: 0 } } },
  "iphone-safari-landscape": { device: "iPhone 15, Safari tab (toolbars outside the page, no viewport-fit=cover)", dpr: 3, only: "landscape", landscape: { pt: [734, 343], insets: { top: 0, bottom: 0, left: 0, right: 0 } } },
  "iphone-se": { device: "iPhone SE 2nd/3rd gen (Home button)", dpr: 2, portrait: { pt: [375, 667], insets: { top: 20, bottom: 0, left: 0, right: 0 } }, landscape: { pt: [667, 375], insets: { top: 0, bottom: 0, left: 0, right: 0 } } },
  ipad: { device: "iPad 10th gen / iPad Air 11-inch (no Home button)", dpr: 2, portrait: { pt: [820, 1180], insets: { top: 24, bottom: 20, left: 0, right: 0 } }, landscape: { pt: [1180, 820], insets: { top: 24, bottom: 20, left: 0, right: 0 } } },
};
const ISLAND = { top: "status bar + Dynamic Island", bottom: "home indicator", left: "Dynamic Island / rounded corner", right: "Dynamic Island / rounded corner" };
const zoneName = (name, side) => (name === "iphone-se" || name === "ipad" ? { top: "status bar", bottom: "home indicator" }[side] : ISLAND[side]);
const FITS = ["contain", "cover", "stretch"];

/**
 * A preset's insets in screenshot px. The screenshot is the game's picture, shown on the device screen by `fit`:
 *   contain (default): one uniform scale, fitted inside the screen and centred (letterbox / pillarbox bars), as
 *     browsers and Emscripten show a canvas with its aspect kept; an inset that ends inside a bar costs nothing.
 *   cover: one uniform scale filling the screen, centred, the overflow cut off.
 *   stretch: each axis scaled on its own (the picture fills the screen exactly).
 * A screenshot with the device's aspect (within 3%) is the same under all three. Returns { px: {left, right, top,
 * bottom}, insetsPt, zones, fit, ptPerPx, bars: {x, y} (pt), mismatch, sizeNote, demote } — demote: stretched over a
 * different aspect, the numbers are a guess (callers warn instead of failing).
 */
export function safePreset(name, W, H, { fit = "contain", canvas = false } = {}) {
  const p = SAFE_PRESETS[name];
  if (!p) throw new RangeError(`safe-area preset is ${Object.keys(SAFE_PRESETS).join(", ")} or a percentage (got ${name})`);
  if (!FITS.includes(fit)) throw new RangeError(`--fit is ${FITS.join(", ")} (got ${fit})`);
  const orientation = p.only || (W > H ? "landscape" : "portrait");
  const o = p[orientation], [PW, PH] = o.pt;
  const I = o.insets;
  const aspectOff = Math.abs(W / H / (PW / PH) - 1) > 0.03;
  let px, ptPerPx, bars = { x: 0, y: 0 }, scale;
  if (fit === "stretch") {
    const sx = W / PW, sy = H / PH;
    px = { left: I.left * sx, right: I.right * sx, top: I.top * sy, bottom: I.bottom * sy };
    ptPerPx = { x: 1 / sx, y: 1 / sy };
    scale = { x: r2(sx), y: r2(sy) };
  } else {
    const f = fit === "contain" ? Math.min(PW / W, PH / H) : Math.max(PW / W, PH / H);   // pt per screenshot px
    bars = { x: (PW - W * f) / 2, y: (PH - H * f) / 2 };   // negative under cover: cut off
    const into = (inset, bar) => Math.max(0, inset - bar) / f;
    px = { left: into(I.left, bars.x), right: into(I.right, bars.x), top: into(I.top, bars.y), bottom: into(I.bottom, bars.y) };
    ptPerPx = { x: f, y: f };
    scale = { x: r2(1 / f), y: r2(1 / f) };
  }
  let mismatch = null, sizeNote = null, canvasNote = null;
  if (p.only && (W > H) !== (orientation === "landscape")) mismatch = `the screenshot is ${W > H ? "landscape" : "portrait"} (${W}×${H}) but ${name} is ${orientation}`;
  else if (aspectOff) {
    mismatch = fit === "stretch"
      ? `the screenshot's aspect ${r2(W / H)} is not the device's ${r2(PW / PH)} (${PW}×${PH} pt) and --fit stretch scales each axis on its own (${r2(1 / ptPerPx.x)} px/pt across, ${r2(1 / ptPerPx.y)} down): no browser shows a canvas like that, so safe-zone findings are warnings`
      : fit === "contain"
        ? `the screenshot's aspect ${r2(W / H)} is not the device's ${r2(PW / PH)} (${PW}×${PH} pt): assumed fitted inside the screen at ${r2(ptPerPx.x)} pt per px with ${bars.x > 0.005 ? `${r2(bars.x)} pt bars left and right` : `${r2(bars.y)} pt bars top and bottom`} (--fit cover|stretch if the game fills the screen another way)`
        : `the screenshot's aspect ${r2(W / H)} is not the device's ${r2(PW / PH)} (${PW}×${PH} pt): assumed filling the screen at ${r2(ptPerPx.x)} pt per px, ${bars.x < -0.005 ? `${r2(-bars.x)} pt cut off left and right` : `${r2(-bars.y)} pt cut off top and bottom`}`;
  } else {
    // the device's own aspect: a full-screen capture. Its px per pt should be a whole number (1 CSS px, or the DPR)
    const k = W / PW;
    if (canvas) {
      // the game's own (logical) canvas: any size is fine, the browser scales it to the screen
      if (Math.abs(k - Math.round(k)) > 0.01 * k) {
        const bar = fit === "stretch" ? null : bars.x > 0.005 ? ["left and right", bars.x] : bars.y > 0.005 ? ["top and bottom", bars.y] : null;
        canvasNote = `the game's ${W}×${H} canvas, scaled to the ${PW}×${PH} pt screen (${fit}${fit === "stretch" ? "" : `, ${r4(ptPerPx.x)} pt per canvas px${bar ? `, ${r2(bar[1])} pt bars ${bar[0]}` : ""}`}): canvas px = ${bar ? "(inset pt − bar)" : "inset pt"} ÷ ${fit === "stretch" ? "pt per px on that axis" : r4(ptPerPx.x)}`;
      }
    } else if (Math.abs(k - Math.round(k)) > 0.01 * k) {
      const other = Object.entries(SAFE_PRESETS).filter(([n]) => n !== name).map(([n, q]) => [n, q[orientation] || null]).find(([, q]) => q && [1, 2, 3].some((d) => W === q.pt[0] * d && Math.abs(H - q.pt[1] * d) <= d));
      sizeNote = `${W} px wide is ${r2(k)} px per pt: not a whole multiple of ${PW} pt, so this isn't a ${PW}×${PH} pt screen${other ? ` (it is ${other[1].pt.join("×")} pt at @${W / other[1].pt[0]}x: --safe ${other[0]})` : ""}; insets scaled to fit (fine if this is the game's own canvas, not a phone screenshot)`;
    }
  }
  const zones = Object.fromEntries(["top", "bottom", "left", "right"].filter((k) => I[k] > 0 && px[k] > 0).map((k) => [k, zoneName(name, k)]));
  return { name, device: p.device, orientation, pt: o.pt, dpr: p.dpr, fit, insetsPt: { ...I }, devicePx: Object.fromEntries(Object.entries(I).map(([k, v]) => [k, v * p.dpr])),
    scale, ptPerPx: { x: r4(ptPerPx.x), y: r4(ptPerPx.y) }, bars: { x: r2(bars.x), y: r2(bars.y) }, px: Object.fromEntries(Object.entries(px).map(([k, v]) => [k, r2(v)])), zones, mismatch, sizeNote, canvasNote, demote: fit === "stretch" && aspectOff };
}

// ---------------------------------------------------------------------------
// the same text twice
// ---------------------------------------------------------------------------

export const normText = (s) => String(s).trim().replace(/\s+/g, " ").toLowerCase();
const meaningful = (k) => k.length >= 3 && /\p{L}/u.test(k);
const visibleIn = (e, W, H) => e.w > 0 && e.h > 0 && e.x < W && e.y < H && e.x + e.w > 0 && e.y + e.h > 0;

/**
 * Visible text showing the same words twice at once (trimmed, case and spacing ignored; at least 3 characters with a
 * letter), leaving out what repeats on purpose: buttons and icons (two "BUY" buttons), text inside a button, an
 * element inside another of the group (a label listed twice), 3+ copies (a list or grid of "LOCKED" tiles), and
 * copies that each sit in their own panel of the same size (cards / tiles).
 */
export function duplicateTexts(els, { width = Infinity, height = Infinity } = {}) {
  const groups = new Map();
  const holders = els.filter((p) => p.kind === "panel" || p.kind === "button");
  const holder = (e, kinds) => holders.filter((p) => p !== e && kinds.includes(p.kind) && contains(p, e)).sort((a, b) => a.w * a.h - b.w * b.h)[0] || null;
  for (const e of els) {
    if (e.text == null || !visibleIn(e, width, height)) continue;
    if (e.kind === "button" || e.kind === "icon" || holder(e, ["button"])) continue;
    const k = normText(e.text);
    if (!meaningful(k)) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const out = [];
  for (const g of groups.values()) {
    // drop an element inside another of the group (for identical rects keep the first)
    const keep = g.filter((e, i) => !g.some((o, j) => j !== i && contains(o, e) && (!contains(e, o) || j < i)));
    if (keep.length !== 2) continue;   // 3+: a list or a grid of the same label
    const [pa, pb] = keep.map((e) => holder(e, ["panel"]));
    if (pa && pb && pa !== pb && Math.abs(pa.w - pb.w) <= 1 && Math.abs(pa.h - pb.h) <= 1) continue;   // two cards / tiles
    out.push({ text: keep[0].text, ids: keep.map((e) => e.id), rects: keep.map((e) => [e.x, e.y, e.w, e.h]) });
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
 * samples: [{ f, els }] in frame order (els: normalized UI elements). Returns Map(key -> { text, id, shows: [{ f0, f1,
 * id, rect, text }] }), one entry per element: its id (elements without one: per text). A show starts when the
 * element is visible with a text at a sample and was not at the one before; a text that changes while the element
 * stays ("HP 10" → "HP 9" → "HP 10") is one show (its text is the first one seen).
 */
export function textTimeline(samples, { width = Infinity, height = Infinity } = {}) {
  const tl = new Map();
  let prev = new Set();
  for (const s of samples) {
    const now = new Set();
    for (const e of s.els) {
      if (e.text == null || !visibleIn(e, width, height)) continue;
      const t = normText(e.text);
      if (!meaningful(t)) continue;
      const k = e.autoId ? `text:${t}` : `id:${e.id}`;
      if (now.has(k)) continue;
      now.add(k);
      if (!tl.has(k)) tl.set(k, { text: e.text, id: e.autoId ? null : e.id, shows: [] });
      const shows = tl.get(k).shows;
      if (prev.has(k)) shows[shows.length - 1].f1 = s.f;
      else shows.push({ f0: s.f, f1: s.f, id: e.id, rect: [e.x, e.y, e.w, e.h], text: e.text });
    }
    prev = now;
  }
  return tl;
}

/**
 * An element that disappeared and came back with the same text within `within` s of its previous showing's start
 * (a toast shown again): [{ text, id, first, again, sinceStart, hidden }]. Values that only change while the
 * element stays on screen are never repeats.
 */
export function repeatedTexts(tl, { within = 10, fps = 60 } = {}) {
  const out = [];
  for (const { id, shows } of tl.values()) for (let i = 1; i < shows.length; i++) {
    const a = shows[i - 1], b = shows[i], since = (b.f0 - a.f0) / fps;
    if (normText(a.text) !== normText(b.text)) continue;
    if (since <= within + 1e-9) out.push({ text: b.text, id, first: a, again: b, sinceStart: r2(since), hidden: r2((b.f0 - a.f1) / fps), shows: shows.length });
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
 * behind it) gives one WCAG ratio: worst / p10 / median / best, where the worst one is and the colours there, and
 * how many are under `need` (under, underShare). null when no text colour stands out.
 */
export function plateCheck(img, rect, { pad = 2, tol = 10, need = 4.5 } = {}) {
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
  const under = rs.filter((r) => r < need).length;
  return {
    text: clusters[text].color.map(Math.round), textPixels: inC[text], background: bgN, bgShare: r2(bgShare), bgColors: bgSorted.filter((n) => n >= 0.1 * bgN).length,
    busy: bgShare < 0.8,
    edge: { n: pairs.length, need, under, underShare: r2(under / pairs.length), worst: r2(rs[0]), p10: r2(q(0.1)), median: r2(q(0.5)), best: r2(rs[rs.length - 1]), worstDeltaE: r2(deltaE(rgbOf(worst.t), rgbOf(worst.b))), at: [worst.x, worst.y], textAt: rgbOf(worst.t), bgAt: rgbOf(worst.b) },
  };
}
