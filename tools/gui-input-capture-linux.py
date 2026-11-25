#!/usr/bin/env python3
"""Owner-session XDG InputCapture v1 adapter for Commander V1.

This process never synthesizes input. Physical EIS events are observed only as
metadata and discarded. Desktop injection remains in the separately authorized
GNOME/KDE backend. All Portal sessions are ephemeral and fail closed.
"""
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import time
import select
from pathlib import Path

import gi
gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
from gi.repository import Gio, GLib

PORTAL = "org.freedesktop.portal.Desktop"
OBJECT = "/org/freedesktop/portal/desktop"
IFACE = "org.freedesktop.portal.InputCapture"
SESSION_IFACE = "org.freedesktop.portal.Session"
STATE = Path(os.environ.get("XDG_STATE_HOME", str(Path.home()/".local/state"))) / "chatgpt-remote-commander"
INCIDENT = STATE / "gui-pending-native-input-v1.json"
STOP = STATE / "GUI_STOP"
UID = os.getuid()
RECEIVER = Path.home()/".local/libexec/chatgpt-remote-commander/gui-libei-receiver"
EIS_DEVICE_TYPE_VIRTUAL = 1
EIS_DEVICE_TYPE_PHYSICAL = 2
MAX_LEASE_MS = 120_000
MIN_LEASE_MS = 10_000

class CaptureError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code

def fail(code):
    raise CaptureError(code)

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n")
    sys.stdout.flush()

def resolve_capture_scope(requested, supported_capabilities):
    """Return exact Portal request bits and EIS device bits for requested scope."""
    if not isinstance(requested, dict) or type(requested.get("pointer")) is not bool or type(requested.get("keyboard")) is not bool:
        fail("GUI_INPUT_SCOPE_INVALID")
    pointer, keyboard = requested["pointer"], requested["keyboard"]
    if not pointer and not keyboard:
        fail("GUI_INPUT_SCOPE_INVALID")
    # Portal v1 capability bits: KEYBOARD=1, POINTER=2, TOUCHSCREEN=4.
    wanted = (1 if keyboard else 0) | (2 if pointer else 0)
    if (supported_capabilities & 2) == 0:
        fail("GUI_INPUT_CAPTURE_POINTER_TRIGGER_UNAVAILABLE")
    if supported_capabilities & wanted != wanted:
        fail("GUI_REQUIRED_INPUT_CAPTURE_CAPABILITY_UNAVAILABLE")
    # libei device bits: pointer=1/absolute=2, keyboard=4, button=32.
    required_device_caps = (4 if keyboard else 0) | ((1 | 2 | 32) if pointer else 0)
    return wanted, required_device_caps

def is_physical_device_type(device_type):
    return type(device_type) is int and device_type == EIS_DEVICE_TYPE_PHYSICAL

def requested_physical_activity_seen(requested, activity_capabilities):
    pointer = requested.get("pointer") is True
    keyboard = requested.get("keyboard") is True
    pointer_activity = pointer and (activity_capabilities & (1 | 2 | 32)) != 0
    keyboard_activity = keyboard and (activity_capabilities & 4) != 0
    return bool(pointer_activity or keyboard_activity)

def incident_pending():
    try:
        if not INCIDENT.exists():
            return False
        st = INCIDENT.lstat()
        if not INCIDENT.is_file() or INCIDENT.is_symlink() or st.st_uid != UID or st.st_mode & 0o077:
            return True
        data = json.loads(INCIDENT.read_text())
        return bool(data)
    except Exception:
        return True

def owner_session():
    """Resolve only an active same-UID local Wayland/X11 logind session."""
    try:
        listed = subprocess.run(
            ["/usr/bin/loginctl", "list-sessions", "--no-legend", "--no-pager"],
            capture_output=True, text=True, timeout=2, check=True)
        candidates = []
        for line in listed.stdout.splitlines():
            fields = line.split()
            if len(fields) >= 2 and fields[1] == str(UID) and re.fullmatch(r"[A-Za-z0-9]+", fields[0]):
                candidates.append(fields[0])
        for sid in candidates:
            p = subprocess.run(
                ["/usr/bin/loginctl", "show-session", sid,
                 "-p", "User", "-p", "Seat", "-p", "Type", "-p", "Active",
                 "-p", "Remote", "-p", "Display", "-p", "Leader", "-p", "LockedHint"],
                capture_output=True, text=True, timeout=2, check=True)
            props = dict(v.split("=", 1) for v in p.stdout.splitlines() if "=" in v)
            if (props.get("User") != str(UID) or props.get("Active") != "yes" or
                    props.get("Remote") == "yes" or props.get("Type") not in ("wayland", "x11") or
                    not props.get("Seat")):
                continue
            if props.get("LockedHint", "no") == "yes":
                fail("GUI_OWNER_SESSION_LOCKED")
            env = {
                "XDG_RUNTIME_DIR": f"/run/user/{UID}",
                "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{UID}/bus"
            }
            leader = int(props.get("Leader", "0"))
            if leader > 1:
                try:
                    raw = Path(f"/proc/{leader}/environ").read_bytes().split(b"\0")
                    allow = {b"WAYLAND_DISPLAY", b"DISPLAY", b"XDG_CURRENT_DESKTOP",
                             b"XDG_SESSION_DESKTOP", b"XDG_SESSION_TYPE", b"XAUTHORITY"}
                    for item in raw:
                        if b"=" not in item:
                            continue
                        key, value = item.split(b"=", 1)
                        if key in allow and value and len(value) <= 512:
                            env[key.decode()] = value.decode(errors="strict")
                except (OSError, UnicodeError):
                    pass
            if props.get("Display"):
                env.setdefault("DISPLAY", props["Display"])
            # /proc/<logind Leader>/environ may be hidden by procfs/ptrace
            # policy even for the same UID. In that case obtain only the
            # documented desktop variables from that UID's systemd user manager.
            if not env.get("WAYLAND_DISPLAY") and not env.get("DISPLAY"):
                manager_env = subprocess.run(
                    ["/usr/bin/systemctl", "--user", "show-environment"],
                    capture_output=True, text=True, timeout=3, check=True,
                    env={**os.environ, "XDG_RUNTIME_DIR": f"/run/user/{UID}",
                         "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{UID}/bus",
                         "HOME": str(Path.home()), "PATH": "/usr/local/bin:/usr/bin:/bin"})
                allow_env = {"WAYLAND_DISPLAY", "DISPLAY", "XDG_CURRENT_DESKTOP",
                             "XDG_SESSION_DESKTOP", "XDG_SESSION_TYPE", "XAUTHORITY"}
                for item in manager_env.stdout.splitlines():
                    if "=" not in item:
                        continue
                    key, value = item.split("=", 1)
                    if key in allow_env and value and len(value) <= 512:
                        env[key] = value
            runtime = Path(env["XDG_RUNTIME_DIR"])
            bus = runtime / "bus"
            if (not runtime.is_dir() or runtime.stat().st_uid != UID or
                    not bus.is_socket() or
                    (props["Type"] == "wayland" and not env.get("WAYLAND_DISPLAY"))):
                continue
            env["HOME"] = str(Path.home())
            env["USER"] = str(UID)
            env["PATH"] = "/usr/local/bin:/usr/bin:/bin"
            seat = props["Seat"]
            display = env.get("WAYLAND_DISPLAY") or env.get("DISPLAY") or props.get("Display") or "session-display"
            return {
                "session": {
                    "ownerPrincipal": f"uid:{UID}",
                    "sessionId": sid,
                    "seatId": seat,
                    "displayId": f"{props['Type']}:{display}",
                    "interactive": True,
                    "ownerAuthenticated": True
                },
                "desktopType": props["Type"],
                "locked": props.get("LockedHint", "no") == "yes",
                "displayEnv": env
            }
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    fail("GUI_OWNER_SESSION_UNAVAILABLE")

class InputCapture:
    def __init__(self):
        # The Commander service may start outside the interactive desktop's
        # inherited environment. Resolve and bind only to the active same-UID
        # logind owner session before opening its session bus.
        owner = owner_session()
        os.environ.update(owner["displayEnv"])
        self.owner_session_snapshot = owner["session"]
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.session_path = None
        self.receiver = None
        self.receiver_fd = None
        self.activation_id = None
        self.lease_id = None
        self.expires_at_ms = 0
        self.events = []
        self.signal_ids = []
        self.closing = False
        self.descriptor = None
        self.capabilities = 0
        self.eis_matched = False
        self.physical_activity = False
        self.physical_activity_at_ms = 0
        self.next_owner_check = 0
        self._subscribe()

    def _subscribe(self):
        for name in ("Activated", "Deactivated", "Disabled", "ZonesChanged"):
            ident = self.bus.signal_subscribe(
                PORTAL, IFACE, name, OBJECT, None, Gio.DBusSignalFlags.NONE,
                self._portal_signal, name)
            self.signal_ids.append(ident)

    def _portal_signal(self, _conn, _sender, path, _iface, _signal, params, name):
        try:
            session_path, opts = params.unpack()
            if session_path != self.session_path:
                return
            opts = opts or {}
            if name == "Activated":
                self.events.append({"event": "PORTAL_ACTIVATED",
                                    "activationId": int(opts.get("activation_id", -1)),
                                    "barrierId": int(opts.get("barrier_id", 0))})
            elif name == "Deactivated":
                self.events.append({"event": "PORTAL_DEACTIVATED",
                                    "activationId": int(opts.get("activation_id", -1))})
                if not self.closing:
                    self._stop_receiver()
                    self.lease_id = None
                    self.activation_id = None
            elif name == "Disabled":
                self.events.append({"event": "PORTAL_DISABLED"})
            elif name == "ZonesChanged":
                self.events.append({"event": "PORTAL_ZONES_CHANGED",
                                    "zoneSet": int(opts.get("zone_set", 0))})
        except Exception:
            self.events.append({"event": "PORTAL_SIGNAL_INVALID"})

    def _session_closed(self, _conn, _sender, _path, _iface, _signal, _params, _data):
        if self.closing:
            return
        self.events.append({"event": "PORTAL_CLOSED"})
        self._stop_receiver()
        self.lease_id = None
        self.activation_id = None

    def _prop(self, name):
        result = self.bus.call_sync(
            PORTAL, OBJECT, "org.freedesktop.DBus.Properties", "Get",
            GLib.Variant("(ss)", (IFACE, name)),
            GLib.VariantType.new("(v)"), Gio.DBusCallFlags.NONE, 2500, None)
        return int(result.unpack()[0])

    def describe(self):
        owner = owner_session()
        if owner["session"] != self.owner_session_snapshot:
            fail("GUI_OWNER_SESSION_CHANGED")
        if incident_pending():
            fail("GUI_INCIDENT_REVIEW_REQUIRED")
        if STOP.exists():
            fail("GUI_LOCAL_STOP")
        version = self._prop("version")
        caps = self._prop("SupportedCapabilities")
        if version != 1:
            fail("GUI_INPUT_CAPTURE_PORTAL_VERSION_UNSUPPORTED")
        if not (caps & 2):
            fail("GUI_INPUT_CAPTURE_POINTER_TRIGGER_UNAVAILABLE")
        if not RECEIVER.is_file() or RECEIVER.is_symlink():
            fail("GUI_EIS_RECEIVER_MISSING")
        st = RECEIVER.stat()
        if st.st_uid != UID or not (st.st_mode & 0o100):
            fail("GUI_EIS_RECEIVER_NOT_OWNER_EXECUTABLE")
        if self.descriptor and self.descriptor["session"] != owner["session"]:
            fail("GUI_OWNER_SESSION_CHANGED")
        self.descriptor = {
            "providerId": "linux-xdg-input-capture-v1",
            "platform": "linux",
            "transport": "xdg-input-capture-v1+libei",
            "session": owner["session"],
            "activityEvidenceSource": "physical",
            "activityEvidenceIncludesSynthetic": False,
            "isolationAuthority": None,
            "capabilities": {
                "observe": True, "screenshot": True,
                "activityDetection": True, "physicalInputProtection": True,
                "emergencyRelease": True, "pointer": bool(caps & 2),
                "keyboard": bool(caps & 1), "semanticInvoke": True,
                "isolatedDesktop": False
            }
        }
        return {"descriptor": self.descriptor, "portalVersion": version,
                "supportedCapabilities": caps, "displayEnv": owner["displayEnv"]}

    @staticmethod
    def _segments(zones):
        """Return outside-union rectangle edge segments, excluding shared edges."""
        clean = []
        for zone in zones:
            if not isinstance(zone, (list, tuple)) or len(zone) != 4:
                fail("GUI_PORTAL_ZONE_INVALID")
            w, h, x, y = map(int, zone)
            if min(w, h) <= 0 or max(abs(x), abs(y), w, h, abs(x+w), abs(y+h)) > 2**30:
                fail("GUI_PORTAL_ZONE_INVALID")
            clean.append((x, y, x+w, y+h))
        barriers = []
        next_id = 1
        for x1, y1, x2, y2 in clean:
            sides = [
                ("h", y1, x1, x2, "top"),
                ("h", y2, x1, x2, "bottom"),
                ("v", x1, y1, y2, "left"),
                ("v", x2, y1, y2, "right")
            ]
            for axis, fixed, lo, hi, side in sides:
                covered = []
                for ox1, oy1, ox2, oy2 in clean:
                    if (ox1, oy1, ox2, oy2) == (x1, y1, x2, y2):
                        continue
                    if axis == "h":
                        if (side == "top" and oy2 == fixed) or (side == "bottom" and oy1 == fixed):
                            a, b = max(lo, ox1), min(hi, ox2)
                            if a < b: covered.append((a, b))
                    else:
                        if (side == "left" and ox2 == fixed) or (side == "right" and ox1 == fixed):
                            a, b = max(lo, oy1), min(hi, oy2)
                            if a < b: covered.append((a, b))
                covered.sort()
                parts, cursor = [], lo
                for a, b in covered:
                    if a > cursor: parts.append((cursor, a))
                    cursor = max(cursor, b)
                if cursor < hi: parts.append((cursor, hi))
                for a, b in parts:
                    if b <= a: continue
                    pos = (a, fixed, b-1, fixed) if axis == "h" and side == "top" else (
                        (a, fixed, b-1, fixed) if axis == "h" else
                        ((fixed, a, fixed, b-1) if side == "left" else (fixed, a, fixed, b-1)))
                    barriers.append({"barrier_id": GLib.Variant("u", next_id),
                                     "position": GLib.Variant("(iiii)", pos)})
                    next_id += 1
        if not barriers:
            fail("GUI_PORTAL_NO_OUTER_BARRIERS")
        return barriers

    def _request(self, method, signature, args, options_idx, timeout_s=20):
        token = "rc" + secrets.token_hex(8)
        values = list(args)
        options = dict(values[options_idx])
        options["handle_token"] = GLib.Variant("s", token)
        values[options_idx] = options
        unique = self.bus.get_unique_name().replace(":", "").replace(".", "_")
        request_path = f"/org/freedesktop/portal/desktop/request/{unique}/{token}"
        box = {}
        def response(_c, _s, _p, _i, _n, params, _d):
            box["value"] = params.unpack()
        sub = self.bus.signal_subscribe(
            PORTAL, "org.freedesktop.portal.Request", "Response",
            request_path, None, Gio.DBusSignalFlags.NONE, response, None)
        try:
            reply = self.bus.call_sync(PORTAL, OBJECT, IFACE, method,
                GLib.Variant(signature, tuple(values)), None,
                Gio.DBusCallFlags.NONE, 8000, None)
            returned_path = reply.unpack()[0]
            if returned_path != request_path:
                fail("GUI_PORTAL_REQUEST_PATH_MISMATCH")
            deadline = time.monotonic() + timeout_s
            context = GLib.MainContext.default()
            while "value" not in box and time.monotonic() < deadline:
                while context.pending():
                    context.iteration(False)
                self._check_abort()
                time.sleep(0.02)
            if "value" not in box:
                fail("GUI_PORTAL_REQUEST_TIMEOUT")
            code, data = box["value"]
            if int(code) != 0:
                fail("GUI_PORTAL_PERMISSION_DENIED")
            return {k: (v.unpack() if isinstance(v, GLib.Variant) else v)
                    for k, v in (data or {}).items()}
        finally:
            if "value" not in box:
                try:
                    self.bus.call_sync(PORTAL, request_path, "org.freedesktop.portal.Request",
                        "Close", None, None, Gio.DBusCallFlags.NONE, 1000, None)
                except Exception:
                    pass
            self.bus.signal_unsubscribe(sub)

    def _check_abort(self):
        if incident_pending():
            self._cleanup_partial()
            fail("GUI_INCIDENT_REVIEW_REQUIRED")
        if STOP.exists():
            self._cleanup_partial()
            fail("GUI_LOCAL_STOP")

    def _zones(self):
        result = self._request("GetZones", "(oa{sv})",
                               [self.session_path, {}], 1, 15)
        zones = result.get("zones")
        zone_set = result.get("zone_set")
        if not zones or not isinstance(zone_set, int):
            fail("GUI_PORTAL_ZONES_UNAVAILABLE")
        return zones, zone_set

    def _cleanup_partial(self):
        self.closing = True
        fd, self.receiver_fd = self.receiver_fd, None
        if isinstance(fd, int) and fd >= 0:
            try: os.close(fd)
            except OSError: pass
        self._stop_receiver()
        if self.session_path:
            try:
                if self.activation_id is not None:
                    self.bus.call_sync(PORTAL, OBJECT, IFACE, "Release",
                        GLib.Variant("(oa{sv})", (self.session_path, {
                            "activation_id": GLib.Variant("u", int(self.activation_id))})),
                        None, Gio.DBusCallFlags.NONE, 1500, None)
            except Exception:
                pass
            try:
                self.bus.call_sync(PORTAL, OBJECT, IFACE, "Disable",
                    GLib.Variant("(oa{sv})", (self.session_path, {})),
                    None, Gio.DBusCallFlags.NONE, 1500, None)
            except Exception:
                pass
            try:
                self.bus.call_sync(PORTAL, self.session_path, SESSION_IFACE, "Close",
                    None, None, Gio.DBusCallFlags.NONE, 1500, None)
            except Exception:
                pass
        self.session_path = None
        self.activation_id = None
        self.lease_id = None
        self.expires_at_ms = 0
        self.closing = False

    def _stop_receiver(self):
        proc, self.receiver = self.receiver, None
        self.receiver_fd = None
        if proc and proc.poll() is None:
            try: proc.terminate()
            except OSError: pass
            try: proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
                try: proc.wait(timeout=1)
                except subprocess.TimeoutExpired: pass

    def acquire(self, request):
        if self.session_path or self.lease_id:
            fail("GUI_LEASE_BUSY")
        self._check_abort()
        owner = owner_session()
        descriptor = self.describe()["descriptor"]
        if owner["session"] != descriptor["session"]:
            fail("GUI_OWNER_SESSION_CHANGED")
        requested = request.get("requestedInput") or {}
        pointer = requested.get("pointer") is True
        keyboard = requested.get("keyboard") is True
        caps = self._prop("SupportedCapabilities")
        wanted, required_device_caps = resolve_capture_scope(
            {"pointer": pointer, "keyboard": keyboard}, caps)
        self._check_abort()
        token = "rc" + secrets.token_hex(8)
        options = {
            "handle_token": GLib.Variant("s", token),
            "session_handle_token": GLib.Variant("s", "rcs" + secrets.token_hex(8)),
            "capabilities": GLib.Variant("u", wanted)
        }
        try:
            # InputCapture v1: CreateSession auto-starts and presents the portal's
            # native owner-consent dialog. V2 is not assumed from a v1 portal.
            result = self._request("CreateSession", "(sa{sv})", ["", options], 1, 60)
            path = result.get("session_handle")
            if not isinstance(path, str) or not path.startswith("/org/freedesktop/portal/desktop/session/"):
                fail("GUI_PORTAL_SESSION_INVALID")
            self.session_path = path
            granted = int(result.get("capabilities", 0))
            if granted & wanted != wanted:
                fail("GUI_PORTAL_INPUT_SCOPE_NOT_GRANTED")
            self.signal_ids.append(self.bus.signal_subscribe(
                PORTAL, SESSION_IFACE, "Closed", path, None,
                Gio.DBusSignalFlags.NONE, self._session_closed, None))
            zones, zone_set = self._zones()
            barriers = self._segments(zones)
            result = self._request("SetPointerBarriers",
                "(oa{sv}aa{sv}u)", [path, {}, barriers, zone_set], 1, 15)
            failed = result.get("failed_barriers", [])
            if failed:
                fail("GUI_PORTAL_BARRIERS_REJECTED")
            # ConnectToEIS MUST precede Enable. Start the passive receiver only
            # after Activated provides the activation_id required by the receiver.
            reply, fd_list = self.bus.call_with_unix_fd_list_sync(
                PORTAL, OBJECT, IFACE, "ConnectToEIS",
                GLib.Variant("(oa{sv})", (path, {})),
                GLib.VariantType.new("(h)"), Gio.DBusCallFlags.NONE,
                8000, None, None)
            fd = fd_list.get(reply.unpack()[0])
            if not isinstance(fd, int) or fd < 3:
                fail("GUI_EIS_FD_INVALID")
            self.receiver_fd = fd
            self.bus.call_sync(PORTAL, OBJECT, IFACE, "Enable",
                GLib.Variant("(oa{sv})", (path, {})), None,
                Gio.DBusCallFlags.NONE, 8000, None)
            deadline = time.monotonic() + 60
            activation = None
            context = GLib.MainContext.default()
            while activation is None and time.monotonic() < deadline:
                while context.pending(): context.iteration(False)
                self._check_abort()
                for i, event in enumerate(self.events):
                    if event.get("event") == "PORTAL_ACTIVATED":
                        activation = self.events.pop(i)
                        break
                    if event.get("event") in ("PORTAL_CLOSED", "PORTAL_DISABLED"):
                        fail("GUI_PORTAL_SESSION_CLOSED")
                time.sleep(0.02)
            if activation is None:
                fail("GUI_PORTAL_ACTIVATION_TIMEOUT")
            activation_id = activation.get("activationId")
            if not isinstance(activation_id, int) or activation_id < 0:
                fail("GUI_PORTAL_ACTIVATION_ID_INVALID")
            self.activation_id = activation_id
            proc = subprocess.Popen(
                [str(RECEIVER), "--fd", str(fd), "--activation-id", str(activation_id),
                 "--timeout-ms", "15000", "--lease-ms", str(int(request["ttlSeconds"])*1000)],
                pass_fds=(fd,), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, text=True, bufsize=1, close_fds=True)
            os.close(fd)
            self.receiver_fd = None
            self.receiver = proc
            receiver_deadline = time.monotonic() + 15
            matched = False
            physical = False
            caps_seen = 0
            activity_caps = 0
            self.physical_activity_at_ms = 0
            while time.monotonic() < receiver_deadline and not (
                matched and (caps_seen & required_device_caps) == required_device_caps and not physical
            ):
                self._check_abort()
                if proc.poll() is not None:
                    fail("GUI_EIS_RECEIVER_EXITED")
                ready, _, _ = select.select([proc.stdout], [], [], 0.05)
                if not ready: continue
                line = proc.stdout.readline(4096)
                if not line: continue
                try: item = json.loads(line)
                except Exception: fail("GUI_EIS_RECEIVER_PROTOCOL_INVALID")
                if item.get("kind") == "eis_activation_sequence_matched":
                    if item.get("activation_id") != activation_id or not is_physical_device_type(item.get("device_type")):
                        fail("GUI_EIS_ACTIVATION_MISMATCH")
                    caps_seen |= int(item.get("capabilities", 0))
                    matched = True
                elif item.get("kind") == "eis_physical_activity":
                    if matched and is_physical_device_type(item.get("device_type")):
                        activity_caps |= int(item.get("capabilities", 0))
                        if requested_physical_activity_seen(requested, activity_caps):
                            physical = True
                            if not self.physical_activity_at_ms:
                                self.physical_activity_at_ms = int(time.time()*1000)
                elif item.get("kind") == "error":
                    fail(str(item.get("code", "GUI_EIS_RECEIVER_FAILED")))
            if not matched:
                fail("GUI_EIS_ACTIVATION_NOT_MATCHED")
            if not physical:
                fail("GUI_EIS_PHYSICAL_ACTIVITY_NOT_OBSERVED")
            if (caps_seen & required_device_caps) != required_device_caps:
                fail("GUI_EIS_REQUIRED_DEVICE_CAPABILITY_MISSING")
            if not physical:
                fail("GUI_EIS_REQUIRED_PHYSICAL_ACTIVITY_NOT_OBSERVED")
            ttl = int(request["ttlSeconds"])
            if ttl < 10 or ttl > 120:
                fail("GUI_LEASE_TTL_INVALID")
            self.lease_id = "eis-" + secrets.token_hex(16)
            self.expires_at_ms = int(time.time()*1000) + ttl*1000
            self.next_owner_check = int(time.time()*1000) + 1000
            return {
                "ok": True,
                "receipt": {
                    "active": True, "kind": "NATIVE_PHYSICAL_INPUT_PROTECTION",
                    "providerId": descriptor["providerId"],
                    "sessionId": descriptor["session"]["sessionId"],
                    "leaseId": self.lease_id, "releaseOnAgentExit": True,
                    "releaseOnEmergency": True, "expiresAtMs": self.expires_at_ms
                },
                "activityEvidence": {
                    "source": "physical", "reliable": True,
                    "excludesSyntheticInput": True,
                    "observedAtMs": self.physical_activity_at_ms, "idleMs": 0
                },
                "activationId": activation_id, "deviceCapabilities": caps_seen,
                "physicalActivityCapabilities": activity_caps
            }
        except Exception:
            self._cleanup_partial()
            raise

    def release(self, request):
        lease = request.get("leaseId")
        if not self.lease_id:
            return {"ok": True, "released": True, "alreadyReleased": True}
        if lease != self.lease_id:
            fail("GUI_NATIVE_LEASE_MISMATCH")
        self._cleanup_partial()
        return {"ok": True, "released": True}

    def _drain_receiver(self):
        proc = self.receiver
        if not proc:
            return
        if proc.poll() is not None:
            self.events.append({"event": "AGENT_PROCESS_EXITED"})
            self._cleanup_partial()
            return
        if proc.stdout:
            for _ in range(256):
                ready, _, _ = select.select([proc.stdout], [], [], 0)
                if not ready:
                    break
                line = proc.stdout.readline(4096)
                if not line:
                    break
                try:
                    item = json.loads(line)
                except Exception:
                    self.events.append({"event": "AGENT_PROCESS_EXITED"})
                    self._cleanup_partial()
                    return
                if item.get("kind") == "error":
                    self.events.append({"event": "AGENT_PROCESS_EXITED"})
                    self._cleanup_partial()
                    return

    def events_poll(self):
        self._check_abort()
        self._drain_receiver()
        now = int(time.time()*1000)
        if self.lease_id and now >= self.next_owner_check:
            self.next_owner_check = now + 1000
            try:
                current = owner_session()
                if current.get("locked"):
                    self.events.append({"event": "SESSION_LOCKED"})
                    self._cleanup_partial()
                elif current["session"] != self.descriptor["session"]:
                    self.events.append({"event": "SESSION_SWITCHED"})
                    self._cleanup_partial()
            except CaptureError as error:
                event = "SESSION_LOCKED" if error.code == "GUI_OWNER_SESSION_LOCKED" else "SESSION_SWITCHED"
                self.events.append({"event": event})
                self._cleanup_partial()
            except Exception:
                self.events.append({"event": "SESSION_SWITCHED"})
                self._cleanup_partial()
        if self.lease_id and now >= self.expires_at_ms:
            self.events.append({"event": "LEASE_EXPIRED"})
            self._cleanup_partial()
        pending = self.events[:]
        self.events.clear()
        if any(e.get("event") in ("PORTAL_DEACTIVATED", "PORTAL_CLOSED", "PORTAL_DISABLED", "AGENT_PROCESS_EXITED") for e in pending):
            self._cleanup_partial()
        return {"events": pending, "active": bool(self.lease_id)}

    def close(self):
        self._cleanup_partial()
        for ident in self.signal_ids:
            try: self.bus.signal_unsubscribe(ident)
            except Exception: pass
        self.signal_ids.clear()

def main():
    try:
        import ctypes
        ctypes.CDLL(None).prctl(1, signal.SIGTERM)
    except Exception:
        emit({"ready": False, "error": "PARENT_LIFECYCLE_GUARD_FAILED"})
        return 70
    adapter = None
    emit({"ready": True, "protocol": 1})
    try:
        for line in sys.stdin:
            if len(line) > 32768:
                emit({"id": None, "ok": False, "error": "GUI_REQUEST_LIMIT"})
                continue
            try:
                request = json.loads(line)
                if not isinstance(request, dict) or not re.fullmatch(r"[a-f0-9-]{36}", str(request.get("id", ""))):
                    fail("GUI_REQUEST_INVALID")
                action = request.get("action")
                if adapter is None:
                    adapter = InputCapture()
                if action == "describeSession":
                    result = adapter.describe()
                elif action == "getPhysicalActivityEvidence":
                    # Wayland barrier capture cannot prove physical idle before activation.
                    result = {"activity": None}
                elif action == "acquireProtection":
                    result = adapter.acquire(request)
                elif action == "releaseProtection":
                    result = adapter.release(request)
                elif action == "events":
                    result = adapter.events_poll()
                elif action == "status":
                    result = {"active": bool(adapter.lease_id),
                              "expiresAtMs": adapter.expires_at_ms}
                elif action == "stop":
                    result = {"stopped": True}
                    emit({"id": request["id"], "ok": True, "result": result})
                    break
                else:
                    fail("GUI_ACTION_UNSUPPORTED")
                emit({"id": request["id"], "ok": True, "result": result})
            except CaptureError as error:
                emit({"id": request.get("id") if isinstance(request, dict) else None,
                      "ok": False, "error": error.code})
            except Exception:
                emit({"id": request.get("id") if isinstance(request, dict) else None,
                      "ok": False, "error": "GUI_INPUT_CAPTURE_FAILED"})
    finally:
        if adapter:
            adapter.close()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
