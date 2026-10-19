// Witness play: "play until …" — a session goal on the game's own state instead of a time budget. `--until "<expr>"`
// is any Witness expression over the snapshot (state.hour >= 18); `--game-hours N` needs play.clock (an expression
// giving in-game hours, e.g. "state.day*24 + state.hour + state.minute/60") and means clock >= clock-at-start + N.
// The daemon checks it after every step; once it is true the order stops, no more orders run, and the tester ENDs.
import { evaluate } from "../core/expr.js";
import { r1 } from "./util.js";

/** 1.5 → "1h30m", 0.25 → "15m", 2 → "2h" (in-game time amounts). */
export function fmtHours(h) {
  const m = Math.max(0, Math.round(h * 60)), hh = Math.floor(m / 60), mm = m % 60;
  return hh && mm ? `${hh}h${String(mm).padStart(2, "0")}m` : hh ? `${hh}h` : `${mm}m`;
}

export class UntilWatch {
  constructor({ until = null, gameHours = null, clock = null } = {}) {
    this.until = until ? String(until) : null;
    this.gameHours = gameHours != null && gameHours !== "" ? +gameHours : null;
    this.clock = clock ? String(clock) : null;
    this.clock0 = null; this.target = null; this.now = null; this.hit = null; this.errors = 0; this.lastError = null;
    if (this.gameHours != null && !(this.gameHours > 0)) throw new Error(`--game-hours must be a positive number of in-game hours (got ${gameHours})`);
    if (this.gameHours != null && !this.clock) throw new Error('--game-hours needs play.clock in witness.json: an expression giving in-game hours, e.g. "state.day*24 + state.hour" (or pass --clock "<expr>")');
  }
  get active() { return !!(this.until || this.gameHours != null); }
  /** What the tester plays until, in words. */
  get label() {
    const a = [];
    if (this.gameHours != null) a.push(`${fmtHours(this.gameHours)} of in-game time${this.target != null ? ` (clock ${r1(this.target)}h)` : ""}`);
    if (this.until) a.push(this.until);
    return a.join(" or ");
  }
  clockOf(snap) {
    const v = +evaluate(this.clock, snap);
    if (!Number.isFinite(v)) throw new Error(`play.clock "${this.clock}" isn't a number here (got ${JSON.stringify(v)})`);
    return v;
  }
  /** At the session start: check the expressions work (throws a clear error) and fix the clock's starting point. */
  start(snap) {
    if (this.clock) {
      try { this.clock0 = this.now = this.clockOf(snap); } catch (e) { throw new Error(`play.clock: ${e.message}`); }
      if (this.gameHours != null) this.target = this.clock0 + this.gameHours;
    }
    if (this.until) { try { evaluate(this.until, snap); } catch (e) { throw new Error(`--until "${this.until}": ${e.message}`); } }
    if (this.check(snap)) throw new Error(`--until is already reached at the start (${this.hit.why}): nothing to play`);
  }
  /** After a step: true once the goal is reached (stays true). */
  check(snap, t = snap.time) {
    if (this.hit) return true;
    let why = null;
    try {
      if (this.clock) this.now = this.clockOf(snap);
      if (this.target != null && this.now >= this.target - 1e-9) why = `the game clock reached ${r1(this.now)}h (${fmtHours(this.now - this.clock0)} of in-game time)`;
      if (!why && this.until && evaluate(this.until, snap)) why = `${this.until} is true`;
    } catch (e) { this.errors++; this.lastError = e.message; return false; }
    if (why) this.hit = { t: +(+t || 0).toFixed(2), frame: snap.frame, why, clock: this.now };
    return !!this.hit;
  }
  /** The observation's clock line (null when there is nothing to show). */
  line() {
    const bits = [];
    if (this.clock && this.now != null) bits.push(`clock ${r1(this.now)}h${this.clock0 != null && this.now !== this.clock0 ? ` (+${fmtHours(this.now - this.clock0)} since the start)` : ""}`);
    if (this.hit) bits.push(`UNTIL REACHED (${this.hit.why}): run END now`);
    else {
      if (this.target != null) bits.push(`${fmtHours(this.target - this.now)} of in-game time to go (until clock ${r1(this.target)}h)`);
      if (this.until) bits.push(`playing until: ${this.until} (not yet)`);
    }
    return bits.length ? `⏲ ${bits.join(" · ")}` : null;
  }
  report() {
    if (!this.active && !this.clock) return null;
    return { until: this.until, gameHours: this.gameHours, clock: this.clock, clockStart: this.clock0, clockEnd: this.now, target: this.target, reached: !!this.hit, at: this.hit, evalErrors: this.errors || undefined, lastError: this.errors ? this.lastError : undefined };
  }
}
