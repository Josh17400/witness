// Synthetic test signals whose answers are known by construction (ported from Lumen's tests/listen.mjs).
import { midiToHz } from "../../src/media/audio-analysis.js";

export const SR = 48000;

export const buf = (sec) => new Float32Array(Math.round(sec * SR));

let seed = 1;
/** Deterministic white noise in -1..1. */
export const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };

/** Add a tone: wave(phase) with a frequency function f(t) and an amplitude function a(t). */
export function addTone(x, t0, dur, f, a, wave = Math.sin) {
  let ph = 0;
  const i0 = Math.round(t0 * SR);
  for (let i = 0; i < Math.round(dur * SR) && i0 + i < x.length; i++) {
    const t = i / SR;
    ph += 2 * Math.PI * f(t) / SR;
    x[i0 + i] += a(t) * wave(ph);
  }
  return x;
}

/** Add a noise burst with an amplitude function a(t). */
export function addNoise(x, t0, dur, a) {
  const i0 = Math.round(t0 * SR);
  for (let i = 0; i < Math.round(dur * SR) && i0 + i < x.length; i++) x[i0 + i] += a(i / SR) * rnd();
  return x;
}

export const fades = (dur, level = 0.5, edge = 0.005) => (t) => level * Math.min(1, t / edge, (dur - t) / edge);
export const saw = (ph) => { let s = 0; for (let k = 1; k <= 12; k++) s += Math.sin(k * ph) / k; return s * 0.55; };
export const square = (ph) => { let s = 0; for (let k = 1; k <= 15; k += 2) s += Math.sin(k * ph) / k; return s * 0.8; };
export const stereo = (x) => [x, x];

/** Kick drums (swept sine) on every beat, with hi-hats on the off-beats. */
export function kicks(bpm, sec, hats = true) {
  const x = buf(sec), beat = 60 / bpm;
  for (let t = 0; t < sec - 0.3; t += beat) {
    addTone(x, t, 0.25, (u) => 50 + 110 * Math.exp(-u / 0.03), (u) => 0.8 * Math.min(1, u / 0.002) * Math.exp(-u / 0.07));
    if (hats) for (let i = 0; i < 0.03 * SR; i++) { const j = Math.round((t + beat / 2) * SR) + i; if (j < x.length) x[j] += rnd() * 0.15 * Math.exp(-i / (0.008 * SR)); }
  }
  return x;
}

export const CHORD_NOTES = { C: [48, 60, 64, 67], Am: [45, 57, 60, 64], F: [41, 57, 60, 65], G: [43, 59, 62, 67] };

/** One bar per chord name at `bpm` (4/4), saw-wave voicings. */
export function chordTrack(names, bpm = 120, { wave = saw, level = 0.12 } = {}) {
  const bar = 4 * 60 / bpm, x = buf(bar * names.length + 0.2);
  names.forEach((n, i) => {
    for (const m of CHORD_NOTES[n]) addTone(x, i * bar, bar, () => midiToHz(m), (t) => level * Math.min(1, t / 0.02, (bar - t) / 0.05), wave);
  });
  return x;
}

/** Interleave Float32 channels into protocol PCM ({ sampleRate, channels, format, data }). */
export function toPCM(channels, format = "f32", sampleRate = SR) {
  const n = channels[0].length, nch = channels.length, bps = format === "f32" ? 4 : 2;
  const data = Buffer.alloc(n * nch * bps);
  for (let i = 0, o = 0; i < n; i++) {
    for (let c = 0; c < nch; c++, o += bps) {
      const v = channels[c][i];
      if (format === "f32") data.writeFloatLE(v, o);
      else data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), o);
    }
  }
  return { sampleRate, channels: nch, format, data };
}
