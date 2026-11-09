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




def validated_sandbox(raw_root: str, raw_temp: str) -> Path:
    """Accept exactly one disposable Linux CI child, rejecting traversal and symlinks.


    Validate external path strings lexically and canonically *before* any file
    access, process enumeration or receipt write. The CLI argument is only an
    identity claim, never the authority for choosing a cleanup directory.
    """
    if not raw_root or not raw_temp or not os.path.isabs(raw_root) or not os.path.isabs(raw_temp):
        raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE")
    if ".." in Path(raw_root).parts or ".." in Path(raw_temp).parts:
        raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE")
    requested = os.path.normpath(raw_root)
    temp = os.path.normpath(raw_temp)
    expected = os.path.join(temp, "remote-commander-rollback-v025l")
    if requested != expected:
        raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE")
    try:
        if os.path.realpath(temp) != temp or os.path.realpath(expected) != expected:
            raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE")
        # Check the actual opened directory instead of a separate path probe.
        checked_fd = pin_sandbox_directory(Path(expected))
        os.close(checked_fd)
    except (OSError, ValueError):
        raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE") from None
    return Path(expected)




def pin_sandbox_directory(sandbox: Path):
    """Open every absolute ancestor without following symlinks.


    A last-component-only O_NOFOLLOW is insufficient when a writable
    ancestor could be replaced after lexical and realpath validation.
    """
    if not sandbox.is_absolute():
        raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open("/", flags)
    try:
        for component in sandbox.parts[1:]:
            if component in ("", ".", "..", "/"):
                raise SystemExit("V025C_SANDBOX_IDENTITY_FAILURE")
            child = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        import stat
        info = os.fstat(fd)
        if (info.st_uid != os.getuid() or not stat.S_ISDIR(info.st_mode)
                or info.st_mode & 0o022):
            raise SystemExit("V025C_SANDBOX_OWNER_INVALID")
        return fd
    except BaseException:
        os.close(fd)
        raise




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
            assert validated_sandbox(str(sandbox), str(r)) == sandbox
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
                    validated_sandbox(candidate, temp_root)
                except SystemExit as failure:
                    assert str(failure) == "V025C_SANDBOX_IDENTITY_FAILURE"
                else:
                    raise AssertionError("unsafe CI cleanup path accepted")
            # A symlink in an *ancestor*, not just the final sandbox,
            # cannot redirect the FD walk to another directory.
            private_parent = r / "private-real"
            private_parent.mkdir(mode=0o700)
            private_child = private_parent / "remote-commander-rollback-v025l"
            private_child.mkdir(mode=0o700)
            alias_parent = r / "private-alias"
            alias_parent.symlink_to(private_parent, target_is_directory=True)
            try:
                pin_sandbox_directory(alias_parent / private_child.name)
            except OSError:
                pass
            else:
                raise AssertionError("V025C_ANCESTOR_SYMLINK_ACCEPTED")
            print("V025C_ANCESTOR_SYMLINK_REJECT_PASS")
            # A substituted receipt symlink must fail rather than overwrite an
            # unrelated synthetic file outside the pinned sandbox directory.
            from unittest.mock import patch
            outside = r / "unrelated-owner-data.txt"
            outside.write_bytes(b"SYNTHETIC_OWNER_DATA_UNTOUCHED")
            fd = open_receipt_directory(sandbox)
            original_open = os.open
            injected = []


            def redirect_before_create(name, flags, mode=0o777, *, dir_fd=None):
                if name == "CLEANUP_V025C.json" and dir_fd == fd and not injected:
                    (sandbox / name).symlink_to(outside)
                    injected.append(True)
                return original_open(name, flags, mode, dir_fd=dir_fd)


            try:
                with patch("os.open", side_effect=redirect_before_create):
                    try:
                        write_receipt(fd, "{}\\n")
                    except FileExistsError:
                        pass
                    else:
                        raise AssertionError("replaced receipt was opened")
            finally:
                os.close(fd)
            assert len(injected) == 1
            assert outside.read_bytes() == b"SYNTHETIC_OWNER_DATA_UNTOUCHED"
            assert (sandbox / "CLEANUP_V025C.json").is_symlink()
            print("V025C_RECEIPT_SYMLINK_RACE_REJECT_PASS")
        print("V025C_IDENTITY_PURE_TEST_PASS")
        return
    if os.getenv("CI") != "true" or not os.getenv("RUNNER_TEMP") or not os.getenv("GITHUB_WORKSPACE"):
        raise SystemExit("V025C_CI_ONLY")
    if not args.root:
        raise SystemExit("V025C_ROOT_REQUIRED")
    sandbox = validated_sandbox(args.root, os.environ["RUNNER_TEMP"])
    # Pin the validated sandbox and keep this descriptor across the entire
    # bounded cleanup. The receipt cannot be redirected by swapping its path.
    root_fd = open_receipt_directory(sandbox)
    try:
        return perform_cleanup(sandbox, root_fd)
    finally:
        os.close(root_fd)




def open_receipt_directory(sandbox: Path):
    fd = pin_sandbox_directory(sandbox)
    try:
        if "CLEANUP_V025C.json" in os.listdir(fd):
            raise SystemExit("V025C_NO_BLIND_REWRITE")
        return fd
    except BaseException:
        os.close(fd)
        raise




def write_receipt(root_fd, payload):
    # Filename is fixed; O_EXCL and dir_fd pin both creation and destination.
    file_fd = os.open("CLEANUP_V025C.json",
                      os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                      0o600, dir_fd=root_fd)
    with os.fdopen(file_fd, "w", encoding="utf-8") as output:
        output.write(payload)




def perform_cleanup(sandbox: Path, root_fd):
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
    write_receipt(root_fd, payload)
    print("V025C_CLEANUP_STATUS=" + record["status"] + " receiptSha="
          + hashlib.sha256(payload.encode("utf-8")).hexdigest())
    if after:
        raise SystemExit(78)




if __name__ == "__main__":
    main()
