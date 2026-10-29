// Witness core: drive a connected game through a timeline (reset → inputs → steps → checkpoints),
// and run test files.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseWitnessInput, splitItems } from "./input-spec.js";
import { check, evaluate, fmt, ExprError, TimeContext, usesPrev, RESERVED_NAMES } from "./expr.js";
import { WitnessError } from "./session.js";
import { parseEpoch, DEFAULT_EPOCH } from "./launch.js";

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
    // adapters may clear their log buffer on reset (python, lua, godot): read it first, or the errors of the run
    // before (a measure step's, a doctor run's) are gone before anyone looks
    await session.pullLogs();
    // a replay restarts exactly as recorded: its seed, and its scene/params when the header has them
    // (and the virtual Date from the epoch it was recorded with, when the header has one: JS adapter games)
    await session.reset(replay ? replay.seed : seed, replay && replay.scene != null ? replay.scene : scene, replay && replay.params != null ? replay.params : params,
      ...(replay && replay.epoch != null ? [replay.epoch] : []));
  }
  const state = { frame: 0, time: 0, dts: replay ? replay.dts : null, calls: replay && replay.calls && replay.calls.length ? replay.calls : null, callIdx: 0 };
  if (state.calls && !session.has("call")) throw new WitnessError("this replay contains game calls (recorded by witness play --allow-calls) but the adapter has no 'call'");
  const evs = [...(events || []), ...parseWitnessInput(input, fps), ...(replay ? replay.events : [])];
  if (evs.length) await queueInput(session, state, evs);
  return state;
}

/**
 * Load a replay file (docs/PROTOCOL.md §5) into {seed, dts, events, marks, duration, warnings}. A bad LAST line is a
 * recording cut short (the game crashed mid-write): it is left out with a warning. A bad line before it is an error
 * naming the file and line. opts.quiet: don't print the warning (it is in .warnings).
 */
export function loadReplay(file, { quiet = false } = {}) {
  const raw = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const lines = [], warnings = [];
  let last = raw.length - 1;
  while (last >= 0 && !raw[last].trim()) last--;
  for (let i = 0; i <= last; i++) {
    if (!raw[i].trim()) continue;
    try { lines.push(JSON.parse(raw[i])); }
    catch (e) {
      if (i < last) throw new WitnessError(`${file}:${i + 1}: not a JSON line (${e.message}): ${raw[i].slice(0, 120)}`);
      warnings.push(`${path.basename(file)}:${i + 1}: the last line is cut short (the recording ended mid-write, e.g. a crash): left out`);
    }
  }
  if (!quiet) for (const w of warnings) console.error(`⚠ ${w}`);
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
  return { file, seed: head.seed ?? 1, epoch: head.epoch ?? null, scene: head.scene ?? null, params: head.params ?? null, name: head.name, launch: head.launch || null, dts, events, marks, calls, duration: startOf[dts.length], frames: dts.length, warnings };
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
 *  { name, seed?, scene?, params?, input?: "spec" | [events], epoch? | now?: ISO date | "today" | ms,
 *    steps: [ { at: seconds | "90f" | after: seconds, call?: [name, ...args] | [[...], ...], input?: "spec",
 *               evalAs?: {name: "page expr"}, expect?: "expr" | [...], expectPage?: "page expr" | [...],
 *               probe?: "expr" | [...], shot?: "file.png", match?: "label" | [...] },
 *             { until?: "expr" | [...], untilPage?: "page expr" | [...], timeout?: seconds (10), every?: frames (1), at? | after?,
 *               call?, input? (before the wait), expect? ... (once it holds) },
 *             { from, to?, within?, always?: "expr" | [...], never?: ..., eventually?: ... },
 *             { measure: { jump | move | hitstop | curve | effect | window: { ...CLI options }, expect: "summary expr" } } ] }
 * Within a point step: call → input → evalAs → expect → expectPage → probe → shot → match. `prev` there is the
 * previous step's snapshot. An input's @t inside a step is relative to the step's frame. Page expressions (expectPage,
 * untilPage, evalAs) run in the game through the protocol's eval (the game's own language: JS for the JS adapter);
 * evalAs values are names the step's and later steps' expressions can read.
 * until steps wait (checking every `every` frames) until all their expressions hold, failing at `timeout`; a test with
 * an until or an "after" step runs its point steps in file order: "after" is seconds after the step before it ran (or
 * the until was met), a step with neither "at" nor "after" runs right after the one before, and "at" stays absolute
 * (an error when an until already waited past it).
 * epoch / now: the virtual Date's start for every reset this test makes, instead of witness.json clock.epoch.
 * Range steps are checked on every frame from `from` to `to` (inclusive), with `prev` = the previous frame:
 * `always` must hold on every frame, `never` on none, `eventually` on at least one (by `from + within` when given).
 * Measure steps run after the timeline, each from its own reset, and check "expect" against the measure's summary.
 * `match`: the first capture of a label (state, digest, and screenshot/audio when the adapter has them) is the
 * reference; every later capture of that label in the same `witness test` run must equal it exactly.
 * `matcher` + `matchAll`: `witness test --repeat N` matches every step against the same step of pass 1.
 */
export async function runTest(session, test, opts = {}) {
  // a per-test Date: every reset of this test (its begin, measure steps, page reloads) sends it, then the run's is back;
  // after a test that set one, a test without one starts at the adapter's own start (hello.epoch: the page's
  // WITNESS_CONFIG.epoch / ?witness_epoch= / WITNESS_EPOCH) or the default epoch, not wherever the last one's Date was
  const own = parseEpoch(test.epoch ?? test.now, `test "${test.name}": "${test.epoch != null ? "epoch" : "now"}"`);
  const run = session.epoch, overridden = session._testEpoch;
  if (own != null && session.has("reset")) session.epoch = session._testEpoch = own;
  else if (own == null && overridden != null && run == null) { const h = session.hello && session.hello.epoch; session.epoch = h != null && Number.isFinite(+h) ? Math.floor(+h) : DEFAULT_EPOCH; }
  try {
    const res = await runTestOn(session, test, opts);
    if (own != null) {
      if (session.has("reset")) res.epoch = own;
      else res.failures.push({ kind: "warn", message: `"${test.epoch != null ? "epoch" : "now"}": the adapter has no 'reset', so a per-test epoch can't be sent: the game's Date starts at witness.json clock.epoch` });
    }
    return res;
  } finally { session.epoch = run; }
}

async function runTestOn(session, test, { shotDir, onShot, matcher, matchAll = false, matchMedia = { shot: true, audio: true } } = {}) {
  const fps = session.fps;
  const res = { name: test.name, file: test.file, ok: true, expects: { passed: 0, failed: 0 }, failures: [], probes: {}, shots: [] };
  const state = await begin(session, test);
  const F = (t) => frameAt(t, fps, state.dts);
  const isRange = (st) => st.always != null || st.never != null || st.eventually != null;
  const all = (test.steps || []).map((st, i) => ({ ...st, _i: i }));
  const measures = all.filter((st) => st.measure != null);
  const isUntil = (st) => st.until != null || st.untilPage != null;
  const Fd = (t) => { const p = parseTime(t); return p.frames != null ? p.frames : Math.round(p.seconds * fps); };   // a duration
  const points = all.filter((st) => !isRange(st) && st.measure == null);
  // an until (or "after") step makes the point steps a sequence in file order: times after it depend on when it held
  const seq = points.some((st) => isUntil(st) || st.after != null);
  const steps = seq ? points.map((st) => ({ ...st, _f: null }))
    : points.map((st) => ({ ...st, _f: F(st.at ?? 0), _at: st.at ?? 0 })).sort((a, b) => a._f - b._f);
  // seq: the step's frame once the one before it ran (frame `cur`)
  const resolve = (i, cur) => {
    const st = steps[i];
    try {
      if (st.at != null && st.after != null) throw new WitnessError(`step ${st._i + 1}: give "at" (seconds from the start) or "after" (seconds after the step before), not both`);
      if (st.at != null) {
        st._f = F(st.at); st._at = st.at;
        if (st._f < cur) {
          const prev = steps[i - 1];
          throw new WitnessError(prev && isUntil(prev) && prev._f0 != null && prev._f0 <= st._f
            ? `step ${st._i + 1} at ${st.at}s: the test is already at ${(cur / fps).toFixed(3)}s (a step before it waited until then): use "after" (seconds after the step before) instead`
            : `step ${st._i + 1} at ${st.at}s: the test is already at ${(cur / fps).toFixed(3)}s: steps run in file order once a test has an until/after step: put step ${st._i + 1} after the steps before it in time (or use "after")`);
        }
      } else { st._f = cur + (st.after != null ? Fd(st.after) : 0); st._at = +(st._f / fps).toFixed(3); }
      st._f0 = st._f;   // where it started (an until's _f moves on while it waits)
    } catch (e) { res.failures.push({ kind: "error", at: st._at, message: e.message }); st._skip = true; st._f = cur; st._at = +(cur / fps).toFixed(3); }
  };
  if (seq && steps.length) resolve(0, state.frame);
  // a page check needs the adapter's eval (the game evaluates it, in its own language)
  const pageKeys = (st) => st.expectPage != null || st.untilPage != null || st.evalAs != null;
  if (steps.some(pageKeys) && !session.has("eval")) {
    res.failures.push({ kind: "error", message: `expectPage / untilPage / evalAs run in the game, through the protocol's 'eval': this game's adapter has none (see its hello.capabilities); check the snapshot with "expect" / "until" instead` });
    res.ok = false;
    return res;
  }
  const vars = {};   // evalAs values, by name: for every expression from that step on
  const hasVars = steps.some((st) => st.evalAs != null);
  // reminders: an expect sharing a step with a call sees the state after it; an input's @t inside a step is relative to it
  const callExpect = steps.filter((st) => st.call && st.expect != null && !isUntil(st)).map((st) => st._i + 1);
  if (callExpect.length) res.failures.push({ kind: "warn", message: `step${callExpect.length > 1 ? "s" : ""} ${callExpect.join(", ")}: "expect" runs after the step's "call" (call → input → expect), so it sees the state after the call; an expect about the state before it belongs in an earlier step` });
  for (const st of steps) {
    if (!st.input || st.at == null) continue;
    const at = F(st.at);
    if (!(at > 0)) continue;
    // each item's start only (a tap's key-up, a hold's release, drag / swipe moves are Witness's own events)
    let starts = [];
    try {
      starts = Array.isArray(st.input) ? parseWitnessInput(st.input, fps).filter((e) => e.down !== false && e.phase !== "up" && e.phase !== "move" && !(e.type === "mouse" && e.down == null)).map((e) => e.frame)
        : splitItems(String(st.input)).map((it) => Math.min(...parseWitnessInput(it, fps).map((e) => e.frame)));
    } catch { continue; }
    const f0 = starts.find((f) => f > 0 && f >= at), late = f0 != null ? { frame: f0 } : null;
    if (late) res.failures.push({ kind: "warn", message: `step ${st._i + 1} (at ${st.at}s): input times inside a step are relative to it, so an item @${+(late.frame / fps).toFixed(3)}s lands at ${+((at + late.frame) / fps).toFixed(3)}s; for ${+(late.frame / fps).toFixed(3)}s from the start write @${+((late.frame - at) / fps).toFixed(3)}` });
  }
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
  const tolNotes = { audio: { n: 0, first: null }, shot: { n: 0, first: null } };
  // hello "audio_exact": false — the adapter can only capture audio in real time, so it isn't compared
  const useAudio = matching && matchMedia.audio && session.has("audio") && session.hello?.audio_exact !== false;
  const useShot = matching && matchMedia.shot && session.has("screenshot");
  if (useShot && session.web && session.web.captureMode && session.web.captureMode !== "canvas") res.failures.push({ kind: "warn", message: `match: screenshots are device pixels here (--capture ${session.web.captureMode}): goldens saved from the game's own pixels (and their regions) won't line up; record and match goldens with the same --capture` });
  // when a point step reads prev (or rose/changed...), every step keeps its snapshot so prev is the previous step
  const pointUsesPrev = steps.some((st) => [].concat(st.expect || [], st.probe || []).some(usesPrev));
  // expressions that read web.* (browser launches: web.audio.state, web.dpr, ...) get the page's facts with each snapshot
  const exprs = [...steps.flatMap((st) => [].concat(st.expect || [], st.probe || [], st.until ?? [])), ...ranges.flatMap((r) => r.asserts.map((a) => a.expr))];
  const usesWeb = exprs.some((e) => /(^|[^\w$.])web\./.test(String(e)));
  if (usesWeb && !session.web) res.failures.push({ kind: "warn", message: "an expression reads web.*, which only browser launches have (launch.url): it is null here" });
  if (usesWeb && session.web && session.web.policy === "gesture") {
    const a = await session.web.audio().catch(() => null);
    if (a && a.contexts.some((c) => c.unlockedBy)) res.failures.push({ kind: "warn", message: "audio was already unlocked when this test began (an unlock lasts for the page's life, as in a browser): run audio-unlock tests on their own (--name)" });
  }
  const snapshot = async () => { const s = await session.snapshot(); if (usesWeb && session.web) s.web = await session.web.state(); if (hasVars) s.__vars = vars; return s; };
  /** A page expression's value (the game evaluates it: protocol 'eval'); its error says what threw. */
  const pageValue = async (js) => {
    try { const r = await session.eval(String(js)); return r ? r.value : undefined; }
    catch (e) { if (e instanceof WitnessError && !session.closed) throw new WitnessError(e.message.replace(/^game error on 'eval': /, "threw: ")); throw e; }
  };
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
    const where = `at ${st._at}s`;
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
      if (st.evalAs != null) {
        if (typeof st.evalAs !== "object" || Array.isArray(st.evalAs)) throw new WitnessError(`"evalAs" wants {"name": "<expression the game evaluates>"}`);
        for (const [k, js] of Object.entries(st.evalAs)) {
          if (!/^[A-Za-z_$][\w$]*$/.test(k) || RESERVED_NAMES.has(k)) throw new WitnessError(`evalAs: ${JSON.stringify(k)} ${RESERVED_NAMES.has(k) ? "is a helper's name already" : "isn't a plain name"}: pick another`);
          try { vars[k] = await pageValue(js); } catch (e) { throw new WitnessError(`evalAs ${k}: page ${js} — ${e.message}`); }
        }
        if (snap) snap.__vars = vars;
      }
      for (const ex of [].concat(st.expect || [])) {
        const s = await getSnap();
        try {
          const r = check(ex, s, prev);
          if (r.ok) res.expects.passed++;
          else { res.expects.failed++; res.failures.push({ kind: "expect", at: st._at, expr: ex, message: `${ex} — ${r.detail}` }); }
        } catch (e) {
          if (!(e instanceof ExprError)) throw e;
          res.expects.failed++;
          res.failures.push({ kind: "expect", at: st._at, expr: ex, message: e.message });
        }
      }
      for (const ex of [].concat(st.expectPage || [])) {
        let v, err = null;
        try { v = await pageValue(ex); } catch (e) { if (!(e instanceof WitnessError) || session.closed) throw e; err = e.message; }
        if (!err && v) res.expects.passed++;
        else { res.expects.failed++; res.failures.push({ kind: "expect", at: st._at, expr: ex, message: `page ${ex} — ${err || `got ${fmt(v)}`}` }); }
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
      if (matching && matchAll && !st._pre) labels.push(`step:${test.file}#${test.index}@${st._i}`);
      if (labels.length) {
        const cap = { snap: await getSnap() };
        if (useShot) cap.shot = await session.screenshot();
        if (useAudio) { const a = await session.audio(); if (a && a.data) cap.audio = a; }
        for (const label of labels) {
          // a --repeat step's reference is needed until the last pass compares it (match: labels may come back later)
          const r = await matcher.check(label, cap, `"${test.name}" ${where}`, { release: label.startsWith("step:") && !!test._lastPass });
          for (const n of r.notes || []) { const k = n.startsWith("audio:") ? "audio" : n.startsWith("screenshot:") ? "shot" : null; if (k) { tolNotes[k].n++; if (!tolNotes[k].first) tolNotes[k].first = `${n} (${where})`; } }
          if (!r.ok) {
            const what = label.startsWith("match:") ? `match "${label.slice(6)}"` : "repeat";
            for (const p of r.problems) res.failures.push({ kind: "match", at: st._at, message: `${what}: ${p}` });
            if (r.shots && onShot && shotDir) {
              const base = path.resolve(shotDir, `mismatch-${String(label.slice(6)).replace(/[^\w.-]+/g, "_").slice(-60)}`);
              try { await onShot(r.shots[0], `${base}-first.png`); await onShot(r.shots[1], `${base}-now.png`); res.shots.push(`${base}-first.png`, `${base}-now.png`); } catch { /* best effort */ }
            }
          }
        }
      }
      if (!snap && pointUsesPrev) snap = await snapshot();
    } catch (e) {
      res.failures.push({ kind: "error", at: st._at, message: `${where}: ${e.message}` });
    }
    if (snap) lastSnap = snap;
  };

  // an until step, checked at the current frame: "met" (then its expects run), "wait" (its _f moved on) or "stop"
  const runUntil = async (st, rangeSnap) => {
    const f = state.frame;
    let u = st._u;
    if (!u) {
      let tf;
      try { tf = Fd(st.timeout ?? 10); } catch (e) { res.failures.push({ kind: "error", at: st._at, message: `step ${st._i + 1}: timeout: ${e.message}` }); return "stop"; }
      u = st._u = { start: f, deadline: f + Math.max(0, tf), every: Math.max(1, Math.floor(+st.every || 1)), prev: null, ctx: new TimeContext(), last: null };
      // call / input first (a tap, then wait for what it starts)
      if (st.call || st.input) { await runPoint({ _i: st._i, _at: st._at, call: st.call, input: st.input, _pre: true }); rangeSnap = null; if (session.closed) return "stop"; }
    }
    const snap = rangeSnap || await snapshot();
    let held = true;
    try {
      for (const ex of [].concat(st.until ?? [])) { const c = check(ex, snap, u.prev, u.ctx); if (!c.ok) { held = false; u.last = `${ex} — ${c.detail}`; break; } }
      if (held) for (const ex of [].concat(st.untilPage ?? [])) { const v = await pageValue(ex); if (!v) { held = false; u.last = `page ${ex} — got ${fmt(v)}`; break; } }
    } catch (e) {
      if (!(e instanceof ExprError || e instanceof WitnessError) || session.closed) throw e;
      res.expects.failed++;
      res.failures.push({ kind: "expect", at: st._at, message: `until (step ${st._i + 1}): ${e.message}${pi + 1 < steps.length ? "; the point steps after it were skipped" : ""}` });
      return "stop";
    }
    u.prev = snap;
    const what = [...[].concat(st.until ?? []), ...[].concat(st.untilPage ?? []).map((x) => `page ${x}`)].join(" && ");
    if (held) {
      res.expects.passed++;
      st._met = f; res.untils = [...(res.untils || []), { step: st._i + 1, frame: f, t: tAt(snap, f), waited: +((f - u.start) / fps).toFixed(3) }];
      const rest = { ...st, call: undefined, input: undefined, _at: tAt(snap, f) };
      if (["expect", "expectPage", "evalAs", "probe", "shot", "match"].some((k) => st[k] != null) || matchAll) await runPoint(rest, snap);
      else lastSnap = snap;
      return "met";
    }
    if (f >= u.deadline) {
      res.expects.failed++;
      res.failures.push({ kind: "expect", at: st._at, expr: what, message: `until ${what} — not true within ${st.timeout ?? 10}s (frames ${u.start}..${u.deadline}, ${(u.start / fps).toFixed(3)}–${(u.deadline / fps).toFixed(3)}s)${u.last ? `; last ${u.last}` : ""}${pi + 1 < steps.length ? "; the point steps after it were skipped" : ""}` });
      return "stop";
    }
    st._f = Math.min(f + u.every, u.deadline);
    return "wait";
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
        const st = steps[pi];
        if (st._skip) { /* its error is in the failures */ }
        else if (isUntil(st)) {
          const u = await runUntil(st, rangeSnap);
          rangeSnap = null;
          if (u === "wait") break;
          if (u === "stop") { pi = steps.length; break; }
        } else await runPoint(st, rangeSnap);
        pi++;
        if (seq && pi < steps.length) resolve(pi, state.frame);
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
  // screenshots / audio that matched only within the tolerance (--shot-tol / --audio-tol): said once per test, not at every step
  for (const t of [tolNotes.shot, tolNotes.audio]) if (t.n) res.failures.push({ kind: "note", message: `${t.first}${t.n > 1 ? `; ${t.n - 1} more match(es) like it` : ""}` });
  res.ok = !res.failures.some((f) => f.kind === "expect" || f.kind === "error" || f.kind === "match");
  return res;
}

export { fmt };
