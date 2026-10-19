// Spectrogram picture tests: `node tests/media/spectrogram.mjs` (writes out/timeline.png, out/sounds.png)
// A synthetic game run: sound effects, then music with a beat, an explosion over the music,
// and a coin after it — the pictures must place each one where it happened.
import { analyzePCM, midiToHz } from "../../src/media/audio-analysis.js";
import { timelinePNG, soundSheetPNG, peakEnvelope, levelLane } from "../../src/media/spectrogram.js";
import { decodePNG } from "../../src/media/png.js";
import { ok, show, save, done } from "./harness.mjs";
import { SR, buf, addTone, addNoise, saw, chordTrack, kicks, toPCM, fades } from "./signals.mjs";

console.log("spectrogram");

const x = buf(14);
{
  const chords = chordTrack(["C", "Am", "F", "G"]), drums = kicks(120, 8.2), lead = buf(8.2);
  [76, 79, 81, 84, 77, 81, 79, 74].forEach((m, i) => addTone(lead, i, 0.9, () => midiToHz(m), (t) => 0.2 * Math.min(1, t / 0.01, (0.9 - t) / 0.05), saw));
  for (let i = 0; i < chords.length; i++) x[i + Math.round(4 * SR)] = (chords[i] + drums[i] * 0.5 + lead[i]) * 0.6;
  const coin = (t0) => addTone(x, t0, 0.4, (t) => midiToHz(t < 0.07 ? 83 : 88), (t) => 0.35 * Math.min(1, t / 0.002, (0.4 - t) / 0.3));
  coin(0.4); coin(3.3);
  addTone(x, 1.2, 0.35, (t) => 250 + 2400 * t, fades(0.35, 0.3));
  addNoise(x, 2.2, 0.9, (t) => 0.5 * Math.min(1, t / 0.003) * Math.exp(-t / 0.25));
  addNoise(x, 7.0, 0.8, (t) => 0.6 * Math.min(1, t / 0.003) * Math.exp(-t / 0.2));
  addTone(x, 12.6, 0.3, () => 1760, (t) => 0.3 * Math.min(1, t / 0.002) * Math.exp(-t / 0.08));
}
const pcm = toPCM([x, x]);
const res = analyzePCM(pcm, { title: "Embervale" });
show("sounds", res.report.sounds.map((s) => `${s.label}${s.count > 1 ? "×" + s.count : ""}@${s.t.toFixed(2)}`).join("  "));
show("music", res.report.music.map((m) => `${m.t0}–${m.t1} s ${m.chords.map((c) => c.chord).join(" ")}`).join(""));
ok("run: 5 distinct sounds, the coin twice", res.report.sounds.length === 5 && res.report.sounds[0].count === 2, res.report.sounds.map((s) => [s.t, s.count]));
ok("run: music starts at 4 s and is C Am F G", res.report.music.length === 1 && Math.abs(res.report.music[0].t0 - 4) < 0.05 && res.report.music[0].chords.map((c) => c.chord).join(" ") === "C Am F G", res.report.music);
ok("run: explosion over music found at 7.0 s", res.report.sounds.some((s) => Math.abs(s.t - 7) <= 0.01 && s.overMusic), res.report.sounds.map((s) => s.t));

{
  const png = timelinePNG(pcm, { analysis: res, markers: [{ t: 7.0, label: "F8 boom" }] });
  save("timeline.png", png);
  const img = decodePNG(png);
  ok("timeline: 1280 wide", img.width === 1280 && img.height > 700, [img.width, img.height]);
  // the spectrogram is bright where the explosion is and dark in the silence after the music
  const at = (t, f) => {
    const L = 104, PW = 1280 - 104 - 100, x0 = Math.round(L + (t / 14) * PW);
    const boxY = 84 + 112 + 16, h = 420, y = Math.round(boxY + h - (Math.log(f / 55) / Math.log(16000 / 55)) * h);
    const o = (y * img.width + x0) * 4;
    return img.data[o] + img.data[o + 1] + img.data[o + 2];
  };
  ok("timeline: explosion is bright at 4 kHz", at(7.2, 4000) > 300, at(7.2, 4000));
  ok("timeline: silence is dark at 4 kHz", at(13.5, 4000) < 60, at(13.5, 4000));
  const alone = decodePNG(timelinePNG(pcm, { title: "standalone", events: [{ t: 0.4, label: "coin" }, { t: 3.3, label: "coin" }] }));
  ok("timeline: works without a precomputed analysis", alone.width === 1280);
}
{
  const png = soundSheetPNG(res.segments, { title: "Embervale" });
  save("sounds.png", png);
  const img = decodePNG(png);
  ok("sheet: 2 rows of cards", img.width === 1280 && img.height > 560 && img.height < 760, img.height);
  ok("sheet: empty list still renders", decodePNG(soundSheetPNG([], { title: "quiet" })).width === 1280);
}
{
  const silent = analyzePCM(toPCM([buf(1)]), { title: "mute" });
  ok("silent run: timeline renders", decodePNG(timelinePNG(null, { analysis: silent })).width === 1280);
  const short = analyzePCM(toPCM([addTone(buf(0.06), 0, 0.05, () => 440, fades(0.05))]), { title: "blip" });
  ok("50 ms run: timeline renders", decodePNG(timelinePNG(null, { analysis: short })).width === 1280);
  const lowSr = toPCM([addTone(new Float32Array(22050), 0.1, 0.5, () => 440, fades(0.5))], "s16", 22050);
  ok("22.05 kHz audio renders", decodePNG(timelinePNG(lowSr, { title: "low rate" })).width === 1280);
}

// ---- the SFX level lane: a 10 ms peak envelope when there's no music
{
  // silence, then a 0.5-amplitude 1 kHz tone from 1.00 s to 1.10 s (exactly 10 windows of 10 ms), then silence
  const sx = buf(3);
  for (let i = Math.round(1.0 * SR); i < Math.round(1.1 * SR); i++) sx[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * (i / SR));
  const env = peakEnvelope([sx], SR, 0.01);
  const w = (t) => Math.round(t / env.win);
  show("envelope at 0.5 / 1.05 / 1.5 s", [env.db[w(0.5)], env.db[w(1.05)].toFixed(2), env.db[w(1.5)]].join(" / "));
  ok("peakEnvelope: 10 ms windows", Math.abs(env.win - 0.01) < 1e-9 && env.times.length === 300, env.times.length);
  ok("peakEnvelope: amplitude 0.5 = -6.02 dBFS inside the sound", Math.abs(env.db[w(1.05)] + 6.0206) < 0.01, env.db[w(1.05)]);
  ok("peakEnvelope: silence is -Infinity around it", env.db[w(0.5)] === -Infinity && env.db[w(1.5)] === -Infinity);
  const loud = env.db.map((d, i) => (d > -60 ? i : -1)).filter((i) => i >= 0);
  ok("peakEnvelope: exactly the 10 windows of the sound are loud", loud.length === 10 && loud[0] === 100 && loud[9] === 109, loud);
  const sfx = analyzePCM(toPCM([sx]), { title: "sfx only" });
  const lane = levelLane(sfx);
  ok("levelLane: sound effects only → 10 ms envelope", lane.kind === "envelope" && lane.label === "dBFS");
  ok("levelLane: with music → the loudness curve", levelLane(res).kind === "loudness");
  const img = decodePNG(timelinePNG(null, { analysis: sfx }));
  save("timeline-sfx.png", timelinePNG(null, { analysis: sfx }));
  // lane geometry: x = 104 + t / duration × 1076, the lane spans y 84..196 for 0..-60 dB; -6 dB tops out near y 95
  const px = (t, y) => { const x = Math.round(104 + (t / 3) * 1076), o = (y * img.width + x) * 4; return [img.data[o], img.data[o + 1], img.data[o + 2]]; };
  const orange = (c) => c[0] > 120 && c[0] > c[2] + 40;
  ok("timeline: the envelope fills the lane where the sound plays", orange(px(1.05, 150)) && orange(px(1.05, 100)), [px(1.05, 150), px(1.05, 100)]);
  ok("timeline: the envelope tops out at -6 dB (nothing above y 94)", !orange(px(1.05, 92)), px(1.05, 92));
  ok("timeline: no envelope in silence", !orange(px(0.5, 150)) && !orange(px(1.5, 150)), [px(0.5, 150), px(1.5, 150)]);
}

done("spectrogram");
