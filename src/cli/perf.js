// Witness CLI: measure perf — what each simulated frame costs, from the adapter's 'perf' reply and wall timing.
// Timing is NOT deterministic (CPU load, JIT warm-up, GC), unlike everything else Witness measures: the report says
// so, and spikes are re-checked against the deterministic state (what changed in that frame) in a second pass.
import { performance } from "node:perf_hooks";
import { begin, stepTo } from "../core/runner.js";
import { diffStates } from "../core/compare.js";
import { frameStats, findSpikes, linearTrend, memoryOf, entityCounts } from "../core/perf.js";
import { die, withGame, runOpts, printLogs, framesOf, fmtT, envelope, emit } from "./common.js";

const MAX_FRAMES = 36000;
const r3 = (x) => (x == null ? x : Math.round(x * 1000) / 1000);
export const fmtMs = (x) => (x == null ? "-" : x >= 100 ? `${Math.round(x)}` : x >= 10 ? x.toFixed(1) : x >= 1 ? x.toFixed(2) : x.toFixed(3));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Which per-frame field of the perf replies to report: update_ms, else frame_ms (null if neither ever varies). */
export function gameSeries(replies) {
  for (const key of ["update_ms", "frame_ms"]) {
    const vals = replies.map((p) => num(p && p[key]));
    if (vals.some((v) => v != null)) return { key, values: vals, constant: new Set(vals.filter((v) => v != null)).size <= 1 };
  }
  return null;
}

/** Summarise what changed in the step that simulated frame f: entities added/removed by type, then new changes. */
export function describeChange(before, at, after) {
  const d = diffStates(at ? at.state : null, after ? after.state : null);
  const usual = new Set(diffStates(before ? before.state : null, at ? at.state : null).map((x) => x.path));
  const byType = {};
  const other = [];
  for (const x of d) {
    const m = /^state\.entities\[([^\]#]*)#[^\]]*\]$/.exec(x.path);
    if (m && (x.kind === "added" || x.kind === "removed")) { const k = m[1] || "?"; byType[k] = (byType[k] || 0) + (x.kind === "added" ? 1 : -1); continue; }
    if (/^state\.entities\[/.test(x.path)) continue;   // per-entity field changes: too many to list, usually motion
    if (!usual.has(x.path)) other.push(x);
  }
  const ents = Object.entries(byType).filter(([, n]) => n).map(([t, n]) => `${n > 0 ? "+" : ""}${n} ${t}`);
  const short = (v) => { const s = v === undefined ? "(none)" : JSON.stringify(v); return s.length > 40 ? `${s.slice(0, 37)}…` : s; };
  const paths = other.slice(0, 4).map((x) => (x.kind === "changed" ? `${x.path} ${short(x.a)} → ${short(x.b)}` : `${x.path} ${x.kind}`));
  return { entities: byType, changes: other.slice(0, 12).map(({ path, kind, a, b }) => ({ path, kind, a, b })), text: [...ents, ...paths, other.length > 4 ? `+${other.length - 4} more paths` : ""].filter(Boolean).join(", ") };
}

export async function perfMeasure(opt) {
  let env, text;
  await withGame(opt, async (s, cfg) => {
    const fps = s.fps;
    const f0 = framesOf(opt.from !== undefined && opt.from !== true ? String(opt.from) : opt.at !== undefined && opt.at !== true ? String(opt.at) : "0", fps);
    const n = framesOf(opt.time && opt.time !== true ? String(opt.time) : "3", fps);
    if (n < 2) die("measure perf needs at least 2 frames (--time)");
    if (n > MAX_FRAMES) die(`--time is at most ${MAX_FRAMES} frames (10 minutes at 60 fps)`);
    const f1 = f0 + n;
    const hasPerf = s.has("perf");
    const factor = opt.spike && opt.spike !== true ? +opt.spike : 2;
    const minMs = opt["spike-ms"] && opt["spike-ms"] !== true ? +opt["spike-ms"] : 2;
    const warmup = opt.warmup !== undefined && opt.warmup !== true ? Math.max(0, Math.round(+opt.warmup)) : 5;
    const budget = 1000 / fps;
    const sampleEvery = Math.max(1, Math.round(fps / 2));   // entity counts twice a second (outside the timed step)
    const useState = !opt["no-state"];
    // ---- pass 1: time every step on its own; perf after each; entity counts now and then
    const frames = [], wall = [], replies = [], countT = [], countSnaps = [];
    let st = await begin(s, runOpts(opt, cfg));
    await stepTo(s, st, f0);
    for (let f = f0; f < f1; f++) {
      const t0 = performance.now();
      await stepTo(s, st, f + 1);
      wall.push(performance.now() - t0);
      frames.push(f);
      replies.push(hasPerf ? await s.request("perf").catch(() => null) : null);
      if (useState && ((f + 1 - f0) % sampleEvery === 0 || f + 1 === f1)) { countT.push((f + 1) / fps); countSnaps.push(entityCounts((await s.snapshot()).state)); }
    }
    const logs1 = await s.drainLogs();
    const game = hasPerf ? gameSeries(replies) : null;
    const gameUsable = game && !game.constant;
    const gStats = gameUsable ? frameStats(game.values, frames, { budget }) : null;
    const wStats = frameStats(wall, frames, { budget });
    const primary = gameUsable ? "game" : "wall";
    const pVals = gameUsable ? game.values : wall;
    const spikes = findSpikes(pVals, frames, { factor, minMs, warmup });
    // the other clock at each spike frame, for comparison
    for (const sp of spikes) { sp.wall = wall[sp.i]; if (gameUsable) sp.game = game.values[sp.i]; }
    // perf counts: per key, first → last, peak, and the change at each spike
    const countKeys = [...new Set(replies.flatMap((p) => (p && p.counts && typeof p.counts === "object" ? Object.keys(p.counts) : [])))];
    const perfCounts = {};
    for (const k of countKeys) {
      const v = replies.map((p) => num(p && p.counts && p.counts[k]));
      let pk = 0; v.forEach((x, i) => { if (x != null && (v[pk] == null || x > v[pk])) pk = i; });
      perfCounts[k] = { first: v.find((x) => x != null), last: [...v].reverse().find((x) => x != null), peak: v[pk], peakFrame: frames[pk] + 1, trend: linearTrend(frames.map((f) => (f + 1) / fps), v) };
    }
    for (const sp of spikes) {
      const d = [];
      for (const k of countKeys) {
        const a = sp.i > 0 ? num(replies[sp.i - 1] && replies[sp.i - 1].counts && replies[sp.i - 1].counts[k]) : null;
        const b = num(replies[sp.i] && replies[sp.i].counts && replies[sp.i].counts[k]);
        if (a != null && b != null && a !== b) d.push(`counts.${k} ${a} → ${b}`);
      }
      sp.counts = d;
    }
    // memory
    const memS = replies.map((p) => memoryOf(p));
    const memKey = (memS.find(Boolean) || {}).key || null;
    const memV = memS.map((m) => (m ? m.mb : null));
    const memTrend = memKey ? linearTrend(frames.map((f) => (f + 1) / fps), memV) : null;
    // entity counts from the state
    const types = [...new Set(countSnaps.flatMap((c) => Object.keys(c)))];
    const entTrends = Object.fromEntries(types.map((t) => [t, linearTrend(countT, countSnaps.map((c) => c[t] || 0))]));
    // ---- pass 2: the state around each spike (the run is deterministic, the timing isn't)
    const shown = spikes.filter((x) => !x.warmup).sort((a, b) => b.ms - a.ms).slice(0, 8).sort((a, b) => a.frame - b.frame);
    let stateNote = "";
    if (useState && shown.length && s.has("reset")) {
      const want = [...new Set(shown.flatMap((x) => [x.frame - 1, x.frame, x.frame + 1]).filter((f) => f >= 0))].sort((a, b) => a - b);
      const snaps = new Map();
      st = await begin(s, runOpts(opt, cfg));
      for (const f of want) { await stepTo(s, st, f); snaps.set(f, await s.snapshot()); }
      await s.drainLogs();
      for (const sp of shown) sp.change = describeChange(snaps.get(sp.frame - 1), snaps.get(sp.frame), snaps.get(sp.frame + 1));
    } else if (useState && shown.length) stateNote = "no 'reset': the state at spikes isn't re-checked";
    // trend of the frame cost itself: first fifth vs last fifth
    const q = Math.max(1, Math.floor(pVals.length / 5));
    const meanOf = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const early = meanOf(pVals.slice(warmup, warmup + q)), late = meanOf(pVals.slice(-q));
    const slower = early != null && late != null && late > 1.5 * early && late - early >= 0.5;
    const memGrowing = memTrend && memTrend.r2 > 0.8 && memTrend.last - memTrend.first >= 1;
    const S = gStats || wStats;
    const realSpikes = spikes.filter((x) => !x.warmup);
    // ---- report
    const lines = [];
    lines.push(`perf f${f0}..f${f1 - 1} (${frames.length} frames at ${fps} fps) from ${gameUsable ? `the game's perf ${game.key}` : hasPerf ? "wall time (the game's perf values don't vary per frame)" : "wall time (no 'perf' capability)"}`);
    const line = (label, x) => `  ${label}: p50 ${fmtMs(x.p50)} ms · p95 ${fmtMs(x.p95)} · max ${fmtMs(x.max)} at f${x.maxFrame} · mean ${fmtMs(x.mean)}${x.overBudget ? ` · ${x.overBudget} frame${x.overBudget === 1 ? "" : "s"} over the ${fmtMs(budget)} ms budget` : " · all within the frame budget"}`;
    if (gStats) lines.push(line(`game ${game.key}`, gStats));
    lines.push(line("wall per step (incl. the protocol round trip)", wStats));
    if (hasPerf && game && game.constant) lines.push(`  ⚠ perf ${game.key} is ${game.values.find((v) => v != null)} on every frame: the adapter may not time single steps`);
    if (spikes.length) {
      lines.push(`  ${realSpikes.length} spike${realSpikes.length === 1 ? "" : "s"} (over ${factor}× the median ${fmtMs(S.p50)} ms and +${minMs} ms)${spikes.length > realSpikes.length ? `, ${spikes.length - realSpikes.length} in the first ${warmup} frames (warm-up, not counted)` : ""}:`);
      for (const sp of [...shown, ...spikes.filter((x) => x.warmup).slice(0, 3)].sort((a, b) => a.frame - b.frame)) {
        const clocks = gameUsable ? `${fmtMs(sp.game)} ms game / ${fmtMs(sp.wall)} ms wall` : `${fmtMs(sp.wall)} ms`;
        const what = [sp.change && sp.change.text, ...(sp.counts || [])].filter(Boolean).join("; ");
        lines.push(`    f${sp.frame}  ${clocks}${sp.warmup ? " (warm-up)" : ""}${what ? ` · changed: ${what}` : sp.change ? " · no state change beyond the usual" : ""}`);
      }
      if (realSpikes.length > shown.length) lines.push(`    … ${realSpikes.length - shown.length} more (--json)`);
    } else lines.push(`  no spikes (nothing over ${factor}× the median and +${minMs} ms)`);
    if (slower) lines.push(`  ⚠ frames get slower over the run: mean ${fmtMs(early)} ms in the first fifth → ${fmtMs(late)} ms in the last`);
    if (memKey) lines.push(`  memory (${memKey}): ${fmtMs(memTrend.first)} → ${fmtMs(memTrend.last)} MB over ${fmtT(frames.length / fps)}${memTrend ? ` (${memTrend.slope >= 0 ? "+" : ""}${fmtMs(memTrend.slope)} MB/s, r² ${memTrend.r2.toFixed(2)})` : ""}${memGrowing ? " ⚠ grows steadily: a leak?" : ""}`);
    else if (hasPerf) lines.push("  memory: not reported (a game can add memory_mb to its perf reply)");
    const cl = Object.entries(perfCounts).map(([k, c]) => `${k} ${c.first} → ${c.last}${c.peak !== c.last && c.peak !== c.first ? ` (peak ${c.peak} at f${c.peakFrame})` : ""}`);
    if (cl.length) lines.push(`  perf counts: ${cl.join(" · ")}`);
    const grow = Object.entries(entTrends).filter(([, t]) => t && t.r2 > 0.8 && t.last - t.first >= 5);
    if (grow.length) lines.push(`  ⚠ entities keep piling up: ${grow.map(([t, x]) => `${t} ${x.first} → ${x.last}`).join(", ")} (despawn?)`);
    if (stateNote) lines.push(`  (${stateNote})`);
    lines.push("  timing is not deterministic: numbers vary between runs and machines (re-run before trusting a small change); in witness mode this is CPU cost per simulated frame, not display pacing, vsync or GPU time");
    env = envelope("measure perf", {
      ok: true,
      verdict: `${gameUsable ? `game ${game.key}` : "wall"} p50 ${fmtMs(S.p50)} ms, p95 ${fmtMs(S.p95)}, max ${fmtMs(S.max)} at f${S.maxFrame}; ${realSpikes.length} spike${realSpikes.length === 1 ? "" : "s"}${memGrowing ? "; memory grows" : ""}`,
      summary: {
        source: primary, key: gameUsable ? game.key : "wall", frames: frames.length,
        p50: r3(S.p50), p95: r3(S.p95), p99: r3(S.p99), max: r3(S.max), maxFrame: S.maxFrame, mean: r3(S.mean), overBudget: S.overBudget, budget: r3(budget),
        spikes: realSpikes.length, spikeFrames: realSpikes.map((x) => x.frame),
        wallP50: r3(wStats.p50), wallP95: r3(wStats.p95), wallMax: r3(wStats.max), wallMaxFrame: wStats.maxFrame,
        memoryStartMB: memTrend ? r3(memTrend.first) : null, memoryEndMB: memTrend ? r3(memTrend.last) : null, memoryGrowthMBps: memTrend ? r3(memTrend.slope) : null, memoryGrows: !!memGrowing,
        slowsDown: slower, deterministic: false,
      },
      data: {
        fps, from: f0, to: f1 - 1, frames, wall: wall.map(r3), game: gameUsable ? game.values.map(r3) : null, gameKey: game ? game.key : null,
        game_stats: gStats, wall_stats: wStats,
        spikes: spikes.map((x) => ({ frame: x.frame, ms: r3(x.ms), ratio: r3(x.ratio), warmup: x.warmup, wall: r3(x.wall), game: r3(x.game), counts: x.counts, change: x.change ? { entities: x.change.entities, changes: x.change.changes } : undefined })),
        memory: memKey ? { key: memKey, mb: memV.map(r3), trend: memTrend } : null,
        counts: perfCounts, entities: { t: countT, counts: countSnaps, trends: entTrends },
        settings: { factor, minMs, warmup },
      },
    });
    text = lines.join("\n");
    printLogs(logs1);
  });
  emit(env, text, opt);
}
