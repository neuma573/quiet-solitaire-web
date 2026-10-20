import hashlib
import json
from pathlib import Path
import struct
import unittest

ROOT = Path(__file__).resolve().parents[1] / "web"


class FontAssetTests(unittest.TestCase):
    def test_bundled_fonts_match_pinned_manifest(self):
        for role, config in json.loads((ROOT / "font.json").read_text()).items():
            with self.subTest(role=role):
                self.assertNotIn("url", config, "Font loading must use local immutable inputs")
                data = (ROOT / config["path"]).read_bytes()
                self.assertEqual(hashlib.sha256(data).hexdigest(), config["sha256"])

    def test_primary_is_original_nanumsquare_regular_and_license_is_included(self):
        config = json.loads((ROOT / "font.json").read_text())["primary"]
        data = (ROOT / config["path"]).read_bytes()
        table_count = struct.unpack_from(">H", data, 4)[0]
        tables = {struct.unpack_from(">4sIII", data, 12 + 16 * index)[0]:
                  struct.unpack_from(">4sIII", data, 12 + 16 * index)[2]
                  for index in range(table_count)}
        offset = tables[b"name"]
        _format, count, strings = struct.unpack_from(">HHH", data, offset)
        names = {}
        for index in range(count):
            platform, _encoding, _language, name, length, position = struct.unpack_from(
                ">HHHHHH", data, offset + 6 + 12 * index)
            if platform == 3:
                value = data[offset + strings + position:offset + strings + position + length].decode("utf-16-be")
                names.setdefault(name, set()).add(value)
        self.assertIn("NanumSquare", names[1])
        self.assertEqual(names[2], {"Regular"})
        self.assertIn("1.000;SAND;NanumSquareR;160623_01;", names[3])
        license_text = (ROOT / "FONT-LICENSE.txt").read_text()
        self.assertIn("2016 NAVER Corporation", license_text)
        self.assertIn("SIL OPEN FONT LICENSE Version 1.1", license_text)
        self.assertIn("NotoSansCJKkr-Regular.otf", license_text)


if __name__ == "__main__":
    unittest.main()
