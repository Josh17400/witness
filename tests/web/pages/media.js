// The 0.7.8 media page: what the page sees of launch.media, desktop dom:tap clicks, a never-resolving call, and the
// AudioContext clock (with and without audio capture: a play session captures none).
import witness from "/witness/witness.js";

// a fresh AudioContext at every reset: its clock counts from the reset, whatever the boot took
let audio = new AudioContext();
let clicks = 0, ended = 0, beeps = 0, t = 0;
document.getElementById("btn").addEventListener("click", () => { clicks++; });
function beep() {
  const now = audio.currentTime, osc = audio.createOscillator();
  osc.connect(audio.destination);
  osc.onended = () => { ended++; };
  osc.start(now);
  osc.stop(now + 0.05);
  beeps++;
}
function reset() { clicks = 0; ended = 0; beeps = 0; t = 0; audio.close(); audio = new AudioContext(); }
let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  const before = Math.floor(t / 0.2);
  t += dt;
  if (Math.floor(t / 0.2) !== before) beep();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

await witness.start({
  name: "Media page", fps: 60,
  reset: () => reset(),
  calls: { forever: () => new Promise(() => {}), clicks: () => clicks },
  snapshot: () => ({
    reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
    dark: matchMedia("(prefers-color-scheme: dark)").matches,
    bg: getComputedStyle(document.body).backgroundColor,
    transition: getComputedStyle(document.getElementById("anim")).transitionProperty,
    clicks, beeps, ended, ct: audio.currentTime, audio: audio.state,
  }),
});
