// Witness core: tie sounds to the events that should cause them (witness listen).
//
// Frames, the same convention everywhere:
//   an input event at frame F is applied at the start of stepping frame F, so its sound can be heard in frame F+1's
//   audio at the earliest (+1f = immediate);
//   a state event observed in snapshot G happened while stepping into G, the same step whose audio is frame G
//   (+0f = the same frame);
//   a sound starting at time t (seconds since reset) is heard first in frame floor(t * fps) + 1.

/** The frame whose audio first contains a sound starting at t seconds. */
export const soundFrame = (t, fps) => Math.floor(t * fps + 0.01) + 1;

/**
 * Line up the game's declared sound events with the onsets heard in the audio.
 * soundEvents: [{ name, frame }] (frame = the frame being simulated when the game started the sound)
 * onsets: [{ t }] (seconds, sorted)
 * A sound event is heard at an onset from 2 frames before to 4 frames after its declared start: the first one at or
 * after it (2 ms of slack), else the nearest one before it. Each onset belongs to one announced sound, so a sound
 * can't take an onset another sound (with a different start frame) is closer to: pairs are assigned best first, an
 * onset at or after the event always ahead of one before it. Sounds announced in the same frame share an onset
 * (`together`: the other labels, they can't be told apart).
 * An unheard sound that starts within 60 ms after another sound's onset gets `near: { label, ms }` (two onsets that
 * close are one to the detector).
 * Returns { sounds: [{ label, t, f, declared, heard, together?, near? }], unreported: [{ t, f }] (onsets no event
 *           explains), lag: median (heard frame - declared frame - 1) over the heard events, or null }.
 */
export function alignSoundEvents(soundEvents, onsets, fps) {
  const slack = 0.002;
  const evs = soundEvents.map((e) => ({ e, t0: (+e.frame || 0) / fps, label: String(e.name ?? "sound"), pick: null }));
  const pairs = [];
  evs.forEach((v, k) => onsets.forEach((o, i) => {
    const d = o.t - v.t0;
    if (d < -2 / fps - 1e-9 || d > 4 / fps + 1e-9) return;
    pairs.push({ k, i, cost: d >= -slack ? Math.max(0, d) : 1 + -d });
  }));
  pairs.sort((p, q) => p.cost - q.cost || p.k - q.k);
  const owner = new Map();   // onset index -> declared frame of the sound that has it
  for (const p of pairs) {
    const v = evs[p.k];
    if (v.pick !== null) continue;
    const f = owner.get(p.i);
    if (f !== undefined && f !== v.e.frame) continue;
    v.pick = p.i;
    owner.set(p.i, v.e.frame);
  }
  const sounds = [], lags = [];
  for (const v of evs) {
    const heard = v.pick !== null;
    const t = heard ? onsets[v.pick].t : v.t0;
    const f = soundFrame(t, fps);
    if (heard) lags.push(f - (v.e.frame + 1));
    const s = { label: v.label, t, f, declared: v.e.frame, heard, volume: v.e.volume, pos: v.e.pos };
    if (heard) {
      const together = evs.filter((w) => w !== v && w.pick === v.pick && w.label !== v.label).map((w) => w.label);
      if (together.length) s.together = [...new Set(together)];
    } else {
      // the onset just before it: whose it is (an announced sound's, or none)
      let near = null;
      onsets.forEach((o, i) => { const dt = v.t0 - o.t; if (dt > -slack && dt <= 0.06 && (!near || dt < near.dt)) near = { i, dt }; });
      if (near) { const w = evs.find((q) => q.pick === near.i); s.near = { label: w ? w.label : null, ms: Math.max(0, Math.round(near.dt * 1000)) }; }
    }
    sounds.push(s);
  }
  const used = new Set(evs.filter((v) => v.pick !== null).map((v) => v.pick));
  const unreported = onsets.map((o, i) => ({ t: o.t, f: soundFrame(o.t, fps), i })).filter((o) => !used.has(o.i) && !sounds.some((s) => Math.abs(s.t - o.t) <= 2 / fps));
  lags.sort((a, b) => a - b);
  return { sounds, unreported, lag: lags.length ? lags[lags.length >> 1] : null };
}

/**
 * Match each action (an input press or a state event) with the sound it should have made.
 * actions: [{ label, f, kind: "input" | "state" }]; sounds: [{ label, f, t }]
 * opts.within: the window in frames after the event (default 6; from +1f for an input, which can't be heard in its
 * own frame, +0f for a state event); opts.early: also look this many frames before that for a sound that came too
 * soon (default 2; for an input, a sound at +0f is too soon).
 * A sound serves at most one action per action label (so a press whose sound was eaten by a cooldown shows up),
 * but actions with different labels may share it (the press and the state change it causes).
 * Returns { matches: [{ action, sound, offset, doubles: [{ sound, offset }], early: { sound, offset } | null,
 *           before: { action, sound } | null }], unexplained: [sounds no action matched] }.
 */
export function matchSounds(actions, sounds, { within = 6, early = 2 } = {}) {
  const claimed = new Map();   // action label -> Set of sound indices
  const used = new Set();
  const ordered = [...actions].sort((a, b) => a.f - b.f);
  const matches = [];
  const lastMatch = new Map();   // action label -> its previous match (for "it played X last time")
  for (const a of ordered) {
    const mine = claimed.get(a.label) || new Set();
    claimed.set(a.label, mine);
    // an input's sound is heard +1f at the earliest; a state change's in its own frame
    const first = a.kind === "input" ? 1 : 0;
    const cands = sounds.map((s, i) => ({ s, i, off: s.f - a.f })).filter((c) => !mine.has(c.i) && c.off >= first && c.off <= within);
    cands.sort((p, q) => p.off - q.off || p.s.t - q.s.t);
    const pick = cands[0] || null;
    const m = { action: a, sound: pick ? pick.s : null, offset: pick ? pick.off : null, doubles: [], early: null, before: lastMatch.get(a.label) || null };
    if (pick) {
      mine.add(pick.i); used.add(pick.i);
      // the same sound again inside the window, within 2 frames: a double trigger
      for (const c of cands.slice(1)) if (c.s.label === pick.s.label && c.off - pick.off <= 2) { m.doubles.push({ sound: c.s, offset: c.off }); mine.add(c.i); used.add(c.i); }
      lastMatch.set(a.label, { action: a, sound: pick.s });
    } else {
      const e = sounds.map((s, i) => ({ s, i, off: s.f - a.f })).filter((c) => !used.has(c.i) && c.off < first && c.off >= -early).sort((p, q) => q.off - p.off)[0];
      if (e) m.early = { sound: e.s, offset: e.off };
    }
    matches.push(m);
  }
  const unexplained = sounds.filter((s, i) => !used.has(i));
  return { matches, unexplained };
}
