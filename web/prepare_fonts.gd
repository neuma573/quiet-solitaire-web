extends SceneTree

func _initialize() -> void:
	var primary: FontFile = load("res://web-fonts/NanumSquareR.ttf")
	if primary == null:
		push_error("Could not load the verified NanumSquare font")
		quit(1)
		return
	# NanumSquare advertises some Japanese/Han codepoints with empty outlines.
	# Route those scripts to the existing CJK fallback without modifying TTF bytes.
	for script: String in ["Hani", "Hira", "Kana"]:
		primary.set_script_support_override(script, false)
	primary.set_language_support_override("ja", false)
	primary.allow_system_fallback = false
	if ResourceSaver.save(primary, "res://web-fonts/nanum.res", ResourceSaver.FLAG_COMPRESS) != OK:
		push_error("Could not save the Web primary font settings")
		quit(1)
		return
	var font: FontFile = load("res://web-fonts/NotoSansCJKkr-Regular.otf")
	if font == null:
		push_error("Could not load the verified Web CJK font")
		quit(1)
		return
	font.allow_system_fallback = false
	# Use the font's proportional alternates for Japanese action labels.
	font.opentype_feature_overrides = {TextServerManager.get_primary_interface().name_to_tag("palt"): 1}
	# Godot includes every fallback's line metrics even for Latin-only labels.
	# Use a 1.25 em line box; keep the original outline size and font bytes.
	for size: int in range(1, 257):
		font.set_cache_ascent(0, size, float(size))
		font.set_cache_descent(0, size, float(size) * 0.25)
	var result: Error = ResourceSaver.save(font, "res://web-fonts/cjk.res", ResourceSaver.FLAG_COMPRESS)
	if result != OK:
		push_error("Could not save the Web CJK font metrics")
	quit(0 if result == OK else 1)
