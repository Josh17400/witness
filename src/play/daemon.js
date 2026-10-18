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
import { EventTracker, cellOf } from "./events.js";
import { observeText, observeData, resultLine } from "./observe.js";
import { parseOrders, OrderError } from "./orders.js";
import { ReplayRecorder } from "./recorder.js";
import { reportData, reportMarkdown, coveragePNG } from "./report.js";
import { updateEntry } from "./registry.js";
import { r1, clip, oneLine } from "./util.js";
import { PERSONAS } from "./brief.js";
export { PERSONAS };



const DEBUG = !!process.env.WITNESS_PLAY_DEBUG;
const OPEN_ENDED = new Set(["explore", "wait", "follow", "run", "waitfor", "hold", "block"]);

export async function runDaemon(dir) {
  const specFile = path.join(dir, "session.json");
  const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
  const logFile = path.join(dir, "daemon.log");
  const log = (m) => { try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${m}\n`); } catch { /* disk */ } };
  const setStatus = (patch) => { Object.assign(spec, patch); fs.writeFileSync(specFile, JSON.stringify(spec, null, 1)); try { updateEntry(spec.name, { ...patch, dir }); } catch { /* registry */ } };
  const opts = spec.opts || {};
  const wall0 = Date.now();
  log(`daemon ${process.pid} starting session ${spec.name} in ${spec.root}`);

  let g;
  try {
    g = await openGame(spec.cfg, spec.root, { quiet: true, timeout: spec.cfg.timeout });
  } catch (e) {
    log(`launch failed: ${e.message}`);
    setStatus({ state: "failed", error: e.message });
    process.exit(1);
  }
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
  let frame = 0, world = null, finalizing = false, server = null;
  const timeline = [], orders = [], notes = [], shots = [], errors = [], pending = [], trail = [];
  let parseErrors = 0, lastLogFrame = 0, firstLook = true;
  const recorder = new ReplayRecorder({ name: S.hello.name || spec.cfg.name, seed: opts.seed ?? spec.cfg.seed ?? 1, fps, scene: opts.scene ?? null, params: opts.params ?? null, session: spec.name });
  const dts = (k) => Array(k).fill(1 / fps);

  // ---- start the run
  let grid, ap, tracker;
  try {
    if (S.has("reset")) await S.reset(opts.seed ?? spec.cfg.seed ?? 1, opts.scene || undefined, opts.params || undefined);
    const snap = await S.snapshot();
    world = perceiver.perceive(snap, 0);
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

  // ---- the reflex loop for one `do`
  const wakeFor = (ev, b) => {
    const combat = ap.inCombat(), careful = b && b.careful;
    for (const e of ev) {
      if (["death", "goal", "error", "scene", "lowhp"].includes(e.kind)) return e.text;
      if (e.kind === "dialogue" && !/^(talk|interact|choose|press|use)$/.test(b?.verb || "")) return e.text;
      if (!combat && e.kind === "hurt" && b?.verb !== "flee") return e.text;
      if (!combat && e.kind === "alert" && b?.verb !== "flee" && !(b?.target != null && e.data && String(e.data.id) === String(b.target))) return e.text;
      if (careful && ["appear", "notice", "pickup", "kill"].includes(e.kind)) return e.text;
    }
    return null;
  };
  async function stepWorld(k) {
    await S.step(k, null, dts(k));
    frame += k;
    const snap = await S.snapshot();
    let logs = [];
    if (frame - lastLogFrame >= Math.max(1, Math.round(fps / 4))) { logs = await S.drainLogs(); lastLogFrame = frame; }
    const nw = perceiver.perceive(snap, frame);
    ap.observe(nw);
    const ev = tracker.update(world, nw, { lastAttackT: ap.lastAttackT, logs, retreat: ap.policy.retreat });
    for (const e of ap.drainEvents()) ev.push({ t: nw.t, frame, ...e });
    world = nw;
    world.remembered = world.remembered.filter((th) => !(perceiver.memory.get(th.id) || {}).gone);
    if (world.player && world.player.p2) { const c = cellOf(world, world.player.p2); const last = trail.at(-1); if (!last || last[0] !== c[0] || last[1] !== c[1]) trail.push(c); }
    for (const e of ev) {
      timeline.push({ t: +e.t.toFixed(2), frame: e.frame, kind: e.kind, text: e.text });
      if (e.kind === "error") errors.push({ t: +e.t.toFixed(2), text: e.text });
      if (e.kind === "death") await keyShot("death");
      if (e.kind === "goal") await keyShot("goal reached");
      if (e.kind === "error" && errors.length <= 3) await keyShot("game error");
      if (e.kind === "stuck" && e.data && !e.data.resolved) { const f = await keyShot("stuck"); const inc = ap.incidents.at(-1); if (inc && f) inc.shot = f; }
      if (e.kind === "dialogue" && /opened/.test(e.text) && tracker.dialogues.length <= 3) await keyShot("dialogue");
    }
    for (const fs0 of tracker.firstSight.splice(0)) if (fs0.t > 0) await keyShot(`first ${fs0.type}`);
    pending.push(...ev);
    return ev;
  }

  async function runDo(text, forS) {
    let list;
    try { list = parseOrders(text, { named: cfg.named, combos: cfg.combos }); }
    catch (e) { if (!(e instanceof OrderError)) throw e; parseErrors++; return { code: 2, text: `✖ ${e.message}${e.hint ? `\n  ${e.hint.split("\n").join("\n  ")}` : ""}` }; }
    const t0 = world.t;
    const cap = forS != null ? +forS : list.every((o) => OPEN_ENDED.has(o.verb) || o.forS) ? Math.max(...list.map((o) => o.forS || 6)) + 0.5 : Math.max(25, ...list.map((o) => (o.forS || 0) + 1));
    ap.setOrders(list);
    const rec = { t: +t0.toFixed(2), text, status: null, msg: null, seconds: null };
    orders.push(rec);
    let result = null;
    for (let guard = 0; guard < 200000; guard++) {
      const dec = ap.decide(world);
      if (dec.status === "call") {
        const ev0 = ap.ctrl.emit(dec.want, frame);
        if (ev0.length) { await S.input(ev0); recorder.add(ev0); }
        let msg;
        try { const r = await S.call(dec.name, dec.args); msg = `called ${dec.name}(${dec.args.join(", ")}) → ${clip(JSON.stringify(r.result ?? null), 120)}`; recorder.call(frame, dec.name, dec.args); }
        catch (e) { msg = `call ${dec.name} failed: ${e.message}`; }
        if (ap.cur) ap.cur.result = msg;
        await stepWorld(1);   // a call is always followed by a step, so it lands inside the recording
        continue;
      }
      const ev = ap.ctrl.emit(dec.want, frame);
      if (ev.length) { await S.input(ev); recorder.add(ev); }
      if (DEBUG) {
        const nav = ap.cur && (ap.cur.nav || (ap.cur.go && ap.cur.go.nav));
        log(`tick f${frame} t${world.t.toFixed(2)} p=${world.player && world.player.p2 ? world.player.p2.map((x) => x.toFixed(1)).join(",") : "-"} ${ap.cur ? ap.cur.label : "-"} st=${dec.status} k=${dec.k} held=[${[...ap.ctrl.held.keys()].join(" ")}] ev=${ev.map((e) => `${e.key || e.type}${e.down === true ? "+" : e.down === false ? "-" : ""}@${e.frame}`).join(" ")}${nav ? ` path=${(nav.path || []).slice(0, 4).map((c) => c.join(".")).join(">")} esc=${nav.escape ? JSON.stringify(nav.escape) : ""} best=${(nav.best / world.cell).toFixed(2)}@${nav.bestT.toFixed(2)}` : ""}`);
      }
      if (dec.status === "done" || dec.status === "fail" || dec.status === "idle") { result = { status: dec.status === "idle" ? "done" : dec.status, msg: dec.message, hint: dec.hint }; break; }
      if (S.closed) { result = { status: "error", msg: "the game disconnected (crashed?)" }; break; }
      const b = ap.cur ? { verb: ap.cur.o?.verb, careful: !!ap.cur.o?.careful, target: ap.cur.thingId ?? ap.cur.target ?? (ap.cur.thing ? ap.cur.thing.id : null) } : null;
      const evs = await stepWorld(Math.max(1, dec.k));
      const wake = wakeFor(evs, b);
      if (wake) { result = evs.some((e) => e.kind === "goal") ? { status: "goal", msg: "the game reports a win" } : { status: "interrupted", msg: wake }; break; }
      if (world.t - t0 >= cap - 1e-9) { result = { status: "time", msg: `stopped after ${r1(world.t - t0)}s of game time${ap.cur ? ` (${clip(ap.cur.label, 40)} still running; give a new order or the same one again)` : ""}` }; break; }
    }
    // results of a chain: show each finished order
    const parts = ap.results.map((r) => `${r.status === "fail" ? "✖" : "✔"} ${clip(r.order, 40)}: ${r.msg}${ap.results.length > 1 ? ` (${r1(r.seconds)}s)` : ""}`);
    if (result.status === "interrupted" || result.status === "time" || result.status === "goal") { if (ap.cur) parts.push(`… ${clip(ap.cur.label, 40)} (stopped)`); ap.clear(); }
    rec.status = result.status; rec.msg = parts.length > 1 ? parts.join(" → ") : result.msg || ap.results.at(-1)?.msg || ""; rec.seconds = +(world.t - t0).toFixed(2);
    if (ap.results.length > 1 && (result.status === "done" || result.status === "fail")) result.msg = parts.join(" → ");
    // flush logs so errors/notices from the last frames show up now
    const lateLogs = await S.drainLogs();
    if (lateLogs.length) for (const e of tracker.update(world, world, { logs: lateLogs })) { timeline.push({ t: +e.t.toFixed(2), frame: e.frame, kind: e.kind, text: e.text }); pending.push(e); if (e.kind === "error") errors.push({ t: +e.t.toFixed(2), text: e.text }); }
    const line = resultLine({ status: result.status, order: list.length > 1 && (result.status === "interrupted" || result.status === "time") ? text : list.length === 1 ? text : null, msg: result.msg, seconds: world.t - t0 }) + (result.hint && result.status === "fail" ? `\n  hint: ${result.hint.split("\n")[0]}` : "");
    writeProgress();
    return { code: 0, result: { ...result, line } };
  }

  function look(result, asJson) {
    const ctx = { cfg, grid, ap, result: result ? { ...result } : null, events: pending.splice(0), first: firstLook, session: { goal: opts.goal, name: spec.name } };
    firstLook = false;
    if (asJson) return { data: observeData(world, ctx) };
    return { text: observeText(world, ctx) };
  }

  function coverage() {
    const open = grid.openCells();
    let seenOpen = 0;
    if (open) for (const k of grid.seen) if (grid.mapSolid.get(k) === false) seenOpen++;
    const b = (() => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const k of grid.visited) { const [x, y] = k.split(",").map(Number); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null; })();
    return { cells: grid.visited.size, seen: open ? seenOpen : grid.seen.size, openCells: open || null, percent: open ? Math.round((100 * seenOpen) / open) : null, bounds: b };
  }

  function state(extra = {}) {
    return {
      name: spec.name, game: { name: S.hello.name, engine: S.hello.engine || null }, persona, goal: opts.goal || null, model: opts.model || null,
      seed: recorder.head.seed, scene: opts.scene ?? null, params: opts.params ?? null, startedAt: new Date(wall0).toISOString(),
      wallSeconds: Math.round((Date.now() - wall0) / 1000), gameSeconds: world.t, frames: frame, fps, orders, timeline, tracker,
      incidents: ap.incidents, coverage: coverage(), shots, errors, notes, parseErrors, profile: cfg.profile,
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

  async function finalize(reason, outcome, feedback) {
    if (finalizing) return null;
    finalizing = true;
    clearTimeout(idleTimer); clearTimeout(maxTimer);
    log(`finalizing: ${reason}`);
    let endState = null;
    try { if (!S.closed) { const snap = await S.snapshot(); endState = snap.state; for (const l of await S.drainLogs()) if (l.level === "error") errors.push({ t: +world.t.toFixed(2), text: `game error: ${l.message}` }); } } catch (e) { log(`final snapshot failed: ${e.message}`); }
    tracker.finish(world.t);
    if (!outcome) outcome = world.won ? "won" : world.dead ? "died" : "ended";
    const st = state({ status: "finished", outcome, endReason: reason, feedback: feedback || null, endedAt: new Date().toISOString() });
    let summary = "";
    try {
      const rp = path.join(dir, "replay.jsonl");
      recorder.write(rp, frame);
      if (endState) fs.writeFileSync(`${rp}.state.json`, JSON.stringify({ frame, time: world.t, state: endState }));
      const png = await coveragePNG(grid, { path: trail, deaths: tracker.deaths, stuck: ap.incidents });
      if (png) { fs.writeFileSync(path.join(dir, "coverage.png"), png); st.coverage.png = path.join(dir, "coverage.png"); }
      const r = reportData(st);
      fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(r, null, 1));
      const rel = (p) => path.relative(spec.root, p).replace(/\\/g, "/");
      fs.writeFileSync(path.join(dir, "report.md"), reportMarkdown(r, { rel, replayCmd: "witness replay" }));
      const S2 = r.stats;
      summary = `${outcome.toUpperCase()} after ${r1(world.t)}s game time · ${S2.orders} orders · fights ${r.fights.length} (${S2.fightsWon} won) · deaths ${S2.deaths} · stuck ${S2.stuck} · notes ${notes.length}${errors.length ? ` · ${errors.length} game errors` : ""}`;
    } catch (e) { log(`report failed: ${e.stack || e.message}`); summary = `report failed: ${e.message}`; }
    try { await g.stop(); } catch (e) { log(`stop failed: ${e.message}`); }
    setStatus({ state: "ended", endedAt: new Date().toISOString(), reason, outcome, summary });
    log(`ended: ${summary}`);
    return { summary, report: path.join(dir, "report.md"), json: path.join(dir, "report.json"), replay: path.join(dir, "replay.jsonl"), dir };
  }

  // ---- lifetime guards
  const idleMs = Math.max(30, +(opts.idle || 300)) * 1000, maxMs = Math.max(1, +(opts.minutes || 20)) * 60000;
  let idleTimer = null;
  const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => shutdown("idle timeout", "idle"), idleMs); };
  const maxTimer = setTimeout(() => shutdown("max session time", "timeout"), maxMs);
  touch();
  S.conn.onClose(() => { if (!finalizing) { log("the game disconnected"); shutdown("the game exited or crashed", "crashed"); } });
  let chain = Promise.resolve();
  async function shutdown(reason, outcome, feedback) {
    const r = await finalize(reason, outcome, feedback);
    try { server && server.close(); } catch { /* closed */ }
    setTimeout(() => process.exit(0), 150);
    return r;
  }
  process.on("SIGINT", () => shutdown("interrupted (SIGINT)", "stopped"));
  process.on("SIGTERM", () => shutdown("terminated (SIGTERM)", "stopped"));
  process.on("uncaughtException", (e) => { log(`uncaught: ${e.stack || e.message}`); shutdown(`internal error: ${e.message}`, "stopped"); });
  process.on("unhandledRejection", (e) => { log(`unhandled: ${e && (e.stack || e.message)}`); });

  // ---- the HTTP API
  async function handle(req) {
    touch();
    const cmd = req.cmd, a = req.args || {};
    if (finalizing) return { ok: false, code: 1, text: "this session has ended" };
    switch (cmd) {
      case "ping": return { ok: true, text: "pong" };
      case "look": {
        let shot = null;
        if (a.shot) shot = await screenshot("look", a.scale ? +a.scale : 0);
        const o = look(null, a.json);
        return { ok: true, ...o, shot };
      }
      case "do": {
        const r = await runDo(String(a.orders || ""), a.for);
        if (r.code === 2) return { ok: false, code: 2, text: r.text };
        const o = look(r.result, a.json);
        if (S.closed && !finalizing) setTimeout(() => shutdown("the game exited or crashed", "crashed"), 10);
        return { ok: true, ...o };
      }
      case "shot": { const f = await screenshot(a.why || "shot", a.scale ? +a.scale : 0); return f ? { ok: true, text: f, shot: f } : { ok: false, code: 1, text: "this game can't take screenshots (no 'screenshot' capability)" }; }
      case "note": {
        const kind = ["bug", "confusing", "fun", "idea"].includes(a.kind) ? a.kind : "note";
        const n = { t: +world.t.toFixed(2), frame, kind, text: oneLine(a.text || "").slice(0, 1000), cell: world.player && world.player.p2 ? cellOf(world, world.player.p2) : null };
        if (a.shot || kind === "bug") n.shot = await keyShot(`${kind}`);
        notes.push(n);
        recorder.mark(frame, `${kind}: ${n.text}`.slice(0, 120));
        timeline.push({ t: n.t, frame, kind: "note", text: `${kind}: ${n.text}` });
        writeProgress();
        return { ok: true, text: `noted (${kind}) at ${r1(world.t)}s${n.shot ? ` · shot ${n.shot}` : ""}` };
      }
      case "status": return { ok: true, text: `session ${spec.name}: ${r1(world.t)}s game time, frame ${frame}, ${orders.length} orders, ${notes.length} notes${world.dead ? ", player dead" : ""}${world.won ? ", goal reached" : ""}`, data: { t: world.t, frame, orders: orders.length } };
      case "end": {
        const fb = { fun: a.fun != null ? +a.fun : null, difficulty: a.difficulty != null ? +a.difficulty : null, text: a.feedback ? String(a.feedback).slice(0, 4000) : null };
        const r = await finalize(a.reason || "ended by the tester", null, fb);
        try { server && server.close(); } catch { /* closed */ }
        setTimeout(() => process.exit(0), 300);
        return { ok: true, text: r ? `${r.summary}\nreport: ${r.report}\nreplay: ${r.replay}` : "ended", data: r };
      }
      default: return { ok: false, code: 1, text: `unknown command '${cmd}'` };
    }
  }

  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(body || "{}"); } catch { res.writeHead(400); res.end("{}"); return; }
      if (msg.token !== spec.token) { res.writeHead(403); res.end(JSON.stringify({ ok: false, code: 1, text: "bad token" })); return; }
      chain = chain.then(() => handle(msg)).then((out) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out)); },
        (e) => { log(`command failed: ${e.stack || e.message}`); res.writeHead(200); res.end(JSON.stringify({ ok: false, code: 1, text: `✖ ${e.message}` })); });
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    setStatus({ state: "ready", port, pid: process.pid, gamePid: g.proc ? g.proc.pid : null, fps, profile: cfg.profile, cell: world.cell });
    log(`ready on port ${port} (game pid ${g.proc ? g.proc.pid : "-"}, ${fps} fps, profile ${cfg.profile}, cell ${world.cell})`);
  });
}
