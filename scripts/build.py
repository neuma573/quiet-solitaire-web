"""Build in a disposable copy. Never modify or print the private source checkout."""
import argparse
import json
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.request
from audit_export import audit

ROOT = Path(__file__).resolve().parents[1]


def checked(command: list[str], cwd: Path, log: Path, timeout: int = 300) -> None:
    with log.open("w") as stream:
        result = subprocess.run(command, cwd=cwd, stdout=stream, stderr=subprocess.STDOUT,
                                timeout=timeout, check=False)
    text = log.read_text(errors="replace")
    if result.returncode or re.search(r"(?:SCRIPT ERROR:|\bERROR:)", text):
        raise RuntimeError(f"Build verification failed; private diagnostic log: {log.name}")


def build(source: Path, output: Path, godot: str, pipeline_sha: str, templates: Path | None) -> None:
    config = json.loads((ROOT / "godot-version.json").read_text())
    version = config["version"]
    original_version = re.search(r"Godot (\d+\.\d+\.\d+)", (source / "README.md").read_text())
    actual = subprocess.check_output([godot, "--version"], text=True).strip()
    if not original_version or original_version[1] != version or not actual.startswith(f"{version}.stable."):
        raise RuntimeError("Source README, pinned version and installed stable Godot must match")
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    if output.exists() and any(output.iterdir()):
        raise RuntimeError("Export output must be empty")
    output.mkdir(parents=True, exist_ok=True)
    diagnostics = Path(tempfile.mkdtemp(prefix="quiet-private-diagnostics-", dir=output.parent))
    with tempfile.TemporaryDirectory(prefix="quiet-web-build-") as scratch:
        directory = Path(scratch)
        project = directory / "project"
        shutil.copytree(source, project, ignore=shutil.ignore_patterns(".git", ".godot", "builds", "__pycache__"))
        font_config = json.loads((ROOT / "web/font.json").read_text())
        fonts = project / "web-fonts"
        if fonts.exists():
            raise RuntimeError("Source already has web-fonts; review required")
        fonts.mkdir()
        with urllib.request.urlopen(font_config["url"], timeout=60) as response:
            font_data = response.read()
        if hashlib.sha256(font_data).hexdigest() != font_config["sha256"]:
            raise RuntimeError("Web fallback font checksum mismatch")
        (fonts / font_config["filename"]).write_bytes(font_data)
        # A fresh checkout has no generated CSV translations yet. Import them before
        # loading the project's translation list, without masking any engine errors.
        if (project / "override.cfg").exists():
            raise RuntimeError("Unexpected source override.cfg; review required")
        project_file = project / "project.godot"
        original_config = project_file.read_bytes()
        temporary_config = re.sub(r'^locale/translations=.*$', 'locale/translations=PackedStringArray()',
                                  original_config.decode(), flags=re.MULTILINE)
        project_file.write_text(temporary_config)
        checked([godot, "--headless", "--path", str(project), "--import"], project,
                diagnostics / "bootstrap.private.log")
        project_file.write_bytes(original_config)
        # Source tests and logs stay on the runner; only the runtime export is published.
        checked(["python3", "scripts/test.py", "--godot", godot,
                 "--artifacts", str(diagnostics / "tests")], project, diagnostics / "tests.private.log", 900)
        report = json.loads((diagnostics / "tests/report.json").read_text())
        if report["status"] != "passed":
            raise RuntimeError("Source regression suite did not complete")
        print("Source regression suite and startup check passed")
        if b"[gui]" in original_config:
            raise RuntimeError("Source GUI settings changed; review web font overlay")
        with project_file.open("a") as stream:
            stream.write('\n[gui]\ntheme/custom_font="res://web-fonts/' + font_config["filename"] + '"\n')
        preset = (ROOT / "web/export_presets.cfg").read_text()
        preset = preset.replace('html/custom_html_shell=""',
                                f'html/custom_html_shell="{ROOT / "web/shell.html"}"')
        if templates:
            preset = preset.replace('custom_template/release=""',
                                    f'custom_template/release="{templates.resolve()}"')
        (project / "export_presets.cfg").write_text(preset)
        checked([godot, "--headless", "--path", str(project), "--export-release", "Web",
                 str(output / "index.html")], project, diagnostics / "export.private.log", 300)
    for name in ["index.html", "index.js", "index.wasm", "index.pck"]:
        if not (output / name).is_file() or (output / name).stat().st_size == 0:
            raise RuntimeError("Required Web runtime file is missing")
    allowed = {"index.html", "index.js", "index.wasm", "index.pck", "index.png",
               "index.icon.png", "index.apple-touch-icon.png", "index.audio.worklet.js",
               "index.audio.position.worklet.js"}
    if any(p.is_symlink() or not p.is_file() or p.name not in allowed for p in output.iterdir()):
        raise RuntimeError("Unexpected file in public export; upload refused")
    audit(output / "index.pck")
    (output / ".nojekyll").touch()
    shutil.copyfile(ROOT / "web/FONT-LICENSE.txt", output / "FONT-LICENSE.txt")
    (output / "404.html").write_text('<!doctype html><html lang="en"><meta charset="utf-8"><title>Not found</title><p>Not found.</p></html>\n')
    (output / "deployment.json").write_text(json.dumps({"source_sha": sha, "pipeline_sha": pipeline_sha,
                                                        "godot": version, "threads": False}) + "\n")
    print(f"Web release export passed: Godot {version}, single thread, commit {sha}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--godot", default=os.environ.get("GODOT_BIN"), required=not os.environ.get("GODOT_BIN"))
    parser.add_argument("--pipeline-sha", default=os.environ.get("GITHUB_SHA", "local"))
    parser.add_argument("--template", type=Path)
    args = parser.parse_args()
    build(args.source.resolve(), args.output.resolve(), args.godot, args.pipeline_sha, args.template)
