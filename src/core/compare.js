// Witness core: compare two moments of a game exactly (state, digest, screenshot, audio).
// Used by `doctor` (same run twice, with a different run in between), test steps with
// `"match": "label"`, `witness test --repeat N`, and replays checked against <file>.state.json.
import crypto from "node:crypto";
import fs from "node:fs";
import { decodePNG, isPNG } from "../media/png.js";

/** Deep differences between two JSON values: [{path, a, b}], at most `limit`. */
export function diffValues(a, b, at = "", out = [], limit = 12, skip = null) {
  if (out.length >= limit) return out;
  if (skip && at && skip(at)) return out;
  if (a === b) return out;
  const ta = Array.isArray(a) ? "array" : a === null ? "null" : typeof a;
  const tb = Array.isArray(b) ? "array" : b === null ? "null" : typeof b;
  if (ta !== tb || ta !== "object" && ta !== "array") {
    if (ta === "number" && tb === "number" && Number.isNaN(a) && Number.isNaN(b)) return out;
    out.push({ path: at || "(root)", a, b });
    return out;
  }
  if (ta === "array") {
    if (a.length !== b.length) out.push({ path: `${at}.length`, a: a.length, b: b.length });
    for (let i = 0; i < Math.min(a.length, b.length) && out.length < limit; i++) diffValues(a[i], b[i], `${at}[${i}]`, out, limit, skip);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (out.length >= limit) break;
    const p = at ? `${at}.${k}` : k;
    if (skip && skip(p)) continue;
    if (!(k in a)) out.push({ path: p, a: undefined, b: b[k] });
    else if (!(k in b)) out.push({ path: p, a: a[k], b: undefined });
    else diffValues(a[k], b[k], p, out, limit, skip);
  }
  return out;
}

/**
 * Differences between two game states for a human/AI reader: like diffValues, but arrays of objects that all have
 * an `id` are matched by id (so one coin disappearing reads "removed Coin#12", not 5 shifted entries), and added /
 * removed entries are reported once. Returns [{ path, kind: "changed" | "added" | "removed", a, b }].
 */
export function diffStates(a, b, at = "state", out = [], limit = 500) {
  if (out.length >= limit || a === b) return out;
  const ta = Array.isArray(a) ? "array" : a === null ? "null" : typeof a;
  const tb = Array.isArray(b) ? "array" : b === null ? "null" : typeof b;
  if (ta !== tb || (ta !== "object" && ta !== "array")) {
    if (ta === "number" && tb === "number" && Number.isNaN(a) && Number.isNaN(b)) return out;
    out.push({ path: at, kind: "changed", a, b });
    return out;
  }
  if (ta === "array") {
    const byId = (arr) => arr.length && arr.every((e) => e && typeof e === "object" && !Array.isArray(e) && e.id != null);
    if (byId(a) && byId(b)) {
      const ma = new Map(a.map((e) => [e.id, e])), mb = new Map(b.map((e) => [e.id, e]));
      const tag = (e) => `${e.type ?? e.kind ?? ""}#${e.id}`;
      for (const [id, e] of ma) if (!mb.has(id) && out.length < limit) out.push({ path: `${at}[${tag(e)}]`, kind: "removed", a: e, b: undefined });
      for (const [id, e] of mb) if (!ma.has(id) && out.length < limit) out.push({ path: `${at}[${tag(e)}]`, kind: "added", a: undefined, b: e });
      for (const [id, e] of ma) if (mb.has(id)) diffStates(e, mb.get(id), `${at}[${tag(e)}]`, out, limit);
      return out;
    }
    if (a.length !== b.length && (a.every((x) => x === null || typeof x !== "object") || b.every((x) => x === null || typeof x !== "object"))) {
      out.push({ path: at, kind: "changed", a, b });   // a list of values changed length: show it whole
      return out;
    }
    if (a.every((x) => x === null || typeof x !== "object") && b.every((x) => x === null || typeof x !== "object")) {
      if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path: at, kind: "changed", a, b });   // vectors read best whole
      return out;
    }
    if (a.length !== b.length) out.push({ path: `${at}.length`, kind: "changed", a: a.length, b: b.length });
    for (let i = 0; i < Math.min(a.length, b.length) && out.length < limit; i++) diffStates(a[i], b[i], `${at}[${i}]`, out, limit);
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (out.length >= limit) break;
    const p = /^[A-Za-z_$][\w$]*$/.test(k) ? `${at}.${k}` : `${at}[${JSON.stringify(k)}]`;
    if (!(k in a)) out.push({ path: p, kind: "added", a: undefined, b: b[k] });
    else if (!(k in b)) out.push({ path: p, kind: "removed", a: a[k], b: undefined });
    else diffStates(a[k], b[k], p, out, limit);
  }
  return out;
}

/**
 * A skip test for diffValues from path patterns like "player.px", "entities[*].dist" or "view.*": a diff path is
 * skipped when it is a pattern or lies under one. `*` matches one key, `[*]` any index; the leading "state." is optional.
 */
export function pathFilter(patterns, root = "state") {
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const res = patterns.map((p) => String(p).trim()).filter(Boolean).map((p) => {
    const full = p === root || p.startsWith(`${root}.`) || p.startsWith(`${root}[`) ? p : `${root}.${p}`;
    // "[*]" any index, "[3]" that index, "*" one key; the rest is literal
    const src = full.split(/(\[\*\]|\[\d+\]|\*)/).map((t) => (t === "[*]" ? "\\[\\d+\\]" : /^\[\d+\]$/.test(t) ? `\\[${t.slice(1, -1)}\\]` : t === "*" ? "[^.[]+" : esc(t))).join("");
    return new RegExp(`^${src}(?:$|[.[])`);
  });
  return (path) => res.some((re) => re.test(path));
}

const sha1 = (buf) => crypto.createHash("sha1").update(buf).digest("hex");
const short = (v) => { const s = v === undefined ? "(missing)" : JSON.stringify(v); return s.length > 60 ? `${s.slice(0, 57)}…` : s; };

/** The digest a game may provide: snapshot.digest or state.digest (any string/number covering its full internal state). */
export const digestOf = (snap) => snap?.digest ?? snap?.state?.digest ?? null;

function shotBytes(shot) {
  if (!shot) return null;
  if (shot.path) { try { return fs.readFileSync(shot.path); } catch { return null; } }
  return shot.data ? Buffer.from(shot.data, "base64") : null;
}

/** A shot ({format: "rgba8"|"png", data} or {path}) decoded to {width, height, data: rgba} (null: none / not readable). */
export function shotImageOf(shot) {
  if (!shot) return null;
  if (shot.width != null && shot.data && shot.data.length === shot.width * shot.height * 4 && typeof shot.data !== "string") return shot;   // already an image
  const buf = shotBytes(shot);
  if (!buf) return null;
  if (isPNG(buf)) { try { return decodePNG(buf); } catch { return null; } }
  if (shot.format && shot.format !== "rgba8") return null;
  if (!(shot.width > 0 && shot.height > 0) || buf.length < shot.width * shot.height * 4) return null;
  return { width: shot.width, height: shot.height, data: new Uint8Array(buf.buffer, buf.byteOffset, shot.width * shot.height * 4) };
}

/**
 * Pixels that differ between two shots of the same size (rgba8 or PNG): {count, percent, bbox, maxDelta, noise,
 * width, height} (null if not comparable). tol: per-channel difference allowed (0 = exact); count and bbox are the
 * pixels with some channel off by more than tol, noise the pixels that differ but within it (anti-aliasing / GPU
 * rounding: Chromium screen captures may differ by 1 level on edge pixels from run to run).
 */
export function shotPixelDiff(a, b, { tol = 0 } = {}) {
  const A = shotImageOf(a), B = shotImageOf(b);
  if (!A || !B || A.width !== B.width || A.height !== B.height) return null;
  const pa = A.data, pb = B.data, w = A.width, h = A.height;
  let count = 0, noise = 0, maxDelta = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0, n = w * h; i < n; i++) {
    const o = i * 4;
    if (pa[o] === pb[o] && pa[o + 1] === pb[o + 1] && pa[o + 2] === pb[o + 2] && pa[o + 3] === pb[o + 3]) continue;
    const d = Math.max(Math.abs(pa[o] - pb[o]), Math.abs(pa[o + 1] - pb[o + 1]), Math.abs(pa[o + 2] - pb[o + 2]), Math.abs(pa[o + 3] - pb[o + 3]));
    if (d > maxDelta) maxDelta = d;
    if (d <= tol) { noise++; continue; }
    count++;
    const x = i % w, y = (i / w) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { count, percent: (100 * count) / (w * h), bbox: count ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null, maxDelta, noise, tol, width: w, height: h };
}

/**
 * A picture of where two same-size images differ: A faded to grey, pixels off by more than tol in red, pixels that
 * differ within tol in yellow, the bounding box of the red ones outlined in magenta. Returns rgba (Uint8Array).
 */
export function pixelDiffImage(A, B, tol = 0) {
  const w = A.width, h = A.height, out = new Uint8Array(w * h * 4), pa = A.data, pb = B.data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const d = Math.max(Math.abs(pa[o] - pb[o]), Math.abs(pa[o + 1] - pb[o + 1]), Math.abs(pa[o + 2] - pb[o + 2]), Math.abs(pa[o + 3] - pb[o + 3]));
    if (d > tol) { out[o] = 255; out[o + 1] = 40; out[o + 2] = 60; const x = i % w, y = (i / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    else if (d > 0) { out[o] = 255; out[o + 1] = 210; out[o + 2] = 0; }
    else { const g = 40 + Math.round(0.25 * (0.299 * pa[o] + 0.587 * pa[o + 1] + 0.114 * pa[o + 2])); out[o] = out[o + 1] = out[o + 2] = g; }
    out[o + 3] = 255;
  }
  if (x1 >= 0) {
    const put = (x, y) => { if (x >= 0 && y >= 0 && x < w && y < h) { const o = (y * w + x) * 4; out[o] = 255; out[o + 1] = 0; out[o + 2] = 255; } };
    for (let x = x0 - 2; x <= x1 + 2; x++) { put(x, y0 - 2); put(x, y1 + 2); }
    for (let y = y0 - 2; y <= y1 + 2; y++) { put(x0 - 2, y); put(x1 + 2, y); }
  }
  return out;
}

/** Two audio captures compared within tol: src/media/audio-compare.js comparePCM + its words (null: not decodable). */
async function audioDiff(a, b, tol) {
  try {
    const m = await import("../media/audio-compare.js");
    const d = m.comparePCM(a, b, { tol });
    return { ...d, text: m.describePCMDiff(d) };
  } catch { return null; }
}

/** The audio tolerance from --audio-tol, else witness.json "audioTol", else 1e-5 (per sample, full scale 1; 0 = exact). */
export function audioTolOf(opt = {}, cfg = {}) {
  const v = opt["audio-tol"] !== undefined && opt["audio-tol"] !== true ? opt["audio-tol"] : cfg && cfg.audioTol;
  if (v === undefined || v === null || v === "") return 1e-5;
  const n = +v;
  if (!(n >= 0 && n <= 2)) throw new RangeError(`--audio-tol / "audioTol" wants a per-sample difference 0..2 (default 1e-5; full scale is 1), got ${JSON.stringify(v)}`);
  return n;
}

/**
 * A Matcher remembers the first capture of each label and compares later captures to it.
 * capture = { snap, shot?, audio? } (audio = {sampleRate, channels, format, data}).
 */
export class Matcher {
  /** shotTol: per-channel screenshot difference allowed (0 = exact; doctor uses 2: GPU / anti-aliasing noise). */
  /** audioTol: per-sample audio difference allowed (default 1e-5: WebAudio float noise; 0 = exact). */
  constructor({ shotTol = 0, audioTol = 1e-5 } = {}) { this.refs = new Map(); this.shotTol = Math.max(0, +shotTol || 0); this.audioTol = Math.max(0, +audioTol || 0); }
  has(label) { return this.refs.has(label); }

  /**
   * Store the first capture for `label`, or compare to it. Returns {first, ok, problems: [string], shots?: [a, b]}.
   * release: this is the label's last comparison (the last --repeat pass): drop the reference's full screenshot and
   * audio after it, so a long suite doesn't hold every step's pictures in memory to the end.
   */
  async check(label, cap, where = "", { release = false } = {}) {
    const ref = this.refs.get(label);
    const cur = {
      state: JSON.stringify(cap.snap?.state ?? null),
      digest: digestOf(cap.snap),
      shot: cap.shot || null, shotHash: cap.shot ? sha1(shotBytes(cap.shot) || Buffer.alloc(0)) : null,
      audio: cap.audio || null, audioHash: cap.audio?.data ? sha1(Buffer.from(String(cap.audio.data))) : null,
      where,
    };
    if (!ref) { this.refs.set(label, cur); return { first: true, ok: true, problems: [] }; }
    const problems = [];
    if (ref.state !== cur.state) {
      const d = diffValues(JSON.parse(ref.state), JSON.parse(cur.state), "state");
      problems.push(`state differs from ${ref.where || "the first capture"} at ${d.length >= 12 ? "12+" : d.length} path(s): ` +
        d.slice(0, 6).map((x) => `${x.path} ${short(x.a)} → ${short(x.b)}`).join("; "));
    }
    if (ref.digest != null && cur.digest != null && ref.digest !== cur.digest) problems.push(`digest differs (${short(ref.digest)} → ${short(cur.digest)}): hidden state the snapshot doesn't show changed`);
    let shotDiff = null;
    const notes = [];
    if (ref.shotHash && cur.shotHash && ref.shotHash !== cur.shotHash) {
      const px = shotDiff = shotPixelDiff(ref.shot, cur.shot, { tol: this.shotTol });
      const sizes = (() => { const A = shotImageOf(ref.shot), B = shotImageOf(cur.shot); return A && B && (A.width !== B.width || A.height !== B.height) ? ` (sizes ${A.width}×${A.height} vs ${B.width}×${B.height})` : ""; })();
      if (px && px.count === 0) notes.push(`screenshot: ${px.noise} px differ by at most ${px.maxDelta} level${px.maxDelta === 1 ? "" : "s"} (within the ±${px.tol} tolerance: anti-aliasing / GPU noise)`);
      else problems.push(px ? `screenshot differs: ${px.count} px (${px.percent.toFixed(3)}%) off by more than ${px.tol} level${px.tol === 1 ? "" : "s"}${px.bbox ? ` in box x=${px.bbox.x} y=${px.bbox.y} ${px.bbox.w}×${px.bbox.h}` : ""}, up to ${px.maxDelta} levels${px.noise ? ` (+${px.noise} px within ±${px.tol})` : ""}`
        : `screenshot differs${sizes}`);
    }
    if (ref.audioHash && cur.audioHash && ref.audioHash !== cur.audioHash) {
      const ad = await audioDiff(ref.audio, cur.audio, this.audioTol);
      if (!ad) problems.push("audio differs");
      else if (!ad.same) problems.push(ad.text);
      else if (ad.text) notes.push(ad.text);
    }
    const shots = problems.some((p) => p.startsWith("screenshot")) ? [ref.shot, cur.shot] : undefined;
    if (release) this.refs.delete(label);
    return { first: false, ok: !problems.length, problems, shots, notes, ...(shotDiff ? { shotDiff } : {}) };
  }
}
