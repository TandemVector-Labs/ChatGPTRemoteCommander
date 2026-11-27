import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const source=fileURLToPath(new URL('../tools/kde_workspace_observer.py',import.meta.url));
test('KDE owner snapshot accepts empty foreground as observation, never a GUI target', {skip:process.platform!=='linux'},()=>{
 const py=[
 'import importlib.util',
 's=importlib.util.spec_from_file_location("kde_metadata",'+JSON.stringify(source)+')',
 'm=importlib.util.module_from_spec(s);s.loader.exec_module(m)',
 'base={"screens":[{"left":0,"top":0,"width":1920,"height":1080},{"left":1920,"top":0,"width":1920,"height":1080}],"cursor":{"x":1,"y":1},"windowBounds":None,"clientBounds":None,"foreground":"","processId":0}',
 'assert m.validate_metadata(base)["activeWindowPresent"] is False',
 'good={**base,"windowBounds":base["screens"][0],"clientBounds":base["screens"][0],"foreground":"12345678-1234-1234-1234-123456789abc","processId":77}',
 'assert m.validate_metadata(good)["activeWindowPresent"] is True',
 'for invalid in [{**base,"processId":7},{**base,"windowBounds":base["screens"][0]},{**good,"foreground":""},{**base,"screens":[{"left":0,"top":0,"width":0,"height":100}]}]:',
 '  try:m.validate_metadata(invalid);raise AssertionError("BAD_STATE_ACCEPTED")',
 '  except m.MetadataError:pass',
 'print("KDE_IDLE_OBSERVE_VALID_AND_MUTATION_BOUNDARY_PRESERVED")'
 ].join('\n');
 const r=spawnSync('/usr/bin/python3',['-I','-B','-c',py],{encoding:'utf8',timeout:5000});
 assert.equal(r.status,0,r.stderr||r.stdout);
 assert.match(r.stdout,/BOUNDARY_PRESERVED/);
});

test('KDE metadata rejects non-finite cursor and non-integer idle PID', {
 skip:process.platform!=='linux'
},()=>{
 const py=[
 'import importlib.util,sys',
 's=importlib.util.spec_from_file_location("kde_metadata",sys.argv[1])',
 'm=importlib.util.module_from_spec(s);s.loader.exec_module(m)',
 'base={"screens":[{"left":-1920,"top":0,"width":1920,"height":1080}],"cursor":{"x":-1.5,"y":0.25},"windowBounds":None,"clientBounds":None,"foreground":"","processId":0}',
 'assert m.validate_metadata(base)["activeWindowPresent"] is False',
 'active={**base,"windowBounds":base["screens"][0],"clientBounds":base["screens"][0],"foreground":"12345678-1234-1234-1234-123456789abc","processId":77}',
 'assert m.validate_metadata(active)["activeWindowPresent"] is True',
 'accepted=[]',
 'for name,invalid,code in [(str(v)+":"+axis+":"+kind,{**state,"cursor":{**state["cursor"],axis:v}},"KDE_CURSOR_INVALID") for v in (float("nan"),float("inf"),float("-inf")) for axis in ("x","y") for kind,state in (("idle",base),("active",active))]+[(repr(v),{**base,"processId":v},"KDE_FOREGROUND_PID_INVALID") for v in (False,0.0)]:',
 ' try:m.validate_metadata(invalid);accepted.append(name)',
 ' except m.MetadataError as e:assert str(e)==code,(name,str(e))',
 'assert not accepted, "INVALID_METADATA_ACCEPTED:"+",".join(accepted)',
 'print("KDE_FINITE_CURSOR_AND_EXACT_IDLE_PID_PASS")'
 ].join('\n');
 const r=spawnSync('/usr/bin/python3',['-I','-B','-c',py,source],{encoding:'utf8',timeout:5000});
 assert.equal(r.status,0,r.error?.message||r.stderr||r.stdout);
 assert.match(r.stdout,/FINITE_CURSOR_AND_EXACT_IDLE_PID_PASS/);
});
