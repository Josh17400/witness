// Witness play: the `witness play …` commands. Each one is a thin client: it finds the session (registry), sends one
// request to its daemon over HTTP on 127.0.0.1, prints the answer and exits. `start` spawns the daemon detached
// (hidden, stdio to daemon.log) so the calling shell returns at once.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { readEntry, writeEntry, updateEntry, listEntries, liveEntries, pidAlive, MAX_SESSIONS, removeEntry, writeShim, shimCommand } from "./registry.js";
import { makeBrief, PERSONAS, configArg } from "./brief.js";
import { prune, pruneRegistry, fmtBytes } from "../core/clean.js";
import { ORDER_CARD, ORDER_CARD_PLATFORMER, ORDER_CARD_FPS } from "./orders.js";
import { resolvePlayConfig, describeControls } from "./config.js";
import { launchFlags } from "../cli/common.js";
import { UntilWatch } from "./until.js";

export const PLAY_HELP = `witness play — let a cheap Claude model PLAY the game and report back (docs/PLAYTEST.md)

  witness play start [--name t1] [--goal "…"] [--persona newbie|explorer|speedrunner|breaker|fighter]
                     [--seed N] [--scene S] [--params JSON] [--wall-minutes 20] [--idle 300] [--allow-calls] [--no-map]
                     [--until "<expr>"] [--game-hours N] [--clock "<expr>"] [--model sonnet] [--out DIR] [--force] [--json] [--cmd "<launch>"]
                     [--live] [--watch] [--speed 1] [--horizon 4] [--pause-after 15]
                     → launches the game + a background session daemon, prints the first observation
                     --live: the game keeps running (paced to real time) while the tester thinks; orders steer it
                     --watch: live, and the game shows its window for a human to watch (WITNESS_WATCH=1)
                     --watch --turns: watched, but the game waits while the tester thinks (orders play at real speed)
                     --wall-minutes: hard stop after that many real minutes (old name: --minutes)
                     --until "state.hour >= 18": play until it's true (checked every step), then orders stop and the
                     tester ENDs (outcome "until reached"); --game-hours 4: until the game clock (play.clock in
                     witness.json, or --clock: an expression giving in-game hours) has advanced 4 hours
  witness play do "<orders>" [-s t1] [--for S]  run orders ("fight wolf block; then talk guard") until done/interrupted
                     (live: replaces the plan now, answers at done / an important event / the horizon; play goes on)
  witness play look [-s t1] [--shot] [--json] [--wait]   the observation now (live --wait: at the next event or horizon)
  witness play shot [-s t1] [--scale 2]          screenshot → PNG path (open it with the Read tool)
  witness play note "<text>" [--bug|--confusing|--fun|--idea] [--shot] [-s t1]
  witness play end [-s t1|--all] [--fun 1-5] [--difficulty 1-5] [--feedback "…"]   → report.md/json + replay, stops everything
  witness play status|stop [-s t1|--all]|list [--clean]|report [t1|dir] [--json]
  witness play clean [t1] [--all]                 delete a playtest you've acted on (t1), old ones (no name), or all of them
  witness play brief [--goal …] [--persona …] [--minutes 4 (GAME minutes)] [--until …|--game-hours N] [--wall-minutes M]
                     [--name t1] [--extra "…"] [--live|--watch]  → the prompt for a tester subagent
  witness play suggest [--write]                  probe the game and propose a "play" config for witness.json
  witness play check [--scene S] [--params J]     is the snapshot playtest-ready? what each missing convention unlocks
  witness play batch --goals FILE [--parallel 2] [--minutes 3 (GAME minutes)] [--wall-minutes M] [--until …|--game-hours N]
                     run tester agents headless (claude -p), one per goal, and summarise
  witness play orders                             the order language

Orders:
  ${ORDER_CARD.split("\n").join("\n  ")}
  platformer: ${ORDER_CARD_PLATFORMER}
  fps:        ${ORDER_CARD_FPS}
Sessions live in witness/playtests/<name>/ (report.md, report.json, replay.jsonl, shots/, coverage.png). At most
${MAX_SESSIONS} sessions run at once machine-wide (WITNESS_PLAY_MAX). A session ends itself after --idle seconds without a
command, after --wall-minutes (real time, default 20), when --until is reached and nobody ENDs within 3 minutes,
or when the game exits.`;

function fail(msg, code = 1) { console.error(`✖ ${msg}`); process.exit(code); }

function sessionName(opt, pos) {
  return opt.s || opt.session || process.env.WITNESS_PLAY_SESSION || null;
}

function findSession(opt, { allowEnded = false } = {}) {
  const name = sessionName(opt);
  if (name) {
    const e = readEntry(String(name));
    if (!e) fail(`no session "${name}" — 'witness play list' shows them`);
    e.live = pidAlive(e.pid) && e.state !== "ended" && e.state !== "failed";
    if (!e.live && !allowEnded) fail(`session "${name}" isn't running (${e.state || "gone"}${e.summary ? `: ${e.summary}` : ""})${e.dir ? ` — report: ${path.join(e.dir, "report.md")}` : ""}`);
    return e;
  }
  const live = liveEntries();
  if (live.length === 1) return live[0];
  if (!live.length) {
    if (allowEnded) { const all = listEntries(); if (all.length) return all[0]; }
    fail('no playtest session is running — start one: witness play start --goal "…"');
  }
  fail(`${live.length} sessions are running (${live.map((e) => e.name).join(", ")}) — pick one with -s <name>`);
}

function sessionInfo(e) {
  try { return JSON.parse(fs.readFileSync(path.join(e.dir, "session.json"), "utf8")); } catch { return null; }
}

function request(e, cmd, args = {}, timeoutMs = 20 * 60000) {
  const info = sessionInfo(e);
  if (!info || !info.port) return Promise.reject(new Error(`session "${e.name}" has no control port (state: ${info ? info.state : "unknown"})`));
  const body = JSON.stringify({ token: info.token, cmd, args });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: info.port, method: "POST", path: "/", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (d) => { data += d; });
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(`bad reply from the session daemon: ${data.slice(0, 200)}`)); } });
    });
    req.on("timeout", () => { req.destroy(new Error("the session daemon didn't answer in time")); });
    req.on("error", (err) => reject(err.code === "ECONNREFUSED" ? new Error(`session "${e.name}" isn't answering (it may have ended: see ${path.join(e.dir, "daemon.log")})`) : err));
    req.end(body);
  });
}

function print(out, opt) {
  if (opt.json && out.data !== undefined) console.log(JSON.stringify(out.data, null, 1));
  else if (out.text) console.log(out.text);
  if (out.shot && !opt.json) console.log(`screenshot: ${out.shot}`);
  if (!out.ok) process.exit(out.code || 1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitExit(pid, ms) { const end = Date.now() + ms; while (pidAlive(pid) && Date.now() < end) await sleep(100); return !pidAlive(pid); }
function kill(pid) { if (!pid || !pidAlive(pid)) return; try { process.kill(pid); } catch { /* gone */ } }

/** `witness play <sub> …` */
export async function playCommand(sub, pos, opt, { loadConfig, ROOT }) {
  const cli = `node "${path.join(ROOT, "bin", "witness.js").replace(/\\/g, "/")}"`;
  switch (sub) {
    case undefined: case "help": case "--help": console.log(PLAY_HELP); return;
    case "orders": console.log(`${ORDER_CARD}\nplatformer: ${ORDER_CARD_PLATFORMER}\nfps: ${ORDER_CARD_FPS}`); return;
    case "_daemon": { const { runDaemon } = await import("./daemon.js"); await runDaemon(path.resolve(pos[0])); return; }

    case "start": {
      const { cfg, root, file } = loadConfig(opt);
      const name = String(opt.name && opt.name !== true ? opt.name : `play-${new Date().toISOString().replace(/[-:T]/g, "").slice(4, 14)}`);
      if (!/^[\w.-]{1,40}$/.test(name)) fail(`bad session name "${name}" (letters, digits, - _ . only)`);
      const prev = readEntry(name);
      if (prev && pidAlive(prev.pid) && prev.state !== "ended" && prev.state !== "failed") fail(`a session named "${name}" is already running — end it (witness play end -s ${name}) or pick another --name`);
      const live = liveEntries().filter((e) => e.name !== name);
      if (live.length >= MAX_SESSIONS && !opt.force) fail(`${live.length} playtest sessions are already running (${live.map((e) => e.name).join(", ")}); the limit is ${MAX_SESSIONS} at once (WITNESS_PLAY_MAX) to keep the machine responsive — end one first`);
      let params;
      if (opt.params && opt.params !== true) { try { params = JSON.parse(String(opt.params)); } catch (e) { fail(`--params isn't valid JSON: ${e.message}`); } }
      if (opt.persona && opt.persona !== true && !PERSONAS[opt.persona]) fail(`unknown persona "${opt.persona}" (${Object.keys(PERSONAS).join(", ")})`);
      // old playtests and finished registry entries go before a new one starts (witness.json "retention")
      try { prune(cfg, root, { only: "playtests" }); pruneRegistry(); } catch { /* best effort */ }
      const base = path.resolve(opt.out && opt.out !== true ? String(opt.out) : path.join(root, "witness", "playtests"));
      let dir = path.join(base, name);
      for (let i = 2; fs.existsSync(dir); i++) dir = path.join(base, `${name}-${i}`);
      fs.mkdirSync(dir, { recursive: true });
      const token = crypto.randomBytes(12).toString("hex");
      const opts = {
        goal: opt.goal && opt.goal !== true ? String(opt.goal) : null, persona: opt.persona && opt.persona !== true ? String(opt.persona) : null,
        seed: opt.seed !== undefined && opt.seed !== true ? +opt.seed : cfg.seed ?? 1, scene: opt.scene && opt.scene !== true ? String(opt.scene) : null, params: params ?? null,
        minutes: opt["wall-minutes"] && opt["wall-minutes"] !== true ? +opt["wall-minutes"] : opt.minutes ? +opt.minutes : 20, idle: opt.idle ? +opt.idle : 300, allowCalls: !!opt["allow-calls"], noMap: !!opt["no-map"], model: opt.model && opt.model !== true ? String(opt.model) : null,
        live: !!(opt.live || (opt.watch && !opt.turns)), watch: !!opt.watch, turns: !!opt.turns, speed: opt.speed && opt.speed !== true ? +opt.speed : undefined,
        horizon: opt.horizon && opt.horizon !== true ? +opt.horizon : undefined, pauseAfter: opt["pause-after"] && opt["pause-after"] !== true ? +opt["pause-after"] : undefined,
        until: opt.until && opt.until !== true ? String(opt.until) : null, gameHours: opt["game-hours"] !== undefined && opt["game-hours"] !== true ? +opt["game-hours"] : null,
        clock: opt.clock && opt.clock !== true ? String(opt.clock) : null,
      };
      // --until / --game-hours: a bad combination fails here, before the game launches (bad expressions fail at the first snapshot)
      try { new UntilWatch({ until: opts.until, gameHours: opts.gameHours, clock: opts.clock || (cfg.play && cfg.play.clock) || null }); } catch (err) { fs.rmSync(dir, { recursive: true, force: true }); fail(err.message); }
      // a config file other than the project's witness.json (--config witness.web.json): report.md's replay commands name it
      const spec = { name, token, root, cfg, configFile: file && !/(^|[\\/])witness\.json$/i.test(file) ? file : null, launchFlags: launchFlags(opt), opts, state: "starting", created: new Date().toISOString() };
      fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify(spec, null, 1));
      writeEntry({ name, dir, root, started: spec.created, state: "starting" });
      const out = fs.openSync(path.join(dir, "daemon.log"), "a");
      const child = spawn(process.execPath, [path.join(ROOT, "bin", "witness.js"), "play", "_daemon", dir], { detached: true, windowsHide: true, stdio: ["ignore", out, out], cwd: root, env: { ...process.env } });
      child.unref();
      fs.closeSync(out);
      updateEntry(name, { pid: child.pid });
      const deadline = Date.now() + ((cfg.timeout || 60) + 20) * 1000;
      let info = null;
      while (Date.now() < deadline) {
        await sleep(100);
        info = sessionInfo({ dir });
        if (info && (info.state === "ready" || info.state === "failed")) break;
        if (!pidAlive(child.pid)) { info = sessionInfo({ dir }); break; }
      }
      if (!info || info.state !== "ready") {
        const tail = (() => { try { return fs.readFileSync(path.join(dir, "daemon.log"), "utf8").trim().split("\n").slice(-12).join("\n"); } catch { return ""; } })();
        kill(child.pid);
        updateEntry(name, { state: "failed" });
        fail(`the session didn't start${info && info.error ? `: ${info.error}` : ""}${tail ? `\n--- daemon.log ---\n${tail}` : ""}`);
      }
      const e = readEntry(name);
      const r = await request(e, "look", { json: !!opt.json }).catch((err) => fail(err.message));
      let shim = null;
      try { shim = writeShim(name, path.join(ROOT, "bin", "witness.js")); } catch { /* the long form still works */ }
      if (!opt.json) console.log(`▶ playtest "${name}" started (${path.relative(process.cwd(), dir) || dir}); orders: ${shim ? `${shimCommand(name)} "<orders>"  (or ` : ""}${cli} play do "<orders>" -s ${name}${shim ? ")" : ""}\n`);
      print(r, opt);
      return;
    }

    case "look": case "next": {
      const e = findSession(opt);
      const wait = sub === "next" || !!opt.wait;
      print(await request(e, "look", { shot: !!opt.shot, json: !!opt.json, scale: opt.scale, wait, for: opt.for !== undefined && opt.for !== true ? +opt.for : undefined }).catch((err) => fail(err.message)), opt);
      return;
    }
    case "do": {
      const e = findSession(opt);
      const text = pos.join(" ").trim();
      if (!text) fail(`usage: witness play do "<orders>" — e.g. "explore", "fight wolf block", "talk guard"\n${ORDER_CARD}`, 2);
      print(await request(e, "do", { orders: text, for: opt.for !== undefined && opt.for !== true ? +opt.for : undefined, json: !!opt.json }).catch((err) => fail(err.message)), opt);
      return;
    }
    case "shot": { const e = findSession(opt); print(await request(e, "shot", { scale: opt.scale }).catch((err) => fail(err.message)), opt); return; }
    case "note": {
      const e = findSession(opt);
      const kind = ["bug", "confusing", "fun", "idea"].find((k) => opt[k]) || (opt.kind && opt.kind !== true ? String(opt.kind) : "note");
      const text = pos.join(" ").trim();
      if (!text) fail('usage: witness play note "<what you noticed>" [--bug|--confusing|--fun|--idea]');
      print(await request(e, "note", { text, kind, shot: !!opt.shot }).catch((err) => fail(err.message)), opt);
      return;
    }
    case "status": { const e = findSession(opt, { allowEnded: true }); if (!e.live) { console.log(`session ${e.name}: ${e.state}${e.summary ? ` — ${e.summary}` : ""}\n${e.dir ? path.join(e.dir, "report.md") : ""}`); return; } print(await request(e, "status").catch((err) => fail(err.message)), opt); return; }
    case "end": case "stop": {
      const targets = opt.all ? liveEntries() : [findSession(opt)];
      if (!targets.length) { console.log("no sessions running"); return; }
      for (const e of targets) {
        const args = sub === "end" ? { fun: opt.fun !== undefined && opt.fun !== true ? +opt.fun : undefined, difficulty: opt.difficulty !== undefined && opt.difficulty !== true ? +opt.difficulty : undefined, feedback: opt.feedback && opt.feedback !== true ? String(opt.feedback) : undefined } : { reason: "stopped by the main agent", outcome: "stopped" };
        let r = null;
        try { r = await request(e, "end", args, 120000); } catch (err) { console.error(`⚠ ${e.name}: ${err.message}`); }
        const info = sessionInfo(e);
        if (!(await waitExit(e.pid, 15000))) { kill(e.pid); await waitExit(e.pid, 3000); }
        if (info && info.gamePid && pidAlive(info.gamePid)) kill(info.gamePid);
        if (!r || !r.ok) updateEntry(e.name, { state: "ended" });
        if (r) print({ ...r, ok: true }, opt); else console.log(`session ${e.name} stopped${e.dir ? ` (partial report: ${path.join(e.dir, "report.json")})` : ""}`);
      }
      return;
    }
    case "list": {
      const all = listEntries();
      if (opt.clean) {
        for (const e of all) {
          if (e.live) { try { await request(e, "ping", {}, 3000); } catch { kill(e.pid); const info = sessionInfo(e); if (info && info.gamePid) kill(info.gamePid); updateEntry(e.name, { state: "ended" }); console.log(`killed unresponsive session ${e.name}`); } }
          else if (Date.now() - Date.parse(e.started || 0) > 7 * 864e5 || (e.dir && !fs.existsSync(e.dir))) removeEntry(e.name);   // old, or its folder was deleted
          else if (e.state !== "ended" && e.state !== "failed") updateEntry(e.name, { state: "ended" });
        }
      }
      const rows = listEntries();
      if (!rows.length) { console.log("no playtest sessions"); return; }
      for (const e of rows.slice(0, 30)) console.log(`  ${e.live ? "●" : "○"} ${e.name.padEnd(16)} ${String(e.state || "?").padEnd(8)} ${e.started ? e.started.slice(0, 16).replace("T", " ") : ""}  ${e.summary || ""}${e.dir ? `\n      ${e.dir}` : ""}`);
      return;
    }
    case "clean": {
      // a finished playtest you've acted on (`play clean t1`), the retention limits (no name), or every one (--all)
      const { cfg, root } = loadConfig(opt);
      const name = pos[0];
      if (name) {
        const e = readEntry(name);
        if (e && e.live) fail(`session ${name} is still running: end it first (witness play end -s ${name})`);
        const dir = e && e.dir ? e.dir : path.join(root, "witness", "playtests", name);
        if (!fs.existsSync(dir)) fail(`no playtest folder for "${name}" (${dir})`);
        const r = { removed: [], bytes: 0 };
        const n = (() => { let b = 0; const walk = (p) => { const st = fs.statSync(p); if (st.isDirectory()) for (const x of fs.readdirSync(p)) walk(path.join(p, x)); else b += st.size; }; try { walk(dir); } catch { /* gone */ } return b; })();
        fs.rmSync(dir, { recursive: true, force: true }); removeEntry(name); r.removed.push(dir); r.bytes = n;
        console.log(`removed playtest ${name} (${fmtBytes(r.bytes)})`);
        return;
      }
      const r = prune(cfg, root, { all: !!opt.all, only: "playtests" });
      const k = pruneRegistry();
      console.log(r.removed.length ? `removed ${r.removed.length} playtest folder(s), ${fmtBytes(r.bytes)}${k ? `; ${k} finished session entr${k === 1 ? "y" : "ies"}` : ""}` : `nothing to remove${k ? ` (${k} finished session entr${k === 1 ? "y" : "ies"} dropped)` : ""}`);
      return;
    }
    case "report": {
      let dir;
      const ref = pos[0];
      const byName = ref && /^[\w.-]{1,40}$/.test(ref) ? readEntry(ref) : null;
      if (byName) dir = byName.dir;
      else if (ref && fs.existsSync(path.resolve(ref))) dir = path.resolve(ref);
      else { const e = ref ? null : findSession(opt, { allowEnded: true }); if (!e) fail(`no session or folder "${ref}"`); dir = e.dir; }
      const f = path.join(dir, opt.json ? "report.json" : "report.md");
      if (!fs.existsSync(f)) fail(`no report yet in ${dir}${opt.json ? "" : " (the session may still be running: report.json is updated after every order)"}`);
      console.log(fs.readFileSync(f, "utf8"));
      return;
    }
    case "brief": {
      const { cfg, root, file } = loadConfig(opt);
      try { new UntilWatch({ until: opt.until, gameHours: opt["game-hours"] !== undefined && opt["game-hours"] !== true ? opt["game-hours"] : null, clock: (opt.clock !== true && opt.clock) || (cfg.play && cfg.play.clock) || null }); } catch (err) { fail(err.message); }
      const pc = resolvePlayConfig(cfg.play || {}, { keys: cfg.play && cfg.play.keys });
      let params = opt.params && opt.params !== true ? String(opt.params) : null;
      console.log(makeBrief({
        cli, configDir: configArg(root, file), launch: launchFlags(opt), name: opt.name && opt.name !== true ? String(opt.name) : "t1", goal: opt.goal && opt.goal !== true ? String(opt.goal) : null,
        persona: opt.persona && opt.persona !== true ? String(opt.persona) : "newbie", minutes: opt.minutes ? +opt.minutes : 4, game: `"${cfg.name || "the game"}"`,
        profile: pc.profile, controls: cfg.play && cfg.play.controls ? describeControls(pc) : "", seed: opt.seed !== undefined && opt.seed !== true ? +opt.seed : null,
        scene: opt.scene && opt.scene !== true ? String(opt.scene) : null, params, model: opt.model && opt.model !== true ? String(opt.model) : null, live: !!(opt.live || (opt.watch && !opt.turns)), watch: !!opt.watch, turns: !!opt.turns, extra: opt.extra && opt.extra !== true ? String(opt.extra) : (cfg.play && cfg.play.brief) || null,
        until: opt.until && opt.until !== true ? String(opt.until) : null, gameHours: opt["game-hours"] !== undefined && opt["game-hours"] !== true ? +opt["game-hours"] : null,
        wallMinutes: opt["wall-minutes"] !== undefined && opt["wall-minutes"] !== true ? +opt["wall-minutes"] : null, clock: opt.clock && opt.clock !== true ? String(opt.clock) : null,
      }));
      return;
    }
    case "suggest": { const { suggest } = await import("./suggest.js"); await suggest(opt, { loadConfig, ROOT }); return; }
    case "check": { const { playCheck } = await import("./check.js"); await playCheck(opt, { loadConfig }); return; }
    case "batch": { const { playBatch } = await import("./batch.js"); await playBatch(opt, { loadConfig, ROOT, cli }); return; }
    default: fail(`unknown play command '${sub}'\n\n${PLAY_HELP}`);
  }
}
