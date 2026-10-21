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

test('R470 sanitizer classifies TAP and redacts secret-looking test names without leaking raw output', {skip:process.platform!=='win32'}, () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-r470-safe-'));
  const sha='a'.repeat(40);
  const logDir=path.join(root,'STATE','ChatGPTRemoteCommander','update-logs');
  try {
    fs.mkdirSync(logDir,{recursive:true});
    const source=path.join(logDir,'qualification-output-qualification-test-'+sha.slice(0,12)+'-fixture.stdout.log');
    const synthetic='Bearer '+'fixture_public_dummy_token_123456789';
    fs.writeFileSync(source,['# not ok 17 - harmless fixture','# fail 1','server did not become healthy','not ok 18 - '+synthetic].join('\\n'));
    const r=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',
      path.join(repo,'tools','diagnose-updater-gate-r470.ps1'),
      '-Root',root,'-ExpectedCommit',sha],
      {encoding:'utf8',timeout:15000,windowsHide:true});
    assert.equal(r.status,0,r.stderr||r.stdout);
    const reportText=fs.readFileSync(path.join(root,'DIAGNOSTIC_R470.json'),'utf8');
    const j=JSON.parse(reportText);
    assert.equal(j.status,'TAP_SUMMARY_EXTRACTED');
    assert.equal(j.matchingLogCount,1);
    assert.equal(j.failureTests.length,2);
    assert.equal(j.failureTests[0].index,17);
    assert.equal(j.failureTests[0].publicTestName,'harmless fixture');
    assert.equal(j.failureTests[1].publicTestName,'REDACTED_TEST_NAME');
    assert.equal(j.tapCounts.fail,'1');
    assert.deepEqual(j.classifiedSignals,['SERVER_READINESS_TIMEOUT']);
    assert.equal(j.rawLogIncluded,false);
    assert.equal(j.stablePromoted,false);
    assert.equal(reportText.includes(synthetic),false);
    assert.equal(reportText.includes(root),false);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
