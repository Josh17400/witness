// Safe areas: what the page's CSS resolves env(safe-area-inset-*) to (0 in headless engines; the device's insets with
// --safe-insets), from a <style>, a <link> sheet, an inline style, a rule inserted by script, and an element added later;
// @import'ed sheets (one from a <style> added by script), a fallback nested two levels deep, a rule inserted into an
// @media rule, rule.style.paddingLeft = …, style.cssText set every frame (one use), and a <style> in a shadow root.
import witness from "/witness/witness.js";

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const sheet = document.styleSheets[0];
sheet.insertRule("#js { position: fixed; left: 0; top: 0; padding-bottom: env(safe-area-inset-bottom); }", sheet.cssRules.length);
const late = document.createElement("div");
late.id = "late";
setTimeout(() => { late.setAttribute("style", "margin-top: env(safe-area-inset-top)"); document.body.appendChild(late); }, 50);
const imp2 = document.createElement("style");
imp2.textContent = "@import url(safe-import2.css);";
document.head.appendChild(imp2);
Array.from(sheet.cssRules).find((r) => r.media).insertRule("#grp { position: fixed; padding-left: env(safe-area-inset-left) }", 0);
Array.from(sheet.cssRules).find((r) => r.selectorText === "#named").style.paddingLeft = "env(safe-area-inset-left)";
const frameEl = document.getElementById("frame");
const shadow = document.getElementById("host").attachShadow({ mode: "open" });
shadow.innerHTML = "<style>#sh { position: fixed; padding-left: env(safe-area-inset-left); }</style><div id='sh'></div>";
// ?missed: a keyframe's style set by name (Chromium has no accessor to patch for it): reported as missed, not rewritten
if (/missed/.test(location.search)) Array.from(sheet.cssRules).find((r) => r.name === "pulse").cssRules[0].style.paddingLeft = "env(safe-area-inset-left)";
let x = 0;
function render() { ctx.fillStyle = "#124"; ctx.fillRect(0, 0, 160, 90); ctx.fillStyle = "#fff"; ctx.fillRect(x, 40, 8, 8); }
const px = (id, prop) => { const el = document.getElementById(id); return el ? getComputedStyle(el)[prop] : null; };
function loop() { render(); frameEl.style.cssText = "position: fixed; padding-left: env(safe-area-inset-left)"; requestAnimationFrame(loop); }
loop();
await witness.start({
  name: "Safe areas", fps: 60, size: [160, 90], canvas,
  reset: () => { x = 0; },
  step: () => { x = (x + 1) % 152; },
  snapshot: () => ({
    hudTop: px("hud", "paddingTop"), hudLeft: px("hud", "paddingLeft"), cornerRight: px("corner", "right"),
    barHeight: px("bar", "height"), barPadRight: px("bar", "paddingRight"), sab: getComputedStyle(document.documentElement).getPropertyValue("--sab").trim(),
    inlLeft: px("inl", "marginLeft"), jsPad: px("js", "paddingBottom"), lateTop: px("late", "marginTop"),
    impLeft: px("imp", "paddingLeft"), imp2Left: px("imp2", "paddingLeft"), nestLeft: px("nest", "paddingLeft"), grpLeft: px("grp", "paddingLeft"),
    namedLeft: px("named", "paddingLeft"), frameLeft: px("frame", "paddingLeft"), shLeft: getComputedStyle(shadow.getElementById("sh")).paddingLeft,
    // (rewrites, the count of rewriting calls, grows with every frame's style.cssText: left out of the state)
    safe: globalThis.__witnessSafe ? (({ rewrites, ...i }) => i)(globalThis.__witnessSafe.info()) : null,
  }),
});
