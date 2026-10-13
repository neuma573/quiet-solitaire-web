import importlib.util
from pathlib import Path
import unittest
from contextlib import contextmanager
import io
import json
import os
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("source", Path(__file__).parents[1] / "scripts/source.py")
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)

SHA = "a" * 40
PIPELINE = "b" * 40


class SelectionTests(unittest.TestCase):
    def test_invalid_sha_cannot_become_a_git_ref_or_shell_input(self):
        for value in ["main", "HEAD", "--upload-pack=x", "a" * 39, "A" * 40, "0" * 40, "a" * 40 + "\n"]:
            with self.subTest(value=value):
                self.assertFalse(source.valid_sha(value))

    def test_manual_default_selects_current_main(self):
        self.assertEqual(source.requested_sha({}, "workflow_dispatch"), "")
        self.assertEqual(source.requested_sha({"inputs": {"source_sha": SHA}}, "workflow_dispatch"), SHA)

    def test_dispatch_requires_exact_source_repository_main_and_commit(self):
        event = {"action": "source-main-push", "client_payload": {
            "source_repository": "neuma573/quiet-solitare", "source_ref": "refs/heads/main", "source_sha": SHA}}
        self.assertEqual(source.requested_sha(event, "repository_dispatch"), SHA)
        for key, value in [("source_repository", "other/repo"), ("source_ref", "refs/heads/feature"),
                           ("source_sha", "main"), ("source_sha", None)]:
            with self.subTest(key=key, value=value):
                invalid = {**event, "client_payload": {**event["client_payload"], key: value}}
                with self.assertRaises(ValueError):
                    source.requested_sha(invalid, "repository_dispatch")

    def test_source_or_pipeline_changes_rebuild_but_unchanged_source_does_not(self):
        deployed = {"source_sha": SHA, "pipeline_sha": PIPELINE}
        self.assertFalse(source.should_build(deployed, SHA, PIPELINE))
        self.assertTrue(source.should_build(deployed, "c" * 40, PIPELINE))
        self.assertTrue(source.should_build(deployed, SHA, "c" * 40))
        self.assertTrue(source.should_build({}, SHA, PIPELINE))

    def test_scheduled_unchanged_source_does_not_checkout_or_publish(self):
        self.run_selection("schedule", {}, SHA, {"source_sha": SHA, "pipeline_sha": PIPELINE}, SHA)

    def test_outdated_dispatch_cannot_roll_the_live_site_back(self):
        event = {"action": "source-main-push", "client_payload": {
            "source_repository": source.SOURCE, "source_ref": "refs/heads/main", "source_sha": SHA}}
        self.run_selection("repository_dispatch", event, "c" * 40, {}, SHA)

    def run_selection(self, event_name, event, main_sha, deployed, expected_sha):
        @contextmanager
        def no_credentials():
            yield {}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            event_path, output = root / "event.json", root / "output"
            event_path.write_text(json.dumps(event))
            env = {"GITHUB_EVENT_PATH": str(event_path), "GITHUB_EVENT_NAME": event_name,
                   "GITHUB_SHA": PIPELINE, "GITHUB_OUTPUT": str(output)}
            with patch.dict(os.environ, env), patch("sys.argv", ["source.py", "--directory", str(root / "checkout")]), \
                    patch.object(source, "credentials", no_credentials), \
                    patch.object(source, "git", return_value=main_sha + "\trefs/heads/main") as access, \
                    patch.object(source.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(deployed).encode())):
                source.main()
            self.assertEqual(output.read_text(), f"sha={expected_sha}\nchanged=false\n")
            self.assertFalse((root / "checkout").exists(), "No private checkout should be created")
            self.assertEqual(access.call_count, 1, "Only read main's remote SHA")
