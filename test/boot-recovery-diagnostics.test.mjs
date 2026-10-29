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

test('SYSTEM BootRecovery install rejects untrusted owner paths before any mutation', () => {
  const source=fs.readFileSync(path.join(repo,'enable-boot-recovery.ps1'),'utf8');
  for(const required of [
    'BOOT_RECOVERY_MACHINE_APP_ROOT_REQUIRED',
    'BOOT_RECOVERY_SYSTEM_EXECUTABLE_WRITABLE',
    'BOOT_RECOVERY_SYSTEM_EXECUTABLE_REPARSE_POINT',
    'BOOT_RECOVERY_MACHINE_CREDENTIAL_STORAGE_MIGRATION_REQUIRED',
    'Assert-RcSystemTaskInstallTrust $Root $OwnerUserProfile',
    'Assert-RcProtectedMachinePath $binary $OwnerUserProfile'
  ]) assert.ok(source.includes(required), 'missing '+required);
  const rootGate=source.indexOf('Assert-RcSystemTaskInstallTrust $Root $OwnerUserProfile');
  const credentialGate=source.indexOf("throw 'BOOT_RECOVERY_MACHINE_CREDENTIAL_STORAGE_MIGRATION_REQUIRED'");
  for(const mutation of ['New-Item -ItemType Directory -Force -Path $VarDir',
    'Convert-OneCredential $profile','Register-ScheduledTask -TaskName $BootTaskName',
    'Start-ScheduledTask -TaskName $BootTaskName']){
    assert.ok(rootGate>=0 && rootGate<source.indexOf(mutation),'root gate must precede '+mutation);
    assert.ok(credentialGate>=0 && credentialGate<source.indexOf(mutation),'credential gate must precede '+mutation);
  }
  assert.ok(!source.includes('$Root = if((Test-Path -LiteralPath $stableSupervisor'),
    'legacy user-writable runtime fallback must not survive');
});
