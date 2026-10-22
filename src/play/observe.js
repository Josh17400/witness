// Witness play: the compact observation a cheap model reads every turn (and its JSON form). Positions/distances are in
// map cells, directions are compass (north = up on screen), things are named exactly as orders accept them.
import { r1, clip, oneLine, fmtT, compass, len } from "./util.js";
import { thingLabel } from "./perceive.js";
import { lookOf } from "./profiles.js";
import { describeControls } from "./config.js";
import { ORDER_CARD, ORDER_CARD_PLATFORMER, ORDER_CARD_FPS, ORDER_CARD_TURN, ORDER_CARD_DEFENSE } from "./orders.js";
import { screenOf } from "./autopilot.js";
import { cellOf } from "./events.js";

const IDLE = /^(idle|none|normal|walk|walking|stand|standing|wander|patrol|default)$/i;

function thingDetails(th, w, cfg) {
  const bits = [];
  if (th.hp != null && th.rel !== "item") bits.push(`hp ${r1(th.hp)}${th.maxHp ? `/${r1(th.maxHp)}` : ""}`);
  if (th.telegraph) bits.push(`WINDUP${th.tele != null ? ` ${r1(th.tele)}s` : ""}`);
  else if (th.state && !IDLE.test(th.state)) bits.push(th.state === "chase" ? "chasing you" : th.state);
  if (th.rel === "item") bits.push("item");
  else if (th.rel === "npc") bits.push("npc");
  else if (th.rel === "friend") bits.push("teammate");
  else if (th.rel === "hostile") bits.push("enemy");
  if (th.locked === true) bits.push("locked");
  if (th.locked === false) bits.push("open");
  if (cfg.profile === "fps" && th.rel === "hostile") bits.push(th.los === false ? "no line of sight" : th.los === true ? "in sight" : "");
  // fps: distances are flat (map cells), so say when something is a floor up or down
  if (cfg.profile === "fps" && th.pos && th.pos.length >= 3 && w.player && w.player.pos && w.player.pos.length >= 3) {
    const up = 3 - cfg.plane[0] - cfg.plane[1], dz = th.pos[up] - w.player.pos[up];
    if (Math.abs(dz) > (cfg.fps.floorHeight ?? 2.2)) bits.push(`${r1(Math.abs(dz))} m ${dz > 0 ? "above" : "below"} you`);
  }
  if (th.name && !/^\d+$/.test(th.name) && th.name.toLowerCase() !== th.type.toLowerCase()) bits.push(`"${clip(th.name, 24)}"`);
  if (cfg.profile === "platformer" && th.p2 && w.player) {
    const dy = (th.p2[1] - w.player.p2[1]) / w.cell;
    if (Math.abs(dy) >= 1) bits.push(dy < 0 ? `${r1(-dy)} up` : `${r1(dy)} down`);
  }
  return bits.filter(Boolean).join("  ");
}

/** One letter per type in the map window (uppercase = hostile), unique within the observation. */
function letterTable(things) {
  const used = new Set(["#", ".", "?", "@", "^", "="]), table = new Map();
  for (const th of things) {
    const key = `${th.type}|${th.rel === "hostile"}`;
    if (table.has(key)) continue;
    const up = th.rel === "hostile";
    const cands = [...th.type.replace(/[^A-Za-z]/g, ""), ..."abcdefghijklmnopqrstuvwxyz"].map((ch) => (up ? ch.toUpperCase() : ch.toLowerCase()));
    const ch = cands.find((c) => !used.has(c)) || "*";
    used.add(ch); table.set(key, ch);
  }
  return table;
}

/** Build the observation data (also what --json prints). */
export function observeData(w, ctx) {
  const { cfg, grid, ap } = ctx;
  if (cfg.profile === "turn") return turnData(w, ctx);
  if (cfg.profile === "defense") return defenseData(w, ctx);
  const P = w.player;
  const data = { t: +w.t.toFixed(2), frame: w.frame, player: null, stats: {}, near: [], farther: {}, remembered: [], dialogue: w.dialogue, goal: w.goal ? w.goal.text : null, notice: w.notice, dead: w.dead, won: w.won, result: ctx.result || null, events: (ctx.events || []).map((e) => ({ t: +e.t.toFixed(2), kind: e.kind, text: e.text })), map: null };
  if (P && P.p2) {
    const c = cellOf(w, P.p2);
    const look = cfg.profile === "fps" ? lookOf(w, cfg) : null;
    data.player = { cell: c, pos: P.pos ? P.pos.map((x) => +(+x).toFixed(2)) : null, hp: P.hp, maxHp: P.maxHp,
      facing: look ? compass(look.dir, w.northSign) : P.facing || ap?.facingGuess || null, pitch: look ? Math.round((look.pitch * 180) / Math.PI) : null,
      onGround: P.onGround, ammo: P.ammo, weapon: P.weapon };
  }
  for (const s of w.stats) data.stats[s.label] = s.value;
  const range = Math.max(cfg.alert * 2.5, 12);
  const near = w.things.filter((th) => !th.dead && th.dist <= range);
  near.sort((a, b) => (a.rel === "hostile" && a.dist <= cfg.alert ? 0 : 1) - (b.rel === "hostile" && b.dist <= cfg.alert ? 0 : 1) || a.dist - b.dist);
  for (const th of near.slice(0, 8)) data.near.push({ key: th.key, name: th.name, type: th.type, rel: th.rel, dist: +th.dist.toFixed(1), dir: th.dir, cell: cellOf(w, th.p2), details: thingDetails(th, w, cfg) });
  for (const th of near.slice(8).concat(w.things.filter((x) => !x.dead && x.dist > range))) data.farther[th.type] = (data.farther[th.type] || 0) + 1;
  for (const th of (w.remembered || []).filter((x) => x.rel !== "item" || x.dist < 30).sort((a, b) => a.dist - b.dist).slice(0, 4)) data.remembered.push({ key: th.key, dist: +th.dist.toFixed(1), dir: th.dir, ago: +(w.t - th.lastSeen).toFixed(1) });
  // map window
  if (P && P.p2 && grid && (w.map || grid.learned.size || cfg.profile !== "fps")) {
    const marks = new Map(), letters = letterTable(w.things.filter((th) => !th.dead));
    const letterFor = (th) => letters.get(`${th.type}|${th.rel === "hostile"}`) || "*";
    for (const th of w.things) { if (th.dead) continue; const c = cellOf(w, th.p2); const k = `${c[0]},${c[1]}`; if (!marks.has(k) || th.rel === "hostile") marks.set(k, letterFor(th)); }
    let rows, x0, y0;
    if (cfg.profile === "platformer" && w.map) ({ rows, x0, y0 } = platformWindow(w, marks));
    else ({ rows, x0, y0 } = grid.render(cellOf(w, P.p2), cfg.profile === "fps" ? 17 : 19, cfg.profile === "fps" ? 11 : 9, marks, w.t));
    const inWin = new Map(); for (const th of w.things) { if (th.dead) continue; const c = cellOf(w, th.p2); if (c[0] >= x0 && c[1] >= y0 && c[0] < x0 + (rows[0] || "").length && c[1] < y0 + rows.length) inWin.set(`${th.type}|${th.rel === "hostile"}`, th); }
    const twoSides = (ty) => [...letters.keys()].filter((k) => k.startsWith(`${ty}|`)).length > 1;
    const legend = [...inWin.entries()].map(([k, th]) => `${letters.get(k)}=${th.type}${twoSides(th.type) ? (th.rel === "hostile" ? " (enemy)" : " (ally)") : ""}`).slice(0, 10);
    // only worth showing when walls are known (the game's map, or walls learned by bumping into them)
    if (w.map || /[#^]/.test(rows.join(""))) data.map = { rows, x0, y0, legend };
  }
  return data;
}

function platformWindow(w, marks) {
  const m = w.map, P = w.player;
  const pc = cellOf(w, P.p2);
  const mc0 = Math.floor((m.origin[0] - (w.origin?.[0] || 0)) / w.cell), mr0 = Math.floor((m.origin[1] - (w.origin?.[1] || 0)) / w.cell);
  const x0 = pc[0] - 6, x1 = pc[0] + 17, rows = [];
  for (let r = 0; r < m.rows.length; r++) {
    let row = "";
    for (let x = x0; x <= x1; x++) {
      const k = `${x},${mr0 + r}`;
      if (x === pc[0] && mr0 + r === pc[1]) { row += "@"; continue; }
      if (marks.has(k)) { row += marks.get(k); continue; }
      const ch = m.rows[r][x - mc0];
      row += ch == null ? " " : ch;
    }
    rows.push(row);
  }
  return { rows, x0, y0: mr0 };
}

/** The text a tester reads. */
export function observeText(w, ctx) {
  if (ctx.cfg.profile === "turn") return turnText(w, ctx);
  if (ctx.cfg.profile === "defense") return defenseText(w, ctx);
  const d = observeData(w, ctx), cfg = ctx.cfg, L = [];
  const head = [`[t ${fmtT(w.t)}${ctx.live ? ` · ${ctx.live}` : ""}]`];
  if (d.player) {
    if (d.player.hp != null) head.push(`hp ${r1(d.player.hp)}${d.player.maxHp ? `/${r1(d.player.maxHp)}` : ""}`);
    for (const [k, v] of Object.entries(d.stats)) head.push(`${k} ${typeof v === "number" ? r1(v) : typeof v === "boolean" ? (v ? "yes" : "no") : clip(String(v), k === "score" ? 40 : 20)}`);
    if (d.player.ammo != null && !("ammo" in d.stats)) head.push(`ammo ${d.player.ammo}`);
    const where = [`cell (${d.player.cell[0]},${d.player.cell[1]})`];
    if (d.player.facing) where.push(`facing ${d.player.facing}`);
    if (d.player.pitch != null) where.push(`pitch ${d.player.pitch}°`);
    if (cfg.profile === "platformer" && d.player.onGround != null) where.push(d.player.onGround ? "on ground" : "in the air");
    L.push(`${head.join(" · ")} · ${where.join(" ")}`);
  } else L.push(`${head.join(" ")} · no player right now${w.scene ? ` (scene: ${w.scene})` : ""}: a title screen, intro or menu? (if this lasts into gameplay, check play.player in witness.json)`);
  if (ctx.clock) L.push(ctx.clock);
  if (ctx.first && ctx.session && ctx.session.goal) L.push(`your goal: ${ctx.session.goal}`);
  if (d.goal) L.push(`goal: ${clip(oneLine(d.goal), 140)}`);
  if (d.result) L.push(d.result.line);
  if (ctx.live && ctx.order && !(d.result && /^(✔|✖)/.test(d.result.line || ""))) L.push(`your order (still running): ${ctx.order}`);
  else if (ctx.live && !ctx.order) L.push("no order running: standing by (holding, guarding, shooting back) while the game plays on");
  if (w.dead) L.push(`YOU ARE DEAD${w.notice ? ` — game says: "${clip(oneLine(w.notice), 100)}"` : ""}${cfg.controls.confirm ? ` (to continue: "respawn", or press the key the game names)` : ""}`);
  else if (w.won) L.push("★ GOAL REACHED (the game reports a win) — keep exploring or end the session");
  if (d.near.length) {
    L.push("near (dist in cells, compass dir):");
    const kw = Math.min(16, Math.max(...d.near.map((n) => n.key.length)));
    for (const n of d.near) L.push(`  ${n.key.padEnd(kw)}  ${n.dist.toFixed(1).padStart(5)} ${n.dir.padEnd(2)}  ${n.details}`);
  } else L.push("near: nothing in view");
  const far = Object.entries(d.farther);
  if (far.length) L.push(`farther: ${far.map(([k, v]) => `${k}×${v}`).join(", ")}`);
  if (d.remembered.length) L.push(`out of view (last seen): ${d.remembered.map((r) => `${r.key} ${r1(r.dist)} ${r.dir}`).join(", ")}`);
  if (w.dialogue) {
    const dl = w.dialogue;
    L.push(`dialogue — ${dl.speaker ? `${dl.speaker}: ` : ""}"${clip(oneLine(dl.text), 220)}"`);
    if (dl.options.length) L.push(`  ${dl.options.map((o, i) => `${i + 1}) ${clip(oneLine(o), 60)}`).join("   ")}    (choose ${dl.options.map((_, i) => i + 1).join(" / ")})`);
  }
  if (w.menu) L.push(`menu open: ${clip(typeof w.menu === "string" ? w.menu : JSON.stringify(w.menu), 140)}`);
  if (d.notice && !w.dead) L.push(`game says: "${clip(oneLine(d.notice), 140)}"`);
  if (d.map) {
    const leg = cfg.profile === "platformer" ? "@ you, # solid" + (w.map?.legend ? `, ${Object.entries(w.map.legend).filter(([k]) => k !== "#" && k !== ".").slice(0, 5).map(([k, v]) => `${k} ${clip(v, 14)}`).join(", ")}` : "")
      : "@ you, # wall, . open, ? unknown";
    L.push(`map (${leg}${d.map.legend.length ? `; ${d.map.legend.join(" ")}` : ""}; N up; top-left cell (${d.map.x0},${d.map.y0})):`);
    for (const r of d.map.rows) L.push(`  ${r}`);
  }
  const evs = (ctx.events || []).filter((e) => !e.dup && (!["bump", "stat"].includes(e.kind) || (ctx.events || []).length < 6));
  if (evs.length) {
    const shown = evs.slice(-9);
    L.push(`events: ${shown.map((e) => `${r1(e.t)} ${e.text}`).join(" · ")}${evs.length > shown.length ? ` (+${evs.length - shown.length} earlier)` : ""}`);
  }
  if (ctx.first) {
    L.push(`controls: ${describeControls(cfg)}`);
    L.push(`orders: ${ORDER_CARD.split("\n").join("\n        ")}${cfg.profile === "platformer" ? `\n        ${ORDER_CARD_PLATFORMER}` : cfg.profile === "fps" ? `\n        ${ORDER_CARD_FPS}` : ""}`);
  }
  return L.join("\n");
}

// ------------------------------------------------------------------ turn-based / card / menu games
/** One field value as text: numbers, short strings, lists of cards/labels, {us: 3, them: 5} scores. */
export function fmtField(v, n = 160) {
  if (v == null) return "–";
  if (typeof v === "number") return String(r1(v));
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return clip(oneLine(v), n);
  const lab = (x) => (x && typeof x === "object" ? x.label ?? x.text ?? x.name ?? x.title ?? x.card ?? x.id ?? null : x);
  if (Array.isArray(v)) {
    if (!v.length) return "(none)";
    const parts = v.map((x) => { const l = lab(x); return l != null && typeof l !== "object" ? String(l) : JSON.stringify(x); });
    return clip(parts.join(", "), n);
  }
  const ent = Object.entries(v);
  if (ent.length && ent.every(([, x]) => x == null || typeof x !== "object")) return clip(ent.map(([k, x]) => `${k} ${typeof x === "number" ? r1(x) : x}`).join(" · "), n);
  const l = lab(v);
  return clip(l != null && typeof l !== "object" ? String(l) : JSON.stringify(v), n);
}

function turnData(w, ctx) {
  const fields = {};
  for (const s of w.stats) fields[s.label] = s.value;
  return { t: +w.t.toFixed(2), frame: w.frame, profile: "turn", scene: w.scene, yourTurn: w.yourTurn, fields,
    choices: (w.choices || []).map((c) => ({ n: c.n, label: c.label, id: c.id, legal: c.legal, selected: c.selected || undefined })),
    dialogue: w.dialogue, goal: w.goal ? w.goal.text : null, notice: w.notice, dead: w.dead, over: w.over || false, won: w.won, result: ctx.result || null,
    events: (ctx.events || []).map((e) => ({ t: +e.t.toFixed(2), kind: e.kind, text: e.text })) };
}

/** The turn profile's observation: the game's own fields, whose turn, the choices; no map, no distances, no cell. */
function turnText(w, ctx) {
  const d = turnData(w, ctx), cfg = ctx.cfg, L = [];
  const head = [`[t ${fmtT(w.t)}${ctx.live ? ` · ${ctx.live}` : ""}]`];
  if (w.scene) head.push(`scene ${clip(w.scene, 30)}`);
  const long = [];
  for (const [k, v] of Object.entries(d.fields)) {
    const txt = fmtField(v);
    if (Array.isArray(v) || txt.length > 32) long.push([k, txt]); else head.push(`${k} ${txt}`);
  }
  if (w.yourTurn === true) head.push("YOUR TURN"); else if (w.yourTurn === false) head.push("not your turn");
  L.push(head.join(" · "));
  if (ctx.clock) L.push(ctx.clock);
  if (ctx.first && ctx.session && ctx.session.goal) L.push(`your goal: ${ctx.session.goal}`);
  if (d.goal) L.push(`goal: ${clip(oneLine(d.goal), 140)}`);
  if (d.result) L.push(d.result.line);
  if (w.won) L.push("★ GAME WON (the game reports a win) — play on or end the session");
  else if (w.dead || w.over) L.push(`GAME OVER${w.notice ? ` — game says: "${clip(oneLine(w.notice), 100)}"` : ""}`);
  for (const [k, txt] of long) L.push(`${k}: ${txt}`);
  if (w.dialogue) {
    const dl = w.dialogue;
    L.push(`dialogue — ${dl.speaker ? `${dl.speaker}: ` : ""}"${clip(oneLine(dl.text), 220)}"`);
    if (dl.options.length) L.push(`  ${dl.options.map((o, i) => `${i + 1}) ${clip(oneLine(o), 60)}`).join("   ")}    (choose ${dl.options.map((_, i) => i + 1).join(" / ")})`);
  }
  const ch = w.choices || [];
  if (ch.length && !(w.dialogue && w.dialogue.options.length)) {
    const shown = ch.slice(0, 24);
    const one = (c) => `${c.n}) ${clip(c.label, 56)}${c.selected ? " (selected)" : ""}${c.legal ? "" : " (not allowed)"}`;
    const lines = []; let line = "";
    for (const c of shown) { const x = one(c); if (line && line.length + x.length > 110) { lines.push(line); line = ""; } line += (line ? "   " : "") + x; }
    if (line) lines.push(line);
    L.push(`choices (pick <n> or pick <words>)${ch.length > shown.length ? ` — ${ch.length} in all, the rest by words` : ""}:`);
    for (const l of lines) L.push(`  ${l}`);
  } else if (!ch.length && !w.dialogue) L.push(w.yourTurn === false ? "no choices: the others are playing (wait)" : "no choices listed right now");
  if (w.menu) L.push(`menu open: ${clip(typeof w.menu === "string" ? w.menu : JSON.stringify(w.menu), 140)}`);
  if (d.notice && !w.dead) L.push(`game says: "${clip(oneLine(d.notice), 140)}"`);
  const evs = (ctx.events || []).filter((e) => !e.dup);
  if (evs.length) {
    const shown = evs.slice(-9);
    L.push(`events: ${shown.map((e) => `${r1(e.t)} ${e.text}`).join(" · ")}${evs.length > shown.length ? ` (+${evs.length - shown.length} earlier)` : ""}`);
  }
  if (ctx.first) {
    const ctl = describeControls(cfg);
    if (ctl) L.push(`controls: ${ctl}`);
    L.push(`orders: ${ORDER_CARD_TURN.split("\n").join("\n        ")}`);
  }
  return L.join("\n");
}

// ------------------------------------------------------------------ static / tower / base defense games
/**
 * The defense observation's data: the base (hp, the game's stats), every enemy on the field closest first with its
 * distance from the base (cells), how fast it closes in, when it would arrive, and where it is on the screen (when the
 * game says: entity screen, state.camera, play.screen); items; no cell, no map, no compass.
 */
function defenseData(w, ctx) {
  const { cfg, ap } = ctx, P = w.player, fps = (ap && ap.fps) || 60, size = (ap && ap.size) || [640, 360];
  const stats = {};
  for (const s of w.stats) stats[s.label] = s.value;
  const one = (th) => {
    let closing = null;
    if (P && P.p2 && th.v && Number.isFinite(th.dist)) {
      const d = [P.p2[0] - th.p2[0], P.p2[1] - th.p2[1]], L = Math.hypot(d[0], d[1]);
      if (L > 1e-9) closing = +(((th.v[0] * d[0] + th.v[1] * d[1]) / L) * fps / w.cell).toFixed(2);
    }
    const sc = screenOf(th, w, cfg, size);
    return { key: th.key, type: th.type, name: th.name, dist: Number.isFinite(th.dist) ? +th.dist.toFixed(1) : null, hp: th.hp, maxHp: th.maxHp,
      closing, eta: closing > 0.05 && Number.isFinite(th.dist) ? +(th.dist / closing).toFixed(1) : null, screen: sc.xy || null,
      boss: !!(th.raw && th.raw.boss), windup: !!th.telegraph, state: th.state && !IDLE.test(th.state) ? th.state : null };
  };
  const live = w.things.filter((th) => !th.dead);
  const byDist = (a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity);
  return { t: +w.t.toFixed(2), frame: w.frame, profile: "defense", base: P ? { hp: P.hp, maxHp: P.maxHp } : null, stats,
    enemies: live.filter((th) => th.rel === "hostile").map(one).sort(byDist), items: live.filter((th) => th.rel === "item").map(one).sort(byDist),
    others: live.filter((th) => th.rel !== "hostile" && th.rel !== "item").length,
    dialogue: w.dialogue, goal: w.goal ? w.goal.text : null, notice: w.notice, dead: w.dead, won: w.won, result: ctx.result || null,
    events: (ctx.events || []).map((e) => ({ t: +e.t.toFixed(2), kind: e.kind, text: e.text })) };
}

function defenseText(w, ctx) {
  const d = defenseData(w, ctx), cfg = ctx.cfg, L = [];
  const head = [`[t ${fmtT(w.t)}${ctx.live ? ` · ${ctx.live}` : ""}]`];
  if (d.base && d.base.hp != null) head.push(`base hp ${r1(d.base.hp)}${d.base.maxHp ? `/${r1(d.base.maxHp)}` : ""}`);
  for (const [k, v] of Object.entries(d.stats)) head.push(`${k} ${typeof v === "number" ? r1(v) : typeof v === "boolean" ? (v ? "yes" : "no") : clip(String(v), 20)}`);
  L.push(head.join(" · "));
  if (ctx.clock) L.push(ctx.clock);
  if (ctx.first && ctx.session && ctx.session.goal) L.push(`your goal: ${ctx.session.goal}`);
  if (d.goal) L.push(`goal: ${clip(oneLine(d.goal), 140)}`);
  if (d.result) L.push(d.result.line);
  if (ctx.live && ctx.order && !(d.result && /^(✔|✖)/.test(d.result.line || ""))) L.push(`your order (still running): ${ctx.order}`);
  else if (ctx.live && !ctx.order) L.push("no order running: standing by (attacking the nearest enemy) while the game plays on");
  if (w.dead) L.push(`THE BASE HAS FALLEN${w.notice ? ` — game says: "${clip(oneLine(w.notice), 100)}"` : ""}`);
  else if (w.won) L.push("★ GOAL REACHED (the game reports a win)");
  const fmt = (e, enemy) => {
    const bits = [];
    if (e.hp != null) bits.push(`hp ${r1(e.hp)}${e.maxHp ? `/${r1(e.maxHp)}` : ""}`);
    if (e.boss) bits.push("BOSS");
    if (e.windup) bits.push("WINDUP");
    else if (e.state) bits.push(e.state);
    if (enemy && e.closing != null) bits.push(e.closing > 0.05 ? `closing ${r1(e.closing)} cells/s${e.eta != null ? ` (there in ~${Math.max(0, Math.round(e.eta))}s)` : ""}` : e.closing < -0.05 ? "moving away" : "holding");
    if (e.screen) bits.push(`screen ${e.screen.join(",")}`);
    if (e.name && !/^\d+$/.test(e.name)) bits.push(`"${clip(e.name, 24)}"`);
    return bits.join("  ");
  };
  if (d.enemies.length) {
    const near = d.enemies.filter((e) => e.dist != null && e.dist <= cfg.alert).length, shown = d.enemies.slice(0, 10);
    L.push(`enemies: ${d.enemies.length} on the field${near ? `, ${near} within ${r1(cfg.alert)} cells` : ""} (closest first; cells from the base):`);
    const kw = Math.min(16, Math.max(...shown.map((e) => e.key.length)));
    for (const e of shown) L.push(`  ${e.key.padEnd(kw)}  ${e.dist == null ? "    ?" : e.dist.toFixed(1).padStart(5)}  ${fmt(e, true)}`);
    if (d.enemies.length > shown.length) { const rest = {}; for (const e of d.enemies.slice(shown.length)) rest[e.type] = (rest[e.type] || 0) + 1; L.push(`  … +${d.enemies.length - shown.length} farther: ${Object.entries(rest).map(([k, v]) => `${k}×${v}`).join(", ")}`); }
  } else L.push("enemies: none on the field (between waves? \"fight enemies for 25s\" waits for the next)");
  if (d.items.length) L.push(`items: ${d.items.slice(0, 6).map((e) => `${e.key} ${e.dist == null ? "" : `${e.dist} `}${e.screen ? `(screen ${e.screen.join(",")})` : ""}`.trim()).join(" · ")}${d.items.length > 6 ? ` +${d.items.length - 6}` : ""}`);
  if (w.dialogue) {
    const dl = w.dialogue;
    L.push(`dialogue — ${dl.speaker ? `${dl.speaker}: ` : ""}"${clip(oneLine(dl.text), 220)}"`);
    if (dl.options.length) L.push(`  ${dl.options.map((o, i) => `${i + 1}) ${clip(oneLine(o), 60)}`).join("   ")}    (choose ${dl.options.map((_, i) => i + 1).join(" / ")})`);
  }
  if (w.menu) L.push(`menu open: ${clip(typeof w.menu === "string" ? w.menu : JSON.stringify(w.menu), 140)}`);
  if (d.notice && !w.dead) L.push(`game says: "${clip(oneLine(d.notice), 140)}"`);
  const evs = (ctx.events || []).filter((e) => !e.dup && e.kind !== "bump");
  if (evs.length) { const shown = evs.slice(-9); L.push(`events: ${shown.map((e) => `${r1(e.t)} ${e.text}`).join(" · ")}${evs.length > shown.length ? ` (+${evs.length - shown.length} earlier)` : ""}`); }
  if (ctx.first) {
    const ctl = describeControls(cfg);
    if (ctl) L.push(`controls: ${ctl}`);
    L.push(`orders: ${ORDER_CARD_DEFENSE.split("\n").join("\n        ")}`);
  }
  return L.join("\n");
}

/** The one-line summary of how a `do` ended. */
export function resultLine(r) {
  if (!r) return null;
  const icon = { done: "✔ done", fail: "✖ failed", interrupted: "⚠ interrupted", time: "⏱ time", idle: "· idle", error: "✖ error", goal: "★ GOAL REACHED", until: "★ UNTIL REACHED", running: "⏩ running", event: "⚠", ended: "■ session ended" }[r.status] || r.status;
  return `${icon}: ${r.order ? `${clip(r.order, 60)} — ` : ""}${r.msg || ""}${r.seconds != null ? ` (${r1(r.seconds)}s)` : ""}`.replace(/ — $/, "");
}
export { thingLabel, len };
