extends Node
## Witness adapter for Godot 4 (protocol v1). Register as the autoload "Witness".
##
## Witness lets an outside tool (the `witness` CLI) drive the game deterministically: reset it
## with a seed, feed it input on exact frames, step it at a fixed dt, and read back its state,
## screenshots, audio and logs. See docs/PROTOCOL.md in the Witness repo and GUIDE.md here.
##
## Game-side conventions (all optional):
##   * Nodes in the group "witness" may define
##       witness_state() -> Dictionary     merged into the snapshot ("entities" arrays are concatenated)
##       witness_reset(seed, scene, params) called after every reset (re-seed private RNGs here)
##       witness_call_<name>(args...)       a custom command, advertised as <name>
##   * Nodes in the group "witness_entities" are listed automatically in state.entities as
##     {"id", "type", "pos"} (id = meta "witness_id" or the node name, type = meta "witness_type"
##     or the class name).
##   * Witness.seed is the seed to use for randomness (from reset, or the replay when recording).
##
## Launch for exact timing:  godot --path . --fixed-fps 60
## ...plus frame-exact audio: --rendering-driver opengl3 --write-movie user://witness.avi
## When WITNESS_ADDR is unset and --witness wasn't passed, this node disables itself: zero cost.

const PROTOCOL := 1
const DEFAULT_ADDR := "127.0.0.1:7357"

## True while the CLI drives the game.
var active := false
## True when a human plays with WITNESS_RECORD=<file.jsonl> set.
var recording := false
## The seed to feed every random generator.
@warning_ignore("shadowed_global_identifier")
var seed := 1
## Frame being simulated (inside physics/process) or about to be simulated.
var frame := 0
## Simulated seconds since reset.
var time := 0.0
## Reload the current scene on reset (set false if your nodes implement witness_reset fully).
var reload_on_reset := true

var _peer: StreamPeerTCP
var _ws: WebSocketPeer
var _blocking := true          # desktop: block inside the frame while idle; web: pause instead
var _buf := PackedByteArray()
var _queue: Array = []         # pending protocol input events
var _due: Array = []           # events applied this frame
var _held_keys := {}           # Key -> true
var _held_buttons := {}        # MouseButton -> true
var _held_actions := {}        # action -> true
var _mouse := Vector2.ZERO
var _logs: Array = []
var _log_mutex := Mutex.new()
var _logger: Object
var _calls := {}               # name -> {callable, args, help} registered with add_call()
var _fps := 60
var _remaining := 0            # frames left in the current step
var _step_id = null
var _step_frames := 1
var _step_started := false
var _connected := false
var _hello_sent := false
var _closing := false
var _reset_pending: Dictionary = {}
var _old_scene_id := 0
var _flush_iterations := 0
var _dirty := true             # state changed since the last rendered frame
var _capture: AudioEffectCapture
var _warned := {}
var _perf := {"frame_ms": 0.0, "update_ms": 0.0, "render_ms": 0.0}
var _step_t0 := 0
var _recorder: FileAccess
var _rec_frame := 0
var _rec_events: Array = []
var _rec_mark := ""

const _KEYS := {
	"enter": KEY_ENTER, "escape": KEY_ESCAPE, "space": KEY_SPACE, "tab": KEY_TAB,
	"backspace": KEY_BACKSPACE, "shift": KEY_SHIFT, "ctrl": KEY_CTRL, "alt": KEY_ALT,
	"left": KEY_LEFT, "right": KEY_RIGHT, "up": KEY_UP, "down": KEY_DOWN, "delete": KEY_DELETE,
	"home": KEY_HOME, "end": KEY_END, "pageup": KEY_PAGEUP, "pagedown": KEY_PAGEDOWN,
	"insert": KEY_INSERT, "meta": KEY_META,
}
const _PAD := {
	"a": JOY_BUTTON_A, "b": JOY_BUTTON_B, "x": JOY_BUTTON_X, "y": JOY_BUTTON_Y,
	"back": JOY_BUTTON_BACK, "guide": JOY_BUTTON_GUIDE, "start": JOY_BUTTON_START,
	"leftstick": JOY_BUTTON_LEFT_STICK, "rightstick": JOY_BUTTON_RIGHT_STICK,
	"leftshoulder": JOY_BUTTON_LEFT_SHOULDER, "rightshoulder": JOY_BUTTON_RIGHT_SHOULDER,
	"dpup": JOY_BUTTON_DPAD_UP, "dpdown": JOY_BUTTON_DPAD_DOWN,
	"dpleft": JOY_BUTTON_DPAD_LEFT, "dpright": JOY_BUTTON_DPAD_RIGHT,
}
const _AXES := {
	"leftx": JOY_AXIS_LEFT_X, "lefty": JOY_AXIS_LEFT_Y, "rightx": JOY_AXIS_RIGHT_X,
	"righty": JOY_AXIS_RIGHT_Y, "lefttrigger": JOY_AXIS_TRIGGER_LEFT,
	"righttrigger": JOY_AXIS_TRIGGER_RIGHT,
}


func _enter_tree() -> void:
	active = OS.get_environment("WITNESS_ADDR") != "" or "--witness" in OS.get_cmdline_user_args() \
		or _web_param() != ""
	recording = not active and OS.get_environment("WITNESS_RECORD") != ""
	if not active and not recording:
		set_physics_process(false)
		set_process(false)
		return
	process_mode = Node.PROCESS_MODE_ALWAYS
	process_priority = -1000000          # run before every other node, each frame
	process_physics_priority = -1000000
	_fps = Engine.physics_ticks_per_second
	if recording:
		var env_seed := OS.get_environment("WITNESS_SEED")
		seed = int(env_seed) if env_seed != "" else int(Time.get_unix_time_from_system()) % 1000000 + 1
	globalscope_seed(seed)


func _ready() -> void:
	if recording:
		_start_recording()
		return
	if not active:
		return
	if ClassDB.class_exists("Logger"):   # Godot 4.5+: forward engine/script errors to Witness
		var script := load(get_script().resource_path.get_base_dir().path_join("witness_logger.gd"))
		if script:
			_logger = script.new(self)
			OS.call("add_logger", _logger)
	if DisplayServer.get_name() != "headless" and OS.get_environment("WITNESS_SHOW_WINDOW") == "":
		# keep the window out of the user's way; it must stay "visible" (not minimized), or
		# Godot stops rendering and screenshots go stale. WITNESS_SHOW_WINDOW=1 to watch.
		DisplayServer.window_set_flag(DisplayServer.WINDOW_FLAG_BORDERLESS, true)
		DisplayServer.window_set_position(Vector2i(-10000, -10000))
	_capture = AudioEffectCapture.new()
	_capture.buffer_length = 30.0
	AudioServer.add_bus_effect(0, _capture)


func _exit_tree() -> void:
	if _logger:
		OS.call("remove_logger", _logger)
	if _recorder:
		_recorder.close()


## Seed Godot's global RNG (randi/randf/randomize-free code paths).
func globalscope_seed(value: int) -> void:
	seed(value)


# ------------------------------------------------------------------------------ logging

## Send a log line ("info" | "warn" | "error"); errors fail Witness tests. No-op when inactive.
func log_line(level: String, message: String) -> void:
	if not active:
		return
	if level == "warning":
		level = "warn"
	if level != "warn" and level != "error":
		level = "info"
	_log_mutex.lock()
	_logs.append({"frame": frame, "level": level, "message": message})
	if _logs.size() > 10000:
		_logs.pop_front()
	_log_mutex.unlock()


func info(message: String) -> void:
	log_line("info", message)


func warn(message: String) -> void:
	log_line("warn", message)


func error(message: String) -> void:
	log_line("error", message)


func _warn_once(key: String, message: String) -> void:
	if not _warned.has(key):
		_warned[key] = true
		log_line("warn", message)


# ------------------------------------------------------------------------------ public helpers

## Register a custom command (alternative to witness_call_<name> methods).
func add_call(name: String, callable: Callable, args := "", help := "") -> void:
	_calls[name] = {"callable": callable, "args": args, "help": help}


## Events applied at the current frame (for code that pulls input instead of using InputMap).
func input_events() -> Array:
	return _due


## Flag the current moment in the replay (F8 does this automatically while recording).
func mark(label := "F8") -> void:
	_rec_mark = label


# ------------------------------------------------------------------------------ transport

func _web_param() -> String:
	if not OS.has_feature("web"):
		return ""
	var js = Engine.get_singleton("JavaScriptBridge")
	var v = js.eval("new URLSearchParams(location.search).get('witness') || ''", true)
	return str(v) if v != null else ""


func _address() -> Array:
	var addr := OS.get_environment("WITNESS_ADDR")
	if addr == "":
		addr = _web_param()
	if addr == "":
		addr = DEFAULT_ADDR
	var i := addr.rfind(":")
	return [addr.substr(0, i) if i > 0 else "127.0.0.1", int(addr.substr(i + 1))]


func _connect() -> bool:
	var addr := _address()
	if OS.has_feature("web"):
		_blocking = false
		_ws = WebSocketPeer.new()
		if _ws.connect_to_url("ws://%s:%d/" % addr) != OK:
			push_error("Witness: can't open ws://%s:%d/" % addr)
			return false
		return true     # the hello is sent once the socket opens (see _poll_ws)
	_peer = StreamPeerTCP.new()
	var deadline := Time.get_ticks_msec() + 10000
	while Time.get_ticks_msec() < deadline:
		if _peer.get_status() == StreamPeerTCP.STATUS_NONE or _peer.get_status() == StreamPeerTCP.STATUS_ERROR:
			_peer.connect_to_host(addr[0], addr[1])
		_peer.poll()
		if _peer.get_status() == StreamPeerTCP.STATUS_CONNECTED:
			_peer.set_no_delay(true)
			_send({"hello": _hello()})
			return true
		OS.delay_msec(20)
	push_error("Witness: could not reach the CLI at %s:%d" % addr)
	return false


func _send(obj: Dictionary) -> void:
	var line := JSON.stringify(_safe(obj), "", true) + "\n"
	if _ws:
		_ws.send_text(line)
	elif _peer:
		_peer.put_data(line.to_utf8_buffer())


## Returns the next complete command line, "" when none is available yet, or null when closed.
func _read_line():
	if _ws:
		_ws.poll()
		var state := _ws.get_ready_state()
		if state == WebSocketPeer.STATE_CLOSED:
			return null
		if state != WebSocketPeer.STATE_OPEN:
			return ""
		if not _hello_sent:
			_hello_sent = true
			_send({"hello": _hello()})
		if _ws.get_available_packet_count() > 0:
			return _ws.get_packet().get_string_from_utf8()
		return ""
	var nl := _buf.find(10)
	if nl < 0:
		_peer.poll()
		var status := _peer.get_status()
		if status != StreamPeerTCP.STATUS_CONNECTED:
			return null
		var n := _peer.get_available_bytes()
		if n > 0:
			var got: Array = _peer.get_partial_data(n)
			if got[0] != OK:
				return null
			_buf.append_array(got[1])
			nl = _buf.find(10)
	if nl < 0:
		return ""
	var line := _buf.slice(0, nl).get_string_from_utf8()
	_buf = _buf.slice(nl + 1)
	return line

func _hello() -> Dictionary:
	var caps := ["reset", "step", "input", "snapshot", "call", "eval", "logs", "perf", "audio"]
	if DisplayServer.get_name() != "headless":
		caps.append("screenshot")
	var size := get_viewport().get_visible_rect().size
	var info := Engine.get_version_info()
	return {
		"protocol": PROTOCOL,
		"name": str(ProjectSettings.get_setting("application/config/name", "Godot game")),
		"engine": "Godot %s" % info.string, "language": "gdscript", "fps": _fps,
		"size": [int(size.x), int(size.y)], "capabilities": caps, "calls": _call_list(),
	}


# ------------------------------------------------------------------------------ main loop

func _physics_process(_delta: float) -> void:
	if recording:
		_record_physics_frame(_delta)
		return
	if _closing:
		return
	if not _connected:
		_connected = true      # first frame: every node is ready, so calls can be discovered
		if not _connect():
			_closing = true
			get_tree().quit(1)
			return
	if not _reset_pending.is_empty():
		if not _finish_reset():
			return             # the scene change needs another (paused) iteration
	if _remaining > 0:
		if _step_started:
			_end_frame()
		if _remaining > 0:
			_begin_frame()
			return
	_serve()


func _process(delta: float) -> void:
	if not active or _remaining <= 0 or not _step_started:
		return
	if absf(delta - 1.0 / _fps) > 1e-4:
		_warn_once("fixed-fps", "Witness: _process delta is %.5f, not 1/%d: launch Godot with --fixed-fps %d so every frame is exactly one fixed step" % [delta, _fps, _fps])


# One frame finished (its physics, process and render ran since the previous call).
func _end_frame() -> void:
	frame += 1
	time += 1.0 / _fps
	_remaining -= 1
	_dirty = false
	if _remaining == 0:
		_step_started = false
		_perf["update_ms"] = (Time.get_ticks_usec() - _step_t0) / 1000.0 / max(1, _step_frames)
		_perf["frame_ms"] = _perf["update_ms"]
		_send({"id": _step_id, "ok": true, "frame": frame, "time": time})


# A frame starts now: apply its input, then let the rest of the iteration simulate it.
func _begin_frame() -> void:
	_step_started = true
	if get_tree().paused:
		get_tree().paused = false
	_due = []
	var keep := []
	for e in _queue:
		if int(e.get("frame", 0)) <= frame:
			_due.append(e)
		else:
			keep.append(e)
	_queue = keep
	for e in _due:
		_inject(e)
	if not _due.is_empty():
		Input.flush_buffered_events()


# Answer commands until a step starts (desktop: block here; web: pause and come back next frame).
func _serve() -> void:
	while true:
		var line = _read_line()
		if line == null:
			_quit()
			return
		if line == "":
			if not _blocking:
				get_tree().paused = true
				return
			OS.delay_usec(250)
			continue
		var msg = JSON.parse_string(line.trim_prefix("@w"))
		if typeof(msg) != TYPE_DICTIONARY:
			log_line("error", "Witness: unreadable command: %s" % line.left(200))
			continue
		var id = msg.get("id")
		var cmd := str(msg.get("cmd", ""))
		match cmd:
			"step":
				var frames := int(msg.get("frames", 1))
				if frames < 1:
					_send({"id": id, "ok": false, "error": "step needs frames >= 1"})
					continue
				if msg.has("dts") or (msg.has("dt") and absf(float(msg["dt"]) - 1.0 / _fps) > 1e-6):
					_warn_once("dt", "Witness (Godot): frames always advance by the fixed 1/%d s; custom dt/dts are ignored" % _fps)
				_step_id = id
				_remaining = frames
				_step_frames = frames
				_step_t0 = Time.get_ticks_usec()
				_begin_frame()
				return
			"reset":
				if not _start_reset(id, msg):
					return     # a scene (re)load is pending: finish it next frame
				continue
			"quit":
				_send({"id": id, "ok": true})
				_quit()
				return
			_:
				_send(_command(id, cmd, msg))

func _command(id, cmd: String, msg: Dictionary) -> Dictionary:
	var result: Dictionary
	match cmd:
		"input":
			_queue.append_array(msg.get("events", []))
			result = {}
		"snapshot":
			result = {"frame": frame, "time": time, "state": _snapshot()}
		"screenshot":
			if DisplayServer.get_name() == "headless":
				return {"id": id, "ok": false, "error": "no screenshots with --headless (use --rendering-driver opengl3)"}
			result = _screenshot(float(msg.get("scale", 1.0)))
		"audio":
			result = _audio()
		"call":
			result = _call(str(msg.get("name", "")), msg.get("args", []))
			if result.has("error"):
				return {"id": id, "ok": false, "error": result["error"]}
			_dirty = true
		"eval":
			result = _eval(str(msg.get("expr", "")))
			if result.has("error"):
				return {"id": id, "ok": false, "error": result["error"]}
			_dirty = true
		"logs":
			_log_mutex.lock()
			result = {"logs": _logs}
			_logs = []
			_log_mutex.unlock()
		"perf":
			result = _perf.duplicate()
			result["counts"] = {"nodes": get_tree().get_node_count(),
				"objects": int(Performance.get_monitor(Performance.OBJECT_COUNT))}
		_:
			return {"id": id, "ok": false, "error": "unknown command '%s'" % cmd}
	result["id"] = id
	result["ok"] = true
	return result


func _quit() -> void:
	_closing = true
	_remaining = 0
	get_tree().paused = true
	if _peer:
		_peer.disconnect_from_host()
	if _ws:
		_ws.close()
	get_tree().quit()


# ------------------------------------------------------------------------------ reset

## Returns true when the reset completed (or failed) right away, false while a scene loads.
func _start_reset(id, msg: Dictionary) -> bool:
	seed = int(msg.get("seed", 1))
	globalscope_seed(seed)
	_release_all()
	_queue = []
	_due = []
	frame = 0
	time = 0.0
	_reset_pending = {"id": id, "scene": msg.get("scene", ""), "params": msg.get("params", {})}
	var scene := str(_reset_pending["scene"])
	var tree := get_tree()
	_old_scene_id = tree.current_scene.get_instance_id() if tree.current_scene else 0
	_flush_iterations = 0
	if scene != "":
		var path := scene if scene.begins_with("res://") else "res://%s.tscn" % scene
		if tree.change_scene_to_file(path) != OK:
			_reset_pending = {}
			_send({"id": id, "ok": false, "error": "can't load scene '%s'" % path})
			return true
	elif reload_on_reset and tree.current_scene:
		tree.reload_current_scene()
	else:
		_old_scene_id = 0
		return _finish_reset()
	tree.paused = true   # the deferred scene change happens during a frame where nothing simulates
	return false


func _finish_reset() -> bool:
	var tree := get_tree()
	var current := tree.current_scene
	if _old_scene_id != 0 and (current == null or current.get_instance_id() == _old_scene_id or not current.is_node_ready()):
		_flush_iterations += 1
		if _flush_iterations < 30:
			return false
		log_line("error", "Witness: the scene didn't reload within 30 frames")
	globalscope_seed(seed)
	for node in tree.get_nodes_in_group("witness"):
		if node.has_method("witness_reset"):
			node.witness_reset(seed, _reset_pending["scene"], _reset_pending["params"])
	tree.paused = false
	if _capture:
		_capture.clear_buffer()
	_dirty = true
	var id = _reset_pending["id"]
	_reset_pending = {}
	_logs = []
	_send({"id": id, "ok": true})
	return true


func _release_all() -> void:
	for key in _held_keys.keys():
		var e := InputEventKey.new()
		e.keycode = key
		e.physical_keycode = key
		e.pressed = false
		Input.parse_input_event(e)
	for button in _held_buttons.keys():
		var b := InputEventMouseButton.new()
		b.button_index = button
		b.pressed = false
		b.position = _mouse
		b.global_position = _mouse
		Input.parse_input_event(b)
	for action in _held_actions.keys():
		Input.action_release(action)
	_held_keys = {}
	_held_buttons = {}
	_held_actions = {}
	Input.flush_buffered_events()


# ------------------------------------------------------------------------------ input

func _keycode(name: String) -> Key:
	if _KEYS.has(name):
		return _KEYS[name]
	for candidate in [name.to_upper(), name.capitalize(), name]:
		var k := OS.find_keycode_from_string(candidate)
		if k != KEY_NONE:
			return k
	return KEY_NONE


func _inject(e: Dictionary) -> void:
	match str(e.get("type", "")):
		"key":
			var key := _keycode(str(e.get("key", "")))
			if key == KEY_NONE:
				_warn_once("key:" + str(e.get("key")), "Witness: no Godot key named '%s'" % e.get("key"))
				return
			var ev := InputEventKey.new()
			ev.keycode = key
			ev.physical_keycode = key
			ev.pressed = bool(e.get("down", false))
			ev.echo = ev.pressed and _held_keys.has(key)
			var name := str(e["key"])
			if ev.pressed and name.length() == 1:
				ev.unicode = name.unicode_at(0)
			elif ev.pressed and name == "space":
				ev.unicode = 32
			if ev.pressed:
				_held_keys[key] = true
			else:
				_held_keys.erase(key)
			Input.parse_input_event(ev)
		"mouse":
			var pos := Vector2(float(e.get("x", _mouse.x)), float(e.get("y", _mouse.y)))
			if pos != _mouse:
				var m := InputEventMouseMotion.new()
				m.position = pos
				m.global_position = pos
				m.relative = pos - _mouse
				m.button_mask = _button_mask()
				_mouse = pos
				Input.parse_input_event(m)
			if e.has("down"):
				var b := InputEventMouseButton.new()
				b.button_index = [MOUSE_BUTTON_LEFT, MOUSE_BUTTON_MIDDLE, MOUSE_BUTTON_RIGHT][clampi(int(e.get("button", 0)), 0, 2)]
				b.pressed = bool(e["down"])
				b.position = pos
				b.global_position = pos
				if b.pressed:
					_held_buttons[b.button_index] = true
				else:
					_held_buttons.erase(b.button_index)
				b.button_mask = _button_mask()
				Input.parse_input_event(b)
		"wheel":
			var dy := float(e.get("dy", 0))
			for pressed in [true, false]:
				var w := InputEventMouseButton.new()
				w.button_index = MOUSE_BUTTON_WHEEL_DOWN if dy > 0 else MOUSE_BUTTON_WHEEL_UP
				w.factor = absf(dy) / 100.0
				w.pressed = pressed
				w.position = _mouse
				w.global_position = _mouse
				Input.parse_input_event(w)
		"text":
			for ch in str(e.get("text", "")):
				for pressed in [true, false]:
					var t := InputEventKey.new()
					t.unicode = ch.unicode_at(0)
					t.pressed = pressed
					Input.parse_input_event(t)
		"action":
			var action := str(e.get("action", ""))
			if not InputMap.has_action(action):
				_warn_once("action:" + action, "Witness: no InputMap action '%s'" % action)
				return
			var a := InputEventAction.new()
			a.action = action
			a.pressed = bool(e.get("down", false))
			a.strength = float(e.get("value", 1.0)) if a.pressed else 0.0
			if a.pressed:
				_held_actions[action] = true
			else:
				_held_actions.erase(action)
			Input.parse_input_event(a)
		"pad":
			var button := str(e.get("button", ""))
			if not _PAD.has(button):
				return
			var p := InputEventJoypadButton.new()
			p.device = int(e.get("device", 0))
			p.button_index = _PAD[button]
			p.pressed = bool(e.get("down", false))
			Input.parse_input_event(p)
		"axis":
			var axis := str(e.get("axis", ""))
			if not _AXES.has(axis):
				return
			var j := InputEventJoypadMotion.new()
			j.device = int(e.get("device", 0))
			j.axis = _AXES[axis]
			j.axis_value = float(e.get("value", 0.0))
			Input.parse_input_event(j)


func _button_mask() -> int:
	var mask := 0
	for b in _held_buttons.keys():
		mask |= 1 << (int(b) - 1)
	return mask


# ------------------------------------------------------------------------------ state

func _snapshot() -> Dictionary:
	var state := {}
	var entities := []
	for node in get_tree().get_nodes_in_group("witness"):
		if node.has_method("witness_state"):
			var part = node.witness_state()
			if typeof(part) == TYPE_DICTIONARY:
				for k in part:
					if k == "entities" and typeof(part[k]) == TYPE_ARRAY:
						entities.append_array(part[k])
					else:
						state[k] = part[k]
	for node in get_tree().get_nodes_in_group("witness_entities"):
		var ent := {"id": node.get_meta("witness_id", str(node.name)),
			"type": node.get_meta("witness_type", node.get_class())}
		if node is Node2D or node is Node3D or node is Control:
			ent["pos"] = node.global_position
		if node.has_method("witness_entity"):
			ent.merge(node.witness_entity(), true)
		entities.append(ent)
	if not entities.is_empty() or state.has("entities"):
		state["entities"] = entities
	if not state.has("scene") and get_tree().current_scene:
		state["scene"] = str(get_tree().current_scene.name)
	return _safe(state)


## Convert any Variant into JSON-safe data: vectors -> arrays, NaN -> "NaN", objects -> state/str.
func _safe(v, depth := 0):
	if depth > 64:
		return "<max depth>"
	match typeof(v):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_STRING:
			return v
		TYPE_FLOAT:
			if is_nan(v):
				return "NaN"
			if is_inf(v):
				return "Infinity" if v > 0 else "-Infinity"
			return v
		TYPE_STRING_NAME, TYPE_NODE_PATH:
			return str(v)
		TYPE_VECTOR2, TYPE_VECTOR2I:
			return [_safe(v.x), _safe(v.y)]
		TYPE_VECTOR3, TYPE_VECTOR3I:
			return [_safe(v.x), _safe(v.y), _safe(v.z)]
		TYPE_VECTOR4, TYPE_VECTOR4I, TYPE_QUATERNION:
			return [_safe(v.x), _safe(v.y), _safe(v.z), _safe(v.w)]
		TYPE_COLOR:
			return [v.r, v.g, v.b, v.a]
		TYPE_RECT2, TYPE_RECT2I:
			return [v.position.x, v.position.y, v.size.x, v.size.y]
		TYPE_DICTIONARY:
			var out := {}
			for k in v:
				out[str(k)] = _safe(v[k], depth + 1)
			return out
		TYPE_OBJECT:
			if not is_instance_valid(v):
				return null
			if v.has_method("witness_state"):
				return _safe(v.witness_state(), depth + 1)
			if v is Node:
				return str(v.get_path())
			return str(v)
		_:
			if typeof(v) >= TYPE_ARRAY:   # Array and every Packed*Array
				var arr := []
				for item in v:
					arr.append(_safe(item, depth + 1))
				return arr
			return str(v)


func _screenshot(scale: float) -> Dictionary:
	var t0 := Time.get_ticks_usec()
	if _dirty:
		RenderingServer.force_draw(false)   # state changed without a step: render it now
		_dirty = false
	var img := get_viewport().get_texture().get_image()
	if img == null:
		return {"width": 0, "height": 0, "format": "rgba8", "data": ""}
	if img.get_format() != Image.FORMAT_RGBA8:
		img.convert(Image.FORMAT_RGBA8)
	if scale > 0.0 and absf(scale - 1.0) > 1e-6:
		img.resize(maxi(1, int(img.get_width() * scale)), maxi(1, int(img.get_height() * scale)), Image.INTERPOLATE_BILINEAR)
	_perf["render_ms"] = (Time.get_ticks_usec() - t0) / 1000.0
	return {"width": img.get_width(), "height": img.get_height(), "format": "rgba8",
		"data": Marshalls.raw_to_base64(img.get_data())}


func _audio() -> Dictionary:
	var rate := int(AudioServer.get_mix_rate())
	if not OS.has_feature("movie"):
		_warn_once("audio", "Witness: audio is captured in real time; add --write-movie user://witness.avi (with a rendering driver) for frame-exact audio")
	var frames := _capture.get_frames_available()
	var stereo := _capture.get_buffer(frames) if frames > 0 else PackedVector2Array()
	var bytes: PackedByteArray
	if OS.has_feature("double"):   # double-precision builds: Vector2 holds float64
		var f := PackedFloat32Array()
		f.resize(stereo.size() * 2)
		for i in stereo.size():
			f[i * 2] = stereo[i].x
			f[i * 2 + 1] = stereo[i].y
		bytes = f.to_byte_array()
	else:
		bytes = stereo.to_byte_array()   # Vector2 = two float32: already interleaved stereo f32
	return {"sampleRate": rate, "channels": 2, "format": "f32",
		"data": Marshalls.raw_to_base64(bytes) if not bytes.is_empty() else ""}


func _call_list() -> Array:
	var seen := {}
	var out := []
	for name in _calls:
		seen[name] = true
		out.append({"name": name, "args": _calls[name]["args"], "help": _calls[name]["help"]})
	for node in get_tree().get_nodes_in_group("witness"):
		for m in node.get_method_list():
			var mname: String = m["name"]
			if mname.begins_with("witness_call_") and not seen.has(mname.substr(13)):
				seen[mname.substr(13)] = true
				var args := []
				for a in m["args"]:
					args.append(a["name"])
				out.append({"name": mname.substr(13), "args": " ".join(args)})
	out.sort_custom(func(a, b): return a["name"] < b["name"])
	return out


func _call(name: String, args: Array) -> Dictionary:
	if _calls.has(name):
		return {"result": _safe(_calls[name]["callable"].callv(args))}
	for node in get_tree().get_nodes_in_group("witness"):
		if node.has_method("witness_call_" + name):
			return {"result": _safe(node.callv("witness_call_" + name, args))}
	var known := []
	for c in _call_list():
		known.append(c["name"])
	return {"error": "unknown call '%s' (known: %s)" % [name, ", ".join(known) if not known.is_empty() else "none"]}


func _eval(source: String) -> Dictionary:
	var expr := Expression.new()
	var names := PackedStringArray(["scene", "tree", "root", "Witness"])
	if expr.parse(source, names) != OK:
		return {"error": expr.get_error_text()}
	var tree := get_tree()
	var value = expr.execute([tree.current_scene, tree, tree.root, self], tree.current_scene, false)
	if expr.has_execute_failed():
		return {"error": expr.get_error_text()}
	return {"value": _safe(value)}


# ------------------------------------------------------------------------------ recording

func _start_recording() -> void:
	var path := OS.get_environment("WITNESS_RECORD")
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	_recorder = FileAccess.open(path, FileAccess.WRITE)
	if _recorder == null:
		push_error("Witness: can't write the replay %s (%s)" % [path, error_string(FileAccess.get_open_error())])
		recording = false
		set_physics_process(false)
		return
	_recorder.store_line(JSON.stringify({"replay": 1, "seed": seed, "fps": _fps,
		"name": str(ProjectSettings.get_setting("application/config/name", "Godot game")),
		"started": Time.get_datetime_string_from_system(true) + "Z"}, "", true))
	get_window().window_input.connect(_on_window_input)


func _on_window_input(event: InputEvent) -> void:
	if event is InputEventKey and not event.echo:
		var code: Key = event.keycode if event.keycode != KEY_NONE else event.physical_keycode
		if code == KEY_F8:
			if event.pressed:
				mark("F8")
			return
		_rec_events.append({"type": "key", "key": OS.get_keycode_string(code).to_lower(), "down": event.pressed})
	elif event is InputEventMouseButton:
		var b := {MOUSE_BUTTON_LEFT: 0, MOUSE_BUTTON_MIDDLE: 1, MOUSE_BUTTON_RIGHT: 2}
		if b.has(event.button_index):
			_rec_events.append({"type": "mouse", "x": event.position.x, "y": event.position.y,
				"button": b[event.button_index], "down": event.pressed})
		elif event.pressed and (event.button_index == MOUSE_BUTTON_WHEEL_UP or event.button_index == MOUSE_BUTTON_WHEEL_DOWN):
			_rec_events.append({"type": "wheel", "dy": (100 if event.button_index == MOUSE_BUTTON_WHEEL_DOWN else -100) * event.factor})
	elif event is InputEventMouseMotion:
		_rec_events.append({"type": "mouse", "x": event.position.x, "y": event.position.y})


func _record_physics_frame(delta: float) -> void:
	var line := {"f": _rec_frame, "dt": delta}
	if not _rec_events.is_empty():
		line["in"] = _rec_events
		_rec_events = []
	if _rec_mark != "":
		line["mark"] = _rec_mark
		_rec_mark = ""
	_recorder.store_line(JSON.stringify(_safe(line), "", true, true))
	_rec_frame += 1
	if _rec_frame % 60 == 0:
		_recorder.flush()
