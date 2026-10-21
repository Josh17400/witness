// A tiny turn-based card game for the `play` turn profile tests ("High Card"): a home menu (Play, Settings), a
// settings screen whose difficulty buttons only toggle a selected flag, and a table where you and a bot each play one
// card a trick (the higher card wins the point). Exposes the turn conventions: state.choices = [{label, id, legal,
// selected}], state.yourTurn, state.scene, state.score, state.hand. Picks arrive as call("choose", [id]).
// Every scene change starts a 9-frame "crossfade"; eval of the expression the harness uses to settle animations
// answers how many frames are left. A won trick is both shown (state.notice) and logged with the same words.
//   imported: `new CardGame(seed)` with step()/snapshot()/call()/eval()   ·   run: a protocol game (WITNESS_ADDR)
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ANIM_EXPR = "globalThis.__witnessAnimating?.() ?? 0";
const SUITS = ["♠", "♥", "♦", "♣"];

export class CardGame {
  constructor(seed = 1) { this.reset(seed); }
  reset(seed = 1) {
    this.seed = seed; this.frame = 0; this.scene = "home"; this.anim = 30; this.difficulty = "easy";   // (the title fades in for half a second)
    this.score = { you: 0, bot: 0 }; this.hand = []; this.botHand = []; this.trick = []; this.yourTurn = null;
    this.botTimer = 0; this.notice = null; this.logs = []; this.won = false; this.over = false; this.evals = 0;
  }
  go(scene) { this.scene = scene; this.anim = 9; }
  deal() {
    const r = (i) => ((this.seed * 7 + i * 5) % 13) + 1;
    this.hand = [0, 1, 2].map((i) => ({ rank: r(i), suit: SUITS[i % 4] }));
    this.botHand = [3, 4, 5].map((i) => ({ rank: ((r(i) + 3) % 13) + 1, suit: SUITS[(i + 1) % 4] }));
    this.score = { you: 0, bot: 0 }; this.trick = []; this.yourTurn = true; this.won = false; this.over = false;
  }
  name(c) { return `${({ 1: "A", 11: "J", 12: "Q", 13: "K" })[c.rank] || c.rank}${c.suit}`; }
  choices() {
    if (this.scene === "home") return [{ label: "Play", id: "play" }, { label: "Settings", id: "settings" }];
    if (this.scene === "settings") return [...["easy", "hard"].map((d) => ({ label: d[0].toUpperCase() + d.slice(1), id: d, selected: this.difficulty === d })), { label: "Back", id: "back" }];
    if (this.scene === "table") return [...this.hand.map((c) => ({ label: `Play ${this.name(c)}`, id: this.name(c), legal: !!this.yourTurn })), { label: "Menu (leave match)", id: "menu" }];
    return [{ label: "Home", id: "home" }];
  }
  call(name, args) {
    if (name !== "choose") throw new Error(`unknown call ${name}`);
    const id = String(args[0]);
    const ch = this.choices().find((c) => c.id === id);
    if (!ch) return { ok: false, error: `no choice ${id}` };
    if (ch.legal === false) return { ok: false, error: "not your turn" };
    if (this.scene === "home") { if (id === "play") { this.deal(); this.go("table"); } else this.go("settings"); return true; }
    if (this.scene === "settings") { if (id === "back") this.go("home"); else this.difficulty = id; return true; }
    if (this.scene === "result") { this.go("home"); return true; }
    if (id === "menu") { this.go("home"); this.yourTurn = null; return true; }
    const i = this.hand.findIndex((c) => this.name(c) === id);
    this.trick = [this.hand.splice(i, 1)[0]]; this.yourTurn = false; this.botTimer = 30;
    return true;
  }
  step() {
    this.frame++;
    if (this.anim > 0) this.anim--;
    if (this.scene === "table" && this.yourTurn === false && --this.botTimer <= 0) {
      const b = this.botHand.shift(); this.trick.push(b);
      const youWin = this.trick[0].rank >= b.rank;
      this.score[youWin ? "you" : "bot"]++;
      this.notice = youWin ? `You won the trick with ${this.name(this.trick[0])}!` : `The bot took the trick with ${this.name(b)}.`;
      this.logs.push({ frame: this.frame, level: "info", message: this.notice });
      if (!this.hand.length) { this.over = true; this.won = this.score.you > this.score.bot; this.yourTurn = null; this.go("result"); }
      else this.yourTurn = true;
    }
  }
  eval(expr) { this.evals++; if (expr !== ANIM_EXPR) throw new Error("only the animation probe is supported"); return this.anim; }
  state() {
    return { scene: this.scene, phase: this.scene === "table" ? (this.yourTurn ? "your lead" : "bot thinking") : null, score: this.score, hand: this.hand.map((c) => this.name(c)),
      trick: this.trick.map((c) => this.name(c)), difficulty: this.difficulty, transition: this.anim, yourTurn: this.yourTurn, choices: this.choices(), notice: this.notice,
      won: this.won, gameOver: this.over };
  }
  snapshot() { return { frame: this.frame, time: this.frame / 60, state: this.state() }; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [host, port] = String(process.env.WITNESS_ADDR || "127.0.0.1:7357").split(":");
  const g = new CardGame(1);
  const sock = net.connect(+port, host);
  const send = (o) => sock.write(JSON.stringify(o) + "\n");
  sock.on("connect", () => send({ hello: { protocol: 1, name: "High Card", engine: "node", language: "javascript", fps: 60, size: [8, 8], capabilities: ["reset", "step", "snapshot", "input", "call", "eval", "logs", "screenshot"] } }));
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
          case "step": for (let i = 0; i < m.frames; i++) g.step(); reply({ frame: g.frame, time: g.frame / 60 }); break;
          case "snapshot": reply(g.snapshot()); break;
          case "input": reply({}); break;
          case "call": reply({ result: g.call(m.name, m.args || []) }); break;
          case "eval": reply({ value: g.eval(m.expr) }); break;
          case "logs": reply({ logs: g.logs.splice(0) }); break;
          // a flat picture whose red channel is the frames of crossfade left (0 once settled)
          case "screenshot": { const px = Buffer.alloc(8 * 8 * 4); for (let i = 0; i < 64; i++) { px[i * 4] = g.anim * 20; px[i * 4 + 3] = 255; } reply({ width: 8, height: 8, format: "rgba8", data: px.toString("base64") }); break; }
          case "quit": reply({}); setTimeout(() => process.exit(0), 10); break;
          default: send({ id: m.id, ok: false, error: `unknown ${m.cmd}` });
        }
      } catch (e) { send({ id: m.id, ok: false, error: e.message }); }
    }
  });
  sock.on("close", () => process.exit(0));
  sock.on("error", () => process.exit(1));
}
