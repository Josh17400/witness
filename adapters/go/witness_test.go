package witness

import (
	"encoding/base64"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizeKey(t *testing.T) {
	for in, want := range map[string]string{
		"Return": "enter", "Left Shift": "shift", "ArrowUp": "up", "KeyA": "a", "Digit7": "7",
		" ": "space", "F5": "f5", "Escape": "escape", "ControlLeft": "ctrl", "right": "right",
	} {
		if got := NormalizeKey(in); got != want {
			t.Errorf("NormalizeKey(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMarshalSpecialFloats(t *testing.T) {
	type inner struct {
		V    float64 `json:"v"`
		Skip int     `json:"-"`
		Zero int     `json:"zero,omitempty"`
	}
	type outer struct {
		inner
		List []float64
	}
	b, err := marshal(map[string]any{"a": math.NaN(), "s": outer{inner{math.Inf(-1), 1, 0}, []float64{1, math.Inf(1)}}})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"a":"NaN","s":{"List":[1,"Infinity"],"v":"-Infinity"}}`
	if string(b) != want {
		t.Errorf("got %s\nwant %s", b, want)
	}
}

func TestEventRoundTrip(t *testing.T) {
	e := eventFromJSON(map[string]any{"frame": 3.0, "type": "key", "key": "Right", "down": true})
	if e.Frame != 3 || e.Key != "right" || !e.Down || !e.HasDown {
		t.Fatalf("bad key event %+v", e)
	}
	m := eventFromJSON(map[string]any{"type": "mouse", "x": 5.0, "y": 6.0})
	if !m.HasPos || m.HasDown || m.Button != -1 {
		t.Fatalf("bad mouse move %+v", m)
	}
	if _, ok := m.JSON()["down"]; ok {
		t.Error("a mouse move must not get a 'down' field")
	}
}

func TestTouchEvents(t *testing.T) {
	e := eventFromJSON(map[string]any{"frame": 2.0, "type": "touch", "id": 1.0, "x": 10.5, "y": 20.0, "phase": "down", "pressure": 0.5})
	if e.Frame != 2 || e.ID != 1 || e.X != 10.5 || e.Y != 20 || e.Phase != TouchDown || e.Pressure != 0.5 || !e.Down || !e.HasDown {
		t.Fatalf("bad touch event %+v", e)
	}
	b, _ := marshal(e.JSON())
	if want := `{"id":1,"phase":"down","pressure":0.5,"type":"touch","x":10.5,"y":20}`; string(b) != want {
		t.Errorf("got %s\nwant %s", b, want)
	}
	// defaults: id 0, a missing phase is a move, pressure 1 (not written), never a "down" field
	bare := eventFromJSON(map[string]any{"type": "touch", "x": 1.0, "y": 2.0})
	b, _ = marshal(bare.JSON())
	if want := `{"id":0,"phase":"move","type":"touch","x":1,"y":2}`; string(b) != want || bare.Pressure != 1 {
		t.Errorf("defaults: got %s (pressure %v)\nwant %s", b, bare.Pressure, want)
	}
	if TouchUp.String() != "up" || touchPhase("up") != TouchUp || touchPhase("lift") != TouchMove {
		t.Error("touch phase names")
	}
}

type touchGame struct{ got []Event }

func (g *touchGame) Reset(int64, string, map[string]any) error { return nil }

func (g *touchGame) Step(*Step) {}

func (g *touchGame) Snapshot() any { return nil }

func (g *touchGame) Input(e Event) { g.got = append(g.got, e) }

func TestTouchMouseFallback(t *testing.T) {
	g := &touchGame{}
	c := &Conn{game: g, fps: 60, held: map[string]bool{}, touches: map[int][2]float64{}}
	events := []any{
		map[string]any{"frame": 0.0, "type": "touch", "id": 0.0, "x": 5.0, "y": 6.0, "phase": "down"},
		map[string]any{"frame": 0.0, "type": "touch", "id": 1.0, "x": 7.0, "y": 8.0, "phase": "down"},
		map[string]any{"frame": 1.0, "type": "touch", "id": 0.0, "x": 9.0, "y": 6.0, "phase": "move"},
	}
	if _, err := c.dispatch(map[string]any{"cmd": "input", "events": events}); err != nil {
		t.Fatal(err)
	}
	c.stepOnce(1.0 / 60)
	// finger 0 down, then its mouse button 0 down, then finger 1 (other fingers make no mouse events)
	if len(g.got) != 3 || g.got[1].Type != "mouse" || !g.got[1].FromTouch || g.got[1].Button != 0 || !g.got[1].Down || g.got[2].ID != 1 {
		t.Fatalf("frame 0 events %+v", g.got)
	}
	s := &Step{c: c}
	if x, y, b := s.Mouse(); x != 5 || y != 6 || b != 1 {
		t.Errorf("mouse after finger 0 down: %v %v %v", x, y, b)
	}
	if x, _, down := s.Touch(1); !down || x != 7 {
		t.Error("finger 1 is not tracked")
	}
	c.stepOnce(1.0 / 60)
	if len(g.got) != 5 || g.got[4].Type != "mouse" || g.got[4].HasDown || g.got[4].X != 9 {
		t.Fatalf("frame 1 events %+v", g.got)
	}
	if _, ok := g.got[4].JSON()["down"]; ok {
		t.Error("a finger move must become a plain mouse move")
	}
	// opted out (Hello.Touch): only the touch event arrives
	c.touchNative, g.got = true, nil
	up := []any{map[string]any{"frame": 2.0, "type": "touch", "id": 0.0, "x": 9.0, "y": 6.0, "phase": "up"}}
	if _, err := c.dispatch(map[string]any{"cmd": "input", "events": up}); err != nil {
		t.Fatal(err)
	}
	c.stepOnce(1.0 / 60)
	if len(g.got) != 1 || g.got[0].Type != "touch" || g.got[0].Phase != TouchUp {
		t.Fatalf("opted out: want only the touch, got %+v", g.got)
	}
	if _, _, down := s.Touch(0); down {
		t.Error("finger 0 is still down after its up")
	}
}

func TestTouchCancel(t *testing.T) {
	// parses, ends the touch (and finger 0's mouse button), and round-trips as "cancel"
	if TouchCancel.String() != "cancel" || touchPhase("cancel") != TouchCancel || !TouchCancel.Ends() || TouchMove.Ends() {
		t.Error("cancel phase name")
	}
	e := eventFromJSON(map[string]any{"frame": 3.0, "type": "touch", "id": 0.0, "x": 4.0, "y": 5.0, "phase": "cancel"})
	if e.Phase != TouchCancel || e.Down || !e.HasDown {
		t.Fatalf("bad cancel event %+v", e)
	}
	b, _ := marshal(e.JSON())
	if want := `{"id":0,"phase":"cancel","type":"touch","x":4,"y":5}`; string(b) != want {
		t.Errorf("got %s\nwant %s", b, want)
	}
	if m, ok := mouseFromTouch(e); !ok || m.Button != 0 || m.Down || !m.HasDown {
		t.Errorf("cancel must release mouse button 0: %+v", m)
	}
	g := &touchGame{}
	c := &Conn{game: g, fps: 60, held: map[string]bool{}, touches: map[int][2]float64{}}
	events := []any{
		map[string]any{"frame": 0.0, "type": "touch", "id": 0.0, "x": 5.0, "y": 6.0, "phase": "down"},
		map[string]any{"frame": 1.0, "type": "touch", "id": 0.0, "x": 5.0, "y": 6.0, "phase": "cancel"},
	}
	if _, err := c.dispatch(map[string]any{"cmd": "input", "events": events}); err != nil {
		t.Fatal(err)
	}
	c.stepOnce(1.0 / 60)
	c.stepOnce(1.0 / 60)
	s := &Step{c: c}
	if _, _, down := s.Touch(0); down {
		t.Error("finger 0 is still down after its cancel")
	}
	if _, _, btn := s.Mouse(); btn != 0 {
		t.Errorf("mouse button still down after cancel: %v", btn)
	}
	if len(g.got) != 4 || g.got[2].Phase != TouchCancel || g.got[3].Type != "mouse" || g.got[3].Down {
		t.Fatalf("cancel events %+v", g.got)
	}
	path := filepath.Join(t.TempDir(), "cancel.jsonl")
	r, err := Record(path, "touch", 60)
	if err != nil {
		t.Fatal(err)
	}
	r.Touch(0, 4, 5, TouchCancel)
	r.Frame(0.5)
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	rb, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(rb)), "\n")
	want := `{"dt":0.5,"f":0,"in":[{"id":0,"phase":"cancel","type":"touch","x":4,"y":5}]}`
	if len(lines) != 2 || lines[1] != want {
		t.Errorf("got %q\nwant %s", lines, want)
	}
}

func TestRecordTouch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "touch.jsonl")
	r, err := Record(path, "touch", 60)
	if err != nil {
		t.Fatal(err)
	}
	r.Touch(0, 10, 20, TouchDown)
	if m, ok := mouseFromTouch(Event{Type: "touch", X: 10, Y: 20, Phase: TouchDown}); ok {
		r.Input(m) // a fallback mouse event is never recorded
	}
	r.Frame(0.5)
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	want := `{"dt":0.5,"f":0,"in":[{"id":0,"phase":"down","type":"touch","x":10,"y":20}]}`
	if len(lines) != 2 || lines[1] != want {
		t.Errorf("got %q\nwant %s", lines, want)
	}
}

func TestEncodeImageFlipAndScale(t *testing.T) {
	// 2x2: top row red, bottom row blue, stored bottom-up with a padded stride of 12 bytes
	px := []byte{0, 0, 255, 255, 0, 0, 255, 255, 9, 9, 9, 9, 255, 0, 0, 255, 255, 0, 0, 255, 9, 9, 9, 9}
	r, err := encodeImage(Image{Width: 2, Height: 2, RGBA: px, Stride: 12, BottomUp: true}, 1)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := base64.StdEncoding.DecodeString(r["data"].(string))
	if got[0] != 255 || got[2] != 0 || got[8] != 0 || got[10] != 255 {
		t.Errorf("flip/stride wrong: %v", got)
	}
	half, _ := encodeImage(Image{Width: 2, Height: 2, RGBA: px, Stride: 12}, 0.5)
	if half["width"] != 1 || half["height"] != 1 {
		t.Errorf("scale wrong: %v x %v", half["width"], half["height"])
	}
	if _, err := encodeImage(Image{Width: 4, Height: 4, RGBA: px}, 1); err == nil {
		t.Error("a short buffer must be rejected")
	}
}

func TestAudioFramesNeverDrift(t *testing.T) {
	c := &Conn{rate: 22050, channels: 1}
	s := &Step{c: c}
	for i := 0; i < 600; i++ {
		s.DT, s.Time = 1.0/60, float64(i)/60
		s.WriteAudio(make([]float32, s.AudioFrames()))
	}
	if c.emitted != 220500 {
		t.Errorf("emitted %d frames for 10 s, want 220500", c.emitted)
	}
}
