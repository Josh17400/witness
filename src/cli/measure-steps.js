// Witness: measure steps in test files — a measurement Claude ran once, kept as a regression test.
//   { "measure": { "jump": { "y": "state.player.pos[1]", "input": "space@1" }, "expect": "apexPx between 60 and 70" } }
// The measure runs its own scenario from reset (the test's seed/scene/params unless the measure sets them), with
// the same option names as the CLI; "expect" is checked against the result's summary (like --expect).
import { WitnessError } from "../core/session.js";
import { measureState, STATE_MEASURES } from "./measure.js";
import { computeEffect, reportEffect } from "./effect.js";
import { computeWindow, reportWindow } from "./window.js";
import { checkExpect } from "./common.js";

export const MEASURE_KINDS = [...STATE_MEASURES, "effect", "window"];

/** Run one measure step on an open session. Returns { kind, env, checks: [{ expr, ok, detail }] }. */
export async function runMeasureStep(session, spec, base = {}, shotDir = ".") {
  if (!spec || typeof spec !== "object") throw new WitnessError(`"measure" must be an object like { "jump": { ... }, "expect": "apexPx >= 40" }`);
  const kinds = Object.keys(spec).filter((k) => k !== "expect");
  if (kinds.length !== 1 || !MEASURE_KINDS.includes(kinds[0])) throw new WitnessError(`a measure step names one measure (${MEASURE_KINDS.join(", ")}); got ${kinds.join(", ") || "none"}`);
  const kind = kinds[0], opts = { ...(spec[kind] || {}) };
  for (const k of Object.keys(opts)) if (typeof opts[k] === "number") opts[k] = String(opts[k]);   // CLI-style values
  const ro = { seed: opts.seed != null ? +opts.seed : base.seed ?? 1, scene: opts.scene ?? base.scene, params: opts.params ?? base.params, input: opts.input != null ? String(opts.input) : undefined };
  let out;
  if (STATE_MEASURES.includes(kind)) out = await measureState(session, kind, opts, ro);
  else if (kind === "effect") out = reportEffect(await computeEffect(session, opts, ro, shotDir), { json: true });
  else out = reportWindow(await computeWindow(session, opts, ro), { json: true });
  const checks = [].concat(spec.expect ?? []).map((e) => checkExpect(String(e), out.env));
  return { kind, env: out.env, checks };
}
