"""Linux user-local GUI installation, rollback and no-live-effects tests."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("install_user.py")
spec = importlib.util.spec_from_file_location("rc_cc_install", SCRIPT)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


@unittest.skipUnless(os.name == "posix", "Linux owner-permission acceptance only")
class LocalControlCenterPackageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="rc-notion-install-")
        self.root = Path(self.tmp.name)
        self.home = self.root / "data"
        self.home.mkdir(mode=0o700)
        self.source = SCRIPT.parent
        self.target = self.home / "remote-commander-control-center"
        self.launcher = self.home / "applications" / installer.DESKTOP_NAME

    def tearDown(self):
        self.tmp.cleanup()

    def test_staging_is_inert_and_repeat_refuses_overwrite(self):
        dest = self.root / "stage"
        installer.stage(self.source, dest, self.target)
        self.assertEqual(sorted(n.name for n in dest.iterdir()),
                         sorted([*installer.FILES, installer.DESKTOP_NAME]))
        self.assertFalse(self.target.exists())
        self.assertFalse(self.launcher.exists())
        self.assertFalse(any(self.home.iterdir()))
        self.assertIn(str(self.target), (dest / installer.DESKTOP_NAME).read_text())
        with self.assertRaisesRegex(RuntimeError, "STAGING_DESTINATION_EXISTS"):
            installer.stage(self.source, dest, self.target)

    def test_install_then_retry_is_idempotent(self):
        self.assertEqual(installer.install(source=self.source, data_home=self.home),
                         "LINUX_CONTROL_CENTER_INSTALL_PASS")
        self.assertTrue(all((self.target / name).is_file() for name in installer.FILES))
        self.assertIn(str(self.target), self.launcher.read_text())
        self.assertEqual(installer.install(source=self.source, data_home=self.home),
                         "LINUX_CONTROL_CENTER_ALREADY_CURRENT")
        self.assertEqual(len(list(self.home.glob(".rc-cc-backup-*"))), 0)
        self.assertEqual(len(list(self.home.glob(".rc-cc-stage-*"))), 0)

    def test_existing_user_data_kept_as_backup(self):
        self.target.mkdir(mode=0o700)
        (self.target / "install-receipt.json").write_text('{"user":"historical"}')
        self.launcher.parent.mkdir(mode=0o700)
        self.launcher.write_text(installer.desktop_entry(self.target))
        self.launcher.chmod(0o600)
        self.assertEqual(installer.install(source=self.source, data_home=self.home),
                         "LINUX_CONTROL_CENTER_INSTALL_PASS")
        copies = list(self.home.glob(".rc-cc-backup-*"))
        self.assertEqual(len(copies), 1)
        self.assertEqual((copies[0] / "install-receipt.json").read_text(),
                         '{"user":"historical"}')
        self.assertTrue((self.target / "notion_panel.py").exists())

    def test_conflicting_launcher_and_symlink_fail_closed(self):
        self.launcher.parent.mkdir(mode=0o700)
        self.launcher.write_text("[Desktop Entry]\nExec=/bin/false\n")
        self.launcher.chmod(0o600)
        old = self.launcher.read_bytes()
        with self.assertRaisesRegex(RuntimeError, "DESKTOP_ENTRY_CONFLICT"):
            installer.install(source=self.source, data_home=self.home)
        self.assertEqual(self.launcher.read_bytes(), old)
        self.assertFalse(self.target.exists())
        self.target.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "UNTRUSTED_DESTINATION"):
            installer.install(source=self.source, data_home=self.home)

    def test_launcher_commit_failure_restores_existing_application(self):
        self.target.mkdir(mode=0o700)
        (self.target / "old.txt").write_text("baseline")
        self.launcher.parent.mkdir(mode=0o700)
        self.launcher.write_text(installer.desktop_entry(self.target))
        self.launcher.chmod(0o600)
        before = self.launcher.read_bytes()
        with patch.object(installer.os, "replace", side_effect=OSError("fixture launcher error")):
            with self.assertRaisesRegex(OSError, "fixture"):
                installer.install(source=self.source, data_home=self.home)
        self.assertEqual((self.target / "old.txt").read_text(), "baseline")
        self.assertEqual(self.launcher.read_bytes(), before)
        self.assertEqual(len(list(self.home.glob(".rc-cc-stage-*"))), 0)


if __name__ == "__main__":
    unittest.main()
