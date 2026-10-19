// Witness core: describe a snapshot's shape for `witness eval --keys` (what can I write in an expression?).
//   state.player.pos = [40,90]                    primitive arrays inline
//   state.map.rows  [18 × "##############…"]       long arrays elided
//   state.entities  [6]: Player ×1, Coin ×5        arrays of typed objects grouped by type,
//     Coin ×5: id, type, pos [2], item = true       with the union of their fields
// Paths whose value differs from a reference snapshot (e.g. frame 0) are marked "~" (they are live).
import { fmt } from "./expr.js";

const IDENT = /^[A-Za-z_$][\w$]*$/;
const sub = (prefix, k) => (IDENT.test(k) ? `${prefix}.${k}` : `${prefix}[${JSON.stringify(k)}]`);
const typeOf = (e) => (e && typeof e === "object" ? e.type ?? e.kind ?? null : null);
const isPrim = (v) => v === null || typeof v !== "object";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** One line describing a field across a group of objects: "hp ∈ 1..3", "state ∈ {idle, chase}", "pos [2]". */
function fieldSummary(k, vals, total) {
  const present = vals.filter((v) => v !== undefined);
  const opt = present.length < total ? "?" : "";
  const kinds = new Set(present.map((v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v)));
  if (kinds.size === 1) {
    const kind = [...kinds][0];
    if (kind === "array") {
      if (present.every((v) => same(v, present[0])) && present[0].every(isPrim) && fmt(present[0], 1e9).length <= 40) return `${k}${opt} = ${fmt(present[0], 40)}`;
      const lens = new Set(present.map((v) => v.length));
      return `${k}${opt} [${lens.size === 1 ? [...lens][0] : `${Math.min(...lens)}..${Math.max(...lens)}`}]`;
    }
    if (kind === "object") return `${k}${opt} {${[...new Set(present.flatMap((v) => Object.keys(v)))].slice(0, 6).join(", ")}}`;
    const distinct = [...new Set(present.map((v) => JSON.stringify(v)))];
    if (distinct.length === 1) return `${k}${opt} = ${fmt(present[0], 24)}`;
    if (kind === "number") return `${k}${opt} ∈ ${+Math.min(...present).toFixed(3)}..${+Math.max(...present).toFixed(3)}`;
    if (distinct.length <= 6) return `${k}${opt} ∈ {${distinct.map((d) => (kind === "string" ? JSON.parse(d) : d)).join(", ")}}`;
    return `${k}${opt} (${distinct.length} ${kind}s)`;
  }
  return `${k}${opt} (${[...kinds].join("|")})`;
}

/** Group lines for an array of objects (typed or not). */
function objectArray(path, arr, ref, mark, out, isEntities, marking) {
  const typed = arr.some((e) => typeOf(e) != null);
  if (!typed) {
    const keys = [...new Set(arr.flatMap((e) => (e && typeof e === "object" ? Object.keys(e) : [])))];
    out.push(`${mark(arr, ref)}${path}  [${arr.length}] each {${keys.slice(0, 12).map((k) => fieldSummary(k, arr.map((e) => e?.[k]), arr.length)).join(", ")}}`);
    return;
  }
  const groups = new Map();
  for (const e of arr) { const t = typeOf(e) ?? "?"; if (!groups.has(t)) groups.set(t, []); groups.get(t).push(e); }
  out.push(`${mark(arr, ref)}${path}  [${arr.length}]: ${[...groups].map(([t, g]) => `${t} ×${g.length}`).join(", ")}`);
  const refGroups = new Map();
  if (Array.isArray(ref)) for (const e of ref) { const t = typeOf(e) ?? "?"; if (!refGroups.has(t)) refGroups.set(t, []); refGroups.get(t).push(e); }
  for (const [t, g] of groups) {
    const keys = [...new Set(g.flatMap((e) => Object.keys(e)))].filter((k) => k !== "type" && k !== "kind");
    const live = marking && !same(g, refGroups.get(t));
    out.push(`${live ? "~" : " "}   ${t} ×${g.length}: ${keys.map((k) => fieldSummary(k, g.map((e) => e[k]), g.length)).join(", ")}`);
  }
  if (isEntities) {
    const t = [...groups].filter(([x]) => x !== "?").sort((a, b) => b[1].length - a[1].length)[0]?.[0] ?? "Type";
    out.push(`     (helpers: count('${t}'), first('${t}').${Object.keys(groups.get(t)[0]).find((k) => k !== "type" && k !== "id") ?? "id"}, all('${t}'), near(pos, '${t}'), byId(id))`);
  }
}

/**
 * Lines describing `state`. `ref` (optional) is the same game's state at another moment: paths whose value
 * differs are marked "~". Depth-limited; arrays are summarized, never listed item by item.
 */
export function describeState(state, ref = undefined, { maxDepth = 5 } = {}) {
  const out = [];
  const mark = (v, r) => (ref === undefined ? " " : same(v, r) ? " " : "~");
  const walk = (v, r, path, depth) => {
    if (isPrim(v)) { out.push(`${mark(v, r)}${path} = ${fmt(v, 48)}`); return; }
    if (Array.isArray(v)) {
      if (!v.length) { out.push(`${mark(v, r)}${path} = []`); return; }
      if (v.every(isPrim)) {
        const s = fmt(v, 1e9);
        if (v.length <= 8 && s.length <= 60) out.push(`${mark(v, r)}${path} = ${s}`);
        else if (v.every((x) => typeof x === "number")) out.push(`${mark(v, r)}${path}  [${v.length} numbers, ${+Math.min(...v).toFixed(3)}..${+Math.max(...v).toFixed(3)}]`);
        else out.push(`${mark(v, r)}${path}  [${v.length} × ${fmt(v[0], 18)}]`);
        return;
      }
      if (v.every((x) => x && typeof x === "object" && !Array.isArray(x))) { objectArray(path, v, r, mark, out, path === "state.entities", ref !== undefined); return; }
      out.push(`${mark(v, r)}${path}  [${v.length} mixed items]`);
      return;
    }
    if (depth >= maxDepth) { out.push(`${mark(v, r)}${path}  {${Object.keys(v).slice(0, 8).join(", ")}${Object.keys(v).length > 8 ? ", …" : ""}}`); return; }
    const keys = Object.keys(v);
    if (!keys.length) { out.push(`${mark(v, r)}${path} = {}`); return; }
    for (const k of keys) walk(v[k], r && typeof r === "object" && !Array.isArray(r) ? r[k] : undefined, sub(path, k), depth + 1);
  };
  if (state && typeof state === "object" && !Array.isArray(state)) {
    for (const k of Object.keys(state)) walk(state[k], ref && typeof ref === "object" ? ref[k] : ref === undefined ? undefined : null, sub("state", k), 1);
  } else walk(state, ref, "state", 0);
  return out;
}
