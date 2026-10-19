// "Tap to start": the iPhone audio-unlock pattern, done right (resume() inside the touchend/click handler) or, with
// ?bug=1, the classic bug (the handler only sets a flag; the game loop calls resume() later, outside the gesture).
import witness from "/witness/witness.js";

const BUG = new URLSearchParams(location.search).get("bug") === "1";
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const audio = new AudioContext();
let started, wantStart, t, beeps;

function reset() {
  started = false; wantStart = false; t = 0; beeps = 0;
  // a jingle queued while audio is still locked: on an iPhone the context is frozen, so it plays after the tap
  if (audio.state !== "running") jingle();
}
function jingle() {
  const now = audio.currentTime, osc = audio.createOscillator(), gain = audio.createGain();
  osc.frequency.value = 330;
  gain.gain.value = 0.4;
  osc.connect(gain).connect(audio.destination);
  osc.start(now);
  osc.stop(now + 0.25);
}
function beep() {
  const now = audio.currentTime, osc = audio.createOscillator(), gain = audio.createGain();
  osc.frequency.value = 660;
  gain.gain.value = 0.4;
  osc.connect(gain).connect(audio.destination);
  osc.start(now);
  osc.stop(now + 0.1);
  beeps++;
}
function start() {
  if (started) return;
  started = true;
  if (!BUG && audio.state === "suspended") audio.resume();   // inside the gesture: unlocks on iPhone
}
canvas.addEventListener("touchend", () => { if (BUG) wantStart = true; else start(); });
canvas.addEventListener("click", () => { if (BUG) wantStart = true; else start(); });

function update(dt) {
  if (BUG && wantStart) { wantStart = false; started = true; audio.resume(); }   // outside the gesture: blocked on iPhone
  if (!started) return;
  const before = Math.floor(t / 0.5);
  t += dt;
  if (Math.floor(t / 0.5) !== before || beeps === 0) beep();
}
function render() {
  ctx.fillStyle = started ? "#143" : "#311";
  ctx.fillRect(0, 0, 160, 90);
  ctx.fillStyle = "#fff";
  if (!started) ctx.fillRect(40, 40, 80, 10);   // the "TAP TO START" bar
}
let last = performance.now();
function frame(now) { update(Math.min((now - last) / 1000, 0.1)); last = now; render(); requestAnimationFrame(frame); }
reset();
requestAnimationFrame(frame);

await witness.start({
  name: BUG ? "Tap to start (bug)" : "Tap to start", fps: 60, size: [160, 90], canvas,
  reset: () => reset(),
  snapshot: () => ({ started, beeps, audio: audio.state, ct: audio.currentTime, ui: started ? [] : [{ id: "tap", kind: "text", rect: [40, 40, 80, 10], text: "TAP TO START" }] }),
});
