# Witness for JavaScript / TypeScript: integration guide (for Claude)

You are wiring Witness into a JS/TS game you may not know yet: a browser game (plain canvas,
Phaser, three.js, PixiJS, Babylon.js, ...), a Node game, or an Electron/Tauri app. The adapter is
one ES module, `witness.js` (plus `witness.d.ts`), with no dependencies. Witness either launches
the game with `WITNESS_ADDR=127.0.0.1:<port>` (Node, Electron), or opens the page in headless
Chromium with `?witness=127.0.0.1:<port>` (browser). The adapter connects, says hello, and from
then on **the game only advances when Witness says `step`**.

In the browser most of the work is automatic. When the module is imported in witness mode, it
takes over `requestAnimationFrame`, `setTimeout`/`setInterval`, `performance.now()` and `Date`,
seeds `Math.random`, makes WebGL keep its drawing buffer, captures WebAudio offline, and injects
input as real DOM events. **The game's own loop, input handlers and sound code stay as they
are.** You add one import and one `witness.start({...})` call.

Working references (read the one that matches, they're short):
* `examples/js-browser/game.js`: an ordinary rAF canvas game with keyboard and WebAudio. The only
  Witness code is the import and `start()`.
* `examples/js-node/game.mjs`: a headless Node game using explicit `input`/`step` handlers,
  `createMixer()` audio, and `recordFrame()` for replays.

Work in this order and check each step with `witness doctor`:
**import → start (hello) → snapshot → reset/seed → input → screenshot → audio → recording.**

---

## 1. Install and where to hook in

1. Copy `witness.js` and `witness.d.ts` into the project (`witness init` puts them in
   `witness/`). With a bundler (Vite, webpack, esbuild) import it like any module. Its Node-only
   imports are dynamic and marked `/* @vite-ignore */ /* webpackIgnore: true */`, so browser builds
   don't pull them in.
2. **Import it before the engine starts its loop**, ideally as the first import of the entry
   module:
   ```js
   import witness from "./witness/witness.js";   // first: installs the takeover in witness mode
   import Phaser from "phaser";
   ```
   For classic `<script>` games, add `<script type="module" src="witness/witness.js"></script>`
   and call `start()` from game code once `witness` is available (e.g. `import()` it from a
   module, or put the game's boot code in a module). A loop that started before the import is
   picked up at its next `requestAnimationFrame` call, so nothing breaks. The first frame just
   runs on real time.
3. **Call `witness.start({...})` exactly once, after assets are loaded and the game can run.**
   In witness mode that is the hello. Until then frames run on the display clock (so engines can
   boot and preload); afterwards they run only on `step`. Typical places: the end of `main()`
   after `await loadAssets()`, Phaser's first scene `create()`, after `await app.init()` (Pixi), or
   in `loader.onLoad` (three.js).
4. Outside witness and record mode, importing patches nothing and `start()` returns at once, so
   the call can stay in production builds (zero cost). `witness.active()` tells you which mode
   you're in.

```js
await witness.start({
  name: "My Game", fps: 60, size: [1280, 720],      // size = logical pixels for mouse events
  canvas,                                           // optional: default is the largest <canvas>
  reset({ seed, scene, params }) { restartLevel(scene ?? "level1"); },
  snapshot: () => ({ scene: current.name, score, player: describe(player), entities: world.map(describe) }),
  calls: { teleport: { args: "x y", help: "move the player", run: (x, y) => { player.x = +x; player.y = +y; return [player.x, player.y]; } } },
  scope: () => ({ game, player, world }),           // what `eval` expressions can see
});
```

Every option is optional, but without `snapshot` the CLI has nothing to test, and without
`reset` it can't rerun deterministically. The full type is `StartOptions` in `witness.d.ts`.

## 2. The rAF takeover (browser), and how determinism works

In witness mode:

* `requestAnimationFrame(cb)` queues `cb`. Each `step` frame runs every queued callback once
  with the frame's timestamp, just as a browser frame would. Callbacks queued during a frame run
  next frame. `cancelAnimationFrame` works, even within a frame.
* `performance.now()` returns a **virtual clock** that advances by exactly `dt` per frame and
  stays frozen within a frame. `Date.now()` / `new Date()` follow the same clock, starting at a
  fixed epoch (2026-01-01T00:00:00Z, override with `WITNESS_CONFIG.epoch`), so even games that seed
  from `Date.now()` become reproducible.
* `setTimeout`/`setInterval`/`requestIdleCallback` are virtual timers. A timer due inside a frame
  fires during that frame, before the rAF callbacks, with the clock set to its own due time.
  Intervals keep their phase. The HTML 4 ms nesting clamp is applied, so `setTimeout(f, 0)`
  chains can't spin forever.
* The clock counts 1/1024 ms ticks, and a frame's dt is rounded **down** to a tick (1/60 s =
  16.666015625 ms). Every difference of two clock readings is therefore exact, so
  `now - last` gives bit-identical dts no matter how long the page has been open. Rounding
  down also keeps dt under the `1000/fps` cap that engines like Phaser clamp to. The rounding
  error is at most 0.001 ms per frame.
* Exceptions in rAF or timer callbacks are caught, logged as `error` (tests fail), and the next
  frame still runs. Note that a loop that throws before calling `requestAnimationFrame` again
  stops, as it would in a real browser.

Opt out per page with `WITNESS_CONFIG = {takeover: false}` (or `{timers: false}` / `{raf: false}`),
set before the import, or with `?witness_timers=0` in the URL. Without the takeover, pass a
`step(dt)` handler and drive the game yourself.

**Node:** nothing is taken over by default. Prefer explicit handlers (`input`, `step`). For an
unmodified `setInterval` loop, call `witness.takeover()` before the loop starts (or set
`WITNESS_CONFIG = {takeover: true}` before the import): timers and clocks then become virtual
exactly as in the browser.

## 3. Input injection

Protocol events are applied **at the start of their frame**, before timers and rAF callbacks, as
real DOM events through the game's normal input path:

| event | what the page receives |
|---|---|
| `key` | `keydown` (+ `keypress` for printable keys) / `keyup` with correct `key`, `code`, `location`, legacy `keyCode`/`which` (Phaser reads `keyCode`) and modifier flags. Target: `keyTarget` option, else a canvas with `tabindex`, else the focused element, else `body`. It bubbles to `document` and `window`. |
| `mouse` | `pointermove`/`pointerdown`/`pointerup` + the compat `mousemove`/`mousedown`/`mouseup` (skipped after a cancelled `pointerdown`, per spec), then `click` / `auxclick` / `contextmenu`, with `buttons`, `movementX/Y`. Coordinates are mapped from logical game pixels (`size`) to client pixels through the canvas's `getBoundingClientRect()`, so CSS scaling works. The target is the element under the point (DOM UI buttons get clicked too), or the pressed element while a button is held. |
| `wheel` | `WheelEvent` (`deltaY` in pixels) at the last mouse position. |
| `touch` | `pointerdown`/`pointermove`/`pointerup` with `pointerType: "touch"` (`pointerId` 100 + finger id, `isPrimary` for finger 0, `pressure`, plus `pointerover`/`enter` before the down and `pointerout`/`leave` after the up), then real `TouchEvent`s `touchstart`/`touchmove`/`touchend` with `touches`/`targetTouches`/`changedTouches` across all fingers (`identifier` = finger id) where the browser has the `Touch` constructor (Chromium/Edge do). Every event of a finger goes to the element it went down on. Same coordinate mapping as the mouse. Finger 0 is then also the mouse (below). |
| `text` | per character: `keydown`, `keypress`, `keyup`. Focused `<input>`/`<textarea>` elements also get the text and an `input` event. |
| `pad`, `axis` | a virtual standard-mapping gamepad: `navigator.getGamepads()[0]` reflects them (buttons `a b x y lb rb lt rt back start ls rs up down left right home`, axes `leftx lefty rightx righty`, triggers `lefttrigger`/`righttrigger`) and `gamepadconnected` fires once. |
| `action` | your `action(name, down)` handler. Without one, it is pressed as a key of that name. |

Before `reset` runs, every held key, button and finger is released (with real `keyup`/`pointerup`/`touchend`), so
input never leaks from one run into the next.

* **Touch mouse fallback.** Right after each touch event of finger 0 the adapter delivers a mouse
  event `{type: "mouse", x, y, fromTouch: true}` (down → button 0 down, move → move, up or cancel →
  button 0 up), so touch tests (`touch:160,90@1`, `swipe:40,90->200,90@1-1.5`) drive mouse-only games. In
  browsers it arrives as compatibility `mousemove`/`mousedown`/`mouseup` + `click` only (no second
  set of pointer events, like a phone), immediately per phase. It is skipped when the page calls
  `preventDefault()` on the touch's `pointerdown` or `touchstart` (for the whole touch) or on a
  `touchmove` (for that move), exactly as browsers drop compat mouse events. Games with their own
  touch handling pass `touch: true` to `start()` (sent as `"touch": true` in the hello): they then
  get only the touch events. Other fingers never make mouse events.
* To handle an event yourself, pass `input(ev)`: return `true` to skip the DOM injection
  (Node games always handle input this way; a touch is `{type: "touch", id, x, y, phase, pressure}`
  with `phase` `"down"` / `"move"` / `"up"` / `"cancel"`, followed for finger 0 by its `fromTouch` mouse event unless `touch: true`). `witness.input` holds
  the current keys/mouse/touches (finger id → `{x, y, pressure}` while down)/pad/actions, and
  `witness.inputEvents()` lists this frame's events (fallback mouse events included), for games
  that poll.
* Pointer lock (`requestPointerLock`) does nothing in headless Chromium. FPS games should read
  `movementX/Y`, which the injected events carry.

## 4. RNG seeding

In witness mode `Math.random` is replaced by a seeded PRNG (mulberry32), reseeded with the
`reset` seed **before** your `reset` handler runs. Code that uses `Math.random` needs no change.

* If the game has its own PRNG (`seedrandom`, `Phaser.Math.RND`, a custom LCG), seed it in
  `reset` from `seed` (Phaser: `game.config.seed` or `Phaser.Math.RND.sow([String(seed)])`).
* `witness.seed()` is the current seed (a random one in normal play, the recorded one in record
  mode). `witness.random()` draws from the same seeded stream.
* `crypto.getRandomValues` / `crypto.randomUUID` are not seeded. Keep them out of gameplay.

## 5. Exposing state (snapshot)

`snapshot()` returns plain data: the adapter makes it JSON-safe (NaN becomes `"NaN"`, cycles,
functions and DOM nodes are dropped or named, Maps and Sets become objects and arrays). Follow the
conventions so the CLI helpers work: `count('Enemy')`, `first('Coin')`, `near(pos, 'Enemy')`:

```js
snapshot: () => ({
  scene: scene.key, score, lives,
  player: { id: 1, type: "Player", pos: [player.x, player.y], hp: player.hp },
  entities: world.children.map((o) => ({ id: o.id, type: o.kind, pos: [o.x, o.y] })),
}),
```

* Return copies of values, or references to plain objects. Never return engine objects (Phaser
  sprites, three.js meshes): they are huge and circular.
* Don't put wall-clock values in the snapshot (raw `performance.now()`, frame timings, FPS). They
  differ between runs and fail the determinism check. Give elapsed game time instead.
* `scope` (an object, or a function returning one) is what `witness raw '{"cmd":"eval",...}'`
  expressions can see. In ES modules, top-level variables aren't global, so list what matters.
  `state` (the snapshot) and `witness` are always in scope.

## 6. Reset

`reset({seed, scene, params})` must put the game in the same state every time, the way the
game's own "restart level" does. Put a new game's init code in a function and call it from
both places. Things that commonly leak across a reset:
* timers and intervals the game started (clear them, or keep their ids and clear them in reset),
* engine-side timers/tweens (Phaser `this.time.removeAllEvents()` / `this.tweens.killAll()`,
  GSAP `gsap.globalTimeline.clear()`),
* object pools, caches of "next id" counters, particles,
* the camera.

The virtual clock is **not** rewound on reset (games compute `dt = now - last`, so going backwards
would break them). Keep absolute times out of the state.

## 7. Audio

**WebAudio (automatic, browser):** in witness mode `new AudioContext()` returns an
`OfflineAudioContext` (mono, 24 kHz unless the game asks for a rate, 300 s per context) that is
rendered in step with simulated time. An AudioWorklet tap behind `ctx.destination` collects the
samples. `ctx.currentTime` advances with the steps (it reads half a sample after the rendered frame, so a sound
started "now" lands on the same sample whatever ran before the reset), so sounds scheduled with
`ctx.currentTime` land at the right simulated moment. The autoplay policy is emulated (see
"Audio unlock" below): by default contexts are `"running"` from the start; while a context is not running
(`suspend()`, the iPhone policy, `close()`) it is **frozen** as in browsers: it doesn't render, `currentTime` stays
put, sounds scheduled meanwhile wait, and the capture is silent; after `resume()` it carries on from where it
stopped (music queued while locked plays from its start after the tap). This works
for Phaser's WebAudio sound manager, Howler.js (WebAudio mode), three.js `AudioListener`, Tone.js
and hand-written graphs. Limits:
* `<audio>`/`HTMLAudioElement` playback and `createMediaElementSource` are **not** captured (a
  silent node is returned and a warning logged). Prefer decoded `AudioBuffer`s, or Howler with
  `html5: false`.
* Capacity: `WITNESS_CONFIG.audioSeconds` (default 300) of simulated time per context.
  `WITNESS_CONFIG.webaudio = false` keeps the real AudioContext (and turns capture off).

**Audio unlock (iPhone "no sound until a tap").** Browsers start an `AudioContext` suspended until the player
touches the page, and iPhone Safari only accepts `resume()` while a touchend / click / keydown handler is running.
Witness emulates that policy the same way in every engine:
* default (`auto`): Witness counts as the player's first gesture; contexts run from the start.
* `--no-auto-unlock` (or witness.json `launch.audioUnlock: false`): like iPhone Safari. A context created outside a
  gesture starts `"suspended"`, frozen at `currentTime` 0 and **silent**; `resume()` works only while Witness delivers input that
  is a gesture (a key down other than Escape, a mouse button, a finger lifting: `touch:x,y@t` lifts one frame after it
  lands; text) or a real browser tap (`dom:tap:x,y@t`); called from the game loop or a timer it stays pending
  (counted as `blocked`). An unlock lasts for the page's life, as in a browser.
* `witness doctor --no-auto-unlock` taps the centre of the canvas, clicks it, presses space and enter, and says which
  one resumed audio, or warns that it stayed suspended. Tests read `web.audio.state` (`"running"`, `"suspended"`,
  `"none"`), `web.audio.blocked` and `web.audio.contexts` (each with `unlockedBy`):
  ```json
  { "name": "tap to start", "input": "touch:80,45@0.5",
    "steps": [ { "at": 0.3, "expect": ["!state.started", "web.audio.state == 'suspended'"] },
               { "at": 0.6, "expect": ["state.started", "web.audio.state == 'running'"] } ] }
  ```
  Run audio-unlock tests one per process (`witness test --name ...`): a later test starts already unlocked.
* Fix for games that fail it: call `ctx.resume()` (or create the context) inside the touchend/click/keydown
  handler itself, not in the update loop.

**Mixer (games that synthesize PCM, and Node):**
```js
const mixer = witness.createMixer({ sampleRate: 22050 });   // a no-op outside witness mode
mixer.play(samples);                      // Float32Array mixed in at the current simulated time
mixer.play(samples, { delay: 0.25, volume: 0.5 });
```
The `audio` command returns everything mixed (taps and mixers summed) since the last call or
reset, exactly `dt × sampleRate` frames per step. For full control, pass `audio()` returning
`{sampleRate, channels, format, data}`.

**Name your sounds:** call `witness.sound("jump")` (optionally `{ volume, pos: [x, y] }`) wherever the game starts a
sound. In witness mode it sends a `{"event": "sound"}` line (docs/PROTOCOL.md §3), so `witness listen` says "jump"
instead of "sound 2" and checks that each input/event got its sound; elsewhere it does nothing. A helper like
`const sfx = (name) => { mixer.play(SFX[name]); witness.sound(name); }` does both at once (see examples/arena).
Note: the Mixer starts a sound at the end of the frame being simulated, so listen hears it one frame after the
frame the game announced (`+2f` after the press that caused it, where `+1f` is the earliest possible).

## 8. Screenshots

The default captures the canvas (or the canvases you pass, composited in order, e.g. a WebGL
scene with a 2D UI canvas on top) at its backing resolution × `scale`, as exact RGBA.
* **WebGL:** in witness mode every `getContext("webgl"|"webgl2")` is created with
  `preserveDrawingBuffer: true`, so three.js, Pixi, Phaser and Babylon canvases read back
  correctly at any time. If your code creates the context before the import (rare), pass
  `preserveDrawingBuffer: true` yourself.
* DOM/CSS UI (HTML health bars, menus) is not on the canvas, so it isn't captured. Draw it in
  `screenshot()` yourself if it matters, or test it through state.
* `screenshotFormat: "png"` sends a PNG (smaller, for 4K canvases). `screenshot()` may return a
  canvas or `{width, height, data: Uint8Array RGBA}` (Node games render their own; see the Node
  example).

## 9. Recording replays in normal play

* **Browser:** open the game with `?witness_record=<endpoint>` (e.g.
  `?witness_record=/__witness/record`). Every frame is POSTed in chunks (each second, on
  `visibilitychange`, and via `sendBeacon` on `pagehide`) to
  `<endpoint>?session=<id>` as NDJSON lines; the dev server appends them to a file
  (`examples/js-browser/serve.mjs` has the 6-line handler, and a Vite plugin or Express route is
  the same idea). With `?witness_record=1` nothing is posted: **F9** (or
  `witness.saveRecording()`) downloads `replay-<time>.jsonl`. **F8** marks a moment.
  `?witness_seed=7` pins the seed.
* How it works: in record mode the same virtual clock runs, driven by the real display. Real
  key, pointer and wheel events are recorded (capture phase, before the game sees them), and
  `start()` performs `reset(seed)`, so frame 0 of the file matches `witness replay`'s reset. A
  replay re-feeds the exact recorded dts and events, and lands on the same state.
* **Touch (phones/tablets):** touch pointers (`pointerType: "touch"`, `pointercancel` counts as up)
  are recorded as `touch` events in game pixels with small finger ids (0 = first finger down, reused
  after it lifts), one position per finger per frame. The compatibility mouse events the browser
  fires after a touch are never recorded: the replay's mouse fallback recreates them, so recording
  both would deliver them twice. Touch games should give the canvas `touch-action: none` (CSS):
  otherwise the browser takes drags over for scrolling and cancels the touch (recorded as an up
  where the finger last was).
* **Node / custom loops:** set `WITNESS_RECORD=replays/run.jsonl` (and optionally
  `WITNESS_SEED`). `start()` calls `reset(seed)`, then each frame call
  `dt = witness.recordFrame(dt, events)` and **simulate with the returned dt** (quantized so the
  replay feeds back exactly the same value). Call `witness.mark("F8")` for markers. With
  `takeover()` on, frames are recorded automatically: don't call `recordFrame` then. Input goes
  in with `witness.recordInput(ev)`, fingers with `witness.recordTouch(id, x, y, "down" | "move" |
  "up" | "cancel")` (game pixels); mouse events flagged `fromTouch` are dropped. In browsers a touch
  `pointercancel` is recorded as `"cancel"`.
* **Cancel.** `phase: "cancel"` is a touch the system ended (the browser took the gesture over,
  focus was lost): it ends the finger like `"up"` but isn't a completed tap; games that don't care
  can treat it as `"up"`. In browsers it is injected as `pointercancel` (+ `pointerout`/`pointerleave`)
  and `touchcancel`.
* Play it back with `witness replay <file> --watch "state.score"`.

## 10. witness.json

```jsonc
// browser game with a dev server (Vite shown; any static server works)
{ "launch": { "url": "http://localhost:5173/", "server": "npm run dev", "size": [1280, 720] } }
// static files, no dev server needed by the game: a 30-line Node server like examples/js-browser/serve.mjs
{ "launch": { "url": "http://127.0.0.1:5317/", "server": "node serve.mjs" } }
// Node game
{ "launch": { "command": "node", "args": ["src/main.js"] } }
```

`server` may also be `{"command", "cwd", "wait": "<url to poll>", "timeout": 60}`. The browser
needs Playwright in the project (`npm i -D playwright && npx playwright install chromium`; or point
`WITNESS_PLAYWRIGHT` at a folder that has it), and always runs headless. If the dev server prints a different port
than the one you configured, fix `url`.

### Phones and tablets: device profiles, engines, device pixels

```jsonc
{ "launch": { "url": "...", "server": "...",
    "device": "iphone-15",        // or iphone-15-safari, iphone-15-pro-max, iphone-se, ipad (+ "-landscape"),
                                  // or {"width": 393, "height": 852, "dpr": 3, "touch": true, "mobile": true,
                                  //     "userAgent": "...", "standalone": true}
    "engine": "webkit",           // chromium (default) | webkit (iPhone/iPad Safari's engine) | firefox
    "audioUnlock": false,         // emulate iPhone Safari's audio unlock (see Audio unlock)
    "capture": "element" } }      // screenshots: canvas (default) | element | screen, see below
```
Every command takes the same as flags: `--device iphone-15`, `--engine webkit`, `--no-auto-unlock`, `--capture
element`. A profile sets the CSS viewport, `devicePixelRatio`, touch, the mobile viewport (meta viewport honoured),
the user agent, `navigator.platform` and `maxTouchPoints` to match it (`"iPhone"` / `"MacIntel"`, 5: the usual iPad
check `platform === "MacIntel" && maxTouchPoints > 1` passes), `screen` at the device's portrait size in both
orientations (as iOS), and for Home Screen web apps `navigator.standalone` and `display-mode: standalone`. The
iPhone profiles are full screen (a web app added to the Home Screen); `iphone-15-safari` is a Safari tab (393×659,
landscape 734×343). `ipad` reports a Mac user agent, as iPadOS Safari does.
**Safe areas**: headless engines have no notch, so `env(safe-area-inset-*)` is 0 and a HUD at y = 0 looks fine in
every screenshot, while on the phone it sits under the Dynamic Island (59 pt) and the home indicator (34 pt).
`--safe-insets` (or `launch.safeInsets: true`) rewrites every env(safe-area-inset-*) in the page's same-origin CSS
(`<style>`, `<link>`, `@import`, shadow roots, custom properties, inline styles, rules and styles set from script,
also later DOM changes) to the profile's insets for its orientation, so a CSS HUD lays out as on the phone; doctor
reports the count, uses it couldn't rewrite, and cross-origin sheets it can't read. Without `viewport-fit=cover` in
the viewport meta the insets are 0, as on the phone (which letterboxes such a page inside the safe area). `--safe-overlay` draws the island, home indicator and rounded corners
(approximate) over every screenshot after capture. A HUD drawn into the canvas: `witness measure ui --safe <preset>`
(doctor names the preset; `iphone-safari-portrait` for a Safari tab, which has none of these insets).

* `witness doctor` with a browser prints the page (viewport, DPR, screen, touch points, platform), how the main
  canvas lands on the screen, from the layout (`canvas 320×180 shown at 361×203.06 CSS px = 1083×609.19 device px:
  ×3.3844, not a whole number: pixels drawn unevenly`) and from a capture at device pixels (`≈×3.384, uneven: one
  game pixel is 3 or 4 device px; 38.4% of game pixels are 4 device px wide`: the share is the layout's exact
  fraction; when the picture can't be read it says so instead of passing). A canvas whose backing store is its CSS
  size on a DPR-3 phone is reported as upscaled with smoothing: blurry.
* `capture`: `canvas` reads the game's own buffer (game pixels: what `--crop`, `--follow`, `--annotate`, `--scale`,
  `measure ui` / `figure` / `align` / `registration` need; they refuse the other modes); `element` is the canvas as
  the screen shows it, at device pixels; `screen` is the whole viewport (HTML HUD too). Goldens (`match`) compare
  like with like: record and match them with the same capture.
  `witness shot --device iphone-15 --capture element` then `witness measure scale shot.png` measures fractional
  scaling and blur.
* `dom:tap:x,y@t`, `dom:click:x,y@t`, `dom:key:space@t` in `--input` / tests: real (trusted) browser input at that
  frame, through Playwright instead of the adapter (game pixels, mapped onto the canvas). `dom:tap` needs a touch
  device.
* WebKit: install it once with `npx playwright install webkit` (no admin; ~60 MB download). Playwright's WebKit is
  close to Safari, not Safari: on Windows it has **no Web Audio and no TouchEvent** (Witness puts in a silent
  AudioContext so pages load, and doctor says so; touches arrive as pointer events). Check audio with Chromium.
  WebGL 1 and 2 work in it (checked on Windows with WebKit 27.2: a shader draws, `readPixels` and element
  screenshots are right and repeat exactly); it names its renderer "Apple GPU" whatever draws underneath. Headless
  Chromium renders WebGL in software (SwiftShader through ANGLE). `witness doctor` prints both: whether WebGL 1/2
  exist, the renderer, and what the game's canvas draws with (✖ when it needs a WebGL the engine lacks).

## 11. Engine notes

### Plain canvas / hand-written loops
Nothing special: `requestAnimationFrame(loop)` and `dt = (now - last) / 1000` just work, as do
`setInterval(update, 16)` loops. Pass `canvas` if the page has several. See
`examples/js-browser`.

### Phaser 3 (verified locally with 3.90, WebGL)
```js
import witness from "./witness/witness.js";
class Main extends Phaser.Scene {
  create() {
    // ...build the level...
    witness.start({ name: "My Phaser Game", size: [this.scale.width, this.scale.height], canvas: this.game.canvas,
      reset: ({ seed }) => this.resetLevel(seed),            // reposition / rebuild directly
      snapshot: () => ({ score: this.score, player: { id: 1, type: "Player", pos: [this.player.x, this.player.y] } }) });
  }
}
```
* Phaser's loop is rAF-driven, so the takeover runs it. Its keyboard plugin reads `keyCode` and
  its pointer input reads the injected events (both verified). `this.time` timers follow
  virtual time.
* In `reset`, reset state directly, and clear what Phaser keeps running:
  `this.time.removeAllEvents()`, `this.tweens.killAll()`, `this.physics.world` bodies. Avoid
  `this.scene.restart()` in `reset`: the restart only happens during the next game step, so a
  snapshot taken right after reset shows the old scene (it's still deterministic).
* `Phaser.Math.RND` has its own seed: `Phaser.Math.RND.sow([String(seed)])` in reset.

### three.js (verified locally with r169)
* `renderer.setAnimationLoop(fn)` and `THREE.Clock` both use the taken-over rAF and
  `performance.now()` (verified). WebGL readback works automatically. Pass
  `canvas: renderer.domElement`.
* For `snapshot`, report `mesh.position.toArray()` (copies), never the mesh.
* Loaders (`GLTFLoader`, `TextureLoader`) are async: `await` them (`loadAsync`) **before**
  `start()`. For assets loaded mid-game, `await` them in `reset` or a call.
* `OrbitControls` and other pointer-driven controls receive the injected pointer events.

### PixiJS (verified locally with v8)
* `await app.init({...})` first, then `start({ canvas: app.canvas, ... })`. `app.ticker` (and
  `Ticker.shared`) run on the taken-over rAF; `ticker.deltaMS` / `deltaTime` are exact.
* Federated events (`eventMode = "static"`, `on("pointertap")`) hit-test the injected pointer
  events correctly (verified). Pixi has no keyboard API, so the game's own `keydown` listeners
  receive key events.
* `Assets.load` is async: await it before `start()`.

### Babylon.js (verified locally with 7.54)
* `engine.runRenderLoop` uses rAF and `engine.getDeltaTime()` uses `performance.now()`, both
  taken over (verified). `scene.onKeyboardObservable` receives the injected keys.
* Pass `canvas` (the engine's canvas). WebGL readback works without setting
  `preserveDrawingBuffer` yourself.
* Wait for `scene.whenReadyAsync()` (and any `ImportMeshAsync`) before `start()`. With physics
  plugins (Havok/Ammo), step them from the render loop (the default) so they follow dt.

### Electron (written carefully, not run here)
Witness launches Electron as a process, so the main process sees `WITNESS_ADDR`. Pass it to the
page and keep the window hidden:
```js
// main.js
const witnessAddr = process.env.WITNESS_ADDR;
const win = new BrowserWindow({ show: !witnessAddr, webPreferences: { backgroundThrottling: false } });
win.loadFile("index.html", witnessAddr ? { query: { witness: witnessAddr } } : {});
if (witnessAddr) win.webContents.on("render-process-gone", () => app.exit(1));
```
* `witness.json`: `{"launch": {"command": "node_modules/.bin/electron", "args": ["."], "shell": true}}`.
  On Windows the `.bin` entry is a `.cmd`, which is why `shell: true` is set.
* The adapter quits on `quit` but can't close the app from the page. Exit from the main process
  when the window closes (`app.on("window-all-closed", () => app.quit())`), and in witness mode
  also when the page's WebSocket goes away (send an IPC message from `start({quit(){...}})`).
* `backgroundThrottling: false` matters: a hidden window otherwise throttles the boot frames
  before the hello.
* For a renderer with `nodeIntegration`, the adapter also reads `process.env.WITNESS_ADDR`.

### Tauri (written carefully, not run here)
The Rust side sees `WITNESS_ADDR`. Hand it to the page before any script runs, and hide the
window:
```rust
let addr = std::env::var("WITNESS_ADDR").ok();
let mut b = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
    .visible(addr.is_none());
if let Some(a) = &addr { b = b.initialization_script(&format!("window.WITNESS_CONFIG = {{ addr: {:?} }};", a)); }
b.build()?;
```
Allow the WebSocket in the CSP (`connect-src 'self' ws://127.0.0.1:*`). `witness.json`:
`{"launch": {"command": "src-tauri/target/debug/my-game"}, "build": "npm run tauri build -- --debug"}`.

### Node games
Use explicit handlers: `input(ev)` (return `true`), `step(dt, frame)`, `snapshot()`, and
optionally `screenshot()` returning RGBA and a mixer. The process exits when Witness sends
`quit` or disconnects (`exitOnQuit: false` to handle it yourself in `quit()`). `console.*`
output is forwarded as game logs. See `examples/js-node/game.mjs`.

## 12. Determinism pitfalls

`witness doctor` runs the same seed and input twice and compares the snapshots byte for byte.
When it says **NOT deterministic**, look for:
1. **Async asset loading after the hello.** Image/audio/model loads resolve on real time, so a
   texture arriving at frame 3 in one run and frame 9 in the next changes the game. Load
   everything before `start()`. Load mid-game assets in `reset` (await them), or preload them.
2. **Work outside the taken-over APIs:** Web Workers (their own clocks and timers: not taken
   over), `fetch`/WebSocket game servers, `MessageChannel`/`postMessage` scheduling,
   `document.timeline`, CSS animations/transitions driving gameplay, `event.timeStamp`.
3. **Timers armed before a reset firing after it.** Clear the game's timers in `reset`
   (the takeover keeps them, as a real browser would).
4. **Unseeded randomness:** `crypto.getRandomValues`, a library PRNG seeded from `Date.now()`
   before the import, `Math.random` captured as `const r = Math.random` before the import.
5. **Wall-clock values in the snapshot** (FPS counters, frame timings, raw `performance.now()`).
6. **Iteration order:** `Object.keys` on objects with numeric-like keys is fine; sorting with an
   inconsistent comparator, or `Set`/`Map` filled in async-callback order, is not.
7. **Reading layout during play** (`getBoundingClientRect`, `innerWidth`) can differ if the
   viewport differs. Set `launch.size` to the size the game expects.

## 13. Verify with `witness doctor`

```
witness doctor     # connection, capabilities, step, snapshot, determinism, screenshot, audio
witness test       # run witness/*.witness.json
witness shot --at 1                     # look at a frame (PNG)
witness raw '{"cmd":"eval","expr":"player.x"}'   # poke at live game objects via `scope`
```

"All good" means: connected, `reset` + `step` + `snapshot` work, two identical runs match,
screenshot and audio return data. Then write tests in `witness/*.witness.json`.

**Troubleshooting**

| symptom | cause / fix |
|---|---|
| `no game connected within 60s` (browser) | `start()` never ran: an asset failed to load, an exception happened earlier (see `[page error]` in the output), or the import path 404s. Is the URL right, and is the dev server up? |
| `no game connected` (Node) | the game doesn't import the adapter or never calls `start()`. Is `WITNESS_ADDR` reaching it (wrapper scripts that drop the env)? |
| `browser games need Playwright` | `npm i -D playwright && npx playwright install chromium` in the game folder |
| frames don't advance the game | the game uses a loop the takeover can't see (a Worker, or a `MessageChannel` pump), or `WITNESS_CONFIG.takeover` is false: pass `step(dt)` |
| audio is silent | sound plays through `<audio>` elements, or the AudioContext was created before the import. Use WebAudio buffers, or a mixer |
| screenshot is black (WebGL) | the context was created before the import without `preserveDrawingBuffer`. Import the adapter first |
| `new Function` / `eval` errors | the page's CSP blocks `unsafe-eval`: only the `eval` command (and string timers) need it |

## API summary

```js
import witness, { createMixer } from "./witness/witness.js";
witness.mode                 // "witness" | "record" | "off"
witness.active()             // driven by the CLI?
await witness.start(options) // hello (witness) / reset + start recording (record) / no-op
witness.takeover()           // Node: virtualize timers + clocks
witness.seed(); witness.random()
witness.log("message"); witness.log("warn" | "error", ...)    // errors fail tests
witness.sound("jump", { volume, pos })                       // name a sound for witness listen (no-op off-witness)
witness.mark("label")        // replay marker
witness.recordFrame(dt, events) -> dt                          // Node record mode
witness.recordInput(ev); witness.recordTouch(id, x, y, phase)   // record input for the next frame line
witness.saveRecording()      // browser record mode: download / flush
witness.input, witness.inputEvents(), witness.frame, witness.time
witness.createMixer({ sampleRate, channels }).play(samples, { delay, volume })
witness.real                 // the real setTimeout/requestAnimationFrame/now/Date
```
Page config, read at import: `globalThis.WITNESS_CONFIG = { addr, record, seed, takeover, raf,
timers, webaudio, console, audioSeconds, audioRate, epoch }`.
