---
name: witness
description: Witness lets you see, hear and prove a game headlessly — in any language or engine (C/C++, Rust, Go, C#, Unity, Godot, Java/LibGDX, Python/pygame, Lua/LÖVE, JS/TS web). Use it whenever you are building, debugging, testing or polishing a GAME (or any real-time interactive app): to wire the Witness adapter into the project, then verify gameplay with scripted-input tests, query game state at any moment, chart values over time, take and diff screenshots, analyze the game's audio, and replay a human's recorded play session.
when_to_use: User asks to test/verify/debug a game, "make sure it works", check a mechanic, reproduce a bug they hit while playing, look at what the game renders, check sound/music, add automated gameplay tests or CI for a game, or set up Witness. Also when you have changed game code and should prove it still works, and after building a level or mechanic, to have a cheap tester subagent play it (agent playtest) before handing it over.
---

# Witness: see, hear and prove any game

Witness drives the game through a tiny **adapter** inside it (one file per language). The game
then runs **headless and deterministic**: you send inputs, step frames, and read back state,
screenshots and audio. Use it so you never hand over game work you haven't actually checked.

CLI: `node "${CLAUDE_PLUGIN_ROOT}/bin/witness.js" <command>` (shown below as `witness`).
Run it from the game project (it finds `witness.json` in the current or a parent folder).

## 1. Set up (once per project)

1. `witness init` detects the language/engine, copies the adapter into the project, and writes
   `witness.json`, a starter `witness/smoke.witness.json`, and `witness/ADAPTER-GUIDE.md`.
   (`witness adapters` lists ids; force one with `--lang <id>`.)
2. **Read `witness/ADAPTER-GUIDE.md` and wire the adapter in.** The usual shape:
   * at startup, if the adapter reports active (WITNESS_ADDR is set), connect and send hello
     (name, fps, size, capabilities, custom calls);
   * in witness mode, **don't run the real-time loop**. Step only when told to, with the given
     fixed dt, through the game's normal update path;
   * inject input events through the engine's normal input path;
   * **seed every RNG** from `reset(seed)` and never read wall-clock time in gameplay;
   * `snapshot` returns game state as JSON. Include `entities: [{id, type, pos, ...}]` if you
     can: it unlocks `count()`, `first()`, `near()`;
   * optional: screenshot (RGBA readback), audio (render the mixer into a buffer), custom
     `call`s for test setup (teleport, give item, set scene …), logs.
   Make it **zero-cost when inactive**, so normal builds behave exactly as before.
3. Set `"launch"` in `witness.json` to start the built game (`"build"` optionally runs first
   with `--build`).
4. `witness doctor` must say **"all good"**. It checks the connection, capabilities, a
   step and a snapshot, screenshots, audio and **determinism**: a run, a different run, then
   the first run again in the same process must give identical state, screenshot and audio.
   Fix anything it reports before writing tests. Doctor's run is short, so also run
   `witness test --repeat 2` once you have tests: the game's real scenarios (journeys, fights,
   menus) must repeat exactly too. Optionally expose a snapshot `digest` (hash of the full
   internal state) so hidden state is compared as well.

## 2. The loop: always verify your work

```bash
witness test                                   # all witness/*.witness.json|mjs tests (--repeat 2: prove determinism)
witness eval --keys                            # every state path (vectors inline, entities grouped by type, ~ = live)
witness eval --at 2,90f "state.player.hp" "count('Enemy')"   # ask instead of guessing (times: seconds or 90f frames)
witness eval --when "state.gate.open" --time 6 --input "e@2"  # the exact frame a condition becomes true, and its spans
witness eval --diff 1,3 --input "e@2"          # what changed in the state between two moments (entities by id)
witness effect --input "space@1"               # what an input causes, and how many frames later: state, pixels, audio
witness window --input "right@0-2, space@{t}" --t 0.9..1.3 --expect "state.player.jumps == 1" --at "{t}+2f" --ref "fell(state.player.grounded)"   # coyote/buffer/parry windows
witness measure jump --y "state.player.pos[1]" --input "space@1"   # apex, airtime, hang, gravity (feel numbers)
witness measure move --x "state.player.pos[0]" --input "right@1-2" # top speed, accel frames, stop/slide
witness measure hitstop --paths "state.player.pos" --input "right@0-2, j@1"   # freezes between motion
witness measure curve --of "state.camera.pos[0]" --vs "state.player.pos[0]" --input "d@1-3"  # rise/settle/overshoot/lag/stutter
witness trace --watch "state.player.pos, state.score" --time 4 --input "space@1" --events "land: rose(state.player.grounded)"
witness trace --watch "state.player.pos[1]" --input "space@1" --compare "GRAVITY=0.5"   # A/B on one chart: B − A, first differing frame
witness trace --watch "..." --save base.json   # then after a code change: --against base.json (before/after deltas)
witness trace --xy "state.player.pos" --input "right@0-3" --hist   # the path over the level (start/end/deaths) + histograms
witness heatmap playtests                      # where testers spent time and died (also: replays, last, --seeds 1,2,3)
witness shot --at 1,4 --input "right@0-3"      # PNGs: OPEN THEM with your image tool and look
witness shot --from 1 --to 1.5 --every 2f --sheet --follow "state.player.pos" --zoom 3   # a whole motion in one picture
witness shot --from 0 --to 4 --auto 9          # the 9 frames where the picture changes most (key moments)
witness shot --at 3 --diff witness/shots/before.png   # what changed: "moved +80,0", appeared, gone; camera shifts undone
witness ab --a LIFT=0 --b LIFT=1 --input "right@0-3" --at 3.2 --rect 200,100,64,64   # A/B: changed px, luma Δ, A|B|diff, --state
witness measure registration --pos "state.player.pos" --at 1 --time 1 --input "right@0-2" --hold-camera   # sprite vs state, foot slide
witness listen --time 8 --input "space@1" --events "land: rose(state.player.grounded)"   # sounds vs their causes
witness replay last --shot                     # what the human saw when they hit the bug
witness call teleport 100 200 --at 1           # run a game command, then print the state
witness measure motion --at 1 --time 1 --input "right@0-2"   # every mover: speed, jitter, stutter, flicker; camera scroll + hitches
witness shot --at 2 --annotate                 # every entity boxed + labelled (#5 Wolf hp=3 state=windup) on the shot
witness measure align --at 2                   # are sprites drawn where the state says? art offsets, hitbox vs art
witness measure scale|box|contrast ...         # pixel facts: integer scale/blur, sprite box, WCAG contrast
witness measure ui --at 2 --out ui.png         # HUD/menus: clipped, off-screen, overlaps, tiny or low-contrast text, text without a plate, the same text twice (state.ui; else a pixel guess)
witness measure ui --at 2 --safe iphone-landscape   # what sits under the Dynamic Island / home indicator (also iphone-portrait, iphone-se, ipad)
witness measure ui --from 0 --to 60 --within 10     # toasts shown again within 10 s, text doubled at any frame
witness measure figure --of Player --params '[{"hour":12},{"hour":22}]'   # hero edge contrast vs each ground surface, day and night
witness measure colorblind --at 2              # protan/deutan/tritan pictures + which sprite colours become confusable (ΔE)
witness measure palette shot.png --palette pal.hex   # pixel art: off-palette pixels and where; --max 16 colour budget
witness measure anim --of "state.player.anim" --input "right@0-2"   # frames per pose, loop length, doubled/dropped frames (or from pixels: no --of)
witness measure perf --time 5 --input "..."    # frame cost p50/p95/max, spikes + what changed then, memory leaks (timing varies run to run)
witness shot --clip --from 1 --to 3            # an animated PNG for the USER to watch (you see only frame 1: use --sheet)
```

* **A/B anything** (a flag, a rig, a mask, a param, an input): `witness ab` (pictures) or `trace --compare` (values over
  time), never a hand-written comparison script. Tuning by editing code: `trace --save` before, `--against` after.
  `--hold-camera` asks games that support it (reset param `"camera": "hold"`) to keep the camera still for pixel work.
* **Pick the tool by the question.** Changed a control → `effect` (latency) + `measure jump|move`. Timing that should "feel fair" (coyote time, buffer,
  parry, i-frames, combo windows) → `window`. Animation or juice → `shot --sheet` (and look). "When does X happen?" → `eval --when`. "What did that do?" → `eval --diff` or
  `effect`. A rule that must always hold → a test range (section 3). Sound wiring → `listen --events`. HUD or menu work → `measure ui` (expose `state.ui`); "can I see the hero on every ground?" → `measure figure` (honour the reset param `hide`); colours that mean something (enemy vs ally, danger) → `measure colorblind`. Sprite animation → `measure anim`. "Is it slow / does it leak?" → `measure perf`. Show the user motion → `shot --clip`. The numbers
  come from the game's own state, pixels and audio: quote them to the user instead of "feels fine".
* **Frames.** Offsets read `+Nf`: N frames after the input's frame; `+1f` is the next frame (immediate). Any time can
  be given in frames: `--at 90f`, `--every 1f`, `space@60f`.
* **Scripted input** (`--input` and test `input`): `key@t` taps, `key@a-b` holds,
  `click:x,y@t` (or `@a-b` to hold), `mouse:x,y@t`, `drag:x1,y1->x2,y2@a-b`, `wheel:+3@t`,
  `action:jump@t` (games with input mapping), `pad:a@t`, `touch:x,y@t` (finger tap; `@a-b`
  holds, `touch2:` = second finger), `swipe:x1,y1->x2,y2@a-b`. Keys are lowercase
  names: `a`–`z`, `0`–`9`, `space`, `enter`, `escape`, `left`, `right`, `up`, `down`, `shift` ….
* Runs are deterministic: the same command gives the same result, so a failing test is a
  real bug, not flakiness. Every `--json` prints `{ok, command, verdict, summary, data, files}`.
* **Look at screenshots, sheets and charts** with your image viewer. Judge composition, readability
  and whether the action is framed. For audio, read the `listen` report: which events got their sound
  (✔/✖/⚠ double), pitch movement, length, loudness vs music, and the Problems list.
* **Sound names**: games can announce sounds (`witness.sound("jump")` in the adapters), so `listen` names them
  and ties them to their cause. Without it, `listen` still matches sounds by onset.
* **Web builds on phones** (JS, or C/C++ via Emscripten + `witness_emscripten.js`, see the cpp GUIDE §13): add
  `--device iphone-15` (also `iphone-se`, `ipad`, `-landscape`) and `--engine webkit` to any command. `doctor` then
  says how the canvas lands on the screen (exact ×k, fractional = uneven pixels, smoothing = blur); `shot --capture
  element` + `measure scale` checks it from device pixels. `doctor --no-auto-unlock` tests the iPhone "no sound until
  a tap" bug; tests assert `web.audio.state == 'running'` after `touch:x,y@t` (or a real `dom:tap:x,y@t`).

## 3. Test files: prove gameplay, keep it proven

`witness/*.witness.json` (or `.witness.mjs` exporting the same array):

```json
[
  { "name": "jumping onto the ledge collects the gem",
    "seed": 1, "scene": "level1", "input": "right@0-1.2, space@0.6",
    "steps": [
      { "at": 1.5, "expect": ["state.score == 1", "count('Gem') == 0", "state.player.grounded"] },
      { "at": 1.6, "call": ["teleport", 10, 20], "expect": "dist(state.player.pos, [10, 20]) < 1",
        "probe": "state.player.hp", "shot": "after-teleport.png" },
      { "from": 0, "to": 3, "always": "state.player.hp >= 0", "never": "state.player.pos[1] > 400",
        "eventually": "state.score == 1" },
      { "from": 0.6, "within": "20f", "eventually": "rose(state.player.grounded)" },
      { "measure": { "jump": { "y": "state.player.pos[1]", "input": "space@1" }, "expect": "apexPx between 60 and 70" } }
    ] }
]
```

* Each step at time `at`: `call` → `input` → `expect` → `probe` → `shot` → `match`.
* **Range steps** check every frame from `from` to `to` (or `from + within`): `always` must hold on every frame,
  `never` on none, `eventually` on one. Failures name the frame: `always state.player.hp >= 0 — failed at frame 212
  (t=3.533s): got -1 >= 0`. Rules of the game ("can't fall through the floor") belong here, not in point checks.
* `"match": "label"`: the first capture of a label (state, digest, screenshot, audio) is the
  reference; any later capture of the same label in the run must be identical. Use it to prove
  the same scenario gives the same result after other tests ran.
* Expressions are JavaScript over the snapshot, with helpers: `state.*`, `count(type)`,
  `first(type)`, `all(type)`, `byId(id)`, `near(pos, type)`, `dist(a, b)`, `len(x)`,
  `approx(a, b, eps)`, `sum(list)`, `frame`, `time`, `prev` (the previous step; the previous frame in ranges, trace
  and eval), `rose(x)`/`fell(x)` (became true/false this frame), `changed(x)`, `since(x)` (frames since x became true).
* A failure prints both sides: `state.score == 1 — got 0 == 1`. Game error logs fail the test.
* **Measure steps** keep a number you tuned (jump, move, hitstop, curve, effect, window, with the CLI's option
  names) as a regression test: each runs its own scenario from reset and `expect` checks its summary. On the CLI the
  same check is `--expect "apexPx between 60 and 70"` (exit 1 when it fails; field names are in `--json`'s summary).
* Write a test for **every mechanic you build or fix**, and turn every reproduced bug into a
  test.

## 4. Replays of human play

When the human plays with `WITNESS_RECORD=witness/replays/session.jsonl` set, the adapter
records seed, frame times and inputs (F8 marks a moment). Then:
1. `witness replays` lists the sessions.
2. `witness replay last --at <marker time> --shot`, or `witness trace --replay last --watch "…"`,
   shows exactly what they saw.
3. Fix the bug, then add a test that reproduces it.
4. If the game writes `<file.jsonl>.state.json` at the end of a recording, `witness replay`
   checks the replay ends in exactly that state; recorded `scene`/`params` go to `reset`. Fields that legitimately
   differ (window-dependent ones) go in witness.json `"replay": {"ignore": ["view", "entities[*].dist"]}` or `--ignore`.

## 5. Run an agent playtest

`witness play` lets a cheap model **play** the game as a subagent and report back: feel, difficulty, confusing
spots, places it got stuck, bugs. Do it after building a level or a mechanic and before handing the work to the
user. Tests prove what you thought of; a playtester finds what you didn't. Full reference:
`${CLAUDE_PLUGIN_ROOT}/docs/PLAYTEST.md`.

1. **Config.** Add a `"play"` section to `witness.json`: at least `controls` (move, attack, block, dodge,
   interact, heal, choose…), plus `profile` (`topdown` | `platformer` | `fps`) if it isn't top-down.
   `witness play suggest` probes the game and proposes one (`--write` saves it). The harness works much better when
   the snapshot follows the playtest conventions (entity `hostile`/`item`/`talk`, enemy `state: "windup"` or
   `telegraph`, `dialogue`, `goal`, `map`, `won`/`dead`): `witness play check` lists which ones the snapshot has,
   what each missing one unlocks, and PLAYTEST.md "Playtest-ready snapshots" has a minimal example per profile.
2. **Sanity-check it yourself:** `witness play start --name check --goal "smoke"`, `witness play do "explore for 3s"
   -s check`, `witness play end -s check`. Fix the config until orders work and things are classified right.
3. **Brief:** `witness play brief --goal "<what to achieve>" --persona newbie --minutes 4 --name t1` prints the
   complete tester prompt (commands with the absolute CLI path, the order card, the rules). **Default: turn-based and
   headless** (no flag): the game waits while the tester thinks and runs as fast as the machine allows during orders.
   That gives the best test (a 4v4 shooter: 25 kills / 5 deaths, the same as a watched run, at ~3.4× the speed).
   When the user wants to watch: `--watch --turns` (window shown, orders at real speed, the game waits for the
   tester). `--watch` alone or `--live` keep the game running while the tester thinks: no freezes, but the model's
   ~1.3 s lag shows (23 kills / 14 deaths in the same shooter). One visible game at a time.
4. **Spawn the tester** with the Agent tool: `model: "sonnet"`, `effort: "low"` and the brief as the prompt (the
   best play at nearly Haiku's speed; `model: "haiku"` is cheaper but plays shallowly, so keep it for simple games).
   The tester runs the commands itself; don't play for it. **No Agent tool** (a workflow subagent): `witness play
   batch --goals goals.txt --minutes 3` launches the testers itself as headless `claude -p` processes (Sonnet, low
   effort, Bash limited to the witness commands, the user's login), at most 2 at once, and prints one summary (also
   `witness/playtests/batch-<time>.md`). Use `--parallel 1` when the machine is busy.
5. **Read `witness/playtests/t1/report.md`**: tester feedback and bug notes first, then fights (windups avoided vs
   hit), stuck incidents, deaths, coverage. Open the key shots and `coverage.png`.
6. **Reproduce** what it flagged: report.md lists `witness replay witness/playtests/t1/replay.jsonl --at <t> --shot`
   for every note and death. Every playtest is a frame-exact replay.
7. **Fix**, then **turn each bug into a test** (section 3), and playtest again if the change affects feel.
8. **Clean up**: once you've acted on a report, `witness play clean t1` deletes that playtest (replay, shots,
   report). Old playtests, recordings and screenshots are also pruned automatically on `play start` and `test`
   (witness.json `"retention"`; `witness clean` applies it now, `--all` removes everything generated). Don't leave
   piles of PNGs and replays on the user's disk.

* Several testers give a broader picture: different `--persona`s (`newbie`, `explorer`, `speedrunner`, `breaker`,
  `fighter`) and different `--name`s. **Run at most 2 at once** (each is a game process; `WITNESS_PLAY_MAX`).
* **Never leave sessions running.** `witness play list` shows them; `witness play stop --all` ends them. Sessions
  also end themselves after 5 idle minutes or 20 minutes total.
* Judge the feedback: the reflex layer plays like a decent human, not a pro, and a stuck incident can be a harness
  limit (moving blockers, no `state.map`) rather than a game bug. Check with a replay before changing the game.

## 6. Troubleshooting

* "no game connected": the adapter isn't connecting. Check `launch`, that the game reads
  `WITNESS_ADDR`, and the game output printed below the error.
* "NOT deterministic": find the unseeded RNG, wall-clock read, thread race or unordered map
  iteration. `doctor` shows which state fields differ.
* A command "didn't answer": the game is blocked (an infinite loop, or waiting on real time).
* Engines you can't launch headlessly (editor-based): `witness <cmd> --attach`, then start
  the game with the adapter active.
* The protocol (for writing a new adapter): `${CLAUDE_PLUGIN_ROOT}/docs/PROTOCOL.md`.
  Adapter guides: `${CLAUDE_PLUGIN_ROOT}/adapters/<id>/GUIDE.md`.
