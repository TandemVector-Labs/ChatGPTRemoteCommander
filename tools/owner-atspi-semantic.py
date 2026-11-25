#!/usr/bin/python3
"""Bounded owner-session AT-SPI semantics. Never sends pointer/keyboard or reads values."""
import json
import os
import re
import sys
import time

import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi

MAX_NODES = 900
MAX_DEPTH = 18
MAX_CHILDREN = 120
READ_ROLES = {"entry", "text", "combo box", "search box"}
ACT_ROLES = {"button", "push button"}
DENY = ("password", "passcode", "secret", "token", "api key", "credit card")


def fail(code):
    raise ValueError("ATSPI_" + code)


def assert_owner_pid(pid):
    # Existing owner-session helper, not a cross-account GUI bridge.
    # /proc PID ownership may fail closed for non-dumpable targets.
    try:
        process_uid = os.stat("/proc/{}".format(pid)).st_uid
    except OSError:
        fail("OWNER_PID_UNAVAILABLE")
    if process_uid != os.geteuid():
        fail("OWNER_UID_MISMATCH")


# A browser is identified from a real same-UID AT-SPI process, never a caller-selected default.
# Do not use CDP, browser profiles or the password manager for this semantic route.
BROWSER_APP = re.compile(
    r"^(?:firefox|brave(?:[ ._-]?browser)?(?:[.]desktop)?|"
    r"google[ ._-]?chrome|chrome|chromium|msedge|"
    r"microsoft[ ._-]?edge|vivaldi|opera)(?:[ ._-].*)?$", re.I)


def owner_frame(pid, window_title):
    if not isinstance(pid, int) or not 1 <= pid <= 2147483647:
        fail("PID_INVALID")
    if not isinstance(window_title, str) or len(window_title) > 300:
        fail("TITLE_INVALID")
    assert_owner_pid(pid)
    desktop = Atspi.get_desktop(0)
    apps = []
    for i in range(min(desktop.get_child_count(), 100)):
        app = desktop.get_child_at_index(i)
        if app.get_process_id() == pid:
            apps.append(app)
    if len(apps) != 1 or not BROWSER_APP.fullmatch((apps[0].get_name() or "").strip()):
        fail("OWNER_BROWSER_PID_UNVERIFIED")
    frames = []
    for i in range(min(apps[0].get_child_count(), 30)):
        node = apps[0].get_child_at_index(i)
        name = (node.get_name() or "").strip()
        # Firefox AT-SPI frame labels omit the compositor's " — Mozilla Firefox".
        if name and (name == window_title or window_title.startswith(name + " — ") or
                     window_title.startswith(name + " - ")):
            frames.append((i, node))
    if len(frames) != 1:
        fail("OWNER_WINDOW_AMBIGUOUS_OR_CHANGED")
    assert_owner_pid(pid)
    return frames[0]


def by_path(root, path):
    if not isinstance(path, list) or len(path) > MAX_DEPTH or not path:
        fail("SELECTOR_INVALID")
    current = root
    for index in path:
        if not isinstance(index, int) or not 0 <= index < MAX_CHILDREN:
            fail("SELECTOR_INVALID")
        if index >= current.get_child_count():
            fail("ELEMENT_CHANGED")
        current = current.get_child_at_index(index)
    return current


def assert_control(node, expected_role, expected_name):
    role = node.get_role_name()
    name = (node.get_name() or "").strip()
    if not isinstance(expected_role, str) or role != expected_role:
        fail("ELEMENT_ROLE_CHANGED")
    if not isinstance(expected_name, str) or name != expected_name or len(name) < 2:
        fail("ELEMENT_NAME_CHANGED")
    if any(block in name.lower() for block in DENY):
        fail("SENSITIVE_ELEMENT_REFUSED")
    return role, name


def snapshot(frame):
    queue = [([], frame)]
    records = []
    seen = 0
    while queue and seen < MAX_NODES:
        path, node = queue.pop(0)
        seen += 1
        # Browser accessibility trees change while pages load; a child can disappear.
        if node is None:
            continue
        role = node.get_role_name()
        name = (node.get_name() or "").strip()
        if len(name) >= 2 and len(name) <= 160 and not any(v in name.lower() for v in DENY):
            editable = role in READ_ROLES and bool(node.is_editable_text())
            actionable = role in ACT_ROLES and bool(node.is_action())
            if editable or actionable:
                act = node.get_action_iface() if actionable else None
                acts = [act.get_action_name(i) for i in range(min(act.get_n_actions(), 4))] if act else []
                records.append({
                    "path": path, "role": role, "name": name,
                    "editable": editable,
                    "action": ("click" if "click" in acts else "press" if "press" in acts else None)
                })
                if len(records) >= 80:
                    break
        if len(path) < MAX_DEPTH:
            count = min(node.get_child_count(), MAX_CHILDREN)
            for i in range(count):
                child = node.get_child_at_index(i)
                if child is not None:
                    queue.append((path + [i], child))
    return {"ok": True, "controls": records, "truncated": bool(queue),
            "nodesVisited": seen, "valuesRead": False, "monitorCoordinatesUsed": False}


def execute(request):
    if not isinstance(request, dict):
        fail("INPUT_INVALID")
    pid = request.get("pid")
    title = request.get("windowTitle")
    _, frame = owner_frame(pid, title)
    command = request.get("command")
    if command == "snapshot":
        return snapshot(frame)
    path = request.get("path")
    node = by_path(frame, path)
    role, name = assert_control(node, request.get("expectedRole"), request.get("expectedName"))
    if command == "type":
        if role not in READ_ROLES or not node.is_editable_text():
            fail("NOT_EDITABLE")
        text = request.get("text")
        if not isinstance(text, str) or not 1 <= len(text) <= 1024 or "\x00" in text:
            fail("TEXT_INVALID")
        # No reading of the previous value; avoids cookies/credentials.
        result = node.get_editable_text_iface().set_text_contents(text)
        return {"ok": bool(result), "effect": "DISPATCHED" if result else "NOT_CONFIRMED",
                "valueRead": False}
    if command == "invoke":
        if role not in ACT_ROLES or not node.is_action():
            fail("NOT_BUTTON")
        action = node.get_action_iface()
        methods = [action.get_action_name(i) for i in range(min(action.get_n_actions(), 4))]
        matches = [i for i, x in enumerate(methods) if x in ("click", "press")]
        if len(matches) != 1:
            fail("ACTION_AMBIGUOUS")
        result = action.do_action(matches[0])
        return {"ok": bool(result), "effect": "DISPATCHED" if result else "NOT_CONFIRMED"}
    fail("UNKNOWN_COMMAND")


if __name__ == "__main__":
    try:
        data = sys.stdin.read(12000)
        request = json.loads(data)
        result = execute(request)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        code = str(error)
        if not code.startswith("ATSPI_"):
            code = "ATSPI_NATIVE_UNVERIFIED_" + type(error).__name__
        print(json.dumps({"ok": False, "error": code, "effect": "UNKNOWN"}))
        sys.exit(2)
