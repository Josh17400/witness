# Witness for Java / Kotlin: integration guide (for Claude)

You are wiring Witness into a JVM game you may not know yet. The adapter is one file,
`Witness.java` (package `witness`, Java 8+, no dependencies): plain Java2D/Swing games, LibGDX,
LWJGL, jMonkeyEngine and Kotlin projects all use it directly (Kotlin calls it like any Java class).

Witness launches the game with `WITNESS_ADDR=127.0.0.1:<port>`. The game connects, says hello and
from then on **only advances when told to**, at a fixed dt. Your job: give the adapter a reset, a
one-frame step, input, a snapshot and (if cheap) a screenshot and audio.

Reference: `examples/java/` (`CoinsGame.java` is a pure simulation, `Main.java` wires it and has a
real-time Swing mode with replay recording). Work in this order and run `witness doctor` after
each step: **connect → step + snapshot → input → reset/seed → screenshot → audio → recording.**

## 1. Install

1. Copy `Witness.java` to `src/main/java/witness/Witness.java` (`witness init` does this). Keep
   the package `witness`, or change the first line to your own package.
2. `witness.json`:
   ```json
   { "name": "mygame",
     "build": "./gradlew classes",
     "launch": { "command": "java", "args": ["-Djava.awt.headless=true", "-cp", "build/classes/java/main", "com.me.Main"] },
     "tests": "witness", "seed": 1 }
   ```
   For a fat jar: `"args": ["-Djava.awt.headless=true", "-jar", "build/libs/game-all.jar"]`. Keep
   `-Djava.awt.headless=true`: witness runs must never open a window or dialog. Add `"cwd"` if
   assets load relative to the working directory (LibGDX desktop projects often use `assets/`).

## 2. Where to hook in

Decide the mode at the top of `main`, before any window, audio device or save file exists:

```java
public static void main(String[] args) {
    Game game = new Game();                                    // no window/device in the constructor
    Witness.Hello hello = new Witness.Hello("My Game").engine("LibGDX").fps(60).size(1280, 720)
        .call("teleport", "x y", "move the player");
    Witness.Handlers h = new Witness.Handlers()
        .reset((seed, scene, params) -> game.reset(seed))
        .input(game.input::apply)                              // Witness.Event, at the start of its frame
        .step(game::update)                                    // exactly one frame of dt seconds
        .snapshot(game::witnessState)
        .call((name, a) -> game.debug(name, a));
    if (Witness.active(args)) {
        Witness.pcm(new Witness.Pcm(44100, 2));                // before start, so hello advertises "audio"
        if (!Witness.start(hello, h)) System.exit(1);
        Witness.run(h);                                        // until the CLI quits
        System.exit(0);
    }
    Witness.start(hello, null);                                // normal play: records if WITNESS_RECORD is set
    game.runRealTime();
}
```

Kotlin: `Witness.Handlers().step { dt -> game.update(dt) }.snapshot { game.state() }`.

`Witness.active()` is true when `WITNESS_ADDR` is set, `-Dwitness` is given, or `--witness` is on
the command line (`active(args)` also scans `main`'s args). Capabilities are derived from the
handlers you set. Lower-level API for engines that own the loop: `connect`, `tryNext()` /
`next(ms)`, `handle(cmd, h)`, `cmd.reply(map)` / `cmd.fail(msg)`, `beginFrame()`, `endFrame(dt)`,
`stepDts(cmd)`, `frame()`, `time()`.

## 3. Restructure the loop for witness mode

`step(dt)` is **one complete frame**: the adapter has already called `input` for that frame's
events; you update the world with exactly `dt`. No `System.nanoTime()`/`currentTimeMillis()` in
gameplay; anything that measures time takes `dt`. Fixed-timestep accumulators: one fixed update
per step. Render only inside the screenshot handler. Saves/settings go to a temp dir in witness
mode. Exceptions inside handlers become failed replies (tests fail, the game keeps serving); a
crash elsewhere should print and `System.exit(1)`.

## 4. Input through the game's normal path

`Witness.Event` has `type` (key / mouse / wheel / text / action / pad / axis / touch), `key`, `down`
(Boolean, null for moves), `x`, `y`, `button`, `dy`, `text`, `action`, `padButton`, `axis`, `value`,
and for touch `id`, `phase`, `pressure`. Feed it to the same input state the device code writes:

```java
void apply(Witness.Event e) {
    if ("key".equals(e.type)) { int code = Witness.Keys.lookup(e.key, Input.Keys::valueOf); if (code >= 0) processor.keyEvent(code, e.isDown()); }
    else if ("mouse".equals(e.type)) { mouseX = (int) e.x; mouseY = (int) e.y; if (e.down != null) processor.button(e.button, e.isDown()); }
    else if ("touch".equals(e.type)) processor.finger(e.id, (float) e.x, (float) e.y, e.phase);   // "down" | "move" | "up"
}
```

**Touch.** A `touch` event has `id` (finger, 0 = first finger down), `x`/`y` in the same logical pixels
as the mouse, `phase` (`"down"` / `"move"` / `"up"`; `down` is also true / null / false) and `pressure`
(1 when not given). By default finger 0 is also delivered as a mouse event right after each touch
event (down → button 0 down, move → move, up → button 0 up) with `fromTouch = true`, so touch tests
(`touch:160,90@1`, `swipe:40,90->200,90@1-1.5`) drive mouse-only games. A game with its own touch
handling sets `new Witness.Hello(...).touch(true)`: it then receives only the touch events (and the
hello says `"touch": true`). LibGDX games want this: LibGDX reports the mouse as pointer 0 too, so
route `touch` to `touchDown/touchDragged/touchUp(x, y, e.id, Buttons.LEFT)` and keep `mouse` for the
desktop path.

`Witness.Keys.lookup(name, byName)` tries the engine's own name lookup with likely spellings
(`right` → `Right`/`RIGHT`, `shift` → `L-Shift`/`LSHIFT`, `1` → `1`/`NUM_1`); `-1` when unknown.
`Witness.Keys.normalize(engineName)` goes the other way, for recording. AWT: map `KeyEvent.VK_*`
codes explicitly (see `examples/java/src/coins/Main.java`); `KeyEvent.getKeyText` is localized.

## 5. Reset and RNG seeding

`reset(seed, scene, params)` rebuilds the initial state completely (entities, timers, camera,
held input) and reseeds every generator:

```java
rng = new java.util.Random(seed);   // java.util.Random's algorithm is specified: identical on every JVM
```

`java.util.Random` is fine (its LCG is part of the spec). Avoid `Math.random()`,
`ThreadLocalRandom` and `SecureRandom` in gameplay; LibGDX's `MathUtils.random` uses a static
`RandomXS128`: reseed it with `MathUtils.random.setSeed(seed)`. `Witness.seed()` gives the seed for
normal play too (the reset seed, `WITNESS_SEED`, or a per-run seed written to the replay header).

## 6. Snapshot: expose state.entities

Return `Map`/`List`/arrays/primitives (use `LinkedHashMap` for a stable key order):

```java
Map<String, Object> s = new LinkedHashMap<>();
s.put("score", score);
s.put("player", entity(player));
List<Object> ents = new ArrayList<>();
for (Ent e : world.sortedById()) ents.add(entity(e));     // stable order, stable ids
s.put("entities", ents);
// entity(e) = {"id": e.id, "type": "Enemy", "pos": new float[]{e.x, e.y}, "hp": e.hp}
```

The JSON writer turns LibGDX `Vector2`/`Vector3`, JOML and jME vectors into `[x, y(, z)]`, enums
into names, other objects into their public fields; NaN becomes `"NaN"`. Whole doubles print without
`.0`.

## 7. Screenshots

Return `Witness.Image.rgba(w, h, bytes, bottomUp)`, `.argb(w, h, int[])` (e.g. from
`BufferedImage.getRGB`), `.png(bytes, w, h)` or `.file(path, w, h)`. Java2D: render into a
`BufferedImage` (no window needed; works with `java.awt.headless=true`).

## 8. Audio capture

`Witness.pcm(new Witness.Pcm(rate, channels))` in witness mode, then `Witness.pcm().play(samples)`
when a sound starts (mixed at the current simulated time) or `write(block, 0, n)` from your mixer.
The buffer stays exactly `round(time × rate)` frames long. Don't open a real audio line in witness
mode.

## 9. Replay recording

Normal play with `WITNESS_RECORD=run.jsonl`: `Witness.start(hello, null)` opens it; once per frame
call `Witness.recordFrame(dt, eventsThisFrame)` with `Witness.Event.key(name, down)`,
`Witness.Event.mouse(x, y, button, down)` (down null = a move), `Witness.Event.touch(id, x, y, phase)`;
`Witness.mark("F8")` on F8; `Witness.stopRecording()` on exit (a shutdown hook also flushes).
Seed with `Witness.seed()`. `witness replay run.jsonl` plays it back.

Touch recording: record real fingers in logical pixels with small ids (0 = first finger down) and
never the mouse events a platform synthesizes from them (JavaFX: skip `MouseEvent.isSynthesized()`;
events you flag `fromTouch = true` are skipped for you). On replay the mouse fallback recreates them,
so recording both would deliver them twice. LibGDX on Android/iOS: record `touchDown/Dragged/Up`
(`pointer` is the id) as touch, and on desktop record the same callbacks as mouse. AWT/Swing has no
touch events (Windows turns touch into plain mouse events), so there it's mouse only.

## 10. Determinism pitfalls (JVM)

* `HashMap`/`HashSet` iteration order depends on hash codes; `Object.hashCode()` (identity) differs
  every run. Sort, or use `LinkedHashMap`/`TreeMap`, for anything gameplay or snapshots iterate.
* Background threads (asset loaders, `Timer`, executors) must finish before `step` returns.
* `strictfp` is the default since Java 17; on older JVMs `float` math is still deterministic on
  one machine. Don't use `System.identityHashCode` for ids.

## 11. LibGDX

(Written against the documented LibGDX 1.12 API; not executed in this repo's CI. The plain-Java
example is what's verified.)

`Lwjgl3Application` / `HeadlessApplication` own a real-time loop that calls `render()` with wall-
clock deltas. In witness mode, don't let them drive the game: run the application, and from the
first `render()` hand the thread to Witness (it blocks between commands, so the loop never free-runs).

```java
public class WitnessLauncher {
    public static void main(String[] args) {
        if (!Witness.active(args)) { DesktopLauncher.main(args); return; }
        HeadlessApplicationConfiguration cfg = new HeadlessApplicationConfiguration();   // pacing is irrelevant: render() never returns
        new HeadlessApplication(new ApplicationAdapter() {
            MyGame game;
            @Override public void create() {
                game = new MyGame();
                game.createWorld();                      // no SpriteBatch/textures under the headless backend
            }
            @Override public void render() {             // first call: Witness owns the thread until quit
                Witness.Handlers h = new Witness.Handlers()
                    .reset((seed, scene, p) -> { MathUtils.random.setSeed(seed); game.reset(seed); })
                    .input(e -> game.witnessInput(e))
                    .step(dt -> game.update((float) dt)) // game logic takes dt; never Gdx.graphics.getDeltaTime()
                    .snapshot(game::state);
                if (Witness.start(new Witness.Hello("MyGame").engine("LibGDX").fps(60).size(1280, 720), h)) Witness.run(h);
                Gdx.app.exit();
            }
        }, cfg);
    }
}
```

* **Manual stepping:** move logic out of `render()` into `update(float dt)`; `render()` only draws.
  Replace every `Gdx.graphics.getDeltaTime()` in gameplay with the dt parameter.
* **Input:** route device input through an `InputProcessor` that writes your own `InputState`
  (`keyDown/keyUp/touchDown/...`). In witness mode call the same processor:
  ```java
  void witnessInput(Witness.Event e) {
      InputProcessor p = inputMultiplexer;   // whatever Gdx.input.setInputProcessor got
      switch (e.type) {
          case "key": { int k = Witness.Keys.lookup(e.key, Input.Keys::valueOf); if (k >= 0) { if (e.isDown()) p.keyDown(k); else p.keyUp(k); } break; }
          case "mouse": if (e.down == null) p.mouseMoved((int) e.x, (int) e.y);
                        else if (e.isDown()) p.touchDown((int) e.x, (int) e.y, 0, e.button); else p.touchUp((int) e.x, (int) e.y, 0, e.button); break;
          case "wheel": p.scrolled(0, (float) (e.dy / 100)); break;
          case "text": for (char c : e.text.toCharArray()) p.keyTyped(c); break;
          case "touch":   // with Hello.touch(true): fingers are pointers, as on a phone
              if ("down".equals(e.phase)) p.touchDown((int) e.x, (int) e.y, e.id, Input.Buttons.LEFT);
              else if ("up".equals(e.phase)) p.touchUp((int) e.x, (int) e.y, e.id, Input.Buttons.LEFT);
              else p.touchDragged((int) e.x, (int) e.y, e.id);
              break;
      }
  }
  ```
  Code that polls `Gdx.input.isKeyPressed(...)` won't see injected keys: change it to read your
  `InputState`, which both the processor and Witness update.
* **Screenshots** need a GL context, which the headless backend lacks. Use `Lwjgl3Application`
  with `config.setInitialVisible(false)` (a hidden window) when you need them: render one frame,
  then `byte[] px = ScreenUtils.getFrameBufferPixels(0, 0, w, h, true)` (true = flip to top-down)
  and return `Witness.Image.rgba(w, h, px, false)`. Under the headless backend leave `screenshot`
  unset; doctor then reports it as not supported instead of failing.
* **Seeding:** `MathUtils.random.setSeed(seed)` plus every `new Random(...)`/`RandomXS128` you own.
* **Audio:** LibGDX `Sound` output can't be captured; call `Witness.pcm().play(samples)` with the
  decoded PCM next to `sound.play()` (decode the WAV once at load), when `Witness.pcm() != null`.

## 12. Verify

```
witness doctor        # connection, capabilities, step, snapshot, determinism, screenshot, audio
witness eval --keys   # every snapshot path the game exposes
witness test          # your witness/*.witness.json
```
