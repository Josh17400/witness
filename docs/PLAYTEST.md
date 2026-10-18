# Agent playtests: `witness play`

A cheap Claude model (Haiku, or Sonnet at low effort) runs as a subagent and **plays** the game through short Bash
commands. It gives plain-word orders ("fight wolves block", "talk guard", "goto Exit"). A deterministic **reflex
layer** inside Witness carries them out frame by frame: it walks around walls, faces and attacks, blocks when an enemy
winds up, picks dialogue options. Witness records a frame-exact replay and writes a report for the main agent.

The design reasoning is in [PLAYTEST_PLAN.md](PLAYTEST_PLAN.md). Where the two differ, this file and the code win.

## Why it works

* **The game only steps on command.** Between orders nothing steps, so the model's thinking costs no game time. A
  slow model plays "in real time" as far as the game can tell.
* **Orders become ordinary recorded input.** Everything the reflex layer does reaches the game as protocol `input`
  events at exact frames, so every playtest is also a standard replay (`witness replay` reproduces it field by field).
* **The model decides what to do, the reflex layer handles timing.** The model doesn't have to press keys at 60 Hz:
  pathing, stuck recovery, attack timing and reacting to telegraphs happen inside Witness, with a human-like reaction
  delay so difficulty feedback stays meaningful.

The harness was proven this way: a Haiku 5.5 tester, on its first try at [examples/arena](../examples/arena), won in
38.8 s of game time with 26 tool calls in about a minute of wall time. Its report flagged real harness bugs and real
game feedback (difficulty too low, gold has no use).

## Quick start (for the main agent)

1. **Write or adjust the `"play"` section of `witness.json`** (reference below). For a game that follows the
   snapshot conventions, `{"controls": {...}}` is often all it needs. `witness play suggest` probes the game and
   proposes one (`--write` merges it into witness.json).
2. **Sanity-check it yourself** before spending a subagent on it:
   ```bash
   witness play start --name check --goal "smoke test"
   witness play do "explore for 3s" -s check
   witness play end -s check
   ```
   Fix the config if the player isn't found, things are misclassified, or orders fail for config reasons
   ("no interact control is configured …").
3. **Print the brief:**
   ```bash
   witness play brief --goal "Escape the arena" --persona newbie --minutes 4 --name t1
   ```
   It's a complete prompt: role, goal, persona, budget, the exact commands with the absolute CLI path, the order card,
   the game's controls, how to read observations, how to finish.
4. **Spawn the tester** with the Agent tool: `model: "haiku"` with the brief as the prompt, or `model: "sonnet"` with
   low effort for harder games. Run at most 2 testers at once.
5. **Read `witness/playtests/t1/report.md`** when it returns: the tester's feedback and bug notes first, then fights,
   stuck incidents, deaths, coverage. Open the key screenshots and `coverage.png`.
6. **Reproduce** anything marked: `witness replay witness/playtests/t1/replay.jsonl --at 12.40 --shot` (report.md
   lists the exact commands). Fix the bug, then turn it into a `witness test`.

Never leave sessions running: `witness play list` shows them, `witness play stop --all` ends them.

## Commands

All commands are thin clients: each sends one request to the session's daemon on 127.0.0.1 and exits in a fraction
of a second. `--config DIR` (or `--cmd "<launch>"`) works as in every Witness command.

| command | options | what it does |
|---|---|---|
| `play start` | `--name t1` `--goal "…"` `--persona P` `--seed N` `--scene S` `--params JSON` `--minutes 20` `--idle 300` `--allow-calls` `--no-map` `--model NAME` `--out DIR` `--force` `--json` | Launches the game and a detached session daemon, prints the first observation (with the goal, the controls and the order card). |
| `play do "<orders>"` | `-s t1` `--for S` `--json` | Runs an order chain until it's done, failed, interrupted by a wake event, or hits the time cap. Prints the observation. |
| `play look` | `-s t1` `--shot` `--scale K` `--json` | The observation now. No game time passes. |
| `play shot` | `-s t1` `--scale K` | Screenshot → PNG path (open it with the Read tool). Frames narrower than 600 px are upscaled 2× (nearest). |
| `play note "<text>"` | `--bug` `--confusing` `--fun` `--idea` `--shot` `-s t1` | Adds a note to the timeline and a mark to the replay. `--bug` notes always take a screenshot. |
| `play end` | `-s t1` `--fun 1-5` `--difficulty 1-5` `--feedback "…"` `--all` | Writes report.md/report.json/coverage.png and the final replay, stops the game and the daemon. |
| `play stop` | `-s t1` or `--all` | Same as `end`, without feedback (reason "stopped by the main agent"). Kills the daemon and game if they don't exit within 15 s. |
| `play status` | `-s t1` | Game time, frame, orders and notes of a live session; state and summary of an ended one. |
| `play list` | `--clean` | All sessions in the registry (● live, ○ ended). `--clean` kills unresponsive sessions (daemon and game), marks dead ones ended, and drops entries older than 7 days. |
| `play report` | `[name\|dir]` `--json` | Prints report.md (or report.json). report.json is also updated after every order while a session runs. |
| `play brief` | `--goal` `--persona` (newbie) `--minutes` (4) `--name` (t1) `--seed` `--scene` `--params` `--model` `--extra "…"` | Prints the tester prompt. `--extra` (or `play.brief` in witness.json) adds a "notes from the developer" paragraph. |
| `play suggest` | `--seed` `--scene` `--params` `--write` | Probes the game (holds each key for 0.35 s from a fresh reset) and proposes a `"play"` config, plus which snapshot conventions the game follows. `--write` merges it into witness.json. It runs one game process. |
| `play orders` | | The order card. |

**Personas** (`--persona`): `newbie` (follows hints, reports confusion), `explorer` (coverage, talks to everyone,
secrets), `speedrunner` (fastest route, skips optional things), `breaker` (walls, edges, spam, odd choices; hunts
bugs), `fighter` (seeks combat, judges difficulty and telegraphs). Each also sets the reaction time (below).

**Finding the session.** `-s <name>`, else `WITNESS_PLAY_SESSION`, else the only live session. With several live
sessions and no `-s`, the command refuses. Sessions are found from any working directory (machine-wide registry).

**Exit codes.** `0`: the command ran, even if the order failed in the game (the result line says `✖ failed` and
why). `2`: the order text didn't parse; nothing happened in the game. `1`: session or daemon errors (no such
session, it ended, it didn't start).

## The order language

Case-insensitive and forgiving: synonyms, filler words ("please", "the", "to", "now", "then"…) are ignored, typos
get a did-you-mean. If the text can't be mapped to an order, nothing happens in the game.

| order | synonyms | meaning |
|---|---|---|
| `goto <thing>` · `goto x,y` · `goto goal` | go to, walk to, move to, run to, head to, travel to, navigate to, get to, return to, go back to, approach, reach | Path there around walls; stop in reach (items: pickup reach; NPCs: talk reach; enemies: attack reach; places: step onto them; a solid door: stand next to it). `x,y` is a map cell. `goto goal` needs a goal position in the snapshot. |
| `go <dir> [n]` | walk, move, head, step; a bare direction (`north 3`) | n cells (default 5) that way. Directions: n s e w ne nw se sw, north…, up/down/left/right, up-right…; fps: forward/back/left/right. |
| `explore [dir]` | wander, scout, search, roam | Frontier exploration of unvisited ground, biased toward dir. Runs until the time cap or nothing is left. |
| `follow <thing>` | | Stay near it (teammates, NPCs). |
| `fight [thing] [mode]` | attack, kill, engage, hit, slay, defeat, battle, strike, shoot, destroy | Approach, face, attack, react to telegraphs. No target: nearest hostiles. A plural (`wolves`, `all enemies`) fights until none is near. |
| `flee [from thing]` | retreat, escape, evade, run away, back off, get away | Move to the reachable spot farthest from hostiles; done when none is within 1.6 × alert. |
| `talk <who>` | talk to/with, speak to/with, chat, greet, ask | Walk up, face, press interact, wait for `dialogue`; retries closer, fails after 3 tries. No target: nearest NPC. |
| `choose <n\|words>` | pick, select, answer, reply, say, option | Pick a dialogue option by number, ordinal (`first`), `last`, or words in it (`choose "get it back"`). |
| `pickup [thing]` | pick up, get, grab, collect, take, loot, fetch | Walk onto the item; press interact if it's still there. No target: nearest item. Plural: collects them all nearby. |
| `use <control\|item>` | drink, quaff, eat, heal | Tap a control. `use potion` / `heal` / `drink` → the heal control. An unknown word becomes `interact <it>`. |
| `interact [thing]` | interact with, activate, open, unlock, inspect, read, examine | Walk up, face, press interact (no target: press it here). Reports a new `notice`, or a dialogue that opened. |
| `press <key\|control> [xN]` | tap, push, key | Raw taps (`press e x3`, `press enter twice`). A bare control name (`interact`, `heal`) also works. |
| `hold <key\|control> <s>` | | Hold for s seconds (default 1). |
| `block [s]` | guard | Hold block (default 0.8 s). |
| `dodge [dir]` | roll | Tap dodge while moving (default: away from the nearest hostile). |
| `wait [s]` | idle, pause, stay, rest | Let time pass (default 1 s); reflexes stay on. |
| `wait for <thing>` | | Until it passes, moves away, or 8 s. |
| `stop` | halt, freeze | Release everything. |
| `respawn` | revive, continue | Press confirm while dead. |
| `set <k> <v>` | | Standing policies: `set retreat 30`, `set heal 40`, `set guard on\|off`, `set reaction 0.3`. |
| `combo <name>` | special; a bare combo name | A frame-exact input sequence from `play.combos` (left/right mirror when the foe is on the left). |
| `call <name> [args]` | | A game `call` (cheats, setup). Only with `--allow-calls` or `play.allowCalls`; recorded in the replay. |
| platformer: `run <left\|right> [n] [to x]` · `jump [left\|right] [short\|long\|high]` · `stomp [thing]` | hop, leap; dash, sprint | Side-view locomotion (see Profiles). |
| fps: `look <dir\|thing\|up\|down>` · `reload` · `weapon <n\|name>` | look at, aim at, turn to, face; switch to, equip | Aim, reload, switch weapons. Outside fps, `look` turns to face. |

**Modifiers** (movement and fight orders): `for 6s` (time cap for this order; works on every order), `block` /
`dodge` / `backoff` / `aggressive` (fight mode; synonyms parry, shield, roll, evade, spacing, trade, rush…),
`retreat 30%` (flee below that hp), `kite 4` (keep 4 cells away while attacking), `careful` (wake on anything:
items appearing, notices, pickups, kills), `using <x>`.

**Fight modes.** `block`: hold block facing the attacker through the strike, then keep attacking. `dodge`: dash away
and sideways just before the strike lands. `backoff`: step out of reach. `aggressive`: ignore windups. Default:
`block` if a block control exists, else `dodge`, else `backoff` (`aggressive` after `set guard off`).

**Naming things.** As the observation lists them: a type (`Wolf`; a plural `wolves` means all of them), `Type#id`
(`Wolf#5`), `#5`, `wolf 5`, a name (`"Old Guard"`, `guard`), or a category with `nearest`: `nearest enemy`, `item`,
`npc`, `teammate`. Matching goes exact → singular → prefix → substring → small typos. Things seen earlier and now out
of view can still be targeted (`goto Gate` uses the last known position). Something already picked up or killed says
so instead of "not here".

**Chaining.** `;`, `then`, `and then`, `after that`, `next`, or newlines: `talk guard; choose 1; pickup potion`.
The chain stops at the first failure. Commas never split (`12,5` is a cell).

**Errors** are one line plus a hint:
* parse errors (exit 2): `✖ "atack wolf": unknown order "atack" — did you mean "attack"?`
* in-game failures (exit 0): `✖ failed: no "Dragon" here — in view: Wolf#5, Coin#31, Gate#40`, `✖ failed: no
  dialogue is open — talk to someone first`, `✖ failed: goto Exit#13 — stuck at cell (26,8) heading S for 3.2s (no
  progress toward the target) — Gate#9 (locked) is right there: try "interact Gate#9"`.

## Observations

What every `do`, `look` and `start` prints: small enough for Haiku to read every turn. Distances and positions are in
**map cells**, directions are compass with **north = up on screen**, things are named exactly as orders accept them.

Arena, after `talk guard` then `choose 1`:

```
[t 0.6s] · hp 10/10 · potions 1 · gold 0 · deaths 0 · cell (3,6) facing N
goal: Get the key from the Alpha Wolf
✔ done: choose 1 — chose 1) "I'll get it back." → Old Guard: "Take this potion. Watch for the wolves' lunge: block it with K, then strike!" (0s)
near (dist in cells, compass dir):
  Guard#6      0.8 NE  npc  "Old Guard"
  Coin#4       5.3 NE  item
  Potion#11    5.6 S   item
  Coin#10      7.1 SE  item
farther: AlphaWolf×1, Wolf×3, Coin×2, Gate×1, Exit×1
dialogue — Old Guard: "Take this potion. Watch for the wolves' lunge: block it with K, then strike!"
  1) Thanks.    (choose 1)
map (@ you, # wall, . open, ? unknown; g=Guard c=Coin; N up; top-left cell (-6,2)):
  ??????#############
  ??????#......#c###.
  ??????#...g..#.##..
  ??????#..@...#.##.#
  ??????#...........#
events: 0.6 dialogue — Old Guard: "Take this potion…" [1) Thanks.] · 0.6 goal: Get the key from the Alpha Wolf · 0.6 potions 0→1
```

| line | content |
|---|---|
| header | `[t game-time]`, hp, stats (from `play.stats`, else up to 5 numeric player fields plus `score`/`lives`/`gold`…), player cell, facing (platformer: on ground / in the air; fps: pitch) |
| `your goal:` | the `--goal`, on the first observation only |
| `goal:` | the game's own `state.goal` |
| result | `✔ done` · `✖ failed` · `⚠ interrupted` (a wake event, named) · `⏱ time` (cap reached; the order was still running) · `★ GOAL REACHED`. A chain lists each finished order. A failure may add `hint:`. |
| `near` | up to 8 things within max(2.5 × alert, 12) cells, hostiles inside the alert range first: key, distance, direction, then hp, `WINDUP 0.2s`, a non-idle state (`chasing you`, `stagger`), `item` / `npc` / `teammate` / `enemy`, `locked` / `open`, the name; fps adds `in sight` / `no line of sight`; platformer adds `2 up` / `1 down` |
| `farther`, `out of view` | counts by type beyond that range; up to 4 remembered things with last known distance |
| `dialogue` | speaker, text and numbered options with the exact `choose` orders |
| `game says:` | the game's `notice` |
| `map` | a 19×9 window around you (fps 17×11; platformer: the map rows ahead): `#` wall (the game's map or learned by bumping), `.` open, `?` unknown, one letter per type (uppercase = hostile; a type on both sides gets two letters, marked enemy/ally in the legend). Shown only when walls are known. |
| `events` | the last 9 notable events since the previous observation: damage, hits, kills, pickups, dialogue, notices, stat changes, game logs, reflexes, bumps and stuck incidents. Game logs that say the same thing as an inferred event replace it. |

Other lines you'll see: `✔ done: fight wolves block — 3 enemies defeated (7.2s)`, `Wolf#6   3.1 E   hp 3/3  WINDUP
0.2s`, `★ GOAL REACHED: goto Exit#13 — the game reports a win (1.3s)`, `YOU ARE DEAD — game says: "…"`. The first
observation also prints the controls and the order card. `--json` returns the same content as data (`{t, frame,
player, stats, near[], farther, remembered[], dialogue, goal, notice, dead, won, result, events[], map}`).

## The reflex layer

Each tick the daemon reads a snapshot, updates the world model and the nav grid, runs the reflexes, lets the current
order's behaviour choose controls, and turns those into protocol input events. A tick is `play.tick` frames (3), or
`play.combatTick` (1) when a hostile is within max(4, 3 × attack reach) cells or a platformer jump is in flight.

### When a `do` returns (wake rules)

A `do` returns when its chain is done or failed, at the time cap, or on a **wake event**:

| when | wakes on |
|---|---|
| always | death, goal reached (`won`), a game error log, a scene change, low hp (first drop below 35% or the retreat level; re-armed after healing above 45%) |
| dialogue | a dialogue opens or changes, unless the order is talk / interact / choose / press / use |
| outside fights | being hurt; a hostile entering the alert range (`play.alert`, 6 cells), unless it's the order's own target. `flee` ignores both. In the platformer profile, an approaching enemy doesn't wake run / goto / go / explore / pickup / jump (the runner jumps or stomps on its own). |
| `careful` | also items or NPCs appearing, notices, pickups, kills |

**Time cap** (game seconds): `--for S` if given. Otherwise, if every order is open-ended (explore, wait, follow,
run, wait for, hold, block) or has its own `for`: the largest `for` (default 6) + 0.5 s. Otherwise max(25, largest
`for` + 1). Behaviours also give up on their own: goto 30 s, fight 60 s, flee 6 s, talk 30 s, pickup 40 s,
wait for 8 s.

A movement or fight order fails at once if a dialogue is open ("choose an option or press cancel first"), and any
order except taps/waits fails if you're dead.

### Guard, heal, retreat

* **Guard** (on by default, `set guard off`, `play.guard: false`): during goto, explore, follow, talk, pickup, wait
  and fight, when a hostile within 1.9 × attack reach has been winding up for at least the **reaction delay**, the
  reflex layer defends: block (held, facing the attacker, until the strike has passed), else dodge (just before the
  strike lands), else back off. Outside a fight the mode is always the best available control; inside, the fight's
  mode. The delay is `play.reaction` (0.25 s) unless a persona sets it: newbie 0.35, explorer 0.28, breaker 0.28,
  fighter 0.22, speedrunner 0.2. `set reaction S` changes it mid-session. A persona doesn't override an explicit
  `play.reaction`.
* **Heal** (`set heal 40`, `play.heal`): below that hp %, tap the heal control, at most every 1.2 s.
* **Retreat** (`set retreat 30`, `play.retreat`, or `retreat 30%` on a fight): below that hp % with a hostile in
  alert range, switch to `flee`.

The report's telegraph stats ("9 windups: 7 avoided, 2 hit") show whether windups are readable at human reaction
speed.

### Navigation, stuck detection and recovery

* **Pathing:** A* over the nav grid (8-connected, no corner cutting). Unknown cells are assumed free and the path is
  replanned as walls are learned. Steering heads for the farthest path cell the body fits through in a straight line.
* **The game's map vs learned walls.** With `state.map`, walls are known up front and the map is always right: a
  learned wall on a cell the map says is open is dropped. Without a map (or with `--no-map`), walls are **learned**
  from failed movement and stay for the session. A learned wall is removed when the player stands in that cell. A cell
  the player stood in before, or one with a creature in it, is only blocked for a few seconds (a moving blocker, not a
  wall).
* **Blocked:** over a ~0.36 s window, moving one way but making less than 25% of the expected progress (speed ×
  window; speed is measured on the fly, or `play.speed`). Then the **recovery ladder**: a newly learned wall just
  triggers a replan (twice); after that it cycles re-centre on the cell (0.35 s) → sidestep to a free side (0.28 s) →
  re-centre → back off (0.3 s).
* **Stuck:** no progress toward the target for 3.2 s (goto, talk, pickup), 4 s (fight approach, follow), 2 s (flee)
  fails the order with the position, heading and duration. If a door-like thing is right there, the message says so
  (`Gate#9 (locked) is right there: try "interact Gate#9"`). `explore` doesn't fail: it abandons that frontier after
  2.5 s and picks another.
* **Incidents** (several blocks, ≥ 0.8 s, or unresolved) go to the report with cell, heading, duration and how they
  were resolved; unresolved ones get a screenshot.

## Profiles

`play.profile`: `topdown` (default), `platformer`, `fps`.

| profile | movement | needs from the snapshot | needs from the controls |
|---|---|---|---|
| `topdown` | 8-way keys (or a stick) toward the next path cell. Facing: taps a move key toward the target when the player's `facing` says it's turned away (unknown facing is assumed right). | `player.pos`; `facing` helps attacks land; `hp` for heal/retreat/low-hp | `move`, plus attack / block / dodge / interact / heal as the game has them |
| `platformer` | left/right with `run` held for distance. Jumps planned from the tile map: a wall at body height (held longer for taller walls), a gap or hazard (running jump), an enemy ahead (jump onto it if stompable, else over it). An enemy marked `stompable: false` close ahead stops the run and fails the order with a suggestion ("wait for X", "jump right long"), unless its `state` says it's harmless right now (`hidden`, `retracted`, `sleeping`, `inactive`…); `wait for X` ends when it goes harmless. Stuck: high jump, then back up for a run-up. | `player.pos`, `onGround` (or `grounded`), `vel`, `size`; `state.map` rows with `#` solid, `=` one-way, `^`/`~` hazards (rows below the map count as a pit) | `move` (left/right/down), `jump`, `run`; `attack` only for `fight X ranged` / `using` |
| `fps` | WASD relative to the look direction; turning and aiming with mouse deltas. Mouse sensitivity and sign are auto-calibrated on first use (or `play.fps.sens`). `fight` aims at centre mass, fires while the aim error is under the target's angular size, strafes on a rhythm, reloads at 0 ammo. | `player.pos` (3D), `look` [x,y,z] or `yaw`/`pitch` (`play.fps.degrees`, `yawSign`), `ammo`; entity `los` / `visible` | `move` (wasd by default), attack (default `mouse:left`, held), `reload` (`r`), `weapons` (`1`–`4`) |

The plane is `[0,1]` (x/y) by default and `[0,2]` (x/z) for fps. North is screen up: `-y` by default, `-z` for fps;
set `play.north: "+y"` for y-up worlds. The platformer profile has no guard reflex.

## The `"play"` config

Everything lives in `witness.json` → `"play"` and has a default. Expressions are JavaScript over the snapshot, like
test `expect`s (`state`, `snap` and the expression helpers are in scope); per-thing expressions also get `e` (the
entity) and `player`.

```json
"play": {
  "profile": "topdown",
  "controls": { "move": "wasd", "attack": "j", "block": "k", "dodge": "l", "interact": "e", "heal": "q",
                "confirm": "enter", "cancel": "escape", "choose": "numbers" },
  "reach": { "attack": 1.3, "interact": 1.2, "pickup": 0.5 },
  "stats": ["state.player.potions", "state.player.gold"],
  "combos": { "fireball": "down@0-0.05, right@0.05-0.12, p@0.1" }
}
```

### Controls

A control is `"j"` (a key), `"key:j"`, `"action:attack"`, `"pad:x"`, `"mouse:left"` (`middle`, `right`) or
`"axis:leftx"`.

| field | default | meaning |
|---|---|---|
| `move` | topdown: `wasd` if the game lists those keys (or no arrows), else `arrows`; platformer: arrows left/right/down (no up: it's often jump); fps: `wasd` | `wasd` · `arrows` · `zqsd` · `{up, down, left, right}` (or `forward`/`back`) · `{axis: ["leftx", "lefty"]}` |
| `attack` | topdown: first of `j` `x` `f` in hello.keys; fps: `mouse:left` | attack |
| `attackMode`, `attackEvery` | `tap` (fps `hold`), 0.35 s | tap every N seconds, or hold |
| `block`, `dodge`, `heal`, `crouch`, `aim` | none | block (held), dodge (tapped), heal (tapped), crouch, aim down sights |
| `interact` | first of `e` `f` in hello.keys (none for fps) | talk / open / pick up |
| `confirm`, `cancel` | `enter`/`space`, `escape` (from hello.keys) | dialogue confirm (arrows mode), respawn |
| `jump`, `run` | platformer: `z`/`space`/`k`/`up`/`w`, `x`/`shift`; fps: `space`, `shift` | jump, run |
| `reload`, `weapons` | fps: `r`, `["1".."4"]` present in hello.keys | reload; weapon slots for `weapon <n>` |
| `choose` | `numbers` if hello.keys has `1` (or lists no keys), else `arrows` | `numbers` (tap 1–9) · `arrows` (move the cursor from `dialogue.selected`, then confirm) · a list of controls, one per option |
| `tapFrames` | 2 | how long a tap is held |
| any other name | | a named control: `"map": "m"` makes `press map` / `use map` work |

The key-based defaults come from `hello.keys`. If the game's hello doesn't list keys, set the controls you need.

### Where things are

| field | default | meaning |
|---|---|---|
| `player` | `state.player`, else the first entity typed Player/Hero/You/Avatar | expression for the player object |
| `entities` | `state.entities` | expression for the list of things |
| `pos` | `e.pos` / `e.position` / `{x,y(,z)}` / `e.x, e.y` | per-thing position expression (`e`) |
| `hostile`, `item`, `npc`, `friend` | entity flags `hostile`/`enemy`, `item`/`pickup`/`collectible`, `talk`/`npc`/`talkable`; teams; else type names (Wolf → hostile, Coin → item, Guard → npc) | per-thing classification expressions |
| `telegraph` | `e.telegraph` (seconds or true) or `e.state` like `windup`/`charging`/`telegraph`/`aiming`… | per-thing "about to strike" expression; a number is seconds left |
| `ignore` | none | per-thing expression: skip these things |
| `dialogue`, `menu`, `goal`, `notice`, `scene` | `state.dialogue` (or `dialog`, `conversation`), `state.menu`, `state.goal`/`objective`/`quest`, `state.notice`/`message`/`toast`/`hint`, `state.scene`/`level`/`location` | expressions |
| `won`, `dead` | `state.won`/`victory`/`win`/`complete`; `state.dead`/`gameOver`, or player hp ≤ 0 | outcome expressions |
| `map` | `state.map` | expression for the map; `false` disables it (same as `--no-map`) |
| `stats` | up to 5 numeric player fields, plus `score`, `lives`, `coins`, `gold`, `level`, `wave`, `kills`, `deaths`, `ammo` | list of expressions (or `{expr, label}`) for the header line |
| `ammo` | `player.ammo` | expression |

### Geometry, timing, behaviour

| field | default | meaning |
|---|---|---|
| `profile` | `topdown` | `topdown` · `platformer` · `fps` |
| `plane` | `[0,1]`, fps `[0,2]` | which position components form the ground plane |
| `north` | `-y`, fps `-z` | the world direction that is "up" on screen |
| `cell` | the map's `cell`, else the player's size × 1.25, else 16 (large coordinates) or 1 | world units per nav cell (all distances in orders and observations) |
| `speed` | measured | walking speed in world units/s |
| `reach` | `{attack: 1.2, interact: 1.2, pickup: 0.5}` | in cells |
| `alert` | 6 | cells: a hostile this close wakes the tester |
| `sight` | 3 | cells around the path counted as seen when exploring |
| `reaction` | 0.25 (or the persona's) | seconds before the guard reacts to a windup |
| `tick`, `combatTick` | 3, 1 | frames per decision normally / near hostiles |
| `guard` | `true` | the telegraph reflex |
| `retreat`, `heal` | 0, 0 | standing hp % policies (0 = off) |
| `combos` | `{}` | name → Witness input spec (`"down@0-0.05, right@0.05-0.12, p@0.1"`) |
| `allowCalls` | `false` | allow `call` orders (same as `--allow-calls`) |
| `logs` | `true` | which game info logs become events: `true`, `false`, or a regex |
| `maxShots` | 24 | cap on automatic key-moment screenshots |
| `platformer` | `{jumpFrames: 18, runJumpFrames: 22, stomp: true}` | also `run` (false: never hold run), `stuckLimit` (7 s) |
| `fps` | `{sens: null, aimTolerance: 1.0, strafe: true, eye: 1.5, aimHeight: 1.2}` | also `range` (12 cells), `degrees`, `yawSign`, `maxTurn` (0.5 rad per tick) |
| `module` | none | see below |
| `brief` | none | default `--extra` text for `play brief` |

**`play.module`** (advanced): an ES module path relative to witness.json. If it exports `perceive(world, snap)`, that
function is called after the built-in perception and may patch or return the world model (`world.player`,
`world.things`, `world.dialogue`, `world.goal`…). A module that fails to load fails the session start.

## Snapshot conventions

All optional. Each one unlocks more of the harness. [examples/arena](../examples/arena) follows all of the top-down
ones.

| convention | unlocks |
|---|---|
| `state.player = {pos, hp, maxHp, facing}` | everything; hp drives heal/retreat/low-hp wakes; facing makes attacks land |
| `state.entities[] = {id, type, pos, name?, hp?, maxHp?}` | targets, the near list, events, kills, pickups (dead enemies may be removed or kept with `dead: true` / hp 0) |
| entity `hostile` / `item` / `talk` (or `npc`) / `team` | exact classification (else type-name guesses) |
| entity `state: "windup"` or `telegraph: <seconds left>` | blocking/dodging at human speed, telegraph stats, `WINDUP` in observations |
| entity `locked` | `locked`/`open` in observations, "try interact" hints when stuck at a door |
| `state.dialogue = {speaker, text, options[], selected?}` (null when closed) | talk/choose, dialogues in the report |
| `state.goal` (text or `{text, pos}`), `state.notice` | goal and "game says" lines; `goto goal` with a pos |
| `state.map = {cell, origin, rows[], solid?}` | walls known up front (rows of characters; `#` solid unless `solid` lists others), coverage % of the open map |
| `state.won` / `state.dead` | outcome, goal and death wakes |
| game logs (info level) | the game's own words in the timeline ("You block Wolf#3's bite. It staggers!"); error logs wake the tester and go to the report |
| platformer: player `onGround`, `vel`, `size`; map `=` one-way, `^` hazard; entity `stompable: false` and a harmless `state` (`hidden`…) | jump planning; stopping before enemies it can't jump on |
| fps: player `look` or `yaw`/`pitch`, `ammo`; entity `los` | aiming, line of sight, reload |

### Make your game playtest-friendly (in priority order)

1. A player with `pos` and `hp`, and `entities` with stable `id`s and readable `type`s.
2. `hostile` / `item` / `talk` flags on entities.
3. `state: "windup"` or `telegraph: <seconds>` on enemies about to strike, for at least a human reaction time.
4. `state.dialogue` while a conversation is open.
5. `state.map` (rows of characters), so navigation doesn't have to learn walls by bumping into them.
6. `state.goal` text and short `notice`s; game events as info logs.
7. `state.won` / `state.dead`, and a respawn the `confirm` control triggers.
8. `call`s for test setup (handy for you; testers only get them with `--allow-calls`).

## Sessions, files and lifetime

```
witness/playtests/<name>/        (<name>-2, -3 … if it exists; --out DIR changes the base)
  report.md  report.json  coverage.png
  replay.jsonl  replay.jsonl.state.json
  shots/*.png  session.json  daemon.log
```

* **Daemon.** `start` spawns one detached, hidden daemon per session (stdio to `daemon.log`). It is the game's only
  client and answers the CLI over HTTP on 127.0.0.1 with a per-session token. `WITNESS_PLAY_DEBUG=1` logs every tick
  to daemon.log.
* **Registry.** `<tmpdir>/witness-play/<name>.json` (override with `WITNESS_PLAY_REGISTRY`): pid, folder, state.
  Session names: letters, digits, `- _ .`, up to 40; default `play-<MMDDhhmmss>`.
* **Lifetime.** The daemon writes the report, stops the game and exits on: `end` / `stop`; `--idle` seconds without a
  command (default 300, minimum 30; outcome `idle`); `--minutes` of wall time (default 20; outcome `timeout`); the
  game exiting or disconnecting (outcome `crashed`); SIGINT/SIGTERM or an internal error (outcome `stopped`).
* **Process cap.** `start` refuses when `WITNESS_PLAY_MAX` sessions (default 2) are already live machine-wide, unless
  `--force`. Each session is one game plus one light daemon. `play suggest` runs a game too but isn't counted.
* **Cleanup.** `witness play list` shows what's alive. `witness play stop --all` ends every live session.
  `witness play list --clean` kills unresponsive ones and forgets entries older than a week.
* `witness init` adds `playtests/` to `witness/.gitignore`.

## The report

**report.md**, most useful first:

1. headline (session, game, outcome: `WON` / `DIED` / ended / `GAME CRASHED` / timed out / abandoned (idle timeout) /
   stopped), tester model, persona, goal, seed, game time, wall time, order counts;
2. **Summary**: fights won/lost, enemy windups avoided/hit, kills, deaths, pickups, stuck incidents, coverage, game
   errors;
3. **Tester feedback**: fun and difficulty (1–5), the feedback text, then notes grouped as Bugs suspected, Confusing
   moments, Ideas, Fun moments, Notes (time, cell, screenshot link);
4. Game errors · Fights (table: against, start, length, result, dealt, taken, windups avoided/hit) · Stuck incidents ·
   Deaths · Dialogues · Coverage (link to coverage.png) · Key moments (screenshots) · Orders · Timeline (notable);
5. **Reproduce**: the exact `witness replay` commands for the whole session, each note (`--at <t> --shot`) and the
   second before each death.

**report.json**: `session, game, persona, goal, seed, scene, params, model, startedAt, endedAt, wallSeconds,
gameSeconds, frames, fps, status, outcome, endReason, orders[{t, text, status, msg, seconds}], timeline[{t, frame,
kind, text}], fights[{n, targets, start, seconds, result, dealt, taken, kills, windups, avoided, hits}],
telegraphs{windups, avoided, hits}, stuck[{t, cell, heading, seconds, resolved, how, blocks, shot?}], deaths[{t, cell,
cause}], kills[], pickups[], dialogues[{t, speaker, text, options}], coverage{cells, seen, openCells, percent, bounds,
png}, shots[{t, why, file}], errors[{t, text}], notes[{t, frame, kind, text, cell, shot?}], feedback{fun, difficulty,
text}, replay{file, frames, calls}, profile, stats{…counts…}`. While a session runs it has `status: "in progress"`
and is rewritten after every order and note.

**coverage.png**: the known map (walls grey, learned walls brown), seen cells, visited cells (blue), the path (light
blue), deaths (red ✕) and stuck points (orange).

**Automatic screenshots** (`shots/`, up to `maxShots`): the start, the goal, each death, the first 3 game errors,
unresolved stuck incidents, the first 3 dialogues, the first sight of each enemy type, every `--bug` note and notes
with `--shot`. `play shot` and `look --shot` are extra.

**Reproducing a marked moment.** Notes are replay marks. `witness replay witness/playtests/t1/replay.jsonl` replays
the whole session and checks the final state against `replay.jsonl.state.json`; `--at <t> --shot` shows a moment;
`witness trace --replay <file> --watch "…"` charts values through it.

## Determinism

* The daemon steps with explicit per-frame `dts` (1/fps), exactly as `witness replay` does, so the live session and
  its replay take the same adapter path.
* Every input event is sent for a frame ≥ the current frame and recorded at that frame. Events planned for frames
  that never ran (a release after the last step) are dropped; marks after the last step land on the last frame; the
  last stepped frame always has a line, so the replay steps exactly as many frames as the session did.
* The replay header has `source: "witness play"` and `session: <name>` (plus seed, scene, params).
* The reflex layer uses no wall clock and no unseeded randomness, though the replay doesn't depend on it anyway.
* Allowed `call` orders are recorded as `calls` on the frame line and re-run by `witness replay` at that frame, before
  it steps ([PROTOCOL.md](PROTOCOL.md) §5). A call is always followed by a step, so it lands inside the recording.
* The game itself must be deterministic (`witness doctor`), or the replay check fails.

## Limits and caveats

* **The reflex layer plays like a decent human, not a pro.** Reaction delays, attack cadence and simple spacing are
  deliberate. A fight the tester loses may be hard for people too; one it wins easily is probably easy.
* **Learned occupancy can be fooled** by moving things, thin colliders, one-way doors and moving platforms. Expose
  `state.map` when you can. Stuck incidents are reported, not hidden: check whether they are game bugs or harness
  limits before "fixing" the game.
* **The platformer and fps profiles are newer** and less proven than top-down. Platformer physics vary (acceleration,
  variable jump height, coyote time); tune `play.platformer`. FPS calibration can fail on unusual look conventions;
  set `play.fps.sens`, `degrees`, `yawSign`.
* **The tester is a cheap model.** It may misname things, repeat failing orders, or forget to `end` (the idle timeout
  then writes the report with outcome `idle`). Its feedback is one player's opinion: weigh it against the numbers.
* **Calls are disabled by default** so testers can't cheat; enable them only for setup you'd also accept from a
  player.
* Only the main agent should spawn testers, and at most 2 at once.
