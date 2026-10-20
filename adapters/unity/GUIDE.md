# Witness for Unity: integration guide (for Claude)

You are wiring Witness into a Unity project (2021.3 or newer) you may not know yet. The adapter is
a UPM package (`com.witnesskit.unity`): `Runtime/Witness.cs` (the shared C# adapter),
`WitnessBridge.cs` (drives the player), `WitnessInput.cs` (input) and `WitnessState.cs`
(snapshot attributes). It installs itself before the first scene loads when `WITNESS_ADDR` is set
(or the player got `--witness`) or `WITNESS_RECORD` is set; otherwise it creates nothing.

> **Verification status:** compiled against Unity 2021.3, 2022.3 and 6000.x reference assemblies
> (with and without the Input System 1.5 package), but **never run inside Unity** (no license on the
> authoring machine). Treat the first run in a real project as the test: run `witness doctor`,
> and if something misbehaves, read section 11 and fix the bridge. Untested: all runtime behavior.

## 1. Install

* Git URL (Package Manager > Add package from git URL):
  `https://github.com/<owner>/witness.git?path=adapters/unity`
* Local checkout, in `Packages/manifest.json`:
  `"com.witnesskit.unity": "file:/path/to/witness/adapters/unity"`
* Or embedded: `witness init` copies the package to `Packages/com.witnesskit.unity/`.

Game scripts in `Assembly-CSharp` see it automatically; your own asmdefs need a reference to
`WitnessKit.Runtime`.

## 2. Launch

Build a player and let Witness launch it:

```json
{ "name": "mygame",
  "build": "Unity -batchmode -quit -projectPath . -executeMethod MyBuild.Build -logFile -",
  "launch": { "command": "Build/MyGame.exe", "args": ["-batchmode", "-logFile", "-"] },
  "tests": "witness", "seed": 1, "timeout": 120 }
```

* `-batchmode` = no window, no dialogs (required for tests). Screenshots still work (cameras
  render offscreen on the GPU).
* Add `-nographics` when you don't need screenshots (CI without a GPU); the bridge then leaves
  `screenshot` out of its capabilities.
* `-logFile -` sends the player log to stdout, so Witness shows it when something fails.
* The scenes the game loads (and the one `reset` reloads) must be in the Build Settings list.

**Editor attach** (iterate without building): add the scripting define `WITNESS_ATTACH`, run any
command with `--attach` (`witness doctor --attach`, `witness test --attach`; or set
`"launch": {"attach": true}` in `witness.json`): it waits on 127.0.0.1:7357 instead of launching
the game. Then press Play. The Editor UI freezes between
commands while Witness drives it; that's expected. Remove the define when done.

## 3. How witness mode drives Unity (nothing to restructure)

The bridge inserts three PlayerLoop hooks and blocks the main thread at the end of each frame,
answering commands until the next `step`:

| when | what |
|---|---|
| EarlyUpdate (first) | this frame's input events are applied (see 4) |
| FixedUpdate | runs exactly once: `Time.captureDeltaTime = Time.fixedDeltaTime = dt` |
| PreUpdate (first) | `Physics.Simulate(dt)` and `Physics2D.Simulate(dt)` (simulation mode = Script), after FixedUpdate scripts, as Unity's own simulation would |
| Update / LateUpdate / render | normal, `Time.deltaTime == dt` |
| PostLateUpdate (last) | audio for the frame is captured; after N frames the step replies and the bridge blocks |

So game code keeps using `Time.deltaTime`, `FixedUpdate`, coroutines, Animators and physics.
Rules for game code:

* No `Time.realtimeSinceStartup`, `Time.unscaledTime`, `DateTime.Now` or `Stopwatch` in gameplay.
* `Time.timeScale` is the game's own (the bridge only sets 0 during reset frames, 1 after).
* Async loads (`LoadSceneAsync`, Addressables, `UnityWebRequest`) must complete before the state
  you test; step until they report done (`witness eval` on a "loaded" flag).

## 4. Input through the engine's normal path

* **New Input System** (the `com.unity.inputsystem` package with the new backend enabled): nothing to
  change. The bridge switches the Input System to `ProcessEventsManually`, adds virtual Keyboard /
  Mouse / Gamepad devices if none exist, queues each event as device state
  (`InputSystem.QueueStateEvent` / `QueueTextEvent`) and calls `InputSystem.Update()` at the start of
  the frame, so `InputAction`s, `PlayerInput`, UI and `Keyboard.current` all see it.
  (`InputTestFixture` is the Input System's own test harness for edit/play-mode tests; the bridge
  uses the same state-event mechanism in a real player.)
* **Old Input Manager:** `UnityEngine.Input` can't be fed from code. Replace `Input.` with
  `WitnessInput.` in gameplay scripts (`GetKey`, `GetKeyDown`, `GetAxisRaw("Horizontal")`,
  `GetButton("Jump")`, `mousePosition`, `mouseScrollDelta`, `inputString`). Outside witness mode
  every call forwards to `Input`, so the change is free. Axes have no smoothing in witness mode.
* `action` events are raised as `WitnessBridge.ActionEvent += (name, down) => ...` for games with
  their own mapping layer.

Keys map by name (`right` → `KeyCode.RightArrow` / `Key.RightArrow`, `1` → `Alpha1` / `Digit1`).
Mouse coordinates are converted from Witness's top-left logical pixels (the hello size) to Unity's
bottom-left screen pixels.

**Touch** (`touch:160,90@1`, `swipe:40,90->200,90@1-1.5`; same coordinates as the mouse, converted
the same way):

* New Input System: on the first touch event the bridge adds a virtual `Touchscreen` (none before,
  so games that show on-screen controls when `Touchscreen.current != null` behave as on desktop until
  a test touches) and queues a `TouchState` per finger change (`touchId` = Witness finger id + 1,
  `Began` / `Moved` / `Ended`, `Canceled` for a Witness `cancel`). `Touchscreen.current.touches`, touch `InputAction`s and EnhancedTouch
  all see it.
* Old Input Manager: `WitnessInput.touchCount`, `GetTouch(i)`, `touches`, `touchSupported`
  (`fingerId` = Witness finger id; phases `Began`, `Moved`, `Stationary`, `Ended` per frame, and
  `Canceled` for a Witness `cancel`, the system ending the touch).
* Mouse fallback: finger 0 also arrives as the mouse (button 0 down / move / up), like Unity's
  `Input.simulateMouseWithTouches`, so touch tests drive mouse-only games. A game that reads touches
  itself sets `WitnessBridge.Hello.Touch = true` (in a `[RuntimeInitializeOnLoadMethod]` or `Awake`):
  it then gets only touches, and the hello says `"touch": true`.

## 5. Reset and RNG seeding

Default reset: `UnityEngine.Random.InitState(seed)`, release held input, raise
`WitnessBridge.Seeded(seed)`, reload the active scene (or `scene` from the test), with
`Time.timeScale = 0` for the load frame so Awake/Start run without advancing the game; the reply comes
when `SceneManager.sceneLoaded` fired. Seed your own generators:

```csharp
void Awake() { rng = new System.Random(Witness.Seed); }   // or subscribe to WitnessBridge.Seeded
```

`DontDestroyOnLoad` managers and static fields survive the reload: reset them in a `Seeded`
handler, or set `WitnessBridge.Reset = (seed, scene, p) => GameManager.Restart(seed);` to replace
the scene reload with your own synchronous reset (the coins example does this).

## 6. Snapshot: expose state.entities

Pick any mix:

```csharp
[WitnessEntity("Enemy", Is2D = true)]            // every enabled instance → {id, type, pos, ...}
public class Enemy : MonoBehaviour
{
    [WitnessState] public int hp;                 // entity field
    [WitnessState("state")] AIState current;      // private works too; enums become names
}

public class GameManager : MonoBehaviour, IWitnessState
{
    [WitnessState] public int score;              // → state.GameManager.score
    public object WitnessState() => new Dictionary<string, object> { { "wave", wave } };   // merged into the root
}
```

or replace it all: `WitnessBridge.Snapshot = () => new Dictionary<string, object> {...};`.
Entities are listed in hierarchy order; `id` is a `[WitnessState] id` member if present, else the
hierarchy path with sibling indices (stable across runs; `GetInstanceID()` is not). Vectors become
`[x, y, z]`; `UnityEngine.Object` references become their names. Custom calls:
`WitnessBridge.RegisterCall("give", "item", "add an item", args => inventory.Add((string)args[0]));`
(register in `Awake`; the hello goes out at the end of the first frame).

## 7. Audio capture

With `WitnessBridge.CaptureAudio` (default true) the bridge starts `AudioRenderer` and, after every
stepped frame, renders `AudioRenderer.GetSampleCountForCaptureFrame()` samples of the final mix
(sample-exact with `Time.captureDeltaTime`) into the capture buffer at
`AudioSettings.outputSampleRate`. AudioSources play normally in game code. `OnAudioFilterRead` on the
AudioListener is the alternative for real-time attach, but it runs on the audio thread at wall-clock
speed, so it can't follow stepped time.

**Sound events (optional).** Next to `source.Play()`, announce the sound:
`WitnessBridge.Sound("jump")`, `WitnessBridge.Sound("jump", 0.8f)`, or with where it happened,
`WitnessBridge.Sound("hit", 0.8f, cam.WorldToScreenPoint(transform.position))` (Unity screen pixels,
converted to the protocol's top-left logical pixels). It is sent at once, stamped with the frame
being simulated, so `witness listen` can name what it hears and flag sounds announced but silent.
It does nothing outside witness mode.

## 8. Screenshots

`WitnessBridge.Screenshots = ScreenshotSource.Cameras` (default): every enabled camera renders, by
depth, into a RenderTexture of the hello size, read back with `ReadPixels`. Works in `-batchmode`;
Screen Space - Overlay canvases are not included (switch them to Screen Space - Camera in witness
runs if tests need UI in the picture). `ScreenshotSource.Screen` uses
`ScreenCapture.CaptureScreenshotAsTexture()` after the frame rendered, overlay UI included, but it
needs a real window (no `-batchmode`), so keep it for manual runs. Set the hello size to the
resolution you want: `WitnessBridge.Hello.Width = 1280; Hello.Height = 720;`.

## 9. Replay recording

Run the player normally with `WITNESS_RECORD=run.jsonl` (and optionally `WITNESS_SEED`): the bridge
writes one replay frame per **fixed step** (`Time.fixedDeltaTime`, the unit witness mode steps: one
FixedUpdate + one Update per frame), with the key presses/releases and touches (Input System keyboard
and `Touchscreen.current`, or the old Input Manager's keys and `Input.touches`) of each rendered frame;
F8 adds a mark. A frame's steps are written when it ends (so a crash loses at most that frame). On quit
it writes `run.jsonl.state.json` (the snapshot the game ended in), and `witness replay run.jsonl`
checks the replay ends in exactly that state. Seed with `Witness.Seed`.

A replay line is one FixedUpdate + one Update with its input applied before both, so the bridge puts
a frame's input where live play first saw it: the old Input Manager (updated in EarlyUpdate, before
FixedUpdate) on the frame's first fixed step, the Input System (default dynamic update, in PreUpdate:
after FixedUpdate, before Update) on its last. Exact replays need one fixed step per rendered frame
(`Application.targetFrameRate` = the fixed rate; pin it when you record replays you'll assert on):
then input read in Update, and input read in FixedUpdate with the old Input Manager, replay on the
same step as live. Remaining gaps: Input System input read in FixedUpdate replays one step early
(live, it reached FixedUpdate on the next frame); with several steps per frame, Update logic runs
once per step instead of once per frame; input of a frame with no fixed step rides on the next
frame's first step.

Touches are written in the hello's logical pixels (top-left origin) with small finger
ids (0 = first finger down); a touch Unity reports as `Canceled` is recorded as `cancel`, not `up`.
The mouse Unity simulates from touches is not recorded: on replay the
mouse fallback recreates it.

## 10. Determinism pitfalls (Unity)

* **Update order:** scripts' `Update` order is undefined unless set (Script Execution Order or
  `[DefaultExecutionOrder]`). It's stable between runs of one build, but changes when you add
  scripts; give order-sensitive systems an explicit order.
* **Physics:** one `Physics.Simulate(dt)` per frame, after FixedUpdate. Interpolation is visual
  only. `Physics.autoSyncTransforms` off means transforms moved in Update apply at the next
  simulate (same in normal play).
* `FindObjectsOfType` order is not guaranteed; sort by something stable before iterating.
* `UnityEngine.Random` is global: anything that consumes it in a different order (particle seeds,
  editor-only code) shifts gameplay rolls. Prefer per-system `System.Random(Witness.Seed + k)`.
* Coroutines with `WaitForSeconds` follow scaled time (stepped); `WaitForSecondsRealtime` does not.
* `Time.frameCount` keeps counting through resets; use `Witness.Frame` for "frames since reset".

## 11. If something misbehaves (untested areas, in likely order)

1. Nothing connects: check the player log (`-logFile -`) for `[witness]` errors; `Witness.Active`
   needs `WITNESS_ADDR` in the player's environment.
2. Two FixedUpdates per frame: float rounding of `captureDeltaTime`; set
   `Time.maximumDeltaTime` higher or move logic to the PreUpdate physics hook.
3. Reset times out: the active scene isn't in Build Settings; or set `WitnessBridge.Reset`.
4. Input System events ignored: the project's Active Input Handling must include the new backend
   (`ENABLE_INPUT_SYSTEM`), and `InputSystem.settings` must not be replaced by an asset later.
5. Black screenshots in URP/HDRP: switch to `ScreenshotSource.Screen` in a windowed run.
6. No audio: batchmode players on some platforms disable audio; check `AudioRenderer.Start()`.

## 12. Verify

```
witness doctor        # connection, step, snapshot, determinism, screenshot, audio
witness eval --keys
witness test
```
