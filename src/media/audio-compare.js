// Witness media: compare two audio captures sample by sample, with a tolerance (doctor, test --repeat, "match" steps).
// WebAudio's dynamics compressors, wave shapers and convolvers may round a hair differently in a fresh AudioContext
// (4e-7 seen in The Fort): a difference within tol is noise, counted apart, never a failure.
import { decodePCM } from "./audio-analysis.js";

/** The default per-sample tolerance (full scale = 1): far below anything audible (-100 dBFS), far above float noise. */
export const AUDIO_TOL = 1e-5;
/** WebAudio renders in quanta of this many frames: a capture may end up to one quantum longer than another. */
export const RENDER_QUANTUM = 128;

/**
 * Where two captures ({sampleRate, channels, format, data} or decoded) differ:
 * {same, seconds, first, count, noise, maxDiff, lengths, sampleRates, tail?, silent?, tol}.
 * count: samples off by more than tol; noise: samples that differ within it; seconds: the first of `count` (null: none).
 * Captures of different lengths are the same when the overlap is and the longer one's extra frames are at most one
 * render quantum of silence (tail: {frames, peak}). Different sample rates are the same only when both are silent.
 */
export function comparePCM(a, b, { tol = AUDIO_TOL } = {}) {
  const A = a && a.channels && Array.isArray(a.channels) && a.channels[0] instanceof Float32Array ? a : decodePCM(a);
  const B = b && b.channels && Array.isArray(b.channels) && b.channels[0] instanceof Float32Array ? b : decodePCM(b);
  tol = Math.max(0, +tol || 0);
  const la = A.channels[0].length, lb = B.channels[0].length;
  const peak = (P, from = 0) => { let m = 0; for (const c of P.channels) for (let i = from; i < c.length; i++) { const v = Math.abs(c[i]); if (v > m) m = v; } return m; };
  const out = { same: true, seconds: null, first: -1, count: 0, noise: 0, maxDiff: 0, lengths: [la, lb], sampleRates: [A.sampleRate, B.sampleRate], tol };
  if (A.sampleRate !== B.sampleRate) {
    const pa = peak(A), pb = peak(B);
    out.silent = pa <= tol && pb <= tol;
    out.maxDiff = Math.max(pa, pb);
    out.same = out.silent;
    return out;
  }
  const n = Math.min(la, lb), nc = Math.min(A.channels.length, B.channels.length);
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let c = 0; c < nc; c++) { const x = Math.abs(A.channels[c][i] - B.channels[c][i]); if (x > d) d = x; }
    if (!(d > 0)) continue;
    if (d > out.maxDiff) out.maxDiff = d;
    if (d <= tol) { out.noise++; continue; }
    if (out.first < 0) out.first = i;
    out.count++;
  }
  if (A.channels.length !== B.channels.length) out.same = false;
  if (la !== lb) {
    const L = la > lb ? A : B;
    out.tail = { frames: Math.abs(la - lb), peak: peak(L, n) };
    if (out.tail.frames > RENDER_QUANTUM || out.tail.peak > tol) out.same = false;
  }
  if (out.count) out.same = false;
  if (out.first >= 0) out.seconds = out.first / A.sampleRate;
  return out;
}

/** comparePCM's result in words: the problem when not the same, else a note when anything differed within tol (or ""). */
export function describePCMDiff(d) {
  const lens = d.lengths[0] !== d.lengths[1] ? ` (lengths ${d.lengths[0]} vs ${d.lengths[1]} frames)` : "";
  if (d.sampleRates[0] !== d.sampleRates[1]) {
    return d.same ? `audio: both captures silent, at ${d.sampleRates[0]} vs ${d.sampleRates[1]} Hz${lens}`
      : `audio differs: sample rates ${d.sampleRates[0]} vs ${d.sampleRates[1]} Hz${lens}, peak ${d.maxDiff.toPrecision(3)}`;
  }
  const tolS = `±${d.tol === 0 ? "0" : d.tol < 1e-3 ? d.tol.toExponential(1) : d.tol}`;
  if (!d.same) {
    const where = d.seconds != null ? ` from ${d.seconds.toFixed(4)} s into the capture` : "";
    const tail = d.tail && !d.count && d.tail.peak > d.tol ? `, the longer one's last ${d.tail.frames} frames peak at ${d.tail.peak.toPrecision(3)}` : "";
    return `audio differs${where}${lens}${d.count ? `: ${d.count} sample${d.count === 1 ? "" : "s"} off by more than ${tolS}` : ""}, max sample difference ${d.maxDiff.toPrecision(3)}${tail}${d.noise ? ` (+${d.noise} within ${tolS})` : ""}`;
  }
  const parts = [];
  if (d.noise) parts.push(`${d.noise} sample${d.noise === 1 ? "" : "s"} differed by at most ${d.maxDiff.toPrecision(3)} (within the ${tolS} tolerance: float rounding in WebAudio's compressors / convolvers)`);
  if (d.tail) parts.push(`lengths ${d.lengths[0]} vs ${d.lengths[1]} frames: the extra ${d.tail.frames} are silent render-quantum padding`);
  return parts.length ? `audio: ${parts.join("; ")}` : "";
}
