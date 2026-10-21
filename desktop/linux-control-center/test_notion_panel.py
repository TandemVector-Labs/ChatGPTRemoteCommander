"""No-real-credential contract tests for GTK Notion Control Center management."""
import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE = Path(__file__).with_name("notion_panel.py")
spec = importlib.util.spec_from_file_location("rc_notion_panel", MODULE)
panel = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = panel
spec.loader.exec_module(panel)


class NotionPanelTests(unittest.TestCase):
    def test_profile_argv_is_validated_and_credentials_are_never_arguments(self):
        for action in ("status", "verify", "connect", "disconnect"):
            args = panel.notion_command(action, "mmz-notion")
            self.assertEqual(Path(args[0]).name, "node")
            self.assertEqual(args[-2:], ["--profile", "mmz-notion"])
            self.assertNotIn("ntn_", " ".join(args))
        self.assertIn("--confirm-disconnect", panel.notion_command("disconnect", "default"))
        for profile in ("", "../owned", "a b", "x" * 81):
            with self.assertRaises(ValueError):
                panel.notion_command("status", profile)
        with self.assertRaises(ValueError):
            panel.notion_command("raw-http", "default")

    def test_standalone_gui_resolves_local_core_importer_and_managed_node(self):
        with tempfile.TemporaryDirectory(prefix="rc-npanel-install-") as temp:
            core = Path(temp) / "installed-core"
            importer = core / "tools/notion-pat-import.mjs"
            importer.parent.mkdir(parents=True)
            importer.write_text("fixture")
            runtime = core / ".runtime/node-current/bin/node"
            runtime.parent.mkdir(parents=True)
            runtime.write_text("fixture")
            with patch.object(panel, "_CORE_ROOT", core):
                args = panel.notion_command("status", "default")
                self.assertEqual(Path(args[0]), runtime)
                self.assertEqual(Path(args[1]), importer)
                self.assertEqual(args[-3:], ["--status", "--profile", "default"])

    def test_safe_state_output_is_bounded_and_exact(self):
        class Result:
            returncode = 0
            stdout = "NOTION_REST_STATUS CONNECTED PAT VAULT_READY\n"
            stderr = ""
        with patch.object(panel.subprocess, "run", return_value=Result()) as execute:
            self.assertIn("connected (PAT)", panel.notion_action("status", "default"))
            args, kwargs = execute.call_args
            self.assertNotIn("--token-stdin", args[0])
            self.assertEqual(kwargs["shell"], False)
            self.assertIsNone(kwargs["input"])

    def test_secret_is_only_sent_over_stdin_and_no_error_details_are_echoed(self):
        secret = "ntn_" + "x" * 48
        class Success:
            returncode = 0
            stdout = "NOTION_REST_PAT_VERIFIED_AND_SAVED_IN_OS_VAULT\n"
            stderr = ""
        with patch.object(panel.subprocess, "run", return_value=Success()) as execute:
            result = panel.notion_action("connect", "default", secret)
            self.assertIn("connected", result)
            args, kwargs = execute.call_args
            self.assertNotIn(secret, " ".join(args[0]))
            self.assertEqual(kwargs["input"], secret + "\n")
        class Bad:
            returncode = 1
            stdout = ""
            stderr = "synthetic credential content " + secret
        with patch.object(panel.subprocess, "run", return_value=Bad()):
            self.assertNotIn(secret, panel.notion_action("connect", "default", secret))
        with self.assertRaises(ValueError):
            panel.notion_action("connect", "default", "bad")
        with self.assertRaises(ValueError):
            panel.notion_action("status", "default", secret)

    def test_disconnect_requires_explicit_cli_confirmation(self):
        class Success:
            returncode = 0
            stdout = "NOTION_REST_DISCONNECTED\n"
            stderr = ""
        with patch.object(panel.subprocess, "run", return_value=Success()) as execute:
            result = panel.notion_action("disconnect", "Emad")
            self.assertIn("removed", result)
            self.assertIn("--confirm-disconnect", execute.call_args.args[0])
            self.assertNotIn("token", " ".join(execute.call_args.args[0]))

    def test_unknown_response_never_becomes_success(self):
        class Bad:
            returncode = 0
            stdout = "NOTION_REST_VERIFIED\nUNEXPECTED"
            stderr = ""
        with patch.object(panel.subprocess, "run", return_value=Bad()):
            self.assertNotIn("verified.", panel.notion_action("verify", "default"))
        with patch.object(panel.subprocess, "run",
                          side_effect=subprocess.TimeoutExpired(["node"], 1)):
            self.assertIn("unavailable", panel.notion_action("status", "default"))


if __name__ == "__main__":
    unittest.main()
