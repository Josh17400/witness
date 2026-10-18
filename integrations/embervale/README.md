# Witness in Embervale

`embervale-witness.patch` adds Witness mode to Embervale (github.com/Josh17400/embervale). Once it's applied, Claude
can drive the game headless and deterministically: run tests, read the state, take screenshots, listen to the mix,
trace values, and replay recorded play sessions.

It is one commit on top of `main` at `8c0dcaf` ("P1 Fresh Roads"): 17 files, of which 2,088 lines are the vendored
single header `engine/witness.h`. The Embervale-side change is 603 lines added and 13 removed. Nothing changes for
players or for the web build.

## Apply it (on the desktop PC)

```bat
cd "C:\path\to\embervale"
git checkout main
git pull
git checkout -b witness
git am "C:\path\to\witness\integrations\embervale\embervale-witness.patch"
tools\build.bat embervale
```

* If `main` has moved on and `git am` stops on a conflict, run `git am --abort`, then
  `git apply --3way <patch>` and fix the few hunks by hand. Almost all of the change is in `rpg/main.cpp`, next to
  the script driver.
* The first build after applying reconfigures CMake (the new `EMBERVALE_WITNESS` option) and recompiles whatever
  includes `rpg/sim/game.h`.
* The Witness CLI needs Node 18 or newer. From the Embervale root:
  `node C:\path\to\witness\bin\witness.js doctor`, or put `witness\bin` on the PATH.

## Use it

Run these from the Embervale root, where `witness.json` lives. Each command starts the game in a hidden window,
drives it, and quits it.

```
witness doctor                                    # all good: connection, determinism, screenshot, audio
witness test                                      # witness/embervale.witness.json: 8 tests
witness eval --keys                               # every snapshot path
witness shot --at 1 --scene town --params "{\"hour\":21.5}"
witness listen --time 8 --scene cave --params "{\"god\":true,\"fight\":\"wolf\",\"count\":3}" --input "j@0.3-7"
witness trace --watch "state.player.hp, sum(all('Wolf').map(w => w.hp))" --time 16 --scene cave --params "{\"fight\":\"wolf\",\"count\":3}" --input "j@0.3-15"
witness call goto town --at 0.5
```

* **reset:** `seed`. The scene is a `goto` target (`city|town|village|cave|ruin|camp|lair|shrine|capital|market`).
  Params: `enter`, `hour`, `god`, `fight` + `count`, and `creator` + `background` + `name` (a recorded new game).
* **input:** Witness key names go through the script driver's paths (an SDL key event plus `View::scriptHold`), so
  WASD/arrows, `j`/`space` (attack, held), `e` (talk), `escape`, and so on behave as on a keyboard. Mouse and wheel
  events are supported too.
* **call:** every script command, built in (`goto`, `walkto`, `talkto`, `choose`, `fight`, `hour`, `enter`, `kit`,
  `expect ...`) or registered (`givequest`, `gotosite`, `fightquest`, `gate`, and the rest of the
  `embervale --script-help` list). A call that takes time (`walkto`, `talkto`, or a registered command that waits)
  keeps running over the next steps, and `state.script.busy` says when it's done. A failed `expect` fails the call.
* **snapshot (`state`):**
  * `mode`, `day`, `hour`, `time`, `notice`, plus `dialogue` (speaker, text, options) while a dialogue is open, and
    `menu` while a menu is open
  * `player`: pos (tiles), px, global, start, moved, hp/magicka/stamina, gold, level, xp, kills, equipped, items
  * `quests` (title, state, have/need, giver, tracked), `location` (region, site, siteType, kingdom)
  * `entities`: the player plus everyone within 40 tiles, nearest first (id, type such as `Wolf` or `Guard`, kind,
    name, pos, dist, hp, level, hostile, faction, state)
  * `counts`, `script` (busy, fails, lastFail), `save` (enabled, written)
* **screenshot:** the 480×270 logical canvas, read back from the hidden window's renderer. The terrain bakers are
  waited on first, so shots don't depend on thread timing.
* **audio:** the synth mix at 48 kHz mono, rendered per step instead of to a device (`witness listen` analyses it).

## Record a session (normal play)

```bat
set WITNESS_RECORD=witness\replays\session.jsonl
build\embervale.exe
```

Play as usual; F8 marks a moment. The replay starts when play does (after the character creator, or straight away
with `--play`), with one line per sim step. Then run `witness replay last --watch "state.player.hp"` to re-simulate it.

## What witness mode changes (and why)

| change | why |
|---|---|
| `EMBERVALE_WITNESS` CMake option, ON for desktop and OFF for Emscripten | the web build has no sockets; `engine/witness_impl.cpp` and every `EMB_WITNESS` block are left out of it |
| a hidden 960×540 window, no vsync, no audio device, no save or settings file | no visible window or dialog during tests; tests never touch the player's files |
| a fresh `Game` per reset | private timers and the actor id counter carried over between resets (the wild spawn timer gave a second run different wolves) |
| `Game::streamThreads = false`, no prefetch worker | every chunk is made on demand, in order, never "whenever the worker finished" |
| `Game::syncStreams` (foes_game.cpp) | named uniques and world bosses used to wait for a worker thread, and the foes memo is process-global: a second run in the same process saw them earlier than the first |
| `View::settleBakes()` before a screenshot | the terrain bake threads |
| `Pix::readCanvas`, `Pix::init(..., hidden)`, `Audio::kSampleRate` | the screenshot readback, the hidden window, and the capture format |

Determinism was checked beyond `witness doctor`. Three scenarios (a long walk across window shifts, a town at
night, a three-wolf fight), each run three times in one process and again in a second process, gave identical
snapshot hashes every time.

## Known limits

* `witness replay` passes only the header's seed to `reset`, not its `params`. A recorded new game whose creator
  background changes play (Novice, Sailor, Marked, ...) can therefore drift on replay until the CLI forwards header
  params. `--play` sessions and background-None games replay exactly.
* Touch input and the creator's text entry aren't recorded or injected. Alt-tabbing away (which pauses the game)
  during a recording breaks the replay at that point.
* Screenshots taken during the UI fast-travel fade (the map's journey) can show buildings that aren't painted yet.
  The tests use `goto` (immediate fast travel).
* The Linux and macOS desktop builds with Witness compile by inspection only. CI's native job builds `rpg_test` and
  `save_test`, never `embervale`.
