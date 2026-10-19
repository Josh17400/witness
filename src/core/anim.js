// Witness core: animation timing from a per-frame pose sequence (measure anim). The poses come from a state field
// (state.player.anim) or from pixels (sprite crops grouped into poses, src/media/anim.js); this part only sees labels.

const modeOf = (xs) => {
  const c = new Map();
  for (const x of xs) c.set(x, (c.get(x) || 0) + 1);
  let best = null, n = 0;
  for (const [x, k] of c) if (k > n || (k === n && x < best)) { best = x; n = k; }
  return best;
};

/**
 * Run-length encode labels over consecutive frames: [{ label, start (frame), len, i (index of the first sample),
 * cut }]. Unknown frames (null: hidden, merged with something) inside a hold are bridged when the pose is the same on
 * both sides; otherwise the holds next to them are marked cut (their true length isn't known).
 */
export function poseRuns(labels, frames) {
  const L = [...labels];
  for (let i = 0; i < L.length; i++) {
    if (L[i] !== null) continue;
    let j = i;
    while (j < L.length && L[j] === null) j++;
    if (i > 0 && j < L.length && L[i - 1] === L[j]) for (let k = i; k < j; k++) L[k] = L[j];
    i = j - 1;
  }
  const runs = [];
  L.forEach((l, i) => {
    const r = runs[runs.length - 1];
    if (r && l !== null && r.label === l && frames[i] === r.start + r.len) r.len++;
    else if (l !== null) runs.push({ label: l, start: frames[i], len: 1, i, cut: i > 0 && L[i - 1] === null });
    if (l === null && r && !r.cutEnd) r.cut = true;
  });
  return runs;
}

/**
 * The smallest cycle of a pose order (labels of consecutive runs): the period p (in poses) for which
 * seq[i] === seq[i + p] holds best (at most 10% mismatches, needs two cycles at least). Returns { p, mismatches:
 * [index into seq] } or null.
 */
export function posePeriod(seq) {
  for (let p = 2; 2 * p <= seq.length; p++) {
    const bad = [];
    for (let i = 0; i + p < seq.length; i++) if (seq[i] !== seq[i + p]) bad.push(i + p);
    const pairs = seq.length - p;
    if (bad.length <= Math.floor(0.1 * pairs)) return { p, mismatches: bad };
  }
  return null;
}

/**
 * Animation timing of a pose sequence sampled every frame (frames consecutive; null = not visible).
 * Returns {
 *   poses (distinct), animated, framesPerPose (the usual hold), holds: { label: usual hold },
 *   period (poses per loop), loopFrames (the usual loop length), loops: [{ start, frames, clean }], cycles,
 *   irregular: [{ label, start, len, usual }] (a pose held longer or shorter than usual: dropped/doubled frames),
 *   breaks: [{ start, label, expected }] (the pose order breaks the cycle: a skipped or extra pose),
 *   confidence: "sure" | "unsure", runs
 * }
 * The first and last runs are cut by the window, so they never count as holds.
 */
export function analyzeAnim(labels, frames) {
  const runs = poseRuns(labels, frames);
  const distinct = [...new Set(runs.map((r) => r.label))];
  const out = { poses: distinct.length, animated: distinct.length > 1, framesPerPose: null, holds: {}, period: null, loopFrames: null, loops: [], cycles: 0, irregular: [], breaks: [], confidence: "unsure", runs };
  if (!out.animated) return out;
  const complete = runs.slice(1, -1).filter((r) => !r.cut);
  if (!complete.length) return out;
  out.framesPerPose = modeOf(complete.map((r) => r.len));
  for (const l of distinct) {
    const own = complete.filter((r) => r.label === l).map((r) => r.len);
    if (own.length) out.holds[l] = modeOf(own);
  }
  // a hold is irregular when it differs by more than a frame from that pose's usual hold (when the pose shows up
  // 3+ times, so its own habit is known), else from the usual hold of all poses
  for (const r of complete) {
    const own = complete.filter((q) => q.label === r.label).map((q) => q.len);
    const ownMode = modeOf(own), ownCount = own.filter((x) => x === ownMode).length;
    const usual = own.length >= 3 && ownCount >= 2 ? ownMode : out.framesPerPose;
    if (Math.abs(r.len - usual) > 1) out.irregular.push({ label: r.label, start: r.start, len: r.len, usual });
  }
  const seq = runs.map((r) => r.label);
  // the cycle length in poses: a near-exact repeat of the order (handles ping-pong cycles like 0 1 2 1), else the
  // usual number of runs before a pose comes back (survives a skipped or extra pose)
  const per = posePeriod(seq);
  let p = per ? per.p : null;
  if (!p) {
    const back = [];
    seq.forEach((l, i) => { const j = seq.indexOf(l, i + 1); if (j > 0) back.push(j - i); });
    const m = back.length >= 3 ? modeOf(back) : null;
    if (m && m >= 2 && back.filter((x) => x === m).length >= 0.6 * back.length) p = m;
  }
  if (p) {
    out.period = p;
    // breaks: a pose change under half as common as the usual one after that pose: a skipped or extra pose
    const T = new Map();
    for (let i = 1; i < seq.length; i++) { const a = seq[i - 1]; if (!T.has(a)) T.set(a, new Map()); T.get(a).set(seq[i], (T.get(a).get(seq[i]) || 0) + 1); }
    for (let i = 1; i < seq.length; i++) {
      const next = T.get(seq[i - 1]), n = next.get(seq[i]);
      let top = null, tn = 0;
      for (const [b, c] of next) if (c > tn) { top = b; tn = c; }
      if (n * 2 < tn) out.breaks.push({ start: runs[i].start, label: seq[i], expected: top });
    }
    // loops: from one appearance of the opening pose to the next (the opening pose = the first complete one that
    // shows up once per cycle, so ping-pong middles don't split loops)
    const once = (l) => { const at = seq.map((x, i) => (x === l ? i : -1)).filter((i) => i >= 0); const d = at.slice(1).map((x, k) => x - at[k]); return d.length && modeOf(d) === p; };
    const open = seq.slice(1).find(once);
    if (open !== undefined) {
      const at = seq.map((x, i) => (x === open ? i : -1)).filter((i) => i >= 1);
      for (let k = 0; k + 1 < at.length; k++) {
        const part = runs.slice(at[k], at[k + 1]);
        if (at[k + 1] > runs.length - 1 || part.some((r) => r.cut)) continue;
        out.loops.push({ start: runs[at[k]].start, frames: runs[at[k + 1]].start - runs[at[k]].start, clean: part.length === p && !out.breaks.some((b) => b.start > runs[at[k]].start && b.start < runs[at[k + 1]].start) });
      }
    }
    out.cycles = +(seq.length / p).toFixed(1);
    if (out.loops.length) out.loopFrames = modeOf(out.loops.map((l) => l.frames));
    out.confidence = seq.length >= 2 * p + 1 ? "sure" : "unsure";
  }
  return out;
}
