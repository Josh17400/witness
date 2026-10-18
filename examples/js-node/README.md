# coins: Node example (`witness.js`)

The standard Witness sample game (see `docs/ADAPTERS.md`) as a headless Node game, built on the
JS adapter in `adapters/js/witness.js` (imported straight from the repo; real projects copy it to
`witness/witness.js` with `witness init`).

| file | what it is |
|---|---|
| `game.mjs` | the game plus its Witness wiring: `reset`, `input`, `step`, `snapshot`, a software-rendered `screenshot`, a `createMixer()` "ding", and the `teleport` / `addcoin` calls |
| `witness.json` | launches `node game.mjs` |
| `witness/coins.witness.json` | the shared test (copy of `examples/coins.witness.json`) |

This is the **explicit-handlers** style: the adapter calls `input` then `step(dt)` for every
frame. (The browser example shows the other style, where the adapter takes over the game's own
`requestAnimationFrame` loop.)

Without Witness, `node game.mjs` is a tiny terminal game (arrows/WASD, `m` marks a moment, `q`
quits). Without a terminal (CI, pipes) it runs a 2-second scripted real-time demo instead.

## Verify with Witness

No build step, no dependencies. Node 18+. From this folder:

```
node ../../bin/witness.js doctor
node ../../bin/witness.js test
```

## Record and replay a session

```
WITNESS_RECORD=witness/replays/demo.jsonl WITNESS_SEED=4 node game.mjs < /dev/null   # PowerShell: $env:WITNESS_RECORD=...; node game.mjs < $null
node ../../bin/witness.js replay witness/replays/demo.jsonl --watch "state.player.pos[0].toFixed(4)"
```

The demo holds `right` for 1.2 s with real, uneven frame times and marks 0.5 s. It prints the
final position, and the replay reaches the same value to 4 decimal places (CI checks it). The
game feeds `witness.recordFrame(dt, events)` every frame and simulates with the dt it returns,
so the recording holds exactly the dts that were simulated.
