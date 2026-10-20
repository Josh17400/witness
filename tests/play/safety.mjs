// Witness play: process-safety regressions from the 0.7.3 audit, through the real CLI but without a game (each command
// exits before anything launches, or talks to a fake daemon in this process). A private registry; light processes only.
//   liveness: a PID alone is never enough to kill (PID reuse after a crash or reboot); stale entries don't hold slots
//   tester guards: a batch tester can't run batch, --force, --all, clean; the narrowed allowlist is in unit.mjs
//   play clean <name> stays inside the playtests folder; the batch lock (stale-safe) and pruning while it's held
//   the .cmd shim with a quoted order; attemptResult ignores an older entry/report under the same name
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, "..", "..", "bin", "witness.js");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL", name, String(extra).slice(0, 2000)); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "witness-play-safety-"));
const REG = path.join(tmp, "registry");
process.env.WITNESS_PLAY_REGISTRY = REG;   // before the registry module reads it
const reg = await import("../../src/play/registry.js");
const { attemptResult } = await import("../../src/play/batch.js");
const { pruneRegistry } = await import("../../src/core/clean.js");
const baseEnv = { ...process.env, WITNESS_PLAY_REGISTRY: REG, WITNESS_PLAY_TESTER: "", WITNESS_PLAY_SESSION: "" };
delete baseEnv.WITNESS_PLAY_TESTER; delete baseEnv.WITNESS_PLAY_SESSION;
const cli = (args, { cwd = tmp, env = {} } = {}) => { const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 60000, env: { ...baseEnv, ...env }, windowsHide: true }); return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }; };
// async: this process keeps answering (the fake daemon below lives here)
const cliAsync = (args, { cwd = tmp, env = {} } = {}) => new Promise((resolve) => {
  const ch = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...baseEnv, ...env }, windowsHide: true });
  let out = ""; ch.stdout.setEncoding("utf8"); ch.stderr.setEncoding("utf8");
  ch.stdout.on("data", (d) => { out += d; }); ch.stderr.on("data", (d) => { out += d; });
  ch.on("close", (code) => resolve({ code, out }));
});
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const now = () => new Date().toISOString();

// a stand-in for "another program that got the old PID": a sleeping node process
const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", windowsHide: true });
const closedPort = await new Promise((res) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const ghost = (name, extra = {}) => {
  const dir = path.join(tmp, `sess-${name}`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ name, token: "tok", port: extra.port ?? closedPort, state: "ready" }));
  reg.writeEntry({ name, dir, root: tmp, started: now(), state: "ready", pid: bystander.pid, ...extra });
  return dir;
};

try {
  // ---- liveness (H1): pid + not ended + started since the boot
  ok("entryLive: a running PID started now is live", reg.entryLive({ pid: process.pid, state: "ready", started: now() }));
  ok("entryLive: started before the boot is dead whatever the PID", !reg.entryLive({ pid: process.pid, state: "ready", started: "2001-01-01T00:00:00.000Z" }));
  ok("entryLive: ended / failed / no pid are dead", !reg.entryLive({ pid: process.pid, state: "ended", started: now() }) && !reg.entryLive({ pid: process.pid, state: "failed" }) && !reg.entryLive({ state: "ready" }));

  // list --clean: a "live" entry whose daemon doesn't answer is marked ended; its PID (another program's now) survives
  ghost("ghost");
  let r = cli(["play", "list", "--clean"]);
  ok("list --clean: an unanswering session is marked ended, not killed", /ghost isn't answering: marked ended/.test(r.out) && /not killed/.test(r.out) && pidAlive(bystander.pid) && reg.readEntry("ghost").state === "ended", r.out);
  ghost("ghost");
  r = cli(["play", "stop", "-s", "ghost"]);
  ok("stop -s: an unanswering session's PID is not killed", pidAlive(bystander.pid) && /not killed/.test(r.out) && reg.readEntry("ghost").state === "ended", r.out);
  ghost("ghost");
  r = cli(["play", "stop", "--all"]);
  ok("stop --all: the same", pidAlive(bystander.pid) && reg.readEntry("ghost").state === "ended", r.out);
  ghost("ghost", { started: "2001-01-01T00:00:00.000Z" });
  r = cli(["play", "list"]);
  ok("list: an entry from before the boot shows as not running", /○ ghost/.test(r.out), r.out);

  // a fake daemon (this process): answers ping with the token, but with another PID than the entry's → not proof
  let pingPid = process.pid;
  const fake = http.createServer((req, res) => {
    const parts = []; req.on("data", (d) => parts.push(d));
    req.on("end", () => { const m = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"); res.end(JSON.stringify(m.token !== "tok" ? { ok: false } : m.cmd === "ping" ? { ok: true, text: "pong", data: { pid: pingPid } } : { ok: false, code: 1, text: "fake" })); });
  });
  const fport = await new Promise((res) => fake.listen(0, "127.0.0.1", () => res(fake.address().port)));
  ghost("imposter", { port: fport });
  r = await cliAsync(["play", "list", "--clean"]);
  ok("list --clean: a ping answered for another PID doesn't vouch for the entry's PID", /imposter isn't answering/.test(r.out) && pidAlive(bystander.pid), r.out);
  reg.removeEntry("imposter");

  // session cap (H1): a stale entry doesn't hold a slot; a web game allows one web session (M2)
  const proj = path.join(tmp, "proj"), pt = path.join(proj, "witness", "playtests");
  fs.mkdirSync(pt, { recursive: true });
  ghost("ghost");
  // --game-hours without a clock fails after the cap check, before anything launches
  r = cli(["play", "start", "--name", "n2", "--cmd", "node -e 1", "--game-hours", "4"], { cwd: proj, env: { WITNESS_PLAY_MAX: "1" } });
  ok("start: a stale entry doesn't count against WITNESS_PLAY_MAX", !/already running/.test(r.out) && /play\.clock/.test(r.out) && reg.readEntry("ghost").state === "ended", r.out);
  const webCfg = path.join(tmp, "webgame"); fs.mkdirSync(webCfg);
  fs.writeFileSync(path.join(webCfg, "witness.json"), JSON.stringify({ name: "web", launch: { url: "http://127.0.0.1:9/" } }));
  pingPid = process.pid;
  ghost("webby", { port: fport, pid: process.pid, web: true });
  r = await cliAsync(["play", "start", "--name", "w2", "--config", webCfg, "--game-hours", "4"], { env: { WITNESS_PLAY_MAX: "3" } });
  ok("start: a second web-game session is refused (one headless browser at a time)", r.code !== 0 && /web-game session is already running \(webby\)/.test(r.out) && /WITNESS_PLAY_MAX_WEB/.test(r.out), r.out);
  r = await cliAsync(["play", "start", "--name", "n3", "--cmd", "node -e 1", "--game-hours", "4"], { cwd: proj, env: { WITNESS_PLAY_MAX: "3" } });
  ok("start: … a desktop game still starts beside it", !/already running/.test(r.out) && /play\.clock/.test(r.out), r.out);
  reg.removeEntry("webby"); fake.close();

  // ---- tester guards (M2)
  const T = { WITNESS_PLAY_TESTER: "1" };
  fs.writeFileSync(path.join(tmp, "g.txt"), "win\n");
  r = cli(["play", "batch", "--goals", path.join(tmp, "g.txt"), "--cmd", "node -e 1"], { env: T });
  ok("tester: play batch refused", r.code !== 0 && /can't run from inside a playtest session/.test(r.out), r.out);
  r = cli(["play", "batch", "--goals", path.join(tmp, "g.txt"), "--cmd", "node -e 1"], { env: { WITNESS_PLAY_SESSION: "t1" } });
  ok("tester: play batch refused with WITNESS_PLAY_SESSION set", r.code !== 0 && /can't run from inside/.test(r.out), r.out);
  r = cli(["play", "start", "--force", "--cmd", "node -e 1"], { env: T });
  ok("tester: start --force refused", r.code !== 0 && /--force isn't available/.test(r.out), r.out);
  r = cli(["play", "stop", "--all"], { env: T });
  ok("tester: stop --all refused", r.code !== 0 && /--all isn't available/.test(r.out), r.out);
  r = cli(["play", "clean", "--all", "--cmd", "node -e 1"], { env: T });
  ok("tester: clean refused", r.code !== 0 && /clean isn't available/.test(r.out), r.out);

  // ---- play clean <name> (H3): only a playtest folder
  fs.mkdirSync(path.join(pt, "keep")); fs.writeFileSync(path.join(proj, "witness", "precious.txt"), "x");
  for (const bad of ["..", ".", "a/b", "../..", "x".repeat(41)]) {
    r = cli(["play", "clean", bad, "--cmd", "node -e 1"], { cwd: proj });
    ok(`clean '${bad.slice(0, 8)}': refused, nothing removed`, r.code !== 0 && /bad playtest name/.test(r.out) && fs.existsSync(path.join(proj, "witness", "precious.txt")) && fs.existsSync(path.join(pt, "keep")), r.out);
  }
  reg.writeEntry({ name: "evil", dir: proj, root: proj, started: now(), state: "ended" });
  r = cli(["play", "clean", "evil", "--cmd", "node -e 1"], { cwd: proj });
  ok("clean: a registry entry pointing outside the playtests folder (no session.json) is refused", r.code !== 0 && /isn't a playtest folder/.test(r.out) && fs.existsSync(path.join(proj, "witness", "precious.txt")), r.out);
  reg.removeEntry("evil");
  r = cli(["play", "clean", "keep", "--cmd", "node -e 1"], { cwd: proj });
  ok("clean keep: a real playtest folder is removed", r.code === 0 && !fs.existsSync(path.join(pt, "keep")) && fs.existsSync(pt), r.out);

  // ---- the batch lock (M2/M10): one holder, stale-safe, survives registry pruning; start doesn't prune while held
  const a = reg.acquireBatchLock({ root: tmp });
  const b = reg.acquireBatchLock({ root: tmp });
  ok("batch lock: a second batch is refused while the first holds it", a.ok && !b.ok && b.holder.pid === process.pid && !!reg.readBatchLock());
  pruneRegistry();
  ok("batch lock: registry pruning leaves it alone", fs.existsSync(reg.batchLockPath()));
  // two days old: past the 24 h a fresh playtest is always kept
  const twoDays = (Date.now() - 2 * 864e5) / 1000;
  for (let i = 0; i < 7; i++) { fs.mkdirSync(path.join(pt, `old${i}`)); fs.utimesSync(path.join(pt, `old${i}`), twoDays - i, twoDays - i); }
  r = cli(["play", "start", "--name", "n4", "--cmd", "node -e 1", "--game-hours", "4"], { cwd: proj });
  ok("start: no pruning while a batch holds the lock", fs.readdirSync(pt).filter((n) => n.startsWith("old")).length === 7, `${fs.readdirSync(pt)}\n${r.out}`);
  a.release();
  ok("batch lock: released", !fs.existsSync(reg.batchLockPath()) && !reg.readBatchLock());
  r = cli(["play", "start", "--name", "n5", "--cmd", "node -e 1", "--game-hours", "4"], { cwd: proj });
  ok("start: prunes again once the batch is done (keep 5)", fs.readdirSync(pt).filter((n) => n.startsWith("old")).length === 5, `${fs.readdirSync(pt)}\n${r.out}`);
  // playtests from the last 24 h stay past "keep" (a judge may still cite them); --dry-run lists without removing
  for (let i = 0; i < 6; i++) fs.mkdirSync(path.join(pt, `fresh${i}`));
  r = cli(["clean", "--playtests", "--cmd", "node -e 1"], { cwd: proj });
  ok("clean: playtests from the last 24 h are kept past keep 5", fs.readdirSync(pt).filter((n) => n.startsWith("fresh")).length === 6 && fs.readdirSync(pt).filter((n) => n.startsWith("old")).length === 0, `${fs.readdirSync(pt)}\n${r.out}`);
  for (let i = 0; i < 6; i++) fs.utimesSync(path.join(pt, `fresh${i}`), twoDays - i, twoDays - i);
  r = cli(["clean", "--playtests", "--dry-run", "--cmd", "node -e 1"], { cwd: proj });
  ok("clean --dry-run: lists what would go, removes nothing", r.code === 0 && /would remove \d+ item/.test(r.out) && fs.readdirSync(pt).filter((n) => n.startsWith("fresh")).length === 6, `${fs.readdirSync(pt)}\n${r.out}`);
  for (const n of fs.readdirSync(pt)) if (n.startsWith("fresh")) fs.rmSync(path.join(pt, n), { recursive: true, force: true });
  fs.writeFileSync(reg.batchLockPath(), JSON.stringify({ pid: process.pid, started: "2001-01-01T00:00:00.000Z" }));
  const c = reg.acquireBatchLock();
  ok("batch lock: a lock from before the boot is stale", c.ok); c.release();
  const dead = spawnSync(process.execPath, ["-e", "0"], { windowsHide: true }).pid;
  fs.writeFileSync(reg.batchLockPath(), JSON.stringify({ pid: dead, started: now() }));
  const d = reg.acquireBatchLock();
  ok("batch lock: a dead holder's lock is stale", d.ok && JSON.parse(fs.readFileSync(reg.batchLockPath(), "utf8")).pid === process.pid); d.release();

  // a batch killed without its exit handlers (taskkill /F): its PID may be reused, but the lock stops being touched
  const old2 = (Date.now() - 5 * 60000) / 1000;
  fs.writeFileSync(reg.batchLockPath(), JSON.stringify({ pid: bystander.pid, started: now() })); fs.utimesSync(reg.batchLockPath(), old2, old2);
  ok("batch lock: a live PID's lock untouched for minutes is stale", !reg.readBatchLock());
  r = cli(["play", "list", "--clean"]);
  ok("list --clean: removes a stale batch lock", /removed a stale batch lock/.test(r.out) && !fs.existsSync(reg.batchLockPath()), r.out);
  const hb = reg.acquireBatchLock();
  fs.utimesSync(reg.batchLockPath(), old2, old2);
  ok("batch lock: … the holder's beat() keeps it live", hb.ok && !reg.readBatchLock() && (hb.beat(), !!reg.readBatchLock())); hb.release();
  // two batches over one stale lock: only the holder of the (exclusive) takeover file may replace it
  fs.writeFileSync(reg.batchLockPath(), JSON.stringify({ pid: dead, started: now() }));
  fs.writeFileSync(`${reg.batchLockPath()}.takeover`, "1");
  const tk = reg.acquireBatchLock();
  ok("batch lock: no takeover while another process is taking over", !tk.ok && fs.existsSync(reg.batchLockPath()) && JSON.parse(fs.readFileSync(reg.batchLockPath(), "utf8")).pid === dead);
  fs.utimesSync(`${reg.batchLockPath()}.takeover`, old2, old2);
  const tk2 = reg.acquireBatchLock();
  ok("batch lock: a crashed taker's old takeover file doesn't block", tk2.ok && !fs.existsSync(`${reg.batchLockPath()}.takeover`)); tk2.release();

  // ---- session names: "." / ".." (shimPath would point at the temp folder / the registry itself) refused everywhere
  for (const bad of [".", ".."]) {
    r = cli(["play", "start", "--name", bad, "--cmd", "node -e 1"], { cwd: proj });
    ok(`start --name '${bad}': refused`, r.code !== 0 && /bad session name/.test(r.out), r.out);
  }
  fs.writeFileSync(path.join(tmp, "dots.json"), JSON.stringify([{ goal: "win", name: ".." }]));
  r = cli(["play", "batch", "--goals", path.join(tmp, "dots.json"), "--cmd", "node -e 1"], { cwd: proj });
  ok("batch: a goal named '..' is refused before anything runs", r.code !== 0 && /bad session name/.test(r.out) && !fs.existsSync(reg.batchLockPath()), r.out);

  // ---- a tester may only name its own session (-s / start --name)
  const TS = { WITNESS_PLAY_TESTER: "1", WITNESS_PLAY_SESSION: "mine" };
  r = cli(["play", "end", "-s", "other"], { env: TS });
  ok("tester: end -s <another session> refused", r.code !== 0 && /only use its own session \(mine\)/.test(r.out), r.out);
  r = cli(["play", "do", "explore", "--session", "other"], { env: TS });
  ok("tester: do --session <another> refused", r.code !== 0 && /only use its own session/.test(r.out), r.out);
  r = cli(["play", "start", "--name", "other", "--cmd", "node -e 1"], { env: TS, cwd: proj });
  ok("tester: start --name <another> refused", r.code !== 0 && /only start its own session/.test(r.out), r.out);
  r = cli(["play", "look", "-s", "mine"], { env: TS });
  ok("tester: -s <its own> passes the check", /no session "mine"/.test(r.out), r.out);

  // ---- play clean <name> with the same name in two projects: the registry entry is the other project's
  const pA = path.join(tmp, "projA"), pB = path.join(tmp, "projB"), tA = path.join(pA, "witness", "playtests", "t1"), tB = path.join(pB, "witness", "playtests", "t1");
  for (const d of [tA, tB]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "session.json"), "{}"); fs.writeFileSync(path.join(d, "report.md"), "x"); }
  reg.writeEntry({ name: "t1", dir: tA, root: pA, started: now(), state: "ready", pid: bystander.pid });   // live, in project A
  r = cli(["play", "clean", "t1", "--cmd", "node -e 1"], { cwd: pB });
  ok("clean t1 in project B: removes B's t1, not A's (and A's live session doesn't block it)", r.code === 0 && !fs.existsSync(tB) && fs.existsSync(path.join(tA, "report.md")) && !!reg.readEntry("t1"), r.out);
  reg.updateEntry("t1", { state: "ended" });
  r = cli(["play", "clean", "t1", "--cmd", "node -e 1"], { cwd: pA });
  ok("clean t1 in project A: removes A's own", r.code === 0 && !fs.existsSync(tA) && !reg.readEntry("t1"), r.out);

  // ---- a slow daemon (the port takes the connection, no answer in time) is still counted, never marked ended
  const hang = http.createServer(() => { /* never answers */ });
  const hport = await new Promise((res) => hang.listen(0, "127.0.0.1", () => res(hang.address().port)));
  ghost("slowpoke", { port: hport });
  r = await cliAsync(["play", "list", "--clean"]);
  ok("list --clean: a timed-out ping leaves the session running", /slowpoke is slow to answer/.test(r.out) && reg.readEntry("slowpoke").state === "ready", r.out);
  r = await cliAsync(["play", "start", "--name", "n6", "--cmd", "node -e 1", "--game-hours", "4"], { cwd: proj, env: { WITNESS_PLAY_MAX: "1" } });
  ok("start: … and still holds its slot", r.code !== 0 && /already running \(slowpoke\)/.test(r.out) && reg.readEntry("slowpoke").state === "ready", r.out);
  reg.removeEntry("slowpoke"); hang.closeAllConnections?.(); hang.close();

  // ---- stop: a daemon that exits by itself has stopped its game; the saved game PID (maybe reused now) isn't killed
  const standIn = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", windowsHide: true });
  const fake2 = http.createServer((req, res) => {
    const parts = []; req.on("data", (d) => parts.push(d));
    req.on("end", () => { const m = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"); if (m.cmd === "end") standIn.kill(); res.end(JSON.stringify(m.cmd === "ping" ? { ok: true, data: { pid: standIn.pid, gamePid: bystander.pid } } : { ok: true, text: "ENDED fake" })); });
  });
  const f2port = await new Promise((res) => fake2.listen(0, "127.0.0.1", () => res(fake2.address().port)));
  ghost("clean1", { port: f2port, pid: standIn.pid });
  r = await cliAsync(["play", "stop", "-s", "clean1"]);
  ok("stop: after a clean daemon exit the old game PID is left alone", /ENDED fake/.test(r.out) && !pidAlive(standIn.pid) && pidAlive(bystander.pid), r.out);
  reg.removeEntry("clean1"); fake2.close();

  // ---- stop while a session is still starting (no port yet): asks the daemon to stop itself, kills nothing
  const starter = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", windowsHide: true });
  const sdir = path.join(tmp, "sess-st"); fs.mkdirSync(sdir);
  fs.writeFileSync(path.join(sdir, "session.json"), JSON.stringify({ name: "st", token: "tok", state: "starting" }));
  reg.writeEntry({ name: "st", dir: sdir, root: tmp, started: now(), state: "starting", pid: starter.pid });
  const stopP = cliAsync(["play", "stop", "-s", "st"]);
  await new Promise((res) => setTimeout(res, 1500));
  const asked = fs.existsSync(path.join(sdir, "stop.request"));
  fs.writeFileSync(path.join(sdir, "session.json"), JSON.stringify({ name: "st", token: "tok", state: "ended" }));   // the daemon saw it
  r = await stopP;
  ok("stop (starting): leaves stop.request, waits, reports what happened, kills nothing", asked && /st stopped while starting/.test(r.out) && !/partial report|marked ended/.test(r.out) && pidAlive(starter.pid), r.out);
  try { starter.kill(); } catch { /* gone */ }
  reg.removeEntry("st");

  // the daemon side: a stop.request found when the game is up → it stops the game and ends without playing
  const ddir = path.join(tmp, "sess-dq"); fs.mkdirSync(ddir);
  const mock = `node "${path.resolve(here, "..", "mock-game.mjs").replace(/\\/g, "/")}"`;
  fs.writeFileSync(path.join(ddir, "session.json"), JSON.stringify({ name: "dq", token: "tok", root: tmp, cfg: { name: "game", launch: { command: mock, args: [], shell: true }, seed: 1, timeout: 60 }, opts: {}, state: "starting" }));
  fs.writeFileSync(path.join(ddir, "stop.request"), "stop");
  const dres = await new Promise((resolve) => { const ch = spawn(process.execPath, [CLI, "play", "_daemon", ddir], { cwd: tmp, env: baseEnv, windowsHide: true, stdio: "ignore" }); const t = setTimeout(() => { ch.kill(); resolve(null); }, 60000); ch.on("exit", (code) => { clearTimeout(t); resolve(code); }); });
  const dspec = JSON.parse(fs.readFileSync(path.join(ddir, "session.json"), "utf8"));
  ok("daemon: a stop requested while starting ends it (exits, state ended, no port)", dres === 0 && dspec.state === "ended" && !dspec.port && /stop requested while starting/.test(fs.readFileSync(path.join(ddir, "daemon.log"), "utf8")), `${dres} ${JSON.stringify(dspec).slice(0, 300)}`);

  // ---- attemptResult (M10): an entry / report from before the attempt isn't its result
  const ad = path.join(tmp, "att"); fs.mkdirSync(ad); fs.writeFileSync(path.join(ad, "report.json"), JSON.stringify({ status: "finished" }));
  reg.writeEntry({ name: "att", dir: ad, started: new Date(Date.now() - 3600e3).toISOString(), state: "ended" });
  const t0 = Date.now();
  ok("attemptResult: an older entry under the same name is ignored", attemptResult("att", t0).dir === null);
  reg.updateEntry("att", { started: now() });
  const old = (Date.now() - 3600e3) / 1000; fs.utimesSync(path.join(ad, "report.json"), old, old);
  const ar = attemptResult("att", t0);
  ok("attemptResult: this attempt's entry, but a stale report.json is ignored", ar.dir === ad && ar.report === null, JSON.stringify(ar));
  fs.writeFileSync(path.join(ad, "report.json"), JSON.stringify({ status: "finished" }));
  ok("attemptResult: a fresh report is read", (attemptResult("att", t0).report || {}).status === "finished");
  reg.removeEntry("att");

  // ---- the .cmd shim (low): a quoted order ("fight wolf") broke `if "%s%"==…`
  if (process.platform === "win32") {
    const echo = path.join(tmp, "echo.js"); fs.writeFileSync(echo, "console.log(JSON.stringify(process.argv.slice(2)))");
    const shim = `${reg.writeShim("s1", echo)}.cmd`;
    const run = (tail) => { const x = spawnSync("cmd.exe", ["/d", "/s", "/c", `""${shim}" ${tail}"`], { encoding: "utf8", windowsVerbatimArguments: true, windowsHide: true }); try { return JSON.parse(x.stdout.trim()); } catch { return x.stdout + x.stderr; } };
    const q = run('"fight wolf"'), l = run("look"), lq = run('"look" --shot');
    ok(".cmd shim: a quoted order is one do argument", JSON.stringify(q) === '["play","do","fight wolf","-s","s1"]', JSON.stringify(q));
    ok(".cmd shim: a play command (bare or quoted) passes through", JSON.stringify(l) === '["play","look","-s","s1"]' && JSON.stringify(lq) === '["play","look","--shot","-s","s1"]', JSON.stringify([l, lq]));
  }
} finally {
  try { bystander.kill(); } catch { /* gone */ }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
