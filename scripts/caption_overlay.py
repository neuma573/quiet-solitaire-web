"""Widen reviewed CJK captions only in the disposable Web build project."""
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
TARGET = "scripts/mode_selection.gd"
# These are the two mode-selection margins, not shared game layout tokens.
REPLACEMENTS = (
    ("safe.position.x + V.START_MARGIN)", "safe.position.x + V.START_MARGIN - 3.0)"),
    ("size.x - safe.end.x + V.START_MARGIN)", "size.x - safe.end.x + V.START_MARGIN - 3.0)"),
)


def apply_caption_overlay(project: Path, *, source_sha: str) -> None:
    if project.is_symlink():
        raise RuntimeError("Caption overlay requires a regular disposable project")
    project = project.resolve()
    if any((ancestor / ".git").exists() for ancestor in (project, *project.parents)):
        raise RuntimeError("Caption overlay requires a disposable copy outside a Git checkout")
    manifest = json.loads((ROOT / "web/caption-compatibility.json").read_text(encoding="utf-8"))
    if not re.fullmatch(r"[0-9a-f]{40}", source_sha) or source_sha != manifest["source_sha"]:
        raise RuntimeError("Source revision has not been reviewed for Web captions")
    path = project / TARGET
    if (path.is_symlink() or path.parent.is_symlink() or not path.is_file()
            or not path.resolve().is_relative_to(project)):
        raise RuntimeError("Caption source contract is missing or unsafe")
    original = path.read_text(encoding="utf-8")
    if hashlib.sha256(original.encode("utf-8")).hexdigest() != manifest["before_sha256"]:
        raise RuntimeError("Caption source changed; Web layout review required")
    patched = original
    for before, after in REPLACEMENTS:
        if patched.count(before) != 1 or after in patched:
            raise RuntimeError("Caption patch conditions changed; Web layout review required")
        patched = patched.replace(before, after, 1)
    if hashlib.sha256(patched.encode("utf-8")).hexdigest() != manifest["after_sha256"]:
        raise RuntimeError("Caption patch result changed; Web layout review required")
    # Validate both edits and the complete result before the first write.
    path.write_text(patched, encoding="utf-8")
