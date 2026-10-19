// Witness play: `witness play batch` runs tester agents itself, as headless Claude Code processes (`claude -p`), one
// per goal, at most 2 at once. For agents that can't spawn subagents (workflow subagents have no Agent tool): the
// batch is a plain command. Each tester gets the same brief `play brief` prints, may run only the witness commands
// (Bash limited to them, plus Read for screenshots, permission mode dontAsk), and uses the user's Claude Code login
// (ANTHROPIC_API_KEY is removed from its environment). Nothing is left running: a wall-clock timeout per tester, the
// session stopped after each tester, and Ctrl-C kills every tester and its session.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { makeBrief, PERSONAS } from "./brief.js";
import { resolvePlayConfig, describeControls } from "./config.js";
import { readEntry, pidAlive } from "./registry.js";

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

/** The `claude -p` arguments for one tester: the model, low effort, Bash limited to the witness commands, no prompts. */
export function testerArgs({ model = "sonnet", effort = "low", cliJs, name }) {
  const wit = `node "${cliJs}" play`;
  const allow = [`Bash(${wit}:*)`, `Bash(${wit} *)`, "Bash(cd:*)", "Bash(cd *)", `Bash(./${name}:*)`, `Bash(./${name} *)`, `Bash(./${name})`, "Read"];
  return ["-p", "--model", model, "--effort", effort, "--tools", "Bash,Read", "--allowedTools", ...allow, "--permission-mode", "dontAsk",
    "--setting-sources", "project,local", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--output-format", "json"];
}

function killTree(pid) {
  if (!pid || !pidAlive(pid)) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } }
}

/** `witness play batch --goals FILE [--persona P] [--model sonnet] [--effort low] [--parallel 2] [--minutes 3] [--timeout M] [--scene S] [--params J] [--live]` */
export async function playBatch(opt, { loadConfig, ROOT }) {
  const { cfg, root } = loadConfig(opt);
  if (!opt.goals || opt.goals === true) { console.error("✖ --goals FILE is required (one goal per line, or a JSON list of {goal, persona, scene, params, minutes})"); process.exit(1); }
  let goals;
  try { goals = readGoals(path.resolve(String(opt.goals))); } catch (e) { console.error(`✖ can't read --goals: ${e.message}`); process.exit(1); }
  if (!goals.length) { console.error("✖ no goals in the file"); process.exit(1); }
  const cliJs = path.join(ROOT, "bin", "witness.js").replace(/\\/g, "/");
  const cli = `node "${cliJs}"`;
  const parallel = Math.max(1, Math.min(2, +(opt.parallel || 2)));
  const minutes = opt.minutes ? +opt.minutes : 3;
  const d0 = new Date(), p2 = (n) => String(n).padStart(2, "0");
  const stamp = `${p2(d0.getMonth() + 1)}${p2(d0.getDate())}${p2(d0.getHours())}${p2(d0.getMinutes())}`;   // MMDDhhmm, local time
  const pc = resolvePlayConfig(cfg.play || {}, {});
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "witness-batch-"));   // the testers' working folder (empty)
  const env = { ...process.env };
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"]) delete env[k];   // the user's login, not a key
  const runs = goals.map((g, i) => {
    const name = String(g.name || `${opt.prefix && opt.prefix !== true ? opt.prefix : "b"}${stamp}-${i + 1}`).slice(0, 40);
    const persona = PERSONAS[g.persona] ? g.persona : PERSONAS[opt.persona] ? opt.persona : "newbie";
    const mins = +(g.minutes ?? minutes);
    const brief = makeBrief({
      cli, configDir: root.replace(/\\/g, "/"), name, goal: g.goal, persona, minutes: mins, game: `"${cfg.name || "the game"}"`, profile: pc.profile,
      controls: cfg.play && cfg.play.controls ? describeControls(pc) : "", seed: g.seed ?? (opt.seed !== undefined && opt.seed !== true ? +opt.seed : null),
      scene: g.scene ?? (opt.scene && opt.scene !== true ? String(opt.scene) : null), params: g.params ?? (opt.params && opt.params !== true ? String(opt.params) : null),
      model: g.model || (opt.model && opt.model !== true ? String(opt.model) : "sonnet"), live: !!(g.live ?? opt.live), extra: (cfg.play && cfg.play.brief) || null,
    });
    return { i: i + 1, name, goal: g.goal, persona, minutes: mins, model: g.model || (opt.model && opt.model !== true ? String(opt.model) : "sonnet"), brief, timeoutMin: +(opt.timeout || Math.max(5, mins * 4 + 3)) };
  });
  if (opt["dry-run"]) { for (const r of runs) console.log(`#${r.i} ${r.name}: claude ${testerArgs({ model: r.model, effort: opt.effort || "low", cliJs, name: r.name }).join(" ")}  (brief: ${r.brief.length} chars)`); fs.rmSync(work, { recursive: true, force: true }); return; }

  const children = new Map();   // run → child
  const stopSession = (name) => {
    const e = readEntry(name);
    if (e && e.pid && pidAlive(e.pid) && e.state !== "ended") spawnSync(process.execPath, [cliJs, "play", "stop", "-s", name], { windowsHide: true, stdio: "ignore", timeout: 30000 });
  };
  let interrupted = false;
  const cleanup = () => { for (const [r, ch] of children) { killTree(ch.pid); stopSession(r.name); } children.clear(); };
  const onSig = () => { interrupted = true; console.error("\n✖ interrupted: stopping the testers and their sessions"); cleanup(); try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* busy */ } process.exit(130); };
  process.on("SIGINT", onSig); process.on("SIGTERM", onSig);

  console.log(`▶ batch of ${runs.length} playtest${runs.length > 1 ? "s" : ""} (${parallel} at once, ${runs[0].model} at ${opt.effort || "low"} effort, about ${minutes} game minutes each, timeout ${runs[0].timeoutMin} min per tester)`);
  const runOne = (r) => new Promise((resolve) => {
    const t0 = Date.now();
    const ch = spawn("claude", testerArgs({ model: r.model, effort: opt.effort || "low", cliJs, name: r.name }), { cwd: work, env: { ...env, WITNESS_PLAY_SESSION: r.name }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    children.set(r, ch);
    let out = "", err = "", timedOut = false;
    ch.stdout.on("data", (d) => { out += d; });
    ch.stderr.on("data", (d) => { err += d; });
    ch.on("error", (e) => { err += `\n${e.message}`; });
    ch.stdin.end(r.brief);
    const timer = setTimeout(() => { timedOut = true; killTree(ch.pid); }, r.timeoutMin * 60000);
    console.log(`  #${r.i} ${r.name}: started — ${r.goal}`);
    ch.on("close", (code) => {
      clearTimeout(timer); children.delete(r);
      stopSession(r.name);   // the tester forgot END, or was killed: the session still writes its report
      r.code = code; r.timedOut = timedOut; r.wall = (Date.now() - t0) / 1000;
      try { const j = JSON.parse(out.trim().split(/\r?\n/).filter((l) => l.startsWith("{")).pop() || "{}"); r.reply = j.result ?? null; r.cost = j.total_cost_usd ?? null; r.turns = j.num_turns ?? null; r.isError = !!j.is_error; } catch { r.reply = out.trim().slice(-600) || null; }
      r.stderr = err.trim().slice(-800);
      const e = readEntry(r.name);
      r.dir = e && e.dir ? e.dir : null;
      try { r.report = r.dir ? JSON.parse(fs.readFileSync(path.join(r.dir, "report.json"), "utf8")) : null; } catch { r.report = null; }
      console.log(`  #${r.i} ${r.name}: ${line(r)}`);
      resolve();
    });
  });
  const queue = runs.slice();
  await Promise.all(Array.from({ length: Math.min(parallel, runs.length) }, async () => { while (queue.length && !interrupted) await runOne(queue.shift()); }));
  process.off("SIGINT", onSig); process.off("SIGTERM", onSig);
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* busy */ }

  const base = path.resolve(opt.out && opt.out !== true ? String(opt.out) : path.join(root, "witness", "playtests"));
  fs.mkdirSync(base, { recursive: true });
  const mdFile = path.join(base, `batch-${stamp}.md`);
  fs.writeFileSync(mdFile, batchMarkdown(runs, { base, model: runs[0].model, effort: opt.effort || "low", minutes }));
  console.log(`\nSummary:`);
  for (const r of runs) console.log(`  #${r.i} ${r.goal}\n     ${line(r)}${r.dir ? `\n     report: ${path.join(r.dir, "report.md")}` : ""}`);
  const cost = runs.reduce((a, r) => a + (r.cost || 0), 0);
  console.log(`\n${runs.filter((r) => r.report).length}/${runs.length} reports${cost ? ` · tester cost $${cost.toFixed(2)} (shown by claude; covered by a subscription login)` : ""} · ${mdFile}`);
}

function line(r) {
  const R = r.report, S = R && R.stats;
  if (!R) return `no report — ${r.timedOut ? `the tester timed out after ${r.timeoutMin} min` : `the tester exited (code ${r.code})`}${r.stderr ? `: ${r.stderr.split("\n").slice(-2).join(" ")}` : r.reply ? `: ${String(r.reply).split("\n")[0].slice(0, 160)}` : ""}`;
  return `${String(R.outcome || R.status).toUpperCase()} · ${r1(R.gameSeconds)}s game · ${S.orders} orders · kills ${S.kills} · deaths ${S.deaths} · stuck ${S.stuck} · notes ${(R.notes || []).length}${R.feedback && R.feedback.fun != null ? ` · fun ${R.feedback.fun}/5` : ""}${r.timedOut ? " · tester timed out" : ""} · ${Math.round(r.wall)}s wall`;
}

export function batchMarkdown(runs, { base, model, effort, minutes }) {
  const rel = (p) => path.relative(base, p).replace(/\\/g, "/");   // links relative to the batch file itself
  const L = [`# Playtest batch ${new Date().toLocaleString("sv").slice(0, 16)}`, "", `${runs.length} testers (${model}, ${effort} effort, about ${minutes} game minutes each), run headless with \`witness play batch\`.`, "",
    "| # | goal | persona | outcome | game s | orders | kills | deaths | stuck | notes | fun | report |", "|---|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of runs) {
    const R = r.report, S = R && R.stats;
    L.push(R ? `| ${r.i} | ${r.goal.replace(/\|/g, "/")} | ${r.persona} | ${R.outcome || R.status} | ${r1(R.gameSeconds)} | ${S.orders} | ${S.kills} | ${S.deaths} | ${S.stuck} | ${(R.notes || []).length} | ${R.feedback && R.feedback.fun != null ? R.feedback.fun : "–"} | [report](${rel(path.join(r.dir, "report.md"))}) |`
      : `| ${r.i} | ${r.goal.replace(/\|/g, "/")} | ${r.persona} | no report (${r.timedOut ? "timed out" : `exit ${r.code}`}) | | | | | | | | |`);
  }
  for (const r of runs) {
    L.push("", `## ${r.i}. ${r.goal}`, "");
    const R = r.report;
    if (R && R.feedback && R.feedback.text) L.push(`Feedback: ${R.feedback.text}`, "");
    if (R && R.notes && R.notes.length) { for (const n of R.notes.slice(0, 12)) L.push(`- ${n.kind} at ${r1(n.t)}s: ${n.text}`); L.push(""); }
    if (r.reply) L.push("Tester's reply:", "", ...String(r.reply).trim().split("\n").map((l) => `> ${l}`), "");
    if (!R && r.stderr) L.push("```", r.stderr, "```", "");
  }
  return L.join("\n") + "\n";
}
