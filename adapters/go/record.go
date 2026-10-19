package witness

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Recorder writes a WITNESS_RECORD replay while a human plays (docs/PROTOCOL.md section 5).
//
//	rec := witness.RecordFromEnv("My Game", 60) // nil unless WITNESS_RECORD is set
//	world := NewWorld(witness.Seed())            // the recorded seed
//	rec.Key("right", true)                       // from the input pump (nil-safe)
//	rec.Frame(dt)                                // once per simulation step
//	rec.Close()
//
// All methods are safe to call on a nil *Recorder, so normal play needs no checks.
type Recorder struct {
	f       *os.File
	w       *bufio.Writer
	path    string
	seed    int64
	frame   int64
	pending []map[string]any
	mark    string
}

// RecordFromEnv starts recording if WITNESS_RECORD=<file.jsonl> is set and Witness is not
// driving the game. Missing folders are created. Failures go to stderr and return nil.
func RecordFromEnv(gameName string, fps int) *Recorder {
	path := os.Getenv("WITNESS_RECORD")
	if path == "" || Active() {
		return nil
	}
	r, err := Record(path, gameName, fps)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[witness] can't record to %s: %v\n", path, err)
		return nil
	}
	return r
}

// Record writes a replay to an explicit file (most games use RecordFromEnv).
func Record(path, gameName string, fps int) (*Recorder, error) {
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
	}
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	if fps <= 0 {
		fps = 60
	}
	r := &Recorder{f: f, w: bufio.NewWriter(f), path: path, seed: Seed()}
	r.writeLine(map[string]any{"replay": 1, "name": gameName, "seed": r.seed, "fps": fps,
		"started": time.Now().UTC().Format("2006-01-02T15:04:05Z"), "adapter": "witness-go " + version})
	return r, nil
}

// Seed is the seed this recording uses: seed the game's RNG with it (same as witness.Seed()).
func (r *Recorder) Seed() int64 {
	if r == nil {
		return Seed()
	}
	return r.seed
}

// Input queues an event for the current frame. A key press of F8 becomes a mark instead, and a
// mouse event made from finger 0 (FromTouch) is skipped: the replay's mouse fallback recreates it.
func (r *Recorder) Input(e Event) {
	if r == nil || (e.Type == "mouse" && e.FromTouch) {
		return
	}
	if e.Type == "key" && e.Key == "f8" {
		if e.Down {
			r.Mark("F8")
		}
		return
	}
	r.pending = append(r.pending, e.JSON())
}

// Key queues a key event (any common spelling; normalized to the Witness name).
func (r *Recorder) Key(key string, down bool) {
	r.Input(Event{Type: "key", Key: NormalizeKey(key), Down: down, HasDown: true, Button: -1})
}

// Mouse queues a mouse event; button < 0 means a move.
func (r *Recorder) Mouse(x, y float64, button int, down bool) {
	r.Input(Event{Type: "mouse", X: x, Y: y, HasPos: true, Button: button, Down: down, HasDown: button >= 0})
}

// Touch queues a finger event: id 0 = the first finger down (keep it until TouchUp), x/y in
// logical pixels (convert from the engine's normalized 0..1 coordinates). Record a touch the system
// ended (SDL's FINGER_CANCELED) as TouchCancel: it replays as "cancel". Don't also record the
// mouse events the platform synthesizes from touch: replay recreates them from the touch.
func (r *Recorder) Touch(id int, x, y float64, phase TouchPhase) {
	r.Input(Event{Type: "touch", ID: id, X: x, Y: y, HasPos: true, Phase: phase, Pressure: 1, Button: -1,
		Down: phase == TouchDown, HasDown: phase != TouchMove})
}

// Mark flags the current frame (shown by witness replay / trace).
func (r *Recorder) Mark(label string) {
	if r == nil {
		return
	}
	if label == "" {
		label = "mark"
	}
	r.mark = label
}

// Frame ends one simulation step: writes its dt and queued inputs, flushed immediately so a
// crash still leaves a usable replay.
func (r *Recorder) Frame(dt float64) {
	if r == nil {
		return
	}
	line := map[string]any{"f": r.frame, "dt": dt}
	if len(r.pending) > 0 {
		line["in"] = r.pending
		r.pending = nil
	}
	if r.mark != "" {
		line["mark"] = r.mark
		r.mark = ""
	}
	r.writeLine(line)
	r.frame++
}

// Close flushes and closes the replay file.
func (r *Recorder) Close() error {
	if r == nil {
		return nil
	}
	if err := r.w.Flush(); err != nil {
		r.f.Close()
		return err
	}
	return r.f.Close()
}

func (r *Recorder) writeLine(v any) {
	b, err := marshal(v)
	if err == nil {
		_, err = r.w.Write(append(b, '\n'))
	}
	if err == nil {
		err = r.w.Flush()
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "[witness] replay write failed: %v\n", err)
	}
}
