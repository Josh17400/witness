// A voice-capped sound engine like The Fort's: live voices counted down by src.onended (buffer sources of uneven
// lengths and pitches) and by setTimeout (oscillators), new sounds dropped at the cap, a fresh AudioContext opened
// lazily after each reset (old one closed) through compressor x2 + waveshaper + convolver reverb. Under Witness the
// same seed must give the same sounds every run: onended late or early by one frame drops a different set.
import witness from "/witness/witness.js";

const CAP = 3;
const canvas = document.getElementById("game");
const g2 = canvas.getContext("2d");
let rs, t, ac, mix, bufs, live, tlive, started, dropped, ended, slack, lsn, ghost, twice, run = 0;
const rnd = () => ((rs = (rs * 16807) % 2147483647) / 2147483647);

function graph(c) {
  const P = (n, o) => { for (const k in o) n[k].value = o[k]; return n; };
  const glue = P(c.createDynamicsCompressor(), { threshold: -14, knee: 8, ratio: 2.5, attack: 0.004, release: 0.25 });
  const lim = P(c.createDynamicsCompressor(), { threshold: -3, knee: 0, ratio: 20, attack: 0.001, release: 0.12 });
  const clip = c.createWaveShaper(), curve = new Float32Array(257);
  for (let i = 0; i < 257; i++) curve[i] = Math.tanh(1.5 * (i / 128 - 1));
  clip.curve = curve;
  mix = c.createGain();
  mix.connect(glue).connect(lim).connect(clip).connect(c.destination);
  const cv = c.createConvolver(), ir = c.createBuffer(1, Math.floor(c.sampleRate * 0.4), c.sampleRate), d = ir.getChannelData(0);
  let s = 7;
  for (let i = 0; i < d.length; i++) { s = (s * 16807) % 2147483647; d[i] = (s / 1073741823.5 - 1) * Math.pow(1 - i / d.length, 3); }
  cv.buffer = ir;
  const wet = c.createGain(); wet.gain.value = 0.4;
  mix.connect(cv).connect(wet).connect(glue);
  bufs = [0.03, 0.07, 0.11, 0.17, 0.23].map((len, k) => {
    const b = c.createBuffer(1, Math.floor(c.sampleRate * len), c.sampleRate), a = b.getChannelData(0);
    for (let i = 0; i < a.length; i++) a[i] = 0.5 * Math.sin((2 * Math.PI * (220 + 110 * k) * i) / c.sampleRate) * (1 - i / a.length);
    return b;
  });
}
function hit() {
  if (live >= CAP) { dropped++; return; }
  live++; started++;
  const s = ac.createBufferSource(), out = ac.createGain();
  s.buffer = bufs[(rnd() * bufs.length) | 0];
  s.playbackRate.value = 0.7 + rnd() * 0.8;
  out.gain.value = 0.3 + rnd() * 0.4;
  s.connect(out).connect(mix);
  const at = ac.currentTime + 0.005 + rnd() * 0.02;
  let end = at + s.buffer.duration / s.playbackRate.value;
  let fired = 0;
  const done = () => {   // how long after its end the event came (context time): never before, at most a frame + a quantum
    if (fired++) { twice++; return; }
    live--; ended++; out.disconnect();
    const d = ac.currentTime - end;
    slack = [Math.min(slack[0], d), Math.max(slack[1], d)];
  };
  // three ways to hear "ended": onended; addEventListener once (a game re-dispatching must not refire it); a
  // handleEvent object on the capture flag. Each listener voice also gets one added-then-removed (must never fire).
  const k = started % 3;
  if (k === 0) s.onended = done;
  else {
    const no = () => ghost++;
    s.addEventListener("ended", no, { capture: k === 2 }); s.removeEventListener("ended", no, k === 2);
    if (k === 1) s.addEventListener("ended", () => { lsn++; done(); s.dispatchEvent(new Event("ended")); }, { once: true });
    else s.addEventListener("ended", { handleEvent() { lsn++; done(); } }, true);
  }
  s.start(at);
  if (rnd() < 0.3) { const st = at + 0.02 + rnd() * 0.05; end = Math.min(end, st); s.stop(st); }   // cut short: ends at its stop time
}
function blip() {   // the other counting pattern: a node-synth voice freed by a timer
  if (tlive >= 2) { dropped++; return; }
  tlive++; started++;
  const o = ac.createOscillator(), gn = ac.createGain(), dur = 0.04 + rnd() * 0.08, at = ac.currentTime + 0.005;
  o.frequency.value = 500 + rnd() * 700; gn.gain.value = 0.2;
  o.connect(gn).connect(mix);
  o.start(at); o.stop(at + dur);
  const r = run;   // a timer from before a reset belongs to the old run
  setTimeout(() => { if (r === run) tlive--; gn.disconnect(); }, (dur + 0.02) * 1000);
}
function reset(seed = 1) {
  if (ac) ac.close();
  ac = null; run++; rs = (seed >>> 0) || 1; t = 0; live = 0; tlive = 0; started = 0; dropped = 0; ended = 0; lsn = 0; ghost = 0; twice = 0; slack = [Infinity, -Infinity];
}
function update(dt) {
  t += dt;
  if (!ac && t >= 0.3) { ac = new AudioContext(); graph(ac); }   // opened lazily, like a game opening audio at "deploy"
  if (!ac) return;
  if (rnd() < 0.6) hit();
  if (rnd() < 0.15) blip();
}
function render() {
  g2.fillStyle = "#123"; g2.fillRect(0, 0, 160, 90);
  g2.fillStyle = "#fc4"; g2.fillRect(4, 4, live * 20, 6);
  g2.fillStyle = "#4cf"; g2.fillRect(4, 14, tlive * 20, 6);
}
let last = performance.now();
function frame(now) { update(Math.min((now - last) / 1000, 0.1)); last = now; render(); requestAnimationFrame(frame); }
reset();
requestAnimationFrame(frame);

await witness.start({
  name: "Voices", fps: 60, size: [160, 90], canvas,
  reset: ({ seed }) => reset(seed),
  snapshot: () => ({ t: Math.round(t * 1000) / 1000, live, tlive, started, dropped, ended, lsn, ghost, twice, audio: ac ? ac.state : "none", early: slack[0] < 0 ? slack[0] : 0, late: slack[1] }),
});
