// Witness play: `witness play suggest` probes a game and proposes a "play" config for witness.json.
// For each candidate key: reset, hold it for 0.35 s, compare the snapshot with an idle run. Position changes give the
// movement keys (and which way is north); fields that flip (attacking, blocking, dodging, onGround...) suggest
// attack/block/dodge/jump. It also reports which snapshot conventions the game follows.
import fs from "node:fs";
import path from "node:path";
import { openGame } from "../core/launch.js";
import { begin, stepTo } from "../core/runner.js";
import { rawPos, Perceiver } from "./perceive.js";
import { checkSnapshot, checkLines, looksTurnBased } from "./check.js";
import { resolvePlayConfig } from "./config.js";

const DEFAULT_KEYS = ["w", "a", "s", "d", "up", "down", "left", "right", "space", "j", "k", "l", "e", "f", "q", "x", "z", "c", "shift", "enter", "1"];

function playerOf(state) {
  if (state && state.player && typeof state.player === "object") return state.player;
  const ents = state && Array.isArray(state.entities) ? state.entities : [];
  return ents.find((e) => /^(player|hero|you|avatar)$/i.test(String(e.type ?? e.kind ?? ""))) || null;
}
const flat = (o, pre = "", out = {}) => { if (!o || typeof o !== "object") return out; for (const [k, v] of Object.entries(o)) { if (v && typeof v === "object" && !Array.isArray(v)) flat(v, `${pre}${k}.`, out); else if (typeof v !== "object") out[`${pre}${k}`] = v; } return out; };

export async function suggest(opt, { loadConfig }) {
  const { cfg, root, file } = loadConfig(opt);
  const seed = opt.seed !== undefined && opt.seed !== true ? +opt.seed : cfg.seed ?? 1;
  const scene = opt.scene && opt.scene !== true ? String(opt.scene) : undefined;
  let params; if (opt.params && opt.params !== true) params = JSON.parse(String(opt.params));
  const g = await openGame(cfg, root, { quiet: true });
  const S = g.session, fps = S.fps;
  const notes = [], play = { ...(cfg.play || {}) };
  const writePlay = (pl) => {
    const f = file || path.join(root, "witness.json");
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.play = pl;
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
    console.log(`✔ wrote "play" into ${f}`);
  };
  try {
    if (!S.has("reset")) throw new Error("the adapter has no 'reset': suggest needs it to probe each key from the same start");
    const frames = Math.round(0.4 * fps);
    // two looks per probe: mid-hold (a swing or a dash is visible) and after release (where it moved)
    const mid = Math.max(1, Math.round(0.05 * fps));
    const probe2 = async (input) => { const st = await begin(S, { seed, scene, params, input }); await stepTo(S, st, mid); const a = (await S.snapshot()).state || {}; await stepTo(S, st, frames); return [a, (await S.snapshot()).state || {}]; };
    const [idleMid, idle] = await probe2(undefined);
    const st0 = await begin(S, { seed, scene, params }); const start = (await S.snapshot()).state || {}; void st0;
    // a turn-based / card / menu game (choices or whose turn, no player position): nothing to probe with movement keys
    if ((play.profile ? resolvePlayConfig(play, {}).profile === "turn" : looksTurnBased(idle) || looksTurnBased(start))) {
      const st = looksTurnBased(idle) ? idle : start;
      play.profile = "turn";
      if (!play.show) { const fields = new Perceiver(resolvePlayConfig(play, {}), { fps }).pickFields(st).map((f) => f.label); if (fields.length) play.show = fields; }
      console.log(`Suggested "play" config for ${S.hello.name || cfg.name} (a turn-based / card / menu game: it lists choices or whose turn it is, and has no player position):\n`);
      console.log(JSON.stringify({ play }, null, 2));
      console.log("\nPlaytest-ready snapshot (docs/PLAYTEST.md):");
      for (const l of checkLines(checkSnapshot(st, "turn"))) console.log(l);
      console.log(`\nHow a pick reaches the game: a choice's own "key", else play.pick ({"call": "<game function>"} gets the choice's id; "click" clicks its rect), else its number key. Reference: docs/PLAYTEST.md`);
      if (opt.write) writePlay(play);
      return;
    }
    const P0 = playerOf(idle);
    if (!P0) notes.push("✖ no player found (state.player or an entity typed Player): set play.player to an expression, e.g. \"state.hero\"");
    const keys = (S.hello.keys && S.hello.keys.length ? S.hello.keys : DEFAULT_KEYS).map((k) => String(k).toLowerCase()).slice(0, 30);
    const moves = [], flips = {};
    const base = flat(P0 || {}), baseMid = flat(playerOf(idleMid) || {}), baseTop = flat(idle);
    for (const k of keys) {
      const [sm, s] = await probe2(`${k}@0-0.35`);
      const pm = playerOf(sm);
      if (pm) for (const [f, v] of Object.entries(flat(pm))) if (typeof v === "boolean" && baseMid[f] !== v && v) { (flips[f] = flips[f] || []); if (!flips[f].includes(k)) flips[f].push(k); }
      const p = playerOf(s);
      if (P0 && p) {
        const a = rawPos(P0), b = rawPos(p);
        if (a && b) {
          const d = b.map((v, i) => v - (a[i] || 0));
          const mag = Math.hypot(...d);
          if (mag > 1e-3) moves.push({ key: k, d, mag });
        }
        const fp = flat(p);
        for (const [f, v] of Object.entries(fp)) if (typeof v === "boolean" && base[f] !== v && v) { (flips[f] = flips[f] || []); if (!flips[f].includes(k)) flips[f].push(k); }
      }
      const ft = flat(s);
      if (ft["dialogue.text"] !== undefined && baseTop["dialogue.text"] === undefined) (flips.dialogue = flips.dialogue || []).push(k);
    }
    // ---- profile
    const pos0 = P0 ? rawPos(P0) : null;
    const is3d = pos0 && pos0.length >= 3 && P0 && (Array.isArray(P0.look) || P0.yaw != null);
    const sideView = P0 && (P0.onGround != null || P0.grounded != null) && !is3d;
    const profile = play.profile || (is3d ? "fps" : sideView ? "platformer" : "topdown");
    play.profile = profile;
    // ---- movement keys from the probe
    const plane = profile === "fps" ? [0, 2] : [0, 1];
    const dirOf = (m) => { const x = m.d[plane[0]] || 0, y = m.d[plane[1]] || 0; return Math.abs(x) >= Math.abs(y) ? (x > 0 ? "right" : "left") : (y > 0 ? "+y" : "-y"); };
    const by = {};
    const dodgeKeys = new Set(Object.entries(flips).filter(([f]) => /^(dodging|dodge|rolling|dashing)$/i.test(f.split(".").pop())).flatMap(([, ks]) => ks));
    for (const m of moves.sort((a, b) => b.mag - a.mag)) { if (dodgeKeys.has(m.key)) continue; const dname = dirOf(m); (by[dname] = by[dname] || []).push(m.key); }
    const yUpKey = (by["-y"] || []).find((k) => /^(w|up|z)$/.test(k)) ? "-y" : (by["+y"] || []).find((k) => /^(w|up|z)$/.test(k)) ? "+y" : null;
    if (profile !== "fps" && yUpKey === "+y") { play.north = "+y"; notes.push("the up key moves +y, so north is +y (y-up world)"); }
    const upList = yUpKey === "+y" ? by["+y"] : by["-y"], downList = yUpKey === "+y" ? by["-y"] : by["+y"];
    const pref = (list, wanted) => (list || []).find((k) => wanted.includes(k)) || (list || [])[0];
    const controls = { ...(play.controls || {}) };
    if (!controls.move) {
      const L = by.left, R = by.right;
      if (profile === "platformer") controls.move = { left: pref(L, ["left", "a"]), right: pref(R, ["right", "d"]), down: pref(downList, ["down", "s"]) };
      else if (["w", "a", "s", "d"].every((k) => (upList || []).concat(downList || [], L || [], R || []).includes(k))) controls.move = "wasd";
      else if (["up", "down", "left", "right"].every((k) => (upList || []).concat(downList || [], L || [], R || []).includes(k))) controls.move = "arrows";
      else controls.move = { up: pref(upList, ["w", "up"]), down: pref(downList, ["s", "down"]), left: pref(L, ["a", "left"]), right: pref(R, ["d", "right"]) };
      for (const [k, v] of Object.entries(controls.move)) if (v === undefined) delete controls.move[k];
    }
    const flipKey = (re) => { for (const [f, ks] of Object.entries(flips)) if (re.test(f.split(".").pop())) return ks[0]; return null; };
    const guess = { attack: flipKey(/^(attacking|attack|swinging|shooting|firing|punching)$/i), block: flipKey(/^(blocking|block|guarding|shielding|parrying)$/i), dodge: flipKey(/^(dodging|dodge|rolling|dashing|invulnerable)$/i) };
    for (const [k, v] of Object.entries(guess)) if (v && !controls[k]) controls[k] = v;
    if (profile === "platformer" && !controls.jump) {
      const jumpers = (by["-y"] || []).filter((k) => !Object.values(controls.move || {}).includes(k));
      const jk = ["z", "space", "k", "c", "up", "w"].find((k) => jumpers.includes(k)) || jumpers[0] || ["z", "space", "up", "w"].find((k) => keys.includes(k));
      if (controls.move && typeof controls.move === "object" && !controls.move.down && keys.includes("down")) controls.move.down = "down";
      if (jk) controls.jump = jk;
      if (!controls.run) { const rk = ["x", "shift"].find((k) => keys.includes(k)); if (rk) controls.run = rk; }
    }
    if (flips.dialogue && !controls.interact) controls.interact = flips.dialogue[0];
    if (!controls.interact && keys.includes("e")) controls.interact = "e";
    play.controls = controls;
    // ---- conventions report
    const conv = checkSnapshot(idle, profile);
    const out = { play };
    console.log(`Suggested "play" config for ${S.hello.name || cfg.name} (probed ${keys.length} keys from seed ${seed}${scene ? `, scene ${scene}` : ""}):\n`);
    console.log(JSON.stringify(out, null, 2));
    console.log("\nPlaytest-ready snapshot (docs/PLAYTEST.md):");
    for (const l of checkLines(conv)) console.log(l);
    if (moves.length) console.log(`\nKeys that moved the player: ${moves.map((m) => `${m.key} (${dirOf(m)})`).join(", ")}`);
    if (Object.keys(flips).length) console.log(`Fields switched on by a key: ${Object.entries(flips).map(([f, ks]) => `${f} ← ${ks.join("/")}`).slice(0, 10).join(", ")}`);
    for (const n of notes) console.log(n);
    if (!moves.length) console.log("No key moved the player from this start (a title screen? use --scene / --params to start in gameplay).");
    console.log("\nCheck it, then add or adjust anything the probe can't see (heal, dialogue choose mode, reach, cell). Reference: docs/PLAYTEST.md");
    if (opt.write) writePlay(play);
  } finally {
    await g.stop();
  }
}
