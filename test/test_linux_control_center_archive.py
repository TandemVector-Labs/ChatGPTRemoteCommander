"""Regression suite for source-pinned, non-installing Linux GTK preview archive."""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILDER = ROOT / "tools/build-linux-control-center-preview.py"
SOURCES = {"control_center.py", "dashboard_ui.py", "notion_panel.py"}
OTHER = {"run-control-center.sh", "README.txt", "MANIFEST.json", "SHA256SUMS.txt", "manage-userlocal.py"}


def build(output):
    return subprocess.run(
        [sys.executable, str(BUILDER), "--output", str(output)],
        capture_output=True, text=True, timeout=20,
    )


class LinuxGtkPreviewArchiveTests(unittest.TestCase):
    def test_build_repeatability_inventory_hashes_and_readonly_audit(self):
        with tempfile.TemporaryDirectory(prefix="rc-gtk-qa-") as t:
            root = pathlib.Path(t)
            one, two = root / "one.zip", root / "two.zip"
            for dest in (one, two):
                r = build(dest)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertIn("LINUX_CONTROL_CENTER_QA_BUNDLE_PASS", r.stdout)
            self.assertEqual(hashlib.sha256(one.read_bytes()).digest(),
                             hashlib.sha256(two.read_bytes()).digest())
            with zipfile.ZipFile(one) as archive:
                names = archive.namelist()
                self.assertEqual(len(names), len(SOURCES | OTHER))
                self.assertEqual(len(set(names)), len(names))
                self.assertEqual({pathlib.PurePosixPath(n).name for n in names}, SOURCES | OTHER)
                self.assertTrue(all(not n.startswith("/") and ".." not in pathlib.PurePosixPath(n).parts
                                    for n in names))
                by_name = {pathlib.PurePosixPath(name).name: archive.read(name) for name in names}
                sha_lines = by_name["SHA256SUMS.txt"].decode().splitlines()
                self.assertEqual(len(sha_lines), 7)
                for line in sha_lines:
                    sha, filename = line.split("  ", 1)
                    self.assertEqual(sha, hashlib.sha256(by_name[filename]).hexdigest())
                manifest = json.loads(by_name["MANIFEST.json"])
                expected = subprocess.check_output(
                    ["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True,
                ).strip()
                self.assertEqual(manifest["sourceCommit"], expected)
                self.assertFalse(manifest["installationPerformed"])
                self.assertFalse(manifest["nativeGuiAccepted"])
                self.assertEqual(set(manifest["files"]), SOURCES | {"run-control-center.sh", "README.txt", "manage-userlocal.py"})
                for name, sha in manifest["files"].items():
                    self.assertEqual(sha, hashlib.sha256(by_name[name]).hexdigest())
                archive.extractall(root / "extract")
            folder, = list((root / "extract").iterdir())
            home = root / "home"
            home.mkdir()
            r = subprocess.run(
                ["sh", str(folder / "run-control-center.sh"), "--audit"],
                capture_output=True, text=True, timeout=10,
                env={**os.environ, "HOME": str(home), "XDG_DATA_HOME": str(root / "xdgdata"),
                     "XDG_CONFIG_HOME": str(root / "xdgconfig")},
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            audit = json.loads(r.stdout)
            self.assertEqual(audit["mode"], "READ_ONLY_CANDIDATE")
            self.assertFalse(audit["workflowControlEnabled"])
            self.assertFalse(audit["credentialAccess"])
            self.assertEqual(list(home.iterdir()), [])
            self.assertFalse((root / "xdgdata").exists())
            self.assertFalse((root / "xdgconfig").exists())

    def test_refuse_existing_output_and_symlink(self):
        with tempfile.TemporaryDirectory(prefix="rc-gtk-negative-") as t:
            root = pathlib.Path(t)
            dest = root / "existing.zip"
            dest.write_bytes(b"USER_WORK_MUST_REMAIN")
            r = build(dest)
            self.assertEqual(r.returncode, 2)
            self.assertEqual(dest.read_bytes(), b"USER_WORK_MUST_REMAIN")
            sym = root / "alias.zip"
            sym.symlink_to(dest)
            r = build(sym)
            self.assertEqual(r.returncode, 2)
            self.assertEqual(dest.read_bytes(), b"USER_WORK_MUST_REMAIN")
            dangling = root / "dangling.zip"
            dangling.symlink_to(root / "no-file.zip")
            r = build(dangling)
            self.assertEqual(r.returncode, 2)
            self.assertTrue(dangling.is_symlink())
            self.assertFalse((root / "no-file.zip").exists())


if __name__ == "__main__":
    unittest.main()
