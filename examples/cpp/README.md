# coins: C / C++ example (`witness.h`)

The standard Witness sample game (see `docs/ADAPTERS.md`) built on the single-header C/C++
adapter in `adapters/cpp/witness.h`.

| file | what it is |
|---|---|
| `coins_game.h` | the game as a pure simulation (C99, no clock/window/globals): step, software rasterizer, synth |
| `coins.cpp` + `witness_impl.cpp` | front-end using the C++ layer (`witness::Handlers`, `witness::Json`); also a real-time demo with replay recording |
| `coins_c.c` | the same game through the plain C API (C99); compiles the implementation itself |
| `build.mjs` | builds both into `build/` (MSVC on Windows, `$CXX`/`$CC` elsewhere) |
| `witness.json` | launches `build/coins` |
| `witness/coins.witness.json` | the shared test (copy of `examples/coins.witness.json`) |

There's no window: in witness mode the game is headless, as the protocol prefers. Without
Witness, `coins` runs a 2-second scripted real-time demo, and `coins_c` just prints how to
use it.

## Build

```
node build.mjs
```

* Windows: uses `cl` from the PATH, or finds Visual Studio through `vswhere` and calls
  `vcvars64.bat`. Builds with `/W4 /WX`, C++14, and C (`/TC`).
* Linux/macOS: `c++ -std=c++11` and `cc -std=c99` with `-Wall -Wextra -Wpedantic -Werror`.
  Set `CXX`/`CC` to pick the compiler.

## Verify with Witness

From this folder:

```
node ../../bin/witness.js doctor                          # C++ front-end
node ../../bin/witness.js test
node ../../bin/witness.js test --cmd "build/coins_c"      # C front-end (Windows: build\coins_c.exe)
node ../../bin/witness.js test --build                    # rebuild first
```

## Record and replay a session

```
WITNESS_RECORD=witness/replays/demo.jsonl WITNESS_SEED=4 ./build/coins     # PowerShell: $env:WITNESS_RECORD=...
node ../../bin/witness.js replay last --watch "state.player.pos, state.score"
```

The demo holds `right` for 1.2 s with real, irregular frame times and presses F8 at 0.5 s.
The replay re-simulates the recorded dts and reaches the same final position as the demo
prints. CI checks this to 4 decimal places.
