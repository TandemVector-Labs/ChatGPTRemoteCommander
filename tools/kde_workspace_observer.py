#!/usr/bin/env python3
"""Read-only KWin scripting metadata; no capture, focus, or input operations."""
import json
import os
import re
import secrets
import tempfile
import time
from pathlib import Path
import gi
gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
from gi.repository import Gio, GLib

class MetadataError(Exception):
    pass

def validate_metadata(data):
    if not isinstance(data,dict) or not isinstance(data.get("screens"),list) or not 1<=len(data["screens"])<=32:
        raise MetadataError("KDE_SCREEN_METADATA_INVALID")

    def valid_rect(rect):
        if not isinstance(rect,dict) or any(type(rect.get(k)) is not int for k in ("left","top","width","height")):
            raise MetadataError("KDE_SCREEN_GEOMETRY_INVALID")
        if not 1<=rect["width"]<=32768 or not 1<=rect["height"]<=32768:
            raise MetadataError("KDE_SCREEN_GEOMETRY_INVALID")

    for rect in data["screens"]:
        valid_rect(rect)
    if not isinstance(data.get("cursor"),dict) or any(type(data["cursor"].get(k)) not in (int,float) for k in ("x","y")):
        raise MetadataError("KDE_CURSOR_INVALID")

    # An idle KDE/X11 desktop may legitimately have NO active foreground window.
    # This is read-only status, NEVER authority to capture or send GUI input.
    if data.get("foreground")=="" and data.get("processId")==0 and \
       data.get("windowBounds") is None and data.get("clientBounds") is None:
        return {**data,"activeWindowPresent":False}

    valid_rect(data.get("windowBounds"))
    valid_rect(data.get("clientBounds"))
    if not isinstance(data.get("foreground"),str) or not re.fullmatch(r"\{?[a-fA-F0-9-]{36}\}?",data["foreground"]):
        raise MetadataError("KDE_FOREGROUND_UNAVAILABLE")
    if type(data.get("processId")) is not int or not 1<=data["processId"]<=2**31-1:
        raise MetadataError("KDE_FOREGROUND_PID_INVALID")
    return {**data,"activeWindowPresent":True}


def snapshot():
    bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
    kwin_owner=bus.call_sync("org.freedesktop.DBus","/org/freedesktop/DBus",
        "org.freedesktop.DBus","GetNameOwner",GLib.Variant("(s)",("org.kde.KWin",)),
        GLib.VariantType.new("(s)"),Gio.DBusCallFlags.NONE,1500,None).unpack()[0]
    nonce=secrets.token_hex(12)
    callback_path="/org/chatgpt/RemoteCommander/Metadata/"+nonce
    interface="org.chatgpt.RemoteCommander.Metadata"
    xml='<node><interface name="'+interface+'"><method name="Report"><arg type="s" direction="in"/></method></interface></node>'
    box={}
    def report(_conn,sender,_path,_iface,method,parameters,invocation):
        if sender!=kwin_owner or method!="Report":
            invocation.return_dbus_error(interface+".Denied","DENIED")
            return
        try:
            raw=parameters.unpack()[0]
            if len(raw)>16384:raise ValueError()
            box["data"]=validate_metadata(json.loads(raw))
            invocation.return_value(GLib.Variant("()",()))
        except Exception:
            box["error"]="KDE_METADATA_INVALID"
            invocation.return_dbus_error(interface+".Invalid","INVALID_METADATA")
    registration=bus.register_object(callback_path,Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0],report,None,None)
    plugin="rc_metadata_"+nonce
    script_id=None
    script=("""
function rect(r) { return {left:Math.round(r.x),top:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}; }
const w=workspace.activeWindow;
const data={foreground:w?String(w.internalId):"",processId:w?w.pid:0,windowBounds:w?rect(w.frameGeometry):null,clientBounds:w?rect(w.clientGeometry):null,
 cursor:{x:workspace.cursorPos.x,y:workspace.cursorPos.y},
 screens:workspace.screens.map(function(s){return rect(s.geometry);})};
callDBus(DEST,PATH,IFACE,"Report",JSON.stringify(data));
""".replace("DEST",json.dumps(bus.get_unique_name())).replace("PATH",json.dumps(callback_path)).replace("IFACE",json.dumps(interface)))
    def call(object_path,iface,method,args=None,reply=None):
        return bus.call_sync("org.kde.KWin",object_path,iface,method,args,reply,Gio.DBusCallFlags.NONE,1500,None)
    try:
        with tempfile.TemporaryDirectory(prefix="rc-kde-readonly-metadata-") as temp:
            file=Path(temp)/"metadata.js"
            file.write_text(script);file.chmod(0o600)
            script_id=call("/Scripting","org.kde.kwin.Scripting","loadScript",GLib.Variant("(ss)",(str(file),plugin)),GLib.VariantType.new("(i)")).unpack()[0]
            if script_id<0:raise MetadataError("KDE_METADATA_SCRIPT_LOAD_FAILED")
            found=False
            for candidate in ("/Scripting/Script"+str(script_id),"/"+str(script_id)):
                try:
                    call(candidate,"org.kde.kwin.Script","run")
                    found=True
                    break
                except GLib.Error:
                    continue
            if not found:raise MetadataError("KDE_METADATA_SCRIPT_RUN_FAILED")
            deadline=time.monotonic()+2
            ctx=GLib.MainContext.default()
            while not box and time.monotonic()<deadline:
                while ctx.pending():ctx.iteration(False)
                time.sleep(.005)
            if "data" not in box:raise MetadataError(box.get("error","KDE_METADATA_TIMEOUT"))
            return box["data"]
    finally:
        if script_id is not None:
            try:call("/Scripting","org.kde.kwin.Scripting","unloadScript",GLib.Variant("(s)",(plugin,)))
            except GLib.Error:pass
        bus.unregister_object(registration)

if __name__=="__main__":
    try:
        result=snapshot()
        print(json.dumps({"metadataValidated":True,"inputSent":False,"screenCount":len(result["screens"])}))
    except Exception as e:
        print(json.dumps({"ok":False,"error":str(e) if isinstance(e,MetadataError) else "KDE_METADATA_FAILED"}))
        raise SystemExit(1)
