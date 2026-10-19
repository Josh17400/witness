#!/usr/bin/env node
// Witness CLI — let Claude see, hear and prove any game. Run `witness help`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_NAME } from "../src/core/launch.js";
import { begin, stepTo, frameAt, findTestFiles, loadTests, runTest, loadReplay } from "../src/core/runner.js";
import { evaluate, fmt, keyPaths, ExprError, usesPrev } from "../src/core/expr.js";
import { WitnessError } from "../src/core/session.js";
import { Matcher, diffValues, digestOf, pathFilter } from "../src/core/compare.js";
import { prune, pruneRegistry, fmtBytes } from "../src/core/clean.js";
import { CLI, die, nums, fmtT, timeList, framesOf, loadConfig, withGame, runOpts, media, writeShot, printLogs, summarizeState, splitTop, resolveReplay } from "../src/cli/common.js";
import { evalCommand, traceCommand } from "../src/cli/ask.js";
import { shotCommand } from "../src/cli/see.js";
import { measureCommand } from "../src/cli/measure.js";
import { effectCommand } from "../src/cli/effect.js";
import { listenCommand } from "../src/cli/listen.js";
import { windowCommand } from "../src/cli/window.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

const HELP = `Witness ${VERSION} — let Claude see, hear and prove any game

  witness init [--lang <id>]          detect the project, add the right adapter + witness.json + Claude skill
  witness doctor                      connect, list capabilities, check determinism/screens/audio
  witness test [files] [--name x]     run *.witness.json / *.witness.mjs test files (--repeat 2: prove determinism)
  witness eval --at 2 "expr" ...      state at given times; --keys (what's there), --when "cond", --diff 1,3
  witness trace --watch "a, b"        values over time: per-series table (frames, per-frame steps) + chart PNG
  witness effect --input "space@1"    what an input causes and how many frames later (state, pixels, audio)
  witness window --input "space@{t}"  sweep an input's timing: where it still works (coyote, buffer, parry windows)
  witness shot --at 1,4               screenshots; --sheet/--auto filmstrips, --crop/--follow/--zoom, --diff ref.png
  witness listen --time 8             hear the game: sounds tied to their causes, audio report + PNGs
  witness measure <what> ...          numbers: jump, move, hitstop, curve (state) · scale, box, contrast, motion (pixels)
  witness replay [file|last]          play back a recorded human session (WITNESS_RECORD)
  witness call <name> [args] --at 1   run a game-specific command, then show the state
  witness raw '<json command>'        send one raw protocol command (for adapter authors)
  witness adapters                    list the bundled adapters
  witness play start|do|look|end ...  agent playtests: a cheap model PLAYS the game, Witness reports (help play)
  witness clean [--all]               delete old playtests, recordings and screenshots (see help clean)

Common options:
  --input "right@0-2, space@1, click:640,360@1.5, action:jump@2"   scripted input
  --seed 7  --scene <name>  --params '{"level":2}'  --build (run witness.json "build" first)
  --window 1920x1080  --dpi 2   (sent as reset params "window"/"dpi" for games that support them)
  --attach (wait for an already-running game)  --cmd "<launch command>" (no witness.json needed)
  --json (machine-readable)   --timeout 60
Times are seconds, or frames with an "f": --at 90f, --every 1f, space@60f. "+2f" = 2 frames after the input's frame.

Run 'witness help <command>' for details. Protocol: docs/PROTOCOL.md`;

const CMD_HELP = {
  clean: `witness clean [--all] [--playtests|--replays|--shots]
  Generated files are pruned automatically (on play start and test) to witness.json "retention", default
  {"playtests": {"keep": 5, "days": 7}, "replays": {"keep": 10, "days": 14}, "shots": {"days": 3}}: the newest
  N stay unless older than the days limit. Plain 'witness clean' applies those limits now; --all deletes every
  playtest, recording and screenshot (running playtests are never touched). 'witness play clean t1' deletes one
  playtest once you've acted on it.`,
  test: `witness test [files...] [--name <substring>] [--json]
  Test files (default folder: "tests" in ${CONFIG_NAME}, usually witness/) are *.witness.json or *.witness.mjs:
    [{ "name": "coin pickup", "seed": 1, "input": "right@0-1.5",
       "steps": [ { "at": 2, "expect": ["state.score == 1", "count('Coin') == 4"] },
                  { "at": 2.5, "call": ["teleport", 10, 20], "expect": "state.player.pos[0] == 10", "shot": "after.png" } ] }]
  Expressions are JavaScript over the snapshot: state.*, count(type), first(type), all(type), near(pos, type),
  dist(a, b), len(x), approx(a, b), frame, time, prev (the previous step), rose(x)/fell(x) (became true/false since
  the previous frame), changed(x), since(x) (frames since x became true; ranges only).
  Each point step runs: call → input → expect → probe → shot → match. "at" may be seconds or frames ("90f").
  Range steps are checked on EVERY frame from "from" to "to" (or "from" + "within"), prev = the previous frame:
    { "from": 0, "to": 3, "always": "state.player.hp >= 0", "never": "count('Coin') > 5", "eventually": "state.score == 1" }
    { "from": 1, "within": "30f", "eventually": "rose(state.player.grounded)" }
  A failure names the first bad frame: always state.player.hp >= 0 — failed at frame 212 (t=3.533s): got -1 >= 0
  "match": "label" — the first capture of a label (state, digest, screenshot, audio) is the reference; every later
  capture of that label in this run must be identical (e.g. the same fight run twice, or a plain start after other tests).
  --repeat N   run the whole selection N times in one game process; every step must equal the same step of pass 1
               (state, digest, screenshot and audio): the strongest determinism check. --no-shots / --no-audio skip those.`,
  eval: `witness eval [--at 0.5,2,90f] "expr" ["expr2" ...] [--input ...] [--json]
  --keys      every path in the snapshot: vectors inline, long arrays elided, entities grouped by type with the union
              of their fields (Wolf ×3: hp ∈ 1..3, state ∈ {idle, chase}); "~" marks paths that changed since frame 0
  --summary   a one-screen summary of the state at each time
  Expressions may use prev (the previous frame) and rose(x) / fell(x) / changed(x).
  --when "cond[, cond2]" [--time 5] [--every 1f]
              samples every frame: the first frame each condition is true, how long, and its spans
  --diff 1,3  what changed in the state between two moments (entities matched by id: removed Coin#12, …)`,
  trace: `witness trace --watch "state.player.pos, state.score" [--time 5] [--every 1f] [--out chart.png]
  Samples every frame (long runs thin out to <= 600 samples) with prev = the previous frame, so per-frame velocity
  is exact ("state.player.pos[0] - prev.player.pos[0]"). Per series: start → end, min/max with their frames, the
  per-frame step range (vectors per axis); for flags and strings, each change with its frame. Expressions that fail
  are reported once with the number of samples. --events "land: rose(state.player.grounded)" marks state events;
  the chart PNG also draws the --input keys as bars under the plot. --replay last traces a recording.
  --json: { "expr": [[t, value, frame], ...] }, one sample per line.`,
  shot: `witness shot [--at 1,4,90f] [--out shots/s.png] [--scale 0.5] [--json]
  --crop x,y,w,h | --follow "state.player.pos" [--size 96 | 96x64]   a region (follow: centred on a position)
  --zoom 3                     crisp nearest-neighbour enlargement (small sprites)
  --diff ref.png [--ignore "x,y,w,h; x,y,w,h"] [--threshold 16]      changed % and every changed region's box
  Filmstrips (one picture, read it with your image tool):
  --from 1 --to 1.5 [--every 3f] --sheet [--cols 6]    a labelled grid of frames (max 48; with --crop/--follow/--zoom)
  --from 0 --to 4 --auto 9                             the 9 frames where the picture changes most (key moments)`,
  listen: `witness listen [--time 8] [--input ...] [--events "name: expr, ..."] [--within 6f] [--out dir] [--wav]
  Captures the game's audio (adapter 'audio' capability), then:
  * events vs sounds: each input press (unless --no-input-events) and each --events state change gets the sound it
    caused within the window: ✔ "+1f" (an input's sound can come +1f at the earliest; a state change's +0f),
    ✖ no sound (with a hint when the same input played one before), ⚠ played twice; then sounds with no event;
  * sounds found (pitch, length, brightness, loudness), music tempo/key/chords, mix problems;
  * timeline.png + sounds.png (+ mix.wav).
  Games that announce sounds ({"event": "sound"}, e.g. witness.sound("jump")) get them named and checked against the
  audio (announced but silent, audible but unannounced).`,
  window: `witness window --input "right@0-2, space@{t}" --t 0.9..1.3 [--step 1f] --expect "expr" [--at "{t}+0.4"]
              [--ref "fell(state.player.grounded)"]
  One run per value of {t} (seconds or frames), each checking --expect at --at ("{t}+offset" or a plain time). Prints
  the values where it passes as windows, and the first failure's values. --ref names the moment the window is about
  (leaving a ledge, landing, an enemy's attack): it is found in a run without the swept input, and the windows are
  given relative to the step it happened in: "+0f..+4f" after leaving the ledge = 5 frames of coyote time;
  "-4f" before landing = a 4-frame jump buffer. Needs 'reset'; at most 600 runs.`,
  effect: `witness effect --input "space@1" [--base "right@0-3"] [--time 0.5] [--paths "player, camera"] [--shot]
  Runs the same seed twice in one process, with the input and without it (both with --base), and reports the first
  frame where the state, the picture and the audio differ: "+1f" = the next frame (immediate). Lists the state paths
  that changed first, the changed screen regions, what the new sound is, and how much differs at the end of the
  window. --shot writes a two-row filmstrip (with / without) around the first visible change. --no-pixels / --no-audio.`,
  replay: `witness replay [file.jsonl | last] [--at 5,10] [--shot] [--watch "expr, ..."] [--ignore "path, ..."]
  Replays are recorded when a human plays with WITNESS_RECORD=<file.jsonl> set (F8 adds a marker). The header's seed,
  scene and params go to reset. If <file.jsonl>.state.json exists (the state the recording ended in), the replay's
  final state is compared to it field by field. Paths that legitimately differ (window-dependent fields) can be left
  out with --ignore or witness.json "replay": {"ignore": [...]}: "player.px" skips that field and everything under it,
  "entities[*].dist" any index, "view.*" any key.`,
  init: `witness init [--lang <id>] [--force]   (ids: witness adapters)`,
  measure: `witness measure <what> ...   numbers instead of eyeballing; --json (jump/move/hitstop/curve/motion print { ok, verdict, summary, data })
  From the state, sampled every frame of a scripted run (--input, --time, --from/--to):
  jump --y "state.player.pos[1]" --input "space@1" [--x expr] [--up -1|1] [--key space]
      takeoff, apex height and frame, hang (frames within 10% of the apex), airtime, rise/fall, gravity rising vs
      falling (fast-fall?), horizontal distance. Landing = holds still for 3 frames.
  move --x "state.player.pos[0]" --input "right@1-2" [--key right]
      top speed (px/f and px/s), frames to reach it, and after the release: when it stops, how far it slides, overshoot
  hitstop --paths "state.player.pos, state.enemy.pos" --input "right@0-2, j@1"
      freezes: frames where every path holds still between motion (with their length and the input before them)
  curve --of "state.camera.pos[0]" [--vs "state.player.pos[0]"] --input "d@1-3"
      start/end/min/max with frames, per-frame steps, rise 10–90%, settle (2%), overshoot, still spans, stutter
      (single steps that break a smooth motion), lag behind --vs (frames, by cross-correlation of the steps)
  From pixels:
  scale <shot.png> [--k 3] [--region x,y,w,h] [--tolerance 0]
      integer-scale test: is every k×k cell one colour? Finds k and the grid offset; reports blur/fractional scaling.
  box <with.png> <without.png> [--threshold 16]
      the pixels that differ between a shot with something and one without it: its exact box, height, centroid.
  contrast <shot.png> --a <mask> --b <mask>
      WCAG ratio and ΔE between two pixel sets. A mask is x,y,w,h | #rrggbb[~tolerance] | diff:<without.png>,
      and --b may be ring[:radius] (the pixels just outside --a, e.g. outline vs the ground around it).
  motion [frame.png ...]  |  motion --at 1 --time 0.5 [--input ...] [--region x,y,w,h]
      every moving object, tracked frame to frame: its speed, net move, jitter (px off a smooth path: steady motion
      and smooth acceleration give 0), stutters (a repeated frame, a double step), flicker (gone for a few frames),
      frames where it merged with something (left out of the steps); things that appear or vanish without moving
      are listed apart. A moving camera is detected (per-frame scroll, jitter, uneven steps like "f30 [3,0] instead
      of ~[2,0]") and removed, so object motion is in world pixels. Prints one object's frames (--track N, or
      --near x,y). Drives the game and screenshots every frame (needs 'reset': one pass for the camera and the
      background, one to measure), or reads PNG files.
      --background auto|first|median|<file.png>  (auto: median for 8+ frames; median needs movers to move their own
      size) · --camera auto|static|moving · --min-size 6 (smallest object, px) · --threshold 16`,
  doctor: `witness doctor [--time 3]
  Checks the connection, protocol, step/snapshot, screenshot and audio, and determinism: a scripted run (--time s), a
  different "dirty" run, then the first run again in the same process; state, digest, screenshot and audio must match.
  For long game-specific scenarios (journeys, fights) use test steps with "match", or witness test --repeat 2.`,
};

// ------------------------------------------------------------------ args & output
function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2), nxt = argv[i + 1];
      if (nxt !== undefined && !nxt.startsWith("--") && !/^-[a-z]/i.test(nxt)) { opt[k] = nxt; i++; } else opt[k] = true;
    } else if (a === "-o") opt.out = argv[++i];
    else if (a === "-s") opt.s = argv[++i];
    else pos.push(a);
  }
  return { pos, opt };
}
// ------------------------------------------------------------------ commands
const commands = {
  async doctor(pos, opt) {
    const report = [];
    const ok = (m) => report.push(`✔ ${m}`), bad = (m) => report.push(`✖ ${m}`), warn = (m) => report.push(`⚠ ${m}`);
    await withGame(opt, async (s) => {
      const h = s.hello;
      ok(`connected over ${s.conn.kind}: "${h.name}" (${h.engine || "?"}, ${h.language || "?"}), protocol ${h.protocol}, ${s.fps} fps${h.size ? `, ${h.size.join("×")}` : ""}`);
      if (h.protocol !== 1) warn(`protocol ${h.protocol} — this CLI speaks v1`);
      const caps = h.capabilities || [];
      const all = ["reset", "step", "input", "snapshot", "screenshot", "audio", "call", "eval", "logs", "perf"];
      report.push(`  capabilities: ${all.map((c) => (caps.includes(c) ? c : `(${c})`)).join(" ")}`);
      if (caps.includes("input")) report.push(`  touch: ${h.touch ? "native (hello.touch: finger events only, no mouse fallback)" : "finger 0 also arrives as the mouse (set hello.touch if the game handles touch itself)"}`);
      for (const need of ["step", "snapshot"]) if (!caps.includes(need)) bad(`missing required capability '${need}'`);
      if (!caps.includes("reset")) warn("no 'reset': Witness restarts the game for every run (slower)");
      if (h.calls && h.calls.length) report.push(`  calls: ${h.calls.map((c) => `${c.name}${c.args ? ` ${c.args}` : ""}`).join(" · ")}`);
      // step + snapshot
      const st = await begin(s, { seed: 1 });
      await stepTo(s, st, 30);
      const a = await s.snapshot();
      ok(`step 30 frames → frame ${a.frame}, t=${fmtT(a.time ?? 0)}`);
      const keys = keyPaths(a.state || {});
      ok(`snapshot has ${keys.length} fields${(a.state || {}).entities ? `, ${(a.state.entities || []).length} entities` : " (tip: expose state.entities = [{id, type, pos}] to unlock count()/first()/near())"}`);
      // determinism: run A, a different "dirty" run B, then A again in the same process. A must repeat exactly:
      // state, digest, screenshot and audio. The dirty run in between catches state that leaks across resets
      // (timers, id counters, caches, particle clocks, UI state) that two back-to-back runs can miss.
      let detAudio = null;   // the determinism runs' audio, reused by the audio check below
      if (caps.includes("reset") && caps.includes("input")) {
        const T = Math.max(0.5, +(opt.time || 3));
        const scriptA = "right@0.1-1.2, space@0.3, up@1.3-1.8, mouse:100,100@0.5, click:120,90@0.8, left@1.9-2.4, down@2.5-2.9, space@2.6";
        const scriptB = "left@0.1-0.9, down@0.4-1.4, click:60,40@0.6, right@1.5-2.6, space@1.1, up@2.7-3";
        const matcher = new Matcher();
        const exactAudio = caps.includes("audio") && h.audio_exact !== false;
        if (caps.includes("audio") && !exactAudio) report.push("  (hello says audio_exact: false — audio follows real time here, so it isn't compared)");
        const run = async (seed, input) => {
          const st2 = await begin(s, { seed, input });
          if (caps.includes("audio")) await s.audio();
          await stepTo(s, st2, Math.round(T * s.fps));
          const cap = { snap: await s.snapshot() };
          if (caps.includes("screenshot")) { try { cap.shot = await s.screenshot(); } catch { /* reported below */ } }
          if (caps.includes("audio")) { try { const au = await s.audio(); if (au && au.data && exactAudio) cap.audio = au; } catch { /* reported below */ } }
          return cap;
        };
        const first = await run(7, scriptA);
        detAudio = first.audio || null;
        await matcher.check("A", first, "run A");
        await run(11, scriptB);
        const r = await matcher.check("A", await run(7, scriptA), "run A again");
        const covered = ["state", digestOf(first.snap) != null ? "digest" : null, first.shot ? "screenshot" : null, first.audio ? "audio" : null].filter(Boolean).join(", ");
        if (r.ok) ok(`deterministic over ${T}s: the same seed + input gave identical ${covered}, even after a different run in between`);
        else {
          bad("NOT deterministic: run A repeated after a different run gave a different result (see docs/PROTOCOL.md §6)");
          for (const p of r.problems) report.push(`    ${p}`);
          report.push("    tip: look for unseeded RNGs, wall-clock reads, threads, and state a reset doesn't clear (timers, id counters, caches, UI)");
        }
        if (digestOf(first.snap) == null) report.push("  tip: add a snapshot \"digest\" (a hash of the full internal state) so hidden state is compared too");
        report.push("  for long scenarios (journeys, fights, menus): add \"match\" steps to tests, or run  witness test --repeat 2");
      }
      if (caps.includes("screenshot")) {
        try { const sh = await s.screenshot(); ok(`screenshot ${sh.width ?? "?"}×${sh.height ?? "?"} (${sh.format || (sh.path ? "file" : "?")})`); }
        catch (e) { bad(`screenshot failed: ${e.message}`); }
      }
      if (caps.includes("audio")) {
        try {
          const fresh = await s.audio();
          const au = fresh && fresh.data && Buffer.from(fresh.data, "base64").length ? fresh : detAudio || fresh;
          const n = au.data ? Buffer.from(au.data, "base64").length / ((au.format === "s16" ? 2 : 4) * (au.channels || 1)) : 0;
          const want = (a.time ?? 0.5) * (au.sampleRate || 44100);
          ok(`audio ${au.sampleRate} Hz × ${au.channels} ch, ${au.format}${n ? ` (${n} frames)` : ""}`);
          if (n === 0) warn("audio returned no samples — make sure the mixer writes into the capture buffer in witness mode");
          void want;
        } catch (e) { bad(`audio failed: ${e.message}`); }
      }
      const logs = await s.drainLogs();
      if (logs.some((l) => l.level === "error")) warn(`the game logged ${logs.filter((l) => l.level === "error").length} error(s) during the checks`);
    });
    console.log(report.join("\n"));
    const failed = report.some((l) => l.startsWith("✖"));
    console.log(failed ? "doctor found problems" : "all good — Witness can drive this game");
    process.exit(failed ? 1 : 0);
  },

  async clean(pos, opt) {
    const { cfg, root } = loadConfig(opt);
    const only = opt.playtests ? "playtests" : opt.replays ? "replays" : opt.shots ? "shots" : null;
    const r = prune(cfg, root, { all: !!opt.all, only });
    const k = only && only !== "playtests" ? 0 : pruneRegistry();
    if (opt.json) { console.log(JSON.stringify({ removed: r.removed, bytes: r.bytes, registry: k })); return; }
    console.log(r.removed.length ? `removed ${r.removed.length} item(s), ${fmtBytes(r.bytes)}:` : "nothing to remove");
    for (const p of r.removed.slice(0, 20)) console.log(`  ${path.relative(root, p) || p}`);
    if (r.removed.length > 20) console.log(`  … and ${r.removed.length - 20} more`);
  },

  async test(pos, opt) {
    const { cfg, root } = loadConfig(opt);
    try { prune(cfg, root); } catch { /* best effort: old playtests, recordings and screenshots */ }
    const files = findTestFiles(root, cfg, pos);
    if (!files.length) die(`no test files found (looked for *.witness.json / *.witness.mjs in ${path.resolve(root, cfg.tests)})`);
    let tests = [];
    for (const f of files) tests.push(...(await loadTests(f)));
    if (opt.name) tests = tests.filter((t) => t.name.toLowerCase().includes(String(opt.name).toLowerCase()));
    if (!tests.length) die(`no test matches '${opt.name}'`);
    const results = [];
    const shotDir = path.resolve(root, cfg.shots);
    const repeat = Math.max(1, Math.floor(+(opt.repeat === true ? 2 : opt.repeat || 1)));
    const matcher = new Matcher();
    const matchMedia = { shot: !opt["no-shots"], audio: !opt["no-audio"] };
    const schedule = [];
    for (let p = 1; p <= repeat; p++) for (const t of tests) schedule.push(repeat > 1 ? { ...t, name: `${t.name}  [pass ${p}/${repeat}]` } : t);
    await withGame(opt, async (s, c, r, g) => {
      for (const t of schedule) {
        let res;
        try { res = await runTest(s, t, { shotDir, onShot: writeShot, matcher, matchAll: repeat > 1, matchMedia }); }
        catch (e) { res = { name: t.name, file: t.file, ok: false, expects: { passed: 0, failed: 0 }, failures: [{ kind: "error", message: e.message }] }; }
        results.push(res);
        if (!opt.json) printTest(res, root);
        if (s.closed) {
          if (!opt.json) console.log("✖ the game crashed or disconnected — remaining tests skipped");
          if (!opt.json) { const tail = g.output().trim().split("\n").slice(-12).join("\n"); if (tail) console.log(`--- last game output ---\n${tail}`); }
          break;
        }
        if (!s.has("reset") && schedule.indexOf(t) < schedule.length - 1) console.log("⚠ the adapter has no 'reset', so later tests continue from this state");
      }
    });
    const failed = results.filter((r) => !r.ok).length;
    if (opt.json) console.log(JSON.stringify({ ok: !failed, results }, null, 1));
    else {
      if (repeat > 1) {
        const diverged = results.some((x) => (x.failures || []).some((f) => f.kind === "match" && f.message.startsWith("repeat:")));
        console.log(diverged ? `✖ passes 2..${repeat} did not repeat pass 1 exactly (see the "repeat:" lines)` : `✔ all ${repeat} passes were identical at every step`);
      }
      console.log(`${results.length - failed} passed, ${failed} failed`);
    }
    process.exit(failed ? 1 : 0);
  },

  eval: evalCommand,
  trace: traceCommand,

  shot: shotCommand,

  listen: listenCommand,

  measure: measureCommand,
  effect: effectCommand,
  window: windowCommand,

  async replay(pos, opt) {
    await withGame(opt, async (s, cfg, root) => {
      const r = loadReplay(resolveReplay(pos[0] || "last", cfg, root));
      console.log(`▶ replay ${path.basename(r.file)}: ${r.frames} frames, ${fmtT(r.duration)}, seed ${r.seed}${r.marks.length ? `, marks: ${r.marks.map((m) => `${m.label}@${fmtT(m.t)}`).join(" ")}` : ""}`);
      const st = await begin(s, { replay: r });
      const frames = opt.at ? timeList(opt.at, []).map((t) => framesOf(t, s.fps, r.dts)) : [...r.marks.map((m) => m.frame), r.frames];
      const watch = opt.watch ? splitTop(String(opt.watch)) : [];
      const needPrev = watch.some(usesPrev);
      const endFile = `${r.file}.state.json`;   // written by adapters/games at the end of a recording (optional)
      // state paths left out of the end-state check (window-dependent fields and the like): witness.json replay.ignore + --ignore
      const ignore = [...(cfg.replay && Array.isArray(cfg.replay.ignore) ? cfg.replay.ignore : []), ...(opt.ignore && opt.ignore !== true ? splitTop(String(opt.ignore)) : [])];
      const skip = ignore.length ? pathFilter(ignore) : null;
      let endChecked = false;
      for (const f of [...new Set(frames)].sort((a, b) => a - b)) {
        let prev = null;
        if (needPrev && f > 0) { await stepTo(s, st, f - 1, r.dts); prev = await s.snapshot(); }
        await stepTo(s, st, f, r.dts);
        const snap = await s.snapshot();
        const t = snap.time ?? st.time;
        if (st.frame >= r.frames && !endChecked && fs.existsSync(endFile)) {
          endChecked = true;
          let want;
          try { want = JSON.parse(fs.readFileSync(endFile, "utf8")); } catch (e) { console.log(`⚠ can't read ${path.basename(endFile)}: ${e.message}`); }
          if (want !== undefined) {
            // the file holds a snapshot ({frame, time, state}) or just the state
            const wantState = want && typeof want === "object" && "state" in want && ("frame" in want || "time" in want) ? want.state : want;
            const d = diffValues(wantState, snap.state, "state", [], 20, skip);
            if (!d.length) console.log(`✔ the replay ended in exactly the recorded end state (${path.basename(endFile)})${ignore.length ? ` (ignoring ${ignore.join(", ")})` : ""}`);
            else {
              console.log(`✖ the replay's end state differs from the recording's (${path.basename(endFile)}) at ${d.length >= 20 ? "20+" : d.length} path(s):`);
              for (const x of d.slice(0, 12)) console.log(`    ${x.path}: recorded ${String(JSON.stringify(x.a)).slice(0, 80)} → replayed ${String(JSON.stringify(x.b)).slice(0, 80)}`);
              process.exitCode = 1;
            }
          }
        }
        console.log(summarizeState(snap));
        for (const x of watch) { let v; try { v = fmt(evaluate(x, snap, prev), 120); } catch (e) { v = `✖ ${e.message}`; } console.log(`   ${x} = ${v}`); }
        if (opt.shot && s.has("screenshot")) {
          const file = path.resolve(root, cfg.shots, `replay-${String((+t).toFixed(2)).replace(".", "_")}.png`);
          await writeShot(await s.screenshot(), file);
          console.log(`   → ${file}`);
        }
      }
      printLogs(await s.drainLogs());
    });
  },

  replays(pos, opt) {
    const { cfg, root } = loadConfig(opt);
    const dir = path.resolve(root, cfg.replays);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs) : [];
    if (!files.length) { console.log(`no replays in ${dir} — play the game with WITNESS_RECORD=${path.join(cfg.replays, "session.jsonl")} set (press F8 to mark moments)`); return; }
    files.forEach((f, i) => { try { const r = loadReplay(f); console.log(`  #${i + 1} ${path.basename(f)}  ${fmtT(r.duration)}  seed ${r.seed}${r.marks.length ? `  marks: ${r.marks.map((m) => `${m.label}@${fmtT(m.t)}`).join(" ")}` : ""}`); } catch (e) { console.log(`  #${i + 1} ${path.basename(f)}  (unreadable: ${e.message})`); } });
  },

  async call(pos, opt) {
    const [name, ...args] = pos;
    if (!name) die("usage: witness call <name> [args...] [--at 1]");
    await withGame(opt, async (s, cfg) => {
      if (!s.has("call")) die("this game's adapter doesn't support 'call'");
      const st = await begin(s, runOpts(opt, cfg));
      await stepTo(s, st, framesOf(opt.at && opt.at !== true ? String(opt.at) : "0.5", s.fps));
      const r = await s.call(name, args.map((a) => (/^-?\d+(\.\d+)?$/.test(a) ? +a : a)));
      console.log(`✔ ${name}(${args.join(", ")}) → ${fmt(r.result, 300)}`);
      await stepTo(s, st, st.frame + 1);
      console.log(summarizeState(await s.snapshot()));
      printLogs(await s.drainLogs());
    });
  },

  async raw(pos, opt) {
    await withGame(opt, async (s) => {
      console.log(`hello: ${JSON.stringify(s.hello)}`);
      for (const p of pos) {
        let msg;
        try { msg = JSON.parse(p); } catch { msg = { cmd: p }; }
        const { cmd, ...args } = msg;
        try { const r = await s.request(cmd, args); console.log(JSON.stringify(r).slice(0, 4000)); }
        catch (e) { console.log(`✖ ${e.message}`); }
      }
    });
  },

  async init(pos, opt) {
    const { init } = await import("../src/core/init.js");
    await init(pos[0] ? path.resolve(pos[0]) : process.cwd(), opt, ROOT);
  },

  async adapters() {
    const { listAdapters } = await import("../src/core/init.js");
    for (const a of listAdapters(ROOT)) console.log(`  ${a.id.padEnd(14)} ${a.title}${a.verified ? "" : "  (unverified)"}`);
  },

  async play(pos, opt) {
    const { playCommand } = await import("../src/play/client.js");
    await playCommand(pos[0], pos.slice(1), opt, { loadConfig, ROOT });
  },

  async help(pos) {
    if (pos[0] === "play") { const { PLAY_HELP } = await import("../src/play/client.js"); console.log(PLAY_HELP); return; }
    console.log(pos[0] && CMD_HELP[pos[0]] ? CMD_HELP[pos[0]] : HELP);
  },
  version() { console.log(VERSION); },
};

function printTest(res, root) {
  const rel = res.file ? path.relative(root, res.file) : "";
  const ex = res.expects || { passed: 0, failed: 0 };
  console.log(`${res.ok ? "✔ pass" : "✖ FAIL"}  ${res.name}  (${ex.passed} expect${ex.passed === 1 ? "" : "s"} passed${ex.failed ? `, ${ex.failed} failed` : ""})${rel ? `  ${rel}` : ""}`);
  for (const f of res.failures || []) {
    if (f.kind === "warn") console.log(`    ⚠ ${f.message}`);
    else console.log(`    ${f.kind === "expect" ? `expect failed at ${f.at}${/^-?[\d.]+$/.test(String(f.at)) ? "s" : ""}:` : "✖"} ${f.message}`);
  }
  for (const [p, vals] of Object.entries(res.probes || {})) console.log(`    probe ${p}: ${vals.map(([t, v]) => `${fmtT(t)}=${fmt(v, 40)}`).join("  ")}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const { pos, opt } = parseArgs(rest);
CLI.json = !!opt.json;
try {
  if (!cmd || cmd === "-h" || cmd === "--help") commands.help([]);
  else if (cmd === "-v" || cmd === "--version") commands.version();
  else if (commands[cmd] && (opt.help || pos[0] === "--help")) await commands.help([cmd]);
  else if (commands[cmd]) await commands[cmd](pos, opt);
  else die(`unknown command '${cmd}'\n\n${HELP}`);
} catch (e) {
  if (e instanceof WitnessError || e instanceof ExprError) die(e.message);
  throw e;
}
