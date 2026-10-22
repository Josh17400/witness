// Accuracy tests for the ears: `node tests/media/audio.mjs`
// Part 1 ports Lumen's tests/listen.mjs (the analysis core on isolated sounds).
// Part 2 checks what Witness adds: raw PCM/WAV in, sounds found by onset detection, music
// found in a mix, masking against that music, and the ranked problems.
import {
  analyzeEvent, describeEvent, estimateTempo, analyzeMusic, estimateKey, chromagram, analyzeMix, transcribe,
  formatReport, spectrogram, loudnessCurve, integratedLoudness, midiToHz, mono,
  analyzePCM, decodePCM, concatPCM, wavToPCM, pcmToWav, detectOnsets,
} from "../../src/media/audio-analysis.js";
import { ok, show, done } from "./harness.mjs";
import { SR, buf, rnd, addTone, addNoise, fades, saw, square, stereo, kicks, chordTrack, CHORD_NOTES, toPCM } from "./signals.mjs";

console.log("audio analysis — isolated sounds (Lumen's listen.mjs)");

// ---- a 440 Hz sine reports A4 / steady ---------------------------------------------------
{
  const x = addTone(buf(1), 0.05, 0.8, () => 440, fades(0.8));
  const a = analyzeEvent(stereo(x), SR);
  show("440 Hz sine", describeEvent(a));
  ok("sine: steady", a.pitch.kind === "steady", a.pitch.text);
  ok("sine: A4", a.pitch.note === "A4", a.pitch.text);
  ok("sine: within 2 Hz", Math.abs(a.pitch.hz - 440) < 2, a.pitch.hz);
  ok("sine: tonal", a.tonality === "tonal", a.periodic);
  ok("sine: sustained", a.shape === "sustained", a.shape);
  ok("sine: length 0.8 s ±5%", Math.abs(a.length - 0.8) < 0.04, a.length);
  ok("sine: peak -6 dBFS", Math.abs(a.peakDb - (-6.02)) < 0.2, a.peakDb);
  ok("sine: centered", Math.abs(a.pan) < 0.01, a.pan);
}

// ---- sweeps rise and fall ------------------------------------------------------------------
{
  const x = addTone(buf(0.7), 0.05, 0.5, (t) => 200 + 2000 * t, fades(0.5));
  const a = analyzeEvent(stereo(x), SR);
  show("200→1200 Hz sweep", a.pitch.text);
  ok("sweep: rises", a.pitch.kind === "rise" && a.pitch.text.startsWith("rises"), a.pitch.text);
  ok("sweep: starts near 200 Hz", a.pitch.from > 180 && a.pitch.from < 260, a.pitch.from);
  ok("sweep: ends near 1200 Hz", a.pitch.to > 1050 && a.pitch.to < 1250, a.pitch.to);
}
{
  const x = addTone(buf(0.5), 0.02, 0.4, (t) => 1500 - 3000 * t, fades(0.4));
  const a = analyzeEvent(stereo(x), SR);
  show("1500→300 Hz fall", a.pitch.text);
  ok("fall: falls", a.pitch.kind === "fall", a.pitch.text);
}

// ---- noise is noisy ----------------------------------------------------------------------------
{
  const x = addNoise(buf(0.6), 0.05, 0.5, () => 0.3);
  const a = analyzeEvent(stereo(x), SR);
  show("white noise", describeEvent(a));
  ok("noise: noisy", a.tonality === "noisy", a.periodic);
  ok("noise: flat spectrum", a.flatness > 0.4, a.flatness);
  ok("noise: bright", a.brightness === "bright", `${a.brightness} ${a.centroid}`);
  ok("noise: unpitched", a.pitch.kind === "unpitched", a.pitch.text);
}
{
  // rumble: noise through two one-pole low-passes at ~300 Hz; flatness collapses but it is still noise
  const x = buf(0.6);
  let y = 0, z = 0;
  for (let i = Math.round(0.05 * SR); i < Math.round(0.55 * SR); i++) { y += 0.04 * (rnd() - y); z += 0.04 * (y - z); x[i] = z * 3; }
  const a = analyzeEvent(stereo(x), SR);
  show("rumble (filtered noise)", describeEvent(a));
  ok("filtered noise: noisy", a.tonality === "noisy", `${a.tonality} ${a.periodic}`);
  ok("filtered noise: not bright", a.brightness === "dark" || a.brightness === "warm", `${a.brightness} ${a.centroid}`);
}

// ---- a decaying pluck: plucky, right length -----------------------------------------------------
{
  const tau = 0.5 / Math.log(100);   // -40 dB after 0.5 s
  const x = addTone(buf(1.2), 0.1, 1.0, () => 330, (t) => 0.6 * Math.min(1, t / 0.002) * Math.exp(-t / tau), saw);
  const a = analyzeEvent(stereo(x), SR);
  show("pluck (−40 dB at 0.5 s)", describeEvent(a));
  ok("pluck: plucky", a.shape === "plucky", a.shape);
  ok("pluck: length 0.5 s ±10%", Math.abs(a.length - 0.5) <= 0.05, a.length);
  ok("pluck: fast attack", a.attack < 0.01, a.attack);
  ok("pluck: E4", a.pitch.note === "E4", a.pitch.text);
}

// ---- note steps, dyads, slow chromatic steps, pan -----------------------------------------------
{
  const x = addTone(buf(0.5), 0.02, 0.4, (t) => (t < 0.07 ? midiToHz(83) : midiToHz(88)), (t) => 0.4 * Math.min(1, t / 0.002, (0.4 - t) / 0.3));
  const a = analyzeEvent(stereo(x), SR);
  show("B5 then E6", a.pitch.text);
  ok("coin: rises B5→E6", a.pitch.kind === "notes" && a.pitch.notes.join(" ") === "B5 E6", a.pitch.text);
  ok("coin: over ~70 ms", Math.abs(a.pitch.over - 0.07) < 0.02, a.pitch.over);
}
{
  const x = buf(0.8);
  addTone(x, 0.02, 0.7, () => midiToHz(84), fades(0.7, 0.3));
  addTone(x, 0.02, 0.7, () => midiToHz(91), fades(0.7, 0.2));
  const a = analyzeEvent(stereo(x), SR);
  show("C6 + G6 together", a.pitch.text);
  ok("dyad: steady C6", a.pitch.kind === "steady" && a.pitch.note === "C6", a.pitch.text);
}
{
  const x = buf(1.3);
  [67, 66, 65, 64].forEach((m, i) => addTone(x, 0.02 + i * 0.26, 0.25, () => midiToHz(m), fades(0.25, 0.4)));
  const a = analyzeEvent(stereo(x), SR);
  show("G4 F#4 F4 E4 steps", a.pitch.text);
  ok("steps: falls G4→F#4→F4→E4", a.pitch.kind === "notes" && a.pitch.notes.join(" ") === "G4 F#4 F4 E4", a.pitch.text);
}
{
  const x = addTone(buf(0.4), 0.02, 0.3, () => 600, fades(0.3));
  const a = analyzeEvent([x, x.map((v) => v * 0.3)], SR);
  ok("pan: reports left", a.pan < -0.4, a.pan);
}

// ---- tempo ----------------------------------------------------------------------------------------
for (const bpm of [120, 90, 140]) {
  const t = estimateTempo(kicks(bpm, 10), SR);
  show(`${bpm} bpm kicks`, `${t.bpm.toFixed(2)} bpm (confidence ${t.confidence.toFixed(2)})`);
  ok(`tempo ${bpm} ±2`, Math.abs(t.bpm - bpm) <= 2, t.bpm);
}
{
  const k = kicks(120, 10);
  ok("declared 120 confirmed", Math.abs(estimateTempo(k, SR, 120).bpm - 120) <= 2);
  ok("declared 97 rejected for a 120 bpm beat", Math.abs(estimateTempo(k, SR, 97).bpm - 120) <= 2, estimateTempo(k, SR, 97).bpm);
}

// ---- chords and keys ---------------------------------------------------------------------------------
{
  const a = analyzeMusic(stereo(chordTrack(["C", "Am", "F", "G"])), SR, { grid: { start: 0, bpm: 120, beats: 4 } });
  const got = a.bars.map((b) => b.chord);
  show("C Am F G", got.join(" | "));
  ok("chords: C Am F G", got.join(" ") === "C Am F G", got.join(" "));
}
{
  // square waves: strong odd harmonics must not turn Am into Amaj7 (or shift the key to G)
  const names = ["C", "Am", "F", "G"], bar = 2, x = buf(8.2);
  names.forEach((n, i) => { for (const m of CHORD_NOTES[n]) addTone(x, i * bar, bar, () => midiToHz(m), (t) => 0.1 * Math.min(1, t / 0.02, (bar - t) / 0.05), square); });
  const a = analyzeMusic(stereo(x), SR, { grid: { start: 0, bpm: 120, beats: 4 } });
  show("square-wave C Am F G", `${a.bars.map((b) => b.chord).join(" | ")} · key ${a.key}`);
  ok("square chords: C Am F G", a.bars.map((b) => b.chord).join(" ") === "C Am F G", a.bars.map((b) => `${b.chord} [${b.notes}]`).join(" | "));
  ok("square chords: key C major", a.key === "C major", a.key);
}
function melodyKey(mel, bass) {
  const x = buf(mel.length * 0.5 + 0.2);
  mel.forEach((m, i) => addTone(x, i * 0.5, 0.45, () => midiToHz(m), (t) => 0.3 * Math.min(1, t / 0.01, (0.45 - t) / 0.05), saw));
  bass.forEach((m, i) => addTone(x, i * 2, 2, () => midiToHz(m), (t) => 0.2 * Math.min(1, t / 0.01, (2 - t) / 0.05)));
  const sum = new Float32Array(12);
  for (const f of chromagram(x, SR)) { const n = Math.hypot(...f.c) || 1; for (let i = 0; i < 12; i++) sum[i] += f.c[i] / n; }
  return estimateKey(sum);
}
{
  const k = melodyKey([60, 62, 64, 65, 67, 69, 71, 72, 67, 64, 60, 64, 67, 72, 67, 60], [48, 53, 55, 48]);
  show("C major melody", `${k.key} (r=${k.r.toFixed(2)}, next ${k.runnerUp})`);
  ok("key: C major", k.key === "C major", k.key);
}
{
  const k = melodyKey([69, 71, 72, 74, 76, 77, 80, 81, 76, 72, 69, 72, 76, 81, 76, 69], [45, 50, 52, 45]);
  show("A minor melody", `${k.key} (r=${k.r.toFixed(2)})`);
  ok("key: A minor", k.key === "A minor", k.key);
}

// ---- melody transcription -------------------------------------------------------------------------------
{
  const notes = ["E5", "-", "G5", "C6", "B5", "-", "_", "G5"];
  const midi = { E5: 76, G5: 79, C6: 84, B5: 83 };
  const step = 0.25, x = buf(notes.length * step + 0.3);
  notes.forEach((n, i) => {
    if (!midi[n]) return;
    let len = 1;
    while (notes[i + len] === "-") len++;
    const d = len * step - 0.02;
    addTone(x, i * step, d, () => midiToHz(midi[n]), (t) => 0.3 * Math.min(1, t / 0.005, (d - t) / 0.02), saw);
  });
  const got = transcribe(stereo(x), SR, { start: 0, step, steps: notes.length });
  show("transcribe E5 - G5 C6 B5 - _ G5", got.join(" "));
  ok("transcribe exact", got.join(" ") === notes.join(" "), got.join(" "));
}

// ---- clipping and masking in the mix -------------------------------------------------------------------
{
  const x = addTone(buf(0.5), 0.02, 0.4, () => 220, () => 1.6).map((v) => Math.max(-1, Math.min(1, v)));
  const a = analyzeEvent(stereo(x), SR);
  ok("clipping: event flag", a.clipped > 1000, a.clipped);
  const mix = analyzeMix(stereo(x), SR, null, [{ t: 0, label: "boom", analysis: a }], { duration: 0.5, audition: true });
  ok("clipping: mix problem first", mix.problems.length && /clips/.test(mix.problems[0].text), JSON.stringify(mix.problems));
  show("clipping problem", mix.problems[0] && mix.problems[0].text);
}
{
  const music = chordTrack(["C", "Am", "F", "G"]).map((v) => v * 1.6);
  const sfx = addTone(buf(0.4), 0.02, 0.3, () => 1318, (t) => 0.02 * Math.min(1, t / 0.002) * Math.exp(-t / 0.08));
  const mixL = music.slice(), at = 3;
  for (let i = 0; i < sfx.length; i++) mixL[Math.round(at * SR) + i] += sfx[i];
  const mix = analyzeMix(stereo(mixL), SR, stereo(music), [{ t: at, label: "coin", analysis: analyzeEvent(stereo(sfx), SR) }], { duration: 8 });
  const p = mix.problems.find((x) => /under the music/.test(x.text));
  show("masking problem", p ? p.text : "(none)");
  ok("masking flagged", !!p && /^coin at 3\.00 s is \d+(\.\d)? dB under the music/.test(p.text), JSON.stringify(mix.problems));
  const loud = addTone(buf(0.4), 0.02, 0.3, () => 1318, (t) => 0.9 * Math.min(1, t / 0.002) * Math.exp(-t / 0.15));
  const mix2 = analyzeMix(stereo(mixL), SR, stereo(music), [{ t: at, label: "coin", analysis: analyzeEvent(stereo(loud), SR) }], { duration: 8 });
  ok("loud sfx not flagged", !mix2.problems.some((x) => /under the music/.test(x.text)), JSON.stringify(mix2.problems));
}

// ---- silence, LUFS reference, spectrogram, report -------------------------------------------------------
{
  const x = buf(8);
  addTone(x, 0, 1, () => 440, fades(1, 0.5));
  addTone(x, 5.5, 1, () => 440, fades(1, 0.5));
  const mix = analyzeMix(stereo(x), SR, null, [], { duration: 8 });
  ok("silence flagged", mix.problems.some((p) => /silence from 0\.[89]|silence from 1\.0/.test(p.text)), JSON.stringify(mix.problems));
  const s = addTone(buf(3), 0, 3, () => 1000, () => 1);
  const l = integratedLoudness([s], SR);
  show("1 kHz full-scale sine", `${l.toFixed(2)} LUFS (reference -3.01)`);
  ok("LUFS reference within 0.3 dB", Math.abs(l + 3.01) < 0.3, l);
  ok("loudness curve has times", loudnessCurve([s], SR).times.length > 20);
}
{
  const x = addTone(buf(1), 0, 1, () => 440, () => 0.5);
  const sp = spectrogram(x, SR, { cols: 20, rows: 200, fmin: 55, fmax: 16000 });
  let best = 0, bv = -1e9;
  for (let r = 0; r < sp.rows; r++) if (sp.data[r * sp.cols + 10] > bv) { bv = sp.data[r * sp.cols + 10]; best = r; }
  const f = 55 * Math.pow(16000 / 55, best / (sp.rows - 1));
  ok("spectrogram row ≈ 440 Hz", Math.abs(Math.log2(f / 440)) < 0.05, f);
  ok("spectrogram level ≈ -6 dB", Math.abs(bv + 6) < 1.5, bv);
}
{
  const x = addTone(buf(0.5), 0.02, 0.4, () => 440, fades(0.4));
  const a = analyzeEvent(stereo(x), SR);
  const mix = analyzeMix(stereo(x), SR, null, [{ t: 0.1, label: "beep", analysis: a }], { duration: 0.5, audition: true });
  const text = formatReport({ title: "test", duration: 0.5, sampleRate: SR, mix, events: [{ t: 0.1, label: "beep", src: "game.lum:3", analysis: a }], music: [] });
  ok("report mentions the sound", /beep/.test(text) && /steady A4/.test(text) && /game\.lum:3/.test(text), text);
  ok("mono helper", mono([new Float32Array([1, 0]), new Float32Array([0, 1])])[0] === 0.5);
}

console.log("\naudio analysis — raw game audio (analyzePCM)");

// ---- PCM decoding and WAV files ------------------------------------------------------------------------
{
  const x = addTone(buf(0.25), 0, 0.25, () => 440, () => 0.5);
  const s16 = toPCM([x, x.map((v) => -v)], "s16");
  const d = decodePCM({ ...s16, data: s16.data.toString("base64") });
  ok("pcm: base64 s16 decodes", d.channels.length === 2 && d.channels[0].length === x.length, d.channels[0].length);
  ok("pcm: s16 values within 1 LSB", Math.abs(d.channels[0][100] - x[100]) < 2 / 32768 && Math.abs(d.channels[1][100] + x[100]) < 2 / 32768);
  const wav = pcmToWav(s16);
  const back = wavToPCM(wav);
  ok("wav: 16-bit round trip is byte-exact", back.format === "s16" && back.sampleRate === SR && back.channels === 2 && back.data.equals(s16.data));
  const f32 = toPCM([x], "f32");
  const backF = wavToPCM(pcmToWav(f32));
  ok("wav: float round trip is byte-exact", backF.format === "f32" && backF.channels === 1 && backF.data.equals(f32.data));
  const conv = wavToPCM(pcmToWav(f32, { format: "s16" }));
  ok("wav: float -> 16-bit conversion", conv.format === "s16" && Math.abs(decodePCM(conv).channels[0][200] - x[200]) < 2 / 32768);
  // a hand-built 24-bit file
  const n = 64, body = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) body.writeIntLE(Math.round(Math.sin(i / 4) * 4000000), i * 3, 3);
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + body.length, 4); hdr.write("WAVEfmt ", 8); hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(44100, 24); hdr.writeUInt32LE(44100 * 3, 28); hdr.writeUInt16LE(3, 32); hdr.writeUInt16LE(24, 34);
  hdr.write("data", 36); hdr.writeUInt32LE(body.length, 40);
  const p24 = decodePCM(wavToPCM(Buffer.concat([hdr, body])));
  ok("wav: 24-bit PCM decodes", p24.sampleRate === 44100 && Math.abs(p24.channels[0][10] - Math.sin(10 / 4) * 4000000 / 8388608) < 1e-6, p24.channels[0][10]);
  let threw = false;
  try { wavToPCM(Buffer.from("not a wav file at all")); } catch (e) { threw = /RIFF/.test(e.message); }
  ok("wav: garbage is rejected with a clear error", threw);
  // `audio` replies arrive in chunks: joined they equal the whole
  const half = x.length / 2;
  const whole = toPCM([x], "s16"), a = toPCM([x.subarray(0, half)], "s16"), b = toPCM([x.subarray(half)], "s16");
  ok("concatPCM: chunks join byte-exact", concatPCM([a, { ...b, data: b.data.toString("base64") }]).data.equals(whole.data));
  const mixed = decodePCM(concatPCM([a, toPCM([x.subarray(half)], "f32")]));
  ok("concatPCM: mixed encodings join as f32", mixed.channels[0].length === x.length && Math.abs(mixed.channels[0][half + 5] - x[half + 5]) < 1e-6);
  let changed = "";
  try { concatPCM([a, toPCM([x], "s16", 44100)]); } catch (e) { changed = e.message; }
  ok("concatPCM: a format change mid-run is an error", /changed mid-run/.test(changed), changed);
}

// ---- onset segmentation: three distinct sounds, no event times --------------------------------------------
{
  const x = buf(3.6);
  addTone(x, 0.5, 0.3, () => 440, fades(0.3, 0.4));                                                   // a beep
  addNoise(x, 1.5, 0.25, (t) => 0.5 * Math.min(1, t / 0.002) * Math.exp(-t / 0.06));                    // a hit
  addTone(x, 2.5, 0.4, (t) => 300 + 2000 * t, fades(0.4, 0.4));                                        // a rising zap
  const { report, text, segments } = analyzePCM(toPCM([x, x]), { title: "three sounds" });
  show("onset segmentation", report.sounds.map((s) => `${s.label}@${s.t.toFixed(3)}`).join("  "));
  ok("onsets: exactly 3 sounds", report.sounds.length === 3, report.sounds.map((s) => s.t));
  const want = [0.5, 1.5, 2.5];
  ok("onsets: times within 15 ms", report.sounds.length === 3 && report.sounds.every((s, i) => Math.abs(s.t - want[i]) <= 0.015), report.sounds.map((s) => s.t));
  ok("onsets: beep heard as steady A4", report.sounds[0]?.analysis.pitch.note === "A4", report.sounds[0]?.description);
  ok("onsets: hit heard as noise", report.sounds[1]?.analysis.tonality === "noisy", report.sounds[1]?.description);
  ok("onsets: zap heard rising", report.sounds[2]?.analysis.pitch.kind === "rise", report.sounds[2]?.description);
  ok("onsets: segments carry audio", segments.length === 3 && segments[0].channels[0].length > 0);
  ok("onsets: report text names the method", /onset detection/.test(text) && /No problems found|Problems/.test(text), text);
  ok("onsets: report is JSON-safe", JSON.stringify(JSON.parse(JSON.stringify(report))) === JSON.stringify(report));
}
{
  // a pitch change inside one sound is not a new sound (the coin)
  const x = buf(0.8);
  addTone(x, 0.1, 0.4, (t) => (t < 0.07 ? midiToHz(83) : midiToHz(88)), (t) => 0.4 * Math.min(1, t / 0.002, (0.4 - t) / 0.3));
  const on = detectOnsets(x, SR);
  ok("onsets: coin's note change is one sound", on.length === 1 && Math.abs(on[0].t - 0.1) < 0.01, on);
}
{
  // a swell out of silence (no sharp attack) is still found
  const x = buf(2);
  addTone(x, 0.6, 1, () => 330, (t) => 0.4 * Math.min(1, t / 0.4, (1 - t) / 0.1));
  const on = detectOnsets(x, SR);
  ok("onsets: slow swell found", on.length === 1 && Math.abs(on[0].t - 0.6) < 0.08, on);
}
{
  // repeats are grouped: four identical blips and one different sound
  const x = buf(3);
  for (const t of [0.3, 0.8, 1.3, 1.8]) addTone(x, t, 0.12, () => 880, (u) => 0.4 * Math.min(1, u / 0.002) * Math.exp(-u / 0.03));
  addNoise(x, 2.3, 0.3, (t) => 0.3 * Math.min(1, t / 0.002) * Math.exp(-t / 0.08));
  const { report, text } = analyzePCM(toPCM([x]), { title: "footsteps" });
  show("grouping", report.sounds.map((s) => `${s.label}×${s.count}`).join("  "));
  ok("grouping: 2 distinct sounds", report.sounds.length === 2, report.sounds.map((s) => s.description));
  ok("grouping: blip ×4", report.sounds[0]?.count === 4 && /×4/.test(text), report.sounds[0]);
}

// ---- music in a mix: tempo, key, chords, melody ------------------------------------------------------------
{
  const chords = chordTrack(["C", "Am", "F", "G", "C", "Am", "F", "G"]);
  const drums = kicks(120, chords.length / SR);
  const lead = buf(chords.length / SR);
  const mel = [76, 79, 81, 84, 77, 81, 79, 74, 72, 76, 76, 72, 81, 77, 83, 79];   // chord tones, one per second
  mel.forEach((m, i) => addTone(lead, i, 0.9, () => midiToHz(m), (t) => 0.22 * Math.min(1, t / 0.01, (0.9 - t) / 0.05), saw));
  const mixL = chords.map((v, i) => v + drums[i] * 0.6 + lead[i]);
  const { report, text } = analyzePCM(toPCM([mixL, mixL]), { title: "song" });
  const mu = report.music[0];
  show("music found", mu ? `${mu.t0}–${mu.t1} s · ${mu.tempo} bpm · ${mu.key} · ${mu.chords.map((c) => c.chord).join(" ")}` : "(none)");
  show("melody guess", mu?.melody?.text ?? "(none)");
  ok("music: one stretch found", report.music.length === 1, report.music.length);
  ok("music: tempo 120 ±2", mu && Math.abs(mu.tempo - 120) <= 2, mu?.tempo);
  ok("music: key C major", mu?.key === "C major", mu?.key);
  ok("music: chords C Am F G C Am F G", mu?.chords.map((c) => c.chord).join(" ") === "C Am F G C Am F G", mu?.chords.map((c) => c.chord).join(" "));
  ok("music: chord changes every 2 s", mu?.chords.every((c, i) => Math.abs(c.t - i * 2) <= 0.5), mu?.chords.map((c) => c.t));
  const heard = (mu?.melody?.notes || []).map((n) => n.note);
  const wanted = mel.map((m) => ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][m % 12] + (Math.floor(m / 12) - 1));
  const hits = wanted.filter((n, i) => heard.includes(n)).length;
  ok("music: melody guess finds most lead notes", hits >= 12, `${hits}/16: ${heard.join(" ")}`);
  ok("music: kicks over music are not 32 separate sounds", report.sounds.length <= 2, report.sounds.length);
  ok("music: report text has tempo, key, chords, melody", /tempo 1\d\d\.\d bpm/.test(text) && /key C major/.test(text) && /chords: C/.test(text) && /melody guess:/.test(text), text);
}
{
  // drums only: a beat, but no key or chords
  const { report } = analyzePCM(toPCM([kicks(90, 8)]), { title: "drums" });
  const mu = report.music[0];
  show("drums only", mu ? `${mu.tempo} bpm, pitched=${mu.pitched}` : "(no music)");
  ok("drums: beat found at 90 ±2", mu && Math.abs(mu.tempo - 90) <= 2, mu?.tempo);
  ok("drums: no pitched parts", mu && !mu.pitched && mu.key === null);
}
{
  // ambience is not music: 6 s of steady noise
  const x = addNoise(buf(6), 0, 6, () => 0.1);
  const { report } = analyzePCM(toPCM([x]), { title: "wind" });
  ok("noise bed: not music", report.music.length === 0, report.music);
}

// ---- events + masking over music -------------------------------------------------------------------------
{
  const music = chordTrack(["C", "Am", "F", "G"]).map((v) => v * 1.6);
  const quiet = addTone(buf(0.4), 0.02, 0.3, () => 1318, (t) => 0.02 * Math.min(1, t / 0.002) * Math.exp(-t / 0.08));
  const loud = addTone(buf(0.4), 0.02, 0.3, () => 2637, (t) => 0.5 * Math.min(1, t / 0.002) * Math.exp(-t / 0.15));
  const mixL = music.slice();
  for (let i = 0; i < quiet.length; i++) { mixL[Math.round(3 * SR) + i] += quiet[i]; mixL[Math.round(5 * SR) + i] += loud[i]; }
  const { report, text } = analyzePCM(toPCM([mixL, mixL]), { title: "masking", events: [{ t: 3, label: "coin" }, { t: 5, label: "jump" }] });
  const p = report.problems.find((x) => /under the music/.test(x.text));
  show("masking (analyzePCM)", p ? p.text : "(none)");
  ok("events: segmentation uses them", report.segmentation === "events" && report.sounds.map((s) => s.label).join(",") === "coin,jump");
  ok("events: quiet coin flagged as masked", !!p && /^coin at 3\.00 s is (at least )?\d+(\.\d)? dB under the music/.test(p.text), report.problems);
  ok("events: loud jump not flagged", !report.problems.some((x) => /^jump .*under the music/.test(x.text)), report.problems);
  ok("events: text shows vs music", /vs music: [+-]\d/.test(text), text);
  const late = analyzePCM(toPCM([mixL]), { events: [{ t: 3, label: "coin" }, { t: 99, label: "door" }] });
  ok("events: one past the end becomes a note", late.report.notes.some((n) => /1 event is at or after the end.*door/.test(n)), late.report.notes);
}

// ---- problems: clipping, NaN, one-sided mix, silence ---------------------------------------------------------
{
  const x = addTone(buf(1), 0.1, 0.6, () => 220, () => 1.6).map((v) => Math.max(-1, Math.min(1, v)));
  const { report, text } = analyzePCM(toPCM([x, x], "s16"), { title: "loud" });
  ok("clipping: first problem", /clips/.test(report.problems[0]?.text || ""), report.problems);
  ok("clipping: shown in the Mix line", /CLIPS \(\d+ samples\)/.test(text), text.split("\n")[1]);
}
{
  const x = addTone(buf(1), 0.1, 0.5, () => 440, fades(0.5));
  const pcm = toPCM([x, new Float32Array(x.length)]);
  pcm.data.writeFloatLE(NaN, 4000 * 8); pcm.data.writeFloatLE(Infinity, 4001 * 8);
  const { report } = analyzePCM(pcm, { title: "broken" });
  ok("NaN samples flagged", report.problems.some((p) => /2 samples were NaN or infinite/.test(p.text)), report.problems);
  ok("one-sided mix flagged", report.problems.some((p) => /leans left completely/.test(p.text)), report.problems);
}
{
  const { report, text } = analyzePCM(toPCM([buf(2), buf(2)]), { title: "mute", events: [{ t: 0.5, label: "click" }] });
  show("silent run", text.split("\n")[0]);
  ok("silent: empty report", report.empty === true && report.sounds.length === 0);
  ok("silent: logged events but no audio is a problem", report.problems.some((p) => /logged but the audio is silent/.test(p.text)), report.problems);
}

{
  // B5: three identical 80 ms bursts (j@1, j@1.5, j@3 in the arena). A segment used to end 5 ms before the next
  // detected onset, which trails the true start, so it swallowed the next attack: "2 distinct sounds", one 1.5 s long.
  const burst = new Float32Array(Math.round(0.08 * SR));
  for (let i = 0; i < burst.length; i++) burst[i] = rnd() * 0.3 * Math.min(1, i / (SR * 0.002)) * Math.exp(-i / (SR * 0.03));
  const x = buf(4);
  const starts = [1, 1.5, 3].map((t) => t + 1 / 60);   // the arena's sounds start a frame after the press
  for (const t of starts) x.set(burst, Math.round(t * SR));
  const { report } = analyzePCM(toPCM([x]), { title: "three swings" });
  show("B5 three identical bursts", report.sounds.map((q) => `${q.label} ×${q.count} ${Math.round(q.analysis.length * 1000)} ms`).join(" · "));
  ok("B5: three identical bursts are 1 sound ×3", report.sounds.length === 1 && report.sounds[0].count === 3, report.sounds.map((q) => [q.label, q.count, q.analysis.length]));
  ok("B5: each is 80 ms long (no swallowed attack)", report.sounds.length === 1 && Math.abs(report.sounds[0].analysis.length - 0.08) <= 0.006, report.sounds[0]?.analysis.length);
  const on = detectOnsets(x, SR);
  ok("onsets: refined to the attack within 0.2 ms (was 2-7 ms late)", on.length === 3 && on.every((o, i) => o.t >= Math.round(starts[i] * SR) / SR && o.t - Math.round(starts[i] * SR) / SR <= 0.0002), on.map((o) => o.t));
}
{
  // labelled events (the game's {"event": "sound"} lines): overlapping sounds keep their names and counts
  const x = buf(2.5);
  addTone(x, 0.5, 0.3, () => 440, fades(0.3, 0.3));
  addNoise(x, 0.54, 0.15, (t) => 0.4 * Math.min(1, t / 0.002) * Math.exp(-t / 0.04));
  addTone(x, 1.5, 0.3, () => 440, fades(0.3, 0.3));
  const { report } = analyzePCM(toPCM([x]), { events: [{ t: 0.5, label: "beep" }, { t: 0.54, label: "hit" }, { t: 1.5, label: "beep" }] });
  const by = Object.fromEntries(report.sounds.map((q) => [q.label, q]));
  ok("labelled: overlapping sounds keep their names and counts", report.segmentation === "events" && by.beep?.count === 2 && by.hit?.count === 1 && by.beep.times.join() === "0.5,1.5", report.sounds.map((q) => [q.label, q.times]));
}

// ---- a sound starting under a longer, louder one (a swing inside a 555 ms quest jingle) ---------------------
{
  // C-major chord (523/659/784 Hz, 0.2 each: its envelope beats every 4-8 ms), 5 ms attack, decaying to half, 10 ms fade
  const chord = (x, t0, dur) => { for (const f of [523.25, 659.25, 783.99]) addTone(x, t0, dur, () => f, (t) => 0.2 * Math.min(1, t / 0.005, (dur - t) / 0.01) * (1 - 0.5 * t / dur)); };
  const swing = (x, t0) => addNoise(x, t0, 0.08, (t) => 0.15 * Math.min(1, t / 0.001) * Math.exp(-t / 0.03));
  const x = buf(2);
  swing(x, 0.5); chord(x, 1.1, 0.555); swing(x, 1.2);
  const on = detectOnsets(x, SR);
  show("overlap onsets", on.map((o) => o.t.toFixed(4)).join(" "));
  ok("overlap: the swing inside the louder jingle is an onset (0.5, 1.1, 1.2 s, within 2 ms)", on.length === 3 && [0.5, 1.1, 1.2].every((t, i) => Math.abs(on[i].t - t) <= 0.002), on.map((o) => o.t));
  const alone = buf(2);
  chord(alone, 1.1, 0.555);
  ok("overlap: the jingle alone (a beating chord, decaying) is one onset", detectOnsets(alone, SR).length === 1, detectOnsets(alone, SR));
  const vib = buf(2);
  addTone(vib, 0.2, 1.2, (t) => 440 * (1 + 0.03 * Math.sin(2 * Math.PI * 6 * t)), (t) => 0.3 * Math.min(1, t / 0.005, (1.2 - t) / 0.01) * (1 + 0.3 * Math.sin(2 * Math.PI * 5 * t)));
  ok("overlap: vibrato + tremolo on one tone is one onset", detectOnsets(vib, SR).length === 1, detectOnsets(vib, SR));
  const { report } = analyzePCM(toPCM([x]), { events: [{ t: 0.5, label: "swing" }, { t: 1.1, label: "quest_start" }, { t: 1.2, label: "swing" }] });
  const by = Object.fromEntries(report.sounds.map((q) => [q.label, q]));
  show("overlap analysis", report.sounds.map((q) => `${q.label} ×${q.count} ${Math.round(q.analysis.length * 1000)} ms`).join(" · "));
  ok("overlap: quest_start is 555 ms long (not cut at the swing inside it)", by.quest_start && Math.abs(by.quest_start.analysis.length - 0.555) <= 0.01, by.quest_start?.analysis.length);
  ok("overlap: swing ×2 described from the clean one: 80 ms, noisy", by.swing && by.swing.count === 2 && Math.abs(by.swing.analysis.length - 0.08) <= 0.006 && by.swing.analysis.tonality === "noisy", [by.swing?.count, by.swing?.analysis.length, by.swing?.analysis.tonality]);
  ok("overlap: no double trigger read into the chord's beating or the overlap", !report.problems.some((q) => /second attack/.test(q.text)), report.problems.map((q) => q.text));

  // ---- the added-sound path must not invent sounds, time them early, or split one moving sound ----
  const seeded = (s) => { s = s >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; }; };
  const fmt = (os) => os.map((o) => o.t.toFixed(3)).join(" ");
  const bad = [];
  for (let sd = 1; sd <= 12; sd++) for (const lv of [0.05, 0.15, 0.4]) {   // rain: steady white noise 0.2-2.8 s
    const r = seeded(sd * 7919), z = buf(3);
    for (let i = Math.round(0.2 * SR); i < Math.round(2.8 * SR); i++) z[i] = lv * r();
    const os = detectOnsets(z, SR);
    if (os.length !== 1) bad.push(`noise ${lv} seed ${sd}: ${fmt(os)}`);
  }
  for (let sd = 1; sd <= 10; sd++) {   // wind: low-passed noise
    const r = seeded(sd * 104729), z = buf(3);
    let y = 0;
    for (let i = Math.round(0.2 * SR); i < Math.round(2.8 * SR); i++) { y = 0.98 * y + 0.02 * r(); z[i] = y * 0.9; }
    const os = detectOnsets(z, SR);
    if (os.length !== 1) bad.push(`wind seed ${sd}: ${fmt(os)}`);
  }
  ok("overlap: steady noise (36 runs) and wind (10 runs) are one onset each", !bad.length, bad.slice(0, 6));
  const errs = [];
  for (let s = 0; s < 10; s++) {   // a swing (peak 0.3) on a 0.15 noise bed: timed within -3..+5 ms
    const r = seeded(1000 + s), z = buf(2), t0 = 0.9 + s * 0.013;
    for (let i = Math.round(0.2 * SR); i < Math.round(1.6 * SR); i++) z[i] = 0.15 * r();
    for (let i = 0; i < 0.08 * SR; i++) { const u = i / SR; z[Math.round(t0 * SR) + i] += 0.3 * Math.min(1, u / 0.001) * Math.exp(-u / 0.03) * r(); }
    const os = detectOnsets(z, SR).filter((o) => Math.abs(o.t - t0) < 0.08);
    errs.push(os.length === 1 ? Math.round((os[0].t - t0) * 1000) : `${os.length} found`);
  }
  show("swing on a noise bed: error (ms)", errs.join(" "));
  ok("overlap: a swing on a noise bed is found once, never more than 3 ms early or 5 ms late", errs.every((e) => typeof e === "number" && e >= -3 && e <= 5), errs);
  const steps = buf(1.2);
  addTone(steps, 0.3, 0.4, (t) => [262, 523, 1047, 2093][Math.min(3, Math.floor(t / 0.1))], (t) => 0.4 * Math.min(1, t / 0.005, (0.4 - t) / 0.005));
  ok("overlap: one tone stepping up by octaves (a one-voice jingle) is one onset", detectOnsets(steps, SR).length === 1, fmt(detectOnsets(steps, SR)));
  const sweep = buf(1);
  addTone(sweep, 0.3, 0.2, (t) => 200 * Math.pow(40, t / 0.2), (t) => 0.4 * Math.min(1, t / 0.005, (0.2 - t) / 0.005));
  ok("overlap: a fast up-sweep (200 Hz → 8 kHz in 0.2 s) is one onset", detectOnsets(sweep, SR).length === 1, fmt(detectOnsets(sweep, SR)));
  // a second sound 40-50 ms into a louder one (and a chord 30 ms after a swing) is its own onset
  const near = [];
  for (const off of [0.04, 0.05]) {
    const z = buf(2);
    chord(z, 1.1, 0.555); swing(z, 1.1 + off);
    const os = detectOnsets(z, SR);
    if (!(os.length === 2 && Math.abs(os[1].t - 1.1 - off) <= 0.003)) near.push(`swing +${off * 1000} ms: ${fmt(os)}`);
  }
  {
    const z = buf(2);
    swing(z, 1.0); chord(z, 1.03, 0.555);
    const os = detectOnsets(z, SR);
    if (!(os.length === 2 && Math.abs(os[1].t - 1.03) <= 0.003)) near.push(`chord 30 ms after a swing: ${fmt(os)}`);
  }
  ok("overlap: a different sound 40-50 ms after another is its own onset", !near.length, near);
  // a swing that only plays under the chord: its length is its own (80 ms), and no pitch/tonality from the chord
  const under = buf(2);
  chord(under, 1.1, 0.555); swing(under, 1.18);
  const ur = analyzePCM(toPCM([under]), { events: [{ t: 1.1, label: "quest_start" }, { t: 1.18, label: "swing" }] }).report;
  const us = ur.sounds.find((q) => q.label === "swing");
  show("swing only under the chord", us?.description);
  ok("overlap: an always-overlapped swing is measured on its own bands: ~80 ms (60-100), no tonality or pitch from the chord", us && us.analysis.length >= 0.06 && us.analysis.length <= 0.1 && !/tonal \(|% pitched|C5/.test(us.description), us?.description);
  const late = buf(2);
  chord(late, 1.1, 0.555); swing(late, 1.5);
  const lr = analyzePCM(toPCM([late]), { events: [{ t: 1.1, label: "quest_start" }, { t: 1.5, label: "swing" }] }).report;
  ok("overlap: a swing late in the chord is not 'double-triggered'", !lr.problems.some((q) => /second attack/.test(q.text)), lr.problems.map((q) => q.text));
  const ls = lr.sounds.find((q) => q.label === "swing");
  ok("overlap: …and isn't described as 'unpitched' and 'tonal' at once", ls && !(/unpitched/.test(ls.description) && /tonal \(/.test(ls.description)), ls?.description);

  // the mock game's MOCK_SOUNDS=overlap at its 22.05 kHz: the swing pressed every frame from f66 to f100 inside
  // quest_start (f66, 555 ms): each is heard at +1f from its own onset, except f66 (starts with it: shared) and f67
  // (17 ms after it: too close for an onset of its own, and said so)
  const { alignSoundEvents, matchSounds } = await import("../../src/core/soundmatch.js");
  const MS = 22050, qs = Float32Array.from({ length: Math.round(MS * 0.555) }, (_, i) => [523.25, 659.25, 783.99].reduce((a, f) => a + Math.sin(2 * Math.PI * f * i / MS), 0) * 0.2 * Math.min(1, i / (MS * 0.005), (MS * 0.555 - i) / (MS * 0.01)) * (1 - 0.5 * i / (MS * 0.555)));
  const sweepBad = [];
  for (let F = 66; F <= 100; F++) {
    let seed = 7;
    const z = new Float32Array(MS * 2), put = (smp, f) => { const st = Math.round((f / 60) * MS); for (let i = 0; i < smp.length && st + i < z.length; i++) z[st + i] += smp[i]; };
    put(qs, 66);
    put(Float32Array.from({ length: Math.round(MS * 0.08) }, (_, i) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return ((seed / 0x7fffffff) * 2 - 1) * 0.15 * Math.min(1, i / (MS * 0.001)) * Math.exp(-i / (MS * 0.03)); }), F);
    const al = alignSoundEvents([{ name: "quest_start", frame: 66 }, { name: "swing", frame: F }], detectOnsets(z, MS), 60);
    const sw = al.sounds[1], m = matchSounds([{ label: "j pressed", f: F, kind: "input" }], al.sounds).matches[0];
    const good = F === 66 ? sw.heard && sw.together?.[0] === "quest_start" : F === 67 ? !sw.heard && sw.near?.label === "quest_start" : sw.heard && m.sound === sw && m.offset === 1;
    if (!good) sweepBad.push(`f${F}: ${sw.heard ? `heard f${sw.f}` : "unheard"} → ${m.sound ? `${m.sound.label} +${m.offset}f` : "none"}`);
  }
  ok("overlap: swing pressed every frame f66-f100 inside quest_start: f68+ each ✔ +1f, f66 shared, f67 too close", !sweepBad.length, sweepBad);
}

// ---- onset times at 22.05 / 44.1 kHz stay right late in a long capture (1 ms envelope windows are 22 or 23 samples)
{
  const late = [];
  for (const sr of [22050, 44100]) {
    const z = new Float32Array(sr * 32);
    let sd = 3;
    for (const t0 of [5, 15, 30]) for (let i = 0; i < 0.08 * sr; i++) { sd = (sd * 1103515245 + 12345) & 0x7fffffff; z[Math.round(t0 * sr) + i] = ((sd / 0x7fffffff) * 2 - 1) * 0.3 * Math.min(1, i / (sr * 0.001)) * Math.exp(-i / (sr * 0.03)); }
    const os = detectOnsets(z, sr);
    if (!(os.length === 3 && [5, 15, 30].every((t, k) => Math.abs(os[k].t - t) <= 0.001))) late.push(`${sr}: ${os.map((o) => o.t.toFixed(4)).join(" ")}`);
  }
  ok("onsets at 5, 15 and 30 s at 22.05 and 44.1 kHz: each within 1 ms (whole-sample windows drifted 34 ms by 15 s)", !late.length, late);
}

// ---- hygiene: clicks at sound edges, pops, true peak, double triggers, repetition, loop seams ----------------
{
  const { edges, pops, truePeak, secondAttack, loopSeam } = await import("../../src/media/hygiene.js");
  // a 440 Hz tone cut at 0.1 s + a quarter period (amplitude 0.4 there) vs the same tone with a 5 ms fade-out
  const cut = buf(0.5), faded = buf(0.5);
  addTone(cut, 0.1, 0.1 + 1 / 1760, () => 440, () => 0.4);   // 0.1 s + a quarter period: it stops at the crest
  addTone(faded, 0.1, 0.1, () => 440, (t) => 0.4 * Math.min(1, t / 0.002, (0.1 - t) / 0.005));
  const ec = edges(cut, SR), ef = edges(faded, SR);
  show("edges: cut vs faded tone", `cut ends at ${ec[0].lastAmp.toFixed(3)} (clicks ${ec[0].clicksOut}) · faded ends at ${ef[0].lastAmp.toFixed(4)} (clicks ${ef[0].clicksOut})`);
  ok("hygiene: a tone cut mid-cycle clicks at its end", ec.length === 1 && ec[0].clicksOut && Math.abs(ec[0].lastAmp - 0.4) < 0.01, ec);
  ok("hygiene: the same tone with a 5 ms fade doesn't", ef.length === 1 && !ef[0].clicksOut && !ef[0].clicksIn, ef);
  const { report } = analyzePCM(toPCM([cut]));
  ok("hygiene: the report says where it was cut and suggests a fade", report.problems.some((q) => /ends abruptly at 0\.20\d s \(cut at amplitude 0\.4/.test(q.text) && /fade-out/.test(q.text)), report.problems.map((q) => q.text));
  // a pop: a 0.3 jump inside a quiet sustained tone
  const pp = buf(0.5);
  addTone(pp, 0, 0.5, () => 220, () => 0.2);
  for (let i = Math.round(0.25 * SR); i < Math.round(0.25 * SR) + 40; i++) pp[i] += 0.3;   // (0.25 s is a zero crossing)
  const pq = pops(pp, SR);
  ok("hygiene: a jump inside a smooth tone is a pop, at its time", pq.length >= 1 && Math.abs(pq[0].t - 0.25) < 0.001, pq);
  ok("hygiene: a tone starting at zero phase doesn't click", !report.problems.some((q) => /starts abruptly/.test(q.text)), report.problems.map((q) => q.text));
  ok("hygiene: a clean tone has no pops", pops(faded, SR).length === 0);
  // true peak: fs/4 at 45° — every sample is ±0.7071 (-3 dBFS) while the waveform reaches 1.0 (0 dBTP)
  const tq = new Float32Array(4800);
  for (let i = 0; i < tq.length; i++) tq[i] = Math.sin((Math.PI / 2) * i + Math.PI / 4);
  const t = truePeak([tq]);
  show("true peak of fs/4 at 45°", `sample ${t.sample.toFixed(2)} dBFS · true ${t.true.toFixed(2)} dBTP`);
  ok("hygiene: true peak sees the inter-sample over (sample -3.01 dBFS, true ≈ 0 dBTP)", Math.abs(t.sample + 3.01) < 0.01 && Math.abs(t.true) < 0.2, t);
  const tr = analyzePCM(toPCM([tq.map((v) => v * 0.99)]));
  ok("hygiene: the report flags it", tr.report.problems.some((q) => /true peak/.test(q.text)), tr.report.problems.map((q) => q.text));
  // a burst restarted one frame (16.7 ms) later: a second attack
  const burst = new Float32Array(Math.round(0.08 * SR));
  for (let i = 0; i < burst.length; i++) burst[i] = rnd() * 0.3 * Math.min(1, i / (SR * 0.002)) * Math.exp(-i / (SR * 0.03));
  const dbl = buf(1);
  for (const st of [0.3, 0.3 + 1 / 60]) for (let i = 0; i < burst.length; i++) dbl[Math.round(st * SR) + i] += burst[i];
  const dr = analyzePCM(toPCM([dbl]));
  ok("hygiene: a sound played twice a frame apart is reported", dr.report.problems.some((q) => /second attack 1[68] ms after the first/.test(q.text) && /a frame apart/.test(q.text)), dr.report.problems.map((q) => q.text));
  const single = buf(1);
  for (let i = 0; i < burst.length; i++) single[Math.round(0.3 * SR) + i] += burst[i];
  ok("hygiene: played once it isn't", !analyzePCM(toPCM([single])).report.problems.some((q) => /second attack/.test(q.text)));
  // the same blip 6 times, identical
  const rep6 = buf(3.5);
  for (let k = 0; k < 6; k++) addTone(rep6, 0.2 + k * 0.5, 0.1, () => 660, (u) => 0.3 * Math.min(1, u / 0.002, (0.1 - u) / 0.01));
  ok("hygiene: 6 identical plays suggest variation", analyzePCM(toPCM([rep6])).report.problems.some((q) => /plays 6 times with the same waveform/.test(q.text)));
  // loop seams: a whole number of cycles loops cleanly; a 0.3 step at the joint clicks
  const loop = buf(1);
  addTone(loop, 0, 1, () => 100, () => 0.3);
  const clean = loopSeam(loop, SR, 0, 0.5), bad = loopSeam(loop, SR, 0, 0.5025);
  show("loop seams", `clean: joint ${clean.joint} step ${clean.levelStep} dB ok ${clean.ok} · off by a quarter cycle: joint ${bad.joint} click ${bad.click}`);
  ok("loop seam: 50 whole cycles join cleanly", clean.ok && clean.joint < 0.01, clean);
  ok("loop seam: a quarter cycle off leaves a 0.3 jump at the joint (a click)", bad.click && Math.abs(bad.joint - 0.3) < 0.01 && !bad.ok, bad);
  void secondAttack;
}

// ---- comparing captures (doctor / test --repeat / match): tolerance, render-quantum padding, sample rates
{
  const { comparePCM, describePCMDiff } = await import("../../src/media/audio-compare.js");
  const { Matcher } = await import("../../src/core/compare.js");
  const cap = (a, rate = 24000) => ({ sampleRate: rate, channels: 1, format: "f32", data: Buffer.from(new Float32Array(a).buffer).toString("base64") });
  const base = Array.from({ length: 4800 }, (_, i) => 0.5 * Math.sin(i / 7));
  const noisy = base.map((v, i) => (i > 2400 && i % 3 === 0 ? v + 4.21e-7 : v));
  let d = comparePCM(cap(base), cap(noisy));
  ok("audio compare: 4.21e-7 float noise is within the default 1e-5 tolerance, counted apart", d.same && d.count === 0 && d.noise > 700 && /audio: \d+ samples differed by at most 4\.\d+e-7 \(within the ±1\.0e-5 tolerance/.test(describePCMDiff(d)), describePCMDiff(d));
  d = comparePCM(cap(base), cap(noisy), { tol: 0 });
  ok("audio compare: tol 0 is exact: the same noise fails, from where it starts", !d.same && d.first === 2403 && /audio differs from 0\.1001 s into the capture: \d+ samples off by more than ±0, max sample difference 4\.\d+e-7/.test(describePCMDiff(d)), describePCMDiff(d));
  const loud = base.slice(); loud[3000] += 0.7;
  d = comparePCM(cap(base), cap(loud));
  ok("audio compare: a dropped / extra sound still fails, with where and how much", !d.same && d.count === 1 && /from 0\.1250 s .*1 sample off by more than ±1\.0e-5, max sample difference 0\.700/.test(describePCMDiff(d)), describePCMDiff(d));
  d = comparePCM(cap(base), cap(base.concat(new Array(128).fill(0))));
  ok("audio compare: one silent render quantum longer is padding, not a difference", d.same && d.tail.frames === 128 && /extra 128 are silent render-quantum padding/.test(describePCMDiff(d)), describePCMDiff(d));
  d = comparePCM(cap(base), cap(base.concat(new Array(129).fill(0))));
  ok("audio compare: more than a quantum longer is a difference (lengths named)", !d.same && /\(lengths 4800 vs 4929 frames\)/.test(describePCMDiff(d)), describePCMDiff(d));
  d = comparePCM(cap(base), cap(base.concat([0.2])));
  ok("audio compare: a tail that sounds is a difference", !d.same && /peak at 0\.200/.test(describePCMDiff(d)), describePCMDiff(d));
  d = comparePCM(cap(new Array(4410).fill(0), 22050), cap(new Array(4800).fill(0), 24000));
  ok("audio compare: two silent captures at 22050 vs 24000 Hz are the same (said so)", d.same && /both captures silent, at 22050 vs 24000 Hz \(lengths 4410 vs 4800 frames\)/.test(describePCMDiff(d)), describePCMDiff(d));
  d = comparePCM(cap(base.slice(0, 4410), 22050), cap(base, 24000));
  ok("audio compare: sound at different rates is a difference naming the rates", !d.same && /sample rates 22050 vs 24000 Hz/.test(describePCMDiff(d)), describePCMDiff(d));
  const m = new Matcher();
  await m.check("x", { snap: { state: {} }, audio: cap(base) });
  let r = await m.check("x", { snap: { state: {} }, audio: cap(noisy) });
  ok("Matcher: audio within the default tolerance passes with a note", r.ok && r.notes.length === 1 && /^audio: \d+ samples differed/.test(r.notes[0]), JSON.stringify(r));
  const m0 = new Matcher({ audioTol: 0 });
  await m0.check("x", { snap: { state: {} }, audio: cap(base) });
  r = await m0.check("x", { snap: { state: {} }, audio: cap(noisy) });
  ok("Matcher audioTol 0: exact", !r.ok && /^audio differs from 0\.1001 s/.test(r.problems[0]), JSON.stringify(r));
  const { audioTolOf } = await import("../../src/core/compare.js");
  ok("audioTolOf: --audio-tol over witness.json audioTol over 1e-5; nonsense refused", audioTolOf({ "audio-tol": "0" }, { audioTol: 1e-3 }) === 0 && audioTolOf({}, { audioTol: 1e-3 }) === 1e-3 && audioTolOf({}, {}) === 1e-5
    && (() => { try { audioTolOf({ "audio-tol": "x" }); return false; } catch (e) { return /--audio-tol/.test(e.message); } })());
}

done("audio");
