// Witness play: "stuck dead". A hero that stays dead while respawn attempts change nothing (a broken death screen, a
// respawn key the harness doesn't know) would have the tester burn its turns pressing keys. After `limit` game
// seconds dead, with at least one input sent and no change in the state (a respawn countdown going down is a change),
// the session ends with outcome "stuck dead".
// Pure: the daemon and the unit tests share it.

// left out of "did anything change": timers and clocks, and the world around the body (enemies wander over it)
const SKIP = /^(t|time|frame|frames|tick|ticks|elapsed|clock|now|dt|fps|seconds|ms|anim|animation|particles|camera|entities|things|actors|objects|enemies|npcs|map|tiles|world|audio|sounds|perf|counts)$|(time|timer)$/i;

// a respawn countdown (respawnTimer, deathTimer, reviveTime, countdown …) going down means the hero is coming back
const COUNTDOWN = /respawn|revive|resurrect|death|dead|countdown|wait/i;

/** Numbers under countdown-like keys anywhere in the state (key path -> value). */
export function countdowns(state, out = new Map(), path = "", depth = 0) {
  if (!state || typeof state !== "object" || depth > 4) return out;
  for (const [k, v] of Object.entries(state)) {
    const p = path ? `${path}.${k}` : k;
    if (typeof v === "number" && Number.isFinite(v) && COUNTDOWN.test(k)) out.set(p, v);
    else if (v && typeof v === "object" && !Array.isArray(v)) countdowns(v, out, p, depth + 1);
  }
  return out;
}

/** The state with timers, clocks and the surrounding world left out, as a string to compare. */
export function deadSignature(state) {
  try { return JSON.stringify(state ?? null, (k, v) => (k && SKIP.test(k) ? undefined : typeof v === "number" ? Math.round(v * 100) / 100 : v)); }
  catch { return String(Math.random()); }
}

const inputLabel = (e) => e.type === "key" ? e.key : e.type === "action" ? `action:${e.action}` : e.type === "pad" ? `pad:${e.button}` : e.type === "mouse" ? `mouse${e.button != null ? `:${e.button}` : ""}` : e.type === "axis" ? `axis:${e.axis}=${e.value}` : e.type;

export class DeadWatch {
  constructor(limit = 20) { this.limit = Math.max(0, +limit || 0); this.inputs = []; this.reset(); }
  reset() { this.since = null; this.sig = null; this.attempts = 0; this.hit = null; this.counts = null; }
  /** Inputs sent to the game (controller events) at game time t. A press while dead is a respawn attempt. */
  input(t, events) {
    const downs = (events || []).filter((e) => e.down === true || (e.type === "axis" && e.value));
    for (const e of downs) { this.inputs.push({ t: +(+t).toFixed(2), input: inputLabel(e) }); }
    if (this.inputs.length > 16) this.inputs.splice(0, this.inputs.length - 16);
    if (this.since != null && downs.length) this.attempts++;
  }
  /** After every step. Returns the hit ({since, seconds, attempts, lastInputs, state}) once, then keeps returning it. */
  update(world) {
    if (!this.limit || this.hit) return this.hit;
    if (!world.dead) { this.reset(); return null; }
    const state = world.snap && world.snap.state;
    const sig = deadSignature(state), counts = countdowns(state), before = this.counts;
    this.counts = counts;
    const counting = before && [...counts].some(([k, v]) => before.has(k) && v > 0 && v < before.get(k) - 1e-9);
    if (this.since == null || sig !== this.sig || counting) { this.since = world.t; this.sig = sig; this.attempts = 0; return null; }
    if (world.t - this.since >= this.limit - 1e-9 && this.attempts > 0) {
      this.hit = { since: +this.since.toFixed(2), at: +world.t.toFixed(2), seconds: +(world.t - this.since).toFixed(1), attempts: this.attempts,
        lastInputs: this.inputs.filter((x) => x.t >= this.since - 0.01).slice(-10), state: trimState(state) };
    }
    return this.hit;
  }
  /** What the tester and report.md are told. */
  text() {
    const h = this.hit; if (!h) return null;
    const keys = [...new Set(h.lastInputs.map((x) => x.input))].join(", ");
    return `stuck dead: dead for ${Math.round(h.seconds)}s of game time with ${h.attempts} respawn attempt${h.attempts === 1 ? "" : "s"}${keys ? ` (pressed ${keys})` : ""} and nothing in the state changing`;
  }
}

/** The state for the report: everything but big lists, cut to a few kB. */
function trimState(state) {
  if (!state || typeof state !== "object") return state ?? null;
  const out = {};
  for (const [k, v] of Object.entries(state)) {
    if (Array.isArray(v) && v.length > 8) { out[k] = `[${v.length} items]`; continue; }
    const s = JSON.stringify(v);
    out[k] = s && s.length > 600 ? `${s.slice(0, 600)}…` : v;
  }
  return out;
}
