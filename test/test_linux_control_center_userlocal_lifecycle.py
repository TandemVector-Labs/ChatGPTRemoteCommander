"""Synthetic, no-privilege lifecycle tests for the Linux GTK QA-only slot."""
import hashlib
import json
import os
import importlib.util
from unittest.mock import patch
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "tools/build-linux-control-center-preview.py"
FILES = {"control_center.py", "dashboard_ui.py", "notion_panel.py",
         "run-control-center.sh", "README.txt", "MANIFEST.json",
         "SHA256SUMS.txt", "manage-userlocal.py"}


class UserLocalLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="rc-gtk-userlocal-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.home = self.base / "home"
        self.home.mkdir(mode=0o700)
        self.scope = self.home / ".local/share/RemoteCommander-ControlCenter-QA-Only"
        bundle = self.base / "bundle.zip"
        r = subprocess.run([sys.executable, str(BUILD), "--output", str(bundle)],
                           capture_output=True, text=True, timeout=15)
        self.assertEqual(r.returncode, 0, r.stderr)
        with zipfile.ZipFile(bundle) as archive:
            archive.extractall(self.base / "unpacked")
        (self.source,) = list((self.base / "unpacked").iterdir())
        self.cli = self.source / "manage-userlocal.py"
        self.env = {**os.environ, "HOME": str(self.home)}

    def run_manager(self, flag, *, source=None, ack=True):
        args = [sys.executable, str((source or self.source) / "manage-userlocal.py"), flag]
        if ack:
            args.append("--ack-qa-only")
        return subprocess.run(args, env=self.env, capture_output=True, text=True, timeout=8)

    def assert_ok(self, flag, *, source=None):
        r = self.run_manager(flag, source=source)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def test_install_noop_uninstall_with_no_core_mutation(self):
        no_ack = self.run_manager("--install", ack=False)
        self.assertEqual(no_ack.returncode, 2)
        self.assertFalse(self.scope.exists())
        self.assertIn("QA_USERLOCAL_INSTALL_PASS", self.assert_ok("--install").stdout)
        self.assertIn("QA_ALREADY_INSTALLED", self.assert_ok("--install").stdout)
        current = self.scope / "current"
        self.assertEqual({p.name for p in current.iterdir()}, FILES)
        r = self.assert_ok("--status")
        self.assertTrue(json.loads(r.stdout)["installed"])
        r = subprocess.run(["sh", str(current / "run-control-center.sh"), "--audit"],
                           env=self.env, capture_output=True, text=True, timeout=8)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(json.loads(r.stdout)["workflowControlEnabled"])
        self.assertFalse((self.home / ".config").exists())
        self.assertFalse((self.home / ".local/share/ChatGPTRemoteCommander").exists())
        self.assertIn("QA_USERLOCAL_UNINSTALL_PASS", self.assert_ok("--uninstall").stdout)
        self.assertFalse(self.scope.exists())
        self.assertIn("QA_ALREADY_ABSENT", self.assert_ok("--uninstall").stdout)

    def test_updated_slot_rollback_and_uninstall(self):
        self.assert_ok("--install")
        next_source = self.base / "synthetic-update"
        shutil.copytree(self.source, next_source)
        manifest = next_source / "MANIFEST.json"
        data = json.loads(manifest.read_text())
        first = data["sourceCommit"]
        updated = ("f" if first[0] != "f" else "e") + first[1:]
        data["sourceCommit"] = updated
        manifest.write_text(json.dumps(data, sort_keys=True, indent=2) + "\n")
        sums = next_source / "SHA256SUMS.txt"
        sums.write_text("".join(
            hashlib.sha256((next_source / name).read_bytes()).hexdigest() + "  " + name + "\n"
            for name in sorted(FILES - {"SHA256SUMS.txt"})
        ))
        self.assertIn("QA_USERLOCAL_INSTALL_PASS", self.assert_ok("--install", source=next_source).stdout)
        self.assertEqual(json.loads((self.scope / "current/MANIFEST.json").read_text())["sourceCommit"], updated)
        self.assertEqual(json.loads((self.scope / "previous/MANIFEST.json").read_text())["sourceCommit"], first)
        self.assertIn("QA_USERLOCAL_ROLLBACK_PASS", self.assert_ok("--rollback").stdout)
        self.assertEqual(json.loads((self.scope / "current/MANIFEST.json").read_text())["sourceCommit"], first)
        self.assertEqual(json.loads((self.scope / "previous/MANIFEST.json").read_text())["sourceCommit"], updated)
        self.assert_ok("--uninstall")
        self.assertFalse(self.scope.exists())

    def test_mutation_and_symlink_refused_without_deletion(self):
        self.assert_ok("--install")
        c = self.scope / "current"
        p = c / "README.txt"
        p.write_text("user data must remain")
        r = self.run_manager("--uninstall")
        self.assertEqual(r.returncode, 2)
        self.assertEqual(p.read_text(), "user data must remain")
        self.assertTrue(c.exists())

    def test_home_missing_or_symlink_is_rejected_before_any_write(self):
        no_home = dict(self.env)
        no_home.pop("HOME", None)
        r = subprocess.run([sys.executable, str(self.cli), "--install", "--ack-qa-only"],
                           env=no_home, capture_output=True, text=True, timeout=8)
        self.assertEqual(r.returncode, 2)
        alias = self.base / "home-link"
        alias.symlink_to(self.home, target_is_directory=True)
        r = subprocess.run([sys.executable, str(self.cli), "--install", "--ack-qa-only"],
                           env={**self.env, "HOME": str(alias)},
                           capture_output=True, text=True, timeout=8)
        self.assertEqual(r.returncode, 2)
        self.assertFalse(self.scope.exists())

    def test_failed_second_promotion_rename_restores_accepted_current(self):
        self.assert_ok("--install")
        current = self.scope / "current"
        original = json.loads((current / "MANIFEST.json").read_text())["sourceCommit"]
        update = self.base / "failed-promote-update"
        shutil.copytree(self.source, update)
        manifest = update / "MANIFEST.json"
        document = json.loads(manifest.read_text())
        document["sourceCommit"] = ("a" if original[0] != "a" else "b") + original[1:]
        manifest.write_text(json.dumps(document, sort_keys=True, indent=2) + "\n")
        (update / "SHA256SUMS.txt").write_text("".join(
            hashlib.sha256((update / name).read_bytes()).hexdigest() + "  " + name + "\n"
            for name in sorted(FILES - {"SHA256SUMS.txt"})
        ))
        spec = importlib.util.spec_from_file_location("gtk_qa_manager", self.cli)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        replace = module.os.replace
        injected = []

        def fail_second(source, destination):
            if Path(destination) == current and Path(source).name.startswith(".stage-"):
                injected.append(True)
                raise OSError("simulated atomic promote failure")
            return replace(source, destination)

        with patch.object(module.os, "replace", side_effect=fail_second):
            with self.assertRaises(OSError):
                module.install(update, self.scope)
        self.assertEqual(len(injected), 1)
        self.assertEqual(
            json.loads((current / "MANIFEST.json").read_text())["sourceCommit"],
            original,
        )
        self.assertEqual({x.name for x in self.scope.iterdir()}, {"current"})
        self.assert_ok("--uninstall")

    def test_recover_verifiable_interrupted_upgrade_without_touching_core(self):
        self.assert_ok("--install")
        current = self.scope / "current"
        original = json.loads((current / "MANIFEST.json").read_text())["sourceCommit"]
        stage = self.scope / (".stage-" + "1" * 24)
        shutil.copytree(self.source, stage)
        os.replace(current, self.scope / "previous")
        r = self.assert_ok("--recover")
        self.assertIn("QA_USERLOCAL_RECOVER_PASS", r.stdout)
        self.assertEqual(json.loads((current / "MANIFEST.json").read_text())["sourceCommit"], original)
        self.assertEqual({x.name for x in self.scope.iterdir()}, {"current"})
        self.assert_ok("--uninstall")

    def test_recover_rollback_first_rename_and_refuse_corrupt_pending(self):
        self.assert_ok("--install")
        current = self.scope / "current"
        original = json.loads((current / "MANIFEST.json").read_text())["sourceCommit"]
        previous = self.scope / "previous"
        shutil.copytree(current, previous)
        pending = self.scope / (".swap-" + "2" * 24)
        os.replace(current, pending)
        self.assertIn("QA_USERLOCAL_RECOVER_PASS", self.assert_ok("--recover").stdout)
        self.assertEqual(json.loads((current / "MANIFEST.json").read_text())["sourceCommit"], original)
        self.assertTrue(previous.is_dir())
        self.assertFalse(pending.exists())
        self.assert_ok("--uninstall")
        self.assert_ok("--install")
        stage = self.scope / (".stage-" + "3" * 24)
        stage.mkdir(mode=0o700)
        foreign = stage / "UNMANAGED.txt"
        foreign.write_text("never delete me")
        r = self.run_manager("--recover")
        self.assertEqual(r.returncode, 2)
        self.assertEqual(foreign.read_text(), "never delete me")
        self.assertTrue((self.scope / "current").is_dir())

    def test_recover_rollback_second_rename_restores_original_order(self):
        self.assert_ok("--install")
        current = self.scope / "current"
        accepted = json.loads((current / "MANIFEST.json").read_text())["sourceCommit"]
        old = self.scope / "previous"
        shutil.copytree(current, old)
        pending = self.scope / (".swap-" + "4" * 24)
        os.replace(current, pending)
        os.replace(old, current)
        self.assert_ok("--recover")
        self.assertEqual({x.name for x in self.scope.iterdir()}, {"current", "previous"})
        self.assertEqual(
            json.loads((current / "MANIFEST.json").read_text())["sourceCommit"],
            accepted,
        )
        self.assertEqual(
            json.loads((old / "MANIFEST.json").read_text())["sourceCommit"],
            accepted,
        )
        self.assert_ok("--uninstall")

    def test_unmanaged_qa_root_prevents_install_and_deletion(self):
        self.scope.mkdir(parents=True, mode=0o700)
        foreign = self.scope / "OWNER_NOTES.txt"
        foreign.write_text("preserve")
        r = self.run_manager("--install")
        self.assertEqual(r.returncode, 2)
        self.assertEqual(foreign.read_text(), "preserve")
        r = self.run_manager("--uninstall")
        self.assertEqual(r.returncode, 2)
        self.assertEqual(foreign.read_text(), "preserve")

    def test_dangling_source_symlink_refused_and_protects_existing(self):
        self.assert_ok("--install")
        p = self.source / "README.txt"
        p.unlink()
        p.symlink_to(self.base / "no-such-file")
        r = self.run_manager("--install")
        self.assertEqual(r.returncode, 2)
        self.assertFalse((self.base / "no-such-file").exists())
        self.assertTrue((self.scope / "current").is_dir())


if __name__ == "__main__":
    unittest.main()
