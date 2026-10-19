// Browser launches in `witness doctor`: the device and engine, how the canvas really lands on the screen (device
// pixels: fractional scaling, smoothing blur), and the audio autoplay policy (the iPhone "no sound until a tap" bug).
import { describeDevice, canvasDisplay } from "../core/devices.js";

/** The measure ui --safe preset for a device profile (null: desktop or a custom profile without one). */
export function safePresetFor(d) {
  if (!d || !d.safe) return null;
  const land = !!d.landscape;
  if (d.safe === "safari") return land ? "iphone-safari-landscape" : "iphone-safari-portrait";
  if (d.safe === "iphone") return land ? "iphone-landscape" : "iphone-portrait";
  if (d.safe === "iphone-max") return land ? "iphone-max-landscape" : "iphone-max-portrait";
  if (d.safe === "iphone-se") return "iphone-se";
  if (d.safe === "ipad") return "ipad";
  return null;
}
import { begin, stepTo, queueInput } from "../core/runner.js";
import { parseWitnessInput } from "../core/input-spec.js";

const fx = (v, d = 2) => +(+v).toFixed(d);

/** The largest visible canvas from web.info(). */
export function mainCanvas(info) {
  let best = null;
  for (const c of (info && info.canvases) || []) if (c.rect[2] * c.rect[3] > 0 && (!best || c.rect[2] * c.rect[3] > best.rect[2] * best.rect[3])) best = c;
  return best;
}

/** Lines for the page and its main canvas. Returns {lines: [[mark, text]], display, info}. */
export async function displayReport(web, media) {
  const lines = [];
  const info = await web.info();
  if (!info) return { lines: [["⚠", "the page has no Witness init script (attached page?): no display facts"]], display: null, info };
  const ua = /iPhone|iPad|Macintosh|Android|Windows|Linux/.exec(info.userAgent);
  lines.push(["", `page: ${info.viewport.join("×")} CSS px, DPR ${info.dpr}${info.screen ? `, screen ${info.screen.join("×")}` : ""}, ${info.maxTouchPoints ? `maxTouchPoints ${info.maxTouchPoints}` : "maxTouchPoints 0"}${web.device && web.device.touch && !info.touchEvents ? " (this build has no TouchEvent: Witness touches arrive as pointer events only; real iPhones send both)" : ""}${info.standalone ? ", navigator.standalone" : ""}${info.platform ? `, platform ${info.platform}` : ""}${ua ? `, user agent says ${ua[0]}` : ""}`]);
  // a touch profile whose page says "no touch" or a desktop platform: games would pick their mouse / desktop UI
  const dev = web.device;
  if (dev && dev.touch && (info.maxTouchPoints || 0) < 2) lines.push(["⚠", `${dev.name} is a touch screen but the page reports maxTouchPoints ${info.maxTouchPoints || 0} (a real one reports 5): a touch-UI check (maxTouchPoints > 0) or the iPad check (platform MacIntel && maxTouchPoints > 1) picks the desktop UI here`]);
  if (dev && dev.platform && info.platform && info.platform !== dev.platform) lines.push(["⚠", `${dev.name}: navigator.platform is "${info.platform}", a real one says "${dev.platform}"`]);
  // safe areas: the notch / Dynamic Island / home indicator aren't emulated (env(safe-area-inset-*) is 0 here)
  const preset = safePresetFor(dev);
  if (preset) lines.push(["", `safe areas are not emulated (env(safe-area-inset-*) is 0 in this page${dev.standalone ? "; on the device a Home Screen web app with viewport-fit=cover gets the insets" : ""}): check the HUD with \`witness measure ui --safe ${preset}\``]);
  if (info.webAudio === false) lines.push(["⚠", `this ${web.engine} build has no Web Audio (Playwright's WebKit for Windows is built without it): Witness put in a silent AudioContext so the page loads; audio can't be captured or heard here (check the unlock path with --engine chromium --no-auto-unlock)`]);
  const c = mainCanvas(info);
  if (!c) { lines.push(["⚠", "no visible <canvas> on the page"]); return { lines, display: null, info }; }
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
      const blurry = runs.blurry || !!(block && block.blurry);
      pixels = { width: img.width, height: img.height, k: block ? want : null, exact, scale: rs, layoutScale: lay, agrees, fractional: runs.fractional, blurry, softPercent: runs.softPercent, smearPercent: runs.smearPercent };
      const pct = (v) => Math.round((v - Math.floor(v)) * 1000) / 10;
      // the share of game pixels drawn one px wider, exactly, from the layout's scale (nearest-neighbour: its fraction)
      const layShare = `${pct(lay[0])}% of game pixels are ${Math.floor(lay[0]) + 1} device px wide${Math.abs(lay[0] - lay[1]) > 0.005 ? `, ${pct(lay[1])}% are ${Math.floor(lay[1]) + 1} tall` : ""} (from the layout's ×${lay[0]})`;
      const runTxt = rs[0] == null ? "no scale" : `≈×${rs[0].toFixed(3)}${Math.abs(rs[0] - (rs[1] ?? rs[0])) > 0.002 && rs[1] != null ? ` × ${rs[1].toFixed(3)}` : ""}`;
      let mark, what;
      if (exact) { mark = "✔"; what = `exact ×${want}: every ${want}×${want} cell is one colour`; }
      else if (blurry) { mark = "⚠"; what = `blurry (${block && block.blurry ? `${block.nonUniformPercent}% of ${want}×${want} cells mixed` : `${runs.smearPercent}% of hard edges smeared over 2+ px, ${runs.softPercent}% of colour changes are soft ramps`})`; }
      else if (!agrees) { mark = d.problem ? "⚠" : ""; what = `couldn't read the scale from the picture (${runTxt} from runs of one colour vs ×${lay[0]}${Math.abs(lay[0] - lay[1]) > 0.005 ? ` × ${lay[1]}` : ""} from the layout: too few one-pixel details, or something drawn over the canvas); the layout's numbers above hold${d.problem === "fractional" ? `: ${layShare}` : ""}`; }
      else if (runs.fractional || d.problem === "fractional") { mark = "⚠"; what = `${runTxt}, uneven: one game pixel is ${Math.floor(lay[0])} or ${Math.floor(lay[0]) + 1} device px; ${layShare}`; }
      else { mark = "✔"; what = `${runTxt}, matches the layout`; }
      lines.push([mark, `pixels on screen (the canvas captured at device pixels, ${img.width}×${img.height}): ${what}`]);
    } catch (e) { lines.push(["⚠", `couldn't capture the canvas at device pixels: ${e.message}`]); }
  }
  return { lines, display: { canvas: name, size: [c.w, c.h], css: [fx(c.rect[2], 4), fx(c.rect[3], 4)], ...d, pixels }, info };
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
  else if (!a.contexts.length) out.push(["⚠", "audio unlock (--no-auto-unlock): no AudioContext was created, even after a tap, a click, space and enter at the centre (no WebAudio, or it starts later in the game)"]);
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

export function describeWeb(web) {
  return `browser: ${web.engine} ${web.engineVersion}${web.playwright ? ` (Playwright ${web.playwright})` : ""} · ${describeDevice(web.device)}${web.captureMode !== "canvas" ? ` · screenshots: ${web.captureMode} capture (device pixels)` : ""}`;
}
