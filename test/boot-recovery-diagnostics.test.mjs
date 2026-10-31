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
    // A source checkout must fail the protected machine-app root trust check before
    // hash/credential checks. A genuinely installed machine-app can reach those later checks.
    const protectedRoot = path.resolve(process.env.ProgramFiles || 'C:\\Program Files', 'ChatGPTRemoteCommander', 'machine-app');
    if (path.resolve(repo).toLowerCase() === protectedRoot.toLowerCase()) {
      assert.match(result.error,/instance config hash mismatch probe|BOOT_RECOVERY_PROTECTED_CREDENTIAL_ROOT_MISSING/u);
    } else {
      assert.equal(result.error,'BOOT_RECOVERY_MACHINE_APP_ROOT_REQUIRED',
        'BootCore must reject a source checkout before integrity/credential checks');
    }
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

test('SYSTEM credential root verifier preserves fail-closed migration gate', () => {
  const boot=fs.readFileSync(path.join(repo,'enable-boot-recovery.ps1'),'utf8');
  const helper=fs.readFileSync(path.join(repo,'machine-credential-trust.ps1'),'utf8');
  for(const phrase of [
    'Assert-RcMachineCredentialStore',
    'BOOT_RECOVERY_PROTECTED_CREDENTIAL_ROOT_MISSING',
    'BOOT_RECOVERY_CREDENTIAL_ROOT_INHERITS',
    'BOOT_RECOVERY_CREDENTIAL_ROOT_UNTRUSTED_ACE',
    'BOOT_RECOVERY_CREDENTIAL_PARENT_DELETE_OR_DAC',
    'BOOT_RECOVERY_CREDENTIAL_FILE_UNTRUSTED_ACE'
  ]) assert.ok((boot+helper).includes(phrase),'missing '+phrase);
  const rootCheck=boot.indexOf('$MachineCredentialRoot = Assert-RcMachineCredentialStore');
  const failClosed=boot.indexOf("throw 'BOOT_RECOVERY_MACHINE_CREDENTIAL_STORAGE_MIGRATION_REQUIRED'");
  const firstWrite=boot.indexOf('New-Item -ItemType Directory -Force -Path $VarDir');
  assert.ok(rootCheck >= 0 && rootCheck < failClosed && failClosed < firstWrite);
  assert.ok(!helper.includes('Unprotect(') && !helper.includes('Get-Content'),
    'attestation must not read or decrypt credential bytes');
});

test('BootCore machine-scope credentials must use protected store, not owner LocalAppData', () => {
  const runtime=fs.readFileSync(path.join(repo,'windows-supervisor-runtime.ps1'),'utf8');
  const boot=fs.readFileSync(path.join(repo,'autostart-windows.ps1'),'utf8');
  assert.ok(runtime.includes('BOOT_RECOVERY_MACHINE_CREDENTIAL_SCOPE_REQUIRED'));
  assert.ok(runtime.includes('$credentials = Assert-RcMachineCredentialStore'));
  assert.ok(runtime.includes('CredDir=$credentials'));
  assert.ok(boot.includes('Initialize-WindowsSupervisorRuntime $Root $OwnerUserProfile ([bool]$BootCore) $CredentialScope'));
  assert.ok(boot.includes('if(-not $SelfTest){throw}'),'no live BootCore credential-root bypass');
  assert.ok(boot.includes('exit 3'),'fail closed early selftest receipt');
});

test('machine credential ProgramData ACL rejects custom principals and GenericAll without misclassifying InheritOnly', { skip: process.platform !== 'win32' }, () => {
  const helper=path.join(repo,'machine-credential-trust.ps1');
  const source=fs.readFileSync(helper,'utf8');
  assert.ok(source.includes('$sid -notin $trustedSids'));
  assert.ok(source.includes('PropagationFlags]::InheritOnly'));
  assert.ok(!source.includes('$untrusted ='), 'fixed three-SID allowlist is insufficient');
  const quoted=helper.replaceAll("'","''");
  const cmd=[
    "$ErrorActionPreference='Stop'",
    ". '"+quoted+"'",
    "$sid=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-547')",
    "$ace=[pscustomobject]@{IdentityReference=$sid;AccessControlType=[Security.AccessControl.AccessControlType]::Allow;FileSystemRights=[int64]0;PropagationFlags=[Security.AccessControl.PropagationFlags]::None}",
    "$acl=[pscustomobject]@{Owner='NT AUTHORITY\\SYSTEM';Access=@($ace)}",
    "$denied=0",
    "foreach($right in @([int64][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,[int64]0x10000000)){ $ace.FileSystemRights=$right; try{ Assert-RcCredentialParentAcl $acl; throw 'UNTRUSTED_PARENT_RIGHT_ACCEPTED' }catch{ if($_.Exception.Message -ne 'BOOT_RECOVERY_CREDENTIAL_PARENT_DELETE_OR_DAC'){ throw }; $denied++ } }",
    "if($denied -ne 2){throw 'DANGEROUS_RIGHTS_NOT_REJECTED'}",
    "$ace.PropagationFlags=[Security.AccessControl.PropagationFlags]::InheritOnly",
    "Assert-RcCredentialParentAcl $acl",
    "$ace.PropagationFlags=[Security.AccessControl.PropagationFlags]::None",
    "$ace.FileSystemRights=[int64][Security.AccessControl.FileSystemRights]::Write",
    "Assert-RcCredentialParentAcl $acl",
    "$acl.Owner='BUILTIN\\Users'",
    "try{ Assert-RcCredentialParentAcl $acl; throw 'OWNER_NOT_REJECTED' }catch{ if($_.Exception.Message -ne 'BOOT_RECOVERY_CREDENTIAL_PARENT_OWNER'){throw} }",
    "$acl.Owner='NT AUTHORITY\\SYSTEM'",
    "Write-Output 'MACHINE_CREDENTIAL_PARENT_ACL_NEGATIVE_PASS'"
  ].join(';');
  const r=spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',cmd],{encoding:'utf8',timeout:15000});
  assert.equal(r.status,0,r.stderr||r.stdout);
  assert.match(r.stdout,/MACHINE_CREDENTIAL_PARENT_ACL_NEGATIVE_PASS/u);
});
