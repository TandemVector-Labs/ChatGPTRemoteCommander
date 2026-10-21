import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../tools/security/inspect-windows-transfer-acl.ps1',import.meta.url));
const run=root=>{
 const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-File',script,'-Root',root],
   {encoding:'utf8',timeout:10000});
 assert.equal(result.error,undefined,String(result.error));
 assert.ok(result.stdout.trim(),result.stderr);
 return {exit:result.status,body:JSON.parse(result.stdout)};
};
const configure=(root,addEveryone=false)=>{
 const literal=root.replaceAll("'","''");
 const ps=[
  "$ErrorActionPreference='Stop'",
  "$root='"+literal+"'",
  "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "icacls $root /grant:r ('*'+$sid+':(OI)(CI)F') | Out-Null",
  "if($LASTEXITCODE -ne 0){throw 'GRANT_FAILED'}",
  "icacls $root /inheritance:r | Out-Null",
  "if($LASTEXITCODE -ne 0){throw 'INHERITANCE_FAILED'}",
  addEveryone?"icacls $root /grant '*S-1-1-0:(OI)(CI)RX' | Out-Null; if($LASTEXITCODE -ne 0){throw 'EVERYONE_GRANT_FAILED'}":"",
 ].join(';');
 const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',ps],
   {encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);
};test('Windows transfer root ACL audit is fail-closed, scoped, and read-only',
 {skip:process.platform!=='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-acl-test-'));
 try{
  configure(root,false);
  const before=fs.statSync(root).mtimeMs;
  const clean=run(root);
  assert.equal(clean.exit,0);
  assert.equal(clean.body.schema,'rc-windows-transfer-root-acl-audit-v1');
  assert.equal(clean.body.status,'ROOT_DACL_RESTRICTED');
  assert.equal(clean.body.unapprovedAllowAceCount,0);
  assert.equal(clean.body.ownerIsCaller,true);
  assert.equal(clean.body.inheritanceProtected,true);
  assert.equal(fs.statSync(root).mtimeMs,before);
  configure(root,true);
  const exposed=run(root);
  assert.equal(exposed.exit,2);
  assert.equal(exposed.body.status,'REVIEW_REQUIRED');
  assert.ok(exposed.body.unapprovedAllowAceCount>=1);
  assert.equal(exposed.body.examined,'ROOT_DACL_ONLY');
  assert.equal(run(path.join(root,'missing')).exit,3);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});