import test from 'node:test';
import './windows-owner-gui-ipc-contract.test.mjs';
import './windows-owner-gui-bridge-status.test.mjs';
import './windows-owner-gui-status-provider.test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorkflowStore } from '../src/workflow-store.mjs';

const root=path.resolve(import.meta.dirname,'..');
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8');

test('desktop access and operations UI is wired to real guarded backends',()=>{
  const profiles=read('desktop/profile-manager-windows.ps1');
  for(const marker of [
    'Profiles, permissions and runtime authority',
    'auto-update-windows.ps1',
    "'-TargetProfile','default'",
    'reconfigure-profile-instance.ps1',
    '-EnableCapability',
    '-DisableCapability',
    'operations-monitor-windows.ps1',
    'admin-runtime-windows.ps1',
    'stale version labels are not treated as profiles'
  ]) assert.ok(profiles.includes(marker),marker);
  for(const cap of [
    'filesystem.full','shell.execute','process.control','filesystem.permanent_delete',
    'browser.background','browser.navigate','browser.input','browser.screenshot',
    'workflow.scheduler','workflow.project_engine','lifecycle.auto_update','lifecycle.zero_downtime_update'
  ]) assert.ok(profiles.includes(cap),cap);

  const monitor=read('desktop/operations-monitor-windows.ps1');
  assert.ok(monitor.includes('tools\\workflow-cli.mjs'));
  assert.ok(monitor.includes('persisted workflow records'));
  assert.ok(monitor.includes("'RUNNING' is persisted lifecycle, not proof of a live process"));

  const admin=read('desktop/admin-runtime-windows.ps1');
  for(const marker of [
    'ChatGPTRemoteCommander-ElevatedRuntime',
    'New-ScheduledTaskPrincipal',
    '-LogonType Interactive',
    '-RunLevel Highest',
    'elevated-runtime-entry-windows.ps1',
    'ADMIN_RUNTIME_ELEVATED_PROBE_FAILED',
    'Remove-ItemProperty -Path $RunKey -Name $RunName',
    'Start-NonElevatedFallback'
  ]) assert.ok(admin.includes(marker),marker);
  for(const forbidden of ['-LogonType Password','-LogonType S4U','DefaultPassword','ConvertFrom-SecureString']) {
    assert.equal(admin.includes(forbidden),false,forbidden);
  }
  assert.ok(admin.indexOf('ADMIN_RUNTIME_ELEVATED_PROBE_FAILED') < admin.indexOf('Remove-ItemProperty -Path $RunKey -Name $RunName'),
    'legacy autostart may be disabled only after elevated readback probe');

  const entry=read('elevated-runtime-entry-windows.ps1');
  assert.ok(entry.includes('WindowsBuiltInRole]::Administrator'));
  assert.ok(entry.includes('ADMIN_RUNTIME_NOT_ELEVATED'));
  assert.ok(entry.includes("autostart-windows.ps1"));

  const build=read('desktop/build-windows.ps1');
  for(const file of [
    'profile-manager-windows.ps1','profile-enrollment-windows.ps1',
    'operations-monitor-windows.ps1','admin-runtime-windows.ps1'
  ]) assert.ok(build.includes(file),file);

  const install=read('desktop/install-windows.ps1');
  assert.ok(install.includes("[ValidateSet('Core','ControlMonitoring')][string]$Mode"));
  assert.ok(install.includes("$DashboardShortcut=Join-Path $StartMenu 'Remote Commander.lnk'"));
  assert.ok(install.includes('shortcuts=1'),'desktop installer must expose one public Commander shortcut');
  assert.equal(install.includes("New-RcShortcut 'Remote Commander Profiles & Access'"),false);
  assert.equal(install.includes("New-RcShortcut 'Remote Commander Operations Monitor'"),false);
  assert.equal(install.includes("New-RcShortcut 'Remote Commander Admin Runtime'"),false);
  for(const legacy of [
    'Remote Commander Profiles & Access.lnk',
    'Remote Commander Operations Monitor.lnk',
    'Remote Commander Admin Runtime.lnk'
  ]) assert.ok(install.includes(legacy),'legacy shortcut cleanup '+legacy);
  assert.ok(install.includes('product-install.json'));
  assert.ok(install.includes("controlMonitoring=($Mode -eq 'ControlMonitoring')"));

  const dashboard=read('desktop/RemoteCommanderDashboard/Program.cs');
  for(const marker of [
    'Add Profiles','Profiles & Access','Operations Monitor','Admin Runtime',
    'ToolInstalled','LaunchPendingProfileOnboarding','requested-profiles.txt'
  ]) assert.ok(dashboard.includes(marker),marker);
});

test('Windows updater can target one named profile without changing default all-profile semantics',()=>{
  const s=read('auto-update-windows.ps1');
  assert.ok(s.includes('[string[]]$TargetProfile = @()'));
  assert.ok(s.includes('$TargetProfile=@($TargetProfile|Select-Object -Unique)'));
  const targets=s.slice(s.indexOf('function Get-Targets'),s.indexOf('function Start-Router'));
  assert.ok(targets.includes("if($TargetProfile.Count -gt 0)"));
  assert.ok(targets.includes('$TargetProfile -contains $_.Profile'));
  assert.ok(targets.includes('TARGET_PROFILE_NOT_FOUND'));
});

test('workflow CLI opens a real store from full Commander config and expands environment roots',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-workflow-cli-'));
  const workflows=path.join(dir,'workflows');
  const projectRoot=path.join(dir,'project');
  fs.mkdirSync(projectRoot,{recursive:true});
  const store=new WorkflowStore({
    directory:workflows,
    rootLeaseDirectory:path.join(dir,'leases'),
    allowedRoots:[projectRoot],
    device:'contract-test',
    configSha256:'a'.repeat(64),
    authority:{profileId:'default',tier:'FULL_POWER',capabilities:[]},
    executionProfile:{},
    schedulerPolicy:{enabled:true}
  });
  store.close();

  const config=path.join(dir,'config.json');
  fs.writeFileSync(config,JSON.stringify({
    allowedRoots:['%RC_CLI_TEST_ROOT%'],
    powerMode:{enabled:false},
    capabilityProfile:{id:'default',tier:'STANDARD',explicitlyAuthorized:true},
    durableWorkflows:{
      enabled:true,directory:workflows,rootLeaseDirectory:path.join(dir,'leases'),
      scheduler:{enabled:true,oneWriterPerRoot:true}
    }
  },null,2));
  const run=spawnSync(process.execPath,[path.join(root,'tools','workflow-cli.mjs'),config,'status'],{
    encoding:'utf8',env:{...process.env,RC_CLI_TEST_ROOT:projectRoot}
  });
  try{
    assert.equal(run.status,0,run.stderr||run.stdout);
    const result=JSON.parse(run.stdout);
    assert.equal(result.scheduler,true);
    assert.equal(result.oneWriterPerRoot,true);
  }finally{
    fs.rmSync(dir,{recursive:true,force:true,maxRetries:4,retryDelay:50});
  }
});

test('new Windows desktop/admin scripts parse without execution',t=>{
  if(process.platform!=='win32'){t.skip('Windows-only parser gate');return;}
  for(const script of [
    'desktop/profile-manager-windows.ps1','desktop/profile-enrollment-windows.ps1',
    'desktop/operations-monitor-windows.ps1','desktop/admin-runtime-windows.ps1',
    'desktop/build-windows.ps1','desktop/install-windows.ps1','installer/build-setup.ps1',
    'server-install-windows.ps1','install.ps1','enable-autostart.ps1',
    'elevated-runtime-entry-windows.ps1','auto-update-windows.ps1','reconfigure-profile-instance.ps1'
  ]){
    const command='$t=$null;$e=$null;[Management.Automation.Language.Parser]::ParseFile((Resolve-Path "'+script+'"),[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|% Message;exit 2}';
    const r=spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{cwd:root,encoding:'utf8',windowsHide:true});
    assert.equal(r.status,0,script+'\n'+(r.stdout||'')+(r.stderr||''));
  }
});
