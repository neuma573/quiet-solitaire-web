import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("leaderboard_overlay", ROOT / "scripts/leaderboard_overlay.py")
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)


class LeaderboardOverlayTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.project = self.root / "disposable-project"
        self.project.mkdir()
        self.pipeline = self.root / "pipeline"
        (self.pipeline / "web").mkdir(parents=True)
        self.sha = "a" * 40
        files = {
            "scripts/example.gd": "extends Node\n# Independently authored fixture.\n",
            "scripts/player_level.gd": "extends RefCounted\nconst FIXTURE_REWARD: int = 100\n",
        }
        for name, text in files.items():
            file = self.project / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(text, encoding="utf-8")
        (self.project / "project.godot").write_text('[application]\nconfig/name="Fixture"\n', encoding="utf-8")
        self.original = self.snapshot()
        self.manifest = {
            "source_sha": self.sha,
            "files": {name: hashlib.sha256(text.encode()).hexdigest() for name, text in files.items()},
        }
        self.write_manifest()
        self.bridge = b"extends Node\n# Web-owned fixture.\n"
        (self.pipeline / "web/leaderboard_bridge.gd").write_bytes(self.bridge)
        self.patch = patch.object(overlay, "ROOT", self.pipeline)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def write_manifest(self):
        (self.pipeline / "web/leaderboard-compatibility.json").write_text(json.dumps(self.manifest), encoding="utf-8")

    def snapshot(self):
        return {p.relative_to(self.project).as_posix(): p.read_bytes()
                for p in self.project.rglob("*") if p.is_file()}

    def apply(self):
        overlay.apply_overlay(self.project, source_sha=self.sha)

    def test_installs_only_own_autoload_and_preserves_game_source(self):
        self.apply()
        self.assertEqual((self.project / "scripts/example.gd").read_bytes(), self.original["scripts/example.gd"])
        self.assertEqual((self.project / "web-leaderboard/leaderboard_bridge.gd").read_bytes(), self.bridge)
        config = (self.project / "project.godot").read_text(encoding="utf-8")
        self.assertTrue((self.project / "project.godot").read_bytes().startswith(self.original["project.godot"]))
        self.assertEqual(config.count("[autoload]"), 1)
        self.assertIn(overlay.AUTOLOAD, config)
        self.assertEqual(set(self.snapshot()) - set(self.original), {"web-leaderboard/leaderboard_bridge.gd"})

    def test_changed_source_contract_refuses_before_any_write(self):
        (self.project / "scripts/example.gd").write_text("extends Node\n# Changed behavior\n", encoding="utf-8")
        before = self.snapshot()
        with self.assertRaisesRegex(RuntimeError, "Source hooks or XP rules changed"):
            self.apply()
        self.assertEqual(self.snapshot(), before)

    def test_unreviewed_revision_refuses_before_any_write(self):
        with self.assertRaisesRegex(RuntimeError, "revision has not been reviewed"):
            overlay.apply_overlay(self.project, source_sha="b" * 40)
        self.assertEqual(self.snapshot(), self.original)

    def test_changed_xp_formula_refuses_even_with_reviewed_revision(self):
        (self.project / "scripts/player_level.gd").write_text(
            "extends RefCounted\nconst FIXTURE_REWARD: int = 1000\n", encoding="utf-8")
        before = self.snapshot()
        with self.assertRaisesRegex(RuntimeError, "Source hooks or XP rules changed"):
            self.apply()
        self.assertEqual(self.snapshot(), before)

    def test_git_checkout_or_descendant_cannot_be_mutated(self):
        (self.root / ".git").mkdir()
        with self.assertRaisesRegex(RuntimeError, "outside a Git checkout"):
            self.apply()
        self.assertEqual(self.snapshot(), self.original)

    def test_missing_contract_refuses_before_any_write(self):
        (self.project / "scripts/example.gd").unlink()
        before = self.snapshot()
        with self.assertRaisesRegex(RuntimeError, "contract is missing or unsafe"):
            self.apply()
        self.assertEqual(self.snapshot(), before)

    def test_manifest_cannot_escape_disposable_root(self):
        outside = self.root / "outside.gd"
        outside.write_text("outside", encoding="utf-8")
        self.manifest["files"] = {"../outside.gd": hashlib.sha256(b"outside").hexdigest()}
        self.write_manifest()
        with self.assertRaisesRegex(RuntimeError, "contract is missing or unsafe"):
            self.apply()
        self.assertEqual(self.snapshot(), self.original)

    def test_repeated_application_or_existing_autoload_is_rejected(self):
        self.apply()
        before = self.snapshot()
        with self.assertRaisesRegex(RuntimeError, "Unexpected source autoload"):
            self.apply()
        self.assertEqual(self.snapshot(), before)

    def test_existing_overlay_directory_is_not_overwritten(self):
        destination = self.project / "web-leaderboard"
        destination.mkdir()
        (destination / "user-file.txt").write_text("preserve", encoding="utf-8")
        before = self.snapshot()
        with self.assertRaisesRegex(RuntimeError, "destination already exists"):
            self.apply()
        self.assertEqual(self.snapshot(), before)

    def test_line_endings_do_not_change_reviewed_contract(self):
        (self.project / "scripts/example.gd").write_bytes(self.original["scripts/example.gd"].replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))
        before = (self.project / "scripts/example.gd").read_bytes()
        self.apply()
        self.assertEqual((self.project / "scripts/example.gd").read_bytes(), before)


@unittest.skipUnless(os.environ.get("GODOT_BIN"), "Set GODOT_BIN for Godot bridge lifecycle verification")
class LeaderboardBridgeTests(unittest.TestCase):
    def test_first_action_completion_reset_and_my_page_events(self):
        # Independent fake game nodes exercise observer behavior without copying upstream source.
        files = {
            "project.godot": 'config_version=5\n[application]\nconfig/name="Bridge fixture"\n',
            "scripts/model.gd": '''extends RefCounted
var difficulty: String = "normal"
var draw_count: int = 3
var scoring: String = "standard"
var won: bool = false
var score: int = 500
var elapsed: int = 45
var moves: int = 90
func snapshot() -> Dictionary:
    return {"score": score, "elapsed": elapsed, "moves": moves}
func is_won() -> bool:
    return won
''',
            "scripts/board.gd": 'extends Node\nsignal action_committed\n',
            "scripts/main.gd": '''extends Node
var game: RefCounted = load("res://scripts/model.gd").new()
var board: Node
var _attempt_id: String = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
func _ready() -> void:
    board = load("res://scripts/board.gd").new()
    add_child(board)
''',
            "scripts/profile_header.gd": '''extends Control
class Service extends RefCounted:
    signal changed
var service: Service = Service.new()
var player_name: Label
var connection: Label
func _ready() -> void:
    player_name = Label.new()
    connection = Label.new()
    add_child(player_name)
    add_child(connection)
    service.changed.connect(_refresh_identity)
    _refresh_identity()
func _refresh_identity() -> void:
    player_name.text = "Player"
    connection.text = "Unavailable"
''',
            "scripts/statistics_page.gd": '''extends Control
var _content: VBoxContainer
var profile: Control
var transitioning: bool = false
var busy: bool = false
var score_buttons: Array[Button] = []
var draw_buttons: Array[Button] = []
var retry: Button
var difficulty_choice: OptionButton
func _ready() -> void:
    _content = VBoxContainer.new()
    add_child(_content)
    profile = load("res://scripts/profile_header.gd").new()
    _content.add_child(profile)
    for buttons: Array[Button] in [score_buttons, draw_buttons]:
        var button: Button = Button.new()
        add_child(button)
        buttons.append(button)
        button.pressed.connect(refresh)
    difficulty_choice = OptionButton.new()
    add_child(difficulty_choice)
    difficulty_choice.add_item("All")
    difficulty_choice.add_item("Normal")
    difficulty_choice.item_selected.connect(func(_index: int) -> void: refresh())
    retry = Button.new()
    add_child(retry)
    retry.pressed.connect(refresh)
    hide()
func refresh() -> void:
    profile._refresh_identity()
func apply_appearance() -> void:
    theme = Theme.new()
    profile._refresh_identity()
''',
            "test_bridge.gd": '''extends SceneTree
class Observer extends "res://web-leaderboard/leaderboard_bridge.gd":
    var events: Array[Dictionary] = []
    var identity: Variant = null
    func _emit(event: Dictionary) -> void:
        events.append(event.duplicate(true))
    func _browser_profile() -> Variant:
        return identity
var failures: int = 0
func _initialize() -> void:
    _run.call_deferred()
func _check(condition: bool, message: String) -> void:
    if not condition:
        failures += 1
        push_error(message)
func _run() -> void:
    var observer: Observer = Observer.new()
    root.add_child(observer)
    var game_root: Node = load("res://scripts/main.gd").new()
    root.add_child(game_root)
    observer._attach_game(game_root)
    observer._attach_game(game_root)
    _check(observer.events.is_empty(), "Attaching must never import historical/local records")
    game_root.board.emit_signal("action_committed")
    _check(observer.events.size() == 1 and observer.events[0].type == "started", "First action starts exactly one run")
    _check(observer.events[0].mode == {"difficulty": "normal", "draw": 3, "scoring": "standard"}, "Modes reach the backend unchanged")
    game_root.board.emit_signal("action_committed")
    _check(observer.events.size() == 1, "Repeated actions must not start duplicate runs")
    game_root.game.won = true
    game_root.board.emit_signal("action_committed")
    _check(observer.events.size() == 2 and observer.events[1].type == "completed", "Winning action completes one run")
    _check(observer.events[1].score == 500 and observer.events[1].moves == 90 and observer.events[1].elapsedMs == 45000, "Completion reports original score, cumulative moves and seconds converted to milliseconds")
    _check(not observer.events[1].has("xp") and not observer.events[1].has("userId"), "Browser cannot select authenticated identity or trusted XP total")
    game_root.board.emit_signal("action_committed")
    _check(observer.events.size() == 2, "Repeated completion signals are idempotent")
    game_root._attempt_id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    game_root.game.won = false
    game_root.board.emit_signal("action_committed")
    _check(observer.events.size() == 3 and observer.events[2].type == "started", "A new attempt starts after a completed game")
    game_root._attempt_id = "cccccccccccccccccccccccccccccccc"
    game_root.board.emit_signal("action_committed")
    _check(observer.events.size() == 5 and observer.events[3].type == "cancelled" and observer.events[4].type == "started", "Restart cancels the old active run before starting another")
    game_root.queue_free()
    await process_frame
    _check(observer.events.size() == 6 and observer.events[5].type == "cancelled", "Leaving gameplay cancels unfinished runs")
    var page: Control = load("res://scripts/statistics_page.gd").new()
    root.add_child(page)
    observer._attach_page(page)
    observer._attach_page(page)
    _check(page._content.get_child_count() == 2, "My Page receives one web-owned button")
    var button: Button = page._content.get_node("WebLeaderboardProfile") as Button
    button.emit_signal("pressed")
    _check(observer.events.size() == 7 and observer.events[6].type == "my-page", "My Page opens the nickname and leaderboard overlay")
    page.transitioning = true
    button.emit_signal("pressed")
    page.transitioning = false
    page.busy = true
    button.emit_signal("pressed")
    _check(observer.events.size() == 7, "My Page ignores actions during transitions or blocked input")
    page.busy = false
    observer.identity = {"nickname": "Guest Pine"}
    page.show()
    await process_frame
    await process_frame
    _check(page.profile.player_name.text == "Guest Pine", "Visible My Page displays the server nickname")
    page.score_buttons[0].emit_signal("pressed")
    await process_frame
    _check(page.profile.player_name.text == "Guest Pine", "Scoring filter refresh preserves the server nickname")
    page.draw_buttons[0].emit_signal("pressed")
    await process_frame
    _check(page.profile.player_name.text == "Guest Pine", "Draw filter refresh preserves the server nickname")
    page.difficulty_choice.emit_signal("item_selected", 1)
    await process_frame
    await process_frame
    _check(page.profile.player_name.text == "Guest Pine", "Difficulty filter refresh preserves the server nickname without an explicit observer hook")
    page.retry.emit_signal("pressed")
    await process_frame
    _check(page.profile.player_name.text == "Guest Pine", "Local statistics retry preserves the server nickname")
    page.apply_appearance()
    await process_frame
    _check(page.profile.player_name.text == "Guest Pine", "Theme refresh preserves the server nickname")
    page.profile.service.emit_signal("changed")
    await process_frame
    _check(page.profile.player_name.text == "Guest Pine", "Native profile service refresh preserves the server nickname")
    page.refresh()
    observer._notification(Node.NOTIFICATION_APPLICATION_FOCUS_OUT)
    await process_frame
    _check(page.profile.player_name.text == "Guest Pine", "App focus refresh preserves the server nickname")
    observer.identity = null
    observer._profile_changed([])
    await process_frame
    _check(page.profile.player_name.text == "Player" and page.profile.connection.text == "Unavailable", "Deleting the web guest restores local profile labels")
    page.queue_free()
    await process_frame
    _check(observer._pages.is_empty() and observer._queued_pages.is_empty(), "Freed My Pages leave no app-lifetime refresh observers")
    observer.queue_free()
    await process_frame
    print("Bridge lifecycle checks completed: failures=", failures)
    quit(1 if failures else 0)
''',
        }
        with tempfile.TemporaryDirectory() as scratch:
            project = Path(scratch)
            for name, content in files.items():
                path = project / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
            (project / "web-leaderboard").mkdir()
            shutil.copyfile(ROOT / "web/leaderboard_bridge.gd", project / "web-leaderboard/leaderboard_bridge.gd")
            (project / "appdata").mkdir()
            environment = dict(os.environ, APPDATA=str(project / "appdata"), LOCALAPPDATA=str(project / "appdata"))
            result = subprocess.run([os.environ["GODOT_BIN"], "--headless", "--path", str(project),
                                     "--script", "res://test_bridge.gd"], capture_output=True, text=True,
                                    encoding="utf-8", errors="replace", timeout=60, env=environment)
            output = result.stdout + result.stderr
            self.assertEqual(result.returncode, 0, output)
            self.assertNotRegex(output, re.compile(r"(?:SCRIPT ERROR:|\bERROR:)"))
            self.assertIn("Bridge lifecycle checks completed: failures=0", output)


if __name__ == "__main__":
    unittest.main()
