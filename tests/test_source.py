import importlib.util
from pathlib import Path
import unittest
from contextlib import contextmanager
import io
import json
import os
import shlex
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
        event = {"action": "source-main-merged", "client_payload": {
            "source_repository": "neuma573/quiet-solitaire", "source_ref": "refs/heads/main", "source_sha": SHA}}
        self.assertEqual(source.requested_sha(event, "repository_dispatch"), SHA)
        for key, value in [("source_repository", "other/repo"),
                           ("source_repository", "neuma573/quiet-solitare"), ("source_ref", "refs/heads/feature"),
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

    def test_unchanged_source_does_not_checkout_or_publish(self):
        self.run_selection("workflow_dispatch", {}, SHA, {"source_sha": SHA, "pipeline_sha": PIPELINE}, SHA)

    def test_outdated_dispatch_cannot_roll_the_live_site_back(self):
        event = {"action": "source-main-merged", "client_payload": {
            "source_repository": source.SOURCE, "source_ref": "refs/heads/main", "source_sha": SHA}}
        self.run_selection("repository_dispatch", event, "c" * 40, {}, SHA)

    def test_manual_core_and_full_validate_already_deployed_main(self):
        for regression in ("core", "full"):
            with self.subTest(regression=regression):
                self.run_selection("workflow_dispatch", {"inputs": {"regression": regression}},
                                   SHA, {"source_sha": SHA, "pipeline_sha": PIPELINE}, SHA,
                                   workflow="validate-runtime.yml", checkout=True)

    def test_deploy_still_deduplicates_the_same_source_and_web_sha(self):
        self.run_selection("workflow_dispatch", {}, SHA,
                           {"source_sha": SHA, "pipeline_sha": PIPELINE}, SHA,
                           workflow="deploy.yml")

    def test_validation_still_rejects_an_outdated_requested_source(self):
        self.run_selection("workflow_dispatch", {"inputs": {"source_sha": SHA, "regression": "full"}},
                           "c" * 40, {"source_sha": SHA, "pipeline_sha": PIPELINE}, SHA,
                           workflow="validate-runtime.yml")

    def run_selection(self, event_name, event, main_sha, deployed, expected_sha, *, workflow=None, checkout=False):
        @contextmanager
        def no_credentials():
            yield {}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            event_path, output = root / "event.json", root / "output"
            event_path.write_text(json.dumps(event))
            env = {"GITHUB_EVENT_PATH": str(event_path), "GITHUB_EVENT_NAME": event_name,
                   "GITHUB_SHA": PIPELINE, "GITHUB_OUTPUT": str(output)}
            checkout_path = root / "checkout"
            argv = ["source.py", "--directory", str(checkout_path)]
            if workflow:
                # Exercise the actual workflow's checkout command so removing the
                # validation flag also breaks these regression tests.
                text = (Path(__file__).parents[1] / ".github/workflows" / workflow).read_text()
                commands = [line.strip().removeprefix("run: python3 ") for line in text.splitlines()
                            if line.strip().startswith("run: python3 scripts/source.py ")
                            and "--directory" in line]
                self.assertEqual(len(commands), 1)
                argv = shlex.split(commands[0].replace("$RUNNER_TEMP/private-source", str(checkout_path)))
            validating = "--validate" in argv

            def git_result(arguments, _env, cwd=None):
                if arguments[0] == "ls-remote":
                    return main_sha + "\trefs/heads/main"
                if arguments == ["rev-parse", "HEAD"]:
                    return expected_sha
                return ""

            with patch.dict(os.environ, env), patch("sys.argv", argv), \
                    patch.object(source, "credentials", no_credentials), \
                    patch.object(source, "git", side_effect=git_result) as access, \
                    patch.object(source.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(deployed).encode())) as deployed_read:
                source.main()
            self.assertEqual(output.read_text(), f"sha={expected_sha}\nchanged={str(checkout).lower()}\n")
            self.assertEqual(deployed_read.call_count, 0 if validating else 1,
                             "Validation must not depend on the live deployment or its availability")
            self.assertEqual(access.call_args_list[0].args[0],
                             ["ls-remote", "git@github.com:neuma573/quiet-solitaire.git", "refs/heads/main"])
            if checkout:
                self.assertTrue(checkout_path.is_dir(), "Manual core/full must reach their required-check gate")
                self.assertEqual([call.args[0] for call in access.call_args_list[1:]], [
                    ["init", "--quiet"],
                    ["remote", "add", "origin", "git@github.com:neuma573/quiet-solitaire.git"],
                    ["fetch", "--quiet", "--depth=1", "origin", expected_sha],
                    ["checkout", "--quiet", "--detach", expected_sha],
                    ["rev-parse", "HEAD"],
                ])
            else:
                self.assertFalse(checkout_path.exists(), "No private checkout should be created")
                self.assertEqual(access.call_count, 1, "Only read main's remote SHA")
