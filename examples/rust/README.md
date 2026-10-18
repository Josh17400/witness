# coins: Rust example (`witness` crate)

The standard Witness sample game (see `docs/ADAPTERS.md`), using the std-only crate in
`adapters/rust` as a path dependency.

`src/main.rs` contains:
* `Coins`, the simulation (no clock, window or globals) with a software rasterizer and a small synth;
* `impl witness::Game for Coins`, the Witness wiring (reset, input, step with per-step audio,
  snapshot, screenshot, calls, perf);
* `demo()`, normal play: a 2-second real-time scripted session, recording a replay when
  `WITNESS_RECORD` is set.

There's no window: in witness mode the game is headless, as the protocol prefers.

## Build and verify

```
cargo build --release
node ../../bin/witness.js doctor
node ../../bin/witness.js test
```

`witness.json` launches `cargo run --release --quiet`, so the CLI rebuilds when sources change.
The first launch compiles; the timeout is 180 s for that reason.

## Record and replay

```
WITNESS_RECORD=witness/replays/demo.jsonl WITNESS_SEED=4 cargo run --release     # PowerShell: $env:WITNESS_RECORD=...
node ../../bin/witness.js replay last --watch "state.player.pos, state.score"
```

The replay re-simulates the recorded (irregular, real-time) dts and reaches the same final
position the demo prints. CI checks this to 4 decimal places.
