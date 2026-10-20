"""Apply reviewed font layout corrections only to a disposable Web project."""
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
REPLACEMENTS = {
    "scripts/mode_selection.gd": (
        ("safe.position.x + V.START_MARGIN)", 'safe.position.x + V.START_MARGIN - (4.0 if TranslationServer.get_locale().begins_with("ja") else 0.0))'),
        ("size.x - safe.end.x + V.START_MARGIN)", 'size.x - safe.end.x + V.START_MARGIN - (4.0 if TranslationServer.get_locale().begins_with("ja") else 0.0))'),
    ),
    "scripts/main.gd": (
        ("\t\tbutton.custom_minimum_size = V.touch_size(button)\n",
         "\t\tbutton.custom_minimum_size = V.touch_size(button)\n\t\tif button in [_undo, _pause]:\n\t\t\tbutton.custom_minimum_size = button.custom_minimum_size.ceil()\n"),
    ),
}


def apply_caption_overlay(project: Path, *, source_sha: str) -> None:
    if project.is_symlink():
        raise RuntimeError("Caption overlay requires a regular disposable project")
    project = project.resolve()
    if any((ancestor / ".git").exists() for ancestor in (project, *project.parents)):
        raise RuntimeError("Caption overlay requires a disposable copy outside a Git checkout")
    manifest = json.loads((ROOT / "web/caption-compatibility.json").read_text(encoding="utf-8"))
    if not re.fullmatch(r"[0-9a-f]{40}", source_sha) or source_sha != manifest["source_sha"]:
        raise RuntimeError("Source revision has not been reviewed for Web captions")
    if set(manifest.get("files", {})) != set(REPLACEMENTS):
        raise RuntimeError("Caption source contract is incomplete")
    prepared = []
    for name, replacements in REPLACEMENTS.items():
        path = project / name
        if (path.is_symlink() or path.parent.is_symlink() or not path.is_file()
                or not path.resolve().is_relative_to(project)):
            raise RuntimeError("Caption source contract is missing or unsafe")
        original = path.read_text(encoding="utf-8")
        contract = manifest["files"][name]
        if hashlib.sha256(original.encode("utf-8")).hexdigest() != contract["before_sha256"]:
            raise RuntimeError("Caption source changed; Web layout review required")
        patched = original
        for old, new in replacements:
            if patched.count(old) != 1 or new in patched:
                raise RuntimeError("Caption patch conditions changed; Web layout review required")
            patched = patched.replace(old, new, 1)
        if hashlib.sha256(patched.encode("utf-8")).hexdigest() != contract["after_sha256"]:
            raise RuntimeError("Caption patch result changed; Web layout review required")
        prepared.append((path, patched))
    # Check every original and resulting file before the first write.
    for path, text in prepared:
        path.write_text(text, encoding="utf-8")
