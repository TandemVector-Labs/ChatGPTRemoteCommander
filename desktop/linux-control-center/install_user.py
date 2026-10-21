#!/usr/bin/env python3
"""User-local, transactional Linux Control Center packaging (no Core/service changes).

--stage-dir produces an inert package for admission tests.
--install upgrades this user's existing Control Center, or installs one when
explicitly invoked. Caller must never treat packaging as release approval.
"""
from __future__ import annotations

import argparse
import os
import pwd
from pathlib import Path
import shutil
import stat
import tempfile

FILES = ("control_center.py", "dashboard_ui.py", "notion_panel.py")
DESKTOP_NAME = "io.github.god13emad.RemoteCommander.ControlCenter.desktop"


def _regular_owned(file: Path) -> bool:
    if file.is_symlink() or not file.is_file():
        return False
    st = file.stat()
    return stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and not st.st_mode & 0o022


def _private_dir(folder: Path) -> None:
    if folder.is_symlink() or not folder.is_dir() or folder.stat().st_uid != os.getuid():
        raise RuntimeError("UNTRUSTED_DESTINATION")
    if folder.stat().st_mode & 0o022:
        raise RuntimeError("UNSAFE_DESTINATION_PERMISSIONS")


def _system_owner_home() -> Path:
    """Use OS uid identity, not a caller-supplied HOME environment variable."""
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    if home.is_symlink() or not home.is_dir() or home.stat().st_uid != os.getuid():
        raise RuntimeError("UNTRUSTED_HOME")
    return home.resolve(strict=True)


def _validated_xdg_data_home() -> Path:
    """XDG override may only select a canonical owner-home descendant.

    A hostile environment may not redirect an updater into system paths,
    another user's directory, or a symlink-redirected tree.
    """
    owner = _system_owner_home()
    override = os.environ.get("XDG_DATA_HOME")
    # Stable updater packages target the fixed account-owned installation root.
    # An arbitrary XDG_DATA_HOME (even beneath the home directory) changes the
    # identity of the production application, inviting unreviewed path writes.
    # Fail closed rather than silently installing into a different location.
    fixed = owner / ".local" / "share"
    if not override:
        return fixed
    if not os.path.isabs(override):
        raise RuntimeError("XDG_DATA_HOME_MUST_BE_ABSOLUTE")
    requested = Path(os.path.abspath(override))
    real = Path(os.path.realpath(override))
    if requested != real or real != fixed:
        raise RuntimeError("UNSUPPORTED_XDG_DATA_HOME")
    return fixed


def _bounded_stage_target(requested: Path) -> Path:
    """Stage only into an already private, owner-controlled parent directory."""
    if not requested.is_absolute() or requested.name in ("", ".", ".."):
        raise RuntimeError("STAGE_PATH_INVALID")
    absolute = Path(os.path.abspath(requested))
    canonical = Path(os.path.realpath(requested))
    if absolute != canonical:
        raise RuntimeError("STAGE_PATH_SYMLINK_ANCESTOR")
    _private_dir(canonical.parent)
    return canonical


def desktop_entry(target: Path) -> str:
    script = target / "control_center.py"
    # Desktop Entry Exec quoting: double-quote paths that contain spaces or metacharacters.
    path = str(script)
    if any(c in path for c in ("\n", "\r", '"', "\\", "%")):
        raise RuntimeError("UNSAFE_DESKTOP_PATH")
    return (
        "[Desktop Entry]\nVersion=1.0\nType=Application\n"
        "Name=Remote Commander Control Center\n"
        "GenericName=Commander monitoring and Notion connection\n"
        "Comment=Owner-local profiles and Notion REST management\n"
        f'Exec=/usr/bin/python3 "{path}"\n'
        "TryExec=/usr/bin/python3\nIcon=remote-commander-control-center\n"
        "Terminal=false\nCategories=Utility;\nStartupNotify=true\n"
    )


def stage(source: Path, destination: Path, final_target: Path) -> None:
    if destination.exists() or destination.is_symlink():
        raise RuntimeError("STAGING_DESTINATION_EXISTS")
    _private_dir(destination.parent)
    for name in FILES:
        if not _regular_owned(source / name):
            raise RuntimeError("SOURCE_NOT_TRUSTED")
    destination.mkdir(mode=0o700)
    try:
        for name in FILES:
            content = (source / name).read_bytes()
            compile(content, name, "exec")
            target = destination / name
            target.write_bytes(content)
            target.chmod(0o600)
        file = destination / DESKTOP_NAME
        file.write_text(desktop_entry(final_target), encoding="utf-8")
        file.chmod(0o600)
    except BaseException:
        shutil.rmtree(destination)
        raise


def install(*, source: Path, data_home: Path) -> str:
    """Atomic rename of one owner-local GUI directory; retains recovery copy.

    No unattended service, browser, profile, or Git state is altered.
    """
    _private_dir(data_home)
    target = data_home / "remote-commander-control-center"
    launcher_dir = data_home / "applications"
    if launcher_dir.exists():
        _private_dir(launcher_dir)
    else:
        launcher_dir.mkdir(mode=0o700)
    launcher = launcher_dir / DESKTOP_NAME
    if target.exists() or target.is_symlink():
        _private_dir(target)
    if launcher.exists() or launcher.is_symlink():
        if not _regular_owned(launcher):
            raise RuntimeError("DESKTOP_ENTRY_NOT_OWNED")
        existing = launcher.read_text(encoding="utf-8")
        # Do not replace a third-party/custom desktop entry.
        expected = str(target / "control_center.py")
        if f"Exec=/usr/bin/python3 {expected}" not in existing and (
            f'Exec=/usr/bin/python3 "{expected}"' not in existing
        ):
            raise RuntimeError("DESKTOP_ENTRY_CONFLICT")
    if target.exists() and launcher.exists() and all(
        _regular_owned(target / name)
        and (target / name).read_bytes() == (source / name).read_bytes()
        for name in FILES
    ) and launcher.read_text(encoding="utf-8") == desktop_entry(target):
        return "LINUX_CONTROL_CENTER_ALREADY_CURRENT"
    stage_path = Path(tempfile.mkdtemp(prefix=".rc-cc-stage-", dir=data_home))
    stage_path.rmdir()
    stage(source, stage_path, target)
    backup = None
    launcher_temp = launcher_dir / (DESKTOP_NAME + ".staged")
    if launcher_temp.exists() or launcher_temp.is_symlink():
        shutil.rmtree(stage_path)
        raise RuntimeError("DESKTOP_ENTRY_STAGING_CONFLICT")
    try:
        launcher_temp.write_text((stage_path / DESKTOP_NAME).read_text(encoding="utf-8"), encoding="utf-8")
        launcher_temp.chmod(0o600)
        if target.exists():
            backup = Path(tempfile.mkdtemp(prefix=".rc-cc-backup-", dir=data_home))
            backup.rmdir()
            target.rename(backup)
        stage_path.rename(target)
        os.replace(launcher_temp, launcher)
    except BaseException:
        launcher_temp.unlink(missing_ok=True)
        if backup is not None and backup.exists():
            if target.exists():
                # Restore previous GUI when entry replacement failed.
                failed = Path(tempfile.mkdtemp(prefix=".rc-cc-failed-", dir=data_home))
                failed.rmdir()
                target.rename(failed)
            backup.rename(target)
        elif target.exists():
            # A new installation failed before its launcher could be installed.
            failed = Path(tempfile.mkdtemp(prefix=".rc-cc-failed-", dir=data_home))
            failed.rmdir()
            target.rename(failed)
        if stage_path.exists():
            shutil.rmtree(stage_path)
        raise
    # Prior bytes and receipt are retained in backup for explicit rollback.
    return "LINUX_CONTROL_CENTER_INSTALL_PASS"


def main() -> None:
    parser = argparse.ArgumentParser(description="Owner-local Control Center package")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--stage-dir", type=Path)
    group.add_argument("--install", action="store_true")
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    data_home = _validated_xdg_data_home()
    if args.install:
        print(install(source=source, data_home=data_home))
    else:
        dest = _bounded_stage_target(args.stage_dir)
        stage(source, dest, data_home / "remote-commander-control-center")
        print("LINUX_CONTROL_CENTER_STAGE_PASS")


if __name__ == "__main__":
    main()
