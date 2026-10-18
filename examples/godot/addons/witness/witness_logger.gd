extends Logger
## Forwards Godot's errors and warnings (script errors, push_error, push_warning, engine
## errors) to Witness so they fail tests. Loaded by Witness.gd on Godot 4.5+ only.
## Loggers can be called from any thread, so this only appends under Witness's mutex.

var _witness: Node


func _init(witness: Node) -> void:
	_witness = witness


func _log_error(function: String, file: String, line: int, code: String, rationale: String,
		_editor_notify: bool, error_type: int, _script_backtraces: Array) -> void:
	var text := rationale if rationale != "" else code
	var where := "%s:%d" % [file.get_file(), line] if file != "" else function
	var level := "warn" if error_type == ERROR_TYPE_WARNING else "error"
	_witness.log_line(level, "%s (%s)" % [text, where])


func _log_message(_message: String, _error: bool) -> void:
	pass   # print() output stays on stdout; use Witness.info() for messages tests should see
