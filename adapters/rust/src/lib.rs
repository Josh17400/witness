//! # witness: Witness adapter for Rust games (std only)
//!
//! Witness lets Claude see, hear and prove a game: the `witness` CLI launches the game with
//! `WITNESS_ADDR=127.0.0.1:<port>`, the game connects, and from then on it **steps only when
//! told to**, at a fixed dt. See `GUIDE.md` and `docs/PROTOCOL.md` in the Witness repo.
//!
//! ```no_run
//! use witness::{Game, Hello, Step, Value, obj};
//!
//! struct MyGame { x: f64 }
//! impl Game for MyGame {
//!     fn reset(&mut self, _seed: i64, _scene: Option<&str>, _params: &Value) -> Result<(), String> {
//!         self.x = 0.0;
//!         Ok(())
//!     }
//!     fn step(&mut self, s: &mut Step) {
//!         if s.key_down("right") { self.x += 120.0 * s.dt; }
//!     }
//!     fn snapshot(&mut self) -> Value { obj! { "x" => self.x } }
//! }
//!
//! fn main() -> std::io::Result<()> {
//!     let mut game = MyGame { x: 0.0 };
//!     if witness::active() {
//!         return witness::run(&Hello::new("My Game").fps(60).size(320, 180), &mut game);
//!     }
//!     // ... the normal real-time loop ...
//!     Ok(())
//! }
//! ```
//!
//! Everything is a cheap early-out when Witness is not active (zero cost in normal play).

mod json;
mod record;

pub use json::Value;
pub use record::Recorder;

use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, ErrorKind, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Protocol version spoken by this crate.
pub const PROTOCOL: u32 = 1;
const DEFAULT_ADDR: &str = "127.0.0.1:7357";
const MAX_LOGS: usize = 4096;
const AUDIO_MAX_SECONDS: usize = 120;

// ------------------------------------------------------------------ activation

/// True when `WITNESS_ADDR` is set or the game was started with `--witness`.
pub fn active() -> bool {
    std::env::var_os("WITNESS_ADDR").is_some_and(|v| !v.is_empty())
        || std::env::args().skip(1).any(|a| a == "--witness")
}

/// A seed for normal play: `WITNESS_SEED` if set, else derived from the clock (chosen once).
/// In witness mode use the seed passed to [`Game::reset`]; while recording use [`Recorder::seed`].
pub fn seed() -> i64 {
    static SEED: Mutex<Option<i64>> = Mutex::new(None);
    let mut s = SEED.lock().unwrap_or_else(|e| e.into_inner());
    *s.get_or_insert_with(|| {
        std::env::var("WITNESS_SEED")
            .ok()
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or_else(|| {
                let t = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default();
                (t.as_secs() % 1_000_000) as i64
            })
    })
}

// ------------------------------------------------------------------ hello

/// One advertised custom command (`witness call <name>`).
#[derive(Clone, Debug)]
pub struct CallInfo {
    pub name: String,
    pub args: String,
    pub help: String,
}

/// What the game tells Witness about itself. Build with the chained setters.
#[derive(Clone, Debug)]
pub struct Hello {
    pub name: String,
    pub engine: String,
    pub language: String,
    pub fps: u32,
    pub size: Option<(u32, u32)>,
    pub calls: Vec<CallInfo>,
    pub keys: Vec<String>,
    /// Advertise `screenshot` (implement [`Game::screenshot`]).
    pub screenshot: bool,
    /// `Some((sample_rate, channels))` advertises `audio` (write samples in [`Game::step`]).
    pub audio: Option<(u32, u16)>,
    /// Advertise `eval` (implement [`Game::eval`]).
    pub eval: bool,
    /// Advertise `perf` (implement [`Game::perf`]).
    pub perf: bool,
    /// The game handles [`Input::Touch`] itself: finger 0 is not also delivered as
    /// [`Input::Mouse`] (the default mouse fallback). Set with [`Hello::touch()`].
    pub touch: bool,
}

impl Hello {
    pub fn new(name: &str) -> Self {
        Hello {
            name: name.to_string(),
            engine: "custom".into(),
            language: "rust".into(),
            fps: 60,
            size: None,
            calls: Vec::new(),
            keys: Vec::new(),
            screenshot: false,
            audio: None,
            eval: false,
            perf: false,
            touch: false,
        }
    }
    pub fn engine(mut self, engine: &str) -> Self {
        self.engine = engine.into();
        self
    }
    pub fn fps(mut self, fps: u32) -> Self {
        self.fps = fps.max(1);
        self
    }
    pub fn size(mut self, width: u32, height: u32) -> Self {
        self.size = Some((width, height));
        self
    }
    pub fn call(mut self, name: &str, args: &str, help: &str) -> Self {
        self.calls.push(CallInfo {
            name: name.into(),
            args: args.into(),
            help: help.into(),
        });
        self
    }
    pub fn keys(mut self, keys: &[&str]) -> Self {
        self.keys = keys.iter().map(|k| k.to_string()).collect();
        self
    }
    pub fn screenshot(mut self) -> Self {
        self.screenshot = true;
        self
    }
    pub fn audio(mut self, sample_rate: u32, channels: u16) -> Self {
        self.audio = Some((sample_rate.max(1), channels.max(1)));
        self
    }
    pub fn eval(mut self) -> Self {
        self.eval = true;
        self
    }
    pub fn perf(mut self) -> Self {
        self.perf = true;
        self
    }
    /// The game handles [`Input::Touch`] itself: don't also deliver finger 0 as mouse events.
    /// Sends `"touch": true` in the hello.
    pub fn touch(mut self) -> Self {
        self.touch = true;
        self
    }

    fn to_json(&self) -> Value {
        let mut caps = vec!["reset", "step", "input", "snapshot"];
        if self.screenshot {
            caps.push("screenshot");
        }
        if self.audio.is_some() {
            caps.push("audio");
        }
        caps.push("call");
        if self.eval {
            caps.push("eval");
        }
        caps.push("logs");
        if self.perf {
            caps.push("perf");
        }
        let mut h = obj! {
            "protocol" => PROTOCOL,
            "name" => self.name.as_str(),
            "engine" => self.engine.as_str(),
            "language" => self.language.as_str(),
            "adapter" => concat!("witness-rs ", env!("CARGO_PKG_VERSION")),
            "fps" => self.fps,
            "capabilities" => caps,
        };
        if let Some((w, hgt)) = self.size {
            h.set("size", [w, hgt]);
        }
        if !self.calls.is_empty() {
            h.set("calls", self.calls.iter().map(|c| obj! { "name" => c.name.as_str(), "args" => c.args.as_str(), "help" => c.help.as_str() }).collect::<Value>());
        }
        if !self.keys.is_empty() {
            h.set(
                "keys",
                self.keys.iter().map(String::as_str).collect::<Value>(),
            );
        }
        if self.touch {
            h.set("touch", true);
        }
        obj! { "hello" => h }
    }
}

// ------------------------------------------------------------------ input events

/// One input event, in the protocol's shapes (docs/PROTOCOL.md §4).
#[derive(Clone, Debug, PartialEq)]
pub enum Input {
    /// Lowercase Witness key name (`"a"`, `"space"`, `"left"`, `"f1"` ...).
    Key {
        key: String,
        down: bool,
    },
    /// Logical pixels, top-left origin. `button`: 0 left, 1 middle, 2 right.
    /// `from_touch`: synthesized from finger 0 by the mouse fallback (like SDL's
    /// `SDL_TOUCH_MOUSEID`); skip it if the game also handles [`Input::Touch`]. Never recorded.
    Mouse {
        pos: Option<(f64, f64)>,
        button: Option<u8>,
        down: Option<bool>,
        from_touch: bool,
    },
    Wheel {
        dx: f64,
        dy: f64,
    },
    Text(String),
    /// For games with an input-mapping layer.
    Action {
        action: String,
        down: bool,
    },
    Pad {
        button: String,
        down: bool,
    },
    Axis {
        axis: String,
        value: f64,
    },
    /// Anything else, as sent.
    Other(Value),
    /// One finger (docs/PROTOCOL.md §4): `id` 0 is the first finger down and keeps its id until
    /// `Up` (or `Cancel`); `x`/`y` are logical pixels like the mouse; `pressure` is 0..1 (1 when not given).
    Touch {
        id: u32,
        x: f64,
        y: f64,
        phase: TouchPhase,
        pressure: f64,
    },
}

/// The phase of an [`Input::Touch`] event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TouchPhase {
    Down,
    Move,
    Up,
    /// The system ended the touch (SDL's `FINGER_CANCELED`: the OS took the gesture, focus was
    /// lost). It ends the finger like `Up`, but it is not a completed tap; games that don't care
    /// may treat it as `Up`.
    Cancel,
}

impl TouchPhase {
    /// `"down"` / `"up"` / `"cancel"`; anything else (including a missing phase) is `Move`.
    pub fn parse(phase: &str) -> TouchPhase {
        match phase {
            "down" => TouchPhase::Down,
            "up" => TouchPhase::Up,
            "cancel" => TouchPhase::Cancel,
            _ => TouchPhase::Move,
        }
    }
    /// The protocol name: `"down"`, `"move"`, `"up"` or `"cancel"`.
    pub fn as_str(self) -> &'static str {
        match self {
            TouchPhase::Down => "down",
            TouchPhase::Move => "move",
            TouchPhase::Up => "up",
            TouchPhase::Cancel => "cancel",
        }
    }
    /// True for the phases that end a touch: `Up` and `Cancel`.
    pub fn ends(self) -> bool {
        matches!(self, TouchPhase::Up | TouchPhase::Cancel)
    }
}

/// Track a finger in the down-fingers list: `Up` / `Cancel` remove it, anything else sets it.
fn track_touch(touches: &mut Vec<(u32, f64, f64)>, id: u32, x: f64, y: f64, phase: TouchPhase) {
    let slot = touches.iter().position(|t| t.0 == id);
    match (slot, phase.ends()) {
        (Some(i), true) => {
            touches.remove(i);
        }
        (Some(i), false) => touches[i] = (id, x, y),
        (None, true) => {}
        (None, false) => touches.push((id, x, y)),
    }
}

impl Input {
    /// True for a mouse event synthesized from finger 0 by the mouse fallback.
    pub fn is_from_touch(&self) -> bool {
        match self {
            Input::Mouse { from_touch, .. } => *from_touch,
            _ => false,
        }
    }

    /// The mouse event finger 0 also produces (the mouse fallback): down -> button 0 down,
    /// move -> move, up / cancel -> button 0 up. `None` for anything else.
    fn mouse_from_touch(&self) -> Option<Input> {
        match self {
            Input::Touch {
                id: 0, x, y, phase, ..
            } => {
                let down = match phase {
                    TouchPhase::Down => Some(true),
                    TouchPhase::Move => None,
                    TouchPhase::Up | TouchPhase::Cancel => Some(false),
                };
                Some(Input::Mouse {
                    pos: Some((*x, *y)),
                    button: down.map(|_| 0),
                    down,
                    from_touch: true,
                })
            }
            _ => None,
        }
    }

    fn from_json(v: &Value) -> Input {
        let down = v["down"].as_bool();
        let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
        match v["type"].as_str().unwrap_or("") {
            "key" => Input::Key {
                key: normalize_key(&s("key")),
                down: down.unwrap_or(false),
            },
            "mouse" => Input::Mouse {
                pos: v["x"].as_f64().map(|x| (x, v["y"].as_f64().unwrap_or(0.0))),
                button: v["button"].as_f64().map(|b| b as u8).or(down.map(|_| 0)),
                down,
                from_touch: false,
            },
            "wheel" => Input::Wheel {
                dx: v["dx"].as_f64().unwrap_or(0.0),
                dy: v["dy"].as_f64().unwrap_or(0.0),
            },
            "text" => Input::Text(s("text")),
            "action" => Input::Action {
                action: s("action"),
                down: down.unwrap_or(false),
            },
            "pad" => Input::Pad {
                button: s("button"),
                down: down.unwrap_or(false),
            },
            "axis" => Input::Axis {
                axis: s("axis"),
                value: v["value"].as_f64().unwrap_or(0.0),
            },
            "touch" => Input::Touch {
                id: v["id"].as_i64().unwrap_or(0).max(0) as u32,
                x: v["x"].as_f64().unwrap_or(0.0),
                y: v["y"].as_f64().unwrap_or(0.0),
                phase: TouchPhase::parse(v["phase"].as_str().unwrap_or("")),
                pressure: v["pressure"].as_f64().unwrap_or(1.0),
            },
            _ => Input::Other(v.clone()),
        }
    }

    /// Protocol JSON without `frame` (the replay format).
    pub fn to_json(&self) -> Value {
        match self {
            Input::Key { key, down } => {
                obj! { "type" => "key", "key" => key.as_str(), "down" => *down }
            }
            Input::Mouse {
                pos, button, down, ..
            } => {
                let mut o = obj! { "type" => "mouse" };
                if let Some((x, y)) = pos {
                    o.set("x", *x);
                    o.set("y", *y);
                }
                if let Some(d) = down {
                    o.set("button", button.unwrap_or(0));
                    o.set("down", *d);
                }
                o
            }
            Input::Wheel { dx, dy } => obj! { "type" => "wheel", "dx" => *dx, "dy" => *dy },
            Input::Text(t) => obj! { "type" => "text", "text" => t.as_str() },
            Input::Action { action, down } => {
                obj! { "type" => "action", "action" => action.as_str(), "down" => *down }
            }
            Input::Pad { button, down } => {
                obj! { "type" => "pad", "button" => button.as_str(), "down" => *down }
            }
            Input::Axis { axis, value } => {
                obj! { "type" => "axis", "axis" => axis.as_str(), "value" => *value }
            }
            Input::Other(v) => v.clone(),
            Input::Touch {
                id,
                x,
                y,
                phase,
                pressure,
            } => {
                let mut o = obj! { "type" => "touch", "id" => *id, "x" => *x, "y" => *y, "phase" => phase.as_str() };
                if *pressure > 0.0 && *pressure != 1.0 {
                    o.set("pressure", *pressure);
                }
                o
            }
        }
    }
}

/// An [`Input`] scheduled at an absolute frame (applied at the start of that frame).
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub frame: u64,
    pub input: Input,
}

/// Canonical Witness key name from common spellings: `"Return"` -> `"enter"`,
/// `"Left Shift"` -> `"shift"`, `"ArrowUp"` / `"KeyCode::Up"`-style `"Up"` -> `"up"`, `"KeyA"` -> `"a"`.
pub fn normalize_key(name: &str) -> String {
    if name == " " {
        return "space".into();
    }
    let mut k: String = name
        .chars()
        .filter(|c| !matches!(c, ' ' | '_' | '-'))
        .flat_map(char::to_lowercase)
        .collect();
    if k.len() == 4 && k.starts_with("key") {
        k.drain(..3);
    } else if k.len() == 6 && k.starts_with("digit") {
        k.drain(..5);
    }
    let alias = match k.as_str() {
        "return" | "kpenter" | "numpadenter" | "keypadenter" => "enter",
        "esc" => "escape",
        "spacebar" => "space",
        "arrowleft" | "leftarrow" => "left",
        "arrowright" | "rightarrow" => "right",
        "arrowup" | "uparrow" => "up",
        "arrowdown" | "downarrow" => "down",
        "lshift" | "rshift" | "leftshift" | "rightshift" | "shiftleft" | "shiftright" => "shift",
        "control" | "lctrl" | "rctrl" | "leftctrl" | "rightctrl" | "leftcontrol"
        | "rightcontrol" | "controlleft" | "controlright" => "ctrl",
        "lalt" | "ralt" | "leftalt" | "rightalt" | "altleft" | "altright" | "option" | "altgr" => {
            "alt"
        }
        "del" => "delete",
        "ins" => "insert",
        "pgup" => "pageup",
        "pgdn" => "pagedown",
        "back" => "backspace",
        "meta" | "metaleft" | "metaright" | "lsuper" | "rsuper" | "leftsuper" | "rightsuper"
        | "superleft" | "superright" | "command" | "windows" => "super",
        _ => return k,
    };
    alias.to_string()
}

// ------------------------------------------------------------------ logs (global, thread-safe)

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

struct LogLine {
    frame: u64,
    level: Level,
    message: String,
}

static ACTIVE: AtomicBool = AtomicBool::new(false);
static FRAME: AtomicU64 = AtomicU64::new(0);
static LOGS: Mutex<(Vec<LogLine>, usize)> = Mutex::new((Vec::new(), 0));

/// Buffer a log line for the CLI (`Level::Error` fails tests). Callable from any thread;
/// a no-op unless connected.
pub fn log(level: Level, message: impl Into<String>) {
    if !ACTIVE.load(Ordering::Relaxed) {
        return;
    }
    let mut logs = LOGS.lock().unwrap_or_else(|e| e.into_inner());
    if logs.0.len() >= MAX_LOGS {
        logs.1 += 1;
        return;
    }
    logs.0.push(LogLine {
        frame: FRAME.load(Ordering::Relaxed),
        level,
        message: message.into(),
    });
}
pub fn info(message: impl Into<String>) {
    log(Level::Info, message)
}
pub fn warn(message: impl Into<String>) {
    log(Level::Warn, message)
}
pub fn error(message: impl Into<String>) {
    log(Level::Error, message)
}

// ------------------------------------------------------------------ the game trait

/// RGBA8 pixels for a screenshot. Set `bottom_up` for OpenGL-style readbacks (row 0 = bottom).
pub struct Image<'a> {
    pub width: u32,
    pub height: u32,
    pub rgba: &'a [u8],
    /// Bytes per row; 0 means `width * 4`.
    pub stride: usize,
    pub bottom_up: bool,
}

/// Implement this for your game (or for a thin wrapper around it).
pub trait Game {
    /// Return to a deterministic initial state: same seed + same inputs = same snapshots.
    fn reset(&mut self, seed: i64, scene: Option<&str>, params: &Value) -> Result<(), String>;
    /// Deliver one input event through the game's normal input path (called at the start
    /// of the event's frame, before `step`). Optional if `step` polls [`Step::key_down`].
    fn input(&mut self, _event: &Input) {}
    /// Advance exactly one fixed frame of `step.dt` seconds. Write audio for this step here.
    fn step(&mut self, step: &mut Step);
    /// The game state as JSON. Convention: `{"entities": [{"id", "type", "pos": [x, y]}], "player", "scene"}`.
    fn snapshot(&mut self) -> Value;
    /// The current frame as RGBA (advertise with [`Hello::screenshot`]).
    fn screenshot(&mut self) -> Option<Image<'_>> {
        None
    }
    /// Game-specific commands (teleport, give item, spawn ...).
    fn call(&mut self, name: &str, _args: &[Value]) -> Result<Value, String> {
        Err(format!("unknown call '{name}'"))
    }
    /// Evaluate an expression in the game's script language (advertise with [`Hello::eval`]).
    fn eval(&mut self, _expr: &str) -> Result<Value, String> {
        Err("eval is not supported".into())
    }
    /// Timing fields, e.g. `obj!{"frame_ms" => 1.2, "counts" => obj!{...}}` (advertise with [`Hello::perf`]).
    fn perf(&mut self) -> Value {
        obj! {}
    }
}

/// Per-step context handed to [`Game::step`].
pub struct Step<'a> {
    /// Seconds to simulate (normally 1/fps; replays pass the recorded dts).
    pub dt: f64,
    /// Frame number being simulated (0 = first frame after reset).
    pub frame: u64,
    /// Simulated seconds at the start of this frame.
    pub time: f64,
    /// Input applied at the start of this frame (already delivered to [`Game::input`]).
    pub events: &'a [Input],
    held: &'a [String],
    mouse: (f64, f64, u8),
    touches: &'a [(u32, f64, f64)],
    audio: &'a mut AudioCapture,
}

impl Step<'_> {
    /// Is this key held (Witness name, e.g. `"right"`)?
    pub fn key_down(&self, key: &str) -> bool {
        let k = normalize_key(key);
        self.held.contains(&k)
    }
    /// Mouse position and button bitmask (bit 0 left, 1 middle, 2 right).
    pub fn mouse(&self) -> (f64, f64, u8) {
        self.mouse
    }
    /// Position of finger `id` (0 = the first finger) while it is down, else `None`.
    pub fn touch(&self, id: u32) -> Option<(f64, f64)> {
        let t = self.touches.iter().find(|t| t.0 == id)?;
        Some((t.1, t.2))
    }
    /// Sample frames to render this step so audio tracks simulated time exactly (0 without audio).
    pub fn audio_frames(&self) -> usize {
        self.audio.frames_for(self.time + self.dt)
    }
    /// Hand over interleaved f32 samples rendered by the mixer for this step.
    pub fn write_audio(&mut self, interleaved: &[f32]) {
        self.audio.write(interleaved);
    }
}

/// Captured PCM (ring buffer with a cap; oldest samples drop first).
struct AudioCapture {
    rate: u32,
    channels: u16,
    samples: VecDeque<f32>,
    emitted: u64, // sample frames since reset
}

impl AudioCapture {
    fn frames_for(&self, until: f64) -> usize {
        if self.rate == 0 {
            return 0;
        }
        let target = (until * self.rate as f64).round() as i64;
        (target - self.emitted as i64).max(0) as usize
    }
    fn write(&mut self, interleaved: &[f32]) {
        if self.rate == 0 {
            return;
        }
        let ch = self.channels.max(1) as usize;
        let cap = self.rate as usize * ch * AUDIO_MAX_SECONDS;
        self.samples.extend(interleaved.iter().copied());
        while self.samples.len() > cap {
            self.samples.pop_front();
        }
        self.emitted += (interleaved.len() / ch) as u64;
    }
    fn clear(&mut self) {
        self.samples.clear();
        self.emitted = 0;
    }
}

// ------------------------------------------------------------------ connection

/// A live connection to the Witness CLI. Most games just call [`run`].
pub struct Connection {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
    line: Vec<u8>,
    fps: u32,
    frame: u64,
    time: f64,
    queue: Vec<Event>,
    held: Vec<String>,
    mouse: (f64, f64, u8),
    touches: Vec<(u32, f64, f64)>,
    touch_native: bool,
    audio: AudioCapture,
    quit: bool,
}

impl Connection {
    /// Connect to `WITNESS_ADDR` (default 127.0.0.1:7357, retrying for up to 10 s) and send the hello.
    pub fn connect(hello: &Hello) -> io::Result<Connection> {
        quiet_crashes();
        let addr = std::env::var("WITNESS_ADDR")
            .ok()
            .filter(|a| !a.is_empty())
            .unwrap_or_else(|| DEFAULT_ADDR.into());
        let give_up = Instant::now() + Duration::from_secs(10);
        let stream = loop {
            match TcpStream::connect(addr.as_str()) {
                Ok(s) => break s,
                Err(e) if Instant::now() < give_up && e.kind() != ErrorKind::InvalidInput => {
                    std::thread::sleep(Duration::from_millis(100))
                }
                Err(e) => {
                    return Err(io::Error::new(
                        e.kind(),
                        format!("witness: could not connect to {addr}: {e}"),
                    ))
                }
            }
        };
        stream.set_nodelay(true)?;
        let mut c = Connection {
            reader: BufReader::with_capacity(1 << 16, stream.try_clone()?),
            writer: stream,
            line: Vec::new(),
            fps: hello.fps.max(1),
            frame: 0,
            time: 0.0,
            queue: Vec::new(),
            held: Vec::new(),
            mouse: (0.0, 0.0, 0),
            touches: Vec::new(),
            touch_native: hello.touch,
            audio: AudioCapture {
                rate: hello.audio.map_or(0, |a| a.0),
                channels: hello.audio.map_or(1, |a| a.1),
                samples: VecDeque::new(),
                emitted: 0,
            },
            quit: false,
        };
        ACTIVE.store(true, Ordering::Relaxed);
        FRAME.store(0, Ordering::Relaxed);
        c.send(&hello.to_json().to_string())?;
        Ok(c)
    }

    /// Serve commands. `None` blocks until at least one command was handled; `Some(d)` waits
    /// at most `d`. Returns `Ok(false)` after `quit` or when the CLI disconnects.
    pub fn poll<G: Game>(&mut self, game: &mut G, timeout: Option<Duration>) -> io::Result<bool> {
        if self.quit {
            return Ok(false);
        }
        self.reader
            .get_ref()
            .set_read_timeout(timeout.map(|d| d.max(Duration::from_millis(1))))?;
        loop {
            match self.reader.read_until(b'\n', &mut self.line) {
                Ok(0) => return Ok(false), // disconnected
                Ok(_) if self.line.last() != Some(&b'\n') => return Ok(false), // EOF mid-line
                Ok(_) => {
                    let raw = std::mem::take(&mut self.line);
                    let text = String::from_utf8_lossy(&raw);
                    let text = text.trim();
                    if text.is_empty() {
                        continue;
                    }
                    let reply = self.handle(game, text.strip_prefix("@w").unwrap_or(text));
                    if let Some(reply) = reply {
                        self.send(&reply)?;
                    }
                    return Ok(!self.quit);
                }
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                    return Ok(true)
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(e)
                    if matches!(
                        e.kind(),
                        ErrorKind::ConnectionReset
                            | ErrorKind::ConnectionAborted
                            | ErrorKind::BrokenPipe
                    ) =>
                {
                    return Ok(false)
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// Frames stepped since the last reset.
    pub fn frame(&self) -> u64 {
        self.frame
    }
    /// Simulated seconds since the last reset.
    pub fn time(&self) -> f64 {
        self.time
    }

    fn send(&mut self, line: &str) -> io::Result<()> {
        let mut buf = Vec::with_capacity(line.len() + 1);
        buf.extend_from_slice(line.as_bytes());
        buf.push(b'\n');
        self.writer.write_all(&buf)
    }

    /// Answer one command line. `None` for unparseable lines (nothing to answer to).
    fn handle<G: Game>(&mut self, game: &mut G, text: &str) -> Option<String> {
        let msg = match Value::parse(text) {
            Ok(m @ Value::Object(_)) => m,
            _ => {
                eprintln!("[witness] ignoring malformed command line");
                return None;
            }
        };
        let id = msg["id"].clone();
        let result = self.dispatch(game, &msg);
        let mut out = String::with_capacity(64);
        out.push_str("{\"id\":");
        id.write_to(&mut out);
        match result {
            Ok(Value::Object(fields)) => {
                out.push_str(",\"ok\":true");
                for (k, v) in fields {
                    out.push(',');
                    json::write_string(&mut out, &k);
                    out.push(':');
                    v.write_to(&mut out);
                }
            }
            Ok(_) => out.push_str(",\"ok\":true"),
            Err(e) => {
                out.push_str(",\"ok\":false,\"error\":");
                json::write_string(&mut out, &e);
            }
        }
        out.push('}');
        Some(out)
    }

    fn dispatch<G: Game>(&mut self, game: &mut G, m: &Value) -> Result<Value, String> {
        match m["cmd"].as_str().unwrap_or("") {
            "reset" => {
                let seed = m["seed"].as_i64().unwrap_or(1);
                self.frame = 0;
                self.time = 0.0;
                self.queue.clear();
                self.held.clear();
                self.mouse = (0.0, 0.0, 0);
                self.touches.clear();
                self.audio.clear();
                FRAME.store(0, Ordering::Relaxed);
                game.reset(seed, m["scene"].as_str(), &m["params"])?;
                Ok(obj! {})
            }
            "input" => {
                for e in m["events"].as_array() {
                    let frame = e["frame"].as_f64().unwrap_or(0.0).max(0.0) as u64;
                    let input = Input::from_json(e);
                    // the mouse fallback: finger 0 is also the mouse unless the game handles touch
                    let mouse = input.mouse_from_touch().filter(|_| !self.touch_native);
                    self.queue.push(Event { frame, input });
                    if let Some(input) = mouse {
                        self.queue.push(Event { frame, input });
                    }
                }
                Ok(obj! {})
            }
            "step" => {
                let frames = m["frames"].as_i64().unwrap_or(1);
                if frames < 1 {
                    return Err("step: 'frames' must be >= 1".into());
                }
                let default_dt = m["dt"]
                    .as_f64()
                    .filter(|d| *d > 0.0)
                    .unwrap_or(1.0 / self.fps as f64);
                let dts = m["dts"].as_array();
                for i in 0..frames as usize {
                    let dt = dts.get(i).and_then(Value::as_f64).unwrap_or(default_dt);
                    self.step_once(game, dt);
                }
                Ok(obj! { "frame" => self.frame, "time" => self.time })
            }
            "snapshot" => {
                Ok(obj! { "frame" => self.frame, "time" => self.time, "state" => game.snapshot() })
            }
            "screenshot" => {
                let scale = m["scale"]
                    .as_f64()
                    .filter(|s| *s > 0.0 && *s <= 16.0)
                    .unwrap_or(1.0);
                let img = game
                    .screenshot()
                    .ok_or("this game doesn't provide screenshots")?;
                encode_image(&img, scale)
            }
            "audio" if self.audio.rate > 0 => {
                let mut bytes = Vec::with_capacity(self.audio.samples.len() * 4);
                for s in self.audio.samples.drain(..) {
                    bytes.extend_from_slice(&s.to_le_bytes());
                }
                Ok(
                    obj! { "sampleRate" => self.audio.rate, "channels" => self.audio.channels, "format" => "f32", "data" => base64(&bytes) },
                )
            }
            "call" => {
                let name = m["name"].as_str().unwrap_or("");
                Ok(obj! { "result" => game.call(name, m["args"].as_array())? })
            }
            "eval" => Ok(obj! { "value" => game.eval(m["expr"].as_str().unwrap_or(""))? }),
            "logs" => {
                let mut logs = LOGS.lock().unwrap_or_else(|e| e.into_inner());
                let mut out: Vec<Value> = logs
                    .0
                    .drain(..)
                    .map(|l| {
                        let level = match l.level {
                            Level::Info => "info",
                            Level::Warn => "warn",
                            Level::Error => "error",
                        };
                        obj! { "frame" => l.frame, "level" => level, "message" => l.message }
                    })
                    .collect();
                if logs.1 > 0 {
                    out.push(obj! { "frame" => self.frame, "level" => "warn", "message" => format!("witness: {} log lines dropped (buffer full)", logs.1) });
                    logs.1 = 0;
                }
                Ok(obj! { "logs" => out })
            }
            "perf" => Ok(game.perf()),
            "quit" => {
                self.quit = true;
                Ok(obj! {})
            }
            other => Err(format!("unknown command '{other}'")),
        }
    }

    fn step_once<G: Game>(&mut self, game: &mut G, dt: f64) {
        // due events, in arrival order
        let (due, later): (Vec<Event>, Vec<Event>) = std::mem::take(&mut self.queue)
            .into_iter()
            .partition(|e| e.frame <= self.frame);
        self.queue = later;
        let events: Vec<Input> = due.into_iter().map(|e| e.input).collect();
        for e in &events {
            self.track(e);
            game.input(e);
        }
        let mut step = Step {
            dt,
            frame: self.frame,
            time: self.time,
            events: &events,
            held: &self.held,
            mouse: self.mouse,
            touches: &self.touches,
            audio: &mut self.audio,
        };
        game.step(&mut step);
        self.frame += 1;
        self.time += dt;
        FRAME.store(self.frame, Ordering::Relaxed);
    }

    fn track(&mut self, e: &Input) {
        match e {
            Input::Key { key, down: true } if !self.held.contains(key) => {
                self.held.push(key.clone())
            }
            Input::Key { key, down: false } => self.held.retain(|k| k != key),
            Input::Mouse {
                pos, button, down, ..
            } => {
                if let Some((x, y)) = pos {
                    self.mouse.0 = *x;
                    self.mouse.1 = *y;
                }
                if let (Some(b), Some(d)) = (button, down) {
                    if *b < 8 {
                        if *d {
                            self.mouse.2 |= 1 << b;
                        } else {
                            self.mouse.2 &= !(1 << b);
                        }
                    }
                }
            }
            Input::Touch {
                id, x, y, phase, ..
            } => track_touch(&mut self.touches, *id, *x, *y, *phase),
            _ => {}
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        ACTIVE.store(false, Ordering::Relaxed);
    }
}

/// Witness runs games unattended: a crash must print to stderr and exit non-zero, never pop a
/// Windows error dialog that waits for a human. Called only in witness mode.
#[cfg(windows)]
fn quiet_crashes() {
    extern "system" {
        fn SetErrorMode(mode: u32) -> u32;
    }
    const SEM_FAILCRITICALERRORS: u32 = 0x0001;
    const SEM_NOGPFAULTERRORBOX: u32 = 0x0002;
    const SEM_NOOPENFILEERRORBOX: u32 = 0x8000;
    // SAFETY: SetErrorMode is a kernel32 call (always linked by std) with no pointer arguments.
    unsafe {
        let old = SetErrorMode(0);
        SetErrorMode(old | SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    }
}

#[cfg(not(windows))]
fn quiet_crashes() {}

/// Connect and serve commands until `quit` or disconnect.
pub fn run<G: Game>(hello: &Hello, game: &mut G) -> io::Result<()> {
    let mut c = Connection::connect(hello)?;
    while c.poll(game, None)? {}
    Ok(())
}

// ------------------------------------------------------------------ helpers

fn encode_image(img: &Image<'_>, scale: f64) -> Result<Value, String> {
    let (w, h) = (img.width as usize, img.height as usize);
    let stride = if img.stride > 0 { img.stride } else { w * 4 };
    if w == 0 || h == 0 || img.rgba.len() < stride * (h - 1) + w * 4 {
        return Err("screenshot: the image buffer is smaller than width x height".into());
    }
    let ow = ((w as f64 * scale).round() as usize).max(1);
    let oh = ((h as f64 * scale).round() as usize).max(1);
    let mut px = Vec::with_capacity(ow * oh * 4);
    for y in 0..oh {
        let mut sy = y * h / oh;
        if img.bottom_up {
            sy = h - 1 - sy;
        }
        let row = &img.rgba[sy * stride..];
        if ow == w {
            px.extend_from_slice(&row[..w * 4]);
        } else {
            for x in 0..ow {
                let sx = x * w / ow;
                px.extend_from_slice(&row[sx * 4..sx * 4 + 4]);
            }
        }
    }
    Ok(obj! { "width" => ow, "height" => oh, "format" => "rgba8", "data" => base64(&px) })
}

/// Standard base64 (with padding).
pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let v = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(T[(v >> 18) as usize] as char);
        out.push(T[(v >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[(v >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(v & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648() {
        for (i, o) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(i.as_bytes()), o);
        }
    }

    #[test]
    fn key_names() {
        for (i, o) in [
            ("Return", "enter"),
            ("Left Shift", "shift"),
            ("ArrowUp", "up"),
            ("KeyA", "a"),
            ("Digit7", "7"),
            (" ", "space"),
            ("F5", "f5"),
            ("Escape", "escape"),
        ] {
            assert_eq!(normalize_key(i), o);
        }
    }

    #[test]
    fn audio_frames_never_drift() {
        let mut a = AudioCapture {
            rate: 22050,
            channels: 1,
            samples: VecDeque::new(),
            emitted: 0,
        };
        let mut t = 0.0;
        for _ in 0..600 {
            let n = a.frames_for(t + 1.0 / 60.0);
            a.write(&vec![0.0; n]);
            t += 1.0 / 60.0;
        }
        assert_eq!(a.emitted, 220500);
    }

    fn finger(id: u32, phase: TouchPhase) -> Input {
        Input::Touch {
            id,
            x: 5.0,
            y: 6.0,
            phase,
            pressure: 1.0,
        }
    }

    fn fallback(input: &Input) -> String {
        match input.mouse_from_touch() {
            Some(mouse) => mouse.to_json().to_string(),
            None => String::new(),
        }
    }

    #[test]
    fn touch_parses_and_serializes() {
        let t = r#"{"type":"touch","id":1,"x":10.5,"y":20,"phase":"down","pressure":0.5}"#;
        let touch = Input::from_json(&Value::parse(t).unwrap());
        assert_eq!(touch.to_json().to_string(), t);
        // defaults: id 0, a missing phase is a move, pressure 1 (not written), never "down"
        let bare = Input::from_json(&Value::parse(r#"{"type":"touch","x":1,"y":2}"#).unwrap());
        let want = r#"{"type":"touch","id":0,"x":1,"y":2,"phase":"move"}"#;
        assert_eq!(bare.to_json().to_string(), want);
        assert_eq!(TouchPhase::parse("up").as_str(), "up");
    }

    #[test]
    fn finger_zero_is_also_the_mouse() {
        let down = r#"{"type":"mouse","x":5,"y":6,"button":0,"down":true}"#;
        let up = r#"{"type":"mouse","x":5,"y":6,"button":0,"down":false}"#;
        assert_eq!(fallback(&finger(0, TouchPhase::Down)), down);
        assert_eq!(
            fallback(&finger(0, TouchPhase::Move)),
            r#"{"type":"mouse","x":5,"y":6}"#
        );
        assert_eq!(fallback(&finger(0, TouchPhase::Up)), up);
        assert_eq!(fallback(&finger(1, TouchPhase::Down)), "");
        let mouse = finger(0, TouchPhase::Down).mouse_from_touch().unwrap();
        assert!(mouse.is_from_touch() && !finger(0, TouchPhase::Down).is_from_touch());
    }

    #[test]
    fn touch_cancel_parses_ends_and_round_trips() {
        let t = r#"{"type":"touch","id":0,"x":5,"y":6,"phase":"cancel"}"#;
        let touch = Input::from_json(&Value::parse(t).unwrap());
        assert_eq!(touch, finger(0, TouchPhase::Cancel));
        assert_eq!(touch.to_json().to_string(), t);
        assert_eq!(TouchPhase::parse("cancel"), TouchPhase::Cancel);
        assert_eq!(TouchPhase::parse("lift"), TouchPhase::Move);
        assert!(TouchPhase::Cancel.ends() && TouchPhase::Up.ends() && !TouchPhase::Move.ends());
        // the mouse fallback releases button 0, like up
        let up = r#"{"type":"mouse","x":5,"y":6,"button":0,"down":false}"#;
        assert_eq!(fallback(&touch), up);
        // the finger is no longer down
        let mut touches = Vec::new();
        track_touch(&mut touches, 0, 5.0, 6.0, TouchPhase::Down);
        track_touch(&mut touches, 1, 7.0, 8.0, TouchPhase::Down);
        track_touch(&mut touches, 0, 5.0, 6.0, TouchPhase::Cancel);
        assert_eq!(touches, vec![(1, 7.0, 8.0)]);
        // recorded as "cancel"
        let name = format!("witness-cancel-{}.jsonl", std::process::id());
        let path = std::env::temp_dir().join(name);
        let mut r = Recorder::create(path.clone(), "touch", 60).unwrap();
        r.touch(0, 5.0, 6.0, TouchPhase::Cancel);
        r.frame(0.5);
        drop(r);
        let text = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        let w = r#"{"f":0,"dt":0.5,"in":[{"type":"touch","id":0,"x":5,"y":6,"phase":"cancel"}]}"#;
        assert_eq!(text.lines().nth(1), Some(w));
    }

    #[test]
    fn recorder_writes_touch_and_skips_fallback_mouse() {
        let name = format!("witness-touch-{}.jsonl", std::process::id());
        let path = std::env::temp_dir().join(name);
        let mut r = Recorder::create(path.clone(), "touch", 60).unwrap();
        r.touch(0, 10.0, 20.0, TouchPhase::Down);
        r.input(&finger(0, TouchPhase::Down).mouse_from_touch().unwrap());
        r.frame(0.5);
        drop(r);
        let text = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        let w = r#"{"f":0,"dt":0.5,"in":[{"type":"touch","id":0,"x":10,"y":20,"phase":"down"}]}"#;
        assert_eq!(text.lines().nth(1), Some(w));
    }
}
