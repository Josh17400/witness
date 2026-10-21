// Witness play: snapshot → world model. Reads the snapshot conventions (docs/PLAYTEST.md) with per-game overrides
// from the play config, classifies things (hostile / npc / item / friend), and remembers things out of view.
import { compileExpr, scopeFor, withVars, compass, dist2, sub } from "./util.js";

const TELEGRAPH_STATES = /^(windup|wind_up|wind-up|telegraph|telegraphing|charging|charge|prepare|preparing|aiming|attack_windup|attackwindup|startup|anticipation)$/i;
const HOSTILE_NAMES = /(enemy|monster|wolf|bandit|skeleton|zombie|goblin|orc|slime|bat|rat|spider|boss|troll|demon|draugr|ghoul|bear|boar|goomba|koopa|piranha|bowser|hammer|bullet|fire ?bar|spiny|lakitu|beetle|cultist|raider|hostile)/i;
const ITEM_NAMES = /(coin|gem|potion|key|item|pickup|heart|ammo|loot|gold|mushroom|flower|star|1up|oneup|medkit|health|chest|crystal|shard)/i;
const NPC_NAMES = /(npc|guard|villager|merchant|shopkeeper|king|queen|innkeeper|elder|farmer|smith|priest|jarl|trader|citizen|princess)/i;

const AVOID_TYPES = /^(door|doorway|entrance|entry|stairs?|staircase|stairway|ladder|portal|exit|trapdoor|hatch)$/i;

const num = (v) => (v == null || v === "" || !Number.isFinite(+v) ? null : +v);

/** Position of a thing: array, {x,y,z}, or x/y fields. */
export function rawPos(e) {
  if (!e || typeof e !== "object") return null;
  if (Array.isArray(e.pos)) return e.pos.map(Number);
  if (Array.isArray(e.position)) return e.position.map(Number);
  const p = e.pos && typeof e.pos === "object" ? e.pos : e.position && typeof e.position === "object" ? e.position : e;
  if (p && num(p.x) != null && num(p.y) != null) return p.z != null ? [+p.x, +p.y, +p.z] : [+p.x, +p.y];
  return null;
}

function normDialogue(d) {
  if (!d) return null;
  if (typeof d === "string") return { speaker: null, text: d, options: [], selected: null };
  if (typeof d !== "object" || d.open === false || d.active === false || d.visible === false) return null;
  const opts = d.options ?? d.choices ?? d.answers ?? [];
  return {
    speaker: d.speaker ?? d.name ?? d.who ?? null,
    text: d.text ?? d.line ?? d.message ?? d.body ?? "",
    options: (Array.isArray(opts) ? opts : []).map((o) => (typeof o === "string" ? o : o && (o.text ?? o.label ?? o.title) != null ? String(o.text ?? o.label ?? o.title) : JSON.stringify(o))),
    selected: num(d.selected ?? d.cursor ?? d.index ?? d.choice),
  };
}

function normFacing(f) {
  if (f == null) return null;
  if (typeof f === "string") {
    const s = f.toLowerCase();
    const m = { n: "N", north: "N", up: "N", s: "S", south: "S", down: "S", e: "E", east: "E", right: "E", w: "W", west: "W", left: "W",
      ne: "NE", nw: "NW", se: "SE", sw: "SW" }[s];
    return m || null;
  }
  if (typeof f === "number") return f > 0 ? "E" : f < 0 ? "W" : null;   // platformers often expose +1/-1
  return null;
}

const STAT_SKIP = /^(id|type|kind|name|pos|position|x|y|z|vx|vy|vz|vel|velocity|size|w|h|width|height|hp|health|maxhp|hpmax|max_hp|maxhealth|healthmax|facing|dir|direction|yaw|pitch|look|forward|state|ongroud|onground|grounded|on_ground|frame|time|t|digest|seed|team|hostile|item|talk|npc|dead|won|attacking|blocking|dodging|invulnerable|star|cooldown|telegraph|lean|magsize|mag_size|maxammo|ads|reloading|sprinting|crouching|god|paused)$/i;

// turn profile: snapshot fields that aren't game facts for the header (shown elsewhere, or engine plumbing)
const FIELD_SKIP = /^(choices|tappables|moves|legalMoves|actions|yourTurn|your_turn|myTurn|isYourTurn|playerTurn|dialogue|dialog|conversation|notice|message|toast|hint|ui|layers|entities|map|digest|frame|frames|time|t|seed|player|scene|won|dead|gameOver|game_over|victory|menu|goal|objective|quest|camera|pointer|touches|debug|fps|dt)$/i;
const FIELD_FIRST = [/^scores?$/i, /^(phase|stage|state|step)$/i, /^(turn|whoseTurn|current|currentPlayer|active)$/i, /^round$/i, /^trump/i, /^hand$/i, /^trick$/i, /^(bid|contract)/i, /^(dealer|leader)$/i, /^(lives|money|coins|gold|chips)$/i];

/**
 * The game's choices as [{n, label, id, key, rect, legal, selected, raw}]: {label, id} objects or plain strings
 * (state.choices; also {text|name|title}, {value}, legal/enabled/disabled, selected). Duplicate labels get " #2".
 */
export function normChoices(v) {
  if (!Array.isArray(v) || !v.length) return null;
  const out = [], seen = new Map();
  v.forEach((c, i) => {
    if (c == null) return;
    const o = typeof c === "object" ? c : null;
    let label = o ? o.label ?? o.text ?? o.name ?? o.title ?? o.id ?? o.value : c;
    label = String(label ?? `#${i + 1}`).replace(/\s+/g, " ").trim().slice(0, 80) || `#${i + 1}`;
    const k = label.toLowerCase(), dup = (seen.get(k) || 0) + 1; seen.set(k, dup);
    if (dup > 1) label = `${label} #${dup}`;
    const rect = o && Array.isArray(o.rect) && o.rect.length >= 2 ? o.rect.map(Number) : o && Array.isArray(o.pos) ? o.pos.map(Number) : o && Array.isArray(o.click) ? o.click.map(Number) : null;
    out.push({
      n: out.length + 1, label, id: o ? o.id ?? o.value ?? o.label ?? o.text ?? i : c, key: o && o.key != null ? String(o.key) : null, rect,
      legal: !(o && (o.legal === false || o.enabled === false || o.disabled === true || o.allowed === false)),
      selected: !!(o && (o.selected === true || o.active === true || o.checked === true)), raw: c,
    });
  });
  return out.length ? out : null;
}

export class Perceiver {
  constructor(cfg, { fps = 60 } = {}) {
    this.cfg = cfg;
    this.fps = fps;
    const c = (x) => compileExpr(x);
    this.fx = {
      player: c(cfg.player), entities: c(cfg.entities), pos: c(cfg.pos), hostile: c(cfg.hostile), item: c(cfg.item), npc: c(cfg.npc),
      friend: c(cfg.friend), telegraph: c(cfg.telegraph), ignore: c(cfg.ignore), dialogue: c(cfg.dialogue), menu: c(cfg.menu),
      goal: c(cfg.goal), notice: c(cfg.notice), scene: c(cfg.scene), won: c(cfg.won), dead: c(cfg.dead), map: cfg.map ? c(cfg.map) : null,
      ammo: c(cfg.ammo), avoid: c(cfg.avoid), choices: c(cfg.choices), yourTurn: c(cfg.yourTurn),
    };
    this.statFns = null;          // decided on the first snapshot (stable observation lines)
    this.memory = new Map();      // id → {thing, lastSeen, gone}
    this.geo = { cell: cfg.cell, origin: [0, 0], fromMap: false };
    this.mapCache = { key: null, map: null };
    this.sceneMap = { id: null, map: null };   // the map id that names the current scene, and the last map seen in it
    this.prev = null;
  }

  planeOf(pos) {
    if (!pos) return null;
    const [a, b] = this.cfg.plane;
    return [pos[a] ?? 0, pos[b] ?? 0];
  }

  /** Decide the nav cell size once (stable units for the whole session). */
  decideCell(player, things, map) {
    if (this.geo.cell) return;
    if (!map && !(player && player.p2)) return;   // a title screen or intro: decide once there's something to measure
    if (map && map.cell) { this.geo.cell = +map.cell; this.geo.origin = (map.origin || [0, 0]).slice(0, 2).map(Number); this.geo.fromMap = true; return; }
    const sz = player && (Array.isArray(player.size) ? player.size : null);
    if (sz && sz.length && Math.max(...sz) > 0) { this.geo.cell = Math.max(...sz.slice(0, 2)) * 1.25; return; }
    const coords = [player?.p2, ...things.map((t) => t.p2)].filter(Boolean).flat().map(Math.abs);
    const big = coords.length ? Math.max(...coords) : 0;
    this.geo.cell = big > 64 ? 16 : 1;
  }

  perceive(snap, frame) {
    const cfg = this.cfg;
    const S = scopeFor(snap);
    const state = S.state || {};
    const t = frame / this.fps;

    // ---- player
    let pl = this.fx.player ? this.fx.player(S) : state.player;
    const ents = (() => { const v = this.fx.entities ? this.fx.entities(S) : state.entities; return Array.isArray(v) ? v : []; })();
    if (!pl || typeof pl !== "object") pl = ents.find((e) => /^(player|hero|you|avatar)$/i.test(String(e.type ?? e.kind ?? ""))) || null;
    const posFor = (e) => {
      if (this.fx.pos) { const v = this.fx.pos(withVars(S, { e })); if (Array.isArray(v)) return v.map(Number); }
      return rawPos(e);
    };
    let player = null;
    if (pl) {
      const pos = posFor(pl);
      const look = Array.isArray(pl.look) ? pl.look.map(Number) : Array.isArray(pl.forward) ? pl.forward.map(Number) : null;
      player = {
        raw: pl, id: pl.id ?? null, pos, p2: this.planeOf(pos),
        hp: num(pl.hp ?? pl.health ?? pl.HP ?? pl.life), maxHp: num(pl.maxHp ?? pl.hpMax ?? pl.max_hp ?? pl.maxHealth ?? pl.healthMax ?? pl.maxhp ?? pl.max_health),
        facing: normFacing(pl.facing ?? pl.dir ?? pl.direction), onGround: pl.onGround ?? pl.grounded ?? pl.on_ground ?? null,
        vel: Array.isArray(pl.vel) ? pl.vel.map(Number) : Array.isArray(pl.velocity) ? pl.velocity.map(Number) : num(pl.vx) != null ? [+pl.vx, +(pl.vy ?? 0)] : null,
        size: Array.isArray(pl.size) ? pl.size.map(Number) : num(pl.w) != null && num(pl.h) != null ? [+pl.w, +pl.h] : null,
        look, yaw: num(pl.yaw), pitch: num(pl.pitch), team: pl.team ?? null, state: pl.state ?? null,
        ammo: this.fx.ammo ? this.fx.ammo(S) : pl.ammo ?? null, weapon: pl.weapon ?? null,
      };
    }

    // ---- things
    const anyField = (names) => ents.some((e) => e && typeof e === "object" && names.some((n) => n in e));
    const hostileField = anyField(["hostile", "enemy"]), itemField = anyField(["item", "pickup", "collectible"]), npcField = anyField(["talk", "npc", "talkable"]);
    const things = [];
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e || typeof e !== "object") continue;
      if (pl && (e === pl || (e.id != null && e.id === pl.id))) continue;
      const type = String(e.type ?? e.kind ?? e.class ?? e.name ?? "Thing");
      if (/^(player|hero|you|avatar)$/i.test(type) && !player) continue;
      const scope = withVars(S, { e, player: pl });
      if (this.fx.ignore && this.fx.ignore(scope)) continue;
      const pos = posFor(e);
      if (!pos) continue;
      let rel = "neutral";
      const isHostile = this.fx.hostile ? !!this.fx.hostile(scope)
        : player && player.team != null && e.team != null ? e.team !== player.team && e.hostile !== false
          : hostileField ? !!(e.hostile ?? e.enemy) : HOSTILE_NAMES.test(type);
      const isFriend = this.fx.friend ? !!this.fx.friend(scope) : player && player.team != null && e.team != null && e.team === player.team;
      const isItem = this.fx.item ? !!this.fx.item(scope) : itemField ? !!(e.item ?? e.pickup ?? e.collectible) : ITEM_NAMES.test(type);
      const isNpc = this.fx.npc ? !!this.fx.npc(scope) : npcField ? !!(e.talk ?? e.npc ?? e.talkable) : NPC_NAMES.test(type);
      if (isHostile) rel = "hostile"; else if (isFriend) rel = "friend"; else if (isItem) rel = "item"; else if (isNpc) rel = "npc";
      const hp = num(e.hp ?? e.health), dead = !!(e.dead || (hp != null && hp <= 0 && rel === "hostile") || (typeof e.state === "string" && /^(dead|dying|corpse|killed)$/i.test(e.state)));
      let telegraph = false, tele = null;
      if (this.fx.telegraph) { const v = this.fx.telegraph(scope); telegraph = !!v; if (typeof v === "number") tele = v; }
      else if (typeof e.telegraph === "number") { telegraph = e.telegraph > 0; tele = e.telegraph > 0 ? e.telegraph : null; }
      else if (e.telegraph) telegraph = true;
      else if (typeof e.state === "string" && TELEGRAPH_STATES.test(e.state)) telegraph = true;
      if (typeof e.telegraph === "number" && e.telegraph > 0 && tele == null) tele = e.telegraph;
      const id = e.id ?? `${type}@${i}`;
      // places the path should keep off unless they're the goal: doors, stairs, exits (entering a building by accident)
      const avoid = this.fx.avoid ? !!this.fx.avoid(scope) : e.avoid != null ? !!e.avoid : !!(e.door || AVOID_TYPES.test(type));
      things.push({
        raw: e, id, type, name: e.name && String(e.name).toLowerCase() !== type.toLowerCase() ? String(e.name) : null, key: `${type}#${id}`,
        pos, p2: this.planeOf(pos), rel, hp, maxHp: num(e.maxHp ?? e.hpMax ?? e.max_hp ?? e.maxHealth), dead,
        state: typeof e.state === "string" ? e.state : null, telegraph, tele,
        los: e.los ?? e.visible ?? e.inSight ?? e.in_sight ?? null, team: e.team ?? null,
        locked: e.locked ?? null, stompable: e.stompable ?? null, size: Array.isArray(e.size) ? e.size.map(Number) : null,
        avoid, leadsTo: e.leadsTo ?? e.leads_to ?? e.to ?? e.building ?? e.destination ?? null,
        // the push that uses a door/exit: "s", "ne" … or a vector (state coords; 3D: projected onto the ground plane)
        enter: typeof e.enter === "string" && /^(n|s|e|w|ne|nw|se|sw)$/i.test(e.enter.trim()) ? e.enter.trim().toUpperCase()
          : Array.isArray(e.enter) && e.enter.length >= 2 && e.enter.every((x) => Number.isFinite(+x)) ? (e.enter.length > 2 ? this.planeOf(e.enter.map(Number)) : e.enter.slice(0, 2).map(Number)) : null,
      });
    }

    // ---- map (optional): {cell, origin, rows, solid}
    let map = null, mapId = null;
    if (cfg.map !== false) {
      const m = this.fx.map ? this.fx.map(S) : state.map;
      if (m && typeof m === "object" && Array.isArray(m.rows) && m.rows.length) {
        mapId = m.id != null ? String(m.id) : null;   // from the configured map expression, so a config can drop or fix it
        const key = `${m.cell}|${m.origin}|${m.rows.length}|${m.rows[0].length}|${m.rows.join("").length}|${m.rows.join("\n")}`;
        if (this.mapCache.key === key) map = this.mapCache.map;
        else {
          map = { cell: +(m.cell || 1), origin: (m.origin || [0, 0]).map(Number), rows: m.rows.map(String), solid: String(m.solid ?? "#"),
            hazard: String(m.hazard ?? "^~"), oneway: String(m.oneway ?? "="), legend: m.legend || null,
            avoid: String(m.door ?? "+") + String(m.avoid ?? ""),   // doors and cells to keep off unless they're the goal
            window: m.window ?? m.moving ?? m.follows ?? null };
          this.mapCache = { key, map };
        }
      }
    }
    this.decideCell(player, things, map);
    const cell = this.geo.cell || 1;

    // distances / bearings in cells
    for (const th of things) {
      if (player && player.p2) {
        const d = sub(th.p2, player.p2);
        th.dist = dist2(th.p2, player.p2) / cell;
        th.dir = compass(d, cfg.northSign);
        th.dy3 = player.pos && th.pos && th.pos.length > 2 ? (th.pos[1] ?? 0) - (player.pos[1] ?? 0) : null;
      } else { th.dist = Infinity; th.dir = "?"; }
    }
    things.sort((a, b) => a.dist - b.dist || String(a.id).localeCompare(String(b.id)));
    // measured velocity (world units per frame) from the previous snapshot: unit-free, works for any game
    if (this.prev && frame > this.prev.frame) {
      const pf = this.prev.frame, byId = new Map(this.prev.things.map((th) => [th.id, th]));
      for (const th of things) { const o = byId.get(th.id); th.v = o ? [(th.p2[0] - o.p2[0]) / (frame - pf), (th.p2[1] - o.p2[1]) / (frame - pf)] : [0, 0]; }
    } else for (const th of things) th.v = [0, 0];

    // ---- dialogue / menu / goal / notice / scene / outcome
    const pick = (fx, ...cands) => (fx ? fx(S) : cands.find((v) => v != null && v !== ""));
    const dialogue = normDialogue(pick(this.fx.dialogue, state.dialogue, state.dialog, state.conversation));
    const menu = pick(this.fx.menu, state.menu) || null;
    const g = pick(this.fx.goal, state.goal, state.objective, state.quest);
    const goal = g == null ? null : typeof g === "string" ? { text: g, p2: null } : typeof g === "object" ? { text: String(g.text ?? g.title ?? g.name ?? g.description ?? ""), p2: this.planeOf(rawPos(g)) } : { text: String(g), p2: null };
    const notice = pick(this.fx.notice, state.notice, state.message, state.toast, state.hint);
    const sc = pick(this.fx.scene, state.scene, state.level, state.location);
    const scene = sc == null ? null : typeof sc === "object" ? String(sc.name ?? sc.region ?? sc.site ?? JSON.stringify(sc).slice(0, 40)) : String(sc);
    const won = !!pick(this.fx.won, state.won, state.victory, state.win, state.complete, state.completed);
    // (turn/menu games: a finished match isn't a death to respawn from; it's `over`)
    const over = cfg.profile === "turn" && !this.fx.dead ? !!(state.gameOver ?? state.game_over ?? state.over) : false;
    const dead = !!(this.fx.dead ? this.fx.dead(S) : cfg.profile === "turn" ? state.dead : state.dead ?? state.gameOver ?? state.game_over ?? (player && player.hp != null && player.hp <= 0) ?? (pl && pl.dead));

    // ---- choices / whose turn (turn-based, card and menu games; any profile may list choices)
    const choices = normChoices(this.fx.choices ? this.fx.choices(S) : state.choices ?? (dialogue ? null : state.tappables) ?? state.moves ?? state.legalMoves ?? state.actions);
    const yt = this.fx.yourTurn ? this.fx.yourTurn(S) : state.yourTurn ?? state.your_turn ?? state.myTurn ?? state.isYourTurn ?? state.playerTurn;
    const yourTurn = yt === undefined ? null : !!yt;

    // ---- stats (decided once so observation lines stay stable)
    if (!this.statFns) this.statFns = cfg.profile === "turn" ? this.pickFields(state) : this.pickStats(state, pl);
    const stats = [];
    for (const s of this.statFns) { const v = s.fn(S); if (v !== undefined && v !== null && v !== false) stats.push({ label: s.label, value: v }); }

    // ---- memory of things out of view
    const visible = new Set(things.map((th) => th.id));
    for (const th of things) this.memory.set(th.id, { thing: th, lastSeen: t, gone: false });
    const maxListed = things.length ? Math.max(...things.map((th) => th.dist).filter(Number.isFinite), 0) : 0;
    const remembered = [];
    for (const [id, m] of this.memory) {
      if (visible.has(id) || m.gone) continue;
      if (player && player.p2) { const d = sub(m.thing.p2, player.p2); m.thing.dist = dist2(m.thing.p2, player.p2) / cell; m.thing.dir = compass(d, cfg.northSign); }
      // last seen right around here but not listed now: it moved on (walked indoors, left), so don't keep a ghost
      if (things.length && m.thing.dist < Math.min(8, maxListed * 0.5) && t - m.lastSeen > 0.5) { m.gone = true; continue; }
      remembered.push({ ...m.thing, lastSeen: m.lastSeen, remembered: true });
    }

    // scene/level identity: when it changes, what we remembered (and the nav grid) belongs to another place.
    // A configured `scene` expression replaces the built-in fields. The map's id (from the configured map expression)
    // counts too, except when the map is a window that moved over the same ground (the same cell size and the cells
    // both windows show agree): a window that follows the player isn't a new place, and its id may change as it moves.
    const base = this.fx.scene ? [scene] : [state.scene ?? null, state.level ?? null, state.stage ?? null, state.area ?? null, state.world ?? null, state.chapter ?? null];
    const baseKey = JSON.stringify(base);
    if (map && mapId !== this.sceneMap.id) {
      const shifted = this.sceneMap.map && this.sceneBase === baseKey && sameGround(this.sceneMap.map, map);
      if (!shifted) this.sceneMap.id = mapId;
    }
    if (map) this.sceneMap.map = map;
    this.sceneBase = baseKey;
    const sceneKey = JSON.stringify([...base, this.sceneMap.id]);
    let newScene = false;
    if (this.sceneKey !== undefined && sceneKey !== this.sceneKey) {
      newScene = true;
      for (const [id, m] of this.memory) if (!visible.has(id)) this.memory.delete(id);
      remembered.length = 0;
    }
    this.sceneKey = sceneKey;
    const world = { snap, frame, t, player, things, remembered, sceneKey, newScene, maxListed, map, dialogue, menu, goal, choices, yourTurn, notice: notice ? String(notice) : null, scene, won, dead, over, stats, cell, origin: this.geo.origin, northSign: cfg.northSign };
    this.prev = world;
    return world;
  }

  /** Mark a remembered thing gone; `why` (killed / picked up / removed) lets orders explain what happened to it. */
  forget(id, why = null) { const m = this.memory.get(id); if (m) { m.gone = true; m.why = why; } }

  /**
   * Turn profile: the game's own fields for the observation (play.show: ["score", "hand", "state.trick", {label, expr}]),
   * else the snapshot's top-level fields that read like game state (score, phase, hand, trick, …), at most 10.
   */
  pickFields(state) {
    const out = [];
    const add = (label, src) => { const fn = compileExpr(src); if (fn) out.push({ label, fn }); };
    const expr = (s) => (/^(state|snap)\b/.test(s) || !/^[\w$.[\]"']+$/.test(s) ? s : `state.${s}`);
    if (Array.isArray(this.cfg.show)) {
      for (const s of this.cfg.show) {
        if (typeof s === "string") add(s.replace(/^state\./, "").split(/[[\]]/)[0], expr(s));
        else if (s && s.expr) add(s.label || s.expr, s.expr);
      }
      return out;
    }
    if (Array.isArray(this.cfg.stats)) return this.pickStats(state, null);
    const keys = Object.keys(state || {}).filter((k) => !FIELD_SKIP.test(k));
    const rank = (k) => { const i = FIELD_FIRST.findIndex((re) => re.test(k)); return i < 0 ? FIELD_FIRST.length : i; };
    keys.sort((a, b) => rank(a) - rank(b));
    for (const k of keys.slice(0, 10)) add(k, `state[${JSON.stringify(k)}]`);
    return out;
  }

  pickStats(state, pl) {
    const out = [];
    const add = (label, src) => { const fn = compileExpr(src); if (fn) out.push({ label, fn }); };
    if (Array.isArray(this.cfg.stats)) {
      for (const s of this.cfg.stats) {
        if (typeof s === "string") add(s.split(/[.[\]]/).filter(Boolean).pop(), s);
        else if (s && s.expr) add(s.label || s.expr, s.expr);
      }
      return out;
    }
    if (pl && typeof pl === "object") {
      for (const [k, v] of Object.entries(pl)) {
        if (out.length >= 5) break;
        if (STAT_SKIP.test(k)) continue;
        if (typeof v === "number" || (typeof v === "boolean" && /^(has|key)/i.test(k)) || (typeof v === "string" && /^(weapon|form|class)$/i.test(k))) add(k, `state.player && state.player[${JSON.stringify(k)}]`);
      }
    }
    // team/match scores ({blue: 12, red: 9}, at state.score / scores / match.score) with a limit if the game has one
    for (const base of ["state", "state.match"]) {
      const obj = base === "state" ? state : state && state.match;
      if (!obj || typeof obj !== "object") continue;
      const key = ["score", "scores", "teamScore", "team_score"].find((k) => obj[k] && typeof obj[k] === "object" && !Array.isArray(obj[k]) && Object.values(obj[k]).some((v) => typeof v === "number"));
      if (!key) continue;
      const lim = ["scoreLimit", "score_limit", "limit", "target", "toWin", "to_win"].find((k) => typeof obj[k] === "number");
      add("score", `(() => { const o = ${base}[${JSON.stringify(key)}] || {}; return Object.entries(o).filter(([, v]) => typeof v === "number").map(([k, v]) => k + " " + v).join(" - ")${lim ? ` + " (to " + ${base}[${JSON.stringify(lim)}] + ")"` : ""}; })()`);
      break;
    }
    for (const k of ["score", "lives", "coins", "gold", "level", "wave", "kills", "deaths", "ammo"]) {
      if (out.length >= 6) break;
      if (state && typeof state[k] === "number" && !out.some((o) => o.label === k)) add(k, `state[${JSON.stringify(k)}]`);
    }
    return out;
  }
}

/** Two maps over the same ground: same cell size, overlapping, and the overlap agrees on what's solid (≥ 90%). */
export function sameGround(a, b) {
  if (!a || !b || Math.abs(a.cell - b.cell) > 1e-9) return false;
  const solidA = new Set(a.solid), solidB = new Set(b.solid);
  const dx = Math.round((b.origin[0] - a.origin[0]) / a.cell), dy = Math.round((b.origin[1] - a.origin[1]) / a.cell);
  let both = 0, agree = 0;
  for (let r = 0; r < b.rows.length; r++) {
    const ra = a.rows[r + dy]; if (ra == null) continue;
    const rb = b.rows[r];
    for (let c = 0; c < rb.length; c++) {
      const ca = ra[c + dx]; if (ca == null) continue;
      both++; if (solidA.has(ca) === solidB.has(rb[c])) agree++;
    }
  }
  const smaller = Math.min(a.rows.length * (a.rows[0]?.length || 0), b.rows.length * (b.rows[0]?.length || 0));
  return both > 0 && both >= smaller * 0.2 && agree >= both * 0.9;
}

/** Find things matching a category or type/name/id spec. Used by orders (resolution) and observations. */
export function thingLabel(th) { return th.name && !/^\d+$/.test(th.name) ? `${th.key} "${th.name}"` : th.key; }
