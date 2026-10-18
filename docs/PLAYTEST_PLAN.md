# Agent playtest harness — plan

Status: **plan (Phase 1)**, written 2026-10-18 before the build. The shipped behaviour is described in
[PLAYTEST.md](PLAYTEST.md). Where the two disagree, PLAYTEST.md and the code win. This file keeps the reasoning.

## 0. Goal in one paragraph

A cheap, fast Claude model (Haiku 5.5, or Sonnet 5.5 at low effort) should be able to **play** a game under
development and report back to the main working agent: walk around walls instead of into them, win fights by
reacting to attack telegraphs, talk to NPCs, pick dialogue options, finish a goal, and then report what happened and
what it thought. Witness can make this work because **the game only advances when Witness says `step`**. The game is
frozen while the model thinks, so even a slow model plays "in real time" from the game's point of view, and every
frame is accounted for. The model gives orders. A fast deterministic **reflex layer** inside Witness carries them out
frame by frame. Everything that reaches the game is ordinary recorded input, so every playtest is also a
frame-exact **replay**.

## 1. Architecture

```
 main Claude ──Agent tool (model: haiku | sonnet-low)──▶ tester subagent
                                                          │  Bash, one short command at a time
                                                          ▼
   witness play start|look|do|shot|note|end ──HTTP (127.0.0.1, token)──▶ play daemon (one per session, detached)
                                                                           │
          ┌────────────────────────────────────────────────────────────────┤
          │  perception  snapshot ─▶ world model (player, things, dialogue, map, goal)
          │  events      world(t-1) vs world(t) ─▶ hurt/hit/killed/appeared/picked/dialogue/stuck/…
          │  orders      "fight wolf block; then talk guard" ─▶ order queue (parser with suggestions)
          │  autopilot   behaviours + reflexes ─▶ held controls ─▶ protocol input events at exact frames
          │  profiles    topdown | platformer | fps  (locomotion + aiming)
          │  nav         occupancy grid (game map and/or learned from bumping), A*, frontier exploration
          │  recorder    replay.jsonl (protocol §5) + marks + calls, end state for `witness replay`
          │  report      timeline, fights, stuck incidents, deaths, coverage, shots, errors, tester feedback
          └───────────────────────────────────▶ game (Witness adapter, protocol v1, unchanged)
```

* **The daemon is the only client of the game.** It owns the `Session` (`src/core/session.js`), launched through the
  normal `openGame` (hidden window, `witness.json` `launch`). It runs the reflex loop:
  `input(events at frame F) → step(k frames, dts) → snapshot → perceive → events → decide`, with k = 1–4 frames.
* **CLI commands are thin HTTP clients.** Each `witness play …` call reads the session's port and token from the
  session registry, sends one JSON request and prints the reply. Node startup plus one localhost request takes
  about 0.1 s, against 3–20 s of model thinking per turn.
* **Nothing new in the protocol is required.** Everything uses v1 commands (`reset`, `input`, `step`, `snapshot`,
  `screenshot`, `logs`, `call`). The harness gets much better when the game follows a few optional **snapshot
  conventions** (section 7). One optional replay-file extension is CLI-side only (§8.2).

### 1.1 Files

| file | role |
|---|---|
| `src/play/config.js` | normalise `witness.json` → `play`, defaults by convention, profile defaults, control parsing |
| `src/play/perceive.js` | snapshot → world model (player, things with relation/kind, dialogue, map, goal, stats, outcome) |
| `src/play/grid.js` | NavGrid: map-derived and learned blocked cells, A*, line of sight, frontier, visited/coverage |
| `src/play/orders.js` | order language parser (forgiving, synonyms, did-you-mean), target resolution |
| `src/play/autopilot.js` | behaviours (goto, fight, flee, talk, choose, pickup, explore, follow, wait, press/hold, combo…), reflexes (guard, heal, retreat), stuck detection, controller (held set → events) |
| `src/play/profiles.js` | locomotion and aiming per profile: topdown, platformer, fps |
| `src/play/events.js` | notable-event detection between world models; fight/encounter and telegraph tracking |
| `src/play/observe.js` | compact text observation (+ JSON form) |
| `src/play/report.js` | report.json + report.md + coverage.png |
| `src/play/daemon.js` | the session host: game, reflex loop, recorder, HTTP API, idle/max/game-death shutdown |
| `src/play/client.js` | `witness play` subcommands, session registry, process cap, `brief`, `suggest` |
| `src/play/brief.js` | tester prompt + personas |
| `src/play/suggest.js` | probe a game and suggest a `play` config |
| `examples/arena/` | the new sample game (JS/Node, adapters/js) with walls, telegraphed enemies, NPC dialogue, pickups, a goal |
| `skills/witness-playtester/SKILL.md` | the tester's skill (the brief is the primary channel; the skill mirrors it) |
| `docs/PLAYTEST.md` | user-facing reference: commands, orders, config, conventions, reports |

## 2. CLI and daemon surface

```
witness play start [--name t1] [--goal "…"] [--persona newbie|explorer|speedrunner|breaker|fighter]
                   [--seed N] [--scene S] [--params JSON] [--minutes 20] [--idle 300] [--allow-calls]
                   [--out DIR] [--cmd "<launch>"] [--json]      → starts game + daemon, prints the first observation
witness play look  [-s t1] [--shot] [--json]                   → observation now (no game time passes)
witness play do "<orders>" [-s t1] [--for SECONDS] [--json]    → runs orders until done / interrupted / time cap
witness play shot  [-s t1] [--scale 2]                          → PNG path (open it with the Read tool)
witness play note "<text>" [--bug|--confusing|--fun|--idea] [--shot] [-s t1]   → timeline + replay mark
witness play end   [-s t1] [--fun 1-5] [--difficulty 1-5] [--feedback "…"]       → writes the report, stops everything
witness play status|list [--clean]|stop [-s t1|--all]|report [t1|dir] [--json]
witness play brief [--goal …] [--persona …] [--minutes 3] [--name t1] [--model haiku]   → prompt for the subagent
witness play suggest [--write]                                   → probe the game, propose a "play" config
witness play orders                                              → the order language card
```

* **Sessions and the registry.** A session has a name (`--name`, default `play-<time>`), a folder
  `witness/playtests/<name>/` in the project, and a registry entry in `<tmpdir>/witness-play/<name>.json`
  (pid, port, token, dir). Commands find the session by `-s <name>`. Without `-s`, the only live session is used,
  else the most recent one. So a subagent's commands work from any working directory.
* **Process cap.** `start` counts live sessions machine-wide through the registry (pid checks) and refuses a new one
  above `WITNESS_PLAY_MAX` (default 2, i.e. 2 games + 2 light daemons) unless `--force`. This respects this
  machine's hard limit of about 3 game processes.
* **Lifetime.** The daemon exits, after writing the report, on: `end`/`stop`; idle timeout (default 300 s without
  a command); max wall time (default 20 min); the game exiting or disconnecting (crash noted in the report);
  SIGINT/SIGTERM; an internal error (report written best-effort, error logged to `daemon.log`). It is spawned
  `detached` with `windowsHide` and stdio redirected to `daemon.log`, so the Bash tool returns at once and no window
  appears. `witness play list --clean` / `stop --all` kill anything stale.
* **Exit codes.** 0 for a command that ran (even if the order failed in game; the text says so), 2 for an order that
  didn't parse (nothing happened in the game), 1 for session or daemon errors.

### Why not an MCP server (evaluated, deferred)

An MCP server would save the ~0.1 s CLI startup per call and give typed tool schemas. But a plugin-declared MCP server
starts with every Claude Code session and stays alive (against the "never leave processes running" rule). The time
it saves is noise next to model latency. And a Bash CLI works with *any* subagent and any harness. So Bash is the
interface; an opt-in `witness play mcp` stdio server can wrap the same client later if it ever pays off.

## 3. Determinism and replays

* The daemon steps with explicit `dts` (`1/fps` per frame), exactly as `witness replay` does. So the live session
  and its replay go through the same adapter path, and float differences between a default dt and a JSON dt can't
  creep in.
* Every input event goes to the game with an absolute frame ≥ the current frame, and is recorded at that frame.
  The model's thinking time does not exist in game time. Between `do`s, nothing steps.
* `replay.jsonl` is a standard protocol §5 file: header `{replay:1, name, seed, fps, scene, params, started,
  source:"witness play", session}` followed by sparse frame lines `{f, dt, in?, mark?, calls?}`. The last stepped
  frame always gets a line, so the replay steps exactly as many frames as the session did. Events scheduled for
  frames that never ran (a key release planned after the last step) are dropped from the file. Marks made after the
  last step clamp to the last frame.
* At the end the daemon writes `replay.jsonl.state.json` (the final snapshot). `witness replay <file>` then proves
  the session replays field by field: "✔ the replay ended in exactly the recorded end state".
* The autopilot itself uses no wall clock and no unseeded randomness. Tie-breaks are deterministic, though the
  replay doesn't depend on the autopilot anyway.
* `call` orders (cheats/setup) are off for testers by default (`--allow-calls`). When allowed they are recorded as
  `calls: [[name, ...args]]` on the frame line, and `witness replay` runs them at that frame (§8.2). The daemon always
  steps at least one frame after a call, so a call never lands after the last recorded frame.

## 4. Observation format

Small enough for Haiku to read every turn (typically 0.6–1.2 KB, about 200–350 tokens). Positions and distances
are in **map cells** (the nav grid unit: 1 tile for tile games, `play.cell` otherwise), compass directions use
screen north (up), and things are named exactly as orders accept them (`Wolf#5`, `Guard`, `Potion`).

Top-down example (arena, after an interrupted `explore east`):

```
[t 14.2s] hp 6/10 · potions 1 · gold 2 · cell (12,7) facing E
goal: Get the gate key from the Alpha Wolf, then open the gate (east).
⚠ interrupted: Wolf#5 appeared 5 cells NE — explore east ran 3.1s (+18 cells)
near:
  Wolf#5     5.0 NE  hp 3/3  chasing you
  Wolf#6     7.2 E   hp 3/3
  Coin#31    2.0 S   item
  Gate#40   15.3 E   locked
map (@ you, # wall, . floor, ? unknown, letters = things; N up):
  ?#####?????????
  ?#...#....w.???
  ##.@.....W....?
  ?#.c.#######..?
events: 13.1 you picked up Coin#30 · 13.9 game: "You hear howling to the east."
```

In combat, the line for a telegraphing enemy says `WINDUP 0.3s`, and the result line tells what happened:

```
[t 22.9s] hp 8/10 · potions 1 · gold 2 · cell (20,5) facing E
✔ done: fight Wolf#5 block — Wolf#5 killed in 2.6s (dealt 3, took 0; 2 windups blocked)
near:
  Wolf#6     3.1 E   hp 3/3  WINDUP 0.2s
  AlphaWolf#8 6.4 SE hp 6/6  chasing you
events: 21.0 you blocked Wolf#5 (staggered) · 21.4 you hit Wolf#5 (-2) · 22.8 Wolf#5 died
```

Dialogue:

```
dialogue — Old Guard: "The Alpha Wolf took the gate key. Will you get it back?"
  1) I'll get it back.   2) Not my problem.     (choose 1 / choose 2)
```

Platformer (`profile: platformer`) adds the ground state and a tile window ahead of the player. FPS adds the look
direction, teammates and line of sight:

```
[t 31.0s] hp 74/100 · ammo 18/30 rifle · team 3-2 (first to 10) · pos (4,-7) facing NE, pitch -2°
near:
  Red#6      14.0 NE  hp ?  in sight  (aim off 12°)
  Blue#2      3.2 W   teammate
```

The first observation of a session also prints the order card (section 5). `--json` returns the same content as
data (`{t, frame, player, stats, near[], dialogue, map, events[], result, goal}`), used by tests and scripts.

## 5. The order language

A small, forgiving grammar. It is case-insensitive, with synonyms, ignored filler words ("please", "the", "to"),
and chains with `;`, `then` or newlines. Unknown words get a did-you-mean suggestion. The parser never guesses
wildly. If it can't map the input to an order, it says so and nothing happens in the game.

| order | synonyms | meaning |
|---|---|---|
| `goto <thing>` · `goto x,y` | go to, walk to, move to, approach, head to | path there (walls handled), stop in reach |
| `go <dir> [n]` | move/walk/run north 5, go ne | n cells (default 5) in a compass direction |
| `explore [dir]` | wander, scout, search | frontier exploration of unvisited ground, biased toward dir |
| `follow <thing>` | | keep near it (teammates, NPCs) |
| `fight [thing] [block\|dodge\|backoff\|aggressive] [kite N] [retreat N%]` | attack, kill, engage, hit | approach, face, attack; react to telegraphs |
| `flee` | retreat, run away, back off, escape | move away from hostiles to a safe spot |
| `talk <who>` | talk to, speak to, greet, ask | walk up, face, interact, wait for the dialogue |
| `choose <n\|text>` | pick, select, answer, say | pick a dialogue option (number or words in it) |
| `pickup [thing]` | pick up, get, grab, collect, loot | walk onto / interact with an item (nearest if none named) |
| `use <control\|item>` | drink, heal, interact, open | tap a configured control (`use potion` → heal control) |
| `press <key\|control> [xN]` · `hold <key\|control> <s>` | tap, push | raw input for anything else |
| `jump [left\|right] [short\|long\|high]` · `run <dir> [to x]` · `stomp <thing>` · `wait for <thing>` | | platformer orders |
| `look <dir\|thing>` · `reload` · `weapon <n>` | aim at | fps orders |
| `combo <name>` | special | a frame-exact input sequence from `play.combos` |
| `wait [s]` | idle, pause | let time pass (reflexes stay on) |
| `stop` | halt | release everything |
| `set retreat N \| heal N \| guard on\|off \| reaction S` | | standing policies |
| `call <name> [args]` | | game command; only with `--allow-calls`, recorded in the replay |

Things: a type (`Wolf`, plural `wolves` = all of them), `Type#id`, `#id`, a name (`Old Guard`), or a category
(`nearest enemy`, `item`, `npc`, `teammate`). Matching runs exact → singular → prefix → substring → edit distance
≤ 2. If nothing matches, the error lists what is in view: `✖ no "Dragon" here — in view: Wolf#5, Coin#31, Gate#40`.
Remembered things (seen earlier, now out of view) are targetable: `goto Gate` uses its last known position.

Modifiers anywhere: `for 6s` (time cap), `retreat 30%`, `block|dodge|backoff|aggressive`, `kite 4`, `careful`
(wake on anything). Errors come back as one line plus a hint: `✖ "atack wolf": unknown order "atack" — did you mean
"attack"?`

## 6. Reflex layer (autopilot)

### 6.1 Loop and wake rules

Each tick (k frames: 1 when a hostile is within threat range or a jump is in flight, else `play.tick`, default 3):
1. perceive the snapshot; detect events; update the nav grid (visited cells, map, learned blocks);
2. **reflexes** (in priority order): dead → abort; dialogue open during a movement order → stop and ask; guard
   (react to a telegraph after the human-like `reaction` delay, default 0.25 s); heal below `heal`%; retreat
   below `retreat`%;
3. the current **behaviour** proposes controls: movement intent, held controls, taps, aim;
4. the **profile** turns intent into controls (keys/axes/mouse) and the controller diffs them into protocol events.

A `do` returns when its order chain is done or failed, when a **wake event** fires, or at the time cap (default
6 s of game time for open-ended orders like explore/wait/follow, 20 s for goto/fight). Wake events: hurt (outside a
fight), a hostile entering the alert range (default 6 cells), an unexpected dialogue, low hp (crossing 35% or the
retreat level), death, goal reached, scene change, a game error log, and stuck. During `fight`, being hit and
other enemies joining are not wake events (they're expected), but low hp and death are.

### 6.2 Behaviours and algorithms

* **goto/go:** A* over the nav grid from the player's cell to the target cell. Unknown cells are optimistic
  (treated as free: "planning under the free-space assumption"; it replans as walls are learned, like D* Lite in
  spirit), with a node budget and a straight-line fallback. Steering heads for the farthest path cell in line of
  sight (up to 4 cells ahead), so paths are smooth and diagonal. It arrives inside `reach`.
* **Stuck detection and recovery:** over a 0.4 s window the expected displacement is speed × window. If actual
  progress is < 25% of that, it's *blocked*: mark the cell ahead as blocked (temporary if a thing stands there),
  replan; after two blocks without progress, sidestep perpendicular for 0.3 s; then back off. A stuck incident
  (position, heading, duration, how it was resolved, screenshot) goes to the report. After 3 s with no progress
  toward the target, the order fails with the incident attached. Speed is measured on the fly (or `play.speed`).
  Things that look like stuck but aren't (dialogue/menu open, dead) are reported as what they are.
* **Learned occupancy:** with no map in the snapshot, the grid learns walls from failed movement. With
  `state.map` (section 7), walls are known up front and learning only adds moving blockers. The cell size comes
  from `play.cell`, then the map's cell, then measured speed × 0.2 s.
* **fight:** pick the target (named, else nearest hostile); approach to `reach.attack`; face it (profile-specific:
  tap a move key toward it, aim the mouse, or nothing for omnidirectional attacks); attack (tap every
  `attackEvery`, or hold). **Telegraphs:** when the target or another hostile within reach starts a windup
  (`telegraph` convention), after `reaction` s use the mode: `block` (hold block facing it, then punish in the
  recovery window), `dodge` (dash perpendicular/away when the windup is about to land), `backoff` (step out of
  reach, re-engage after the strike), `aggressive` (ignore). Default: block if a block control exists, else dodge,
  else backoff. `kite N`: hold distance N while attacking (ranged). Plural targets fight on until no such hostile
  remains in the alert range. Ends: won (all dead), lost (died), fled, or target lost.
* **flee:** BFS over free/unknown cells within 10 cells for the cell maximising distance to hostiles minus path
  cost; go there; done when no hostile is within alert × 1.2.
* **talk:** goto the NPC within `reach.interact`, face it, tap interact, wait 0.5 s for `dialogue`; retry once
  closer; fail with "pressed interact next to Guard but no dialogue opened".
* **choose:** `play.choose` = `numbers` (tap "1".."9"), `arrows` (move the cursor from `dialogue.selected`, then
  confirm), or a list of controls. Done when the dialogue changes or closes.
* **pickup:** goto the item within `reach.pickup`; if it's still there after 0.3 s, tap interact; done when it's gone.
* **explore:** frontier exploration over *visited* cells (radius `play.sight`, default 3 cells, around the path),
  scored by distance with a bonus toward the requested direction. With a map, coverage is measured against the map's
  open cells.
* **Platformer profile:** horizontal intent plus `run`; jumps are planned from the tile map ahead (a wall at body
  height → jump, held longer for taller walls; a gap or hazard ahead → running jump, held to the apex; a hostile
  ahead on the same band → jump over it or stomp it), with air steering toward safe ground and stuck recovery
  (no x progress → high jump, then back up and take a run-up). Orders `run right`, `jump right long`, `stomp Goomba`,
  `wait for Koopa`.
* **FPS profile:** the plane is configurable (default x/z for y-up worlds). Movement keys are relative to the look
  direction (forward/back/strafe); turning and aiming use mouse deltas (or look axes). Sensitivity and sign are
  **auto-calibrated** on first use from the look vector or yaw/pitch in the snapshot. `fight` aims at the target's
  centre mass, fires while the aim error is below the target's angular size, strafes on a rhythm, and reloads when
  ammo is empty. It uses line of sight from the snapshot (`los`/`visible`) when available.

### 6.3 Human-likeness knobs

`reaction` (s), `attackEvery`, and an aim speed limit (FPS) make the reflex layer play like a decent human rather
than a frame-perfect bot, so difficulty feedback stays meaningful. Personas adjust them (newbie 0.35 s reaction,
speedrunner 0.18 s). The report's **telegraph stats** ("9 windups: 7 avoided, 2 hit") show whether a windup is
readable at human reaction speed.

## 7. Per-game config and snapshot conventions

All config lives in `witness.json` → `"play"`. Everything has a convention-based default, so the minimal config
for a game that follows the conventions is `{}`.

```jsonc
"play": {
  "profile": "topdown",                       // topdown | platformer | fps
  "controls": {
    "move": "wasd",                           // wasd | arrows | {up,down,left,right} | {axis:["leftx","lefty"]}
    "attack": "j", "attackMode": "tap", "attackEvery": 0.35,   // a control is "j", "key:j", "action:attack", "pad:x", "mouse:left"
    "block": "k", "dodge": "l", "interact": "e", "heal": "q", "confirm": "enter", "cancel": "escape",
    "choose": "numbers"                       // numbers | arrows | ["1","2","3"]
  },
  "player": "state.player",                   // expressions over the snapshot (JS, like test expects)
  "entities": "state.entities",
  "hostile": "e.hostile",                     // per-thing expressions get `e`
  "telegraph": "e.state == 'windup'",
  "reach": { "attack": 1.3, "interact": 1.4, "pickup": 0.6 },   // in cells
  "cell": 16, "alert": 6, "reaction": 0.25, "tick": 3,
  "stats": ["state.player.potions", "state.player.gold"],
  "won": "state.won", "dead": "state.dead",
  "combos": { "fireball": "down@0-0.05, right@0.05-0.12, p@0.1" }
}
```

**Snapshot conventions** (all optional; each one unlocks more):

| convention | unlocks |
|---|---|
| `state.player = {pos, hp, maxHp, facing}` | everything; hp drives retreat/heal/low-hp wakes |
| `state.entities[] = {id, type, pos, name?, hp?, maxHp?}` | targets, near list, events |
| entity `hostile` / `item` / `talk` (or `npc`) / `team` | classification (else type-name heuristics) |
| entity `state: "windup"` or `telegraph: <seconds left>` | blocking/dodging/punishing, telegraph stats |
| `state.dialogue = {speaker, text, options[], selected?}` | talk/choose, dialogue in reports |
| `state.goal` (text or `{text, pos}`), `state.notice` | goal hints in observations |
| `state.map = {cell, origin, rows[], solid?}` | walls known up front (rows of chars, `#` solid by default) |
| `state.won` / `state.dead` | outcome |
| game logs (`witness.log`, info level) | the game's own event text ("You blocked the bite!") in the timeline |
| platformer: player `onGround`, `vel`, `size`; map legend `=` one-way, `^` hazard | jump planning |
| fps: player `look` [x,y,z] or `yaw`/`pitch`, `ammo`, entity `los` | aiming, line of sight, reload |

**What's generic and what needs per-game config:**
* Generic: daemon, sessions, recording/replay, events, report, order parser, nav/stuck/explore, observations, fight
  logic, the brief.
* Per game, usually 5–15 lines: which keys do what (`controls`), where state lives if it doesn't follow conventions,
  the profile, and sometimes ranges and cell size. `witness play suggest` probes the game to propose them: it holds
  each key from `hello.keys` (or a default list) for 0.3 s after a fresh reset and measures what changed (position →
  movement keys and axis signs; `attacking`/`blocking` fields → attack/block; dialogue opened → interact). It also
  finds the state paths (player, hp, entities, dialogue, map) and prints the block, or merges it with `--write`.
* Escape hatch: `play.module` (an ES module next to witness.json) may export `perceive(world, snap)` to patch the
  world model, and extra `orders`. Kept small; documented as advanced.

## 8. Protocol and format additions

1. **None required in protocol v1.** The conventions above go into PROTOCOL.md §3's conventions note, and
   PLAYTEST.md.
2. **Replay `calls` (optional, CLI-side, backward compatible):** a frame line may carry `"calls": [["name", ...args]]`,
   written only by `witness play` when calls were allowed. `witness replay` / `trace --replay` run them when the
   replay reaches that frame, before stepping it. Adapters never write or read it. Old replays are unaffected.

## 9. Report

`witness/playtests/<name>/`: `report.md`, `report.json`, `replay.jsonl` (+ `.state.json`), `shots/*.png` (key
moments: start, goal, deaths, stuck, bugs, first sight of each enemy type; capped at 24), `coverage.png` (the known
map with visited cells, the path, deaths ✕ and stuck points), `daemon.log`.

`report.json`: `{session, game, seed, scene, params, goal, persona, startedAt, wallSeconds, gameSeconds, frames,
outcome: won|died|ended|crashed|timeout|idle, orders[{t, text, result, status, seconds}], timeline[{t, frame, kind,
text}], fights[{targets, start, seconds, result, dealt, taken, kills, windups, avoided, hits}], stuck[{t, cell,
heading, seconds, resolved, how, shot}], deaths[{t, cell, cause}], coverage{cells, openCells?, percent?, bounds},
dialogues[{t, speaker, text, options, chosen}], pickups[], shots[{t, file, why}], errors[], notes[{t, kind, text}],
feedback{fun, difficulty, text}, replay{file, frames, exact?}}`.

`report.md` (what the main agent reads first): the outcome headline, the tester's feedback and bug/confusion notes
(highest value first), then fights, stuck incidents, deaths, coverage, dialogues, game errors, a condensed timeline,
the order list, and the exact `witness replay` command for each marked moment.

## 10. Spawning testers (brief, skills, personas)

* `witness play brief --goal "Escape the arena" --persona newbie --minutes 4 --name t1` prints a complete prompt:
  role, goal, persona, budget, the exact commands with the absolute CLI path, the order card, how to read an
  observation, play tips (telegraphs, failed orders, screenshots), the end protocol (feedback fields) and rules
  (only these commands, one session, always `end`).
* The main agent: `Agent({model: "haiku", prompt: <brief>})`, or `model: "sonnet"` with low effort for harder games.
  When it returns: read `report.md`, open key shots, reproduce marks with `witness replay … --at <t> --shot`, turn
  bugs into tests.
* Personas: **newbie** (follows hints, reports confusion), **explorer** (coverage, talks to everyone, secrets),
  **speedrunner** (fastest route, skips optional things), **breaker** (walls, edges, spam, odd choices; reports
  bugs), **fighter** (seeks fights, judges balance and telegraphs).
* Several testers: different `--name`s as separate sessions, run one or two at a time (`WITNESS_PLAY_MAX`, default 2).
* `skills/witness/SKILL.md` gains "Run an agent playtest". `skills/witness-playtester/SKILL.md` gives a tester the
  same rules if it's pointed at the skill instead of a brief.

## 11. The arena sample game (`examples/arena`)

Coins is too trivial for this. Arena is a small top-down game in JS/Node on adapters/js (runs anywhere Node 18+
runs, no toolchain), built to show the conventions and to prove the harness in CI:

* **Map:** 30×18 tiles of 16 px (480×288): a start room (NPC, potion), a short maze with dead ends and coins, a
  courtyard with wolves, a walled goal room behind a locked gate, an exit tile. Exposed as `state.map`.
* **Player:** hp 10, speed 5 tiles/s, facing = last move direction. Attack `j`/`space` (front arc ±75°, reach
  1.4 tiles, cooldown 0.4 s). Block `k` (held, frontal ±90°: no damage, and the attacker is staggered and takes double
  damage). Dodge `l`/`shift` (short dash with i-frames, cooldown 0.7 s). Interact `e`, potion `q`, dialogue `1`/`2`,
  `enter` respawns after death.
* **Wolves** ×3 (hp 3, bite 2) and the **Alpha Wolf** (hp 6, bite 3, drops the key): chase within 5.5 tiles in line of
  sight; within reach they **wind up** (0.5 s / 0.6 s, `state:"windup"`, `telegraph: <s left>`) then strike, then
  recover. Trading hits with several wolves loses; reading the windups wins.
* **Old Guard** NPC: a dialogue with two options (option 1 gives a potion and sets the quest).
* **Pickups:** potions, coins. **Gate** opens with the key; **Exit** sets `won`.
* Snapshot: `player`, `entities` (with `hostile`, `item`, `talk`, `state`, `telegraph`), `dialogue`, `goal`,
  `notice`, `map`, `won`, `dead`, `digest`. Game events as logs. Screenshots: legible shapes (windups flash).
  Mixer sfx. Calls for test setup. A terminal mode with recording for humans.
* `witness/arena.witness.json`: mechanics tests (walls stop you, windup precedes a bite, block negates and staggers,
  dialogue and options, key opens the gate, exit wins), all deterministic (`doctor` all good, `test --repeat 2`).

## 12. Test plan

* **Unit** (`tests/run.mjs`, no processes): order parser (synonyms, chains, coordinates, modifiers, did-you-mean,
  target matching incl. plurals and remembered things); NavGrid (A* around walls, learned blocks, frontier,
  line of sight); a pure-JS simulated top-down world driving the autopilot (reaches a goal through a maze with no map,
  recovers from a stuck corner, blocks a telegraphed attack after the reaction delay); event detection (hurt, kill,
  pickup, appear, dialogue); observation size budget; replay writer (sparse lines, end clamp, dropped future events,
  calls); config defaults; brief contains the absolute CLI path.
* **E2E mock game:** `play start/do "pickup coin"`×N/`end` via the CLI; report written; `witness replay` → exact end
  state; the daemon exits, and no processes are left (pid check).
* **E2E arena, scripted fake agent** (`tests/play-agent.mjs`): a deterministic script plays the whole arena through
  the CLI (talk → choose 1 → fight the wolves with block → take the key → open the gate → exit). It checks the
  report (outcome won, fights won, a dialogue recorded), that `witness replay` reproduces the final state exactly,
  and that every process exited. It also runs a `--no-map` session to prove learned occupancy gets through the
  maze.
* **CI:** core.yml (ubuntu/windows/macos) runs all of the above, plus `doctor` + `test` in examples/arena.
* **Real model runs (Phase 3):** Haiku and Sonnet-low testers on the arena (iterate on observation/orders/brief),
  then on two real games of the user (below), then optionally Embervale.

## 13. Real games (Phase 3)

Work happens only in %TEMP% copies (no build/dist/__pycache__). The originals get only a new `witness_integration/`
folder (a unified diff + README with the play config and playtest results). Nothing private goes into the witness
repo.

* **Super Xhigh Bros** (pygame-ce platformer): wire adapters/python (`witness.run` around `Game.step()`, seeded RNG,
  `input.virtual`-style injection or key events, `state.map` window of tiles around the player, entities with
  `hostile`, `onGround`, lives/coins/score/level). Profile `platformer`. Haiku plays 1-1, then tries 1-2.
* **Floating Arena 3D** (OpenGL FPS, 4v4 bots): wire adapters/python with a hidden GL window (one GL process at a
  time), fixed-step `step`, snapshot of the player (pos, look/yaw/pitch, hp, ammo, weapon), soldiers
  (team, hp, los), score, plus the nav grid as `state.map`. Profile `fps`, mouse aim with auto-calibration. Haiku
  plays a short match.
* **Embervale** (optional, only if time allows): clone read-only into %TEMP%, build, write a play config
  (`integrations/embervale/play.json` in this repo if it's reusable), one short Haiku run.

## 14. Risks and open questions

* **Snapshot cost on big games.** At 20 decisions per game second a large snapshot (Embervale lists everything within
  40 tiles) is parsed often. Mitigation: `tick` adapts (fast only in combat). The `snapshot` `paths` filter is optional
  in adapters, so it can't be relied on.
* **Learned occupancy limits.** Thin collision shapes, one-way doors and moving platforms confuse it. The map
  convention fixes it for games that expose one. Stuck incidents are reported honestly instead of hidden.
* **Platformer physics vary** (acceleration, variable jump height, coyote time). The jump planner uses conservative
  defaults (always hold to the apex for gaps, take a run-up when it fails) and per-game `jump` tuning.
* **FPS aiming conventions vary** (radians/degrees, yaw sign, forward axis). Calibration measures them; explicit
  config overrides it.
* **Model behaviour.** Haiku may spam `look`, misuse names, or forget to `end`. The brief keeps rules short; parse
  errors are cheap and explained; the idle timeout writes the report anyway (outcome `idle`).
* **Wake granularity:** too many wakes waste turns, too few miss decisions. Phase 3 tunes the defaults.
* **Windows detached processes:** the daemon must not hold the Bash tool's pipes (stdio goes to `daemon.log`), and no
  console window may flash (`windowsHide`). Verified in Phase 2.
* Open: should `fight` default to auto-guard? (Plan: yes, with the human `reaction` delay, so testers aren't
  frame-perfect and telegraph readability is measured.) Should testers be allowed `call`? (Plan: no by default.)
