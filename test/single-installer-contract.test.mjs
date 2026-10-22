import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8');

test('renamed organization source is pinned to canonical repository in install canaries',()=>{
  const repo='TandemVector-Labs/ChatGPTRemoteCommander';
  const workflow=read('.github/workflows/server-install-canary.yml');
  const windows=read('server-install-windows.ps1');
  const installer=read('install.ps1');
  assert.ok(workflow.includes(`github.repository == '${repo}'`));
  assert.ok(workflow.includes(`GOD13emad/ChatGPTRemoteCommander|${repo})`));
  assert.ok(windows.includes(`$env:GITHUB_REPOSITORY -ne '${repo}'`));
  assert.ok(windows.includes(`$Repo = 'https://github.com/${repo}.git'`));
  assert.ok(installer.includes(`$env:GITHUB_REPOSITORY -ne '${repo}'`));
  assert.ok(installer.includes(`$Repo = 'https://github.com/${repo}.git'`));
  assert.equal(workflow.includes('Usefull-Skills/ChatGPTRemoteCommander'),false);
  assert.equal(windows.includes('Usefull-Skills/ChatGPTRemoteCommander'),false);
  assert.equal(installer.includes('Usefull-Skills/ChatGPTRemoteCommander'),false);
});

test('single Windows installer exposes one product shell with two installation modes',()=>{
  const iss=read('installer/RemoteCommander.iss');

  assert.ok(iss.includes('AppName=Remote Commander'));
  assert.ok(iss.includes('PrivilegesRequired=lowest'),'setup must stay in the original user context');
  assert.equal(iss.includes('PrivilegesRequired=admin'),false);
  assert.ok(iss.includes('Name: "core"; Description: "Commander Core"'));
  assert.ok(iss.includes('Name: "complete"; Description: "Commander + Control && Monitoring"'));
  assert.ok(iss.includes('Name: "controlmonitor"; Description: "Control && Monitoring panel"'));

  const publicCommanderIcons=[...iss.matchAll(/Name:\s*"\{group\}\\Remote Commander"/g)];
  assert.equal(publicCommanderIcons.length,1,'installer must publish one Commander Start Menu icon');

  for(const legacy of [
    'Remote Commander Profiles & Access.lnk',
    'Remote Commander Operations Monitor.lnk',
    'Remote Commander Admin Runtime.lnk'
  ]) {
    assert.ok(iss.includes(legacy),'installer must clean legacy shortcut '+legacy);
    assert.equal(iss.includes('Name: "{group}\\'+legacy.replace(/\.lnk$/,'')+'"'),false,
      'internal tool must not be published as a Start Menu application');
  }

  assert.ok(iss.includes('profile-manager-windows.ps1'));
  assert.ok(iss.includes('profile-enrollment-windows.ps1'));
  assert.ok(iss.includes('Components: controlmonitor'));
  assert.ok(iss.includes('operations-monitor-windows.ps1'));
  assert.ok(iss.includes('admin-runtime-windows.ps1'));
});

test('fresh Windows bootstrap elevates only machine prerequisites and returns to user context for core',()=>{
  const iss=read('installer/RemoteCommander.iss');
  const server=read('server-install-windows.ps1');
  const install=read('install.ps1');

  assert.ok(iss.includes("ShellExec('runas'"),'machine prerequisite boundary must explicitly elevate');
  assert.ok(iss.includes('-PrerequisitesOnly'));
  assert.ok(iss.includes("Exec(PwshPath, Params"),'per-user core install must use the non-elevated setup context');
  assert.ok(iss.includes(' -StartServer -SourceRef "'), 'setup must preserve the existing core profile');
  assert.ok(iss.includes("if not ExistingCore then Params := Params + ' -StandardMode';"),
    'fresh installations remain Standard while existing installations preserve their access tier');
  assert.ok(iss.includes('PowerShell-7.6.6-win-x64.msi'));
  assert.ok(iss.includes('958838FF55091E1C8705D89EFED0CC7E8245A3A6EF6C0CCFAE20015227108AD8'));

  assert.ok(server.includes('[switch]$PrerequisitesOnly'));
  assert.ok(server.includes("SERVER_PREREQUISITES_PASS"));
  assert.ok(server.includes("[ValidateSet('Power','Standard')][string]$AccessMode = 'Power'"));
  assert.ok(server.includes("if ($AccessMode -eq 'Power') { $args += '-PowerMode' } else { $args += '-StandardMode' }"));

  const requireIndex=install.indexOf('Require-Windows');
  const refreshIndex=install.indexOf('Refresh-Path',requireIndex);
  const prereqIndex=install.indexOf('Ensure-Prerequisites',refreshIndex);
  assert.ok(requireIndex>=0 && refreshIndex>requireIndex && prereqIndex>refreshIndex,
    'freshly installed machine prerequisites must be visible before prerequisite validation');
});

test('installer collects only profile names; credentials are collected after install and passed in memory',()=>{
  const iss=read('installer/RemoteCommander.iss');
  const enrollment=read('desktop/profile-enrollment-windows.ps1');
  const autostart=read('enable-autostart.ps1');

  assert.ok(iss.includes('Profiles (semicolon-separated):'));
  assert.ok(iss.includes('requested-profiles.txt'));
  assert.equal(iss.includes("ProfilePage.Add('Runtime API key"),false);
  assert.equal(iss.includes("ProfilePage.Add('OpenAI tunnel_id"),false);

  assert.ok(autostart.includes('[Security.SecureString]$RuntimeApiKey'));
  assert.ok(autostart.includes('if ($RuntimeApiKey)'));
  assert.ok(enrollment.includes('ConvertTo-SecureString $key.Text -AsPlainText -Force'));
  assert.ok(enrollment.includes('& $Enroll -Profile $n -TunnelId $tid -RuntimeApiKey $secure'));
  assert.equal(enrollment.includes('Start-Process') && enrollment.includes('RuntimeApiKey'),false,
    'runtime API key must never be placed in a child-process command line');
  assert.ok(enrollment.includes('profile-enrollment-windows.ps1')===false,
    'profile setup must not recursively relaunch itself');
});

test('release setup clean guard rejects staged, untracked and substantive drift but tolerates EOL-only checkout normalization',()=>{
  const builder=read('installer/build-setup.ps1');
  const workflow=read('.github/workflows/release-sync.yml');
  assert.ok(builder.includes('ls-files --others --exclude-standard'));
  assert.ok(builder.includes('diff --cached --quiet --'));
  assert.ok(builder.includes('diff --ignore-space-at-eol --exit-code --'));
  assert.ok(builder.includes('Setup release build refuses untracked files'));
  assert.ok(builder.includes('Setup release build refuses staged tracked changes'));
  assert.ok(builder.includes('Setup release build refuses substantive unstaged tracked changes'));
  assert.ok(builder.includes('SETUP_TRACKED_EOL_DRIFT_ACCEPTED'));
  assert.ok(!workflow.includes('-AllowDirty'),'hosted Release Sync must not bypass the clean-worktree guard');
});

test('browser component is compile-time optional until a standalone Browser installer is supplied',()=>{
  const iss=read('installer/RemoteCommander.iss');
  assert.ok(iss.includes('#ifdef BrowserSetup'));
  assert.ok(iss.includes('#define BrowserSetupName ExtractFileName(BrowserSetup)'));
  assert.ok(iss.includes('Name: "browser"; Description: "Remote Commander Browser"'));
  assert.ok(iss.includes('Source: "{#BrowserSetup}"; DestName: "{#BrowserSetupName}"'));
  assert.equal(iss.includes('Filename: "{tmp}\\{#BrowserSetupName}"'),false,'nested Browser must check exit');
});

test('product icon is a standards-compliant multi-image ICO asset',()=>{
  const p=path.join(root,'desktop','RemoteCommanderDashboard','remote-commander.ico');
  const b=fs.readFileSync(p);
  assert.ok(b.length>1000);
  assert.deepEqual([...b.subarray(0,4)],[0,0,1,0]);
  const count=b.readUInt16LE(4);
  assert.ok(count>=4,'ICO should contain multiple display sizes');
});

test('native Desktop upgrade preserves authorized existing Core tier instead of forcing Standard',()=>{
  const iss=read('installer/RemoteCommander.iss');
  const install=read('install.ps1');
  const section=iss.slice(iss.indexOf('function PrepareToInstall'),iss.indexOf('procedure CurStepChanged'));
  assert.ok(section.includes("ExistingCoreGit := ExpandConstant('{localappdata}\\ChatGPTRemoteCommander\\app\\.git');"),
    'detect only the canonical existing user-local Core repository');
  assert.ok(section.includes('ExistingCore := DirExists(ExistingCoreGit) or FileExists(ExistingCoreGit);'),
    'accept directory or worktree Git markers without assuming a fresh installation');
  assert.ok(section.includes("if not ExistingCore then Params := Params + ' -StandardMode';"),
    'do not pass a demotion switch into an existing Core');
  assert.equal(section.includes(' -StartServer -StandardMode -SourceRef'),false,
    'unconditional Standard on Desktop update would downgrade existing owner-authorized Power');
  assert.ok(install.includes("if ($StandardMode) { $args += '-StandardMode' }"),
    'installer forwards explicit Standard only when supplied');
  assert.ok(install.includes('Invoke-ExistingSafeUpdate'),
    'existing Core still routes through the qualified updater');
});

test('organization preview bootstrap is explicit, exact-commit pinned, and cannot upgrade existing owner Core',()=>{
  const iss=read('installer/RemoteCommander.iss'), builder=read('installer/build-setup.ps1');
  const core=read('install.ps1'), server=read('server-install-windows.ps1');
  for(const file of [core,server]){
    assert.ok(file.includes("[ValidateSet('upstream','organization')][string]$SourceRepository = 'upstream'"));
    assert.ok(file.includes('ORGANIZATION_SOURCE_REQUIRES_PINNED_COMMIT'));
    assert.ok(file.includes("$Repo = 'https://github.com/TandemVector-Labs/ChatGPTRemoteCommander.git'"));
  }
  assert.ok(core.includes('ORGANIZATION_PREVIEW_EXISTING_INSTALL_DENIED'));
  assert.ok(iss.includes('if ExistingCore and (\'{#MySourceRepository}\' = \'organization\') then'));
  assert.ok(builder.includes('ORGANIZATION_SOURCE_REF_NOT_ADVERTISED'));
  assert.ok(builder.includes('ORGANIZATION_SOURCE_REF_SHA_MISMATCH'));
  assert.ok(server.includes("'-SourceRepository',$SourceRepository"));
  assert.ok(builder.includes("'/DMySourceRepository='+$SourceRepository"));
  assert.ok(builder.includes('ORGANIZATION_SOURCE_REQUIRES_PINNED_COMMIT'));
  assert.ok(iss.includes('#define MySourceRepository "upstream"'));
  assert.equal(iss.split('-SourceRepository "{#MySourceRepository}"').length - 1,2);
});


test('selected nested Browser failure is checked before writing installation metadata',()=>{
  const iss=read('installer/RemoteCommander.iss');
  const run=iss.slice(iss.indexOf('[Run]'),iss.indexOf('[Code]'));
  const code=iss.slice(iss.indexOf('procedure CurStepChanged('));
  assert.ok(!run.includes('BrowserSetupName'));
  assert.ok(code.includes("if WizardIsComponentSelected('browser') then"));
  assert.ok(code.includes("ExtractTemporaryFile('{#BrowserSetupName}')"));
  assert.ok(code.includes("if not Exec(ExpandConstant('{tmp}\\{#BrowserSetupName}')"));
  assert.ok(code.includes('ewWaitUntilTerminated, BrowserExitCode)'));
  assert.ok(code.includes("Log('BROWSER_INSTALL_LAUNCH_FAILED')"));
  assert.ok(code.includes('if BrowserExitCode <> 0 then'));
  assert.ok(iss.includes('function GetCustomSetupExitCode: Integer;'));
  assert.ok(iss.includes('if BrowserSetupFailed then Result := 4'));
  assert.equal((code.match(/BrowserSetupFailed := True;/g)??[]).length,2);
  assert.ok(code.includes('if not WizardSilent then'));
  assert.ok(!code.includes("RaiseException('BROWSER_INSTALL_EXIT_NONZERO_'"));
  assert.ok(code.includes("Log('BROWSER_INSTALL_EXIT_NONZERO_'"));
  assert.ok(code.indexOf('BROWSER_INSTALL_EXIT_NONZERO_') <
    code.indexOf("SaveStringToFile(ExpandConstant('{app}\\product-install.json')"));
});
