// Command coins is the standard Witness sample game in Go, using package witness.
//
//   - witness mode (WITNESS_ADDR set, or --witness): headless, steps only on command with a
//     fixed dt, renders on demand into an image.RGBA, mixes audio per step.
//   - normal mode: a 2-second real-time demo with a scripted player (no window). With
//     WITNESS_RECORD=<file.jsonl> set it records a replay that `witness replay` reproduces.
package main

import (
	"fmt"
	"image"
	"image/color"
	"log"
	"math"
	"slices"
	"time"

	witness "github.com/Josh17400/witness/adapters/go"
)

const (
	W          = 320
	H          = 180
	FPS        = 60
	SampleRate = 22050
	Speed      = 120.0
)

type coin struct {
	ID   int
	X, Y float64
}

// Coins is the simulation: no clock, no window, no globals.
type Coins struct {
	px, py    float64
	hp, score int
	coins     []coin
	held      map[string]bool
	voices    []int // "ding" voices, by age in samples
	frame     *image.RGBA
}

func NewCoins(seed int64) *Coins {
	g := &Coins{frame: image.NewRGBA(image.Rect(0, 0, W, H))}
	g.restart(seed)
	return g
}

func (g *Coins) restart(seed int64) {
	g.px, g.py, g.hp, g.score = 40, 90, 3, 0
	g.held = map[string]bool{}
	g.voices = g.voices[:0]
	g.coins = g.coins[:0]
	for i := int64(0); i < 5; i++ {
		y := 90.0
		if i > 0 {
			y = float64(60 + (seed*7+i*13)%61)
		}
		g.coins = append(g.coins, coin{ID: int(10 + i), X: float64(80 + 40*i), Y: y})
	}
}

// key is the game's normal input path.
func (g *Coins) key(name string, down bool) { g.held[name] = down }

// dir is +1 / -1 / 0 from two pairs of keys (arrows and WASD).
func (g *Coins) dir(plus1, plus2, minus1, minus2 string) float64 {
	v := 0.0
	if g.held[plus1] || g.held[plus2] {
		v++
	}
	if g.held[minus1] || g.held[minus2] {
		v--
	}
	return v
}

func (g *Coins) update(dt float64) {
	g.px = math.Max(0, math.Min(W, g.px+g.dir("right", "d", "left", "a")*Speed*dt))
	g.py = math.Max(0, math.Min(H, g.py+g.dir("down", "s", "up", "w")*Speed*dt))
	g.coins = slices.DeleteFunc(g.coins, func(c coin) bool {
		if math.Hypot(c.X-g.px, c.Y-g.py) >= 12 {
			return false
		}
		g.score++
		g.voices = append(g.voices, 0)
		witness.Info("coin %d collected", c.ID)
		return true
	})
}

// mix renders mono samples: a ding is a 0.15 s 880 Hz decaying sine.
func (g *Coins) mix(out []float32) {
	length := SampleRate * 15 / 100 // 0.15 s
	for i := range out {
		v := 0.0
		for k, age := range g.voices {
			if age <= length {
				a := float64(age)
				v += math.Sin(2*math.Pi*880*a/SampleRate) * 0.5 * math.Exp(-a/(SampleRate*0.04))
			}
			g.voices[k]++
		}
		out[i] = float32(v)
	}
	g.voices = slices.DeleteFunc(g.voices, func(age int) bool { return age > length })
}

// render draws the view: dark background, yellow coins, blue player.
func (g *Coins) render() {
	bg := color.RGBA{20, 24, 40, 255}
	for i := 0; i < len(g.frame.Pix); i += 4 {
		copy(g.frame.Pix[i:i+4], []byte{bg.R, bg.G, bg.B, bg.A})
	}
	disc := func(cx, cy float64, r int, c color.RGBA) {
		ox, oy := int(math.Floor(cx+0.5)), int(math.Floor(cy+0.5))
		for y := -r; y <= r; y++ {
			for x := -r; x <= r; x++ {
				if x*x+y*y <= r*r {
					g.frame.SetRGBA(ox+x, oy+y, c) // ignores out-of-bounds points
				}
			}
		}
	}
	for _, c := range g.coins {
		disc(c.X, c.Y, 5, color.RGBA{255, 210, 60, 255})
	}
	disc(g.px, g.py, 7, color.RGBA{80, 200, 255, 255})
}

// ---------------------------------------------------------------- the Witness wiring

func (g *Coins) Reset(seed int64, scene string, params map[string]any) error {
	g.restart(seed)
	return nil
}

func (g *Coins) Input(e witness.Event) {
	switch {
	case e.Type == "key":
		g.key(e.Key, e.Down)
	case e.Type == "action" && e.Action == "dash" && e.Down:
		g.px += 30
	}
}

func (g *Coins) Step(s *witness.Step) {
	g.update(s.DT)
	buf := make([]float32, s.AudioFrames())
	g.mix(buf)
	s.WriteAudio(buf)
}

func entity(id int, kind string, x, y float64) map[string]any {
	return map[string]any{"id": id, "type": kind, "pos": []float64{x, y}}
}

func (g *Coins) Snapshot() any {
	player := entity(1, "Player", g.px, g.py)
	player["hp"] = g.hp
	entities := []any{player}
	for _, c := range g.coins {
		entities = append(entities, entity(c.ID, "Coin", c.X, c.Y))
	}
	return map[string]any{"score": g.score, "scene": "level1", "player": player, "entities": entities}
}

func (g *Coins) Screenshot() (witness.Image, error) {
	g.render()
	return witness.FromRGBA(g.frame), nil
}

func (g *Coins) Call(name string, args []any) (any, error) {
	arg := func(i int, def float64) float64 {
		if i < len(args) {
			switch v := args[i].(type) {
			case float64:
				return v
			case string:
				var f float64
				if _, err := fmt.Sscan(v, &f); err == nil {
					return f
				}
			}
		}
		return def
	}
	switch name {
	case "teleport":
		g.px, g.py = arg(0, g.px), arg(1, g.py)
		return []float64{g.px, g.py}, nil
	case "addcoin":
		g.coins = append(g.coins, coin{ID: 100 + len(g.coins), X: arg(0, 0), Y: arg(1, 0)})
		return len(g.coins), nil
	}
	return nil, fmt.Errorf("unknown call '%s' (try teleport, addcoin)", name)
}

func (g *Coins) Perf() map[string]any {
	return map[string]any{"counts": map[string]any{"coins": len(g.coins)}}
}

func main() {
	if witness.Active() {
		hello := witness.Hello{
			Name: "Coins (Go)", Engine: "witness-go sample", FPS: FPS, Width: W, Height: H,
			Calls: []witness.CallInfo{
				{Name: "teleport", Args: "x y", Help: "move the player"},
				{Name: "addcoin", Args: "x y", Help: "add a coin, returns the coin count"},
			},
			Keys:            []string{"left", "right", "up", "down", "a", "d", "w", "s"},
			AudioSampleRate: SampleRate, AudioChannels: 1,
		}
		if err := witness.Run(hello, NewCoins(1)); err != nil {
			log.Fatal(err)
		}
		return
	}
	demo()
}

// demo is normal play. A real game pumps window events here; this one scripts a short session.
func demo() {
	rec := witness.RecordFromEnv("Coins (Go)", FPS) // nil (and every method a no-op) unless WITNESS_RECORD is set
	defer rec.Close()
	g := NewCoins(rec.Seed())
	press := func(key string, down bool) {
		g.key(key, down)
		rec.Key(key, down)
	}
	t, holding, marked, last := 0.0, false, false, time.Now()
	for t < 2.0 {
		time.Sleep(16 * time.Millisecond) // real time: fine outside witness mode
		now := time.Now()
		dt := math.Min(now.Sub(last).Seconds(), 0.1)
		last = now
		// "player": hold right from 0 s to 1.2 s, press F8 at 0.5 s
		if !holding && t < 1.2 {
			holding = true
			press("right", true)
		}
		if holding && t >= 1.2 {
			holding = false
			press("right", false)
		}
		if !marked && t >= 0.5 {
			marked = true
			press("f8", true)
		}
		g.update(dt)
		rec.Frame(dt)
		t += dt
	}
	fmt.Printf("demo finished: t=%.3fs seed=%d score=%d player=(%.4f, %.4f) coins=%d\n", t, rec.Seed(), g.score, g.px, g.py, len(g.coins))
	if rec != nil {
		fmt.Println("replay recorded (play it back with: witness replay last)")
	} else {
		fmt.Println("tip: set WITNESS_RECORD=witness/replays/demo.jsonl to record a replay; run 'witness test' to verify")
	}
}
