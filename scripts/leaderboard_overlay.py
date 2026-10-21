"""Install web-owned hooks in a disposable build copy, never an upstream checkout."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
AUTOLOAD = 'QuietWebLeaderboard="*res://web-leaderboard/leaderboard_bridge.gd"'


def apply_overlay(project: Path, *, source_sha: str) -> None:
    if project.is_symlink():
        raise RuntimeError("Leaderboard overlay requires a regular disposable project")
    project = project.resolve()
    if any((ancestor / ".git").exists() for ancestor in (project, *project.parents)):
        raise RuntimeError("Leaderboard overlay requires a disposable copy outside a Git checkout")
    if not re.fullmatch(r"[0-9a-f]{40}", source_sha):
        raise RuntimeError("Source revision must be a full commit SHA")
    config_file = project / "project.godot"
    if (config_file.is_symlink() or not config_file.is_file()
            or not config_file.resolve().is_relative_to(project)):
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
    # Check the insertion point and paths before the first write.
    destination.mkdir()
    try:
        (destination / "leaderboard_bridge.gd").write_bytes(bridge)
        config_file.write_bytes(config_bytes + ("\n\n[autoload]\n\n" + AUTOLOAD + "\n").encode("utf-8"))
    except BaseException:
        (destination / "leaderboard_bridge.gd").unlink(missing_ok=True)
        destination.rmdir()
        raise
