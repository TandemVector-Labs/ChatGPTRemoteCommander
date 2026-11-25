#!/usr/bin/env python3
import base64, json, os, sys, time, select
import gi
gi.require_version('Gio','2.0')
gi.require_version('GLib','2.0')
gi.require_version('GdkPixbuf','2.0')
from gi.repository import Gio, GLib, GdkPixbuf

DEST='org.gnome.Shell'
PATH='/org/gnome/Shell/Extensions/ChatGPTRemoteCommander'
IFACE='org.gnome.Shell.Extensions.ChatGPTRemoteCommander'
MUTTER_DEST='org.gnome.Mutter.RemoteDesktop'
MUTTER_PATH='/org/gnome/Mutter/RemoteDesktop'
MUTTER_IFACE='org.gnome.Mutter.RemoteDesktop'
MUTTER_SESSION_IFACE='org.gnome.Mutter.RemoteDesktop.Session'
TOKEN_PATH=os.path.join(os.environ.get('XDG_CONFIG_HOME',os.path.expanduser('~/.config')),'chatgpt-remote-commander','gui-extension-token')
GLOBAL_STOP=os.path.join(os.environ.get('XDG_STATE_HOME',os.path.expanduser('~/.local/state')),'chatgpt-remote-commander','GUI_STOP')
OPERATION_TIMEOUT_S=6.0

class GuiFailure(Exception):
    def __init__(self, code): super().__init__(code); self.code=code

def guierr(code): return {'ok':False,'error':code}
def fail(code): raise GuiFailure(code)
def remaining_ms(deadline, cap=2500):
    left=int((deadline-time.monotonic())*1000)
    if left <= 0: fail('GUI_OPERATION_TIMEOUT')
    return max(1,min(cap,left))
def stopped(req=None):
    if os.path.exists(GLOBAL_STOP): return True
    p=req.get('stopFile') if isinstance(req,dict) else None
    return isinstance(p,str) and p.endswith('/var/GUI_STOP') and os.path.exists(p)
def check(req, deadline):
    if stopped(req): fail('GUI_LOCAL_STOP')
    if time.monotonic() >= deadline: fail('GUI_OPERATION_TIMEOUT')

def token():
    try:
        with open(TOKEN_PATH,'r',encoding='utf-8') as f: value=f.read().strip()
        if len(value)<32: raise ValueError()
        return value
    except Exception: return None

def extension_proxy():
    return Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION,Gio.DBusProxyFlags.DO_NOT_AUTO_START,None,DEST,PATH,IFACE,None)

def invoke_extension(req, timeout_ms=6000):
    t=token()
    if not t: return guierr('GUI_EXTENSION_TOKEN_MISSING')
    q=dict(req); q['auth']=t
    try:
        p=extension_proxy()
        out=p.call_sync('Invoke',GLib.Variant('(s)',(json.dumps(q,separators=(',',':'),ensure_ascii=False),)),Gio.DBusCallFlags.NONE,timeout_ms,None)
        value=json.loads(out.unpack()[0])
        return value if isinstance(value,dict) else guierr('GUI_NATIVE_INVALID_RESPONSE')
    except Exception: return guierr('GUI_GNOME_EXTENSION_UNAVAILABLE')

def mutter_capabilities():
    try:
        bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
        props=bus.call_sync(MUTTER_DEST,MUTTER_PATH,'org.freedesktop.DBus.Properties','GetAll',GLib.Variant('(s)',(MUTTER_IFACE,)),GLib.VariantType.new('(a{sv})'),Gio.DBusCallFlags.NONE,2500,None).unpack()[0]
        types=int(props.get('SupportedDeviceTypes',0))
        return {'available':(types & 3)==3,'supportedDeviceTypes':types,'version':int(props.get('Version',0))}
    except Exception:
        return {'available':False,'supportedDeviceTypes':0,'version':0}

class MutterInput:
    def __init__(self, req, deadline):
        self.req=req; self.deadline=deadline; self.bus=None; self.path=None; self.started=False
        self.keys=[]; self.buttons=[]
        self.clipboard_signal_ids=[]; self.clipboard_owner_seen=False; self.clipboard_owner_mimes=[]
        self.clipboard_owner_generation=0; self.clipboard_session_is_owner=False
        self.clipboard_payloads={}; self.clipboard_transfer_count=0; self.clipboard_error=None; self.clipboard_enabled=False
    def _call(self, method, params=None, reply=None):
        check(self.req,self.deadline)
        try:
            return self.bus.call_sync(MUTTER_DEST,self.path,MUTTER_SESSION_IFACE,method,params,reply,Gio.DBusCallFlags.NONE,remaining_ms(self.deadline),None)
        except GuiFailure: raise
        except Exception: fail('GUI_MUTTER_REMOTE_DESKTOP_FAILED')
    def __enter__(self):
        check(self.req,self.deadline)
        try:
            self.bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
            r=self.bus.call_sync(MUTTER_DEST,MUTTER_PATH,MUTTER_IFACE,'CreateSession',None,GLib.VariantType.new('(o)'),Gio.DBusCallFlags.NONE,remaining_ms(self.deadline),None)
            self.path=r.unpack()[0]
            self._call('Start')
            self.started=True
            return self
        except GuiFailure: self.close(); raise
        except Exception: self.close(); fail('GUI_MUTTER_REMOTE_DESKTOP_UNAVAILABLE')
    def keycode(self, code, state):
        self._call('NotifyKeyboardKeycode',GLib.Variant('(ub)',(int(code),bool(state))))
        if state:
            if code not in self.keys: self.keys.append(code)
        else:
            if code in self.keys: self.keys.remove(code)
    def button(self, code, state):
        self._call('NotifyPointerButton',GLib.Variant('(ib)',(int(code),bool(state))))
        if state:
            if code not in self.buttons: self.buttons.append(code)
        else:
            if code in self.buttons: self.buttons.remove(code)
    def move(self, dx, dy):
        self._call('NotifyPointerMotionRelative',GLib.Variant('(dd)',(float(dx),float(dy))))
    def scroll(self, horizontal, steps):
        self._call('NotifyPointerAxisDiscrete',GLib.Variant('(ui)',(1 if horizontal else 0,int(steps))))
    def _clipboard_mimes(self, raw):
        while isinstance(raw,tuple) and len(raw)==1: raw=raw[0]
        if not isinstance(raw,(list,tuple)): return []
        return [str(x) for x in raw if isinstance(x,str) and 0 < len(x) <= 256]
    def _pump(self, seconds, until=None):
        end=min(self.deadline,time.monotonic()+max(0.0,float(seconds)))
        ctx=GLib.MainContext.default()
        while time.monotonic() < end:
            check(self.req,self.deadline)
            while ctx.pending(): ctx.iteration(False)
            if self.clipboard_error: fail(self.clipboard_error)
            if until is not None and until(): return True
            time.sleep(0.005)
        while ctx.pending(): ctx.iteration(False)
        if self.clipboard_error: fail(self.clipboard_error)
        return bool(until is None or until())
    def _clipboard_write_fd(self, serial, payload):
        ret,fds=self.bus.call_with_unix_fd_list_sync(MUTTER_DEST,self.path,MUTTER_SESSION_IFACE,'SelectionWrite',GLib.Variant('(u)',(int(serial),)),GLib.VariantType.new('(h)'),Gio.DBusCallFlags.NONE,remaining_ms(self.deadline),None,None)
        fd=fds.get(ret.unpack()[0]); ok=False
        try:
            os.set_blocking(fd,False); view=memoryview(payload); sent=0
            while sent < len(view):
                check(self.req,self.deadline)
                _,w,_=select.select([],[fd],[],min(0.05,max(0.001,self.deadline-time.monotonic())))
                if not w: continue
                try: n=os.write(fd,view[sent:])
                except BlockingIOError: continue
                if n <= 0: fail('GUI_CLIPBOARD_WRITE_FAILED')
                sent += n
            ok=True
        finally:
            try: os.close(fd)
            except OSError: pass
            try: self.bus.call_sync(MUTTER_DEST,self.path,MUTTER_SESSION_IFACE,'SelectionWriteDone',GLib.Variant('(ub)',(int(serial),bool(ok))),None,Gio.DBusCallFlags.NONE,min(1000,remaining_ms(self.deadline)),None)
            except Exception:
                if ok: self.clipboard_error='GUI_CLIPBOARD_WRITE_DONE_FAILED'
    def _clipboard_signal(self, _conn, _sender, _obj, _iface, signal, params, _data):
        try:
            if signal == 'SelectionOwnerChanged':
                options=params.unpack()[0]; self.clipboard_owner_seen=True; self.clipboard_owner_generation += 1
                self.clipboard_owner_mimes=self._clipboard_mimes(options.get('mime-types',[])) if isinstance(options,dict) else []
                self.clipboard_session_is_owner=bool(options.get('session-is-owner',False)) if isinstance(options,dict) else False
                return
            if signal == 'SelectionTransfer':
                mime,serial=params.unpack(); payload=self.clipboard_payloads.get(str(mime))
                if payload is None:
                    try: self.bus.call_sync(MUTTER_DEST,self.path,MUTTER_SESSION_IFACE,'SelectionWriteDone',GLib.Variant('(ub)',(int(serial),False)),None,Gio.DBusCallFlags.NONE,500,None)
                    except Exception: pass
                    return
                self._clipboard_write_fd(serial,payload); self.clipboard_transfer_count += 1
        except Exception:
            self.clipboard_error='GUI_CLIPBOARD_TRANSFER_FAILED'
    def _clipboard_subscribe(self):
        if self.clipboard_signal_ids: return
        for signal in ('SelectionOwnerChanged','SelectionTransfer'):
            self.clipboard_signal_ids.append(self.bus.signal_subscribe(MUTTER_DEST,MUTTER_SESSION_IFACE,signal,self.path,None,Gio.DBusSignalFlags.NONE,self._clipboard_signal,None))
    def _clipboard_enable(self):
        if self.clipboard_enabled: return
        self._clipboard_subscribe(); self.clipboard_owner_seen=False; self.clipboard_owner_mimes=[]
        owner_before=self.clipboard_owner_generation
        self._call('EnableClipboard',GLib.Variant('(a{sv})',({},)))
        self.clipboard_enabled=True
        if not self._pump(0.50,lambda:self.clipboard_owner_generation>owner_before): fail('GUI_CLIPBOARD_OWNER_UNAVAILABLE')
    def _clipboard_read(self, mime, total_so_far):
        try:
            ret,fds=self.bus.call_with_unix_fd_list_sync(MUTTER_DEST,self.path,MUTTER_SESSION_IFACE,'SelectionRead',GLib.Variant('(s)',(str(mime),)),GLib.VariantType.new('(h)'),Gio.DBusCallFlags.NONE,remaining_ms(self.deadline),None,None)
            fd=fds.get(ret.unpack()[0])
        except Exception: fail('GUI_CLIPBOARD_PRESERVE_FAILED')
        chunks=[]; size=0
        try:
            os.set_blocking(fd,False)
            while True:
                check(self.req,self.deadline)
                r,_,_=select.select([fd],[],[],min(0.05,max(0.001,self.deadline-time.monotonic())))
                if not r: continue
                try: part=os.read(fd,65536)
                except BlockingIOError: continue
                if not part: break
                chunks.append(part); size += len(part)
                if size > 4*1024*1024 or total_so_far+size > 4*1024*1024: fail('GUI_CLIPBOARD_PRESERVE_LIMIT')
        finally:
            try: os.close(fd)
            except OSError: pass
        return b''.join(chunks)
    def clipboard_snapshot(self):
        self._clipboard_enable(); payloads={}; total=0
        pseudo={'TARGETS','TIMESTAMP','MULTIPLE','SAVE_TARGETS'}
        for mime in self.clipboard_owner_mimes:
            if mime.upper() in pseudo: continue
            data=self._clipboard_read(mime,total); total += len(data); payloads[mime]=data
        return payloads
    def clipboard_set(self, payloads):
        if not payloads: payloads={'text/plain;charset=utf-8':b'','text/plain':b''}
        self.clipboard_payloads={str(k):bytes(v) for k,v in payloads.items()}
        owner_before=self.clipboard_owner_generation; self.clipboard_session_is_owner=False
        options={'mime-types':GLib.Variant('as',list(self.clipboard_payloads.keys()))}
        self._call('SetSelection',GLib.Variant('(a{sv})',(options,)))
        if not self._pump(0.80,lambda:self.clipboard_owner_generation>owner_before and self.clipboard_session_is_owner): fail('GUI_CLIPBOARD_OWNER_NOT_CONFIRMED')
        return self.clipboard_transfer_count
    def clipboard_wait_transfer(self, before, seconds, code):
        if not self._pump(seconds,lambda:self.clipboard_transfer_count>before): fail(code)
    def clipboard_stage(self, text):
        saved=self.clipboard_snapshot(); payload=text.encode('utf-8')
        before=self.clipboard_set({'text/plain;charset=utf-8':payload,'text/plain':payload})
        return saved,before
    def clipboard_restore(self, saved):
        self.clipboard_set(saved)
    def close(self):
        if self.bus and self.path:
            for code in list(reversed(self.buttons)):
                try: self.bus.call_sync(MUTTER_DEST,self.path,MUTTER_SESSION_IFACE,'NotifyPointerButton',GLib.Variant('(ib)',(int(code),False)),None,Gio.DBusCallFlags.NONE,500,None)
                except Exception: pass
            self.buttons.clear()
            for code in list(reversed(self.keys)):
                try: self.bus.call_sync(MUTTER_DEST,self.path,MUTTER_SESSION_IFACE,'NotifyKeyboardKeycode',GLib.Variant('(ub)',(int(code),False)),None,Gio.DBusCallFlags.NONE,500,None)
                except Exception: pass
            self.keys.clear()
            if self.started:
                try: self.bus.call_sync(MUTTER_DEST,self.path,MUTTER_SESSION_IFACE,'Stop',None,None,Gio.DBusCallFlags.NONE,1000,None)
                except Exception: pass
            for sid in self.clipboard_signal_ids:
                try: self.bus.signal_unsubscribe(sid)
                except Exception: pass
        self.clipboard_signal_ids=[]; self.clipboard_payloads={}; self.clipboard_enabled=False
        self.started=False; self.path=None; self.bus=None
    def __exit__(self, exc_type, exc, tb): self.close(); return False

def point(value, observed):
    index=value.get('screenIndex',observed.get('screenIndex'))
    if index != observed.get('screenIndex'): fail('GUI_MONITOR_NOT_OBSERVED')
    b=observed.get('bounds') or {}
    if value.get('coordinateMode','absolute')=='relative':
        x=int(b['left']+round(float(value['x'])*(int(b['width'])-1)))
        y=int(b['top']+round(float(value['y'])*(int(b['height'])-1)))
    else: x=int(value['x']); y=int(value['y'])
    if x < b['left'] or y < b['top'] or x >= b['left']+b['width'] or y >= b['top']+b['height']: fail('GUI_POINT_OUTSIDE_MONITOR')
    return x,y

def button_code(name):
    return {'left':0x110,'right':0x111,'middle':0x112}.get(name or 'left') or fail('GUI_BUTTON_INVALID')

def named_keycode(name):
    letters={'A':30,'B':48,'C':46,'D':32,'E':18,'F':33,'G':34,'H':35,'I':23,'J':36,'K':37,'L':38,'M':50,'N':49,'O':24,'P':25,'Q':16,'R':19,'S':31,'T':20,'U':22,'V':47,'W':17,'X':45,'Y':21,'Z':44}
    digits={'1':2,'2':3,'3':4,'4':5,'5':6,'6':7,'7':8,'8':9,'9':10,'0':11}
    named={'CTRL':29,'SHIFT':42,'ALT':56,'WIN':125,'ENTER':28,'TAB':15,'SPACE':57,'BACKSPACE':14,'DELETE':111,'INSERT':110,'HOME':102,'END':107,'PGUP':104,'PGDN':109,'LEFT':105,'RIGHT':106,'UP':103,'DOWN':108}
    if name in letters: return letters[name]
    if name in digits: return digits[name]
    if name in named: return named[name]
    if name.startswith('F') and name[1:].isdigit():
        n=int(name[1:])
        if 1 <= n <= 10: return 58+n
        if n == 11: return 87
        if n == 12: return 88
        if 13 <= n <= 24: return 170+n
    fail('GUI_KEYMAP_FAILED')

def guard(req, deadline):
    check(req,deadline)
    r=invoke_extension({'action':'guard','expected':req.get('expected'),'stopFile':req.get('stopFile')},remaining_ms(deadline))
    if not r.get('ok'): fail(r.get('error','GUI_FOREGROUND_OR_GEOMETRY_CHANGED'))
    return r.get('snapshot') or req.get('expected')

def cursor(req, deadline):
    r=invoke_extension({'action':'cursor','stopFile':req.get('stopFile')},remaining_ms(deadline))
    if not r.get('ok'): fail(r.get('error','GUI_CURSOR_UNAVAILABLE'))
    return int(r['x']),int(r['y'])

def move_to(req, rd, target, deadline):
    cx,cy=cursor(req,deadline); tx,ty=target
    dx,dy=tx-cx,ty-cy
    if dx or dy: rd.move(dx,dy)
    check(req,deadline)

def handle_input(req):
    deadline=time.monotonic()+OPERATION_TIMEOUT_S
    action=req.get('action')
    try:
        observed=guard(req,deadline)
    except GuiFailure as e:
        # The GNOME snapshot guard runs before MutterInput and any pointer/keyboard dispatch.
        # This receipt is limited to the exact click guard rejection, never an effectful failure.
        if action=='click' and e.code=='GUI_FOREGROUND_OR_GEOMETRY_CHANGED':
            return {'ok':False,'error':e.code,'effect':'NOT_APPLIED','phase':'PRE_DISPATCH_GUARD'}
        raise
    # Validate click coordinates before constructing a Mutter input session or
    # dispatching any pointer event. This exact error is provably NOT_APPLIED.
    if action=='click':
        try: guarded_click_point=point(req,observed)
        except GuiFailure as e:
            if e.code=='GUI_POINT_OUTSIDE_MONITOR':
                return {'ok':False,'error':e.code,'effect':'NOT_APPLIED','phase':'PRE_DISPATCH_GUARD'}
            raise
    with MutterInput(req,deadline) as rd:
        if action=='move': move_to(req,rd,point(req,observed),deadline); return {'ok':True,'backend':'mutter-remote-desktop'}
        if action=='moveRelative': rd.move(req['dx'],req['dy']); return {'ok':True,'backend':'mutter-remote-desktop'}
        if action=='scroll':
            steps=max(1,round(abs(float(req['delta']))/120)); steps=steps if float(req['delta'])>0 else -steps
            rd.scroll(bool(req.get('horizontal')),steps); return {'ok':True,'backend':'mutter-remote-desktop'}
        if action=='click':
            move_to(req,rd,guarded_click_point,deadline); code=button_code(req.get('button'))
            for i in range(int(req.get('clicks',1))):
                check(req,deadline); rd.button(code,True)
                try: rd.button(code,False)
                finally:
                    if code in rd.buttons:
                        try: rd.button(code,False)
                        except Exception: pass
                if i+1<int(req.get('clicks',1)): time.sleep(max(0.02,min(0.3,float(req.get('intervalMs',120))/1000)))
            return {'ok':True,'backend':'mutter-remote-desktop'}
        if action=='drag':
            a=point(req['from'],observed); b=point(req['to'],observed); code=button_code(req.get('button')); move_to(req,rd,a,deadline)
            rd.button(code,True)
            try:
                steps=max(2,int(req.get('steps',24))); duration=max(0.05,min(3.0,float(req.get('durationMs',500))/1000))
                last=a
                for i in range(1,steps+1):
                    check(req,deadline); t=i/steps; cur=(round(a[0]+(b[0]-a[0])*t),round(a[1]+(b[1]-a[1])*t)); rd.move(cur[0]-last[0],cur[1]-last[1]); last=cur
                    if i<steps: time.sleep(max(0.001,duration/steps))
            finally:
                if code in rd.buttons:
                    try: rd.button(code,False)
                    except Exception: pass
            return {'ok':True,'backend':'mutter-remote-desktop'}
        if action=='typeText':
            text=str(req.get('text',''))
            saved,stage_before=rd.clipboard_stage(text)
            try:
                # Physical evdev keycodes: LeftCtrl=29, V=47. Arbitrary Unicode is
                # transferred through the same Mutter RemoteDesktop clipboard session.
                rd.keycode(29,True)
                try:
                    rd.keycode(47,True)
                    rd.keycode(47,False)
                finally:
                    if 47 in rd.keys:
                        try: rd.keycode(47,False)
                        except Exception: pass
                rd.keycode(29,False)
                rd.clipboard_wait_transfer(stage_before,0.80,'GUI_CLIPBOARD_PASTE_NOT_CONFIRMED')
                check(req,deadline)
            finally:
                if 29 in rd.keys:
                    try: rd.keycode(29,False)
                    except Exception: pass
                rd.clipboard_restore(saved)
            return {'ok':True,'backend':'mutter-remote-desktop','textDelivery':'mutter-clipboard-keycode-paste'}
        if action=='keyPress':
            vals=[named_keycode(str(k)) for k in req.get('keys',[])]
            try:
                for v in vals: check(req,deadline); rd.keycode(v,True)
                hold=max(0,min(3.0,float(req.get('holdMs',0))/1000))
                if hold: time.sleep(hold)
            finally:
                for v in reversed(vals):
                    if v in rd.keys:
                        try: rd.keycode(v,False)
                        except Exception: pass
            return {'ok':True,'backend':'mutter-remote-desktop'}
    fail('GUI_UNKNOWN_ACTION')

def encode_pixbuf(pix, fmt, quality=70):
    if fmt == 'png':
        ok,data=pix.save_to_bufferv('png',[],[])
        return ok,data,'image/png',pix
    source=pix
    if pix.get_has_alpha():
        rgb=GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB,False,8,pix.get_width(),pix.get_height())
        rgb.fill(0xffffffff)
        pix.composite(rgb,0,0,pix.get_width(),pix.get_height(),0,0,1,1,GdkPixbuf.InterpType.NEAREST,255)
        source=rgb
    q=max(25,min(90,int(quality)))
    ok,data=source.save_to_bufferv('jpeg',['quality'],[str(q)])
    return ok,data,'image/jpeg',source

def jpeg_rgba_self_test():
    pix=GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB,True,8,16,16)
    pix.fill(0x4080c080)
    ok,data,mime,encoded=encode_pixbuf(pix,'jpeg',75)
    return bool(ok and mime=='image/jpeg' and not encoded.get_has_alpha() and data[:2]==b'\xff\xd8' and data[-2:]==b'\xff\xd9')

def convert_screenshot(req,result):
    path=result.get('path')
    try:
        if not isinstance(path,str) or not os.path.isfile(path): return guierr('GUI_CAPTURE_FILE_MISSING')
        pix=GdkPixbuf.Pixbuf.new_from_file(path); max_width=max(320,min(1920,int(req.get('maxWidth',1600))))
        if pix.get_width()>max_width:
            width=max_width; height=max(1,round(pix.get_height()*width/pix.get_width())); pix=pix.scale_simple(width,height,GdkPixbuf.InterpType.BILINEAR)
        fmt=req.get('format','jpeg')
        ok,data,mime,encoded=encode_pixbuf(pix,fmt,req.get('quality',70))
        if not ok: return guierr('GUI_IMAGE_ENCODE_FAILED')
        limit=max(262144,min(4194304,int(req.get('maxBytes',2097152))))
        if len(data)>limit: return guierr('GUI_IMAGE_BYTE_LIMIT')
        return {'ok':True,'data':base64.b64encode(data).decode('ascii'),'mimeType':mime,'width':encoded.get_width(),'height':encoded.get_height(),'snapshot':result.get('snapshot'),'capturedAt':result.get('capturedAt')}
    except Exception: return guierr('GUI_IMAGE_ENCODE_FAILED')
    finally:
        if isinstance(path,str):
            try: os.unlink(path)
            except OSError: pass

def handle(req):
    if not isinstance(req,dict): return guierr('GUI_REQUEST_INVALID')
    if stopped(req): return guierr('GUI_LOCAL_STOP')
    action=req.get('action')
    if action=='status':
        ext=invoke_extension(req,3000)
        if not ext.get('ok'): return {'ok':True,'available':False,'backend':'gnome-mutter-remote-desktop','reason':ext.get('error','GUI_GNOME_EXTENSION_UNAVAILABLE'),'screens':[]}
        rd=mutter_capabilities(); caps=dict(ext.get('capabilities') or {}); caps['mouse']=rd['available']; caps['keyboard']=rd['available']
        ext.update({'available':bool(ext.get('available',True) and rd['available']),'backend':'gnome-mutter-remote-desktop','inputTransport':'org.gnome.Mutter.RemoteDesktop','mutterRemoteDesktop':rd,'capabilities':caps})
        return ext
    if action in {'move','moveRelative','scroll','click','drag','typeText','keyPress'}:
        try: return handle_input(req)
        except GuiFailure as e: return guierr(e.code)
        except Exception: return guierr('GUI_MUTTER_REMOTE_DESKTOP_FAILED')
    r=invoke_extension(req,6000)
    if action=='screenshot' and r.get('ok'): return convert_screenshot(req,r)
    return r

def main():
    if '--self-test' in sys.argv:
        jpeg_ok=jpeg_rgba_self_test()
        if not jpeg_ok: return 2
        rd=mutter_capabilities(); print(json.dumps({'ok':True,'python':sys.version.split()[0],'gdkPixbuf':True,'jpegRgbaEncode':True,'contract':2,'mutterRemoteDesktop':rd,'globalStop':GLOBAL_STOP})); return 0
    if '--server' in sys.argv:
        print(json.dumps({'ok':True,'ready':True,'protocol':1}),flush=True)
        for line in sys.stdin:
            try: out=guierr('GUI_REQUEST_LIMIT') if len(line)>32768 else handle(json.loads(line))
            except Exception: out=guierr('GUI_NATIVE_FAILED')
            print(json.dumps(out,separators=(',',':'),ensure_ascii=False),flush=True)
        return 0
    raw=sys.stdin.read()
    if len(raw)>32768: out=guierr('GUI_REQUEST_LIMIT')
    else:
        try: out=handle(json.loads(raw))
        except Exception: out=guierr('GUI_NATIVE_FAILED')
    print(json.dumps(out,separators=(',',':'),ensure_ascii=False)); return 0
if __name__=='__main__': raise SystemExit(main())
