# coins: browser example (`witness.js` + Playwright)

The standard Witness sample game (see `docs/ADAPTERS.md`) as an ordinary canvas game: its own
`requestAnimationFrame` loop, `keydown`/`keyup` listeners on `window`, and a WebAudio
oscillator for the "ding". The only Witness code is the import and one `witness.start({...})`.

In witness mode the adapter (`adapters/js/witness.js`) takes the page over: rAF callbacks, timers,
`performance.now()` and `Date` run on a virtual clock that moves only on `step`, `Math.random` is
seeded, input arrives as real `KeyboardEvent`s / `PointerEvent`s, and the `AudioContext` is rendered
offline in step with simulated time, so the CLI hears the ding.

| file | what it is |
|---|---|
| `index.html`, `game.js` | the game |
| `serve.mjs` | a dependency-free static server (port 5317). It maps `/witness/witness.js` to the adapter in this repo and stores replays posted to `/__witness/record` in `witness/replays/` |
| `witness.json` | `"launch": {"url": "http://127.0.0.1:5317/", "server": "node serve.mjs"}`: Witness starts the server, opens headless Chromium on `?witness=<addr>` and talks to the page over a WebSocket |
| `witness/coins.witness.json` | the shared test (copy of `examples/coins.witness.json`) |
| `record-check.mjs` | records a session with real key presses in headless Chromium, then checks that `witness replay` reproduces it exactly |

## Setup (once)

```
npm install                      # installs Playwright (dev dependency), into node_modules/
npx playwright install chromium  # about 150 MB, stored outside the repo (ms-playwright cache)
```

## Verify with Witness

```
node ../../bin/witness.js doctor
node ../../bin/witness.js test
node record-check.mjs
```

## Play it, and record a replay

```
node serve.mjs
```

Open http://127.0.0.1:5317/ and move with the arrows or WASD. To record, open
`http://127.0.0.1:5317/?witness_record=/__witness/record` instead: every frame is posted to the
server (into `witness/replays/<session>.jsonl`) and F8 marks a moment. With `?witness_record=1`
nothing is posted, and F9 downloads the replay instead. Then:

```
node ../../bin/witness.js replay witness/replays/<session>.jsonl --watch "state.score, state.player.pos"
```
