"""Owner-local Notion REST connection management for the native GTK Control Center.

No user token is accepted in argv, logs, clipboard or profile files.
The only credential storage is the Node engine's per-profile OS vault.
"""
from __future__ import annotations

import re
import subprocess
import threading
from pathlib import Path

_PROFILE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
_PAT = re.compile(r"^[A-Za-z0-9._-]{24,512}$")
_EXPECTED_STATUS = re.compile(
    r"^NOTION_REST_STATUS (CONNECTED|DISCONNECTED) (PAT|OAUTH|NONE) VAULT_(READY|UNAVAILABLE)$"
)
_IMPORTER = (Path(__file__).resolve().parents[2] / "tools" / "notion-pat-import.mjs").resolve()


def notion_command(action: str, profile: str) -> list[str]:
    if not isinstance(profile, str) or not _PROFILE.fullmatch(profile):
        raise ValueError("NOTION_PROFILE_INVALID")
    actions = {
        "status": ["--status"],
        "verify": ["--verify"],
        "connect": ["--token-stdin"],
        "disconnect": ["--disconnect", "--confirm-disconnect"],
    }
    if action not in actions:
        raise ValueError("NOTION_ACTION_INVALID")
    if not _IMPORTER.is_file() or _IMPORTER.is_symlink():
        raise RuntimeError("NOTION_IMPORTER_UNAVAILABLE")
    return ["node", str(_IMPORTER), *actions[action], "--profile", profile]


def notion_action(action: str, profile: str, token: str | None = None) -> str:
    args = notion_command(action, profile)
    if action == "connect":
        if not isinstance(token, str) or not _PAT.fullmatch(token):
            raise ValueError("NOTION_PAT_INVALID_FORMAT")
    elif token is not None:
        raise ValueError("NOTION_UNEXPECTED_CREDENTIAL")
    try:
        result = subprocess.run(
            args, input=(token + "\n" if action == "connect" else None),
            capture_output=True, text=True, timeout=27,
            check=False, shell=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "Notion operation unavailable; no successful action confirmed."
    # Only exact, predefined markers may be reflected into the UI.
    output = result.stdout.strip()[:180]
    if result.returncode != 0:
        return "Notion operation failed. Check the local vault, token, or permission."
    if action == "status":
        match = _EXPECTED_STATUS.fullmatch(output)
        if match is None:
            return "Notion status could not be verified."
        state, credential, vault = match.groups()
        if vault == "UNAVAILABLE":
            return "Notion REST vault unavailable (unlock the user keyring)."
        if state == "DISCONNECTED":
            return "Notion REST disconnected for this Commander profile."
        return f"Notion REST connected ({credential}); select Verify for a live check."
    if action == "verify" and output == "NOTION_REST_VERIFIED":
        return "Notion REST live API access verified."
    if action == "connect" and output == "NOTION_REST_PAT_VERIFIED_AND_SAVED_IN_OS_VAULT":
        return "Notion REST connected. Credential stored in this user's OS vault."
    if action == "disconnect" and output == "NOTION_REST_DISCONNECTED":
        return "Local Notion REST credential removed. Hosted MCP remains independent."
    return "Notion operation returned an unexpected result; status not confirmed."


def attach_notion_panel(parent, Gtk, GLib):
    """Render within the main Control Center's existing GTK stack, without CLI shells."""
    def note(text: str):
        widget = Gtk.Label(label=text, xalign=0, wrap=True)
        widget.set_selectable(False)
        return widget

    parent.append(note("Notion connection & management"))
    parent.append(note(
        "REST Personal Access Token is separate from hosted Notion MCP. "
        "Each Commander profile uses its own OS user vault. "
        "Only the owner can authorize Notion pages; writes remain disabled by default."
    ))
    portal = Gtk.LinkButton.new_with_label(
        "https://app.notion.com/developers/tokens", "Create a Notion REST token"
    )
    portal.set_halign(Gtk.Align.START)
    parent.append(portal)

    parent.append(note("Commander profile"))
    profile = Gtk.Entry()
    profile.set_text("default")
    profile.set_max_length(80)
    profile.set_tooltip_text("Separate Notion REST connection for each Commander profile.")
    parent.append(profile)

    parent.append(note("Notion REST Personal Access Token (masked, never logged)"))
    secret = Gtk.PasswordEntry()
    secret.set_hexpand(True)
    parent.append(secret)

    confirm = Gtk.CheckButton(label="Confirm removing the local REST credential for this profile")
    parent.append(confirm)
    status = note("Select Check status to read this profile's local REST connection state.")
    parent.append(status)

    controls = Gtk.FlowBox()
    controls.set_selection_mode(Gtk.SelectionMode.NONE)
    controls.set_max_children_per_line(4)
    parent.append(controls)
    buttons = {}
    busy = [False]

    def finish(message: str):
        status.set_text(message[:250])
        busy[0] = False
        for widget in buttons.values():
            widget.set_sensitive(True)
        return False

    def perform(action: str):
        if busy[0]:
            return
        selected = profile.get_text().strip()
        token = secret.get_text() if action == "connect" else None
        # Clear the GTK input before the worker receives the temporary string.
        secret.set_text("")
        if not _PROFILE.fullmatch(selected):
            status.set_text("Invalid Commander profile.")
            return
        if action == "connect" and (token is None or not _PAT.fullmatch(token)):
            status.set_text("Invalid Notion token format.")
            return
        if action == "disconnect":
            if not confirm.get_active():
                status.set_text("Select the explicit disconnect confirmation first.")
                return
            confirm.set_active(False)
        busy[0] = True
        status.set_text("Checking Notion..." if action != "disconnect" else "Removing local REST credential...")
        for widget in buttons.values():
            widget.set_sensitive(False)

        def worker():
            try:
                message = notion_action(action, selected, token)
            except (ValueError, RuntimeError):
                message = "Notion action unavailable for the selected profile."
            GLib.idle_add(finish, message)
        threading.Thread(target=worker, daemon=True, name="rc-notion-ui-action").start()

    for title, action in (
        ("Check status", "status"),
        ("Verify access", "verify"),
        ("Connect", "connect"),
        ("Disconnect", "disconnect"),
    ):
        button = Gtk.Button(label=title)
        button.set_tooltip_text("Notion REST for the selected Commander profile")
        button.connect("clicked", lambda _button, operation=action: perform(operation))
        controls.insert(button, -1)
        buttons[action] = button
