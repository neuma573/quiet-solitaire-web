extends SceneTree
## Runs against the audited PCK; no test hooks are added to the shipped game.
const Preferences = preload("res://scripts/klondike_preferences.gd")
const Statistics = preload("res://scripts/klondike_statistics.gd")
const Model = preload("res://scripts/klondike.gd")
const Bridge = preload("res://web-leaderboard/leaderboard_bridge.gd")

var checks: int = 0
var failures: int = 0
var cases: int = 0
var current: String

func _initialize() -> void:
	call_deferred("_run")

func record(event: String, data: Dictionary = {}) -> void:
	data.event = event
	data.case = current
	print("QUIET_RESPONSIVE " + JSON.stringify(data))

func check(ok: bool, message: String) -> void:
	checks += 1
	if not ok:
		failures += 1
		record("failure", {"message":message})

func touch(point: Vector2, pressed: bool) -> void:
	var event: InputEventScreenTouch = InputEventScreenTouch.new()
	event.index = 0
	event.position = point
	event.pressed = pressed
	root.push_input(event, true)

func mouse_click(control: Control) -> void:
	var point: Vector2 = control.get_global_transform_with_canvas() * (control.size / 2.0)
	for pressed: bool in [true,false]:
		var event: InputEventMouseButton = InputEventMouseButton.new()
		event.button_index = MOUSE_BUTTON_LEFT
		event.position = point
		event.pressed = pressed
		root.push_input(event,true)

func _run() -> void:
	var directory: String = OS.get_cmdline_user_args()[0]
	var sizes: Array[Vector2i] = [Vector2i(320,460),Vector2i(320,504),Vector2i(360,500),
		Vector2i(320,568),Vector2i(360,640),Vector2i(375,667),
		Vector2i(390,664),Vector2i(430,780),Vector2i(430,932),Vector2i(567,568),
		Vector2i(600,601),Vector2i(600,960),Vector2i(600,1200)]
	record("start",{"expected":sizes.size()*2})
	root.gui_embed_subwindows = true
	root.content_scale_mode = Window.CONTENT_SCALE_MODE_CANVAS_ITEMS
	root.content_scale_aspect = Window.CONTENT_SCALE_ASPECT_EXPAND
	root.content_scale_size = Vector2i(390,760)
	var baseline_children: int = root.get_child_count()
	for dark: bool in [false,true]:
		for size: Vector2i in sizes:
			current = "%dx%d-%s" % [size.x,size.y,"ja-dark" if dark else "en-light"]
			record("case_start")
			var before_checks: int = checks
			var preferences: Preferences = Preferences.new(directory.path_join(current+"-preferences.json"))
			preferences.chosen = true
			preferences.draw_count = 1
			preferences.appearance = "dark" if dark else "light"
			preferences.language = "ja" if dark else "en"
			preferences.apply_language()
			set_meta(Preferences.META,preferences)
			var statistics: Statistics = Statistics.new(directory.path_join(current+"-statistics.json"))
			statistics.load_records()
			set_meta(Statistics.META,statistics)
			set_meta(&"quiet_games_splash_shown",true)
			set_meta(&"quiet_games_reduced_motion",true)
			root.size = size
			await process_frame
			await process_frame
			var main: Control = load("res://scenes/main.tscn").instantiate()
			root.add_child(main)
			await process_frame
			await process_frame
			var bounds: Rect2 = Rect2(Vector2.ZERO,main.size).grow(0.1)
			for key: String in ["_start","_statistics_button","_settings_button"]:
				check(bounds.encloses(main.get(key).get_global_rect()),"Main action remains fully visible: "+key)
			var page: Control = main.get("_statistics_page")
			# The headless platform does not run the Web autoload's JS hooks.
			# Recreate only its independently authored 44-unit profile button.
			var button: Button = Button.new()
			button.text = "Leaderboard & nickname"
			button.theme_type_variation = "NavigationBack"
			button.custom_minimum_size.y = 44
			var content: VBoxContainer = page.get("_content")
			content.add_child(button)
			content.move_child(button,1)
			page.present(statistics,"standard",1,main.get("_visuals"))
			main.call("_resize")
			await process_frame
			await process_frame
			for control: Control in [page.get("back"),page.get("difficulty_choice"),page.get("draw_buttons")[0],page.get("score_buttons")[1]]:
				check(bounds.encloses(control.get_global_rect()),"My Page primary filter remains in the visible viewport")
			var scroll: ScrollContainer = page.get("scroll")
			scroll.scroll_vertical = int(scroll.get_v_scroll_bar().max_value)
			await process_frame
			var last: Control = page.get("values")["INCOMPLETE"]
			check(scroll.get_global_rect().grow(1.0).encloses(last.get_global_rect()),"Last statistics row is reachable by native scrolling")
			main.free()
			await process_frame
			# Inspect the actual compiled font and viewport, rather than assuming
			# the host OS's SystemFont is equivalent to the browser fallback.
			var mode: Control = load("res://scenes/mode_selection.tscn").instantiate()
			root.add_child(mode)
			await process_frame
			await process_frame
			var caption: Label = mode._captions[0]
			# Native macOS/Windows SystemFont can still resolve installed fonts.
			# Use the PCK's exact Web FontFile chain on every test host.
			var web_theme: Theme = load("res://web-fonts/theme.tres")
			caption.add_theme_font_override("font", web_theme.default_font)
			mode._fit_captions()
			await process_frame
			await process_frame
			var font: Font = caption.get_theme_font("font")
			var families: Array[String] = []
			for rid: RID in font.get_rids():
				families.append(TextServerManager.get_primary_interface().font_get_name(rid))
			check(families.size() >= 2 and families[0] == "NanumSquare"
				and "Noto Sans CJK KR" in families, "Compiled captions use the pinned primary and CJK fallback")
			var preview_bounds: Rect2 = mode._previews[0].get_global_rect()
			for key: String in ["PREVIEW_STACK", "PREVIEW_REVEAL", "PREVIEW_FOUNDATION"]:
				caption.text = tr(key)
				await process_frame
				await process_frame
				check(caption.get_theme_font_size("font_size") == 16, "Caption keeps 16 logical units")
				if mode.size.x >= 390:
					check(caption.get_line_count() == 1, "Caption fits one line at a standard or wider logical viewport")
				check(caption.size.y >= caption.get_minimum_size().y
					and caption.get_global_rect().end.y < mode._play.get_global_rect().position.y,
					"Caption remains fully visible above Play")
				check(mode._previews[0].get_global_rect() == preview_bounds, "Changing caption preserves the preview bounds")
			mode.free()
			await process_frame
			var screen: Control = load("res://scenes/game.tscn").instantiate()
			root.add_child(screen)
			screen.get("_clock").process_mode = Node.PROCESS_MODE_DISABLED
			await process_frame
			await process_frame
			var game: Object = screen.get("game")
			var state: Dictionary = game.snapshot()
			for pile: int in Model.PILE_COUNT: state.piles[pile] = []
			state.up.fill(false)
			var used: Array[int] = []
			var ranks: Array[int] = []
			for rank: int in range(12,-1,-1): ranks.append(rank+(13 if rank%2 else 0))
			used.append_array(ranks)
			for card: int in 52:
				if card not in used and state.piles[6].size()<6:
					state.piles[6].append(card)
					used.append(card)
			state.piles[6].append_array(ranks)
			for card: int in ranks: state.up[card]=true
			for card: int in 52:
				if card not in used: state.piles[0].append(card)
			check(Model.valid_state(state),"Fixture has 52 unique cards, six hidden cards and thirteen alternating exposed ranks")
			game.set("_state",state.duplicate(true))
			screen.call("_changed")
			await process_frame
			await process_frame
			var board: Control = screen.get("board")
			var scale: float = board.get_viewport().get_screen_transform().y.length()
			var limit: float = Bridge.board_width_limit(board.size.y,board.get_parent().size.x,scale)
			if limit<board.get_parent().size.x-0.5:
				board.size_flags_horizontal=Control.SIZE_SHRINK_CENTER
				board.custom_minimum_size.x=limit
				await process_frame
				await process_frame
			check(game.snapshot()==state,"Responsive layout preserves every game-state field")
			var first: Dictionary
			var min_header: float = INF
			for item: Dictionary in board.get("_items"):
				check(Rect2(Vector2.ZERO,board.size).grow(0.1).encloses(item.rect),"Every card remains inside the board")
				check(absf(item.rect.size.y-item.rect.size.x*1.48)<0.01,"Card aspect stays unchanged")
				if item.face_up and item.has("header_height"):
					min_header=minf(min_header,item.header_height*scale)
				if item.pile==6 and item.index==6: first=item
			# On very short browser viewports retain the old 390x760 board's
			# exposed header instead of shrinking its cards to meet a width target.
			var old_header: float = 16.0 * ((374.0-12.0)/7.0/48.0) * scale
			var required_header: float = 14.0 if size.y>=568 else minf(14.0,old_header)
			check(min_header>=required_header-0.01,"A longest valid column keeps readable exposed marks, without reducing the old short-screen header")
			var start: Vector2 = board.get_global_transform_with_canvas()*(first.rect.position+Vector2(first.rect.size.x/2,first.header_height/2))
			var target: Vector2 = board.get_global_transform_with_canvas()*board.get("_slots")[8].get_center()
			touch(start,true)
			var drag: InputEventScreenDrag=InputEventScreenDrag.new()
			drag.index=0
			drag.position=target
			drag.relative=target-start
			root.push_input(drag,true)
			touch(target,false)
			await process_frame
			check(game.snapshot().piles[8]==ranks and game.snapshot().moves==state.moves+1,"Dragging an exposed strip moves all thirteen cards exactly once")
			mouse_click(screen.get("_undo"))
			await process_frame
			check(game.snapshot().piles==state.piles and game.snapshot().up==state.up and game.snapshot().moves==state.moves+2,"One Undo restores cards and hidden faces after responsive drag")
			record("metrics",{"minimum_header_css":min_header,"board_width":board.size.x,"logical_width":screen.size.x})
			screen.free()
			await process_frame
			check(root.get_child_count()==baseline_children,"Fixture releases all scene nodes")
			cases+=1
			record("case_end",{"checks":checks-before_checks})
	record("summary",{"cases":cases,"checks":checks,"failures":failures})
	quit(1 if failures else 0)
