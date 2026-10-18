// Witness play: the reflex layer. The tester gives orders ("fight wolf block", "talk guard"); the autopilot turns
// them into held controls every few frames, from the world model: path finding around walls, stuck recovery,
// facing and attacking, reacting to telegraphed attacks after a human-like reaction delay, dialogue choices.
// Deterministic: no wall clock, no unseeded randomness.
import { norm, len, sub, add, scale, dist2, dot, perp, compass, dirVector, r1, fmtT, clip } from "./util.js";
import { controlLabel, parseControl } from "./config.js";
import { makeProfile, moveControls, lookOf } from "./profiles.js";
import { PlatformRunner, SAFE_STATES } from "./platformer.js";
import { OrderError, resolveTarget } from "./orders.js";
import { thingLabel } from "./perceive.js";
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
    this.escape = null; this.best = Infinity; this.bestT = this.ap.t; this.incident = null; this.lastDir = null; this.bestRem = Infinity;
  }
  /** One tick toward goal (plane point) within reach (world units). Returns {dir, arrived, fail}. */
  tick(w, goal, reach, { stuckLimit = 3.2, direct = false } = {}) {
    const ap = this.ap, grid = ap.grid, p = w.player.p2, t = ap.t, cell = w.cell;
    const d = dist2(p, goal);
    if (d <= reach) { this.closeIncident(w, true, "arrived"); return { dir: null, arrived: true }; }
    if (d < this.best - 0.4 * cell) { this.best = d; this.bestT = t; }
    if (t - this.bestT > stuckLimit) {
      const msg = `stuck at cell ${fmtCell(grid.toCell(p))} heading ${compass(sub(goal, p), w.northSign)} for ${r1(t - this.bestT)}s (no progress toward the target)`;
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
        this.path = grid.astar(pc, gc, { t, goalOk: (x, y) => dist2(grid.center([x, y]), goal) <= Math.max(reach, cell * 0.5) && !(x === pc[0] && y === pc[1]) || (Math.hypot(x - gc[0], y - gc[1]) <= Math.max(0, reachCells - 0.5)) }) || grid.lastPartial || null;
        this.planVersion = grid.version; this.goalCell = gc; this.planT = t;
        if (!this.path) this.noPath = (this.noPath || 0) + 1;
        this.bestRem = Infinity;   // a new plan: progress is measured along it from here
      }
      if (this.path && this.path.length > 1) {
        let i = this.path.findIndex((c) => c[0] === pc[0] && c[1] === pc[1]);
        if (i < 0) { let bd = Infinity; this.path.forEach((c, j) => { const dd = Math.hypot(c[0] - pc[0], c[1] - pc[1]); if (dd < bd) { bd = dd; i = j; } }); }
        const rem = this.path.length - 1 - i;
        if (rem < this.bestRem - 0.5) { if (this.bestRem !== Infinity) this.bestT = t; this.bestRem = rem; }
        // look ahead along the path as far as the body fits through in a straight line (no clipping wall corners)
        let j = Math.min(i + 1, this.path.length - 1);
        for (let k = j + 1; k < Math.min(this.path.length, i + 6); k++) { if (grid.clearLine(p, grid.center(this.path[k]), rb, t)) j = k; else break; }
        const last = j === this.path.length - 1;
        const wp = last && grid.clearLine(p, goal, rb, t) ? goal : grid.center(this.path[j]);
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
      this.incident = { t0: t, p, cell: pc, heading: compass(dir, w.northSign), how: [], blocks: 0 };
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
      this.ap.incidents.push({ t: inc.t0, cell: inc.cell, heading: inc.heading, seconds: +secs.toFixed(2), resolved, how: resolved ? how : `${inc.how.join(" → ")} → ${how}`.replace(/^ → /, ""), blocks: inc.blocks });
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
class GoTo extends Behaviour {
  constructor(o, ap, w, { goal = null, thing = null, reach = null, label = null } = {}) {
    super(o, ap, w);
    this.guardable = true;
    this.nav = new Navigator(ap);
    this.thingId = thing ? thing.id : null; this.thingKey = thing ? thingLabel(thing) : null;
    this.goal = goal; this.reach = reach;
    this.desc = label || (thing ? thing.key : goal ? `cell ${fmtCell(ap.grid.toCell(goal))}` : "?");
    this.maxT = o.forS ?? 30;
  }
  target(w) {
    if (this.thingId != null) {
      const th = w.things.find((x) => x.id === this.thingId) || (w.remembered || []).find((x) => x.id === this.thingId);
      if (th) { this.goal = th.p2; this.lastThing = th; }
    }
    return this.goal;
  }
  tick(w, want) {
    const goal = this.target(w);
    if (!goal) return this.fail(`lost track of ${this.desc}`);
    const reach = this.reach ?? reachW(w, this.thingId != null ? 1.0 : 0.45);
    if (this.ap.platform) {
      const r = this.ap.platform.tick(w, want, { targetX: goal[0], targetY: goal[1], reachX: Math.max(reach, w.cell * 0.4) });
      if (r.arrived) return this.done(`arrived at ${this.desc}`);
      if (r.fail) return this.fail(r.fail);
      return this.age > this.maxT ? this.fail(`gave up after ${r1(this.age)}s`) : this.run();
    }
    const r = this.nav.tick(w, goal, reach);
    if (r.arrived) return this.done(`arrived at ${this.desc}${this.note ? ` — ${this.note}` : ""}`);
    if (r.fail) return this.fail(this.ap.blockerHint(w, r.fail));
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
    const prefer = (this.kite ?? cfg.fps.range ?? 12) * w.cell;
    let mv = null;
    if (th.los === false || d > prefer * 1.4) {
      const r = this.nav.tick(w, th.p2, prefer * 0.8, { stuckLimit: 5 });
      if (r.fail) return this.fail(`can't reach ${th.key}: ${r.fail}`);
      mv = r.dir;
    } else if (d < prefer * 0.4) mv = sub(p, th.p2);
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
    const threats = w.things.filter((th) => th.rel === "hostile" && !th.dead && th.dist <= ap.cfg.alert * 1.6);
    if (!threats.length) return this.done(`got away`);
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
  constructor(o, ap, w, thing) { super(o, ap, w); this.guardable = true; this.thing = thing; this.go = new GoTo(o, ap, w, { thing, reach: reachW(w, ap.cfg.reach.interact) * 0.8 }); this.phase = "go"; this.tries = 0; this.maxT = o.forS ?? 30; }
  tick(w, want) {
    const ap = this.ap, c = ap.cfg.controls;
    if (w.dialogue) return this.done(`dialogue: ${w.dialogue.speaker ? `${w.dialogue.speaker}: ` : ""}"${clip(w.dialogue.text, 90)}"`);
    if (this.age > this.maxT) return this.fail(`couldn't talk to ${this.thing.key}`);
    if (!c.interact) return this.fail("no interact control is configured (play.controls.interact)");
    if (this.phase === "go") {
      const r = this.go.tick(w, want);
      if (r.status === "fail") return r;
      if (r.status === "done") { this.phase = "face"; this.faceT = ap.t; }
      return this.run();
    }
    const th = w.things.find((x) => x.id === this.thing.id) || this.thing;
    if (this.phase === "face") {
      if (ap.profile.face(w, th.p2, want) || ap.t - this.faceT > 0.3) { this.phase = "press"; }
      return this.run();
    }
    if (this.phase === "press") { want.taps.push({ label: "interact", c: c.interact, frames: c.tapFrames }); this.phase = "wait"; this.waitT = ap.t; return this.run(); }
    if (this.phase === "wait" && ap.t - this.waitT > 0.6) {
      this.tries++;
      if (this.tries >= 3) return this.fail(`pressed interact next to ${th.key} ${this.tries}× but no dialogue opened`);
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
    if (ap.t - this.waitT > 1.0 + (this.waitFrames || 0) / ap.fps) return this.fail(`chose ${this.idx} but the dialogue didn't change (is play.controls.choose right?)`);
    return this.run();
  }
}
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

// ------------------------------------------------------------------ the autopilot
export class Autopilot {
  constructor(cfg, { fps = 60, grid, perceiver, size = [640, 360] } = {}) {
    this.cfg = cfg; this.fps = fps; this.grid = grid; this.perceiver = perceiver;
    this.policy = { retreat: cfg.retreat, heal: cfg.heal, guard: cfg.guard, reaction: cfg.reaction };
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

  setOrders(orders) { this.queue = orders.slice(); this.cur = null; this.results = []; }
  clear() { this.queue = []; this.cur = null; }
  busy() { return !!(this.cur || this.queue.length); }
  inCombat() { return this.cur instanceof Fight || this.cur instanceof Flee; }
  currentLabel() { return this.cur ? this.cur.label : null; }
  replaceWith(b, why) { this.cur = b; this.emit("reflex", why); }

  /** After every snapshot: speed estimate, facing guess, windup timers, nav grid knowledge. */
  observe(w) {
    this.t = w.t; this.frame = w.frame;
    const p = w.player;
    if (!p || !p.p2) return;
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
    for (const th of w.things) {
      if (th.rel !== "hostile") continue;
      if (th.telegraph) { if (!this.windupSeen.has(th.id)) this.windupSeen.set(th.id, this.t); }
      else this.windupSeen.delete(th.id);
    }
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
    if (this.cfg.profile === "fps") { const r = this.profile.move(w, dir, want); this.moveAligned = r.aligned; return; }
    moveControls(this.cfg, dir, w.northSign, want, w.cell);
    this.moveAligned = true;
  }

  /** Add "next to X (locked)" to a stuck message when a door-like thing is right there. */
  blockerHint(w, msg) {
    const near = w.things.filter((th) => th.rel !== "item" && th.rel !== "hostile" && th.dist <= 1.6).sort((a, b) => a.dist - b.dist)[0];
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
      const s = Math.min(...threats.map((th) => dist2(cp, th.p2))) / w.cell - 0.35 * d;
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
    try { return this.make1(o, w); }
    catch (e) {
      // "Potion#14" that we already picked up / "Wolf#3" we already killed: say so instead of "not here"
      const spec = o.target;
      if (e instanceof OrderError && spec && spec.id != null) {
        const m = this.perceiver.memory.get(isNaN(+spec.id) ? spec.id : +spec.id) || this.perceiver.memory.get(spec.id);
        if (m && m.gone) throw new OrderError(`${m.thing.key} is gone (picked up, killed or removed earlier)`, e.hint);
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
      case "choose": return new Choose(o, this, w);
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
      case "wait": return new Wait(o, this, w, o.seconds);
      case "waitfor": return new WaitFor(o, this, w, resolveTarget(o.target, w, { allowRemembered: false }).things[0]);
      case "stop": return new Instant(o, this, w, () => ({ status: "done", msg: "stopped" }));
      case "set": return new Instant(o, this, w, () => {
        const k = o.key, v = o.value;
        if (/^(retreat|flee)$/.test(k)) { this.policy.retreat = v === false ? 0 : +v || 0; return { status: "done", msg: `retreat below ${this.policy.retreat}% hp` }; }
        if (/^(heal|potion)$/.test(k)) { if (!c.heal) return { status: "fail", msg: "no heal control is configured (play.controls.heal)" }; this.policy.heal = v === false ? 0 : +v || 0; return { status: "done", msg: `heal below ${this.policy.heal}% hp` }; }
        if (/^(guard|block|defend|defense|defence)$/.test(k)) { this.policy.guard = !!v; return { status: "done", msg: `guard ${this.policy.guard ? "on" : "off"}` }; }
        if (/^(reaction|react)$/.test(k)) { this.policy.reaction = Math.max(0, Math.min(1, +v || 0)); return { status: "done", msg: `reaction ${this.policy.reaction}s` }; }
        return { status: "fail", msg: `unknown setting "${k}" (retreat, heal, guard, reaction)` };
      });
      case "call": if (!cfg.allowCalls) throw new OrderError("calls are disabled in playtests (start with --allow-calls to enable them)"); return new CallOrder(o, this, w);
      case "combo": return new Combo(o, this, w);
      case "respawn": return new Instant(o, this, w, (w2, want) => {
        if (!w2.dead) return { status: "done", msg: "not dead" };
        if (!this.respawnT) { this.respawnT = this.t; want.taps.push({ label: "confirm", c: c.confirm || parseControl("enter"), frames: c.tapFrames }); return { status: "run" }; }
        if (this.t - this.respawnT > 1.5) { this.respawnT = null; return { status: "fail", msg: "pressed confirm but still dead" }; }
        return { status: "run" };
      });
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
        if (!this.queue.length) { this.wantedMove = false; return { want, k: 0, status: this.results.length ? "done" : "idle", message: this.results.at(-1)?.msg }; }
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
      const b = this.cur;
      // ---- reflexes that come before the order
      if (w.dead && !(b instanceof Tap || b instanceof Wait || b instanceof Instant || b instanceof Choose || b instanceof Hold || b instanceof CallOrder)) return this.finish(b, { status: "fail", msg: "you died" }, want);
      if (w.dialogue && (b instanceof GoTo || b instanceof Explore || b instanceof Fight || b instanceof Pickup || b instanceof Follow || b instanceof Flee) && !(b instanceof Talk))
        return this.finish(b, { status: "fail", msg: `a dialogue is open (${w.dialogue.speaker || "someone"}: "${clip(w.dialogue.text, 60)}") — choose an option or press cancel first` }, want);
      const pct = hpPct(w);
      if (this.policy.heal && pct != null && pct < this.policy.heal && this.cfg.controls.heal && this.t - this.lastHealT > 1.2) {
        want.taps.push({ label: "heal", c: this.cfg.controls.heal, frames: this.cfg.controls.tapFrames }); this.lastHealT = this.t;
        this.emit("reflex", `healing at ${Math.round(pct)}% hp`);
      }
      if (this.policy.retreat && pct != null && pct < this.policy.retreat && !(b instanceof Flee) && !(b instanceof Fight) && w.things.some((th) => th.rel === "hostile" && th.dist <= this.cfg.alert)) {
        this.cur = new Flee({ verb: "flee", text: "flee (low hp)" }, this, w); this.cur.t0 = this.t;
        this.emit("reflex", `retreating at ${Math.round(pct)}% hp`);
        continue;
      }
      if (b.guardable && this.policy.guard && !this.platform) {
        const threat = this.reactingThreat(w, reachW(w, this.cfg.reach.attack) * 1.9);
        const mode = this.cfg.guardMode || (this.cfg.controls.block ? "block" : this.cfg.controls.dodge ? "dodge" : "backoff");
        const pause = () => { for (const n of [b.nav, b.go && b.go.nav]) if (n) n.bestT = this.t; };
        if (threat && this.defend(w, want, threat, mode)) { pause(); this.k = this.cfg.combatTick; this.wantedMove = this.wantedMoveNow; return { want, k: this.cfg.combatTick, status: "run" }; }
        if (this.blockUntilT && this.t < this.blockUntilT && this.cfg.controls.block) { pause(); want.held.set("block", this.cfg.controls.block); this.k = this.cfg.combatTick; return { want, k: this.cfg.combatTick, status: "run" }; }
      }
      // ---- the order
      const res = b.tick(w, want);
      if (res.status === "call") { this.wantedMove = false; return { want, k: 1, status: "call", name: res.name, args: res.args }; }
      if (res.status === "run") { this.wantedMove = this.wantedMoveNow; return { want, k: b.fast ? 1 : this.k, status: "run" }; }
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

export { GoTo, Fight, Flee, Talk, Choose, Pickup, Explore, Tap, Hold, Wait, Behaviour, Look, hpPct, reachW, fmtCell };
