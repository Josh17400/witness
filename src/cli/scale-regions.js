// Mixed-scale pictures for `measure scale` and `doctor`: named rects read one by one (--rect, --scale-rect), the
// automatic split into regions with one pixel grid each (media scaleRegions), and names for those regions from the
// game's state.layers [{name, rect}] (or its state.ui elements).
import { die } from "./common.js";

const fx2 = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
/** "×5", "×4.11", "×4.11 × 4.02" (x and y apart when they differ by more than 0.005). */
export const fmtScale = (s) => {
  const [x, y] = s;
  if (x == null && y == null) return "no scale";
  if (x == null || y == null) return `×${fx2(x ?? y)} (${x == null ? "y" : "x"} only)`;
  return Math.abs(x - y) > 0.005 ? `×${fx2(x)} × ${fx2(y)}` : `×${fx2(x)}`;
};
export const pct = (share) => `${Math.round(share * 1000) / 10}%`;
const boxTxt = (r) => `${r.x},${r.y} ${r.w}×${r.h}`;

/** "x,y,w,h" or "name=x,y,w,h", several separated by ";" → [{name, rect}]. */
export function parseNamedRects(s, what = "--rect") {
  return String(s).split(";").map((p) => p.trim()).filter(Boolean).map((p, i) => {
    const m = /^([^=]+)=(.*)$/.exec(p);
    const v = (m ? m[2] : p).split(",").map(Number);
    if (v.length !== 4 || v.some((x) => !Number.isFinite(x)) || v[2] <= 0 || v[3] <= 0) die(`${what} is x,y,w,h or name=x,y,w,h, several separated by ";" (got ${p})`);
    return { name: m ? m[1].trim() : `rect ${i + 1}`, rect: { x: v[0], y: v[1], w: v[2], h: v[3] } };
  });
}

/** Layers from a game state in canvas pixels: state.layers [{name, rect: [x,y,w,h] | {x,y,w,h}}], else state.ui
 *  elements (each named by its id, as layer "UI"). Returns [{name, rect, from}] (empty: none). */
export function stateLayers(state) {
  const R = (r) => (Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) ? { x: r[0], y: r[1], w: r[2], h: r[3] } : r && [r.x, r.y, r.w, r.h].every(Number.isFinite) ? { x: r.x, y: r.y, w: r.w, h: r.h } : null);
  if (state && Array.isArray(state.layers)) return state.layers.map((l, i) => ({ name: String(l && (l.name || l.id) || `layer ${i + 1}`), rect: R(l && l.rect), from: "state.layers" })).filter((l) => l.rect && l.rect.w > 0 && l.rect.h > 0);
  if (state && Array.isArray(state.ui)) return state.ui.map((e) => ({ name: "UI", id: e && e.id, rect: R(e && e.rect), from: "state.ui" })).filter((l) => l.rect && l.rect.w > 0 && l.rect.h > 0);
  return [];
}

/** Layers scaled from canvas pixels to picture pixels (a device-pixel capture of the canvas is k× larger). */
export const scaleLayers = (layers, kx, ky) => layers.map((l) => ({ ...l, rect: { x: l.rect.x * kx, y: l.rect.y * ky, w: l.rect.w * kx, h: l.rect.h * ky } }));

/** A region's name: the smallest layer holding 60%+ of it (state.ui: any element inside it names it "UI"). */
export function nameRegions(res, layers) {
  const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return res.regions.map((r) => {
    if (!layers.length) return null;
    if (layers[0].from === "state.ui") {
      const ids = layers.filter((l) => inter(l.rect, r.rect) >= 0.6 * l.rect.w * l.rect.h).map((l) => l.id).filter(Boolean);
      return ids.length ? `UI (${ids.slice(0, 3).join(", ")}${ids.length > 3 ? ", …" : ""})` : null;
    }
    const hold = layers.filter((l) => inter(l.rect, r.rect) >= 0.6 * r.rect.w * r.rect.h).sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h);
    return hold.length ? hold[0].name : null;
  });
}

/** One line for the groups: "world ×5 (whole, 78.8% of the picture) · UI ×4.11 (fractional, 21.2%)". */
export function groupsLine(res, names) {
  return res.groups.map((g, k) => {
    const nm = [...new Set(g.regions.map((i) => names[i]).filter(Boolean))].join("/");
    return `${nm ? `${nm} ` : ""}${fmtScale(g.scale)} (${g.whole ? "whole" : g.fractional ? "fractional" : "unscaled"}, ${pct(g.share)}${k === 0 ? " of the picture" : ""}${g.regions.length > 1 ? `, ${g.regions.length} areas` : ""})`;
  }).join(" · ");
}

/** Lines per region: "  ×4.11 at 0,473 1000×127 (21.2%): one source pixel is 4 or 5 px (11% are 5)". */
export function regionLines(res, names, indent = "  ") {
  return res.regions.map((r, i) => `${indent}${names[i] ? `${names[i]} ` : ""}${fmtScale(r.scale)} at ${boxTxt(r.rect)} (${pct(r.share)}${r.rectangular ? "" : ", not a rectangle: its box"}): ${evenTxt(r)}`);
}
const evenTxt = (r) => {
  if (r.whole) return `whole: every source pixel is ${r.scale.filter((v) => v != null).map((v) => `${v}`).join("×")} px`;
  const ax = [0, 1].filter((a) => r.single[a] && r.single[a].length === 2).map((a) => `${r.single[a][0]} or ${r.single[a][1]} px ${a ? "tall" : "wide"} (${Math.round(r.longShare[a] * 100)}% are ${r.single[a][1]})`);
  return ax.length ? `uneven: one source pixel is ${ax.join(", ")}` : "not a whole number";
};

/** One rect read on its own: runs of one colour (any scale), confirmed cell by cell when whole. */
export function readRect(m, img, rect, tolerance = 0) {
  const runs = m.pixelRuns(img, { region: rect, tolerance });
  const [sx, sy] = runs.scale;
  const k = sx != null && Number.isInteger(sx) && (sy == null || sy === sx) && sx > 1 ? sx : null;
  const block = k ? m.blockScale(img, k, { region: rect, tolerance }) : null;
  const exact = !!block && !block.blurry && !runs.fractional;
  return { rect: runs.region, scale: runs.scale, exact, k, fractional: runs.fractional, blurry: runs.blurry || !!(block && block.blurry), single: [runs.x.single, runs.y.single], longShare: [runs.x.longShare, runs.y.longShare], nonUniformPercent: block ? block.nonUniformPercent : null, softPercent: runs.softPercent, smearPercent: runs.smearPercent };
}

/** "×5 exact: every 5×5 cell one colour" / "×4.11 FRACTIONAL: one source pixel is 4 or 5 px wide (11% are 5) …" */
export function rectVerdict(r) {
  if (r.exact) return [true, `exact ×${r.k}: every ${r.k}×${r.k} cell is one colour`];
  if (r.blurry) return [false, `BLURRY (${r.nonUniformPercent != null ? `${r.nonUniformPercent}% of ${r.k}×${r.k} cells mixed, ` : ""}${r.smearPercent}% of hard edges smeared)`];
  if (r.fractional) return [false, `FRACTIONAL ${fmtScale(r.scale)}: ${evenTxt({ ...r, whole: false })}`];
  if (r.scale[0] == null && r.scale[1] == null) return [true, "no pixel grid read (too few one-pixel details)"];
  return [true, `${fmtScale(r.scale)}${r.k ? ` (${r.nonUniformPercent}% of ${r.k}×${r.k} cells mixed)` : ""}`];
}
