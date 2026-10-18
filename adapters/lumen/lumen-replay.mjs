#!/usr/bin/env node
// Convert a Lumen session recording (`lumen run` writes <game>/.lumen/replays/replay-*.json, F8
// adds markers) into a Witness replay (docs/PROTOCOL.md section 5), so `witness replay` can play
// it back through the Lumen bridge:
//
//   node lumen-replay.mjs <replay-*.json | game folder (newest replay)> [out.jsonl]
//   witness replay out.jsonl --watch "state.globals.score"
//
// Without an output path it writes witness/replays/<same name>.jsonl in the current folder.
import fs from "node:fs";
import path from "node:path";

const die = (msg) => { console.error(`lumen-replay: ${msg}`); process.exit(2); };
const [input, outArg] = process.argv.slice(2);
if (!input) die("usage: node lumen-replay.mjs <replay-*.json | game folder> [out.jsonl]");

let file = path.resolve(input);
if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
  const dir = path.join(file, ".lumen", "replays");
  const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^replay-.*\.json$/.test(f)).sort() : [];
  if (!all.length) die(`no recordings in ${dir} (play the game with 'lumen run' first)`);
  file = path.join(dir, all[all.length - 1]);
}
let rec;
try { rec = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { die(`can't read ${file}: ${e.message}`); }
if (!rec || !Array.isArray(rec.frames)) die(`${file} is not a Lumen recording (no frames)`);

// Lumen tags an input change that arrives between frames with the NEXT frame number (1-based:
// applied during the frame that makes rt.frame == f), i.e. Witness frame f - 1 (0-based).
const byFrame = new Map();
const add = (f, ev) => { if (!byFrame.has(f)) byFrame.set(f, []); byFrame.get(f).push(ev); };
let skipped = 0;
for (const e of rec.events || []) {
  const f = Math.max(0, (e.f | 0) - 1);
  if (e.key != null) add(f, { type: "key", key: String(e.key), down: e.down !== false });
  else if (Array.isArray(e.mouse)) {
    const ev = { type: "mouse", x: e.mouse[0], y: e.mouse[1] };
    if (typeof e.down === "boolean") { ev.button = e.button === 2 ? 2 : 0; ev.down = e.down; }
    add(f, ev);
  } else if (typeof e.px === "number" || typeof e.wheel === "number") add(f, { type: "wheel", dy: typeof e.px === "number" ? e.px : e.wheel * 100 });
  else skipped++;
}
const marks = new Map((rec.markers || []).map((m) => [Math.max(0, (m.f | 0) - 1), m.label || "F8"]));

const fps = 60;
const lines = [JSON.stringify({ replay: 1, name: path.basename(rec.main || "game.lum", ".lum"), seed: rec.seed ?? 1, fps, started: rec.startedAt ? new Date(rec.startedAt).toISOString() : new Date().toISOString(), source: "lumen" })];
rec.frames.forEach((dt, f) => {
  const line = { f, dt };
  if (byFrame.has(f)) line.in = byFrame.get(f);
  if (marks.has(f)) line.mark = marks.get(f);
  lines.push(JSON.stringify(line));
});

const out = path.resolve(outArg || path.join("witness", "replays", path.basename(file, ".json") + ".jsonl"));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join("\n") + "\n");
console.log(`${out}: ${rec.frames.length} frames, ${(rec.events || []).length - skipped} input events, seed ${rec.seed ?? 1}${marks.size ? `, ${marks.size} marker(s)` : ""}`);
if (skipped) console.error(`lumen-replay: ${skipped} event(s) of unknown shape were skipped`);
if (rec.noiseSeed != null && rec.noiseSeed !== rec.seed) console.error(`lumen-replay: note: the recording used noise seed ${rec.noiseSeed}; Witness boots with noise seed = seed (${rec.seed}), so gameplay driven by noise() may drift (rand() is exact)`);
if (rec.storage && Object.keys(rec.storage).length) console.error("lumen-replay: note: the recording started with saved data (load()); the bridge boots with empty storage");
