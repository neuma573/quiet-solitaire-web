extends SceneTree

func _initialize() -> void:
	var font: FontFile = load("res://web-fonts/NotoSansCJKkr-Regular.otf")
	if font == null:
		push_error("Could not load the verified Web CJK font")
		quit(1)
		return
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
