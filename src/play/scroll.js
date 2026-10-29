// Witness play: scrolling. A page taller than the screen (a settings list under a fixed tab bar on a phone) hides
// choices a finger can't reach until the page moves. `scroll down|up [n]` / `scroll top|bottom` send wheel input
// (recorded, so replays scroll the same; the JS adapter scrolls the page under the pointer like a browser does),
// `scroll to <words>` brings one choice into the part of the screen no fixed bar covers: through the game's
// play.scroll call when it has one, else measured on the page (an eval that only reads the layout) and reached with
// wheel input, else from the choice's rect. The measurement also explains a pick that a bar covered.

/**
 * Runs in the page (serialized into an eval; must stay self-contained). a = {id?, label?} or {page: true}. Returns
 * the page's scroll position, and for a choice: where it is, the bars covering the screen's edges, what covers its
 * centre, how far to scroll so it sits mid-way between the bars, and a point over its scroller to wheel at.
 */
function measureInPage(a) {
  const d = document, vw = innerWidth, vh = innerHeight;
  const cs = (e) => getComputedStyle(e);
  const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();
  const labelOf = (e) => norm(e.getAttribute("aria-label") || e.innerText || e.textContent || e.getAttribute("title") || e.value || "");
  const name = (e) => { const t = norm(e.getAttribute("aria-label") || e.innerText || ""); return e.id ? `#${e.id}` : t ? `"${t.length > 30 ? `${t.slice(0, 29)}…` : t}"` : `<${e.tagName.toLowerCase()}>`; };
  const barOf = (e) => { for (let x = e; x && x.nodeType === 1; x = x.parentElement) { const p = cs(x).position; if (p === "fixed" || p === "sticky") return x; } return null; };
  const canScroll = (e) => { const o = cs(e).overflowY; return /(auto|scroll|overlay)/.test(o) && e.scrollHeight > e.clientHeight + 1; };
  const root = d.scrollingElement || d.documentElement;
  const scrollerOf = (e) => { for (let x = e && e.parentElement; x && x !== root && x !== d.body; x = x.parentElement) { if (canScroll(x)) return x; if (cs(x).position === "fixed") break; } return null; };
  // the page can't scroll when its root clips (html, or body when html is visible: overflow hidden|clip), as in a browser
  const rootOv = () => { const h = cs(d.documentElement).overflowY; return h !== "visible" || !d.body ? h : cs(d.body).overflowY; };
  const pos = (s) => (s ? { y: Math.round(s.scrollTop), max: Math.max(0, Math.round(s.scrollHeight - s.clientHeight)), h: s.clientHeight } : { y: Math.round(scrollY), max: /^(hidden|clip)$/.test(rootOv()) ? 0 : Math.max(0, Math.round(root.scrollHeight - vh)), h: vh });
  const canvas = !!d.querySelector("canvas");
  if (a.page) { const mid = d.elementFromPoint(vw / 2, vh / 2); return { page: true, ...pos(mid ? scrollerOf(mid) || (canScroll(mid) ? mid : null) : null), vw, vh, canvas }; }
  let el = null;
  if (typeof a.id === "string" && /^[A-Za-z][\w-]*$/.test(a.id)) el = d.getElementById(a.id);
  if (!el && a.label) {
    let want = norm(a.label).replace(/ \(selected\)$/, ""), k = 1;
    const m = / #(\d+)$/.exec(want);
    if (m) { k = +m[1]; want = want.slice(0, m.index); }
    const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest('[hidden], [aria-hidden="true"]'); };
    const pool = Array.from(d.querySelectorAll('button, [role="button"], a[href], input:not([type="hidden"]), select, textarea, [onclick], [tabindex], label')).filter(shown);
    let hits = pool.filter((e) => labelOf(e) === want);
    if (!hits.length) hits = pool.filter((e) => labelOf(e).startsWith(want));
    if (!hits.length) { hits = Array.from(d.body.querySelectorAll("*")).filter((e) => shown(e) && labelOf(e) === want); hits = hits.filter((e) => !hits.some((o) => o !== e && e.contains(o))); }
    if (!hits.length && want.length >= 3) { hits = Array.from(d.body.querySelectorAll("*")).filter((e) => shown(e) && labelOf(e).includes(want) && labelOf(e).length < want.length * 3 + 20); hits = hits.filter((e) => !hits.some((o) => o !== e && e.contains(o))); }
    el = hits[k - 1] || hits[0] || null;
  }
  if (!el) return { found: false, vw, vh, canvas };
  // the bars: short fixed / sticky things over the top and bottom edges, probed down the choice's column; a tall one
  // (a third of the screen or more, or over its middle: a dialog's backdrop) is an overlay scrolling can't clear
  const r = el.getBoundingClientRect(), cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2));
  const big = (e) => { const q = e.getBoundingClientRect(); return q.height >= vh / 3 || (q.top < vh / 2 && q.bottom > vh / 2); };
  let top = 0, bottom = 0, topBar = null, bottomBar = null;
  for (let y = 0; y < vh / 2; y += 4) { const h = d.elementFromPoint(cx, y), b = h && barOf(h); if (!b || el.contains(b) || b.contains(el) || big(b)) break; top = y + 4; topBar = b; }
  for (let y = vh - 1; y > vh / 2; y -= 4) { const h = d.elementFromPoint(cx, y), b = h && barOf(h); if (!b || el.contains(b) || b.contains(el) || big(b)) break; bottom = vh - y + 3; bottomBar = b; }
  const cy = r.top + r.height / 2, inside = cy >= 0 && cy < vh && cx >= 0 && cx < vw;
  const hit = inside ? d.elementFromPoint(cx, cy) : null;
  const clear = !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  const coverEl = inside && !clear && hit ? barOf(hit) || hit : null;
  const overlay = !!coverEl && coverEl !== topBar && coverEl !== bottomBar && big(coverEl);
  const where = cy < top ? "above" : cy >= vh - bottom ? "below" : null;
  const sc = scrollerOf(el), p = pos(sc);
  const goal = top + (vh - top - bottom) / 2;
  const dy = Math.round(cy - goal);
  // the least scrolling that brings it clear of the bars (8 px to spare): what a player would do
  const need = r.bottom > vh - bottom ? Math.round(r.bottom - (vh - bottom) + 8) : r.top < top ? -Math.round(top - r.top + 8) : 0;
  // wheel over the scroller (the page: mid-way between the bars), never over a bar
  let wx = vw / 2, wy = goal;
  if (sc) { const s = sc.getBoundingClientRect(); wx = s.left + s.width / 2; wy = Math.max(s.top + 2, Math.min(s.bottom - 2, goal)); }
  return {
    found: true, label: labelOf(el).slice(0, 60), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], vw, vh, canvas,
    inView: clear && r.top >= top - 1 && r.bottom <= vh - bottom + 1, clear, offscreen: !inside ? (cy < 0 ? "above" : "below") : null, where,
    coveredBy: coverEl ? (coverEl === topBar ? `the fixed bar at the top (${name(coverEl)})` : coverEl === bottomBar ? `the fixed bar at the bottom (${name(coverEl)})` : overlay ? `${name(coverEl)} (an overlay over the screen)` : name(coverEl)) : null, overlay,
    bars: { top, bottom }, dy, need, room: dy > 0 ? p.max - p.y : p.y, scroll: p, at: [Math.round(wx), Math.round(wy)],
  };
}

/** The eval expression measuring a choice ({id, label}) or, with {page: true}, the page's scroll position. */
export const measureExpr = (a) => `(${measureInPage.toString()})(${JSON.stringify(a)})`;

/** What to look for on the page for a choice: its DOM id when it has one (witness.dom.tappables), and its label. */
export const choiceTarget = (c) => ({ id: c.raw && typeof c.raw === "object" && c.raw.id != null ? String(c.raw.id) : null, label: c.label });

/** play.scroll: {call: "fn", args: ["id"|"label"|"index"|...], step: 200} | "call:fn" | "fn"; step = px per `scroll down 1`. */
export function parseScroll(s) {
  const out = { call: null, args: ["id"], step: 200 };
  if (s == null) return out;
  if (typeof s === "string") { out.call = s.replace(/^call:/i, "").trim() || null; return out; }
  if (typeof s === "object") {
    if (s.call) out.call = String(s.call);
    if (Array.isArray(s.args) && s.args.length) out.args = s.args.map(String);
    if (+s.step > 0) out.step = Math.round(+s.step);
  }
  return out;
}

/**
 * A tap the page refused because something else is on top, or because the target isn't on screen: a call's answer
 * like witness.dom.tap's "blocked by #tabs" / "blocked by nothing (off screen)" / "not found: …", or an {error}
 * saying so. Returns {what, offscreen} or null.
 */
export function blockedOf(v) {
  const s = typeof v === "string" ? v : v && typeof v === "object" && !Array.isArray(v) ? String(v.error || v.reason || v.message || "") : "";
  let m = /^\s*blocked by (.+)$/i.exec(s);
  if (m) return { what: m[1].trim(), offscreen: /off.?screen|^nothing/i.test(m[1]) };
  m = /\b(?:is )?(covered|obscured|hidden) by (.+)$/i.exec(s);
  if (m) return { what: m[2].trim(), offscreen: false };
  if (/\boff.?screen\b|\bnot (?:in view|visible|on screen)\b/i.test(s)) return { what: "nothing (off screen)", offscreen: true };
  return null;
}

/** How many `scroll down|up` steps (of `step` px) bring dy px of scrolling: at least 1. */
export const stepsFor = (dy, step) => Math.max(1, Math.ceil(Math.abs(dy) / Math.max(1, step)));

/**
 * The fix for a pick that couldn't land, in words: "covered by the fixed bar at the bottom (#tabs): scroll down 1
 * (or scroll to save), then pick again". m = a measurement (or null), blocked = blockedOf(...) (or null); without a
 * measurement, the choice's rect ([x, y, w, h] or [x, y]) against size ([W, H], null: unknown) picks the way.
 */
export function scrollAdvice(label, m, blocked, step = 200, rect = null, size = null) {
  const words = shortWords(label);
  if (m && m.found) {
    if (m.overlay && m.coveredBy) return `covered by ${m.coveredBy}: close it first (scrolling won't clear it)`;
    const why = m.coveredBy ? `covered by ${m.coveredBy}` : m.offscreen ? `off screen (${m.offscreen})` : m.where ? `under the fixed bar ${m.where === "below" ? "at the bottom" : "at the top"}` : blocked ? `covered by ${blocked.what}` : null;
    if (!why) return null;
    if (Math.abs(m.dy) < 2 || m.room < 1) return `${why}, and the page can't scroll ${m.dy > 0 ? "further down" : "further up"} to clear it (a layout bug a player would hit too)`;
    const by = m.need || m.dy;
    return `${why}: scroll ${by > 0 ? "down" : "up"} ${stepsFor(by, step)} (or "scroll to ${words}"), then pick again`;
  }
  if (!blocked) return null;
  const why = blocked.offscreen ? "off screen" : `covered by ${blocked.what}`;
  const y = Array.isArray(rect) && rect.length >= 2 ? (rect.length >= 4 ? rect[1] + rect[3] / 2 : rect[1]) : null, H = Array.isArray(size) ? size[1] : null;
  // the choice's centre against the view's middle (above the view: up, however tall it is); no rect or no size below it: one step down
  const dy = y == null ? 1 : H ? y - H / 2 : y < 0 ? y : 1;
  return `${why}: scroll ${dy < 0 ? "up" : "down"} ${y == null || (!H && y >= 0) ? 1 : stepsFor(dy, step)} (or "scroll to ${words}"), then pick again`;
}

/** A few words of a label to type back in an order ("Save current look (selected) #2" → "save current look"). */
export const shortWords = (label) => String(label || "").replace(/ \(selected\)| #\d+$/g, "").replace(/["']/g, "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4).join(" ");
