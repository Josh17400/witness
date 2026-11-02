// Witness play 0.7.13: what a tester can see and hear, and how a session ending is told. Units (no processes): long
// stats on their own lines, sounds (state.sounds, "sound:" logs, sound events, perf.audio_started), the shot capture
// choice, "choose 1 if open" and a chain going on past a choose with nothing open, host-sleep detection and the exit
// verdict (interrupted / browser closed / exited / crashed). End to end with the mock game (node): the events line's
// sounds, the skipped choose, a session interrupted by a (simulated) sleep, a real crash after one. With Playwright:
// a canvas game with DOM buttons over it (the screen is captured, the shot line says so) whose WebAudio press is counted.
// Run: node tests/play/senses.mjs (browser part: WITNESS_PLAYWRIGHT=<dir with playwright>, one browser at a time).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { witness } from "./agent.mjs";
import { parseOrders } from "../../src/play/orders.js";
import { resolvePlayConfig } from "../../src/play/config.js";
import { Perceiver } from "../../src/play/perceive.js";
import { NavGrid } from "../../src/play/grid.js";
import { Autopilot } from "../../src/play/autopilot.js";
import { observeText, statParts, wrapText } from "../../src/play/observe.js";
import { SoundLog, soundsText, soundOfLog } from "../../src/play/sounds.js";
import { SleepWatch, exitVerdict } from "../../src/play/interrupt.js";
import { chooseCapture } from "../../src/play/shotui.js";
import { decodePNG } from "../../src/media/png.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL", name, String(typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 3000)); } };

// ---- 3. long stats: own lines, wrapped, cut at 300 with a note; short ones stay on the header line
{
  const powers = "Gunship (2 charges, ready) / Mark Target (1 charge, ready) / Fortify (2 charges, needs 1 more) / Rally (1 charge) / Barrage (2 charges) (meter 1.4)";
  const sp = statParts({ wave: 36, cash: 1200, powers });
  ok("stats: short ones on the header, a long one on its own line(s)", sp.head.join(" · ") === "wave 36 · cash 1200" && sp.lines[0].startsWith("powers: Gunship (2 charges, ready)") && sp.lines.every((l) => l.length <= 100) && sp.lines.length >= 2 && sp.lines.slice(1).every((l) => l.startsWith("  ")) && sp.lines.join(" ").replace(/\s+/g, " ").includes("(meter 1.4)"), sp);
  const huge = statParts({ log: "x ".repeat(400) });
  ok("stats: a very long one is cut at 300 chars with a note (look --full: whole)", /… \(cut at 300 of 799 chars: look --full shows all\)$/.test(huge.lines.join(" ")) && !/cut/.test(statParts({ log: "x ".repeat(400) }, { full: true }).lines.join(" ")), huge.lines.at(-1));
  ok("wrapText: words kept whole, continuation indented", JSON.stringify(wrapText("aaa bbb ccc", 8)) === JSON.stringify(["aaa bbb", "  ccc"]));
  // the defense observation (The Fort): the powers stat isn't "…"-clipped at 20 any more
  const cfg = resolvePlayConfig({ profile: "defense", stats: [{ label: "wave", expr: "state.wave" }, { label: "powers", expr: "state.powers" }] }, {});
  const per = new Perceiver(cfg, { fps: 60 });
  const w = per.perceive({ frame: 1, time: 1, state: { wave: 36, powers, player: { pos: [0, 0], hp: 50, maxHp: 100 }, entities: [] } }, 1);
  const txt = observeText(w, { cfg, ap: null, events: [{ t: 1, kind: "log", text: 'game: "Fortify needs 2 charges"' }], sounds: "sounds: deny" });
  const L = txt.split("\n");
  ok("defense observation: header keeps wave, the powers line follows it whole", /· wave 36$/.test(L[0]) && /^powers: Gunship/.test(L[1]) && txt.includes("(meter 1.4)") && !/powers Gunship/.test(L[0]), txt);
  ok("observation: sounds ride on the events line", /^events: 1 game: "Fortify needs 2 charges" · sounds: deny$/m.test(txt), txt);
  const t2 = observeText(w, { cfg, ap: null, events: [], sounds: "sounds: 2 played" });
  ok("observation: sounds alone still get an events line", /^events: sounds: 2 played$/m.test(t2), t2);
}

// ---- 2. sounds
{
  const s = new SoundLog();
  s.fromState({ sounds: ["deny"] }); s.fromState({ sounds: ["deny"] }); s.fromState({ sounds: ["hit", "hit"] }); s.fromState({ sounds: [] }); s.fromState({ sounds: ["hit"] });
  ok("state.sounds per snapshot: names counted, an unchanged list not re-heard", soundsText(s.take()) === "sounds: deny, hit ×3", JSON.stringify([...s.names]));
  const g = new SoundLog();
  g.fromState({ sounds: ["a"] }); g.take(); g.fromState({ sounds: ["a", "b", "c"] });
  ok("state.sounds that only grows: its new tail", soundsText(g.take()) === "sounds: b, c");
  const r = new SoundLog();
  r.fromState({ sounds: ["x", "y"], soundCount: 10 }); r.fromState({ sounds: ["y", "deny", { name: "hit" }], soundCount: 12 });
  r.fromState({ sounds: { count: 13, recent: ["deny", "hit", "boom"] } });
  ok("rolling list with a counter (soundCount, or {count, recent}): only the new entries", soundsText(r.take()) === "sounds: deny, hit, boom", JSON.stringify([...r.names]));
  const l = new SoundLog();
  const rest = l.fromLogs([{ level: "info", message: "sound: deny" }, { level: "info", message: "sound hit" }, { level: "info", message: "Wave 3" }, { level: "warn", message: "sound: odd" }]);
  ok("log lines: 'sound: deny' and witness.log('sound', 'hit') named and taken; others handed back", soundsText(l.take()) === "sounds: deny, hit" && rest.length === 2 && rest[0].message === "Wave 3" && soundOfLog("[sound] beep") === "beep" && soundOfLog("soundtrack on") === null && soundOfLog("sounds good") === null, rest);
  ok("log lines: an ordinary message starting with 'Sound' stays a game message", soundOfLog("Sound muted") === null && soundOfLog("sound engine failed to init") === null && soundOfLog("SOUND: X") === "X");
  const e = new SoundLog(); e.fromEvents([{ event: "sound", name: "swing" }, { event: "sound", name: "swing" }]);
  ok("sound events (witness.sound): named", soundsText(e.take()) === "sounds: swing ×2");
  const p = new SoundLog();
  ok("perf without a counter: off for good", p.fromPerf({ frame_ms: 1 }) === false && p.perfAudio === false);
  const q = new SoundLog(); q.fromPerf({ audio_started: 5 }); q.fromPerf({ audio_started: 7 });
  const q1 = q.take(); q.fromPerf({ audio_started: 1 });
  ok("perf.audio_started: unnamed starts counted (a reset's zeroed counter too)", soundsText(q1) === "sounds: 2 played" && soundsText(q.take()) === "sounds: 1 played" && q.channel);
  ok("sounds: none only when asked (an order ran on a game that can tell)", soundsText(null) === null && soundsText(null, { quietOk: true }) === "sounds: none");
}

// ---- 1. the shot capture choice
{
  const web = { captureMode: "canvas", page: {} };
  const ui = async () => ({ count: 4, labels: ["LOCK ON", "FRAG", "AIR"] }), none = async () => ({ count: 0, labels: [] });
  const a = await chooseCapture("auto", web, ui), b = await chooseCapture("auto", web, none), c = await chooseCapture("canvas", web, ui), d = await chooseCapture("screen", web, none);
  ok("auto: buttons/text over the canvas → the screen, named in the note", a.mode === "screen" && /the screen: the page has 4 buttons\/text over or next to the canvas \("LOCK ON", "FRAG", "AIR", …\)/.test(a.note), a);
  ok("auto: nothing over it → the canvas; canvas / screen forced by play.shotCapture", b.mode === "canvas" && /no page buttons/.test(b.note) && c.mode === "canvas" && /play\.shotCapture "canvas"/.test(c.note) && d.mode === "screen", [b, c, d]);
  const n = await chooseCapture("auto", null, ui), dom = await chooseCapture("canvas", { captureMode: "screen", domPage: true }, ui), bad = await chooseCapture("auto", web, async () => { throw new Error("x"); });
  ok("not a browser game: its own screenshot, no note; a DOM page stays the screen; a probe that fails → canvas", n.mode === "game" && n.note === null && dom.mode === "screen" && /no canvas/.test(dom.note) && bad.mode === "canvas" && bad.note === null, [n, dom, bad]);
  let msg = "";
  try { resolvePlayConfig({ shotCapture: "window" }, {}); } catch (e2) { msg = e2.message; }
  ok("play.shotCapture: default auto; a bad value refused with the choices", resolvePlayConfig({}, {}).shotCapture === "auto" && resolvePlayConfig({ shotCapture: "Screen" }, {}).shotCapture === "screen" && /use "auto".*"screen" or "canvas"/.test(msg), msg);
}

// ---- 4. choose with nothing open: a skip, the chain goes on; an open dialogue without the option still fails
{
  const o = parseOrders("choose 1 if open; pick 'get it back' if any")[0], o2 = parseOrders("pick 'get it back' if any")[0];
  ok("parse: 'choose 1 if open' / 'pick <words> if any'", o.verb === "choose" && o.option === 1 && o.ifOpen === true && o2.optionText === "get it back" && o2.ifOpen === true && parseOrders("choose 2")[0].ifOpen === undefined, [o, o2]);
  const o3 = parseOrders("choose ask if it is safe")[0], o4 = parseOrders("choose see if any are left")[0];
  ok("parse: 'if any/it' inside the option text isn't the skip suffix", o3.optionText === "ask if it is safe" && !o3.ifOpen && o4.optionText === "see if any are left" && !o4.ifOpen, [o3, o4]);
  const mk = (dialogue) => {
    const S = { frame: 0, step() { this.frame++; }, snapshot() { return { frame: this.frame, time: this.frame / 60, state: { player: { pos: [0, 0], hp: 10, maxHp: 10 }, entities: [], ...(dialogue ? { dialogue } : {}) } }; } };
    return (text, profile = "defense") => {
      const cfg = resolvePlayConfig({ profile, cell: 1, controls: { choose: "numbers" } }, { keys: ["1", "2", "3"] }), per = new Perceiver(cfg, { fps: 60 });
      let w = per.perceive(S.snapshot(), S.frame);
      const ap = new Autopilot(cfg, { fps: 60, grid: new NavGrid({ cell: w.cell, origin: [0, 0] }), perceiver: per });
      ap.observe(w); ap.setOrders(parseOrders(text, { named: cfg.named }));
      let dec;
      for (let i = 0; i < 3000; i++) { dec = ap.decide(w); if (dec.status !== "run") break; for (let k = 0; k < Math.max(1, dec.k); k++) S.step(); w = per.perceive(S.snapshot(), S.frame); ap.observe(w); }
      return { dec, results: ap.results };
    };
  };
  let r = mk(null)("choose 1; wait 1");
  ok("no dialogue: 'choose 1; wait 1' skips the choose and runs the wait", r.dec.status === "done" && r.results.length === 2 && r.results[0].skipped && /^skipped choose 1: no dialogue open/.test(r.results[0].msg) && r.results[1].status === "done", r.results);
  r = mk(null)("choose 1 if open; wait 1");
  ok("'choose 1 if open': the same skip, no advice appended", r.results[0].skipped && r.results[0].msg === "skipped choose 1 if open: no dialogue open" && r.results.length === 2, r.results);
  r = mk(null)("pick 2; wait 1", "turn");
  ok("turn profile: a pick with no choices or dialogue is a skip too", r.results[0].skipped && /no choices or dialogue open/.test(r.results[0].msg) && r.results.length === 2, r.results);
  r = mk({ text: "Pick one", options: ["A", "B"] })("choose 3; wait 1");
  ok("an open dialogue without option 3: still a failure, the chain stops", r.dec.status === "fail" && /only 2 options/.test(r.dec.message) && r.results.length === 1, r.results);
}

// ---- 6. host sleep and the exit verdict
{
  const sw = new SleepWatch();
  sw.tick(1000, 1000); sw.tick(3000, 3000);
  ok("sleep watch: an on-time tick is no sleep", sw.sleeps.length === 0);
  const s1 = sw.tick(3000 + 2000 + 600000, 5000 + 600000, 110.2);
  ok("sleep watch: a tick 10 min late is a sleep (t noted)", s1 && s1.gapS === 600 && s1.t === 110.2 && sw.recent(3000 + 2000 + 600000 + 5000), s1);
  const sw2 = new SleepWatch(); sw2.tick(0, 0); const s2 = sw2.tick(2000 + 90000, 2000);
  ok("sleep watch: the wall clock jumping past the monotonic one is a sleep", s2 && s2.gapS >= 90, s2);
  ok("sleep watch: an old sleep isn't recent", !sw.recent(3000 + 2000 + 600000 + 400000));
  const biquad = ["[page] BiquadFilter.frequency.value 13668.8 outside nominal range [0, 12000]; value will be clamped."];
  const v = (x) => exitVerdict(x).outcome;
  ok("verdict: the closed laptop (The Fort v11late): web, slept, harmless warnings → interrupted", v({ web: true, slept: { gapS: 600 }, lines: biquad }) === "interrupted");
  ok("verdict: the browser went away with no game error → browser closed", v({ web: true, lines: biquad }) === "browser closed");
  ok("verdict: a game error just before → crashed, even after a sleep", v({ web: true, slept: { gapS: 60 }, gameError: true }) === "crashed" && v({ web: true, lines: ["[error] TypeError: x is undefined"] }) === "crashed");
  ok("verdict: a fatal line / stack in the last output → crashed, even after a sleep", v({ code: 3, slept: { gapS: 60 }, lines: ["mock: fatal: out of cheese"] }) === "crashed" && v({ code: 1, lines: ["    at update (game.js:12:5)"] }) === "crashed");
  ok("verdict: a native game: code 0 and no error → exited; nonzero → crashed; after a sleep → interrupted", v({ code: 0 }) === "exited" && v({ code: 3 }) === "crashed" && v({ code: null }) === "crashed" && v({ code: 1, slept: { gapS: 30 } }) === "interrupted");
  ok("verdict: after a sleep a stray console error / promise rejection doesn't outrank it", v({ web: true, slept: { gapS: 3000 }, lines: ["[error] Failed to load resource: the server responded with a status of 404 (Not Found)", "[page error] Uncaught (in promise) NotAllowedError: play() failed"] }) === "interrupted");
  ok("verdict: the page crashed (renderer died) → crashed, even with no error or after a sleep", v({ web: true, pageCrashed: true }) === "crashed" && v({ web: true, slept: { gapS: 60 }, pageCrashed: true }) === "crashed");
}

// ---- end to end with the mock game (node processes, one at a time)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "witness-play-senses-"));
const env = { WITNESS_PLAY_REGISTRY: path.join(tmp, "registry"), WITNESS_PLAY_MAX: "3" };
const mockJs = path.join(root, "tests", "mock-game.mjs");
const proj = (name, cfg) => { const d = path.join(tmp, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, "witness.json"), JSON.stringify(cfg)); return d; };
const mock = proj("mock", { name: "Mock Coins", launch: { command: process.execPath, args: [mockJs] }, play: { controls: { attack: "j" } } });
const w = (args, extra = {}) => witness(args, { cwd: mock, env: { ...env, ...extra } });
const pidAlive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const dirOf = (name) => path.join(mock, "witness", "playtests", name);
const report = (name) => JSON.parse(fs.readFileSync(path.join(dirOf(name), "report.json"), "utf8"));
const session = (name) => JSON.parse(fs.readFileSync(path.join(dirOf(name), "session.json"), "utf8"));
const gone = async (name) => { const pid = session(name).pid; for (let i = 0; i < 40 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 300)); return !pidAlive(pid); };
{
  const snd = { MOCK_SOUNDS: "1" };
  let r = w(["play", "start", "--name", "sn"], snd);
  ok("mock: session starts", r.code === 0, r.out);
  r = w(["play", "do", "press j; wait 0.5", "-s", "sn"], snd);
  ok("mock: a press that plays a sound → 'sounds: swing' on the events line", /^events: .*sounds: swing$/m.test(r.out), r.out);
  r = w(["play", "do", "press j; wait 0.5", "-s", "sn"], snd);
  ok("mock: the second press (the planted cooldown) plays nothing → 'sounds: none'", /^events: .*sounds: none$/m.test(r.out) || /^events: sounds: none$/m.test(r.out), r.out);
  r = w(["play", "do", "choose 1; wait 0.5", "-s", "sn"], snd);
  ok("mock: 'choose 1; wait 0.5' with no dialogue: ↷ skipped, then ✔ wait", /↷ skipped choose 1: no dialogue open/.test(r.out) && /✔ wait 0\.5/.test(r.out) && /✔ done/.test(r.out), r.out);
  w(["play", "end", "-s", "sn"]);
  ok("mock: the skipped choose is in the report's order line", /↷ skipped choose 1/.test(report("sn").orders.at(-1).msg || ""), report("sn").orders.at(-1));

  // a (simulated) sleep, then the game goes away with no error: session interrupted, not GAME CRASHED
  const slept = { WITNESS_PLAY_FAKE_SLEEP: "600" };
  r = w(["play", "start", "--name", "zz"], slept);
  const gp = session("zz").gamePid;
  try { process.kill(gp); } catch { /* gone */ }
  ok("sleep: the daemon ends by itself", await gone("zz"));
  let rep = report("zz");
  const md = fs.readFileSync(path.join(dirOf("zz"), "report.md"), "utf8");
  ok("sleep: outcome interrupted, the reason says the machine slept, not a crash", rep.outcome === "interrupted" && /session interrupted \(the machine slept or the browser was closed\) at t=.*the machine slept for ~600s.*not a game crash/.test(rep.endReason || ""), { o: rep.outcome, e: rep.endReason });
  ok("sleep: report.md headline SESSION INTERRUPTED, no GAME CRASHED", /— SESSION INTERRUPTED/.test(md) && !/GAME CRASHED/.test(md), md.slice(0, 400));
  r = w(["play", "end", "-s", "zz", "--feedback", "late words"]);
  ok("sleep: END afterwards is told the session was interrupted", /already ended \(session interrupted/.test(r.out), r.out);

  // a real crash after a sleep stays CRASHED (its last output reads like one)
  const crash = { ...slept, MOCK_EXIT_AT: "30" };
  w(["play", "start", "--name", "zc"], crash);
  r = w(["play", "do", "wait 5", "-s", "zc"], crash);
  ok("sleep + a real crash: still 'the game exited (code 3)'", /game exited \(code 3\) at t=0\.5s/.test(r.out) && !/interrupted/.test(r.out), r.out);
  ok("sleep + a real crash: outcome crashed", await gone("zc") && report("zc").outcome === "crashed", report("zc").outcome);
}

// ---- with a browser: DOM buttons over the canvas, a WebAudio press (one browser; WITNESS_BUDGET_WAIT respected)
function findPlaywright() {
  for (const dir of [process.env.WITNESS_PLAYWRIGHT, path.join(root, "examples", "js-browser"), root].filter(Boolean)) {
    try { createRequire(path.join(dir, "package.json")).resolve("playwright"); return dir; } catch { /* next */ }
  }
  return null;
}
const pwDir = findPlaywright();
if (!pwDir || process.env.WITNESS_SKIP_BROWSER) console.log("  browser part skipped (no Playwright)");
else {
  const site = path.join(tmp, "site");
  fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><title>Overlay</title>
<style>html,body{margin:0;background:#000}#wrap{position:relative;width:320px;height:200px}canvas{display:block;width:320px;height:200px}
#hud{position:absolute;right:6px;bottom:6px;display:flex;gap:4px}#hud button{font:12px sans-serif;padding:4px 6px;background:#c33;color:#fff;border:0}#hidden{display:none}</style></head>
<body><div id="wrap"><canvas id="game" width="320" height="200"></canvas><div id="hud"><button>LOCK ON</button><button>FRAG</button><button id="hidden">SECRET</button></div></div>
<script type="module">
import witness from "/witness/witness.js";
const c = document.getElementById("game"), g = c.getContext("2d");
let audio = null, presses = 0;
addEventListener("keydown", (e) => { if (e.key === "3") { presses++; audio ??= new AudioContext(); const o = audio.createOscillator(); o.connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.05); } });
function draw() { g.fillStyle = "#246"; g.fillRect(0, 0, 320, 200); requestAnimationFrame(draw); }
requestAnimationFrame(draw);
await witness.start({ name: "Overlay", fps: 60, size: [320, 200], canvas: c, keys: ["3"], snapshot: () => ({ presses, player: { pos: [0, 0], hp: 10, maxHp: 10 }, entities: [] }) });
</script></body></html>`);
  const adapter = path.join(root, "adapters", "js", "witness.js");
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x").pathname;
    const f = u === "/witness/witness.js" ? adapter : u === "/" || u === "/index.html" ? path.join(site, "index.html") : null;
    if (!f) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : "text/html" }); res.end(fs.readFileSync(f));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/index.html`;
  const benv = { ...env, WITNESS_PLAYWRIGHT: pwDir, WITNESS_BUDGET_WAIT: process.env.WITNESS_BUDGET_WAIT || "1800" };
  const web = proj("web", { name: "overlay", launch: { url, size: [480, 320] }, seed: 1, play: { profile: "defense", controls: { power: "3" }, map: false } });
  const wb = (args) => new Promise((res) => {   // async: the test's own server must keep answering while the CLI runs
    import("node:child_process").then(({ spawn }) => {
      const p = spawn(process.execPath, [path.join(root, "bin", "witness.js"), ...args], { cwd: web, env: { ...process.env, ...benv } });
      let out = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
      p.on("close", (code) => res({ code, out }));
    });
  });
  try {
    let r = await wb(["play", "start", "--name", "ov"]);
    ok("web: session starts", r.code === 0, r.out);
    r = await wb(["play", "shot", "-s", "ov"]);
    const file = (/^screenshot: (.+)$/m.exec(r.out) || [])[1];
    ok("web: play shot says it captured the screen because of the buttons over the canvas (the hidden one not counted)", /captured the screen: the page has 2 buttons\/text over or next to the canvas \("LOCK ON", "FRAG"\)/.test(r.out), r.out);
    const im = file && fs.existsSync(file.trim()) ? decodePNG(fs.readFileSync(file.trim())) : null;
    ok("web: the picture is the viewport (480×320 CSS px at the device's pixels), not the 320×200 canvas", im && im.width >= 480 && im.height >= 320 && im.width / im.height === 1.5, im && [im.width, im.height]);
    r = await wb(["play", "look", "--shot", "-s", "ov"]);
    ok("web: look --shot prints the capture line before the screenshot path", /^captured the screen: .*\n(screenshot: .+)$/m.test(r.out), r.out);
    r = await wb(["play", "do", "press 3; wait 0.3", "-s", "ov"]);
    ok("web: a WebAudio press with no sound names → 'sounds: 1 played'", /sounds: 1 played/.test(r.out), r.out);
    r = await wb(["play", "do", "wait 0.3", "-s", "ov"]);
    ok("web: an order with no sound → 'sounds: none'", /sounds: none/.test(r.out), r.out);
    await wb(["play", "end", "-s", "ov"]);
    const rep = JSON.parse(fs.readFileSync(path.join(web, "witness", "playtests", "ov", "report.json"), "utf8"));
    ok("web: key-moment shots record the capture used", (rep.shots || []).some((s) => s.capture === "screen"), rep.shots);
  } finally { srv.close(); }
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a daemon still closing */ }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
