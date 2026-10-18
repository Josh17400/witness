# Witness

**Let Claude see, hear and prove any game.**

Witness is a universal, headless verification toolkit for games and other real-time
programs. A tiny **adapter** inside your game (one file, any language) speaks a small
protocol. The `witness` CLI then drives the game deterministically: it scripts input, steps
frames, queries state, takes and diffs screenshots, analyzes audio, charts values over time,
and replays human play sessions. It was built so an AI coding assistant can **verify its own
game work** instead of guessing, but it works just as well in CI or for a human.

```bash
witness doctor                                   # is the game wired up and deterministic?
witness test                                     # run witness/*.witness.json gameplay tests
witness eval --at 2 "state.player.hp" "count('Enemy')"
witness trace --watch "state.player.pos[1], state.score" --time 4 --input "space@1"   # → chart PNG
witness shot --at 1,4 --diff witness/shots/before.png
witness listen --time 8                          # audio report + spectrogram PNGs
witness replay last --shot                       # what the human saw when they pressed F8
```

## Install

**As a Claude Code plugin** (recommended: Claude gets the skill and the CLI):

```
/plugin marketplace add Josh17400/witness
/plugin install witness@witness-tools
```

Then ask Claude: *"set up Witness for this game and prove the jump works"*.

**As a CLI** (Node 18+, no dependencies):

```bash
git clone https://github.com/Josh17400/witness && cd witness && npm link
cd /path/to/your/game && witness init
```

## Adapters

| id | for | verified |
|---|---|---|
| `cpp` | C / C++ (SDL, raylib, SFML, custom engines; single header witness.h) | ✅ run locally |
| `csharp` | C# / .NET (console, MonoGame, FNA, Stride, custom engines) | ✅ run locally |
| `go` | Go (custom engines, Ebitengine via guide; package witness, std only) | ✅ run locally |
| `godot` | Godot 4 (GDScript autoload Witness.gd; TCP on desktop, WebSocket on web exports) | ✅ run locally |
| `godot-csharp` | Godot 4 (.NET / C#) | ✅ run locally |
| `java` | Java / Kotlin (LibGDX, LWJGL, jMonkeyEngine, Swing/Java2D, custom engines) | ✅ run locally |
| `js` | JavaScript / TypeScript (browser canvas, Phaser, three.js, PixiJS, Babylon.js, Node, Electron, Tauri; one ES module) | ✅ run locally |
| `lua` | Lua (LÖVE 11 via witness_love.lua, plain Lua 5.1-5.4 / LuaJIT with LuaSocket) | ✅ run locally |
| `lumen` | Lumen (.lum games): a bridge onto Lumen's built-in test API through its Electron shell | ✅ run locally |
| `python` | Python (plain Python, pygame / pygame-ce, Arcade, Pyglet; single file witness.py, stdlib only) | ✅ run locally |
| `rust` | Rust (custom engines, winit/wgpu, macroquad, Bevy via guide; crate `witness`, std only) | ✅ run locally |
| `unity` | Unity (2021.3+, built players in -batchmode or the Editor) | ⚠️ written, not run |

`witness adapters` lists what's bundled. Each adapter has a `GUIDE.md` written for Claude,
and a sample game in `examples/<id>/` that passes the same shared test in CI.
**Verification levels are honest:** `local` was run on the authoring machine, `ci` runs in
GitHub Actions, and `false` means carefully written but not executed (e.g. Unity, which needs
a license).

## How it works

1. `witness init` detects your language/engine, copies the adapter in, and writes
   `witness.json` (how to launch the game) plus a starter test.
2. Following the adapter's guide, the game connects to `WITNESS_ADDR` when it's set and
   then steps **only on command** with a fixed dt, so every run is deterministic.
3. All the smart work happens in the CLI, over JSON snapshots. That's why one test format,
   one `eval` and one audio analyzer work for every language.

Test files are JSON (or JS modules):

```json
[{ "name": "walking right collects the first coin", "input": "right@0-0.5",
   "steps": [{ "at": 0.6, "expect": ["state.score == 1", "count('Coin') == 4"] }] }]
```

* Spec: [docs/PROTOCOL.md](docs/PROTOCOL.md)
* Writing adapters: [docs/ADAPTERS.md](docs/ADAPTERS.md)
* The Claude skill: [skills/witness/SKILL.md](skills/witness/SKILL.md)

## License

MIT
