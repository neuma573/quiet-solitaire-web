"""Check compiled layout fixtures without exposing private source or logs."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--godot", default=os.environ.get("GODOT_BIN"), required=not os.environ.get("GODOT_BIN"))
    args = parser.parse_args()
    pack = args.directory.resolve() / "index.pck"
    script = Path(__file__).resolve().parents[1] / "tests/responsive-layout.gd"
    diagnostics = Path(tempfile.mkdtemp(prefix="quiet-responsive-private-"))
    result = subprocess.run([args.godot, "--headless", "--main-pack", str(pack), "--script", str(script),
                             "--log-file", str(diagnostics / "engine.log"), "--", str(diagnostics)],
                            capture_output=True, text=True, timeout=120)
    output = result.stdout + result.stderr
    (diagnostics / "private.log").write_text(output)
    events = [json.loads(line.removeprefix("QUIET_RESPONSIVE "))
              for line in output.splitlines() if line.startswith("QUIET_RESPONSIVE ")]
    starts = [event for event in events if event["event"] == "case_start"]
    ends = [event for event in events if event["event"] == "case_end"]
    summaries = [event for event in events if event["event"] == "summary"]
    expected = next((event["expected"] for event in events if event["event"] == "start"), 0)
    failed = (result.returncode != 0 or re.search(r"SCRIPT ERROR:|\bERROR:", output) or not expected
              or len(summaries) != 1 or len(starts) != expected or len(ends) != expected
              or {e["case"] for e in starts} != {e["case"] for e in ends}
              or len({e["case"] for e in starts}) != expected or any(e["checks"] < 1 for e in ends)
              or summaries[0]["failures"] or summaries[0]["cases"] != expected
              or sum(e["checks"] for e in ends) != summaries[0]["checks"])
    if failed:
        failures = [{"case":e["case"], "message":e["message"]} for e in events if e["event"] == "failure"]
        raise SystemExit(f"Compiled responsive layout verification failed; private diagnostics: {diagnostics}; assertions: {json.dumps(failures)}")
    print(f"Compiled responsive layout passed: {expected} light/dark and English/Japanese cases; "
          f"{summaries[0]['checks']} checks; full-width menus/profile, reachable statistics, "
          "six hidden + thirteen exposed cards, >=14px headers at >=568px height, "
          "old header preserved below that, real strip drag and one Undo")


if __name__ == "__main__":
    main()
