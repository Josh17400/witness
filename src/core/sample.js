// Witness core: sample expressions over frames of a run (trace, eval --when, measure curve, listen --events).
import { stepTo } from "./runner.js";
import { evaluate, usesPrev, TimeContext, ExprError } from "./expr.js";
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

/**
 * Step an already begun run through `frames` (ascending, none before the current frame), snapshot each one and
 * evaluate `exprs` there. `prev` for each sample is the previous *frame*: when frames aren't consecutive and an
 * expression needs prev (prev, rose, fell, changed, since), the frame before is fetched as well.
 * onFrame(snap, f, prev) is called after each sample (e.g. to fetch audio or screenshots).
 * Returns { frames, times, values: [per expr: [v per frame]], errors: [per expr: null | { count, f, message }],
 *           missing: [per expr: how many samples were undefined (a misspelt last field)] }.
 */
export async function sampleExprs(session, st, exprs, frames, { dts = null, onFrame = null } = {}) {
  const needPrev = exprs.some(usesPrev);
  const ctx = new TimeContext();
  const values = exprs.map(() => []), errors = exprs.map(() => null), missing = exprs.map(() => 0), times = [];
  let prevSnap = null, prevF = -2;
  for (const f of frames) {
    if (f < st.frame) throw new WitnessError(`can't sample frame ${f}: the run is already at frame ${st.frame}`);
    if (needPrev && f > 0 && prevF !== f - 1 && st.frame <= f - 1) {
      await stepTo(session, st, f - 1, dts);
      prevSnap = await session.snapshot(); prevF = f - 1;
    }
    await stepTo(session, st, f, dts);
    const snap = await session.snapshot();
    const prev = prevF === f - 1 ? prevSnap : null;
    times.push(typeof snap.time === "number" ? snap.time : st.time);
    exprs.forEach((x, i) => {
      let v = null;
      try { v = evaluate(x, snap, prev, ctx); }
      catch (e) {
        if (!(e instanceof ExprError)) throw e;
        // the first sample has no previous frame: a prev-based expression is simply undefined there
        if (!(prev == null && usesPrev(x))) {
          if (!errors[i]) errors[i] = { count: 0, f, message: e.message };
          errors[i].count++;
        }
      }
      if (v === undefined) missing[i]++;
      values[i].push(v === undefined ? null : v);
    });
    if (onFrame) await onFrame(snap, f, prev);
    prevSnap = snap; prevF = f;
  }
  return { frames: [...frames], times, values, errors, missing };
}
