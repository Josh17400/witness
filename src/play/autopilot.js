// Witness play: the reflex layer. The tester gives orders ("fight wolf block", "talk guard"); the autopilot turns
// them into held controls every few frames, from the world model: path finding around walls, stuck recovery,
// facing and attacking, reacting to telegraphed attacks after a human-like reaction delay, dialogue choices.
// Deterministic: no wall clock, no unseeded randomness.
import { norm, len, sub, add, scale, dist2, dot, perp, compass, dirVector, r1, fmtT, clip } from "./util.js";
import { controlLabel, parseControl } from "./config.js";
import { makeProfile, moveControls, lookOf } from "./profiles.js";
import { PlatformRunner, SAFE_STATES } from "./platformer.js";
import { OrderError, resolveTarget, ORDER_CARD_TURN } from "./orders.js";
import { thingLabel } from "./perceive.js";
import { DotClassifier } from "./events.js";
import { parseWitnessInput } from "../core/input-spec.js";

// ------------------------------------------------------------------ controller: wanted controls → protocol events
export function newWant() { return { held: new Map(), taps: [], axes: {}, mouse: null, raw: [] }; }

function controlEvent(c, down, mouse) {
  if (c.type === "key") return { type: "key", key: c.key, down };
  if (c.type === "action") return { type: "action", action: c.action, down };
  if (c.type === "pad") return { type: "pad", button: c.button, down };
  if (c.type === "mouse") return { type: "mouse", x: mouse.x, y: mouse.y, button: c.button, down };
  if (c.type === "axis") return { type: "axis", axis: c.axis, value: down ? 1 : 0 };
  return null;
}

export class Controller {
  constructor(size = [640, 360]) {
    this.held = new Map();      // label → control
    this.busy = new Map();      // label → frame its tap release lands on
    this.axes = {};
    this.mouse = { x: Math.round(size[0] / 2), y: Math.round(size[1] / 2) };
  }
  /** Diff the wanted state against what's held; return events for frame F (taps release a few frames later). */
  emit(want, F) {
    const ev = [];
    for (const [label, until] of this.busy) if (until <= F) this.busy.delete(label);
    const heldKeys = new Set([...want.held.values()].map(controlLabel));
    for (const [label, c] of this.held) {
      if (!want.held.has(label)) {
        this.held.delete(label);
        // another wanted label may share the same physical control: keep it down then
        if (heldKeys.has(controlLabel(c))) continue;
        if (!this.busy.has(controlLabel(c))) ev.push({ frame: F, ...controlEvent(c, false, this.mouse) });
      }
    }
    for (const [label, c] of want.held) {
      if (this.held.has(label)) continue;
      const already = [...this.held.values()].some((h) => controlLabel(h) === controlLabel(c));
      this.held.set(label, c);
      if (!already && !this.busy.has(controlLabel(c))) ev.push({ frame: F, ...controlEvent(c, true, this.mouse) });
    }
    for (const tap of want.taps) {
      const lab = controlLabel(tap.c);
      if (heldKeys.has(lab) || this.busy.has(lab)) continue;
      const frames = Math.max(1, tap.frames || 1);
      ev.push({ frame: F, ...controlEvent(tap.c, true, this.mouse) });
      ev.push({ frame: F + frames, ...controlEvent(tap.c, false, this.mouse) });
      this.busy.set(lab, F + frames);
    }
    for (const [axis, v] of Object.entries(want.axes)) {
      if (this.axes[axis] !== v) { this.axes[axis] = v; ev.push({ frame: F, type: "axis", axis, value: v }); }
    }
    if (want.mouse && (want.mouse[0] || want.mouse[1])) {
      this.mouse.x += want.mouse[0]; this.mouse.y += want.mouse[1];
      ev.push({ frame: F, type: "mouse", x: this.mouse.x, y: this.mouse.y });
    }
    for (const r of want.raw) { const { at = 0, ...e } = r; ev.push({ ...e, frame: F + at }); }
    return ev.filter((e) => e.type);
  }
  releaseAll(F) { const w = newWant(); return this.emit(w, F); }
}

// ------------------------------------------------------------------ navigator: follow a path on the nav grid
export class Navigator {
  constructor(ap) { this.ap = ap; this.reset(); }
  reset() {
    this.path = null; this.goalCell = null; this.planVersion = -1; this.planT = -1e9; this.samples = []; this.blocks = 0;
    this.escape = null; this.best = Infinity; this.bestT = this.ap.t; this.incident = null; this.lastDir = null; this.bestRem = Infinity; this.cellsDone = new Set();
  }
  /** One tick toward goal (plane point) within reach (world units). Returns {dir, arrived, fail}. */
  tick(w, goal, reach, { stuckLimit = 3.2, direct = false } = {}) {
    const ap = this.ap, grid = ap.grid, p = w.player.p2, t = ap.t, cell = w.cell;
    const d = dist2(p, goal);
    if (d <= reach) { this.closeIncident(w, true, "arrived"); return { dir: null, arrived: true }; }
    if (d < this.best - 0.4 * cell) { this.best = d; this.bestT = t; }
    // walking into ground it hasn't stood on yet counts as progress too: going round a long wall takes you away from
    // the target for a while (and its path keeps growing as the map reveals more of the wall)
    const ck = grid.toCell(p).join(",");
    if (!this.cellsDone.has(ck)) { this.cellsDone.add(ck); if (this.cellsDone.size > 1) this.bestT = t; }
    if (t - this.bestT > stuckLimit) {
      let msg = `stuck at cell ${fmtCell(grid.toCell(p))} heading ${compass(sub(goal, p), w.northSign)} for ${r1(t - this.bestT)}s (no progress toward the target)`;
      if (this.partial) {   // the planner found no open way at all: say so, and point at a locked door/gate if there is one
        const locked = w.things.filter((th) => th.locked && !th.dead).sort((a, b) => dist2(p, a.p2) - dist2(p, b.p2))[0];
        const shown = grid.windowed ? "the map shows no open way there (in the ground its window has shown so far)" : "the map shows no open way there";
        msg += locked ? ` — ${shown}; ${locked.key} is locked (${r1(dist2(p, locked.p2) / cell)} cells ${compass(sub(locked.p2, p), w.northSign)}): try "goto ${locked.key}; interact ${locked.key}"` : ` — ${shown} from here`;
      }
      grid.addDeadEnd(grid.toCell(p));   // the next plan (this order again, or another) tries a different way
      this.closeIncident(w, false, "gave up");
      return { dir: null, fail: msg };
    }
    // escape manoeuvres after repeated blocks
    if (this.escape && t < this.escape.until && !(this.escape.toward && dist2(p, this.escape.toward) < cell * 0.08)) {
      const ed = this.escape.toward ? sub(this.escape.toward, p) : this.escape.dir;
      this.record(w, norm(ed)); return { dir: ed };
    }
    this.escape = null;
    const pc = grid.toCell(p), gc = grid.toCell(goal), rb = ap.bodyRadius(w);
    let dir;
    if (direct) dir = sub(goal, p);
    else {
      const offPath = this.path && !this.path.some((c) => Math.abs(c[0] - pc[0]) <= 1 && Math.abs(c[1] - pc[1]) <= 1);
      if (!this.path || this.planVersion !== grid.version || !this.goalCell || this.goalCell[0] !== gc[0] || this.goalCell[1] !== gc[1] || offPath || t - this.planT > 1.5) {
        const reachCells = reach / cell;
        const full = grid.astar(pc, gc, { t, exempt: this.exempt, goalOk: (x, y) => dist2(grid.center([x, y]), goal) <= Math.max(reach, cell * 0.5) && !(x === pc[0] && y === pc[1]) || (Math.hypot(x - gc[0], y - gc[1]) <= Math.max(0, reachCells - 0.5)) });
        this.path = full || grid.lastPartial || null;
        this.partial = !full;
        this.planVersion = grid.version; this.goalCell = gc; this.planT = t;
        if (!this.path) this.noPath = (this.noPath || 0) + 1;
        this.bestRem = Infinity;   // a new plan: progress is measured along it from here
      }
      if (this.path && this.path.length > 1) {
        let i = this.path.findIndex((c) => c[0] === pc[0] && c[1] === pc[1]);
        if (i < 0) { let bd = Infinity; this.path.forEach((c, j) => { const dd = Math.hypot(c[0] - pc[0], c[1] - pc[1]); if (dd < bd) { bd = dd; i = j; } }); }
        const rem = this.path.length - 1 - i;
        // the end of a partial path (as close as the known map lets us get): a dead end. Record it and replan, so the
        // planner tries another way instead of coming back here
        if (this.partial && rem <= 1) {
          const end = this.path[this.path.length - 1], ek = `${end[0]},${end[1]}`;
          this.deadMarked ??= new Set();
          if (!this.deadMarked.has(ek)) { this.deadMarked.add(ek); grid.addDeadEnd(end); ap.emit("nav", `a dead end at ${fmtCell(end)}: trying another way`, { cell: end }); }
        }
        // (a partial path ends short of the target: only real closing-in counts, or backing off and re-walking it loops forever)
        if (rem < this.bestRem - 0.5) { if (this.bestRem !== Infinity && !this.partial) this.bestT = t; this.bestRem = rem; }
        // look ahead along the path as far as the body fits through in a straight line (no clipping wall corners)
        let j = Math.min(i + 1, this.path.length - 1);
        // (and never cutting across a door, stairs or an exit the path goes round)
        const keepOff = grid.isAvoid(pc[0], pc[1]) ? null : (x, y) => grid.isAvoid(x, y) && !(this.exempt && this.exempt(x, y)) && !this.path.some((c) => c[0] === x && c[1] === y);
        for (let k = j + 1; k < Math.min(this.path.length, i + 6); k++) { if (grid.clearLine(p, grid.center(this.path[k]), rb, t, keepOff)) j = k; else break; }
        const last = j === this.path.length - 1;
        const wp = last && grid.clearLine(p, goal, rb, t, keepOff) ? goal : grid.center(this.path[j]);
        dir = sub(wp, p);
        if (len(dir) < cell * 0.05) dir = sub(goal, p);
      } else dir = sub(goal, p);
    }
    this.record(w, norm(dir));
    const blocked = this.checkBlocked(w, norm(dir));
    if (blocked && this.escape) dir = this.escape.toward ? sub(this.escape.toward, p) : this.escape.dir;
    this.lastDir = norm(dir);
    return { dir };
  }
  record(w, dir) {
    this.samples.push({ t: this.ap.t, p: w.player.p2, dir, aligned: this.ap.moveAligned !== false });
    while (this.samples.length && this.ap.t - this.samples[0].t > 0.6) this.samples.shift();
  }
  /** Moving the same way for a while but not getting anywhere: learn a wall, replan, then sidestep or back off. */
  checkBlocked(w, dir) {
    const ap = this.ap, grid = ap.grid, t = ap.t, cell = w.cell, win = 0.36;
    const old = this.samples.find((s) => t - s.t >= win - 1e-9 && t - s.t <= win + 0.25);
    if (!old || this.samples.some((s) => s.t >= old.t && (!s.aligned || dot(s.dir, dir) < 0.7))) {
      // still moving well? resolve an open incident
      if (this.incident && dist2(w.player.p2, this.incident.p) > cell * 1.2) this.closeIncident(w, true, this.incident.how.join(" → ") || "moved on");
      return false;
    }
    const moved = sub(w.player.p2, old.p), along = dot(moved, dir);
    const expected = (ap.speed || cell * 2) * (t - old.t);
    if (along > expected * 0.25 && len(moved) > cell * 0.08) {
      if (this.incident && dist2(w.player.p2, this.incident.p) > cell * 1.2) this.closeIncident(w, true, this.incident.how.join(" → ") || "moved on");
      return false;
    }
    if (ap.speed == null && len(moved) > cell * 0.05) return false;
    // blocked: which cell is in the way?
    const p = w.player.p2, pc = grid.toCell(p);
    let c = grid.toCell(add(p, scale(dir, cell * 0.8)));
    if (c[0] === pc[0] && c[1] === pc[1]) c = grid.toCell(add(p, scale(dir, cell * 1.1)));
    const occupied = w.things.some((th) => th.rel !== "item" && dist2(th.p2, grid.center(c)) < cell * 0.9);
    const mapOpen = grid.mapSolid.get(`${c[0]},${c[1]}`) === false;
    let kind = null;
    // the game's map says it's open: a snag on a corner or a creature, not a wall (never learn a wall there)
    if (occupied) kind = grid.markBlocked(c, "temp", t, mapOpen ? 1.2 : 3);
    else if (!mapOpen) {
      kind = grid.markBlocked(c, "learned", t, 4);
      if (Math.abs(dir[0]) > 0.3 && Math.abs(dir[1]) > 0.3 && this.blocks >= 1) {   // diagonal: either side cell may be the wall
        for (const sc of [grid.toCell(add(p, [Math.sign(dir[0]) * cell * 0.8, 0])), grid.toCell(add(p, [0, Math.sign(dir[1]) * cell * 0.8]))]) if (grid.mapSolid.get(`${sc[0]},${sc[1]}`) !== false) grid.markBlocked(sc, "learned", t, 4);
      }
    }
    this.blocks++;
    this.samples = [];
    if (!this.incident) {
      this.incident = { t0: t, p, cell: pc, heading: compass(dir, w.northSign), how: [], blocks: 0, scene: w.scene ?? null, sceneKey: w.sceneKey ?? null };
      ap.emit("bump", `bumped into ${occupied ? "something" : mapOpen ? "a corner" : "a wall"} at ${fmtCell(c)} heading ${compass(dir, w.northSign)}`, { cell: c });
    }
    this.incident.blocks++;
    // recovery ladder: a newly learned wall just needs a replan; otherwise centre on the cell, sidestep, back off
    if (kind === "learned" && this.blocks <= 2) { this.incident.how.push("learned a wall, replanned"); return true; }
    const step = ["center", "sidestep", "center", "backoff"][(this.blocks - 1) % 4];
    const ctr = grid.center(pc);
    if (step === "center" && dist2(p, ctr) > cell * 0.1) { this.escape = { toward: ctr, until: t + 0.35 }; this.incident.how.push("re-centred"); return true; }
    if (step === "backoff") { this.escape = { dir: scale(dir, -1), until: t + 0.3 }; this.incident.how.push("backed off"); return true; }
    const sides = [perp(dir), scale(perp(dir), -1)];
    const free = sides.find((s2) => !grid.isBlocked(...grid.toCell(add(p, scale(s2, cell))), t)) || sides[this.blocks % 2];
    this.escape = { dir: norm(free), until: t + 0.28 };
    this.incident.how.push("sidestepped");
    return true;
  }
  closeIncident(w, resolved, how) {
    const inc = this.incident; if (!inc) return;
    this.incident = null;
    const secs = this.ap.t - inc.t0;
    if (inc.blocks >= 2 || secs >= 0.8 || !resolved) {
      this.ap.incidents.push({ t: inc.t0, cell: inc.cell, heading: inc.heading, seconds: +secs.toFixed(2), resolved, how: resolved ? how : `${inc.how.join(" → ")} → ${how}`.replace(/^ → /, ""), blocks: inc.blocks, scene: inc.scene, sceneKey: inc.sceneKey });
      this.ap.emit("stuck", `${resolved ? "got unstuck" : "stuck"} at ${fmtCell(inc.cell)} heading ${inc.heading} (${r1(secs)}s, ${resolved ? how : "unresolved"})`, { cell: inc.cell, resolved, seconds: secs });
    }
    this.blocks = 0;
  }
}
const fmtCell = (c) => `(${c[0]},${c[1]})`;

// ------------------------------------------------------------------ behaviours
class Behaviour {
  constructor(o, ap, w) { this.o = o; this.ap = ap; this.t0 = ap.t; this.guardable = false; this.instant = false; this.label = o.text; }
  get age() { return this.ap.t - this.t0; }
  done(msg, data) { return { status: "done", msg, data }; }
  fail(msg) { return { status: "fail", msg }; }
  run() { return { status: "run" }; }
}

function hpPct(w) { const p = w.player; return p && p.hp != null && p.maxHp ? (100 * p.hp) / p.maxHp : null; }
const reachW = (w, cells) => cells * w.cell;

/** Moves toward a plane point or a thing (re-resolved every tick by id), with walls handled. */
const BUILDING = /(inn|tavern|house|home|shop|store|hall|church|temple|chapel|smithy|forge|barn|mill|castle|keep|tower|building|hut|cabin|manor|guild|bank|library|stable|cottage|lodge)/i;

class GoTo extends Behaviour {
  constructor(o, ap, w, { goal = null, thing = null, reach = null, label = null } = {}) {
    super(o, ap, w);
    this.guardable = true;
    this.nav = new Navigator(ap);
    this.thingId = thing ? thing.id : null; this.thingKey = thing ? thingLabel(thing) : null;
    this.goal = goal; this.reach = reach;
    this.desc = label || (thing ? thing.key : goal ? `cell ${fmtCell(ap.grid.toCell(goal))}` : "?");
    this.maxT = o.forS ?? 30;
    this.spec = null;   // set for "goto <Type>": another one that's listed can stand in when this one leaves the view
    // doors, stairs and exits are kept off unless they're where we're going (or lead to it)
    this.nav.exempt = (x, y) => this.exemptCell(x, y);
  }
  /** May the path cross this door/stairs/exit cell? Only on the goal itself, a door leading to the target, or a building's own doors. */
  exemptCell(x, y) {
    const grid = this.ap.grid, g = this.goal;
    if (this.via && this.via.door && x === this.via.cell[0] && y === this.via.cell[1]) return true;   // the way in to a target in a wall
    if (!g) return false;
    const gc = grid.toCell(g), d = Math.max(Math.abs(x - gc[0]), Math.abs(y - gc[1]));
    if (d === 0) return true;
    const th = this.lastThing;
    if (!th) return false;
    const door = grid.avoidThings.get(`${x},${y}`);
    const words = [th.name, th.type].filter(Boolean).map((s) => String(s).toLowerCase());
    if (door && door.leadsTo != null && words.some((wd) => String(door.leadsTo).toLowerCase().includes(wd) || wd.includes(String(door.leadsTo).toLowerCase()))) return true;
    // a building (an inn, a shop) that isn't a door itself: its doors are the way in
    return !th.avoid && th.rel === "neutral" && BUILDING.test(`${th.type} ${th.name || ""}`) && d <= 4;
  }
  target(w) {
    if (this.thingId != null) {
      let th = w.things.find((x) => x.id === this.thingId);
      // "goto Wolf" and the wolf we picked left the view: another one that's listed beats a stale remembered spot
      if (!th && this.spec) {
        let alt = null;
        try { alt = resolveTarget(this.spec, w, { allowRemembered: false }).things[0]; } catch { /* none listed */ }
        if (alt) { this.ap.emit("nav", `${this.desc} left the view: heading for ${alt.key} instead`); this.thingId = alt.id; this.desc = alt.key; this.thingKey = thingLabel(alt); this.nav.reset(); th = alt; }
      }
      th ??= (w.remembered || []).find((x) => x.id === this.thingId);
      if (th) { this.goal = th.p2; this.lastThing = th; this.lastSeenT = th.lastSeen ?? this.ap.t; this.outOfView = false; }
      else {
        // it left the view (went indoors, behind something, was removed): head for where it was last seen
        if (!this.lastThing) { const m = this.ap.perceiver && this.ap.perceiver.memory.get(this.thingId); if (m && m.thing.p2) { this.lastThing = m.thing; this.lastSeenT = m.lastSeen; this.goal ??= m.thing.p2; } }
        this.outOfView = true;
      }
    }
    return this.goal;
  }
  outOfViewMsg() {
    const th = this.lastThing;
    const where = th && th.p2 ? ` (last seen at cell ${fmtCell(this.ap.grid.toCell(th.p2))}${this.lastSeenT != null && this.ap.t - this.lastSeenT > 0.5 ? `, ${r1(this.ap.t - this.lastSeenT)}s ago` : ""})` : "";
    return `${this.desc} went out of view${where}`;
  }
  /**
   * A goto whose target is a solid cell (the map says so, or bumping into it taught us): pushing into it only gets
   * stuck. Go in by a door at or next to it, else to the nearest open cell. Things keep "stand next to it" (a sign
   * or a chest on a wall, a locked gate) unless no open ground touches them or they're a building beside its door.
   * Returns {goal, reach, cell, door, msg} or null.
   */
  solidDetour(w, goal) {
    const grid = this.ap.grid, t = this.ap.t, gc = grid.toCell(goal), kind = grid.blockedKind(gc[0], gc[1], t);
    const th = this.thingId != null ? this.lastThing : null;
    if (kind !== "map" && !(kind === "learned" && !th)) return null;
    const doors = grid.doorsNear(gc).filter((d) => !th || d.thing !== th && !(d.thing && d.thing.id === th.id));
    if (th) {
      if (th.avoid || th.locked) return null;
      const building = th.rel === "neutral" && BUILDING.test(`${th.type} ${th.name || ""}`);
      const side = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !grid.isBlocked(gc[0] + dx, gc[1] + dy, t) && !grid.isAvoid(gc[0] + dx, gc[1] + dy));
      if (!(building && doors.length) && side) return null;
    }
    const head = `target ${th ? `${this.desc} at ${fmtCell(gc)}` : fmtCell(gc)} is inside a wall${kind === "learned" ? " (found by bumping into it)" : ""}`;
    if (doors.length) {
      const dc = doors[0].cell;
      return { goal: grid.center(dc), reach: w.cell * 0.45, cell: dc, door: true, thing: doors[0].thing || null, msg: `${head}: ${fmtCell(gc)} is in a building; entering by its door at ${fmtCell(dc)}` };
    }
    const n = grid.nearestOpen(grid.toCell(w.player.p2), gc, { t });
    if (!n) return null;
    const d = +r1(n.d);
    return { goal: grid.center(n.cell), reach: w.cell * 0.45, cell: n.cell, door: false, msg: `${head}: nearest open cell ${fmtCell(n.cell)}, ${d} cell${d === 1 ? "" : "s"} from the target` };
  }
  /**
   * The door this goto goes through, if any: a door-like target (Door/Exit/Stairs…, or with leadsTo or enter), a map
   * door cell as the goal, or the door a target in a wall is entered by. {cell, enter, key} or null.
   */
  doorTarget(w) {
    const grid = this.ap.grid;
    if (this.via) {
      if (!this.via.door) return null;
      const th = this.via.thing;
      return { cell: this.via.cell, enter: (th && th.enter) || null, key: th ? th.key : `the door at ${fmtCell(this.via.cell)}` };
    }
    const th = this.thingId != null ? this.lastThing : null;
    if (th) return th.p2 && !th.locked && (th.avoid || th.leadsTo != null || th.enter != null) ? { cell: grid.toCell(th.p2), enter: th.enter || null, key: th.key } : null;
    if (!this.goal) return null;
    const gc = grid.toCell(this.goal), d = grid.doorsNear(gc, 0)[0];
    return d ? { cell: gc, enter: (d.thing && d.thing.enter) || null, key: d.thing ? d.thing.key : `the door at ${fmtCell(gc)}` } : null;
  }
  /**
   * Which ways to push on a door, in order: its `enter` ("S", or a vector); else from its open side into each solid
   * side (an Exit with the wall behind it; a corner exit has two), the one we came moving toward first; else on in the
   * direction we came. [{v, name}], maybe empty.
   */
  pushDirs(w, door) {
    const ns = w.northSign ?? -1;
    if (typeof door.enter === "string") return [{ v: dirVector(door.enter, ns), name: door.enter }];
    if (Array.isArray(door.enter) && len(door.enter) > 1e-9) return [{ v: norm(door.enter), name: compass(door.enter, ns) }];
    const grid = this.ap.grid, t = this.ap.t, [cx, cy] = door.cell, came = this.ap.lastMoveDir;
    const cands = [[0, 1], [0, -1], [1, 0], [-1, 0]].filter(([dx, dy]) => grid.isBlocked(cx + dx, cy + dy, t) && !grid.isBlocked(cx - dx, cy - dy, t));
    if (cands.length) return cands.map((c) => ({ c, s: came ? dot(c, came) : 0 })).sort((a, b) => b.s - a.s).map(({ c }) => ({ v: c, name: compass(c, ns) }));
    if (came && len(came) > 1e-9) { const v = Math.abs(came[0]) >= Math.abs(came[1]) ? [Math.sign(came[0]), 0] : [0, Math.sign(came[1])]; return [{ v, name: compass(v, ns) }]; }
    return [];
  }
  /**
   * Arrived at a door and the scene didn't change: step onto its cell and push each way it may be used (`enter`, or
   * the inferred ones) for 0.6 s, stepping back on if a push walks off it; a door in a wall cell (can't stand on it)
   * is pushed into from where we stand. Then press the interact key. The scene changing at any point finishes the
   * goto (observe).
   */
  pushTick(w, want) {
    const ap = this.ap, grid = ap.grid, t = ap.t, P = this.push, door = P.door;
    const pc = grid.toCell(w.player.p2), on = pc[0] === door.cell[0] && pc[1] === door.cell[1];
    const startPush = () => {
      const d = P.dirs[P.i];
      if (!d) { P.phase = "key"; P.t0 = t; return; }
      P.phase = "push"; P.t0 = t; P.tried.push(`pushed ${d.name}`);
    };
    // next to it: push into it from here (the way from our cell to its cell)
    const pushInto = () => {
      P.beside = true; P.i = 0;
      const dv = sub(grid.center(door.cell), grid.center(pc)), ns = w.northSign ?? -1;
      const v = Math.abs(dv[0]) >= Math.abs(dv[1]) ? [Math.sign(dv[0]), 0] : [0, Math.sign(dv[1])];
      P.dirs = len(dv) > 1e-9 ? [{ v, name: compass(v, ns) }] : [];
    };
    for (let i = 0; i < 8; i++) {
      if (P.phase === "side") {
        // diagonal to it: first step to the open cell beside it, so the push goes into it
        const there = pc[0] === P.side[0] && pc[1] === P.side[1];
        if (!there && t - P.t0 <= 1.5) { ap.moveTo(w, sub(grid.center(P.side), w.player.p2), want); return this.run(); }
        pushInto();
        if (!P.dirs.length) { P.tried.push("no push direction"); P.phase = "key"; P.t0 = t; continue; }
        startPush();
        continue;
      }
      if (P.phase === "step" || P.phase === "back") {
        // a door drawn in a wall cell can't be stood on: no point walking into it for 2 s
        const solid = grid.isBlocked(door.cell[0], door.cell[1], t);
        if (!on && !solid && t - P.t0 <= (P.phase === "step" ? 2 : 1.5)) { ap.moveTo(w, sub(grid.center(door.cell), w.player.p2), want); return this.run(); }
        if (P.phase === "back") { if (!on) P.tried.push("couldn't step back onto it"); P.i++; startPush(); continue; }
        if (!on) {
          const sides = [[0, 1], [0, -1], [1, 0], [-1, 0]].map(([dx, dy]) => [door.cell[0] + dx, door.cell[1] + dy]).filter(([x, y]) => !grid.isBlocked(x, y, t));
          const beside = sides.some(([x, y]) => x === pc[0] && y === pc[1]);
          if (!beside && sides.length) { P.side = sides.sort((a, b) => dist2(a, pc) - dist2(b, pc))[0]; P.phase = "side"; P.t0 = t; continue; }
          pushInto();
        } else { P.dirs = this.pushDirs(w, door); P.i = 0; }
        if (!P.dirs.length) { P.tried.push("no push direction (no enter field, no wall beside it)"); P.phase = "key"; P.t0 = t; continue; }
        startPush();
        continue;
      }
      if (P.phase === "push") {
        const d = P.dirs[P.i];
        if (!on && !P.beside) { P.tried[P.tried.length - 1] = `pushed ${d.name} (that walked off it)`; P.phase = "back"; P.t0 = t; continue; }
        if (t - P.t0 < 0.6 - 1e-9) { ap.moveTo(w, d.v, want); return this.run(); }
        P.tried[P.tried.length - 1] = `pushed ${d.name} for 0.6s`;
        P.i++; startPush();
        continue;
      }
      const c = ap.cfg.controls.interact;
      if (c && !P.pressed) { want.taps.push({ label: "interact", c, frames: ap.cfg.controls.tapFrames }); P.pressed = true; P.t0 = t; P.tried.push(`pressed ${controlLabel(c)}`); return this.run(); }
      if (c && t - P.t0 < 0.5) return this.run();
      return this.done(`arrived at ${this.desc} — ${P.beside ? "next to" : "standing on"} ${door.key} at ${fmtCell(door.cell)}: ${P.tried.join(", ")}: the scene didn't change`);
    }
    return this.run();
  }
  tick(w, want) {
    // entering the target (a building, a door, an exit) changed the scene: that was the point of the order
    if (this.sceneDone) return this.done(this.sceneDone);
    if (this.push) return this.pushTick(w, want);
    const goal = this.target(w);
    // forgotten (not just out of view): it was killed, picked up or removed near you, e.g. by an autofight on the way
    const mem = this.outOfView && this.ap.perceiver ? this.ap.perceiver.memory.get(this.thingId) : null;
    if (mem && mem.gone && (mem.why === "killed" || mem.why === "picked up")) return this.done(`${this.desc} is gone (${mem.why === "killed" ? "it died" : "picked up"} on the way)`);
    if (!goal) return this.fail(this.outOfViewMsg());
    const reach = this.reach ?? reachW(w, this.thingId != null ? 1.0 : 0.45);
    if (this.ap.platform) {
      const r = this.ap.platform.tick(w, want, { targetX: goal[0], targetY: goal[1], reachX: Math.max(reach, w.cell * 0.4) });
      if (r.arrived) return this.done(`arrived at ${this.desc}`);
      if (r.fail) return this.fail(r.fail);
      return this.age > this.maxT ? this.fail(`gave up after ${r1(this.age)}s`) : this.run();
    }
    // a target in a wall: decided up front from the map, or the moment bumping into it shows it's solid
    if (this.o.verb === "goto" && !this.outOfView && (!this.via || this.ap.grid.isBlocked(this.via.cell[0], this.via.cell[1], this.ap.t)) && (this.detours || 0) < 3) {
      const v = this.solidDetour(w, goal);
      if (v) {
        this.detours = (this.detours || 0) + 1;
        this.via = v; this.note = null;
        this.nav.closeIncident(w, true, "the target is a wall: changed course");
        this.nav.reset();
        this.ap.emit("nav", v.msg, { cell: v.cell });
      }
    }
    const via = this.via;
    const r = this.nav.tick(w, via ? via.goal : goal, via ? via.reach : reach);
    if (r.arrived && via && !via.door) return this.done(`${via.msg} — arrived there`);
    if (r.arrived && this.outOfView && !via) return this.fail(`${this.outOfViewMsg()}: reached that spot, but it isn't in view here`);
    // at a door, exit or stairs and the scene didn't change: some games want you on the tile pushing a way (an Exit
    // you leave by pushing south into the wall behind it), or the interact key. Give the game a moment, then try those
    if (r.arrived && this.o.verb === "goto") {
      const door = this.doorTarget(w);
      if (door) {
        this.inDoorT ??= this.ap.t;
        const pc = this.ap.grid.toCell(w.player.p2);
        if (pc[0] === door.cell[0] && pc[1] === door.cell[1] && this.ap.t - this.inDoorT < 0.3) return this.run();
        this.push = { door, phase: "step", t0: this.ap.t, tried: [], pressed: false };
        return this.pushTick(w, want);
      }
    }
    if (r.arrived) return this.done(`arrived at ${this.desc}${this.note ? ` — ${this.note}` : ""}`);
    if (r.fail) return this.fail(`${via ? `${via.msg} — ` : ""}${this.ap.blockerHint(w, r.fail, { dir: this.nav.lastDir, goal: via ? via.goal : goal, targetId: this.thingId })}`);
    this.ap.moveTo(w, r.dir, want);
    return this.age > this.maxT ? this.fail(`gave up reaching ${this.desc} after ${r1(this.age)}s`) : this.run();
  }
}

class Explore extends Behaviour {
  constructor(o, ap, w) {
    super(o, ap, w);
    this.guardable = true;
    this.dirName = o.dir; this.dir = o.dir ? dirVector(o.dir, w.northSign) : null;
    this.nav = new Navigator(ap); this.target = null; this.pickT = -1e9; this.failed = new Set(); this.fresh0 = ap.grid.seen.size;
    this.maxT = o.forS ?? 1e9;
  }
  tick(w, want) {
    const ap = this.ap, grid = ap.grid, t = ap.t;
    if (this.age > this.maxT) return this.done(`explored for ${r1(this.age)}s (+${grid.seen.size - this.fresh0} cells seen)`);
    if (ap.platform) {
      const dirX = this.dir ? Math.sign(this.dir[0]) || 1 : 1;
      const r = ap.platform.tick(w, want, { targetX: w.player.p2[0] + dirX * w.cell * 40, reachX: w.cell * 0.2 });
      if (r.fail) return this.fail(r.fail);
      return this.run();
    }
    const pc = grid.toCell(w.player.p2);
    const reached = this.target && Math.hypot(this.target[0] - pc[0], this.target[1] - pc[1]) <= 1.2;
    if (!this.target || reached || t - this.pickT > 4 || grid.seen.has(`${this.target[0]},${this.target[1]}`)) {
      this.target = grid.frontier(pc, { t, dir: this.dir, avoid: this.failed });
      this.pickT = t; this.nav.reset();
      if (!this.target) return this.done(`nothing left to explore${this.dirName ? ` to the ${this.dirName}` : ""} (+${grid.seen.size - this.fresh0} cells seen)`);
    }
    const r = this.nav.tick(w, grid.center(this.target), w.cell * 0.6, { stuckLimit: 2.5 });
    if (r.fail || r.arrived) { if (r.fail) this.failed.add(`${this.target[0]},${this.target[1]}`); this.target = null; return this.run(); }
    ap.moveTo(w, r.dir, want);
    return this.run();
  }
}

class Follow extends Behaviour {
  constructor(o, ap, w, thing) { super(o, ap, w); this.guardable = true; this.id = thing.id; this.key = thing.key; this.nav = new Navigator(ap); this.maxT = o.forS ?? 1e9; }
  tick(w, want) {
    const th = w.things.find((x) => x.id === this.id);
    if (!th) return this.fail(`${this.key} is gone`);
    if (this.age > this.maxT) return this.done(`followed ${this.key} for ${r1(this.age)}s`);
    const r = this.nav.tick(w, th.p2, w.cell * 1.8, { stuckLimit: 4 });
    if (r.fail) return this.fail(r.fail);
    if (!r.arrived) this.ap.moveTo(w, r.dir, want); else this.nav.bestT = this.ap.t;
    return this.run();
  }
}

class Fight extends Behaviour {
  constructor(o, ap, w) {
    super(o, ap, w);
    this.spec = o.target;
    this.mode = o.mode || null;
    this.retreat = o.retreat ?? null;
    this.kite = o.kite ?? null;
    this.plural = !!(o.target && o.target.plural) || !o.target;
    this.nav = new Navigator(ap);
    this.kills = 0; this.blockUntil = -1; this.maxT = o.forS ?? 60;
    this.start = w.player && w.player.p2 ? w.player.p2.slice() : null;   // the leash: a fight doesn't chase across the map
    // asked for a defence the game has no control for: use the best one it has, and say so
    const cc = ap.cfg.controls;
    if ((this.mode === "block" && !cc.block) || (this.mode === "dodge" && !cc.dodge)) {
      const alt = cc.block ? "block" : cc.dodge ? "dodge" : "backoff";
      ap.note(`no ${this.mode} control in this game: defending with ${alt} instead`);
      this.label = `${o.text} (${alt})`;
      this.mode = alt;
    }
    this.pick(w, true);
  }
  defaultMode() {
    const c = this.ap.cfg.controls;
    if (this.mode) return this.mode;
    if (!this.ap.policy.guard) return "aggressive";
    return this.ap.cfg.guardMode || (c.block ? "block" : c.dodge ? "dodge" : "backoff");
  }
  pick(w, first = false) {
    let cands;
    if (this.spec && !(this.spec.category === "any" && !this.spec.words.length)) {
      try { cands = resolveTarget(this.spec, w, { prefer: "hostile", allowRemembered: first }).things; }
      catch (e) { if (first) throw e; cands = []; }
      cands = cands.filter((th) => !th.dead);
    } else cands = w.things.filter((th) => th.rel === "hostile" && !th.dead && th.dist <= this.ap.cfg.alert * 2.5);
    if (!first) cands = cands.filter((th) => th.dist <= this.ap.cfg.alert * 2);
    if (first && !cands.length) throw new OrderError(this.spec ? `no "${this.spec.raw}" to fight here` : "no enemies around to fight", "explore to find some, or name one from the observation");
    const th = cands[0] || null;
    this.target = th ? th.id : null; this.targetKey = th ? th.key : this.targetKey;
    this.typeName = this.typeName || (th ? th.type : null);
    return th;
  }
  tick(w, want) {
    const ap = this.ap, cfg = ap.cfg, t = ap.t, c = cfg.controls;
    if (w.dead) return this.fail("you died");
    const pct = hpPct(w), retreat = this.retreat ?? ap.policy.retreat;
    if (retreat && pct != null && pct < retreat) { ap.replaceWith(new Flee({ verb: "flee", text: `flee (hp ${Math.round(pct)}% < ${retreat}%)` }, ap, w), `retreating at ${Math.round(pct)}% hp`); return this.run(); }
    let th = w.things.find((x) => x.id === this.target && !x.dead);
    if (!th) {
      if (this.target != null) this.kills++;
      const prevKey = this.targetKey;
      th = this.plural || (this.spec && this.spec.category) ? this.pick(w) : null;
      if (!th) return this.done(this.kills ? `${this.kills > 1 ? `${this.kills} enemies` : prevKey} defeated` : `${prevKey || "target"} is gone`);
    }
    if (this.age > this.maxT) return this.fail(`fight still going after ${r1(this.age)}s`);
    if (ap.platform) return ap.platform.fight(w, want, th, this) || this.run();
    const mode = this.defaultMode();
    const p = w.player.p2;
    const reach = reachW(w, cfg.reach.attack);
    const d = dist2(th.p2, p);
    // ---- telegraph reflex
    if (mode !== "aggressive") {
      const threat = ap.reactingThreat(w, reach * 1.9);
      if (threat) {
        if (ap.defend(w, want, threat, mode === "kite" ? "backoff" : mode)) return this.run();
      } else if (t < this.blockUntil && c.block && mode === "block") { want.held.set("block", c.block); return this.run(); }
    }
    if (cfg.profile === "fps") return this.shoot(w, want, th) || this.run();
    // ---- spacing
    if (mode === "kite" && this.kite) {
      const k = this.kite * w.cell;
      if (d < k * 0.75) { ap.moveTo(w, sub(p, th.p2), want); }
      else if (d > k * 1.3) { const r = this.nav.tick(w, th.p2, k, { stuckLimit: 5 }); if (r.dir) ap.moveTo(w, r.dir, want); }
      if (ap.profile.face(w, th.p2, want)) ap.attack(want);
      return this.run();
    }
    if (d > reach * 0.85) {
      // the leash: don't chase a target across the map (out of the village, into another region)
      if (this.start && (this.leashCells ?? cfg.leash) > 0 && dist2(p, this.start) > (this.leashCells ?? cfg.leash) * w.cell && d > reach * 2)
        return this.done(`stopped chasing ${th.key}: it led you ${r1(dist2(p, this.start) / w.cell)} cells from where the fight started (fight it again to keep going)`);
      const r = this.nav.tick(w, th.p2, reach * 0.8, { stuckLimit: 4 });
      if (r.fail) return this.fail(`can't reach ${th.key}: ${r.fail}`);
      if (r.dir) ap.moveTo(w, r.dir, want);
      // swing as soon as it's in reach while closing in
      if (d <= reach && ap.profile.face(w, th.p2, want)) ap.attack(want);
      return this.run();
    }
    this.nav.bestT = t; this.nav.best = Infinity;
    if (ap.profile.face(w, th.p2, want)) ap.attack(want);
    return this.run();
  }
  /** fps: aim at the target and fire when the aim is on it; strafe on a rhythm; close in or hold range. */
  shoot(w, want, th) {
    const ap = this.ap, cfg = ap.cfg, c = cfg.controls, p = w.player.p2, d = dist2(th.p2, p);
    if (w.player.ammo === 0 && c.reload) { want.taps.push({ label: "reload", c: c.reload, frames: 2 }); }
    const aim = ap.profile.aim(w, th, want);
    const size = Math.atan2(0.45, Math.max(0.5, d));
    const onTarget = Math.abs(aim.yawErr) < size * cfg.fps.aimTolerance + 0.01 && Math.abs(aim.pitchErr) < size * 1.6 + 0.02;
    if (onTarget && th.los !== false) { want.held.set("attack", c.attack); ap.lastAttackT = ap.t; }
    if (this.mode === "hold") {
      // hold position: shoot what's in sight, never chase; switch to another visible enemy when this one hides
      if (th.los === false) {
        const vis = w.things.find((x) => x.rel === "hostile" && !x.dead && x.los !== false && x.dist <= (cfg.fps.range ?? 12) * 2.5);
        if (vis) { this.target = vis.id; this.targetKey = vis.key; }
        this.unseen = (this.unseen ?? ap.t);
        if (ap.t - this.unseen > 2.5) return this.done(`no enemy in sight for 2.5s (held position)`);
      } else this.unseen = null;
      if (cfg.fps.strafe && th.los !== false) { const phase = Math.floor(ap.t / 0.9) % 2 ? 1 : -1; ap.profile.move(w, scale(perp(norm(sub(th.p2, p))), phase), want, { faceDir: sub(th.p2, p), turn: false }); }
      return null;
    }
    const prefer = (this.kite ?? cfg.fps.range ?? 12) * w.cell;
    let mv = null;
    if (th.los === false || d > prefer * 1.4) {
      // chasing someone you can't see: not up or down a floor (the ground map can't get you there, you end up in a
      // pocket under them), not for long without seeing them, and not across the map (the leash)
      const other = ap.visibleFoe(w, (x) => x.id !== th.id);
      const swap = (why) => { if (other) { this.target = other.id; this.targetKey = other.key; return null; } return this.done(why); };
      if (ap.otherFloor(w, th)) { const [a, b] = cfg.plane, dz = th.pos[3 - a - b] - w.player.pos[3 - a - b]; return swap(`${th.key} is on another floor (${r1(Math.abs(dz))} m ${dz > 0 ? "above" : "below"} you): not chasing it; take the stairs or wait for it`); }
      if (th.los === false) { this.noLosSince ??= ap.t; if (ap.t - this.noLosSince > 4) return swap(`lost ${th.key} behind walls (4s out of sight)`); }
      else this.noLosSince = null;
      if (this.start && cfg.leash > 0 && dist2(p, this.start) > cfg.leash * w.cell && th.los === false) return swap(`stopped chasing ${th.key}: ${r1(dist2(p, this.start) / w.cell)} cells from where the fight started`);
      const r = this.nav.tick(w, th.p2, prefer * 0.8, { stuckLimit: 3.5 });
      if (r.fail) return other ? swap("") : this.fail(`can't reach ${th.key}: ${r.fail}`);
      mv = r.dir;
    } else { this.noLosSince = null; if (d < prefer * 0.4) mv = sub(p, th.p2); }
    if (cfg.fps.strafe && th.los !== false) {
      const phase = Math.floor(ap.t / 0.9) % 2 ? 1 : -1;
      const side = scale(perp(norm(sub(th.p2, p))), phase);
      mv = mv ? add(norm(mv), scale(side, 0.6)) : side;
    }
    ap.profile.move(w, mv, want, { faceDir: sub(th.p2, p), turn: false });
    return null;
  }
}

class Flee extends Behaviour {
  constructor(o, ap, w) { super(o, ap, w); this.nav = new Navigator(ap); this.goal = null; this.pickT = -1e9; this.maxT = o.forS ?? 6; }
  tick(w, want) {
    const ap = this.ap, t = ap.t, grid = ap.grid;
    // threats: enemies near you, plus (fps) anyone who can shoot you from range
    const fpsRange = (ap.cfg.fps?.range ?? 12) * 2.2;
    const threats = w.things.filter((th) => th.rel === "hostile" && !th.dead && (th.dist <= ap.cfg.alert * 1.6 || (ap.cfg.profile === "fps" && th.los === true && th.dist <= fpsRange)));
    const pct = hpPct(w);
    if (!threats.length) return this.done(`got away${pct != null ? ` (hp ${Math.round(pct)}%)` : ""}`);
    if (this.age > this.maxT) return this.done(`fled for ${r1(this.age)}s; ${threats.length} still near`);
    if (ap.platform) { const away = Math.sign(w.player.p2[0] - threats[0].p2[0]) || -1; ap.platform.tick(w, want, { targetX: w.player.p2[0] + away * w.cell * 20, reachX: 1 }); return this.run(); }
    if (!this.goal || t - this.pickT > 1.0) { this.goal = ap.safeSpot(w, threats); this.pickT = t; this.nav.reset(); }
    const r = this.goal ? this.nav.tick(w, this.goal, w.cell * 0.5, { stuckLimit: 2 }) : { dir: null };
    const dir = r.dir || norm(threats.reduce((acc, th) => add(acc, norm(sub(w.player.p2, th.p2))), [0, 0]));
    if (r.arrived) this.goal = null;
    ap.moveTo(w, dir, want);
    return this.run();
  }
}

class Talk extends Behaviour {
  constructor(o, ap, w, thing) { super(o, ap, w); this.guardable = true; this.thing = thing; this.go = new GoTo(o, ap, w, { thing, reach: reachW(w, ap.cfg.reach.interact) * 0.8 }); this.phase = "go"; this.tries = 0; this.maxT = o.forS ?? 30; this.wrong = []; }
  /**
   * Did the right one answer? When the game names the speaker, it must match the target's name or type. A speaker that
   * matches neither only counts as someone else when the target has a name, or another listed thing matches it
   * (a game whose people have no names in the snapshot can't be checked).
   */
  whoAnswered(w, th) {
    const d = w.dialogue, sp = d && d.speaker != null ? String(d.speaker).trim().toLowerCase() : "";
    if (!sp) return { ok: true };
    const fits = (x) => [x.name, x.type].filter(Boolean).map((s) => String(s).toLowerCase()).some((n) => n.length > 1 && (sp === n || sp.includes(n) || n.includes(sp)));
    if (fits(th)) return { ok: true };
    const other = w.things.filter((x) => x.id !== th.id && !x.dead && fits(x)).sort((a, b) => a.dist - b.dist)[0] || null;
    if (!th.name && !other) return { ok: true };
    return { ok: false, speaker: d.speaker, other };
  }
  tick(w, want) {
    const ap = this.ap, c = ap.cfg.controls;
    const th = w.things.find((x) => x.id === this.thing.id) || this.thing;
    if (w.dialogue && this.phase !== "cancel") {
      const who = this.whoAnswered(w, th);
      if (who.ok) return this.done(`dialogue: ${w.dialogue.speaker ? `${w.dialogue.speaker}: ` : ""}"${clip(w.dialogue.text, 90)}"`);
      // someone else answered (a child standing closer than the guard): close it, step closer, face the right one, retry
      const who2 = `${who.speaker}${who.other ? ` (${who.other.key})` : ""}`;
      if (!this.wrong.includes(who2)) this.wrong.push(who2);
      ap.emit("note", `${who2} answered instead of ${th.key}${c.cancel && this.tries < 2 ? ": closing it and trying again closer" : ""}`);
      if (!c.cancel || this.tries >= 2) return this.fail(`${who2} answered instead of ${th.key} — that dialogue is open: choose an option or press cancel, then get right next to ${th.key} (or name who answered)`);
      this.tries++;
      want.taps.push({ label: "cancel", c: c.cancel, frames: c.tapFrames });
      this.phase = "cancel"; this.cancelT = ap.t;
      return this.run();
    }
    if (this.age > this.maxT) return this.fail(`couldn't talk to ${this.thing.key}${this.wrong.length ? ` (${this.wrong.join(", ")} answered instead)` : ""}`);
    if (!c.interact) return this.fail("no interact control is configured (play.controls.interact)");
    if (this.phase === "cancel") {
      if (w.dialogue) {
        if (ap.t - this.cancelT > 1.2) return this.fail(`${this.wrong.at(-1)} answered instead of ${th.key}, and cancel didn't close that dialogue — choose an option to end it`);
        if (ap.t - this.cancelT > 0.4 && !this.cancelAgain) { this.cancelAgain = true; want.taps.push({ label: "cancel", c: c.cancel, frames: c.tapFrames }); }
        return this.run();
      }
      this.cancelAgain = false;
      this.go = new GoTo(this.o, ap, w, { thing: th, reach: reachW(w, ap.cfg.reach.interact) * (this.tries === 1 ? 0.45 : 0.25) });
      this.phase = "go";
      return this.run();
    }
    if (this.phase === "go") {
      const r = this.go.tick(w, want);
      if (r.status === "fail") return r;
      if (r.status === "done") { this.phase = "face"; this.faceT = ap.t; }
      return this.run();
    }
    if (this.phase === "face") {
      if (ap.profile.face(w, th.p2, want) || ap.t - this.faceT > 0.3) { this.phase = "press"; }
      return this.run();
    }
    if (this.phase === "press") { want.taps.push({ label: "interact", c: c.interact, frames: c.tapFrames }); this.phase = "wait"; this.waitT = ap.t; return this.run(); }
    if (this.phase === "wait" && ap.t - this.waitT > 0.6) {
      this.tries++;
      if (this.tries >= 3) return this.fail(`pressed interact next to ${th.key} ${this.tries}× but no dialogue opened${this.wrong.length ? ` (${this.wrong.join(", ")} answered earlier)` : ""}`);
      this.go = new GoTo(this.o, ap, w, { thing: th, reach: reachW(w, ap.cfg.reach.interact) * (this.tries === 1 ? 0.5 : 0.3) });
      this.phase = "go";
    }
    return this.run();
  }
}

class Interact extends Behaviour {
  constructor(o, ap, w, thing) { super(o, ap, w); this.thing = thing; this.go = thing ? new GoTo(o, ap, w, { thing, reach: reachW(w, ap.cfg.reach.interact) * 0.8 }) : null; this.phase = thing ? "go" : "press"; this.notice0 = w.notice; }
  tick(w, want) {
    const ap = this.ap, c = ap.cfg.controls;
    if (!c.interact) return this.fail("no interact control is configured (play.controls.interact)");
    if (this.phase === "go") { const r = this.go.tick(w, want); if (r.status === "fail") return r; if (r.status === "done") { this.phase = "face"; this.faceT = ap.t; } return this.run(); }
    if (this.phase === "face") { if (ap.profile.face(w, this.thing.p2, want) || ap.t - this.faceT > 0.3) this.phase = "press"; return this.run(); }
    if (this.phase === "press") { want.taps.push({ label: "interact", c: c.interact, frames: c.tapFrames }); this.phase = "wait"; this.waitT = ap.t; return this.run(); }
    if (w.dialogue) return this.done(`dialogue opened: ${w.dialogue.speaker || ""} "${clip(w.dialogue.text, 80)}"`);
    if (ap.t - this.waitT > 0.35) return this.done(w.notice && w.notice !== this.notice0 ? `interacted${this.thing ? ` with ${this.thing.key}` : ""}: "${clip(w.notice, 90)}"` : `interacted${this.thing ? ` with ${this.thing.key}` : ""}`);
    return this.run();
  }
}

class Choose extends Behaviour {
  constructor(o, ap, w) {
    super(o, ap, w);
    const d = w.dialogue;
    if (!d) throw new OrderError("no dialogue is open — talk to someone first");
    const n = d.options.length;
    let idx = o.option === -1 ? n : o.option;
    if (o.optionText) {
      const q = o.optionText.toLowerCase(), words = q.split(/\W+/).filter((x) => x.length > 2);
      let best = 0, bs = 0;
      d.options.forEach((opt, i) => { const ol = opt.toLowerCase(); const s = ol.includes(q) ? 100 : words.filter((x) => ol.includes(x)).length; if (s > bs) { bs = s; best = i + 1; } });
      if (!best) throw new OrderError(`no option matches "${o.optionText}" — options: ${d.options.map((x, i) => `${i + 1}) ${x}`).join("  ")}`);
      idx = best;
    }
    if (n && (idx < 1 || idx > n)) throw new OrderError(`there ${n === 1 ? "is only 1 option" : `are only ${n} options`}: ${d.options.map((x, i) => `${i + 1}) ${x}`).join("  ")}`);
    this.idx = idx; this.text0 = JSON.stringify(d); this.chosen = d.options[idx - 1] ?? `#${idx}`; this.phase = "press";
    this.watch = new StateWatch(w);
  }
  tick(w, want) {
    const ap = this.ap, c = ap.cfg.controls, ch = c.choose;
    if (this.phase === "press") {
      if (ch.mode === "list") { const k = ch.keys[this.idx - 1]; if (!k) return this.fail(`no control configured for option ${this.idx}`); want.taps.push({ label: "choose", c: k, frames: c.tapFrames }); }
      else if (ch.mode === "numbers") want.taps.push({ label: "choose", c: parseControl(String(this.idx)), frames: c.tapFrames });
      else {
        // arrows: move the cursor from `selected` (0-based) or from the top, then confirm
        const d = w.dialogue, sel = d.selected != null ? d.selected : null;
        const up = c.move.up || parseControl("up"), down = c.move.down || parseControl("down");
        const seq = [];
        if (sel == null) for (let i = 0; i < d.options.length; i++) seq.push(up);
        const from = sel == null ? 0 : sel, to = this.idx - 1;
        for (let i = from; i < to; i++) seq.push(down);
        for (let i = from; i > to; i--) seq.push(up);
        seq.push(c.confirm || parseControl("enter"));
        let at = 0;
        for (const k of seq) { want.raw.push({ at, ...controlEventRaw(k, true) }, { at: at + 2, ...controlEventRaw(k, false) }); at += 6; }
        this.waitFrames = at;
      }
      this.phase = "wait"; this.waitT = ap.t;
      return this.run();
    }
    const now = w.dialogue ? JSON.stringify(w.dialogue) : null;
    if (now !== this.text0) return this.done(`chose ${this.idx}) "${clip(this.chosen, 50)}"${w.dialogue ? ` → ${w.dialogue.speaker ? `${w.dialogue.speaker}: ` : ""}"${clip(w.dialogue.text, 100)}"` : " → dialogue closed"}`);
    // a choice that only toggles something (a difficulty button gets a CSS class): the snapshot changed and stayed so
    // (after the dialogue has had half a second to answer, so a slow dialogue still reports its new line)
    const changed = this.watch.check(w);
    if (changed && ap.t - this.waitT > 0.5 + (this.waitFrames || 0) / ap.fps) return this.done(`chose ${this.idx}) "${clip(this.chosen, 50)}": state changed (${changed}), dialogue unchanged`);
    // many games swallow the first confirm while the text is still typing out: press it once more
    if (ch.mode === "arrows" && !this.again && ap.t - this.waitT > 0.35 + (this.waitFrames || 0) / ap.fps) {
      this.again = true;
      want.taps.push({ label: "confirm", c: c.confirm || parseControl("enter"), frames: c.tapFrames });
      return this.run();
    }
    if (ap.t - this.waitT > 1.0 + (this.waitFrames || 0) / ap.fps) return this.fail(`chose ${this.idx} but nothing changed: not the dialogue, not the game state (is play.controls.choose right?)`);
    return this.run();
  }
}

// ------------------------------------------------------------------ turn-based / card / menu games
const VOLATILE = /(^|\.)(t|time|times|frame|frames|clock|tick|ticks|elapsed|timer|timers|now|seed|fps|dt|delta|anim\w*|animating|particles|camera|pointer|touches|perf)(\.|$|\[)/i;
/** The snapshot as flat path → short JSON (3 levels; arrays as one value), without time-like fields. */
export function flatState(state, pre = "", out = {}, depth = 0) {
  if (!state || typeof state !== "object") return out;
  for (const [k, v] of Object.entries(state)) {
    const p = pre ? `${pre}.${k}` : k;
    if (VOLATILE.test(p)) continue;
    if (v && typeof v === "object" && !Array.isArray(v) && depth < 2) flatState(v, p, out, depth + 1);
    else { const j = JSON.stringify(v); out[p] = j && j.length > 2000 ? `${j.length}:${j.slice(0, 2000)}` : j; }
  }
  return out;
}
/**
 * Did the game's state change because of what we just sent? A field counts when it differs from before the input and
 * held the same value over two looks in a row (counters and moving things keep changing, a toggled setting doesn't).
 * `check(w)` returns the changed fields ("difficulty, ui.selected") or null.
 */
class StateWatch {
  constructor(w) { this.base = flatState(w.snap && w.snap.state); this.last = null; }
  check(w) {
    const now = flatState(w.snap && w.snap.state), last = this.last;
    this.last = now;
    if (!last) return null;
    const keys = new Set([...Object.keys(now), ...Object.keys(this.base)]);
    const changed = [...keys].filter((k) => now[k] !== this.base[k] && now[k] === last[k]);
    if (!changed.length) return null;
    const named = changed.filter((k) => !/(^|\.)digest$/.test(k));
    const top = [...new Set(named.map((k) => k.split(".").slice(0, 2).join(".")))];
    return top.length ? `${top.slice(0, 4).join(", ")}${top.length > 4 ? ` +${top.length - 4}` : ""}` : "hidden state (digest)";
  }
}

/** Find a choice by number or by words of its label. Throws OrderError listing the choices. */
export function matchChoice(choices, o) {
  const list = () => choices.slice(0, 12).map((c) => `${c.n}) ${clip(c.label, 40)}`).join("  ") + (choices.length > 12 ? `  … (${choices.length} in all)` : "");
  if (!o.optionText) {
    const idx = o.option === -1 ? choices.length : o.option;
    const c = choices.find((x) => x.n === idx);
    if (!c) throw new OrderError(`there ${choices.length === 1 ? "is only 1 choice" : `are ${choices.length} choices`}: ${list()}`);
    return c;
  }
  const q = o.optionText.toLowerCase().trim(), norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}♠♣♥♦]+/gu, " ").trim();
  const words = norm(q).split(" ").filter(Boolean);
  let best = null, bs = 0;
  for (const c of choices) {
    const l = c.label.toLowerCase(), nl = norm(l), lw = new Set(nl.split(" "));
    let s = l === q || nl === norm(q) ? 1000 : l.includes(q) ? 500 : 0;
    if (!s) {
      const whole = words.filter((x) => lw.has(x)).length, part = words.filter((x) => !lw.has(x) && x.length > 2 && nl.includes(x)).length;
      s = whole + part >= Math.ceil(words.length / 2) ? whole * 10 + part * 4 + (whole + part === words.length ? 5 : 0) : 0;
    }
    if (s && c.legal) s += 1;   // ties go to a legal move
    if (s > bs) { bs = s; best = c; }
  }
  if (!best) throw new OrderError(`no choice matches "${o.optionText}" — choices: ${list()}`, "pick by number, or by words from the label");
  return best;
}

/**
 * pick: send one of the game's choices (state.choices) the way play.pick says (a game call, a click on its rect, its
 * key or number key), then wait until the game reacts: a dialogue, new choices, the turn passing, any lasting state
 * change, or the call's acknowledgement.
 */
class Pick extends Behaviour {
  constructor(o, ap, w) {
    super(o, ap, w);
    this.choice = matchChoice(w.choices, o);
    this.watch = new StateWatch(w);
    this.sig0 = choiceSig(w); this.dlg0 = w.dialogue ? JSON.stringify(w.dialogue) : null; this.turn0 = w.yourTurn; this.scene0 = w.scene;
    this.phase = "send";
  }
  get desc() { return `picked ${this.choice.n}) "${clip(this.choice.label, 50)}"`; }
  route() {
    const cfg = this.ap.cfg, p = cfg.pick, c = this.choice;
    if (p.mode === "call" || (p.mode === "auto" && p.call)) return "call";
    if (p.mode === "click") return "click";
    if (p.mode === "keys") return "keys";
    return c.key ? "key" : c.rect ? "click" : "keys";
  }
  tick(w, want) {
    const ap = this.ap, cfg = ap.cfg, c = this.choice;
    if (this.phase === "send") {
      const how = this.route();
      this.phase = "wait"; this.waitT = ap.t;
      if (how === "call") {
        const args = cfg.pick.args.map((a) => (a === "index" || a === "n" ? c.n - 1 : a === "number" ? c.n : a === "label" ? c.label : a === "choice" ? c.raw : c.id));
        return { status: "call", name: cfg.pick.call, args };
      }
      if (how === "click") {
        const r = c.rect;
        if (!r) return this.fail(`choice ${c.n} has no rect or pos to click (give choices a rect, or set play.pick)`);
        const x = Math.round(r.length >= 4 ? r[0] + r[2] / 2 : r[0]), y = Math.round(r.length >= 4 ? r[1] + r[3] / 2 : r[1]);
        want.raw.push({ at: 0, type: "mouse", x, y }, { at: 0, type: "mouse", x, y, button: 0, down: true }, { at: 2, type: "mouse", x, y, button: 0, down: false });
        return this.run();
      }
      if (how === "key") { want.taps.push({ label: "pick", c: parseControl(c.key), frames: cfg.controls.tapFrames }); return this.run(); }
      const ch = cfg.controls.choose;
      if (ch.mode === "list") { const k = ch.keys[c.n - 1]; if (!k) return this.fail(`no control configured for choice ${c.n} (play.controls.choose has ${ch.keys.length})`); want.taps.push({ label: "pick", c: k, frames: cfg.controls.tapFrames }); return this.run(); }
      if (c.n > 9) return this.fail(`choice ${c.n} has no number key: set play.pick (a call or click) to pick past 9`);
      want.taps.push({ label: "pick", c: parseControl(String(c.n)), frames: cfg.controls.tapFrames });
      return this.run();
    }
    // the game's answer to a call: false / {ok: false} / {error} is a refusal
    if (this.result !== undefined && !this.judged) {
      this.judged = true;
      const r = this.callValue;
      if (this.callFailed) return this.fail(this.result);
      if (r === false || (r && typeof r === "object" && (r.ok === false || r.legal === false || r.error))) return this.fail(`${this.desc}: the game refused it${r && typeof r === "object" && (r.error || r.reason || r.message) ? ` ("${clip(String(r.error || r.reason || r.message), 120)}")` : ""}`);
    }
    const what = [];
    if (w.dialogue && JSON.stringify(w.dialogue) !== this.dlg0) what.push(`${w.dialogue.speaker ? `${w.dialogue.speaker}: ` : ""}"${clip(w.dialogue.text, 100)}"`);
    else if (!w.dialogue && this.dlg0) what.push("dialogue closed");
    if (w.scene !== this.scene0 && w.scene != null) what.push(`scene ${w.scene}`);
    if (this.turn0 !== w.yourTurn && w.yourTurn != null) what.push(w.yourTurn ? "your turn" : "the turn passed");
    if (choiceSig(w) !== this.sig0) what.push(w.choices ? `${w.choices.length} choice${w.choices.length === 1 ? "" : "s"} now` : "no choices now");
    if (what.length) return this.done(`${this.desc} → ${what.join(", ")}`);
    const changed = this.watch.check(w);
    if (changed) return this.done(`${this.desc}: state changed (${changed})`);
    if (this.result !== undefined && !this.callFailed && ap.t - this.waitT > 0.5) return this.done(`${this.desc}: the game accepted it (${this.result}), nothing visible changed yet`);
    if (ap.t - this.waitT > 1.0) return this.fail(`${this.desc} but nothing changed (is play.pick right? choices: ${this.route()})`);
    return this.run();
  }
}
const choiceSig = (w) => (w.choices ? w.choices.map((c) => `${c.label}|${c.legal}|${c.selected}`).join("\n") : "");

/**
 * Turn profile `wait`: until it becomes your turn, the choices change, a dialogue opens or changes, the scene changes
 * or the game ends; `wait 10` caps it at 10 s (a bare `wait` at play.turnWait, 30 s).
 */
class WaitTurn extends Behaviour {
  constructor(o, ap, w) {
    super(o, ap, w);
    this.cap = o.untimed ? (o.forS ?? ap.cfg.turnWait) : o.seconds;
    this.sig0 = choiceSig(w); this.dlg0 = w.dialogue ? JSON.stringify(w.dialogue) : null; this.turn0 = w.yourTurn; this.scene0 = w.scene;
    this.already = o.untimed && w.yourTurn === true;
    this.over0 = !!(w.won || w.dead || w.over);
  }
  tick(w) {
    if (this.already) return this.done("it's already your turn");
    if ((w.won || w.dead || w.over) && !this.over0) return this.done(w.won ? "the game reports a win" : "the game is over");
    if (w.yourTurn === true && this.turn0 !== true) return this.done(`your turn${w.choices ? ` (${w.choices.length} choice${w.choices.length === 1 ? "" : "s"})` : ""}`);
    if (w.dialogue && JSON.stringify(w.dialogue) !== this.dlg0) return this.done(`a dialogue: ${w.dialogue.speaker ? `${w.dialogue.speaker}: ` : ""}"${clip(w.dialogue.text, 80)}"`);
    if (w.scene !== this.scene0 && w.scene != null) return this.done(`scene ${w.scene}`);
    if (choiceSig(w) !== this.sig0 && this.age > 0.05) {
      if (w.yourTurn === false) { this.sig0 = choiceSig(w); }   // the others' moves show up while it isn't your turn: keep waiting
      else return this.done(`the choices changed (${w.choices ? w.choices.length : 0} now)`);
    }
    if (this.age >= this.cap - 1e-9) return this.done(`waited ${r1(this.age)}s${w.yourTurn === false ? " (still not your turn)" : ""}`);
    return this.run();
  }
}
const TURN_NO = /^(goto|go|run|explore|follow|fight|flee|talk|pickup|interact|stomp|jump|look|reload|weapon|block|dodge)$/;
function controlEventRaw(c, down) { return controlEvent(c, down, { x: 0, y: 0 }); }

class Pickup extends Behaviour {
  constructor(o, ap, w, thing) { super(o, ap, w); this.guardable = true; this.spec = o.target; this.plural = !!(o.target && o.target.plural); this.count = 0; this.setThing(w, thing); this.maxT = o.forS ?? 40; }
  setThing(w, th) { this.thing = th; this.go = new GoTo(this.o, this.ap, w, { thing: th, reach: reachW(w, this.ap.cfg.reach.pickup) }); this.phase = "go"; }
  tick(w, want) {
    const ap = this.ap, c = ap.cfg.controls;
    const still = w.things.find((x) => x.id === this.thing.id);
    if (!still && (this.thing.remembered ? dist2(w.player.p2, this.thing.p2) < w.cell * 2 : true)) {
      this.count++;
      if (this.plural) {
        let next = null; try { next = resolveTarget(this.spec, w, { prefer: "item", allowRemembered: false }).things[0]; } catch { /* none left */ }
        if (next && next.dist <= ap.cfg.alert * 3) { this.setThing(w, next); return this.run(); }
      }
      return this.done(`picked up ${this.count > 1 ? `${this.count} items` : this.thing.key}`);
    }
    if (this.age > this.maxT) return this.fail(`couldn't pick up ${this.thing.key}`);
    if (this.phase === "go") { const r = this.go.tick(w, want); if (r.status === "fail") return r; if (r.status === "done") { this.phase = "wait"; this.waitT = ap.t; } return this.run(); }
    if (this.phase === "wait" && ap.t - this.waitT > 0.3) {
      if (c.interact && !this.pressed) { want.taps.push({ label: "interact", c: c.interact, frames: c.tapFrames }); this.pressed = true; this.waitT = ap.t; return this.run(); }
      return this.fail(`walked onto ${this.thing.key} but it wasn't picked up`);
    }
    return this.run();
  }
}

class Tap extends Behaviour {
  /** Tap a control `times` times (press/use), optionally with a movement direction (dodge). */
  constructor(o, ap, w, { control, times = 1, dir = null, label }) { super(o, ap, w); this.c = control; this.times = times; this.n = 0; this.next = 0; this.dir = dir; this.desc = label; }
  tick(w, want) {
    const ap = this.ap, gap = Math.max(6, ap.cfg.controls.tapFrames * 3) / ap.fps;
    if (this.dir) this.ap.moveTo(w, this.dir, want);
    if (this.n < this.times && ap.t >= this.next - 1e-9) { want.taps.push({ label: `tap:${controlLabel(this.c)}`, c: this.c, frames: ap.cfg.controls.tapFrames }); this.n++; this.next = ap.t + gap; return this.run(); }
    if (this.n >= this.times && ap.t >= this.next - 1e-9) return this.done(`${this.desc}${this.times > 1 ? ` ×${this.times}` : ""}`);
    return this.run();
  }
}

class Hold extends Behaviour {
  constructor(o, ap, w, { control, seconds, label }) { super(o, ap, w); this.c = control; this.seconds = seconds; this.desc = label; }
  tick(w, want) {
    if (this.age >= this.seconds - 1e-9) return this.done(`held ${this.desc} ${r1(this.seconds)}s`);
    if (this.c === "move") this.ap.moveTo(w, this.dir, want); else want.held.set(`hold:${controlLabel(this.c)}`, this.c);
    return this.run();
  }
}

class Wait extends Behaviour {
  constructor(o, ap, w, seconds) { super(o, ap, w); this.guardable = true; this.seconds = seconds; }
  tick() { return this.age >= this.seconds - 1e-9 ? this.done(`waited ${r1(this.seconds)}s`) : this.run(); }
}

class WaitFor extends Behaviour {
  constructor(o, ap, w, thing) { super(o, ap, w); this.guardable = true; this.thing = thing; this.d0 = thing.dist; this.side0 = Math.sign(thing.p2[0] - w.player.p2[0]); this.maxT = o.forS ?? 8; }
  tick(w) {
    const th = w.things.find((x) => x.id === this.thing.id);
    if (!th) return this.done(`${this.thing.key} is gone`);
    const side = Math.sign(th.p2[0] - w.player.p2[0]);
    if (this.ap.platform && side !== this.side0 && side !== 0) return this.done(`${th.key} passed`);
    if (th.state && SAFE_STATES.test(th.state) && this.age > 0.05) return this.done(`${th.key} is ${th.state} now — go`);
    if (th.dist > Math.max(this.d0 + 3, this.ap.cfg.alert)) return this.done(`${th.key} moved away (${r1(th.dist)} cells)`);
    if (this.age > this.maxT) return this.done(`waited ${r1(this.age)}s for ${th.key}`);
    return this.run();
  }
}

class Instant extends Behaviour {
  constructor(o, ap, w, fn) { super(o, ap, w); this.instant = true; this.fn = fn; }
  tick(w, want) { return this.fn(w, want); }
}

class CallOrder extends Behaviour {
  constructor(o, ap, w) { super(o, ap, w); this.phase = "call"; }
  tick() {
    if (this.phase === "call") { this.phase = "after"; return { status: "call", name: this.o.name, args: this.o.args || [] }; }
    return this.done(this.result ?? `called ${this.o.name}`);
  }
}

class Combo extends Behaviour {
  constructor(o, ap, w) {
    super(o, ap, w);
    const spec = ap.cfg.combos[o.name];
    if (!spec) throw new OrderError(`no combo "${o.name}"${Object.keys(ap.cfg.combos).length ? ` (combos: ${Object.keys(ap.cfg.combos).join(", ")})` : " (define play.combos in witness.json)"}`);
    let evs = parseWitnessInput(spec, ap.fps);
    // mirror left/right when the target is on the other side (fighting games)
    const foe = w.things.find((th) => th.rel === "hostile");
    if (ap.cfg.mirrorCombos !== false && foe && foe.p2[0] < w.player.p2[0]) evs = evs.map((e) => (e.type === "key" && (e.key === "left" || e.key === "right") ? { ...e, key: e.key === "left" ? "right" : "left" } : e));
    this.events = evs; this.sent = false; this.end = Math.max(0, ...evs.map((e) => e.frame)) / ap.fps;
  }
  tick(w, want) {
    if (!this.sent) { for (const e of this.events) { const { frame, ...rest } = e; want.raw.push({ at: frame, ...rest }); } this.sent = true; return this.run(); }
    return this.age >= this.end + 1 / this.ap.fps ? this.done(`combo ${this.o.name}`) : this.run();
  }
}

class Look extends Behaviour {
  constructor(o, ap, w, thing) { super(o, ap, w); this.thing = thing; this.dir = o.dir ? dirVector(o.dir, w.northSign) : null; }
  tick(w, want) {
    const p = w.player;
    if (this.ap.cfg.profile !== "fps") {
      const tp = this.thing ? this.thing.p2 : add(p.p2, scale(this.dir || [1, 0], w.cell * 3));
      return this.ap.profile.face(w, tp, want) || this.age > 0.4 ? this.done(`facing ${this.thing ? this.thing.key : this.o.dir}`) : this.run();
    }
    let err;
    if (this.thing) { const th = w.things.find((x) => x.id === this.thing.id) || this.thing; err = this.ap.profile.aim(w, th, want).yawErr; }
    else if (this.o.pitch) { const look = lookOf(w, this.ap.cfg); err = this.ap.profile.turn(w, look ? look.dir : [0, -1], want, this.o.pitch === "up" ? 0.6 : -0.6); }
    else err = this.ap.profile.turn(w, this.dir, want, 0);
    if (Math.abs(err) < 0.05 && this.age > 0.05) return this.done(`looking ${this.thing ? `at ${this.thing.key}` : this.o.dir || this.o.pitch}`);
    return this.age > 1.5 ? this.done(`turned (aim off ${Math.round((err * 180) / Math.PI)}°)`) : this.run();
  }
}

/**
 * Live mode: what the player does between orders while the game keeps running. Never finishes on its own.
 * fps: hold position and shoot enemies in sight; topdown: guard (the guard reflex) and hit back at enemies in reach;
 * platformer: stand still and jump onto (or away from) enemies about to touch you.
 */
class Standing extends Behaviour {
  constructor(o, ap, w) { super(o, ap, w); this.guardable = true; this.standing = true; this.label = "standing by"; }
  tick(w, want) {
    const ap = this.ap, cfg = ap.cfg, c = cfg.controls;
    if (!w.player || !w.player.p2 || w.dead || w.dialogue) return this.run();
    if (ap.platform) { ap.platform.guard(w, want); return this.run(); }
    if (cfg.profile === "fps") {
      const th = ap.visibleFoe(w);
      if (th) ap.shootAt(w, want, th);
      else if (w.player.ammo === 0 && c.reload) want.taps.push({ label: "reload", c: c.reload, frames: 2 });
      return this.run();
    }
    const reach = reachW(w, cfg.reach.attack);
    const th = w.things.filter((x) => x.rel === "hostile" && !x.dead && dist2(x.p2, w.player.p2) <= reach * 1.6).sort((a, b) => a.dist - b.dist)[0];
    if (th && ap.profile.face(w, th.p2, want)) ap.attack(want);
    return this.run();
  }
}

// ------------------------------------------------------------------ the autopilot
export class Autopilot {
  constructor(cfg, { fps = 60, grid, perceiver, size = [640, 360] } = {}) {
    this.cfg = cfg; this.fps = fps; this.grid = grid; this.perceiver = perceiver;
    // autofight: enemies met during a move (goto/explore/follow/go) are fought on the spot and the move then resumes,
    // instead of waking the tester (fps shoots on the move; topdown stops, fights near, resumes). Platformer runners
    // already deal with enemies, so it's off there.
    this.policy = { retreat: cfg.retreat, heal: cfg.heal, guard: cfg.guard, reaction: cfg.reaction, autofight: cfg.autofight ?? cfg.profile !== "platformer" };
    this.standingMode = false;   // live mode: a Standing behaviour runs whenever no order does
    this.lastHurtT = -1e9; this.lastHp = null; this.dot = new DotClassifier();
    this.ctrl = new Controller(size);
    this.profile = makeProfile(cfg.profile, this);
    this.platform = cfg.profile === "platformer" ? new PlatformRunner(this) : null;
    this.queue = []; this.cur = null; this.results = [];
    this.speed = cfg.speed; this.speedSamples = [];
    this.prevP = null; this.prevT = null; this.lastMoveDir = null; this.facingGuess = null; this.moveAligned = true;
    this.windupSeen = new Map(); this.lastAttackT = -1e9; this.lastHealT = -1e9;
    this.events = []; this.incidents = [];
    this.t = 0; this.frame = 0; this.wantedMove = false;
  }
  note(text) { this.events.push({ kind: "note", text }); }
  emit(kind, text, data) { this.events.push({ kind, text, data }); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  setOrders(orders) { this.queue = orders.slice(); this.cur = null; this.suspended = null; this.results = []; }
  clear() { this.queue = []; this.cur = null; this.suspended = null; }
  busy() { return !!((this.cur && !this.cur.standing) || this.queue.length); }
  inCombat() { return this.cur instanceof Fight || this.cur instanceof Flee || /^(fight|stomp|flee)$/.test(this.cur?.o?.verb || "") || !!this.suspended; }
  /** The order a tester gave that's running now (an autofight's suspended order counts; standing doesn't). */
  activeOrder() { return this.suspended || (this.cur && !this.cur.standing ? this.cur : null); }

  /** Another floor: a vertical gap bigger than a storey (3D games), so the ground map can't lead there. */
  otherFloor(w, th) {
    const p = w.player; if (!p || !p.pos || !th.pos || p.pos.length < 3 || th.pos.length < 3) return false;
    const [a, b] = this.cfg.plane, up = 3 - a - b;
    return Math.abs((th.pos[up] ?? 0) - (p.pos[up] ?? 0)) > (this.cfg.fps.floorHeight ?? 2.2);
  }
  /** The nearest enemy you could shoot right now (fps): in sight, in range, on your floor. */
  visibleFoe(w, filter = null) {
    const range = (this.cfg.fps.range ?? 12) * 2.2;
    return w.things.filter((x) => x.rel === "hostile" && !x.dead && x.los !== false && x.dist <= range && !this.otherFloor(w, x) && (!filter || filter(x)))
      .sort((a, b) => a.dist - b.dist)[0] || null;
  }
  /** fps: aim at a target and hold the trigger when the crosshair is on it (used while moving and while standing). */
  shootAt(w, want, th) {
    const c = this.cfg.controls, d = dist2(th.p2, w.player.p2);
    if (w.player.ammo === 0 && c.reload) { want.taps.push({ label: "reload", c: c.reload, frames: 2 }); return; }
    const aim = this.profile.aim(w, th, want);
    const size = Math.atan2(0.45, Math.max(0.5, d));
    if (Math.abs(aim.yawErr) < size * this.cfg.fps.aimTolerance + 0.01 && Math.abs(aim.pitchErr) < size * 1.6 + 0.02 && c.attack) { want.held.set("attack", c.attack); this.lastAttackT = this.t; }
  }
  currentLabel() { return this.cur ? this.cur.label : null; }
  replaceWith(b, why) { this.cur = b; this.emit("reflex", why); }

  /** After every snapshot: speed estimate, facing guess, windup timers, nav grid knowledge. */
  observe(w) {
    this.t = w.t; this.frame = w.frame;
    const p = w.player;
    // a scene change the running order caused on purpose (it walked into the inn it was sent to) finishes that order
    // instead of interrupting the chain
    const sceneChanged = w.newScene || (this.lastScene != null && w.scene !== this.lastScene);
    this.lastScene = w.scene;
    this.sceneArrival = sceneChanged ? this.arrivedByScene(w) : null;
    if (w.newScene) {   // a new level or scene: the old map knowledge and what we remembered no longer apply
      this.visitedBefore = (this.visitedBefore || 0) + this.grid.visited.size;   // coverage adds up across levels
      this.grid.reset(); this.windupSeen.clear(); this.prevP = null;
      if (this.platform) this.platform.reset();
      // (a turn/menu game has no map: its scene changes are just the tracker's "scene: home → table")
      if (this.cfg.profile !== "turn") this.emit("scene", `${this.sceneArrival ? `entered ${this.sceneArrival}: ` : ""}new scene/level (${w.sceneKey}): map knowledge reset`);
    }
    this.prevW = w;
    if (this.cfg.mapWindow) this.grid.windowed = true;
    this.grid.setAvoidThings(w.things);
    if (!p || !p.p2) return;
    if (this.grid.cell !== w.cell || this.grid.origin[0] !== w.origin[0] || this.grid.origin[1] !== w.origin[1]) {
      // the cell size was only decided now (the session started on a title screen): start the grid in the right units
      this.grid.cell = w.cell; this.grid.origin = w.origin.slice(); this.grid.reset();
    }
    if (w.map) this.grid.setMap(w.map);
    this.grid.visit(p.p2, this.cfg.sight);
    if (this.prevP && this.prevT != null && this.t > this.prevT) {
      const dp = sub(p.p2, this.prevP), v = len(dp) / (this.t - this.prevT);
      if (this.wantedMove && this.moveAligned) {
        this.speedSamples.push(v);
        if (this.speedSamples.length > 40) this.speedSamples.shift();
        const s = [...this.speedSamples].sort((a, b) => a - b);
        const q = s[Math.floor(s.length * 0.75)];
        if (s.length >= 3 && q > 0) this.speed = this.cfg.speed ?? q;
      }
      if (len(dp) > w.cell * 0.02) {
        this.lastMoveDir = norm(dp);
        const ax = Math.abs(dp[0]) >= Math.abs(dp[1]) ? (dp[0] > 0 ? "E" : "W") : ((w.northSign === -1 ? dp[1] : -dp[1]) > 0 ? "S" : "N");
        this.facingGuess = ax;
      }
    }
    this.prevP = p.p2; this.prevT = this.t;
    if (p.hp != null) {
      const src = this.lastHp != null && p.hp < this.lastHp ? w.things.filter((th) => th.rel === "hostile" && !th.dead).sort((a, b) => a.dist - b.dist)[0] : undefined;
      // a small loss with no enemy near is damage over time (poison), not a hit: autofight doesn't go after a bystander
      const dot = src !== undefined && this.dot.loss(this.t, this.lastHp - p.hp, p.maxHp, { near: !!(src && src.dist <= reachW(w, this.cfg.reach.attack) * 2.6), things: w.things });
      if (src !== undefined && !dot) { this.lastHurtT = this.t; this.lastHurtBy = src ? src.id : null; }
      this.lastHp = p.hp;
    }
    for (const th of w.things) {
      if (th.rel !== "hostile") continue;
      if (th.telegraph) { if (!this.windupSeen.has(th.id)) this.windupSeen.set(th.id, this.t); }
      else this.windupSeen.delete(th.id);
    }
  }

  /**
   * The scene changed while an order was walking somewhere. Was that the point? A goto finishes when, just before the
   * change, the player was next to its goal or stood by a door that leads to it. Any walking order (goto, talk,
   * interact, pickup) whose target is still listed in the new scene carries on toward it.
   * Returns what was entered (the scene event then doesn't interrupt the chain), or null.
   */
  arrivedByScene(w) {
    const b = this.activeOrder(), pw = this.prevW, p0 = this.prevP;
    if (!b || !pw || !p0) return null;
    const go = b instanceof GoTo ? b : null, inner = !go && b.go instanceof GoTo && b.phase === "go" ? b.go : null;
    const g = go || inner;
    if (!g) return null;
    // the target is still listed in the new scene (a region label changed, or it's inside too): carry on toward it
    const listed = g.thingId != null && w.things.some((x) => x.id === g.thingId);
    const cell = pw.cell || w.cell;
    const near = g.goal && dist2(p0, g.goal) <= Math.max((g.reach || 0) + 2 * cell, 3 * cell);
    const th = g.lastThing, words = th ? [th.name, th.type].filter(Boolean).map((x) => String(x).toLowerCase()) : [];
    const door = th && pw.things.find((x) => x.avoid && x.leadsTo != null && dist2(x.p2, p0) <= 2 * cell && words.some((wd) => String(x.leadsTo).toLowerCase().includes(wd)));
    if (inner || (!near && !door)) { if (!listed) return null; g.nav.reset(); return g.desc; }
    const changed = `(the scene changed${w.scene ? ` to ${w.scene}` : ""})`;
    const how = g.push && g.push.tried.length ? ` (${g.push.tried.join(", ")})` : "";
    g.sceneDone = g.via && g.via.door ? `${g.via.msg} — entered${how} ${changed}`
      : `entered ${g.desc}${door && door.id !== g.thingId ? ` through ${door.key}` : ""}${how} ${changed}`;
    return g.desc;
  }

  /** The nearest hostile winding up within `range` whose windup we've had time to notice (reaction delay). */
  reactingThreat(w, range) {
    let best = null;
    for (const th of w.things) {
      if (th.rel !== "hostile" || !th.telegraph || th.dead) continue;
      const d = dist2(th.p2, w.player.p2);
      if (d > range) continue;
      const seen = this.windupSeen.get(th.id);
      if (seen == null || this.t - seen < this.policy.reaction - 1e-9) continue;
      if (!best || d < best.d) best = { th, d };
    }
    return best ? best.th : null;
  }

  /** React to a telegraphed attack with block / dodge / backoff. Returns true if it took over this tick. */
  defend(w, want, th, mode) {
    const c = this.cfg.controls, p = w.player.p2;
    if (mode === "block" && c.block) {
      want.held.set("block", c.block);
      this.profile.face(w, th.p2, want);
      this.blockUntilT = this.t + (th.tele ?? 0.3) + 0.15;
      if (this.cur && this.cur.blockUntil !== undefined) this.cur.blockUntil = this.blockUntilT;
      return true;
    }
    if (mode === "dodge" && c.dodge) {
      if (th.tele == null || th.tele <= 0.22) {
        const away = norm(sub(p, th.p2)), side = perp(away);
        const dir = norm(add(away, scale(side, 0.8)));
        this.moveTo(w, dir, want);
        want.taps.push({ label: "dodge", c: c.dodge, frames: c.tapFrames });
      }
      return true;
    }
    // backoff: step out of reach until the strike has passed
    this.moveTo(w, sub(p, th.p2), want);
    return true;
  }

  attack(want) {
    const c = this.cfg.controls;
    if (!c.attack) return;
    if (c.attackMode === "hold") { want.held.set("attack", c.attack); this.lastAttackT = this.t; return; }
    if (this.t - this.lastAttackT >= c.attackEvery - 1e-9) { want.taps.push({ label: "attack", c: c.attack, frames: c.tapFrames }); this.lastAttackT = this.t; }
  }

  moveTo(w, dir, want) {
    if (!dir || len(dir) < 1e-9) return;
    this.wantedMoveNow = true;
    if (this.cfg.profile === "fps") {
      // shooting on the move: the mouse aims at the enemy while the keys keep walking the path (relative to the look)
      const r = this.profile.move(w, dir, want, { turn: !this.aimTarget });
      this.moveAligned = this.aimTarget ? true : r.aligned;
      return;
    }
    moveControls(this.cfg, dir, w.northSign, want, w.cell);
    this.moveAligned = true;
  }

  /**
   * Autofight, checked before a movement order ticks. fps: pick an enemy in sight to shoot while the order keeps moving
   * (sets aimTarget). topdown: an enemy that hit us, or is right on us, suspends the order for a short fight; the order
   * resumes when it's over. Returns a Fight to run instead, or null.
   */
  autofight(w, b) {
    this.aimTarget = null;
    if (!this.policy.autofight || this.platform || !w.player || !w.player.p2 || w.dead || w.dialogue) return null;
    if (!(b instanceof GoTo || b instanceof Explore || b instanceof Follow || b instanceof Pickup || b instanceof Talk)) return null;
    if (this.cfg.profile === "fps") {
      const th = this.visibleFoe(w);
      if (th) {
        this.aimTarget = th;
        if (this.lastAutoAim !== th.id) { this.lastAutoAim = th.id; this.emit("autofight", `shooting at ${thingLabel(th)} on the move (${r1(th.dist)} cells ${th.dir}); ${clip(b.label, 40)} continues`); }
      }
      return null;
    }
    const reach = reachW(w, this.cfg.reach.attack);
    const hurtBy = this.t - this.lastHurtT < 1.5 ? w.things.find((x) => x.id === this.lastHurtBy && !x.dead) : null;
    const close = w.things.filter((x) => x.rel === "hostile" && !x.dead && dist2(x.p2, w.player.p2) <= reach * 2.2 && (x.telegraph || /chase|attack|strike|aggro|hunt/i.test(x.state || "") || x.raw?.aggro === true))
      .sort((a, c) => a.dist - c.dist)[0];
    const th = hurtBy && hurtBy.dist <= this.cfg.alert ? hurtBy : close;
    if (!th) return null;
    let fight;
    try { fight = new Fight({ verb: "fight", text: `autofight ${th.key}`, target: { raw: th.key, words: [], id: String(th.id), category: null, plural: false } }, this, w); }
    catch { return null; }
    fight.auto = true;
    fight.leashCells = this.cfg.autofightLeash ?? 6;
    if (hurtBy === th) this.lastHurtT = -1e9;   // that hit is answered: a fight that ends on the leash doesn't restart over it
    this.emit("autofight", `${thingLabel(th)} ${hurtBy === th ? "hit you" : "came at you"}: fighting it, then back to ${clip(b.label, 40)}`);
    return fight;
  }

  /**
   * Add "X is right there" to a stuck message when X may be what's in the way: a door-like thing (locked, a door,
   * stairs), or someone standing in the cell ahead. Never a bystander when the cell ahead is a wall, and never the
   * target itself. `dir` (the heading) or `goal` give "ahead".
   */
  blockerHint(w, msg, { dir = null, goal = null, targetId = null } = {}) {
    const grid = this.grid, p = w.player && w.player.p2;
    let ahead = null, wallAhead = false;
    const hd = dir && len(dir) > 1e-9 ? norm(dir) : p && goal && dist2(p, goal) > 1e-9 ? norm(sub(goal, p)) : null;
    if (p && hd) {
      const pc = grid.toCell(p);
      ahead = grid.toCell(add(p, scale(hd, w.cell * 0.8)));
      if (ahead[0] === pc[0] && ahead[1] === pc[1]) ahead = grid.toCell(add(p, scale(hd, w.cell * 1.1)));
      const k = grid.blockedKind(ahead[0], ahead[1], this.t);
      wallAhead = k === "map" || k === "learned" || k === "hazard";
    }
    const inWay = (th) => ahead && !wallAhead && dist2(th.p2, grid.center(ahead)) < w.cell * 0.9;
    const near = w.things.filter((th) => th.rel !== "item" && th.rel !== "hostile" && !th.dead && th.dist <= 1.6 && !(targetId != null && th.id === targetId) && (th.locked || th.avoid || inWay(th))).sort((a, b) => a.dist - b.dist)[0];
    if (!near) return msg;
    return `${msg} — ${near.key}${near.locked ? " (locked)" : ""} is right there${near.locked || near.rel === "neutral" ? `: try "interact ${near.key}"` : ""}`;
  }

  /** The player's collision radius in world units (from its size, else play.radius cells, default 0.35). */
  bodyRadius(w) {
    const sz = w.player && w.player.size;
    if (sz && sz.length) return Math.max(...sz.slice(0, 2)) / 2;
    return (this.cfg.radius ?? 0.35) * w.cell;
  }

  /** BFS over walkable cells for the spot that keeps the most distance from threats (minus path cost). */
  safeSpot(w, threats) {
    const g = this.grid, start = g.toCell(w.player.p2), q = [[start, 0]], seen = new Set([`${start}`]);
    let best = null, bestS = -Infinity;
    while (q.length) {
      const [c, d] = q.shift();
      const cp = g.center(c);
      // far from threats, close to you, and (when the map knows walls) out of their line of fire
      const covered = g.mapSolid.size > 0 && threats.every((th) => !g.clearLine(cp, th.p2, 0, this.t));
      const s = Math.min(...threats.map((th) => dist2(cp, th.p2))) / w.cell - 0.35 * d + (covered ? 6 : 0);
      if (s > bestS) { bestS = s; best = cp; }
      if (d >= 10) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = [c[0] + dx, c[1] + dy];
        if (seen.has(`${n}`) || g.isBlocked(n[0], n[1], this.t)) continue;
        seen.add(`${n}`); q.push([n, d + 1]);
      }
    }
    return best;
  }

  /** Build the behaviour for an order (may throw OrderError when its target doesn't exist). */
  make(o, w) {
    if (this.cfg.profile === "turn" && TURN_NO.test(o.verb))
      throw new OrderError(`"${o.text}": this is a turn-based / menu game, there's nothing to ${o.verb === "goto" || o.verb === "go" ? "walk to" : o.verb}`, ORDER_CARD_TURN);
    if ((!w.player || !w.player.p2) && this.cfg.profile !== "turn" && !/^(press|hold|wait|stop|set|call|choose|use|respawn|combo)$/.test(o.verb))
      throw new OrderError("there's no player in the game right now (an intro, a cutscene or a menu?)", "wait, or press the key the screen asks for (press enter)");
    try { return this.make1(o, w); }
    catch (e) {
      // "Potion#14" that we already picked up / "Wolf#3" we already killed: say so instead of "not here"
      const spec = o.target;
      if (e instanceof OrderError && spec && spec.id != null) {
        const m = this.perceiver.memory.get(isNaN(+spec.id) ? spec.id : +spec.id) || this.perceiver.memory.get(spec.id);
        if (m && m.gone) {
          // fighting / stomping something that's already dead is a success, not an error
          if (/^(fight|stomp)$/.test(o.verb) && m.thing.rel === "hostile") return new Instant(o, this, w, () => ({ status: "done", msg: `${m.thing.key} is already defeated` }));
          throw new OrderError(`${m.thing.key} is gone (picked up, killed or removed earlier)`, e.hint);
        }
      }
      throw e;
    }
  }
  make1(o, w) {
    const cfg = this.cfg, c = cfg.controls, ap = this;
    const ctl = (name) => {
      const n = String(name).toLowerCase();
      if (cfg.named[n]) return cfg.named[n];
      if (/^(attack|block|dodge|interact|heal|confirm|cancel|jump|run|reload|aim|crouch)$/.test(n)) throw new OrderError(`no "${n}" control is configured (play.controls.${n} in witness.json)`);
      return parseControl(n);   // a raw key name
    };
    switch (o.verb) {
      case "goto": {
        if (o.point) return new GoTo(o, this, w, { goal: this.grid.center([Math.floor(o.point[0]), Math.floor(o.point[1])]), label: `cell (${o.point[0]},${o.point[1]})`, reach: w.cell * 0.45 });
        if (o.goal) { if (!w.goal || !w.goal.p2) throw new OrderError("the game doesn't say where the goal is (no goal position in the snapshot)"); return new GoTo(o, this, w, { goal: w.goal.p2, label: "the goal" }); }
        const r = resolveTarget(o.target, w), th = r.things[0];
        // items: within pickup reach; people and enemies: within talking/attack reach; places (exits, doors, flags): step onto them
        let rc = th.rel === "item" ? cfg.reach.pickup : th.rel === "npc" || th.rel === "friend" ? cfg.reach.interact * 0.8 : th.rel === "hostile" ? cfg.reach.attack * 0.9 : 0.3;
        const tc = this.grid.toCell(th.p2), inWall = this.grid.isBlocked(tc[0], tc[1], this.t);
        if (inWall) rc = Math.max(rc, 1.15);
        const b = new GoTo(o, this, w, { thing: th, reach: reachW(w, rc) });
        if (o.target && o.target.id == null && !r.remembered) b.spec = o.target;
        if (inWall) b.note = `${th.key} is solid${th.locked ? " and locked" : ""}: you're next to it now (try "interact ${th.key}")`;
        return b;
      }
      case "go": {
        let v;
        if (cfg.profile === "fps" && /^[FB]$/.test(o.dir) || (cfg.profile === "fps" && /^[EW]$/.test(o.dir) && o.text.match(/\b(left|right)\b/))) {
          const look = lookOf(w, cfg); const f = look ? look.dir : [0, -1];
          v = o.dir === "F" ? f : o.dir === "B" ? scale(f, -1) : /\bleft\b/.test(o.text) ? (w.northSign === -1 ? [f[1], -f[0]] : [-f[1], f[0]]) : (w.northSign === -1 ? [-f[1], f[0]] : [f[1], -f[0]]);
        } else v = dirVector(o.dir === "F" ? "N" : o.dir === "B" ? "S" : o.dir, w.northSign);
        if (!v) throw new OrderError(`"${o.text}": which direction?`);
        const n = o.n ?? 5;
        const goal = add(w.player.p2, scale(v, n * w.cell));
        return new GoTo(o, this, w, { goal, label: `${n} cells ${o.dir}`, reach: w.cell * 0.5 });
      }
      case "run": {
        if (!this.platform) { const v = dirVector(o.dir, w.northSign); return new GoTo(o, this, w, { goal: add(w.player.p2, scale(v, (o.n ?? 6) * w.cell)), label: `${o.n ?? 6} cells ${o.dir}`, reach: w.cell * 0.5 }); }
        return this.platform.makeRun(o, w);
      }
      case "explore": return new Explore(o, this, w);
      case "follow": return new Follow(o, this, w, resolveTarget(o.target, w, { prefer: "friend", allowRemembered: false }).things[0]);
      case "fight": return new Fight(o, this, w);
      case "flee": return new Flee(o, this, w);
      case "talk": return new Talk(o, this, w, resolveTarget(o.target, w, { prefer: "npc" }).things[0]);
      case "interact": return new Interact(o, this, w, o.target ? resolveTarget(o.target, w).things[0] : null);
      case "choose":
        // the game's choices (cards, menu buttons, moves) when no dialogue with options is open
        if (w.choices && !(w.dialogue && w.dialogue.options.length)) return new Pick(o, this, w);
        if (!w.dialogue && cfg.profile === "turn") throw new OrderError("there are no choices right now (no state.choices, no dialogue): wait for your turn, or look at a screenshot", ORDER_CARD_TURN);
        return new Choose(o, this, w);
      case "pickup": {
        let r;
        try { r = resolveTarget(o.target, w, { prefer: "item" }); }
        catch (e) {
          const gone = o.target && o.target.id != null && (this.perceiver.memory.get(isNaN(+o.target.id) ? o.target.id : +o.target.id) || this.perceiver.memory.get(o.target.id) || {}).gone;
          if (gone) return new Instant(o, this, w, () => ({ status: "done", msg: `already picked up ${o.target.raw}` }));
          throw e;
        }
        return new Pickup(o, this, w, r.things[0]);
      }
      case "use": return new Tap(o, this, w, { control: ctl(o.control), label: `used ${o.control}` });
      case "press": return new Tap(o, this, w, { control: ctl(o.control), times: o.times, label: `pressed ${o.control}` });
      case "hold": return new Hold(o, this, w, { control: ctl(o.control), seconds: o.seconds, label: o.control });
      case "block": if (!c.block) throw new OrderError("no block control is configured (play.controls.block)"); return new Hold(o, this, w, { control: c.block, seconds: o.seconds, label: "block" });
      case "dodge": {
        if (!c.dodge) throw new OrderError("no dodge control is configured (play.controls.dodge)");
        const foe = w.things.find((th) => th.rel === "hostile");
        const dir = o.dir ? dirVector(o.dir, w.northSign) : foe ? norm(sub(w.player.p2, foe.p2)) : this.lastMoveDir;
        return new Tap(o, this, w, { control: c.dodge, dir, label: "dodged" });
      }
      case "wait": return cfg.profile === "turn" ? new WaitTurn(o, this, w) : new Wait(o, this, w, o.seconds);
      case "waitfor": if (cfg.profile === "turn") return new WaitTurn({ ...o, untimed: true }, this, w);
        return new WaitFor(o, this, w, resolveTarget(o.target, w, { allowRemembered: false }).things[0]);
      case "stop": return new Instant(o, this, w, () => ({ status: "done", msg: "stopped" }));
      case "set": return new Instant(o, this, w, () => {
        const k = o.key, v = o.value;
        if (/^(retreat|flee)$/.test(k)) { this.policy.retreat = v === false ? 0 : +v || 0; return { status: "done", msg: `retreat below ${this.policy.retreat}% hp` }; }
        if (/^(heal|potion)$/.test(k)) { if (!c.heal) return { status: "fail", msg: "no heal control is configured (play.controls.heal)" }; this.policy.heal = v === false ? 0 : +v || 0; return { status: "done", msg: `heal below ${this.policy.heal}% hp` }; }
        if (/^(guard|block|defend|defense|defence)$/.test(k)) { this.policy.guard = !!v; return { status: "done", msg: `guard ${this.policy.guard ? "on" : "off"}` }; }
        if (/^(reaction|react)$/.test(k)) { this.policy.reaction = Math.max(0, Math.min(1, +v || 0)); return { status: "done", msg: `reaction ${this.policy.reaction}s` }; }
        if (/^(autofight|auto-fight|fightback|fight-back|engage)$/.test(k)) { this.policy.autofight = !!v; return { status: "done", msg: `autofight ${this.policy.autofight ? "on: enemies met while moving are fought, then the move resumes" : "off: enemies met while moving stop the order"}` }; }
        return { status: "fail", msg: `unknown setting "${k}" (retreat, heal, guard, reaction, autofight)` };
      });
      case "call": if (!cfg.allowCalls) throw new OrderError("calls are disabled in playtests (start with --allow-calls to enable them)"); return new CallOrder(o, this, w);
      case "combo": return new Combo(o, this, w);
      case "respawn": {
        // press confirm now and every 1.5 s while dead (a "press Enter" prompt often shows a second or so after the
        // death, and an earlier press is ignored); many games respawn on their own timer, so wait up to 8 s
        let t0 = null, pressed = 0;
        return new Instant(o, this, w, (w2, want) => {
          if (t0 == null) { t0 = this.t; if (!w2.dead) return { status: "done", msg: "not dead" }; }
          if (!w2.dead) return { status: "done", msg: `respawned after ${r1(this.t - t0)}s${pressed ? ` (pressed confirm ${pressed}×)` : ""}` };
          const due = this.t - t0 >= pressed * 1.5 - 1e-9;
          if (due && (c.confirm || cfg.profile !== "fps")) { want.taps.push({ label: "confirm", c: c.confirm || parseControl("enter"), frames: c.tapFrames }); pressed++; }
          if (this.t - t0 > 8) return { status: "fail", msg: `still dead after 8s${pressed ? ` (pressed confirm ${pressed}×)` : ""} — the game may need a menu choice: look at a screenshot` };
          return { status: "run" };
        });
      }
      case "jump": case "stomp": {
        if (!this.platform) {
          if (o.verb === "stomp") return new Fight({ ...o, verb: "fight" }, this, w);
          if (!c.jump) throw new OrderError("no jump control is configured (play.controls.jump)");
          return new Tap(o, this, w, { control: c.jump, label: "jumped" });
        }
        return o.verb === "jump" ? this.platform.makeJump(o, w) : this.platform.makeStomp(o, w);
      }
      case "look": return new Look(o, this, w, o.target ? resolveTarget(o.target, w, { allowRemembered: false }).things[0] : null);
      case "reload": if (!c.reload) throw new OrderError("no reload control is configured (play.controls.reload)"); return new Tap(o, this, w, { control: c.reload, label: "reloaded" });
      case "weapon": {
        const list = c.weapons || [];
        const ctlW = typeof o.weapon === "number" ? list[o.weapon - 1] || parseControl(String(o.weapon)) : cfg.named[o.weapon];
        if (!ctlW) throw new OrderError(`no weapon "${o.weapon}" (weapons are play.controls.weapons, e.g. ["1","2","3","4"])`);
        return new Tap(o, this, w, { control: ctlW, label: `weapon ${o.weapon}` });
      }
      default: throw new OrderError(`"${o.text}": "${o.verb}" isn't supported here`);
    }
  }

  /**
   * Decide the controls for the next k frames. Returns {want, k, status, message, call?}.
   * status: "run" (keep stepping), "done"/"fail" (the order chain finished), "idle" (nothing to do), "call".
   */
  decide(w) {
    const want = newWant();
    this.wantedMoveNow = false;
    let k = this.cfg.tick;
    const nearHostile = w.player && w.things.some((th) => th.rel === "hostile" && !th.dead && th.dist <= Math.max(4, this.cfg.reach.attack * 3));
    if (nearHostile || (this.platform && w.player && w.player.onGround === false) || (this.fastUntil && this.t < this.fastUntil)) k = this.cfg.combatTick;
    this.k = k;
    for (let guard = 0; guard < 12; guard++) {
      if (!this.cur) {
        if (!this.queue.length) {
          // live mode: nothing ordered, so the standing behaviour plays on (hold/guard/shoot back)
          if (this.standingMode) { this.cur = new Standing({ verb: "stand", text: "standing by" }, this, w); this.cur.t0 = this.t; continue; }
          this.wantedMove = false; return { want, k: 0, status: this.results.length ? "done" : "idle", message: this.results.at(-1)?.msg };
        }
        const o = this.queue.shift();
        try { this.cur = this.make(o, w); }
        catch (e) {
          if (!(e instanceof OrderError)) throw e;
          const res = { order: o.text, status: "fail", msg: e.message, hint: e.hint };
          this.results.push(res); this.queue = [];
          this.wantedMove = false;
          return { want, k: 0, status: "fail", message: e.message, hint: e.hint };
        }
        this.cur.t0 = this.t;
      }
      let b = this.cur;
      // ---- an autofight that ended: back to the order it interrupted
      if (b.autoDone) {
        const back = this.suspended; this.suspended = null; this.cur = back;
        if (back) { for (const n of [back.nav, back.go && back.go.nav]) if (n) { n.bestT = this.t; n.reset?.(); } this.emit("autofight", `${b.autoDone}; back to ${clip(back.label, 50)}`); continue; }
        continue;
      }
      // ---- reflexes that come before the order
      if (w.dead && b.standing) return { want, k: this.cfg.tick, status: "run" };
      if (w.dead && b.auto) { this.cur = this.suspended || b; this.suspended = null; b = this.cur; }
      const stillOk = b instanceof Tap || b instanceof Wait || b instanceof Instant || b instanceof Choose || b instanceof Pick || b instanceof WaitTurn || b instanceof Hold || b instanceof CallOrder;
      // live mode: an order given (or running) while dead waits for the respawn (up to 12 s) instead of failing
      if (w.dead && !stillOk && this.standingMode) {
        b.deadSince ??= this.t;
        if (this.t - b.deadSince < 12) { for (const n of [b.nav, b.go && b.go.nav]) if (n) n.bestT = this.t; b.t0 = Math.max(b.t0, this.t - 0.01); return { want, k: this.cfg.tick, status: "run" }; }
      }
      if (!w.dead && b.deadSince != null) { b.deadSince = null; if (b.start && w.player && w.player.p2) b.start = w.player.p2.slice(); for (const n of [b.nav, b.go && b.go.nav]) if (n) n.reset(); }
      if (w.dead && !stillOk) return this.finish(b, { status: "fail", msg: "you died" }, want);
      if (w.dialogue && (b instanceof GoTo || b instanceof Explore || b instanceof Fight || b instanceof Pickup || b instanceof Follow || b instanceof Flee) && !(b instanceof Talk))
        return this.finish(b, { status: "fail", msg: `a dialogue is open (${w.dialogue.speaker || "someone"}: "${clip(w.dialogue.text, 60)}") — choose an option or press cancel first` }, want);
      // no player in the snapshot (a cutscene, an intro, a title screen): only orders that don't move can run
      if (!w.player || !w.player.p2) {
        if (!(b instanceof Tap || b instanceof Wait || b instanceof Hold || b instanceof Instant || b instanceof Choose || b instanceof Pick || b instanceof WaitTurn || b instanceof CallOrder))
          return this.finish(b, { status: "fail", msg: "there's no player in the game right now (an intro, a cutscene or a menu?) — wait, or press the key the screen asks for" }, want);
        const res0 = b.tick(w, want);
        if (res0.status === "call") { this.wantedMove = false; return { want, k: 1, status: "call", name: res0.name, args: res0.args }; }
        if (res0.status === "run") { this.wantedMove = false; return { want, k: this.cfg.tick, status: "run" }; }
        const out0 = this.finish(b, res0, want);
        if (out0.status === "fail" || !this.queue.length) return out0;
        continue;
      }
      // the reflexes (heal, retreat, guard, autofight) are for a living hero: over a body (0 hp, an enemy standing on
      // it) a retreat would swap every order (respawn, wait, press, even `set retreat 0`) for a Flee that can't run
      // and a `set` order always applies as given: `set retreat 0` at 20% hp next to an enemy isn't a Flee
      const pct = w.dead || (b instanceof Instant && b.o?.verb === "set") ? null : hpPct(w);
      if (this.policy.heal && pct != null && pct < this.policy.heal && this.cfg.controls.heal && this.t - this.lastHealT > 1.2) {
        want.taps.push({ label: "heal", c: this.cfg.controls.heal, frames: this.cfg.controls.tapFrames }); this.lastHealT = this.t;
        this.emit("reflex", `healing at ${Math.round(pct)}% hp`);
      }
      if (this.policy.retreat && pct != null && pct < this.policy.retreat && !(b instanceof Flee) && !(b instanceof Fight) && w.things.some((th) => th.rel === "hostile" && th.dist <= this.cfg.alert)) {
        this.cur = new Flee({ verb: "flee", text: "flee (low hp)" }, this, w); this.cur.t0 = this.t;
        this.emit("reflex", `retreating at ${Math.round(pct)}% hp`);
        continue;
      }
      if (b.guardable && this.policy.guard && !this.platform && !w.dead) {
        const threat = this.reactingThreat(w, reachW(w, this.cfg.reach.attack) * 1.9);
        const mode = this.cfg.guardMode || (this.cfg.controls.block ? "block" : this.cfg.controls.dodge ? "dodge" : "backoff");
        const pause = () => { for (const n of [b.nav, b.go && b.go.nav]) if (n) n.bestT = this.t; };
        if (threat && this.defend(w, want, threat, mode)) { pause(); this.k = this.cfg.combatTick; this.wantedMove = this.wantedMoveNow; return { want, k: this.cfg.combatTick, status: "run" }; }
        if (this.blockUntilT && this.t < this.blockUntilT && this.cfg.controls.block) { pause(); want.held.set("block", this.cfg.controls.block); this.k = this.cfg.combatTick; return { want, k: this.cfg.combatTick, status: "run" }; }
      }
      // platformers: while an order stands still (wait, press, look, wait for ...), jump onto or away from an enemy about to touch you
      if (this.platform && this.policy.guard && !w.dead && (b instanceof Wait || b instanceof WaitFor || b instanceof Tap || b instanceof Look || b instanceof Hold) && this.platform.guard(w, want)) {
        this.k = this.cfg.combatTick; this.wantedMove = true;
        return { want, k: this.cfg.combatTick, status: "run" };
      }
      // ---- autofight: an enemy met during a move gets dealt with, then the move goes on
      if (!b.auto && !b.standing && !w.dead) {
        const af = this.autofight(w, b);
        if (af) { this.suspended = b; this.cur = af; af.t0 = this.t; b = af; this.k = this.cfg.combatTick; }
      } else this.aimTarget = null;
      // ---- the order
      const res = b.tick(w, want);
      if (this.aimTarget && this.cfg.profile === "fps") this.shootAt(w, want, this.aimTarget);
      if (res.status === "call") { this.wantedMove = false; return { want, k: 1, status: "call", name: res.name, args: res.args }; }
      if (res.status === "run") { this.wantedMove = this.wantedMoveNow; return { want, k: b.fast ? 1 : this.k, status: "run" }; }
      if (b.auto) {
        // an autofight is the reflex layer's business: it isn't a result of the tester's order, just an event
        if (res.status === "fail" && /you died/.test(res.msg || "")) { const o0 = this.suspended || b; this.suspended = null; return this.finish(o0, res, want); }
        b.autoDone = res.msg || "fight over"; this.cur = b;
        return { want, k: this.k, status: "run" };
      }
      const out = this.finish(b, res, want);
      if (out.status === "fail") return out;
      if (!this.queue.length) return out;
      if (!(b.instant || res.status === "done" && want.held.size === 0 && !want.taps.length && !want.raw.length)) return { ...out, status: "run", k };
    }
    return { want, k, status: "run" };
  }
  finish(b, res, want) {
    this.cur = null;
    const r = { order: b.label, status: res.status, msg: res.msg, seconds: +(this.t - b.t0).toFixed(2) };
    this.results.push(r);
    if (res.status === "fail") this.queue = [];
    this.wantedMove = false;
    return { want, k: 0, status: res.status, message: res.msg };
  }
}

export { GoTo, Fight, Flee, Talk, Choose, Pick, WaitTurn, StateWatch, Pickup, Explore, Tap, Hold, Wait, Behaviour, Look, hpPct, reachW, fmtCell };
