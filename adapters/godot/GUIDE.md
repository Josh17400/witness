# Witness for Godot 4 (GDScript): integration guide (for Claude)

You are wiring Witness into a Godot 4 project you may not know yet. The adapter is one autoload,
`Witness.gd`, plus `witness_logger.gd`, which forwards engine and script errors on Godot 4.5+.
Witness launches the game with `WITNESS_ADDR=127.0.0.1:<port>`. The autoload connects, says
hello, and from then on **the engine only advances when Witness says `step`**. C# projects
use the `godot-csharp` adapter instead.

Most projects need **no gameplay code changes** to connect: register the autoload and launch
with the right flags, and `witness doctor` works. Real tests then need state (section 6).
The working reference is `examples/godot/` (`main.gd`), so read it first.

Work in this order, checking each step with `witness doctor`:
**connect → step + snapshot → input → reset/seed → screenshot → audio → recording.**

---

## 1. Install

`witness init` copies the files to `res://addons/witness/`. Then register the autoload. Put it
**first** in the `[autoload]` list so it runs before every other node:

```ini
; project.godot
[autoload]
Witness="*res://addons/witness/Witness.gd"
```

(Or use Project Settings → Autoload, name `Witness`.) Requires Godot 4.2+. Tested on 4.7.2.

`witness.json`:
```json
{ "name": "mygame",
  "launch": { "command": "godot",
              "args": ["--path", ".", "--rendering-driver", "opengl3", "--fixed-fps", "60",
                       "--write-movie", "user://witness.avi"] },
  "tests": "witness", "seed": 1, "timeout": 60 }
```

* `command`: the Godot binary (`Godot_v4.x-stable_win64_console.exe` on Windows, so the
  output reaches the CLI). Use the exported game executable for release builds.
* `--fixed-fps 60` (**required**): every engine iteration becomes exactly one 1/60 s step of
  physics and process, with no wall clock involved. Match the project's
  `physics/common/physics_ticks_per_second`.
* `--write-movie user://witness.avi` (recommended): Movie Maker mode makes the AudioServer mix
  exactly 1/60 s of audio per frame, so captured audio is exact and identical across resets
  (section 8). It writes a small MJPEG file in `user://`, overwritten each launch. Leave it out
  if you don't need audio.
* `--rendering-driver opengl3` (or the project's renderer): needed for screenshots and Movie
  Maker. For the fastest runs with no screenshots or audio, use `["--path", ".", "--headless",
  "--fixed-fps", "60"]`; `screenshot` is then not advertised. On Linux CI, wrap the whole
  `witness` command in `xvfb-run -a` when not headless.

The window is moved off-screen and made borderless in witness mode
(`WITNESS_SHOW_WINDOW=1` keeps it visible). It is never minimized: Godot stops rendering
minimized windows.

## 2. How stepping works (and why the game needs no loop changes)

When inactive, the autoload calls `set_physics_process(false)` and `set_process(false)` in
`_enter_tree`, so it costs nothing. In witness mode it runs `PROCESS_MODE_ALWAYS` at the
lowest `process_physics_priority`, so its `_physics_process` is the first callback of every
iteration:

1. **Idle** (no step pending): it answers commands (`snapshot`, `input`, `call`, `screenshot`
   …) inside that callback, **blocking the main loop** until a `step` arrives. While idle nothing
   simulates and nothing renders.
2. **step N**: it applies the frame's queued input (`Input.parse_input_event` +
   `Input.flush_buffered_events()`), returns, and the rest of the iteration (every node's
   physics, process and the render) is frame 1. At the start of each following iteration it
   counts the frame done and injects the next frame's input. After N frames it replies and goes
   idle again.
3. **reset**: it clears the logs and releases held input. With Movie Maker (`--write-movie`)
   it then pauses the tree, stops the sound players of the scene it is about to free, and waits
   (paused, at most 2 × 16 frames at 48000 Hz and 60 fps) until the audio mixer is at the same
   point of its 512-frame block cycle as on every reset (section 8). Then it seeds, re-creates
   the audio bus effects, calls `get_tree().reload_current_scene()` (or
   `change_scene_to_file(scene)` when the test passes `scene`), keeps the tree paused for the
   deferred scene swap, and calls `witness_reset(seed, scene, params)` on nodes in the
   `"witness"` group. With Movie Maker, one more paused frame mixes (and drops) the fade-out of
   any sound `witness_reset` stopped. Then it replies. What the reset logs (the new scene's
   `_ready`, `witness_reset`) belongs to the new run.

Web exports can't block (browsers are single-threaded), so there the autoload pauses the tree
(`get_tree().paused`) between steps instead. It connects with `WebSocketPeer` to the address
in the page URL (`?witness=127.0.0.1:7357`); `witness.json` uses `{"launch": {"url": ...}}`.
The web path is written to the protocol but **not yet verified** by a run. Check it with
`witness doctor` before you rely on it.

Custom `dt`/`dts` in `step` are ignored: Godot frames always advance by 1/fps. Replays
recorded from Godot use that fixed step anyway.

## 3. Input through the normal path

Witness events become real `InputEvent`s pushed through `Input.parse_input_event`, so
`_input`, `_unhandled_input`, `Input.is_action_pressed`, `Input.get_axis`,
`is_action_just_pressed` and GUI controls all see them:

| Witness event | Godot event |
|---|---|
| `key` (`right`, `space`, `a`, `f1`, `enter`, `ctrl`…) | `InputEventKey` with both `keycode` and `physical_keycode` set (InputMap bindings of either kind match), plus `unicode` for printable keys |
| `mouse` x, y (+ button 0/1/2, down) | `InputEventMouseMotion` / `InputEventMouseButton` (left/middle/right) at window coordinates |
| `wheel` dy | `MOUSE_BUTTON_WHEEL_DOWN/UP` press + release, `factor = |dy|/100` |
| `text` | `InputEventKey` per character (`unicode` only) |
| `action` jump (down) | `InputEventAction` (warns if the InputMap has no such action) |
| `pad` a/b/x/y/start/dpup… | `InputEventJoypadButton`, device 0 |
| `axis` leftx/lefty/… value | `InputEventJoypadMotion` |
| `touch` id, x, y, phase down/up | `InputEventScreenTouch` (`index` = id, `pressed`) |
| `touch` phase cancel | `InputEventScreenTouch` with `pressed = false`, `canceled = true` (the system ended the touch; recorded back as `cancel`) |
| `touch` phase move (+ pressure) | `InputEventScreenDrag` (`index`, `position`, `relative` from that finger's last position, `pressure`) |

Coordinates: with `display/window/stretch/mode = "viewport"`, window pixels equal logical pixels.
With other stretch modes, inject window coordinates (the Viewport transforms them).
`Witness.input_events()` returns the events applied this frame.

**Touch** (`touch:160,90@1`, `swipe:40,90->200,90@1-1.5`, `touch2:` for a second finger) arrives
as `InputEventScreenTouch`/`InputEventScreenDrag`, like on a phone. The protocol's mouse
fallback is Godot's own `input_devices/pointing/emulate_mouse_from_touch` (on by default): Godot
then also sends the first finger down (normally id 0) as `InputEventMouseButton`/`MouseMotion`
with `device == -1` (`InputEvent.DEVICE_ID_EMULATION`), so mouse-driven UI and gameplay work with
touch tests. A game that handles touch itself turns that setting off; the hello then says
`"touch": true` and only the touch events arrive. Fingers still down at `reset` are lifted.

## 4. RNG seeding

On reset the autoload calls the global `seed(seed)` (so `randi()`/`randf()` are deterministic)
**before** reloading the scene, and exposes the value as `Witness.seed`. Every
`RandomNumberGenerator` you create must be seeded from it:

```gdscript
var rng := RandomNumberGenerator.new()
func _ready() -> void:
	rng.seed = Witness.seed        # never randomize() in gameplay
```

Never call `randomize()` in witness mode (`if not Witness.active: randomize()`).

## 5. Reset strategies

* **Default:** reload the current scene. This works when the main scene builds all gameplay
  state in `_ready`.
* **Autoload state** (score, inventory, save data in other singletons) survives a reload, so
  reset it in a `witness_reset(seed, scene, params)` method on a node in the `"witness"` group,
  or let the singleton join the group itself.
* **Sounds that outlive a reload** (music players in autoloads, every player with
  `reload_on_reset = false`) are yours to stop (or restart from 0) in `witness_reset`. The
  adapter drops their fade-out before the run starts (section 8).
* **Scene names:** `reset` with `scene: "level2"` loads `res://level2.tscn` (or a full `res://`
  path).
* **No reload:** `Witness.reload_on_reset = false` (set in an autoload's `_ready`). Then only
  `witness_reset` runs and must restore everything.

## 6. Expose state

```gdscript
func _ready() -> void:
	add_to_group("witness")

func witness_state() -> Dictionary:
	return {"scene": "level1", "score": score, "player": {"id": 1, "type": "Player", "pos": $Player.global_position},
		"entities": enemies.map(func(e): return {"id": e.name, "type": "Enemy", "pos": e.global_position, "hp": e.hp})}
```

* Snapshots merge `witness_state()` from **every** node in `"witness"` (in tree order) and
  concatenate their `entities` arrays. `scene` defaults to the current scene's name.
* Zero-code entities: add nodes to the group `"witness_entities"`. Each becomes
  `{"id": meta witness_id or node name, "type": meta witness_type or class, "pos": global_position}`,
  plus whatever its optional `witness_entity() -> Dictionary` returns.
* Values are converted for you: Vector2/3/4 and Color become arrays, NaN/inf become strings,
  nodes become paths, objects become their `witness_state()` or `str()`. Keys are sorted.
* Ids must be stable: node names or your own counters, never `get_instance_id()`.

**Calls:** a method `witness_call_teleport(x, y)` on a node in `"witness"` becomes the call
`teleport`, and its argument names appear in the hello. Alternatively register one with
`Witness.add_call("give", func(item): ..., "item", "add an item")`. Arguments arrive as JSON
numbers or strings, so convert them with `float()` / `int()`.

**Eval:** `witness raw '{"cmd":"eval","expr":"scene.score"}'` runs a Godot `Expression` with
`scene` (current scene, also the base instance), `tree`, `root` and `Witness` in scope.

**Logs:** `Witness.info/warn/error("...")`. On Godot 4.5+ every `push_error`, `push_warning`,
script runtime error and engine error is forwarded automatically, so **errors fail tests**.
`print()` stays on stdout.

## 7. Screenshots

`get_viewport().get_texture().get_image()` → RGBA8 → base64. After a step the image is exactly
the last simulated frame. After `reset` or a `call` with no step since, the adapter
`RenderingServer.force_draw()`s first, but `_draw()`-based visuals only refresh when the node
calls `queue_redraw()` during a frame, so take shots after stepping at least one frame. Not
available with `--headless` (the dummy renderer has no textures).

## 8. Audio capture

In witness mode the adapter adds an `AudioEffectCapture` to the **Master** bus. `audio` returns
what was mixed since the last `audio` call or reset, as interleaved stereo f32 at
`AudioServer.get_mix_rate()`.

* **With `--write-movie`** (Movie Maker), the audio driver doesn't run in real time: every frame
  the engine mixes exactly `mix_rate / fps` frames (800 at Movie Maker's default
  `editor/movie_writer/mix_rate` of 48000 and 60 fps). Audio is then exact:
  * a reply holds exactly the simulated time × rate frames: frame × rate / fps in total since
    the reset, with the fraction carried over to the next reply (3 s → 144000 frames);
  * the same seed and input give **byte-identical** audio whatever ran before in the process
    (`witness doctor` and `witness test --repeat 2` check this).

  How: Godot mixes in 512-frame blocks, so the mixer runs up to one block ahead of the frames
  output so far (its lookahead), and a sound started during a frame begins at the next block
  boundary. The adapter follows where the mixer is in its block cycle (from how many blocks the
  capture receives each frame) and `reset` waits, paused, until it is at the same point every
  time, so each run starts on a block boundary. The lookahead waits in the adapter for the next
  reply.
* **Sound timing**: a sound started during frame k (samples k × 800 onward) begins at the first
  block boundary at or after sample k × 800, plus Godot's constant mixing latency of about 64
  frames: up to 10.7 ms late, identically every run. For sample-exact starts, set
  `editor/movie_writer/mix_rate` to a multiple of 512 × fps (61440 or 30720 at 60 fps), so every
  frame is whole blocks. Avoid rates where `mix_rate / fps` isn't a multiple of 64 (44100 at
  60 fps = 735): the block cycle is then 512 frames long and every reset waits seconds for it
  (the adapter warns).
* **Without it** (`--headless`, or no `--write-movie`), audio is captured on the wall clock (the
  dummy driver's thread), which is useless for timing and differs between runs. The hello then
  says `"audio_exact": false` and the adapter logs a warning once.
* **Reset and sounds**: the adapter stops every `AudioStreamPlayer`/`2D`/`3D` in the scene a
  reset frees (one frame early, so the fade-out is mixed and dropped during the reset) and
  re-creates every bus effect instance, so reverb, delay and compressor tails of one run never
  reach the next. Players that survive the reset are the game's: stop them in `witness_reset`
  (section 5). Re-creating effects means an `AudioEffectInstance` fetched with
  `AudioServer.get_bus_effect_instance()` before the reset (a spectrum analyzer kept in an
  autoload) goes stale: fetch it again in `witness_reset`/`_ready`, or set
  `Witness.reset_audio_effects = false` (effect tails may then leak between runs).
* Sounds must reach Master: `AudioStreamPlayer`/`2D`/`3D` on buses that route to Master.
  Captured audio is post-effects (reverb, limiter …), exactly what a player hears.

## 9. Replay recording

With `WITNESS_RECORD=<file.jsonl>` set (and no CLI), the autoload records normal play: one line
per physics frame with full-precision dt, every key, mouse, wheel and touch event from
`Window.window_input` (so events the game marks as handled still count), and F8 as a marker.
Touches are recorded as `touch` events (`ScreenTouch` → down/up, `ScreenDrag` → move, with
`pressure` when the device reports one other than 1); mouse events Godot emulated from touch
(`device == -1`) are skipped, because on replay the emulation recreates them from the touches.
It seeds the global RNG with `WITNESS_SEED` (or a clock-based seed) in `_enter_tree`, before
the main scene loads; read it from `Witness.seed`. `godot --path . -- --demo` in the example is
a scripted session that CI records and replays exactly.

## 10. Determinism pitfalls (Godot-specific)

* **`--fixed-fps` missing**: physics still ticks at 1/60, but `_process(delta)` follows the wall
  clock and the number of physics ticks per iteration varies. The adapter warns when
  `_process` delta isn't 1/fps.
* `randomize()`, unseeded `RandomNumberGenerator`s, `Time.get_ticks_msec()` /
  `Time.get_unix_time_from_system()` in gameplay, `OS.get_ticks_*`.
* Timers and tweens are fine: they advance with process/physics delta. AnimationPlayers in
  `ANIMATION_PROCESS_MANUAL` mode must be advanced by your code.
* Threads, `WorkerThreadPool` and `ResourceLoader.load_threaded_request`: wait for completion
  before using results in gameplay, or load synchronously in witness mode.
* GPU particles and shader `TIME` only affect visuals, but `GPUParticles` collision or
  readback must not feed gameplay.
* State in autoloads survives `reload_current_scene()` (see section 5), and so do sound
  players in autoloads: stop them in `witness_reset`, or the next run's audio differs.
* "audio differs" from `doctor` without `--write-movie` is expected (real-time audio, see
  section 8); with it, look for players that outlive the reset.
* Physics: Godot Physics and Jolt are deterministic for the same step sequence in the same
  build. Don't change `physics_ticks_per_second` at runtime.
* Iterating a `Dictionary` is insertion-ordered (stable). `get_children()` order changes when
  nodes are added in a different order.

## 11. Verify

```
witness doctor        # connection, capabilities, determinism, screenshot, audio
witness eval --keys   # every snapshot path
witness test          # tests in witness/
```

`doctor` must end with `all good`. If it says "no game connected", the autoload isn't
registered, the project path is wrong, or the binary isn't the console build on Windows. If it
says "NOT deterministic", check section 10 and `Witness.seed` usage. "_process delta is …"
in the logs means `--fixed-fps` is missing.
