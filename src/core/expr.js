// Witness core: evaluate expressions (eval / trace / test expects) against a game snapshot.
// Expressions are JavaScript, evaluated by the CLI on the JSON the game returned, so this works
// for games written in ANY language. Helpers make game-state questions short:
//   state.player.hp            count("Coin")          first("Boss")?.hp
//   all("Enemy").length        near([x, y], "Enemy")  dist(state.player.pos, first("Door").pos)
//   len(x)   approx(a, b, eps)   frame   time   entities   prev (previous snapshot, in traces/tests)

export class ExprError extends Error {}

const cache = new Map();

function compileExpr(src) {
  if (cache.has(src)) return cache.get(src);
  let fn;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function("H", `with (H) { return (${src}\n); }`);
  } catch (e) {
    throw new ExprError(`can't parse "${src}": ${e.message}`);
  }
  cache.set(src, fn);
  return fn;
}

const typeOf = (e) => e && (e.type ?? e.kind ?? e.class ?? e.name);
const posOf = (p) => (Array.isArray(p) ? p : p && Array.isArray(p.pos) ? p.pos : p && typeof p === "object" && "x" in p ? [p.x, p.y, p.z ?? 0] : null);

export function helpers(snap, prev = null) {
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
    state, snap, prev: prev ? prev.state : null, frame: snap ? snap.frame : 0, time: snap ? snap.time : 0,
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
  };
}

/** Evaluate `src` against a snapshot. Throws ExprError with a friendly message. */
export function evaluate(src, snap, prev = null) {
  const fn = compileExpr(src);
  try {
    return fn(helpers(snap, prev));
  } catch (e) {
    const m = /Cannot read propert(?:y|ies) of (undefined|null) \(reading '([^']+)'\)/.exec(e.message);
    if (m) throw new ExprError(`"${src}": something before .${m[2]} is ${m[1] === "null" ? "null" : "missing"} in this snapshot — check the path with 'witness eval --keys'`);
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
export function check(src, snap, prev = null) {
  const cmp = splitComparison(src);
  if (cmp) {
    const a = evaluate(cmp.left, snap, prev), b = evaluate(cmp.right, snap, prev);
    const ok = evaluate(src, snap, prev);
    return { ok: !!ok, detail: ok ? null : `got ${fmt(a)} ${cmp.op} ${fmt(b)}` };
  }
  const v = evaluate(src, snap, prev);
  return { ok: !!v, detail: v ? null : `got ${fmt(v)}` };
}

export function fmt(v, max = 80) {
  let s;
  if (typeof v === "number") s = Number.isInteger(v) ? String(v) : String(+v.toFixed(3));
  else if (typeof v === "string") s = JSON.stringify(v);
  else { try { s = JSON.stringify(v); } catch { s = String(v); } }
  if (s === undefined) s = "undefined";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

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
