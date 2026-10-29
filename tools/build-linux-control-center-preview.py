#!/usr/bin/env python3
"""Deterministic, non-installing Linux GTK Control Center QA preview bundle.

This builder NEVER writes to an installed Commander, XDG directory or host
configuration. A successful archive build is NOT native GUI or release approval.
"""
import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# The QA preview has one official artifact basename; callers select the directory.
QA_ARCHIVE_NAME = "Remote-Commander-Linux-Control-Center-QA.zip"
SOURCES = (
    "desktop/linux-control-center/control_center.py",
    "desktop/linux-control-center/dashboard_ui.py",
    "desktop/linux-control-center/notion_panel.py",
)
LAUNCHER = """#!/bin/sh
set -eu
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
exec /usr/bin/python3 -B "$HERE/control_center.py" "$@"
"""


def checked_git(*args):
    result = subprocess.run(
        ["git", "-C", str(ROOT), *args],
        capture_output=True, text=True, timeout=12, check=True,
    )
    return result.stdout.strip()


def open_private_output_parent(parent: Path):
    """Walk each absolute parent component without following intermediate links.

    Opening the entire path with O_NOFOLLOW protects only its final component;
    pin every ancestor descriptor to prevent redirects through an earlier one.
    """
    if not parent.is_absolute():
        raise ValueError("OUTPUT_PARENT_NOT_ABSOLUTE")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open("/", flags)
    try:
        for component in parent.parts[1:]:
            if component in ("", ".", "..", "/"):
                raise ValueError("OUTPUT_PARENT_INVALID_COMPONENT")
            child_fd = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = child_fd
        actual = os.fstat(fd)
        if (actual.st_uid != os.getuid() or not stat.S_ISDIR(actual.st_mode)
                or actual.st_mode & 0o022):
            raise ValueError("OUTPUT_DIRECTORY_UNTRUSTED")
        return fd
    except BaseException:
        os.close(fd)
        raise


def pack(output: Path):
    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    stable_semver = re.fullmatch(r"\d+\.\d+\.\d+", version)
    dev_semver = re.fullmatch(r"0\.11\.0-(?:dev|rc)\.[1-9][0-9]*", version)
    if dev_semver:
        release_train_path = ROOT / "docs/release-train-0.11.json"
        if not release_train_path.is_file():
            raise ValueError("INVALID_SOURCE_VERSION")
        release_train = json.loads(release_train_path.read_text(encoding="utf-8"))
        if (
            release_train.get("sourceVersion") != version
            or release_train.get("isStable") is not False
            or release_train.get("publishApproved") is not False
            or release_train.get("autoupdateApproved") is not False
            or release_train.get("installedPromotionApproved") is not False
        ):
            raise ValueError("UNACCEPTED_DEV_RELEASE_TRAIN")
    elif not stable_semver:
        raise ValueError("INVALID_SOURCE_VERSION")
    commit = checked_git("rev-parse", "HEAD^{commit}")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("INVALID_SOURCE_COMMIT")
    # Only historical commit time: no wall-clock timestamp in artifact bytes.
    epoch = max(315532800, int(checked_git("show", "-s", "--format=%ct", "HEAD")))
    timestamp = time.gmtime(epoch)[:6]
    prefix = f"Remote-Commander-Control-Center-Linux-v{version}-preview/"
    entries = {}
    for src in SOURCES:
        path = ROOT / src
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 1024 * 1024:
            raise ValueError("UNSAFE_SOURCE_FILE " + src)
        entries[Path(src).name] = path.read_bytes()
    entries["manage-userlocal.py"] = (ROOT / "tools/manage-linux-control-center-qa.py").read_bytes()
    entries["run-control-center.sh"] = LAUNCHER.encode("utf-8")
    entries["README.txt"] = (
        f"Remote Commander Linux Control Center v{version} (QA SOURCE PREVIEW)\n"
        f"Exact repository source commit: {commit}\n"
        "This is a portable read-only preview, NOT a public Linux installer.\n"
        "Optional QA lifecycle (explicit consent): python3 manage-userlocal.py --install --ack-qa-only\n"
        "After QA: python3 manage-userlocal.py --uninstall --ack-qa-only\n"
        "Interrupted QA rename recovery: python3 manage-userlocal.py --recover --ack-qa-only\n"
        "Rollback previous QA slot: python3 manage-userlocal.py --rollback --ack-qa-only\n"
        "No service, desktop entry, credential, profile, system file or auto-update is installed.\n"
        "Run: sh ./run-control-center.sh --audit (no native GUI required).\n"
        "For manual GTK4/Adwaita testing: sh ./run-control-center.sh\n"
        "Requirements: Linux, /usr/bin/python3, PyGObject, GTK4 and libadwaita.\n"
        "The Notion panel requires independent owner opt-in and the separately qualified Core.\n"
        "Never claim authenticated GUI control or native release acceptance from archive checks.\n"
    ).encode("utf-8")
    manifest = {
        "schema": 1,
        "product": "remote-commander-linux-control-center-qa-preview",
        "version": version,
        "sourceCommit": commit,
        "installationPerformed": False,
        "nativeGuiAccepted": False,
        "files": {name: hashlib.sha256(raw).hexdigest()
                  for name, raw in sorted(entries.items())},
    }
    entries["MANIFEST.json"] = (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode("utf-8")
    entries["SHA256SUMS.txt"] = "".join(
        f"{hashlib.sha256(raw).hexdigest()}  {name}\n"
        for name, raw in sorted(entries.items())
    ).encode("utf-8")
    # Pin the intended output parent and create a brand-new member exclusively.
    # The filename is only the final component, never an unchecked relative path.
    parent_fd = open_private_output_parent(output.parent)
    try:
        if output.name != QA_ARCHIVE_NAME:
            raise ValueError("OUTPUT_NAME_INVALID")
        flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        descriptor = os.open(QA_ARCHIVE_NAME, flags, 0o600, dir_fd=parent_fd)
        with os.fdopen(descriptor, "w+b") as output_stream:
            with zipfile.ZipFile(output_stream, "w", compression=zipfile.ZIP_DEFLATED,
                                 compresslevel=9) as dest:
                for member, raw in sorted(entries.items()):
                    info = zipfile.ZipInfo(prefix + member, date_time=timestamp)
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.external_attr = (0o755 if member.endswith(".sh") else 0o644) << 16
                    info.create_system = 3
                    dest.writestr(info, raw, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
            output_stream.flush()
            output_stream.seek(0)
            digest = hashlib.file_digest(output_stream, "sha256").hexdigest()
    finally:
        os.close(parent_fd)
    print(
        f"LINUX_CONTROL_CENTER_QA_BUNDLE_PASS version={version} commit={commit}"
        f" members={len(entries)} sha256={digest}"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        pack(Path(os.path.abspath(args.output)))
    except (OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        print("LINUX_CONTROL_CENTER_QA_BUNDLE_FAIL " + str(e), file=sys.stderr)
        sys.exit(2)
