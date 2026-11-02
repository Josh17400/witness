// Witness play: why the game went away. A closed laptop (the machine slept) or a closed browser is not a crash: the
// daemon notes host sleep (its 2 s timer wakes up late, or the wall clock jumps ahead of the monotonic one) and, when the
// connection drops after it, says "session interrupted"; a browser that goes away with no game error is "browser
// closed". Real crashes (a page crash, a game error, an exception or fatal line in the last output, a nonzero exit) stay
// CRASHED; after a sleep only a game error, a stack frame or a fatal line does.

/** Host sleep detection: tick(now, mono) every ~2 s; a gap of more than `gapS` seconds beyond the period is a sleep. */
export class SleepWatch {
  constructor({ periodMs = 2000, gapS = 20 } = {}) { this.periodMs = periodMs; this.gapMs = gapS * 1000; this.last = null; this.lastMono = null; this.sleeps = []; }
  /** One reading of the wall clock (Date.now) and a monotonic one (performance.now). → the sleep found, or null. */
  tick(now = Date.now(), mono = globalThis.performance ? performance.now() : now, t = null) {
    let found = null;
    if (this.last != null) {
      const wall = now - this.last, mon = mono - this.lastMono;
      // the timer itself came late (both clocks moved on), or the wall clock jumped while the monotonic one stood still
      if (wall - this.periodMs > this.gapMs || wall - mon > this.gapMs) found = this.note(Math.max(wall - this.periodMs, wall - mon) / 1000, now, t);
    }
    this.last = now; this.lastMono = mono;
    return found;
  }
  note(gapS, at = Date.now(), t = null) { const s = { at, gapS: Math.round(gapS), t }; this.sleeps.push(s); return s; }
  /** The last sleep that ended within `withinS` seconds before `now` (a drop right after waking), or null. */
  recent(now = Date.now(), withinS = 180) { const s = this.sleeps.at(-1); return s && now - s.at <= withinS * 1000 ? s : null; }
}

const CRASH_LINE = /\b(error|exception|fatal|panic|traceback|segmentation fault|abort(ed)?|stack overflow|unhandled|uncaught)\b|^\s*at .+:\d+/i;
// after a sleep only a hard crash line outranks it: a stack frame or a fatal one, not a stray "[error] 404" / "Uncaught (in promise)"
const HARD_LINE = /^\s*at .+:\d+|\b(fatal|panic|traceback|segmentation fault|stack overflow)\b/i;
const HARMLESS = /\b(outside nominal range|will be clamped|deprecated|warning)\b/i;

/**
 * How the game went away, from what is known when its connection dropped:
 *   {slept: {gapS, t}|null, web: bool (a browser page), code: exit code | signal | null, lines: last output/log lines
 *    (the caller keeps game logs to the last ~5 s), gameError: bool (a game error was reported in the last seconds),
 *    pageCrashed: bool (the browser said the page crashed: its renderer died)}
 * → {outcome: "crashed" | "interrupted" | "browser closed" | "exited", why: short reason}
 */
export function exitVerdict({ slept = null, web = false, code = null, lines = [], gameError = false, pageCrashed = false } = {}) {
  if (pageCrashed) return { outcome: "crashed", why: "the page crashed (its renderer died: out of memory?)" };
  const stack = lines.some((l) => (slept ? HARD_LINE : CRASH_LINE).test(l) && !HARMLESS.test(l));
  if (gameError || stack) return { outcome: "crashed", why: gameError ? "a game error came just before" : "its last output reads like a crash" };
  if (slept) return { outcome: "interrupted", why: `the machine slept for ~${slept.gapS}s` };
  if (web) return { outcome: "browser closed", why: "no game error before the page went away" };
  if (code === 0) return { outcome: "exited", why: "exit code 0, no error" };
  return { outcome: "crashed", why: code != null ? `exit ${code}` : "no exit code" };
}
