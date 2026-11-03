import configparser
import copy
import fnmatch
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("audit", Path(__file__).parents[1] / "scripts/audit_export.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

DEALS = "assets/deals/"
CATALOG = DEALS + "catalog.json"
LEGACY = {DEALS + f"draw-{draw}-decks.json" for draw in (1, 3)}


def json_bytes(value):
    return (json.dumps(value, sort_keys=True) + "\n").encode()


def pack(files):
    """Build a PCK v4 with real directory offsets, sizes, MD5s and payload."""
    items = list(files.items()) if isinstance(files, dict) else list(files)
    header = bytearray(112)
    header[:4] = b"GDPC"
    struct.pack_into("<I", header, 4, 4)
    struct.pack_into("<I", header, 20, 2)  # FILEBASE_RELATIVE, as Godot's release exporter uses.
    struct.pack_into("<Q", header, 24, len(header))
    struct.pack_into("<Q", header, 32, len(header))
    encoded = [name.encode() + b"\0" for name, _ in items]
    position = len(header) + 4 + sum(4 + len(name) + 36 for name in encoded)
    directory = bytearray(struct.pack("<I", len(items)))
    payload = bytearray()
    for name, (_, content) in zip(encoded, items):
        directory += struct.pack("<I", len(name)) + name
        directory += struct.pack("<QQ", position - len(header), len(content))
        directory += hashlib.md5(content).digest() + struct.pack("<I", 0)
        payload += content
        position += len(content)
    return header + directory + payload


def runtime():
    deck = bytes(range(52))
    bundle = b"QSDEAL1\0" + struct.pack("<I", 1) + hashlib.sha256(deck).digest() + deck
    descriptor = {"id": "research-fixture", "path": "bundles/research-fixture.qsd",
                  "sha256": hashlib.sha256(bundle).hexdigest(), "records": 1,
                  "groups": {"standard_1_casual": [0]}}
    catalog = {"version": 1, "generation": 1, "parent_sha256": "",
               "bundles": [descriptor], "counts": {"standard_1_casual": 1}}
    files = {"project.binary": b"project", "scripts/main.gdc": b"compiled",
             **{name: b"{}" for name in LEGACY},
             DEALS + descriptor["path"]: bundle, CATALOG: json_bytes(catalog)}
    return files, catalog


def with_parent(files, catalog, parent=None):
    parent = copy.deepcopy(catalog if parent is None else parent)
    content = json_bytes(parent)
    digest = hashlib.sha256(content).hexdigest()
    path = DEALS + f"manifests/{digest}.json"
    files[path] = content
    catalog["generation"] = parent["generation"] + 1
    catalog["parent_sha256"] = digest
    files[CATALOG] = json_bytes(catalog)
    return path


class PublicPackTests(unittest.TestCase):
    def check_data(self, data):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "game.pck"
            file.write_bytes(data)
            audit.audit(file)

    def check_pack(self, files):
        self.check_data(pack(files))

    def assert_invalid(self, files):
        with self.assertRaises(ValueError):
            self.check_pack(files)

    def test_compiled_game_and_referenced_runtime_deals_are_allowed(self):
        files, _ = runtime()
        self.check_pack(files | {"scripts/main.gd.remap": b"remap", "assets/card.png": b"image"})

    def test_current_catalog_and_hashed_parent_manifest_are_allowed(self):
        files, catalog = runtime()
        with_parent(files, catalog)
        self.check_pack(files)

    def test_noncanonical_suit_representative_uses_canonical_board_identity(self):
        files, catalog = runtime()
        # Source DealIdentity allows this suit relabeling of 0..51. Its board ID
        # stays SHA256(0..51), although the stored representative has a different hash.
        deck = bytes([*range(39, 52), *range(13, 39), *range(13)])
        identity = hashlib.sha256(bytes(range(52))).digest()
        self.assertNotEqual(hashlib.sha256(deck).digest(), identity)
        descriptor = catalog["bundles"][0]
        path = DEALS + descriptor["path"]
        files[path] = files[path][:12] + identity + deck
        descriptor["sha256"] = hashlib.sha256(files[path]).hexdigest()
        files[CATALOG] = json_bytes(catalog)
        self.check_pack(files)

    def test_bundle_cards_and_canonical_board_identity_must_be_valid(self):
        canonical = bytes(range(52))
        relabeled = bytes([*range(39, 52), *range(13, 39), *range(13)])
        identity = hashlib.sha256(canonical).digest()
        for label, board, deck in (
            ("duplicate cards", identity, bytes(52)),
            ("card outside 0..51", identity, bytes(range(51)) + b"\x34"),
            ("wrong identity", b"\xff" * 32, canonical),
            ("raw rather than canonical hash", hashlib.sha256(relabeled).digest(), relabeled),
        ):
            files, catalog = runtime()
            descriptor = catalog["bundles"][0]
            path = DEALS + descriptor["path"]
            files[path] = files[path][:12] + board + deck
            # Preserve outer integrity so rejection must inspect the QSD record.
            descriptor["sha256"] = hashlib.sha256(files[path]).hexdigest()
            files[CATALOG] = json_bytes(catalog)
            with self.subTest(label=label):
                self.assert_invalid(files)

    def test_suit_equivalent_boards_cannot_repeat_the_same_rule_pair(self):
        files, catalog = runtime()
        first = catalog["bundles"][0]
        second = copy.deepcopy(first)
        second.update(id="relabeled", path="bundles/relabeled.qsd")
        original = files[DEALS + first["path"]]
        deck = bytes([*range(39, 52), *range(13, 39), *range(13)])
        payload = original[:44] + deck
        second["sha256"] = hashlib.sha256(payload).hexdigest()
        files[DEALS + second["path"]] = payload
        catalog["bundles"].append(second)
        catalog["counts"]["standard_1_casual"] = 2
        files[CATALOG] = json_bytes(catalog)
        self.assert_invalid(files)

    def test_evidence_metadata_does_not_require_developer_files(self):
        files, catalog = runtime()
        catalog["bundles"][0].update({"certificate_sha256": "a" * 64,
                                      "verification_sha256": "b" * 64,
                                      "evidence": {"sources": {"assets/deals/draw-1-solutions.json": "c" * 64},
                                                   "report": "research/private-proof.json"}})
        files[CATALOG] = json_bytes(catalog)
        self.check_pack(files)

    def test_failed_ci_shape_includes_new_catalog_beside_both_legacy_files(self):
        files, _ = runtime()
        old_allowlist = {"project.binary", "scripts/main.gdc", *LEGACY}
        self.assertTrue(old_allowlist.issubset(files))
        self.assertIn(CATALOG, set(files) - old_allowlist)
        self.check_pack(files)

    def test_private_source_development_files_and_unreferenced_data_are_blocked(self):
        files, _ = runtime()
        forbidden = ["scripts/main.gd", "test/fixture.gdc", "docs/design.txt", "native/plugin.a", "token",
                     "scripts/ci/toolchain.json",
                     "assets/deals/draw-1-solutions.json", "assets/deals/draw-3-solutions.json",
                     "assets/deals/draw-1-solutions.JSON", "assets/branding/Contents.Json",
                     "assets/branding/Contents.json", "unexpected.json", "secrets/signing.p12",
                     ".git/config", "../private", "/private", "export_presets.cfg",
                     "research/proof.json", "assets/deals/research/report.json",
                     "assets/deals/bundles/orphan.qsd", "assets/deals/manifests/" + "a" * 64 + ".json"]
        for name in forbidden:
            with self.subTest(name=name):
                self.assert_invalid(files | {name: b"private fixture"})

    def test_each_required_catalog_and_bundle_must_exist(self):
        files, _ = runtime()
        for missing in [CATALOG, *LEGACY, DEALS + "bundles/research-fixture.qsd"]:
            with self.subTest(missing=missing):
                self.assert_invalid({name: content for name, content in files.items() if name != missing})

    def test_parent_must_exist_and_match_its_filename_hash(self):
        files, catalog = runtime()
        parent = with_parent(files, catalog)
        self.assert_invalid({name: content for name, content in files.items() if name != parent})
        self.assert_invalid(files | {parent: files[parent] + b" "})

    def test_parent_generation_and_bundle_prefix_must_match(self):
        for kind in ("generation", "bundles"):
            files, catalog = runtime()
            parent = copy.deepcopy(catalog)
            if kind == "generation":
                parent["generation"] = 4
            else:
                parent["bundles"][0]["id"] = "rewritten-parent"
            with_parent(files, catalog, parent)
            if kind == "generation":
                catalog["generation"] = 2
                files[CATALOG] = json_bytes(catalog)
            with self.subTest(kind=kind):
                self.assert_invalid(files)

    def test_catalog_json_and_schema_must_be_valid(self):
        invalid = [None, [], {}, {"version": 2}, {"generation": 0}, {"generation": True},
                   {"generation": 4294967296},
                   {"generation": float("inf")}, {"generation": float("nan")},
                   {"parent_sha256": "../private"}, {"parent_sha256": "g" * 64},
                   {"bundles": {}}, {"counts": []}]
        for change in invalid:
            files, catalog = runtime()
            value = catalog | change if isinstance(change, dict) and change else change
            files[CATALOG] = json_bytes(value)
            with self.subTest(change=change):
                self.assert_invalid(files)
        files, _ = runtime()
        self.assert_invalid(files | {CATALOG: b"{invalid json"})

    def test_bundle_paths_stay_in_runtime_bundle_directory(self):
        for path in ("../private.qsd", "/private.qsd", "bundles/../private.qsd", "bundles\\private.qsd",
                     "C:/private.qsd", "research/proof.qsd", "bundles/fixture.json", "bundles//fixture.qsd"):
            files, catalog = runtime()
            original = files.pop(DEALS + catalog["bundles"][0]["path"])
            catalog["bundles"][0]["path"] = path
            files[DEALS + path] = original
            files[CATALOG] = json_bytes(catalog)
            with self.subTest(path=path):
                self.assert_invalid(files)

    def test_descriptors_have_valid_id_hash_record_count_and_groups(self):
        for change in ({"id": ""}, {"id": 1}, {"sha256": "g" * 64}, {"sha256": "a" * 63},
                       {"records": 0}, {"records": True}, {"records": 1.5},
                       {"records": float("inf")}, {"records": 4294967296}, {"groups": []}):
            files, catalog = runtime()
            catalog["bundles"][0].update(change)
            files[CATALOG] = json_bytes(catalog)
            with self.subTest(change=change):
                self.assert_invalid(files)

    def test_duplicate_bundle_ids_are_rejected(self):
        files, catalog = runtime()
        catalog["bundles"].append(copy.deepcopy(catalog["bundles"][0]))
        files[CATALOG] = json_bytes(catalog)
        self.assert_invalid(files)

    def test_duplicate_boards_in_one_bundle_and_pairs_across_bundles_are_rejected(self):
        files, catalog = runtime()
        descriptor = catalog["bundles"][0]
        path = DEALS + descriptor["path"]
        repeated = files[path][:8] + struct.pack("<I", 2) + files[path][12:] * 2
        descriptor.update(records=2, sha256=hashlib.sha256(repeated).hexdigest())
        self.assert_invalid(files | {path: repeated, CATALOG: json_bytes(catalog)})

        files, catalog = runtime()
        second = copy.deepcopy(catalog["bundles"][0])
        second.update(id="second", path="bundles/second.qsd")
        files[DEALS + second["path"]] = files[DEALS + catalog["bundles"][0]["path"]]
        catalog["bundles"].append(second)
        catalog["counts"]["standard_1_casual"] = 2
        files[CATALOG] = json_bytes(catalog)
        self.assert_invalid(files)

    def test_same_board_for_different_draw_and_scoring_rules_is_allowed(self):
        files, catalog = runtime()
        catalog["bundles"][0]["groups"]["vegas_3_normal"] = [0]
        catalog["counts"]["vegas_3_normal"] = 1
        files[CATALOG] = json_bytes(catalog)
        self.check_pack(files)

    def test_bundle_hash_header_length_and_record_count_must_match(self):
        files, catalog = runtime()
        path = DEALS + catalog["bundles"][0]["path"]
        original = files[path]
        for content in (original[:-1], original + b"extra", b"BADMAGIC" + original[8:],
                        original[:8] + struct.pack("<I", 2) + original[12:]):
            changed = copy.deepcopy(catalog)
            # Match the hash so this exercises the independent QSD structure check.
            changed["bundles"][0]["sha256"] = hashlib.sha256(content).hexdigest()
            with self.subTest(header=content[:12]):
                self.assert_invalid(files | {path: content, CATALOG: json_bytes(changed)})
        self.assert_invalid(files | {path: original[:-1] + b"x"})

    def test_groups_indices_pair_uniqueness_and_counts_must_match(self):
        invalid = [({"invalid": [0]}, {"invalid": 1}),
                   ({"standard_1_casual": "0"}, {"standard_1_casual": 1}),
                   ({"standard_1_casual": [-1]}, {"standard_1_casual": 1}),
                   ({"standard_1_casual": [1]}, {"standard_1_casual": 1}),
                   ({"standard_1_casual": [True]}, {"standard_1_casual": 1}),
                   ({"standard_1_casual": [0.5]}, {"standard_1_casual": 1}),
                   ({"standard_1_casual": [0, 0]}, {"standard_1_casual": 2}),
                   ({"standard_1_casual": [0], "standard_1_normal": [0]},
                    {"standard_1_casual": 1, "standard_1_normal": 1}),
                   ({"standard_1_casual": [0]}, {}),
                   ({"standard_1_casual": [0]}, {"standard_1_casual": 2}),
                   ({"standard_1_casual": [0]}, {"standard_1_casual": True}),
                   ({"standard_1_casual": [float("inf")]}, {"standard_1_casual": 1}),
                   ({"standard_1_casual": [0]}, {"standard_1_casual": float("inf")}),
                   ({"standard_1_casual": [0]}, {"standard_1_casual": 4294967296}),
                   ({"standard_1_casual": [0]}, {"standard_1_casual": 1, "extra": 0})]
        for groups, counts in invalid:
            files, catalog = runtime()
            catalog["bundles"][0]["groups"] = groups
            catalog["counts"] = counts
            files[CATALOG] = json_bytes(catalog)
            with self.subTest(groups=groups, counts=counts):
                self.assert_invalid(files)

    def test_missing_compiled_runtime_blocks_publication(self):
        files, _ = runtime()
        for missing in ("project.binary", "scripts/main.gdc"):
            with self.subTest(missing=missing):
                self.assert_invalid({name: content for name, content in files.items() if name != missing})

    def test_export_filters_include_runtime_data_and_exclude_developer_files(self):
        config = configparser.ConfigParser()
        config.read(Path(__file__).parents[1] / "web/export_presets.cfg")
        preset = config["preset.0"]
        include = preset["include_filter"].strip('"').split(",")
        exclude = preset["exclude_filter"].strip('"').split(",")
        self.assertEqual(set(include), {CATALOG, DEALS + "manifests/*.json", DEALS + "bundles/*.qsd", *LEGACY})
        for name in (CATALOG, DEALS + "manifests/" + "a" * 64 + ".json",
                     DEALS + "bundles/research-20261026.qsd", *LEGACY):
            self.assertTrue(any(fnmatch.fnmatch(name, pattern) for pattern in include), name)
            self.assertFalse(any(fnmatch.fnmatch(name, pattern) for pattern in exclude), name)
        for name in ("assets/deals/draw-1-solutions.json", "assets/deals/draw-3-solutions.json",
                     "assets/branding/QuietLaunchBackground.colorset/Contents.json",
                     "docs/report.json", "tools/fixture.json", "test/fixture.json",
                     "scripts/ci/toolchain.json", "scripts/ci/nested/fixture.json", "scripts/ci/check.gdc"):
            self.assertTrue(any(fnmatch.fnmatch(name, pattern) for pattern in exclude), name)

    def test_duplicate_pack_paths_are_rejected(self):
        files, _ = runtime()
        self.assert_invalid(list(files.items()) + [(CATALOG, files[CATALOG])])

    def test_truncated_or_invalid_pack_directory_and_payload_are_rejected(self):
        files, _ = runtime()
        original = pack(files)
        cases = [b"", original[:4], original[:30], original[:113], original[:-1]]
        bad_directory = bytearray(original)
        struct.pack_into("<Q", bad_directory, 32, len(original) + 1)
        cases.append(bad_directory)
        for data in cases:
            with self.subTest(size=len(data)), self.assertRaises(ValueError):
                self.check_data(data)

    def test_future_or_encrypted_pack_format_blocks_publication(self):
        files, _ = runtime()
        for offset, value in ((4, 99), (20, 1)):
            data = pack(files)
            struct.pack_into("<I", data, offset, value)
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                self.check_data(data)
