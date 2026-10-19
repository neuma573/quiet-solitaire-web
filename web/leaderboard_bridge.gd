extends Node
## Web-owned observer. Browser events are reports, never proof of a valid game.

const GAME_SCRIPT: String = "res://scripts/main.gd"
const PAGE_SCRIPT: String = "res://scripts/statistics_page.gd"
const BOARD_SCRIPT: String = "res://scripts/board.gd"
const PROFILE_SCRIPT: String = "res://scripts/profile_header.gd"
const WEB_PROFILE_META: StringName = &"quiet_web_leaderboard_profile"

var _window: JavaScriptObject
var _profile_callback: JavaScriptObject
var _pages: Array[WeakRef] = []
var _game_root: Node
var _attempt_id: String = ""
var _started: bool = false
var _completed: bool = false

func _ready() -> void:
	if not OS.has_feature("web"):
		return
	_window = JavaScriptBridge.get_interface("window")
	if _window == null:
		return
	_profile_callback = JavaScriptBridge.create_callback(_profile_changed)
	_window.addEventListener("quiet-leaderboard-profile", _profile_callback)
	get_tree().node_added.connect(_node_added)
	_scan(get_tree().root)

func _script_path(node: Object) -> String:
	var script: Script = node.get_script() as Script
	return script.resource_path if script != null else ""

func _scan(node: Node) -> void:
	_node_added(node)
	for child: Node in node.get_children():
		_scan(child)

func _node_added(node: Node) -> void:
	if _script_path(node) in [GAME_SCRIPT, PAGE_SCRIPT]:
		_attach.call_deferred(weakref(node))

func _attach(reference: WeakRef) -> void:
	var node: Node = reference.get_ref() as Node
	if node == null or not node.is_inside_tree():
		return
	if _script_path(node) == GAME_SCRIPT:
		_attach_game(node)
	elif _script_path(node) == PAGE_SCRIPT:
		_attach_page(node as Control)

func _attach_game(root: Node) -> void:
	if root == _game_root:
		return
	var board: Node = root.get("board") as Node
	var game: Object = root.get("game") as Object
	if board == null or _script_path(board) != BOARD_SCRIPT or not board.has_signal("action_committed") \
			or game == null or not game.has_method("snapshot") or not game.has_method("is_won"):
		push_warning("Web leaderboard game hooks are unavailable")
		return
	_cancel()
	_game_root = root
	_attempt_id = ""
	board.connect("action_committed", _action_committed.bind(root))
	root.tree_exiting.connect(_game_exiting.bind(root))

func _action_committed(root: Node) -> void:
	if root != _game_root or not is_instance_valid(root):
		return
	var game: Object = root.get("game") as Object
	var attempt: String = str(root.get("_attempt_id"))
	if attempt.length() != 32 or not attempt.is_valid_hex_number(false):
		return
	var mode: Dictionary = {"difficulty": game.get("difficulty"), "draw": game.get("draw_count"), "scoring": game.get("scoring")}
	if mode.difficulty not in ["casual", "normal", "challenge"] or mode.draw not in [1, 3] or mode.scoring not in ["standard", "vegas"]:
		return
	if attempt != _attempt_id:
		_cancel()
		_attempt_id = attempt
	if not _started:
		_started = true
		_emit({"type": "started", "attemptId": attempt, "mode": mode})
	if _completed or not game.call("is_won"):
		return
	var state: Dictionary = game.call("snapshot")
	if not state.has_all(["score", "elapsed", "moves"]) or not state.score is int \
			or not state.elapsed is int or not state.moves is int or state.elapsed < 0 or state.moves < 1:
		return
	_completed = true
	_emit({"type": "completed", "attemptId": attempt, "mode": mode, "score": state.score,
		"elapsedMs": state.elapsed * 1000, "moves": state.moves, "won": true})

func _cancel() -> void:
	if _started and not _completed:
		_emit({"type": "cancelled", "attemptId": _attempt_id})
	_started = false
	_completed = false

func _game_exiting(root: Node) -> void:
	if root == _game_root:
		_cancel()
		_game_root = null
		_attempt_id = ""

func _attach_page(page: Control) -> void:
	if page.has_meta(WEB_PROFILE_META):
		return
	var content: VBoxContainer = page.get("_content") as VBoxContainer
	var profile: Control = page.get("profile") as Control
	if content == null or profile == null or _script_path(profile) != PROFILE_SCRIPT \
			or not profile.get("player_name") is Label or not profile.get("connection") is Label:
		push_warning("Web leaderboard My Page hooks are unavailable")
		return
	page.set_meta(WEB_PROFILE_META, true)
	_pages.append(weakref(page))
	var button: Button = Button.new()
	button.name = "WebLeaderboardProfile"
	button.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	button.text = _caption("profile")
	button.theme_type_variation = "NavigationBack"
	button.custom_minimum_size.y = 44.0
	button.pressed.connect(func() -> void:
		if not page.get("transitioning") and not page.get("busy"):
			_emit({"type": "my-page"}))
	content.add_child(button)
	content.move_child(button, 1)
	page.visibility_changed.connect(func() -> void: _refresh_page.call_deferred(weakref(page)))
	_refresh_page(weakref(page))

func _profile_changed(_arguments: Array) -> void:
	for reference: WeakRef in _pages:
		_refresh_page(reference)

func _refresh_page(reference: WeakRef) -> void:
	var page: Control = reference.get_ref() as Control
	if page == null or not page.is_visible_in_tree():
		return
	var raw: Variant = JavaScriptBridge.eval("JSON.stringify(window.QuietLeaderboardBridge && window.QuietLeaderboardBridge.profile ? window.QuietLeaderboardBridge.profile() : null)")
	if not raw is String:
		return
	var identity: Variant = JSON.parse_string(raw)
	if not identity is Dictionary or not identity.get("nickname") is String or identity.nickname.is_empty() or identity.nickname.length() > 48:
		var original_profile: Control = page.get("profile") as Control
		if original_profile != null and original_profile.has_method("_refresh_identity"):
			original_profile.call("_refresh_identity")
		return
	var profile: Control = page.get("profile") as Control
	var label: Label = profile.get("player_name") as Label
	label.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	label.text = identity.nickname
	var connection: Label = profile.get("connection") as Label
	connection.text = _caption("guest")
	var button: Button = page.get("_content").get_node_or_null("WebLeaderboardProfile") as Button
	if button != null:
		button.text = _caption("profile")

func _caption(key: String) -> String:
	var language: String = TranslationServer.get_locale().substr(0, 2)
	if language == "ko":
		return "리더보드 · 닉네임" if key == "profile" else "웹 게스트"
	if language == "ja":
		return "ランキング・ニックネーム" if key == "profile" else "ウェブゲスト"
	return "Leaderboard & nickname" if key == "profile" else "Web guest"

func _emit(event: Dictionary) -> void:
	var encoded: String = JSON.stringify(JSON.stringify(event))
	JavaScriptBridge.eval("if (window.QuietLeaderboardBridge) window.QuietLeaderboardBridge.emit(" + encoded + ");")

func _exit_tree() -> void:
	if _window != null and _profile_callback != null:
		_window.removeEventListener("quiet-leaderboard-profile", _profile_callback)
