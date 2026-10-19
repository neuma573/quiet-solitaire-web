"""Install web-owned hooks in a disposable build copy, never an upstream checkout."""
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
AUTOLOAD = 'QuietWebLeaderboard="*res://web-leaderboard/leaderboard_bridge.gd"'


def apply_overlay(project: Path, *, source_sha: str) -> None:
    project = project.resolve()
    if any((ancestor / ".git").exists() for ancestor in (project, *project.parents)):
        raise RuntimeError("Leaderboard overlay requires a disposable copy outside a Git checkout")
    manifest = json.loads((ROOT / "web/leaderboard-compatibility.json").read_text(encoding="utf-8"))
    if not re.fullmatch(r"[0-9a-f]{40}", source_sha) or source_sha != manifest["source_sha"]:
        raise RuntimeError("Source revision has not been reviewed for leaderboard compatibility")
    files = manifest.get("files")
    if not isinstance(files, dict) or not files:
        raise RuntimeError("Leaderboard compatibility manifest is incomplete")
    for name, expected in files.items():
        path = project / name
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(project):
            raise RuntimeError("Leaderboard source contract is missing or unsafe")
        text = path.read_text(encoding="utf-8")
        if hashlib.sha256(text.encode("utf-8")).hexdigest() != expected:
            raise RuntimeError("Source hooks or XP rules changed; leaderboard review required")
    config_file = project / "project.godot"
    if config_file.is_symlink() or not config_file.is_file():
        raise RuntimeError("Leaderboard requires a regular project.godot")
    config_bytes = config_file.read_bytes()
    config = config_bytes.decode("utf-8")
    if re.search(r"^\[autoload\]", config, re.MULTILINE) or "QuietWebLeaderboard" in config:
        raise RuntimeError("Unexpected source autoload; leaderboard review required")
    destination = project / "web-leaderboard"
    if destination.exists() or destination.is_symlink():
        raise RuntimeError("Leaderboard overlay destination already exists")
    bridge = (ROOT / "web/leaderboard_bridge.gd").read_bytes()
    if not bridge:
        raise RuntimeError("Leaderboard bridge is empty")
    # All compatibility and path checks finish before the first write.
    destination.mkdir()
    try:
        (destination / "leaderboard_bridge.gd").write_bytes(bridge)
        config_file.write_bytes(config_bytes + ("\n\n[autoload]\n\n" + AUTOLOAD + "\n").encode("utf-8"))
    except BaseException:
        (destination / "leaderboard_bridge.gd").unlink(missing_ok=True)
        destination.rmdir()
        raise
