// Safe areas: what the page's CSS resolves env(safe-area-inset-*) to (0 in headless engines; the device's insets with
// --safe-insets), from a <style>, a <link> sheet, an inline style, a rule inserted by script, and an element added later.
import witness from "/witness/witness.js";

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const sheet = document.styleSheets[0];
sheet.insertRule("#js { position: fixed; left: 0; top: 0; padding-bottom: env(safe-area-inset-bottom); }", sheet.cssRules.length);
const late = document.createElement("div");
late.id = "late";
setTimeout(() => { late.setAttribute("style", "margin-top: env(safe-area-inset-top)"); document.body.appendChild(late); }, 50);
let x = 0;
function render() { ctx.fillStyle = "#124"; ctx.fillRect(0, 0, 160, 90); ctx.fillStyle = "#fff"; ctx.fillRect(x, 40, 8, 8); }
const px = (id, prop) => { const el = document.getElementById(id); return el ? getComputedStyle(el)[prop] : null; };
function loop() { render(); requestAnimationFrame(loop); }
loop();
await witness.start({
  name: "Safe areas", fps: 60, size: [160, 90], canvas,
  reset: () => { x = 0; },
  step: () => { x = (x + 1) % 152; },
  snapshot: () => ({
    hudTop: px("hud", "paddingTop"), hudLeft: px("hud", "paddingLeft"), cornerRight: px("corner", "right"),
    barHeight: px("bar", "height"), barPadRight: px("bar", "paddingRight"), sab: getComputedStyle(document.documentElement).getPropertyValue("--sab").trim(),
    inlLeft: px("inl", "marginLeft"), jsPad: px("js", "paddingBottom"), lateTop: px("late", "marginTop"),
    safe: globalThis.__witnessSafe ? globalThis.__witnessSafe.info() : null,
  }),
});
