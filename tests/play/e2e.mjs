// Witness play: end-to-end tests through the real CLI and daemon (one game process at a time).
// Mock game session (+ recorded calls), a full scripted "fake agent" run of the arena, and a --no-map run.
// Every replay must reproduce its session's final state exactly, and every daemon/game must be gone afterwards.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { witness, playSession } from "./agent.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL", name, String(extra).slice(0, 3000)); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "witness-play-e2e-"));
const env = { WITNESS_PLAY_REGISTRY: path.join(tmp, "registry"), WITNESS_PLAY_MAX: "3" };
const pidAlive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const sessionJson = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
const report = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
const mockCmd = `node "${path.join(root, "tests", "mock-game.mjs").replace(/\\/g, "/")}"`;
const findDir = (base, name) => path.join(base, "witness", "playtests", name);

// ---- mock game: pickups, a parse error, a note, an allowed call; the replay (with its call) is exact
const mdir = path.join(tmp, "mock"); fs.mkdirSync(mdir);
let r = witness(["play", "start", "--name", "m", "--goal", "collect coins", "--allow-calls", "--cmd", mockCmd], { cwd: mdir, env });
ok("play start prints the first observation", r.code === 0 && /your goal: collect coins/.test(r.out) && /Coin#10/.test(r.out) && /orders:/.test(r.out), r.out);
r = witness(["play", "do", "pickup coin", "-s", "m"], { cwd: mdir, env });
ok("play do pickup", r.code === 0 && /✔ done: pickup coin — picked up Coin#10/.test(r.out) && /score 1/.test(r.out), r.out);
r = witness(["play", "do", "atack coin", "-s", "m"], { cwd: mdir, env });
ok("play do: bad order → exit 2 + did you mean", r.code === 2 && /did you mean "attack"/.test(r.out), r.out);
r = witness(["play", "do", "pick up all coins; call teleport 100 60", "-s", "m"], { cwd: mdir, env });
ok("play do chain + call", r.code === 0 && /picked up 4 items/.test(r.out) && /called teleport/.test(r.out), r.out);
r = witness(["play", "note", "coins all look the same", "--confusing", "-s", "m"], { cwd: mdir, env });
ok("play note", r.code === 0 && /noted \(confusing\)/.test(r.out), r.out);
r = witness(["play", "look", "-s", "m", "--json"], { cwd: mdir, env });
let lookJson = null; try { lookJson = JSON.parse(r.out); } catch { /* reported below */ }
ok("play look --json", lookJson && lookJson.player && lookJson.player.pos[0] === 100 && lookJson.stats.score === 5, r.out);
const mockDir = findDir(mdir, "m");
const mockPid = sessionJson(mockDir).pid;
r = witness(["play", "end", "-s", "m", "--fun", "3", "--difficulty", "1", "--feedback", "easy"], { cwd: mdir, env });
ok("play end summary", r.code === 0 && /ENDED after/.test(r.out) && /report:/.test(r.out), r.out);
let rep = report(mockDir);
ok("report.json contents", rep.status === "finished" && rep.stats.pickups === 5 && rep.stats.parseErrors === 1 && rep.notes.length === 1 && rep.feedback.fun === 3 && rep.replay.calls === 1, JSON.stringify(rep.stats));
ok("report.md written", /Playtest m: Mock Coins/.test(fs.readFileSync(path.join(mockDir, "report.md"), "utf8")));
const rl = fs.readFileSync(path.join(mockDir, "replay.jsonl"), "utf8");
ok("replay records the call", /"calls":\[\["teleport",100,60\]\]/.test(rl), rl.slice(0, 500));
r = witness(["replay", path.join(mockDir, "replay.jsonl"), "--cmd", mockCmd], { cwd: mdir, env });
ok("mock replay (with a call) ends in exactly the recorded state", r.code === 0 && /ended in exactly the recorded end state/.test(r.out), r.out);
ok("mock daemon exited", !pidAlive(mockPid));
r = witness(["play", "do", "wait 1", "-s", "m"], { cwd: mdir, env });
ok("orders to an ended session explain themselves", r.code === 1 && /isn't running/.test(r.out), r.out);

// ---- arena: a scripted fake agent plays the whole game through the CLI
const arena = path.join(root, "examples", "arena");
const adir = path.join(tmp, "arena-out");
const run = playSession({
  dir: arena, name: "fake", env, startArgs: ["--goal", "escape the arena", "--out", adir, "--persona", "newbie"],
  orders: ["talk guard", "choose 1", "choose 1", "goto Wolf", "fight wolves block", "pickup key", "goto gate", "interact gate", "goto exit"],
  endArgs: ["--fun", "4", "--difficulty", "2", "--feedback", "scripted run"],
});
ok("arena fake agent: start", run.start.code === 0, run.start.out);
ok("arena fake agent: every order ran", run.steps.every((s) => s.code === 0), run.steps.map((s) => `${s.order}: ${s.code}\n${s.out.split("\n").slice(0, 3).join("\n")}`).join("\n"));
const last = run.steps.at(-1) || { out: "" };
ok("arena fake agent: reaches the exit", /GOAL REACHED/.test(last.out), last.out);
const fakeDir = path.join(adir, "fake");
rep = report(fakeDir);
ok("arena report: won, fights won, dialogues, kills", rep.outcome === "won" && rep.stats.fightsWon >= 2 && rep.dialogues.length >= 2 && rep.stats.kills === 4 && rep.stats.deaths === 0, JSON.stringify({ outcome: rep.outcome, stats: rep.stats }));
ok("arena report: telegraphs tracked", rep.telegraphs.windups >= 1 && rep.telegraphs.avoided >= 1, JSON.stringify(rep.telegraphs));
ok("arena report: coverage against the map", rep.coverage.openCells > 200 && rep.coverage.percent > 20, JSON.stringify(rep.coverage));
ok("arena report: key-moment shots + coverage.png", rep.shots.some((s) => s.why === "goal reached") && fs.existsSync(path.join(fakeDir, "coverage.png")));
r = witness(["replay", path.join(fakeDir, "replay.jsonl")], { cwd: arena, env });
ok("arena replay ends in exactly the recorded state", r.code === 0 && /ended in exactly the recorded end state/.test(r.out), r.out.split("\n").slice(-6).join("\n"));
ok("arena daemon exited", !pidAlive(sessionJson(fakeDir).pid) && !pidAlive(sessionJson(fakeDir).gamePid));

// ---- arena without the map: walls are learned by bumping into them, and the maze still gets solved
const nm = playSession({ dir: arena, name: "nomap", env, startArgs: ["--no-map", "--out", adir], orders: ["goto Wolf#3"] });
const nmOut = (nm.steps[0] || { out: "" }).out;
ok("no-map: reaches the courtyard through the maze", nm.start.code === 0 && /(✔ done: goto Wolf#3 — (arrived|Wolf#3 is gone)|⚠ interrupted: goto Wolf#3)/.test(nmOut), nmOut);
ok("no-map: walls were learned", /#/.test(nmOut.split("map (")[1] || ""), nmOut);

// ---- live mode (mock): the game runs while the client is silent; do answers at the horizon; auto-pause; exact replay
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const tOf = (out) => { const m = /\[t (\d+(?:\.\d+)?)s/.exec(out || ""); return m ? +m[1] : NaN; };
const ldir = path.join(tmp, "live"); fs.mkdirSync(ldir);
const lw = (args) => witness(args, { cwd: ldir, env });
r = lw(["play", "start", "--name", "lv", "--live", "--pause-after", "3", "--horizon", "1.5", "--cmd", mockCmd]);
ok("live: start says LIVE", r.code === 0 && /· LIVE\]/.test(r.out), r.out);
const lt0 = tOf(r.out);
sleepMs(1200);
r = lw(["play", "look", "-s", "lv"]);
const lt1 = tOf(r.out);
ok("live: game time advances while the client is silent", lt1 - lt0 >= 0.6, `${lt0} → ${lt1}\n${r.out}`);
r = lw(["play", "do", "wait 20", "-s", "lv"]);
const lt2 = tOf(r.out);
ok("live do: answers at the horizon while the order keeps running", r.code === 0 && /⏩ running: .*still running/.test(r.out) && /your order \(still running\): wait/.test(r.out) && lt2 - lt1 >= 1.4, r.out);
sleepMs(800);
r = lw(["play", "look", "-s", "lv"]);
ok("live: play went on after do returned", tOf(r.out) - lt2 >= 0.4 && /your order \(still running\)/.test(r.out), r.out);
r = lw(["play", "next", "-s", "lv"]);
ok("live next: waits for the horizon, plan unchanged", /⏩ running/.test(r.out) && /your order \(still running\): wait/.test(r.out), r.out);
r = lw(["play", "do", "wait  20", "-s", "lv"]);
ok("live do: the same order again keeps the running one going", /same order as the one running, so it carried on/.test(r.out) && /your order \(still running\): wait/.test(r.out), r.out);
r = lw(["play", "do", "wait 0.5", "-s", "lv"]);
ok("live do: a short order answers done (and replaces the long one)", /✔ done: wait 0\.5/.test(r.out) && /no order running: standing by/.test(r.out), r.out);
sleepMs(4500);
r = lw(["play", "look", "-s", "lv"]);
ok("live: auto-pause after the silence", /PAUSED: no orders for 3s/.test(r.out), r.out);
const ltp = tOf(r.out);
sleepMs(700);
r = lw(["play", "look", "-s", "lv"]);
ok("live: a paused game's time stands still", tOf(r.out) === ltp, `${ltp} → ${tOf(r.out)}`);
r = lw(["play", "do", "pickup coin", "-s", "lv"]);
ok("live: an order resumes the game", /· LIVE\]/.test(r.out) && /(✔ done: pickup coin|⏩ running)/.test(r.out), r.out);
const liveDir = findDir(ldir, "lv");
r = lw(["play", "end", "-s", "lv"]);
ok("live: end", r.code === 0 && /ENDED after/.test(r.out), r.out);
const lrep = report(liveDir);
ok("live: report has pace stats (live, orders, no freezes before the pause)", lrep.pace && lrep.pace.mode === "live" && lrep.pace.orders === 3 && lrep.pace.freezes === 1, JSON.stringify(lrep.pace));
const lorders = lrep.orders.map((o) => o.status).join(",");
ok("live: the replaced order is marked replaced", /^replaced,done,/.test(lorders), lorders);
r = lw(["replay", path.join(liveDir, "replay.jsonl"), "--cmd", mockCmd]);
ok("live: the replay ends in exactly the recorded state", r.code === 0 && /ended in exactly the recorded end state/.test(r.out), r.out.split("\n").slice(-6).join("\n"));
ok("live: daemon and game exited", !pidAlive(sessionJson(liveDir).pid) && !pidAlive(sessionJson(liveDir).gamePid));

// ---- live mode (arena): a goto runs across several check-ins, autofight deals with wolves on the way, exact replay
r = witness(["play", "start", "--name", "alive", "--live", "--speed", "3", "--out", adir], { cwd: arena, env });
ok("live arena: start", r.code === 0 && /· LIVE\]/.test(r.out), r.out);
r = witness(["play", "do", "goto Wolf#3", "-s", "alive"], { cwd: arena, env });
let liveOut = r.out;
for (let i = 0; i < 12 && /⏩ running|⚠/.test(liveOut) && !/✔|✖/.test(liveOut.split("\n").slice(0, 3).join("\n")); i++) liveOut = witness(["play", "next", "-s", "alive"], { cwd: arena, env }).out;
ok("live arena: the goto finishes across check-ins", /✔ done: (goto Wolf#3 — )?(arrived|Wolf#3 is gone)/.test(liveOut) || /✔ your order "goto Wolf#3" finished/.test(liveOut), liveOut);
const aliveDir = path.join(adir, "alive");
r = witness(["play", "end", "-s", "alive"], { cwd: arena, env });
const arep = report(aliveDir);
ok("live arena: autofight engaged and resumed the goto", (arep.timeline || []).some((e) => /fighting it, then back to goto Wolf#3/.test(e.text)) || arep.stats.kills > 0, JSON.stringify((arep.timeline || []).filter((e) => /autofight|fighting|back to/.test(e.text)).slice(0, 6)));
r = witness(["replay", path.join(aliveDir, "replay.jsonl")], { cwd: arena, env });
ok("live arena: the replay ends in exactly the recorded state", r.code === 0 && /ended in exactly the recorded end state/.test(r.out), r.out.split("\n").slice(-6).join("\n"));

// ---- the process cap and cleanup
const regFiles = fs.existsSync(env.WITNESS_PLAY_REGISTRY) ? fs.readdirSync(env.WITNESS_PLAY_REGISTRY).filter((f) => f.endsWith(".json")) : [];
// an ended daemon can take a few seconds to exit on a busy Windows runner: give it up to 10 s
let live = regFiles.map((f) => JSON.parse(fs.readFileSync(path.join(env.WITNESS_PLAY_REGISTRY, f), "utf8"))).filter((e) => pidAlive(e.pid));
for (let i = 0; i < 20 && live.length; i++) { await new Promise((res) => setTimeout(res, 500)); live = live.filter((e) => pidAlive(e.pid)); }
ok("no session daemons left running", live.length === 0, JSON.stringify(live));
r = witness(["play", "list"], { cwd: tmp, env });
ok("play list shows ended sessions", /○ fake\s+ended/.test(r.out) && /○ m\s+ended/.test(r.out), r.out);

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });   // Windows: a just-exited daemon can hold its log for a moment
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
