# Witness for Rust: integration guide (for Claude)

You are wiring Witness into a Rust game you may not know yet. The adapter is the `witness`
crate (std only, no dependencies). Witness launches the game with
`WITNESS_ADDR=127.0.0.1:<port>`; the game connects, says hello, and from then on **only steps
when told to**. You implement one trait, `witness::Game`, as a thin layer over the game.

The working reference is `examples/rust/src/main.rs`: a pure simulation (`Coins`), its
`Game` impl (about 60 lines), and a real-time demo that records replays. Read it first.

Work in this order and check each step with `witness doctor`:
**connect → step + snapshot → input → reset/seed → screenshot → audio → recording.**

---

## 1. Install

Copy `adapters/rust/` into the project (e.g. `witness/`; `witness init` does this) and add it as a
path dependency. Optionally put it behind a feature so release builds can drop it:

```toml
[dependencies]
witness = { path = "witness", optional = true }

[features]
default = ["witness"]
```

`witness.json` (next to `Cargo.toml`):
```json
{ "name": "mygame", "build": "cargo build --release",
  "launch": { "command": "cargo", "args": ["run", "--release", "--quiet"] },
  "tests": "witness", "seed": 1, "timeout": 180 }
```
`cargo run` rebuilds when needed. If the build takes long, launch `target/release/mygame`
directly and use `--build`. Add `"cwd"` if assets load relative to the working directory.

## 2. Where to call `active()` / `run()`

Decide at the top of `main`, **before** creating a window, opening an audio device, starting a
frame limiter, or touching the player's save files:

```rust
fn main() -> std::io::Result<()> {
    if witness::active() {
        let hello = witness::Hello::new("My Game")
            .engine("custom wgpu")
            .fps(60)
            .size(1280, 720)
            .call("teleport", "x y", "move the player")
            .screenshot()          // only if you implement Game::screenshot
            .audio(48_000, 2);     // only if you write audio in Game::step
        let mut game = WitnessGame::new(1);            // headless: no window, no audio device
        return witness::run(&hello, &mut game);        // serves commands until quit
    }
    run_normally()
}
```

* For engines that must keep pumping an OS event loop, use `Connection` instead of `run`:
  `let mut c = Connection::connect(&hello)?; while c.poll(&mut game, Some(Duration::from_millis(5)))? { pump_os(); }`.
* Saves and settings: use a temp directory in witness mode.
* **No windows or dialogs in witness mode** (it runs unattended). `Connection::connect` turns off
  Windows crash dialogs. Also skip the game's own message boxes (`rfd`, `native-dialog`, panic
  popups); log with `witness::error` instead, or let the panic print and exit.
* Logs: `witness::info/warn/error(msg)` from anywhere (thread-safe, no-op when inactive).
  If the game uses the `log` crate, forward `log::error!` to `witness::error` in your logger
  impl. Errors fail tests.

## 3. The main loop in witness mode

Witness owns time. `Game::step` runs **exactly one** fixed frame of `step.dt` seconds. There's
no `Instant::now()`, no sleep, no vsync and no accumulator. Normal loop vs. witness:

```rust
// normal (unchanged)
loop {
    pump_events(&mut input);
    acc += clock.tick().min(0.25);
    while acc >= FIXED_DT { world.update(FIXED_DT, &input); acc -= FIXED_DT; }
    renderer.draw(&world);
}

// witness: the SAME update, called by the adapter
impl witness::Game for WitnessGame {
    fn step(&mut self, s: &mut witness::Step) {
        self.world.update(s.dt, &self.input);
        self.render_audio(s);                       // section 7
    }
    // ...
}
```

* A `step 600` command calls `step` 600 times. Don't render there; render in `screenshot`.
* Anything else that changes state per frame (timers, tweens, scripted events) runs inside
  `step`, with `s.dt`.
* Background work (asset loading, pathfinding threads) must finish before `step` returns.
  Load synchronously in witness mode.

## 4. Input through the normal path

The adapter delivers each event to `Game::input` at the start of its frame, before `step`.
Route it into the same function the window event loop feeds:

```rust
fn input(&mut self, e: &witness::Input) {
    use witness::Input::*;
    match e {
        Key { key, down } => self.input.on_key(key_from_witness(key), *down),
        Mouse { pos, button, down, .. } => {
            if let Some((x, y)) = pos { self.input.on_cursor(*x as f32, *y as f32); }
            if let (Some(b), Some(d)) = (button, down) { self.input.on_button(*b, *d); }
        }
        Wheel { dy, .. } => self.input.on_wheel(*dy as f32),
        Text(t) => self.input.on_text(t),
        Action { action, down } => self.input.on_action(action, *down),
        Touch { id, x, y, phase, pressure } => self.input.on_finger(*id, *x as f32, *y as f32, *phase, *pressure as f32),
        _ => {}
    }
}
```

**Touch.** `Input::Touch { id, x, y, phase, pressure }` is one finger: `id` 0 is the first finger
down (it keeps its id until `TouchPhase::Up` or `Cancel`), `x`/`y` are logical pixels like the
mouse, `phase` is `TouchPhase::Down` / `Move` / `Up` / `Cancel`, `pressure` is 0..1 (1 when not
given). `Cancel` is a touch the system ended (SDL's FINGER_CANCELED, winit's `TouchPhase::Cancelled`):
it ends the finger like `Up` (`phase.ends()` is true for both), but it isn't a completed tap. By
default finger 0 is **also** delivered as `Input::Mouse` right after each touch event (down →
button 0 down, move → move, up or cancel → button 0 up) with `from_touch: true`, so touch tests
(`touch:160,90@1`, `swipe:40,90->200,90@1-1.5`) drive mouse-only games too. A game with real
touch handling (on-screen sticks, gestures) calls `Hello::touch()`: it then gets only the
touch events (the hello says `"touch": true`). If the engine wants normalized 0..1 touch
coordinates (winit gives window pixels, SDL normalized), convert from the logical size.
Polling games can read `s.touch(id)` (`Some((x, y))` while the finger is down).

* Key names are lowercase Witness names (`a`–`z`, `0`–`9`, `space`, `enter`, `escape`, `left`, `f1` ...).
  `witness::normalize_key(&format!("{:?}", key))` maps most engine names (winit
  `KeyCode::ArrowLeft` → `left`, `KeyA` → `a`, `Space` → `space`, `ShiftLeft` → `shift`).
* Games that poll instead can read `s.key_down("right")`, `s.mouse()` and `s.events` inside `step`.
* Mouse positions are logical pixels, top-left origin.

## 5. Reset and seeding

```rust
fn reset(&mut self, seed: i64, scene: Option<&str>, params: &witness::Value) -> Result<(), String> {
    self.rng = Rng::seed_from_u64(seed as u64);            // EVERY generator
    self.world = World::load(scene.unwrap_or("level1")).map_err(|e| e.to_string())?;
    if let Some(level) = params["level"].as_i64() { self.world.set_level(level as u32); }
    self.input = InputState::default();                    // nothing held from the last test
    self.voices.clear();
    Ok(())
}
```

Rebuild from scratch: the same seed and inputs must give byte-identical snapshots.
`Err("unknown scene 'x'")` is shown by the CLI.

## 6. Snapshot: expose `state.entities`

```rust
fn snapshot(&mut self) -> witness::Value {
    use witness::{obj, Value};
    let mut ents: Vec<&Entity> = self.world.entities.iter().collect();
    ents.sort_by_key(|e| e.id);                                       // STABLE order
    let entities: Value = ents.iter().map(|e| obj! {
        "id" => e.id, "type" => e.kind.name(), "pos" => [e.pos.x, e.pos.y], "hp" => e.hp,
    }).collect();
    obj! {
        "scene" => self.world.scene.as_str(),
        "player" => obj! { "id" => 0, "type" => "Player", "pos" => (self.player.x, self.player.y), "hp" => self.player.hp },
        "entities" => entities,
    }
}
```

`obj!` keeps key order. Tuples and arrays become JSON arrays, `Option` becomes a value or null,
and NaN becomes `"NaN"`. Expose what tests assert on (HP, inventory, quest flags, AI state,
the open menu), and summarize big things (particles, tiles).

## 7. Audio: render the mixer per step

Don't open an audio device in witness mode. Render exactly the samples the step covers:

```rust
fn render_audio(&mut self, s: &mut witness::Step) {
    let frames = s.audio_frames();                       // derived from simulated time: never drifts
    self.buf.resize(frames * 2, 0.0);                    // stereo interleaved
    self.synth.render(&mut self.buf);                    // the SAME fn the cpal/device callback calls
    s.write_audio(&self.buf);
}
```

With cpal, the device callback is usually
`move |data: &mut [f32], _| synth.lock().unwrap().render(data)`. Factor out `render(&mut [f32])`
and call it from both places.

## 8. Screenshots

Return RGBA8 from `Game::screenshot`. It borrows `&mut self`, so point at a buffer you own:

```rust
fn screenshot(&mut self) -> Option<witness::Image<'_>> {
    self.renderer.draw(&self.world);                       // draw the current state now
    self.renderer.read_rgba(&mut self.pixels);             // GPU -> CPU readback
    Some(witness::Image { width: 1280, height: 720, rgba: &self.pixels, stride: 0, bottom_up: false })
}
```

* **wgpu:** render to an offscreen texture (`RENDER_ATTACHMENT | COPY_SRC`), call
  `copy_texture_to_buffer` into a `MAP_READ` buffer whose `bytes_per_row` is padded to 256
  (pass that as `stride`), call `map_async`, then `device.poll(Maintain::Wait)` and read.
  `Bgra8UnormSrgb` surfaces need an R/B swap. wgpu images are top-down.
* **OpenGL (glow):** `gl.read_pixels(0, 0, w, h, RGBA, UNSIGNED_BYTE, ...)` with `bottom_up: true`.
* **Software renderers / pixel buffers (`pixels`, `softbuffer`, macroquad `get_screen_data`):**
  point at the buffer; macroquad's image is bottom-up.
* No practical readback? Leave screenshots out (don't call `Hello::screenshot()`).

## 9. Replay recording in normal play

```rust
let mut rec = witness::Recorder::from_env("My Game", 60);      // None unless WITNESS_RECORD is set
let seed = rec.as_ref().map_or_else(witness::seed, |r| r.seed());
let mut world = World::new(seed);

// event pump (winit): record what the sim will see, in Witness names
if let Some(r) = &mut rec { r.key(&format!("{:?}", physical_key), pressed); }   // F8 becomes a mark
// fixed-step loop: one line per SIM tick
while acc >= FIXED_DT { world.update(FIXED_DT, &input); if let Some(r) = &mut rec { r.frame(FIXED_DT); } acc -= FIXED_DT; }
```

One `frame(dt)` per **simulation step**, with the dt that step used. Queued events go into the
next frame line. Lines are flushed per frame, so crashes keep the replay. Play it back with
`witness replay last`.

Touch (phones, tablets, touchscreens): record each finger with
`r.touch(id, x, y, witness::TouchPhase::Down | Move | Up | Cancel)` in logical pixels, with small ids
(0 = first finger down; map winit's `Touch::id` / SDL finger ids to slots and reuse a slot
after its finger lifts). Don't also record the mouse events the platform synthesizes from
touch (SDL `which == SDL_TOUCH_MOUSEID`, winit/browser emulated mouse): on replay the mouse
fallback recreates them, so recording both would deliver them twice. `r.input(&e)` skips
`Input::Mouse { from_touch: true, .. }` for you.

## 10. Determinism checklist (Rust-specific items first)

- [ ] **`std::collections::HashMap`/`HashSet` iterate in a random order per process.** Never let
      that order affect gameplay or the snapshot: use `BTreeMap`, `Vec`, `indexmap`, or a fixed hasher.
- [ ] Every RNG is seeded from the reset seed (`rand::rngs::StdRng::seed_from_u64`), not `thread_rng()`
      or `rand::random()`.
- [ ] No `Instant::now()` / `SystemTime::now()` in the sim in witness mode.
- [ ] `rayon` / threads: the results must not depend on scheduling (sort or reduce in a fixed order).
- [ ] `reset` rebuilds everything, including `static`/`thread_local!`/`OnceLock` caches that hold game state.
- [ ] Same binary for the recording and the replay (float results can change between builds).

## 11. Bevy (guide, not compiled here)

Bevy owns the main loop through its runner. In witness mode, don't call `app.run()`. Build the
`App` yourself and call `app.update()` once per witness step, with time forced to the step's dt.
The API names below match Bevy 0.14–0.16; check the version in `Cargo.lock` and adapt.

```rust
use bevy::prelude::*;
use bevy::input::keyboard::{KeyboardInput, Key};
use bevy::input::ButtonState;
use bevy::time::TimeUpdateStrategy;
use std::time::Duration;

#[derive(Component)] struct Witnessed { id: u32, kind: &'static str }    // add to entities tests care about

fn build_app(seed: u64) -> App {
    let mut app = App::new();
    app.add_plugins((MinimalPlugins, bevy::input::InputPlugin, bevy::state::app::StatesPlugin))
        .insert_resource(GameRng::seed(seed))                          // your RNG resource
        .insert_resource(Time::<Fixed>::from_hz(60.0))                 // one FixedUpdate per step
        .add_plugins(GamePlugin);                                      // the game's own systems
    app.finish();
    app.cleanup();
    app
}

struct BevyGame { app: App, window: Entity }

impl witness::Game for BevyGame {
    fn reset(&mut self, seed: i64, _: Option<&str>, _: &witness::Value) -> Result<(), String> {
        self.app = build_app(seed as u64);                             // a fresh World: nothing leaks between tests
        self.window = self.app.world_mut().spawn_empty().id();         // stand-in window entity for input events
        Ok(())
    }
    fn input(&mut self, e: &witness::Input) {
        if let witness::Input::Key { key, down } = e {
            if let Some(code) = keycode_from_witness(key) {            // your table: "right" -> KeyCode::ArrowRight
                self.app.world_mut().send_event(KeyboardInput {
                    key_code: code, logical_key: Key::Unidentified(bevy::input::keyboard::NativeKey::Unidentified),
                    state: if *down { ButtonState::Pressed } else { ButtonState::Released },
                    window: self.window, repeat: false, text: None,    // fields vary by version
                });
            }
        }
    }
    fn step(&mut self, s: &mut witness::Step) {
        self.app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(s.dt)));
        self.app.update();                                             // runs First..Last once, FixedUpdate once
    }
    fn snapshot(&mut self) -> witness::Value {
        let world = self.app.world_mut();
        let mut q = world.query::<(&Witnessed, &Transform)>();
        let mut ents: Vec<_> = q.iter(world).map(|(w, t)| (w.id, w.kind, t.translation)).collect();
        ents.sort_by_key(|e| e.0);                                     // never rely on query order
        witness::obj! { "entities" => ents.iter().map(|(id, kind, p)| witness::obj! {
            "id" => *id, "type" => *kind, "pos" => [p.x, p.y] }).collect::<witness::Value>() }
    }
}
```

Bevy-specific determinism:
* Systems with no ordering between them can run in any order on the multithreaded executor.
  Order the gameplay systems explicitly (`.chain()`, `.before()`/`.after()`), or in witness
  mode use `app.edit_schedule(Update, |s| { s.set_executor_kind(bevy::ecs::schedule::ExecutorKind::SingleThreaded); })`.
* Identify entities in snapshots by your own `id` component, not `Entity` (ids get recycled).
* `bevy_audio` plays straight to a device and can't be captured, so leave audio out. With a
  custom synth or `bevy_kira_audio`, render per step as in section 7.
* Rendering headless in Bevy is heavy (render-to-image plus readback). Start without
  screenshots; snapshots and tests matter more.

## 12. Verify

From the folder with `witness.json`, run one command at a time:

```
witness doctor            # connection, capabilities, determinism, screenshot, audio
witness eval --keys       # every snapshot path: use these in tests
witness test              # witness/*.witness.json
witness shot --at 1       # look at the PNG
```

| doctor says | likely cause |
|---|---|
| `no game connected` / `exited before connecting` | `witness::active()` not checked first, wrong `launch`, a panic in headless init (see the output tail), or a `cargo run` build error |
| `NOT deterministic` | `HashMap` iteration, unseeded RNG, `Instant::now()`, unordered Bevy systems, state not cleared in `reset` |
| `audio returned no samples` | `Hello::audio` set but `Step::write_audio` never called |
| `didn't answer 'step'` | `step` blocks (vsync, a channel waiting on a thread that isn't running) |

## API summary

| item | purpose |
|---|---|
| `witness::active()` | `WITNESS_ADDR` set or `--witness` |
| `witness::run(&Hello, &mut impl Game)` | connect + serve until quit |
| `Connection::connect(&Hello)` / `.poll(&mut game, timeout)` | pumped variant |
| `trait Game { reset, input, step, snapshot, screenshot, call, eval, perf }` | the hooks |
| `Step { dt, frame, time, events }`, `.key_down()`, `.mouse()`, `.touch(id)`, `.audio_frames()`, `.write_audio()` | per-step context |
| `Input::{Key, Mouse, Wheel, Text, Action, Pad, Axis, Other, Touch}`, `TouchPhase`, `Input::is_from_touch()` | input events |
| `Hello::new(name).fps().size().call().keys().screenshot().audio().eval().perf().touch()` | the hello (`touch()`: no mouse fallback for finger 0) |
| `Value`, `obj!`, `arr!` | JSON |
| `witness::info/warn/error/log` | logs (errors fail tests) |
| `Recorder::from_env(name, fps)`, `.seed()`, `.key()`, `.mouse()`, `.touch()`, `.input()`, `.mark()`, `.frame(dt)` | replays |
| `witness::seed()`, `witness::normalize_key()`, `witness::base64()` | helpers |
