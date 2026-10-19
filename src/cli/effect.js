// Witness CLI: effect — what an input causes, and how many frames later (state, pixels, audio).
// The same seed runs twice in one process: with the input and without it (the "twin"). Runs are deterministic,
// so the first frame where they differ is caused by the input and nothing else.
import fs from "node:fs";
import path from "node:path";
import { begin, stepTo } from "../core/runner.js";
import { diffStates, pathFilter } from "../core/compare.js";
import { fmt } from "../core/expr.js";
import { parseWitnessInput } from "../core/input-spec.js";
import { WitnessError } from "../core/session.js";
import { frameAt } from "../core/runner.js";
import { die, withGame, runOpts, media, printLogs, splitTop, fmtT, shotImage, envelope, emit } from "./common.js";

const fail = (msg) => { throw new WitnessError(msg); };

const MAX_PIXEL_FRAMES = 120;
const msOf = (f, fps) => Math.round((f * 1000) / fps);
const feel = (f, fps) => { const m = msOf(f, fps); return m <= 50 ? "feels instant" : m <= 100 ? "noticeable" : "feels laggy"; };

/** First index where two Float32 channels differ by more than eps. */
function firstAudioDiff(a, b, eps = 1e-6) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (Math.abs((a[i] || 0) - (b[i] || 0)) > eps) return i;
  return -1;
}

export async function effectCommand(pos, opt) {
  if (!opt.input || opt.input === true) die('usage: witness effect --input "space@1" [--base "right@0-3"] [--time 0.5] [--paths "player"] [--shot]');
  let res;
  await withGame(opt, async (s, cfg, root) => {
    res = await computeEffect(s, opt, runOpts(opt, cfg), path.join(root, cfg.shots));
  });
  if (res.logs.some((l) => l.level === "error")) printLogs(res.logs.filter((l) => l.level === "error"));
  const out = report(res, opt);
  emit(out.env, out.text, opt);
}

/** The effect of opt.input on an open session (twin runs from reset with ro's seed/scene/params). Returns the raw result. */
export async function computeEffect(s, opt, ro, shotDir) {
  const F = (t) => { try { return frameAt(t, s.fps); } catch (e) { return fail(e.message); } };
  if (!opt.input || opt.input === true) fail("effect needs --input (the cause)");
  const fps = s.fps;
  const cause = String(opt.input), base = opt.base && opt.base !== true ? String(opt.base) : "";
  let causeEvents;
  try { causeEvents = parseWitnessInput(cause, fps); parseWitnessInput(base, fps); } catch (e) { fail(e.message); }
  if (!causeEvents.length) fail("--input has no events");
  if (!s.has("reset")) fail("effect needs the adapter's 'reset' (it runs the same seed twice in one process)");
  const fIn = Math.min(...causeEvents.map((e) => e.frame));
  const W = Math.max(1, F(opt.time && opt.time !== true ? String(opt.time) : "0.5", fps));
  const fEnd = fIn + W;
  const usePixels = !opt["no-pixels"] && s.has("screenshot");
  const useAudio = !opt["no-audio"] && s.has("audio") && s.hello?.audio_exact !== false;
  const pixelEnd = fIn + Math.min(W, MAX_PIXEL_FRAMES);
  // --paths "player, camera.pos": only state paths at or under these count
  const keep = opt.paths && opt.paths !== true ? pathFilter(splitTop(String(opt.paths))) : null;
  const skip = keep ? (p) => !keep(p) : null;
  const m = usePixels || useAudio ? await media() : null;
  const firstLabel = causeEvents[0].type === "key" ? causeEvents[0].key : causeEvents[0].type === "action" ? `action ${causeEvents[0].action}` : causeEvents[0].type;

  // one run: snapshots f_in..f_end, screenshots f_in..pixelEnd, audio since reset
  const run = async (input) => {
    const st = await begin(s, { ...ro, input: input || undefined });
    if (useAudio) await s.audio();
    const snaps = new Map(), shots = new Map();
    for (let f = fIn; f <= fEnd; f++) {
      await stepTo(s, st, f);
      snaps.set(f, await s.snapshot());
      if (usePixels && f <= pixelEnd) { const im = await shotImage(await s.screenshot()); shots.set(f, { width: im.width, height: im.height, data: Uint8Array.from(im.data) }); }
    }
    let audio = null;
    if (useAudio) { const a = await s.audio(); if (a && a.data) audio = m.decodePCM(a); }
    return { snaps, shots, audio };
  };
  const twin = await run(base);
  const withIn = await run([base, cause].filter(Boolean).join(", "));
  const logs = await s.drainLogs();

  // state
  const stateDiffAt = (f) => diffStates(twin.snaps.get(f)?.state ?? null, withIn.snaps.get(f)?.state ?? null).filter((d) => !skip || !skip(d.path));
  const pre = stateDiffAt(fIn);
  let stateF = null, stateChanges = [];
  for (let f = fIn + 1; f <= fEnd; f++) { const d = stateDiffAt(f); if (d.length) { stateF = f; stateChanges = d; break; } }
  const endState = stateDiffAt(fEnd);
  // pixels
  let pixF = null, pixDiff = null, prePix = false, endPix = null;
  if (usePixels) {
    const same = (a, b) => a.width === b.width && a.height === b.height && Buffer.compare(Buffer.from(a.data.buffer, a.data.byteOffset, a.data.length), Buffer.from(b.data.buffer, b.data.byteOffset, b.data.length)) === 0;
    prePix = !same(twin.shots.get(fIn), withIn.shots.get(fIn));
    for (let f = fIn + 1; f <= pixelEnd; f++) if (!same(twin.shots.get(f), withIn.shots.get(f))) { pixF = f; break; }
    if (pixF != null) pixDiff = m.diffImages(twin.shots.get(pixF), withIn.shots.get(pixF), { threshold: 0 });
    endPix = m.diffImages(twin.shots.get(pixelEnd), withIn.shots.get(pixelEnd), { threshold: 0 });
  }
  // audio: the first sample that differs, and what the difference sounds like
  let audioF = null, audioT = null, audioDesc = null, extraSounds = 0, preAudio = false;
  if (useAudio && twin.audio && withIn.audio) {
    const sr = twin.audio.sampleRate, spf = sr / fps;
    const A = m.mono(withIn.audio.channels), B = m.mono(twin.audio.channels);
    const i = firstAudioDiff(A, B);
    if (i >= 0) {
      audioF = Math.floor(i / spf + 1e-9) + 1;
      audioT = i / sr;
      if (audioF <= fIn) preAudio = true;
      const n = Math.max(A.length, B.length), d = new Float32Array(n);
      for (let k = 0; k < n; k++) d[k] = (A[k] || 0) - (B[k] || 0);
      const seg = d.subarray(i, Math.min(n, i + Math.round(sr * 1.0)));
      try { const a = m.analyzeEvent([seg], sr); if (!a.silent) audioDesc = m.describeEvent(a); } catch { /* best effort */ }
      try { extraSounds = m.detectOnsets(d.subarray(Math.round(fIn * spf)), sr).length; } catch { extraSounds = 0; }
    }
  }
  // a filmstrip: with the input over the twin, around the first visible change
  let sheetFile = null;
  if (opt.shot && usePixels) {
    const start = Math.max(fIn, (pixF ?? fIn + 1) - 2), frames = [];
    for (let f = start; f <= Math.min(pixelEnd, start + 7); f++) frames.push(f);
    const cells = [...frames.map((f) => ({ img: withIn.shots.get(f), label: `with f${f} +${f - fIn}f` })), ...frames.map((f) => ({ img: twin.shots.get(f), label: `without f${f}`, color: "#8b93b8" }))];
    const sheet = m.contactSheet(cells, { cols: frames.length, title: `${s.hello.name}: ${cause} (top) vs the same run without it (bottom)`, subtitle: `frames f${frames[0]}..f${frames[frames.length - 1]}; the input is at f${fIn}` });
    sheetFile = path.resolve(opt.out && opt.out !== true ? String(opt.out) : path.join(shotDir, "effect.png"));
    fs.mkdirSync(path.dirname(sheetFile), { recursive: true });
    fs.writeFileSync(sheetFile, sheet.png);
  }
  return { fps, fIn, fEnd, W, pixelEnd, cause, base, firstLabel, usePixels, useAudio, pre, prePix, preAudio, stateF, stateChanges, endState, pixF, pixDiff, endPix, audioF, audioT, audioDesc, extraSounds, sheetFile, logs };
}

function report(r, opt) {
  const { fps, fIn, fEnd } = r;
  const after = (f) => `+${f - fIn}f, ${msOf(f - fIn, fps)} ms`;
  const pathName = (p) => p.replace(/^state\./, "");
  const short = (v) => (v === undefined ? "(none)" : fmt(v, 32));
  const chg = (d) => (d.kind === "added" ? `${pathName(d.path)} added` : d.kind === "removed" ? `${pathName(d.path)} removed` : `${pathName(d.path)} ${short(d.a)} → ${short(d.b)}`);
  // entity copies of top-level objects (state.player and entities[Player#1]) and the digest go last
  const late = (d) => /^state\.(entities\b|digest$)/.test(d.path);
  const ordered = (ds) => [...ds.filter((d) => !late(d)), ...ds.filter(late)];
  const lines = [];
  lines.push(`${r.firstLabel} at frame ${fIn} (t=${fmtT(fIn / fps)}), compared with the same run without it${r.base ? ` (both runs: ${r.base})` : ""}:`);
  if (r.pre.length || r.prePix || r.preAudio) lines.push(`  ⚠ the two runs already differ at f${fIn}, before the input acts (${[r.pre.length ? `${r.pre.length} state paths` : "", r.prePix ? "pixels" : "", r.preAudio ? "audio" : ""].filter(Boolean).join(", ")}): the game isn't deterministic, so the numbers below can't be trusted — run 'witness doctor'`);
  const st = ordered(r.stateChanges);
  lines.push(r.stateF != null
    ? `  state   first differs at f${r.stateF} (${after(r.stateF)}): ${st.slice(0, 4).map(chg).join(", ")}${st.length > 4 ? ` (+${st.length - 4} more)` : ""}`
    : `  state   no difference by f${fEnd}`);
  if (r.usePixels) {
    const b = r.pixDiff?.boxes || [];
    lines.push(r.pixF != null
      ? `  pixels  first differ at f${r.pixF} (${after(r.pixF)}): ${b.length} region${b.length === 1 ? "" : "s"} ${b.slice(0, 3).map((x) => `x=${x.x} y=${x.y} ${x.w}×${x.h} (${x.pixels} px)`).join(", ")}${b.length > 3 ? ", …" : ""}`
      : `  pixels  no difference by f${r.pixelEnd}`);
  } else lines.push(`  pixels  not compared (${opt["no-pixels"] ? "--no-pixels" : "no 'screenshot' capability"})`);
  if (r.useAudio) {
    lines.push(r.audioF != null
      ? `  audio   first differs at f${r.audioF} (+${r.audioF - fIn}f: it starts ${Math.round((r.audioT - fIn / fps) * 1000)} ms after the press, at ${fmtT(r.audioT)}): ${r.audioDesc || "a change too quiet to describe"}`
      : `  audio   no difference by f${fEnd}`);
  } else lines.push("  audio   not compared (no exact 'audio' capability, or --no-audio)");
  const endBits = [`${r.endState.length >= 500 ? "500+" : r.endState.length} state path${r.endState.length === 1 ? " differs" : "s differ"}${r.endState.length ? ` (${[...new Set(ordered(r.endState).map((d) => pathName(d.path).split(/[.[]/)[0]))].slice(0, 5).join(", ")})` : ""}`];
  if (r.usePixels && r.endPix) endBits.push(`${r.endPix.changedPercent}% of pixels`);
  if (r.useAudio) endBits.push(`${r.extraSounds} new sound onset${r.extraSounds === 1 ? "" : "s"}`);
  lines.push(`  by f${fEnd} (+${fEnd - fIn}f): ${endBits.join(", ")}`);
  const none = r.stateF == null && r.pixF == null && r.audioF == null;
  let verdict;
  if (none) verdict = `no effect within ${fmtT(r.W / fps)} (${r.W} frames): state${r.usePixels ? ", pixels" : ""}${r.useAudio ? " and audio" : ""} are identical to the run without it`;
  else {
    const parts = [];
    if (r.pixF != null) parts.push(`picture in ${r.pixF - fIn}f (${msOf(r.pixF - fIn, fps)} ms: ${feel(r.pixF - fIn, fps)})`);
    else if (r.usePixels && r.stateF != null) parts.push(`the state changes but nothing on screen changes by f${r.pixelEnd}`);
    if (r.stateF != null) parts.push(`state in ${r.stateF - fIn}f`);
    const firstSeen = Math.min(r.stateF ?? Infinity, r.pixF ?? Infinity);
    if (r.audioF != null) parts.push(r.audioF - firstSeen > 6 ? `the first sound change comes ${r.audioF - fIn}f after the input (${r.audioF - firstSeen}f after the visible response: a later consequence, like a pickup, rather than the input's own sound?)` : `sound in ${r.audioF - fIn}f`);
    if (r.pixF != null && r.stateF != null && r.pixF - r.stateF >= 2) parts.push(`the picture trails the state by ${r.pixF - r.stateF}f`);
    if (r.audioF != null && r.pixF != null && r.audioF < r.pixF - 1) parts.push(`the sound comes ${r.pixF - r.audioF}f before the picture`);
    verdict = `input → ${parts.join(" · ")}`;
  }
  lines.push(`  verdict: ${verdict}`);
  if (r.sheetFile) lines.push(`  filmstrip → ${r.sheetFile} (top: with the input, bottom: without; view it with your image tool)`);
  const env = envelope("effect", {
      verdict,
      summary: {
        inputFrame: fIn, stateFrame: r.stateF, stateAfter: r.stateF == null ? null : r.stateF - fIn,
        pixelFrame: r.pixF, pixelAfter: r.pixF == null ? null : r.pixF - fIn, audioFrame: r.audioF, audioAfter: r.audioF == null ? null : r.audioF - fIn,
        statePathsAtEnd: r.endState.length, pixelPercentAtEnd: r.endPix ? r.endPix.changedPercent : null, deterministic: !(r.pre.length || r.prePix || r.preAudio),
      },
      data: {
        cause: r.cause, base: r.base, window: [fIn, fEnd], fps, firstChanges: r.stateChanges.slice(0, 50), endChanges: r.endState.slice(0, 200),
        pixelRegions: r.pixDiff ? r.pixDiff.boxes.map(({ x, y, w, h, pixels }) => ({ x, y, w, h, pixels })) : [], audio: r.audioF == null ? null : { frame: r.audioF, t: r.audioT, description: r.audioDesc, onsets: r.extraSounds },
      },
      files: r.sheetFile ? [r.sheetFile] : [],
  });
  return { env, text: lines.join("\n") };
}
export { report as reportEffect };
