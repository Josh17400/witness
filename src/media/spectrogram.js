// Witness media: the pictures `witness listen` writes, ported from Lumen's audio-listen.js.
//
//   timelinePNG(pcm, { events, markers, title, analysis })  -> PNG Buffer
//       the whole run: a level lane (with music: the 400 ms loudness curve, music stretches, each sound's level;
//       sound effects only: a 10 ms peak envelope in dBFS, so each sound's attack, length and tail show), a
//       log-frequency spectrogram labelled with notes C2..C8, a dB color scale, a time axis,
//       marker lines, and an event lane (music with tempo/key/chords, each sound by name)
//   soundSheetPNG(segments, { title })                     -> PNG Buffer
//       a card per distinct sound: its own spectrogram, its envelope in dB, and a caption
//
// `analysis` is analyzePCM()'s result; pass it to avoid analyzing twice (timelinePNG runs
// analyzePCM itself otherwise). `segments` is analyzePCM(...).segments.

import { Raster } from "./raster.js";
import { analyzePCM, spectrogram, mono } from "./audio-analysis.js";

const COL = {
  bg: "#0d0f14", panel: "#151922", well: "#0f1218", grid: "rgba(255,255,255,0.10)", text: "#e8ecf4", dim: "#8a93a6",
  mix: "#ffffff", music: "#4dd6c8", sfx: "#ffb347", warn: "#ff5d73", mark: "rgba(255,90,120,0.9)",
};
const DB_LO = -96, DB_HI = -6;
const W = 1280;

/** Inferno colormap (polynomial fit), t in 0..1. */
function inferno(t) {
  t = Math.max(0, Math.min(1, t));
  const c = [[0.00021894, 0.0016510, -0.019480], [0.10651, 0.56396, 3.9327], [11.6025, -3.97285, -15.9424],
    [-41.7040, 17.4364, 44.3541], [77.1629, -33.4024, -81.8073], [-71.3194, 32.6261, 73.2095], [25.1311, -12.2427, -23.0703]];
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) { let v = 0; for (let i = 6; i >= 0; i--) v = v * t + c[i][k]; out[k] = Math.round(Math.max(0, Math.min(1, v)) * 255); }
  return out;
}
const LUT = Array.from({ length: 256 }, (_, i) => inferno(i / 255));

const fmtT = (s) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`);
const r1 = (x) => Math.round(x * 10) / 10;
const fmax = (sr) => Math.min(16000, sr * 0.45);
const FMIN = 55;

/**
 * The sample peak of every `win`-second window, in dBFS (a full-scale sine = 0 dB, amplitude 0.5 = -6.02 dB;
 * silence = -Infinity). channels: Float32Array per channel. Returns { win, times: window starts, db }.
 */
export function peakEnvelope(channels, sr, win = 0.01) {
  const n = Math.max(1, Math.round(sr * win)), len = channels && channels[0] ? channels[0].length : 0;
  const k = Math.ceil(len / n), times = new Array(k), db = new Array(k);
  for (let w = 0; w < k; w++) {
    let p = 0;
    for (const ch of channels) for (let i = w * n, e = Math.min(len, (w + 1) * n); i < e; i++) { const a = Math.abs(ch[i]); if (a > p) p = a; }
    times[w] = (w * n) / sr;
    db[w] = p > 0 ? 20 * Math.log10(p) : -Infinity;
  }
  return { win: n / sr, times, db };
}

/** Which level lane the timeline draws: the loudness curve when there's music, else the 10 ms SFX envelope. */
export function levelLane(analysis) {
  const rep = analysis.report;
  if (rep.music.length) return { kind: "loudness", label: "LUFS", lo: -60, times: rep.mix.loudness ? rep.mix.loudness.times : [], values: rep.mix.loudness ? rep.mix.loudness.lufs : [] };
  const env = peakEnvelope(analysis.channels || [], analysis.sampleRate, 0.01);
  return { kind: "envelope", label: "dBFS", lo: -60, win: env.win, times: env.times, values: env.db };
}

/** Paint a log-frequency spectrogram of x over [t0, t1) into box (row 0 at the bottom). */
function paintSpectrogram(g, x, sr, box, t0, t1, { nfft } = {}) {
  const cols = Math.max(1, Math.floor(box.w)), rows = Math.max(1, Math.floor(box.h));
  const n = nfft || 1 << Math.round(Math.log2(sr * 0.085));
  const sp = spectrogram(x, sr, { t0, t1, cols, rows, fmin: FMIN, fmax: fmax(sr), nfft: n });
  const img = new Uint8Array(cols * rows * 4);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = (sp.data[r * cols + c] - DB_LO) / (DB_HI - DB_LO);
      const [R, G, B] = LUT[Math.max(0, Math.min(255, Math.round(v * 255)))];
      const o = ((rows - 1 - r) * cols + c) * 4;
      img[o] = R; img[o + 1] = G; img[o + 2] = B; img[o + 3] = 255;
    }
  }
  g.putRGBA(box.x, box.y, cols, rows, img);
}

const freqY = (f, box, sr) => box.y + box.h - (Math.log(f / FMIN) / Math.log(fmax(sr) / FMIN)) * box.h;

/** Octave lines at every C (C2..C8) with note (and Hz) labels left of the box. */
function noteAxis(g, box, sr, { small = false } = {}) {
  for (let o = 2; o <= 8; o++) {
    const f = 440 * Math.pow(2, (12 * (o + 1) - 69) / 12);
    const y = Math.round(freqY(f, box, sr));
    if (y < box.y - 1 || y > box.y + box.h + 1) continue;
    g.fillRect(box.x, y, box.w, 1, "rgba(255,255,255,0.16)");
    if (small && o % 2) continue;
    const hz = f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}`;
    g.text(small ? `C${o}` : `C${o} ${hz.padStart(4)}`, box.x - 6, y, { color: COL.text, align: "right", baseline: "middle" });
  }
}

function timeTicks(g, box, t0, t1, y) {
  const span = t1 - t0, steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120];
  const step = steps.find((s) => span / s <= Math.max(4, Math.floor(box.w / 90))) || 300;
  for (let t = Math.ceil(t0 / step - 1e-9) * step; t <= t1 + 1e-9; t += step) {
    const x = Math.round(box.x + ((t - t0) / span) * box.w);
    g.fillRect(x, y, 1, 5, COL.dim);
    g.text(`${+t.toFixed(2)} s`, x, y + 8, { color: COL.dim, align: "center" });
  }
}

function colorbar(g, x, y, h) {
  for (let i = 0; i < h; i++) { const [R, G, B] = LUT[Math.round((1 - i / h) * 255)]; g.fillRect(x, y + i, 12, 1, [R, G, B, 1]); }
  g.strokeRect(x, y, 12, h, "rgba(255,255,255,0.18)");
  for (const v of [-6, -30, -60, -90]) {
    const yy = Math.round(y + ((DB_HI - v) / (DB_HI - DB_LO)) * h);
    g.fillRect(x + 12, yy, 4, 1, COL.dim);
    g.text(`${v} dB`, x + 20, yy, { color: COL.dim, baseline: "middle" });
  }
}

/** Greedy label rows so text never overlaps. Returns the row of each item. */
function rowsFor(items, maxRows) {
  const ends = [];
  return items.map((it) => {
    let r = ends.findIndex((e) => e <= it.x);
    if (r < 0) r = ends.length < maxRows ? ends.length : ends.indexOf(Math.min(...ends));
    ends[r] = it.x + it.w + 8;
    return r;
  });
}

/** A filled triangle pointing up, centred on (x, y). */
const triangle = (g, x, y, color) => g.polygon([[x, y - 5], [x + 5, y + 4], [x - 5, y + 4]], color);

// ---------------------------------------------------------------------------
// the timeline
// ---------------------------------------------------------------------------

/**
 * The whole-run picture.
 * @param pcm   protocol PCM (ignored when `analysis` is given)
 * @param opts  { events?, markers?: [{ t, label }], title?, analysis?: analyzePCM() result }
 */
export function timelinePNG(pcm, { events = null, markers = [], title, analysis = null } = {}) {
  const res = analysis || analyzePCM(pcm, { events, title: title ?? "game" });
  const rep = res.report, sr = res.sampleRate;
  const t1 = Math.max(rep.duration, 0.05);
  const L = 104, R = 100, PW = W - L - R;
  const X = (t) => L + (t / t1) * PW;
  const marks = (Array.isArray(markers) ? markers : []).filter((m) => m && Number.isFinite(+m.t)).map((m) => ({ t: +m.t, label: String(m.label ?? "mark") }));

  // lay out the event labels first so the picture is exactly as tall as it needs to be
  const items = [];
  for (const s of rep.sounds) for (const t of s.times) {
    const len = s.analysis && !s.analysis.silent && !/^barely/.test(s.description) ? Math.min(s.analysis.length, t1 - t) : 0.05;
    items.push({ x: X(t), t, s, len, w: Math.max(8 * s.label.length + 12, X(t + len) - X(t)) });
  }
  items.sort((a, b) => a.x - b.x);
  // a label that would run off the right edge sits to the left of its marker instead
  for (const it of items) { it.flip = it.x + 8 * it.s.label.length + 12 > L + PW; it.lx = it.flip ? it.x - 8 * it.s.label.length - 8 : it.x; }
  items.sort((a, b) => a.lx - b.lx);   // pack rows in the order the labels start
  const rows = rowsFor(items.map((it) => ({ x: it.lx, w: it.flip ? it.x - it.lx + Math.max(2, X(it.t + it.len) - it.x) : it.w })), 10);
  const nRows = items.length ? Math.max(...rows) + 1 : 0;
  const header = 84, laneH = 112, specH = 420;
  const lane = { x: L, y: header, w: PW, h: laneH };
  const box = { x: L, y: lane.y + lane.h + 16, w: PW, h: specH };
  const evY = box.y + box.h + 36;
  const evH = 12 + rep.music.length * 40 + nRows * 22 + (rep.music.length || nRows ? 4 : 26);
  const H = evY + evH + 12;
  const g = new Raster(W, H, COL.bg);
  const m = rep.mix;

  // ---- header ----
  g.text(g.fitText(`${rep.title} — what the player hears (${rep.duration.toFixed(2)} s)`, W - L - 24, { scale: 2 }), L, 28, { scale: 2, bold: true, color: COL.text, baseline: "middle" });
  const stats = `peak ${m.peakDb === null ? "-inf" : r1(m.peakDb)} dBFS · ${m.integrated === null ? "silent" : r1(m.integrated) + " LUFS integrated"} · ${m.clipped ? m.clipped + " clipped samples" : "no clipping"} · ${rep.sounds.length} sound${rep.sounds.length === 1 ? "" : "s"} · ${rep.problems.length} problem${rep.problems.length === 1 ? "" : "s"}`;
  g.text(stats, L, 60, { color: m.clipped ? COL.warn : COL.dim, baseline: "middle" });

  // ---- level lane: loudness with music, a 10 ms peak envelope for sound effects ----
  const lvl = levelLane(res);
  g.fillRect(lane.x, lane.y, lane.w, lane.h, COL.panel);
  const LY = (v) => lane.y + lane.h - ((Math.max(-60, Math.min(0, v)) + 60) / 60) * lane.h;
  for (const mu of rep.music) g.fillRect(X(mu.t0), lane.y, X(mu.t1) - X(mu.t0), lane.h, "rgba(77,214,200,0.10)");
  for (const v of [0, -20, -40, -60]) {
    const y = Math.round(LY(v));
    g.fillRect(lane.x, Math.min(y, lane.y + lane.h - 1), lane.w, 1, COL.grid);
    g.text(`${v}`, lane.x - 8, Math.min(Math.max(y, lane.y + 6), lane.y + lane.h - 6), { color: COL.dim, align: "right", baseline: "middle" });
  }
  g.textUp(lvl.label, 16, lane.y + lane.h / 2, { color: COL.dim });
  g.save().clip(lane.x, lane.y, lane.w, lane.h);
  if (lvl.kind === "envelope") {
    // one column per pixel: the loudest window that falls in it, filled down to the floor
    const cols = new Float64Array(lane.w).fill(-Infinity);
    lvl.times.forEach((t, i) => {
      const a = Math.floor(X(t) - lane.x), b = Math.max(a, Math.floor(X(t + lvl.win) - lane.x) - 1);
      for (let c = Math.max(0, a); c <= Math.min(lane.w - 1, b); c++) if (lvl.values[i] > cols[c]) cols[c] = lvl.values[i];
    });
    for (let c = 0; c < lane.w; c++) if (cols[c] > -60) { const y = Math.round(LY(cols[c])); g.fillRect(lane.x + c, y, 1, lane.y + lane.h - y, "rgba(255,179,71,0.55)"); g.fillRect(lane.x + c, y, 1, 1, COL.sfx); }
  } else {
    g.polyline(lvl.times.map((t, i) => [X(t), LY(lvl.values[i] ?? -120)]), COL.mix, 1.75);
    for (const s of rep.sounds) {
      const lv = s.ownLoudness ?? (s.analysis && !s.analysis.silent ? s.analysis.loudness : null);
      if (lv === null) continue;
      for (const t of s.times) triangle(g, X(t), LY(lv), COL.sfx);
    }
  }
  g.restore();
  g.strokeRect(lane.x, lane.y, lane.w, lane.h, "rgba(255,255,255,0.12)");
  const lx = lane.x + lane.w + 12;
  if (lvl.kind === "envelope") {
    g.fillRect(lx, lane.y + 6, 14, 10, "rgba(255,179,71,0.55)"); g.text("peak", lx + 20, lane.y + 11, { color: COL.sfx, baseline: "middle" });
    g.text("per 10 ms", lx, lane.y + 31, { color: COL.dim, baseline: "middle" });
  } else {
    g.fillRect(lx, lane.y + 10, 14, 2, COL.mix); g.text("mix", lx + 20, lane.y + 11, { color: COL.mix, baseline: "middle" });
    triangle(g, lx + 7, lane.y + 31, COL.sfx); g.text("sound", lx + 20, lane.y + 31, { color: COL.sfx, baseline: "middle" });
    if (rep.music.length) { g.fillRect(lx, lane.y + 45, 14, 12, "rgba(77,214,200,0.45)"); g.text("music", lx + 20, lane.y + 51, { color: COL.music, baseline: "middle" }); }
  }

  // ---- spectrogram ----
  paintSpectrogram(g, mono(res.channels), sr, box, 0, t1);
  noteAxis(g, box, sr);
  colorbar(g, box.x + box.w + 12, box.y, box.h);
  g.textUp("pitch (note, Hz)", 16, box.y + box.h / 2, { color: COL.dim });
  for (const mu of rep.music) for (const c of mu.chords) if (c.t > mu.t0 + 1e-3) g.fillRect(Math.round(X(c.t)), box.y, 1, box.h, "rgba(77,214,200,0.40)");
  if (items.length <= 30) for (const it of items) g.fillRect(Math.round(it.x), box.y, 1, box.h, "rgba(255,179,71,0.55)");
  else for (const it of items) { g.fillRect(Math.round(it.x), box.y, 1, 10, COL.sfx); g.fillRect(Math.round(it.x), box.y + box.h - 10, 1, 10, COL.sfx); }   // busy runs: ticks, not curtains
  g.strokeRect(box.x, box.y, box.w, box.h, "rgba(255,255,255,0.12)");
  timeTicks(g, box, 0, t1, box.y + box.h + 2);

  // ---- markers (e.g. replay F8 marks) ----
  if (marks.length) {
    const mi = marks.map((mk) => ({ mk, x: X(Math.max(0, Math.min(t1, mk.t))), w: g.measureText(mk.label) + 12 })).sort((a, b) => a.x - b.x);
    const mrows = rowsFor(mi.map((it) => ({ x: Math.min(box.x + box.w - it.w, it.x + 4), w: it.w })), 3);
    mi.forEach((it, i) => {
      g.line(Math.round(it.x) + 0.5, lane.y, Math.round(it.x) + 0.5, box.y + box.h, COL.mark, 1.5, { dash: [6, 5] });
      const bx = Math.min(box.x + box.w - it.w, Math.round(it.x) + 4), by = box.y + 6 + mrows[i] * 24;
      g.roundRect(bx, by, it.w, 20, 4, COL.mark);
      g.text(it.mk.label, bx + 6, by + 10, { color: "#ffffff", bold: true, baseline: "middle" });
    });
  }

  // ---- event lane ----
  const ev = { x: L, y: evY, w: PW, h: evH };
  g.fillRect(ev.x, ev.y, ev.w, ev.h, COL.panel);
  g.save().clip(ev.x, ev.y, ev.w, ev.h);
  let y = ev.y + 16;
  for (const mu of rep.music) {
    const x0 = X(mu.t0), x1 = X(mu.t1);
    g.roundRect(x0, y - 9, Math.max(3, x1 - x0), 18, 3, "rgba(77,214,200,0.28)");
    const chordList = mu.chords.length ? ` · ${mu.chords.slice(0, 8).map((c) => c.chord).join(" ")}${mu.chords.length > 8 ? " …" : ""}` : "";
    const info = `music${mu.beat ? ` · ${r1(mu.tempo)} bpm` : ""}${mu.pitched ? ` · ${mu.key}` : ""}${chordList}`;
    g.text(g.fitText(info, Math.max(80, ev.x + ev.w - x0 - 12)), x0 + 6, y, { color: COL.music, bold: true, baseline: "middle" });
    // chord names under their bars, only when every one fits (a partial list would mislead)
    if (mu.chords.every((c) => X(c.end) - X(c.t) >= 8 * c.chord.length + 6)) {
      for (const c of mu.chords) g.text(c.chord, X(c.t) + 3, y + 19, { color: "rgba(255,255,255,0.62)", baseline: "middle" });
    }
    y += 40;
  }
  items.forEach((it, i) => {
    const yy = y + rows[i] * 22;
    g.fillRect(it.x, yy - 8, Math.max(2, X(it.t + it.len) - it.x), 16, "rgba(255,179,71,0.30)");
    g.fillRect(it.x, yy - 8, 2, 16, COL.sfx);
    if (it.flip) g.text(it.s.label, it.x - 4, yy, { color: COL.text, align: "right", baseline: "middle" });
    else g.text(it.s.label, it.x + 6, yy, { color: COL.text, baseline: "middle" });
  });
  if (!rep.music.length && !items.length) g.text(rep.empty ? "silent: nothing audible" : "no distinct sounds found", ev.x + ev.w / 2, ev.y + ev.h / 2, { color: COL.dim, align: "center", baseline: "middle" });
  g.restore();
  return g.toPNG();
}

// ---------------------------------------------------------------------------
// the sound sheet
// ---------------------------------------------------------------------------

/** RMS envelope in dB (relative to its own peak) over n columns. */
function envelopeDb(x, sr, t0, span, n) {
  const i0 = Math.floor(t0 * sr), per = Math.max(1, Math.floor((span * sr) / n));
  let mx = 1e-9;
  const raw = [];
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let i = i0 + k * per; i < Math.min(x.length, i0 + (k + 1) * per); i++) s += x[i] * x[i];
    const v = Math.sqrt(s / per);
    raw.push(v);
    if (v > mx) mx = v;
  }
  return raw.map((v) => (v > 0 ? 20 * Math.log10(v / mx) : -120));
}

/**
 * A grid of cards, one per distinct sound (analyzePCM(...).segments).
 * @param opts { title?, sampleRate? (when segments don't carry it), maxCards = 24 }
 */
export function soundSheetPNG(segments, { title = "game", sampleRate, maxCards = 24 } = {}) {
  const COLS = 3, PAD = 14, cw = Math.floor((W - PAD * (COLS + 1)) / COLS), ch = 282;
  const list = (Array.isArray(segments) ? segments : []).filter((s) => s && s.analysis && s.channels);
  const shown = list.slice(0, maxCards);
  const H = 76 + Math.max(1, Math.ceil(shown.length / COLS)) * (ch + PAD) + (list.length > shown.length ? 24 : 0);
  const g = new Raster(W, H, COL.bg);
  g.text(`${title} — sound sheet`, PAD, 26, { scale: 2, bold: true, color: COL.text, baseline: "middle" });
  g.text("each card: pitch (C2–C8) over time, brighter = louder · below: envelope in dB (−60…0) and the time span shown", PAD, 56, { color: COL.dim, baseline: "middle" });
  if (!shown.length) {
    g.text("no sounds to show", W / 2, 76 + ch / 2, { color: COL.dim, scale: 2, align: "center", baseline: "middle" });
    return g.toPNG();
  }
  shown.forEach((seg, i) => {
    const a = seg.analysis, sr = seg.sampleRate || sampleRate || 48000;
    const x = PAD + (i % COLS) * (cw + PAD), y = 76 + Math.floor(i / COLS) * (ch + PAD);
    g.roundRect(x, y, cw, ch, 6, COL.panel);
    const name = `${seg.label}${seg.count > 1 ? ` ×${seg.count}` : ""}`;
    const when = `@ ${(+seg.t).toFixed(2)} s`;
    g.text(g.fitText(name, cw - 24 - g.measureText(when)), x + 10, y + 16, { color: COL.sfx, bold: true, baseline: "middle" });
    g.text(when, x + cw - 10, y + 16, { color: COL.dim, align: "right", baseline: "middle" });

    const sx = mono(seg.channels);
    const span = a.silent ? 0.5 : Math.max(0.15, a.length * 1.15 + 0.03);
    const t0 = a.silent ? 0 : Math.max(0, a.start - 0.01);
    const sbox = { x: x + 44, y: y + 32, w: cw - 54, h: 124 };
    paintSpectrogram(g, sx, sr, sbox, t0, t0 + span, { nfft: 1 << Math.round(Math.log2(sr * 0.043)) });
    noteAxis(g, sbox, sr, { small: true });
    g.strokeRect(sbox.x, sbox.y, sbox.w, sbox.h, "rgba(255,255,255,0.10)");

    const ebox = { x: sbox.x, y: sbox.y + sbox.h + 6, w: sbox.w, h: 38 };
    g.fillRect(ebox.x, ebox.y, ebox.w, ebox.h, COL.well);
    g.fillRect(ebox.x, ebox.y + Math.round(ebox.h / 2), ebox.w, 1, "rgba(255,255,255,0.06)");
    if (!a.silent) {
      const env = envelopeDb(sx, sr, t0, span, ebox.w);
      g.save().clip(ebox.x, ebox.y, ebox.w, ebox.h);
      g.polyline(env.map((v, k) => [ebox.x + k + 0.5, ebox.y + ebox.h - 1 - ((Math.max(-60, v) + 60) / 60) * (ebox.h - 2)]), COL.sfx, 1.5);
      g.restore();
    }
    const [num, unit] = fmtT(span).split(" ");   // the span shown, in the margin left of the envelope
    g.text(num, ebox.x - 6, ebox.y + 10, { color: COL.dim, align: "right", baseline: "middle" });
    g.text(unit, ebox.x - 6, ebox.y + 28, { color: COL.dim, align: "right", baseline: "middle" });

    const buried = /^barely audible/.test(seg.description || "");
    const lines = a.silent ? ["SILENT (nothing audible)"] : buried ? ["barely audible over the music:", "it adds almost nothing to the mix,", "so these pictures show the music"] : [
      `${fmtT(a.length)} ${a.shape} · ${a.pitch.kind === "unpitched" ? (a.sweep || "unpitched") : a.pitch.text}`,
      `${a.brightness} ${Math.round(a.centroid)} Hz · ${a.tonality}`,
      `peak ${r1(a.peakDb)} dBFS · ${r1(a.loudness)} LUFS${a.clipped ? " · CLIPS" : ""}`,
    ];
    lines.forEach((ln, k) => g.text(g.fitText(ln, cw - 20), x + 10, ebox.y + ebox.h + 16 + k * 19, { color: a.clipped && k === 2 ? COL.warn : k ? COL.dim : COL.text, baseline: "middle" }));
  });
  if (list.length > shown.length) g.text(`+ ${list.length - shown.length} more sounds not shown`, PAD, H - 16, { color: COL.dim, baseline: "middle" });
  return g.toPNG();
}
