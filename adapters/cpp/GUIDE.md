# Witness for C / C++: integration guide (for Claude)

You are wiring Witness into a C or C++ game you may not know yet. The adapter is one header,
`witness.h` (C99 / C++11, no dependencies). Witness launches the game with
`WITNESS_ADDR=127.0.0.1:<port>`; the game connects, says hello, and from then on **only steps
when told to**. Your job is to give the adapter five hooks into the engine: reset, step,
input, snapshot and (if cheap) screenshot and audio.

The working reference is `examples/cpp/`: `coins_game.h` is a pure simulation; `coins.cpp`
wires it through the C++ layer, and `coins_c.c` through the C API. Read it first; it's short.

Work in this order and check each step with `witness doctor`:
**connect → step + snapshot → input → reset/seed → screenshot → audio → recording.**

---

## 1. Install

1. Copy `witness.h` into the project (`witness init` puts it in `witness/witness.h`).
2. Add **one** new source file that compiles the implementation. Keep it separate: it pulls
   in `<winsock2.h>`, which conflicts with a plain `<windows.h>` included earlier in the
   same file.
   ```cpp
   // witness_impl.cpp (or .c)
   #define WITNESS_IMPLEMENTATION
   #include "witness.h"
   ```
3. Link: MSVC links `ws2_32` automatically. MinGW needs `-lws2_32`; Linux/macOS need
   `-pthread -lm`. CMake:
   ```cmake
   target_sources(game PRIVATE src/witness_impl.cpp)
   target_include_directories(game PRIVATE witness)
   if(WIN32)
     target_link_libraries(game PRIVATE ws2_32)
   else()
     find_package(Threads REQUIRED)
     target_link_libraries(game PRIVATE Threads::Threads m)
   endif()
   ```
4. Create `witness.json` next to the build (paths are relative to it):
   ```json
   { "name": "embervale", "build": "cmake --build build --config Release",
     "launch": { "command": "build/Release/embervale", "args": ["--witness"] },
     "tests": "witness", "seed": 1 }
   ```
   On Windows `"command"` can omit `.exe`. Add `"cwd"` if the game loads assets relative to its
   working directory.

## 2. Where to call `witness_active()` / connect

Decide the mode at the top of `main`, **before** the engine creates a window, opens the audio
device, starts a frame limiter or loads the player's save/settings:

```cpp
int main(int argc, char** argv) {
    if (witness::active(argc, argv)) return run_witness(argc, argv);  // headless, command-driven
    return run_normal(argc, argv);                                     // the game as shipped
}
```

`run_witness` does the engine init that the simulation needs (assets, script VM, world), skips
everything the player sees or hears in real time, then connects and hands control to Witness:

```cpp
int run_witness(int argc, char** argv) {
    Engine engine(EngineConfig::headless());      // no vsync, no audio device, scratch save dir
    witness_hello hello = witness_hello();        // zero-init, then fill
    hello.name = "Embervale"; hello.engine = "custom C++/SDL3";
    hello.fps = 60; hello.width = 1280; hello.height = 720;
    hello.audio_sample_rate = 48000; hello.audio_channels = 2;   // 0 = no audio capability
    static const witness_call_info calls[] = {{"gotosite", "quest|camp|cave", "teleport next to a site"}};
    hello.calls = calls; hello.call_count = 1;

    witness::Handlers h;   // fill in sections 3-8
    // ...
    if (!witness::connect(hello, h)) return 1;    // retries ~10 s, then gives up
    witness_run();                                // blocks until "quit" or disconnect
    witness_shutdown();
    return 0;
}
```

* Capabilities in the hello are derived from which handlers you set. Leave out what's not
  implemented rather than stubbing it.
* **No windows or dialogs in witness mode.** Witness runs unattended, often with the user at the
  PC. `witness_connect` already disables the Windows crash/"stopped working" boxes and the MSVC
  abort/assert dialogs (reports go to stderr). Also bypass the engine's own message boxes
  (`SDL_ShowSimpleMessageBox`, custom assert UI, "are you sure?" prompts): log with
  `witness_log(WITNESS_ERROR, ...)` and continue, or print to stderr and exit non-zero.
* Saves and settings: point the engine at a temp folder in witness mode. Tests must never
  read or overwrite the player's real files.
* If the engine **must** have a window (e.g. for a GL context), create it hidden
  (`SDL_WINDOW_HIDDEN`). If the OS event queue must keep pumping, replace `witness_run()` with
  `while (witness_poll(5)) pump_os_events_without_simulating();`.

## 3. The main loop in witness mode

Witness owns time. The game simulates exactly one fixed frame per `step` callback, at the dt it
is given. There's no clock read, no sleep, no vsync and no accumulator.

Typical engine loop (normal mode, unchanged):
```cpp
while (running) {
    pump_events(input);                       // SDL_PollEvent -> input system
    acc += clamp(now() - last, 0.0, 0.25);
    while (acc >= FIXED_DT) { sim.update(FIXED_DT, input); acc -= FIXED_DT; }
    view.render(sim, acc / FIXED_DT);         // interpolated draw
    audio.mix_to_device();                    // device callback, real time
}
```

Witness mode: the same `sim.update` is called from the step handler, and nothing else runs on
its own:
```cpp
h.step = [&](double dt) {
    sim.update(dt, input);                    // the SAME fixed update the real loop calls
    render_audio_for_step(dt);                // section 7
};
```

* `step` receives frames one at a time (a `step 600` command calls your handler 600 times),
  so `dt` is always one frame, normally `1/fps`. Replays pass the recorded real dts.
* With a sim/view split, never render in `step`. Render only in the screenshot handler, so
  stepping thousands of frames stays fast.
  A game that must render inside `step` (watch mode presents frames, a render that is hard to split out) can skip it
  while `witness_drawing()` returns 0: a step sent with `"draw": "last"` (agent playtests with `play.lazyDraw`) runs
  every frame but its last that way (docs/PROTOCOL.md §3). Rendering must never change simulation state.
* Anything the loop did per frame besides `sim.update` that affects state (script timers,
  tweens, scheduled events, particle systems that gameplay reads) must also run inside
  `step`, with the given dt.
* Asynchronous work (job threads, streaming, async loads) must be finished or joined before
  `step` returns. In witness mode, prefer loading synchronously.
* Do not call `witness_poll()` inside `step`.

## 4. Input through the engine's normal path

Witness sends protocol events (`key`, `mouse`, `wheel`, `text`, `action`, `pad`, `axis`, `touch`). The
adapter delivers each event at the start of its frame, before `step`. Feed it into the **same
function your OS event pump feeds**, so gameplay code can't tell the difference:

```cpp
h.input = [&](const witness_event& e) {
    switch (e.type) {
    case WITNESS_EV_KEY:   input.on_key(witness_to_engine_key(e.name), e.down == 1); break;
    case WITNESS_EV_MOUSE: if (e.has_pos) input.on_mouse_move((float)e.x, (float)e.y);
                           if (e.down >= 0) input.on_mouse_button(e.button, e.down == 1); break;
    case WITNESS_EV_WHEEL: input.on_wheel((float)e.dx, (float)e.dy); break;
    case WITNESS_EV_TEXT:  input.on_text(e.text); break;
    case WITNESS_EV_ACTION:input.on_action(e.name, e.down == 1); break;    // input-mapping layer
    case WITNESS_EV_PAD:   input.on_pad_button(e.name, e.down == 1); break;
    case WITNESS_EV_AXIS:  input.on_pad_axis(e.name, (float)e.value); break;
    case WITNESS_EV_TOUCH: input.on_finger(e.id, (float)e.x, (float)e.y, e.phase, (float)e.pressure); break;
    default: break;
    }
};
```

**Touch.** `WITNESS_EV_TOUCH` carries `id` (finger, 0 = first finger down), `x`/`y` (logical pixels,
like the mouse), `phase` (`WITNESS_TOUCH_DOWN` / `_MOVE` / `_UP` / `_CANCEL`; `down` is also
1 / -1 / 0, 0 for cancel too) and `pressure` (1 when not given). `WITNESS_TOUCH_CANCEL` is a touch
the system ended (SDL's `SDL_EVENT_FINGER_CANCELED`): it ends the finger like `_UP`, but don't count
it as a completed tap (or just treat it as `_UP`). By default the adapter also delivers finger 0 as a
mouse event right after each touch event (down → button 0 down, move → move, up or cancel → button 0
up), flagged
`from_touch = 1` like SDL's `SDL_TOUCH_MOUSEID`, so touch tests (`touch:160,90@1`,
`swipe:40,90->200,90@1-1.5`) drive mouse-only games too. A game with real touch handling (on-screen
sticks, multi-finger gestures) sets `hello.touch = 1`: it then gets only the touch events, like on a
phone with SDL's touch-mouse events ignored. If the game's touch code wants SDL's normalized
coordinates, divide by the logical size. Polling games can use `witness_touch(id, &x, &y)` (1 while
the finger is down).

* Key names are lowercase Witness names: `a`–`z`, `0`–`9`, `space`, `enter`, `escape`, `tab`,
  `backspace`, `shift`, `ctrl`, `alt`, `left`/`right`/`up`/`down`, `f1`–`f12`. Mouse
  coordinates are logical pixels, top-left origin. If the engine works in window pixels, scale them.
* Games that **poll** (`SDL_GetKeyboardState`, `IsKeyDown`) can put a facade in front of the
  poll: `witness_connected() ? witness_key_down("space") : real_poll(...)`. The adapter tracks
  held keys and the mouse (`witness_key_down`, `witness_mouse`) and exposes the current
  frame's events (`witness_frame_events`) during `step`.
* An alternative for SDL games: build an `SDL_Event` from the witness event and pass it to the
  engine's existing `handle_event(const SDL_Event&)`. Don't use `SDL_PushEvent`: nothing pumps
  the SDL queue in witness mode.

### Key-code mapping snippets (copy the one you need)

`witness_key_normalize()` turns any common key name into the Witness name ("Return" → `enter`,
"Left Shift" → `shift`, "A" → `a`, "ArrowUp" → `up`). Use it for engine → Witness, and a small
table for Witness → engine.

**SDL3 / SDL2** (the same code works for both):
```cpp
// engine -> witness (recording)
const char* witness_from_sdl(SDL_Keycode k, char* buf, size_t n) { return witness_key_normalize(SDL_GetKeyName(k), buf, n); }
// witness -> engine (injection). SDL_GetScancodeFromName is case-insensitive ("right" == "Right").
SDL_Scancode sdl_from_witness(const char* name) {
    static const struct { const char *w, *sdl; } alias[] = {
        {"enter", "Return"}, {"shift", "Left Shift"}, {"ctrl", "Left Ctrl"}, {"alt", "Left Alt"}, {"meta", "Left GUI"}};
    for (auto& a : alias) if (strcmp(name, a.w) == 0) return SDL_GetScancodeFromName(a.sdl);
    return SDL_GetScancodeFromName(name);   // a-z, 0-9, space, escape, tab, backspace, left/right/up/down, f1-f12
}
// SDL_Keycode from a scancode: SDL3 SDL_GetKeyFromScancode(sc, SDL_KMOD_NONE, false); SDL2 SDL_GetKeyFromScancode(sc)
```

**raylib** (key codes are GLFW codes; raylib can't inject, so use the polling facade):
```c
const char* witness_from_raylib(int k) {
    static char one[2];
    if ((k >= KEY_A && k <= KEY_Z) || (k >= KEY_ZERO && k <= KEY_NINE)) { one[0] = (char)(k >= KEY_A ? k + 32 : k); one[1] = 0; return one; }
    if (k >= KEY_F1 && k <= KEY_F12) { static char f[4]; snprintf(f, sizeof f, "f%d", k - KEY_F1 + 1); return f; }
    switch (k) {
    case KEY_SPACE: return "space"; case KEY_ENTER: return "enter"; case KEY_ESCAPE: return "escape";
    case KEY_TAB: return "tab"; case KEY_BACKSPACE: return "backspace";
    case KEY_LEFT: return "left"; case KEY_RIGHT: return "right"; case KEY_UP: return "up"; case KEY_DOWN: return "down";
    case KEY_LEFT_SHIFT: case KEY_RIGHT_SHIFT: return "shift"; case KEY_LEFT_CONTROL: case KEY_RIGHT_CONTROL: return "ctrl";
    case KEY_LEFT_ALT: case KEY_RIGHT_ALT: return "alt"; default: return "";
    }
}
bool game_key_down(int k) { return witness_connected() ? witness_key_down(witness_from_raylib(k)) : IsKeyDown(k); }
```

**SFML** (2.x shown; in SFML 3 the enum is scoped: `sf::Keyboard::Key::Left`):
```cpp
const char* witness_from_sfml(sf::Keyboard::Key k) {
    static const char* const fkeys[12] = {"f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12"};
    static char one[2];
    if (k >= sf::Keyboard::F1 && k <= sf::Keyboard::F12) return fkeys[k - sf::Keyboard::F1];
    if (k >= sf::Keyboard::A && k <= sf::Keyboard::Z) { one[0] = char('a' + (k - sf::Keyboard::A)); one[1] = 0; return one; }
    if (k >= sf::Keyboard::Num0 && k <= sf::Keyboard::Num9) { one[0] = char('0' + (k - sf::Keyboard::Num0)); one[1] = 0; return one; }
    switch (k) {
    case sf::Keyboard::Space: return "space"; case sf::Keyboard::Enter: return "enter"; case sf::Keyboard::Escape: return "escape";
    case sf::Keyboard::Tab: return "tab"; case sf::Keyboard::Backspace: return "backspace";
    case sf::Keyboard::Left: return "left"; case sf::Keyboard::Right: return "right"; case sf::Keyboard::Up: return "up"; case sf::Keyboard::Down: return "down";
    case sf::Keyboard::LShift: case sf::Keyboard::RShift: return "shift"; case sf::Keyboard::LControl: case sf::Keyboard::RControl: return "ctrl";
    case sf::Keyboard::LAlt: case sf::Keyboard::RAlt: return "alt";
    default: return "";
    }
}
```

The opposite direction (Witness → SFML/raylib) is the same table read backwards. Build it once
as an `unordered_map<std::string, Key>` from the function above.

## 5. Reset and seeding

`reset(seed, scene, params)` must rebuild the game into a state that depends **only** on its
arguments: the same seed and inputs must give byte-identical snapshots (`witness doctor`
checks this).

```cpp
h.reset = [&](long long seed, const char* scene, witness::Value params) {
    rng.seed(static_cast<uint64_t>(seed));            // EVERY generator: gameplay, loot, AI, particles that matter
    sim = Sim();                                       // fresh world; don't reuse state from the last test
    sim.load_scene(scene ? scene : "default");
    if (params["level"].exists()) sim.set_level((int)params["level"].integer());
    input.clear();                                     // no keys stuck down from the previous test
    audio.stop_all();                                  // voices from the previous test must not leak
};
```

* Use `witness_seed()` to seed anything created outside `reset`. It returns the reset seed in
  witness mode and the recorded seed during recording.
* Unknown scene → `witness::fail("unknown scene 'x' (have: a, b)")`. The CLI shows the message.
* Never seed from `time()`, `std::random_device`, addresses or thread ids in witness mode.

## 6. Snapshot: expose `state.entities`

The snapshot is the game's state as JSON. The CLI evaluates test expressions against it
(`state.player.hp > 0`, `count('Enemy') == 3`, `near(state.player.pos, 'Door')`). Conventions
that unlock the helpers: `state.entities = [{id, type, pos: [x, y(, z)], ...}]`,
`state.player`, `state.scene`.

```cpp
h.snapshot = [&](witness::Json& j) {
    j.begin_object()
        .field("scene", sim.scene_name())
        .field("time_of_day", sim.clock.hours)
        .field("quest", sim.quests.active_id());
    j.key("player").begin_object()
        .field("id", sim.player.id).field("type", "Player").field("hp", sim.player.hp)
        .key("pos").vec(sim.player.pos.x, sim.player.pos.y)
        .end_object();
    j.key("entities").begin_array();
    for (const Entity* e : sim.entities_sorted_by_id()) {      // STABLE order
        j.begin_object().field("id", e->id).field("type", e->type_name())
         .key("pos").vec(e->pos.x, e->pos.y).field("hp", e->hp).field("state", e->ai_state_name())
         .end_object();
    }
    j.end_array().end_object();
};
```

* Output must not depend on hash-map iteration order: sort, or iterate a stable container.
* Expose what a test would want to assert on: HP, inventory counts, quest flags, AI state,
  the current menu or dialog. Keep it under a few hundred KB: summarize particles and tiles,
  don't dump them.
* NaN and Inf are written as `"NaN"` / `"Infinity"` automatically. Unclosed containers are
  closed for you, but write balanced JSON anyway.
* C API equivalent: `witness_json_begin_object(w); witness_json_field_int(w, "hp", hp); ...`.

## 7. Audio: render the mixer per step, not to a device

In witness mode **don't feed an audio device from your synth** (web builds still open one, fed silence: §13).
After each step, render exactly the samples
that step covers and give them to the adapter. `witness_audio_frames_for_step(dt)` returns
that count from simulated time, so it never drifts, even with irregular replay dts.

```cpp
std::vector<float> buf;
void render_audio_for_step(double dt) {
    int frames = witness_audio_frames_for_step(dt);           // e.g. 800 at 48 kHz / 60 fps
    buf.resize((size_t)frames * 2);                           // stereo, interleaved
    synth.render(buf.data(), frames);                         // the SAME function the device callback calls
    witness_audio_write(buf.data(), frames);                  // or witness_audio_write_s16(...)
}
```

* The device callback in normal play usually looks like
  `void cb(void*, Uint8* stream, int len) { synth.render((float*)stream, len / 8); }` (SDL2) or
  an `SDL_AudioStream` get-callback that calls `SDL_PutAudioStreamData` (SDL3). Factor the
  body into `synth.render(float*, frames)` and call it from both places.
* Sound triggers fired during `sim.update` must start in the block rendered right after that
  step, which happens naturally when `render_audio_for_step` follows `sim.update`.
* If the synth runs on its own thread with a lock, take the same lock in
  `render_audio_for_step`. The adapter's buffer is thread-safe.
* Sample rate and channels come from the hello (`audio_sample_rate`, `audio_channels`).
  `witness listen` then reports pitches, loudness, tempo and clipping, and draws spectrograms.

**Sound events (optional).** Where the game starts a sound, also announce it:
`witness_sound("jump")`, or `witness_sound_ex("jump", 0.8, 1, x, y)` with a volume (0..1, `< 0` =
not given) and a screen position (`has_pos` 0 = not given). C++: `witness::sound("jump")`,
`witness::sound("jump", 0.8)`, `witness::sound("jump", 0.8, x, y)`. It is sent at once, stamped with
the current frame, so `witness listen` can name what it hears and flag sounds announced but silent.
Call it from the sim thread (inside `step`); it does nothing outside witness mode.

## 8. Screenshots from a GPU renderer

The handler fills a `witness_image` with RGBA8 pixels. They must stay valid until it returns.
Set `bottom_up = 1` when row 0 is the bottom row (OpenGL); the adapter flips the image.
`stride` handles padded rows, and `scale` requests are resampled for you.

**Software / CPU framebuffer:** point at it (see `coins_game.h`).

**OpenGL** (render the frame first, into the default framebuffer or an FBO):
```cpp
h.screenshot = [&](witness_image& img) -> bool {
    view.render(sim);                                         // draw the current state now
    pixels.resize((size_t)W * H * 4);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    glReadPixels(0, 0, W, H, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
    img.rgba = pixels.data(); img.width = W; img.height = H; img.bottom_up = 1;   // GL is bottom-up
    return true;
};
```

**SDL3 renderer:**
```cpp
view.render(sim);                                             // SDL_RenderClear + draws, no SDL_RenderPresent needed
SDL_Surface* s = SDL_RenderReadPixels(renderer, nullptr);
SDL_Surface* rgba = SDL_ConvertSurface(s, SDL_PIXELFORMAT_RGBA32);   // byte order R,G,B,A
SDL_DestroySurface(s);
pixels.assign((unsigned char*)rgba->pixels, (unsigned char*)rgba->pixels + rgba->pitch * rgba->h);
img.rgba = pixels.data(); img.width = rgba->w; img.height = rgba->h; img.stride = rgba->pitch;
SDL_DestroySurface(rgba);
return true;
```
**SDL2 renderer:** `SDL_RenderReadPixels(renderer, nullptr, SDL_PIXELFORMAT_RGBA32, pixels.data(), W * 4)`.

**SDL3 GPU / Vulkan / D3D / Metal:** render into an offscreen texture, copy it into a
CPU-readable transfer/staging buffer, wait on a fence, map it, and point `img.rgba` at the
mapped memory (unmap after the call). Swapchain formats are often **BGRA**: swap the R and B
bytes. Vulkan/D3D/Metal images are top-down (`bottom_up = 0`); GL is bottom-up.

* Render at the logical size from the hello. Headless GL needs a hidden window or an EGL
  pbuffer context.
* If screenshots are impossible in some setup, leave the handler unset. Tests that don't take
  shots still run.

## 9. Calls, eval and logs

**Calls** are the game's debug commands, e.g. teleports, giving items, spawning, or opening a menu.
If the engine has a script/console command system, route `call` through it, so every console
command becomes testable:
```cpp
h.call = [&](const char* name, witness::Value args, witness::Json& result) {
    std::string line = name;
    for (size_t i = 0; i < args.size(); i++) line += std::string(" ") + (args[(int)i].type() == WITNESS_STRING
        ? args[(int)i].str() : std::to_string(args[(int)i].num()));
    ScriptResult r = console.execute(line);                   // the engine's own command path
    if (!r.ok) return witness::fail(r.error);                 // e.g. "unknown command 'x'"
    result.value(r.output);
};
```
Advertise the common ones in `hello.calls` so `witness doctor` lists them. Test files call them
as `"call": ["gotosite", "camp"]`.

**Eval** (optional): if there's a script VM, `h.eval = [&](const char* expr, witness::Json& v) { v.value(vm.eval_to_string(expr)); };`

**Logs:** forward the engine logger: `witness_log(WITNESS_ERROR, "%s", msg)`. Errors fail
tests, so forward real errors only. It's thread-safe, and a no-op when Witness isn't active.

## 10. Replay recording in normal play

When a human plays with `WITNESS_RECORD=witness/replays/session.jsonl` set, the game writes a
replay that `witness replay last` re-simulates exactly. F8 adds a mark.

```cpp
// run_normal(): before the world is created
witness_record_start("Embervale", 60);         // no-op unless WITNESS_RECORD is set
rng.seed(witness_seed());                      // the recorded seed (WITNESS_SEED env, or the clock)

// event pump: record what the SIM will see this tick, in Witness names
case SDL_EVENT_KEY_DOWN: case SDL_EVENT_KEY_UP: {
    char k[32];
    if (!ev.key.repeat) witness_record_key(witness_from_sdl(ev.key.key, k, sizeof k), ev.type == SDL_EVENT_KEY_DOWN);
    break; }
case SDL_EVENT_MOUSE_MOTION:
    if (ev.motion.which != SDL_TOUCH_MOUSEID) witness_record_mouse(ev.motion.x, ev.motion.y, -1, 0);
    break;
// touch (phones/tablets): record fingers in logical pixels; small ids (0 = first finger down)
case SDL_EVENT_FINGER_DOWN: case SDL_EVENT_FINGER_MOTION: case SDL_EVENT_FINGER_UP: case SDL_EVENT_FINGER_CANCELED: {
    int id = finger_slot(ev.tfinger.fingerID, ev.type == SDL_EVENT_FINGER_DOWN);   // your SDL_FingerID -> 0..9 map
    int phase = ev.type == SDL_EVENT_FINGER_DOWN ? WITNESS_TOUCH_DOWN : ev.type == SDL_EVENT_FINGER_MOTION ? WITNESS_TOUCH_MOVE
              : ev.type == SDL_EVENT_FINGER_CANCELED ? WITNESS_TOUCH_CANCEL : WITNESS_TOUCH_UP;
    // _ex also records pressure (0..1; <= 0 = not given). witness_record_touch(id, x, y, phase) records none.
    if (id >= 0) witness_record_touch_ex(id, ev.tfinger.x * logical_w, ev.tfinger.y * logical_h, phase, ev.tfinger.pressure);
    if (phase == WITNESS_TOUCH_UP || phase == WITNESS_TOUCH_CANCEL) finger_slot_free(ev.tfinger.fingerID);
    break; }

// fixed-step loop: one replay line per SIM tick
while (acc >= FIXED_DT) { sim.update(FIXED_DT, input); witness_record_frame(FIXED_DT); acc -= FIXED_DT; }

// on exit
witness_record_stop();
```

* **One line per simulation step**, with the dt that step used. In a fixed-step loop, record
  inside the accumulator loop. Events go into the first tick after they arrive, matching the
  frame where the sim applied them. If no tick ran this render frame, keep them queued: the
  adapter only flushes them on `witness_record_frame`.
* For variable-dt games, call `witness_record_frame(dt)` once per frame with the real dt.
* If the game picks its own seed, or the start depends on choices made before play (a character creator, a chosen
  scene), start the recording when play begins with
  `witness_record_begin("Embervale", 60, world_seed, "{\"background\":3}")`. The header then holds the seed the world
  really used plus params that your `reset` handler applies to rebuild the same start.
* Mouse coordinates must be the same logical pixels Witness injects.
* Touch: record the fingers, never the mouse events SDL synthesizes from them
  (`which == SDL_TOUCH_MOUSEID`, for buttons and motion): on replay the adapter's mouse fallback
  recreates those, so recording both would deliver them twice. SDL finger ids are large arbitrary
  numbers; map them to small slots (0 = first finger down, reuse a slot after its finger lifts).
  `witness_record_event` can also record a filled `witness_event` (e.g. with `pressure`).
* Lines are flushed every frame, so a crash still leaves a usable replay.

## 11. Determinism checklist

- [ ] Every RNG is seeded from `reset`'s seed (or `witness_seed()`). No `rand()` without `srand(seed)`,
      no `std::random_device`, and no `time()`-based seeds.
- [ ] No wall-clock reads in the sim (`SDL_GetTicks`, `std::chrono::*::now`, `QueryPerformanceCounter`)
      in witness mode. Time comes only from the step's dt.
- [ ] No iteration over `unordered_map`/`unordered_set` (or pointer-keyed maps) where order affects
      the outcome or the snapshot.
- [ ] Worker-thread results are joined within the step. No "whichever thread finishes first".
- [ ] `reset` clears **everything**: input state, audio voices, timers, caches, static/global state,
      script VM globals, pending events.
- [ ] Floating point is deterministic on one build. Don't mix `-ffast-math` builds between the
      recording and the replay.
- [ ] No uninitialized memory in the simulation (MSVC debug fill patterns differ between runs).

## 12. Verify

Run from the folder containing `witness.json` (one witness command at a time; each launches the game):

```
witness doctor            # connection, capabilities, determinism, screenshot, audio
witness eval --keys       # every snapshot path: use these in tests
witness test              # witness/*.witness.json
witness shot --at 1       # look at the PNG with your image tool
witness listen --time 3   # audio report + spectrogram
```

| doctor says | likely cause |
|---|---|
| `no game connected within 30s` | `witness_active()` not reached, wrong `launch.command`, or the game crashed before connecting (see the output tail) |
| `game exited (code N) before connecting` | init failed headless (missing window/GPU/asset path): check `launch.cwd` and the headless init |
| `NOT deterministic` + differing paths | unseeded RNG, wall clock, unordered iteration, or state not cleared by `reset` |
| `audio returned no samples` | `render_audio_for_step` not called from `step`, or `audio_sample_rate` not set in the hello |
| `didn't answer 'step'` | the step handler blocks (waiting on vsync, a device, or a thread that never finishes) |

## 13. Web (Emscripten) builds

The same `witness.h` drives a WebAssembly build of the game in a headless browser (and with `--device iphone-15`,
as an iPhone would show it). Compiled by `emcc`, `witness.h` uses **no sockets**: its protocol lines go through
`witness_emscripten.js`, a small shim that keeps one WebSocket to the Witness CLI and calls back into C for every
command. Nothing else in your Witness code changes: handlers, hello, input, snapshot and audio work as on desktop.

**1. Link the shim** (copy `adapters/cpp/witness_emscripten.js` next to `witness.h`; `witness init` does):
```
emcc ... --pre-js witness/witness_emscripten.js
```
(or load it with a `<script>` before the Emscripten loader). It does nothing unless the page URL has
`?witness=host:port`, which the CLI adds. `witness_emscripten_inbuf/recv/closed` are exported by `witness.h` itself
(`EMSCRIPTEN_KEEPALIVE`); no `EXPORTED_FUNCTIONS` changes are needed. Release builds with `-O2 --closure 1` are
fine: the shim and the `EM_JS` bodies use quoted `['names']` for everything that crosses the bundle's edge
(protocol JSON, `WITNESS_CONFIG`, the page's `__witnessWeb`, `Module`), so Closure's renaming can't break them
(checked statically by the tests; no real emcc/Closure run here, see Limits).

**2. Don't start the main loop in witness mode.** The browser can't block, so `witness_run()` returns control to
the browser and keeps the runtime alive (`emscripten_exit_with_live_runtime()`; the lines after it in `main`, such
as `witness_shutdown()`, never run). From then on the game advances only inside the `step` handler:
```c
int main(int argc, char **argv) {
    init_game();                                  /* window/GL context, assets: as usual */
    if (witness_active(argc, argv)) {             /* ?witness= in the page URL */
        witness_connect(&hello, &handlers);       /* returns 1 at once: the hello waits until the socket opens */
        witness_run();                            /* back to the browser; commands now drive the game */
        return 0;                                 /* not reached */
    }
    emscripten_set_main_loop(frame, 0, 1);        /* normal play only */
}
```
Never call `emscripten_set_main_loop` (or `requestAnimationFrame` loops) in witness mode: it would advance the game
on the browser's clock between commands. If the loop is already running when you detect witness mode, call
`emscripten_cancel_main_loop()` first. The `step` handler does one frame of simulation with the given dt (the same
function your frame callback calls, minus reading the clock and polling SDL events).

**3. Screenshots.** Either keep your desktop `screenshot` handler (render, then `glReadPixels` with
`bottom_up = 1`; reading right after drawing in the same call is always valid), or leave `screenshot` out of the
handlers: the shim then answers it from the canvas (`Module.canvas`, else the largest `<canvas>`). In witness mode
the shim forces `preserveDrawingBuffer: true` on WebGL contexts created after it loads, so the canvas can be read
at any time. `--capture element` reads what the screen shows instead (device pixels, CSS scaling included).

**4. Audio.** Keep `witness_audio_write()` from your mixer in `step` (section 7): it follows simulated time exactly.
SDL3's own Emscripten audio device pulls samples on the browser's real audio clock, so it is not what Witness
captures. For the iPhone unlock path (no sound until a tap), see `witness doctor --no-auto-unlock` in the JS guide
(adapters/js/GUIDE.md, "Audio unlock"): in web builds, `witness.h` marks each input event that browsers count as a
user gesture (key down, mouse button, finger lifted) while your `input` handler runs, so resuming an
`AudioContext` from that handler works, and the page's AudioContexts (SDL's too) are tracked and reported. SDL3
resumes its context from its own DOM listeners, which Witness input does not go through: test that path with real
browser taps, `dom:tap:x,y@t`, and expect `web.audio.state == 'running'`.

**Open the audio device in witness mode too (web builds).** If witness mode skips `SDL_OpenAudioDevice` /
`SDL_OpenAudioDeviceStream`, the page never creates an `AudioContext`: `doctor --no-auto-unlock` can only say
"no AudioContext was created … open audio in witness mode too", and `web.audio.state` stays `"none"`. Open it
the way normal play does (SDL turns it into a WebAudio `AudioContext`, which the page's Witness init script
wraps: state, `resume()` and the iPhone gesture policy), but give it **silence**, not your synth: SDL's device
pulls on the browser's real clock, so pulling from the synth would advance game audio with wall time (not
deterministic), and Witness doesn't capture that context's samples in an Emscripten page anyway. What `listen`
hears still comes from `witness_audio_write()` in `step` (section 7).
```c
#ifdef __EMSCRIPTEN__
if (witness_mode) {   /* the page's AudioContext exists, so the unlock path can be tested; no samples go in */
    SDL_AudioStream *dev = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &spec, NULL, NULL);
    SDL_ResumeAudioStreamDevice(dev);   /* the same call normal play makes; never SDL_PutAudioStreamData here */
}
#endif
```
Then `witness doctor --no-auto-unlock` says which gesture resumed it (or ⚠ that it stayed suspended), and a
test can expect `web.audio.state == 'running'` after `dom:tap:x,y@t`. (Playwright's WebKit for Windows has no Web
Audio at all: run this check with Chromium.)

**5. witness.json:**
```json
{ "launch": { "url": "http://127.0.0.1:8080/game.html", "server": "python -m http.server 8080 -d build-web",
              "device": "iphone-15" } }
```
With a desktop build too, keep this as `witness.web.json` beside the desktop `witness.json` and pass
`--config witness.web.json` (any command; `play brief` passes it on). `witness doctor --device iphone-15` then also
prints how the canvas lands on the phone's screen (DPR, fractional scaling, blur) and the WebGL renderer. Engines and
profiles: adapters/js/GUIDE.md, "Phones and tablets".

**Limits (honest):** Witness's tests have no `emcc`. The bridge's C side is compiled natively against a stand-in
`emscripten.h` (C and C++, warnings as errors) and driven end to end through the real shim and CLI (doctor, the shared
coins test, gesture marking); the shim also runs in Chromium and WebKit pages against a JavaScript stand-in for the
compiled module on a growing `WebAssembly.Memory`. **Not run here: an actual emcc build** — the `EM_JS` bodies
(`HEAPU8`, calling `_witness_emscripten_*`), the `--pre-js` placement and `emscripten_exit_with_live_runtime()` in a
real wasm runtime, and `--closure 1` (the quoting is checked by a test that scans the files, not by running Closure).
Recording replays (`WITNESS_RECORD`) is not wired for web builds (it would write to MEMFS).
`WITNESS_EMSCRIPTEN_SOCKETS` keeps the socket code for builds that proxy POSIX sockets. Threads: without
`-pthread` the adapter's lock is a no-op; with it, a mutex.

## API summary

| C | purpose |
|---|---|
| `witness_active(argc, argv)` | `WITNESS_ADDR` set or `--witness` given |
| `witness_connect(&hello, &handlers)` / `witness::connect(hello, Handlers)` | connect + hello |
| `witness_run()` / `witness_poll(timeout_ms)` | serve commands (blocking / pumped) |
| `witness_shutdown()` | close, free |
| `--pre-js witness_emscripten.js`, `witness_emscripten_inbuf/recv/closed` | web (Emscripten) builds: the shim and its entry points (section 13) |
| `witness_frame()`, `witness_time()`, `witness_seed()` | simulation clock and seed |
| `witness_key_down(name)`, `witness_mouse(&x, &y, &buttons)`, `witness_touch(id, &x, &y)`, `witness_frame_events(&n)` | polled input |
| `hello.touch = 1` | the game handles `WITNESS_EV_TOUCH` itself: no mouse events from finger 0 |
| `witness_log(level, fmt, ...)` | logs (errors fail tests) |
| `witness_audio_frames_for_step(dt)`, `witness_audio_write(f32, frames)`, `witness_audio_write_s16` | audio capture |
| `witness_sound(name)`, `witness_sound_ex(name, volume, has_pos, x, y)`, `witness::sound(...)` | announce a sound (optional) |
| `witness_record_start/begin/key/mouse/touch/event/frame/stop`, `witness_mark(label)` | replays |
| `witness_json_*`, `witness::Json` | snapshot / result writer |
| `witness_get/at/number/int/string/bool`, `witness::Value` | read command arguments |
| `witness_key_normalize(name, out, n)` | any key name → Witness name |
| `witness_error(fmt, ...)`, `witness::fail(msg)` | fail the current command |
