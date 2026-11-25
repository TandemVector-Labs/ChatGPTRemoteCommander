import ast
import importlib.util
import pathlib
import unittest

P = pathlib.Path(__file__).with_name("dashboard_ui.py")
spec = importlib.util.spec_from_file_location("r32_dash_ui", P)
ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui)

class DashboardPresentationTests(unittest.TestCase):
    def test_addon_cards_are_read_only_and_planned(self):
        items = [{"id": "colibri", "name": "Colibri MoE",
                  "state": "PLANNED", "platformSupported": True,
                  "installable": False},
                 {"id": "ufo2", "name": "UFO2",
                  "state": "PLANNED", "platformSupported": False,
                  "installable": False},
                 {"id": "untrusted", "name": "Invalid",
                  "state": "INSTALLED", "installable": True}]
        rows = ui.addon_rows(items)
        self.assertEqual(len(rows), 2)
        self.assertIn("install disabled", rows[0][1])
        self.assertIn("not supported", rows[1][1])
        self.assertEqual(ui.addon_rows({}), ())

    def test_healthy_state_exact_only(self):
        for v in ("CONNECTED", "READY", "ONLINE", "PASS"):
            self.assertEqual(ui.state_label(v)[1], "rc-success")
        for v in ("UNKNOWN", "UNVERIFIED", "STALE", "RUNNING", "WAITING", None):
            self.assertEqual(ui.state_label(v)[1], "rc-caution")
    def test_blocked_and_failed_are_not_ok(self):
        for v in ("FAILED", "ERROR", "DISCONNECTED", "BLOCKED"):
            self.assertEqual(ui.state_label(v)[1], "rc-danger")
    def test_counts_reject_spoof_and_bool(self):
        for v in (True, False, 0.3, -1, None, "15", {}, 10_000_000):
            self.assertEqual(ui.checked_count(v), "UNVERIFIED")
        self.assertEqual(ui.checked_count(0), "0")
        self.assertEqual(ui.checked_count(300), "300")
    def test_profiles_truncated_and_never_mutated(self):
        data = [{"id":"default","port":48832,"version":"0.10.20","generation":34,"root":"/tmp/test"}]
        original = repr(data)
        rows = ui.profile_rows(data)
        self.assertEqual(rows[0][0], "default")
        self.assertIn("48832", rows[0][1])
        self.assertEqual(data.__repr__(), original)
        self.assertEqual(ui.profile_rows([{"id":"x","port":"48832"}])[0][1].count("UNVERIFIED"), 3)
    def test_renamed_profile_retains_technical_identity_in_presentation(self):
        data=[{"id":"default","displayName":"My Workstation","version":"0.12.0",
               "port":47831,"generation":43}]
        row=ui.profile_rows(data)[0]
        self.assertEqual(row[0],"My Workstation")
        self.assertIn("Profile ID: default",row[1])
        self.assertEqual(data[0]["id"],"default")

    def test_label_editor_is_independent_of_core_actions(self):
        source=P.read_text()
        for marker in ["display_name_updater", "Save display name",
                       "self._save_profile_display", "Technical profile ID, Tunnel and permissions never change"]:
            self.assertIn(marker,source)
        self.assertNotIn("Core.Mutate",source)

    def test_persisted_running_is_not_live_green(self):
        rows = ui.workflow_rows([{"id":"w1","revision":4,"state":"RUNNING"}, {"id":"w2","revision":0,"state":"FAILED"}])
        self.assertEqual(rows[0][2],"rc-caution")
        self.assertEqual(rows[1][2],"rc-danger")
    def test_rows_bound_to_300(self):
        many=[{"id":str(i),"state":"WAITING"} for i in range(700)]
        self.assertEqual(len(ui.workflow_rows(many)),300)
        self.assertEqual(len(ui.profile_rows(many)),300)
    def test_missing_optional_gnome_schema_guard_precedes_settings_ctor(self):
        source=P.read_text()
        guard=source.index('schemas = Gio.SettingsSchemaSource.get_default()')
        check=source.index('schemas.lookup("org.gnome.desktop.interface", True)')
        construct=source.index('self._gnome_settings = Gio.Settings.new("org.gnome.desktop.interface")')
        self.assertLess(guard, check)
        self.assertLess(check, construct)
        self.assertIn('if found is not None:', source)
        self.assertIn('self._gnome_settings = None', source)

    def test_balanced_two_by_two_metrics_and_six_visible_navigation_pages(self):
        source=P.read_text()
        self.assertIn("flow = Gtk.Grid()", source)
        self.assertIn("flow.set_column_homogeneous(True)", source)
        self.assertIn("flow.attach(metric, index % 2, index // 2, 1, 1)", source)
        add_index=source.index("stack_page = self.stack.add_titled(page, key, title)")
        nav_index=source.index('self._select_nav("overview")')
        self.assertLess(add_index, nav_index)
        self.assertIn("page.set_visible(True)", source)
        self.assertIn("stack_page.set_visible(True)", source)
        self.assertIn('self.stack.set_visible_child_name(key)', source)
        self.assertIn("self.nav_buttons[nav_key] = nav_button", source)
        self.assertIn("navigator.append(nav_button)", source)
        self.assertNotIn("Gtk.StackSidebar()", source)

    def test_optional_synthetic_test_hook_is_disabled_in_real_app(self):
        source=P.read_text()
        self.assertIn("native_test_observer=None", source)
        self.assertIn("if native_test_observer is not None:", source)
        self.assertLess(source.index("self.window.present()"),
                        source.index("native_test_observer(self)"))
        self.assertIn("self.sidebar = sidebar", source)
        self.assertIn("sidebar.set_hexpand(False)", source)
        self.assertIn("navigator.set_hexpand(False)", source)
        self.assertIn("nav_button.set_hexpand(False)", source)
        self.assertNotIn("native_test_observer=", P.with_name("control_center.py").read_text())

    def test_native_geometry_diagnostic_uses_supported_gtk4_get_width(self):
        source=P.with_name("preview_fixture.py").read_text()
        self.assertIn("center.sidebar.get_width()", source)
        self.assertIn("center.stack.get_width()", source)
        self.assertNotIn("center.sidebar.get_allocated_width()", source)
        self.assertIn("GLib.timeout_add(180, report)", source)
        self.assertIn("attempts[0] < 12", source)
        self.assertIn("R47_ALLOCATION_TIMEOUT_AFTER_12_FRAMES", source)

    def test_presentation_never_imports_shell_or_network(self):
        source=P.read_text()
        tree=ast.parse(source)
        imports=set()
        for node in ast.walk(tree):
            if isinstance(node,ast.Import):
                imports.update(a.name.split(".")[0] for a in node.names)
            if isinstance(node,ast.ImportFrom) and node.module:
                imports.add(node.module.split(".")[0])
        self.assertFalse(imports & {"subprocess","socket","requests","urllib","http","webbrowser","shutil"})
        self.assertNotIn("os.system(", source)
        self.assertNotIn("exec(", source)
        self.assertNotIn("Gtk.Button.set_accessible_name", source)
    def test_refresh_cannot_execute_core_commands(self):
        source=P.read_text()
        self.assertIn('Gtk.SearchEntry()',source)
        self.assertIn('self._render_profiles(profile_data, raw_profiles)',source)
        self.assertIn('self._render_workflows(task_data)',source)
        self.assertIn('if rows == self._workflow_rows:',source)
        self.assertNotIn("LaunchPowerShellTool",source)
        self.assertNotIn("self.stack.get_visible_child_name()",source)

if __name__ == "__main__":
    unittest.main(verbosity=2)
