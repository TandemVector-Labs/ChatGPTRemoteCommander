import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('native KDE X11 owner list observes exact window safely and excludes cross-user PID',()=>{
 const py=[
 'import importlib.util,os,stat,types',
 'from pathlib import Path',
 'p=Path.home()/"source/repos/.rc-brave-uia-qa-20261031/tools/kde_portal_runtime.py"',
 'import sys;sys.path.insert(0,str(p.parent))',
 'sp=importlib.util.spec_from_file_location("rc_kde_portal",p)',
 'm=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)',
 'uid=os.getuid()',
 'def statter(p):return types.SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_uid=uid if not p.endswith("/99") else uid+1)',
 'def run(args,**kw):',
 '  if "show-environment" in args:return types.SimpleNamespace(returncode=0,stdout="DISPLAY=:0\\nXAUTHORITY=/tmp/testowner\\n")',
 '  if "-root" in args:return types.SimpleNamespace(returncode=0,stdout="_NET_CLIENT_LIST(WINDOW): window id # 0x4e00017, 0x4e00018\\n_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0\\n")',
 '  pid="6061" if "0x4e00017" in args else "99"',
 '  val="_NET_WM_PID(CARDINAL) = "+pid+"\\nWM_CLASS(STRING) = \\"Navigator\\", \\"firefox_firefox\\"\\n_NET_WM_NAME(UTF8_STRING) = \\"A test tab - Mozilla Firefox\\"\\n"',
 '  return types.SimpleNamespace(returncode=0,stdout=val)',
 'env={"XDG_SESSION_TYPE":"x11"}',
 'rows=m.x11_owner_windows(env,run,statter)',
 'assert len(rows)==1 and rows[0]["processId"]==6061 and rows[0]["handle"]==str(int("0x4e00017",16))',
 'assert rows[0]["focused"] is False and rows[0]["wmClass"]=="firefox_firefox"',
 'assert m.x11_owner_windows({"XDG_SESSION_TYPE":"wayland"},run,statter)==[]',
 'print("KDE_X11_OWNER_SCOPED_NO_FOCUS_OR_INPUT_PASS")'
 ].join('\n');
 const r=spawnSync('/usr/bin/python3',['-c',py],{encoding:'utf8',timeout:5000});
 assert.equal(r.status,0,r.stderr||r.stdout);
 assert.match(r.stdout,/SCOPED_NO_FOCUS_OR_INPUT_PASS/);
});
