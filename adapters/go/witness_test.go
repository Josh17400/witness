package witness

import (
	"encoding/base64"
	"math"
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
