// Card-game sound effects (see cardsfx.html). Under Witness, test --repeat 2 must give the same audio in both passes:
// in the first the context is made by the first tap of the test, in the second it already exists (it lives for the
// page, as a game's does), and the WAV decodes asynchronously. ?eager=1 (the cardsfx-locked project, iPhone audio
// policy): made at load, frozen until the first tap resumes it in pass 1, running all along in pass 2.
import witness from "/witness/witness.js";

let ac = null, wav = null, played, dealt, ai, sfx, decodes = 0;
const cards = [...document.querySelectorAll(".card")];

function wavBytes() {   // a 16-bit mono WAV made in memory (a 0.12 s "card slide" noise burst, then 30 s of silence:
  // long enough that decoding it takes real time), as if fetched
  const rate = 44100, n = Math.floor(rate * 0.12), len = n + rate * 30, b = new ArrayBuffer(44 + len * 2), v = new DataView(b);
  const s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  s(0, "RIFF"); v.setUint32(4, 36 + len * 2, true); s(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, "data"); v.setUint32(40, len * 2, true);
  let r = 9;
  for (let i = 0; i < n; i++) { r = (r * 16807) % 2147483647; v.setInt16(44 + i * 2, ((r / 1073741823.5 - 1) * 12000 * (1 - i / n)) | 0, true); }
  return b;
}
function audio() {   // lazily, on the first gesture (iPhone style), resumed on every tap while suspended
  if (!ac) {
    ac = new AudioContext();
    ac.decodeAudioData(wavBytes()).then((b) => { wav = b; decodes++; });
  }
  if (ac.state === "suspended") ac.resume();
  return ac;
}
function tone(freq, dur, delay = 0.01, type = "triangle") {   // an enveloped oscillator one-shot
  if (!ac) return;
  const t = ac.currentTime + delay, o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(freq * 0.7, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.4, t + 0.008); g.gain.linearRampToValueAtTime(0, t + dur);
  o.connect(g).connect(ac.destination);
  o.start(t); o.stop(t + dur + 0.01);
  sfx++;
}
function slide(rate = 1) {   // the decoded WAV, if it has decoded yet
  if (!ac || !wav) return;
  const s = ac.createBufferSource(), g = ac.createGain();
  s.buffer = wav; s.playbackRate.value = rate;
  g.gain.setValueAtTime(0.5, ac.currentTime); g.gain.setTargetAtTime(0, ac.currentTime + 0.05, 0.02);
  s.connect(g).connect(ac.destination);
  s.start(); s.stop(ac.currentTime + 0.2);
  sfx++;
}
function deal() {
  audio();
  tone(523, 0.06);
  for (let i = 0; i < 5; i++) setTimeout(() => { slide(0.9 + i * 0.05); dealt++; }, 20 + i * 90);   // the first one frames after the decode began
}
function play(i) {
  audio();
  played++;
  tone(660 + 40 * i, 0.08);                          // from the handler / call itself
  Promise.resolve().then(() => tone(330, 0.05, 0.03, "square"));   // a promise continuation
  requestAnimationFrame(() => requestAnimationFrame(() => tone(990, 0.04, 0)));   // two frames later, "now"
  setTimeout(() => { ai++; slide(1.2); tone(220, 0.1, 0.02, "sawtooth"); }, 350);   // the AI's answer
}
document.getElementById("deal").addEventListener("click", deal);
cards.forEach((c, i) => c.addEventListener("click", () => play(i)));

// ?eager=1: the context is made at load instead (suspended until a tap under the iPhone policy, resumed by it)
if (new URLSearchParams(location.search).get("eager") === "1") audio();

function reset() { played = 0; dealt = 0; ai = 0; sfx = 0; }   // the context (and its decoded WAV) live on, as in a game
reset();

await witness.start({
  name: "Card sounds", fps: 60,
  reset: () => reset(),
  calls: { play: (i) => { play(i | 0); return played; }, deal: () => { deal(); return true; }, tap: (sel) => witness.dom.tap(sel) },
  snapshot: () => ({ played, dealt, ai, sfx }),
});
