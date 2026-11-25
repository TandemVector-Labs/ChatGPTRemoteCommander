import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8');

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
  assert.ok(iss.includes('Filename: "{tmp}\\{#BrowserSetupName}"'));
});

test('bundled Browser preserves an existing owner-installed Browser, including a newer preview',()=>{
  const iss=read('installer/RemoteCommander.iss');
  const run=iss.split('[Run]')[1]?.split('[Code]')[0];
  assert.ok(run);
  assert.match(run,/Components: browser;.*Check: ShouldInstallBundledBrowser/);
  const guard=iss.split('function ShouldInstallBundledBrowser(): Boolean;')[1]?.split('function JsonBool')[0];
  assert.ok(guard);
  assert.match(guard,/RegQueryStringValue\(HKCU,/);
  assert.match(guard,/RemoteCommanderBrowser/);
  assert.match(guard,/product-install\.json/);
  assert.match(guard,/Result := not RegQueryStringValue/);
});
test('offline exact-head shallow ZIP replaces distributable full-history Git bundle',()=>{
  const iss=read('installer/RemoteCommander.iss');
  const builder=read('installer/build-setup.ps1');
  const install=read('install.ps1');
  const updater=read('auto-update-windows.ps1');
  const helper=read('tools/offline-shallow-source.ps1');
  assert.match(iss,/#error CORE_FULL_HISTORY_BUNDLE_FORBIDDEN/);
  assert.match(iss,/#ifdef CoreSourceSnapshot/);
  assert.match(iss,/ExtractTemporaryFile\('offline-shallow-source[.]ps1'\)/);
  assert.match(iss,/SourceSnapshotSha256/);
  assert.match(builder,/CORE_LEGACY_BUNDLE_DIRECT_USE_FORBIDDEN/);
  assert.match(builder,/DCoreSourceSnapshotSHA256/);
  assert.match(install,/SHALLOW_SOURCE_IMPORT_FAILED/);
  assert.match(install,/SourceSnapshotRepo/);
  assert.match(updater,/SHALLOW_SOURCE_REPOSITORY_VERIFICATION_FAILED/);
  assert.match(helper,/SHALLOW_SOURCE_HISTORY_INCLUDED/);
  assert.match(helper,/SHALLOW_SOURCE_ARCHIVE_SHA256_MISMATCH/);
  assert.match(helper,/SHALLOW_SOURCE_UNREACHABLE_OBJECT/);
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

test('Windows Inno archive source files omit build-host file timestamps',()=>{
  const section=read('installer/RemoteCommander.iss').split('[Files]')[1]?.split('[Icons]')[0];
  assert.ok(section,'Inno [Files] section required');
  const entries=section.split(/\r?\n/).map(x=>x.trim()).filter(x=>x.startsWith('Source:'));
  assert.equal(entries.length,12,'validate pinned Shallow Git snapshot, verifier, Windows runner, display labels and exact installer inventory');
  for(const entry of entries){
    assert.match(entry,/\bnotimestamp\b/,'each packaged file must omit source filesystem timestamps');
  }
});

test('pinned Windows Job Object runner is built, embedded, installed and staged before candidate qualification',()=>{
  const builder=read('installer/build-setup.ps1');
  const iss=read('installer/RemoteCommander.iss');
  const install=read('install.ps1');
  const linuxInstall=read('install.sh');
  const runnerInstaller=read('tools/windows-job-runner/install-windows-job-runner.ps1');
  const updater=read('auto-update-windows.ps1');
  const releaseSync=read('.github/workflows/release-sync.yml');
  const ci=read('.github/workflows/ci.yml');
  assert.ok(builder.includes('verify-windows-job-runner.ps1'),'setup build must verify or build the pinned runner');
  assert.ok(builder.includes('-Ensure'),'setup build must produce the self-contained runner when absent');
  assert.ok(builder.includes("('/DWindowsJobRunner='+$RunnerPath)"),'Inno receives the verified runner path');
  assert.ok(builder.includes('windowsJobRunnerSha256=$RunnerSha'));
  assert.ok(iss.includes('#error V102_PINNED_WINDOWS_JOB_RUNNER_REQUIRED'));
  assert.ok(iss.includes('Source: "{#WindowsJobRunner}"; DestName: "CommanderWindowsJobRunner.exe"'));
  assert.ok(iss.includes("ExtractTemporaryFile('CommanderWindowsJobRunner.exe')"));
  assert.ok(iss.includes('-WindowsJobRunnerPath '));
  assert.ok(install.includes('function Install-WindowsJobRunner'));
  assert.ok(install.includes('install-windows-job-runner.ps1'));
  assert.ok(install.includes('V012_INSTALL_RELEASE_TRAIN_NOT_APPROVED'));
  assert.ok(install.includes('verify-v012-publish-readiness.mjs'));
  assert.ok(linuxInstall.includes('V012_INSTALL_RELEASE_TRAIN_NOT_APPROVED'));
  assert.ok(linuxInstall.includes('verify-v012-publish-readiness.mjs'));
  assert.ok(runnerInstaller.includes('function Install-CommanderWindowsJobRunner'));
  assert.ok(runnerInstaller.includes('WINDOWS_JOB_RUNNER_SOURCE_SHA_MISMATCH'));
  assert.ok(runnerInstaller.includes('WINDOWS_JOB_RUNNER_INSTALL_OR_VERIFY_FAILED'));
  assert.ok(runnerInstaller.includes('WINDOWS_JOB_RUNNER_INSTALL_TEMP_SHA_MISMATCH'));
  assert.ok(runnerInstaller.includes('Move-Item -LiteralPath $installTemp -Destination $installedTarget -Force'));
  assert.ok(install.includes('Install-WindowsJobRunner -SourcePath $WindowsJobRunnerPath'));
  assert.ok(install.includes('Install-WindowsJobRunner -SourcePath $WindowsJobRunnerPath -ManifestRoot $temp'));
  assert.ok(install.indexOf('candidate-first update failed:')<install.indexOf('Install-WindowsJobRunner -SourcePath $WindowsJobRunnerPath -ManifestRoot $temp'),
    'existing install runner is replaced only after candidate update succeeds');
  assert.ok(updater.includes('function Copy-WindowsJobRunner'));
  assert.ok(updater.includes('WINDOWS_JOB_RUNNER_NOT_INSTALLED'));
  assert.ok(updater.includes('Copy-WindowsJobRunner $stage.Dir'));
  assert.ok(updater.includes('[string]$WindowsJobRunnerPath ='));
  assert.ok(updater.includes('Install-ControlWindowsJobRunner $StageDir'));
  assert.ok(updater.includes('Promote-Control $stage.Commit $ref $stage.Dir'));
  assert.ok(updater.indexOf('Copy-WindowsJobRunner $stage.Dir')<updater.indexOf('$script:QualificationCommit=$stage.Commit'),
    'candidate native runner must be verified before qualification and routing');
  assert.ok(releaseSync.includes('git bundle create $bundle $bundleRef'),
    'legacy CI may construct historical input, but builder must never embed it');
  assert.ok(releaseSync.includes('-SourceBundle $bundle'));
  assert.ok(builder.includes('LEGACY_GIT_BUNDLE_NEVER_EMBEDDED'));
  assert.ok(builder.includes('CORE_LEGACY_BUNDLE_DIRECT_USE_FORBIDDEN'));
  assert.ok(builder.includes('test/offline-shallow-source.test.mjs'));
  assert.ok(builder.includes('/DCoreSourceSnapshotSHA256'));
  assert.ok(!builder.includes('/DCoreSourceBundle='));
  assert.ok(iss.includes('#error CORE_FULL_HISTORY_BUNDLE_FORBIDDEN'));
  assert.ok(ci.includes('verify-windows-job-runner.ps1 -Ensure'));
  assert.ok(ci.includes("dotnet-version: '8.0.427'"));
});

test('Windows direct ISCC compile refuses historical fallback identity and builder refuses version spoofing',()=>{
  const iss=read('installer/RemoteCommander.iss');
  const builder=read('installer/build-setup.ps1');
  for(const gate of ['V108_EXPLICIT_PACKAGE_VERSION_REQUIRED','V108_EXACT_SOURCE_COMMIT_REQUIRED','V108_EXPLICIT_SOURCE_REF_REQUIRED']){
    assert.ok(iss.includes('#error '+gate), 'missing hard build-time identity gate: '+gate);
  }
  assert.equal(iss.includes('#define MySourceRef "v0.10.18"'),false);
  assert.equal(iss.includes('#define MyVersion "0.10.18-dev"'),false);
  assert.equal(iss.includes('#define MyCommit "0000000000000000000000000000000000000000"'),false);
  assert.ok(builder.includes('SETUP_VERSION_MUST_MATCH_SOURCE_PACKAGE'));
  assert.ok(builder.includes("('/DMyVersion='+$Version)"));
  assert.ok(builder.includes("('/DMyCommit='+$ExpectedCommit)"));
  assert.ok(builder.includes("('/DMySourceRef='+$SourceRef)"));
});
