// Witness CLI: listen — capture the game's audio, describe its sounds and music, and tie each sound to the event
// that should cause it (input presses, --events state changes, and the game's own {"event": "sound"} lines).
import fs from "node:fs";
import path from "node:path";
import { begin, stepTo } from "../core/runner.js";
import { sampleExprs, frameGrid } from "../core/sample.js";
import { alignSoundEvents, matchSounds, soundFrame } from "../core/soundmatch.js";
import { parseNamedEvents, eventFrames, inputPresses, errorLines } from "./ask.js";
import { die, withGame, runOpts, media, printLogs, framesOf, fmtT, envelope, emit } from "./common.js";

export async function listenCommand(pos, opt) {
  const named = parseNamedEvents(opt.events);
  let res;
  await withGame(opt, async (s, cfg, root) => {
    if (!s.has("audio")) die("this game's adapter doesn't support 'audio' (the mixer must write into a capture buffer in witness mode)");
    const fps = s.fps;
    const endF = framesOf(opt.time && opt.time !== true ? String(opt.time) : "5", fps);
    const ro = runOpts(opt, cfg);
    s.drainEvents("sound");                // a previous run's sound events don't belong to this one
    const st = await begin(s, ro);
    await s.audio();                       // discard anything mixed before the reset
    const replies = [];
    const grab = async () => { const a = await s.audio(); if (a && a.data) replies.push({ sampleRate: a.sampleRate, channels: a.channels || 1, format: a.format || "f32", data: a.data }); };
    let sample = null;
    if (named.length) {
      // state events need every frame; audio is collected once a second on the way
      sample = await sampleExprs(s, st, named.map((n) => n.expr), frameGrid(0, endF, 1), { onFrame: async (snap, f) => { if (f > 0 && f % fps === 0) await grab(); } });
      await grab();
    } else {
      for (let f = 0; f < endF;) { f = Math.min(endF, f + fps); await stepTo(s, st, f); await grab(); }
    }
    const soundEvents = s.drainEvents("sound").filter((e) => Number.isFinite(+e.frame));
    printLogs(await s.drainLogs());
    if (sample) { const errs = errorLines(named.map((n) => n.expr), sample); if (errs.length) die(errs.join("\n")); }
    const m = await media();
    if (!replies.length) die("the game returned no audio samples");
    const pcm = m.concatPCM(replies);
    const dec = m.decodePCM(pcm);
    const onsets = m.detectOnsets(m.mono(dec.channels), dec.sampleRate);
    const aligned = soundEvents.length ? alignSoundEvents(soundEvents, onsets, fps) : null;
    // with sound events, the analysis cuts sounds where the game said they start (heard time) and names them
    const rep = m.analyzePCM(pcm, { title: `${s.hello.name} — ${fmtT(endF / fps)}`, events: aligned ? aligned.sounds.map((x) => ({ t: x.t, label: x.label })) : null });
    // the sounds to match: the game's named events, else every analysed occurrence
    let sounds;
    if (aligned) sounds = [...aligned.sounds, ...aligned.unreported.map((o) => ({ label: `unreported sound`, t: o.t, f: o.f, unreported: true }))];
    else {
      // the report rounds times to 1 ms: use the exact onset each occurrence came from (frames need it)
      const exact = (t) => { let b = t, d = 0.003; for (const o of onsets) if (Math.abs(o.t - t) <= d) { d = Math.abs(o.t - t); b = o.t; } return b; };
      sounds = rep.report.sounds.flatMap((x) => x.times.map((t) => { const te = exact(t); return { label: x.label, t: te, f: soundFrame(te, fps) }; })).sort((a, b) => a.t - b.t);
    }
    const actions = [
      ...(opt["no-input-events"] ? [] : inputPresses(ro.input, fps).map((p) => ({ label: `${p.label} pressed`, f: p.f, kind: "input" }))),
      ...(sample ? eventFrames(named, sample).map((e) => ({ label: e.name, f: e.f, kind: "state" })) : []),
    ].filter((a) => a.f <= endF);
    const within = opt.within && opt.within !== true ? framesOf(String(opt.within), fps) : 6;
    // --loop a..b: how the end of a music loop meets its start
    let seam = null;
    if (opt.loop && opt.loop !== true) {
      const mm = /^\s*([^.]+?)\s*\.\.\s*(.+?)\s*$/.exec(String(opt.loop));
      if (!mm) die("--loop wants a..b (seconds or frames), e.g. --loop 0..4");
      const la = framesOf(mm[1], fps) / fps, lb = framesOf(mm[2], fps) / fps;
      const { loopSeam } = await import("../media/hygiene.js");
      try { seam = { a: la, b: lb, ...loopSeam(m.mono(dec.channels), dec.sampleRate, la, lb) }; } catch (e) { die(`--loop: ${e.message}`); }
    }
    const match = actions.length ? matchSounds(actions, sounds, { within }) : null;
    const outDir = path.resolve(opt.out && opt.out !== true ? String(opt.out) : path.join(root, cfg.shots, "listen"));
    const files = [];
    try {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "timeline.png"), m.timelinePNG(null, { analysis: rep, title: s.hello.name })); files.push(path.join(outDir, "timeline.png"));
      if (rep.segments && rep.segments.length) { fs.writeFileSync(path.join(outDir, "sounds.png"), m.soundSheetPNG(rep.segments, { title: s.hello.name })); files.push(path.join(outDir, "sounds.png")); }
      if (opt.wav) { fs.writeFileSync(path.join(outDir, "mix.wav"), m.pcmToWav(pcm)); files.push(path.join(outDir, "mix.wav")); }
    } catch (e) { if (!opt.json) console.log(`(no pictures: ${e.message})`); }
    res = { fps, endF, rep, aligned, soundEvents, sounds, actions, match, within, files, seam };
  });
  const out = report(res, opt);
  emit(out.env, out.text, opt);
}

function report(r, opt) {
  const { fps, rep, aligned, match, within } = r;
  const lines = [];
  const fr = (f) => `f${f}`;
  let counts = null;
  if (match) {
    counts = { events: match.matches.length, matched: 0, missing: 0, doubled: 0, early: 0 };
    lines.push(`Events vs sounds (window +0..+${within}f after each event; +1f is the earliest an input's sound can be heard, +0f for a state change):`);
    const w = Math.max(...match.matches.map((x) => `${x.action.label} ${fr(x.action.f)}`.length));
    for (const x of match.matches) {
      const head = `${x.action.label} ${fr(x.action.f)}`.padEnd(w);
      if (x.sound) {
        counts.matched++;
        if (x.doubles.length) { counts.doubled++; lines.push(`  ⚠ ${head} → ${x.sound.label} ${x.doubles.length + 1} times (+${x.offset}f, ${x.doubles.map((d) => `+${d.offset}f`).join(", ")}): double-triggered?`); }
        else lines.push(`  ✔ ${head} → ${x.sound.label} at +${x.offset}f${x.sound.heard === false ? " (announced, but nothing audible starts there)" : ""}`);
      } else {
        counts.missing++;
        if (x.early) counts.early++;
        const hint = x.early ? ` — but ${x.early.sound.label} started ${-x.early.offset}f BEFORE it` : x.before ? ` (the ${x.before.action.label.replace(/ pressed$/, " press")} at ${fr(x.before.action.f)} played ${x.before.sound.label}: a cooldown or retrigger rule eating this one?)` : "";
        lines.push(`  ✖ ${head} → no sound within ${within}f${hint}`);
      }
    }
    if (match.unexplained.length) {
      const by = new Map();
      for (const s of match.unexplained) { if (!by.has(s.label)) by.set(s.label, []); by.get(s.label).push(s); }
      lines.push(`Sounds with no event: ${[...by].map(([l, ss]) => `${l}${ss.length > 1 ? ` ×${ss.length}` : ""} (${ss.slice(0, 6).map((s) => fr(s.f)).join(", ")}${ss.length > 6 ? ", …" : ""})`).join(" · ")}`);
    }
    lines.push("");
  }
  if (aligned) {
    const heard = aligned.sounds.filter((x) => x.heard).length;
    lines.push(`The game announced ${aligned.sounds.length} sound${aligned.sounds.length === 1 ? "" : "s"} ({"event": "sound"} lines); ${heard} line up with an onset in the audio${aligned.lag ? `, heard ${Math.abs(aligned.lag)}f ${aligned.lag > 0 ? "after" : "before"} the frame the game announced (median)` : ""}.`);
    const silent = aligned.sounds.filter((x) => !x.heard);
    if (silent.length) lines.push(`  ⚠ announced but nothing audible starts there: ${silent.slice(0, 6).map((x) => `${x.label} (${fr(x.declared)})`).join(", ")}${silent.length > 6 ? ", …" : ""} — an empty/muted sample, or a sound starting inside another`);
    if (aligned.unreported.length) lines.push(`  ⚠ audible onsets the game didn't announce: ${aligned.unreported.slice(0, 6).map((o) => `${fmtT(o.t)} (${fr(o.f)})`).join(", ")}${aligned.unreported.length > 6 ? ", …" : ""}`);
    lines.push("");
  }
  if (r.seam) {
    const q = r.seam;
    lines.push(`Loop ${q.a}–${q.b} s seam: ${q.ok ? "✔ clean" : "✖"} · level step ${q.levelStep} dB · jump at the joint ${q.joint} (the slope around it ${q.slope})${q.click ? " → it clicks" : ""} · brightness jump ${q.brightnessJump} Hz${q.ok ? "" : " → cut the loop on a zero crossing at the same phase, or crossfade 10–50 ms"}`, "");
  }
  const text = [...lines, rep.text].join("\n").replace(/pass event times for exact labels\./, "games can name them with {\"event\": \"sound\"} lines (docs/PROTOCOL.md).");
  {
    const ma = match ? match.matches.map((x) => ({ event: x.action.label, frame: x.action.f, kind: x.action.kind, sound: x.sound ? x.sound.label : null, soundFrame: x.sound ? x.sound.f : null, offset: x.offset, doubles: x.doubles.map((d) => d.offset), early: x.early ? x.early.offset : null })) : [];
    // a report, not a test: missing sounds don't fail it (movement keys have none); gate with --expect "missing == 0"
    const env = envelope("listen", {
      verdict: rep.text.split("\n")[0] + (counts ? ` · events: ${counts.matched}/${counts.events} have their sound, ${counts.missing} missing, ${counts.doubled} doubled` : ""),
      summary: { ...(r.seam ? { loopOk: r.seam.ok, loopJoint: r.seam.joint, loopLevelStep: r.seam.levelStep } : {}), truePeakDb: rep.report.mix.truePeakDb, sounds: rep.report.sounds.length, occurrences: rep.report.sounds.reduce((a, x) => a + x.count, 0), problems: rep.report.problems.length, ...(counts || {}), unexplained: match ? match.unexplained.length : null, announced: aligned ? aligned.sounds.length : 0 },
      data: { report: rep.report, matches: ma, unexplained: match ? match.unexplained.map((x) => ({ sound: x.label, frame: x.f, t: x.t })) : [], soundEvents: aligned ? aligned.sounds : [], unreported: aligned ? aligned.unreported : [], fps },
      files: r.files,
    });
    return { env, text: `${text}${r.files.length ? `\nwrote ${r.files.join(", ")}  (view the PNGs with your image tool)` : ""}` };
}
}
