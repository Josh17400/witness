// A tiny static defense game for the `play` defense profile tests ("Tiny Fort"): the base sits at the world origin and
// never moves; waves of grunts walk in from a ring 120 units out at 24 units/s and chip the base when they reach it.
// Wave 1 comes at 0.5 s (3 grunts), then each wave 2 s after the field is clear. You hurt the nearest grunt with the
// key "j" (one point a press), or by tapping / clicking a grunt where it is drawn (state.camera maps world to screen:
// a 320×180 screen with the base in the middle). Calls: buy (false when broke, {ok: false, error} for an unknown
// item), status (a long string), nothing (no result), boom (throws). Moving keys are logged so a test can see that
// the harness never pressed one. Options for the 0.7.7 tests (all off by default): `dialogEvery` opens a
// "Field commendation" pick of 3 after every Nth cleared wave (the game pauses; keys 1-3 pick, ignored for `lockFrames`
// (39 = 650 ms) after it opens, like The Fort's anti-misclick lockout; `readyField` shows that as dialogue.ready; `dialogClose` frames: the card closes by itself),
// `gruntHp`, `baseHp`, and `bombAt` (a frame: a bomb hits the base for `bombDamage`, state.lastHit = `lastHit`).
//   imported: `new FortGame(seed)` with input()/step()/snapshot()/call()   ·   run: a protocol game (WITNESS_ADDR)
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const W = 320, H = 180;

export class FortGame {
  constructor(seed = 1, { camera = true, dialogEvery = 0, readyField = false, lockFrames = 39, dialogClose = null, gruntHp = 2, baseHp = 20, bombAt = null, bombDamage = 5, lastHit = { by: "Bomber", type: "bomb" } } = {}) {
    this.camera = camera; this.opt = { dialogEvery, readyField, lockFrames, dialogClose, gruntHp, baseHp, bombAt, bombDamage, lastHit }; this.reset(seed);
  }
  reset(seed = 1) {
    this.seed = seed; this.frame = 0; this.hp = this.opt ? this.opt.baseHp : 20; this.choosing = null; this.perk = null; this.ignoredPicks = 0; this.lastHit = null; this.wave = 0; this.kills = 0; this.bank = 5; this.nextId = 1;
    this.enemies = []; this.nextWaveAt = 30; this.queue = []; this.moves = []; this.taps = []; this.logs = [];
  }
  input(events) { this.queue.push(...events); }
  spawn() {
    this.wave++;
    for (let i = 0; i < 3; i++) {
      const a = (this.seed * 0.7 + this.wave * 1.3 + i * 2.1) % (Math.PI * 2);
      this.enemies.push({ id: this.nextId++, x: Math.cos(a) * 120, y: Math.sin(a) * 70, hp: this.opt.gruntHp });
    }
  }
  hurt(e) { e.hp--; if (e.hp <= 0) { this.kills++; this.bank += 2; } }
  nearest() { return this.enemies.filter((e) => e.hp > 0).sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y))[0] || null; }
  apply(e) {
    if (this.choosing) {
      // the pick: keys 1-3, ignored for lockFrames after the card opens (anti-misclick); nothing else works meanwhile
      const n = e.type === "key" && e.down ? +e.key : NaN;
      if (n >= 1 && n <= 3) { if (this.frame - this.choosing.at < this.opt.lockFrames) this.ignoredPicks++; else { this.perk = n; this.choosing = null; this.nextWaveAt = this.frame + 120; } }
      return;
    }
    if (e.type === "key" && e.down && e.key === "j") { const n = this.nearest(); if (n) this.hurt(n); }
    if (e.type === "key" && e.down && /^(w|a|s|d|up|down|left|right)$/.test(e.key)) this.moves.push(e.key);
    const at = e.type === "touch" && e.phase === "down" ? [e.x, e.y] : e.type === "mouse" && e.down === true ? [e.x, e.y] : null;
    if (at) {
      this.taps.push(at);
      const wx = at[0] - W / 2, wy = at[1] - H / 2;
      const hit = this.enemies.filter((g) => g.hp > 0 && Math.hypot(g.x - wx, g.y - wy) <= 8)[0];
      if (hit) this.hurt(hit);
    }
  }
  step() {
    for (const e of this.queue.filter((q) => q.frame <= this.frame)) this.apply(e);
    this.queue = this.queue.filter((q) => q.frame > this.frame);
    this.frame++;
    if (this.choosing && this.opt.dialogClose != null && this.frame - this.choosing.at >= this.opt.dialogClose) { this.choosing = null; this.nextWaveAt = this.frame + 120; }   // a timed card
    if (this.hp <= 0 || this.choosing) return;
    if (this.opt.bombAt != null && this.frame === this.opt.bombAt) { this.hp = Math.max(0, this.hp - this.opt.bombDamage); this.lastHit = this.opt.lastHit; if (this.hp <= 0) return; }
    if (this.nextWaveAt != null && this.frame >= this.nextWaveAt) { this.spawn(); this.nextWaveAt = null; }
    for (const g of this.enemies) {
      if (g.hp <= 0) continue;
      const d = Math.hypot(g.x, g.y);
      if (d > 10) { g.x -= (g.x / d) * 0.4; g.y -= (g.y / d) * 0.4; }
      else if (this.frame % 30 === 0) { this.hp--; this.lastHit = null; }
    }
    this.enemies = this.enemies.filter((g) => g.hp > 0);
    if (!this.enemies.length && this.nextWaveAt == null) {
      if (this.opt.dialogEvery && this.wave % this.opt.dialogEvery === 0 && this.perkWave !== this.wave) { this.perkWave = this.wave; this.choosing = { at: this.frame }; }
      else this.nextWaveAt = this.frame + 120;
    }
  }
  call(name, args) {
    if (name === "buy") { if (args[0] !== "wall") return { ok: false, error: `no item "${args[0]}"` }; if (this.bank < 100) return false; this.bank -= 100; return `bought a wall, $${this.bank} left`; }
    if (name === "status") return `wave ${this.wave} · ` + Array.from({ length: 60 }, (_, i) => `upgrade${i}=lv${i % 4}`).join(", ") + " · END";
    if (name === "nothing") return undefined;
    if (name === "boom") throw new Error("the armory is on fire");
    throw new Error(`unknown call ${name}`);
  }
  state() {
    const r1 = (v) => Math.round(v * 10) / 10;
    return {
      wave: this.wave, kills: this.kills, bank: this.bank, dead: this.hp <= 0, won: false,
      ...(this.camera ? { camera: { pos: [-W / 2, -H / 2], zoom: 1 } } : {}),
      player: { id: 0, type: "Base", pos: [0, 0], hp: this.hp, maxHp: this.opt.baseHp },
      ...(this.lastHit ? { lastHit: this.lastHit } : {}),
      ...(this.opt.dialogEvery ? { dialogue: this.choosing ? { speaker: "Command", text: "Field commendation: pick one directive", options: ["Walls: +5 base hp", "Rapid fire", "Bounty: +$2 a kill"], ...(this.opt.readyField ? { ready: this.frame - this.choosing.at >= this.opt.lockFrames } : {}) } : null } : {}),
      entities: this.enemies.map((g) => ({ id: g.id, type: "Grunt", pos: [r1(g.x), r1(g.y)], hp: g.hp, maxHp: this.opt.gruntHp, hostile: true })),
    };
  }
  snapshot() { return { frame: this.frame, time: this.frame / 60, state: this.state() }; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [host, port] = String(process.env.WITNESS_ADDR || "127.0.0.1:7357").split(":");
  const g = new FortGame(1);
  const sock = net.connect(+port, host);
  const send = (o) => sock.write(JSON.stringify(o) + "\n");
  sock.on("connect", () => send({ hello: { protocol: 1, name: "Tiny Fort", engine: "node", language: "javascript", fps: 60, size: [W, H], keys: ["j", "p"], capabilities: ["reset", "step", "snapshot", "input", "call", "logs", "perf"] } }));
  // lazy drawing (step "draw": "last"): it "draws" only the last frame of a hinted step and says so in perf.lazy_draw
  const lazy = { reads: 0, skipped: 0 };
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
      const reply = (o) => send({ id: m.id, ok: true, ...o });
      try {
        switch (m.cmd) {
          case "reset": g.reset(m.seed ?? 1); reply({}); break;
          case "step": for (let i = 0; i < m.frames; i++) { g.step(); lazy.reads++; if (m.draw === "last" && i < m.frames - 1) lazy.skipped++; } reply({ frame: g.frame, time: g.frame / 60 }); break;
          case "perf": reply({ frame_ms: 0, lazy_draw: lazy }); break;
          case "snapshot": reply(g.snapshot()); break;
          case "input": g.input(m.events || []); reply({}); break;
          case "call": { const v = g.call(m.name, m.args || []); reply(v === undefined ? {} : { result: v }); break; }
          case "logs": reply({ logs: g.logs.splice(0) }); break;
          case "quit": reply({}); setTimeout(() => process.exit(0), 10); break;
          default: send({ id: m.id, ok: false, error: `unknown ${m.cmd}` });
        }
      } catch (e) { send({ id: m.id, ok: false, error: e.message }); }
    }
  });
  sock.on("close", () => process.exit(0));
  sock.on("error", () => process.exit(1));
}
