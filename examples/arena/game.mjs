// "Arena": a small top-down action game for Witness agent playtests (docs/PLAYTEST_PLAN.md §11).
// A maze where straight lines get you stuck, wolves whose bites are telegraphed by a windup, an NPC
// with a two-option dialogue, pickups, a locked gate and an exit. It exists to show the snapshot
// conventions an AI playtest harness reads (player, entities with hostile/item/talk/state/telegraph,
// dialogue, goal, notice, map, won/dead, digest) and to give that harness something real to play.
//   witness mode:  WITNESS_ADDR=127.0.0.1:<port> node game.mjs   (the witness CLI does this)
//   normal play:   node game.mjs   (a terminal game; without a terminal: a short scripted real-time demo)
//   record a run:  WITNESS_RECORD=witness/replays/run.jsonl node game.mjs
import witness from "../../adapters/js/witness.js";

const TILE = 16, COLS = 30, ROWS = 18, W = COLS * TILE, H = ROWS * TILE, FPS = 60, SR = 22050, EPS = 1e-6;

// '#' wall, '.' floor; markers become floor + a thing: @ player start, g Old Guard, w Wolf, A Alpha Wolf,
// p Potion, c Coin, G gate (solid until opened), X exit. Checked by the "map" test: everything is reachable
// with the gate open, the exit is not reachable with it closed, and the straight line start→exit hits walls.
const MAP = [
  "##############################",
  "##############....#.........c#",
  "##############.##.....w......#",
  "#......#c###...##.#.......w..#",
  "#......#.#####.##.#..........#",
  "#...g..#.##....##.#..........#",
  "#......#.##.#####c#....w.....#",
  "#.@.........#######..........#",
  "#......####.########.#####G###",
  "#......####.#######...##.....#",
  "#......##c....#####...##.....#",
  "#.p....######.#####...##.....#",
  "#......######.#####...##.....#",
  "#########.....#####...##.....#",
  "#########.#########.A.##..X..#",
  "#p..........c.#####...##.....#",
  "#....c........#####..c##.....#",
  "##############################",
];

// ------------------------------------------------------------------ tuning
const PLAYER = { hp: 10, speed: 80, radius: 5, attackCooldown: 0.4, swing: 0.1, reach: 22, arc: 75, blockArc: 90,
  dashMul: 3.2, dash: 0.18, dashCooldown: 0.7, talk: 20, gate: 24, pickup: 10, potion: 4 };
const WOLVES = {
  Wolf: { name: "Wolf", hp: 3, speed: 60, windup: 0.5, damage: 2 },
  AlphaWolf: { name: "Alpha Wolf", hp: 6, speed: 55, windup: 0.6, damage: 3 },
};
const WOLF_R = 5, AGGRO = 88, GIVE_UP = 160, LOST_LOS = 2, REACH = 20, STRIKE = 26, RECOVER = 0.5, STAGGER = 1.0;
const STARTS = { maze: [11, 7], courtyard: [19, 2], alpha: [20, 9], gate: [26, 7] };   // tile; "start" = the @ tile
const QUEST = "Get the key from the Alpha Wolf";
const FACE = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const DIR_KEYS = { w: "N", up: "N", s: "S", down: "S", a: "W", left: "W", d: "E", right: "E" };
const DIALOGUE = {
  intro: { speaker: "Old Guard", text: "Wolves! The Alpha Wolf ran off with the gate key. Will you get it back?", options: ["I'll get it back.", "Not my problem."] },
  accepted: { speaker: "Old Guard", text: "Take this potion. Watch for the wolves' lunge: block it with K, then strike!", options: ["Thanks."] },
  declined: { speaker: "Old Guard", text: "Suit yourself. The gate stays shut without that key.", options: ["Bye."] },
  again: { speaker: "Old Guard", text: "Any luck with that key? The Alpha Wolf hides south of the courtyard.", options: ["Bye."] },
  done: { speaker: "Old Guard", text: "You did it! Now open the gate on the courtyard's south side.", options: ["Bye."] },
};

// ------------------------------------------------------------------ state (all of it is rebuilt by reset)
let grid, start, player, things, nextId, time, won, deaths, quest, declined, guardGave, notice, noticeAt, dialogue, god, draws;
let edges = [], pressSeq = 0;
const held = new Set(), pressOrder = new Map(), recent = [];
const rand = () => { draws++; return witness.random(); };    // every random number comes from the seeded stream

function reset({ seed, scene, params } = {}) {
  void seed;   // witness reseeds witness.random() before calling reset
  params = params || {};
  held.clear(); pressOrder.clear(); edges = []; pressSeq = 0; recent.length = 0;
  draws = 0; nextId = 1; time = 0; won = false; deaths = 0; declined = false; guardGave = !!params.quest;
  quest = params.quest ? QUEST : null; notice = null; noticeAt = 0; dialogue = null; god = !!params.god;
  grid = MAP.map((row) => [...row].map((c) => (c === "#" || c === "G" || c === "X" ? c : ".")));
  things = [];
  player = { id: nextId++, type: "Player", x: 0, y: 0, hp: PLAYER.hp, maxHp: PLAYER.hp, facing: "E", potions: 0, gold: 0,
    hasKey: !!params.key, dead: false, swing: 0, cooldown: 0, hits: [], dash: 0, dashCooldown: 0, dashDir: [1, 0], blocking: false };
  for (let ty = 0; ty < ROWS; ty++) for (let tx = 0; tx < COLS; tx++) {
    const c = MAP[ty][tx], x = tx * TILE + 8, y = ty * TILE + 8;
    if (c === "#" || c === ".") continue;
    if (c === "@") { start = [x, y]; continue; }
    const id = nextId++;   // ids follow map order whatever the params, so tests can name things by id
    if (c === "w" || c === "A") { if (params.wolves !== false) things.push(makeWolf(id, c === "A" ? "AlphaWolf" : "Wolf", x, y)); }
    else if (c === "g") things.push({ id, type: "Guard", name: "Old Guard", x, y });
    else if (c === "p" || c === "c") things.push({ id, type: c === "p" ? "Potion" : "Coin", x, y });
    else if (c === "G") things.push({ id, type: "Gate", x, y, tx, ty, locked: true });
    else if (c === "X") things.push({ id, type: "Exit", x, y, tx, ty });
  }
  const name = params.start || (STARTS[scene] ? scene : "start");
  const t = STARTS[name];
  [player.x, player.y] = t ? [t[0] * TILE + 8, t[1] * TILE + 8] : start;
}

function makeWolf(id, type, x, y) {
  const k = WOLVES[type];
  return { id, type, name: k.name, x, y, hp: k.hp, maxHp: k.hp, state: "idle", timer: 0, lost: 0, hx: x, hy: y,
    homing: false, wanderT: 0.5 + rand() * 1.5, tx: x, ty: y, detour: 1 };
}

// ------------------------------------------------------------------ input
const KEY_ALIASES = { " ": "space", esc: "escape", return: "enter", arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right" };
const normKey = (k) => { const n = String(k).toLowerCase(); return KEY_ALIASES[n] || n; };

function input(ev) {
  if (!ev || ev.type !== "key") return true;
  const k = normKey(ev.key);
  if (ev.down) {
    if (!held.has(k)) {
      held.add(k);
      edges.push(k);                                  // key-down edges: attack, dodge, interact, potion, choose, ...
      if (DIR_KEYS[k]) pressOrder.set(k, ++pressSeq);  // diagonal facing follows the most recent direction key
    }
  } else held.delete(k);
  return true;
}

// ------------------------------------------------------------------ helpers
const isSolid = (tx, ty) => tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS || grid[ty][tx] === "#" || grid[ty][tx] === "G";
const solidAt = (x, y) => isSolid(Math.floor(x / TILE), Math.floor(y / TILE));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const isWolf = (t) => t.type === "Wolf" || t.type === "AlphaWolf";
const tag = (t) => `${t.type}#${t.id}`;
const find = (type) => things.find((t) => t.type === type) || null;

function say(msg) {
  witness.log(msg);
  recent.push(`${time.toFixed(1)} ${msg}`);
  if (recent.length > 4) recent.shift();
}
function setNotice(text) { notice = text; noticeAt = time; }

// Axis-separated movement of a circle against solid tiles: each axis moves until first contact, so a
// diagonal push into a wall keeps sliding along it.
function moveCircle(e, dx, dy, r) {
  if (dx) e.x = sweep(e.x, e.y, dx, r, true);
  if (dy) e.y = sweep(e.y, e.x, dy, r, false);
}
function sweep(a, b, d, r, horizontal) {
  let target = a + d;
  const t0 = Math.floor((Math.min(a, target) - r) / TILE), t1 = Math.floor((Math.max(a, target) + r) / TILE);
  const s0 = Math.floor((b - r) / TILE), s1 = Math.floor((b + r) / TILE);
  for (let t = t0; t <= t1; t++) for (let s = s0; s <= s1; s++) {
    if (!(horizontal ? isSolid(t, s) : isSolid(s, t))) continue;
    const b0 = s * TILE, b1 = b0 + TILE, off = b < b0 ? b0 - b : b > b1 ? b - b1 : 0;
    if (off >= r) continue;
    const reach = Math.sqrt(r * r - off * off);
    if (d > 0) { const c = t * TILE - reach; if (c >= a - 1e-7 && c < target) target = c; }
    else { const c = (t + 1) * TILE + reach; if (c <= a + 1e-7 && c > target) target = c; }
  }
  return target;
}

// Line of sight: no solid tile on the segment, sampled every 4 px.
function los(a, b) {
  const n = Math.max(1, Math.ceil(dist(a, b) / 4));
  for (let i = 0; i <= n; i++) if (solidAt(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n)) return false;
  return true;
}

// Is `t` within ±deg of the player's facing?
function inArc(t, deg) {
  const [fx, fy] = FACE[player.facing], dx = t.x - player.x, dy = t.y - player.y, d = Math.hypot(dx, dy);
  return d < 1e-9 || (fx * dx + fy * dy) / d >= Math.cos((deg * Math.PI) / 180) - 1e-9;
}

function moveInput() {
  const on = (...ks) => ks.some((k) => held.has(k));
  return [(on("d", "right") ? 1 : 0) - (on("a", "left") ? 1 : 0), (on("s", "down") ? 1 : 0) - (on("w", "up") ? 1 : 0)];
}

// ------------------------------------------------------------------ simulation
function step(dt) {
  dt = +dt > 0 ? +dt : 1 / FPS;
  time += dt;
  const p = player;
  p.cooldown = Math.max(0, p.cooldown - dt);
  p.swing = Math.max(0, p.swing - dt);
  p.dash = Math.max(0, p.dash - dt);
  p.dashCooldown = Math.max(0, p.dashCooldown - dt);
  p.blocking = held.has("k") && !p.dead && !dialogue && !won;

  for (const k of edges.splice(0)) handleEdge(k);

  // movement
  const [ix, iy] = moveInput();
  if (!p.dead && !dialogue) {
    let vx = 0, vy = 0;
    if (p.dash > EPS) { vx = p.dashDir[0] * PLAYER.speed * PLAYER.dashMul; vy = p.dashDir[1] * PLAYER.speed * PLAYER.dashMul; }
    else if (ix || iy) {
      const len = Math.hypot(ix, iy), sp = PLAYER.speed * (p.blocking ? 0.5 : 1);
      vx = (ix / len) * sp; vy = (iy / len) * sp;
    }
    moveCircle(p, vx * dt, vy * dt, PLAYER.radius);
    if (ix || iy) p.facing = facingFor(ix, iy);
  }

  // the swing hits every hostile in the front arc, each at most once per swing
  if (p.swing > EPS && !p.dead) {
    for (const w of things.filter(isWolf)) {
      if (p.hits.includes(w.id) || dist(p, w) > PLAYER.reach || !inArc(w, PLAYER.arc)) continue;
      p.hits.push(w.id);
      const dmg = w.state === "stagger" ? 2 : 1;
      w.hp -= dmg;
      say(`You hit ${tag(w)} (-${dmg})`);
      sfx("hit");
      if (w.hp <= 0) killWolf(w);
      else if (w.state === "idle") { w.state = "chase"; w.lost = 0; w.homing = false; }
    }
  }

  // pickups
  if (!p.dead) {
    for (const it of things.filter((t) => t.type === "Potion" || t.type === "Coin" || t.type === "Key")) {
      if (dist(p, it) > PLAYER.pickup) continue;
      things.splice(things.indexOf(it), 1);
      if (it.type === "Potion") p.potions++;
      else if (it.type === "Coin") p.gold++;
      else p.hasKey = true;
      say(it.type === "Key" ? "You pick up the Key" : `You pick up a ${it.type}`);
      sfx("pickup");
    }
  }

  // wolves
  if (!won) {
    for (const w of things.filter(isWolf)) updateWolf(w, dt);
    separateWolves();
  }

  if (p.hp <= 0 && !p.dead) die();
  if (!won && !p.dead) {
    const ex = find("Exit");
    if (ex && Math.floor(p.x / TILE) === ex.tx && Math.floor(p.y / TILE) === ex.ty) {
      won = true;
      for (const w of things.filter(isWolf)) { w.state = "idle"; w.timer = 0; }
      setNotice("You escaped the arena!");
      say("You escaped the arena!");
      sfx("win");
    }
  }
  // notices fade after 3 s, except "you died" (until you respawn) and "you escaped" (for good)
  if (notice && !p.dead && !won && time - noticeAt >= 3 - EPS) notice = null;
}

function facingFor(ix, iy) {
  if (ix && iy) {   // diagonal: the axis of the most recently pressed direction key that is held and counts
    let best = null, bestSeq = -1;
    for (const [k, f] of Object.entries(DIR_KEYS)) {
      if (!held.has(k)) continue;
      const counts = (f === "E" && ix > 0) || (f === "W" && ix < 0) || (f === "S" && iy > 0) || (f === "N" && iy < 0);
      if (counts && (pressOrder.get(k) || 0) > bestSeq) { bestSeq = pressOrder.get(k) || 0; best = f; }
    }
    if (best) return best;
  }
  return ix ? (ix > 0 ? "E" : "W") : iy > 0 ? "S" : "N";
}

function handleEdge(k) {
  const p = player;
  if (p.dead) { if (k === "enter") respawn(); return; }
  if (dialogue) {
    if (k === "1" || k === "2" || k === "3") choose(+k);
    else if (k === "escape") dialogue = null;
    return;
  }
  if (won) return;
  if (k === "j" || k === "space") {
    if (p.blocking || p.cooldown > EPS) return;
    p.swing = PLAYER.swing; p.cooldown = PLAYER.attackCooldown; p.hits = [];
    sfx("swing");
  } else if (k === "l" || k === "shift") {
    if (p.dashCooldown > EPS) return;
    const [ix, iy] = moveInput(), len = Math.hypot(ix, iy);
    p.dashDir = len ? [ix / len, iy / len] : [...FACE[p.facing]];
    p.dash = PLAYER.dash; p.dashCooldown = PLAYER.dashCooldown;
    sfx("dodge");
  } else if (k === "e") interact();
  else if (k === "q") {
    if (p.potions > 0 && p.hp < p.maxHp) {
      const heal = Math.min(PLAYER.potion, p.maxHp - p.hp);
      p.hp += heal; p.potions--;
      say(`You drink a potion (+${heal})`);
      sfx("drink");
    }
  }
}

function interact() {
  const g = find("Guard");
  if (g && dist(player, g) <= PLAYER.talk) {
    dialogue = !quest ? DIALOGUE.intro : player.hasKey ? DIALOGUE.done : DIALOGUE.again;
    player.dash = 0;
    return;
  }
  const gate = find("Gate");
  if (gate && gate.locked && dist(player, gate) <= PLAYER.gate) {
    if (player.hasKey) openGate();
    else setNotice("The gate is locked. The Alpha Wolf has the key.");
  }
}

function choose(n) {
  if (!dialogue || n > dialogue.options.length) return;
  if (dialogue === DIALOGUE.intro) {
    if (n === 1) {
      if (!guardGave) { guardGave = true; player.potions++; say("The Old Guard gives you a Potion"); sfx("pickup"); }
      quest = QUEST; declined = false;
      dialogue = DIALOGUE.accepted;
    } else { declined = true; dialogue = DIALOGUE.declined; }
  } else dialogue = null;   // a single "Thanks." / "Bye." closes it
}

function openGate() {
  const gate = find("Gate");
  if (!gate || !gate.locked) return false;
  gate.locked = false;
  grid[gate.ty][gate.tx] = ".";
  setNotice("The gate swings open.");
  say("The gate swings open");
  sfx("gate");
  return true;
}

function die() {
  const p = player;
  p.dead = true; p.hp = 0; p.swing = 0; p.dash = 0; p.blocking = false;
  deaths++;
  dialogue = null;
  setNotice("You died. Press ENTER to respawn.");
  say("You died");
  sfx("death");
}

function respawn() {
  const p = player;
  Object.assign(p, { dead: false, hp: p.maxHp, x: start[0], y: start[1], facing: "E", swing: 0, cooldown: 0, hits: [], dash: 0, dashCooldown: 0 });
  notice = null;
  say("You wake up at the start");
}

function killWolf(w) {
  const i = things.indexOf(w);
  if (i < 0) return;
  things.splice(i, 1);
  say(`${tag(w)} dies`);
  sfx("wolfDie");
  if (w.type === "AlphaWolf") {
    things.push({ id: nextId++, type: "Key", x: w.x, y: w.y });
    say("The Alpha Wolf drops the key!");
  }
}

// idle → chase → windup → strike → recover → chase, plus stagger (after a blocked bite)
function updateWolf(w, dt) {
  const k = WOLVES[w.type], p = player, alive = !p.dead;
  const goIdle = () => { w.state = "idle"; w.timer = 0; w.lost = 0; w.homing = true; };
  switch (w.state) {
    case "idle": {
      if (alive && dist(w, p) <= AGGRO && los(w, p)) { w.state = "chase"; w.lost = 0; w.homing = false; break; }
      if (w.homing) { if (stepToward(w, w.hx, w.hy, 40 * dt) < 1) w.homing = false; break; }
      w.wanderT -= dt;
      if (w.wanderT <= 0) { w.tx = w.hx + (rand() * 2 - 1) * 12; w.ty = w.hy + (rand() * 2 - 1) * 12; w.wanderT = 1.5 + rand() * 2; }
      stepToward(w, w.tx, w.ty, 20 * dt);
      break;
    }
    case "chase": {
      const d = dist(w, p);
      if (!alive || d > GIVE_UP) { goIdle(); break; }
      if (los(w, p)) w.lost = 0;
      else if ((w.lost += dt) >= LOST_LOS) { goIdle(); break; }
      if (d < REACH) { w.state = "windup"; w.timer = k.windup; break; }
      chaseMove(w, k.speed * dt);
      break;
    }
    case "windup":
      w.timer -= dt;
      if (w.timer <= EPS) { w.timer = 0; strike(w, k); }
      break;
    case "strike":
      w.state = "recover"; w.timer = RECOVER;
      break;
    case "recover":
    case "stagger":
      w.timer -= dt;
      if (w.timer <= EPS) { w.state = "chase"; w.timer = 0; w.lost = 0; }
      break;
  }
}

function strike(w, k) {
  const p = player;
  w.state = "strike";   // shown for exactly one frame, then recover
  if (p.dead) return;
  if (dist(w, p) > STRIKE) { say(`${tag(w)}'s bite misses`); return; }
  if (p.dash > EPS) { say(`You dodge ${tag(w)}'s bite`); return; }
  if (p.blocking && inArc(w, PLAYER.blockArc)) {
    w.state = "stagger"; w.timer = STAGGER;
    say(`You block ${tag(w)}'s bite. It staggers!`);
    sfx("block");
    return;
  }
  const dmg = god ? 0 : k.damage;
  p.hp -= dmg;
  say(`${tag(w)} bites you (-${dmg})`);
  sfx("bite");
}

function stepToward(w, tx, ty, maxStep) {
  const dx = tx - w.x, dy = ty - w.y, d = Math.hypot(dx, dy);
  if (d < 0.5) return d;
  const s = Math.min(maxStep, d);
  moveCircle(w, (dx / d) * s, (dy / d) * s, WOLF_R);
  return Math.hypot(tx - w.x, ty - w.y);
}

// Direct steering; when a wall stops it, try the other axis (toward the player, else the wolf's detour side).
function chaseMove(w, s) {
  const dx = player.x - w.x, dy = player.y - w.y, d = Math.hypot(dx, dy);
  if (d < 1e-9) return;
  const ox = w.x, oy = w.y;
  moveCircle(w, (dx / d) * s, (dy / d) * s, WOLF_R);
  if (Math.hypot(w.x - ox, w.y - oy) >= s * 0.3) return;
  const bx = w.x, by = w.y;
  if (Math.abs(dx) >= Math.abs(dy)) moveCircle(w, 0, (Math.abs(dy) > 2 ? Math.sign(dy) : w.detour) * s, WOLF_R);
  else moveCircle(w, (Math.abs(dx) > 2 ? Math.sign(dx) : w.detour) * s, 0, WOLF_R);
  if (Math.hypot(w.x - bx, w.y - by) < s * 0.3) w.detour = -w.detour;
}

// A small push so wolves don't stack exactly.
function separateWolves() {
  const ws = things.filter(isWolf);
  for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) {
    const a = ws[i], b = ws[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
    if (d >= WOLF_R * 2) continue;
    const [ux, uy] = d < 1e-6 ? [1, 0] : [dx / d, dy / d], push = (WOLF_R * 2 - d) * 0.25;
    moveCircle(a, -ux * push, -uy * push, WOLF_R);
    moveCircle(b, ux * push, uy * push, WOLF_R);
  }
}

// ------------------------------------------------------------------ snapshot
const r3 = (v) => Math.round(v * 1000) / 1000;
const pos = (t) => [r3(t.x), r3(t.y)];

function goalText() {
  const gate = find("Gate");
  if (won) return "You escaped!";
  if (gate && !gate.locked) return "Reach the exit behind the gate";
  if (player.hasKey) return "Open the gate (east) and reach the exit";
  if (quest || declined) return QUEST;
  return "Talk to the Old Guard";
}

function view(t) {
  if (t === player) {
    return { id: t.id, type: "Player", pos: pos(t), hp: t.hp, maxHp: t.maxHp, facing: t.facing, attacking: t.swing > EPS,
      blocking: t.blocking, dodging: t.dash > EPS, potions: t.potions, gold: t.gold, hasKey: t.hasKey };
  }
  if (isWolf(t)) return { id: t.id, type: t.type, name: t.name, pos: pos(t), hp: t.hp, maxHp: t.maxHp, hostile: true, state: t.state, telegraph: t.state === "windup" ? r3(t.timer) : 0 };
  if (t.type === "Guard") return { id: t.id, type: "Guard", name: t.name, pos: pos(t), talk: true, hostile: false };
  if (t.type === "Gate") return { id: t.id, type: "Gate", pos: pos(t), locked: t.locked };
  if (t.type === "Exit") return { id: t.id, type: "Exit", pos: pos(t) };
  return { id: t.id, type: t.type, pos: pos(t), item: true };
}

function snapshot() {
  const pl = view(player);
  return {
    scene: "arena", time: r3(time), won, dead: player.dead, deaths, quest, notice,
    goal: { text: goalText() },
    player: pl,
    entities: [pl, ...things.map(view)],
    dialogue: dialogue ? { speaker: dialogue.speaker, text: dialogue.text, options: [...dialogue.options] } : null,
    map: { cell: TILE, origin: [0, 0], rows: grid.map((r) => r.join("")), solid: "#G" },
    ui: hudLayout().map(({ color, ...e }) => e),
    digest: digest(),
  };
}

// FNV-1a (two lanes) over every bit of internal state: exact floats, timers, held keys, rng draws.
function digest() {
  const s = JSON.stringify({ time, player, things, held: [...held].sort(), edges, pressOrder: [...pressOrder].sort(), pressSeq,
    dialogue: dialogue && dialogue.text, quest, declined, guardGave, notice, noticeAt, nextId, won, deaths, god,
    seed: witness.seed(), draws, grid: grid.map((r) => r.join("")) });
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193 + 0x2000);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

// ------------------------------------------------------------------ audio (precomputed, mixed at the current simulated time)
const mixer = witness.createMixer({ sampleRate: SR });
function tone(dur, f0, f1, decay, vol, noise = 0, seed = 1) {
  const n = Math.round(SR * dur), out = new Float32Array(n);
  let ph = 0, s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (f0 + ((f1 - f0) * i) / n)) / SR;
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const nz = (s / 4294967296) * 2 - 1;
    out[i] = (Math.sin(ph) * (1 - noise) + nz * noise) * vol * Math.exp(-t / decay) * Math.min(1, i / (SR * 0.002));
  }
  return out;
}
const mix = (...parts) => { const n = Math.max(...parts.map((p) => p.length)), out = new Float32Array(n); for (const p of parts) p.forEach((v, i) => { out[i] += v; }); return out; };
const concat = (...parts) => { const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const SFX = {
  swing: tone(0.08, 700, 300, 0.03, 0.3, 0.7, 3),
  dodge: tone(0.1, 400, 900, 0.04, 0.2, 0.6, 5),
  hit: tone(0.12, 260, 140, 0.04, 0.5, 0.35, 7),
  bite: tone(0.16, 140, 80, 0.06, 0.55, 0.5, 9),
  block: mix(tone(0.14, 1100, 1100, 0.05, 0.3), tone(0.14, 1650, 1650, 0.04, 0.2)),
  pickup: tone(0.14, 880, 1320, 0.06, 0.45),
  drink: tone(0.2, 500, 900, 0.1, 0.35, 0.05, 11),
  wolfDie: tone(0.3, 300, 120, 0.12, 0.45, 0.4, 13),
  death: tone(0.7, 440, 90, 0.3, 0.5, 0.1, 15),
  gate: tone(0.35, 90, 60, 0.15, 0.6, 0.3, 17),
  win: concat(tone(0.12, 523, 523, 0.08, 0.4), tone(0.12, 659, 659, 0.08, 0.4), tone(0.3, 784, 784, 0.15, 0.4)),
};
// every sound effect is also announced to Witness, so listen names it ("swing", "hit") and ties it to its cause
const sfx = (name) => { mixer.play(SFX[name]); witness.sound(name); };

// ------------------------------------------------------------------ screenshot (480x288 RGBA, drawn in software)
// 3x5 pixel font: each glyph is 5 rows of 3 bits (4 = left, 2 = middle, 1 = right).
const FONT = {
  A: [2, 5, 7, 5, 5], B: [6, 5, 6, 5, 6], C: [3, 4, 4, 4, 3], D: [6, 5, 5, 5, 6], E: [7, 4, 6, 4, 7], F: [7, 4, 6, 4, 4],
  G: [3, 4, 5, 5, 3], H: [5, 5, 7, 5, 5], I: [7, 2, 2, 2, 7], J: [1, 1, 1, 5, 2], K: [5, 5, 6, 5, 5], L: [4, 4, 4, 4, 7],
  M: [5, 7, 7, 5, 5], N: [6, 5, 5, 5, 5], O: [2, 5, 5, 5, 2], P: [6, 5, 6, 4, 4], Q: [2, 5, 5, 6, 3], R: [6, 5, 6, 5, 5],
  S: [3, 4, 2, 1, 6], T: [7, 2, 2, 2, 2], U: [5, 5, 5, 5, 7], V: [5, 5, 5, 5, 2], W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5],
  Y: [5, 5, 2, 2, 2], Z: [7, 1, 2, 4, 7], 0: [7, 5, 5, 5, 7], 1: [2, 6, 2, 2, 7], 2: [6, 1, 2, 4, 7], 3: [6, 1, 2, 1, 6],
  4: [5, 5, 7, 1, 1], 5: [7, 4, 6, 1, 6], 6: [3, 4, 7, 5, 7], 7: [7, 1, 2, 2, 2], 8: [7, 5, 7, 5, 7], 9: [7, 5, 7, 1, 6],
  " ": [0, 0, 0, 0, 0], ".": [0, 0, 0, 0, 2], ",": [0, 0, 0, 2, 4], "!": [2, 2, 2, 0, 2], "?": [6, 1, 2, 0, 2], "'": [2, 2, 0, 0, 0],
  ":": [0, 2, 0, 2, 0], "-": [0, 0, 7, 0, 0], "/": [1, 1, 2, 4, 4], "(": [1, 2, 2, 2, 1], ")": [4, 2, 2, 2, 4], "+": [0, 2, 7, 2, 0],
};
const C = {
  wall: [44, 46, 62], wallEdge: [74, 76, 100], floor: [126, 118, 102], grid: [113, 105, 91], gate: [135, 85, 40], plank: [100, 60, 28],
  exit: [60, 220, 110], exitEdge: [20, 90, 40], player: [60, 130, 255], playerEdge: [15, 30, 80], dash: [160, 230, 255],
  wolf: [235, 140, 45], wolfEdge: [90, 50, 20], alpha: [150, 25, 25], alphaEdge: [55, 8, 8], windA: [255, 40, 40], windB: [255, 255, 255],
  stagger: [150, 150, 150], guard: [60, 170, 80], guardEdge: [20, 70, 30], potion: [255, 110, 190], coin: [250, 205, 40],
  coinEdge: [150, 110, 10], key: [255, 240, 60], keyEdge: [120, 90, 0], white: [255, 255, 255], text: [230, 230, 240],
  dim: [190, 190, 205], yellow: [255, 225, 110], hpBg: [70, 10, 10], hp: [230, 50, 50], box: [14, 14, 24], boxEdge: [200, 200, 220],
};

function screenshot() {
  const px = new Uint8Array(W * H * 4);
  const put = (x, y, c, a = 1) => {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    if (a >= 1) { px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; }
    else for (let k = 0; k < 3; k++) px[i + k] = Math.round(px[i + k] * (1 - a) + c[k] * a);
    px[i + 3] = 255;
  };
  const rect = (x, y, w, h, c, a = 1) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c, a); };
  const disc = (cx, cy, r, c, a = 1) => {
    for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) put(x, y, c, a);
    }
  };
  // pixels between radius r0 and r1 within ±deg of direction (fx, fy)
  const arc = (cx, cy, r0, r1, fx, fy, deg, c, a = 1) => {
    const cos = Math.cos((deg * Math.PI) / 180);
    for (let y = Math.floor(cy - r1 - 1); y <= cy + r1 + 1; y++) for (let x = Math.floor(cx - r1 - 1); x <= cx + r1 + 1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d = Math.hypot(dx, dy);
      if (d >= r0 && d <= r1 && (dx * fx + dy * fy) / d >= cos) put(x, y, c, a);
    }
  };
  const text = (s, x, y, scale, c) => {
    for (const ch of String(s).toUpperCase()) {
      const g = FONT[ch] || FONT["?"];
      for (let row = 0; row < 5; row++) for (let col = 0; col < 3; col++) if (g[row] & (4 >> col)) rect(x + col * scale, y + row * scale, scale, scale, c);
      x += 4 * scale;
    }
  };
  // tiles: dark walls (lit edges facing the floor), lighter floor with a subtle grid
  for (let ty = 0; ty < ROWS; ty++) for (let tx = 0; tx < COLS; tx++) {
    const x0 = tx * TILE, y0 = ty * TILE, c = grid[ty][tx];
    if (c === "#") {
      rect(x0, y0, TILE, TILE, C.wall);
      const open = (dx, dy) => { const nx = tx + dx, ny = ty + dy; return nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS && grid[ny][nx] !== "#"; };
      if (open(0, -1)) rect(x0, y0, TILE, 1, C.wallEdge);
      if (open(0, 1)) rect(x0, y0 + TILE - 1, TILE, 1, C.wallEdge);
      if (open(-1, 0)) rect(x0, y0, 1, TILE, C.wallEdge);
      if (open(1, 0)) rect(x0 + TILE - 1, y0, 1, TILE, C.wallEdge);
      continue;
    }
    rect(x0, y0, TILE, TILE, C.floor);
    rect(x0, y0, TILE, 1, C.grid);
    rect(x0, y0, 1, TILE, C.grid);
    if (c === "G") {   // the closed gate: a brown bar of planks with a yellow keyhole
      rect(x0 + 1, y0 + 3, TILE - 2, TILE - 6, C.gate);
      for (let i = 3; i < TILE - 1; i += 4) rect(x0 + i, y0 + 3, 1, TILE - 6, C.plank);
      rect(x0 + 7, y0 + 6, 2, 3, C.key);
    }
  }
  // things
  const t2 = Math.floor(time * 10) % 2;
  for (const t of things) {
    const x = t.x, y = t.y;
    if (t.type === "Exit") {
      for (let j = -8; j <= 8; j++) for (let i = -8; i <= 8; i++) { const m = Math.abs(i) + Math.abs(j); if (m <= 7) put(x + i, y + j, m >= 6 ? C.exitEdge : C.exit); }
    } else if (t.type === "Coin") { disc(x, y, 3.5, C.coinEdge); disc(x, y, 2.5, C.coin); }
    else if (t.type === "Potion") { disc(x, y + 1, 3.5, C.potion); rect(x - 1, y - 4, 2, 2, C.white); }
    else if (t.type === "Key") {   // ring + shaft + teeth (the notch)
      disc(x - 3, y, 3, C.keyEdge); disc(x - 3, y, 2.2, C.key); put(x - 3, y, C.keyEdge);
      rect(x - 1, y - 1, 7, 2, C.key); rect(x + 3, y + 1, 1, 2, C.key); rect(x + 5, y + 1, 1, 3, C.key);
    } else if (t.type === "Guard") {
      disc(x, y, 6.5, C.guardEdge); disc(x, y, 5.5, C.guard); rect(x - 3, y - 6, 6, 2, C.dim);
      if (!quest) text("!", x - 3, y - 20, 2, C.yellow);
    }
  }
  // the swing arc goes under the wolves, so the target stays visible
  const p = player, [fx, fy] = FACE[p.facing];
  if (!p.dead && p.swing > EPS) arc(p.x, p.y, 11, PLAYER.reach, fx, fy, PLAYER.arc, [255, 250, 190], 0.5);
  for (const w of things.filter(isWolf)) {
    const big = w.type === "AlphaWolf", r = big ? 8 : 6;
    let fill = big ? C.alpha : C.wolf;
    const edge = big ? C.alphaEdge : C.wolfEdge;
    if (w.state === "windup") { fill = t2 ? C.windB : C.windA; disc(w.x, w.y, r + 3.5, C.windA, 0.55); }
    else if (w.state === "stagger") fill = C.stagger;
    disc(w.x, w.y, r + 1, edge);
    disc(w.x, w.y, r, fill);
    if (w.state === "strike") disc(w.x, w.y, r + 2, C.white, 0.5);
    if (w.hp < w.maxHp) {
      const bw = big ? 18 : 14;
      rect(w.x - bw / 2, w.y - r - 6, bw, 3, C.hpBg);
      rect(w.x - bw / 2, w.y - r - 6, Math.round((bw * w.hp) / w.maxHp), 3, C.hp);
    }
  }
  // the player: blue circle, white facing tick, shield arc while blocking
  if (p.dead) {
    disc(p.x, p.y, 6.5, [60, 60, 70]);
    for (let i = -4; i <= 4; i++) { put(p.x + i, p.y + i, C.hp); put(p.x + i, p.y - i, C.hp); }
  } else {
    disc(p.x, p.y, 7, C.playerEdge);
    disc(p.x, p.y, 6, p.dash > EPS ? C.dash : C.player);
    for (let i = 2; i <= 9; i++) { put(p.x + fx * i, p.y + fy * i, C.white); put(p.x + fx * i + fy, p.y + fy * i + fx, C.white); }
    if (p.blocking) arc(p.x, p.y, 8.5, 11, fx, fy, 60, [225, 225, 240]);
  }
  // the HUD (hp bar and counters on the top wall row, notice or goal on the bottom one, banner, dialogue box), laid
  // out once by hudLayout() so the snapshot's state.ui lists exactly what is drawn
  for (const e of hudLayout()) {
    const [x, y] = e.rect;
    if (e.id === "hp") {
      rect(x, y, 62, 10, [0, 0, 0]);
      rect(x + 1, y + 1, 60, 8, C.hpBg);
      rect(x + 1, y + 1, Math.round((60 * Math.max(0, p.hp)) / p.maxHp), 8, C.hp);
    } else if (e.id === "banner") {
      rect(0, 16, W, H - 32, [0, 0, 0], 0.35);
      text(e.text, x, y, 4, p.dead ? C.hp : C.exit);
    } else if (e.id === "dialogue") {
      rect(x, y, e.rect[2], e.rect[3], C.boxEdge);
      rect(x + 1, y + 1, e.rect[2] - 2, e.rect[3] - 2, C.box);
    } else if (e.kind === "text") text(e.text, x, y, 2, e.color);
  }
  return { width: W, height: H, format: "rgba8", data: px };
}

const wrap = (s, n) => { const out = []; let line = ""; for (const w of s.split(" ")) { if (line && (line + " " + w).length > n) { out.push(line); line = w; } else line = line ? line + " " + w : w; } if (line) out.push(line); return out; };

/** The HUD as screen rects (the state.ui convention): drawn by screenshot(), listed in snapshot(). */
function hudLayout() {
  const p = player;
  const tw = (s, scale = 2) => String(s).length * 4 * scale - scale;   // the 3x5 font: 4 columns per glyph, no trailing gap
  const label = (id, s, x, y, color, scale = 2) => ({ id, kind: "text", rect: [x, y, tw(s, scale), 5 * scale], text: s, fontPx: 5 * scale, color });
  const hud = `${p.hp}/${p.maxHp}  POTIONS ${p.potions}  GOLD ${p.gold}${p.hasKey ? "  KEY" : ""}`;
  const ui = [
    { id: "hp", kind: "panel", rect: [3, 3, 62, 10] },
    label("counters", hud, 72, 3, C.text),
    notice ? label("notice", notice, 8, 275, C.yellow) : label("goal", `GOAL: ${goalText()}`, 8, 275, C.dim),
  ];
  if (p.dead || won) { const s = p.dead ? "YOU DIED" : "YOU ESCAPED!"; ui.push(label("banner", s, Math.round(W / 2 - (s.length * 16) / 2), 120, null, 4)); }
  if (dialogue) {
    const lines = wrap(dialogue.text, 56);
    const opts = dialogue.options.map((o, i) => `${i + 1}) ${o}`);
    const h = 14 + (1 + lines.length + opts.length) * 12;
    const y0 = 268 - h;
    ui.push({ id: "dialogue", kind: "panel", rect: [8, y0, W - 16, h] });
    ui.push(label("speaker", dialogue.speaker, 16, y0 + 7, C.yellow));
    lines.forEach((l, i) => ui.push(label(`line${i + 1}`, l, 16, y0 + 19 + i * 12, C.text)));
    opts.forEach((o, i) => ui.push(label(`option${i + 1}`, o, 24, y0 + 19 + (lines.length + i) * 12 + 2, [150, 210, 255])));
  }
  return ui;
}

// ------------------------------------------------------------------ calls (test setup)
const calls = {
  teleport: { args: "x y", help: "move the player to pixel x y; returns the new pos", run: (x, y) => { player.x = +x; player.y = +y; return pos(player); } },
  give: { args: "potion|coin|key [n]", help: "give the player items; returns the new count", run: (what, n = 1) => {
    const k = String(what).toLowerCase();
    if (k === "potion" || k === "potions") return (player.potions += +n);
    if (k === "coin" || k === "coins" || k === "gold") return (player.gold += +n);
    if (k === "key") return (player.hasKey = true);
    throw new Error(`give: unknown item '${what}' (potion, coin, key)`);
  } },
  sethp: { args: "n", help: "set the player's hp (0 kills)", run: (n) => {
    player.hp = Math.max(0, Math.min(player.maxHp, Math.round(+n)));
    if (player.hp <= 0 && !player.dead) die();
    return player.hp;
  } },
  kill: { args: "<id|type> ...", help: "kill wolves by id or type (Wolf, AlphaWolf, all); returns how many died", run: (...targets) => {
    let n = 0;
    for (const t of targets) {
      const s = String(t).toLowerCase();
      for (const w of things.filter(isWolf)) {
        if (String(w.id) === s || w.type.toLowerCase() === s || s === "all" || s === "wolves") { killWolf(w); n++; }
      }
    }
    return n;
  } },
  open: { help: "open the gate", run: () => openGate() },
};

reset({ seed: witness.seed() });
await witness.start({
  name: "Arena", fps: FPS, size: [W, H],
  keys: ["w", "a", "s", "d", "up", "down", "left", "right", "j", "space", "k", "l", "shift", "e", "q", "1", "2", "3", "enter", "escape"],
  reset, input, step, snapshot, screenshot, calls,
  scope: () => ({ player, things, grid, dialogue, quest, time, won, held }),
});

if (!witness.active()) { if (process.stdin.isTTY) playInTerminal(); else demo(); }

// ------------------------------------------------------------------ scripted real-time demo (no terminal: CI, pipes)
// Walks east out of the start room and swings once, with real (irregular) frame times. With WITNESS_RECORD set,
// 'witness replay' must land on exactly the position printed here.
function demo() {
  const script = [[0, "right", true], [0.5, "right", false], [0.5, "up", true], [0.8, "j", true], [0.85, "j", false], [0.9, "up", false]];
  const t0 = performance.now();
  let last = t0, next = 0, marked = false;
  const tick = () => {
    const now = performance.now(), t = (now - t0) / 1000, events = [];
    while (next < script.length && script[next][0] <= t) { const [, key, down] = script[next++]; events.push({ type: "key", key, down }); }
    if (!marked && t >= 0.5) { marked = true; witness.mark("F8"); }
    events.forEach(input);
    const dt = witness.recordFrame(Math.min((now - last) / 1000, 0.1), events);
    last = now;
    step(dt);
    if (t < 1.5) setTimeout(tick, 16 + (Math.floor(t * 1000) % 3));   // uneven on purpose
    else console.log(`demo done: player=(${player.x.toFixed(4)}, ${player.y.toFixed(4)}) facing=${player.facing} seed=${witness.seed()}`);
  };
  tick();
}

// ------------------------------------------------------------------ normal play (a terminal game)
function playInTerminal() {
  const KEYMAP = { "\u001b[A": "up", "\u001b[B": "down", "\u001b[C": "right", "\u001b[D": "left", w: "w", a: "a", s: "s", d: "d",
    j: "j", " ": "space", k: "k", l: "l", e: "e", q: "q", 1: "1", 2: "2", 3: "3", "\r": "enter", "\n": "enter", "\u001b": "escape" };
  const HOLD_MS = { up: 160, down: 160, left: 160, right: 160, w: 160, a: 160, s: 160, d: 160, k: 320 };   // others are taps
  const until = new Map();   // terminals send presses but no releases: hold each key briefly
  let pending = [], frame = 0;
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (k) => {
    if (k === "x" || k === "\u0003") quit();
    if (k === "m") { witness.mark("m"); say("(marked this moment)"); }
    const name = KEYMAP[k];
    if (!name) return;
    if (!held.has(name) && !until.has(name)) pending.push({ type: "key", key: name, down: true });
    until.set(name, performance.now() + (HOLD_MS[name] || 50));
  });
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    for (const [name, t] of until) if (now >= t) { until.delete(name); pending.push({ type: "key", key: name, down: false }); }
    const events = pending;
    pending = [];
    events.forEach(input);
    const dt = witness.recordFrame(Math.min((now - last) / 1000, 0.1), events);
    last = now;
    step(dt);
    if (frame++ % 3 === 0) draw();
  }, 1000 / FPS);
  function draw() {
    const cells = grid.map((r) => r.slice());
    const at = (t, ch) => { cells[Math.floor(t.y / TILE)][Math.floor(t.x / TILE)] = ch; };
    for (const t of things) {
      if (t.type === "Guard") at(t, "g");
      else if (t.type === "Potion") at(t, "p");
      else if (t.type === "Coin") at(t, "c");
      else if (t.type === "Key") at(t, "k");
    }
    for (const w of things.filter(isWolf)) at(w, w.state === "windup" ? "!" : w.state === "stagger" ? "z" : w.type === "AlphaWolf" ? "A" : "w");
    at(player, player.dead ? "%" : "@");
    const p = player, lines = [
      ` ARENA   hp ${p.hp}/${p.maxHp}   potions ${p.potions}   gold ${p.gold}   key ${p.hasKey ? "yes" : "no"}   facing ${p.facing}${p.blocking ? "  [blocking]" : ""}   deaths ${deaths}`,
      ` goal: ${goalText()}${notice ? `      ** ${notice} **` : ""}`,
      ...cells.map((r) => " " + r.join(" ")),
      dialogue ? ` ${dialogue.speaker}: "${dialogue.text}"` : " ",
      dialogue ? `   ${dialogue.options.map((o, i) => `${i + 1}) ${o}`).join("    ")}` : " ",
      ...recent.map((m) => ` · ${m}`),
      ` WASD/arrows move · j attack · k block · l dodge · e talk/open · q potion · 1/2 choose · enter respawn · x quits${witness.recording() ? " · recording (m marks)" : ""}`,
      " (! = a wolf winding up its bite: block with k facing it, or step away; z = staggered: hit it for double damage)",
    ];
    process.stdout.write(`\u001b[H\u001b[2J${lines.join("\n")}\n`);
  }
  function quit() {
    clearInterval(timer);
    process.stdout.write("\nbye\n");
    process.exit(0);
  }
}
