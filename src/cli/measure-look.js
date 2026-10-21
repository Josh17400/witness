// Witness CLI: measure ui | colorblind | palette | figure — readability checks on a screenshot (a PNG, or the game's frame).
//   ui          layout from the state.ui convention (clipped, off screen, safe area or a device preset, overlaps, text
//               size, text contrast, text over the world without a plate, the same text twice, almost-aligned edges),
//               or text-like rows found from pixels when the game has no state.ui; --from/--to: repeated toasts
//   colorblind  protan / deutan / tritan (/ achroma) simulation: simulated pictures, and which key colours (given,
//               the entities' sprite colours, or the picture's most common colours) stop being distinguishable
//   palette     colour count and palette compliance for pixel art: off-palette pixels, where, and their nearest colour
//   figure      a sprite's edge contrast against each ground surface around it, over scenes / params / times
import fs from "node:fs";
import path from "node:path";
import { begin, stepTo } from "../core/runner.js";
import { parseRect } from "./see.js";
import { die, withGame, gamePixels, runOpts, media, printLogs, framesOf, fmtT, shotImage, envelope, emit } from "./common.js";
import { sampleExprs, frameGrid } from "../core/sample.js";
import { entitiesOf, cameraHint } from "./measure.js";
import { backgroundPalette } from "../media/align.js";
import { resolveDevice, safePresetFor } from "../core/devices.js";

const r2 = (v) => (v == null ? v : Math.round(v * 100) / 100);
const val = (v) => (v !== undefined && v !== true ? String(v) : null);
const readImage = (m, f) => { const p = path.resolve(String(f)); if (!fs.existsSync(p)) die(`no such image: ${f}`); return m.decodePNG(fs.readFileSync(p)); };
const rgb = (c) => `rgb(${c.join(",")})`;

export async function lookMeasure(what, files, opt) {
  const m = await media();
  const c = await import("../media/color.js");
  if (what === "ui") return uiMeasure(m, files, opt);
  if (what === "colorblind" || what === "cvd") return colorblindMeasure(m, c, files, opt);
  if (what === "palette") return paletteMeasure(m, c, files, opt);
  if (what === "figure") return figureMeasure(m, c, files, opt);
}

/** The frame(s) to look at: a PNG file, or the game's screenshot (+ snapshot) at --at, once per --window size. */
async function getFrames(m, files, opt, gameCoords = null, { second = null, web = false } = {}) {
  if (files[0]) return { frames: [{ img: readImage(m, files[0]), snap: null, label: path.basename(String(files[0])) }], file: path.resolve(String(files[0])) };
  const wins = val(opt.window) ? val(opt.window).split(",").map((w) => w.trim()).filter(Boolean) : [null];
  const frames = [];
  let root = null, cfg = null;
  await withGame(opt, async (s, cfg0, root0) => {
    cfg = cfg0; root = root0;
    if (!s.has("screenshot")) die("this game's adapter doesn't support 'screenshot'");
    if (gameCoords) gamePixels(s, gameCoords, opt);
    const f = framesOf(val(opt.at) || "1", s.fps);
    // web (measure ui): any capture mode works, the page's layout says how its coordinates land on the picture; a page
    // with no canvas (a DOM game) is captured from the screen in the same session
    let mode = s.web ? s.web.captureMode : null, fellBack = false;
    const grab = async () => {
      if (web && s.web && mode !== "screen") {
        const info = await s.web.info().catch(() => null);
        if (info && !(info.canvases || []).some((c) => c.rect[2] * c.rect[3] > 0)) { mode = "screen"; fellBack = true; }
      }
      if (web && s.web && mode !== s.web.captureMode) { const c = await s.web.capture(mode); return shotImage({ width: c.width, height: c.height, format: "png", data: c.png.toString("base64") }); }
      return shotImage(await s.screenshot());
    };
    for (const w of wins) {
      const st = await begin(s, runOpts(w ? { ...opt, window: w } : { ...opt, window: undefined }, cfg));
      await stepTo(s, st, f);
      const img = await grab();
      const snap = await s.snapshot();
      const fr = { img: { width: img.width, height: img.height, data: Uint8Array.from(img.data) }, snap, f, window: w, label: `f${f}${w ? ` at ${w}` : ""}` };
      if (web && s.web) fr.web = { mode, fellBack, device: s.web.device || null, safeInsets: s.web.safeInsets || null, info: await s.web.info().catch(() => null), size: Array.isArray(s.hello.size) ? s.hello.size : null };
      // a second frame a little later (second(snap) frames on): what moves with the camera is the world, not HUD
      const k = second ? second(snap) : 0;
      if (k) { await stepTo(s, st, f + k); const im2 = await grab(); fr.next = { f: f + k, img: { width: im2.width, height: im2.height, data: Uint8Array.from(im2.data) } }; }
      frames.push(fr);
      printLogs(await s.drainLogs());
    }
  });
  return { frames, root, cfg };
}

/** Where pictures go: --out <dir>, else next to the input PNG, else the project's shots folder. */
function outDir(opt, got) {
  if (val(opt.out)) return path.resolve(val(opt.out));
  if (got.file) return path.dirname(got.file);
  return path.resolve(got.root, (got.cfg && got.cfg.shots) || "witness/shots");
}
const stemOf = (got, fallback) => (got.file ? path.basename(got.file).replace(/\.png$/i, "") : fallback);

/** "5%" -> fraction of the size; "12" or "12px" -> px. */
function pctOrPx(s, size, def) {
  const v = val(s) ?? def;
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n < 0) die(`expected a percentage (5%) or pixels (12), got ${v}`);
  return /%$/.test(v) ? { px: (n / 100) * size, pct: n } : { px: n, pct: null };
}

// ------------------------------------------------------------------ measure ui

/**
 * How state.ui coordinates land on the picture, and the picture's px per CSS px (= pt on iOS, dp on Android).
 * Browser games: from the page's layout (viewport, DPR, the main canvas's CSS box and hello.size); the ui list is in
 * game px when the page has a canvas (hello.size), else in CSS px (a DOM game's getBoundingClientRect). A PNG file:
 * px per pt from --device (picture width / the profile's CSS width), coordinates as given unless --ui-scale.
 * --ui-scale css|game forces the units; a number (3) or auto (= px per pt) scales the list by hand.
 */
export function uiGeometry(fr, opt) {
  const W = fr.img.width, H = fr.img.height, us = val(opt["ui-scale"]);
  let device = null;
  if (fr.web) device = fr.web.device;
  else if (val(opt.device)) { try { device = resolveDevice(val(opt.device)); } catch (e) { die(e.message); } }
  let pxPerPt = null, map = null, units = null, note = null;
  if (fr.web) {
    const info = fr.web.info || {}, size = fr.web.size;
    const vw = (info.viewport && info.viewport[0]) || (device ? device.width : W), vh = (info.viewport && info.viewport[1]) || (device ? device.height : H);
    let cv = null;
    for (const c of info.canvases || []) if (c.rect[2] * c.rect[3] > 0 && (!cv || c.rect[2] * c.rect[3] > cv.rect[2] * cv.rect[3])) cv = c;
    units = us === "css" || us === "game" ? us : cv && size ? "game" : "css";
    if (units === "game" && !(cv && size)) die("--ui-scale game: the page has no canvas (or hello has no size): its state.ui is in CSS px (--ui-scale css)");
    const mode = fr.web.mode;
    if (mode === "screen") {
      const kx = W / vw, ky = H / vh;
      pxPerPt = kx;
      map = units === "game" ? { kx: (cv.rect[2] / size[0]) * kx, ky: (cv.rect[3] / size[1]) * ky, ox: cv.rect[0] * kx, oy: cv.rect[1] * ky } : { kx, ky, ox: 0, oy: 0 };
      note = `the screen at ${r2(kx)} px per CSS px${fr.web.fellBack ? " (the page has no canvas: captured from the screen)" : ""}; state.ui in ${units === "game" ? `game px (the ${size.join("×")} canvas at ${cv.rect.map(r2).join(",")} CSS)` : "CSS px"}`;
    } else if (cv) {
      // element: the canvas as shown, at device px; canvas: the game's own pixels
      const kx = W / cv.rect[2], ky = H / cv.rect[3];
      pxPerPt = kx;
      map = units === "game" ? (size ? { kx: W / size[0], ky: H / size[1], ox: 0, oy: 0 } : null) : { kx, ky, ox: -cv.rect[0] * kx, oy: -cv.rect[1] * ky };
      note = `the ${mode === "element" ? "canvas as shown" : "game's canvas"} (${W}×${H}) at ${r2(kx)} px per CSS px; state.ui in ${units === "game" ? "game px" : "CSS px"}`;
    }
  } else if (device) { pxPerPt = W / device.width; note = `${device.name}: ${W} px wide = ${r2(pxPerPt)} px per pt (a full-screen screenshot assumed)`; }
  if (us && us !== "css" && us !== "game") {
    let k;
    if (us === "auto" || us === "dpr") { if (!pxPerPt) die("--ui-scale auto needs --device (the screenshot's px per CSS px), or give the factor: --ui-scale 3"); k = pxPerPt; }
    else { k = +us; if (!(k > 0 && k <= 16)) die(`--ui-scale wants a factor (3), auto, css or game (got ${us})`); }
    map = { kx: k, ky: k, ox: 0, oy: 0 };
    note = `${note ? `${note}; ` : ""}state.ui scaled ×${r2(k)}`;
  }
  if (map && Math.abs(map.kx - 1) < 1e-9 && Math.abs(map.ky - 1) < 1e-9 && !map.ox && !map.oy) map = null;
  return { device, pxPerPt, map, units, note };
}

/** --min-text: "2%" / "12" (px) / "11pt" (needs px per pt); default 11 pt on a device, else 2% of the height. */
function minTextOf(opt, H, geo) {
  const v = val(opt["min-text"]);
  if (v && /pt$/i.test(v)) {
    const n = parseFloat(v);
    if (!(n >= 0)) die(`--min-text wants 2%, 12 (px) or 11pt, got ${v}`);
    if (!geo.pxPerPt) die("--min-text in pt needs to know the screenshot's px per pt: a browser game, or --device iphone-15 with a PNG");
    return { px: n * geo.pxPerPt, pct: null, pt: n };
  }
  if (v == null && geo.device && geo.pxPerPt) return { px: 11 * geo.pxPerPt, pct: null, pt: 11 };
  return pctOrPx(opt["min-text"], H, "2%");
}

/** Tap targets: --min-tap N (pt with a device, else px; "Npx" px; 0 off); default 44 pt (iOS) / 48 dp (Android) on a touch device. */
function tapMinOf(opt, geo) {
  const v = val(opt["min-tap"]);
  if (v != null) {
    const n = parseFloat(v);
    if (!(n >= 0)) die(`--min-tap wants a size (44, 48, 44pt, 30px; 0 = off), got ${v}`);
    if (n === 0) return null;
    const pt = /px$/i.test(v) || !geo.pxPerPt ? null : n;
    return { px: pt != null ? n * geo.pxPerPt : n, pt, why: "--min-tap" };
  }
  const d = geo.device;
  if (!d || !d.touch || !geo.pxPerPt) return null;
  const android = /android/i.test(`${d.userAgent || ""} ${d.platform || ""} ${d.name || ""}`);
  return { px: (android ? 48 : 44) * geo.pxPerPt, pt: android ? 48 : 44, why: android ? "Android: 48 dp" : "Apple HIG: 44 pt" };
}

/**
 * measure ui --from/--to: state.ui sampled over a span: texts shown again within --within seconds of their last
 * showing (a repeated toast), and the same text shown twice at once at any sampled frame.
 */
async function uiSweep(ui, opt) {
  const within = val(opt.within) != null ? +opt.within : 10;
  if (!(within > 0)) die("--within wants seconds > 0");
  let res;
  await withGame(opt, async (s, cfg) => {
    const fps = s.fps;
    const f0 = framesOf(val(opt.from) ?? "0", fps), f1 = framesOf(val(opt.to) ?? `${f0 + 10 * fps}f`, fps);
    if (f1 <= f0) die("--to must be after --from");
    const every = val(opt.every) != null ? Math.max(1, framesOf(val(opt.every), fps)) : 1;
    const st = await begin(s, runOpts(opt, cfg));
    const frames = frameGrid(f0, f1, every);
    const r = await sampleExprs(s, st, ["state.ui"], frames);
    printLogs(await s.drainLogs());
    const [W, H] = Array.isArray(s.hello.size) ? s.hello.size : [Infinity, Infinity];
    let missing = 0;
    const samples = r.frames.map((f, i) => {
      const v = r.values[0][i];
      if (!Array.isArray(v)) { missing++; return { f, els: [] }; }
      try { return { f, els: ui.normalizeUI(v) }; } catch (e) { die(`f${f}: ${e.message}`); }
    });
    if (missing === samples.length) die("no state.ui in any sampled frame: the sweep needs the game's state.ui (see witness help measure)");
    const tl = ui.textTimeline(samples, { width: W, height: H });
    const repeats = ui.repeatedTexts(tl, { within, fps });
    const dupAt = new Map();   // text -> { first frame, frames, ids, rects }
    for (const sm of samples) for (const d of ui.duplicateTexts(sm.els, { width: W, height: H })) {
      const k = ui.normText(d.text), e = dupAt.get(k);
      if (e) { e.frames++; e.last = sm.f; } else dupAt.set(k, { text: d.text, first: sm.f, last: sm.f, frames: 1, ids: d.ids, rects: d.rects });
    }
    res = { fps, f0, f1, every, samples: samples.length, missing, tl, repeats, dups: [...dupAt.values()] };
  });
  const { fps, f0, f1, every, tl, repeats, dups } = res;
  const t = (f) => `f${f} (${fmtT(f / fps)})`;
  const rect = (q) => `${q[0]},${q[1]} ${q[2]}×${q[3]}`;
  const lines = [`measure ui sweep ${t(f0)} → ${t(f1)}, every ${every}f (${res.samples} samples${res.missing ? `, ${res.missing} without state.ui` : ""}): ${tl.size} distinct texts · repeats within ${within} s`];
  for (const r of repeats) lines.push(`  ⚠ ${r.id ? `${r.id} ` : ""}"${r.text}" shown again ${r.sinceStart} s after it last appeared: ${t(r.first.f0)}–${t(r.first.f1)} at ${rect(r.first.rect)}, then ${t(r.again.f0)} at ${rect(r.again.rect)} (hidden ${r.hidden} s between; ${r.shows} showings in the span)`);
  for (const d of dups) lines.push(`  ✖ "${d.text}" shown twice at once from ${t(d.first)} (${d.frames} sampled frame${d.frames > 1 ? "s" : ""}, to ${t(d.last)}): ${d.ids.map((id, i) => `${id} at ${rect(d.rects[i])}`).join(" and ")}`);
  if (!repeats.length && !dups.length) lines.push(`  ✔ no text shown again within ${within} s, none shown twice at once`);
  else if (repeats.length) lines.push(`  (a repeat is a warning: an element that hid and came back with the same text, a toast or a prompt shown again; gate it with --expect "repeats == 0")`);
  const shown = [...tl.values()].sort((a, b) => a.shows[0].f0 - b.shows[0].f0);
  lines.push(`  texts: ${shown.slice(0, 12).map((x) => `"${x.text.length > 30 ? x.text.slice(0, 29) + "…" : x.text}" ${x.shows.map((q) => (q.f0 === q.f1 ? `f${q.f0}` : `f${q.f0}–f${q.f1}`)).join(", ")}`).join(" · ")}${shown.length > 12 ? ` (+${shown.length - 12})` : ""}`);
  const env = envelope("measure ui", {
    ok: !dups.length,
    verdict: repeats.length || dups.length ? [repeats.length ? `${repeats.length} text${repeats.length > 1 ? "s" : ""} shown again within ${within} s` : "", dups.length ? `${dups.length} text${dups.length > 1 ? "s" : ""} shown twice at once` : ""].filter(Boolean).join(", ") : `no repeated or doubled text over ${fmtT((f1 - f0) / fps)}`,
    summary: { sweep: true, samples: res.samples, texts: tl.size, repeats: repeats.length, duplicates: dups.length, within },
    data: { from: f0, to: f1, every, fps, repeats, duplicates: dups, texts: shown.map((x) => ({ text: x.text, shows: x.shows })) },
  });
  return emit(env, lines.join("\n"), opt);
}

async function uiMeasure(m, files, opt) {
  const ui = await import("../media/ui.js");
  if (opt.from !== undefined || opt.to !== undefined) return uiSweep(ui, opt);
  // without state.ui the rows come from pixels: a frame 6 frames later tells world things (they scroll) from HUD
  const got = await getFrames(m, files, opt, null, { web: true, second: (snap) => (!val(opt.ui) && (opt.pixels || !Array.isArray(snap?.state?.ui)) ? 6 : 0) });
  let uiFile = null;
  if (val(opt.ui)) {
    const p = path.resolve(val(opt.ui));
    if (!fs.existsSync(p)) die(`no such file: ${opt.ui}`);
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    uiFile = Array.isArray(j) ? j : j.state?.ui ?? j.ui;
    if (!Array.isArray(uiFile)) die(`${opt.ui}: expected an array of UI elements, { ui: [...] } or a snapshot with state.ui`);
  }
  const alignTol = val(opt.align) != null ? +opt.align : 3;
  const results = [], written = [];
  const safeName = val(opt.safe) && /^[a-z]/i.test(val(opt.safe)) ? val(opt.safe).toLowerCase() : null;
  for (const fr of got.frames) {
    const { img } = fr, W = img.width, H = img.height;
    const geo = uiGeometry(fr, opt);
    let safe, safeM, preset = null;
    if (safeName) {
      // a frame from the game is its canvas (logical px), not a device screenshot: any size is fine
      try { preset = ui.safePreset(safeName, W, H, { fit: val(opt.fit) || "contain", canvas: !!fr.snap && !(fr.web && fr.web.mode !== "canvas") }); } catch (e) { die(`--safe: ${e.message}`); }
      safe = { px: null, pct: null }; safeM = preset.px;
    } else if (val(opt.safe) == null && geo.device && geo.pxPerPt) {
      // a phone or tablet: no generic 5% margin (every full-width bar would be "outside"); the emulated insets when the
      // page was given them (--safe-insets, a screen capture), else no safe-area check, and the preset to ask for
      const ins = fr.web && fr.web.safeInsets && fr.web.mode === "screen" ? fr.web.safeInsets : null, k = geo.pxPerPt;
      const sp = safePresetFor(geo.device);
      if (ins) { safeM = { left: ins.left * k, right: ins.right * k, top: ins.top * k, bottom: ins.bottom * k }; safe = { px: null, pct: null, note: `safe area: the emulated insets (--safe-insets ${ins.preset}: top ${ins.top}, right ${ins.right}, bottom ${ins.bottom}, left ${ins.left} pt)` }; }
      else { safeM = { x: 0, y: 0 }; safe = { px: 0, pct: null, note: `safe area not checked on ${geo.device.name} (no generic margin on a phone${sp ? `: --safe ${sp} checks the notch and home indicator zones` : ""})` }; }
    } else {
      safe = pctOrPx(opt.safe, 1, "5%");
      safeM = safe.pct != null ? safe.pct / 100 : { x: safe.px, y: safe.px };
    }
    const minT = minTextOf(opt, H, geo);
    const list = uiFile || (opt.pixels ? null : fr.snap?.state?.ui);
    let els, source;
    const panels = [], moved = [];
    if (Array.isArray(list)) {
      try { els = ui.normalizeUI(list); } catch (e) { die(e.message); }
      if (geo.map) els = ui.scaleUI(els, geo.map);
      source = uiFile ? path.basename(val(opt.ui)) : "state.ui";
    } else {
      const found = ui.findTextRows(img, { threshold: +(opt.threshold || 24) });
      if (fr.next) {
        const pal = ui.backgroundPaletteOf(img);
        found.rows = found.rows.filter((r) => { const mv = ui.worldMotion(img, fr.next.img, r, { threshold: +(opt.threshold || 24), palette: pal }); if (mv) moved.push({ rect: [r.x, r.y, r.w, r.h], dx: mv.dx, dy: mv.dy }); return !mv; });
      }
      els = found.rows.map((r) => ({ id: `text@${r.x},${r.y}`, kind: "text", x: r.x, y: r.y, w: r.w, h: r.h, text: null, fontPx: r2(r.glyphPx / 0.7), glyphPx: r.glyphPx, glyphs: r.glyphs, layer: 0 }));
      for (const p of found.panels) panels.push({ id: `panel@${p.x},${p.y}`, kind: "panel", ...p, text: null, fontPx: null, layer: 0 });
      els = els.concat(panels);
      source = "pixels";
    }
    // from pixels, glyph tops and side bearings vary: only the horizontal edges of text rows, 2 px or more apart
    const chk = ui.layoutChecks(els, { width: W, height: H, safe: safeM, minText: minT.px, alignTol, ...(source === "pixels" ? { alignEdges: ["left", "right", "centre-x"], alignMin: 2, alignKinds: ["text"] } : {}) });
    const minC = val(opt["min-contrast"]) != null ? +opt["min-contrast"] : null;
    const contrasts = [];
    const offIds = new Set(chk.offscreen.map((o) => o.id));
    const zero = els.filter((e) => !(e.w > 0 && e.h > 0) && (e.kind === "text" || e.text));
    // scrolled out of their container's window: not on screen, nothing to measure; partly: measure what shows
    const scrolledOut = new Set(chk.scrolled.filter((q) => !q.visible).map((q) => q.id));
    const scrolledPart = new Map(chk.scrolled.filter((q) => q.visible).map((q) => [q.id, { x: q.visible[0], y: q.visible[1], w: q.visible[2], h: q.visible[3] }]));
    // text not held by a panel or button sits straight on the world: its background may be busy (no plate)
    const held = (e) => els.some((p) => p !== e && (p.kind === "panel" || p.kind === "button") && p.x <= e.x && p.y <= e.y && p.x + p.w >= e.x + e.w && p.y + p.h >= e.y + e.h);
    for (const e of els) {
      if (offIds.has(e.id) || scrolledOut.has(e.id) || !(e.kind === "text" || e.text) || zero.includes(e)) continue;
      // 24 px+ text is "large" (WCAG: 18 pt ≈ 24 CSS px): in picture px that is 24 × px per pt on a device
      const need = minC ?? ((e.fontPx ?? e.h) >= 24 * (geo.device && geo.pxPerPt ? geo.pxPerPt : 1) ? 3 : 4.5);
      // gradient text (background-clip: text, marked fill: "gradient" or found from pixels): no one text colour
      if (e.fill === "gradient") { contrasts.push({ id: e.id, need, ratio: null, unmeasurable: "gradient text (marked in state.ui)" }); continue; }
      const tc = ui.textContrast(img, scrolledPart.get(e.id) || e);
      if (tc && tc.unreliable) { contrasts.push({ id: e.id, need, ratio: null, unmeasurable: `gradient text (its colour changes along ${tc.unreliable.axis}: ${tc.unreliable.channel} by ${tc.unreliable.range} levels)`, estimate: tc.ratio }); continue; }
      const outlined = tc && tc.outline && tc.outline.textVsOutline >= need;
      const plate = e.kind === "text" && !held(e) && !outlined && !scrolledPart.has(e.id) ? ui.plateCheck(img, e, { need }) : null;
      contrasts.push({ id: e.id, need, ...(tc ? tc : { ratio: null }), ...(plate ? { plate } : {}) });
    }
    const dups = source === "pixels"
      ? ui.pixelDuplicates(img, els.filter((e) => e.kind === "text")).map((d) => ({ ids: [d.a.id, d.b.id], rects: [[d.a.x, d.a.y, d.a.w, d.a.h], [d.b.x, d.b.y, d.b.w, d.b.h]], iou: d.iou }))
      : ui.duplicateTexts(els, { width: W, height: H });
    // pixel mode: things touching the screen edge may be cut off
    const touching = source === "pixels" ? els.filter((e) => e.x <= 0 || e.y <= 0 || e.x + e.w >= W || e.y + e.h >= H).map((e) => e.id) : [];
    const byId = new Map(els.map((e) => [e.id, e]));
    const name = (id) => { const e = byId.get(id); return `${id} (${e.kind}${e.text ? ` "${e.text.length > 24 ? e.text.slice(0, 23) + "…" : e.text}"` : ""})`; };
    const F = [];
    const add = (level, kind, ids, text, extra = {}) => F.push({ level, kind, ids, text, ...extra });
    for (const c of chk.clipped) add("fail", "clipped", [c.id], `${name(c.id)} clipped: ${Object.entries(c.past).map(([k, v]) => `${v} px past the ${k} edge`).join(", ")} (${c.visiblePercent}% visible)`);
    for (const c of chk.offscreen) { const e = byId.get(c.id); add("fail", "offscreen", [c.id], `${name(c.id)} entirely off screen (rect ${e.x},${e.y} ${e.w}×${e.h}; screen ${W}×${H})`); }
    for (const id of touching) if (!chk.clipped.some((c) => c.id === id)) add("warn", "edge", [id], `${name(id)} touches the screen edge (cut off?)`);
    for (const o of chk.overlaps) add("fail", "overlap", [o.a, o.b], `${name(o.a)} and ${name(o.b)} overlap by ${o.rect[2]}×${o.rect[3]} px at ${o.rect[0]},${o.rect[1]}`);
    for (const e of zero) add("warn", "zero-size", [e.id], `${name(e.id)}: zero-size rect (${e.w}×${e.h}): nothing to measure`);
    for (const s of chk.small) { const e = byId.get(s.id); if (zero.includes(e)) continue; add("fail", "small", [s.id], source === "pixels" ? `${name(s.id)} glyphs ${e.glyphPx} px tall (≈ ${s.fontPx} px font) < ${r2(chk.minText)} px` : `${name(s.id)} ${s.estimated ? "rect height" : "font"} ${s.fontPx} px < ${r2(chk.minText)} px`); }
    // tap targets: tappable elements on screen under the platform minimum (their hit box when listed)
    const tapMin = source === "pixels" ? null : tapMinOf(opt, geo);
    const taps = tapMin ? ui.tapTargets(els, { minX: tapMin.px, minY: tapMin.px, skip: new Set([...offIds, ...scrolledOut]) }) : [];
    const inPt = (v) => (tapMin && tapMin.pt != null ? `${r2(v / geo.pxPerPt)}` : `${r2(v)}`);
    for (const t of taps) add("fail", "tap", [t.id], `${name(t.id)} tap target ${t.hit ? "(hit box) " : ""}${inPt(t.w)}×${inPt(t.h)} ${tapMin.pt != null ? "pt" : "px"} < ${tapMin.pt ?? r2(tapMin.px)}×${tapMin.pt ?? r2(tapMin.px)} ${tapMin.pt != null ? "pt" : "px"} (${tapMin.why})`);
    for (const c of contrasts) {
      if (c.ratio == null) { if (c.unmeasurable) continue; const e = byId.get(c.id); if (e.text) add("warn", "invisible", [c.id], `${name(c.id)}: its rect is one flat colour (text not drawn?)`); continue; }
      if (c.plate && c.plate.busy) {
        // over a busy background the averaged ratio hides the weak spots: judge the worst glyph edge instead
        const p = c.plate, g = p.edge;
        // a stray pixel (a flower, a sparkle) touching one letter isn't unreadable text: ✖ when over 10% of the glyph
        // edges are under the bar (p10 under it), ⚠ for a few (3+), the worst pixel as context
        const detail = `${g.under} of ${g.n} glyph edges under ${c.need}:1 (${Math.round(g.underShare * 100)}%); p10 ${g.p10.toFixed(2)}, median ${g.median.toFixed(2)}, worst ${g.worst.toFixed(2)} (${rgb(g.textAt)} on ${rgb(g.bgAt)} at ${g.at.join(",")}); background ${Math.round(p.bgShare * 100)}% one colour`;
        if (g.underShare > 0.1) add("fail", "no-plate", [c.id], `${name(c.id)} over the world without a plate: ${detail}`, { worst: g.worst, p10: g.p10, underShare: g.underShare, at: g.at });
        else if (g.under >= 3) add("warn", "no-plate", [c.id], `${name(c.id)} over the world without a plate, a few weak spots: ${detail}`, { worst: g.worst, p10: g.p10, underShare: g.underShare, at: g.at });
        continue;
      }
      const ol = c.outline ? ` (outlined in ${rgb(c.outline.color)}: text/outline ${c.outline.textVsOutline.toFixed(2)}, outline/background ${c.outline.outlineVsBg.toFixed(2)}, without the outline ${c.outline.plainRatio.toFixed(2)})` : "";
      if (c.ratio < c.need) add("fail", "contrast", [c.id], `${name(c.id)} contrast ${c.ratio.toFixed(2)}:1 < ${c.need} (text ${rgb(c.fg)} on ${rgb(c.bg)})${ol}`);
    }
    for (const d of dups) {
      if (source === "pixels") add("warn", "duplicate", d.ids, `the same text twice? ${d.ids[0]} and ${d.ids[1]} have the same ink (${Math.round(d.iou * 100)}% overlap): ${d.rects.map((r) => `${r[0]},${r[1]} ${r[2]}×${r[3]}`).join(" and ")}`);
      else add("fail", "duplicate", d.ids, `"${d.text}" shown ${d.ids.length === 2 ? "twice" : `${d.ids.length} times`} at once: ${d.ids.map((id, i) => `${id} at ${d.rects[i][0]},${d.rects[i][1]} ${d.rects[i][2]}×${d.rects[i][3]}`).join(" and ")}`);
    }
    for (const u of chk.unsafe) {
      if (touching.includes(u.id)) continue;
      if (!preset) { add("warn", "safe", [u.id], `${name(u.id)} outside the safe area: ${Object.entries(u.into).map(([k, v]) => `${v} px into the ${k} margin`).join(", ")}`); continue; }
      const e = byId.get(u.id), zones = Object.keys(u.into).map((k) => preset.zones[k] || `${k} edge`);
      // stretched over another aspect the zones are a guess: warnings only
      add(e.kind === "panel" || preset.demote ? "warn" : "fail", "safe", [u.id], `${name(u.id)} in the ${safeName} unsafe zone: ${Object.entries(u.into).map(([k, v]) => `${preset.zones[k] || `${k} edge`} (${v} px into the ${preset.px[k]} px ${k} inset)`).join(", ")}${e.kind === "panel" ? " (a panel: a background may extend there, keep its content out)" : ""}`, { zones });
    }
    for (const a of chk.aligned) add("warn", "align", [a.a, a.b], `${a.a} / ${a.b} almost aligned: ${a.edges.map((e) => `${e.edge} ${e.a} vs ${e.b}`).join(", ")} (${Math.max(...a.edges.map((e) => e.diff))} px off)`);
    const fails = F.filter((f) => f.level === "fail").length, warns = F.length - fails;
    const readable = contrasts.filter((c) => c.ratio != null && (c.plate && c.plate.busy ? c.plate.edge.worst >= c.need : c.ratio >= c.need) && !chk.small.some((s) => s.id === c.id));
    // the annotated picture
    if (val(opt.out) || opt.picture) {
      const bad = new Set(F.filter((f) => f.level === "fail").flatMap((f) => f.ids)), warn = new Set(F.filter((f) => f.level === "warn").flatMap((f) => f.ids));
      const items = els.filter((e) => e.w > 0 && e.h > 0).map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h, label: e.id, color: bad.has(e.id) ? "#ff4d5e" : warn.has(e.id) ? "#ffd166" : "#3ddc97" }));
      const M = chk.margins, ml = M.left ?? M.x, mr = M.right ?? M.x, mt = M.top ?? M.y, mb = M.bottom ?? M.y;
      items.push({ x: ml, y: mt, w: W - ml - mr, h: H - mt - mb, color: "#8ecae6" });
      const png = m.annotate(img, items, { title: `ui ${fr.label}: red problem · yellow warning · green fine · blue safe area` });
      const dir = outDir(opt, got);
      const file = val(opt.out) && /\.png$/i.test(val(opt.out)) ? path.resolve(val(opt.out).replace(/\.png$/i, got.frames.length > 1 && fr.window ? `-${fr.window}.png` : ".png")) : path.join(dir, `${stemOf(got, "ui")}-ui${fr.window ? `-${fr.window}` : ""}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, png);
      written.push(file);
    }
    if (source === "pixels") for (const f of F) f.confidence = "low";
    results.push({ fr, W, H, source, els, chk, contrasts, F, fails, warns, readable, minT, safe, preset, dups, moved, geo, tapMin });
  }
  // text
  const lines = [];
  for (const r of results) {
    const heur = r.source === "pixels";
    lines.push(`measure ui ${r.fr.label} (${r.W}×${r.H}): ${heur ? `no state.ui — ${r.els.filter((e) => e.kind === "text").length} text-like rows and ${r.els.filter((e) => e.kind === "panel").length} panels found from pixels` : `${r.els.length} elements from ${r.source}`}`);
    if (heur) lines.push(`  ? low confidence: pixel guesses (thin-stroke glyph rows on one baseline; world art can still pass) → list the HUD in state.ui = [{id, kind, rect, text}] for exact checks`);
    if (r.moved.length) lines.push(`  · ${r.moved.length} text-like row${r.moved.length > 1 ? "s" : ""} moved with the world from ${r.fr.label} to f${r.fr.next.f} (${r.moved.slice(0, 4).map((q) => `${q.rect[0]},${q.rect[1]} ${q.rect[2]}×${q.rect[3]} by ${q.dx},${q.dy}`).join("; ")}): left out as world art, not HUD`);
    if (r.preset) {
      const p = r.preset;
      const side = (k) => `${k} ${p.insetsPt[k]} pt = ${p.px[k]} px${p.px[k] === 0 ? " (inside the bars)" : ` (${p.zones[k] || k})`}`;
      lines.push(`  safe area ${p.name}: ${p.device}, ${p.orientation} ${p.pt.join("×")} pt @${p.dpr}x · env(safe-area-inset-*) ${["top", "bottom", "left", "right"].filter((k) => p.insetsPt[k]).map(side).join(" · ") || "none"}${p.mismatch ? "" : ` (${p.scale.x} px/pt${p.fit === "stretch" && p.scale.x !== p.scale.y ? ` across, ${p.scale.y} down` : ""})`}`);
      if (p.mismatch) lines.push(`  ${p.demote ? "⚠" : "·"} ${p.mismatch}`);
      if (p.sizeNote) lines.push(`  ⚠ ${p.sizeNote}`);
      if (p.canvasNote) lines.push(`  · ${p.canvasNote}`);
    }
    if (r.geo.note) lines.push(`  · ${r.geo.note}`);
    lines.push(`  ${r.preset ? "" : r.safe.note ? `${r.safe.note} · ` : `safe area ${r.safe.pct != null ? `${r.safe.pct}% = ` : ""}${r.chk.margins.x}×${r.chk.margins.y} px margins · `}min text ${r2(r.chk.minText)} px${r.minT.pct != null ? ` (${r.minT.pct}% of ${r.H})` : r.minT.pt != null ? ` (${r.minT.pt} pt)` : ""}${heur ? " (glyph height ≈ 0.7 × font px)" : ""} · text contrast ≥ ${val(opt["min-contrast"]) ?? `4.5 (3 for ${r.geo.device && r.geo.pxPerPt ? "24 pt" : "24 px"}+)`}${r.tapMin ? ` · tap targets ≥ ${r.tapMin.pt != null ? `${r.tapMin.pt} pt` : `${r2(r.tapMin.px)} px`} (${r.tapMin.why})` : ""} · edges within ${alignTol} px`);
    if (r.chk.scrolled.length) {
      const out = r.chk.scrolled.filter((q) => !q.visible).length, part = r.chk.scrolled.length - out, guessed = r.chk.scrolled.filter((q) => q.guessed).length;
      lines.push(`  · ${r.chk.scrolled.length} element${r.chk.scrolled.length > 1 ? "s" : ""} cut by a scroll container (${out} scrolled out of view, ${part} partly visible): not clipped or off screen, left out of the layout checks${guessed ? ` (${guessed} matched to a scroll: true container by position; give them "parent": "<container id>" to be exact)` : ""}`);
    }
    for (const c of r.contrasts.filter((q) => q.unmeasurable)) lines.push(`  · ${c.id}: contrast not measurable, ${c.unmeasurable}${c.estimate != null ? ` (a single-colour estimate would say ${c.estimate.toFixed(2)}:1)` : ""}`);
    lines.push(r.F.length ? `  ${r.fails ? "✖" : "⚠"} ${r.fails} problem${r.fails === 1 ? "" : "s"}, ${r.warns} warning${r.warns === 1 ? "" : "s"}${heur ? " (low confidence)" : ""}` : r.els.length ? `  ✔ no layout problems` : "  nothing to check: no UI elements found");
    for (const f of r.F) lines.push(`  ${f.level === "fail" ? "✖" : "⚠"} ${f.text}`);
    if (r.readable.length) lines.push(`  ✔ readable: ${r.readable.slice(0, 8).map((c) => { const e = r.els.find((x) => x.id === c.id); return `${c.id} ${e.glyphPx != null ? `glyphs ${e.glyphPx}` : e.fontPx ?? e.h} px ${c.ratio.toFixed(1)}:1${c.outline ? ` (outline; ${c.outline.plainRatio.toFixed(1)}:1 without)` : ""}`; }).join(" · ")}${r.readable.length > 8 ? ` (+${r.readable.length - 8})` : ""}`);
  }
  if (results.length > 1) {
    // the same finding at two sizes: the same kind on the same elements
    const key = (f) => `${f.kind}:${f.ids.join("+")}`;
    const all = results.map((r) => new Map(r.F.filter((f) => f.level === "fail").map((f) => [key(f), f.text])));
    const common = [...all[0].keys()].filter((k) => all.every((s) => s.has(k)));
    lines.push(`windows: ${results.map((r) => `${r.fr.window || "default"} ${r.fails} problems`).join(" · ")}${common.length ? ` (${common.length} at every size)` : ""}`);
    results.forEach((r, i) => { const only = [...all[i]].filter(([k]) => !common.includes(k)).map(([, t]) => t); if (only.length) lines.push(`  only at ${r.fr.window || "default"}: ${only.join(" · ")}`); });
  }
  if (written.length) lines.push(`picture: ${written.join(", ")} (open it: boxes by status, the safe area in blue)`);
  const first = results[0];
  const count = (r, k) => r.F.filter((f) => f.kind === k).length;
  const sumOf = (r) => ({ elements: r.els.length, source: r.source, problems: r.fails, warnings: r.warns, clipped: count(r, "clipped"), offscreen: count(r, "offscreen"), overlaps: count(r, "overlap"), smallText: count(r, "small"), lowContrast: count(r, "contrast"), noPlate: count(r, "no-plate"), duplicates: count(r, "duplicate"), unsafe: count(r, "safe"), misaligned: count(r, "align"), touchingEdge: count(r, "edge"), smallTapTargets: count(r, "tap"), scrolled: r.chk.scrolled.length, contrastUnmeasurable: r.contrasts.filter((c) => c.unmeasurable).length, ...(r.geo.pxPerPt ? { pxPerPt: r2(r.geo.pxPerPt) } : {}), confidence: r.source === "pixels" ? "low" : "exact", ...(r.source === "pixels" ? { movedWithWorld: r.moved.length } : {}), ...(r.preset ? { safePreset: r.preset.name } : {}) });
  const dataOf = (r) => ({
    frame: r.fr.f ?? null, window: r.fr.window ?? null, width: r.W, height: r.H, source: r.source, margins: r.chk.margins, minText: r.chk.minText,
    ...(r.geo.pxPerPt ? { pxPerPt: r2(r.geo.pxPerPt) } : {}), ...(r.geo.map ? { uiMap: r.geo.map, uiUnits: r.geo.units } : {}), ...(r.tapMin ? { minTap: { px: r2(r.tapMin.px), pt: r.tapMin.pt, why: r.tapMin.why } } : {}), ...(r.fr.web ? { capture: r.fr.web.mode } : {}),
    elements: r.els.map((e) => ({ id: e.id, kind: e.kind, rect: [e.x, e.y, e.w, e.h], text: e.text, fontPx: e.fontPx, ...(e.tap ? { tap: true } : {}), ...(e.hit ? { hit: [e.hit.x, e.hit.y, e.hit.w, e.hit.h] } : {}), ...(e.scroll ? { scroll: e.scroll } : {}), ...(e.fill ? { fill: e.fill } : {}), ...(e.glyphPx != null ? { glyphPx: e.glyphPx, glyphs: e.glyphs } : {}) })),
    findings: r.F, contrast: r.contrasts, duplicates: r.dups, ...(r.source === "pixels" ? { movedWithWorld: r.moved } : {}), ...(r.preset ? { safe: r.preset } : {}), checks: { clipped: r.chk.clipped, offscreen: r.chk.offscreen, unsafe: r.chk.unsafe, overlaps: r.chk.overlaps, small: r.chk.small, aligned: r.chk.aligned, scrolled: r.chk.scrolled },
  });
  const totalFails = results.reduce((s, r) => s + r.fails, 0);
  const env = envelope("measure ui", {
    ok: totalFails === 0,
    verdict: results.length > 1 ? `${totalFails} UI problems over ${results.length} window sizes` : first.F.length ? `${first.fails} UI problems, ${first.warns} warnings${first.source === "pixels" ? " (pixel heuristic)" : ""}` : !first.els.length ? "no UI elements found" : `UI layout clean (${first.els.length} elements${first.source === "pixels" ? ", pixel heuristic" : ""})`,
    summary: results.length > 1 ? { problems: totalFails, warnings: results.reduce((s, r) => s + r.warns, 0), source: first.source, windows: results.map((r) => ({ window: r.fr.window, ...sumOf(r) })) } : sumOf(first),
    data: results.length > 1 ? { windows: results.map(dataOf) } : dataOf(first),
    files: written,
  });
  return emit(env, lines.join("\n"), opt);
}

// ------------------------------------------------------------------ measure colorblind

function parseColors(c, s) {
  return String(s).split(",").map((t) => t.trim()).filter(Boolean).map((t, i) => {
    const eq = t.indexOf("=");
    const nm = eq > 0 ? t.slice(0, eq).trim() : null, col = eq > 0 ? t.slice(eq + 1).trim() : t;
    let v;
    try { v = c.parsePalette(col)[0]; } catch { die(`--colors: "${t}" is not name=#rrggbb or #rrggbb`); }
    return { name: nm || c.hex(v), color: v };
  });
}

/** Each entity type's main sprite colour: the sprites matched to state positions, their most common colour. */
function entityColors(m, c, img, snap, types, opt) {
  const ents = entitiesOf(snap, types);
  if (!ents.length) return { reason: "no entities with a position in state.entities" };
  const blobs = m.findBlobs(img, { threshold: +(opt.threshold || 24) });
  const fit = m.fitProjection(ents, blobs, { hint: cameraHint(snap) });
  if (!fit.ok) return { reason: `state → screen didn't fit (${fit.reason})` };
  const pal = c.dominantColors(img, { max: 4, minShare: 0.05 }).map((d) => d.color);
  const bg = pal[0];
  const per = new Map();
  const d = img.data, W = img.width;
  for (const q of fit.all) {
    const b = q.blob.bbox, t = q.entity.type;
    const acc = per.get(t) || { buckets: new Map(), n: 0 };
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
      const o = (y * W + x) * 4;
      if (pal.some((p) => Math.abs(d[o] - p[0]) <= 24 && Math.abs(d[o + 1] - p[1]) <= 24 && Math.abs(d[o + 2] - p[2]) <= 24)) continue;
      const k = ((d[o] >> 4) << 8) | ((d[o + 1] >> 4) << 4) | (d[o + 2] >> 4);
      const e = acc.buckets.get(k) || [0, 0, 0, 0];
      e[0] += d[o]; e[1] += d[o + 1]; e[2] += d[o + 2]; e[3]++;
      acc.buckets.set(k, e);
    }
    acc.n++;
    per.set(t, acc);
  }
  const colors = [];
  for (const [t, acc] of per) {
    const top = [...acc.buckets.values()].sort((a, b) => b[3] - a[3])[0];
    if (top) colors.push({ name: t, color: [top[0], top[1], top[2]].map((v) => Math.round(v / top[3])), sprites: acc.n });
  }
  if (bg) colors.push({ name: "background", color: bg });
  return { colors, matched: fit.matched, total: fit.total };
}

async function colorblindMeasure(m, c, files, opt) {
  const tsel = val(opt.type) || "all";
  const types = tsel === "all" ? ["protan", "deutan", "tritan"] : tsel.split(",").map((t) => t.trim());
  for (const t of types) if (!c.CVD_TYPES.includes(t)) die(`--type is protan, deutan, tritan, achroma or all (got ${t})`);
  const minDE = val(opt["min-de"]) != null ? +opt["min-de"] : 20;
  const got = await getFrames(m, files, opt);
  const fr = got.frames[0], img = fr.img;
  let colors, source, note = "";
  if (val(opt.colors)) { colors = parseColors(c, opt.colors); source = "given"; }
  else if (fr.snap && !opt.dominant) {
    const ec = entityColors(m, c, img, fr.snap, val(opt.types) ? val(opt.types).split(",").map((t) => t.trim()) : null, opt);
    if (ec.colors && ec.colors.length >= 2) { colors = ec.colors; source = "entities"; note = `sprite colours of ${ec.colors.length - 1} entity types (${ec.matched} of ${ec.total} entities found on screen) + the background`; }
    else note = `${ec.reason || "fewer than 2 entity colours"}: using the picture's most common colours`;
  }
  if (!colors) {
    colors = c.dominantColors(img, { max: +(opt.max || 8), minShare: 0.002 }).map((d) => ({ name: d.hex, color: d.color, share: d.share }));
    source = "dominant";
    note = note || `the ${colors.length} most common colours (each ≥ 0.2% of the picture)`;
  }
  if (colors.length < 2 && !(opt.a && opt.b)) die("need at least 2 colours to compare (--colors name=#hex,name=#hex)");
  const pairs = colors.length >= 2 ? c.pairsUnderCVD(colors, { types, minDE }) : [];
  // masks: the contrast of two pixel sets under each type
  let maskRes = null;
  const sims = Object.fromEntries(types.map((t) => [t, c.simulateCVD(img, t)]));
  if (opt.a && opt.b) {
    const mask = (spec) => {
      const s = String(spec);
      if (s.startsWith("#") || s.startsWith("rgb")) { const [col, tol] = s.split("~"); return m.maskFromColor(img, col, +(tol || 0)); }
      if (s.startsWith("diff:")) { const p = path.resolve(s.slice(5)); if (!fs.existsSync(p)) die(`no such image: ${s.slice(5)}`); return m.maskDiff(img, fs.readFileSync(p), { threshold: +(opt.threshold || 16) }).mask; }
      return m.maskFromRect(img.width, img.height, parseRect(s));
    };
    const A = mask(opt.a);
    const B = /^ring(:\d+)?$/.test(String(opt.b)) ? m.ringMask(A, img.width, img.height, +(String(opt.b).split(":")[1] || 2)) : mask(opt.b);
    maskRes = { normal: m.contrast(img, A, B) };
    for (const t of types) maskRes[t] = m.contrast(sims[t], A, B);
  }
  // pictures
  const written = [];
  if (!opt["no-images"]) {
    const dir = outDir(opt, got), stem = stemOf(got, "colorblind");
    fs.mkdirSync(dir, { recursive: true });
    for (const t of types) { const f = path.join(dir, `${stem}-${t}.png`); fs.writeFileSync(f, m.encodePNG(img.width, img.height, sims[t].data)); written.push(f); }
    const cells = [{ img, label: "normal vision" }, ...types.map((t) => ({ img: sims[t], label: c.TYPE_NAMES[t] }))];
    const sheet = m.contactSheet(cells, { cols: cells.length === 4 ? 2 : Math.min(cells.length, 3), title: `colour-vision simulation (Machado 2009): ${fr.label}`, subtitle: "the same frame as seen with each deficiency" });
    const f = path.join(dir, `${stem}-cvd.png`);
    fs.writeFileSync(f, sheet.png);
    written.unshift(f);
  }
  // text
  const lines = [`measure colorblind ${fr.label} (${img.width}×${img.height}): ${note || `${colors.length} given colours`} · confusable below ΔE ${minDE}`];
  if (colors.length) lines.push(`  colours: ${colors.map((k) => `${k.name}${k.name.startsWith("#") ? "" : ` ${c.hex(k.color)}`}${k.share != null ? ` ${r2(k.share * 100)}%` : ""}`).join(" · ")}`);
  const fmtPair = (p, t) => `${p.a} vs ${p.b} ΔE ${p.normal.deltaE} → ${p.types[t].deltaE}`;
  if (pairs.length) {
    const nAlready = pairs.filter((p) => p.normal.deltaE < minDE);
    const minN = pairs.reduce((a, p) => (p.normal.deltaE < a.normal.deltaE ? p : a));
    lines.push(`  normal: ${nAlready.length ? `⚠ ${nAlready.length} pair${nAlready.length > 1 ? "s" : ""} already close (${nAlready.slice(0, 3).map((p) => `${p.a} vs ${p.b} ΔE ${p.normal.deltaE}`).join(", ")})` : (pairs.length === 1 ? "distinct" : `all ${pairs.length} pairs distinct`)} · closest ${minN.a} vs ${minN.b} ΔE ${minN.normal.deltaE}`);
    for (const t of types) {
      const lost = pairs.filter((p) => p.lost.includes(t)).sort((a, b) => a.types[t].deltaE - b.types[t].deltaE);
      const closest = pairs.reduce((a, p) => (p.types[t].deltaE < a.types[t].deltaE ? p : a));
      lines.push(lost.length ? `  ✖ ${t}: ${lost.length} pair${lost.length > 1 ? "s" : ""} ${lost.length > 1 ? "become" : "becomes"} confusable: ${lost.slice(0, 6).map((p) => fmtPair(p, t)).join(" · ")}` : `  ✔ ${t}: still distinct · closest ${fmtPair(closest, t)}`);
    }
  }
  if (maskRes) lines.push(`  --a vs --b: ${["normal", ...types].map((t) => `${t} ${maskRes[t].ratio.toFixed(2)}:1 ΔE ${maskRes[t].deltaE.toFixed(1)}${t !== "normal" && maskRes.normal.deltaE >= minDE && maskRes[t].deltaE < minDE ? " ✖" : ""}`).join(" · ")}`);
  if (written.length) lines.push(`  pictures: ${written[0]} (normal + each type side by side: open it and look)${written.length > 1 ? `; one per type: ${written.slice(1).map((f) => path.basename(f)).join(", ")}` : ""}`);
  const lostBy = Object.fromEntries(types.map((t) => [t, pairs.filter((p) => p.lost.includes(t)).length]));
  const minBy = Object.fromEntries(types.map((t) => [t, pairs.length ? Math.min(...pairs.map((p) => p.types[t].deltaE)) : null]));
  const lostTotal = pairs.filter((p) => p.lost.length).length + (maskRes ? types.filter((t) => maskRes.normal.deltaE >= minDE && maskRes[t].deltaE < minDE).length : 0);
  const env = envelope("measure colorblind", {
    ok: lostTotal === 0,
    verdict: lostTotal ? `${Object.entries(lostBy).filter(([, n]) => n).map(([t, n]) => `${n} pair${n > 1 ? "s" : ""} confusable under ${t}`).join(", ") || "the --a/--b pair becomes confusable"}` : `key colours stay distinct under ${types.join(", ")}`,
    summary: { colors: colors.length, source, pairs: pairs.length, minDE, lost: lostBy, lostPairs: pairs.filter((p) => p.lost.length).length, minDeltaE: { normal: pairs.length ? Math.min(...pairs.map((p) => p.normal.deltaE)) : null, ...minBy }, ...(maskRes ? { maskDeltaE: Object.fromEntries(Object.entries(maskRes).map(([t, r]) => [t, r.deltaE])) } : {}) },
    data: { types, colors: colors.map((k) => ({ name: k.name, hex: c.hex(k.color), ...(k.share != null ? { share: k.share } : {}), ...(k.sprites ? { sprites: k.sprites } : {}) })), pairs, masks: maskRes },
    files: written,
  });
  return emit(env, lines.join("\n"), opt);
}

// ------------------------------------------------------------------ measure palette

async function paletteMeasure(m, c, files, opt) {
  const got = await getFrames(m, files, opt);
  const fr = got.frames[0], img = fr.img;
  const region = val(opt.region) ? parseRect(val(opt.region)) : null;
  const max = val(opt.max) != null ? +opt.max : null;
  const list = val(opt.list) != null ? +opt.list : 20;
  let palette = null, palName = null;
  if (val(opt.palette)) {
    const spec = val(opt.palette), p = path.resolve(spec);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        palName = path.basename(p);
        palette = /\.png$/i.test(p) ? c.paletteOfImage(m.decodePNG(fs.readFileSync(p))) : c.parsePalette(fs.readFileSync(p, "utf8"), path.extname(p).slice(1).toLowerCase());
      } else { palette = c.parsePalette(spec); palName = "given"; }
    } catch (e) { die(`--palette ${spec}: ${e.message}`); }
    if (palette.length > 4096) die(`--palette has ${palette.length} colours: is that a palette?`);
  }
  const budget = c.colorBudget(img, max, { region });
  const lines = [`measure palette ${fr.label} (${img.width}×${img.height}${region ? `, region ${region.x},${region.y} ${region.w}×${region.h}` : ""}): ${budget.colors} distinct colours in ${budget.pixels} px`];
  lines.push(`  most used: ${budget.top.slice(0, 8).map((t) => `${t.hex} ${r2(t.share * 100)}%`).join(" · ")}`);
  if (budget.rare.colors) lines.push(`  ${budget.rare.colors} colours under 0.1% each (${budget.rare.pixels} px): ${budget.rare.colors > 16 ? "blending, anti-aliasing or scaling blur? (pixel art usually has none)" : "rare details or stray pixels"}`);
  let pc = null;
  const written = [];
  if (palette) {
    pc = c.paletteCheck(img, palette, { tolerance: +(opt.tolerance || 0), region, list });
    if (!pc.offPixels) lines.push(`  ✔ every pixel is on the ${palette.length}-colour palette (${palName})${pc.unused.length ? ` · unused: ${pc.unused.slice(0, 12).join(" ")}${pc.unused.length > 12 ? ` (+${pc.unused.length - 12})` : ""}` : ""}`);
    else {
      lines.push(`  ✖ ${pc.offPixels} px off the ${palette.length}-colour palette (${pc.offPercent}%), ${pc.offColors.length} colour${pc.offColors.length > 1 ? "s" : ""}, within x=${pc.bbox.x} y=${pc.bbox.y} ${pc.bbox.w}×${pc.bbox.h}`);
      for (const o of pc.offColors.slice(0, 10)) lines.push(`    ${o.hex} ×${o.count} first at ${o.first.join(",")}, box x=${o.bbox.x} y=${o.bbox.y} ${o.bbox.w}×${o.bbox.h} → nearest ${o.nearest} (ΔE ${o.deltaE})`);
      if (pc.offColors.length > 10) lines.push(`    … ${pc.offColors.length - 10} more colours`);
      lines.push(`    first ${pc.sample.length} px: ${pc.sample.map((p) => p.join(",")).join(" ")}`);
      if (val(opt.out)) {
        const file = /\.png$/i.test(val(opt.out)) ? path.resolve(val(opt.out)) : path.join(path.resolve(val(opt.out)), `${stemOf(got, "palette")}-offpalette.png`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const im = c.offPaletteImage(img, pc.mask);
        fs.writeFileSync(file, m.encodePNG(im.width, im.height, im.data));
        written.push(file);
        lines.push(`    picture: ${file} (off-palette pixels in magenta)`);
      } else lines.push("    (--out off.png draws them in magenta)");
      if (pc.unused.length) lines.push(`  unused palette colours: ${pc.unused.slice(0, 12).join(" ")}${pc.unused.length > 12 ? ` (+${pc.unused.length - 12})` : ""}`);
    }
  }
  if (max != null) {
    if (!budget.over) lines.push(`  ✔ ${budget.colors} colours ≤ max ${max}`);
    else {
      lines.push(`  ✖ ${budget.colors} colours > max ${max} (${budget.colors - max} too many); least used:`);
      for (const l of budget.leastUsed) lines.push(`    ${l.hex} ×${l.count} first at ${l.first.join(",")}${l.nearest ? ` → closest ${l.nearest} (ΔE ${l.deltaE})` : ""}`);
    }
  }
  const ok = !(pc && pc.offPixels) && !budget.over;
  const env = envelope("measure palette", {
    ok,
    verdict: pc ? (pc.offPixels ? `${pc.offPixels} px off the palette (${pc.offColors.length} colours)` : "every pixel on the palette") + (budget.over ? `, ${budget.colors} colours > max ${max}` : "") : max != null ? (budget.over ? `${budget.colors} colours > max ${max}` : `${budget.colors} colours ≤ max ${max}`) : `${budget.colors} colours`,
    summary: { colors: budget.colors, pixels: budget.pixels, rareColors: budget.rare.colors, ...(max != null ? { max, over: budget.over } : {}), ...(pc ? { paletteSize: palette.length, offPixels: pc.offPixels, offPercent: pc.offPercent, offColors: pc.offColors.length, unused: pc.unused.length } : {}) },
    data: { top: budget.top, rare: budget.rare, leastUsed: budget.leastUsed, ...(pc ? { offColors: pc.offColors.map(({ color, ...o }) => o), sample: pc.sample, bbox: pc.bbox, unused: pc.unused } : {}) },
    files: written,
  });
  return emit(env, lines.join("\n"), opt);
}

// ------------------------------------------------------------------ measure figure

/** "a,b" -> ["a", "b"]; a JSON array of objects for --params stays one list of param sets. */
function paramSets(spec) {
  if (spec == null) return [undefined];
  let v;
  try { v = JSON.parse(spec); } catch (e) { die(`--params: ${e.message}`); }
  if (Array.isArray(v)) { if (!v.length || v.some((p) => !p || typeof p !== "object" || Array.isArray(p))) die("--params: a JSON object, or an array of objects (one run each)"); return v; }
  if (!v || typeof v !== "object") die("--params: a JSON object, or an array of objects (one run each)");
  return [v];
}

/** The things --of names in a snapshot: [{ id, type, name, x, y, box, rect, label }] (state units). */
function figureTargets(snap, of, evaluate) {
  const pick = (e, label) => {
    const p = Array.isArray(e?.pos) ? e.pos : e && typeof e === "object" && "x" in e ? [e.x, e.y] : null;
    return { id: e?.id, type: e?.type ?? e?.kind ?? null, name: e?.name ?? null, x: p ? +p[0] : NaN, y: p ? +p[1] : NaN, box: Array.isArray(e?.box) ? e.box : null, rect: Array.isArray(e?.rect) ? e.rect : null, label };
  };
  if (/^state\b/.test(of)) {
    let v;
    try { v = evaluate(of, snap); } catch (e) { die(`--of ${of}: ${e.message}`); }
    if (!v || typeof v !== "object") die(`--of ${of}: not an object with a pos (got ${JSON.stringify(v)?.slice(0, 80)})`);
    const t = pick(v, of);
    if (!Number.isFinite(t.x) && !t.rect) die(`--of ${of}: no pos ([x, y]), x/y or rect`);
    return [t];
  }
  const ents = Array.isArray(snap?.state?.entities) ? snap.state.entities : [];
  const key = of.replace(/^#/, "").toLowerCase();
  const hit = ents.filter((e) => String(e.id).toLowerCase() === key || String(e.type ?? e.kind ?? "").toLowerCase() === key || String(e.name ?? "").toLowerCase() === key);
  return hit.map((e) => pick(e, `${e.type ?? e.kind ?? "?"}${e.id != null ? ` #${e.id}` : ""}`));
}

/** The pixels connected to (x, y) that differ from the background palette: a sprite found from its position. */
function blobAt(m, img, x, y, threshold = 24) {
  const W = img.width, H = img.height, d = img.data, pal = backgroundPalette(img);
  const fg = (i) => { const o = i * 4; return !pal.some((c) => Math.abs(d[o] - c[0]) <= threshold && Math.abs(d[o + 1] - c[1]) <= threshold && Math.abs(d[o + 2] - c[2]) <= threshold); };
  let seed = -1, bd = Infinity;
  for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
    const xx = Math.round(x) + dx, yy = Math.round(y) + dy;
    if (xx < 0 || yy < 0 || xx >= W || yy >= H || !fg(yy * W + xx)) continue;
    if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; seed = yy * W + xx; }
  }
  if (seed < 0) return null;
  const mask = new Uint8Array(W * H), stack = [seed];
  mask[seed] = 1;
  let n = 0;
  while (stack.length) {
    const i = stack.pop(), px = i % W, py = (i - px) / W;
    if (++n > W * H * 0.05) return null;   // spilled into the scenery: not a sprite
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = px + dx, ny = py + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (!mask[j] && fg(j)) { mask[j] = 1; stack.push(j); }
    }
  }
  return mask;
}

/** Inside a screen rect, the pixels unlike every main colour of the 3 px around it (the ground): a silhouette guess. */
function rectSilhouette(c, img, R) {
  const W = img.width, H = img.height, d = img.data;
  const x0 = Math.max(0, Math.floor(R.x)), y0 = Math.max(0, Math.floor(R.y)), x1 = Math.min(W, Math.ceil(R.x + R.w)), y1 = Math.min(H, Math.ceil(R.y + R.h));
  if (x1 <= x0 || y1 <= y0) return null;
  const counts = new Map();
  let n = 0;
  for (let y = Math.max(0, y0 - 3); y < Math.min(H, y1 + 3); y++) for (let x = Math.max(0, x0 - 3); x < Math.min(W, x1 + 3); x++) {
    if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
    const o = (y * W + x) * 4, k = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
    counts.set(k, (counts.get(k) || 0) + 1); n++;
  }
  if (!n) return null;
  const ground = c.clusterColors(counts, 10).clusters.filter((q) => q.count >= 0.05 * n).map((q) => [q.key >> 16, (q.key >> 8) & 255, q.key & 255]);
  const mask = new Uint8Array(W * H);
  let any = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * W + x) * 4, px = [d[o], d[o + 1], d[o + 2]];
    if (!ground.some((g) => c.deltaE(px, g) <= 10)) { mask[y * W + x] = 1; any++; }
  }
  return any ? mask : null;
}

/** The diff's connected regions (2 px gaps join: a sword held apart): [{ px: [indices], x, y, w, h }]. */
export function diffRegions(mask, W, H) {
  const seen = new Uint8Array(W * H), out = [];
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || seen[s]) continue;
    const px = [], stack = [s];
    seen[s] = 1;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    while (stack.length) {
      const i = stack.pop(), x = i % W, y = (i - x) / W;
      px.push(i);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    out.push({ px, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  return out;
}

/** Does a diff region belong to a thing at screen point (sx, sy) with screen rect R (either may be missing)? Its
 *  bounding box overlaps R, or comes within `near` px of the point. */
export function regionAt(g, sx, sy, R, near = 4) {
  if (R && g.x < R.x + R.w + 1 && g.x + g.w > R.x - 1 && g.y < R.y + R.h + 1 && g.y + g.h > R.y - 1) return true;
  if (!Number.isFinite(sx)) return false;
  const dx = Math.max(g.x - sx, 0, sx - (g.x + g.w - 1)), dy = Math.max(g.y - sy, 0, sy - (g.y + g.h - 1));
  return dx * dx + dy * dy <= near * near;
}

/** The gap in px between two boxes {x, y, w, h} (0 when they touch or overlap). */
const boxGap = (a, b) => Math.hypot(Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)), Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)));

/**
 * Did a diff region vanish to show the ground (a part of the hidden thing: a marker, bar, label, shadow), or does the
 * image without it hold other paint there (a draw-order change: tied sprites re-sorted)? Vanished when most of the
 * region's pixels in the without image B match a colour on the ground just around it in the with image A (ΔE ≤ 10).
 */
export function regionVanished(g, A, B, mask, near) {
  const W = A.width, H = A.height, ring = [];
  const x0 = Math.max(0, g.x - 2), y0 = Math.max(0, g.y - 2), x1 = Math.min(W - 1, g.x + g.w + 1), y1 = Math.min(H - 1, g.y + g.h + 1);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (y !== y0 && y !== y1 && x !== x0 && x !== x1) continue;
    const i = y * W + x;
    if (!mask[i]) ring.push([A.data[i * 4], A.data[i * 4 + 1], A.data[i * 4 + 2]]);
  }
  if (!ring.length) return false;
  const step = Math.max(1, Math.floor(g.px.length / 400));
  let n = 0, hit = 0;
  for (let k = 0; k < g.px.length; k += step) {
    const o = g.px[k] * 4, col = [B.data[o], B.data[o + 1], B.data[o + 2]];
    n++;
    if (ring.some((r) => near(col, r))) hit++;
  }
  return hit >= 0.6 * n;
}

/**
 * Which with/without diff regions are the hidden figure. `at`: the regions at its state position or box (may be
 * empty); sx, sy: its screen point (NaN when unknown); trusted: the screen point comes from a projection the entities
 * or state.camera confirm (not just screen = state).
 *  - kept: the regions at it; when none touches it, the nearest one (trusted point) or else the largest (`unplaced`);
 *  - parts: other regions that vanished to show the ground within one figure size of the kept ones (a health bar, a
 *    quest marker, a name tag: part of the hidden thing), added to the silhouette;
 *  - others: the rest, each { g, kind: "vanished" | "draw" } (draw: other paint there without it, a draw-order change).
 * No per-pixel spreads (a region can hold 200k+ pixels).
 */
export function figureRegions(regions, at, { sx = NaN, sy = NaN, trusted = false, A, B, mask, near }) {
  let kept = at, unplaced = false, how = "at";
  if (!kept.length) {
    unplaced = true;
    if (Number.isFinite(sx) && trusted) {
      const d = (g) => boxGap(g, { x: sx, y: sy, w: 0, h: 0 });
      kept = [regions.reduce((a, g) => (d(g) < d(a) ? g : a))]; how = "nearest";
    } else { kept = [regions.reduce((a, g) => (g.px.length > a.px.length ? g : a))]; how = "largest"; }
  }
  const K = kept.reduce((b, g) => ({ x: Math.min(b.x, g.x), y: Math.min(b.y, g.y), x1: Math.max(b.x1, g.x + g.w), y1: Math.max(b.y1, g.y + g.h) }), { x: Infinity, y: Infinity, x1: -Infinity, y1: -Infinity });
  const box = { x: K.x, y: K.y, w: K.x1 - K.x, h: K.y1 - K.y }, size = Math.max(box.w, box.h);
  const parts = [], others = [];
  for (const g of regions) {
    if (kept.includes(g)) continue;
    const kind = A && B ? (regionVanished(g, A, B, mask, near) ? "vanished" : "draw") : "vanished";
    if (kind === "vanished" && boxGap(g, box) <= size) parts.push(g); else others.push({ g, kind });
  }
  return { kept, parts, others, unplaced, how };
}

/** The elsewhere report from figureRegions().others: { pixels, regions: [[x,y,w,h]], draw, vanished } (largest first). */
function elsewhereOf(others) {
  if (!others.length) return null;
  const s = [...others].sort((a, b) => b.g.px.length - a.g.px.length);
  return { pixels: s.reduce((a, o) => a + o.g.px.length, 0), regions: s.map((o) => [o.g.x, o.g.y, o.g.w, o.g.h]), draw: s.filter((o) => o.kind === "draw").length, vanished: s.filter((o) => o.kind === "vanished").length };
}

/** The ⚠ line for diff regions left out of a figure's silhouette. */
function elsewhereLine(e) {
  const g = e.regions[0], n = e.regions.length;
  const why = !e.vanished ? "draw order / unstable sort? (other paint is there without it)"
    : !e.draw ? "parts that vanished with it, away from it (a marker, label, shadow?): give it a box to include them"
    : `${e.draw} with other paint there without it (draw order / unstable sort?), ${e.vanished} that vanished with it (a detached part?)`;
  return `⚠ ${e.pixels} px changed elsewhere (${n === 1 ? "1 region:" : `${n} regions, largest`} ${g[2]}×${g[3]} at ${g[0]},${g[1]}): ${why}. Left out of the silhouette.`;
}

async function figureMeasure(m, c, files, opt) {
  const of = val(opt.of);
  const edge = val(opt.edge) != null ? Math.max(1, Math.round(+opt.edge)) : 1;
  const merge = val(opt.merge) != null ? +opt.merge : 12;
  const min = val(opt.min) != null ? +opt.min : 3;
  const minShare = pctOrPx(opt["min-share"], 1, "5%");
  // a bare number above 1 is a percentage (--min-share 5 = 5%), up to 1 a fraction (0.05)
  if (minShare.pct == null && minShare.px > 1) { minShare.pct = minShare.px; minShare.px = minShare.px / 100; }
  if (minShare.pct != null && minShare.pct > 100) die(`--min-share is a share of the ring: 5% (or 5, or 0.05), got ${val(opt["min-share"])}`);
  const minShareF = minShare.pct != null ? minShare.pct / 100 : minShare.px;
  const threshold = +(opt.threshold || 16);
  const named = val(opt.surfaces) ? parseColors(c, opt.surfaces) : [];
  const fgOpts = { edge, merge, min, minShare: minShareF };
  const shots = [];   // { label, img, mask, method, target, mapLabel }
  if (files[0]) {
    // a PNG: the silhouette from --mask diff:<without.png> | #rrggbb[~tol] | x,y,w,h (a rect: the pixels unlike its surroundings)
    const img = readImage(m, files[0]);
    const spec = val(opt.mask);
    if (!spec) die("usage: witness measure figure <shot.png> --mask diff:<without.png> | #rrggbb[~tol] | x,y,w,h   (or --of <entity> to drive the game)");
    let mask, method, elsewhere = null, parts = null;
    if (spec.startsWith("diff:")) {
      // no position to anchor to: the largest region (plus parts beside it that vanished too), the others reported
      const p = path.resolve(spec.slice(5)); if (!fs.existsSync(p)) die(`no such image: ${spec.slice(5)}`);
      const B = readImage(m, p), d = m.maskDiff(img, B, { threshold });
      mask = d.mask; method = `with/without diff (${path.basename(p)})`;
      const regions = d.count ? diffRegions(d.mask, img.width, img.height) : [];
      if (regions.length > 1) {
        const fr = figureRegions(regions, [], { A: img, B, mask: d.mask, near: (a, b) => c.deltaE(a, b) <= 10 });
        mask = new Uint8Array(img.width * img.height);
        for (const g of [...fr.kept, ...fr.parts]) for (const i of g.px) mask[i] = 1;
        elsewhere = elsewhereOf(fr.others);
        if (fr.parts.length) parts = fr.parts.map((g) => [g.x, g.y, g.w, g.h]);
        method += `, its largest region${fr.parts.length ? ` + ${fr.parts.length} part${fr.parts.length > 1 ? "s" : ""} beside it that vanished too` : ""} (${regions.length} regions; pass a rect to choose)`;
      }
    }
    else if (spec.startsWith("#") || spec.startsWith("rgb")) { const [col, tol] = spec.split("~"); mask = m.maskFromColor(img, col, +(tol || 0)); method = `colour ${spec}`; }
    else { mask = rectSilhouette(c, img, parseRect(spec)); method = `rect ${spec} minus its surroundings' colours (a guess)`; }
    if (!mask || !mask.some((v) => v)) die(`--mask ${spec} selects no pixels`);
    shots.push({ label: path.basename(String(files[0])), img, mask, method, target: "figure", elsewhere, parts });
  } else {
    if (!of) die("usage: witness measure figure --of <Type | id | state.path> [--scenes a,b] [--params '[{...},{...}]'] [--at 1,2] [--without \"params={...}\"]");
    const { evaluate } = await import("../core/expr.js");
    const { parseVariant } = await import("./ab.js");
    const scenes = val(opt.scenes) ? val(opt.scenes).split(",").map((s) => s.trim()).filter(Boolean) : [val(opt.scene) ?? undefined];
    const sets = paramSets(val(opt.params));
    const ats = (val(opt.at) || "1").split(",").map((s) => s.trim()).filter(Boolean);
    const without = val(opt.without) ? parseVariant(opt.without, "without") : null;
    if (without && (Object.keys(without.env).length || without.cmd !== undefined)) die("--without: params=, scene=, seed= or input= (env variables and cmd= need a second process: use witness ab, then measure figure <with.png> --mask diff:<without.png>)");
    if (scenes.length * sets.length * ats.length > 24) die(`${scenes.length * sets.length * ats.length} shots: keep scenes × params × times at 24 or fewer`);
    await withGame({ ...opt, params: undefined, scene: undefined }, async (s, cfg) => {
      if (!s.has("screenshot")) die("this game's adapter doesn't support 'screenshot'");
      gamePixels(s, "measure figure", opt);
      // a second run (without the figure) in the same process: it must start from the same state
      if (!s.has("reset")) die("measure figure --of runs the scene twice in one game process (with and without the figure), which needs the adapter's 'reset': add 'reset', or save two pictures yourself and run witness measure figure <with.png> --mask diff:<without.png>");
      const base = runOpts({ ...opt, params: undefined, scene: undefined }, cfg);
      for (const scene of scenes) for (const params of sets) {
        const frames = [...new Set(ats.map((t) => framesOf(t, s.fps)))].sort((a, b) => a - b);
        const run = { ...base, scene, params: params || base.params ? { ...(base.params || {}), ...(params || {}) } : undefined };
        const st = await begin(s, run);
        const caps = [];
        for (const f of frames) { await stepTo(s, st, f); const im = await shotImage(await s.screenshot()); caps.push({ f, img: { width: im.width, height: im.height, data: Uint8Array.from(im.data) }, snap: await s.snapshot() }); }
        // the same run without the figure: --without, else the reserved "hide" param with the targets' ids (or types)
        const targets0 = figureTargets(caps[0].snap, of, evaluate);
        if (!targets0.length) die(`--of ${of}: nothing in state.entities has that id, type or name at f${caps[0].f}${scene ? ` (scene ${scene})` : ""}`);
        const hide = targets0.map((t) => t.id ?? t.type).filter((v) => v != null);
        // a target without an id is hidden by its type: every entity of that type goes, so its diff is cut to the part
        // at the target's position
        const byType = !without && targets0.some((t) => t.id == null && t.type != null);
        const runB = without
          ? { seed: without.seed ?? run.seed, scene: without.scene ?? run.scene, params: { ...(run.params || {}), ...(without.params || {}) }, input: [run.input, without.input].filter(Boolean).join(", ") || undefined }
          : hide.length ? { ...run, params: { ...(run.params || {}), hide } } : null;
        const capsB = new Map();
        if (runB) {
          const stB = await begin(s, runB);
          for (const f of frames) { await stepTo(s, stB, f); const im = await shotImage(await s.screenshot()); capsB.set(f, { width: im.width, height: im.height, data: Uint8Array.from(im.data) }); }
        }
        printLogs((await s.drainLogs()).filter((l) => l.level === "error"));
        for (const cap of caps) {
          const targets = figureTargets(cap.snap, of, evaluate);
          const ents = entitiesOf(cap.snap);
          const blobs = m.findBlobs(cap.img, { threshold: 24 });
          const fit = m.fitProjection(ents, blobs, { hint: cameraHint(cap.snap) });
          // one entity on one blob proves nothing (it lands on any sprite): use such a fit only from the game's camera
          const proj = fit.ok && (fit.matched >= 2 || fit.fromHint) ? fit : (() => { const h = cameraHint(cap.snap); return h ? { ax: h.scale, bx: h.ox, ay: h.scale, by: h.oy, assumed: "state.camera" } : { ax: 1, bx: 0, ay: 1, by: 0, assumed: "screen = state" }; })();
          const toScreen = (x, y) => [proj.ax * x + proj.bx, proj.ay * y + proj.by];
          const map = cap.snap?.state?.map;
          const mapLabel = map && Array.isArray(map.rows) && +map.cell > 0 ? (x, y) => {
            const wx = (x + 0.5 - proj.bx) / proj.ax, wy = (y + 0.5 - proj.by) / proj.ay, o = Array.isArray(map.origin) ? map.origin : [0, 0];
            const row = map.rows[Math.floor((wy - o[1]) / map.cell)], ch = row ? row[Math.floor((wx - o[0]) / map.cell)] : undefined;
            return ch === undefined ? null : `tile '${ch}'`;
          } : null;
          const B = capsB.get(cap.f);
          const diff = B ? m.maskDiff(cap.img, B, { threshold }) : null;
          const label = `${scene ? `scene ${scene} · ` : ""}${params ? `${JSON.stringify(params)} · ` : ""}f${cap.f}`;
          // screen point and rect of a thing in the state (box: [w, h] centred, or [dx, dy, w, h] from its pos)
          const placeOf = (t) => {
            const [sx, sy] = Number.isFinite(t.x) ? toScreen(t.x, t.y) : [NaN, NaN];
            const R = t.rect ? { x: t.rect[0], y: t.rect[1], w: t.rect[2], h: t.rect[3] }
              : t.box && Number.isFinite(sx) ? (t.box.length >= 4 ? { x: sx + t.box[0] * proj.ax, y: sy + t.box[1] * proj.ay, w: t.box[2] * proj.ax, h: t.box[3] * proj.ay }
                : { x: sx - (t.box[0] * proj.ax) / 2, y: sy - (t.box[1] * proj.ay) / 2, w: t.box[0] * proj.ax, h: t.box[1] * proj.ay }) : null;
            return { sx, sy, R };
          };
          // the diff's regions; those at a hidden thing (any target, or anything the hide param names) are explained
          const regions = diff && diff.count ? diffRegions(diff.mask, cap.img.width, cap.img.height) : [];
          const hiddenSet = new Set(hide.map(String));
          const hiddenPlaces = without ? [] : (cap.snap?.state?.entities || []).filter((e) => e && (hiddenSet.has(String(e.id)) || (e.id == null && hiddenSet.has(String(e.type ?? e.kind))))).map((e) => placeOf(figureTargets({ state: { entities: [e] } }, String(e.id ?? e.type ?? e.kind), evaluate)[0] || {}));
          for (const t of targets) {
            const { sx, sy, R } = placeOf(t);
            let mask = null, method = null, elsewhere = null, parts = null, unplaced = null;
            if (regions.length) {
              // keep the region(s) at the entity's position or box, plus parts beside them that vanished with it (a
              // health bar, a quest marker); others are reported (a draw-order change far away, e.g. an unstable sort
              // reordering tied sprites, must not grow the silhouette). Regions at another hidden thing are its own.
              const placed = Number.isFinite(sx) || !!R;
              const theirs = (g) => targets.some((o) => { if (o === t) return false; const q = placeOf(o); return regionAt(g, q.sx, q.sy, q.R); }) || hiddenPlaces.some((p) => regionAt(g, p.sx, p.sy, p.R));
              const pool = regions.filter((g) => regionAt(g, sx, sy, R) || !theirs(g));
              let mine = regions, fr = null;   // no position or box: the whole diff
              if (placed && pool.length) {
                fr = figureRegions(pool, pool.filter((g) => regionAt(g, sx, sy, R)), { sx, sy, trusted: !!R || proj.assumed !== "screen = state", A: cap.img, B, mask: diff.mask, near: (a, b) => c.deltaE(a, b) <= 10 });
                mine = [...fr.kept, ...fr.parts];
                elsewhere = elsewhereOf(fr.others);
                if (fr.parts.length) parts = fr.parts.map((g) => [g.x, g.y, g.w, g.h]);
                if (fr.unplaced) unplaced = { at: R ? [Math.round(R.x), Math.round(R.y), Math.round(R.w), Math.round(R.h)] : [Math.round(sx), Math.round(sy)], how: fr.how };
              }
              mask = new Uint8Array(cap.img.width * cap.img.height);
              for (const g of mine) for (const i of g.px) mask[i] = 1;
              method = without ? `with/without diff (--without ${without.label})` : `with/without diff (reset param hide: ${JSON.stringify(hide)}${byType ? Number.isFinite(sx) ? `: no id, so every ${targets0.find((t) => t.id == null).type} was hidden; the part at its position kept` : `: no id, so every ${targets0.find((t) => t.id == null).type} was hidden and it has no position: the diff may hold the others` : ""})`;
              if (fr && regions.length > 1) {
                const p = fr.parts.length ? ` + ${fr.parts.length} part${fr.parts.length > 1 ? "s" : ""} beside it that vanished too (${fr.parts.map((g) => `${g.w}×${g.h} at ${g.x},${g.y}`).join(", ")})` : "";
                method += fr.how === "at" ? `, the region${fr.kept.length > 1 ? "s" : ""} at its ${R ? "box" : "position"}${p}`
                  : fr.how === "nearest" ? `, the region nearest its position ${Math.round(sx)},${Math.round(sy)}${p}` : `, the largest region${p}`;
              }
            }
            const note = runB && !(diff && diff.count) ? (without ? "--without changed no pixels" : `the game ignored the hide param (${JSON.stringify(hide)})`) : null;
            if (!mask && R) {
              mask = rectSilhouette(c, cap.img, R);
              if (mask) method = `${t.rect ? "rect" : "box"} ${Math.round(R.x)},${Math.round(R.y)} ${Math.round(R.w)}×${Math.round(R.h)} minus the ground's colours (a guess: edge pixels that match the ground drop out${note ? `; ${note}` : ""})`;
            }
            if (!mask && Number.isFinite(sx)) {
              mask = blobAt(m, cap.img, sx, sy);
              if (mask) method = `the sprite at its state position ${Math.round(sx)},${Math.round(sy)} (${proj.assumed ? proj.assumed : "fitted to the entities"}; a guess: edge pixels that match the ground drop out${note ? `; ${note}` : ""})`;
            }
            if (!mask) { shots.push({ label, target: t.label, error: `no silhouette for ${t.label}${note ? ` (${note})` : ""}: give it a box/rect in the state, support the reset param "hide", or pass --without` }); continue; }
            shots.push({ label, img: cap.img, mask, method, target: t.label, mapLabel, scene, params, f: cap.f, elsewhere, parts, unplaced, proj: proj.assumed || null });
          }
        }
      }
    });
  }
  // measure every shot
  // --surfaces names. A shot whose surfaces mostly match the given colours (ΔE < 15) is lit like them: each surface
  // takes its colour's name (a param set that moves the ground around keeps true names). Otherwise (night: other
  // colours at the same places) a surface takes the name of the one that held the same ground pixels in an earlier
  // shot of the same scene, frame and figure, else the nearest given colour
  const nameOf = (col) => { if (!col) return null; let best = null, bd = 15; for (const n of named) { const dd = c.deltaE(col, n.color); if (dd < bd) { bd = dd; best = n.name; } } return best; };
  const results = [], owners = [];   // owners: per named shot, Map(pixel index -> name)
  for (const sh of shots) {
    if (sh.error) { results.push(sh); continue; }
    const r = c.figureGround(sh.img, sh.mask, { ...fgOpts, label: sh.mapLabel || null });
    if (!r) { results.push({ ...sh, error: `${sh.target}: its silhouette touches no ground (fills the screen?)` }); continue; }
    const pix = r.surfaces.map(() => []);
    for (let n = 0; n < r.ring.length; n += 3) pix[r.ring[n + 2]].push(r.ring[n]);
    const real = r.surfaces.filter((s) => s.color && !s.minor);
    const lit = real.length > 0 && real.filter((s) => nameOf(s.color)).length * 2 >= real.length;
    r.surfaces.forEach((s, j) => {
      if (!named.length || !s.color) return;
      if (lit && nameOf(s.color)) { s.name = nameOf(s.color); return; }
      for (const o of owners) {
        if (o.key !== `${sh.scene}|${sh.f}|${sh.target}` || o.w !== sh.img.width || o.h !== sh.img.height) continue;
        const votes = new Map();
        for (const i of pix[j]) { const v = o.names.get(i); if (v) votes.set(v, (votes.get(v) || 0) + 1); }
        const top = [...votes].sort((a, b) => b[1] - a[1])[0];
        if (top && top[1] >= 0.5 * pix[j].length) { s.name = top[0]; s.nameFrom = `the same pixels in ${o.label}`; return; }
      }
      const nm = nameOf(s.color);
      if (nm) s.name = nm;
    });
    const names = new Map();
    r.surfaces.forEach((s, j) => { if (s.name && !s.nameFrom) for (const i of pix[j]) names.set(i, s.name); });
    if (names.size) owners.push({ key: `${sh.scene}|${sh.f}|${sh.target}`, w: sh.img.width, h: sh.img.height, label: sh.label, names });
    results.push({ ...sh, r });
  }
  const good = results.filter((x) => x.r);
  if (!good.length) die(results.map((x) => x.error).join("\n"));
  const sName = (s) => s.name || (s.label ? `${s.hex} ${s.label}` : s.hex);
  const failing = [];
  for (const x of good) for (const s of x.r.surfaces) if (!s.minor && s.ratio.median < min) failing.push({ shot: x.label, target: x.target, surface: sName(s), median: s.ratio.median, worst: s.ratio.worst });
  // pictures: each figure's neighbourhood ×4, its ground ring coloured by the ratio there (red < min, green ≥ min)
  const written = [];
  if (val(opt.out) || opt.picture) {
    const cells = good.map((x) => {
      const b = x.r.bbox, pad = 6, R = { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad };
      const im = { width: x.img.width, height: x.img.height, data: Uint8Array.from(x.img.data) };
      for (let n = 0; n < x.r.ring.length; n += 3) { const o = x.r.ring[n] * 4, bad = x.r.ring[n + 1] < min; im.data[o] = bad ? 255 : 61; im.data[o + 1] = bad ? 77 : 220; im.data[o + 2] = bad ? 94 : 151; }
      const crop = m.cropImage(im, R), k = Math.max(2, Math.min(10, Math.floor(240 / Math.max(R.w, R.h))));
      const worst = x.r.surfaces.filter((s) => !s.minor).reduce((a, s) => (s.ratio.median < a.ratio.median ? s : a), x.r.surfaces[0]);
      return [{ img: m.zoomImage(m.cropImage(x.img, R), k), label: `${x.label} ${x.target}` }, { img: m.zoomImage(crop, k), label: `${sName(worst)} median ${worst.ratio.median}:1`, color: worst.ratio.median < min ? "#ff4d5e" : "#3ddc97" }];
    }).flat();
    const sheet = m.contactSheet(cells, { cols: Math.min(6, cells.length), title: `figure vs ground: ${of || good[0].target}`, subtitle: `each figure, then its ground ring: green ≥ ${min}:1, red < ${min}:1` });
    const dir = val(opt.out) && !/\.png$/i.test(val(opt.out)) ? path.resolve(val(opt.out)) : null;
    const file = dir ? path.join(dir, "figure.png") : val(opt.out) ? path.resolve(val(opt.out)) : path.join(process.cwd(), "figure.png");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, sheet.png);
    written.push(file);
  }
  // text
  const fmtS = (s) => `${s.ratio.median < min && !s.minor ? "✖" : s.minor ? "·" : "✔"} ${sName(s)}${s.nameFrom ? ` (${s.hex}, by position)` : ""}${s.name && s.label ? ` (${s.label})` : ""} ${Math.round(s.share * 100)}%${s.minor ? " (minor)" : ""}: ratio worst ${s.ratio.worst} · median ${s.ratio.median}${s.under ? ` (${s.under}% of this edge < ${min})` : ""} · ΔE worst ${s.deltaE.worst} · median ${s.deltaE.median}${s.ratio.worst < min ? ` — worst at ${s.worstAt.join(",")} (${s.worstFigure} on ${s.worstGround})` : ""}`;
  const lines = [`measure figure ${of || good[0].target}: ${good.length} shot${good.length > 1 ? "s" : ""} · edge contrast vs each ground surface touching the silhouette (surfaces ≥ ${minShare.pct != null ? `${minShare.pct}%` : minShareF} of the ring judged) · fail when a surface's median < ${min}:1`];
  for (const x of results) {
    if (x.error) { lines.push(`  ✖ ${x.label ? `${x.label}: ` : ""}${x.error}`); continue; }
    const b = x.r.bbox;
    lines.push(`  ${x.label} · ${x.target}: ${b.w}×${b.h} px at ${b.x},${b.y}, ${x.r.figure} px, ring ${x.r.ground} px · silhouette: ${x.method}`);
    if (x.unplaced) lines.push(`    ⚠ its state ${x.unplaced.at.length > 2 ? `box ${x.unplaced.at.slice(0, 2).join(",")} ${x.unplaced.at[2]}×${x.unplaced.at[3]} touches` : `position ${x.unplaced.at.join(",")} is on`} no changed pixel${x.proj === "screen = state" ? " (screen = state was assumed: world coords? add state.camera or a box)" : ""}: measured the ${x.unplaced.how} changed region instead`);
    if (x.elsewhere) lines.push(`    ${elsewhereLine(x.elsewhere)}`);
    // the small surfaces judged together come first: they decide when nothing else is big enough
    for (const s of [...x.r.surfaces.filter((q) => q.combined), ...x.r.surfaces.filter((q) => !q.combined)].slice(0, 8)) lines.push(`    ${fmtS(s)}`);
    if (x.r.surfaces.length > 8) lines.push(`    … ${x.r.surfaces.length - 8} more surfaces (--json)`);
  }
  // the same surface across shots (named or map-labelled surfaces)
  const byName = new Map();
  for (const x of good) for (const s of x.r.surfaces) if (!s.minor && (s.name || s.label)) { const k = s.name || s.label; if (!byName.has(k)) byName.set(k, []); byName.get(k).push({ shot: x.label, s }); }
  if (good.length > 1 && byName.size) lines.push(`  across shots: ${[...byName].map(([k, list]) => { const w = list.reduce((a, q) => (q.s.ratio.median < a.s.ratio.median ? q : a)); return `${k} lowest median ${w.s.ratio.median}:1 (${w.shot})`; }).join(" · ")}`);
  if (written.length) lines.push(`  picture: ${written[0]} (open it: each figure, then its ground ring red where the edge is under ${min}:1)`);
  const judged = good.flatMap((x) => x.r.surfaces.filter((s) => !s.minor));
  const lowest = (k, f) => judged.length ? Math.min(...judged.map((s) => s[k][f])) : null;
  const worstS = judged.length ? judged.reduce((a, s) => (s.ratio.median < a.ratio.median ? s : a)) : null;
  const errors = results.filter((x) => x.error).length;
  if (!judged.length) lines.push(`  ✖ no surface judged (every surface under --min-share ${minShare.pct}%)`);
  const env = envelope("measure figure", {
    ok: !failing.length && !errors && judged.length > 0,
    verdict: !judged.length ? "no surface judged" : failing.length ? `${failing.length} surface${failing.length > 1 ? "s" : ""} under ${min}:1 (median edge): ${failing.slice(0, 4).map((f) => `${f.surface} ${f.median}:1 at ${f.shot}`).join(", ")}` : errors ? `${errors} shot${errors > 1 ? "s" : ""} without a silhouette` : `edge contrast ≥ ${min}:1 (median) on every surface in ${good.length} shot${good.length > 1 ? "s" : ""}`,
    summary: { shots: good.length, errors, warnings: good.filter((x) => x.elsewhere || x.unplaced).length, surfaces: judged.length, failing: failing.length, min, worstRatio: lowest("ratio", "worst"), worstMedianRatio: lowest("ratio", "median"), worstDeltaE: lowest("deltaE", "worst"), worstMedianDeltaE: lowest("deltaE", "median"), worstSurface: worstS ? sName(worstS) : null },
    data: { edge, merge, minShare: minShareF, shots: results.map((x) => (x.error ? { shot: x.label, target: x.target, error: x.error } : { shot: x.label, target: x.target, scene: x.scene ?? null, params: x.params ?? null, frame: x.f ?? null, silhouette: x.method, ...(x.elsewhere ? { elsewhere: x.elsewhere } : {}), ...(x.parts ? { parts: x.parts } : {}), ...(x.unplaced ? { unplaced: x.unplaced } : {}), bbox: x.r.bbox, figurePixels: x.r.figure, ringPixels: x.r.ground, surfaces: x.r.surfaces, all: x.r.all })), failing },
    files: written,
  });
  return emit(env, lines.join("\n"), opt);
}
