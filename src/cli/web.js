// Browser launches in `witness doctor`: the device and engine, how the canvas really lands on the screen (device
// pixels: fractional scaling, smoothing blur), and the audio autoplay policy (the iPhone "no sound until a tap" bug).
import { describeDevice, canvasDisplay, safePresetFor, safeInsetsFor } from "../core/devices.js";
export { safePresetFor };

import { begin, stepTo, queueInput } from "../core/runner.js";
import { nameRegions, scaleLayers, groupsLine, regionLines, fmtScale, readRect, rectVerdict } from "./scale-regions.js";
import { parseWitnessInput } from "../core/input-spec.js";
import { epochNote } from "../core/launch.js";

const fx = (v, d = 2) => +(+v).toFixed(d);

/** The largest visible canvas from web.info(). */
export function mainCanvas(info) {
  let best = null;
  for (const c of (info && info.canvases) || []) if (c.rect[2] * c.rect[3] > 0 && (!best || c.rect[2] * c.rect[3] > best.rect[2] * best.rect[3])) best = c;
  return best;
}

const insetTxt = (i) => ["top", "right", "bottom", "left"].filter((k) => i[k]).map((k) => `${k} ${i[k]}`).join(" · ") || "none (0 on every side)";

/**
 * Lines for the page and its main canvas. Returns {lines: [[mark, text]], display, info, safe}.
 * opts: layers [{name, rect}] in canvas px (state.layers / state.ui) to name the picture's scale regions; scaleRects
 * [{name, rect}] in canvas px (--scale-rect) read one by one; cfgFlag " --config x" for printed commands.
 */
export async function displayReport(web, media, { layers = [], scaleRects = null, cfgFlag = "" } = {}) {
  const lines = [];
  const info = await web.info();
  if (!info) return { lines: [["⚠", "the page has no Witness init script (attached page?): no display facts"]], display: null, info, safe: null };
  const ua = /iPhone|iPad|Macintosh|Android|Windows|Linux/.exec(info.userAgent);
  lines.push(["", `page: ${info.viewport.join("×")} CSS px, DPR ${info.dpr}${info.screen ? `, screen ${info.screen.join("×")}` : ""}, ${info.maxTouchPoints ? `maxTouchPoints ${info.maxTouchPoints}` : "maxTouchPoints 0"}${web.device && web.device.touch && !info.touchEvents ? " (this build has no TouchEvent: Witness touches arrive as pointer events only; real iPhones send both)" : ""}${info.standalone ? ", navigator.standalone" : ""}${info.platform ? `, platform ${info.platform}` : ""}${ua ? `, user agent says ${ua[0]}` : ""}`]);
  // a touch profile whose page says "no touch" or a desktop platform: games would pick their mouse / desktop UI
  const dev = web.device;
  if (dev && dev.touch && (info.maxTouchPoints || 0) < 2) lines.push(["⚠", `${dev.name} is a touch screen but the page reports maxTouchPoints ${info.maxTouchPoints || 0} (a real one reports 5): a touch-UI check (maxTouchPoints > 0) or the iPad check (platform MacIntel && maxTouchPoints > 1) picks the desktop UI here`]);
  if (dev && dev.platform && info.platform && info.platform !== dev.platform) lines.push(["⚠", `${dev.name}: navigator.platform is "${info.platform}", a real one says "${dev.platform}"`]);
  // safe areas: the engines have no notch (env(safe-area-inset-*) is 0) unless --safe-insets rewrote the page's env() uses
  const preset = safePresetFor(dev);
  let safe = null;
  if (web.safeInsets) {
    const si = await web.safeInfo().catch(() => null);
    const S = web.safeInsets, b = si ? si.bySource : {};
    const missed = si && si.missed ? si.missed : { count: 0, where: [] }, cover = si ? si.cover !== false : null;
    safe = { emulated: !!si, preset: S.preset, insets: { top: S.top, right: S.right, bottom: S.bottom, left: S.left }, viewportFitCover: cover, rewritten: si ? si.rewritten : 0, rewrites: si ? si.rewrites ?? null : null, bySource: si ? si.bySource : null, crossOrigin: si ? si.crossOrigin : 0, missed: si ? missed : null, overlay: !!web.safeOverlay };
    if (!si) lines.push(["⚠", "safe areas: --safe-insets was asked for, but the page has no Witness safe-area script (attached page?)"]);
    else {
      // rewritten: distinct places (a HUD setting the same style every frame is one)
      const where = [b.stylesheet && `${b.stylesheet} in style sheets`, b.inline && `${b.inline} inline`, b.script && `${b.script} set from script`].filter(Boolean).join(", ");
      const uses = `${si.rewritten} env() use${si.rewritten > 1 ? "s" : ""} in the page's CSS rewritten${cover ? "" : " to 0"} (${where})`;
      const head = `safe areas emulated (--safe-insets, ${S.preset}${S.preset.includes(S.orientation) ? "" : ` ${S.orientation}`})`;
      if (!cover) lines.push(["⚠", `${head}: the page has no viewport-fit=cover, so env(safe-area-inset-*) is 0, as on the device, where the page is letterboxed inside the safe area (${insetTxt(S)} CSS px; the letterbox isn't emulated here)${si.rewritten ? `; ${uses}` : ""}. To draw under the island and corners: <meta name="viewport" content="…, viewport-fit=cover">`]);
      else lines.push([missed.count ? "⚠" : "✔", `${head}: env(safe-area-inset-*) = ${insetTxt(S)} CSS px; ${si.rewritten ? uses : missed.count ? "nothing rewritten" : "the page's CSS uses no env(safe-area-inset-*): a HUD drawn into the canvas must keep clear by itself"}`]);
      if (missed.count) lines.push(["⚠", `${missed.count} env(safe-area-inset-*) use${missed.count > 1 ? "s" : ""} could not be rewritten and ${missed.count > 1 ? "stay" : "stays"} 0 here: ${missed.where.join(", ")}${missed.count > missed.where.length ? ", …" : ""} (set from script in a way Witness doesn't see, e.g. a keyframe's style.paddingLeft = … in Chromium: use style.setProperty)`]);
      if (si.crossOrigin) lines.push(["⚠", `${si.crossOrigin} cross-origin style sheet${si.crossOrigin > 1 ? "s" : ""} couldn't be read: env() in ${si.crossOrigin > 1 ? "them" : "it"} stays 0 here (serve the CSS from the game's origin)`]);
    }
  } else if (preset) lines.push(["", `safe areas are not emulated (env(safe-area-inset-*) is 0 in this page${dev.standalone ? "; on the device a Home Screen web app with viewport-fit=cover gets the insets" : ""}): --safe-insets emulates them (--safe-overlay draws the island and corners on screenshots); check a canvas HUD with \`witness measure ui --safe ${preset}${cfgFlag}\``]);
  if (web.safeOverlay) {
    lines.push(["", `safe overlay (--safe-overlay): the ${/safari/.test(web.safeOverlay.preset) ? "zero insets of a Safari tab (its toolbars hold the island and corners)" : web.safeOverlay.preset === "iphone-se" ? "status bar inset (no island or rounded corners on an SE)" : `${web.safeOverlay.preset === "ipad" ? "rounded corners and home indicator" : "Dynamic Island, rounded corners and home indicator"}, and the inset zones tinted magenta`} are drawn over every screenshot after capture (not into the page)`]);
    if (!safe) safe = { emulated: false, preset: web.safeOverlay.preset, overlay: true };
  }
  if (info.webAudio === false) lines.push(["⚠", `this ${web.engine} build has no Web Audio (Playwright's WebKit for Windows is built without it): Witness put in a silent AudioContext so the page loads; audio can't be captured or heard here (check the unlock path with --engine chromium --no-auto-unlock)`]);
  const c = mainCanvas(info);
  if (!c && web.captureMode === "screen") { lines.push(["", `DOM page (no visible <canvas>): screenshots are of the whole viewport at device pixels${web.dom ? " (chosen because the page has no canvas; launch.capture sets it)" : ""}`]); return { lines, display: null, info, safe }; }
  if (!c) { lines.push(["⚠", "no visible <canvas> on the page (a DOM game? --capture screen, or leave launch.capture unset: Witness then captures the viewport)"]); return { lines, display: null, info, safe }; }
  const d = canvasDisplay(c, info.dpr);
  const name = `canvas${c.id ? `#${c.id}` : ""}`;
  lines.push([d.problem ? "⚠" : "✔",
    `display: ${name} ${c.w}×${c.h} shown at ${fx(c.rect[2])}×${fx(c.rect[3])} CSS px = ${fx(d.device[0])}×${fx(d.device[1])} device px (image-rendering: ${c.imageRendering || "auto"}): ${d.verdict}`]);
  if (d.problem === "fractional") lines.push(["", `  fix: size the canvas box to a whole multiple of ${c.w}×${c.h} device px (CSS width = k × ${c.w} / ${info.dpr}), letterbox the rest`]);
  else if (d.problem === "blurry") lines.push(["", `  fix: render at devicePixelRatio (canvas.width = CSS width × ${info.dpr}) for smooth art, or integer-scale with image-rendering: pixelated for pixel art`]);
  let pixels = null;
  if (media && (info.dpr !== 1 || web.device)) {
    try {
      const cap = await web.capture("element");
      const img = media.decodePNG(cap.png);
      // a few % in from the edges: rounded corners, borders and the clip's rounding aren't the game's pixels
      const mx = Math.min(16, Math.floor(img.width * 0.03)), my = Math.min(16, Math.floor(img.height * 0.03));
      const region = { x: mx, y: my, w: img.width - 2 * mx, h: img.height - 2 * my };
      // the layout says what the scale should be: an integer one is checked cell by cell at exactly that k (a sparse
      // scene would pass at other k too); otherwise the scale is read from runs of one colour
      const want = Math.round(d.scale[0]);
      const block = d.integer && want > 1 ? media.blockScale(img, want, { region }) : null;
      const runs = media.pixelRuns(img, { region });
      const exact = !!block && !block.blurry && !runs.fractional;
      // the layout's scale is exact; the picture's is read from runs of one colour. When they disagree by more than
      // 3% the picture couldn't be read (too few one-pixel details, or chrome around the canvas): no ✔ from it
      const lay = d.scale, rs = runs.scale;
      const agrees = rs[0] != null && rs[1] != null && Math.abs(rs[0] - lay[0]) / lay[0] <= 0.03 && Math.abs(rs[1] - lay[1]) / lay[1] <= 0.03;
      // a k×k cell test that fails is blur only when edges are smeared or soft: crisp art drawn at another scale
      // inside the canvas (a ×4.11 HUD in a ×4 canvas) mixes cells too, and is read region by region below
      const cellsMixed = !!(block && block.blurry);
      const mixed = !exact && !runs.blurry ? media.scaleRegions(img, { region }) : null;
      const multi = mixed && mixed.groups.length > 1;
      const blurry = runs.blurry || (cellsMixed && !multi && (runs.softPercent > 10 || runs.smearPercent >= 25));
      pixels = { width: img.width, height: img.height, k: block ? want : null, exact, scale: rs, layoutScale: lay, agrees, fractional: runs.fractional, blurry, softPercent: runs.softPercent, smearPercent: runs.smearPercent };
      const pct = (v) => Math.round((v - Math.floor(v)) * 1000) / 10;
      // the share of game pixels drawn one px wider, exactly, from the layout's scale (nearest-neighbour: its fraction)
      const layShare = `${pct(lay[0])}% of game pixels are ${Math.floor(lay[0]) + 1} device px wide${Math.abs(lay[0] - lay[1]) > 0.005 ? `, ${pct(lay[1])}% are ${Math.floor(lay[1]) + 1} tall` : ""} (from the layout's ×${lay[0]})`;
      const runTxt = rs[0] == null ? "no scale" : `≈×${rs[0].toFixed(3)}${Math.abs(rs[0] - (rs[1] ?? rs[0])) > 0.002 && rs[1] != null ? ` × ${rs[1].toFixed(3)}` : ""}`;
      // not one clean grid: the picture may hold two scales (a ×5 world under a UI drawn at ×4.11): region by region
      const one = (v) => Math.abs(v - 1) < 0.005;
      let mark, what, extra = [];
      if (exact) { mark = "✔"; what = `exact ×${want}: every ${want}×${want} cell is one colour`; }
      else if (blurry) { mark = "⚠"; what = `blurry (${block && block.blurry ? `${block.nonUniformPercent}% of ${want}×${want} cells mixed` : `${runs.smearPercent}% of hard edges smeared over 2+ px, ${runs.softPercent}% of colour changes are soft ramps`})`; }
      else if (multi) {
        const kx = img.width / c.w, ky = img.height / c.h;   // capture px per canvas px
        const names = nameRegions(mixed, scaleLayers(layers, kx, ky));
        const near = (v, l) => v != null && Math.abs(v - l) / l <= 0.03;
        // an integer layout's region is the one at exactly that whole scale (×4.11 is within 3% of ×4 but isn't it)
        const at = d.integer ? mixed.groups.findIndex((g) => g.whole && (g.scale[0] ?? g.scale[1]) === want && (g.scale[1] ?? g.scale[0]) === want)
          : mixed.groups.findIndex((g) => near(g.scale[0] ?? g.scale[1], lay[0]) && near(g.scale[1] ?? g.scale[0], lay[1]));
        const label = (gi) => { const nm = [...new Set(mixed.groups[gi].regions.map((i) => names[i]).filter(Boolean))].join("/"); return nm ? `${nm} (${fmtScale(mixed.groups[gi].scale)})` : fmtScale(mixed.groups[gi].scale); };
        mark = mixed.groups.some((g) => g.fractional) ? "⚠" : "✔";
        what = `${mixed.groups.length} scales in one picture: ${groupsLine(mixed, names)}`;
        if (at >= 0) extra.push(`  the layout's ×${lay[0]} is the ${label(at)} region's; ${mixed.groups.length > 2 ? "the others are" : `the ${label(at === 0 ? 1 : 0)} region is`} drawn by the game at a scale of its own`);
        else if (one(lay[0]) && one(lay[1])) extra.push("  the canvas is shown 1:1 (the layout's ×1): these are the scales the game draws at itself");
        else extra.push(`  the layout shows the canvas at ×${lay[0]}: inside it the game draws ${mixed.groups.map((g, gi) => `${label(gi)} = ×${fx((g.scale[0] ?? g.scale[1]) / lay[0], 3)} of its canvas pixels`).join(", ")}`);
        extra.push(...regionLines(mixed, names, "    "));
        Object.assign(pixels, { agrees: at >= 0, mixed: true, layoutRegion: at >= 0 ? at : null, regions: mixed.regions.map((g, i) => ({ name: names[i] || null, rect: g.rect, share: g.share, scale: g.scale, whole: g.whole, fractional: g.fractional, group: g.group })), groups: mixed.groups.map((g) => ({ scale: g.scale, whole: g.whole, fractional: g.fractional, share: g.share })) });
      } else if (cellsMixed) {
        // crisp (no smeared or soft edges), one scale, but not one colour per k×k cell: the game draws at a scale of its own
        mark = "⚠"; what = `not one colour per ${want}×${want} cell (${block.nonUniformPercent}% mixed) though no edge is smeared: the game draws at ${rs[0] == null ? "a scale too sparse to read" : runTxt} inside the ×${want} canvas${runs.fractional ? ` — uneven: one game pixel is ${runs.x.single.join(" or ")} device px` : ""}`;
        pixels.gameScale = rs;
      } else if (!agrees && one(lay[0]) && one(lay[1]) && rs[0] != null && rs[1] != null && rs[0] > 1.05) {
        // a 1:1 canvas whose game draws its own pixels bigger: nothing to compare, the picture's scale is the game's
        mark = runs.fractional ? "⚠" : "✔";
        what = `${runTxt}: the canvas is shown 1:1 (the layout's ×1), so the game draws its pixels at ${runTxt.slice(1)} itself${runs.fractional ? ` — uneven: one game pixel is ${runs.x.single.join(" or ")} device px` : Number.isInteger(rs[0]) && Number.isInteger(rs[1]) ? " (whole: even pixels)" : ""}`;
        pixels.gameScale = rs;
      } else if (!agrees) { mark = d.problem ? "⚠" : ""; what = `couldn't read the scale from the picture (${runTxt} from runs of one colour vs ×${lay[0]}${Math.abs(lay[0] - lay[1]) > 0.005 ? ` × ${lay[1]}` : ""} from the layout: too few one-pixel details, or something drawn over the canvas); the layout's numbers above hold${d.problem === "fractional" ? `: ${layShare}` : ""}`; }
      else if (runs.fractional || d.problem === "fractional") { mark = "⚠"; what = `${runTxt}, uneven: one game pixel is ${Math.floor(lay[0])} or ${Math.floor(lay[0]) + 1} device px; ${layShare}`; }
      else { mark = "✔"; what = `${runTxt}, matches the layout`; }
      lines.push([mark, `pixels on screen (the canvas captured at device pixels, ${img.width}×${img.height}): ${what}`]);
      for (const e of extra) lines.push(["", e]);
      // --scale-rect: rects in canvas px, each read on its own
      if (scaleRects && scaleRects.length) {
        const kx = img.width / c.w, ky = img.height / c.h;
        pixels.rects = [];
        for (const { name: nm, rect } of scaleRects) {
          const dev = { x: Math.round(rect.x * kx), y: Math.round(rect.y * ky), w: Math.round(rect.w * kx), h: Math.round(rect.h * ky) };
          let r;
          try { r = readRect(media, img, dev); } catch (e) { lines.push(["⚠", `--scale-rect ${nm}: ${e.message}`]); continue; }
          const [good, text] = rectVerdict(r);
          lines.push([good ? "✔" : "⚠", `--scale-rect ${nm} (${rect.x},${rect.y} ${rect.w}×${rect.h} canvas px = ${r.rect.x},${r.rect.y} ${r.rect.w}×${r.rect.h} device px): ${text}`]);
          pixels.rects.push({ name: nm, rect, deviceRect: r.rect, scale: r.scale, exact: r.exact, fractional: r.fractional, blurry: r.blurry });
        }
      }
    } catch (e) { lines.push(["⚠", `couldn't capture the canvas at device pixels: ${e.message}`]); }
  }
  return { lines, display: { canvas: name, size: [c.w, c.h], css: [fx(c.rect[2], 4), fx(c.rect[3], 4)], ...d, pixels }, info, safe };
}

const audioLine = (a) => a.contexts.map((c) => `#${c.id} ${c.kind} ${c.state}${c.unlockedBy ? ` (unlocked by ${c.unlockedBy})` : ""}${c.blocked ? `, ${c.blocked} resume() call(s) blocked` : ""}`).join("; ");

/**
 * "gesture" policy (--no-auto-unlock): before anything else touches the game, see whether audio starts suspended and
 * which ordinary gesture resumes it: a tap at the centre, a click there, space, enter. Returns [[mark, text]].
 */
export async function unlockProbe(s, seed = 1) {
  const web = s.web, out = [];
  const st = await begin(s, { seed });
  await stepTo(s, st, 2);
  const start = await web.audio();
  if (!s.has("input")) return [["⚠", "audio unlock: the adapter takes no input, so no gesture can be tried"]];
  const size = s.hello.size || [320, 180];
  const cx = Math.round(size[0] / 2), cy = Math.round(size[1] / 2);
  // [name, input, what counts as the gesture, its frame after the start]: a tap's finger lifts one frame after it lands
  const tries = [["a tap at the centre", `touch:${cx},${cy}@1f`, "finger lifted", 2], ["a click at the centre", `click:${cx},${cy}@1f`, "mouse button down", 1], ["space", "space@1f", "key down", 1], ["enter", "enter@1f", "key down", 1]];
  const startState = start.state;
  let got = null, a = start;
  for (const [name, spec, ev, df] of tries) {
    if (a.state === "running") break;
    const evs = parseWitnessInput(spec, s.fps).map((e) => ({ ...e, frame: e.frame + st.frame }));
    await queueInput(s, st, evs);
    const from = st.frame;
    await stepTo(s, st, st.frame + 8);
    a = await web.audio();
    if (a.state === "running") got = { name, ev, frame: from + df, tap: name.startsWith("a tap") };
  }
  if (startState === "running") out.push(["⚠", `audio unlock (--no-auto-unlock): the AudioContext was already running before any gesture (${audioLine(start)}) — created inside a gesture?`]);
  else if (got && !got.tap && web.device && web.device.touch) out.push(["⚠", `audio unlock (--no-auto-unlock): a tap at the centre did NOT resume the AudioContext, only ${got.name} did (${got.ev} at frame ${got.frame}): on ${web.device.name} (a touch screen) players hear nothing until the game resumes audio in a touchend / click handler: ${audioLine(a)}`]);
  else if (got) out.push(["✔", `audio unlock (--no-auto-unlock, like iPhone Safari): ${startState === "none" ? "no AudioContext at start; " : "AudioContext suspended at start; "}running after ${got.name} (${got.ev} at frame ${got.frame}): ${audioLine(a)}`]);
  else if (!a.contexts.length) out.push(["⚠", "audio unlock (--no-auto-unlock): no AudioContext was created (none at start, none after a tap, a click, space and enter at the centre), so there is no unlock path to test: open audio in witness mode too (an SDL/Emscripten build: open the audio device, fed silence; adapters/cpp/GUIDE.md §13), then re-run"]);
  else out.push(["⚠", `audio stayed SUSPENDED after a tap, a click, space and enter at the centre (${audioLine(a)}): on iPhone Safari this game is silent until it calls ctx.resume() inside a touchend / click / keydown handler (resume() from the game loop or a timer doesn't count)`]);
  return out;
}

/** "auto" policy: what the contexts did during the doctor's runs. */
export async function audioReport(web) {
  const a = await web.audio();
  if (!a) return [];
  if (!a.contexts.length) return [["", `audio: no AudioContext (policy ${a.policy})`]];
  const out = [["", `audio: ${a.contexts.length} AudioContext${a.contexts.length > 1 ? "s" : ""} (${audioLine(a)}); policy ${a.policy === "auto" ? `auto: Witness counts as the player's first gesture${web.autoUnlocked ? ` (resumed ${web.autoUnlocked} at connect)` : ""}; check the iPhone path with --no-auto-unlock` : a.policy}`]];
  if (a.policy === "auto" && a.suspended) out.push(["⚠", "an AudioContext is suspended at the end (the game suspended it and never resumed it): players would hear nothing from it"]);
  return out;
}

/**
 * WebGL in this engine (probed on a scratch canvas) and what the game's main canvas draws with. Returns
 * { lines: [[mark, text]], summary }. SwiftShader = software rendering (Chromium headless: slow, but the same pixels
 * on every machine); WebKit reports a generic "Apple GPU" whatever renders underneath.
 */
export async function webglReport(web, info) {
  let g = null;
  try { g = web.webgl ? await web.webgl() : null; } catch { /* page gone */ }
  if (!g) return { lines: [], summary: null };
  const c = mainCanvas(info);
  const uses = c && c.context ? c.context : null;
  const gl = (k) => g[k] && g[k].available;
  const r = (gl("webgl2") ? g.webgl2 : gl("webgl") ? g.webgl : null);
  const soft = r && /swiftshader|llvmpipe|software|microsoft basic render/i.test(r.renderer || "");
  const masked = r && /^apple gpu$/i.test(r.renderer || "") && web.engine === "webkit";
  const what = r ? `${gl("webgl2") ? "WebGL 2" : "WebGL 1 only (no WebGL 2)"} · renderer ${r.renderer}${soft ? " (software: slower, not tied to the machine's GPU)" : masked ? " (WebKit's generic name; the real backend isn't shown)" : ""} · max texture ${r.maxTexture}` : "no WebGL in this engine";
  const lines = [];
  if (uses && uses.endsWith(" (failed)")) lines.push(["✖", `WebGL: the game asked for ${uses.slice(0, -9)} and got none: ${what}`]);
  else if (uses === "webgl" || uses === "webgl2") lines.push(["✔", `WebGL: the game's canvas draws with ${uses} · ${what}`]);
  else if (!r && !uses) lines.push(["⚠", `WebGL: ${what} (${web.engine}): a WebGL build would show a blank canvas here`]);
  else lines.push(["", `WebGL: ${what}${uses ? ` · the game's canvas uses ${uses}` : ""}`]);
  return { lines, summary: { webgl: !!gl("webgl"), webgl2: !!gl("webgl2"), renderer: r ? r.renderer : null, software: !!soft, canvasContext: uses } };
}

/** The virtual Date's start, for JS adapter games (null for other adapters: their Date is the real one). */
export function clockLine(session) {
  if (!/witness-js/.test((session.hello && session.hello.adapter) || "")) return null;
  return epochNote(session) + (session.web && session.web.resetMode === "reload" ? " · reset reloads the page (launch.reset)" : "");
}

export function describeWeb(web) {
  return `browser: ${web.engine} ${web.engineVersion}${web.playwright ? ` (Playwright ${web.playwright})` : ""} · ${describeDevice(web.device)}${web.captureMode !== "canvas" ? ` · screenshots: ${web.captureMode} capture (device pixels)` : ""}`;
}
