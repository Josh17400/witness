// Witness core tests: `node tests/run.mjs` (unit tests + end-to-end CLI runs against the mock game).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluate, check, splitComparison, keyPaths, rewriteTemporal, usesPrev, TimeContext, statePaths } from "../src/core/expr.js";
import { frameStats, findSpikes, linearTrend, memoryOf, entityCounts, rankPercentile } from "../src/core/perf.js";
import { gameSeries } from "../src/cli/perf.js";
import { analyzeAnim } from "../src/core/anim.js";
import { everyFrames } from "../src/cli/see.js";
import { decodeAPNG } from "../src/media/apng.js";
import { decodePNG } from "../src/media/png.js";
import { describeState } from "../src/core/schema.js";
import { diffStates } from "../src/core/compare.js";
import { analyzeJump, analyzeMove, frozenSpans, response, lag, stutters, summarize } from "../src/core/signal.js";
import { matchSounds, alignSoundEvents, soundFrame } from "../src/core/soundmatch.js";
import { windowsOf } from "../src/cli/window.js";
import { parseVariant, compareRect } from "../src/cli/ab.js";
import { figureRegions } from "../src/cli/measure-look.js";
import { compareSeries, posOf, autoDeathExpr, mapOf, tickPoints, respawnFrames, deathAt } from "../src/cli/trace.js";
import { parseWitnessInput } from "../src/core/input-spec.js";
import { loadReplay, frameAt } from "../src/core/runner.js";
import { detect, listAdapters } from "../src/core/init.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL", name, extra); } };
const snap = { frame: 60, time: 1, state: { score: 2, player: { pos: [10, 20], hp: 3 }, entities: [{ id: 1, type: "Player", pos: [10, 20] }, { id: 2, type: "Coin", pos: [13, 24] }, { id: 3, type: "Coin", pos: [100, 100] }] } };

// ---- expressions
ok("expr path", evaluate("state.player.hp", snap) === 3);
ok("expr count", evaluate("count('Coin')", snap) === 2);
ok("expr near", evaluate("near(state.player.pos, 'Coin').id", snap) === 2);
ok("expr dist", evaluate("dist(state.player, first('Coin'))", snap) === 5);
ok("expr approx", evaluate("approx(time, 1)", snap) === true);
ok("check pass", check("state.score == 2", snap).ok);
ok("check fail shows both sides", check("state.score == 3", snap).detail === "got 2 == 3");
ok("split ignores strings", splitComparison("first('a==b') != null").op === "!=");
ok("split >=", splitComparison("state.score >= 2").op === ">=");
ok("missing path message", (() => { try { evaluate("state.nope.x", snap); return false; } catch (e) { return /missing/.test(e.message); } })());
ok("keyPaths", keyPaths(snap.state).some((k) => k.startsWith("state.player.hp")));

// ---- time helpers: prev, rose, fell, changed, since
{
  const s0 = { frame: 0, state: { g: false, n: 1, p: [0, 0] } }, s1 = { frame: 1, state: { g: true, n: 1, p: [2, 0] } };
  ok("rose: false → true", evaluate("rose(state.g)", s1, s0) === true && evaluate("rose(state.g)", s0, s1) === false);
  ok("fell: true → false", evaluate("fell(state.g)", s0, s1) === true && evaluate("fell(state.g)", s1, s0) === false);
  ok("changed: vectors compared by value", evaluate("changed(state.p)", s1, s0) === true && evaluate("changed(state.n)", s1, s0) === false);
  ok("rose without prev is false", evaluate("rose(state.g)", s1, null) === false);
  ok("prev: per-frame velocity", evaluate("state.p[0] - prev.p[0]", s1, s0) === 2);
  ok("prev null: a clear message", (() => { try { evaluate("state.p[0] - prev.p[0]", s1, null); return false; } catch (e) { return /prev is null here/.test(e.message); } })());
  ok("rewrite skips strings and members", (() => { const r = rewriteTemporal("rose(a) && x.rose(1) && 'rose(b)' == changed(f(\"c)\"))"); return r.args.join("|") === 'a|f("c)")' && r.code.includes("x.rose(1)") && r.code.includes("'rose(b)'"); })());
  ok("usesPrev", usesPrev("prev.x") && usesPrev("rose(a)") && usesPrev("since(a) > 2") && !usesPrev("state.prevent") && !usesPrev("a.rose"));
  const seq = [false, true, true, false, true, true, true], ctx = new TimeContext();
  const since = seq.map((g, i) => evaluate("since(state.g)", { frame: i, state: { g } }, i ? { frame: i - 1, state: { g: seq[i - 1] } } : null, ctx));
  ok("since: frames since it last became true", JSON.stringify(since) === "[null,0,1,2,0,1,2]", since);
  const ctx2 = new TimeContext(), late = [true, true, true].map((g, i) => evaluate("since(state.g)", { frame: 40 + i, state: { g } }, { frame: 39 + i, state: { g: true } }, ctx2));
  ok("since: already true on the first sampled frame counts from there", JSON.stringify(late) === "[0,1,2]", late);
  ok("since needs a run context", (() => { try { evaluate("since(state.g)", s1, s0); return false; } catch (e) { return /every-frame sampling/.test(e.message); } })());
  ok("check: a && / || expression is judged whole", check("frame == 0 || state.p[0] - prev.p[0] == 2", s1, s0).ok && check("frame == 0 || state.p[0] - prev.p[0] == 2", s0, null).ok);
  ok("check: failing detail shows both sides", check("state.n == 3", s1).detail === "got 1 == 3");
}

// ---- doctor's WebGL lines (browser pages): what the engine has vs what the game's canvas asked for
{
  const { webglReport } = await import("../src/cli/web.js");
  const sw = { available: true, version: "WebGL 2.0", renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)", maxTexture: 8192 };
  const web = (g, engine = "chromium") => ({ engine, webgl: async () => g });
  const page = (context) => ({ canvases: [{ id: "game", w: 160, h: 90, rect: [0, 0, 320, 180], context }] });
  const a = await webglReport(web({ webgl: sw, webgl2: sw }), page("webgl2 (failed)"));
  ok("webglReport: a canvas whose WebGL request returned null is ✖", a.lines[0][0] === "✖" && /the game asked for webgl2 and got none/.test(a.lines[0][1]) && a.summary.canvasContext === "webgl2 (failed)", a.lines);
  const b = await webglReport(web({ webgl: { available: false }, webgl2: { available: false } }, "webkit"), page(null));
  ok("webglReport: no WebGL at all is ⚠ (a WebGL build would be blank)", b.lines[0][0] === "⚠" && /no WebGL in this engine \(webkit\)/.test(b.lines[0][1]) && b.summary.webgl === false, b.lines);
  const c = await webglReport(web({ webgl: sw, webgl2: sw }), page("webgl2"));
  ok("webglReport: SwiftShader is named software", c.lines[0][0] === "✔" && c.summary.software === true && /software: slower/.test(c.lines[0][1]), c.lines);
}

// ---- doctor's pixels-on-screen line: a crisp integer-scaled canvas the game draws two scales into isn't "blurry"
{
  const { displayReport } = await import("../src/cli/web.js");
  const media = await import("../src/media/index.js");
  const hash = (x, y, s) => { let n = Math.imul(x + 1, 374761393) ^ Math.imul(y + 7, 668265263) ^ Math.imul(s + 3, 2246822519); n = Math.imul(n ^ (n >>> 13), 1274126177); return (n ^ (n >>> 16)) >>> 0; };
  const P = [[20, 24, 46], [230, 57, 70], [241, 250, 238], [168, 218, 220], [69, 123, 157], [255, 183, 3]], Q = [[250, 250, 250], [40, 40, 60], [200, 160, 40], [90, 200, 120]];
  // a 1000×600 capture: world at ×k, rows y ≥ 473 a UI at ×f (both from the origin); blur: a 3×3 box blur over it
  const pic = (k, f, blur = false, split = 473) => {
    const W = 1000, H = 600, d = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = y >= split ? Q[hash(Math.floor(x / f), Math.floor(y / f), 5) % 4] : P[hash(Math.floor(x / k), Math.floor(y / k), 2) % 6]; d.set([...c, 255], (y * W + x) * 4); }
    if (!blur) return media.encodePNG(W, H, d);
    const o = Uint8Array.from(d);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) for (let ch = 0; ch < 3; ch++) { let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += d[((y + dy) * W + x + dx) * 4 + ch]; o[(y * W + x) * 4 + ch] = Math.round(s / 9); }
    return media.encodePNG(W, H, o);
  };
  // canvas cw×ch shown at 500×300 CSS px, DPR 2, pixelated: exactly ×(1000 / cw)
  const doc = async (cw, ch, png) => (await displayReport({ engine: "chromium", device: null, info: async () => ({ viewport: [800, 600], dpr: 2, canvases: [{ id: "game", w: cw, h: ch, rect: [0, 0, 500, 300], imageRendering: "pixelated" }] }), capture: async () => ({ png }) }, media));
  const line = (r) => r.lines.find((l) => /^pixels on screen/.test(l[1])) || [];
  const a = await doc(250, 150, pic(4, 4.11));
  ok("doctor: ×4 canvas, ×4 world + ×4.11 UI: 2 scales, not blurry; the layout's ×4 is the ×4 region's", line(a)[0] === "⚠" && /2 scales in one picture: ×4 \(whole, 78\.8% of the picture\) · ×4\.11 \(fractional, 21\.2%\)/.test(line(a)[1]) && a.lines.some((l) => /the layout's ×4 is the ×4 region's; the ×4\.11 region is drawn by the game at a scale of its own/.test(l[1])) && !a.display.pixels.blurry && a.display.pixels.mixed && a.display.pixels.layoutRegion === 0, a.lines);
  const b = await doc(500, 300, pic(2, 4.11));
  ok("doctor: ×2 canvas, ×2 world + ×4.11 UI: 2 scales (was blurry, 6.39% of 2×2 cells mixed)", /2 scales in one picture: ×2 .* · ×4\.11 /.test(line(b)[1]) && !b.display.pixels.blurry && b.display.pixels.layoutRegion === 0, b.lines);
  const c = await doc(250, 150, pic(5, 4.11));
  ok("doctor: ×4 canvas, ×5 world + ×4.11 UI: neither region is the layout's (×4.11 isn't ×4)", /2 scales in one picture/.test(line(c)[1]) && c.lines.some((l) => /the layout shows the canvas at ×4: inside it the game draws ×5 = ×1\.25 of its canvas pixels, ×4\.11 = ×1\.028/.test(l[1])) && c.display.pixels.agrees === false, c.lines);
  const e = await doc(250, 150, pic(4, 4, false, 472));
  ok("doctor: one clean ×4 grid is still exact", line(e)[0] === "✔" && /exact ×4/.test(line(e)[1]), e.lines);
  const f = await doc(250, 150, pic(4, 4, true, 472));
  ok("doctor: a blurred ×4 picture is still blurry", line(f)[0] === "⚠" && /blurry/.test(line(f)[1]) && f.display.pixels.blurry, f.lines);
}

// ---- printed follow-up commands: the same config and the same launch overrides
{
  const { configFlag } = await import("../src/cli/common.js");
  ok("configFlag: --config plus the launch overrides that were passed", configFlag({ config: "zzp/witness.web.json", "safe-insets": true }) === " --config zzp/witness.web.json --safe-insets" && configFlag({ device: "iphone-15", engine: "webkit", capture: "element", "no-auto-unlock": true }) === " --device iphone-15 --engine webkit --capture element --no-auto-unlock" && configFlag({ config: "my dir/w.json" }) === ' --config "my dir/w.json"' && configFlag({}) === "", configFlag({ config: "zzp/witness.web.json", "safe-insets": true }));
  const { hint } = await import("../src/core/expr.js");
  hint.flags = " --config w.web.json";
  let msg = "";
  try { evaluate("state.nope.x", snap); } catch (e) { msg = e.message; }
  hint.flags = "";
  ok("expression errors name 'witness eval --keys' with the same config", /witness eval --keys --config w\.web\.json/.test(msg), msg);
}

// ---- chart v2 helpers: comparing two runs, positions, conventions
{
  const c = compareSeries([0, 1, 2, 3], [1, 2, 3, 4], [1, 2, 5, 3]);
  ok("compareSeries: first differing frame, deltas, largest gap", c.differ === 2 && c.first.f === 2 && c.first.a === 3 && c.first.b === 5 && c.delta.end === -1 && c.delta.max === 1 && c.maxGap.f === 2 && c.maxGap.d === 2 && c.a.maxFrame === 3 && c.b.maxFrame === 2, c);
  ok("compareSeries: identical", compareSeries([0, 1], [1, 1], [1, 1]).differ === 0 && compareSeries([0, 1], [1, 1], [1, 1]).maxGap === null);
  const t = compareSeries([0, 1, 2], ["idle", "run", "run"], ["idle", "idle", "run"]);
  ok("compareSeries: strings compared by value, no numeric deltas", t.differ === 1 && t.first.f === 1 && t.first.a === "run" && !t.delta, t);
  ok("posOf: arrays, {x, y}, things with pos", posOf([1, 2]).join() === "1,2" && posOf({ x: 3, y: 4 }).join() === "3,4" && posOf({ pos: [5, 6, 7] }).join() === "5,6" && posOf([1]) === null && posOf("1,2") === null && posOf({ x: 1 }) === null);
  ok("autoDeathExpr: state.dead, then state.player.dead", autoDeathExpr({ dead: false }) === "state.dead" && autoDeathExpr({ player: { dead: false } }) === "state.player.dead" && autoDeathExpr({ dead: 0 }) === null && autoDeathExpr(null) === null);
  ok("mapOf: rows + cell + origin, defaults cell 1", mapOf({ map: { rows: ["#.#"], origin: [8, 4] } }).cell === 1 && mapOf({ map: { rows: ["#.#"], cell: 16 } }).origin.join() === "0,0" && mapOf({ map: { rows: [1, 2] } }) === null);
  // xy helpers: time dots on samples that don't land on the tick, respawns, deaths while the position is null
  const pts7 = Array.from({ length: 30 }, (_, i) => [i, 0, i * 7]);   // every 7 frames up to f203
  ok("tickPoints: --every 7f still gets a dot per 60f tick (first sample at/after it)", tickPoints(pts7, 60).map((q) => q[2]).join() === "63,126,182", tickPoints(pts7, 60).map((q) => q[2]));
  ok("tickPoints: never the end point", tickPoints([[0, 0, 0], [1, 0, 60]], 60).length === 0);
  const pv = [[0, 0], [1, 0], null, null, [0, 0], [1, 0]], dv = [false, false, true, true, false, false], fr = [0, 1, 2, 3, 4, 5];
  ok("respawnFrames: the first alive position after a dead sample", respawnFrames(fr, pv, dv).join() === "4" && respawnFrames(fr, [[0, 0], [1, 0], [2, 0], [2, 0], [0, 0], [1, 0]], dv).join() === "4" && respawnFrames(fr, pv, null).length === 0);
  const da = deathAt(fr, pv, { f: 2, t: 2 / 60 });
  ok("deathAt: null position at the death frame → the last one seen before it", da.pos.join() === "1,0" && da.seenAt === 1 && deathAt(fr, [null, null, null, null, null, null], { f: 2, t: 0 }).pos === null);
  ok("parseVariant: replay= is its own key, not an env var", (() => { const v = parseVariant("replay=b.jsonl; seed=2", "compare"); return v.replay === "b.jsonl" && v.seed === 2 && !Object.keys(v.env).length; })());
}

// ---- snapshot paths filter: the top-level keys expressions read
{
  const sp = (...e) => JSON.stringify(statePaths(e));
  ok("statePaths: state.x.y and prev.x → top-level keys", sp("state.player.pos[0] - prev.player.pos[0]", "state.score") === '["player","score"]');
  ok("statePaths: entity helpers need entities", sp("count('Coin') + all('Wolf').length") === '["entities"]' && sp("first(\"Boss\")?.hp") === '["entities"]');
  ok("statePaths: bracket literals, optional chaining, strings ignored", sp('state["my key"].x', "state?.cam.pos", "'state.fake' == state.mode") === '["cam","mode","my key"]', sp('state["my key"].x', "state?.cam.pos", "'state.fake' == state.mode"));
  ok("statePaths: bare state, computed keys, snap → no filter", statePaths(["Object.keys(state).length"]) === null && statePaths(["state[k]"]) === null && statePaths(["snap.state.x"]) === null && statePaths(["frame > 3"]) === null);
}

// ---- perf statistics on known inputs
{
  const v = [1, 1, 1, 1, 25, 1, 1, 1, 1, 1], f = v.map((_, i) => 100 + i);
  const st = frameStats(v, f, { budget: 1000 / 60 });
  ok("frameStats: nearest-rank p50/p95, max with its frame, over budget", st.p50 === 1 && st.p95 === 25 && st.max === 25 && st.maxFrame === 104 && st.mean === 3.4 && st.overBudget === 1, st);
  ok("rankPercentile: 20 values, p95 = the 19th", rankPercentile(Array.from({ length: 20 }, (_, i) => i + 1), 0.95) === 19 && rankPercentile([5], 0.5) === 5 && rankPercentile([], 0.5) === null);
  const sp = findSpikes(v, f, { factor: 2, minMs: 2, warmup: 0 });
  ok("findSpikes: the one frame over 2× median and +2 ms", sp.length === 1 && sp[0].frame === 104 && sp[0].ratio === 25);
  ok("findSpikes: small absolute jumps are not spikes (+2 ms floor)", findSpikes([0.05, 0.05, 0.3, 0.05], [0, 1, 2, 3]).length === 0);
  ok("findSpikes: early frames are marked warm-up", findSpikes([30, 1, 1, 1], [0, 1, 2, 3], { warmup: 2 })[0].warmup === true);
  const tr = linearTrend([1, 2, 3, 4], [40, 43, 46, 49]);
  ok("linearTrend: exact slope and r² 1", tr.slope === 3 && tr.r2 === 1 && tr.first === 40 && tr.last === 49, tr);
  ok("linearTrend: flat line, slope 0", linearTrend([0, 1, 2], [5, 5, 5]).slope === 0);
  ok("memoryOf: MB keys and bytes", memoryOf({ memory_mb: 12 }).mb === 12 && memoryOf({ heap_bytes: 1048576 * 3 }).mb === 3 && memoryOf({ frame_ms: 1 }) === null);
  ok("entityCounts: by type", JSON.stringify(entityCounts({ entities: [{ type: "A" }, { type: "A" }, { kind: "B" }] })) === '{"A":2,"B":1}');
  ok("gameSeries: update_ms first, constant flagged", gameSeries([{ update_ms: 1, frame_ms: 2 }, { update_ms: 3 }]).key === "update_ms" && gameSeries([{ frame_ms: 0.01 }, { frame_ms: 0.01 }]).constant === true && gameSeries([null, {}]) === null);
}

// ---- animation timing from a pose sequence
{
  // the mock's planted cycle: 4 poses × 6f, the 7th hold (pose 2) lasts 12f
  const holds = [6, 6, 6, 6, 6, 6, 12, 6, 6, 6, 6, 6, 6, 6, 6, 6, 3];
  const labels = holds.flatMap((n, k) => Array(n).fill(k % 4)), frames = labels.map((_, i) => i);
  const a = analyzeAnim(labels, frames);
  ok("analyzeAnim: 4 poses, 6f per pose, loop 4 poses = 24f", a.poses === 4 && a.framesPerPose === 6 && a.period === 4 && a.loopFrames === 24 && a.confidence === "sure", a);
  ok("analyzeAnim: the doubled hold is flagged with its frame", a.irregular.length === 1 && a.irregular[0].label === 2 && a.irregular[0].start === 36 && a.irregular[0].len === 12 && a.irregular[0].usual === 6, a.irregular);
  ok("analyzeAnim: the loop with it took 30f", a.loops.filter((l) => l.frames !== 24).map((l) => `${l.start}:${l.frames}`).join() === "30:30", a.loops);
  const skip = [0, 1, 2, 3, 0, 1, 2, 3, 0, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3].flatMap((p) => Array(4).fill(p));
  const b = analyzeAnim(skip, skip.map((_, i) => i));
  ok("analyzeAnim: a skipped pose breaks the order (pose 2 where 1 was due)", b.period === 4 && b.breaks.length >= 1 && b.breaks[0].start === 36 && b.breaks[0].label === 2 && b.breaks[0].expected === 1, b.breaks);
  const pp = [0, 1, 2, 1, 0, 1, 2, 1, 0, 1, 2, 1, 0].flatMap((p) => Array(5).fill(p));
  const c = analyzeAnim(pp, pp.map((_, i) => i));
  ok("analyzeAnim: ping-pong cycle 0 1 2 1 = 4 poses, 20f", c.period === 4 && c.loopFrames === 20 && c.poses === 3, c);
  const gap = [0, 0, 0, 0, 1, 1, null, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0];
  const g = analyzeAnim(gap, gap.map((_, i) => i));
  ok("analyzeAnim: an unknown frame inside a hold is bridged", g.irregular.length === 0 && g.framesPerPose === 4 && g.runs[1].len === 5, g.runs);
  ok("analyzeAnim: one pose = not animated", analyzeAnim([3, 3, 3], [0, 1, 2]).animated === false);
  ok("everyFrames: 1/30 s at 60 fps = 2 frames; 3f; default 1", everyFrames("1/30", 60) === 2 && everyFrames("3f", 60) === 3 && everyFrames(undefined, 60) === 1);
}

// ---- times: seconds or frames
ok("frameAt '90f' is 90 frames", frameAt("90f", 60) === 90 && frameAt("1.5", 60) === 90 && frameAt(1.5, 60) === 90 && frameAt("1.5s", 60) === 90);
ok("bad time: a clear error", (() => { try { frameAt("soon", 60); return false; } catch (e) { return /use seconds \(1\.5\) or frames \(90f\)/.test(e.message); } })());
{
  const fe = parseWitnessInput("space@60f, right@0-120f, touch:1,1@30f, action:jump@10f-20f, d@0.5-90f", 60);
  const at = (pred) => fe.filter(pred).map((e) => e.frame).join(",");
  ok("input: frame times (tap lasts 0.1 s)", at((e) => e.key === "space") === "60,66", at((e) => e.key === "space"));
  ok("input: frame hold", at((e) => e.key === "right") === "0,120");
  ok("input: touch at a frame", at((e) => e.type === "touch") === "30,31");
  ok("input: action frame range", at((e) => e.type === "action") === "10,20");
  ok("input: seconds and frames mixed", at((e) => e.key === "d") === "30,90");
  ok("input: 30 fps frames", parseWitnessInput("space@15f", 30)[0].frame === 15);
}

// ---- state schema (eval --keys)
{
  const st = { score: 0, player: { id: 1, type: "Player", pos: [40, 90], hp: 3 }, map: { rows: Array(18).fill("##############....#") }, xs: Array.from({ length: 20 }, (_, i) => i),
    entities: [{ id: 1, type: "Player", pos: [40, 90], hp: 3 }, ...[0, 1, 2, 3, 4].map((i) => ({ id: 10 + i, type: "Coin", pos: [80 + i * 40, 60] })), { id: 30, type: "Wolf", state: "idle", hp: 3 }, { id: 31, type: "Wolf", state: "chase", hp: 2, telegraph: 0.5 }] };
  const later = JSON.parse(JSON.stringify(st)); later.player.pos = [88, 90]; later.entities[0].pos = [88, 90];
  const L = describeState(later, st);
  const has = (re) => L.some((l) => re.test(l));
  ok("keys: primitive vector inline", has(/^~state\.player\.pos = \[88,90\]$/), L.join("\n"));
  ok("keys: unchanged path not marked", has(/^ state\.player\.hp = 3$/));
  ok("keys: long arrays elided", has(/state\.map\.rows  \[18 × "/) && has(/state\.xs  \[20 numbers, 0\.\.19\]/));
  ok("keys: entities grouped by type with counts", has(/state\.entities  \[8\]: Player ×1, Coin ×5, Wolf ×2/));
  ok("keys: type-union fields, optional marked ?", has(/Wolf ×2: id ∈ 30\.\.31, state ∈ \{idle, chase\}, hp ∈ 2\.\.3, telegraph\? = 0\.5/), L.join("\n"));
  ok("keys: only the changed group is live", has(/^~   Player ×1: id = 1, pos = \[88,90\], hp = 3/) && has(/^    Coin ×5: id ∈ 10\.\.14, pos \[2\]/));
  ok("keys: helper hint names the biggest type", has(/count\('Coin'\)/));
}

// ---- state diff (eval --diff): entities matched by id
{
  const a = { score: 0, entities: [{ id: 1, type: "Player", pos: [0, 0] }, { id: 10, type: "Coin", pos: [5, 5] }, { id: 11, type: "Coin", pos: [9, 9] }] };
  const b = { score: 1, entities: [{ id: 1, type: "Player", pos: [6, 0] }, { id: 11, type: "Coin", pos: [9, 9] }, { id: 12, type: "Key", pos: [1, 1] }] };
  const d = diffStates(a, b);
  const p = d.map((x) => `${x.kind} ${x.path}`);
  ok("diff: by id (removed, added, changed; no shifted-index noise)", p.join(" | ") === "changed state.score | removed state.entities[Coin#10] | added state.entities[Key#12] | changed state.entities[Player#1].pos", p.join(" | "));
}

// ---- signal facts (measure curve/jump/move/hitstop, trace tables)
{
  const pts = (vals, f0 = 0) => vals.map((v, i) => ({ f: f0 + i, v }));
  // ballistic jump, explicit Euler: vy0 = -7 px/f, g = 0.4 px/f², pressed at f10, ground y = 90
  const ys = [];
  let y = 90, vy = 0, air = false;
  for (let f = 0; f <= 80; f++) {
    ys.push({ f, v: y });
    if (f === 10) { vy = -7; air = true; }
    if (air) { y += vy; vy += 0.4; if (y >= 90 - 1e-9) { y = 90; vy = 0; air = false; } }
  }
  const j = analyzeJump(ys, { press: 10, fps: 60 });
  ok("jump: takeoff +1f, apex 64.8 px at +18f", j.ok && j.takeoff.after === 1 && j.apex.height === 64.8 && j.apex.after === 18 && j.apex.holds === 1, j);
  ok("jump: airtime 36f, rise 18 / fall 18, lands +36f", j.airtime.frames === 36 && j.rise.frames === 18 && j.fall.frames === 18 && j.landed.after === 36, j);
  ok("jump: hang 11f within 10% of the apex", j.hang.frames === 11, j.hang);
  ok("jump: gravity 0.4 px/f² both ways, takeoff speed 7", j.gravity.rise === 0.4 && j.gravity.fall === 0.4 && j.takeoffSpeed === 7 && j.up === -1, j.gravity);
  ok("jump: --up contradicting the motion is refused", analyzeJump(ys, { press: 10, up: 1 }).ok === false);
  // ground move: accelerate 0.5 px/f per frame to 3 px/f, brake 1 px/f per frame; held f10..f40
  const xs = [];
  let x = 0, v = 0;
  for (let f = 0; f <= 70; f++) { xs.push({ f, v: x }); if (f >= 10 && f < 40) v = Math.min(3, v + 0.5); else v = Math.max(0, v - 1); x += v; }
  const mv = analyzeMove(xs, { press: 10, release: 40, fps: 60 });
  ok("move: top 3 px/f = 180 px/s reached +6f, first move +1f", mv.ok && mv.top.perFrame === 3 && mv.top.perSecond === 180 && mv.top.after === 6 && mv.firstMove.after === 1 && mv.top.accelFrames === 6, mv);
  ok("move: stops +2f after release, slides 3 px, no overshoot", mv.stop && mv.stop.after === 2 && mv.stop.slide === 3 && mv.stop.overshoot === 0, mv.stop);
  // frozen spans: a pause between motion (hitstop) vs never started / never resumed
  const fr = frozenSpans([pts([0, 0, 0, 1, 2, 3, 3, 3, 3, 3, 4, 5, 5, 5])]);
  ok("frozen: bounded pause f6..f9 (4f), start and end spans unbounded", fr.length === 3 && fr[1].from === 6 && fr[1].to === 9 && fr[1].frames === 4 && fr[1].bounded && !fr[0].bounded && !fr[2].bounded && fr[2].resumed === false, fr);
  ok("frozen: all series must hold", frozenSpans([pts([0, 1, 1, 1, 2]), pts([0, 0, 1, 2, 3])]).every((s) => !s.bounded));
  // response: 0 → 100 with an overshoot to 110
  const rs = response(pts([0, 0, 20, 50, 80, 100, 110, 104, 100, 100, 100]));
  ok("response: rise 10–90% f2..f5, overshoot 10 (10%), settles f8", rs.rise.from === 2 && rs.rise.to === 5 && rs.rise.frames === 3 && rs.overshoot.value === 10 && rs.overshoot.percent === 10 && rs.settle.f === 8, rs);
  // lag: b is a delayed exactly 9 frames
  const base = Array.from({ length: 120 }, (_, i) => Math.sin(i / 7) * 50 + (i > 40 ? i : 0));
  const a = pts(base), b = pts(base.map((_, i) => (i >= 9 ? base[i - 9] : base[0])));
  ok("lag: a known 9-frame delay", lag(b, a).lag === 9 && lag(a, b).lag === -9, [lag(b, a), lag(a, b)]);
  // stutter: steady 2 px/f with one repeated frame is flagged; a smooth ramp, a start and a stop are not
  const steady = [0, 2, 4, 6, 8, 8, 10, 12, 14, 16, 18];
  const stt = stutters(pts(steady));
  ok("stutter: the repeated frame (f5) is flagged", stt.length === 1 && stt[0].f === 5 && stt[0].d === 0, stt);
  ok("stutter: smooth ramp, start and stop are not", stutters(pts([0, 0, 0, 0.5, 1.5, 3, 5, 7.5, 10.5, 13.5, 16.5, 18.5, 19.5, 19.5, 19.5])).length === 0);
  const sm = summarize(pts([5, 7, 9, 4]));
  ok("summarize: start/end/min/max with frames, per-frame step range", sm.start.v === 5 && sm.end.v === 4 && sm.min.f === 3 && sm.max.f === 2 && sm.step.min.d === -5 && sm.step.max.d === 2 && sm.step.min.f === 3, sm);
  ok("summarize: steps only between consecutive frames", summarize([{ f: 0, v: 0 }, { f: 3, v: 9 }]).step === null);
}

// ---- window: contiguous passing values
{
  const res = [1, 2, 3, 5, 6, 9].map((v) => ({ v, step: 1, ok: true })).concat([4, 7, 8].map((v) => ({ v, step: 1, ok: false }))).sort((a, b) => a.v - b.v);
  const w = windowsOf(res);
  ok("windowsOf: contiguous runs with their sizes", JSON.stringify(w) === JSON.stringify([{ from: 1, to: 3, frames: 3 }, { from: 5, to: 6, frames: 2 }, { from: 9, to: 9, frames: 1 }]), w);
  ok("windowsOf: a step of 2 frames", JSON.stringify(windowsOf([0, 2, 4].map((v) => ({ v, step: 2, ok: true })))) === JSON.stringify([{ from: 0, to: 4, frames: 3 }]));
}

// ---- ab: variants and rect comparison
{
  const v = parseVariant('LIFT=1; params={"rig":2}; scene=boss; seed=3; input=j@1; cmd=node g.mjs', "a");
  ok("ab variant: env, params, scene, seed, input, cmd", v.env.LIFT === "1" && v.params.rig === 2 && v.scene === "boss" && v.seed === 3 && v.input === "j@1" && v.cmd === "node g.mjs");
  ok("ab variant: plain env pairs separated by spaces", (() => { const w = parseVariant("A=1 B=2", "a"); return w.env.A === "1" && w.env.B === "2"; })());
  const mk = (c) => ({ width: 4, height: 2, data: Uint8Array.from({ length: 32 }, (_, i) => (i % 4 === 3 ? 255 : c)) });
  const a = mk(0), b = mk(0);
  for (const i of [0, 1]) { b.data[i * 4] = 255; b.data[i * 4 + 1] = 255; b.data[i * 4 + 2] = 255; }
  const c = compareRect(a, b, { x: 0, y: 0, w: 4, h: 2 });
  ok("ab rect: 2 of 8 px white: 25%, luma +63.75 overall, +255 on the changed, bbox x0..1", c.changed === 2 && c.percent === 25 && c.lumaDelta === 63.75 && c.lumaDeltaChanged === 255 && c.bbox.w === 2 && c.bbox.h === 1, c);
}

// ---- sound ↔ event matching (listen)
{
  const fps = 60;
  ok("soundFrame: a sound starting at frame 60's time is heard in frame 61", soundFrame(1, fps) === 61 && soundFrame(1 - 0.4 / 22050, fps) === 61 && soundFrame(1.016, fps) === 61);
  const sounds = [{ label: "swing", f: 61, t: 1 }, { label: "swing", f: 151, t: 2.5 }, { label: "land", f: 216, t: 3.583 }, { label: "hit", f: 300, t: 4.98 }, { label: "hit", f: 301, t: 5 }, { label: "ding", f: 400, t: 6.65 }];
  const actions = [{ label: "j pressed", f: 60, kind: "input" }, { label: "j pressed", f: 120, kind: "input" }, { label: "j pressed", f: 150, kind: "input" }, { label: "land", f: 216, kind: "state" }, { label: "hurt", f: 300, kind: "state" }, { label: "swung", f: 61, kind: "state" }];
  const r = matchSounds(actions, sounds, { within: 6 });
  const byF = (l, f) => r.matches.find((m) => m.action.label === l && m.action.f === f);
  ok("match: press → sound +1f", byF("j pressed", 60).sound.label === "swing" && byF("j pressed", 60).offset === 1);
  ok("match: an eaten press has no sound, and says what the last one played", byF("j pressed", 120).sound === null && byF("j pressed", 120).before.sound.label === "swing");
  ok("match: state event → its sound at +0f", byF("land", 216).offset === 0 && byF("land", 216).sound.label === "land");
  ok("match: the same sound twice in 2 frames is a double trigger", byF("hurt", 300).doubles.length === 1 && byF("hurt", 300).doubles[0].offset === 1);
  ok("match: different events may share a sound", byF("swung", 61).sound === sounds[0] && byF("swung", 61).offset === 0);
  ok("match: unexplained sounds", r.unexplained.length === 1 && r.unexplained[0].label === "ding");
  const early = matchSounds([{ label: "x pressed", f: 100, kind: "input" }], [{ label: "boom", f: 99, t: 1.63 }]);
  ok("match: a sound before its event is reported as early", early.matches[0].sound === null && early.matches[0].early.offset === -1);
  const al = alignSoundEvents([{ name: "swing", frame: 60 }, { name: "ghost", frame: 200 }], [{ t: 1 + 1 / 60 }, { t: 5 }], fps);
  ok("align: announced sound heard at the nearest onset (1f late here)", al.sounds[0].heard && al.sounds[0].f === 62 && al.lag === 1, al);
  ok("align: announced but silent, and an onset nobody announced", al.sounds[1].heard === false && al.unreported.length === 1 && Math.abs(al.unreported[0].t - 5) < 1e-9, al);
  // quest_start (f66) has the onset at 1.1 s; a swing announced 2 frames later must not take it
  const ov = alignSoundEvents([{ name: "quest_start", frame: 66 }, { name: "swing", frame: 68 }], [{ t: 1.1 }], fps);
  ok("align: an onset belongs to one sound: a later swing doesn't snap back onto quest_start's", ov.sounds[0].heard && !ov.sounds[1].heard && ov.sounds[1].near.label === "quest_start" && ov.sounds[1].near.ms === 33, ov.sounds);
  const ov2 = alignSoundEvents([{ name: "quest_start", frame: 66 }, { name: "swing", frame: 68 }], [{ t: 68 / 60 }], fps);
  ok("align: an onset at or after an event beats one before it (quest_start's onset unheard, the swing keeps its own)", !ov2.sounds[0].heard && ov2.sounds[1].heard && ov2.sounds[1].f === 69, ov2.sounds);
  const tg = alignSoundEvents([{ name: "quest_start", frame: 66 }, { name: "swing", frame: 66 }], [{ t: 1.1 }], fps);
  ok("align: sounds started in the same frame share an onset, marked together", tg.sounds.every((x) => x.heard) && tg.sounds[1].together[0] === "quest_start" && tg.sounds[0].together[0] === "swing", tg.sounds);
  const z = matchSounds([{ label: "j pressed", f: 67, kind: "input" }], [{ label: "quest_start", f: 67, t: 1.1 }]);
  ok("match: an input's sound can't be at +0f (that sound started before the press could be heard)", z.matches[0].sound === null && z.matches[0].early.offset === 0, z.matches[0]);
}

// ---- measure figure: which diff regions are the figure
{
  // a 600×400 region (240,000 px) that doesn't touch the point: picked without spreading its pixels (no stack overflow)
  const W = 800, big = { px: Array.from({ length: 600 * 400 }, (_, k) => (100 + Math.floor(k / 600)) * W + 150 + (k % 600)), x: 150, y: 100, w: 600, h: 400 };
  const small = { px: [5 * W + 5], x: 5, y: 5, w: 1, h: 1 };
  let fr = null, err = null;
  try { fr = figureRegions([small, big], [], { sx: 120, sy: 300, trusted: true }); } catch (e) { err = e.message; }
  ok("figureRegions: a 240k-px region is chosen as the nearest without a stack overflow", fr && fr.kept[0] === big && fr.how === "nearest" && fr.unplaced, err || fr);
  const fr2 = figureRegions([small, big], [], { sx: 6, sy: 6, trusted: false });
  ok("figureRegions: an assumed (screen = state) point on nothing keeps the largest region, not the nearest", fr2.kept[0] === big && fr2.how === "largest", fr2.how);
}

// ---- input spec
const ev = parseWitnessInput("right@0-1, space@0.5, click:10,20@2, action:jump@1, pad:a@1-1.5, text:hi@3, 1@0.1, 2@0.4", 60);
ok("input key hold", ev.some((e) => e.type === "key" && e.key === "right" && e.down && e.frame === 0) && ev.some((e) => e.key === "right" && !e.down && e.frame === 60));
ok("input click", ev.some((e) => e.type === "mouse" && e.x === 10 && e.y === 20 && e.down === true && e.frame === 120));
ok("input action", ev.some((e) => e.type === "action" && e.action === "jump" && e.down && e.frame === 60));
ok("input pad", ev.some((e) => e.type === "pad" && e.button === "a" && !e.down && e.frame === 90));
ok("input text", ev.some((e) => e.type === "text" && e.text === "hi" && e.frame === 180));
ok("input digits after commas", ev.some((e) => e.key === "1") && ev.some((e) => e.key === "2"));
ok("input sorted", ev.every((e, i) => i === 0 || ev[i - 1].frame <= e.frame));
ok("input bad item throws", (() => { try { parseWitnessInput("rite@@1", 60); return false; } catch { return true; } })());
const throwsLike = (spec, re) => { try { parseWitnessInput(spec, 60); return false; } catch (e) { return re.test(e.message); } };
const tv = parseWitnessInput("touch:100,50@1, touch:10,20@2-2.5, touch2:30,40@1, right@0.5, swipe3:5,5->6,6@3-3.1", 60);
const phases = (f) => tv.filter((e) => e.type === "touch" && f(e)).map((e) => `${e.phase}@${e.frame}`).join(" ");
ok("input touch tap (up one frame later)", phases((e) => e.id === 0 && e.x === 100 && e.y === 50) === "down@60 up@61", phases((e) => e.x === 100));
ok("input touch hold", phases((e) => e.id === 0 && e.x === 10 && e.y === 20) === "down@120 up@150");
ok("input touchN is finger N-1", phases((e) => e.id === 1) === "down@60 up@61" && tv.filter((e) => e.id === 1).every((e) => e.x === 30 && e.y === 40));
ok("input swipeN finger id", tv.filter((e) => e.type === "touch" && e.id === 2).length === 2 + 6);
ok("input touch mixes with keys", tv.some((e) => e.type === "key" && e.key === "right" && e.frame === 30) && tv.every((e, i) => i === 0 || tv[i - 1].frame <= e.frame));
const sw = parseWitnessInput("swipe:0,0->60,30@0-1", 60), moves = sw.filter((e) => e.phase === "move");
ok("input swipe down/moves/up", sw[0].phase === "down" && sw[0].frame === 0 && sw[0].x === 0 && sw.at(-1).phase === "up" && sw.at(-1).frame === 60 && sw.at(-1).x === 60 && sw.at(-1).y === 30 && sw.every((e) => e.type === "touch" && e.id === 0));
ok("input swipe moves every frame, interpolated", moves.length === 60 && moves.every((e, i) => e.frame === i + 1 && Math.abs(e.x - (i + 1)) < 1e-9 && Math.abs(e.y - (i + 1) / 2) < 1e-9));
ok("input swipe last move lands before the up", sw.at(-2).phase === "move" && sw.at(-2).x === 60 && sw.at(-2).frame === 60);
ok("input touch needs a position", throwsLike("touch@1", /needs a position/));
ok("input swipe needs a range", throwsLike("swipe:0,0->1,1@1", /time range/));
ok("input touch0 is rejected", throwsLike("touch0:1,1@1", /numbered from 1/));
ok("input touch hold must end after start", throwsLike("touch:1,1@2-1", /end after/));

// ---- replays
const rp = loadReplay(path.join(here, "mock", "session.jsonl"));
ok("replay duration", Math.abs(rp.duration - (61 / 60 + (0.02 - 1 / 60))) < 0.001, rp.duration);   // frames 0..60, one 0.02 s frame
ok("replay marks", rp.marks.length === 1 && rp.marks[0].frame === 20 && Math.abs(rp.marks[0].t - 20 / 60) < 0.01);
ok("replay events", rp.events.length === 2 && rp.events[1].frame === 40);
ok("frameAt with dts", frameAt(rp.marks[0].t, 60, rp.dts) === 20);

// ---- init detection (temp projects)
const adapters = listAdapters(root);
if (adapters.length) {
  const mk = (files) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "witness-det-")); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); } return d; };
  const expectPick = (files, id) => {
    const d = mk(files);
    const r = detect(d, adapters);
    fs.rmSync(d, { recursive: true, force: true });
    if (!adapters.find((a) => a.id === id)) return;           // adapter not bundled (yet)
    ok(`detect ${id}`, r[0] && r[0].adapter.id === id, r.map((x) => `${x.adapter.id}:${x.score}`).join(" "));
  };
  expectPick({ "Cargo.toml": "[package]\nname='g'", "src/main.rs": "fn main(){}" }, "rust");
  expectPick({ "CMakeLists.txt": "project(g)\nfind_package(SDL3)", "src/main.cpp": "int main(){}" }, "cpp");
  expectPick({ "project.godot": "[application]", "main.gd": "extends Node" }, "godot");
  expectPick({ "main.py": "import pygame", "requirements.txt": "pygame" }, "python");
  expectPick({ "main.lua": "function love.load() end", "conf.lua": "function love.conf(t) end" }, "lua");
  expectPick({ "go.mod": "module g", "main.go": "package main" }, "go");
  expectPick({ "package.json": "{\"dependencies\":{\"phaser\":\"3\"}}", "index.html": "<canvas>" }, "js");
  expectPick({ "Assets/Scripts/Player.cs": "using UnityEngine;", "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 2022.3" }, "unity");
}

// ---- end-to-end against the mock game
// e2e runs work in a scratch folder, so generated files (witness/shots/...) never land in the repo
const work = fs.mkdtempSync(path.join(os.tmpdir(), "witness-work-"));
// the machine-wide heavy-process budget (src/core/budget.js) gets its own folder for the mock-game block only: these
// runs are sequential, one light node process at a time, and other agents' launches must not make them wait. It is
// dropped again before the sub-suites (headless browsers, playtests), which must count against the real budget.
const ownBudget = !process.env.WITNESS_BUDGET_DIR;
if (ownBudget) process.env.WITNESS_BUDGET_DIR = path.join(work, "budget");
const cli = (args, env = {}) => spawnSync(process.execPath, [path.join(root, "bin", "witness.js"), ...args, "--cmd", `"${process.execPath}" "${path.join(here, "mock-game.mjs")}"`], { encoding: "utf8", timeout: 120000, cwd: work, env: { ...process.env, ...env } });
let r = cli(["doctor"]);
ok("e2e doctor all good", r.status === 0 && /all good/.test(r.stdout), r.stdout + r.stderr);
ok("e2e doctor deterministic", /deterministic/.test(r.stdout));
r = cli(["test", path.join(root, "examples", "coins.witness.json")]);
ok("e2e shared coins test passes on the mock", r.status === 0 && /5 passed, 0 failed/.test(r.stdout), r.stdout + r.stderr);
r = cli(["test", path.join(here, "mock", "coins.witness.json")]);
ok("e2e failing test fails with both sides", r.status === 1 && /got 0 == 99/.test(r.stdout), r.stdout);
r = cli(["test", path.join(here, "mock", "prev.witness.json")]);
ok("e2e prev is the previous step's snapshot", r.status === 0 && /1 passed, 0 failed/.test(r.stdout), r.stdout + r.stderr);
r = cli(["eval", "--at", "0.6", "--input", "right@0-0.5", "state.score", "--json"]);
ok("e2e eval json", r.status === 0 && JSON.parse(r.stdout).data.rows[0].values["state.score"] === 1 && JSON.parse(r.stdout).command === "eval", r.stdout + r.stderr);
r = cli(["call", "teleport", "50", "60"]);
ok("e2e call", r.status === 0 && /\[50,60\]/.test(r.stdout), r.stdout + r.stderr);
r = cli(["replay", path.join(here, "mock", "session.jsonl"), "--watch", "state.player.pos[0]"]);
ok("e2e replay", r.status === 0 && /pos\[0\] = 120\.4/.test(r.stdout), r.stdout + r.stderr);
// touch: finger 0 drives the mock's pointer like the mouse (drag-to-move), other fingers are counted
r = cli(["eval", "--at", "0.6", "--input", "swipe:40,90->100,90@0-0.5", "state.player.pos[0]", "state.score", "state.pointer.down", "--json"]);
ok("e2e swipe drags the player", r.status === 0 && (() => { const v = JSON.parse(r.stdout).data.rows[0].values; return Math.abs(v["state.player.pos[0]"] - 100) < 1e-6 && v["state.score"] === 1 && v["state.pointer.down"] === false; })(), r.stdout + r.stderr);
r = cli(["eval", "--at", "0.3,0.6", "--input", "touch:10,10@0-1, touch2:20,20@0.2-0.5", "state.touches", "--json"]);
ok("e2e multi-touch fingers", r.status === 0 && (() => { const j = JSON.parse(r.stdout).data.rows; return j[0].values["state.touches"] === 2 && j[1].values["state.touches"] === 1; })(), r.stdout + r.stderr);
r = cli(["replay", path.join(here, "mock", "touch-session.jsonl"), "--watch", "state.player.pos[0], state.player.pos[1], state.touches"]);
ok("e2e replay with touch events", r.status === 0 && /pos\[0\] = 100\b/.test(r.stdout) && /pos\[1\] = 60\b/.test(r.stdout) && /state\.touches = 0/.test(r.stdout), r.stdout + r.stderr);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "witness-e2e-"));
if (fs.existsSync(path.join(root, "src", "media", "index.js"))) {
  r = cli(["shot", "--at", "0.5", "--out", path.join(tmp, "s.png")]);
  ok("e2e shot writes a png", r.status === 0 && fs.existsSync(path.join(tmp, "s.png")) && fs.readFileSync(path.join(tmp, "s.png")).slice(1, 4).toString() === "PNG", r.stdout + r.stderr);
  r = cli(["trace", "--watch", "state.player.pos[0], state.score", "--time", "1", "--input", "right@0-1", "--out", path.join(tmp, "t.png")]);
  ok("e2e trace chart", r.status === 0 && fs.existsSync(path.join(tmp, "t.png")) && /pos\[0\]: 40 → 160 · min 40 @f0 · max 160 @f60 · per frame 2\.\.2 /.test(r.stdout), r.stdout + r.stderr);
  r = cli(["listen", "--time", "1", "--input", "right@0-0.5", "--out", tmp]);
  ok("e2e listen hears the ding", r.status === 0 && fs.existsSync(path.join(tmp, "timeline.png")), r.stdout + r.stderr);
}

// ---- determinism checks that go beyond the snapshot
if (fs.existsSync(path.join(root, "src", "media", "index.js"))) {
  r = cli(["doctor"], { MOCK_LEAK: "1" });
  ok("e2e doctor catches a leak only the screenshot shows", r.status === 1 && /NOT deterministic/.test(r.stdout) && /screenshot differs: 1 px/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["test", path.join(root, "examples", "coins.witness.json"), "--repeat", "2"]);
  ok("e2e test --repeat 2 identical", r.status === 0 && /all 2 passes were identical/.test(r.stdout) && /10 passed, 0 failed/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["test", path.join(root, "examples", "coins.witness.json"), "--repeat", "2"], { MOCK_LEAK: "1" });
  ok("e2e test --repeat catches the leak", r.status === 1 && /repeat: screenshot differs/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["test", path.join(here, "mock", "match.witness.json")]);
  ok("e2e match labels", r.status === 1 && /2 passed, 1 failed/.test(r.stdout) && /match "start": state differs/.test(r.stdout), r.stdout + r.stderr);
}
// ---- measure (drives the game, screenshots every frame)
if (fs.existsSync(path.join(root, "src", "media", "measure.js"))) {
  r = cli(["measure", "motion", "--at", "0", "--time", "0.1", "--input", "right@0-1", "--json"]);
  try {
    const mo = JSON.parse(r.stdout).data;   // the --json envelope: { ok, command, verdict, summary, data }
    // 7 frames: auto falls back to "first"; frame 0 holds the player, so the mask is old+new position; its leading edge is exact
    ok("e2e measure motion: the player's leading edge moves 2 px a frame", mo.frames.length === 7 && mo.frames.slice(2).every((f, i) => f.lowestRowSpan.x1 - mo.frames[i + 1].lowestRowSpan.x1 === 2), r.stdout.slice(0, 400));
  } catch (e) { ok("e2e measure motion", false, `${e.message}
${r.stdout}${r.stderr}`); }
}
// ---- perception upgrades (docs/PERCEPTION_PLAN.md phase 1), against the mock's planted numbers
const J = (res) => { try { return JSON.parse(res.stdout); } catch { return null; } };
{
  // trace: errors reported once (B1), prev per frame (B2), every frame by default (B9), compact JSON
  r = cli(["trace", "--watch", "state.playr.hp, state.player.pos[0] - prev.player.pos[0], state.player.hpp", "--time", "1", "--input", "right@0-1", "--no-chart"]);
  ok("trace B1: a misspelt path is an error, once, with the sample count", r.status === 0 && /✖ state\.playr\.hp: something before \.hp is missing.*\(all 61 samples\)/.test(r.stdout), r.stdout + r.stderr);
  ok("trace B1: an undefined field is reported too", /✖ state\.player\.hpp: undefined on every sample/.test(r.stdout), r.stdout);
  ok("trace B2: prev is the previous frame (velocity 2 px/f from f1)", /prev\.player\.pos\[0\]: 2 \(constant over f1\.\.f60\)/.test(r.stdout), r.stdout);
  ok("trace B9: every frame by default", /61 samples, f0\.\.f60 \(1s\), every frame/.test(r.stdout), r.stdout);
  r = cli(["trace", "--watch", "state.player.pos[0]", "--time", "0.5", "--every", "3f", "--input", "right@0-1", "--json"]);
  const tj = J(r), series = tj && tj.data.series["state.player.pos[0]"];
  ok("trace --every 3f: frame-aligned samples, [t, value, frame] one per line", series && series.length === 11 && series.every((p, i) => p[2] === i * 3 && p[1] === 40 + 6 * i && Math.abs(p[0] - (i * 3) / 60) < 1e-9) && r.stdout.split("\n").filter((l) => /^\s+\[[\d.]+,/.test(l)).length === 11, r.stdout.slice(0, 300));
  r = cli(["trace", "--watch", "state.player.pos, state.score", "--time", "1", "--input", "right@0-1", "--events", "coin: changed(state.score)", "--out", path.join(work, "tr.png")]);
  ok("trace: vectors per axis, state events listed, chart written", r.status === 0 && /pos\.x: 40 → 160/.test(r.stdout) && /pos\.y: 90 \(constant/.test(r.stdout) && /events: coin @f15, coin @f37, coin @f55/.test(r.stdout) && fs.existsSync(path.join(work, "tr.png")), r.stdout + r.stderr);

  // chart v2: --compare (two runs, one difference), --save/--against (before/after), --xy (path + deaths), --hist,
  // and heatmap (MOCK_HAZARD: lava from x = 150 kills at f55 and f120, respawn after 10 frames)
  r = cli(["trace", "--watch", "state.player.pos, state.score", "--compare", "input=up@0.5-0.7", "--input", "right@0-1", "--time", "1.2", "--out", path.join(work, "cmp.png"), "--json"]);
  ok("trace --compare: B − A per axis, the first frame they differ (up pressed at f30 → f31)", (() => { const j = J(r); return j && j.summary.differs === 2 && j.summary.firstDiffFrame === 31 && j.summary.deltas["state.player.pos.y"].end === -24 && j.summary.deltas["state.player.pos.y"].min === -24 && j.summary.deltas["state.player.pos.x"].end === 0 && j.data.compare.series["state.player.pos.x"].differ === 0 && j.data.compare.series["state.player.pos.y"].first.f === 31 && j.data.seriesB["state.player.pos"].length === 73 && j.summary.a["state.player.pos.x"].max === 160 && fs.existsSync(path.join(work, "cmp.png")); })(), r.stdout.slice(0, 600) + r.stderr);
  r = cli(["trace", "--watch", "state.player.pos[0]", "--compare", "input=up@0.5-0.7", "--input", "right@0-1", "--time", "1.2", "--no-chart"]);
  ok("trace --compare text: identical series say so", r.status === 0 && /compare: A = \(as given\) · B = input=up@0\.5-0\.7/.test(r.stdout) && /state\.player\.pos\[0\]: identical on all 73 samples/.test(r.stdout), r.stdout + r.stderr);
  const base = path.join(work, "base.json");
  r = cli(["trace", "--watch", "state.player.pos[0], state.score", "--input", "right@0-1", "--time", "1.2", "--no-chart", "--save", base]);
  ok("trace --save writes the trace JSON", r.status === 0 && fs.existsSync(base) && JSON.parse(fs.readFileSync(base, "utf8")).data.series["state.player.pos[0]"].length === 73, r.stdout + r.stderr);
  r = cli(["trace", "--watch", "state.player.pos[0], state.score", "--input", "right@0-0.8", "--time", "1.2", "--no-chart", "--against", base]);
  ok("trace --against: before/after deltas (right held 0.8 s instead of 1 s: end −24, first differs at f49)", r.status === 0 && /A = before \(base\.json\) · B = now/.test(r.stdout) && /state\.player\.pos\[0\]: A 40 → 160 \(min 40 @f0, max 160 @f60\) · B 40 → 136 \(min 40 @f0, max 136 @f48\) · B − A: end -24, max -24 · first differs at f49 \(0\.817s\): 138 vs 136/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["trace", "--replay", path.join(here, "mock", "session.jsonl"), "--compare", `replay=${path.join(here, "mock", "touch-session.jsonl")}`, "--watch", "state.player.pos", "--no-chart", "--json"]);
  ok("trace --compare replay=: two recordings, compared over the shorter one", (() => { const j = J(r); return j && j.data.series["state.player.pos"].length === 42 && j.data.compare.b === "replay touch-session.jsonl" && j.data.compare.a === "replay session.jsonl" && j.summary.deltas["state.player.pos.x"].end === -20.4 && j.summary.deltas["state.player.pos.y"].min === -30; })(), r.stdout.slice(0, 600) + r.stderr);
  r = cli(["ab", "--a", "replay=x.jsonl", "--b", "seed=2"]);
  ok("ab rejects replay= (it's for trace --compare)", r.status === 1 && /replay= is for 'witness trace --compare'/.test(r.stderr), r.stderr);
  r = cli(["trace", "--xy", "state.player.pos", "--watch", "state.player.pos[0]", "--hist", "--input", "right@0-3", "--time", "2.5", "--out", path.join(work, "hz.png"), "--json"], { MOCK_HAZARD: "1" });
  ok("trace --xy: the path, deaths found by themselves (state.dead) with their frame and position", (() => { const j = J(r); const x = j && j.data.xy.runs[0]; return x && x.length === 260 && x.jumps.map((q) => q.f).join() === "65,130" && x.start.join() === "40,90" && x.end.join() === "80,90" && x.deaths.map((d) => `${d.f}:${d.pos}`).join(" ") === "55:150,90 120:150,90" && j.summary.xy.deaths === 2 && x.points.length === 151 && x.points[55].join() === "150,90,55" && fs.existsSync(path.join(work, "hz-xy.png")); })(), r.stdout.slice(0, 600) + r.stderr);
  ok("trace --hist: exact stats (mean 96.689, median 94, mode 150..160 with 20 samples)", (() => { const j = J(r); const h = j && j.summary.hist["state.player.pos[0]"]; return h && h.n === 151 && h.mean === 96.689 && h.median === 94 && h.min === 40 && h.max === 150 && h.mode.join() === "150,160" && j.data.hist[0].bins[0].at(-1)[2] === 20 && fs.existsSync(path.join(work, "hz-hist.png")); })(), r.stdout.slice(0, 300));
  r = cli(["trace", "--xy", "state.score", "--time", "0.2", "--no-chart"]);
  ok("trace --xy on a non-position says what it got", r.status === 0 && /✖ xy state\.score: got 0, not a position/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["heatmap", "--input", "right@0-3", "--time", "2.5", "--cell", "10", "--out", path.join(work, "heat.png"), "--json"], { MOCK_HAZARD: "1" });
  ok("heatmap (one scripted run): time per cell and deaths, exact", (() => { const j = J(r); return j && j.summary.samples === 151 && j.summary.seconds === 2.5 && j.summary.cells === 12 && j.summary.deaths === 2 && j.summary.deathCells === 1 && j.summary.hottest.x0 === 150 && j.summary.hottest.y0 === 90 && j.summary.hottest.frames === 20 && j.data.top[1].x0 === 40 && j.data.top[1].frames === 15 && j.data.deaths.map((d) => d.f).join() === "55,120" && fs.existsSync(path.join(work, "heat.png")); })(), r.stdout.slice(0, 600) + r.stderr);
  r = cli(["heatmap", "--input", "right@0-3", "--time", "2.5", "--cell", "10", "--no-chart"], { MOCK_HAZARD: "1" });
  ok("heatmap text: most time and the death cell", r.status === 0 && /151 samples = 2\.5 s of play · cell 10 · 12 cells visited/.test(r.stdout) && /most time: x 150\.\.160, y 90\.\.100: 0\.333 s \(13%\)/.test(r.stdout) && /deaths \(state\.dead\): 2 in 1 cell — x 150\.\.160, y 90\.\.100 ×2 \[f55, f120\]/.test(r.stdout), r.stdout + r.stderr);
  {
    // playtests: every witness/playtests/*/replay.jsonl (t1 dies at f55, t2 lets go of right at f30)
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "witness-heat-"));
    const put = (name, lines) => { fs.mkdirSync(path.join(proj, "witness", "playtests", name), { recursive: true }); fs.writeFileSync(path.join(proj, "witness", "playtests", name, "replay.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n"); };
    put("t1", [{ replay: 1, name: "Mock Coins", seed: 1, fps: 60 }, { f: 0, in: [{ type: "key", key: "right", down: true }] }, { f: 90 }]);
    put("t2", [{ replay: 1, name: "Mock Coins", seed: 1, fps: 60 }, { f: 0, in: [{ type: "key", key: "right", down: true }] }, { f: 30, in: [{ type: "key", key: "right", down: false }] }, { f: 60 }]);
    const h = spawnSync(process.execPath, [path.join(root, "bin", "witness.js"), "heatmap", "playtests", "--cell", "10", "--json", "--cmd", `"${process.execPath}" "${path.join(here, "mock-game.mjs")}"`], { encoding: "utf8", timeout: 120000, cwd: proj, env: { ...process.env, MOCK_HAZARD: "1" } });
    ok("heatmap playtests: every playtest replay, deaths with their run", (() => { const j = J(h); return j && j.summary.runs === 2 && j.data.runs.map((x) => `${x.name}:${x.samples}:${x.deaths}`).join() === "t1:92:1,t2:62:0" && j.summary.samples === 154 && j.summary.deaths === 1 && j.data.deaths[0].run === "t1" && j.data.deaths[0].f === 55; })(), h.stdout.slice(0, 600) + h.stderr);
    fs.rmSync(proj, { recursive: true, force: true });
  }

  // chart v2 regressions (reviewer findings)
  const xyBase = path.join(work, "xy.json");
  r = cli(["trace", "--xy", "state.player.pos", "--input", "right@0-3", "--time", "2.5", "--no-chart", "--save", xyBase], { MOCK_HAZARD: "1" });
  ok("trace --xy --no-chart: still measures the path (260, respawns left out) and saves its points", r.status === 0 && /path 260 \(2 teleports left out: f65, f130\) over 151 samples/.test(r.stdout) && /deaths \(state\.dead\): f55 at \(150, 90\), f120 at \(150, 90\)/.test(r.stdout) && JSON.parse(fs.readFileSync(xyBase, "utf8")).data.xy.runs[0].points.length === 151, r.stdout + r.stderr);
  r = cli(["trace", "--xy", "state.player.pos", "--input", "right@0-2", "--time", "2.5", "--no-chart", "--against", xyBase, "--json"], { MOCK_HAZARD: "1" });
  ok("trace --xy --against a saved path: A has its points, B − A compared per axis", (() => { const j = J(r); return j && j.data.xy.runs[0].length === 260 && j.data.xy.runs[1].length === 220 && j.summary.differs === 1 && j.summary.firstDiffFrame === 131 && j.data.compare.series["state.player.pos.x"].differ > 0; })(), r.stdout.slice(0, 400) + r.stderr);
  const b2 = path.join(work, "b2.json"), n2 = path.join(work, "n2.json");
  cli(["trace", "--watch", "state.player.pos[0]", "--input", "right@0-1", "--time", "1.5", "--no-chart", "--save", b2]);
  r = cli(["trace", "--watch", "state.player.pos[0]", "--input", "right@0-0.8", "--time", "1.5", "--no-chart", "--against", b2, "--save", n2]);
  ok("trace --against --save: the file holds this run (max 136), not the baseline (160)", (() => { const j = JSON.parse(fs.readFileSync(n2, "utf8")); const v = j.data.series["state.player.pos[0]"].map((p) => p[1]); return Math.max(...v) === 136 && v.length === 91 && !j.data.compare && !j.data.seriesB && j.summary["state.player.pos[0]"].max === 136; })(), r.stdout + r.stderr);
  r = cli(["trace", "--xy", "state.player.pos", "--compare", "input=up@0.5-0.7", "--input", "right@0-1", "--time", "1.2", "--no-chart", "--json"]);
  ok("trace --compare with only --xy: the paths are compared (y differs from f31), not 'identical on all 0 series'", (() => { const j = J(r); return j && j.summary.differs === 1 && j.summary.firstDiffFrame === 31 && j.summary.deltas["state.player.pos.y"].end === -24 && /1 of 2 series differ/.test(j.verdict); })(), r.stdout.slice(0, 400) + r.stderr);
  r = cli(["trace", "--xy", "state.dead ? null : state.player.pos", "--deaths", "state.dead", "--input", "right@0-3", "--time", "2.5", "--no-chart"], { MOCK_HAZARD: "1" });
  ok("trace --xy: a position that is null while dead → deaths at the last position seen", r.status === 0 && /f55 at \(148, 90\) \(last seen f54\), f120 at \(148, 90\) \(last seen f119\)/.test(r.stdout) && /path 256 \(2 teleports left out: f65, f130\)/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["heatmap", "--pos", "state.dead ? null : state.player.pos", "--input", "right@0-3", "--time", "2.5", "--cell", "10", "--no-chart"], { MOCK_HAZARD: "1" });
  ok("heatmap: a position that is null while dead → deaths still placed (last seen), dead time not counted", r.status === 0 && /2\.167 s of play/.test(r.stdout) && /deaths \(state\.dead\): 2 in 1 cell — x 140\.\.150, y 90\.\.100 ×2 \[f55, f120\]/.test(r.stdout) && /at: f55 \(148, 90\) last seen f54, f120 \(148, 90\) last seen f119/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["heatmap", "--seeds", "1,2", "--input", "right@0-3", "--time", "2.5", "--cell", "10", "--no-chart"], { MOCK_HAZARD: "1" });
  ok("heatmap: the total time equals the per-run lines (2 × 2.5 s = 5 s)", r.status === 0 && /302 samples = 5 s of play/.test(r.stdout) && /per run: seed 1 2\.5s, 2 deaths · seed 2 2\.5s, 2 deaths/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["heatmap", "--time", "1", "--no-chart", "--json"]);
  ok("heatmap: an idle player gets a visible cell (1/64 of the screenshot, a power of 2), not 1e-10", (() => { const j = J(r); return j && j.summary.cell === 8 && j.summary.cells === 1 && j.summary.seconds === 1; })(), r.stdout.slice(0, 300) + r.stderr);

  // eval: frames, prev, --keys, --summary, --when, --diff
  r = cli(["eval", "--at", "30f", "--input", "right@0-30f", "state.player.pos[0]", "state.player.pos[0] - prev.player.pos[0]", "--json"]);
  ok("eval: --at 30f with a frame-timed input, and prev", (() => { const j = J(r)?.data.rows; return j && j[0].frame === 30 && j[0].values["state.player.pos[0]"] === 100 && j[0].values["state.player.pos[0] - prev.player.pos[0]"] === 2; })(), r.stdout + r.stderr);
  r = cli(["eval", "--keys", "--input", "right@0-1"]);
  ok("eval --keys: inline vectors, live marks, entity groups", r.status === 0 && /~state\.player\.pos = \[160,90\]/.test(r.stdout) && / state\.player\.hp = 3/.test(r.stdout) && /state\.entities {2}\[3\]: Player ×1, Coin ×2/.test(r.stdout) && /Coin ×2: id ∈ 13\.\.14, pos \[2\]/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["eval", "--summary", "--at", "1", "--input", "right@0-1"]);
  ok("eval --summary", r.status === 0 && /— frame 60 {2}t=1s {2}\[Player×1, Coin×2\]/.test(r.stdout), r.stdout);
  r = cli(["eval", "--when", "state.score >= 1, count('Coin') == 3, state.score > 9", "--time", "3", "--input", "right@0-3"]);
  ok("eval --when: the exact first frame (x reaches 70 > 68 at f15)", /state\.score >= 1: first true at frame 15 \(t=0\.25s\), stays true to the end \(f180, 3s\)/.test(r.stdout), r.stdout + r.stderr);
  ok("eval --when: a span, and never", /count\('Coin'\) == 3: true from frame 37 to 54 \(18f/.test(r.stdout) && /state\.score > 9: never true in f0\.\.f180/.test(r.stdout), r.stdout);
  r = cli(["eval", "--when", "state.score >= 1", "--time", "1", "--input", "right@0-1", "--json"]);
  ok("eval --when --json envelope", (() => { const j = J(r); return j && j.ok && j.command === "eval --when" && j.summary["state.score >= 1"].first === 15; })(), r.stdout);
  r = cli(["eval", "--diff", "0.2,1", "--input", "right@0-1"]);
  ok("eval --diff: entities by id", /frames 12→60\), 6 paths changed/.test(r.stdout) && /state\.entities\[Coin#10\]: removed/.test(r.stdout) && /state\.score: 0 → 3/.test(r.stdout) && /state\.player\.pos: \[64,90\] → \[160,90\]/.test(r.stdout), r.stdout + r.stderr);

  // test range steps (always / never / eventually / within / since) and B12
  r = cli(["test", path.join(here, "mock", "range.witness.json")]);
  ok("test ranges: holding ranges pass", /✔ pass {2}ranges that hold {2}\(6 expects passed\)/.test(r.stdout), r.stdout + r.stderr);
  ok("test ranges: always fails at the first bad frame with values", /always state\.score == 0 — failed at frame 15 \(t=0\.25s\): got 1 == 0/.test(r.stdout), r.stdout);
  ok("test ranges: never names the frame it became true", /never count\('Coin'\) < 4 — true at frame 37 \(t=0\.617s\): got 3 < 4/.test(r.stdout), r.stdout);
  ok("test ranges: eventually that never happens", /eventually state\.score == 1 — never true in frames 0\.\.10/.test(r.stdout), r.stdout);
  ok("test ranges: since() counts frames", /always since\(state\.score == 2\) < 5 — failed at frame 45/.test(r.stdout), r.stdout);
  ok("test B12: prev is the previous step even if it fetched nothing", /✔ pass {2}prev is the previous step/.test(r.stdout) && r.status === 1 && /2 passed, 1 failed/.test(r.stdout), r.stdout);

  // effect: state +3f, picture +5f, sound +1f (MOCK_LAG), and a key that does nothing
  r = cli(["effect", "--input", "x@1", "--json"], { MOCK_LAG: "1" });
  ok("effect: planted latencies exactly (+3f state, +5f pixels, +1f audio)", (() => { const j = J(r); return j && j.summary.inputFrame === 60 && j.summary.stateAfter === 3 && j.summary.pixelAfter === 5 && j.summary.audioAfter === 1 && j.summary.deterministic && j.data.pixelRegions.length === 1 && j.data.pixelRegions[0].x === 300 && j.data.pixelRegions[0].w === 10; })(), r.stdout + r.stderr);
  r = cli(["effect", "--input", "x@1"], { MOCK_LAG: "1" });
  ok("effect: text names the changed path and the lag of the picture", /state {3}first differs at f63 \(\+3f, 50 ms\): lagged false → true/.test(r.stdout) && /the picture trails the state by 2f/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["effect", "--input", "q@1", "--time", "20f"], { MOCK_LAG: "1" });
  ok("effect: a key that does nothing", /verdict: no effect within 0\.333s \(20 frames\)/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["effect", "--input", "space@1", "--base", "right@0-3", "--paths", "player.grounded", "--json"], { MOCK_JUMP: "1" });
  ok("effect: --base shared by both runs, --paths narrows the state diff", (() => { const j = J(r); return j && j.summary.stateAfter === 1 && j.data.firstChanges.length === 1 && j.data.firstChanges[0].path === "state.player.grounded"; })(), r.stdout + r.stderr);

  // measure curve presets on MOCK_JUMP's analytic numbers
  r = cli(["measure", "jump", "--y", "state.player.pos[1]", "--input", "right@0-3, space@1", "--json"], { MOCK_JUMP: "1" });
  ok("measure jump: apex 64.8 px at +18f, airtime 36f, hang 11f, gravity 0.4 both ways", (() => { const s = J(r)?.summary; return s && s.apexPx === 64.8 && s.apexAfter === 18 && s.takeoffAfter === 1 && s.airtimeFrames === 36 && s.airtimeSeconds === 0.6 && s.hangFrames === 11 && s.riseFrames === 18 && s.fallFrames === 18 && s.gravityRise === 0.4 && s.gravityFall === 0.4; })(), r.stdout + r.stderr);
  r = cli(["measure", "move", "--x", "state.player.pos[0]", "--input", "right@1-2", "--json"], { MOCK_JUMP: "1" });
  ok("measure move: 180 px/s reached +6f, stops +2f after release, slides 3 px", (() => { const s = J(r)?.summary; return s && s.topSpeed === 180 && s.reachedAfter === 6 && s.accelFrames === 6 && s.firstMoveAfter === 1 && s.stopAfter === 2 && s.slide === 3 && s.overshoot === 0; })(), r.stdout + r.stderr);
  r = cli(["measure", "hitstop", "--paths", "state.player.pos", "--input", "right@0-1.5, h@1", "--json"], { MOCK_JUMP: "1" });
  ok("measure hitstop: one 5-frame freeze, f61–f65", (() => { const s = J(r)?.summary; return s && s.freezes === 1 && s.first.from === 61 && s.first.to === 65 && s.first.frames === 5; })(), r.stdout + r.stderr);
  r = cli(["measure", "curve", "--of", "state.player.pos[0]", "--input", "right@1-2", "--time", "3"], { MOCK_JUMP: "1" });
  ok("measure curve: range, rise, holds, no stutter", r.status === 0 && /40 → 215\.5/.test(r.stdout) && /per frame 0\.\.3/.test(r.stdout) && /stutter: none/.test(r.stdout) && /holds still: f1–f60 \(60f\)/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["measure", "jump", "--y", "state.player.pos", "--input", "space@1"], { MOCK_JUMP: "1" });
  ok("measure: a vector expression asks for one axis", r.status !== 0 && /pick one axis/.test(r.stderr), r.stderr);

  // motion: auto background on a clip where the player is visible in frame 0 (B3), PNG screenshots (B10)
  // (down: away from the coins, so the player is the only thing that moves)
  r = cli(["measure", "motion", "--at", "0", "--time", "0.5", "--input", "down@0-1", "--json"]);
  ok("measure motion B3: auto → median, the true 2 px/frame", (() => { const j = J(r); return j && j.data.background === "median" && j.summary.meanStep === 2 && j.data.steps.slice(1).every((d) => d && d[0] === 0 && d[1] === 2) && j.summary.jitter === 0; })(), r.stdout.slice(0, 500) + r.stderr);
  r = cli(["measure", "motion", "--at", "0", "--time", "0.5", "--input", "down@0-1", "--json"], { MOCK_PNG: "1" });
  ok("measure motion B10: PNG screenshots are decoded", (() => { const j = J(r); return j && j.summary.meanStep === 2; })(), r.stdout.slice(0, 300) + r.stderr);

  // motion v2: several objects, static changes, merged frames left out, and a scrolling camera with a planted hitch
  r = cli(["measure", "motion", "--at", "0", "--time", "0.5", "--input", "right@0-1", "--json"]);
  ok("motion v2: the player is one object at exactly 2 px/f; the vanished coin is a static change", (() => { const j = J(r)?.data; return j && j.objects.length === 1 && j.objects[0].meanStep === 2 && j.objects[0].jitter === 0 && j.objects[0].stutters.length === 0 && j.objects[0].net[0] === 60 && j.static.length >= 1 && j.static[0].first === 0 && j.static[0].last === 13; })(), r.stdout.slice(0, 600) + r.stderr);
  // (diagonal, 36 frames: the player stays on screen while the camera scrolls, and touches no coin)
  r = cli(["measure", "motion", "--at", "0", "--time", "36f", "--input", "right@0-1, down@0-1", "--json"], { MOCK_CAMERA: "1" });
  ok("motion v2: camera 73 px over 36 frames, the 3 px step at f30 flagged", (() => { const c = J(r)?.data.camera; return c && c.moving && c.total[0] === 73 && c.total[1] === 0 && c.uneven.length === 1 && c.uneven[0].i === 30 && c.uneven[0].got[0] === 3 && c.steps.filter((q) => q.dx !== 2).length === 1; })(), r.stdout.slice(0, 600) + r.stderr);
  ok("motion v2: the player's world motion is [2, 2] px/f with the camera removed", (() => { const o = J(r)?.data.objects; return o && o.length === 1 && o[0].meanStep === 2.828 && o[0].net[0] === 72 && o[0].net[1] === 72 && o[0].jitter === 0 && o[0].stutters.length === 0; })(), r.stdout.slice(0, 900));
  // measure align: state ↔ pixels (pixel space, camera + zoom, a planted art offset and hitboxes), shot --annotate
  r = cli(["measure", "align", "--at", "0.5", "--json"]);
  ok("align: the mock is drawn in pixel space (identity, residual 0)", (() => { const q = J(r)?.summary; return q && q.ax === 1 && q.bx === 0 && q.ay === 1 && q.by === 0 && q.residual === 0 && q.matched === 6; })(), r.stdout.slice(0, 400) + r.stderr);
  r = cli(["measure", "align", "--at", "10f", "--json"], { MOCK_CAMERA: "flat", MOCK_ZOOM: "2" });
  ok("align: camera offset and ×2 zoom recovered, and state.camera agrees", (() => { const j = J(r); return j && j.summary.ax === 2 && j.summary.bx === -40 && j.summary.ay === 2 && j.summary.by === -80 && j.data.cameraHint.scale === 2 && j.data.cameraHint.ox === -40; })(), r.stdout.slice(0, 400) + r.stderr);
  r = cli(["measure", "align", "--at", "0.5"], { MOCK_ALIGN: "1" });
  ok("align: coin 12 drawn 6 px left is flagged; hitboxes vs art", /#12 Coin 6 px left/.test(r.stdout) && /Player box 15×15 vs art 15×15 ✔/.test(r.stdout) && /Coin ×5 box 16×16 vs art 11×11 ✖ hitbox larger than the art/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["shot", "--at", "0.5", "--annotate", "--out", path.join(work, "ann.png"), "--json"]);
  ok("shot --annotate: every entity labelled, positions fitted to the sprites", (() => { const j = J(r)?.data.shots[0]; return j && j.annotated === 6 && j.fit && j.fit.ax === 1 && fs.existsSync(path.join(work, "ann.png")); })(), r.stdout.slice(0, 400) + r.stderr);

  // witness ab: the same scenario twice with one difference (reset params, env), compared in a rect
  r = cli(["ab", "--a", 'params={"big":false}', "--b", 'params={"big":true}', "--at", "0.5", "--rect", "20,70,40,40", "--state", "--out", path.join(work, "ab"), "--json"]);
  ok("ab: radius 7 → 9 is 149 → 253 px: 104 changed, each +154.15 luma, in the right bbox", (() => { const q = J(r)?.summary; return q && q.changedPixels === 104 && q.lumaDeltaChanged === 154.15 && q.lumaDelta === 10.02 && q.bbox.x === 31 && q.bbox.w === 19 && q.stateChanges === 0 && fs.existsSync(path.join(work, "ab", "ab-f30.png")); })(), r.stdout.slice(0, 500) + r.stderr);
  r = cli(["ab", "--a", "MOCK_ALIGN=", "--b", "MOCK_ALIGN=1", "--at", "0.5", "--from", "0.2", "--to", "0.6", "--every", "6f", "--rect", "140,80,40,30", "--out", path.join(work, "ab2")]);
  ok("ab: an env difference runs two processes; the coin moved -6,0; a filmstrip of both", /two game processes/.test(r.stdout) && /moved -6,0 x=149 y=88 17×11/.test(r.stdout) && /changed px per frame 112, 112, 112, 112, 112/.test(r.stdout) && fs.existsSync(path.join(work, "ab2", "ab-sheet.png")), r.stdout + r.stderr);
  r = cli(["ab", "--a", "input=right@0-0.5", "--b", "input=left@0-0.5", "--at", "0.5", "--state", "--json"]);
  ok("ab: an input difference, and the state diff between A and B", (() => { const j = J(r); const m0 = j?.data.moments[0]; return m0 && m0.state.some((d) => d.path === "state.player.pos" && d.a[0] === 100 && d.b[0] === 0); })(), r.stdout.slice(0, 500) + r.stderr);
  // a frozen camera (the reserved reset param), the game's own camera, and registration against the state
  r = cli(["measure", "motion", "--hold-camera", "--at", "0", "--time", "36f", "--input", "right@0-1, down@0-1", "--json"], { MOCK_CAMERA: "1" });
  ok("--hold-camera: the game keeps its camera still, so screen motion is world motion", (() => { const j = J(r)?.data; return j && j.camera && !j.camera.moving && j.objects[0].net.join() === "72,72"; })(), r.stdout.slice(0, 400) + r.stderr);
  r = cli(["measure", "motion", "--camera", "state", "--at", "0", "--time", "36f", "--input", "right@0-1, down@0-1", "--json"], { MOCK_CAMERA: "1" });
  ok("motion --camera state: the camera from state.camera (the f30 step exact), world motion [2,2]", (() => { const j = J(r)?.data; return j && j.camera.moving && j.camera.uneven.length === 1 && j.camera.uneven[0].i === 30 && j.objects[0].meanStep === 2.828; })(), r.stdout.slice(0, 400) + r.stderr);

  // measure ui (MOCK_UI: the planted layout bugs), colorblind and palette
  const { contrastRatio, deltaE, hex: hexOf } = await import("../src/media/color.js");
  const hintRatio = Math.round(contrastRatio([70, 70, 90], [20, 24, 40]) * 1000) / 1000;
  r = cli(["measure", "ui", "--json", "--out", path.join(work, "ui.png")], { MOCK_UI: "1" });
  ok("measure ui: exactly the planted findings from state.ui", (() => { const j = J(r); const q = j?.summary; return j && !j.ok && r.status === 1 && q.source === "state.ui" && q.elements === 11 && q.problems === 5 && q.warnings === 3 && q.clipped === 1 && q.offscreen === 1 && q.overlaps === 1 && q.smallText === 1 && q.lowContrast === 1 && q.unsafe === 1 && q.misaligned === 2 && j.data.checks.clipped[0].id === "minimap" && j.data.checks.clipped[0].past.right === 10 && j.data.checks.offscreen[0].id === "toast" && j.data.checks.overlaps[0].area === 200 && j.data.checks.small[0].id === "tiny" && j.data.checks.unsafe[0].into.left === 6 && fs.existsSync(path.join(work, "ui.png")) && j.files.length === 1; })(), r.stdout.slice(0, 900) + r.stderr);
  ok("measure ui: the hint's contrast is the exact ratio of its two colours", (() => { const c = J(r)?.data.contrast.find((x) => x.id === "hint"); return c && c.ratio === hintRatio && c.fg.join() === "70,70,90" && c.bg.join() === "20,24,40"; })(), JSON.stringify(J(r)?.data.contrast));
  r = cli(["measure", "ui"], { MOCK_UI: "1" });
  ok("measure ui text: one line per finding", /✖ 5 problems, 3 warnings/.test(r.stdout) && /minimap \(panel\) clipped: 10 px past the right edge \(75% visible\)/.test(r.stdout) && /btn_a \(button\) and btn_b \(button\) overlap by 20×10 px at 240,50/.test(r.stdout) && /tiny \(text "tiny"\) font 3 px < 3\.6 px/.test(r.stdout) && r.stdout.includes(`hint (text "PRESS E") contrast ${hintRatio.toFixed(2)}:1 < 4.5`) && /btn_a \/ btn_c almost aligned: left 200 vs 202, right 260 vs 262, centre-x 230 vs 232/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["measure", "ui", "--window", "320x180,280x180", "--json"], { MOCK_UI: "1" });
  ok("measure ui --window: btn_b clips only at 280×180", (() => { const w = J(r)?.summary.windows; return w && w.length === 2 && w[0].clipped === 1 && w[1].clipped === 2 && w[1].problems === 6 && J(r).summary.problems === 11; })(), r.stdout.slice(0, 600) + r.stderr);
  r = cli(["measure", "ui", "--window", "320x180,280x180"], { MOCK_UI: "1" });
  ok("measure ui --window text: what breaks only at one size", /only at 280x180: btn_b \(button\) clipped: 20 px past the right edge/.test(r.stdout) && !/only at 320x180/.test(r.stdout), r.stdout);
  // world things without state.ui: villagers (filled sprites) are not text; an INN sign that scrolls with the camera
  // (MOCK_CAMERA=flat: 2 px per frame) is found on the frame 6 frames later 12 px left, and left out as world art
  r = cli(["measure", "ui", "--at", "0.1", "--json"], { MOCK_UI: "world" });
  ok("measure ui pixels: villagers are not a text row; the static INN sign is (5 rows → 4 text + INN), low confidence", (() => { const j = J(r); const t = j?.data.elements.filter((e) => e.kind === "text").map((e) => e.id); return j && !t.includes("text@121,60") && t.includes("text@242,95") && t.length === 5 && j.summary.confidence === "low" && j.summary.movedWithWorld === 0 && j.data.findings.every((f) => f.confidence === "low"); })(), r.stdout.slice(0, 900) + r.stderr);
  r = cli(["measure", "ui", "--at", "0.1", "--json"], { MOCK_UI: "world", MOCK_CAMERA: "flat" });
  ok("measure ui pixels: a row that scrolls with the camera (by -12,0 from f6 to f12) is left out as world", (() => { const j = J(r); const mv = j?.data.movedWithWorld; return j && mv.length === 1 && mv[0].rect.join() === "230,95,21,10" && mv[0].dx === -12 && mv[0].dy === 0 && !j.data.elements.some((e) => e.id === "text@230,95") && j.summary.movedWithWorld === 1; })(), r.stdout.slice(0, 900) + r.stderr);
  r = cli(["measure", "ui", "--at", "0.1"], { MOCK_UI: "world", MOCK_CAMERA: "flat" });
  ok("measure ui pixels text: one low-confidence hint naming state.ui, the moved row, findings marked", /\? low confidence: pixel guesses .* state\.ui = \[\{id, kind, rect, text\}\]/.test(r.stdout) && /1 text-like row moved with the world from f6 to f12 \(230,95 21×10 by -12,0\)/.test(r.stdout) && /\(low confidence\)/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["measure", "ui", "--json"], { MOCK_UI: "pixels" });
  ok("measure ui without state.ui: text rows from pixels, the low-contrast hint, the edge and the safe area", (() => { const j = J(r); const q = j?.summary; return q && q.source === "pixels" && j.data.elements.filter((e) => e.kind === "text").length === 4 && q.lowContrast === 1 && j.data.findings.find((f) => f.kind === "contrast").ids[0] === "text@101,153" && q.touchingEdge === 1 && q.unsafe === 1 && q.clipped === 0 && q.overlaps === 0 && j.data.contrast.find((c) => c.id === "text@101,153").ratio === hintRatio; })(), r.stdout.slice(0, 900) + r.stderr);
  r = cli(["measure", "colorblind", "--json", "--out", path.join(work, "cvd")]);
  ok("measure colorblind: the entities' sprite colours and the background, distinct under all 3 types, pictures written", (() => { const j = J(r); return j && j.ok && j.summary.source === "entities" && j.data.colors.map((c) => `${c.name}${c.hex}`).join() === "Player#50c8ff,Coin#ffd23c,background#141828" && j.summary.lostPairs === 0 && j.files.length === 4 && j.files.every((f) => fs.existsSync(f)) && /colorblind-cvd\.png$/.test(j.files[0]); })(), r.stdout.slice(0, 900) + r.stderr);
  const cvShot = path.join(work, "cv.png");
  cli(["shot", "--at", "1", "--out", cvShot]);
  r = cli(["measure", "colorblind", cvShot, "--colors", "hostile=#dc3232,friendly=#3cb44b", "--no-images", "--json"]);
  ok("measure colorblind --colors: red vs green lost under deutan only (exit 1)", (() => { const j = J(r); return j && !j.ok && r.status === 1 && j.summary.lost.deutan === 1 && j.summary.lost.protan === 0 && j.summary.lost.tritan === 0 && j.summary.minDeltaE.deutan === 12.35 && j.files.length === 0; })(), r.stdout.slice(0, 600) + r.stderr);
  r = cli(["measure", "colorblind", cvShot, "--a", "#50c8ff", "--b", "ring:2", "--type", "deutan", "--no-images", "--json"]);
  ok("measure colorblind --a/--b: the mask contrast normally and under deutan", (() => { const q = J(r)?.summary; return q && q.maskDeltaE && q.maskDeltaE.normal > 60 && q.maskDeltaE.deutan > 60 && Object.keys(q.lost).join() === "deutan"; })(), r.stdout.slice(0, 600) + r.stderr);
  const cvShot2 = path.join(work, "cv2.png");
  cli(["shot", "--at", "1", "--input", "right@0-1", "--out", cvShot2]);
  r = cli(["measure", "colorblind", cvShot, "--a", "#50c8ff", "--b", `diff:${cvShot2}`, "--no-images", "--json"]);
  const rc = cli(["measure", "contrast", cvShot, "--a", "#50c8ff", "--b", `diff:${cvShot2}`, "--json"]);
  ok("measure colorblind --b diff:<png>: masks as in contrast (the same normal ratio)", (() => { const q = J(r)?.summary, c = J(rc)?.summary; return q && c && q.maskDeltaE && Math.abs(q.maskDeltaE.normal - c.deltaE) < 0.01; })(), r.stdout.slice(0, 400) + r.stderr + rc.stderr);
  fs.writeFileSync(path.join(work, "zero-ui.json"), JSON.stringify([{ id: "z", kind: "text", rect: [0, 0, 0, 0], text: "zero" }]));
  r = cli(["measure", "ui", cvShot, "--ui", path.join(work, "zero-ui.json")]);
  ok("measure ui: a zero-size text element is reported as such, not as 'one flat colour'", /z \(text "zero"\): zero-size rect \(0×0\)/.test(r.stdout) && !/flat colour/.test(r.stdout) && !/font|rect height/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["measure", "palette", cvShot, "--palette", "#141828,#ffd23c", "--max", "2", "--out", path.join(work, "off.png"), "--json"]);
  ok("measure palette: the player's 149 px are off a 2-colour palette, 3 colours > max 2, picture written", (() => { const j = J(r); const q = j?.summary; return q && !j.ok && q.colors === 3 && q.offPixels === 149 && q.offColors === 1 && q.over === true && j.data.offColors[0].hex === "#50c8ff" && j.data.offColors[0].bbox.w === 15 && j.data.offColors[0].bbox.h === 15 && fs.existsSync(path.join(work, "off.png")); })(), r.stdout.slice(0, 600) + r.stderr);
  r = cli(["measure", "palette", cvShot, "--palette", "#141828,#ffd23c,#50c8ff"]);
  ok("measure palette: all on the palette", r.status === 0 && /✔ every pixel is on the 3-colour palette/.test(r.stdout), r.stdout + r.stderr);
  // measure ui (MOCK_UI=look): the same text twice, text over the world without a plate, a repeated toast; device safe areas
  {
    const rr = (v) => Math.round(v * 100) / 100;
    r = cli(["measure", "ui", "--at", "0.6", "--json"], { MOCK_UI: "look" });
    ok("measure ui: QUEST UPDATED twice at once, with both rects", (() => { const j = J(r); const d = j?.data.duplicates; return j && j.summary.duplicates === 1 && d.length === 1 && d[0].ids.join() === "quest1,quest2" && d[0].rects.map((q) => q.join()).join("|") === "30,36,104,16|30,56,104,16"; })(), r.stdout.slice(0, 900) + r.stderr);
    ok("measure ui: WEARY over the sand patch without a plate: worst glyph edge = white on sand exactly, the average hides it", (() => { const j = J(r); const c = j?.data.contrast.find((x) => x.id === "status"); const f = j?.data.findings.find((x) => x.kind === "no-plate"); return j && j.summary.noPlate === 1 && c.plate.busy && c.plate.edge.worst === rr(contrastRatio([240, 240, 240], [222, 205, 160])) && c.plate.edge.best === rr(contrastRatio([240, 240, 240], [20, 24, 40])) && c.ratio > 4.5 && f.ids[0] === "status" && f.at[0] >= 170 && !j.data.findings.some((x) => x.kind === "contrast" && x.ids[0] === "status") && !j.data.contrast.find((x) => x.id === "quest1").plate.busy; })(), r.stdout.slice(0, 900) + r.stderr);
    r = cli(["measure", "ui", "--from", "0", "--to", "5", "--within", "4", "--json"], { MOCK_UI: "look" });
    ok("measure ui --from/--to: SAVED GAME again at f150, 2 s after it appeared at f30, hidden 1 s; the doubled quest line from f0", (() => { const j = J(r); const q = j?.data.repeats; return j && !j.ok && j.summary.repeats === 1 && q[0].text === "SAVED GAME" && q[0].first.f0 === 30 && q[0].first.f1 === 90 && q[0].again.f0 === 150 && q[0].sinceStart === 2 && q[0].hidden === 1 && q[0].again.rect.join() === "180,10,80,16" && j.summary.duplicates === 1 && j.data.duplicates[0].first === 0 && j.data.duplicates[0].frames === 301 && j.summary.samples === 301; })(), r.stdout.slice(0, 900) + r.stderr);
    r = cli(["measure", "ui", "--from", "0", "--to", "5", "--within", "1.5"], { MOCK_UI: "look" });
    ok("measure ui sweep text: no repeat within 1.5 s; the doubled line still printed", r.status === 1 && !/shown again/.test(r.stdout) && /"QUEST UPDATED" shown twice at once from f0/.test(r.stdout), r.stdout + r.stderr);
    r = cli(["measure", "ui", "--from", "0", "--to", "5", "--within", "4"], { MOCK_UI: "look" });
    ok("measure ui sweep: the repeated toast is a warning (⚠ toast2 \"SAVED GAME\"), lives \"HP 3\" staying on screen is none", /⚠ toast2 "SAVED GAME" shown again 2 s/.test(r.stdout) && !/HP 3/.test(r.stdout.split("texts:")[0]), r.stdout);
    // a 320×180 (16:9) game on a landscape iPhone is fitted to the height: 2.1833 pt per px, 76.67 pt bars at the
    // sides, so the 59 pt island insets end in the bars (0 px); the 21 pt bottom inset is 9.62 px
    r = cli(["measure", "ui", "--safe", "iphone-landscape", "--json"], { MOCK_UI: "1" });
    ok("measure ui --safe iphone-landscape (contain): sides 0 px (inside 76.67 pt bars), bottom 21 pt = 9.62 px, nothing in a zone", (() => { const j = J(r); const s = j?.data.safe; return j && s.px.left === 0 && s.px.right === 0 && s.px.bottom === 9.62 && s.px.top === 0 && s.bars.x === 76.67 && s.fit === "contain" && !s.demote && /fitted inside the screen/.test(s.mismatch) && j.summary.unsafe === 0 && j.summary.safePreset === "iphone-landscape"; })(), r.stdout.slice(0, 900) + r.stderr);
    r = cli(["measure", "ui", "--safe", "iphone-landscape", "--window", "639x295"], { MOCK_UI: "1" });
    ok("measure ui --safe on the game's 639×295 canvas: no 'px per pt' warning, the mapping in one line", !/px per pt: not a whole multiple/.test(r.stdout) && (r.stdout.match(/the game's 639×295 canvas, scaled to the 852×393 pt screen/g) || []).length === 1, r.stdout.slice(0, 900) + r.stderr);
    r = cli(["measure", "ui", "--safe", "iphone-landscape", "--fit", "stretch", "--json"], { MOCK_UI: "1" });
    ok("measure ui --safe iphone-landscape --fit stretch: 59 pt sides = 22.16 px per axis, the zone findings only warnings (aspect 1.78 ≠ 2.17)", (() => { const j = J(r); const s = j?.data.safe; const f = j?.data.findings.filter((x) => x.kind === "safe"); return j && s.px.left === 22.16 && s.px.right === 22.16 && s.px.bottom === 9.62 && s.demote && /aspect 1.78/.test(s.mismatch) && f.map((x) => `${x.ids[0]}:${x.level}`).join() === "hud:warn,score:warn,btn_b:warn,badge:warn" && j.data.checks.unsafe.find((u) => u.id === "badge").into.left === 12.16; })(), r.stdout.slice(0, 900) + r.stderr);
    r = cli(["measure", "ui", "--safe", "pixel-8"], { MOCK_UI: "1" });
    ok("measure ui --safe: an unknown preset names the presets", r.status === 1 && /iphone-portrait, iphone-landscape, .*iphone-safari-portrait, .*iphone-se, ipad or a percentage/.test(r.stderr), r.stderr);
  }

  // measure figure (MOCK_FIGURE: four ground quadrants around the player; hide and hour params)
  {
    const rr = (v) => Math.round(v * 100) / 100;
    const F = [80, 200, 255], G = { sand: [194, 178, 128], snow: [240, 244, 250], grass: [60, 140, 60], road: [70, 70, 75] };
    const night = (c) => c.map((v) => Math.round(v * 0.3));
    r = cli(["measure", "figure", "--of", "Player", "--params", '[{"hour":12},{"hour":22}]', "--at", "0.1", "--surfaces", "sand=#c2b280,snow=#f0f4fa,grass=#3c8c3c,road=#46464b", "--out", path.join(work, "fig"), "--json"], { MOCK_FIGURE: "1" });
    const sh = J(r)?.data.shots;
    ok("measure figure: the silhouette from the hide param, 4 named surfaces by day with the exact ratio and ΔE of each pair", (() => { if (!sh) return false; const d = sh[0]; return /hide: \[1\]/.test(d.silhouette) && d.figurePixels === 149 && d.surfaces.length === 4 && Object.entries(G).every(([n, g]) => { const s = d.surfaces.find((x) => x.name === n); return s && s.ratio.worst === rr(contrastRatio(F, g)) && s.ratio.median === s.ratio.worst && s.deltaE.median === rr(deltaE(F, g)); }); })(), r.stdout.slice(0, 900) + r.stderr);
    ok("measure figure: at night (×0.3) the same surfaces named by position, with the night colours' exact ratios", (() => { if (!sh) return false; const d = sh[1]; return Object.entries(G).every(([n, g]) => { const s = d.surfaces.find((x) => x.name === n); return s && s.nameFrom && s.hex === hexOf(night(g)) && s.ratio.worst === rr(contrastRatio(night(F), night(g))); }); })(), JSON.stringify(sh && sh[1].surfaces));
    ok("measure figure: verdict, summary and picture: 7 surfaces under 3:1 (all but day road), worst sand at night 1.04", (() => { const j = J(r); return j && !j.ok && r.status === 1 && j.summary.failing === 7 && j.summary.worstMedianRatio === rr(contrastRatio(night(F), night(G.sand))) && j.summary.worstSurface === "sand" && fs.existsSync(path.join(work, "fig", "figure.png")); })(), r.stdout.slice(0, 600) + r.stderr);
    // a param set that moves the ground (swap: sand and grass trade places) keeps the given colours' names
    r = cli(["measure", "figure", "--of", "Player", "--params", '[{},{"swap":1}]', "--at", "0.1", "--surfaces", "sand=#c2b280,snow=#f0f4fa,grass=#3c8c3c,road=#46464b", "--json"], { MOCK_FIGURE: "1" });
    ok("measure figure: after a layout param (swap) each surface keeps its colour's name, not the old position's", (() => { const d = J(r)?.data.shots[1]; return d && Object.entries(G).every(([n, g]) => { const q = d.surfaces.find((x) => x.name === n); return q && q.hex === hexOf(g) && !q.nameFrom; }); })(), JSON.stringify(J(r)?.data.shots[1]?.surfaces.map((x) => [x.name, x.hex, x.nameFrom])));
    // --min-share 5 is 5% (it was read as 500%: every surface minor, ok with 0 judged)
    r = cli(["measure", "figure", "--of", "Player", "--at", "0.1", "--min-share", "5", "--json"], { MOCK_FIGURE: "1" });
    ok("measure figure --min-share 5 = 5%: 4 surfaces judged, 3 failing", (() => { const j = J(r); return j && !j.ok && j.data.minShare === 0.05 && j.summary.surfaces === 4 && j.summary.failing === 3; })(), r.stdout.slice(0, 600) + r.stderr);
    r = cli(["measure", "figure", "--of", "Player", "--at", "0.1", "--min-share", "500"], { MOCK_FIGURE: "1" });
    ok("measure figure --min-share 500: refused", r.status === 1 && /--min-share is a share of the ring/.test(r.stderr), r.stderr);
    // an entity without an id is hidden by type (every NPC goes): the diff is cut to the part at its position
    r = cli(["measure", "figure", "--of", "Bob", "--at", "0.1", "--json"], { MOCK_FIGURE: "npc" });
    ok("measure figure --of Bob (no id): hidden by type, only Bob's 6×6 = 36 px kept, not Ann's too", (() => { const d = J(r)?.data.shots[0]; return d && d.figurePixels === 36 && d.bbox.x === 197 && /every NPC was hidden; the part at its position kept/.test(d.silhouette); })(), r.stdout.slice(0, 600) + r.stderr);
    // hiding by id also re-sorted two tied props far away (MOCK_FIGURE=sort): only the region at the player is the
    // silhouette (149 px, 15×15 at 33,83), the 5×11 = 55 px elsewhere is reported, not merged into a 122×41 box
    r = cli(["measure", "figure", "--of", "Player", "--at", "0.1", "--json"], { MOCK_FIGURE: "sort" });
    ok("measure figure hide:[id]: only the diff region at the entity; 55 px elsewhere warned (draw order)", (() => { const d = J(r)?.data.shots[0]; return d && d.figurePixels === 149 && d.bbox.w === 15 && d.bbox.h === 15 && d.bbox.x === 33 && d.elsewhere && d.elsewhere.pixels === 55 && d.elsewhere.regions.length === 1 && d.elsewhere.regions[0].join() === "150,113,5,11" && J(r).summary.warnings === 1; })(), r.stdout.slice(0, 900) + r.stderr);
    r = cli(["measure", "figure", "--of", "Player", "--at", "0.1"], { MOCK_FIGURE: "sort" });
    ok("measure figure hide:[id]: the text names the other region and the likely cause", /⚠ 55 px changed elsewhere \(1 region: 5×11 at 150,113\): draw order \/ unstable sort\?/.test(r.stdout), r.stdout + r.stderr);
    r = cli(["measure", "figure", "--of", "Player", "--params", '{"hour":12}', "--at", "0.1", "--min", "1.05", "--expect", "worstMedianRatio >= 1.1"], { MOCK_FIGURE: "1" });
    ok("measure figure --min / --expect: every surface over 1.05, worst median 1.11", r.status === 0 && /✔ expect worstMedianRatio >= 1.1: got 1.11/.test(r.stdout), r.stdout + r.stderr);
    // no hide support: a box in the state (MOCK_ALIGN) or the sprite found at its state position; exact on a flat floor
    const flat = rr(contrastRatio(F, [20, 24, 40]));
    r = cli(["measure", "figure", "--of", "state.player", "--without", "seed=1", "--at", "0.1", "--json"], { MOCK_ALIGN: "1" });
    ok("measure figure: when --without changes nothing, the state box minus the ground's colours", (() => { const d = J(r)?.data.shots[0]; return d && /^box 33,83 15×15/.test(d.silhouette) && /--without changed no pixels/.test(d.silhouette) && d.figurePixels === 149 && d.surfaces[0].ratio.worst === flat; })(), r.stdout.slice(0, 600) + r.stderr);
    r = cli(["measure", "figure", "--of", "Coin", "--at", "0.1", "--params", '{"hide":"none"}', "--json"]);
    ok("measure figure: --of a type measures each one; without hide support or a box, each sprite at its state position", (() => { const d = J(r)?.data.shots; return d && d.length === 5 && d.every((x) => /the sprite at its state position/.test(x.silhouette) && x.surfaces[0].ratio.worst === rr(contrastRatio([255, 210, 60], [20, 24, 40]))) && /the game ignored the hide param/.test(d[0].silhouette); })(), r.stdout.slice(0, 600) + r.stderr);
    r = cli(["measure", "figure", "--of", "Wizard"]);
    ok("measure figure: an unknown --of is named", r.status === 1 && /--of Wizard: nothing in state.entities/.test(r.stderr), r.stderr);
    // from files: --mask diff:<without.png>
    const withP = path.join(work, "fig-with.png"), withoutP = path.join(work, "fig-without.png");
    cli(["shot", "--at", "0.1", "--out", withP], { MOCK_FIGURE: "1" });
    cli(["shot", "--at", "0.1", "--out", withoutP, "--params", '{"hide":["Player"]}'], { MOCK_FIGURE: "1" });
    r = cli(["measure", "figure", withP, "--mask", `diff:${withoutP}`, "--json"]);
    ok("measure figure <png> --mask diff:<without.png>: the same 4 surfaces as driving the game", (() => { const d = J(r)?.data.shots[0]; return d && d.figurePixels === 149 && d.surfaces.length === 4 && J(r).summary.worstMedianRatio === rr(contrastRatio(F, G.sand)); })(), r.stdout.slice(0, 600) + r.stderr);
    // the same from files when the hide also re-sorted the tied props: the largest region, the other one reported
    cli(["shot", "--at", "0.1", "--out", withP], { MOCK_FIGURE: "sort" });
    cli(["shot", "--at", "0.1", "--out", withoutP, "--params", '{"hide":["Player"]}'], { MOCK_FIGURE: "sort" });
    r = cli(["measure", "figure", withP, "--mask", `diff:${withoutP}`, "--json"]);
    ok("measure figure <png> --mask diff: (re-sorted props too): the largest region (149 px), the 55 px elsewhere warned as draw order", (() => { const j = J(r), d = j?.data.shots[0]; return d && d.figurePixels === 149 && d.bbox.x === 33 && d.elsewhere?.pixels === 55 && d.elsewhere.draw === 1 && j.summary.warnings === 1; })(), r.stdout.slice(0, 900) + r.stderr);
    // the player drawn 200 px right of its state position (world coords, no state.camera): no region is at 40,90
    r = cli(["measure", "figure", "--of", "Player", "--at", "0.1", "--json"], { MOCK_FIGURE: "sort", MOCK_FIGURE_DX: "200" });
    ok("measure figure: state position on no changed pixel (screen = state assumed): the largest region (the hero, 149 px at 233,83), warned", (() => { const j = J(r), d = j?.data.shots[0]; return d && d.figurePixels === 149 && d.bbox.x === 233 && d.unplaced?.how === "largest" && d.elsewhere?.regions[0].join() === "150,113,5,11" && d.elsewhere.draw === 1 && j.summary.warnings === 1; })(), r.stdout.slice(0, 900) + r.stderr);
    r = cli(["measure", "figure", "--of", "Player", "--at", "0.1"], { MOCK_FIGURE: "sort", MOCK_FIGURE_DX: "200" });
    ok("measure figure text: says the position landed on nothing and why", /⚠ its state position 40,90 is on no changed pixel \(screen = state was assumed: world coords\? add state\.camera or a box\): measured the largest changed region instead/.test(r.stdout), r.stdout + r.stderr);
    // a health bar 3 px above the sprite vanishes with it: part of the figure, no warning
    r = cli(["measure", "figure", "--of", "Player", "--at", "0.1", "--json"], { MOCK_FIGURE: "1", MOCK_FIGURE_BAR: "1" });
    ok("measure figure: a health bar 3 px above the sprite is part of the figure (149 + 30 px, 15×20), not 'draw order'", (() => { const j = J(r), d = j?.data.shots[0]; return d && d.figurePixels === 179 && d.bbox.h === 20 && d.parts?.[0].join() === "33,78,15,2" && !d.elsewhere && j.summary.warnings === 0; })(), r.stdout.slice(0, 900) + r.stderr);
    // examples/arena: the Guard's "!" quest marker (drawn 20 px above it) vanishes with it: part of it, not a sort change
    r = spawnSync(process.execPath, [path.join(root, "bin", "witness.js"), "measure", "figure", "--of", "Guard", "--json"], { encoding: "utf8", timeout: 120000, cwd: path.join(root, "examples", "arena") });
    ok("measure figure (arena) --of Guard: its '!' marker joins the figure, no 'draw order' warning", (() => { const j = J(r), d = j?.data.shots[0]; return d && d.parts?.length === 2 && d.parts.every((q) => q[0] === 71) && !d.elsewhere && j.summary.warnings === 0; })(), r.stdout.slice(0, 900) + r.stderr);
  }
  r = cli(["measure", "registration", "--pos", "state.player.pos", "--at", "0", "--time", "36f", "--input", "right@0-1, down@0-1", "--json"], { MOCK_CAMERA: "1" });
  ok("registration: the sprite sits on its state position (offset 0, spread 0); a disc's feet glide", (() => { const q = J(r)?.summary; return q && q.offset.join() === "0,0" && q.spread.join() === "0,0" && q.gliding === 36 && q.planted === 0; })(), r.stdout.slice(0, 400) + r.stderr);
  r = cli(["shot", "--sheet", "--at", "0.2,0.5,1.1", "--out", path.join(work, "mom.png"), "--input", "right@0-1", "--json"]);
  ok("shot --sheet --at: a sheet of chosen moments", (() => { const q = J(r)?.summary; return q && q.frames.join() === "12,30,66" && q.cols === 3; })(), r.stdout.slice(0, 300) + r.stderr);

  // shots: --json, diff regions (B11), crops, sheets, key frames
  const s1 = path.join(work, "a.png"), s2 = path.join(work, "b.png");
  cli(["shot", "--at", "0.5", "--out", s1, "--input", "right@0-1"]);
  r = cli(["shot", "--at", "0.5", "--out", s2, "--input", "right@0-1", "--seed", "2", "--diff", s1, "--json"]);
  ok("shot B11: --json envelope with the diff's regions (v2: each coin's move, exactly)", (() => { const j = J(r); const d = j?.data.shots[0].diff; return j && j.command === "shot" && d && d.changedPixels === 552 && d.regions.length === 4 && d.regions.slice(0, 3).every((q) => q.kind === "moved" && q.moved.join() === "0,7") && d.regions[3].moved.join() === "0,-54" && j.summary.ssim > 0.9; })(), r.stdout + r.stderr);
  r = cli(["shot", "--at", "0.5", "--out", s2, "--input", "right@0-1", "--seed", "2", "--diff", s1]);
  ok("shot B11: regions printed in the text", /0\.958% changed \(552 px\) in 4 regions · SSIM 0\.9\d+/.test(r.stdout) && /1 moved \+0,\+7 inside x=115 y=75 11×18/.test(r.stdout) && /4 moved \+0,-54: x=235 y=114 → x=235 y=60 11×11/.test(r.stdout), r.stdout);
  // diff v2: a walk inside one region, a camera-only change, a size mismatch
  const w1 = path.join(work, "w1.png"), w2 = path.join(work, "w2.png");
  cli(["shot", "--at", "0.2", "--out", w1]);
  r = cli(["shot", "--at", "0.2", "--out", w2, "--input", "right@0-1", "--diff", w1]);
  ok("diff v2: the player's 24 px walk is one move +24,0", /1 moved \+24,\+0 inside x=33 y=83 39×15/.test(r.stdout), r.stdout);
  const c1 = path.join(work, "cam1.png"), c2 = path.join(work, "cam2.png");
  cli(["shot", "--at", "10f", "--out", c1], { MOCK_CAMERA: "1" });
  r = cli(["shot", "--at", "11f", "--out", c2, "--diff", c1, "--json"], { MOCK_CAMERA: "1" });
  ok("diff v2: a camera scroll is the only change (shift -2,0, then 0%)", (() => { const q = J(r)?.summary; return q && q.changedPercent === 0 && q.shift.join() === "-2,0" && q.ssim === 1; })(), r.stdout.slice(0, 500) + r.stderr);
  r = cli(["shot", "--at", "0.2", "--out", path.join(work, "z.png"), "--zoom", "2", "--diff", w1]);
  ok("diff v2: different sizes are an error unless --resize", r.status !== 0 && /different sizes \(add --resize/.test(r.stderr), r.stderr);
  if (fs.existsSync(path.join(root, "src", "media", "sheet.js"))) {
    const { decodePNG } = await import("../src/media/png.js");
    r = cli(["shot", "--at", "1", "--crop", "60,70,40,40", "--zoom", "4", "--out", path.join(work, "crop.png")]);
    const full = path.join(work, "full.png");
    cli(["shot", "--at", "1", "--out", full]);
    const C = decodePNG(fs.readFileSync(path.join(work, "crop.png"))), Fu = decodePNG(fs.readFileSync(full));
    let same = C.width === 160 && C.height === 160;
    for (let y = 0; y < 160 && same; y++) for (let x = 0; x < 160 && same; x++) for (let c = 0; c < 4; c++) if (C.data[(y * 160 + x) * 4 + c] !== Fu.data[((70 + (y >> 2)) * Fu.width + 60 + (x >> 2)) * 4 + c]) { same = false; break; }
    ok("shot --crop --zoom 4: exactly the source pixels, each a crisp 4×4 block", same);
    r = cli(["shot", "--from", "0", "--to", "1", "--every", "6f", "--sheet", "--follow", "state.player.pos", "--size", "40", "--out", path.join(work, "sheet.png"), "--input", "right@0-1", "--json"]);
    ok("shot --sheet --follow: 11 frames, 6×2, 40×40 cells", (() => { const j = J(r); return j && j.summary.frames.length === 11 && j.summary.frames[10] === 60 && j.summary.cols === 6 && j.summary.rows === 2 && j.summary.cell.join() === "40,40"; })(), r.stdout + r.stderr);
    r = cli(["shot", "--from", "0", "--to", "1.5", "--auto", "3", "--out", path.join(work, "auto.png"), "--input", "right@0-1", "--json"]);
    ok("shot --auto 3: the three coin pickups are the biggest changes", (() => { const j = J(r); return j && j.summary.frames.join() === "15,37,55"; })(), r.stdout + r.stderr);
    r = cli(["shot", "--from", "0", "--to", "5", "--every", "1f", "--sheet"]);
    ok("shot --sheet refuses too many cells, with advice", r.status !== 0 && /too many for one readable sheet.*--every/.test(r.stderr), r.stderr);
  }

  // listen: sounds tied to inputs and state events (MOCK_SOUNDS), with and without the game's sound events
  for (const mode of ["1", "quiet"]) {
    r = cli(["listen", "--time", "4", "--input", "j@1, j@2, j@2.5, space@3", "--events", "land: rose(state.player.grounded)", "--out", work, "--json"], { MOCK_JUMP: "1", MOCK_SOUNDS: mode });
    const j = J(r);
    const m = j ? Object.fromEntries(j.data.matches.map((x) => [`${x.event}@${x.frame}`, x])) : {};
    ok(`listen (${mode === "1" ? "with" : "without"} sound events): press → +1f, the eaten press, land → +0f`, j && m["j pressed@60"]?.offset === 1 && m["j pressed@120"]?.sound === null && m["j pressed@150"]?.offset === 1 && m["land@216"]?.offset === 0 && m["space pressed@180"]?.sound === null && j.summary.missing === 2 && j.ok === true, r.stdout.slice(0, 600) + r.stderr);
    if (mode === "1") ok("listen: sounds named by the game", j && j.data.matches.find((x) => x.frame === 60)?.sound === "swing" && j.data.soundEvents.length === 3 && j.data.soundEvents.every((x) => x.heard));
  }
  // measurements as regression tests: measure steps in a test file, and --expect on the command line
  r = cli(["test", path.join(here, "mock", "measure.witness.json")], { MOCK_JUMP: "1" });
  ok("test measure steps: jump/move/effect/window checks pass; a regressed apex fails with its value", r.status === 1 && /✔ pass {2}the jump keeps its feel {2}\(6 expects passed\)/.test(r.stdout) && /expect failed at measure jump: apexPx >= 80 — got 64\.8 >= 80/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["measure", "jump", "--y", "state.player.pos[1]", "--input", "space@1", "--expect", "airtimeFrames between 34f and 38f"], { MOCK_JUMP: "1" });
  ok("--expect passes: exit 0 and the value", r.status === 0 && /✔ expect airtimeFrames between 34f and 38f: got 36 \(want 34\.\.38\)/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["measure", "jump", "--y", "state.player.pos[1]", "--input", "space@1", "--expect", "apexPx >= 80", "--json"], { MOCK_JUMP: "1" });
  ok("--expect fails: exit 1, ok false, the value in the envelope", r.status === 1 && (() => { const j = J(r); return j && j.ok === false && j.expect.ok === false && j.expect.detail === "got 64.8 >= 80"; })(), r.stdout + r.stderr);
  r = cli(["measure", "jump", "--y", "state.player.pos[1]", "--input", "space@1", "--expect", "hangtime > 3"], { MOCK_JUMP: "1" });
  ok("--expect with a wrong field name lists the fields", r.status === 1 && /"hangtime" is not in this result \(fields: apexPx,/.test(r.stdout), r.stdout);
  r = cli(["test", path.join(root, "examples", "coins.witness.json"), "--json"]);
  ok("one envelope: test --json", (() => { const j = J(r); return j && j.command === "test" && j.ok === true && j.summary.passed === 5 && Array.isArray(j.data.results); })(), r.stdout.slice(0, 300));
  r = cli(["doctor", "--json"]);
  ok("one envelope: doctor --json", (() => { const j = J(r); return j && j.command === "doctor" && j.ok === true && j.summary.deterministic === true; })(), r.stdout.slice(0, 300));

  // window: timing sweeps find the planted coyote time (5 frames) and jump buffer (4 frames) exactly
  r = cli(["window", "--input", "right@0-3, space@{t}", "--t", "40f..70f", "--expect", "state.player.jumps == 1", "--at", "{t}+2f", "--ref", "fell(state.player.grounded)", "--json"], { MOCK_JUMP: "1", MOCK_LEDGE: "1" });
  ok("window: coyote time = 5 frames after the ledge (+0f..+4f), one run per value", (() => { const j = J(r); return j && j.summary.runs === 31 && j.summary.windows.length === 1 && j.summary.ref === 55 && j.summary.relative[0][1] === 4 && j.summary.windows[0][0] === 40; })(), r.stdout.slice(0, 400) + r.stderr);
  r = cli(["window", "--input", "space@1, space@{t}", "--t", "80f..100f", "--expect", "state.player.jumps == 2", "--at", "120f", "--ref", "rose(state.player.grounded)"], { MOCK_JUMP: "1" });
  ok("window: jump buffer = 4 frames before the landing step", /passes at t = f91\.\.f100/.test(r.stdout) && /happened in step f95/.test(r.stdout) && /4 values before it \(from -4f/.test(r.stdout) && /fails at f80\.\.f90/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["listen", "--time", "4", "--input", "j@1, j@2, j@2.5", "--out", work], { MOCK_SOUNDS: "1" });
  ok("listen text: ✔/✖ lines and the cooldown hint", /✔ j pressed f60 +→ swing at \+1f/.test(r.stdout) && /✖ j pressed f120 +→ no sound within 6f \(the j press at f60 played swing/.test(r.stdout), r.stdout + r.stderr);
  // a swing starting inside a louder 555 ms quest_start (MOCK_SOUNDS=overlap) is heard, and every section agrees
  r = cli(["listen", "--time", "2", "--input", "j@0.5, j@1.2", "--out", work, "--json"], { MOCK_SOUNDS: "overlap" });
  ok("listen: a sound starting under a longer, louder one is heard (+1f), all 3 announced sounds line up", (() => { const j = J(r); if (!j) return false; const sw = j.data.matches.filter((m) => m.sound === "swing"); const q = j.data.report.sounds.find((x) => x.label === "quest_start"), s = j.data.report.sounds.find((x) => x.label === "swing"); return sw.length === 2 && sw.every((m) => m.offset === 1) && j.data.soundEvents.every((e) => e.heard) && j.summary.unheard === 0 && s.count === 2 && s.times.join() === "0.5,1.2" && Math.abs(q.analysis.length - 0.555) <= 0.01 && !j.data.report.problems.length; })(), r.stdout.slice(0, 1500) + r.stderr);
  r = cli(["listen", "--time", "2", "--input", "j@0.5, j@1.2", "--out", work], { MOCK_SOUNDS: "overlap" });
  ok("listen text: ✔ both swings, no 'nothing audible' contradiction", /✔ j pressed f72 → swing at \+1f/.test(r.stdout) && !/nothing audible/.test(r.stdout) && /swing ×2 +at 0\.50, 1\.20 s/.test(r.stdout), r.stdout + r.stderr);
  // the swing pressed at, 1 and 2 frames after quest_start's f66: it never takes quest_start's onset or description
  r = cli(["listen", "--time", "2", "--input", "j@1.1", "--out", work, "--json"], { MOCK_SOUNDS: "overlap" });
  ok("listen j@1.10 (same frame as quest_start): ✔ +1f, both share the onset, marked 'starts together'", (() => { const j = J(r); if (!j) return false; const s = j.data.report.sounds.find((x) => x.label === "swing"); return j.summary.matched === 1 && j.data.matches[0].offset === 1 && j.data.soundEvents.find((e) => e.label === "swing").together[0] === "quest_start" && /starts together with quest_start/.test(s.description); })(), r.stdout.slice(0, 1500) + r.stderr);
  r = cli(["listen", "--time", "2", "--input", "j@1.12", "--out", work, "--json"], { MOCK_SOUNDS: "overlap" });
  ok("listen j@1.12 (17 ms after quest_start): ⚠ too close for an onset of its own, not matched to quest_start at +0f, counted", (() => { const j = J(r); if (!j) return false; const sw = j.data.soundEvents.find((e) => e.label === "swing"); return j.summary.matched === 0 && j.summary.unheard === 1 && j.summary.eventIssues === 1 && j.data.matches[0].sound === "swing" && !sw.heard && sw.near.label === "quest_start" && !j.data.report.sounds.some((x) => x.label === "swing"); })(), r.stdout.slice(0, 1500) + r.stderr);
  r = cli(["listen", "--time", "2", "--input", "j@1.12"], { MOCK_SOUNDS: "overlap" });
  ok("listen text j@1.12: says why, and not 'No problems found'", /⚠ j pressed f67 → swing announced at \+1f, but no onset of its own: it starts 1\d ms after quest_start's/.test(r.stdout) && !/No problems found/.test(r.stdout) && /1 event above is ✖\/⚠/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["listen", "--time", "2", "--input", "j@1.13", "--out", work, "--json"], { MOCK_SOUNDS: "overlap" });
  ok("listen j@1.13 (33 ms after quest_start): ✔ swing +1f from its own onset, ~80 ms on its own bands, only quest_start without an event", (() => { const j = J(r); if (!j) return false; const s = j.data.report.sounds.find((x) => x.label === "swing"); return j.summary.matched === 1 && j.data.matches[0].sound === "swing" && j.data.matches[0].offset === 1 && j.data.soundEvents.every((e) => e.heard) && j.summary.unexplained === 1 && j.data.unexplained[0].sound === "quest_start" && s && s.analysis.length >= 0.07 && s.analysis.length <= 0.095 && !/C5|tonal \(/.test(s.description) && !j.data.report.problems.length; })(), r.stdout.slice(0, 1500) + r.stderr);
  r = cli(["listen", "--time", "2", "--input", "j@1.4, j@1.6", "--out", work, "--json"], { MOCK_SOUNDS: "overlap" });
  ok("listen j@1.4,1.6 under the chord: no 'double-triggered?' problem", (() => { const j = J(r); return j && j.summary.matched === 2 && !j.data.report.problems.some((p) => /second attack/.test(p.text)); })(), r.stdout.slice(0, 1500) + r.stderr);
  // ---- measure perf (MOCK_PERF: update 1 ms, a 25 ms particle burst at f90, memory +0.05 MB/frame)
  r = cli(["measure", "perf", "--time", "3", "--input", "right@0-3", "--json"], { MOCK_PERF: "1" });
  ok("measure perf: game update_ms p50 1, p95 1, max 25 at f90, one spike", (() => { const s = J(r)?.summary; return s && s.source === "game" && s.key === "update_ms" && s.frames === 180 && s.p50 === 1 && s.p95 === 1 && s.max === 25 && s.maxFrame === 90 && s.spikes === 1 && s.spikeFrames.join() === "90" && s.overBudget === 1 && s.deterministic === false; })(), r.stdout.slice(0, 1200) + r.stderr);
  ok("measure perf: memory 40.05 → 49 MB, +3 MB/s, flagged as growing", (() => { const s = J(r)?.summary; return s && s.memoryStartMB === 40.05 && s.memoryEndMB === 49 && s.memoryGrowthMBps === 3 && s.memoryGrows === true; })(), r.stdout.slice(0, 1200));
  ok("measure perf: the spike's state change (particles 0 → 200) and counts", (() => { const sp = J(r)?.data.spikes.find((x) => x.frame === 90); return sp && sp.wall >= 35 && sp.counts.includes("counts.particles 0 → 200") && sp.change.changes.some((c) => c.path === "state.particles" && c.a === 0 && c.b === 200); })(), r.stdout.slice(0, 2500));
  r = cli(["measure", "perf", "--time", "3", "--input", "right@0-3"], { MOCK_PERF: "1" });
  ok("measure perf text: spike line, leak warning, the determinism note", /f90 +25\.0 ms game \/ \d+(\.\d+)? ms wall · changed: state\.particles 0 → 200; counts\.particles 0 → 200/.test(r.stdout) && /grows steadily: a leak\?/.test(r.stdout) && /timing is not deterministic/.test(r.stdout), r.stdout + r.stderr);
  ok("measure perf text: the burst is f90 in both the spike line and the counts peak", /particles 0 → 0 \(peak 200 at f90\)/.test(r.stdout) && J(cli(["measure", "perf", "--time", "3", "--input", "right@0-3", "--json", "--no-state"], { MOCK_PERF: "1" }))?.data.counts.particles.peakFrame === 90, r.stdout);
  r = cli(["measure", "perf", "--time", "2f", "--json"], { MOCK_PERF: "1" });
  ok("measure perf --time 2f: memory on 2 frames (no trend) doesn't crash: 40.05 → 40.1", (() => { const s = J(r)?.summary; return r.status === 0 && s && s.frames === 2 && s.memoryStartMB === 40.05 && s.memoryEndMB === 40.1 && s.memoryGrowthMBps === null; })(), r.stdout.slice(0, 600) + r.stderr);
  r = cli(["measure", "perf", "--time", "1", "--json"]);
  ok("measure perf: a constant perf value falls back to wall time", (() => { const s = J(r)?.summary; return s && s.source === "wall" && s.frames === 60; })(), r.stdout.slice(0, 600) + r.stderr);
  r = cli(["measure", "perf", "--time", "3", "--expect", "max < 16.7"], { MOCK_PERF: "1" });
  ok("measure perf --expect: max < 16.7 fails on the 25 ms spike", r.status === 1 && /✖ expect max < 16\.7: got 25 < 16\.7/.test(r.stdout), r.stdout + r.stderr);

  // ---- shot --clip: an APNG of the motion; frame 1 is the plain screenshot, delays add up
  r = cli(["shot", "--clip", path.join(work, "clip.png"), "--from", "0", "--to", "0.5", "--every", "1/30", "--input", "down@0-1", "--json"]);
  const plain = cli(["shot", "--at", "0", "--out", path.join(work, "clip0.png")]);
  ok("shot --clip: 16 frames every 2f, decoded frame 1 = the plain shot, 32 frames of delay", (() => {
    const j = J(r); if (!j || plain.status !== 0) return false;
    const d = decodeAPNG(fs.readFileSync(path.join(work, "clip.png"))), p0 = decodePNG(fs.readFileSync(path.join(work, "clip0.png")));
    return j.summary.frames === 16 && j.summary.every === 2 && d.numFrames === j.summary.stored && d.frames.reduce((a, f) => a + f.delay[0], 0) === 32 && d.frames[0].delay[1] === 60 && Buffer.from(d.frames[0].image).equals(Buffer.from(p0.data)) && j.files[0].endsWith("clip.png");
  })(), r.stdout.slice(0, 600) + r.stderr);
  r = cli(["shot", "--clip", path.join(work, "clip7.png"), "--from", "0", "--to", "1", "--every", "7f", "--input", "right@0-1", "--json"]);
  ok("shot --clip: (to - from) not a multiple of --every: seconds = what the file plays (f0..f56 + 7f = 1.05 s)", (() => { const j = J(r); if (!j) return false; const d = decodeAPNG(fs.readFileSync(path.join(work, "clip7.png"))); const ms = d.frames.reduce((a, f) => a + f.delay[0] / f.delay[1], 0); return j.summary.seconds === 1.05 && Math.abs(ms - 1.05) < 1e-9 && j.summary.to === 56; })(), r.stdout.slice(0, 400) + r.stderr);
  r = cli(["shot", "--clip", path.join(work, "clip7.png"), "--from", "0", "--to", "1", "--every", "7f", "--input", "right@0-1", "--max-mb", "0.001", "--json"]);
  ok("shot --clip: after frames are dropped for size, seconds still = the file's delays", (() => { const j = J(r); if (!j) return false; const d = decodeAPNG(fs.readFileSync(path.join(work, "clip7.png"))); const ms = d.frames.reduce((a, f) => a + f.delay[0] / f.delay[1], 0); return j.summary.every > 7 && Math.abs(j.summary.seconds - +ms.toFixed(3)) < 1e-9; })(), r.stdout.slice(0, 400) + r.stderr);
  r = cli(["shot", "--clip", path.join(work, "clip.png"), "--from", "0", "--to", "0.5", "--speed", "0.5"]);
  ok("shot --clip text: playback time, and the hint to use --sheet", r.status === 0 && /plays 1\.03 s \(×0\.5 speed\)/.test(r.stdout) && /use --sheet/.test(r.stdout), r.stdout + r.stderr);

  // ---- measure anim (MOCK_ANIM: 4 poses × 6f, pose 2 held 12f at f36..f47)
  r = cli(["measure", "anim", "--of", "state.player.anim", "--time", "2", "--json"], { MOCK_ANIM: "1" });
  ok("measure anim --of: 4 poses, 6f, loop 24f, the 12f hold at f36", (() => { const j = J(r); return j && j.summary.poses === 4 && j.summary.framesPerPose === 6 && j.summary.period === 4 && j.summary.loopFrames === 24 && j.summary.irregular === 1 && j.data.irregular[0].start === 36 && j.data.irregular[0].len === 12 && j.data.irregular[0].label === 2; })(), r.stdout.slice(0, 800) + r.stderr);
  r = cli(["measure", "anim", "--of", "state.nope", "--time", "1"], { MOCK_ANIM: "1" });
  ok("measure anim --of a missing field: says the path is undefined (not 'never visible')", r.status === 1 && /--of state\.nope: undefined on every frame/.test(r.stderr) && /eval --keys/.test(r.stderr), r.stdout + r.stderr);
  r = cli(["measure", "anim", "--time", "2", "--input", "right@0-3", "--params", '{"nocoins":true}', "--json"], { MOCK_ANIM: "1" });
  ok("measure anim from pixels (tracked sprite): the same timing", (() => { const j = J(r); const a = j && j.data.objects[0] && j.data.objects[0].anim; return a && j.summary.poses === 4 && j.summary.framesPerPose === 6 && j.summary.loopFrames === 24 && a.irregular.length === 1 && a.irregular[0].start === 36 && a.irregular[0].len === 12; })(), r.stdout.slice(0, 800) + r.stderr);
  r = cli(["measure", "anim", "--follow", "state.player.pos", "--size", "20", "--time", "2", "--json"], { MOCK_ANIM: "1" });
  ok("measure anim --follow (sprite animating in place): the same timing", (() => { const j = J(r); return j && j.summary.poses === 4 && j.summary.framesPerPose === 6 && j.summary.loopFrames === 24 && j.data.irregular.length === 1 && j.data.irregular[0].start === 36; })(), r.stdout.slice(0, 800) + r.stderr);
  r = cli(["measure", "motion", "--at", "0", "--time", "0.5", "--input", "right@0-1", "--params", '{"nocoins":true}', "--json"]);
  ok("motion: a lone sprite on a plain background is not a camera scroll", (() => { const j = J(r); return j && j.data.camera && j.data.camera.moving === false && j.data.objects.length === 1 && j.data.objects[0].meanStep === 2; })(), r.stdout.slice(0, 600) + r.stderr);

  // ---- snapshot paths: trace asks only for the keys it reads; a broken filter is caught
  r = cli(["trace", "--watch", "state.player.pos[0], count('Coin')", "--input", "right@0-1", "--time", "1", "--no-chart"], { MOCK_PATHS: "log" });
  ok("paths: trace sends the filter (entities, player)", r.status === 0 && /snapshot paths: entities,player/.test(r.stdout) && /pos\[0\]: 40 → 160/.test(r.stdout), r.stdout + r.stderr);
  const good = cli(["trace", "--watch", "state.player.pos[0], count('Coin'), state.score", "--input", "right@0-1", "--time", "1", "--json"], { MOCK_PATHS: "ignore" });
  const broken = cli(["trace", "--watch", "state.player.pos[0], count('Coin'), state.score", "--input", "right@0-1", "--time", "1", "--json"], { MOCK_PATHS: "bad" });
  ok("paths: an adapter that drops filtered keys gives the same answers (filter turned off)", (() => { const a = J(good), b = J(broken); return a && b && JSON.stringify(a.data.series) === JSON.stringify(b.data.series); })(), broken.stdout.slice(0, 400) + broken.stderr);
}

// ---- replays checked against the recorded end state
fs.copyFileSync(path.join(here, "mock", "session.jsonl"), path.join(tmp, "s.jsonl"));
fs.writeFileSync(path.join(tmp, "s.jsonl.state.json"), JSON.stringify({ score: 0, scene: "level1", player: { id: 1, type: "Player", pos: [0, 0], hp: 3 } }));
r = cli(["replay", path.join(tmp, "s.jsonl")]);
ok("e2e replay end state mismatch reported", r.status === 1 && /end state differs/.test(r.stdout) && /state\.player\.pos\[0\]/.test(r.stdout), r.stdout + r.stderr);
r = cli(["trace", "--replay", path.join(tmp, "s.jsonl"), "--watch", "state", "--time", String(rp.duration), "--every", String(rp.duration), "--json"]);
try {
  const series = JSON.parse(r.stdout).data.series.state;
  fs.writeFileSync(path.join(tmp, "s.jsonl.state.json"), JSON.stringify(series[series.length - 1][1]));
  r = cli(["replay", path.join(tmp, "s.jsonl")]);
  ok("e2e replay end state match", r.status === 0 && /ended in exactly the recorded end state/.test(r.stdout), r.stdout + r.stderr);
  // window-dependent fields: left out with --ignore (or witness.json replay.ignore)
  const end = series[series.length - 1][1];
  fs.writeFileSync(path.join(tmp, "s.jsonl.state.json"), JSON.stringify({ ...end, view: { w: 1, h: 2 }, player: { ...end.player, pos: [-9, -9] } }));
  r = cli(["replay", path.join(tmp, "s.jsonl")]);
  const r2 = cli(["replay", path.join(tmp, "s.jsonl"), "--ignore", "view, player.pos"]);
  ok("e2e replay --ignore leaves paths out of the end-state check", r.status === 1 && /state\.view/.test(r.stdout) && r2.status === 0 && /ignoring view, player\.pos/.test(r2.stdout), r.stdout + r2.stdout + r2.stderr);
} catch (e) { ok("e2e replay end state match", false, `${e.message}\n${r.stdout}${r.stderr}`); }
// ---- clean: old playtests, recordings and screenshots are pruned; recent ones stay
{
  const proj = path.join(tmp, "cleanproj"), old = (p, days) => { const t = new Date(Date.now() - days * 864e5); fs.utimesSync(p, t, t); };
  fs.mkdirSync(path.join(proj, "witness", "shots"), { recursive: true });
  fs.mkdirSync(path.join(proj, "witness", "replays"), { recursive: true });
  fs.writeFileSync(path.join(proj, "witness.json"), JSON.stringify({ name: "c", launch: { command: "node", args: ["x.mjs"] }, retention: { playtests: { keep: 3 } } }));
  for (let i = 0; i < 6; i++) { const d = path.join(proj, "witness", "playtests", `p${i}`); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "replay.jsonl"), "x".repeat(100)); old(d, 2 + i * 0.1); }   // past the 24 h a fresh playtest always stays
  const stale = path.join(proj, "witness", "playtests", "stale"); fs.mkdirSync(stale); old(stale, 30);
  fs.writeFileSync(path.join(proj, "witness", "shots", "shot-old.png"), "x"); old(path.join(proj, "witness", "shots", "shot-old.png"), 5);
  fs.writeFileSync(path.join(proj, "witness", "shots", "shot-new.png"), "x");
  fs.writeFileSync(path.join(proj, "witness", "shots", "mine.png"), "x"); old(path.join(proj, "witness", "shots", "mine.png"), 50);   // not Witness's: kept
  fs.writeFileSync(path.join(proj, "witness", "replays", "a.jsonl"), "{}"); fs.writeFileSync(path.join(proj, "witness", "replays", "a.jsonl.state.json"), "{}");
  old(path.join(proj, "witness", "replays", "a.jsonl"), 20);
  const c1 = spawnSync(process.execPath, [path.join(root, "bin", "witness.js"), "clean"], { cwd: proj, encoding: "utf8", timeout: 30000 });
  const left = fs.readdirSync(path.join(proj, "witness", "playtests")).sort().join(",");
  ok("e2e clean prunes to retention (keep 3, drop stale, old shots and recordings with their end state)",
    c1.status === 0 && left === "p0,p1,p2" && !fs.existsSync(path.join(proj, "witness", "shots", "shot-old.png")) && fs.existsSync(path.join(proj, "witness", "shots", "shot-new.png")) && fs.existsSync(path.join(proj, "witness", "shots", "mine.png")) &&
    !fs.existsSync(path.join(proj, "witness", "replays", "a.jsonl")) && !fs.existsSync(path.join(proj, "witness", "replays", "a.jsonl.state.json")), left + "\n" + c1.stdout + c1.stderr);
  const c2 = spawnSync(process.execPath, [path.join(root, "bin", "witness.js"), "clean", "--all"], { cwd: proj, encoding: "utf8", timeout: 30000 });
  ok("e2e clean --all removes every generated file (and only those)", c2.status === 0 && fs.readdirSync(path.join(proj, "witness", "playtests")).length === 0 && fs.readdirSync(path.join(proj, "witness", "shots")).join(",") === "mine.png", c2.stdout + c2.stderr);
}
// ---- witness.json with a single-backslash Windows path
fs.mkdirSync(path.join(tmp, "cc"));
fs.writeFileSync(path.join(tmp, "cc", "witness.json"), '{ "build": "tools\\build.bat", "launch": { "command": "x" } }');
r = spawnSync(process.execPath, [path.join(root, "bin", "witness.js"), "doctor"], { cwd: path.join(tmp, "cc"), encoding: "utf8", timeout: 30000 });
ok("config control character refused", r.status !== 0 && /control character/.test(r.stdout + r.stderr) && /tools\\\\build\.bat/.test(r.stdout + r.stderr), r.stdout + r.stderr);
// ---- --config FILE: a second config (witness.web.json) beside witness.json
{
  const proj = path.join(tmp, "two"), W = path.join(root, "bin", "witness.js");
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, "witness.json"), JSON.stringify({ name: "desktop", launch: { command: "no-such-desktop-build" } }));
  fs.writeFileSync(path.join(proj, "witness.web.json"), JSON.stringify({ name: "web", launch: { command: process.execPath, args: [path.join(here, "mock-game.mjs")] }, play: {} }));
  const e = spawnSync(process.execPath, [W, "eval", "--at", "0.1", "frame", "--json", "--config", path.join(proj, "witness.web.json")], { cwd: tmp, encoding: "utf8", timeout: 60000 });
  let j = null; try { j = JSON.parse(e.stdout); } catch { /* shown below */ }
  ok("--config FILE loads that file (not the witness.json beside it)", e.status === 0 && j && j.ok, e.stdout + e.stderr);
  const b = spawnSync(process.execPath, [W, "play", "brief", "--config", path.join(proj, "witness.web.json")], { cwd: tmp, encoding: "utf8", timeout: 30000 });
  ok("play brief: the start line passes the config file on", b.status === 0 && b.stdout.includes(`--config "${path.join(proj, "witness.web.json").replace(/\\/g, "/")}"`), b.stdout + b.stderr);
  const b2 = spawnSync(process.execPath, [W, "play", "brief", "--config", proj], { cwd: tmp, encoding: "utf8", timeout: 30000 });
  ok("play brief: --config DIR still passes the folder", b2.status === 0 && b2.stdout.includes(`--config "${proj.replace(/\\/g, "/")}"`) && /"desktop"/.test(b2.stdout), b2.stdout + b2.stderr);
  const m = spawnSync(process.execPath, [W, "eval", "--at", "0.1", "frame", "--config", path.join(proj, "nope.json")], { cwd: tmp, encoding: "utf8", timeout: 30000 });
  ok("--config with a missing file: a clear error", m.status !== 0 && /--config .*nope\.json: no such file/.test(m.stdout + m.stderr), m.stdout + m.stderr);
}
fs.rmSync(tmp, { recursive: true, force: true });
if (ownBudget) delete process.env.WITNESS_BUDGET_DIR;   // web/play sub-suites: the machine-wide budget (and no stray <work>/budget)
fs.rmSync(work, { recursive: true, force: true });

// WITNESS_TEST_SKIP=play,web,python leaves those sub-suites out (they start browsers and daemons: one at a time)
const skip = new Set(String(process.env.WITNESS_TEST_SKIP || "").split(",").map((x) => x.trim()).filter(Boolean));

// core regressions (0.7.3 audit: process cleanup, budget, pruning, args, replays, transports)
{
  const m = spawnSync(process.execPath, [path.join(here, "core", "run.mjs")], { encoding: "utf8", timeout: 600000 });
  ok("core suite", m.status === 0, (m.stdout + m.stderr).slice(-2500));
  const counts = /(\d+) passed, (\d+) failed/.exec(m.stdout || "");
  if (counts) console.log(`  core: ${counts[0]}`);
}

// JS adapter regressions (one short-lived child game each): UTF-8 split across TCP chunks, OS-key aliases → "meta"
for (const t of ["utf8-split", "key-aliases"]) {
  const f = path.join(here, "js-adapter", `${t}.mjs`);
  if (!fs.existsSync(f)) continue;
  const m = spawnSync(process.execPath, [f], { encoding: "utf8", timeout: 60000 });
  ok(`js adapter ${t}`, m.status === 0, (m.stdout + m.stderr).slice(-1500));
}

// agent playtest harness (separate runners: unit tests without processes, process-safety guards (light processes and
// one mock game), then end-to-end CLI/daemon runs, then session budgets (--until, --game-hours, --wall-minutes) and
// play batch with a fake claude)
for (const suite of skip.has("play") ? [] : ["unit", "safety", "e2e", "budget"]) {
  const f = path.join(here, "play", `${suite}.mjs`);
  if (!fs.existsSync(f)) continue;
  const m = spawnSync(process.execPath, [f], { encoding: "utf8", timeout: 600000 });
  ok(`play ${suite} suite`, m.status === 0, (m.stdout + m.stderr).slice(-2500));
  const counts = /(\d+) passed, (\d+) failed/.exec(m.stdout || "");
  if (counts) console.log(`  play ${suite}: ${counts[0]}`);
}

// web / WASM: device profiles, audio unlock, the Emscripten bridge (browser parts skip without Playwright, the native
// bridge build without a C compiler)
if (!skip.has("web")) {
  const m = spawnSync(process.execPath, [path.join(here, "web", "run.mjs")], { encoding: "utf8", timeout: 1200000 });
  ok("web suite", m.status === 0, (m.stdout + m.stderr).slice(-2500));
  const counts = /(\d+) passed, (\d+) failed/.exec(m.stdout || "");
  if (counts) console.log(`  web: ${counts[0]}${/skipped/.test(m.stdout) ? ` (${(m.stdout.match(/^ {2}.*skipped.*$/gm) || []).map((l) => l.trim()).join("; ")})` : ""}`);
}

// Python adapter (standard library only): skipped when no Python is installed
{
  const f = path.join(here, "python", "test_idle.py");
  const py = ["python3", "python", "py"].find((p) => { const v = spawnSync(p, ["--version"], { encoding: "utf8", timeout: 15000 }); return v.status === 0 && /Python 3/.test(v.stdout + v.stderr); });
  if (skip.has("python")) console.log("  python adapter: skipped (WITNESS_TEST_SKIP)");
  else if (fs.existsSync(f) && py) {
    const m = spawnSync(py, [f], { encoding: "utf8", timeout: 120000 });
    ok("python adapter idle hook", m.status === 0, (m.stdout + m.stderr).slice(-1500));
    const counts = /(\d+) passed, (\d+) failed/.exec(m.stdout || "");
    if (counts) console.log(`  python adapter: ${counts[0]}`);
  } else if (fs.existsSync(f)) console.log("  python adapter: skipped (no Python 3 found)");
}

// media suites (separate runner)
if (fs.existsSync(path.join(here, "media", "run.mjs"))) {
  const m = spawnSync(process.execPath, [path.join(here, "media", "run.mjs")], { encoding: "utf8", timeout: 300000 });
  ok("media suites", m.status === 0, (m.stdout + m.stderr).slice(-1500));
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
