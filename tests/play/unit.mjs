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
import { checkSnapshot, checkLines } from "../../src/play/check.js";
import { readGoals, testerArgs, batchMarkdown, blockedBy, blockedText, nudge, budgetText, batchLine } from "../../src/play/batch.js";
import { shimCommand } from "../../src/play/registry.js";
import { stuckSpots, reportMarkdown as reportMd } from "../../src/play/report.js";
import { UntilWatch, fmtHours } from "../../src/play/until.js";
import { PLAY_HELP } from "../../src/play/client.js";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

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
ok("brief has the exact commands", br.includes('node "C:/w/bin/witness.js" play start --name t7 --config "C:/game" --goal "win" --persona breaker --model haiku') && br.includes("play end -s t7") === false && br.includes(`${shimCommand("t7")} end --fun`) && br.includes(`order:  ${shimCommand("t7")} "<orders>"`) && /bug hunter/.test(br), br.slice(0, 1800));
ok("brief: no cd (dontAsk denies a cd outside the working folder): the short command by its absolute path", !/cd "/.test(br) && !/then, once/.test(br) && /[\\/]t7"?$/.test(shimCommand("t7")) && /no cd, nothing chained/.test(br), br.slice(0, 1800));
ok("brief: the budget is GAME time, by name", /BUDGET: about 3 minutes of GAME time/.test(br) && /BUDGET: about 3 minutes of GAME time/.test(makeBrief({ cli: "w", configDir: "C:/g", name: "t1", minutes: 3, live: true })));
// launch overrides (--device/--engine/…) reach the tester's start line and report.md's replay commands
{
  const { launchFlags } = await import("../../src/cli/common.js");
  const { reportMarkdown } = await import("../../src/play/report.js");
  const fl = launchFlags({ device: "iphone-15-landscape", engine: "webkit", "safe-insets": true, config: "witness.web.json" });
  ok("launchFlags: the launch overrides only", fl === " --device iphone-15-landscape --engine webkit --safe-insets", fl);
  const bl = makeBrief({ cli: "witness", configDir: "C:/game/witness.web.json", name: "t8", launch: fl });
  ok("brief: the start line carries the launch overrides", bl.includes('play start --name t8 --config "C:/game/witness.web.json" --device iphone-15-landscape --engine webkit --safe-insets'), bl.slice(0, 600));
  const rep = { session: "t1", outcome: "ended", seed: 1, frames: 60, gameSeconds: 1, wallSeconds: 2, stats: { orders: 0, ordersFailed: 0 }, replay: { file: "witness/playtests/t1/replay.jsonl" }, notes: [{ frame: 30, t: 0.5, text: "a coin" }], timeline: [], orders: [], errors: [], shots: [], deaths: [], dialogues: [], fights: [], stuck: [] };
  const md = reportMarkdown(rep, { config: "witness.web.json", flags: fl }).split("\n").filter((l) => l.startsWith("witness replay"));
  ok("report.md: replay commands carry --config and the launch overrides", md.length === 2 && md.every((l) => l.startsWith("witness replay --config witness.web.json --device iphone-15-landscape --engine webkit --safe-insets witness/playtests/t1/replay.jsonl")), md);
  const rec = new ReplayRecorder({ launch: { engine: "webkit", device: "iphone-15-landscape" } });
  ok("replay head records the browser it ran in", JSON.parse(rec.text(1).split("\n")[0]).launch.device === "iphone-15-landscape");
}
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
ok("autopilot: stuck incidents record the scene they happened in", r.ap.incidents.length > 0 && r.ap.incidents.every((i) => typeof i.sceneKey === "string" && "scene" in i), JSON.stringify(r.ap.incidents.slice(0, 2)));
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

// ---- play check: the playtest-ready checklist
{
  const bare = checkSnapshot({ player: { pos: [1, 1] }, entities: [{ id: 2, type: "Wolf", pos: [3, 1] }] });
  const by = (items, k) => items.find((i) => i.key === k);
  ok("check: a bare snapshot misses the map, facing, goal pos, doors, dialogue, outcome", ["map", "facing", "goal", "dialogue", "outcome"].every((k) => by(bare, k).ok === false) && by(bare, "player").ok === false && by(bare, "telegraph").ok === null, JSON.stringify(bare.map((i) => [i.key, i.ok])));
  const full = checkSnapshot({ player: { pos: [212.5, 30.5], hp: 80, facing: "N" }, dialogue: null, won: false, dead: false, goal: { text: "Clear the den", pos: [260, 12] },
    entities: [{ id: 4, type: "Guard", pos: [215, 28], talk: true }, { id: 76, type: "Wolf", pos: [230, 41], hostile: true, state: "windup" }, { id: 31, type: "Door", leadsTo: "Inn", pos: [220, 25] }, { id: 55, type: "Wolf", pos: [240, 12], hostile: true, objective: true }],
    map: { id: "w", cell: 1, origin: [192, 10], rows: Array(41).fill(".".repeat(41)), solid: "#" } });
  ok("check: the README example snapshot is playtest-ready", full.every((i) => i.ok === true), JSON.stringify(full.filter((i) => i.ok !== true).map((i) => i.key)));
  ok("check: local positions outside the map are flagged", checkSnapshot({ player: { pos: [5, 5], hp: 1 }, entities: [], map: { cell: 1, origin: [200, 200], rows: ["..."] } }).find((i) => i.key === "global").ok === false);
  ok("check: the text says what each missing item unlocks", /✖ a walkability map .*→ exact navigation/.test(checkLines(bare).join(" ")) && /missing/.test(checkLines(bare).at(-1)));
  ok("check: profile-specific items", checkSnapshot({}, "platformer").some((i) => i.key === "onGround") && checkSnapshot({}, "fps").some((i) => i.key === "look") && !checkSnapshot({}, "fps").some((i) => i.key === "facing"));
}

// ---- play batch: goals files, the claude command line, the summary file
{
  const tmpB = fs.mkdtempSync(nodePath.join(os.tmpdir(), "witness-batch-test-"));
  fs.writeFileSync(nodePath.join(tmpB, "g.txt"), ["Talk to the guard", "# skip me", "", "Fight the wolves", ""].join("\n"));
  fs.writeFileSync(nodePath.join(tmpB, "g.json"), JSON.stringify(["a", { goal: "b", persona: "explorer", minutes: 2 }, { persona: "x" }]));
  const gt = readGoals(nodePath.join(tmpB, "g.txt")), gj = readGoals(nodePath.join(tmpB, "g.json"));
  ok("batch: goals from a text file (comments and blanks skipped)", gt.length === 2 && gt[1].goal === "Fight the wolves");
  ok("batch: goals from JSON (strings or objects; no goal is skipped)", gj.length === 2 && gj[1].persona === "explorer" && gj[1].minutes === 2);
  const args = testerArgs({ model: "sonnet", effort: "low", cliJs: "C:/w/bin/witness.js", name: "b1-1" });
  const after = (f) => args[args.indexOf(f) + 1];
  ok("batch: claude -p with sonnet, low effort, Bash+Read only, dontAsk, no user settings or MCP", args[0] === "-p" && after("--model") === "sonnet" && after("--effort") === "low" && after("--tools") === "Bash,Read" && after("--permission-mode") === "dontAsk" && after("--setting-sources") === "project,local" && args.includes("--strict-mcp-config") && after("--output-format") === "json", args.join(" "));
  ok("batch: Bash is limited to the witness commands and the session's short command", args.includes('Bash(node "C:/w/bin/witness.js" play:*)') && args.includes("Bash(./b1-1:*)") && !args.some((a) => a === "Bash" || a === "Bash(*)" || /^Bash\(node:/.test(a)), args.join(" "));
  const md = batchMarkdown([{ i: 1, goal: "win | fast", persona: "newbie", dir: nodePath.join(tmpB, "b1-1"), report: { outcome: "won", gameSeconds: 41.2, stats: { orders: 5, kills: 4, deaths: 0, stuck: 0 }, notes: [{ kind: "bug", t: 3, text: "door" }], feedback: { fun: 3, text: "easy" } }, reply: "won" },
    { i: 2, goal: "lose", persona: "fighter", report: null, timedOut: true, code: null, stderr: "" }], { base: tmpB, model: "sonnet", effort: "low", minutes: 1 });
  ok("batch: the summary file has a row per tester, links next to it, feedback and notes", /\| 1 \| win \/ fast \| newbie \| won \| 41\.2 \| 5 \| 4 \| 0 \| 0 \| 1 \| 3 \| \[report\]\(b1-1\/report\.md\) \|/.test(md) && /no report \(timed out\)/.test(md) && /- bug at 3s: door/.test(md), md);
  // every command the brief tells the tester to run is allowed by a --allowedTools rule (prefix rules, as Claude Code matches them)
  const rules = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--add-dir")).filter((a) => a.startsWith("Bash(")).map((a) => a.slice(5, -1));
  const allowed = (cmd) => rules.some((x) => (x.endsWith(":*") ? cmd.startsWith(x.slice(0, -2)) : x.endsWith(" *") ? cmd.startsWith(x.slice(0, -1)) : cmd === x));
  const bb = makeBrief({ cli: 'node "C:/w/bin/witness.js"', configDir: "C:/game", name: "b1-1", goal: "win", live: true });
  const shown = bb.split("COMMANDS")[1].split("ORDERS")[0].split("\n").map((l) => /^\s+(start|order|look|next|screen|note|end):\s+(.+?)(\s{2,}\(.*)?$/.exec(l)).filter(Boolean).map((m) => m[2].replace("<orders>", "goto Inn").replace("<what you noticed>", "x"));
  ok("batch: every command in the brief is allowed (start, order, look, next, screen, note, end)", shown.length === 7 && shown.every(allowed), JSON.stringify(shown.filter((c) => !allowed(c))) + "\n" + rules.join("\n"));
  ok("batch: the quoted and ./ variants are allowed too; other commands aren't", allowed(`"${shimCommand("b1-1").replace(/"/g, "")}" look`) && allowed("./b1-1 look") && !allowed("ls /") && !allowed("node -e 1") && after("--add-dir").length > 3, rules.join("\n"));
  // a permission-blocked tester: from claude's JSON permission_denials, or its reply; not when it played
  const den = [{ tool_name: "Bash", tool_input: { command: 'cd "C:/T/witness-play" && ./long-explorer "goto Inn"' } }];
  ok("batch: blockedBy reads permission_denials", (blockedBy({ denials: den, report: { stats: { orders: 0 } } }) || {}).command === 'cd "C:/T/witness-play" && ./long-explorer "goto Inn"');
  ok("batch: blockedBy: a tester that played isn't blocked", blockedBy({ denials: den, report: { stats: { orders: 4 } } }) === null && blockedBy({ denials: [], reply: "done, won", report: null }) === null);
  ok("batch: blockedBy from the reply alone", (blockedBy({ denials: [], reply: "The command was denied by the permission mode, so I stopped." }) || {}).command === null);
  ok("batch: blocked outcome text", blockedText({ command: "cd x && ./t look" }) === "blocked: permission denied (cd x && ./t look)");
  ok("batch: the retry prompt names the exact allowed form", nudge("BRIEF", { command: "cd x" }, "b1-1").includes(`${shimCommand("b1-1")} "explore"`) && /`cd x` was denied/.test(nudge("BRIEF", { command: "cd x" }, "b1-1")));
  const mdB = batchMarkdown([{ i: 1, goal: "g", persona: "newbie", report: null, blocked: { command: "cd x && ./t look" }, firstBlock: { command: "cd x && ./t look" } }], { base: tmpB, model: "sonnet", effort: "low", minutes: 3 });
  ok("batch md: a blocked tester's row says so", /\| 1 \| g \| newbie \| blocked: permission denied \(cd x && \.\/t look\) \|/.test(mdB), mdB);
  ok("batch: budget text names units", budgetText({ minutes: 3 }) === "about 3 game minutes" && budgetText({ minutes: 3, gameHours: 4.5, wall: 20 }) === "4h30m of in-game time (hard stop after 20 wall min)");
  fs.rmSync(tmpB, { recursive: true, force: true });
}

// ---- help: --minutes is named as GAME time for brief/batch; start's wall-clock cap is --wall-minutes
ok("help: units named", /brief .*--minutes 4 \(GAME minutes\)/.test(PLAY_HELP) && /batch .*--minutes 3 \(GAME minutes\)\] \[--wall-minutes M\]/.test(PLAY_HELP) && /\[--wall-minutes 20\]/.test(PLAY_HELP) && !/\[--minutes 20\]/.test(PLAY_HELP), PLAY_HELP);

// ---- --until / --game-hours (pure)
{
  const sn = (h, extra = {}) => ({ frame: h * 60, time: h * 10, state: { day: 1, hour: h, ...extra } });
  ok("until: --game-hours needs a clock", (() => { try { new UntilWatch({ gameHours: 4 }); return false; } catch (e) { return /needs play\.clock/.test(e.message); } })());
  const u = new UntilWatch({ gameHours: 4.5, clock: "state.day*24 + state.hour" });
  u.start(sn(9));
  ok("until: the clock line at the start", u.line() === "⏲ clock 33h · 4h30m of in-game time to go (until clock 37.5h)", u.line());
  ok("until: not yet at 13h", u.check(sn(13)) === false && /30m of in-game time to go/.test(u.line()), u.line());
  ok("until: reached at 13.5h, and stays reached", u.check(sn(13.5)) === true && u.check(sn(9)) === true && /UNTIL REACHED \(the game clock reached 37\.5h \(4h30m of in-game time\)\): run END now/.test(u.line()), u.line());
  const v = new UntilWatch({ until: "state.hour >= 18" });
  v.start(sn(9));
  ok("until: an expression", v.check(sn(17)) === false && v.check(sn(18)) === true && v.hit.why === "state.hour >= 18 is true" && v.report().reached);
  ok("until: already true at the start is an error", (() => { try { new UntilWatch({ until: "state.hour >= 1" }).start(sn(9)); return false; } catch (e) { return /already reached at the start/.test(e.message); } })());
  ok("until: a missing path names the expression", (() => { try { new UntilWatch({ until: "state.nope.x > 1" }).start(sn(9)); return false; } catch (e) { return /--until "state\.nope\.x > 1"/.test(e.message); } })());
  ok("fmtHours", fmtHours(1.5) === "1h30m" && fmtHours(0.25) === "15m" && fmtHours(2) === "2h");
}

// ---- stuck incidents: a long run's 63 incidents become a few spots, each with one replay command
{
  const inc = [];
  const add = (n, cell, opts = {}) => { for (let i = 0; i < n; i++) inc.push({ t: 10 + inc.length * 7.3, cell: [cell[0] + (i % 3 === 2 ? 1 : 0), cell[1]], heading: i % 4 ? "N" : "E", seconds: 1.2, resolved: !(opts.unresolved && i === 3), how: "sidestepped", blocks: 2 }); };
  add(41, [172, -101], { unresolved: true }); add(15, [40, 12]); add(6, [-3, 77]); add(1, [100, 100]);
  inc.reverse();   // input order doesn't matter
  const sp = stuckSpots(inc);
  ok("stuck spots: 63 incidents → 4 spots, most first", sp.length === 4 && sp.map((x) => x.count).join() === "41,15,6,1" && sp[0].cell.join() === "172,-101" && sp[0].unresolved === 1 && sp[0].cells === 2, JSON.stringify(sp.map((x) => [x.cell, x.count, x.cells])));
  const unres = inc.find((x) => !x.resolved);
  ok("stuck spots: the replay moment is the unresolved incident", sp[0].replayAt === +(unres.t + 0.5).toFixed(2), JSON.stringify(sp[0]));
  const rep63 = { session: "long", outcome: "ended", seed: 1, frames: 60, gameSeconds: 600, wallSeconds: 2, stats: { orders: 0, ordersFailed: 0, stuck: 63 }, stuckSpots: sp, replay: { file: "witness/playtests/long/replay.jsonl" }, notes: [], timeline: [], orders: [], errors: [], shots: [], deaths: [], dialogues: [], fights: [], stuck: inc };
  const md63 = reportMd(rep63);
  const sec = md63.split("## Stuck incidents")[1].split("\n## ")[0];
  ok("report.md: the stuck section is a table of spots with one replay command each, not 63 lines", /63 incidents in \*\*4 spots\*\*/.test(sec) && (sec.match(/^\| \(/gm) || []).length === 4 && (sec.match(/witness replay witness\/playtests\/long\/replay\.jsonl --at/g) || []).length === 4 && !/^- \[/m.test(sec) && /\| \(172,-101\) \+1 near \| 41 \| 1 \|/.test(sec), sec);
  ok("report.md: the summary says how many spots, Reproduce lists the top 3", /stuck incidents 63 in 4 spots/.test(md63) && (md63.split("## Reproduce")[1].match(/# stuck spot/g) || []).length === 3, md63.split("## Reproduce")[1]);
  const md3 = reportMd({ ...rep63, stats: { ...rep63.stats, stuck: 3 }, stuck: inc.slice(0, 3), stuckSpots: stuckSpots(inc.slice(0, 3)) });
  ok("report.md: a few incidents are still listed one by one", (md3.split("## Stuck incidents")[1].split("\n## ")[0].match(/^- \[/gm) || []).length === 3);
}

// ---- 0.7.2 reviewer findings
{
  const sn = (snapState, time = 1) => ({ frame: 60, time, state: snapState });
  // play.clock set in witness.json, the game starts on a title screen without day/hour: a plain session still starts
  const pc = new UntilWatch({ clock: "state.day*24 + state.hour" });
  let err = null; try { pc.start(sn({ menu: "title" })); } catch (e) { err = e.message; }
  ok("until: play.clock alone doesn't fail the start when the clock can't be read yet", err === null && pc.line() === null, err);
  ok("until: the clock shows once it can be read", pc.check(sn({ day: 1, hour: 9 })) === false && pc.line() === "⏲ clock 33h", pc.line());
  // --game-hours: anchored lazily at the first finite reading
  const gl = new UntilWatch({ gameHours: 2, clock: "state.day*24 + state.hour" });
  err = null; try { gl.start(sn({ menu: "title" })); } catch (e) { err = e.message; }
  ok("until: --game-hours on a title screen starts; the line says the clock isn't readable yet", err === null && /not readable yet/.test(gl.line() || ""), `${err} ${gl.line()}`);
  ok("until: --game-hours anchors at the first reading", gl.check(sn({ day: 1, hour: 9 })) === false && gl.clock0 === 33 && gl.target === 35 && /2h of in-game time to go \(until clock 35h\)/.test(gl.line()), gl.line());
  ok("until: … and is reached 2 hours later", gl.check(sn({ day: 1, hour: 11 })) === true);
  ok("until: a non-number names NaN / undefined, not null", (() => { try { new UntilWatch({ clock: "state.hour" }).clockOf(sn({ hour: undefined })); return false; } catch (e) { return /got undefined/.test(e.message) && !/null/.test(e.message); } })()
    && (() => { try { new UntilWatch({ clock: "state.day*24" }).clockOf(sn({ day: "x" })); return false; } catch (e) { return /got NaN/.test(e.message); } })());
  // a clock that wraps at midnight: unwrapped (+24h), with a warning; any other backwards jump warns
  const wr = new UntilWatch({ gameHours: 4, clock: "state.hour" });
  wr.start(sn({ hour: 22 }));
  wr.check(sn({ hour: 23.5 })); wr.check(sn({ hour: 0.5 }));
  ok("until: a clock wrapping at midnight is unwrapped and warned about", wr.now === 24.5 && /went backwards|wrapped/.test(wr.line()) && /state\.day\*24/.test(wr.line()) && /1h30m of in-game time to go/.test(wr.line()), wr.line());
  ok("until: … --game-hours then finishes", wr.check(sn({ hour: 2 })) === true && wr.report().warning);
  const bk = new UntilWatch({ gameHours: 0.1, clock: "state.c" });
  bk.start(sn({ c: 0.25 })); bk.check(sn({ c: 0.29 })); bk.check(sn({ c: 0.01 }));
  ok("until: a clock dropping below its start warns", /went backwards/.test(bk.line()) && /include the day/.test(bk.line()), bk.line());
  ok("until: already reached suggests a day-based --until", (() => { try { new UntilWatch({ until: "state.hour >= 18" }).start(sn({ day: 1, hour: 20 })); return false; } catch (e) { return /already reached/.test(e.message) && /state\.day\*24 \+ state\.hour >= 66/.test(e.message); } })());

  // batch: the brief tells testers to single-quote note/feedback text (backticks and $ are denied or expand)
  const bq = makeBrief({ cli: 'node "C:/w/bin/witness.js"', configDir: "C:/game", name: "b1-1", goal: "win" });
  ok("brief: note and end feedback in single quotes, no backticks or $", /note:\s+\S+ note '<what you noticed>'/.test(bq) && /--feedback '<3-6 sentences>'/.test(bq) && /single quotes/.test(bq) && /backticks/.test(bq), bq.split("COMMANDS")[1].slice(0, 900));
  // batch: denials after the first order are still shown; a denied END is named
  const played = { i: 1, goal: "g", persona: "newbie", wallSec: 42, wall: 15, dir: "x", reply: "done",
    report: { outcome: "ended", gameSeconds: 30, stats: { orders: 4, kills: 0, deaths: 0, stuck: 0 }, notes: [], feedback: null },
    denials: [{ tool_name: "Bash", tool_input: { command: "/t/b1-1 note \"I liked `goto Inn`\" --fun" } }, { tool_name: "Bash", tool_input: { command: "/t/b1-1 end --fun 4 --feedback \"`goto` was great\"" } }] };
  const ln = batchLine(played);
  ok("batch line: denials shown even after orders; END denied named", /· 2 commands denied \(\/t\/b1-1 note/.test(ln) && /END was denied \(no feedback recorded\)/.test(ln), ln);
  ok("batch line: elapsed wall seconds, not the --wall-minutes cap", /· 42s wall$/.test(ln), ln);
  const mdD = batchMarkdown([played], { base: os.tmpdir(), model: "sonnet", effort: "low", minutes: 3 });
  ok("batch md: the denials are listed in the tester's section", /2 commands denied/.test(mdD) && /END was denied/.test(mdD), mdD);

  // stuck spots: the same cells in different scenes are different spots
  const sc = [{ t: 1, cell: [3, 4], heading: "N", seconds: 1, resolved: true, how: "x", scene: "Inn", sceneKey: '["Inn"]' }, { t: 5, cell: [4, 5], heading: "N", seconds: 1, resolved: true, how: "x", scene: "Overworld", sceneKey: '["Overworld"]' },
    { t: 9, cell: [3, 5], heading: "E", seconds: 1, resolved: true, how: "x", scene: "Inn", sceneKey: '["Inn"]' }];
  const spS = stuckSpots(sc);
  ok("stuck spots: grouped by scene and cell", spS.length === 2 && spS[0].scene === "Inn" && spS[0].count === 2 && spS[1].scene === "Overworld", JSON.stringify(spS));
  const mdS = reportMd({ session: "s", outcome: "ended", seed: 1, frames: 60, gameSeconds: 60, wallSeconds: 2, stats: { orders: 0, ordersFailed: 0, stuck: 3 }, stuckSpots: spS, replay: { file: "r.jsonl" }, notes: [], timeline: [], orders: [], errors: [], shots: [], deaths: [], dialogues: [], fights: [], stuck: sc });
  ok("report.md: the spot table names the scene", /\| Inn \(3,4\)/.test(mdS) && /\| Overworld \(4,5\)/.test(mdS), mdS.split("## Stuck incidents")[1]);

  // allowedTools: the Git Bash /c/... form of the shim path
  if (process.platform === "win32") {
    const aw = testerArgs({ model: "sonnet", effort: "low", cliJs: "C:/w/bin/witness.js", name: "b1-1" });
    const rl = aw.slice(aw.indexOf("--allowedTools") + 1, aw.indexOf("--add-dir")).filter((a) => a.startsWith("Bash(")).map((a) => a.slice(5, -1));
    const al = (cmd) => rl.some((x) => (x.endsWith(":*") ? cmd.startsWith(x.slice(0, -2)) : x.endsWith(" *") ? cmd.startsWith(x.slice(0, -1)) : cmd === x));
    const msys = shimCommand("b1-1").replace(/"/g, "").replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`);
    ok("batch: the MSYS /c/... form of the shim is allowed (bare and quoted)", al(`${msys} look`) && al(`"${msys}" look`), `${msys}\n${rl.join("\n")}`);
  }
}

// ---- regressions from a real game's reports (Embervale)
runFixTests(ok);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
