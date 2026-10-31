"""Native GTK4/libadwaita presentation only. Never acquires Commander input or shell authority.

All state is supplied by the existing bounded owner-private read-only functions
in control_center.py. UI refresh never executes workflows or parses code from JSON.
"""
from __future__ import annotations

import time
from typing import Callable

CSS = """
.rc-root { background: @window_bg_color; }
.rc-sidebar {
  background: @headerbar_bg_color;
  border-right: 1px solid alpha(@borders, .5);
  padding: 14px 6px;
}
.rc-nav-button {
  border-radius: 10px;
  padding: 12px 15px;
  margin: 2px 4px;
  font-weight: 620;
}
.rc-nav-active {
  background: alpha(@accent_bg_color, .18);
  color: @accent_color;
  font-weight: 750;
}
.rc-header-title { font-size: 19px; font-weight: 750; letter-spacing: -.3px; }
.rc-header-subtitle { font-size: 11px; opacity: .7; }
.rc-page-head { font-size: 25px; font-weight: 760; letter-spacing: -.45px; }
.rc-page-subhead { font-size: 13px; opacity: .69; }
.rc-hero {
  background: alpha(@accent_bg_color, .09);
  border: 1px solid alpha(@accent_bg_color, .20);
  border-radius: 20px; padding: 24px;
}
.rc-eyebrow { font-size: 10px; font-weight: 750; letter-spacing: 1.15px; opacity: .7; }
.rc-hero-heading { font-size: 22px; font-weight: 760; }
.rc-metric {
  background: @card_bg_color;
  border: 1px solid alpha(@borders, .55);
  border-radius: 17px; padding: 19px;
}
.rc-metric-label { font-size: 12px; font-weight: 650; opacity: .78; }
.rc-metric-value { font-size: 21px; font-weight: 760; letter-spacing: -.4px; }
.rc-metric-detail { font-size: 11px; opacity: .68; }
.rc-section-title { font-size: 16px; font-weight: 730; }
.rc-section-caption { font-size: 12px; opacity: .69; }
.rc-list-row { padding: 12px 16px; }
.rc-list-title { font-size: 14px; font-weight: 680; }
.rc-list-caption { font-size: 12px; opacity: .72; }
.rc-rule { padding: 16px; border: 1px solid alpha(@borders, .5);
  background: @card_bg_color; border-radius: 16px; }
.rc-success { color: #13875f; }
.rc-caution { color: #c67b21; }
.rc-danger { color: #c75252; }
.rc-quiet { opacity: .72; }
.rc-footer { font-size: 11px; opacity: .63; padding: 10px 16px; }
.rc-status-icon { margin-right: 6px; }
.rc-stale-indicator { border-radius: 12px; padding: 8px 12px; }
"""


def checked_count(value) -> str:
    """Never render untrusted/invalid counts as 0 or falsely as live."""
    if type(value) is int and 0 <= value <= 999999:
        return str(value)
    return "UNVERIFIED"


def state_label(state: object) -> tuple[str, str]:
    """Return explicit user-facing state and severity class, no invented PASS."""
    text = str(state if isinstance(state, str) else "UNVERIFIED").strip().upper()[:42]
    if text in {"CONNECTED", "READY", "ONLINE", "PASS"}:
        return text, "rc-success"
    if text in {"DISCONNECTED", "BLOCKED", "FAILED", "ERROR"}:
        return text, "rc-danger"
    return text or "UNVERIFIED", "rc-caution"


def profile_rows(rows: list[dict]) -> tuple[tuple[str, str, str], ...]:
    """Bound labels; never treat a routing file as permission to mutate Core."""
    if not isinstance(rows, list):
        return ()
    result = []
    for row in rows[:300]:
        if not isinstance(row, dict):
            continue
        name = str(row.get("id", "UNKNOWN"))[:64]
        version = str(row.get("version", "UNVERIFIED"))[:30]
        port = checked_count(row.get("port"))
        generation = checked_count(row.get("generation"))
        kind = row.get("type")
        if kind == "ACCOUNT_TUNNEL":
            detail = "Independent account tunnel · Core permission scope not yet verified"
        elif kind == "GUI_WORKER":
            detail = f"Owner GUI worker · local port {port} · separate GUI permission policy"
        else:
            detail = f"Core {version}  ·  port {port}  ·  generation {generation}"
        root = str(row.get("root") or "")[:160]
        result.append((name, detail, root))
    return tuple(result)


def workflow_rows(rows: list[dict]) -> tuple[tuple[str, str, str], ...]:
    if not isinstance(rows, list):
        return ()
    result = []
    for item in rows[:300]:
        if not isinstance(item, dict):
            continue
        ident = str(item.get("id", "UNKNOWN"))[:64]
        revision = checked_count(item.get("revision"))
        state, cls = state_label(item.get("state"))
        result.append((ident, f"{state}  ·  revision {revision}", cls))
    return tuple(result)


def run_dashboard(app_id: str,
                  monitor_source: Callable,
                  profile_source: Callable,
                  workflow_source: Callable,
                  followup_source: Callable,
                  dark_preference: Callable,
                  argv=None,
                  native_test_observer=None):
    import gi
    gi.require_version("Gtk", "4.0")
    gi.require_version("Adw", "1")
    from gi.repository import Adw, Gdk, Gio, GLib, Gtk

    def label(text="", css=None, *, wrap=True, selectable=False):
        text_widget = Gtk.Label(label=str(text), xalign=0, wrap=wrap, selectable=selectable)
        if css:
            text_widget.add_css_class(css)
        return text_widget

    def boxed(vertical=True, gap=8):
        return Gtk.Box(orientation=Gtk.Orientation.VERTICAL if vertical else Gtk.Orientation.HORIZONTAL,
                       spacing=gap)

    def section_heading(parent, heading, info):
        h = boxed(gap=3)
        h.append(label(heading, "rc-section-title"))
        h.append(label(info, "rc-section-caption"))
        parent.append(h)
        return h

    class Center(Adw.Application):
        def __init__(self):
            super().__init__(application_id=app_id, flags=Gio.ApplicationFlags.FLAGS_NONE)
            self.window = None
            self.stack = Gtk.Stack()
            self.stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
            self._card_labels = {}
            self.nav_buttons = {}
            self._profile_rows = ()
            self._workflow_rows = ()
            self._task_widgets = []
            self._style_installed = False
            self._timer = 0
            self._gnome_settings = None
            try:
                # Gio.Settings.new() aborts the process when the optional GNOME
                # schema is missing (e.g. minimal Xvfb CI). Query first.
                schemas = Gio.SettingsSchemaSource.get_default()
                found = (schemas.lookup("org.gnome.desktop.interface", True)
                         if schemas is not None else None)
                if found is not None:
                    self._gnome_settings = Gio.Settings.new("org.gnome.desktop.interface")
                    self._gnome_settings.connect("changed::color-scheme", self._os_theme_changed)
                    self._gnome_settings.connect("changed::gtk-theme", self._os_theme_changed)
            except (RuntimeError, ValueError, TypeError):
                self._gnome_settings = None

        def _select_nav(self, key):
            # UI-local page selection only; no workflow or Commander action.
            if key not in self.nav_buttons:
                return
            self.stack.set_visible_child_name(key)
            for name, button in self.nav_buttons.items():
                if name == key:
                    button.add_css_class("rc-nav-active")
                else:
                    button.remove_css_class("rc-nav-active")

        def _os_theme_changed(self, *_args):
            self.apply_system_theme()

        def apply_system_theme(self):
            pref = ""
            gtk_theme = ""
            try:
                if self._gnome_settings is not None:
                    pref = self._gnome_settings.get_string("color-scheme")
                    gtk_theme = self._gnome_settings.get_string("gtk-theme")
            except (RuntimeError, ValueError):
                pass
            import os
            dark = dark_preference(pref, gtk_theme, os.environ.get("GTK_THEME", ""))
            Adw.StyleManager.get_default().set_color_scheme(
                Adw.ColorScheme.FORCE_DARK if dark else Adw.ColorScheme.FORCE_LIGHT)

        def _install_css(self):
            if self._style_installed:
                return
            display = Gdk.Display.get_default()
            if display is None:
                return
            provider = Gtk.CssProvider()
            provider.load_from_data(CSS.encode("utf-8"))
            Gtk.StyleContext.add_provider_for_display(
                display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
            self._style_installed = True
            self._css_provider = provider

        @staticmethod
        def _clear(container):
            child = container.get_first_child()
            while child is not None:
                next_child = child.get_next_sibling()
                container.remove(child)
                child = next_child

        @staticmethod
        def _set_status(widget, value):
            display, style = state_label(value)
            widget.set_text(display)
            for old in ("rc-success", "rc-caution", "rc-danger"):
                widget.remove_css_class(old)
            widget.add_css_class(style)

        @staticmethod
        def _make_page():
            scroll = Gtk.ScrolledWindow()
            scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
            content = boxed(gap=20)
            content.set_margin_top(24)
            content.set_margin_bottom(30)
            content.set_margin_start(28)
            content.set_margin_end(28)
            scroll.set_child(content)
            return scroll, content

        @staticmethod
        def _list_box():
            rows = Gtk.ListBox()
            rows.set_selection_mode(Gtk.SelectionMode.NONE)
            rows.add_css_class("boxed-list")
            return rows

        @staticmethod
        def _list_row(title, subtitle, footnote=None, status_css=None):
            row = Gtk.ListBoxRow()
            row.set_activatable(False)
            row.set_selectable(False)
            shell = boxed(gap=4)
            shell.add_css_class("rc-list-row")
            title_widget = label(title, "rc-list-title", selectable=True)
            shell.append(title_widget)
            detail = label(subtitle, "rc-list-caption", selectable=True)
            if status_css:
                detail.add_css_class(status_css)
            shell.append(detail)
            if footnote:
                shell.append(label(footnote, "rc-list-caption", selectable=True))
            row.set_child(shell)
            return row

        def _metric(self, heading, default, description):
            card = boxed(gap=8)
            card.add_css_class("rc-metric")
            card.set_size_request(190, 124)
            card.append(label(heading, "rc-metric-label"))
            value = label(default, "rc-metric-value", selectable=True)
            card.append(value)
            detail = label(description, "rc-metric-detail")
            card.append(detail)
            self._card_labels[heading] = (value, detail)
            return card

        def _build_overview(self):
            hero = boxed(gap=9)
            hero.add_css_class("rc-hero")
            hero.append(label("OWNER-PRIVATE  •  LOCAL TELEMETRY", "rc-eyebrow"))
            hero.append(label("Commander at a glance", "rc-hero-heading"))
            hero.append(label(
                "Trusted local snapshot only. Unverified or expired evidence is never displayed as healthy.",
                "rc-page-subhead"))
            self.overview.append(hero)

            section_heading(self.overview, "System health", "Current local observations, not scheduled workflow claims")
            flow = Gtk.Grid()
            flow.set_column_homogeneous(True)
            flow.set_column_spacing(12)
            flow.set_row_spacing(12)
            flow.set_hexpand(True)
            for index, (title, initial, description) in enumerate([
                ("Connection", "UNVERIFIED", "Waiting for owner-private monitor"),
                ("Native GUI", "UNVERIFIED", "Input admission / STOP state"),
                ("Browser", "UNVERIFIED", "Background browser readiness"),
                ("Active operations", "UNVERIFIED", "Live only; not durable backlog"),
            ]):
                metric = self._metric(title, initial, description)
                metric.set_hexpand(True)
                metric.set_halign(Gtk.Align.FILL)
                flow.attach(metric, index % 2, index // 2, 1, 1)
            self.overview.append(flow)

            section_heading(self.overview, "Instance summary",
                            "Verified routing metadata and read-only SQLite, with no Core commands")
            section = boxed(gap=4)
            section.add_css_class("rc-rule")
            self.summary_line = label("Waiting for snapshot", "rc-list-title")
            self.summary_detail = label("No workflow has been executed by this interface.", "rc-list-caption")
            section.append(self.summary_line)
            section.append(self.summary_detail)
            self.overview.append(section)
            self.last_refreshed = label("Not refreshed", "rc-section-caption")
            self.overview.append(self.last_refreshed)

        def _build_profiles(self):
            self.profiles_page.append(label("Profiles", "rc-page-head"))
            self.profiles_page.append(label(
                "Canonical routing pairs only; this view cannot enroll, replace or delete profiles.",
                "rc-page-subhead"))
            self.profile_count = label("0 verified profiles", "rc-section-caption")
            self.profiles_page.append(self.profile_count)
            self.profile_list = self._list_box()
            self.profiles_page.append(self.profile_list)

        def _build_tasks(self):
            self.tasks_page.append(label("Workflows", "rc-page-head"))
            self.tasks_page.append(label(
                "Durable records are not active workers. Task mutations and ChatGPT delivery are disabled.",
                "rc-page-subhead"))
            self.task_search = Gtk.SearchEntry()
            self.task_search.set_placeholder_text("Filter workflow ID or state")
            self.task_search.set_hexpand(True)
            self.task_search.connect("search-changed", self._filter_tasks)
            self.tasks_page.append(self.task_search)
            self.workflow_count = label("Workflow metadata unavailable", "rc-section-caption")
            self.tasks_page.append(self.workflow_count)
            self.task_list = self._list_box()
            self.tasks_page.append(self.task_list)

            section_heading(self.tasks_page, "Local AI follow-up",
                            "Configuration metadata — not proof of a running timer")
            box = boxed(gap=6)
            box.add_css_class("rc-rule")
            self.ai_state = label("UNVERIFIED", "rc-list-title")
            self.ai_info = label("No authenticated same-conversation delivery proven.", "rc-list-caption")
            box.append(self.ai_state)
            box.append(self.ai_info)
            self.tasks_page.append(box)

        def _build_notion(self):
            from notion_panel import attach_notion_panel
            attach_notion_panel(self.notion_page, Gtk, GLib)

        def _build_security(self):
            self.security_page.append(label("Security & appearance", "rc-page-head"))
            self.security_page.append(label(
                "Owner-only application. System appearance follows GNOME and never modifies desktop settings.",
                "rc-page-subhead"))
            rules = [
                ("Owner-private input", "No symlinks or group/world-writable telemetry files accepted"),
                ("No browser login access", "No cookies, password store, API keys or browser-origin task commands"),
                ("No autonomous execution", "Workflow and profile management require an accepted authenticated Core IPC"),
                ("No false completion", "Expired monitor data and stored RUNNING state never prove a live worker"),
                ("Accessible state", "Unknown, blocked and disconnected values are shown as caution"),
            ]
            box = self._list_box()
            for title, note in rules:
                box.append(self._list_row(title, note))
            self.security_page.append(box)
            self.theme_detail = label("Following GNOME application color scheme", "rc-section-caption")
            self.security_page.append(self.theme_detail)

        def do_activate(self):
            if native_test_observer is not None:
                print("R42_PHASE_DO_ACTIVATE", flush=True)
            if self.window is not None:
                self.window.present()
                return
            self.apply_system_theme()
            self._install_css()
            self.window = Adw.ApplicationWindow(application=self)
            self.window.set_title("Remote Commander • Control Center")
            self.window.set_default_size(1190, 790)
            self.window.set_size_request(680, 510)
            root = boxed(gap=0)
            root.add_css_class("rc-root")
            bar = Adw.HeaderBar()
            titlebox = boxed(gap=2)
            titlebox.append(label("Remote Commander", "rc-header-title"))
            titlebox.append(label("Control Center  /  monitoring", "rc-header-subtitle"))
            bar.set_title_widget(titlebox)
            refresh = Gtk.Button(icon_name="view-refresh-symbolic")
            refresh.set_tooltip_text("Refresh read-only owner telemetry")
            refresh.update_property([Gtk.AccessibleProperty.LABEL], ["Refresh local Commander state"])
            refresh.connect("clicked", lambda *_: self.refresh())
            bar.pack_end(refresh)
            root.append(bar)

            workspace = boxed(vertical=False, gap=0)
            workspace.set_vexpand(True)
            sidebar = boxed(gap=14)
            sidebar.set_size_request(212, -1)
            sidebar.set_hexpand(False)
            self.sidebar = sidebar
            sidebar.add_css_class("rc-sidebar")
            sidebar.append(label("WORKSPACE", "rc-eyebrow"))
            # Explicit Native Gtk.Button navigation avoids the observed
            # StackSidebar X11 issue showing only the selected page despite
            # all four Gtk.StackPages reporting visible=True.
            navigator = boxed(gap=4)
            navigator.set_hexpand(False)
            for nav_key, nav_title in (
                ("overview", "Overview"),
                ("profiles", "Profiles"),
                ("tasks", "Workflows"),
                ("security", "Security"),
                ("notion", "Notion"),
            ):
                nav_button = Gtk.Button(label=nav_title)
                nav_button.add_css_class("flat")
                nav_button.add_css_class("rc-nav-button")
                # The sidebar must never consume the flexible content width.
                nav_button.set_hexpand(False)
                nav_button.set_halign(Gtk.Align.FILL)
                nav_button.set_tooltip_text("Show " + nav_title + " (read-only)")
                nav_button.update_property(
                    [Gtk.AccessibleProperty.LABEL], ["Show " + nav_title + " page"])
                nav_button.connect(
                    "clicked", lambda _btn, key=nav_key: self._select_nav(key))
                navigator.append(nav_button)
                self.nav_buttons[nav_key] = nav_button
            sidebar.append(navigator)
            sidebar.append(label("MONITORING + LOCAL NOTION", "rc-section-caption"))
            workspace.append(sidebar)
            self.stack.set_hexpand(True)
            self.stack.set_vexpand(True)
            self.overview_scroll, self.overview = self._make_page()
            self.profiles_scroll, self.profiles_page = self._make_page()
            self.tasks_scroll, self.tasks_page = self._make_page()
            self.security_scroll, self.security_page = self._make_page()
            self.notion_scroll, self.notion_page = self._make_page()
            for key, title, page in (
                ("overview", "Overview", self.overview_scroll),
                ("profiles", "Profiles", self.profiles_scroll),
                ("tasks", "Workflows", self.tasks_scroll),
                ("security", "Security", self.security_scroll),
                ("notion", "Notion", self.notion_scroll),
            ):
                page.set_visible(True)
                stack_page = self.stack.add_titled(page, key, title)
                stack_page.set_visible(True)
            # Monitoring tabs remain read-only. The opt-in Notion tab performs
            # only explicit owner-local REST credential actions, not workflows.
            self._select_nav("overview")
            self._build_overview()
            self._build_profiles()
            self._build_tasks()
            self._build_security()
            self._build_notion()
            workspace.append(self.stack)
            root.append(workspace)
            footer = label(
                "Local snapshot only  •  No automation execution  •  No credentials or browser session access",
                "rc-footer")
            footer.set_halign(Gtk.Align.CENTER)
            root.append(footer)
            if native_test_observer is not None:
                print("R42_PHASE_SET_CONTENT", flush=True)
            self.window.set_content(root)
            self._timer = GLib.timeout_add_seconds(5, self._tick)
            self.window.connect("destroy", self._window_destroyed)
            if native_test_observer is not None:
                print("R42_PHASE_BEFORE_REFRESH", flush=True)
            self.refresh()
            if native_test_observer is not None:
                print("R42_PHASE_BEFORE_PRESENT", flush=True)
            self.window.present()
            if native_test_observer is not None:
                print("R42_PHASE_AFTER_PRESENT", flush=True)
            # Synthetic CI-only callback supplied by the trusted fixture.
            # Production callers pass None; no Browser/Core mutation bridge.
            if native_test_observer is not None:
                native_test_observer(self)

        def _window_destroyed(self, *_args):
            self.window = None
            if self._timer:
                GLib.source_remove(self._timer)
                self._timer = 0

        def _tick(self):
            if self.window is None:
                return False
            self.refresh()
            return True

        def _filter_tasks(self, *_args):
            if not hasattr(self, "task_search"):
                return
            query = self.task_search.get_text().casefold().strip()
            for row, keywords in self._task_widgets:
                row.set_visible(not query or query in keywords)

        def _render_profiles(self, rows):
            if rows == self._profile_rows:
                return
            self._profile_rows = rows
            self._clear(self.profile_list)
            self.profile_count.set_text(f"{len(rows)} verified routing profile(s)")
            if not rows:
                self.profile_list.append(self._list_row(
                    "No accepted routing profiles", "No canonical matching state/runtime pair"))
                return
            for name, detail, root in rows:
                self.profile_list.append(self._list_row(name, detail, root))

        def _render_workflows(self, rows):
            if rows == self._workflow_rows:
                return
            self._workflow_rows = rows
            self._clear(self.task_list)
            self._task_widgets = []
            self.workflow_count.set_text(f"{len(rows)} persisted workflow record(s) · read-only")
            if not rows:
                self.task_list.append(self._list_row(
                    "No accessible workflow records", "Database missing, unavailable or empty"))
                return
            for ident, detail, cls in rows:
                row = self._list_row(ident, detail, status_css=cls)
                self.task_list.append(row)
                self._task_widgets.append((row, (ident + " " + detail).casefold()))
            self._filter_tasks()

        def refresh(self):
            try:
                snapshot = monitor_source()
                profile_data = profile_rows(profile_source())
                task_data = workflow_rows(workflow_source())
                ai = followup_source()
                if not isinstance(snapshot, dict):
                    snapshot = {"state": "UNVERIFIED"}
                if not isinstance(ai, dict):
                    ai = {"state": "UNVERIFIED"}
            except (ValueError, TypeError, OSError):
                snapshot = {"state": "UNVERIFIED"}
                profile_data = ()
                task_data = ()
                ai = {"state": "UNVERIFIED"}

            connection = snapshot.get("state", "UNVERIFIED")
            self._set_status(self._card_labels["Connection"][0], connection)
            self._card_labels["Connection"][1].set_text(
                str(snapshot.get("device") or "No accepted live device")[:100])
            self._set_status(self._card_labels["Native GUI"][0],
                             snapshot.get("gui", "UNVERIFIED"))
            self._card_labels["Native GUI"][1].set_text(
                str(snapshot.get("guiReason") or "Physical STOP/Mutex separate")[:100])
            self._set_status(self._card_labels["Browser"][0],
                             snapshot.get("browser", "UNVERIFIED"))
            self._card_labels["Browser"][1].set_text(
                str(snapshot.get("browserReason") or
                    "Background only; CEF validation separate")[:100])
            active = checked_count(snapshot.get("activeOperations"))
            value = self._card_labels["Active operations"][0]
            value.set_text(active)
            for css in ("rc-success", "rc-caution", "rc-danger"):
                value.remove_css_class(css)
            if active == "UNVERIFIED":
                value.add_css_class("rc-caution")
            self._render_profiles(profile_data)
            self._render_workflows(task_data)
            self.summary_line.set_text(
                f"{len(profile_data)} verified profile(s)   ·   {len(task_data)} workflow record(s)")
            self.summary_detail.set_text(
                f"Core {str(snapshot.get('version') or '?')[:24]}   ·   "
                f"Profile {str(snapshot.get('profile') or 'UNVERIFIED')[:48]}   ·   "
                "No local workflow actions performed")
            self.ai_state.set_text(str(ai.get("state", "UNVERIFIED"))[:54])
            self.ai_info.set_text(
                str(ai.get("timerLiveState", "UNVERIFIED_NO_SYSTEMD_QUERY"))[:80] +
                "   ·   Chat delivery NOT PROVEN")
            self.last_refreshed.set_text(
                "Local refresh  " + time.strftime("%H:%M:%S") +
                "  ·  View-only (no request to Core)")
    return Center().run((argv or [])[:1])
