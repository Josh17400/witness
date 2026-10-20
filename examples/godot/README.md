# coins: Godot 4 example (autoload `Witness.gd`)

The standard Witness sample game (see `docs/ADAPTERS.md`), written the ordinary Godot way in
`main.gd`: InputMap actions read with `Input.get_axis` in `_physics_process`, `_draw()` for
rendering, and an `AudioStreamPlayer` on the Master bus for the ding. The Witness-specific
parts are the `"witness"` group, `witness_state()`, the `witness_call_teleport` /
`witness_call_addcoin` methods, and seeding from `Witness.seed`. Reset reloads the scene: no
code needed.

`addons/witness/` is a copy of `adapters/godot/` (Godot can only load scripts inside the
project). CI fails if the copy drifts.

## Run and verify (Godot 4.2+, tested with 4.7.2)

```
godot --path .                           # play: arrows/WASD
node ../../bin/witness.js doctor
node ../../bin/witness.js test
```

`witness.json` launches
`godot --path . --rendering-driver opengl3 --fixed-fps 60 --write-movie witness/movies/witness.avi`:

* `--fixed-fps 60`: one engine iteration = one exact 1/60 s step (required);
* `--write-movie`: Movie Maker mode, so audio is mixed frame-by-frame: each `audio` reply is
  exactly the simulated time long and the same run gives byte-identical audio after any other
  (an MJPEG AVI in `witness/movies/`, tens of MB per minute, overwritten each launch; Godot
  creates no folders, so the folder and its `.gdignore` are kept in git, and `witness clean` prunes the movies);
* a real renderer, for screenshots. The window is borderless and moved off-screen.

If `godot` isn't on PATH (Windows), pass the console binary:
`--cmd "\"C:\path\Godot_v4.7.2-stable_win64_console.exe\" --path . --rendering-driver opengl3 --fixed-fps 60 --write-movie witness/movies/witness.avi"`.
Quick headless check, with no screenshots and no synced audio:
`--cmd "godot --path . --headless --fixed-fps 60"`.

## Record and replay

```
WITNESS_RECORD=witness/replays/demo.jsonl WITNESS_SEED=4 godot --path . --headless -- --demo
node ../../bin/witness.js replay witness/replays/demo.jsonl --watch "state.player.pos[0].toFixed(4)"
```

`--demo` is a scripted 2-second session (hold right from 0 to 1.2 s, F8 at 0.5 s) whose key
events go through `Input.parse_input_event`, so the recorder sees them like a human's. The
replay ends on exactly the x position the demo prints. The demo calls `Witness.stop_recording()`
before it quits, which writes the recording's end state (`demo.jsonl.state.json`): the replay
then says it ended in exactly that state.
