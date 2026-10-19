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

// ---- play.clock in witness.json that can't be read at the start (an RPG's title screen has no day/hour): a plain
//      session still starts; --game-hours anchors at the first reading
const arenaDayClock = proj("arena-dayclock", { ...arenaCfg, launch: { command: process.execPath, args: [arenaJs] }, play: { ...arenaCfg.play, clock: "state.day*24 + state.hour" } });
r = w(arenaDayClock, ["play", "start", "--name", "c1"]);
ok("play.clock unreadable at the start: a plain session starts anyway (no clock line)", r.code === 0 && !/didn't start/.test(r.out) && !/⏲/.test(r.out), r.out);
w(arenaDayClock, ["play", "stop", "-s", "c1"]);
r = w(arenaDayClock, ["play", "start", "--name", "c2", "--game-hours", "1"]);
ok("--game-hours with an unreadable clock: starts and says it isn't readable yet", r.code === 0 && /⏲ .*not readable yet/.test(r.out), r.out);
w(arenaDayClock, ["play", "stop", "-s", "c2"]);
// ---- a clock that goes backwards (wraps): the ⏲ line warns instead of counting down forever
r = w(arenaNoClock, ["play", "start", "--name", "wr", "--clock", "((state.time+2.5)/10) % 0.3", "--game-hours", "0.1"]);
r = w(arenaNoClock, ["play", "do", "wait 6", "-s", "wr"]);
ok("a wrapping clock: the ⏲ line warns that it went backwards", /⏲ .*went backwards.*include the day/.test(r.out), r.out);
w(arenaNoClock, ["play", "end", "-s", "wr"]);
ok("a wrapping clock: report.json until.warning", /went backwards/.test((report(dirOf(arenaNoClock, "wr")).until || {}).warning || ""), JSON.stringify(report(dirOf(arenaNoClock, "wr")).until));

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

// ---- how a session ends while an order runs (Embervale's long batch on 0.7.1)
const wE = (dir, args, extra) => witness(args, { cwd: dir, env: { ...env, ...extra } });
const daemonGone = async (name, dir) => { const pid = JSON.parse(fs.readFileSync(path.join(dirOf(dir, name), "session.json"), "utf8")).pid; for (let i = 0; i < 30 && pidAlive(pid); i++) await new Promise((res) => setTimeout(res, 300)); return !pidAlive(pid); };
{
  // (a) the wall cap hits mid-order: the order stops cleanly and says why (it said "the game disconnected" while the
  // game was fine); END afterwards is still taken and its feedback lands in report.md/json
  const slow = { MOCK_STEP_MS: "25" };   // 1 game second takes 1.5 s
  r = wE(mock, ["play", "start", "--name", "tl", "--wall-minutes", "0.06"], slow);
  r = wE(mock, ["play", "do", "wait 600", "-s", "tl"], slow);
  ok("time limit mid-order: the order says the session time limit was reached", /session time limit reached \(max 0\.06 min\)/.test(r.out) && !/disconnected|crashed/.test(r.out), r.out);
  ok("time limit mid-order: the daemon exits", await daemonGone("tl", mock));
  r = wE(mock, ["play", "end", "-s", "tl", "--fun", "4", "--feedback", "late words"], slow);
  rep = report(dirOf(mock, "tl"));
  ok("time limit: END after the session closed is accepted", r.code === 0 && /feedback (was )?added/.test(r.out), r.out);
  ok("time limit: the feedback is in report.json and report.md, the outcome stays timeout", rep.outcome === "timeout" && rep.feedback && rep.feedback.text === "late words" && rep.feedback.fun === 4 && /late words/.test(fs.readFileSync(path.join(dirOf(mock, "tl"), "report.md"), "utf8")), JSON.stringify({ o: rep.outcome, f: rep.feedback, e: rep.endReason }));
  ok("time limit: endReason names the cap", /session time limit reached \(max 0\.06 min\)/.test(rep.endReason || ""), rep.endReason);
  r = wE(mock, ["replay", path.join(dirOf(mock, "tl"), "replay.jsonl")]);
  ok("time limit: the replay ends in exactly the recorded state", r.code === 0 && /ended in exactly the recorded end state/.test(r.out), r.out.split("\n").slice(-4).join("\n"));

  // live: the waiting order is told the same
  r = wE(mock, ["play", "start", "--name", "tll", "--live", "--wall-minutes", "0.05"]);
  r = wE(mock, ["play", "do", "wait 600", "--for", "60", "-s", "tll"]);
  ok("time limit, live: the waiting order says the session time limit was reached", /session time limit reached \(max 0\.05 min\)/.test(r.out) && !/disconnected|crashed/.test(r.out), r.out);
  ok("time limit, live: the daemon exits", await daemonGone("tll", mock));

  // (b) the game really exits mid-order: said with its exit code, the time, and its last output
  r = wE(mock, ["play", "start", "--name", "ex"], { MOCK_EXIT_AT: "30" });
  r = wE(mock, ["play", "do", "wait 5", "-s", "ex"], { MOCK_EXIT_AT: "30" });
  ok("game exit: 'game exited (code 3) at t=0.5s' with its last output", /game exited \(code 3\) at t=0\.5s/.test(r.out) && /out of cheese/.test(r.out), r.out);
  ok("game exit: the daemon exits", await daemonGone("ex", mock));
  rep = report(dirOf(mock, "ex"));
  ok("game exit: outcome crashed, endReason with the code", rep.outcome === "crashed" && /game exited \(code 3\) at t=0\.5s/.test(rep.endReason || ""), JSON.stringify({ o: rep.outcome, e: rep.endReason }));

  // (c) the game hangs: "not responding since t=…" instead of a TIMEOUT at the wall cap
  const hang = { MOCK_HANG_AT: "30", WITNESS_PLAY_HANG: "2" };
  r = wE(mock, ["play", "start", "--name", "hg"], hang);
  r = wE(mock, ["play", "do", "wait 5", "-s", "hg"], hang);
  ok("game hang: 'not responding since t=0.5s'", /not responding since t=0\.5s/.test(r.out), r.out);
  ok("game hang: the daemon exits (and the game with it)", await daemonGone("hg", mock));
  rep = report(dirOf(mock, "hg"));
  ok("game hang: outcome 'not responding'", rep.outcome === "not responding" && /not responding since t=0\.5s/.test(rep.endReason || ""), JSON.stringify({ o: rep.outcome, e: rep.endReason }));

  // (d) dead for good: respawn attempts and nothing changing for 20 game seconds ends the session as "stuck dead"
  const stuck = { MOCK_HAZARD: "stuck" };
  r = wE(mock, ["play", "start", "--name", "sd"], stuck);
  r = wE(mock, ["play", "do", "hold d 1.5", "-s", "sd"], stuck);
  ok("stuck dead: the player died", /YOU DIED|dead/.test(r.out), r.out);
  r = wE(mock, ["play", "do", "respawn", "-s", "sd"], stuck);
  ok("stuck dead: respawn fails after 8 s, pressing confirm", /still dead after 8s \(pressed confirm \d+×\)/.test(r.out), r.out);
  wE(mock, ["play", "do", "respawn", "-s", "sd"], stuck);
  r = wE(mock, ["play", "do", "wait 6", "-s", "sd"], stuck);
  ok("stuck dead: the session ends as 'stuck dead' with the attempts", /stuck dead: dead for 20s/.test(r.out) && /respawn attempt/.test(r.out) && /enter/.test(r.out), r.out);
  ok("stuck dead: the daemon exits", await daemonGone("sd", mock));
  rep = report(dirOf(mock, "sd"));
  ok("stuck dead: report outcome, inputs, state and a shot", rep.outcome === "stuck dead" && rep.stuckDead && rep.stuckDead.attempts >= 1 && rep.stuckDead.lastInputs.some((x) => /enter/.test(x.input)) && rep.stuckDead.state && rep.stuckDead.state.dead === true && rep.stuckDead.shot && fs.existsSync(rep.stuckDead.shot), JSON.stringify({ o: rep.outcome, s: rep.stuckDead }).slice(0, 1500));
  ok("stuck dead: report.md says so", /STUCK DEAD/.test(fs.readFileSync(path.join(dirOf(mock, "sd"), "report.md"), "utf8")));
}

// ---- batch --minutes 240: each session gets a wall cap that fits (it was the daemon default, 20 min)
fs.writeFileSync(path.join(mock, "long.txt"), "play for a long time\n");
r = w(mock, ["play", "batch", "--goals", "long.txt", "--minutes", "240", "--dry-run"]);
ok("batch --minutes 240: the session cap scales (960 wall min), the tester timeout 963", r.code === 0 && /about 240 game minutes \(hard stop after 960 wall min\), tester timeout 963 wall min/.test(r.out), r.out.slice(-600));
r = w(mock, ["play", "brief", "--minutes", "240"]);
ok("brief --minutes 240: the start line carries the same scaled cap", r.code === 0 && /--wall-minutes 960/.test(r.out), r.out.slice(0, 600));
r = w(mock, ["play", "brief", "--minutes", "4"]);
ok("brief --minutes 4: the daemon default (20 wall min) needs no flag", r.code === 0 && !/--wall-minutes/.test(r.out), r.out.slice(0, 600));
fs.rmSync(path.join(mock, "long.txt"));

// ---- play batch with a fake claude that runs the brief's commands through sh
const hasSh = spawnSync("sh", ["-c", "echo ok"], { encoding: "utf8", windowsHide: true }).stdout?.trim() === "ok";
if (!hasSh) console.log("  batch with a fake tester: skipped (no sh)");
else {
  fs.writeFileSync(path.join(mock, "goals.json"), JSON.stringify([{ goal: "collect a coin block-once", name: "fb1" }, { goal: "collect a coin block-always", name: "fb2" }]));
  const tB = Date.now();
  const b = spawnSync(process.execPath, [path.join(root, "bin", "witness.js"), "play", "batch", "--goals", "goals.json", "--parallel", "1", "--wall-minutes", "50"], { cwd: mock, encoding: "utf8", timeout: 300000, env: { ...process.env, ...env, WITNESS_CLAUDE: path.join(here, "fake-claude.mjs") } });
  const batchSec = (Date.now() - tB) / 1000;
  const bo = (b.stdout || "") + (b.stderr || "");
  const walls = [...bo.matchAll(/· (\d+)s wall/g)].map((m) => +m[1]);
  ok("batch: 'Ns wall' is the elapsed time, not the --wall-minutes cap added on", walls.length >= 2 && walls.every((s) => s <= batchSec + 1), `${walls} vs ${batchSec}s\n${bo}`);
  ok("batch: a blocked tester is reported with the denied command and retried once", /#1 fb1: blocked: permission denied \(cd ".*" && \.\/fb1 (?:"goto Coin"|…)\), 0 orders; retrying once with the exact allowed command/.test(bo), bo);
  ok("batch: the retry played through the brief's own short command (absolute path, no cd)", /#1 fb1: ENDED · [\d.]+s game · 1 orders .*retried after: blocked: permission denied/.test(bo), bo);
  ok("batch: blocked twice → a distinct outcome", /#2 fb2: BLOCKED: permission denied \(cd .*\) · 0 orders · also blocked on the retry/.test(bo), bo);
  const bmd = fs.readdirSync(dirOf(mock, "").replace(/[\\/]$/, "")).find((f) => /^batch-.*\.md$/.test(f));
  const bm = bmd ? fs.readFileSync(path.join(dirOf(mock, ""), bmd), "utf8") : "";
  ok("batch md: the blocked row and the retry note", /\| 2 \| collect a coin block-always \| newbie \| blocked: permission denied \(cd /.test(bm) && /\| 1 \| .* \| ended \(after a retry\) \|/.test(bm) && /retried once with the exact allowed command, which worked/.test(bm), bm);
  ok("batch: the blocked attempt's empty session folder was removed", fs.readdirSync(path.join(mock, "witness", "playtests")).filter((f) => f.startsWith("fb1")).length === 1, fs.readdirSync(path.join(mock, "witness", "playtests")).join(","));
  ok("batch: the header names the units", /about 3 game minutes \(hard stop after 50 wall min\) each, tester timeout 53 wall min/.test(bo), bo.split("\n")[0]);
}

// ---- nothing left running
const regDir = env.WITNESS_PLAY_REGISTRY;
let live = (fs.existsSync(regDir) ? fs.readdirSync(regDir).filter((f) => f.endsWith(".json")) : []).map((f) => JSON.parse(fs.readFileSync(path.join(regDir, f), "utf8"))).filter((e) => pidAlive(e.pid));
for (let i = 0; i < 20 && live.length; i++) { await new Promise((res) => setTimeout(res, 500)); live = live.filter((e) => pidAlive(e.pid)); }
ok("no session daemons left running", live.length === 0, JSON.stringify(live));
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
