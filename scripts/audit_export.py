"""Audit public Godot 4.7 PCK v4 files and the referenced runtime deal catalog."""
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import re
import struct


LEGACY_JSON = {"assets/deals/draw-1-decks.json", "assets/deals/draw-3-decks.json"}
CATALOG = "assets/deals/catalog.json"
RUNTIME_JSON = LEGACY_JSON | {CATALOG}
SHA256 = re.compile(r"[0-9a-f]{64}")
GROUP = re.compile(r"(standard|vegas)_[13]_(casual|normal)")
# Matches the source game's DealIdentity.board_id(), including equivalent suits.
SUIT_MAPS = (
    (0, 1, 2, 3), (3, 1, 2, 0), (0, 2, 1, 3), (3, 2, 1, 0),
    (1, 0, 3, 2), (1, 3, 0, 2), (2, 0, 3, 1), (2, 3, 0, 1),
)


def safe_path(name: str) -> bool:
    return (bool(name) and "\\" not in name and ":" not in name
            and not name.startswith("/") and all(p not in {"", ".", ".."} for p in name.split("/")))


def pack_files(pack: Path) -> dict[str, bytes]:
    data = pack.read_bytes()
    if len(data) < 112 or data[:4] != b"GDPC" or struct.unpack_from("<I", data, 4)[0] != 4:
        raise ValueError("Unsupported PCK format; review export audit before publishing")
    flags = struct.unpack_from("<I", data, 20)[0]
    if flags & 1:
        raise ValueError("Encrypted PCK directory cannot be audited")
    if flags & ~2:
        raise ValueError("Unsupported PCK flags")
    file_base = struct.unpack_from("<Q", data, 24)[0] if flags & 2 else 0
    offset = struct.unpack_from("<Q", data, 32)[0]
    if offset < 112 or offset + 4 > len(data):
        raise ValueError("Invalid PCK directory")
    count = struct.unpack_from("<I", data, offset)[0]
    offset += 4
    if count > (len(data) - offset) // 40:
        raise ValueError("Invalid PCK directory count")
    files = {}
    for _ in range(count):
        if offset + 4 > len(data):
            raise ValueError("Invalid PCK directory entry")
        length = struct.unpack_from("<I", data, offset)[0]
        offset += 4
        if not 0 < length <= 4096 or offset + length + 36 > len(data):
            raise ValueError("Invalid PCK directory entry")
        try:
            name = data[offset:offset + length].rstrip(b"\0").decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError("Invalid PCK path") from error
        if not safe_path(name) or "\0" in name or name in files:
            raise ValueError("Unsafe or duplicate PCK path")
        start, size, checksum, entry_flags = struct.unpack_from("<QQ16sI", data, offset + length)
        start += file_base
        if entry_flags or start > len(data) or size > len(data) - start:
            raise ValueError("Invalid or encrypted PCK file entry")
        payload = data[start:start + size]
        if hashlib.md5(payload).digest() != checksum:
            raise ValueError("PCK file checksum mismatch")
        files[name] = payload
        offset += length + 36
    return files


def pack_paths(pack: Path) -> list[str]:
    return list(pack_files(pack))


def whole(value, minimum=0) -> bool:
    return (type(value) in (int, float) and minimum <= value <= 4294967295
            and math.isfinite(value) and value == int(value))


def board_identity(deck: bytes) -> bytes:
    if len(deck) != 52 or set(deck) != set(range(52)):
        raise ValueError("Invalid runtime bundle deck")
    canonical = min(bytes(suits[card // 13] * 13 + card % 13 for card in deck)
                    for suits in SUIT_MAPS)
    return hashlib.sha256(canonical).digest()


def read_catalog(files: dict[str, bytes], name: str) -> dict:
    if name not in files:
        raise ValueError("Required runtime deal catalog missing: " + name)
    try:
        value = json.loads(files[name])
    except (ValueError, UnicodeDecodeError) as error:
        raise ValueError("Invalid runtime deal catalog JSON: " + name) from error
    if not isinstance(value, dict):
        raise ValueError("Invalid runtime deal catalog schema")
    return value


def deal_files(files: dict[str, bytes]) -> set[str]:
    allowed = set(RUNTIME_JSON)
    seen_manifests = set()
    checked_bundles = set()

    def validate(catalog: dict) -> None:
        if (catalog.get("version") != 1 or type(catalog.get("version")) is bool
                or not whole(catalog.get("generation"), 1)
                or not isinstance(catalog.get("parent_sha256"), str)
                or not isinstance(catalog.get("bundles"), list) or not catalog["bundles"]
                or not isinstance(catalog.get("counts"), dict)):
            raise ValueError("Invalid runtime deal catalog schema")
        parent_hash = catalog["parent_sha256"]
        if parent_hash:
            if not SHA256.fullmatch(parent_hash) or parent_hash in seen_manifests:
                raise ValueError("Invalid runtime manifest reference")
            seen_manifests.add(parent_hash)
            parent_name = "assets/deals/manifests/" + parent_hash + ".json"
            parent = read_catalog(files, parent_name)
            if hashlib.sha256(files[parent_name]).hexdigest() != parent_hash:
                raise ValueError("Runtime manifest hash mismatch")
            if (not whole(parent.get("generation"), 1)
                    or parent["generation"] + 1 != catalog["generation"]
                    or not isinstance(parent.get("bundles"), list)
                    or catalog["bundles"][:len(parent["bundles"])] != parent["bundles"]):
                raise ValueError("Invalid runtime manifest generation or bundle prefix")
            allowed.add(parent_name)
            validate(parent)
        elif catalog["generation"] != 1:
            raise ValueError("Invalid runtime manifest generation")

        bundle_ids = set()
        paths = set()
        counts = {}
        pairs = set()
        for bundle in catalog["bundles"]:
            if (not isinstance(bundle, dict) or not isinstance(bundle.get("id"), str) or not bundle["id"]
                    or bundle["id"] in bundle_ids or not isinstance(bundle.get("path"), str)
                    or not isinstance(bundle.get("sha256"), str)
                    or not SHA256.fullmatch(bundle["sha256"])
                    or not whole(bundle.get("records"), 1) or not isinstance(bundle.get("groups"), dict)):
                raise ValueError("Invalid runtime bundle descriptor")
            path = bundle["path"]
            # Only bundle data belongs in the runtime; evidence metadata is not a file reference.
            if (not safe_path(path) or len(PurePosixPath(path).parts) != 2
                    or PurePosixPath(path).parts[0] != "bundles" or not path.endswith(".qsd")
                    or path in paths):
                raise ValueError("Invalid runtime bundle path")
            bundle_ids.add(bundle["id"])
            paths.add(path)
            name = "assets/deals/" + path
            if name not in files:
                raise ValueError("Required runtime bundle missing: " + name)
            payload = files[name]
            records = int(bundle["records"])
            if name not in checked_bundles:
                if hashlib.sha256(payload).hexdigest() != bundle["sha256"]:
                    raise ValueError("Runtime bundle hash mismatch")
                if (len(payload) != 12 + 84 * records or payload[:8] != b"QSDEAL1\0"
                        or struct.unpack_from("<I", payload, 8)[0] != records):
                    raise ValueError("Invalid runtime bundle header or record count")
                for index in range(records):
                    start = 12 + 84 * index
                    if payload[start:start + 32] != board_identity(payload[start + 32:start + 84]):
                        raise ValueError("Runtime bundle board identity mismatch")
                checked_bundles.add(name)
            # Parent descriptors must match the current prefix, so cached hashes remain valid.
            identities = [payload[12 + 84*i:44 + 84*i] for i in range(records)]
            if len(set(identities)) != records:
                raise ValueError("Duplicate runtime bundle board identity")
            allowed.add(name)
            for group, indices in bundle["groups"].items():
                if not GROUP.fullmatch(group) or not isinstance(indices, list):
                    raise ValueError("Invalid runtime bundle group")
                counts[group] = counts.get(group, 0) + len(indices)
                for index in indices:
                    if not whole(index) or index >= records:
                        raise ValueError("Invalid runtime bundle group index")
                    pair = (identities[int(index)], group.rsplit("_", 1)[0])
                    if pair in pairs:
                        raise ValueError("Duplicate runtime deal pair")
                    pairs.add(pair)
        if (any(not GROUP.fullmatch(key) or not whole(value) for key, value in catalog["counts"].items())
                or counts != catalog["counts"]):
            raise ValueError("Runtime deal catalog counts mismatch")

    validate(read_catalog(files, CATALOG))
    return allowed


def audit(pack: Path) -> None:
    files = pack_files(pack)
    forbidden_roots = {"test", "tests", "docs", "native", "ios", ".git", ".github", "references", "tools", "builds", "research"}
    forbidden_suffixes = {".gd", ".py", ".sh", ".md", ".log", ".zip", ".tpz", ".pem", ".key", ".p12", ".mobileprovision"}
    for name in files:
        path = PurePosixPath(name)
        if (path.parts[0].lower() in forbidden_roots or path.suffix.lower() in forbidden_suffixes
                or path.name.lower() in {"token", ".env", "export_presets.cfg"}):
            raise ValueError("Private source or development data found in runtime pack; publish refused")
    missing = RUNTIME_JSON - files.keys()
    if missing:
        raise ValueError("Required runtime deal catalog missing: " + ", ".join(sorted(missing)))
    allowed = deal_files(files)
    for name in files:
        suffix = PurePosixPath(name).suffix.lower()
        if suffix in {".json", ".qsd"} and name not in allowed:
            raise ValueError("Non-runtime JSON or bundle found in runtime pack; publish refused")
        if name.startswith("assets/deals/") and name not in allowed:
            raise ValueError("Non-runtime deal data found in runtime pack; publish refused")
    if "project.binary" not in files or not any(name.endswith(".gdc") for name in files):
        raise ValueError("Expected compiled game runtime is missing")


if __name__ == "__main__":
    import sys
    audit(Path(sys.argv[1]))
    print("Public runtime pack audit passed; no raw scripts or development directories")
