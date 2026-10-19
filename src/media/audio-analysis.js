// Witness media — audio perception: turns rendered audio into numbers and words.
//
// Ported from Lumen's runtime (src/runtime/audio-analysis.js) with its API intact; the advice
// in problem texts is engine-neutral here. Pure ES on Float32Arrays (no WebAudio, no DOM), so
// tests/media/audio.mjs checks it against known synthetic signals. `witness listen` feeds it
// the PCM a game mixed during a run through analyzePCM() at the end of this file:
//
//   analyzeEvent(channels, sr)      one sound rendered alone: length, level, attack,
//                                   envelope shape, pitch movement (YIN), brightness,
//                                   tonal/noisy, clipping, pan
//   analyzeMusic(channels, sr, ...) tempo (onset autocorrelation), key (Krumhansl),
//                                   chord per bar (chroma templates), loudness, changes
//   transcribe(...)                 a monophonic stem back into pattern notation
//   analyzeMix(...)                 peak, clipping, integrated LUFS, masking, outliers,
//                                   silences -> a prioritized list of problems
//   formatReport(report)            the plain-language report (Lumen's per-call format)
//   spectrogram(...)                log-frequency dB matrix for the PNGs
//
// Witness additions (raw game audio, no per-sound stems):
//   decodePCM / concatPCM            protocol PCM -> Float32 channels; join `audio` replies
//   wavToPCM / pcmToWav              WAV files <-> protocol PCM
//   detectOnsets(...)                where distinct sounds start in a mix
//   analyzePCM(pcm, { events })      the whole `witness listen` report: mix, sounds (from the
//                                    given event times or found by onset detection), music
//                                    (tempo, key, chords, melody guess) and ranked problems
//
// Every descriptor is reported together with the number it came from.

// ---------------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------------

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const noteName = (m) => { const r = Math.round(m); return NOTE_NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1); };
const dB = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const fmtHz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`);
const fmtS = (s) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`);
const r1 = (x) => Math.round(x * 10) / 10;

function median(a) {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Average of the channels (the signal a mono listener hears). */
export function mono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length, out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i] / channels.length;
  return out;
}

// ---------------------------------------------------------------------------
// FFT (iterative radix-2, cached tables)
// ---------------------------------------------------------------------------

const fftCache = new Map();
function tables(n) {
  let t = fftCache.get(n);
  if (!t) {
    const rev = new Uint32Array(n), bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
    const hann = new Float32Array(n);
    for (let i = 0; i < n; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    t = { rev, cos, sin, hann, re: new Float64Array(n), im: new Float64Array(n) };
    fftCache.set(n, t);
  }
  return t;
}

/** In-place complex FFT of (re, im), length a power of two. */
export function fft(re, im) {
  const n = re.length, { rev, cos, sin } = tables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j, b = a + half;
        const tr = re[b] * cos[k] - im[b] * sin[k], ti = re[b] * sin[k] + im[b] * cos[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}

/**
 * Hann-windowed power spectrum of x[start .. start+n) (zero-padded at the edges).
 * Scaled so a full-scale sine reads ~1.0 in its peak bin. Returns n/2+1 bins.
 */
export function powerSpectrum(x, start, n, out) {
  const t = tables(n), re = t.re, im = t.im, w = t.hann;
  for (let i = 0; i < n; i++) {
    const j = start + i;
    re[i] = j >= 0 && j < x.length ? x[j] * w[i] : 0;
    im[i] = 0;
  }
  fft(re, im);
  const p = out || new Float32Array(n / 2 + 1), scale = 4 / (n * n * 0.25);
  for (let k = 0; k <= n / 2; k++) p[k] = (re[k] * re[k] + im[k] * im[k]) * scale;
  return p;
}

// ---------------------------------------------------------------------------
// envelope & loudness
// ---------------------------------------------------------------------------

/** RMS envelope over the channels in windows of `win` seconds: window w covers [w * win, (w + 1) * win) exactly (at
 *  22.05 or 44.1 kHz a window is 22 or 23 samples, so index × win stays the time: whole 22-sample windows drifted
 *  0.23%, 2.7 ms by 1.2 s and 30 ms by 13 s). */
export function envelope(channels, sr, win = 0.005) {
  const len = channels[0].length, step = sr * win;
  const out = new Float32Array(Math.ceil(len / step - 1e-9));
  for (let w = 0; w < out.length; w++) {
    const i0 = Math.round(w * step), i1 = Math.min(len, Math.max(i0 + 1, Math.round((w + 1) * step)));
    let s = 0, c = 0;
    for (const ch of channels) for (let i = i0; i < i1; i++) { s += ch[i] * ch[i]; c++; }
    out[w] = Math.sqrt(s / Math.max(1, c));
  }
  return out;
}

function biquad(x, b0, b1, b2, a0, a1, a2) {
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** BS.1770 K-weighting (high shelf +4 dB at 1.5 kHz, high-pass at 38 Hz), any sample rate. */
export function kWeight(x, sr) {
  let w0 = 2 * Math.PI * 1500 / sr, A = Math.pow(10, 4 / 40), al = Math.sin(w0) / (2 * Math.SQRT1_2), c = Math.cos(w0), sA = Math.sqrt(A);
  const shelf = biquad(x,
    A * ((A + 1) + (A - 1) * c + 2 * sA * al), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - 2 * sA * al),
    (A + 1) - (A - 1) * c + 2 * sA * al, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - 2 * sA * al);
  w0 = 2 * Math.PI * 38 / sr; al = Math.sin(w0) / (2 * 0.5); c = Math.cos(w0);
  return biquad(shelf, (1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
}

/** Momentary loudness (LUFS) in `win`-second windows every `hop` seconds. */
export function loudnessCurve(channels, sr, win = 0.4, hop = 0.1) {
  const len = channels[0].length;
  const pre = new Float64Array(len + 1);
  for (const ch of channels) {
    const k = kWeight(ch, sr);
    let s = 0;
    for (let i = 0; i < len; i++) { s += k[i] * k[i]; pre[i + 1] += s; }
  }
  const n = Math.round(win * sr), h = Math.round(hop * sr);
  const times = [], lufs = [], ms = [];
  for (let s = 0; s + n <= Math.max(len, n); s += h) {
    const e = Math.min(len, s + n);
    const z = (pre[e] - pre[Math.min(s, len)]) / n;
    times.push((s + n / 2) / sr); ms.push(z); lufs.push(z > 0 ? -0.691 + 10 * Math.log10(z) : -120);
    if (e >= len) break;
  }
  return { times, lufs, ms, hop, win };
}

/** Integrated loudness (BS.1770 gating: absolute -70 LUFS, relative -10 LU). */
export function integratedLoudness(channels, sr, curve) {
  const c = curve || loudnessCurve(channels, sr);
  const abs = c.ms.filter((z, i) => c.lufs[i] > -70);
  if (!abs.length) return -Infinity;
  const gate = -0.691 + 10 * Math.log10(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const rel = abs.filter((z) => -0.691 + 10 * Math.log10(z) > gate);
  return -0.691 + 10 * Math.log10(rel.reduce((a, b) => a + b, 0) / rel.length);
}

// ---------------------------------------------------------------------------
// pitch (YIN, FFT-accelerated difference function)
// ---------------------------------------------------------------------------

/**
 * Pitch track of x[i0 .. i1): frames every `hop` s with { t, f0 | null, conf, rms }.
 * conf is 1 - YIN aperiodicity (1 = perfectly periodic).
 */
export function yinTrack(x, sr, { i0 = 0, i1 = x.length, hop = 0.01, fmin = 50, fmax = 5000, threshold = 0.15 } = {}) {
  const W = 1 << Math.ceil(Math.log2(sr / fmin));        // integration window, covers fmin
  const N = W * 4;                                          // FFT size for the correlation
  const tauMin = Math.max(2, Math.floor(sr / fmax)), tauMax = W - 1;
  const t = tables(N), re = t.re, im = t.im;
  const are = new Float64Array(N), aim = new Float64Array(N);
  const d = new Float64Array(W), cm = new Float64Array(W);
  const frames = [];
  const h = Math.max(1, Math.round(hop * sr));
  for (let s = i0; s + W < i1 || s === i0; s += h) {
    const seg = (i) => { const j = s + i; return j >= 0 && j < x.length ? x[j] : 0; };
    let energy = 0;
    for (let i = 0; i < W; i++) energy += seg(i) * seg(i);
    const rms = Math.sqrt(energy / W);
    if (rms < 1e-5) { frames.push({ t: (s + W / 2) / sr, f0: null, conf: 0, rms }); if (s + W >= i1) break; continue; }
    // r(tau) = sum_{j<W} a_j b_{j+tau}: correlate the first W samples against 2W samples
    for (let i = 0; i < N; i++) { are[i] = i < W ? seg(i) : 0; aim[i] = 0; re[i] = i < 2 * W ? seg(i) : 0; im[i] = 0; }
    fft(are, aim); fft(re, im);
    for (let i = 0; i < N; i++) {
      const pr = re[i] * are[i] + im[i] * aim[i], pi = im[i] * are[i] - re[i] * aim[i];
      re[i] = pr; im[i] = -pi;     // conj for the inverse via forward FFT
    }
    fft(re, im);
    // energy of the shifted windows via a running sum
    let eTau = energy;
    d[0] = 0;
    for (let tau = 1; tau < W; tau++) {
      eTau += seg(tau + W - 1) * seg(tau + W - 1) - seg(tau - 1) * seg(tau - 1);
      d[tau] = Math.max(0, energy + eTau - 2 * (re[tau] / N));
    }
    cm[0] = 1;
    let run = 0;
    for (let tau = 1; tau < W; tau++) { run += d[tau]; cm[tau] = run > 0 ? d[tau] * tau / run : 1; }
    let best = -1;
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (cm[tau] < threshold) { while (tau + 1 < tauMax && cm[tau + 1] < cm[tau]) tau++; best = tau; break; }
    }
    if (best < 0) { let m = Infinity; for (let tau = tauMin; tau < tauMax; tau++) if (cm[tau] < m) { m = cm[tau]; best = tau; } }
    const a = cm[best - 1], b = cm[best], c = cm[best + 1];
    const shift = (a - c) / (2 * (a - 2 * b + c)) || 0;
    const tau = best + (Math.abs(shift) < 1 ? shift : 0);
    const conf = 1 - Math.min(1, b);
    frames.push({ t: (s + W / 2) / sr, f0: conf > 0.75 ? sr / tau : null, conf, rms });
    if (s + W >= i1) break;
  }
  return frames;
}

/**
 * YIN finds the period of the whole waveform. For several notes at once (a chord, a layered
 * octave/fifth) that is their common sub-harmonic, which nobody hears: C6+G6 has period C5.
 * When the spectrum has (almost) no energy at the YIN pitch, use the strongest partial instead.
 */
export function heardPitch(x, sr, frames, nfft = 4096) {
  const p = new Float32Array(nfft / 2 + 1), binHz = sr / nfft;
  for (const f of frames) {
    if (!f.f0) continue;
    powerSpectrum(x, Math.round(f.t * sr) - nfft / 2, nfft, p);
    let mx = 0, kmx = 0;
    for (let k = 2; k < nfft / 2 - 1; k++) if (p[k] > mx) { mx = p[k]; kmx = k; }
    const k0 = f.f0 / binHz;
    let near = 0;
    for (let k = Math.max(1, Math.floor(k0 * 0.97) - 1); k <= Math.ceil(k0 * 1.03) + 1; k++) near = Math.max(near, p[k] || 0);
    if (mx > 0 && near < mx * 0.03) {
      const a = p[kmx - 1], b = p[kmx], c = p[kmx + 1];
      const sh = (a - c) / (2 * (a - 2 * b + c)) || 0;
      f.f0 = (kmx + (Math.abs(sh) < 1 ? sh : 0)) * binHz;
      f.partial = true;
    }
  }
  return frames;
}

/** Words + numbers for a pitch track: steady / note steps / glide / warble / unpitched. */
export function describePitch(frames, { minRms = 0 } = {}) {
  const active = frames.filter((f) => f.rms > minRms);
  const voiced = active.filter((f) => f.f0);
  if (active.length < 3) return { kind: "unpitched", text: "too short to hear a pitch" };
  if (!active.length || voiced.length < Math.max(3, active.length * 0.3)) return { kind: "unpitched", text: "unpitched" };
  const m = voiced.map((f) => hzToMidi(f.f0));
  const sm = m.map((_, i) => median(m.slice(Math.max(0, i - 1), i + 2)));   // 3-point median
  const ts = voiced.map((f) => f.t);
  const hop = frames.length > 1 ? frames[1].t - frames[0].t : 0.01;
  const span = ts[ts.length - 1] - ts[0] + hop;

  // segments of roughly constant pitch
  const segs = [];
  let cur = null;
  sm.forEach((v, i) => {
    if (cur && Math.abs(v - median(cur.v)) <= 0.6 && ts[i] - cur.t1 <= hop * 3.5) { cur.v.push(v); cur.t1 = ts[i]; }
    else { cur = { v: [v], t0: ts[i], t1: ts[i] }; segs.push(cur); }
  });
  segs.forEach((s) => {
    s.m = median(s.v); s.dur = s.t1 - s.t0 + hop;
    // least-squares slope inside the segment (semitones per second): ~0 for a held note
    const n = s.v.length, mt = (n - 1) / 2, mv = s.v.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    s.v.forEach((v, i) => { num += (i - mt) * (v - mv); den += (i - mt) ** 2; });
    s.slope = den ? num / den / hop : 0;
  });
  const longest = segs.reduce((a, b) => (b.dur > a.dur ? b : a));
  const centre = median(sm);

  if (longest.dur >= span * 0.85) {
    const sorted = Float64Array.from(longest.v).sort();
    const depth = (sorted[Math.floor(sorted.length * 0.95)] - sorted[Math.floor(sorted.length * 0.05)]) / 2 * 100;
    return { kind: "steady", note: noteName(centre), hz: midiToHz(centre), vibrato: depth > 15 ? Math.round(depth) : 0,
      text: `steady ${noteName(centre)} (${fmtHz(midiToHz(centre))})${depth > 15 ? `, vibrato ±${Math.round(depth)} cents` : ""}` };
  }
  const plateaus = segs.filter((s) => s.dur >= Math.max(0.025, hop * 2.5));
  const plateauTime = plateaus.reduce((a, s) => a + s.dur, 0);
  const slopes = plateaus.map((s) => Math.abs(s.slope));
  // many short one-semitone plateaus in a row are a slow glide sampled by the frames, not notes
  const crawl = plateaus.length >= 3 && median(plateaus.map((p) => p.dur)) < 0.06 &&
    plateaus.every((p, i) => !i || Math.abs(Math.round(p.m) - Math.round(plateaus[i - 1].m)) <= 1);
  const gliding = (slopes.length && median(slopes) > 4) || crawl;
  if (!gliding && plateaus.length >= 2 && plateauTime >= span * 0.6) {
    const notes = [];
    for (const p of plateaus) { const n = noteName(p.m); if (notes[notes.length - 1]?.n !== n) notes.push({ n, m: p.m, t: p.t0 }); }
    if (notes.length >= 2) {
      let up = 0, down = 0, turns = 0, lastDir = 0;
      for (let i = 1; i < notes.length; i++) {
        const dir = Math.sign(notes[i].m - notes[i - 1].m);
        if (dir > 0) up++; else if (dir < 0) down++;
        if (dir && lastDir && dir !== lastDir) turns++;
        if (dir) lastDir = dir;
      }
      const over = notes[notes.length - 1].t - notes[0].t;
      if (turns >= 3) {
        const lo = notes.reduce((a, b) => (b.m < a.m ? b : a)).n, hi = notes.reduce((a, b) => (b.m > a.m ? b : a)).n;
        return { kind: "warble", notes: notes.map((x) => x.n), text: `warbles ${lo}↔${hi} (${turns + 1} turns in ${fmtS(over)})` };
      }
      const verb = !down ? "rises" : !up ? "falls" : "moves";
      const shown = notes.length > 8 ? [...notes.slice(0, 4).map((x) => x.n), "…", ...notes.slice(-3).map((x) => x.n)] : notes.map((x) => x.n);
      return { kind: "notes", direction: verb, notes: notes.map((x) => x.n), over, text: `${verb} ${shown.join("→")} over ${fmtS(over)}` };
    }
  }
  const head = median(sm.slice(0, 3)), tail = median(sm.slice(-3));
  // count direction reversals of the smoothed contour (arp loops, sirens)
  let turns = 0, dir = 0;
  for (let i = 3; i < sm.length; i += 3) {
    const dd = sm[i] - sm[i - 3];
    if (Math.abs(dd) < 0.5) continue;
    const s = Math.sign(dd);
    if (dir && s !== dir) turns++;
    dir = s;
  }
  if (turns >= 4) {
    const lo = Math.min(...sm), hi = Math.max(...sm);
    return { kind: "warble", text: `warbles ${noteName(lo)}↔${noteName(hi)} (${turns + 1} turns in ${fmtS(span)})` };
  }
  if (Math.abs(tail - head) >= 1) {
    const verb = tail > head ? "rises" : "falls";
    const f0 = midiToHz(head), f1 = midiToHz(tail);
    return { kind: verb === "rises" ? "rise" : "fall", from: f0, to: f1, over: span,
      text: `${verb} ${Math.round(f0)}→${Math.round(f1)} Hz (${noteName(head)}→${noteName(tail)}) over ${fmtS(span)}` };
  }
  return { kind: "steady", note: noteName(centre), hz: midiToHz(centre), vibrato: 0, text: `hovers around ${noteName(centre)} (${fmtHz(midiToHz(centre))})` };
}

// ---------------------------------------------------------------------------
// spectrum: brightness and tonality
// ---------------------------------------------------------------------------

/** A-weighting as a power factor (the ear's reduced sensitivity to lows and extreme highs). */
function aWeight(f) {
  const f2 = f * f;
  const ra = (148693636 * f2 * f2) / ((f2 + 424.36) * Math.sqrt((f2 + 11599.29) * (f2 + 544496.41)) * (f2 + 148693636));
  return ra * ra * 1.585;
}

/**
 * Brightness centroid (Hz) and spectral flatness over x[i0..i1), plus the centroid at the start and end.
 * The centroid is perceptual: A-weighted power, averaged on a log-frequency axis, so a sub-bass
 * layer or a gentle high-frequency tail doesn't dominate it.
 */
export function spectralStats(x, sr, i0 = 0, i1 = x.length, nfft = 2048) {
  const hop = nfft / 4, binHz = sr / nfft;
  const kLo = Math.max(1, Math.round(60 / binHz)), kHi = Math.min(nfft / 2, Math.round(Math.min(16000, sr * 0.45) / binHz));
  const kMid = Math.round(200 / binHz);
  const aw = new Float32Array(nfft / 2 + 1), lf = new Float32Array(nfft / 2 + 1);
  for (let k = 1; k <= nfft / 2; k++) { aw[k] = aWeight(k * binHz); lf[k] = Math.log(k * binHz); }
  const p = new Float32Array(nfft / 2 + 1);
  let wC = 0, wF = 0, wSum = 0;
  const cents = [];
  for (let s = i0 - nfft / 2; s < i1 - nfft / 2 || s === i0 - nfft / 2; s += hop) {
    powerSpectrum(x, s, nfft, p);
    let e = 0, wsum = 0, wlog = 0, mx = 0;
    for (let k = kLo; k <= kHi; k++) {
      const w = p[k] * aw[k];
      e += p[k]; wsum += w; wlog += w * lf[k];
      if (p[k] > mx) mx = p[k];
    }
    if (e <= 1e-14) continue;
    // flatness: a sub-bass thump under a noise burst shouldn't make the burst "tonal"
    let eHi = 0;
    for (let k = kMid; k <= kHi; k++) eHi += p[k];
    const k0 = eHi >= e * 0.1 ? kMid : kLo, eF = eHi >= e * 0.1 ? eHi : e;
    // Measure over the band that holds 95% of that energy: a low-passed noise
    // (explosions, thuds) is flat inside its passband, and the empty bins above
    // the cutoff mustn't drag its geometric mean (and the shown flatness) to 0.
    let k1 = kHi;
    for (let k = k0, acc = 0; k <= kHi; k++) { acc += p[k]; if (acc >= eF * 0.95) { k1 = Math.max(k, k0 + 7); break; } }
    k1 = Math.min(k1, kHi);
    let lg = 0, eB = 0;
    const eps = mx * 1e-10;
    for (let k = k0; k <= k1; k++) { lg += Math.log(p[k] + eps); eB += p[k]; }
    const nb = k1 - k0 + 1;
    const flat = eB > 0 ? Math.exp(lg / nb) / (eB / nb) : 0;
    const c = wsum > 0 ? Math.exp(wlog / wsum) : 0;
    wC += c * e; wF += flat * e; wSum += e;
    cents.push({ c, e });
  }
  if (!wSum) return { centroid: 0, flatness: 0, centroidStart: 0, centroidEnd: 0 };
  const part = (list) => { const s = list.reduce((a, b) => a + b.e, 0); return s ? list.reduce((a, b) => a + b.c * b.e, 0) / s : 0; };
  const q = Math.max(1, Math.floor(cents.length / 4));
  return { centroid: wC / wSum, flatness: wF / wSum, centroidStart: part(cents.slice(0, q)), centroidEnd: part(cents.slice(-q)) };
}

/** Brightness from the spectral centroid; very high centroids are "harsh" only for tones (noise up there is hiss). */
export function brightnessWord(centroid, noisy = false) {
  if (centroid < 350) return "dark";
  if (centroid < 1200) return "warm";
  if (centroid < 5000 || noisy) return "bright";
  return "harsh";
}
/** Tonal vs noisy from periodicity: the share of audible frames with a clear pitch (YIN). */
export const tonalityWord = (periodic) => (periodic >= 0.7 ? "tonal" : periodic >= 0.3 ? "mixed tone+noise" : "noisy");

// ---------------------------------------------------------------------------
// one sound
// ---------------------------------------------------------------------------

/** A sound's shape word from its attack, time to peak, length (seconds) and share held within 6 dB of its peak. */
function shapeOf(attack, toPeak, length, holdFrac) {
  if (attack >= Math.max(0.06, length * 0.3) || (attack >= 0.03 && toPeak >= Math.max(0.12, length * 0.3))) return "swell";
  if (length < 0.07) return "clicky";
  if (attack <= 0.025 && length < 0.25) return "punchy";
  if (holdFrac >= 0.5 && length >= 0.15) return "sustained";
  if (attack <= 0.025) return "plucky";
  return "soft";
}

/**
 * Analyze one sound rendered on its own. `channels` = [L, R] (or [mono]).
 * Times are relative to the start of the buffer.
 */
export function analyzeEvent(channels, sr, { envWin = 0.005 } = {}) {
  const x = mono(channels), len = channels[0].length;
  let peak = 0, clipped = 0;
  for (const ch of channels) for (let i = 0; i < len; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; if (a >= 0.999) clipped++; }
  if (peak < 1e-5) return { silent: true, peakDb: -Infinity, text: "silent" };
  const env = envelope(channels, sr, envWin);
  let emax = 0, imax = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > emax) { emax = env[i]; imax = i; }
  const thr = emax * 0.01;   // -40 dB under its peak
  let on = 0, off = env.length - 1;
  while (on < env.length && env[on] <= thr) on++;
  while (off > on && env[off] <= thr) off--;
  const tOn = on * envWin, tOff = (off + 1) * envWin, length = tOff - tOn;
  // attack on a 1 ms envelope: from the first audible millisecond to within 1 dB of the peak
  const fine = envelope(channels, sr, 0.001);
  let fmax = 0, fpk = 0;
  for (let i = 0; i < fine.length; i++) if (fine[i] > fmax) { fmax = fine[i]; fpk = i; }
  let f0 = 0;
  while (f0 < fpk && fine[f0] <= fmax * 0.01) f0++;
  // attack: until the level is within 10 dB of its peak and no longer rising fast (>5% per ms)
  let f1 = f0;
  while (f1 < fpk && fine[f1] < fmax * 0.316) f1++;
  while (f1 < fpk && fine[f1 + 1] > fine[f1] * 1.05) f1++;
  const attack = Math.max(0.001, (f1 - f0 + 1) * 0.001);
  const toPeak = (fpk - f0 + 1) * 0.001;
  let d20 = imax;
  while (d20 < env.length && env[d20] > emax * 0.1) d20++;
  // hold: share of the sound within 6 dB of its peak, on a 25 ms-smoothed envelope (noise flickers)
  let hold = 0;
  const sm = new Float32Array(env.length);
  const rad = (off - on) * envWin > 0.3 ? 2 : 0;
  for (let i = 0; i < env.length; i++) { let s = 0, c = 0; for (let j = Math.max(0, i - rad); j <= Math.min(env.length - 1, i + rad); j++) { s += env[j]; c++; } sm[i] = s / c; }
  const smax = Math.max(...sm);
  for (let i = on; i <= off; i++) if (sm[i] >= smax * 0.5) hold++;
  const holdFrac = hold / Math.max(1, off - on + 1);
  const shape = shapeOf(attack, toPeak, length, holdFrac);

  const i0 = Math.floor(tOn * sr), i1 = Math.min(len, Math.ceil(tOff * sr));
  let s2 = 0;
  for (const ch of channels) for (let i = i0; i < i1; i++) s2 += ch[i] * ch[i];
  const rms = Math.sqrt(s2 / Math.max(1, (i1 - i0) * channels.length));

  const frames = heardPitch(x, sr, yinTrack(x, sr, { i0, i1 }));
  const pitch = describePitch(frames, { minRms: emax * 0.05 });
  const audible = frames.filter((f) => f.rms > emax * 0.05);
  const periodic = audible.length ? audible.filter((f) => f.f0).length / audible.length : 0;
  const spec = spectralStats(x, sr, i0, i1);
  let sweep = null;
  if (pitch.kind === "unpitched" && spec.centroidStart && spec.centroidEnd) {
    const ratio = spec.centroidEnd / spec.centroidStart;
    if (ratio > 1.6 || ratio < 0.62) {
      sweep = `brightness ${ratio > 1 ? "rises" : "falls"} ${fmtHz(spec.centroidStart)}→${fmtHz(spec.centroidEnd)}`;
    }
  }
  let pan = 0;
  if (channels.length === 2) {
    let l = 0, r = 0;
    for (let i = i0; i < i1; i++) { l += channels[0][i] * channels[0][i]; r += channels[1][i] * channels[1][i]; }
    l = Math.sqrt(l); r = Math.sqrt(r);
    pan = l + r > 0 ? (r - l) / (r + l) : 0;
  }
  const loud = loudnessCurve(channels, sr, 0.1, 0.02);
  const loudness = Math.max(...loud.lufs);   // short-term peak loudness (100 ms windows)
  // a compact envelope for drawing (dB, 100 points over the audible span)
  const shapeDb = [];
  for (let k = 0; k < 100; k++) {
    const i = on + Math.floor((k / 100) * (off - on + 1));
    shapeDb.push(Math.round(dB(env[i] / emax) * 10) / 10);
  }
  return {
    silent: false, start: tOn, length, peakDb: dB(peak), rmsDb: dB(rms), loudness, attack, decay20: (d20 - imax) * envWin,
    hold: holdFrac, shape, pitch, centroid: spec.centroid, flatness: spec.flatness, periodic,
    brightness: brightnessWord(spec.centroid, periodic < 0.3), tonality: tonalityWord(periodic),
    sweep, clipped, pan, envelope: shapeDb,
  };
}

/** One line of plain language for an analyzed event. */
export function describeEvent(a) {
  if (a.silent) return "SILENT (nothing audible)";
  const bits = a.ownBands ? [   // heard under another sound, measured on the bands it added (see analyzePCM)
    `${fmtS(a.length)} ${a.shape} (attack ${fmtS(a.attack)})`,
    `${a.brightness} (centroid ${fmtHz(a.centroid)})`,
    `peak ${r1(a.peakDb)} dBFS, ${r1(a.loudness)} LUFS in its own bands ${fmtHz(a.ownBands[0])}–${fmtHz(a.ownBands[1])}`,
  ] : [
    `${fmtS(a.length)} ${a.shape} (attack ${fmtS(a.attack)})`,
    a.pitch.kind === "unpitched" ? (a.sweep || "unpitched") : a.pitch.text,
    `${a.brightness} (centroid ${fmtHz(a.centroid)})`,
    `${a.tonality} (${Math.round(a.periodic * 100)}% pitched, flatness ${a.flatness.toFixed(2)})`,
    `peak ${r1(a.peakDb)} dBFS, RMS ${r1(a.rmsDb)} dBFS, ${r1(a.loudness)} LUFS`,
  ];
  if (Math.abs(a.pan) > 0.08) bits.push(`panned ${Math.round(Math.abs(a.pan) * 100)}% ${a.pan < 0 ? "left" : "right"}`);
  if (a.clipped) bits.push(`CLIPS (${a.clipped} samples at full scale)`);
  return bits.join(" · ");
}

// ---------------------------------------------------------------------------
// music: tempo, key, chords
// ---------------------------------------------------------------------------

/** Spectral-flux onset strength, `rate` frames per second. */
export function onsetEnvelope(x, sr, nfft = 1024, hop = 256) {
  const kHi = Math.round(8000 / (sr / nfft));
  const p = new Float32Array(nfft / 2 + 1), prev = new Float32Array(nfft / 2 + 1);
  const out = [];
  for (let s = 0; s + nfft <= x.length; s += hop) {
    powerSpectrum(x, s, nfft, p);
    let flux = 0;
    for (let k = 1; k <= kHi; k++) {
      const v = Math.log1p(1000 * Math.sqrt(p[k]));
      if (v > prev[k]) flux += v - prev[k];
      prev[k] = v;
    }
    out.push(flux);
  }
  if (out.length) out[0] = 0;
  return { env: Float32Array.from(out), rate: sr / hop };
}

/**
 * Tempo from the autocorrelation of the onset envelope, with a gentle prior around 120 bpm.
 * With `declared` (the bpm the music was written at), that tempo is confirmed when its
 * autocorrelation peak is at least 70% as strong as the best one: patterns with syncopated
 * accents often have a slightly stronger 2/3 or 3/2 periodicity that no listener would tap.
 */
export function estimateTempo(x, sr, declared = 0) {
  const { env, rate } = onsetEnvelope(x, sr);
  if (env.length < rate * 2) return { bpm: 0, confidence: 0 };
  // remove the slow trend so sustained loudness doesn't count as rhythm
  const w = Math.round(rate * 0.4), o = new Float32Array(env.length);
  let acc = 0;
  for (let i = 0; i < env.length; i++) {
    acc += env[i]; if (i >= w) acc -= env[i - w];
    o[i] = Math.max(0, env[i] - acc / Math.min(i + 1, w));
  }
  const lagMin = Math.floor(rate * 60 / 220), lagMax = Math.ceil(rate * 60 / 50);
  const ac = new Float64Array(lagMax + 2);
  for (let lag = 0; lag <= lagMax + 1; lag++) {
    let s = 0;
    for (let i = lag; i < o.length; i++) s += o[i] * o[i - lag];
    ac[lag] = s / (o.length - lag);
  }
  let best = -1, bestV = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const bpm = 60 * rate / lag;
    const v = ac[lag] * Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120), 2));
    if (v > bestV && ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1]) { bestV = v; best = lag; }
  }
  if (best < 0) return { bpm: 0, confidence: 0 };
  if (declared > 0) {
    const dl = rate * 60 / declared;
    let peak = -1;
    for (let lag = Math.max(lagMin, Math.floor(dl * 0.97)); lag <= Math.min(lagMax, Math.ceil(dl * 1.03)); lag++) if (peak < 0 || ac[lag] > ac[peak]) peak = lag;
    if (peak > 0 && ac[peak] >= ac[best] * 0.7) best = peak;
  }
  const a = ac[best - 1], b = ac[best], c = ac[best + 1];
  const shift = (a - c) / (2 * (a - 2 * b + c)) || 0;
  const lag = best + (Math.abs(shift) < 1 ? shift : 0);
  return { bpm: 60 * rate / lag, confidence: ac[0] > 0 ? b / ac[0] : 0 };
}

/** Chroma (12 pitch-class energies) per frame, plus a bass-register chroma. */
export function chromagram(x, sr, nfft = 8192, hop = 2048) {
  const binHz = sr / nfft, p = new Float32Array(nfft / 2 + 1);
  const map = [];
  for (let k = 1; k <= nfft / 2; k++) {
    const f = k * binHz;
    if (f < 55 || f > 5000) continue;
    map.push([k, ((Math.round(hzToMidi(f)) % 12) + 12) % 12, f < 260]);
  }
  const frames = [];
  for (let s = 0; s + nfft <= Math.max(x.length, nfft); s += hop) {
    powerSpectrum(x, s, nfft, p);
    const c = new Float32Array(12), bass = new Float32Array(12);
    for (const [k, pc, low] of map) { const a = Math.sqrt(p[k]); c[pc] += a; if (low) bass[pc] += a; }
    frames.push({ t: (s + nfft / 2) / sr, c, bass });
  }
  return frames;
}

/**
 * Power spectrum of x over [t0, t1) across Hann frames (75% overlap): the per-bin mean, or a
 * percentile (0..1) — e.g. 0.5 keeps sustained notes and drops isolated drum hits.
 */
export function averageSpectrum(x, sr, t0, t1, nfft = 8192, percentile = null) {
  const frames = [];
  const end = Math.min(x.length, Math.ceil(t1 * sr));
  for (let s = Math.floor(t0 * sr); s + nfft <= end || (!frames.length && s < x.length); s += nfft / 4) frames.push(powerSpectrum(x, s, nfft));
  const out = new Float64Array(nfft / 2 + 1), col = new Float64Array(frames.length);
  for (let k = 0; k < out.length; k++) {
    if (percentile === null) { let sum = 0; for (const f of frames) sum += f[k]; out[k] = sum / frames.length; continue; }
    for (let i = 0; i < frames.length; i++) col[i] = frames[i][k];
    col.sort();
    out[k] = col[Math.min(col.length - 1, Math.floor(col.length * percentile))];
  }
  return out;
}

/**
 * The notes sounding in a power spectrum, strongest first (iterative harmonic-salience
 * estimation: find the pitch whose harmonic series is strongest, remove it, repeat).
 * Raw chroma would count a square wave's 3rd and 5th harmonics as a fifth and a major third.
 * Feed it pitched material only (drums-free music is best; Lumen renders a stem without them):
 * a kick drum's swept sine reads as low notes.
 */
export function notesInSpectrum(P, sr, nfft, { lo = 36, hi = 96, maxNotes = 6, harmonics = 10 } = {}) {
  const binHz = sr / nfft;
  const A = Float64Array.from(P, (v) => Math.sqrt(v));
  const peakNear = (f) => {
    const k = f / binHz, w = Math.max(0.6, k * 0.0145);   // ± a quarter semitone
    let m = 0;
    for (let i = Math.max(1, Math.floor(k - w)); i <= Math.min(A.length - 1, Math.ceil(k + w)); i++) if (A[i] > m) m = A[i];
    return m;
  };
  const top = Math.max(...A);
  const notes = [];
  let first = 0;
  for (let round = 0; round < maxNotes; round++) {
    let best = -1, bestS = 0;
    for (let m = lo; m <= hi; m++) {
      // below C4, short (pumping) bass notes smear over their neighbours: never a semitone cluster
      if (notes.some((n) => n.midi === m || (Math.abs(n.midi - m) === 1 && Math.min(n.midi, m) < 60))) continue;
      const f0 = midiToHz(m);
      const fund = peakNear(f0);
      if (fund < top * 0.03) continue;   // a note needs its own fundamental
      let sal = 0;
      for (let h = 1; h <= harmonics && h * f0 < sr * 0.45; h++) sal += peakNear(h * f0) / Math.sqrt(h);
      if (sal > bestS) { bestS = sal; best = m; }
    }
    if (best < 0 || (first && bestS < first * 0.12)) break;
    if (!first) first = bestS;
    notes.push({ midi: best, name: noteName(best), salience: bestS / first });
    const f0 = midiToHz(best);
    for (let h = 1; h <= harmonics && h * f0 < sr * 0.45; h++) {
      const k = (h * f0) / binHz, w = Math.max(1.5, k * 0.0145);
      for (let i = Math.max(1, Math.floor(k - w)); i <= Math.min(A.length - 1, Math.ceil(k + w)); i++) A[i] *= 0.15;
    }
  }
  return notes;
}

/** Chroma (and the lowest note's pitch class as the bass) from detected notes. */
function notesChroma(notes) {
  const c = new Float32Array(12), bass = new Float32Array(12);
  for (const n of notes) c[((n.midi % 12) + 12) % 12] += Math.sqrt(n.salience);
  if (notes.length) bass[((Math.min(...notes.map((n) => n.midi)) % 12) + 12) % 12] = 1;
  return { c, bass };
}

const HN = 32768;   // harmony FFT: ~1.5 Hz bins at 48 kHz, 3 bins per semitone even at C2

const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a, b) {
  const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Key from a chroma sum (Krumhansl–Kessler profiles), with the runner-up. */
export function estimateKey(chroma) {
  const res = [];
  for (let t = 0; t < 12; t++) {
    const rot = Array.from({ length: 12 }, (_, i) => chroma[(i + t) % 12]);
    res.push({ key: `${NOTE_NAMES[t]} major`, r: pearson(rot, KK_MAJOR) });
    res.push({ key: `${NOTE_NAMES[t]} minor`, r: pearson(rot, KK_MINOR) });
  }
  res.sort((a, b) => b.r - a.r);
  return { key: res[0].key, r: res[0].r, runnerUp: res[1].key, runnerUpR: res[1].r };
}

const CHORD_TYPES = [["", [0, 4, 7], 1], ["m", [0, 3, 7], 1], ["7", [0, 4, 7, 10], 0.97], ["maj7", [0, 4, 7, 11], 0.97],
  ["m7", [0, 3, 7, 10], 0.97], ["dim", [0, 3, 6], 0.96], ["sus4", [0, 5, 7], 0.96], ["6", [0, 4, 7, 9], 0.95]];

/** Best chord name for a chroma vector (cosine vs templates, small bonus when the bass agrees). */
export function matchChord(c, bass) {
  const norm = Math.hypot(...c);
  if (!norm) return null;
  const bmax = bass ? Math.max(...bass) : 0;
  const scores = [];
  for (let root = 0; root < 12; root++) {
    for (const [q, iv, w] of CHORD_TYPES) {
      let dot = 0;
      for (const i of iv) dot += c[(root + i) % 12];
      let s = (dot / (norm * Math.sqrt(iv.length))) * w;
      if (bmax > 0) s += 0.08 * (bass[root] / bmax);
      scores.push({ name: NOTE_NAMES[root] + q, score: s });
    }
  }
  scores.sort((a, b) => b.score - a.score);
  const alt = scores[1].score > scores[0].score - 0.015 ? scores[1].name : null;
  return { name: scores[0].name, score: scores[0].score, alt };
}

/**
 * Music analysis over [t0, t1) of a music-only render.
 * @param grid     { start, bpm, beats } — the declared bar grid (when the game declares it), optional
 * @param harmony  the same music without drums (for key and chords); defaults to `channels`
 */
export function analyzeMusic(channels, sr, { t0 = 0, t1, grid = null, maxBars = 16, harmony = null } = {}) {
  const x0 = mono(channels);
  const i0 = Math.max(0, Math.floor(t0 * sr)), i1 = Math.min(x0.length, Math.floor((t1 ?? x0.length / sr) * sr));
  const x = x0.subarray(i0, i1);
  const hx = harmony ? mono(harmony).subarray(i0, i1) : x;
  const tempo = estimateTempo(x, sr, grid ? grid.bpm : 0);
  const dur = x.length / sr;
  // key: notes heard in 1-second blocks, accumulated as chroma
  const sum = new Float32Array(12);
  for (let t = 0; t + 0.5 < dur; t += 1) {
    const { c } = notesChroma(notesInSpectrum(averageSpectrum(hx, sr, t, Math.min(dur, t + 1), HN), sr, HN));
    for (let i = 0; i < 12; i++) sum[i] += c[i];
  }
  const key = estimateKey(sum);
  const loud = loudnessCurve([x], sr, 0.4, 0.1);
  const bpm = grid ? grid.bpm : tempo.bpm;
  const bars = [];
  if (bpm > 0) {
    const barLen = (grid ? grid.beats : 4) * 60 / bpm;
    const start = grid ? grid.start - t0 : 0;
    for (let b = 0; b < maxBars; b++) {
      const bs = start + b * barLen, be = bs + barLen;
      if (be > x.length / sr + 0.05) break;
      if (be <= 0) continue;
      let lsum = 0, ln = 0;
      const heard = notesInSpectrum(averageSpectrum(hx, sr, Math.max(0, bs + barLen * 0.1), Math.min(dur, be - barLen * 0.05), HN), sr, HN);
      const { c, bass } = notesChroma(heard);
      loud.times.forEach((tt, i) => { if (tt >= bs && tt < be) { lsum += loud.lufs[i]; ln++; } });
      const ch = matchChord(c, bass);
      bars.push({ bar: b + 1, t: bs + t0, chord: ch ? ch.name : "—", alt: ch && ch.alt, score: ch ? ch.score : 0,
        notes: heard.slice(0, 6).map((n) => n.name), loudness: ln ? lsum / ln : -120, chroma: Array.from(c) });
    }
  }
  // changes: big jumps in harmony + loudness between consecutive bars
  const changes = [];
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1], b = bars[i];
    const na = Math.hypot(...a.chroma) || 1, nb = Math.hypot(...b.chroma) || 1;
    let dot = 0;
    for (let k = 0; k < 12; k++) dot += a.chroma[k] * b.chroma[k];
    const dl = b.loudness - a.loudness;
    if (Math.abs(dl) >= 4) changes.push({ bar: b.bar, t: b.t, text: `${dl > 0 ? "louder" : "quieter"} by ${r1(Math.abs(dl))} dB` });
  }
  const valid = loud.lufs.filter((v) => v > -70);
  return {
    tempo: Math.round(tempo.bpm * 10) / 10, tempoConfidence: tempo.confidence, key: key.key, keyR: key.r, keyRunnerUp: key.runnerUp,
    bars: bars.map(({ chroma: _c, ...b }) => b), changes,
    loudness: valid.length ? integratedLoudness([x], sr, loud) : -Infinity,
    loudnessRange: valid.length ? Math.max(...valid) - Math.min(...valid) : 0,
  };
}

/**
 * Turn a monophonic stem into pattern notation on a step grid.
 * @returns tokens like ["E5", "-", "G5", "_"]
 */
export function transcribe(channels, sr, { start, step, steps }) {
  const x = mono(channels);
  const frames = yinTrack(x, sr, { i0: Math.max(0, Math.floor(start * sr)), i1: Math.min(x.length, Math.ceil((start + step * steps) * sr) + 2048) });
  const env = envelope([x], sr, 0.005);
  const eAt = (t0, t1) => { let m = 0; for (let i = Math.max(0, Math.floor(t0 / 0.005)); i < Math.min(env.length, Math.ceil(t1 / 0.005)); i++) m = Math.max(m, env[i]); return m; };
  const eMin = (t0, t1) => { let m = Infinity; for (let i = Math.max(0, Math.floor(t0 / 0.005)); i < Math.min(env.length, Math.ceil(t1 / 0.005)); i++) m = Math.min(m, env[i]); return m === Infinity ? 0 : m; };
  const peak = Math.max(...env);
  const { env: flux, rate } = onsetEnvelope(x, sr);
  const fluxMed = median(Array.from(flux).filter((v) => v > 0)) || 1;
  const fluxAt = (t0, t1) => { let m = 0; for (let i = Math.max(0, Math.floor(t0 * rate)); i <= Math.min(flux.length - 1, Math.ceil(t1 * rate)); i++) m = Math.max(m, flux[i]); return m; };
  const out = [];
  let last = null;
  for (let s = 0; s < steps; s++) {
    const a = start + s * step, b = a + step;
    const level = eAt(a + step * 0.15, a + step * 0.6);
    if (level < peak * 0.05) { out.push("_"); last = null; continue; }
    const f = frames.filter((fr) => fr.f0 && fr.t >= a + Math.min(0.02, step * 0.2) && fr.t < a + step * 0.7).map((fr) => hzToMidi(fr.f0));
    if (!f.length) { out.push(last ? "-" : "?"); continue; }
    const n = noteName(median(f));
    const onset = fluxAt(a - 0.012, a + 0.03) > 4 * fluxMed && eAt(a + 0.005, a + Math.min(0.045, step * 0.5)) > 1.3 * eMin(a - 0.03, a + 0.004);
    if (last === n && !onset) out.push("-");
    else { out.push(n); last = n; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// the mix
// ---------------------------------------------------------------------------

/**
 * @param mix     [L, R] of everything
 * @param music   [L, R] of the music alone, or null
 * @param events  [{ t, label, src, analysis }] sounds (analysis from analyzeEvent on an isolated render)
 * @param opts    { duration, audition }
 */
export function analyzeMix(mix, sr, music, events, { duration, audition = false } = {}) {
  const len = mix[0].length;
  let peak = 0, clipped = 0;
  for (const ch of mix) for (let i = 0; i < len; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; if (a >= 0.999) clipped++; }
  const curve = loudnessCurve(mix, sr, 0.4, 0.1);
  const integrated = integratedLoudness(mix, sr, curve);
  const mcurve = music ? loudnessCurve(music, sr, 0.4, 0.1) : null;
  const musicAt = (t0, t1) => {
    if (!mcurve) return -120;
    let m = -120;
    mcurve.times.forEach((t, i) => { if (t >= t0 && t <= t1) m = Math.max(m, mcurve.lufs[i]); });
    return m;
  };
  const problems = [];
  const add = (severity, text) => problems.push({ severity, text });
  if (clipped) add(1, `the mix clips: ${clipped} samples at full scale (peak ${r1(dB(peak))} dBFS) → lower the master volume or the loudest sounds`);

  const sounds = events.filter((e) => e.analysis);
  const masked = new Map();   // label -> worst masking, reported once per sound
  for (const e of sounds) {
    const a = e.analysis;
    if (a.silent) { add(1, `${e.label} at ${e.t.toFixed(2)} s is silent → check its volume and envelope`); continue; }
    if (a.clipped) add(1, `${e.label} at ${e.t.toFixed(2)} s clips on its own (${a.clipped} samples) → lower its volume`);
    const bed = musicAt(e.t, e.t + Math.max(0.4, a.length));
    e.musicLoudness = bed;
    if (bed > -60 && a.loudness < bed - 3) {
      const under = bed - a.loudness, prev = masked.get(e.label);
      if (!prev || under > prev.under) masked.set(e.label, { e, under, bed, count: (prev ? prev.count : 0) + 1 });
      else prev.count++;
    }
  }
  for (const { e, under, bed, count } of masked.values()) {
    add(2, `${e.label} at ${e.t.toFixed(2)} s is ${r1(under)} dB under the music (${r1(e.analysis.loudness)} vs ${r1(bed)} LUFS)${count > 1 ? ` (${count} times)` : ""} and may be masked → ${volumeAdvice(e, under + 3)}, or lower the music volume`);
  }
  // loudness spread across distinct sounds (not one measured on its own bands under another: part of its energy)
  const byLabel = new Map();
  for (const e of sounds) if (!e.analysis.silent && !e.analysis.ownBands && !byLabel.has(e.label)) byLabel.set(e.label, e.analysis.loudness);
  if (byLabel.size >= 3) {
    const med = median([...byLabel.values()]);
    for (const [label, l] of byLabel) {
      const e = sounds.find((x) => x.label === label);
      if (l > med + 8) add(3, `${label} is ${r1(l - med)} dB louder than the typical sound (${r1(l)} vs ${r1(med)} LUFS) → ${volumeAdvice(e, -(l - med - 3))}`);
      if (l < med - 8 && !masked.has(label)) add(3, `${label} is ${r1(med - l)} dB quieter than the typical sound (${r1(l)} vs ${r1(med)} LUFS) → ${volumeAdvice(e, med - l - 3)}`);
    }
  }
  // long silences inside the run
  const silences = [];
  if (!audition && duration > 3) {
    let s0 = null;
    curve.times.forEach((t, i) => {
      const quiet = curve.lufs[i] < -55 && t <= duration;
      if (quiet && s0 === null) s0 = t;
      if ((!quiet || i === curve.times.length - 1 || t > duration) && s0 !== null) {
        const t1 = Math.min(t, duration);
        if (t1 - s0 >= 2) silences.push([Math.max(0, s0 - 0.2), t1]);
        s0 = null;
      }
    });
    for (const [a, b] of silences) add(3, `silence from ${a.toFixed(1)} to ${b.toFixed(1)} s (${r1(b - a)} s with nothing audible)${music ? "" : " → music or ambience would fill it"}`);
  }
  if (Number.isFinite(integrated)) {
    if (integrated < -30) add(3, `the mix is quiet overall (${r1(integrated)} LUFS; games usually sit around -16 to -23) → raise the master volume or the sounds`);
    if (integrated > -9) add(2, `the mix is very loud (${r1(integrated)} LUFS) → lower the master volume or the music`);
  }
  problems.sort((a, b) => a.severity - b.severity);
  return { peakDb: dB(peak), clipped, integrated, loudness: curve, musicLoudness: mcurve, silences, problems };
}

/**
 * Advice for a change of `db` decibels: "set volume: 0.6 (now 0.15)" when the call's own volume
 * is known (e.volume), otherwise "raise it by about 9 dB (gain ×2.8)".
 */
function volumeAdvice(e, db) {
  if (!e || typeof e.volume !== "number") {
    const gain = Math.pow(10, db / 20);
    return `${db >= 0 ? "raise" : "lower"} it by about ${r1(Math.abs(db))} dB (gain ×${gain >= 10 ? Math.round(gain) : +gain.toFixed(2)})`;
  }
  const now = e.volume;
  const want = now * Math.pow(10, db / 20);
  if (want > 4) return `set volume: 4 (the maximum; now ${+now.toFixed(2)}) and make the sound itself louder`;
  return `set volume: ${want >= 1 ? want.toFixed(1) : want.toFixed(2)} (now ${+now.toFixed(2)}; ${db > 0 ? "+" : ""}${r1(db)} dB)`;
}

// ---------------------------------------------------------------------------
// the report
// ---------------------------------------------------------------------------

/**
 * report = { title, duration, sampleRate, mix, events: [{t, label, src, kind, analysis, count?}],
 *            music: [{ t, end, label, declared: {bpm, key?, chords?, lead?}, analysis, heardLead, writtenLead, match }], files }
 */
export function formatReport(rep) {
  const L = [];
  const m = rep.mix;
  const nSounds = rep.events.length;
  L.push(`♪ ${rep.title} — ${rep.duration.toFixed(2)} s rendered (${rep.sampleRate / 1000} kHz stereo): ${nSounds} sound${nSounds === 1 ? "" : "s"}, ${rep.music.length} music track${rep.music.length === 1 ? "" : "s"}`);
  L.push(`Mix: peak ${r1(m.peakDb)} dBFS · integrated ${Number.isFinite(m.integrated) ? r1(m.integrated) + " LUFS" : "silent"} · ${m.clipped ? `CLIPS (${m.clipped} samples)` : "no clipping"}`);
  for (const mu of rep.music) {
    const a = mu.analysis;
    L.push("");
    L.push(`Music ${mu.label.replace(/^music /, "")} (${mu.t.toFixed(2)}–${mu.end.toFixed(2)} s)${mu.src ? `  ${mu.src}` : ""}`);
    if (!a) { L.push("  (too short to analyze)"); continue; }
    const d = mu.declared || {};
    let tempoNote = "";
    if (d.bpm && a.tempo) {
      const ratio = a.tempo / d.bpm;
      tempoNote = Math.abs(ratio - 1) < 0.03 ? ` (declared ${d.bpm} ✓)`
        : Math.abs(ratio - 2) < 0.06 ? ` (declared ${d.bpm}: the beat feels double-time)`
        : Math.abs(ratio - 0.5) < 0.03 ? ` (declared ${d.bpm}: the beat feels half-time)`
        : ` (declared ${d.bpm}: MISMATCH)`;
    }
    const pitched = a.bars.some((b) => b.chord !== "—") && a.keyR > 0.2;   // drums-only music has no key or chords
    L.push(`  tempo ${a.tempo ? r1(a.tempo) + " bpm" : "unclear"}${tempoNote} · ${pitched ? `key ${a.key} (r=${a.keyR.toFixed(2)}; next ${a.keyRunnerUp})` : "no pitched parts"} · loudness ${r1(a.loudness)} LUFS, range ${r1(a.loudnessRange)} dB`);
    if (a.bars.length && pitched) {
      L.push(`  chords by bar: ${a.bars.map((b) => b.chord + (b.alt ? `/${b.alt}` : "") + (b.score < 0.8 ? "?" : "")).join(" | ")}${a.bars.some((b) => b.score < 0.8) ? "   (? = unsure)" : ""}`);
      if (d.chords) L.push(`  written chords: ${d.chords}`);
    }
    if (mu.heardLead) {
      L.push(`  lead heard (first ${mu.leadBars} bar${mu.leadBars === 1 ? "" : "s"}): ${mu.heardLead}`);
      if (mu.writtenLead) L.push(`  lead written:                ${mu.writtenLead}${mu.match ? `   (${mu.match})` : ""}`);
    }
    if (mu.sections && mu.sections.length > 1) L.push(`  sections: ${mu.sections.map((s) => `${s.name}@${s.t.toFixed(1)}s`).join(" → ")}`);
    if (a.changes.length) L.push(`  changes: ${a.changes.map((c) => `bar ${c.bar} (${c.t.toFixed(1)} s) ${c.text}`).join("; ")}`);
  }
  if (rep.events.length) {
    L.push("");
    L.push("Sounds:");
    for (const e of rep.events) {
      const head = `  ${e.t.toFixed(2).padStart(6)} s  ${e.label}${e.count > 1 ? ` ×${e.count}` : ""}${e.src ? `  (${e.src})` : ""}`;
      L.push(head);
      L.push(`           ${e.analysis ? describeEvent(e.analysis) : e.note || "not analyzed"}`);
      if (e.analysis && e.musicLoudness > -60) {
        const diff = e.analysis.loudness - e.musicLoudness;
        L.push(`           vs music: ${diff >= 0 ? "+" : ""}${r1(diff)} dB`);
      }
    }
  }
  if (rep.notes && rep.notes.length) { L.push(""); for (const n of rep.notes) L.push(`note: ${n}`); }
  L.push("");
  if (m.problems.length) {
    L.push("Problems (most important first):");
    m.problems.slice(0, 12).forEach((p, i) => L.push(`  ${i + 1}. ${p.text}`));
    if (m.problems.length > 12) L.push(`  … ${m.problems.length - 12} more (--json)`);
  } else L.push("No problems found.");
  if (rep.files && rep.files.length) L.push(`Wrote ${rep.files.join(", ")}`);
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// spectrogram for the pictures
// ---------------------------------------------------------------------------

/**
 * Log-frequency spectrogram of x over [t0, t1): `cols` x `rows` dB values (row 0 = fmin).
 * Each cell is the strongest bin in its frequency band (interpolated where bins are sparse).
 */
export function spectrogram(x, sr, { t0 = 0, t1 = x.length / sr, cols = 600, rows = 200, fmin = 55, fmax = 16000, nfft = 4096 } = {}) {
  const out = new Float32Array(cols * rows).fill(-120);
  const p = new Float32Array(nfft / 2 + 1), binHz = sr / nfft;
  const edges = [];
  for (let r = 0; r <= rows; r++) edges.push(fmin * Math.pow(fmax / fmin, (r - 0.5) / (rows - 1)));
  for (let c = 0; c < cols; c++) {
    const t = t0 + (c + 0.5) * (t1 - t0) / cols;
    powerSpectrum(x, Math.round(t * sr) - nfft / 2, nfft, p);
    for (let r = 0; r < rows; r++) {
      const k0 = edges[r] / binHz, k1 = edges[r + 1] / binHz;
      let v = 0;
      if (k1 - k0 < 1) {   // sparse: interpolate between neighbouring bins
        const k = (k0 + k1) / 2, i = Math.floor(k), f = k - i;
        v = (p[i] || 0) * (1 - f) + (p[i + 1] || 0) * f;
      } else for (let k = Math.ceil(k0); k <= Math.min(nfft / 2, Math.floor(k1)); k++) if (p[k] > v) v = p[k];
      out[r * cols + c] = v > 1e-12 ? 10 * Math.log10(v) : -120;
    }
  }
  return { data: out, cols, rows, fmin, fmax, t0, t1 };
}

// ===========================================================================
// Witness: raw game audio in, report out
// ===========================================================================
//
// Lumen rendered every sound alone, so it always knew what played when. A generic game only
// hands us its final mix (protocol `audio` command: interleaved PCM). analyzePCM() therefore
// finds the distinct sounds itself (onset detection) unless the caller passes event times,
// finds stretches of music (rhythm or harmony that keeps going) and describes them, and turns
// everything into the same kind of ranked problem list `lumen listen` prints.

const PCM_FORMATS = { f32: "f32", float32: "f32", float: "f32", s16: "s16", int16: "s16", pcm16: "s16" };

/** Bytes of a protocol `data` field: base64 string, Buffer, ArrayBuffer or typed array. */
function pcmBytes(data) {
  if (typeof data === "string") return Buffer.from(data, "base64");
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError("PCM data must be base64, a Buffer, an ArrayBuffer or a typed array");
}

const pcmFormat = (f) => {
  const v = PCM_FORMATS[String(f ?? "f32").toLowerCase()];
  if (!v) throw new RangeError(`unsupported PCM format ${JSON.stringify(f)} (use "f32" or "s16")`);
  return v;
};

/**
 * Protocol PCM -> Float32 channels.
 * @param pcm { sampleRate, channels, format: "f32" | "s16", data: Buffer | base64 | typed array }
 *            (or an already decoded { sampleRate, channels: [Float32Array, ...] })
 * @returns { sampleRate, channels: Float32Array[], nonFinite } — NaN/Inf samples become 0 and are counted
 */
export function decodePCM(pcm) {
  if (!pcm || typeof pcm !== "object") throw new TypeError("decodePCM: expected { sampleRate, channels, format, data }");
  const sampleRate = +pcm.sampleRate;
  if (!(sampleRate >= 1000 && sampleRate <= 768000)) throw new RangeError(`decodePCM: bad sampleRate ${pcm.sampleRate}`);
  if (Array.isArray(pcm.channels)) {
    const chs = pcm.channels.map((c) => (c instanceof Float32Array ? c : Float32Array.from(c)));
    if (!chs.length) throw new RangeError("decodePCM: no channels");
    return { sampleRate, channels: chs, nonFinite: 0 };
  }
  const nch = pcm.channels === undefined ? 2 : pcm.channels | 0;
  if (nch < 1 || nch > 64) throw new RangeError(`decodePCM: bad channel count ${pcm.channels}`);
  const format = pcmFormat(pcm.format);
  const bytes = pcmBytes(pcm.data ?? "");
  const bps = format === "f32" ? 4 : 2, frames = Math.floor(bytes.length / (bps * nch));
  const view = new DataView(bytes.buffer, bytes.byteOffset, frames * bps * nch);
  const chs = Array.from({ length: nch }, () => new Float32Array(frames));
  let nonFinite = 0;
  for (let i = 0, o = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++, o += bps) {
      let v = format === "f32" ? view.getFloat32(o, true) : view.getInt16(o, true) / 32768;
      if (!Number.isFinite(v)) { v = 0; nonFinite++; }
      chs[c][i] = v;
    }
  }
  return { sampleRate, channels: chs, nonFinite };
}

/**
 * Join consecutive protocol `audio` replies (each holds what was mixed since the previous call)
 * into one PCM. Mixed encodings are joined as "f32"; a change of sample rate or channel count
 * mid-run is an error (it means the game reconfigured its audio device).
 */
export function concatPCM(chunks) {
  const list = (Array.isArray(chunks) ? chunks : []).filter((c) => c && c.data !== undefined && c.data !== null);
  if (!list.length) throw new RangeError("concatPCM: no audio chunks");
  const { sampleRate } = list[0], channels = list[0].channels === undefined ? 2 : list[0].channels | 0;
  for (const c of list) {
    const ch = c.channels === undefined ? 2 : c.channels | 0;
    if (+c.sampleRate !== +sampleRate || ch !== channels) {
      throw new RangeError(`concatPCM: audio format changed mid-run (${sampleRate} Hz × ${channels} → ${c.sampleRate} Hz × ${ch})`);
    }
  }
  const formats = new Set(list.map((c) => pcmFormat(c.format)));
  if (formats.size === 1) return { sampleRate, channels, format: [...formats][0], data: Buffer.concat(list.map((c) => pcmBytes(c.data))) };
  const parts = list.map((c) => {
    const d = decodePCM(c), n = d.channels[0].length, out = Buffer.alloc(n * channels * 4);
    for (let i = 0, o = 0; i < n; i++) for (let k = 0; k < channels; k++, o += 4) out.writeFloatLE(d.channels[k][i], o);
    return out;
  });
  return { sampleRate, channels, format: "f32", data: Buffer.concat(parts) };
}

/**
 * Read a WAV file (PCM 8/16/24/32-bit, IEEE float 32/64, WAVE_FORMAT_EXTENSIBLE) into protocol PCM.
 * 16-bit files stay "s16"; everything else becomes "f32".
 * @returns { sampleRate, channels, format, data: Buffer, duration }
 */
export function wavToPCM(buffer) {
  const buf = pcmBytes(buffer);
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") throw new Error("wavToPCM: not a RIFF/WAVE file");
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("latin1", pos, pos + 4), size = buf.readUInt32LE(pos + 4);
    const body = buf.subarray(pos + 8, Math.min(buf.length, pos + 8 + size));
    if (id === "fmt " && body.length >= 16) {
      let tag = body.readUInt16LE(0);
      if (tag === 0xfffe && body.length >= 26) tag = body.readUInt16LE(24);   // extensible: the sub-format GUID starts with the tag
      fmt = { tag, channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    } else if (id === "data") data = body;
    pos += 8 + size + (size & 1);
  }
  if (!fmt) throw new Error("wavToPCM: missing fmt chunk");
  if (!data) throw new Error("wavToPCM: missing data chunk");
  const { tag, channels, sampleRate, bits } = fmt;
  if (!channels || !sampleRate || !bits || bits % 8) throw new Error("wavToPCM: invalid fmt chunk");
  const bps = bits / 8, total = Math.floor(data.length / bps), n = total - (total % channels);
  if (tag === 1 && bits === 16) {
    return { sampleRate, channels, format: "s16", data: Buffer.from(data.subarray(0, n * 2)), duration: n / channels / sampleRate };
  }
  const read = tag === 3 && bits === 32 ? (o) => data.readFloatLE(o)
    : tag === 3 && bits === 64 ? (o) => data.readDoubleLE(o)
    : tag === 1 && bits === 8 ? (o) => (data[o] - 128) / 128
    : tag === 1 && bits === 24 ? (o) => data.readIntLE(o, 3) / 8388608
    : tag === 1 && bits === 32 ? (o) => data.readInt32LE(o) / 2147483648
    : null;
  if (!read) throw new Error(`wavToPCM: unsupported WAV encoding (format ${tag}, ${bits}-bit)`);
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) out.writeFloatLE(read(i * bps), i * 4);
  return { sampleRate, channels, format: "f32", data: out, duration: n / channels / sampleRate };
}

/**
 * Protocol PCM (or decoded { sampleRate, channels: [Float32Array] }) -> a WAV file Buffer.
 * Keeps the input encoding (s16 -> 16-bit PCM, f32 -> 32-bit float) unless `format` says otherwise.
 */
export function pcmToWav(pcm, { format } = {}) {
  const src = Array.isArray(pcm.channels) ? null : pcmFormat(pcm.format);
  const want = pcmFormat(format ?? src ?? "f32"), bps = want === "f32" ? 4 : 2;
  let nch, sr = pcm.sampleRate, body;
  if (src === want) {   // same encoding: copy the bytes through
    nch = pcm.channels === undefined ? 2 : pcm.channels | 0;
    const bytes = pcmBytes(pcm.data ?? "");
    body = bytes.subarray(0, bytes.length - (bytes.length % (bps * nch)));
  } else {
    const d = decodePCM(pcm);
    sr = d.sampleRate; nch = d.channels.length;
    const frames = d.channels[0].length;
    body = Buffer.alloc(frames * nch * bps);
    for (let i = 0, o = 0; i < frames; i++) {
      for (let c = 0; c < nch; c++, o += bps) {
        const v = d.channels[c][i];
        if (want === "f32") body.writeFloatLE(v, o);
        else body.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), o);
      }
    }
  }
  const float = want === "f32", fmtLen = float ? 18 : 16, factLen = float ? 12 : 0;
  const head = Buffer.alloc(12 + 8 + fmtLen + factLen + 8);
  let o = 0;
  head.write("RIFF", o); head.writeUInt32LE(head.length - 8 + body.length, o + 4); head.write("WAVEfmt ", o + 8); o += 16;
  head.writeUInt32LE(fmtLen, o); o += 4;
  head.writeUInt16LE(float ? 3 : 1, o); head.writeUInt16LE(nch, o + 2); head.writeUInt32LE(sr, o + 4);
  head.writeUInt32LE(sr * nch * bps, o + 8); head.writeUInt16LE(nch * bps, o + 12); head.writeUInt16LE(bps * 8, o + 14); o += 16;
  if (float) {
    head.writeUInt16LE(0, o); o += 2;
    head.write("fact", o); head.writeUInt32LE(4, o + 4); head.writeUInt32LE(body.length / (nch * bps), o + 8); o += 12;
  }
  head.write("data", o); head.writeUInt32LE(body.length, o + 4);
  return Buffer.concat([head, body]);
}

import { truePeak, shortTerm, edges, pops, secondAttack, similarity } from "./hygiene.js";

// ---------------------------------------------------------------------------
// onsets: where distinct sounds start
// ---------------------------------------------------------------------------

/** Mean of a 1 ms envelope over [t0, t1) seconds. */
function levelAt(fine, t0, t1) {
  const a = Math.max(0, Math.floor(t0 * 1000)), b = Math.min(fine.length, Math.ceil(t1 * 1000));
  let s = 0;
  for (let i = a; i < b; i++) s += fine[i];
  return b > a ? s / (b - a) : 0;
}

/**
 * The first sample of a sound's attack near a detected onset t (seconds): scanning from 30 ms before t
 * (never before `lo`) to 5 ms after it, the first loud sample (above 2% of the sound's early peak and
 * 3x the level just before) that follows >= 1.5 ms of quiet. Over a loud bed with no quiet stretch,
 * t is returned unchanged.
 */
export function refineOnset(x, sr, t, lo = 0) {
  const i = Math.round(t * sr), a = Math.max(0, Math.round(lo * sr), i - Math.round(0.03 * sr));
  const pkEnd = Math.min(x.length, i + Math.round(0.03 * sr));
  let peak = 0;
  for (let k = Math.max(a, i - Math.round(0.005 * sr)); k < pkEnd; k++) { const v = Math.abs(x[k]); if (v > peak) peak = v; }
  if (peak < 1e-6) return t;
  const b0 = Math.max(0, a - Math.round(0.05 * sr));
  const bed = [];
  for (let k = b0; k < a; k++) bed.push(Math.abs(x[k]));
  bed.sort((p, q) => p - q);
  const base = bed.length ? bed[Math.floor(bed.length * 0.9)] : 0;
  const thr = Math.max(peak * 0.02, base * 3, 1e-6);
  if (thr >= peak * 0.5) return t;
  const need = Math.max(2, Math.round(0.0015 * sr));
  // the first loud sample at or after a, preceded by `need` quiet samples
  let quiet = 0;
  for (let k = a; k < Math.min(x.length, i + Math.round(0.005 * sr)); k++) {
    if (Math.abs(x[k]) <= thr) { quiet++; continue; }
    if (quiet >= need || (k === a && a === 0)) {
      return k / sr;   // the first loud sample after a quiet stretch (may be a little after t: t is rounded to 1 ms)
    }
    quiet = 0;
  }
  return t;
}

/** x band-limited to [[lo, hi] Hz, ...] over [t0, t1) seconds, zero elsewhere: causal 4th-order high- and low-pass
 *  per range (Butterworth biquads, twice), so nothing rings before an attack and an onset is never pulled early. */
export function bandPass(x, sr, t0, t1, bands) {
  const i0 = Math.max(0, Math.round(t0 * sr)), i1 = Math.min(x.length, Math.round(t1 * sr));
  const y = new Float32Array(x.length);
  if (i1 <= i0) return y;
  const seg = x.subarray(i0, i1);
  const hp = (v, f) => { const w = 2 * Math.PI * f / sr, al = Math.sin(w) / (2 * Math.SQRT1_2), c = Math.cos(w); return biquad(v, (1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al); };
  const lp = (v, f) => { const w = 2 * Math.PI * f / sr, al = Math.sin(w) / (2 * Math.SQRT1_2), c = Math.cos(w); return biquad(v, (1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al); };
  for (const [lo, hi] of bands) {
    let v = hp(hp(seg, lo), lo);
    if (hi < sr * 0.45) v = lp(lp(v, hi), hi);
    for (let k = 0; k < v.length; k++) y[i0 + k] += v[k];
  }
  return y;
}

// third-octave bands from 50 Hz for an n-point FFT, the low ones pooled until each spans 6+ bins (a band of 1-2 bins
// rises 10 dB by chance in steady noise or wind)
const bandCache = new Map();
function addedBands(sr, n) {
  const key = `${sr}|${n}`;
  if (bandCache.has(key)) return bandCache.get(key);
  const out = [], top = Math.min(12000, sr / 2), r = Math.pow(2, 1 / 3);
  for (let lo = 50; lo < top * 0.999;) {
    let hi = lo * r;
    while (hi < top && Math.ceil((hi * n) / sr) - Math.ceil((lo * n) / sr) < 6) hi *= r;
    hi = Math.min(hi, top);
    out.push({ lo, hi, k0: Math.ceil((lo * n) / sr), k1: Math.min(n / 2, Math.ceil((hi * n) / sr) - 1) });
    lo = hi;
  }
  bandCache.set(key, out);
  return out;
}

/** addedSound with its strength: { bands, frac } (frac = the share of the energy after t that the new sound adds), or null. */
function addedSoundAt(x, sr, t, minFrac = 0.01) {
  const w = Math.round(0.04 * sr), gap = Math.round(0.004 * sr), hop = Math.round(0.008 * sr), i = Math.round(t * sr);
  const back = [0, 8, 20, 36, 56].map((ms) => i - w - gap - Math.round((ms / 1000) * sr));
  if (back[back.length - 1] < 0 || i + w + hop > x.length) return null;
  let n = 256;
  while (n < w) n *= 2;
  const bands = addedBands(sr, n), re = new Float64Array(n), im = new Float64Array(n);
  const spec = (a) => {   // Hann over the 40 ms window itself (zero-padded to n)
    re.fill(0); im.fill(0);
    for (let k = 0; k < w; k++) re[k] = x[a + k] * (0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (w - 1)));
    fft(re, im);
    return bands.map(({ k0, k1 }) => { let v = 0; for (let k = k0; k <= k1; k++) v += re[k] * re[k] + im[k] * im[k]; return v; });
  };
  const bs = back.map(spec), b1 = bs[0], b2 = bs[1], a1 = spec(i), a2 = spec(i + hop);
  const before = b1.map((v, b) => Math.max(...bs.map((q) => q[b]))), after = a1.map((v, b) => Math.min(v, a2[b]));
  const bm = b1.map((v, b) => (v + b2[b]) / 2), am = a1.map((v, b) => (v + a2[b]) / 2);
  const rose = after.map((v, b) => v > before[b] * 10);
  let total = 0, added = 0, vacated = 0;
  const found = [], held = bm.reduce((a, v) => a + v, 0);
  for (let b = 0; b < bands.length; b++) {
    total += am[b];
    // emptied: a band that carried 2%+ of the sound before and lost half of it (not a transient's thin splatter)
    if (!rose[b]) { if (bm[b] > am[b] * 2 && bm[b] >= 0.02 * held) vacated += bm[b] - am[b]; continue; }
    let moved = 0;
    for (let j = Math.max(0, b - 2); j <= Math.min(bands.length - 1, b + 2); j++) if (!rose[j]) moved += Math.max(0, bm[j] - am[j]);
    const add = after[b] - before[b] - moved;
    if (add > 0) { added += add; found.push([b, add]); }
  }
  // an added sound leaves the bands already sounding playing; a pitch step or a fast sweep empties the ones it left
  if (!(total > 0 && added >= minFrac * total)) return null;
  // (while the level carries on: a sound that ends as a quieter one starts is not a move)
  if (vacated >= 0.5 * added && vacated >= 0.05 * total && total >= 0.6 * held) return { moved: true };
  // the bands that carry it (5%+ of what was added), adjacent ones merged
  const out = [];
  for (const [b] of found.filter(([, v]) => v >= 0.05 * added)) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - bands[b].lo) < 1e-6) last[1] = bands[b].hi; else out.push([bands[b].lo, bands[b].hi]);
  }
  return { bands: out, frac: added / total };
}

/**
 * Did a new sound start at t on top of one already playing? Band energies (third-octave, the low bands pooled to 6+
 * FFT bins) over five 40 ms windows before t (ending 4 to 60 ms before it) vs two from t (and 8 ms later). A band
 * that rose 10x (10 dB) in both after windows over every before window (so steady noise wavering by chance doesn't)
 * adds its rise minus what the bands up to 2 away (2/3 octave) lost: vibrato moves energy into a neighbouring band,
 * an added sound leaves the old bands sounding. New sound when that adds at least 1% of the energy after t (a sound up
 * to 20 dB under the one playing, in bands it leaves free), unless the bands that emptied (bands holding 2%+ that fell
 * 3 dB+) lost half as much or more while the level held (60%+): a pitch step or a fast sweep moving away.
 * Returns the rising band edges in Hz, or null.
 */
export function addedSound(x, sr, t) {
  const r = addedSoundAt(x, sr, t);
  return r && r.bands ? r.bands : null;
}

/** The added sound near a flux peak at tk: the flux frame is 46 ms long, so from 30 ms before tk (never before
 *  `from`), at the window where it stands out most (the after windows start at its attack, the before windows hold
 *  none of it), and still there 5 ms later: { bands, frac, q }. A pitch step or a fast sweep reads as added at the
 *  window that only just reaches it and as moved once the window is past it: one sound, null. */
function addedNear(x, sr, tk, from = 0) {
  let best = null;
  for (let q = Math.max(tk - 0.03, from); q <= tk + 0.0051; q += 0.005) {
    const r = addedSoundAt(x, sr, q);
    if (r && r.moved) return null;
    if (r && (!best || r.frac > best.frac)) best = { ...r, q };
  }
  // a sound that really starts there reads as added 5 ms before or after too (half the share will do: it decays, or
  // the sound under it ends); a slow sweep edging into the next band reads as added at one window only
  if (best && ![-0.005, 0.005].some((d) => { if (best.q + d < from) return false; const r = addedSoundAt(x, sr, best.q + d, 0.005); return r && r.bands; })) return null;
  return best;
}

/**
 * Onset times of distinct sounds in a (mono) signal: spectral-flux peaks that come with a real
 * rise in level (a pitch change inside one sound is not a new sound), plus the starts of sounds
 * that fade in out of silence. Each time is refined to the first millisecond within 20 dB of the
 * sound's early peak, then (with `refine`) to the first sample of its attack after a quiet stretch.
 * @returns [{ t, strength }] sorted by time
 */
export function detectOnsets(x, sr, { minGap = 0.06, refine = true } = {}) {
  if (!x.length) return [];
  const fine = envelope([x], sr, 0.001), fineAll = fine;
  let peak = 0;
  for (let i = 0; i < fine.length; i++) if (fine[i] > peak) peak = fine[i];
  if (peak < 1e-5) return [];
  const floor = Math.max(1e-5, peak * Math.pow(10, -50 / 20));
  const { env, rate } = onsetEnvelope(x, sr);
  const sorted = Float32Array.from(env).sort();
  const ref = sorted[Math.floor(sorted.length * 0.995)] || sorted[sorted.length - 1] || 1;
  const found = [];
  const back = Math.round(rate * 0.25), near = Math.max(1, Math.round(rate * 0.015));
  for (let k = 1; k < env.length; k++) {
    const v = env[k];
    if (v < ref * 0.06) continue;
    let isMax = true;
    for (let j = Math.max(0, k - near); j <= Math.min(env.length - 1, k + near); j++) if (env[j] > v || (env[j] === v && j < k)) { isMax = false; break; }
    if (!isMax) continue;
    let mean = 0, c = 0;
    for (let j = Math.max(0, k - back); j < k - near; j++) { mean += env[j]; c++; }
    mean = c ? mean / c : 0;
    if (v < mean * 1.6 + ref * 0.03) continue;
    // the flux frame spans [k*hop, k*hop + 1024): the new energy entered in its last part
    const tk = (k * 256 + 768) / sr;
    const pre = levelAt(fine, tk - 0.045, tk - 0.012), post = levelAt(fine, tk - 0.004, tk + 0.03);
    // a short sound on a steady bed rises in its first 20 ms (and tk is up to ~10 ms off): the loudest 20 ms near tk
    // against the loudest 20 ms before it (like with like, so a bed that wavers by itself doesn't pass)
    let post20 = 0, pre20 = 0;
    for (let q = tk - 0.012; q <= tk + 0.0101; q += 0.002) post20 = Math.max(post20, levelAt(fine, q, q + 0.02));
    for (let q = tk - 0.06; q <= tk - 0.0319; q += 0.002) pre20 = Math.max(pre20, levelAt(fine, q, q + 0.02));
    if (post < floor) continue;
    // a level rise, or (under a longer, louder sound the level hardly moves) new energy in bands that were quiet
    // while the bands already sounding carry on: a sound added on top, not a pitch change inside one sound
    let bands = null, at = tk;
    if (!(post > pre * 1.5 || post20 > pre20 * 1.5 || (pre < floor * 3 && post > pre * 1.2))) {
      const best = addedNear(x, sr, tk);
      if (!best) continue;
      bands = best.bands; at = best.q;
    }
    found.push({ t: at, tk, strength: v / ref, bands });
  }
  // sounds that swell out of silence have no sharp flux peak: catch them on the level gate
  const gate = envelope([x], sr, 0.005);
  let quiet = 10;
  for (let i = 0; i < gate.length; i++) {
    if (gate[i] < floor) { quiet++; continue; }
    if (quiet >= 10 && !found.some((f) => Math.abs(f.t - i * 0.005) < 0.08)) found.push({ t: i * 0.005, strength: 0 });
    quiet = 0;
  }
  found.sort((a, b) => a.t - b.t);
  // refine each time on the 1 ms envelope (the first millisecond 20 dB up from the level before
  // it towards the new peak, so a bed of music underneath doesn't pull it early) and enforce the
  // minimum gap (keep the stronger)
  // a sound that started under a louder one is timed on its own bands (the louder sound's level would hide its rise)
  const out = [];
  for (const f of found) {
    // within minGap of the last onset: the same sound's attack again, unless it is a different sound starting right
    // after the first (a swing 40 ms into a jingle, a chord 30 ms after a swing): new energy in bands the first
    // wasn't using (a re-trigger of the same sound rises in its own bands, which were already sounding)
    // (its nearest before window must hold the first sound: from 34 ms after it; earlier, the "added" bands are the
    // first sound's own, rising out of what came before it)
    const prev = out[out.length - 1];
    if (prev && f.t - prev.t < minGap) {
      const r = addedNear(x, sr, f.tk ?? f.t, prev.t + 0.034);
      f.bands = r ? r.bands : null;
      if (r) f.t = r.q;
    }
    let lp = 0;
    const y = f.bands ? bandPass(x, sr, f.t - 0.15, f.t + 0.1, f.bands) : null;
    f.signal = y;
    const fine = y ? envelope([y], sr, 0.001) : fineAll;
    // (an added sound's window starts within ~5 ms of its attack: look from 10 ms before it, not 30, so a wobble in
    // the bed under it can't time it early; its rise must hold for 2 ms)
    const a = Math.max(0, Math.floor((f.t - (y ? 0.01 : 0.03)) * 1000)), b = Math.min(fine.length, Math.ceil((f.t + 0.06) * 1000));
    for (let i = a; i < b; i++) if (fine[i] > lp) lp = fine[i];
    const before = Array.from(fine.subarray(Math.max(0, a - 50), a)).sort((p, q) => p - q);
    const base = before.length ? before[Math.floor(before.length * 0.9)] : 0;   // 1 ms RMS of a bass wobbles: use its peaks
    const rise = base + (lp - base) * 0.1;
    const prevT = out.length ? out[out.length - 1].t + (y ? 0.012 : 0) : -1;
    let i = a;
    while (i < b && (fine[i] < rise || (y && fine[i + 1] < rise) || i / 1000 <= prevT)) i++;
    const t = Math.min(f.t + 0.03, i / 1000);
    const last = out[out.length - 1];
    if (last && t - last.t < (f.bands ? 0.012 : minGap)) { if (f.strength > last.strength) last.strength = f.strength; continue; }
    out.push({ t, strength: f.strength, ...(y ? { over: true, bands: f.bands, signal: y } : {}) });
  }
  // (an added sound's own bands still hold the bed's noise: no further than 5 ms back from its 1 ms time)
  if (refine) for (let k = 0; k < out.length; k++) out[k].t = refineOnset(out[k].signal || x, sr, out[k].t, Math.max(k ? out[k - 1].t + 0.01 : 0, out[k].signal ? out[k].t - 0.005 : 0));
  for (const o of out) delete o.signal;
  return out;
}

/** The first moment in [a, b] (seconds) where a 1 ms envelope is at its floor for that span (within 1.5x). */
function quietPoint(fine, a, b) {
  const i0 = Math.max(0, Math.floor(a * 1000)), i1 = Math.min(fine.length, Math.ceil(b * 1000));
  if (i1 <= i0) return b;
  let mn = Infinity;
  for (let i = i0; i < i1; i++) if (fine[i] < mn) mn = fine[i];
  const thr = mn * 1.5 + 1e-7;
  for (let i = i0; i < i1; i++) if (fine[i] <= thr) return Math.min(b, (i + 1) / 1000);
  return b;
}

// ---------------------------------------------------------------------------
// music in a mix
// ---------------------------------------------------------------------------

const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * Where to put the half-second chord blocks so their edges fall on chord changes: the phase
 * (0 .. block) that collects the most harmonic novelty (chroma before vs after) on block edges.
 */
function blockPhase(x, sr, t0, t1, block) {
  const hop = 1024, frames = chromagram(x.subarray(Math.floor(t0 * sr), Math.floor(t1 * sr)), sr, 8192, hop);
  if (frames.length < 8) return 0;
  const unit = frames.map((f) => { const n = Math.hypot(...f.c) || 1; return Array.from(f.c, (v) => v / n); });
  const w = Math.max(2, Math.round((0.25 * sr) / hop)), nov = new Float32Array(frames.length);
  for (let i = w; i + w <= frames.length; i++) {
    const a = new Float32Array(12), b = new Float32Array(12);
    for (let j = i - w; j < i; j++) for (let k = 0; k < 12; k++) a[k] += unit[j][k];
    for (let j = i; j < i + w; j++) for (let k = 0; k < 12; k++) b[k] += unit[j][k];
    let dot = 0;
    for (let k = 0; k < 12; k++) dot += a[k] * b[k];
    nov[i] = 1 - dot / ((Math.hypot(...a) * Math.hypot(...b)) || 1);
  }
  const at = (t) => {   // novelty at a boundary time (relative), ±1 frame
    const i = Math.round((t * sr + hop / 2 - 4096) / hop);
    let m = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(nov.length - 1, i + 1); j++) m = Math.max(m, nov[j]);
    return m;
  };
  let best = 0, bestScore = -1;
  for (let p = 0; p < 16; p++) {
    const ph = (p * block) / 16;
    let score = 0;
    for (let t = ph; t < t1 - t0; t += block) score += at(t);
    if (score > bestScore + 1e-9) { bestScore = score; best = ph; }
  }
  return best;
}

/**
 * Chords over time from the notes heard in half-second blocks (aligned to the chord changes when
 * `align`), merged into runs. Each block keeps the per-bin minimum of its spectra, so a short
 * sound effect or drum hit inside it doesn't add notes.
 */
function chordTimeline(x, sr, t0, t1, align = true) {
  const nfft = 1 << Math.round(Math.log2(sr * 0.34)), block = 0.5;
  const ph = align ? blockPhase(x, sr, t0, t1, block) : 0;
  const raw = [];
  for (let edge = t0 + ph - (ph > 0.05 ? block : 0); edge + block * 0.5 < t1; edge += block) {
    const t = Math.max(t0, edge), e = Math.min(t1, edge + block);
    if (e - t < block * 0.3) continue;   // a sliver before the first full block
    const heard = notesInSpectrum(averageSpectrum(x, sr, t, e, nfft, 0), sr, nfft);
    const pcs = new Set(heard.map((n) => ((n.midi % 12) + 12) % 12));
    let chord = "—", score = 0, alt = null;
    if (pcs.size >= 2) {
      const { c, bass } = notesChroma(heard);
      const m = matchChord(c, bass);
      if (m) { chord = m.score >= 0.72 ? m.name : "?"; score = m.score; alt = m.alt; }
    }
    raw.push({ t, end: e, chord, score, alt, notes: heard.slice(0, 6).map((n) => n.name) });
  }
  // a single odd block between two equal chords is a transition smear, not a chord
  for (let i = 1; i + 1 < raw.length; i++) {
    if (raw[i - 1].chord === raw[i + 1].chord && raw[i].chord !== raw[i - 1].chord) raw[i] = { ...raw[i], chord: raw[i - 1].chord, score: raw[i - 1].score, alt: raw[i - 1].alt };
  }
  const runs = [];
  for (const b of raw) {
    const last = runs[runs.length - 1];
    if (last && last.chord === b.chord) { last.end = b.end; last.score = Math.max(last.score, b.score); }
    else runs.push({ t: b.t, end: b.end, chord: b.chord, score: b.score, alt: b.alt, notes: b.notes });
  }
  return runs.map((r) => ({ ...r, t: r3(r.t), end: r3(r.end), score: Math.round(r.score * 100) / 100 }));
}

/**
 * A guess at the melody over [t0, t1): the highest clearly sounding note every 50 ms (harmonic
 * salience on short spectra, so chords underneath and drums below G3 don't take over), held
 * for >= 150 ms. A top-line estimate, not a transcription.
 */
function melodyGuess(x, sr, t0, t1) {
  const end = Math.min(t1, t0 + 30), nfft = 1 << Math.round(Math.log2(sr * 0.17)), hop = 0.05;
  const p = new Float32Array(nfft / 2 + 1);
  const frames = [];
  for (let t = t0 + nfft / sr / 2; t < end; t += hop) {
    powerSpectrum(x, Math.round(t * sr) - nfft / 2, nfft, p);
    let energy = 0;
    for (let k = 0; k < p.length; k++) energy += p[k];
    const heard = energy > 1e-9 ? notesInSpectrum(p, sr, nfft, { lo: 55, hi: 100, maxNotes: 5 }).filter((n) => n.salience >= 0.3) : [];
    frames.push({ t, m: heard.length ? Math.max(...heard.map((n) => n.midi)) : null });
  }
  const notes = [];
  let cur = null;
  const flush = () => {
    if (!cur || cur.t1 - cur.t0 + hop < 0.15) return;
    const last = notes[notes.length - 1];
    if (last && last.midi === cur.m && cur.t0 - (last.t + last.dur) < hop * 1.5) last.dur = r3(cur.t1 + hop - last.t);
    else notes.push({ note: noteName(cur.m), midi: cur.m, t: r3(cur.t0 - hop / 2), dur: r3(cur.t1 - cur.t0 + hop) });
  };
  for (const f of frames) {
    if (cur && f.m === cur.m) { cur.t1 = f.t; continue; }
    flush();
    cur = f.m === null ? null : { m: f.m, t0: f.t, t1: f.t };
  }
  flush();
  const coverage = Math.min(1, notes.reduce((a, n) => a + n.dur, 0) / Math.max(1e-9, end - t0));
  const shown = notes.slice(0, 16).map((n) => n.note).join(" ") + (notes.length > 16 ? " …" : "");
  const text = coverage < 0.25 || notes.length < 3
    ? `no clear melody line (a held top note only ${Math.round(coverage * 100)}% of the time)`
    : `${shown}   (top line, ${Math.round(coverage * 100)}% of the time${end < t1 ? `, first ${Math.round(end - t0)} s` : ""})`;
  return { notes: notes.slice(0, 64), coverage: Math.round(coverage * 100) / 100, text };
}

/**
 * estimateTempo with a musical-range prior: below 80 bpm the double tempo, above 170 the half,
 * is taken when the beat supports it (estimateTempo's own declared-tempo test, >= 70% as strong).
 */
function musicTempo(x, sr) {
  const t = estimateTempo(x, sr);
  const alt = t.bpm > 0 && t.bpm < 80 ? t.bpm * 2 : t.bpm > 170 ? t.bpm / 2 : 0;
  if (alt) {
    const u = estimateTempo(x, sr, alt);
    if (Math.abs(u.bpm - alt) / alt < 0.04) return u;
  }
  return t;
}

/**
 * Stretches of music in a mix: a bed of sound that never drops out for >= 4 s (the rolling
 * minimum of the loudness stays up, so separate sound effects with gaps between them don't
 * count) and that either has a steady beat or moves between pitched chords. Each one gets
 * tempo, key, a chord timeline and a melody guess.
 */
function findMusic(channels, x, sr, onsets) {
  const curve = loudnessCurve([x], sr, 0.4, 0.1);
  const integ = integratedLoudness([x], sr, curve);
  if (!Number.isFinite(integ)) return [];
  const thr = Math.max(-50, integ - 25), n = curve.lufs.length, reach = 4;   // ±0.4 s
  const bed = curve.lufs.map((_, i) => { let m = Infinity; for (let j = Math.max(0, i - reach); j <= Math.min(n - 1, i + reach); j++) m = Math.min(m, curve.lufs[j]); return m; });
  const stretches = [];
  let s0 = -1;
  for (let i = 0; i <= n; i++) {
    const on = i < n && bed[i] > thr;
    if (on && s0 < 0) s0 = i;
    if (!on && s0 >= 0) {
      // the rolling minimum shrank the stretch by `reach` frames at each end: grow it back
      stretches.push([curve.times[Math.max(0, s0 - reach)] - curve.win / 2, curve.times[Math.min(n - 1, i - 1 + reach)] + curve.win / 2]);
      s0 = -1;
    }
  }
  const out = [];
  for (let [a, b] of stretches) {
    a = Math.max(0, a); b = Math.min(x.length / sr, b);
    if (b - a < 4) continue;
    let chords = chordTimeline(x, sr, a, b, false);
    // sound effects right before or after the music can bridge into the stretch: trim its edges
    // to where held chords (>= 1 s) begin and end
    const held = chords.filter((c) => c.chord !== "—" && c.chord !== "?" && c.end - c.t >= 1);
    if (held.length && held[held.length - 1].end - held[0].t >= 4) {
      a = held[0].t; b = held[held.length - 1].end;
      // start on the music's first attack near there (the earliest clear one: an effect can be louder)
      const near = onsets.filter((o) => o.t >= a - 0.45 && o.t <= a + 0.45 && o.strength >= 0.2);
      if (near.length) a = near[0].t;
    }
    if (b - a < 4) continue;
    chords = chordTimeline(x, sr, a, b);
    const i0 = Math.floor(a * sr), i1 = Math.floor(b * sr);
    const tempo = musicTempo(x.subarray(i0, i1), sr);
    const rhythmic = tempo.bpm > 0 && tempo.confidence >= 0.45;   // noise and scattered effects score <= ~0.35
    const flat = spectralStats(x, sr, i0, i1).flatness;
    const pitchedRuns = chords.filter((c) => c.chord !== "—" && c.chord !== "?");
    const harmonic = flat < 0.3 && new Set(pitchedRuns.map((c) => c.chord)).size >= 2;
    if (!rhythmic && !harmonic) continue;
    const an = analyzeMusic(channels, sr, { t0: a, t1: b, maxBars: 0 });
    const pitched = pitchedRuns.length > 0 && an.keyR > 0.2;
    out.push({
      t0: r3(a), t1: r3(b), beat: rhythmic, tempo: rhythmic ? r1(tempo.bpm) : 0, tempoConfidence: Math.round(tempo.confidence * 100) / 100,
      pitched, key: pitched ? an.key : null, keyR: Math.round(an.keyR * 100) / 100, keyRunnerUp: pitched ? an.keyRunnerUp : null,
      chords: pitched ? chords : [], melody: pitched ? melodyGuess(x, sr, a, b) : null,
      loudness: an.loudness, loudnessRange: r1(an.loudnessRange),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// sounds: segments, grouping, masking
// ---------------------------------------------------------------------------

const sliceChannels = (chs, sr, t0, t1) => chs.map((c) => c.subarray(Math.max(0, Math.floor(t0 * sr)), Math.min(c.length, Math.ceil(t1 * sr))));

/** A short name for what a pitch description heard (for grouping repeats). */
const pitchKey = (p) => (p.kind === "unpitched" ? "-" : p.note || (p.notes || []).join(" ") || p.kind);

/** Two analyses that sound like the same sound played again. */
function sameSound(a, b) {
  if (a.silent || b.silent) return a.silent === b.silent;
  return a.shape === b.shape && pitchKey(a.pitch) === pitchKey(b.pitch) && Math.abs(Math.log(a.length / b.length)) < 0.25 &&
    Math.abs(Math.log((a.centroid || 1) / (b.centroid || 1))) < 0.25 && Math.abs(a.loudness - b.loudness) < 4;
}

/** Median or max of a loudness curve's K-weighted mean squares over [t0, t1). */
function curveStat(curve, t0, t1, kind) {
  const v = [];
  curve.times.forEach((t, i) => { if (t >= t0 && t < t1) v.push(curve.ms[i]); });
  if (!v.length) return 0;
  return kind === "max" ? Math.max(...v) : median(v);
}
const msToLufs = (z) => (z > 0 ? -0.691 + 10 * Math.log10(z) : -120);

/** Replace non-finite numbers by null so the report survives a JSON round trip unchanged. */
function jsonSafe(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = jsonSafe(x); return o; }
  return v;
}

const NAN_PROBLEM = (n) => ({ severity: 1, text: `${n} samples were NaN or infinite (replaced by silence) → a broken filter, a division by zero or an uninitialized buffer in the audio code` });

/**
 * The `witness listen` analysis of a game's mixed audio.
 * @param pcm   protocol PCM { sampleRate, channels, format: "f32" | "s16", data: Buffer | base64 }
 * @param opts  { events?: [{ t, label }] (what the game says it played, when it can), title?, maxSounds = 40 }
 * @returns { report (JSON-safe), text (the plain-language report), segments (one per distinct
 *            sound, with its audio, for soundSheetPNG), channels, sampleRate }
 */
export function analyzePCM(pcm, { events = null, title = "game", maxSounds = 40 } = {}) {
  const { sampleRate: sr, channels: chs, nonFinite } = decodePCM(pcm);
  const len = chs[0].length, duration = len / sr;
  const x = mono(chs);
  const notes = [];
  const evs = (Array.isArray(events) ? events : []).filter((e) => e && Number.isFinite(+e.t))
    .map((e, i) => ({ t: Math.max(0, +e.t), label: String(e.label ?? `event ${i + 1}`) })).sort((a, b) => a.t - b.t);
  const base = { title, duration, sampleRate: sr, channels: chs.length, segmentation: evs.length ? "events" : "onsets" };

  let peak = 0;
  for (const c of chs) for (let i = 0; i < len; i++) { const a = Math.abs(c[i]); if (a > peak) peak = a; }
  if (len < sr * 0.01 || peak < 1e-5) {
    const problems = [];
    if (nonFinite) problems.push(NAN_PROBLEM(nonFinite));
    if (evs.length) problems.push({ severity: 1, text: `${evs.length} sound event${evs.length === 1 ? " was" : "s were"} logged but the audio is silent → does the adapter capture the mix in witness mode?` });
    const report = jsonSafe({ ...base, empty: true, mix: { peakDb: dB(peak), clipped: 0, integrated: -Infinity }, onsets: 0, music: [], sounds: [], problems, notes });
    const text = [`♪ ${title} — silent: nothing audible in ${duration.toFixed(2)} s of audio${len ? "" : " (no samples)"}.`,
      ...(problems.length ? ["", "Problems (most important first):", ...problems.map((p, i) => `  ${i + 1}. ${p.text}`)] : [])].join("\n");
    return { report, text, segments: [], channels: chs, sampleRate: sr };
  }

  // ---- onsets and music ---------------------------------------------------------------
  const onsets = detectOnsets(x, sr);
  const music = findMusic(chs, x, sr, onsets);
  const inMusic = (t) => music.find((m) => t >= m.t0 && t < m.t1) || null;
  const short = loudnessCurve(chs, sr, 0.1, 0.02);

  // ---- segments: the given events, or the onsets that stand out --------------------------
  let segs;
  if (evs.length) {
    // a sound ends at the quiet point before the next event, unless it is still sounding when that one starts (a
    // swing inside a long jingle): then it runs on under it, to where it falls back to the level before it began
    const fine = envelope([x], sr, 0.001), env5 = envelope([x], sr, 0.005);
    const lvl = (a, b) => levelAt(fine, a, b);
    segs = evs.map((e, i) => {
      const bed = lvl(e.t - 0.05, e.t - 0.002);
      let pk = 0;
      for (let k = Math.floor(e.t / 0.005); k < Math.min(env5.length, Math.ceil((e.t + 0.1) / 0.005)); k++) if (env5[k] > pk) pk = env5[k];
      let t1 = Math.min(duration, e.t + 4), cut = false;
      for (const n of evs.slice(i + 1)) {
        if (n.t < e.t + 0.05) continue;
        if (n.label === e.label || lvl(n.t - 0.02, n.t - 0.002) <= Math.max(bed * 2, pk * 0.25)) { t1 = Math.min(t1, quietPoint(fine, e.t + 0.02, n.t)); cut = true; break; }
      }
      if (!cut) {   // its own end: back to the level before it (or 40 dB under its peak), held for 20 ms
        const stop = Math.max(bed * 2, pk * 0.01);
        for (let k = Math.ceil((e.t + 0.02) / 0.005); k < env5.length; k++) {
          if (k * 0.005 >= t1) break;
          let quiet = true;
          for (let j = k; j < Math.min(env5.length, k + 4); j++) if (env5[j] > stop) { quiet = false; break; }
          if (quiet) { t1 = Math.min(t1, k * 0.005 + 0.005); break; }
        }
      }
      return { t: e.t, label: e.label, t0: Math.max(0, e.t - 0.01), t1 };
    });
    // which sounds overlap another (their own analysis would hold both)
    for (const sg of segs) {
      sg.over = segs.filter((o) => o !== sg && o.label !== sg.label && o.t < sg.t1 - 0.005 && sg.t < o.t1 - 0.005).map((o) => o.label);
      sg.with = segs.filter((o) => o !== sg && o.label !== sg.label && Math.abs(o.t - sg.t) < 0.002).map((o) => o.label);   // started together
    }
  } else {
    // inside music every beat is an onset: keep only sounds that rise >= 6 dB above the bed
    // (and not the music's own first note)
    const kept = onsets.filter((o) => {
      const mu = inMusic(o.t);
      if (!mu) return true;
      if (o.t - mu.t0 < 0.45) return false;
      const bed = msToLufs(curveStat(short, o.t - 1.5, o.t - 0.1, "median")), top = msToLufs(curveStat(short, o.t, o.t + 0.3, "max"));
      return top - bed >= 6;
    });
    // a sound ends at the quietest point before the next one starts (never in the next sound's attack),
    // and starts at most 10 ms before its onset (never before the previous sound's end)
    const fine = envelope([x], sr, 0.001);
    let prevEnd = 0;
    segs = kept.map((o, i) => {
      let t1 = Math.min(duration, kept[i + 1] ? quietPoint(fine, o.t + 0.02, kept[i + 1].t) : Infinity, o.t + 8);
      const next = music.find((m) => m.t0 > o.t);
      if (next) t1 = Math.min(t1, next.t0 - 0.005);   // a sound before the music ends where the music begins
      const mu = inMusic(o.t);
      if (mu) {   // over music a sound ends when the level is back within 3 dB of the bed
        const bedMs = curveStat(short, o.t - 1.5, o.t - 0.1, "median");
        const k = short.times.findIndex((t, j) => t > o.t + 0.08 && short.ms[j] <= bedMs * 2);
        if (k >= 0) t1 = Math.min(t1, short.times[k] + short.win / 2);
      }
      const t0 = Math.max(0, prevEnd, o.t - 0.01);
      prevEnd = t1;
      return { t: o.t, t0, t1 };
    });
  }
  const late = segs.filter((s) => s.label !== undefined && s.t >= duration - 0.01);
  if (late.length) notes.push(`${late.length} event${late.length === 1 ? " is" : "s are"} at or after the end of the audio (${duration.toFixed(2)} s): ${[...new Set(late.map((s) => s.label))].slice(0, 5).join(", ")}${late.length > 5 ? ", …" : ""} → was the audio fetched before those frames were stepped?`);
  segs = segs.filter((s) => s.t1 - s.t0 >= 0.01);

  // ---- analyze each segment, then group repeats ----------------------------------------------
  // a sound that starts under another one is measured on the bands it added (where it rose 10 dB over what was
  // playing; the onset detector found them): its own length, attack and brightness, not the other sound's. Its pitch
  // and tonality can't be separated from the other sound's, so they are left out. With no such bands (it is the
  // louder one, or no onset of its own) it is measured with the other sound, and says so.
  const ownOf = (s) => {
    if (!(s.over || []).length || (s.with || []).length) return null;
    const o = onsets.find((q) => q.bands && q.bands.length && Math.abs(q.t - s.t) <= 0.004);
    if (!o) return null;
    // (its segment from the events ends where the mix is back near the other sound: too soon; look up to 4 s on)
    const lim = Math.min(duration, s.t + 4);
    // (8th order: twice through the band-pass, so the other sound leaks in 48 dB down an octave away, not 24)
    const y = bandPass(bandPass(x, sr, Math.max(0, s.t - 0.15), lim, o.bands), sr, Math.max(0, s.t - 0.15), lim, o.bands), f1 = envelope([y], sr, 0.001);
    const bed = levelAt(f1, s.t - 0.06, s.t - 0.005), i0 = Math.floor(s.t * 1000);
    let pk = 0, pi = i0;
    for (let i = i0; i < Math.min(f1.length, Math.ceil((s.t + 0.1) * 1000)); i++) if (f1[i] > pk) { pk = f1[i]; pi = i; }
    if (!(pk > bed * 2)) return null;
    // length and attack against the level its bands had before it (the other sound leaks into them a little):
    // it ends back down at twice that level (or 40 dB under its peak), held for 20 ms
    const stop = Math.max(bed * 2, pk * 0.01);
    let end = lim;
    for (let i = pi, q = 0; i < Math.min(f1.length, Math.ceil(lim * 1000)); i++) { q = f1[i] <= stop ? q + 1 : 0; if (q >= 20) { end = (i - 19) / 1000; break; } }
    let ia = i0;
    while (ia < pi && f1[ia] < Math.max(pk * 0.316, bed * 2)) ia++;
    const seg = [y.subarray(Math.max(0, Math.floor(s.t0 * sr)), Math.min(y.length, Math.ceil(end * sr)))];
    const a = analyzeEvent(seg, sr);
    if (a.silent) return null;
    const length = Math.max(0.001, end - s.t), attack = Math.max(0.001, (ia - i0 + 1) / 1000);
    const lo = Math.min(...o.bands.map((b) => b[0])), hi = Math.max(...o.bands.map((b) => b[1]));
    Object.assign(a, { start: s.t - s.t0, length, attack, shape: shapeOf(attack, (pi - i0 + 1) / 1000, length, a.hold), ownBands: [Math.round(lo), Math.round(hi)],
      pitch: { kind: "unknown", text: "pitch not separable" }, tonality: "not separable", periodic: null });
    return { analysis: a, channels: seg, y };
  };
  const groups = [];
  let skipped = 0;
  for (const s of segs) {
    let g = s.label !== undefined ? groups.find((q) => q.label === s.label) : null;
    if (g) {
      g.times.push(s.t);
      if (g.over.length && !(s.over || []).length) {   // describe it from an occurrence that plays alone
        const seg = sliceChannels(chs, sr, s.t0, s.t1);
        Object.assign(g, { t0: s.t0, t1: s.t1, analysis: analyzeEvent(seg, sr), channels: seg, over: [], with: [], from: s.t });
      } else if (g.over.length && !g.analysis.ownBands) {
        const own = ownOf(s);
        if (own) Object.assign(g, { t0: s.t0, t1: s.t1, analysis: own.analysis, channels: own.channels, over: s.over, with: [], from: s.t });
      }
      continue;
    }
    if (groups.length >= maxSounds) { skipped++; continue; }
    const own = ownOf(s);
    const seg = own ? own.channels : sliceChannels(chs, sr, s.t0, s.t1);
    const a = own ? own.analysis : analyzeEvent(seg, sr);
    if (s.label === undefined) {
      if (a.silent || a.peakDb < dB(peak) - 50) continue;   // residue under the noise floor
      g = groups.find((q) => sameSound(q.analysis, a));
      if (g) { g.times.push(s.t); continue; }
    }
    groups.push({ label: s.label, t: s.t, t0: s.t0, t1: s.t1, times: [s.t], analysis: a, channels: seg, overMusic: !!inMusic(s.t), over: s.over || [], with: s.with || [] });
  }
  groups.forEach((g, i) => { if (g.label === undefined) g.label = `sound ${i + 1}`; });
  if (skipped) notes.push(`${skipped} more segments were not analyzed (limit ${maxSounds} distinct sounds)`);

  // ---- problems: the mix (clipping, outliers, silences, loudness) + masking + signal faults ----
  const occurrences = [];
  for (const g of groups) for (const t of g.times) occurrences.push({ t, label: g.label, analysis: g.analysis });
  occurrences.sort((a, b) => a.t - b.t);
  const mix = analyzeMix(chs, sr, null, occurrences, { duration, audition: false });
  const problems = mix.problems.slice();
  for (const g of groups) {
    if (!inMusic(g.t) || g.analysis.silent) continue;
    // power subtraction: what the sound adds, right after its onset, on top of the music just before it
    // (its own analysis can't tell: cut from the mix, it mostly describes the music)
    // (like with like: the loudest 100 ms after the onset vs the loudest 100 ms in as long a stretch before it)
    const win = Math.max(0.1, Math.min(g.t1, g.t + 0.3) - g.t);
    const bedMs = curveStat(short, g.t - 0.05 - win, g.t - 0.05, "max");
    const evMs = curveStat(short, g.t, g.t + win, "max");
    if (!(msToLufs(bedMs) > -60)) continue;   // no audible bed to be masked by
    const own = Math.max(evMs - bedMs, bedMs * 1e-3);
    g.musicLoudness = msToLufs(bedMs);
    g.ownLoudness = msToLufs(own);
    const under = g.musicLoudness - g.ownLoudness;
    g.buried = under > 6;
    if (under > 3) {
      const shown = own <= bedMs * 1e-3 ? "at least 30" : r1(under);
      problems.push({ severity: 2, text: `${g.label} at ${g.t.toFixed(2)} s is ${shown} dB under the music (${r1(g.ownLoudness)} vs ${r1(g.musicLoudness)} LUFS)${g.times.length > 1 ? ` (${g.times.length} times)` : ""} and may be masked → ${volumeAdvice(null, Math.min(30, under) + 3)}, or lower the music` });
    }
  }
  if (nonFinite) problems.push(NAN_PROBLEM(nonFinite));
  // ---- hygiene: true peak, clicks at sound edges, pops, double triggers, repetition ---------------------
  const tp = truePeak(chs);
  const st = shortTerm(chs, sr);
  if (tp.truePeak > Math.pow(10, -1 / 20) && !mix.clipped) {
    problems.push({ severity: tp.truePeak >= 1 ? 1 : 2, text: `true peak ${r1(tp.true)} dBTP (sample peak ${r1(tp.sample)} dBFS): the waveform between samples ${tp.truePeak >= 1 ? "goes over full scale and clips" : "comes within 1 dB of clipping"} on playback → lower the master by about ${r1(tp.true + 1)} dB` });
  }
  const labelAt = (t) => { let best = null; for (const o of occurrences) if (Math.abs(o.t - t) <= 0.03 && (!best || Math.abs(o.t - t) < Math.abs(best.t - t))) best = o; return best ? best.label : null; };
  const ed = edges(x, sr);
  const cuts = new Map();
  for (const e of ed) {
    if (!e.clicksIn && !e.clicksOut) continue;
    const label = labelAt(e.t0) || `the sound at ${e.t0.toFixed(2)} s`;
    const c = cuts.get(label) || { label, ins: [], outs: [] };
    if (e.clicksIn) c.ins.push(e);
    if (e.clicksOut) c.outs.push(e);
    cuts.set(label, c);
  }
  const hygiene = { truePeakDb: tp.true, shortTermMax: st.max, loudnessRange: st.lra, abruptStarts: 0, abruptEnds: 0, pops: [], doubles: [], repeated: [] };
  for (const c of cuts.values()) {
    if (c.outs.length) {
      const e = c.outs[0];
      hygiene.abruptEnds += c.outs.length;
      problems.push({ severity: 3, text: `${c.label} ends abruptly at ${e.t1.toFixed(3)} s (cut at amplitude ${r3(e.lastAmp)}, ${Math.round((100 * e.lastAmp) / e.peak)}% of its peak)${c.outs.length > 1 ? ` (${c.outs.length} times)` : ""}: it clicks → add a 5 ms fade-out` });
    }
    if (c.ins.length) {
      const e = c.ins[0];
      hygiene.abruptStarts += c.ins.length;
      problems.push({ severity: 3, text: `${c.label} starts abruptly at ${e.t0.toFixed(3)} s (first sample at amplitude ${r3(e.first)}, ${Math.round((100 * e.first) / e.peak)}% of its peak)${c.ins.length > 1 ? ` (${c.ins.length} times)` : ""}: it clicks → add a 2 ms fade-in` });
    }
  }
  const pp = pops(x, sr);
  hygiene.pops = pp;
  if (pp.length) problems.push({ severity: 2, text: `${pp.length} pop${pp.length === 1 ? "" : "s"} inside the audio at ${pp.slice(0, 5).map((q) => `${q.t.toFixed(3)} s`).join(", ")}${pp.length > 5 ? ", …" : ""} (a jump of ${pp[0].jump} where the waveform is otherwise smooth) → a buffer cut short, or a sound stopped mid-waveform` });
  const env2 = envelope([x], sr, 0.002);
  const doubles = new Map();
  const segAt = new Map(segs.map((q) => [q.t, q]));
  for (const o of occurrences) {
    // under another sound the mix's level moves with that one too: look for a restart on its own bands, or not at all
    const sg = segAt.get(o.t);
    let env = env2;
    if (sg && (sg.over || []).length) {
      const on = onsets.find((q) => q.bands && q.bands.length && Math.abs(q.t - o.t) <= 0.004);
      if (!on) continue;
      env = envelope([bandPass(x, sr, Math.max(0, o.t - 0.15), Math.min(duration, o.t + 0.2), on.bands)], sr, 0.002);
    }
    const sa = secondAttack(env, o.t, 0.002);
    // only a restart 1-2 frames later (14-36 ms) counts: shorter gaps are a sound's own texture
    if (sa && sa.dt >= 14 && sa.dt <= 36) { const d = doubles.get(o.label) || { label: o.label, hits: [] }; d.hits.push({ t: o.t, ...sa }); doubles.set(o.label, d); }
  }
  for (const d of doubles.values()) {
    hygiene.doubles.push({ label: d.label, times: d.hits.map((h) => r3(h.t)), dt: d.hits[0].dt });
    problems.push({ severity: 2, text: `${d.label} at ${d.hits.map((h) => `${h.t.toFixed(2)} s`).slice(0, 4).join(", ")} has a second attack ${d.hits[0].dt} ms after the first (+${d.hits[0].rise} dB): played twice${d.hits[0].dt <= 20 ? ", a frame apart" : ""} (double-triggered?)` });
  }
  for (const g of groups) {
    if (g.times.length < 6 || g.analysis.silent) continue;
    const n = Math.min(Math.round(0.4 * sr), Math.round((g.t1 - g.t0) * sr));
    const clip = (t) => x.subarray(Math.max(0, Math.round(t * sr)), Math.max(0, Math.round(t * sr)) + n);
    const sims = g.times.slice(1, 6).map((t) => similarity(clip(g.times[0]), clip(t)));
    if (sims.every((v) => v >= 0.99)) {
      hygiene.repeated.push({ label: g.label, count: g.times.length });
      problems.push({ severity: 3, text: `${g.label} plays ${g.times.length} times with the same waveform each time → vary its pitch by ±1–2 semitones or alternate 2–3 takes, so it doesn't grate` });
    }
  }
  let dc = 0;
  for (let i = 0; i < len; i++) dc += x[i];
  dc /= len;
  if (Math.abs(dc) > 0.02) problems.push({ severity: 3, text: `DC offset of ${dc.toFixed(3)} (the waveform is not centered) → it wastes headroom and clicks when sounds start or stop; check generated waveforms` });
  let balance = 0;
  if (chs.length === 2) {
    let l = 0, r = 0;
    for (let i = 0; i < len; i++) { l += chs[0][i] * chs[0][i]; r += chs[1][i] * chs[1][i]; }
    balance = l > 0 && r > 0 ? 10 * Math.log10(r / l) : r > 0 ? 60 : l > 0 ? -60 : 0;
    if (Math.abs(balance) >= 6) problems.push({ severity: 3, text: `the mix leans ${balance > 0 ? "right" : "left"} ${Math.abs(balance) >= 60 ? "completely (one channel is silent)" : `by ${r1(Math.abs(balance))} dB`} → check panning, or a mono source written to one channel` });
  }
  problems.sort((a, b) => a.severity - b.severity);

  const sounds = groups.map((g) => ({
    label: g.label, t: r3(g.t), times: g.times.map(r3), count: g.times.length, overMusic: g.overMusic,
    musicLoudness: g.musicLoudness ?? null, ownLoudness: g.ownLoudness ?? null,
    description: g.buried ? "barely audible over the music (it adds almost nothing to the mix there), so it can't be described on its own" : describeEvent(g.analysis) + (g.with && g.with.length ? ` (starts together with ${[...new Set(g.with)].join(", ")}: measured with it, they can't be told apart)` : g.over && g.over.length ? (g.analysis.ownBands ? ` (always under ${[...new Set(g.over)].join(", ")}: measured on the bands it adds; pitch not separable)` : ` (always overlapped by ${[...new Set(g.over)].join(", ")}: measured with it)`) : ""),
    analysis: g.analysis,
  }));
  const report = jsonSafe({
    ...base,
    mix: {
      peakDb: mix.peakDb, clipped: mix.clipped, integrated: mix.integrated, dcOffset: Math.round(dc * 10000) / 10000, balance: r1(balance),
      silences: mix.silences, loudness: { times: mix.loudness.times.map(r3), lufs: mix.loudness.lufs.map(r1) },
      truePeakDb: hygiene.truePeakDb, shortTermMax: hygiene.shortTermMax, loudnessRange: hygiene.loudnessRange,
    },
    hygiene: { abruptStarts: hygiene.abruptStarts, abruptEnds: hygiene.abruptEnds, pops: hygiene.pops, doubles: hygiene.doubles, repeated: hygiene.repeated },
    onsets: onsets.length, music, sounds, problems, notes,
  });
  const segments = groups.map((g, i) => ({ ...report.sounds[i], channels: g.channels, sampleRate: sr, offset: g.t0 }));
  return { report, text: formatPCMReport(report), segments, channels: chs, sampleRate: sr };
}

/** The plain-language report for analyzePCM, in the style of `lumen listen`. */
export function formatPCMReport(rep) {
  const L = [];
  const m = rep.mix, n = rep.sounds.length, total = rep.sounds.reduce((a, s) => a + s.count, 0);
  const layout = rep.channels === 1 ? "mono" : rep.channels === 2 ? "stereo" : `${rep.channels} channels`;
  const musicSpan = rep.music.length ? `, music ${rep.music.map((mu) => `${mu.t0.toFixed(2)}–${mu.t1.toFixed(2)} s`).join(", ")}` : ", no music";
  L.push(`♪ ${rep.title} — ${rep.duration.toFixed(2)} s of audio (${rep.sampleRate / 1000} kHz ${layout}): ${n} distinct sound${n === 1 ? "" : "s"}${total > n ? ` (${total} in all)` : ""}${musicSpan}`);
  L.push(`Mix: peak ${m.peakDb === null ? "-inf" : r1(m.peakDb)} dBFS${m.truePeakDb != null ? ` (true peak ${r1(m.truePeakDb)} dBTP)` : ""} · integrated ${m.integrated === null ? "silent" : r1(m.integrated) + " LUFS"}${m.shortTermMax != null ? ` · short-term max ${r1(m.shortTermMax)} LUFS, range ${r1(m.loudnessRange)} LU` : ""} · ${m.clipped ? `CLIPS (${m.clipped} samples)` : "no clipping"}`);
  L.push(rep.segmentation === "events"
    ? "Sounds are cut at the event times the game reported."
    : `Sounds were found by onset detection (${rep.onsets} onset${rep.onsets === 1 ? "" : "s"}); pass event times for exact labels.`);
  for (const mu of rep.music) {
    L.push("");
    L.push(`Music (${mu.t0.toFixed(2)}–${mu.t1.toFixed(2)} s)`);
    const tempo = mu.beat ? `tempo ${r1(mu.tempo)} bpm (confidence ${mu.tempoConfidence.toFixed(2)})` : "no steady beat";
    L.push(`  ${tempo} · ${mu.pitched ? `key ${mu.key} (r=${mu.keyR.toFixed(2)}; next ${mu.keyRunnerUp})` : "no pitched parts"} · loudness ${mu.loudness === null ? "-" : r1(mu.loudness)} LUFS, range ${r1(mu.loudnessRange)} dB`);
    if (mu.chords.length) {
      const shown = mu.chords.slice(0, 16).map((c) => `${c.chord}${c.alt ? `/${c.alt}` : ""} @${c.t.toFixed(1)}s`);
      L.push(`  chords: ${shown.join(" → ")}${mu.chords.length > 16 ? " → …" : ""}${mu.chords.some((c) => c.chord === "?") ? "   (? = unclear)" : ""}`);
    }
    if (mu.melody) L.push(`  melody guess: ${mu.melody.text}`);
  }
  if (rep.sounds.length) {
    L.push("");
    L.push("Sounds:");
    for (const s of rep.sounds) {
      const when = s.count > 1 ? `  at ${s.times.slice(0, 8).map((t) => t.toFixed(2)).join(", ")}${s.count > 8 ? ", …" : ""} s` : "";
      L.push(`  ${s.t.toFixed(2).padStart(6)} s  ${s.label}${s.count > 1 ? ` ×${s.count}` : ""}${when}`);
      L.push(`           ${s.description}${s.overMusic && !/^barely audible/.test(s.description) ? "   (measured over the music)" : ""}`);
      if (s.musicLoudness !== null && s.ownLoudness !== null) {
        const d = s.ownLoudness - s.musicLoudness;
        L.push(`           vs music: ${d >= 0 ? "+" : ""}${r1(d)} dB`);
      }
    }
  }
  if (rep.notes.length) { L.push(""); for (const t of rep.notes) L.push(`note: ${t}`); }
  L.push("");
  if (rep.problems.length) {
    L.push("Problems (most important first):");
    rep.problems.slice(0, 12).forEach((p, i) => L.push(`  ${i + 1}. ${p.text}`));
    if (rep.problems.length > 12) L.push(`  … ${rep.problems.length - 12} more (--json)`);
  } else L.push("No problems found.");
  return L.join("\n");
}
