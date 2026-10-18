# Coins: C# / .NET example

The standard Witness sample game (docs/ADAPTERS.md) on .NET 8, using `adapters/csharp/Witness.cs`
directly (linked by `Coins.csproj`, not copied).

* `CoinsGame.cs`: the game as a pure simulation (no clock, no console, no window).
* `Program.cs`: witness mode (`Witness.Start` + `Witness.Run`) or, without `WITNESS_ADDR`, a real-time
  ASCII console game (arrows/WASD, F8 marks the replay, Esc quits). Real-time mode needs an
  interactive console; consoles report key presses but not releases, so a key counts as held until
  its auto-repeat stops (about half a second).

## Run

Needs the .NET 8 SDK and Node 18+.

```
dotnet build Coins.csproj -c Release -o build
node ../../bin/witness.js doctor
node ../../bin/witness.js test
```

(`witness test --build` runs the build command from `witness.json` first.)

Play and record a replay, then play it back headlessly:

```
WITNESS_RECORD=witness/replays/run.jsonl dotnet build/Coins.dll
node ../../bin/witness.js replay witness/replays/run.jsonl
```

Witness mode prints nothing and opens nothing; a crash prints to stderr and exits non-zero.
