import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
with patch.object(sys, "path", [str(ROOT / "scripts"), *sys.path]):
    spec = importlib.util.spec_from_file_location("web_build", ROOT / "scripts/build.py")
    build = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build)


class WebBuildTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "README.md").write_text("Godot 4.7.2")
        (self.source / "project.godot").write_text(
            '[internationalization]\nlocale/translations=PackedStringArray("res://messages.en.translation")\n')
        for name in ("scripts/game.gd", "scenes/game.tscn", "test/rules.gd"):
            file = self.source / name
            file.parent.mkdir(exist_ok=True)
            file.write_text("private source fixture: " + name)
        self.before = self.snapshot()
        self.pipeline = self.root / "pipeline"
        web = self.pipeline / "web"
        web.mkdir(parents=True)
        (self.pipeline / "godot-version.json").write_text('{"version":"4.7.2"}')
        for name in ("theme.tres", "export_presets.cfg", "FONT-LICENSE.txt", "leaderboard.mjs",
                     "leaderboard.css", "leaderboard-config.json"):
            (web / name).write_bytes((ROOT / "web" / name).read_bytes())
        manifest = json.loads((ROOT / "web/font.json").read_text())
        self.downloads = {}
        for role, config in manifest.items():
            data = ("font fixture: " + role).encode()
            self.downloads[config["url"]] = data
            config["sha256"] = hashlib.sha256(data).hexdigest()
        (web / "font.json").write_text(json.dumps(manifest))
        self.output = self.root / "site"
        self.stages = []
        self.copies = []

    def snapshot(self):
        return {p.relative_to(self.source).as_posix(): p.read_bytes() for p in self.source.rglob("*") if p.is_file()}

    def download(self, url, **_options):
        return io.BytesIO(self.downloads[url])

    def checked(self, command, project, log, _timeout=300, *, env):
        self.stages.append(log.name)
        self.copies.append(project)
        config = (project / "project.godot").read_text()
        self.assertTrue((project / "web-fonts/Arimo-Regular.ttf").is_file())
        self.assertTrue((project / "web-fonts/NotoSansCJKkr-Regular.otf").is_file())
        self.assertIn(str(project / "web-fonts"), Path(env["FONTCONFIG_FILE"]).read_text())
        for name in ("scripts/game.gd", "scenes/game.tscn", "test/rules.gd"):
            self.assertEqual((project / name).read_bytes(), self.before[name])
        if log.name in ("bootstrap.private.log", "fonts.private.log"):
            self.assertIn("locale/translations=PackedStringArray()", config)
            self.assertNotIn("theme/custom", config, "import fonts before loading their generated resources")
        else:
            self.assertIn('theme/custom="res://web-fonts/theme.tres"', config,
                          "the real Web theme is active for both regression tests and export")
            self.assertTrue((project / "web-fonts/theme.tres").is_file())
            self.assertIn('locale/translations=PackedStringArray("res://messages.en.translation")', config)
        if log.name == "tests.private.log":
            self.assertEqual(command[:2], ["python3", "scripts/test.py"])
            report = Path(command[command.index("--artifacts") + 1]) / "report.json"
            report.parent.mkdir()
            report.write_text('{"status":"passed"}')
        if log.name == "export.private.log":
            for name in ("index.html", "index.js", "index.wasm", "index.pck"):
                (self.output / name).write_bytes(b"runtime fixture")

    def run_build(self, checked=None, overlay_error=None):
        with patch.object(build, "ROOT", self.pipeline), \
                patch.object(build.urllib.request, "urlopen", side_effect=self.download), \
                patch.object(build.subprocess, "check_output", side_effect=["4.7.2.stable.official.test", "a" * 40]), \
                patch.object(build, "apply_overlay", side_effect=overlay_error) as overlay, \
                patch.object(build, "checked", side_effect=checked or self.checked), \
                patch.object(build, "audit") as audit:
            build.build(self.source, self.output, "godot", "b" * 40, None)
            overlay.assert_called_once_with(self.copies[-1], source_sha="a" * 40)
        return audit

    def test_tested_fonts_match_export_and_source_checkout_is_preserved(self):
        inherited_fontconfig = os.environ.get("FONTCONFIG_FILE")
        audit = self.run_build()
        self.assertEqual(self.stages, ["bootstrap.private.log", "fonts.private.log", "tests.private.log",
                                     "leaderboard-import.private.log", "leaderboard-startup.private.log", "export.private.log"])
        self.assertEqual(self.snapshot(), self.before)
        self.assertEqual(os.environ.get("FONTCONFIG_FILE"), inherited_fontconfig)
        self.assertTrue(all(not p.exists() for p in self.copies), "only the disposable copy is modified")
        self.assertEqual((self.output / "FONT-LICENSE.txt").read_bytes(), (ROOT / "web/FONT-LICENSE.txt").read_bytes())
        for name in ("leaderboard.mjs", "leaderboard.css", "leaderboard-config.json"):
            self.assertEqual((self.output / name).read_bytes(), (ROOT / "web" / name).read_bytes())
        self.assertFalse((self.output / "leaderboard-compatibility.json").exists())
        audit.assert_called_once_with(self.output / "index.pck")

    def test_regression_failure_prevents_export_and_keeps_source_intact(self):
        def fail_tests(command, project, log, timeout=300, *, env):
            if log.name == "tests.private.log":
                raise RuntimeError("regression fixture failed")
            self.checked(command, project, log, timeout, env=env)

        with self.assertRaisesRegex(RuntimeError, "regression fixture failed"):
            self.run_build(fail_tests)
        self.assertEqual(self.stages, ["bootstrap.private.log", "fonts.private.log"])
        self.assertEqual(self.snapshot(), self.before)
        self.assertFalse(any(self.output.iterdir()))

    def test_corrupt_font_stops_before_running_source_code(self):
        self.downloads = dict.fromkeys(self.downloads, b"corrupted download")
        with self.assertRaisesRegex(RuntimeError, "font checksum mismatch"):
            self.run_build()
        self.assertEqual(self.stages, [])
        self.assertEqual(self.snapshot(), self.before)

    def test_unreviewed_source_hooks_prevent_export(self):
        with self.assertRaisesRegex(RuntimeError, "leaderboard review required"):
            self.run_build(overlay_error=RuntimeError("leaderboard review required"))
        self.assertEqual(self.stages, ["bootstrap.private.log", "fonts.private.log", "tests.private.log"])
        self.assertEqual(self.snapshot(), self.before)
        self.assertFalse(any(self.output.iterdir()))
