"""Build in a disposable copy. Never modify or print the private source checkout."""
import argparse
import json
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from xml.sax.saxutils import escape
from audit_export import audit
from caption_overlay import apply_caption_overlay
from leaderboard_overlay import apply_overlay, validate_source_contract

ROOT = Path(__file__).resolve().parents[1]



# Explicit browser-only allowlist. The repository's leaderboard/ directory is
# the backend, not public website content, and must never be copied recursively.
PUBLIC_WEB_ASSETS = (
    "leaderboard.mjs", "leaderboard-api.mjs", "leaderboard.css", "leaderboard-config.json",
    "leaderboard/index.html", "leaderboard/page.css", "leaderboard/page.mjs",
)


def copy_public_web_assets(output: Path) -> None:
    web = ROOT / "web"
    for name in PUBLIC_WEB_ASSETS:
        asset = web / name
        destination = output / name
        if (asset.is_symlink() or asset.parent.is_symlink() or not asset.is_file()
                or destination.is_symlink() or destination.parent.is_symlink()):
            raise RuntimeError("Required public leaderboard asset is missing or unsafe")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(asset, destination)


def checked(command: list[str], cwd: Path, log: Path, timeout: int = 300, *, env: dict | None = None) -> None:
    with log.open("w") as stream:
        result = subprocess.run(command, cwd=cwd, stdout=stream, stderr=subprocess.STDOUT,
                                timeout=timeout, check=False, env=env)
    text = log.read_text(errors="replace")
    if result.returncode or re.search(r"(?:SCRIPT ERROR:|\bERROR:)", text):
        raise RuntimeError(f"Build verification failed; private diagnostic log: {log.name}")


def prepare_fonts(project: Path, diagnostics: Path) -> dict[str, str]:
    fonts = project / "web-fonts"
    if fonts.exists():
        raise RuntimeError("Source already has web-fonts; review required")
    fonts.mkdir()
    manifest = json.loads((ROOT / "web/font.json").read_text())
    for config in manifest.values():
        asset = ROOT / "web" / config["path"]
        if (asset.is_symlink() or not asset.is_file() or (ROOT / "web/fonts").is_symlink()
                or not asset.resolve().is_relative_to((ROOT / "web/fonts").resolve())
                or Path(config["filename"]).name != config["filename"]):
            raise RuntimeError("Bundled Web font is missing or unsafe")
        data = asset.read_bytes()
        if hashlib.sha256(data).hexdigest() != config["sha256"]:
            raise RuntimeError("Web font checksum mismatch")
        (fonts / config["filename"]).write_bytes(data)
    # Web SystemFont has no native fonts. An empty Fontconfig directory forces
    # tests through the prepared theme resources, including script routing;
    # discovering raw TTFs here would bypass those prepared FontFile settings.
    no_system_fonts = diagnostics / "no-system-fonts"
    no_system_fonts.mkdir()
    fontconfig = diagnostics / "fontconfig.conf"
    fontconfig.write_text('<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n'
                          '<fontconfig><dir>' + escape(str(no_system_fonts)) + '</dir><cachedir>'
                          + escape(str(diagnostics / "font-cache")) + '</cachedir></fontconfig>\n')
    return dict(os.environ, FONTCONFIG_FILE=str(fontconfig))


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
        # Check original hook/XP hashes, then prepare this exact copy for the
        # pinned Web font before regression. Export the same tested copy.
        validate_source_contract(project, source_sha=sha)
        apply_caption_overlay(project, source_sha=sha)
        environment = prepare_fonts(project, diagnostics)
        # A fresh checkout has no generated CSV translations yet. Import them before
        # loading the project's translation list, without masking any engine errors.
        if (project / "override.cfg").exists():
            raise RuntimeError("Unexpected source override.cfg; review required")
        project_file = project / "project.godot"
        original_config = project_file.read_bytes()
        if b"[gui]" in original_config:
            raise RuntimeError("Source GUI settings changed; review web font overlay")
        web_config = original_config + b'\n[gui]\ntheme/custom="res://web-fonts/theme.tres"\n'
        temporary_config = re.sub(r'^locale/translations=.*$', 'locale/translations=PackedStringArray()',
                                  original_config.decode(), flags=re.MULTILINE)
        project_file.write_text(temporary_config)
        try:
            checked([godot, "--headless", "--path", str(project), "--import"], project,
                    diagnostics / "bootstrap.private.log", env=environment)
            checked([godot, "--headless", "--path", str(project), "--script", str(ROOT / "web/prepare_fonts.gd")],
                    project, diagnostics / "fonts.private.log", env=environment)
            shutil.copyfile(ROOT / "web/theme.tres", project / "web-fonts/theme.tres")
        finally:
            project_file.write_bytes(web_config)
        # Source tests and logs stay on the runner; only the runtime export is published.
        checked([sys.executable, "scripts/test.py", "--godot", godot,
                 "--artifacts", str(diagnostics / "tests")], project, diagnostics / "tests.private.log", 900,
                env=environment)
        report = json.loads((diagnostics / "tests/report.json").read_text())
        if report["status"] != "passed":
            raise RuntimeError("Source regression suite did not complete")
        print("Source regression suite and startup check passed")
        # Observe results and My Page using a web-owned autoload only in this
        # disposable copy. Reimport and boot the exact project being exported.
        apply_overlay(project, source_sha=sha)
        checked([godot, "--headless", "--path", str(project), "--import"], project,
                diagnostics / "leaderboard-import.private.log", env=environment)
        checked([godot, "--headless", "--path", str(project), "--quit-after", "120"], project,
                diagnostics / "leaderboard-startup.private.log", env=environment)
        preset = (ROOT / "web/export_presets.cfg").read_text()
        preset = preset.replace('html/custom_html_shell=""',
                                f'html/custom_html_shell="{(ROOT / "web/shell.html").as_posix()}"')
        if templates:
            preset = preset.replace('custom_template/release=""',
                                    f'custom_template/release="{templates.resolve().as_posix()}"')
        (project / "export_presets.cfg").write_text(preset)
        checked([godot, "--headless", "--path", str(project), "--export-release", "Web",
                 str(output / "index.html")], project, diagnostics / "export.private.log", 300,
                env=environment)
    for name in ["index.html", "index.js", "index.wasm", "index.pck"]:
        if not (output / name).is_file() or (output / name).stat().st_size == 0:
            raise RuntimeError("Required Web runtime file is missing")
    allowed = {"index.html", "index.js", "index.wasm", "index.pck", "index.png",
               "index.icon.png", "index.apple-touch-icon.png", "index.audio.worklet.js",
               "index.audio.position.worklet.js"}
    if any(p.is_symlink() or not p.is_file() or p.name not in allowed for p in output.iterdir()):
        raise RuntimeError("Unexpected file in public export; upload refused")
    audit(output / "index.pck")
    # Fixed public web assets only. Never publish the source compatibility
    # manifest, backend, credentials, diagnostics, or private source checkout.
    copy_public_web_assets(output)
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
