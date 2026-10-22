"""Opt-in timer stage cannot silently change live owner services."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("stage_update_timer.py")
spec = importlib.util.spec_from_file_location("timerstage", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@unittest.skipUnless(os.name == "posix", "Linux owner-only")
class TimerStageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.core = self.root / "core"
        self.core.mkdir()
        (self.core / "auto-update-linux.sh").write_text("#!/bin/bash\n")
        self.target = self.root / "candidate"

    def tearDown(self):
        self.tmp.cleanup()

    def test_stage_is_inert_and_opt_in_only(self):
        module.stage(self.core, self.target)
        self.assertEqual(sorted(x.name for x in self.target.iterdir()), sorted([module.SERVICE, module.TIMER]))
        service = (self.target / module.SERVICE).read_text()
        timer = (self.target / module.TIMER).read_text()
        self.assertIn(str(self.core / "auto-update-linux.sh"), service)
        self.assertIn("OnCalendar=daily", timer)
        self.assertIn("RandomizedDelaySec=45m", timer)
        self.assertNotIn("--no-promote", service)
        self.assertNotIn("systemctl", service + timer)
        self.assertNotIn("WantedBy=default.target", service)
        with self.assertRaisesRegex(ValueError, "DESTINATION_ALREADY_EXISTS"):
            module.stage(self.core, self.target)

    def test_missing_updater_and_symlink_rejected(self):
        (self.core / "auto-update-linux.sh").unlink()
        with self.assertRaisesRegex(ValueError, "UPDATER_NOT_PRESENT"):
            module.stage(self.core, self.target)
        self.assertFalse(self.target.exists())
        (self.core / "auto-update-linux.sh").symlink_to(self.root / "missing")
        with self.assertRaisesRegex(ValueError, "UPDATER_NOT_PRESENT"):
            module.stage(self.core, self.target)

    def test_untrusted_core_path_is_rejected(self):
        for bad in ("unsafe;name", "with%percent", 'with"quote'):
            directory = self.root / bad
            directory.mkdir()
            (directory / "auto-update-linux.sh").write_text("#!/bin/bash\n")
            with self.assertRaisesRegex(ValueError, "UNSAFE_CORE_PATH"):
                module.render(directory)

if __name__ == "__main__":
    unittest.main()
