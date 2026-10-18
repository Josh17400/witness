// Package witness is the Witness adapter for Go games (standard library only).
//
// Witness lets Claude see, hear and prove a game: the witness CLI launches the game with
// WITNESS_ADDR=127.0.0.1:<port>, the game connects, and from then on it steps only when told
// to, at a fixed dt. See GUIDE.md and docs/PROTOCOL.md in the Witness repo.
//
//	func main() {
//		if witness.Active() {
//			hello := witness.Hello{Name: "My Game", FPS: 60, Width: 320, Height: 180}
//			if err := witness.Run(hello, newGame()); err != nil {
//				log.Fatal(err)
//			}
//			return
//		}
//		// ... the normal real-time loop ...
//	}
//
// A game implements Game (Reset, Step, Snapshot). Optional capabilities are discovered from
// the extra interfaces it implements: InputHandler, Screenshotter, Caller, Evaluator,
// PerfReporter. Audio is enabled by Hello.AudioSampleRate. Everything is a cheap early-out
// when Witness is not active.
package witness

import (
	"bufio"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"io"
	"math"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Protocol is the Witness protocol version spoken by this package.
const Protocol = 1

const (
	defaultAddr     = "127.0.0.1:7357"
	maxLogs         = 4096
	audioMaxSeconds = 120
	version         = "1.0.0"
)

// Active reports whether WITNESS_ADDR is set or the game was started with --witness.
func Active() bool {
	if os.Getenv("WITNESS_ADDR") != "" {
		return true
	}
	for _, a := range os.Args[1:] {
		if a == "--witness" {
			return true
		}
	}
	return false
}

var (
	seedOnce  sync.Once
	seedValue int64
)

// Seed returns a seed for normal play: WITNESS_SEED if set, else derived from the clock
// (chosen once). In witness mode use the seed passed to Game.Reset; while recording use
// Recorder.Seed (which is this value).
func Seed() int64 {
	seedOnce.Do(func() {
		var s int64
		if _, err := fmt.Sscan(os.Getenv("WITNESS_SEED"), &s); err == nil {
			seedValue = s
			return
		}
		seedValue = time.Now().Unix() % 1000000
	})
	return seedValue
}

// ---------------------------------------------------------------- hello

// CallInfo advertises one custom command (witness call <name>).
type CallInfo struct {
	Name string `json:"name"`
	Args string `json:"args,omitempty"`
	Help string `json:"help,omitempty"`
}

// Hello describes the game to the CLI.
type Hello struct {
	Name     string
	Engine   string
	Language string // default "go"
	FPS      int    // default 60; the default step dt is 1/FPS
	Width    int
	Height   int
	Calls    []CallInfo
	Keys     []string
	// AudioSampleRate > 0 enables the "audio" capability: write samples in Step via Step.WriteAudio.
	AudioSampleRate int
	AudioChannels   int // default 1
	// Touch: the game handles touch events itself, so finger 0 is not also delivered as mouse
	// events (the default mouse fallback). Sends "touch": true in the hello.
	Touch bool
}

// ---------------------------------------------------------------- game interfaces

// Game is what every game implements (usually as a thin wrapper over its simulation).
type Game interface {
	// Reset returns the game to a deterministic initial state: the same seed and inputs
	// must give the same snapshots. scene is "" when not given; params may be nil.
	Reset(seed int64, scene string, params map[string]any) error
	// Step advances exactly one fixed frame of s.DT seconds.
	Step(s *Step)
	// Snapshot returns the state as JSON-encodable data. Convention:
	// {"entities": [{"id", "type", "pos": [x, y]}], "player": {...}, "scene": "..."}.
	Snapshot() any
}

// InputHandler receives each input event at the start of its frame, before Step, so it can
// be fed through the game's normal input path.
type InputHandler interface{ Input(e Event) }

// Screenshotter returns the current frame. Implementing it enables "screenshot".
type Screenshotter interface{ Screenshot() (Image, error) }

// Caller handles game-specific commands (teleport, give item, spawn ...). Enables "call".
type Caller interface {
	Call(name string, args []any) (any, error)
}

// Evaluator evaluates an expression in the game's script language. Enables "eval".
type Evaluator interface {
	Eval(expr string) (any, error)
}

// PerfReporter returns timing fields such as "frame_ms" and "counts". Enables "perf".
type PerfReporter interface{ Perf() map[string]any }

// Image is RGBA8 pixels. Set BottomUp for OpenGL-style readbacks (row 0 = bottom).
type Image struct {
	Width, Height int
	RGBA          []byte
	Stride        int // bytes per row; 0 means Width*4
	BottomUp      bool
}

// FromRGBA wraps an *image.RGBA (e.g. a software framebuffer) without copying.
func FromRGBA(img *image.RGBA) Image {
	b := img.Bounds()
	off := img.PixOffset(b.Min.X, b.Min.Y)
	return Image{Width: b.Dx(), Height: b.Dy(), RGBA: img.Pix[off:], Stride: img.Stride}
}

// ---------------------------------------------------------------- input events

// Event is one input event (docs/PROTOCOL.md section 4).
type Event struct {
	Frame   int64          // frame at whose start it applies
	Type    string         // "key", "mouse", "wheel", "text", "action", "pad", "axis", "touch", or anything else
	Key     string         // key: lowercase Witness name ("a", "space", "left", "f1" ...)
	Down    bool           // key/mouse/action/pad: pressed; touch: true on TouchDown (false on TouchUp/TouchCancel)
	HasDown bool           // false for mouse moves, axis, text, touch moves
	X, Y    float64        // mouse, touch: logical pixels, top-left origin
	HasPos  bool           // mouse: X/Y are set (always true for touch)
	Button  int            // mouse: 0 left, 1 middle, 2 right; -1 when not a button event
	Pad     string         // pad: button name
	DX, DY  float64        // wheel
	Text    string         // text
	Action  string         // action (input-mapping layer)
	Axis    string         // axis
	Value   float64        // axis value
	Raw     map[string]any // the event as received

	// Touch fields (Type "touch"); FromTouch marks mouse events made by the mouse fallback.
	ID        int        // touch: finger, 0 = the first finger down (stable from down to up)
	Phase     TouchPhase // touch: TouchDown, TouchMove, TouchUp or TouchCancel
	Pressure  float64    // touch: 0..1, 1 when not given (when recording, 0 also means not given)
	FromTouch bool       // mouse: synthesized from finger 0 (like SDL_TOUCH_MOUSEID); never recorded
}

// TouchPhase is the phase of a touch event.
type TouchPhase int

// Touch phases: the protocol's "down", "move", "up" and "cancel".
const (
	TouchDown TouchPhase = iota
	TouchMove
	TouchUp
	// TouchCancel: the system ended the touch (SDL's FINGER_CANCELED, the OS took the gesture,
	// focus lost). It ends the finger like TouchUp, but it is not a completed tap; games that
	// don't care may treat it as TouchUp. Appended last so the values above keep their numbers.
	TouchCancel
)

// Ends reports whether the phase ends the touch (TouchUp or TouchCancel).
func (p TouchPhase) Ends() bool { return p == TouchUp || p == TouchCancel }

// String returns the protocol name: "down", "move", "up" or "cancel".
func (p TouchPhase) String() string {
	switch p {
	case TouchDown:
		return "down"
	case TouchUp:
		return "up"
	case TouchCancel:
		return "cancel"
	default:
		return "move"
	}
}

// touchPhase parses a protocol phase; anything but "down" / "up" / "cancel" (or a missing one) is a move.
func touchPhase(s string) TouchPhase {
	switch s {
	case "down":
		return TouchDown
	case "up":
		return TouchUp
	case "cancel":
		return TouchCancel
	}
	return TouchMove
}

// mouseFromTouch is the mouse event finger 0 also produces (the mouse fallback):
// down -> button 0 down, move -> move, up / cancel -> button 0 up. ok is false for anything else.
func mouseFromTouch(e Event) (m Event, ok bool) {
	if e.Type != "touch" || e.ID != 0 {
		return Event{}, false
	}
	m = Event{Frame: e.Frame, Type: "mouse", X: e.X, Y: e.Y, HasPos: true, Button: -1, FromTouch: true}
	if e.Phase != TouchMove {
		m.Button, m.Down, m.HasDown = 0, e.Phase == TouchDown, true
	}
	m.Raw = m.JSON()
	return m, true
}

func eventFromJSON(m map[string]any) Event {
	e := Event{Raw: m, Button: -1}
	e.Frame = int64(num(m["frame"], 0))
	e.Type, _ = m["type"].(string)
	if d, ok := m["down"].(bool); ok {
		e.Down, e.HasDown = d, true
	}
	str := func(k string) string { s, _ := m[k].(string); return s }
	switch e.Type {
	case "key":
		e.Key = NormalizeKey(str("key"))
	case "mouse":
		if _, ok := m["x"]; ok {
			e.HasPos = true
			e.X, e.Y = num(m["x"], 0), num(m["y"], 0)
		}
		if b, ok := m["button"].(float64); ok {
			e.Button = int(b)
		} else if e.HasDown {
			e.Button = 0
		}
	case "wheel":
		e.DX, e.DY = num(m["dx"], 0), num(m["dy"], 0)
	case "text":
		e.Text = str("text")
	case "action":
		e.Action = str("action")
	case "pad":
		e.Pad = str("button")
	case "axis":
		e.Axis, e.Value = str("axis"), num(m["value"], 0)
	case "touch":
		e.ID = int(num(m["id"], 0))
		e.HasPos = true
		e.X, e.Y = num(m["x"], 0), num(m["y"], 0)
		e.Phase = touchPhase(str("phase"))
		e.Down, e.HasDown = e.Phase == TouchDown, e.Phase != TouchMove
		e.Pressure = num(m["pressure"], 1)
	}
	return e
}

// JSON returns the protocol shape of the event without "frame" (the replay format).
func (e Event) JSON() map[string]any {
	o := map[string]any{"type": e.Type}
	switch e.Type {
	case "key":
		o["key"] = e.Key
	case "mouse":
		if e.HasPos {
			o["x"], o["y"] = e.X, e.Y
		}
		if e.HasDown {
			o["button"] = max(e.Button, 0)
		}
	case "wheel":
		o["dx"], o["dy"] = e.DX, e.DY
	case "text":
		o["text"] = e.Text
	case "action":
		o["action"] = e.Action
	case "pad":
		o["button"] = e.Pad
	case "axis":
		o["axis"], o["value"] = e.Axis, e.Value
	case "touch":
		o["id"], o["x"], o["y"], o["phase"] = e.ID, e.X, e.Y, e.Phase.String()
		if e.Pressure > 0 && e.Pressure != 1 {
			o["pressure"] = e.Pressure
		}
		return o // the phase says it all: no "down"
	default:
		for k, v := range e.Raw {
			if k != "frame" {
				o[k] = v
			}
		}
	}
	if e.HasDown {
		o["down"] = e.Down
	}
	return o
}

var keyAliases = map[string]string{
	"return": "enter", "kpenter": "enter", "numpadenter": "enter", "keypadenter": "enter", "esc": "escape",
	"spacebar": "space", "arrowleft": "left", "arrowright": "right", "arrowup": "up", "arrowdown": "down",
	"leftarrow": "left", "rightarrow": "right", "uparrow": "up", "downarrow": "down",
	"lshift": "shift", "rshift": "shift", "leftshift": "shift", "rightshift": "shift", "shiftleft": "shift", "shiftright": "shift",
	"control": "ctrl", "lctrl": "ctrl", "rctrl": "ctrl", "leftctrl": "ctrl", "rightctrl": "ctrl", "leftcontrol": "ctrl",
	"rightcontrol": "ctrl", "controlleft": "ctrl", "controlright": "ctrl",
	"lalt": "alt", "ralt": "alt", "leftalt": "alt", "rightalt": "alt", "altleft": "alt", "altright": "alt", "option": "alt", "altgr": "alt",
	"del": "delete", "ins": "insert", "pgup": "pageup", "pgdn": "pagedown", "back": "backspace",
	"meta": "super", "metaleft": "super", "metaright": "super", "lsuper": "super", "rsuper": "super", "leftsuper": "super",
	"rightsuper": "super", "superleft": "super", "superright": "super", "command": "super", "windows": "super",
}

// NormalizeKey maps common key spellings to the Witness name: "Return" -> "enter",
// "Left Shift" -> "shift", "ArrowUp" -> "up", "KeyA" -> "a", "Digit1" -> "1".
// Ebitengine names work too: ebiten.KeyArrowLeft.String() is "ArrowLeft".
func NormalizeKey(name string) string {
	if name == " " {
		return "space"
	}
	k := strings.ToLower(strings.NewReplacer(" ", "", "_", "", "-", "").Replace(name))
	if len(k) == 4 && strings.HasPrefix(k, "key") {
		k = k[3:]
	} else if len(k) == 6 && strings.HasPrefix(k, "digit") {
		k = k[5:]
	}
	if a, ok := keyAliases[k]; ok {
		return a
	}
	return k
}

// ---------------------------------------------------------------- logs (global, thread-safe)

// Level is a log severity. LevelError lines fail tests.
type Level int

const (
	LevelInfo Level = iota
	LevelWarn
	LevelError
)

func (l Level) String() string {
	switch l {
	case LevelWarn:
		return "warn"
	case LevelError:
		return "error"
	default:
		return "info"
	}
}

type logLine struct {
	frame   int64
	level   Level
	message string
}

var (
	connected  atomic.Bool
	curFrame   atomic.Int64
	logMu      sync.Mutex
	logBuf     []logLine
	logDropped int
)

// Log buffers a line for the CLI. Safe from any goroutine; a no-op unless connected.
func Log(level Level, format string, args ...any) {
	if !connected.Load() {
		return
	}
	msg := format
	if len(args) > 0 {
		msg = fmt.Sprintf(format, args...)
	}
	logMu.Lock()
	defer logMu.Unlock()
	if len(logBuf) >= maxLogs {
		logDropped++
		return
	}
	logBuf = append(logBuf, logLine{frame: curFrame.Load(), level: level, message: msg})
}

// Info, Warn and Error are shorthands for Log.
func Info(format string, args ...any)  { Log(LevelInfo, format, args...) }
func Warn(format string, args ...any)  { Log(LevelWarn, format, args...) }
func Error(format string, args ...any) { Log(LevelError, format, args...) }

// ---------------------------------------------------------------- step context

// Step is the per-frame context handed to Game.Step.
type Step struct {
	DT     float64 // seconds to simulate (normally 1/FPS; replays pass recorded dts)
	Frame  int64   // frame being simulated (0 = first after reset)
	Time   float64 // simulated seconds at the start of this frame
	Events []Event // input applied at the start of this frame (already sent to InputHandler)
	c      *Conn
}

// KeyDown reports whether a key (Witness name, e.g. "right") is held.
func (s *Step) KeyDown(key string) bool { return s.c.held[NormalizeKey(key)] }

// Mouse returns the mouse position and button bitmask (bit 0 left, 1 middle, 2 right).
func (s *Step) Mouse() (x, y float64, buttons int) { return s.c.mx, s.c.my, s.c.mb }

// Touch returns the position of finger id (0 = the first finger) and whether it is down.
func (s *Step) Touch(id int) (x, y float64, down bool) {
	p, ok := s.c.touches[id]
	return p[0], p[1], ok
}

// AudioFrames is how many sample frames to render this step so audio tracks simulated time
// exactly (never drifts). 0 when audio is not enabled.
func (s *Step) AudioFrames() int {
	if s.c.rate == 0 {
		return 0
	}
	target := int64(math.Round((s.Time + s.DT) * float64(s.c.rate)))
	return int(max(target-s.c.emitted, 0))
}

// WriteAudio hands over interleaved float32 samples rendered by the mixer for this step.
func (s *Step) WriteAudio(interleaved []float32) {
	c := s.c
	if c.rate == 0 {
		return
	}
	c.audio = append(c.audio, interleaved...)
	if limit := c.rate * c.channels * audioMaxSeconds; len(c.audio) > limit {
		c.audio = append(c.audio[:0], c.audio[len(c.audio)-limit:]...)
	}
	c.emitted += int64(len(interleaved) / c.channels)
}

// ---------------------------------------------------------------- connection

// Conn is a live connection to the Witness CLI. Most games just call Run.
type Conn struct {
	nc       net.Conn
	r        *bufio.Reader
	partial  []byte
	game     Game
	fps      int
	frame    int64
	time     float64
	queue    []Event
	held     map[string]bool
	mx, my   float64
	mb       int
	rate     int
	channels int
	audio    []float32
	emitted  int64
	quit     bool

	// fingers down (id -> x, y); touchNative is Hello.Touch (no mouse fallback for finger 0)
	touches     map[int][2]float64
	touchNative bool
}

// Run connects and serves commands until "quit" or the CLI disconnects.
func Run(hello Hello, game Game) error {
	c, err := Connect(hello, game)
	if err != nil {
		return err
	}
	defer c.Close()
	for {
		more, err := c.Poll(-1)
		if err != nil || !more {
			return err
		}
	}
}

// Connect dials WITNESS_ADDR (default 127.0.0.1:7357, retrying for up to 10 s) and sends the hello.
func Connect(hello Hello, game Game) (*Conn, error) {
	quietCrashes()
	addr := os.Getenv("WITNESS_ADDR")
	if addr == "" {
		addr = defaultAddr
	}
	var nc net.Conn
	var err error
	for giveUp := time.Now().Add(10 * time.Second); ; {
		nc, err = net.DialTimeout("tcp", addr, 2*time.Second)
		if err == nil {
			break
		}
		if time.Now().After(giveUp) {
			return nil, fmt.Errorf("witness: could not connect to %s: %w", addr, err)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if tc, ok := nc.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
	}
	if hello.FPS <= 0 {
		hello.FPS = 60
	}
	if hello.AudioChannels <= 0 {
		hello.AudioChannels = 1
	}
	c := &Conn{nc: nc, r: bufio.NewReaderSize(nc, 1<<16), game: game, fps: hello.FPS, held: map[string]bool{},
		rate: max(hello.AudioSampleRate, 0), channels: hello.AudioChannels,
		touches: map[int][2]float64{}, touchNative: hello.Touch}
	connected.Store(true)
	curFrame.Store(0)
	if err := c.send(map[string]any{"hello": helloJSON(hello, game)}); err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

func helloJSON(h Hello, g Game) map[string]any {
	caps := []string{"reset", "step", "input", "snapshot"}
	if _, ok := g.(Screenshotter); ok {
		caps = append(caps, "screenshot")
	}
	if h.AudioSampleRate > 0 {
		caps = append(caps, "audio")
	}
	if _, ok := g.(Caller); ok {
		caps = append(caps, "call")
	}
	if _, ok := g.(Evaluator); ok {
		caps = append(caps, "eval")
	}
	caps = append(caps, "logs")
	if _, ok := g.(PerfReporter); ok {
		caps = append(caps, "perf")
	}
	lang := h.Language
	if lang == "" {
		lang = "go"
	}
	name := h.Name
	if name == "" {
		name = "game"
	}
	m := map[string]any{"protocol": Protocol, "name": name, "engine": h.Engine, "language": lang,
		"adapter": "witness-go " + version, "fps": h.FPS, "capabilities": caps}
	if h.Width > 0 && h.Height > 0 {
		m["size"] = []int{h.Width, h.Height}
	}
	if len(h.Calls) > 0 {
		m["calls"] = h.Calls
	}
	if len(h.Keys) > 0 {
		m["keys"] = h.Keys
	}
	if h.Touch {
		m["touch"] = true
	}
	return m
}

// Close ends the connection.
func (c *Conn) Close() error {
	connected.Store(false)
	return c.nc.Close()
}

// Frame and Time report the simulation clock since the last reset.
func (c *Conn) Frame() int64  { return c.frame }
func (c *Conn) Time() float64 { return c.time }

// Poll handles at most one command. timeout < 0 blocks until one arrives. It returns
// false after "quit" or when the CLI disconnects (not an error).
func (c *Conn) Poll(timeout time.Duration) (bool, error) {
	if c.quit {
		return false, nil
	}
	if timeout >= 0 {
		_ = c.nc.SetReadDeadline(time.Now().Add(timeout))
	} else {
		_ = c.nc.SetReadDeadline(time.Time{})
	}
	for {
		chunk, err := c.r.ReadSlice('\n')
		c.partial = append(c.partial, chunk...)
		if errors.Is(err, bufio.ErrBufferFull) {
			continue // long line (screenshots, big input batches): keep reading
		}
		if err != nil {
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				return true, nil // keep the partial line for the next Poll
			}
			if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
				return false, nil
			}
			return false, nil // reset by peer etc.: the CLI is gone
		}
		line := strings.TrimSpace(string(c.partial))
		c.partial = c.partial[:0]
		if line == "" {
			continue
		}
		if err := c.handle(strings.TrimPrefix(line, "@w")); err != nil {
			return false, err
		}
		return !c.quit, nil
	}
}

func (c *Conn) send(v any) error {
	b, err := marshal(v)
	if err != nil {
		return err
	}
	_, err = c.nc.Write(append(b, '\n'))
	return err
}

func (c *Conn) handle(line string) error {
	var m map[string]any
	if err := json.Unmarshal([]byte(line), &m); err != nil {
		fmt.Fprintln(os.Stderr, "[witness] ignoring malformed command line")
		return nil
	}
	result, err := c.dispatch(m)
	reply := map[string]any{"id": m["id"], "ok": err == nil}
	if err != nil {
		reply["error"] = err.Error()
	} else {
		for k, v := range result {
			reply[k] = v
		}
	}
	b, merr := marshal(reply)
	if merr != nil { // e.g. a snapshot with values JSON can't hold: report instead of dying
		b, _ = marshal(map[string]any{"id": m["id"], "ok": false, "error": "witness: can't encode reply: " + merr.Error()})
	}
	_, werr := c.nc.Write(append(b, '\n'))
	return werr
}

func (c *Conn) dispatch(m map[string]any) (map[string]any, error) {
	cmd, _ := m["cmd"].(string)
	switch cmd {
	case "reset":
		seed := int64(num(m["seed"], 1))
		scene, _ := m["scene"].(string)
		params, _ := m["params"].(map[string]any)
		c.frame, c.time, c.queue, c.held = 0, 0, nil, map[string]bool{}
		c.mx, c.my, c.mb = 0, 0, 0
		c.touches = map[int][2]float64{}
		c.audio, c.emitted = c.audio[:0], 0
		curFrame.Store(0)
		if err := c.game.Reset(seed, scene, params); err != nil {
			return nil, err
		}
		return map[string]any{}, nil
	case "input":
		evs, _ := m["events"].([]any)
		for _, e := range evs {
			if em, ok := e.(map[string]any); ok {
				ev := eventFromJSON(em)
				c.queue = append(c.queue, ev)
				// the mouse fallback: finger 0 is also the mouse unless the game handles touch
				if mouse, isFinger0 := mouseFromTouch(ev); isFinger0 && !c.touchNative {
					c.queue = append(c.queue, mouse)
				}
			}
		}
		return map[string]any{}, nil
	case "step":
		frames := int(num(m["frames"], 1))
		if frames < 1 {
			return nil, errors.New("step: 'frames' must be >= 1")
		}
		dt := num(m["dt"], 0)
		if dt <= 0 {
			dt = 1 / float64(c.fps)
		}
		dts, _ := m["dts"].([]any)
		for i := 0; i < frames; i++ {
			d := dt
			if i < len(dts) {
				d = num(dts[i], dt)
			}
			c.stepOnce(d)
		}
		return map[string]any{"frame": c.frame, "time": c.time}, nil
	case "snapshot":
		return map[string]any{"frame": c.frame, "time": c.time, "state": c.game.Snapshot()}, nil
	case "screenshot":
		s, ok := c.game.(Screenshotter)
		if !ok {
			break
		}
		img, err := s.Screenshot()
		if err != nil {
			return nil, err
		}
		scale := num(m["scale"], 1)
		if scale <= 0 || scale > 16 {
			scale = 1
		}
		return encodeImage(img, scale)
	case "audio":
		if c.rate == 0 {
			break
		}
		buf := make([]byte, 4*len(c.audio))
		for i, s := range c.audio {
			binary.LittleEndian.PutUint32(buf[4*i:], math.Float32bits(s))
		}
		c.audio = c.audio[:0]
		return map[string]any{"sampleRate": c.rate, "channels": c.channels, "format": "f32",
			"data": base64.StdEncoding.EncodeToString(buf)}, nil
	case "call":
		cl, ok := c.game.(Caller)
		if !ok {
			break
		}
		name, _ := m["name"].(string)
		args, _ := m["args"].([]any)
		r, err := cl.Call(name, args)
		if err != nil {
			return nil, err
		}
		return map[string]any{"result": r}, nil
	case "eval":
		ev, ok := c.game.(Evaluator)
		if !ok {
			break
		}
		expr, _ := m["expr"].(string)
		v, err := ev.Eval(expr)
		if err != nil {
			return nil, err
		}
		return map[string]any{"value": v}, nil
	case "logs":
		logMu.Lock()
		out := make([]map[string]any, 0, len(logBuf)+1)
		for _, l := range logBuf {
			out = append(out, map[string]any{"frame": l.frame, "level": l.level.String(), "message": l.message})
		}
		if logDropped > 0 {
			out = append(out, map[string]any{"frame": c.frame, "level": "warn", "message": fmt.Sprintf("witness: %d log lines dropped (buffer full)", logDropped)})
		}
		logBuf, logDropped = logBuf[:0], 0
		logMu.Unlock()
		return map[string]any{"logs": out}, nil
	case "perf":
		if p, ok := c.game.(PerfReporter); ok {
			return p.Perf(), nil
		}
	case "quit":
		c.quit = true
		return map[string]any{}, nil
	}
	return nil, fmt.Errorf("unknown command '%s'", cmd)
}

func (c *Conn) stepOnce(dt float64) {
	var due []Event
	keep := c.queue[:0]
	for _, e := range c.queue { // due events, in arrival order
		if e.Frame <= c.frame {
			due = append(due, e)
		} else {
			keep = append(keep, e)
		}
	}
	c.queue = keep
	ih, _ := c.game.(InputHandler)
	for _, e := range due {
		c.track(e)
		if ih != nil {
			ih.Input(e)
		}
	}
	c.game.Step(&Step{DT: dt, Frame: c.frame, Time: c.time, Events: due, c: c})
	c.frame++
	c.time += dt
	curFrame.Store(c.frame)
}

func (c *Conn) track(e Event) {
	switch e.Type {
	case "key":
		if e.HasDown {
			if e.Down {
				c.held[e.Key] = true
			} else {
				delete(c.held, e.Key)
			}
		}
	case "mouse":
		if e.HasPos {
			c.mx, c.my = e.X, e.Y
		}
		if e.HasDown && e.Button >= 0 && e.Button < 8 {
			if e.Down {
				c.mb |= 1 << e.Button
			} else {
				c.mb &^= 1 << e.Button
			}
		}
	case "touch":
		if c.touches == nil {
			c.touches = map[int][2]float64{}
		}
		if e.Phase.Ends() {
			delete(c.touches, e.ID)
		} else {
			c.touches[e.ID] = [2]float64{e.X, e.Y}
		}
	}
}

// ---------------------------------------------------------------- helpers

func num(v any, def float64) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case string:
		var f float64
		if _, err := fmt.Sscan(strings.TrimSpace(x), &f); err == nil {
			return f
		}
	case bool:
		if x {
			return 1
		}
		return 0
	}
	return def
}

func encodeImage(img Image, scale float64) (map[string]any, error) {
	w, h := img.Width, img.Height
	stride := img.Stride
	if stride <= 0 {
		stride = w * 4
	}
	if w <= 0 || h <= 0 || len(img.RGBA) < stride*(h-1)+w*4 {
		return nil, errors.New("screenshot: the image buffer is smaller than width x height")
	}
	ow, oh := max(int(math.Round(float64(w)*scale)), 1), max(int(math.Round(float64(h)*scale)), 1)
	px := make([]byte, 0, ow*oh*4)
	for y := 0; y < oh; y++ {
		sy := y * h / oh
		if img.BottomUp {
			sy = h - 1 - sy
		}
		row := img.RGBA[sy*stride:]
		if ow == w {
			px = append(px, row[:w*4]...)
			continue
		}
		for x := 0; x < ow; x++ {
			sx := x * w / ow
			px = append(px, row[sx*4:sx*4+4]...)
		}
	}
	return map[string]any{"width": ow, "height": oh, "format": "rgba8", "data": base64.StdEncoding.EncodeToString(px)}, nil
}
