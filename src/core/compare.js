// Witness core: compare two moments of a game exactly (state, digest, screenshot, audio).
// Used by `doctor` (same run twice, with a different run in between), test steps with
// `"match": "label"`, `witness test --repeat N`, and replays checked against <file>.state.json.
import crypto from "node:crypto";
import fs from "node:fs";

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

/** Pixels that differ between two rgba8 shots of the same size: {count, percent, bbox} (null if not comparable). */
export function shotPixelDiff(a, b) {
  if (!a || !b || a.format !== "rgba8" || b.format !== "rgba8" || a.width !== b.width || a.height !== b.height) return null;
  const pa = shotBytes(a), pb = shotBytes(b), w = a.width, h = a.height;
  let count = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0, n = w * h; i < n; i++) {
    const o = i * 4;
    if (pa[o] !== pb[o] || pa[o + 1] !== pb[o + 1] || pa[o + 2] !== pb[o + 2] || pa[o + 3] !== pb[o + 3]) {
      count++;
      const x = i % w, y = (i / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return { count, percent: (100 * count) / (w * h), bbox: count ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null };
}

/** Where two audio captures first differ: {seconds, maxDiff} (decoded through the media module when available). */
async function audioDiff(a, b) {
  try {
    const m = await import("../media/index.js");
    const da = m.decodePCM(a), db = m.decodePCM(b);
    const ca = da.channels[0], cb = db.channels[0];
    const n = Math.min(ca.length, cb.length);
    let first = -1, maxDiff = 0;
    for (let c = 0; c < Math.min(da.channels.length, db.channels.length); c++) {
      const x = da.channels[c], y = db.channels[c];
      for (let i = 0; i < n; i++) { const d = Math.abs(x[i] - y[i]); if (d > 0 && (first < 0 || i < first)) first = i; if (d > maxDiff) maxDiff = d; }
    }
    return { seconds: first < 0 ? null : first / da.sampleRate, maxDiff, lengths: [ca.length, cb.length], sampleRate: da.sampleRate };
  } catch { return null; }
}

/**
 * A Matcher remembers the first capture of each label and compares later captures to it.
 * capture = { snap, shot?, audio? } (audio = {sampleRate, channels, format, data}).
 */
export class Matcher {
  constructor() { this.refs = new Map(); }
  has(label) { return this.refs.has(label); }

  /** Store the first capture for `label`, or compare to it. Returns {first, ok, problems: [string], shots?: [a, b]}. */
  async check(label, cap, where = "") {
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
    if (ref.shotHash && cur.shotHash && ref.shotHash !== cur.shotHash) {
      const px = shotPixelDiff(ref.shot, cur.shot);
      problems.push(px ? `screenshot differs: ${px.count} px (${px.percent.toFixed(3)}%)${px.bbox ? ` in box x=${px.bbox.x} y=${px.bbox.y} ${px.bbox.w}×${px.bbox.h}` : ""}`
        : "screenshot differs");
    }
    if (ref.audioHash && cur.audioHash && ref.audioHash !== cur.audioHash) {
      const ad = await audioDiff(ref.audio, cur.audio);
      problems.push(ad ? `audio differs${ad.seconds != null ? ` from ${ad.seconds.toFixed(4)} s into the capture` : ""}${ad.lengths[0] !== ad.lengths[1] ? ` (lengths ${ad.lengths[0]} vs ${ad.lengths[1]} frames)` : ""}, max sample difference ${ad.maxDiff.toPrecision(3)}`
        : "audio differs");
    }
    return { first: false, ok: !problems.length, problems, shots: problems.some((p) => p.startsWith("screenshot")) ? [ref.shot, cur.shot] : undefined };
  }
}
