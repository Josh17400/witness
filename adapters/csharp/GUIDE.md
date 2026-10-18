# Witness for C# / .NET: integration guide (for Claude)

You are wiring Witness into a C# game you may not know yet. The adapter is one file, `Witness.cs`
(netstandard2.0, C# 7.3, no dependencies), so it works in .NET 6/8 console or windowed games,
MonoGame, FNA, Stride and custom engines. Unity and Godot have their own adapters (`unity`,
`godot-csharp`) built on this same file; use those for those engines.

Witness launches the game with `WITNESS_ADDR=127.0.0.1:<port>`. The game connects, says hello and
from then on **only advances when told to**, at a fixed dt. Your job: give the adapter a reset, a
one-frame step, input, a snapshot and (if cheap) a screenshot and audio.

Reference: `examples/csharp/` (`CoinsGame.cs` is a pure simulation, `Program.cs` wires it). Read it
first; it's short. Work in this order and run `witness doctor` after each step:
**connect → step + snapshot → input → reset/seed → screenshot → audio → recording.**

## 1. Install

1. Copy `Witness.cs` into the project (`witness init` puts it in `witness/Witness.cs`; SDK-style
   projects compile it automatically). Everything is in the `WitnessKit` namespace.
2. `witness.json` next to the project:
   ```json
   { "name": "mygame",
     "build": "dotnet build -c Release -o build",
     "launch": { "command": "dotnet", "args": ["build/MyGame.dll"] },
     "tests": "witness", "seed": 1 }
   ```
   `dotnet build/MyGame.dll` works on every OS; the apphost (`build/MyGame.exe`) works too. Add
   `"cwd"` if assets load relative to the working directory.

## 2. Where to hook in

Decide the mode at the top of `Main`, **before** a window, audio device, frame limiter or the
player's save/settings exist:

```csharp
using WitnessKit;

static int Main(string[] args)
{
    var game = new Game();                       // must not open a window or device in its constructor
    var hello = new WitnessHello {
        Name = "My Game", Engine = "MonoGame", Fps = 60, Width = 1280, Height = 720,
        Calls = { new WitnessCall("teleport", "x y", "move the player") },
    };
    var h = new WitnessHandlers {
        Reset    = (seed, scene, args) => game.Reset(seed, scene),
        Input    = e => game.Input.Apply(e),     // WitnessEvent, at the start of its frame
        Step     = dt => game.Update(dt),        // exactly one frame
        Snapshot = () => game.WitnessState(),
        Screenshot = scale => game.RenderToImage(),
        Call     = (name, a) => game.Debug(name, a),
    };
    if (Witness.Active)
    {
        Witness.Pcm = new WitnessPcm(44100, 2);  // before Start, so hello advertises "audio"
        if (!Witness.Start(hello, h)) return 1;  // couldn't connect: exit non-zero
        Witness.Run(h);                          // owns the loop until the CLI quits
        return 0;
    }
    Witness.Start(hello);                        // normal play: records if WITNESS_RECORD is set
    return game.RunRealTime();
}
```

`Witness.Active` is true when `WITNESS_ADDR` is set or `--witness` was passed. Capabilities in the
hello are derived from which handlers are non-null (plus `audio` when `Witness.Pcm` is set).

Lower-level API, for engines that own their loop: `Witness.Connect(hello, h)`,
`Witness.TryNext(out cmd)` / `Witness.Next(timeoutMs)`, `Witness.Handle(cmd, h)`,
`cmd.Reply(dict)` / `cmd.Fail(msg)`, `Witness.BeginFrame()` (due events) and
`Witness.EndFrame(dt)` (advances `Witness.Frame` / `Witness.Time`, syncs audio),
`Witness.StepDts(cmd)` (per-frame dts of a step).

## 3. Restructure the loop for witness mode

`Step(dt)` must be **one complete frame** of simulation with the given dt: input already applied
(the adapter calls `Input` for that frame's events first), then update, then whatever end-of-frame
bookkeeping the game does. Typical refactor:

```csharp
// before: void Tick() { var dt = stopwatch.Elapsed; PollInput(); Update(dt); Render(); }
public void Update(double dt) { world.Update(dt); particles.Update(dt); timers.Update(dt); }
public void RunRealTime() { while (running) { var dt = clock.Lap(); PollDevices(); Update(dt); Render(); Witness.RecordFrame(dt, framesEvents); } }
```

* No `Stopwatch`, `DateTime.Now`, `Environment.TickCount` or `Task.Delay` in gameplay: everything
  that measures time takes `dt` (or reads a game clock advanced by `Step`).
* Fixed-timestep accumulators: in witness mode run exactly one fixed update per `Step` (Witness
  already gives you a fixed dt; replays may pass a different dt per frame via `dts`).
* Rendering is not needed per step. Render only inside the `Screenshot` handler.
* Witness mode must not open a window, audio device or vsync'd swap chain. If the engine insists on
  a window, create it hidden. Crashes must print to stderr and exit non-zero; add
  `AppDomain.CurrentDomain.UnhandledException += (s, e) => { Console.Error.WriteLine(e.ExceptionObject); Environment.Exit(3); };`
  in witness mode so Windows never shows a crash dialog. No `Debug.Assert` UI, no message boxes.
* Saves/settings: point them at a temp folder when `Witness.Active`.

## 4. Input through the game's normal path

The `Input` handler receives a `WitnessEvent` (`Type` = key / mouse / wheel / text / action / pad /
axis; `Key`, `Down` (bool?), `X`, `Y`, `Button`, `Dy`, `Text`, `Action`, `PadButton`, `Axis`,
`Value`). Feed it into the same input state the real device code writes, so gameplay can't tell:

```csharp
public void Apply(WitnessEvent e)
{
    switch (e.Type)
    {
        case "key":
            Keys k;                                          // the engine's key enum
            if (WitnessKeys.TryParse(e.Key, out k)) { if (e.IsDown) held.Add(k); else held.Remove(k); }
            break;
        case "mouse": mouse = new Point((int)e.X, (int)e.Y); if (e.Down.HasValue) buttons[e.Button] = e.IsDown; break;
        case "wheel": wheel += (int)-e.Dy; break;           // Witness +dy = scroll down
        case "action": actions.Set(e.Action, e.IsDown); break;
    }
}
```

`WitnessKeys.TryParse<TEnum>` maps Witness names (`right`, `space`, `1`, `shift`, `f8`) to any key
enum by name: MonoGame/FNA `Keys`, `ConsoleKey`, WinForms `Keys`, SDL wrappers. The reverse,
`WitnessKeys.Normalize(engineKey.ToString())`, is for recording. Pull-style games can read
`Witness.FrameEvents` inside `Step` instead of setting `Input`.

## 5. Reset and RNG seeding

`Reset(seed, scene, params)` must rebuild the initial state completely: entities, score, timers,
camera, input state (release held keys) **and every RNG**:

```csharp
rng = new Pcg32((ulong)seed);   // your own PRNG: System.Random's algorithm is not guaranteed across .NET versions
```

`new Random(seed)` is deterministic within one runtime version but has differed between .NET
Framework, .NET Core and .NET 6+; prefer a tiny PRNG you own (xorshift, PCG). `Witness.Seed` gives
the seed to use in normal play too (the reset seed, `WITNESS_SEED`, or a per-run seed written to the
replay header). Never seed from the clock.

## 6. Snapshot: expose state.entities

Return dictionaries/lists/primitives. Conventions that unlock CLI helpers (`count('Coin')`,
`first('Player')`, `near(pos, 'Enemy')`):

```csharp
public object WitnessState() => new Dictionary<string, object> {
    { "scene", scene.Name }, { "score", score },
    { "player", Entity(player) },
    { "entities", world.Entities.OrderBy(e => e.Id).Select(Entity).ToList() },   // stable order
};
static Dictionary<string, object> Entity(Ent e) => new Dictionary<string, object> {
    { "id", e.Id }, { "type", e.Kind }, { "pos", new[] { e.X, e.Y } }, { "hp", e.Hp } };
```

The JSON writer handles `IDictionary`, `IEnumerable`, numbers, enums (as names), and turns any
`Vector2/3/4` (System.Numerics, MonoGame, Stride) or `Point` into `[x, y(, z)]`. Other objects are
written as their public fields. NaN/Infinity become `"NaN"` / `"Infinity"`. Ids must be stable
across runs (no `GetHashCode`, no allocation counters that survive a reset).

## 7. Screenshots

Return `WitnessImage.FromRgba(w, h, rgbaTopDown)`, `FromPng(bytes)` or `FromFile(path)`. GPU
readbacks are usually bottom-up: pass `bottomUp: true`. The `scale` argument is applied by Witness
(nearest neighbour) for RGBA images.

## 8. Audio capture

Set `Witness.Pcm = new WitnessPcm(sampleRate, channels)` in witness mode. Then either
`Witness.Pcm.Play(samples)` when the game triggers a sound (mixed at the current simulated time),
or `Witness.Pcm.Write(block)` from your mixer each frame (a continuous stream). Witness keeps the
buffer exactly `round(time × sampleRate)` frames long and returns f32 PCM on `audio`. Do not open
the real audio device in witness mode.

## 9. Replay recording

Normal play with `WITNESS_RECORD=run.jsonl`: `Witness.Start(hello)` opens the file, then once per
frame `Witness.RecordFrame(dt, eventsThisFrame)` (the same `WitnessEvent`s you'd apply), and
`Witness.Mark("F8")` when the player presses F8. Call `Witness.StopRecording()` on exit (it also
runs on `ProcessExit`). Seed the game with `Witness.Seed`. `witness replay run.jsonl` plays it back
through reset + input + per-frame dts.

## 10. Determinism pitfalls (.NET)

* `Dictionary`/`HashSet` enumeration order depends on insertion/removal history; sort before
  iterating in gameplay or snapshots. `GetHashCode()` of strings is randomized per process.
* `float` math is deterministic on one machine/runtime, but don't mix `MathF` and `Math` between
  record and replay builds; avoid `Parallel.For` and thread-pool work that mutates game state.
* `async`/`Task` continuations that touch game state must complete inside `Step`.
* Static state survives `Reset`: clear static caches, pools and id counters there.

## 11. MonoGame / FNA

`Game.Run()` owns a real-time loop, so in witness mode don't call it: drive your `Update` logic
directly and only touch the GraphicsDevice for screenshots.

```csharp
static int Main(string[] args)
{
    if (!Witness.Active) { using (var g = new MyGame()) g.Run(); return 0; }
    using (var g = new MyGame())
    {
        g.InitHeadless();                       // load content, build world; no Run(), no window shown
        Witness.Pcm = new WitnessPcm(44100, 2);
        var h = new WitnessHandlers {
            Reset = (seed, scene, a) => g.ResetWorld(seed),
            Input = e => g.WitnessInput.Apply(e),
            Step = dt => g.Simulate(new GameTime(g.Elapsed, TimeSpan.FromSeconds(dt))),
            Snapshot = g.State,
            Screenshot = scale => g.Capture(),
        };
        if (!Witness.Start(new WitnessHello { Name = "MyGame", Engine = "MonoGame", Fps = 60, Width = 1280, Height = 720 }, h)) return 1;
        Witness.Run(h);
    }
    return 0;
}
```

* Split `Update(GameTime)` into input polling + `Simulate(GameTime)`; keep `IsFixedTimeStep` logic
  out of witness mode (one Simulate per Step). Build `GameTime` yourself from the accumulated dt.
* Input: MonoGame's `Keyboard.GetState()` can't be injected. Read input through your own
  `InputState` that, in witness mode, is filled by `WitnessKeys.TryParse(e.Key, out Keys k)`.
* Screenshot: render one frame into a `RenderTarget2D`, then
  `target.GetData(rgba)` (`Color[]` → bytes, already top-down), `WitnessImage.FromRgba(w, h, bytes)`.
  Creating a `GraphicsDevice` needs a window: call `InitHeadless` after `GraphicsDeviceManager`
  is applied, keep the window hidden (`Window.IsBorderless`, position it offscreen or use SDL's
  hidden flag), or skip screenshots in CI (leave `Screenshot` null).
* Audio: SoundEffect playback can't be captured; call `Witness.Pcm?.Play(samples)` with the
  effect's PCM (decode the WAV once at load) next to `effect.Play()`.

## 12. Verify

```
witness doctor        # connection, capabilities, 30-frame step, snapshot, determinism, screenshot, audio
witness eval --keys   # every snapshot path the game exposes
witness test          # your witness/*.witness.json
```

`doctor` must end with "all good". If determinism fails it lists the differing paths: look for
unsorted dictionaries, an unseeded RNG, or real time leaking into `Step`.
