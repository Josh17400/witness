// A tiny protocol-complete game used to test the Witness CLI itself (not an adapter template).
// Player moves with arrows/WASD at 120 px/s, collects coins (+1 score, a "ding" sound).
// Pointer: dragging with the left button (or finger 0: touch id 0 is treated like the mouse) drags the
// player by the pointer's movement; state.pointer and state.touches (fingers down) make input observable.
import net from "node:net";

const FPS = 60, W = 320, H = 180, SR = 22050;
let rngState = 1, frame = 0, time = 0, queue = [], keys = new Set(), logs = [], audioBuf = [];
let pointer = { x: 0, y: 0, down: false }, fingers = new Map();
let player, coins, score;
const rng = () => { rngState = (rngState * 1103515245 + 12345) & 0x7fffffff; return rngState / 0x7fffffff; };

function reset(seed = 1) {
  rngState = seed || 1; frame = 0; time = 0; queue = []; keys = new Set(); audioBuf = []; score = 0;
  pointer = { x: 0, y: 0, down: false }; fingers = new Map();
  player = { id: 1, type: "Player", pos: [40, 90], hp: 3 };
  coins = Array.from({ length: 5 }, (_, i) => ({ id: 10 + i, type: "Coin", pos: [80 + i * 40, i === 0 ? 90 : 60 + ((seed * 7 + i * 13) % 61)] }));
}

function stepOnce(dt) {
  for (const e of queue.filter((e) => e.frame <= frame)) {
    if (e.type === "key") e.down ? keys.add(e.key) : keys.delete(e.key);
    if (e.type === "action" && e.action === "dash") player.pos[0] += 30;
    if (e.type === "touch") e.phase === "up" ? fingers.delete(e.id) : fingers.set(e.id, [e.x, e.y]);
    // finger 0 drives the same pointer as the mouse (down -> button 0 down, move -> move, up -> button up)
    const p = e.type === "mouse" && (e.button ?? 0) === 0 ? { x: e.x, y: e.y, down: e.down }
      : e.type === "touch" && e.id === 0 ? { x: e.x, y: e.y, down: e.phase === "down" ? true : e.phase === "up" ? false : undefined } : null;
    if (p) {
      if (p.x != null && pointer.down) { player.pos[0] += p.x - pointer.x; player.pos[1] += p.y - pointer.y; }
      if (p.x != null) { pointer.x = p.x; pointer.y = p.y; }
      if (p.down !== undefined) pointer.down = p.down;
    }
  }
  queue = queue.filter((e) => e.frame > frame);
  const dx = (keys.has("right") || keys.has("d") ? 1 : 0) - (keys.has("left") || keys.has("a") ? 1 : 0);
  const dy = (keys.has("down") || keys.has("s") ? 1 : 0) - (keys.has("up") || keys.has("w") ? 1 : 0);
  player.pos[0] = Math.max(0, Math.min(W, player.pos[0] + dx * 120 * dt));
  player.pos[1] = Math.max(0, Math.min(H, player.pos[1] + dy * 120 * dt));
  for (const c of [...coins]) {
    if (Math.hypot(c.pos[0] - player.pos[0], c.pos[1] - player.pos[1]) < 12) {
      coins.splice(coins.indexOf(c), 1);
      score++;
      logs.push({ frame, level: "info", message: `coin ${c.id} collected` });
      // ding: a 0.15 s 880 Hz decaying sine starting now
      const start = audioBuf.length;
      for (let i = 0; i < SR * 0.15; i++) audioBuf[start + i] = (audioBuf[start + i] || 0) + Math.sin(2 * Math.PI * 880 * i / SR) * 0.5 * Math.exp(-i / (SR * 0.04));
    }
  }
  // audio advances with simulated time
  const want = Math.round((time + dt) * SR);
  while (audioBuf.length < want) audioBuf.push(0);
  frame++; time += dt;
  if (process.env.MOCK_CRASH_AT && frame === +process.env.MOCK_CRASH_AT) logs.push({ frame, level: "error", message: "boom: something broke" });
}

function screenshot() {
  const px = Buffer.alloc(W * H * 4);
  const put = (x, y, r, g, b) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, 20, 24, 40);
  const blob = (p, r, c) => { for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) put(Math.round(p[0]) + x, Math.round(p[1]) + y, ...c); };
  coins.forEach((c) => blob(c.pos, 5, [255, 210, 60]));
  blob(player.pos, 7, [80, 200, 255]);
  return { width: W, height: H, format: "rgba8", data: px.toString("base64") };
}

let audioSent = 0;
function audio() {
  const n = audioBuf.length - audioSent;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = audioBuf[audioSent + i];
  audioSent = audioBuf.length;
  return { sampleRate: SR, channels: 1, format: "f32", data: Buffer.from(f.buffer).toString("base64") };
}

reset(1);
const [host, port] = (process.env.WITNESS_ADDR || "127.0.0.1:7357").split(":");
const sock = net.connect(+port, host, () => {
  sock.write(JSON.stringify({ hello: { protocol: 1, name: "Mock Coins", engine: "node", language: "javascript", fps: FPS, size: [W, H],
    capabilities: ["reset", "step", "input", "snapshot", "screenshot", "audio", "call", "eval", "logs", "perf"],
    calls: [{ name: "teleport", args: "x y", help: "move the player" }, { name: "addcoin", args: "x y" }] } }) + "\n");
});
let buf = "";
sock.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    const reply = (o) => sock.write(JSON.stringify({ id: m.id, ok: true, ...o }) + "\n");
    const fail = (e) => sock.write(JSON.stringify({ id: m.id, ok: false, error: e }) + "\n");
    switch (m.cmd) {
      case "reset": reset(m.seed); audioSent = 0; reply({}); break;
      case "input": queue.push(...m.events); reply({}); break;
      case "step": { const n = m.frames || 1; for (let i = 0; i < n; i++) stepOnce(m.dts ? m.dts[i] : m.dt || 1 / FPS); reply({ frame, time }); break; }
      case "snapshot": reply({ frame, time, state: { score, scene: "level1", player, pointer, touches: fingers.size, entities: [player, ...coins] } }); break;
      case "screenshot": reply(screenshot()); break;
      case "audio": reply(audio()); break;
      case "call":
        if (m.name === "teleport") { player.pos = [+m.args[0], +m.args[1]]; reply({ result: player.pos }); }
        else if (m.name === "addcoin") { coins.push({ id: 100 + coins.length, type: "Coin", pos: [+m.args[0], +m.args[1]] }); reply({ result: coins.length }); }
        else fail(`unknown call '${m.name}'`);
        break;
      case "eval": try { reply({ value: eval(m.expr) }); } catch (e) { fail(String(e)); } break; // eslint-disable-line no-eval
      case "logs": reply({ logs: logs.splice(0) }); break;
      case "perf": reply({ frame_ms: 0.01, counts: { coins: coins.length } }); break;
      case "quit": reply({}); setTimeout(() => process.exit(0), 10); break;
      default: fail(`unknown command '${m.cmd}'`);
    }
  }
});
sock.on("close", () => process.exit(0));
