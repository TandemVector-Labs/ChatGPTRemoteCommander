#!/usr/bin/env python3
"""KDE Wayland RemoteDesktop/ScreenCast portal adapter prototype.

The prior Remote Commander native-input uncertainty is authoritative: no
portal consent, screenshot or input is attempted while it remains pending.
This tool is intentionally not an active RC input backend until live
capture+fresh-frame+owner-consent integration tests are complete.
"""
import json
import os
import re
import secrets
import subprocess
import stat
import sys
import time
from pathlib import Path

import gi
gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
from gi.repository import Gio, GLib

PORTAL = "org.freedesktop.portal.Desktop"
OBJECT = "/org/freedesktop/portal/desktop"
REMOTE = "org.freedesktop.portal.RemoteDesktop"
SCREEN = "org.freedesktop.portal.ScreenCast"
STATE = Path.home() / ".local/state/chatgpt-remote-commander/gui-pending-native-input-v1.json"
STOP = Path.home() / ".local/state/chatgpt-remote-commander/GUI_STOP"

class PortalError(Exception):
    pass

def incident_pending():
    try:
        if not STATE.exists():
            return False
        if not STATE.is_file() or STATE.is_symlink():
            return True
        doc = json.loads(STATE.read_text())
        return doc.get("status") == "PENDING_NATIVE_EFFECT" or bool(doc)
    except Exception:
        return True  # Fail closed on unreadable/unexpected incidents.

def desktop_kde():
    # A service started before graphical login may lack XDG_CURRENT_DESKTOP.
    # Resolve a real, active same-UID KDE Wayland logind session, never spoof it.
    v = (os.environ.get("XDG_CURRENT_DESKTOP", "") + ":" +
         os.environ.get("XDG_SESSION_DESKTOP", "")).lower()
    if "kde" in v or "plasma" in v:
        return True
    try:
        uid = os.getuid()
        listed = subprocess.run(
            ["/usr/bin/loginctl", "list-sessions", "--no-legend", "--no-pager"],
            capture_output=True, text=True, timeout=2, check=True)
        for line in listed.stdout.splitlines():
            fields = line.split()
            if len(fields) < 2 or fields[1] != str(uid) or not fields[0].isalnum():
                continue
            session = subprocess.run(
                ["/usr/bin/loginctl", "show-session", fields[0],
                 "-p", "Desktop", "-p", "Type", "-p", "Active"],
                capture_output=True, text=True, timeout=2, check=True)
            props = dict(x.split("=", 1) for x in session.stdout.splitlines() if "=" in x)
            if (props.get("Desktop", "").lower() != "kde" or
                    props.get("Type") != "wayland" or props.get("Active") != "yes"):
                continue
            runtime = Path("/run/user") / str(uid)
            rs = runtime.stat()
            bus = runtime / "bus"
            if rs.st_uid != uid or not runtime.is_dir() or not bus.is_socket():
                continue
            os.environ.setdefault("XDG_RUNTIME_DIR", str(runtime))
            os.environ.setdefault("DBUS_SESSION_BUS_ADDRESS",
                                  "unix:path=" + str(bus))
            return True
    except (OSError, ValueError, subprocess.SubprocessError):
        return False
    return False

def validated_jpeg_payload(raw, max_width=1600, quality=70):
    """Decode/recompress one JPEG. Safe for synthetic frames and consented data.

    This does NOT certify a real Portal stream, freshness or foreground identity.
    """
    import base64
    gi.require_version("GdkPixbuf", "2.0")
    from gi.repository import GdkPixbuf
    if (not isinstance(raw, bytes) or len(raw) < 4 or
            len(raw) > 16 * 1024 * 1024 or
            not raw.startswith(bytes.fromhex("ffd8")) or
            not raw.endswith(bytes.fromhex("ffd9"))):
        raise PortalError("INVALID_JPEG_FRAME")
    if not isinstance(max_width, int) or not 64 <= max_width <= 4096:
        raise PortalError("INVALID_MAX_FRAME_WIDTH")
    if not isinstance(quality, int) or not 25 <= quality <= 90:
        raise PortalError("INVALID_FRAME_QUALITY")
    try:
        loader = GdkPixbuf.PixbufLoader.new_with_type("jpeg")
        loader.write(raw)
        loader.close()
        pix = loader.get_pixbuf()
        if pix is None:
            raise PortalError("FRAME_PIXBUF_MISSING")
        width, height = pix.get_width(), pix.get_height()
        if not 1 <= width <= 16384 or not 1 <= height <= 16384:
            raise PortalError("FRAME_GEOMETRY_INVALID")
        if width > max_width:
            h = max(1, int(height * max_width / width))
            pix = pix.scale_simple(max_width, h, GdkPixbuf.InterpType.BILINEAR)
            if pix is None:
                raise PortalError("FRAME_SCALING_FAILED")
        ok, encoded = pix.save_to_bufferv(
            "jpeg", ["quality"], [str(quality)])
        if not ok or not encoded:
            raise PortalError("JPEG_ENCODING_FAILED")
    except PortalError:
        raise
    except (GLib.Error, RuntimeError, ValueError, TypeError):
        raise PortalError("JPEG_VALIDATION_FAILED")
    return {
        "ok": True,
        "mimeType": "image/jpeg",
        "data": base64.b64encode(encoded).decode("ascii"),
        "width": pix.get_width(),
        "height": pix.get_height(),
        "foregroundVerified": False
    }


class Portal:
    def __init__(self):
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.session_path = None
        self.started = False
        self.granted_devices = 0
        self.eis_consumed = False

    def props(self, iface):
        proxy = Gio.DBusProxy.new_sync(
            self.bus, Gio.DBusProxyFlags.NONE, None, PORTAL, OBJECT, iface, None)
        return proxy

    def capabilities(self):
        rd, sc = self.props(REMOTE), self.props(SCREEN)
        def num(proxy, name):
            value = proxy.get_cached_property(name)
            return int(value.unpack()) if value else 0
        return {
            "remoteDesktopVersion": num(rd, "version"),
            "availableDeviceTypes": num(rd, "AvailableDeviceTypes"),
            "screenCastVersion": num(sc, "version"),
            "availableSourceTypes": num(sc, "AvailableSourceTypes")
        }

    def request(self, iface, method, signature, args, options_idx, timeout=10):
        # Subscribe before calling. Portal replies asynchronously with a
        # Request.Response signal and returns an opaque request object path.
        token = "rc" + secrets.token_hex(8)
        args = list(args)
        options = dict(args[options_idx])
        options["handle_token"] = GLib.Variant("s", token)
        args[options_idx] = options
        conn = self.bus.get_unique_name().replace(":", "").replace(".", "_")
        request_path = "/org/freedesktop/portal/desktop/request/" + conn + "/" + token
        box = {}
        def receive(_conn, _sender, _object, _interface, _signal, params, _data):
            box["response"] = params.unpack()
        sub = self.bus.signal_subscribe(
            PORTAL, "org.freedesktop.portal.Request", "Response",
            request_path, None, Gio.DBusSignalFlags.NONE, receive, None)
        try:
            parameters = GLib.Variant(signature, tuple(args))
            reply = self.bus.call_sync(
                PORTAL, OBJECT, iface, method, parameters, None,
                Gio.DBusCallFlags.NONE, 10000, None)
            returned_path = reply.unpack()[0]
            if returned_path != request_path:
                raise PortalError("REQUEST_PATH_MISMATCH")
            deadline = time.monotonic() + timeout
            context = GLib.MainContext.default()
            while "response" not in box and time.monotonic() < deadline:
                while context.pending():
                    context.iteration(False)
                time.sleep(0.025)
            if "response" not in box:
                raise PortalError("PORTAL_CONSENT_TIMEOUT")
            result, data = box["response"]
            if result != 0:
                raise PortalError("PORTAL_PERMISSION_NOT_GRANTED")
            return {k: v.unpack() if isinstance(v, GLib.Variant) else v
                    for k, v in data.items()}
        finally:
            if "response" not in box:
                try:
                    self.bus.call_sync(PORTAL,request_path,"org.freedesktop.portal.Request","Close",
                                       None,None,Gio.DBusCallFlags.NONE,1000,None)
                except GLib.Error:
                    pass
            self.bus.signal_unsubscribe(sub)

    def create_session(self):
        result = self.request(
            REMOTE, "CreateSession", "(a{sv})",
            [{"session_handle_token": GLib.Variant(
                "s", "rc" + secrets.token_hex(8))}], 0)
        path = result.get("session_handle")
        if not isinstance(path, str) or not path.startswith(
                "/org/freedesktop/portal/desktop/session/"):
            raise PortalError("INVALID_SESSION_PATH")
        self.session_path = path
        return path

    def prepare_sources_and_input(self):
        if not self.session_path:
            raise PortalError("SESSION_REQUIRED")
        self.request(REMOTE, "SelectDevices", "(oa{sv})",
                     [self.session_path, {
                         "types": GLib.Variant("u", 3)}], 1)
        self.request(SCREEN, "SelectSources", "(oa{sv})",
                     [self.session_path, {
                         "types": GLib.Variant("u", 1),
                         "multiple": GLib.Variant("b", False)}], 1)

    def start(self):
        if not self.session_path:
            raise PortalError("SESSION_REQUIRED")
        data = self.request(REMOTE, "Start", "(osa{sv})",
                            [self.session_path, "", {}], 2, timeout=45)
        self.streams = data.get("streams", [])
        self.granted_devices = int(data.get("devices", 0))
        self.started = True
        return {"granted": True, "hasStreams": bool(self.streams),
                "devices": self.granted_devices}

    def probe_eis_transport_without_input(self):
        # The portal returns a one-use FD; after consent run ONLY the tiny
        # sender-handshake checker, not a desktop injection program.
        if incident_pending():
            raise PortalError("GUI_INCIDENT_REVIEW_REQUIRED")
        if STOP.exists():
            raise PortalError("GUI_LOCAL_STOP")
        if not self.session_path or not self.started:
            raise PortalError("EIS_CONSENTED_START_REQUIRED")
        if not (self.granted_devices & 3):
            raise PortalError("EIS_INPUT_NOT_GRANTED")
        if self.eis_consumed:
            raise PortalError("EIS_ONE_SHOT_ONLY")
        helper = Path(__file__).with_name("kde-eis-probe")
        if (not helper.is_file() or helper.is_symlink() or
                helper.stat().st_uid != os.getuid() or
                not helper.stat().st_mode & stat.S_IXUSR):
            raise PortalError("EIS_SAFE_PROBE_NOT_INSTALLED")
        # Set before dispatch so an uncertain timeout never invokes ConnectToEIS
        # a second time. The portal API permits only one call per session.
        self.eis_consumed = True
        reply, fds = self.bus.call_with_unix_fd_list_sync(
            PORTAL, OBJECT, REMOTE, "ConnectToEIS",
            GLib.Variant("(oa{sv})", (self.session_path, {})),
            GLib.VariantType.new("(h)"), Gio.DBusCallFlags.NONE,
            8000, None, None)
        fd = fds.get(reply.unpack()[0])
        if not isinstance(fd, int) or fd < 3:
            raise PortalError("EIS_INVALID_FD")
        try:
            try:
                completed = subprocess.run(
                    [str(helper), "--fd", str(fd)], pass_fds=(fd,),
                    capture_output=True, text=True, timeout=5,
                    check=False)
            except subprocess.TimeoutExpired:
                raise PortalError("EIS_HANDSHAKE_TIMEOUT")
            if (completed.returncode != 0 or
                    "EIS_AUTHENTICATED_HANDSHAKE_PASS=1" not in
                    completed.stdout.splitlines() or
                    "EIS_NATIVE_INPUT_SENT=0" not in
                    completed.stdout.splitlines()):
                raise PortalError("EIS_HANDSHAKE_NOT_CONFIRMED")
            return {"transport": "libei-fd", "fdReceived": True,
                    "handshakeConfirmed": True, "inputSent": False,
                    "sessionConsentRequired": True}
        finally:
            os.close(fd)

    def capture_jpeg(self, max_width=1600, quality=70):
        """Read one consented PipeWire frame. No KWin private API or injection."""
        if incident_pending():
            raise PortalError("GUI_INCIDENT_REVIEW_REQUIRED")
        if STOP.exists():
            raise PortalError("GUI_LOCAL_STOP")
        gi.require_version("Gst", "1.0")
        from gi.repository import Gst
        if not self.started:
            raise PortalError("CONSENTED_START_REQUIRED")
        if not self.session_path or not getattr(self, "streams", None):
            raise PortalError("CONSENTED_STREAM_REQUIRED")
        node_id = int(self.streams[0][0])
        if not 0 < node_id < 2**32:
            raise PortalError("INVALID_PIPEWIRE_NODE")
        parameters = GLib.Variant("(oa{sv})", (self.session_path, {}))
        reply, out_fds = self.bus.call_with_unix_fd_list_sync(
            PORTAL, OBJECT, SCREEN, "OpenPipeWireRemote", parameters,
            GLib.VariantType.new("(h)"), Gio.DBusCallFlags.NONE,
            8000, None, None)
        fd = out_fds.get(reply.unpack()[0])
        pipeline = None
        try:
            Gst.init(None)
            pipeline = Gst.parse_launch(
                f"pipewiresrc fd={fd} path={node_id} do-timestamp=true "
                "! videoconvert ! video/x-raw,format=RGB "
                "! jpegenc quality=70 ! appsink name=out "
                "sync=false max-buffers=1 drop=true")
            sink = pipeline.get_by_name("out")
            if not sink:
                raise PortalError("PIPEWIRE_APPSINK_MISSING")
            pipeline.set_state(Gst.State.PLAYING)
            sample = sink.emit("try-pull-sample", 8 * Gst.SECOND)
            if not sample:
                raise PortalError("PIPEWIRE_FRAME_TIMEOUT")
            buf = sample.get_buffer()
            raw = buf.extract_dup(0, buf.get_size())
            result = validated_jpeg_payload(raw, max_width, quality)
            result["consentedPortalStream"] = True
            # Freshness and foreground proof require independent validation.
            result["freshFrameVerified"] = False
            return result
        finally:
            if pipeline:
                pipeline.set_state(Gst.State.NULL)
            os.close(fd)

    def close(self):
        if not self.session_path:
            return
        try:
            self.bus.call_sync(
                PORTAL, self.session_path, "org.freedesktop.portal.Session",
                "Close", None, None, Gio.DBusCallFlags.NONE, 2000, None)
        finally:
            self.session_path = None
            self.started = False
            self.granted_devices = 0
            self.eis_consumed = False

def status():
    out = {"backend": "kde-wayland-xdg-portal",
           "kdeSession": desktop_kde(),
           "incidentPending": incident_pending(),
           "localStop": STOP.exists(),
           "consentRequired": True,
           "nativeInputReleased": False,
           "available": False}
    if not out["kdeSession"]:
        out["reason"] = "NOT_KDE"
        return out
    try:
        out.update(Portal().capabilities())
        out["portalCapable"] = (
            out["remoteDesktopVersion"] >= 2 and
            out["availableDeviceTypes"] & 3 == 3 and
            out["screenCastVersion"] >= 4 and
            bool(out["availableSourceTypes"] & 1))
    except Exception:
        out["portalCapable"] = False
    out["reason"] = (
        "GUI_INCIDENT_REVIEW_REQUIRED" if out["incidentPending"] else
        "GUI_LOCAL_STOP" if out["localStop"] else
        "KDE_PORTAL_BACKEND_STAGED_NEEDS_LIVE_SCREEN_FRAME_TEST")
    return out

RUNTIME = None

def runtime():
    global RUNTIME
    if RUNTIME is None:
        from kde_portal_runtime import Runtime
        RUNTIME = Runtime(Portal, PortalError, incident_pending)
    return RUNTIME

def helper_reply(request):
    if not isinstance(request, dict):
        return {"ok": False, "error": "GUI_REQUEST_INVALID"}
    if os.environ.get("RC_KDE_PORTAL_RUNTIME") == "1" or request.get("kdePortalRuntime") is True:
        return runtime().handle(request)
    if incident_pending():
        if request.get("action") == "status":
            s = status()
            return {"ok": True, **s}
        return {"ok": False, "error": "GUI_INCIDENT_REVIEW_REQUIRED"}
    if STOP.exists():
        return {"ok": False, "error": "GUI_LOCAL_STOP"}
    if request.get("action") == "status":
        return {"ok": True, **status()}
    # Never advertise mouse/key/screenshot until live frame/foreground and
    # independent owner consent are accepted by production policy.
    return {"ok": False, "error": "GUI_KDE_NATIVE_INPUT_NOT_PROMOTED"}

def main():
    if "--server" in sys.argv:
        print(json.dumps({"ok": True, "ready": True, "protocol": 1}),
              flush=True)
        for line in sys.stdin:
            try:
                reply = ({"ok": False, "error": "GUI_REQUEST_LIMIT"}
                         if len(line) > 32768
                         else helper_reply(json.loads(line)))
            except Exception:
                reply = {"ok": False, "error": "GUI_NATIVE_FAILED"}
            print(json.dumps(reply, separators=(",", ":"), ensure_ascii=False),
                  flush=True)
        return 0
    info = status()
    if "--self-test" in sys.argv or "--status" in sys.argv:
        print(json.dumps(info, sort_keys=True))
        return 0 if info.get("portalCapable") else 2
    if ("--request-consent-test" not in sys.argv and
            "--capture-once-after-consent" not in sys.argv and
            "--probe-eis-after-consent" not in sys.argv):
        print(json.dumps({"ok": False, "error": "ONLY_STATUS_AND_CONSENT_TEST"}))
        return 2
    if incident_pending() or STOP.exists():
        print(json.dumps({"ok": False, "error": "GUI_INCIDENT_REVIEW_REQUIRED"}))
        return 3
    if not info.get("portalCapable"):
        return 4
    session = Portal()
    try:
        session.create_session()
        session.prepare_sources_and_input()
        result = session.start()
        if "--probe-eis-after-consent" in sys.argv:
            result["eis"] = session.probe_eis_transport_without_input()
        if "--capture-once-after-consent" in sys.argv:
            frame = session.capture_jpeg()
            # This CLI prints no image bytes; RC integration must honor policy.
            result["frameCaptured"] = frame.get("ok") is True
            result["frameWidth"] = frame.get("width")
            result["frameHeight"] = frame.get("height")
        print(json.dumps(result))
        return 0
    except PortalError as err:
        print(json.dumps({"ok": False, "error": str(err)}))
        return 5
    finally:
        session.close()

if __name__ == "__main__":
    import signal
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    try:
        raise SystemExit(main())
    finally:
        if RUNTIME is not None:
            RUNTIME.close()
