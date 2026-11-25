"""Opt-in KDE Portal runtime. All native input uses consented RemoteDesktop API.
KWin scripting is used only for read-only foreground/cursor metadata.
The D-Bus Notify transport is separate from the diagnostic EIS session.
"""
import json
import math
import os
import re
import secrets
import stat
import subprocess
import time
from pathlib import Path
import gi
gi.require_version("Gio","2.0")
gi.require_version("GLib","2.0")
from gi.repository import Gio, GLib
from kde_workspace_observer import snapshot
from kde_emergency_stop import EmergencyStop

# Linux/X11 owner-window enumeration. Read-only metadata; never focuses a window.
# On Wayland this method returns no window enumeration rather than bypassing portals.
def x11_owner_windows(runtime_env=None,runner=subprocess.run,statter=os.lstat):
    env=dict(os.environ if runtime_env is None else runtime_env)
    if env.get("XDG_SESSION_TYPE")!="x11":
        return []
    try:
        if not env.get("DISPLAY") or not env.get("XAUTHORITY"):
            proc=runner(["/usr/bin/systemctl","--user","show-environment"],
                        capture_output=True,text=True,timeout=1)
            if proc.returncode!=0:
                return []
            for line in proc.stdout.splitlines():
                if line.startswith(("DISPLAY=","XAUTHORITY=")):
                    key,value=line.split("=",1)
                    env.setdefault(key,value)
        if not re.fullmatch(r":[0-9]{1,3}(?:\.[0-9])?",env.get("DISPLAY","")):
            return []
        auth=env.get("XAUTHORITY","")
        if not auth.startswith("/"):
            return []
        st=statter(auth)
        if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o022:
            return []
        env={**env,"LC_ALL":"C.UTF-8"}
        def xprop(*args):
            out=runner(["/usr/bin/xprop",*args],capture_output=True,text=True,
                       timeout=0.75,env=env)
            if out.returncode!=0 or len(out.stdout)>12000:
                raise ValueError("X11_METADATA_UNAVAILABLE")
            return out.stdout
        root=xprop("-root","_NET_CLIENT_LIST","_NET_ACTIVE_WINDOW")
        clients=re.search(r"^_NET_CLIENT_LIST\(WINDOW\):\s*window id #\s*(.*)$",root,re.M)
        active=re.search(r"^_NET_ACTIVE_WINDOW\(WINDOW\):\s*window id #\s*(0x[0-9a-fA-F]+)$",root,re.M)
        if not clients or not active:
            return []
        handles=re.findall(r"0x[0-9a-fA-F]+",clients.group(1))
        foreground=int(active.group(1),16)
        items=[]
        deadline=time.monotonic()+2.8
        for handle in handles[:32]:
            if time.monotonic()>=deadline:
                break
            try:
                body=xprop("-id",handle,"_NET_WM_PID","WM_CLASS","_NET_WM_NAME")
                pid=re.search(r"^_NET_WM_PID\(CARDINAL\)\s*=\s*([0-9]{1,12})$",body,re.M)
                klass=re.search(r"^WM_CLASS\(STRING\)\s*=\s*(.*)$",body,re.M)
                title=re.search(r'^_NET_WM_NAME\(UTF8_STRING\)\s*=\s*"([^"\r\n]{4,300})"$',body,re.M)
                if not pid or not klass or not title:
                    continue
                ownerpid=int(pid.group(1))
                if not 1<=ownerpid<=2147483647 or statter("/proc/"+str(ownerpid)).st_uid!=os.getuid():
                    continue
                classes=re.findall(r'"([^"\r\n]{1,100})"',klass.group(1))
                if not classes:
                    continue
                xid=int(handle,16)
                items.append({"handle":str(xid),"processId":ownerpid,"title":title.group(1),
                              "wmClass":classes[-1],"appName":classes[-1],
                              "focused":xid==foreground})
            except (ValueError,FileNotFoundError,PermissionError,subprocess.TimeoutExpired):
                continue
        return items
    except (ValueError,FileNotFoundError,PermissionError,subprocess.TimeoutExpired):
        return []

PORTAL="org.freedesktop.portal.Desktop"
OBJECT="/org/freedesktop/portal/desktop"
REMOTE="org.freedesktop.portal.RemoteDesktop"
ACTIONS={"move":"gui_mouse_move","moveRelative":"gui_mouse_delta","scroll":"gui_mouse_scroll",
 "click":"gui_mouse_click","drag":"gui_mouse_drag","typeText":"gui_type_text","keyPress":"gui_key_press"}
KEYS={"CTRL":29,"SHIFT":42,"ALT":56,"WIN":125,"ENTER":28,"TAB":15,"ESC":1,"SPACE":57,
 "BACKSPACE":14,"DELETE":111,"INSERT":110,"HOME":102,"END":107,"PGUP":104,"PGDN":109,
 "LEFT":105,"RIGHT":106,"UP":103,"DOWN":108}
KEYS.update(dict(zip("QWERTYUIOP",[16,17,18,19,20,21,22,23,24,25])))
KEYS.update(dict(zip("ASDFGHJKL",[30,31,32,33,34,35,36,37,38])))
KEYS.update(dict(zip("ZXCVBNM",[44,45,46,47,48,49,50])))
KEYS.update({str(i):(i+1 if i else 11) for i in range(10)})
KEYS.update({"F"+str(i):(58+i if i<=10 else 76+i) for i in range(1,13)})
BUTTONS={"left":272,"right":273,"middle":274}

class PrecheckError(Exception):
    pass

class Runtime:
    def __init__(self,portal_type,error_type,incident_pending):
        self.stop_monitor_factory=EmergencyStop
        self.Portal=portal_type
        self.Error=error_type
        self.incident_pending=incident_pending
        self.portal=None
        self.observe=snapshot
        self.last_frame=None
        self.last_frame_at=0
        self.started_effect=False
        self.keys=[]
        self.buttons=[]
        self.syms=[]
        self.state=Path(os.environ.get("XDG_STATE_HOME",str(Path.home()/".local/state")))/"chatgpt-remote-commander"

    def stopped(self,req):
        local=req.get("stopFile")
        if (self.state/"GUI_STOP").exists():
            return True
        return isinstance(local,str) and local.endswith("/var/GUI_STOP") and Path(local).exists()

    def admit(self,req):
        # Controller creates this exact write-ahead record BEFORE mutating helper
        # invocation. Only its internal operation ID may match; tool schemas do
        # not accept an operation ID from an external GUI request.
        p=self.state/"gui-pending-native-input-v1.json"
        st=p.lstat()
        if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_uid!=os.getuid() or st.st_mode&0o077 or not 1<=st.st_size<=2048:
            raise PrecheckError("GUI_KDE_PRECHECK_FAILED")
        raw=p.read_text()
        doc=json.loads(raw)
        if (doc.get("schema")!="rc-gui-pending-input-v1" or doc.get("status")!="PENDING_NATIVE_EFFECT" or
            doc.get("id")!=req.get("nativeOperationId") or doc.get("tool")!=ACTIONS.get(req.get("action"))):
            raise PrecheckError("GUI_KDE_PRECHECK_FAILED")

    def record(self,phase,req):
        ident=req.get("nativeOperationId")
        if not isinstance(ident,str) or not re.fullmatch(r"[a-zA-Z0-9-]{8,128}",ident):
            raise PrecheckError("GUI_KDE_PRECHECK_FAILED")
        folder=self.state/"native-operation-phases-v1"
        folder.mkdir(mode=0o700,parents=True,exist_ok=True)
        st=folder.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077 or folder.resolve()!=folder:
            raise RuntimeError("GUI_NATIVE_RECEIPT_STORAGE_FAILED")
        dest=folder/(ident+".json")
        previous=None
        if dest.exists():
            ds=dest.lstat()
            if not stat.S_ISREG(ds.st_mode) or ds.st_nlink!=1 or ds.st_uid!=os.getuid() or ds.st_mode&0o077 or ds.st_size>2048:
                raise RuntimeError("GUI_NATIVE_RECEIPT_STORAGE_FAILED")
            doc=json.loads(dest.read_text())
            if doc.get("id")!=ident:raise RuntimeError("GUI_NATIVE_RECEIPT_STORAGE_FAILED")
            previous=doc.get("phase")
        allowed={None:{"PRECHECK"},"PRECHECK":{"DISPATCH_STARTED","NOT_DISPATCHED"},
                 "DISPATCH_STARTED":{"NATIVE_ACK","UNKNOWN"}}
        if phase not in allowed.get(previous,set()):
            raise RuntimeError("GUI_NATIVE_OPERATION_ALREADY_RECORDED")
        temp=folder/(ident+"."+secrets.token_hex(8)+".tmp")
        fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        try:
            os.write(fd,(json.dumps({"schema":"rc-native-phase-v1","id":ident,"phase":phase,
             "backend":"kde-xdg-portal-dbus","utc":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
             "applicationPostconditionVerified":False})+"\n").encode())
            os.fsync(fd)
        finally:os.close(fd)
        os.replace(temp,dest)
        fd=os.open(folder,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)

    def send(self,method,signature,args):
        if not self.portal or not self.portal.started or self.portal.eis_consumed:
            raise RuntimeError("GUI_PORTAL_SESSION_NOT_ACTIVE")
        self.portal.bus.call_sync(PORTAL,OBJECT,REMOTE,method,
            GLib.Variant(signature,(self.portal.session_path,{},*args)),None,
            Gio.DBusCallFlags.NONE,1500,None)

    def close(self):
        if self.portal:
            try:self.portal.close()
            finally:self.portal=None
        self.last_frame=None

    def screen(self):
        if not self.portal or not self.portal.started or not self.portal.streams:
            raise PrecheckError("GUI_KDE_PRECHECK_FAILED")
        node,props=self.portal.streams[0]
        size=props.get("size")
        position=props.get("position",(0,0))
        if not isinstance(size,(list,tuple)) or len(size)!=2 or not all(type(v) is int and v>0 for v in size):
            raise PrecheckError("GUI_KDE_PRECHECK_FAILED")
        if not isinstance(position,(list,tuple)) or len(position)!=2 or not all(type(v) is int for v in position):
            raise PrecheckError("GUI_KDE_PRECHECK_FAILED")
        return int(node),{"left":position[0],"top":position[1],"width":size[0],"height":size[1]}

    def capture(self,req):
        # Avoid opening an OS consent portal when no active target exists.
        if self.observe().get("activeWindowPresent") is not True:
            raise PrecheckError("GUI_KDE_FOREGROUND_REQUIRED")
        if req.get("screenIndex",0)!=0:
            raise PrecheckError("GUI_KDE_CAPTURED_SOURCE_REQUIRED")
        if not self.portal:
            self.portal=self.Portal()
            try:
                self.portal.create_session()
                self.portal.prepare_sources_and_input()
                self.portal.start()
            except Exception:
                try:self.close()
                except Exception:pass
                raise
        before=self.observe()
        frame=self.portal.capture_jpeg(req.get("maxWidth",1600),req.get("quality",70))
        after=self.observe()
        if (before["foreground"],before["processId"],before["windowBounds"],before["screens"])!=(after["foreground"],after["processId"],after["windowBounds"],after["screens"]):
            raise PrecheckError("GUI_FOREGROUND_OR_GEOMETRY_CHANGED")
        node,bounds=self.screen()
        self.target_covered(after,bounds)
        self.last_frame={"foreground":after["foreground"],"processId":after["processId"],"bounds":bounds,"screenIndex":0,"targetBounds":after["windowBounds"],"screens":after["screens"],"targetClientBounds":after.get("clientBounds")}
        self.last_frame_at=time.monotonic()
        frame.update(snapshot=dict(self.last_frame),freshFrameVerified=True,foregroundVerified=True,
                     coordinateSpace="portal-stream-logical",capturedMonotonicNs=time.monotonic_ns())
        return frame

    def point(self,point,bounds):
        x,y=point.get("x"),point.get("y")
        if type(x) not in (int,float) or type(y) not in (int,float) or not math.isfinite(x) or not math.isfinite(y):
            raise PrecheckError("GUI_KDE_PRECHECK_FAILED")
        if point.get("coordinateMode")=="relative":
            if not 0<=x<=1 or not 0<=y<=1:raise PrecheckError("GUI_KDE_PRECHECK_FAILED")
            x=bounds["left"]+round(x*(bounds["width"]-1))
            y=bounds["top"]+round(y*(bounds["height"]-1))
        if not bounds["left"]<=x<bounds["left"]+bounds["width"] or not bounds["top"]<=y<bounds["top"]+bounds["height"]:
            raise PrecheckError("GUI_KDE_PRECHECK_FAILED")
        return float(x-bounds["left"]),float(y-bounds["top"])

    def target_covered(self,current,bounds):
        target=current.get("windowBounds")
        if not isinstance(target,dict) or any(type(target.get(k)) is not int for k in ("left","top","width","height")):
            raise PrecheckError("GUI_KDE_PRECHECK_FAILED")
        if target["width"]<1 or target["height"]<1 or target["left"]<bounds["left"] or target["top"]<bounds["top"] or target["left"]+target["width"]>bounds["left"]+bounds["width"] or target["top"]+target["height"]>bounds["top"]+bounds["height"]:
            raise PrecheckError("GUI_KDE_PRECHECK_FAILED")

    def precheck(self,req):
        self.admit(req)
        if self.stopped(req):raise PrecheckError("GUI_KDE_PRECHECK_FAILED")
        expected=req.get("expected")
        fresh=self.last_frame
        self.last_frame=None
        if not fresh or time.monotonic()-self.last_frame_at>15 or expected!=fresh:
            raise PrecheckError("GUI_FOREGROUND_OR_GEOMETRY_CHANGED")
        current=self.observe()
        node,bounds=self.screen()
        if current["foreground"]!=fresh["foreground"] or current["processId"]!=fresh["processId"] or bounds!=fresh["bounds"]:
            raise PrecheckError("GUI_FOREGROUND_OR_GEOMETRY_CHANGED")
        self.target_covered(current,bounds)
        if current["windowBounds"]!=fresh.get("targetBounds") or current["screens"]!=fresh.get("screens") or current.get("clientBounds")!=fresh.get("targetClientBounds"):
            raise PrecheckError("GUI_FOREGROUND_OR_GEOMETRY_CHANGED")
        action=req["action"]
        if action in ("move","click"):self.point(req,bounds)
        if action=="click" and req.get("button","left") not in BUTTONS:raise PrecheckError("GUI_KDE_PRECHECK_FAILED")
        if action=="drag":
            self.point(req["from"],bounds);self.point(req["to"],bounds)
            if req.get("button","left") not in BUTTONS:raise PrecheckError("GUI_KDE_PRECHECK_FAILED")
        if action=="moveRelative":
            destination={"x":current["cursor"]["x"]+req["dx"],"y":current["cursor"]["y"]+req["dy"]}
            self.point(destination,bounds)
        if action=="drag" and req["from"].get("coordinateMode","absolute")!=req["to"].get("coordinateMode","absolute"):
            raise PrecheckError("GUI_KDE_PRECHECK_FAILED")
        if action=="scroll":
            if type(req.get("delta")) is not int or req["delta"]%120!=0:
                raise PrecheckError("GUI_KDE_PRECHECK_FAILED")
            self.point(current["cursor"],bounds)
            client=current.get("clientBounds")
            x,y=current["cursor"]["x"],current["cursor"]["y"]
            if not isinstance(client,dict) or not client["left"]<=x<client["left"]+client["width"] or not client["top"]<=y<client["top"]+client["height"]:
                raise PrecheckError("GUI_KDE_PRECHECK_FAILED")
        if action=="keyPress" and (not req.get("keys") or any(k not in KEYS for k in req["keys"])):
            raise PrecheckError("GUI_KDE_PRECHECK_FAILED")
        if action=="typeText":
            text=req.get("text")
            if not isinstance(text,str) or not 1<=len(text)<=1024 or any(ord(c)<32 or ord(c)==127 for c in text):
                raise PrecheckError("GUI_KDE_PRECHECK_FAILED")
        return current,node,bounds

    def input(self,req):
        with self.stop_monitor_factory() as monitor:
            return self._input(req,monitor)

    def _input(self,req,monitor):
        self.started_effect=False
        if monitor.poll():raise PrecheckError("GUI_KDE_PRECHECK_FAILED")
        current,node,bounds=self.precheck(req)
        self.record("PRECHECK",req)
        deadline=time.monotonic()+6
        def check():
            if monitor.poll() or self.stopped(req) or time.monotonic()>deadline:raise RuntimeError("GUI_NATIVE_OPERATION_INTERRUPTED")
        def effect(method,signature,args,held=None):
            check()
            if not self.started_effect:
                self.record("DISPATCH_STARTED",req)
                self.started_effect=True
            if held is not None:held[0].append(held[1])
            self.send(method,signature,args)
        def move(point):
            x,y=self.point(point,bounds)
            effect("NotifyPointerMotionAbsolute","(oa{sv}udd)",(node,x,y))
        def key(code,down):
            effect("NotifyKeyboardKeycode","(oa{sv}iu)",(code,int(down)),(self.keys,code) if down else None)
            if not down:self.keys.remove(code)
        def button(code,down):
            effect("NotifyPointerButton","(oa{sv}iu)",(code,int(down)),(self.buttons,code) if down else None)
            if not down:self.buttons.remove(code)
        try:
            action=req["action"]
            if action=="move":move(req)
            elif action=="moveRelative":effect("NotifyPointerMotion","(oa{sv}dd)",(float(req["dx"]),float(req["dy"])))
            elif action=="scroll":
                effect("NotifyPointerAxisDiscrete","(oa{sv}ui)",(int(bool(req.get("horizontal",False))),-int(req["delta"]/120)))
            elif action=="click":
                move(req);code=BUTTONS[req.get("button","left")]
                for _ in range(req.get("clicks",1)):
                    button(code,True);button(code,False)
                    time.sleep(req.get("intervalMs",80)/1000)
            elif action=="drag":
                move(req["from"]);code=BUTTONS[req.get("button","left")];button(code,True)
                steps=req.get("steps",20)
                for i in range(1,steps+1):
                    point={"x":req["from"]["x"]+(req["to"]["x"]-req["from"]["x"])*i/steps,
                           "y":req["from"]["y"]+(req["to"]["y"]-req["from"]["y"])*i/steps,
                           "coordinateMode":req["from"].get("coordinateMode","absolute")}
                    move(point);time.sleep(req.get("durationMs",300)/steps/1000)
                button(code,False)
            elif action=="keyPress":
                for name in req["keys"]:key(KEYS[name],True)
                end=time.monotonic()+req.get("holdMs",30)/1000
                while time.monotonic()<end:check();time.sleep(.01)
                for name in reversed(req["keys"]):key(KEYS[name],False)
            elif action=="typeText":
                for char in req["text"]:
                    fresh=self.observe()
                    if (fresh["foreground"],fresh["processId"])!=(current["foreground"],current["processId"]):
                        raise RuntimeError("GUI_FOREGROUND_CHANGED_AFTER_DISPATCH")
                    code=ord(char) if ord(char)<256 else 0x01000000|ord(char)
                    effect("NotifyKeyboardKeysym","(oa{sv}iu)",(code,1),(self.syms,code))
                    effect("NotifyKeyboardKeysym","(oa{sv}iu)",(code,0))
                    self.syms.remove(code)
                    if req.get("intervalMs"):time.sleep(req["intervalMs"]/1000)
            self.record("NATIVE_ACK",req)
            return {"ok":True,"nativeAcknowledged":True,"applicationPostconditionVerified":False}
        except Exception:
            if self.started_effect:
                self.record("UNKNOWN",req)
            else:
                self.record("NOT_DISPATCHED",req)
                raise PrecheckError("GUI_KDE_PRECHECK_FAILED")
            raise
        finally:
            for code in self.syms[::-1]:
                try:self.send("NotifyKeyboardKeysym","(oa{sv}iu)",(code,0))
                except Exception:pass
            self.syms=[]
            for code in self.keys[::-1]:
                try:self.send("NotifyKeyboardKeycode","(oa{sv}iu)",(code,0))
                except Exception:pass
            for code in self.buttons[::-1]:
                try:self.send("NotifyPointerButton","(oa{sv}iu)",(code,0))
                except Exception:pass
            self.keys=[];self.buttons=[]

    def handle(self,req):
        try:
            action=req.get("action")
            if action=="focusWindow":
                raise PrecheckError("GUI_KDE_PRECHECK_FAILED")
            if action in ACTIONS:
                return self.input(req)
            if self.incident_pending():
                return {"ok":False,"error":"GUI_INCIDENT_REVIEW_REQUIRED"}
            if self.stopped(req):
                self.close();return {"ok":False,"error":"GUI_LOCAL_STOP"}
            if action=="status":
                metadata=self.observe()
                return {"ok":True,"available":True,
                        "foregroundTargetAvailable":metadata.get("activeWindowPresent") is True,
                        "backend":"kde-wayland-xdg-portal",
                        "inputAvailable":True,"consentRequired":True,"consentedSessionActive":bool(self.portal and self.portal.started),
                        "transport":"xdg-portal-dbus-notify","nativeInputReleased":True,"windowFocusAvailable":False,"textControlCharactersSupported":False,"scrollDeltaUnit":120,"partialScrollSupported":False}
            if action=="screenshot":return self.capture(req)
            if action=="cursor":
                return {"ok":True,**self.observe()["cursor"]}
            if action=="listWindows":
                data=self.observe()
                if os.environ.get("XDG_SESSION_TYPE")=="x11":
                    windows=x11_owner_windows()
                    return {"ok":True,"partial":True,"scope":"same-owner-x11-window-metadata",
                            "titlesRedacted":False,"windows":windows}
                windows=([{"handle":"1","title":"Current KDE foreground","processId":data["processId"]}]
                         if data.get("activeWindowPresent") is True else [])
                return {"ok":True,"partial":True,"scope":"foreground-only",
                        "titlesRedacted":True,"windows":windows}
            return {"ok":False,"error":"GUI_KDE_NATIVE_INPUT_NOT_PROMOTED"}
        except PrecheckError as e:
            return {"ok":False,"error":str(e),"effect":"NOT_APPLIED","phase":"PRE_DISPATCH_GUARD","backend":"kde-wayland-xdg-portal"}
        except Exception as error:
            try:self.close()
            except Exception:pass
            code=str(error)
            if not re.fullmatch(r"[A-Z][A-Z0-9_]{2,79}",code):
                code="GUI_KDE_NATIVE_OPERATION_FAILED"
            return {"ok":False,"error":code}
