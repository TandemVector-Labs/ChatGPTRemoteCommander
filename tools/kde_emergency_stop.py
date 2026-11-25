"""Bounded per-operation Escape registration through KDE KGlobalAccel.
A separate watcher owns registration and reaps it on parent-pipe EOF/deadline.
No existing shortcut is stolen. No key events are read or injected.
"""
import os,select,secrets,signal,subprocess,sys,time
import gi
gi.require_version("Gio","2.0")
gi.require_version("GLib","2.0")
from gi.repository import Gio,GLib
SERVICE="org.kde.kglobalaccel"
IFACE="org.kde.KGlobalAccel"
ESCAPE=16777216

def call(bus,method,signature,args,path="/kglobalaccel",interface=IFACE):
    return bus.call_sync(SERVICE,path,interface,method,GLib.Variant(signature,args),
                         None,Gio.DBusCallFlags.NONE,1000,None)

def unregister(component,action):
    bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
    call(bus,"unregister","(ss)",(component,action))

class EmergencyStop:
    def __init__(self):
        self.component="remote_commander_stop_"+secrets.token_hex(10)
        self.action="_k_session:emergency_stop"
        self.child=None
        self.cancelled=False
    def __enter__(self):
        self.child=subprocess.Popen([sys.executable,__file__,"--watch",self.component,self.action],
          stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,bufsize=0)
        try:
            if not select.select([self.child.stdout],[],[],2.5)[0] or self.child.stdout.readline()!=b"READY\n":
                raise RuntimeError("GUI_KDE_EMERGENCY_STOP_UNAVAILABLE")
            return self
        except Exception:
            self.__exit__(None,None,None)
            raise
    def poll(self):
        while select.select([self.child.stdout],[],[],0)[0]:
            line=self.child.stdout.readline()
            if line==b"STOP\n":self.cancelled=True
            if not line:break
        if self.cancelled:return True
        if self.child.poll() is not None:raise RuntimeError("GUI_KDE_EMERGENCY_STOP_LOST")
        return False
    def __exit__(self,*args):
        if not self.child:return
        try:
            self.child.stdin.close()
            try:self.child.wait(timeout=1.5)
            except subprocess.TimeoutExpired:
                self.child.terminate()
                try:self.child.wait(timeout=1.5)
                except subprocess.TimeoutExpired:self.child.kill();self.child.wait(timeout=1)
        finally:
            # Also reconcile a watcher crash using only our nonce-owned identity.
            unregister(self.component,self.action)
            self.child.stdout.close()

def watch(component,action):
    bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
    registered=False;subscription=None;loop=GLib.MainLoop()
    try:
        if not call(bus,"isGlobalShortcutAvailable","(is)",(ESCAPE,"")).unpack()[0]:
            raise RuntimeError("ESCAPE_BUSY")
        ident=[component,action,"Remote Commander","Emergency stop"]
        call(bus,"doRegister","(as)",(ident,));registered=True
        keys=call(bus,"setShortcut","(asaiu)",(ident,[ESCAPE],6)).unpack()[0]
        if keys!=[ESCAPE]:raise RuntimeError("ESCAPE_NOT_BOUND")
        object_path=call(bus,"getComponent","(s)",(component,)).unpack()[0]
        owner=bus.call_sync("org.freedesktop.DBus","/org/freedesktop/DBus",
          "org.freedesktop.DBus","GetNameOwner",GLib.Variant("(s)",(SERVICE,)),
          None,Gio.DBusCallFlags.NONE,1000,None).unpack()[0]
        def pressed(_bus,sender,_path,_iface,_signal,parameters):
            values=parameters.unpack()
            if sender==owner and values[0]==component and values[1]==action:
                print("STOP",flush=True);loop.quit()
        subscription=bus.signal_subscribe(owner,"org.kde.kglobalaccel.Component","globalShortcutPressed",
          object_path,None,Gio.DBusSignalFlags.NONE,pressed)
        def parent_event(*_):
            # The parent never sends bytes. EOF means normal close or parent crash.
            loop.quit();return False
        GLib.io_add_watch(sys.stdin,GLib.IOCondition.IN|GLib.IOCondition.HUP|GLib.IOCondition.ERR,parent_event)
        GLib.timeout_add(8000,lambda:(loop.quit(),False)[1])
        for sig in (signal.SIGTERM,signal.SIGINT):
            GLib.unix_signal_add(GLib.PRIORITY_DEFAULT,sig,lambda:(loop.quit(),False)[1])
        print("READY",flush=True)
        loop.run()
    finally:
        if subscription is not None:bus.signal_unsubscribe(subscription)
        if registered:call(bus,"unregister","(ss)",(component,action))

if __name__=="__main__":
    if len(sys.argv)==4 and sys.argv[1]=="--watch":
        try:watch(sys.argv[2],sys.argv[3])
        except Exception:raise SystemExit(1)
    else:raise SystemExit(2)
