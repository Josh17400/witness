// Witness core tests: `node tests/run.mjs` (unit tests + end-to-end CLI runs against the mock game).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluate, check, splitComparison, keyPaths } from "../src/core/expr.js";
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
const cli = (args, env = {}) => spawnSync(process.execPath, [path.join(root, "bin", "witness.js"), ...args, "--cmd", `"${process.execPath}" "${path.join(here, "mock-game.mjs")}"`], { encoding: "utf8", timeout: 120000, env: { ...process.env, ...env } });
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
  ok("e2e trace chart", r.status === 0 && fs.existsSync(path.join(tmp, "t.png")) && /start 40/.test(r.stdout), r.stdout + r.stderr);
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
    const mo = JSON.parse(r.stdout);
    // background "first": frame 0 holds the player, so the mask is old+new position; its leading edge is exact
    ok("e2e measure motion: the player's leading edge moves 2 px a frame", mo.frames.length === 7 && mo.frames.slice(2).every((f, i) => f.lowestRowSpan.x1 - mo.frames[i + 1].lowestRowSpan.x1 === 2), r.stdout.slice(0, 400));
  } catch (e) { ok("e2e measure motion", false, `${e.message}
${r.stdout}${r.stderr}`); }
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
