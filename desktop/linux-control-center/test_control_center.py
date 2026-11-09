import importlib.util
import json
import os
import sqlite3
import stat
import tempfile
import time
import unittest
from pathlib import Path

P = Path(__file__).with_name("control_center.py")
spec = importlib.util.spec_from_file_location("rc_center", P)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class SafeMonitorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="rc-center-r1-")
        self.root = Path(self.tmp.name)
        self.old = (m.MONITOR,m.ROUTING,m.WORKFLOWS,m.OWNER_GUI_CONFIG,m.SAEED_UNIT)
        m.MONITOR = self.root/"monitor.json"
        m.ROUTING = self.root/"routing"
        m.WORKFLOWS = self.root/"workflows.sqlite"
        m.OWNER_GUI_CONFIG = self.root/"missing-owner-gui.json"
        m.SAEED_UNIT = self.root/"missing-saeed.service"
        m.ROUTING.mkdir(mode=0o700)
    def tearDown(self):
        m.MONITOR,m.ROUTING,m.WORKFLOWS,m.OWNER_GUI_CONFIG,m.SAEED_UNIT = self.old
        self.tmp.cleanup()
    def dump(self,p,obj):
        p.write_text(json.dumps(obj),encoding="utf8")
        p.chmod(0o600)
    def valid_monitor(self,adjust=0):
        now=int(time.time()*1000)
        return {"schema":1,"kind":"COMMANDER_LIVE_MONITOR",
                "observedAtEpochMs":now-100,"expiresAtEpochMs":now+10000+adjust,
                "identity":{"deviceName":"fixture","version":"0.10.20","profile":"default"},
                "gui":{"available":False,"reason":"UNVERIFIED"},
                "browser":{"available":True},"operations":{"active":0},
                "extensions":{"items":[]}}
    def test_fresh_monitor(self):
        self.dump(m.MONITOR,self.valid_monitor())
        s=m.monitor_status()
        self.assertEqual(s["state"],"CONNECTED")
        self.assertEqual(s["gui"],"BLOCKED")
        self.assertEqual(s["activeOperations"],0)
    def test_owner_gui_monitor_is_not_primary_browser_or_core_activity(self):
        sample = self.valid_monitor()
        sample["identity"]["profile"] = "owner-gui-v1"
        sample["browser"] = {"enabled": False, "available": False}
        sample["operations"] = {"active": 0}
        self.dump(m.MONITOR, sample)
        result = m.monitor_status()
        self.assertEqual(result["state"], "CONNECTED")
        self.assertEqual(result["gui"], "BLOCKED")
        self.assertEqual(result["browser"], "OTHER_PROFILE_UNVERIFIED")
        self.assertIsNone(result["activeOperations"])
        self.assertIn("GUI worker", result["browserReason"])

    def test_primary_profile_browser_evidence_is_preserved(self):
        sample = self.valid_monitor()
        sample["identity"]["profile"] = "default"
        self.dump(m.MONITOR, sample)
        result = m.monitor_status()
        self.assertEqual(result["browser"], "READY")
        self.assertEqual(result["activeOperations"], 0)

    def test_foreign_monitor_does_not_claim_ready_even_if_browser_true(self):
        sample = self.valid_monitor()
        sample["identity"]["profile"] = "owner-gui-v1"
        self.dump(m.MONITOR, sample)
        self.assertEqual(m.monitor_status()["browser"], "OTHER_PROFILE_UNVERIFIED")

    def test_multi_profile_fresh_snapshots_aggregate_without_false_unavailable(self):
        primary = self.valid_monitor()
        primary["identity"].update({"profile": "default", "deviceName": "fleet"})
        primary["browser"] = {"available": True}
        primary["operations"] = {"active": 2}
        self.dump(m.MONITOR, primary)
        self.assertEqual(m.monitor_status()["browser"], "READY")
        owner = self.valid_monitor()
        owner["identity"].update({"profile": "owner-gui-v1", "deviceName": "fleet"})
        owner["gui"] = {"available": True}
        owner["browser"] = {"available": False}
        self.dump(m.MONITOR, owner)
        combined = m.monitor_status()
        self.assertEqual(combined["browser"], "READY")
        self.assertEqual(combined["gui"], "READY")
        self.assertEqual(combined["activeOperations"], 2)

    def test_multi_profile_cross_device_cache_is_never_reused(self):
        primary = self.valid_monitor()
        primary["identity"].update({"profile": "default", "deviceName": "host-a"})
        self.dump(m.MONITOR, primary)
        self.assertEqual(m.monitor_status()["browser"], "READY")
        foreign = self.valid_monitor()
        foreign["identity"].update({"profile": "owner-gui-v1", "deviceName": "host-b"})
        foreign["browser"] = {"available": False}
        self.dump(m.MONITOR, foreign)
        self.assertEqual(m.monitor_status()["browser"], "OTHER_PROFILE_UNVERIFIED")

    def test_stale_monitor_never_shows_connected(self):
        self.dump(m.MONITOR,self.valid_monitor(adjust=-100000))
        self.assertEqual(m.monitor_status()["state"],"DISCONNECTED")
    def test_missing_private_file(self):
        self.assertEqual(m.monitor_status()["state"],"UNVERIFIED")
    def test_symlink_rejected(self):
        original=self.root/"owner.json"
        self.dump(original,self.valid_monitor())
        m.MONITOR.symlink_to(original)
        self.assertEqual(m.monitor_status()["state"],"UNVERIFIED")
    def test_unsafe_permissions_rejected(self):
        self.dump(m.MONITOR,self.valid_monitor())
        m.MONITOR.chmod(0o666)
        self.assertEqual(m.monitor_status()["state"],"UNVERIFIED")
    def test_profile_pair_exact_canonical_root(self):
        p=m.ROUTING/"default.json"
        self.dump(p,{"profile":"default","active":{"version":"0.10.20","port":48832},"generation":4})
        q=m.ROUTING/"default.runtime.json"
        self.dump(q,{"stateFile":str(p.resolve())})
        self.assertEqual(m.profiles()[0]["id"],"default")
        self.dump(q,{"stateFile":"/tmp/wrong.json"})
        self.assertEqual(m.profiles(),[])
    def test_owner_gui_and_saeed_tunnel_are_separate_local_roles(self):
        owner = self.root / "owner-config.json"
        saeed = self.root / "saeed-emad-laptop-tunnel.service"
        self.dump(owner, {
            "instance": {"profile": "owner-gui-v1"}, "port": 48837,
            "powerMode": {"guiControl": {"allowMouse": False, "allowKeyboard": False}}})
        saeed.write_text("[Unit]\\nDescription=Saeed account tunnel to Emad laptop\\n[Service]\\nExecStart=/bin/echo saeed-emad-laptop\\n", encoding="utf8")
        saeed.chmod(0o600)
        original = (m.OWNER_GUI_CONFIG, m.SAEED_UNIT)
        m.OWNER_GUI_CONFIG, m.SAEED_UNIT = owner, saeed
        try:
            result = m.profiles()
            by_name = {x["id"]: x for x in result}
            self.assertIn("owner-gui-v1", by_name)
            self.assertIn("saeed-emad", by_name)
            self.assertNotEqual(by_name["owner-gui-v1"]["type"], by_name["saeed-emad"]["type"])
            self.assertFalse(by_name["saeed-emad"]["editableHere"])
            self.assertEqual(by_name["saeed-emad"]["access"], "ACCOUNT_SCOPE_UNVERIFIED")
        finally:
            m.OWNER_GUI_CONFIG, m.SAEED_UNIT = original

    def test_account_tunnel_untrusted_unit_not_accepted(self):
        f = self.root / "saeed-untrusted.service"
        f.write_text("[Unit]\\nDescription=Saeed account tunnel to Emad laptop\\n")
        f.chmod(0o666)
        original = (m.OWNER_GUI_CONFIG, m.SAEED_UNIT)
        m.OWNER_GUI_CONFIG, m.SAEED_UNIT = self.root/"missing.json", f
        try:
            self.assertFalse(any(x["type"] == "ACCOUNT_TUNNEL" for x in m.profiles()))
        finally:
            m.OWNER_GUI_CONFIG, m.SAEED_UNIT = original

    def test_read_only_sqlite_does_not_modify_database(self):
        c=sqlite3.connect(m.WORKFLOWS)
        c.execute("CREATE TABLE workflows (id TEXT, revision INTEGER, snapshot TEXT)")
        c.execute("INSERT INTO workflows VALUES (?,?,?)",("probe",3,json.dumps({"lifecycleState":"WAITING"})))
        c.commit(); c.close()
        before=m.WORKFLOWS.stat().st_mtime_ns
        self.assertEqual(m.workflows(),[{"id":"probe","revision":3,"state":"WAITING"}])
        self.assertEqual(m.WORKFLOWS.stat().st_mtime_ns,before)
    def test_rejects_spoofed_workflow_identifiers(self):
        c=sqlite3.connect(m.WORKFLOWS)
        c.execute("CREATE TABLE workflows (id TEXT, revision INTEGER, snapshot TEXT)")
        c.execute("INSERT INTO workflows VALUES (?,?,?)",("../escape",1,json.dumps({"lifecycleState":"RUNNING"})))
        c.commit();c.close()
        self.assertEqual(m.workflows(),[])


if __name__=="__main__":
    unittest.main(verbosity=2)
