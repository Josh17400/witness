// Witness play: the playtest report (report.json + report.md + coverage.png). What the main agent reads first:
// the outcome, the tester's own feedback, then fights, stuck incidents, deaths, coverage, dialogues and errors,
// with the exact `witness replay` command to see any marked moment again.
import fs from "node:fs";
import path from "node:path";
import { r1, clip, oneLine } from "./util.js";

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "?");

/**
 * Stuck incidents grouped into spots: incidents in the same scene (sceneKey: an interior and the overworld can share
 * cell numbers) within `radius` cells (Chebyshev) of a spot's first one join it. A long
 * run snags on the same few corners again and again (63 incidents, mostly at a few doorways); the spots, most incidents
 * first, point at those places. Each spot names one moment to replay: its first unresolved incident, else the longest.
 */
export function stuckSpots(incidents = [], radius = 2) {
  const spots = [];
  for (const s of [...incidents].filter((x) => x && x.cell).sort((a, b) => a.t - b.t)) {
    let sp = spots.find((q) => q.sceneKey === (s.sceneKey ?? null) && Math.max(Math.abs(q.anchor[0] - s.cell[0]), Math.abs(q.anchor[1] - s.cell[1])) <= radius);
    if (!sp) spots.push(sp = { anchor: s.cell, sceneKey: s.sceneKey ?? null, scene: s.scene ?? null, list: [] });
    sp.list.push(s);
  }
  return spots.map(({ list, scene, sceneKey }) => {
    const cells = new Map(), heads = new Map();
    for (const s of list) { const k = s.cell.join(","); cells.set(k, (cells.get(k) || 0) + 1); heads.set(s.heading, (heads.get(s.heading) || 0) + 1); }
    const cell = [...cells.entries()].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
    const rep = list.find((s) => !s.resolved) || [...list].sort((a, b) => b.seconds - a.seconds)[0];
    return { scene, sceneKey, cell, cells: cells.size, count: list.length, unresolved: list.filter((s) => !s.resolved).length, seconds: +list.reduce((a, s) => a + (s.seconds || 0), 0).toFixed(2),
      first: list[0].t, last: list.at(-1).t, headings: Object.fromEntries([...heads.entries()].sort((a, b) => b[1] - a[1])),
      replayAt: +(rep.t + Math.min(0.5, rep.seconds || 0)).toFixed(2), shot: (list.find((s) => s.shot) || {}).shot || null };
  }).sort((a, b) => b.count - a.count || b.seconds - a.seconds);
}

/** Assemble report.json from the daemon's state. */
export function reportData(s) {
  const tr = s.tracker;
  const fights = tr.fights;
  const tele = tr.tele;
  return {
    session: s.name, game: s.game, persona: s.persona || null, goal: s.goal || null, seed: s.seed, scene: s.scene ?? null, params: s.params ?? null,
    model: s.model || null, startedAt: s.startedAt, endedAt: s.endedAt || null, wallSeconds: s.wallSeconds, gameSeconds: +s.gameSeconds.toFixed(2), frames: s.frames, fps: s.fps,
    status: s.status || "in progress", outcome: s.outcome || null, endReason: s.endReason || null,
    orders: s.orders, timeline: s.timeline,
    fights, telegraphs: tele,
    stuck: s.incidents, stuckSpots: stuckSpots(s.incidents), until: s.until || null, deaths: tr.deaths, kills: tr.kills, pickups: tr.pickups, dialogues: tr.dialogues,
    coverage: s.coverage, shots: s.shots, errors: s.errors, notes: s.notes, feedback: s.feedback || null, stuckDead: s.stuckDead || null,
    replay: s.replay, profile: s.profile, pace: s.pace || null, lazyDraw: s.lazyDraw || null, build: s.build || null, runConfig: s.runConfig || null,
    stats: {
      orders: s.orders.length, ordersFailed: s.orders.filter((o) => o.status === "fail").length, parseErrors: s.parseErrors || 0,
      fightsWon: fights.filter((f) => f.result === "won").length, fightsLost: fights.filter((f) => f.result === "lost").length, fightsHeld: fights.filter((f) => f.result === "held").length,
      damageDealt: +fights.reduce((a, f) => a + f.dealt, 0).toFixed(2), damageTaken: +fights.reduce((a, f) => a + f.taken, 0).toFixed(2),
      kills: tr.kills.length, deaths: tr.deaths.length, pickups: tr.pickups.length, stuck: s.incidents.length, stuckUnresolved: s.incidents.filter((i) => !i.resolved).length,
      windups: tele.windups, windupsAvoided: tele.avoided, windupsHit: tele.hits,
    },
  };
}

/** The lazyDraw summary line: frames stepped without drawing, and whether the game acted on the hint. */
export function lazyLine(z) {
  if (!z.on) return "lazy drawing: configured, off (watched session: every frame is drawn)";
  const game = !z.game ? "" : z.game.reads ? `; the game checks witness.drawing (${z.game.reads}× asked)` : "; the game never read witness.drawing, so it drew every frame (adapters/js/GUIDE.md §8)";
  return `lazy drawing: on; ${z.framesUndrawn} of ${z.frames} frames hinted undrawn (${z.frames ? Math.round((100 * z.framesUndrawn) / z.frames) : 0}%) in ${z.steps} steps${game}`;
}

/** report.md: readable, most useful first. `rel` makes paths relative to the project root. */
export function reportMarkdown(r, { rel = (p) => p, link = rel, replayCmd = "witness replay", config = null, flags = "", server = null } = {}) {
  // link: paths for markdown links (relative to report.md itself); rel: paths for shell commands (relative to the project);
  // config: the config file the session ran with when it isn't the project's witness.json (witness.web.json): the
  // replay commands must load the same launch (a web build), so they carry --config
  const sh = (p) => (/[\s"'$&|;<>()]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p);
  if (config) replayCmd = `${replayCmd} --config ${sh(config)}`;
  // flags: the launch overrides the session started with (--device iphone-15-landscape --engine webkit): same viewport
  if (flags) replayCmd += flags;
  const L = [];
  const outcome = { won: "WON", died: "DIED", ended: "ended", crashed: "GAME CRASHED", timeout: "timed out", idle: "abandoned (idle timeout)", stopped: "stopped", "until reached": "UNTIL REACHED", "stuck dead": "STUCK DEAD", "not responding": "GAME NOT RESPONDING" }[r.outcome] || r.outcome || "in progress";
  L.push(`# Playtest ${r.session}: ${r.game?.name || "game"} — ${outcome}`);
  L.push("");
  L.push(`${r.model ? `Tester: **${r.model}** · ` : ""}${r.persona ? `persona: **${r.persona}** · ` : ""}goal: ${r.goal ? `"${r.goal}"` : "(none)"} · seed ${r.seed}${r.scene ? ` · scene ${r.scene}` : ""}${r.params ? ` · params \`${JSON.stringify(r.params)}\`` : ""}`);
  L.push(`Game time ${r1(r.gameSeconds)}s (${r.frames} frames) · wall time ${fmtWall(r.wallSeconds)} · ${r.stats.orders} orders (${r.stats.ordersFailed} failed${r.stats.parseErrors ? `, ${r.stats.parseErrors} not understood` : ""})${r.endReason ? ` · ended: ${r.endReason}` : ""}`);
  if (r.until && (r.until.until || r.until.gameHours != null)) {
    const u = r.until, what = [u.gameHours != null ? `${u.gameHours}h of in-game time (clock ${r1(u.clockStart)}h → ${r1(u.target)}h)` : null, u.until].filter(Boolean).join(" or ");
    L.push(`Played until: ${what} · ${u.reached ? `**reached** at ${r1(u.at.t)}s game time (${u.at.why})` : `not reached${u.clockEnd != null ? ` (clock ${r1(u.clockEnd)}h at the end)` : ""}`}${u.evalErrors ? ` · ⚠ ${u.evalErrors} evaluation errors (last: ${u.lastError})` : ""}`);
  }
  L.push("");
  L.push("## Summary");
  const S = r.stats;
  const bits = [];
  bits.push(`fights ${r.fights.length} (${S.fightsWon} won, ${S.fightsLost} lost${S.fightsHeld ? `, ${S.fightsHeld} held` : ""})${r.fights.some((f) => f.still) ? ": one per engagement (a wave, or a fight order's share of it)" : ""}`);
  if (S.windups) bits.push(`enemy windups ${S.windups}: ${S.windupsAvoided} avoided, ${S.windupsHit} hit (${pct(S.windupsAvoided, S.windupsAvoided + S.windupsHit)} avoided)`);
  bits.push(`kills ${S.kills}`, `deaths ${S.deaths}`, `pickups ${S.pickups}`, `stuck incidents ${S.stuck}${S.stuck > 1 && r.stuckSpots ? ` in ${r.stuckSpots.length} spot${r.stuckSpots.length > 1 ? "s" : ""}` : ""}${S.stuckUnresolved ? ` (${S.stuckUnresolved} unresolved)` : ""}`);
  if (r.coverage) bits.push(`coverage ${r.coverage.cells} cells${r.coverage.percent != null ? ` (${r.coverage.percent}% of ${r.coverage.mapWindow ? "the open cells the moving map window revealed" : "the open map"})` : ""}`);
  if (r.errors.length) bits.push(`**${r.errors.length} game error(s)**`);
  if (r.lazyDraw) bits.push(lazyLine(r.lazyDraw));
  if (r.pace) bits.push(`pace: ${r.pace.mode}; ${r.pace.orders} orders (${r.pace.ordersPerGameMinute} per game minute, ${r.pace.ordersStoppedEarly} stopped early); game frozen ${r.pace.freezes}× for ${r.pace.frozenWallSeconds}s of ${r.pace.wallSeconds}s wall (${Math.round(100 * r.pace.frozenShare)}%)`);
  L.push(`- ${bits.join("\n- ")}`);
  L.push("");
  // tester feedback first: it's the part nothing else can produce
  L.push("## Tester feedback");
  if (r.feedback && (r.feedback.text || r.feedback.fun != null || r.feedback.difficulty != null)) {
    const fd = r.feedback;
    if (fd.fun != null || fd.difficulty != null) L.push(`fun **${fd.fun ?? "?"}/5** · difficulty **${fd.difficulty ?? "?"}/5**`);
    if (fd.text) L.push("", `> ${oneLine(fd.text)}`);
    if (fd.late) L.push("", "_(given after the session had ended)_");
  } else L.push("_The tester didn't leave final feedback._");
  const byKind = (k) => r.notes.filter((n) => n.kind === k);
  for (const [k, title] of [["bug", "Bugs suspected"], ["confusing", "Confusing moments"], ["idea", "Ideas"], ["fun", "Fun moments"], ["note", "Notes"]]) {
    const ns = byKind(k);
    if (!ns.length) continue;
    L.push("", `**${title}**`);
    for (const n of ns) L.push(`- [${r1(n.t)}s, cell ${n.cell ? `(${n.cell})` : "?"}] ${oneLine(n.text)}${n.shot ? ` ([shot](${link(n.shot)}))` : ""}`);
  }
  L.push("");
  if (r.errors.length) {
    L.push("## Game errors");
    for (const e of r.errors.slice(0, 20)) L.push(`- [${r1(e.t)}s] ${clip(oneLine(e.text), 300)}`);
    L.push("");
  }
  if (r.fights.some((f) => f.still)) {
    // still fights (defense): one row per engagement, against everyone on the field by type; damage from every source
    L.push("## Fights");
    L.push("One row per engagement: from the first exchange with enemies on the field until the field is clear (won), the base falls (lost), the fight order ends with enemies left (held) or 15 s pass with no exchange (broke off). Dealt is every hp the enemies lost (your attacks and the defences'), at most each enemy's max hp.");
    L.push("", "| # | order | against | start | length | result | killed | dealt | taken |");
    L.push("|---|---|---|---|---|---|---|---|---|");
    for (const f of r.fights) L.push(`| ${f.n} | ${f.order ? clip(f.order, 40) : "-"} | ${clip(f.targets.join(", "), 60)} | ${r1(f.start)}s | ${r1(f.seconds)}s | ${f.result} | ${f.kills}${f.enemies ? ` of ${f.enemies}` : ""} | ${r1(f.dealt)} | ${r1(f.taken)} |`);
    L.push("");
  } else if (r.fights.length) {
    L.push("## Fights");
    L.push("| # | against | start | length | result | dealt | taken | windups (avoided/hit) |");
    L.push("|---|---|---|---|---|---|---|---|");
    for (const f of r.fights) L.push(`| ${f.n} | ${clip(f.targets.join(", "), 50)} | ${r1(f.start)}s | ${r1(f.seconds)}s | ${f.result} | ${r1(f.dealt)} | ${r1(f.taken)} | ${f.windups ? `${f.windups} (${f.avoided}/${f.hits})` : "-"} |`);
    L.push("");
  }
  const spots = r.stuckSpots || stuckSpots(r.stuck || []);
  // the scene is named when the spots are in more than one (an interior's (3,4) isn't the overworld's (3,4))
  const where = new Set(spots.map((s) => s.sceneKey ?? null)).size > 1 ? (sp) => `${sp.scene ?? (sp.sceneKey ? clip(sp.sceneKey, 30) : "?")} ` : () => "";
  const replayFile = r.replay && r.replay.file ? sh(rel(r.replay.file)) : "replay.jsonl";
  if (r.stuck.length) {
    L.push("## Stuck incidents");
    L.push(`Detected automatically: the autopilot pushed toward a target and didn't move. ${r.stuck.length} incident${r.stuck.length > 1 ? "s" : ""} in **${spots.length} spot${spots.length > 1 ? "s" : ""}** (incidents within 2 cells of each other, in the same scene), most first. A spot with many incidents is a real problem place: a collision bug (a snag on a corner, an invisible wall) or a confusing layout.`);
    L.push("", "| spot (cell) | incidents | unresolved | stuck for | between | heading | see it |", "|---|---|---|---|---|---|---|");
    for (const sp of spots.slice(0, 12)) {
      const heads = Object.entries(sp.headings).map(([h, n]) => (n > 1 ? `${h}×${n}` : h)).join(" ");
      L.push(`| ${where(sp)}(${sp.cell})${sp.cells > 1 ? ` +${sp.cells - 1} near` : ""} | ${sp.count} | ${sp.unresolved || "–"} | ${r1(sp.seconds)}s | ${r1(sp.first)}s${sp.count > 1 ? `–${r1(sp.last)}s` : ""} | ${heads} | \`${replayCmd} ${replayFile} --at ${sp.replayAt.toFixed(2)} --shot\`${sp.shot ? ` · [shot](${link(sp.shot)})` : ""} |`);
    }
    if (spots.length > 12) L.push("", `… ${spots.length - 12} more spots with fewer incidents in report.json (stuckSpots).`);
    if (r.stuck.length <= 10) { L.push(""); for (const s of r.stuck) L.push(`- [${r1(s.t)}s] cell (${s.cell}) heading ${s.heading}, ${r1(s.seconds)}s, ${s.resolved ? "resolved" : "**unresolved**"}: ${s.how}${s.shot ? ` ([shot](${link(s.shot)}))` : ""}`); }
    else L.push("", "Every incident (time, cell, heading, how it ended) is in report.json: stuck[].");
    L.push("");
  }
  if (r.deaths.length) {
    L.push("## Deaths");
    // cause: "killed by Bomber bomb" (state.lastHit), "last hit by Wolf#3" (the nearest attacker), or the game's log line
    for (const d of r.deaths) L.push(`- [${r1(d.t)}s]${d.cell && r.profile !== "defense" ? ` at cell (${d.cell})` : ""}: ${/^(killed by|last hit by|cause unknown)/.test(d.cause) ? d.cause : !d.cause || d.cause === "unknown" ? "cause unknown" : `game says "${d.cause}"`}`);
    L.push("");
  }
  if (r.stuckDead) {
    const sd = r.stuckDead;
    L.push("## Stuck dead");
    L.push(`Dead from ${r1(sd.since)}s to ${r1(sd.at)}s of game time: ${sd.attempts} respawn attempt${sd.attempts === 1 ? "" : "s"} and nothing in the state changed, so the session ended. Last inputs: ${sd.lastInputs.map((x) => `${x.input} at ${r1(x.t)}s`).join(", ") || "none"}.${sd.shot ? ` [shot](${link(sd.shot)})` : ""} Does the game respawn on its own, or with a key the play config doesn't name (play.controls.confirm)?`);
    L.push("", "```json", JSON.stringify(sd.state, null, 1).slice(0, 2500), "```", "");
  }
  if (r.dialogues.length) {
    L.push("## Dialogues");
    for (const d of r.dialogues.slice(0, 15)) L.push(`- [${r1(d.t)}s] ${d.speaker ? `**${d.speaker}**: ` : ""}"${clip(oneLine(d.text), 200)}"${d.options.length ? ` → ${d.options.map((o, i) => `${i + 1}) ${clip(o, 50)}`).join(" · ")}` : ""}`);
    L.push("");
  }
  if (r.coverage) {
    L.push("## Coverage");
    L.push(`${r.coverage.cells} cells visited${r.coverage.seen != null ? `, ${r.coverage.seen} seen` : ""}${r.coverage.openCells ? (r.coverage.mapWindow ? ` of ${r.coverage.openCells} open cells revealed so far (${r.coverage.percent}%; the game's map is a window that follows the player, so this grows as you walk and the full map size is unknown)` : ` of ${r.coverage.openCells} open map cells (${r.coverage.percent}%)`) : ""}; bounds x ${r.coverage.bounds?.x0}..${r.coverage.bounds?.x1}, y ${r.coverage.bounds?.y0}..${r.coverage.bounds?.y1}.${r.coverage.png ? ` Map: [coverage.png](${link(r.coverage.png)}) (path in blue, deaths red ✕, stuck points orange).` : ""}`);
    L.push("");
  }
  if (r.shots.length) {
    L.push("## Key moments (screenshots)");
    for (const s of r.shots) L.push(`- [${r1(s.t)}s] ${s.why}: [${path.basename(s.file)}](${link(s.file)})`);
    L.push("");
  }
  L.push("## Orders");
  for (const o of r.orders.slice(0, 120)) L.push(`- [${r1(o.t)}s] \`${clip(o.text, 80)}\` → ${o.status}${o.msg ? `: ${clip(oneLine(o.msg), 160)}` : ""}${o.seconds != null ? ` (${r1(o.seconds)}s)` : ""}`);
  if (r.orders.length > 120) L.push(`- … ${r.orders.length - 120} more in report.json`);
  L.push("");
  L.push("## Timeline (notable)");
  const keep = new Set(["death", "goal", "kill", "dialogue", "pickup", "alert", "stuck", "error", "warn", "scene", "notice", "goalchange", "respawn", "note", "reflex", "lowhp"]);
  const tl = r.timeline.filter((e) => keep.has(e.kind));
  for (const e of tl.slice(0, 150)) L.push(`- ${r1(e.t)}s ${e.kind}: ${clip(oneLine(e.text), 200)}`);
  if (tl.length > 150) L.push(`- … ${tl.length - 150} more in report.json`);
  L.push("");
  L.push("## Reproduce");
  if (r.replay && r.replay.file) {
    L.push(`The whole session is a standard Witness replay (${r.replay.frames} frames)${r.replay.calls ? `, including ${r.replay.calls} game call(s)` : ""}. Every frame replays exactly:`);
    L.push("```");
    L.push(`${replayCmd} ${sh(rel(r.replay.file))}                      # checks the end state matches`);
    const marks = r.notes.filter((n) => n.t != null).slice(0, 6);
    for (const n of marks) L.push(`${replayCmd} ${sh(rel(r.replay.file))} --at ${n.t.toFixed(2)} --shot     # ${clip(oneLine(n.text), 50)}`);
    for (const sp of spots.slice(0, 3)) L.push(`${replayCmd} ${sh(rel(r.replay.file))} --at ${sp.replayAt.toFixed(2)} --shot     # stuck spot ${where(sp)}(${sp.cell}): ${sp.count} incident${sp.count > 1 ? "s" : ""}`);
    for (const d of r.deaths.slice(0, 2)) L.push(`${replayCmd} ${sh(rel(r.replay.file))} --at ${Math.max(0, d.t - 1).toFixed(2)} --shot     # just before death`);
    L.push("```");
    // the run config in this folder carries the launch (and its server) whole; the fingerprint says what build was played
    if (r.runConfig) L.push(`The commands load this playtest's own config (${sh(rel(r.runConfig))}: the session's launch with absolute paths${server === true ? ", and launch.server, so the replay starts the server again" : ""}).`);
    if (server === false && r.build && r.build.url && /^https?:\/\/(localhost|127\.|\[::1\])/i.test(r.build.url)) L.push(`⚠ ${r.build.url} was served by something Witness didn't start (no launch.server): start that server before replaying.`);
    if (r.build) L.push(`Build played: ${r.build.kind === "web" ? `${r.build.url} and ${r.build.count - 1} file${r.build.count === 2 ? "" : "s"} it loads` : `${r.build.count} launched file${r.build.count === 1 ? "" : "s"}`}, fingerprint \`${r.build.hash}\` (in the replay header: \`witness replay\` warns when the build changed since).`);
  }
  return L.join("\n") + "\n";
}

/** report.md's options from the session's own session.json (root, a non-default config file, launch flags). */
function mdOptions(dir) {
  let spec = {};
  try { spec = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8")); } catch { /* defaults */ }
  const root = spec.root || dir;
  const rel = (p) => path.relative(root, p).replace(/\\/g, "/");
  // a playtest's own witness.run.json (0.7.8) beats the config file it started from (a batch's per-run config can be gone)
  const own = spec.runConfig && fs.existsSync(spec.runConfig) ? spec.runConfig : null;
  return { rel, link: (p) => path.relative(dir, p).replace(/\\/g, "/"), replayCmd: "witness replay", config: own ? rel(own) : spec.configFile ? rel(spec.configFile) : null, flags: spec.launchFlags || "",
    server: spec.cfg && spec.cfg.launch && spec.cfg.launch.url ? !!spec.cfg.launch.server : null };
}
/** Write report.json and report.md into a session folder. */
export function writeReports(dir, r) {
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(r, null, 1));
  fs.writeFileSync(path.join(dir, "report.md"), reportMarkdown(r, mdOptions(dir)));
}
/**
 * END after the session had already ended (the wall cap, stuck dead, the game exiting): the tester's feedback still
 * goes into report.json and report.md. Returns the updated report, or null when there's no finished report.
 */
export function addLateFeedback(dir, fb) {
  let r;
  try { r = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")); } catch { return null; }
  if (!fb || (fb.text == null && fb.fun == null && fb.difficulty == null)) return r;
  r.feedback = { fun: fb.fun ?? null, difficulty: fb.difficulty ?? null, text: fb.text ?? null, late: true };
  writeReports(dir, r);
  return r;
}

function fmtWall(s) { if (s == null) return "?"; const m = Math.floor(s / 60); return m ? `${m}m${String(Math.round(s % 60)).padStart(2, "0")}s` : `${Math.round(s)}s`; }

/** coverage.png: the known map (walls), visited cells, the path, deaths and stuck points. */
export async function coveragePNG(grid, { path: trail = [], deaths = [], stuck = [], scale: sc = 6 } = {}) {
  const { encodePNG } = await import("../media/png.js");
  const cells = [...grid.visited, ...grid.mapSolid.keys(), ...grid.learned.keys()].map((k) => k.split(",").map(Number));
  if (!cells.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of cells) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  const W = Math.min(400, x1 - x0 + 3), H = Math.min(400, y1 - y0 + 3);
  x0 -= 1; y0 -= 1;
  const w = W * sc, h = H * sc, px = new Uint8Array(w * h * 4);
  const fill = (cx, cy, [r, g, b], inset = 0) => {
    const X = (cx - x0) * sc, Y = (cy - y0) * sc;
    if (X < 0 || Y < 0 || X >= w || Y >= h) return;
    for (let y = Y + inset; y < Y + sc - inset; y++) for (let x = X + inset; x < X + sc - inset; x++) { const i = (y * w + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; }
  };
  for (let i = 0; i < w * h; i++) { px[i * 4] = 24; px[i * 4 + 1] = 26; px[i * 4 + 2] = 32; px[i * 4 + 3] = 255; }
  for (const [k, solid] of grid.mapSolid) { const [x, y] = k.split(",").map(Number); fill(x, y, solid ? [90, 90, 100] : [44, 48, 58]); }
  for (const k of grid.seen) { const [x, y] = k.split(",").map(Number); if (grid.mapSolid.get(k) !== true) fill(x, y, [52, 64, 70]); }
  for (const k of grid.learned.keys()) { const [x, y] = k.split(",").map(Number); fill(x, y, [150, 120, 90]); }
  for (const k of grid.visited) { const [x, y] = k.split(",").map(Number); fill(x, y, [60, 110, 170]); }
  for (const [x, y] of trail) fill(x, y, [120, 190, 255], Math.floor(sc / 3));
  for (const s of stuck) if (s.cell) fill(s.cell[0], s.cell[1], [255, 160, 40], 1);
  for (const d of deaths) if (d.cell) { const [cx, cy] = d.cell; const X = (cx - x0) * sc, Y = (cy - y0) * sc; for (let i = 0; i < sc; i++) for (const [x, y] of [[X + i, Y + i], [X + sc - 1 - i, Y + i]]) { if (x >= 0 && y >= 0 && x < w && y < h) { const j = (y * w + x) * 4; px[j] = 255; px[j + 1] = 50; px[j + 2] = 50; } } }
  return encodePNG(w, h, px);
}
