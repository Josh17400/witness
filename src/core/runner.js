// Witness core: drive a connected game through a timeline (reset → inputs → steps → checkpoints),
// and run test files.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseWitnessInput } from "./input-spec.js";
import { check, evaluate, fmt, ExprError } from "./expr.js";
import { WitnessError } from "./session.js";

const MAX_CHUNK = 600; // frames per step request (keeps requests short and responsive)

/** Step the session forward to frame `target` (absolute). Uses replay dts when given. */
export async function stepTo(session, state, target, dts = null) {
  while (state.frame < target) {
    const n = Math.min(MAX_CHUNK, target - state.frame);
    let r;
    if (dts) {
      const slice = dts.slice(state.frame, state.frame + n);
      while (slice.length < n) slice.push(1 / session.fps);   // past the end of a replay: fixed dt
      r = await session.step(n, null, slice);
    } else r = await session.step(n);
    state.frame = r.frame ?? state.frame + n;
    state.time = r.time ?? state.frame / session.fps;
  }
}

/** Reset (or rely on a fresh process) and queue inputs. Returns the timeline state. */
export async function begin(session, { seed = 1, scene, params, input, events, replay } = {}) {
  const fps = session.fps;
  if (session.has("reset")) await session.reset(replay ? replay.seed : seed, scene, params);
  const state = { frame: 0, time: 0, dts: replay ? replay.dts : null };
  const evs = [...(events || []), ...parseWitnessInput(input, fps), ...(replay ? replay.events : [])];
  if (evs.length) {
    if (!session.has("input")) throw new WitnessError("this game's adapter doesn't support 'input' (see its hello.capabilities)");
    await session.input(evs.sort((a, b) => a.frame - b.frame));
  }
  return state;
}

/** Load a replay file (docs/PROTOCOL.md §5) into {seed, dts, events, marks, duration}. */
export function loadReplay(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const head = lines.find((l) => l.replay) || {};
  const frames = lines.filter((l) => l.f != null).sort((a, b) => a.f - b.f);
  const dts = [], events = [], markFrames = [];
  const fixed = 1 / (head.fps || 60);
  for (const fr of frames) {
    dts[fr.f] = fr.dt || fixed;
    for (const e of fr.in || []) events.push({ ...e, frame: fr.f });
    if (fr.mark) markFrames.push({ frame: fr.f, label: fr.mark });
  }
  // frames missing from the file (sparse recordings) ran at the fixed dt
  for (let i = 0; i < dts.length; i++) if (dts[i] == null) dts[i] = fixed;
  const startOf = [0];
  for (let i = 0; i < dts.length; i++) startOf[i + 1] = startOf[i] + dts[i];
  const marks = markFrames.map((m) => ({ ...m, t: startOf[m.frame] }));
  return { file, seed: head.seed ?? 1, name: head.name, dts, events, marks, duration: startOf[dts.length], frames: dts.length };
}

/** Frame index for time t, honoring replay dts. */
export function frameAt(t, fps, dts) {
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
 *    steps: [ { at: seconds, call?: [name, ...args] | [[...], ...], input?: "spec", expect?: "expr" | [...],
 *               probe?: "expr" | [...], shot?: "file.png" } ] }
 * Within a step: call → input → expect → probe → shot.
 */
export async function runTest(session, test, { shotDir, onShot } = {}) {
  const fps = session.fps;
  const res = { name: test.name, file: test.file, ok: true, expects: { passed: 0, failed: 0 }, failures: [], probes: {}, shots: [] };
  const state = await begin(session, test);
  let snap = null, prev = null;
  const steps = [...(test.steps || [])].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  if (!steps.length) res.failures.push({ kind: "warn", message: "this test has no steps, so it checks nothing" });
  for (const st of steps) {
    await stepTo(session, state, frameAt(st.at ?? 0, fps, state.dts), state.dts);
    snap = null;
    const getSnap = async () => { if (!snap) { prev = snap; snap = await session.snapshot(); } return snap; };
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
        await session.input(evs);
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
    } catch (e) {
      res.failures.push({ kind: "error", at: st.at, message: `${where}: ${e.message}` });
      if (session.closed) break;
    }
  }
  for (const l of await session.drainLogs()) {
    if (l.level === "error") res.failures.push({ kind: "error", message: `game error${l.frame != null ? ` (frame ${l.frame})` : ""}: ${l.message}` });
  }
  res.ok = !res.failures.some((f) => f.kind === "expect" || f.kind === "error");
  return res;
}

export { fmt };
