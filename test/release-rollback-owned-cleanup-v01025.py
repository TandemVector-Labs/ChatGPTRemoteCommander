#!/usr/bin/env python3
"""CI-only cleanup of owned Node routers/backends in a disposable v0.10.25 candidate sandbox.

Fails closed on uncertain process identity. No interactive/real host deployment.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import sys
import time

PATTERNS = (b"src/server-v0.3.mjs", b"src/stable-router.mjs")
# This process-killing helper runs only on the observed GitHub-hosted Ubuntu image.
# Fail closed if GitHub changes the observed trusted runner temp location.
# These constants, not --root or environment strings, own every IO path.
CI_TEMP_ROOT = Path("/home/runner/work/_temp")
CI_SANDBOX = CI_TEMP_ROOT / "remote-commander-rollback-v025l"


def matches(root: Path, cwd: str, argv: bytes) -> bool:
    try:
        directory = Path(cwd).resolve(strict=True)
        return directory.is_relative_to(root) and (
            b"node" in argv.split(b"\0")[0].split(b"/")[-1:]
            or Path(argv.split(b"\0")[0].decode(errors="ignore")).name in ("node", "node.exe")
        ) and any(fragment in argv for fragment in PATTERNS)
    except (OSError, ValueError):
        return False


def list_owned(root: Path):
    found = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            if entry.stat().st_uid != os.getuid():
                continue
            cmd = (entry / "cmdline").read_bytes()
            if not cmd:
                continue
            current = os.readlink(entry / "cwd")
            state = (entry / "stat").read_text().split(")", 1)[1].split()[0]
            if state == "Z":
                continue
            if matches(root, current, cmd):
                found.append(int(entry.name))
        except (FileNotFoundError, ProcessLookupError, PermissionError, OSError):
            continue
    return sorted(set(found))


def validated_sandbox(raw_root: str, raw_temp: str) -> Path:
    """Bind CI cleanup to a single known hosted-Ubuntu directory.

    The CLI and RUNNER_TEMP values are identity assertions ONLY. All actual
    filesystem and process operations derive from literal CI_SANDBOX, and
    ambiguous GitHub runner paths fail closed rather than expanding scope.
    """
    if not isinstance(raw_root, str) or not isinstance(raw_temp, str):
        raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE")
    if not raw_root or not raw_temp or not os.path.isabs(raw_root) or not os.path.isabs(raw_temp):
        raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE")
    if ".." in Path(raw_root).parts or ".." in Path(raw_temp).parts:
        raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE")
    if raw_root != str(CI_SANDBOX) or raw_temp != str(CI_TEMP_ROOT):
        raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE")
    if os.path.normpath(raw_root) != raw_root or os.path.normpath(raw_temp) != raw_temp:
        raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE")
    try:
        if os.path.realpath(CI_TEMP_ROOT) != str(CI_TEMP_ROOT):
            raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE")
        if os.path.realpath(CI_SANDBOX) != str(CI_SANDBOX):
            raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE")
        if not os.path.isdir(CI_TEMP_ROOT) or not os.path.isdir(CI_SANDBOX):
            raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE")
    except (OSError, ValueError):
        raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE") from None
    return CI_SANDBOX

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        import tempfile
        with tempfile.TemporaryDirectory(prefix="rc-v025c-") as tmp:
            r = Path(tmp).resolve()
            (r / "release").mkdir()
            assert matches(r, str(r / "release"), b"/opt/node/bin/node\0src/server-v0.3.mjs\0")
            assert matches(r, str(r / "release"), b"node\0src/stable-router.mjs\0")
            assert not matches(r, "/home/user/private", b"node\0src/stable-router.mjs\0")
            assert not matches(r, str(r / "release"), b"python3\0src/server-v0.3.mjs\0")
            from unittest import mock
            sandbox = r / "remote-commander-rollback-v025l"
            sandbox.mkdir()
            other = r / "other"
            other.mkdir()
            alias = r / "symlinked-sandbox"
            alias.symlink_to(sandbox, target_is_directory=True)
            # Positive: mock only known CI filesystem probes without creating
            # anything under the actual hosted-root path on this developer PC.
            with mock.patch("os.path.realpath", side_effect=lambda p: str(p)), \
                 mock.patch("os.path.isdir", return_value=True):
                assert validated_sandbox(str(CI_SANDBOX), str(CI_TEMP_ROOT)) == CI_SANDBOX
            rejected = [
                (str(other), str(r)),
                (str(alias), str(r)),
                (str(sandbox / ".." / sandbox.name), str(r)),
                (str(sandbox), str(r / "release")),
                ("/tmp", str(r)),
                ("relative/path", str(r)),
                (str(CI_SANDBOX) + "/../remote-commander-rollback-v025l", str(CI_TEMP_ROOT)),
                (str(CI_SANDBOX), str(r)),
            ]
            for candidate, temp_root in rejected:
                try:
                    validated_sandbox(candidate, temp_root)
                except SystemExit as failure:
                    assert str(failure) == "V025C_SANDBOX_IDENTITY_FAILURE"
                else:
                    raise AssertionError("unsafe CI cleanup path accepted")
            with mock.patch("os.path.realpath", side_effect=lambda p: "/tmp/untrusted" if str(p) == str(CI_SANDBOX) else str(p)), \
                 mock.patch("os.path.isdir", return_value=True):
                try:
                    validated_sandbox(str(CI_SANDBOX), str(CI_TEMP_ROOT))
                except SystemExit as failure:
                    assert str(failure) == "V025C_SANDBOX_IDENTITY_FAILURE"
                else:
                    raise AssertionError("symlinked fixed CI directory accepted")
        print("V025C_IDENTITY_PURE_TEST_PASS")
        return
    if os.getenv("CI") != "true" or not os.getenv("RUNNER_TEMP") or not os.getenv("GITHUB_WORKSPACE"):
        raise SystemExit("V025C_CI_ONLY")
    if not args.root:
        raise SystemExit("V025C_ROOT_REQUIRED")
    validated_sandbox(args.root, os.environ["RUNNER_TEMP"])
    sandbox = CI_SANDBOX  # the trusted fixed root, never constructed from input
    receipt = CI_SANDBOX / "CLEANUP_V025C.json"
    if "CLEANUP_V025C.json" in os.listdir(sandbox):
        raise SystemExit("V025C_NO_BLIND_REWRITE")
    before = list_owned(sandbox)
    for pid in before:
        if pid in list_owned(sandbox):
            os.kill(pid, signal.SIGTERM)
    for _ in range(30):
        if not list_owned(sandbox):
            break
        time.sleep(0.1)
    remaining = list_owned(sandbox)
    for pid in remaining:
        if pid in list_owned(sandbox):
            os.kill(pid, signal.SIGKILL)
    for _ in range(30):
        if not list_owned(sandbox):
            break
        time.sleep(0.1)
    after = list_owned(sandbox)
    record = {
        "schema": 1, "revision": "V025C", "host": "isolated-linux-github-runner",
        "status": "PASS_ZERO_OWNED_NODE_AFTER_ROLLBACK" if not after else "FAIL_OWNED_NODE_REMAIN",
        "ownedBefore": before, "ownedAfter": after, "cleanupUsed": bool(before),
        "externalNodeProcessesTouched": False, "root": str(sandbox)
    }
    payload = json.dumps(record, indent=2) + "\n"
    with receipt.open("x", encoding="utf-8") as output:
        output.write(payload)
    print("V025C_CLEANUP_STATUS=" + record["status"] + " receiptSha="
          + hashlib.sha256(payload.encode("utf-8")).hexdigest())
    if after:
        raise SystemExit(78)


if __name__ == "__main__":
    main()
