// Witness play: the playtest report (report.json + report.md + coverage.png). What the main agent reads first:
// the outcome, the tester's own feedback, then fights, stuck incidents, deaths, coverage, dialogues and errors,
// with the exact `witness replay` command to see any marked moment again.
import path from "node:path";
import { r1, clip, oneLine } from "./util.js";

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "?");

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
    stuck: s.incidents, deaths: tr.deaths, kills: tr.kills, pickups: tr.pickups, dialogues: tr.dialogues,
    coverage: s.coverage, shots: s.shots, errors: s.errors, notes: s.notes, feedback: s.feedback || null,
    replay: s.replay, profile: s.profile,
    stats: {
      orders: s.orders.length, ordersFailed: s.orders.filter((o) => o.status === "fail").length, parseErrors: s.parseErrors || 0,
      fightsWon: fights.filter((f) => f.result === "won").length, fightsLost: fights.filter((f) => f.result === "lost").length,
      damageDealt: +fights.reduce((a, f) => a + f.dealt, 0).toFixed(2), damageTaken: +fights.reduce((a, f) => a + f.taken, 0).toFixed(2),
      kills: tr.kills.length, deaths: tr.deaths.length, pickups: tr.pickups.length, stuck: s.incidents.length, stuckUnresolved: s.incidents.filter((i) => !i.resolved).length,
      windups: tele.windups, windupsAvoided: tele.avoided, windupsHit: tele.hits,
    },
  };
}

/** report.md: readable, most useful first. `rel` makes paths relative to the project root. */
export function reportMarkdown(r, { rel = (p) => p, replayCmd = "witness replay" } = {}) {
  const L = [];
  const outcome = { won: "WON", died: "DIED", ended: "ended", crashed: "GAME CRASHED", timeout: "timed out", idle: "abandoned (idle timeout)", stopped: "stopped" }[r.outcome] || r.outcome || "in progress";
  L.push(`# Playtest ${r.session}: ${r.game?.name || "game"} — ${outcome}`);
  L.push("");
  L.push(`${r.model ? `Tester: **${r.model}** · ` : ""}${r.persona ? `persona: **${r.persona}** · ` : ""}goal: ${r.goal ? `"${r.goal}"` : "(none)"} · seed ${r.seed}${r.scene ? ` · scene ${r.scene}` : ""}${r.params ? ` · params \`${JSON.stringify(r.params)}\`` : ""}`);
  L.push(`Game time ${r1(r.gameSeconds)}s (${r.frames} frames) · wall time ${fmtWall(r.wallSeconds)} · ${r.stats.orders} orders (${r.stats.ordersFailed} failed${r.stats.parseErrors ? `, ${r.stats.parseErrors} not understood` : ""})${r.endReason ? ` · ended: ${r.endReason}` : ""}`);
  L.push("");
  L.push("## Summary");
  const S = r.stats;
  const bits = [];
  bits.push(`fights ${r.fights.length} (${S.fightsWon} won, ${S.fightsLost} lost)`);
  if (S.windups) bits.push(`enemy windups ${S.windups}: ${S.windupsAvoided} avoided, ${S.windupsHit} hit (${pct(S.windupsAvoided, S.windupsAvoided + S.windupsHit)} avoided)`);
  bits.push(`kills ${S.kills}`, `deaths ${S.deaths}`, `pickups ${S.pickups}`, `stuck incidents ${S.stuck}${S.stuckUnresolved ? ` (${S.stuckUnresolved} unresolved)` : ""}`);
  if (r.coverage) bits.push(`coverage ${r.coverage.cells} cells${r.coverage.percent != null ? ` (${r.coverage.percent}% of the open map)` : ""}`);
  if (r.errors.length) bits.push(`**${r.errors.length} game error(s)**`);
  L.push(`- ${bits.join("\n- ")}`);
  L.push("");
  // tester feedback first: it's the part nothing else can produce
  L.push("## Tester feedback");
  if (r.feedback && (r.feedback.text || r.feedback.fun != null || r.feedback.difficulty != null)) {
    const fd = r.feedback;
    if (fd.fun != null || fd.difficulty != null) L.push(`fun **${fd.fun ?? "?"}/5** · difficulty **${fd.difficulty ?? "?"}/5**`);
    if (fd.text) L.push("", `> ${oneLine(fd.text)}`);
  } else L.push("_The tester didn't leave final feedback._");
  const byKind = (k) => r.notes.filter((n) => n.kind === k);
  for (const [k, title] of [["bug", "Bugs suspected"], ["confusing", "Confusing moments"], ["idea", "Ideas"], ["fun", "Fun moments"], ["note", "Notes"]]) {
    const ns = byKind(k);
    if (!ns.length) continue;
    L.push("", `**${title}**`);
    for (const n of ns) L.push(`- [${r1(n.t)}s, cell ${n.cell ? `(${n.cell})` : "?"}] ${oneLine(n.text)}${n.shot ? ` ([shot](${rel(n.shot)}))` : ""}`);
  }
  L.push("");
  if (r.errors.length) {
    L.push("## Game errors");
    for (const e of r.errors.slice(0, 20)) L.push(`- [${r1(e.t)}s] ${clip(oneLine(e.text), 300)}`);
    L.push("");
  }
  if (r.fights.length) {
    L.push("## Fights");
    L.push("| # | against | start | length | result | dealt | taken | windups (avoided/hit) |");
    L.push("|---|---|---|---|---|---|---|---|");
    for (const f of r.fights) L.push(`| ${f.n} | ${clip(f.targets.join(", "), 50)} | ${r1(f.start)}s | ${r1(f.seconds)}s | ${f.result} | ${r1(f.dealt)} | ${r1(f.taken)} | ${f.windups ? `${f.windups} (${f.avoided}/${f.hits})` : "-"} |`);
    L.push("");
  }
  if (r.stuck.length) {
    L.push("## Stuck incidents");
    L.push("Detected automatically: the autopilot pushed toward a target and didn't move. Repeated incidents at the same cell can mean a collision bug (a snag on a corner, an invisible wall) or a confusing layout.");
    for (const s of r.stuck.slice(0, 20)) L.push(`- [${r1(s.t)}s] cell (${s.cell}) heading ${s.heading}, ${r1(s.seconds)}s, ${s.resolved ? "resolved" : "**unresolved**"}: ${s.how}${s.shot ? ` ([shot](${rel(s.shot)}))` : ""}`);
    L.push("");
  }
  if (r.deaths.length) {
    L.push("## Deaths");
    for (const d of r.deaths) L.push(`- [${r1(d.t)}s] at cell (${d.cell || "?"}), last hit by ${d.cause}`);
    L.push("");
  }
  if (r.dialogues.length) {
    L.push("## Dialogues");
    for (const d of r.dialogues.slice(0, 15)) L.push(`- [${r1(d.t)}s] ${d.speaker ? `**${d.speaker}**: ` : ""}"${clip(oneLine(d.text), 200)}"${d.options.length ? ` → ${d.options.map((o, i) => `${i + 1}) ${clip(o, 50)}`).join(" · ")}` : ""}`);
    L.push("");
  }
  if (r.coverage) {
    L.push("## Coverage");
    L.push(`${r.coverage.cells} cells visited${r.coverage.seen != null ? `, ${r.coverage.seen} seen` : ""}${r.coverage.openCells ? ` of ${r.coverage.openCells} open map cells (${r.coverage.percent}%)` : ""}; bounds x ${r.coverage.bounds?.x0}..${r.coverage.bounds?.x1}, y ${r.coverage.bounds?.y0}..${r.coverage.bounds?.y1}.${r.coverage.png ? ` Map: [coverage.png](${rel(r.coverage.png)}) (path in blue, deaths red ✕, stuck points orange).` : ""}`);
    L.push("");
  }
  if (r.shots.length) {
    L.push("## Key moments (screenshots)");
    for (const s of r.shots) L.push(`- [${r1(s.t)}s] ${s.why}: [${path.basename(s.file)}](${rel(s.file)})`);
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
    L.push(`${replayCmd} ${rel(r.replay.file)}                      # checks the end state matches`);
    const marks = r.notes.filter((n) => n.t != null).slice(0, 6);
    for (const n of marks) L.push(`${replayCmd} ${rel(r.replay.file)} --at ${n.t.toFixed(2)} --shot     # ${clip(oneLine(n.text), 50)}`);
    for (const d of r.deaths.slice(0, 2)) L.push(`${replayCmd} ${rel(r.replay.file)} --at ${Math.max(0, d.t - 1).toFixed(2)} --shot     # just before death`);
    L.push("```");
  }
  return L.join("\n") + "\n";
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
