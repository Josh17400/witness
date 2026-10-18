# coins: Go example (package `witness`)

The standard Witness sample game (see `docs/ADAPTERS.md`), using the std-only package in
`adapters/go` (wired in with a `replace` directive in `go.mod`).

`main.go` contains:
* `Coins`, the simulation (no clock, window or globals), drawing into an `image.RGBA` and mixing a small synth;
* its Witness methods: `Reset`, `Step` (with per-step audio), `Snapshot` (the `witness.Game` interface),
  plus `Input`, `Screenshot`, `Call` and `Perf`, which the adapter discovers by interface;
* `demo()`, normal play: a 2-second real-time scripted session, recording a replay when
  `WITNESS_RECORD` is set.

There's no window: in witness mode the game is headless, as the protocol prefers.

## Build and verify (Go 1.21+)

```
go build -o build/ .
node ../../bin/witness.js doctor
node ../../bin/witness.js test
```

`witness.json` launches `go run .`, so the CLI rebuilds when sources change.

## Record and replay

```
WITNESS_RECORD=witness/replays/demo.jsonl WITNESS_SEED=4 ./build/coins     # PowerShell: $env:WITNESS_RECORD=...
node ../../bin/witness.js replay last --watch "state.player.pos, state.score"
```

The replay re-simulates the recorded (irregular, real-time) dts and reaches the same final
position the demo prints. CI checks this to 4 decimal places.
