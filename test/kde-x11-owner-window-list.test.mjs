import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const source=fileURLToPath(new URL('../tools/kde_portal_runtime.py',import.meta.url));
test('native KDE X11 owner list observes exact window safely and excludes cross-user PID', {
 skip:process.platform!=='linux'
},()=>{
 // The source is from this checkout, never from a developer's HOME.
 const py=[
   "import importlib.util,os,stat,sys,types",
   "from pathlib import Path",
   "p=Path(sys.argv[1]).resolve(strict=True)",
   "sys.path.insert(0,str(p.parent))",
   "sp=importlib.util.spec_from_file_location(\"rc_kde_portal\",p)",
   "m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)",
   "assert Path(m.__file__).resolve()==p",
   "uid=os.getuid()",
   "calls=[]",
   "def statter(p):",
   "    return types.SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_uid=uid if not p.endswith(\"/99\") else uid+1)",
   "def run(args,**kw):",
   "    calls.append(tuple(args))",
   "    if args==[\"/usr/bin/systemctl\",\"--user\",\"show-environment\"]:",
   "        return types.SimpleNamespace(returncode=0,stdout=\"DISPLAY=:0\\nXAUTHORITY=/tmp/testowner\\n\")",
   "    if args==[\"/usr/bin/xprop\",\"-root\",\"_NET_CLIENT_LIST\",\"_NET_ACTIVE_WINDOW\"]:",
   "        return types.SimpleNamespace(returncode=0,stdout=\"_NET_CLIENT_LIST(WINDOW): window id # 0x4e00017, 0x4e00018\\n_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0\\n\")",
   "    assert args[:2]==[\"/usr/bin/xprop\",\"-id\"] and args[3:]==[\"_NET_WM_PID\",\"WM_CLASS\",\"_NET_WM_NAME\"]",
   "    pid=\"6061\" if args[2]==\"0x4e00017\" else \"99\"",
   "    val='_NET_WM_PID(CARDINAL) = '+pid+'\\nWM_CLASS(STRING) = \"Navigator\", \"firefox_firefox\"\\n_NET_WM_NAME(UTF8_STRING) = \"A test tab - Mozilla Firefox\"\\n'",
   "    return types.SimpleNamespace(returncode=0,stdout=val)",
   "rows=m.x11_owner_windows({\"XDG_SESSION_TYPE\":\"x11\"},run,statter)",
   "assert len(rows)==1 and rows[0][\"processId\"]==6061 and rows[0][\"handle\"]==str(int(\"0x4e00017\",16))",
   "assert rows[0][\"focused\"] is False and rows[0][\"wmClass\"]==\"firefox_firefox\"",
   "assert len(calls)==4",
   "before=list(calls)",
   "assert m.x11_owner_windows({\"XDG_SESSION_TYPE\":\"wayland\"},run,statter)==[]",
   "assert m.x11_owner_windows({\"XDG_SESSION_TYPE\":\"x11\",\"DISPLAY\":\"invalid\",\"XAUTHORITY\":\"/tmp/testowner\"},run,statter)==[]",
   "assert m.x11_owner_windows({\"XDG_SESSION_TYPE\":\"x11\",\"DISPLAY\":\":0\",\"XAUTHORITY\":\"relative\"},run,statter)==[]",
   "assert calls==before",
   "print(\"KDE_X11_OWNER_SCOPED_NO_FOCUS_OR_INPUT_PASS\")"
 ].join('\n');
 const r=spawnSync('/usr/bin/python3',['-I','-B','-c',py,source],{
   encoding:'utf8',timeout:5000
 });
 assert.equal(r.status,0,r.error?.message||r.stderr||r.stdout);
 assert.match(r.stdout,/SCOPED_NO_FOCUS_OR_INPUT_PASS/);
});
