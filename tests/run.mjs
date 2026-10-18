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
const cli = (args) => spawnSync(process.execPath, [path.join(root, "bin", "witness.js"), ...args, "--cmd", `"${process.execPath}" "${path.join(here, "mock-game.mjs")}"`], { encoding: "utf8", timeout: 120000 });
let r = cli(["doctor"]);
ok("e2e doctor all good", r.status === 0 && /all good/.test(r.stdout), r.stdout + r.stderr);
ok("e2e doctor deterministic", /deterministic/.test(r.stdout));
r = cli(["test", path.join(root, "examples", "coins.witness.json")]);
ok("e2e shared coins test passes on the mock", r.status === 0 && /5 passed, 0 failed/.test(r.stdout), r.stdout + r.stderr);
r = cli(["test", path.join(here, "mock", "coins.witness.json")]);
ok("e2e failing test fails with both sides", r.status === 1 && /got 0 == 99/.test(r.stdout), r.stdout);
r = cli(["eval", "--at", "0.6", "--input", "right@0-0.5", "state.score", "--json"]);
ok("e2e eval json", r.status === 0 && JSON.parse(r.stdout)[0].values["state.score"] === 1, r.stdout + r.stderr);
r = cli(["call", "teleport", "50", "60"]);
ok("e2e call", r.status === 0 && /\[50,60\]/.test(r.stdout), r.stdout + r.stderr);
r = cli(["replay", path.join(here, "mock", "session.jsonl"), "--watch", "state.player.pos[0]"]);
ok("e2e replay", r.status === 0 && /pos\[0\] = 120\.4/.test(r.stdout), r.stdout + r.stderr);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "witness-e2e-"));
if (fs.existsSync(path.join(root, "src", "media", "index.js"))) {
  r = cli(["shot", "--at", "0.5", "--out", path.join(tmp, "s.png")]);
  ok("e2e shot writes a png", r.status === 0 && fs.existsSync(path.join(tmp, "s.png")) && fs.readFileSync(path.join(tmp, "s.png")).slice(1, 4).toString() === "PNG", r.stdout + r.stderr);
  r = cli(["trace", "--watch", "state.player.pos[0], state.score", "--time", "1", "--input", "right@0-1", "--out", path.join(tmp, "t.png")]);
  ok("e2e trace chart", r.status === 0 && fs.existsSync(path.join(tmp, "t.png")) && /start 40/.test(r.stdout), r.stdout + r.stderr);
  r = cli(["listen", "--time", "1", "--input", "right@0-0.5", "--out", tmp]);
  ok("e2e listen hears the ding", r.status === 0 && fs.existsSync(path.join(tmp, "timeline.png")), r.stdout + r.stderr);
}
fs.rmSync(tmp, { recursive: true, force: true });

// media suites (separate runner)
if (fs.existsSync(path.join(here, "media", "run.mjs"))) {
  const m = spawnSync(process.execPath, [path.join(here, "media", "run.mjs")], { encoding: "utf8", timeout: 300000 });
  ok("media suites", m.status === 0, (m.stdout + m.stderr).slice(-1500));
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
