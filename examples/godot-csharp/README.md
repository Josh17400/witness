# Coins: Godot 4 (.NET) example

The standard Witness sample game (docs/ADAPTERS.md) as a Godot 4.7 C# project.

* `Coins.cs`: an ordinary scene script (Node2D). It reads input with `Input.IsKeyPressed`, logs with
  `GD.Print`, plays its sound through an `AudioStreamPlayer`, and draws with `_Draw`. The only
  Witness-specific parts: the snapshot (`IWitnessState`), two `RegisterCall`s, and
  `WitnessNode.Mix(...)` next to the sound.
* `addons/witness/`: copies of `adapters/csharp/Witness.cs` and `adapters/godot-csharp/WitnessNode.cs`
  (CI checks they're identical), registered as the `Witness` autoload in `project.godot`.
* `witness/.gdignore` keeps Godot from importing test files and screenshots.

## Run

Needs the Godot 4.7 **.NET** editor (on PATH as `godot`, or edit `witness.json`), the .NET 8 SDK and
Node 18+.

```
dotnet build Coins.csproj
godot --headless --path . --import          # first time only: creates .godot/
node ../../bin/witness.js doctor
node ../../bin/witness.js test
```

Tests run `--headless` (no window, no renderer), so `doctor` lists `(screenshot)` as unsupported.
Screenshots need a renderer: `witness shot --cmd "godot --path . --fixed-fps 60"` works on a desktop,
but opens a window. Open the folder in the Godot editor to play it normally (arrows/WASD).
