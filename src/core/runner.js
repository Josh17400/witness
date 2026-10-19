// Witness core: drive a connected game through a timeline (reset → inputs → steps → checkpoints),
// and run test files.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseWitnessInput } from "./input-spec.js";
import { check, evaluate, fmt, ExprError, TimeContext, usesPrev } from "./expr.js";
import { WitnessError } from "./session.js";

const MAX_CHUNK = 600; // frames per step request (keeps requests short and responsive)

/** Run replay `calls` that are due at the current frame (written by `witness play`; docs/PROTOCOL.md section 5). */
async function runDueCalls(session, state) {
  while (state.calls && state.callIdx < state.calls.length && state.calls[state.callIdx].frame <= state.frame) {
    const c = state.calls[state.callIdx++];
    await session.call(c.name, c.args);
  }
}

/** Real browser input (dom:tap / dom:click / dom:key) that is due at the current frame. */
async function runDueDom(session, state) {
  while (state.dom && state.domIdx < state.dom.length && state.dom[state.domIdx].frame <= state.frame) {
    const e = state.dom[state.domIdx++];
    await session.web.dom(e, session.hello && session.hello.size);
  }
}

/** Queue protocol events with the adapter; dom: events (real browser input) wait in state.dom for their frame. */
export async function queueInput(session, state, evs) {
  const dom = evs.filter((e) => e.type === "dom"), rest = evs.filter((e) => e.type !== "dom");
  if (dom.length) {
    if (!session.web) throw new WitnessError("dom: input is real browser input: it needs a browser launch (launch.url)");
    state.dom = [...(state.dom || []).slice(state.domIdx || 0), ...dom].sort((a, b) => a.frame - b.frame);
    state.domIdx = 0;
  }
  if (rest.length) {
    if (!session.has("input")) throw new WitnessError("this game's adapter doesn't support 'input' (see its hello.capabilities)");
    await session.input(rest.sort((a, b) => a.frame - b.frame));
  }
}

/** Step the session forward to frame `target` (absolute). Uses replay dts when given. */
export async function stepTo(session, state, target, dts = null) {
  await runDueCalls(session, state);
  await runDueDom(session, state);
  while (state.frame < target) {
    let n = Math.min(MAX_CHUNK, target - state.frame);
    if (state.calls && state.callIdx < state.calls.length) n = Math.min(n, Math.max(1, state.calls[state.callIdx].frame - state.frame));
    if (state.dom && state.domIdx < state.dom.length) n = Math.min(n, Math.max(1, state.dom[state.domIdx].frame - state.frame));
    let r;
    if (dts) {
      const slice = dts.slice(state.frame, state.frame + n);
      while (slice.length < n) slice.push(1 / session.fps);   // past the end of a replay: fixed dt
      r = await session.step(n, null, slice);
    } else r = await session.step(n);
    state.frame = r.frame ?? state.frame + n;
    state.time = r.time ?? state.frame / session.fps;
    await runDueCalls(session, state);
    await runDueDom(session, state);
  }
}

/** Reset (or rely on a fresh process) and queue inputs. Returns the timeline state. */
export async function begin(session, { seed = 1, scene, params, input, events, replay } = {}) {
  const fps = session.fps;
  if (session.has("reset")) {
    // a replay restarts exactly as recorded: its seed, and its scene/params when the header has them
    await session.reset(replay ? replay.seed : seed, replay && replay.scene != null ? replay.scene : scene, replay && replay.params != null ? replay.params : params);
  }
  const state = { frame: 0, time: 0, dts: replay ? replay.dts : null, calls: replay && replay.calls && replay.calls.length ? replay.calls : null, callIdx: 0 };
  if (state.calls && !session.has("call")) throw new WitnessError("this replay contains game calls (recorded by witness play --allow-calls) but the adapter has no 'call'");
  const evs = [...(events || []), ...parseWitnessInput(input, fps), ...(replay ? replay.events : [])];
  if (evs.length) await queueInput(session, state, evs);
  return state;
}

/** Load a replay file (docs/PROTOCOL.md §5) into {seed, dts, events, marks, duration}. */
export function loadReplay(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const head = lines.find((l) => l.replay) || {};
  const frames = lines.filter((l) => l.f != null).sort((a, b) => a.f - b.f);
  const dts = [], events = [], markFrames = [], calls = [];
  const fixed = 1 / (head.fps || 60);
  for (const fr of frames) {
    dts[fr.f] = fr.dt || fixed;
    for (const e of fr.in || []) events.push({ ...e, frame: fr.f });
    if (fr.mark) markFrames.push({ frame: fr.f, label: fr.mark });
    for (const c of fr.calls || []) if (Array.isArray(c) && c.length) calls.push({ frame: fr.f, name: String(c[0]), args: c.slice(1) });
  }
  // frames missing from the file (sparse recordings) ran at the fixed dt
  for (let i = 0; i < dts.length; i++) if (dts[i] == null) dts[i] = fixed;
  const startOf = [0];
  for (let i = 0; i < dts.length; i++) startOf[i + 1] = startOf[i] + dts[i];
  const marks = markFrames.map((m) => ({ ...m, t: startOf[m.frame] }));
  return { file, seed: head.seed ?? 1, scene: head.scene ?? null, params: head.params ?? null, name: head.name, dts, events, marks, calls, duration: startOf[dts.length], frames: dts.length };
}

/**
 * A time as given by a user: a number of seconds, or a string "1.5" / "1.5s" (seconds) / "90f" (frames).
 * Returns { frames } or { seconds }. Throws on anything else.
 */
export function parseTime(t) {
  if (typeof t === "number") return { seconds: t };
  const s = String(t).trim();
  let m = /^(-?\d+(?:\.\d+)?)f$/i.exec(s);
  if (m) return { frames: Math.round(+m[1]) };
  m = /^(-?\d+(?:\.\d+)?|-?\.\d+)s?$/i.exec(s);
  if (m) return { seconds: +m[1] };
  throw new WitnessError(`bad time '${t}': use seconds (1.5) or frames (90f)`);
}

/** Seconds for a user time (frames / fps for "90f"). */
export function secondsOf(t, fps) { const p = parseTime(t); return p.frames != null ? p.frames / fps : p.seconds; }

/** Frame index for time t (seconds, or "90f"), honoring replay dts. */
export function frameAt(t, fps, dts) {
  if (typeof t !== "number") { const p = parseTime(t); if (p.frames != null) return p.frames; t = p.seconds; }
  if (!dts) return Math.round(t * fps);
  let acc = 0;
  for (let i = 0; i < dts.length; i++) { if (acc >= t - 1e-9) return i; acc += dts[i]; }
  return dts.length + Math.round((t - acc) * fps);
}

// ------------------------------------------------------------------ tests

/** Find test files: *.witness.json / *.witness.mjs / *.witness.js under the tests folder (or given paths). */
export function findTestFiles(root, cfg, paths = []) {
  const targets = paths.length ? paths.map((p) => path.resolve(p)) : [path.resolve(root, cfg.tests)];
  const out = [];
  const walk = (p, depth = 0) => {
    if (!fs.existsSync(p) || depth > 4) return;
    const st = fs.statSync(p);
    if (st.isFile()) { if (/\.witness\.(json|mjs|js)$/.test(p)) out.push(p); return; }
    for (const e of fs.readdirSync(p)) if (!e.startsWith(".") && e !== "node_modules" && e !== "shots" && e !== "replays") walk(path.join(p, e), depth + 1);
  };
  targets.forEach((t) => walk(t));
  return [...new Set(out)].sort();
}

export async function loadTests(file) {
  let data;
  if (file.endsWith(".json")) data = JSON.parse(fs.readFileSync(file, "utf8"));
  else {
    const mod = await import(pathToFileURL(file).href + `?v=${fs.statSync(file).mtimeMs}`);
    data = typeof mod.default === "function" ? await mod.default() : mod.default ?? mod.tests;
  }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.tests) ? data.tests : [data];
  return list.map((t, i) => ({ file, index: i, name: t.name || `${path.basename(file)} #${i + 1}`, ...t }));
}

/**
 * Run one test on a session. Test shape:
 *  { name, seed?, scene?, params?, input?: "spec" | [events],
 *    steps: [ { at: seconds | "90f", call?: [name, ...args] | [[...], ...], input?: "spec", expect?: "expr" | [...],
 *               probe?: "expr" | [...], shot?: "file.png", match?: "label" | [...] },
 *             { from, to?, within?, always?: "expr" | [...], never?: ..., eventually?: ... },
 *             { measure: { jump | move | hitstop | curve | effect | window: { ...CLI options }, expect: "summary expr" } } ] }
 * Within a point step: call → input → expect → probe → shot → match. `prev` there is the previous step's snapshot.
 * Range steps are checked on every frame from `from` to `to` (inclusive), with `prev` = the previous frame:
 * `always` must hold on every frame, `never` on none, `eventually` on at least one (by `from + within` when given).
 * Measure steps run after the timeline, each from its own reset, and check "expect" against the measure's summary.
 * `match`: the first capture of a label (state, digest, and screenshot/audio when the adapter has them) is the
 * reference; every later capture of that label in the same `witness test` run must equal it exactly.
 * `matcher` + `matchAll`: `witness test --repeat N` matches every step against the same step of pass 1.
 */
export async function runTest(session, test, { shotDir, onShot, matcher, matchAll = false, matchMedia = { shot: true, audio: true } } = {}) {
  const fps = session.fps;
  const res = { name: test.name, file: test.file, ok: true, expects: { passed: 0, failed: 0 }, failures: [], probes: {}, shots: [] };
  const state = await begin(session, test);
  const F = (t) => frameAt(t, fps, state.dts);
  const isRange = (st) => st.always != null || st.never != null || st.eventually != null;
  const all = (test.steps || []).map((st, i) => ({ ...st, _i: i }));
  const measures = all.filter((st) => st.measure != null);
  const steps = all.filter((st) => !isRange(st) && st.measure == null).map((st) => ({ ...st, _f: F(st.at ?? 0) })).sort((a, b) => a._f - b._f);
  const ranges = [];
  for (const st of all.filter(isRange)) {
    const fromF = F(st.from ?? st.at ?? 0);
    const within = st.within != null ? F(st.within) : null;
    const toF = st.to != null ? F(st.to) : within != null ? fromF + within : null;
    if (toF == null) { res.failures.push({ kind: "error", message: `step ${st._i + 1}: a range step needs "to" (or "within")` }); continue; }
    if (toF < fromF) { res.failures.push({ kind: "error", message: `step ${st._i + 1}: "to" is before "from"` }); continue; }
    const asserts = [];
    for (const kind of ["always", "never", "eventually"]) for (const expr of [].concat(st[kind] ?? [])) asserts.push({ kind, expr, done: false, failed: false, met: null, last: null });
    ranges.push({ st, fromF, toF, deadline: within != null ? Math.min(toF, fromF + within) : toF, ctx: new TimeContext(), asserts, label: `${st.from ?? st.at ?? 0}..${st.to ?? `+${st.within}`}` });
  }
  if (!steps.length && !ranges.length && !measures.length) res.failures.push({ kind: "warn", message: "this test has no steps, so it checks nothing" });
  const matching = matcher && (matchAll || steps.some((st) => st.match));
  // hello "audio_exact": false — the adapter can only capture audio in real time, so it isn't compared
  const useAudio = matching && matchMedia.audio && session.has("audio") && session.hello?.audio_exact !== false;
  const useShot = matching && matchMedia.shot && session.has("screenshot");
  // when a point step reads prev (or rose/changed...), every step keeps its snapshot so prev is the previous step
  const pointUsesPrev = steps.some((st) => [].concat(st.expect || [], st.probe || []).some(usesPrev));
  // expressions that read web.* (browser launches: web.audio.state, web.dpr, ...) get the page's facts with each snapshot
  const exprs = [...steps.flatMap((st) => [].concat(st.expect || [], st.probe || [])), ...ranges.flatMap((r) => r.asserts.map((a) => a.expr))];
  const usesWeb = exprs.some((e) => /(^|[^\w$.])web\./.test(String(e)));
  if (usesWeb && !session.web) res.failures.push({ kind: "warn", message: "an expression reads web.*, which only browser launches have (launch.url): it is null here" });
  if (usesWeb && session.web && session.web.policy === "gesture") {
    const a = await session.web.audio().catch(() => null);
    if (a && a.contexts.some((c) => c.unlockedBy)) res.failures.push({ kind: "warn", message: "audio was already unlocked when this test began (an unlock lasts for the page's life, as in a browser): run audio-unlock tests on their own (--name)" });
  }
  const snapshot = async () => { const s = await session.snapshot(); if (usesWeb && session.web) s.web = await session.web.state(); return s; };
  if (useAudio) await session.audio();   // drop anything mixed before this test's reset: audio is compared per test
  let lastSnap = null;      // the snapshot of the previous point step (exposed as `prev` there)
  let frameSnap = null, frameSnapF = -1;   // the previous frame's snapshot inside range windows

  const tAt = (snap, f) => +(snap && snap.time != null ? snap.time : f / fps).toFixed(3);
  const checkRanges = (f, snap, prev) => {
    for (const r of ranges) {
      if (f < r.fromF || f > r.toF) continue;
      for (const a of r.asserts) {
        if (a.done) continue;
        if (a.kind === "eventually" && f > r.deadline) continue;
        let c;
        try { c = check(a.expr, snap, prev, r.ctx); }
        catch (e) {
          if (!(e instanceof ExprError)) throw e;
          a.done = true; a.failed = true;
          res.failures.push({ kind: "expect", at: r.label, expr: a.expr, message: `${a.kind} ${e.message} (frame ${f})` });
          continue;
        }
        a.last = c.detail;
        if (a.kind === "always" && !c.ok) { a.done = true; a.failed = true; res.failures.push({ kind: "expect", at: r.label, expr: a.expr, message: `always ${a.expr} — failed at frame ${f} (t=${tAt(snap, f)}s): ${c.detail}` }); }
        else if (a.kind === "never" && c.ok) { a.done = true; a.failed = true; res.failures.push({ kind: "expect", at: r.label, expr: a.expr, message: `never ${a.expr} — true at frame ${f} (t=${tAt(snap, f)}s): ${c.detail}` }); }
        else if (a.kind === "eventually" && c.ok) { a.done = true; a.met = f; }
      }
    }
  };
  // range windows start one frame early, so the first checked frame has its prev
  const inWindow = (f) => ranges.some((r) => f >= Math.max(0, r.fromF - 1) && f <= r.toF);

  const runPoint = async (st, rangeSnap) => {
    let snap = rangeSnap || null;
    const prev = lastSnap;
    const getSnap = async () => { if (!snap) snap = await snapshot(); return snap; };
    const where = `at ${st.at ?? 0}s`;
    try {
      const calls = st.call ? (Array.isArray(st.call[0]) ? st.call : [st.call]) : [];
      for (const c of calls) {
        if (!session.has("call")) throw new WitnessError("this game's adapter doesn't support 'call'");
        const [name, ...args] = c;
        await session.call(name, args);
        snap = null;
      }
      if (st.input) {
        const evs = parseWitnessInput(st.input, fps).map((e) => ({ ...e, frame: e.frame + state.frame }));
        await queueInput(session, state, evs);
        await runDueDom(session, state);
      }
      for (const ex of [].concat(st.expect || [])) {
        const s = await getSnap();
        try {
          const r = check(ex, s, prev);
          if (r.ok) res.expects.passed++;
          else { res.expects.failed++; res.failures.push({ kind: "expect", at: st.at, expr: ex, message: `${ex} — ${r.detail}` }); }
        } catch (e) {
          if (!(e instanceof ExprError)) throw e;
          res.expects.failed++;
          res.failures.push({ kind: "expect", at: st.at, expr: ex, message: e.message });
        }
      }
      for (const p of [].concat(st.probe || [])) {
        const s = await getSnap();
        let v;
        try { v = evaluate(p, s, prev); } catch (e) { v = `error: ${e.message}`; }
        (res.probes[p] = res.probes[p] || []).push([state.time, v]);
      }
      if (st.shot) {
        if (!session.has("screenshot")) throw new WitnessError("this game's adapter doesn't support 'screenshot'");
        const file = path.resolve(shotDir || ".", st.shot);
        await onShot(await session.screenshot(), file);
        res.shots.push(file);
      }
      const labels = [].concat(st.match || []).map((l) => `match:${l}`);
      if (matching && matchAll) labels.push(`step:${test.file}#${test.index}@${st._i}`);
      if (labels.length) {
        const cap = { snap: await getSnap() };
        if (useShot) cap.shot = await session.screenshot();
        if (useAudio) { const a = await session.audio(); if (a && a.data) cap.audio = a; }
        for (const label of labels) {
          const r = await matcher.check(label, cap, `"${test.name}" ${where}`);
          if (!r.ok) {
            const what = label.startsWith("match:") ? `match "${label.slice(6)}"` : "repeat";
            for (const p of r.problems) res.failures.push({ kind: "match", at: st.at, message: `${what}: ${p}` });
            if (r.shots && onShot && shotDir) {
              const base = path.resolve(shotDir, `mismatch-${String(label.slice(6)).replace(/[^\w.-]+/g, "_").slice(-60)}`);
              try { await onShot(r.shots[0], `${base}-first.png`); await onShot(r.shots[1], `${base}-now.png`); res.shots.push(`${base}-first.png`, `${base}-now.png`); } catch { /* best effort */ }
            }
          }
        }
      }
      if (!snap && pointUsesPrev) snap = await snapshot();
    } catch (e) {
      res.failures.push({ kind: "error", at: st.at, message: `${where}: ${e.message}` });
    }
    if (snap) lastSnap = snap;
  };

  // walk the timeline: every frame inside a range window, plus each point step's frame
  let pi = 0;
  try {
    for (;;) {
      const f = state.frame;
      let rangeSnap = null;
      if (inWindow(f)) {
        rangeSnap = await snapshot();
        checkRanges(f, rangeSnap, frameSnapF === f - 1 ? frameSnap : null);
        frameSnap = rangeSnap; frameSnapF = f;
      }
      while (pi < steps.length && steps[pi]._f <= f) {
        await runPoint(steps[pi++], rangeSnap);
        rangeSnap = null;   // a later point step at the same frame may follow a call: fetch afresh
        if (session.closed) break;
      }
      if (session.closed) break;
      const nextPoint = pi < steps.length ? steps[pi]._f : Infinity;
      const starts = ranges.map((r) => Math.max(0, r.fromF - 1)).filter((x) => x > f);
      const nextRange = inWindow(f + 1) ? f + 1 : starts.length ? Math.min(...starts) : Infinity;
      const next = Math.min(nextPoint, nextRange);
      if (next === Infinity) break;
      await stepTo(session, state, next, state.dts);
    }
  } catch (e) {
    res.failures.push({ kind: "error", message: `at frame ${state.frame}: ${e.message}` });
  }
  // measure steps: each runs its own scenario from reset, after the timeline above
  for (const st of measures) {
    if (session.closed) break;
    try {
      const { runMeasureStep } = await import("../cli/measure-steps.js");
      const m = await runMeasureStep(session, st.measure, test, shotDir);
      (res.measures = res.measures || []).push({ kind: m.kind, verdict: m.env.verdict, summary: m.env.summary });
      if (!m.checks.length) res.failures.push({ kind: "warn", message: `measure ${m.kind}: no "expect", so it checks nothing (${m.env.verdict})` });
      for (const c of m.checks) {
        if (c.ok) res.expects.passed++;
        else { res.expects.failed++; res.failures.push({ kind: "expect", at: `measure ${m.kind}`, expr: c.expr, message: `${c.expr} — ${c.detail}  (${m.env.verdict})` }); }
      }
      if (m.env.ok === false && m.checks.every((c) => c.ok)) { res.expects.failed++; res.failures.push({ kind: "expect", at: `measure ${m.kind}`, message: m.env.verdict }); }
    } catch (e) {
      res.failures.push({ kind: "error", at: "measure", message: `measure step ${st._i + 1}: ${e.message}` });
    }
  }
  for (const r of ranges) {
    for (const a of r.asserts) {
      if (a.kind === "eventually" && a.met == null && !a.done) {
        a.failed = true;
        res.failures.push({ kind: "expect", at: r.label, expr: a.expr, message: `eventually ${a.expr} — never true in frames ${r.fromF}..${r.deadline} (${(r.fromF / fps).toFixed(3)}–${(r.deadline / fps).toFixed(3)}s)${a.last ? `; last ${a.last}` : ""}` });
      }
      if (a.failed) res.expects.failed++; else res.expects.passed++;
    }
  }
  for (const l of await session.drainLogs()) {
    if (l.level === "error") res.failures.push({ kind: "error", message: `game error${l.frame != null ? ` (frame ${l.frame})` : ""}: ${l.message}` });
  }
  res.ok = !res.failures.some((f) => f.kind === "expect" || f.kind === "error" || f.kind === "match");
  return res;
}

export { fmt };
