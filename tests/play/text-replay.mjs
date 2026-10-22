// Witness play 0.7.8, from Euchre Unleashed (a pure-DOM iPhone card game): observations that don't clip what a tester
// reads (play.textCap, state.screenText, look --full), choose / pick accepting a notice change (a hint bubble) as the
// answer, and playtests that replay on their own (witness.run.json in the playtest folder, a build fingerprint in the
// replay header, a warning when the build changed), plus batch --dry-run printing each brief. Unit tests without
// processes, a local HTTP server for the web fingerprint, then one end-to-end session (one node game, no browser).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { parseOrders } from "../../src/play/orders.js";
import { NavGrid } from "../../src/play/grid.js";
import { resolvePlayConfig, parseTextCap, TEXT_CAP } from "../../src/play/config.js";
import { Perceiver } from "../../src/play/perceive.js";
import { Autopilot } from "../../src/play/autopilot.js";
import { observeText, observeData } from "../../src/play/observe.js";
import { EventTracker } from "../../src/play/events.js";
import { runConfig, fingerprint, buildDiff, recordedBuild, buildWarning, RUN_CONFIG } from "../../src/play/build.js";
import { reportMarkdown } from "../../src/play/report.js";
import { witness } from "./agent.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL", name, String(extra).slice(0, 3000)); } };

// ---- 22a: textCap, screenText, look --full
{
  ok("textCap: defaults 600 dialogue / notice / menu, 1200 screen", JSON.stringify(parseTextCap(undefined)) === JSON.stringify(TEXT_CAP) && TEXT_CAP.dialogue === 600 && TEXT_CAP.screen === 1200);
  ok("textCap: a number sets every field; an object only its fields; nonsense keeps the default", parseTextCap(300).notice === 300 && parseTextCap(300).screen === 300 && parseTextCap({ dialogue: 800, notice: 600 }).dialogue === 800 && parseTextCap({ dialogue: 800 }).menu === 600 && parseTextCap({ notice: "x" }).notice === 600 && parseTextCap(5).dialogue === 40);
  const result = "Tournament complete! " + "Round results: you and your partner took 4 of 5 hands; the bots euchred you twice. ".repeat(3) + "Final standing: 2nd of 8.";   // ~330 chars
  const long = "L".repeat(1000);
  const view = (state, play = {}, full = false, profile = "turn") => {
    const cfg = resolvePlayConfig({ profile, ...play }, { keys: [] });
    const w = new Perceiver(cfg, { fps: 60 }).perceive({ frame: 0, time: 0, state }, 0);
    const ctx = { cfg, events: [], first: false, session: {}, full };
    return { text: observeText(w, ctx), data: observeData(w, ctx) };
  };
  let v = view({ yourTurn: true, choices: [{ label: "Home", id: "home" }], dialogue: { text: result, options: [] }, notice: result });
  ok("a ~330-char result (dialogue and notice) shows whole now (was cut at 220 / 140)", v.text.includes(result) && !/cut, /.test(v.text), v.text);
  v = view({ yourTurn: true, choices: [], notice: long, menu: long });
  ok("a 1000-char notice is cut at 600 and says how much is left and how to see it", /game says: "L{599}…" \(cut, 401 more chars; look --full\)/.test(v.text) && /menu open: L{599}… \(cut, 401 more chars; look --full\)/.test(v.text), v.text);
  v = view({ yourTurn: true, choices: [], notice: long }, {}, true);
  ok("look --full (ctx.full): the notice uncut, no cut note", v.text.includes(`"${long}"`) && !/cut, /.test(v.text), v.text.slice(0, 300));
  v = view({ yourTurn: true, choices: [], dialogue: { text: long, options: ["OK"] } }, { textCap: { dialogue: 800 } });
  ok("play.textCap {dialogue: 800}: the dialogue is cut at 800 instead", /"L{799}…" \(cut, 201 more chars; look --full\)/.test(v.text), v.text);
  const screen = "TOURNAMENT RESULTS\n1. North/South 10 pts\n2. You/Partner 8 pts\n" + "Hand 3: you led the jack of hearts... ".repeat(10);
  v = view({ yourTurn: true, choices: [{ label: "Continue", id: "c" }], scene: "tournament", screenText: screen });
  ok("state.screenText: its own line, the whole screen's text on one line, and in --json data", /\nscreen text: "TOURNAMENT RESULTS 1\. North\/South 10 pts/.test(v.text) && v.text.includes("Hand 3: you led") && v.data.screenText === screen, v.text);
  ok("state.screenText isn't listed again as a field of its own", !/screenText/.test(v.text), v.text);
  v = view({ yourTurn: true, choices: [], screenText: "x".repeat(1500) });
  ok("screen text cut at 1200 by default, with the cut note", /screen text: "x{1199}…" \(cut, 301 more chars; look --full\)/.test(v.text), v.text.slice(-200));
  v = view({ yourTurn: true, choices: [], screenText: "y".repeat(500) }, { textCap: { screen: 200 } });
  ok("play.textCap {screen: 200}", /screen text: "y{199}…" \(cut, 301 more chars/.test(v.text), v.text);
  v = view({ yourTurn: true, choices: [], notice: "Same words", screenText: "Same words" });
  ok("screen text that only repeats the notice isn't shown twice", (v.text.match(/Same words/g) || []).length === 1, v.text);
  v = view({ player: { pos: [1, 1], hp: 3 }, notice: result, screenText: screen }, {}, false, "topdown");
  ok("topdown observation: long notice whole, screen text line", v.text.includes(result) && /screen text: "TOURNAMENT/.test(v.text), v.text);
  v = view({ player: { pos: [1, 1], hp: 3 }, notice: result, screenText: screen }, { screenText: "state.panel" }, false, "topdown");
  ok("play.screenText expression: reads the game's field it names (none here → no line)", !/screen text:/.test(v.text), v.text);
  // a notice / dialogue that came and went between two looks: the events line is the only copy, cut at textCap too
  const evLook = (states, full = false, play = {}) => {
    const cfg = resolvePlayConfig({ profile: "turn", ...play }, { keys: [] }), per = new Perceiver(cfg, { fps: 60 }), tr = new EventTracker(cfg, per);
    const ws = states.map((s, i) => per.perceive({ frame: i * 30, time: i / 2, state: { yourTurn: true, choices: [], ...s } }, i * 30));
    const events = []; for (let i = 1; i < ws.length; i++) events.push(...tr.update(ws[i - 1], ws[i], {}));
    return observeText(ws.at(-1), { cfg, events, first: false, session: {}, full });
  };
  v = { text: evLook([{}, { notice: result }, {}]) };
  ok("a ~330-char notice that appeared and went between looks reaches the events line whole", /events: .*game says: "Tournament complete!/.test(v.text) && v.text.includes(`game says: "${result}"`) && !/cut, /.test(v.text), v.text);
  v = { text: evLook([{}, { dialogue: { speaker: "Table", text: result, options: ["OK"] } }, {}]) };
  ok("a ~330-char dialogue line gone by the look: the events line has it whole", v.text.includes(`dialogue opened — Table: "${result}" [1) OK]`), v.text);
  v = { text: evLook([{}, { notice: long }, {}]) };
  ok("a 1000-char notice in the events line: cut at 600 with the cut note", /events: .*game says: "L{599}…" \(cut, 401 more chars; look --full\)/.test(v.text), v.text.slice(-200));
  v = { text: evLook([{}, { notice: long }, {}], true) };
  ok("look --full: the events line has the notice whole", v.text.includes(`game says: "${long}"`) && !/cut, /.test(v.text), v.text.slice(-200));
  v = { text: evLook([{}, { notice: long }, {}], false, { textCap: { notice: 200 } }) };
  ok("play.textCap {notice: 200} cuts the events line there too", /game says: "L{199}…" \(cut, 801 more chars/.test(v.text), v.text.slice(-200));
}

// ---- 22b: choose / pick accept a notice change (a hint button opening a bubble) as the answer
const runChoose = (S, order, play = { controls: { choose: "numbers" } }, keys = ["1", "2", "3", "4", "5", "6"]) => {
  const cfg = resolvePlayConfig(play, { keys });
  const per = new Perceiver(cfg, { fps: 60 });
  let w = per.perceive(S.snapshot(), 0);
  const ap = new Autopilot(cfg, { fps: 60, grid: new NavGrid({ cell: w.cell, origin: [0, 0] }), perceiver: per });
  ap.observe(w); ap.setOrders(parseOrders(order, {}));
  let dec;
  for (let i = 0; i < 200; i++) {
    dec = ap.decide(w);
    if (dec.status === "call") {
      const v = S.call(dec.name, dec.args);
      if (ap.cur) { ap.cur.result = `called ${dec.name} → ${JSON.stringify(v)}`; ap.cur.callValue = v; ap.cur.callFailed = false; }
      S.step(); w = per.perceive(S.snapshot(), S.frame); ap.observe(w); continue;
    }
    S.q.push(...ap.ctrl.emit(dec.want, S.frame));
    if (dec.status !== "run") break;
    for (let k = 0; k < Math.max(1, dec.k); k++) S.step();
    w = per.perceive(S.snapshot(), S.frame); ap.observe(w);
  }
  return dec;
};
const hintGame = ({ fades = false, viaUi = false } = {}) => ({
  frame: 0, q: [], bubble: null, bubbleT: 0, presses: 0,
  step() {
    for (const e of this.q.filter((e) => e.frame <= this.frame)) if (e.type === "key" && e.down && e.key === "6") { this.presses++; this.bubble = "Hint: lead your highest trump when your partner called it."; this.bubbleT = this.frame; }
    this.q = this.q.filter((e) => e.frame > this.frame);
    if (fades && this.bubble && this.frame - this.bubbleT > 12) this.bubble = null;   // a bubble that fades in 0.2 s
    this.frame++;
  },
  snapshot() {
    const opts = ["Pass", "Order up", "Go alone", "Rules", "Settings", "Hint"];
    return { frame: this.frame, time: this.frame / 60, state: { player: { pos: [1, 1], hp: 5 }, dialogue: { speaker: "Bidding", text: "Order up the jack of hearts?", options: opts }, ...(viaUi ? { ui: { bubble: this.bubble } } : { notice: this.bubble }) } };
  },
});
{
  let S = hintGame(), dec = runChoose(S, "choose 6");
  ok("choose 6 (Hint): the dialogue stays, the notice changes → done: 'chose 6) \"Hint\": notice changed → …, dialogue unchanged'", dec.status === "done" && /^chose 6\) "Hint": notice changed → "Hint: lead your highest trump/.test(dec.message) && /dialogue unchanged/.test(dec.message) && S.presses === 1, JSON.stringify(dec));
  S = hintGame({ fades: true }); dec = runChoose(S, "choose 6");
  ok("a hint bubble that fades within the half second still counts (the state change didn't last); pressed once", dec.status === "done" && /notice changed → "Hint:/.test(dec.message) && S.presses === 1, JSON.stringify(dec));
  S = hintGame({ viaUi: true }); dec = runChoose(S, "choose 6", { controls: { choose: "numbers" }, notice: "state.ui.bubble" });
  ok("a notice the config reads from elsewhere (play.notice: state.ui.bubble) counts the same", dec.status === "done" && /notice changed → "Hint:/.test(dec.message), JSON.stringify(dec));
  // turn profile pick: a hint choice whose only answer is a notice
  const T = { frame: 0, q: [], notice: null, step() { this.frame++; }, call(name, args) { if (args[0] === "hint") this.notice = "Hint: follow suit if you can."; return { ok: true }; },
    snapshot() { return { frame: this.frame, time: this.frame / 60, state: { yourTurn: true, notice: this.notice, choices: [{ label: "Play J♥", id: "jh" }, { label: "Hint", id: "hint" }] } }; } };
  dec = runChoose(T, "pick hint", { profile: "turn", pick: { call: "choose" } }, []);
  ok("pick (turn): a hint that only shows a notice → done, 'notice changed → …'", dec.status === "done" && /picked 2\) "Hint" → notice changed → "Hint: follow suit/.test(dec.message), JSON.stringify(dec));
  // a ticking turn timer in the notice ('Your turn: 9s' → '8s') is not the pick's answer
  const tick = (f) => `Your turn: ${9 - Math.floor(f / 12)}s`;   // ticks every 0.2 s
  S = hintGame(); S.dropFirst = true; const step0 = S.step;
  S.step = function () { if (this.dropFirst && this.q.some((e) => e.frame <= this.frame && e.type === "key" && e.down && e.key === "6")) { this.dropFirst = false; this.dropped = true; this.q = this.q.filter((e) => e.frame > this.frame); } step0.call(this); if (!this.bubble || this.bubble.startsWith("Your turn")) this.bubble = tick(this.frame); };
  S.bubble = tick(0); dec = runChoose(S, "choose 6");
  ok("choose with a ticking notice and a game that drops the first press: presses again and reports the real hint", S.dropped && dec.status === "done" && /notice changed → "Hint: lead/.test(dec.message) && S.presses === 1, JSON.stringify(dec));
  const T2 = { ...T, notice: tick(0), step() { this.frame++; this.notice = tick(this.frame); }, call() { return { ok: true }; } };
  dec = runChoose(T2, "pick hint", { profile: "turn", pick: { call: "choose" } }, []);
  ok("pick (turn) with a ticking timer notice: not 'notice changed → Your turn: 8s'", dec.status === "done" && !/notice changed/.test(dec.message) && /accepted it/.test(dec.message), JSON.stringify(dec));
}

// ---- 17: run config, fingerprint, diff, report lines
{
  const root = path.resolve("/proj/game");
  const rc = runConfig({ name: "g", build: "npm run build", tests: "witness", shots: "witness/shots", launch: { url: "http://127.0.0.1:5173/", server: { command: "npx serve -l 5173", cwd: "web" } }, play: { module: "play.mjs" } }, root);
  ok("run config: no build step, absolute folders, launch.server kept with an absolute cwd, play.module absolute", !rc.build && rc.tests === path.join(root, "witness") && rc.shots === path.join(root, "witness", "shots") && rc.launch.server.command === "npx serve -l 5173" && rc.launch.server.cwd === path.join(root, "web") && rc.play.module === path.join(root, "play.mjs"), JSON.stringify(rc));
  const rc2 = runConfig({ launch: { command: "node", args: ["game.mjs"], server: "python -m http.server" } }, root);
  ok("run config: a command launch gets launch.cwd (the root), a string server becomes {command, cwd}", rc2.launch.cwd === root && rc2.launch.server.command === "python -m http.server" && rc2.launch.server.cwd === root, JSON.stringify(rc2));

  const ptDir = path.join(root, "witness", "playtests", "b1"), rc3 = runConfig({ tests: "witness", shots: "witness/shots", replays: "witness/replays" }, root, ptDir);
  ok("run config into a playtest folder: folders relative to it, so path.join(root, cfg.shots) and path.resolve both reach the project's", rc3.shots === "../../shots" && path.join(ptDir, rc3.shots) === path.join(root, "witness", "shots") && path.resolve(ptDir, rc3.tests) === path.join(root, "witness") && path.join(ptDir, rc3.replays) === path.join(root, "witness", "replays"), JSON.stringify(rc3));

  const site = fs.mkdtempSync(path.join(os.tmpdir(), "witness-fp-"));
  fs.mkdirSync(path.join(site, "js"));
  fs.writeFileSync(path.join(site, "index.html"), `<!doctype html><link rel="stylesheet" href="style.css"><script type="module" src="js/main.js"></script><script src="https://cdn.example.com/x.js"></script>`);
  fs.writeFileSync(path.join(site, "style.css"), "body{}");
  fs.writeFileSync(path.join(site, "js", "main.js"), `import { a } from "./cards.js";\nimport "./witness.js";\nconst later = () => import("./later.js");\n`);
  fs.writeFileSync(path.join(site, "js", "cards.js"), "export const a = 1;\n");
  fs.writeFileSync(path.join(site, "js", "later.js"), "export default 2;\n");
  fs.writeFileSync(path.join(site, "dev.html"), `<!doctype html><script type="module" src="/@vite/client"></script><script type="module">import { start } from './js/boot.js'; start()</script><script type="module" src="js/main.js"></script>`);
  fs.writeFileSync(path.join(site, "js", "boot.js"), "export const start = () => 1;\n");
  const srv = http.createServer((req, res) => { if (req.url.startsWith("/@vite/")) return res.end(`const wsToken = "${Math.random()}";`); const f = path.join(site, decodeURIComponent(new URL(req.url, "http://x").pathname)); if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.end(fs.readFileSync(f)); } else { res.statusCode = 404; res.end(); } });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/index.html?witness=127.0.0.1:1&witness_seed=3`;
  try {
    const a = await fingerprint({ launch: { url } }, site);
    ok("web fingerprint: the page, its stylesheet, its module and the module's imports (static and dynamic); not other sites or witness.js; no witness query", a && a.kind === "web" && Object.keys(a.files).join(",") === "/index.html,/js/cards.js,/js/later.js,/js/main.js,/style.css" && !/witness/.test(a.url) && a.count === 5 && /^[0-9a-f]{16}$/.test(a.hash), JSON.stringify(a));
    const same = await fingerprint({ launch: { url } }, site);
    ok("the same build: the same fingerprint, no diff", same.hash === a.hash && buildDiff(a, same) === null);
    fs.writeFileSync(path.join(site, "js", "cards.js"), "export const a = 2;\n");
    const b = await fingerprint({ launch: { url } }, site);
    ok("one script changed: another hash, and the diff names it", b.hash !== a.hash && buildDiff(a, b) === "/js/cards.js changed", buildDiff(a, b));
    const devUrl = url.replace("/index.html", "/dev.html"), d1 = await fingerprint({ launch: { url: devUrl } }, site), d2 = await fingerprint({ launch: { url: devUrl } }, site);
    ok("dev-server runtime (/@vite/client, a new token each fetch) is skipped: the same build gives the same hash", d1 && d2 && d1.hash === d2.hash && !Object.keys(d1.files).some((k) => /@vite/.test(k)), JSON.stringify([d1, d2]));
    ok("an inline module script's imports are followed", d1 && "/js/boot.js" in d1.files, JSON.stringify(d1));
    fs.writeFileSync(path.join(site, "js", "boot.js"), "export const start = () => 2;\n");
    const d3 = await fingerprint({ launch: { url: devUrl } }, site);
    ok("a module only an inline script imports changed: the diff names it", buildDiff(d1, d3) === "/js/boot.js changed", buildDiff(d1, d3));
    srv.close();
    ok("the page unreachable (its server gone): no fingerprint, nothing thrown", (await fingerprint({ launch: { url } }, site)) === null);
  } finally { srv.close(); fs.rmSync(site, { recursive: true, force: true }); }
  const cmdDir = fs.mkdtempSync(path.join(os.tmpdir(), "witness-fpc-"));
  try {
    fs.writeFileSync(path.join(cmdDir, "game.mjs"), "1");
    const c1 = await fingerprint({ launch: { command: process.execPath, args: ["game.mjs", "--fast"] } }, cmdDir);
    ok("command fingerprint: the launched files that exist (the script; node itself is outside the cwd but a file too)", c1 && c1.kind === "files" && "game.mjs" in c1.files, JSON.stringify(c1));
    const rf = path.join(cmdDir, "r.jsonl");
    fs.writeFileSync(rf, JSON.stringify({ replay: 1, fps: 60, build: c1 }) + "\n" + JSON.stringify({ f: 0, dt: 1 / 60 }) + "\n");
    ok("recordedBuild reads the replay header's fingerprint", recordedBuild(rf)?.hash === c1.hash);
    ok("buildWarning: nothing when unchanged", (await buildWarning(rf, { launch: { command: process.execPath, args: ["game.mjs"] } }, cmdDir)) === null);
    fs.writeFileSync(path.join(cmdDir, "game.mjs"), "2");
    const wn = await buildWarning(rf, { launch: { command: process.execPath, args: ["game.mjs"] } }, cmdDir);
    ok("buildWarning: 'the build changed since this playtest (game.mjs changed)'", /^⚠ the build changed since this playtest \(game\.mjs changed\)/.test(wn || ""), wn);
  } finally { fs.rmSync(cmdDir, { recursive: true, force: true }); }

  const base = { session: "b1", game: { name: "Euchre" }, seed: 1, gameSeconds: 10, frames: 600, wallSeconds: 30, stats: { orders: 1, ordersFailed: 0 }, timeline: [], notes: [], deaths: [], kills: [], pickups: [], stuck: [], stuckSpots: [], fights: [], orders: [], errors: [], shots: [], dialogues: [], profile: "turn", replay: { file: "/p/witness/playtests/b1/replay.jsonl", frames: 600 }, runConfig: "/p/witness/playtests/b1/witness.run.json", build: { kind: "web", url: "http://127.0.0.1:8123/index.html", hash: "abcdef0123456789", count: 6 } };
  const rel = (p) => path.posix.relative("/p", p);
  let md = reportMarkdown(base, { rel, config: rel(base.runConfig), server: false });
  ok("report.md: replay commands load the playtest's own config; no-server localhost warning; the fingerprint line", /witness replay --config witness\/playtests\/b1\/witness\.run\.json witness\/playtests\/b1\/replay\.jsonl/.test(md) && /served by something Witness didn't start \(no launch\.server\)/.test(md) && /Build played: http:\/\/127\.0\.0\.1:8123\/index\.html and 5 files it loads, fingerprint `abcdef0123456789`/.test(md), md.slice(md.indexOf("## Reproduce")));
  md = reportMarkdown(base, { rel, config: rel(base.runConfig), server: true });
  ok("report.md with launch.server: says the replay starts the server again, no warning", /so the replay starts the server again/.test(md) && !/didn't start/.test(md));
}

// ---- end to end: a session's own run config replays after the original config is gone; a changed build warns
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "witness-rr-"));
  const env = { WITNESS_PLAY_REGISTRY: path.join(tmp, "registry"), WITNESS_PLAY_MAX: "3" };
  fs.copyFileSync(path.join(here, "turn-game.mjs"), path.join(tmp, "game.mjs"));
  const cfgFile = path.join(tmp, "witness.run-7.json");   // a per-run config, as a harness writes one
  fs.writeFileSync(cfgFile, JSON.stringify({ name: "High Card", launch: { command: process.execPath, args: ["game.mjs"] }, play: { profile: "turn", pick: { call: "choose" }, show: ["score", "phase"] } }));
  try {
    let r = witness(["play", "start", "--name", "rr", "--config", cfgFile], { cwd: tmp, env });
    ok("e2e: start", r.code === 0, r.out);
    r = witness(["play", "do", "pick play; pick 1", "-s", "rr"], { cwd: tmp, env });
    r = witness(["play", "look", "-s", "rr", "--full"], { cwd: tmp, env });
    ok("e2e: look --full answers", r.code === 0 && /no game call yet|latest call/.test(r.out), r.out);
    r = witness(["play", "end", "-s", "rr", "--fun", "3"], { cwd: tmp, env });
    ok("e2e: end", r.code === 0 && /report:/.test(r.out), r.out);
    const dir = path.join(tmp, "witness", "playtests", "rr");
    const run = JSON.parse(fs.readFileSync(path.join(dir, RUN_CONFIG), "utf8"));
    ok("e2e: witness.run.json in the playtest folder, launch.cwd absolute", run.launch.cwd === tmp && run.launch.args[0] === "game.mjs", JSON.stringify(run.launch));
    const head = JSON.parse(fs.readFileSync(path.join(dir, "replay.jsonl"), "utf8").split("\n")[0]);
    ok("e2e: the replay header records the build (game.mjs)", head.build && head.build.kind === "files" && "game.mjs" in head.build.files, JSON.stringify(head.build));
    const rep = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
    const md = fs.readFileSync(path.join(dir, "report.md"), "utf8");
    const line = (md.split("\n").find((l) => /^witness replay /.test(l)) || "").replace(/\s+#.*$/, "").trim();
    ok("e2e: report.json has the fingerprint; report.md's replay command names the playtest's own config", rep.build && rep.build.hash === head.build.hash && /^witness replay --config witness\/playtests\/rr\/witness\.run\.json witness\/playtests\/rr\/replay\.jsonl$/.test(line) && /Build played: 2 launched files|Build played: 1 launched file/.test(md), line + "\n" + md.slice(md.indexOf("## Reproduce")));
    fs.rmSync(cfgFile);   // the per-run config is gone after the batch
    r = witness(line.split(" ").slice(1), { cwd: tmp, env });
    ok("e2e: report.md's replay command works with the original config gone, and ends in the recorded state, no build warning", r.code === 0 && /ended in exactly the recorded end state/.test(r.out) && !/build changed/.test(r.out), r.out);
    fs.appendFileSync(path.join(tmp, "game.mjs"), "\n// changed\n");
    r = witness(line.split(" ").slice(1), { cwd: tmp, env });
    ok("e2e: a changed build: 'the build changed since this playtest (game.mjs changed)'", /⚠ the build changed since this playtest \(game\.mjs changed\)/.test(r.out), r.out);
    // batch --dry-run: every tester's whole brief, not only the claude command lines
    fs.writeFileSync(path.join(tmp, "witness.json"), JSON.stringify({ name: "High Card", launch: { command: process.execPath, args: ["game.mjs"] }, play: { profile: "turn" } }));
    fs.writeFileSync(path.join(tmp, "goals.txt"), "win a match\nbreak the settings screen\n");
    r = witness(["play", "batch", "--goals", "goals.txt", "--dry-run"], { cwd: tmp, env });
    ok("batch --dry-run: both briefs in full (start line, goal, order card) after each claude line", r.code === 0 && (r.out.match(/----- brief #\d/g) || []).length === 2 && /brief #2 \(newbie\): break the settings screen/.test(r.out) && (r.out.match(/play start --name/g) || []).length === 2 && /-p --model sonnet/.test(r.out) && /end of brief #2/.test(r.out), r.out.slice(0, 2000));
  } finally {
    witness(["play", "stop", "--all"], { cwd: tmp, env });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
