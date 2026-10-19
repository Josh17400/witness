// Device profiles for browser launches (witness.json launch.device / --device): viewport in CSS px, device pixel
// ratio, touch, mobile viewport handling, user agent, and whether the page runs as a Home Screen web app.
// Sizes are Apple's published point sizes; the iPhone profiles are full screen (a web app added to the Home Screen),
// the "-safari" one is a Safari tab (toolbars take the rest, the same viewport Playwright uses for "iPhone 15").
import { WitnessError } from "./session.js";

const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
// iPadOS Safari asks for the desktop site by default: it reports itself as a Mac (with touch).
const IPADOS_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

export const DEVICES = {
  "iphone-15": { title: "iPhone 15, Home Screen web app", width: 393, height: 852, dpr: 3, touch: true, mobile: true, standalone: true, userAgent: IOS_UA },
  "iphone-15-safari": { title: "iPhone 15, Safari tab", width: 393, height: 659, dpr: 3, touch: true, mobile: true, standalone: false, userAgent: IOS_UA },
  "iphone-15-pro-max": { title: "iPhone 15 Pro Max, Home Screen web app", width: 430, height: 932, dpr: 3, touch: true, mobile: true, standalone: true, userAgent: IOS_UA },
  "iphone-se": { title: "iPhone SE (2nd/3rd gen), Home Screen web app", width: 375, height: 667, dpr: 2, touch: true, mobile: true, standalone: true, userAgent: IOS_UA },
  "ipad": { title: "iPad (10th gen), Home Screen web app", width: 820, height: 1180, dpr: 2, touch: true, mobile: true, standalone: true, userAgent: IPADOS_UA },
};

const num = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

/**
 * A device spec → a profile {name, title, width, height, dpr, touch, mobile, standalone, userAgent, landscape}.
 * spec: "iphone-15", "iphone-15-landscape" (or ":landscape"), or a custom object {width, height, dpr?, touch?, mobile?,
 * userAgent?, standalone?, landscape?, name?}. null/undefined → null (desktop, no emulation).
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
    base = { title: spec.title || spec.name || "custom device", width: w, height: h, dpr, touch: !!spec.touch, mobile: !!spec.mobile, standalone: !!spec.standalone, userAgent: spec.userAgent ? String(spec.userAgent) : null };
    name = spec.name ? String(spec.name) : `custom ${w}×${h}@${dpr}`;
  } else throw new WitnessError(`launch.device must be a device name or an object (got ${JSON.stringify(spec)})`);
  const [width, height] = landscape ? [Math.max(base.width, base.height), Math.min(base.width, base.height)] : [base.width, base.height];
  return { name, title: base.title + (landscape ? ", landscape" : ""), width, height, dpr: base.dpr, touch: base.touch, mobile: base.mobile, standalone: base.standalone, userAgent: base.userAgent, landscape };
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
  const o = { viewport: { width: d.width, height: d.height }, screen: { width: d.width, height: d.height }, deviceScaleFactor: d.dpr, hasTouch: d.touch, isMobile: d.mobile };
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
