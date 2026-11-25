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


def validated_sandbox(raw_root: str, raw_temp: str, *, trusted_temp: Path | None = None) -> Path:
    """Ignore external path strings as filesystem authority.

    Production derives the runner temp root from the located source checkout:
    /.../work/<repo>/<repo>/test/script.py -> /.../work/_temp.
    The CLI and environment values must match this independently built path.
    A self-test may inject a new disposable temporary root, never user input.
    """
    if not raw_root or not raw_temp or not os.path.isabs(raw_root) or not os.path.isabs(raw_temp):
        raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE")
    if ".." in Path(raw_root).parts or ".." in Path(raw_temp).parts:
        raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE")
    if trusted_temp is None:
        source = Path(__file__).resolve(strict=True)
        workspace = source.parents[1]
        # Fail closed if the expected GitHub work/repo/repo checkout shape moves.
        if workspace.name != workspace.parent.name:
            raise SystemExit("V025C_CI_LAYOUT_INVALID")
        temp = workspace.parent.parent / "_temp"
        if os.environ["GITHUB_WORKSPACE"] != str(workspace):
            raise SystemExit("V025C_CI_LAYOUT_INVALID")
    else:
        temp = trusted_temp
    expected = temp / "remote-commander-rollback-v025l"
    if os.path.normpath(raw_temp) != str(temp) or os.path.normpath(raw_root) != str(expected):
        raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE")
    try:
        if (not temp.is_dir() or temp.is_symlink()
                or not expected.is_dir() or expected.is_symlink()
                or temp.resolve(strict=True) != temp
                or expected.resolve(strict=True) != expected):
            raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE")
    except (OSError, ValueError):
        raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE") from None
    return expected

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
            sandbox = r / "remote-commander-rollback-v025l"
            sandbox.mkdir()
            assert validated_sandbox(str(sandbox), str(r), trusted_temp=r) == sandbox
            other = r / "other"
            other.mkdir()
            alias = r / "symlinked-sandbox"
            alias.symlink_to(sandbox, target_is_directory=True)
            rejected = [
                (str(other), str(r)),
                (str(alias), str(r)),
                (str(sandbox / ".." / sandbox.name), str(r)),
                (str(sandbox), str(r / "release")),
                ("/tmp", str(r)),
                ("relative/path", str(r)),
            ]
            for candidate, temp_root in rejected:
                try:
                    validated_sandbox(candidate, temp_root, trusted_temp=r)
                except SystemExit as failure:
                    assert str(failure) == "V025C_SANDBOX_IDENTITY_FAILURE"
                else:
                    raise AssertionError("unsafe CI cleanup path accepted")
        # Simulate the GitHub work/repo/repo checkout without touching a host
        # or trusting real RUNNER_TEMP. This checks the production authority
        # derivation, not only the injectable synthetic test helper.
        with tempfile.TemporaryDirectory(prefix="rc-v025c-layout-") as testing:
            work = Path(testing) / "work"
            checkout = work / "sample" / "sample"
            test_dir = checkout / "test"
            test_dir.mkdir(parents=True)
            fake_script = test_dir / "cleanup.py"
            fake_script.write_text("# isolated source layout\n")
            runner = work / "_temp"
            root = runner / "remote-commander-rollback-v025l"
            root.mkdir(parents=True)
            current_file = globals()["__file__"]
            old_workspace = os.environ.get("GITHUB_WORKSPACE")
            try:
                globals()["__file__"] = str(fake_script)
                os.environ["GITHUB_WORKSPACE"] = str(checkout)
                assert validated_sandbox(str(root), str(runner)) == root
                os.environ["GITHUB_WORKSPACE"] = str(checkout / "other")
                try:
                    validated_sandbox(str(root), str(runner))
                except SystemExit as failure:
                    assert str(failure) == "V025C_CI_LAYOUT_INVALID"
                else:
                    raise AssertionError("untrusted CI workspace accepted")
            finally:
                globals()["__file__"] = current_file
                if old_workspace is None:
                    os.environ.pop("GITHUB_WORKSPACE", None)
                else:
                    os.environ["GITHUB_WORKSPACE"] = old_workspace
        print("V025C_IDENTITY_PURE_TEST_PASS")
        return
    if os.getenv("CI") != "true" or not os.getenv("RUNNER_TEMP") or not os.getenv("GITHUB_WORKSPACE"):
        raise SystemExit("V025C_CI_ONLY")
    if not args.root:
        raise SystemExit("V025C_ROOT_REQUIRED")
    sandbox = validated_sandbox(args.root, os.environ["RUNNER_TEMP"])
    receipt = sandbox / "CLEANUP_V025C.json"
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
        # Persist a non-sensitive scope label, never the runner's absolute path.
        "externalNodeProcessesTouched": False,
        "sandboxLabel": "remote-commander-rollback-v025l"
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
