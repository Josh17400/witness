// Witness core regression tests (0.7.3 audit): `node tests/core/run.mjs`. Unit tests first; the end-to-end part
// runs one tiny game process at a time.
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, KNOWN_FLAGS } from "../../src/cli/args.js";
import { splitRange } from "../../src/cli/window.js";
import { loadReplay } from "../../src/core/runner.js";
import { listen, Session } from "../../src/core/session.js";
import { prune, markGenerated, unsafeDir, GENERATED, MANIFEST } from "../../src/core/clean.js";
import { stampSkill, staleSkillCopies, isInstalledPlugin } from "../../src/core/init.js";
import { acquireSlot, scanSlots, startKeys, pidAlive, defaultWaitSec, fmtAge, who } from "../../src/core/budget.js";
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
  // every opt.<name> / opt["name"] / get("name") the code reads is a known flag, so the typo warning never fires on a real one
  const src = [];
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.m?js$/.test(n)) src.push(fs.readFileSync(p, "utf8")); } };
  walk(path.join(here, "..", "..", "src")); walk(path.join(here, "..", "..", "bin"));
  const read = new Set(src.flatMap((t) => [...t.matchAll(/\bopt\.([a-z][a-z0-9]*)\b(?!\()|\bopt\["([a-z][a-z0-9-]*)"\]|\b(?:get|val)\("([a-z][a-z0-9-]*)"\)/g)].map((m) => m[1] || m[2] || m[3])));
  const missing = [...read].filter((k) => !KNOWN_FLAGS.has(k) && !k.startsWith("no-"));
  ok("args: every flag the code reads is in KNOWN_FLAGS", !missing.length, missing.join(" "));
  // every .js file parses: lazily imported commands (play suggest) would otherwise only fail when someone runs them
  const files = [];
  const walkF = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) { if (n !== "node_modules") walkF(p); } else if (/\.m?js$/.test(n)) files.push(p); } };
  for (const d of ["src", "bin", path.join("adapters", "js")]) walkF(path.join(root, d));
  const bad = files.map((f) => [f, spawnSync(process.execPath, ["--check", f], { encoding: "utf8" })]).filter(([, r]) => r.status !== 0);
  ok(`syntax: all ${files.length} source files parse`, !bad.length, bad.map(([f, r]) => `${path.relative(root, f)}: ${r.stderr.split("\n").slice(0, 4).join(" | ")}`).join("\n"));
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
  // 0.7.8: a config outside any project (the OS temp folder) writing into a game's witness/shots: that folder is
  // Witness's own layout, so it is pruned (generated files only); a random outside folder, a drive root, home: refused
  {
    const cfgDir = path.join(tmp, "tmpcfg"), game = path.join(tmp, "game"), gShots = path.join(game, "witness", "shots");
    fs.mkdirSync(cfgDir, { recursive: true }); fs.mkdirSync(gShots, { recursive: true });
    put(path.join(gShots, "shot-1.png"), 9); put(path.join(gShots, "mine.png"), 9);
    const tr = prune({ shots: gShots, replays: path.join(game, "witness", "replays") }, cfgDir);
    ok("prune: a temp config's shots in another folder's witness/shots are pruned (generated only), no warning", tr.warnings.length === 0 && tr.removed.map((p) => path.basename(p)).join() === "shot-1.png" && fs.existsSync(path.join(gShots, "mine.png")), tr);
    ok("unsafeDir: outside folders that aren't witness/shots|replays (or a drive root, home) stay refused", /outside the project/.test(unsafeDir(path.join(game, "pics"), cfgDir) || "") && !!unsafeDir(path.parse(tmp).root, cfgDir) && !!unsafeDir(os.homedir(), cfgDir) && !!unsafeDir(root, cfgDir), [unsafeDir(path.join(game, "pics"), cfgDir), unsafeDir(root, cfgDir)]);
    // an outside folder holding a manifest (Desktop) is still refused: the user's figure_1.png / palette.png match GENERATED
    const desk = path.join(tmp, "Desktop"); fs.mkdirSync(desk, { recursive: true });
    put(path.join(desk, "shot-9.png"), 9); put(path.join(desk, "figure_1.png"), 9); put(path.join(desk, "palette.png"), 9); fs.writeFileSync(path.join(desk, MANIFEST), "shot-9.png\n");
    const dr = prune({ shots: desk }, cfgDir, { all: true });
    ok("prune: an outside folder with a manifest (not witness/shots) is refused; the user's figure_1.png / palette.png survive", dr.removed.length === 0 && /outside the project/.test(dr.warnings.join(" ")) && ["figure_1.png", "palette.png", "shot-9.png"].every((n) => fs.existsSync(path.join(desk, n))), dr);
  }
  // ---- 0.7.8: call timeout (WITNESS_CALL_TIMEOUT / launch.callTimeout) names what was pending; launch.media checked
{
  const { callTimeout } = await import(pathToFileURL(path.join(root, "src", "core", "launch.js")).href);
  const { mediaOptions } = await import(pathToFileURL(path.join(root, "src", "core", "browser.js")).href);
  const { browserOverrides } = await import(pathToFileURL(path.join(root, "src", "cli", "common.js")).href);
  const was = process.env.WITNESS_CALL_TIMEOUT;
  delete process.env.WITNESS_CALL_TIMEOUT;
  const bad = (f) => { try { f(); return null; } catch (e) { return e.message; } };
  ok("callTimeout: unset → null (60 s), launch.callTimeout seconds, WITNESS_CALL_TIMEOUT wins, 0/junk refused", callTimeout({ launch: {} }) === null && callTimeout({ launch: { callTimeout: 120 } }) === 120
    && (process.env.WITNESS_CALL_TIMEOUT = "90", callTimeout({ launch: { callTimeout: 120 } }) === 90) && /WITNESS_CALL_TIMEOUT "x": use seconds/.test((process.env.WITNESS_CALL_TIMEOUT = "x", bad(() => callTimeout({})))) && (delete process.env.WITNESS_CALL_TIMEOUT, /launch.callTimeout 0/.test(bad(() => callTimeout({ launch: { callTimeout: 0 } })))));
  if (was != null) process.env.WITNESS_CALL_TIMEOUT = was;
  ok("launch.media: checked and normalised; unknown features / values refused with the choices", JSON.stringify(mediaOptions({ reducedMotion: "Reduce", colorScheme: "dark" })) === '{"reducedMotion":"reduce","colorScheme":"dark"}' && mediaOptions(null) === null && mediaOptions({}) === null
    && /use "dark" or "light"/.test(bad(() => mediaOptions({ colorScheme: "blue" }))) && /unknown media feature/.test(bad(() => mediaOptions({ motion: "reduce" }))) && JSON.stringify(mediaOptions({ forcedColors: "active", contrast: "more" })) === '{"forcedColors":"active","contrast":"more"}');
  const bo = browserOverrides({ launch: { url: "http://x/", media: { contrast: "more" } } }, { "reduced-motion": true, "color-scheme": "dark" });
  ok("--reduced-motion / --color-scheme dark → launch.media (merged with the config's)", JSON.stringify(bo.launch.media) === '{"contrast":"more","reducedMotion":"reduce","colorScheme":"dark"}', bo.launch);
  ok("--reduced-motion / --color-scheme are known flags; --reduced-motion takes no value", KNOWN_FLAGS.has("reduced-motion") && KNOWN_FLAGS.has("color-scheme") && parseArgs(["test", "--reduced-motion", "a.witness.json"]).pos.includes("a.witness.json"));
  // a fake JS-adapter page: 'call' never answered, the out-of-line "busy" query answered at once
  const srv = await listen({ port: 0 });
  const c = net.connect(srv.port, "127.0.0.1");
  await new Promise((r) => c.on("connect", r));
  c.write(JSON.stringify({ hello: { protocol: 1, name: "slow", capabilities: ["call"], adapter: "witness-js 0.7.8" } }) + "\n");
  let buf = "";
  c.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.cmd === "busy") c.write(JSON.stringify({ id: m.id, ok: true, busy: { cmd: "call", name: "dealHand", ms: 400, awaiting: true }, calls: [{ name: "dealHand", ms: 400 }] }) + "\n"); } });
  const s = await srv.nextSession(5000);
  s.requestTimeoutMs = 300;
  const t0 = Date.now();
  const msg = await s.call("dealHand", [3, "north"]).then(() => "answered", (e) => e.message);
  ok("call timeout: configurable, names the call and its args, and the game promise still unresolved (busy query)", /didn't answer 'call' dealHand\(3,"north"\) within 0\.3s/.test(msg) && /waiting on a promise the game returned that never resolved/.test(msg) && /unresolved async calls: dealHand/.test(msg) && /WITNESS_CALL_TIMEOUT/.test(msg) && Date.now() - t0 < 3000, msg);
  c.destroy(); srv.close();
  }
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
  setTimeout(() => sleeper.kill(), 2000);
  const tq = Date.now();
  const d = await acquireSlot({ dir, max: 2, waitMs: 8000, pollMs: 200, log: () => {} });
  ok("budget: the wait ends when a holder exits", d.files.length === 1);
  const mine = who(scanSlots(dir).find((r) => r.file === d.files[0]));
  ok("budget: running time counts from taking the slot, not from queueing", Date.now() - tq >= 1900 && /running [01] s/.test(mine), mine);
  // holders named with what they are and how long they've run; an older slot file without "at" uses its mtime
  const s2 = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
  await sleep(200);
  const k2 = startKeys([s2.pid]).get(s2.pid);
  fs.writeFileSync(path.join(dir, "slot-1.json"), JSON.stringify({ pid: s2.pid, key: k2, token: "old" }));   // 0.7.5 format: no at, no label
  fs.utimesSync(path.join(dir, "slot-1.json"), new Date(Date.now() - 125000), new Date(Date.now() - 125000));
  const lines = []; msg = "";
  try { await acquireSlot({ dir, max: 2, waitMs: 1500, pollMs: 100, progressMs: 500, log: (m) => lines.push(m) }); } catch (e) { msg = e.message; }
  ok("budget: old slot file → its age from mtime", (lines[0] || "").includes(`pid ${s2.pid} (running 2 min)`) && /running 2 min/.test(msg), `${lines[0]} | ${msg}`);
  ok("budget: progress lines while waiting", lines.length >= 2 && lines.slice(1).every((l) => /^▸ still waiting for a free slot \(\d+ s of \d+ s\): in use by .*pid \d+ \(running 2 min\)/.test(l)), lines.join("\n"));
  ok("budget: a short wait has no background hint", !/background/.test(lines[0] || ""), lines[0]);
  fs.writeFileSync(path.join(dir, "slot-1.json"), JSON.stringify({ pid: s2.pid, key: k2, token: "new", at: new Date(Date.now() - 240000).toISOString(), label: "the-fort: witness play _daemon b1" }));
  lines.length = 0; msg = "";
  try { await acquireSlot({ dir, max: 2, waitMs: 120000, pollMs: 100, log: (m) => { lines.push(m); throw new Error("stop"); } }); } catch (e) { msg = e.message; }
  ok("budget: holder label + pid + running time; over 110 s → run it in the background", (lines[0] || "").includes(`the-fort: witness play _daemon b1 (pid ${s2.pid}, running 4 min)`) && /gives up after 120 s: .*run this command in the background .*WITNESS_BUDGET_WAIT/.test(lines[0] || ""), lines[0]);
  s2.kill();
  try { fs.unlinkSync(path.join(dir, "slot-1.json")); } catch { /* reclaimed */ }
  ok("budget: who() without owner / without label", who({ owner: null }) === "a launch starting" && /^pid 7 \(running 5 s\)$/.test(who({ owner: { pid: 7, at: new Date(1e12).toISOString() } }, 1e12 + 5000)));
  ok("budget: fmtAge", fmtAge(40000) === "40 s" && fmtAge(240000) === "4 min" && fmtAge(3900000) === "1 h 5 min");
  ok("budget: default wait 600 s for test/doctor/play batch, 90 s otherwise",
    defaultWaitSec(["test"]) === 600 && defaultWaitSec(["doctor"]) === 600 && defaultWaitSec(["play", "batch"]) === 600
    && defaultWaitSec(["play", "start"]) === 90 && defaultWaitSec(["play", "_daemon", "x"]) === 90 && defaultWaitSec(["shot"]) === 90 && defaultWaitSec(["eval"]) === 90 && defaultWaitSec([]) === 90);
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
  // a moment flag the command doesn't take: shot --t is --at; a typo is named, with the closest flag
  const viaT = cli(["shot", "--t", "0.5", "--diff", "start", "--json"], {}, proj), viaAt = cli(["shot", "--at", "0.5", "--diff", "start", "--json"], {}, proj);
  let jt = null, ja = null; try { jt = JSON.parse(viaT.stdout); ja = JSON.parse(viaAt.stdout); } catch { /* shown */ }
  ok("shot --t is taken as --at", jt && ja && jt.summary.changedPercent === ja.summary.changedPercent && !/unknown flag/.test(viaT.stderr), viaT.stdout + viaT.stderr);
  const typo = cli(["shot", "--at", "0.5", "--sead", "1"], {}, proj);
  ok("an unknown flag is warned about, with a suggestion", /unknown flag --sead \(ignored\): did you mean --seed\?/.test(typo.stderr), typo.stderr);
  const none = cli(["shot", "--at", "0.2", "--diff", "nope"], {}, proj);
  ok("shot --diff <unknown name>: says how to save one", none.status === 1 && /--save-ref nope/.test(none.stderr), none.stderr);
}

// ---- 0.7.5: screenshot tolerance (doctor), custom-device safe insets, measure ui on phone screenshots
{
  const { shotPixelDiff, pixelDiffImage, shotImageOf } = await import("../../src/core/compare.js");
  const { encodePNG } = await import("../../src/media/png.js");
  const { resolveDevice, safeInsetsFor, parseInsets, inferSafeFamily } = await import("../../src/core/devices.js");
  const { browserOptions } = await import("../../src/core/browser.js");
  const W0 = 200, H0 = 150, base = new Uint8Array(W0 * H0 * 4);
  for (let i = 0; i < W0 * H0; i++) base.set([(i * 7) % 200, (i * 3) % 180, 90, 255], i * 4);
  const noisy = base.slice();
  for (let k = 0; k < 123; k++) { const o = ((k * 211) % (W0 * H0)) * 4; noisy[o] += 1; }   // 123 px off by one level
  const png = (d) => ({ width: W0, height: H0, format: "png", data: Buffer.from(encodePNG(W0, H0, d)).toString("base64") });
  const A = png(base), B = png(noisy);
  const exact = shotPixelDiff(A, B), tol = shotPixelDiff(A, B, { tol: 2 });
  ok("shotPixelDiff: PNG shots decoded; exact: 123 px off by 1 with a box", exact && exact.count === 123 && exact.maxDelta === 1 && exact.bbox && exact.noise === 0, JSON.stringify(exact));
  ok("shotPixelDiff: ±2 tolerance: 0 px over, 123 noise", tol && tol.count === 0 && tol.noise === 123 && tol.bbox === null, JSON.stringify(tol));
  const m2 = new Matcher({ shotTol: 2 });
  await m2.check("A", { snap: { state: { a: 1 } }, shot: A });
  const r2 = await m2.check("A", { snap: { state: { a: 1 } }, shot: B });
  ok("Matcher shotTol 2: 1-level noise passes, said in a note", r2.ok && r2.notes.length === 1 && /123 px differ by at most 1 level \(within the ±2 tolerance/.test(r2.notes[0]), JSON.stringify(r2));
  const big = noisy.slice(); big.set([255, 0, 0, 255], (40 * W0 + 50) * 4); big.set([0, 255, 0, 255], (60 * W0 + 70) * 4);
  const m0 = new Matcher({ shotTol: 2 });
  await m0.check("A", { snap: { state: {} }, shot: A });
  const r0 = await m0.check("A", { snap: { state: {} }, shot: png(big) });
  ok("Matcher shotTol 2: a real change: count, box, largest difference, the noise counted apart; both shots returned", !r0.ok && /screenshot differs: 2 px \(0\.007%\) off by more than 2 levels in box x=50 y=40 21×21, up to \d+ levels \(\+12\d px within ±2\)/.test(r0.problems[0]) && r0.shots.length === 2 && r0.shotDiff.count === 2, JSON.stringify(r0.problems));
  const dimg = pixelDiffImage(shotImageOf(A), shotImageOf(png(big)), 2);
  ok("pixelDiffImage: red where over the tolerance, yellow within", dimg.length === W0 * H0 * 4 && dimg[(40 * W0 + 50) * 4] === 255 && dimg[(40 * W0 + 50) * 4 + 1] === 40 && dimg[211 * 4 + 1] === 210);
  ok("Matcher default stays exact", (await (async () => { const m = new Matcher(); await m.check("x", { snap: { state: {} }, shot: A }); return m.check("x", { snap: { state: {} }, shot: B }); })()).ok === false);

  // custom devices and explicit insets
  ok("parseInsets: 4, 2 and 1 numbers, objects, arrays", JSON.stringify(parseInsets("59,0,34,0")) === JSON.stringify({ top: 59, right: 0, bottom: 34, left: 0 }) && parseInsets("20,4").left === 4 && parseInsets("8").bottom === 8 && parseInsets([1, 2, 3, 4]).left === 4 && parseInsets({ top: 5 }).right === 0);
  let threw = null; try { parseInsets("a,b"); } catch (e) { threw = e.message; }
  ok("parseInsets: a readable error", /top,right,bottom,left/.test(threw || ""), threw);
  const c393 = resolveDevice({ width: 393, height: 852, dpr: 1 });
  const si = safeInsetsFor(c393);
  ok("custom 393×852@1: the iPhone 15 preset is inferred", inferSafeFamily(393, 852) === "iphone" && inferSafeFamily(852, 393) === "iphone" && c393.safe === "iphone" && si && si.preset === "iphone-portrait" && si.top === 59 && si.bottom === 34 && si.inferred === true, JSON.stringify(si));
  const odd = resolveDevice({ width: 400, height: 800 });
  ok("custom 400×800: no preset, explicit insets work, a preset name works", safeInsetsFor(odd) === null && JSON.stringify(safeInsetsFor(odd, "10,0,20,0")) === JSON.stringify({ preset: "custom", orientation: "portrait", top: 10, right: 0, bottom: 20, left: 0 }) && safeInsetsFor(odd, "iphone-landscape").left === 59 && safeInsetsFor(resolveDevice({ width: 400, height: 800, safeInsets: [44, 0, 34, 0] })).top === 44);
  const bo = browserOptions({ url: "x", device: { width: 400, height: 800 }, safeInsets: "12,0,30,0" });
  ok("browserOptions: --safe-insets 12,0,30,0 on a custom device", bo.safeInsets && bo.safeInsets.preset === "custom" && bo.safeInsets.bottom === 30);
  let be = null; try { browserOptions({ url: "x", device: { width: 400, height: 800 }, safeInsets: true }); } catch (e) { be = e.message; }
  ok("browserOptions: no preset and no insets: the error names explicit insets", /--safe-insets 59,0,34,0/.test(be || ""), be);
  const pa = parseArgs(["--safe-insets", "59,0,34,0", "--device", "x"], "doctor"), pb = parseArgs(["--safe-insets", "test.witness.json"], "test"), pc = parseArgs(["--safe-insets", "iphone-portrait"], "shot");
  ok("args: --safe-insets takes insets or a preset name, never a file", pa.opt["safe-insets"] === "59,0,34,0" && pb.opt["safe-insets"] === true && pb.pos[0] === "test.witness.json" && pc.opt["safe-insets"] === "iphone-portrait");
  const { uiGeometry } = await import("../../src/cli/measure-look.js");
  const fr = (mode, canvases, size) => ({ img: { width: 1179, height: 2556 }, web: { mode, device: resolveDevice("iphone-15"), info: { viewport: [393, 852], dpr: 3, canvases }, size } });
  const gDom = uiGeometry(fr("screen", [], [393, 852]), {}), gCv = uiGeometry(fr("screen", [{ w: 320, h: 180, rect: [0, 100, 393, 221.0625] }], [320, 180]), {});
  ok("uiGeometry: a DOM game on the screen: CSS px ×3; a canvas game: game px through the canvas box", gDom.pxPerPt === 3 && gDom.map.kx === 3 && gDom.units === "css" && gCv.units === "game" && Math.abs(gCv.map.kx - (3 * 393) / 320) < 1e-9 && gCv.map.oy === 300, JSON.stringify([gDom, gCv]));
}

// ---- measure ui on a phone screenshot (a PNG + ui.json in CSS px, --device): pt defaults, tap targets, scroll, gradient text
{
  const { encodePNG } = await import("../../src/media/png.js");
  const w = 750, h = 1334, d = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set([20, 20, 30, 255], i * 4);
  const fill = (x, y, ww, hh, c) => { for (let j = y; j < y + hh; j++) for (let i = x; i < x + ww; i++) if (i >= 0 && j >= 0 && i < w && j < h) d.set([...c, 255], (j * w + i) * 4); };
  for (let x = 40; x < 440; x++) for (let y = 40; y < 120; y++) if ((x >> 3) % 2 && (y >> 3) % 2) d.set([230, Math.round(40 + (200 * (x - 40)) / 400), 40, 255], (y * w + x) * 4);   // gradient letters
  fill(40, 200, 80, 60, [40, 90, 200]); fill(200, 200, 240, 100, [40, 90, 200]);
  const dir = path.join(tmp, "phone"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "shot.png"), encodePNG(w, h, d));
  const ui = [
    { id: "title", kind: "text", rect: [20, 20, 200, 40], text: "EUCHRE", fontPx: 28, fill: "gradient" },
    { id: "deal", kind: "button", rect: [20, 100, 40, 30], text: "Deal", fontPx: 14 },
    { id: "big", kind: "button", rect: [100, 100, 120, 50], text: "Play", fontPx: 14 },
    { id: "tiny", kind: "text", rect: [20, 170, 100, 12], text: "fine print", fontPx: 9 },
    { id: "list", kind: "panel", rect: [0, 200, 375, 300], scroll: "y" },
  ];
  for (let i = 0; i < 20; i++) ui.push({ id: `row${i}`, kind: "panel", rect: [0, 200 + i * 40, 375, 40], parent: "list" });
  fs.writeFileSync(path.join(dir, "ui.json"), JSON.stringify({ ui }));
  const run = (...extra) => cli(["measure", "ui", path.join(dir, "shot.png"), "--ui", path.join(dir, "ui.json"), "--json", ...extra], {}, dir);
  const r = run("--device", "iphone-se", "--ui-scale", "auto");
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* shown */ }
  const q = j && j.summary;
  ok("measure ui --device iphone-se --ui-scale auto: ×2, min text 11 pt = 22 px, Deal under 44 pt, rows scrolled (not off screen), gradient title not measured", q && q.pxPerPt === 2 && j.data.minText === 22 && q.smallText === 1 && q.smallTapTargets === 1 && q.offscreen === 0 && q.clipped === 0 && q.scrolled === 13 && q.contrastUnmeasurable === 1 && q.lowContrast === 0 && j.data.findings.find((f) => f.kind === "tap").ids[0] === "deal" && j.data.minTap.pt === 44, r.stdout.slice(0, 1500) + r.stderr);
  const t = cli(["measure", "ui", path.join(dir, "shot.png"), "--ui", path.join(dir, "ui.json"), "--device", "iphone-se", "--ui-scale", "auto"], {}, dir);
  ok("measure ui text output: the tap finding in pt, min text in pt, the scroll line, contrast not measurable", /deal \(button "Deal"\) tap target 40×30 pt < 44×44 pt \(Apple HIG: 44 pt\)/.test(t.stdout) && /min text 22 px \(11 pt\)/.test(t.stdout) && /tap targets ≥ 44 pt \(Apple HIG: 44 pt\)/.test(t.stdout) && /13 elements cut by a scroll container \(12 scrolled out of view, 1 partly visible\)/.test(t.stdout) && /safe area not checked on iphone-se \(no generic margin on a phone: --safe iphone-se checks/.test(t.stdout) && !/outside the safe area/.test(t.stdout) && /title: contrast not measurable, gradient text \(marked in state\.ui\)/.test(t.stdout), t.stdout + t.stderr);
  const r2 = run();
  let j2 = null; try { j2 = JSON.parse(r2.stdout); } catch { /* shown */ }
  ok("measure ui without --device: the old 2% default, no tap check", j2 && j2.data.minText === 26.68 && !j2.data.minTap && j2.summary.smallTapTargets === 0, r2.stdout.slice(0, 600) + r2.stderr);
  const r3 = run("--min-text", "11pt");
  ok("measure ui --min-text 11pt without a device: says why", r3.status === 1 && /needs to know the screenshot's px per pt/.test(r3.stderr), r3.stderr);
  const r4 = run("--device", "iphone-se", "--ui-scale", "auto", "--min-tap", "0", "--min-text", "8pt");
  let j4 = null; try { j4 = JSON.parse(r4.stdout); } catch { /* shown */ }
  ok("measure ui --min-tap 0 / --min-text 8pt override the defaults", j4 && j4.summary.smallTapTargets === 0 && j4.data.minText === 16 && j4.summary.smallText === 0, r4.stdout.slice(0, 600) + r4.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // a game whose Date start comes from its own config (WITNESS_CONFIG.epoch): an epoch test, then a plain one that must
  // see the game's date again (not 2026-01-01), the same as when it runs alone with --name
  const proj = path.join(tmp, "cfg-epoch");
  fs.mkdirSync(proj);
  const adapter = pathToFileURL(path.join(root, "adapters", "js", "witness.js")).href;
  fs.writeFileSync(path.join(proj, "game.mjs"), `globalThis.WITNESS_CONFIG = { epoch: "2030-03-03", takeover: true };
const { default: witness } = await import(${JSON.stringify(adapter)});
await witness.start({ name: "cfg-epoch", fps: 60, reset: () => {}, snapshot: () => ({ y: new Date().getUTCFullYear(), m: new Date().getUTCMonth() + 1 }) });`);
  fs.writeFileSync(path.join(proj, "witness.json"), JSON.stringify({ name: "cfg-epoch", launch: { command: process.execPath, args: [path.join(proj, "game.mjs")] }, tests: "." }));
  fs.writeFileSync(path.join(proj, "e.witness.json"), JSON.stringify([{ name: "own", epoch: "2026-06-15", steps: [{ at: "2f", expect: "state.y == 2026 && state.m == 6" }] },
    { name: "plain", steps: [{ at: "2f", expect: "state.y == 2030 && state.m == 3" }] }]));
  const r = cli(["test", "--json"], {}, proj);
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* shown */ }
  const t = j && j.data && j.data.results;
  ok("JS adapter: after an epoch test, a plain test is back at the game's own WITNESS_CONFIG.epoch (hello.epoch)", r.status === 0 && t && t.length === 2 && t.every((x) => x.ok), r.stdout.slice(0, 1500) + r.stderr);
}

// ---- test steps (0.7.8): expectPage / evalAs (page checks), until (conditional wait), per-test epoch, step reminders,
// the audio drain at a test's start: runTest on an in-process fake session (no game process)
{
  const { runTest } = await import("../../src/core/runner.js");
  const { WitnessError } = await import("../../src/core/session.js");
  const { DEFAULT_EPOCH } = await import("../../src/core/launch.js");
  const fake = (o = {}) => ({
    fps: 60, frame: 0, score: 0, epoch: o.epoch ?? null, log: [], closed: false,
    hello: { ...(o.helloEpoch != null ? { epoch: o.helloEpoch } : {}), capabilities: ["step", "snapshot", "call", "input", ...(o.noReset ? [] : ["reset"]), ...(o.noEval ? [] : ["eval"]), ...(o.audio ? ["audio"] : [])] },
    has(c) { return this.hello.capabilities.includes(c); },
    async reset(seed, scene, params, epoch = this.epoch) { this.log.push(["reset", epoch]); this.frame = 0; this.score = 0; return {}; },
    async step(n) { this.frame += n; return { frame: this.frame, time: this.frame / 60 }; },
    async snapshot() { return { frame: this.frame, time: this.frame / 60, state: { frame: this.frame, score: this.score } }; },
    async call(name) { this.log.push(["call", name, this.frame]); this.score++; return {}; },
    async input(evs) { this.log.push(["input", evs.map((e) => e.frame)]); return {}; },
    async eval(expr) { if (expr === "boom") throw new WitnessError("game error on 'eval': boom is not defined"); return { value: new Function("frame", "score", `return (${expr});`)(this.frame, this.score) }; },
    async audio() { this.log.push(["audio", this.frame]); return o.pcm ? o.pcm(this) : { sampleRate: 22050, channels: 1, format: "f32", data: "" }; },
    async pullLogs() {}, async drainLogs() { return []; },
  });
  const T = (steps, extra = {}) => ({ name: "t", file: "x.witness.json", index: 0, steps, ...extra });
  const msgs = (r) => r.failures.map((f) => `${f.kind}: ${f.message}`).join(" | ");
  let s = fake(), r = await runTest(s, T([{ at: 0.5, expectPage: ["frame == 30", "frame == 31", "boom"] }]));
  ok("expectPage: evaluated in the game at the step; failures show the expression and what it returned (or threw)", r.expects.passed === 1 && r.expects.failed === 2 && /page frame == 31 — got false/.test(msgs(r)) && /page boom — threw: boom is not defined/.test(msgs(r)), msgs(r));
  r = await runTest(fake(), T([{ at: 0.5, evalAs: { f: "frame * 2", sc: "score + 7" }, expect: ["f == 60", "sc == 7"] }, { at: 1, expect: "f == 60 && frame == 60" }]));
  ok("evalAs: page values by name, readable by the step's and later steps' expects", r.ok && r.expects.passed === 3, msgs(r));
  r = await runTest(fake(), T([{ at: 0, evalAs: { count: "1" } }]));
  ok("evalAs: a helper's name is refused", !r.ok && /evalAs: "count" is a helper's name already/.test(msgs(r)), msgs(r));
  r = await runTest(fake({ noEval: true }), T([{ at: 0, expectPage: "true" }]));
  ok("expectPage without the adapter's eval: one clear error", !r.ok && r.failures.length === 1 && /has none \(see its hello\.capabilities\)/.test(msgs(r)), msgs(r));
  r = await runTest(fake(), T([{ until: "state.frame >= 100", timeout: 5, expect: "frame == 100" }, { expect: "frame == 100" }, { after: 0.5, expect: "frame == 130" }, { at: 3, expect: "frame == 180" }]));
  ok("until: waits until true, then its expects; no at = right after; after = relative; at stays absolute", r.ok && r.expects.passed === 5 && r.untils[0].frame === 100, msgs(r) + JSON.stringify(r.untils));
  r = await runTest(fake(), T([{ at: 0.5, until: "state.frame >= 101", every: 7 }, { untilPage: "frame >= 121", expect: "frame == 121" }]));
  ok("until every 7 frames from 0.5 s: met at 107; untilPage (in the game) then met at 121", r.ok && r.untils[0].frame === 107 && r.untils[1].frame === 121, msgs(r) + JSON.stringify(r.untils));
  s = fake();
  r = await runTest(s, T([{ input: "touch:1,2@0.1", until: "state.frame > 1000", timeout: 1 }, { expect: "true" }]));
  ok("until timeout: fails with the expression, the window and the last value; later point steps skipped; its input ran first", !r.ok && r.expects.failed === 1 && r.expects.passed === 0 && /until state\.frame > 1000 — not true within 1s \(frames 0\.\.60, 0\.000–1\.000s\); last state\.frame > 1000 — got 60 > 1000; the point steps after it were skipped/.test(msgs(r)) && s.log.some((l) => l[0] === "input" && l[1][0] === 6), msgs(r));
  r = await runTest(fake(), T([{ until: "frame >= 120" }, { at: 1, expect: "true" }]));
  ok("an absolute at an until already waited past: an error that says to use after", !r.ok && /step 2 at 1s: the test is already at 2\.000s .*use "after"/.test(msgs(r)), msgs(r));
  r = await runTest(fake(), T([{ at: 2, expect: "true" }, { at: 1, expect: "true" }, { until: "frame >= 200" }]));
  ok("a point step out of time order in a sequence test: blames file order, not a wait", !r.ok && /step 2 at 1s: the test is already at 2\.000s: steps run in file order once a test has an until\/after step: put step 2 after/.test(msgs(r)) && !/waited/.test(msgs(r)), msgs(r));
  r = await runTest(fake(), T([{ from: 0, to: 1, always: "state.score == 0" }, { until: "frame >= 90", call: ["bump"] }]));
  ok("until: its call runs before the wait; range steps still see every frame while it waits", !r.ok && /always state\.score == 0 — failed at frame 1 /.test(msgs(r)) && r.untils[0].frame === 90, msgs(r));
  // per-test epoch
  s = fake();
  await runTest(s, T([{ at: 0, expect: "true" }], { epoch: "2026-06-15" }));
  await runTest(s, T([{ at: 0, expect: "true" }]));
  s = fake({ helloEpoch: Date.UTC(2030, 2, 3) });
  await runTest(s, T([{ at: 0, expect: "true" }], { epoch: "2026-06-15" }));
  await runTest(s, T([{ at: 0, expect: "true" }]));
  ok("epoch: after a test's own epoch, the next test gets the adapter's configured start (hello.epoch), not the default", s.log[1][1] === Date.UTC(2030, 2, 3) && s.epoch === null, JSON.stringify(s.log));
  s = fake(); await runTest(s, T([{ at: 0, expect: "true" }], { epoch: "2026-06-15" })); await runTest(s, T([{ at: 0, expect: "true" }]));
  ok("epoch: the test's epoch goes with its reset; the next test without one starts at the default epoch; the run's is back after", s.log[0][1] === Date.UTC(2026, 5, 15) && s.log[1][1] === DEFAULT_EPOCH && s.epoch === null, JSON.stringify(s.log));
  s = fake({ epoch: 5 });
  r = await runTest(s, T([{ at: 0, expect: "true" }], { now: "today" }));
  const d0 = new Date();
  ok("now: \"today\" for one test; witness.json's epoch for the rest; res.epoch recorded", s.log[0][1] === Date.UTC(d0.getFullYear(), d0.getMonth(), d0.getDate()) && r.epoch === s.log[0][1] && s.epoch === 5, JSON.stringify(s.log));
  r = await runTest(fake({ noReset: true }), T([{ at: 0, expect: "true" }], { epoch: "2026-06-15" }));
  ok("epoch without the adapter's reset: a warning, not a silent no-op", r.ok && /per-test epoch can't be sent/.test(msgs(r)), msgs(r));
  let ee = null; try { await runTest(fake(), T([], { epoch: "someday" })); } catch (e) { ee = e.message; }
  ok("epoch: a bad date is refused, naming the test", /test "t": "epoch" "someday" isn't a date/.test(ee || ""), ee);
  // reminders
  s = fake();
  r = await runTest(s, T([{ at: 0.5, call: ["bump"], expect: "state.score == 1" }, { at: 1.3, input: "touch:1,2@1.4" }]));
  ok("warns: an expect sharing a step with a call sees the post-call state; an input @t ≥ the step's at is relative (lands at 2.7 s)", r.ok && /step 1: "expect" runs after the step's "call"/.test(msgs(r)) && /step 2 \(at 1\.3s\): .*@1\.4s lands at 2\.7s; for 1\.4s from the start write @0\.1/.test(msgs(r)) && s.log.find((l) => l[0] === "input")[1][0] === 162, msgs(r) + JSON.stringify(s.log));
  r = await runTest(fake(), T([{ at: 0.5, input: "right@0-2" }, { at: 0.05, input: "space@0" }, { at: 0.5, input: "drag:1,1->9,9@0-1, swipe:1,1->9,9@0-0.9, touch:1,1@0-1, click:1,1@0" }, { at: 0.5, input: [{ frame: 0, type: "key", key: "a", down: true }, { frame: 40, type: "key", key: "a", down: false }] }]));
  ok("no relative-input warning for a hold's release, a tap's key-up, drag/swipe moves, a touch's up (only item starts count)", r.ok && !/relative to it/.test(msgs(r)), msgs(r));
  r = await runTest(fake(), T([{ at: 0.5, input: "a@0, b@0.6-1" }]));
  ok("relative-input warning: names the item that starts late", /item @0\.6s lands at 1\.1s; for 0\.6s from the start write @0\.1/.test(msgs(r)), msgs(r));
  // audio drained at the start of a test even without a reset (a fresh page: its load isn't in the first capture)
  s = fake({ noReset: true, audio: true });
  r = await runTest(s, T([{ at: 0.5, expect: "true" }]), { matcher: new Matcher(), matchAll: true });
  const au = s.log.filter((l) => l[0] === "audio");
  ok("--repeat without reset: audio drained at the test's start (frame 0), then captured at the step", au.length === 2 && au[0][1] === 0 && au[1][1] === 30, JSON.stringify(s.log));
  // --repeat through the Matcher: step audio at another rate on pass 2 (0.7.3 Euchre: 22050/24000 vs 44100 Hz)
  const pcm = (rate, v) => ({ sampleRate: rate, channels: 1, format: "f32", data: Buffer.from(new Float32Array(rate / 10).fill(v).buffer).toString("base64") });
  for (const [v, name] of [[0, "silent"], [0.25, "loud"]]) {
    s = fake({ audio: true, pcm: (me) => pcm(me.pass === 1 ? 24000 : 44100, v) });
    const m = new Matcher(), t = T([{ at: 0.5, expect: "true" }]);
    s.pass = 1; const p1 = await runTest(s, t, { matcher: m, matchAll: true });
    s.pass = 2; const p2 = await runTest(s, { ...t, _lastPass: true }, { matcher: m, matchAll: true });
    const mm = p2.failures.filter((f) => f.kind === "match");
    if (v === 0) ok("--repeat: silent step audio at 24000 then 44100 Hz is no mismatch (at most a 'both captures silent' note)", p1.ok && p2.ok && !mm.length && !/audio: (?!both captures silent)/.test(msgs(p2)), msgs(p1) + " || " + msgs(p2));
    else ok(`--repeat: ${name} step audio at 24000 then 44100 Hz fails the match`, p1.ok && !p2.ok && mm.length === 1 && /repeat: .*Hz/.test(mm[0].message), msgs(p2));
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
