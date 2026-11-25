import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const repo=path.resolve(import.meta.dirname,'..');
const source=fs.readFileSync(path.join(repo,'handoff-user-session-windows.ps1'),'utf8');
const between=(from,to)=>{
  const begin=source.indexOf(from);
  const end=source.indexOf(to,begin);
  assert.ok(begin>=0&&end>begin,'required handoff section missing: '+from);
  return source.slice(begin,end);
};

test('Windows handoff fails closed on unavailable or malformed MCP status',()=>{
  const f=between('function Get-CommanderBusy {','function Stop-ExactProcess(');
  for(const marker of [
    'HANDOFF_BUSY_STATE_UNVERIFIED','HANDOFF_BUSY_STATE_INVALID',
    'HANDOFF_GUI_STATE_UNVERIFIED','HANDOFF_BROWSER_STATE_UNVERIFIED',
    "foreach($tool in @('gui_status','browser_status'))",
    '$s.concurrency.activeOperations','$s.concurrency.queued',
    '$s.durableWorkflows.schedulerState.currentLeases'
  ])assert.ok(f.includes(marker),'missing fail-closed prerequisite '+marker);
  assert.match(f,/catch\s*\{[^}]*active=1;queued=1;leases=1/su);
  assert.doesNotMatch(f,/catch\s*\{[^}]*active=0;leases=0/su);
  assert.match(source,/\$busy\.queued -eq 0/u);
  assert.match(source,/\$busy\.queued -ne 0/u);
});

test('Windows handoff stops only SYSTEM processes and excludes independent Headless server',()=>{
  const stop=between('function Stop-ExactProcess(','$deadline=');
  assert.match(stop,/if\(-not\(Test-SystemOwner \$Process\)\)\{return\}/u);
  const filter=between('$ownerCommanderRoot=','Start-Sleep -Seconds 1');
  for(const marker of [
    "$ownerCommanderPrefix=[regex]::Escape($ownerCommanderRoot+'\\')",
    'server-headless-v1\\auth-preload.cjs',
    'server-headless-v1\\run-headless.ps1',
    "$_.CommandLine -notmatch [regex]::Escape($headlessPreload)",
    "$_.ParentProcessId -notin $headlessSupervisorPids"
  ])assert.ok(filter.includes(marker),'missing independently protected process constraint '+marker);
  assert.doesNotMatch(filter,/\$commanderPattern\s*=\s*'ChatGPTRemoteCommander'/u);
  assert.match(source,/\$expectedTunnel=\[IO\.Path\]::GetFullPath/u);
  assert.match(source,/\$_\.ExecutablePath.*-eq \$expectedTunnel/u);
});

test('Windows handoff retains bounded idle wait, busy deferral, and user-profile parametrization',()=>{
  assert.match(source,/\[ValidateRange\(30,900\)\]\[int\]\$WaitSeconds/u);
  assert.match(source,/\$OwnerUserProfile=\[IO\.Path\]::GetFullPath\(\$OwnerUserProfile\)/u);
  assert.match(source,/HANDOFF_DEFERRED_BUSY/u);
  assert.match(source,/exit 75/u);
  assert.match(source,/USER_SESSION_HANDOFF_RECOVERY_PENDING/u);
  assert.match(source,/exit 76/u);
  assert.match(source,/USER_SESSION_HANDOFF_PASS/u);
});


test('Native Windows PowerShell mock covers idle, queued, GUI/browser leases, malformed and unauthorized status',
  {skip:process.platform!=='win32'},()=>{
    const result=spawnSync('pwsh.exe',[
      '-NoLogo','-NoProfile','-NonInteractive','-File',
      path.join(repo,'test','windows-handoff-failclosed-native.ps1')
    ],{cwd:repo,encoding:'utf8',timeout:15000,windowsHide:true});
    assert.equal(result.status,0,result.stderr||result.stdout);
    assert.match(result.stdout,/HANDOFF_NATIVE_FAILCLOSED_PASS cases=7/u);
  });

test('Windows handoff PASS requires SID-qualified user-owned Router and Tunnel listeners',()=>{
  const profile=between('function Get-OwnerProfileSid {','$recoverDeadline=');
  for(const required of [
    "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList",
    'ProfileImagePath','GetOwnerSid','Get-NetTCPConnection',
    "LocalAddress '127.0.0.1'","$listeners.Count -ne 1",
    "$_.State -eq 'Listen'","$null -eq $_.State","$_.RemoteAddress -eq '0.0.0.0'","$_.RemotePort -eq 0",
    "$owner.ReturnValue -eq 0","[string]$owner.Sid -eq $OwnerSid"
  ])assert.ok(profile.includes(required),'missing owner proof '+required);
  const recovery=source.slice(source.indexOf('$recoverDeadline='));
  assert.match(recovery,/\$ownerSid=Get-OwnerProfileSid/u);
  assert.match(recovery,/Test-OwnerListener 47831 \$ownerSid 'node\.exe'/u);
  assert.match(recovery,/Test-OwnerListener \$port \$ownerSid 'tunnel-client\.exe'/u);
  assert.match(recovery,/if\(\$mcp -and \$tunnelOk\)\{\$ok=\$true;break\}/u);
  assert.match(recovery,/USER_SESSION_HANDOFF_PASS/u);
});

test('Native Windows ownership fixture denies SYSTEM, wrong SID, ambiguous listener and profile',
  {skip:process.platform!=='win32'},()=>{
    const result=spawnSync('pwsh.exe',[
      '-NoLogo','-NoProfile','-NonInteractive','-File',
      path.join(repo,'test','windows-handoff-owner-listener-native.ps1')
    ],{cwd:repo,encoding:'utf8',timeout:15000,windowsHide:true});
    assert.equal(result.status,0,result.stderr||result.stdout);
    assert.match(result.stdout,/HANDOFF_OWNER_NATIVE_PASS cases=21/u);
  });


test('Handoff binds each tunnel health endpoint to its exact profile argument and denies partial config',()=>{
  const map=between('function ManagedTunnelProfiles {','# The recovery check must prove');
  for(const marker of [
    'BaseName','listen_addr:','$declarations.Count -ne 1',
    "return @()",'Select-Object -ExpandProperty Port -Unique',
    '$uniquePorts.Count -ne $profiles.Count'
  ])assert.ok(map.includes(marker),'missing profile integrity requirement '+marker);
  assert.match(map,/\$declarations=\[regex\]::Matches/u);
  assert.match(map,/\$match=\[regex\]::Match\(\$value/u);
  assert.match(map,/if\(-not \$match\.Success\)\{return @\(\)\}/u);
  const gate=source.slice(source.indexOf('$recoverDeadline='));
  assert.match(gate,/\$profiles=@\(ManagedTunnelProfiles\)/u);
  assert.match(gate,/\$profiles\.Count-gt0/u);
  assert.match(gate,/--profile\(\?:=\|\\s\+\)/u);
  assert.match(gate,/\[regex\]::Escape\(\[string\]\$entry\.Name\)/u);
  assert.match(gate,/Test-OwnerListener \$port \$ownerSid 'tunnel-client\.exe' \$profilePattern/u);
});

test('Native Windows profile fixture rejects same-port wrong profile and invalid configs',
  {skip:process.platform!=='win32'},()=>{
    const result=spawnSync('pwsh.exe',[
      '-NoLogo','-NoProfile','-NonInteractive','-File',
      path.join(repo,'test','windows-handoff-profile-match-native.ps1')
    ],{cwd:repo,encoding:'utf8',timeout:15000,windowsHide:true});
    assert.equal(result.status,0,result.stderr||result.stdout);
    assert.match(result.stdout,/HANDOFF_PROFILE_NATIVE_PASS cases=20/u);
  });

test('SYSTEM handoff must receive an explicit non-SYSTEM owner before any side effects',()=>{
  assert.match(source,/\$OwnerUserProfile = \$env:USERPROFILE/u);
  const fn=between('function Assert-HandoffOwnerContext(', '$Root=Split-Path');
  for(const marker of [
    'HANDOFF_OWNER_PROFILE_MISSING',
    'HANDOFF_OWNER_EXPLICIT_REQUIRED_FOR_SYSTEM',
    'HANDOFF_SYSTEM_PROFILE_CANNOT_OWN_USER_SESSION',
    "$PSBoundParameters.ContainsKey('OwnerUserProfile')",
    'WindowsIdentity]::GetCurrent().IsSystem'
  ])assert.ok(fn.includes(marker),'missing required SYSTEM preflight '+marker);
  assert.ok(source.indexOf('Assert-HandoffOwnerContext ([Security.Principal.WindowsIdentity]') <
    source.indexOf('New-Item -ItemType Directory'),
    'SYSTEM preflight must precede any file writes');
  assert.ok(source.indexOf('Assert-HandoffOwnerContext ([Security.Principal.WindowsIdentity]') <
    source.indexOf('Stop-ExactProcess $p'),
    'SYSTEM preflight must precede stopping processes');
});

test('Native Windows SYSTEM owner-context guard rejects implicit/mismatched owner',
  {skip:process.platform!=='win32'},()=>{
    const result=spawnSync('pwsh.exe',[
      '-NoLogo','-NoProfile','-NonInteractive','-File',
      path.join(repo,'test','windows-handoff-owner-context-native.ps1')
    ],{cwd:repo,encoding:'utf8',timeout:15000,windowsHide:true});
    assert.equal(result.status,0,result.stderr||result.stdout);
    assert.match(result.stdout,/HANDOFF_OWNER_CONTEXT_NATIVE_PASS cases=7/u);
  });
