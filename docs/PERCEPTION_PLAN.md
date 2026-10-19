# Perception plan: see, hear, ask, chart, measure

Status: plan (2026-10-18), written against Witness 0.5.0 (`dc8a70c`). **Phase 1 is implemented** (B1–B13, the state
schema, `effect`, `measure curve|jump|move|hitstop`, filmstrips, temporal ask, sound↔event matching with the optional
`event: sound` line in the js, python, cpp, java and rust adapters, and the chart quick wins). Most of phase 2
shipped in 0.6.0 (`measure perf` and APNG clips are in 0.7.0; UI layout, colour-blind and palette checks (§3.14, §3.15) are in
0.7.0 as `measure ui | colorblind | palette`), and chart v2 (§3.12: `trace --compare` / `--save` / `--against` overlays, `--xy` paths, `--hist`, plus
`witness heatmap` over replays and playtests, pulled forward from "not doing") is in 0.7.0.
Also in 0.7.0: the `snapshot.paths` filter for per-frame sampling (§1.4/§3.4), motion v2's animation timing
(§3.7.5, as `measure anim`) and the SFX envelope lane on the listen timeline (§3.11). Phase 2 is complete apart from
chart `--panel` grouping.

Witness lets Claude check its own game work. The owner can't read code, so every "it works" Claude
gives him should rest on evidence Witness produced. This plan audits the five perception tools
(see, hear, ask, chart, measure), lists what an AI building a game needs to check but can't check today,
ranks the upgrades, and splits them into two phases. The owner asked for **measure** in particular, and
most of the top-ranked items are measurements.

Ground rules for every item below:

* **Game-agnostic first.** The analysis runs in the CLI on what every adapter already returns (snapshots,
  screenshots, PCM, input timing), so it works for all 11 adapters at once. Where an item gets better with
  game cooperation, that comes from an *optional snapshot convention* (like `entities`), not a protocol change.
  One small protocol addition is proposed (sound events, §3.6), because it really is worth it.
* **Zero dependencies stays.** Everything here (SSIM, connected components, phase correlation, true-peak
  oversampling, colour-blindness matrices, APNG) is a few hundred lines of plain JS on top of the existing PNG
  codec, Raster and FFT. The only thing that would justify a dependency is OCR for reading on-screen text, and
  that's better solved with a `state.ui` convention (§3.14) than with Tesseract. So no new dependency is proposed.
* **Text first, numbers that matter, pictures when they add something.** Each command prints a verdict line
  with the key numbers, then the details. It writes a picture only when the picture shows something the
  numbers can't, and says what to look for in it.

---

## 1. Audit

Method: I read `bin/witness.js`, `src/core/{expr,runner,session}.js` and `src/media/*`, and their tests. I ran
`tests/media/run.mjs` (7/7 suites, 11 s; `measure.mjs` 92/92 in 0.2 s). I drove `examples/arena` (JS, 480×288,
audio at 22 kHz) and `examples/python` (320×180) with `doctor`, `eval --keys`, `trace`, `shot --diff`, all four
`measure` modes and `listen`. Each finding below was seen in a real run or read directly in the code.

### 1.1 Bugs (wrong or silently missing output)

| # | Where | What happens | Seen |
|---|---|---|---|
| B1 | `bin/witness.js:384` | `trace` catches every evaluation error and records `null`. A typo (`state.playr.hp`) prints "1 distinct value(s) @0s null" and drops out of the chart, with no error anywhere. | run |
| B2 | `bin/witness.js:384`, `:356` | `trace` and `eval` call `evaluate(x, snap)` with no `prev`. The expression header (`expr.js:6`) and the skill promise `prev` "in traces/tests", but in a trace `state.player.pos[0] - prev.player.pos[0]` is always `null` (and B1 hides the error). Per-frame velocity, the most natural feel check, can't be traced. | run |
| B3 | `src/media/measure.js:550`, `bin/witness.js:506` | `measure motion` uses background `"first"` by default: frame 0 is the "clean plate". In practice the object is almost always on screen in frame 0, so each mask is old silhouette ∪ new silhouette. Arena: the player walks 80 px in 1 s (1.333 px/frame, from state). The default reported **39.3 px, step 0.667**, half the real figure. `--background median` gave 39.9 px over 0.5 s, step 1.33, which is correct. The command does print a "note", but the wrong numbers come first. | run |
| B4 | `src/media/measure.js:579` | `jitter` = the standard deviation of step lengths. A smoothly accelerating sprite (steps 0, 1, 2, 3, 4 px) scores about 1.4 "jitter", the same as a stuttering one. Acceleration and stutter are mixed up. It should be the deviation from a smooth local fit (the second difference). | code |
| B5 | `src/media/audio-analysis.js:1510` + `:1537` | A sound's segment ends 5 ms before the next detected onset, but detected onsets trail the true start by up to ~20 ms, so a segment can swallow the next sound's attack. Arena: three identical `swing` sounds (j@1, j@1.5, j@3) were reported as **2 distinct sounds**, one "85 ms punchy" and one "1.51 s plucky". The 1.51 s sound doesn't exist, and repeat grouping (`sameSound`) failed because of it. | run |
| B6 | `bin/witness.js:459` | `analyzePCM` accepts labelled `events` (`audio-analysis.js:1465`), and the report even says "pass event times for exact labels", but `listen` never passes any, and there's no way to give them. So no report can say which sound belongs to which action. | code + run |
| B7 | `src/core/session.js:168-169` | Unsolicited adapter lines other than `event: "log"` are dropped, so an adapter has nowhere to report structured events (sounds, hits) even if it wanted to. | code |
| B8 | `src/media/chart.js:53` | Tick decimals come from `floor(log10(step))`, so a 0.25 step prints as `0.3, 0.5, 0.8, …, 1.3, 1.8` (seen on the arena trace chart). Wrong labels on a time axis are bad when the reader is counting frames. | run |
| B9 | `bin/witness.js:375,381-382` | Trace sampling is `t += every` with `every = time/120` by default, so samples don't line up with frames. For `--time 5` it's 2.5 frames per sample, which alternates 2 and 3 frames. Any velocity read off consecutive samples zig-zags by ±20% for no reason. The float accumulation also drifts. | code |
| B10 | `bin/witness.js:520` | `measure motion` dies on screenshots in `format: "png"` (the JS adapter's `screenshotFormat: "png"`, and Unity), although `decodePNG` is right there. | code |
| B11 | `bin/witness.js:416-438` | `shot` ignores `--json`, and its diff line gives only the % and a region *count*. The region boxes the diff computed (`diff.js:105`) never reach the text, so a reader has to open the PNG to learn *where* the change is. | run |
| B12 | `src/core/runner.js:321` | In tests, `prev` is the last step that *fetched* a snapshot, not the previous step. A step with only `shot` or `call` is skipped silently, so `prev` can be two steps old. | code |
| B13 | `bin/witness.js:455,458` | Duplicate "no audio samples" check (harmless, cosmetic). | code |

### 1.2 Weak output and confusing UX for an AI reader

* **`eval --keys`** (`expr.js:111-124`): arrays of numbers print as `state.player.pos  [2 items]` with no value,
  so the most important vectors are invisible. Only `entities[0]` is expanded. In arena that means the Player;
  the 16 other entities (wolves, coins, guard, gate, potions) and their fields never show up. There's no per-type
  summary (`Wolf ×3: hp, state, telegraph`).
* **`trace` text** (`bin/witness.js:402-413`): a vector series prints its first 10 distinct values
  (`@0s [40,120] @0.02s [41.333,120] …`), which says nothing about the run. The help text promises "summary,
  table and a chart", but there's no table. `--json` uses `JSON.stringify(…, null, 1)`, so every `[t, v]` pair
  takes 4 lines: about 4× the tokens.
* **The chart** marks only replay F8 marks (`bin/witness.js:397`). The `--input` the run used (when space was
  pressed, when the key was held) isn't drawn, so you can't see cause and effect. Series that came out all
  `null` (B1/B2) quietly disappear from the legend.
* **Diff picture** (`diff.js:113-163`): it shows only B, dimmed, with magenta changes. You can't see what A
  looked like, and regions aren't marked "appeared", "gone" or "moved". In arena, region 1 is where the player
  *was* and region 2 is where it *is*, and only the reader's guess separates them. A 1 px camera shift turns into
  "90% changed". Size mismatches are scaled bilinearly and diffed anyway (`diff.js:84-88`). `ignore` regions
  exist in the API but the CLI doesn't expose them (`bin/witness.js:430`), so an FPS counter or a clock ruins
  every diff.
* **`measure box`** (`bin/witness.js:490`): one box around *all* differing pixels. Two changes make one huge box.
* **`measure contrast`** (`measure.js:470-484`): it compares the *mean* luminance of A against the mean of B.
  A sprite whose outline disappears against half the ground (a textured ring) can still average to a passing
  ratio. Colour masks ignore `--region` (`measure.js:357`, `bin/witness.js:497-498`).
* **`measure motion`** tracks *one* blob: every differing pixel in the region (`measure.js:558-566`). A wolf, a
  particle or a HUD number in the region merges with the player. A scrolling camera makes the whole screen
  "differ", so motion is useless in any game with a moving camera, which is most of them. Its text output is
  capped at 40 frames (`bin/witness.js:532`), and times print to 0.01 s, not as frame numbers.
* **`listen` timeline**: the top lane is the 400 ms momentary-LUFS curve (`audio-analysis.js:824`), which turns
  every 80 ms SFX into the same flat-topped trapezoid. That's fine for music and useless for SFX. Clipping counts
  sample peaks ≥ 0.999 (`:823`), with no true-peak (inter-sample) check. There's no short-term LUFS or
  loudness range.
* **Times are in seconds everywhere, rounded to 0.01** (`fmtT`, `bin/witness.js:109`), but game-feel facts are
  frame facts ("lands 2 frames late"). There's no `60f` syntax for `--at`.

### 1.3 Missing cases (what Claude can't check at all today)

1. **Cause → effect.** "When I press jump, what changes, and how many frames later?" There's no latency
   measurement from state, pixels or audio.
2. **Timing windows.** Coyote time, jump buffer, parry and i-frame windows, combo windows: anything of the form
   "between which frames does this input still work?"
3. **Shapes of motion from state.** Jump apex, airtime, hang time, accel/decel time, stop distance, knockback
   distance, hitstop length, camera lag. All of it can be computed from a trace, but you have to eyeball it from
   a chart.
4. **Conditions over time.** "When did the gate open?", "HP never drops below 0", "the boss eventually enters
   phase 2". Tests can only check single instants.
5. **What changed between two moments** (a state diff), or between two runs (before and after a code change).
6. **Motion in one picture.** An AI judges motion from a filmstrip it can see in one Read. Today it has to open
   N separate PNGs.
7. **Which on-screen thing is which entity.** Nothing overlays state on pixels, and nothing checks that sprites
   line up with their state positions or hitboxes.
8. **Sound ↔ action.** "Did the jump sound play within 2 frames of the jump?", "was a sound missing or played
   twice?", "does that tone click?"
9. **Moving cameras.** Scroll smoothness, camera jitter and parallax can't be measured.
10. **Turning a measurement into a regression test.** Measurements are one-off CLI calls. A test can't say
    "outline contrast ≥ 3" or "apex 48 ± 2 px".

### 1.4 Speed

Small games are fast. Arena traces 1,200 snapshots in about 0.5 s, and a Python trace of 600 frames takes about
0.4 s. The slow paths only show at scale:

* `trace`/`eval` never use the protocol's `snapshot.paths` filter (`session.js:206` supports it, and the C++, C#,
  Godot, Java, JS and Lua adapters implement it). For a big game (Embervale-sized state) each sample ships the whole world.
* `measure motion` keeps every decoded frame in memory (`bin/witness.js:517-522`): 600 frames at 1280×720 is
  about 2.2 GB plus the base64 copies. It should stream (diff each frame into its mask as it arrives).
* `listen` has to step the game twice for the counterfactual work proposed below, and that's fine: stepping
  is cheap next to analysis.

---

## 2. What an AI building a game actually needs to check

I sorted the brainstorm by one question: *what would Claude otherwise claim without evidence?* These are the
things Claude most often gets wrong in games and can't see from code:

* **Feel numbers.** Jump height, airtime, acceleration, input latency, hitstop, coyote and buffer windows. Claude
  tunes constants blind, and the owner's feedback ("floaty", "laggy") is exactly these numbers.
* **Cause → effect.** Did pressing X do anything, how soon, and did the picture and sound follow?
* **Motion quality.** Stutter, jitter, foot slide, camera shake that shouldn't be there, flicker.
* **Readability.** Can a player see the thing that matters (contrast, colour-blind safety, size), and is UI
  clipped or overlapping?
* **Sound wiring.** Every action has its sound, at the right time, once, without clicks.
* **Regressions.** After a change, did anything else move?

**Dropped or deferred**, and why:

* **Z-order errors.** No game-agnostic signal: neither state nor pixels say what *should* be in front. Revisit if
  a `state.draw` convention ever appears.
* **Stereo pan vs on-screen position.** Most AI-made games are mono or centre-panned (arena and the python
  example are both mono). It can be added on top of the sound events in §3.6 later.
* **Ducking.** It's rare in the games Claude builds, and once events exist it's a 20-line check on top of §3.6.
* **Difficulty curves.** This needs many runs. Agent playtests (`witness play`) already gather deaths and fights
  per session, so it belongs in the playtest report, not in perception.
* **GIF.** APNG covers the human case (§3.17), and Claude's image reader shows only the first frame of an
  animation, so animations don't help the AI reader at all. Filmstrips do.
* **Heatmaps across runs.** Playtests already draw `coverage.png`. A deaths/positions heatmap over several
  replays is nice but rarely decides anything. Phase 3 at the earliest. *(Built anyway in 0.7.0 as `witness heatmap`, since the
  chart v2 world plot made it cheap.)*

---

## 3. Ranked upgrades

Value is to an AI verifying game work. Effort: **S** ≈ under a day, **M** ≈ 1–3 days, **L** ≈ a week, each
including tests and docs. **Agnostic** = works for every adapter with no game changes.

| Rank | Upgrade | Area | Effort | Agnostic |
|---|---|---|---|---|
| 0 | Bug-fix bundle B1–B13 + quick UX fixes | all | S–M | yes |
| 1 | `witness effect`: cause → effect and input latency (state, pixels, audio) | measure / ask | M | yes |
| 2 | `measure curve` + presets `jump`, `move`, `hitstop`: feel numbers from state | measure | M | yes (needs an expression) |
| 3 | Filmstrips, crops and zoom: `shot --sheet`, `--crop`, `--zoom`, `--follow` | see | S–M | yes |
| 4 | Temporal Ask: `eval --when`, `--diff`, `prev` everywhere, test `always/never/eventually` | ask | M | yes |
| 5 | Sound ↔ event alignment in `listen` (+ optional `event: sound` lines) | hear | M | yes (better with events) |
| 6 | `witness window`: timing-window sweeps (coyote, buffer, parry, i-frames) | measure | M | yes |
| 7 | Motion v2: multi-object tracking, camera scroll and jitter, stutter, flicker | measure | L | yes |
| 8 | Measurements in tests + one JSON envelope + `--expect` thresholds | cross | M | yes |
| 9 | Annotated shots and `measure align` (state ↔ pixels, hitboxes) | see / measure | M | partly (convention helps) |
| 10 | Diff v2: A│B│diff, appeared/gone/moved, shift-tolerant, SSIM, `--ignore` | see | M | yes |
| 11 | Audio hygiene: clicks and loop seams, true peak, short-term LUFS, double triggers, repetition | hear | S–M | yes |
| 12 | Chart v2: input bands, event markers, frame-aligned sampling, before/after overlay, XY paths | chart | M | yes |
| 13 | State schema: better `--keys`, per-type entity summary, `eval --summary` | ask | S | yes |
| 14 | UI layout checks from a `state.ui` convention + `--window` sweeps | measure | M | convention |
| 15 | Colour-blind simulation and palette compliance | see / measure | S | yes |
| 16 | `measure perf`: frame-cost spikes over a scenario | measure | S | needs the `perf` capability |
| 17 | APNG clips (for the owner, not the AI) | see | S | yes |

### 3.0 Bug-fix bundle (S–M, agnostic)

These fix B1–B13, plus the cheap UX items from 1.2:
* trace errors are reported once per expression ("✖ state.playr.hp: something before .hp is missing … (all 121 samples)") and listed in the chart legend as "no data";
* `prev` goes to `eval`/`trace`, as the previous *frame's* snapshot (trace) or the previous step (tests, fixed per B12);
* frame-aligned sampling, plus an `f` suffix accepted everywhere a time is (`--at 60f`, `--every 1f`);
* motion picks a sensible background: `auto` = median when the clip is long enough, else "first" with a loud warning;
* jitter redefined (B4), with the old number kept as `stepSpread`;
* the listen segmentation ends a segment at the *energy floor* between two onsets, not at onset − 5 ms;
* PNG screenshots decoded in motion;
* `shot --json`, plus diff region boxes printed;
* the chart tick decimals fixed;
* a compact JSON style (one sample per line) for trace;
* motion streams its frames.

**Test:** each bug gets a regression case. B1/B2/B9 run in `tests/run.mjs` against the mock game; B3/B4 are
synthetic in `tests/media/measure.mjs` (an accelerating square must report jitter ≈ 0, and an object visible in
frame 0 must give the true step under `auto`). B5 is synthetic in `tests/media/audio.mjs` (three identical 80 ms
bursts must give 1 sound ×3). B8 is a `fmtTick(0.25, 0.25)` unit test.

### 3.1 `witness effect`: cause → effect and latency (M, agnostic), rank 1

**What it is.** Run the same seed twice in one process: once with the input and once without it (the "twin").
Because runs are deterministic, the first frame where the two runs differ is caused by the input and by nothing
else. Witness then reports:

```
$ witness effect --input "space@1" --time 0.5
space down at frame 60 (t=1.000s), compared with the same run without it:
  state   first differs at frame 61 (+1f, 17 ms): player.vy 0 → -7.2, player.grounded true → false, player.anim "idle" → "jump"
  pixels  first differ at frame 62 (+2f, 33 ms): region x=212 y=140 18×22 (player), then whole-frame shift at +3f (camera)
  audio   first differs at frame 61 (+1f): a new sound at 1.017s, 92 ms punchy, pitch rising C5→G5
  by +30f: 14 state paths differ (player.pos, player.vy, camera.pos, …), 3.1% of pixels, 1 extra sound
  verdict: input → motion in 2 frames (good: ≤ 3f feels instant), sound in 1 frame
```

**Options:** `--input` (the cause; several events allowed), `--base "<input>"` (inputs both runs share, e.g. walking
right in both), `--paths "player.*"` (narrow the state diff), `--no-pixels`, `--no-audio`, `--shot` (writes a
two-row filmstrip, with-input over twin, for the frames around the first visible change).

**Why it matters.** It answers the most common verification question ("does pressing X do the right thing?")
without Claude knowing the state layout. It measures input latency from state, pixels *and* audio at once, which
is the number behind "laggy controls". It also catches the classic "the input changes state but nothing on screen
moves for 6 frames" (animation or render delay), and "the jump sound plays before the jump".

**How.** Most of it already exists: `begin` resets with the same seed, and `diffValues` (`compare.js`) handles
state. Pixels: per-frame screenshots of both runs from the input frame to the first difference, then a few more.
Audio: the per-frame `audio` reply of both runs, compared sample-wise, and the first divergent sample → frame.
For the pixel and audio passes it steps one frame at a time only inside the window (default 0.5 s).

**Risks.** Hidden RNG use tied to input (a game drawing random numbers on keypress) makes the twin diverge later
in unrelated ways. That's still correct ("caused by the input") but noisy, so the report groups paths and shows
the first-frame changes separately. Games without `reset` restart the process twice (slower, still correct).

**Test.** Extend the mock game with an `X` key whose effect is delayed by a known 3 frames in state and 5 frames
in the picture, plus a sound on frame +1. The test asserts +3f/+5f/+1f exactly. A no-op key must report
"no effect within 0.5 s". There's also a unit test of the divergence finder on synthetic snapshot lists.

### 3.2 `measure curve` + presets: feel numbers from state (M, agnostic), rank 2

**What it is.** It runs a scenario, samples one expression *every frame*, and computes signal facts. The presets
name the facts game designers use:

```
$ witness measure jump --y "state.player.pos[1]" --input "space@1" [--up -1]
jump at frame 60: takeoff +1f · apex 47.5 px at +21f (0.35 s) · hang 6f within 10% of apex
  airtime 41f (0.68 s) · landed at frame 102 · rise 21f / fall 20f (symmetric: floaty fall? no)
  horizontal distance 0 px (no x given; add --x "state.player.pos[0]")
  per-frame vy: -7.2 -6.8 … (gravity 0.4 px/f² rising, 0.4 falling → no fast-fall)

$ witness measure move --x "state.player.pos[0]" --input "d@1-2"
top speed 120 px/s reached in 6f (0.10 s) · stop in 4f, slides 5.3 px after release · no overshoot

$ witness measure curve --of "state.camera.pos[0]" --vs "state.player.pos[0]" --input "d@1-3"
camera lags the player by 9f (cross-correlation) · settles 0.4 s after the player stops · overshoot 0 px
```

Generic `curve` facts: start/end/min/max with frames; first derivative (per frame and per second); plateaus and
frozen spans (hitstop = every listed path frozen for N frames while the game keeps stepping); rise and settle
times (10–90%, within 2%); overshoot; local stutter (frames whose step deviates from the local median by more than
X); lag between two series. The `hitstop` preset: `--paths "player.pos, enemy.pos"`, reporting the frames where all
of them freeze after a hit.

**Why it matters.** This is the owner's "make it feel right" turned into numbers Claude can tune towards and report
in plain words ("the jump is 48 px high and lasts 0.68 s; Celeste's is about 0.5 s, so it'll feel floaty"). Today
Claude eyeballs a chart.

**Risks.** The expression must exist in the snapshot. Without a convention, Claude must find it with `--keys`
(rank 13 makes that easier). Up and down axes vary between games (`--up -1`, auto-detected from the takeoff
direction). Jumps on slopes or moving platforms: "landed" = derivative back to ~0 for 3 frames, which is
documented.

**Test.** Mock game: add a deterministic jump (vy0 = -7.2, g = 0.4 px/f²) so apex, airtime and hang are analytic.
A ballistic table drives `tests/media`-style unit tests for the signal functions (rise, settle, overshoot, lag via
a known shift, plateau detection).

### 3.3 Filmstrips, crops, zoom, follow (S–M, agnostic), rank 3

```
$ witness shot --from 1 --to 1.5 --every 3f --sheet [--cols 6] [--crop x,y,w,h | --follow "state.player.pos" --size 96] [--zoom 3]
✔ 11 frames f60..f90 → witness/shots/sheet.png (6×2 grid, each 96×96 around the player, ×3, labelled f60 +0f …)
$ witness shot --at 2 --crop 200,120,64,64 --zoom 4        # nearest-neighbour, crisp pixels
$ witness shot --from 0 --to 4 --auto 9 --sheet            # the 9 frames where the picture changes most (key moments)
```

**Why it matters.** One Read shows a whole motion (an attack's anticipation, impact and recovery, or a jump), so
Claude can judge animation timing and juice the way a human scrubbing a video would. Arena renders at 480×288, so a
zoomed crop is the only way to see the details of a 14 px sprite. `--auto` picks frames by the size of the
frame-to-frame diff (peaks with spacing), so Claude doesn't have to know when the interesting thing happens.

**How.** Raster already has `drawImage` (nearest/bilinear), `text` and `strokeRect`. `--follow` uses the expression
as pixel coordinates by default, or a projection from rank 9 when one exists. Sheets stay ≤ 1600 px wide and are
labelled by frame and offset from the first.

**Risks.** Too many frames make cells unreadably small. Cap the cell count, and refuse (with advice) past 48.

**Test.** Mock game: a sheet of N frames has the right size and cell count, and the pixel at a known cell offset
equals the source shot's pixel (decode and compare). A crop of a known region equals a manual slice. On synthetic
frames with one big change, `--auto 1` picks that change.

### 3.4 Temporal Ask (M, agnostic), rank 4

```
$ witness eval --when "state.gate.open" --input "e@2" --time 6
state.gate.open first true at frame 151 (t=2.517s), stays true to the end (6s)
$ witness eval --diff 1,3 --input "e@2"
between t=1 and t=3 (frames 60→180), 6 paths changed: gate.open false→true, quest "find key"→"done", player.pos [40,120]→[88,120], …
$ witness eval --at 2 "rose(state.player.grounded)" "changed(state.player.anim)"
```

Test steps gain range assertions, checked every frame across `[from, to]`:

```json
{ "from": 0, "to": 5, "always": "state.player.hp >= 0", "never": "count('Coin') > 5",
  "eventually": "state.score == 1", "within": "0.5s after input" }
```

Failures name the first bad frame and the values there: `always state.player.hp >= 0 — failed at frame 212
(t=3.53s): got -1 >= 0`.

Helpers: `prev` (the previous frame), `rose(x)`/`fell(x)` (false → true on this frame), `changed(x)`, `since(x)`
(frames since `x` last became true), all built from a small per-expression history kept by the evaluator.

**Why it matters.** "Never", "always" and "within" are how game rules are written ("you can't fall through the
floor"). Single-instant expects miss the frame where the rule breaks. `--diff` answers "what did that do?" with
zero knowledge of the state layout.

**How.** Range assertions need a snapshot every frame across the range. Use `snapshot.paths` (only the paths the
expressions mention, worked out statically) where the adapter supports it, to keep that cheap. `--diff` reuses
`diffValues`.

**Risks.** The cost of per-frame snapshots on huge states. The paths filter plus a documented `--every` override
handle it. `with` scoping means `rose(...)` needs the history keyed by expression text, which is easy since the
compiled-expression cache already keys on the source.

**Test.** `tests/run.mjs` against the mock game: `--when` gives the exact frame of the first coin pickup (known
from speed and distance), an `always` assertion that breaks at a known frame reports that frame, and `--diff`
lists exactly the changed paths. There's also a unit test of `rose/fell/changed/since` on synthetic snapshot
sequences.

### 3.5 Sound ↔ event alignment (M, agnostic, better with sound events), rank 5

```
$ witness listen --time 6 --input "space@1, j@2, j@2.5" --events "land: rose(state.player.grounded), hurt: fell(state.player.hp)"
Events vs sounds (window +0..+6f):
  ✔ input space @1.000s → sound A at +1f (17 ms): 92 ms punchy, rising
  ✔ input j @2.000s     → sound B at +1f
  ✖ input j @2.500s     → NO sound within 6f (B played the first time; is the cooldown eating the second press?)
  ✔ land @1.683s        → sound C at +0f
  ⚠ hurt @4.100s        → sound D twice (+0f and +1f): double-triggered?
Sounds with no event: sound E at 5.2 s (ambient? unexplained)
```

Events come from three places. All three are game-agnostic except the last, which is optional:
1. the `--input` itself: each key-down is an event by default (`--no-input-events` turns it off);
2. `--events "name: <expr>"`: the CLI samples every frame and an event fires on each rising edge, reusing §3.4's history helpers;
3. **optional, a protocol addition**: an adapter may send an unsolicited `{"event": "sound", "name": "jump", "frame": 61, "volume"?: 0.8, "pos"?: [x, y]}` line when it starts a sound. This needs a session change (B7) and one function per adapter (`witness.sound("jump")`), and gives every sound its real name. Unknown events are already ignored, so it's backwards compatible with every existing adapter. It's worth it because it turns "sound 3" into "jump", and that's what makes the report usable for an owner who asks "does the coin sound play?".

**Why it matters.** "Did each action make its sound, on time, once?" is most of what audio verification means
in Claude-built games, and today's report can't tie any sound to any action (B6).

**Risks.** Overlapping sounds within one frame. The window and "nearest unclaimed onset" matching handle most
cases. Sounds started by game events with no state signal fall into "no event", which the report says plainly.

**Test.** Mock game: key `j` plays a known burst, but only every other press (a deliberate cooldown bug), and
landing plays a tone. The test asserts ✔/✖ per event with exact frame offsets. A synthetic `analyzePCM` unit test
with labelled events checks matching on overlapping sounds. A session unit test checks that `event: sound` lines
are collected.

### 3.6 `witness window`: timing-window sweeps (M, agnostic), rank 6

```
$ witness window --input "right@0-2, space@{t}" --t 0.9..1.3 --step 1f --expect "state.player.pos[1] < 80" --at "{t}+0.4"
ledge edge at t≈1.083 (frame 65). Jump works for space at frames 50..69 → it still works up to 4 frames after leaving the ledge
  coyote window: 4f (67 ms) · fails from frame 70 · 40 runs, 0.9 s
```

Generic form: a parameter `{t}` (or `{x}`, for positions in input specs) is swept over a range, and each run checks
an expect at an offset time. The output is the set of values where it passes, given as contiguous windows. Typical
uses: coyote time, jump buffering (press *before* landing), parry and block windows, i-frames during a dodge
("hit lands?" swept over the enemy attack time), combo input windows, and the smallest gap a jump clears.

**Why it matters.** These windows are where "feels fair" lives, and no single test or chart shows them. With a
deterministic `reset`, a sweep of 40 runs costs about a second.

**Risks.** Without `reset`, every run restarts the process (slow: the command warns and caps the run count).
Non-monotone results (several windows) are reported as a list, not forced into one.

**Test.** The mock game gets a coyote window of exactly 5 frames and a buffer window of 4. The sweep must report
exactly those, and the run count must equal the steps in the range.

### 3.7 Motion v2 (L, agnostic), rank 7

Five pieces, which can land separately:
1. **Several objects.** Connected components of the change mask (8-neighbour, with a minimum size). Frame-to-frame
   tracking by greedy nearest-centroid matching (enough at game object counts; no Hungarian solver needed). Output per track: id, frames present, path, steps. `--track N` (the Nth biggest) or `--near x,y` picks
   one.
2. **Camera scroll.** The global translation between consecutive frames, by phase correlation on a downsampled
   luminance image using the existing FFT (or block matching, if the FFT size is awkward). Report the scroll per
   frame, the **camera jitter** (deviation from a smooth scroll), sub-pixel shimmer, and "camera moved but
   player didn't" frames. The object masks then subtract the scroll first, so motion works in scrolling games.
   Parallax check: the per-band (top, middle, bottom) scroll ratios against the expected layer factors.
3. **Stutter and frame pacing.** Per track: frames whose step breaks the local smooth fit (B4's new jitter), duplicate
   frames (0 movement between moving frames: "frame hitch" from render interpolation bugs), and 2× steps.
4. **Flicker.** Per region or track: visible → gone → visible within K frames, counted, with the frames listed
   ("the wolf disappears for 1 frame at f88, f120: z-fight or a spawn/despawn bug"). The same check on state:
   entity ids that vanish and reappear (`count()` per id across frames).
5. **Animation timing.** A pose-change detector inside a track's box (a big intra-sprite change and the same
   silhouette) → frames per pose, loop length, and whether it loops cleanly ("walk cycle 8 poses × 6f = 48f; pose
   5 holds 12f, a dropped frame?").

**Why it matters.** Today motion is limited to a single sprite on a static screen, which is a small share of real
games. With these pieces Claude can measure smoothness, shake and flicker, the things owners describe as "janky".

**Risks.** Phase correlation can lock onto repeating tiles (aliasing). Restrict the search to ±32 px per frame and
cross-check with the median of block matches. Big particle effects break components, so there's a minimum size
and a `--region` to limit the search. This is the biggest item, so it lands piece by piece.

**Test.** Synthetic frames (in the style of `measure.mjs`): two squares crossing (two tracks, with the ids kept
through the crossing); a textured background scrolled by a known per-frame sequence including one 1 px jitter
(the exact scroll is recovered and the jitter frame flagged); a square that skips 1 frame (stutter flagged); a
square absent for one frame (flicker at that frame); a 4-pose cycle (the period is recovered). An e2e test on the
mock game with a camera mode.

### 3.8 Measurements in tests, one JSON envelope, `--expect` thresholds (M, agnostic), rank 8

* Every measure command takes `--expect "<expr over its JSON result>"`, for example `--expect "ratio >= 3"` or
  `--expect "airtime between 36f and 44f"`. A failed expect exits 1 and prints the failing value.
* Test steps gain `"measure": {"jump": {"y": "state.player.pos[1]", "input": "space@0"}, "expect": "apexPx >= 40"}`.
  The check Claude ran once becomes a regression test, which is the skill's core rule ("turn every check into a
  test").
* All commands share one `--json` envelope: `{ ok, command, verdict, summary: {…key numbers…}, data, files: [] }`.
  `summary` holds just the few numbers that matter, so an AI can read only that.

**Why it matters.** Measurement without regression protection decays: the next change silently breaks the jump
Claude tuned last week.

**Risks.** Scope creep in the test schema. Keep `measure` steps to the presets and commands that already exist on
the CLI, with the same option names.

**Test.** For each command, a `--json` schema check (the envelope fields exist and `summary` is non-empty) in
`tests/run.mjs`. A test file with a `measure` step that passes and one that fails against the mock jump.

### 3.9 Annotated shots and `measure align` (M, partly agnostic), rank 9

```
$ witness shot --at 2 --annotate [--types Wolf,Player] [--fields hp,state]
✔ → shot.png with 17 entity boxes + labels (#5 Wolf hp=3 windup) drawn from state
$ witness measure align --at 2
state → screen fit: x' = 1.000·x + 0.0, y' = 1.000·y − 0.5 (17 entities, residual 0.6 px) ✔
  outliers: #9 Coin drawn 6 px left of its state pos (sprite anchor or hitbox offset?)
  hitboxes: Player box 12×12 vs sprite 14×14 (1 px margin each side) ✔ · Wolf box 16×16 vs sprite 12×10 ✖ hitbox larger than the art
```

**Projection.** Pixel-space games (arena, the mock game) need none. Otherwise:
* use the optional snapshot convention `state.camera = {pos: [x, y], zoom, size: [w, h]}`, or per-entity
  `screen: [x, y, w, h]`;
* or `--project "<expr giving [sx, sy] from e>"`;
* or the auto-fit: find blobs in the shot (components on the median plate of a short clip, or every blob against
  the background colour), then fit an affine transform that maps entity positions to blob centroids (RANSAC over
  pairs, then least squares).

Hitbox checks read an optional entity `box: [w, h]` (or `[x, y, w, h]`) and compare it with the blob's silhouette.

**Why it matters.** Labels on a picture tell Claude which orange circle is wolf #5 in windup. `align` catches
"the sprite is drawn offset from where the game thinks it is", the cause of "I got hit but I wasn't touching it".

**Risks.** The auto-fit fails in crowded or effect-heavy scenes, so it reports low confidence rather than guessing.
3D games need the convention (perspective projection is out of scope for auto-fit).

**Test.** The mock game in pixel space must fit to identity with a residual under 1 px. A second mock mode with a
camera offset and ×2 zoom must recover them. An entity with a deliberate 6 px sprite offset must be flagged. A
golden check that annotate boxes land on known pixels.

### 3.10 Diff v2 (M, agnostic), rank 10

* The picture becomes **A │ B │ changes**, with the same boxes on all three.
* Each region is classified: *appeared* (B differs from its surroundings, A matches the background), *gone* (the
  reverse), *moved* (a gone region and an appeared one with matching content: "moved 48 px right"), *changed*
  (recoloured or animated).
* **Shift-tolerant:** global translation is found first (phase correlation from §3.7). "Camera moved 1 px right;
  after aligning, 0.4% changed in 2 regions."
* An **SSIM score** (windowed, on luminance) next to the raw percentage, plus `--metric ssim` for regression gates
  that tolerate anti-aliasing noise.
* `--ignore x,y,w,h;…`, plus config `shots.ignore` for clocks and FPS counters. A size mismatch is reported as an
  error unless `--resize`.
* The text lists regions: `1 gone x=33 y=113 14×14 · 2 appeared x=113 y=113 14×14 (moved +80,0)`.

**Why it matters.** It turns "0.23% changed in 2 regions" into "the player moved 80 px right", which is what
Claude needs to judge the change without opening the picture.

**Risks.** Classification heuristics on busy scenes. When unsure, say "changed" and give the box.

**Test.** Synthetic cases: a moved square is classified *moved* with the right vector; an appearing coin is
*appeared*; a 1 px global shift gives "camera shift (1, 0)" and ~0% after aligning; SSIM is 1 for identical images
and falls monotonically with noise; ignore regions are excluded.

### 3.11 Audio hygiene (S–M, agnostic), rank 11

* **Clicks and pops:** a sample-to-sample jump far above the local high-frequency energy, and sounds that start or
  stop at non-zero amplitude (no fade). "sound B ends abruptly at 2.081 s (cut at amplitude 0.21) → add a 5 ms
  fade-out". Claude-generated procedural audio does this constantly (the arena's own tones end on an exponential
  tail with no final fade).
* **Loop seams:** given `--loop a..b`, or found automatically for music (autocorrelation at the bar length),
  compare the end of the loop with its start (level step, waveform discontinuity, spectral jump).
* **True peak** (4× oversampled, as BS.1770 asks) next to the sample peak. Short-term (3 s) LUFS max and loudness
  range in the mix line.
* **Double triggers and machine-gunning:** the same sound twice within 2 frames ("double-triggered"), or retriggered
  every frame while a key is held.
* **Repetition fatigue:** the same sound ×N with identical pitch and length → "jump played 14 times identically;
  add ±1–2 semitone pitch variation".
* A **timeline lane** for SFX: a 10 ms envelope instead of the 400 ms LUFS curve when there's no music.

**Test.** Synthetic signals in `tests/media/audio.mjs` (they already build tones and bursts in `signals.mjs`):
a sine cut mid-cycle is flagged and one with a fade isn't; a loop with a 0.3 amplitude jump at the seam is
flagged; a 997 Hz tone at -3 dBFS phase-shifted to have an inter-sample over gives true peak > sample peak;
identical bursts 1 frame apart are flagged as a double trigger.

### 3.12 Chart v2 (M, agnostic), rank 12

**Status (0.7.0): done**, except `--panel` grouping (series of an overlay share a lane by key; `lanesFor` takes a
`lane` key, so `--panel` is a small step when needed). As built: `trace --compare <variant>` (the `ab` variants plus
`replay=`), `--save` / `--against`, `--xy` over `state.map` or the last screenshot with start/end/death markers,
`--hist`, and `witness heatmap [replays|playtests|--seeds]`.

* Input spans as shaded bands (held keys) and ticks (taps) along the time axis, plus `--events` markers (shared
  with §3.5). Cause and effect are visible on the chart.
* Frame-aligned sampling (B9). The text table becomes real: per series start/end/min/max *with frames*, and for
  vectors per axis (`pos.x 40→160 (min f0, max f90)`), plus the derivative's range.
* `--save base.json` and `--against base.json`: overlay a previous run dashed, with a per-series delta line ("pos.y
  apex 47.5 → 52.0 (+4.5)"). That's the before/after check for any tuning change.
* `--xy "state.player.pos"`: the path drawn over the last screenshot (a trail with frame ticks), for "where did it
  go".
* Multiple panels already exist as lanes. Add `--panel` grouping so related series share an axis on purpose.

**Test.** Unit tests on `renderChart` (the band and marker positions in pixels from a known spec); an e2e trace
`--save` then `--against` with a changed input must report the delta; the `fmtTick` fix.

### 3.13 State schema (S, agnostic), rank 13

`--keys` shows primitive arrays inline (`state.player.pos = [40, 120]`), groups entities by type with counts and
the union of their fields (`Wolf ×3: id, pos, hp, state ∈ {idle, windup, bite}, telegraph`), elides long arrays
(`map.rows [18 × "#…"]`), and marks the paths that changed in the first second (the live ones). `eval --summary`
reuses `summarizeState` (`bin/witness.js:188`), which today only replay and call use.

**Test.** Mock game snapshot: the key listing contains `state.player.pos = [40,90]` and `Coin ×5`, and the
type-union fields are correct for heterogeneous entities.

### 3.14 UI layout checks (M, needs a convention), rank 14

With an optional `state.ui = [{id, rect: [x, y, w, h], text?, fontPx?, layer?}]`, `witness measure ui` reports
overlaps between elements on the same layer, elements clipped by the screen or outside a safe area
(`--safe 5%`), text below a minimum pixel size (`--min-text 8`), and the text contrast of each rect against its
surroundings (using `contrast` with a ring). Combined with `--window 1280x720,1920x1080,2560x1080 --dpi 1,2`, it
runs once per size and reports what breaks where. Without the convention it falls back to pixel-only checks: HUD
pixels touching the screen edge, and text-like regions (high-contrast small components) under the size minimum.
That fallback is weaker and is marked as such.

**Why not OCR:** reading on-screen text needs a dependency (Tesseract or a model), and the game already knows its
UI rects. The convention is cheaper and exact.

**Test.** The mock game with a `state.ui` of two overlapping rects and one off-screen gives exactly those findings,
and a `--window` sweep where a rect only clips at the small size reports it only there.

### 3.15 Colour-blind simulation and palette (S, agnostic), rank 15

`shot --cvd deutan|protan|tritan|achroma` writes the simulated image (Machado 2009 matrices in linear RGB).
`measure contrast --cvd all` reports the ratio and ΔE under each vision type ("Wolf vs ground: ΔE 38 normal,
**4.1 deutan** ✖"). `measure palette shot.png --palette pal.png|hex,…` gives the share of off-palette pixels and
the worst offenders' locations, for pixel-art projects with a fixed palette.

**Test.** Known matrix outputs for pure colours; red/green pairs that pass normally must fail under deutan; a
synthetic image with 3 off-palette pixels reports exactly 3.

### 3.16 `measure perf` (S, needs `perf`), rank 16

Sample the existing `perf` command every frame through a scenario. Report frame_ms, update_ms and render_ms
percentiles, the spikes (frames over 2× the median, with frame numbers and the state `counts` at that moment), and
growth over time (a leak: entity counts or update_ms trending up). In witness mode this is CPU cost, not real
display pacing, and the report says so. It's still the right tool for "spawning 200 particles costs 30 ms".

**Test.** The mock game exposes `perf` with a deliberate spike at a known frame, and the report flags that frame.

### 3.17 APNG clips (S), rank 17

`shot --from 1 --to 2 --clip clip.png` writes an animated PNG (fcTL/fdAT chunks on the existing encoder) at the
game's frame rate, for the **owner** to watch in a browser. The CLI says clearly that the AI reader should use
`--sheet`, since image tools show the first frame only.

**Test.** Decode the chunk structure: the frame count and delays match, and frame 1 equals the plain screenshot.

---

## 4. Phases

### Phase 1: make the existing tools trustworthy, then add the feel and cause→effect core

1. Bug-fix bundle (§3.0): all of B1–B13, compact JSON, frame (`f`) syntax.
2. State schema (§3.13): small, and it makes every later expression easier to write.
3. `witness effect` (§3.1).
4. `measure curve` + `jump`/`move`/`hitstop` presets (§3.2).
5. Filmstrips, crop, zoom, follow, auto key frames (§3.3).
6. Temporal Ask: `prev`/`rose`/`changed`, `--when`, `--diff`, `always/never/eventually` steps (§3.4).
7. Sound ↔ event alignment, including the optional `event: sound` protocol line, the session collection (B7)
   and the helper in the JS and Python adapters first; the other adapters follow in phase 2 (§3.5).
8. Chart quick wins from §3.12: input bands, event markers, the per-axis table (no before/after yet).

Exit criteria: every new command has a mock-game e2e test and unit tests on synthetic data; `witness help`,
`SKILL.md` and `PROTOCOL.md` (sound events, `f` times) are updated; each new command has been run on arena and
the python example, and its output read critically from the point of view of an AI reader.

### Phase 2: the harder perception, and regressions

1. `witness window` timing sweeps (§3.6). It reuses the multi-run machinery from `effect`.
2. Measurements in tests, the JSON envelope, `--expect` (§3.8).
3. Motion v2 (§3.7), piece by piece: components → camera scroll → stutter → flicker → animation timing.
4. Diff v2 (§3.10). It reuses the phase correlation from motion v2.
5. Annotated shots and `measure align` (§3.9), plus the `state.camera` / entity `screen` / `box` conventions in
   PLAYTEST.md's conventions list.
6. Audio hygiene (§3.11).
7. Chart before/after overlays and XY paths (§3.12 remainder).
8. UI layout checks (§3.14), colour-blind and palette (§3.15), `measure perf` (§3.16), APNG (§3.17).
9. `witness.sound()` in the remaining adapters (C++, C#, Go, Godot, Java, Lua, Rust, Unity).

Why this order: phase 1 fixes outputs that currently mislead (B1–B5 can make Claude report wrong numbers or miss
errors), then adds the three things Claude needs on nearly every game task: cause→effect, feel numbers and seeing
motion. Phase 2 items are either heavier image analysis (motion v2, diff v2, align) or depend on phase 1
machinery (window on effect, tests-with-measures on the JSON envelope).

---

## 5. How it's tested: the shared approach

* **Known answers by construction.** As in `tests/media/measure.mjs` today, every image and audio algorithm is
  tested on synthesized input whose right answer is known exactly (squares moving known steps, scrolls with a
  planted jitter, tones with planted clicks, bursts at known times).
* **One extended mock game** (`tests/mock-game.mjs`) gains opt-in mechanics behind environment variables, the
  same way `MOCK_LEAK` works today:
  * `MOCK_JUMP`: an analytic jump, a coyote window of 5f and a buffer of 4f;
  * `MOCK_LAG`: an input whose state effect is +3f and picture effect +5f;
  * `MOCK_CAMERA`: a scrolling camera with a planted 1 px jitter, offset and zoom;
  * `MOCK_SOUNDS`: a cooldown that eats every other press, plus `event: sound` lines;
  * `MOCK_FLICKER`: an entity gone for one frame;
  * `MOCK_UI`: overlapping and clipped rects;
  * `MOCK_PERF`: a frame-time spike.

  Every e2e test asserts the exact planted numbers.
* **The JSON envelope is the test surface.** e2e tests parse `--json` `summary` fields instead of matching text,
  so the text wording can improve freely.
* **Real-game smoke.** Each phase ends with the new commands run on `examples/arena` and `examples/python`, and the
  outputs read as an AI reader would: is the verdict line right, are the key numbers there, is the picture needed?
  PNGs and WAVs from these runs are deleted afterwards.
* **CI:** media and mock e2e already run in `core.yml`. Adapter workflows add one `listen --events` check per
  adapter when its `witness.sound()` helper lands.

---

## 6. Risks across the plan

* **Command sprawl.** Five new verbs or modes (`effect`, `window`, `measure curve|jump|move|hitstop|align|ui|perf|palette`).
  Keep `measure` as the umbrella for anything that produces numbers, make `witness help measure` a short table, and
  update SKILL.md's loop section with *when* to use each one ("changed a control → `effect` + `measure jump`").
* **Per-frame capture cost.** The pixel parts of `effect`, motion v2 and the sheets screenshot every frame. Keep
  the windows short by default (0.5 s), stream frames, and cap the counts with clear messages.
* **Heuristics that sound authoritative.** Classification (appeared/moved), pose detection, auto-fit projection
  and loop detection can be wrong. Every heuristic output carries its confidence or its evidence numbers, and says
  "unsure" instead of guessing.
* **Protocol change.** Only `event: sound` is proposed. It's additive, optional and ignored by old CLIs, and old
  adapters keep working because `listen` falls back to input and expression events.
