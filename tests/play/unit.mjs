// Witness play: unit tests (no processes). Order parser, target resolution, nav grid, recorder, config, perception,
// events, observations, the brief, and the autopilot driving a small simulated top-down world (no game needed).
import { parseOrders, resolveTarget, OrderError, splitChain } from "../../src/play/orders.js";
import { NavGrid } from "../../src/play/grid.js";
import { ReplayRecorder } from "../../src/play/recorder.js";
import { resolvePlayConfig, parseControl } from "../../src/play/config.js";
import { Perceiver } from "../../src/play/perceive.js";
import { EventTracker } from "../../src/play/events.js";
import { Autopilot } from "../../src/play/autopilot.js";
import { observeText } from "../../src/play/observe.js";
import { makeBrief } from "../../src/play/brief.js";
import { compass, editDistance, singular } from "../../src/play/util.js";
import { runFixTests } from "./fixes.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL", name, extra); } };
const P = (s) => parseOrders(s, { named: { attack: parseControl("j"), interact: parseControl("e") }, combos: { fireball: "down@0" } });
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return e instanceof OrderError && re.test(e.message); } };

// ---- order parser
let o = P("goto Gate")[0];
ok("order goto thing", o.verb === "goto" && o.target.words[0] === "Gate");
o = P("go north 5")[0]; ok("order go dir n", o.verb === "go" && o.dir === "N" && o.n === 5);
o = P("north 3")[0]; ok("order bare compass", o.verb === "go" && o.dir === "N" && o.n === 3);
o = P("walk to 12,5")[0]; ok("order goto coords", o.verb === "goto" && o.point[0] === 12 && o.point[1] === 5);
o = P("goto (12, 5)")[0]; ok("order goto (x, y)", o.point && o.point[1] === 5);
o = P("move east")[0]; ok("order move east", o.verb === "go" && o.dir === "E");
o = P("fight wolves block retreat 30%")[0]; ok("order fight plural block retreat", o.verb === "fight" && o.target.plural && o.mode === "block" && o.retreat === 30, JSON.stringify(o));
o = P("attack the nearest enemy")[0]; ok("order fight category", o.verb === "fight" && o.target.category === "hostile");
o = P("kill Wolf#5 aggressively")[0]; ok("order fight id", o.target.id === "5" && o.target.words[0] === "Wolf" && o.mode === "aggressive");
o = P("fight wolf retreat at 25")[0]; ok("order retreat at N", o.retreat === 25);
o = P("talk to the old guard")[0]; ok("order talk by name", o.verb === "talk" && o.target.words.join(" ") === "old guard");
o = P("choose 2")[0]; ok("order choose n", o.verb === "choose" && o.option === 2);
o = P("pick the second option")[0]; ok("order choose ordinal", o.verb === "choose" && o.option === 2, JSON.stringify(o));
o = P("answer 'get it back'")[0]; ok("order choose text", o.optionText === "get it back");
o = P("pick up all coins")[0]; ok("order pickup plural", o.verb === "pickup" && o.target.plural);
o = P("drink potion")[0]; ok("order drink → heal", o.verb === "use" && o.control === "heal");
o = P("press e x3")[0]; ok("order press xN", o.verb === "press" && o.control === "e" && o.times === 3);
o = P("hold k 1.5")[0]; ok("order hold seconds", o.verb === "hold" && o.seconds === 1.5);
o = P("wait 2")[0]; ok("order wait", o.verb === "wait" && o.seconds === 2);
o = P("wait for koopa")[0]; ok("order wait for", o.verb === "waitfor" && o.target.words[0] === "koopa");
o = P("set retreat 30%")[0]; ok("order set", o.verb === "set" && o.key === "retreat" && o.value === 30);
o = P("set guard off")[0]; ok("order set off", o.value === false);
ok("order chain", P("talk guard; choose 1 then pickup potion").length === 3);
ok("splitChain keeps coordinates", splitChain("goto 3,4; wait 1").length === 2);
ok("order did you mean", throws(() => P("atack wolf"), /did you mean "attack"/));
ok("order unknown verb", throws(() => P("dance wildly"), /unknown order/));
ok("order choose needs a number", throws(() => P("choose"), /which option/));
o = P("jump right long")[0]; ok("order jump", o.verb === "jump" && o.dir === "E" && o.size === "long");
o = P("run left to 40")[0]; ok("order run to x", o.verb === "run" && o.dir === "W" && o.toX === 40);
o = P("look at Red#6")[0]; ok("order look at", o.verb === "look" && o.target.id === "6");
o = P("explore north for 8s")[0]; ok("order explore for", o.verb === "explore" && o.dir === "N" && o.forS === 8);
o = P("please attack")[0]; ok("order filler + bare verb", o.verb === "fight" && !o.target);
o = P("fireball")[0]; ok("order bare combo name", o.verb === "combo" && o.name === "fireball");
o = P("open the gate")[0]; ok("order open → interact", o.verb === "interact" && o.target.words[0] === "gate");
o = P("fight nearest enemy hold")[0]; ok("order fight hold (fps: no chasing)", o.verb === "fight" && o.mode === "hold" && o.target.category === "hostile");
o = P("press block")[0]; ok("order press keeps control names that look like modifiers", o.verb === "press" && o.control === "block");
o = P("respawn")[0]; ok("order respawn", o.verb === "respawn");

// ---- target resolution
const th = (id, type, rel, dist, extra = {}) => ({ id, type, rel, dist, key: `${type}#${id}`, name: null, p2: [dist, 0], dead: false, ...extra });
const world = { things: [th(3, "Wolf", "hostile", 4), th(5, "Wolf", "hostile", 2), th(12, "AlphaWolf", "hostile", 6, { name: "Alpha Wolf" }), th(6, "Guard", "npc", 3, { name: "Old Guard" }), th(7, "Potion", "item", 1)], remembered: [th(9, "Gate", "neutral", 15)] };
const R = (s, o2) => resolveTarget(P(`goto ${s}`)[0].target, world, o2).things;
ok("resolve exact type beats substring", R("wolf").every((t) => t.type === "Wolf") && R("wolf")[0].id === 5);
ok("resolve prefix", R("alpha")[0].type === "AlphaWolf");
ok("resolve by name", R("old guard")[0].id === 6);
ok("resolve id", R("#3")[0].id === 3 && R("Wolf#3")[0].id === 3);
ok("resolve category", R("nearest enemy")[0].id === 5);
ok("resolve typo", R("wlof")[0].type === "Wolf");
ok("resolve remembered", R("gate")[0].id === 9);
const teamWorld = { things: [th(1, "Soldier", "friend", 3, { name: "Blue 1" }), th(4, "Soldier", "hostile", 5, { name: "Red 1" })], remembered: [] };
ok("resolve a name ending in a number (Red 1 is a name, not id 1)", resolveTarget(P("fight Red 1")[0].target, teamWorld, { prefer: "hostile" }).things[0].id === 4);
ok("resolve type + id still works", resolveTarget(P("fight Soldier 4")[0].target, teamWorld).things[0].id === 4);
ok("resolve missing lists what's in view", (() => { try { R("dragon"); return false; } catch (e) { return /in view: .*Wolf#5/.test(e.message); } })());

// ---- nav grid
const MAZE = [
  "##########",
  "#@...#...#",
  "#.##.#.#.#",
  "#.#..#.#.#",
  "#.#.##.#.#",
  "#......#X#",
  "##########",
];
const g = new NavGrid({ cell: 16 });
g.setMap({ cell: 16, origin: [0, 0], rows: MAZE, solid: "#" });
const path = g.astar([1, 1], [8, 5]);
ok("astar finds the maze path", path && path.length > 10, path && path.length);
ok("astar never crosses walls", path && path.every(([x, y]) => MAZE[y][x] !== "#"));
ok("astar no corner cutting", path && path.every((c, i) => i === 0 || Math.abs(c[0] - path[i - 1][0]) + Math.abs(c[1] - path[i - 1][1]) === 1 || (MAZE[path[i - 1][1]][c[0]] !== "#" && MAZE[c[1]][path[i - 1][0]] !== "#")));
ok("clearLine blocked by a wall", !g.clearLine(g.center([1, 1]), g.center([3, 3]), 5));
ok("clearLine open corridor", g.clearLine(g.center([1, 1]), g.center([4, 1]), 5));
const v0 = g.version; g.markBlocked([4, 3], "learned", 0); ok("learning a wall bumps the version", g.version > v0);
ok("map-open cell is only temporarily blocked", g.markBlocked([3, 3], "learned", 0) === "temp" && g.isBlocked(3, 3, 1) && !g.isBlocked(3, 3, 10));
g.visit(g.center([1, 1]), 2);
ok("frontier finds unseen ground", (() => { const f = g.frontier([1, 1]); return f && !g.seen.has(`${f[0]},${f[1]}`); })());
const g2 = new NavGrid({ cell: 1 });
ok("astar through unknown space", (g2.astar([0, 0], [5, 3]) || []).length === 6);

// ---- recorder
const rec = new ReplayRecorder({ name: "t", seed: 3, fps: 60 });
rec.add([{ frame: 0, type: "key", key: "d", down: true }, { frame: 10, type: "key", key: "d", down: false }, { frame: 10, type: "key", key: "d", down: true }, { frame: 99, type: "key", key: "j", down: false }]);
rec.mark(50, "bug: here"); rec.mark(60, "after the end"); rec.call(20, "teleport", [1, 2]);
const lines = rec.text(60).trim().split("\n").map((l) => JSON.parse(l));
ok("recorder header", lines[0].replay === 1 && lines[0].seed === 3 && lines[0].source === "witness play");
ok("recorder keeps in-frame order", JSON.stringify(lines.find((l) => l.f === 10).in.map((e) => e.down)) === "[false,true]");
ok("recorder drops events after the last frame", !lines.some((l) => l.f >= 60));
ok("recorder last frame line + clamped mark", lines.at(-1).f === 59 && /after the end/.test(lines.at(-1).mark));
ok("recorder calls", JSON.stringify(lines.find((l) => l.f === 20).calls) === '[["teleport",1,2]]');

// ---- config
let c = resolvePlayConfig({}, { keys: ["w", "a", "s", "d", "j", "e", "1", "2"] });
ok("config topdown defaults", c.profile === "topdown" && c.controls.move.up.key === "w" && c.controls.attack.key === "j" && c.controls.interact.key === "e" && c.controls.choose.mode === "numbers");
c = resolvePlayConfig({ profile: "platformer" }, { keys: ["left", "right", "up", "down", "z", "x", "w", "a", "s", "d"] });
ok("config platformer: arrows walk, z jumps, x runs", c.controls.move.right.key === "right" && !c.controls.move.up && c.controls.jump.key === "z" && c.controls.run.key === "x");
c = resolvePlayConfig({ profile: "fps" }, { keys: ["w", "a", "s", "d", "r", "1", "2"] });
ok("config fps: mouse fire, plane x/z", c.controls.attack.type === "mouse" && c.controls.attackMode === "hold" && c.plane[1] === 2 && c.controls.reload.key === "r");
ok("parseControl kinds", parseControl("action:jump").type === "action" && parseControl("pad:a").button === "a" && parseControl("mouse:right").button === 2 && parseControl("K").key === "k");

// ---- perception + events (an arena-like snapshot)
const mkSnap = (o2 = {}) => ({ frame: 0, time: 0, state: {
  scene: "arena", won: false, dead: false, goal: { text: "Talk to the Old Guard" }, notice: o2.notice ?? null,
  player: { id: 1, type: "Player", pos: [40, 40], hp: o2.hp ?? 10, maxHp: 10, facing: "E", potions: 1, gold: 2 },
  entities: [{ id: 1, type: "Player", pos: [40, 40] },
    ...(o2.noWolf ? [] : [{ id: 5, type: "Wolf", pos: [60, 40], hp: o2.wolfHp ?? 3, maxHp: 3, hostile: true, state: o2.wstate ?? "chase", telegraph: o2.tele ?? 0 }]),
    { id: 6, type: "Guard", name: "Old Guard", pos: [40, 90], talk: true, hostile: false },
    ...(o2.noCoin ? [] : [{ id: 7, type: "Coin", pos: [44, 40], item: true }])],
  dialogue: o2.dialogue ?? null,
  map: { cell: 16, origin: [0, 0], rows: MAZE, solid: "#" } } });
const pc = resolvePlayConfig({ controls: { block: "k" } }, { keys: ["w", "a", "s", "d", "j", "e"] });
const per = new Perceiver(pc, { fps: 60 });
const w0 = per.perceive(mkSnap(), 0);
ok("perceive player + cell from the map", w0.player.hp === 10 && w0.cell === 16 && w0.player.p2[0] === 40);
ok("perceive classification", w0.things.find((t) => t.type === "Wolf").rel === "hostile" && w0.things.find((t) => t.type === "Guard").rel === "npc" && w0.things.find((t) => t.type === "Coin").rel === "item");
ok("perceive stats", w0.stats.some((s) => s.label === "potions" && s.value === 1) && w0.stats.some((s) => s.label === "gold"));
ok("perceive distances in cells + compass", Math.abs(w0.things.find((t) => t.type === "Wolf").dist - 1.25) < 1e-9 && w0.things.find((t) => t.type === "Guard").dir === "S");
const w1 = per.perceive(mkSnap({ tele: 0.4, wstate: "windup" }), 6);
ok("perceive telegraph seconds", w1.things.find((t) => t.type === "Wolf").telegraph && w1.things.find((t) => t.type === "Wolf").tele === 0.4);
const per2 = new Perceiver(resolvePlayConfig({}, {}), { fps: 60 });
const wn = per2.perceive({ frame: 0, state: { player: { pos: [0, 0] }, entities: [{ id: 2, type: "Skeleton", pos: [1, 0] }, { id: 3, type: "Medkit", pos: [2, 0] }] } }, 0);
ok("perceive name heuristics without fields", wn.things[0].rel === "hostile" && wn.things[1].rel === "item");
const wt = per2.perceive({ frame: 0, state: { player: { pos: [0, 0, 0], team: "blue" }, entities: [{ id: 2, type: "Soldier", team: "red", pos: [1, 0, 0] }, { id: 3, type: "Soldier", team: "blue", pos: [2, 0, 0] }] } }, 0);
ok("perceive teams", wt.things[0].rel === "hostile" && wt.things[1].rel === "friend");
const wd = per.perceive(mkSnap({ dialogue: { speaker: "Old Guard", text: "Hi", choices: [{ text: "Yes" }, "No"] } }), 7);
ok("perceive dialogue normalised", wd.dialogue.speaker === "Old Guard" && wd.dialogue.options.join("|") === "Yes|No");

const per3 = new Perceiver(pc, { fps: 60 });
const tr = new EventTracker(pc, per3);
let pw = per3.perceive(mkSnap(), 0); tr.update(null, pw, {});
let nw = per3.perceive(mkSnap({ tele: 0.5, wstate: "windup" }), 6); let ev = tr.update(pw, nw, {}); pw = nw;
nw = per3.perceive(mkSnap({ wstate: "strike", hp: 8 }), 36); ev = tr.update(pw, nw, {}); pw = nw;
ok("events hurt with source", ev.some((e) => e.kind === "hurt" && /Wolf#5/.test(e.text) && /10→8/.test(e.text)), JSON.stringify(ev));
nw = per3.perceive(mkSnap({ wstate: "recover", hp: 8, noCoin: true }), 60); ev = tr.update(pw, nw, {}); pw = nw;
ok("events pickup", ev.some((e) => e.kind === "pickup" && /Coin#7/.test(e.text)));
ok("events telegraph hit counted", tr.tele.windups === 1 && tr.tele.hits === 1, JSON.stringify(tr.tele));
nw = per3.perceive(mkSnap({ hp: 8, wolfHp: 1, noCoin: true }), 70); ev = tr.update(pw, nw, { lastAttackT: 70 / 60 }); pw = nw;
ok("events you hit", ev.some((e) => e.kind === "hit" && /you hit Wolf#5/.test(e.text)));
nw = per3.perceive(mkSnap({ hp: 8, noWolf: true, noCoin: true, dialogue: { speaker: "Old Guard", text: "Thanks", options: ["Bye"] } }), 80); ev = tr.update(pw, nw, {}); pw = nw;
ok("events kill + dialogue", ev.some((e) => e.kind === "kill") && ev.some((e) => e.kind === "dialogue"));
tr.finish(2);
ok("fight tracked as won", tr.fights.length === 1 && tr.fights[0].result === "won" && tr.fights[0].taken === 2, JSON.stringify(tr.fights));
{
  // a corpse kept as state "dead" and removed seconds later must not count as a second kill or open a phantom fight
  const perD = new Perceiver(pc, { fps: 60 }), trD = new EventTracker(pc, perD);
  const snapD = (o2) => { const s = mkSnap({ noCoin: true, ...o2 }); if (o2.corpse) Object.assign(s.state.entities.find((e) => e.id === 5), { hp: 0, state: "dead" }); return s; };
  let a = perD.perceive(snapD({}), 0); trD.update(null, a, {});
  let b = perD.perceive(snapD({ wolfHp: 1 }), 10); trD.update(a, b, { lastAttackT: 10 / 60 }); a = b;
  b = perD.perceive(snapD({ corpse: true }), 20); trD.update(a, b, { lastAttackT: 20 / 60 }); a = b;
  for (let f = 30; f < 400; f += 30) { b = perD.perceive(snapD({ corpse: true }), f); trD.update(a, b, {}); a = b; }
  b = perD.perceive(snapD({ noWolf: true }), 420); const evD = trD.update(a, b, { lastAttackT: 420 / 60 }); a = b;
  trD.finish(8);
  ok("a corpse removed later is not a second kill", trD.kills.length === 1 && !evD.some((e) => e.kind === "kill"), JSON.stringify(trD.kills));
  ok("a corpse removed later opens no phantom fight", trD.fights.length === 1 && trD.fights[0].result === "won", JSON.stringify(trD.fights));
}
ok("game logs become events", new EventTracker(pc, per3).update(pw, pw, { logs: [{ level: "info", message: "You found a secret" }, { level: "error", message: "boom" }] }).map((e) => e.kind).join() === "log,error");

// ---- observation + brief
const grid0 = new NavGrid({ cell: 16 }); grid0.setMap(w0.map);
const txt = observeText(w0, { cfg: pc, grid: grid0, ap: null, result: { line: "✔ done: test" }, events: [], first: true, session: { goal: "escape" } });
ok("observation shows hp, goal, near, map, orders", /hp 10\/10/.test(txt) && /goal: Talk to the Old Guard/.test(txt) && /Wolf#5\s+1\.3 E\s+hp 3\/3/.test(txt) && /map \(/.test(txt) && /orders:/.test(txt), txt);
ok("observation stays small", txt.length < 2400, txt.length);
const br = makeBrief({ cli: 'node "C:/w/bin/witness.js"', configDir: "C:/game", name: "t7", goal: "win", persona: "breaker", minutes: 3, model: "haiku" });
ok("brief has the exact commands", br.includes('node "C:/w/bin/witness.js" play start --name t7 --config "C:/game" --goal "win" --persona breaker --model haiku') && br.includes("play end -s t7") === false && br.includes('./t7 end --fun') && br.includes('./t7 "<orders>"') && /bug hunter/.test(br));
ok("util compass/editDistance/singular", compass([1, -1]) === "NE" && compass([0, 1]) === "S" && editDistance("atack", "attack") === 1 && singular("wolves") === "wolf" && singular("enemies") === "enemy");

// ---- the autopilot in a simulated top-down world (no game process)
const SIM_MAP = [
  "####################",
  "#.....#............#",
  "#.###.#.#########..#",
  "#.#...#.#.......#..#",
  "#.#.###.#.#####.#..#",
  "#.#.....#.#........#",
  "#.#######.#.#.######",
  "#.........#.#......#",
  "####################",
];
function simWorld({ wolf = false, mortal = false } = {}) {
  const S = { frame: 0, t: 0, p: [24, 24], keys: new Set(), facing: "E", hp: 10, blocking: false, queue: [],
    wolf: wolf ? { pos: [24 + 40, 24], state: "idle", timer: 0, hp: 3 } : null };
  const solid = (x, y) => { const c = Math.floor(x / 16), r = Math.floor(y / 16); return !SIM_MAP[r] || SIM_MAP[r][c] !== "."; };
  const hits = (x, y) => solid(x - 5, y - 5) || solid(x + 5, y - 5) || solid(x - 5, y + 5) || solid(x + 5, y + 5);
  S.step = () => {
    for (const e of S.queue.filter((e) => e.frame <= S.frame)) if (e.type === "key") e.down ? S.keys.add(e.key) : S.keys.delete(e.key);
    S.queue = S.queue.filter((e) => e.frame > S.frame);
    const dx = (S.keys.has("d") ? 1 : 0) - (S.keys.has("a") ? 1 : 0), dy = (S.keys.has("s") ? 1 : 0) - (S.keys.has("w") ? 1 : 0);
    S.blocking = S.keys.has("k");
    if (mortal && S.wolf && S.keys.has("j") && !S.wasJ && Math.hypot(S.wolf.pos[0] - S.p[0], S.wolf.pos[1] - S.p[1]) < 28) { S.wolf.hp--; if (S.wolf.hp <= 0) S.wolf = null; }
    S.wasJ = S.keys.has("j");
    const l = Math.hypot(dx, dy) || 1, v = (S.blocking ? 40 : 80) / 60;
    if (dx) S.facing = dx > 0 ? "E" : "W"; else if (dy) S.facing = dy > 0 ? "S" : "N";
    const nx = S.p[0] + (dx / l) * v; if (!hits(nx, S.p[1])) S.p[0] = nx;
    const ny = S.p[1] + (dy / l) * v; if (!hits(S.p[0], ny)) S.p[1] = ny;
    const W = S.wolf;
    if (W) {
      const d = Math.hypot(W.pos[0] - S.p[0], W.pos[1] - S.p[1]);
      if (W.state === "idle" && d < 80) W.state = "chase";
      if (W.state === "chase") { if (d < 20) { W.state = "windup"; W.timer = 0.5; } else { W.pos[0] += ((S.p[0] - W.pos[0]) / d) * 0.8; W.pos[1] += ((S.p[1] - W.pos[1]) / d) * 0.8; } }
      else if (W.state === "windup") { W.timer -= 1 / 60; if (W.timer <= 0) { const facingOk = { E: W.pos[0] > S.p[0], W: W.pos[0] < S.p[0], S: W.pos[1] > S.p[1], N: W.pos[1] < S.p[1] }[S.facing]; if (d < 26) { if (S.blocking && facingOk) W.state = "stagger"; else { S.hp -= 2; W.state = "recover"; } } else W.state = "recover"; W.timer = 0.6; } }
      else { W.timer -= 1 / 60; if (W.timer <= 0) W.state = "chase"; }
    }
    S.frame++; S.t = S.frame / 60;
  };
  S.snap = () => ({ frame: S.frame, time: S.t, state: { player: { id: 1, type: "Player", pos: [...S.p], hp: S.hp, maxHp: 10, facing: S.facing },
    entities: S.wolf ? [{ id: 2, type: "Wolf", pos: [...S.wolf.pos], hp: S.wolf.hp, maxHp: 3, hostile: true, state: S.wolf.state, telegraph: S.wolf.state === "windup" ? S.wolf.timer : 0 }] : [],
    map: S.useMap ? { cell: 16, origin: [0, 0], rows: SIM_MAP, solid: "#" } : undefined } });
  return S;
}
function drive(S, cfgRaw, orderText, maxFrames = 3600) {
  const cfg = resolvePlayConfig(cfgRaw, { keys: ["w", "a", "s", "d", "j", "k", "e"] });
  if (!S.useMap) cfg.cell = 16;
  const per4 = new Perceiver(cfg, { fps: 60 });
  let w = per4.perceive(S.snap(), 0);
  const grid = new NavGrid({ cell: w.cell, origin: [0, 0] });
  const ap = new Autopilot(cfg, { fps: 60, grid, perceiver: per4, size: [320, 144] });
  ap.observe(w);
  ap.setOrders(parseOrders(orderText, { named: cfg.named }));
  let status = "run", msg = "";
  while (S.frame < maxFrames) {
    const d = ap.decide(w);
    S.queue.push(...ap.ctrl.emit(d.want, S.frame));
    if (d.status !== "run") { status = d.status; msg = d.message; break; }
    for (let i = 0; i < Math.max(1, d.k); i++) S.step();
    w = per4.perceive(S.snap(), S.frame);
    ap.observe(w);
  }
  return { status, msg, ap, t: S.t };
}
let S1 = simWorld(); S1.useMap = true;
let r = drive(S1, { controls: { move: "wasd" } }, "goto 18,7");
ok("autopilot reaches a goal through a maze (map known)", r.status === "done" && Math.floor(S1.p[0] / 16) === 18 && Math.floor(S1.p[1] / 16) === 7, `${r.status} ${r.msg} at ${S1.p} t=${r.t}`);
ok("autopilot: no unresolved stuck with a map", r.ap.incidents.filter((i) => !i.resolved).length === 0, JSON.stringify(r.ap.incidents));
S1 = simWorld(); S1.useMap = false;
r = drive(S1, { controls: { move: "wasd" }, map: false }, "goto 18,7", 60 * 90);
ok("autopilot learns walls and still gets through the maze (no map)", r.status === "done" && Math.floor(S1.p[0] / 16) === 18, `${r.status} ${r.msg} at ${S1.p.map((x) => x.toFixed(1))} t=${r.t.toFixed(1)} learned=${r.ap.grid.learned.size}`);
{
  // a target that leaves the view (goes indoors) reads as "went out of view (last seen at …)", not "lost track"
  const SV = simWorld(); SV.useMap = true;
  const snap0 = SV.snap;
  SV.snap = () => { const s = snap0(); s.state.entities.push({ id: 8, type: "Sign", pos: [280, 120] }); /* something far stays listed, so a near thing that vanished is known gone */ if (SV.frame < 10) s.state.entities.push({ id: 9, type: "Villager", pos: [24, 120], talk: true, hostile: false }); return s; };
  const rv = drive(SV, { controls: { move: "wasd" } }, "goto Villager", 60 * 20);
  ok("a target that went out of view says where it was last seen", rv.status === "fail" && /Villager#9 went out of view \(last seen at cell \(1,7\)/.test(rv.msg), `${rv.status} ${rv.msg}`);
  const gw = new NavGrid({ cell: 1 });
  gw.setMap({ cell: 1, origin: [0, 0], rows: ["...", "..."], solid: "#" });
  const fixed = gw.windowed;
  gw.setMap({ cell: 1, origin: [1, 0], rows: ["...", "..#"], solid: "#" });
  ok("a map window that follows the player is flagged (coverage % is then labelled)", !fixed && gw.windowed && gw.openCells() === 7, `${fixed} ${gw.windowed} ${gw.openCells()}`);
}
{
  // autofight: a wolf that comes at you during a goto is fought on the spot, then the goto carries on to its goal
  const SA = simWorld({ wolf: true, mortal: true }); SA.useMap = true;
  const ra = drive(SA, { controls: { move: "wasd", attack: "j", block: "k" }, reaction: 0.25 }, "goto 18,7", 60 * 60);
  const evA = ra.ap.drainEvents().map((e) => e.text).join(" | ");
  ok("autofight: the goto survives the wolf and still arrives", ra.status === "done" && /arrived at cell \(18,7\)/.test(ra.msg) && !SA.wolf, `${ra.status} ${ra.msg} wolf=${JSON.stringify(SA.wolf)}`);
  ok("autofight: engaged and resumed the goto (reported as events)", /fighting it, then back to goto 18,7/.test(evA) && /back to goto 18,7/.test(evA.split("fighting it")[1] || ""), evA);
  ok("autofight: the fight isn't the order's result", ra.ap.results.length === 1 && /goto 18,7/.test(ra.ap.results[0].order), JSON.stringify(ra.ap.results));
  const SB = simWorld({ wolf: true, mortal: true }); SB.useMap = true;
  const rb = drive(SB, { controls: { move: "wasd", attack: "j", block: "k" }, reaction: 0.25 }, "set autofight off; goto 18,7", 60 * 60);
  ok("set autofight off: no autofight events", !/fighting it/.test(rb.ap.drainEvents().map((e) => e.text).join(" ")) && /autofight off/.test(rb.ap.results[0]?.msg || ""), JSON.stringify(rb.ap.results));
}
{
  // live mode's standing behaviour: nothing ordered, a wolf comes at you, the autopilot guards and fights back
  const SS = simWorld({ wolf: true, mortal: true }); SS.useMap = true;
  const cfgS = resolvePlayConfig({ controls: { move: "wasd", attack: "j", block: "k" }, reaction: 0.25 }, { keys: ["w", "a", "s", "d", "j", "k", "e"] });
  const perS = new Perceiver(cfgS, { fps: 60 });
  let wS = perS.perceive(SS.snap(), 0);
  const apS = new Autopilot(cfgS, { fps: 60, grid: new NavGrid({ cell: wS.cell, origin: [0, 0] }), perceiver: perS, size: [320, 144] });
  apS.standingMode = true; apS.observe(wS);
  const statuses = new Set();
  while (SS.frame < 60 * 8) {
    const d = apS.decide(wS); statuses.add(d.status);
    SS.queue.push(...apS.ctrl.emit(d.want, SS.frame));
    for (let i = 0; i < Math.max(1, d.k); i++) SS.step();
    wS = perS.perceive(SS.snap(), SS.frame); apS.observe(wS);
  }
  ok("standing (live, no order): keeps running, guards and fights back", [...statuses].join() === "run" && !SS.wolf && SS.hp >= 8 && !apS.busy() && apS.activeOrder() == null, `${[...statuses]} wolf=${JSON.stringify(SS.wolf)} hp=${SS.hp}`);
}
S1 = simWorld({ wolf: true }); S1.useMap = true;
r = drive(S1, { controls: { move: "wasd", attack: "j", block: "k" }, reaction: 0.25 }, "wait 4");
ok("guard reflex blocks a telegraphed bite after the reaction delay", S1.hp === 10 && S1.wolf.state !== "idle", `hp ${S1.hp} wolf ${S1.wolf.state}`);
S1 = simWorld({ wolf: true }); S1.useMap = true;
r = drive(S1, { controls: { move: "wasd", attack: "j", block: "k" }, reaction: 0.6 }, "wait 4");
ok("a slow reaction (0.6s > 0.5s windup) gets bitten", S1.hp < 10, `hp ${S1.hp}`);

// ---- platformer profile in a simulated side-view world: a gap, a 2-high wall, a stompable enemy
const PLAT = [
  "................................................",
  "................................................",
  "................................................",
  "................................................",
  "..........................##....................",
  "..........................##....................",
  "##########...#####################...###########",
  "##########...#####################...###########",
];
function platWorld() {
  const T = 16, S = { frame: 0, x: 40, y: 6 * T - 8, vx: 0, vy: 0, keys: new Set(), onGround: true, dead: false, queue: [], jumpHeld: 0, prevJump: false,
    enemy: { x: 20 * T, y: 6 * T - 8, alive: true, vx: -0.4 } };
  const solid = (px, py) => { const c = Math.floor(px / T), r = Math.floor(py / T); if (r < 0) return false; if (r >= PLAT.length) return false; return (PLAT[r][c] || ".") === "#"; };
  S.step = () => {
    for (const e of S.queue.filter((e) => e.frame <= S.frame)) if (e.type === "key") e.down ? S.keys.add(e.key) : S.keys.delete(e.key);
    S.queue = S.queue.filter((e) => e.frame > S.frame);
    if (S.dead) { S.frame++; return; }
    const run = S.keys.has("x"), max = run ? 2.4 : 1.4, dir = (S.keys.has("right") ? 1 : 0) - (S.keys.has("left") ? 1 : 0);
    S.vx += dir * 0.12; if (!dir) S.vx *= 0.85; S.vx = Math.max(-max, Math.min(max, S.vx));
    const jump = S.keys.has("z");
    if (jump && !S.prevJump && S.onGround) { S.vy = -4.6; S.onGround = false; }
    S.prevJump = jump;
    S.vy += jump && S.vy < 0 ? 0.2 : 0.5; S.vy = Math.min(S.vy, 5);
    const nx = S.x + S.vx;
    if (!solid(nx + 6 * Math.sign(S.vx || 1), S.y) && !solid(nx + 6 * Math.sign(S.vx || 1), S.y - 6)) S.x = nx; else S.vx = 0;
    const ny = S.y + S.vy;
    if (S.vy > 0 && (solid(S.x - 5, ny + 8) || solid(S.x + 5, ny + 8))) { S.y = Math.floor((ny + 8) / T) * T - 8; S.vy = 0; S.onGround = true; }
    else { S.y = ny; S.onGround = false; }
    if (S.y > PLAT.length * T + 32) S.dead = true;
    const E = S.enemy;
    if (E.alive) {
      E.x += E.vx;
      if (Math.abs(E.x - S.x) < 12 && Math.abs(E.y - S.y) < 14) { if (S.vy > 0 && S.y < E.y - 4) { E.alive = false; S.vy = -3; } else S.dead = true; }
    }
    S.frame++;
  };
  S.snap = () => ({ frame: S.frame, state: { dead: S.dead,
    player: { id: 1, type: "Player", pos: [S.x, S.y], size: [12, 16], vel: [S.vx, S.vy], onGround: S.onGround },
    entities: S.enemy.alive ? [{ id: 2, type: "Goomba", pos: [S.enemy.x, S.enemy.y], size: [12, 14], hostile: true, stompable: true }] : [],
    map: { cell: 16, origin: [0, 0], rows: PLAT, solid: "#" } } });
  return S;
}
{
  const S2 = platWorld();
  const cfg = resolvePlayConfig({ profile: "platformer", controls: { move: { left: "left", right: "right" }, jump: "z", run: "x" } }, { keys: ["left", "right", "z", "x"] });
  const per5 = new Perceiver(cfg, { fps: 60 });
  let w = per5.perceive(S2.snap(), 0);
  const ap = new Autopilot(cfg, { fps: 60, grid: new NavGrid({ cell: 16 }), perceiver: per5 });
  ap.observe(w);
  ap.setOrders(parseOrders("run right to 44"));
  let st = "run", msg = "";
  while (S2.frame < 60 * 30 && !S2.dead) {
    const d = ap.decide(w);
    S2.queue.push(...ap.ctrl.emit(d.want, S2.frame));
    if (d.status !== "run") { st = d.status; msg = d.message; break; }
    for (let i = 0; i < Math.max(1, d.k); i++) S2.step();
    w = per5.perceive(S2.snap(), S2.frame); ap.observe(w);
  }
  ok("platformer: runs right over a gap, a wall and an enemy without dying", st === "done" && !S2.dead && Math.floor(S2.x / 16) >= 43, `${st} ${msg} x=${(S2.x / 16).toFixed(1)} dead=${S2.dead} enemy=${S2.enemy.alive}`);
  ok("platformer: the stompable enemy got stomped (or jumped)", !S2.dead && (!S2.enemy.alive || S2.x > S2.enemy.x));
}

// ---- fps profile: mouse sensitivity calibration, aiming at a target, firing when on target
{
  const F = { frame: 0, pos: [0, 0, 0], yaw: 0, pitch: 0, mouse: [160, 90], queue: [], firing: false, shots: 0, target: { pos: [6, 0, -6], hp: 100 } };
  const sens = 0.0011;
  F.step = () => {
    for (const e of F.queue.filter((e) => e.frame <= F.frame)) {
      if (e.type === "mouse") { if (e.button === 0 && e.down !== undefined) F.firing = e.down; F.yaw += (e.x - F.mouse[0]) * sens; F.pitch = Math.max(-1.5, Math.min(1.5, F.pitch - (e.y - F.mouse[1]) * sens)); F.mouse = [e.x, e.y]; }
    }
    F.queue = F.queue.filter((e) => e.frame > F.frame);
    if (F.firing) {
      F.shots++;
      const dx = F.target.pos[0] - F.pos[0], dz = F.target.pos[2] - F.pos[2];
      const want = Math.atan2(dx, -dz);
      if (Math.abs(((want - F.yaw + Math.PI) % (2 * Math.PI)) - Math.PI) < 0.08) F.target.hp -= 2;
    }
    F.frame++;
  };
  F.snap = () => ({ frame: F.frame, state: { player: { id: 0, type: "Player", team: "blue", pos: [...F.pos], yaw: F.yaw, pitch: F.pitch, hp: 100, maxHp: 100, ammo: 30 },
    entities: F.target.hp > 0 ? [{ id: 5, type: "Soldier", name: "Red 1", team: "red", pos: F.target.pos, hp: F.target.hp, los: true }] : [{ id: 5, type: "Soldier", name: "Red 1", team: "red", pos: F.target.pos, hp: 0, dead: true }] } });
  const cfg = resolvePlayConfig({ profile: "fps", cell: 1, fps: { eye: 1.6, aimHeight: 1.6, strafe: false } }, { keys: ["w", "a", "s", "d"] });
  const per6 = new Perceiver(cfg, { fps: 60 });
  let w = per6.perceive(F.snap(), 0);
  const ap = new Autopilot(cfg, { fps: 60, grid: new NavGrid({ cell: 1 }), perceiver: per6, size: [320, 180] });
  ap.observe(w);
  ap.setOrders(parseOrders("fight Red"));
  let st = "run";
  while (F.frame < 60 * 10) {
    const d = ap.decide(w);
    F.queue.push(...ap.ctrl.emit(d.want, F.frame));
    if (d.status !== "run") { st = d.status; break; }
    for (let i = 0; i < Math.max(1, d.k); i++) F.step();
    w = per6.perceive(F.snap(), F.frame); ap.observe(w);
  }
  ok("fps: calibrates the mouse, aims at the enemy and kills it", st === "done" && F.target.hp <= 0, `${st} hp=${F.target.hp} yaw=${F.yaw.toFixed(3)} shots=${F.shots} sens=${JSON.stringify(ap.profile.sens)}`);
  ok("fps: calibrated yaw sensitivity ≈ the game's", ap.profile.sens && Math.abs(ap.profile.sens.x - 0.0011) < 0.0002, JSON.stringify(ap.profile.sens));
}

{
  // team scores and the score limit reach the observation header
  const cfgS = resolvePlayConfig({ profile: "fps", plane: [0, 2], controls: { move: "wasd" } }, { keys: ["w", "a", "s", "d"] });
  const wS = new Perceiver(cfgS, { fps: 60 }).perceive({ frame: 0, time: 0, state: { player: { pos: [0, 0, 0], hp: 50 }, match: { score: { blue: 12, red: 9 }, scoreLimit: 40 }, entities: [] } }, 0);
  ok("team score with its limit is a stat", wS.stats.some((s) => s.label === "score" && s.value === "blue 12 - red 9 (to 40)"), JSON.stringify(wS.stats));
}

// ---- regressions from a real game's reports (Embervale)
runFixTests(ok);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
