# Changelog

Each release lists what changed and **Adoption steps**: what a game that already uses Witness has to do (or may do)
to pick it up. Steps marked *optional* unlock new features; everything else keeps working without them.

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
