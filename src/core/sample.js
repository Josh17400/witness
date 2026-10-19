// Witness core: sample expressions over frames of a run (trace, eval --when, measure curve, listen --events).
import { stepTo } from "./runner.js";
import { evaluate, usesPrev, TimeContext, ExprError, statePaths } from "./expr.js";
import { WitnessError } from "./session.js";

/**
 * The frames to sample: from..to (inclusive) every `every` frames, always including `to`.
 */
export function frameGrid(from, to, every = 1) {
  const out = [];
  const e = Math.max(1, Math.round(every));
  for (let f = from; f <= to; f += e) out.push(f);
  if (out[out.length - 1] !== to) out.push(to);
  return out;
}

/** Deep equality for JSON values (the filter check). */
const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Step an already begun run through `frames` (ascending, none before the current frame), snapshot each one and
 * evaluate `exprs` there. `prev` for each sample is the previous *frame*: when frames aren't consecutive and an
 * expression needs prev (prev, rose, fell, changed, since), the frame before is fetched as well.
 *
 * Speed: snapshots ask only for the top-level state keys the expressions read (the protocol's snapshot "paths"
 * filter, see statePaths), so a big world isn't shipped every frame. The filter is checked against one full
 * snapshot first (an adapter that drops or changes a key turns it off), any sample that errors or comes back
 * undefined is re-checked once against the full state, and the last frame is passed to onFrame in full.
 * filter: false (or the environment variable WITNESS_PATHS=0) turns it off.
 *
 * onFrame(snap, f, prev) is called after each sample (e.g. to fetch audio or screenshots).
 * Returns { frames, times, values: [per expr: [v per frame]], errors: [per expr: null | { count, f, message }],
 *           missing: [per expr: how many samples were undefined (a misspelt last field)], paths: [...] | null }.
 */
export async function sampleExprs(session, st, exprs, frames, { dts = null, onFrame = null, filter = process.env.WITNESS_PATHS !== "0" } = {}) {
  const needPrev = exprs.some(usesPrev);
  const ctx = new TimeContext();
  const values = exprs.map(() => []), errors = exprs.map(() => null), missing = exprs.map(() => 0), times = [];
  let paths = filter ? statePaths(exprs) : null;
  let verified = false;
  const checked = exprs.map(() => false);
  const snapshot = async () => {
    if (!paths) return session.snapshot();
    const part = await session.snapshot(paths);
    if (!verified) {
      verified = true;
      const full = await session.snapshot();
      const fs = full.state || {}, ps = part.state || {};
      // every requested key the game has must come back unchanged, or the filter is off for this run
      if (!paths.every((k) => !(k in fs) || (k in ps && sameJSON(fs[k], ps[k])))) { paths = null; return full; }
    }
    return part;
  };
  let prevSnap = null, prevF = -2;
  const last = frames[frames.length - 1];
  for (const f of frames) {
    if (f < st.frame) throw new WitnessError(`can't sample frame ${f}: the run is already at frame ${st.frame}`);
    if (needPrev && f > 0 && prevF !== f - 1 && st.frame <= f - 1) {
      await stepTo(session, st, f - 1, dts);
      prevSnap = await snapshot(); prevF = f - 1;
    }
    await stepTo(session, st, f, dts);
    let snap = await snapshot();
    const prev = prevF === f - 1 ? prevSnap : null;
    times.push(typeof snap.time === "number" ? snap.time : st.time);
    const evalOne = (x, sn, pv) => {
      try { return { v: evaluate(x, sn, pv, null) }; } catch (e) { if (!(e instanceof ExprError)) throw e; return { e }; }
    };
    for (let i = 0; i < exprs.length; i++) {
      const x = exprs[i];
      let v = null, err = null;
      try { v = evaluate(x, snap, prev, ctx); }
      catch (e) { if (!(e instanceof ExprError)) throw e; err = e; }
      if (paths && !checked[i] && (err || v === undefined) && !(prev == null && usesPrev(x))) {
        // a filtered sample that failed: does the full state say otherwise? (statePaths missed a key)
        checked[i] = true;
        const full = await session.snapshot();
        const a = evalOne(x, full, null), b = evalOne(x, snap, null);
        if (JSON.stringify(a.v) !== JSON.stringify(b.v) || !!a.e !== !!b.e) {
          paths = null; snap = full;
          err = null; v = null;
          try { v = evaluate(x, snap, prev, ctx); } catch (e) { if (!(e instanceof ExprError)) throw e; err = e; }
        }
      }
      if (err) {
        // the first sample has no previous frame: a prev-based expression is simply undefined there
        if (!(prev == null && usesPrev(x))) {
          if (!errors[i]) errors[i] = { count: 0, f, message: err.message };
          errors[i].count++;
        }
        v = null;
      }
      if (v === undefined) missing[i]++;
      values[i].push(v === undefined ? null : v);
    }
    if (onFrame) await onFrame(f === last && paths ? await session.snapshot() : snap, f, prev);
    prevSnap = snap; prevF = f;
  }
  return { frames: [...frames], times, values, errors, missing, paths };
}
