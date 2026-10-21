// Device profiles for browser launches (witness.json launch.device / --device): viewport in CSS px, device pixel
// ratio, touch, mobile viewport handling, user agent, and whether the page runs as a Home Screen web app.
// Sizes are Apple's published point sizes; the iPhone profiles are full screen (a web app added to the Home Screen),
// the "-safari" one is a Safari tab (toolbars take the rest: the viewports Playwright uses for "iPhone 15" and
// "iPhone 15 landscape", 393×659 and 734×343). screen is the device's portrait point size in every orientation, as
// iOS reports it. navigator.platform and maxTouchPoints match the user agent ("iPhone" / "MacIntel", 5 touch points:
// the usual iPad check is platform === "MacIntel" && maxTouchPoints > 1). Safe areas (notch, Dynamic Island, home
// indicator) are not emulated by the engines: env(safe-area-inset-*) is 0 in the page. --safe-insets rewrites the page's
// env() uses to the profile's insets (web-init.js safeInsetsInit); measure ui --safe <preset> checks a screenshot.
import { WitnessError } from "./session.js";
import { SAFE_PRESETS } from "../media/ui.js";

const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
// iPadOS Safari asks for the desktop site by default: it reports itself as a Mac (with touch).
const IPADOS_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

export const DEVICES = {
  "iphone-15": { title: "iPhone 15, Home Screen web app", width: 393, height: 852, dpr: 3, touch: true, mobile: true, standalone: true, userAgent: IOS_UA, screen: [393, 852], platform: "iPhone", safe: "iphone" },
  "iphone-15-safari": { title: "iPhone 15, Safari tab", width: 393, height: 659, landscapeSize: [734, 343], dpr: 3, touch: true, mobile: true, standalone: false, userAgent: IOS_UA, screen: [393, 852], platform: "iPhone", safe: "safari" },
  "iphone-15-pro-max": { title: "iPhone 15 Pro Max, Home Screen web app", width: 430, height: 932, dpr: 3, touch: true, mobile: true, standalone: true, userAgent: IOS_UA, screen: [430, 932], platform: "iPhone", safe: "iphone-max" },
  "iphone-se": { title: "iPhone SE (2nd/3rd gen), Home Screen web app", width: 375, height: 667, dpr: 2, touch: true, mobile: true, standalone: true, userAgent: IOS_UA, screen: [375, 667], platform: "iPhone", safe: "iphone-se" },
  "ipad": { title: "iPad (10th gen), Home Screen web app", width: 820, height: 1180, dpr: 2, touch: true, mobile: true, standalone: true, userAgent: IPADOS_UA, screen: [820, 1180], platform: "MacIntel", safe: "ipad" },
};

const num = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

/**
 * A device spec → a profile {name, title, width, height, dpr, touch, mobile, standalone, userAgent, landscape}.
 * spec: "iphone-15", "iphone-15-landscape" (or ":landscape"), or a custom object {width, height, dpr?, touch?, mobile?,
 * userAgent?, standalone?, landscape?, name?, screen?: [w, h], platform?, maxTouchPoints?}. null/undefined → null
 * (desktop, no emulation). The profile also carries screen, platform, maxTouchPoints and safe (its safe-area family).
 */
export function resolveDevice(spec) {
  if (spec == null || spec === false || spec === "" || spec === "desktop") return null;
  let base, landscape = false, name;
  if (typeof spec === "string") {
    let s = spec.trim().toLowerCase().replace(/\s+/g, "-");
    const m = /^(.*?)[-:](landscape|portrait)$/.exec(s);
    if (m && DEVICES[m[1]]) { s = m[1]; landscape = m[2] === "landscape"; }
    if (!DEVICES[s]) throw new WitnessError(`unknown device '${spec}': use ${Object.keys(DEVICES).join(", ")} (add -landscape), or a custom {"width", "height", "dpr", "touch", "mobile", "userAgent"} in witness.json`);
    base = DEVICES[s];
    name = s + (landscape ? "-landscape" : "");
  } else if (typeof spec === "object" && !Array.isArray(spec)) {
    const w = num(spec.width), h = num(spec.height), dpr = spec.dpr == null ? 1 : num(spec.dpr);
    if (!(Number.isInteger(w) && w > 0 && w <= 10000) || !(Number.isInteger(h) && h > 0 && h <= 10000)) throw new WitnessError(`custom device: "width" and "height" must be whole CSS pixels (got ${JSON.stringify(spec.width)} × ${JSON.stringify(spec.height)})`);
    if (!(dpr >= 0.5 && dpr <= 8)) throw new WitnessError(`custom device: "dpr" must be between 0.5 and 8 (got ${JSON.stringify(spec.dpr)})`);
    landscape = !!spec.landscape;
    const sc = Array.isArray(spec.screen) && spec.screen.length === 2 && spec.screen.every((v) => Number.isInteger(num(v)) && num(v) > 0) ? spec.screen.map(num) : null;
    base = { title: spec.title || spec.name || "custom device", width: w, height: h, dpr, touch: !!spec.touch, mobile: !!spec.mobile, standalone: !!spec.standalone, userAgent: spec.userAgent ? String(spec.userAgent) : null,
      screen: sc || [Math.min(w, h), Math.max(w, h)], platform: spec.platform ? String(spec.platform) : null, maxTouchPoints: spec.maxTouchPoints != null ? num(spec.maxTouchPoints) : null };
    // safe areas: explicit "safeInsets" [top, right, bottom, left] (CSS px), a named family ("safe": "iphone"), else
    // inferred when the size is a known device's (393x852 is an iPhone 15 whatever its DPR)
    if (spec.safeInsets != null) base.safeInsets = parseInsets(spec.safeInsets, 'custom device "safeInsets"');
    if (spec.safe && SAFE_FAMILIES.includes(String(spec.safe))) base.safe = String(spec.safe);
    else if (spec.safe) throw new WitnessError(`custom device: "safe" is ${SAFE_FAMILIES.join(", ")} (got ${JSON.stringify(spec.safe)}); or give "safeInsets": [top, right, bottom, left]`);
    else { const f = inferSafeFamily(w, h); if (f) { base.safe = f; base.safeInferred = true; } }
    name = spec.name ? String(spec.name) : `custom ${w}×${h}@${dpr}`;
  } else throw new WitnessError(`launch.device must be a device name or an object (got ${JSON.stringify(spec)})`);
  // landscape: the Home Screen profiles are full screen (the axes swap); a Safari tab has its own landscape viewport
  // (the toolbars aren't the same height); screen stays the portrait size, as on iOS
  const [width, height] = landscape ? base.landscapeSize || [Math.max(base.width, base.height), Math.min(base.width, base.height)] : [base.width, base.height];
  const maxTouchPoints = base.maxTouchPoints != null ? base.maxTouchPoints : base.platform ? 5 : null;
  return { name, title: base.title + (landscape ? ", landscape" : ""), width, height, dpr: base.dpr, touch: base.touch, mobile: base.mobile, standalone: base.standalone, userAgent: base.userAgent,
    screen: base.screen || [Math.min(width, height), Math.max(width, height)], platform: base.platform || null, maxTouchPoints, safe: base.safe || null, landscape,
    ...(base.safeInferred ? { safeInferred: true } : {}), ...(base.safeInsets ? { safeInsets: base.safeInsets } : {}) };
}

/** Safe-area families a profile can name (custom devices: "safe": "iphone"). */
export const SAFE_FAMILIES = ["iphone", "iphone-max", "iphone-16-pro", "iphone-16-pro-max", "safari", "iphone-se", "ipad"];
// portrait point sizes -> family, for custom devices of a known size
const KNOWN_SIZES = [[393, 852, "iphone"], [430, 932, "iphone-max"], [402, 874, "iphone-16-pro"], [440, 956, "iphone-16-pro-max"], [393, 659, "safari"], [375, 667, "iphone-se"], [820, 1180, "ipad"]];

/** The safe-area family of a known device size (either orientation; Safari's landscape tab is 734×343), else null. */
export function inferSafeFamily(w, h) {
  const a = Math.min(w, h), b = Math.max(w, h);
  if (a === 343 && b === 734) return "safari";
  const k = KNOWN_SIZES.find(([x, y]) => x === a && y === b);
  return k ? k[2] : null;
}

/**
 * Explicit insets in CSS px: "59,0,34,0" / [59, 0, 34, 0] (top, right, bottom, left, as in CSS), "20,0" (vertical,
 * horizontal), "16" (all four), or {top, right, bottom, left}. Throws a readable WitnessError.
 */
export function parseInsets(v, what = "--safe-insets") {
  let a;
  if (Array.isArray(v)) a = v.map(num);
  else if (v && typeof v === "object") a = ["top", "right", "bottom", "left"].map((k) => (v[k] == null ? 0 : num(v[k])));
  else a = String(v).split(/[\s,]+/).filter(Boolean).map(num);
  if (a.length === 1) a = [a[0], a[0], a[0], a[0]];
  else if (a.length === 2) a = [a[0], a[1], a[0], a[1]];
  else if (a.length === 3) a = [a[0], a[1], a[2], a[1]];
  if (a.length !== 4 || a.some((x) => !(x >= 0 && x <= 2000))) throw new WitnessError(`${what} wants CSS px insets "top,right,bottom,left" (e.g. 59,0,34,0), 1 or 2 numbers, or a preset name (got ${JSON.stringify(v)})`);
  return { top: a[0], right: a[1], bottom: a[2], left: a[3] };
}

/** The measure ui --safe preset for a device profile (null: desktop or a custom profile without one). */
export function safePresetFor(d) {
  if (!d || !d.safe) return null;
  const land = !!d.landscape;
  if (d.safe === "safari") return land ? "iphone-safari-landscape" : "iphone-safari-portrait";
  if (d.safe === "iphone") return land ? "iphone-landscape" : "iphone-portrait";
  if (d.safe === "iphone-max") return land ? "iphone-max-landscape" : "iphone-max-portrait";
  if (d.safe === "iphone-16-pro") return land ? "iphone-16-pro-landscape" : "iphone-16-pro-portrait";
  if (d.safe === "iphone-16-pro-max") return land ? "iphone-16-pro-max-landscape" : "iphone-16-pro-max-portrait";
  if (d.safe === "iphone-se") return "iphone-se";
  if (d.safe === "ipad") return "ipad";
  return null;
}

/** env(safe-area-inset-*) of a profile in CSS px (= pt) for its orientation: { preset, orientation, top, right, bottom,
 *  left } (the measure ui --safe preset's numbers), or null (desktop / a custom device of no known size).
 *  want: the launch's safeInsets: true (the profile's own), explicit insets ("59,0,34,0", [..], {top, ...}: preset
 *  "custom"), or a measure ui --safe preset name ("iphone-portrait"). A custom profile's own "safeInsets" count as
 *  explicit; one whose size matches a known device gets that device's preset (inferred: true). */
export function safeInsetsFor(d, want = true) {
  const orient = () => (d ? (d.landscape || d.width > d.height ? "landscape" : "portrait") : "portrait");
  if (typeof want === "string" && /^[a-z]/i.test(want.trim())) {
    const name = want.trim().toLowerCase(), p = SAFE_PRESETS[name];
    if (!p) throw new WitnessError(`--safe-insets: no preset '${want}' (${Object.keys(SAFE_PRESETS).join(", ")}), or give insets "top,right,bottom,left" in CSS px`);
    const orientation = p.only || orient(), i = p[orientation].insets;
    return { preset: name, orientation, top: i.top, right: i.right, bottom: i.bottom, left: i.left };
  }
  if (want != null && want !== true && want !== false) return { preset: "custom", orientation: orient(), ...parseInsets(want) };
  if (d && d.safeInsets) return { preset: "custom", orientation: orient(), ...d.safeInsets };
  const name = safePresetFor(d);
  if (!name) return null;
  const p = SAFE_PRESETS[name], orientation = p.only || (d.landscape ? "landscape" : "portrait");
  const i = p[orientation].insets;
  return { preset: name, orientation, top: i.top, right: i.right, bottom: i.bottom, left: i.left, ...(d.safeInferred ? { inferred: true } : {}) };
}

/** One line: "iphone-15 (iPhone 15, Home Screen web app): 393×852 CSS px, DPR 3 = 1179×2556 device px, touch, mobile". */
export function describeDevice(d) {
  if (!d) return "desktop (no device emulation)";
  const flags = [d.touch && "touch", d.mobile && "mobile viewport", d.standalone && "standalone"].filter(Boolean).join(", ");
  return `${d.name} (${d.title}): ${d.width}×${d.height} CSS px, DPR ${d.dpr} = ${Math.round(d.width * d.dpr)}×${Math.round(d.height * d.dpr)} device px${flags ? `, ${flags}` : ""}`;
}

/** Playwright browser-context options for a profile. */
export function contextOptions(d, size) {
  if (!d) return { viewport: { width: size[0], height: size[1] } };
  const sc = d.screen || [d.width, d.height];
  const o = { viewport: { width: d.width, height: d.height }, screen: { width: sc[0], height: sc[1] }, deviceScaleFactor: d.dpr, hasTouch: d.touch, isMobile: d.mobile };
  if (d.userAgent) o.userAgent = d.userAgent;
  return o;
}

/**
 * How a canvas is shown, from its backing size, its CSS box and the device pixel ratio (all exact numbers from the page):
 * device px it covers, scale per axis, whether that is a whole number, and what it does to the picture.
 * c: {w, h, rect: [x, y, w, h] (CSS px), imageRendering}. dpr: window.devicePixelRatio.
 */
export function canvasDisplay(c, dpr) {
  const r = c.rect || [0, 0, 0, 0];
  const dw = r[2] * dpr, dh = r[3] * dpr;
  const sx = c.w ? dw / c.w : 0, sy = c.h ? dh / c.h : 0;
  const near = (v) => Math.abs(v - Math.round(v)) < 0.005;
  const integer = sx > 0 && near(sx) && near(sy) && Math.round(sx) === Math.round(sy);
  const crisp = /pixelated|crisp-edges|optimize-contrast|optimizespeed/i.test(c.imageRendering || "");
  const ox = r[0] * dpr, oy = r[1] * dpr;
  const aligned = near(ox) && near(oy);
  const r4 = (v) => +v.toFixed(4);
  let verdict, problem = null;
  if (!(sx > 0 && sy > 0)) { verdict = "not visible (zero size)"; problem = "hidden"; }
  else if (integer && Math.round(sx) === 1) verdict = aligned ? "1:1, every canvas pixel is one device pixel (crisp)" : "1:1 but placed between device pixels (soft edges)";
  else if (integer) verdict = crisp ? `exact ×${Math.round(sx)} ${aligned ? "(crisp)" : "but placed between device pixels (uneven edge rows)"}` : `×${Math.round(sx)} upscaled with smoothing: blurry on this screen`;
  else if (sx < 1 && sy < 1) verdict = `downscaled ×${r4(sx)} (finer than the screen: fine for smooth art, pixel art loses pixels)`;
  else verdict = crisp ? `×${r4(sx)}${Math.abs(sx - sy) > 0.005 ? ` × ${r4(sy)}` : ""}, not a whole number: pixels drawn unevenly (some ${Math.floor(sx)} px, some ${Math.ceil(sx)} px wide)` : `×${r4(sx)}${Math.abs(sx - sy) > 0.005 ? ` × ${r4(sy)}` : ""} upscaled with smoothing: blurry on this screen`;
  if (!problem && sx > 0) {
    if (!integer && !(sx < 1 && sy < 1)) problem = crisp ? "fractional" : "blurry";
    else if (integer && Math.round(sx) > 1 && !crisp) problem = "blurry";
    else if (!aligned) problem = "offset";
  }
  return { device: [r4(dw), r4(dh)], scale: [r4(sx), r4(sy)], integer, crisp, offset: [r4(ox), r4(oy)], aligned, verdict, problem };
}
