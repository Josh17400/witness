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
witness test --repeat 2                          # every step must repeat exactly: state, screenshot, audio
witness eval --at 2 "state.player.hp" "count('Enemy')"
witness eval --when "state.gate.open" --input "e@2"   # the exact frame something happens
witness effect --input "space@1"                 # what an input causes, and how many frames later (state, pixels, audio)
witness ab --a LIFT=0 --b LIFT=1 --at 3.2 --rect 200,100,64,64   # A/B runs: changed pixels, luma Δ, A | B | diff, state
witness measure jump --y "state.player.pos[1]" --input "space@1"   # apex, airtime, hang, gravity: feel as numbers
witness trace --watch "state.player.pos[1], state.score" --time 4 --input "space@1"   # → table + chart PNG
witness trace --watch "state.player.pos[1]" --input "space@1" --compare "GRAVITY=0.5"   # two runs on one chart, B − A
witness trace --xy "state.player.pos" --input "right@0-3"   # the path over the level, start/end/death markers
witness heatmap playtests                        # where playtesters spent time and died
witness shot --from 1 --to 1.5 --sheet --follow "state.player.pos" --zoom 3   # a whole motion in one picture
witness shot --at 1,4 --diff witness/shots/before.png
witness listen --time 8 --input "space@1"        # every sound tied to its cause, audio report + PNGs
witness replay last --shot                       # what the human saw when they pressed F8
witness measure scale witness/shots/shot.png     # exact pixel checks: scale/blur, box, contrast, motion
witness measure ui --at 2                        # readability: HUD layout, text size/contrast; also colorblind, palette
witness measure figure --of Player --params '[{"hour":12},{"hour":22}]'   # can you see the hero on every ground, day and night?
witness measure anim --of "state.player.anim"    # frames per pose, loop length, doubled or dropped frames
witness measure perf --time 5                    # frame cost p50/p95/max, spikes and what caused them, memory growth
witness shot --clip --from 1 --to 3              # an animated PNG to watch in a browser
witness play start --goal "Escape the arena"     # agent playtests: a cheap model PLAYS the game, Witness reports
witness clean                                    # prune old playtests, recordings, screenshots (also automatic)
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
| `cpp` | C / C++ (SDL, raylib, SFML, custom engines; single header witness.h) | ✅ local + CI |
| `csharp` | C# / .NET (console, MonoGame, FNA, Stride, custom engines) | ✅ local + CI |
| `go` | Go (custom engines, Ebitengine via guide; package witness, std only) | ✅ local + CI |
| `godot` | Godot 4 (GDScript autoload Witness.gd; TCP on desktop, WebSocket on web exports) | ✅ local + CI |
| `godot-csharp` | Godot 4 (.NET / C#) | ✅ local + CI |
| `java` | Java / Kotlin (LibGDX, LWJGL, jMonkeyEngine, Swing/Java2D, custom engines) | ✅ local + CI |
| `js` | JavaScript / TypeScript (browser canvas, Phaser, three.js, PixiJS, Babylon.js, Node, Electron, Tauri; one ES module) | ✅ local + CI |
| `lua` | Lua (LÖVE 11 via witness_love.lua, plain Lua 5.1-5.4 / LuaJIT with LuaSocket) | ✅ local + CI |
| `python` | Python (plain Python, pygame / pygame-ce, Arcade, Pyglet; single file witness.py, stdlib only) | ✅ local + CI |
| `rust` | Rust (custom engines, winit/wgpu, macroquad, Bevy via guide; crate `witness`, std only) | ✅ local + CI |
| `unity` | Unity (2021.3+, built players in -batchmode or the Editor) | ⚠️ compile-checked in CI; never run inside Unity (needs a license) |

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

Test files are JSON (or JS modules). Point steps check a moment; range steps check every frame of a span:

```json
[{ "name": "walking right collects the first coin", "input": "right@0-0.5",
   "steps": [{ "at": 0.6, "expect": ["state.score == 1", "count('Coin') == 4"] },
             { "from": 0, "to": 2, "always": "state.player.hp > 0", "eventually": "state.score == 1" }] }]
```

Times are seconds or frames (`90f`), and expressions can look one frame back (`prev`, `rose(x)`, `changed(x)`).
Games may announce their sounds (`witness.sound("coin")`) so `listen` names them; everything else needs nothing more
than the adapter.

* Spec: [docs/PROTOCOL.md](docs/PROTOCOL.md)
* What changed and how to adopt each release: [CHANGELOG.md](CHANGELOG.md)
* Agent playtests: [docs/PLAYTEST.md](docs/PLAYTEST.md)
* Writing adapters: [docs/ADAPTERS.md](docs/ADAPTERS.md)
* The Claude skill: [skills/witness/SKILL.md](skills/witness/SKILL.md)

## Agent playtests

`witness play` lets a cheap Claude model (Sonnet at low effort, or Haiku) **play** the game as a subagent. It gives
plain-word orders through short commands; a deterministic reflex layer inside Witness carries them out frame by
frame (pathing around walls, attack timing, blocking telegraphed attacks, dialogue choices). The game only steps on
command, so the model's thinking costs no game time, and every playtest is recorded as a frame-exact replay with a
report (fights, stuck spots, deaths, coverage, the tester's feedback).

```bash
witness play brief --goal "Escape the arena" --persona newbie --name t1   # the prompt for the tester subagent
witness play start --name t1 --goal "Escape the arena"                    # (what the tester runs)
witness play do "talk guard; choose 1; fight wolves block" -s t1
witness play end -s t1 --fun 4 --difficulty 2 --feedback "…"              # → witness/playtests/t1/report.md
witness replay witness/playtests/t1/replay.jsonl --at 12.4 --shot         # see a marked moment again
```

[examples/arena](examples/arena) is a small top-down game built for it (a maze, wolves that telegraph their bites,
an NPC dialogue, a locked gate). Three profiles cover top-down games, side-view platformers (jump planning, stomps,
landing prediction) and first-person shooters (auto-calibrated mouse aim). Haiku testers have won the arena, beaten
level 1-1 of a Mario-style platformer, and won a 4v4 FPS match 40–17, and each report fed back real bugs and design
feedback. `witness play suggest` proposes the config for a new game. Reference: [docs/PLAYTEST.md](docs/PLAYTEST.md).

## License

MIT
