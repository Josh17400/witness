// Witness play: is a game's snapshot playtest-ready? `witness play check` (and `play suggest`) read one snapshot and
// list which of the snapshot conventions (docs/PLAYTEST.md, "Playtest-ready snapshots") it has, and what each missing
// one would unlock. Pure: `checkSnapshot(state, profile)` works on any snapshot state.
import { openGame } from "../core/launch.js";
import { begin, stepTo } from "../core/runner.js";
import { rawPos, normChoices } from "./perceive.js";
import { resolvePlayConfig } from "./config.js";

const DOORS = /^(door|doorway|entrance|entry|stairs?|staircase|stairway|ladder|portal|exit|trapdoor|hatch|gate)$/i;
const OBJECTIVE = /(objective|quest|target|marker|goal)/i;

function playerOf(state) {
  if (state && state.player && typeof state.player === "object") return state.player;
  const ents = state && Array.isArray(state.entities) ? state.entities : [];
  return ents.find((e) => /^(player|hero|you|avatar)$/i.test(String(e.type ?? e.kind ?? ""))) || null;
}

/**
 * The checklist for one snapshot state. Returns [{key, label, ok, unlocks, hint, seen?}] where ok is true (present),
 * false (missing) or null (can't tell from this moment, e.g. no enemy is winding up right now).
 */
export function checkSnapshot(state, profile = "topdown") {
  state = state || {};
  if (profile === "turn") return checkTurn(state);
  if (profile === "defense") return checkDefense(state);
  const P = playerOf(state), pos = P ? rawPos(P) : null;
  const ents = (Array.isArray(state.entities) ? state.entities : []).filter((e) => e && typeof e === "object" && e !== P);
  const has = (f) => ents.some((e) => f in e);
  const types = [...new Set(ents.map((e) => String(e.type ?? e.kind ?? "")))];
  const map = state.map && Array.isArray(state.map.rows) ? state.map : null;
  const out = [];
  const add = (key, label, ok, unlocks, hint, seen) => out.push({ key, label, ok, unlocks, hint, ...(seen ? { seen } : {}) });

  add("player", "player with pos and hp", !!(P && pos) && (P.hp ?? P.health) != null, "everything; hp drives heal, retreat and low-hp wakes",
    !P ? "state.player = {pos, hp, maxHp, facing} (or an entity typed Player)" : !pos ? "the player has no pos" : "the player has no hp");
  add("entities", "entities with id and type", ents.length > 0 && ents.every((e) => e.id != null && (e.type ?? e.kind) != null), "targets, the near list, kills and pickups",
    ents.length ? "every entity needs a stable id and a readable type" : "state.entities = [{id, type, pos}]", ents.length ? `${ents.length}: ${types.slice(0, 8).join(", ")}` : null);
  add("map", "a walkability map (state.map, a window or the whole level)", !!map, "exact navigation, coverage %; without it walls are learned by bumping into them",
    "state.map = {cell, origin, rows: [\"#..#\"], solid: \"#\"} (a window that follows the player is fine)", map ? `${map.rows.length}×${(map.rows[0] || "").length}${map.id != null ? `, id ${map.id}` : ""}` : null);
  // one world frame: the player stands inside the map, and things aren't all in screen pixels around the player
  let global = null;
  if (pos && map) {
    const cell = +(map.cell || 1), o = (map.origin || [0, 0]).map(Number);
    const c = Math.floor((pos[0] - o[0]) / cell), r = Math.floor((pos[1] - o[1]) / cell);
    global = r >= 0 && r < map.rows.length && c >= 0 && c < (map.rows[0] || "").length;
  }
  add("global", "positions in one world frame (the map's origin + rows contain the player)", global, "paths, distances and remembered things stay right as you move",
    global === false ? "the player's pos isn't inside state.map: use the same (global) coordinates for the player, the entities and map.origin" : "add state.map to check this");
  add("flags", "entity hostile / talk / item flags", ents.length ? has("hostile") || has("talk") || has("npc") || has("item") : null, "exact classification (else guessed from type names: Wolf → enemy, Guard → npc)",
    "hostile: true on enemies, talk: true on people, item: true on pickups");
  add("doors", "doors, exits and stairs as things (and `avoid`)", ents.length || map ? ents.some((e) => e.avoid != null || e.door || DOORS.test(String(e.type ?? e.kind ?? ""))) || !!(map && map.rows.some((row) => /\+/.test(row)) || (map && (map.door || map.avoid))) : null,
    "goto Exit / goto Inn; paths keep off doors unless they're the goal; entering one finishes the goto; a door used by pushing a way (stand on the Exit, push south) needs enter", "list them as entities (type Door / Exit / Stairs, leadsTo: \"Inn\", enter: \"s\" when you push into it to use it), or mark door cells with + in map rows");
  add("objectives", "quest objectives as things", ents.length ? ents.some((e) => e.objective || e.quest || e.questTarget || OBJECTIVE.test(String(e.type ?? e.kind ?? ""))) : null,
    "the tester can goto / fight / talk to what the quest asks for", "mark the entities a quest needs (objective: true, or quest: \"<title>\"), or list a marker thing at the spot");
  const g = state.goal ?? state.objective ?? state.quest;
  add("goal", "a goal with a position", g == null ? false : typeof g === "object" && !!rawPos(g), "the goal line, and goto goal", g == null ? "state.goal = {text, pos}" : "state.goal has text but no pos: add pos so `goto goal` works");
  if (profile !== "fps") add("facing", "player facing", P ? (P.facing ?? P.dir ?? P.direction) != null : false, "attacks land the first time and talking faces the right way", "player.facing = \"N\" | \"E\" | … (or +1/-1 in a platformer)");
  const tele = ents.some((e) => (typeof e.telegraph === "number" && e.telegraph > 0) || e.telegraph === true || /windup|wind_up|telegraph|charg|aiming|prepar/i.test(String(e.state || "")));
  add("telegraph", "telegraph states on attacking enemies", tele ? true : has("telegraph") ? true : null, "blocking and dodging at human speed, windup stats in the report",
    "state: \"windup\" or telegraph: <seconds left> while an enemy winds up (not seen in this snapshot: nobody is attacking now?)");
  add("dialogue", "a dialogue with speaker and options", "dialogue" in state || "dialog" in state ? (state.dialogue && typeof state.dialogue === "object" ? state.dialogue.speaker != null && Array.isArray(state.dialogue.options ?? state.dialogue.choices) : true) : false,
    "talk / choose, and talk checks the right person answered", "state.dialogue = {speaker, text, options[]} while one is open (null when closed)");
  add("outcome", "won / dead", "won" in state || "dead" in state || "gameOver" in state || "victory" in state, "the outcome, goal and death wakes", "state.won / state.dead");
  if (profile === "platformer") {
    add("onGround", "player onGround and size", P ? (P.onGround ?? P.grounded ?? P.on_ground) != null && (Array.isArray(P.size) || P.w != null) : false, "jump planning and exact landings", "player.onGround, player.size = [w, h] (and entity size)");
  }
  if (profile === "fps") {
    add("look", "player look or yaw/pitch, and ammo", P ? (Array.isArray(P.look) || P.yaw != null) && P.ammo != null : false, "aiming, reloading", "player.look = [x, y, z] (or yaw/pitch), player.ammo");
    add("los", "entity line of sight", ents.length ? has("los") || has("visible") : null, "shooting only what's in sight", "entity los: true/false");
  }
  return out;
}

/** The defense profile's checklist: the base (hp, a position to measure from), enemies flagged hostile, screen positions, outcome. */
function checkDefense(state) {
  const P = playerOf(state), pos = P ? rawPos(P) : null;
  const ents = (Array.isArray(state.entities) ? state.entities : []).filter((e) => e && typeof e === "object" && e !== P);
  const out = [], add = (key, label, ok, unlocks, hint, seen) => out.push({ key, label, ok, unlocks, hint, ...(seen ? { seen } : {}) });
  add("base", "the base as state.player with pos and hp", !!(P && pos) && (P.hp ?? P.health) != null, "distances from the base, arrival times, low-hp wakes, the base hp in the header",
    !P ? "state.player = {pos, hp, maxHp} (the base, tower or fort you defend)" : !pos ? "the base has no pos" : "the base has no hp");
  add("entities", "entities with id, type and pos", ents.length ? ents.every((e) => e.id != null && (e.type ?? e.kind) != null && rawPos(e)) : null, "the enemy list, targets, kills",
    "state.entities = [{id, type, pos, hp}] (none listed right now: between waves?)", ents.length ? `${ents.length}: ${[...new Set(ents.map((e) => String(e.type ?? e.kind ?? "")))].slice(0, 8).join(", ")}` : null);
  add("flags", "entity hostile / item flags", ents.length ? ents.some((e) => "hostile" in e || "enemy" in e) : null, "exact classification (else guessed from type names)", "hostile: true on enemies, item: true on pickups");
  const cam = state.camera && typeof state.camera === "object";
  add("screen", "screen positions (for attack \"tap:target\")", ents.some((e) => e.screen || e.screenPos) || cam ? true : null, "tapping or clicking an enemy where it is drawn",
    "entity screen: [x, y] in the game's pixels, or state.camera = {pos: [x, y], zoom} (only needed with attack \"tap:target\" / \"click:target\")");
  add("outcome", "won / dead (the base fell)", "won" in state || "dead" in state || "gameOver" in state || "victory" in state, "the outcome and the end-of-run wake", "state.dead when the base falls, state.won");
  add("dialogue", "choices as a dialogue (upgrades between waves, perks)", "dialogue" in state || "dialog" in state ? true : null, "choose <n> for the game's own picks", "state.dialogue = {speaker, text, options[]} while one is open");
  return out;
}

/** Does this snapshot look like a turn-based / card / menu game (choices or whose turn, no player position)? */
export function looksTurnBased(state) {
  if (!state || typeof state !== "object") return false;
  const P = playerOf(state);
  if (P && rawPos(P)) return false;
  return !!(normChoices(state.choices ?? state.tappables) || ["yourTurn", "your_turn", "myTurn", "isYourTurn"].some((k) => k in state));
}

/** The turn profile's checklist: choices with labels and legality, whose turn, score, phase, hand, outcome. */
function checkTurn(state) {
  const out = [];
  const add = (key, label, ok, unlocks, hint, seen) => out.push({ key, label, ok, unlocks, hint, ...(seen ? { seen } : {}) });
  const raw = state.choices ?? state.tappables ?? state.moves ?? state.legalMoves ?? state.actions;
  const ch = normChoices(raw);
  const objs = Array.isArray(raw) && raw.some((c) => c && typeof c === "object");
  add("choices", "choices (cards, buttons, moves) with label and id", ch ? (objs ? raw.every((c) => !c || typeof c !== "object" || ((c.label ?? c.text ?? c.name) != null && (c.id ?? c.value) != null)) : true) : false,
    "pick <n|words>, and the choices list in every observation", ch ? "every choice needs a label and a stable id: [{label: \"Play J♠\", id: \"JS\"}] (plain strings work too)" : "state.choices = [{label, id}] (or plain strings): what the player can click or play right now",
    ch ? `${ch.length}: ${ch.slice(0, 5).map((c) => c.label).join(", ")}${ch.length > 5 ? ", …" : ""}` : null);
  add("legal", "legal moves marked", ch ? (objs && raw.some((c) => c && typeof c === "object" && ("legal" in c || "enabled" in c || "disabled" in c)) ? true : null) : null,
    "the tester sees which moves the game allows (and a bug hunter can try the others)", "list only legal moves, or mark them: legal: false / disabled: true (can't tell from this snapshot)");
  const turnKey = ["yourTurn", "your_turn", "myTurn", "isYourTurn", "playerTurn"].find((k) => k in state);
  add("turn", "whose turn (state.yourTurn)", turnKey ? true : false, "wait wakes the moment it's your turn; the header says YOUR TURN", "state.yourTurn = true while the player has to act");
  const score = ["score", "scores", "points"].find((k) => state[k] != null);
  add("score", "score", score ? true : null, "the header shows it, and score changes are events", "state.score (a number, or {us: 3, them: 5}) (not seen: no score on this screen?)", score ? JSON.stringify(state[score]).slice(0, 40) : null);
  add("phase", "scene or phase", state.scene != null || state.phase != null ? true : false, "scene changes and phases in the observation and the report", "state.scene = \"home\" / \"table\", state.phase = \"bidding\"");
  add("hand", "the player's hand or resources", Array.isArray(state.hand) || state.hand != null ? true : null, "the tester knows what it holds (card games)", "state.hand = [\"J♠\", \"A♥\"] (not seen: not a card game, or not dealt yet)");
  add("dialogue", "a dialogue with speaker and options", "dialogue" in state || "dialog" in state ? true : null, "choose, and wait wakes when one opens", "state.dialogue = {speaker, text, options[]} while one is open (null when closed)");
  add("outcome", "won / game over", "won" in state || "dead" in state || "gameOver" in state || "victory" in state || "winner" in state ? true : false, "the outcome in the report, and a win wakes the tester", "state.won / state.gameOver (or state.winner)");
  return out;
}

/** The checklist as text lines. */
export function checkLines(items) {
  const L = [];
  for (const it of items) {
    const mark = it.ok === true ? "✔" : it.ok === false ? "✖" : "?";
    L.push(`  ${mark} ${it.label}${it.seen ? ` (${it.seen})` : ""} — ${it.ok === true ? `→ ${it.unlocks}` : `${it.hint} → ${it.unlocks}`}`);
  }
  const miss = items.filter((it) => it.ok === false).length, unk = items.filter((it) => it.ok == null).length;
  L.push(miss ? `${miss} missing${unk ? `, ${unk} not visible in this snapshot` : ""}: see docs/PLAYTEST.md "Playtest-ready snapshots"` : `playtest-ready${unk ? ` (${unk} not visible in this snapshot; check them in a fight or a dialogue: --scene / --params)` : ""}`);
  return L;
}

/** `witness play check [--seed N] [--scene S] [--params JSON] [--at S] [--json]`: one snapshot from a fresh reset. */
export async function playCheck(opt, { loadConfig }) {
  const { cfg, root } = loadConfig(opt);
  const seed = opt.seed !== undefined && opt.seed !== true ? +opt.seed : cfg.seed ?? 1;
  const scene = opt.scene && opt.scene !== true ? String(opt.scene) : undefined;
  let params; if (opt.params && opt.params !== true) params = JSON.parse(String(opt.params));
  const profile = resolvePlayConfig(cfg.play || {}, {}).profile;
  const g = await openGame(cfg, root, { quiet: true });
  try {
    const S = g.session, fps = S.fps;
    const st = await begin(S, { seed, scene, params });
    // like a playtest start: step until something is in view (up to 1/3 s), or to --at
    const atF = opt.at && opt.at !== true ? Math.round(+opt.at * fps) : null;
    let state = {};
    for (let f = 1; f <= (atF ?? Math.max(1, Math.round(fps / 3))); f++) {
      await stepTo(S, st, f);
      if (atF != null && f < atF) continue;
      state = (await S.snapshot()).state || {};
      if (atF == null && playerOf(state) && Array.isArray(state.entities) && state.entities.length > 1) break;
      if (atF == null && profile === "turn" && normChoices(state.choices ?? state.tappables)) break;
    }
    const items = checkSnapshot(state, profile);
    // an unconfigured game that reads as turn-based: say so (its action checklist would be all misses)
    if (!opt.json && profile !== "turn" && !(cfg.play && cfg.play.profile) && looksTurnBased(state)) console.log('this looks like a turn-based / card / menu game: set "play": {"profile": "turn"} in witness.json (or run witness play suggest)');
    if (opt.json) { console.log(JSON.stringify({ command: "play check", profile, items }, null, 1)); return; }
    console.log(`Playtest-ready check for ${S.hello.name || cfg.name} (${profile}, seed ${seed}${scene ? `, scene ${scene}` : ""}):`);
    for (const l of checkLines(items)) console.log(l);
  } finally { await g.stop(); }
}
