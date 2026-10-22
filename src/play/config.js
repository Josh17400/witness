// Witness play: resolve the "play" section of witness.json into a complete config, filling everything the game
// doesn't specify from conventions (docs/PLAYTEST.md). Pure: no game access; `hello` and a first snapshot refine it.

const has = (keys, k) => keys.includes(k);
const firstIn = (keys, cands) => cands.find((c) => keys.includes(c)) || null;

/** A control reference → {type, ...}. "j" | "key:j" | "action:attack" | "pad:x" | "mouse:left" | "axis:leftx". */
export function parseControl(spec) {
  if (spec == null || spec === false || spec === "") return null;
  if (typeof spec === "object") return spec.type ? spec : null;
  const s = String(spec).trim();
  // "tap:target" / "click:target": tap (touch) or click the target's screen position (attack in a tap-to-shoot game)
  const tm = /^(tap|touch|click):(target|enemy|it)$/i.exec(s);
  if (tm) return { type: "target", via: /^click$/i.test(tm[1]) ? "click" : "tap" };
  const m = /^(key|action|pad|mouse|axis):(.+)$/i.exec(s);
  if (!m) return { type: "key", key: s.toLowerCase() };
  const kind = m[1].toLowerCase(), v = m[2].trim();
  if (kind === "key") return { type: "key", key: v.toLowerCase() };
  if (kind === "action") return { type: "action", action: v };
  if (kind === "pad") return { type: "pad", button: v.toLowerCase() };
  if (kind === "axis") return { type: "axis", axis: v.toLowerCase() };
  const b = { left: 0, l: 0, "0": 0, middle: 1, m: 1, "1": 1, right: 2, r: 2, "2": 2 }[v.toLowerCase()];
  return { type: "mouse", button: b ?? 0 };
}
export const controlLabel = (c) => !c ? "?" : c.type === "target" ? `${c.via}:target` : c.type === "key" ? c.key : c.type === "action" ? `action:${c.action}` : c.type === "pad" ? `pad:${c.button}` : c.type === "mouse" ? `mouse:${["left", "middle", "right"][c.button] || c.button}` : `axis:${c.axis}`;

function parseMove(spec, keys, profile) {
  // no movement: "move": false / "none", and a defense game unless it names its move keys
  if (spec === false || spec === null || /^(none|off|no)$/i.test(String(spec ?? "")) || (profile === "defense" && spec == null)) return {};
  if (spec && typeof spec === "object" && Array.isArray(spec.axis)) return { axis: spec.axis.map(String) };
  if (spec && typeof spec === "object") {
    const o = {};
    for (const d of ["up", "down", "left", "right", "forward", "back"]) if (spec[d]) o[d] = parseControl(spec[d]);
    if (o.forward && !o.up) o.up = o.forward;
    if (o.back && !o.down) o.down = o.back;
    return o;
  }
  const mk = (u, d, l, r) => ({ up: parseControl(u), down: parseControl(d), left: parseControl(l), right: parseControl(r) });
  if (spec === "wasd") return mk("w", "s", "a", "d");
  if (spec === "arrows") return mk("up", "down", "left", "right");
  if (spec === "zqsd") return mk("z", "s", "q", "d");
  // auto: platformers walk with the arrows (W/up is often jump); fps with WASD; top-down with WASD if the game has it
  const wasd = ["w", "a", "s", "d"].every((k) => has(keys, k));
  const arrows = ["up", "down", "left", "right"].every((k) => has(keys, k));
  if (profile === "platformer") return arrows || !wasd ? mk(null, "down", "left", "right") : mk(null, "s", "a", "d");
  if (profile === "fps") return mk("w", "s", "a", "d");
  return wasd || !arrows ? mk("w", "s", "a", "d") : mk("up", "down", "left", "right");
}

const PROFILES = ["topdown", "platformer", "fps", "turn", "defense"];
// turn-based / card / board / menu games: no body to walk, the game offers choices (cards, buttons, moves)
const TURN_ALIASES = /^(turn|turns|turn-based|turnbased|card|cards|board|menu|menus)$/i;
// static / tower / base defense: you never move, enemies come to you in waves; you fire, tap and build
const DEFENSE_ALIASES = /^(defense|defence|static|tower|towers|tower-defense|tower-defence|towerdefense|stationary|base|fort)$/i;
/** True when `c` names a control that moves (any key of up/down/left/right, or a stick). */
export const canMove = (mv) => !!(mv && (mv.axis || mv.up || mv.down || mv.left || mv.right));

/**
 * Resolve the play config. `raw` = witness.json "play" (may be undefined), `hello` = the adapter hello.
 * Every field the harness reads is present in the result.
 */
export function resolvePlayConfig(raw = {}, hello = {}) {
  raw = raw || {};
  const keys = (hello.keys || []).map((k) => String(k).toLowerCase());
  const profile = PROFILES.includes(raw.profile) ? raw.profile : TURN_ALIASES.test(String(raw.profile || "")) ? "turn" : DEFENSE_ALIASES.test(String(raw.profile || "")) ? "defense" : "topdown";
  const defense = profile === "defense";
  const c = raw.controls || {};
  const pick = (name, cands) => (name in c ? parseControl(c[name]) : cands ? parseControl(firstIn(keys, cands)) : null);
  const controls = {
    move: parseMove(c.move, keys, profile),
    attack: pick("attack", profile === "fps" ? null : profile === "platformer" ? null : ["j", "x", "f"]),
    attackMode: c.attackMode === "hold" ? "hold" : profile === "fps" ? "hold" : "tap",
    attackEvery: +(c.attackEvery ?? 0.35),
    block: pick("block"),
    dodge: pick("dodge"),
    interact: pick("interact", profile === "fps" ? null : ["e", "f"]),
    heal: pick("heal"),
    confirm: pick("confirm", ["enter", "space"]),
    cancel: pick("cancel", ["escape"]),
    jump: pick("jump", profile === "platformer" ? ["z", "space", "k", "up", "w"] : profile === "fps" ? ["space"] : null),
    run: pick("run", profile === "platformer" ? ["x", "shift"] : profile === "fps" ? ["shift"] : null),
    crouch: pick("crouch"),
    reload: pick("reload", profile === "fps" ? ["r"] : null),
    aim: pick("aim"),                 // fps: aim down sights (held)
    weapons: Array.isArray(c.weapons) ? c.weapons.map(parseControl) : profile === "fps" ? ["1", "2", "3", "4"].filter((k) => has(keys, k)).map(parseControl) : [],
    choose: c.choose === "arrows" ? { mode: "arrows" } : Array.isArray(c.choose) ? { mode: "list", keys: c.choose.map(parseControl) }
      : c.choose === "numbers" || has(keys, "1") || !keys.length ? { mode: "numbers" } : { mode: "arrows" },
    tapFrames: Math.max(1, Math.round(+(c.tapFrames ?? 2))),
  };
  if (profile === "fps" && !("attack" in c)) controls.attack = parseControl("mouse:left");
  // free-form named controls usable in orders: "use <name>" / "press <name>"
  const named = {};
  for (const [k, v] of Object.entries(c)) if (!["move", "attackMode", "attackEvery", "choose", "weapons", "tapFrames"].includes(k) && v != null) {
    const pc = parseControl(v); if (pc) named[k.toLowerCase()] = pc;
  }
  for (const [k, v] of Object.entries(controls)) if (v && v.type && !named[k]) named[k] = v;

  const fpsDefaults = profile === "fps";
  const cfg = {
    profile,
    controls,
    named,
    rawControls: c,
    // where things live (expressions over the snapshot; `state`, `snap` and the expr.js helpers are in scope)
    player: raw.player || null,             // null: state.player, else the first entity typed Player/Hero
    entities: raw.entities || "state.entities",
    pos: raw.pos || null,                    // per-thing position expression with `e`; null: e.pos / e.position / [e.x, e.y(, e.z)]
    hostile: raw.hostile || null, item: raw.item || null, npc: raw.npc || null, friend: raw.friend || null,
    telegraph: raw.telegraph || null, ignore: raw.ignore || null,
    avoid: raw.avoid || null,               // per-thing: keep paths off it unless it's the goal (null: e.avoid / e.door / Door, Stairs, Exit… types)
    mapWindow: raw.mapWindow != null ? !!raw.mapWindow : null,   // true: state.map is a window that follows the player (else detected when it moves)
    dialogue: raw.dialogue || null, menu: raw.menu || null, goal: raw.goal || null, notice: raw.notice || null,
    scene: raw.scene || null, won: raw.won || null, dead: raw.dead || null, map: raw.map === false ? false : raw.map || null,
    stats: Array.isArray(raw.stats) ? raw.stats : null,
    ammo: raw.ammo || null,
    // geometry
    plane: Array.isArray(raw.plane) ? raw.plane : fpsDefaults ? [0, 2] : [0, 1],
    north: raw.north || (fpsDefaults ? "-z" : profile === "platformer" ? "-y" : "-y"),
    cell: raw.cell != null ? +raw.cell : null,           // world units per nav cell (null: from the map, else measured)
    speed: raw.speed != null ? +raw.speed : null,         // world units per second when walking (null: measured)
    reach: { attack: 1.2, interact: 1.2, pickup: 0.5, ...(raw.reach || {}) },   // in cells
    // cells: a hostile this close is an alert (and wakes the tester when alerts wake); 0 = alerts off (6 for ranges)
    alert: +(raw.alert ?? 6) || 6,
    // alerts: true = they wake waits/moves, "events" = listed in events only (defense default), false = none (alert 0)
    alerts: raw.alert === 0 || raw.alerts === false || /^(off|none|no)$/i.test(String(raw.alerts ?? "")) ? false
      : raw.alerts === true || /^(on|wake|yes)$/i.test(String(raw.alerts ?? "")) ? true : raw.alerts === "events" || defense ? "events" : true,
    leash: +(raw.leash ?? 14),               // cells: a fight stops chasing a target this far from where it started
    sight: +(raw.sight ?? 3),                // cells around the path counted as "seen" when exploring without a map
    reaction: +(raw.reaction ?? 0.25),       // seconds before the reflex layer reacts to a telegraph
    tick: Math.max(1, Math.round(+(raw.tick ?? 3))),
    combatTick: Math.max(1, Math.round(+(raw.combatTick ?? 1))),
    guard: raw.guard != null ? raw.guard !== false : !defense,   // a defense game has nothing to block with by stepping
    autofight: raw.autofight != null ? !!raw.autofight : defense ? false : null,   // null: on for topdown and fps, off for platformers
    autofightLeash: +(raw.autofightLeash ?? 6),    // cells an autofight may chase before it gives up and the move resumes
    live: { horizon: 4, pauseAfter: 15, speed: 1, ...(raw.live || {}) },   // live mode: check-in horizon (game s), auto-pause after (wall s), pace
    guardMode: ["block", "dodge", "backoff"].includes(raw.guardMode) ? raw.guardMode : null,   // null: block if possible, else dodge, else back off
    radius: raw.radius != null ? +raw.radius : null,     // player collision radius in cells (null: from player.size, else 0.35)
    mirrorCombos: raw.mirrorCombos !== false,
    retreat: +(raw.retreat ?? 0),
    heal: +(raw.heal ?? 0),
    combos: raw.combos || {},
    allowCalls: !!raw.allowCalls,
    logs: raw.logs === false ? false : raw.logs || true,   // true | false | "regex" for which info logs count as game events
    maxShots: +(raw.maxShots ?? 24),
    platformer: { jumpFrames: 18, runJumpFrames: 22, stomp: true, ...(raw.platformer || {}) },
    fps: { sens: null, aimTolerance: 1.0, strafe: true, eye: 1.5, aimHeight: 1.2, ...(raw.fps || {}) },
    module: raw.module || null,
    resultChars: Math.max(40, +(raw.resultChars ?? 800) || 800),   // how much of a call's result an observation shows (look --full: all)
    screen: raw.screen || null,              // per-thing screen position expression with `e` (tap:target); null: e.screen, state.camera
    fightWait: Math.max(1, +(raw.fightWait ?? 20) || 20),   // s a waiting fight ("when they come", defense) waits without a "for"
    // turn profile (also read by any profile when the game lists choices): the game's choices, whose turn it is, the
    // fields the observation shows, how a pick reaches the game, how long a bare `wait` may wait for your turn
    choices: raw.choices || null, yourTurn: raw.yourTurn || null,
    show: Array.isArray(raw.show) ? raw.show : null,
    pick: parsePick(raw.pick),
    turnWait: Math.max(1, +(raw.turnWait ?? 30) || 30),
  };
  cfg.northSign = /^\+/.test(String(cfg.north)) ? 1 : -1;
  return cfg;
}

/**
 * How `pick` sends a choice: {call: "fn"} calls the game's function with the choice's id (args: ["id"] / ["index"] /
 * ["label"] / ["id", "index"]...), {mode: "click"} clicks the choice's rect/pos, {mode: "keys"} presses its number
 * (or play.controls.choose). Default "auto": the choice's own key, else a configured call, else a click when the
 * choice has a rect/pos, else its number key.
 */
export function parsePick(p) {
  if (p == null || p === "auto") return { mode: "auto", call: null, args: ["id"] };
  if (typeof p === "string") {
    if (/^(click|tap|keys?|numbers?)$/i.test(p)) return { mode: /^(click|tap)$/i.test(p) ? "click" : "keys", call: null, args: ["id"] };
    const m = /^call:(.+)$/i.exec(p);
    return { mode: "call", call: (m ? m[1] : p).trim(), args: ["id"] };
  }
  if (typeof p === "object") {
    const call = p.call ? String(p.call) : null;
    const mode = call ? "call" : /^(click|tap)$/i.test(String(p.mode || "")) ? "click" : /^(keys?|numbers?)$/i.test(String(p.mode || "")) ? "keys" : "auto";
    const args = Array.isArray(p.args) && p.args.length ? p.args.map(String) : ["id"];
    return { mode, call, args };
  }
  return { mode: "auto", call: null, args: ["id"] };
}

/** Short description of the controls for the brief / first observation. */
export function describeControls(cfg) {
  const c = cfg.controls, out = [];
  if (cfg.profile === "turn" || cfg.profile === "defense") {   // no movement: only the controls the game named itself
    for (const [k, v] of Object.entries(cfg.named)) if (!["confirm", "cancel"].includes(k) && v && !(k in c && !(cfg.rawControls || {})[k])) out.push(`${k} ${controlLabel(v)}`);
    return out.join(" · ");
  }
  const parts = c.move.axis ? null : ["up", "left", "down", "right"].map((d) => c.move[d] ? c.move[d].key || controlLabel(c.move[d]) : null).filter(Boolean);
  const mv = c.move.axis ? `stick ${c.move.axis.join("/")}` : parts.every((k) => k.length === 1) ? parts.join("") : parts.join("/");
  if (mv) out.push(`move ${mv}`);
  for (const k of ["attack", "block", "dodge", "interact", "heal", "jump", "run", "reload", "aim"]) if (c[k]) out.push(`${k} ${controlLabel(c[k])}`);
  return out.join(" · ");
}
