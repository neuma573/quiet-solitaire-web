"""Reject raw source and development files in Godot 4.7's unencrypted PCK v4."""
from pathlib import Path
import struct


def pack_paths(pack: Path) -> list[str]:
    data = pack.read_bytes()
    if data[:4] != b"GDPC" or struct.unpack_from("<I", data, 4)[0] != 4:
        raise ValueError("Unsupported PCK format; review export audit before publishing")
    if struct.unpack_from("<I", data, 20)[0] & 1:
        raise ValueError("Encrypted PCK directory cannot be audited")
    offset = struct.unpack_from("<Q", data, 32)[0]
    count = struct.unpack_from("<I", data, offset)[0]
    offset += 4
    names = []
    for _ in range(count):
        length = struct.unpack_from("<I", data, offset)[0]
        offset += 4
        if length > 4096 or offset + length + 36 > len(data):
            raise ValueError("Invalid PCK directory entry")
        names.append(data[offset:offset + length].rstrip(b"\0").decode("utf-8"))
        offset += length + 36
    return names


def audit(pack: Path) -> None:
    names = pack_paths(pack)
    forbidden_roots = {"test", "docs", "native", "ios", ".git", ".github", "references", "tools", "builds"}
    forbidden_suffixes = {".gd", ".py", ".sh", ".md", ".log", ".zip", ".tpz", ".pem", ".key", ".p12", ".mobileprovision"}
    for name in names:
        parts = Path(name).parts
        if (not parts or ".." in parts or name.startswith("/") or parts[0] in forbidden_roots
                or Path(name).suffix in forbidden_suffixes or Path(name).name in {"token", ".env", "export_presets.cfg"}):
            raise ValueError("Private source or development data found in runtime pack; publish refused")
    if "project.binary" not in names or not any(name.endswith(".gdc") for name in names):
        raise ValueError("Expected compiled game runtime is missing")


if __name__ == "__main__":
    import sys
    audit(Path(sys.argv[1]))
    print("Public runtime pack audit passed; no raw scripts or development directories")
