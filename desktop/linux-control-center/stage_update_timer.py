#!/usr/bin/env python3
"""Prepare a reversible owner-local systemd auto-update timer; never enable it.

No user unit, active service, Core installation, browser or credentials are
modified. Installer owners may review the staged files and opt-in separately.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import stat

SERVICE = "chatgpt-remote-commander-update.service"
TIMER = "chatgpt-remote-commander-update.timer"


def render(core: Path) -> tuple[str, str]:
    script = core / "auto-update-linux.sh"
    if not core.is_absolute() or not script.is_absolute():
        raise ValueError("CORE_PATH_NOT_ABSOLUTE")
    name = str(script)
    if any(x in name for x in ('"', "'", "\\", "\n", "\r", "%", ";")):
        raise ValueError("UNSAFE_CORE_PATH")
    if not script.is_file() or script.is_symlink():
        raise ValueError("UPDATER_NOT_PRESENT")
    service = (
        "[Unit]\nDescription=Remote Commander owner-local stable update\n"
        "ConditionACPower=true\n"
        "[Service]\nType=oneshot\n"
        f'ExecStart=/bin/bash "{name}"\n'
        "NoNewPrivileges=true\nPrivateTmp=true\n"
        "UMask=0077\n"
        "TimeoutStartSec=3600\n"
    )
    timer = (
        "[Unit]\nDescription=Remote Commander stable update schedule (explicit opt-in)\n"
        "[Timer]\nOnCalendar=daily\nRandomizedDelaySec=45m\n"
        "Persistent=true\nUnit=" + SERVICE + "\n"
        "[Install]\nWantedBy=timers.target\n"
    )
    return service, timer


def stage(core: Path, dest: Path) -> None:
    if dest.exists() or dest.is_symlink():
        raise ValueError("DESTINATION_ALREADY_EXISTS")
    if not dest.parent.is_dir() or dest.parent.is_symlink():
        raise ValueError("INVALID_PARENT")
    owner = dest.parent.stat()
    if owner.st_uid != os.getuid() or owner.st_mode & 0o022:
        raise ValueError("UNSAFE_PARENT")
    service, timer = render(core)
    dest.mkdir(mode=0o700)
    for filename, text in ((SERVICE, service), (TIMER, timer)):
        file = dest / filename
        file.write_text(text, encoding="utf-8")
        file.chmod(stat.S_IRUSR | stat.S_IWUSR)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--core", type=Path, required=True)
    parser.add_argument("--stage-dir", type=Path, required=True)
    args = parser.parse_args()
    stage(args.core, args.stage_dir)
    print("RC_UPDATE_TIMER_STAGE_ONLY_PASS: NOT_INSTALLED_NOT_ENABLED")


if __name__ == "__main__":
    main()
