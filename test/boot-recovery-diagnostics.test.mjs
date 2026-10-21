import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo=path.resolve(import.meta.dirname,'..');

test('Windows BootCore self-test writes structured integrity failure instead of disappearing into timeout', { skip: process.platform !== 'win32' }, () => {
  const owner=fs.mkdtempSync(path.join(os.tmpdir(),'rc-bootdiag-owner-'));
  try {
    const profileDir=path.join(owner,'AppData','Roaming','tunnel-client');
    const instanceDir=path.join(owner,'AppData','Local','ChatGPTRemoteCommander','instances','probe');
    fs.mkdirSync(profileDir,{recursive:true});
    fs.mkdirSync(instanceDir,{recursive:true});
    fs.writeFileSync(path.join(profileDir,'probe.yaml'),'url: "http://127.0.0.1:47834/mcp"\nlisten_addr: "127.0.0.1:47833"\n');
    const configPath=path.join(instanceDir,'config.json');
    fs.writeFileSync(configPath,JSON.stringify({port:47834,instance:{profile:'probe',isolated:true}},null,2)+'\n');
    fs.writeFileSync(path.join(instanceDir,'instance.json'),JSON.stringify({
      schema:1,profile:'probe',enabled:true,mcpPort:47834,configPath,
      configSha256:'0'.repeat(64),isolated:true
    },null,2)+'\n');
    const out=path.join(owner,'selftest.json');
    const r=spawnSync('pwsh.exe',[
      '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
      '-File',path.join(repo,'autostart-windows.ps1'),
      '-SelfTest','-CredentialScope','LocalMachine','-BootCore',
      '-OwnerUserProfile',owner,'-SelfTestOutput',out
    ],{encoding:'utf8',timeout:15000});
    assert.equal(r.status,3,r.stderr||r.stdout);
    assert.equal(fs.existsSync(out),true,'self-test output must exist on integrity failure');
    const result=JSON.parse(fs.readFileSync(out,'utf8'));
    assert.equal(result.ok,false);
    assert.equal(result.bootCore,true);
    assert.equal(result.credentialScope,'LocalMachine');
    assert.match(result.error,/instance config hash mismatch probe/u);
  } finally {
    fs.rmSync(owner,{recursive:true,force:true});
  }
});

test('BootRecovery installer surfaces structured probe failure and task last-result context', () => {
  const t=fs.readFileSync(path.join(repo,'enable-boot-recovery.ps1'),'utf8');
  for(const required of [
    'BOOT_RECOVERY_SYSTEM_PROBE_NO_RESULT',
    'lastTaskResult=',
    'BOOT_RECOVERY_SYSTEM_PROBE_FAIL error=',
    "$probe.PSObject.Properties.Name -contains 'error'"
  ]) assert.equal(t.includes(required),true,'missing '+required);
});

test('boot, handoff, and user-logon task launchers do not pin the versioned MSIX pwsh executable', () => {
  const install=fs.readFileSync(path.join(repo,'enable-boot-recovery.ps1'),'utf8');
  const launcher=fs.readFileSync(path.join(repo,'windows-pwsh-task-launcher.ps1'),'utf8');
  const handoff=fs.readFileSync(path.join(repo,'handoff-user-session-windows.ps1'),'utf8');
  assert.match(install,/BOOT_RECOVERY_STABLE_BOOTSTRAP_MISSING/u);
  assert.match(install,/New-ScheduledTaskAction -Execute \$bootstrap -Argument \$bootArgs/u);
  assert.match(install,/New-ScheduledTaskAction -Execute \$bootstrap -Argument \$handoffArgs/u);
  assert.match(install,/-Mode UserSupervisor/u);
  assert.match(launcher,/Get-AppxPackage -Name 'Microsoft.PowerShell' -ErrorAction Stop/u);
  assert.match(launcher,/Get-AppxPackage -AllUsers -Name 'Microsoft.PowerShell'/u);
  assert.match(launcher,/Sort-Object Version -Descending/u);
  assert.match(launcher,/BOOT_LAUNCHER_PWSH7_NOT_FOUND/u);
  assert.match(launcher,/USER_SUPERVISOR_DEFERRED_MACHINE_CREDENTIALS/u);
  assert.match(launcher,/USER_SUPERVISOR_DEFERRED_INVALID_USER_CREDENTIAL/u);
  assert.match(launcher,/ConvertTo-SecureString/u);
  assert.match(install,/BOOT_RECOVERY_STABLE_LAUNCHER_UPDATE_REQUIRED/u);
  assert.match(install,/if\(Test-Path -LiteralPath \$target -PathType Leaf\)\{return \$target\}/u);
  assert.match(handoff,/HANDOFF_DEFERRED_MACHINE_ONLY_CREDENTIALS/u);
  assert.ok(handoff.indexOf('HANDOFF_DEFERRED_MACHINE_ONLY_CREDENTIALS') <
            handoff.indexOf('Stop-ExactProcess $p'), 'machine-only credentials must stop handoff BEFORE any SYSTEM process termination');
});

test('Windows stable PowerShell bootstrap resolves PowerShell 7 without operating on live tasks', {skip:process.platform!=='win32'}, () => {
  const script=path.join(repo,'windows-pwsh-task-launcher.ps1');
  const result=spawnSync('powershell.exe',[
    '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,
    '-Mode','Boot','-SelfTest'
  ],{encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.match(result.stdout,/BOOT_LAUNCHER_SELFTEST_PASS mode=Boot/u);
});


test('non-elevated user supervisor resolves signed Store pwsh without privileged AllUsers', {skip:process.platform!=='win32'}, () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-pr55-store-user-'));
  try {
    const runner=path.join(temp,'store-user-fixture.ps1');
    const ps=[
      'param([string]$SourcePath)',
      'function global:Get-AppxPackage {',
      '  param([string]$Name,[switch]$AllUsers)',
      "  if ($AllUsers) { throw 'TEST_PRIVILEGED_ALLUSERS_DENIED' }",
      "  if ($Name -ne 'Microsoft.PowerShell') { throw 'TEST_UNEXPECTED_PACKAGE_NAME' }",
      "  [pscustomobject]@{Name='Microsoft.PowerShell';Publisher='CN=Microsoft Corporation';Version=[version]'7.6.7.0';InstallLocation=(Join-Path $env:ProgramFiles 'WindowsApps\\Microsoft.PowerShell_7.6.7.0_x64__8wekyb3d8bbwe')}",
      '}',
      'function global:Test-Path {',
      "  param([string]$LiteralPath,[string]$Path,[string]$PathType='Any')",
      '  $candidate=if($LiteralPath){$LiteralPath}else{$Path}',
      "  if ($candidate -match '[\\\\/]PowerShell[\\\\/]7[\\\\/]pwsh\\.exe$') { return $false }",
      "  if ($candidate -match '[\\\\/]WindowsApps[\\\\/]Microsoft\\.PowerShell_7\\.6\\.7\\.0_x64__8wekyb3d8bbwe[\\\\/]pwsh\\.exe$') { return $true }",
      '  Microsoft.PowerShell.Management\\Test-Path -LiteralPath $candidate -PathType $PathType',
      '}',
      '& $SourcePath -Mode UserSupervisor -SelfTest',
      'exit $LASTEXITCODE'
    ].join('\n');
    fs.writeFileSync(runner,ps,'utf8');
    const result=spawnSync('powershell.exe',[
      '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',runner,
      '-SourcePath',path.join(repo,'windows-pwsh-task-launcher.ps1')
    ],{encoding:'utf8',timeout:15000,windowsHide:true});
    assert.equal(result.status,0,result.stderr||result.stdout);
    assert.match(result.stdout,/BOOT_LAUNCHER_SELFTEST_PASS mode=UserSupervisor/u);
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
});
