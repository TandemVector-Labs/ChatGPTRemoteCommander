#!/usr/bin/env python3
"""User-local, opt-in QA lifecycle for the portable read-only GTK preview.

Never modifies a real Commander installation, service, plugin, XDG autostart,
system binaries, API credentials, or desktop state. Not a public installer.
"""
import argparse
import hashlib
import json
import os
import re
import secrets
import stat
import sys
from pathlib import Path

FILES = frozenset({
    "control_center.py", "dashboard_ui.py", "notion_panel.py",
    "run-control-center.sh", "README.txt", "MANIFEST.json",
    "SHA256SUMS.txt", "manage-userlocal.py",
})
HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
ROOT_NAME = "RemoteCommander-ControlCenter-QA-Only"


def refuse(reason):
    raise ValueError("QA_FAIL_CLOSED_" + reason)


def ordinary(path: Path, directory=False):
    """Only same-user nonsymlink files/dirs, never delegated paths."""
    st = path.lstat()
    if st.st_uid != os.getuid() or not (
        stat.S_ISDIR(st.st_mode) if directory else stat.S_ISREG(st.st_mode)
    ):
        refuse("OWNER_OR_FILE_KIND")
    if st.st_mode & 0o022:
        refuse("WRITABLE_BY_OTHERS")
    return st


def home_root():
    home_text = os.environ.get("HOME")
    if not home_text or not Path(home_text).is_absolute() or home_text == "/":
        refuse("NO_PRIVATE_HOME")
    home = Path(home_text)
    # Reject aliases along the absolute HOME path, not only the final path.
    for parent in reversed((home, *home.parents)):
        if parent.is_symlink():
            refuse("SYMLINK_HOME")
    ordinary(home, directory=True)
    return home / ".local" / "share" / ROOT_NAME


def ensure_parents(prefix: Path):
    home = prefix.parents[2]
    ordinary(home, directory=True)
    for directory in [home / ".local", home / ".local" / "share", prefix]:
        if directory.is_symlink():
            refuse("SYMLINK_PARENT")
        if directory.exists():
            ordinary(directory, directory=True)
        else:
            directory.mkdir(mode=0o700)
            ordinary(directory, directory=True)


def read_payload(folder: Path):
    ordinary(folder, directory=True)
    names = set()
    raw = {}
    for child in folder.iterdir():
        if child.name not in FILES:
            refuse("UNKNOWN_MEMBER")
        ordinary(child)
        if child.stat().st_size > 1_048_576:
            refuse("OVERSIZED_MEMBER")
        names.add(child.name)
        raw[child.name] = child.read_bytes()
    if names != FILES:
        refuse("MEMBERS_INCOMPLETE")
    doc = json.loads(raw["MANIFEST.json"])
    if doc.get("schema") != 1 or doc.get("product") != "remote-commander-linux-control-center-qa-preview":
        refuse("MANIFEST_IDENTITY")
    if doc.get("installationPerformed") is not False or doc.get("nativeGuiAccepted") is not False:
        refuse("MANIFEST_AUTHORITY")
    commit = doc.get("sourceCommit")
    if not isinstance(commit, str) or not HEX40.fullmatch(commit):
        refuse("SOURCE_COMMIT")
    hashes = doc.get("files")
    if not isinstance(hashes, dict) or set(hashes) != FILES - {"MANIFEST.json", "SHA256SUMS.txt"}:
        refuse("MANIFEST_FILES")
    for file, digest in hashes.items():
        if not isinstance(digest, str) or not HEX64.fullmatch(digest):
            refuse("BAD_MANIFEST_HASH")
        if hashlib.sha256(raw[file]).hexdigest() != digest:
            refuse("COMPONENT_HASH")
    lines = raw["SHA256SUMS.txt"].decode("utf-8", errors="strict").splitlines()
    expected_names = FILES - {"SHA256SUMS.txt"}
    if len(lines) != len(expected_names):
        refuse("CHECKSUM_COUNT")
    seen = set()
    for line in lines:
        parts = line.split("  ", 1)
        if len(parts) != 2 or parts[1] not in expected_names or parts[1] in seen:
            refuse("CHECKSUM_FORMAT")
        seen.add(parts[1])
        if parts[0] != hashlib.sha256(raw[parts[1]]).hexdigest():
            refuse("CHECKSUM_MISMATCH")
    if seen != expected_names:
        refuse("CHECKSUM_INVENTORY")
    return doc


def remove_owned(folder: Path):
    read_payload(folder)
    for file in sorted(FILES):
        (folder / file).unlink()
    folder.rmdir()


def safe_children(prefix):
    if not prefix.exists() and not prefix.is_symlink():
        return
    ordinary(prefix, directory=True)
    if {x.name for x in prefix.iterdir()} - {"current", "previous"}:
        refuse("UNMANAGED_INSTALL_ROOT")
    for x in prefix.iterdir():
        read_payload(x)


def install(source: Path, prefix: Path):
    incoming = read_payload(source)
    safe_children(prefix)
    current, previous = prefix / "current", prefix / "previous"
    if current.exists():
        running = read_payload(current)
        if running["sourceCommit"] == incoming["sourceCommit"]:
            if running["files"] == incoming["files"]:
                print("QA_ALREADY_INSTALLED", incoming["sourceCommit"])
                return
            refuse("SAME_SOURCE_DIFFERENT_PAYLOAD")
        if previous.exists():
            refuse("PREVIOUS_MUST_BE_HANDLED")
    stage = prefix / (".stage-" + secrets.token_hex(12))
    stage.mkdir(mode=0o700)
    try:
        for file in sorted(FILES):
            destination = stage / file
            destination.write_bytes((source / file).read_bytes())
            destination.chmod(0o700 if file == "run-control-center.sh" else 0o600)
        read_payload(stage)
        if current.exists():
            os.replace(current, previous)
            try:
                os.replace(stage, current)
            except OSError:
                os.replace(previous, current)
                raise
        else:
            os.replace(stage, current)
        read_payload(current)
        print("QA_USERLOCAL_INSTALL_PASS", incoming["sourceCommit"])
    finally:
        if stage.exists():
            # Only remove files we created in this unique owner-private staging
            # path; preserve unknown user data and fail closed if contaminated.
            ordinary(stage, directory=True)
            for entry in list(stage.iterdir()):
                if entry.name not in FILES:
                    refuse("STAGING_CONTAMINATED")
                ordinary(entry)
                entry.unlink()
            stage.rmdir()


def rollback(prefix: Path):
    safe_children(prefix)
    cur, prev = prefix / "current", prefix / "previous"
    if not cur.is_dir() or not prev.is_dir():
        refuse("ROLLBACK_UNAVAILABLE")
    active, historical = read_payload(cur), read_payload(prev)
    temporary = prefix / (".swap-" + secrets.token_hex(12))
    os.replace(cur, temporary)
    try:
        os.replace(prev, cur)
        try:
            os.replace(temporary, prev)
        except OSError:
            os.replace(cur, prev)
            os.replace(temporary, cur)
            raise
    except OSError:
        if temporary.exists() and not cur.exists():
            os.replace(temporary, cur)
        raise
    print("QA_USERLOCAL_ROLLBACK_PASS", active["sourceCommit"], "->", historical["sourceCommit"])



def recover(prefix: Path):
    """Repair only verified, interrupted QA rename sequences. Never remove unknowns.

    Cannot infer user intent if more than one pending operation exists.
    """
    if not prefix.exists() and not prefix.is_symlink():
        print("QA_ALREADY_ABSENT")
        return
    ordinary(prefix, directory=True)
    names = {x.name for x in prefix.iterdir()}
    stages = [name for name in names if re.fullmatch(r"[.]stage-[0-9a-f]{24}", name)]
    swaps = [name for name in names if re.fullmatch(r"[.]swap-[0-9a-f]{24}", name)]
    if (len(stages) + len(swaps) > 1
            or names - {"current", "previous", *stages, *swaps}):
        refuse("AMBIGUOUS_QA_RECOVERY")
    current, previous = prefix / "current", prefix / "previous"
    if current.exists() or current.is_symlink():
        read_payload(current)
    if previous.exists() or previous.is_symlink():
        read_payload(previous)
    pending = prefix / (stages + swaps)[0] if (stages or swaps) else None
    if pending is not None:
        read_payload(pending)
    if stages:
        if not current.exists() and previous.exists():
            os.replace(previous, current)
        remove_owned(pending)
    elif swaps:
        if not previous.exists() and current.exists():
            os.replace(current, previous)
            os.replace(pending, current)
        elif previous.exists() and not current.exists():
            os.replace(pending, current)
        else:
            refuse("AMBIGUOUS_ROLLBACK_RECOVERY")
    elif not current.exists() and previous.exists():
        # A verified crash after upgrading current->previous but prior to
        # committing a replacement slot; restore the last accepted current.
        os.replace(previous, current)
    print("QA_USERLOCAL_RECOVER_PASS")

def uninstall(prefix: Path):
    safe_children(prefix)
    if not prefix.is_dir():
        print("QA_ALREADY_ABSENT")
        return
    for name in ("current", "previous"):
        p = prefix / name
        if p.exists():
            remove_owned(p)
    prefix.rmdir()
    print("QA_USERLOCAL_UNINSTALL_PASS")


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--install", action="store_true")
    group.add_argument("--rollback", action="store_true")
    group.add_argument("--uninstall", action="store_true")
    group.add_argument("--status", action="store_true")
    group.add_argument("--recover", action="store_true")
    parser.add_argument("--ack-qa-only", action="store_true")
    args = parser.parse_args()
    if not args.ack_qa_only:
        refuse("EXPLICIT_QA_ACK_REQUIRED")
    prefix = home_root()
    if args.install:
        source = Path(__file__).absolute().parent
        read_payload(source)
        ensure_parents(prefix)
        install(source, prefix)
    elif args.rollback:
        rollback(prefix)
    elif args.uninstall:
        uninstall(prefix)
    elif args.recover:
        recover(prefix)
    else:
        safe_children(prefix)
        data = read_payload(prefix / "current") if (prefix / "current").is_dir() else None
        print(json.dumps({"mode": "QA_SOURCE_PREVIEW", "installed": bool(data),
                          "sourceCommit": data.get("sourceCommit") if data else None,
                          "rollbackAvailable": (prefix / "previous").is_dir()}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, UnicodeError, json.JSONDecodeError) as error:
        print("QA_MANAGEMENT_REJECTED", str(error), file=sys.stderr)
        raise SystemExit(2)
