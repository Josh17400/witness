// Witness play: the order language. Forgiving on purpose (synonyms, filler words, chains, plurals, typos get a
// "did you mean"), strict in one way: if it can't map the text to an order, nothing happens in the game.
import { parseDir, singular, editDistance } from "./util.js";
import { thingLabel } from "./perceive.js";

// multi-word verbs first (longest match wins)
const VERBS = [
  ["pick up", "pickup"], ["go to", "goto"], ["walk to", "goto"], ["move to", "goto"], ["run to", "goto"], ["head to", "goto"], ["travel to", "goto"],
  ["navigate to", "goto"], ["get to", "goto"], ["go over to", "goto"], ["walk over to", "goto"], ["return to", "goto"], ["go back to", "goto"],
  ["talk to", "talk"], ["talk with", "talk"], ["speak to", "talk"], ["speak with", "talk"], ["chat with", "talk"], ["chat to", "talk"],
  ["run away", "flee"], ["back off", "flee"], ["get away", "flee"], ["look at", "look"], ["aim at", "look"], ["turn to", "look"], ["face", "look"],
  ["wait for", "waitfor"], ["interact with", "interact"], ["switch to", "weapon"], ["equip", "weapon"],
  ["goto", "goto"], ["approach", "goto"], ["reach", "goto"], ["go", "go"], ["walk", "go"], ["move", "go"], ["head", "go"], ["step", "go"],
  ["explore", "explore"], ["wander", "explore"], ["scout", "explore"], ["search", "explore"], ["roam", "explore"],
  ["fight", "fight"], ["attack", "fight"], ["kill", "fight"], ["engage", "fight"], ["hit", "fight"], ["slay", "fight"], ["defeat", "fight"],
  ["battle", "fight"], ["strike", "fight"], ["shoot", "fight"], ["destroy", "fight"],
  ["flee", "flee"], ["retreat", "flee"], ["escape", "flee"], ["evade", "flee"],
  ["talk", "talk"], ["speak", "talk"], ["greet", "talk"], ["ask", "talk"], ["chat", "talk"],
  ["choose", "choose"], ["pick", "choose"], ["select", "choose"], ["answer", "choose"], ["reply", "choose"], ["say", "choose"], ["option", "choose"],
  ["pickup", "pickup"], ["get", "pickup"], ["grab", "pickup"], ["collect", "pickup"], ["take", "pickup"], ["loot", "pickup"], ["fetch", "pickup"],
  ["use", "use"], ["drink", "use"], ["quaff", "use"], ["eat", "use"], ["heal", "use"],
  ["interact", "interact"], ["activate", "interact"], ["open", "interact"], ["unlock", "interact"], ["inspect", "interact"], ["read", "interact"], ["examine", "interact"],
  ["press", "press"], ["tap", "press"], ["push", "press"], ["key", "press"], ["hold", "hold"],
  ["wait", "wait"], ["idle", "wait"], ["pause", "wait"], ["stay", "wait"], ["rest", "wait"],
  ["stop", "stop"], ["halt", "stop"], ["freeze", "stop"], ["nothing", "stop"],
  ["follow", "follow"], ["set", "set"], ["call", "call"], ["combo", "combo"], ["special", "combo"],
  ["jump", "jump"], ["hop", "jump"], ["leap", "jump"], ["run", "run"], ["dash", "run"], ["sprint", "run"], ["stomp", "stomp"],
  ["look", "look"], ["turn", "look"], ["aim", "look"], ["reload", "reload"], ["weapon", "weapon"], ["block", "block"], ["guard", "block"],
  ["dodge", "dodge"], ["roll", "dodge"], ["respawn", "respawn"], ["revive", "respawn"], ["continue", "respawn"],
];
const VERB_NAMES = [...new Set(VERBS.map((v) => v[0]))];
const FILLER = /^(please|now|ok|okay|and|then|also|lets|let's|let us|i will|i'll|try to|try|go and|quickly|carefully|just)\s+/i;
const CATEGORY = {
  enemy: "hostile", enemies: "hostile", monster: "hostile", monsters: "hostile", foe: "hostile", foes: "hostile", hostile: "hostile",
  hostiles: "hostile", baddie: "hostile", baddies: "hostile", target: "hostile", targets: "hostile", opponent: "hostile", opponents: "hostile",
  npc: "npc", npcs: "npc", person: "npc", someone: "npc", somebody: "npc", character: "npc", people: "npc",
  item: "item", items: "item", loot: "item", pickup: "item", pickups: "item", stuff: "item", powerup: "item", "power-up": "item",
  teammate: "friend", teammates: "friend", ally: "friend", allies: "friend", friend: "friend", friends: "friend", buddy: "friend", squad: "friend",
  anything: "any", thing: "any", something: "any",
};
const ORDINAL = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, one: 1, two: 2, three: 3, four: 4, five: 5, top: 1 };
const SIZE_WORDS = { short: "short", small: "short", tiny: "short", little: "short", medium: "medium", normal: "medium", long: "long", far: "long", big: "long", high: "high", tall: "high", full: "high", max: "high" };
const HEAL_WORDS = /^(potion|potions|heal|healing|health|medkit|food|bandage|elixir|flask)$/i;

export class OrderError extends Error { constructor(message, hint) { super(message); this.hint = hint; } }

export const ORDER_CARD = [
  "goto <thing|x,y> · go <n|s|e|w|ne…> [cells] · explore [dir] · follow <thing>",
  "fight [thing] [block|dodge|backoff|aggressive] [retreat 30%] · flee",
  "talk <who> · choose <n|words> · pickup [thing] · use <control|item> · interact [thing]",
  "press <key|control> [xN] · hold <key|control> <s> · wait [s] · stop · respawn · set retreat 30|heal 40|guard on|off|autofight on|off",
  "modifiers: for 8s · careful (wake on anything) · kite 4 (keep distance)",
].join("\n");
export const ORDER_CARD_PLATFORMER = "run <left|right> [to x] · jump [left|right] [short|long|high] · stomp <thing> · wait for <thing>";
export const ORDER_CARD_TURN = [
  "pick <n|words> (one of the choices: a card, a menu button, a move; by number or by words from its label)",
  "choose <n|words> (a dialogue option; pick works there too) · wait [s] (until your turn, new choices or a dialogue; cap s)",
  "press <key|control> [xN] · hold <key|control> <s> · stop",
].join("\n");
export const ORDER_CARD_FPS = "fight [thing] [hold] · look <dir|thing> · reload · weapon <n|name> · go forward|back|left|right [cells]";

function tokenize(s) {
  const out = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(s))) out.push(m[1] != null ? { w: m[1], q: true } : m[2] != null ? { w: m[2], q: true } : { w: m[3], q: false });
  return out;
}

/**
 * Split "a; b then c" into orders (not on commas: "12,5" is a coordinate). "next" only where it can't be a word of the
 * order: "next," / ". Next" / at an order's start ("talk to the next guard" is one order). A bare "next" piece
 * ("explore; next") is dropped, and so is a trailing comma ("goto Inn, next, talk guard").
 */
export function splitChain(text) {
  return String(text).split(/\s*(?:;|\n|\band then\b|\bthen\b|\bafter that\b|\bnext\s*,|[.!]\s+next\b)\s*/i).map((s) => s.trim().replace(/^next\s+/i, "").replace(/[.!,]+$/, "").trim()).filter((s) => s && !/^next$/i.test(s));
}

function suggestVerb(word) {
  let best = null, bd = Infinity;
  for (const v of VERB_NAMES) { const d = editDistance(word, v); if (d < bd) { bd = d; best = v; } }
  return bd <= 2 && word.length >= 3 ? best : null;
}

const NUM = /^-?\d+(?:\.\d+)?$/;
const parseSeconds = (s) => { const m = /^(\d+(?:\.\d+)?)(s|sec|secs|seconds?)?$/i.exec(s); return m ? +m[1] : null; };

/** Pull common modifiers out of a word list; returns {mods, rest}. */
function takeModifiers(words) {
  const mods = {}, rest = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i].w.toLowerCase(), nx = words[i + 1]?.w.toLowerCase(), nx2 = words[i + 2]?.w.toLowerCase();
    if (words[i].q) { rest.push(words[i]); continue; }
    if (w === "for" && nx && parseSeconds(nx.replace(/s$/, "")) != null) { mods.forS = parseSeconds(nx.replace(/s$/, "")); i++; if (/^(s|sec|secs|seconds?)$/.test(nx2 || "")) i++; continue; }
    if (/^(retreat|flee|run)$/.test(w) && nx) {
      let j = i + 1;
      if (/^(at|below|under|if|when)$/.test(words[j]?.w.toLowerCase())) j++;
      const m = /^(\d+(?:\.\d+)?)%?$/.exec(words[j]?.w || "");
      if (m) { mods.retreat = +m[1]; i = j; if (/^(%|percent|hp)$/i.test(words[i + 1]?.w || "")) i++; continue; }
    }
    if (w === "kite" || w === "keep-distance" || w === "range") { const m = NUM.test(nx || "") ? +nx : null; mods.mode = "kite"; mods.kite = m ?? 4; if (m != null) i++; continue; }
    if (/^(block|blocking|parry|shield)$/.test(w)) { mods.mode = "block"; continue; }
    if (/^(dodge|dodging|roll|evade)$/.test(w)) { mods.mode = "dodge"; continue; }
    if (/^(backoff|back-off|spacing|retreating)$/.test(w) || (w === "back" && nx === "off")) { mods.mode = "backoff"; if (w === "back") i++; continue; }
    if (/^(aggressive|aggressively|trade|reckless|rush|berserk)$/.test(w)) { mods.mode = "aggressive"; continue; }
    if (/^(careful|carefully|cautious|cautiously|slowly)$/.test(w)) { mods.careful = true; continue; }
    if ((w === "using" || w === "with") && nx) { mods.using = words[i + 1].w; i++; continue; }
    if (/^(shooting|ranged)$/.test(w)) { mods.mode = mods.mode || "ranged"; continue; }
    if (/^(hold|stay|camp|defensive|stationary)$/.test(w) || (w === "in" && nx === "place")) { mods.mode = "hold"; if (w === "in") i++; continue; }
    rest.push(words[i]);
  }
  return { mods, rest };
}

/** Parse a thing reference: "wolf", "Wolf#5", "#5", "wolf 5", "the old guard", "nearest enemy", "all coins". */
export function parseTarget(words) {
  let ws = words.filter((x) => !/^(the|a|an|to|at|that|this|over|there|me|my|of|toward|towards|into|onto|on|near|by)$/i.test(x.w) || x.q);
  if (!ws.length) return null;
  const spec = { raw: ws.map((x) => x.w).join(" "), plural: false, nearest: false, id: null, category: null, words: [] };
  for (const x of ws) {
    let w = x.w;
    if (x.q) { spec.words.push(w); continue; }
    const lw = w.toLowerCase();
    if (/^(all|every|each|both)$/.test(lw)) { spec.plural = true; continue; }
    if (/^(nearest|closest|next|nearby|close)$/.test(lw)) { spec.nearest = true; continue; }
    const idm = /^([a-z_][\w-]*)?#(\w+)$/i.exec(w);
    if (idm) { if (idm[1]) spec.words.push(idm[1]); spec.id = idm[2]; continue; }
    if (/^\d+$/.test(w) && spec.words.length) { spec.id = w; spec.idFromWord = true; continue; }   // "wolf 5" (or a name like "Red 1": retried below)
    if (CATEGORY[lw] && !spec.words.length) { spec.category = CATEGORY[lw]; if (/s$/.test(lw) && lw !== "boss") spec.plural = true; continue; }
    if (CATEGORY[lw]) { spec.category = spec.category || CATEGORY[lw]; continue; }
    spec.words.push(w);
  }
  if (spec.words.length === 1 && singular(spec.words[0]) !== spec.words[0].toLowerCase()) spec.pluralWord = true;
  if (!spec.words.length && !spec.category && spec.id == null) spec.category = "any";
  return spec;
}

function parsePoint(words) {
  const s = words.map((x) => x.w).join(" ").replace(/[()[\]]/g, " ").trim();
  let m = /^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/.exec(s);
  if (m) return [+m[1], +m[2]];
  m = /^x\s*=?\s*(-?\d+(?:\.\d+)?)\s*,?\s*y\s*=?\s*(-?\d+(?:\.\d+)?)$/i.exec(s);
  if (m) return [+m[1], +m[2]];
  return null;
}

function parseOne(text, ctx) {
  let s = text.trim();
  for (let i = 0; i < 4 && FILLER.test(s); i++) s = s.replace(FILLER, "");
  const low = s.toLowerCase();
  let verb = null, restText = s;
  for (const [v, canon] of VERBS) {
    if (low === v || low.startsWith(v + " ")) { verb = canon; restText = s.slice(v.length).trim(); break; }
  }
  const words0 = tokenize(restText);
  const first = (low.split(/\s+/)[0] || "");
  // bare compass word ("north 3") → go
  if (!verb && parseDir(first)) { verb = "go"; restText = s; }
  // bare control / combo name ("attack" is a verb; "interact"…): press it
  if (!verb && ctx.named && ctx.named[first]) { verb = "press"; restText = s; }
  if (!verb && ctx.combos && ctx.combos[first]) { verb = "combo"; restText = s; }
  if (!verb) {
    const sug = suggestVerb(first);
    throw new OrderError(`"${text}": unknown order "${first}"${sug ? ` — did you mean "${sug}"?` : ""}`, ORDER_CARD);
  }
  const words = tokenize(restText);
  // fight/movement modifiers (block, retreat 30%, kite 4, careful ...) only for orders where they mean something;
  // "set retreat 30" and "press block" keep their words. "for N s" works everywhere.
  const MODS = new Set(["goto", "go", "run", "explore", "fight", "flee", "follow", "talk", "pickup", "interact", "stomp", "waitfor", "wait"]);
  let mods = {}, rest = words;
  if (MODS.has(verb)) ({ mods, rest } = takeModifiers(words));
  else if (!["set", "call"].includes(verb)) {
    const i = words.findIndex((x, j) => /^for$/i.test(x.w) && words[j + 1] && parseSeconds(words[j + 1].w.replace(/s$/, "")) != null);
    if (i >= 0) { mods.forS = parseSeconds(words[i + 1].w.replace(/s$/, "")); rest = words.filter((_, j) => j !== i && j !== i + 1 && !(j === i + 2 && /^(s|sec|secs|seconds?)$/i.test(words[j].w))); }
  }
  const o = { verb, text, ...mods };
  const restStr = rest.map((x) => x.w).join(" ").trim();
  const lowRest = restStr.toLowerCase();

  switch (verb) {
    case "goto": {
      const pt = parsePoint(rest);
      if (pt) { o.point = pt; break; }
      if (/^(goal|objective|the goal|quest)$/.test(lowRest)) { o.goal = true; break; }
      const d = parseDir(rest[0]?.w);
      if (d && (rest.length === 1 || (rest.length === 2 && NUM.test(rest[1].w)))) { o.verb = "go"; o.dir = d; o.n = rest[1] ? +rest[1].w : null; break; }
      o.target = parseTarget(rest);
      if (!o.target) throw new OrderError(`"${text}": go where? e.g. "goto Gate", "goto 12,5", "go north 4"`);
      break;
    }
    case "go": case "run": {
      // "go north 5", "move east", "go forward 3", "run right", "run to 40" (platformer), "go to X" handled above
      const ws = rest.filter((x) => !/^(cells?|tiles?|steps?|meters?|metres?|m|units?|blocks?|squares?)$/i.test(x.w));
      const d = parseDir(ws[0]?.w);
      if (d) {
        o.dir = d; o.verb = verb === "run" ? "run" : "go";
        const n = ws.slice(1).find((x) => NUM.test(x.w));
        if (n) o.n = +n.w;
        const toIdx = ws.findIndex((x) => /^(to|until)$/i.test(x.w));
        if (toIdx >= 0 && NUM.test(ws[toIdx + 1]?.w || "")) { o.toX = +ws[toIdx + 1].w; o.n = null; }
        break;
      }
      const pt = parsePoint(ws);
      if (pt) { o.verb = "goto"; o.point = pt; break; }
      if (!ws.length) { if (verb === "run") throw new OrderError(`"${text}": run which way? e.g. "run right", "run left to 40"`); throw new OrderError(`"${text}": go where? e.g. "go north 4", "goto Gate"`); }
      o.verb = "goto"; o.target = parseTarget(ws);
      break;
    }
    case "explore": o.dir = parseDir(rest[0]?.w) || null; break;
    case "fight": {
      if (/^(stomp|jump on)$/.test(lowRest)) { o.mode = "stomp"; break; }
      o.target = rest.length ? parseTarget(rest) : null;
      if (o.target && o.target.pluralWord) o.target.plural = true;
      if (/^shoot$/i.test(text.split(/\s+/)[0])) o.mode = o.mode || "ranged";
      break;
    }
    case "flee": { const i = rest.findIndex((x) => /^from$/i.test(x.w)); o.from = i >= 0 ? parseTarget(rest.slice(i + 1)) : null; break; }
    case "talk": o.target = rest.length ? parseTarget(rest) : { raw: "", words: [], category: "npc", plural: false, nearest: true, id: null }; break;
    case "interact": o.target = rest.length ? parseTarget(rest) : null; break;
    case "choose": {
      if (rest.some((x) => !x.q)) rest = rest.filter((x) => x.q || !/^(the|option|number|choice|answer|#|no\.?)$/i.test(x.w));
      const w = (rest[0]?.w || "").toLowerCase().replace(/[).:]$/, "").replace(/^#/, "");
      if (/^\d+$/.test(w) && rest.length === 1) o.option = +w;
      else if (ORDINAL[w] && rest.length <= 2) o.option = ORDINAL[w];
      else if (w === "last") o.option = -1;
      else if (restStr) o.optionText = restStr.replace(/^["']|["']$/g, "");
      else throw new OrderError(`"${text}": choose which option? e.g. "choose 1" or "choose 'get it back'"`);
      break;
    }
    case "pickup": o.target = rest.length ? parseTarget(rest) : { raw: "", words: [], category: "item", plural: false, nearest: true, id: null }; if (o.target && o.target.pluralWord) o.target.plural = true; break;
    case "use": {
      const word = lowRest || (text.split(/\s+/)[0].toLowerCase() === "heal" ? "heal" : "");
      if (HEAL_WORDS.test(word) || /^(drink|quaff|eat|heal)$/.test(text.split(/\s+/)[0].toLowerCase())) { o.control = "heal"; break; }
      if (ctx.named && ctx.named[word]) { o.control = word; break; }
      if (!word) throw new OrderError(`"${text}": use what? e.g. "use potion", "use interact"`);
      o.verb = "interact"; o.target = parseTarget(rest);
      break;
    }
    case "press": case "hold": {
      if (!rest.length) throw new OrderError(`"${text}": ${verb} which key? e.g. "${verb} e"${verb === "hold" ? " 1.5" : ""}`);
      o.control = rest[0].w.toLowerCase();
      let times = 1, secs = null;
      for (const x of rest.slice(1)) {
        const lw = x.w.toLowerCase();
        const tm = /^x(\d+)$/.exec(lw) || /^(\d+)x$/.exec(lw);
        if (tm) times = +tm[1];
        else if (lw === "twice") times = 2; else if (lw === "thrice") times = 3;
        else if (parseSeconds(lw) != null) { if (verb === "hold") secs = parseSeconds(lw); else times = Math.round(parseSeconds(lw)); }
      }
      if (rest.some((x) => /^times?$/i.test(x.w))) { const n = rest.find((x) => NUM.test(x.w)); if (n) times = +n.w; }
      o.times = Math.min(20, Math.max(1, times));
      if (verb === "hold") o.seconds = secs ?? mods.forS ?? 1;
      break;
    }
    case "wait": { const n = rest.find((x) => parseSeconds(x.w) != null); o.seconds = n ? parseSeconds(n.w) : mods.forS ?? 1; if (!n && mods.forS == null) o.untimed = true; break; }
    case "waitfor": o.target = parseTarget(rest); if (!o.target) throw new OrderError(`"${text}": wait for what? e.g. "wait for Koopa"`); break;
    case "follow": o.target = parseTarget(rest); if (!o.target) throw new OrderError(`"${text}": follow whom?`); break;
    case "stop": break;
    case "set": {
      const k = (rest[0]?.w || "").toLowerCase(), v = (rest[1]?.w || "").toLowerCase().replace(/%$/, "");
      if (!k) throw new OrderError(`"${text}": set what? e.g. "set retreat 30", "set heal 40", "set guard off", "set reaction 0.3"`);
      o.key = k; o.value = v === "on" || v === "true" || v === "yes" ? true : v === "off" || v === "false" || v === "no" ? false : NUM.test(v) ? +v : v;
      break;
    }
    case "call": o.name = rest[0]?.w; o.args = rest.slice(1).map((x) => (NUM.test(x.w) ? +x.w : x.w)); if (!o.name) throw new OrderError(`"${text}": call which command?`); break;
    case "combo": o.name = (rest[0]?.w || text.split(/\s+/)[0]).toLowerCase(); break;
    case "jump": {
      o.dir = null; o.size = "medium";
      for (const x of rest) {
        const lw = x.w.toLowerCase(), d = parseDir(lw);
        if (d === "E" || d === "W") o.dir = d; else if (d === "N") o.size = "high";
        else if (SIZE_WORDS[lw]) o.size = SIZE_WORDS[lw];
        else if (/^\d+$/.test(lw)) o.frames = +lw;
        else if (/^(over|across|onto|on|to)$/.test(lw)) continue;
        else if (lw === "in" || lw === "place") continue;
      }
      break;
    }
    case "stomp": o.target = rest.length ? parseTarget(rest) : { raw: "", words: [], category: "hostile", plural: false, nearest: true, id: null }; break;
    case "look": {
      const d = parseDir(rest[0]?.w);
      if (d) { o.dir = d; break; }
      if (/^(up|down)$/.test(lowRest)) { o.pitch = lowRest; break; }
      o.target = parseTarget(rest); if (!o.target) throw new OrderError(`"${text}": look where? e.g. "look north", "look at Red#6"`);
      break;
    }
    case "reload": break;
    case "weapon": { const w = rest[0]?.w; if (!w) throw new OrderError(`"${text}": which weapon? e.g. "weapon 2"`); o.weapon = NUM.test(w) ? +w : w.toLowerCase(); break; }
    case "block": { const n = rest.find((x) => parseSeconds(x.w) != null); o.seconds = n ? parseSeconds(n.w) : 0.8; break; }
    case "dodge": o.dir = parseDir(rest[0]?.w) || null; break;
    case "respawn": break;
    default: break;
  }
  return o;
}

/** Parse an order chain. Throws OrderError with a helpful message on the first bad part. */
export function parseOrders(text, ctx = {}) {
  const parts = splitChain(text);
  if (!parts.length) throw new OrderError("no order given", ORDER_CARD);
  return parts.map((p) => parseOne(p, ctx));
}

// ------------------------------------------------------------------ resolving things against the world

const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Candidates that match a target spec, best match level first. */
function matchLevel(th, words) {
  if (!words.length) return 1;
  const q = normName(words.join(" ")), qs = normName(words.map(singular).join(" "));
  const names = [normName(th.type), th.name ? normName(th.name) : null].filter(Boolean);
  if (names.includes(q)) return 6;
  if (names.includes(qs)) return 5;
  if (names.some((n) => n.startsWith(qs) || n.startsWith(q))) return 4;
  if (names.some((n) => n.includes(qs) || (qs.length >= 4 && qs.includes(n)))) return 3;
  if (qs.length >= 4 && names.some((n) => editDistance(n, qs) <= 2 || (n.length > qs.length && editDistance(n.slice(0, qs.length), qs) <= 1))) return 2;
  return 0;
}

const relOk = (th, cat) => !cat || cat === "any" || th.rel === cat || (cat === "npc" && th.rel === "friend");

/**
 * Resolve a target spec to things. Returns {things: [...] (nearest first), remembered: bool} or throws OrderError.
 * `prefer` biases to a relation ("hostile" for fight, "npc" for talk, "item" for pickup) when several match.
 */
export function resolveTarget(spec, world, opts = {}) {
  if (!spec) throw new OrderError("no target");
  try { return resolveTarget1(spec, world, opts); }
  catch (e) {
    // "Red 1" is a name, not "Red" with id 1: retry with the number as part of the name
    if (spec.idFromWord) return resolveTarget1({ ...spec, words: [...spec.words, String(spec.id)], id: null, idFromWord: false }, world, opts);
    throw e;
  }
}
function resolveTarget1(spec, world, { prefer = null, allowRemembered = true, includeDead = false } = {}) {
  const pools = [world.things.filter((t) => includeDead || !t.dead), allowRemembered ? world.remembered || [] : []];
  for (let pi = 0; pi < pools.length; pi++) {
    const pool = pools[pi];
    let cands = pool;
    if (spec.id != null) cands = cands.filter((t) => String(t.id) === String(spec.id));
    if (spec.category) cands = cands.filter((t) => relOk(t, spec.category));
    let best = 0, scored = [];
    for (const t of cands) { const m = matchLevel(t, spec.words); if (m > 0) scored.push([m, t]); if (m > best) best = m; }
    let hits = scored.filter(([m]) => m === best).map(([, t]) => t);
    if (prefer && hits.some((t) => t.rel === prefer)) hits = hits.filter((t) => t.rel === prefer);
    if (hits.length) return { things: hits.sort((a, b) => a.dist - b.dist), remembered: pi === 1 };
  }
  const inView = world.things.filter((t) => !t.dead).slice(0, 8).map(thingLabel).join(", ") || "nothing";
  const what = spec.raw || spec.category || "that";
  const cat = spec.category && spec.category !== "any" && !spec.words.length ? ` (no ${spec.category === "hostile" ? "enemies" : spec.category === "friend" ? "teammates" : spec.category + "s"} around)` : "";
  throw new OrderError(`no "${what}" here${cat} — in view: ${inView}`, "name things exactly as the observation lists them (Wolf, Wolf#5, Guard), or explore to find more");
}
