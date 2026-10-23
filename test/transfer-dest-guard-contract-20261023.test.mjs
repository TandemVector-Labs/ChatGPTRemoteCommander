import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('portable Win32 native directory guard exactly matches reviewed source',()=>{
 const pilot=fs.readFileSync(path.join(root,'tools/commander-transfer-mesh/pilot-cli.mjs'),'utf8');
 const guard=fs.readFileSync(path.join(root,'tools/commander-transfer-mesh/win-dest-pin.ps1'),'utf8');
 const m=pilot.match(/const WIN_DEST_PIN_SCRIPT_B64='([A-Za-z0-9+/=]+)';/);
 assert.ok(m,'embedded portable native guard present');
 // Git checkout may use platform-native CRLF while committed portable source uses LF.
 const normalized=s=>s.replace(/\r\n/g,'\n');
 assert.equal(normalized(Buffer.from(m[1],'base64').toString('utf16le')),normalized(guard),
  'portable PowerShell guard must match reviewed source after canonical EOL normalization');
 assert.match(guard,/GetFileInformationByHandleEx/);
 assert.match(guard,/NtCreateFile/);
 assert.match(guard,/RootDirectory=parent\.DangerousGetHandle\(\)/);
 assert.match(guard,/0x200021/);
 assert.match(guard,/0x02200000/);
 assert.match(guard,/NtCreateFile\(out SafeFileHandle h,0x1000A0/);
});
