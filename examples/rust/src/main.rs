//! coins: the standard Witness sample game in Rust, using the `witness` crate.
//!
//! * witness mode (`WITNESS_ADDR` set, or `--witness`): headless, steps only on command with a
//!   fixed dt, renders on demand into an RGBA buffer, mixes audio per step.
//! * normal mode: a 2-second real-time demo with a scripted player (no window). With
//!   `WITNESS_RECORD=<file.jsonl>` set it records a replay that `witness replay` reproduces.

use std::time::{Duration, Instant};
use witness::{obj, Game, Hello, Image, Input, Recorder, Step, Value};

const W: usize = 320;
const H: usize = 180;
const FPS: u32 = 60;
const SAMPLE_RATE: u32 = 22050;
const SPEED: f64 = 120.0;

#[derive(Clone)]
struct Coin {
    id: u32,
    x: f64,
    y: f64,
}

/// The simulation: no clock, no window, no globals.
struct Coins {
    px: f64,
    py: f64,
    hp: u32,
    score: u32,
    coins: Vec<Coin>,
    held: [bool; 8],  // right, left, down, up, d, a, s, w
    voices: Vec<u32>, // "ding" voices, by age in samples
    pixels: Vec<u8>,
}

impl Coins {
    fn new(seed: i64) -> Coins {
        let mut g = Coins {
            px: 0.0,
            py: 0.0,
            hp: 3,
            score: 0,
            coins: Vec::new(),
            held: [false; 8],
            voices: Vec::new(),
            pixels: vec![0; W * H * 4],
        };
        g.restart(seed);
        g
    }

    fn restart(&mut self, seed: i64) {
        self.px = 40.0;
        self.py = 90.0;
        self.hp = 3;
        self.score = 0;
        self.held = [false; 8];
        self.voices.clear();
        self.coins = (0..5i64)
            .map(|i| Coin {
                id: 10 + i as u32,
                x: (80 + 40 * i) as f64,
                y: if i == 0 {
                    90.0
                } else {
                    (60 + (seed * 7 + i * 13) % 61) as f64
                },
            })
            .collect();
    }

    /// The game's normal input path.
    fn key(&mut self, key: &str, down: bool) {
        if let Some(i) = ["right", "left", "down", "up", "d", "a", "s", "w"]
            .iter()
            .position(|k| *k == key)
        {
            self.held[i] = down;
        }
    }

    fn update(&mut self, dt: f64) {
        let h = &self.held;
        let dx = (h[0] || h[4]) as i32 - (h[1] || h[5]) as i32;
        let dy = (h[2] || h[6]) as i32 - (h[3] || h[7]) as i32;
        self.px = (self.px + dx as f64 * SPEED * dt).clamp(0.0, W as f64);
        self.py = (self.py + dy as f64 * SPEED * dt).clamp(0.0, H as f64);
        let (px, py) = (self.px, self.py);
        let mut collected = Vec::new();
        self.coins.retain(|c| {
            let hit = (c.x - px).hypot(c.y - py) < 12.0;
            if hit {
                collected.push(c.id);
            }
            !hit
        });
        for id in collected {
            self.score += 1;
            self.voices.push(0);
            witness::info(format!("coin {id} collected"));
        }
    }

    /// Mixer: a ding is a 0.15 s 880 Hz decaying sine.
    fn mix(&mut self, out: &mut [f32]) {
        let len = (SAMPLE_RATE as f64 * 0.15) as u32;
        let sr = SAMPLE_RATE as f64;
        for s in out.iter_mut() {
            let mut v = 0.0;
            for age in self.voices.iter_mut() {
                if *age <= len {
                    let a = *age as f64;
                    v += (2.0 * std::f64::consts::PI * 880.0 * a / sr).sin()
                        * 0.5
                        * (-a / (sr * 0.04)).exp();
                }
                *age += 1;
            }
            *s = v as f32;
        }
        self.voices.retain(|age| *age <= len);
    }

    /// View: dark background, yellow coins, blue player.
    fn render(&mut self) {
        for p in self.pixels.chunks_exact_mut(4) {
            p.copy_from_slice(&[20, 24, 40, 255]);
        }
        let discs: Vec<(f64, f64, i32, [u8; 3])> = self
            .coins
            .iter()
            .map(|c| (c.x, c.y, 5, [255, 210, 60]))
            .chain(std::iter::once((self.px, self.py, 7, [80, 200, 255])))
            .collect();
        for (cx, cy, r, rgb) in discs {
            let (ox, oy) = ((cx + 0.5).floor() as i32, (cy + 0.5).floor() as i32);
            for y in -r..=r {
                for x in -r..=r {
                    let (px, py) = (ox + x, oy + y);
                    if x * x + y * y <= r * r
                        && px >= 0
                        && py >= 0
                        && (px as usize) < W
                        && (py as usize) < H
                    {
                        let i = (py as usize * W + px as usize) * 4;
                        self.pixels[i..i + 4].copy_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
                    }
                }
            }
        }
    }

    fn entity(id: u32, kind: &str, x: f64, y: f64) -> Value {
        obj! { "id" => id, "type" => kind, "pos" => [x, y] }
    }
}

/// The Witness wiring: a thin layer over the simulation.
impl Game for Coins {
    fn reset(&mut self, seed: i64, _scene: Option<&str>, _params: &Value) -> Result<(), String> {
        self.restart(seed);
        Ok(())
    }

    fn input(&mut self, event: &Input) {
        match event {
            Input::Key { key, down } => self.key(key, *down),
            Input::Action { action, down: true } if action == "dash" => self.px += 30.0,
            _ => {}
        }
    }

    fn step(&mut self, step: &mut Step) {
        self.update(step.dt);
        let mut buf = vec![0.0f32; step.audio_frames()];
        self.mix(&mut buf);
        step.write_audio(&buf);
    }

    fn snapshot(&mut self) -> Value {
        let mut player = Coins::entity(1, "Player", self.px, self.py);
        player.set("hp", self.hp);
        let mut entities = vec![player.clone()];
        entities.extend(
            self.coins
                .iter()
                .map(|c| Coins::entity(c.id, "Coin", c.x, c.y)),
        );
        obj! { "score" => self.score, "scene" => "level1", "player" => player, "entities" => entities }
    }

    fn screenshot(&mut self) -> Option<Image<'_>> {
        self.render();
        Some(Image {
            width: W as u32,
            height: H as u32,
            rgba: &self.pixels,
            stride: 0,
            bottom_up: false,
        })
    }

    fn call(&mut self, name: &str, args: &[Value]) -> Result<Value, String> {
        let num = |i: usize, def: f64| args.get(i).and_then(Value::as_f64).unwrap_or(def);
        match name {
            "teleport" => {
                self.px = num(0, self.px);
                self.py = num(1, self.py);
                Ok([self.px, self.py].into())
            }
            "addcoin" => {
                let id = 100 + self.coins.len() as u32;
                self.coins.push(Coin {
                    id,
                    x: num(0, 0.0),
                    y: num(1, 0.0),
                });
                Ok(self.coins.len().into())
            }
            _ => Err(format!("unknown call '{name}' (try teleport, addcoin)")),
        }
    }

    fn perf(&mut self) -> Value {
        obj! { "counts" => obj! { "coins" => self.coins.len() } }
    }
}

fn main() -> std::io::Result<()> {
    if witness::active() {
        let hello = Hello::new("Coins (Rust)")
            .engine("witness-rs sample")
            .fps(FPS)
            .size(W as u32, H as u32)
            .call("teleport", "x y", "move the player")
            .call("addcoin", "x y", "add a coin, returns the coin count")
            .keys(&["left", "right", "up", "down", "a", "d", "w", "s"])
            .screenshot()
            .audio(SAMPLE_RATE, 1)
            .perf();
        return witness::run(&hello, &mut Coins::new(1));
    }
    demo();
    Ok(())
}

/// Normal play. A real game pumps window events here; this one scripts a short session.
fn demo() {
    let mut rec = Recorder::from_env("Coins (Rust)", FPS);
    let seed = rec.as_ref().map_or_else(witness::seed, Recorder::seed);
    let mut game = Coins::new(seed);
    let (mut t, mut holding, mut marked) = (0.0, false, false);
    let mut last = Instant::now();
    while t < 2.0 {
        std::thread::sleep(Duration::from_millis(16)); // real time: fine outside witness mode
        let now = Instant::now();
        let dt = now.duration_since(last).as_secs_f64().min(0.1);
        last = now;
        // "player": hold right from 0 s to 1.2 s, press F8 at 0.5 s
        let mut press = |game: &mut Coins, key: &str, down: bool| {
            game.key(key, down);
            if let Some(r) = rec.as_mut() {
                r.key(key, down);
            }
        };
        if !holding && t < 1.2 {
            holding = true;
            press(&mut game, "right", true);
        }
        if holding && t >= 1.2 {
            holding = false;
            press(&mut game, "right", false);
        }
        if !marked && t >= 0.5 {
            marked = true;
            press(&mut game, "f8", true);
        }
        game.update(dt);
        if let Some(r) = rec.as_mut() {
            r.frame(dt);
        }
        t += dt;
    }
    println!(
        "demo finished: t={t:.3}s seed={seed} score={} player=({:.4}, {:.4}) coins={}",
        game.score,
        game.px,
        game.py,
        game.coins.len()
    );
    println!(
        "{}",
        if rec.is_some() {
            "replay recorded (play it back with: witness replay last)"
        } else {
            "tip: set WITNESS_RECORD=witness/replays/demo.jsonl to record a replay; run 'witness test' to verify"
        }
    );
}
