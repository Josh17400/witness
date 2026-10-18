# Witness in Embervale

Embervale (github.com/Josh17400/embervale) has Witness mode built in since commit `90633ad` ("Witness mode", on
`main`). Claude can drive the game headless and deterministically: run tests, read the state, take screenshots,
listen to the mix, trace values, and replay recorded play sessions exactly.

`embervale-witness.patch` is that commit as a patch (`git format-patch` of `90633ad`, on top of `5b9bcc5`), kept
here as a worked example of wiring Witness into a custom C++/SDL3 engine. Embervale's `main` already contains it, so
**don't apply it there**. Of its 29 files, 2,088 lines are the vendored single header `engine/witness.h`, identical to
`adapters/cpp/witness.h`. Nothing changes for players or for the web build.

## Use it

The Witness CLI needs Node 18 or newer. Run these from the Embervale root, where `witness.json` lives. Each command
starts the game in a hidden window, drives it, and quits it.

```
witness doctor                                    # all good: connection, determinism, screenshot, audio
witness test                                      # witness/*.witness.json: 17 tests (8 gameplay + 9 determinism)
witness test --repeat 2                           # every step of every test must repeat pass 1 exactly
witness eval --keys                               # every snapshot path
witness shot --at 1 --scene town --params "{\"hour\":21.5}"
witness listen --time 8 --scene cave --params "{\"god\":true,\"fight\":\"wolf\",\"count\":3}" --input "j@0.3-7"
witness trace --watch "state.player.hp, sum(all('Wolf').map(w => w.hp))" --time 16 --scene cave --params "{\"fight\":\"wolf\",\"count\":3}" --input "j@0.3-15"
witness call goto town --at 0.5
```

* **reset:** `seed`. The scene is a `goto` target (`city|town|village|cave|ruin|camp|lair|shrine|capital|market`).
  Params: `enter`, `hour`, `god`, `fight` + `count`, `at` (a global tile), `talk`, `menu`, `creator` + `background`
  + `name` (a recorded new game), and `ids` (a recording's actor-id counter at its start).
* **input:** Witness key names go through the script driver's paths (an SDL key event plus `View::scriptHold`), so
  WASD/arrows, `j`/`space` (attack, held), `e` (talk), `escape`, and so on behave as on a keyboard. Mouse and wheel
  events are supported too. A reset releases every finger and button still down.
* **call:** every script command, built in (`goto`, `walkto`, `talkto`, `choose`, `fight`, `hour`, `enter`, `kit`,
  `travel`, `waittravel`, `swipe`, `expect ...`) or registered (`givequest`, `gotosite`, `fightquest`, `gate`, and
  the rest of the `embervale --script-help` list). A call that takes time keeps running over the next steps, and
  `state.script.busy` says when it's done. A failed `expect` fails the call.
  * Witness-only: `statematch`, `shotmatch` and `audiomatch <label>` compare this moment with the first run of the
    same label in the process. Witness now does the same thing generically with a test step's `"match": "label"`
    (state, `digest`, screenshot and audio), so new tests can use that instead.
* **snapshot (`state`):**
  * `mode`, `day`, `hour`, `time`, `notice`, plus `dialogue` (speaker, text, options) while a dialogue is open, and
    `menu` while a menu is open
  * `player`: pos (tiles), px, global, start, moved, hp/magicka/stamina, gold, level, xp, kills, equipped, items
  * `quests` (title, state, have/need, giver, tracked), `location` (region, site, siteType, kingdom)
  * `entities`: the player plus everyone within 40 tiles, nearest first (id, type such as `Wolf` or `Guard`, kind,
    name, pos, dist, hp, level, hostile, faction, state)
  * `counts`, `script` (busy, fails, lastFail), `save` (enabled, written)
  * `digest`: a hash covering every actor exactly, so comparisons catch state the snapshot doesn't list
* **screenshot:** the 480×270 logical canvas (pinned, whatever the settings file or `EMB_SCREEN`/`EMB_BORDER`/
  `EMB_HUD`/`EMB_SAFE` say), read back from the hidden window's renderer after every bake and paint has finished.
* **audio:** the synth mix at 48 kHz mono, rendered per step instead of to a device (`witness listen` analyses it).

## Record a session (normal play)

```bat
set WITNESS_RECORD=witness\replays\session.jsonl
build\embervale.exe
```

* Play as usual; F8 marks a moment. A recording session runs the way witness mode does (no stream worker, inline
  bakes, the pinned canvas), so it can stutter where arrivals or crowded scenes are generated.
* The header carries the seed and the start's params (`at`, `talk`, `menu`, `count`, `ids`, the creator choices).
  Each line is one sim step; key auto-repeat is dropped.
* At exit the game writes `session.jsonl.state.json`, the state the session ended in.
* `witness replay last` re-simulates it from the header's seed and params, and checks that the replay ends in exactly
  that state. Two sessions (4,776 and 576 frames) replay field for field.

## What witness mode changes (and why)

| change | why |
|---|---|
| `EMBERVALE_WITNESS` CMake option, ON for desktop and OFF for Emscripten | the web build has no sockets; `engine/witness_impl.cpp` and every witness block are left out of it |
| a hidden 960×540 window, no vsync, no audio device, no save or settings file | no visible window or dialog during tests; tests never touch the player's files |
| reset builds a fresh `Game`, `View` and `Audio`, and frees textures made since startup | private timers, the actor id counter, particles, fades, UI state and cached pixels used to carry over, so screenshots and audio depended on which tests ran first |
| one `applyStart` shared by reset and a recorded `--play` start; the id counter is recorded | a real start built the title world first, so actor ids (which feed foe ranks, affixes and loot) differed on replay |
| `Game::syncStreams`: no prefetch worker, immediate foe warming | chunks, named uniques and world bosses used to wait for worker threads |
| journeys: the whole wish list generated on the first black step, a fixed 0.5 s arrive hold, `View::witness` bakes and paints inline | gather and arrive waited on wall-clock caps, millisecond budgets and threads, so the same journey ended at different game times with different spawns |
| the canvas pinned at 480×270 | settings and environment variables changed its size, and NPC sleep distance with it |
| `Pix::readCanvas`, `Pix::init(..., hidden)`, `Audio::kSampleRate` | the screenshot readback, the hidden window, and the capture format |

## Known limits

* World-map tab screenshots still paint tiles on a 5 ms budget, so they can vary from run to run.
* Touch input and the creator's text entry aren't recorded yet. Witness now has a protocol `touch` event (inject and
  record); Embervale's side still has to deliver and record it. Alt-tabbing away during a recording can break the
  replay: the protocol now asks games to record releases for everything held on focus loss.
* The Linux and macOS desktop builds with Witness compile by inspection only. CI's native job builds `rpg_test` and
  `save_test`, never `embervale`. MinGW needs `ws2_32` linked explicitly (the `#pragma comment` is MSVC-only).
