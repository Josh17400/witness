# Witness in Embervale

Embervale (github.com/Josh17400/embervale) has Witness mode built in since commit `90633ad` ("Witness mode", on
`main`). Claude can drive the game headless and deterministically: run tests, read the state, take screenshots,
listen to the mix, trace values, and replay recorded play sessions exactly.

`embervale-witness.patch` is that commit as a patch (`git format-patch` of `90633ad`, on top of `5b9bcc5`), kept
here as a worked example of wiring Witness into a custom C++/SDL3 engine. Embervale's `main` already contains it, so
**don't apply it there**. Most of its 29 files' lines are the vendored single header `engine/witness.h` (the 0.2.0
`adapters/cpp/witness.h`). Nothing changes for players or for the web build.

**Since then (October 2026), Embervale adopted Witness 0.3.0 itself:**
- the header is re-vendored;
- touch is injected and recorded (`hello.touch = 1`, SDL's synthesized `SDL_TOUCH_MOUSEID` mouse events skipped,
  FINGER_CANCELED recorded as up);
- focus loss records releases for everything held, and the game's own pause on focus loss is recorded as
  `{"type":"action","action":"pause"}`, so replays stay aligned;
- `"match"` test steps replace the old `statematch`/`shotmatch` calls;
- MinGW links `ws2_32`;
- the play config is merged, with people found by a `talk` entity flag (`npc: e.talk`);
- `state.map` is a 41-row walkability window around the player (`{id, cell: 1, origin, rows, solid: "#"}`);
- animals are typed (Hen, Rooster, Dog; kind `animal`), and `scene` is set in every in-world mode;
- window-dependent fields stay out of the replay end-state check through witness.json's `replay.ignore` (Witness 0.4.0).
  This replaced the earlier workaround, where recordings set `params.recorded`.

**Embervale on Witness 0.5.0:**
- `witness doctor` passes every check, including watch mode (`WITNESS_WATCH` is supported: the window shows and
  presents frames while a watched playtest plays);
- `witness test --repeat 2` is 90/90;
- FINGER_CANCELED is recorded through `witness_record_touch_ex`;
- five headless turn-based playtests each replayed exactly;
- the snapshot now has global tile positions, quest objectives listed as things, public doors, exits and stairs as
  things, `facing`, and a goal with a position. `state.map` is a 41-tile window that moves with the player
  (`{id, cell: 1, origin, rows, solid: "#"}`).

Those playtests found harness bugs, now fixed in Witness: a moving map window used to count as a new scene and wipe
map memory; regen printed one `healed +0` line per tick; `talk Guard#4` reported success when a child answered;
a wall longer than the window gave "no open way" and goto kept returning to the same dead end; paths went through
doors into buildings; entering the inn interrupted `goto Inn; talk Innkeeper`; `goto <Type>` could prefer a stale
remembered spot; and "Wolf#76 is gone" showed twice. To have paths keep off doors, mark them in the map rows (`+`, or
the characters in `map.door` / `map.avoid`) or list them as things (type Door / Stairs / Exit, or `avoid: true`), with
`leadsTo` naming the building (see docs/PLAYTEST.md, Snapshot conventions).

Earlier results (0.3.0): doctor's A/B/A determinism passed, `witness test --repeat 2` was 84/84, and play smoke runs
worked. One talked to a real villager and explored with 0 stuck incidents on the map. Another won against 3 wolves in
3.9 s, avoiding 4 of 5 windups. Each replayed exactly.

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
  * Witness-only (the 0.2.0 patch): `statematch`, `shotmatch` and `audiomatch <label>` compare this moment with the
    first run of the same label in the process. Embervale's tests now use Witness's generic `"match": "label"` test
    steps (state, `digest`, screenshot and audio) instead.
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

## Agent playtests (`witness play`)

[`play.json`](play.json) is a tested `"play"` config for Embervale: merge its `play` object into Embervale's
`witness.json`. Embervale's snapshot already follows the playtest conventions (player hp, entities with `hostile`,
`state: "windup"` telegraphs, `dialogue` with options, `notice`, quests). The config adds the following:
* `cell: 1`: positions are tiles, and tile numbers are large, so this has to be set;
* the controls: WASD, `j` attack, `shift` roll as the dodge, `e` talk, `q` potion; dialogue options are picked with
  up/down + enter (`choose: "arrows"`; the harness presses enter twice when the text is still typing);
* `dead` from `mode`, the tracked quest as the goal line, gold/level/stamina/region as stats;
* people as NPCs (`kind == 'person'`).

When this config was written there was no `state.map`, so walls were learned by bumping into them. Embervale has exposed a
walkability window since its 0.3.0 adoption (see above). Witness merges the window as it moves and treats ground
outside it as unknown, so no config is needed for it.

```
witness play start --scene village --params "{\"fight\":\"wolf\",\"count\":3}" --goal "survive the wolves"
witness play do "fight wolves" -s <name>          # 2 wolves defeated in 5 s, no damage (the guards help)
```

Checked on a build of `eb4668d` (2026-10-18): sessions start in about 1 s, `fight wolves` wins, and the replay
reproduces the session exactly. Embervale wolves wind up for only 0.3 s: at the default human reaction delay
(0.25 s) the roll lands just in time, and at the newbie persona's 0.35 s it lands too late. That's useful feedback on
how readable the telegraph is.

**A Haiku 5.5 playtest** (persona newbie, `--scene village` with 3 wolves, 140 s of game time, 37 orders) beat the
opening pack with the guards' help. It then talked to the villagers, took a den quest from an NPC, and killed two of
the three den wolves before dying and respawning. What it reported about the game:
* **wolf windups are hard to read:** 24 windups, 18 of them hit (the telegraph is shorter than a human reaction);
* accepting a quest silently replaced the tracked "A Blade of Your Own" quest in the HUD and the goal line;
* hens and roosters are typed `Villager` in the snapshot, so "talk to the nearest villager" walked to a chicken;
* the den pack did 17–19 damage per bite (89 → 0 hp in about 10 s at level 1).

The harness fixes that came out of this run: a fight leash, falling back to the roll when "block" was asked for,
dead corpses, and stale remembered NPCs. Without a `state.map`, walking through the village still bumps into buildings
and sometimes through doors (20 short stuck incidents, all resolved). The walkability window Embervale added since fixes
that: an `explore` on the map had 0 stuck incidents.

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
* The creator's text entry isn't recorded yet. (Touch and focus-loss releases are, since the 0.3.0 adoption.)
* The Linux and macOS desktop builds with Witness compile by inspection only. CI's native job builds `rpg_test` and
  `save_test`, never `embervale`. MinGW needs `ws2_32` linked explicitly (the `#pragma comment` is MSVC-only).
