// Witness CLI: ab — the same scenario twice with one difference, compared at the same moments.
//   witness ab --input "right@0-3" --a LIFT=0 --b LIFT=1 --at 3.2,4 [--rect x,y,w,h] [--from 3 --to 4 --every 0.1] [--state]
// A variant is "KEY=VALUE" items separated by ";": params={...} (merged into reset params), scene=..., seed=N,
// input=... (added to --input), cmd=... (a different launch command); any other KEY=VALUE is an environment variable
// for the game process. Variants that differ only in params/scene/seed/input share one game process.
import fs from "node:fs";
import path from "node:path";
import { begin, stepTo } from "../core/runner.js";
import { diffStates } from "../core/compare.js";
import { fmt } from "../core/expr.js";
import { parseRect } from "./see.js";
import { die, withGame, runOpts, media, printLogs, timeList, framesOf, fmtT, shotImage, envelope, emit } from "./common.js";

const RESERVED = new Set(["params", "scene", "seed", "input", "cmd", "replay"]);

/** "LIFT=1; params={\"rig\":2}; input=j@1" -> { env, params, scene, seed, input, cmd, label } */
export function parseVariant(spec, name) {
  const v = { env: {}, params: null, scene: undefined, seed: undefined, input: "", cmd: undefined, replay: undefined, label: spec ? String(spec) : "(baseline)" };
  if (!spec || spec === true) return v;
  let items = String(spec).split(";").map((x) => x.trim()).filter(Boolean);
  // "A=1 B=2" (spaces between plain env assignments) works too
  if (items.length === 1 && /^\w+=\S*(\s+\w+=\S*)+$/.test(items[0]) && !RESERVED.has(items[0].split("=")[0])) items = items[0].split(/\s+/);
  for (const it of items) {
    const m = /^([A-Za-z_][\w.-]*)\s*=\s*([\s\S]*)$/.exec(it);
    if (!m) die(`--${name}: "${it}" isn't KEY=VALUE (e.g. LIFT=1, params={"rig":2}, scene=boss, seed=3, input=j@1, cmd=...)`);
    const [, k, val] = m;
    if (k === "params") { try { v.params = { ...(v.params || {}), ...JSON.parse(val) }; } catch (e) { die(`--${name} params: ${e.message}`); } }
    else if (k === "scene") v.scene = val;
    else if (k === "seed") v.seed = +val;
    else if (k === "input") v.input = val;
    else if (k === "cmd") v.cmd = val;
    else if (k === "replay") v.replay = val;   // trace --compare only: run a recording instead
    else v.env[k] = val;
  }
  return v;
}

const luma = (d, o) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];

/** Pixel facts of a rect in A vs B: changed pixels, mean luma and colour (whole rect and changed pixels), bbox. */
export function compareRect(A, B, R, threshold = 16) {
  let n = 0, changed = 0, sa = 0, sb = 0, ca = [0, 0, 0], cb = [0, 0, 0], dl = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, absL = 0;
  for (let y = R.y; y < R.y + R.h; y++) for (let x = R.x; x < R.x + R.w; x++) {
    if (x < 0 || y < 0 || x >= A.width || y >= A.height) continue;
    const o = (y * A.width + x) * 4;
    const la = luma(A.data, o), lb = luma(B.data, o);
    n++; sa += la; sb += lb; absL += Math.abs(lb - la);
    for (let c = 0; c < 3; c++) { ca[c] += A.data[o + c]; cb[c] += B.data[o + c]; }
    const d = Math.max(Math.abs(A.data[o] - B.data[o]), Math.abs(A.data[o + 1] - B.data[o + 1]), Math.abs(A.data[o + 2] - B.data[o + 2]));
    if (d > threshold) { changed++; dl += lb - la; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    pixels: n, changed, percent: n ? Math.round((changed / n) * 1e6) / 1e4 : 0,
    lumaA: r2(sa / n), lumaB: r2(sb / n), lumaDelta: r2((sb - sa) / n), lumaAbsDelta: r2(absL / n),
    lumaDeltaChanged: changed ? r2(dl / changed) : 0,
    colorDelta: [0, 1, 2].map((c) => r2((cb[c] - ca[c]) / n)),
    bbox: changed ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null,
  };
}

export async function abCommand(pos, opt) {
  const A = parseVariant(opt.a, "a"), B = parseVariant(opt.b, "b");
  if (A.replay !== undefined || B.replay !== undefined) die("replay= is for 'witness trace --compare' (ab compares pictures of one scenario)");
  if (!opt.a && !opt.b) die('usage: witness ab --a LIFT=0 --b LIFT=1 --at 3.2 [--input "..."] [--rect x,y,w,h] [--from 3 --to 4 --every 0.1] [--state]');
  const rect = opt.rect && opt.rect !== true ? parseRect(opt.rect, "--rect") : null;
  const zoom = opt.zoom && opt.zoom !== true ? Math.max(1, Math.round(+opt.zoom)) : 0;
  const threshold = +(opt.threshold || 16);
  const ranged = opt.from !== undefined || opt.to !== undefined;
  const separate = Object.keys(A.env).length || Object.keys(B.env).length || A.cmd !== undefined || B.cmd !== undefined;
  const m = await media();
  let fps = 60, frames = [], sheetFrames = [], name = "game", shotsDir = null;
  const plan = (s) => {
    fps = s.fps; name = s.hello.name;
    frames = [...new Set(timeList(opt.at, ranged ? [] : ["1"]).map((t) => framesOf(t, fps)))].sort((a, b) => a - b);
    if (ranged) {
      const f0 = framesOf(opt.from !== undefined && opt.from !== true ? String(opt.from) : "0", fps);
      const f1 = framesOf(opt.to !== undefined && opt.to !== true ? String(opt.to) : `${f0 + fps}f`, fps);
      const every = opt.every && opt.every !== true ? Math.max(1, framesOf(String(opt.every), fps)) : Math.max(1, Math.ceil((f1 - f0) / 9));
      for (let f = f0; f <= f1; f += every) sheetFrames.push(f);
      if (sheetFrames.length > 24) die(`${sheetFrames.length} frames is too many for an A/B sheet (max 24): raise --every`);
    }
  };
  // one variant's run: screenshots (and snapshots) at every frame we need
  const capture = async (s, cfg, v) => {
    if (!s.has("screenshot")) die("this game's adapter doesn't support 'screenshot'");
    const ro = runOpts(opt, cfg);
    const run = { seed: v.seed ?? ro.seed, scene: v.scene ?? ro.scene, params: v.params || ro.params ? { ...(ro.params || {}), ...(v.params || {}) } : undefined, input: [ro.input, v.input].filter(Boolean).join(", ") || undefined };
    const st = await begin(s, run);
    const out = new Map();
    for (const f of [...new Set([...frames, ...sheetFrames])].sort((a, b) => a - b)) {
      await stepTo(s, st, f);
      const im = await shotImage(await s.screenshot());
      out.set(f, { img: { width: im.width, height: im.height, data: Uint8Array.from(im.data) }, snap: await s.snapshot() });
    }
    printLogs((await s.drainLogs()).filter((l) => l.level === "error"));
    return out;
  };
  let capA, capB;
  const withVariant = (v, fn) => withGame({ ...opt, cmd: v.cmd ?? opt.cmd, __env: v.env }, fn);
  if (separate) {
    await withVariant(A, async (s, cfg, root) => { plan(s); shotsDir = path.join(root, cfg.shots); capA = await capture(s, cfg, A); });
    await withVariant(B, async (s, cfg) => { if (s.fps !== fps) die(`A runs at ${fps} fps and B at ${s.fps}: they can't be compared frame by frame`); capB = await capture(s, cfg, B); });
  } else {
    await withGame(opt, async (s, cfg, root) => { plan(s); shotsDir = path.join(root, cfg.shots); capA = await capture(s, cfg, A); capB = await capture(s, cfg, B); });
  }
  const outDir = path.resolve(opt.out && opt.out !== true ? String(opt.out) : path.join(shotsDir, "ab"));
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  const results = [];
  const first = capA.get(frames[0] ?? sheetFrames[0]).img;
  const R = rect || { x: 0, y: 0, w: first.width, h: first.height };
  const crop = (img) => { let c = m.cropImage(img, R); if (zoom > 1) c = m.zoomImage(c, zoom); return c; };
  for (const f of frames) {
    const a = capA.get(f), b = capB.get(f);
    if (a.img.width !== b.img.width || a.img.height !== b.img.height) die(`A's screenshot is ${a.img.width}×${a.img.height} and B's ${b.img.width}×${b.img.height} at f${f}`);
    const cmp = compareRect(a.img, b.img, R, threshold);
    const d = m.diffImages(m.cropImage(a.img, R), m.cropImage(b.img, R), { threshold, title: `f${f}: A ${A.label} | B ${B.label}` });
    const file = path.join(outDir, `ab-f${f}.png`);
    fs.writeFileSync(file, d.png); files.push(file);
    const regions = d.boxes.filter((q) => !q.isFrom).map((q) => ({ kind: q.kind, x: R.x + q.x, y: R.y + q.y, w: q.w, h: q.h, moved: q.moved }));
    const state = opt.state ? diffStates(a.snap.state ?? null, b.snap.state ?? null) : null;
    results.push({ frame: f, t: +(f / fps).toFixed(3), ...cmp, ssim: d.ssim, regions, state, file });
  }
  let sheet = null;
  if (sheetFrames.length) {
    const cells = [];
    const deltas = sheetFrames.map((f) => compareRect(capA.get(f).img, capB.get(f).img, R, threshold).changed);
    sheetFrames.forEach((f) => cells.push({ img: crop(capA.get(f).img), label: `A f${f} +${f - sheetFrames[0]}f` }));
    sheetFrames.forEach((f, i) => cells.push({ img: crop(capB.get(f).img), label: `B f${f} Δ${deltas[i]}px`, color: deltas[i] ? "#ffd166" : "#8b93b8" }));
    const sh = m.contactSheet(cells, { cols: sheetFrames.length, title: `${name}: A ${A.label} (top) | B ${B.label} (bottom)`, subtitle: `f${sheetFrames[0]}..f${sheetFrames[sheetFrames.length - 1]}${rect ? ` · rect ${R.x},${R.y} ${R.w}×${R.h}` : ""}${zoom > 1 ? ` · ×${zoom}` : ""} · Δ = pixels that differ in the rect` });
    sheet = path.join(outDir, "ab-sheet.png");
    fs.writeFileSync(sheet, sh.png); files.push(sheet);
    results.sheet = sheetFrames.map((f, i) => ({ frame: f, changed: deltas[i] }));
  }
  report({ A, B, R, rect, results, sheet, fps, opt, files, separate });
}

function report({ A, B, R, rect, results, sheet, fps, opt, files, separate }) {
  const box = (b) => (b ? `x=${b.x} y=${b.y} ${b.w}×${b.h}` : "none");
  const sg = (v) => (v > 0 ? `+${v}` : `${v}`);
  const lines = [`ab: A = ${A.label} · B = ${B.label}${separate ? " (two game processes)" : ""} · ${rect ? `rect x=${R.x} y=${R.y} ${R.w}×${R.h}` : "whole frame"}`];
  for (const r of results) {
    lines.push(`  f${r.frame} (${fmtT(r.t)}): ${r.changed ? `${r.changed.toLocaleString("en-US")} px changed (${r.percent}% of ${r.pixels.toLocaleString("en-US")}) in ${box(r.bbox)}` : "identical"} · mean luma ${r.lumaA} → ${r.lumaB} (${sg(r.lumaDelta)}${r.changed ? `; ${sg(r.lumaDeltaChanged)} on the changed pixels` : ""}) · mean colour Δ [${r.colorDelta.map(sg).join(", ")}] · SSIM ${r.ssim}`);
    for (const q of r.regions.slice(0, 5)) lines.push(`      ${q.kind}${q.moved ? ` ${sg(q.moved[0])},${sg(q.moved[1])}` : ""} x=${q.x} y=${q.y} ${q.w}×${q.h}`);
    if (r.state) lines.push(r.state.length ? `      state: ${r.state.length} path${r.state.length === 1 ? "" : "s"} differ: ${r.state.slice(0, 5).map((d) => (d.kind === "removed" ? `${d.path.replace(/^state\./, "")} only in A` : d.kind === "added" ? `${d.path.replace(/^state\./, "")} only in B` : `${d.path.replace(/^state\./, "")} ${fmt(d.a, 24)} → ${fmt(d.b, 24)}`)).join(" · ")}${r.state.length > 5 ? " · …" : ""}` : "      state: identical");
    lines.push(`      → ${r.file}  (A | B | changes)`);
  }
  if (sheet) lines.push(`  filmstrip f${results.sheet[0].frame}..f${results.sheet[results.sheet.length - 1].frame}: changed px per frame ${results.sheet.map((q) => q.changed).join(", ")} → ${sheet}`);
  const one = results[0];
  const env = envelope("ab", {
    verdict: one ? `${one.changed} px changed in the ${rect ? "rect" : "frame"} at f${one.frame} (${one.percent}%), mean luma ${sg(one.lumaDelta)}` : `filmstrip: ${results.sheet ? results.sheet.map((q) => q.changed).join(", ") : ""}`,
    summary: one ? { changedPixels: one.changed, changedPercent: one.percent, lumaDelta: one.lumaDelta, lumaDeltaChanged: one.lumaDeltaChanged, colorDelta: one.colorDelta, bbox: one.bbox, ssim: one.ssim, stateChanges: one.state ? one.state.length : null, frames: results.map((r) => r.frame) } : { sheet: results.sheet },
    data: { a: A, b: B, rect: R, fps, moments: results.map(({ file, ...r }) => r), sheet: results.sheet || null },
    files,
  });
  emit(env, `${lines.join("\n")}\n(view the PNGs with your image tool)`, opt);
}
