#!/usr/bin/python3
"""Remote Commander Control Center: native GNOME/Adwaita 1, safe owner-only monitoring UI.
No network / shell / credential access. Management mutations disabled until an
authenticated, revision-checked Core IPC is independently accepted.
"""
import json
import os
import re
import sqlite3
import stat
import sys
import time
from pathlib import Path

APP_ID = "io.github.god13emad.RemoteCommander.ControlCenter"
HOME = Path.home()
STATE = HOME / ".local/state/chatgpt-remote-commander"
MONITOR = STATE / "browser-companion/commander-monitor.json"
ROUTING = STATE / "routing"
WORKFLOWS = STATE / "instances/default/workflows/workflows.sqlite"
PROFILE_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
MAX_BYTES = 64 * 1024
AUTOFOLLOW_ROOT = HOME / "source/repos/RC_AUTOFOLLOW_R1"
AUTOFOLLOW_UNITS = HOME / ".config/systemd/user"


# Two independent local runtime identities and one Saeed account connection.
# The latter is not falsely presented as another Core process or permission scope.
OWNER_GUI_CONFIG = STATE / "owner-gui-v1/config.json"
SAEED_UNIT = HOME / ".config/systemd/user/saeed-emad-laptop-tunnel.service"


# Cache only still-fresh, owner-private snapshots from both supported workers.
# This avoids last-writer-wins flicker without network access or persisted data.
_PROFILE_MONITOR_SNAPSHOTS = {}


def effective_system_dark(preference: str, gtk_theme: str = "", gtk_override: str = "") -> bool:
    """GNOME color-scheme has priority; in Default mode honor an explicitly
    dark GTK theme. Do not write or change desktop preferences.
    """
    pref = (preference or "").strip().strip("\\'\\\"").casefold()
    if pref == "prefer-dark":
        return True
    if pref == "prefer-light":
        return False
    selected = (gtk_override or gtk_theme or "").casefold()
    return bool(re.search(r"(?:^|[-_: ])dark(?:$|[-_: ])", selected))



def bounded_json(path: Path, limit=MAX_BYTES):
    """Read only owner-controlled regular files. Never follow symlink input."""
    try:
        st = path.lstat()
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
            return None
        if st.st_size > limit or st.st_size < 2:
            return None
        if st.st_mode & 0o022:
            return None
        with path.open("rb") as f:
            raw = f.read(limit + 1)
        if len(raw) > limit:
            return None
        value = json.loads(raw)
        return value if isinstance(value, dict) else None
    except (OSError, ValueError, TypeError, UnicodeError):
        return None


def monitor_status():
    m = bounded_json(MONITOR, 16384)
    if not m or m.get("schema") != 1 or m.get("kind") != "COMMANDER_LIVE_MONITOR":
        return {"state": "UNVERIFIED", "reason": "Missing/untrusted private monitor"}
    now = int(time.time() * 1000)
    expires = m.get("expiresAtEpochMs")
    observed = m.get("observedAtEpochMs")
    if not isinstance(expires, int) or not isinstance(observed, int):
        return {"state": "UNVERIFIED", "reason": "Missing timestamps"}
    if observed > now + 30000 or expires < now:
        return {"state": "DISCONNECTED", "reason": "Monitor stale"}
    identity = m.get("identity") or {}
    gui = m.get("gui") or {}
    operations = m.get("operations") or {}
    # The shared monitor file may be written by a separate owner-GUI worker.
    # Its Browser=false and operations=0 are scoped to that worker, not Core.
    # Do not infer readiness for a different profile without live evidence.
    profile = identity.get("profile")
    device = identity.get("deviceName")
    version = identity.get("version")
    cache_key = (str(MONITOR), device, version)
    # Profile identity comes from the validated private snapshot; invalid or
    # expired monitor files never resurrect cached liveness.
    for key, snapshots in list(_PROFILE_MONITOR_SNAPSHOTS.items()):
        if key != cache_key:
            del _PROFILE_MONITOR_SNAPSHOTS[key]
            continue
        for name, value in list(snapshots.items()):
            if value["expires"] <= now:
                del snapshots[name]
    stored = _PROFILE_MONITOR_SNAPSHOTS.setdefault(cache_key, {})
    if profile in ("default", "owner-gui-v1"):
        stored[profile] = {
            "expires": expires,
            "gui": gui,
            "browser": m.get("browser") or {},
            "operations": operations,
        }
    primary = stored.get("default")
    owner = stored.get("owner-gui-v1")
    effective_gui = owner["gui"] if owner is not None else gui
    browser_available = primary is not None and primary["browser"].get("available") is True
    browser_status = (
        ("READY" if browser_available else "UNAVAILABLE")
        if primary is not None else "OTHER_PROFILE_UNVERIFIED"
    )
    operations_status = primary["operations"].get("active") if primary is not None else None
    return {
        "state": "CONNECTED",
        "device": str(device or "?")[:80],
        "version": str(version or "?")[:40],
        "profile": str(profile or "?")[:64],
        "gui": "READY" if effective_gui.get("available") is True else "BLOCKED",
        "guiReason": str(effective_gui.get("reason") or "")[:100],
        "browser": browser_status,
        "browserReason": (
            "Fresh default-profile monitor; GUI worker verified separately"
            if primary is not None else "GUI worker snapshot; primary Browser readiness unverified"
        ),
        "activeOperations": operations_status,
        "extensions": len((m.get("extensions") or {}).get("items") or []),
    }


def profiles():
    records = []
    if not ROUTING.is_dir() or ROUTING.is_symlink():
        return records
    for f in sorted(ROUTING.glob("*.json")):
        if f.name.endswith(".runtime.json"):
            continue
        name = f.stem
        if not PROFILE_RE.fullmatch(name) or ".." in name:
            continue
        meta = bounded_json(f, 4096)
        runtime_path = ROUTING / (name + ".runtime.json")
        runtime = bounded_json(runtime_path, 4096)
        if not meta or not runtime or meta.get("profile") != name:
            continue
        if runtime.get("stateFile") != str(f.resolve()):
            continue
        active = meta.get("active") or {}
        records.append({
            "id": name,
            "version": str(active.get("version") or "UNKNOWN")[:30],
            "port": active.get("port"),
            "generation": meta.get("generation"),
            "root": str(active.get("projectDir") or "")[:160],
        })
    # The owner GUI worker deliberately has its own private config rather
    # than a routing/*.runtime.json pair. Do not lose it from this inventory.
    owner_gui = bounded_json(OWNER_GUI_CONFIG, 16384)
    if (owner_gui and (owner_gui.get("instance") or {}).get("profile") == "owner-gui-v1"
            and owner_gui.get("port") == 48837):
        policy = (owner_gui.get("powerMode") or {}).get("guiControl") or {}
        restricted = not bool(policy.get("allowMouse") or policy.get("allowKeyboard"))
        records.append({
            "id": "owner-gui-v1", "type": "GUI_WORKER", "version": "INDEPENDENT",
            "port": 48837, "generation": None,
            "root": "Owner GUI worker · " + ("observe-only access" if restricted else "review granted GUI policy"),
            "access": "OWNER_GUI_POLICY", "editableHere": False,
        })

    # A Saeed account connection is separate from both the Core default and
    # the owner GUI. Never infer its scope from a tunnel or inspect its secret.
    try:
        st = SAEED_UNIT.lstat()
        valid = (stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid()
                 and 10 <= st.st_size <= 8192 and not st.st_mode & 0o022)
        if valid:
            unit = SAEED_UNIT.read_text(encoding="utf-8")
            valid = ("Description=Saeed account tunnel to Emad laptop" in unit
                     and "saeed-emad-laptop" in unit)
        if valid:
            records.append({
                "id": "saeed-emad", "type": "ACCOUNT_TUNNEL",
                "version": "ACCOUNT_CONNECTOR", "port": None,
                "generation": None,
                "root": "Saeed ChatGPT tunnel · independent credential · permissions require account-bound owner policy",
                "access": "ACCOUNT_SCOPE_UNVERIFIED", "editableHere": False,
            })
    except (OSError, ValueError, UnicodeError):
        pass
    return records


def workflows(limit=300):
    # Read only the existing owner-state database; SQLite query_only prevents
    # implicit schema migration, scheduling, revision writes or task execution.
    if not WORKFLOWS.is_file() or WORKFLOWS.is_symlink():
        return []
    if WORKFLOWS.stat().st_uid != os.getuid():
        return []
    records = []
    try:
        import urllib.parse
        uri = "file:" + urllib.parse.quote(str(WORKFLOWS), safe="/") + "?mode=ro"
        c = sqlite3.connect(uri, uri=True, timeout=0.4)
        try:
            c.execute("PRAGMA query_only=ON")
            c.execute("PRAGMA busy_timeout=400")
            cursor = c.execute("SELECT id,revision,snapshot FROM workflows ORDER BY id LIMIT ?", (limit,))
            for ident, rev, snapshot in cursor:
                if not isinstance(ident, str) or not PROFILE_RE.fullmatch(ident):
                    continue
                if not isinstance(snapshot, str) or len(snapshot) > 500_000:
                    continue
                try:
                    doc = json.loads(snapshot)
                except (ValueError, TypeError):
                    continue
                state = str(doc.get("lifecycleState") or "UNKNOWN")[:30]
                records.append({"id": ident, "revision": rev, "state": state})
        finally:
            c.close()
    except (OSError, sqlite3.Error):
        return []
    return records



def autofollow_status(root=None, unit_dir=None):
    """Show only explicit owner-private receipt metadata. Never trust plan text
    as an action and never infer a live systemd process from old install logs.
    """
    import hashlib
    project = Path(root) if root is not None else AUTOFOLLOW_ROOT
    units = Path(unit_dir) if unit_dir is not None else AUTOFOLLOW_UNITS
    fallback = {"state": "NOT_CONFIGURED_OR_UNVERIFIED", "modelStatus": "UNVERIFIED",
                "timerLiveState": "UNVERIFIED_NO_SYSTEMD_QUERY", "workflowMutation": False,
                "chatDeliveryBound": False, "lastReceiptId": "NONE"}
    try:
        if not project.is_dir() or project.is_symlink() or project.stat().st_uid != os.getuid():
            return fallback
        receipt = bounded_json(project / "INSTALL_R2_RECEIPT.json", 8192)
        brain = bounded_json(project / "BRAIN_VERIFY_R1.json", 4096)
        if not receipt or not brain:
            return fallback
        if receipt.get("status") != "PASS_USER_ONLY_AUTOFOLLOW_TIMER_R2":
            return fallback
        if receipt.get("workflowMutation") is not False or receipt.get("chatAccountBoundDelivery") is not False:
            return fallback
        expected = receipt.get("unitSha256")
        if not isinstance(expected, dict):
            return fallback
        for name in ("rc-autofollow.service", "rc-autofollow.timer"):
            p = units / name
            if p.is_symlink() or not p.is_file() or p.stat().st_uid != os.getuid():
                return fallback
            if p.stat().st_mode & 0o022 or p.stat().st_size > 8192:
                return fallback
            actual = hashlib.sha256(p.read_bytes()).hexdigest()
            if actual != expected.get(name):
                return fallback
        zip_path = project / "BRAIN_R1.zip"
        if zip_path.is_symlink() or not zip_path.is_file() or zip_path.stat().st_uid != os.getuid():
            return fallback
        if zip_path.stat().st_size > 1_000_000:
            return fallback
        if brain.get("status") != "PASS_R1_CUMULATIVE_AUTOFOLLOW_ACCOUNT_TRANSFER":
            return fallback
        if hashlib.sha256(zip_path.read_bytes()).hexdigest() != brain.get("sha256"):
            return fallback
        report_dir = project / "RESULTS"
        if report_dir.is_symlink() or not report_dir.is_dir():
            return {"state": "CONFIGURED_NO_REPORT", **{k:v for k,v in fallback.items() if k!="state"}}
        report = bounded_json(report_dir / "CURRENT.json", 16384)
        base = {"state": "CONFIGURED_SOURCE_VERIFIED",
                "modelStatus": "UNVERIFIED", "timerLiveState": "UNVERIFIED_NO_SYSTEMD_QUERY",
                "workflowMutation": False, "chatDeliveryBound": False, "lastReceiptId": "NONE"}
        if report and report.get("schema") == 1 and report.get("noActionsExecuted") is True and report.get("chatDelivery") is False:
            ident = report.get("id")
            value = report.get("modelStatus")
            if isinstance(ident,str) and re.fullmatch(r"RUN_[0-9]{8}T[0-9]{6}Z",ident):
                base["lastReceiptId"] = ident
            if isinstance(value,str) and re.fullmatch(r"(?:PASS_PROPOSAL_ONLY|UNVERIFIED_[A-Za-z0-9_]{1,48}|SKIPPED_[A-Za-z0-9_]{1,48})",value):
                base["modelStatus"] = value
        return base
    except (OSError, ValueError, TypeError):
        return fallback

def audit():
    data = monitor_status()
    result = {
        "schema": 1,
        "product": "Remote Commander Control Center",
        "mode": "READ_ONLY_CANDIDATE",
        "monitor": data.get("state"),
        "profileCount": len(profiles()),
        "workflowCountInStore": len(workflows()),
        "operationsShownAsLiveOnly": True,
        "durableRunningIsNotActive": True,
        "workflowControlEnabled": False,
        "credentialAccess": False,
        "localAIFollowup": autofollow_status()["state"],
        "localAIWorkflowMutation": False,
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


def run_gui():
    """R32 read-only GTK4/Adwaita presentation; source/backend unchanged."""
    from dashboard_ui import run_dashboard

    return run_dashboard(APP_ID, monitor_status, profiles, workflows,
                         autofollow_status, effective_system_dark, sys.argv)


if __name__ == "__main__":
    raise SystemExit(audit() if "--audit" in sys.argv else run_gui())
