// Witness CLI: see the game — screenshots, crops, crisp zoom, filmstrips (contact sheets) and key frames.
import fs from "node:fs";
import path from "node:path";
import { begin, stepTo } from "../core/runner.js";
import { evaluate } from "../core/expr.js";
import { REFS_DIR, markGenerated } from "../core/clean.js";
import {
  die, say, withGame, gamePixels, runOpts, media, printLogs, timeList, framesOf, fmtT, shotImage, envelope, emit,
} from "./common.js";

const MAX_CELLS = 48;

/** "x,y,w,h" -> rect (dies on a bad value). */
export function parseRect(s, what = "a region") {
  const v = String(s).split(",").map(Number);
  if (v.length !== 4 || v.some((x) => !Number.isFinite(x)) || v[2] <= 0 || v[3] <= 0) die(`${what} is x,y,w,h (got ${s})`);
  return { x: v[0], y: v[1], w: v[2], h: v[3] };
}
// symlinks resolved (macOS /var is /private/var), so one file under two spellings still counts as the same
const realish = (p) => { p = path.resolve(p); const tail = []; while (!fs.existsSync(p)) { const d = path.dirname(p); if (d === p) break; tail.unshift(path.basename(p)); p = d; } try { p = fs.realpathSync.native(p); } catch { /* as is */ } return path.join(p, ...tail); };
const samePath = (a, b) => { const x = realish(a), y = realish(b); return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y; };
/** --save-ref <name>: a baseline name (letters, digits, . _ -), ".png" optional. */
export function refName(v) {
  const n = v === true ? "" : String(v).replace(/\.png$/i, "");
  if (!/^[\w.-]+$/.test(n)) die(`--save-ref wants a name like title-screen (saved as ${REFS_DIR}/<name>.png), got ${v === true ? "nothing" : v}`);
  return n;
}
/**
 * --diff <name | file.png>: a name without a folder is a baseline saved with --save-ref (witness/refs/<name>.png)
 * when one exists (names may hold dots: title.v2); else a path, and a bare name without an extension must be a
 * baseline. Dies when it doesn't exist.
 */
export function refPath(spec, cfg, root) {
  if (spec === true) die("--diff wants a reference: a name saved with --save-ref, or a PNG file");
  const s = String(spec);
  if (/^[\w.-]+$/.test(s)) {
    const f = path.resolve(root, REFS_DIR, `${s}.png`);
    if (fs.existsSync(f)) return f;
    if (!/\.\w{2,4}$/.test(s)) die(`no reference named "${s}" (looked for ${f}): save one first with  witness shot --at <t> --save-ref ${s}`);
  }
  const f = path.resolve(s);
  if (!fs.existsSync(f)) die(`no such image: ${s}`);
  return f;
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

/**
 * Boxes and labels for the entities of a snapshot, in screen pixels of `img`: from each entity's own `screen`, else
 * --project "<expr of e>", else the state.camera convention, else a fit of state positions to the sprites found.
 * Returns { items, how, fit }.
 */
export async function annotationItems(m, img, snap, opt) {
  const { entitiesOf, cameraHint } = await import("./measure.js");
  const types = opt.types && opt.types !== true ? String(opt.types).split(",").map((t) => t.trim()).filter(Boolean) : null;
  const ents = entitiesOf(snap, types);
  const fields = opt.fields && opt.fields !== true ? String(opt.fields).split(",").map((f) => f.trim()).filter(Boolean) : ["hp", "state"];
  const label = (e) => [`#${e.id} ${e.type}`, ...fields.filter((f) => e.raw && e.raw[f] != null && typeof e.raw[f] !== "object").map((f) => `${f}=${typeof e.raw[f] === "number" ? +(+e.raw[f]).toFixed(2) : e.raw[f]}`)].join(" ");
  let proj = null, how = "", fit = null;
  if (opt.project && opt.project !== true) {
    let fn;
    try { fn = new Function("e", "state", `return (${String(opt.project)});`); } catch (e) { die(`--project: ${e.message}`); }   // eslint-disable-line no-new-func
    proj = (e) => { const v = fn(e.raw, snap.state); return Array.isArray(v) ? v : v && "x" in v ? [v.x, v.y] : null; };
    how = `--project ${opt.project}`;
  } else {
    const hint = cameraHint(snap);
    if (hint && !opt.fit) { proj = (e) => [hint.scale * e.x + hint.ox, hint.scale * e.y + hint.oy]; how = `state.camera (x' = ${hint.scale}·x ${hint.ox >= 0 ? "+" : "−"} ${Math.abs(hint.ox)})`; }
    else {
      fit = m.fitProjection(ents, m.findBlobs(img), { hint });
      if (fit.ok) { proj = (e) => [fit.ax * e.x + fit.bx, fit.ay * e.y + fit.by]; how = `fitted to the sprites: x' = ${fit.ax}·x ${fit.bx >= 0 ? "+" : "−"} ${Math.abs(fit.bx)}, y' = ${fit.ay}·y ${fit.by >= 0 ? "+" : "−"} ${Math.abs(fit.by)} (${fit.matched}/${fit.total}, residual ${fit.residual} px)`; }
      else { proj = (e) => [e.x, e.y]; how = `state positions as pixels (no fit: ${fit.reason})`; }
    }
  }
  const scale = fit && fit.ok ? Math.abs(fit.ax) : (() => { const h = cameraHint(snap); return h ? h.scale : 1; })();
  const blobOf = new Map((fit && fit.ok ? fit.all : []).map((q) => [q.entity.id, q.blob]));
  const items = [];
  for (const e of ents) {
    let x, y, w = 0, h = 0;
    if (Array.isArray(e.screen) && e.screen.length >= 2) { [x, y] = e.screen; w = e.screen[2] || 0; h = e.screen[3] || 0; if (w && h) { items.push({ x, y, w, h, label: label(e), group: e.type }); continue; } }
    else { const p = Number.isFinite(e.x) ? proj(e) : null; if (!p) continue; [x, y] = p; }
    const bx = Array.isArray(e.box) ? e.box : null;
    if (bx && bx.length >= 2) { w = (bx.length >= 4 ? bx[2] : bx[0]) * scale; h = (bx.length >= 4 ? bx[3] : bx[1]) * scale; items.push({ x: x - w / 2, y: y - h / 2, w, h, label: label(e), group: e.type }); }
    else if (blobOf.has(e.id)) { const b = blobOf.get(e.id).bbox; items.push({ x: b.x, y: b.y, w: b.w, h: b.h, label: label(e), group: e.type }); }
    else items.push({ x, y, w: 0, h: 0, label: label(e), group: e.type });
  }
  return { items, how, fit, count: ents.length };
}

export async function shotCommand(pos, opt) {
  const ranged = opt.from !== undefined || opt.to !== undefined || opt.auto !== undefined || opt.sheet;
  // a baseline is one picture at a time: a sheet or clip would land in the (pruned) shots folder, not witness/refs
  if (opt["save-ref"] !== undefined && (opt.clip || ranged)) die(`--save-ref saves single shots only (witness shot --at <t> --save-ref <name>), not --${opt.clip ? "clip" : opt.sheet ? "sheet" : opt.auto !== undefined ? "auto" : "from/--to"}: those go to the shots folder, which is pruned`);
  if (opt.clip) return clipShots(opt);
  return ranged ? sheetShots(opt) : singleShots(opt);
}

/** witness shot --at 1,4 [--crop|--follow] [--zoom] [--diff ref.png [--ignore ...]] */
async function singleShots(opt) {
  const fr = framing(opt);
  const results = [];
  await withGame(opt, async (s, cfg, root) => {
    if (!s.has("screenshot")) die("this game's adapter doesn't support 'screenshot'");
    if (fr.crop || fr.follow || opt.annotate || (opt.scale && opt.scale !== true)) gamePixels(s, "shot --crop / --follow / --annotate / --scale", opt);
    const fps = s.fps;
    const tokens = timeList(opt.at, [opt.time && opt.time !== true ? String(opt.time) : "1"]);
    const items = tokens.map((t) => ({ t, f: framesOf(t, fps) })).sort((a, b) => a.f - b.f);
    const m = await media();
    // the reference is read BEFORE anything is written: --diff of the default output path compared the new shot with itself
    const ref = opt.diff ? refPath(opt.diff, cfg, root) : null;
    const refBuf = ref ? fs.readFileSync(ref) : null;
    const saveRef = opt["save-ref"] !== undefined ? refName(opt["save-ref"]) : null;
    const st = await begin(s, runOpts(opt, cfg));
    for (const it of items) {
      await stepTo(s, st, it.f);
      const tTag = /f$/i.test(it.t) ? `f${it.f}` : String(it.t).replace(".", "_");
      let file = path.resolve(opt.out && opt.out !== true ? String(opt.out) : path.join(root, cfg.shots, items.length > 1 ? "shot-{t}.png" : "shot.png"));
      if (items.length > 1 && !file.includes("{t}")) file = file.replace(/\.png$/i, "-{t}.png");
      file = file.replace("{t}", tTag);
      if (saveRef) {
        // a named baseline: witness/refs/<name>.png, never pruned (the shots folder is); one per --at time with several
        const rf = path.resolve(root, REFS_DIR, `${saveRef}${items.length > 1 ? `-${tTag}` : ""}.png`);
        if (ref && samePath(rf, ref)) die(`--save-ref ${saveRef} would overwrite the --diff reference ${ref}`);
        file = rf;
      }
      if (ref && samePath(file, ref)) die(`--diff ${opt.diff} is the file this shot would be written to (${file}): it would be compared with itself. Keep references apart: witness shot --save-ref <name> (witness/refs/<name>.png), then --diff <name>`);
      const shot = await s.screenshot(opt.scale ? +opt.scale : undefined);
      const snap = fr.follow || opt.annotate ? await s.snapshot() : null;
      if (opt.annotate) {
        // entity boxes and labels from the state, drawn over the full frame
        const full = await shotImage(shot);
        const A = await annotationItems(m, full, snap, opt);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, m.annotate(full, A.items, { zoom: fr.zoom > 1 ? fr.zoom : null, title: `${s.hello.name} f${it.f}: ${A.items.length} entities · ${A.how}` }));
        markGenerated(path.resolve(root, cfg.shots), file);
        const r = { frame: it.f, t: +(it.f / fps).toFixed(3), file, annotated: A.items.length, projection: A.how, fit: A.fit && A.fit.ok ? { ax: A.fit.ax, bx: A.fit.bx, ay: A.fit.ay, by: A.fit.by, residual: A.fit.residual } : null };
        if (!opt.json) say(`✔ f${it.f} (${fmtT(it.f / fps)}) → ${file}  (${A.items.length} entities boxed and labelled; positions from ${A.how})`);
        results.push(r);
        continue;
      }
      const { img, rect } = await frameImage(m, shot, snap, fr);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, m.encodePNG(img.width, img.height, img.data));
      markGenerated(path.resolve(root, cfg.shots), file);
      const r = { frame: it.f, t: +(it.f / fps).toFixed(3), file, width: img.width, height: img.height, source: rect, ...(saveRef ? { ref: path.basename(file, ".png") } : {}) };
      const dev = s.web && s.web.captureMode && s.web.captureMode !== "canvas" ? `  (${img.width}×${img.height} device px: ${s.web.captureMode} capture at DPR ${s.web.device ? s.web.device.dpr : 1}, not game pixels)` : "";
      if (!opt.json) say(`✔ f${it.f} (${fmtT(it.f / fps)}) → ${file}${rect || fr.zoom > 1 ? `  (${img.width}×${img.height}: ${describeFraming(fr)})` : ""}${dev}`);
      if (opt.diff) {
        // regions never compared: --ignore "x,y,w,h; ..." plus witness.json "diff": { "ignore": ["x,y,w,h", ...] }
        const cfgIgnore = cfg.diff && Array.isArray(cfg.diff.ignore) ? cfg.diff.ignore.map((q) => parseRect(q, "witness.json diff.ignore")) : [];
        const ignore = [...cfgIgnore, ...(opt.ignore && opt.ignore !== true ? parseRects(opt.ignore) : [])];
        let d;
        try { d = m.diffImages(refBuf, { width: img.width, height: img.height, data: img.data }, { threshold: +(opt.threshold || 16), ignore, align: !opt["no-align"], resize: !!opt.resize, title: `diff vs ${path.basename(ref)}` }); }
        catch (e) { if (/sizes differ/.test(e.message)) die(`${e.message.replace(/^diffImages: /, "")}: the reference ${path.basename(ref)} and the shot have different sizes (add --resize to compare anyway, or shoot with the same --window/--crop/--zoom)`); throw e; }
        // next to the shot; a shot saved as a reference keeps its diff picture in the shots folder, not witness/refs
        const dfile = saveRef ? path.resolve(root, cfg.shots, `${path.basename(file, ".png")}-diff.png`) : file.replace(/\.png$/i, "-diff.png");
        fs.mkdirSync(path.dirname(dfile), { recursive: true });
        fs.writeFileSync(dfile, d.png); markGenerated(path.resolve(root, cfg.shots), dfile);
        const desc = (b) => (b.kind === "moved" && b.from ? `moved ${b.moved[0] >= 0 ? "+" : ""}${b.moved[0]},${b.moved[1] >= 0 ? "+" : ""}${b.moved[1]}: x=${b.from.x} y=${b.from.y} → x=${b.x} y=${b.y} ${b.w}×${b.h}`
          : b.kind === "moved" && b.within ? `moved ${b.moved[0] >= 0 ? "+" : ""}${b.moved[0]},${b.moved[1] >= 0 ? "+" : ""}${b.moved[1]} inside x=${b.x} y=${b.y} ${b.w}×${b.h}`
          : `${b.kind} x=${b.x} y=${b.y} ${b.w}×${b.h} (${b.pixels} px)`);
        const shown = d.boxes.filter((b) => !b.isFrom);
        r.diff = { changedPercent: d.changedPercent, changedPixels: d.changedPixels, ssim: d.ssim, shift: d.shift, regions: shown.map(({ x, y, w, h, pixels, kind, moved, from }) => ({ x, y, w, h, pixels, kind, moved, from })), sizeMismatch: d.sizeMismatch, file: dfile };
        if (!opt.json) {
          const head = d.changedPixels ? `${(+d.changedPercent).toFixed(3)}% changed (${d.changedPixels} px) in ${shown.length} region${shown.length === 1 ? "" : "s"}` : d.shift ? "nothing changed but the camera" : "identical";
          say(`  diff vs ${opt.diff}: ${head} · SSIM ${d.ssim}${d.shift ? ` · the camera moved (picture shifted ${d.shift.dx},${d.shift.dy}; compared after undoing it, ${d.shift.rawPercent}% differed before)` : ""}${ignore.length ? ` · ignoring ${ignore.length} region${ignore.length === 1 ? "" : "s"}` : ""}`);
          shown.slice(0, 8).forEach((b, i) => say(`    ${i + 1} ${desc(b)}`));
          if (shown.length > 8) say(`    … ${shown.length - 8} more (--json)`);
          say(`    → ${dfile}  (A │ B │ changes: green appeared, red gone, blue moved, yellow changed)`);
          if (d.sizeMismatch) say(`  ⚠ sizes differ: reference ${d.sizeMismatch.a.join("×")} vs shot ${d.sizeMismatch.b.join("×")} (--resize scaled the shot to compare)`);
        }
      }
      results.push(r);
    }
    printLogs(await s.drainLogs());
  });
  {
    emit(envelope("shot", {
      verdict: `${results.length} shot${results.length === 1 ? "" : "s"}${results.some((r) => r.diff) ? `; diff ${results.map((r) => r.diff ? `${r.diff.changedPercent}% (SSIM ${r.diff.ssim})` : "-").join(", ")}` : ""}`,
      summary: { shots: results.length, frames: results.map((r) => r.frame), ...(results.length === 1 && results[0].diff ? { changedPercent: results[0].diff.changedPercent, regions: results[0].diff.regions.length, ssim: results[0].diff.ssim, moved: results[0].diff.regions.filter((q) => q.kind === "moved").length, shift: results[0].diff.shift ? [results[0].diff.shift.dx, results[0].diff.shift.dy] : null } : {}) },
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
    if (fr.crop || fr.follow || (opt.scale && opt.scale !== true)) gamePixels(s, "shot --sheet --crop / --follow / --scale", opt);
    const fps = s.fps;
    // --sheet --at 1,1.4,2: a sheet of chosen moments
    const moments = opt.at !== undefined && opt.at !== true && opt.from === undefined && opt.auto === undefined ? [...new Set(timeList(opt.at, []).map((t) => framesOf(t, fps)))].sort((a, b) => a - b) : null;
    const f0 = moments ? moments[0] : framesOf(opt.from !== undefined && opt.from !== true ? String(opt.from) : "0", fps);
    const f1 = moments ? moments[moments.length - 1] : framesOf(opt.to !== undefined && opt.to !== true ? String(opt.to) : `${f0 + fps}f`, fps);
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
      frames = moments || [];
      if (!moments) for (let f = f0; f <= f1; f += every) frames.push(f);
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
  const regular = frames.every((f, i) => i < 2 || f - frames[i - 1] === frames[1] - frames[0]);
  const sub = auto ? "the frames that change most vs the frame before · label: frame, +offset, % changed" : regular ? `every ${frames.length > 1 ? frames[1] - frames[0] : 0}f at ${fps} fps · label: frame, +offset` : `chosen moments at ${fps} fps · label: frame, +offset`;
  const sheet = m.contactSheet(cells, { cols: opt.cols && opt.cols !== true ? +opt.cols : undefined, title, subtitle: sub });
  const file = path.resolve(opt.out && opt.out !== true ? String(opt.out) : path.join(root, cfg.shots, "sheet.png"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, sheet.png);
  markGenerated(path.resolve(root, cfg.shots), file);
  const L = sheet.layout;
  const how = [`${L.cols}×${L.rows} grid`, `each ${imgs[0].width}×${imgs[0].height}${L.scale < 1 ? ` shown at ${Math.round(L.scale * 100)}%` : ""}`, describeFraming(fr)].filter(Boolean).join(", ");
  const text = auto
    ? `✔ ${frames.length} key frame${frames.length === 1 ? "" : "s"} of f${f0}..f${f1} (biggest picture changes): ${frames.map((f) => `f${f}${pct(f)}`).join(", ")}\n  → ${file} (${how})`
    : `✔ ${frames.length} frames ${regular ? `f${frames[0]}..f${frames[frames.length - 1]}${frames.length > 1 ? ` every ${frames[1] - frames[0]}f` : ""}` : frames.map((f) => `f${f}`).join(", ")} → ${file} (${how})`;
  const json = envelope("shot --sheet", {
    verdict: text.split("\n")[0].replace(/^✔ /, ""),
    summary: { frames, cols: L.cols, rows: L.rows, cell: [imgs[0].width, imgs[0].height] },
    data: { from: f0, to: f1, fps, auto: !!auto, scores: scores && auto ? Object.fromEntries(frames.map((f) => [f, scores.get(f)])) : undefined, layout: L, framing: { crop: fr.crop, follow: fr.follow, size: fr.size, zoom: fr.zoom } },
    files: [file],
  });
  return { text: `${text}  (view it with your image tool)`, json };
}

const MAX_CLIP_FRAMES = 600;
const CLIP_MEMORY = 400e6;   // bytes of decoded frames held before encoding

/** "--every 1/30" (seconds as a fraction), "2f", "0.05" -> frames (at least 1). */
export function everyFrames(v, fps) {
  if (v === undefined || v === true) return 1;
  const m = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(String(v));
  if (m) return Math.max(1, Math.round((+m[1] / +m[2]) * fps));
  return Math.max(1, framesOf(String(v), fps));
}

/** witness shot --clip [clip.png] --from 1 --to 2 [--every 1/30] [--scale 0.5] [--speed 0.25] [--max-mb 8] */
async function clipShots(opt) {
  const fr = framing(opt);
  let out;
  await withGame(opt, async (s, cfg, root) => {
    if (!s.has("screenshot")) die("this game's adapter doesn't support 'screenshot'");
    if (fr.crop || fr.follow) gamePixels(s, "shot --clip --crop / --follow", opt);
    const fps = s.fps;
    const f0 = framesOf(opt.from !== undefined && opt.from !== true ? String(opt.from) : "0", fps);
    const f1 = framesOf(opt.to !== undefined && opt.to !== true ? String(opt.to) : `${f0 + 2 * fps}f`, fps);
    if (f1 <= f0) die("--to must be after --from");
    let every = everyFrames(opt.every, fps);
    const scale = opt.scale && opt.scale !== true ? +opt.scale : 1;
    if (!(scale > 0 && scale <= 8)) die("--scale is a factor from 0.05 to 8, e.g. 0.5");
    const speed = opt.speed && opt.speed !== true ? +opt.speed : 1;
    if (!(speed > 0 && speed <= 8)) die("--speed is a playback factor, e.g. 0.25 for quarter speed");
    const maxBytes = (opt["max-mb"] && opt["max-mb"] !== true ? +opt["max-mb"] : 8) * 1024 * 1024;
    const notes = [];
    if (Math.floor((f1 - f0) / every) + 1 > MAX_CLIP_FRAMES) {
      const e2 = Math.ceil((f1 - f0) / (MAX_CLIP_FRAMES - 1));
      notes.push(`every ${every}f would be ${Math.floor((f1 - f0) / every) + 1} frames (max ${MAX_CLIP_FRAMES}): using every ${e2}f`);
      every = e2;
    }
    const m = await media();
    const st = await begin(s, runOpts(opt, cfg));
    const frames = [], imgs = [];
    for (let f = f0; f <= f1; f += every) {
      await stepTo(s, st, f);
      const shot = await s.screenshot();
      const snap = fr.follow ? await s.snapshot() : null;
      let { img } = await frameImage(m, shot, snap, fr);
      if (scale !== 1) img = m.scaleImage(img, scale);
      if (!imgs.length) {
        // the frames are held in memory until encoding: thin them out if the whole clip would not fit
        const n = Math.floor((f1 - f0) / every) + 1, per = img.width * img.height * 4;
        if (n * per > CLIP_MEMORY) {
          const e2 = Math.ceil((f1 - f0) / Math.max(1, Math.floor(CLIP_MEMORY / per) - 1));
          notes.push(`${n} frames of ${img.width}×${img.height} won't fit in memory: using every ${e2}f (or add --scale 0.5 / --crop)`);
          every = e2;
        }
      }
      frames.push(f); imgs.push({ width: img.width, height: img.height, data: Uint8Array.from(img.data) });
    }
    // playback at game speed (× --speed): each frame lasts `every` game frames
    let den = fps * speed, num = every;
    if (Math.abs(den - Math.round(den)) > 1e-9) { num = Math.round((every * 1000) / (fps * speed)); den = 1000; }
    let pick = imgs.map((_, i) => i), stride = 1, enc;
    for (;;) {
      const delays = pick.map((i, k) => (k + 1 < pick.length ? pick[k + 1] - i : stride) * num);
      enc = m.encodeAPNG(pick.map((i) => imgs[i]), { fps: Math.round(den), delays });
      if (enc.bytes <= maxBytes || pick.length <= 2) break;
      stride *= 2;
      pick = imgs.map((_, i) => i).filter((i) => i % stride === 0);
    }
    if (stride > 1) notes.push(`over ${Math.round(maxBytes / 1048576)} MB: kept every ${stride === 2 ? "2nd" : `${stride}th`} frame (every ${every * stride}f; raise --max-mb, or use --scale/--crop)`);
    const clipFile = path.resolve(typeof opt.clip === "string" ? opt.clip : opt.out && opt.out !== true ? String(opt.out) : path.join(root, cfg.shots, "clip.png"));
    fs.mkdirSync(path.dirname(clipFile), { recursive: true });
    fs.writeFileSync(clipFile, enc.png);
    markGenerated(path.resolve(root, cfg.shots), clipFile);
    const kept = pick.map((i) => frames[i]);
    // what the file plays: the sum of the delays written (the last kept frame is often before --to)
    const seconds = enc.delays.reduce((a, [n, d]) => a + n / d, 0);
    const w = imgs[0].width, h = imgs[0].height;
    const kb = enc.bytes < 1048576 ? `${Math.round(enc.bytes / 1024)} KB` : `${(enc.bytes / 1048576).toFixed(1)} MB`;
    const text = [
      `✔ clip f${f0}..f${kept[kept.length - 1]} every ${every * stride}f: ${kept.length} frames (${enc.stored} stored, repeats merged), ${w}×${h}${describeFraming(fr) ? ` (${describeFraming(fr)})` : ""}${scale !== 1 ? ` at ×${scale}` : ""}, plays ${+seconds.toFixed(2)} s${speed !== 1 ? ` (×${speed} speed)` : " (real time)"}, loops · ${kb} → ${clipFile}`,
      ...notes.map((n) => `  ⚠ ${n}`),
      "  an animated PNG for a person to watch (open it in a browser); image tools show only its first frame, so to see the motion yourself use --sheet",
    ].join("\n");
    out = { text, env: envelope("shot --clip", {
      verdict: `${kept.length} frames, ${+seconds.toFixed(2)} s, ${kb}`,
      summary: { frames: kept.length, stored: enc.stored, every: every * stride, from: f0, to: kept[kept.length - 1], width: w, height: h, seconds: +seconds.toFixed(3), bytes: enc.bytes },
      data: { frames: kept, fps, speed, scale, delay: [num, Math.round(den)], notes, framing: { crop: fr.crop, follow: fr.follow, size: fr.size, zoom: fr.zoom } },
      files: [clipFile],
    }) };
    printLogs(await s.drainLogs());
  });
  emit(out.env, out.text, opt);
}
