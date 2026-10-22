import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const source=fs.readFileSync(path.join(root,'auto-update-windows.ps1'),'utf8');
const ownerStart=source.indexOf('$InstallDir=[IO.Path]::GetFullPath($InstallDir)');
const ownerEnd=source.indexOf("$ReleaseRoot=Join-Path $StateRoot 'releases'",ownerStart);
const lockStart=source.indexOf('# A session-local mutex does not coordinate SYSTEM/session-0');
const lockEnd=source.indexOf('$candidates=@();',lockStart);
const finallyStart=source.lastIndexOf('}finally{');
const ownerSnippet=source.slice(ownerStart,ownerEnd);
const lockSnippet=source.slice(lockStart,lockEnd);

function isolated(label,fn){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),label));
 try{return fn(temp)} finally{fs.rmSync(temp,{recursive:true,force:true})}
}
function psQuote(s){return "'"+s.replaceAll("'","''")+"'";}
function runFile(file,args,timeout=10000){
 return spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',file,...args],
  {encoding:'utf8',timeout,windowsHide:true,shell:false});
}

test('updater rejects foreign StateRoot before staging and keeps the owner pause gate',()=>{
 assert.ok(ownerStart>=0&&ownerEnd>ownerStart);
 assert.ok(ownerSnippet.includes('AUTO_UPDATE_OWNER_STATE_ROOT_MISMATCH'));
 assert.ok(ownerSnippet.includes('AUTO_UPDATE_WRONG_ACCOUNT_SESSION'));
 assert.ok(ownerSnippet.includes('AUTO_UPDATE_OWNER_PROFILE_UNVERIFIED'));
 assert.ok(ownerSnippet.includes('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'));

 assert.ok(source.indexOf('if(-not $Force -and (Test-Path -LiteralPath $PauseFile')<ownerStart);
 assert.ok(ownerEnd<source.indexOf('New-Item -ItemType Directory -Force -Path $ReleaseRoot'));
 assert.ok(source.indexOf("if($SelfTest){")<lockStart,'selftest remains non-mutating');
 assert.ok(lockStart>0&&lockEnd>lockStart);
 assert.ok(lockSnippet.includes('[IO.FileShare]::None'),'Windows kernel must enforce cross-session exclusion');
 assert.ok(lockSnippet.includes("if(([IO.File]::GetAttributes($updateLockPath) -band [IO.FileAttributes]::ReparsePoint)"));
 assert.ok(source.slice(finallyStart).includes('$updateLockStream.Dispose()'),'release exactly on termination');
 assert.ok(!source.includes("'Local\\ChatGPTRemoteCommanderAutoUpdater'"),'session-local marker was removed');
});

test('Windows owner and foreign runtime scope cannot share owner installation', {skip:process.platform!=='win32'},()=>{
 isolated('rc-owner-scope-',dir=>{
   const ownerRoot=path.join(dir,'owner','ChatGPTRemoteCommander');
   const foreignRoot=path.join(dir,'foreign','ChatGPTRemoteCommander');
   const app=path.join(ownerRoot,'app');
   fs.mkdirSync(app,{recursive:true}); fs.mkdirSync(foreignRoot,{recursive:true});
   const fixture=path.join(dir,'owner-guard.ps1');
   const staticCode=[
      "$ErrorActionPreference='Stop'",
      '$StateRoot=$args[0]',
      '$InstallDir=$args[1]',
      ownerSnippet,
      "Write-Output 'SCOPE_ACCEPTED'"
   ].join('\n');
   fs.writeFileSync(fixture,staticCode,{mode:0o600});
   const good=runFile(fixture,[ownerRoot,app]);
   assert.equal(good.status,0,good.stderr);
   assert.match(good.stdout,/SCOPE_ACCEPTED/);
   const bad=runFile(fixture,[foreignRoot,app]);
   assert.equal(bad.status,0,bad.stderr);
   assert.match(bad.stdout,/AUTO_UPDATE_OWNER_STATE_ROOT_MISMATCH/);
   assert.doesNotMatch(bad.stdout,/SCOPE_ACCEPTED/);
 });
});

test('Windows registry owner SID, not inherited LOCALAPPDATA, controls user-profile updater scope',
  {skip:process.platform!=='win32'},()=>{
  isolated('rc-profile-sid-',dir=>{
    const fixture=path.join(dir,'sid-guard.ps1');
    fs.writeFileSync(fixture,[
      "$ErrorActionPreference='Stop'",
      '$currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
      " $entries=Get-ChildItem 'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList' | ForEach-Object {",
      "  $p=Get-ItemProperty -LiteralPath $_.PSPath -Name ProfileImagePath -ErrorAction SilentlyContinue",
      "  if($p){[pscustomobject]@{sid=$_.PSChildName;profile=[Environment]::ExpandEnvironmentVariables([string]$p.ProfileImagePath)}}",
      ' }',
      " $target=if($args[0] -eq 'own'){@($entries|Where-Object sid -eq $currentSid|Select-Object -First 1)}else{@($entries|Where-Object sid -ne $currentSid|Select-Object -First 1)}",
      " if(-not $target){Write-Output 'SKIP_NO_PROFILE_REGISTRY_ENTRY';exit 0}",
      " $StateRoot=Join-Path $target[0].profile 'AppData\\Local\\ChatGPTRemoteCommander'",
      " $InstallDir=Join-Path $StateRoot 'app'",
      ownerSnippet,
      " Write-Output 'SCOPE_ACCEPTED'"
    ].join('\n'),{mode:0o600});
    const own=runFile(fixture,['own']); assert.equal(own.status,0,own.stderr);
    assert.doesNotMatch(own.stdout,/AUTO_UPDATE_WRONG_ACCOUNT_SESSION/);
    assert.match(own.stdout,/SCOPE_ACCEPTED/);
    const foreign=runFile(fixture,['foreign']); assert.equal(foreign.status,0,foreign.stderr);
    assert.match(foreign.stdout,/AUTO_UPDATE_WRONG_ACCOUNT_SESSION/);
    assert.doesNotMatch(foreign.stdout,/SCOPE_ACCEPTED/);
  });
});

test('Windows exclusive installed-path lock prevents concurrent updater processes, then releases', 
 {skip:process.platform!=='win32',timeout:20000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-updater-lock-'));
 const app=path.join(dir,'app');
 fs.mkdirSync(app);
 const fixture=path.join(dir,'lock.ps1');
 fs.writeFileSync(fixture,[
   "$ErrorActionPreference='Stop'",
   '$InstallDir=$args[0]',
   "function Log([string]$msg){Write-Output $msg}",
   lockSnippet,
   "Write-Output 'LOCK_ACQUIRED'",
   'if($args.Length -ge 2 -and $args[1] -eq "hold"){ $null=[Console]::ReadLine() }',
   '$updateLockStream.Dispose()',
   "Write-Output 'LOCK_RELEASED'"
 ].join('\n'),{mode:0o600});
 let holder;
 t.after(()=>{
   try{holder?.stdin?.end('release\n');}catch{}
   try{if(holder&&!holder.killed)holder.kill();}catch{}
   fs.rmSync(dir,{recursive:true,force:true});
 });
 holder=spawn('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',fixture,app,'hold'],
   {encoding:'utf8',windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false});
 let out='';
 await new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>reject(new Error('LOCK_HOLDER_BOOT_TIMEOUT '+out)),8000);
   holder.stdout.on('data',data=>{
     out+=data.toString();
     if(out.includes('LOCK_ACQUIRED')){clearTimeout(timeout);resolve();}
   });
   holder.once('exit',code=>{if(!out.includes('LOCK_ACQUIRED')){clearTimeout(timeout);reject(new Error('HOLDER_EARLY_EXIT '+code+' '+out));}});
   holder.once('error',err=>{clearTimeout(timeout);reject(err);});
 });
 const blocked=runFile(fixture,[app,'probe']);
 assert.equal(blocked.status,0,blocked.stderr);
 assert.match(blocked.stdout,/AUTO_UPDATE_ALREADY_RUNNING_OR_LOCK_UNAVAILABLE/);
 assert.doesNotMatch(blocked.stdout,/LOCK_ACQUIRED/);
 holder.stdin.write('release\n');
 await new Promise((resolve,reject)=>{
    if(holder.exitCode!==null)return resolve();
    const timeout=setTimeout(()=>reject(new Error('HOLDER_NOT_RELEASED')),5000);
    holder.once('exit',()=>{clearTimeout(timeout);resolve();});
 });
 const recovered=runFile(fixture,[app,'probe']);
 assert.equal(recovered.status,0,recovered.stderr);
 assert.match(recovered.stdout,/LOCK_ACQUIRED/);
 assert.match(recovered.stdout,/LOCK_RELEASED/);
 assert.ok(fs.existsSync(path.join(dir,'.rc-auto-update.lock')));
});
