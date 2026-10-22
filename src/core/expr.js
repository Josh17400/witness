// Witness core: evaluate expressions (eval / trace / test expects) against a game snapshot.
// Expressions are JavaScript, evaluated by the CLI on the JSON the game returned, so this works
// for games written in ANY language. Helpers make game-state questions short:
//   state.player.hp            count("Coin")          first("Boss")?.hp
//   all("Enemy").length        near([x, y], "Enemy")  dist(state.player.pos, first("Door").pos)
//   len(x)   approx(a, b, eps)   frame   time   entities
// Time helpers (need the previous frame's snapshot, which eval/trace/tests pass as `prev`):
//   prev.player.pos[0]     the same path one frame earlier (the previous step in point test steps)
//   rose(x) / fell(x)      x became true / false on this frame       changed(x)   x differs from the previous frame
//   since(x)               frames since x last became true (needs every-frame sampling: trace, --when, test ranges;
//                          if x is already true on the first sampled frame, counting starts there)

export class ExprError extends Error {}

const cache = new Map();
const TEMPORAL = ["rose", "fell", "changed", "since"];

/**
 * Rewrite rose(...)/fell(...)/changed(...)/since(...) calls into __t("kind", i) so the helper can evaluate the
 * argument's *source* on this frame and on the previous one. Strings and member calls (a.rose()) are left alone.
 * Returns { code, args: [argument source, ...] }.
 */
export function rewriteTemporal(src) {
  const args = [];
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {   // copy a string literal verbatim
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    const m = /^(rose|fell|changed|since)\s*\(/.exec(src.slice(i));
    const before = i > 0 ? src[i - 1] : "";
    if (m && !/[\w$.]/.test(before)) {
      // balanced argument
      let j = i + m[0].length, depth = 1, q = null;
      for (; j < src.length; j++) {
        const d = src[j];
        if (q) { if (d === "\\") j++; else if (d === q) q = null; continue; }
        if (d === '"' || d === "'" || d === "`") { q = d; continue; }
        if (d === "(") depth++;
        else if (d === ")" && --depth === 0) break;
      }
      if (depth !== 0) break;   // unbalanced: let the parser report it
      const arg = src.slice(i + m[0].length, j).trim();
      args.push(arg);
      out += `__t(${JSON.stringify(m[1])}, ${args.length - 1})`;
      i = j + 1; continue;
    }
    out += c; i++;
  }
  if (i < src.length) out += src.slice(i);
  return { code: out, args };
}

function compileExpr(src) {
  if (cache.has(src)) return cache.get(src);
  const { code, args } = TEMPORAL.some((k) => src.includes(k)) ? rewriteTemporal(src) : { code: src, args: [] };
  let fn;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function("H", `with (H) { return (${code}\n); }`);
  } catch (e) {
    throw new ExprError(`can't parse "${src}": ${e.message}`);
  }
  const entry = { fn, args };
  cache.set(src, entry);
  return entry;
}

const ENTITY_HELPERS = new Set(["entities", "all", "count", "first", "byId", "near"]);
/** Names expressions already mean something by (helpers, time helpers): an "evalAs" name can't be one of them. */
export const RESERVED_NAMES = new Set(["state", "snap", "prev", "frame", "time", "web", "entities", "all", "count", "first", "byId", "near", "dist", "len", "approx", "abs", "min", "max", "floor", "round", "sqrt", "sum", "Math", "JSON", "__t", ...TEMPORAL]);

/**
 * The top-level state keys a set of expressions reads, for the protocol's snapshot "paths" filter: state.player.pos
 * and prev.player → "player"; count()/first()/all()/near()/byId()/entities → "entities". Returns null when that
 * can't be known statically (bare `state`, `snap`, computed keys like state[k]): then no filter is used.
 */
export function statePaths(exprs) {
  const keys = new Set();
  for (const raw of exprs) {
    const src = String(raw);
    // split into code and string literals; strings become "" in the code (their text is kept for state["key"])
    let code = "";
    const lits = [];
    for (let i = 0; i < src.length;) {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") {
        let j = i + 1, text = "";
        while (j < src.length && src[j] !== c) { if (src[j] === "\\") { text += src[j + 1] ?? ""; j += 2; } else text += src[j++]; }
        if (c === "`" && /\$\{/.test(text)) return null;   // template with code inside
        lits.push(text);
        code += `${c}${lits.length - 1}${c}`;
        i = j + 1;
        continue;
      }
      code += c; i++;
    }
    const re = /(^|[^\w$.])([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(code))) {
      const id = m[2], at = m.index + m[0].length;
      if (id === "snap") return null;
      if (ENTITY_HELPERS.has(id)) { keys.add("entities"); continue; }
      if (id !== "state" && id !== "prev") continue;
      const rest = code.slice(at);
      const dot = /^\s*\??\.\s*([A-Za-z_$][\w$]*)/.exec(rest);
      if (dot) { keys.add(dot[1]); continue; }
      const br = /^\s*(?:\?\.)?\[\s*(["'`])(\d+)\1\s*\]/.exec(rest);
      if (br) { keys.add(lits[+br[2]]); continue; }
      return null;   // bare state/prev, or a computed key: everything may be needed
    }
  }
  return keys.size ? [...keys].sort() : null;
}

/** Does an expression look at the previous frame (prev, rose, fell, changed, since)? */
export const usesPrev = (src) => /(^|[^\w$.])(prev|rose|fell|changed|since)\b/.test(String(src));

/**
 * Per-run memory for since(): which frame each argument last became true on. Create one per run (or test range)
 * and pass it to evaluate()/check() on every sampled frame, in frame order.
 */
export class TimeContext {
  constructor() { this.m = new Map(); }
}
const truthy = (v) => !!v;

const typeOf = (e) => e && (e.type ?? e.kind ?? e.class ?? e.name);
const posOf = (p) => (Array.isArray(p) ? p : p && Array.isArray(p.pos) ? p.pos : p && typeof p === "object" && "x" in p ? [p.x, p.y, p.z ?? 0] : null);

export function helpers(snap, prev = null, ctx = null, targs = []) {
  const state = (snap && snap.state) || {};
  const entities = Array.isArray(state.entities) ? state.entities : [];
  const match = (t) => (t == null ? entities : entities.filter((e) => typeOf(e) === t || (typeof t === "function" && t(e))));
  const dist = (a, b) => {
    const p = posOf(a), q = posOf(b);
    if (!p || !q) return NaN;
    let s = 0;
    for (let i = 0; i < Math.max(p.length, q.length); i++) s += ((p[i] || 0) - (q[i] || 0)) ** 2;
    return Math.sqrt(s);
  };
  return {
    ...(snap && snap.__vars ? snap.__vars : {}),   // test steps' "evalAs" values (page values by name); the helpers below win
    state, snap, prev: prev ? prev.state : null, frame: snap ? snap.frame : 0, time: snap ? snap.time : 0,
    web: snap && snap.web != null ? snap.web : null,   // browser launches: device, dpr, audio policy/state (filled when an expression reads web.)
    entities,
    all: (t) => match(t),
    count: (t) => match(t).length,
    first: (t) => match(t)[0] ?? null,
    byId: (id) => entities.find((e) => e.id === id) ?? null,
    near: (p, t) => { let best = null, bd = Infinity; for (const e of match(t)) { const d = dist(p, e); if (d < bd) { bd = d; best = e; } } return best; },
    dist,
    len: (x) => (x == null ? 0 : typeof x === "string" || Array.isArray(x) ? x.length : typeof x === "object" ? Object.keys(x).length : 0),
    approx: (a, b, eps = 1e-3) => Math.abs(a - b) <= eps,
    abs: Math.abs, min: Math.min, max: Math.max, floor: Math.floor, round: Math.round, sqrt: Math.sqrt,
    sum: (xs) => (xs || []).reduce((a, b) => a + (+b || 0), 0),
    Math, JSON,
    __t: (kind, i) => temporal(kind, targs[i], snap, prev, ctx),
  };
}

/** rose/fell/changed/since: the argument evaluated on this frame and on the previous one. */
function temporal(kind, argSrc, snap, prev, ctx) {
  const cur = evaluate(argSrc, snap, prev, ctx);
  let before;
  if (prev) { try { before = evaluate(argSrc, prev, null, null); } catch { before = undefined; } }
  if (kind === "changed") return !!prev && JSON.stringify(cur) !== JSON.stringify(before);
  if (kind === "rose") return !!prev && truthy(cur) && !truthy(before);
  if (kind === "fell") return !!prev && !truthy(cur) && truthy(before);
  // since(x): frames since x last became true (true on the run's first sample counts as becoming true there)
  if (!ctx) throw new ExprError(`since(${argSrc}) needs every-frame sampling: use it in trace, eval --when, or test always/never/eventually ranges`);
  const f = snap ? snap.frame : 0;
  let m = ctx.m.get(argSrc);
  if (!m) { m = { seen: null, last: null }; ctx.m.set(argSrc, m); }
  if (m.seen !== f) {
    // already true on the first frame this run/range samples: counting starts there
    if (truthy(cur) && (m.seen === null || !prev || !truthy(before))) m.last = f;
    m.seen = f;
  }
  return m.last == null ? null : f - m.last;
}

/** Evaluate `src` against a snapshot. Throws ExprError with a friendly message. */
export function evaluate(src, snap, prev = null, ctx = null) {
  const { fn, args } = compileExpr(src);
  try {
    return fn(helpers(snap, prev, ctx, args));
  } catch (e) {
    if (e instanceof ExprError) throw e;
    const m = /Cannot read propert(?:y|ies) of (undefined|null) \(reading '([^']+)'\)/.exec(e.message);
    if (m && !prev && /(^|[^\w$.])prev\b/.test(src)) throw new ExprError(`"${src}": prev is null here (the first sample has no previous frame)`);
    if (m) throw new ExprError(`"${src}": something before .${m[2]} is ${m[1] === "null" ? "null" : "missing"} in this snapshot — check the path with 'witness eval --keys${hint.flags}'`);
    throw new ExprError(`"${src}": ${e.message}`);
  }
}

/** For comparisons, split "a OP b" so failures can show both sides. */
export function splitComparison(src) {
  let depth = 0, q = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === q && src[i - 1] !== "\\") q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0) {
      for (const op of ["===", "!==", "==", "!=", "<=", ">=", "<", ">"]) {
        if (src.startsWith(op, i) && !(op === "<" && src[i + 1] === "=") && !(op === ">" && src[i + 1] === "=")
            && !(op.length === 2 && src[i + 2] === "=" && (op === "==" || op === "!="))) {
          return { left: src.slice(0, i).trim(), op, right: src.slice(i + op.length).trim() };
        }
      }
    }
  }
  return null;
}

/** Check an expectation; returns {ok, detail}. */
export function check(src, snap, prev = null, ctx = null) {
  const ok = evaluate(src, snap, prev, ctx);
  // "a OP b" shows both sides; an expression joined by && / || / ?: is judged whole (its halves may not stand alone)
  const cmp = topLevelLogic(src) ? null : splitComparison(src);
  if (cmp) {
    try {
      const a = evaluate(cmp.left, snap, prev, ctx), b = evaluate(cmp.right, snap, prev, ctx);
      return { ok: !!ok, detail: `got ${fmt(a)} ${cmp.op} ${fmt(b)}` };
    } catch { /* a side that can't be evaluated alone: fall back to the whole value */ }
  }
  return { ok: !!ok, detail: `got ${fmt(ok)}` };
}

/** Does the expression have &&, ||, ?? or a ternary at the top level (outside brackets and strings)? */
export function topLevelLogic(src) {
  let depth = 0, q = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0) {
      const two = src.slice(i, i + 2);
      if (two === "&&" || two === "||" || two === "??") return true;
      if (c === "?" && src[i + 1] !== "." ) return true;
    }
  }
  return false;
}

export function fmt(v, max = 80) {
  let s;
  if (typeof v === "number") s = Number.isInteger(v) ? String(v) : String(+v.toFixed(3));
  else if (typeof v === "string") s = JSON.stringify(v);
  else { try { s = JSON.stringify(v); } catch { s = String(v); } }
  if (s === undefined) s = "undefined";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Flags printed commands carry (" --config witness.web.json --device iphone-15"): set once by the CLI. */
export const hint = { flags: "" };

/** List key paths of a snapshot (for 'witness eval --keys'), sampling arrays. */
export function keyPaths(obj, prefix = "state", depth = 0, out = []) {
  if (depth > 4 || obj == null || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    out.push(`${prefix}  [${obj.length} items]`);
    if (obj.length && typeof obj[0] === "object") keyPaths(obj[0], `${prefix}[0]`, depth + 1, out);
    return out;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k], p = /^[A-Za-z_$][\w$]*$/.test(k) ? `${prefix}.${k}` : `${prefix}[${JSON.stringify(k)}]`;
    if (v && typeof v === "object") keyPaths(v, p, depth + 1, out);
    else out.push(`${p} = ${fmt(v, 40)}`);
  }
  return out;
}
