import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const source=fileURLToPath(new URL('../tools/kde_workspace_observer.py',import.meta.url));
test('KDE owner snapshot accepts empty foreground as observation, never a GUI target',()=>{
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
 const r=spawnSync('/usr/bin/python3',['-c',py],{encoding:'utf8',timeout:5000});
 assert.equal(r.status,0,r.stderr||r.stdout);
 assert.match(r.stdout,/BOUNDARY_PRESERVED/);
});
