// Run every media test: `node tests/media/run.mjs` (exit code 1 if any fails).
// Each suite runs in its own process, one at a time, so a crash in one can't hide the others.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SUITES = ["png.mjs", "apng.mjs", "raster.mjs", "chart.mjs", "plot.mjs", "audio.mjs", "spectrogram.mjs", "diff.mjs", "measure.mjs", "sheet.mjs", "track.mjs", "align.mjs", "color.mjs", "ui.mjs", "anim.mjs"];

let failed = 0;
const t0 = Date.now();
for (const name of SUITES) {
  const start = Date.now();
  const r = spawnSync(process.execPath, [path.join(here, name)], { stdio: "inherit" });
  const secs = ((Date.now() - start) / 1000).toFixed(1);
  if (r.status !== 0) { failed++; console.log(`✗ ${name} failed (exit ${r.status ?? r.signal}) in ${secs} s\n`); }
  else console.log(`✓ ${name} (${secs} s)\n`);
}
console.log(`media: ${SUITES.length - failed}/${SUITES.length} suites passed in ${((Date.now() - t0) / 1000).toFixed(1)} s · pictures in ${path.join(here, "out")}`);
process.exitCode = failed ? 1 : 0;
