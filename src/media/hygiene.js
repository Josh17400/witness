// Witness media: audio hygiene — the faults procedural and hand-wired game audio has most often.
//
//   truePeak(channels)                      -> { sample, true } peak levels in dBFS / dBTP (4× oversampled, BS.1770)
//   shortTerm(channels, sr)                 -> { max, lra } short-term (3 s) loudness max and loudness range (EBU 3342)
//   edges(x, sr)                            -> sounds separated by silence, with how loud their first/last samples are
//                                              (a sound that starts or stops at a high amplitude clicks)
//   pops(x, sr)                             -> discontinuities inside sustained audio (a jump far above the local slope)
//   secondAttack(env, t0, ...)               -> a second attack 10–45 ms after the first (double-triggered sound)
//   similarity(a, b)                        -> normalized correlation of two clips (1 = identical)
//   loopSeam(x, sr, a, b)                   -> how the end of a loop meets its start: level step, joint jump, tone jump

import { loudnessCurve } from "./audio-analysis.js";

const dB = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

const r1 = (x) => Math.round(x * 10) / 10;
const r3 = (x) => Math.round(x * 1000) / 1000;

// 4-phase polyphase interpolator: a Hann-windowed sinc with 12 taps per phase (48 taps at 4×)
const PHASES = 4, TAPS = 12;
const KERNEL = (() => {
  const k = [];
  for (let p = 0; p < PHASES; p++) {
    const row = new Float64Array(TAPS);
    for (let t = 0; t < TAPS; t++) {
      const n = t - TAPS / 2 + 1 - p / PHASES;          // distance in input samples
      const sinc = n === 0 ? 1 : Math.sin(Math.PI * n) / (Math.PI * n);
      const win = 0.5 + 0.5 * Math.cos((Math.PI * n) / (TAPS / 2));
      row[t] = sinc * (Math.abs(n) < TAPS / 2 ? win : 0);
    }
    const s = row.reduce((a, b) => a + b, 0);
    for (let t = 0; t < TAPS; t++) row[t] /= s;
    k.push(row);
  }
  return k;
})();

/** Sample peak and true peak (the highest level between samples, from 4× oversampling) in dB. */
export function truePeak(channels) {
  let sp = 0, tp = 0;
  for (const x of channels) {
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]);
      if (a > sp) sp = a;
      if (a > tp) tp = a;
      // only look between samples where the signal is loud enough to matter
      if (a < 0.5 && (i + 1 >= x.length || Math.abs(x[i + 1]) < 0.5)) continue;
      for (let p = 1; p < PHASES; p++) {
        let v = 0;
        const row = KERNEL[p];
        for (let t = 0; t < TAPS; t++) { const j = i + t - TAPS / 2 + 1; if (j >= 0 && j < x.length) v += x[j] * row[t]; }
        if (Math.abs(v) > tp) tp = Math.abs(v);
      }
    }
  }
  return { sample: dB(sp), true: dB(tp), samplePeak: sp, truePeak: tp };
}

/** Short-term (3 s windows, every 0.1 s) loudness maximum and the loudness range (EBU Tech 3342: P95 - P10 after gating). */
export function shortTerm(channels, sr) {
  const dur = channels[0].length / sr;
  if (dur < 3) return { max: null, lra: null };
  const c = loudnessCurve(channels, sr, 3, 0.1);
  const vals = c.lufs.filter((v) => Number.isFinite(v) && v > -70);
  if (!vals.length) return { max: null, lra: null };
  const meanE = vals.reduce((a, v) => a + Math.pow(10, v / 10), 0) / vals.length;
  const rel = 10 * Math.log10(meanE) - 20;
  const g = vals.filter((v) => v >= rel).sort((a, b) => a - b);
  const pct = (p) => g[Math.min(g.length - 1, Math.max(0, Math.round((p / 100) * (g.length - 1))))];
  return { max: r1(Math.max(...vals)), lra: g.length ? r1(pct(95) - pct(10)) : null };
}

/**
 * Sounds separated by (near) digital silence: [{ start, end (sample indices), peak, first, last }] where first/last
 * are the absolute values of the first and last audible samples. A sound that begins or ends far above zero (more
 * than 5% of its own peak, 0.005 absolute, and twice the steps next to it) clicks; a short fade (2–5 ms) removes it.
 */
export function edges(x, sr, { silence = 1e-4, gap = 0.002 } = {}) {
  const need = Math.max(2, Math.round(gap * sr));
  const out = [];
  let i = 0;
  const n = x.length;
  while (i < n) {
    while (i < n && Math.abs(x[i]) < silence) i++;
    if (i >= n) break;
    const start = i;
    let quiet = 0, last = i, peak = 0;
    for (; i < n; i++) {
      const a = Math.abs(x[i]);
      if (a < silence) { if (++quiet >= need) break; }
      else { quiet = 0; last = i; if (a > peak) peak = a; }
    }
    // how big the steps right after the start / before the end are: a smooth start (a sine from zero phase, a
    // fade) has a first sample no bigger than its next steps; a cut one jumps far beyond them
    const stepIn = Math.max(Math.abs((x[start + 1] ?? 0) - x[start]), Math.abs((x[start + 2] ?? 0) - (x[start + 1] ?? 0)));
    const stepOut = Math.max(Math.abs(x[last] - (x[last - 1] ?? 0)), Math.abs((x[last - 1] ?? 0) - (x[last - 2] ?? 0)));
    out.push({ start, end: last, t0: start / sr, t1: last / sr, peak, first: Math.abs(x[start]), lastAmp: Math.abs(x[last]), stepIn, stepOut, endsAtEnd: last >= n - need });
  }
  const abrupt = (amp, step, peak) => amp > 0.005 && amp > 0.05 * peak && amp > 2 * step;
  return out.map((s) => ({ ...s, clicksIn: abrupt(s.first, s.stepIn, s.peak), clicksOut: !s.endsAtEnd && abrupt(s.lastAmp, s.stepOut, s.peak) }));
}

/** Jumps inside audio far steeper than the slope around them (a cut buffer, a glitch): [{ i, t, jump }]. */
export function pops(x, sr, { min = 0.1, ratio = 10, max = 20 } = {}) {
  const out = [];
  const w = Math.max(8, Math.round(0.001 * sr));
  const d = new Float64Array(x.length);
  for (let i = 1; i < x.length; i++) d[i] = Math.abs(x[i] - x[i - 1]);
  for (let i = 2; i < x.length - 2 && out.length < max; i++) {
    if (d[i] < min) continue;
    // the local slope, from the steps around that are small themselves (another jump nearby doesn't count)
    let sum = 0, cnt = 0;
    for (let k = Math.max(1, i - w); k < Math.min(x.length, i + w + 1); k++) if (Math.abs(k - i) > 1 && d[k] < min / 2) { sum += d[k] * d[k]; cnt++; }
    const span = Math.min(x.length, i + w + 1) - Math.max(1, i - w) - 3;
    if (cnt < 0.8 * span) continue;   // noise: big steps everywhere, nothing smooth to pop out of
    const ref = cnt > 0 ? Math.sqrt(sum / cnt) : 0;
    // a jump to or from silence (1 ms of it) is a sound's edge, reported by edges(), not a pop inside audio
    let before = 0, after = 0;
    for (let k = Math.max(0, i - w); k < i; k++) before = Math.max(before, Math.abs(x[k]));
    for (let k = i; k < Math.min(x.length, i + w); k++) after = Math.max(after, Math.abs(x[k]));
    if (before < 1e-4 || after < 1e-4) continue;
    if (d[i] > ratio * Math.max(ref, 1e-4)) { out.push({ i, t: r3(i / sr), jump: r3(d[i]) }); i += w; }
  }
  return out;
}

/**
 * A second attack in a sound: on an envelope sampled every `step` seconds (2 ms works well), after the first peak
 * following t0, a later rise of >= 4 dB above the dip before it, back to >= 70% of the first peak, 10–45 ms after
 * it (noise wobbles 1–3 dB; a noise burst restarted a frame later rises ~6 dB, a tone more). { dt (ms), rise (dB) } or null.
 */
export function secondAttack(env, t0, step = 0.002) {
  const i0 = Math.max(0, Math.floor(t0 / step)), win = (ms) => Math.round(ms / 1000 / step);
  let p = i0;
  for (let i = i0; i < Math.min(env.length, i0 + win(12)); i++) if (env[i] > env[p]) p = i;
  if (env[p] <= 1e-5) return null;
  let dip = env[p], dipI = p;
  // a level that already dips and recovers 4 dB inside the first 10 ms is the sound's own texture (a chord's beats,
  // tremolo), not a restart
  { let lo = env[p]; for (let i = p + 1; i < Math.min(env.length, p + win(10)); i++) { if (env[i] < lo) lo = env[i]; else if (lo > 0 && 20 * Math.log10(env[i] / lo) >= 4) return null; } }
  for (let i = p + 1; i < Math.min(env.length, p + win(45) + 1); i++) {
    if (env[i] < dip) { dip = env[i]; dipI = i; }
    if (i - p >= win(10) && i > dipI && dip > 0 && 20 * Math.log10(env[i] / dip) >= 4 && env[i] >= 0.7 * env[p]) return { dt: Math.round((i - p) * step * 1000), rise: r1(20 * Math.log10(env[i] / dip)) };
  }
  return null;
}

/** Normalized correlation of two equal-length clips (1 = the same waveform). */
export function similarity(a, b) {
  const n = Math.min(a.length, b.length);
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/**
 * How a loop's end [b - 20 ms, b) meets its start [a, a + 20 ms): the level step (dB), the jump at the joint
 * (|x[b-1] - x[a]| against the slope around it), and the brightness jump (zero-crossing rate, as Hz).
 */
export function loopSeam(x, sr, a, b) {
  const ia = Math.round(a * sr), ib = Math.round(b * sr), w = Math.round(0.02 * sr);
  if (ib - ia < 2 * w) throw new RangeError("loopSeam: the loop is shorter than 40 ms");
  const rms = (s, e) => { let q = 0; for (let i = s; i < e; i++) q += x[i] * x[i]; return Math.sqrt(q / Math.max(1, e - s)); };
  const zcr = (s, e) => { let z = 0; for (let i = s + 1; i < e; i++) if ((x[i] >= 0) !== (x[i - 1] >= 0)) z++; return (z * sr) / (2 * Math.max(1, e - s)); };
  const startR = rms(ia, ia + w), endR = rms(ib - w, ib);
  const step = startR > 0 && endR > 0 ? 20 * Math.log10(startR / endR) : 0;
  let slope = 0;
  for (let i = ib - w + 1; i < ib; i++) slope += Math.abs(x[i] - x[i - 1]);
  for (let i = ia + 1; i < ia + w; i++) slope += Math.abs(x[i] - x[i - 1]);
  slope /= 2 * (w - 1);
  const joint = Math.abs(x[ib - 1] - x[ia]);
  const tone = zcr(ia, ia + w) - zcr(ib - w, ib);
  const click = joint > 0.02 && joint > 4 * slope;
  return { levelStep: r1(step), joint: r3(joint), slope: r3(slope), click, brightnessJump: Math.round(tone), ok: Math.abs(step) < 3 && !click && Math.abs(tone) < 500 };
}
