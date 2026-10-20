// Witness core regression tests (0.7.3 audit): `node tests/core/run.mjs`. Unit tests first; the end-to-end part
// runs one tiny game process at a time.
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "../../src/cli/args.js";
import { splitRange } from "../../src/cli/window.js";
import { loadReplay } from "../../src/core/runner.js";
import { listen, Session } from "../../src/core/session.js";
import { prune, markGenerated, unsafeDir, GENERATED, MANIFEST } from "../../src/core/clean.js";
import { stampSkill, staleSkillCopies, isInstalledPlugin } from "../../src/core/init.js";
import { acquireSlot, scanSlots, startKeys, pidAlive } from "../../src/core/budget.js";
import { killTree } from "../../src/core/procs.js";
import { Matcher } from "../../src/core/compare.js";
import { loopSeam } from "../../src/media/hygiene.js";
import { refPath } from "../../src/cli/see.js";
import { markOutputs } from "../../src/cli/common.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const W = path.join(root, "bin", "witness.js"), TINY = path.join(here, "tiny-game.mjs");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL", name, String(extra).slice(0, 2500)); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "witness-core-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- M5: boolean flags never eat the next word
{
  const a = parseArgs(["--json", "a.witness.json", "--name", "coin"], "test");
  ok("args: --json leaves the file positional", a.pos[0] === "a.witness.json" && a.opt.json === true && a.opt.name === "coin", JSON.stringify(a));
  const b = parseArgs(["--repeat", "x.witness.json"], "test"), c = parseArgs(["--repeat", "3", "x.witness.json"], "test");
  ok("args: --repeat takes a number only", b.opt.repeat === true && b.pos[0] === "x.witness.json" && c.opt.repeat === "3" && c.pos[0] === "x.witness.json", JSON.stringify([b, c]));
  ok("args: --fit is a flag for shot, a value for measure", parseArgs(["--annotate", "--fit", "--at", "1"], "shot").opt.fit === true && parseArgs(["ui", "--fit", "cover"], "measure").opt.fit === "cover");
  ok("args: --watch takes a value except for play", parseArgs(["--watch", "state.x"], "trace").opt.watch === "state.x" && parseArgs(["start", "--watch", "--goal", "g"], "play").opt.watch === true);
  const pic = parseArgs(["ui", "--picture", "shot.png"], "measure"), dom = parseArgs(["palette", "--dominant", "a.png"], "measure");
  ok("args: --picture/--dominant/--write/--clean/--no-* never eat the next word", pic.opt.picture === true && pic.pos[1] === "shot.png" && dom.pos[1] === "a.png"
    && parseArgs(["suggest", "--write", "x"], "play").pos[1] === "x" && parseArgs(["list", "--clean", "x"], "play").pos[1] === "x" && parseArgs(["--no-whatever", "f.json"], "test").pos[0] === "f.json", JSON.stringify([pic, dom]));
  ok("args: --fun is a flag before note text, a value before a number", parseArgs(["note", "--fun", "great jump"], "play").opt.fun === true && parseArgs(["note", "--fun", "great jump"], "play").pos[1] === "great jump" && parseArgs(["end", "--fun", "4"], "play").opt.fun === "4");
  ok("args: value flags unchanged", parseArgs(["--at", "1,2", "--input", "right@0-1", "-o", "x.png"], "shot").opt.at === "1,2" && parseArgs(["-o", "x.png"]).opt.out === "x.png");
}

// ---- H5: ranges with decimals
ok("splitRange: decimals", JSON.stringify(splitRange("0.9..1.3")) === '["0.9","1.3"]' && JSON.stringify(splitRange(" 50f .. 80f ")) === '["50f","80f"]');
ok("splitRange: bad", splitRange("0.9") === null && splitRange("1..2..3") === null && splitRange("..2") === null);

// ---- listen --loop past the end: a clear error, not NaN dB
{
  const x = new Float32Array(44100).fill(0.1);
  let msg = "";
  try { loopSeam(x, 44100, 0.5, 2); } catch (e) { msg = e.message; }
  ok("loopSeam past the end throws", /outside the 1 s of audio/.test(msg), msg);
  ok("loopSeam inside works", Number.isFinite(loopSeam(x, 44100, 0, 0.9).levelStep));
}

// ---- M14: replay lines
{
  const head = JSON.stringify({ replay: 1, seed: 3, fps: 60 });
  const f1 = path.join(tmp, "cut.jsonl");
  fs.writeFileSync(f1, `${head}\n{"f":0,"in":[{"type":"key","key":"a","down":true}]}\n{"f":1}\n{"f":2,"in":[{"ty`);
  const r = loadReplay(f1, { quiet: true });
  ok("replay: a cut-short last line is left out with a warning", r.frames === 2 && r.warnings.length === 1 && /cut short/.test(r.warnings[0]), JSON.stringify(r.warnings));
  const f2 = path.join(tmp, "bad.jsonl");
  fs.writeFileSync(f2, `${head}\n{"f":0}\nnot json\n{"f":2}\n`);
  let msg = "";
  try { loadReplay(f2, { quiet: true }); } catch (e) { msg = e.message; }
  ok("replay: a bad middle line names file:line", msg.includes("bad.jsonl:3:"), msg);
}

// ---- H6: UTF-8 split across chunks; WebSocket handshakes split, or without a key
{
  const srv = await listen({ port: 0 });
  const c = net.connect(srv.port, "127.0.0.1");
  await new Promise((r) => c.on("connect", r));
  const line = Buffer.from(JSON.stringify({ hello: { protocol: 1, name: "café ünï", capabilities: [] } }) + "\n", "utf8");
  const cut = line.indexOf(Buffer.from("é")) + 1;
  c.write(line.subarray(0, cut)); await sleep(30); c.write(line.subarray(cut));
  const s = await srv.nextSession(5000);
  ok("ndjson: a character split across chunks decodes", s.hello.name === "café ünï", s.hello.name);
  c.destroy();
  // a WebSocket handshake in three pieces
  const ws = net.connect(srv.port, "127.0.0.1");
  await new Promise((r) => ws.on("connect", r));
  let resp = "";
  ws.on("data", (d) => { resp += d.toString("latin1"); });
  const hs = "GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";
  ws.write(hs.slice(0, 2)); await sleep(20); ws.write(hs.slice(2, 40)); await sleep(20); ws.write(hs.slice(40));
  await sleep(150);
  ok("websocket: a handshake split across chunks is accepted", /101 Switching Protocols/.test(resp) && /s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/.test(resp), resp);
  ws.destroy();
  // no key: that socket is closed with a 400, the server keeps serving
  const bad = net.connect(srv.port, "127.0.0.1");
  await new Promise((r) => bad.on("connect", r));
  let badResp = "", closed = false;
  bad.on("data", (d) => { badResp += d.toString("latin1"); });
  bad.on("close", () => { closed = true; });
  bad.on("error", () => {});
  bad.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
  await sleep(150);
  ok("websocket: no key → 400 and closed (no crash)", closed && /400/.test(badResp), badResp);
  const c2 = net.connect(srv.port, "127.0.0.1");
  await new Promise((r) => c2.on("connect", r));
  c2.write(JSON.stringify({ hello: { protocol: 1, name: "after", capabilities: [] } }) + "\n");
  ok("server still accepts games after a bad handshake", (await srv.nextSession(5000)).hello.name === "after");
  c2.destroy();
  srv.close();
}

// ---- input: a long replay's events go in several requests
{
  const sent = [];
  const conn = { send: (o) => { sent.push(o); setImmediate(() => handlers.forEach((h) => h({ id: o.id, ok: true }))); }, onMessage: (h) => handlers.push(h), onClose: () => {}, close: () => {} };
  const handlers = [];
  const s = new Session(conn);
  handlers.forEach((h) => h({ hello: { protocol: 1, capabilities: ["input"] } }));
  await s.input(Array.from({ length: 4500 }, (_, i) => ({ type: "key", key: "a", frame: i })));
  ok("input chunks: 4500 events → 3 requests", sent.length === 3 && sent[0].events.length === 2000 && sent[2].events.length === 500, sent.map((x) => x.events.length));
  await s.input([]);
  ok("input: nothing to send → no request", sent.length === 3);
}

// ---- compare: --repeat references released after the last pass
{
  const m = new Matcher();
  const cap = { snap: { state: { a: 1 } }, shot: { width: 1, height: 1, format: "rgba8", data: Buffer.alloc(4).toString("base64") } };
  await m.check("step:x", cap, "p1");
  const r = await m.check("step:x", cap, "p2", { release: true });
  ok("matcher: release drops the reference after comparing", r.ok && !m.has("step:x"));
  await m.check("match:y", cap); await m.check("match:y", cap);
  ok("matcher: without release the reference stays", m.has("match:y"));
}

// ---- M4: pruning only touches what Witness generated
{
  const proj = path.join(tmp, "proj"), shots = path.join(proj, "witness", "shots"), refs = path.join(proj, "witness", "refs"), reps = path.join(proj, "witness", "replays");
  for (const d of [shots, refs, reps]) fs.mkdirSync(d, { recursive: true });
  const old = (p, days) => { const t = new Date(Date.now() - days * 864e5); fs.utimesSync(p, t, t); };
  const put = (p, days) => { fs.writeFileSync(p, "x"); old(p, days); };
  put(path.join(shots, "shot-1.png"), 5); put(path.join(shots, "sheet.png"), 1); put(path.join(shots, "before.png"), 9);
  put(path.join(shots, "after.png"), 9); markGenerated(shots, path.join(shots, "after.png"));
  put(path.join(refs, "title.png"), 99); put(path.join(reps, "notes.txt"), 99); put(path.join(reps, "a.jsonl"), 1);
  const cfg = { shots: "witness/shots", replays: "witness/replays" };
  const r = prune(cfg, proj);
  const names = r.removed.map((p) => path.basename(p)).sort().join(",");
  ok("prune: old generated shots go, a user's picture and refs stay", names === "after.png,shot-1.png" && fs.existsSync(path.join(shots, "before.png")) && fs.existsSync(path.join(refs, "title.png")) && fs.existsSync(path.join(shots, "sheet.png")), names);
  ok("prune: the manifest forgets removed files", !fs.existsSync(path.join(shots, MANIFEST)));
  const all = prune(cfg, proj, { all: true });
  ok("prune --all: generated only (refs, notes.txt and before.png stay)", !fs.existsSync(path.join(shots, "sheet.png")) && !fs.existsSync(path.join(reps, "a.jsonl")) && fs.existsSync(path.join(reps, "notes.txt")) && fs.existsSync(path.join(shots, "before.png")) && fs.existsSync(path.join(refs, "title.png")), all.removed);
  const bad = prune({ shots: ".", replays: "../elsewhere" }, proj, { all: true });
  ok("prune: the project folder or a folder outside it is refused", bad.warnings.length === 2 && fs.existsSync(path.join(proj, "witness")) && /project folder itself/.test(bad.warnings.join(" ")) && /outside the project/.test(bad.warnings.join(" ")), bad.warnings);
  const ex = path.join(root, "examples", "js-node");
  ok("unsafeDir: a project inside the Witness checkout (an example) may prune its own folders", unsafeDir(path.join(ex, "witness", "shots"), ex) === null && unsafeDir(path.join(ex, "witness", "replays"), ex) === null
    && !!unsafeDir(path.join(root, "src", "core"), root) && !!unsafeDir(path.join(root, "examples"), root), unsafeDir(path.join(ex, "witness", "shots"), ex));
  ok("unsafeDir: the Witness install and witness/refs", !!unsafeDir(root, path.dirname(root)) && !!unsafeDir(path.join(proj, "witness", "refs"), proj) && unsafeDir(shots, proj) === null);
  // subfolder shots (a test step's "shot": "lvl1/a.png") and outputs named by the user (trace --out jump.png and its
  // jump-xy.png, <shot>-protan.png beside a test shot): in the manifest, pruned when old; a user's picture beside them stays
  const proj2 = path.join(tmp, "proj2"), shots2 = path.join(proj2, "witness", "shots");
  fs.mkdirSync(path.join(shots2, "lvl1"), { recursive: true }); fs.mkdirSync(path.join(shots2, "mine"), { recursive: true });
  fs.writeFileSync(path.join(proj2, "witness.json"), JSON.stringify({ name: "p2", launch: { command: "x" } }));
  put(path.join(shots2, "lvl1", "a.png"), 9); markGenerated(shots2, path.join(shots2, "lvl1", "a.png"));
  put(path.join(shots2, "mine", "keep.png"), 9);
  for (const n of ["jump.png", "jump-xy.png", "step-protan.png"]) put(path.join(shots2, n), 9);
  markOutputs([path.join(shots2, "jump.png"), path.join(shots2, "jump-xy.png"), path.join(shots2, "step-protan.png"), path.join(tmp, "elsewhere.png")]);
  const listed2 = fs.readFileSync(path.join(shots2, MANIFEST), "utf8").split(/\r?\n/).filter(Boolean).sort().join(",");
  ok("markGenerated/markOutputs: subfolder paths and named outputs listed", listed2 === "jump-xy.png,jump.png,lvl1/a.png,step-protan.png", listed2);
  const r2 = prune({}, proj2);
  ok("prune: old subfolder shots and named outputs go (empty folder too), a user's subfolder stays", !fs.existsSync(path.join(shots2, "lvl1")) && !fs.existsSync(path.join(shots2, "jump.png")) && !fs.existsSync(path.join(shots2, "step-protan.png")) && fs.existsSync(path.join(shots2, "mine", "keep.png")), r2.removed);
  // witness/movies (Godot --write-movie): old movie files go, the folder and its .gdignore stay
  const mov = path.join(proj2, "witness", "movies");
  fs.mkdirSync(mov, { recursive: true });
  put(path.join(mov, ".gdignore"), 99); put(path.join(mov, "witness.avi"), 9); put(path.join(mov, "witness.wav"), 9); put(path.join(mov, "new.avi"), 0); put(path.join(mov, "notes.txt"), 99);
  prune({}, proj2, { only: "movies" });
  ok("prune movies: old .avi/.wav go; new ones, .gdignore and other files stay", !fs.existsSync(path.join(mov, "witness.avi")) && !fs.existsSync(path.join(mov, "witness.wav")) && fs.existsSync(path.join(mov, "new.avi")) && fs.existsSync(path.join(mov, ".gdignore")) && fs.existsSync(path.join(mov, "notes.txt")), fs.readdirSync(mov));
  prune({}, proj2, { all: true, only: "movies" });
  ok("prune --all movies: the folder and .gdignore stay", fs.existsSync(path.join(mov, ".gdignore")) && !fs.existsSync(path.join(mov, "new.avi")));
  // playtests: {keep} folders (a batch's own reports) are never removed but count toward the limit
  const pt = path.join(proj2, "witness", "playtests");
  for (const [n, days] of [["old1", 3], ["old2", 2], ["b1", 0.01], ["b2", 0.01], ["b3", 0.01]]) { fs.mkdirSync(path.join(pt, n), { recursive: true }); old(path.join(pt, n), days); }
  prune({ retention: { playtests: { keep: 2 } } }, proj2, { only: "playtests", keep: ["b1", "b2", "b3"].map((n) => path.join(pt, n)) });
  ok("prune playtests {keep}: a batch's reports all stay, older ones beyond keep go", fs.readdirSync(pt).sort().join(",") === "b1,b2,b3", fs.readdirSync(pt));
  ok("GENERATED names", GENERATED.test("shot.png") && GENERATED.test("trace-xy.png") && GENERATED.test("mismatch-a-first.png") && GENERATED.test("x-diff.png") && GENERATED.test("listen") && !GENERATED.test("about.png") && !GENERATED.test("title.png"));
}

// ---- pruneRegistry leaves the batch lock folder (locks/) alone; a stray short command goes
{
  const reg = path.join(tmp, "reg");
  fs.mkdirSync(path.join(reg, "locks"), { recursive: true });
  fs.writeFileSync(path.join(reg, "locks", "batch.json"), "{}"); fs.writeFileSync(path.join(reg, "stray.cmd"), "x");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(path.join(root, "src", "core", "clean.js")).href)}).then((m) => console.log(m.pruneRegistry()))`], { encoding: "utf8", env: { ...process.env, WITNESS_PLAY_REGISTRY: reg } });
  ok("pruneRegistry: skips locks/, removes a stray short command", r.status === 0 && fs.existsSync(path.join(reg, "locks", "batch.json")) && !fs.existsSync(path.join(reg, "stray.cmd")), r.stdout + r.stderr);
}

// ---- M16: Godot --write-movie's folder exists before launch; init's .gitignore keeps it
{
  const { movieDirs } = await import("../../src/core/launch.js");
  const g = path.join(tmp, "godot");
  fs.mkdirSync(g, { recursive: true });
  const d = movieDirs(["--path", ".", "--write-movie", "witness/movies/witness.avi"], g);
  ok("movieDirs: creates the relative movie folder", d.length === 1 && fs.existsSync(path.join(g, "witness", "movies")), d);
  ok("movieDirs: user:// and no --write-movie are left alone", movieDirs(["--write-movie", "user://witness.avi"], g).length === 0 && movieDirs(["--path", "."], g).length === 0);
  const sub = movieDirs(["--path", "game", "--write-movie", "out/m.avi"], g);
  ok("movieDirs: relative to --path", sub.length === 1 && fs.existsSync(path.join(g, "game", "out")), sub);
  const src = fs.readFileSync(path.join(root, "src", "core", "init.js"), "utf8");
  ok("init: witness/.gitignore ignores movies but keeps the folder", src.includes("movies/*\\n!movies/.gdignore\\n"));
}

// ---- input: a request stays under about 1 MiB however big the events (a web adapter's inbound buffer)
{
  const sent = [], handlers = [];
  const conn = { send: (o) => { sent.push(o); setImmediate(() => handlers.forEach((h) => h({ id: o.id, ok: true }))); }, onMessage: (h) => handlers.push(h), onClose: () => {}, close: () => {} };
  const s = new Session(conn);
  handlers.forEach((h) => h({ hello: { protocol: 1, capabilities: ["input"] } }));
  await s.input(Array.from({ length: 300 }, (_, i) => ({ type: "text", text: "x".repeat(10000), frame: i })));
  ok("input chunks by size: 300 × 10 KB → several requests under 1 MiB, nothing lost", sent.length >= 3 && sent.every((x) => JSON.stringify(x).length < (1 << 20) + 20000) && sent.reduce((a, x) => a + x.events.length, 0) === 300, sent.map((x) => x.events.length));
}

// ---- M9: skill copies carry their version; stale ones are found
{
  const t = stampSkill("---\nname: witness\n---\n# Witness\n", "0.7.3", "/w/bin/witness.js");
  ok("stampSkill: after the front matter", /^---\nname: witness\n---\n<!-- witness-skill 0\.7\.3 cli=\/w\/bin\/witness\.js -->\n# Witness/.test(t), t);
  const proj = path.join(tmp, "skills");
  fs.mkdirSync(path.join(proj, ".claude", "skills", "witness"), { recursive: true });
  fs.mkdirSync(path.join(proj, ".claude", "skills", "witness-playtester"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".claude", "skills", "witness", "SKILL.md"), stampSkill("# W\n", "0.7.1", W));
  fs.writeFileSync(path.join(proj, ".claude", "skills", "witness-playtester", "SKILL.md"), "# old, no stamp\n");
  const st = staleSkillCopies(proj, "0.7.3");
  ok("staleSkillCopies: another version, and no stamp", st.length === 2 && /0\.7\.1/.test(st[0].why) && /no version stamp/.test(st[1].why), st);
  ok("staleSkillCopies: current copy is fine", staleSkillCopies(proj, "0.7.1").length === 1);
  ok("isInstalledPlugin", isInstalledPlugin("C:\\Users\\a\\.claude\\plugins\\cache\\m\\witness\\0.7.3") && isInstalledPlugin("/home/a/.claude/plugins/witness") && !isInstalledPlugin(root));
}

// ---- NEW: the machine-wide heavy-process budget
{
  const dir = path.join(tmp, "budget");
  const a = await acquireSlot({ dir, max: 2, maxBrowsers: 1, waitMs: 0, log: () => {} });
  const b = await acquireSlot({ dir, max: 2, maxBrowsers: 1, waitMs: 0, log: () => {}, browser: true });
  ok("budget: two slots taken (one also a browser slot)", a.files.length === 1 && b.files.length === 2 && fs.readdirSync(dir).length === 3, fs.readdirSync(dir));
  let msg = "";
  try { await acquireSlot({ dir, max: 2, waitMs: 0, log: () => {} }); } catch (e) { msg = e.message; }
  ok("budget: full → this process holds them all: refused at once", /already holds every slot/.test(msg), msg);
  b.release();
  ok("budget: release frees both files", fs.readdirSync(dir).length === 1);
  // a slot of a dead process is taken back; a live pid whose start time differs (a reused pid) too
  const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
  const deadPid = +dead.stdout.trim();
  fs.writeFileSync(path.join(dir, "slot-1.json"), JSON.stringify({ pid: deadPid, key: "x", token: "dead" }));
  const c = await acquireSlot({ dir, max: 2, waitMs: 0, log: () => {} });
  ok("budget: a dead owner's slot is reclaimed", c.files[0].endsWith("slot-1.json") && JSON.parse(fs.readFileSync(c.files[0], "utf8")).pid === process.pid);
  c.release();
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
  await sleep(200);
  const realKey = startKeys([sleeper.pid]).get(sleeper.pid);
  fs.writeFileSync(path.join(dir, "slot-1.json"), JSON.stringify({ pid: sleeper.pid, key: "not-its-start", token: "reused" }));
  const rows = scanSlots(dir);
  ok("budget: a live pid with another start time is stale (pid reuse)", realKey && rows.find((r) => r.file.endsWith("slot-1.json")).stale === true, JSON.stringify({ realKey, rows }));
  fs.writeFileSync(path.join(dir, "slot-1.json"), JSON.stringify({ pid: sleeper.pid, key: realKey, token: "live" }));
  let waited = "", t0 = Date.now();
  try { await acquireSlot({ dir, max: 2, waitMs: 1200, pollMs: 200, log: (m) => { waited = m; } }); } catch (e) { msg = e.message; }
  ok("budget: a live holder makes it wait (said once), then a clear failure", /waiting for a free slot/.test(waited) && /no free slot after/.test(msg) && Date.now() - t0 >= 1100, `${waited} | ${msg}`);
  // a waiting launch gets the slot when the holder dies
  setTimeout(() => sleeper.kill(), 400);
  const d = await acquireSlot({ dir, max: 2, waitMs: 8000, pollMs: 200, log: () => {} });
  ok("budget: the wait ends when a holder exits", d.files.length === 1);
  d.release(); a.release();
  ok("budget: max 0 = no limit", (await acquireSlot({ dir, max: 0 })).files.length === 0);
}

// ---- process trees: a shell's child dies with it
{
  const pidFile = path.join(tmp, "grandchild.pid");
  const code = `const c = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" }); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setTimeout(() => {}, 30000);`;
  const parent = spawn(process.execPath, ["-e", code], { stdio: "ignore", detached: process.platform !== "win32" });
  for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await sleep(100);
  const gc = +fs.readFileSync(pidFile, "utf8");
  killTree(parent.pid, { signal: "SIGKILL" });
  for (let i = 0; i < 30 && pidAlive(gc); i++) await sleep(100);
  ok("killTree: the grandchild is gone too", !pidAlive(gc) && !pidAlive(parent.pid), gc);
}

// ---- end to end with the tiny game (one process at a time)
const env = { ...process.env, WITNESS_BUDGET_DIR: path.join(tmp, "budget-e2e") };
const cli = (args, extra = {}, cwd = tmp) => spawnSync(process.execPath, [W, ...args], { cwd, encoding: "utf8", timeout: 90000, env: { ...env, ...extra } });
const tinyCfg = (dir, extraLaunch = {}) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "witness.json"), JSON.stringify({ name: "tiny", launch: { command: process.execPath, args: [TINY], ...extraLaunch }, tests: "." })); return dir; };
{
  // M7: no reset → a fresh process per test
  const proj = tinyCfg(path.join(tmp, "noreset"));
  fs.writeFileSync(path.join(proj, "a.witness.json"), JSON.stringify([
    { name: "one", steps: [{ at: "10f", expect: ["state.frame == 10", "state.boots == 1"] }] },
    { name: "two", steps: [{ at: "5f", expect: "state.frame == 5" }] },
  ]));
  const pids = path.join(tmp, "noreset.pids");
  const r = cli(["test", "--json"], { TINY_NORESET: "1", TINY_PID_FILE: pids }, proj);
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* shown */ }
  ok("no reset: each test gets a fresh process and passes", r.status === 0 && j && j.summary.passed === 2 && fs.readFileSync(pids, "utf8").trim().split("\n").length === 2, r.stdout + r.stderr);
  ok("no reset: --json stdout stays JSON (notes on stderr)", j && /fresh game process/.test(r.stderr), r.stderr);
  // 3+ restarts: every launched game gets a clean 'quit' (the 2nd restart once updated an inner handle, so the last
  // game was killed by the exit hook instead)
  fs.writeFileSync(path.join(proj, "c.witness.json"), JSON.stringify(["c1", "c2", "c3", "c4"].map((name) => ({ name, steps: [{ at: "3f", expect: "state.frame == 3" }] }))));
  const pids4 = path.join(tmp, "noreset4.pids"), quits4 = path.join(tmp, "noreset4.quits");
  const r4 = cli(["test", "--json", "c.witness.json"], { TINY_NORESET: "1", TINY_PID_FILE: pids4, TINY_QUIT_FILE: quits4 }, proj);
  const lines = (f) => { try { return fs.readFileSync(f, "utf8").trim().split(/\r?\n/).filter(Boolean).sort(); } catch { return []; } };
  ok("no reset, 4 tests: 4 launches, each got 'quit'", r4.status === 0 && lines(pids4).length === 4 && JSON.stringify(lines(pids4)) === JSON.stringify(lines(quits4)), `${lines(pids4)} / ${lines(quits4)} ${r4.stdout.slice(0, 400)}${r4.stderr}`);
  // M5 end to end: 'test --json <file>' runs that file only
  fs.writeFileSync(path.join(proj, "b.witness.json"), JSON.stringify([{ name: "three", steps: [{ at: "1f", expect: "state.frame == 1" }] }]));
  const r2 = cli(["test", "--json", "b.witness.json"], { TINY_NORESET: "1" }, proj);
  let j2 = null; try { j2 = JSON.parse(r2.stdout); } catch { /* shown */ }
  ok("test --json FILE runs that file only", j2 && j2.summary.passed === 1 && j2.data.results[0].name === "three", r2.stdout + r2.stderr);
}
{
  // --save-ref is single shots only (a sheet/clip would land in the pruned shots folder); dies before any launch
  const proj = tinyCfg(path.join(tmp, "saveref"));
  for (const extra of [["--sheet"], ["--from", "0", "--to", "1"], ["--clip", "0..1"]]) {
    const r = cli(["shot", ...extra, "--save-ref", "base"], {}, proj);
    ok(`shot ${extra[0]} --save-ref: refused`, r.status === 1 && /--save-ref saves single shots only/.test(r.stderr), r.stdout + r.stderr);
  }
  // a dotted baseline name (title.v2) is found by --diff
  fs.mkdirSync(path.join(proj, "witness", "refs"), { recursive: true });
  fs.writeFileSync(path.join(proj, "witness", "refs", "title.v2.png"), "x");
  ok("refPath: a dotted --save-ref name resolves to witness/refs", refPath("title.v2", {}, proj) === path.join(proj, "witness", "refs", "title.v2.png"));
}
{
  // M6: logs read before every reset survive an adapter that clears them on reset
  const proj = tinyCfg(path.join(tmp, "logs"));
  fs.writeFileSync(path.join(proj, "a.witness.json"), JSON.stringify([{ name: "logs", steps: [{ at: "10f", expect: "state.frame == 10" }, { measure: { curve: { of: "state.frame", time: "0.1" } } }] }]));
  const r = cli(["test"], { TINY_LOGCLEAR: "1" }, proj);
  ok("logs before reset: the error from before the measure step's reset fails the test", r.status === 1 && /tiny: frame 6 broke/.test(r.stdout), r.stdout + r.stderr);
}
{
  // H6 end to end: replies cut inside "é"
  const proj = tinyCfg(path.join(tmp, "split"));
  const r = cli(["eval", "--at", "2f", "state.name", "--json"], { TINY_SPLIT: "1" }, proj);
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* shown */ }
  ok("split UTF-8 replies decode", j && j.data.rows[0].values["state.name"] === "café", r.stdout + r.stderr);
}
{
  // M1: a launch command that doesn't exist fails at once, with the reason
  const proj = path.join(tmp, "enoent");
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, "witness.json"), JSON.stringify({ name: "x", launch: { command: path.join(tmp, "no-such-game.exe") }, timeout: 60 }));
  const t0 = Date.now(), r = cli(["eval", "--at", "1", "frame"], {}, proj);
  ok("ENOENT: fails fast with the reason", r.status !== 0 && Date.now() - t0 < 20000 && /couldn't start the game/.test(r.stderr) && /ENOENT/.test(r.stderr), `${Date.now() - t0} ms ${r.stderr}`);
  // a game that prints and never connects: the timeout error carries its output
  fs.writeFileSync(path.join(proj, "quiet.mjs"), "console.log('tiny: config missing, waiting forever'); setTimeout(() => {}, 60000);");
  fs.writeFileSync(path.join(proj, "witness.json"), JSON.stringify({ name: "x", launch: { command: process.execPath, args: [path.join(proj, "quiet.mjs")] }, timeout: 2 }));
  const r2 = cli(["eval", "--at", "1", "frame"], {}, proj);
  ok("timeout: the error shows the game's output", r2.status !== 0 && /no game connected within 2s/.test(r2.stderr) && /config missing, waiting forever/.test(r2.stderr), r2.stderr);
  ok("budget slots are released after failed launches", !fs.existsSync(env.WITNESS_BUDGET_DIR) || fs.readdirSync(env.WITNESS_BUDGET_DIR).length === 0, fs.existsSync(env.WITNESS_BUDGET_DIR) ? fs.readdirSync(env.WITNESS_BUDGET_DIR) : "");
}
{
  // H4: a die() inside a command stops the game (no leaked process), and SIGTERM does too
  const proj = tinyCfg(path.join(tmp, "die"));
  const pids = path.join(tmp, "die.pids");
  const r = cli(["call", "teleport", "--at", "0.1"], { TINY_PID_FILE: pids }, proj);   // tiny has no 'call' → die inside withGame
  const pid = +fs.readFileSync(pids, "utf8").trim();
  await sleep(300);
  ok("die inside withGame: clear message and the game is stopped", r.status === 1 && /doesn't support 'call'/.test(r.stderr) && !pidAlive(pid), `${r.stderr} alive=${pidAlive(pid)}`);
  fs.rmSync(pids, { force: true });
  const ch = spawn(process.execPath, [W, "trace", "--watch", "state.frame", "--time", "600"], { cwd: proj, env: { ...env, TINY_PID_FILE: pids, TINY_HANG: "1" }, stdio: "ignore" });
  const exitP = new Promise((res) => ch.on("exit", res));
  for (let i = 0; i < 80 && !fs.existsSync(pids); i++) await sleep(100);
  await sleep(500);
  const gp = fs.existsSync(pids) ? +fs.readFileSync(pids, "utf8").trim() : 0;
  const running = ch.exitCode === null && pidAlive(gp);   // the command is still busy (step never answers)
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(ch.pid), "/F"], { stdio: "ignore" }); else ch.kill("SIGTERM");
  await exitP;
  for (let i = 0; i < 30 && gp && pidAlive(gp); i++) await sleep(100);
  // Windows: taskkill /F ends the CLI without any handler, so the game sees its socket close and quits by itself
  ok("CLI killed mid-run: its game doesn't outlive it", gp && running && !pidAlive(gp), { gp, running });
}
{
  // M3: --diff of the default output path is refused (it would compare the shot with itself); named baselines
  const proj = path.join(tmp, "shots");
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, "witness.json"), JSON.stringify({ name: "mock", launch: { command: process.execPath, args: [path.join(root, "tests", "mock-game.mjs")] } }));
  const save = cli(["shot", "--at", "0.2", "--save-ref", "start"], {}, proj);
  ok("shot --save-ref writes witness/refs/<name>.png", save.status === 0 && fs.existsSync(path.join(proj, "witness", "refs", "start.png")), save.stdout + save.stderr);
  const same = cli(["shot", "--at", "0.2", "--diff", "start", "--json"], {}, proj);
  let j = null; try { j = JSON.parse(same.stdout); } catch { /* shown */ }
  ok("shot --diff <name> compares with the baseline", same.status === 0 && j && j.summary.changedPercent === 0, same.stdout + same.stderr);
  const moved = cli(["shot", "--at", "1", "--input", "right@0-1", "--diff", "start", "--json"], {}, proj);
  let j2 = null; try { j2 = JSON.parse(moved.stdout); } catch { /* shown */ }
  ok("shot --diff <name> sees a change", moved.status === 0 && j2 && j2.summary.changedPercent > 0, moved.stdout + moved.stderr);
  cli(["shot", "--at", "0.2"], {}, proj);
  const self = cli(["shot", "--at", "0.5", "--diff", path.join(proj, "witness", "shots", "shot.png")], {}, proj);
  ok("shot --diff of its own output path is refused", self.status === 1 && /compared with itself/.test(self.stderr), self.stdout + self.stderr);
  const none = cli(["shot", "--at", "0.2", "--diff", "nope"], {}, proj);
  ok("shot --diff <unknown name>: says how to save one", none.status === 1 && /--save-ref nope/.test(none.stderr), none.stderr);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
