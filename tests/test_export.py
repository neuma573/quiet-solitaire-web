import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("audit", Path(__file__).parents[1] / "scripts/audit_export.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def pack(names):
    header = bytearray(112)
    header[:4] = b"GDPC"
    struct.pack_into("<I", header, 4, 4)
    struct.pack_into("<Q", header, 32, 112)
    directory = struct.pack("<I", len(names))
    for name in names:
        encoded = name.encode() + b"\0"
        directory += struct.pack("<I", len(encoded)) + encoded + bytes(36)
    return header + directory


class PublicPackTests(unittest.TestCase):
    def check_pack(self, names):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "game.pck"
            file.write_bytes(pack(names))
            audit.audit(file)

    def test_compiled_game_and_runtime_assets_are_allowed(self):
        self.check_pack(["project.binary", "scripts/main.gdc", "scripts/main.gd.remap", "assets/card.png"])

    def test_raw_source_development_directories_and_keys_block_publication(self):
        for name in ["scripts/main.gd", "test/fixture.gdc", "docs/design.txt", "native/plugin.a", "token",
                     "secrets/signing.p12", ".git/config", "../private", "/private", "export_presets.cfg"]:
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    self.check_pack(["project.binary", "scripts/main.gdc", name])

    def test_missing_compiled_runtime_blocks_publication(self):
        with self.assertRaises(ValueError):
            self.check_pack(["project.binary", "assets/card.png"])

    def test_future_pack_format_blocks_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "game.pck"
            data = pack(["project.binary", "scripts/main.gdc"])
            struct.pack_into("<I", data, 4, 99)
            file.write_bytes(data)
            with self.assertRaises(ValueError):
                audit.audit(file)
