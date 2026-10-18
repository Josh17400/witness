// "Coins", the standard Witness sample game (docs/ADAPTERS.md), as an ordinary canvas game.
// Nothing below is written for Witness except the import and the start() call at the end:
// the game keeps its own requestAnimationFrame loop, keyboard listeners and WebAudio sound,
// and the adapter makes all of it deterministic and steppable in witness mode.
import witness from "./witness/witness.js";

const W = 320, H = 180, SPEED = 120;
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const hud = document.getElementById("score");

// ---- input: plain DOM listeners -------------------------------------------------------------
const NAMES = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
const held = new Set();
addEventListener("keydown", (e) => {
  const k = NAMES[e.key] || e.key.toLowerCase();
  if (["left", "right", "up", "down", "w", "a", "s", "d"].includes(k)) { held.add(k); e.preventDefault(); }
  if (audio.state === "suspended") audio.resume();
});
addEventListener("keyup", (e) => held.delete(NAMES[e.key] || e.key.toLowerCase()));
addEventListener("blur", () => held.clear());

// ---- sound: WebAudio --------------------------------------------------------------------------
const audio = new AudioContext();
function ding() {
  const t = audio.currentTime;
  const osc = audio.createOscillator(), gain = audio.createGain();
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.5, t);
  gain.gain.exponentialRampToValueAtTime(0.0025, t + 0.15);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + 0.15);
}

// ---- the game ---------------------------------------------------------------------------------
let player, coins, score;

function reset(seed) {
  held.clear();
  score = 0;
  player = { id: 1, type: "Player", pos: [40, 90], hp: 3 };
  coins = Array.from({ length: 5 }, (_, i) => ({ id: 10 + i, type: "Coin", pos: [80 + i * 40, i === 0 ? 90 : 60 + ((seed * 7 + i * 13) % 61)] }));
}

function update(dt) {
  const dx = (held.has("right") || held.has("d") ? 1 : 0) - (held.has("left") || held.has("a") ? 1 : 0);
  const dy = (held.has("down") || held.has("s") ? 1 : 0) - (held.has("up") || held.has("w") ? 1 : 0);
  player.pos[0] = Math.max(0, Math.min(W, player.pos[0] + dx * SPEED * dt));
  player.pos[1] = Math.max(0, Math.min(H, player.pos[1] + dy * SPEED * dt));
  for (const c of [...coins]) {
    if (Math.hypot(c.pos[0] - player.pos[0], c.pos[1] - player.pos[1]) < 12) {
      coins.splice(coins.indexOf(c), 1);
      score++;
      console.log(`coin ${c.id} collected`);
      ding();
    }
  }
}

function render() {
  ctx.fillStyle = "rgb(20, 24, 40)";
  ctx.fillRect(0, 0, W, H);
  const blob = (p, r, color) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.fill(); };
  for (const c of coins) blob(c.pos, 5, "rgb(255, 210, 60)");
  blob(player.pos, 7, "rgb(80, 200, 255)");
  hud.textContent = String(score);
}

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  update(dt);
  render();
  requestAnimationFrame(frame);
}

reset(witness.seed());
requestAnimationFrame(frame);
globalThis.coins = { state: () => ({ score, player }) };   // for record-check.mjs

// ---- Witness ----------------------------------------------------------------------------------
await witness.start({
  name: "Coins (browser)",
  fps: 60,
  size: [W, H],
  canvas,
  keys: ["up", "down", "left", "right", "w", "a", "s", "d"],
  reset: ({ seed }) => reset(seed),
  snapshot: () => ({ score, scene: "level1", player, entities: [player, ...coins] }),
  calls: {
    teleport: { args: "x y", help: "move the player", run: (x, y) => { player.pos = [+x, +y]; return player.pos; } },
    addcoin: { args: "x y", help: "add a coin, returns the coin count", run: (x, y) => { coins.push({ id: 100 + coins.length, type: "Coin", pos: [+x, +y] }); return coins.length; } },
  },
  scope: () => ({ player, coins, score, held, audio }),
});
