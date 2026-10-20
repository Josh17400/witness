// Witness CLI: heatmap — where the player spent time and where they died, over one or many runs.
//   witness heatmap [last | file.jsonl ... | playtests | <folder>] [--pos "state.player.pos"] [--deaths "state.dead"]
//                   [--cell 16] [--every 1f] [--seeds 1,2,3 --input ... --time 10] [--bg map|shot|none] [--out f.png]
// Each run is sampled every frame (or --every); a sample counts the frames until the next one, so cells hold time
// (the last sample, at the end frame, counts none: a run of --time 2.5 holds exactly 2.5 s).
import fs from "node:fs";
import path from "node:path";
import { begin, loadReplay } from "../core/runner.js";
import { sampleExprs, frameGrid } from "../core/sample.js";
import { die, say, withGame, runOpts, media, printLogs, framesOf, fmtT, envelope, emit, resolveReplay, timeList } from "./common.js";
import { eventFrames } from "./ask.js";
import { posOf, autoDeathExpr, mapOf, backgroundFor, deathAt } from "./trace.js";

const tr = (x) => +(+x).toFixed(3);
const MAX_RUNS = 50;

/** The replay files a heatmap's positional arguments name. */
export function heatmapSources(pos, cfg, root) {
  if (!pos.length) return [];
  const out = [];
  const replaysIn = (dir) => {
    const own = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
    const nested = fs.readdirSync(dir).map((f) => path.join(dir, f, "replay.jsonl")).filter((f) => fs.existsSync(f));
    return [...own, ...nested].sort();
  };
  for (const p of pos) {
    if (p === "last") out.push(resolveReplay("last", cfg, root));
    else if (p === "playtests") {
      const dir = path.join(root, "witness", "playtests");
      const found = fs.existsSync(dir) ? replaysIn(dir) : [];
      if (!found.length) die(`no playtest replays in ${dir} — run a playtest first ('witness help play')`);
      out.push(...found);
    } else {
      const f = path.resolve(p);
      if (!fs.existsSync(f)) die(`no such replay or folder: ${p}`);
      if (fs.statSync(f).isDirectory()) { const found = replaysIn(f); if (!found.length) die(`no .jsonl replays in ${p}`); out.push(...found); }
      else out.push(f);
    }
  }
  if (out.length > MAX_RUNS) die(`${out.length} replays is too many for one heatmap (max ${MAX_RUNS}): pass fewer`);
  return [...new Set(out)];
}

const runName = (file, root) => {
  if (!file) return "scripted";
  const base = path.basename(file);
  return base === "replay.jsonl" ? path.basename(path.dirname(file)) : path.relative(root, file).replace(/\\/g, "/");
};

export async function heatmapCommand(pos, opt) {
  const posExpr = opt.pos && opt.pos !== true ? String(opt.pos) : null;
  let res;
  await withGame(opt, async (s, cfg, root) => {
    const fps = s.fps;
    const files = heatmapSources(pos, cfg, root);
    const seeds = !files.length && opt.seeds && opt.seeds !== true ? timeList(opt.seeds, []).map(Number) : null;
    if (seeds && seeds.some((x) => !Number.isFinite(x))) die(`--seeds is a list of numbers (got ${opt.seeds})`);
    const plan = files.length ? files.map((f) => ({ file: f, replay: loadReplay(f) })) : (seeds || [null]).map((seed) => ({ seed }));
    if (plan.length > 1 && !s.has("reset")) die(`heatmap over ${plan.length} ${files.length ? "replays" : "seeds"} runs them one after another in one game process, which needs the adapter's 'reset' (else each starts where the last ended): add 'reset', or run one at a time`);
    const runs = [];
    let lastSnap = null, posUsed = posExpr, deathUsed = opt.deaths && opt.deaths !== true ? String(opt.deaths) : null, deathAuto = false;
    for (const p of plan) {
      const ro = runOpts(opt, cfg);
      const st = await begin(s, { ...ro, seed: p.seed ?? ro.seed, replay: p.replay });
      const first = await s.snapshot();
      if (!posUsed) posUsed = posOf(first.state && first.state.player) ? "state.player" : null;
      if (!posUsed) die("no player position found (state.player.pos or state.player.x/y): pass --pos \"<expression for [x, y]>\"");
      if (!deathUsed && !runs.length) { deathUsed = autoDeathExpr(first.state); deathAuto = !!deathUsed; }
      const endF = p.replay ? (opt.time && opt.time !== true ? Math.min(p.replay.frames, framesOf(String(opt.time), fps, p.replay.dts)) : p.replay.frames) : framesOf(opt.time && opt.time !== true ? String(opt.time) : "5", fps);
      const every = opt.every && opt.every !== true ? Math.max(1, framesOf(String(opt.every), fps)) : 1;
      const frames = frameGrid(0, endF, every);
      const exprs = [posUsed, ...(deathUsed ? [deathUsed] : [])];
      let last = null;
      const sample = await sampleExprs(s, st, exprs, frames, { dts: st.dts, onFrame: (snap) => { last = snap; } });
      printLogs((await s.drainLogs()).filter((l) => l.level === "error"));
      if (sample.errors[0] && sample.errors[0].count === frames.length) die(`--pos ${posUsed}: ${sample.errors[0].message}`);
      const pts = [];
      sample.frames.forEach((f, i) => {
        const q = posOf(sample.values[0][i]);
        const w = (i + 1 < sample.frames.length ? sample.frames[i + 1] : endF) - f;   // frames this sample stands for
        if (q) pts.push([q[0], q[1], w, f]);
      });
      if (!pts.length) die(`--pos ${posUsed} gave ${JSON.stringify(sample.values[0].find((v) => v != null) ?? null)}, not a position [x, y] or {x, y}`);
      // a death's position: at its frame, else the last one seen before it (games often null the player while dead)
      const deaths = deathUsed ? eventFrames([{ name: "death", expr: deathUsed }], { ...sample, values: [sample.values[1]] }).map((d) => deathAt(sample.frames, sample.values[0], d)) : [];
      runs.push({ name: p.file ? runName(p.file, root) : p.seed != null ? `seed ${p.seed}` : "scripted", file: p.file || null, frames: endF, samples: sample.frames.length, pts, deaths });
      lastSnap = last;
    }
    const m = await media();
    const map = mapOf(lastSnap && lastSnap.state);
    const cell = opt.cell && opt.cell !== true ? +opt.cell : map ? map.cell : 0;
    if (opt.cell && !(cell > 0)) die(`--cell wants a positive size in world units (got ${opt.cell})`);
    const origin = map && (!opt.cell || cell === map.cell) ? map.origin : [0, 0];
    const all = runs.flatMap((r) => r.pts);
    const bg = files.length > 1 || seeds ? (map && opt.bg !== "none" && opt.bg !== "shot" ? { map, note: `background: state.map of the last run, ${Math.max(...map.rows.map((r) => r.length))}×${map.rows.length} cells of ${map.cell}` } : { note: "" })
      : await backgroundFor(s, lastSnap, all, opt.bg, runs[0].frames);
    const weighted = all.filter((q) => q[2] > 0).map((q) => [q[0], q[1], q[2]]);
    let grid = m.heatGrid(weighted, { cell, origin });
    // an auto cell over a screenshot is at least 1/64 of the picture (a player who barely moved still shows up)
    if (!cell && bg.image) {
      const span = Math.max(bg.image.x1 - bg.image.x0, bg.image.y1 - bg.image.y0), floor = span / 64;
      if (grid.cell < floor) { let c = 1; while (c < floor) c *= 2; grid = m.heatGrid(weighted, { cell: c, origin }); }
    }
    // open map cells never visited (when the heat cells are the map's cells)
    let unvisited = null;
    if (map && grid.cell === map.cell && grid.ox === map.origin[0] && grid.oy === map.origin[1]) {
      const seen = new Set(grid.cells.map((c) => `${c.ix},${c.iy}`));
      let open = 0, never = 0;
      map.rows.forEach((r, j) => [...r].forEach((ch, i) => { if (map.solid.includes(ch)) return; open++; if (!seen.has(`${i},${j}`)) never++; }));
      unvisited = { open, never };
    }
    res = { fps, runs, grid, map, bg, posUsed, deathUsed, deathAuto, unvisited, m, shots: path.join(root, cfg.shots), name: s.hello.name };
  });
  report(res, opt);
}

function report({ fps, runs, grid, bg, posUsed, deathUsed, deathAuto, unvisited, m, shots, name }, opt) {
  const secs = (frames) => frames / fps;
  const totalFrames = grid.total, samples = runs.reduce((a, r) => a + r.samples, 0);
  const deaths = runs.flatMap((r) => r.deaths.map((d) => ({ ...d, run: r.name })));
  const cellTxt = (c) => `x ${tr(c.x0)}..${tr(c.x1)}, y ${tr(c.y0)}..${tr(c.y1)}`;
  const files = [];
  // the picture
  const out = path.resolve(opt.out && opt.out !== true ? String(opt.out) : path.join(shots, "heatmap.png"));
  if (!opt["no-chart"]) {
    const counts = new Map();
    for (const d of deaths) if (d.pos) { const k = `${tr(d.pos[0])},${tr(d.pos[1])}`; counts.set(k, (counts.get(k) || 0) + 1); }
    const drawn = new Set();
    const markers = deaths.filter((d) => d.pos).filter((d) => { const k = `${tr(d.pos[0])},${tr(d.pos[1])}`; if (drawn.has(k)) return false; drawn.add(k); return true; })
      .map((d) => { const n = counts.get(`${tr(d.pos[0])},${tr(d.pos[1])}`); return { x: d.pos[0], y: d.pos[1], kind: "death", label: n > 1 ? `death ×${n}` : runs.length > 1 ? `death (${d.run} f${d.f})` : `death f${d.f}` }; });
    const spec = {
      title: `${name}: where ${posUsed} spent time`,
      subtitle: `${runs.length} run${runs.length === 1 ? "" : "s"} · ${tr(secs(totalFrames))} s · cell ${tr(grid.cell)}`,
      map: bg.map, image: bg.image, yUp: !!opt["y-up"],
      heat: { grid, label: "s", value: (c) => c / fps, title: "time per cell (sqrt scale)" },
      markers,
      notes: [bg.note, deathUsed ? `deaths: ${deathUsed}${deathAuto ? " (found in the snapshot; --deaths to choose)" : ""} · red ✕` : "no death flag (pass --deaths \"state.dead\")"].filter(Boolean).map((s) => s.replace(" · red ✕", " · red X")),
    };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, m.worldPNG(spec));
    files.push(out);
  }
  const top = grid.cells.slice(0, 5).map((c) => ({ x0: tr(c.x0), y0: tr(c.y0), x1: tr(c.x1), y1: tr(c.y1), seconds: tr(secs(c.count)), frames: c.count, share: tr(c.count / totalFrames) }));
  // deaths grouped by heat cell
  const byCell = new Map();
  for (const d of deaths) {
    if (!d.pos) continue;
    const ix = Math.floor((d.pos[0] - grid.ox) / grid.cell + 1e-9), iy = Math.floor((d.pos[1] - grid.oy) / grid.cell + 1e-9), k = `${ix},${iy}`;
    if (!byCell.has(k)) byCell.set(k, { x0: grid.ox + ix * grid.cell, y0: grid.oy + iy * grid.cell, x1: grid.ox + (ix + 1) * grid.cell, y1: grid.oy + (iy + 1) * grid.cell, list: [] });
    byCell.get(k).list.push(d);
  }
  const deathCells = [...byCell.values()].sort((a, b) => b.list.length - a.list.length || a.y0 - b.y0 || a.x0 - b.x0);
  const lines = [];
  const src = runs.length === 1 ? (runs[0].file ? `the replay ${runs[0].name}` : `one ${runs[0].name} run`) : `${runs.length} runs (${runs.slice(0, 6).map((r) => r.name).join(", ")}${runs.length > 6 ? ", …" : ""})`;
  lines.push(`heatmap ${posUsed} over ${src}: ${samples.toLocaleString("en-US")} samples = ${tr(secs(totalFrames))} s of play · cell ${tr(grid.cell)}${bg.map && grid.cell === bg.map.cell ? " (the map's cells)" : ""} · ${grid.cells.length} cells visited`);
  lines.push(`  most time: ${top.map((c) => `${cellTxt(c)}: ${c.seconds} s (${Math.round(c.share * 100)}%)`).join(" · ")}`);
  if (deathUsed) {
    if (!deaths.length) lines.push(`  deaths (${deathUsed}): none`);
    else {
      const who = (d) => `${runs.length > 1 ? `${d.run} ` : ""}f${d.f}`;
      const noPos = deaths.filter((d) => !d.pos);
      const cellsTxt = deathCells.length ? ` in ${deathCells.length} cell${deathCells.length === 1 ? "" : "s"} — ${deathCells.slice(0, 6).map((c) => `${cellTxt(c)} ×${c.list.length} [${c.list.slice(0, 4).map(who).join(", ")}${c.list.length > 4 ? ", …" : ""}]`).join(" · ")}` : "";
      lines.push(`  deaths (${deathUsed}): ${deaths.length}${cellsTxt}${noPos.length ? `${cellsTxt ? " ·" : ""} ${noPos.length} with no position [${noPos.slice(0, 4).map(who).join(", ")}${noPos.length > 4 ? ", …" : ""}]` : ""}`);
      const exact = deaths.slice(0, 8).map((d) => (d.pos ? `${who(d)} (${tr(d.pos[0])}, ${tr(d.pos[1])})${d.seenAt != null ? ` last seen f${d.seenAt}` : ""}` : `${who(d)} (no position)`));
      lines.push(`    at: ${exact.join(", ")}${deaths.length > 8 ? ", …" : ""}`);
    }
  }
  if (runs.length > 1) lines.push(`  per run: ${runs.map((r) => `${r.name} ${fmtT(secs(r.frames))}${deathUsed ? `, ${r.deaths.length} death${r.deaths.length === 1 ? "" : "s"}` : ""}`).join(" · ")}`);
  if (unvisited) lines.push(`  open map cells never visited: ${unvisited.never} of ${unvisited.open} (${Math.round((100 * unvisited.never) / Math.max(1, unvisited.open))}%)`);
  if (files.length) lines.push(`heatmap → ${files[0]}${bg.short || bg.note ? `  (${bg.short || bg.note})` : ""}`);
  const env = envelope("heatmap", {
    verdict: `${grid.cells.length} cells, ${tr(secs(totalFrames))} s${deathUsed ? `, ${deaths.length} death${deaths.length === 1 ? "" : "s"}` : ""}${top[0] ? `; most time at ${cellTxt(top[0])} (${Math.round(top[0].share * 100)}%)` : ""}`,
    summary: { runs: runs.length, samples, seconds: tr(secs(totalFrames)), cell: grid.cell, cells: grid.cells.length, deaths: deathUsed ? deaths.length : null, deathCells: deathUsed ? deathCells.length : null, hottest: top[0] || null, ...(unvisited ? { openCells: unvisited.open, unvisitedOpen: unvisited.never } : {}) },
    data: {
      pos: posUsed, deathExpr: deathUsed, fps, top,
      cells: grid.cells.map((c) => [tr(c.x0), tr(c.y0), c.count]),
      deaths: deaths.map((d) => ({ run: d.run, f: d.f, t: d.t, pos: d.pos, ...(d.seenAt != null ? { seenAt: d.seenAt } : {}) })),
      runs: runs.map((r) => ({ name: r.name, file: r.file, frames: r.frames, samples: r.samples, deaths: r.deaths.length })),
    },
    files,
  });
  if (!files.length && opt["no-chart"]) say("(no picture: --no-chart)");
  // arrays of plain values (cells, positions, bins) stay on one line each
  emit(env, lines.join("\n"), opt, { json: (e) => console.log(JSON.stringify(e, null, 1).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_, body) => `[${body.split(/,\s+/).join(", ")}]`)) });
}
