// Witness core tests: `node tests/run.mjs` (unit tests + end-to-end CLI runs against the mock game).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluate, check, splitComparison, keyPaths, rewriteTemporal, usesPrev, TimeContext } from "../src/core/expr.js";
import { describeState } from "../src/core/schema.js";
import { diffStates } from "../src/core/compare.js";
import { analyzeJump, analyzeMove, frozenSpans, response, lag, stutters, summarize } from "../src/core/signal.js";
import { matchSounds, alignSoundEvents, soundFrame } from "../src/core/soundmatch.js";
import { windowsOf } from "../src/cli/window.js";
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
ok("e2e eval json", r.status === 0 && JSON.parse(r.stdout)[0].values["state.score"] === 1, r.stdout + r.stderr);
r = cli(["call", "teleport", "50", "60"]);
ok("e2e call", r.status === 0 && /\[50,60\]/.test(r.stdout), r.stdout + r.stderr);
r = cli(["replay", path.join(here, "mock", "session.jsonl"), "--watch", "state.player.pos[0]"]);
ok("e2e replay", r.status === 0 && /pos\[0\] = 120\.4/.test(r.stdout), r.stdout + r.stderr);
// touch: finger 0 drives the mock's pointer like the mouse (drag-to-move), other fingers are counted
r = cli(["eval", "--at", "0.6", "--input", "swipe:40,90->100,90@0-0.5", "state.player.pos[0]", "state.score", "state.pointer.down", "--json"]);
ok("e2e swipe drags the player", r.status === 0 && (() => { const v = JSON.parse(r.stdout)[0].values; return Math.abs(v["state.player.pos[0]"] - 100) < 1e-6 && v["state.score"] === 1 && v["state.pointer.down"] === false; })(), r.stdout + r.stderr);
r = cli(["eval", "--at", "0.3,0.6", "--input", "touch:10,10@0-1, touch2:20,20@0.2-0.5", "state.touches", "--json"]);
ok("e2e multi-touch fingers", r.status === 0 && (() => { const j = JSON.parse(r.stdout); return j[0].values["state.touches"] === 2 && j[1].values["state.touches"] === 1; })(), r.stdout + r.stderr);
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
  const tj = J(r), series = tj && tj["state.player.pos[0]"];
  ok("trace --every 3f: frame-aligned samples, [t, value, frame] one per line", series && series.length === 11 && series.every((p, i) => p[2] === i * 3 && p[1] === 40 + 6 * i && Math.abs(p[0] - (i * 3) / 60) < 1e-9) && r.stdout.split("\n").filter((l) => /^ {2}\[/.test(l)).length === 11, r.stdout.slice(0, 300));
  r = cli(["trace", "--watch", "state.player.pos, state.score", "--time", "1", "--input", "right@0-1", "--events", "coin: changed(state.score)", "--out", path.join(work, "tr.png")]);
  ok("trace: vectors per axis, state events listed, chart written", r.status === 0 && /pos\.x: 40 → 160/.test(r.stdout) && /pos\.y: 90 \(constant/.test(r.stdout) && /events: coin @f15, coin @f37, coin @f55/.test(r.stdout) && fs.existsSync(path.join(work, "tr.png")), r.stdout + r.stderr);

  // eval: frames, prev, --keys, --summary, --when, --diff
  r = cli(["eval", "--at", "30f", "--input", "right@0-30f", "state.player.pos[0]", "state.player.pos[0] - prev.player.pos[0]", "--json"]);
  ok("eval: --at 30f with a frame-timed input, and prev", (() => { const j = J(r); return j && j[0].frame === 30 && j[0].values["state.player.pos[0]"] === 100 && j[0].values["state.player.pos[0] - prev.player.pos[0]"] === 2; })(), r.stdout + r.stderr);
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
  // shots: --json, diff regions (B11), crops, sheets, key frames
  const s1 = path.join(work, "a.png"), s2 = path.join(work, "b.png");
  cli(["shot", "--at", "0.5", "--out", s1, "--input", "right@0-1"]);
  r = cli(["shot", "--at", "0.5", "--out", s2, "--input", "right@0-1", "--seed", "2", "--diff", s1, "--json"]);
  ok("shot B11: --json envelope with the diff's regions", (() => { const j = J(r); const d = j?.data.shots[0].diff; return j && j.command === "shot" && d && d.regions.length === 5 && d.changedPixels === 552 && d.regions.every((b) => b.w > 0 && b.h > 0 && b.pixels > 0); })(), r.stdout + r.stderr);
  r = cli(["shot", "--at", "0.5", "--out", s2, "--input", "right@0-1", "--seed", "2", "--diff", s1]);
  ok("shot B11: regions printed in the text", /0\.958% changed \(552 px\) in 5 regions: 1: x=\d+ y=\d+ \d+×\d+ \(\d+ px\)/.test(r.stdout), r.stdout);
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
    ok(`listen (${mode === "1" ? "with" : "without"} sound events): press → +1f, the eaten press, land → +0f`, j && m["j pressed@60"]?.offset === 1 && m["j pressed@120"]?.sound === null && m["j pressed@150"]?.offset === 1 && m["land@216"]?.offset === 0 && m["space pressed@180"]?.sound === null && j.summary.missing === 2 && j.ok === false, r.stdout.slice(0, 600) + r.stderr);
    if (mode === "1") ok("listen: sounds named by the game", j && j.data.matches.find((x) => x.frame === 60)?.sound === "swing" && j.data.soundEvents.length === 3 && j.data.soundEvents.every((x) => x.heard));
  }
  // window: timing sweeps find the planted coyote time (5 frames) and jump buffer (4 frames) exactly
  r = cli(["window", "--input", "right@0-3, space@{t}", "--t", "40f..70f", "--expect", "state.player.jumps == 1", "--at", "{t}+2f", "--ref", "fell(state.player.grounded)", "--json"], { MOCK_JUMP: "1", MOCK_LEDGE: "1" });
  ok("window: coyote time = 5 frames after the ledge (+0f..+4f), one run per value", (() => { const j = J(r); return j && j.summary.runs === 31 && j.summary.windows.length === 1 && j.summary.ref === 55 && j.summary.relative[0][1] === 4 && j.summary.windows[0][0] === 40; })(), r.stdout.slice(0, 400) + r.stderr);
  r = cli(["window", "--input", "space@1, space@{t}", "--t", "80f..100f", "--expect", "state.player.jumps == 2", "--at", "120f", "--ref", "rose(state.player.grounded)"], { MOCK_JUMP: "1" });
  ok("window: jump buffer = 4 frames before the landing step", /passes at t = f91\.\.f100/.test(r.stdout) && /happened in step f95/.test(r.stdout) && /4 values before it \(from -4f/.test(r.stdout) && /fails at f80\.\.f90/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["listen", "--time", "4", "--input", "j@1, j@2, j@2.5", "--out", work], { MOCK_SOUNDS: "1" });
  ok("listen text: ✔/✖ lines and the cooldown hint", /✔ j pressed f60 +→ swing at \+1f/.test(r.stdout) && /✖ j pressed f120 +→ no sound within 6f \(the j press at f60 played swing/.test(r.stdout), r.stdout + r.stderr);
}

// ---- replays checked against the recorded end state
fs.copyFileSync(path.join(here, "mock", "session.jsonl"), path.join(tmp, "s.jsonl"));
fs.writeFileSync(path.join(tmp, "s.jsonl.state.json"), JSON.stringify({ score: 0, scene: "level1", player: { id: 1, type: "Player", pos: [0, 0], hp: 3 } }));
r = cli(["replay", path.join(tmp, "s.jsonl")]);
ok("e2e replay end state mismatch reported", r.status === 1 && /end state differs/.test(r.stdout) && /state\.player\.pos\[0\]/.test(r.stdout), r.stdout + r.stderr);
r = cli(["trace", "--replay", path.join(tmp, "s.jsonl"), "--watch", "state", "--time", String(rp.duration), "--every", String(rp.duration), "--json"]);
try {
  const series = JSON.parse(r.stdout).state;
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
  for (let i = 0; i < 6; i++) { const d = path.join(proj, "witness", "playtests", `p${i}`); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "replay.jsonl"), "x".repeat(100)); old(d, i * 0.1); }
  const stale = path.join(proj, "witness", "playtests", "stale"); fs.mkdirSync(stale); old(stale, 30);
  fs.writeFileSync(path.join(proj, "witness", "shots", "old.png"), "x"); old(path.join(proj, "witness", "shots", "old.png"), 5);
  fs.writeFileSync(path.join(proj, "witness", "shots", "new.png"), "x");
  fs.writeFileSync(path.join(proj, "witness", "replays", "a.jsonl"), "{}"); fs.writeFileSync(path.join(proj, "witness", "replays", "a.jsonl.state.json"), "{}");
  old(path.join(proj, "witness", "replays", "a.jsonl"), 20);
  const c1 = spawnSync(process.execPath, [path.join(root, "bin", "witness.js"), "clean"], { cwd: proj, encoding: "utf8", timeout: 30000 });
  const left = fs.readdirSync(path.join(proj, "witness", "playtests")).sort().join(",");
  ok("e2e clean prunes to retention (keep 3, drop stale, old shots and recordings with their end state)",
    c1.status === 0 && left === "p0,p1,p2" && !fs.existsSync(path.join(proj, "witness", "shots", "old.png")) && fs.existsSync(path.join(proj, "witness", "shots", "new.png")) &&
    !fs.existsSync(path.join(proj, "witness", "replays", "a.jsonl")) && !fs.existsSync(path.join(proj, "witness", "replays", "a.jsonl.state.json")), left + "\n" + c1.stdout + c1.stderr);
  const c2 = spawnSync(process.execPath, [path.join(root, "bin", "witness.js"), "clean", "--all"], { cwd: proj, encoding: "utf8", timeout: 30000 });
  ok("e2e clean --all removes every generated file", c2.status === 0 && fs.readdirSync(path.join(proj, "witness", "playtests")).length === 0 && fs.readdirSync(path.join(proj, "witness", "shots")).length === 0, c2.stdout + c2.stderr);
}
// ---- witness.json with a single-backslash Windows path
fs.mkdirSync(path.join(tmp, "cc"));
fs.writeFileSync(path.join(tmp, "cc", "witness.json"), '{ "build": "tools\\build.bat", "launch": { "command": "x" } }');
r = spawnSync(process.execPath, [path.join(root, "bin", "witness.js"), "doctor"], { cwd: path.join(tmp, "cc"), encoding: "utf8", timeout: 30000 });
ok("config control character refused", r.status !== 0 && /control character/.test(r.stdout + r.stderr) && /tools\\\\build\.bat/.test(r.stdout + r.stderr), r.stdout + r.stderr);
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(work, { recursive: true, force: true });

// agent playtest harness (separate runners: unit tests without processes, then end-to-end CLI/daemon runs)
for (const suite of ["unit", "e2e"]) {
  const f = path.join(here, "play", `${suite}.mjs`);
  if (!fs.existsSync(f)) continue;
  const m = spawnSync(process.execPath, [f], { encoding: "utf8", timeout: 600000 });
  ok(`play ${suite} suite`, m.status === 0, (m.stdout + m.stderr).slice(-2500));
  const counts = /(\d+) passed, (\d+) failed/.exec(m.stdout || "");
  if (counts) console.log(`  play ${suite}: ${counts[0]}`);
}

// Python adapter (standard library only): skipped when no Python is installed
{
  const f = path.join(here, "python", "test_idle.py");
  const py = ["python3", "python", "py"].find((p) => { const v = spawnSync(p, ["--version"], { encoding: "utf8", timeout: 15000 }); return v.status === 0 && /Python 3/.test(v.stdout + v.stderr); });
  if (fs.existsSync(f) && py) {
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
