# Witness for Lumen games: integration guide (for Claude)

Lumen (`.lum` games) already has its own deterministic test runtime: `lumen test`, `lumen shot`,
`lumen listen`, and `test` blocks. This adapter is a **bridge**: it lets the universal `witness`
CLI drive *any* Lumen game through the Witness protocol, **without changing the game**. Use
Witness when you want the same tools across a mixed codebase (one test format, `witness
doctor/trace/shot/listen/replay`), or tests that live outside the `.lum` files. Inside a pure
Lumen project, Lumen's own `test` blocks remain the most direct tool. Both run on the same
deterministic runtime.

## How it works

```
witness ──TCP──▶ Electron (Lumen's src/desktop/main.cjs, mode "witness", hidden window)
                   └─ game page: Lumen.boot({test: {seed, fixedDt, manual}}) + window.__witness
```

* `witness-lumen.mjs` (this folder) finds the game and the Lumen install, rebuilds Lumen's runtime
  bundle if it's stale, and starts Lumen's Electron through `src/desktop/boot.cjs`, Lumen's
  headless launcher, which never shows error dialogs. The window is never shown.
* Lumen's `main.cjs` has a `witness` mode (`runWitness`): it connects to `WITNESS_ADDR`, boots the
  game in **test mode** (manual stepping, fixed dt, seeded `rand`/`noise`, silent but logged audio,
  in-memory save storage), sends the hello and translates every command onto the `Lumen.*` test
  API. The Lumen in use must have this mode (Lumen's main.cjs, "witness mode" section).

| protocol | Lumen |
|---|---|
| `reset {seed, scene?, params?}` | a fresh `Lumen.boot` with `test: {seed, fixedDt: 1/fps, manual: true, keepGoing: true, start: {scene, params}}`, then `whenLoaded()` |
| `step {frames, dt?, dts?}` | `runtime.frameStep(dt)` per frame (renders on the last), queued input injected first, waiting for model/image loads |
| `input` | `runtime.inject` (the same path as real input): `key` → key, `mouse` → virtual UI pixels + left/right button, `wheel` → pixels, `text` → key taps, `action` → a key of that name, `pad` → `pad_a`… (+ `space`/`enter`), `axis` `leftx`/`lefty` → arrow keys at \|v\| ≥ 0.5 |
| `snapshot` | `Lumen.snapshot()` minus its wall-clock `perf` block: `entities` (`{id, type, tag, pos: [x,y,z], vel, fields, ...}`), `counts`, `globals`, `scene`, `scene_vars`, `camera`, `expects` |
| `screenshot {scale}` | `Lumen.screenshot()` PNG at the game's virtual resolution × scale (3D + UI composited) |
| `audio` | `Lumen.listen({wav})`: the audio log re-rendered through Lumen's real synth, 48 kHz stereo s16, only the part since the last call |
| `logs` | `Lumen.logs`: `print`/`debug` → info, `warn` → warn, `error` and failed `expect` → **error** (fails Witness tests) |
| `call` | `goto Scene [params-json]`, `teleport Type\|#id x y [z]`, `tests` |
| `eval {expr}` | JavaScript in the page with `Lumen`, `rt` (the Runtime), `L`, `world`, `find(type)`, `first(type)`, `globals`, `state`. Entities and vectors are returned as snapshot data |
| `perf` | `Lumen.perf()`: logic/render ms, draw calls, triangles, counts |

## Wire up a Lumen game (no game code changes)

1. Make sure Lumen is installed (`npm install` in the Lumen folder, which brings Electron).
2. `witness init` (or copy `witness-lumen.mjs` into `witness/`), then write `witness.json`:
   ```json
   { "launch": { "command": "node", "args": ["witness/witness-lumen.mjs", "game.lum"] }, "timeout": 90 }
   ```
   Arguments: `<game.lum | folder>` plus optional `--lumen <folder>` (else `LUMEN_HOME`, then the
   folders above the game, then an installed `lumen-lang` package, then `../lumen` next to
   Witness), `--fps 60`, `--width 1280 --height 720` (the window, not the game's virtual size),
   and `--scene Name` (default start scene).
3. `witness doctor` should say "all good". Then learn the state shape:
   `witness eval --keys` lists every path. Lumen globals are under `state.globals`, scene
   variables under `state.scene_vars`, and user entity fields under `entity.fields`.
4. Write tests in `witness/*.witness.json`. Entity `type` is the Lumen entity name, so `count('Coin')`,
   `first('Runner').pos[0]`, `near(pos, 'Drone')` work directly:
   ```json
   [{ "name": "space starts level 1", "input": "space@0.5",
      "steps": [{ "at": 1, "expect": ["state.scene == 'Level'", "state.globals.level_no == 0"] }] },
    { "name": "falling off costs a life", "scene": "Level", "params": { "n": 0 },
      "steps": [{ "at": 0.5, "call": ["teleport", "Runner", 264, -300] },
                { "at": 2, "expect": ["state.globals.deaths == 1", "count('Runner') == 1"] }] }]
   ```
   Start scenes with `"scene"`/`"params"` (Lumen `start Level(n: 0)`). Use the `teleport` /
   `goto` calls where a Lumen test block would assign `first(Runner).pos = ...` or `goto`.

## Coordinates, time and determinism

* Mouse coordinates are Lumen's **virtual UI pixels** (the `game { width, height }` space, top-left
  origin), the same as `ui.*` and `mouse.pos`. `teleport` takes **world** coordinates (2D: y up).
* Witness time is Lumen's `real_time` (the sum of stepped dts). `world.time_scale`, `pause()` and
  hitstops affect `state.time`, not the frame count.
* Everything Lumen's test mode guarantees holds: the same seed and input give identical
  snapshots (the doctor checks this). `rand()` is seeded from the reset seed, cosmetic randomness
  (particles) has its own stream, and storage is empty and in memory unless the game seeds it.
* `perf` timings are removed from snapshots because they are wall-clock values.

## Audio

Lumen's test mode is silent but logs every `sound`/`sfx`/`tone`/`music` call. The bridge's `audio`
re-renders that log offline with Lumen's own synth (`Lumen.listen`), so `witness listen` hears
exactly what a player would. Limits: at most 120 s per boot (Lumen's render cap), and every
`audio` call re-renders from the start of the run, so it costs more on long runs.

## Replays

Lumen records its own sessions: `lumen run` writes `<game>/.lumen/replays/replay-*.json` (F8 adds a
marker). Convert one and play it back through Witness:
```
node witness/lumen-replay.mjs <replay-*.json | game folder>      # → witness/replays/replay-*.jsonl
witness replay witness/replays/replay-<time>.jsonl --watch "first('Runner').pos, state.globals.coins"
```
The converter maps Lumen's frame tags (an input change that arrives between frames belongs to the
next frame) onto Witness frames, and keeps every recorded dt. Verified locally: a Lumen-recorded
neon-drift run replays to exactly the same runner position. Caveats, printed when they apply:
window-mode recordings use noise seed 1 while the bridge boots with noise seed = seed (gameplay
that depends on `noise()` may drift; `rand()` is exact), and recordings that started from saved
data replay with empty storage.

## Troubleshooting

| symptom | fix |
|---|---|
| `can't find Lumen` | pass `--lumen <folder>` or set `LUMEN_HOME` |
| `Electron isn't installed` | `npm install` in the Lumen folder |
| `the game didn't start: game.lum:12: ...` (on step/snapshot) | a compile or top-level error. Run `lumen check game.lum` |
| the game exits right away, `Electron failed: ...` | Electron's main process threw; the launcher prints the tail of `%TEMP%/lumen-electron-errors.log` (boot.cjs writes there instead of showing a dialog) |
| no game connected (Lumen older than the bridge) | that Lumen's `main.cjs` has no `witness` mode: update Lumen |
| Linux CI | Electron needs a display: run Witness under `xvfb-run -a` |
