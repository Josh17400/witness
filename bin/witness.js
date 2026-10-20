#!/usr/bin/env node
// Witness CLI — let Claude see, hear and prove any game. Run `witness help`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_NAME } from "../src/core/launch.js";
import { begin, stepTo, frameAt, findTestFiles, loadTests, runTest, loadReplay } from "../src/core/runner.js";
import { evaluate, fmt, keyPaths, ExprError, usesPrev, hint } from "../src/core/expr.js";
import { WitnessError } from "../src/core/session.js";
import { Matcher, diffValues, digestOf, pathFilter } from "../src/core/compare.js";
import { prune, pruneRegistry, fmtBytes, markGenerated } from "../src/core/clean.js";
import { CLI, die, say, forgetDie, DieError, nums, fmtT, timeList, framesOf, envelope, printJSON, loadConfig, withGame, runOpts, media, writeShot, printLogs, summarizeState, splitTop, resolveReplay, configFlag } from "../src/cli/common.js";
import { parseNamedRects, stateLayers } from "../src/cli/scale-regions.js";
import { evalCommand } from "../src/cli/ask.js";
import { traceCommand } from "../src/cli/trace.js";
import { heatmapCommand } from "../src/cli/heatmap.js";
import { shotCommand } from "../src/cli/see.js";
import { measureCommand } from "../src/cli/measure.js";
import { effectCommand } from "../src/cli/effect.js";
import { listenCommand } from "../src/cli/listen.js";
import { windowCommand } from "../src/cli/window.js";
import { abCommand } from "../src/cli/ab.js";
import { parseArgs } from "../src/cli/args.js";
import { describeWeb, displayReport, unlockProbe, audioReport, webglReport } from "../src/cli/web.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

const HELP = `Witness ${VERSION} — let Claude see, hear and prove any game

  witness init [--lang <id>]          detect the project, add the right adapter + witness.json + Claude skill
  witness doctor                      connect, list capabilities, check determinism/screens/audio
  witness test [files] [--name x]     run *.witness.json / *.witness.mjs test files (--repeat 2: prove determinism)
  witness eval --at 2 "expr" ...      state at given times; --keys (what's there), --when "cond", --diff 1,3
  witness trace --watch "a, b"        values over time: per-series table (frames, per-frame steps) + chart PNG;
                                      --compare VAR=1 / --against base.json (two runs), --xy (path), --hist
  witness heatmap [playtests|last]    where the player spent time and died, over replays, playtests or runs
  witness effect --input "space@1"    what an input causes and how many frames later (state, pixels, audio)
  witness window --input "space@{t}"  sweep an input's timing: where it still works (coyote, buffer, parry windows)
  witness ab --a ENV=0 --b ENV=1      the same scenario twice with one difference, compared (pixels in a rect, state)
  witness shot --at 1,4               screenshots; --sheet/--auto filmstrips, --crop/--follow/--zoom, --diff ref.png;
                                      --clip: an animated PNG for a person to watch
  witness listen --time 8             hear the game: sounds tied to their causes, audio report + PNGs
  witness measure <what> ...          numbers: jump, move, hitstop, curve (state) · scale, box, contrast, motion, anim
                                      (pixels) · ui, colorblind, palette, figure (readability) · perf (frame cost, memory)
  witness replay [file|last]          play back a recorded human session (WITNESS_RECORD)
  witness call <name> [args] --at 1   run a game-specific command, then show the state
  witness raw '<json command>'        send one raw protocol command (for adapter authors)
  witness adapters                    list the bundled adapters
  witness play start|do|look|end ...  agent playtests: a cheap model PLAYS the game, Witness reports (help play)
  witness clean [--all]               delete old playtests, recordings and screenshots (see help clean)

Common options:
  --input "right@0-2, space@1, click:640,360@1.5, action:jump@2"   scripted input
  --seed 7  --scene <name>  --params '{"level":2}'  --build (run witness.json "build" first)
  --window 1920x1080  --dpi 2   (sent as reset params "window"/"dpi" for games that support them)
  --hold-camera   reset param "camera": "hold": games that support it keep the camera still (pixel measures)
  --attach (wait for an already-running game)  --cmd "<launch command>" (no witness.json needed)
  --config DIR|file.json  the project folder, or a config file of any name (witness.web.json beside witness.json)
  Browser games (launch.url): --device iphone-15|iphone-15-safari|iphone-15-pro-max|iphone-se|ipad[-landscape]
  (viewport, DPR, touch, mobile, user agent, platform, 5 touch points, portrait screen size) · --safe-insets
  (launch.safeInsets): the page's env(safe-area-inset-*) rewritten to the device's insets (iPhone 15 portrait top 59 /
  bottom 34, landscape left/right 59 / bottom 21 CSS px; a Safari tab 0; 0 without viewport-fit=cover) · --safe-overlay (launch.safeOverlay): the
  island, home indicator and rounded corners drawn over screenshots after capture · --engine chromium|webkit|firefox · --no-auto-unlock (iPhone audio policy: suspended and frozen until a
  tap) · --capture canvas|element|screen (element/screen: device pixels; crop/follow/annotate refuse them) · input
  dom:tap:x,y@t / dom:click / dom:key:space (real browser input) · expressions web.audio.state, web.dpr
  --json: one shape for every command: { ok, command, verdict, summary, data, files }   --timeout 60
  --expect "apexPx between 60 and 70"   a threshold on the result (summary fields; "36f" = 36): exit 1 if it fails
Times are seconds, or frames with an "f": --at 90f, --every 1f, space@60f. "+2f" = 2 frames after the input's frame.
Machine-wide limit: at most 3 games/browsers run at once (WITNESS_MAX_PROCS; 0 = no limit), 1 of them a headless
browser (WITNESS_MAX_BROWSERS); a launch over it waits, then gives up after 90 s (WITNESS_BUDGET_WAIT).

Run 'witness help <command>' for details. Protocol: docs/PROTOCOL.md`;

const CMD_HELP = {
  clean: `witness clean [--all] [--playtests|--replays|--shots|--movies]
  Generated files are pruned automatically (on play start and test; 'test' says what it removed) to witness.json
  "retention", default {"playtests": {"keep": 5, "days": 7}, "replays": {"keep": 10, "days": 14}, "shots": {"days": 3},
  "movies": {"days": 3}}: the newest N stay unless older than the days limit. Plain 'witness clean' applies those limits now; --all deletes
  every playtest, recording and generated screenshot (running playtests are never touched). Only what Witness wrote is
  removed: in the shots folder its own names (shot*.png, sheet.png, trace*.png, mismatch-*, ...) and files listed in
  its .witness-generated manifest (test step shots, --out files there); in replays *.jsonl and their .state.json.
  witness/movies (Godot --write-movie): its .avi/.png/.wav go, the folder and its .gdignore stay.
  Other files stay, and witness/refs (named baselines: shot --save-ref) is never pruned. A "shots"/"replays" folder
  outside the project, the project folder itself or the Witness install is refused. 'witness play clean t1' deletes
  one playtest once you've acted on it.`,
  test: `witness test [files...] [--name <substring>] [--json]
  Test files (default folder: "tests" in ${CONFIG_NAME}, usually witness/) are *.witness.json or *.witness.mjs:
    [{ "name": "coin pickup", "seed": 1, "input": "right@0-1.5",
       "steps": [ { "at": 2, "expect": ["state.score == 1", "count('Coin') == 4"] },
                  { "at": 2.5, "call": ["teleport", 10, 20], "expect": "state.player.pos[0] == 10", "shot": "after.png" } ] }]
  Expressions are JavaScript over the snapshot: state.*, count(type), first(type), all(type), near(pos, type),
  dist(a, b), len(x), approx(a, b), frame, time, prev (the previous step), rose(x)/fell(x) (became true/false since
  the previous frame), changed(x), since(x) (frames since x became true; ranges only).
  Each point step runs: call → input → expect → probe → shot → match. "at" may be seconds or frames ("90f").
  Range steps are checked on EVERY frame from "from" to "to" (or "from" + "within"), prev = the previous frame:
    { "from": 0, "to": 3, "always": "state.player.hp >= 0", "never": "count('Coin') > 5", "eventually": "state.score == 1" }
    { "from": 1, "within": "30f", "eventually": "rose(state.player.grounded)" }
  A failure names the first bad frame: always state.player.hp >= 0 — failed at frame 212 (t=3.533s): got -1 >= 0
  Measure steps keep a measurement as a regression test (jump, move, hitstop, curve, effect, window; the CLI's option
  names; each runs its own scenario from reset after the timeline; "expect" is checked against its summary):
    { "measure": { "jump": { "y": "state.player.pos[1]", "input": "space@1" }, "expect": "apexPx between 60 and 70" } }
  "match": "label" — the first capture of a label (state, digest, screenshot, audio) is the reference; every later
  capture of that label in this run must be identical (e.g. the same fight run twice, or a plain start after other tests).
  --repeat N   run the whole selection N times in one game process; every step must equal the same step of pass 1
               (state, digest, screenshot and audio): the strongest determinism check. --no-shots / --no-audio skip those.
  An adapter without 'reset' gets a fresh game process for every test (not possible with --attach: one test at a
  time there); measure steps need 'reset'.`,
  eval: `witness eval [--at 0.5,2,90f] "expr" ["expr2" ...] [--input ...] [--json]
  --keys      every path in the snapshot: vectors inline, long arrays elided, entities grouped by type with the union
              of their fields (Wolf ×3: hp ∈ 1..3, state ∈ {idle, chase}); "~" marks paths that changed since frame 0
  --summary   a one-screen summary of the state at each time
  Expressions may use prev (the previous frame) and rose(x) / fell(x) / changed(x).
  --when "cond[, cond2]" [--time 5] [--every 1f]
              samples every frame: the first frame each condition is true, how long, and its spans
  --diff 1,3  what changed in the state between two moments (entities matched by id: removed Coin#12, …)`,
  trace: `witness trace --watch "state.player.pos, state.score" [--time 5] [--every 1f] [--out chart.png]
  Samples every frame (long runs thin out to <= 600 samples) with prev = the previous frame, so per-frame velocity
  is exact ("state.player.pos[0] - prev.player.pos[0]"). Per series: start → end, min/max with their frames, the
  per-frame step range (vectors per axis); for flags and strings, each change with its frame. Expressions that fail
  are reported once with the number of samples. --events "land: rose(state.player.grounded)" marks state events;
  the chart PNG also draws the --input keys as bars under the plot. --replay last traces a recording.
  Two runs on one chart (A dashed, B solid; per series B − A for start/end/min/max, the first frame they differ and
  the largest gap):
    --compare <variant>     B = this run with one difference, the same variants as 'witness ab' (LIFT=1,
                            params={...}, seed=3, input=j@1, cmd=...) plus replay=b.jsonl (two replays:
                            --replay a.jsonl --compare replay=b.jsonl); --a <variant> changes A too
    --save base.json, later --against base.json    before/after a code change: the saved run is A
                            (--against base.json --save new.json saves this run, the B side)
  --xy "state.player.pos"   the path over the level (state.map, else the last screenshot when it lines up; --bg
                            map|shot|none), start/end markers, a dot every second, deaths as red X (--deaths
                            "state.dead"; state.dead / state.player.dead are found by themselves), --events as dots;
                            --y-up for y-up worlds. Path length leaves out teleports (respawns after a death, or a
                            step over 10x the usual one), drawn as thin dotted hops. → <out>-xy.png
  --hist [--bins 20]        histograms of each series (mean, median, p5, p95, most common value; A/B overlaid)
                            → <out>-hist.png
  --json: data.series { "expr": [[t, value, frame], ...] } one sample per line (+ data.seriesB, data.compare,
  data.xy, data.hist); summary has differs / firstDiffFrame / deltas, xy { length, end, deaths }, hist.`,
  heatmap: `witness heatmap [last | file.jsonl ... | folder | playtests] [--pos "state.player.pos"] [--deaths "state.dead"]
              [--cell 16] [--every 1f] [--time T] [--out heatmap.png] [--bg map|shot|none] [--y-up]
  Where the player spent time and where they died. Sources: replays (files, a folder of them, "last", or
  "playtests" = every witness/playtests/*/replay.jsonl), or with none a scripted run (--input, --time 5; --seeds 1,2,3
  runs it once per seed). Each sample counts the frames until the next one, so cells hold time. Prints the cells with
  the most time (seconds and %), deaths grouped by cell with run and frame, and with state.map the open cells never
  visited. Default position: state.player (pos or x/y); default cell: the map's cell, else about 1/16 of the longer
  side of the visited area (at least 1 unit, or 1/64 of the screenshot behind it); deaths default to state.dead /
  state.player.dead (rising edges), placed at the last position seen if the position is null while dead. The picture: the level, the heat (sqrt scale,
  seconds per cell), deaths as red X. --expect "deaths == 0", "unvisitedOpen < 20", "hottest.share < 0.5".`,
  shot: `witness shot [--at 1,4,90f] [--out shots/s.png] [--scale 0.5] [--json]
  --capture element|screen     browser games: what the screen shows at device pixels (with --device iphone-15: the
                               canvas after CSS scaling, or the whole viewport) instead of the game's own buffer;
                               --crop/--follow/--annotate/--scale (game pixels) are refused with it
  --crop x,y,w,h | --follow "state.player.pos" [--size 96 | 96x64]   a region (follow: centred on a position)
  --zoom 3                     crisp nearest-neighbour enlargement (small sprites)
  --save-ref <name>            save the shot as a named baseline, witness/refs/<name>.png (never pruned; commit it)
  --diff <name | ref.png> [--ignore "x,y,w,h; x,y,w,h"] [--threshold 16] [--resize] [--no-align]
                               what changed vs a reference (a --save-ref name, or a file; never the shot's own
                               output path): %, SSIM, and each region as appeared / gone / moved
                               (+dx,+dy) / changed; a camera shift is found and undone first; A │ B │ changes picture.
                               Ignore regions also from witness.json "diff": {"ignore": ["x,y,w,h"]}; gate with
                               --expect "ssim >= 0.99" or "changedPercent < 0.5"
  --annotate [--types Wolf,Player] [--fields hp,state] [--project "[e.pos[0]*2, e.pos[1]*2]"] [--fit]
                               boxes and labels for every entity, placed by its "screen", else --project, else
                               state.camera, else a fit of the state positions to the sprites found
  Filmstrips (one picture, read it with your image tool):
  --from 1 --to 1.5 [--every 3f] --sheet [--cols 6]    a labelled grid of frames (max 48; with --crop/--follow/--zoom)
  --from 0 --to 4 --auto 9                             the 9 frames where the picture changes most (key moments)
  --sheet --at 1,1.4,2.2                               a sheet of chosen moments
  Clips (for a PERSON to watch in a browser; image tools show only frame 1, so read motion yourself with --sheet):
  --clip [clip.png] --from 1 --to 2 [--every 1/30] [--scale 0.5] [--speed 0.25] [--max-mb 8]
                               an animated PNG (APNG) at game speed (× --speed), looping; with --crop/--follow/--zoom.
                               Only changed rectangles are stored and repeated frames merged; at most 600 frames, and
                               over --max-mb every other frame is dropped until it fits (said in the output)`,
  listen: `witness listen [--time 8] [--input ...] [--events "name: expr, ..."] [--within 6f] [--out dir] [--wav]
  Captures the game's audio (adapter 'audio' capability), then:
  * events vs sounds: each input press (unless --no-input-events) and each --events state change gets the sound it
    caused within the window: ✔ "+1f" (an input's sound can come +1f at the earliest; a state change's +0f),
    ✖ no sound (with a hint when the same input played one before), ⚠ played twice; then sounds with no event;
    a sound that starts under a louder one is heard from the bands it adds (from ~35-40 ms after the other starts) and
    measured on them;
  * sounds found (pitch, length, brightness, loudness), music tempo/key/chords, mix problems (clipping, true peak,
    loudness, sounds that start/stop abruptly and click, pops, sounds played twice a frame apart, the same sample
    repeated identically); --loop a..b checks a music loop's seam (level step, jump at the joint, brightness);
  * timeline.png + sounds.png (+ mix.wav).
  Games that announce sounds ({"event": "sound"}, e.g. witness.sound("jump")) get them named and checked against the
  audio (announced but silent, audible but unannounced; an onset belongs to one announced sound). summary.problems
  counts the audio's own problems; gate events with --expect "eventIssues == 0" (✖ missing + doubled + unheard).`,
  ab: `witness ab --a <variant> --b <variant> [--input ...] [--at 3.2,4] [--rect x,y,w,h] [--from 3 --to 4 --every 0.1]
              [--zoom 2] [--state] [--threshold 16]
  Runs the same scenario as A and as B and compares them at the same frames. A variant is KEY=VALUE items joined by
  ";": params={...} (merged into reset params), scene=..., seed=N, input=... (added to --input), cmd=... (another
  launch command); any other KEY=VALUE is an environment variable for the game (each env/cmd variant gets its own
  process). Per moment: changed pixels in the rect (count, %, bbox), mean luma and colour B − A (over the rect and
  over the changed pixels), SSIM, the regions (appeared / gone / moved / changed), an A | B | changes picture, and
  with --state the state paths that differ. --from/--to: a filmstrip of both (A over B) with the changed pixels per
  frame. --expect works on the first moment's summary (changedPixels, lumaDelta, ...).`,
  window: `witness window --input "right@0-2, space@{t}" --t 0.9..1.3 [--step 1f] --expect "expr" [--at "{t}+0.4"]
              [--ref "fell(state.player.grounded)"]
  One run per value of {t} (seconds or frames), each checking --expect at --at ("{t}+offset" or a plain time). Prints
  the values where it passes as windows, and the first failure's values. --ref names the moment the window is about
  (leaving a ledge, landing, an enemy's attack): it is found in a run without the swept input, and the windows are
  given relative to the step it happened in: "+0f..+4f" after leaving the ledge = 5 frames of coyote time;
  "-4f" before landing = a 4-frame jump buffer. Needs 'reset'; at most 600 runs.`,
  effect: `witness effect --input "space@1" [--base "right@0-3"] [--time 0.5] [--paths "player, camera"] [--shot]
  Runs the same seed twice in one process, with the input and without it (both with --base), and reports the first
  frame where the state, the picture and the audio differ: "+1f" = the next frame (immediate). Lists the state paths
  that changed first, the changed screen regions, what the new sound is, and how much differs at the end of the
  window. --shot writes a two-row filmstrip (with / without) around the first visible change. --no-pixels / --no-audio.`,
  replay: `witness replay [file.jsonl | last] [--at 5,10] [--shot] [--watch "expr, ..."] [--ignore "path, ..."]
  Replays are recorded when a human plays with WITNESS_RECORD=<file.jsonl> set (F8 adds a marker). The header's seed,
  scene and params go to reset. If <file.jsonl>.state.json exists (the state the recording ended in), the replay's
  final state is compared to it field by field. Paths that legitimately differ (window-dependent fields) can be left
  out with --ignore or witness.json "replay": {"ignore": [...]}: "player.px" skips that field and everything under it,
  "entities[*].dist" any index, "view.*" any key.`,
  init: `witness init [--lang <id>] [--force]   (ids: witness adapters)`,
  measure: `witness measure <what> ...   numbers instead of eyeballing; --json (jump/move/hitstop/curve/motion print { ok, verdict, summary, data })
  From the state, sampled every frame of a scripted run (--input, --time, --from/--to):
  jump --y "state.player.pos[1]" --input "space@1" [--x expr] [--up -1|1] [--key space]
      takeoff, apex height and frame, hang (frames within 10% of the apex), airtime, rise/fall, gravity rising vs
      falling (fast-fall?), horizontal distance. Landing = holds still for 3 frames.
  move --x "state.player.pos[0]" --input "right@1-2" [--key right]
      top speed (px/f and px/s), frames to reach it, and after the release: when it stops, how far it slides, overshoot
  hitstop --paths "state.player.pos, state.enemy.pos" --input "right@0-2, j@1"
      freezes: frames where every path holds still between motion (with their length and the input before them)
  curve --of "state.camera.pos[0]" [--vs "state.player.pos[0]"] --input "d@1-3"
      start/end/min/max with frames, per-frame steps, rise 10–90%, settle (2%), overshoot, still spans, stutter
      (single steps that break a smooth motion), lag behind --vs (frames, by cross-correlation of the steps)
  From pixels:
  align [--at 1] [--types Wolf,Coin] [--clip 0.5]
      state ↔ pixels: fits screen = a·state + b per axis to the sprites found (no projection needed), checks it
      against state.camera, lists entities drawn away from their state position ("#12 Coin 6 px left"), entities not
      found, and hitboxes (entity "box") vs the drawn art. --clip S: a clean plate from the S seconds before, for
      textured scenes (then only things that moved are found).
  registration --pos "state.player.pos" --at 1 --time 1 [--input ...] [--hold-camera]
      the sprite against its state position every frame: the offset of its centre (stays registered, or drifts),
      and its lowest row (the feet) moving in the world against the body (planted vs gliding: foot slide). The
      camera comes from state.camera when the game exposes it, else it's estimated and removed.
  scale <shot.png> [--k 3] [--region x,y,w,h] [--tolerance 0]
      integer-scale test: is every k×k cell one colour? Finds k and the grid offset. Otherwise the scale from runs of
      one colour, refined to the pixel grid that holds the colour changes (any factor; read a few % in from the
      edges unless --region): ✖ FRACTIONAL (a source pixel drawn 2 or 3 px: uneven pixels, e.g. a canvas stretched to
      a phone screen; the share drawn wider is the scale's fraction) or ✖ BLURRY (hard edges smeared over 2+ pixels:
      smoothing / filtered upscaling). Soft ramps alone (gradients, anti-aliasing at 1:1) are not blur. Take the
      picture at device pixels: shot --device iphone-15 --capture element.
      Two scales in one picture (a ×5 world under a UI layer at ×4.11): when it isn't one clean grid it is split into
      regions with one grid each: "2 scales in one picture: ×5 (whole, 78.8% of the picture) · ×4.11 (fractional,
      21.2%)", each region's rect and its uneven pixels (--json: data.regions, summary.regions). --layers
      '[{"name":"ui","rect":[x,y,w,h]}]' (or a file, or a state with layers / ui) names them.
      --rect "world=0,0,1000,473; ui=0,473,1000,127": each rect read on its own (exact ×k / FRACTIONAL / BLURRY).
  box <with.png> <without.png> [--threshold 16]
      the pixels that differ between a shot with something and one without it: its exact box, height, centroid.
  contrast <shot.png> --a <mask> --b <mask>
      WCAG ratio and ΔE between two pixel sets. A mask is x,y,w,h | #rrggbb[~tolerance] | diff:<without.png>,
      and --b may be ring[:radius] (the pixels just outside --a, e.g. outline vs the ground around it).
  ui [shot.png] [--at 1] [--ui ui.json] [--safe 5%|<preset>] [--fit contain|cover|stretch] [--min-text 2%|12]
     [--min-contrast 4.5] [--align 3] [--window 1280x720,1920x1080] [--pixels] [--out ui.png]
      UI layout from the game's state.ui = [{id, kind: text|button|panel|icon, rect: [x,y,w,h], text?, fontPx?,
      layer?}] (or --ui file): ✖ clipped by / entirely off the screen, ✖ overlapping (same layer; panels and buttons
      may hold others), ✖ text smaller than --min-text (default 2% of the screen height), ✖ text contrast under 4.5
      (3 for 24 px+; the text and background colours inside the rect, anti-aliased edges left out), ⚠ inside the
      safe-area margin, ⚠ edges almost aligned (1..--align px apart). Without state.ui (or with --pixels): text-like
      rows (thin strokes on one baseline; filled sprites are not text) and solid panels from pixels, findings marked
      low confidence; a frame 6 frames later leaves out rows that scroll with the camera (world signs). --window runs once per size (the
      reserved reset param) and says what breaks only at one size. --out: boxes coloured by status, safe area in blue.
      ✖ the same text shown twice at once (both rects; from pixels: rows with the same ink, a ⚠; buttons, icons, text
      in buttons, 3+ copies and copies on same-size cards are labels that repeat on purpose). ✖ text not held by a
      panel/button over a busy background (no plate): over 10% of its glyph edges (text pixel vs the background pixel
      next to it, anti-aliased pixels skipped) under the contrast bar (⚠ for 3+ weak edges), with p10, median and the
      worst pixel and its two colours.
      --safe <preset>: env(safe-area-inset-*) in points, ✖ text, buttons and icons in an unsafe zone (⚠ panels). The
      screenshot is shown on the device by --fit: contain (default: one scale, fitted and centred; an inset that ends
      in the letterbox bars costs nothing), cover, or stretch (each axis; with another aspect only ⚠). Home Screen web
      app presets (viewport-fit=cover; a Safari tab has none of these insets): iphone-portrait / iphone-landscape =
      iPhone 14 Pro/15/15 Pro/16 (393×852 pt): top 59 pt (status bar + Dynamic Island), bottom 34 (home indicator);
      landscape left/right 59, bottom 21. iphone-max-portrait/-landscape: 14 Pro Max/15 Plus/15 Pro Max/16 Plus
      (430×932 pt), the same insets. iphone-16-pro-* (402×874) and iphone-16-pro-max-* (440×956): 62 instead of 59.
      iphone-safari-portrait/-landscape: an iPhone 15 Safari tab (393×659 / 734×343 pt): no insets. iphone-se: portrait
      top 20 (status bar), landscape none. ipad (10th gen/Air 11"): top 24, bottom 20. A full-screen shot whose width
      isn't a whole number of points for the preset is warned about, with the preset that fits; a frame from the game
      is its own canvas (any size): one line says how insets map onto it instead.
  ui --from 0 --to 30 [--every 1f] [--within 10] [--input ...]
      sweep state.ui: ⚠ an element (by id) that hid and came back with the same text within --within s (a repeated
      toast or prompt: both times, how long it was hidden, its rect; values that change while it stays, like HP 10 →
      9 → 10, are not repeats; gate with --expect "repeats == 0") and ✖ the same text twice at once (first frame, how
      many sampled frames).
  figure --of <Type | id | state.path> [--scenes a,b] [--params '[{"hour":12},{"hour":22}]'] [--at 1,2] [--input ...]
     [--without "params={...}"] [--edge 1] [--min 3] [--merge 12] [--min-share 5%] [--surfaces sand=#c2b280,...] [--out dir]
  figure <shot.png> --mask diff:<without.png> | #rrggbb[~tol] | x,y,w,h
      a sprite's edge contrast against every ground around it, per scene × param set × time: the silhouette from the
      same run without it (reset param "hide": [its id], or --without), else its state box/rect minus the ground's
      colours, else the sprite found at its state position (both marked as guesses). Ground = the ring of pixels
      touching the silhouette, each compared with the figure pixels within --edge px (strongest edge there; --edge 2
      reaches past an anti-aliased rim), clustered into surfaces (ΔE ≤ --merge; under --min-share of the ring: minor;
      --min-share 5 = 5%; minor surfaces covering 25%+ of the ring, or all of it, are judged together as one).
      Per surface: WCAG ratio and ΔE worst / p10 / median, % of its edge under --min, the worst pixel and colours;
      surfaces are named by state.map tiles, --surfaces colours (ΔE < 15; used first when most surfaces match them, so
      a param that moves the ground keeps true names), or by position from an earlier shot of the same scene and frame
      (day → night: other colours, same places). Only the diff region(s) at the entity's position or box are its
      silhouette (an entity without an id is hidden by type: the part at its position), plus parts within one figure
      size that vanished to the ground with it (a health bar, a "!" marker); ⚠ when the position is on no changed
      pixel (state coords ≠ screen?: the largest region is used), ⚠ "N px changed elsewhere" for other regions (draw
      order / an unstable sort when other paint is there without it). A PNG diff keeps its largest region the same way. ✖ when a surface's median < --min; nothing judged is ✖ too. --expect "worstMedianRatio >= 3".
      --out: each figure and its ground ring, red where the edge is under --min.
  colorblind [shot.png] [--at 1] [--type protan|deutan|tritan|achroma|all] [--colors name=#hex,...] [--types Wolf,Guard]
     [--a <mask> --b <mask>] [--min-de 20] [--out dir] [--no-images]
      colour-vision deficiency (Machado 2009, linear RGB): writes <name>-cvd.png (normal + each type side by side)
      and one picture per type, and reports which key colours stop being distinguishable (ΔE under --min-de that
      were distinct normally). Key colours: --colors, else (driving the game) each entity type's sprite colour
      (sprites fitted to state positions, like align) + the background, else the picture's most common colours.
      --a/--b: the contrast of two masks under each type (as in contrast).
  palette <shot.png | --at 1> [--palette pal.png|pal.hex|pal.txt|pal.gpl|pal.json|"#a,#b"] [--max N] [--tolerance 0]
     [--region x,y,w,h] [--list 20] [--out off.png]
      distinct colours (most used, rare ones: blending or scaling blur in pixel art), --max: over budget lists the
      least used colours and the closest colour to merge each into; --palette: every off-palette pixel counted,
      grouped by colour (count, first pixel, box, nearest palette colour + ΔE), the first --list coordinates, unused
      palette colours; --out draws the off-palette pixels in magenta.
  anim --of "state.player.anim" [--input ...] [--time 2]   |   anim --follow "state.player.pos" [--size 32] | --region x,y,w,h
     |   anim [--at 1 --time 2 --input ...] [--track N] [--tolerance 0.05]
      animation timing: poses, frames per pose (ms, poses/s), loop length (poses and frames, ping-pong cycles too),
      ⚠ holds longer or shorter than that pose's usual (a doubled or dropped frame, with its frame), loops that ran
      long, and the order breaking (a skipped or extra pose). --of: from a state field (exact). From pixels: a fixed or
      followed box (sprites animating in place), or with neither the moving objects measure motion tracks (their own
      pixels each frame; a new pose = over 5% of them differ, 1 px shift allowed). Shapes that change in step with a
      fractional speed are flagged as sub-pixel shimmer, not animation.
  perf [--time 3] [--input ...] [--from 0] [--spike 2] [--spike-ms 2] [--warmup 5] [--no-state]
      what each simulated frame costs: the game's perf update_ms (else frame_ms; else wall time) p50/p95/p99/max with
      its frame, frames over the 1/fps budget, wall time per step (incl. the protocol round trip), spikes (over 2× the
      median and +2 ms) with what changed in that frame (re-run deterministically: entities added by type, new state
      changes, perf counts), memory growth (perf memory_mb) and entities piling up, frames getting slower. Timing is
      NOT deterministic: re-run before trusting a small change. --expect "p95 < 8", "spikes == 0", "!memoryGrows".
  motion [frame.png ...]  |  motion --at 1 --time 0.5 [--input ...] [--region x,y,w,h]
      every moving object, tracked frame to frame: its speed, net move, jitter (px off a smooth path: steady motion
      and smooth acceleration give 0), stutters (a repeated frame, a double step), flicker (gone for a few frames),
      frames where it merged with something (left out of the steps); things that appear or vanish without moving
      are listed apart. A moving camera is detected (per-frame scroll, jitter, uneven steps like "f30 [3,0] instead
      of ~[2,0]") and removed, so object motion is in world pixels. Prints one object's frames (--track N, or
      --near x,y). Drives the game and screenshots every frame (needs 'reset': one pass for the camera and the
      background, one to measure), or reads PNG files.
      --background auto|first|median|<file.png>  (auto: median for 8+ frames; median needs movers to move their own
      size) · --camera auto|static|moving|state (state: the game's state.camera, exact) · --min-size 6 (smallest object, px) · --threshold 16`,
  doctor: `witness doctor [--time 3] [--device iphone-15] [--engine webkit] [--no-auto-unlock] [--safe-insets]
              [--safe-overlay] [--scale-rect "name=x,y,w,h; ..."]
  Checks the connection, protocol, step/snapshot, screenshot and audio, and determinism: a scripted run (--time s), a
  different "dirty" run, then the first run again in the same process; state, digest, screenshot and audio must match.
  For long game-specific scenarios (journeys, fights) use test steps with "match", or witness test --repeat 2.
  Browser games also get: the engine and device; the page (CSS viewport, DPR, screen, touch points, platform; ⚠ a
  touch profile reporting < 2 touch points); safe areas (--safe-insets emulates them; else the measure ui --safe preset to check); how
  the main canvas lands on the screen (backing size → CSS box → device px: an exact ×k, a fractional scale with
  uneven pixels and the exact share drawn wider, or smoothing blur, from the layout; the capture at device pixels
  confirms it, or says it couldn't be read; a picture with two scales, e.g. a ×5 world under a ×4.11 UI layer, is
  read region by region, named from state.layers [{name, rect}] or state.ui, and compared with the layout region that
  matches it; --scale-rect reads rects in canvas px one by one); with --safe-insets whether the insets were emulated,
  how many env() uses were rewritten (distinct places), ⚠ any it couldn't rewrite and a page without viewport-fit=cover; WebGL 1/2 in the engine, its renderer (SwiftShader = software) and the
  context the game's canvas draws with; the AudioContexts and the audio policy. With
  --no-auto-unlock it first checks the iPhone unlock: audio suspended at start, then a tap at the canvas centre, a
  click, space and enter, and which one resumed it (or ⚠ it stayed suspended: silent on iPhone; or ⚠ no AudioContext
  was created: open audio in witness mode too, adapters/cpp/GUIDE.md §13).`,
};

// ------------------------------------------------------------------ args & output
// ------------------------------------------------------------------ commands
const commands = {
  async doctor(pos, opt) {
    const scaleRects = opt["scale-rect"] && opt["scale-rect"] !== true ? parseNamedRects(opt["scale-rect"], "--scale-rect") : null;
    const report = [];
    const ok = (m) => report.push(`✔ ${m}`), bad = (m) => report.push(`✖ ${m}`), warn = (m) => report.push(`⚠ ${m}`);
    const mark = ([m, t]) => report.push(m ? `${m} ${t}` : `  ${t}`);
    let webSummary = null;
    await withGame(opt, async (s, cfg, root) => {
      const h = s.hello;
      ok(`connected over ${s.conn.kind}: "${h.name}" (${h.engine || "?"}, ${h.language || "?"}), protocol ${h.protocol}, ${s.fps} fps${h.size ? `, ${h.size.join("×")}` : ""}`);
      if (h.protocol !== 1) warn(`protocol ${h.protocol} — this CLI speaks v1`);
      const caps = h.capabilities || [];
      const all = ["reset", "step", "input", "snapshot", "screenshot", "audio", "call", "eval", "logs", "perf"];
      report.push(`  capabilities: ${all.map((c) => (caps.includes(c) ? c : `(${c})`)).join(" ")}`);
      if (caps.includes("input")) report.push(`  touch: ${h.touch ? "native (hello.touch: finger events only, no mouse fallback)" : "finger 0 also arrives as the mouse (set hello.touch if the game handles touch itself)"}`);
      for (const need of ["step", "snapshot"]) if (!caps.includes(need)) bad(`missing required capability '${need}'`);
      if (!caps.includes("reset")) warn("no 'reset': witness test restarts the game for each test (slower); commands that compare several runs in one process (window, effect, ab, heatmap over several runs, measure motion/registration/figure, measure steps in tests, this determinism check) need it");
      if (h.calls && h.calls.length) report.push(`  calls: ${h.calls.map((c) => `${c.name}${c.args ? ` ${c.args}` : ""}`).join(" · ")}`);
      // browser launches: the engine and device; with --no-auto-unlock the audio unlock probe runs first (an unlock
      // lasts for the page's life, as in a browser, so it must happen before the determinism runs compare audio)
      if (s.web) {
        report.push(`  ${describeWeb(s.web)}`);
        webSummary = { engine: s.web.engine, device: s.web.device ? s.web.device.name : null, policy: s.web.policy };
        if (s.web.policy === "gesture") { const p = await unlockProbe(s); p.forEach(mark); webSummary.unlock = p[0] ? p[0][1] : null; const none = p.some(([, t]) => /no AudioContext was created/.test(t)); webSummary.audioLocked = none ? null : p.some(([, t]) => /stayed SUSPENDED/.test(t)); if (none) webSummary.noAudioContext = true; }
      }
      // step + snapshot
      const st = await begin(s, { seed: 1 });
      await stepTo(s, st, 30);
      const a = await s.snapshot();
      ok(`step 30 frames → frame ${a.frame}, t=${fmtT(a.time ?? 0)}`);
      const keys = keyPaths(a.state || {});
      ok(`snapshot has ${keys.length} fields${(a.state || {}).entities ? `, ${(a.state.entities || []).length} entities` : " (tip: expose state.entities = [{id, type, pos}] to unlock count()/first()/near())"}`);
      // determinism: run A, a different "dirty" run B, then A again in the same process. A must repeat exactly:
      // state, digest, screenshot and audio. The dirty run in between catches state that leaks across resets
      // (timers, id counters, caches, particle clocks, UI state) that two back-to-back runs can miss.
      let detAudio = null;   // the determinism runs' audio, reused by the audio check below
      if (caps.includes("reset") && caps.includes("input")) {
        const T = Math.max(0.5, +(opt.time || 3));
        const scriptA = "right@0.1-1.2, space@0.3, up@1.3-1.8, mouse:100,100@0.5, click:120,90@0.8, left@1.9-2.4, down@2.5-2.9, space@2.6";
        const scriptB = "left@0.1-0.9, down@0.4-1.4, click:60,40@0.6, right@1.5-2.6, space@1.1, up@2.7-3";
        const matcher = new Matcher();
        const exactAudio = caps.includes("audio") && h.audio_exact !== false;
        if (caps.includes("audio") && !exactAudio) report.push("  (hello says audio_exact: false — audio follows real time here, so it isn't compared)");
        const run = async (seed, input) => {
          const st2 = await begin(s, { seed, input });
          if (caps.includes("audio")) await s.audio();
          await stepTo(s, st2, Math.round(T * s.fps));
          const cap = { snap: await s.snapshot() };
          if (caps.includes("screenshot")) { try { cap.shot = await s.screenshot(); } catch { /* reported below */ } }
          if (caps.includes("audio")) { try { const au = await s.audio(); if (au && au.data && exactAudio) cap.audio = au; } catch { /* reported below */ } }
          return cap;
        };
        const first = await run(7, scriptA);
        detAudio = first.audio || null;
        await matcher.check("A", first, "run A");
        await run(11, scriptB);
        const r = await matcher.check("A", await run(7, scriptA), "run A again");
        const covered = ["state", digestOf(first.snap) != null ? "digest" : null, first.shot ? "screenshot" : null, first.audio ? "audio" : null].filter(Boolean).join(", ");
        if (r.ok) ok(`deterministic over ${T}s: the same seed + input gave identical ${covered}, even after a different run in between`);
        else {
          bad("NOT deterministic: run A repeated after a different run gave a different result (see docs/PROTOCOL.md §6)");
          for (const p of r.problems) report.push(`    ${p}`);
          report.push("    tip: look for unseeded RNGs, wall-clock reads, threads, and state a reset doesn't clear (timers, id counters, caches, UI)");
        }
        if (digestOf(first.snap) == null) report.push("  tip: add a snapshot \"digest\" (a hash of the full internal state) so hidden state is compared too");
        report.push(`  for long scenarios (journeys, fights, menus): add "match" steps to tests, or run  witness test --repeat 2${configFlag(opt)}`);
      }
      if (caps.includes("screenshot")) {
        try { const sh = await s.screenshot(); ok(`screenshot ${sh.width ?? "?"}×${sh.height ?? "?"} (${sh.format || (sh.path ? "file" : "?")})`); }
        catch (e) { bad(`screenshot failed: ${e.message}`); }
      }
      if (caps.includes("audio")) {
        try {
          const fresh = await s.audio();
          const au = fresh && fresh.data && Buffer.from(fresh.data, "base64").length ? fresh : detAudio || fresh;
          const n = au.data ? Buffer.from(au.data, "base64").length / ((au.format === "s16" ? 2 : 4) * (au.channels || 1)) : 0;
          const want = (a.time ?? 0.5) * (au.sampleRate || 44100);
          ok(`audio ${au.sampleRate} Hz × ${au.channels} ch, ${au.format}${n ? ` (${n} frames)` : ""}`);
          if (n === 0) warn("audio returned no samples — make sure the mixer writes into the capture buffer in witness mode");
          void want;
        } catch (e) { bad(`audio failed: ${e.message}`); }
      }
      if (s.web) {
        const m = await media();
        // the game's own names for the picture's layers: state.layers [{name, rect}] (or state.ui elements), canvas px
        let layers = [];
        try { layers = stateLayers(((await s.snapshot()) || {}).state); } catch { /* no snapshot: unnamed regions */ }
        const d = await displayReport(s.web, m, { layers, scaleRects, cfgFlag: configFlag(opt) });
        d.lines.forEach(mark);
        if (d.safe) webSummary.safe = d.safe;
        const wg = await webglReport(s.web, d.info);
        wg.lines.forEach(mark);
        if (wg.summary) webSummary.webgl = wg.summary;
        if (d.display) webSummary.display = { scale: d.display.scale, problem: d.display.problem, pixels: d.display.pixels };
        if (s.web.policy === "auto") (await audioReport(s.web)).forEach(mark);
        const au = await s.web.audio();
        if (au) webSummary.audio = { state: au.state, contexts: au.contexts.length, blocked: au.blocked };
      }
      // every run's logs (read before each reset, which may clear the adapter's buffer)
      const logs = await s.drainLogs();
      if (logs.some((l) => l.level === "error")) warn(`the game logged ${logs.filter((l) => l.level === "error").length} error(s) during the checks: ${logs.filter((l) => l.level === "error").slice(0, 3).map((l) => `${l.frame != null ? `f${l.frame} ` : ""}${String(l.message).slice(0, 100)}`).join(" · ")}`);
      // project copies of the skills (witness init without the plugin) go stale when Witness updates
      const { staleSkillCopies } = await import("../src/core/init.js");
      for (const c of staleSkillCopies(root, VERSION)) warn(`${path.relative(root, c.file)} is a stale copy of the Witness skill (${c.why}): delete its folder; with the Witness plugin installed that's all (the plugin provides the skill), else run  witness init  again to write a fresh copy (files that exist are kept)`);
    });
    const failed = report.some((l) => l.startsWith("✖"));
    if (opt.json) printJSON(envelope("doctor", { ok: !failed, verdict: failed ? "doctor found problems" : "all good", summary: { problems: report.filter((l) => l.startsWith("✖")).length, warnings: report.filter((l) => l.startsWith("⚠")).length, deterministic: report.some((l) => /^✔ deterministic/.test(l)) ? true : report.some((l) => /NOT deterministic/.test(l)) ? false : null, ...(webSummary ? { web: webSummary } : {}) }, data: { lines: report } }));
    else {
      console.log(report.join("\n"));
      console.log(failed ? "doctor found problems" : "all good — Witness can drive this game");
    }
    process.exit(failed ? 1 : 0);
  },

  async clean(pos, opt) {
    const { cfg, root } = loadConfig(opt);
    const only = opt.playtests ? "playtests" : opt.replays ? "replays" : opt.shots ? "shots" : opt.movies ? "movies" : null;
    const r = prune(cfg, root, { all: !!opt.all, only });
    const k = only && only !== "playtests" ? 0 : pruneRegistry();
    if (opt.json) { printJSON(envelope("clean", { verdict: `removed ${r.removed.length} item(s)`, summary: { removed: r.removed.length, bytes: r.bytes }, data: { removed: r.removed, bytes: r.bytes, registry: k, warnings: r.warnings } })); return; }
    for (const w of r.warnings) console.log(`⚠ ${w}`);
    console.log(r.removed.length ? `removed ${r.removed.length} item(s), ${fmtBytes(r.bytes)}:` : "nothing to remove");
    for (const p of r.removed.slice(0, 20)) console.log(`  ${path.relative(root, p) || p}`);
    if (r.removed.length > 20) console.log(`  … and ${r.removed.length - 20} more`);
  },

  async test(pos, opt) {
    const { cfg, root } = loadConfig(opt);
    // best effort: old playtests, recordings and generated screenshots (never witness/refs); said, so nothing vanishes silently
    try {
      const pr = prune(cfg, root);
      if (pr.removed.length) say(`▸ cleaned up ${pr.removed.length} old generated file${pr.removed.length === 1 ? "" : "s"} (${fmtBytes(pr.bytes)}; witness.json "retention", see 'witness help clean'): ${pr.removed.slice(0, 3).map((p) => path.relative(root, p) || p).join(", ")}${pr.removed.length > 3 ? ", …" : ""}`);
      for (const w of pr.warnings) say(`⚠ ${w}`);
    } catch { /* best effort */ }
    const files = findTestFiles(root, cfg, pos);
    if (!files.length) die(`no test files found (looked for *.witness.json / *.witness.mjs in ${path.resolve(root, cfg.tests)})`);
    let tests = [];
    for (const f of files) tests.push(...(await loadTests(f)));
    if (opt.name) tests = tests.filter((t) => t.name.toLowerCase().includes(String(opt.name).toLowerCase()));
    if (!tests.length) die(`no test matches '${opt.name}'`);
    const results = [];
    const shotDir = path.resolve(root, cfg.shots);
    const repeat = Math.max(1, Math.floor(+(opt.repeat === true ? 2 : opt.repeat || 1)));
    const matcher = new Matcher();
    const matchMedia = { shot: !opt["no-shots"], audio: !opt["no-audio"] };
    const schedule = [];
    for (let p = 1; p <= repeat; p++) for (const t of tests) schedule.push(repeat > 1 ? { ...t, name: `${t.name}  [pass ${p}/${repeat}]`, _lastPass: p === repeat } : t);
    await withGame(opt, async (s, c, r, g) => {
      // without 'reset', every test after the first gets a fresh game process (docs/PROTOCOL.md §3); a game Witness
      // didn't launch (--attach) can't be restarted, so only one test can run on it
      const restart = !s.has("reset") && schedule.length > 1;
      if (restart && (opt.attach || (c.launch && c.launch.attach))) die(`the adapter has no 'reset' and the game was attached (--attach), so Witness can't restart it between tests: run one test at a time (--name, no --repeat), or add 'reset' to the adapter`);
      if (restart) say(`▸ the adapter has no 'reset': each test runs in a fresh game process (slower)`);
      for (const [i, t] of schedule.entries()) {
        if (restart && i > 0) {
          try { s = await g.restart(); }
          catch (e) { results.push({ name: t.name, file: t.file, ok: false, expects: { passed: 0, failed: 0 }, failures: [{ kind: "error", message: `couldn't restart the game: ${e.message}` }] }); if (!opt.json) printTest(results[results.length - 1], root); break; }
        }
        let res;
        try { res = await runTest(s, t, { shotDir, onShot: writeShot, matcher, matchAll: repeat > 1, matchMedia }); }
        catch (e) { forgetDie(e); res = { name: t.name, file: t.file, ok: false, expects: { passed: 0, failed: 0 }, failures: [{ kind: "error", message: e.message }] }; }
        results.push(res);
        for (const f of res.shots || []) markGenerated(shotDir, f);
        if (!opt.json) printTest(res, root);
        if (s.closed) {
          if (!opt.json) console.log("✖ the game crashed or disconnected — remaining tests skipped");
          if (!opt.json) { const tail = g.output().trim().split("\n").slice(-12).join("\n"); if (tail) console.log(`--- last game output ---\n${tail}`); }
          break;
        }
      }
    });
    const failed = results.filter((r) => !r.ok).length;
    if (opt.json) printJSON(envelope("test", { ok: !failed, verdict: `${results.length - failed} passed, ${failed} failed`, summary: { passed: results.length - failed, failed, expects: results.reduce((a, x) => a + (x.expects ? x.expects.passed + x.expects.failed : 0), 0) }, data: { results } }));
    else {
      if (repeat > 1) {
        const diverged = results.some((x) => (x.failures || []).some((f) => f.kind === "match" && f.message.startsWith("repeat:")));
        console.log(diverged ? `✖ passes 2..${repeat} did not repeat pass 1 exactly (see the "repeat:" lines)` : `✔ all ${repeat} passes were identical at every step`);
      }
      console.log(`${results.length - failed} passed, ${failed} failed`);
    }
    process.exit(failed ? 1 : 0);
  },

  eval: evalCommand,
  trace: traceCommand,
  heatmap: heatmapCommand,

  shot: shotCommand,

  listen: listenCommand,

  measure: measureCommand,
  effect: effectCommand,
  window: windowCommand,
  ab: abCommand,

  async replay(pos, opt) {
    await withGame(opt, async (s, cfg, root) => {
      const r = loadReplay(resolveReplay(pos[0] || "last", cfg, root));
      console.log(`▶ replay ${path.basename(r.file)}: ${r.frames} frames, ${fmtT(r.duration)}, seed ${r.seed}${r.marks.length ? `, marks: ${r.marks.map((m) => `${m.label}@${fmtT(m.t)}`).join(" ")}` : ""}`);
      // a playtest records the browser it ran in: another device means another viewport (touch points, layout)
      if (r.launch && s.web) {
        const now = { engine: s.web.engine, device: s.web.device ? s.web.device.name : null };
        const txt = (l) => `${l.engine} · ${l.device || "desktop"}`;
        if (now.engine !== r.launch.engine || now.device !== r.launch.device) console.log(`⚠ recorded on ${txt(r.launch)}, replaying on ${txt(now)}: the viewport differs (touch coordinates, layout); add${r.launch.device ? ` --device ${r.launch.device}` : " --device none"} --engine ${r.launch.engine}`);
      }
      const st = await begin(s, { replay: r });
      const frames = opt.at ? timeList(opt.at, []).map((t) => framesOf(t, s.fps, r.dts)) : [...r.marks.map((m) => m.frame), r.frames];
      const watch = opt.watch ? splitTop(String(opt.watch)) : [];
      const needPrev = watch.some(usesPrev);
      const endFile = `${r.file}.state.json`;   // written by adapters/games at the end of a recording (optional)
      // state paths left out of the end-state check (window-dependent fields and the like): witness.json replay.ignore + --ignore
      const ignore = [...(cfg.replay && Array.isArray(cfg.replay.ignore) ? cfg.replay.ignore : []), ...(opt.ignore && opt.ignore !== true ? splitTop(String(opt.ignore)) : [])];
      const skip = ignore.length ? pathFilter(ignore) : null;
      let endChecked = false;
      for (const f of [...new Set(frames)].sort((a, b) => a - b)) {
        let prev = null;
        if (needPrev && f > 0) { await stepTo(s, st, f - 1, r.dts); prev = await s.snapshot(); }
        await stepTo(s, st, f, r.dts);
        const snap = await s.snapshot();
        const t = snap.time ?? st.time;
        if (st.frame >= r.frames && !endChecked && fs.existsSync(endFile)) {
          endChecked = true;
          let want;
          try { want = JSON.parse(fs.readFileSync(endFile, "utf8")); } catch (e) { console.log(`⚠ can't read ${path.basename(endFile)}: ${e.message}`); }
          if (want !== undefined) {
            // the file holds a snapshot ({frame, time, state}) or just the state
            const wantState = want && typeof want === "object" && "state" in want && ("frame" in want || "time" in want) ? want.state : want;
            const d = diffValues(wantState, snap.state, "state", [], 20, skip);
            if (!d.length) console.log(`✔ the replay ended in exactly the recorded end state (${path.basename(endFile)})${ignore.length ? ` (ignoring ${ignore.join(", ")})` : ""}`);
            else {
              console.log(`✖ the replay's end state differs from the recording's (${path.basename(endFile)}) at ${d.length >= 20 ? "20+" : d.length} path(s):`);
              for (const x of d.slice(0, 12)) console.log(`    ${x.path}: recorded ${String(JSON.stringify(x.a)).slice(0, 80)} → replayed ${String(JSON.stringify(x.b)).slice(0, 80)}`);
              process.exitCode = 1;
            }
          }
        }
        console.log(summarizeState(snap));
        for (const x of watch) { let v; try { v = fmt(evaluate(x, snap, prev), 120); } catch (e) { v = `✖ ${e.message}`; } console.log(`   ${x} = ${v}`); }
        if (opt.shot && s.has("screenshot")) {
          const file = path.resolve(root, cfg.shots, `replay-${String((+t).toFixed(2)).replace(".", "_")}.png`);
          await writeShot(await s.screenshot(), file);
          console.log(`   → ${file}`);
        }
      }
      printLogs(await s.drainLogs());
    });
  },

  replays(pos, opt) {
    const { cfg, root } = loadConfig(opt);
    const dir = path.resolve(root, cfg.replays);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs) : [];
    if (!files.length) { console.log(`no replays in ${dir} — play the game with WITNESS_RECORD=${path.join(cfg.replays, "session.jsonl")} set (press F8 to mark moments)`); return; }
    files.forEach((f, i) => { try { const r = loadReplay(f, { quiet: true }); console.log(`  #${i + 1} ${path.basename(f)}  ${fmtT(r.duration)}  seed ${r.seed}${r.marks.length ? `  marks: ${r.marks.map((m) => `${m.label}@${fmtT(m.t)}`).join(" ")}` : ""}${r.warnings.length ? "  (cut short: the last line is incomplete)" : ""}`); } catch (e) { console.log(`  #${i + 1} ${path.basename(f)}  (unreadable: ${e.message})`); } });
  },

  async call(pos, opt) {
    const [name, ...args] = pos;
    if (!name) die("usage: witness call <name> [args...] [--at 1]");
    await withGame(opt, async (s, cfg) => {
      if (!s.has("call")) die("this game's adapter doesn't support 'call'");
      const st = await begin(s, runOpts(opt, cfg));
      await stepTo(s, st, framesOf(opt.at && opt.at !== true ? String(opt.at) : "0.5", s.fps));
      const r = await s.call(name, args.map((a) => (/^-?\d+(\.\d+)?$/.test(a) ? +a : a)));
      console.log(`✔ ${name}(${args.join(", ")}) → ${fmt(r.result, 300)}`);
      await stepTo(s, st, st.frame + 1);
      console.log(summarizeState(await s.snapshot()));
      printLogs(await s.drainLogs());
    });
  },

  async raw(pos, opt) {
    await withGame(opt, async (s) => {
      console.log(`hello: ${JSON.stringify(s.hello)}`);
      for (const p of pos) {
        let msg;
        try { msg = JSON.parse(p); } catch { msg = { cmd: p }; }
        const { cmd, ...args } = msg;
        try { const r = await s.request(cmd, args); console.log(JSON.stringify(r).slice(0, 4000)); }
        catch (e) { console.log(`✖ ${e.message}`); }
      }
    });
  },

  async init(pos, opt) {
    const { init } = await import("../src/core/init.js");
    await init(pos[0] ? path.resolve(pos[0]) : process.cwd(), opt, ROOT);
  },

  async adapters() {
    const { listAdapters } = await import("../src/core/init.js");
    for (const a of listAdapters(ROOT)) console.log(`  ${a.id.padEnd(14)} ${a.title}${a.verified ? "" : "  (unverified)"}`);
  },

  async play(pos, opt) {
    const { playCommand } = await import("../src/play/client.js");
    await playCommand(pos[0], pos.slice(1), opt, { loadConfig, ROOT });
  },

  async help(pos) {
    if (pos[0] === "play") { const { PLAY_HELP } = await import("../src/play/client.js"); console.log(PLAY_HELP); return; }
    console.log(pos[0] && CMD_HELP[pos[0]] ? CMD_HELP[pos[0]] : HELP);
  },
  version() { console.log(VERSION); },
};

function printTest(res, root) {
  const rel = res.file ? path.relative(root, res.file) : "";
  const ex = res.expects || { passed: 0, failed: 0 };
  console.log(`${res.ok ? "✔ pass" : "✖ FAIL"}  ${res.name}  (${ex.passed} expect${ex.passed === 1 ? "" : "s"} passed${ex.failed ? `, ${ex.failed} failed` : ""})${rel ? `  ${rel}` : ""}`);
  for (const f of res.failures || []) {
    if (f.kind === "warn") console.log(`    ⚠ ${f.message}`);
    else console.log(`    ${f.kind === "expect" ? `expect failed at ${f.at}${/^-?[\d.]+$/.test(String(f.at)) ? "s" : ""}:` : "✖"} ${f.message}`);
  }
  for (const [p, vals] of Object.entries(res.probes || {})) console.log(`    probe ${p}: ${vals.map(([t, v]) => `${fmtT(t)}=${fmt(v, 40)}`).join("  ")}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const { pos, opt } = parseArgs(rest, cmd);
CLI.json = !!opt.json;
hint.flags = configFlag(opt);   // printed follow-up commands load the same config, device and engine
try {
  if (!cmd || cmd === "-h" || cmd === "--help") commands.help([]);
  else if (cmd === "-v" || cmd === "--version") commands.version();
  else if (commands[cmd] && (opt.help || pos[0] === "--help")) await commands.help([cmd]);
  else if (commands[cmd]) await commands[cmd](pos, opt);
  else die(`unknown command '${cmd}'\n\n${HELP}`);
} catch (e) {
  if (e instanceof DieError) { console.error(`✖ ${e.message}`); process.exit(e.code); }
  if (e instanceof WitnessError || e instanceof ExprError) die(e.message);
  throw e;
}
