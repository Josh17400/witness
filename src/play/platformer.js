// Witness play: side-view platformer locomotion. Moves left/right (with run held for distance), and plans jumps from
// the game's tile map (state.map): walls at body height, gaps and hazards ahead, enemies in the way. Recovers from
// getting stuck with higher jumps and run-ups. Without a map it still jumps when progress stops.
import { r1, clip } from "./util.js";
import { OrderError, resolveTarget } from "./orders.js";
import { parseControl } from "./config.js";

export const SAFE_STATES = /^(hidden|retracted|retract|down|wait|waiting|sleep|sleeping|inactive|dormant|off|in)$/i;

export class PlatformRunner {
  constructor(ap) {
    this.ap = ap;
    this.jumpHold = 0;          // frames left to keep jump held
    this.jumpReleasedAt = -1e9; // frame when jump was last released (a new jump needs a fresh press)
    this.jumping = false;
    this.lastX = null; this.lastProgressT = 0; this.stuck = 0; this.backoffUntil = -1; this.bestDist = Infinity; this.bestT = 0;
    this.lastTarget = null;
  }
  get c() { return this.ap.cfg.controls; }
  reset() { this.jumpHold = 0; this.jumping = false; this.lastX = null; this.stuckN = 0; this.backoffUntil = -1; this.bestDist = Infinity; this.bestT = this.ap.t; }
  get pc() { return this.ap.cfg.platformer; }

  tileAt(w, x, y) {
    const m = w.map; if (!m) return null;
    const c = Math.floor((x - m.origin[0]) / m.cell), r = Math.floor((y - m.origin[1]) / m.cell);
    if (r < 0) return ".";
    if (r >= m.rows.length) return "_";               // below the map: a pit
    const row = m.rows[r];
    if (c < 0 || c >= row.length) return null;        // outside the window: unknown
    return row[c];
  }
  isSolid(w, ch) { return ch != null && w.map.solid.includes(ch); }
  isOneway(w, ch) { return ch != null && w.map.oneway.includes(ch); }
  isHazard(w, ch) { return ch === "_" || (ch != null && w.map.hazard.includes(ch)); }

  body(w) {
    const p = w.player, cell = w.cell;
    const size = p.size || [cell * 0.75, cell * 0.95];
    return { x: p.p2[0], y: p.p2[1], w: size[0], h: size[1], foot: p.p2[1] + size[1] / 2, head: p.p2[1] - size[1] / 2, vx: p.vel ? p.vel[0] : 0, onGround: p.onGround !== false };
  }

  /** Ground below x (from the foot row down): 'ground' | 'hazard' | 'pit' | null (unknown). */
  groundAt(w, x, foot) {
    const m = w.map; if (!m) return null;
    for (let y = foot + 1; y < m.origin[1] + m.rows.length * m.cell + m.cell; y += m.cell) {
      const ch = this.tileAt(w, x, y);
      if (ch === null) return null;
      if (this.isHazard(w, ch)) return ch === "_" ? "pit" : "hazard";
      if (this.isSolid(w, ch) || this.isOneway(w, ch)) return y - foot <= m.cell * 1.5 ? "ground" : "drop";
    }
    return "pit";
  }

  /** What's ahead in direction dir: {wall: tiles high or 0, wallDist, gap: cells wide or 0, gapDist, enemy}. */
  scan(w, b, dir) {
    const cell = w.cell, out = { wall: 0, wallDist: Infinity, gap: 0, gapDist: Infinity, enemy: null, drop: false };
    if (w.map) {
      const look = cell * 2 + Math.abs(b.vx) * 10;
      for (let dx = 2; dx <= look; dx += cell / 4) {
        const x = b.x + dir * (b.w / 2 + dx);
        let solidHit = false;
        for (let y = b.head + 2; y <= b.foot - 2; y += cell / 2) if (this.isSolid(w, this.tileAt(w, x, y))) solidHit = true;
        if (solidHit) {
          let hgt = 0;
          for (let y = b.foot - cell / 2; hgt < 8; y -= cell) { if (this.isSolid(w, this.tileAt(w, x, y))) hgt++; else break; }
          out.wall = Math.max(1, hgt); out.wallDist = dx; break;
        }
      }
      for (let dx = cell * 0.25; dx <= cell * 2.5 + Math.abs(b.vx) * 8; dx += cell / 4) {
        const x = b.x + dir * (b.w / 2 + dx);
        const g = this.groundAt(w, x, b.foot);
        if (g === "pit" || g === "hazard") {
          if (out.gapDist === Infinity) out.gapDist = dx;
          let width = 0;
          for (let k = 0; k < 10; k++) { const gg = this.groundAt(w, x + dir * k * cell, b.foot); if (gg === "pit" || gg === "hazard") width++; else break; }
          out.gap = width; out.hazard = g === "hazard"; break;
        }
        if (g === "drop") out.drop = true;
      }
    }
    for (const th of w.things) {
      if (th.rel !== "hostile" || th.dead) continue;
      const dx = (th.p2[0] - b.x) * dir, dy = Math.abs(th.p2[1] - b.y);
      // time to contact from both speeds (a kicked shell coming back closes fast)
      const closing = ((this.vF ? this.vF[0] : 0) - (th.v ? th.v[0] : 0)) * dir;
      const ttc = dx > 0 && closing > 0.05 ? dx / closing : Infinity;
      if (dx > -cell * 0.2 && dy < cell * 1.4 && (dx < cell * 2.2 + Math.abs(b.vx) * 8 || ttc < 30)) { if (!out.enemy || dx < out.enemy.dx) out.enemy = { th, dx, ttc }; }
    }
    return out;
  }

  pressJump(want, frames, w) {
    if (!this.c.jump) return false;
    if (this.ap.frame - this.jumpReleasedAt < 2 && this.jumpReleasedAt > -1e9) return false;
    this.jumpHold = Math.max(1, Math.round(frames));
    this.jumping = true; this.airborneSeen = false; this.jumpT = this.ap.t;
    want.held.set("jump", this.c.jump);
    this.ap.fastUntil = this.ap.t + 0.6;
    return true;
  }

  /** Velocity (world units per frame) and gravity, measured from positions so the game's own units never matter. */
  track(w) {
    const b = this.body(w), f = this.ap.frame;
    if (this.lastF != null && f > this.lastF) {
      const n = f - this.lastF, vx = (b.x - this.lastBX) / n, vy = (b.y - this.lastBY) / n;
      if (!b.onGround && this.lastAir && this.vF && this.jumpHold <= 0) {
        const gNow = (vy - this.vF[1]) / n;
        if (gNow > 0 && gNow < w.cell) this.g = this.g ? this.g * 0.7 + gNow * 0.3 : gNow;
      }
      // friction: how fast we slow down on the ground with no move key held (measured, so braking distance is known)
      const held = this.ap.ctrl.held, noMove = !held.has("move:right") && !held.has("move:left");
      if (b.onGround && !this.lastAir && this.vF && noMove && Math.abs(vx) < Math.abs(this.vF[0]) && Math.abs(vx) > 1e-3) {
        const fNow = (Math.abs(this.vF[0]) - Math.abs(vx)) / n;
        if (fNow > 0 && fNow < w.cell * 0.1) this.friction = this.friction ? this.friction * 0.7 + fNow * 0.3 : fNow;
      }
      this.vF = [vx, vy];
      if (b.onGround) this.maxVx = Math.max(this.maxVx || 0, Math.abs(vx));
    }
    if (this.lastF !== f) { this.lastF = f; this.lastBX = b.x; this.lastBY = b.y; this.lastAir = !b.onGround; }
  }

  holdJump(w, want, k) {
    this.track(w);
    if (this.jumpHold > 0) { want.held.set("jump", this.c.jump); this.jumpHold -= Math.max(1, this.ap.k || 1); if (this.jumpHold <= 0) this.jumpReleasedAt = this.ap.frame + (this.ap.k || 1); }
    const b = this.body(w);
    if (!b.onGround) this.airborneSeen = true;
    if (this.jumping && this.airborneSeen && b.onGround) { this.jumping = false; this.landedT = this.ap.t; const af = (this.ap.t - this.jumpT) * this.ap.fps; if (af > 4 && af < 120) this.airFrames = this.airFrames ? this.airFrames * 0.6 + af * 0.4 : af; }
    if (this.jumping && !this.airborneSeen && this.ap.t - this.jumpT > 0.25) this.jumping = false;   // the jump didn't take
  }

  /** One tick toward targetX. Returns {arrived, fail}. */
  tick(w, want, { targetX, targetY = null, reachX = 4, run = this.pc.run !== false } = {}) {
    const ap = this.ap, c = this.c, cell = w.cell, t = ap.t;
    this.holdJump(w, want);
    const b = this.body(w);
    const dx = targetX - b.x;
    if (Math.abs(dx) <= reachX && (targetY == null || Math.abs(targetY - b.y) < cell * 1.2 || b.onGround)) {
      if (targetY != null && targetY < b.y - cell && b.onGround && Math.abs(dx) < cell * 0.8) { this.pressJump(want, this.pc.jumpFrames, w); return {}; }
      return { arrived: true };
    }
    const dist = Math.abs(dx);
    if (dist < this.bestDist - cell * 0.3) { this.bestDist = dist; this.bestT = t; }
    if (t - this.bestT > (this.pc.stuckLimit ?? 7)) return { fail: `no progress toward x=${r1(targetX / cell)} for ${r1(t - this.bestT)}s (stuck at cell x=${Math.floor(b.x / cell)})` };
    let dir = Math.sign(dx);
    if (t < this.backoffUntil) dir = -this.backoffDir;
    const right = c.move.right, left = c.move.left;
    if (dir > 0 && right) want.held.set("move:right", right); else if (dir < 0 && left) want.held.set("move:left", left);
    ap.wantedMoveNow = true;
    if (run && c.run && dist > cell * 1.5) want.held.set("run", c.run);
    if (t < this.backoffUntil) return {};
    const s = this.scan(w, b, dir);
    if (s.wallDist < cell * 3 || s.gapDist < cell * 3 || s.enemy) ap.fastUntil = t + 0.3;
    const invincible = this.invincible(w);
    // an enemy you can't stomp (a plant in a pipe, spikes, fire) close ahead: that's a judgement call, not a reflex
    const danger = invincible ? null : w.things.find((th) => th.rel === "hostile" && !th.dead && th.stompable === false && !SAFE_STATES.test(th.state || "")
      && (th.p2[0] - b.x) * dir > -cell * 0.3 && (th.p2[0] - b.x) * dir < cell * 2.6 + Math.abs(b.vx) * 6 && Math.abs(th.p2[1] - b.y) < cell * 4);
    if (danger && b.onGround && !this.jumping && !this.ignoreDanger?.has(danger.id)) {
      want.held.delete("move:right"); want.held.delete("move:left"); want.held.delete("run");
      return { danger, fail: `stopped: ${danger.key}${danger.state ? ` (${danger.state})` : ""} is in the way ${((danger.p2[0] - b.x) * dir / cell).toFixed(1)} cells ahead and can't be stomped — "wait for ${danger.key}" (until it hides), then run on` };
    }
    // in the air: plan the landing. For each air input (left / none / right) predict where we come down and where every
    // enemy will be by then (their measured speed), then pick the safest: a stomp is good, a side hit is fatal.
    if (!b.onGround) {
      const plan = this.airPlan(w, b, dir, invincible);
      if (plan && plan.input !== dir) {
        want.held.delete("move:right"); want.held.delete("move:left");
        if (plan.input !== dir) want.held.delete("run");
        if (plan.input > 0 && right) want.held.set("move:right", right); else if (plan.input < 0 && left) want.held.set("move:left", left);
        ap.fastUntil = t + 0.2;
        if (plan.threat && !this.backedFrom?.has(plan.threat.id)) { (this.backedFrom ??= new Set()).add(plan.threat.id); ap.emit("reflex", `changed course in the air to avoid ${plan.threat.key}`); }
      }
    }
    if (b.onGround && !this.jumping) {
      const speedPx = Math.abs(b.vx);
      // a pack (another enemy just beyond the first): a running stomp would bounce us into the second one.
      // Stop, let the first walk in, stomp it from a standstill so the bounce lands in place.
      const pack = s.enemy && !invincible && s.enemy.th.stompable !== false && w.things.some((th) => th !== s.enemy.th && th.rel === "hostile" && !th.dead
        && Math.abs(th.p2[1] - b.y) < cell * 1.5 && (th.p2[0] - b.x) * dir > s.enemy.dx && (th.p2[0] - b.x) * dir < s.enemy.dx + cell * 5);
      if (pack) {
        this.packSince ??= t;
        const closing = s.enemy.th.v ? -s.enemy.th.v[0] * dir : 0;     // world units per frame toward us
        const vNow = this.vF ? Math.abs(this.vF[0]) : speedPx;
        want.held.delete("run");
        // too fast to stop before it reaches us (e.g. just landed from a running jump): stomp now
        const gap0 = s.enemy.dx - (b.w + (s.enemy.th.size ? s.enemy.th.size[0] : cell * 0.75)) / 2;
        const ttcAll = gap0 / Math.max(0.05, closing + (this.vF ? this.vF[0] * dir : 0));
        const stopFrames = vNow / Math.max(this.friction || cell * 0.007, 1e-3);
        if (gap0 > 0 && ttcAll < Math.min(stopFrames, 18)) { this.pressJump(want, this.pc.jumpFrames * 0.7, w); ap.emit("jump", `jumped onto ${s.enemy.th.key} (too close to stop)`); this.packSince = null; return {}; }
        if (closing > 0.05 && t - this.packSince < 3) {
          // it walks toward us: stand still and jump so it arrives as we come down (about half the air time before contact)
          want.held.delete("move:right"); want.held.delete("move:left");
          const gapPx = s.enemy.dx - (b.w + (s.enemy.th.size ? s.enemy.th.size[0] : cell * 0.75)) / 2;
          const ttc = gapPx / closing, air = this.airFrames || 26;
          if (vNow < cell * 0.04 && ttc <= air * 0.5 + 2) { this.pressJump(want, this.pc.jumpFrames * 0.6, w); ap.emit("jump", `stomped ${s.enemy.th.key} from a standstill (another enemy right behind it)`); this.packSince = null; }
          return {};
        }
        // it isn't coming: walk (no run) and stomp with a short bounce
        if (s.enemy.dx < cell * 1.4) { this.pressJump(want, this.pc.jumpFrames * 0.6, w); ap.emit("jump", `jumped onto ${s.enemy.th.key} at walking speed`); this.packSince = null; }
        return {};
      }
      this.packSince = null;
      if (s.enemy && (s.enemy.dx < cell * 1.6 + speedPx * 6 || s.enemy.ttc < 16)) {
        const stomp = s.enemy.th.stompable !== false && this.pc.stomp;
        this.pressJump(want, stomp ? this.pc.jumpFrames * 0.75 : this.pc.runJumpFrames, w);
        ap.emit("jump", `jumped ${stomp ? "onto" : "over"} ${s.enemy.th.key}`);
      } else if (s.gap && s.gapDist < cell * 0.6 + speedPx * 3) {
        if (c.run) want.held.set("run", c.run);
        this.pressJump(want, this.pc.runJumpFrames, w);
        ap.emit("jump", `jumped a ${s.gap}-wide ${s.hazard ? "hazard" : "gap"}`);
      } else if (s.wall && s.wallDist < cell * 0.9 + speedPx * 2) {
        this.pressJump(want, Math.min(this.pc.runJumpFrames, 8 + 5 * s.wall), w);
        ap.emit("jump", `jumped a ${s.wall}-high wall`);
      }
    } else if (!b.onGround && this.jumping) {
      // in the air: keep pushing toward safe ground; stop holding jump early for small hops near a target
      if (dist < cell && this.jumpHold > 4) this.jumpHold = 2;
    }
    // stuck: no x progress while on the ground
    if (this.lastX == null || Math.abs(b.x - this.lastX) > cell * 0.15) { this.lastX = b.x; this.lastProgressT = t; this.stuckN = 0; }
    else if (b.onGround && t - this.lastProgressT > 0.45) {
      this.stuckN = (this.stuckN || 0) + 1; this.lastProgressT = t;
      if (this.stuckN % 3 === 0) { this.backoffUntil = t + 0.45; this.backoffDir = dir; ap.emit("stuck", `stuck at cell x=${Math.floor(b.x / cell)}; backing up for a run-up`); this.recordIncident(w, b, dir, "backed up for a run-up"); }
      else { this.pressJump(want, this.pc.runJumpFrames, w); if (this.stuckN === 1) ap.emit("bump", `blocked at cell x=${Math.floor(b.x / cell)}; trying a high jump`); }
    }
    return {};
  }

  /**
   * Choose the air input (-1, 0, +1) that lands safest. Frame-by-frame forward simulation with the measured gravity and
   * an assumed air acceleration; enemies move at their measured velocity. Returns {input, threat} or null (no enemies).
   */
  airPlan(w, b, dir, invincible) {
    const cell = w.cell, vF = this.vF || [0, 0], g = this.g || cell * 0.028, acc = this.pc.airAccel ?? cell * 0.005;
    const maxV = Math.max(Math.abs(vF[0]), this.maxVx || 0, cell * 0.09);
    const foes = w.things.filter((th) => th.rel === "hostile" && !th.dead && Math.abs(th.p2[0] - b.x) < cell * 6 && th.p2[1] > b.y - cell * 3 && th.p2[1] - b.y < cell * 6);
    if (!foes.length) return null;
    const groundBelow = (x, y) => { for (let yy = y; yy < y + cell * 8; yy += cell / 2) { const ch = this.tileAt(w, x, yy); if (ch === null) return null; if (this.isSolid(w, ch) || this.isOneway(w, ch)) return Math.floor((yy - (w.map ? w.map.origin[1] : 0)) / cell) * cell + (w.map ? w.map.origin[1] : 0); if (this.isHazard(w, ch)) return Infinity; } return Infinity; };
    let best = null;
    for (const input of [dir, 0, -dir]) {
      let x = b.x, foot = b.foot, vx = vF[0], vy = vF[1], score = input === dir ? 1 : input === 0 ? 0.5 : 0, threat = null, outcome = "land";
      for (let f = 1; f <= 90; f++) {
        vx = Math.max(-maxV, Math.min(maxV, vx + input * acc)); vy += g; x += vx; foot += vy;
        for (const th of foes) {
          const ex = th.p2[0] + (th.v ? th.v[0] : 0) * f, fw = th.size ? th.size[0] : cell * 0.75, fh = th.size ? th.size[1] : cell * 0.9;
          const top = th.p2[1] - fh / 2, bottom = th.p2[1] + fh / 2;
          if (Math.abs(x - ex) < (b.w + fw) / 2 && foot > top && foot - b.h < bottom) {
            if ((invincible || th.stompable !== false) && foot - vy <= top + 2 && vy > 0) { score += 5; outcome = "stomp"; }
            else { score -= 100; threat = th; outcome = "hit"; }
            break;
          }
        }
        if (outcome !== "land") break;
        const gy = vy > 0 ? groundBelow(x, foot - vy) : null;
        if (gy != null && gy !== Infinity && foot >= gy) {
          // landed: slide on with our momentum for a few frames; penalise ending up against an enemy before we can react
          const fr0 = this.friction || cell * 0.007;
          let sx = x, svx = vx;
          for (let k = 1; k <= 10; k++) {
            svx = Math.sign(svx) * Math.max(0, Math.abs(svx) - fr0); sx += svx;
            for (const th of foes) { const ex = th.p2[0] + (th.v ? th.v[0] : 0) * (f + k); if (Math.abs(sx - ex) < (b.w + (th.size ? th.size[0] : cell * 0.75)) / 2 + cell * 0.1 && Math.abs(th.p2[1] - (gy - b.h / 2)) < cell) { score -= 40; threat = threat || th; k = 99; break; } }
          }
          break;
        }
        if (gy === Infinity && foot > (w.map ? w.map.origin[1] + w.map.rows.length * w.map.cell : foot + 1)) { score -= 80; break; }   // falling into a pit
      }
      if (!best || score > best.score) best = { input, score, threat: score < 0 ? threat : null, outcome };
    }
    return best;
  }

  /** Star power and the like: everything can be run through. */
  invincible(w) { const r = w.player && w.player.raw; return !!(r && (r.star === true || r.invincible === true || r.starPower === true)); }

  /**
   * The platformer guard reflex for orders that aren't moving (wait, press, look ...): an enemy about to touch you on
   * the ground gets jumped on (stompable) or jumped away from. Returns true when it acted.
   */
  guard(w, want) {
    const b = this.body(w), cell = w.cell;
    this.holdJump(w, want);
    if (!b.onGround || this.jumping || this.invincible(w)) return false;
    const foe = w.things.filter((th) => th.rel === "hostile" && !th.dead && Math.abs(th.p2[1] - b.y) < cell * 1.1 && Math.abs(th.p2[0] - b.x) < cell * 1.6)
      .sort((p, q) => Math.abs(p.p2[0] - b.x) - Math.abs(q.p2[0] - b.x))[0];
    if (!foe) return false;
    const vx = foe.raw && Array.isArray(foe.raw.vel) ? foe.raw.vel[0] : null;
    const closing = vx == null || Math.sign(vx) === Math.sign(b.x - foe.p2[0]) || Math.abs(foe.p2[0] - b.x) < cell * 0.9;
    if (!closing) return false;
    const toward = Math.sign(foe.p2[0] - b.x) || 1, dir = foe.stompable === false ? -toward : toward;
    if (dir > 0 && this.c.move.right) want.held.set("move:right", this.c.move.right); else if (dir < 0 && this.c.move.left) want.held.set("move:left", this.c.move.left);
    if (this.pressJump(want, foe.stompable === false ? this.pc.runJumpFrames : this.pc.jumpFrames * 0.7, w)) this.ap.emit("reflex", `${foe.stompable === false ? "jumped away from" : "jumped onto"} ${foe.key} (it was about to hit you)`);
    return true;
  }

  recordIncident(w, b, dir, how) {
    this.ap.incidents.push({ t: this.ap.t, cell: [Math.floor(b.x / w.cell), Math.floor(b.y / w.cell)], heading: dir > 0 ? "E" : "W", seconds: 0.45 * (this.stuckN || 1), resolved: true, how, blocks: this.stuckN || 1 });
  }

  /** fight in a platformer: shoot if allowed and asked for, else stomp. */
  fight(w, want, th, fb) {
    const c = this.c, cell = w.cell, b = this.body(w);
    if ((fb.mode === "ranged" || fb.o.using) && c.attack) {
      const dx = th.p2[0] - b.x;
      if (Math.abs(dx) > cell * 7) { this.tick(w, want, { targetX: th.p2[0], reachX: cell * 6 }); return null; }
      const dir = Math.sign(dx);
      if (dir > 0 && c.move.right) want.held.set("move:right", c.move.right); else if (dir < 0 && c.move.left) want.held.set("move:left", c.move.left);
      this.holdJump(w, want);
      this.ap.attack(want);
      return null;
    }
    return this.stompTick(w, want, th);
  }

  stompTick(w, want, th) {
    const cell = w.cell, b = this.body(w);
    this.holdJump(w, want);
    const dx = th.p2[0] - b.x, dir = Math.sign(dx) || 1;
    if (dir > 0 && this.c.move.right) want.held.set("move:right", this.c.move.right); else if (dir < 0 && this.c.move.left) want.held.set("move:left", this.c.move.left);
    this.ap.wantedMoveNow = true;
    this.ap.fastUntil = this.ap.t + 0.3;
    const speedPx = Math.abs(b.vx);
    if (b.onGround && !this.jumping && Math.abs(dx) < cell * 1.8 + speedPx * 5 && th.p2[1] > b.head - cell) this.pressJump(want, this.pc.jumpFrames * 0.7, w);
    return null;
  }

  makeRun(o, w) {
    const ap = this.ap, runner = this, cell = w.cell;
    const dir = o.dir === "W" || o.dir === "NW" || o.dir === "SW" ? -1 : 1;
    const targetX = o.toX != null ? (w.origin ? w.origin[0] : 0) + (o.toX + 0.5) * cell : w.player.p2[0] + dir * (o.n ?? 12) * cell;   // cell coordinates, as observations show them
    const x0 = w.player.p2[0];
    runner.bestDist = Infinity; runner.bestT = ap.t;
    return mk(o, ap, (w2, want) => {
      const r = runner.tick(w2, want, { targetX, reachX: cell * 0.4 });
      if (r.arrived) return { status: "done", msg: `ran ${o.dir === "W" ? "left" : "right"} ${r1(Math.abs(w2.player.p2[0] - x0) / cell)} cells` };
      if (r.fail) return { status: "fail", msg: r.fail };
      return { status: "run" };
    }, { guardable: false });
  }

  makeJump(o, w) {
    const ap = this.ap, runner = this, cell = w.cell;
    if (!this.c.jump) throw new OrderError("no jump control is configured (play.controls.jump)");
    const frames = o.frames ?? { short: 5, medium: this.pc.jumpFrames * 0.6, long: this.pc.runJumpFrames, high: this.pc.runJumpFrames }[o.size || "medium"];
    const dir = o.dir === "E" ? 1 : o.dir === "W" ? -1 : 0;
    let started = false; const x0 = w.player.p2[0];
    return mk(o, ap, (w2, want) => {
      runner.holdJump(w2, want);
      if (dir > 0 && runner.c.move.right) want.held.set("move:right", runner.c.move.right);
      if (dir < 0 && runner.c.move.left) want.held.set("move:left", runner.c.move.left);
      if (dir && (o.size === "long" || o.size === "high") && runner.c.run) want.held.set("run", runner.c.run);
      ap.fastUntil = ap.t + 0.3;
      if (!started) { if (runner.pressJump(want, frames, w2)) started = true; return { status: "run" }; }
      if (!runner.jumping) return { status: "done", msg: `jumped ${o.size || ""}${dir ? (dir > 0 ? " right" : " left") : ""} (moved ${r1((w2.player.p2[0] - x0) / cell)} cells)`.replace(/\s+/g, " ") };
      if (ap.t - runner.jumpT > 3) return { status: "done", msg: "jumped (still in the air)" };
      return { status: "run" };
    });
  }

  makeStomp(o, w) {
    const ap = this.ap, runner = this;
    const th0 = resolveTarget(o.target, w, { prefer: "hostile", allowRemembered: false }).things[0];
    let tries = 0, wasAir = false; const t0 = ap.t;
    return mk(o, ap, (w2, want) => {
      const th = w2.things.find((x) => x.id === th0.id && !x.dead);
      if (!th) return { status: "done", msg: `${th0.key} is gone` };
      if (w2.dead) return { status: "fail", msg: "you died" };
      runner.stompTick(w2, want, th);
      const b = runner.body(w2);
      if (!b.onGround) wasAir = true;
      else if (wasAir) { wasAir = false; tries++; if (tries >= 4) return { status: "fail", msg: `4 stomp attempts on ${th.key} missed` }; }
      return ap.t - t0 > 8 ? { status: "fail", msg: `couldn't get onto ${th.key} in 8s (out of reach? try "run" toward it, or "wait for ${th.key}")` } : { status: "run" };
    });
  }
}

/** A tiny behaviour object from a tick function (keeps platformer orders self-contained). */
function mk(o, ap, fn, extra = {}) {
  return { o, label: o.text, t0: ap.t, guardable: false, instant: false, ...extra, get age() { return ap.t - this.t0; }, tick: fn };
}

export { parseControl, clip };
