#!/usr/bin/env node
// Witness CLI — let Claude see, hear and prove any game. Run `witness help`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findConfig, openGame, runBuild, CONFIG_NAME } from "../src/core/launch.js";
import { begin, stepTo, frameAt, findTestFiles, loadTests, runTest, loadReplay } from "../src/core/runner.js";
import { evaluate, check, fmt, keyPaths, ExprError } from "../src/core/expr.js";
import { WitnessError } from "../src/core/session.js";
import { Matcher, diffValues, digestOf } from "../src/core/compare.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

const HELP = `Witness ${VERSION} — let Claude see, hear and prove any game

  witness init [--lang <id>]          detect the project, add the right adapter + witness.json + Claude skill
  witness doctor                      connect, list capabilities, check determinism/screens/audio
  witness test [files] [--name x]     run *.witness.json / *.witness.mjs test files (--repeat 2: prove determinism)
  witness eval --at 2 "expr" ...      evaluate expressions on the game's state at given times
  witness trace --watch "a, b"        values over time: summary, table and a chart PNG
  witness shot --at 1,4               screenshots (PNG); --diff ref.png highlights changes
  witness listen --time 8             hear the game: audio report + spectrogram PNGs
  witness measure <what> ...          pixel measurements: scale, box, contrast, motion (see help measure)
  witness replay [file|last]          play back a recorded human session (WITNESS_RECORD)
  witness call <name> [args] --at 1   run a game-specific command, then show the state
  witness raw '<json command>'        send one raw protocol command (for adapter authors)
  witness adapters                    list the bundled adapters

Common options:
  --input "right@0-2, space@1, click:640,360@1.5, action:jump@2"   scripted input (times in s)
  --seed 7  --scene <name>  --params '{"level":2}'  --build (run witness.json "build" first)
  --window 1920x1080  --dpi 2   (sent as reset params "window"/"dpi" for games that support them)
  --attach (wait for an already-running game)  --cmd "<launch command>" (no witness.json needed)
  --json (machine-readable)   --timeout 60

Run 'witness help <command>' for details. Protocol: docs/PROTOCOL.md`;

const CMD_HELP = {
  test: `witness test [files...] [--name <substring>] [--json]
  Test files (default folder: "tests" in ${CONFIG_NAME}, usually witness/) are *.witness.json or *.witness.mjs:
    [{ "name": "coin pickup", "seed": 1, "input": "right@0-1.5",
       "steps": [ { "at": 2, "expect": ["state.score == 1", "count('Coin') == 4"] },
                  { "at": 2.5, "call": ["teleport", 10, 20], "expect": "state.player.pos[0] == 10", "shot": "after.png" } ] }]
  Expressions are JavaScript over the snapshot: state.*, count(type), first(type), all(type), near(pos, type),
  dist(a, b), len(x), approx(a, b), frame, time, prev. Each step runs: call → input → expect → probe → shot → match.
  "match": "label" — the first capture of a label (state, digest, screenshot, audio) is the reference; every later
  capture of that label in this run must be identical (e.g. the same fight run twice, or a plain start after other tests).
  --repeat N   run the whole selection N times in one game process; every step must equal the same step of pass 1
               (state, digest, screenshot and audio): the strongest determinism check. --no-shots / --no-audio skip those.`,
  eval: `witness eval [--at 0.5,2] "expr" ["expr2" ...] [--keys] [--input ...] [--json]
  --keys lists every path in the snapshot (start here to learn what the game exposes).`,
  trace: `witness trace --watch "state.player.pos[1], state.score" [--time 5] [--every 0.05] [--out chart.png]
  Prints start/end/min/max per series and a table, and writes a chart PNG (view it with your image tool).`,
  shot: `witness shot [--at 1,4] [--out shots/s.png] [--diff ref.png] [--scale 0.5]`,
  listen: `witness listen [--time 8] [--input ...] [--out dir] [--wav]
  Captures the game's audio (adapter 'audio' capability) and prints an analysis: sounds found (pitch, length,
  brightness, loudness), music tempo/key/chords, mix problems; writes timeline.png + sounds.png (+ mix.wav).`,
  replay: `witness replay [file.jsonl | last] [--at 5,10] [--shot] [--watch "expr, ..."]
  Replays are recorded when a human plays with WITNESS_RECORD=<file.jsonl> set (F8 adds a marker). The header's seed,
  scene and params go to reset. If <file.jsonl>.state.json exists (the state the recording ended in), the replay's
  final state is compared to it field by field.`,
  init: `witness init [--lang <id>] [--force]   (ids: witness adapters)`,
  measure: `witness measure <what> ...   exact pixel measurements (no eyeballing); add --json for machine output
  scale <shot.png> [--k 3] [--region x,y,w,h] [--tolerance 0]
      integer-scale test: is every k×k cell one colour? Finds k and the grid offset; reports blur/fractional scaling.
  box <with.png> <without.png> [--threshold 16]
      the pixels that differ between a shot with something and one without it: its exact box, height, centroid.
  contrast <shot.png> --a <mask> --b <mask>
      WCAG ratio and ΔE between two pixel sets. A mask is x,y,w,h | #rrggbb[~tolerance] | diff:<without.png>,
      and --b may be ring[:radius] (the pixels just outside --a, e.g. outline vs the ground around it).
  motion [frame.png ...]  |  motion --at 1 --time 0.5 [--input ...] [--region x,y,w,h]
      per-frame box/centroid of what moves, step sizes, path length, jitter, and the lowest row's span (foot slide:
      compare its change with the centroid's). Without files it drives the game and screenshots every frame.
      --background first|median|<file.png>  (first: frame 0 must not contain the object; median: it moves its width)`,
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
      if (nxt !== undefined && !nxt.startsWith("--")) { opt[k] = nxt; i++; } else opt[k] = true;
    } else if (a === "-o") opt.out = argv[++i];
    else pos.push(a);
  }
  return { pos, opt };
}
const die = (msg, code = 1) => { console.error(`✖ ${msg}`); process.exit(code); };
const nums = (s, def) => (s === undefined || s === true ? def : String(s).split(",").map(Number));
const fmtT = (t) => `${+(+t).toFixed(2)}s`;

function loadConfig(opt) {
  if (opt.cmd) {
    // ad-hoc launch: the whole command line goes to the shell as one string
    return { cfg: { name: "game", launch: { command: String(opt.cmd), args: [], shell: true }, tests: "witness", seed: 1, timeout: +(opt.timeout || 60), shots: "witness/shots", replays: "witness/replays" }, root: process.cwd() };
  }
  const found = findConfig(opt.config ? path.resolve(opt.config) : process.cwd());
  if (!found) die(`no ${CONFIG_NAME} found here or in any parent folder — run 'witness init' (or pass --cmd "<how to start the game>")`);
  return { cfg: found.config, root: found.root };
}
function splitCmd(s) { return (s.match(/"[^"]*"|\S+/g) || []).map((x) => x.replace(/^"|"$/g, "")); }

async function withGame(opt, fn) {
  const { cfg, root } = loadConfig(opt);
  if (opt.build) runBuild(cfg, root, { quiet: !!opt.json });
  let g;
  try {
    g = await openGame(cfg, root, { attach: !!opt.attach, port: opt.port ? +opt.port : undefined, timeout: opt.timeout ? +opt.timeout : undefined, quiet: !!opt.json });
  } catch (e) {
    die(e.message);
  }
  try {
    return await fn(g.session, cfg, root, g);
  } catch (e) {
    if (e instanceof WitnessError || e instanceof ExprError) {
      const tail = g.output().trim().split("\n").slice(-15).join("\n");
      die(`${e.message}${tail ? `\n--- last game output ---\n${tail}` : ""}`);
    }
    throw e;
  } finally {
    await g.stop();
  }
}

function runOpts(opt, cfg) {
  let params = opt.params && opt.params !== true ? JSON.parse(opt.params) : undefined;
  // reserved params (docs/PROTOCOL.md): window size and pixel density for games that can vary them per run
  if (opt.window && opt.window !== true) {
    const m = /^(\d+)[x×,](\d+)$/.exec(String(opt.window));
    if (!m) die(`--window wants WIDTHxHEIGHT, e.g. 1920x1080 (got ${opt.window})`);
    params = { ...params, window: [+m[1], +m[2]] };
  }
  if (opt.dpi && opt.dpi !== true) params = { ...params, dpi: +opt.dpi };
  return {
    seed: opt.seed !== undefined ? +opt.seed : cfg.seed ?? 1,
    scene: opt.scene && opt.scene !== true ? String(opt.scene) : undefined,
    params,
    input: opt.input && opt.input !== true ? String(opt.input) : undefined,
  };
}

async function media() {
  try { return await import("../src/media/index.js"); }
  catch (e) { die(`the media module isn't available (${e.message})`); }
}

async function writeShot(shot, file, scale) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (shot.path) { fs.copyFileSync(path.resolve(shot.path), file); return file; }
  const buf = Buffer.from(shot.data, "base64");
  if (shot.format === "png") { fs.writeFileSync(file, buf); return file; }
  const m = await media();
  fs.writeFileSync(file, m.encodePNG(shot.width, shot.height, new Uint8Array(buf.buffer, buf.byteOffset, buf.length)));
  return file;
}

let JSON_MODE = false;   // with --json, human-readable extras go to stderr so stdout stays valid JSON
function printLogs(logs) {
  const say = JSON_MODE ? console.error : console.log;
  const errs = logs.filter((l) => l.level === "error"), other = logs.filter((l) => l.level !== "error");
  for (const l of errs) say(`✖ game error${l.frame != null ? ` (frame ${l.frame})` : ""}: ${l.message}`);
  if (other.length) {
    say(`— game log (${other.length > 30 ? `last 30 of ${other.length}` : other.length}) —`);
    for (const l of other.slice(-30)) say(`  ${l.frame != null ? `[f${l.frame}] ` : ""}${l.level === "warn" ? "⚠ " : ""}${l.message}`);
  }
  return errs.length;
}

function summarizeState(snap) {
  const s = snap.state || {};
  const ents = Array.isArray(s.entities) ? s.entities : [];
  const counts = {};
  for (const e of ents) { const t = e.type ?? e.kind ?? "?"; counts[t] = (counts[t] || 0) + 1; }
  const top = Object.entries(s).filter(([k, v]) => k !== "entities" && (v === null || typeof v !== "object")).map(([k, v]) => `${k}=${fmt(v, 30)}`);
  const lines = [`— frame ${snap.frame}  t=${fmtT(snap.time ?? 0)}${ents.length ? `  [${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(", ")}]` : ""}`];
  if (top.length) lines.push(`   ${top.slice(0, 14).join("  ")}`);
  for (const e of ents.filter((e) => (counts[e.type ?? e.kind ?? "?"] || 0) <= 3).slice(0, 12)) {
    const extra = Object.entries(e).filter(([k]) => !["id", "type", "kind", "pos"].includes(k)).map(([k, v]) => `${k}=${fmt(v, 24)}`).join(" ");
    lines.push(`   #${e.id ?? "?"} ${e.type ?? e.kind ?? "?"}${e.pos ? ` pos=${fmt(e.pos.map ? e.pos.map((x) => +(+x).toFixed(2)) : e.pos, 40)}` : ""} ${extra}`);
  }
  return lines.join("\n");
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

  async test(pos, opt) {
    const { cfg, root } = loadConfig(opt);
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

  async eval(pos, opt) {
    const exprs = pos;
    const times = nums(opt.at, [opt.time ? +opt.time : 0.5]);
    const out = [];
    await withGame(opt, async (s, cfg) => {
      const st = await begin(s, runOpts(opt, cfg));
      for (const t of [...times].sort((a, b) => a - b)) {
        await stepTo(s, st, frameAt(t, s.fps));
        const snap = await s.snapshot();
        if (opt.keys || !exprs.length) {
          console.log(`— snapshot paths at t=${fmtT(t)} (use these in expressions) —`);
          for (const k of keyPaths(snap.state || {})) console.log(`  ${k}`);
          if (!exprs.length) continue;
        }
        const row = { t, values: {} };
        for (const x of exprs) {
          let v;
          try { v = evaluate(x, snap); } catch (e) { v = { error: e.message }; }
          row.values[x] = v;
        }
        out.push(row);
        if (!opt.json) {
          console.log(`— t=${fmtT(t)} (frame ${snap.frame})`);
          for (const x of exprs) { const v = row.values[x]; console.log(`   ${x}  =  ${v && v.error ? `✖ ${v.error}` : fmt(v, 200)}`); }
        }
      }
      const errs = printLogs(await s.drainLogs());
      if (errs && !opt.json) console.log("(the game logged errors — values may be affected)");
    });
    if (opt.json) console.log(JSON.stringify(out, null, 1));
  },

  async trace(pos, opt) {
    if (!opt.watch || opt.watch === true) die('usage: witness trace --watch "state.player.pos[1], state.score" [--time 5]');
    const exprs = splitTop(String(opt.watch));
    const time = +(opt.time || 5);
    const every = Math.max(1 / 240, +(opt.every || Math.max(time / 120, 1 / 60)));
    const series = exprs.map(() => []);
    let replay = null;
    await withGame(opt, async (s, cfg, root) => {
      if (opt.replay) replay = loadReplay(resolveReplay(opt.replay, cfg, root));
      const st = await begin(s, { ...runOpts(opt, cfg), replay });
      for (let t = 0; t <= time + 1e-9; t += every) {
        await stepTo(s, st, frameAt(t, s.fps, st.dts), st.dts);
        const snap = await s.snapshot();
        exprs.forEach((x, i) => { let v; try { v = evaluate(x, snap); } catch (e) { v = null; } series[i].push([+t.toFixed(4), v]); });
      }
      printLogs(await s.drainLogs());
      const outFile = path.resolve(opt.out || path.join(root, cfg.shots, "trace.png"));
      const chartSeries = [];
      exprs.forEach((x, i) => {
        const sample = series[i].find((p) => p[1] != null)?.[1];
        if (Array.isArray(sample)) ["x", "y", "z", "w"].slice(0, sample.length).forEach((ax, k) => chartSeries.push({ label: `${x}.${ax}`, points: series[i].filter((p) => Array.isArray(p[1])).map((p) => [p[0], +p[1][k]]) }));
        else chartSeries.push({ label: x, points: series[i].map((p) => [p[0], typeof p[1] === "boolean" ? +p[1] : p[1]]).filter((p) => typeof p[1] === "number") });
      });
      try {
        const m = await media();
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, m.lineChart({ title: `${s.hello.name}: ${exprs.join(", ")}`, series: chartSeries, markers: replay ? replay.marks : undefined }));
        if (!opt.json) console.log(`chart → ${outFile}  (view it with your image tool)`);
      } catch (e) { if (!opt.json) console.log(`(no chart: ${e.message})`); }
    });
    if (opt.json) { console.log(JSON.stringify(Object.fromEntries(exprs.map((x, i) => [x, series[i]])), null, 1)); return; }
    exprs.forEach((x, i) => {
      const pts = series[i], numsOnly = pts.filter((p) => typeof p[1] === "number");
      if (numsOnly.length === pts.length && pts.length) {
        let lo = numsOnly[0], hi = numsOnly[0];
        for (const p of numsOnly) { if (p[1] < lo[1]) lo = p; if (p[1] > hi[1]) hi = p; }
        console.log(`  ${x}: start ${fmt(pts[0][1])} → end ${fmt(pts[pts.length - 1][1])} · min ${fmt(lo[1])} @${fmtT(lo[0])} · max ${fmt(hi[1])} @${fmtT(hi[0])}`);
      } else {
        const changes = pts.filter((p, k) => k === 0 || JSON.stringify(p[1]) !== JSON.stringify(pts[k - 1][1]));
        console.log(`  ${x}: ${changes.length} distinct value(s)`);
        for (const p of changes.slice(0, 10)) console.log(`     @${fmtT(p[0])}  ${fmt(p[1], 60)}`);
      }
    });
  },

  async shot(pos, opt) {
    const times = nums(opt.at, [opt.time ? +opt.time : 1]);
    await withGame(opt, async (s, cfg, root) => {
      if (!s.has("screenshot")) die("this game's adapter doesn't support 'screenshot'");
      const st = await begin(s, runOpts(opt, cfg));
      for (const t of [...times].sort((a, b) => a - b)) {
        await stepTo(s, st, frameAt(t, s.fps));
        let file = path.resolve(opt.out || path.join(root, cfg.shots, times.length > 1 ? "shot-{t}.png" : "shot.png"));
        if (times.length > 1 && !file.includes("{t}")) file = file.replace(/\.png$/i, "-{t}.png");
        file = file.replace("{t}", String(t).replace(".", "_"));
        await writeShot(await s.screenshot(opt.scale ? +opt.scale : undefined), file);
        console.log(`✔ t=${fmtT(t)} → ${file}`);
        if (opt.diff) {
          const m = await media();
          const d = m.diffImages(fs.readFileSync(path.resolve(opt.diff)), fs.readFileSync(file), { threshold: +(opt.threshold || 16) });
          const dfile = file.replace(/\.png$/i, "-diff.png");
          fs.writeFileSync(dfile, d.png);
          console.log(`  diff vs ${opt.diff}: ${(+d.changedPercent).toFixed(2)}% changed${d.boxes.length ? ` in ${d.boxes.length} region(s)` : ""} → ${dfile}`);
        }
      }
      printLogs(await s.drainLogs());
    });
  },

  async listen(pos, opt) {
    const time = +(opt.time || 5);
    await withGame(opt, async (s, cfg, root) => {
      if (!s.has("audio")) die("this game's adapter doesn't support 'audio' (the mixer must write into a capture buffer in witness mode)");
      const st = await begin(s, runOpts(opt, cfg));
      await s.audio(); // discard anything mixed during reset
      const replies = [];
      for (let t = 0; t < time - 1e-9;) {
        t = Math.min(time, t + 1);
        await stepTo(s, st, frameAt(t, s.fps));
        const a = await s.audio();
        if (a.data) replies.push({ sampleRate: a.sampleRate, channels: a.channels || 1, format: a.format || "f32", data: a.data });
      }
      printLogs(await s.drainLogs());
      const m = await media();
      if (!replies.length) die("the game returned no audio samples");
      const pcm = m.concatPCM(replies);
      const outDir = path.resolve(opt.out || path.join(root, cfg.shots, "listen"));
      if (!replies.length) die("the game returned no audio samples");
      const rep = m.analyzePCM(pcm, { title: `${s.hello.name} — ${time}s` });
      if (opt.json) { console.log(JSON.stringify(rep.report ?? rep, null, 1)); }
      else console.log(rep.text ?? JSON.stringify(rep, null, 1));
      fs.mkdirSync(outDir, { recursive: true });
      try {
        fs.writeFileSync(path.join(outDir, "timeline.png"), m.timelinePNG(null, { analysis: rep, title: s.hello.name }));
        if (rep.segments && rep.segments.length) fs.writeFileSync(path.join(outDir, "sounds.png"), m.soundSheetPNG(rep.segments, { title: s.hello.name }));
        if (opt.wav) fs.writeFileSync(path.join(outDir, "mix.wav"), m.pcmToWav(pcm));
        if (!opt.json) console.log(`wrote ${path.join(outDir, "timeline.png")}${rep.segments && rep.segments.length ? ", sounds.png" : ""}${opt.wav ? ", mix.wav" : ""}  (view the PNGs with your image tool)`);
      } catch (e) { if (!opt.json) console.log(`(no pictures: ${e.message})`); }
    });
  },

  async measure(pos, opt) {
    const m = await media();
    const what = pos[0], files = pos.slice(1);
    const read = (f) => { const p = path.resolve(String(f)); if (!fs.existsSync(p)) die(`no such image: ${f}`); return fs.readFileSync(p); };
    const rect = (s) => { const v = String(s).split(",").map(Number); if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) die(`a region is x,y,w,h (got ${s})`); return { x: v[0], y: v[1], w: v[2], h: v[3] }; };
    const region = opt.region && opt.region !== true ? rect(opt.region) : undefined;
    const out = (obj, lines) => { if (opt.json) console.log(JSON.stringify(obj, (k, v) => (v instanceof Uint8Array ? undefined : v), 1)); else console.log(lines.filter(Boolean).join("\n")); };
    const box = (b) => (b ? `x=${b.x} y=${b.y} ${b.w}×${b.h}` : "none");
    if (what === "scale") {
      if (!files[0]) die("usage: witness measure scale <shot.png> [--k 3]");
      const img = m.decodePNG(read(files[0]));
      const k = opt.k && opt.k !== true ? +opt.k : m.detectScale(img, { region, tolerance: +(opt.tolerance || 0) });
      const r = m.blockScale(img, k, { region, tolerance: +(opt.tolerance || 0) });
      out(r, [`${files[0]}: ${img.width}×${img.height}, ${opt.k ? "checked" : "detected"} scale ×${r.k}, grid offset [${r.offset}]`,
        `  ${r.cells} cells, ${r.nonUniform} not one colour (${r.nonUniformPercent}%) → ${r.blurry ? "✖ BLURRY or fractionally scaled" : r.k > 1 ? "✔ exact integer scaling" : "no pixel grid larger than 1"}`,
        ...r.worst.slice(0, 5).map((c) => `  worst cell ${box(c)}: ${c.colors} colours, spread ${c.spread}`)]);
    } else if (what === "box") {
      if (files.length < 2) die("usage: witness measure box <with.png> <without.png>");
      const r = m.maskDiff(read(files[0]), read(files[1]), { threshold: +(opt.threshold || 16), region });
      out({ count: r.count, bbox: r.bbox, centroid: r.centroid }, [r.count ? `✔ ${r.count} px differ: box ${box(r.bbox)} (height ${r.bbox.h} px, width ${r.bbox.w} px), centroid [${r.centroid}]` : "the two images are the same (nothing to measure)"]);
    } else if (what === "contrast") {
      if (!files[0] || !opt.a || !opt.b) die("usage: witness measure contrast <shot.png> --a <mask> --b <mask|ring[:r]>");
      const img = m.decodePNG(read(files[0]));
      const mask = (spec) => {
        const s = String(spec);
        if (s.startsWith("#") || s.startsWith("rgb")) { const [c, tol] = s.split("~"); return m.maskFromColor(img, c, +(tol || 0)); }
        if (s.startsWith("diff:")) return m.maskDiff(img, read(s.slice(5)), { threshold: +(opt.threshold || 16) }).mask;
        return m.maskFromRect(img.width, img.height, rect(s));
      };
      const A = mask(opt.a);
      const B = /^ring(:\d+)?$/.test(String(opt.b)) ? m.ringMask(A, img.width, img.height, +(String(opt.b).split(":")[1] || 2)) : mask(opt.b);
      const r = m.contrast(img, A, B);
      out(r, [`contrast ${r.ratio.toFixed(2)}:1 (WCAG: 3 for large shapes, 4.5 for text) · ΔE ${r.deltaE.toFixed(1)} · luminance ${r.lumA.toFixed(3)} vs ${r.lumB.toFixed(3)} · ${r.countA} vs ${r.countB} px`]);
    } else if (what === "motion") {
      const bg = opt.background && opt.background !== true ? String(opt.background) : "first";
      const background = bg === "first" || bg === "median" ? bg : read(bg);
      let frames = files.map(read);
      let t0 = 0, dt = 0;
      if (!frames.length) {
        const at = +(opt.at || 0), time = +(opt.time || 0.5);
        await withGame(opt, async (s, cfg) => {
          if (!s.has("screenshot")) die("this game's adapter doesn't support 'screenshot'");
          const st = await begin(s, runOpts(opt, cfg));
          const f0 = frameAt(at, s.fps), f1 = frameAt(at + time, s.fps);
          if (f1 - f0 > 600) die("motion captures every frame: keep --time under 10 s");
          for (let f = f0; f <= f1; f++) {
            await stepTo(s, st, f);
            const sh = await s.screenshot();
            if (sh.format !== "rgba8") die("measure motion needs rgba8 screenshots from the game");
            frames.push({ width: sh.width, height: sh.height, data: new Uint8Array(Buffer.from(sh.data, "base64")) });
          }
          t0 = at; dt = 1 / s.fps;
          printLogs(await s.drainLogs());
        });
      }
      if (frames.length < 2) die("motion needs at least 2 frames");
      const r = m.motion(frames, { region, threshold: +(opt.threshold || 16), background });
      const sm = r.summary;
      out(r, [bg === "first" && r.frames[1] && r.frames[0].count === 0 && r.frames[1].count > 0 ? "note: compared with frame 0; if the object is already visible there, boxes/centroids cover its old and new position (use --background median or a clean <file.png>)" : "",
        `${frames.length} frames${dt ? ` from t=${fmtT(t0)}` : ""}: object in ${sm.framesWithObject}, path ${sm.pathLength} px, net [${sm.net}] (${sm.netDistance} px), step mean ${sm.meanStep} / max ${sm.maxStep}, jitter ${sm.jitter}`,
        ...r.frames.slice(0, 40).map((f, i) => `  #${i}${dt ? ` t=${fmtT(t0 + i * dt)}` : ""}  box ${box(f.bbox)}  centroid ${f.centroid ? `[${f.centroid}]` : "-"}  lowest row ${f.lowestRowSpan ? `y=${f.lowestRowSpan.y} x=${f.lowestRowSpan.x0}..${f.lowestRowSpan.x1}` : "-"}${r.steps[i - 1] ? `  step [${r.steps[i - 1]}]` : ""}`)]);
    } else die("usage: witness measure scale|box|contrast|motion ...  (witness help measure)");
  },

  async replay(pos, opt) {
    await withGame(opt, async (s, cfg, root) => {
      const r = loadReplay(resolveReplay(pos[0] || "last", cfg, root));
      console.log(`▶ replay ${path.basename(r.file)}: ${r.frames} frames, ${fmtT(r.duration)}, seed ${r.seed}${r.marks.length ? `, marks: ${r.marks.map((m) => `${m.label}@${fmtT(m.t)}`).join(" ")}` : ""}`);
      const st = await begin(s, { replay: r });
      const times = opt.at ? nums(opt.at) : [...r.marks.map((m) => m.t), r.duration];
      const endFile = `${r.file}.state.json`;   // written by adapters/games at the end of a recording (optional)
      let endChecked = false;
      for (const t of [...new Set(times)].sort((a, b) => a - b)) {
        await stepTo(s, st, frameAt(t, s.fps, r.dts), r.dts);
        const snap = await s.snapshot();
        if (st.frame >= r.frames && !endChecked && fs.existsSync(endFile)) {
          endChecked = true;
          let want;
          try { want = JSON.parse(fs.readFileSync(endFile, "utf8")); } catch (e) { console.log(`⚠ can't read ${path.basename(endFile)}: ${e.message}`); }
          if (want !== undefined) {
            // the file holds a snapshot ({frame, time, state}) or just the state
            const wantState = want && typeof want === "object" && "state" in want && ("frame" in want || "time" in want) ? want.state : want;
            const d = diffValues(wantState, snap.state, "state", [], 20);
            if (!d.length) console.log(`✔ the replay ended in exactly the recorded end state (${path.basename(endFile)})`);
            else {
              console.log(`✖ the replay's end state differs from the recording's (${path.basename(endFile)}) at ${d.length >= 20 ? "20+" : d.length} path(s):`);
              for (const x of d.slice(0, 12)) console.log(`    ${x.path}: recorded ${String(JSON.stringify(x.a)).slice(0, 80)} → replayed ${String(JSON.stringify(x.b)).slice(0, 80)}`);
              process.exitCode = 1;
            }
          }
        }
        console.log(summarizeState(snap));
        if (opt.watch) for (const x of splitTop(String(opt.watch))) { let v; try { v = fmt(evaluate(x, snap), 120); } catch (e) { v = `✖ ${e.message}`; } console.log(`   ${x} = ${v}`); }
        if (opt.shot && s.has("screenshot")) {
          const file = path.resolve(root, cfg.shots, `replay-${String(t.toFixed(2)).replace(".", "_")}.png`);
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
      await stepTo(s, st, frameAt(+(opt.at || 0.5), s.fps));
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

  help(pos) { console.log(pos[0] && CMD_HELP[pos[0]] ? CMD_HELP[pos[0]] : HELP); },
  version() { console.log(VERSION); },
};

function printTest(res, root) {
  const rel = res.file ? path.relative(root, res.file) : "";
  const ex = res.expects || { passed: 0, failed: 0 };
  console.log(`${res.ok ? "✔ pass" : "✖ FAIL"}  ${res.name}  (${ex.passed} expect${ex.passed === 1 ? "" : "s"} passed${ex.failed ? `, ${ex.failed} failed` : ""})${rel ? `  ${rel}` : ""}`);
  for (const f of res.failures || []) {
    if (f.kind === "warn") console.log(`    ⚠ ${f.message}`);
    else console.log(`    ${f.kind === "expect" ? `expect failed at ${f.at}s:` : "✖"} ${f.message}`);
  }
  for (const [p, vals] of Object.entries(res.probes || {})) console.log(`    probe ${p}: ${vals.map(([t, v]) => `${fmtT(t)}=${fmt(v, 40)}`).join("  ")}`);
}

function splitTop(s) {
  const out = []; let depth = 0, q = null, cur = "";
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; cur += c; continue; }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function resolveReplay(spec, cfg, root) {
  if (spec && spec !== "last" && spec !== true) {
    const f = path.resolve(String(spec));
    if (!fs.existsSync(f)) die(`no such replay: ${spec}`);
    return f;
  }
  const dir = path.resolve(root, cfg.replays);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs) : [];
  if (!files.length) die(`no replays in ${dir} — record one by playing with WITNESS_RECORD=<file.jsonl>`);
  return files[0];
}

const [cmd, ...rest] = process.argv.slice(2);
const { pos, opt } = parseArgs(rest);
JSON_MODE = !!opt.json;
try {
  if (!cmd || cmd === "-h" || cmd === "--help") commands.help([]);
  else if (cmd === "-v" || cmd === "--version") commands.version();
  else if (commands[cmd] && (opt.help || pos[0] === "--help")) commands.help([cmd]);
  else if (commands[cmd]) await commands[cmd](pos, opt);
  else die(`unknown command '${cmd}'\n\n${HELP}`);
} catch (e) {
  if (e instanceof WitnessError || e instanceof ExprError) die(e.message);
  throw e;
}
