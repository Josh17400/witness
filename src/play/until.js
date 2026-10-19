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
    this.last = null; this.lo = null; this.hi = null; this.offset = 0; this.warning = null;   // raw readings, for a clock that goes backwards
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
  /** The clock expression's value in hours; throws when it isn't a number here (a title screen without day/hour). */
  clockOf(snap) {
    const raw = evaluate(this.clock, snap);
    const v = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? +raw : NaN;
    if (!Number.isFinite(v)) throw new Error(`play.clock "${this.clock}" isn't a number here (got ${raw === undefined ? "undefined" : typeof raw === "number" ? String(raw) : JSON.stringify(raw)})`);
    return v;
  }
  /**
   * The clock as it runs: a reading below the previous one is a clock that wrapped or was reset. A wrap at midnight
   * (from 12h or later to under 12h, by 12h or more) is counted as the next day (+24h); any other sharp drop (more
   * than half the range seen so far, or below the start with --game-hours) is warned about.
   */
  read(snap) {
    const v = this.clockOf(snap);
    if (this.last != null && v < this.last - 1e-9) {
      const drop = this.last - v, from = this.last;
      const hint = "include the day so it keeps increasing, e.g. state.day*24 + state.hour";
      if (from >= 12 && from <= 24.5 && v >= 0 && v < 12 && drop >= 12) {
        this.offset += 24;
        this.warning = `play.clock wrapped past midnight (${r1(from)}h → ${r1(v)}h), counted as the next day: ${hint}`;
      } else if (drop > 0.5 * (this.hi - this.lo) || (this.clock0 != null && this.gameHours != null && v + this.offset < this.clock0)) {
        this.warning = `play.clock went backwards (${r1(from)}h → ${r1(v)}h)${this.gameHours != null ? ", so --game-hours may never be reached" : ""}: ${hint}`;
      }
    }
    this.last = v; this.lo = this.lo == null ? v : Math.min(this.lo, v); this.hi = this.hi == null ? v : Math.max(this.hi, v);
    return v + this.offset;
  }
  /** At the session start: check --until works (throws a clear error). The clock may not be readable yet (a title screen): it is anchored at its first reading. */
  start(snap) {
    if (this.until) { try { evaluate(this.until, snap); } catch (e) { throw new Error(`--until "${this.until}": ${e.message}`); } }
    if (this.check(snap)) {
      const s = (snap && snap.state) || {}, m = /^\s*state\.hour\s*>=?\s*(\d+(?:\.\d+)?)\s*$/.exec(this.until || "");
      const hint = m && typeof s.day === "number" ? ` To play until that hour tomorrow, include the day: --until "state.day*24 + state.hour >= ${(s.day + 1) * 24 + +m[1]}"`
        : /\bhour\b/.test(this.until || "") ? ' For a time of day that has already passed today, include the day: --until "state.day*24 + state.hour >= <hours>"' : "";
      throw new Error(`--until is already reached at the start (${this.hit.why}): nothing to play.${hint}`);
    }
  }
  /** After a step: true once the goal is reached (stays true). */
  check(snap, t = snap.time) {
    if (this.hit) return true;
    let why = null;
    if (this.clock) {
      try {
        this.now = this.read(snap);
        if (this.clock0 == null) { this.clock0 = this.now; if (this.gameHours != null) this.target = this.clock0 + this.gameHours; }
        if (this.target != null && this.now >= this.target - 1e-9) why = `the game clock reached ${r1(this.now)}h (${fmtHours(this.now - this.clock0)} of in-game time)`;
      } catch (e) { this.errors++; this.lastError = e.message; }
    }
    if (!why && this.until) { try { if (evaluate(this.until, snap)) why = `${this.until} is true`; } catch (e) { this.errors++; this.lastError = e.message; } }
    if (why) this.hit = { t: +(+t || 0).toFixed(2), frame: snap.frame, why, clock: this.now };
    return !!this.hit;
  }
  /** The observation's clock line (null when there is nothing to show). */
  line() {
    const bits = [];
    if (this.clock && this.now != null) bits.push(`clock ${r1(this.now)}h${this.clock0 != null && this.now !== this.clock0 ? ` (+${fmtHours(this.now - this.clock0)} since the start)` : ""}`);
    else if (this.gameHours != null && !this.hit) bits.push(`game clock not readable yet (${this.lastError || "no reading"}): the ${fmtHours(this.gameHours)} of in-game time count from its first reading`);
    if (this.hit) bits.push(`UNTIL REACHED (${this.hit.why}): run END now`);
    else {
      if (this.target != null) bits.push(`${fmtHours(this.target - this.now)} of in-game time to go (until clock ${r1(this.target)}h)`);
      if (this.until) bits.push(`playing until: ${this.until} (not yet)`);
    }
    if (this.warning) bits.push(`⚠ ${this.warning}`);
    return bits.length ? `⏲ ${bits.join(" · ")}` : null;
  }
  report() {
    if (!this.active && !this.clock) return null;
    return { until: this.until, gameHours: this.gameHours, clock: this.clock, clockStart: this.clock0, clockEnd: this.now, target: this.target, reached: !!this.hit, at: this.hit, evalErrors: this.errors || undefined, lastError: this.errors ? this.lastError : undefined, warning: this.warning || undefined };
  }
}
