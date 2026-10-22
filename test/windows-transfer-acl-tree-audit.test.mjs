import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('../tools/security/inspect-windows-transfer-acl-tree.ps1',import.meta.url));
const run=(root,max=256,expectedOwnerSid)=>{
 const argv=['-NoProfile','-NonInteractive','-File',script,'-Root',root,'-MaxEntries',String(max)];
 if(expectedOwnerSid)argv.push('-ExpectedOwnerSid',expectedOwnerSid);
 const out=spawnSync('pwsh',argv,{encoding:'utf8',timeout:10000});
 assert.equal(out.error,undefined,String(out.error));
 assert.ok(out.stdout.trim(),out.stderr);
 return {status:out.status,report:JSON.parse(out.stdout)};
};
const configure=(directory)=>{
 const root=directory.replaceAll("'","''");
 const code=[
  "$ErrorActionPreference='Stop'",
  "$r='"+root+"'",
  '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  "icacls $r /inheritance:r | Out-Null; if($LASTEXITCODE -ne 0){throw 'INHERITANCE_FAILED'}",
  "icacls $r /grant:r ('*'+$sid+':(OI)(CI)F') | Out-Null; if($LASTEXITCODE -ne 0){throw 'GRANT_FAILED'}"
 ].join(';');
 const p=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',code],
   {encoding:'utf8',timeout:10000});
 assert.equal(p.status,0,p.stderr);
};
const grant=(file,rights)=>{
 const code="icacls '"+file.replaceAll("'","''")+"' /grant '*S-1-1-0:("+rights+")' | Out-Null; if($LASTEXITCODE -ne 0){throw 'GRANT_FAILED'}";
 const p=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',code],
   {encoding:'utf8',timeout:10000});
 assert.equal(p.status,0,p.stderr);
};
test('bounded Windows ACL tree audit finds read-only and mutating descendant grants without file reads',
 {skip:process.platform!=='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-tree-acl-'));
 try{
  configure(root);
  const inside=path.join(root,'state');fs.mkdirSync(inside);
  const sensitive=path.join(inside,'https-cert.pem');
  fs.writeFileSync(sensitive,'FAKE-CERT-NEVER-READ-BY-AUDIT','utf8');
  const before=fs.statSync(sensitive);
  const safe=run(root);
  assert.equal(safe.status,0,JSON.stringify(safe.report));
  assert.equal(safe.report.schema,'rc-windows-transfer-tree-acl-audit-v1');
  assert.equal(safe.report.status,'TREE_DACL_RESTRICTED');
  assert.equal(safe.report.inspectedEntries,3);
  assert.equal(safe.report.inspectedFiles,1);
  assert.equal(safe.report.unapprovedAllowAceCount,0);
  assert.equal(safe.report.rootOwnerIsObserver,true);
  assert.equal(safe.report.rootInheritanceProtected,true);
  grant(sensitive,'R');
  const read=run(root);
  assert.equal(read.status,2,JSON.stringify(read.report));
  assert.ok(read.report.unapprovedAllowAceCount>=1);
  assert.ok(read.report.unapprovedReadAceCount>=1);
  assert.equal(read.report.unapprovedMutationAceCount,0);
  grant(sensitive,'M');
  const write=run(root);
  assert.equal(write.status,2);
  assert.ok(write.report.unapprovedMutationAceCount>=1);
  assert.equal(write.report.inspectedEntries,3);
  assert.equal(fs.readFileSync(sensitive,'utf8'),'FAKE-CERT-NEVER-READ-BY-AUDIT');
  assert.equal(fs.statSync(sensitive).mtimeMs,before.mtimeMs);
  const limit=run(root,2);
  assert.equal(limit.status,3);
  assert.equal(limit.report.truncated,true);
  assert.equal(run('\\\\invalid-host\\untrusted\\state').status,3);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('redirected ancestor is rejected before its target is enumerated',
 {skip:process.platform!=='win32'},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-acl-redirect-'));
 try {
  const external=path.join(root,'external');
  const inner=path.join(external,'inner');
  fs.mkdirSync(inner,{recursive:true});
  fs.writeFileSync(path.join(inner,'unread.txt'),'NEVER_READ', 'utf8');
  const alias=path.join(root,'redirected');
  try{fs.symlinkSync(external,alias,'junction');}
  catch(e){
   if(['EPERM','EACCES','ENOTSUP','EOPNOTSUPP'].includes(e.code)){
    t.skip('Junction creation unavailable in this Windows test context');return;
   }
   throw e;
  }
  const report=run(path.join(alias,'inner'));
  assert.equal(report.status,2,JSON.stringify(report.report));
  assert.equal(report.report.status,'REVIEW_REQUIRED');
  assert.ok(report.report.reparseEntryCount>=1);
  assert.equal(report.report.inspectedEntries,0);
  assert.equal(fs.readFileSync(path.join(inner,'unread.txt'),'utf8'),'NEVER_READ');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('bounded audit uses a pinned owner SID rather than its SYSTEM observer identity',
 {skip:process.platform!=='win32'},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-acl-pinned-owner-'));
 try{
  configure(root);
  const ownerSid='S-1-5-32-544'; // synthetic Administrators owner, not SYSTEM
  const ps=[
   "$ErrorActionPreference='Stop'",
   "$r='"+root.replaceAll("'","''")+"'",
   '$a=Get-Acl -LiteralPath $r',
   "$a.SetOwner([Security.Principal.SecurityIdentifier]::new('"+ownerSid+"'))",
   'Set-Acl -LiteralPath $r -AclObject $a'
  ].join(';');
  const changed=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',ps],
   {encoding:'utf8',timeout:10000});
  if(changed.status!==0){t.skip('Synthetic owner change unavailable');return;}
  const defaultAudit=run(root);
  assert.equal(defaultAudit.status,2,JSON.stringify(defaultAudit.report));
  assert.equal(defaultAudit.report.rootOwnerIsObserver,false);
  assert.equal(defaultAudit.report.rootOwnerIsExpected,false);
  const verified=run(root,256,ownerSid);
  assert.equal(verified.status,0,JSON.stringify(verified.report));
  assert.equal(verified.report.rootOwnerIsExpected,true);
  assert.equal(verified.report.rootOwnerIsObserver,false);
  assert.equal(run(root,256,'S-1-5-19').status,2);
  grant(root,'R');
  const read=run(root,256,ownerSid);
  assert.equal(read.status,2,JSON.stringify(read.report));
  assert.ok(read.report.unapprovedReadAceCount>0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
