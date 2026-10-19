// Witness play: session budgets and batch runs, end to end (one game process at a time).
//   --until "<expr>", --game-hours N with play.clock / --clock, --wall-minutes, and `play batch` with a fake claude
//   that runs the brief's own commands through sh (permission-blocked testers are reported and retried once).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { witness } from "./agent.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL", name, String(extra).slice(0, 3000)); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "witness-play-budget-"));
const env = { WITNESS_PLAY_REGISTRY: path.join(tmp, "registry"), WITNESS_PLAY_MAX: "3" };
const pidAlive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const report = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
const mockJs = path.join(root, "tests", "mock-game.mjs");
const arenaJs = path.join(root, "examples", "arena", "game.mjs");

// a project for each game: witness.json launching it by absolute path (arena: with its play config and a clock)
const arenaCfg = JSON.parse(fs.readFileSync(path.join(root, "examples", "arena", "witness.json"), "utf8"));
const proj = (name, cfg) => { const d = path.join(tmp, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, "witness.json"), JSON.stringify(cfg)); return d; };
const arena = proj("arena", { ...arenaCfg, launch: { command: process.execPath, args: [arenaJs] }, play: { ...arenaCfg.play, clock: "state.time / 10" } });   // 1 in-game hour = 10 s
const arenaNoClock = proj("arena-noclock", { ...arenaCfg, launch: { command: process.execPath, args: [arenaJs] } });
const mock = proj("mock", { name: "Mock Coins", launch: { command: process.execPath, args: [mockJs] } });
const w = (dir, args) => witness(args, { cwd: dir, env });
const dirOf = (d, name) => path.join(d, "witness", "playtests", name);

// ---- --game-hours with play.clock: the header shows the clock and what's left; the order stops when it's reached;
//      further orders are refused; END records outcome "until reached"; the replay is exact
let r = w(arena, ["play", "start", "--name", "gh", "--game-hours", "0.5"]);
ok("game-hours: start shows the clock line", r.code === 0 && /⏲ clock 0h · 30m of in-game time to go \(until clock 0\.5h\)/.test(r.out), r.out);
r = w(arena, ["play", "do", "wait 3", "-s", "gh"]);
ok("game-hours: the clock advances with game time", /⏲ clock 0\.3h \(\+18m since the start\) · 12m of in-game time to go/.test(r.out), r.out);
r = w(arena, ["play", "do", "wait 10", "-s", "gh"]);
ok("game-hours: the order stops when the clock is reached", /★ UNTIL REACHED: (wait 10 — )?the game clock reached 0\.5h \(30m of in-game time\): the playtest is over, run END now/.test(r.out) && /⏲ .*UNTIL REACHED/.test(r.out), r.out);
const tReached = +(/\[t (\d+\.\d)s/.exec(r.out) || [])[1];
ok("game-hours: stopped at 5 s of game time (not after the whole wait 10)", tReached >= 5 && tReached < 5.3, tReached);
r = w(arena, ["play", "do", "explore", "-s", "gh"]);
ok("game-hours: orders after it are refused (no game time passes)", /★ UNTIL REACHED: no more orders/.test(r.out) && +(/\[t (\d+\.\d)s/.exec(r.out) || [])[1] === tReached, r.out);
r = w(arena, ["play", "end", "-s", "gh", "--fun", "3"]);
ok("game-hours: END → outcome until reached", r.code === 0 && /UNTIL REACHED after/.test(r.out), r.out);
let rep = report(dirOf(arena, "gh"));
ok("game-hours: report.json until{reached, at}", rep.outcome === "until reached" && rep.until.reached && rep.until.gameHours === 0.5 && Math.abs(rep.until.target - 0.5) < 0.01 && rep.until.at.t >= 5, JSON.stringify(rep.until));
const md = fs.readFileSync(path.join(dirOf(arena, "gh"), "report.md"), "utf8");
ok("game-hours: report.md headline and until line", /— UNTIL REACHED/.test(md) && /Played until: 0\.5h of in-game time \(clock 0h → 0\.5h\) · \*\*reached\*\*/.test(md), md.slice(0, 800));
r = w(arena, ["replay", path.join(dirOf(arena, "gh"), "replay.jsonl")]);
ok("game-hours: the replay ends in exactly the recorded state", r.code === 0 && /ended in exactly the recorded end state/.test(r.out), r.out.split("\n").slice(-4).join("\n"));

// ---- --game-hours without a clock: a clear error before anything launches; --clock supplies one
r = w(arenaNoClock, ["play", "start", "--name", "nc", "--game-hours", "2"]);
ok("game-hours without play.clock: a clear error", r.code === 1 && /--game-hours needs play\.clock in witness\.json/.test(r.out) && !fs.existsSync(dirOf(arenaNoClock, "nc")), r.out);
r = w(arenaNoClock, ["play", "start", "--name", "bad", "--until", "state.nope.hour >= 3"]);
ok("until: a bad expression fails the start with the reason", r.code === 1 && /--until "state\.nope\.hour >= 3": .*missing/.test(r.out), r.out);
r = w(arenaNoClock, ["play", "brief", "--game-hours", "4"]);
ok("brief --game-hours without play.clock: the same error", r.code === 1 && /needs play\.clock/.test(r.out), r.out);
r = w(arena, ["play", "brief", "--game-hours", "4", "--wall-minutes", "15", "--name", "t9"]);
ok("brief --game-hours: start line, budget in in-game hours, hard wall stop", r.code === 0 && /--game-hours 4 --wall-minutes 15/.test(r.out) && /BUDGET: play until 4h of in-game time have passed/.test(r.out) && /after 15 real \(wall-clock\) minutes/.test(r.out), r.out.slice(0, 1500));

// ---- --until on the state, turn-based (mock): stops mid-chain the moment it's true
r = w(mock, ["play", "start", "--name", "un", "--until", "state.score >= 2"]);
ok("until: start shows the condition", r.code === 0 && /⏲ playing until: state\.score >= 2 \(not yet\)/.test(r.out), r.out);
r = w(mock, ["play", "do", "pick up all coins", "-s", "un"]);
ok("until: the chain stops at score 2", /★ UNTIL REACHED: (pick up all coins — )?state\.score >= 2 is true/.test(r.out) && /score 2\b/.test(r.out), r.out);
w(mock, ["play", "end", "-s", "un"]);
rep = report(dirOf(mock, "un"));
ok("until: outcome until reached, pickups 2", rep.outcome === "until reached" && rep.stats.pickups === 2, JSON.stringify({ o: rep.outcome, s: rep.stats.pickups }));

// ---- --until in live mode: the waiting order answers, the game pauses for END
r = w(mock, ["play", "start", "--name", "ul", "--live", "--until", "time >= 1.5"]);
r = w(mock, ["play", "do", "wait 20", "-s", "ul"]);
let lo = r.out;
for (let i = 0; i < 6 && !/UNTIL REACHED/.test(lo); i++) lo = w(mock, ["play", "next", "-s", "ul"]).out;
ok("until live: the order answers UNTIL REACHED and the game pauses", /★ UNTIL REACHED: (wait 20 — )?time >= 1\.5 is true/.test(lo) && !/still running/.test(lo), lo);
r = w(mock, ["play", "look", "-s", "ul"]);
ok("until live: paused for END", /PAUSED: .*reached: run END/.test(r.out), r.out);
w(mock, ["play", "end", "-s", "ul"]);
ok("until live: outcome", report(dirOf(mock, "ul")).outcome === "until reached");

// ---- --wall-minutes: a hard real-time stop (outcome timeout); --minutes on start is its old name
r = w(mock, ["play", "start", "--name", "wm", "--wall-minutes", "0.08"]);
const wmPid = JSON.parse(fs.readFileSync(path.join(dirOf(mock, "wm"), "session.json"), "utf8")).pid;
for (let i = 0; i < 40 && pidAlive(wmPid); i++) await new Promise((res) => setTimeout(res, 500));
rep = report(dirOf(mock, "wm"));
ok("wall-minutes: the session ends itself after ~5 s (outcome timeout)", !pidAlive(wmPid) && rep.outcome === "timeout" && rep.wallSeconds <= 12, JSON.stringify({ o: rep.outcome, w: rep.wallSeconds }));

// ---- play batch with a fake claude that runs the brief's commands through sh
const hasSh = spawnSync("sh", ["-c", "echo ok"], { encoding: "utf8", windowsHide: true }).stdout?.trim() === "ok";
if (!hasSh) console.log("  batch with a fake tester: skipped (no sh)");
else {
  fs.writeFileSync(path.join(mock, "goals.json"), JSON.stringify([{ goal: "collect a coin block-once", name: "fb1" }, { goal: "collect a coin block-always", name: "fb2" }]));
  const b = spawnSync(process.execPath, [path.join(root, "bin", "witness.js"), "play", "batch", "--goals", "goals.json", "--parallel", "1", "--wall-minutes", "2"], { cwd: mock, encoding: "utf8", timeout: 300000, env: { ...process.env, ...env, WITNESS_CLAUDE: path.join(here, "fake-claude.mjs") } });
  const bo = (b.stdout || "") + (b.stderr || "");
  ok("batch: a blocked tester is reported with the denied command and retried once", /#1 fb1: blocked: permission denied \(cd ".*" && \.\/fb1 "goto Coin"\), 0 orders; retrying once with the exact allowed command/.test(bo), bo);
  ok("batch: the retry played through the brief's own short command (absolute path, no cd)", /#1 fb1: ENDED · [\d.]+s game · 1 orders .*retried after: blocked: permission denied/.test(bo), bo);
  ok("batch: blocked twice → a distinct outcome", /#2 fb2: BLOCKED: permission denied \(cd .*\) · 0 orders · also blocked on the retry/.test(bo), bo);
  const bmd = fs.readdirSync(dirOf(mock, "").replace(/[\\/]$/, "")).find((f) => /^batch-.*\.md$/.test(f));
  const bm = bmd ? fs.readFileSync(path.join(dirOf(mock, ""), bmd), "utf8") : "";
  ok("batch md: the blocked row and the retry note", /\| 2 \| collect a coin block-always \| newbie \| blocked: permission denied \(cd /.test(bm) && /\| 1 \| .* \| ended \(after a retry\) \|/.test(bm) && /retried once with the exact allowed command, which worked/.test(bm), bm);
  ok("batch: the blocked attempt's empty session folder was removed", fs.readdirSync(path.join(mock, "witness", "playtests")).filter((f) => f.startsWith("fb1")).length === 1, fs.readdirSync(path.join(mock, "witness", "playtests")).join(","));
  ok("batch: the header names the units", /about 3 game minutes \(hard stop after 2 wall min\) each, tester timeout 5 wall min/.test(bo), bo.split("\n")[0]);
}

// ---- nothing left running
const regDir = env.WITNESS_PLAY_REGISTRY;
let live = (fs.existsSync(regDir) ? fs.readdirSync(regDir).filter((f) => f.endsWith(".json")) : []).map((f) => JSON.parse(fs.readFileSync(path.join(regDir, f), "utf8"))).filter((e) => pidAlive(e.pid));
for (let i = 0; i < 20 && live.length; i++) { await new Promise((res) => setTimeout(res, 500)); live = live.filter((e) => pidAlive(e.pid)); }
ok("no session daemons left running", live.length === 0, JSON.stringify(live));
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
