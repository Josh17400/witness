// A tiny protocol-complete game used to test the Witness CLI itself (not an adapter template).
// Player moves with arrows/WASD at 120 px/s, collects coins (+1 score, a "ding" sound).
// Pointer: dragging with the left button (or finger 0: touch id 0 is treated like the mouse) drags the
// player by the pointer's movement; state.pointer and state.touches (fingers down) make input observable.
//
// Opt-in mechanics with exact, planted numbers (for testing Witness's measurements):
//   MOCK_JUMP=1    platformer: no up/down walking; space jumps (vy0 = -7 px/f, gravity 0.4 px/f², explicit Euler:
//                  apex 64.8 px at +18f, lands at +36f); left/right accelerate 0.5 px/f per frame up to 3 px/f and
//                  brake 1 px/f per frame; h = hitstop (all motion frozen for exactly 5 frames). Coyote time: a jump
//                  still works in the step the ground disappears and the 4 after it (5 frames); jump buffer: a press
//                  up to 4 frames before the landing step jumps on landing. state.player gains vy, vx, grounded, jumps.
//   MOCK_LEDGE=1   (with MOCK_JUMP) the floor at y=90 ends at x=200; past it the player falls to y=150
//   MOCK_ALIGN=1   coin 12 is drawn 6 px left of its state position; entities carry a hitbox "box": the player's
//                  [15, 15] matches its art, the coins' [16, 16] is bigger than their 11 px art
//   MOCK_ZOOM=2    everything is drawn twice as big: screen = (world - camera) × 2
//   MOCK_CAMERA=1  a textured world; the camera scrolls right 2 px per frame, with one 3 px step into frame 30;
//                  state.camera = { pos: [x, 0], zoom } (sprites are drawn at (world - camera) × zoom);
//                  MOCK_CAMERA=flat keeps the plain background
//   MOCK_LAG=1     x: the state reacts 3 frames after the press (state.lagged), the picture 5 frames after (a white
//                  square at 300,10), and a beep starts in the press frame's own audio (+1f)
//   MOCK_SOUNDS=1  j plays an 80 ms noise burst, but only on odd presses (a planted cooldown bug); landing plays a
//                  120 ms 660 Hz tone; coins ding. Each sound is announced with an {"event": "sound"} line;
//                  MOCK_SOUNDS=quiet plays the same sounds without the lines (an adapter without sound events).
//   reset params: {"big": true} draws the player with radius 9 instead of 7 (an A/B difference);
//                  {"camera": "hold"} (the reserved camera-hold param) keeps MOCK_CAMERA's camera still
//   MOCK_HAZARD=1  (top-down only) lava from x = 150: the player dies the frame it reaches x >= 150 (snapped to exactly
//                  x = 150), stays dead and still for 10 frames, then respawns at [40, 90]. state.dead / state.deaths.
//                  Holding right from f0: deaths at f55 and f120 (respawns at f65 and f130), both at [150, 90].
//   MOCK_PNG=1     screenshots come back as format "png" (like Unity, or the JS adapter's screenshotFormat "png")
import net from "node:net";
import { encodePNG } from "../src/media/png.js";

const FPS = 60, W = 320, H = 180, SR = 22050;
let rngState = 1, frame = 0, time = 0, queue = [], keys = new Set(), logs = [], audioBuf = [];
let pointer = { x: 0, y: 0, down: false }, fingers = new Map();
let player, coins, score;
// MOCK_LEAK=1: a "particle clock" that reset() forgets, so screenshots depend on earlier runs while the snapshot
// stays identical (the classic leak only screenshot/audio comparison catches)
let leakT = 0;
const JUMP = !!process.env.MOCK_JUMP, LAG = !!process.env.MOCK_LAG, SOUNDS = process.env.MOCK_SOUNDS || "";
let edges = [], freeze = 0, xAt = null, lagged = false, jPresses = 0, coyote = 0, buffer = 0;
const LEDGE = !!process.env.MOCK_LEDGE, CAMERA = !!process.env.MOCK_CAMERA, ALIGN = !!process.env.MOCK_ALIGN;
const ZOOM = +process.env.MOCK_ZOOM || 1;
// MOCK_CAMERA: the camera scrolls 2 px a frame, with one 3 px step (frame 29 → 30): a planted 1 px hitch
const camX = () => (holdCamera ? 0 : 2 * frame + (frame >= 30 ? 1 : 0));
const camY = ZOOM > 1 ? 40 : 0;   // zoomed in, the camera looks a little lower so the coins stay in view
const groundY = (x) => (LEDGE && x >= 200 ? 150 : 90);
const rng = () => { rngState = (rngState * 1103515245 + 12345) & 0x7fffffff; return rngState / 0x7fffffff; };

let bigPlayer = false, holdCamera = false;
const HAZARD = !!process.env.MOCK_HAZARD;
let dead = false, deaths = 0, deadAt = -1;
function reset(seed = 1, params = {}) {
  bigPlayer = !!params.big; holdCamera = params.camera === "hold";
  rngState = seed || 1; frame = 0; time = 0; queue = []; keys = new Set(); audioBuf = []; score = 0;
  pointer = { x: 0, y: 0, down: false }; fingers = new Map();
  player = { id: 1, type: "Player", pos: [40, 90], hp: 3 };
  if (JUMP) Object.assign(player, { vx: 0, vy: 0, grounded: true, jumps: 0 });
  if (ALIGN) player.box = [15, 15];   // matches the 15 px disc it's drawn as
  dead = false; deaths = 0; deadAt = -1;
  edges = []; freeze = 0; xAt = null; lagged = false; jPresses = 0; coyote = 0; buffer = 0;
  coins = Array.from({ length: 5 }, (_, i) => ({ id: 10 + i, type: "Coin", pos: [80 + i * 40, i === 0 ? 90 : 60 + ((seed * 7 + i * 13) % 61)], ...(ALIGN ? { box: [16, 16] } : {}) }));   // MOCK_ALIGN: a hitbox bigger than the 11 px art
}

function stepOnce(dt) {
  for (const e of queue.filter((e) => e.frame <= frame)) {
    if (e.type === "key") { if (e.down && !keys.has(e.key)) edges.push(e.key); e.down ? keys.add(e.key) : keys.delete(e.key); }
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
  const pressed = edges.splice(0);
  if (LAG && pressed.includes("x")) { xAt = frame; addSound(beep(), null); }
  if (LAG && xAt != null && frame - xAt >= 2) lagged = true;
  if (SOUNDS && pressed.includes("j") && ++jPresses % 2 === 1) addSound(burst(), "swing");
  if (JUMP) {
    if (pressed.includes("h")) freeze = 5;
    if (freeze > 0) freeze--;
    else {
      // per-frame units: accelerate 0.5 px/f per frame up to 3 px/f, brake 1 px/f per frame
      if (dx) player.vx = Math.max(-3, Math.min(3, player.vx + 0.5 * dx));
      else player.vx = Math.sign(player.vx) * Math.max(0, Math.abs(player.vx) - 1);
      player.pos[0] = Math.max(0, Math.min(W, player.pos[0] + player.vx));
      const jump = () => { player.vy = -7; player.grounded = false; player.jumps++; coyote = 0; buffer = 0; };
      // walked off the ledge: the floor is gone, coyote time starts (this step and the 4 after it)
      if (player.grounded && groundY(player.pos[0]) > player.pos[1] + 1e-9) { player.grounded = false; player.vy = 0; coyote = 5; }
      if (pressed.includes("space")) { if (player.grounded || coyote > 0) jump(); else buffer = 5; }
      if (!player.grounded) {
        player.pos[1] += player.vy;
        player.vy += 0.4;
        const gy = groundY(player.pos[0]);
        if (player.pos[1] >= gy - 1e-9) {
          player.pos[1] = gy; player.vy = 0; player.grounded = true;
          if (SOUNDS) addSound(tone660(), "land");
          if (buffer > 0) jump();   // a buffered press jumps on landing
        }
      }
      coyote = Math.max(0, coyote - 1); buffer = Math.max(0, buffer - 1);
    }
  } else if (HAZARD && dead) {
    // dead: still for 10 frames, then back at the start
    if (frame + 1 - deadAt >= 10) { dead = false; player.pos = [40, 90]; }
  } else {
    player.pos[0] = Math.max(0, Math.min(W, player.pos[0] + dx * 120 * dt));
    player.pos[1] = Math.max(0, Math.min(H, player.pos[1] + dy * 120 * dt));
    if (HAZARD && player.pos[0] >= 150 - 1e-6) { player.pos[0] = 150; dead = true; deaths++; deadAt = frame + 1; }
  }
  for (const c of [...coins]) {
    if (Math.hypot(c.pos[0] - player.pos[0], c.pos[1] - player.pos[1]) < 12) {
      coins.splice(coins.indexOf(c), 1);
      score++;
      logs.push({ frame, level: "info", message: `coin ${c.id} collected` });
      // ding: a 0.15 s 880 Hz decaying sine starting now
      addSound(Float32Array.from({ length: SR * 0.15 }, (_, i) => Math.sin(2 * Math.PI * 880 * i / SR) * 0.5 * Math.exp(-i / (SR * 0.04))), SOUNDS ? "ding" : null);
    }
  }
  // audio advances with simulated time
  const want = Math.round((time + dt) * SR);
  while (audioBuf.length < want) audioBuf.push(0);
  frame++; time += dt; leakT++;
  if (process.env.MOCK_CRASH_AT && frame === +process.env.MOCK_CRASH_AT) logs.push({ frame, level: "error", message: "boom: something broke" });
}

// a sound starts at the current simulated time (the start of the frame being stepped)
function addSound(samples, name) {
  const start = audioBuf.length;
  for (let i = 0; i < samples.length; i++) audioBuf[start + i] = (audioBuf[start + i] || 0) + samples[i];
  if (name && SOUNDS !== "quiet") sock.write(JSON.stringify({ event: "sound", name, frame }) + "\n");
}
let noiseSeed = 7;
function burst() {   // 80 ms of noise, 1 ms attack, decaying
  const n = Math.round(SR * 0.08), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { noiseSeed = (noiseSeed * 1103515245 + 12345) & 0x7fffffff; out[i] = ((noiseSeed / 0x7fffffff) * 2 - 1) * 0.5 * Math.min(1, i / (SR * 0.001)) * Math.exp(-i / (SR * 0.03)); }
  return out;
}
const tone660 = () => Float32Array.from({ length: Math.round(SR * 0.12) }, (_, i) => Math.sin(2 * Math.PI * 660 * i / SR) * 0.4 * Math.min(1, i / (SR * 0.002)) * (1 - i / (SR * 0.12)));
const beep = () => Float32Array.from({ length: Math.round(SR * 0.1) }, (_, i) => Math.sin(2 * Math.PI * 440 * i / SR) * 0.4 * (1 - i / (SR * 0.1)));

function screenshot() {
  const px = Buffer.alloc(W * H * 4);
  const put = (x, y, r, g, b) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; };
  const cam = CAMERA ? camX() : 0;
  if (CAMERA && process.env.MOCK_CAMERA !== "flat") {
    // a textured world (4×4 blocks) seen through the camera, so scrolling is visible
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const h = (Math.imul((x + cam) >> 2, 73856093) ^ Math.imul(y >> 2, 19349663)) >>> 0; put(x, y, 20 + (h & 63), 24 + ((h >> 6) & 63), 40 + ((h >> 12) & 63)); }
  } else for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, 20, 24, 40);
  // screen = (world - camera) × zoom; MOCK_ALIGN draws coin 12 six screen pixels left of its state position
  const blob = (p, r, c, dx = 0) => { const R = r * ZOOM, sx = Math.round((p[0] - cam) * ZOOM) + dx, sy = Math.round((p[1] - (CAMERA ? camY : 0)) * ZOOM); for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) if (x * x + y * y <= R * R) put(sx + x, sy + y, ...c); };
  coins.forEach((c) => blob(c.pos, 5, [255, 210, 60], ALIGN && c.id === 12 ? -6 : 0));
  blob(player.pos, bigPlayer ? 9 : 7, [80, 200, 255]);
  if (process.env.MOCK_LEAK) put(2, 2, leakT % 256, 0, 0);
  if (LAG && xAt != null && frame - xAt >= 5) for (let y = 10; y < 20; y++) for (let x = 300; x < 310; x++) put(x, y, 255, 255, 255);
  if (process.env.MOCK_PNG) return { width: W, height: H, format: "png", data: Buffer.from(encodePNG(W, H, px)).toString("base64") };
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
      case "reset": reset(m.seed, m.params || {}); audioSent = 0; noiseSeed = 7; reply({}); break;
      case "input": queue.push(...m.events); reply({}); break;
      case "step": { const n = m.frames || 1; for (let i = 0; i < n; i++) stepOnce(m.dts ? m.dts[i] : m.dt || 1 / FPS); reply({ frame, time }); break; }
      case "snapshot": reply({ frame, time, state: { score, scene: "level1", player, pointer, touches: fingers.size, entities: [player, ...coins], ...(LAG ? { lagged } : {}), ...(HAZARD ? { dead, deaths } : {}), ...(CAMERA ? { camera: { pos: [camX(), camY], zoom: ZOOM } } : {}) } }); break;
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
