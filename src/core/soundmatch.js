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
 * A sound event is heard at the nearest onset from 2 frames before to 4 frames after its declared start.
 * Returns { sounds: [{ label, t, f, declared, heard }], unreported: [{ t, f }] (onsets no event explains),
 *           lag: median (heard frame - declared frame - 1) over the heard events, or null }.
 */
export function alignSoundEvents(soundEvents, onsets, fps) {
  const sounds = [], used = new Set(), lags = [];
  for (const e of soundEvents) {
    const t0 = (+e.frame || 0) / fps;
    let best = null;
    for (let i = 0; i < onsets.length; i++) {
      const d = onsets[i].t - t0;
      if (d < -2 / fps - 1e-9 || d > 4 / fps + 1e-9) continue;
      if (!best || Math.abs(d) < Math.abs(best.d)) best = { i, d };
    }
    const heard = !!best;
    const t = heard ? onsets[best.i].t : t0;
    if (heard) used.add(best.i);
    const f = soundFrame(t, fps);
    if (heard) lags.push(f - (e.frame + 1));
    sounds.push({ label: String(e.name ?? "sound"), t, f, declared: e.frame, heard, volume: e.volume, pos: e.pos });
  }
  const unreported = onsets.map((o, i) => ({ t: o.t, f: soundFrame(o.t, fps), i })).filter((o) => !used.has(o.i) && !sounds.some((s) => Math.abs(s.t - o.t) <= 2 / fps));
  lags.sort((a, b) => a - b);
  return { sounds, unreported, lag: lags.length ? lags[lags.length >> 1] : null };
}

/**
 * Match each action (an input press or a state event) with the sound it should have made.
 * actions: [{ label, f, kind: "input" | "state" }]; sounds: [{ label, f, t }]
 * opts.within: the window in frames after the event (default 6); opts.early: also look this many frames before
 * it for a sound that came too soon (default 2).
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
    const cands = sounds.map((s, i) => ({ s, i, off: s.f - a.f })).filter((c) => !mine.has(c.i) && c.off >= 0 && c.off <= within);
    cands.sort((p, q) => p.off - q.off || p.s.t - q.s.t);
    const pick = cands[0] || null;
    const m = { action: a, sound: pick ? pick.s : null, offset: pick ? pick.off : null, doubles: [], early: null, before: lastMatch.get(a.label) || null };
    if (pick) {
      mine.add(pick.i); used.add(pick.i);
      // the same sound again inside the window, within 2 frames: a double trigger
      for (const c of cands.slice(1)) if (c.s.label === pick.s.label && c.off - pick.off <= 2) { m.doubles.push({ sound: c.s, offset: c.off }); mine.add(c.i); used.add(c.i); }
      lastMatch.set(a.label, { action: a, sound: pick.s });
    } else {
      const e = sounds.map((s, i) => ({ s, i, off: s.f - a.f })).filter((c) => !used.has(c.i) && c.off < 0 && c.off >= -early).sort((p, q) => q.off - p.off)[0];
      if (e) m.early = { sound: e.s, offset: e.off };
    }
    matches.push(m);
  }
  const unexplained = sounds.filter((s, i) => !used.has(i));
  return { matches, unexplained };
}
