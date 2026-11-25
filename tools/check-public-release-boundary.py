#!/usr/bin/env python3
"""Fail-closed file-path boundary check for public Commander release ZIP assets.

Only the generic skills/remote-commander/SKILL.md may appear. This is not
a claim about opaque compiled EXE content or public Git history.
"""
from __future__ import annotations

import io
from pathlib import Path
import sys
import tempfile
from zipfile import BadZipFile, ZipFile

MAX_ZIP_ITEM = 64 * 1024 * 1024
MAX_NESTING = 4
FORBIDDEN_DIRS = frozenset({
    "extensions", "private-extensions", "commander-private-extensions",
    ".private", "private-packages", "personal-agents",
})
FORBIDDEN_FILES = frozenset({
    "agent.json", "commander-relay.mjs", "coucou-bridge.mjs",
    "config.local.json", "coucou.local.json",
})
ALLOWED_SKILL_DIR = "remote-commander"


def validate_path(raw: str, context: str) -> None:
    norm = raw.replace("\\", "/").rstrip("/")
    parts = norm.split("/")
    if not norm or any(p in ("", ".", "..") for p in parts) or norm.startswith("/"):
        raise ValueError(f"invalid artifact path: {context}: {raw!r}")
    lowered = [p.lower() for p in parts]
    if set(lowered) & FORBIDDEN_DIRS or lowered[-1] in FORBIDDEN_FILES:
        raise ValueError(f"private extension path forbidden: {context}: {raw!r}")
    if lowered[-1] == "skill.md":
        if len(lowered) < 3 or lowered[-3:] != [
            "skills", ALLOWED_SKILL_DIR, "skill.md"
        ]:
            raise ValueError(f"non-Core SKILL.md forbidden: {context}: {raw!r}")


def scan_zip(data: bytes, context: str, depth: int = 0) -> int:
    if depth > MAX_NESTING:
        raise ValueError(f"nested ZIP depth exceeded: {context}")
    total = 0
    try:
        with ZipFile(io.BytesIO(data), "r") as z:
            for info in z.infolist():
                validate_path(info.filename, context)
                if info.file_size > MAX_ZIP_ITEM:
                    raise ValueError(f"oversized ZIP member: {context}: {info.filename}")
                if info.create_system == 3 and ((info.external_attr >> 16) & 0o170000) == 0o120000:
                    raise ValueError(f"symlink ZIP member forbidden: {context}: {info.filename}")
                if info.is_dir():
                    continue
                total += 1
                if info.filename.lower().endswith(".zip"):
                    total += scan_zip(z.read(info), f"{context}!{info.filename}", depth + 1)
    except BadZipFile as exc:
        raise ValueError(f"invalid ZIP: {context}") from exc
    return total


def scan_release(root: Path) -> tuple[int, int]:
    if not root.is_dir() or root.is_symlink():
        raise ValueError("release directory must exist and not be a symlink")
    assets = 0
    zip_entries = 0
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root).as_posix()
        validate_path(rel, str(root))
        if p.is_symlink():
            raise ValueError(f"symlink in public artifact directory: {rel}")
        if p.is_dir():
            continue
        if not p.is_file():
            raise ValueError(f"unexpected nonfile artifact: {rel}")
        assets += 1
        if p.suffix.lower() == ".zip":
            zip_entries += scan_zip(p.read_bytes(), rel)
    if assets == 0:
        raise ValueError("empty release output is not accepted")
    return assets, zip_entries


def self_test() -> None:
    from zipfile import ZIP_DEFLATED
    with tempfile.TemporaryDirectory(prefix="rc-public-boundary-") as tmp:
        root = Path(tmp)
        def zipped(entries: dict[str, bytes]) -> bytes:
            buf = io.BytesIO()
            with ZipFile(buf, "w", compression=ZIP_DEFLATED) as z:
                for k, v in entries.items():
                    z.writestr(k, v)
            return buf.getvalue()
        good = zipped({"skills/remote-commander/SKILL.md": b"# public Commander\n"})
        (root / "plugin-template.zip").write_bytes(good)
        (root / "installer.zip").write_bytes(zipped({"plugin-template.zip": good}))
        assert scan_release(root) == (2, 3), "expected nested public skill"
        for invalid in (
            "extensions/secret/agent.json",
            "skills/comsol/SKILL.md",
            "packages/coucou-bridge/commander-relay.mjs",
            "../private/SKILL.md",
        ):
            (root / "installer.zip").write_bytes(zipped({invalid: b"fixture"}))
            try:
                scan_release(root)
            except ValueError:
                pass
            else:
                raise AssertionError(f"denied member was allowed: {invalid}")
        # ZIP symlinks are forbidden even under a public-looking path.
        from zipfile import ZipInfo
        link = ZipInfo("skills/remote-commander/SKILL.md")
        link.create_system = 3
        link.external_attr = 0o120777 << 16
        buf = io.BytesIO()
        with ZipFile(buf, "w") as archive:
            archive.writestr(link, b"../../private")
        (root / "installer.zip").write_bytes(buf.getvalue())
        try:
            scan_release(root)
        except ValueError:
            pass
        else:
            raise AssertionError("ZIP symlink was allowed")
        (root / "installer.zip").write_bytes(zipped({"nested.zip": zipped({
            "extensions/private/agent.json": b"fixture"
        })}))
        try:
            scan_release(root)
        except ValueError:
            pass
        else:
            raise AssertionError("nested private extension was allowed")
    print("RELEASE_BOUNDARY_SELF_TEST_PASS")


def main(argv: list[str]) -> int:
    try:
        if argv == ["--self-test"]:
            self_test()
        elif len(argv) == 1:
            assets, entries = scan_release(Path(argv[0]))
            print(f"RELEASE_BOUNDARY_PASS assets={assets} zip_members={entries}")
        else:
            raise ValueError("usage: check-public-release-boundary.py --self-test | RELEASE_DIR")
    except (AssertionError, ValueError, OSError) as exc:
        print(f"RELEASE_BOUNDARY_FAIL: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
