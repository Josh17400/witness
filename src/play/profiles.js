// Witness play: locomotion and aiming per game style. A profile turns the autopilot's intent (a direction on the
// ground plane, something to face or aim at) into controls: held keys, stick axes, mouse deltas.
import { norm, len, sub, angleBetween, compass, dot } from "./util.js";

const FACE4 = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };

/** Shared helper: the move controls for a plane direction (8-way keys) or stick axes. */
export function moveControls(cfg, dir, northSign, want, cell = null) {
  const mv = cfg.controls.move;
  if (!dir || len(dir) < 1e-9) { if (mv.axis) { want.axes[mv.axis[0]] = 0; want.axes[mv.axis[1]] = 0; } return; }
  const d = norm(dir);
  const screenY = northSign === -1 ? d[1] : -d[1];   // + = down on screen
  if (mv.axis) { want.axes[mv.axis[0]] = +d[0].toFixed(3); want.axes[mv.axis[1]] = +screenY.toFixed(3); return; }
  // 8-way keys: press an axis when its share of the direction is clear (22.5 degree sectors), or, with digital input,
  // when the raw offset on that axis is bigger than a small tolerance: that lines the body up with a corridor before
  // turning into it, instead of snagging on the corner.
  const t = Math.sin(Math.PI / 8), tol = cell ? cell * 0.1 : Infinity;
  const rx = dir[0], ry = northSign === -1 ? dir[1] : -dir[1];
  const on = (comp, raw, other) => Math.abs(comp) > t || (Math.abs(raw) > tol && Math.abs(raw) >= 0.2 * Math.abs(other));
  if (on(d[0], rx, ry)) { if (rx > 0 && mv.right) want.held.set("move:right", mv.right); if (rx < 0 && mv.left) want.held.set("move:left", mv.left); }
  if (on(screenY, ry, rx)) { if (ry < 0 && mv.up) want.held.set("move:up", mv.up); if (ry > 0 && mv.down) want.held.set("move:down", mv.down); }
}

export class TopdownProfile {
  constructor(ap) { this.ap = ap; this.kind = "topdown"; }
  /** Apply a movement intent. Returns {aligned: true}. */
  move(world, dir, want) { moveControls(this.ap.cfg, dir, world.northSign, want, world.cell); return { aligned: true }; }
  /** Face a point: tap the move key toward it for a frame if the game's facing says we're turned the wrong way. */
  face(world, targetP2, want) {
    const p = world.player; if (!p || !p.p2) return true;
    const d = sub(targetP2, p.p2);
    if (len(d) < 1e-6) return true;
    const want4 = Math.abs(d[0]) >= Math.abs(d[1]) ? (d[0] > 0 ? "E" : "W") : ((world.northSign === -1 ? d[1] : -d[1]) > 0 ? "S" : "N");
    const facing = p.facing || this.ap.facingGuess;
    if (!facing) return true;                    // unknown facing: assume the approach left us facing it
    if (facing === want4 || (facing.length === 2 && facing.includes(want4))) return true;
    const mv = this.ap.cfg.controls.move;
    const ctl = { N: mv.up, S: mv.down, E: mv.right, W: mv.left }[want4];
    if (ctl && this.ap.t - (this.lastNudge ?? -1) > 0.12) { want.taps.push({ label: `nudge:${want4}`, c: ctl, frames: 1 }); this.lastNudge = this.ap.t; }
    return false;
  }
  aim() { return true; }
}

/** Shared by fps: the player's look direction on the plane (and pitch), from `look` or yaw/pitch. */
export function lookOf(world, cfg) {
  const p = world.player; if (!p) return null;
  const [a, b] = cfg.plane;
  if (Array.isArray(p.look) && p.look.length >= 2) {
    const v = p.look.length >= 3 ? [p.look[a], p.look[b]] : [p.look[0], p.look[1]];
    const up = p.look.length >= 3 ? p.look[3 - a - b] : 0;
    const h = len(v);
    return { dir: norm(v), pitch: Math.atan2(up, h || 1e-9) };
  }
  if (p.yaw != null) {
    const yaw = cfg.fps.degrees ? (p.yaw * Math.PI) / 180 : p.yaw;
    const sgn = cfg.fps.yawSign ?? 1;
    // default convention: yaw 0 looks toward -plane[1] (e.g. -Z), positive yaw turns toward +plane[0] (right)
    const dir = [Math.sin(yaw * sgn), -Math.cos(yaw * sgn)];
    const pitch = p.pitch == null ? 0 : cfg.fps.degrees ? (p.pitch * Math.PI) / 180 : p.pitch;
    return { dir, pitch };
  }
  return null;
}

export class FpsProfile {
  constructor(ap) {
    this.ap = ap; this.kind = "fps";
    const s = ap.cfg.fps.sens;
    this.sens = s ? { x: +(Array.isArray(s) ? s[0] : s), y: +(Array.isArray(s) ? s[1] : s) } : null;   // radians per mouse pixel (signed)
    this.calib = null;   // calibration state
  }
  /** Turn toward a plane direction (and pitch) with mouse deltas; returns the remaining yaw error (radians). */
  turn(world, dir, want, pitch = null, { maxStep = 0.6 } = {}) {
    const look = lookOf(world, this.ap.cfg);
    if (!look || !dir || len(dir) < 1e-9) return 0;
    const err = angleBetween(look.dir, norm(dir));   // signed, plane coords
    const perr = pitch == null ? 0 : pitch - look.pitch;
    if (!this.ready(world, want, look)) return err;
    const c = Math.max(-maxStep, Math.min(maxStep, err)), pc = Math.max(-maxStep, Math.min(maxStep, perr));
    let dx = this.sens.x ? c / this.sens.x : 0, dy = this.sens.y && pitch != null ? pc / this.sens.y : 0;
    dx = Math.round(dx); dy = Math.round(dy);
    if (dx || dy) want.mouse = [(want.mouse?.[0] || 0) + dx, (want.mouse?.[1] || 0) + dy];
    return err;
  }
  /** Auto-calibrate mouse sensitivity: move the mouse, watch the look direction change. */
  ready(world, want, look) {
    if (this.sens && this.sens.x && this.sens.y) return true;
    const c = this.calib || (this.calib = { phase: "x", t0: null, look0: null });
    if (c.phase === "x") {
      if (!c.look0) { c.look0 = look; want.mouse = [40, 0]; return false; }
      const d = angleBetween(c.look0.dir, look.dir);
      if (Math.abs(d) > 1e-4) { this.sens = { x: d / 40, y: null }; c.phase = "y"; c.look0 = null; this.ap.note(`calibrated mouse yaw: ${(d / 40 * 1000).toFixed(2)} mrad/px`); }
      else { c.tries = (c.tries || 0) + 1; if (c.tries > 4) { this.sens = { x: 0.002, y: -0.002 }; this.ap.note("mouse calibration saw no turn; using 0.002 rad/px"); return true; } want.mouse = [40, 0]; c.look0 = look; }
      return false;
    }
    if (c.phase === "y") {
      if (!c.look0) { c.look0 = look; want.mouse = [0, 20]; return false; }
      const d = look.pitch - c.look0.pitch;
      this.sens.y = Math.abs(d) > 1e-5 ? d / 20 : -Math.abs(this.sens.x);
      want.mouse = [0, -20];        // put the view back
      c.phase = "done";
      return false;
    }
    return true;
  }
  /** Move along a plane direction using forward/back/strafe keys relative to the look direction; turn toward it too. */
  move(world, dir, want, { faceDir = null, turn = true } = {}) {
    const look = lookOf(world, this.ap.cfg);
    const mv = this.ap.cfg.controls.move;
    if (!dir || len(dir) < 1e-9) { if (turn && faceDir) this.turn(world, faceDir, want); return { aligned: true }; }
    if (!look) { moveControls(this.ap.cfg, dir, world.northSign, want); return { aligned: true }; }
    const d = norm(dir), f = look.dir;
    // right vector: forward turned 90° clockwise as seen on a map with north up
    const right = world.northSign === -1 ? [-f[1], f[0]] : [f[1], -f[0]];
    const fw = dot(d, f), st = dot(d, right);
    const t = 0.38;
    if (fw > t && mv.up) want.held.set("move:up", mv.up);
    if (fw < -t && mv.down) want.held.set("move:down", mv.down);
    if (st > t && mv.right) want.held.set("move:right", mv.right);
    if (st < -t && mv.left) want.held.set("move:left", mv.left);
    let err = 0;
    if (turn) err = this.turn(world, faceDir || d, want);
    return { aligned: Math.abs(err) < 0.8 };
  }
  face(world, targetP2, want) {
    const p = world.player; if (!p) return true;
    const err = this.turn(world, sub(targetP2, p.p2), want);
    return Math.abs(err) < 0.06;
  }
  /** Aim at a 3D point (yaw + pitch). Returns {yawErr, pitchErr} in radians. */
  aim(world, target, want) {
    const p = world.player; if (!p || !p.pos || !target) return { yawErr: Math.PI, pitchErr: 0 };
    const cfg = this.ap.cfg, [a, b] = cfg.plane, up = 3 - a - b;
    const eye = p.pos.length > 2 ? p.pos[up] + (cfg.fps.eye ?? 1.5) : 0;
    const tpos = target.pos;
    const ty = tpos.length > 2 ? tpos[up] + (cfg.fps.aimHeight ?? 1.2) : eye;
    const horiz = sub(target.p2, p.p2);
    const pitch = Math.atan2(ty - eye, len(horiz) || 1e-6);
    const yawErr = this.turn(world, horiz, want, pitch, { maxStep: cfg.fps.maxTurn ?? 0.5 });
    const look = lookOf(world, cfg);
    return { yawErr, pitchErr: look ? pitch - look.pitch : 0 };
  }
}

export function makeProfile(kind, ap) {
  if (kind === "fps") return new FpsProfile(ap);
  return new TopdownProfile(ap);   // the platformer profile uses its own navigator (platformer.js) and topdown helpers
}

export { FACE4, compass };
