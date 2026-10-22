// Witness play: small shared helpers (expressions over snapshots, vectors, compass, formatting).
import { helpers } from "../core/expr.js";

const compiled = new Map();

/**
 * Compile a config expression ("state.player", "e.hostile", "e.state == 'windup'") into fn(scope).
 * Scope lookups go through `with`, so every expr.js helper (state, count, first, near, dist ...) works, plus the
 * extra names a caller binds (e = the entity being classified, player = the player object).
 */
export function compileExpr(src) {
  if (src == null || src === "") return null;
  if (typeof src === "function") return src;
  const key = String(src);
  if (compiled.has(key)) return compiled.get(key);
  let fn;
  try {
    // eslint-disable-next-line no-new-func
    const f = new Function("__s", `with (__s) { return (${key}\n); }`);
    fn = (scope) => { try { return f(scope); } catch { return undefined; } };
  } catch (e) {
    throw new Error(`play config: can't parse expression "${key}": ${e.message}`);
  }
  compiled.set(key, fn);
  return fn;
}

/** A scope object for one snapshot: expr.js helpers, plus extra bindings added per call via Object.create. */
export function scopeFor(snap) { return helpers(snap); }
export function withVars(scope, vars) { const s = Object.create(scope); Object.assign(s, vars); return s; }

// ------------------------------------------------------------------ vectors (2D plane)
export const len = (v) => Math.hypot(v[0], v[1]);
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const scale = (v, k) => [v[0] * k, v[1] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const norm = (v) => { const l = len(v); return l > 1e-9 ? [v[0] / l, v[1] / l] : [0, 0]; };
export const perp = (v) => [-v[1], v[0]];
/** Signed angle (radians) from a to b. */
export const angleBetween = (a, b) => Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);

// ------------------------------------------------------------------ compass
const DIRS8 = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];
/** Compass name of plane vector v. northSign = -1 means north is -y (screen coords). */
export function compass(v, northSign = -1) {
  if (Math.abs(v[0]) < 1e-9 && Math.abs(v[1]) < 1e-9) return "here";
  const y = northSign === -1 ? v[1] : -v[1];   // convert to screen-down y
  const a = Math.atan2(y, v[0]);               // 0 = E, +90 = S (screen)
  let i = Math.round(a / (Math.PI / 4));
  i = ((i % 8) + 8) % 8;
  return DIRS8[i];
}

const DIR_WORDS = {
  n: "N", north: "N", up: "N", u: "N", s: "S", south: "S", down: "S", d: "S", e: "E", east: "E", right: "E", r: "E",
  w: "W", west: "W", left: "W", l: "W", ne: "NE", northeast: "NE", "north-east": "NE", "up-right": "NE", upright: "NE",
  nw: "NW", northwest: "NW", "north-west": "NW", "up-left": "NW", upleft: "NW", se: "SE", southeast: "SE", "south-east": "SE",
  "down-right": "SE", downright: "SE", sw: "SW", southwest: "SW", "south-west": "SW", "down-left": "SW", downleft: "SW",
  forward: "F", forwards: "F", ahead: "F", back: "B", backward: "B", backwards: "B",
};
export function parseDir(word) { return word ? DIR_WORDS[String(word).toLowerCase()] || null : null; }

/** Unit plane vector for a compass name (screen north = up). */
export function dirVector(name, northSign = -1) {
  const m = { E: [1, 0], W: [-1, 0], N: [0, -1], S: [0, 1], NE: [1, -1], NW: [-1, -1], SE: [1, 1], SW: [-1, 1] }[name];
  if (!m) return null;
  const v = norm(m);
  return northSign === -1 ? v : [v[0], -v[1]];
}

// ------------------------------------------------------------------ formatting
export const r1 = (x) => (x == null || !Number.isFinite(+x) ? "?" : String(Math.round(+x * 10) / 10));
export const r0 = (x) => (x == null || !Number.isFinite(+x) ? "?" : String(Math.round(+x)));
export const fmtT = (t) => `${(Math.round(t * 10) / 10).toFixed(1)}s`;
export function clip(s, n) { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
export function oneLine(s) { return String(s ?? "").replace(/\s+/g, " ").trim(); }
/** Game text on one line, quoted, cut at n with a plain note of how much is left (full: whole). */
export function capText(s, n = 600, full = false, q = '"') {
  const t = oneLine(s);
  return full || t.length <= n ? `${q}${t}${q}` : `${q}${t.slice(0, n - 1)}…${q} (cut, ${t.length - n + 1} more chars; look --full)`;
}

/** Plural → singular for matching ("wolves" → "wolf", "potions" → "potion", "enemies" → "enemy"). */
export function singular(w) {
  w = String(w).toLowerCase();
  if (w.endsWith("ves") && w.length > 4) return w.slice(0, -3) + "f";
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (/(ses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  return w;
}

/** Levenshtein distance (small strings). */
export function editDistance(a, b) {
  a = String(a); b = String(b);
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** A tiny deterministic PRNG (mulberry32) for tie-breaks and rhythms. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
