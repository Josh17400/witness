// Witness core: facts about values sampled over frames (trace tables, measure curve/jump/move/hitstop).
// Pure functions on series of points { f, v } (f = frame number, v = number or null), sorted by frame.
// Per-frame quantities (velocity, gravity) are computed only between consecutive frames, so they are exact
// when the series was sampled every frame and never mixed with sampling gaps.

const EPS = 1e-6;
const r3 = (x) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 1000) / 1000);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "boolean" ? +v : null);

/** Numeric points only. */
export const numeric = (pts) => pts.filter((p) => num(p.v) != null).map((p) => ({ f: p.f, v: num(p.v) }));

/** Per-frame steps between consecutive frames: [{ f, d }] where d = v(f) - v(f-1). */
export function steps(pts) {
  const out = [];
  for (let i = 1; i < pts.length; i++) if (pts[i].f === pts[i - 1].f + 1 && pts[i].v != null && pts[i - 1].v != null) out.push({ f: pts[i].f, d: pts[i].v - pts[i - 1].v });
  return out;
}

/**
 * Start/end/min/max (first frame reaching each) and the per-frame step range of a numeric series.
 * Returns null for a series with no numbers.
 */
export function summarize(pts) {
  const p = numeric(pts);
  if (!p.length) return null;
  let lo = p[0], hi = p[0];
  for (const q of p) { if (q.v < lo.v) lo = q; if (q.v > hi.v) hi = q; }
  const st = steps(p);
  let dlo = null, dhi = null;
  for (const s of st) { if (!dlo || s.d < dlo.d) dlo = s; if (!dhi || s.d > dhi.d) dhi = s; }
  return {
    start: { f: p[0].f, v: p[0].v }, end: { f: p[p.length - 1].f, v: p[p.length - 1].v },
    min: { f: lo.f, v: lo.v }, max: { f: hi.f, v: hi.v }, constant: hi.v - lo.v <= EPS,
    step: st.length ? { min: { f: dlo.f, d: r3(dlo.d) }, max: { f: dhi.f, d: r3(dhi.d) } } : null,
    samples: p.length,
  };
}

/** Where a value (any JSON) changes: [{ f, from, to }]. */
export function changes(pts) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const a = JSON.stringify(pts[i - 1].v), b = JSON.stringify(pts[i].v);
    if (a !== b) out.push({ f: pts[i].f, from: pts[i - 1].v, to: pts[i].v });
  }
  return out;
}

/** Truthy spans of a series: [{ from, to, toEnd }] (frames inclusive). */
export function spans(pts, test = (v) => !!v) {
  const out = [];
  let cur = null;
  for (const p of pts) {
    if (test(p.v)) { if (!cur) cur = { from: p.f, to: p.f }; else cur.to = p.f; }
    else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push({ ...cur, toEnd: true });
  return out;
}

/**
 * Frames where every series holds still (equal to its previous frame within eps): spans [{ from, to, frames,
 * bounded }] — `bounded` = something moved right before and right after (a pause, e.g. hitstop), as opposed to a
 * series that never started or never resumed. `series` = arrays of { f, v } (v a number or an array of numbers).
 */
export function frozenSpans(series, { eps = 1e-6 } = {}) {
  if (!series.length) return [];
  const maps = series.map((s) => new Map(s.map((p) => [p.f, p.v])));
  const frames = [...maps[0].keys()].sort((a, b) => a - b);
  const same = (a, b) => {
    if (a == null || b == null) return a === b;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= eps);
    if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= eps;
    return JSON.stringify(a) === JSON.stringify(b);
  };
  const out = [];
  let cur = null, movedBefore = false;
  for (const f of frames) {
    if (!maps.every((m) => m.has(f - 1))) { if (cur) { out.push(cur); cur = null; } movedBefore = false; continue; }
    const still = maps.every((m) => same(m.get(f), m.get(f - 1)));
    if (still) { if (!cur) cur = { from: f, to: f, after: movedBefore }; else cur.to = f; }
    else { if (cur) { out.push({ ...cur, resumed: true }); cur = null; } movedBefore = true; }
  }
  if (cur) out.push({ ...cur, resumed: false });
  return out.map((s) => ({ from: s.from, to: s.to, frames: s.to - s.from + 1, bounded: !!(s.after && s.resumed), afterMotion: !!s.after, resumed: !!s.resumed }));
}

/**
 * Step response facts of a numeric series going from its start to its end value: rise time (10% → 90% of the
 * change), settle frame (from then on within `band` of the change around the end value), overshoot (how far it
 * went past the end value, in units and % of the change). Null when start ≈ end.
 */
export function response(pts, { band = 0.02 } = {}) {
  const p = numeric(pts);
  if (p.length < 2) return null;
  const a = p[0].v, b = p[p.length - 1].v, ch = b - a;
  if (Math.abs(ch) <= EPS) return null;
  const frac = (v) => (v - a) / ch;
  const t10 = p.find((q) => frac(q.v) >= 0.1), t90 = p.find((q) => frac(q.v) >= 0.9);
  let settle = p[p.length - 1].f;
  for (let i = p.length - 1; i >= 0; i--) { if (Math.abs(frac(p[i].v) - 1) > band) { settle = i + 1 < p.length ? p[i + 1].f : p[i].f; break; } if (i === 0) settle = p[0].f; }
  let over = 0, overF = null;
  for (const q of p) { const o = (q.v - b) * Math.sign(ch); if (o > over + EPS) { over = o; overF = q.f; } }
  return {
    from: r3(a), to: r3(b), change: r3(ch),
    rise: t10 && t90 ? { from: t10.f, to: t90.f, frames: t90.f - t10.f } : null,
    settle: { f: settle },
    overshoot: { value: r3(over), percent: r3((100 * over) / Math.abs(ch)), f: overF },
  };
}

/**
 * How many frames series `a` follows series `b` (positive = a lags behind b), from the cross-correlation of their
 * per-frame steps over lags -maxLag..maxLag. Returns { lag, r } (r = the correlation at that lag) or null.
 */
export function lag(a, b, { maxLag = 60 } = {}) {
  const da = new Map(steps(numeric(a)).map((s) => [s.f, s.d])), db = new Map(steps(numeric(b)).map((s) => [s.f, s.d]));
  if (da.size < 3 || db.size < 3) return null;
  let best = null;
  for (let k = -maxLag; k <= maxLag; k++) {
    const xs = [], ys = [];
    for (const [f, d] of da) if (db.has(f - k)) { xs.push(d); ys.push(db.get(f - k)); }
    if (xs.length < 3) continue;
    const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    if (sxx <= EPS || syy <= EPS) continue;
    const r = sxy / Math.sqrt(sxx * syy);
    if (!best || r > best.r + 1e-9) best = { lag: k, r };
  }
  return best && { lag: best.lag, r: r3(best.r) };
}

/**
 * Frames whose step breaks a smooth motion: the step differs from the median of its ±3 neighbours by more than
 * max(minPx, 50% of that median) and from the mean of the steps just before and after, while the motion is under
 * way (both neighbouring steps move and agree with each other, the median is above minPx): a hitch, a repeated
 * frame or a 2× step — not a start, a stop, a smooth ramp or a switch between two speeds. [{ f, d, expected }]
 */
export function stutters(pts, { minPx = 0.25 } = {}) {
  const st = steps(numeric(pts));
  const out = [];
  for (let i = 0; i < st.length; i++) {
    const nb = [];
    for (let j = Math.max(0, i - 3); j <= Math.min(st.length - 1, i + 3); j++) if (j !== i && Math.abs(st[j].f - st[i].f) <= 3) nb.push(st[j].d);
    if (nb.length < 4) continue;
    nb.sort((x, y) => x - y);
    const med = nb.length % 2 ? nb[nb.length >> 1] : (nb[nb.length / 2 - 1] + nb[nb.length / 2]) / 2;
    if (Math.abs(med) < minPx) continue;
    // a ramp (accelerating or braking) is smooth: compare with the linear trend of the neighbours too
    const prevD = i > 0 && st[i - 1].f === st[i].f - 1 ? st[i - 1].d : null, nextD = i + 1 < st.length && st[i + 1].f === st[i].f + 1 ? st[i + 1].d : null;
    // only judge a step in the middle of a motion: both neighbours move (a start or a stop is not a stutter)
    if (prevD == null || nextD == null || Math.abs(prevD) < minPx || Math.abs(nextD) < minPx) continue;
    const trend = (prevD + nextD) / 2;
    const tol = Math.max(minPx, 0.5 * Math.abs(med));
    if (Math.abs(prevD - nextD) > tol) continue;   // the neighbours disagree: a change of speed, not a stutter
    if (Math.abs(st[i].d - med) > tol && Math.abs(st[i].d - trend) > tol) out.push({ f: st[i].f, d: r3(st[i].d), expected: r3(trend) });
  }
  return out;
}

const still = (pts, i, eps, n = 3) => {
  for (let k = 0; k < n; k++) {
    const a = pts[i + k], b = pts[i + k + 1];
    if (!a || !b || b.f !== a.f + 1 || Math.abs(b.v - a.v) > eps) return false;
  }
  return true;
};

/**
 * A jump from a height series (every frame). `press` = the input frame (or null: the first movement is the
 * takeoff). `up` = +1 when up is +y, -1 when up is -y, null to take the takeoff direction. Optional `xs` for the
 * horizontal distance. Landing = the first frame after the apex from which the height holds still for 3 frames.
 * Frames: takeoff = first frame off the ground; airtime counts the steps from the last frame on the ground to the
 * first frame back on it.
 */
export function analyzeJump(ys, { press = null, up = null, xs = null, eps = 0.01, fps = 60 } = {}) {
  const p = numeric(ys);
  if (p.length < 3) return { ok: false, reason: "not enough samples" };
  const startI = press == null ? 0 : Math.max(0, p.findIndex((q) => q.f >= press));
  if (startI < 0 || startI >= p.length) return { ok: false, reason: "the press is after the last sample" };
  const base = p[startI].v;
  let ti = -1;
  for (let i = startI + 1; i < p.length; i++) if (Math.abs(p[i].v - base) > eps) { ti = i; break; }
  if (ti < 0) return { ok: false, reason: `the value never left ${r3(base)} after frame ${p[startI].f}` };
  const dir = up != null ? Math.sign(up) : Math.sign(p[ti].v - base);
  if (up != null && Math.sign(p[ti].v - base) !== dir) return { ok: false, reason: `it moved ${p[ti].v > base ? "+" : "-"} first, but --up says up is ${dir > 0 ? "+" : "-"}: not a jump` };
  const h = (i) => (p[i].v - p[ti - 1].v) * dir;
  // apex: the highest point before the landing
  let ai = ti, li = -1;
  for (let i = ti; i < p.length; i++) {
    if (h(i) > h(ai) + EPS) ai = i;
    if (i > ai && still(p, i, eps)) { li = i; break; }
  }
  // the apex may be a plateau: count its frames
  let plateau = 1;
  for (let i = ai + 1; i < p.length && Math.abs(h(i) - h(ai)) <= EPS; i++) plateau++;
  const apexH = h(ai);
  const g = [], gRise = [], gFall = [];
  const lastAir = li < 0 ? p.length - 1 : li - 1;
  for (let i = ti; i + 1 <= lastAir; i++) {
    if (p[i + 1].f !== p[i].f + 1 || p[i - 1].f !== p[i].f - 1) continue;
    const acc = -(p[i + 1].v - 2 * p[i].v + p[i - 1].v) * dir;   // positive = pulling down
    g.push(acc);
    (i < ai ? gRise : gFall).push(acc);
  }
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const hang = (() => { let n = 0; for (let i = ti; i <= lastAir; i++) if (h(i) >= 0.9 * apexH - EPS) n++; return n; })();
  const pressF = press == null ? p[ti - 1].f : press;
  const ground = p[ti - 1].f;
  const out = {
    ok: true, up: dir, upAuto: up == null, press: pressF, base: r3(p[ti - 1].v),
    takeoff: { f: p[ti].f, after: p[ti].f - pressF }, takeoffSpeed: r3((p[ti].v - p[ti - 1].v) * dir),
    apex: { f: p[ai].f, after: p[ai].f - pressF, height: r3(apexH), holds: plateau, value: r3(p[ai].v) },
    hang: { frames: hang },
    landed: li < 0 ? null : { f: p[li].f, after: p[li].f - pressF, height: r3(h(li)) },
    airtime: li < 0 ? null : { frames: p[li].f - ground, seconds: r3((p[li].f - ground) / fps) },
    rise: { frames: p[ai].f - ground }, fall: li < 0 ? null : { frames: p[li].f - p[ai].f },
    gravity: { mean: r3(mean(g)), rise: r3(mean(gRise)), fall: r3(mean(gFall)), perSecond2: r3(mean(g) * fps * fps) },
  };
  if (xs) {
    const xm = new Map(numeric(xs).map((q) => [q.f, q.v]));
    const x0 = xm.get(ground), x1 = xm.get(li < 0 ? p[p.length - 1].f : p[li].f);
    out.distance = x0 != null && x1 != null ? r3(x1 - x0) : null;
  }
  return out;
}

/**
 * Ground movement from a position series (every frame), with the press and release frames of the move input.
 * Speed = per-frame step. Top speed, when it is first reached (within 1%), and after the release: when it stops
 * (holds still 3 frames), how far it slides, and whether it overshoots (moves back).
 */
export function analyzeMove(xs, { press = null, release = null, eps = 0.001, fps = 60 } = {}) {
  const p = numeric(xs);
  const st = steps(p);
  if (!st.length) return { ok: false, reason: "not enough samples" };
  const pressF = press ?? p[0].f;
  const during = st.filter((s) => s.f > pressF && (release == null || s.f <= release));
  const moving = during.filter((s) => Math.abs(s.d) > eps);
  if (!moving.length) return { ok: false, reason: `it didn't move after frame ${pressF}` };
  const dir = Math.sign(moving.reduce((s, x) => s + x.d, 0)) || 1;
  const peak = Math.max(...during.map((s) => s.d * dir));
  const reached = during.find((s) => s.d * dir >= peak * 0.99 - EPS);
  // the top speed is the plateau's mean (positions rounded by the game make single steps wobble)
  const plateau = during.filter((s) => s.d * dir >= peak * 0.99 - EPS);
  const top = plateau.reduce((a, s) => a + s.d * dir, 0) / plateau.length;
  const firstMove = moving[0];
  const out = {
    ok: true, dir, press: pressF, release,
    firstMove: { f: firstMove.f, after: firstMove.f - pressF },
    top: { perFrame: r3(top), perSecond: r3(top * fps), peak: r3(peak), f: reached.f, after: reached.f - pressF, accelFrames: reached.f - firstMove.f + 1 },
  };
  if (release != null) {
    const xAt = new Map(p.map((q) => [q.f, q.v]));
    const iRel = p.findIndex((q) => q.f >= release);
    let stopI = -1;
    for (let i = Math.max(1, iRel); i < p.length; i++) if (still(p, i, eps)) { stopI = i; break; }
    const x0 = xAt.get(release);
    if (stopI < 0) out.stop = null;
    else {
      const seg = p.slice(iRel, stopI + 1);
      let far = 0;
      for (const q of seg) far = Math.max(far, (q.v - x0) * dir);
      const back = far - (p[stopI].v - x0) * dir;
      out.stop = { f: p[stopI].f, after: p[stopI].f - release, slide: r3((p[stopI].v - x0) * dir), overshoot: r3(back > eps ? back : 0) };
    }
  }
  return out;
}
