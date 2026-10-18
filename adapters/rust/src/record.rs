//! Replay recording for normal play (docs/PROTOCOL.md §5).

use crate::{active, normalize_key, obj, seed, Input, TouchPhase, Value};
use std::fs::{self, File};
use std::io::{self, BufWriter, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Writes a `WITNESS_RECORD` replay while a human plays.
///
/// ```no_run
/// let mut rec = witness::Recorder::from_env("My Game", 60);   // None unless WITNESS_RECORD is set
/// let seed = rec.as_ref().map_or_else(witness::seed, |r| r.seed());
/// // event pump:      if let Some(r) = &mut rec { r.key("right", true); }
/// // after each tick: if let Some(r) = &mut rec { r.frame(dt); }
/// ```
pub struct Recorder {
    out: BufWriter<File>,
    path: PathBuf,
    seed: i64,
    frame: u64,
    pending: Vec<Value>,
    mark: Option<String>,
}

impl Recorder {
    /// Start recording if `WITNESS_RECORD=<file.jsonl>` is set and Witness is not driving the
    /// game. Creates missing folders. Errors are reported on stderr and yield `None`.
    pub fn from_env(game_name: &str, fps: u32) -> Option<Recorder> {
        let path = PathBuf::from(std::env::var_os("WITNESS_RECORD").filter(|p| !p.is_empty())?);
        if active() {
            return None;
        }
        match Recorder::create(path.clone(), game_name, fps) {
            Ok(r) => Some(r),
            Err(e) => {
                eprintln!("[witness] can't record to {}: {e}", path.display());
                None
            }
        }
    }

    /// Record to an explicit file (most games use [`from_env`](Self::from_env)).
    pub fn create(path: PathBuf, game_name: &str, fps: u32) -> io::Result<Recorder> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            fs::create_dir_all(dir)?;
        }
        let mut r = Recorder {
            out: BufWriter::new(File::create(&path)?),
            path,
            seed: seed(),
            frame: 0,
            pending: Vec::new(),
            mark: None,
        };
        let head = obj! {
            "replay" => 1,
            "name" => game_name,
            "seed" => r.seed,
            "fps" => fps.max(1),
            "started" => iso_now(),
            "adapter" => concat!("witness-rs ", env!("CARGO_PKG_VERSION")),
        };
        writeln!(r.out, "{head}")?;
        r.out.flush()?;
        Ok(r)
    }

    /// The seed this recording uses: seed the game's RNG with it.
    pub fn seed(&self) -> i64 {
        self.seed
    }
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    /// Queue an input for the current frame. A key press of F8 becomes a mark instead, and a
    /// mouse event made from finger 0 ([`Input::is_from_touch`]) is skipped: the replay's mouse
    /// fallback recreates it from the touch.
    pub fn input(&mut self, input: &Input) {
        if input.is_from_touch() {
            return;
        }
        if let Input::Key { key, down } = input {
            if key == "f8" {
                if *down {
                    self.mark("F8");
                }
                return;
            }
        }
        self.pending.push(input.to_json());
    }
    /// Queue a key event (any common key name; normalized to the Witness name).
    pub fn key(&mut self, key: &str, down: bool) {
        self.input(&Input::Key {
            key: normalize_key(key),
            down,
        });
    }
    /// Queue a mouse event: `button: None` for a move.
    pub fn mouse(&mut self, x: f64, y: f64, button: Option<u8>, down: bool) {
        self.input(&Input::Mouse {
            pos: Some((x, y)),
            button,
            down: button.map(|_| down),
            from_touch: false,
        });
    }
    /// Queue a finger event: `id` 0 = the first finger down (keep it until `Up`), `x`/`y` in
    /// logical pixels (convert from the engine's normalized 0..1 coordinates). Don't also record
    /// the mouse events the platform synthesizes from touch: replay recreates them.
    pub fn touch(&mut self, id: u32, x: f64, y: f64, phase: TouchPhase) {
        self.input(&Input::Touch {
            id,
            x,
            y,
            phase,
            pressure: 1.0,
        });
    }
    /// Flag this frame (shown by `witness replay` / `trace`).
    pub fn mark(&mut self, label: &str) {
        self.mark = Some(if label.is_empty() {
            "mark".into()
        } else {
            label.into()
        });
    }

    /// End of one simulation step: write its dt and queued inputs. Flushed every frame so a
    /// crash still leaves a usable replay.
    pub fn frame(&mut self, dt: f64) {
        let mut line = obj! { "f" => self.frame, "dt" => dt };
        if !self.pending.is_empty() {
            line.set("in", Value::Array(std::mem::take(&mut self.pending)));
        }
        if let Some(m) = self.mark.take() {
            line.set("mark", m);
        }
        if let Err(e) = writeln!(self.out, "{line}").and_then(|_| self.out.flush()) {
            eprintln!("[witness] replay write failed: {e}");
        }
        self.frame += 1;
    }
}

/// UTC ISO-8601 timestamp (no chrono dependency).
fn iso_now() -> String {
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    let (days, secs) = (t.div_euclid(86400), t.rem_euclid(86400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs / 3600,
        secs / 60 % 60,
        secs % 60
    )
}
