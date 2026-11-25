import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const script=readFileSync(join(import.meta.dirname,'..','tools','windows-owner-workspace-worker.ps1'),'utf8');
test('owner worker requires same interactive user and exact pinned binary',()=>{
  assert.match(script,/\$identity\.IsSystem\s+-or\s+\$proc\.SessionId\s+-le\s+0/);
  assert.match(script,/\[Parameter\(Mandatory=\$true\)\]\[ValidatePattern\('\^\[a-fA-F0-9\]\{64\}\$'\)\]\[string\]\$DriverSha256/);
  assert.match(script,/Get-FileHash\s+-LiteralPath\s+\$driver\s+-Algorithm\s+SHA256/);
  assert.match(script,/OWNER_WORKSPACE_DRIVER_HASH_MISMATCH/);
});
test('worker exposes only read-only probe and window inventory',()=>{
  assert.match(script,/ValidateSet\('Probe','ListWindows'\)/);
  assert.match(script,/call --socket \$socket list_windows '\{\}'/);
  assert.match(script,/OWNER_WINDOWS_ENUMERATED/);
  for(const action of ['gui_mouse_click','gui_type_text','SendKeys','Invoke-Expression','Set-Acl'])assert.ok(!script.includes(action),action);
});
test('receipts are request-bound and redact window titles and browser sessions',()=>{
  assert.match(script,/OWNER_WORKSPACE_REQUEST_ALREADY_PROCESSED/);
  assert.match(script,/owner-workspace\\receipts/);
  assert.match(script,/window_id/);
  assert.doesNotMatch(script,/\$_\.title|\$_\.cookie|\$_\.profile/);
});

test('same-request receipt is atomic create-only with durable flush, never replaceable',()=>{
 assert.match(script,/\[IO\.File\]::Open\(\$receipt,\[IO\.FileMode\]::CreateNew,\[IO\.FileAccess\]::Write,\[IO\.FileShare\]::None\)/);
 assert.match(script,/\$file\.Flush\(\$true\)/);
 assert.match(script,/finally\s*\{\s*\$file\.Dispose\(\)/);
 assert.doesNotMatch(script,/Set-Content\s+-LiteralPath\s+\$receipt/);
 assert.doesNotMatch(script,/\[IO\.FileMode\]::(?:Create|OpenOrCreate|Truncate)\b/);
});
