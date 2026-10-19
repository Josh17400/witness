# Witness Protocol v1

Witness drives a game through a tiny **adapter** that lives inside the game. The adapter
speaks this protocol. Everything clever (tests, eval/trace, charts, screenshots, audio
analysis, replays) lives in the `witness` CLI, so an adapter stays small: about 200–400
lines in any language.

## 1. Transport

* The CLI opens a **TCP server** on `127.0.0.1:<port>` and launches the game with the
  environment variable `WITNESS_ADDR=127.0.0.1:<port>`. Other values (games already
  running in an editor, or started by hand) use the default `127.0.0.1:7357` with
  `witness attach`.
* The adapter **connects as a client**: on startup, if `WITNESS_ADDR` is set, or if the game
  was started with `--witness`. Browsers connect with a **WebSocket** to
  `ws://<addr>/` on the same port; the CLI auto-detects WebSocket upgrades. Browser games
  read the address from a URL parameter: `?witness=127.0.0.1:<port>`.
  WebAssembly builds of C/C++ games (Emscripten) use the same WebSocket: `witness.h` hands its lines to
  `witness_emscripten.js`, which holds the socket and calls back into the module for each command.
* Browser launches (`launch.url`) run the page in a headless Playwright browser, optionally with a device profile
  (viewport, device pixel ratio, touch). The CLI installs a page script before the game's own (`__witnessWeb`): it
  tracks AudioContexts and emulates the autoplay policy (`auto`, or `gesture` like iPhone Safari: `resume()` only
  while a user gesture is handled). Adapters mark input that browsers count as a gesture (key down except Escape,
  mouse button, finger lifted, text) with `__witnessWeb.begin()` / `end()` around its delivery. Standalone pages
  (no CLI script) take the policy from `?witness_audio_unlock=0`.
* Framing: **one JSON object per line** (UTF-8, `\n`-terminated; no newlines inside a
  message). WebSocket: one JSON object per text frame.
* While connected, the game runs in **witness mode**:
  * It doesn't advance on its own (no real-time loop). It only steps when told to, at a
    fixed `dt`.
  * It needs no window. If it must open one, it may be hidden. Rendering happens only when a
    screenshot is requested, or every step if that's simpler.
  * Audio goes into a buffer instead of to a device (see `audio`).
  * Saves and settings go to a scratch location so tests never touch the player's real save.
* Logs: the game must keep stdout free of non-protocol text only when using the optional
  `stdio` transport (section 7). TCP adapters can print freely.

## 2. Handshake

Right after connecting, the adapter sends:

```json
{"hello": {"protocol": 1, "name": "Embervale", "engine": "custom C++/SDL3", "language": "c++",
  "fps": 60, "size": [1280, 720],
  "capabilities": ["reset", "step", "input", "snapshot", "screenshot", "audio", "call", "logs"],
  "calls": [{"name": "gotosite", "args": "quest|camp|cave", "help": "teleport next to a site"}],
  "keys": ["w", "a", "s", "d", "space", "e", "escape"]}}
```

`capabilities` lists which commands below are implemented. `calls` advertises custom
commands for `call`, and `keys` (optional) lists the keys the game actually uses.
`audio_exact: false` (optional; default true) says the adapter can only capture audio in real
time in this launch mode (e.g. Godot without `--write-movie`): the audio is still useful to
`listen` to, but the CLI won't require it to repeat sample for sample.

## 3. Commands

The CLI sends `{"id": <n>, "cmd": "<name>", ...args}`. The adapter answers each one, in
order, with `{"id": <n>, "ok": true, ...result}` or
`{"id": <n>, "ok": false, "error": "<message>"}`.

| cmd | args | result | notes |
|---|---|---|---|
| `reset` | `seed` (int), `scene?` (string), `params?` (object) | `{}` | Return the game to a deterministic initial state: the same seed and the same inputs must always give the same snapshots, screenshots and audio, **whatever ran before in the same process** (see §6). Without `reset`, the CLI restarts the process for each run. Reserved `params` (honour them if the game can vary them per run): `window: [w, h]` (window/backbuffer size in device pixels) and `dpi` (device pixel ratio); the CLI sends them for `--window 1920x1080` / `--dpi 2`. `camera: "hold"` (sent for `--hold-camera`) asks the game to keep its camera where the reset put it for the whole run (no following, no shake), so pixel measurements of a moving character (foot slide, registration, sprite size) aren't mixed with camera motion; games that ignore it still work, and `measure motion` then removes the camera's motion itself. `hide: [ids or type names]` (sent by `measure figure`) asks the game not to draw those entities this run (drawing only: everything else, the simulation included, stays the same), so the picture minus this run's is the entity's exact silhouette; games that ignore it still work (the silhouette is then estimated). |
| `input` | `events: [Event]` | `{}` | Queue input events. Each has `frame` (absolute frame number at which to apply it; apply at the start of that frame). Events for a past or current frame apply at the next step. |
| `step` | `frames` (int ≥ 1), `dt?` (seconds, default `1/fps`), `dts?` (an array of per-frame dt, used by replays; overrides `dt`) | `{"frame": f, "time": t}` | Advance exactly that many fixed frames, applying queued inputs at their frames. |
| `snapshot` | `paths?` (array of strings, optional filter) | `{"frame", "time", "state": {...}}` | Game-defined JSON describing its state. With `paths`, return only those top-level state keys (the CLI sends the keys its expressions read when it samples every frame, e.g. `["player", "entities"]`; it checks the filter against one full snapshot and turns it off if a key comes back different, and `WITNESS_PATHS=0` disables it). Ignoring `paths` is always allowed. Conventions (optional but unlocking helpers): `state.entities = [{"id", "type", "pos": [x, y(, z)], ...}]`, `state.scene`, `state.player`. Values must be JSON-safe (no NaN; use `"NaN"`). Optional `digest` (in the reply or in `state`): a string hash of the game's full internal state (every actor, RNG states, timers), so comparisons also catch hidden state the snapshot doesn't show. Agent playtests (`witness play`) read more optional conventions: entity `hostile`/`item`/`talk`, `state: "windup"` or `telegraph: <seconds>`, `state.dialogue`, `state.goal`, `state.notice`, `state.map`, `state.won`/`state.dead` (see [PLAYTEST.md](PLAYTEST.md#snapshot-conventions)). `witness measure ui` reads `state.ui = [{"id", "kind": "text"\|"button"\|"panel"\|"icon", "rect": [x, y, w, h], "text"?, "fontPx"?, "layer"?}]` in screen pixels (list only what is drawn this frame: a toast while it shows). |
| `screenshot` | `scale?` (number) | `{"width", "height", "format": "rgba8" \| "png", "data": "<base64>"}` | The frame as currently rendered. `rgba8` = raw top-to-bottom rows; the CLI encodes the PNG. Adapters may also write a file and return `{"path": "..."}`. |
| `audio` | — | `{"sampleRate", "channels", "format": "f32" \| "s16", "data": "<base64>"}` | Interleaved PCM of everything the game mixed since the last `audio` call or reset, synchronized with simulated time (one step of dt = dt × sampleRate frames). |
| `call` | `name`, `args: []` | `{"result": any}` | Game-specific commands (teleport, give item, open menu, spawn …). |
| `eval` | `expr` (string) | `{"value": any}` | Optional, for languages with eval (JS, Python, Lua, GDScript). |
| `logs` | — | `{"logs": [{"frame", "level": "info" \| "warn" \| "error", "message"}]}` | Messages since the last call. Errors here fail tests. |
| `perf` | — | `{"frame_ms", "update_ms", "render_ms", "memory_mb"?, "counts": {...}}` | Optional timing info for the last `step` (per frame) and the last `screenshot` (`render_ms`). `witness measure perf` steps one frame at a time and reads `update_ms` (else `frame_ms`) after each; `memory_mb` (or `heap_mb`, `rss_mb`, or `*_bytes`) shows leaks; `counts` (particles, bodies, timers) is listed at spikes. |
| `quit` | — | `{}` | Then exit. |

The adapter may also send **unsolicited** lines at any time:
`{"event": "log", "level": "error", "message": "...", "frame": 12}`. The CLI collects
them like `logs`.

**Sound events (optional).** When the game starts a sound, the adapter may announce it:

```json
{"event": "sound", "name": "jump", "frame": 60, "volume": 0.8, "pos": [212, 140]}
```

* `name` (string, required): what the game calls the sound (`"jump"`, `"coin"`, `"hit"`).
* `frame` (int, required): the frame being simulated when the sound started, the same number a `log`
  event made at that moment carries (0 for the first step after `reset`).
* `volume` (0–1) and `pos` (`[x, y]` in screen pixels) are optional.

`witness listen` uses them to name the sounds it hears ("jump" instead of "sound 2"), to cut the
analysis at the right moments, and to tie each sound to the input or state change that caused it.
It also lines each announced sound up with the audio and reports sounds announced but not audible,
and audible sounds nobody announced. Adapters offer it as one call (`witness.sound("jump")`,
`witness_sound("jump")`, ...) that does nothing outside witness mode. It is additive: older CLIs ignore
unknown events, and games that never send it still get every check from the audio alone.

**Times.** Everywhere the CLI takes a time (`--at`, `--time`, `--every`, `--from`/`--to`, test `at`/`from`/`to`,
input specs like `space@1.5`), it means seconds, or frames with an `f` suffix: `--at 90f`, `space@60f`,
`{"at": "120f"}`. Frame `n` is the state after `n` steps from `reset`.

## 4. Input events

```json
{"frame": 30, "type": "key",    "key": "space", "down": true}
{"frame": 30, "type": "mouse",  "x": 640, "y": 360, "button": 0, "down": true}
{"frame": 31, "type": "mouse",  "x": 650, "y": 360}
{"frame": 40, "type": "wheel",  "dy": -120}
{"frame": 45, "type": "text",   "text": "hello"}
{"frame": 50, "type": "action", "action": "jump", "down": true}
{"frame": 60, "type": "pad",    "button": "a", "down": true}
{"frame": 60, "type": "axis",   "axis": "leftx", "value": 0.8}
{"frame": 70, "type": "touch",  "id": 0, "x": 160, "y": 90, "phase": "down"}
{"frame": 71, "type": "touch",  "id": 0, "x": 170, "y": 92, "phase": "move", "pressure": 0.6}
{"frame": 72, "type": "touch",  "id": 0, "x": 170, "y": 92, "phase": "up"}
```

* **Key names** are lowercase: `a`–`z`, `0`–`9`, `space`, `enter`, `escape`, `tab`,
  `backspace`, `shift`, `ctrl`, `alt`, `left`, `right`, `up`, `down`, `f1`–`f12`, plus any
  other name the game understands.
* Mouse coordinates are in the game's logical pixels, with the top-left origin.
* `button`: 0 = left, 1 = middle, 2 = right.
* `action` events are for games with an input-mapping layer: the adapter passes the action
  straight to it.
* Adapters inject events through the game's normal input path, so gameplay code can't tell
  the difference.

### Touch

* `id` is the finger: an integer, 0 for the first finger down, 1 for the second, and so on.
  One finger keeps its id from `down` through its `move`s to `up` (or `cancel`), and an id may be reused
  after `up`. Several fingers can be down at once.
* `x`/`y` are in the same logical pixel space as mouse events (top-left origin), never
  normalized 0–1: adapters convert from/to engine-normalized coordinates (SDL, pygame).
* `phase` is `"down"`, `"move"`, `"up"` or `"cancel"`. `pressure` is optional (0–1; adapters
  use 1 when it is missing).
* **Cancel.** `cancel` ends a touch exactly like `up`: the finger is no longer down and its id
  is free for reuse. It means the system ended the touch rather than the user lifting the
  finger (SDL's `SDL_EVENT_FINGER_CANCELED`, Android `ACTION_CANCEL`, the browser's
  `touchcancel`/`pointercancel`, Unity's `TouchPhase.Canceled`; e.g. the OS took over a gesture
  or the window lost focus), so games should not treat it as a completed tap or click. Games
  that don't make the distinction may handle `cancel` as `up`. Adapters deliver it through the
  engine's cancel path where one exists, and as a lift otherwise.
* Only these four names are valid. An adapter reads an unknown `phase` as `"move"`.
* **Mouse fallback.** Adapters deliver touch events as touch (the engine's touch path, or a
  touch event in the adapter's event API). For finger `id` 0 they also deliver the matching
  mouse event right after it, unless the game opts out: `down` → button 0 down at x,y,
  `move` → mouse move to x,y, `up` or `cancel` → button 0 up at x,y. So touch-only tests still drive
  mouse-driven games, the way phones and browsers emulate a mouse from the first finger.
  Where the engine has a marker for "mouse from touch", the synthesized event carries it
  (SDL's `SDL_TOUCH_MOUSEID`, pygame's `touch`, LÖVE's `istouch`); other fingers never make
  mouse events. Engine-integrated adapters may use the engine's own emulation instead (Godot's
  `emulate_mouse_from_touch`).
* **Opting out.** A game that handles touch itself turns the fallback off with its adapter's
  `touch` option and then receives only the touch events. Such games may add `"touch": true`
  to the hello to say so (informational; the CLI ignores unknown hello fields).
* **Recording.** Touch events are recorded in replay frames (`in`, section 5) like any other
  event, in the shape above without `frame`. Record the real touches and skip the mouse
  events the platform synthesizes from them (SDL `which == SDL_TOUCH_MOUSEID`, pygame
  `event.touch`, LÖVE `istouch`, browser compatibility mouse events): on replay the fallback
  recreates those, so recording both would deliver them twice. A system-ended touch is recorded
  as `cancel` and replays as `cancel` (a round trip keeps it; it is never rewritten to `up`).
* Scripted input (`--input` and test `input`): `touch:x,y@t` taps with finger 0 (down at t,
  up one frame later), `touch:x,y@a-b` holds, `touch2:x,y@…` uses finger 1 (`touchN` is
  finger N−1), and `swipe:x1,y1->x2,y2@a-b` puts finger 0 down at a, moves it every frame
  (linearly interpolated) and lifts it at b (`swipeN` for other fingers).

## 5. Recording (replays)

When the game runs normally (a human playing) with `WITNESS_RECORD=<file.jsonl>` set, the
adapter writes a replay:

```
{"replay": 1, "name": "...", "seed": 123, "fps": 60, "started": "2026-10-17T20:00:00Z", "scene": null, "params": {...}}
{"f": 0, "dt": 0.016667, "in": [{"type": "key", "key": "d", "down": true}]}
{"f": 1, "dt": 0.016671}
{"f": 2, "dt": 0.016660, "mark": "F8"}
```

* There is one line per frame, carrying its dt and any input events from that frame (in the
  same shapes as above, without `frame`).
* `mark` is written when the player presses F8 (or calls `witness_mark()`), to flag a
  moment.
* The game must seed its randomness with the recorded seed. Adapters expose
  `seed()` / `on_reset` helpers for this.
* `scene` and `params` (optional) describe how the session started (a menu choice, a character background, a
  saved id counter...). `witness replay` and `trace --replay` pass them to `reset`, so `reset(seed, scene, params)`
  must reproduce exactly the state the recording started from — including counters a real start leaves
  behind (e.g. a title screen that built a world first).
* Record the simulation steps that actually ran, with their dt; a paused frame that doesn't step the
  simulation is not a frame. Input that arrives while paused rides on the next recorded frame. On focus
  loss, record releases for every key/button/finger still held, so the replay doesn't keep them down.
* At the end of a recording a game may write `<file.jsonl>.state.json`: its final snapshot (or just its
  `state`). `witness replay` then compares the replay's final state to it field by field and fails on any
  difference — the proof that the recording replays exactly.
* `witness replay` plays the file back through `reset(seed, scene, params)` + `input` + `step(dts)`.
* Replays written by an agent playtest (`witness play`, see [PLAYTEST.md](PLAYTEST.md)) use the same format. Their
  header has `"source": "witness play"` and `"session": "<name>"`, and their frame lines are sparse: only frames with
  input, marks or calls, plus the last stepped frame (missing frames ran at `1/fps`).
* `calls` (optional, CLI-side): a frame line may carry `"calls": [["name", arg, ...], ...]`. Only
  `witness play` writes it, when calls were allowed (`--allow-calls`) and the tester ran a game `call`. `witness replay` (and `trace --replay`)
  run those calls when the replay reaches that frame, before stepping it. Adapters never write it, and it needs the
  `call` capability to replay.

## 6. Determinism checklist (for adapter authors and game code)

1. Seed every random generator from the `reset` seed. No wall-clock randomness and no
   `time()` in gameplay.
2. Simulate only on `step`, with the given dt. Never read real elapsed time in witness mode.
3. Iterate collections in a stable order: hash maps with randomized ordering need care.
4. Asynchronous work (worker threads, loading, streaming, texture baking) must finish before
   `step` returns, or be joined per frame. Never budget work by wall-clock milliseconds in witness
   mode (a "do 8 ms of work per frame" loop does a different amount each run): do it all, or a fixed
   count.
5. `reset` must clear **everything** a run can leave behind: timers, id counters, caches, particle
   clocks, UI/menu state, held keys and fingers, audio voices, and any texture or render cache whose
   contents depend on what was drawn. Rebuilding the game/view objects from scratch is the safe way.
6. Pin anything that comes from the machine: window/canvas size (settings files, environment
   variables, the display), locale, the save folder.
7. `witness doctor` checks this: a scripted run, a *different* run, then the first run again in the
   same process must give identical state, `digest`, screenshot and audio. For long scenarios (a
   journey, a fight) use `"match"` steps in tests or `witness test --repeat 2`, which compares every
   step of every test against the first pass.

## 7. Optional stdio transport

If TCP is impossible, set `"transport": "stdio"` in `witness.json`. The CLI then talks over
the child's stdin and stdout. Protocol lines must start with the two characters `@w`
(e.g. `@w{"id":1,...}`); other stdout lines are treated as game logs.

## 8. Versioning

`hello.protocol` is the integer version. The CLI supports v1. Future versions will be
additive: unknown fields must be ignored, and unknown commands must answer with
`ok: false`.

## 9. Watch mode (`WITNESS_WATCH=1`)

`witness play start --watch` launches the game with `WITNESS_WATCH=1` (and `WITNESS_ADDR` as always) so a person can
watch an agent play it live. It's optional: a game that ignores it still works, it just stays hidden. A game that
supports it:

* **shows its window** (headless runs keep it hidden or offscreen; on Windows the CLI starts processes with the first
  window hidden, so show it explicitly);
* **presents frames** as it steps: render and flip after each `step` (every 2nd frame is fine), so the window shows
  what the simulation is doing;
* **drops real input**: only Witness-injected input reaches gameplay, so a viewer's stray key or click can't change a
  run whose replay must stay exact;
* **stays responsive while idle**: between commands keep pumping window events (so the OS doesn't mark it "not
  responding" and the window can be moved); the Python adapter's `witness.run(..., idle=fn)` calls `fn` about every
  30 ms while it waits;
* **does not pace itself**: the daemon paces live play to real time and sends small steps; the game steps as fast as
  it's asked, exactly as in headless runs, and never reads the wall clock for gameplay.

Watch mode must not change the simulation: the same seed and inputs give the same state with or without it.
