"""Install checksum-pinned official Linux Godot and single-thread Web templates."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def download(url: str, target: Path, expected: str) -> None:
    digest = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=120) as response, target.open("wb") as stream:
        while chunk := response.read(1024 * 1024):
            digest.update(chunk)
            stream.write(chunk)
    if digest.hexdigest() != expected:
        raise RuntimeError("Official Godot download checksum mismatch")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, required=True)
    options = parser.parse_args()
    directory = options.directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    config = json.loads((ROOT / "godot-version.json").read_text())
    version = config["version"]
    base = f"https://github.com/godotengine/godot/releases/download/{version}-stable"
    editor_name = f"Godot_v{version}-stable_linux.x86_64"
    editor_zip = directory / "editor.zip"
    download(f"{base}/{editor_name}.zip", editor_zip, config["linux_sha256"])
    with zipfile.ZipFile(editor_zip) as archive:
        with archive.open(editor_name) as source, (directory / "godot").open("wb") as target:
            shutil.copyfileobj(source, target)
    (directory / "godot").chmod(0o755)
    templates_zip = directory / "templates.tpz"
    download(f"{base}/Godot_v{version}-stable_export_templates.tpz", templates_zip,
             config["templates_sha256"])
    template_dir = directory / "data/godot/export_templates" / f"{version}.stable"
    template_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(templates_zip) as archive:
        for name in ["version.txt", "web_nothreads_release.zip", "web_nothreads_debug.zip"]:
            with archive.open(f"templates/{name}") as source, (template_dir / name).open("wb") as target:
                shutil.copyfileobj(source, target)
    editor_zip.unlink()
    templates_zip.unlink()
    if output := os.environ.get("GITHUB_ENV"):
        with open(output, "a") as stream:
            stream.write(f"GODOT_BIN={directory / 'godot'}\nXDG_DATA_HOME={directory / 'data'}\n")
    print(f"Installed official Godot {version}; checksums verified")


if __name__ == "__main__":
    main()
