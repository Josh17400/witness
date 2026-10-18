// Witness play: snapshot → world model. Reads the snapshot conventions (docs/PLAYTEST.md) with per-game overrides
// from the play config, classifies things (hostile / npc / item / friend), and remembers things out of view.
import { compileExpr, scopeFor, withVars, compass, dist2, sub } from "./util.js";

const TELEGRAPH_STATES = /^(windup|wind_up|wind-up|telegraph|telegraphing|charging|charge|prepare|preparing|aiming|attack_windup|attackwindup|startup|anticipation)$/i;
const HOSTILE_NAMES = /(enemy|monster|wolf|bandit|skeleton|zombie|goblin|orc|slime|bat|rat|spider|boss|troll|demon|draugr|ghoul|bear|boar|goomba|koopa|piranha|bowser|hammer|bullet|fire ?bar|spiny|lakitu|beetle|cultist|raider|hostile)/i;
const ITEM_NAMES = /(coin|gem|potion|key|item|pickup|heart|ammo|loot|gold|mushroom|flower|star|1up|oneup|medkit|health|chest|crystal|shard)/i;
const NPC_NAMES = /(npc|guard|villager|merchant|shopkeeper|king|queen|innkeeper|elder|farmer|smith|priest|jarl|trader|citizen|princess)/i;

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

export class Perceiver {
  constructor(cfg, { fps = 60 } = {}) {
    this.cfg = cfg;
    this.fps = fps;
    const c = (x) => compileExpr(x);
    this.fx = {
      player: c(cfg.player), entities: c(cfg.entities), pos: c(cfg.pos), hostile: c(cfg.hostile), item: c(cfg.item), npc: c(cfg.npc),
      friend: c(cfg.friend), telegraph: c(cfg.telegraph), ignore: c(cfg.ignore), dialogue: c(cfg.dialogue), menu: c(cfg.menu),
      goal: c(cfg.goal), notice: c(cfg.notice), scene: c(cfg.scene), won: c(cfg.won), dead: c(cfg.dead), map: cfg.map ? c(cfg.map) : null,
      ammo: c(cfg.ammo),
    };
    this.statFns = null;          // decided on the first snapshot (stable observation lines)
    this.memory = new Map();      // id → {thing, lastSeen, gone}
    this.geo = { cell: cfg.cell, origin: [0, 0], fromMap: false };
    this.mapCache = { key: null, map: null };
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
      const hp = num(e.hp ?? e.health), dead = !!(e.dead || (hp != null && hp <= 0 && rel === "hostile"));
      let telegraph = false, tele = null;
      if (this.fx.telegraph) { const v = this.fx.telegraph(scope); telegraph = !!v; if (typeof v === "number") tele = v; }
      else if (typeof e.telegraph === "number") { telegraph = e.telegraph > 0; tele = e.telegraph > 0 ? e.telegraph : null; }
      else if (e.telegraph) telegraph = true;
      else if (typeof e.state === "string" && TELEGRAPH_STATES.test(e.state)) telegraph = true;
      if (typeof e.telegraph === "number" && e.telegraph > 0 && tele == null) tele = e.telegraph;
      const id = e.id ?? `${type}@${i}`;
      things.push({
        raw: e, id, type, name: e.name && String(e.name).toLowerCase() !== type.toLowerCase() ? String(e.name) : null, key: `${type}#${id}`,
        pos, p2: this.planeOf(pos), rel, hp, maxHp: num(e.maxHp ?? e.hpMax ?? e.max_hp ?? e.maxHealth), dead,
        state: typeof e.state === "string" ? e.state : null, telegraph, tele,
        los: e.los ?? e.visible ?? e.inSight ?? e.in_sight ?? null, team: e.team ?? null,
        locked: e.locked ?? null, stompable: e.stompable ?? null, size: Array.isArray(e.size) ? e.size.map(Number) : null,
      });
    }

    // ---- map (optional): {cell, origin, rows, solid}
    let map = null;
    if (cfg.map !== false) {
      const m = this.fx.map ? this.fx.map(S) : state.map;
      if (m && typeof m === "object" && Array.isArray(m.rows) && m.rows.length) {
        const key = `${m.cell}|${m.origin}|${m.rows.length}|${m.rows[0].length}|${m.rows.join("").length}|${m.rows.join("\n")}`;
        if (this.mapCache.key === key) map = this.mapCache.map;
        else {
          map = { cell: +(m.cell || 1), origin: (m.origin || [0, 0]).map(Number), rows: m.rows.map(String), solid: String(m.solid ?? "#"),
            hazard: String(m.hazard ?? "^~"), oneway: String(m.oneway ?? "="), legend: m.legend || null };
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
    const dead = !!(this.fx.dead ? this.fx.dead(S) : state.dead ?? state.gameOver ?? state.game_over ?? (player && player.hp != null && player.hp <= 0) ?? (pl && pl.dead));

    // ---- stats (decided once so observation lines stay stable)
    if (!this.statFns) this.statFns = this.pickStats(state, pl);
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
      remembered.push({ ...m.thing, lastSeen: m.lastSeen, remembered: true });
    }

    // scene/level identity: when it changes, what we remembered (and the nav grid) belongs to another place
    const sceneKey = JSON.stringify([state.scene ?? null, state.level ?? null, state.stage ?? null, state.area ?? null, state.world ?? null, state.chapter ?? null, state.map && state.map.id != null ? state.map.id : null]);
    let newScene = false;
    if (this.sceneKey !== undefined && sceneKey !== this.sceneKey) {
      newScene = true;
      for (const [id, m] of this.memory) if (!visible.has(id)) this.memory.delete(id);
      remembered.length = 0;
    }
    this.sceneKey = sceneKey;
    const world = { snap, frame, t, player, things, remembered, sceneKey, newScene, maxListed, map, dialogue, menu, goal, notice: notice ? String(notice) : null, scene, won, dead, stats, cell, origin: this.geo.origin, northSign: cfg.northSign };
    this.prev = world;
    return world;
  }

  forget(id) { const m = this.memory.get(id); if (m) m.gone = true; }

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
    for (const k of ["score", "lives", "coins", "gold", "level", "wave", "kills", "deaths", "ammo"]) {
      if (out.length >= 6) break;
      if (state && typeof state[k] === "number" && !out.some((o) => o.label === k)) add(k, `state[${JSON.stringify(k)}]`);
    }
    return out;
  }
}

/** Find things matching a category or type/name/id spec. Used by orders (resolution) and observations. */
export function thingLabel(th) { return th.name && !/^\d+$/.test(th.name) ? `${th.key} "${th.name}"` : th.key; }
