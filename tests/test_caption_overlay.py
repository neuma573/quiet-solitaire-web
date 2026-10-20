import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("caption_overlay", ROOT / "scripts/caption_overlay.py")
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class CaptionOverlayTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.project = self.root / "project"
        (self.project / "scripts").mkdir(parents=True)
        self.target = self.project / "scripts/mode_selection.gd"
        # Independent text fixture, not a copy of private upstream source.
        self.original = ("extends RefCounted\n"
                         "func left(safe, V):\n\treturn ceili(safe.position.x + V.START_MARGIN)\n"
                         "func right(safe, size, V):\n\treturn ceili(size.x - safe.end.x + V.START_MARGIN)\n")
        self.expected = self.original.replace("V.START_MARGIN)", "V.START_MARGIN - 3.0)")
        self.target.write_text(self.original)
        self.pipeline = self.root / "pipeline"
        (self.pipeline / "web").mkdir(parents=True)
        self.sha = "a" * 40
        self.manifest = {"source_sha": self.sha, "before_sha256": digest(self.original),
                         "after_sha256": digest(self.expected)}
        self.write_manifest()
        self.patch = patch.object(overlay, "ROOT", self.pipeline)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def write_manifest(self):
        (self.pipeline / "web/caption-compatibility.json").write_text(json.dumps(self.manifest))

    def apply(self):
        overlay.apply_caption_overlay(self.project, source_sha=self.sha)

    def test_applies_both_margins_without_changing_other_content(self):
        self.apply()
        self.assertEqual(self.target.read_text(), self.expected)
        self.assertEqual({p.relative_to(self.project).as_posix() for p in self.project.rglob("*") if p.is_file()},
                         {"scripts/mode_selection.gd"})

    def test_unreviewed_or_malformed_revision_refuses_before_write(self):
        for sha in ("b" * 40, "a" * 39, "a" * 40 + "\n"):
            with self.subTest(sha=sha), self.assertRaisesRegex(RuntimeError, "revision has not been reviewed"):
                overlay.apply_caption_overlay(self.project, source_sha=sha)
            self.assertEqual(self.target.read_text(), self.original)

    def test_changed_source_refuses_before_write(self):
        changed = self.original + "# New upstream behavior\n"
        self.target.write_text(changed)
        with self.assertRaisesRegex(RuntimeError, "Caption source changed"):
            self.apply()
        self.assertEqual(self.target.read_text(), changed)

    def test_patch_conditions_remain_required_even_if_manifest_hash_is_updated(self):
        for text in (self.original.replace("safe.position.x", "safe.position.y"),
                     self.original + self.original, self.expected):
            with self.subTest(text=text):
                self.target.write_text(text)
                self.manifest["before_sha256"] = digest(text)
                self.write_manifest()
                with self.assertRaisesRegex(RuntimeError, "Caption patch conditions changed"):
                    self.apply()
                self.assertEqual(self.target.read_text(), text)

    def test_changed_expected_result_refuses_both_edits_before_write(self):
        self.manifest["after_sha256"] = "0" * 64
        self.write_manifest()
        with self.assertRaisesRegex(RuntimeError, "Caption patch result changed"):
            self.apply()
        self.assertEqual(self.target.read_text(), self.original)

    def test_repeated_application_refuses_without_changing_result(self):
        self.apply()
        with self.assertRaisesRegex(RuntimeError, "Caption source changed"):
            self.apply()
        self.assertEqual(self.target.read_text(), self.expected)

    def test_git_checkout_or_descendant_is_never_patched(self):
        for git in (self.project / ".git", self.root / ".git"):
            with self.subTest(git=git):
                git.write_text("fixture")
                with self.assertRaisesRegex(RuntimeError, "outside a Git checkout"):
                    self.apply()
                self.assertEqual(self.target.read_text(), self.original)
                git.unlink()

    def test_symlinked_file_directory_and_project_are_rejected(self):
        outside = self.root / "outside.gd"
        outside.write_text(self.original)
        self.target.unlink()
        self.target.symlink_to(outside)
        with self.assertRaisesRegex(RuntimeError, "missing or unsafe"):
            self.apply()
        self.assertEqual(outside.read_text(), self.original)
        self.target.unlink()
        self.target.write_text(self.original)
        scripts = self.project / "scripts"
        scripts.rename(self.root / "external-scripts")
        scripts.symlink_to(self.root / "external-scripts", target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "missing or unsafe"):
            self.apply()
        project_link = self.root / "linked-project"
        project_link.symlink_to(self.project, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "regular disposable"):
            overlay.apply_caption_overlay(project_link, source_sha=self.sha)


if __name__ == "__main__":
    unittest.main()
