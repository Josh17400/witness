// Witness play: the turn profile (turn-based / card / menu games) and the 0.7.5 play fixes from a real card game
// (Euchre, a pure-DOM web game): choices + pick, wait for your turn, an observation without map/near/cell/movement,
// the turn brief and checklist, no "map knowledge reset" on a scene change, choose judged by any lasting state change,
// notice + log deduped. Unit tests (no processes) against tests/play/turn-game.mjs, then one end-to-end session
// through the real CLI and daemon (settling a crossfade before the tester looks, an exact replay).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseOrders } from "../../src/play/orders.js";
import { NavGrid } from "../../src/play/grid.js";
import { resolvePlayConfig, parsePick } from "../../src/play/config.js";
import { Perceiver, normChoices } from "../../src/play/perceive.js";
import { EventTracker, coalesceEvents } from "../../src/play/events.js";
import { Autopilot } from "../../src/play/autopilot.js";
import { wakeFor } from "../../src/play/wake.js";
import { observeText, observeData } from "../../src/play/observe.js";
import { makeBrief } from "../../src/play/brief.js";
import { checkSnapshot, checkLines, looksTurnBased } from "../../src/play/check.js";
import { CardGame } from "./turn-game.mjs";
import { witness } from "./agent.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL", name, String(extra).slice(0, 3000)); } };

const TURN_PLAY = { profile: "turn", pick: { call: "choose" }, show: ["score", "phase", "hand", "trick", "difficulty"] };

/**
 * The daemon's turn-based loop without processes: `g` = a game object with step()/snapshot()/call(); calls an order
 * makes go straight to it (with the daemon's result fields). `drv.do(text)` → {status, msg, events}.
 */
function driver(g, play = TURN_PLAY) {
  const cfg = resolvePlayConfig(play, { keys: [] });
  const per = new Perceiver(cfg, { fps: 60 });
  let w = per.perceive(g.snapshot(), g.frame);
  const ap = new Autopilot(cfg, { fps: 60, grid: new NavGrid({ cell: w.cell, origin: [0, 0] }), perceiver: per });
  const tr = new EventTracker(cfg, per);
  ap.observe(w); tr.update(null, w, {});
  const inputs = [], pending = [];
  const step = (k) => {
    for (let i = 0; i < k; i++) g.step();
    const nw = per.perceive(g.snapshot(), g.frame);
    ap.observe(nw);
    const ev = tr.update(w, nw, { logs: (g.logs || []).splice(0) });
    for (const e of ap.drainEvents()) ev.push({ t: nw.t, frame: g.frame, ...e });
    w = nw; pending.push(...ev);
    return ev;
  };
  return {
    cfg, ap, tr, inputs, get world() { return w; },
    look(first = false) { return observeText(w, { cfg, ap, events: coalesceEvents(pending.splice(0)), first, session: {} }); },
    do(text, maxFrames = 3600) {
      ap.setOrders(parseOrders(text, { named: cfg.named }));
      const f0 = g.frame, events = [];
      while (g.frame - f0 < maxFrames) {
        const d = ap.decide(w);
        if (d.status === "call") {
          let v, failed = false;
          try { v = g.call(d.name, d.args); } catch (e) { failed = true; v = e.message; }
          if (ap.cur) { ap.cur.result = `called ${d.name}(${d.args.join(", ")}) → ${JSON.stringify(v)}`; ap.cur.callValue = v; ap.cur.callFailed = failed; }
          events.push(...step(1)); continue;
        }
        inputs.push(...ap.ctrl.emit(d.want, g.frame));
        if (d.status !== "run") return { status: d.status, msg: ap.results.length > 1 ? ap.results.map((r) => r.msg).join(" → ") : d.message, events };
        const ev = step(Math.max(1, d.k)); events.push(...ev);
        const b = ap.cur ? { verb: ap.cur.o?.verb } : null;
        const wake = wakeFor(ev, b, { ap, world: w, cfg });
        if (wake) return { status: "interrupted", msg: wake, events };
      }
      return { status: "time", msg: "", events };
    },
  };
}

// ---- config
{
  const c = resolvePlayConfig({ profile: "cards" }, {});
  ok("config: card/menu aliases resolve to the turn profile", c.profile === "turn" && resolvePlayConfig({ profile: "menu" }).profile === "turn" && resolvePlayConfig({}).profile === "topdown");
  ok("config: play.pick forms", parsePick({ call: "choose" }).mode === "call" && parsePick("click").mode === "click" && parsePick("call:pickCard").call === "pickCard" && parsePick(undefined).mode === "auto" && parsePick({ call: "x", args: ["index"] }).args[0] === "index");
  ok("config: call results show 800 characters by default (400 in 0.7.5, 120 before), play.resultChars changes it", c.resultChars === 800 && resolvePlayConfig({ resultChars: 1000 }).resultChars === 1000);
}

// ---- choices
{
  const ch = normChoices(["Play", { label: "Settings", id: "s" }, { text: "Play", value: 3, legal: false }, { name: "Hard", selected: true, disabled: true }]);
  ok("choices: strings and {label,id} objects, duplicate labels get #2, legal/selected flags",
    ch.length === 4 && ch[0].label === "Play" && ch[0].id === "Play" && ch[1].id === "s" && ch[2].label === "Play #2" && ch[2].id === 3 && ch[2].legal === false && ch[3].selected && !ch[3].legal && ch[3].n === 4, JSON.stringify(ch));
  ok("choices: an empty or non-array value is none", normChoices([]) === null && normChoices({ a: 1 }) === null && normChoices(undefined) === null);
}

// ---- a game: home → table, pick cards, wait for your turn
{
  const g = new CardGame(1);
  const d = driver(g);
  for (let i = 0; i < 3; i++) g.step();
  d.do("wait 0.05");
  const first = d.look(true);
  ok("observation: header from the game's fields, choices numbered, the turn order card", /^\[t [^\]]+\] · scene home/.test(first) && /choices \(pick <n> or pick <words>\):\n  1\) Play   2\) Settings/.test(first) && /orders: pick <n\|words>/.test(first), first);
  ok("observation: no cell, no near, no map, no movement controls, no action order card", !/cell \(|near:|map \(|controls: move|goto <thing|fight \[thing/.test(first), first);
  let r = d.do("pick play");
  ok("pick by words → sent through play.pick.call, reports the new screen", r.status === "done" && /picked 1\) "Play" → scene table/.test(r.msg) && g.scene === "table", JSON.stringify(r));
  ok("a scene change in the turn profile: no 'map knowledge reset', no wake", !r.events.some((e) => /map knowledge reset/.test(e.text)) && r.status === "done", r.events.map((e) => e.text).join(" | "));
  const tbl = d.look();
  ok("observation at the table: YOUR TURN, score and phase in the header, hand on its own line, legal cards listed", /YOUR TURN/.test(tbl) && /· score you 0 · bot 0/.test(tbl) && /phase your lead/.test(tbl) && /hand: \w+♠, \w+♥, \w+♦/.test(tbl) && /4\) Menu \(leave match\)/.test(tbl), tbl);
  const data = observeData(d.world, { cfg: d.cfg, ap: d.ap });
  ok("observation --json: fields, choices with ids, yourTurn; no player/near/map", data.profile === "turn" && data.yourTurn === true && data.choices.length === 4 && data.choices[3].id === "menu" && data.fields.difficulty === "easy" && !("near" in data) && !("map" in data), JSON.stringify(data));
  const card = g.choices()[1].label;
  r = d.do("pick 2");
  ok("pick by number → the turn passes", r.status === "done" && new RegExp(`picked 2\\) "${card.replace(/[()]/g, "\\$&")}" → the turn passed`).test(r.msg) && g.yourTurn === false, JSON.stringify(r));
  const t0 = g.frame;
  r = d.do("wait");
  ok("wait: until it's your turn again (the bot played)", r.status === "done" && /^your turn \(3 choices\)/.test(r.msg) && g.yourTurn === true && g.frame - t0 >= 25 && g.frame - t0 < 60, `${JSON.stringify(r)} after ${g.frame - t0} frames`);
  r = d.do("wait");
  ok("wait when it's already your turn: says so at once", r.status === "done" && /already your turn/.test(r.msg), JSON.stringify(r));
  r = d.do("wait 0.3");
  ok("wait <s> while nothing happens: the full time", r.status === "done" && /waited 0\.3s/.test(r.msg), JSON.stringify(r));
  const look2 = d.look();
  const said = (look2.match(/won the trick|took the trick/g) || []).length;
  ok("notice + game log of the same line: one event (was two)", said === 1 || (said === 2 && /game says: "/.test(look2) && (look2.match(/events:.*(won|took) the trick/g) || []).length === 1), look2);
  r = d.do("goto Menu");
  ok("movement orders in the turn profile: a clear refusal with the turn order card", r.status === "fail" && /turn-based \/ menu game/.test(r.msg), JSON.stringify(r));
  r = d.do("pick 1; wait; pick 1; wait");
  ok("the tester's loop (pick N; wait) chains through bot turns to the end of the hand (a win wakes)", (r.status === "done" || /GOAL REACHED/.test(r.msg)) && g.hand.length === 0 && g.scene === "result", JSON.stringify(r));
  const end = d.look();
  ok("the end of the match: GAME OVER or the win, not 'YOU ARE DEAD'", /GAME OVER|GAME WON/.test(end) && !/YOU ARE DEAD/.test(end), end);
  r = d.do("pick home; pick settings; pick hard");
  ok("a toggle that only changes a selected flag: pick reports the change", r.status === "done" && g.difficulty === "hard" && /picked 2\) "Hard" → 3 choices now/.test(r.msg), JSON.stringify(r));
  r = d.do("pick nonsense words");
  ok("pick with words no choice has: lists the choices", r.status === "fail" && /no choice matches "nonsense words" — choices: 1\) Easy  2\) Hard  3\) Back/.test(r.msg), JSON.stringify(r));
  r = d.do("pick 9");
  ok("pick past the last choice: says how many there are", r.status === "fail" && /are 3 choices/.test(r.msg), JSON.stringify(r));
}

// ---- the game refuses a pick (an illegal move)
{
  const g = new CardGame(2);
  const d = driver(g);
  d.do("pick play; pick 1");
  const r = d.do("pick 2");   // not your turn: the game answers {ok: false, error}
  ok("a pick the game refuses: fails with the game's reason", r.status === "fail" && /the game refused it \("not your turn"\)/.test(r.msg), JSON.stringify(r));
}

// ---- pick by key (a choice's own key) and by number keys
{
  const S = { frame: 0, q: [], sel: null, step() { for (const e of this.q.filter((e) => e.frame <= this.frame)) if (e.type === "key" && e.down) this.sel = e.key; this.q = this.q.filter((e) => e.frame > this.frame); this.frame++; },
    snapshot() { return { frame: this.frame, time: this.frame / 60, state: { yourTurn: true, picked: this.sel, choices: [{ label: "Hit", id: "hit", key: "h" }, { label: "Stand", id: "stand" }] } }; } };
  const d = driver(S, { profile: "turn" });
  const run = (txt) => { const r0 = d.do(txt); S.q.push(...d.inputs.splice(0)); return r0; };
  // inputs go to the game as the driver emits them: feed them in, step, then judge
  d.ap.setOrders(parseOrders("pick hit", {}));
  let dec = d.ap.decide(d.world); S.q.push(...d.ap.ctrl.emit(dec.want, S.frame));
  let r = { status: "run" };
  for (let i = 0; i < 40 && r.status === "run"; i++) { for (let k = 0; k < 3; k++) S.step(); const w = new Perceiver(d.cfg).perceive(S.snapshot(), S.frame); d.ap.observe(w); dec = d.ap.decide(w); S.q.push(...d.ap.ctrl.emit(dec.want, S.frame)); r = dec; }
  ok("pick: a choice with its own key presses that key, and a lasting state change counts", S.sel === "h" && r.status === "done" && /state changed \(picked\)/.test(r.message), `${S.sel} ${JSON.stringify(r)}`);
  void run;
}

// ---- choose: a dialogue option that only toggles something (the difficulty select) is a success, worded honestly
{
  const S = { frame: 0, q: [], difficulty: "normal", step() { for (const e of this.q.filter((e) => e.frame <= this.frame)) if (e.type === "key" && e.down && /^[1-3]$/.test(e.key)) this.difficulty = ["easy", "normal", "hard"][+e.key - 1]; this.q = this.q.filter((e) => e.frame > this.frame); this.frame++; },
    snapshot() { return { frame: this.frame, time: this.frame / 60, state: { clock: this.frame, difficulty: this.difficulty, dialogue: { speaker: "Setup", text: "Pick a difficulty", options: ["Easy", "Normal", "Hard"] }, player: { pos: [1, 1], hp: 5 } } }; } };
  const cfg = resolvePlayConfig({ controls: { choose: "numbers" } }, { keys: ["1", "2", "3"] });
  const per = new Perceiver(cfg, { fps: 60 });
  let w = per.perceive(S.snapshot(), 0);
  const ap = new Autopilot(cfg, { fps: 60, grid: new NavGrid({ cell: w.cell, origin: [0, 0] }), perceiver: per });
  ap.observe(w); ap.setOrders(parseOrders("choose 3", {}));
  let dec;
  for (let i = 0; i < 100; i++) { dec = ap.decide(w); S.q.push(...ap.ctrl.emit(dec.want, S.frame)); if (dec.status !== "run") break; for (let k = 0; k < Math.max(1, dec.k); k++) S.step(); w = per.perceive(S.snapshot(), S.frame); ap.observe(w); }
  ok("choose: the dialogue didn't change but the state did → done, says what changed (a ticking clock doesn't count)", dec.status === "done" && /chose 3\) "Hard": state changed \(difficulty\), dialogue unchanged/.test(dec.message) && S.difficulty === "hard", JSON.stringify(dec));
  // nothing changes at all: still a failure, worded for both
  const S2 = { ...S, frame: 0, q: [], difficulty: "normal", step() { this.frame++; } };
  const per2 = new Perceiver(cfg, { fps: 60 });
  let w2 = per2.perceive(S2.snapshot.call(S2), 0);
  const ap2 = new Autopilot(cfg, { fps: 60, grid: new NavGrid({ cell: w2.cell, origin: [0, 0] }), perceiver: per2 });
  ap2.observe(w2); ap2.setOrders(parseOrders("choose 2", {}));
  for (let i = 0; i < 200; i++) { dec = ap2.decide(w2); ap2.ctrl.emit(dec.want, S2.frame); if (dec.status !== "run") break; for (let k = 0; k < Math.max(1, dec.k); k++) S2.step(); w2 = per2.perceive(S2.snapshot.call(S2), S2.frame); ap2.observe(w2); }
  ok("choose: nothing changed at all → fails, saying neither the dialogue nor the state changed", dec.status === "fail" && /nothing changed: not the dialogue, not the game state/.test(dec.message), JSON.stringify(dec));
}

// ---- events: a notice and a log line with the same words are one event
{
  const cfg = resolvePlayConfig({}, {});
  const per = new Perceiver(cfg, { fps: 60 });
  const tr = new EventTracker(cfg, per);
  const snap = (f, notice) => ({ frame: f, time: f / 60, state: { notice, player: { pos: [0, 0], hp: 3 } } });
  const w0 = per.perceive(snap(0, null), 0); tr.update(null, w0, {});
  const w1 = per.perceive(snap(1, "Quest updated!"), 1);
  const e1 = tr.update(w0, w1, {});
  const w2 = per.perceive(snap(16, "Quest updated!"), 16);
  const e2 = tr.update(w1, w2, { logs: [{ level: "info", message: "Quest updated!" }, { level: "info", message: "Another line" }] });
  ok("events: the notice shows, its log line a few frames later doesn't repeat it, other logs still do", e1.filter((e) => e.kind === "notice").length === 1 && !e2.some((e) => e.kind === "log" && /Quest/.test(e.text)) && e2.some((e) => e.kind === "log" && /Another line/.test(e.text)), JSON.stringify([e1, e2]));
}

// ---- brief, checklist, suggest's detection
{
  const b = makeBrief({ cli: "witness", configDir: "C:/g", profile: "turn", persona: "breaker", goal: "win a match" });
  ok("brief (turn): pick/wait orders and turn-game tips; no walls, aiming, map or 'nearest enemy'", /pick <n\|words>/.test(b) && /pick <n>; wait/.test(b) && /moves that shouldn't be allowed/.test(b) && !/walls|aiming|nearest enemy|a small map|weapon for the range|WINDUP/.test(b), b);
  const topdown = makeBrief({ cli: "witness", configDir: "C:/g", profile: "topdown" });
  ok("brief (topdown) unchanged: walls, aiming, map", /walking around walls, aiming/.test(topdown) && /a small map/.test(topdown) && !/pick <n\|words>/.test(topdown));
  const st = new CardGame(1).state();
  const items = checkSnapshot(st, "turn"), byKey = Object.fromEntries(items.map((i) => [i.key, i]));
  const lines = checkLines(items);
  ok("play check (turn): choices, turn, score, phase, outcome present; no player/map/facing items", byKey.choices.ok && byKey.turn.ok && byKey.score.ok && byKey.phase.ok && byKey.outcome.ok && !byKey.map && !byKey.player && !byKey.facing && !/missing/.test(lines.at(-1)), lines.join("\n"));
  const bare = checkSnapshot({ scene: "x" }, "turn");
  ok("play check (turn): a game without choices or turn lists those as missing", bare.find((i) => i.key === "choices").ok === false && bare.find((i) => i.key === "turn").ok === false);
  ok("turn detection (play suggest / check): choices or yourTurn and no player position", looksTurnBased(st) && looksTurnBased({ yourTurn: false }) && !looksTurnBased({ choices: ["a"], player: { pos: [1, 2] } }) && !looksTurnBased({ player: { pos: [1, 2] }, entities: [] }));
}

// ---- end to end: the real CLI and daemon on the card game (one game process)
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "witness-turn-"));
  const env = { WITNESS_PLAY_REGISTRY: path.join(tmp, "registry"), WITNESS_PLAY_MAX: "3" };
  fs.writeFileSync(path.join(tmp, "witness.json"), JSON.stringify({ name: "High Card", launch: { command: process.execPath, args: [path.join(here, "turn-game.mjs")] }, play: { ...TURN_PLAY, show: ["score", "phase", "hand", "transition"] } }));
  try {
    let r = witness(["play", "check"], { cwd: tmp, env });
    ok("e2e: play check scores the card game by the turn checklist", r.code === 0 && /\(turn, seed 1\)/.test(r.out) && /playtest-ready/.test(r.out) && !/missing/.test(r.out), r.out);
    r = witness(["play", "start", "--name", "c1", "--goal", "win a match"], { cwd: tmp, env });
    ok("e2e: start shows the turn observation", r.code === 0 && /choices \(pick/.test(r.out) && /1\) Play/.test(r.out) && !/cell \(|near:/.test(r.out), r.out);
    r = witness(["play", "shot", "-s", "c1"], { cwd: tmp, env });
    const shot = r.out.trim().split(/\r?\n/).pop().replace(/^screenshot:\s*/, "");
    let red = null; try { const { decodePNG } = await import("../../src/media/png.js"); const im = decodePNG(fs.readFileSync(shot)); red = im.data[0]; } catch (e) { red = `n/a: ${e.message}`; }
    ok("e2e: play shot right after start waits out the title fade-in (the picture is the settled screen)", r.code === 0 && fs.existsSync(shot) && red === 0 && !(/^n\/a/.test(String(red))), `${r.out} red=${red}`);
    r = witness(["play", "do", "pick play", "-s", "c1", "--json"], { cwd: tmp, env });
    let j = null; try { j = JSON.parse(r.out); } catch { /* below */ }
    ok("e2e: a pick that changed the scene settles the crossfade before answering (transition 0)", j && j.scene === "table" && j.fields.transition === 0 && /picked 1\) "Play" → scene table/.test(j.result.line), r.out);
    r = witness(["play", "do", "pick 1; wait", "-s", "c1"], { cwd: tmp, env });
    ok("e2e: pick a card; wait for your turn", r.code === 0 && /your turn/.test(r.out) && /YOUR TURN/.test(r.out), r.out);
    r = witness(["play", "end", "-s", "c1", "--fun", "3", "--difficulty", "2", "--feedback", "fine"], { cwd: tmp, env });
    ok("e2e: end", r.code === 0 && /report:/.test(r.out), r.out);
    const dir = path.join(tmp, "witness", "playtests", "c1");
    r = witness(["replay", path.join(dir, "replay.jsonl")], { cwd: tmp, env });
    ok("e2e: the replay (picks are recorded calls, settles are plain frames) ends in exactly the recorded state", r.code === 0 && /ended in exactly the recorded end state/.test(r.out), r.out);
    const rep = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
    ok("e2e: the report has no map coverage for a turn game", !rep.coverage && rep.profile === "turn", JSON.stringify(rep.coverage));
  } finally {
    witness(["play", "stop", "--all"], { cwd: tmp, env });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
