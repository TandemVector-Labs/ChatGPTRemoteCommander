import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const script=path.resolve(here,'../packaging/unified/owner-dpapi-profile-recovery.ps1');
const pwsh=process.platform==='win32'?'C:\\Program Files\\PowerShell\\7\\pwsh.exe':'pwsh';
function execute(appData,mode,profileName=null){
 const args=['-NoLogo','-NoProfile','-NonInteractive',
   '-File',script,'-Mode',mode];
 if(profileName!==null)args.push('-ProfileName',profileName);
 const result=spawnSync(pwsh,args,{
   encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:8192,
   env:{...process.env,APPDATA:appData}
 });
 if(result.error)throw result.error;
 return result;
}
test('Windows owner DPAPI recovery capsule stages and verifies only encrypted owner-local fixtures, detects mutations',{
  skip:process.platform!=='win32',timeout:30000
},()=>{
 const owner=fs.mkdtempSync(path.join(os.tmpdir(),'rc012-dpapi-qa-'));
 const profile=path.join(owner,'tunnel-client','chatgpt-remote-commander.yaml');
 const certDir=path.join(owner,'ChatGPTRemoteCommander','private-pair','default');
 const recovery=path.join(owner,'ChatGPTRemoteCommander','owner-recovery','rc012-native-pair-dpapi');
 const privateMarker='NONPRODUCTION_PLAINTEXT_FIXTURE_BEARER_ABC123';
 try{
   fs.mkdirSync(path.dirname(profile),{recursive:true});
   fs.mkdirSync(certDir,{recursive:true});
   fs.writeFileSync(profile,
    'config_version: 1\ncontrol_plane:\n  api_key: '+privateMarker+'\n');
   for(const f of ['ca.crt','client.crt','client.key','server.crt','server.key'])
     fs.writeFileSync(path.join(certDir,f),'NONPRODUCTION_CERT_FIXTURE_'+f+'\n');
   const source=fs.readFileSync(profile);
   const stage=execute(owner,'Stage');
   assert.equal(stage.status,0,stage.stderr?.slice(-900));
   assert.match(stage.stdout,/RC012_WINDOWS_OWNER_DPAPI_BACKUP_STAGE_PASS files=6/);
   assert.ok(!stage.stdout.includes(privateMarker));
   const sealed=fs.readFileSync(path.join(recovery,'owner-capsule.dpapi'));
   assert.ok(!sealed.includes(Buffer.from(privateMarker)));
   const receipt=fs.readFileSync(path.join(recovery,'receipt.json'),'utf8');
   assert.ok(!receipt.includes(privateMarker));
   const verified=execute(owner,'Verify');
   assert.equal(verified.status,0,verified.stderr?.slice(-900));
   assert.match(verified.stdout,/RC012_WINDOWS_OWNER_DPAPI_BACKUP_VERIFY_PASS files=6/);
   const simulated=execute(owner,'TestRestore');
   assert.equal(simulated.status,0,simulated.stderr?.slice(-900));
   assert.match(simulated.stdout,/RC012_WINDOWS_OWNER_DPAPI_RESTORE_SIMULATION_PASS files=6/);
   assert.equal(fs.readdirSync(path.dirname(recovery)).filter(x=>x.startsWith('.restore-test-')).length,0);
   assert.deepEqual(fs.readFileSync(profile),source);
   const again=execute(owner,'Stage');
   assert.equal(again.status,0);
   assert.match(again.stdout,/RC012_WINDOWS_OWNER_DPAPI_BACKUP_REUSED/);
   assert.deepEqual(fs.readFileSync(profile),source);
   fs.writeFileSync(profile,source.toString()+'# changed baseline\n');
   const changed=execute(owner,'Stage');
   assert.notEqual(changed.status,0);
   assert.match(changed.stderr,/RC012_DPAPI_EXISTING_BASELINE_CHANGED/);
   fs.writeFileSync(profile,source);
   const blob=path.join(recovery,'owner-capsule.dpapi');
   const tampered=fs.readFileSync(blob);
   tampered[0]^=0x01;
   fs.writeFileSync(blob,tampered);
   const rejected=execute(owner,'Verify');
   assert.notEqual(rejected.status,0);
   assert.match(rejected.stderr,/RC012_DPAPI_RECEIPT_INVALID/);
   // A previous capsule directory with an extra explicit group Allow ACE
   // must NEVER be "fixed" silently. Native owner re-enrollment is required.
   // This is a disposable QA fixture, not the installed owner's backup.
   const extraAce=spawnSync('icacls.exe',[
     recovery,'/grant','*S-1-5-32-545:(OI)(CI)RX'
   ],{encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:4096});
   assert.equal(extraAce.status,0,extraAce.stderr?.slice(-400));
   const broad=execute(owner,'Verify');
   assert.notEqual(broad.status,0);
   assert.match(broad.stderr,/RC012_DPAPI_BACKUP_EXTRA_ACL/);
   const repeatBroad=execute(owner,'Stage');
   assert.notEqual(repeatBroad.status,0);
   assert.match(repeatBroad.stderr,/RC012_DPAPI_BACKUP_EXTRA_ACL/);
 }finally{
   fs.rmSync(owner,{recursive:true,force:true});
 }
});


test('Windows DPAPI capsules isolate each explicit owner profile and reject cross-profile restores',{
 skip:process.platform!=='win32',timeout:60000
},()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'rc012-dpapi-multipair-'));
 const names=['chatgpt-remote-commander','MMZ'];
 const profileDir=path.join(home,'tunnel-client');
 const base=path.join(home,'ChatGPTRemoteCommander');
 const pairRoot=path.join(base,'private-pair');
 const recovery=path.join(base,'owner-recovery');
 const fileNames=['ca.crt','client.crt','client.key','server.crt','server.key'];
 const capsule=n=>path.join(recovery,'rc012-native-pair-dpapi-'+n);
 try{
   fs.mkdirSync(profileDir,{recursive:true});
   fs.mkdirSync(path.join(pairRoot,'default'),{recursive:true});
   fs.mkdirSync(path.join(pairRoot,'MMZ'),{recursive:true});
   for(const name of names){
     const certName=name==='chatgpt-remote-commander'?'default':name;
     fs.writeFileSync(path.join(profileDir,name+'.yaml'),
       'config_version: 1\ncontrol_plane:\n  api_key: NONPRODUCTION_OWNER_'+name+'\n');
     for(const file of fileNames)
       fs.writeFileSync(path.join(pairRoot,certName,file),
         'SYNTHETIC_OWNER_'+name+'_'+file+'\n');
   }
   for(const invalid of ['', '../wrong','..','bad/name','a'.repeat(65)]){
     const x=execute(home,'Stage',invalid);
     assert.notEqual(x.status,0,invalid);
     assert.match(x.stderr,/RC012_DPAPI_OWNER_PROFILE_INVALID/);
   }
   const a=execute(home,'Stage',names[0]);
   assert.equal(a.status,0,a.stderr);
   const missing=execute(home,'Verify',names[1]);
   assert.notEqual(missing.status,0,'profile B must not inherit profile A backup');
   const b=execute(home,'Stage',names[1]);
   assert.equal(b.status,0,b.stderr);
   for(const name of names){
     assert.equal(execute(home,'Verify',name).status,0);
     const restored=execute(home,'TestRestore',name);
     assert.equal(restored.status,0,restored.stderr);
     assert.match(restored.stdout,/RESTORE_SIMULATION_PASS files=6/);
     assert.match(execute(home,'Stage',name).stdout,/BACKUP_REUSED files=6/);
   }
   assert.equal(fs.existsSync(path.join(recovery,'rc012-native-pair-dpapi')),false,
     'explicit profile scopes must not create or mutate the legacy capsule');
   // Prove exact backward compatibility with a legacy schema-1 capsule
   // lacking profileName metadata. Re-encryption uses only disposable test
   // fixtures and the same Windows CurrentUser DPAPI account.
   const legacyPs=String.raw`
$ErrorActionPreference='Stop'
$d=$env:RC012_QA_LEGACY_DIR
$c=Join-Path $d 'owner-capsule.dpapi'
$r=Join-Path $d 'receipt.json'
$bytes=[IO.File]::ReadAllBytes($c)
$plain=[Security.Cryptography.ProtectedData]::Unprotect(
  $bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
$doc=[Text.Encoding]::UTF8.GetString($plain)|ConvertFrom-Json
[void]$doc.PSObject.Properties.Remove('profileName')
$newPlain=[Text.Encoding]::UTF8.GetBytes(($doc|ConvertTo-Json -Depth 7 -Compress))
$newCipher=[Security.Cryptography.ProtectedData]::Protect(
  $newPlain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes($c,$newCipher)
$meta=Get-Content -LiteralPath $r -Raw | ConvertFrom-Json
[void]$meta.PSObject.Properties.Remove('profileName')
$meta.cipherSha256=[Convert]::ToHexString(
  [Security.Cryptography.SHA256]::HashData($newCipher)).ToLowerInvariant()
[IO.File]::WriteAllText($r,($meta|ConvertTo-Json -Compress),
  [Text.UTF8Encoding]::new($false))
`;
   // Execute synthetic DPAPI compatibility script from test-owned local file,
   // not by passing source in the PowerShell command argument.
   const legacyFile=path.join(home,'rc012-legacy-capsule-qa.ps1');
   fs.writeFileSync(legacyFile,legacyPs,{flag:'wx',mode:0o600});
   const makeLegacy=spawnSync(pwsh,['-NoProfile','-NonInteractive',
     '-File',legacyFile],{encoding:'utf8',windowsHide:true,timeout:10000,
       env:{...process.env,RC012_QA_LEGACY_DIR:capsule(names[1])}});
   assert.equal(makeLegacy.status,0,makeLegacy.stderr);
   assert.equal(execute(home,'Verify',names[1]).status,0,
     'legacy scoped archive must verify by exact owner, files and hashes');
   assert.equal(execute(home,'TestRestore',names[1]).status,0);
   assert.match(execute(home,'Stage',names[1]).stdout,/BACKUP_REUSED files=6/);
   const payloadName='owner-capsule.dpapi',receiptName='receipt.json';
   const originalPayload=fs.readFileSync(path.join(capsule(names[1]),payloadName));
   const originalReceipt=fs.readFileSync(path.join(capsule(names[1]),receiptName));
   try{
     fs.copyFileSync(path.join(capsule(names[0]),payloadName),path.join(capsule(names[1]),payloadName));
     fs.copyFileSync(path.join(capsule(names[0]),receiptName),path.join(capsule(names[1]),receiptName));
     const crossed=execute(home,'Verify',names[1]);
     assert.notEqual(crossed.status,0);
     assert.match(crossed.stderr,/RC012_DPAPI_PROFILE_BINDING_INVALID/);
   }finally{
     fs.writeFileSync(path.join(capsule(names[1]),payloadName),originalPayload);
     fs.writeFileSync(path.join(capsule(names[1]),receiptName),originalReceipt);
   }
   assert.equal(execute(home,'Verify',names[1]).status,0);
   for(const name of names)
     assert.match(fs.readFileSync(path.join(profileDir,name+'.yaml'),'utf8'),
       /NONPRODUCTION_OWNER_/);
 }finally{fs.rmSync(home,{force:true,recursive:true});}
});
