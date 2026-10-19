# Changelog

Each release lists what changed and **Adoption steps**: what a game that already uses Witness has to do (or may do)
to pick it up. Steps marked *optional* unlock new features; everything else keeps working without them.

## 0.7.1 (unreleased)

Fixes reported by a C++/SDL3 game that adopted 0.7.0 (desktop and Emscripten web builds).

**Config**
- `--config path/to/file.json` loads that file (any name; its folder is the project root), so a `witness.web.json`
  can sit beside the desktop `witness.json`. `--config DIR` still walks up to a `witness.json`. Every command takes
  it (play start/brief/check/suggest/batch, doctor, test, clean); `play brief` and `play batch` pass the same file
  on to the tester's start line. A missing path is an error instead of a silent search from its parent.

**measure figure**
- With `hide: [id]` the silhouette is now only the with/without diff region(s) at the entity's state position (or
  overlapping its box/rect), as type hides already did; it was the whole diff, so a hide that also re-sorted two
  tied sprites far away (an unstable `std::sort` on equal y) turned a hero into a 119×55 "silhouette". Other regions
  not at a hidden entity are reported: `⚠ 55 px changed elsewhere (1 region: 5×11 at 150,113): draw order /
  unstable sort? Left out of the silhouette.`; `--json`: `data.shots[].elsewhere {pixels, regions: [[x,y,w,h]]}`,
  `summary.warnings`.
- A projection fitted from a single entity on a single sprite is no longer trusted (one entity lands on any blob:
  the player was mapped onto the far-away prop): screen = state, or `state.camera`, unless 2+ entities agree.

**Adoption steps**
1. *Optional:* a second build (web next to desktop): put its config in `witness.web.json` and run commands with
   `--config witness.web.json`.

## 0.7.0 (2026-10-19)

**Chart v2: compare runs, paths, heatmaps, histograms**
- `witness trace --compare <variant>`: the same trace run twice (the `witness ab` variants: env var, `params={...}`,
  `seed=`, `scene=`, `input=`, `cmd=`, plus `replay=b.jsonl` for two recordings) on one chart, A dashed and B solid
  in one lane per series. Per series: A and B start → end with min/max frames, B − A for start/end/min/max, the first
  frame they differ and the largest gap; `--json` has `data.seriesB`, `data.compare` and `summary.differs`,
  `firstDiffFrame`, `deltas`.
- `trace --save base.json`, then `trace --against base.json` after a code change: the same before/after report with
  the saved run as A.
- `trace --xy "state.player.pos"`: the path over the level (`state.map` walls, else the last screenshot when the
  positions line up with it or `state.camera` places it; `--bg map|shot|none`), equal scale on both axes, start / end
  markers, a dot every second, deaths as red X (`--deaths "expr"`; `state.dead` / `state.player.dead` are found by
  themselves) and `--events` as dots. Text: start → end, path length, bounds, net displacement, deaths with frame and
  position; `--y-up` for y-up worlds.
- `trace --hist [--bins 20]`: a histogram per series (n, mean, median, p5, p95, min, max, the most common value;
  small integers get one bin each; A/B overlaid with `--compare`).
- `witness heatmap [last | file.jsonl ... | folder | playtests]`: where the player spent time (seconds per cell) and
  where they died, over replays, every playtest replay, or scripted runs (`--seeds 1,2,3`). Prints the cells with the
  most time, deaths grouped by cell with run and frame, and with `state.map` the open cells never visited; the
  picture draws the level, the heat and the deaths. `--expect "deaths == 0"`, `"unvisitedOpen < 20"`.
- Media: `histogram`, `sharedHistograms`, `heatGrid`, `pathStats`, `renderWorld`, `renderHist` in `src/media/plot.js`;
  line charts take per-series `dash` and `lane` keys.

**Readability: UI layout, colour vision, palettes**
- `witness measure ui [shot.png] --at 2`: HUD and menu layout from an optional `state.ui = [{id, kind: text|button|
  panel|icon, rect: [x, y, w, h], text?, fontPx?, layer?}]` (screen pixels): elements clipped by or entirely off the
  screen, overlaps on the same layer (panels and buttons may hold others), text under `--min-text` (default 2% of the
  screen height), text contrast under 4.5:1 (3 for 24 px+; text vs background colour inside the rect, anti-aliased
  edges left out), elements in the `--safe 5%` margin and edges 1–3 px off alignment (warnings). `--window
  1280x720,1920x1080` runs once per size and prints what breaks only at one size; `--out ui.png` boxes each element
  by status. Without `state.ui` (or with `--pixels`) it finds text-like rows and solid panels from pixels: edges,
  safe area, glyph height and contrast, marked as a heuristic.
- `witness measure colorblind [shot.png] [--type protan|deutan|tritan|achroma|all]`: Machado 2009 simulation in
  linear RGB; writes `<name>-cvd.png` (normal + each type side by side) and one picture per type, and lists the key
  colours that become confusable (ΔE under `--min-de 20` that were distinct normally: "Wolf vs Guard ΔE 83.75 →
  15.57" under protan). Key colours: `--colors name=#hex,...`, else each entity type's sprite colour (sprites fitted
  to state positions) plus the background, else the picture's most common colours; `--a/--b` masks as in `contrast`.
- `witness measure palette <shot.png> [--palette pal.png|.hex|.gpl|.json|"#a,#b"] [--max N]`: colour count, rare
  colours (blending or scaling blur in pixel art), every off-palette pixel grouped by colour with its first pixel,
  box and nearest palette colour, unused palette colours, and over a `--max` budget the least used colours with the
  closest colour to merge each into. `--out` draws off-palette pixels in magenta.
- `examples/arena` lists its HUD and dialogue box in `state.ui` (the drawing is unchanged, pixel for pixel).
- Media: `src/media/color.js` (CVD matrices, `simulateCVD`, `dominantColors`, `pairsUnderCVD`, palette parsing and
  checks) and `src/media/ui.js` (`layoutChecks`, `textContrast`, `findTextRows`); `measure.js` exports `labOf`,
  `luminanceOf`, `LINEAR`.

**Phone safe areas, doubled and repeated text, text without a plate, figure vs ground**
- `measure ui --safe <preset> [--fit contain|cover|stretch]`: the device's `env(safe-area-inset-*)` in points,
  mapped onto the screenshot as the device shows it: `contain` (default: one uniform scale, fitted and centred, as
  browsers and Emscripten show a canvas; an inset that ends inside the letterbox bars costs nothing), `cover`, or
  `stretch` (each axis on its own; with a different aspect the zone findings are only ⚠). Home Screen web app
  presets (viewport-fit=cover): `iphone-portrait` / `iphone-landscape` = iPhone 14 Pro, 15, 15 Pro, 16 (393×852 pt
  @3x): portrait top 59 pt (status bar + Dynamic Island), bottom 34 (home indicator); landscape left and right 59
  (the island can be on either side), bottom 21. `iphone-max-portrait/-landscape`: 14 Pro Max, 15 Plus, 15 Pro Max,
  16 Plus (430×932 pt), the same insets. `iphone-16-pro-*` (402×874) and `iphone-16-pro-max-*` (440×956): 62 instead
  of 59. `iphone-safari-portrait/-landscape`: an iPhone 15 Safari tab (393×659 / 734×343 pt; the toolbars are outside
  the page): no insets. `iphone-se` (375×667 @2x): portrait top 20 (status bar), landscape none. `ipad` (10th gen /
  Air 11", 820×1180 @2x): top 24, bottom 20. Not covered: notched iPhones X–14 (44–50 pt: 12/13 mini 50, XR/11 48,
  12–14 47, X/XS/11 Pro 44). A full-screen shot whose width isn't a whole number of the preset's points is warned
  about, with the preset that fits ("1290 px wide is 3.28 px per pt … it is 430×932 pt at @3x: --safe
  iphone-max-portrait"). Text, buttons and icons inside a zone are ✖ with the zone named; panels ⚠. On
  examples/arena (480×288) with `iphone-landscape`: 1.3646 pt per px, 98.5 pt bars left and right, so only the
  bottom 21 pt = 15.39 px applies ("goal … home indicator (12.39 px into the 15.39 px bottom inset)"). The `%` form is
  unchanged.
- `measure ui`: ✖ the same text shown twice at once (case and spacing ignored, ≥ 3 characters with a letter), both
  rects; labels that repeat on purpose are left out: buttons and icons (two "BUY" buttons), text inside a button, an
  element inside another of the group, 3+ copies (a list or grid of "LOCKED" tiles) and copies on same-size cards.
  Without `state.ui`, text rows with the same ink (⚠).
- `measure ui --from 0 --to 30 [--within 10] [--every 1f]`: samples `state.ui` per element id and reports ⚠ an
  element that hid and came back with the same text within `--within` s of its previous showing (a repeated toast or
  prompt: when it showed, when it came back, how long it was hidden, its rect; a value that changes while the element
  stays, HP 10 → 9 → 10, is not a repeat; gate with `--expect "repeats == 0"`), and ✖ texts doubled at any sampled
  frame (first frame, how many frames).
- `measure ui`: text not held by a panel or button is checked for a backing plate. When the background around the
  glyphs is busy (its main colour under 80% of it), every glyph edge (each text pixel vs the background pixel next
  to it; anti-aliased in-between pixels stand for the colour they blend into) gets a ratio: ✖ when over 10% of them
  are under the bar (⚠ for 3 or more weak edges below that), with p10, median and the worst pixel and its colours,
  so one flower or sparkle pixel touching a letter doesn't fail the text. The averaged ratio of the mock's "WEARY"
  half over sand is 6.13 and passes; its glyph edges over the sand are 1.38:1.
- `witness measure figure --of <Type | id | state.path> [--scenes a,b] [--params '[{"hour":12},{"hour":22}]']
  [--at 1,2]`: a sprite's edge contrast against every ground around it, per scene × param set × time. Silhouette:
  the same run with the new reserved reset param `hide: [id]` (or `--without <variant>`), diffed; else the
  entity's state `box`/`rect` minus the ground's colours, else the sprite at its state position (both marked as
  guesses). The ring of ground pixels touching it is compared with the figure pixels within `--edge` px, clustered
  into surfaces (ΔE ≤ 12), and each surface gets WCAG ratio and ΔE worst / p10 / median, the share of its edge under
  `--min 3`, the worst pixel and colours. Surfaces under `--min-share` (5%; a bare 5 means 5%) are minor; minor
  surfaces covering 25%+ of the ring (textured ground) are judged together as one, and all of the ring when none is
  big enough, so a figure is never passed with nothing judged. Surfaces are named from `state.map` tiles,
  `--surfaces sand=#c2b280,…` (used first when most surfaces match the given colours, so a param that moves the
  ground keeps true names), or by position from an earlier shot of the same scene and frame (night: other colours at
  the same places). A target without an id is hidden by its type and its diff cut to the part at its position. ✖
  when a surface's median is under `--min`; `--expect "worstMedianRatio >= 3"`; `--out` draws each figure and its
  ring (red under `--min`). Also from files: `measure figure shot.png --mask diff:without.png`. On `examples/arena`
  (`--of player --at 1`): the player's dark outline against the floor 2.93:1 worst / 3.53:1 median; walked into the
  left wall (`--input a@0-3 --at 3`): the wall 1.19:1 worst but 13.4:1 median, a 6% wall-edge strip 2.32:1 median (✖).
- `examples/arena` honours `hide` (drawing only).
- Media: `safePreset`, `duplicateTexts`, `pixelDuplicates`, `textTimeline`, `repeatedTexts`, `plateCheck` in
  `ui.js`; `figureGround`, `clusterColors` in `color.js`; `layoutChecks` takes per-side safe margins.

**Performance, animation timing, clips**
- `witness measure perf [--time 3] [--input ...]`: steps one frame at a time and reads the adapter's `perf` after each:
  the game's `update_ms` (else `frame_ms`; else wall time) p50 / p95 / p99 / max with its frame, frames over the 1/fps
  budget, wall time per step next to it, spikes (over 2× the median and +2 ms) with what changed in that frame (a
  deterministic second run: entities added by type, new state changes, `perf.counts` deltas), memory growth from
  `perf.memory_mb` (MB/s, flagged when it climbs steadily), entities piling up, frames getting slower. The report says
  plainly that timing is not deterministic. Gate it: `--expect "p95 < 8"`, `"spikes == 0"`, `"!memoryGrows"`.
- `witness measure anim`: frames per pose, poses per second, loop length (poses and frames; ping-pong cycles too),
  holds longer or shorter than usual with their frame ("pose 2 held 12f at f36–f47 (usual 6f)"), loops that ran long,
  the order breaking (a skipped or extra pose). From a state field (`--of "state.player.anim"`, exact), a fixed or
  followed box (`--region`, `--follow`: sprites animating in place), or the moving objects `measure motion` tracks
  (each object's own pixels; frames where it merged with something are left out). Shape changes in step with a
  fractional speed are reported as sub-pixel shimmer, not animation (seen on `examples/arena`: 1.33 px/f repeats every 3f).
- `witness shot --clip [clip.png] --from 1 --to 2 [--every 1/30] [--scale 0.5] [--speed 0.25]`: an animated PNG (own
  APNG encoder: acTL/fcTL/fdAT, only changed rectangles stored, repeated frames merged) for the owner to watch in a
  browser, at game speed; capped at 600 frames and `--max-mb 8` (frames are dropped until it fits, and the output says
  so). The CLI reminds the AI reader that image tools show only frame 1 (use `--sheet`).
- `listen` timeline: with no music, the level lane is a 10 ms peak envelope in dBFS instead of the 400 ms loudness
  curve, so each sound's attack, length and tail are visible.
- Speed: `trace`, `eval --when`, `measure jump|move|hitstop|curve`, `listen --events`, `window` and `heatmap` now send the
  protocol's snapshot `paths` filter (the top-level keys the expressions read, e.g. `["player", "entities"]`). It is
  checked against one full snapshot (an adapter that drops a key turns it off), a sample that fails is re-checked in
  full, and `WITNESS_PATHS=0` disables it. A trace of 600 frames with a 200 KB world: 0.81 s → 0.28 s.
- Media: `src/media/apng.js` (`encodeAPNG`, `decodeAPNG`), `src/media/anim.js` (`poseLabels`, `poseDistance`),
  `peakEnvelope` / `levelLane` in `spectrogram.js`, `scaleImage` in `sheet.js`; `src/core/perf.js`, `src/core/anim.js`.

**Web / WASM builds on phones: device profiles, WebKit, device pixels, audio unlock, Emscripten**
- Device profiles for browser launches: witness.json `launch.device` or `--device iphone-15 | iphone-15-safari |
  iphone-15-pro-max | iphone-se | ipad` (`-landscape` too; or custom `{width, height, dpr, touch, mobile, userAgent,
  standalone, screen, platform, maxTouchPoints}`): CSS viewport, devicePixelRatio, touch, mobile viewport, user
  agent, `navigator.platform` and `maxTouchPoints` matching it ("iPhone" / "MacIntel", 5: the usual iPad check
  `platform === "MacIntel" && maxTouchPoints > 1` passes; headless engines said "Win32" and 0 or 1), `screen` at the
  portrait point size in both orientations (as iOS), and for Home Screen web apps `navigator.standalone` /
  `display-mode: standalone`. The Safari tab's landscape viewport is its own, 734×343 (Playwright's "iPhone 15
  landscape"), not the portrait one swapped. Safe areas are not emulated (`env(safe-area-inset-*)` is 0 headless):
  doctor names the `measure ui --safe` preset for the profile. `--engine webkit` (iPhone/iPad Safari's engine) or `firefox`;
  when the engine's build isn't installed the error gives the install command (`npx playwright install webkit`, no
  admin). Playwright's WebKit for Windows has no Web Audio and no TouchEvent: Witness puts in a silent AudioContext so
  pages load, and doctor says so. `WITNESS_PLAYWRIGHT=<folder>` finds Playwright outside the game project.
- `witness doctor` on a browser launch: engine, device, page (viewport, DPR, screen, touch points, platform; ⚠ a
  touch profile reporting under 2 touch points), the safe-area preset to check, and how the main canvas lands on the
  screen from the layout ("canvas#game 320×180 shown at 361×203.06 CSS px = 1083×609.19 device px: ×3.3844, not a
  whole number: pixels drawn unevenly (some 3 px, some 4 px wide)", or "×3 upscaled with smoothing: blurry") and from
  a capture at device pixels ("≈×3.384 × 3.380, uneven: one game pixel is 3 or 4 device px; 38.4% of game pixels are
  4 device px wide (from the layout's ×3.3844)": the share is the layout's exact fraction, 1083 = 3·320 + 123; an
  integer layout scale is checked cell by cell; when the picture disagrees with the layout by over 3% it says it
  couldn't read the picture instead of ✔). `summary.web` in `--json`.
- `--capture canvas | element | screen` (witness.json `launch.capture`): screenshots from the game's buffer (default),
  the canvas as the screen shows it, or the whole viewport, both at device pixels (`shot` says "1083×612 device px:
  element capture at DPR 3, not game pixels"). Commands that place game-pixel coordinates on a screenshot refuse
  device-pixel captures with a clear message (`shot --crop/--follow/--annotate/--scale`, `measure ui`, `figure`,
  `align`, `registration`, `anim --region/--follow`, `motion --region`); `test` warns when it matches screenshots.
- `measure scale` reads any scale from runs of one colour, refined to the pixel grid that holds the colour changes
  (a few % in from the edges unless `--region`, so an element capture's rounded border doesn't count): ✖ FRACTIONAL
  (`≈×3.38`, a source pixel drawn 3 or 4 px; the share drawn wider is the scale's fraction) and ✖ BLURRY (hard edges
  smeared over 2+ pixels: smoothing or filtered upscaling), where it used to say "no pixel grid larger than 1". Soft
  one-pixel steps alone (a 1:1 gradient, anti-aliased art) are not blur, and a 1:1 picture still says "no pixel grid
  larger than 1", ok. Synthetic nearest-neighbour scalings of ×2.5, ×3.384375, ×3.684, ×4.2 and a sparse ×2.14375
  with a rounded border: within 0.05% (share within 1%). Real captures of examples/js-browser: iPhone 15 ×3.384 /
  3.383 (layout 3.3844, 38% of pixels 4 px), iPhone SE ×2.144 / 2.143 (layout 2.1437, 14% 3 px), iPad ×4.925 / 4.923
  (layout 4.925). Media: `pixelRuns` in measure.js (also `grid`, `smearPercent`).
- Audio unlock (the iPhone "no sound until a tap" bug): every browser launch emulates the autoplay policy in the
  page, the same in every engine. Default `auto`: Witness counts as the first gesture. `--no-auto-unlock` (witness.json
  `launch.audioUnlock: false`): like iPhone Safari, an AudioContext starts suspended and frozen (the JS adapter's
  captured context doesn't render, `currentTime` stays 0, the capture is silent; music queued while locked plays
  from its start after the tap), and `resume()` works only while a gesture is being handled: Witness input that is one (key down, mouse
  button, finger lifted, text; adapters mark it) or real browser input. `doctor --no-auto-unlock` taps the canvas
  centre, clicks, presses space and enter, and says which resumed audio (on a touch device a key alone is a ⚠), or
  that it stayed suspended with the number of blocked `resume()` calls. Tests read `web.audio.state`,
  `web.audio.blocked`, `web.dpr`, `web.device`.
- `dom:tap:x,y@t`, `dom:click:x,y@t`, `dom:key:space@t` input items: real (trusted) browser input through Playwright
  at that frame (game pixels mapped onto the canvas), for unlock paths that listen to the DOM (SDL3's).
- C/C++ in the browser: compiled with emcc, `witness.h` uses no sockets; `adapters/cpp/witness_emscripten.js`
  (`--pre-js`) holds the WebSocket and calls back into the module (`witness_emscripten_inbuf/recv/closed`, exported by
  the header). `witness_run()` returns control to the browser and keeps the runtime alive; in witness mode the game
  doesn't start `emscripten_set_main_loop`. The shim answers `screenshot` from the canvas when the game has no
  handler and keeps WebGL drawing buffers. Closure-safe for `-O2 --closure 1` (quoted names wherever they cross the
  bundle's edge; checked by a test that scans the files). `witness.h` marks gesture input around the game's `input` handler.
  adapters/cpp/GUIDE.md §13 "Web (Emscripten) builds". **Not verified with a real emcc build** (none here): the C side
  is compiled natively against a stand-in `emscripten.h` (C and C++, warnings as errors) and driven through the real
  shim and CLI (doctor, the shared coins test ×2, 23 of 23 gestures marked); the shim runs in Chromium and WebKit
  pages against a JavaScript stand-in for the module on a growing `WebAssembly.Memory`.

**Fixed**
- JS adapter, WebAudio capture: a sound started at exactly `ctx.currentTime` began on the rendered frame or one
  sample later depending on how long the page had run before the reset (the engine turns the time back into a frame
  and rounds up), so the same run could give different audio after a different history: 3 of 40 histories in
  examples/js-browser. `currentTime` now reads half a sample after the rendered frame: 0 of 120.
- `measure motion` (and `measure anim`) took a lone sprite moving over a plain background for a scrolling camera
  (the picture shift matched the sprite); camera tracking now keeps the camera still when under 2% of the picture
  changed between frames in up to 4 blobs. A sparse scene that scrolls (a starfield: many small changes that one
  shift explains far better than none) is still found as a camera move.
- `trace --xy`: with `--no-chart` it reported a valid position as "not a position" and `--save` stored an empty
  path; path length counted respawn teleports as distance walked (a run with two deaths read 480 instead of 260):
  teleports (the step into a respawn after the death flag, or a step over 10× the usual one) are left out, listed
  ("2 teleports left out: f65, f130", `data.xy.runs[].jumps`) and drawn as thin dotted hops; the dot every second
  vanished when `--every` didn't divide the tick (now the nearest sample).
- `trace --against base.json --save new.json` saved the baseline's series instead of this run.
- `trace --compare` with only `--xy` said "A and B identical on all 0 series": the xy position is now compared per
  axis.
- Deaths while the position is null (games that remove the player while dead) are placed at the last position seen
  (`trace --xy`, `heatmap`), not dropped ("2 in 0 cells").
- `heatmap`: each run counted one frame too many (2.517 s for `--time 2.5`); the automatic cell collapsed to ~1e-10
  for an idle player (now at least 1 unit, or 1/64 of the screenshot behind it); the help said "1/16 of the area"
  (it is 1/16 of the longer side).
- Histograms (`trace --hist`) crashed above ~120k samples (`Math.min(...)` stack overflow).
- `measure ui`: pixel-mode text rows depended on unrelated shapes elsewhere on screen; outlined HUD text (yellow
  letters, black outline) was failed on its fill-vs-background ratio: the outline is now measured and the stronger
  edge is reported, with both ratios ("outlined in rgb(0,0,0): text/outline 19.56, outline/background 12.55,
  without the outline 1.56"); a zero-size `state.ui` text element was called "one flat colour (text not drawn?)".
- `measure colorblind --a/--b` now takes `diff:<png>` masks, as `contrast` does.
- `measure palette`: `--max` merge suggestions could point at each other (both being removed); targets are now
  only colours that stay. Lospec Paint.NET `.txt` palettes (`;` comment lines, AARRGGBB) failed to parse or read
  as the wrong colours. Key colours (`dominantColors`) are most common first again after merging.
- `measure perf`: crashed when memory was reported on fewer than 3 frames (`--time 2f`); a counts peak was labelled
  one frame after its spike (f91 vs f90).
- `measure anim --of` a missing field said "never visible"; it now says the path is undefined on every frame.
- `shot --clip`: the reported length used the requested range, not what was written (wrong when the range isn't a
  multiple of `--every` or frames were dropped for size); a still stretch longer than 65535 delay units was cut to
  that length (now carried on in repeats storing one pixel).

**Adapters**
- Sound event helpers are in every adapter: C/C++ `witness_sound(name)` / `witness_sound_ex(...)`; JS, Python,
  Java, Rust, Lua `sound(...)`; C#, Unity `Witness.Sound(name, volume, x, y)` (Unity also `WitnessBridge.Sound`);
  Godot GDScript `sound(name, volume, pos)`, Godot C# `WitnessNode.Sound(...)`; Go `witness.Sound(name,
  witness.Volume(v), witness.At(x, y))`.

**Behaviour changes**
- `measure scale` on a fractionally scaled or smoothed picture is now `ok: false` (✖ FRACTIONAL / ✖ BLURRY; it said
  "no pixel grid larger than 1", ok). Summary adds `fractional`, `scaleX`, `scaleY`, `softPercent`, `smearPercent`.
- JS adapter: a captured AudioContext reports and honours `suspend()` and `close()`: while not running it is frozen
  (no rendering, `currentTime` still, scheduled sounds wait, silent capture) and resumes where it stopped; its
  `currentTime` is half a sample after the rendered frame.
- Browser device profiles report `navigator.platform` / `maxTouchPoints` 5 / the portrait `screen` of the device:
  a game that picks its touch or iPad UI from them now shows that UI under `--device` (it showed the desktop one).
- `trace --json` `summary`: vector series are summarized per axis (`"state.player.pos.x": {start, end, min, ...}`)
  instead of `{"error": null}`. `trace` now accepts `--expect` (over the summary).

### Adoption steps (0.6.0 → 0.7.0)
1. Update the plugin (`claude plugin update witness@witness-tools`) or pull the repo.
2. If a script reads `trace --json` `summary` for a vector expression: read the per-axis keys (`<expr>.x`, `<expr>.y`).
3. *Optional:* expose `state.dead` (or `state.player.dead`) so `trace --xy` and `heatmap` mark deaths without
   `--deaths`, and `state.map` with a `cell` size so paths and heatmaps are drawn over the level.
4. *Optional:* list the HUD and menus in `state.ui` (see [PLAYTEST.md](docs/PLAYTEST.md#snapshot-conventions)) so
   `measure ui` checks exact rects instead of guessing text rows from pixels; games that honour the reserved reset
   param `window` can be swept with `measure ui --window`.
5. *Optional:* add `memory_mb` (and `counts` such as particles or bodies) to your adapter's `perf` reply, so
   `measure perf` can show leaks and what a spike spawned; adapters that answer `perf` already give frame times.
6. *Optional:* if your adapter implements the snapshot `paths` filter, check it returns the asked-for top-level keys
   unchanged (Witness turns a wrong filter off by itself, but then gets no speed-up); `WITNESS_PATHS=0` turns it off.
7. If a test or script gates on `trace --xy` path length or `heatmap` seconds: re-check the numbers (respawn
   teleports no longer count as distance, and each heatmap run is one frame shorter).
8. *Optional:* C#, Unity, Godot, Go and Lua games can re-vendor their adapter and call its `sound(...)` helper where
   a sound starts, so `listen` and `effect` can name sounds.
9. Browser games tested with `--device`: re-check screenshots and goldens made with a device profile (the page now
   reports the phone's platform and 5 touch points, so a game may switch to its touch UI), and re-vendor the JS
   adapter (`adapters/js/witness.js`) so suspended audio is frozen as on an iPhone. C/C++ web builds: re-copy
   `witness.h` and `witness_emscripten.js` (closure-safe).
10. *Optional:* `measure ui --safe`: pick the preset for how the game ships (`iphone-safari-portrait` for a Safari
    tab, `iphone-portrait` for a Home Screen web app, `iphone-max-*` for 430 pt phones); a letterboxed canvas is now
    fitted (`--fit contain`), so side insets that fall in the bars no longer fail.
11. If a test or script gates on `measure ui` (`ok`, `problems`, `lowContrast`): two new ✖ kinds can appear (`duplicate`,
   `no-plate`), and text over a busy background is now judged by its worst glyph edge (`no-plate`) instead of the
   averaged `contrast` finding. Re-run it once and fix or accept what it finds.
12. *Optional:* honour the reserved reset param `hide: [ids or type names]` (don't draw those entities; change
   nothing else) so `measure figure` gets exact silhouettes; without it the silhouette is estimated from the
   entity's state `box`/`rect` or the sprite at its position. Phone/web builds: `measure ui --safe iphone-landscape`
   (or `iphone-portrait`, `iphone-se`, `ipad`) on a screenshot of the phone-sized layout; list toasts in `state.ui`
   only while they show, so `measure ui --from/--to` can catch repeats.
13. If a script gates on `measure scale`'s `ok`: fractional or smoothed pictures now fail; re-check them.
14. *Optional, web games:* re-vendor `adapters/js/witness.js` (determinism fix for sounds started at `currentTime`,
   gesture marking), run `witness doctor --device iphone-15` (and `--engine webkit` after
   `npx playwright install webkit`), and `witness doctor --no-auto-unlock`: if audio stays suspended, call
   `ctx.resume()` inside the touchend/click/keydown handler. Pin it with a test reading `web.audio.state`.
15. *Optional, C/C++ web builds (Emscripten):* re-vendor `witness.h`, copy `witness_emscripten.js` next to it, link it
   with `--pre-js`, and skip `emscripten_set_main_loop` in witness mode (adapters/cpp/GUIDE.md §13). Native builds
   need nothing.

## 0.6.0 (2026-10-19)

**Perception: measure what you used to eyeball**
- `witness effect --input "j@1"`: input → reaction latency in frames, from state, pixels and audio (vs the same run
  without the input). Verdict line: "input → picture in 1f (feels instant) · state in 1f · sound in 2f".
- `witness ab --a <variant> --b <variant> --at 3.2 [--rect x,y,w,h] [--from --to --every] [--state]`: run the same
  scenario twice with one difference (env var, `params={...}`, `scene=`, `seed=`, `input=`, `cmd=`) and compare:
  changed px, mean luma/colour delta, bbox, SSIM, an A | B | changes picture, filmstrips of both, state diffs.
- `witness measure jump | move | hitstop | curve`: apex, hang, airtime, gravity; top speed, time to top speed, stop
  distance; hitstop frames, all from state. `measure registration`, `measure align` (sprites vs state positions and
  hitboxes), motion v2 (every moving object tracked, flicker, stutter, camera scroll, `--camera state`).
- `witness window`: sweeps an input's timing to measure coyote time, jump buffering, parry windows, cooldowns.
- `--expect "apexPx between 60 and 70"` on measures, and `measure` steps inside test files.
- Filmstrips: `shot --sheet`, `--auto N` (picks the key frames), `--crop`, `--zoom`, `--follow`; `shot --annotate`
  draws entity boxes and labels from state.
- Diff v2: regions classified appeared / gone / moved / changed with vectors, camera shifts undone, SSIM.
- Time queries: `eval --when "expr"`, `eval --diff t1,t2`; `prev`, `rose`, `fell`, `changed`, `since` everywhere; test
  range steps `always` / `never` / `eventually` / `within` that name the failing frame.
- `listen`: matches sounds to inputs and game events ("j pressed f60 → swing at +1f", missing and double sounds), true
  peak, short-term loudness, clicks, pops, repetition, `--loop` seam checks.
- `eval --keys` shows vectors, groups entities by type; `eval --summary`.
- Charts: input bars, event markers, misspelt series reported, per-axis table with frames.
- **Fixed wrong answers:** expression typos printed blank values silently; `prev` was null in trace/eval; motion
  speed read half the real value when the object was visible in frame 0; identical sounds split into phantom ones;
  chart time labels rounded wrongly; trace samples alternated 2 and 3 frames.

**Playtests**
- `witness play check` (and `play suggest`): which "playtest-ready snapshot" items are present or missing; the
  checklist with examples per genre is at the top of docs/PLAYTEST.md.
- `witness play batch --goals goals.txt`: runs Sonnet-low testers itself as headless `claude -p` processes (2 at once),
  with a combined summary in `witness/playtests/batch-<time>.md`. Works from engineer agents that can't spawn
  subagents.
- New snapshot convention: doors and cells to avoid (map `+` door / avoid characters, entities with `avoid: true`,
  `door: true` or typed Door/Stairs/Exit/Portal, `leadsTo`). Paths go round them unless they're the target.
- Fixes from Embervale: `talk` checks who answered; walls longer than a moving map window are walked round and dead
  ends remembered; moving map windows merge into one memory (and `play.map` / `play.scene` decide the scene key);
  entering the goto target's building finishes the goto and the chain continues; regen/damage-over-time merged into
  one line; listed things preferred over remembered ones; no duplicate "gone" events.

**Protocol (all optional, old adapters unaffected)**
- Sound events: `{"event": "sound", "name": "jump", "frame": 60, "volume?": 0.8, "pos?": [x, y]}`. Helpers:
  C/C++ `witness_sound(name)` / `witness_sound_ex(name, volume, has_pos, x, y)`; JS, Python, Java, Rust `sound(...)`.
- Reserved reset param `camera: "hold"` (CLI `--hold-camera`): keep the camera fixed for pixel measurements.

**Behaviour changes**
- Every `--json` output is now one envelope: `{ok, command, verdict, summary, data, files}`. `eval` rows moved to
  `data.rows`, `trace` series to `data.series`.
- `shot --diff` with different image sizes is an error unless `--resize`.
- `listen` exits 0 even when sounds are missing; gate it with `--expect "missing == 0"`.

### Adoption steps (0.5.0 → 0.6.0)
1. Update the plugin (`claude plugin update witness@witness-tools`) or pull the repo.
2. If any of your scripts parse `--json` output: read results from `data` (`data.rows` for eval, `data.series` for
   trace).
3. If you use `shot --diff` with images of different sizes: add `--resize`.
4. If you gate on `listen`'s exit code: use `--expect "missing == 0"` instead.
5. Run `witness doctor` and `witness test --repeat 2`: nothing else should change.
6. *Optional:* re-vendor `witness.h` (or your adapter) and call `witness_sound("name")` where the game starts a sound,
   so `listen` and `effect` can name sounds and match them to causes.
7. *Optional:* honour reset param `camera: "hold"` (freeze the camera) and drop any custom camera-hold switch.
8. *Optional:* mark doors / no-go cells in the snapshot (see docs/PLAYTEST.md, snapshot conventions: "Cells to keep off"), and run
   `witness play check` to see what else the playtest checklist suggests.
9. *Optional:* replace hand-written A/B and contact-sheet scripts with `witness ab` and `shot --sheet`.

## 0.5.0 (2026-10-18)
- `witness clean [--all]`, `witness play clean [t1|--all]`; automatic pruning of old playtests, recordings and
  screenshots on `play start` and `test` (witness.json `"retention"`).
- Retreat seeks cover and counts ranged shooters; team score and limit in observations.
- **Adoption:** none required. *Optional:* set `"retention"` in witness.json.

## 0.4.x (2026-10-18)
- 0.4.0: live playtests (`--live`), `--watch` (`WITNESS_WATCH=1` game-side convention, PROTOCOL.md §9), autofight,
  touch `cancel` phase, `replay.ignore`, doctor shows touch mode. 0.4.1: short per-session tester commands.
  0.4.2: `--watch --turns`.
- **Adoption:** *optional* `WITNESS_WATCH` support (show the window, drop real input, pump events while idle);
  *optional* record FINGER_CANCELED with `witness_record_touch_ex(..., WITNESS_TOUCH_CANCEL, pressure)`;
  *optional* replace window-dependent replay workarounds with witness.json `"replay": {"ignore": [...]}`.

## 0.3.0 (2026-10-18)
- `witness play`: agent playtests (reflex layer, session daemon, reports, frame-exact replays).
- **Adoption:** add a `"play"` section to witness.json (`witness play suggest --write`).

## 0.2.0 (2026-10-18)
- doctor A/B/A determinism, `test --repeat N`, `"match"` steps, replay end-state check, `witness measure`, touch input.
- **Adoption:** re-vendor the adapter; record releases on focus loss; make reset clear everything (doctor tells you).
