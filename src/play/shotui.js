// Witness play: what a playtest screenshot captures in a web game. Many games draw the world on a canvas and put their
// HUD (buttons, meters, labels) in the page over or around it; a canvas-only picture hides those, and a tester then
// reports "no power button on screen". play.shotCapture "auto" (default) captures the screen when the page shows
// buttons or text inside or next to the canvas, else the canvas; "screen" / "canvas" force one.

/**
 * Runs in the page: the visible non-canvas elements (buttons, links, inputs, elements with their own text) that sit
 * inside the main canvas's box or within `margin` CSS px of it. → {count, labels: [first few texts]} | null (no canvas).
 */
export function domUiProbe(margin = 24) {
  let best = null, area = 0;
  for (const c of document.querySelectorAll("canvas")) {
    const r = c.getBoundingClientRect(), st = getComputedStyle(c);
    if (st.display === "none" || st.visibility === "hidden") continue;
    if (r.width * r.height > area) { area = r.width * r.height; best = c; }
  }
  if (!best || !document.body) return null;
  const R = best.getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
  const box = { l: R.left - margin, t: R.top - margin, r: R.right + margin, b: R.bottom + margin };
  const INTER = "button,a[href],input,select,textarea,[role=button],[role=link],[onclick]";
  const hidden = (el) => { for (let a = el; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return true; } return false; };
  const labels = []; let count = 0;
  for (const el of document.body.querySelectorAll("*")) {
    if (el.tagName === "CANVAS" || el.contains(best) || /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|LINK|META|svg|path|g)$/i.test(el.tagName)) continue;
    const inter = el.matches(INTER);
    let text = "";
    if (!inter) { for (const n of el.childNodes) if (n.nodeType === 3) text += n.textContent; text = text.trim(); if (!text) continue; }
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.right <= box.l || r.left >= box.r || r.bottom <= box.t || r.top >= box.b) continue;   // not over / by the canvas
    if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;                 // off screen
    if (hidden(el)) continue;
    count++;
    if (labels.length < 5) { const l = (inter ? el.innerText || el.value || el.getAttribute("aria-label") || el.title || el.tagName.toLowerCase() : text).replace(/\s+/g, " ").trim().slice(0, 20); if (l && !labels.includes(l)) labels.push(l); }
  }
  return { count, labels };
}

/**
 * Which capture a playtest shot uses: {mode: "screen" | "canvas", note: text for the shot line | null}.
 * `want`: play.shotCapture; `web`: the session's web facts (null: not a browser game: its own screenshot, no note);
 * `probe()`: domUiProbe's answer from the page (or null / a throw: unknown → canvas).
 */
export async function chooseCapture(want, web, probe) {
  if (!web) return { mode: "game", note: null };
  if (web.captureMode === "screen") return { mode: "screen", note: web.domPage ? "the screen (the page has no canvas)" : "the screen (launch.capture)" };
  if (web.captureMode === "element" && want !== "screen") return { mode: "element", note: "the canvas as the screen shows it (launch.capture \"element\")" };
  if (want === "canvas") return { mode: "canvas", note: "the canvas only (play.shotCapture \"canvas\": page buttons and text over it are not in the picture)" };
  if (want === "screen") return { mode: "screen", note: "the screen (play.shotCapture \"screen\")" };
  let ui = null;
  try { ui = await probe(); } catch { ui = null; }
  if (ui && ui.count) return { mode: "screen", note: `the screen: the page has ${ui.count} button${ui.count === 1 ? "" : "s"}/text over or next to the canvas${ui.labels && ui.labels.length ? ` (${ui.labels.map((l) => `"${l}"`).join(", ")}${ui.count > ui.labels.length ? ", …" : ""})` : ""}` };
  return { mode: "canvas", note: ui ? "the canvas (no page buttons or text over or next to it)" : null };
}
