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
    assert.match(result.error,/BOOT_RECOVERY_MACHINE_APP_ROOT_REQUIRED|BOOT_RECOVERY_PROTECTED_CREDENTIAL_ROOT_MISSING/u);
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

test('SYSTEM executable ACL denies arbitrary SID mutators, generic rights and foreign owners', { skip: process.platform !== 'win32' }, () => {
  const installer=path.join(repo,'enable-boot-recovery.ps1');
  const source=fs.readFileSync(installer,'utf8');
  for(const required of ['function Assert-RcSystemExecutableAcl','BOOT_RECOVERY_SYSTEM_EXECUTABLE_OWNER_UNTRUSTED',
    'BOOT_RECOVERY_SYSTEM_EXECUTABLE_WRITABLE','0x50000000','PropagationFlags]::InheritOnly']) {
    assert.ok(source.includes(required), 'missing '+required);
  }
  assert.ok(!source.includes("$untrusted = @("), 'fixed SID blacklist must not survive');
  const quoted=installer.replaceAll("'","''");
  const cmd=[
    "$ErrorActionPreference='Stop'",
    "$tokens=$null;$errors=$null",
    "$ast=[Management.Automation.Language.Parser]::ParseFile('"+quoted+"',[ref]$tokens,[ref]$errors)",
    "if($errors.Count){throw 'INSTALLER_AST_FAIL'}",
    "$fn=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-RcSystemExecutableAcl'},$true))",
    "if($fn.Count -ne 1){throw 'ACL_FUNCTION_NOT_UNIQUE'}",
    ". ([ScriptBlock]::Create($fn[0].Extent.Text))",
    "$sid=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-547')",
    "$ace=[pscustomobject]@{IdentityReference=$sid;AccessControlType=[Security.AccessControl.AccessControlType]::Allow;FileSystemRights=[int64]0;PropagationFlags=[Security.AccessControl.PropagationFlags]::None}",
    "$acl=[pscustomobject]@{Owner='NT AUTHORITY\\SYSTEM';Access=@($ace)}",
    "foreach($right in @([int64][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,[int64]0x10000000,[int64]0x40000000)){ $ace.FileSystemRights=$right; try{ Assert-RcSystemExecutableAcl $acl; throw 'WRITE_NOT_REJECTED' }catch{ if($_.Exception.Message -ne 'BOOT_RECOVERY_SYSTEM_EXECUTABLE_WRITABLE'){throw} } }",
    "$ace.PropagationFlags=[Security.AccessControl.PropagationFlags]::InheritOnly",
    "Assert-RcSystemExecutableAcl $acl",
    "$ace.PropagationFlags=[Security.AccessControl.PropagationFlags]::None",
    "$ace.FileSystemRights=[int64][Security.AccessControl.FileSystemRights]::ReadAndExecute",
    "Assert-RcSystemExecutableAcl $acl",
    "$acl.Owner='BUILTIN\\Users'",
    "try{ Assert-RcSystemExecutableAcl $acl; throw 'OWNER_NOT_REJECTED' }catch{ if($_.Exception.Message -ne 'BOOT_RECOVERY_SYSTEM_EXECUTABLE_OWNER_UNTRUSTED'){throw} }",
    "Write-Output 'SYSTEM_EXECUTABLE_ARBITRARY_SID_FAIL_CLOSED_PASS'"
  ].join(';');
  const r=spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',cmd],
    {encoding:'utf8',timeout:15000});
  assert.equal(r.status,0,r.stderr||r.stdout);
  assert.match(r.stdout,/SYSTEM_EXECUTABLE_ARBITRARY_SID_FAIL_CLOSED_PASS/u);
});

test('SYSTEM BootRecovery pins vendor-signed machine binaries and rejects spoofed ProgramFiles or PATH', () => {
  const source=fs.readFileSync(path.join(repo,'enable-boot-recovery.ps1'),'utf8');
  for(const marker of [
    'function Get-RcMachineProgramFiles',
    'SpecialFolder]::ProgramFiles',
    'BOOT_RECOVERY_PROGRAMFILES_ENV_MISMATCH',
    'function Get-RcTrustedSystemBinaries',
    "PowerShell\\7\\pwsh.exe",
    "nodejs\\node.exe",
    "nodejs\\npm.cmd",
    "nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    'BOOT_RECOVERY_SYSTEM_BINARY_SIGNATURE_UNTRUSTED',
    'Get-AuthenticodeSignature',
    'Get-RcTrustedSystemBinaries $OwnerUserProfile'
  ]) assert.ok(source.includes(marker),'missing '+marker);
  for(const unsafe of [
    '(Get-Command pwsh.exe -ErrorAction Stop).Source',
    '(Get-Command node.exe -ErrorAction Stop).Source',
    '(Get-Command npm.cmd -ErrorAction Stop).Source'
  ]) assert.equal(source.includes(unsafe),false,'PATH fallback '+unsafe);
  const admission=source.indexOf('Assert-RcSystemTaskInstallTrust $Root $OwnerUserProfile');
  const failClosed=source.indexOf("throw 'BOOT_RECOVERY_MACHINE_CREDENTIAL_STORAGE_MIGRATION_REQUIRED'");
  const register=source.indexOf('Register-ScheduledTask -TaskName $BootTaskName');
  assert.ok(admission>=0 && admission<failClosed && failClosed<register,'retain fail-closed registration');
});

test('BootCore never executes owner-configured paths or owner-writable tunnel binaries', () => {
  const runtime=fs.readFileSync(path.join(repo,'windows-supervisor-runtime.ps1'),'utf8');
  const boot=fs.readFileSync(path.join(repo,'autostart-windows.ps1'),'utf8');
  const routing=fs.readFileSync(path.join(repo,'supervisor-routing.ps1'),'utf8');
  const trust=fs.readFileSync(path.join(repo,'machine-runtime-trust.ps1'),'utf8');
  for(const required of [
    'BOOT_RECOVERY_MACHINE_APP_ROOT_REQUIRED',
    'Assert-RcMachineRuntimeStore',
    "Join-Path $machineRuntime 'profiles'",
    "Join-Path $machineRuntime 'instances'"
  ]) assert.ok(runtime.includes(required),required);
  assert.ok(boot.includes('if($BootCore){return Get-RcMachineTunnelExecutable}'));
  assert.ok(boot.includes("$env:REMOTE_COMMANDER_CONFIG=Join-Path $script:MachineRuntimeRoot 'primary\\config.json'"));
  assert.ok(routing.includes("BOOT_RECOVERY_MACHINE_ROUTE_PROJECT_UNTRUSTED"));
  assert.ok(routing.includes("BOOT_RECOVERY_MACHINE_ROUTE_CONFIG_UNTRUSTED"));
  assert.ok(routing.includes('if($BootCore){return} # never self-update under SYSTEM'));
  for(const marker of [
    'BOOT_RECOVERY_MACHINE_RUNTIME_UNTRUSTED_ACE',
    'BOOT_RECOVERY_MACHINE_RUNTIME_OWNER_UNTRUSTED',
    'BOOT_RECOVERY_MACHINE_TUNNEL_PIN_MISMATCH',
    'BOOT_RECOVERY_MACHINE_PRIMARY_PRIVILEGED'
  ]) assert.ok(trust.includes(marker),marker);
});


test('user-session handoff refuses unknown service state before considering SYSTEM shutdown', () => {
  const script=fs.readFileSync(path.join(repo,'handoff-user-session-windows.ps1'),'utf8');
  assert.match(script,/HANDOFF_STATUS_INCOMPLETE/u);
  assert.match(script,/HANDOFF_STATUS_INVALID/u);
  assert.match(script,/return \[pscustomobject\]@\{active=1;leases=1\}/u);
  assert.doesNotMatch(script,/return \[pscustomobject\]@\{active=0;leases=0\}/u);
});
