"""Read private main over SSH without logging source contents or persisting credentials."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import urllib.error
import urllib.request

SOURCE = "neuma573/quiet-solitaire"
PAGE = "https://neuma573.github.io/quiet-solitaire-web/"


def valid_sha(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-f]{40}", value)) and value != "0" * 40


def requested_sha(event: dict, name: str) -> str:
    if name == "repository_dispatch":
        payload = event.get("client_payload", {})
        if (event.get("action") != "source-main-merged" or payload.get("source_repository") != SOURCE
                or payload.get("source_ref") != "refs/heads/main"):
            raise ValueError("Unrecognized source dispatch")
        value = payload.get("source_sha", "")
        if not isinstance(value, str) or not valid_sha(value):
            raise ValueError("Invalid dispatched commit SHA")
        return value
    value = event.get("inputs", {}).get("source_sha", "")
    if value and (not isinstance(value, str) or not valid_sha(value)):
        raise ValueError("Invalid requested commit SHA")
    return value


def should_build(deployed: dict, sha: str, pipeline_sha: str) -> bool:
    return deployed.get("source_sha") != sha or deployed.get("pipeline_sha") != pipeline_sha


def git(arguments: list[str], env: dict, cwd: Path | None = None) -> str:
    result = subprocess.run(["git", *arguments], cwd=cwd, env=env, capture_output=True,
                            text=True, timeout=120, check=False)
    if result.returncode:
        raise RuntimeError("Read-only source access failed; check SOURCE_DEPLOY_KEY")
    return result.stdout.strip()


@contextmanager
def credentials():
    secret = os.environ.get("SOURCE_DEPLOY_KEY", "")
    if not secret:
        raise RuntimeError("SOURCE_DEPLOY_KEY secret is required")
    with tempfile.TemporaryDirectory(prefix="quiet-source-auth-") as scratch:
        key = Path(scratch) / "key"
        key.write_text(secret.strip() + "\n")
        key.chmod(0o600)
        request = urllib.request.Request("https://api.github.com/meta", headers={"User-Agent": "quiet-web-ci"})
        with urllib.request.urlopen(request, timeout=30) as response:
            host_keys = json.load(response)["ssh_keys"]
        known_hosts = Path(scratch) / "known_hosts"
        known_hosts.write_text("".join(f"github.com {value}\n" for value in host_keys))
        env = dict(os.environ)
        env.pop("SOURCE_DEPLOY_KEY", None)
        env["GIT_TERMINAL_PROMPT"] = "0"
        env["GIT_SSH_COMMAND"] = (f"ssh -i {shlex.quote(str(key))} -o IdentitiesOnly=yes "
                                  "-o BatchMode=yes -o StrictHostKeyChecking=yes "
                                  f"-o UserKnownHostsFile={shlex.quote(str(known_hosts))}")
        yield env


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--fresh", help="Only deploy while this SHA is still main")
    args = parser.parse_args()
    with credentials() as env:
        remote = f"git@github.com:{SOURCE}.git"
        head = git(["ls-remote", remote, "refs/heads/main"], env).split()[0]
        if not valid_sha(head):
            raise RuntimeError("Invalid source main SHA")
        if args.fresh:
            result = {"current": str(args.fresh == head).lower()}
        else:
            event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
            sha = requested_sha(event, os.environ["GITHUB_EVENT_NAME"]) or head
            deployed = {}
            try:
                with urllib.request.urlopen(PAGE + "deployment.json", timeout=30) as response:
                    deployed = json.load(response)
            except urllib.error.HTTPError as error:
                if error.code != 404:
                    raise
            changed = should_build(deployed, sha, os.environ["GITHUB_SHA"])
            # Old queued events must never roll the live site back to an older source.
            changed = changed and sha == head
            if changed:
                if not args.directory or args.directory.exists():
                    raise RuntimeError("A new disposable checkout directory is required")
                args.directory.mkdir(parents=True, mode=0o700)
                git(["init", "--quiet"], env, args.directory)
                git(["remote", "add", "origin", remote], env, args.directory)
                git(["fetch", "--quiet", "--depth=1", "origin", sha], env, args.directory)
                git(["checkout", "--quiet", "--detach", sha], env, args.directory)
                if git(["rev-parse", "HEAD"], env, args.directory) != sha:
                    raise RuntimeError("Source checkout SHA mismatch")
            result = {"sha": sha, "changed": str(changed).lower()}
    with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
        stream.write("".join(f"{key}={value}\n" for key, value in result.items()))
    print("Source main checked; read-only credentials removed")


if __name__ == "__main__":
    main()
