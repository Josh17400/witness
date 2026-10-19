// Witness CLI: see the game — screenshots, crops, crisp zoom, filmstrips (contact sheets) and key frames.
import fs from "node:fs";
import path from "node:path";
import { begin, stepTo } from "../core/runner.js";
import { evaluate } from "../core/expr.js";
import {
  die, say, withGame, runOpts, media, printLogs, timeList, framesOf, fmtT, shotImage, envelope, emit,
} from "./common.js";

const MAX_CELLS = 48;

/** "x,y,w,h" -> rect (dies on a bad value). */
export function parseRect(s, what = "a region") {
  const v = String(s).split(",").map(Number);
  if (v.length !== 4 || v.some((x) => !Number.isFinite(x)) || v[2] <= 0 || v[3] <= 0) die(`${what} is x,y,w,h (got ${s})`);
  return { x: v[0], y: v[1], w: v[2], h: v[3] };
}
/** "x,y,w,h; x,y,w,h" -> rects. */
export const parseRects = (s) => String(s).split(";").map((r) => r.trim()).filter(Boolean).map((r) => parseRect(r, "an --ignore region"));
const posOf = (p) => (Array.isArray(p) ? p : p && Array.isArray(p.pos) ? p.pos : p && typeof p === "object" && "x" in p ? [p.x, p.y] : null);

/** Options shared by the commands that capture frames: crop, follow (+size) and zoom. */
export function framing(opt) {
  const crop = opt.crop && opt.crop !== true ? parseRect(opt.crop, "--crop") : null;
  const follow = opt.follow && opt.follow !== true ? String(opt.follow) : null;
  let size = [96, 96];
  if (opt.size && opt.size !== true) {
    const m = /^(\d+)(?:[x×,](\d+))?$/.exec(String(opt.size));
    if (!m) die(`--size wants N or WxH (got ${opt.size})`);
    size = [+m[1], +(m[2] ?? m[1])];
  }
  const zoom = opt.zoom && opt.zoom !== true ? Math.round(+opt.zoom) : 1;
  if (!(zoom >= 1 && zoom <= 16)) die("--zoom is a whole number from 1 to 16");
  if (crop && follow) die("use --crop or --follow, not both");
  return { crop, follow, size, zoom };
}

/** Apply crop/follow/zoom to a captured frame. Returns { img, rect } (rect = the source area shown, or null). */
export async function frameImage(m, shot, snap, fr) {
  let img = await shotImage(shot), rect = null;
  if (fr.follow) {
    let v;
    try { v = evaluate(fr.follow, snap); } catch (e) { die(`--follow: ${e.message}`); }
    const p = posOf(v);
    if (!p || !Number.isFinite(+p[0]) || !Number.isFinite(+p[1])) die(`--follow "${fr.follow}" gave ${JSON.stringify(v)}, not a position [x, y] in screen pixels`);
    rect = { x: Math.round(+p[0] - fr.size[0] / 2), y: Math.round(+p[1] - fr.size[1] / 2), w: fr.size[0], h: fr.size[1] };
  } else if (fr.crop) rect = fr.crop;
  if (rect) img = m.cropImage(img, rect);
  if (fr.zoom > 1) img = m.zoomImage(img, fr.zoom);
  return { img, rect };
}

const describeFraming = (fr) => [fr.follow ? `${fr.size.join("×")} around ${fr.follow}` : fr.crop ? `crop ${fr.crop.x},${fr.crop.y} ${fr.crop.w}×${fr.crop.h}` : "", fr.zoom > 1 ? `×${fr.zoom}` : ""].filter(Boolean).join(", ");

export async function shotCommand(pos, opt) {
  const ranged = opt.from !== undefined || opt.to !== undefined || opt.auto !== undefined || opt.sheet;
  return ranged ? sheetShots(opt) : singleShots(opt);
}

/** witness shot --at 1,4 [--crop|--follow] [--zoom] [--diff ref.png [--ignore ...]] */
async function singleShots(opt) {
  const fr = framing(opt);
  const results = [];
  await withGame(opt, async (s, cfg, root) => {
    if (!s.has("screenshot")) die("this game's adapter doesn't support 'screenshot'");
    const fps = s.fps;
    const tokens = timeList(opt.at, [opt.time && opt.time !== true ? String(opt.time) : "1"]);
    const items = tokens.map((t) => ({ t, f: framesOf(t, fps) })).sort((a, b) => a.f - b.f);
    const m = await media();
    const st = await begin(s, runOpts(opt, cfg));
    for (const it of items) {
      await stepTo(s, st, it.f);
      let file = path.resolve(opt.out && opt.out !== true ? String(opt.out) : path.join(root, cfg.shots, items.length > 1 ? "shot-{t}.png" : "shot.png"));
      if (items.length > 1 && !file.includes("{t}")) file = file.replace(/\.png$/i, "-{t}.png");
      file = file.replace("{t}", /f$/i.test(it.t) ? `f${it.f}` : String(it.t).replace(".", "_"));
      const shot = await s.screenshot(opt.scale ? +opt.scale : undefined);
      const snap = fr.follow ? await s.snapshot() : null;
      const { img, rect } = await frameImage(m, shot, snap, fr);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, m.encodePNG(img.width, img.height, img.data));
      const r = { frame: it.f, t: +(it.f / fps).toFixed(3), file, width: img.width, height: img.height, source: rect };
      if (!opt.json) say(`✔ f${it.f} (${fmtT(it.f / fps)}) → ${file}${rect || fr.zoom > 1 ? `  (${img.width}×${img.height}: ${describeFraming(fr)})` : ""}`);
      if (opt.diff) {
        const ignore = opt.ignore && opt.ignore !== true ? parseRects(opt.ignore) : [];
        const ref = path.resolve(String(opt.diff));
        if (!fs.existsSync(ref)) die(`no such image: ${opt.diff}`);
        const d = m.diffImages(fs.readFileSync(ref), { width: img.width, height: img.height, data: img.data }, { threshold: +(opt.threshold || 16), ignore });
        const dfile = file.replace(/\.png$/i, "-diff.png");
        fs.writeFileSync(dfile, d.png);
        r.diff = { changedPercent: d.changedPercent, changedPixels: d.changedPixels, regions: d.boxes.map(({ x, y, w, h, pixels }) => ({ x, y, w, h, pixels })), sizeMismatch: d.sizeMismatch, file: dfile };
        if (!opt.json) {
          const regs = d.boxes.slice(0, 6).map((b, i) => `${i + 1}: x=${b.x} y=${b.y} ${b.w}×${b.h} (${b.pixels} px)`).join(" · ");
          say(`  diff vs ${opt.diff}: ${d.changedPixels ? `${(+d.changedPercent).toFixed(3)}% changed (${d.changedPixels} px) in ${d.boxes.length} region${d.boxes.length === 1 ? "" : "s"}${regs ? `: ${regs}${d.boxes.length > 6 ? " · …" : ""}` : ""}` : "identical"}${ignore.length ? ` (ignoring ${ignore.length} region${ignore.length === 1 ? "" : "s"})` : ""} → ${dfile}`);
          if (d.sizeMismatch) say(`  ⚠ sizes differ: reference ${d.sizeMismatch.a.join("×")} vs shot ${d.sizeMismatch.b.join("×")} (the shot was scaled to compare: crop/zoom the reference the same way)`);
        }
      }
      results.push(r);
    }
    printLogs(await s.drainLogs());
  });
  {
    emit(envelope("shot", {
      verdict: `${results.length} shot${results.length === 1 ? "" : "s"}${results.some((r) => r.diff) ? `; diff ${results.map((r) => r.diff ? `${r.diff.changedPercent}%` : "-").join(", ")}` : ""}`,
      summary: { shots: results.length, frames: results.map((r) => r.frame), ...(results.length === 1 && results[0].diff ? { changedPercent: results[0].diff.changedPercent, regions: results[0].diff.regions.length } : {}) },
      data: { shots: results },
      files: results.flatMap((r) => [r.file, ...(r.diff ? [r.diff.file] : [])]),
    }), null, opt);
  }
}

/** witness shot --from 1 --to 1.5 [--every 3f] --sheet | --auto 9 */
async function sheetShots(opt) {
  const fr = framing(opt);
  let out;
  await withGame(opt, async (s, cfg, root) => {
    if (!s.has("screenshot")) die("this game's adapter doesn't support 'screenshot'");
    const fps = s.fps;
    const f0 = framesOf(opt.from !== undefined && opt.from !== true ? String(opt.from) : "0", fps);
    const f1 = framesOf(opt.to !== undefined && opt.to !== true ? String(opt.to) : `${f0 + fps}f`, fps);
    if (f1 < f0) die("--to must not be before --from");
    const m = await media();
    const auto = opt.auto !== undefined ? (opt.auto === true ? 9 : Math.round(+opt.auto)) : 0;
    if (opt.auto !== undefined && !(auto >= 1)) die("--auto wants a number of key frames, e.g. --auto 9");
    let frames;
    let scores = null;
    if (auto) {
      if (auto > MAX_CELLS) die(`--auto ${auto}: at most ${MAX_CELLS} frames fit in one readable sheet`);
      if (f1 - f0 > 1800) die("--auto screenshots every frame: keep --from..--to within 30 s");
      // pass 1: how much the picture changes from each frame to the next
      const st = await begin(s, runOpts(opt, cfg));
      let prev = null;
      scores = new Map();
      const keep = !s.has("reset") ? new Map() : null;   // without reset there is no second pass: keep the frames
      for (let f = f0; f <= f1; f++) {
        await stepTo(s, st, f);
        const shot = await s.screenshot(opt.scale ? +opt.scale : undefined);
        const img = await shotImage(shot);
        if (prev) scores.set(f, m.frameDiffScore(prev, img, +(opt.threshold || 16)));
        prev = { width: img.width, height: img.height, data: Uint8Array.from(img.data) };
        if (keep) { if (keep.size > 400) die("this adapter has no 'reset': --auto keeps every frame in memory, so keep the range under 400 frames"); keep.set(f, { shot, snap: fr.follow ? await s.snapshot() : null }); }
      }
      await s.drainLogs();   // pass 2 repeats the run: report its logs once
      const fs_ = [...scores.keys()];
      const picked = m.pickKeyFrames(fs_.map((f) => scores.get(f)), auto, Math.max(1, Math.floor((f1 - f0) / (3 * auto))));
      frames = picked.map((i) => fs_[i]);
      if (!frames.length) frames = [f0];
      if (keep) { out = await compose(m, fr, frames.map((f) => keep.get(f)), frames, { s, cfg, root, opt, f0, f1, fps, scores, auto }); printLogs(await s.drainLogs()); return; }
    } else {
      const every = opt.every && opt.every !== true ? Math.max(1, framesOf(String(opt.every), fps)) : Math.max(1, Math.ceil((f1 - f0) / 11));
      frames = [];
      for (let f = f0; f <= f1; f += every) frames.push(f);
      if (frames.length > MAX_CELLS) die(`${frames.length} frames is too many for one readable sheet (max ${MAX_CELLS}): raise --every (e.g. --every ${Math.ceil((f1 - f0) / (MAX_CELLS - 1))}f) or shorten --from..--to`);
    }
    // capture the chosen frames (pass 2 for --auto: same seed and input, so the same frames)
    const st = await begin(s, runOpts(opt, cfg));
    const caps = [];
    for (const f of frames) {
      await stepTo(s, st, f);
      caps.push({ shot: await s.screenshot(opt.scale ? +opt.scale : undefined), snap: fr.follow ? await s.snapshot() : null });
    }
    out = await compose(m, fr, caps, frames, { s, cfg, root, opt, f0, f1, fps, scores, auto });
    printLogs(await s.drainLogs());
  });
  emit(out.json, out.text, opt);
}

async function compose(m, fr, caps, frames, { s, cfg, root, opt, f0, f1, fps, scores, auto }) {
  const imgs = [];
  for (let i = 0; i < caps.length; i++) imgs.push((await frameImage(m, caps[i].shot, caps[i].snap, fr)).img);
  const area = imgs[0].width * imgs[0].height / (fr.zoom * fr.zoom);
  const pct = (f) => (scores && scores.has(f) && area ? ` ${(100 * scores.get(f) / area).toFixed(1)}%` : "");
  const cells = imgs.map((img, i) => ({ img, label: `f${frames[i]} +${frames[i] - frames[0]}f${auto ? pct(frames[i]) : ""}` }));
  const title = `${s.hello.name}: ${auto ? `${frames.length} key frames of` : `${frames.length} frames`} f${f0}..f${f1}${describeFraming(fr) ? ` (${describeFraming(fr)})` : ""}`;
  const sub = auto ? "the frames that change most vs the frame before · label: frame, +offset, % changed" : `every ${frames.length > 1 ? frames[1] - frames[0] : 0}f at ${fps} fps · label: frame, +offset`;
  const sheet = m.contactSheet(cells, { cols: opt.cols && opt.cols !== true ? +opt.cols : undefined, title, subtitle: sub });
  const file = path.resolve(opt.out && opt.out !== true ? String(opt.out) : path.join(root, cfg.shots, "sheet.png"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, sheet.png);
  const L = sheet.layout;
  const how = [`${L.cols}×${L.rows} grid`, `each ${imgs[0].width}×${imgs[0].height}${L.scale < 1 ? ` shown at ${Math.round(L.scale * 100)}%` : ""}`, describeFraming(fr)].filter(Boolean).join(", ");
  const text = auto
    ? `✔ ${frames.length} key frame${frames.length === 1 ? "" : "s"} of f${f0}..f${f1} (biggest picture changes): ${frames.map((f) => `f${f}${pct(f)}`).join(", ")}\n  → ${file} (${how})`
    : `✔ ${frames.length} frames f${frames[0]}..f${frames[frames.length - 1]}${frames.length > 1 ? ` every ${frames[1] - frames[0]}f` : ""} → ${file} (${how})`;
  const json = envelope("shot --sheet", {
    verdict: text.split("\n")[0].replace(/^✔ /, ""),
    summary: { frames, cols: L.cols, rows: L.rows, cell: [imgs[0].width, imgs[0].height] },
    data: { from: f0, to: f1, fps, auto: !!auto, scores: scores && auto ? Object.fromEntries(frames.map((f) => [f, scores.get(f)])) : undefined, layout: L, framing: { crop: fr.crop, follow: fr.follow, size: fr.size, zoom: fr.zoom } },
    files: [file],
  });
  return { text: `${text}  (view it with your image tool)`, json };
}
