"""Record public stage durations without copying private subprocess output/logs."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stage")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a command is required")
    started = time.monotonic()
    code = subprocess.call(command)
    seconds = round(time.monotonic() - started, 3)
    record = {"stage": args.stage, "seconds": seconds, "exit_code": code}
    print("CI_TIMING " + json.dumps(record), flush=True)
    if destination := os.environ.get("CI_TIMINGS"):
        with Path(destination).open("a") as stream:
            stream.write(json.dumps(record) + "\n")
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(summary).open("a") as stream:
            stream.write(f"- {args.stage}: **{seconds:.3f}s**, exit {code}\n")
    raise SystemExit(code if code >= 0 else 1)


if __name__ == "__main__":
    main()
