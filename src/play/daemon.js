// Witness play: the session daemon. One per playtest, detached from the CLI that started it. It owns the game
// (through the normal openGame/Session), runs the reflex loop, records the replay, answers `witness play …` commands
// over HTTP on 127.0.0.1 (token-checked), and always shuts down cleanly: on `end`, idle timeout, max wall time, the game
// dying, or a signal. It never leaves the game running.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { openGame } from "../core/launch.js";
import { resolvePlayConfig } from "./config.js";
import { Perceiver } from "./perceive.js";
import { NavGrid } from "./grid.js";
import { Autopilot } from "./autopilot.js";
import { EventTracker, cellOf, coalesceEvents } from "./events.js";
import { wakeFor as wakeRule } from "./wake.js";
import { observeText, observeData, resultLine } from "./observe.js";
import { parseOrders, OrderError } from "./orders.js";
import { ReplayRecorder } from "./recorder.js";
import { reportData, coveragePNG, writeReports, addLateFeedback } from "./report.js";
import { DeadWatch } from "./deadwatch.js";
import { updateEntry, writeJson } from "./registry.js";
import { r1, clip, oneLine } from "./util.js";
import { PERSONAS } from "./brief.js";
import { UntilWatch } from "./until.js";
export { PERSONAS };



const DEBUG = !!process.env.WITNESS_PLAY_DEBUG;
const OPEN_ENDED = new Set(["explore", "wait", "follow", "run", "waitfor", "hold", "block"]);

export async function runDaemon(dir) {
  const specFile = path.join(dir, "session.json");
  const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
  const logFile = path.join(dir, "daemon.log");
  const log = (m) => { try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${m}\n`); } catch { /* disk */ } };
  const setStatus = (patch) => { Object.assign(spec, patch); writeJson(specFile, spec); try { updateEntry(spec.name, { ...patch, dir }); } catch { /* registry */ } };
  const opts = spec.opts || {};
  const wall0 = Date.now();
  // the hard real-time cap: --wall-minutes (spec.opts.wallMinutes; "minutes" in sessions started by 0.7.1)
  const wallMin = Math.max(0.01, +(opts.wallMinutes ?? opts.minutes ?? 20) || 20);
  // a step the game doesn't answer within this long means it hung (WITNESS_PLAY_HANG seconds, for tests)
  const hangMs = Math.max(1, +process.env.WITNESS_PLAY_HANG || 60) * 1000;
  let stopWhy = null, doRunning = null, hung = null;   // why the session is ending (told to a running order); the running `do`
  log(`daemon ${process.pid} starting session ${spec.name} in ${spec.root}`);

  let g;
  try {
    // --watch: the game shows its window, presents frames, drops real input (docs/PROTOCOL.md, watch mode)
    g = await openGame(spec.cfg, spec.root, { quiet: true, timeout: spec.cfg.timeout, env: opts.watch ? { WITNESS_WATCH: "1" } : undefined });
  } catch (e) {
    log(`launch failed: ${e.message}`);
    setStatus({ state: "failed", error: e.message });
    process.exit(1);
  }
  // `play stop` / `end` (or a batch's cleanup) while this was launching the game: don't start playing
  const stopAsked = () => fs.existsSync(path.join(dir, "stop.request"));
  if (stopAsked()) { log("stop requested while starting"); try { await g.stop(); } catch { /* gone */ } setStatus({ state: "ended", endedAt: new Date().toISOString(), reason: "stopped while starting", outcome: "stopped", summary: "stopped while starting" }); process.exit(0); }
  const S = g.session, fps = S.fps;
  const rawPlay = { ...(spec.cfg.play || {}) };
  if (opts.noMap) rawPlay.map = false;
  if (opts.allowCalls) rawPlay.allowCalls = true;
  const persona = PERSONAS[opts.persona] ? opts.persona : null;
  if (persona && rawPlay.reaction == null) rawPlay.reaction = PERSONAS[persona].reaction;
  let cfg;
  try { cfg = resolvePlayConfig(rawPlay, S.hello); }
  catch (e) { log(`bad play config: ${e.message}`); setStatus({ state: "failed", error: e.message }); await g.stop(); process.exit(1); }

  const shotsDir = path.join(dir, "shots");
  const perceiver = new Perceiver(cfg, { fps });
  // play.module: an optional ES module next to witness.json that can patch the world model (advanced escape hatch)
  if (cfg.module) {
    try {
      const { pathToFileURL } = await import("node:url");
      const mod = await import(pathToFileURL(path.resolve(spec.root, cfg.module)).href);
      if (typeof mod.perceive === "function") { const base = perceiver.perceive.bind(perceiver); perceiver.perceive = (snap, f) => { const w = base(snap, f); return mod.perceive(w, snap) || w; }; }
      log(`loaded play module ${cfg.module}`);
    } catch (e) { log(`play module failed: ${e.message}`); setStatus({ state: "failed", error: `play.module: ${e.message}` }); await g.stop(); process.exit(1); }
  }
  const size = S.hello.size || [640, 360];
  let frame = 0, world = null, finalizing = false, server = null, finalP = null;
  const timeline = [], orders = [], notes = [], shots = [], errors = [], pending = [], trail = [];
  let parseErrors = 0, lastLogFrame = 0, firstLook = true;
  const recorder = new ReplayRecorder({ name: S.hello.name || spec.cfg.name, seed: opts.seed ?? spec.cfg.seed ?? 1, fps, scene: opts.scene ?? null, params: opts.params ?? null, session: spec.name, launch: S.web ? { engine: S.web.engine, device: S.web.device ? S.web.device.name : null } : null });
  const dts = (k) => Array(k).fill(1 / fps);

  // ---- live mode: one loop owns the game and steps it continuously, paced to real time; commands steer it
  const liveCfg = cfg.live || {};
  const live = {
    on: !!(opts.live || (opts.watch && !opts.turns)), paused: false, stop: false, waiter: null, lastCmd: Date.now(),
    speed: Math.max(0.05, +(opts.speed ?? liveCfg.speed ?? 1)), horizon: +(opts.horizon ?? liveCfg.horizon ?? 4),
    pauseAfter: Math.max(2, +(opts.pauseAfter ?? liveCfg.pauseAfter ?? 15)), baseWall: 0, baseFrame: 0,
    resume: null, exited: null, order: null, pauseReason: null,
  };
  // every Session request goes through this lock in live mode (the loop takes it per tick, commands for screenshots)
  const lock = { p: Promise.resolve(), run(fn) { const r = this.p.then(fn, fn); this.p = r.then(() => {}, () => {}); return r; } };
  // pace: how long the game sat frozen while the tester thought (turn-taking) or while live mode was paused
  const pace = { freezes: 0, frozenMs: 0, frozenSince: live.on ? null : Date.now() };
  const thaw = () => { if (pace.frozenSince != null) { const gap = Date.now() - pace.frozenSince; if (gap > 50) { pace.freezes++; pace.frozenMs += gap; } pace.frozenSince = null; } };
  const freeze = () => { if (pace.frozenSince == null) pace.frozenSince = Date.now(); };

  // ---- start the run
  let grid, ap, tracker, until = null, untilTimer = null;
  try {
    if (S.has("reset")) await S.reset(opts.seed ?? spec.cfg.seed ?? 1, opts.scene || undefined, opts.params || undefined);
    // many games fill their world on the first update: step once (and up to ~1/3 s until something is in view)
    // before the first look. These frames are recorded like any others, so the replay stays exact.
    const warm = Math.max(1, Math.round(fps / 3));
    for (let i = 0; i < warm; i++) {
      await S.step(1, null, dts(1)); frame++;
      world = perceiver.perceive(await S.snapshot(), frame);
      if (world.player && world.things.length) break;
    }
    // --until / --game-hours (play.clock): checked after every step from here on
    until = new UntilWatch({ until: opts.until, gameHours: opts.gameHours, clock: opts.clock || (spec.cfg.play && spec.cfg.play.clock) || null });
    if (until.active || until.clock) until.start(await S.snapshot());
    grid = new NavGrid({ cell: world.cell, origin: perceiver.geo.origin, northSign: cfg.northSign });
    ap = new Autopilot(cfg, { fps, grid, perceiver, size });
    tracker = new EventTracker(cfg, perceiver);
    ap.observe(world);
    tracker.update(null, world, {});
  } catch (e) {
    log(`start failed: ${e.stack || e.message}`);
    setStatus({ state: "failed", error: e.message });
    await g.stop();
    process.exit(1);
  }

  async function screenshot(why, scaleUp = 0) {
    if (!S.has("screenshot") || S.closed) return null;
    try {
      const sh = await S.screenshot();
      fs.mkdirSync(shotsDir, { recursive: true });
      const file = path.join(shotsDir, `${String(world.t.toFixed(1)).replace(".", "_")}s-${why.replace(/[^\w-]+/g, "_").slice(0, 40)}.png`);
      if (sh.path) fs.copyFileSync(path.resolve(sh.path), file);
      else if (sh.format === "png") fs.writeFileSync(file, Buffer.from(sh.data, "base64"));
      else {
        const { encodePNG } = await import("../media/png.js");
        let w = sh.width, h = sh.height, px = new Uint8Array(Buffer.from(sh.data, "base64"));
        const k = scaleUp || (w < 600 ? 2 : 1);
        if (k > 1) {   // nearest-neighbour upscale so small pixel-art frames are legible to a model
          const W = w * k, H = h * k, out = new Uint8Array(W * H * 4);
          for (let y = 0; y < H; y++) { const sy = (y / k) | 0; for (let x = 0; x < W; x++) { const s = (sy * w + ((x / k) | 0)) * 4, d = (y * W + x) * 4; out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = px[s + 3]; } }
          px = out; w = W; h = H;
        }
        fs.writeFileSync(file, encodePNG(w, h, px));
      }
      return file;
    } catch (e) { log(`screenshot failed: ${e.message}`); return null; }
  }
  async function keyShot(why) {
    if (shots.length >= cfg.maxShots) return null;
    const file = await screenshot(why);
    if (file) shots.push({ t: +world.t.toFixed(2), why, file });
    return file;
  }
  await keyShot("start");

  // the timeline keeps one line per run of regen ticks (or damage over time with no attacker), not one per tick
  let regenRun = null;
  function timelinePush(e) {
    const dot = e.kind === "hurt" && e.data && !e.data.by;
    if ((e.kind === "heal" || dot) && e.data && e.data.amount != null) {
      const last = timeline.at(-1);
      if (regenRun && last === regenRun.entry && regenRun.kind === e.kind && e.t - regenRun.tEnd < 1.5) {
        regenRun.sum += e.data.amount; regenRun.tEnd = e.t; regenRun.n++;
        last.text = e.kind === "heal" ? `regenerated +${r1(regenRun.sum)} over ${r1(e.t - regenRun.t0)}s (hp ${r1(regenRun.from)}→${r1(e.data.to)})`
          : `took ${r1(regenRun.sum)} damage over ${r1(e.t - regenRun.t0)}s in ${regenRun.n} hits, no attacker near (hp ${r1(regenRun.from)}→${r1(e.data.to)})`;
        return;
      }
      const entry = { t: +e.t.toFixed(2), frame: e.frame, kind: e.kind, text: e.text };
      timeline.push(entry);
      regenRun = { entry, kind: e.kind, t0: e.t, tEnd: e.t, sum: e.data.amount, from: e.data.from ?? null, n: 1 };
      return;
    }
    timeline.push({ t: +e.t.toFixed(2), frame: e.frame, kind: e.kind, text: e.text });
  }

  // ---- the reflex loop for one `do`
  const wakeFor = (ev, b) => wakeRule(ev, b, { ap, world, cfg, live: live.on });
  // watched turn-taking (--watch --turns): an order plays at real-time speed, the game waits while the tester thinks
  const turnPace = { wall: 0, frame: 0 };
  async function stepWorld(k) {
    try { await S.request("step", { frames: k, dts: dts(k) }, Math.max(hangMs, k * 50)); }
    catch (e) { if (!S.closed && /didn't answer/.test(e.message)) hung ??= { t: world.t, frame }; throw e; }
    frame += k;
    if (opts.watch && !live.on) { const ahead = turnPace.wall + ((frame - turnPace.frame) / fps) * 1000 - Date.now(); if (ahead > 1) await new Promise((r) => setTimeout(r, ahead)); }
    const snap = await S.snapshot();
    let logs = [];
    if (frame - lastLogFrame >= Math.max(1, Math.round(fps / 4))) { logs = await S.drainLogs(); lastLogFrame = frame; }
    for (const l of logs) { lastLogs.push(`${l.level ? `[${l.level}] ` : ""}${oneLine(l.message)}`); if (lastLogs.length > 5) lastLogs.shift(); }
    const nw = perceiver.perceive(snap, frame);
    if (until && !until.hit && (until.active || until.clock) && until.check(snap, nw.t)) untilReached();
    ap.observe(nw);
    const ev = tracker.update(world, nw, { lastAttackT: ap.lastAttackT, logs, retreat: ap.policy.retreat });
    for (const e of ap.drainEvents()) ev.push({ t: nw.t, frame, ...e });
    world = nw;
    world.remembered = world.remembered.filter((th) => !(perceiver.memory.get(th.id) || {}).gone);
    if (world.player && world.player.p2) { const c = cellOf(world, world.player.p2); const last = trail.at(-1); if (!last || last[0] !== c[0] || last[1] !== c[1]) trail.push(c); }
    for (const e of ev) {
      timelinePush(e);
      if (e.kind === "error") errors.push({ t: +e.t.toFixed(2), text: e.text });
      if (e.kind === "death") await keyShot("death");
      if (e.kind === "goal") await keyShot("goal reached");
      if (e.kind === "error" && errors.length <= 3) await keyShot("game error");
      if (e.kind === "stuck" && e.data && !e.data.resolved) { const f = await keyShot("stuck"); const inc = ap.incidents.at(-1); if (inc && f) inc.shot = f; }
      if (e.kind === "dialogue" && /opened/.test(e.text) && tracker.dialogues.length <= 3) await keyShot("dialogue");
    }
    for (const fs0 of tracker.firstSight.splice(0)) if (fs0.t > 0) await keyShot(`first ${fs0.type}`);
    pending.push(...ev);
    if (deadWatch.update(world) && !deadWatch.reported) await stuckDead();
    return ev;
  }

  // ---- stuck dead: respawn attempts change nothing for play.stuckDead game seconds (default 20) → the session ends
  const deadWatch = new DeadWatch(rawPlay.stuckDead ?? 20);
  const lastLogs = [];
  async function stuckDead() {
    deadWatch.reported = true;
    const h = deadWatch.hit, text = deadWatch.text();
    h.shot = await keyShot("stuck dead");
    const e = { t: world.t, frame, kind: "stuckdead", text };
    timeline.push({ t: +e.t.toFixed(2), frame, kind: e.kind, text }); pending.push(e);
    recorder.mark(frame, text.slice(0, 120));
    log(text);
    stopWhy = text;
    setTimeout(() => shutdown(stopWhy, "stuck dead"), 20);
  }
  /** Inputs went to the game: the stuck-dead watch counts presses while dead. */
  const sent = (ev) => { if (ev.length) deadWatch.input(world.t, ev); };

  /** The game went away or stopped answering: say which, when, and its last words. */
  async function gameTrouble() {
    const tail = () => {
      const out = (g.output ? g.output() : "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3);
      const lines = [...lastLogs.slice(-3), ...out];
      return lines.length ? `; last lines: ${lines.map((l) => `"${clip(l, 120)}"`).join(" | ")}` : "";
    };
    if (hung && !S.closed) return { status: "error", outcome: "not responding", msg: `the game is not responding since t=${r1(hung.t)}s (a step got no answer for ${Math.round(hangMs / 1000)}s)${tail()}` };
    if (g.proc && g.proc.exitCode == null) await new Promise((res) => { const t = setTimeout(res, 1500); g.proc.once("exit", () => { clearTimeout(t); res(); }); });
    const code = g.proc ? g.proc.exitCode ?? g.proc.signalCode : null;
    return { status: "error", outcome: "crashed", msg: `the game exited${code != null ? ` (code ${code})` : ""} at t=${r1(world.t)}s${tail()}` };
  }

  async function runDo(text, forS) {
    let list;
    try { list = parseOrders(text, { named: cfg.named, combos: cfg.combos }); }
    catch (e) { if (!(e instanceof OrderError)) throw e; parseErrors++; return { code: 2, text: `✖ ${e.message}${e.hint ? `\n  ${e.hint.split("\n").join("\n  ")}` : ""}` }; }
    if (until && until.hit) return { code: 0, result: untilResult(true) };
    thaw();
    turnPace.wall = Date.now(); turnPace.frame = frame;
    const t0 = world.t;
    const cap = forS != null ? +forS : list.every((o) => OPEN_ENDED.has(o.verb) || o.forS) ? Math.max(...list.map((o) => o.forS || 6)) + 0.5 : Math.max(25, ...list.map((o) => (o.forS || 0) + 1));
    ap.setOrders(list);
    const rec = { t: +t0.toFixed(2), text, status: null, msg: null, seconds: null };
    orders.push(rec);
    let result = null;
    try {
    for (let guard = 0; guard < 200000; guard++) {
      if (stopWhy) { result = { status: "ended", msg: stopWhy }; break; }
      const dec = ap.decide(world);
      if (dec.status === "call") {
        const ev0 = ap.ctrl.emit(dec.want, frame);
        if (ev0.length) { await S.input(ev0); recorder.add(ev0); sent(ev0); }
        let msg;
        try { const r = await S.call(dec.name, dec.args); msg = `called ${dec.name}(${dec.args.join(", ")}) → ${clip(JSON.stringify(r.result ?? null), 120)}`; recorder.call(frame, dec.name, dec.args); }
        catch (e) { msg = `call ${dec.name} failed: ${e.message}`; }
        if (ap.cur) ap.cur.result = msg;
        await stepWorld(1);   // a call is always followed by a step, so it lands inside the recording
        continue;
      }
      const ev = ap.ctrl.emit(dec.want, frame);
      if (ev.length) { await S.input(ev); recorder.add(ev); sent(ev); }
      if (DEBUG) {
        const nav = ap.cur && (ap.cur.nav || (ap.cur.go && ap.cur.go.nav));
        log(`tick f${frame} t${world.t.toFixed(2)} p=${world.player && world.player.p2 ? world.player.p2.map((x) => x.toFixed(1)).join(",") : "-"} ${ap.cur ? ap.cur.label : "-"} st=${dec.status} k=${dec.k} held=[${[...ap.ctrl.held.keys()].join(" ")}] ev=${ev.map((e) => `${e.key || e.type}${e.down === true ? "+" : e.down === false ? "-" : ""}@${e.frame}`).join(" ")}${nav ? ` path=${(nav.path || []).slice(0, 4).map((c) => c.join(".")).join(">")} esc=${nav.escape ? JSON.stringify(nav.escape) : ""} best=${(nav.best / world.cell).toFixed(2)}@${nav.bestT.toFixed(2)}` : ""} foes=${world.things.filter((th) => th.rel === "hostile" && th.dist < 6).map((th) => `${th.key}@${th.p2.map((x) => x.toFixed(0)).join(",")}`).join(" ")} vel=${world.player && world.player.vel ? world.player.vel.map((x) => x.toFixed(2)).join(",") : ""} g=${world.player ? world.player.onGround : ""}`);
      }
      if (dec.status === "done" || dec.status === "fail" || dec.status === "idle") { result = { status: dec.status === "idle" ? "done" : dec.status, msg: dec.message, hint: dec.hint }; break; }
      if (S.closed) { result = stopWhy ? { status: "ended", msg: stopWhy } : await gameTrouble(); break; }
      const b = ap.cur ? { verb: ap.cur.o?.verb, careful: !!ap.cur.o?.careful, target: ap.cur.thingId ?? ap.cur.target ?? (ap.cur.thing ? ap.cur.thing.id : null) } : null;
      const evs = await stepWorld(Math.max(1, dec.k));
      if (deadWatch.hit) { result = { status: "ended", msg: stopWhy }; break; }
      if (until && until.hit) { result = untilResult(false); break; }
      const wake = wakeFor(evs, b);
      if (wake) { result = evs.some((e) => e.kind === "goal") ? { status: "goal", msg: "the game reports a win" } : { status: "interrupted", msg: wake }; break; }
      if (world.t - t0 >= cap - 1e-9) { result = { status: "time", msg: `stopped after ${r1(world.t - t0)}s of game time${ap.cur ? ` (${clip(ap.cur.label, 40)} still running; give a new order or the same one again)` : ""}` }; break; }
    }
    } catch (e) {
      // the game closed or hung under a step: a session stop (the wall cap) says so; a real exit/hang is told apart
      if (stopWhy) result = { status: "ended", msg: stopWhy };
      else if (S.closed || hung) result = await gameTrouble();
      else throw e;
    }
    if (result.status === "ended") result.msg = endedMsg(result.msg);
    if (result.outcome) { const why = result.msg; setTimeout(() => shutdown(why, result.outcome), 10); }
    // results of a chain: show each finished order
    const parts = ap.results.map((r) => `${r.status === "fail" ? "✖" : "✔"} ${clip(r.order, 40)}: ${r.msg}${ap.results.length > 1 ? ` (${r1(r.seconds)}s)` : ""}`);
    if (result.status === "interrupted" || result.status === "time" || result.status === "goal" || result.status === "until") { if (ap.cur) parts.push(`… ${clip(ap.cur.label, 40)} (stopped)`); ap.clear(); }
    rec.status = result.status; rec.msg = parts.length > 1 ? parts.join(" → ") : result.msg || ap.results.at(-1)?.msg || ""; rec.seconds = +(world.t - t0).toFixed(2);
    if (ap.results.length > 1 && (result.status === "done" || result.status === "fail")) result.msg = parts.join(" → ");
    // flush logs so errors/notices from the last frames show up now
    const lateLogs = S.closed || hung || stopWhy ? [] : await S.drainLogs().catch(() => []);
    if (lateLogs.length) for (const e of tracker.update(world, world, { logs: lateLogs })) { timeline.push({ t: +e.t.toFixed(2), frame: e.frame, kind: e.kind, text: e.text }); pending.push(e); if (e.kind === "error") errors.push({ t: +e.t.toFixed(2), text: e.text }); }
    const line = resultLine({ status: result.status, order: list.length > 1 && (result.status === "interrupted" || result.status === "time") ? text : list.length === 1 ? text : null, msg: result.msg, seconds: world.t - t0 }) + (result.hint && result.status === "fail" ? `\n  hint: ${result.hint.split("\n")[0]}` : "");
    writeProgress();
    freeze();
    return { code: 0, result: { ...result, line } };
  }

  // ---- --until / --game-hours reached: the order stops, no more orders run, the tester ENDs (or the session does)
  function untilResult(refused) {
    const msg = refused ? `no more orders: the playtest is over (${until.hit.why}); run END now with your feedback`
      : `${until.hit.why}: the playtest is over, run END now with your feedback`;
    return { status: "until", msg, line: resultLine({ status: "until", msg }) };
  }
  function untilReached() {
    const e = { t: until.hit.t, frame, kind: "until", text: `until reached: ${until.hit.why}` };
    timeline.push({ t: +e.t.toFixed(2), frame, kind: e.kind, text: e.text });
    recorder.mark(frame, e.text.slice(0, 120));
    log(e.text);
    // the tester should END now; if it doesn't within 3 minutes, the session ends itself with the same outcome
    untilTimer = setTimeout(() => shutdown("until reached (the tester didn't END)", "until reached"), 180000);
  }

  // ---- live mode ---------------------------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rebase = () => { live.baseWall = Date.now(); live.baseFrame = frame; };
  const orderLabel = () => { const b = ap.activeOrder(); return b ? clip(b.label, 50) : null; };

  /** Hand the waiting `do` (or `look --wait`) its answer; the game keeps running either way. */
  function settle(status, msg, hint) {
    const wt = live.waiter; if (!wt) return;
    live.waiter = null;
    const parts = ap.results.slice(wt.results0).map((r) => `${r.status === "fail" ? "✖" : "✔"} ${clip(r.order, 40)}: ${r.msg}${ap.results.length - wt.results0 > 1 ? ` (${r1(r.seconds)}s)` : ""}`);
    const running = orderLabel();
    let m = msg;
    if ((status === "done" || status === "fail") && parts.length > 1) m = parts.join(" → ");
    if (status === "event" && running && !world.dead) m = `${msg} — ${running} keeps running`;
    if (status === "running") m = running ? `${wt.same ? "same order as the one running, so it carried on: " : ""}${running} is still running; the game keeps going (give a new order to change it, or use next)` : "nothing to do: standing by (the game keeps going)";
    const line = resultLine({ status, order: wt.list && wt.list.length === 1 && status !== "running" ? wt.text : null, msg: m, seconds: world.t - wt.t0 }) + (hint && status === "fail" ? `\n  hint: ${hint.split("\n")[0]}` : "");
    wt.resolve({ code: 0, result: { status, msg: m, line } });
  }

  /** The order chain finished (done/fail) during live play: record it, answer the waiter or leave a note for later. */
  function chainFinished(dec) {
    const rec = live.order; live.order = null;
    const st = dec.status === "idle" ? "done" : dec.status;
    const all = ap.results.map((r) => `${r.status === "fail" ? "✖" : "✔"} ${clip(r.order, 40)}: ${r.msg}`);
    if (rec) { rec.status = st; rec.msg = all.length > 1 ? all.join(" → ") : dec.message || ""; rec.seconds = +(world.t - rec.t).toFixed(2); }
    if (live.waiter && live.waiter.rec === rec) settle(st, dec.message, dec.hint);
    else if (rec) pending.push({ t: world.t, frame, kind: "order", text: `${st === "fail" ? "✖" : "✔"} your order "${clip(rec.text, 40)}" finished: ${clip(rec.msg, 120)}` });
    writeProgress();
  }

  async function liveTick() {
    const dec = ap.decide(world);
    if (dec.status === "call") {
      const ev0 = ap.ctrl.emit(dec.want, frame);
      if (ev0.length) { await S.input(ev0); recorder.add(ev0); sent(ev0); }
      let msg;
      try { const r = await S.call(dec.name, dec.args); msg = `called ${dec.name}(${dec.args.join(", ")}) → ${clip(JSON.stringify(r.result ?? null), 120)}`; recorder.call(frame, dec.name, dec.args); }
      catch (e) { msg = `call ${dec.name} failed: ${e.message}`; }
      if (ap.cur) ap.cur.result = msg;
      await stepWorld(1);
      return;
    }
    const ev = ap.ctrl.emit(dec.want, frame);
    if (ev.length) { await S.input(ev); recorder.add(ev); sent(ev); }
    if ((dec.status === "done" || dec.status === "fail" || dec.status === "idle") && live.order) chainFinished(dec);
    if (S.closed) return;
    const b = ap.activeOrder();
    const bi = b ? { verb: b.o?.verb, careful: !!b.o?.careful, target: b.thingId ?? b.target ?? (b.thing ? b.thing.id : null) } : null;
    // small steps keep a watched window responsive (the game presents frames as it steps)
    const k = Math.max(1, Math.min(opts.watch ? 2 : 4, dec.k || cfg.tick));
    const evs = await stepWorld(k);
    if (deadWatch.hit) { if (live.waiter) settle("ended", endedMsg(stopWhy)); live.stop = true; return; }
    if (until && until.hit) {
      if (live.waiter) settle("until", untilResult(false).msg);
      if (live.order && live.order.status === "running") { live.order.status = "until"; live.order.msg = until.hit.why; live.order.seconds = +(world.t - live.order.t).toFixed(2); live.order = null; }
      ap.clear(); pauseLive(`${until.label} reached: run END`); return;
    }
    if (live.waiter) {
      const wake = wakeFor(evs, bi);
      if (wake) { if (evs.some((e) => e.kind === "goal")) settle("goal", "the game reports a win"); else settle("event", wake); }
      else if (world.t - live.waiter.t0 >= live.waiter.cap - 1e-9) settle("running");
    }
  }

  async function liveLoop() {
    rebase();
    log(`live loop started (speed ${live.speed}, horizon ${live.horizon}s, auto-pause after ${live.pauseAfter}s without orders${opts.watch ? ", watched" : ""})`);
    while (!finalizing && !live.stop && !S.closed) {
      if (live.paused) { await new Promise((r) => { live.resume = r; }); rebase(); continue; }
      if (!live.waiter && Date.now() - live.lastCmd > live.pauseAfter * 1000) { pauseLive(`no orders for ${live.pauseAfter}s`); continue; }
      try { await lock.run(liveTick); }
      catch (e) {
        if (stopWhy || S.closed || hung) break;   // told below
        log(`live tick failed: ${e.stack || e.message}`); if (live.waiter) settle("error", e.message); await sleep(50);
      }
      const target = live.baseWall + ((frame - live.baseFrame) / fps / live.speed) * 1000, now = Date.now();
      if (target > now) await sleep(target - now);
      else if (now - target > 250) rebase();   // the game steps slower than real time: don't try to catch up
      else await sleep(0);                     // let HTTP commands in
    }
    if (stopWhy) { if (live.waiter) settle("ended", endedMsg(stopWhy)); }
    else if (S.closed || hung) {
      const tr = await gameTrouble();
      if (live.waiter) settle("error", tr.msg);
      setTimeout(() => shutdown(tr.msg, tr.outcome), 10);
    } else if (live.waiter) settle("error", "the session is ending");
    log("live loop stopped");
  }
  function pauseLive(why) {
    if (live.paused) return;
    live.paused = true; live.pauseReason = why; freeze();
    const e = { t: world.t, frame, kind: "paused", text: `game paused: ${why} (give an order to resume)` };
    pending.push(e); timeline.push({ t: +e.t.toFixed(2), frame, kind: e.kind, text: e.text });
    log(`paused: ${why}`);
  }
  function resumeLive() {
    if (!live.paused) return;
    live.paused = false; live.pauseReason = null; thaw();
    const e = { t: world.t, frame, kind: "resumed", text: "game resumed" };
    timeline.push({ t: +e.t.toFixed(2), frame, kind: e.kind, text: e.text });
    if (live.resume) { const r = live.resume; live.resume = null; r(); }
  }

  /** live `do`: replace the plan now and answer at the first of: done/failed, an important event, the horizon. */
  async function liveDo(text, forS, waitOnly = false) {
    let list = null;
    if (!waitOnly) {
      try { list = parseOrders(text, { named: cfg.named, combos: cfg.combos }); }
      catch (e) { if (!(e instanceof OrderError)) throw e; parseErrors++; return { code: 2, text: `✖ ${e.message}${e.hint ? `\n  ${e.hint.split("\n").join("\n  ")}` : ""}` }; }
    }
    if (live.stop || S.closed) return { code: 0, result: { status: "error", line: "✖ the game isn't running any more" } };
    if (until && until.hit) return { code: 0, result: untilResult(true) };
    const answer = new Promise((resolve) => {
      lock.run(() => {
        // the same order again while it's still running: keep it going (restarting it would throw away its progress)
        const norm = (x) => String(x || "").trim().toLowerCase().replace(/\s+/g, " ");
        const same = list && live.order && live.order.status === "running" && norm(live.order.text) === norm(text) && !!ap.activeOrder();
        if (same) list = null;
        if (list) {
          if (live.order && live.order.status === "running") { live.order.status = "replaced"; live.order.msg = `replaced by "${clip(text, 40)}"`; live.order.seconds = +(world.t - live.order.t).toFixed(2); }
          ap.setOrders(list);
          const rec = { t: +world.t.toFixed(2), text, status: "running", msg: null, seconds: null };
          orders.push(rec); live.order = rec;
        }
        if (live.waiter) settle("running");   // a newer command supersedes an older wait
        live.waiter = { t0: world.t, cap: forS != null ? +forS : live.horizon, resolve, text, list, same, rec: live.order, results0: list ? 0 : ap.results.length };
      });
    });
    resumeLive();
    return answer;
  }

  function look(result, asJson) {
    const ctx = { cfg, grid, ap, result: result ? { ...result } : null, events: coalesceEvents(pending.splice(0)), first: firstLook, session: { goal: opts.goal, name: spec.name },
      live: live.on ? (live.paused ? `PAUSED: ${live.pauseReason}` : "LIVE") : null, order: live.on ? orderLabel() : null, clock: until ? until.line() : null };
    firstLook = false;
    if (asJson) return { data: observeData(world, ctx) };
    return { text: observeText(world, ctx) };
  }

  function coverage() {
    const open = grid.openCells();
    let seenOpen = 0;
    if (open) for (const k of grid.seen) if (grid.mapSolid.get(k) === false) seenOpen++;
    const b = (() => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const k of grid.visited) { const [x, y] = k.split(",").map(Number); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null; })();
    return { cells: grid.visited.size + (ap.visitedBefore || 0), scenes: ap.visitedBefore ? "all levels (map % is the current one)" : undefined, seen: open ? seenOpen : grid.seen.size, openCells: open || null, percent: open ? Math.round((100 * seenOpen) / open) : null, mapWindow: grid.windowed || undefined, bounds: b };
  }

  function paceStats() {
    const frozen = pace.frozenMs + (pace.frozenSince != null ? Date.now() - pace.frozenSince : 0), wallS = (Date.now() - wall0) / 1000;
    const stopped = orders.filter((o) => ["interrupted", "time", "replaced"].includes(o.status)).length;
    return { mode: live.on ? (opts.watch ? "live (watched)" : "live") : "turns", speed: live.on ? live.speed : null, wallSeconds: +wallS.toFixed(1), gameSeconds: +world.t.toFixed(1),
      freezes: pace.freezes, frozenWallSeconds: +(frozen / 1000).toFixed(1), frozenShare: wallS ? +(frozen / 1000 / wallS).toFixed(2) : 0,
      orders: orders.length, ordersPerGameMinute: world.t ? +(orders.length / (world.t / 60)).toFixed(1) : 0, ordersStoppedEarly: stopped };
  }
  function state(extra = {}) {
    return {
      name: spec.name, game: { name: S.hello.name, engine: S.hello.engine || null }, persona, goal: opts.goal || null, model: opts.model || null,
      seed: recorder.head.seed, scene: opts.scene ?? null, params: opts.params ?? null, startedAt: new Date(wall0).toISOString(),
      wallSeconds: Math.round((Date.now() - wall0) / 1000), gameSeconds: world.t, frames: frame, fps, orders, timeline, tracker,
      until: until ? until.report() : null, incidents: ap.incidents, coverage: coverage(), shots, errors, notes, parseErrors, profile: cfg.profile, pace: paceStats(),
      replay: { file: path.join(dir, "replay.jsonl"), frames: frame, calls: recorder ? [...recorder.frames.values()].reduce((a, x) => a + x.calls.length, 0) : 0 },
      ...extra,
    };
  }
  function writeProgress() {
    try {
      recorder.write(path.join(dir, "replay.jsonl"), frame);
      const r = reportData(state({ status: "in progress" }));
      fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(r, null, 1));
    } catch (e) { log(`progress write failed: ${e.message}`); }
  }

  /** "<why>; the session is over: run END …" for an order the session's end stopped. */
  function endedMsg(why) { return `${why}; the session is over: run END with your feedback (it is still recorded)`; }
  function finalize(reason, outcome, feedback) { return (finalP ??= finalizeNow(reason, outcome, feedback)); }
  async function finalizeNow(reason, outcome, feedback) {
    finalizing = true;
    clearTimeout(idleTimer); clearTimeout(maxTimer); clearTimeout(untilTimer);
    log(`finalizing: ${reason}`);
    // a running order stops first and is told why (it used to step on into the closed game: "the game disconnected")
    stopWhy ??= reason;
    if (doRunning) { await Promise.race([doRunning.catch(() => {}), sleep(hangMs + 3000)]); }
    // live: stop the loop first, so nothing steps after the final snapshot (the replay must end on the same frame)
    if (live.on) { live.stop = true; if (live.resume) { const r0 = live.resume; live.resume = null; r0(); } try { await live.loopP; } catch { /* reported */ } }
    if (live.order && live.order.status === "running") { live.order.status = "ended"; live.order.msg = "still running when the session ended"; live.order.seconds = +(world.t - live.order.t).toFixed(2); }
    pace.frozenSince = null;   // the final pause (writing feedback) isn't play time
    let endState = null;
    try { if (!S.closed && !hung) { const snap = await S.snapshot(); endState = snap.state; for (const l of await S.drainLogs()) if (l.level === "error") errors.push({ t: +world.t.toFixed(2), text: `game error: ${l.message}` }); } } catch (e) { log(`final snapshot failed: ${e.message}`); }
    tracker.finish(world.t);
    const st0 = {};
    if (!outcome) outcome = until && until.hit ? "until reached" : world.won ? "won" : world.dead ? "died" : "ended";
    if (deadWatch.hit) st0.stuckDead = deadWatch.hit;
    const st = state({ status: "finished", outcome, endReason: reason, feedback: feedback || null, endedAt: new Date().toISOString(), ...st0 });
    let summary = "";
    try {
      const rp = path.join(dir, "replay.jsonl");
      recorder.write(rp, frame);
      if (endState) fs.writeFileSync(`${rp}.state.json`, JSON.stringify({ frame, time: world.t, state: endState }));
      const png = await coveragePNG(grid, { path: trail, deaths: tracker.deaths, stuck: ap.incidents });
      if (png) { fs.writeFileSync(path.join(dir, "coverage.png"), png); st.coverage.png = path.join(dir, "coverage.png"); }
      const r = reportData(st);
      writeReports(dir, r);
      const S2 = r.stats;
      summary = `${outcome.toUpperCase()} after ${r1(world.t)}s game time · ${S2.orders} orders · fights ${r.fights.length} (${S2.fightsWon} won) · deaths ${S2.deaths} · stuck ${S2.stuck} · notes ${notes.length}${errors.length ? ` · ${errors.length} game errors` : ""}`;
    } catch (e) { log(`report failed: ${e.stack || e.message}`); summary = `report failed: ${e.message}`; }
    try { await g.stop(); } catch (e) { log(`stop failed: ${e.message}`); }
    setStatus({ state: "ended", endedAt: new Date().toISOString(), reason, outcome, summary });
    log(`ended: ${summary}`);
    return { summary, report: path.join(dir, "report.md"), json: path.join(dir, "report.json"), replay: path.join(dir, "replay.jsonl"), dir };
  }

  // ---- lifetime guards
  const idleMs = Math.max(30, +(opts.idle || 300)) * 1000, maxMs = wallMin * 60000;
  let idleTimer = null, inflight = 0;   // commands being handled: a long order (wait 600) isn't idleness
  const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => (inflight || doRunning ? touch() : shutdown("idle timeout", "idle")), idleMs); };
  const maxTimer = setTimeout(() => shutdown(`session time limit reached (max ${wallMin} min)`, "timeout"), maxMs);
  touch();
  // the game went away by itself: a running order reports it (with the exit code); otherwise the session ends here
  S.conn.onClose(() => { if (!finalizing) { log("the game disconnected"); setTimeout(async () => { if (!finalizing && !doRunning) { const tr = await gameTrouble(); shutdown(tr.msg, tr.outcome); } }, 50); } });
  let chain = Promise.resolve();
  async function shutdown(reason, outcome, feedback) {
    const r = await finalize(reason, outcome, feedback);
    try { server && server.close(); } catch { /* closed */ }
    setTimeout(() => process.exit(0), 400);   // time for a late END to land its feedback
    return r;
  }
  process.on("SIGINT", () => shutdown("interrupted (SIGINT)", "stopped"));
  process.on("SIGTERM", () => shutdown("terminated (SIGTERM)", "stopped"));
  process.on("uncaughtException", (e) => { log(`uncaught: ${e.stack || e.message}`); shutdown(`internal error: ${e.message}`, "stopped"); });
  process.on("unhandledRejection", (e) => { log(`unhandled: ${e && (e.stack || e.message)}`); });

  // ---- the HTTP API
  async function handle(req) {
    touch();
    live.lastCmd = Date.now();
    const cmd = req.cmd, a = req.args || {};
    if (finalizing) {
      // END after the session closed itself (the wall cap, stuck dead, the game exiting): the feedback still counts
      if (cmd === "end") {
        const r = await finalP;
        const fb = { fun: a.fun != null ? +a.fun : null, difficulty: a.difficulty != null ? +a.difficulty : null, text: a.feedback ? String(a.feedback).slice(0, 4000) : null };
        if (fb.text != null || fb.fun != null || fb.difficulty != null) addLateFeedback(dir, fb);
        return { ok: true, text: `the session had already ended (${stopWhy || "ended"})${fb.text != null || fb.fun != null ? "; your feedback was added to the report" : ""}${r ? `\n${r.summary}\nreport: ${r.report}` : ""}`, data: r };
      }
      return { ok: false, code: 1, text: `this session has ended${stopWhy ? ` (${stopWhy})` : ""}: run END with your feedback` };
    }
    const shoot = (why, scale) => (live.on ? lock.run(() => screenshot(why, scale)) : screenshot(why, scale));
    switch (cmd) {
      case "look": {
        let shot = null, res = null;
        if (a.wait && live.on) res = (await liveDo(null, a.for, true)).result;   // keep the plan; answer at the next event or the horizon
        if (a.shot) shot = await shoot("look", a.scale ? +a.scale : 0);
        const o = look(res, a.json);
        return { ok: true, ...o, shot };
      }
      case "do": {
        let r;
        if (live.on) r = await liveDo(String(a.orders || ""), a.for);
        else { doRunning = runDo(String(a.orders || ""), a.for); try { r = await doRunning; } finally { doRunning = null; } }
        if (r.code === 2) return { ok: false, code: 2, text: r.text };
        const o = look(r.result, a.json);
        return { ok: true, ...o };
      }
      case "shot": { const f = await shoot(a.why || "shot", a.scale ? +a.scale : 0); return f ? { ok: true, text: f, shot: f } : { ok: false, code: 1, text: "this game can't take screenshots (no 'screenshot' capability)" }; }
      case "note": {
        const kind = ["bug", "confusing", "fun", "idea"].includes(a.kind) ? a.kind : "note";
        const n = { t: +world.t.toFixed(2), frame, kind, text: oneLine(a.text || "").slice(0, 1000), cell: world.player && world.player.p2 ? cellOf(world, world.player.p2) : null };
        if (a.shot || kind === "bug") n.shot = live.on ? await lock.run(() => keyShot(`${kind}`)) : await keyShot(`${kind}`);
        notes.push(n);
        recorder.mark(frame, `${kind}: ${n.text}`.slice(0, 120));
        timeline.push({ t: n.t, frame, kind: "note", text: `${kind}: ${n.text}` });
        writeProgress();
        return { ok: true, text: `noted (${kind}) at ${r1(world.t)}s${n.shot ? ` · shot ${n.shot}` : ""}` };
      }
      case "status": return { ok: true, text: `session ${spec.name}: ${r1(world.t)}s game time, frame ${frame}, ${orders.length} orders, ${notes.length} notes${world.dead ? ", player dead" : ""}${world.won ? ", goal reached" : ""}`, data: { t: world.t, frame, orders: orders.length } };
      case "end": {
        const fb = { fun: a.fun != null ? +a.fun : null, difficulty: a.difficulty != null ? +a.difficulty : null, text: a.feedback ? String(a.feedback).slice(0, 4000) : null };
        const r = await finalize(a.reason || "ended by the tester", a.outcome || null, fb);
        try { server && server.close(); } catch { /* closed */ }
        setTimeout(() => process.exit(0), 400);
        return { ok: true, text: r ? `${r.summary}\nreport: ${r.report}\nreplay: ${r.replay}` : "ended", data: r };
      }
      default: return { ok: false, code: 1, text: `unknown command '${cmd}'` };
    }
  }

  server = http.createServer((req, res) => {
    // bytes first, decoded once: a multibyte character split across chunks must not turn into U+FFFD
    const parts = []; let n = 0;
    req.on("data", (d) => { parts.push(d); n += d.length; if (n > 1e6) req.destroy(); });
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"); } catch { res.writeHead(400); res.end("{}"); return; }
      if (msg.token !== spec.token) { res.writeHead(403); res.end(JSON.stringify({ ok: false, code: 1, text: "bad token" })); return; }
      // ping is answered here, outside the command queue: a liveness check must not wait behind a running order (it
      // used to time out there and get a healthy session killed). It proves this PID is this session's daemon.
      if (msg.cmd === "ping") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, text: "pong", data: { name: spec.name, pid: process.pid, gamePid: g.proc ? g.proc.pid : null, finalizing } })); return; }
      inflight++;
      chain = chain.then(() => handle(msg)).then((out) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out)); },
        (e) => { log(`command failed: ${e.stack || e.message}`); res.writeHead(200); res.end(JSON.stringify({ ok: false, code: 1, text: `✖ ${e.message}` })); })
        .finally(() => { inflight--; if (!finalizing) touch(); });
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    setStatus({ state: "ready", port, pid: process.pid, gamePid: g.proc ? g.proc.pid : null, fps, profile: cfg.profile, cell: world.cell });
    log(`ready on port ${port} (game pid ${g.proc ? g.proc.pid : "-"}, ${fps} fps, profile ${cfg.profile}, cell ${world.cell}${live.on ? ", LIVE" : ""})`);
    // stopped while it was starting (stop/end found no port yet and left stop.request): checked after "ready" is written,
    // so either that stop saw the port or this sees the file
    if (stopAsked()) { log("stop requested while starting"); shutdown("stopped while starting", "stopped"); return; }
    if (live.on) { ap.standingMode = true; live.lastCmd = Date.now(); live.loopP = liveLoop(); }
  });
}
