// Witness play: `witness play batch` runs tester agents itself, as headless Claude Code processes (`claude -p`), one
// per goal, at most 2 at once (1 for a web game: each is a headless browser), one batch machine-wide. For agents that
// can't spawn subagents (workflow subagents have no Agent tool): the batch is a plain command (run it in the background). Each tester gets the same brief `play brief` prints, may run only the witness commands
// (Bash limited to them, plus Read for screenshots, permission mode dontAsk), and uses the user's Claude Code login
// (ANTHROPIC_API_KEY is removed from its environment). Nothing is left running: a wall-clock timeout per tester, the
// session stopped after each tester, and Ctrl-C kills every tester and its session.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { makeBrief, PERSONAS, configArg, cmdRoot, launchArgs } from "./brief.js";
import { resolvePlayConfig, describeControls } from "./config.js";
import { readEntry, pidAlive, shimPath, shimCommand, acquireBatchLock, validName, LOCK_BEAT_MS } from "./registry.js";
import { prune, fmtBytes } from "../core/clean.js";
import { budgetLimits } from "../core/budget.js";
import { UntilWatch, fmtHours } from "./until.js";

const r1 = (x) => Math.round(x * 10) / 10;

/** Goals: a text file (one per line, # comments) or JSON (a list of strings or {goal, persona, scene, params, minutes, model, live}). */
export function readGoals(file) {
  const txt = fs.readFileSync(file, "utf8");
  if (/\.json$/i.test(file) || /^\s*\[/.test(txt)) {
    const j = JSON.parse(txt);
    if (!Array.isArray(j)) throw new Error("a JSON goals file must be a list");
    return j.map((g) => (typeof g === "string" ? { goal: g } : g)).filter((g) => g && g.goal);
  }
  return txt.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((goal) => ({ goal }));
}

/** The play commands a tester may run (the brief's, plus the order card): no batch, clean, stop --all, list --clean. */
export const TESTER_COMMANDS = ["start", "do", "look", "next", "shot", "note", "end", "status", "orders"];
/**
 * The `claude -p` arguments for one tester: the model, low effort, Bash limited to the witness commands, no prompts.
 * The brief's order command is the session shim's absolute path (no cd: dontAsk denies a cd outside the working
 * folder whatever the rules say). Allowed: that path bare and quoted, the long `node "…witness.js" play` form, and the
 * harmless `./name` form; --add-dir lets a tester that cds to the registry anyway (`cd … && ./name`) run.
 */
export function testerArgs({ model = "sonnet", effort = "low", cliJs, name }) {
  const wit = `node "${cliJs}" play`;
  const abs = shimPath(name).replace(/\\/g, "/");
  // Git Bash's /c/... form of the same path (a tester that rewrites it, or copies `pwd`): dontAsk matches rules textually
  const msys = /^[A-Za-z]:\//.test(abs) ? `/${abs[0].toLowerCase()}${abs.slice(2)}` : null;
  const forms = [abs, `"${abs}"`, ...(msys ? [msys, `"${msys}"`] : []), `./${name}`];
  const allow = [...TESTER_COMMANDS.flatMap((c) => [`Bash(${wit} ${c}:*)`, `Bash(${wit} ${c} *)`]), ...forms.flatMap((f) => [`Bash(${f}:*)`, `Bash(${f} *)`, `Bash(${f})`]), "Bash(cd:*)", "Read"];
  return ["-p", "--model", model, "--effort", effort, "--tools", "Bash,Read", "--allowedTools", ...allow, "--add-dir", path.dirname(shimPath(name)), "--permission-mode", "dontAsk",
    "--setting-sources", "project,local", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--output-format", "json"];
}

function killTree(pid) {
  if (!pid || !pidAlive(pid)) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } }
}

/**
 * A tester that was stopped by a permission denial instead of playing: 0 orders, and a denial in claude's JSON result
 * (`permission_denials`) or words to that effect in its reply. Returns {command} (null when only the reply says so).
 */
export function blockedBy({ denials, reply, report }) {
  if (report && report.stats && report.stats.orders > 0) return null;
  const ds = Array.isArray(denials) ? denials.filter(Boolean) : [];
  const d = ds.find((x) => x.tool_name === "Bash") || ds[0];
  if (d) { const inp = d.tool_input || {}; return { command: String(inp.command || inp.file_path || d.tool_name || "?") }; }
  if (reply && /permission|not (allowed|permitted)|was denied|denied by|dontAsk|don't ask mode/i.test(String(reply))) return { command: null };
  return null;
}
export const blockedText = (b) => `blocked: permission denied${b.command ? ` (${clip1(b.command, 100)})` : ""}`;
const clip1 = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The retry prompt after a permission block: the brief plus the exact allowed form. */
export function nudge(brief, b, name) {
  const S = shimCommand(name);
  return `${brief}\n\nIMPORTANT, A PREVIOUS ATTEMPT WAS BLOCKED: ${b.command ? `\`${b.command}\` was denied` : "a command was denied"} (there is no permission prompt here, so a denied command just fails). Only the exact command forms listed under COMMANDS are allowed. Run each one on its own, starting with the full path, for example:\n  ${S} "explore"\n  ${S} look\nUse the path exactly as shown (not a /c/... form), no cd, no && or ;, no other programs; note and feedback text in single quotes with no backticks. That attempt's session was stopped: begin again with the start command.`;
}

/**
 * The claude binary: `claude`, or WITNESS_CLAUDE (a path; a .js/.mjs file runs with node — tests use a fake tester).
 * Windows: spawn() can't run npm's claude.cmd without a shell (and a shell would mangle the quoted --allowedTools), so
 * claude.exe is looked up on PATH, else the script inside claude.cmd is run with node.
 */
export function claudeCommand(env = process.env, platform = process.platform) {
  const c = env.WITNESS_CLAUDE;
  if (c) return /\.m?js$/i.test(c) ? [process.execPath, c] : [c];
  if (platform !== "win32") return ["claude"];
  const dirs = String(env.PATH || env.Path || "").split(";").filter(Boolean);
  for (const d of dirs) { const f = path.join(d, "claude.exe"); if (fs.existsSync(f)) return [f]; }
  for (const d of dirs) {
    const f = path.join(d, "claude.cmd");
    if (!fs.existsSync(f)) continue;
    // npm's shim: IF EXIST "%dp0%\node.exe" (…) first, then … "%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*
    // (or an .exe it wraps): the target is the last match that isn't node.exe (node.exe beside it is only the runtime)
    let txt = ""; try { txt = fs.readFileSync(f, "utf8"); } catch { /* unreadable */ }
    const ms = [...txt.matchAll(/"%~?dp0%?\\?([^"%]+\.(m?js|cjs|exe))"/gi)].filter((m) => !/(^|[\\/])node\.exe$/i.test(m[1])).reverse();
    for (const m of ms) { const t = path.join(d, m[1]); if (fs.existsSync(t)) return /exe$/i.test(m[2]) ? [t] : [process.execPath, t]; }
  }
  return ["claude"];
}

/**
 * `witness play batch --goals FILE [--persona P] [--model sonnet] [--effort low] [--parallel 2] [--minutes 3 (game)]
 *  [--wall-minutes M] [--until "<expr>"] [--game-hours N] [--timeout M] [--scene S] [--params J] [--live]`
 */
export async function playBatch(opt, { loadConfig, ROOT }) {
  const L = loadConfig(opt), { cfg, file } = L, root = cmdRoot(opt, L.root);
  if (!opt.goals || opt.goals === true) { console.error("✖ --goals FILE is required (one goal per line, or a JSON list of {goal, persona, scene, params, minutes, until, gameHours, wallMinutes})"); process.exit(1); }
  let goals;
  try { goals = readGoals(path.resolve(String(opt.goals))); } catch (e) { console.error(`✖ can't read --goals: ${e.message}`); process.exit(1); }
  if (!goals.length) { console.error("✖ no goals in the file"); process.exit(1); }
  const cliJs = path.join(ROOT, "bin", "witness.js").replace(/\\/g, "/");
  const cli = `node "${cliJs}"`;
  // a web game's session is a headless browser: one tester at a time (the session limit allows one web session); never
  // more games at once than the machine-wide heavy-process budget allows (WITNESS_MAX_PROCS; the rest would only queue)
  const web = !!(cfg.launch && cfg.launch.url && !cfg.launch.attach);
  const procs = budgetLimits().max;
  const parallel = web ? 1 : Math.max(1, Math.min(2, +(opt.parallel || 2), procs || Infinity));
  const val = (k) => (opt[k] !== undefined && opt[k] !== true ? opt[k] : null);
  const minutes = opt.minutes ? +opt.minutes : 3;   // GAME minutes (the tester's budget)
  const wallDefault = val("wall-minutes") != null ? +val("wall-minutes") : null;   // a hard wall-clock stop per session
  const d0 = new Date(), p2 = (n) => String(n).padStart(2, "0");
  const stamp = `${p2(d0.getMonth() + 1)}${p2(d0.getDate())}${p2(d0.getHours())}${p2(d0.getMinutes())}`;   // MMDDhhmm, local time
  const pc = resolvePlayConfig(cfg.play || {}, {});
  const clock = val("clock") != null ? String(val("clock")) : (cfg.play && cfg.play.clock) || null;
  const runs = goals.map((g, i) => {
    const name = String(g.name || `${opt.prefix && opt.prefix !== true ? opt.prefix : "b"}${stamp}-${i + 1}`).slice(0, 40);
    const persona = PERSONAS[g.persona] ? g.persona : PERSONAS[opt.persona] ? opt.persona : "newbie";
    const mins = +(g.minutes ?? minutes);
    const until = g.until ?? (val("until") != null ? String(val("until")) : null);
    const gameHours = g.gameHours ?? (val("game-hours") != null ? +val("game-hours") : null);
    const wall = wallCapFor({ wall: g.wallMinutes != null ? +g.wallMinutes : wallDefault, minutes: mins, until, gameHours });
    const model = g.model || (val("model") != null ? String(val("model")) : "sonnet");
    const brief = makeBrief({
      cli, configDir: configArg(root, file), launch: launchArgs(opt), name, goal: g.goal, persona, minutes: mins, game: `"${cfg.name || "the game"}"`, profile: pc.profile,
      controls: cfg.play && cfg.play.controls ? describeControls(pc) : "", seed: g.seed ?? (val("seed") != null ? +val("seed") : null),
      scene: g.scene ?? (val("scene") != null ? String(val("scene")) : null), params: g.params ?? (val("params") != null ? String(val("params")) : null),
      model, live: !!(g.live ?? opt.live), extra: (cfg.play && cfg.play.brief) || null, until, gameHours, wallMinutes: wall, clock: val("clock") != null ? String(val("clock")) : null,
    });
    const timeoutMin = +(opt.timeout || wall + 3);
    return { i: i + 1, name, goal: g.goal, persona, minutes: mins, until, gameHours, wall, model, brief, timeoutMin };
  });
  for (const r of runs) if (!validName(r.name)) { console.error(`✖ goal #${r.i}: bad session name "${r.name}" (letters, digits, - _ . only, not all dots)`); process.exit(1); }
  for (const r of runs) { try { new UntilWatch({ until: r.until, gameHours: r.gameHours, clock }); } catch (e) { console.error(`✖ goal #${r.i}: ${e.message}`); process.exit(1); } }
  if (opt["dry-run"]) { for (const r of runs) console.log(`#${r.i} ${r.name}: claude ${testerArgs({ model: r.model, effort: opt.effort || "low", cliJs, name: r.name }).join(" ")}  (brief: ${r.brief.length} chars; ${budgetText(r)}, tester timeout ${r.timeoutMin} wall min)`); return; }

  // one batch machine-wide (each is up to 2 games plus 2 claude processes); a dead holder's lock doesn't count
  const lock = acquireBatchLock({ root, goals: runs.length });
  if (!lock.ok) { console.error(`✖ another playtest batch is running (pid ${lock.holder.pid}${lock.holder.started ? `, since ${String(lock.holder.started).slice(0, 16).replace("T", " ")}` : ""}${lock.holder.root ? `, ${lock.holder.root}` : ""}): wait for it to finish`); process.exit(1); }
  process.on("exit", () => lock.release());
  const beat = setInterval(() => lock.beat(), LOCK_BEAT_MS); beat.unref();   // untouched for 2 min = stale (a killed batch)
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "witness-batch-"));   // the testers' working folder (empty)
  const env = { ...process.env, WITNESS_PLAY_TESTER: "1" };
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"]) delete env[k];   // the user's login, not a key
  const children = new Map();   // run → child
  const stopSession = (name) => {
    const e = readEntry(name);
    if (e && e.pid && pidAlive(e.pid) && e.state !== "ended") spawnSync(process.execPath, [cliJs, "play", "stop", "-s", name], { windowsHide: true, stdio: "ignore", timeout: 60000 });   // a starting one: stop waits up to 20 s for its port
  };
  let interrupted = false;
  const cleanup = () => { for (const [r, ch] of children) { killTree(ch.pid); stopSession(r.name); } children.clear(); };
  const onSig = () => { interrupted = true; console.error("\n✖ interrupted: stopping the testers and their sessions"); cleanup(); try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* busy */ } lock.release(); process.exit(130); };
  process.on("SIGINT", onSig); process.on("SIGTERM", onSig);

  const budget = budgetText(runs[0]);
  console.log(`▶ batch of ${runs.length} playtest${runs.length > 1 ? "s" : ""} (${parallel} at once, ${runs[0].model} at ${opt.effort || "low"} effort, ${budget} each, tester timeout ${runs[0].timeoutMin} wall min)`);
  const [claudeBin, ...claudePre] = claudeCommand();
  /** One claude process for run r with this prompt; fills r's result fields when it exits. */
  const attempt = (r, prompt) => new Promise((resolve) => {
    const t0 = Date.now();
    const ch = spawn(claudeBin, [...claudePre, ...testerArgs({ model: r.model, effort: opt.effort || "low", cliJs, name: r.name })], { cwd: work, env: { ...env, WITNESS_PLAY_SESSION: r.name }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    children.set(r, ch);
    let out = "", err = "", timedOut = false;
    ch.stdout.setEncoding("utf8"); ch.stderr.setEncoding("utf8");   // decoded across chunks (multibyte characters stay whole)
    ch.stdout.on("data", (d) => { out += d; });
    ch.stderr.on("data", (d) => { err += d; });
    ch.on("error", (e) => { err += `\n${e.message}`; });
    ch.stdin.on("error", () => { /* exited before reading */ });
    ch.stdin.end(prompt);
    const timer = setTimeout(() => { timedOut = true; killTree(ch.pid); }, r.timeoutMin * 60000);
    ch.on("close", (code) => {
      clearTimeout(timer); children.delete(r);
      stopSession(r.name);   // the tester forgot END, or was killed: the session still writes its report
      r.code = code; r.timedOut = timedOut; r.wallSec = (r.wallSec || 0) + (Date.now() - t0) / 1000; r.denials = null;   // elapsed (r.wall is the --wall-minutes cap)
      try { const j = JSON.parse(out.trim().split(/\r?\n/).filter((l) => l.startsWith("{")).pop() || "{}"); r.reply = j.result ?? null; r.cost = (r.cost || 0) + (j.total_cost_usd || 0); r.turns = j.num_turns ?? null; r.isError = !!j.is_error; r.denials = j.permission_denials || null; } catch { r.reply = out.trim().slice(-600) || null; }
      r.stderr = err.trim().slice(-800);
      Object.assign(r, attemptResult(r.name, t0));
      resolve();
    });
  });
  const runOne = async (r) => {
    console.log(`  #${r.i} ${r.name}: started — ${r.goal}`);
    await attempt(r, r.brief);
    let b = !r.timedOut && !interrupted ? blockedBy({ denials: r.denials, reply: r.reply, report: r.report }) : null;
    if (b) {
      // a permission denial stopped it before it played: say so, drop the empty session, try once more naming the allowed form
      r.firstBlock = b;
      console.log(`  #${r.i} ${r.name}: ${blockedText(b)}, 0 orders; retrying once with the exact allowed command`);
      if (r.dir && r.report && !(r.report.stats && r.report.stats.orders)) { try { fs.rmSync(r.dir, { recursive: true, force: true }); } catch { /* busy */ } }
      r.dir = null; r.report = null;
      await attempt(r, nudge(r.brief, b, r.name));
      b = !r.timedOut && !interrupted ? blockedBy({ denials: r.denials, reply: r.reply, report: r.report }) : null;
    }
    r.blocked = b;
    console.log(`  #${r.i} ${r.name}: ${batchLine(r)}`);
  };
  const queue = runs.slice();
  await Promise.all(Array.from({ length: Math.min(parallel, runs.length) }, async () => { while (queue.length && !interrupted) await runOne(queue.shift()); }));
  process.off("SIGINT", onSig); process.off("SIGTERM", onSig); clearInterval(beat);
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* busy */ }
  lock.release();

  const base = path.resolve(opt.out && opt.out !== true ? String(opt.out) : path.join(root, "witness", "playtests"));
  fs.mkdirSync(base, { recursive: true });
  // retention once, after the testers (their starts don't prune while the lock is held): this batch's own reports
  // count toward "keep" but are never removed, however big the batch
  try {
    const pr = prune(cfg, root, { only: "playtests", keep: runs.map((r) => r.dir).filter(Boolean) });
    if (pr.removed.length) console.log(`▸ removed ${pr.removed.length} older playtest${pr.removed.length === 1 ? "" : "s"} (${fmtBytes(pr.bytes)}; witness.json "retention")`);
    for (const w of pr.warnings) console.log(`⚠ ${w}`);
  } catch { /* best effort */ }
  const mdFile = path.join(base, `batch-${stamp}.md`);
  fs.writeFileSync(mdFile, batchMarkdown(runs, { base, model: runs[0].model, effort: opt.effort || "low", minutes, budget }));
  console.log(`\nSummary:`);
  for (const r of runs) console.log(`  #${r.i} ${r.goal}\n     ${batchLine(r)}${r.dir ? `\n     report: ${path.join(r.dir, "report.md")}` : ""}`);
  const cost = runs.reduce((a, r) => a + (r.cost || 0), 0);
  console.log(`\n${runs.filter((r) => r.report).length}/${runs.length} reports${cost ? ` · tester cost $${cost.toFixed(2)} (shown by claude; covered by a subscription login)` : ""} · ${mdFile}`);
}

/**
 * One attempt's session folder and report, by its name: an entry or report.json from before the attempt started (an
 * earlier batch, the blocked first attempt) under the same name isn't its result. → {dir, report}
 */
export function attemptResult(name, t0) {
  const e = readEntry(name), fresh = (ms) => ms >= t0 - 2000;
  const dir = e && e.dir && fresh(Date.parse(e.started || 0)) ? e.dir : null;
  let report = null;
  try { const f = dir && path.join(dir, "report.json"); report = f && fresh(fs.statSync(f).mtimeMs) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; } catch { /* none yet */ }
  return { dir, report };
}

/**
 * Each session's hard wall-clock cap (minutes), passed to its daemon with --wall-minutes: the given one, else one that
 * scales with the game-time budget (4 wall minutes per game minute, at least 20, the daemon's own default) so a long
 * budget (--minutes 240) isn't cut off at 20; 30 for --until / --game-hours. The tester's timeout is this + 3.
 */
export function wallCapFor({ wall = null, minutes = 3, until = null, gameHours = null } = {}) {
  if (wall != null && Number.isFinite(+wall)) return +wall;
  if (until || gameHours != null) return 30;
  return Math.max(20, Math.ceil((+minutes || 3) * 4));
}

/** "about 3 game minutes", "4h of in-game time (game clock)", "until state.hour >= 18", plus a wall cap. */
export function budgetText(r) {
  const b = r.gameHours != null ? `${fmtHours(r.gameHours)} of in-game time` : r.until ? `until ${r.until}` : `about ${r.minutes} game minutes`;
  return `${b}${r.wall != null ? ` (hard stop after ${r.wall} wall min)` : ""}`;
}

/**
 * The commands claude denied in a tester's (last) attempt. A tester that played can still lose a note or its END (a
 * backtick in the text reads as command substitution; a cd; the /c/... path form). {n, cmds, first, endDenied} or null.
 */
export function deniedInfo(r) {
  const cmds = (Array.isArray(r.denials) ? r.denials : []).filter(Boolean).map((d) => { const i = d.tool_input || {}; return String(i.command || i.file_path || d.tool_name || "?"); });
  if (!cmds.length) return null;
  const R = r.report, fed = R && R.feedback && (R.feedback.text || R.feedback.fun != null);
  const endDenied = !fed && cmds.some((c) => /(^|\s)end(\s|$)/.test(c.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, " ")));
  return { n: cmds.length, cmds, first: cmds[0], endDenied };
}
const deniedText = (d) => `${d.n} command${d.n > 1 ? "s" : ""} denied (${clip1(d.first, 80)})${d.endDenied ? " · END was denied (no feedback recorded)" : ""}`;
const spots = (R) => (R.stuckSpots && R.stuckSpots.length && R.stats.stuck > R.stuckSpots.length ? ` in ${R.stuckSpots.length} spot${R.stuckSpots.length > 1 ? "s" : ""}` : "");
export function batchLine(r) {
  const R = r.report, S = R && R.stats;
  const retried = r.firstBlock ? ` · retried after: ${blockedText(r.firstBlock)}` : "";
  if (r.blocked) return `${blockedText(r.blocked).replace(/^blocked/, "BLOCKED")} · 0 orders${r.firstBlock ? " · also blocked on the retry" : ""} · ${Math.round(r.wallSec || 0)}s wall`;
  if (!R) return `no report — ${r.timedOut ? `the tester timed out after ${r.timeoutMin} min` : `the tester exited (code ${r.code})`}${r.stderr ? `: ${r.stderr.split("\n").slice(-2).join(" ")}` : r.reply ? `: ${String(r.reply).split("\n")[0].slice(0, 160)}` : ""}${retried}`;
  return `${String(R.outcome || R.status).toUpperCase()} · ${r1(R.gameSeconds)}s game · ${S.orders} orders · kills ${S.kills} · deaths ${S.deaths} · stuck ${S.stuck}${spots(R)} · notes ${(R.notes || []).length}${R.feedback && R.feedback.fun != null ? ` · fun ${R.feedback.fun}/5` : ""}${r.timedOut ? " · tester timed out" : ""}${retried}${deniedInfo(r) ? ` · ${deniedText(deniedInfo(r))}` : ""} · ${Math.round(r.wallSec || 0)}s wall`;
}

export function batchMarkdown(runs, { base, model, effort, minutes, budget = `about ${minutes} game minutes` }) {
  const rel = (p) => path.relative(base, p).replace(/\\/g, "/");   // links relative to the batch file itself
  const L = [`# Playtest batch ${new Date().toLocaleString("sv").slice(0, 16)}`, "", `${runs.length} testers (${model}, ${effort} effort, ${budget} each), run headless with \`witness play batch\`.`, "",
    "| # | goal | persona | outcome | game s | orders | kills | deaths | stuck | notes | fun | report |", "|---|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of runs) {
    const R = r.report, S = R && R.stats;
    const g = r.goal.replace(/\|/g, "/");
    if (r.blocked) L.push(`| ${r.i} | ${g} | ${r.persona} | ${blockedText(r.blocked).replace(/\|/g, "/")} | | 0 | | | | | | |`);
    else L.push(R ? `| ${r.i} | ${g} | ${r.persona} | ${R.outcome || R.status}${r.firstBlock ? " (after a retry)" : ""} | ${r1(R.gameSeconds)} | ${S.orders} | ${S.kills} | ${S.deaths} | ${S.stuck}${spots(R)} | ${(R.notes || []).length} | ${R.feedback && R.feedback.fun != null ? R.feedback.fun : "–"} | [report](${rel(path.join(r.dir, "report.md"))}) |`
      : `| ${r.i} | ${g} | ${r.persona} | no report (${r.timedOut ? "timed out" : `exit ${r.code}`}) | | | | | | | | |`);
  }
  for (const r of runs) {
    L.push("", `## ${r.i}. ${r.goal}`, "");
    const R = r.report;
    for (const b of [r.firstBlock, r.blocked].filter(Boolean)) L.push(`**${blockedText(b)}**${b === r.firstBlock && !r.blocked ? ": retried once with the exact allowed command, which worked" : b === r.blocked ? ": the tester stopped instead of working around it (correct). Check that the brief's commands match \`claude -p --allowedTools\` (\`witness play batch --dry-run\` prints both)." : ""}`, "");
    const dn = !r.blocked && deniedInfo(r);
    if (dn) L.push(`**${deniedText(dn).replace(/ \(.*$/, "")}** (a batch has no permission prompt, so they just failed)${dn.endDenied ? ": **END was denied, so no feedback was recorded** (the batch stopped the session)" : ""}:`, "", ...dn.cmds.slice(0, 6).map((c) => `- \`${clip1(c.replace(/`/g, "'"), 160)}\``), "");
    if (R && R.feedback && R.feedback.text) L.push(`Feedback: ${R.feedback.text}`, "");
    if (R && R.notes && R.notes.length) { for (const n of R.notes.slice(0, 12)) L.push(`- ${n.kind} at ${r1(n.t)}s: ${n.text}`); L.push(""); }
    if (r.reply) L.push("Tester's reply:", "", ...String(r.reply).trim().split("\n").map((l) => `> ${l}`), "");
    if (!R && r.stderr) L.push("```", r.stderr, "```", "");
  }
  return L.join("\n") + "\n";
}
