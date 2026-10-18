# Witness for Godot 4 (.NET / C#): integration guide (for Claude)

You are wiring Witness into a Godot 4 C# project you may not know yet. Two files go in
`addons/witness/`: `Witness.cs` (the shared C# adapter) and `WitnessNode.cs` (an autoload that
drives Godot's main loop). GDScript-only projects use the `godot` adapter instead.

How it works in witness mode (`WITNESS_ADDR` set): the autoload pauses the SceneTree and **blocks the
main loop at the end of each frame** while it answers commands. A `step N` unpauses for exactly N
frames; with `--fixed-fps` each frame is one physics tick + one process call with the same delta.
Input goes through `Input.ParseInputEvent`, `reset` reloads the scene, engine errors are forwarded
to the CLI (`OS.AddLogger`). When `WITNESS_ADDR` isn't set the node disables its own processing.

Reference: `examples/godot-csharp/` (`Coins.cs` is an ordinary scene script). Verified with Godot
4.7.2 .NET, headless, on Windows. Order of work, checking with `witness doctor` each time:
**autoload + launch → snapshot → input → reset/seed → calls → audio → screenshots (optional).**

## 1. Install

1. Copy `Witness.cs` and `WitnessNode.cs` into `res://addons/witness/` (`witness init` does this).
2. Register the autoload (Project Settings > Autoload, or in `project.godot`):
   ```ini
   [autoload]
   Witness="*res://addons/witness/WitnessNode.cs"
   ```
3. Build once so Godot knows the class: `dotnet build` (or the editor's Build button).
4. `witness.json`:
   ```json
   { "name": "mygame",
     "build": "dotnet build --nologo -v q && godot --headless --path . --import",
     "launch": { "command": "godot", "args": ["--headless", "--path", ".", "--fixed-fps", "60"] },
     "tests": "witness", "seed": 1, "timeout": 120 }
   ```
   `"command"` is the Godot .NET editor binary (on Windows prefer the `_console.exe`; put it on PATH
   as `godot` or write its full path). `--fixed-fps` must equal Project Settings > Physics > Common >
   Physics Ticks per Second (60 by default); the node warns if it's missing. Keep `--headless` for
   tests: no window, no dialogs, works in CI.
5. Put a `.gdignore` file in your `witness/` folder so Godot doesn't import test screenshots.

## 2. Where to hook in

Nothing to call from the game loop. Configure the bridge from your main scene's `_Ready` (it says
hello at the end of the first frame, after `_Ready` ran):

```csharp
using WitnessKit;

public override void _Ready()
{
    WitnessNode.Hello.Name = "My Game";                                   // Fps/size default to project settings
    WitnessNode.RegisterCall("teleport", "x y", "move the player", args =>
    {
        _player.GlobalPosition = new Vector2((float)WitnessJson.Double(args[0], 0), (float)WitnessJson.Double(args[1], 0));
        return new[] { _player.GlobalPosition.X, _player.GlobalPosition.Y };
    });
}
```

Optional hooks (static): `WitnessNode.Snapshot` (replace the default snapshot),
`WitnessNode.Reset` (a synchronous reset instead of a scene reload), `WitnessNode.Perf`.
`RegisterCall` is safe to call again after every reload.

## 3. The game loop in witness mode

No restructuring is needed if the game already uses `delta`:

* `_PhysicsProcess(delta)` runs exactly once per stepped frame, `_Process(delta)` once, both with
  `delta = dt` (Witness sets `Engine.TimeScale = dt × fps`, so replays with variable dt work).
* Timers, Tweens, AnimationPlayers and physics bodies follow the same scaled time.
* Don't read `Time.GetTicksMsec()` / `OS.GetUnixTime()` / `DateTime.Now` in gameplay.
* Between steps the tree is paused (`GetTree().Paused`), so nodes with `ProcessMode = Always` still
  run during reset frames; give gameplay nodes the default `Inherit`/`Pausable` mode.
* `await ToSignal(GetTree().CreateTimer(x), "timeout")` is fine (it's frame-driven). Threads
  (`Task.Run`, `WorkerThreadPool`) that change game state must be joined within the frame.

## 4. Input through the normal path

Witness events become real `InputEvent`s: keys → `InputEventKey` (Keycode + PhysicalKeycode),
mouse → `InputEventMouseButton`/`InputEventMouseMotion`, wheel → wheel button presses, text →
unicode key events, `action` → `InputEventAction`, pad → `InputEventJoypadButton`/`Motion`. They're
flushed at the start of the frame, before any `_PhysicsProcess`, so `Input.IsActionPressed`,
`Input.IsKeyPressed`, `_Input` and `_UnhandledInput` all see them. Keys map by name to `Godot.Key`
(`right` → `Key.Right`, `1` → `Key.Key1`, `shift` → `Key.Shift`). Input maps that bind physical
keys work too. Mouse coordinates are viewport pixels (equal to window pixels under `--headless`).
Held keys are released on reset.

**Touch** (`touch:160,90@1`, `swipe:40,90->200,90@1-1.5`): a down/up becomes
`InputEventScreenTouch` (`Index` = Witness finger id, `Position`, `Pressed`), a move becomes
`InputEventScreenDrag` (`Index`, `Position`, `Relative` from that finger's last position, `Velocity`,
`Pressure`), in the same coordinates as the mouse. The mouse fallback is Godot's own: with Project
Settings > Input Devices > Pointing > **Emulate Mouse From Touch** on (the default), Godot turns the
first finger into `InputEventMouseButton` / `InputEventMouseMotion` (with `Device == -1`,
`InputEvent.DeviceIdEmulation`), exactly as on a phone, so touch tests drive mouse-driven UI and
gameplay. A game that handles touch itself turns that setting off; the hello then says
`"touch": true` and only the touch events arrive. Fingers still down are lifted on reset.

## 5. Reset and RNG seeding

Default reset: `GD.Seed(seed)`, `ReloadCurrentScene()` (or `ChangeSceneToFile("res://<scene>.tscn")`
for `reset` with a scene name), then one paused frame so the new scene's `_Ready` runs before the
reply. Your scene must therefore build its whole initial state in `_Ready`, and seed its own RNGs
from `Witness.Seed`:

```csharp
_rng = new RandomNumberGenerator { Seed = (ulong)Witness.Seed };   // GD.Randf() is seeded by the bridge
```

Autoloads survive reloads: reset their state in `WitnessNode.Reset` (or from your scene's `_Ready`).
Static C# fields also survive.

## 6. Snapshot: expose state.entities

Either implement `IWitnessState` on the **scene root** (it returns the whole snapshot):

```csharp
public partial class Level : Node2D, IWitnessState
{
    public object WitnessState() => new Dictionary<string, object> {
        { "score", _score }, { "player", Ent(_player) },
        { "entities", GetTree().GetNodesInGroup("actors").Select(n => (object)Ent((Node2D)n)).ToList() },
    };
}
```

or add nodes to the group **`witness`**: the default snapshot lists them in tree order as
`{id, type, pos}` (`id` = path from the scene root or `witness_id` meta; `type` = C# class name or
`witness_type` meta; `pos` = global position), plus the fields of any node that implements
`IWitnessState`. Never use `GetInstanceId()` as an id: it changes on every reload.

## 7. Audio capture

Godot mixes audio on its own thread in real time, which can't follow stepped time, so capture is
explicit: set `Witness.Pcm = new WitnessPcm(22050, 1)` (in `_Ready`, when `Witness.Active`) and
call `WitnessNode.Mix(wavStream)` next to `player.Play()` for sounds tests should hear. `Mix`
decodes 8/16-bit PCM `AudioStreamWav`s at the current simulated time; for generated audio call
`Witness.Pcm.Play(floatSamples)`.

## 8. Screenshots

`--headless` has no renderer, so the bridge leaves `screenshot` out of its capabilities there.
Screenshots need Godot running with a renderer (no `--headless`), which opens a window: use that
only on a machine where a window is acceptable, or under a virtual display in CI (`xvfb-run godot
--path . --fixed-fps 60 --rendering-driver opengl3`). The bridge then calls
`RenderingServer.ForceDraw()` and returns `GetViewport().GetTexture().GetImage()` as RGBA, so the
image is the current frame.

## 9. Replay recording

Run the game normally with `WITNESS_RECORD=run.jsonl`: the node records each frame's delta and key /
mouse-button / touch events (`InputEventScreenTouch` → touch down/up, `InputEventScreenDrag` → move;
F8 adds a mark) and flushes on exit. Emulated events (`Device == -1`: the mouse Godot makes from
touch, or touch made from the mouse) are skipped, because the replay makes Godot emulate them again.
Seed with `Witness.Seed`. Physics in normal play may tick 0 or 2 times per frame; record with
`--fixed-fps 60` for replays that match exactly.

## 10. Determinism pitfalls (Godot)

* `_Process` vs `_PhysicsProcess`: with `--fixed-fps` equal to the physics tick rate there is exactly
  one of each per frame. Without it, Godot runs a variable number of physics ticks per frame and
  replays drift.
* Physics: the bridge sets `Engine.PhysicsJitterFix = 0`. Jolt and Godot Physics are deterministic
  for the same step sequence on one machine.
* `GetTree().GetNodesInGroup()` returns tree order: stable. C# `Dictionary`/`HashSet` iteration is
  not guaranteed: sort before using.
* Scene changes and `QueueFree` are deferred to the end of the frame; check results a frame later.
* Navigation agents and `NavigationServer` sync asynchronously; wait a frame after (re)loading.

## 11. Verify

```
witness doctor        # connection, step, snapshot, determinism, audio (screenshot only with a renderer)
witness eval --keys   # every snapshot path
witness test
```

If the game never connects, run the launch command by hand with `WITNESS_ADDR=127.0.0.1:7357` and
read Godot's output (missing build, wrong autoload path, `--fixed-fps` warning).
