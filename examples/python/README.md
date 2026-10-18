# coins: Python example (`witness.py`, stdlib only)

The standard Witness sample game (see `docs/ADAPTERS.md`), using the single-file adapter in
`adapters/python`. Inside this repo the example imports the adapter from there; a real game ships
`witness.py` next to its main script.

`coins.py` contains:
* `Coins`, the engine-free simulation: `reset(seed)`, `on_input(event)`, `update(dt)`,
  `snapshot()`, a software rasterizer (`render()` → RGBA bytes) and a synthesized "ding" mixed
  into a `witness.AudioCapture`;
* `main()`: `witness.run(...)` in witness mode, otherwise a tkinter window (arrows/WASD, F8
  marks a replay moment);
* `demo()` (`--demo`): a scripted 2-second real-time session with no window, which records a
  replay when `WITNESS_RECORD` is set.

## Verify (Python 3.8+)

```
node ../../bin/witness.js doctor
node ../../bin/witness.js test
```

## Record and replay

```
WITNESS_RECORD=witness/replays/demo.jsonl WITNESS_SEED=4 python coins.py --demo
node ../../bin/witness.js replay witness/replays/demo.jsonl --watch "state.player.pos[0].toFixed(4)"
```

(PowerShell: `$env:WITNESS_RECORD="witness/replays/demo.jsonl"; $env:WITNESS_SEED=4; python coins.py --demo`.)
The replay re-simulates the recorded real-time dts and ends on exactly the x position the demo
prints. Playing in the tkinter window with `WITNESS_RECORD` set records your own session.

## pygame variant (`pygame/`)

`pygame/coins_pygame.py` is the same game written the pygame way: `pygame.key.get_pressed()`,
`pygame.draw`, a `pygame.mixer.Sound` for the ding, and `witness_pygame.Bridge` for input,
screenshots and audio capture. It needs `pip install pygame-ce` (or `pygame`), and has its own
`witness.json`:

```
cd pygame
node ../../../bin/witness.js doctor
node ../../../bin/witness.js test
```

In witness mode it runs on SDL's dummy drivers, so no window opens and no audio device is used.
