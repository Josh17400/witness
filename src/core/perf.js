// Witness core: frame-time statistics for `witness measure perf` (pure functions, unit-tested on known inputs).

/** Nearest-rank percentile of an ascending array: the smallest value with at least p of the samples at or below it. */
export function rankPercentile(sorted, p) {
  if (!sorted.length) return null;
  const k = Math.max(1, Math.ceil(Math.min(1, Math.max(0, p)) * sorted.length));
  return sorted[k - 1];
}

/**
 * Distribution of per-frame times (ms). frames[i] is the frame values[i] was measured on.
 * Returns { n, p50, p95, p99, max, maxFrame, min, mean, overBudget, budget } (null when there are no values).
 */
export function frameStats(values, frames, { budget = null } = {}) {
  const xs = [], fs = [];
  values.forEach((v, i) => { if (typeof v === "number" && Number.isFinite(v)) { xs.push(v); fs.push(frames[i]); } });
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  let mi = 0;
  xs.forEach((v, i) => { if (v > xs[mi]) mi = i; });
  return {
    n: xs.length, p50: rankPercentile(s, 0.5), p95: rankPercentile(s, 0.95), p99: rankPercentile(s, 0.99), max: xs[mi], maxFrame: fs[mi],
    min: s[0], mean: xs.reduce((a, b) => a + b, 0) / xs.length,
    budget, overBudget: budget ? xs.filter((v) => v > budget).length : null,
  };
}

/**
 * Frames whose time is over `factor` × the median AND at least `minMs` above it. Spikes inside the first `warmup`
 * frames of the run are marked warmup (a JIT or cache warming, not the game's cost).
 * Returns [{ i, frame, ms, ratio, warmup }].
 */
export function findSpikes(values, frames, { factor = 2, minMs = 2, warmup = 0, median = null } = {}) {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return [];
  const med = median ?? rankPercentile(xs, 0.5);
  const out = [];
  values.forEach((v, i) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return;
    if (v > factor * med && v - med >= minMs) out.push({ i, frame: frames[i], ms: v, ratio: med > 0 ? v / med : null, warmup: i < warmup });
  });
  return out;
}

/**
 * Least-squares line through (t, y): slope per unit t, r² and the first/last values. Used for memory growth
 * (MB per second) and steadily rising counts. Returns null with fewer than 3 points.
 */
export function linearTrend(ts, ys) {
  const pts = ts.map((t, i) => [t, ys[i]]).filter(([t, y]) => Number.isFinite(t) && Number.isFinite(y));
  if (pts.length < 3) return null;
  const n = pts.length, mt = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [t, y] of pts) { sxy += (t - mt) * (y - my); sxx += (t - mt) ** 2; syy += (y - my) ** 2; }
  const slope = sxx ? sxy / sxx : 0;
  const r2 = sxx && syy ? (sxy * sxy) / (sxx * syy) : syy ? 0 : 1;
  return { slope, r2, first: pts[0][1], last: pts[n - 1][1], min: Math.min(...pts.map((p) => p[1])), max: Math.max(...pts.map((p) => p[1])) };
}

/** Memory in MB from a perf reply: memory_mb / heap_mb / rss_mb, or the same in bytes (memory_bytes, ...). */
export function memoryOf(perf) {
  if (!perf || typeof perf !== "object") return null;
  for (const k of ["memory_mb", "mem_mb", "heap_mb", "rss_mb"]) if (typeof perf[k] === "number" && Number.isFinite(perf[k])) return { mb: perf[k], key: k };
  for (const k of ["memory_bytes", "heap_bytes", "rss_bytes"]) if (typeof perf[k] === "number" && Number.isFinite(perf[k])) return { mb: perf[k] / 1048576, key: k };
  return null;
}

/** Entity counts by type (state.entities), the cheap "how many things exist" view of a snapshot. */
export function entityCounts(state) {
  const out = {};
  const ents = state && Array.isArray(state.entities) ? state.entities : [];
  for (const e of ents) { const t = (e && (e.type ?? e.kind)) ?? "?"; out[t] = (out[t] || 0) + 1; }
  return out;
}
