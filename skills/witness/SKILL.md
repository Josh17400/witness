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
witness test                                   # all witness/*.witness.json|mjs tests
witness eval --at 2 "state.player.hp" "count('Enemy')"      # ask instead of guessing
witness eval --keys                            # list every state path the game exposes
witness trace --watch "state.player.pos[1], state.score" --time 4 --input "space@1"   # + chart PNG
witness shot --at 1,4 --input "right@0-3"      # PNGs: OPEN THEM with your image tool and look
witness shot --at 3 --diff witness/shots/before.png   # what changed visually
witness listen --time 8                        # audio report + spectrogram PNGs
witness replay last --shot                     # what the human saw when they hit the bug
witness call teleport 100 200 --at 1           # run a game command, then print the state
witness test --repeat 2                        # prove every step repeats exactly (state, screenshot, audio)
witness measure scale shot.png                 # integer-scale / blur test (pixel art)
witness measure box with.png without.png       # exact box/height of whatever differs (a sprite's silhouette)
witness measure contrast shot.png --a "#202020" --b ring:2    # WCAG ratio + ΔE (outline vs ground)
witness measure motion --at 1 --time 0.5 --input "right@0-2"  # per-frame box/centroid/steps (foot slide, jitter)
```

* **Measure instead of eyeballing** when a judgement can be a number: sprite height, blur from
  fractional scaling, outline contrast, foot slide. `witness help measure` has the details.

* **Scripted input** (`--input` and test `input`): `key@t` taps, `key@a-b` holds,
  `click:x,y@t` (or `@a-b` to hold), `mouse:x,y@t`, `drag:x1,y1->x2,y2@a-b`, `wheel:+3@t`,
  `action:jump@t` (games with input mapping), `pad:a@t`, `touch:x,y@t` (finger tap; `@a-b`
  holds, `touch2:` = second finger), `swipe:x1,y1->x2,y2@a-b`. Times are seconds. Keys are lowercase
  names: `a`–`z`, `0`–`9`, `space`, `enter`, `escape`, `left`, `right`, `up`, `down`, `shift` ….
* Runs are deterministic: the same command gives the same result, so a failing test is a
  real bug, not flakiness.
* **Look at screenshots and charts** with your image viewer. Judge composition, readability
  and whether the action is framed. For audio, read the `listen` report: pitch movement,
  length, loudness vs music, and the Problems list.

## 3. Test files: prove gameplay, keep it proven

`witness/*.witness.json` (or `.witness.mjs` exporting the same array):

```json
[
  { "name": "jumping onto the ledge collects the gem",
    "seed": 1, "scene": "level1", "input": "right@0-1.2, space@0.6",
    "steps": [
      { "at": 1.5, "expect": ["state.score == 1", "count('Gem') == 0", "state.player.grounded"] },
      { "at": 1.6, "call": ["teleport", 10, 20], "expect": "dist(state.player.pos, [10, 20]) < 1",
        "probe": "state.player.hp", "shot": "after-teleport.png" }
    ] }
]
```

* Each step at time `at`: `call` → `input` → `expect` → `probe` → `shot` → `match`.
* `"match": "label"`: the first capture of a label (state, digest, screenshot, audio) is the
  reference; any later capture of the same label in the run must be identical. Use it to prove
  the same scenario gives the same result after other tests ran.
* Expressions are JavaScript over the snapshot, with helpers: `state.*`, `count(type)`,
  `first(type)`, `all(type)`, `byId(id)`, `near(pos, type)`, `dist(a, b)`, `len(x)`,
  `approx(a, b, eps)`, `sum(list)`, `frame`, `time`, `prev` (the previous snapshot).
* A failure prints both sides: `state.score == 1 — got 0 == 1`. Game error logs fail the test.
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
   `telegraph`, `dialogue`, `goal`, `map`, `won`/`dead`): see PLAYTEST.md "Snapshot conventions".
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
   The tester runs the commands itself; don't play for it.
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
