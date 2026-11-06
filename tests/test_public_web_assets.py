import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("web_build", ROOT / "scripts/build.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class PublicWebAssetTests(unittest.TestCase):
    def test_support_pages_and_styles_are_copied_exactly_without_backend_or_docs(self):
        expected = {
            "leaderboard.mjs", "leaderboard-api.mjs", "leaderboard.css", "leaderboard-config.json",
            "leaderboard/index.html", "leaderboard/page.css", "leaderboard/page.mjs",
            "support/index.html", "privacy/index.html", "information.css",
        }
        self.assertEqual(set(build.PUBLIC_WEB_ASSETS), expected)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            build.copy_public_web_assets(output)
            actual = {p.relative_to(output).as_posix() for p in output.rglob("*") if p.is_file()}
            self.assertEqual(actual, expected)
            for name in expected:
                self.assertEqual((output / name).read_bytes(), (ROOT / "web" / name).read_bytes())

    def test_missing_support_page_fails_instead_of_shipping_a_broken_link(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "web").mkdir()
            with patch.object(build, "ROOT", root), patch.object(build, "PUBLIC_WEB_ASSETS", ("support/index.html",)):
                with self.assertRaisesRegex(RuntimeError, "public web asset"):
                    build.copy_public_web_assets(root / "output")

    def test_symlinked_support_directory_cannot_publish_other_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "web").mkdir()
            (root / "private").mkdir()
            (root / "private/index.html").write_text("not public")
            (root / "web/support").symlink_to(root / "private", target_is_directory=True)
            with patch.object(build, "ROOT", root), patch.object(build, "PUBLIC_WEB_ASSETS", ("support/index.html",)):
                with self.assertRaisesRegex(RuntimeError, "public web asset"):
                    build.copy_public_web_assets(root / "output")

    def test_symlinked_output_directory_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "output"
            output.mkdir()
            private = root / "other"
            private.mkdir()
            (output / "privacy").symlink_to(private, target_is_directory=True)
            with patch.object(build, "PUBLIC_WEB_ASSETS", ("privacy/index.html",)):
                with self.assertRaisesRegex(RuntimeError, "public web asset"):
                    build.copy_public_web_assets(output)
            self.assertFalse((private / "index.html").exists())


if __name__ == "__main__":
    unittest.main()
