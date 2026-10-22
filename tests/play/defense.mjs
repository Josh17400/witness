// Witness play: the defense profile (static / tower / base defense: you never move, enemies come in waves) and the
// 0.7.6 play fixes from a real tap-to-shoot defense game (The Fort): alerts that don't break waits, "wait N quiet",
// a fight that ends on its own time as a success and waits for the next wave, attack "tap:target", no move control
// needed, call answers judged (false / {ok: false} / a throw fail, no result is said plainly), longer call results and
// look --full, backticks in play.brief. Unit tests (no processes) against tests/play/defense-game.mjs, then one
// end-to-end session through the real CLI and daemon (touch taps recorded, an exact replay).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseOrders } from "../../src/play/orders.js";
import { NavGrid } from "../../src/play/grid.js";
import { resolvePlayConfig, parseControl, controlLabel, describeControls } from "../../src/play/config.js";
import { Perceiver } from "../../src/play/perceive.js";
import { EventTracker, coalesceEvents } from "../../src/play/events.js";
import { Autopilot, screenOf, refusalOf } from "../../src/play/autopilot.js";
import { wakeFor } from "../../src/play/wake.js";
import { observeText, observeData } from "../../src/play/observe.js";
import { makeBrief } from "../../src/play/brief.js";
import { checkSnapshot } from "../../src/play/check.js";
import { FortGame } from "./defense-game.mjs";
import { witness } from "./agent.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL", name, String(extra).slice(0, 3000)); } };

const DEF_PLAY = { profile: "defense", cell: 10, alert: 8, controls: { attack: "j" } };

/**
 * The daemon's loop without processes: inputs go to the game, calls straight to it (worded like the daemon's), and the
 * wake rules apply. `drv.do(text)` → {status, msg, events}.
 */
function driver(g, play = DEF_PLAY, size = [320, 180]) {
  const cfg = resolvePlayConfig(play, { keys: ["j", "p"] });
  const per = new Perceiver(cfg, { fps: 60 });
  let w = per.perceive(g.snapshot(), g.frame);
  const ap = new Autopilot(cfg, { fps: 60, grid: new NavGrid({ cell: w.cell, origin: [0, 0] }), perceiver: per, size });
  const tr = new EventTracker(cfg, per);
  ap.observe(w); tr.update(null, w, {});
  const inputs = [], pending = [];
  const step = (k) => {
    for (let i = 0; i < k; i++) g.step();
    const nw = per.perceive(g.snapshot(), g.frame);
    ap.observe(nw);
    const ev = tr.update(w, nw, { lastAttackT: ap.lastAttackT, logs: (g.logs || []).splice(0) });
    for (const e of ap.drainEvents()) ev.push({ t: nw.t, frame: g.frame, ...e });
    w = nw; pending.push(...ev);
    return ev;
  };
  return {
    cfg, ap, tr, inputs, get world() { return w; }, step,
    look(first = false) { return observeText(w, { cfg, ap, events: coalesceEvents(pending.splice(0)), first, session: {} }); },
    do(text, maxFrames = 3600) {
      const list = parseOrders(text, { named: cfg.named });
      ap.setOrders(list);
      const f0 = g.frame, events = [];
      while (g.frame - f0 < maxFrames) {
        const d = ap.decide(w);
        if (d.status === "call") {
          let v, failed = false;
          try { v = g.call(d.name, d.args); } catch (e) { failed = true; v = e.message; }
          if (ap.cur) { ap.cur.result = failed ? `call ${d.name} failed: ${v}` : `called ${d.name}(${d.args.join(", ")}) → ${v == null ? "(no result)" : JSON.stringify(v)}`; ap.cur.callValue = failed ? undefined : v ?? null; ap.cur.callFailed = failed; }
          events.push(...step(1)); continue;
        }
        const ev0 = ap.ctrl.emit(d.want, g.frame);
        inputs.push(...ev0); g.input(ev0);
        if (d.status !== "run") return { status: d.status, msg: ap.results.length > 1 ? ap.results.map((r) => r.msg).join(" → ") : d.message, events };
        const ev = step(Math.max(1, d.k)); events.push(...ev);
        const b = ap.cur ? { verb: ap.cur.o?.verb, careful: !!ap.cur.o?.careful, quiet: !!ap.cur.o?.quiet } : null;
        const wake = wakeFor(ev, b, { ap, world: w, cfg });
        if (wake) return { status: "interrupted", msg: wake, events };
      }
      return { status: "time", msg: "", events };
    },
  };
}
const moveKeys = (inputs) => inputs.filter((e) => e.type === "key" && /^(w|a|s|d|up|down|left|right)$/.test(e.key));

// ---- config and orders
{
  const c = resolvePlayConfig({ profile: "defense" }, { keys: ["w", "a", "s", "d", "j"] });
  ok("config: defense profile (and its aliases static / tower / tower-defense)", c.profile === "defense" && ["static", "tower", "tower-defense", "defence"].every((p) => resolvePlayConfig({ profile: p }).profile === "defense") && resolvePlayConfig({}).profile === "topdown");
  ok("config: defense needs no move control (none auto-picked even when the game has WASD), no guard, no autofight, alerts listed but not waking",
    Object.keys(c.controls.move).length === 0 && c.policy === undefined && c.guard === false && c.autofight === false && c.alerts === "events", JSON.stringify({ move: c.controls.move, guard: c.guard, af: c.autofight, alerts: c.alerts }));
  ok("config: defense keeps move keys a game names (but never presses them: below)", resolvePlayConfig({ profile: "defense", controls: { move: "wasd" } }).controls.move.up.key === "w");
  ok("config: topdown unchanged (WASD auto, guard on, alerts wake)", (() => { const t = resolvePlayConfig({}, { keys: ["w", "a", "s", "d"] }); return t.controls.move.up.key === "w" && t.guard === true && t.autofight === null && t.alerts === true && t.alert === 6; })());
  ok("config: alert 0 = alerts off (ranges keep 6 cells); play.alerts false / \"events\" / true", (() => { const a = resolvePlayConfig({ alert: 0 }); return a.alerts === false && a.alert === 6 && resolvePlayConfig({ alerts: false }).alerts === false && resolvePlayConfig({ alerts: "events" }).alerts === "events" && resolvePlayConfig({ profile: "defense", alerts: true }).alerts === true; })());
  ok("config: \"move\": false / \"none\" in any profile → no move control", Object.keys(resolvePlayConfig({ controls: { move: false } }).controls.move).length === 0 && Object.keys(resolvePlayConfig({ controls: { move: "none" } }).controls.move).length === 0);
  ok("config: call results show 800 characters by default (was 400)", c.resultChars === 800 && resolvePlayConfig({ resultChars: 100 }).resultChars === 100);
  const tap = parseControl("tap:target"), click = parseControl("click:target");
  ok("controls: tap:target / click:target parse (and print) as target taps", tap.type === "target" && tap.via === "tap" && click.via === "click" && controlLabel(tap) === "tap:target" && controlLabel(click) === "click:target" && parseControl("tap").type === "key");
  ok("controls (defense): only the game's own controls listed, no move", describeControls(resolvePlayConfig({ profile: "defense", controls: { attack: "tap:target", frag: "action:frag", move: "wasd" } })) === "attack tap:target · frag action:frag", describeControls(resolvePlayConfig({ profile: "defense", controls: { attack: "tap:target", frag: "action:frag", move: "wasd" } })));
  const q = parseOrders("wait 5 quiet")[0], q2 = parseOrders("wait 5 ignore")[0], f = parseOrders("fight enemies when they come")[0], f2 = parseOrders("fight enemies as they arrive for 30s")[0];
  ok("orders: wait 5 quiet / ignore; fight ... when they come / as they arrive (for 30s)", q.quiet && q.seconds === 5 && q2.quiet && f.await && f.target.category === "hostile" && f2.await && f2.forS === 30 && !parseOrders("fight wolf")[0].await, JSON.stringify([q, f, f2]));
  ok("refusalOf: false, {ok:false}, {legal:false}, {error} are refusals; true, strings, null are not", refusalOf(false) === "" && refusalOf({ ok: false, error: "x" }) === "x" && refusalOf({ legal: false }) === "" && refusalOf({ error: "nope" }) === "nope" && refusalOf(true) === null && refusalOf("can't afford") === null && refusalOf(null) === null && refusalOf([]) === null);
}

// ---- screen positions for tap:target
{
  const cfg = resolvePlayConfig({ profile: "defense" });
  const th = { key: "Grunt#1", raw: {}, pos: [10, -20] };
  const W = (state) => ({ snap: { frame: 0, state } });
  ok("screen: state.camera {pos, zoom} (top-left)", JSON.stringify(screenOf(th, W({ camera: { pos: [-160, -90], zoom: 1 } }), cfg, [320, 180]).xy) === "[170,70]");
  ok("screen: state.camera with zoom 2 and center: true", JSON.stringify(screenOf(th, W({ camera: { x: 0, y: 0, zoom: 2, center: true } }), cfg, [320, 180]).xy) === "[180,50]");
  ok("screen: the entity's own screen field wins", JSON.stringify(screenOf({ ...th, raw: { screen: [5, 6] } }, W({ camera: { pos: [0, 0] } }), cfg, [320, 180]).xy) === "[5,6]");
  ok("screen: play.screen expression with e", JSON.stringify(screenOf({ ...th, raw: { pos: [10, -20] } }, W({ ox: 100 }), resolvePlayConfig({ screen: "[e.pos[0] + state.ox, e.pos[1] + 100]" }), [320, 180]).xy) === "[110,80]");
  const none = screenOf(th, W({}), cfg, [320, 180]);
  ok("screen: no camera and no screen field → a clear reason (no guessing world = screen)", none.xy === null && /has no screen position: give entities screen: \[x, y\], or state\.camera/.test(none.why), JSON.stringify(none));
  ok("screen: play.screen \"world\" says positions are screen pixels; off-screen is refused", JSON.stringify(screenOf({ ...th, pos: [30, 40] }, W({}), resolvePlayConfig({ screen: "world" }), [320, 180]).xy) === "[30,40]" && /off the screen/.test(screenOf({ ...th, pos: [-30, 40] }, W({}), resolvePlayConfig({ screen: "world" }), [320, 180]).why));
}

// ---- a wave game: observation, fight that waits for the wave, ends on its time as a success, no move keys
{
  const g = new FortGame(1);
  const d = driver(g, { ...DEF_PLAY, controls: { attack: "j", move: "wasd" } });
  d.step(1);
  const first = d.look(true);
  ok("observation (empty field): base hp, the game's stats, 'none on the field', the defense order card; no cell, no map, no near/compass",
    /^\[t [^\]]+\] · base hp 20\/20/.test(first) && /enemies: none on the field/.test(first) && /orders: fight \[enemies\|thing\] \[for 25s\]/.test(first) && !/cell \(|map \(|near \(|controls: move/.test(first), first);
  let r = d.do("fight enemies for 3s");
  ok("fight enemies for 3s on an empty field: waits for the wave, fights it, ends on its own time as a success (✔ done, not 'still going')",
    r.status === "done" && /^fought for 3(\.\d)?s as ordered: \d enem(y|ies) defeated/.test(r.msg) && g.kills >= 1 && g.wave === 1, JSON.stringify({ r: r.msg, kills: g.kills, wave: g.wave }));
  ok("the waiting fight said so in its events", r.events.some((e) => /no enemies on the field: waiting for the next \(up to 3s\)/.test(e.text)) && r.events.some((e) => /came after/.test(e.text)), r.events.map((e) => e.text).join(" | "));
  ok("no move key was ever pressed (move keys configured, but a defense game never moves)", moveKeys(d.inputs).length === 0 && g.moves.length === 0 && d.inputs.some((e) => e.key === "j"), JSON.stringify(moveKeys(d.inputs)));
  const gm = new FortGame(1), dm = driver(gm);
  dm.do("wait 1.5");
  const mid = dm.look();
  ok("observation (wave on): enemies closest first with cells from the base, closing speed, arrival time and screen position",
    gm.enemies.length === 3 && (/enemies: 3 on the field/.test(mid) && /Grunt#\d+\s+\d+\.\d  hp \d\/2  closing [\d.]+ cells\/s \(there in ~\d+s\)  screen \d+,\d+/.test(mid)), mid);
  r = d.do("fight enemies");
  ok("fight enemies (no time) in a defense game: fights the rest of the wave (or waits for the next), done when the field is clear",
    r.status === "done" && /enem(y|ies) defeated, the field is clear/.test(r.msg) && g.enemies.length === 0, JSON.stringify({ r, left: g.enemies.length }));
  // between waves: a wait isn't cut short by the next wave showing up (alerts are events here), a timed wait runs out
  const k0 = g.kills;
  r = d.do("wait 3");
  ok("wait 3 in a defense game: the wave arriving doesn't interrupt it (the alert is only an event)", r.status === "done" && /waited 3s/.test(r.msg) && r.events.some((e) => e.kind === "alert" && /cells from the base/.test(e.text)) && g.kills === k0, JSON.stringify({ r: r.msg, ev: r.events.map((e) => e.text) }));
  r = d.do("goto Grunt");
  ok("movement orders in a defense game: a clear refusal with the defense order card", r.status === "fail" && /this is a defense game, you don't move/.test(r.msg), JSON.stringify(r));
  r = d.do("press attack x2");
  ok("press attack (a key) still works", r.status === "done" && /pressed attack ×2/.test(r.msg), JSON.stringify(r));
  const data = observeData(d.world, { cfg: d.cfg, ap: d.ap });
  ok("observation --json (defense): base, enemies with dist/closing/eta/screen; no player cell, no map", data.profile === "defense" && data.base.hp != null && Array.isArray(data.enemies) && !("map" in data) && !("near" in data) && (!data.enemies.length || "eta" in data.enemies[0]), JSON.stringify(data).slice(0, 600));
}

// ---- attack "tap:target" / "click:target": taps where the target is drawn, recorded as normal input
{
  const g = new FortGame(2);
  const d = driver(g, { ...DEF_PLAY, controls: { attack: "tap:target" } });
  const r = d.do("fight enemies for 2.5s");
  const touches = d.inputs.filter((e) => e.type === "touch");
  ok("tap:target: touch down/up at the target's screen position (from state.camera), and the taps land (kills)",
    r.status === "done" && touches.length >= 2 && touches.every((e) => e.id === 0 && Number.isInteger(e.x) && Number.isInteger(e.y)) && touches.some((e) => e.phase === "up") && g.kills >= 1 && g.taps.length >= 2 && !d.inputs.some((e) => e.type === "key"), JSON.stringify({ r: r.msg, kills: g.kills, touches: touches.slice(0, 4) }));
  const g2 = new FortGame(2);
  const d2 = driver(g2, { ...DEF_PLAY, controls: { attack: "click:target" } });
  d2.do("fight enemies for 2s");
  const clicks = d2.inputs.filter((e) => e.type === "mouse" && e.down === true);
  ok("click:target: mouse move + left button at the target", clicks.length >= 1 && clicks.every((e) => e.button === 0) && g2.kills >= 1, JSON.stringify({ clicks: clicks.slice(0, 3), kills: g2.kills }));
  const g3 = new FortGame(2, { camera: false });
  const d3 = driver(g3, { ...DEF_PLAY, controls: { attack: "tap:target" } });
  const r3 = d3.do("fight enemies for 2s");
  ok("tap:target with no way to place the target on screen: the fight fails, saying what to add", r3.status === "fail" && /has no screen position: give entities screen/.test(r3.msg), JSON.stringify(r3));
  const g4 = new FortGame(3);
  const d4 = driver(g4, { ...DEF_PLAY, controls: { attack: "tap:target" } });
  d4.do("wait 1");
  const r4 = d4.do("press attack");
  // a screen narrower than the field (a portrait phone): enemies off the edge are skipped or waited for, not a failure
  const g5 = new FortGame(2), size5 = [200, 180];
  const d5 = driver(g5, { ...DEF_PLAY, controls: { attack: "tap:target" } }, size5);
  const r5 = d5.do("fight enemies for 4s");
  const t5 = d5.inputs.filter((e) => e.type === "touch");
  ok("tap:target on a narrow screen: off-screen enemies don't fail the fight; only on-screen taps, and they land",
    r5.status === "done" && /fought for 4(\.\d+)?s as ordered/.test(r5.msg) && t5.length >= 2 && t5.every((e) => e.x >= 0 && e.x <= size5[0] && e.y >= 0 && e.y <= size5[1]) && g5.kills >= 1, JSON.stringify({ r: r5.msg, kills: g5.kills, n: t5.length }));
  ok("press attack with tap:target: taps the nearest enemy", r4.status === "done" && /tapped Grunt#\d+/.test(r4.msg) && d4.inputs.some((e) => e.type === "touch"), JSON.stringify(r4));
}

// ---- calls: false / {ok:false} / a throw fail with the game's reason; no result is done and said so
{
  const g = new FortGame(1);
  const d = driver(g, { ...DEF_PLAY, allowCalls: true });
  let r = d.do("call buy wall");
  ok("call returning false → ✖ failed: the game refused it", r.status === "fail" && /called buy\(wall\) → false: the game refused it$/.test(r.msg), JSON.stringify(r));
  r = d.do("call buy tower");
  ok("call returning {ok: false, error} → failed with the game's reason", r.status === "fail" && /the game refused it \("no item \\"tower\\""\)|the game refused it \("no item "tower""\)/.test(r.msg), JSON.stringify(r));
  r = d.do("call boom");
  ok("call that throws → failed with the error", r.status === "fail" && /call boom failed: the armory is on fire/.test(r.msg), JSON.stringify(r));
  r = d.do("call nothing");
  ok("call with no result → done, '→ (no result)'", r.status === "done" && /called nothing\(\) → \(no result\)/.test(r.msg), JSON.stringify(r));
  g.bank = 250;
  r = d.do("call buy wall");
  ok("call returning a string → done with it", r.status === "done" && /bought a wall/.test(r.msg), JSON.stringify(r));
}

// ---- other profiles: the explicit fixes (fight's own time, move-less fight, quiet waits, alerts off)
{
  // a topdown arena: the player at the origin, an enemy that can't die standing next to it
  const S = { frame: 0, q: [], keys: [], step() { for (const e of this.q.filter((e) => e.frame <= this.frame)) if (e.type === "key" && e.down) this.keys.push(e.key); this.q = this.q.filter((e) => e.frame > this.frame); this.frame++; },
    input(ev) { this.q.push(...ev); },
    snapshot() { return { frame: this.frame, time: this.frame / 60, state: { camera: this.camera, player: { pos: [0, 0], hp: 10, maxHp: 10, facing: "E" }, entities: [{ id: 7, type: "Golem", pos: [1, 0], hp: 999, hostile: true }] } }; } };
  const run = (play, text) => {
    const cfg = resolvePlayConfig(play, { keys: ["w", "a", "s", "d", "j"] }), per = new Perceiver(cfg, { fps: 60 });
    let w = per.perceive(S.snapshot(), S.frame);
    const ap = new Autopilot(cfg, { fps: 60, grid: new NavGrid({ cell: w.cell, origin: [0, 0] }), perceiver: per });
    ap.observe(w); ap.setOrders(parseOrders(text, { named: cfg.named }));
    const inputs = []; let dec;
    for (let i = 0; i < 8000; i++) { dec = ap.decide(w); const ev = ap.ctrl.emit(dec.want, S.frame); inputs.push(...ev); S.input(ev); if (dec.status !== "run") break; for (let k = 0; k < Math.max(1, dec.k); k++) S.step(); w = per.perceive(S.snapshot(), S.frame); ap.observe(w); }
    return { dec, inputs };
  };
  let r = run({ controls: { attack: "j" }, cell: 1 }, "fight golem for 2s");
  ok("topdown: fight with a time given ends on it as a success", r.dec.status === "done" && /^fought for 2(\.\d+)?s as ordered: none defeated, 1 still on the field/.test(r.dec.message), JSON.stringify(r.dec));
  r = run({ controls: { attack: "j" }, cell: 1 }, "fight golem");
  ok("topdown: fight without a time still fails at its 60 s cap (unchanged)", r.dec.status === "fail" && /fight still going after 60/.test(r.dec.message), JSON.stringify(r.dec));
  r = run({ controls: { attack: "j", move: false }, cell: 1 }, "fight golem for 1s");
  ok("no move control (move: false): fight attacks from where it stands, presses no move key", r.dec.status === "done" && moveKeys(r.inputs).length === 0 && r.inputs.some((e) => e.key === "j"), JSON.stringify(r.inputs.slice(0, 6)));
  // tap:target in a fight that can move (kite / closing in / in reach all pass the target): it taps; no camera → fails
  S.camera = { pos: [-160, -90], zoom: 1 };
  for (const mode of ["", " kite 2"]) {
    r = run({ controls: { attack: "tap:target" }, cell: 1 }, `fight golem${mode} for 2s`);
    ok(`topdown tap:target with move keys${mode}: the fight taps the enemy`, r.dec.status === "done" && r.inputs.filter((e) => e.type === "touch" && e.phase === "down").length >= 2, JSON.stringify({ d: r.dec, n: r.inputs.filter((e) => e.type === "touch").length }));
  }
  S.camera = undefined;
  r = run({ controls: { attack: "tap:target" }, cell: 1 }, "fight golem for 2s");
  ok("topdown tap:target with no screen position: the moving fight fails, saying why", r.dec.status === "fail" && /has no screen position/.test(r.dec.message), JSON.stringify(r.dec));
  // wake rules: an alert wakes a topdown wait (unchanged), not a quiet one, not with alerts as events, not in a defense game
  const cfgT = resolvePlayConfig({}), cfgE = resolvePlayConfig({ alerts: "events" }), cfgD = resolvePlayConfig({ profile: "defense" });
  const ap = { inCombat: () => false, policy: { autofight: false }, suspended: null };
  const alert = [{ kind: "alert", text: "Grunt#2 appeared: 10.7 cells NE", data: { id: 2 } }], hurt = [{ kind: "hurt", text: "Grunt#2 hit you (-1)" }], death = [{ kind: "death", text: "you died" }];
  const wk = (ev, b, cfg) => wakeFor(ev, b, { ap, world: { dead: false }, cfg });
  ok("wake: an alert wakes a plain topdown wait (unchanged)", wk(alert, { verb: "wait" }, cfgT) === alert[0].text);
  ok("wake: 'wait N quiet' isn't woken by an alert or a hit, still by death", wk(alert, { verb: "wait", quiet: true }, cfgT) === null && wk(hurt, { verb: "wait", quiet: true }, cfgT) === null && wk(death, { verb: "wait", quiet: true }, cfgT) === "you died");
  ok("wake: play.alerts \"events\" (and the defense profile) list alerts without waking; defense ignores base hits", wk(alert, { verb: "wait" }, cfgE) === null && wk(alert, { verb: "wait" }, cfgD) === null && wk(hurt, { verb: "wait" }, cfgD) === null && wk(hurt, { verb: "wait" }, cfgT) === hurt[0].text);
  // alert 0: no alert events at all
  const cfg0 = resolvePlayConfig({ alert: 0, cell: 1 }), per0 = new Perceiver(cfg0, { fps: 60 }), tr0 = new EventTracker(cfg0, per0);
  const snapAt = (f, x) => ({ frame: f, time: f / 60, state: { player: { pos: [0, 0], hp: 5 }, entities: [{ id: 3, type: "Wolf", pos: [x, 0], hostile: true }] } });
  const w0 = per0.perceive(snapAt(0, 40), 0); tr0.update(null, w0, {});
  const e1 = tr0.update(w0, per0.perceive(snapAt(1, 2), 1), {});
  const cfg6 = resolvePlayConfig({ cell: 1 }), per6 = new Perceiver(cfg6, { fps: 60 }), tr6 = new EventTracker(cfg6, per6);
  const v0 = per6.perceive(snapAt(0, 40), 0); tr6.update(null, v0, {});
  const e6 = tr6.update(v0, per6.perceive(snapAt(1, 2), 1), {});
  ok("events: alert 0 makes no alert events; the default still does", !e1.some((e) => e.kind === "alert") && e6.some((e) => e.kind === "alert"), JSON.stringify([e1, e6]));
}

// ---- brief and checklist
{
  const b = makeBrief({ cli: "witness", configDir: "C:/g", profile: "defense", extra: "Send `fight enemies for 25s` then `press grab`; a lone ` stays" });
  ok("brief: backticks in the game's brief text become quotes", /NOTES FROM THE DEVELOPER: Send "fight enemies for 25s" then "press grab"; a lone ' stays/.test(b) && !/NOTES FROM THE DEVELOPER:[^\n]*`/.test(b), b.split("NOTES")[1]);
  ok("brief (defense): the defense order card and tips; no walls, map or aiming", /fight \[enemies\|thing\] \[for 25s\]/.test(b) && /You never move/.test(b) && /wait 5 quiet/.test(b) && !/walls|a small map|aiming|nearest enemy", "item"/.test(b), b);
  ok("brief (topdown) unchanged", /walking around walls, aiming/.test(makeBrief({ cli: "witness", configDir: "C:/g" })));
  const items = checkSnapshot(new FortGame(1).state(), "defense"), by = Object.fromEntries(items.map((i) => [i.key, i]));
  ok("play check (defense): base, flags, screen (state.camera), outcome; no map/facing/doors", by.base.ok && by.screen.ok && by.outcome.ok && !by.map && !by.facing && !by.doors, JSON.stringify(items));
}

// ---- end to end: the real CLI and daemon on the defense game (one game process)
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "witness-defense-"));
  const env = { WITNESS_PLAY_REGISTRY: path.join(tmp, "registry"), WITNESS_PLAY_MAX: "3" };
  fs.writeFileSync(path.join(tmp, "witness.json"), JSON.stringify({ name: "Tiny Fort", launch: { command: process.execPath, args: [path.join(here, "defense-game.mjs")] },
    play: { ...DEF_PLAY, controls: { attack: "tap:target", lock: "j" }, allowCalls: true, brief: "Use `fight enemies for 25s` in a wave." } }));
  try {
    let r = witness(["play", "brief"], { cwd: tmp, env });
    ok("e2e: play brief turns the game's backticks into quotes", r.code === 0 && /Use "fight enemies for 25s" in a wave/.test(r.out), r.out.split("NOTES")[1]);
    r = witness(["play", "start", "--name", "d1"], { cwd: tmp, env });
    ok("e2e: start shows the defense observation", r.code === 0 && /base hp 20\/20/.test(r.out) && /orders: fight \[enemies/.test(r.out) && !/cell \(/.test(r.out), r.out);
    r = witness(["play", "do", "fight enemies for 3s", "-s", "d1"], { cwd: tmp, env });
    ok("e2e: fight enemies for 3s → ✔ done (it waited for the wave and tapped)", r.code === 0 && /✔ done: fight enemies for 3s — fought for 3(\.\d)?s as ordered/.test(r.out), r.out);
    r = witness(["play", "do", "wait 2 quiet", "-s", "d1"], { cwd: tmp, env });
    ok("e2e: wait 2 quiet runs its 2 s", r.code === 0 && /✔ done: wait 2 quiet — waited 2s/.test(r.out), r.out);
    r = witness(["play", "do", "call status", "-s", "d1"], { cwd: tmp, env });
    ok("e2e: a long call result is cut at 800 characters and says how to see it all", r.code === 0 && /called status\(\) → "wave \d · upgrade0=lv0.*… \(cut at 800 of \d+ chars: look --full shows all\)/.test(r.out), r.out);
    r = witness(["play", "look", "--full", "-s", "d1"], { cwd: tmp, env });
    ok("e2e: look --full shows the latest call's answer whole", r.code === 0 && /latest call \(t [\d.]+s\) status\(\), in full:\nwave \d · upgrade0=lv0.*upgrade59=lv3 · END/.test(r.out), r.out);
    r = witness(["play", "do", "call buy wall", "-s", "d1"], { cwd: tmp, env });
    ok("e2e: a call the game answers false → ✖ failed", r.code === 0 && /✖ failed: call buy wall — called buy\(wall\) → false: the game refused it/.test(r.out), r.out);
    r = witness(["play", "do", "call nothing", "-s", "d1"], { cwd: tmp, env });
    ok("e2e: a call with no result → ✔ done → (no result)", r.code === 0 && /✔ done: call nothing — called nothing\(\) → \(no result\)/.test(r.out), r.out);
    r = witness(["play", "end", "-s", "d1", "--fun", "3", "--difficulty", "2", "--feedback", "fine"], { cwd: tmp, env });
    ok("e2e: end", r.code === 0 && /report:/.test(r.out), r.out);
    const dir = path.join(tmp, "witness", "playtests", "d1");
    const rec = fs.readFileSync(path.join(dir, "replay.jsonl"), "utf8");
    ok("e2e: the taps are in the replay as touch input", /"type":"touch"/.test(rec) && /"phase":"down"/.test(rec));
    r = witness(["replay", path.join(dir, "replay.jsonl")], { cwd: tmp, env });
    ok("e2e: the replay (touch taps and calls) ends in exactly the recorded state", r.code === 0 && /ended in exactly the recorded end state/.test(r.out), r.out);
    const rep = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
    ok("e2e: the report has no map coverage for a defense game", !rep.coverage && rep.profile === "defense", JSON.stringify(rep.coverage));
  } finally {
    witness(["play", "stop", "--all"], { cwd: tmp, env });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
