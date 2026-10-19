// "Coins", the standard Witness sample game (docs/ADAPTERS.md), as a headless Node game.
//   witness mode:  WITNESS_ADDR=127.0.0.1:<port> node game.mjs   (the witness CLI does this)
//   normal play:   node game.mjs   (a terminal game: arrows/WASD move, m marks a moment, q quits;
//                  without a terminal it runs a 2-second scripted real-time demo instead)
//   record a run:  WITNESS_RECORD=witness/replays/run.jsonl node game.mjs
import witness from "../../adapters/js/witness.js";

const W = 320, H = 180, FPS = 60, SR = 22050, SPEED = 120;
let player, coins, score;
const held = new Set();
const mixer = witness.createMixer({ sampleRate: SR });

// A 0.15 s 880 Hz decaying sine, played whenever a coin is collected.
const DING = Float32Array.from({ length: Math.round(SR * 0.15) }, (_, i) => Math.sin((2 * Math.PI * 880 * i) / SR) * 0.5 * Math.exp(-i / (SR * 0.04)));

function reset({ seed = 1 } = {}) {
  held.clear();
  score = 0;
  player = { id: 1, type: "Player", pos: [40, 90], hp: 3 };
  coins = Array.from({ length: 5 }, (_, i) => ({ id: 10 + i, type: "Coin", pos: [80 + i * 40, i === 0 ? 90 : 60 + ((seed * 7 + i * 13) % 61)] }));
}

function input(ev) {
  if (ev.type === "key") { if (ev.down) held.add(ev.key); else held.delete(ev.key); }
  if (ev.type === "action" && ev.action === "dash" && ev.down) player.pos[0] += 30;
  return true;
}

function step(dt) {
  const dx = (held.has("right") || held.has("d") ? 1 : 0) - (held.has("left") || held.has("a") ? 1 : 0);
  const dy = (held.has("down") || held.has("s") ? 1 : 0) - (held.has("up") || held.has("w") ? 1 : 0);
  player.pos[0] = Math.max(0, Math.min(W, player.pos[0] + dx * SPEED * dt));
  player.pos[1] = Math.max(0, Math.min(H, player.pos[1] + dy * SPEED * dt));
  for (const c of [...coins]) {
    if (Math.hypot(c.pos[0] - player.pos[0], c.pos[1] - player.pos[1]) < 12) {
      coins.splice(coins.indexOf(c), 1);
      score++;
      witness.log(`coin ${c.id} collected`);
      mixer.play(DING);
      witness.sound("coin");   // named in witness listen (docs/PROTOCOL.md: sound events)
    }
  }
}

function snapshot() {
  return { score, scene: "level1", player, entities: [player, ...coins] };
}

function screenshot() {
  const px = new Uint8Array(W * H * 4);
  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, 20, 24, 40);
  const blob = (p, rad, [r, g, b]) => {
    for (let y = -rad; y <= rad; y++) for (let x = -rad; x <= rad; x++) if (x * x + y * y <= rad * rad) put(Math.round(p[0]) + x, Math.round(p[1]) + y, r, g, b);
  };
  coins.forEach((c) => blob(c.pos, 5, [255, 210, 60]));
  blob(player.pos, 7, [80, 200, 255]);
  return { width: W, height: H, format: "rgba8", data: px };
}

const calls = {
  teleport: { args: "x y", help: "move the player", run: (x, y) => { player.pos = [+x, +y]; return player.pos; } },
  addcoin: { args: "x y", help: "add a coin, returns the coin count", run: (x, y) => { coins.push({ id: 100 + coins.length, type: "Coin", pos: [+x, +y] }); return coins.length; } },
};

reset({ seed: witness.seed() });
await witness.start({
  name: "Coins (Node)", fps: FPS, size: [W, H], keys: ["up", "down", "left", "right", "w", "a", "s", "d"],
  reset, input, step, snapshot, screenshot, calls, scope: () => ({ player, coins, score }),
});

if (!witness.active()) { if (process.stdin.isTTY) playInTerminal(); else demo(); }

// ------------------------------------------------------------------ scripted real-time demo
// Holds "right" for 1.2 s with real (irregular) frame times and marks 0.5 s, like a player would.
// With WITNESS_RECORD set, 'witness replay' must land on exactly the position printed here.
function demo() {
  const start = performance.now();
  let last = start, marked = false, pressed = false, released = false;
  const tick = () => {
    const now = performance.now(), t = (now - start) / 1000, events = [];
    if (!pressed) { pressed = true; events.push({ type: "key", key: "right", down: true }); }
    if (!released && t >= 1.2) { released = true; events.push({ type: "key", key: "right", down: false }); }
    if (!marked && t >= 0.5) { marked = true; witness.mark("F8"); }
    events.forEach(input);
    const dt = witness.recordFrame(Math.min((now - last) / 1000, 0.1), events);
    last = now;
    step(dt);
    if (t < 2) setTimeout(tick, 16 + (Math.floor(t * 1000) % 3));   // uneven on purpose
    else console.log(`demo done: player=(${player.pos[0].toFixed(4)}, ${player.pos[1].toFixed(4)}) score=${score} seed=${witness.seed()}`);
  };
  tick();
}

// ------------------------------------------------------------------ normal play (a terminal game)
function playInTerminal() {
  const KEYMAP = { "\u001b[A": "up", "\u001b[B": "down", "\u001b[C": "right", "\u001b[D": "left", w: "w", a: "a", s: "s", d: "d" };
  const until = new Map();   // terminals send presses but no releases: hold each key briefly
  let pending = [];
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (k) => {
    if (k === "q" || k === "\u0003") quit();
    if (k === "m") witness.mark("m");
    const name = KEYMAP[k];
    if (!name) return;
    if (!held.has(name)) pending.push({ type: "key", key: name, down: true });
    until.set(name, performance.now() + 160);
  });
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    for (const [name, t] of until) if (now >= t) { until.delete(name); pending.push({ type: "key", key: name, down: false }); }
    const events = pending;
    pending = [];
    events.forEach(input);
    const dt = witness.recordFrame(Math.min((now - last) / 1000, 0.1), events);
    last = now;
    step(dt);
    draw();
  }, 1000 / FPS);
  function draw() {
    const cols = 64, rows = 18, grid = Array.from({ length: rows }, () => Array(cols).fill("·"));
    const at = (p, ch) => { const x = Math.min(cols - 1, Math.floor((p[0] / W) * cols)), y = Math.min(rows - 1, Math.floor((p[1] / H) * rows)); grid[y][x] = ch; };
    coins.forEach((c) => at(c.pos, "o"));
    at(player.pos, "@");
    process.stdout.write(`\u001b[H\u001b[2J COINS  score ${score}   arrows/WASD move · q quits${witness.recording() ? " · recording (m marks)" : ""}\n${grid.map((r) => r.join("")).join("\n")}\n`);
  }
  function quit() {
    clearInterval(timer);
    process.stdout.write("\nbye\n");
    process.exit(0);
  }
}
