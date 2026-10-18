// Witness media tests: a tiny no-framework harness shared by tests/media/*.mjs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");

let pass = 0, fail = 0;

/** Record a check; on failure print the name and the offending value. */
export function ok(name, cond, extra = "") {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL ${name}${extra !== "" ? `  — ${typeof extra === "string" ? extra : JSON.stringify(extra)}` : ""}`); }
}

/** Print a measured value next to its label (what the module actually heard/saw). */
export const show = (name, value) => console.log(`  ${name.padEnd(36)} ${value}`);

/** Write an artifact into tests/media/out/ and return its path. */
export function save(name, data) {
  fs.mkdirSync(OUT, { recursive: true });
  const p = path.join(OUT, name);
  fs.writeFileSync(p, data);
  return p;
}

/** Print the tally and set the exit code. */
export function done(suite) {
  console.log(`${suite}: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
