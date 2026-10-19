# Changelog

Each release lists what changed and **Adoption steps**: what a game that already uses Witness has to do (or may do)
to pick it up. Steps marked *optional* unlock new features; everything else keeps working without them.

## 0.7.2 (unreleased)

**play: goto a target inside a wall** (reported by Embervale: `goto 172,-100`, a cell in the Inn's front wall beside
its door, was "stuck at cell (172,-101) heading S for 3.2s", twice, then "learned a wall, replanned → gave up", and
the hint blamed a farmer standing nearby)
- A `goto` whose target cell is solid (the map says so, or bumping into it just showed it) says so up front and
  changes course: with a door at or next to it (map door cells `+`, or Door/`leadsTo` things) it goes in by the door
  (`target (172,-100) is inside a wall: (172,-100) is in a building; entering by its door at (173,-100) — entered (the
  scene changed to Inn)`); otherwise it walks to the nearest open cell and is done there (`target (15,5) is inside a
  wall: nearest open cell (15,7), 2 cells from the target — arrived there`). Without a map it switches the moment the
  bump teaches it the target is a wall, instead of failing 3.2 s later. Things in a wall keep "stand next to it"
  (a sign, a chest, a locked gate) unless no open ground touches them or they're a building beside its door.
- The "X is right there" hint on a stuck goto names only door-like things (locked, doors, stairs) or someone standing
  in the cell ahead: never a bystander when a wall is ahead, and never the target itself.
- Adoption steps: none.

**play batch: a tester blocked by a permission denial** (reported by Embervale's first real batch, 2 Sonnet testers:
tester #2 ran `cd <witness-play dir>` then `./long-explorer "goto Inn"`, was denied, correctly refused to work
around it, and the batch said `STOPPED · 0s game · 0 orders`)
- Cause, checked with real `claude -p` runs in dontAsk mode: Claude Code denies a `cd` outside the tester's working
  folder whatever the rules say (`Bash(cd:*)` was allowed), so the brief's "then, once: cd …" step could never work;
  testers who used the long `node …` form played.
- Briefs (`play brief` and batch) now give the session's short command by its absolute path, one command per order,
  no cd: `C:/Users/me/AppData/Local/Temp/witness-play/b10191200-1 "goto Inn"` (quoted when the path has spaces), and
  say "no cd, nothing chained". `play start` prints the same form.
- The batch's `--allowedTools` cover every form the brief uses plus harmless variants: the long `node "…witness.js"
  play` form, the short command bare and quoted, `./name`; `--add-dir <registry>` makes `cd <registry> && ./name`
  legal too. A unit test checks every brief command against the rules; real `claude -p` probes (Haiku, dontAsk)
  ran the bare, quoted (also with a space in the path), cd-chained and long forms and were denied `ls /`.
- A tester that ends with 0 orders and a permission denial (claude's `permission_denials`, or its reply) is reported
  as `blocked: permission denied (<command>)`, its empty session folder is removed, and it runs once more with a
  note naming the exact allowed form; blocked again, that is its outcome in the summary and `batch-*.md`.
- `WITNESS_CLAUDE=<path>` runs another program instead of `claude` (the tests use a fake tester that runs the brief's
  own commands through `sh`).
- Adoption steps: none (the brief and the batch command line changed; a tester briefed by 0.7.1 still works with its
  long-form commands).

**play: name the units; a hard wall-clock stop** (Embervale read `--minutes 3` as wall-clock minutes)
- `play brief` / `play batch` `--minutes` is the tester's budget in GAME minutes, and help, PLAYTEST.md, the brief
  ("about 3 minutes of GAME time") and the batch header ("about 3 game minutes each, tester timeout 15 wall min") now
  say so. On `play start`, `--minutes` was always a wall-clock cap: it is now `--wall-minutes` (`--minutes` still
  works there).
- `play batch --wall-minutes M` (also `play brief`, goals JSON `wallMinutes`): a hard real-time stop, put in the
  tester's start line (the session ends itself, outcome `timeout`) and told to the tester; the tester's own timeout
  becomes M + 3.
- Adoption steps: *optional*: use `--wall-minutes` instead of `--minutes` on `play start`.

**play: run until a game clock** (`--until "<expr>"`, `--game-hours N`, `play.clock`)
- `--until "<expr>"` (start, brief, batch, goals JSON `until`): any Witness expression over the snapshot, checked
  after every step: `state.hour >= 18`, `state.day*24 + state.hour >= 30`.
- `play.clock` in witness.json (or `--clock`): an expression giving in-game hours, which enables `--game-hours N`
  (goals JSON `gameHours`): play until the clock has advanced N hours from the start.
- The tester sees `⏲ clock 33h (+1h30m since the start) · 3h of in-game time to go (until clock 37.5h)` under the
  header and a budget in in-game hours in its brief. When it's reached the order stops: `★ UNTIL REACHED: the game
  clock reached 37.5h (4h30m of in-game time): the playtest is over, run END now`; later orders are refused (live
  mode pauses), END gives outcome `until reached` (and the session ends itself that way if nobody ENDs within 3
  minutes). report.json `until{…, reached, at}`, report.md "Played until: …". A bad expression, `--game-hours`
  without a clock, or a condition already true fails the start before play.
- Checked with the arena (`--clock "state.time / 10"`), the mock game (turn-based and live) and a real Sonnet tester
  (`--game-hours 0.2`: stopped at 12.0 s game time, ENDed, `UNTIL REACHED`).
- Adoption steps: *optional*: add `"clock": "state.day*24 + state.hour + state.minute/60"` (your fields) to `"play"`
  to brief testers in in-game hours with `--game-hours`.

**play report: stuck incidents grouped by place** (Embervale's long run had 63 incidents; report.md listed the first
20 one by one, all at the same spot, and never showed the others)
- Incidents within 2 cells of each other form a spot; report.md's Stuck section is a table of spots, most incidents
  first: cell, count, unresolved, total stuck time, first–last time, headings, and one `witness replay … --at <t>
  --shot` command (its first unresolved incident, else its longest). Single incidents are listed only when there are
  10 or fewer. Reproduce lists the top 3 spots; the summary says "stuck incidents 63 in 4 spots"; report.json gets
  `stuckSpots[]`; the batch line says "stuck 63 in 4 spots".
- Adoption steps: none.

## 0.7.1 (2026-10-19)

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
  unstable sort? (other paint is there without it). Left out of the silhouette.`; `--json`:
  `data.shots[].elsewhere {pixels, regions: [[x,y,w,h]], draw, vanished}`, `summary.warnings`.
- Parts of the hidden entity apart from its body (a health bar 3 px above it, the arena Guard's "!" marker 20 px
  above it) are part of its silhouette when they vanished to the ground with it within one figure size
  (`data.shots[].parts`); "draw order / unstable sort?" is said only when the image without it has other paint there
  (re-sorted sprites), else "parts that vanished with it, away from it". The arena Guard was `⚠ 16 px changed
  elsewhere … draw order / unstable sort?`; now no warning, 12×26 px with its marker.
- A projection fitted from a single entity on a single sprite is no longer trusted (one entity lands on any blob:
  the player was mapped onto the far-away prop): screen = state, or `state.camera`, unless 2+ entities agree. When
  the position then lands on no changed pixel (state in world coords, no `state.camera`), the largest region is
  measured and it says so: `⚠ its state position 40,90 is on no changed pixel (screen = state was assumed: world
  coords? add state.camera or a box): measured the largest changed region instead` (`data.shots[].unplaced`); it
  measured the nearest region (the 5×11 prop) and called the hero "draw order". With a confirmed projection the
  nearest region is used, found without spreading its pixels into `Math.min` (a 200k-px region threw "Maximum call
  stack size exceeded").
- `measure figure <png> --mask diff:<without.png>` splits the diff the same way: its largest region (plus parts that
  vanished beside it), the other regions in the ⚠ line (was the whole diff, silently: a 122×41 box over hero and
  props).
- Mock game: `MOCK_FIGURE_DX=200` (the player drawn 200 px right of its state position), `MOCK_FIGURE_BAR=1` (a health
  bar 3 px above it).

**listen: sounds that start under another sound**
- Onsets under a longer, louder sound are found: when the level hardly rises, a spectral-flux peak still counts if
  bands that were quiet rise 10 dB over all of the 60 ms before (five 40 ms windows; third-octave bands, the low ones
  pooled to 6+ FFT bins) in two windows after, and add at least 1% of the energy. What neighbouring bands lost is
  subtracted, and when bands that held the sound empty while the level holds (a pitch step, a fast sweep) it is one
  sound. The onset is timed on those bands (causal filters, from 10 ms before, a rise held 2 ms). A 0.15 swing at
  1.2 s inside a 555 ms chord at 1.1 s: found at 1.2003 s. Checked against: steady white noise at 0.05/0.15/0.4 (36
  runs) and wind (10): exactly one onset each (the first version of this found 6 and 12 phantom onsets 60-155 ms
  in); a swing on a 0.15 noise bed, 10 starts: within 0..+1 ms (was -39..+3 ms, 1 missed); a tone stepping up by
  octaves and a 200 Hz → 8 kHz sweep in 0.2 s: one onset (were 4 and 2).
- A level rise also counts on the loudest 20 ms near the flux peak against the loudest 20 ms before it, so a short
  sound on a steady bed (+3.4 dB over 34 ms) is found.
- Onset times at 22.05 and 44.1 kHz drifted late in long captures: the 1 ms envelope used whole 22-sample (44-sample)
  windows but read each as 1 ms, 0.23% slow, so a burst at 15 s read 15.034 s and one at 30 s 30.068 s (44.1 kHz:
  29.900 s, refined onto the wrong stretch). Envelope windows now cover exact times (22 or 23 samples): 15.0001 and
  30.0000 s. This also moved the swing in the mock (22.05 kHz) 3 ms late at 1.2 s once onsets were timed on their own
  bands.
- Two sounds within 60 ms (the merge gap) are both kept when the second adds bands the first wasn't using, from
  ~35-40 ms after the first (a swing 40 or 50 ms into the chord, a chord 30 ms after a swing), and still reads as
  added 5 ms later (a slow sweep edging into the next band does once: one sound); closer than that the detector can't
  separate them, and `listen` says so (below).
- The sections agree: `listen --input "j@0.5,j@1.2"` said "swing at +1f (announced, but nothing audible starts
  there)" and then listed "swing ×2" under Sounds. Now both swings are ✔ +1f. An announced sound that really has no
  onset is ⚠ in the events list (`summary.unheard`, not counted as matched) and is left out of the Sounds analysis
  instead of describing whatever else plays there as it.
- An onset belongs to one announced sound: it goes to the sound it is at or after (2 ms slack) before one it is up to
  2 frames before, best pairs first; sounds announced in the same frame share it (`together`, described as "starts
  together with X: measured with it, they can't be told apart"). `j@1.13` (the swing 33 ms into quest_start) was "✖ j
  pressed f68 → no sound — but quest_start started 1f BEFORE it", "2 line up" with one onset, the swing described as
  the 555 ms C5 chord and "No problems found"; now ✔ swing +1f, 83 ms on its own bands. Pressing j every frame from
  f66 to f100 inside quest_start (the mock, 22.05 kHz): f68-f100 all ✔ +1f (f69 was ⚠ "nothing audible", f67/f68
  taken by quest_start's onset). f67 (17 ms after it) is `⚠ … swing announced at +1f, but no onset of its own: it
  starts 16 ms after quest_start's, too close to tell apart` (`soundEvents[].near {label, ms}`).
- An input's sound is matched from +1f (it can't be heard in the press's own frame): `j@1.12` was "✔ j pressed f67 →
  quest_start at +0f"; a sound at +0f is now the "started in the same frame, before the press could be heard" hint.
- With ✖/⚠ events the audio report's last line reads "No problems in the audio itself; N events above are ✖/⚠."
  instead of "No problems found." (`summary.eventIssues` = missing + doubled + unheard; `summary.problems` stays the
  audio's own problems, since a movement key with no sound is ✖ too).
- A sound that always plays under another is measured on the bands it added (8th-order band-pass, its length and
  attack against those bands' level before it): an 80 ms swing under the chord was "35 ms clicky · unpitched · …
  tonal (100% pitched) (always overlapped by quest_start: measured with it)"; now "81 ms punchy (attack 1 ms) · bright
  (centroid 5.76 kHz) · peak -20.5 dBFS, -33.3 LUFS in its own bands 1.60 kHz–12.0 kHz (always under quest_start:
  measured on the bands it adds; pitch not separable)" (`analysis.ownBands`, pitch kind "unknown", tonality "not
  separable"). The double-trigger check for it runs on those bands too: `j@1.5` and `j@1.4,j@1.6` reported "swing …
  has a second attack 14 ms after the first (+5.9 dB): played twice" for one burst; no longer.
- With announced sounds, a sound still playing when the next one starts runs on under it (quest_start: 555 ms, not
  cut to 100 ms at the swing); a sound is described from an occurrence that plays alone when there is one, else marked
  "(always overlapped by swing: measured with it)". A segment no longer takes in the first samples of the next sound
  (a swing read 605 ms long). A chord's beating (or tremolo) is no longer reported as a double trigger.
- Mock game: `MOCK_SOUNDS=overlap`; sounds now start at the current time even when an earlier one wrote past it.

**measure ui --safe on a game canvas**
- A frame from the game is its own (logical) canvas, so its size needn't be a whole number of the preset's points:
  the "639 px wide is 0.75 px per pt … insets scaled" warning is gone there, replaced by one line on the mapping:
  `· the game's 639×295 canvas, scaled to the 852×393 pt screen (contain, 1.3322 pt per canvas px, 0.36 pt bars left
  and right): canvas px = (inset pt − bar) ÷ 1.3322` (`data.safe.canvasNote`). A PNG file still gets the warning,
  which now says a game canvas is fine.

**measure ui without state.ui**
- The pixel heuristic no longer reads world sprites as text: a row's glyphs must be strokes (the median of the
  shorter horizontal/vertical ink run through each pixel ≤ max(2, 0.25 × glyph height): trees, houses, villagers and
  path stones are filled) and share a baseline (half the glyph bottoms within 1 px). A synthetic village (grass tufts,
  flowers, a row of trees, 3 houses, 3 villagers, path stones, a HUD plate and a place name) gave 7 rows; now exactly
  the 3 text rows.
- Driving the game, a second frame 6 frames later leaves out rows that moved with the world (a sign scrolled by the
  camera: `· 1 text-like row moved with the world from f6 to f12 (230,95 21×10 by -12,0): left out as world art`;
  `data.movedWithWorld`, `summary.movedWithWorld`).
- One hint line says the findings are pixel guesses and how to get exact ones (`state.ui`); the count line says
  "(low confidence)", each finding carries `confidence: "low"`, `summary.confidence` is `low` (else `exact`).
- Mock game: `MOCK_UI=world` (an INN sign and three villagers in the world).

**Web builds: WebGL and audio in witness mode**
- `witness doctor` on a browser game prints WebGL: whether the engine has WebGL 1 / 2, its (unmasked) renderer and
  max texture size, and the context the game's main canvas draws with (the page's init script now records each
  canvas's `getContext` type: `web.info().canvases[].context`). ✖ when the game asked for WebGL and got none, ⚠
  when the engine has no WebGL.
  `--json`: `summary.web.webgl {webgl, webgl2, renderer, software, canvasContext}`. Checked on Windows with
  Playwright 1.64.1: headless Chromium 156 renders WebGL 1 and 2 in software ("ANGLE (Google, Vulkan 1.3.0
  (SwiftShader Device (Subzero) …), SwiftShader driver)"); WebKit 27.2 renders WebGL 1 and 2 too and names its
  renderer "Apple GPU". In both a shader draws, `readPixels` and element screenshots are right and repeat exactly
  (the two engines differ by 1 in some channels on a gradient).
- `doctor --no-auto-unlock` on a page that creates no AudioContext (a build that skips opening audio in witness
  mode) says so plainly: "no AudioContext was created … so there is no unlock path to test: open audio in witness
  mode too (… adapters/cpp/GUIDE.md §13)"; `summary.web.audioLocked` is `null` (was `false`, which read as a pass)
  and `summary.web.noAudioContext` is `true`.
- adapters/cpp/GUIDE.md §13: web builds open the SDL audio device in witness mode too, fed silence (so the page has
  its AudioContext and the unlock path can be tested), while `listen` keeps hearing `witness_audio_write()` from
  `step`; §7 says so. The JS guide notes WebGL in WebKit and Chromium.
- Web test page `tests/web/pages/gl.html`: a WebGL2 game with no audio.

**Two scales in one picture (measure scale, doctor)**
- A web build whose world is drawn at a whole ×5 under a UI layer stretched at ×4.11 got "couldn't read the scale from
  the picture (≈×5.000 × 4.911 from runs of one colour vs ×1 from the layout)". A picture that isn't one clean grid is
  now split into regions with one grid each (media `scaleRegions`): tiles read their own scale, readings within 4% form
  a candidate (refitted over its tiles; kept when both axes sit on a grid at the same scale within 3%), every tile goes
  to the grid that holds its colour changes best, flat tiles join a neighbour of their own colour, and region edges move
  to the row / column where the changes switch grids. Synthetic checks (1000×600): a ×5 world with UI rows 115+ at ×4.11
  → `×5 (whole, 78.8% of the picture) · ×4.11 (fractional, 21.2%)`, rects 0,0 1000×473 and 0,473 1000×127 exactly (UI
  ×4.1101 × 4.109, 4 or 5 px, 11% are 5), also with sparse art (flat sky, a flat panel with text); a corner panel at
  42,33 291×136 (6.6%); ×4 UI on ×5; ×1 text on ×5; a ×2.5 panel beside a ×2 world (split at x 600); plain ×5 and ×3.384
  pictures stay one region.
- `doctor` on such a page: `⚠ pixels on screen (…, 2556×1179): 2 scales in one picture: world ×5 (whole, 80.2% of the
  picture) · ui ×4.11 (fractional, 19.8%)`, then `the canvas is shown 1:1 (the layout's ×1): these are the scales the
  game draws at itself` (or which region matches the layout's scale) and one line per region with its rect.
  `--json`: `summary.web.display.pixels.{mixed, regions, groups, layoutRegion}`. A 1:1 canvas whose game draws one
  scale bigger now says so (`≈×5.000: the canvas is shown 1:1 …, so the game draws its pixels at ×5 itself`) instead of
  "couldn't read". Checked in Chromium on `tests/web/pages/mixed.html` (iphone-15-landscape: ui region 0,945 2556×234).
- Region names: optional `state.layers = [{name, rect: [x, y, w, h]}]` in screen pixels (docs/PROTOCOL.md); a region
  takes the smallest layer holding 60%+ of it; without layers, a region holding `state.ui` elements is "UI".
- `measure scale shot.png --rect "world=0,0,1000,473; ui=0,473,1000,127"` reads each rect on its own (`✔ world …: exact
  ×5`, `✖ ui …: FRACTIONAL ×4.11: uneven: one source pixel is 4 or 5 px wide (11% are 5)`); `--layers` names the
  automatic regions; `--json`: `summary.regions`, `data.regions`. `doctor --scale-rect "…"` does the same in canvas px.
- Scales closer than a tile can tell apart are split: a 50 px tile of ×4.11 art fits ×4 too, so a ×4 world under a
  ×4.11 UI strip (likewise ×5 + ×4.9, ×5 + ×5.15, ×3 + ×3.1) was one ×4 region at 100% and `measure scale` passed
  ("no pixel grid larger than 1", exit 0). Now a candidate's tiles whose changes sit off its grid across the picture
  are refitted on their own and kept as a second scale 1-6% away: `✖ 2 scales in one picture: ×4 (whole, 78.8% of
  the picture) · ×4.11 (fractional, 21.2%)`, rects 0,0 1000×473 and 0,473 1000×127, exit 1.
- Each scale is read again from its regions' own pixels: two ×4 bars on a ×5 world (top and bottom 80 px) read
  `×4 × 3.91 (fractional, 26.7%, 2 areas)` (border tiles held ×5 rows; two bands far apart also fit a pitch that
  skips a pixel across the gap) and failed; now `×4 (whole, 26.7%, 2 areas)`, exit 0 (×4.11 bars: ×4.11, was ×4.11 ×
  4.02). Of equally good pitches the one nearest the run lengths' estimate wins (pixelRuns read ×2.05 art as ×1.952,
  its twin grid 2.05/1.05).
- Thin layers: a 100 px ×4.11 column on a ×3 world was missed at any UI phase (one ×3 region, exit 0): its tiles
  straddle the world, so the down axis didn't fit, and ×4.11 over 100 px fit ×4 across. An axis that misses is
  refitted from the tiles on the other axis' grid (one axis is enough when the other has no runs); runs of L and L+1 px
  (5%+ of them L+1) are never a whole ×L; a border tile goes to the grid holding more of its changes; left/right edges
  are scored over the region's own rows. Now 900,0 100×600 (10%) ×4.11 at UI origin x 0, 3 and 905; a 100 px bottom
  strip 0,500 1000×100; a ×2.5 strip 120 px tall whose art ends at x 750: 0,480 750×120.
- doctor called a crisp integer-scaled canvas blurry when the game draws two scales into it (canvas 250×150 at 500×300
  CSS px, DPR 2: exact ×4; a ×4 world, a ×4.11 UI strip): `⚠ pixels on screen …: blurry (16.63% of 4×4 cells mixed)`.
  A failed k×k cell test is blur only with smeared or soft edges; else the regions are read: `2 scales in one
  picture: ×4 (whole, 78.8% of the picture) · ×4.11 (fractional, 21.2%)` and `the layout's ×4 is the ×4 region's; the
  ×4.11 region is drawn by the game at a scale of its own`. An integer layout matches only the region at exactly that
  whole scale (×4.11 is within 3% of ×4). One crisp scale with mixed cells: `⚠ not one colour per 4×4 cell (N%
  mixed) though no edge is smeared: the game draws at ≈×… inside the ×4 canvas`. A blurred ×4 picture is still blurry.

**Safe areas in the page: --safe-insets, --safe-overlay**
- `--safe-insets` (`launch.safeInsets: true`, with a phone or tablet `--device`): an init script rewrites every
  `env(safe-area-inset-top|right|bottom|left[, fallback])` in same-origin CSS (`<style>`, `<link>`, `@import`, nested
  rules, custom properties, `calc()`/`max()`, inline style attributes, `insertRule` / `replace` / `setProperty` /
  `cssText` from script, and later DOM changes) to the profile's insets for its orientation: the `measure ui --safe`
  preset's numbers (iPhone 15 portrait top 59 / bottom 34, landscape left and right 59 / bottom 21; a Safari tab 0; SE
  top 20; iPad top 24 / bottom 20). Cross-origin sheets can't be read: counted. Doctor: `✔ safe areas emulated
  (--safe-insets, iphone-landscape): env(safe-area-inset-*) = right 59 · bottom 21 · left 59 CSS px; 8 env() uses in the
  page's CSS rewritten (5 in style sheets, 2 inline, 1 set from script)` (`summary.web.safe`); without it the "not
  emulated" line names the flag. Checked in Chromium 156 and WebKit 27.2 on `tests/web/pages/safe.html`: a HUD with
  `padding: env(safe-area-inset-top, 7px) 0 0 env(safe-area-inset-left)` computes 59px left in landscape (0px before),
  59px top in portrait; the `<link>` sheet's `calc(20px + var(--sab))` 41px.
- A page without `viewport-fit=cover` gets 0, as on iOS (which lays such a page out inside the safe area): it read
  `✔ safe areas emulated … left 59` and the HUD computed 59px. Now `⚠ safe areas emulated (…): the page has no
  viewport-fit=cover, so env(safe-area-inset-*) is 0, as on the device, where the page is letterboxed inside the safe
  area (…; the letterbox isn't emulated here); 15 env() uses … rewritten to 0 …` (`summary.web.safe.viewportFitCover`).
- Uses that stayed 0px in Chromium 156 and WebKit 27.2 are rewritten: `@import`ed sheets (also from a `<style>` added
  by script: a sheet is walked again until its imports have loaded), fallbacks nested at any depth (`env(…-left,
  max(1px, calc(2px + 3px)))`), `insertRule` on @media/@supports rules, `rule.style.paddingLeft = …` (WebKit: the
  property setters; Chromium: a style rule's declaration is handed out wrapped), and `<style>`/inline styles in shadow
  roots (attachShadow is watched). On `tests/web/pages/safe.html` all seven compute 59px in both engines.
- The count is distinct uses (per declaration, selector and property): a HUD setting `style.cssText` every frame read
  `130 env() uses … rewritten (5 in style sheets, 2 inline, 123 set from script)`; now `15 env() uses … (9 in style
  sheets, 2 inline, 4 set from script)` on the extended page; the calls are `summary.web.safe.rewrites`.
- Uses left unrewritten are found and named, and the line is then ⚠, never ✔: `⚠ 1 env(safe-area-inset-*) use could
  not be rewritten and stays 0 here: @keyframes pulse 0% (style sheet) (…: use style.setProperty)`
  (`summary.web.safe.missed {count, where}`).
- `--safe-overlay`: the Dynamic Island, home indicator and rounded corners (approximate: corner radius 55 pt, island
  126×37 pt 11 pt from the edge, indicator 134×5 pt 8 pt up) and the inset zones tinted magenta are drawn over every
  screenshot after capture, mapped onto what was captured (`--capture screen`, `element`, or the game's own canvas
  pixels); never into the page.

**Follow-up commands keep --config**
- A playtest started with `--config witness.web.json` wrote report.md replay commands without it, so they ran the
  desktop build: now `witness replay --config witness.web.json witness/playtests/c/replay.jsonl …` (and paths with
  spaces are quoted). doctor's "witness test --repeat 2" and "measure ui --safe" hints and effect's "run 'witness
  doctor'" carry the `--config` that was passed.
- They also carry the launch overrides that were passed (`--device`, `--engine`, `--capture`, `--safe-insets`,
  `--safe-overlay`, `--no-auto-unlock`, `--auto-unlock`): doctor printed `witness test --repeat 2 --config
  zzp/witness.web.json` without its `--safe-insets`. `play start` keeps them for report.md's replay commands
  (`witness replay --config witness.web.json --device iphone-15-landscape --engine webkit …`; they ran the config's
  device and engine), `play brief`/`batch` put them on the tester's start line, a playtest's replay head records
  `launch: {engine, device}` and `witness replay` warns when it replays on another browser. The `--capture` hint,
  `witness eval --keys` (eval errors, ask, anim), `witness trace … --save` and "see 'witness doctor'" carry them too.

**Adoption steps**
1. *Optional:* a second build (web next to desktop): put its config in `witness.web.json` and run commands with
   `--config witness.web.json`. Briefs made before this pointed at the folder (the desktop config): re-make them.
2. If a script gates on `measure figure` numbers made with the `hide` param: re-run it once; a silhouette that held
   far-away pixels (a draw-order change) is smaller now, and its surfaces and ratios change with it. A new ⚠ names
   the other regions: if it says "unstable sort?", sort tied sprites stably (e.g. by y, then id) so hiding one
   doesn't reorder the rest.
3. If a script gates on `listen` counts (`matched`, `unexplained`, sound counts, `problems`): sounds that start
   under a louder one are now heard, so "announced but nothing audible" entries and unexplained onsets can move
   into matches; announced sounds with no onset no longer count as matched (`summary.unheard`), and an input no
   longer matches a sound at +0f. Sound lengths for overlapped sounds and the double-trigger problems on chords
   change for the better; re-check thresholds. Steady noise or wind no longer yields unexplained onsets. At 22.05 or
   44.1 kHz, sound times late in a capture move earlier (the drift fix: 34 ms at 15 s). To fail on
   event trouble, gate on `summary.eventIssues` (or `missing`/`unheard`), not `problems`.
4. Nothing to do for `measure ui --safe` on the game's canvas (the warning just went away). Scripts that gate on
   pixel-mode `measure ui` (`problems`) will see fewer: world sprites are no longer text. Better: list the HUD in
   `state.ui`.
5. *Optional, web (Emscripten/SDL) builds:* open the SDL audio device in witness mode too, fed silence (cpp GUIDE §13),
   so `doctor --no-auto-unlock` and `web.audio.state` can check the iPhone unlock path; keep `witness_audio_write()`
   for what `listen` hears. Then `witness doctor` also shows the WebGL renderer.
6. *Optional:* games that draw layers at different scales: expose `state.layers = [{name, rect}]` (screen pixels) so
   doctor names the regions. Scripts reading `measure scale --json` on such pictures: `verdict` and `summary.fractional`
   now describe the regions (`summary.regions`); `ok` is false when any region is fractional.
7. *Optional, web builds with a CSS HUD:* run doctor/tests with `--device <phone> --safe-insets` (or
   `launch.safeInsets: true` in the web config) to lay the HUD out with the phone's insets, and `--safe-overlay` on
   shots to see what the island and corners cover; a page without `viewport-fit=cover` now gets 0 insets, as on the
   phone (add it to draw under the island). `summary.web.safe.rewritten` counts distinct uses now (smaller for a HUD
   that sets its style every frame). Re-make old playtest reports' replay commands by hand if they used `--config`
   or launch flags (add them).
8. Scripts reading `measure scale` or doctor's pixels line: a UI within a few % of the world's scale and thin UI
   columns or strips are now their own regions (`ok` false when fractional); a crisp canvas with a second scale inside
   is no longer `blurry`.

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
