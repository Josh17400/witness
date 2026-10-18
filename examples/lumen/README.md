# neon-drift: Lumen example (bridge)

Witness driving **Neon Drift**, a 2D platformer that ships with Lumen
(`lumen/examples/neon-drift`), through the Lumen bridge in `adapters/lumen/`. The game is not
modified, and it isn't the "coins" game: the bridge is meant to run any Lumen game, so the example
points at a real one. Its tests mirror the game's own `test` blocks, written as Witness tests.

| file | what it is |
|---|---|
| `witness.json` | launches `node ../../adapters/lumen/witness-lumen.mjs ../../../lumen/examples/neon-drift` (Lumen checked out next to this repo) |
| `witness/neon-drift.witness.json` | title → level, running, coin pickup, death + respawn, portal → level 2, `goto` |

## Requirements

* Lumen next to this repo (`../lumen` from the Witness folder), or edit the path in
  `witness.json` / pass `--lumen`, with `npm install` done there (it brings Electron).
* The Lumen runtime bundle is rebuilt automatically when it's stale.

## Verify with Witness

```
node ../../bin/witness.js doctor
node ../../bin/witness.js test
node ../../bin/witness.js shot --at 1.5 --input "space@0.3, right@0.5-1.5"
```

Electron runs with a hidden window through Lumen's `boot.cjs` (no dialogs) and exits when Witness
disconnects.

## Replay a Lumen recording

Play with `lumen run ../../../lumen/examples/neon-drift/game.lum` (F8 marks moments), then:

```
node ../../adapters/lumen/lumen-replay.mjs ../../../lumen/examples/neon-drift
node ../../bin/witness.js replay last --watch "first('Runner').pos, state.globals.coins"
```
