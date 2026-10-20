# Witness for Python: integration guide (for Claude)

You are wiring Witness into a Python game you may not know yet. The adapter is a single
stdlib-only module, `witness.py` (Python 3.8+), plus an optional `witness_pygame.py` for
pygame / pygame-ce. Witness launches the game with `WITNESS_ADDR=127.0.0.1:<port>`. The game
connects, says hello, and from then on **only advances when told to**: `witness.run(...)` owns
the loop and calls your handlers.

| handler passed to `witness.run` | enables / contract |
|---|---|
| `update(dt)` (required) | `step`: advance **exactly one** frame of `dt` seconds |
| `snapshot()` (required) | `snapshot`: a JSON-able dict (expose `entities`, see section 6) |
| `reset(seed[, scene[, params]])` | `reset`: deterministic initial state for that seed |
| `on_input(event)` | input, called at the start of the event's frame (else poll `witness.is_down(key)` / `witness.input_events()`) |
| `screenshot([scale])` | `screenshot`: return `(width, height, rgba_bytes)` |
| `audio=witness.AudioCapture(...)` | `audio`: the adapter advances and resets it for you |
| `calls={"name": fn}` | `call`: the hello lists each call's argument names and the first line of its docstring |
| `namespace=` dict or callable | `eval` (default: `__main__`'s globals) |
| `perf()` | adds fields to `perf` (`update_ms` / `render_ms` are measured automatically) |

The working reference is `examples/python/coins.py`, with a pygame variant in
`examples/python/pygame/coins_pygame.py`. Read the one closer to your game first.

Work in this order, checking each step with `witness doctor`:
**connect → step + snapshot → input → reset/seed → screenshot → audio → recording.**

---

## 1. Install

`witness init` copies `witness.py` and `witness_pygame.py` next to the main script, so a plain
`import witness` works (a regular module beats the `witness/` test folder). Games run as a
package (`python -m mygame`) should import it from the package or put it on `sys.path`.

`witness.json`:
```json
{ "name": "mygame", "launch": { "command": "python", "args": ["main.py"] }, "tests": "witness", "seed": 1 }
```
Use the interpreter the game needs (`"py"`, `".venv/Scripts/python"`, `"python3"` …). Paths are
relative to the folder that holds `witness.json`.

## 2. Where to hook in

Put the check at the top of the entry point, **before** creating a window, opening audio or
loading saves:

```python
import witness

def main():
    game = Game()
    if witness.active():                      # WITNESS_ADDR set or --witness passed
        witness.run(name="My Game", fps=60, size=(640, 360), engine="pygame",
                    reset=game.reset, on_input=game.on_input, update=game.update,
                    snapshot=game.snapshot, screenshot=game.rgba, audio=game.capture,
                    calls={"teleport": game.teleport})
        return                                # run() returns after the CLI says quit
    game.run_realtime()
```

* Logs: `witness.info/warn/error(msg)`. These are no-ops when inactive. Errors fail tests. While
  `run` serves, the root `logging` logger also forwards records at its configured level
  (`capture_logging=False` turns that off).
* An exception in any handler is caught. The CLI gets `ok:false` with the game's own
  traceback frames, and an error log line fails the test, so the process doesn't crash.
* Saves and settings: write to `tempfile.mkdtemp()` in witness mode. **Never open dialogs**
  (tkinter message boxes, `input()`): nobody is there to answer them.

## 3. Restructure the loop: step only on command, fixed dt

Most games have `while running: events → update(clock.tick()/1000) → draw → flip`. Split it so
one function advances one frame from a given dt, and let the real-time loop and Witness both
call it:

```python
def frame(dt):                       # events + update (+ draw if that's cheap)
    for e in pygame.event.get(): handle(e)
    update(dt)
    draw()

def run_realtime():
    clock = pygame.time.Clock()
    dt = 1 / 60
    while True:
        frame(dt)
        pygame.display.flip()
        dt = min(clock.tick(60) / 1000, 0.1)

# witness mode: witness.run(update=frame, ...): no clock, no sleep, no flip
```

Rules in witness mode: never read `time.time()`, `time.perf_counter()`, `pygame.time.get_ticks()`
or `clock.tick()` results in gameplay; use the `dt` you're given or `witness.time()`. Threads
started by the game must finish before `update` returns.

## 4. Input through the game's normal path

`on_input(event)` gets protocol events (`{"type": "key", "key": "right", "down": True}`, `mouse`,
`wheel`, `text`, `action`, `pad`, `axis`, `touch`; see docs/PROTOCOL.md §4) at the start of their frame,
before `update(dt)`. Feed them into whatever the game already uses:

* Own key set: `self.keys.add(e["key"])` / `discard` (coins.py does this).
* An input-mapping layer: on `"action"` events call `actions.press(e["action"])`.
* pygame: use `witness_pygame.Bridge` (section 9). It posts real `KEYDOWN`/`MOUSEBUTTONDOWN`
  events and patches `pygame.key.get_pressed()`, so the game code doesn't change.

No handler? Poll `witness.is_down("space")` or read `witness.input_events()` inside `update`.
Mouse coordinates are logical game pixels with the origin at the top left. If the window is
scaled, the game must undo the scale when it records input.

**Touch.** `{"type": "touch", "id": 0, "x": 160.0, "y": 90.0, "phase": "down", "pressure": 1.0}`:
`id` is the finger (0 = first finger down), `x`/`y` are the same logical pixels as the mouse,
`phase` is `"down"` / `"move"` / `"up"` / `"cancel"` (fields are defaulted for you; `"cancel"` is a
touch the system ended, e.g. SDL's FINGER_CANCELED: it ends the finger like `"up"` but isn't a
completed tap). By default finger 0 is also delivered as the matching mouse event right after it
(`down` → button 0 down, `move` → move, `up` or `cancel` → button 0 up), marked `"from_touch": True`, so touch tests (`touch:160,90@1`,
`swipe:40,90->200,90@1-1.5`) drive mouse-only games. A game with its own touch handling passes
`witness.run(..., touch=True)`: it then gets only the touch events, and the hello says
`"touch": true`. With `witness_pygame.Bridge`, touch arrives as real `FINGERDOWN` / `FINGERMOTION` /
`FINGERUP` events (a cancel posts `FINGERUP`: pygame has no cancel event; normalized 0..1 `x`/`y`/`dx`/`dy`, `finger_id` = the Witness id) and the fallback as
`MOUSE*` events with `touch=True`, exactly like pygame on a phone.

## 5. RNG seeding

Every random choice must come from an RNG seeded in `reset(seed)`:

```python
def reset(self, seed=1, scene=None, params=None):
    self.rng = random.Random(seed)       # never module-level random.random() in gameplay
    random.seed(seed)                    # if legacy code uses the global RNG
    # numpy: self.np_rng = numpy.random.default_rng(seed)
    self.build_level(scene or "level1")
```

`reset` must rebuild **all** gameplay state, including timers, caches and singletons. Without a
`reset` handler, Witness restarts the process for every run, which works but is slow.

## 6. Expose state (`snapshot`)

```python
def snapshot(self):
    return {"scene": self.scene, "score": self.score, "player": self.player,
            "entities": [{"id": e.id, "type": type(e).__name__, "pos": [e.x, e.y], "hp": e.hp}
                         for e in self.world.entities]}
```

* `entities = [{"id", "type", "pos": [x, y(, z)]}]` unlocks `count('Coin')`, `first()` and `near()` in tests.
* Values are made JSON-safe for you by `witness.json_safe`: NaN/inf become strings, tuples and
  sets become lists, and dataclasses, namedtuples, enums and objects with `witness_state()` or a
  `__dict__` become dicts. You can still return plain data so the snapshot stays readable.
* Ids must be stable across runs. Don't use `id(obj)` or other memory addresses.

## 7. Screenshots

Return `(width, height, rgba_bytes)` with rows top to bottom (or a protocol dict such as
`{"format": "png", ...}`). Render on demand inside the handler:

* pygame: `pygame.image.tobytes(surface, "RGBA")` (`tostring` before pygame 2.1.3), or
  `Bridge.screenshot`.
* Pyglet / Arcade (OpenGL): draw the frame, then
  `pyglet.image.get_buffer_manager().get_color_buffer().get_image_data().get_data("RGBA", -w*4)`.
  The negative pitch flips GL's bottom-up rows. With Arcade, call `window.on_draw()` first, or
  use `arcade.get_image()` (PIL) and pass it to `.tobytes()`.
* No renderer (simulation-only games): rasterize simple shapes into a `bytearray`, as coins.py
  does, or leave `screenshot` out.

## 8. Audio capture

There's no portable way to tap a real audio device, so **mix in software**:
`witness.AudioCapture(sample_rate, channels)` is a float buffer that advances with simulated time.
Make every sound go through one function that, in witness mode, mixes the sound's samples into
the capture instead of playing them:

```python
capture = witness.AudioCapture(22050, 1)

def play(sound_samples, volume=1.0):     # the game's single "play a sound" entry point
    if witness.active():
        capture.play(sound_samples, volume)   # floats in -1..1, interleaved, starting now
    else:
        device_play(sound_samples, volume)
```

* Pass `audio=capture` to `run`. Witness calls `advance(dt)` after each frame and `reset()` on
  reset. `take()` returns exactly the samples for the simulated time since the last call, and
  tails that run past "now" carry over to the next call.
* Raw s16 PCM (e.g. `pygame.mixer.Sound.get_raw()`): `capture.play_pcm16(raw, channels=2)`.
  Initialize the mixer at the capture's sample rate.
* Music or streams: decode once (`wave` module, or `Sound.get_raw()`) and feed the samples in
  chunks per frame, e.g. `capture.play(music[i:i+n])` with `n = round(dt * rate) * channels`,
  advancing `i` each frame.
* Name your sounds: `witness.sound("coin")` (optionally `volume`, `pos=(x, y)`) next to `play` sends a
  `{"event": "sound"}` line in witness mode (docs/PROTOCOL.md §3), so `witness listen` names the sound and checks that
  each input or state change got its sound. It does nothing when Witness isn't driving the game.

## 9. pygame / pygame-ce (`witness_pygame.py`)

```python
import witness, witness_pygame as wp
wp.prepare()                    # BEFORE pygame.init(): SDL dummy video/audio drivers in witness mode
import pygame
pygame.mixer.pre_init(frequency=22050, size=-16, channels=1)
pygame.init()
screen = pygame.display.set_mode((W, H))      # still fine under the dummy driver
capture = witness.AudioCapture(22050, 1)
bridge = wp.Bridge(canvas, capture)           # canvas: the Surface the game draws on

def play(sound): bridge.play(sound)           # mixes Sound.get_raw() in witness mode, plays otherwise

witness.run(..., on_input=bridge.inject, update=frame, screenshot=bridge.screenshot, audio=capture,
            reset=lambda seed: (bridge.reset(), game.reset(seed)))
```

* `Bridge` (witness mode) patches `pygame.key.get_pressed`, `pygame.key.get_mods`,
  `pygame.mouse.get_pos` / `get_pressed` and `pygame.time.get_ticks` (simulated ms). Code that
  did `from pygame.key import get_pressed` keeps the original, so change it to
  `pygame.key.get_pressed()`.
* Key names map through `wp.key_code(name)` / `wp.key_name(code)`. `wp.event_to_witness(e)`
  converts real events for recording: `FINGER*` become touch events in logical pixels (pass
  `size=` if the display surface isn't the logical size) with small ids, and mouse events with
  `e.touch` set return `None` (replay recreates them from the touch).
* Touch normalization: `wp.Bridge(..., size=(W, H))` sets the size injected touch pixels are divided
  by; by default the hello `size`, else the surface's size.
* `wp.FixedClock(60)` is a drop-in for `pygame.time.Clock` whose `tick()` never sleeps. Use it in
  witness mode if `clock.tick()` is buried deep in the code.
* `pygame.mixer` output can't be captured, hence `bridge.play`. If the game calls
  `sound.play()` in many places, add a single `play()` helper first. To read samples as arrays,
  `pygame.sndarray.array(sound)` also works (needs numpy).

### Watch mode (WITNESS_WATCH=1)

`witness play start --watch` launches the game with `WITNESS_WATCH=1` so a human can watch the
session live; `witness.watching()` is true then. The CLI steps the game continuously and paces it
to real time, so the game must **not** pace itself (no `clock.tick`, no sleep). A watched game:

* shows its window (keep the real video driver: `wp.prepare(headless=not witness.watching())`);
* presents a frame every step (or every 2nd step) from `update`;
* drops the viewer's real input: only Witness-injected events may reach the game;
* passes `idle=` to `witness.run` to pump window events while waiting for the next command
  (called about every 30 ms; commands are then read on a background thread).

```python
if witness.watching():
    pending, real_get = [], pygame.event.get
    pygame.event.post = lambda e, *a, **k: pending.append(e) or True   # the Bridge's events
    def get(*a, **k):
        real_get()                                   # pump the window, drop real input
        out = pending[:]; del pending[:]; return out
    pygame.event.get = get
    def watched(dt):
        frame(dt); window.blit(canvas, (0, 0)); pygame.display.flip()
    witness.run(..., update=watched, idle=real_get)
```

Nothing changes when `WITNESS_WATCH` isn't set. Drawing must not change game state, so a watched
session still replays exactly.

## 10. Arcade and Pyglet

Both own the loop through `pyglet.app.run()` / `arcade.run()`. In witness mode **don't call it**.
Drive the window yourself:

```python
from pyglet.window import key as K
KEYMAP = {"left": K.LEFT, "right": K.RIGHT, "up": K.UP, "down": K.DOWN, "space": K.SPACE,
          "enter": K.ENTER, "escape": K.ESCAPE}          # plus letters: getattr(K, name.upper())

window = MyWindow(visible=False)                     # arcade.Window / pyglet.window.Window

def on_input(e):                                     # through the window's own handlers
    if e["type"] == "key":
        code = KEYMAP.get(e["key"]) or getattr(K, e["key"].upper())
        (window.on_key_press if e["down"] else window.on_key_release)(code, 0)

def update(dt):
    window.dispatch_events()                         # keep the OS happy (ignore what it returns)
    window.on_update(dt)                             # pyglet: your own update(dt)

witness.run(update=update, on_input=on_input, screenshot=grab_rgba, snapshot=state, ...)
```

Unschedule `pyglet.clock.schedule_interval` callbacks, or call them yourself from `update`.
Pyglet's `KeyStateHandler` is a dict, so set `keys[key.RIGHT] = True` from `on_input`. A hidden
window (`visible=False`) still renders for screenshots.

## 11. Replay recording

Normal play with `WITNESS_RECORD=<file.jsonl>` set writes a replay that `witness replay` re-simulates:

```python
witness.start_recording("My Game", fps=60)  # writes the header
game.reset(witness.seed())                  # seed from WITNESS_SEED, else random; it's in the header
while running:
    events = [...]                          # this frame's input, in protocol shapes
    if f8_pressed: witness.mark("F8")
    game.update(dt)
    witness.record_frame(dt, events)        # one line per frame, full-precision dt
```

Lines reach the disk as they are written, so a crash keeps the whole recording. At the end of play,
`witness.write_end_state(game.state())` writes `<file.jsonl>.state.json` (the state the recording
ended in), and `witness replay` then checks the replay ends in exactly that state.
All of these are no-ops unless `witness.recording()` is true. The replay applies each frame's
events **before** that frame's update, so record them in the same frame you applied them.
From an event pump you can also queue events as they arrive with `witness.record_event(e)` /
`witness.record_touch(id, x, y, phase)`; the next `record_frame` writes them first.

Touch: record the fingers (logical pixels, ids from 0, stable until `"up"`; a touch the system ended
is `"cancel"`) and never the mouse
events the platform synthesizes from them (pygame: skip events with `e.touch`; `wp.event_to_witness`
does both). On replay the mouse fallback recreates those mouse events, so recording both would
deliver them twice. Mouse events marked `"from_touch"` are dropped by `record_frame` for you.
`coins.py --demo` is a scripted example that CI replays and compares to 4 decimal places.

## 12. Determinism pitfalls (Python-specific)

* **`hash()` randomization**: iterating a `set` of strings, or a dict built from one, changes order
  between processes (PYTHONHASHSEED). Sort before iterating, or use dicts and lists, which
  keep insertion order.
* `random.random()` at import time, `uuid4()`, `id()` / `hash()` ids, `time.time()` timers,
  `datetime.now()` in gameplay.
* Float `dt` accumulation is fine (it's identical run to run). What breaks it is mixing in a
  measured dt.
* Lazy initialization on first use (caches keyed by `id`, singletons) that survives `reset`:
  clear it in `reset`.
* Threads or asyncio tasks advancing state between steps: join them inside `update`.
* pygame: `pygame.time.get_ticks()` / `Clock` in gameplay (the Bridge patches `get_ticks`
  only), `pygame.event.get()` returning OS events (under the dummy driver there are none).

## 13. Verify

```
witness doctor        # connection, capabilities, determinism, screenshot, audio
witness eval --keys   # every snapshot path the game exposes
witness test          # the coins.witness.json-style tests in witness/
```

`doctor` must end with `all good`. If it says "NOT deterministic", it lists the differing
paths: find what feeds them (section 12). "no game connected": the entry point didn't reach
`witness.run`, so check that `witness.active()` runs before any window or menu code.
