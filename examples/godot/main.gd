extends Node2D
## Coins: the standard Witness sample game, written the ordinary Godot way. Movement reads
## InputMap actions in _physics_process, the ding is an AudioStreamPlayer on the Master bus and
## drawing happens in _draw. The only Witness-specific parts are the "witness" group, the
## witness_state() / witness_call_*() methods and seeding from Witness.seed.
##
## `godot --path . -- --demo` plays a scripted 2 s session in normal play (and records a replay
## when WITNESS_RECORD is set): the "player" holds right from 0 s to 1.2 s and presses F8 at 0.5 s.

const W := 320.0
const H := 180.0
const SPEED := 120.0
const RATE := 22050

var score := 0
var player := {"id": 1, "type": "Player", "pos": Vector2(40, 90), "hp": 3}
var coins: Array = []
var ding: AudioStreamPlayer
var demo := {}   # scripted player state while running with --demo


func _ready() -> void:
	add_to_group("witness")
	_ensure_actions()
	var s: int = Witness.seed   # the reset seed under Witness, the replay seed when recording
	for i in 5:
		coins.append({"id": 10 + i, "type": "Coin",
			"pos": Vector2(80 + 40 * i, 90 if i == 0 else 60 + (s * 7 + i * 13) % 61)})
	ding = AudioStreamPlayer.new()
	ding.stream = _make_ding()
	add_child(ding)
	if "--demo" in OS.get_cmdline_user_args() and not Witness.active:
		demo = {"t": 0.0, "step": 0}
		process_physics_priority = -2000000   # press keys before anything (the recorder too) runs


func _physics_process(delta: float) -> void:
	if not demo.is_empty():
		_demo_frame(delta)
	var dir := Vector2(Input.get_axis("move_left", "move_right"), Input.get_axis("move_up", "move_down"))
	var pos: Vector2 = player["pos"] + dir * SPEED * delta
	player["pos"] = Vector2(clampf(pos.x, 0, W), clampf(pos.y, 0, H))
	for coin in coins.duplicate():
		if (coin["pos"] as Vector2).distance_to(player["pos"]) < 12:
			coins.erase(coin)
			score += 1
			Witness.info("coin %d collected" % coin["id"])
			ding.play()
	queue_redraw()


func _draw() -> void:
	draw_rect(Rect2(0, 0, W, H), Color8(20, 24, 40))
	for coin in coins:
		draw_circle(coin["pos"], 5, Color8(255, 210, 60))
	draw_circle(player["pos"], 7, Color8(80, 200, 255))


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_cancel") and not Witness.active:
		get_tree().quit()


# ------------------------------------------------------------------------------ Witness hooks

func witness_state() -> Dictionary:
	return {"score": score, "scene": "level1", "player": player, "entities": [player] + coins}


func witness_call_teleport(x, y) -> Vector2:
	player["pos"] = Vector2(float(x), float(y))
	return player["pos"]


func witness_call_addcoin(x, y) -> int:
	coins.append({"id": 100 + coins.size(), "type": "Coin", "pos": Vector2(float(x), float(y))})
	return coins.size()


# ------------------------------------------------------------------------------ demo

func _demo_frame(delta: float) -> void:
	var script := [[0.0, KEY_RIGHT, true], [0.5, KEY_F8, true], [0.5, KEY_F8, false], [1.2, KEY_RIGHT, false]]
	while demo["step"] < script.size() and demo["t"] >= script[demo["step"]][0]:
		var action: Array = script[demo["step"]]
		var ev := InputEventKey.new()
		ev.keycode = action[1]
		ev.physical_keycode = action[1]
		ev.pressed = action[2]
		Input.parse_input_event(ev)
		Input.flush_buffered_events()
		demo["step"] += 1
	if demo["t"] >= 2.0:
		var p: Vector2 = player["pos"]
		print("demo finished: t=%.3fs seed=%d score=%d player=(%.4f, %.4f) coins=%d" % [demo["t"], Witness.seed, score, p.x, p.y, coins.size()])
		demo = {}
		get_tree().quit()
		return
	demo["t"] += delta


# ------------------------------------------------------------------------------ setup

func _ensure_actions() -> void:
	var bindings := {"move_left": [KEY_LEFT, KEY_A], "move_right": [KEY_RIGHT, KEY_D],
		"move_up": [KEY_UP, KEY_W], "move_down": [KEY_DOWN, KEY_S]}
	for action in bindings:
		if InputMap.has_action(action):
			continue
		InputMap.add_action(action)
		for key in bindings[action]:
			var ev := InputEventKey.new()
			ev.keycode = key
			InputMap.action_add_event(action, ev)


func _make_ding() -> AudioStreamWAV:
	var n := int(RATE * 0.15)
	var data := PackedByteArray()
	data.resize(n * 2)
	for i in n:
		var v := sin(TAU * 880.0 * i / RATE) * 0.5 * exp(-i / (RATE * 0.04))
		data.encode_s16(i * 2, int(v * 32767.0))
	var wav := AudioStreamWAV.new()
	wav.format = AudioStreamWAV.FORMAT_16_BITS
	wav.mix_rate = RATE
	wav.stereo = false
	wav.data = data
	return wav
