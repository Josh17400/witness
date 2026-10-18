# Witness for Lua and LÖVE: integration guide (for Claude)

You are wiring Witness into a Lua game you may not know yet. There are two files:

* `witness.lua`: the engine-agnostic adapter. It's pure Lua 5.1 / LuaJIT / 5.2–5.4 and needs
  LuaSocket for TCP (LÖVE and Defold bundle it). It includes JSON, base64, an s16 audio capture,
  replay recording and `eval`.
* `witness_love.lua`: the LÖVE 11 integration. It builds the whole adapter from the game's
  normal `love.*` callbacks, so most LÖVE games need one `setup{...}` call.

Witness launches the game with `WITNESS_ADDR=127.0.0.1:<port>`. The game connects, says hello,
and from then on **only advances when told to**. The working reference is `examples/lua/`
(`main.lua` + `conf.lua`), so read it first.

Work in this order, checking each step with `witness doctor`:
**connect → step + snapshot → input → reset/seed → screenshot → audio → recording.**

---

## 1. Install

`witness init` copies both files next to `main.lua`, where `require("witness")` finds them.
If the game keeps libraries in `lib/`, move them there and require `"lib.witness"`. `witness_love`
does `require("witness")`, so keep the two files together or adjust `package.path`.

`witness.json`:
```json
{ "name": "mygame", "launch": { "command": "love", "args": ["."] }, "tests": "witness", "seed": 1 }
```
On Windows, point `command` at `love.exe` / `lovec.exe` (lovec keeps a console, so you see
`print` and errors) when `love` isn't on PATH. On Linux CI, run under `xvfb-run -a`. For a fused
game, use the game executable.

## 2. LÖVE: where to hook in

At the **end** of `main.lua`, after every `love.*` callback is defined:

```lua
local wl = require("witness_love")
wl.setup{
  name = "My Game", size = {320, 180}, fps = 60,   -- size = logical resolution
  reset = function(seed, scene, params) newGame(seed, scene) end,
  snapshot = function() return { scene = sceneName, player = player, entities = listEntities() } end,
  calls = { teleport = function(x, y) player.x, player.y = tonumber(x), tonumber(y); return {player.x, player.y} end },
  call_help = { teleport = "move the player" },     -- optional (argument names are read automatically)
  audio = mixer,                                     -- section 7
  keys = { "left", "right", "up", "down", "space" }, -- optional, for the hello
}
```

What `setup` does in witness mode (it does **nothing** in normal play, unless recording):

* It replaces `love.run` with a loop that runs `love.load` once, then serves commands. Each
  `step` frame: apply that frame's injected input, `love.update(dt)` with the fixed dt, then the
  next frame. `love.draw` runs only for screenshots.
* It patches `love.keyboard.isDown` / `isScancodeDown`, `love.mouse.getPosition/getX/getY/isDown`,
  `love.touch.getTouches/getPosition/getPressure`
  and `love.timer.getDelta/getTime/getFPS/step/sleep` to report injected state and simulated time.
* It minimizes the window and discards real OS input events.
* It replaces LÖVE's blue error screen (which waits for a click) with: print the traceback to
  stderr, report it to Witness, `os.exit(1)`.

Add the same headless error handler to `conf.lua`. It covers errors raised before `main.lua`
reaches the `require`, and it keeps windows out of the user's way:

```lua
local witness_mode = (os.getenv("WITNESS_ADDR") or "") ~= ""
function love.conf(t)
  t.window.width, t.window.height = 320, 180     -- (normal sizes otherwise)
  if witness_mode then
    t.window.vsync = 0
    t.window.borderless = true
    t.window.x, t.window.y = -10000, -10000      -- off-screen; witness_love also minimizes it
  end
end
if witness_mode then
  function love.errorhandler(msg)
    io.stderr:write("Error: " .. tostring(msg) .. "\n" .. debug.traceback("", 2) .. "\n")
    os.exit(1)
  end
end
```

Don't set `t.window = false` if you want screenshots: rendering needs the GL context.

Logs: `witness.info/warn/error(msg)`. Errors fail tests, and all of these are no-ops when not
connected. An error inside `love.update` during a step becomes `ok:false` plus an error log
carrying the game's stack frames, so the process keeps serving.

## 3. Plain Lua (or another engine with LuaSocket)

```lua
local witness = require("witness")
if witness.active() then
  witness.run{
    name = "My Game", fps = 60, size = {640, 360},
    reset = function(seed, scene, params) game.reset(seed) end,
    input = function(ev) game.input(ev) end,       -- protocol event, start of its frame
    update = function(dt) game.update(dt) end,     -- exactly one frame
    snapshot = function() return game.state() end,
    screenshot = function(scale) return w, h, rgba_string end,
    audio = capture,                               -- witness.capture(rate, channels)
    calls = { teleport = game.teleport },
    env = function() return setmetatable({ game = game }, { __index = _G }) end, -- eval scope
  }
  os.exit(0)
end
```

`witness.run` returns after `quit` (or a disconnect). Without an `input` handler, poll
`witness.is_down("right")` or iterate `witness.input_events()` inside `update`.

## 4. The loop in witness mode: step only on command, fixed dt

Under `wl.setup` this is automatic. Make sure gameplay only advances inside `love.update(dt)`:

* No `love.timer.getTime()` deltas computed by hand, `os.time()`, `os.clock()` or
  `socket.gettime()` in gameplay. `getTime` is patched to simulated time, but `os.clock` can't be.
* Tweening and timer libraries (hump.timer, flux, tween.lua): update them from `love.update(dt)`
  with the given dt, never from their own clock.
* Coroutines and threads (`love.thread`): results must be joined before `love.update` returns.
  Channels that fill in asynchronously aren't deterministic.

## 5. Input through the normal path

`wl` delivers injected events through `love.handlers`, exactly like the default `love.run`, so
`love.keypressed(key, scancode, isrepeat)`, `love.keyreleased`, `love.mousepressed(x, y, button)`
(LÖVE buttons: 1 left, 2 right, 3 middle), `mousemoved`, `wheelmoved` and `textinput` fire as
usual, and `love.keyboard.isDown` sees held keys. Name mapping: Witness `enter` → `return`,
`shift` → `lshift`, `ctrl` → `lctrl`, `alt` → `lalt`; everything else is the same KeyConstant.
`action`, `pad` and `axis` events go to `setup{ input = function(ev) ... end }`, so route them to
the game's input mapper (baton, tactile …). Gamepad callbacks need a Joystick object that
Witness can't fabricate. Mouse coordinates are logical pixels: if the game scales the screen,
`love.mouse.getPosition` returns injected logical coordinates.

**Touch** (`touch:160,90@1`, `swipe:40,90->200,90@1-1.5` in tests). `wl` fires
`love.touchpressed(id, x, y, dx, dy, pressure)`, `love.touchmoved` and `love.touchreleased` with
integer ids (0 = first finger down; LÖVE ids are opaque, so treat them as table keys), logical
pixels like the mouse, and `love.touch.getTouches/getPosition/getPressure` report the injected
fingers. Like LÖVE on a phone, finger 0 also fires `love.mousepressed(x, y, 1, true, 1)`,
`mousemoved(..., true)` and `mousereleased(x, y, 1, true, 1)` right after (the 4th/5th argument
`istouch` is true), so mouse-only games work with touch tests. A game that handles touch itself
passes `setup{ touch = true }`: finger 0 then makes no mouse callbacks (the hello says
`"touch": true`). Plain Lua: `input` gets `{type = "touch", id, x, y, phase = "down"|"move"|"up",
pressure}` followed, for finger 0, by `{type = "mouse", ..., from_touch = true}` (skip those if you
handle the touch; `run{ touch = true }` turns them off). Polling: `witness.touch(id)` → x, y,
pressure while the finger is down, `witness.mouse()` → x, y, `witness.mouse_down(0)`.

## 6. RNG seeding and reset

Before calling your `reset`, `wl` calls `love.math.setRandomSeed(seed)` and
`math.randomseed(seed)`. If the game creates `love.math.newRandomGenerator()` objects, seed them
from the `seed` argument. Without a `reset` function, `wl` calls `love.load()` again, which
is fine when `love.load` builds all gameplay state. Gamestate libraries (hump.gamestate,
roomy): switch to the initial state inside `reset`.

## 7. Expose state

```lua
snapshot = function()
  local entities = {}
  for _, e in ipairs(world.entities) do                 -- arrays, not pairs(): stable order
    entities[#entities + 1] = { id = e.id, type = e.kind, pos = { e.x, e.y }, hp = e.hp }
  end
  return { scene = "level1", score = score, player = player, entities = entities }
end
```

* The JSON encoder sorts object keys, so snapshots are byte-stable. NaN/inf become strings.
  Functions and userdata become their `tostring`. Empty tables encode as `[]`; use
  `witness.object({})` when you need `{}`.
* Use stable ids (counters), never `tostring(table)` addresses.

## 8. Screenshots

By default `wl` renders `love.draw` into an offscreen Canvas of `size` and returns its ImageData.
That works with a minimized, off-screen window. If the game calls `love.graphics.setCanvas()`
itself inside `love.draw` (pixel-perfect scaling libraries such as push or maid64 do), pass
`screenshot_canvas = false`. `wl` then draws to the backbuffer and grabs it with
`love.graphics.captureScreenshot`, and the window must then be the logical size and not
minimized (`minimize = false`). Plain Lua: return `w, h, rgba_string` (rows top to bottom);
`witness.base64` encodes it.

## 9. Audio: a game-side mixer

LÖVE (OpenAL) can't capture its own output. Route sounds through one mixer that you own:

```lua
local mixer = wl.newMixer(22050, 1)              -- rate, channels
local coin = love.sound.newSoundData("coin.wav") -- SoundData, same rate as the mixer
function love.update(dt)
  ...
  mixer:play(coin, 0.8)                          -- instead of source:play()
  mixer:update()                                 -- normal play: keeps the QueueableSource fed
end
wl.setup{ ..., audio = mixer }
```

* Normal play: `mixer:update()` mixes active voices into a `love.audio.newQueueableSource`
  (8 × 1024-frame buffers, about 0.37 s at 22 kHz, low latency).
* Witness mode: `mixer:play` writes the samples into `mixer.capture` (`witness.capture`) at the
  current simulated time, sample-accurately. Tails carry over between `audio` calls.
* Music: decode to SoundData (`love.sound.newSoundData(file)`) and play it through the mixer as a
  voice. For long tracks, stream with `love.sound.newDecoder` into the mixer, or keep music on a
  normal Source and log `witness.info("music " .. name)` so tests can at least check it.
* Games with many `Source:play()` calls: write a `sfx(name)` helper first, then switch its body.

## 10. Replay recording

With `WITNESS_RECORD=<file.jsonl>` set and no Witness CLI, `wl.setup` installs a recording
`love.run`. It works like the default one, but each frame it writes the frame's dt and its input
events, F8 adds a marker, and before `love.load` it seeds `love.math`/`math.random` with the
replay seed (`WITNESS_SEED`, else from the clock). Seed game RNGs from `witness.seed()`. Missing
folders are created. If the file can't be written, the game prints a warning and plays on
without recording. `examples/lua` has `love . --demo`, a scripted session that CI records and
replays to 4 decimals.

Touches are recorded as `touch` events with LÖVE's touch ids mapped to small finger numbers
(0 = first finger down, reused after release). Mouse callbacks with `istouch = true` are left
out: on replay the finger-0 mouse fallback recreates them, so recording both would click twice.
Plain Lua / other engines: queue events with `witness.record_key(key, down)`,
`witness.record_mouse(x, y, button, down)` (button nil = a move),
`witness.record_touch(id, x, y, phase, pressure)` or `witness.record_event(ev)` during the frame
(an f8 key marks instead), then call `witness.record_frame(dt)`; mouse events with `from_touch`
or `istouch` set are skipped, and touch pressure is written only when it isn't 1.

## 11. Determinism pitfalls (Lua / LÖVE)

* `pairs()` order isn't stable across runs or Lua versions: iterate arrays with `ipairs`, or
  sort keys. (The encoder sorts snapshot keys, but gameplay that iterates with `pairs` and
  spends RNG or collides in that order still diverges.)
* `love.math.random` vs `math.random`: both get seeded, but `love.math.newRandomGenerator()`
  objects don't.
* `love.physics` (Box2D) is deterministic for identical step sequences. Destroy and recreate
  the World in `reset`, and never step it with a measured dt or a variable number of substeps.
* `os.time()` seeds and `collectgarbage`-dependent weak tables (`__mode`) used for gameplay.
* LuaJIT and PUC Lua can differ in the last bits of floating-point math, so record and replay
  on the same runtime.

## 12. Other Lua engines

* **Defold**: has LuaSocket built in (`socket` module) but owns the loop. Use plain
  `witness.lua` with a non-blocking variant. In witness mode, set
  `sys.set_update_frequency(0)` and `msg.post("@system:", "set_time_step", {factor = 0, mode = 0})`
  to freeze time, poll the socket in `update`, and when a step arrives restore
  `set_time_step {factor = 1}` for exactly N frames, the same "pause between steps" strategy
  the Godot adapter uses on the web. Screenshots: `screen.capture` needs an extension, so leave
  `screenshot` out or render a debug state image. This path is untested. Treat it as a design
  sketch.
* **PICO-8**: carts can't open sockets, so there's no adapter. The workable bridge is
  GPIO/serial: in a web export, `pico8_gpio` (128 bytes shared with JavaScript) can carry
  input and state through the Witness JS adapter, with the cart polling GPIO each frame. Or use
  `printh` + `stat(30)`/`stat(31)` stdin with `pico8 -run` and the stdio transport. Neither is
  shipped. For real coverage, port the game logic to Lua and test it under `witness.lua`.
* **Solar2D / Playdate**: same pattern as Defold (Solar2D has LuaSocket). Playdate has no sockets.

## 13. Verify

```
witness doctor        # connection, capabilities, determinism, screenshot, audio
witness eval --keys   # every snapshot path
witness test          # tests in witness/
```

`doctor` must end with `all good`. "the game exited before connecting" plus a traceback means
an error in `main.lua`/`love.load`; the headless error handler printed it. If "no game
connected" appears, `wl.setup` wasn't reached (it must run at load time, not inside
`love.load`) or LuaSocket is missing.
