// Witness play: regression tests for harness bugs a real game (Embervale, a C++ RPG) reported. Synthetic tile worlds,
// no processes. Each block reproduces one report: a moving map window, regen spam, the wrong NPC answering, a wall
// longer than the window, paths through doors, entering a building ending a goto, stale remembered targets, and
// duplicate "is gone" lines. Run from unit.mjs.
import { parseOrders } from "../../src/play/orders.js";
import { NavGrid } from "../../src/play/grid.js";
import { resolvePlayConfig } from "../../src/play/config.js";
import { Perceiver } from "../../src/play/perceive.js";
import { EventTracker, coalesceEvents } from "../../src/play/events.js";
import { Autopilot } from "../../src/play/autopilot.js";
import { wakeFor } from "../../src/play/wake.js";
import { DeadWatch } from "../../src/play/deadwatch.js";

const KEYS = ["w", "a", "s", "d", "j", "k", "e", "escape", "enter"];

/**
 * A top-down world in tile units (cell 1, like Embervale): `solid(x, y)` says which global tiles are walls; the player
 * walks 5 tiles/s with a 0.3-tile body. `snapState(S)` builds the snapshot state; `onStep(S)` runs game rules.
 */
function tileWorld({ start, solid, snapState, onStep = null }) {
  const S = { frame: 0, t: 0, p: start.slice(), keys: new Set(), facing: "E", hp: 10, queue: [], dialogue: null, scene: "outside", trail: [] };
  const hits = (x, y) => [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]].some(([ox, oy]) => S.solidAt(Math.floor(x + ox), Math.floor(y + oy)));
  S.solidAt = solid;
  S.pressed = new Set();
  S.step = () => {
    S.pressed.clear();
    for (const e of S.queue.filter((e) => e.frame <= S.frame)) if (e.type === "key") { if (e.down && !S.keys.has(e.key)) S.pressed.add(e.key); e.down ? S.keys.add(e.key) : S.keys.delete(e.key); }
    S.queue = S.queue.filter((e) => e.frame > S.frame);
    const dx = (S.keys.has("d") ? 1 : 0) - (S.keys.has("a") ? 1 : 0), dy = (S.keys.has("s") ? 1 : 0) - (S.keys.has("w") ? 1 : 0);
    if (!S.dialogue) {
      const l = Math.hypot(dx, dy) || 1, v = 5 / 60;
      if (dx) S.facing = dx > 0 ? "E" : "W"; else if (dy) S.facing = dy > 0 ? "S" : "N";
      const nx = S.p[0] + (dx / l) * v; if (!hits(nx, S.p[1])) S.p[0] = nx;
      const ny = S.p[1] + (dy / l) * v; if (!hits(S.p[0], ny)) S.p[1] = ny;
    }
    if (onStep) onStep(S);
    const c = [Math.floor(S.p[0]), Math.floor(S.p[1])], last = S.trail.at(-1);
    if (!last || last[0] !== c[0] || last[1] !== c[1]) S.trail.push(c);
    S.frame++; S.t = S.frame / 60;
  };
  S.snap = () => ({ frame: S.frame, time: S.t, state: { scene: S.scene, dialogue: S.dialogue, player: { id: 1, type: "Player", pos: [...S.p], hp: S.hp, maxHp: 10, facing: S.facing }, ...snapState(S) } });
  return S;
}

/**
 * Like the daemon's turn-based session: one autopilot for several `do`s (settings stick), the reflex loop plus the
 * event tracker and the wake rules. `drv.do(text)` runs one order; `drv.sync()` takes in a change made to the game
 * between orders (its events are dropped, as if seen in an earlier observation).
 */
function driver(S, cfgRaw = {}, { cell = 1 } = {}) {
  const cfg = resolvePlayConfig({ cell, controls: { move: "wasd", interact: "e", cancel: "escape" }, ...cfgRaw }, { keys: KEYS });
  const per = new Perceiver(cfg, { fps: 60 });
  let w = per.perceive(S.snap(), S.frame);
  const grid = new NavGrid({ cell: w.cell, origin: [0, 0] });
  const ap = new Autopilot(cfg, { fps: 60, grid, perceiver: per, size: [320, 180] });
  const tr = new EventTracker(cfg, per);
  ap.observe(w); tr.update(null, w, {});
  const inputs = [];
  const drv = {
    cfg, ap, grid, tr, inputs, get world() { return w; },
    sync() { const nw = per.perceive(S.snap(), S.frame); ap.observe(nw); tr.update(w, nw, {}); ap.drainEvents(); w = nw; },
    do(orderText, { maxFrames = 3600 } = {}) {
      ap.setOrders(parseOrders(orderText, { named: cfg.named }));
      const events = [], f0 = S.frame, t0 = S.t;
      let status = "run", msg = "", wake = null;
      while (S.frame - f0 < maxFrames) {
        const d = ap.decide(w);
        const ev0 = ap.ctrl.emit(d.want, S.frame);
        S.queue.push(...ev0); inputs.push(...ev0.map((e) => ({ ...e, t: S.t })));
        if (d.status !== "run") { status = d.status; msg = d.message; break; }
        for (let i = 0; i < Math.max(1, d.k); i++) S.step();
        const nw = per.perceive(S.snap(), S.frame);
        ap.observe(nw);
        const ev = tr.update(w, nw, {});
        for (const e of ap.drainEvents()) ev.push({ t: nw.t, frame: S.frame, ...e });
        w = nw;
        events.push(...ev);
        const b = ap.cur ? { verb: ap.cur.o?.verb, careful: false, target: ap.cur.thingId ?? null } : null;
        wake = wakeFor(ev, b, { ap, world: w, cfg });
        if (wake) { status = "interrupted"; msg = wake; break; }
      }
      return { status, msg, ap, grid, events, results: ap.results, world: w, seconds: S.t - t0 };
    },
  };
  return drv;
}
/** One order on a fresh driver. */
function driveDo(S, cfgRaw, orderText, { maxFrames = 3600, cell = 1 } = {}) { return driver(S, cfgRaw, { cell }).do(orderText, { maxFrames }); }

export function runFixTests(ok) {
  // ---- 1. the scene key comes from the configured map, and a window moving over the same ground isn't a new scene
  {
    const rowsAt = (ox) => Array.from({ length: 5 }, (_, r) => Array.from({ length: 9 }, (_, c) => ((ox + c) % 4 === 0 && r === 2 ? "#" : ".")).join(""));
    const snap = (ox, extra = {}) => ({ frame: ox, state: { player: { pos: [ox + 4.5, 2.5] }, entities: [], map: { id: `win@${ox}`, cell: 1, origin: [ox, 0], rows: rowsAt(ox), solid: "#" }, ...extra } });
    // (a) a config whose map expression points somewhere stable: a changing raw state.map.id must not count
    const cfgA = resolvePlayConfig({ cell: 1, map: "state.walk" }, {});
    const pa = new Perceiver(cfgA, { fps: 60 });
    const walk = { id: "overworld", cell: 1, origin: [0, 0], rows: ["....."], solid: "#" };
    pa.perceive(snap(0, { walk }), 0);
    const wa = pa.perceive(snap(1, { walk }), 1);
    ok("bug 1: the scene key uses the configured map expression, not the raw state.map.id", !wa.newScene, wa.sceneKey);
    // (b) default config: the window's id changes as it moves, but it shows the same ground
    const pb = new Perceiver(resolvePlayConfig({ cell: 1 }, {}), { fps: 60 });
    pb.perceive(snap(0), 0);
    const shifts = [1, 2, 5, 9].map((ox, i) => pb.perceive(snap(ox), i + 1).newScene);
    ok("bug 1: a moving map window (same ground, new id each step) is the same scene", shifts.every((x) => !x), JSON.stringify(shifts));
    // (c) a different place (an interior that doesn't match) with a new id is a new scene
    const inside = { frame: 20, state: { player: { pos: [4.5, 2.5] }, entities: [], map: { id: "inn", cell: 1, origin: [5, 0], rows: ["#########", "#.......#", "#.......#", "#.......#", "#########"], solid: "#" } } };
    ok("bug 1: a different map with a new id is still a new scene", pb.perceive(inside, 20).newScene);
  }

  // ---- 2. regen: no "healed +0" per tick, and one merged line per observation
  {
    const cfg = resolvePlayConfig({ cell: 1 }, {});
    const per = new Perceiver(cfg, { fps: 60 }), tr = new EventTracker(cfg, per);
    const snap = (f, hp) => ({ frame: f, state: { player: { pos: [0, 0], hp, maxHp: 100 }, entities: [{ id: 3, type: "Sign", pos: [30, 0] }] } });
    let prev = per.perceive(snap(0, 50), 0); tr.update(null, prev, {});
    const all = [];
    let hp = 50;
    for (let f = 1; f <= 300; f++) { hp += 0.02 + (f % 3 === 0 ? 0.01 : 0); const cur = per.perceive(snap(f, hp), f); all.push(...tr.update(prev, cur, {})); prev = cur; }
    const heals = all.filter((e) => e.kind === "heal");
    ok("bug 2: no zero-amount heal events while regenerating (wait 5)", heals.length > 0 && heals.length <= 20 && !heals.some((e) => /\+0 /.test(e.text)), `${heals.length}: ${heals.slice(0, 3).map((e) => e.text).join(" | ")}`);
    const shown = coalesceEvents(all).filter((e) => e.kind === "heal");
    ok("bug 2: an observation shows regen as one line (regenerated +N over Ss)", shown.length === 1 && /regenerated \+\d+(\.\d)? over \d+(\.\d)?s \(hp 50→/.test(shown[0].text), shown.map((e) => e.text).join(" | "));
    // big heals (a potion) keep their own line
    const potion = { t: 6, kind: "heal", text: "healed +40 (hp 60→100)", data: { amount: 40, from: 60, to: 100 } };
    const withPotion = coalesceEvents([...all, potion]).filter((e) => e.kind === "heal");
    ok("bug 2: a potion among regen ticks keeps its own line", withPotion.length === 2 && withPotion.some((e) => /healed \+40/.test(e.text)), withPotion.map((e) => e.text).join(" | "));
    // damage over time with no attacker: merged too
    const per2 = new Perceiver(cfg, { fps: 60 }), tr2 = new EventTracker(cfg, per2);
    let p2 = per2.perceive(snap(0, 50), 0); tr2.update(null, p2, {});
    const dot = [];
    for (let f = 1; f <= 120; f++) { const cur = per2.perceive(snap(f, 50 - Math.floor(f / 20)), f); dot.push(...tr2.update(p2, cur, {})); p2 = cur; }
    const dotShown = coalesceEvents(dot).filter((e) => e.kind === "hurt");
    ok("bug 2: damage over time shows as one line", dotShown.length === 1 && /took 6 damage over/.test(dotShown[0].text) && !dot.some((e) => /took 0 damage/.test(e.text)), dotShown.map((e) => e.text).join(" | "));
  }

  // ---- 3. talk checks who answered: a child standing closer than the guard isn't the guard
  {
    const open = () => false;
    const npcs = [{ id: 4, type: "Guard", name: "Hrolf", pos: [10.5, 5.5], talk: true }, { id: 7, type: "Child", name: "Quaquanas", pos: [9.6, 5.5], talk: true }];
    const mk = () => tileWorld({
      start: [3.5, 5.5], solid: open,
      snapState: () => ({ entities: npcs }),
      onStep: (S) => {
        if (S.pressed.has("escape")) S.dialogue = null;
        if (S.pressed.has("e") && !S.dialogue) {   // the game answers with the nearest person within 1.5 tiles
          const near = npcs.map((n) => [Math.hypot(n.pos[0] - S.p[0], n.pos[1] - S.p[1]), n]).filter(([d]) => d < 1.5).sort((a, b) => a[0] - b[0])[0];
          if (near) S.dialogue = { speaker: near[1].name.toUpperCase(), text: near[1].id === 4 ? "Halt." : "Hi mister!", options: ["Bye"] };
        }
      },
    });
    const S = mk();
    const r = driveDo(S, {}, "talk Guard#4", { maxFrames: 60 * 30 });
    ok("bug 3: talk Guard#4 ends talking to the guard, not the child who answered first", r.status === "done" && /HROLF/.test(r.msg) && S.dialogue && S.dialogue.speaker === "HROLF", `${r.status} ${r.msg} dialogue=${JSON.stringify(S.dialogue)}`);
    ok("bug 3: the wrong answer is reported", r.events.some((e) => /QUAQUANAS \(Child#7\) answered instead of Guard#4/.test(e.text)), r.events.map((e) => e.text).filter((x) => /answer/.test(x)).join(" | "));
    // no cancel control: it can't retry, so it fails and says who answered (instead of reporting success)
    const S2 = mk();
    const r2 = driveDo(S2, { controls: { move: "wasd", interact: "e", cancel: null } }, "talk Guard#4", { maxFrames: 60 * 30 });
    ok("bug 3: without a cancel control, talk fails with 'X answered instead'", r2.status === "fail" && /QUAQUANAS \(Child#7\) answered instead of Guard#4/.test(r2.msg), `${r2.status} ${r2.msg}`);
  }

  // ---- 4. a wall longer than a 41-tile moving window: go round it, keep what earlier windows showed
  {
    const W = 220, H = 60;
    const solid = (x, y) => x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1 || (y === 30 && x >= 100 && x <= 165) || (x === 100 && y >= 30);
    const windowAt = (S) => {
      const ox = Math.floor(S.p[0]) - 20, oy = Math.floor(S.p[1]) - 20, rows = [];
      for (let r = 0; r < 41; r++) { let row = ""; for (let c = 0; c < 41; c++) row += solid(ox + c, oy + r) ? "#" : "."; rows.push(row); }
      return { id: `win@${ox},${oy}`, cell: 1, origin: [ox, oy], rows, solid: "#" };
    };
    // the west end is closed by a wall going south to the world's edge: west is a dead end; the way is east, 40 tiles off
    const S = tileWorld({ start: [125.5, 40.5], solid, snapState: (S2) => ({ entities: [], map: windowAt(S2) }) });
    const r = driveDo(S, {}, "goto 125,20 for 90s", { maxFrames: 60 * 120 });
    ok("bug 4: goto goes round a wall longer than the moving map window", r.status === "done" && Math.floor(S.p[1]) === 20, `${r.status} ${r.msg} at ${S.p.map((x) => x.toFixed(1))} t=${S.t.toFixed(1)}`);
    ok("bug 4: the windows were merged, not reset on every move", r.grid.windowed && r.grid.mapSolid.size > 41 * 41 * 2 && !r.events.some((e) => /map knowledge reset/.test(e.text)), `${r.grid.mapSolid.size} ${r.events.filter((e) => e.kind === "scene").length}`);
    const back = S.trail.filter(([x, y]) => x >= 99 && x <= 103 && y >= 31 && y <= 34).length;
    ok("bug 4: it didn't keep returning to the west dead end", back <= 6, `${back} visits near the dead end`);
    // the planner itself: with a dead end recorded, the partial path ends somewhere else
    const g = new NavGrid({ cell: 1 });
    g.setMap({ cell: 1, origin: [0, 0], rows: ["###########", "#.........#", "#.#######.#", "#.#.....#.#", "#.#.....#.#", "#.#######.#", "#.........#", "###########"], solid: "#" });
    g.astar([1, 1], [5, 4]);   // (5,4) is inside a closed room: no way in
    const end1 = g.lastPartial && g.lastPartial.at(-1);
    if (end1) g.addDeadEnd(end1);
    g.astar([1, 1], [5, 4]);
    const end2 = g.lastPartial && g.lastPartial.at(-1);
    ok("bug 4: after a dead end, the planner tries another spot instead of the same one", end1 && end2 && Math.max(Math.abs(end1[0] - end2[0]), Math.abs(end1[1] - end2[1])) > 2, `${end1} → ${end2}`);
    // a moving window: cells outside it are unknown ground (plannable), not the edge of the world
    const gw = new NavGrid({ cell: 1 });
    gw.setMap({ cell: 1, origin: [0, 0], window: true, rows: ["#####", ".....", "....."], solid: "#" });
    ok("bug 4: outside a map window is unknown ground, not the end of the world", !!gw.astar([2, 2], [2, -3]), JSON.stringify(gw.lastPartial));
  }

  // ---- 5. doors: paths keep off them unless the door (or the building) is the goal
  {
    const MAP = [
      "####################",
      "#..................#",
      "#.######+#######...#",
      "#.#............#...#",
      "#.######+#######...#",
      "#..................#",
      "####################",
    ];
    const solid = (x, y) => !MAP[y] || MAP[y][x] === undefined || MAP[y][x] === "#";
    const S = tileWorld({ start: [8.5, 1.5], solid, snapState: () => ({ entities: [], map: { cell: 1, origin: [0, 0], rows: MAP, solid: "#", door: "+" } }) });
    const r = driveDo(S, {}, "goto 8,5", { maxFrames: 60 * 30 });
    const crossed = S.trail.filter(([x, y]) => MAP[y][x] === "+");
    ok("bug 5: a path goes round a building instead of through its doors", r.status === "done" && crossed.length === 0, `${r.status} ${r.msg} crossed ${JSON.stringify(crossed)}`);
    const S2 = tileWorld({ start: [8.5, 1.5], solid, snapState: () => ({ entities: [{ id: 9, type: "Door", name: "Hall", pos: [8.5, 2.5] }], map: { cell: 1, origin: [0, 0], rows: MAP, solid: "#", door: "+" } }) });
    const r2 = driveDo(S2, {}, "goto Door", { maxFrames: 60 * 10 });
    ok("bug 5: goto Door still walks onto the door", r2.status === "done" && /arrived at Door#9/.test(r2.msg), `${r2.status} ${r2.msg}`);
    // things marked avoid (no map characters): same costs
    const g = new NavGrid({ cell: 1 });
    g.setMap({ cell: 1, origin: [0, 0], rows: MAP.map((row) => row.replace(/\+/g, ".")), solid: "#" });
    g.setAvoidThings([{ avoid: true, p2: [8.5, 2.5] }, { avoid: true, p2: [8.5, 4.5] }]);
    const path = g.astar([8, 1], [8, 5]);
    ok("bug 5: entities with avoid: true are kept off too", path && !path.some(([x, y]) => x === 8 && (y === 2 || y === 4)), JSON.stringify(path));
    const inside = g.astar([8, 1], [8, 3], { exempt: (x, y) => Math.abs(y - 3) <= 1 });
    ok("bug 5: going into the building, its door is the way", inside && inside.some(([x, y]) => x === 8 && y === 2) && inside.length <= 4, JSON.stringify(inside));
  }

  // ---- 6. entering the building a goto was sent to finishes the goto, and the chain goes on
  {
    const OUT = ["##########", "#........#", "#........#", "#...###+##", "#...#...##", "##########"];
    const INN = ["#######", "#.....#", "#.....#", "#.....#", "#######"];
    const S = tileWorld({
      start: [2.5, 1.5],
      solid: (x, y) => { const m = S.scene === "inn" ? INN : OUT; return !m[y] || m[y][x] === undefined || m[y][x] === "#"; },
      snapState: (S2) => S2.scene === "inn"
        ? { entities: [{ id: 21, type: "Innkeeper", name: "Innkeeper", pos: [4.5, 1.5], talk: true }], map: { id: "inn", cell: 1, origin: [0, 0], rows: INN, solid: "#" } }
        : { entities: [{ id: 30, type: "Door", name: "Inn", leadsTo: "Inn", pos: [7.5, 3.5] }, { id: 31, type: "Sign", pos: [1.5, 4.5] }], map: { id: "town", cell: 1, origin: [0, 0], rows: OUT, solid: "#" } },
      onStep: (S2) => {
        if (S2.scene === "outside" && Math.floor(S2.p[0]) === 7 && Math.floor(S2.p[1]) === 3) { S2.scene = "inn"; S2.p = [3.5, 3.4]; }
        if (S2.pressed.has("e") && S2.scene === "inn" && !S2.dialogue && Math.hypot(S2.p[0] - 4.5, S2.p[1] - 1.5) < 1.6) S2.dialogue = { speaker: "Innkeeper", text: "A room?", options: ["Yes", "No"] };
      },
    });
    S.scene = "outside";
    const r = driveDo(S, {}, "goto Inn; talk Innkeeper", { maxFrames: 60 * 30 });
    ok("bug 6: goto Inn; talk Innkeeper — entering the inn finishes the goto and the talk runs", r.status === "done" && r.results.length === 2 && /entered Door#30/.test(r.results[0].msg) && /Innkeeper/.test(r.results[1].msg), `${r.status} ${r.msg} ${JSON.stringify(r.results)}`);
    // a scene change far from the goal, with the target gone from the list, still interrupts
    const S2 = tileWorld({ start: [2.5, 1.5], solid: () => false, snapState: (S3) => ({ scene: S3.frame > 30 ? "cave" : "outside", entities: S3.frame > 30 ? [{ id: 6, type: "Bat", pos: [9.5, 9.5] }] : [{ id: 5, type: "Well", pos: [40.5, 1.5] }] }) });
    const r2 = driveDo(S2, {}, "goto Well", { maxFrames: 60 * 10 });
    ok("bug 6: an unrelated scene change still interrupts", r2.status === "interrupted" && /scene/.test(r2.msg), `${r2.status} ${r2.msg}`);
    // the target is still listed after the change (a region label changed): the goto carries on to it
    const S3 = tileWorld({ start: [2.5, 1.5], solid: () => false, snapState: (S4) => ({ scene: S4.frame > 30 ? "east fields" : "outside", entities: [{ id: 5, type: "Well", pos: [12.5, 1.5] }] }) });
    const r3 = driveDo(S3, {}, "goto Well", { maxFrames: 60 * 10 });
    ok("bug 6: a scene change with the target still listed lets the goto carry on", r3.status === "done" && /arrived at Well#5/.test(r3.msg), `${r3.status} ${r3.msg}`);
  }

  // ---- 7. goto <Type>: one still listed beats the stale remembered spot of one that vanished
  {
    const S = tileWorld({ start: [2.5, 2.5], solid: () => false, snapState: (S2) => ({ entities: [
      ...(S2.frame < 10 ? [{ id: 9, type: "Villager", pos: [12.5, 2.5], talk: true }] : []),
      { id: 10, type: "Villager", pos: [2.5, 14.5], talk: true }, { id: 11, type: "Sign", pos: [40.5, 40.5] }] }) });
    const r = driveDo(S, {}, "goto Villager", { maxFrames: 60 * 15 });
    ok("bug 7: goto Villager switches to the listed one when its pick vanishes", r.status === "done" && /arrived at Villager#10/.test(r.msg), `${r.status} ${r.msg}`);
  }

  // ---- 8. a thing flickering at the edge of the list is gone once
  {
    const cfg = resolvePlayConfig({ cell: 1 }, {});
    const per = new Perceiver(cfg, { fps: 60 }), tr = new EventTracker(cfg, per);
    const snap = (f, wolf) => ({ frame: f, state: { player: { pos: [0, 0], hp: 10 }, entities: [{ id: 3, type: "Sign", pos: [9, 0] }, ...(wolf ? [{ id: 76, type: "Wolf", pos: [5, 0], hp: 3, maxHp: 3, hostile: true }] : [])] } });
    let prev = per.perceive(snap(0, true), 0); tr.update(null, prev, {});
    const all = [];
    [false, true, false, true, false].forEach((wolf, i) => { const cur = per.perceive(snap(i + 1, wolf), i + 1); all.push(...tr.update(prev, cur, {})); prev = cur; });
    const gone = coalesceEvents(all).filter((e) => /Wolf#76 is gone/.test(e.text));
    ok("bug 8: one 'Wolf#76 is gone', not one per flicker", gone.length === 1, all.map((e) => `${e.t.toFixed(3)} ${e.text}`).join(" | "));
    const dup = coalesceEvents([{ t: 49.8, kind: "gone", text: "Wolf#76 is gone" }, { t: 49.8, kind: "gone", text: "Wolf#76 is gone" }]);
    ok("bug 8: identical events at the same time show once", dup.length === 1);
  }

  // ---- 9. goto a solid cell (Vond (172,-101): "goto 172,-100" pushed into the Inn's front wall beside its door for
  // 3.2 s, twice, and the hint blamed a farmer standing by): say the target is a wall, enter by the door next to it,
  // else stop at the nearest open cell
  {
    const TOWN = [
      "####################",
      "#..................#",
      "#..................#",
      "#.....#######......#",
      "#.....#.....#.###..#",
      "#.....#.....#.###..#",
      "#.....###+###.###..#",
      "#..................#",
      "#..................#",
      "#..................#",
      "####################",
    ];
    const INSIDE = ["#######", "#.....#", "#.....#", "#######"];
    // stepping on the door (9,6) takes you inside, like Embervale's doors
    const town = ({ start, entities = [], rows = TOWN, map = true, door = true }) => {
      const S = tileWorld({
        start,
        solid: (x, y) => { const m = S.scene === "inn" ? INSIDE : rows; return !m[y] || m[y][x] === undefined || m[y][x] === "#"; },
        snapState: (S2) => S2.scene === "inn"
          ? { entities: [], map: { id: "inn", cell: 1, origin: [0, 0], rows: INSIDE, solid: "#" } }
          : { entities, ...(map ? { map: { id: "town", cell: 1, origin: [0, 0], rows, solid: "#", door: "+" } } : {}) },
        onStep: (S2) => { if (door && S2.scene === "outside" && Math.floor(S2.p[0]) === 9 && Math.floor(S2.p[1]) === 6) { S2.scene = "inn"; S2.p = [3.5, 2.5]; } },
      });
      S.scene = "outside";
      return S;
    };
    const stuckEvents = (r) => r.events.filter((e) => /stuck at|bumped into/.test(e.text)).map((e) => e.text);
    const farmer = { id: 40, type: "Farmer", name: "Odo", pos: [7.5, 7.5], talk: true };

    // (a) a wall cell right beside the door (the reported case): enter by the door instead of pushing into the wall
    {
      const S = town({ start: [8.5, 8.5], entities: [farmer] });
      const r = driveDo(S, {}, "goto 8,6", { maxFrames: 60 * 15 });
      ok("bug 9: goto a wall cell beside a door enters by the door", r.status === "done" && S.scene === "inn" && /target \(8,6\) is inside a wall/.test(r.msg) && /\(8,6\) is in a building; entering by its door at \(9,6\)/.test(r.msg) && S.t < 3, `${r.status} ${r.msg} scene=${S.scene} t=${S.t.toFixed(1)}`);
      ok("bug 9: ... said up front, before walking", r.events.some((e) => /target \(8,6\) is inside a wall/.test(e.text)) && !stuckEvents(r).length, r.events.map((e) => e.text).join(" | "));
      ok("bug 9: ... no farmer blamed", !/Farmer/.test(r.msg), r.msg);
    }
    // (a2) a door that's a thing (Door with leadsTo; the map cell is plain ground)
    {
      const rows = TOWN.map((row) => row.replace("+", "."));
      const S = town({ start: [12.5, 8.5], rows, entities: [{ id: 31, type: "Door", name: "Inn door", leadsTo: "Inn", pos: [9.5, 6.5] }] });
      const r = driveDo(S, {}, "goto 10,6", { maxFrames: 60 * 15 });
      ok("bug 9: a Door entity next to the wall cell is the way in too", r.status === "done" && S.scene === "inn" && /entering by its door at \(9,6\)/.test(r.msg), `${r.status} ${r.msg} scene=${S.scene}`);
    }
    // (b) a solid cell with no door near (the middle of a 3x3 block): end at the nearest open cell, done
    {
      const S = town({ start: [15.5, 9.5], entities: [farmer] });
      const r = driveDo(S, {}, "goto 15,5", { maxFrames: 60 * 15 });
      const c = S.p.map(Math.floor);
      ok("bug 9: goto a solid cell without a door ends at the nearest open cell", r.status === "done" && /target \(15,5\) is inside a wall/.test(r.msg) && /nearest open cell \(15,7\), 2 cells from the target/.test(r.msg) && c[0] === 15 && c[1] === 7, `${r.status} ${r.msg} at ${c}`);
      ok("bug 9: ... without bumping into it", !stuckEvents(r).length && S.t < 3, `${stuckEvents(r).join(" | ")} t=${S.t.toFixed(1)}`);
    }
    // (c) a thing standing in a wall cell
    {
      // deep inside the block: no open cell next to it, so the nearest open one
      const S = town({ start: [15.5, 9.5], entities: [{ id: 50, type: "Marker", name: "Quest", pos: [15.5, 5.5] }] });
      const r = driveDo(S, {}, "goto Marker", { maxFrames: 60 * 15 });
      ok("bug 9: goto a thing deep in a wall ends at the nearest open cell", r.status === "done" && /Marker#50 at \(15,5\) is inside a wall/.test(r.msg) && /nearest open cell \(15,7\)/.test(r.msg) && S.p.map(Math.floor).join() === "15,7", `${r.status} ${r.msg} at ${S.p.map(Math.floor)}`);
      // a building whose position is in its own front wall, beside its door: enter it
      const S2 = town({ start: [4.5, 8.5], entities: [{ id: 51, type: "Building", name: "Inn", pos: [8.5, 6.5] }] });
      const r2 = driveDo(S2, {}, "goto Inn", { maxFrames: 60 * 15 });
      ok("bug 9: goto a building positioned in its wall enters by its door", r2.status === "done" && S2.scene === "inn" && /entering by its door at \(9,6\)/.test(r2.msg), `${r2.status} ${r2.msg} scene=${S2.scene}`);
      // a sign on the wall beside the door, with ground in front of it: still "stand next to it", not taken indoors
      const S3 = town({ start: [4.5, 8.5], entities: [{ id: 52, type: "Sign", pos: [8.5, 6.5] }] });
      const r3 = driveDo(S3, {}, "goto Sign", { maxFrames: 60 * 15 });
      ok("bug 9: a sign on a wall is still reached from beside it", r3.status === "done" && S3.scene === "outside" && /Sign#52 is solid/.test(r3.msg), `${r3.status} ${r3.msg} scene=${S3.scene}`);
    }
    // (d) no map: the wall is only learned by bumping into it. Switch at once, don't fail after 3.2 s stuck
    {
      const S = town({ start: [10.5, 2.5], map: false, door: false, entities: [{ id: 40, type: "Farmer", name: "Odo", pos: [11.5, 2.5], talk: true }] });
      const r = driveDo(S, {}, "goto 10,3", { maxFrames: 60 * 15 });
      ok("bug 9: no map: the target learned solid by bumping ends at the nearest open cell", r.status === "done" && /target \(10,3\) is inside a wall/.test(r.msg) && /nearest open cell \(10,2\), 1 cell from the target/.test(r.msg) && S.t < 2, `${r.status} ${r.msg} t=${S.t.toFixed(1)}`);
      ok("bug 9: ... no 'stuck for 3.2s', no farmer blamed", !/stuck at|Farmer/.test(r.msg) && !r.events.some((e) => /stuck at .*unresolved/.test(e.text)), `${r.msg} | ${r.events.map((e) => e.text).join(" | ")}`);
    }
    // (e) the "X is right there" hint names a bystander only when it stands in the way, never for a wall or the target
    {
      const S = town({ start: [10.5, 2.5], entities: [{ id: 40, type: "Farmer", name: "Odo", pos: [11.5, 2.5], talk: true }] });
      const cfg = resolvePlayConfig({ cell: 1, controls: { move: "wasd", interact: "e" } }, { keys: KEYS });
      const per = new Perceiver(cfg, { fps: 60 }), w = per.perceive(S.snap(), 0);
      const ap = new Autopilot(cfg, { fps: 60, grid: new NavGrid({ cell: 1 }), perceiver: per });
      ap.observe(w);
      const wall = ap.blockerHint(w, "stuck", { goal: [10.5, 3.5] });
      ok("bug 9: the hint doesn't blame a bystander when a wall is in the way", wall === "stuck", wall);
      const inWay = ap.blockerHint(w, "stuck", { goal: [13.5, 2.5] });
      ok("bug 9: the hint names someone standing in the way", /Farmer#40 is right there/.test(inWay), inWay);
      const target = ap.blockerHint(w, "stuck", { goal: [11.5, 2.5], targetId: 40 });
      ok("bug 9: the hint doesn't name the target itself", target === "stuck", target);
      const S2 = town({ start: [5.5, 7.5], entities: [{ id: 41, type: "Gate", pos: [5.5, 8.5], locked: true }, { id: 42, type: "Farmer", pos: [4.5, 7.5], talk: true }] });
      const w2 = per.perceive(S2.snap(), 1); ap.observe(w2);
      const gate = ap.blockerHint(w2, "stuck", { goal: [5.5, 9.5] });
      ok("bug 9: a locked gate is still named", /Gate#41 \(locked\) is right there/.test(gate) && !/Farmer/.test(gate), gate);
    }
  }

  // ---- 10. death freeze (Embervale, 0.7.1 batch): after `set retreat 30`, dying with an enemy over the body turned every
  // order (respawn, wait, press, even `set retreat 0`) into a Flee, which can't run while dead: "you died" before a
  // single frame, the clock frozen, the session unrecoverable. Their game respawns on Enter once the prompt shows (1.2 s)
  {
    const mk = () => {
      const S = tileWorld({
        start: [5.5, 5.5], solid: () => false,
        snapState: (S2) => ({ dead: S2.dead, entities: [{ id: 5, type: "Skeleton", pos: S2.dead ? [S2.deathP[0] + 0.2, S2.deathP[1]] : [9.5, 5.5], hp: 6, maxHp: 6, hostile: true }] }),
        onStep: (S2) => {
          if (!S2.dead) return;
          S2.p = S2.deathP.slice();   // the body doesn't move
          if (S2.pressed.has("enter") && S2.t - S2.deathT >= 1.2) { S2.dead = false; S2.hp = 10; S2.p = [2.5, 2.5]; S2.respawns = (S2.respawns || 0) + 1; }
        },
      });
      S.dead = false;
      S.kill = () => { S.hp = 0; S.dead = true; S.deathT = S.t; S.deathP = S.p.slice(); };
      return S;
    };
    const S = mk(), drv = driver(S, { controls: { move: "wasd", interact: "e", cancel: "escape", confirm: "enter" } });
    const r0 = drv.do("set retreat 30");
    ok("death freeze: set retreat 30", r0.status === "done" && /retreat below 30% hp/.test(r0.msg), `${r0.status} ${r0.msg}`);
    S.kill(); drv.sync();
    const t0 = S.t;
    const r1 = drv.do("wait 0.5");
    ok("death freeze: wait runs while dead (the clock moves)", r1.status === "done" && S.t - t0 >= 0.5 && !/you died/.test(r1.msg), `${r1.status} ${r1.msg} +${(S.t - t0).toFixed(2)}s`);
    ok("death freeze: no retreat reflex while dead", !r1.events.some((e) => /retreating/.test(e.text)), r1.events.map((e) => e.text).join(" | "));
    const r2 = drv.do("respawn");
    ok("death freeze: respawn while dead with retreat on respawns (Enter after the 1.2 s prompt)", r2.status === "done" && /respawned after/.test(r2.msg) && S.respawns === 1 && !S.dead, `${r2.status} ${r2.msg} respawns=${S.respawns}`);
    S.kill(); drv.sync();
    const r3 = drv.do("set retreat 0");
    ok("death freeze: set retreat 0 applies while dead", r3.status === "done" && /retreat below 0% hp/.test(r3.msg) && drv.ap.policy.retreat === 0, `${r3.status} ${r3.msg}`);
    drv.do("set retreat 30");
    const f0 = S.frame, r4 = drv.do("press enter");
    ok("death freeze: press runs while dead", r4.status === "done" && /pressed enter/.test(r4.msg) && S.frame > f0, `${r4.status} ${r4.msg}`);
    // heal and guard reflexes stay quiet over a body too
    const S2 = mk(), d2 = driver(S2, { heal: 50, guard: true, controls: { move: "wasd", interact: "e", confirm: "enter", heal: "h", block: "k" } });
    S2.kill(); d2.sync();
    const r5 = d2.do("wait 1");
    ok("death freeze: no heal/guard reflex while dead", r5.status === "done" && !d2.inputs.some((e) => e.key === "h" || e.key === "k"), `${r5.status} ${r5.msg} ${d2.inputs.map((e) => e.key).join(",")}`);
  }

  // ---- 11. damage over time (poison: "took 0.1 damage" every half second, no attacker in view) woke the tester and
  // ended goto orders; a real hit by a visible attacker still wakes, and so do low hp and death
  {
    const mk = ({ foe = false } = {}) => {
      const S = tileWorld({
        start: [2.5, 2.5], solid: () => false,
        snapState: (S2) => ({ entities: [{ id: 3, type: "Well", pos: [16.5, 2.5] }, ...(foe ? [{ id: 8, type: "Archer", pos: [S2.p[0] + 6, 2.5], hostile: true, hp: 4, maxHp: 4 }] : [])] }),
        onStep: (S2) => { if (S2.frame % 30 === 29 && S2.hp > 6) S2.hp = +(S2.hp - 0.1).toFixed(2); if (S2.hitAt === S2.frame) S2.hp -= 2; },
      });
      return S;
    };
    for (const autofight of [false, true]) {
      const S = mk(), drv = driver(S, { autofight });
      const r = drv.do("goto Well");
      ok(`DoT: poison ticks don't interrupt a goto (autofight ${autofight ? "on" : "off"})`, r.status === "done" && /arrived at Well#3/.test(r.msg) && S.hp < 10, `${r.status} ${r.msg} hp=${S.hp}`);
      ok(`DoT: ... the ticks are still in the events (autofight ${autofight ? "on" : "off"})`, r.events.some((e) => e.kind === "hurt" && e.data && e.data.dot), r.events.filter((e) => e.kind === "hurt").map((e) => e.text).join(" | "));
    }
    const S2 = mk(), d2 = driver(S2, { autofight: false });
    const r2 = d2.do("wait 3");
    ok("DoT: poison ticks don't wake a wait", r2.status === "done" && /waited 3s/.test(r2.msg), `${r2.status} ${r2.msg}`);
    // poison with an enemy in view but not near: autofight doesn't go after it as "it hit you"
    const S4 = mk({ foe: true }), d4 = driver(S4, { autofight: true });
    const r4 = d4.do("goto Well");
    ok("DoT: autofight doesn't blame a far-off enemy for a poison tick", r4.status === "done" && !r4.events.some((e) => /hit you/.test(e.text)), `${r4.status} ${r4.msg} | ${r4.events.filter((e) => e.kind === "autofight").map((e) => e.text).join(" | ")}`);
    // a hit by a visible attacker wakes a wait (no autofight to deal with it)
    const S3 = mk({ foe: true }); S3.hitAt = 10;
    const d3 = driver(S3, { autofight: false });
    const r3 = d3.do("wait 3");
    ok("DoT: a hit with an attacker in view still wakes", r3.status === "interrupted" && /you took 2 damage/.test(r3.msg), `${r3.status} ${r3.msg}`);
  }

  // ---- 12. leaving by an Exit you push into (Embervale's dungeons): stand on the Exit tile and push SOUTH (into the
  // wall behind it), having stepped off it since arriving; E does nothing. A goto that stopped within 1 cell of it, or
  // arrived from the side, did nothing. Convention: the entity's `enter` ("s", "ne", or a plane vector) is the push
  // that uses it; without one, push from its open side into its solid side, then try the interact key
  {
    const DUN = [
      "##########",
      "#........#",
      "#........#",
      "#........#",
      "#........#",
      "##########",
    ];
    // the exit is (5,4): the wall (5,5) is south of it, open floor north, east and west
    const dungeon = ({ start, exit, rule = "push-s" }) => {
      const S = tileWorld({
        start,
        solid: (x, y) => S.scene !== "dungeon" ? false : !DUN[y] || DUN[y][x] === undefined || DUN[y][x] === "#",
        snapState: (S2) => S2.scene === "dungeon" ? { entities: [exit], map: { id: "dun", cell: 1, origin: [0, 0], rows: DUN, solid: "#" } } : { entities: [], map: { id: "world", cell: 1, origin: [0, 0], rows: ["...."], solid: "#" } },
        onStep: (S2) => {
          if (S2.scene !== "dungeon") return;
          const on = Math.floor(S2.p[0]) === 5 && Math.floor(S2.p[1]) === 4;
          if (!on) { S2.steppedOff = true; return; }
          if (rule === "push-s" && S2.steppedOff && S2.keys.has("s")) { S2.scene = "overworld"; S2.p = [1.5, 0.5]; S2.left = "push"; }
          if (rule === "key" && S2.pressed.has("e")) { S2.scene = "overworld"; S2.p = [1.5, 0.5]; S2.left = "key"; }
        },
      });
      S.scene = "dungeon"; S.steppedOff = false;
      return S;
    };
    const exitE = (extra = {}) => ({ id: 70, type: "Exit", leadsTo: "Overworld", pos: [5.5, 4.5], ...extra });
    // (a) with enter: "s", arriving from the east (the goto stops within 1 cell, short of the tile)
    {
      const S = dungeon({ start: [8.5, 4.5], exit: exitE({ enter: "s" }) });
      const r = driveDo(S, {}, "goto Exit", { maxFrames: 60 * 15 });
      ok("exit push: enter \"s\": goto Exit steps on and pushes south → leaves", r.status === "done" && S.scene === "overworld" && S.left === "push" && /entered Exit#70/.test(r.msg) && /pushed S/.test(r.msg), `${r.status} ${r.msg} scene=${S.scene}`);
    }
    // (b) arriving from the side, no enter field: the wall is south of it, open north → push S
    {
      const S = dungeon({ start: [1.5, 4.5], exit: exitE() });
      const r = driveDo(S, {}, "goto Exit", { maxFrames: 60 * 15 });
      ok("exit push: no enter field, from the side: pushes from its open side into the wall (S)", r.status === "done" && S.scene === "overworld" && S.left === "push" && /pushed S/.test(r.msg), `${r.status} ${r.msg} scene=${S.scene}`);
    }
    // (c) enter as a plane vector [0, 1] (south, y down)
    {
      const S = dungeon({ start: [8.5, 2.5], exit: exitE({ enter: [0, 1] }) });
      const r = driveDo(S, {}, "goto Exit", { maxFrames: 60 * 15 });
      ok("exit push: enter as a vector [0,1]", r.status === "done" && S.scene === "overworld" && /pushed S/.test(r.msg), `${r.status} ${r.msg} scene=${S.scene}`);
    }
    // (d) a hatch that opens with the interact key: pushing does nothing, then E works; the message says what was tried
    {
      const S = dungeon({ start: [2.5, 1.5], exit: { id: 71, type: "Hatch", leadsTo: "Cellar", pos: [5.5, 4.5] }, rule: "key" });
      const r = driveDo(S, {}, "goto Hatch", { maxFrames: 60 * 15 });
      ok("exit push: then the interact key", r.status === "done" && S.scene === "overworld" && S.left === "key" && /pushed S for 0\.6s, pressed e/.test(r.msg), `${r.status} ${r.msg} scene=${S.scene}`);
    }
    // (e) nothing works: done, standing on it, saying what was tried
    {
      const S = dungeon({ start: [2.5, 1.5], exit: exitE({ enter: "n" }), rule: "none" });
      const r = driveDo(S, {}, "goto Exit", { maxFrames: 60 * 15 });
      ok("exit push: nothing worked → says what was tried", r.status === "done" && S.scene === "dungeon" && /on Exit#70 at \(5,4\): pushed N \(that walked off it\), pressed e: the scene didn't change/.test(r.msg) && S.p.map(Math.floor).join() === "5,4", `${r.status} ${r.msg} at ${S.p.map(Math.floor)}`);
    }
  }
  // ---- 13. stuck dead: dead for 20 game seconds with respawn presses and nothing changing; enemies wandering over the
  // body and ticking timers don't count as a change, a press while alive doesn't count as an attempt
  {
    const dw = new DeadWatch(20);
    const world = (t, dead, extra = {}) => ({ t, dead, snap: { state: { player: { hp: dead ? 0 : 10, pos: [3, 4] }, deathTimer: t, entities: [{ id: 5, pos: [t, 1] }], ...extra } } });
    dw.input(0.5, [{ type: "key", key: "enter", down: true }]);
    dw.update(world(1, true));
    let hit = null;
    for (let t = 1; t <= 25 && !hit; t += 0.5) hit = dw.update(world(t, true));
    ok("stuck dead: no presses while dead is no attempt (a game with a long respawn timer)", !hit);
    const dw2 = new DeadWatch(20);
    dw2.update(world(1, true));
    for (let t = 1; t <= 25 && !hit; t += 0.5) { if (t === 3) dw2.input(t, [{ type: "key", key: "enter", down: true }, { type: "key", key: "enter", down: false, frame: 9 }]); hit = dw2.update(world(t, true)); }
    ok("stuck dead: after 20 s with a press, timers and wandering enemies ignored", hit && hit.attempts === 1 && Math.abs(hit.seconds - 20) < 0.6 && /stuck dead: dead for 20s of game time with 1 respawn attempt \(pressed enter\)/.test(dw2.text()), JSON.stringify(hit));
    const dw3 = new DeadWatch(20);
    let h3 = null;
    for (let t = 1; t <= 25 && !h3; t += 0.5) { dw3.input(t, [{ type: "key", key: "enter", down: true }]); h3 = dw3.update(world(t, true, { menu: t < 15 ? "continue?" : "load save?" })); }
    ok("stuck dead: a change in the death screen restarts the count", !h3);
  }
}
