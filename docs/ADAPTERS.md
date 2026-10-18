# Writing a Witness adapter

An adapter is a small library that lives inside a game and implements
[the protocol](PROTOCOL.md). Every adapter in `adapters/` follows the same layout, so
`witness init` can install it into any project and Claude can wire it up by following its
guide.

## Package layout

```
adapters/<id>/
  adapter.json          metadata for `witness init` (below)
  GUIDE.md              step-by-step integration guide written FOR CLAUDE: where to hook the
                        game loop, input, rendering, audio and RNG, with code snippets
  <source files>        the adapter itself (header-only / single file where possible, no deps)
examples/<id>/          the standard sample game (below) using this adapter
  witness.json          how to launch it
  witness/coins.witness.json   (a copy of examples/coins.witness.json)
  README.md             how to build and run it
.github/workflows/adapter-<id>.yml   CI: build the example, run `witness doctor` + `witness test`
```

### adapter.json

```json
{
  "id": "cpp",
  "title": "C / C++ (SDL, raylib, SFML, custom engines, Unreal via wrapper)",
  "languages": ["c", "c++"],
  "detect": {
    "files": ["CMakeLists.txt", "meson.build", "premake5.lua", "Makefile"],
    "globs": ["*.vcxproj", "*.sln", "src/**/*.cpp"],
    "contains": [{ "glob": "CMakeLists.txt", "text": "SDL" }]
  },
  "priority": 10,
  "install": [{ "from": "witness.h", "to": "witness/witness.h" }],
  "launch": { "command": "./build/game", "args": [] },
  "guide": "GUIDE.md",
  "verified": "ci"
}
```

* **detect:** `witness init` scores every adapter. `files` are exact names in the project root,
  `globs` are relative patterns, and `contains` checks a file for a string. The highest
  score × priority wins. `--lang <id>` overrides it.
* **install:** files copied into the project (the destination is relative to the project root).
  Existing files are never overwritten without `--force`.
* **launch:** the template written into the new `witness.json` (Claude edits it to match the
  real build output).
* **verified:** `"local"` (tested on the authoring machine), `"ci"` (tested by a GitHub
  Actions job), or `false` (written carefully but not executed, e.g. Unity, which needs a
  license). Never claim more than was actually run.

## Adapter API shape (same idea in every language)

Each adapter exposes roughly this, idiomatically named:

```
witness.active()                      → bool: true when WITNESS_ADDR is set or --witness was passed
witness.connect(hello)                → connect + send hello (name, fps, size, capabilities, calls)
witness.poll(handlers)                → in witness mode, the game's main loop calls this instead of
                                        running real-time: it blocks for commands and dispatches to
                                        handlers {reset, step, snapshot, screenshot, audio, call, eval, perf}
                                        (or: witness.run(handlers) owns the loop until quit)
witness.input_events(frame)           → the queued input events whose frame == frame (games that prefer
                                        pulling input instead of a callback)
witness.log(level, msg)               → unsolicited log line
witness.record_frame(dt, events)      → normal play with WITNESS_RECORD set: append one replay line;
witness.mark(label)                     F8 / markers
witness.seed()                        → the seed to use for RNG (from reset, or the replay header)
```

Touch (protocol section 4): touch events reach the game as touch (`id`, `x`, `y`, `phase`), and
finger 0 is also delivered as the matching mouse event unless the game sets the adapter's
`touch` option (it handles touch itself). Recording gets a `record_touch(id, x, y, phase)`
helper next to `record_key` / `record_mouse`.

Plus small helpers where useful: a JSON writer for snapshots (languages without one built in),
base64, an RGBA screenshot encoder, a float PCM capture buffer, and key-name mapping from the
engine's key codes to Witness names.

Rules: no third-party dependencies (stdlib only); thread-safe enough for engines with a
render thread; never block the game when Witness isn't active; zero cost when inactive.

## The standard sample game ("coins")

Every `examples/<id>/` implements the same tiny game, so one shared test file proves every
adapter:

* Logical size 320×180, 60 fps, dt = 1/60 unless the step says otherwise.
* Player: id 1, type `"Player"`, starts at `pos [40, 90]`, `hp` 3. Moves 120 px/s with
  arrows/WASD (`right` / `d` = +x, `down` / `s` = +y). Clamped to the screen.
* Coins: 5, ids 10–14, type `"Coin"`, at x = 80 + 40·i, y = 90 for i = 0, and
  y = 60 + (((seed · 7 + i · 13) mod 61)) for the others. Collected when the distance to the player is < 12:
  `score += 1`, a log line `coin <id> collected`, and (with audio) a 0.15 s 880 Hz decaying
  sine "ding".
* Snapshot: `{"score", "scene": "level1", "player": {...}, "entities": [player, ...coins]}`.
* Calls: `teleport x y` (moves the player and returns the new pos) and `addcoin x y` (returns the
  coin count).
* Screenshot: 320×180 RGBA, with a dark background, yellow coin circles and a blue player circle.
* Audio: mono, any sample rate, f32 or s16, synchronized with simulated time.
* Real-time mode (not witness): opens a window if the language makes that cheap; otherwise
  it may be witness-only (state that in the README).

`examples/coins.witness.json` is the shared test. Copy it into `examples/<id>/witness/`. It must
pass, `witness doctor` must report "all good", and the run must be deterministic.
