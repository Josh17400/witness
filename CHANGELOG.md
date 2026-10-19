# Changelog

Each release lists what changed and **Adoption steps**: what a game that already uses Witness has to do (or may do)
to pick it up. Steps marked *optional* unlock new features; everything else keeps working without them.

## 0.7.0 (unreleased)

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

**Fixed**
- `measure motion` (and `measure anim`) took a lone sprite moving over a plain background for a scrolling camera
  (the picture shift matched the sprite); camera tracking now keeps the camera still when under 2% of the picture
  changed between frames.

**Behaviour changes**
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
