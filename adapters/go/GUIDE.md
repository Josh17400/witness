# Witness for Go: integration guide (for Claude)

You are wiring Witness into a Go game you may not know yet. The adapter is package `witness`
(standard library only). Witness launches the game with `WITNESS_ADDR=127.0.0.1:<port>`; the
game connects, says hello, and from then on **only steps when told to**. You implement
`witness.Game` (`Reset`, `Step`, `Snapshot`) as a thin wrapper over the simulation. Optional
capabilities are discovered from the extra interfaces you implement:

| implement | enables |
|---|---|
| `Input(e witness.Event)` | input delivered through the game's normal path (otherwise poll `s.KeyDown`) |
| `Screenshot() (witness.Image, error)` | `screenshot` |
| `Call(name string, args []any) (any, error)` | `call` (teleport, give item, spawn ...) |
| `Eval(expr string) (any, error)` | `eval` |
| `Perf() map[string]any` | `perf` |
| `Hello.AudioSampleRate > 0` + `s.WriteAudio` in `Step` | `audio` |

The working reference is `examples/go/main.go`: a pure simulation (`Coins`), its Witness
methods, and a real-time demo that records replays. Read it first.

Work in this order and check each step with `witness doctor`:
**connect → step + snapshot → input → reset/seed → screenshot → audio → recording.**

---

## 1. Install

`witness init` copies the package files (without `go.mod`) into `witness/` inside your module, so it
is simply a sub-package. Import it by your module path:

```go
import "example.com/mygame/witness" // <module path from go.mod>/witness
```

(To use it as a separate module instead, keep `adapters/go/go.mod` and add
`require github.com/Josh17400/witness/adapters/go v0.0.0` plus a `replace` pointing at the folder,
as `examples/go/go.mod` does.)

`witness.json`:
```json
{ "name": "mygame", "build": "go build -o build/ .",
  "launch": { "command": "go", "args": ["run", "."] }, "tests": "witness", "seed": 1, "timeout": 180 }
```
For faster launches, point `launch.command` at `build/mygame` and use `witness test --build`.

## 2. Where to call `Active()` / `Run()`

At the top of `main`, before creating a window, opening audio, or touching saves:

```go
func main() {
	if witness.Active() {
		hello := witness.Hello{Name: "My Game", Engine: "Ebitengine", FPS: 60, Width: 640, Height: 360,
			Calls:           []witness.CallInfo{{Name: "teleport", Args: "x y", Help: "move the player"}},
			AudioSampleRate: 48000, AudioChannels: 2} // omit for no audio
		if err := witness.Run(hello, NewWitnessGame(1)); err != nil {
			log.Fatal(err)
		}
		return
	}
	runNormally()
}
```

* For a loop that must keep pumping (e.g. inside Ebitengine, see section 11), use
  `c, _ := witness.Connect(hello, game)` and call `c.Poll(0)` from your loop. It returns
  `false` when Witness quits.
* Logs: `witness.Info/Warn/Error(format, args...)` from any goroutine (a no-op when inactive).
  Errors fail tests. With `log/slog`, add a handler that forwards `slog.LevelError` to `witness.Error`.
* Saves and settings: use `os.MkdirTemp` in witness mode.
* **No windows or dialogs in witness mode** (it runs unattended). `Connect` turns off Windows
  crash dialogs. Skip the game's own message boxes (e.g. `sqweek/dialog`); log with `witness.Error`
  instead, or panic so it prints and exits.

## 3. The main loop in witness mode

Witness owns time. `Step` runs **exactly one** frame of `s.DT` seconds. There's no `time.Now()`, no
`time.Sleep`, no ticker and no vsync. A `step 600` command calls `Step` 600 times. Don't render in
`Step`; render in `Screenshot`. Goroutines started by the sim must finish (or be joined) before
`Step` returns.

```go
func (g *WitnessGame) Step(s *witness.Step) {
	g.world.Update(s.DT, g.input) // the SAME update the real loop calls
	g.renderAudio(s)              // section 7
}
```

## 4. Input through the normal path

```go
func (g *WitnessGame) Input(e witness.Event) {
	switch e.Type {
	case "key":
		g.input.SetKey(keyFromWitness(e.Key), e.Down) // e.Key: "a", "space", "left", "f1" ...
	case "mouse":
		if e.HasPos {
			g.input.SetCursor(e.X, e.Y) // logical pixels, top-left origin
		}
		if e.HasDown {
			g.input.SetButton(e.Button, e.Down) // 0 left, 1 middle, 2 right
		}
	case "wheel":
		g.input.Scroll(e.DX, e.DY)
	case "text":
		g.input.Type(e.Text)
	case "action":
		g.input.SetAction(e.Action, e.Down)
	}
}
```

Polling games can use `s.KeyDown("space")`, `s.Mouse()` and `s.Events` inside `Step`.
`witness.NormalizeKey` maps engine names to Witness names (`"ArrowLeft"` → `left`,
`"KeyA"`/`"A"` → `a`, `"ShiftLeft"` → `shift`, `"Enter"` → `enter`).

## 5. Reset and seeding

```go
func (g *WitnessGame) Reset(seed int64, scene string, params map[string]any) error {
	g.rng = rand.New(rand.NewPCG(uint64(seed), 0)) // math/rand/v2; EVERY generator
	w, err := LoadWorld(cmp.Or(scene, "level1"))
	if err != nil {
		return err // shown by the CLI
	}
	g.world, g.input = w, NewInput()
	if lvl, ok := params["level"].(float64); ok {
		g.world.SetLevel(int(lvl))
	}
	return nil
}
```

The same seed and inputs must give identical snapshots. Never use the global `rand` functions
(`rand.Intn` without a seeded source) in the sim.

## 6. Snapshot: expose `state.entities`

Return anything `encoding/json` can encode. Maps get sorted keys, structs keep field order, and
NaN/Inf become `"NaN"`/`"Infinity"`.

```go
func (g *WitnessGame) Snapshot() any {
	ents := make([]map[string]any, 0, len(g.world.Entities))
	for _, e := range g.world.SortedEntities() { // STABLE order: never range over a map here
		ents = append(ents, map[string]any{"id": e.ID, "type": e.Kind, "pos": []float64{e.X, e.Y}, "hp": e.HP})
	}
	return map[string]any{
		"scene":    g.world.Scene,
		"player":   map[string]any{"id": 0, "type": "Player", "pos": []float64{g.world.Player.X, g.world.Player.Y}, "hp": g.world.Player.HP},
		"entities": ents,
	}
}
```

## 7. Audio: render the mixer per step

```go
func (g *WitnessGame) renderAudio(s *witness.Step) {
	n := s.AudioFrames()                   // from simulated time: never drifts
	g.buf = slices.Grow(g.buf[:0], n*2)[:n*2] // stereo interleaved
	g.synth.Render(g.buf)                  // the SAME function the device stream calls
	s.WriteAudio(g.buf)
}
```

If the synth is an `io.Reader` stream (as Ebitengine/oto players use), read exactly `n` frames
from it in `Step` and convert the bytes to float32 (16-bit: `float32(int16(le))/32768`).

## 8. Screenshots

```go
func (g *WitnessGame) Screenshot() (witness.Image, error) {
	g.drawSoftware(g.frame)            // *image.RGBA
	return witness.FromRGBA(g.frame), nil
}
```

For GPU readbacks, fill `witness.Image{Width, Height, RGBA, Stride, BottomUp}`. OpenGL
`glReadPixels` is bottom-up (set `BottomUp: true`). If screenshots aren't practical, don't
implement `Screenshotter`.

## 9. Replay recording in normal play

```go
rec := witness.RecordFromEnv("My Game", 60) // nil unless WITNESS_RECORD is set; nil-safe methods
defer rec.Close()
world := NewWorld(rec.Seed()) // the recorded seed (WITNESS_SEED or the clock)
// input pump: rec.Key(name, down) / rec.Mouse(x, y, button, down). F8 becomes a mark.
// after each SIM tick: rec.Frame(dt)
```

Write one `Frame(dt)` per simulation step, with the dt that step used. Lines are flushed every
frame. Play it back with `witness replay last`.

## 10. Determinism checklist (Go-specific items first)

- [ ] **`range` over a map is randomized on purpose.** Never let map order affect gameplay or
      the snapshot. Iterate a sorted key slice or keep a slice.
- [ ] Every RNG comes from the reset seed (`rand.New(rand.NewPCG(seed, 0))`). No global `rand.*`
      in the sim, and no `crypto/rand`.
- [ ] No `time.Now()`/`time.Since()`/tickers in the sim in witness mode.
- [ ] Goroutines: results are combined in a fixed order, and all work is done before `Step` returns.
      `select` over several ready channels picks randomly.
- [ ] `Reset` rebuilds everything, including package-level caches.

## 11. Ebitengine (guide, not compiled here)

Ebitengine owns the loop (`ebiten.RunGame` calls `Update` at TPS and `Draw` per frame), and its
input functions (`ebiten.IsKeyPressed`, `inpututil.IsKeyJustPressed`) are global, so they can't be
injected. Two steps make an Ebitengine game drivable.

**1. Put an input facade in front of the global functions**, and call it everywhere instead of `ebiten.*`:
```go
type Input interface {
	Pressed(k ebiten.Key) bool
	JustPressed(k ebiten.Key) bool
	Cursor() (int, int)
}

type ebitenInput struct{}

func (ebitenInput) Pressed(k ebiten.Key) bool     { return ebiten.IsKeyPressed(k) }
func (ebitenInput) JustPressed(k ebiten.Key) bool { return inpututil.IsKeyJustPressed(k) }
func (ebitenInput) Cursor() (int, int)            { return ebiten.CursorPosition() }

// witness mode: state fed by Witness events (ebiten.Key.String() is "ArrowLeft", "A", "Space" ...)
type witnessInput struct {
	held, just map[string]bool
	x, y       int
}

func (w *witnessInput) Pressed(k ebiten.Key) bool     { return w.held[witness.NormalizeKey(k.String())] }
func (w *witnessInput) JustPressed(k ebiten.Key) bool { return w.just[witness.NormalizeKey(k.String())] }
func (w *witnessInput) Cursor() (int, int)            { return w.x, w.y }
```

**2. Drive `Update` from Witness.** Ebitengine games tick at a fixed TPS, so set `Hello.FPS` to the
game's TPS. Each witness step is one `Update()`:
```go
type WitnessGame struct {
	game *Game // the ebiten.Game implementation
	in   *witnessInput
}

func (w *WitnessGame) Input(e witness.Event) {
	switch e.Type {
	case "key":
		if e.Down {
			w.in.held[e.Key], w.in.just[e.Key] = true, true
		} else {
			delete(w.in.held, e.Key)
		}
	case "mouse":
		if e.HasPos {
			w.in.x, w.in.y = int(e.X), int(e.Y)
		}
	}
}

func (w *WitnessGame) Step(s *witness.Step) {
	_ = w.game.Update()             // the game's own Update, reading w.in through the facade
	clear(w.in.just)                // "just pressed" lasts one tick, like inpututil
}

func (w *WitnessGame) Reset(seed int64, _ string, _ map[string]any) error {
	w.in = &witnessInput{held: map[string]bool{}, just: map[string]bool{}}
	w.game = NewGame(seed, w.in)
	return nil
}
```
Run this headless (no `RunGame`) when the game's `Update` doesn't create `ebiten.Image`s. That's the
fast path, and it covers tests, snapshots and audio.

**Screenshots** need Ebitengine's graphics loop. Run the witness connection *inside* it on a
small window, as fast as possible, and render on demand:
```go
ebiten.SetTPS(ebiten.SyncWithFPS)
ebiten.SetVsyncEnabled(false)
ebiten.SetWindowSize(640, 360)
// host.Update(): if more, _ := conn.Poll(0); !more { return ebiten.Termination }
// WitnessGame.Screenshot(): off := ebiten.NewImage(W, H); w.game.Draw(off); off.ReadPixels(buf)
//   (ReadPixels returns premultiplied RGBA; fine for opaque frames)
```
In this mode, everything else works the same as headless.

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
| `no game connected` / `exited before connecting` | `witness.Active()` not checked first, wrong `launch`, a compile error in `go run`, or a panic in init (see the output tail) |
| `NOT deterministic` | map iteration, global `rand`, `time.Now()`, goroutine ordering, state not cleared in `Reset` |
| `audio returned no samples` | `AudioSampleRate` set but `s.WriteAudio` never called |
| `didn't answer 'step'` | `Step` blocks (channel waiting on a goroutine, vsync) |

## API summary

| item | purpose |
|---|---|
| `witness.Active()` | `WITNESS_ADDR` set or `--witness` |
| `witness.Run(Hello, Game)` / `Connect(Hello, Game)` + `(*Conn).Poll(timeout)` | serve commands |
| `Game{Reset, Step, Snapshot}` + optional `InputHandler`, `Screenshotter`, `Caller`, `Evaluator`, `PerfReporter` | hooks |
| `Step{DT, Frame, Time, Events}`, `KeyDown`, `Mouse`, `AudioFrames`, `WriteAudio` | per-step context |
| `witness.Image`, `witness.FromRGBA(*image.RGBA)` | screenshots |
| `witness.Info/Warn/Error/Log` | logs (errors fail tests) |
| `RecordFromEnv`, `Record`, `(*Recorder).Seed/Key/Mouse/Input/Mark/Frame/Close` | replays |
| `witness.Seed()`, `witness.NormalizeKey()` | helpers |
