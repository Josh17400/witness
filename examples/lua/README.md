# coins: LÖVE example (`witness.lua` + `witness_love.lua`)

The standard Witness sample game (see `docs/ADAPTERS.md`) for LÖVE 11, written the ordinary
LÖVE way: `love.load` / `love.update(dt)` / `love.draw`, movement with `love.keyboard.isDown`,
and the ding as a `SoundData` played through `witness_love`'s game-side mixer (a
QueueableSource in normal play, sample-accurate capture under Witness). The only Witness
code is the `wl.setup{...}` call at the end of `main.lua` and the headless error handler in
`conf.lua`.

Inside this repo `main.lua` loads the adapter from `adapters/lua/` through `package.path`. A real
game keeps `witness.lua` and `witness_love.lua` next to `main.lua`.

## Run and verify (LÖVE 11.x)

```
love .                                   # play: arrows/WASD, F8 marks a replay moment, Esc quits
node ../../bin/witness.js doctor
node ../../bin/witness.js test
```

`witness.json` launches `love .`. On Windows, if `love` isn't on PATH, use
`--cmd "\"C:\Program Files\LOVE\lovec.exe\" ."` or edit `launch.command`; `lovec.exe` keeps a
console, so you see errors. Under Witness the window is borderless, parked off-screen and
minimized; screenshots render into an offscreen canvas. On headless Linux, run the CLI under
`xvfb-run -a` (CI also sets `ALSOFT_DRIVERS=null` so OpenAL needs no sound card).

## Plain Lua variant (`plain/`)

`plain/coins.lua` is the same game on bare `witness.lua` with no engine: Lua 5.1, LuaJIT or
5.2–5.4, plus LuaSocket (`luarocks install luasocket`, or the `lua-socket` apt package). It
rasterizes in software and mixes into `witness.capture`. It's witness-only.

```
cd plain
node ../../../bin/witness.js doctor --cmd "lua5.4 coins.lua"     # or luajit / lua5.1 / lua
node ../../../bin/witness.js test
```

`adapters/lua/tests/test_witness.lua` unit-tests the JSON, base64 and capture code on the same
runtimes (`lua tests/test_witness.lua` from `adapters/lua`).

## Record and replay

```
WITNESS_RECORD=witness/replays/demo.jsonl WITNESS_SEED=4 love . --demo
node ../../bin/witness.js replay witness/replays/demo.jsonl --watch "state.player.pos[0].toFixed(4)"
```

`--demo` is a scripted 2-second real-time session. Its key presses go through LÖVE's event
queue, so the recorder sees them like a human's. The replay ends on exactly the x position the
demo prints (CI checks this). Playing normally with `WITNESS_RECORD` set records your own
session.
