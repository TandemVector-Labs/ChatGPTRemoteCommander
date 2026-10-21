import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { validateHardwareSelftestEndpoint } from '../tools/hardware-selftest-endpoint.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');

// Execute generated Bash qualification fixtures as private, owned script files,
// never as data supplied to bash -c. Arguments remain separate argv data.
// All files stay under the existing test-owned sandbox and are removed immediately.
function runPrivateBashFixture(source, args, options, sandbox) {
  assert.equal(path.dirname(path.resolve(sandbox)),path.resolve(os.tmpdir()),
    'generated Bash fixture must remain under an owned OS-temp test sandbox');
  assert.ok(typeof source==='string'&&source.startsWith('set -Eeuo pipefail'));
  assert.ok(Array.isArray(args)&&args.every(value=>typeof value==='string'));
  const stage=fs.mkdtempSync(path.join(sandbox,'.bash-fixture-'));
  const file=path.join(stage,'fixture.sh');
  try {
    fs.writeFileSync(file,source,{encoding:'utf8',flag:'wx',mode:0o600});
    return spawnSync('bash',[file,...args],options);
  }finally{
    fs.rmSync(stage,{recursive:true,force:true});
  }
}


test('private Bash fixture treats untrusted argv as literal data, not shell commands',t=>{
  if(process.platform!=='linux')return t.skip('native Bash fixture only');
  const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'rc-bash-argv-safety-'));
  t.after(()=>fs.rmSync(sandbox,{recursive:true,force:true}));
  const marker=path.join(sandbox,'must-not-be-created');
  const injected='$(touch '+marker+')';
  const result=runPrivateBashFixture(
    'set -Eeuo pipefail\nprintf "%s\n" "$1"',
    [injected],{encoding:'utf8',timeout:5000},sandbox);
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),injected);
  assert.equal(fs.existsSync(marker),false,'argv must never be interpreted as Bash source');
  assert.equal(fs.readdirSync(sandbox).length,0,'private script and stage must be removed');
});

test('hardware selftest URL admits only canonical numeric loopback MCP endpoints',()=>{
  for (const url of ['http://127.0.0.1:47831/mcp','http://[::1]:47831/mcp','http://127.0.0.1:65535/mcp'])
    assert.equal(validateHardwareSelftestEndpoint(url),url);
  for (const url of [
    'http://localhost:47831/mcp',
    'http://example.invalid:47831/mcp',
    'https://127.0.0.1:47831/mcp',
    'http://0x7f000001:47831/mcp',
    'http://127.0.0.1/mcp',
    'http://127.0.0.1:80/mcp',
    'http://127.0.0.1:47831/health',
    'http://127.0.0.1:47831/foo/mcp',
    'http://127.0.0.1:47831/mcp/',
    'http://127.0.0.1:47831/mcp?next=example.invalid',
    'http://127.0.0.1:47831/mcp#fragment',
    'http://user:pass@127.0.0.1:47831/mcp',
    'file:///etc/passwd'
  ]) assert.throws(()=>validateHardwareSelftestEndpoint(url),/SELFTEST_LOOPBACK_ONLY/,url);
});

test('hardware selftest denies invalid URL before loading config or sending requests',()=>{
  const script=path.join(root,'tools','hardware-selftest.mjs');
  const missing=path.join(os.tmpdir(),'hardware-selftest-config-should-not-exist-48177.json');
  const r=spawnSync(process.execPath,[script,'--url','http://localhost:47831/mcp','--config',missing],{
    encoding:'utf8',timeout:5000
  });
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/SELFTEST_LOOPBACK_ONLY/);
  assert.doesNotMatch(r.stderr,/ENOENT|ECONNREFUSED|fetch failed/);
});


test('R205 retirement preflight is before any old release deletion on Windows and Linux',()=>{
 const win=read('auto-update-windows.ps1'),linux=read('auto-update-linux.sh'),helper=read('tools/release-retirement-gate-r205.mjs');
 const w=win.slice(win.indexOf('function Cleanup-Releases {'),win.indexOf('if($SelfTest){',win.indexOf('function Cleanup-Releases {')));
 const l=linux.slice(linux.indexOf('cleanup_releases(){'),linux.indexOf('detach_from_commander_backend_if_needed',linux.indexOf('cleanup_releases(){')));
 for(const marker of ['release-retirement-gate-r205.mjs','RELEASE_RETIRE_DEFER','GUARD_NOT_INSTALLED','RELEASE_RETIRE_AUTHORIZED']){
   assert.ok(w.includes(marker) && l.includes(marker),'missing '+marker);
 }
 assert.ok(w.indexOf("if($gate.status-ne'ALLOW'")<w.indexOf('Remove-Item -LiteralPath $d.FullName'),'Windows must enforce result before delete');
 assert.ok(l.indexOf('RELEASE_RETIRE_AUTHORIZED')<l.indexOf('rm -rf -- "$d"'),'Linux must enforce result before rm');
 assert.ok(w.indexOf('Get-ReleaseCleanupLockEvidence $d.FullName')<w.indexOf('Remove-Item -LiteralPath $d.FullName'));
 assert.ok(win.includes('RELEASE_PROCESS_ENUMERATION_UNVERIFIED'));
 for(const name of ['CORE_RETIREMENT_ACCEPTED','POST_ACCEPTANCE_APPROVAL_MISSING','REFERENCED_BY_CURRENT_OR_PREVIOUS_ROUTE','REFERENCED_BY_RETAINED_BACKEND','RELEASE_TREE_HAS_LOCAL_DATA_OR_CHANGES','browserLoginPreserved','rollbackVerified','soakAccepted','explicitRetirementAccepted'])
   assert.ok(helper.includes(name),'missing required safeguard: '+name);
});

test('R230 both NoPromote and normal Core upgrades preserve unknown legacy provider data',()=>{
  const win=read('auto-update-windows.ps1');
  const linux=read('auto-update-linux.sh');
  const w=win.slice(win.indexOf('function Ensure-ProjectProvider'),win.indexOf('function Stage-Release'));
  const l=linux.slice(linux.indexOf('ensure_project_provider(){'),linux.indexOf('ensure_browser_backend(){'));
  assert.ok(w.startsWith('function Ensure-ProjectProvider') && l.startsWith('ensure_project_provider(){'));
  const wGuard=w.indexOf('if($NoPromote){');
  const lGuard=l.indexOf('if [[ "$NO_PROMOTE" == 1 ]]');
  const wDisable=w.indexOf('PROJECT_PROVIDER_DISABLED policy=NO_CODEX_VIA_COMMANDER');
  const lDisable=l.indexOf('PROJECT_PROVIDER_DISABLED policy=NO_CODEX_VIA_COMMANDER');
  assert.ok(wGuard>=0&&lGuard>=0&&wDisable>wGuard&&lDisable>lGuard);
  assert.ok(w.slice(wGuard,wDisable).includes('return'));
  assert.ok(l.slice(lGuard,lDisable).includes('return 0'));
  assert.ok(w.includes('PROJECT_PROVIDER_CLEANUP_SKIPPED reason=no-promote'));
  assert.ok(l.includes('PROJECT_PROVIDER_CLEANUP_SKIPPED reason=no-promote'));
  assert.ok(w.includes('LEGACY_CODEX_PROVIDER_CLEANUP_PENDING reason=OWNER_ACCEPTANCE_REQUIRED'));
  assert.ok(l.includes('LEGACY_CODEX_PROVIDER_CLEANUP_PENDING reason=OWNER_ACCEPTANCE_REQUIRED'));
  assert.ok(!/Remove-Item|del-item|Start-Process|Get-CimInstance/u.test(w),'Windows provider block must be non-mutating');
  assert.ok(!/rm\s+-rf|chmod|chown|unlink|find\s+.*-delete/u.test(l),'Linux provider block must be non-mutating');
  assert.ok(win.includes('Ensure-ProjectProvider (Get-PrimaryConfig)') && linux.includes('ensure_project_provider "$STAGE_DIR" "$ACTIVE_CFG"'));
});

test('R230 real updater helper execution leaves arbitrary legacy projection sentinel intact',t=>{
 const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'rc-r230-preserve-'));
 const toolsPath=path.join(sandbox,'tools','codex-cli');
 fs.mkdirSync(path.join(toolsPath,'unknown-owner-subdir'),{recursive:true});
 const sentinel=path.join(toolsPath,'unknown-owner-subdir','sentinel.txt');
 fs.writeFileSync(sentinel,'R230_OWNER_DATA_NEVER_AUTO_DELETE');
 t.after(()=>{
   const tmp=path.resolve(os.tmpdir());
   assert.equal(path.dirname(path.resolve(sandbox)),tmp,'fixture cleanup must be limited to this unique temp directory');
   assert.match(path.basename(sandbox),/^rc-r230-preserve-/);
   fs.rmSync(sandbox,{recursive:true,force:true});
 });
 const win=read('auto-update-windows.ps1'),linux=read('auto-update-linux.sh');
 const windowsFn=win.slice(win.indexOf('function Ensure-ProjectProvider'),win.indexOf('function Stage-Release'));
 const linuxFn=linux.slice(linux.indexOf('ensure_project_provider(){'),linux.indexOf('ensure_browser_backend(){'));
 for(const promote of [false,true]){
   const noPromote=promote?'$true':'$false';
   let command,result;
   if(process.platform==='win32'){
     const escaped=sandbox.replace(/'/g,"''");
     command=[
       "$ErrorActionPreference='Stop'",
       "$StateRoot='"+escaped+"'",
       "$NoPromote="+noPromote,
       "function Log([string]$message){Write-Output $message}",
       windowsFn,
       "Ensure-ProjectProvider 'dummy-config'"
     ].join('\n');
     const encoded=Buffer.from(command,'utf16le').toString('base64');
     result=spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],{encoding:'utf8',timeout:15000});
   }else if(process.platform==='linux'){
     command=[
       'set -Eeuo pipefail',
       'STATE_ROOT="$1"',
       'NO_PROMOTE="$2"',
       'log(){ printf "%s\\n" "$1"; }',
       linuxFn,
       'ensure_project_provider'
     ].join('\n');
     result=runPrivateBashFixture(command,[sandbox,promote?'1':'0'],{encoding:'utf8',timeout:15000},sandbox);
   }else{
     return t.skip('R230 native execution is required only on Windows and Linux');
   }
   assert.equal(result.error,undefined,result.error?.message);
   assert.equal(result.status,0,'native helper failed: '+result.stderr);
   assert.equal(fs.readFileSync(sentinel,'utf8'),'R230_OWNER_DATA_NEVER_AUTO_DELETE','normal upgrade must preserve arbitrary nested owner data');
   assert.ok(result.stdout.includes(promote?'PROJECT_PROVIDER_CLEANUP_SKIPPED reason=no-promote':'LEGACY_CODEX_PROVIDER_CLEANUP_PENDING reason=OWNER_ACCEPTANCE_REQUIRED'),result.stdout);
   if(!promote)assert.ok(result.stdout.includes('PROJECT_PROVIDER_DISABLED policy=NO_CODEX_VIA_COMMANDER'));
 }
});

test('R-fleet unattended Stable check preserves newer persisted active route when MCP is unavailable',t=>{
 const win=read('auto-update-windows.ps1');
 const marker=win.indexOf('  # R-fleet: An accepted newer route');
 const end=win.indexOf('  $currentStatus=$null',marker);
 assert.ok(marker>win.indexOf('$script:QualificationCommit=$stage.Commit'),'guard follows stage identity');
 assert.ok(end>marker && end<win.indexOf("Run-Gate $stage.Dir 'check'"),'guard must precede tests or promotion');
 const snippet=win.slice(marker,end);
 for(const key of ["if(-not $Force)", "Get-RoutePath 'default'","Read-Json $persistedRoutePath",
   "Test-VersionGreater $persistedVersion $stage.Version","$report.authoritySource='PERSISTED_ROUTE'",
   "AUTO_UPDATE_NEWER_PERSISTED_ROUTE","exit 0"])assert.ok(snippet.includes(key),'missing '+key);
 if(process.platform!=='win32')return;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-route-no-downgrade-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const fixture=path.join(dir,'default.json');
 const run=(force,contents)=>{
   if(contents===null){fs.rmSync(fixture,{force:true});}
   else fs.writeFileSync(fixture,contents,'utf8');
   const program=[
     "$ErrorActionPreference='Stop'",
     '$Force='+String(force?'$true':'$false'),
     "$stage=[pscustomobject]@{Version='0.10.20'}",
     "$report=[ordered]@{}",
     "$ResultFile='unused-isolated-contract'",
     'function Get-RoutePath([string]$Profile){return $env:RC_ROUTE_FIXTURE}',
     'function Read-Json([string]$Path){return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -ErrorAction Stop}',
     'function Test-VersionGreater([string]$Left,[string]$Right){return ([version]$Left -gt [version]$Right)}',
     'function Atomic-Json([string]$Path,[object]$Value){Write-Output ("RECEIPT_STATUS="+$Value.status)}',
     'function Log([string]$Message){Write-Output $Message}',
     snippet,
     "Write-Output 'CROSSED_GUARD'"
   ].join('\n');
   return spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',program],{
     encoding:'utf8',timeout:15000,
     env:{...process.env,RC_ROUTE_FIXTURE:fixture}
   });
 };
 const newer=JSON.stringify({active:{version:'0.10.24',commit:'accepted-preview'}});
 const blocked=run(false,newer);
 assert.equal(blocked.status,0,blocked.stderr);
 assert.match(blocked.stdout,/AUTO_UPDATE_NEWER_PERSISTED_ROUTE/);
 assert.match(blocked.stdout,/RECEIPT_STATUS=NEWER_CURRENT/);
 assert.doesNotMatch(blocked.stdout,/CROSSED_GUARD/);
 const explicit=run(true,newer);
 assert.equal(explicit.status,0,explicit.stderr);
 assert.match(explicit.stdout,/CROSSED_GUARD/,'explicit Force is still available');
 const fresh=run(false,null);
 assert.equal(fresh.status,0,fresh.stderr);
 assert.match(fresh.stdout,/CROSSED_GUARD/,'first install without route is unaffected');
 const invalid=run(false,'{"active": ');
 assert.notEqual(invalid.status,0,'unparseable persisted authority fails closed');
 assert.doesNotMatch(invalid.stdout,/CROSSED_GUARD/);
});

test('auto updater is candidate-first, hardware-gated and commit-point aware',()=>{
  const s=read('auto-update-windows.ps1');
  for(const marker of [
    'Local\\ChatGPTRemoteCommanderAutoUpdater',
    "Run-Gate $stage.Dir 'check'",
    "Run-Gate $stage.Dir 'test'",
    "Run-Gate $stage.Dir 'audit'",
    'Run-GuiNativeSelfTest $stage.Dir',
    'copy-workflow-store.mjs',
    'workflow-shadow',
    'DisableCapability',
    'EnableCapability',
    'FINAL_CANDIDATE_DOCTOR_FAIL',
    'FULL_POWER_DELETE_FAIL',
    'RC_AUTOUPDATE_SHELL_PASS',
    'Verify-Canonical',
    'Verify-Tunnels',
    '$cutoverCommitted=$true',
    'finalize-workflow-schema.mjs',
    'Promote-Control',
    'Recycle-ControlSupervisor',
    'GATE_ARGUMENTS_MISSING',
    'CANDIDATE_CLEANUP_OWNERSHIP_MISMATCH',
    'Stop-OwnedCandidate',
    '$currentCandidate',
    'GUI_POLICY_STATUS_FAIL',
    'SUPERVISOR_RECYCLE_PASS',
    'Cleanup-Releases',
    'RELEASE_CLEANUP_DEFER',
    'AUTO_UPDATE_CLEANUP_PENDING',
    'PROMOTED_MAINTENANCE_REQUIRED',
    'PROMOTED_DRAIN_PENDING',
    'AUTO_UPDATE_DRAIN_PENDING',
    'DRAIN_CANCEL_SAFE',
    'Complete-DeferredDrains',
    'DRAIN_STALE_CONFIRMED',
    'DRAIN_STALE_DEFER',
    'DRAIN_PERSISTENT_TERMINAL_DEFER',
    'AUTO_UPDATE_ACTIVE_TERMINALS_PRESERVE',
    'DRAIN_TERMINAL_RETAINED',
    'retained-backends.json',
    'AUTO_UPDATE_EXISTING_DRAIN_BLOCK',
    'BLOCKED_EXISTING_DRAIN',
    'PROMOTED_PARTIAL',
    'AUTO_UPDATE_PROFILE_DEFER',
    'AUTO_UPDATE_EXISTING_DRAIN_DEFER',
    'Get-PersistentTerminalChildren',
    'ROUTER_PREVIOUS_RETIRED',
    'router-retire.mjs',
    'stale-drain-policy.ps1',
    'AUTO_UPDATE_NEWER_CURRENT',
    'Test-VersionGreater',
    'merge-primary-policy.mjs',
    'PRIMARY_POLICY_OVERLAY',
    'PRIMARY_POLICY_MERGE_FAIL',
    'auto-update-paused.json',
    'AUTO_UPDATE_PAUSED'
  ]) assert.ok(s.includes(marker),marker);
  assert.ok(s.includes("if(-not $Force -and (Test-Path -LiteralPath $PauseFile -PathType Leaf))"), 'automatic Windows update pause sentinel must fail before staging while explicit -Force remains available');
  const promote=s.slice(s.indexOf('function Promote-Control'),s.indexOf('function Recycle-ControlSupervisor'));
  for(const marker of ['diff --cached --quiet --','diff --ignore-space-at-eol --exit-code --','CONTROL_TRACKED_EOL_DRIFT_ACCEPTED'])assert.ok(promote.includes(marker),marker);
  assert.ok(promote.indexOf('diff --cached --quiet --') < promote.indexOf('CONTROL_TRACKED_EOL_DRIFT_ACCEPTED'),'staged control changes must fail before EOL-only drift is accepted');
  assert.ok(promote.indexOf('diff --ignore-space-at-eol --exit-code --') < promote.indexOf('CONTROL_TRACKED_EOL_DRIFT_ACCEPTED'),'substantive unstaged control changes must fail before EOL-only drift is accepted');
  assert.ok(s.includes('https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/latest') && s.includes('Invoke-WebRequest') && s.includes('Invoke-RestMethod'),'Windows stable discovery must prefer published-release redirect with REST fallback');
  assert.ok(s.includes("MCP-Protocol-Version") && s.includes("2026-07-28") && s.includes("-Headers $headers"), 'internal updater MCP calls through the canonical router must identify as the current protocol and never self-poison legacy-host continuity state');
  assert.ok(s.includes("io.modelcontextprotocol/protocolVersion") && s.includes("_meta"), 'modern updater MCP calls must mirror the protocol marker in body metadata so header/body classification cannot fail');
  assert.ok(s.includes("io.modelcontextprotocol/clientCapabilities") && s.includes("io.modelcontextprotocol/clientInfo") && s.includes("Mcp-Method") && s.includes("Mcp-Name"), 'modern updater MCP calls must satisfy the complete server-side modern client contract');


  assert.ok(s.includes('[string[]]$CommandArgs'), 'gate helper must not bind the PowerShell automatic $args variable');
  assert.ok(!s.includes('& npm.cmd @CommandArgs'), 'Windows qualification must not launch npm outside the owned Job Object');
  for(const marker of ['run-owned-process-tree-windows.ps1','qualification-job-','-TimeoutSeconds 1200','QUALIFICATION_FAILURE_RECORDED','AUTO_UPDATE_QUALIFICATION_BACKOFF','qualification-failure.json','Clear-QualificationFailure'])assert.ok(s.includes(marker),marker);
  assert.ok(s.includes("GATE_START gui-native-selftest"), 'unattended updater must run non-interactive native GUI self-test');
  assert.ok(s.includes("gui-control.ps1") && s.includes("-SelfTest"), 'GUI candidate gate must compile/validate native helper without desktop interaction');
  assert.ok(!s.includes("Run-Gate $stage.Dir 'gui-native' @('run','test:gui-native')"), 'unattended updater must not run interactive GUI E2E');
  assert.ok(!s.includes("Invoke-Mcp $port 'gui_status'"), 'candidate validation must not contend for the shared interactive GUI helper');
  assert.ok(s.includes('Stop-OwnedCandidate $currentCandidate'), 'failure cleanup must include the current pre-registration candidate');
  assert.ok(s.indexOf('$currentCandidate=[pscustomobject]') > s.indexOf('$p=Start-Backend'), 'candidate ownership tracking must start immediately after spawn');
  const startBackend=s.slice(s.indexOf('function Start-Backend'),s.indexOf('function Stop-OwnedCandidate'));
  assert.ok(startBackend.includes('Start-Process') && !startBackend.includes('-RedirectStandardOutput') && !startBackend.includes('-RedirectStandardError'),'Windows staged backends must detach from updater run_shell stdio handles');
  const stale=s.slice(s.indexOf('function Get-StaleDrainEvidence'),s.indexOf('function Get-DrainStatus'));
  for(const marker of ['activeOperations','queued','unexpectedConnections','Get-NetTCPConnection -State Established','Get-BackendDescendants','guiBusy','guiLeased','browserActive','browserBusy','browserLeased','browserUncertain','browser_status','DEFER_PROCESS_TREE'])assert.ok(stale.includes(marker),marker);
  assert.ok(stale.includes("tools\\browser-control.mjs --server") && stale.includes('$isBrowserHelper') && stale.includes('-not$result.browserActive') && stale.includes('-not$result.browserUncertain'),'idle browser helper is safe only after explicit fail-closed browser_status evidence');
  assert.ok(!stale.includes('$isIdleTerminal'),'persistent terminals must always block stale-backend retirement');
  assert.ok(stale.includes('$routerListener'),'only the canonical router connection may be ignored as transport evidence');
  assert.ok(stale.includes("Get-StaleDrainDecision"),'stale recovery must pass independent evidence into a fail-closed policy');
  assert.ok(s.includes("Start-Sleep -Milliseconds 500") && s.includes("DRAIN_STALE_RECHECK_DEFER"),'stale recovery must re-check immediately before destructive stop');
  assert.ok(s.indexOf('Get-StaleDrainEvidence $OldActive') < s.indexOf('Stop-StaleBackendTree $OldActive'),'stale evidence must precede stale-backend retirement');
  assert.ok(s.includes("Retire-PreviousRoute $Target.RoutePath $OldActive $Target.Profile"),'successful Windows drain must atomically retire route.previous');
  const retire=s.slice(s.indexOf('function Retire-PreviousRoute'),s.indexOf('function Get-DrainStatus'));
  assert.ok(retire.includes("router-retire.mjs')") && retire.includes('| Out-Null'),'router-retire diagnostic JSON must not leak into Complete-DeferredDrains pending-profile output');
  const drain=s.slice(s.indexOf('function Drain-Previous'),s.indexOf('function Complete-DeferredDrains'));
  assert.ok(drain.indexOf('Get-PersistentTerminalChildren $OldActive') < drain.indexOf('Stop-OldBackend $OldActive'),'Windows immediate retirement must check persistent terminals before old-backend stop');
  const deferred=s.slice(s.indexOf('function Complete-DeferredDrains'),s.indexOf('function Has-SupersededRelease'));
  assert.ok(deferred.indexOf('Get-PersistentTerminalChildren $old') < deferred.indexOf('Stop-OldBackend $old'),'Windows deferred retirement must check persistent terminals before every old-backend stop path');
  assert.ok(deferred.indexOf('Get-RetainableLongCommandRoots $old $canonical') < deferred.indexOf('Stop-OldBackend $old'),'Windows deferred retirement must preserve verified long command trees before any old-backend stop path');
  const currentFastPath=s.slice(s.indexOf("if(-not $Force -and $currentStatus -and [string]$currentStatus.version-eq $stage.Version)"),s.indexOf('Push-Location $stage.Dir'));
  assert.ok(currentFastPath.includes('Complete-RetainedBackends'),'already-current Windows maintenance must reconcile retained backends');
  assert.ok(currentFastPath.indexOf('Complete-RetainedBackends') < currentFastPath.indexOf('Complete-DeferredDrains'),'retained-backend reconciliation must precede deferred-drain handling in current fast path');
  assert.ok(currentFastPath.indexOf('Complete-RetainedBackends') < currentFastPath.lastIndexOf('$cleanupPending=@(Cleanup-Releases)'),'retained-backend reconciliation must precede release cleanup so dead retained releases are not protected forever');
  const maintenance=s.slice(s.indexOf('$controlMismatch=($controlHead-ne $stage.Commit)'),s.indexOf('Push-Location $stage.Dir'));
  assert.ok(maintenance.includes("if($controlMismatch)") && maintenance.includes('Recycle-ControlSupervisor'),'control-code promotion may recycle the supervisor');
  const cleanupOnly=maintenance.slice(maintenance.lastIndexOf('$cleanupPending=@(Cleanup-Releases)'));
  assert.ok(cleanupOnly.includes("AUTO_UPDATE_CLEANUP_PENDING") && !cleanupOnly.includes('Recycle-ControlSupervisor'),'release cleanup alone must never recycle a healthy supervisor');
  assert.ok(!s.includes('[string[]]$Args'), 'reserved automatic $args name must not be used as a gate parameter');
  assert.ok(s.includes("Get-ChildItem -LiteralPath $InstanceRoot -Directory"), 'target discovery must enumerate only immediate profile directories');
  assert.ok(s.includes("Join-Path $profileDir.FullName 'instance.json'"), 'target discovery must bind only each profile directory instance record');
  assert.ok(!s.includes("Get-ChildItem -LiteralPath $InstanceRoot -Filter 'instance.json' -Recurse"), 'target discovery must never recurse into instance backups');
  assert.ok(s.includes('PROFILE_DIRECTORY_MISMATCH'), 'profile directory identity must fail closed');
  assert.ok(s.includes("AUTO_UPDATE_DRAIN_PENDING profiles=") && s.includes("AUTO_UPDATE_PROFILE_DEFER profiles="),'Windows committed cutover must preserve both post-cutover drains and independently deferred profiles');
  assert.ok(s.includes('DRAIN_TERMINAL_RETAINED') && s.includes('Get-ProtectedReleasePaths') && s.includes('Complete-RetainedBackends'),'Windows terminal keeper must durably detach zero-inflight previous backends and protect their release trees');
  assert.ok(s.includes('Get-RetainableLongCommandRoots') && s.includes('DRAIN_COMMAND_RETAINED'),'Windows updater must detach verified long-running command backends instead of blocking future generations');
  const longCommand=s.slice(s.indexOf('function Get-RetainableLongCommandRoots'),s.indexOf('function Get-StaleDrainEvidence'));
  for(const marker of ["rpcMethod-eq'tools/call'","run_shell","run_project_command","cancellable-ne$true","-noninteractive","age-lt60"])assert.ok(longCommand.includes(marker),marker);
  assert.ok(longCommand.includes('if($found.Count-ne$st.count){return @()}'),'long-command retention must map every non-cancellable command request to exactly one direct owned command root');
  const retainWork=s.slice(s.indexOf('function Retain-PreviousBackend'),s.indexOf('function Test-ProfileName'));
  assert.ok(retainWork.includes('Get-TerminalRetentionEvidence $Old $Canonical $RetentionRoots'),'retention evidence must use the provided retention roots');
  assert.ok(!retainWork.includes('$TerminalChildren'),'generic retained-work path must not fall back to the legacy terminal-only variable');


  assert.ok(s.includes('Get-TerminalRetentionEvidence') && s.includes('DRAIN_TERMINAL_STALE_ROUTER_ACCOUNTING'),'Windows terminal keeper must detach stale router accounting only after independent backend-idle evidence');
  const retainEvidence=s.slice(s.indexOf('function Get-TerminalRetentionEvidence'),s.indexOf('function Stop-StaleBackendTree'));
  for(const marker of ['activeOperations','queued','unexpectedConnections','guiBusy','guiLeased','browserActive','browserBusy','browserLeased','browserUncertain','browser_status','allowedRoots','unsafeDescendants','Get-StaleDrainDecision'])assert.ok(retainEvidence.includes(marker),marker);
  assert.ok(retainEvidence.includes("tools\\browser-control.mjs --server") && retainEvidence.includes('-not$result.browserActive') && retainEvidence.includes('allowedRoots[[int]$p.ProcessId]=$true'),'retained-work evidence may root only an explicitly idle browser helper');
  assert.ok(s.includes('DRAIN_TERMINAL_RETAIN_RECHECK_DEFER') && s.includes('Start-Sleep -Milliseconds 500'),'terminal retention must re-check safety immediately before route detachment');
  assert.ok(s.includes("Run-Gate $stage.Dir 'check' @('run','check:qualification')"),'Windows updater qualification CHECK must bound Node test-file concurrency');
  assert.ok(s.includes('$runtimeLeaf="port-$port"') && s.includes("Join-Path $t.Profile $runtimeLeaf"),'Windows candidate runtime state must be unique per candidate port so ownership markers cannot be overwritten by later same-commit runs');
  assert.ok(s.includes('AUTO_UPDATE_PROFILE_CURRENT_SKIP') && s.includes('$explicitProfileMutation'),'already-current independent profiles must not churn candidates during another profile drain unless an explicit mutation was requested');
  assert.ok(retainEvidence.includes("tools\\gui-control.ps1 -server") && retainEvidence.includes("allowedRoots[[int]$p.ProcessId]=$true"),'idle GUI helper subtree must be explicitly rooted before descendant traversal');
  assert.ok(s.includes("if($last.ok -and $last.count-gt 0 -and $last.cancellableOnly)"),'Windows may cancel only explicitly classified long-lived requests');
  assert.ok(s.indexOf('AUTO_UPDATE_NEWER_CURRENT') < s.indexOf("Run-Gate $stage.Dir 'check'"), 'automatic downgrade guard must precede candidate gates/cutover');
  const cutover=s.indexOf('if(Test-Path $t.RoutePath)');
  const existingDrainAdmission=s.indexOf('$existingDrainBlocks=@(Complete-DeferredDrains)');
  const terminalAdmission=s.indexOf('$terminalPreserve=@()');
  assert.ok(existingDrainAdmission>0 && existingDrainAdmission<terminalAdmission,'unresolved previous drain must be handled before active-terminal admission');
  const existingDrainBlock=s.slice(existingDrainAdmission,terminalAdmission);
  assert.ok(existingDrainBlock.includes('Where-Object{$_.Profile-eq$profile}') && existingDrainBlock.includes('AUTO_UPDATE_EXISTING_DRAIN_DEFER') && existingDrainBlock.includes('if($candidates.Count-eq0)'),'Windows existing-drain admission must defer only affected profiles and globally block only when none remain');
  assert.ok(terminalAdmission>0 && terminalAdmission<cutover,'persistent terminal admission must run before Windows route cutover');
  const terminalAdmissionBlock=s.slice(terminalAdmission,cutover);
  assert.ok(terminalAdmissionBlock.includes('AUTO_UPDATE_ACTIVE_TERMINALS_PRESERVE') && !terminalAdmissionBlock.includes('Stop-OwnedCandidate'),'Windows active terminals must be preserved through cutover rather than block or kill their profile');
  assert.ok(s.indexOf("Run-Gate $stage.Dir 'check'") < cutover, 'gates must precede cutover');
  assert.ok(s.indexOf('Verify-Tunnels') < s.indexOf('$cutoverCommitted=$true'), 'tunnels verified before commit point');
  const commitPoint=s.indexOf('$cutoverCommitted=$true');
  assert.ok(commitPoint>0 && s.indexOf('finalize-workflow-schema.mjs',commitPoint)>commitPoint, 'schema finalizes only after cutover commit in the main promotion path');
});

test('Windows control promotion classifier distinguishes historical CRLF drift from substantive or staged mutation',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-control-eol-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const git=args=>spawnSync('git',args,{cwd:dir,encoding:'utf8'});
  assert.equal(git(['init','-q']).status,0);
  assert.equal(git(['config','user.name','RC Test']).status,0);
  assert.equal(git(['config','user.email','rc-test@example.invalid']).status,0);
  const script=path.join(dir,'legacy.ps1');
  fs.writeFileSync(path.join(dir,'.gitattributes'),'*.ps1 text eol=crlf\n','utf8');
  assert.equal(git(['add','.gitattributes']).status,0);
  assert.equal(git(['commit','-qm','attributes']).status,0);
  fs.writeFileSync(script,'one\r\ntwo\r\n','utf8');
  const blob=git(['hash-object','-w','--no-filters','legacy.ps1']);
  assert.equal(blob.status,0);
  assert.match(blob.stdout.trim(),/^[0-9a-f]{40,64}$/);
  assert.equal(git(['update-index','--add','--cacheinfo',`100644,${blob.stdout.trim()},legacy.ps1`]).status,0);
  assert.equal(git(['commit','-qm','historical-crlf-blob']).status,0);
  const dirty=git(['status','--porcelain','--untracked-files=no']);
  assert.equal(dirty.status,0);
  assert.match(dirty.stdout,/legacy\.ps1/,'fixture must reproduce historical CRLF dirty status');
  assert.equal(git(['diff','--cached','--quiet','--']).status,0,'EOL-only fixture must have no staged mutation');
  assert.equal(git(['diff','--ignore-space-at-eol','--exit-code','--']).status,0,'EOL-only fixture must be accepted by content classifier');

  fs.appendFileSync(script,'three\r\n','utf8');
  assert.notEqual(git(['diff','--ignore-space-at-eol','--exit-code','--']).status,0,'substantive unstaged mutation must remain blocked');
  assert.equal(git(['restore','--worktree','--','legacy.ps1']).status,0);
  fs.appendFileSync(path.join(dir,'.gitattributes'),'# staged\n','utf8');
  assert.equal(git(['add','.gitattributes']).status,0);
  assert.notEqual(git(['diff','--cached','--quiet','--']).status,0,'staged mutation must remain blocked');
});

test('Linux control promotion accepts CR-at-EOL-only drift but blocks staged or substantive mutation',t=>{
  const updater=read('auto-update-linux.sh');
  const promote=updater.slice(updater.indexOf('promote_control(){'),updater.indexOf('install_linux_gui_backend(){'));
  assert.ok(promote.includes("git -C \"$INSTALL_DIR\" diff --cached --quiet --"),'Linux promotion must fail closed on staged mutation');
  assert.ok(promote.includes("git -C \"$INSTALL_DIR\" diff --ignore-cr-at-eol --quiet --"),'Linux promotion may tolerate only CR-at-EOL working-tree drift');
  assert.ok(promote.includes("CONTROL_EOL_DRIFT_TOLERATED"),'accepted historical EOL drift must be auditable');
  assert.ok(promote.includes("CONTROL_TRACKED_DIRTY_BLOCK reason=staged"),'staged dirtiness must be auditable');
  assert.ok(promote.includes("CONTROL_TRACKED_DIRTY_BLOCK reason=substantive"),'substantive dirtiness must be auditable');
  assert.ok(promote.includes("CONTROL_PROMOTION_PASS commit=$commit"),'promotion must verify and record the exact commit');

  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-linux-control-eol-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const git=args=>spawnSync('git',args,{cwd:dir,encoding:'utf8'});
  assert.equal(git(['init','-q']).status,0);
  assert.equal(git(['config','user.name','RC Test']).status,0);
  assert.equal(git(['config','user.email','rc-test@example.invalid']).status,0);
  const script=path.join(dir,'legacy.ps1');
  fs.writeFileSync(path.join(dir,'.gitattributes'),'*.ps1 text eol=crlf\n','utf8');
  assert.equal(git(['add','.gitattributes']).status,0);
  assert.equal(git(['commit','-qm','attributes']).status,0);
  fs.writeFileSync(script,'one\r\ntwo\r\n','utf8');
  const blob=git(['hash-object','-w','--no-filters','legacy.ps1']);
  assert.equal(blob.status,0);
  assert.equal(git(['update-index','--add','--cacheinfo',`100644,${blob.stdout.trim()},legacy.ps1`]).status,0);
  assert.equal(git(['commit','-qm','historical-crlf-blob']).status,0);
  assert.match(git(['status','--porcelain','--untracked-files=no']).stdout,/legacy\.ps1/);
  assert.equal(git(['diff','--cached','--quiet','--']).status,0);
  assert.equal(git(['diff','--ignore-cr-at-eol','--quiet','--']).status,0,'CRLF-only drift must be tolerated');

  fs.appendFileSync(script,'three\r\n','utf8');
  assert.notEqual(git(['diff','--ignore-cr-at-eol','--quiet','--']).status,0,'substantive unstaged mutation must be blocked');
  assert.equal(git(['restore','--worktree','--','legacy.ps1']).status,0);
  fs.appendFileSync(path.join(dir,'.gitattributes'),'# staged\n','utf8');
  assert.equal(git(['add','.gitattributes']).status,0);
  assert.notEqual(git(['diff','--cached','--quiet','--']).status,0,'staged mutation must be blocked');
});



test('Linux updater writes an atomic durable completion receipt',t=>{
  const updater=read('auto-update-linux.sh');
  const start=updater.indexOf('write_update_result(){');
  const end=updater.indexOf('wait_health(){',start);
  assert.ok(start>0 && end>start,'write_update_result must be a standalone helper');
  const fn=updater.slice(start,end);
  for(const marker of ['last-update.json','.tmp-','fs.renameSync','completedAt',"platform: 'linux'"]) assert.ok(fn.includes(marker)||updater.includes(marker),marker);
  assert.ok(updater.includes('write_update_result maintenance_pass "$VERSION" "$COMMIT" "$REF"'),'maintenance PASS must persist a receipt before logging PASS');
  assert.ok(updater.includes('write_update_result pass "$VERSION" "$COMMIT" "$REF"'),'normal PASS must persist a receipt before logging PASS');
  if(process.platform==='win32'){t.skip('Linux shell fixture requires a native POSIX Bash environment');return;}

  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'rc-update-result-'));
  t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  const resultFile=path.join(fixture,'state','last-update.json');
  const harness=path.join(fixture,'receipt.sh');
  fs.writeFileSync(harness,[
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'RESULT_FILE="$1"; shift',
    fn,
    'write_update_result "$1" "$2" "$3" "$4"'
  ].join('\n'));
  fs.chmodSync(harness,0o755);
  const commit='a'.repeat(40);
  const run=spawnSync('bash',[harness,resultFile,'pass','0.10.14',commit,'fix/linux-control-promotion-v01014'],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr||run.stdout);
  const receipt=JSON.parse(fs.readFileSync(resultFile,'utf8'));
  assert.deepEqual({
    schema:receipt.schema,
    platform:receipt.platform,
    status:receipt.status,
    version:receipt.version,
    commit:receipt.commit,
    sourceRef:receipt.sourceRef
  },{
    schema:1,
    platform:'linux',
    status:'pass',
    version:'0.10.14',
    commit,
    sourceRef:'fix/linux-control-promotion-v01014'
  });
  assert.match(receipt.completedAt,/^\d{4}-\d{2}-\d{2}T/);
  assert.equal(fs.statSync(resultFile).mode & 0o777,0o600);
  assert.equal(fs.readdirSync(path.dirname(resultFile)).filter(x=>x.includes('.tmp-')).length,0,'atomic temp file must not remain');

  const bad=spawnSync('bash',[harness,resultFile,'pass','0.10.14','not-a-commit','fix/linux-control-promotion-v01014'],{encoding:'utf8'});
  assert.notEqual(bad.status,0,'invalid completion identity must fail closed');
  assert.equal(JSON.parse(fs.readFileSync(resultFile,'utf8')).commit,commit,'failed rewrite must preserve prior durable receipt');
});

test('Linux updater atomically syncs an installed Work plugin while preserving its app binding',
  { skip: process.platform !== 'linux' ? 'Linux-only updater executable fixture' : false },
  t=>{
  const updater=read('auto-update-linux.sh');
  const start=updater.indexOf('sync_work_plugin_projection(){');
  const end=updater.indexOf('cleanup_releases(){',start);
  assert.ok(start>0 && end>start,'sync_work_plugin_projection must be a standalone updater function');
  const fn=updater.slice(start,end);
  for(const marker of ['WORK_PLUGIN_SOURCE_SYNC_PASS','WORK_PLUGIN_SOURCE_SYNC_SKIP','WORK_PLUGIN_SOURCE_SYNC_BLOCK','sha256sum','mv -T -- "$plugin_root" "$retired"']) assert.ok(fn.includes(marker),marker);
  if(process.platform==='win32'){t.skip('Linux shell fixture requires a native POSIX Bash environment');return;}

  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'rc-work-plugin-sync-'));
  t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  const project=path.join(fixture,'candidate');
  const template=path.join(project,'plugin-template');
  const data=path.join(fixture,'data');
  const backup=path.join(fixture,'backups');
  const pluginRoot=path.join(data,'ChatGPTRemoteCommander','work-plugin','marketplace','plugins','chatgpt-remote-commander');
  fs.mkdirSync(path.join(template,'.codex-plugin'),{recursive:true});
  fs.mkdirSync(pluginRoot,{recursive:true});
  fs.writeFileSync(path.join(template,'plugin.json'),JSON.stringify({
    $schema:'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name:'chatgpt-remote-commander',
    version:'0.10.14',
    extensions:{'com.openai':{interface:{displayName:'Remote Commander',shortDescription:'old'}}}
  },null,2)+'\n');
  fs.writeFileSync(path.join(template,'.codex-plugin','plugin.json'),JSON.stringify({
    name:'chatgpt-remote-commander',
    version:'0.10.14'
  },null,2)+'\n');
  fs.writeFileSync(path.join(template,'payload.txt'),'candidate\n');
  fs.writeFileSync(path.join(pluginRoot,'plugin.json'),JSON.stringify({name:'chatgpt-remote-commander',version:'0.10.4'})+'\n');
  fs.writeFileSync(path.join(pluginRoot,'.app.json'),JSON.stringify({
    apps:{'remote-commander':{id:'asdk_app_TEST_BINDING_123',required:true}}
  },null,2)+'\n');
  const originalApp=fs.readFileSync(path.join(pluginRoot,'.app.json'));

  const harness=path.join(fixture,'sync.sh');
  fs.writeFileSync(harness,[
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'log(){ printf "%s\\n" "$*"; }',
    'BACKUP_ROOT="$1"; shift',
    fn,
    'sync_work_plugin_projection "$1" "$2" "$3"'
  ].join('\n'));
  fs.chmodSync(harness,0o755);

  const commit='a'.repeat(40);
  const result=spawnSync('bash',[harness,backup,project,'0.10.14',commit],{
    encoding:'utf8',
    env:{...process.env,XDG_DATA_HOME:data}
  });
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.match(result.stdout,/WORK_PLUGIN_SOURCE_BACKUP_PASS/);
  assert.match(result.stdout,/WORK_PLUGIN_SOURCE_SYNC_PASS version=0\.10\.14/);
  assert.deepEqual(fs.readFileSync(path.join(pluginRoot,'.app.json')),originalApp,'app binding bytes must be preserved exactly');
  const portable=JSON.parse(fs.readFileSync(path.join(pluginRoot,'plugin.json'),'utf8'));
  const native=JSON.parse(fs.readFileSync(path.join(pluginRoot,'.codex-plugin','plugin.json'),'utf8'));
  assert.equal(portable.version,'0.10.14');
  assert.equal(native.version,'0.10.14');
  assert.equal(portable.extensions['com.openai'].apps,'./.app.json');
  assert.equal(portable.extensions['com.openai'].interface.displayName,'ChatGPT Remote Commander (Personal)');
  assert.equal(portable.extensions['com.openai'].interface.shortDescription,'Use your registered Remote Commander app');
  assert.equal(native.apps,'./.app.json');
  assert.equal(fs.readFileSync(path.join(pluginRoot,'payload.txt'),'utf8'),'candidate\n');
  assert.ok(fs.existsSync(path.join(backup,commit,'work-plugin','chatgpt-remote-commander','plugin.json')),'prestate backup must exist');

  const absentData=path.join(fixture,'absent-data');
  const absent=spawnSync('bash',[harness,backup,project,'0.10.14',commit],{
    encoding:'utf8',
    env:{...process.env,XDG_DATA_HOME:absentData}
  });
  assert.equal(absent.status,0,absent.stderr||absent.stdout);
  assert.match(absent.stdout,/WORK_PLUGIN_SOURCE_SYNC_SKIP reason=not-installed/);

  const badData=path.join(fixture,'bad-data');
  const badRoot=path.join(badData,'ChatGPTRemoteCommander','work-plugin','marketplace','plugins','chatgpt-remote-commander');
  fs.mkdirSync(badRoot,{recursive:true});
  fs.writeFileSync(path.join(badRoot,'plugin.json'),'{"version":"0.10.4"}\n');
  fs.writeFileSync(path.join(badRoot,'.app.json'),'{"apps":{"remote-commander":{"id":"not-a-valid-app-id"}}}\n');
  const beforeBad=fs.readFileSync(path.join(badRoot,'plugin.json'),'utf8');
  const bad=spawnSync('bash',[harness,backup,project,'0.10.14','b'.repeat(40)],{
    encoding:'utf8',
    env:{...process.env,XDG_DATA_HOME:badData}
  });
  assert.notEqual(bad.status,0,'malformed binding must fail closed');
  assert.equal(fs.readFileSync(path.join(badRoot,'plugin.json'),'utf8'),beforeBad,'failed validation must not mutate installed plugin');
});

test('stable router and supervisor preserve canonical ports while backends are versioned',()=>{
  const router=read('src/stable-router.mjs'),switcher=read('tools/router-switch.mjs'),sup=read('supervisor-routing.ps1'),main=read('autostart-windows.ps1');
  for(const marker of ['ROUTER_GENERATION_CONFLICT','inflightByPort','inflightDetailsByPort','cancellable','subscriptions/listen','127.0.0.1','active.port'])assert.ok(router.includes(marker),marker);
  assert.ok(switcher.includes('ROUTER_PREVIOUS_NOT_DRAINED'),'router switch must fail closed while any previous generation remains');
  assert.ok(switcher.indexOf('current.previous') < switcher.indexOf("fetch('http://127.0.0.1:'"),'previous-generation guard must run before candidate switch I/O');
  for(const marker of [
    'Get-RouteState','Start-RoutedBackend','Start-RouterForRoute','Ensure-RoutedProfile','Start-AutoUpdateIfDue',
    'Get-RouterStatusSafe','Get-RouterBackendActivity','Get-RoutedBackendRecoveryDecision',
    'RoutedBackendHealthFailureThreshold','DEFER_BUSY','DEFER_TRANSIENT','DEFER_UNPROVEN',
    'ROUTED_BACKEND_RECYCLE_$decision','ROUTED_BACKEND_RECYCLE_CONFIRMED',
    'ROUTER_SOURCE_ACTIVATION_DEFERRED','Get-FileHash','sourceSha256'
  ])assert.ok(sup.includes(marker),marker);
  assert.ok(sup.includes('Start-RoutedBackend $route $CanonicalPort'),'backend recovery must inspect the canonical router before any recycle');
  const routerStart=sup.slice(sup.indexOf('function Start-RouterForRoute'),sup.indexOf('function Ensure-RoutedProfile'));
  assert.ok(!routerStart.includes('Stop-OwnedRouter'),'live source drift must not create a canonical-listener gap');
  assert.ok(main.includes(". (Join-Path $Root 'supervisor-routing.ps1')"));
  assert.ok(main.includes("Ensure-RoutedProfile 'default' 47831"));
});

test('Windows routed-backend recovery is thresholded and fail-closed around live work',()=>{
  const sup=read('supervisor-routing.ps1');
  const decision=sup.slice(sup.indexOf('function Get-RoutedBackendRecoveryDecision'),sup.indexOf('function Stop-OwnedRouter'));
  assert.ok(decision.indexOf("DEFER_UNPROVEN") < decision.indexOf("RECYCLE"));
  assert.ok(decision.indexOf("DEFER_BUSY") < decision.indexOf("RECYCLE"));
  assert.ok(decision.indexOf("DEFER_TRANSIENT") < decision.indexOf("RECYCLE"));
  const backend=sup.slice(sup.indexOf('function Start-RoutedBackend'),sup.indexOf('function Start-RouterForRoute'));
  assert.ok(backend.includes('Start-Sleep -Milliseconds 500'),'recycle must include a final recovery probe');
  assert.ok(backend.includes('$finalDecision=Get-RoutedBackendRecoveryDecision $false $misses $activity.Known $activity.Count $activity.OldestAgeMs'),'final recycle gate must recompute recovery from freshly re-read router activity');
  const activityChecks=[...backend.matchAll(/Get-RouterBackendActivity/g)].map(match=>match.index);
  assert.ok(activityChecks.length>=2,'routed backend recycle must re-read router activity immediately before destructive stop');
  assert.ok(activityChecks.at(-1) < backend.indexOf('Stop-OwnedRoutedBackend'),'fresh activity proof must precede destructive stop');
  assert.ok(backend.includes("if($finalDecision -notmatch '^RECYCLE')"),'fresh activity decision must fail closed unless recycle remains authorized');
});

test('installer delegates existing installations to candidate updater instead of in-place source mutation',()=>{
  const s=read('install.ps1');
  assert.ok(s.includes('Invoke-ExistingSafeUpdate'));
  assert.ok(s.includes("candidate-first update failed"));
  const main=s.indexOf('$existingInstall = Test-Path');
  const branch=s.indexOf('Invoke-ExistingSafeUpdate',main);
  const install=s.indexOf('Install-Source',main);
  assert.ok(main>0 && branch>main && install>branch);
});

test('Full Power means all known capabilities unless disabled explicitly',()=>{
  const s=read('src/capability-profile.mjs');
  for(const marker of ['autoEnableNewCapabilities','disabledCapabilities','filesystem.permanent_delete','shell.unrestricted','lifecycle.auto_update','lifecycle.zero_downtime_update'])assert.ok(s.includes(marker),marker);
  assert.ok(s.includes("next.powerMode.allowPermanentDelete = on('filesystem.permanent_delete')"));
  assert.ok(s.includes("next.powerMode.blockedShellPatterns = on('shell.unrestricted') ? []"));
});

test('public installation opts into stable automatic updates',()=>{
  const c=JSON.parse(read('config.json'));
  assert.equal(c.autoUpdate.enabled,true);
  assert.equal(c.autoUpdate.zeroDowntime,true);
  assert.equal(c.autoUpdate.channel,'stable');
  assert.ok(Number.isInteger(c.autoUpdate.intervalMinutes)&&c.autoUpdate.intervalMinutes>0);
});



test('Windows updater shell qualification satisfies mutation request identity',()=>{
  const s=read('auto-update-windows.ps1');
  assert.ok(s.includes('requestId=("autoupdate-shell-{0}-{1}" -f $t.Profile,$port)'),'Windows candidate run_shell canary must use a stable per-candidate requestId');
});

test('hardware selftest supplies stable requestIds to direct mutations',()=>{
  const s=read('tools/hardware-selftest.mjs');
  assert.ok(s.includes("requestId:selftestRequestId('run-shell')"),'run_shell selftest must satisfy mutation idempotency contract');
  assert.ok(s.includes("requestId:selftestRequestId('browser-begin')"),'browser_session_begin selftest must satisfy mutation idempotency contract');
  assert.ok(s.includes("requestId:selftestRequestId('browser-end')"),'browser_session_end selftest must satisfy mutation idempotency contract');
  assert.ok(s.includes('hardware-selftest-${process.pid}-${label}'),'selftest request IDs must be unique per process and stable per intent');
});

test('Linux updater is candidate-first, hardware-gated, routed and rollback-aware',()=>{
  const s=read('auto-update-linux.sh');
  for(const marker of [
    'stage_release',
    'run_gate "$STAGE_DIR" check npm run check:qualification',
    'run_gate "$STAGE_DIR" test npm run test:qualification',
    'run_gate "$STAGE_DIR" audit npm run audit',
    'copy-workflow-store.mjs',
    'workflow-shadow',
    'hardware-selftest.mjs',
    'router-switch.mjs',
    'router-init.mjs',
    'tunnels_ready',
    'CUTOVER_COMMITTED=1',
    'finalize-workflow-schema.mjs',
    'promote_control',
    'recycle_supervisor',
    'cleanup_releases',
    'RELEASE_CLEANUP_DEFER',
    'AUTO_UPDATE_CLEANUP_PENDING',
    'AUTO_UPDATE_POST_COMMIT_MAINTENANCE_REQUIRED',
    'AUTO_UPDATE_DRAIN_PENDING',
    'DRAIN_PERSISTENT_TERMINAL_DEFER',
    'drain_previous_once',
    'retire_previous_route',
    'router-retire.mjs',
    'ROUTER_PREVIOUS_RETIRED',
    'cancellableOnly',
    'AUTO_UPDATE_NEWER_CURRENT',
    'version_gt',
    'stop_owned_candidate',
    'validation_cleanup',
    'trap validation_cleanup ERR',
    'persistent_terminal_pids',
    'AUTO_UPDATE_ACTIVE_TERMINALS_PRESERVE',
    'DRAIN_TERMINAL_RETAINED',
    'retained-backends.json',
    'retained-backends.mjs',
    'RELEASE_CLEANUP_RETAINED_PROTECT',
    'AUTO_UPDATE_EXISTING_DRAIN_BLOCK',
    'https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/latest',
    '%{url_effective}',
    'install_linux_gui_backend',
    'LINUX_GUI_BACKEND_SYNCED',
    'sync_work_plugin_projection',
    'WORK_PLUGIN_SOURCE_SYNC_PASS',
    'WORK_PLUGIN_SOURCE_SYNC_SKIP',
    'updater_has_commander_backend_ancestor',
    'detach_from_commander_backend_if_needed',
    'AUTO_UPDATE_SELF_DETACH_REQUESTED',
    'AUTO_UPDATE_SELF_DETACH_BLOCK',
    'REMOTE_COMMANDER_AUTO_UPDATE_DETACHED',
    'setsid -f',
    '/snap/bin/geckodriver',
    '/usr/bin/geckodriver',
    '/usr/local/bin/geckodriver',
    '"$HOME/.local/bin/geckodriver"'
  ]) assert.ok(s.includes(marker),marker);
  assert.ok(s.includes('build_cfg "$DIAG_CFG" "$SHADOW_WF" shadow'),'Linux diagnostic candidate must use an isolated delivery shadow');
  assert.ok(s.includes('build_cfg "$FINAL_CFG" "$LIVE_WF" preserve'),'Linux final candidate must preserve active delivery identity');
  assert.ok(s.includes('--delivery-directory "$BACKUP_ROOT/$COMMIT/default/delivery-shadow-$PORT"'),'Linux diagnostic delivery directory must stay inside candidate backup state');
  assert.ok(s.includes('--delivery-scope "diagnostic-${COMMIT:0:32}-$PORT"'),'Linux diagnostic delivery scope must be explicit and per-candidate');
  assert.ok(s.indexOf('driver="$(command -v geckodriver') < s.indexOf('/snap/bin/geckodriver'),'Linux updater must prefer PATH geckodriver before explicit safe fallbacks');
  const detachFn=s.slice(s.indexOf('updater_has_commander_backend_ancestor(){'),s.indexOf('wait_health(){'));
  assert.ok(detachFn.includes('depth" -lt 16'),'Linux updater ancestry detection must be bounded');
  assert.ok(detachFn.includes('$STATE_ROOT/releases/') && detachFn.includes('$INSTALL_DIR'),'Linux updater detach must recognize only managed Commander backend roots');
  assert.ok(detachFn.includes('[[ "$SELF_TEST" == 1 ]] && return 0'),'Linux updater self-test must never detach');
  assert.ok(s.indexOf('detach_from_commander_backend_if_needed') < s.indexOf('exec 9>"$STATE_ROOT/auto-update.lock"'),'Linux updater must detach from a Commander backend before taking the update lock');
  assert.ok(s.includes('nohup setsid -f env REMOTE_COMMANDER_AUTO_UPDATE_DETACHED=1 /bin/bash "$SELF_PATH" "${ORIGINAL_ARGS[@]}"'),'Linux updater must preserve exact arguments while escaping the retiring backend process tree');

  assert.ok(!s.includes('git ls-remote --tags --refs'),'Linux stable discovery must never promote a raw tag without a published Release');
  assert.ok(s.includes("log 'AUTO_UPDATE_DRAIN_PENDING profile=default'"),'Linux committed cutover must defer unsafe drains');
  assert.ok(s.includes('drain_previous_once "$STAGE_DIR" "$OLD_PORT"'), 'Linux drain must use conservative shared policy');
  assert.ok(s.includes('retire_previous_route "$helper" "$old_port"'), 'Linux successful drain must atomically retire route.previous');
  const linuxDrain=s.slice(s.indexOf('drain_previous_once(){'),s.indexOf('has_superseded_release(){'));
  assert.ok(linuxDrain.indexOf('persistent_terminal_pids') < linuxDrain.indexOf('stop_owned_from_config'),'Linux retirement must check persistent terminals before stopping the old backend');
  assert.ok(linuxDrain.includes('retain_previous_backend'),'Linux terminal-bearing previous backends must use retained-backend detachment instead of forced stop');
  const currentMaintenance=s.slice(s.indexOf('if [[ "$CONTROL" != "$COMMIT" ]]; then'),s.indexOf('CANDIDATE_PID=""'));
  const cleanupOnlyLinux=currentMaintenance.slice(currentMaintenance.indexOf('if has_superseded_release; then'));
  assert.ok(currentMaintenance.includes('recycle_supervisor'),'Linux control-code promotion may recycle the supervisor');
  assert.ok(currentMaintenance.includes('install_linux_gui_backend "$STAGE_DIR" "$ACTIVE_CFG"'),'Linux control-code maintenance must synchronize the GUI backend before recycle');
  assert.ok(currentMaintenance.includes('sync_work_plugin_projection "$STAGE_DIR" "$VERSION" "$COMMIT"'),'Linux control-code maintenance must synchronize the Work plugin projection before recycle');
  assert.ok(cleanupOnlyLinux.includes("AUTO_UPDATE_CLEANUP_PENDING") && !cleanupOnlyLinux.includes('recycle_supervisor'),'Linux release cleanup alone must never recycle a healthy supervisor');
  assert.ok(s.includes('stop_owned_candidate "$CANDIDATE_PID" "$STAGE_DIR"'), 'Linux validation failures must clean the exact spawned candidate');
  assert.ok(s.indexOf('trap validation_cleanup ERR') < s.indexOf('CANDIDATE_PID="$(start_backend'), 'Linux validation cleanup trap must be installed before candidate spawn');
  assert.ok(s.indexOf('AUTO_UPDATE_NEWER_CURRENT') < s.indexOf('run_gate "$STAGE_DIR" check npm run check:qualification'),'Linux automatic downgrade guard must precede gates/cutover');
  const gates=s.indexOf('run_gate "$STAGE_DIR" check npm run check:qualification');
  const cutover=s.lastIndexOf('if [[ -f "$ROUTE" ]]');
  const existingDrainAdmission=s.indexOf('EXISTING_PREV_PORT="$(json_field');
  const terminalAdmission=s.indexOf('TERMINAL_PIDS="$(persistent_terminal_pids');
  assert.ok(existingDrainAdmission>0 && existingDrainAdmission<terminalAdmission,'Linux unresolved previous drain must be handled before active-terminal admission');
  assert.ok(s.slice(existingDrainAdmission,terminalAdmission).includes("AUTO_UPDATE_EXISTING_DRAIN_BLOCK"),'Linux existing-drain blocker must exit before route mutation');
  assert.ok(terminalAdmission>0 && terminalAdmission<cutover,'Linux persistent terminal admission must run before route cutover');
  assert.ok(s.slice(terminalAdmission,cutover).includes('AUTO_UPDATE_ACTIVE_TERMINALS_PRESERVE'),'Linux active terminals must be explicitly preserved before route cutover');
  assert.ok(!s.slice(terminalAdmission,cutover).includes('AUTO_UPDATE_PERSISTENT_TERMINAL_BLOCK'),'Linux active terminals must not block a validated cutover');
  const commit=s.indexOf('CUTOVER_COMMITTED=1');
  assert.ok(gates>0 && cutover>gates,'Linux gates precede cutover');
  assert.ok(s.indexOf('tunnels_ready',cutover)<commit,'Linux tunnel verification precedes commit point');
  assert.ok(s.indexOf('finalize-workflow-schema.mjs',commit)>commit,'Linux schema finalization follows commit point');
  const postCommit=s.slice(commit,s.indexOf('log "AUTO_UPDATE_PASS version=',commit));
  assert.ok(!postCommit.includes('trap - ERR'),'Linux post-commit maintenance must retain the ERR trap so failures are durably classified');
  assert.ok(s.includes("AUTO_UPDATE_POST_COMMIT_MAINTENANCE_REQUIRED"),'Linux post-commit maintenance failure must be explicitly logged');
  assert.ok(s.includes("systemctl --user restart --no-block chatgpt-remote-commander.service"), 'Linux systemd recycle must be asynchronous so the updater can finish its own cgroup work');
  assert.ok(s.includes('src/server-v0.3.mjs 9>&-'), 'Linux promoted backend must close inherited updater lock descriptor');
  assert.ok(s.includes('src/stable-router.mjs --listen-port 47831') && s.includes('9>&- >>"$log_file"'), 'Linux stable router must close inherited updater lock descriptor');
  assert.ok(s.includes('install_linux_gui_backend "$STAGE_DIR" "$FINAL_CFG"'),'Linux promotion must synchronize the GUI backend before control promotion');
  assert.ok(s.includes('sync_work_plugin_projection "$STAGE_DIR" "$VERSION" "$COMMIT"'),'Linux promotion must synchronize the Work plugin projection before durable PASS');
  const finalPromote=s.lastIndexOf('promote_control "$COMMIT" "$REF"');
  const finalCleanup=s.indexOf('cleanup_releases',finalPromote);
  const finalPass=s.indexOf('AUTO_UPDATE_PASS version=',finalCleanup);
  const finalRecycle=s.indexOf('recycle_supervisor',finalPass);
  assert.ok(finalPromote>0 && finalCleanup>finalPromote && finalPass>finalCleanup && finalRecycle>finalPass, 'Linux cleanup and durable PASS log must precede self-cgroup supervisor restart');
  const maintenance=s.indexOf('AUTO_UPDATE_MAINTENANCE_PASS version=');
  assert.ok(maintenance>0 && s.lastIndexOf('cleanup_releases',maintenance)<maintenance && s.indexOf('recycle_supervisor',maintenance)>maintenance, 'Linux maintenance pass must be durable before supervisor restart request');
});

test('Linux supervisor recovers routed backend/router and schedules automatic updates',()=>{
  const sup=read('supervisor-routing-linux.sh'),main=read('autostart-linux.sh');
  for(const marker of ['ensure_routed_default','start_routed_backend','start_router_default','start_auto_update_if_due','AUTO_UPDATE_CHECK_STARTED','router_source_sha','ROUTER_SOURCE_ACTIVATION_DEFERRED','sourceSha256'])assert.ok(sup.includes(marker),marker);
  const routerStart=sup.slice(sup.indexOf('start_router_default()'),sup.indexOf('ensure_routed_default()'));
  assert.ok(!routerStart.includes('stop_owned_router_default'),'Linux live source drift must not create a canonical-listener gap');
  assert.ok(main.includes('. "$ROOT/supervisor-routing-linux.sh"'));
  assert.ok(main.includes('ensure_routed_default || start_mcp'));
  assert.ok(main.includes('start_auto_update_if_due || true'));
});

test('Linux installer delegates existing installs and builds Full Power through shared capability profile',()=>{
  const s=read('install.sh');
  for(const marker of ['invoke_existing_safe_update','build-candidate-config.mjs','--provider-root','--disable-capability','--enable-capability','SAFE_UPDATE_PASS','capabilityProfile.tier'])assert.ok(s.includes(marker),marker);
  const branch=s.indexOf('if [[ -d "$INSTALL_DIR/.git" ]]');
  assert.ok(branch>0 && s.indexOf('invoke_existing_safe_update',branch)>branch);
});


test('R230 legacy provider is disabled without unapproved cleanup on actual promotion',()=>{
  const win=read('auto-update-windows.ps1');
  const lin=read('auto-update-linux.sh');
  for(const marker of ['Ensure-ProjectProvider','PROJECT_PROVIDER_DISABLED policy=NO_CODEX_VIA_COMMANDER','LEGACY_CODEX_PROVIDER_CLEANUP_PENDING reason=OWNER_ACCEPTANCE_REQUIRED']) assert.ok(win.includes(marker),marker);
  for(const marker of ['ensure_project_provider','PROJECT_PROVIDER_DISABLED policy=NO_CODEX_VIA_COMMANDER','LEGACY_CODEX_PROVIDER_CLEANUP_PENDING reason=OWNER_ACCEPTANCE_REQUIRED']) assert.ok(lin.includes(marker),marker);
  for(const s of [win,lin]) {
    assert.ok(!s.includes('LEGACY_CODEX_PROVIDER_REMOVED'),'old implicit-delete success must be unreachable');
    assert.ok(!s.includes('@openai/codex@'),'updater must not install a legacy provider');
  }
});

test('router bootstrap is after no-promote and before schema-changing cutover',()=>{
  const win=read('auto-update-windows.ps1');
  const lin=read('auto-update-linux.sh');
  const helper=read('tools/router-source-bootstrap.mjs');
  assert.ok(win.indexOf('if($NoPromote)') < win.indexOf('$bootstrap=Ensure-RouterCandidateSource'),'Windows no-promote must exit before router bootstrap');
  assert.ok(lin.indexOf('if [[ "$NO_PROMOTE" == 1 ]]') < lin.indexOf('router-source-bootstrap.mjs'),'Linux no-promote must exit before router bootstrap');
  assert.match(win,/ROUTER_BOOTSTRAPPED_RETRY_REQUIRED/);
  assert.match(lin,/AUTO_UPDATE_ROUTER_BOOTSTRAPPED_RETRY_REQUIRED/);
  assert.match(helper,/ROUTER_ROUTE_DRIFT/);
  assert.match(helper,/ROUTER_BOOTSTRAP_ROLLBACK_FAIL/);
  assert.match(helper,/verifyProcessIdentity/);
});

test('Windows updater overlays explicit owner runner policy for default and named profiles without replacing active runtime state',()=>{
  const s=read('auto-update-windows.ps1');
  const merge=s.slice(s.indexOf('function Merge-OwnerPolicyConfig'),s.indexOf('function Get-PrimaryConfig'));
  for(const marker of ['merge-primary-policy.mjs','--active','--local','--output','PRIMARY_POLICY_OVERLAY','PRIMARY_POLICY_MERGE_FAIL']) assert.ok(merge.includes(marker),marker);
  assert.ok(merge.includes('return $activePath'),'non-mergeable owner policy must preserve active runtime authority');
  const primary=s.slice(s.indexOf('function Get-PrimaryConfig'),s.indexOf('function Invoke-Mcp'));
  assert.ok(primary.includes("Merge-OwnerPolicyConfig ([string]$r.active.configPath) $local 'default'"),'default profile must overlay canonical owner policy onto routed runtime config');
  const targets=s.slice(s.indexOf('function Get-Targets'),s.indexOf('function Start-Router'));
  assert.ok(targets.includes('$canonical=[string]$record.configPath'),'named profiles must retain their canonical owner config identity');
  assert.ok(targets.includes('Merge-OwnerPolicyConfig ([string]$rr.active.configPath) $canonical $profile'),'named profiles must apply the same guarded owner-policy overlay');
  assert.ok(targets.includes('PROFILE_CONFIG_MISSING'),'named profiles must fail closed when neither canonical nor routed config is usable');
});


const processExists=pid=>{
  try{process.kill(pid,0);return true;}catch{return false;}
};
const waitUntil=async(fn,ms=5000)=>{
  const end=Date.now()+ms;
  while(Date.now()<end){if(await fn())return true;await delay(50);}
  return false;
};
const reservePort=()=>new Promise((resolve,reject)=>{
  const s=net.createServer();
  s.once('error',reject);
  s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});
});
const listenerOwnership=port=>{
  const script=[
    `$rows=@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue)`,
    "$out=@($rows|ForEach-Object{$owner=[int]$_.OwningProcess;$proc=Get-CimInstance Win32_Process -Filter ('ProcessId='+$owner) -ErrorAction SilentlyContinue;[ordered]@{pid=$owner;localAddress=[string]$_.LocalAddress;state=[string]$_.State;commandLine=if($proc){[string]$proc.CommandLine}else{$null}}});ConvertTo-Json -InputObject $out -Compress"
  ].join(';');
  const result=spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,'listener ownership probe failed: '+(result.stderr||result.stdout));
  const raw=result.stdout.trim();
  if(!raw)return [];
  const parsed=JSON.parse(raw);
  return Array.isArray(parsed)?parsed:[parsed];
};
const assertNoOwnedListener=(port,serverPid,serverScript)=>{
  const evidence=listenerOwnership(port);
  const owned=evidence.filter(row=>Number(row.pid)===serverPid&&String(row.commandLine??'').includes(serverScript)&&String(row.commandLine??'').includes(String(port)));
  assert.equal(owned.length,0,'original grandchild must not own listener after Job cleanup evidence='+JSON.stringify(evidence));
  return evidence;
};

test('Windows qualification Job Object leaves zero descendants after fail, leak-success, timeout, and wrapper termination', {timeout:180000}, async t=>{
  if(process.platform!=='win32'){t.skip('Windows Job Object regression');return;}
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'rc-job-containment-'));
  t.after(async()=>{
    let lastError=null;
    for(let attempt=0;attempt<40;attempt++){
      try{fs.rmSync(fixture,{recursive:true,force:true});return;}
      catch(error){
        if(!['EPERM','EBUSY','ENOTEMPTY'].includes(error?.code))throw error;
        lastError=error;
        await delay(250);
      }
    }
    throw lastError??new Error('fixture cleanup failed without captured error');
  });
  const runner=path.join(root,'tools','run-owned-process-tree-windows.ps1');
  const node=process.execPath;
  const rootScript=path.join(fixture,'root.mjs');
  const childScript=path.join(fixture,'child.mjs');
  const serverScript=path.join(fixture,'server.mjs');
  fs.writeFileSync(serverScript,[
    "import fs from 'node:fs';",
    "import net from 'node:net';",
    "const [portText,pidFile]=process.argv.slice(2);",
    "const server=net.createServer(()=>{});",
    "server.listen(Number(portText),'127.0.0.1',()=>fs.writeFileSync(pidFile,String(process.pid)));",
    "setInterval(()=>{},1000);"
  ].join('\n'));
  fs.writeFileSync(childScript,[
    "import fs from 'node:fs';",
    "import {spawn} from 'node:child_process';",
    "const [serverScript,portText,childPidFile,serverPidFile]=process.argv.slice(2);",
    "fs.writeFileSync(childPidFile,String(process.pid));",
    "spawn(process.execPath,[serverScript,portText,serverPidFile],{detached:true,stdio:'ignore'}).unref();",
    "setInterval(()=>{},1000);"
  ].join('\n'));
  fs.writeFileSync(rootScript,[
    "import {spawn} from 'node:child_process';",
    "const [childScript,serverScript,portText,childPidFile,serverPidFile,mode]=process.argv.slice(2);",
    "spawn(process.execPath,[childScript,serverScript,portText,childPidFile,serverPidFile],{detached:true,stdio:'ignore'}).unref();",
    "if(mode==='hang')setInterval(()=>{},1000);else setTimeout(()=>process.exit(Number(mode)),700);"
  ].join('\n'));

  const run=async(mode,timeoutSeconds=8,runId='case')=>{
    const port=await reservePort();
    const childPidFile=path.join(fixture,runId+'.child.pid');
    const serverPidFile=path.join(fixture,runId+'.server.pid');
    const report=path.join(fixture,runId+'.report.json');
    const args=[rootScript,childScript,serverScript,String(port),childPidFile,serverPidFile,String(mode)];
    const psArgs=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',runner,
      '-Program',node,'-WorkingDirectory',fixture,'-ArgumentsJson',JSON.stringify(args),'-RunId',runId,
      '-TimeoutSeconds',String(timeoutSeconds),'-DrainGraceMs','300','-ReportPath',report];
    const wrapperBudgetMs=Math.max(30000,timeoutSeconds*1000+15000);
    const result=spawnSync('pwsh.exe',psArgs,{cwd:root,encoding:'utf8',timeout:wrapperBudgetMs});
    assert.equal(result.error?.code??null,null,'qualification wrapper failed before report runId='+runId+' budgetMs='+wrapperBudgetMs+' error='+(result.error?.code??'none'));
    assert.ok(fs.existsSync(report),result.stderr||result.stdout||('missing report runId='+runId+' budgetMs='+wrapperBudgetMs));
    const data=JSON.parse(fs.readFileSync(report,'utf8'));
    const childPid=fs.existsSync(childPidFile)?Number(fs.readFileSync(childPidFile,'utf8')):0;
    const serverPid=fs.existsSync(serverPidFile)?Number(fs.readFileSync(serverPidFile,'utf8')):0;
    assert.equal(data.activeAfterCleanup,0);
    if(childPid)assert.equal(processExists(childPid),false,'child must be gone');
    if(serverPid)assert.equal(processExists(serverPid),false,'grandchild server must be gone');
    assertNoOwnedListener(port,serverPid,serverScript);
    return {result,data,port,childPid,serverPid,psArgs,childPidFile,serverPidFile};
  };

  for(let i=0;i<3;i++){
    const x=await run('7',8,'fail-'+i);
    assert.equal(x.result.status,7);
    assert.equal(x.data.status,'FAIL_CLEANED');
    assert.equal(x.data.cleanupRequired,true);
  }

  const passLeak=await run('0',8,'pass-leak');
  assert.equal(passLeak.result.status,125);
  assert.equal(passLeak.data.status,'DESCENDANT_LEAK_CLEANED');
  assert.equal(passLeak.data.cleanupRequired,true);

  const timed=await run('hang',1,'timeout');
  assert.equal(timed.result.status,124);
  assert.equal(timed.data.status,'TIMEOUT_CLEANED');
  assert.equal(timed.data.cleanupRequired,true);

  const port=await reservePort();
  const childPidFile=path.join(fixture,'killed.child.pid');
  const serverPidFile=path.join(fixture,'killed.server.pid');
  const report=path.join(fixture,'killed.report.json');
  const args=[rootScript,childScript,serverScript,String(port),childPidFile,serverPidFile,'hang'];
  const psArgs=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',runner,
    '-Program',node,'-WorkingDirectory',fixture,'-ArgumentsJson',JSON.stringify(args),'-RunId','killed-wrapper',
    '-TimeoutSeconds','60','-DrainGraceMs','300','-ReportPath',report];
  const wrapper=spawn('pwsh.exe',psArgs,{cwd:root,stdio:'ignore'});
  const ready=await waitUntil(()=>fs.existsSync(serverPidFile)||wrapper.exitCode!==null,30000);
  assert.equal(fs.existsSync(serverPidFile),true,'grandchild server must start before wrapper termination; wrapperExit='+wrapper.exitCode+' readySignal='+ready);
  const childPid=Number(fs.readFileSync(childPidFile,'utf8'));
  const serverPid=Number(fs.readFileSync(serverPidFile,'utf8'));
  assert.equal(processExists(childPid),true);
  assert.equal(processExists(serverPid),true);
  wrapper.kill('SIGTERM');
  await new Promise(resolve=>wrapper.once('exit',resolve));
  assert.equal(await waitUntil(()=>!processExists(childPid)&&!processExists(serverPid),5000),true,'KILL_ON_JOB_CLOSE must remove descendants when wrapper dies');
  const afterOwnership=assertNoOwnedListener(port,serverPid,serverScript);
  // Numeric port reuse is not process-tree ownership. If the port is free,
  // deliberately rebind it from this test process and prove the ownership
  // predicate still rejects only the original grandchild identity.
  if(afterOwnership.length===0){
    const foreign=net.createServer(()=>{});
    await new Promise((resolve,reject)=>{
      foreign.once('error',reject);
      foreign.listen(port,'127.0.0.1',resolve);
    });
    try{
      const foreignOwnership=listenerOwnership(port);
      assert.ok(foreignOwnership.some(row=>Number(row.pid)===process.pid),'controlled foreign listener must be attributable to the test process');
      assertNoOwnedListener(port,serverPid,serverScript);
    }finally{
      await new Promise(resolve=>foreign.close(resolve));
    }
  }

});

test('qualification output retention preserves owned-job and failure semantics',()=>{
  const source=read('auto-update-windows.ps1');
  const gate=source.slice(source.indexOf('function Run-Gate('),source.indexOf('function Run-GuiNativeSelfTest('));
  for(const marker of ['qualification-output-','1> $stdoutPath','2> $stderrPath','GATE_OUTPUT_FILES','GATE_OUTPUT_HASH','stdout=$stdoutPath','stderr=$stderrPath'])assert.ok(gate.includes(marker),marker);
  assert.ok(gate.includes('-TimeoutSeconds 1200 -DrainGraceMs 2000 -ReportPath $reportPath'));
  assert.ok(gate.includes('Record-QualificationFailure $commit $Name $_.Exception.Message'));
  assert.ok(gate.indexOf('GATE_OUTPUT_FILES')<gate.indexOf('& pwsh.exe'));
});

for(const scenario of ['success','failure','runner-failure']){
  test(`qualification output retention native ${scenario}`,{timeout:60000},t=>{
    if(process.platform!=='win32'){t.skip('native Windows qualification output');return;}
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-qual-output-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:100}));
    fs.mkdirSync(path.join(dir,'tools'));
    fs.mkdirSync(path.join(dir,'logs'));
    const runner=path.join(dir,'tools','run-owned-process-tree-windows.ps1');
    const expectedCode=scenario==='success'?0:scenario==='failure'?7:9;
    if(scenario==='runner-failure'){
      fs.writeFileSync(runner,'[Console]::Out.WriteLine("RC_QUAL_STDOUT"); [Console]::Error.WriteLine("RC_QUAL_STDERR"); exit 9\n');
    }else{
      fs.copyFileSync(path.join(root,'tools','run-owned-process-tree-windows.ps1'),runner);
      fs.copyFileSync(path.join(root,'tools','owned-command-child.ps1'),path.join(dir,'tools','owned-command-child.ps1'));
    }
    fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'rc-qualification-output-fixture',version:'1.0.0',private:true,scripts:{probe:'node probe.cjs'}}));
    fs.writeFileSync(path.join(dir,'probe.cjs'),`process.stdout.write('RC_QUAL_STDOUT\\n'+'x'.repeat(16384),()=>process.stderr.write('RC_QUAL_STDERR\\n',()=>{process.exitCode=${expectedCode};}));\n`);
    const source=read('auto-update-windows.ps1');
    const begin=source.indexOf('function Run-Gate('),end=source.indexOf('function Run-GuiNativeSelfTest(');
    assert.ok(begin>=0&&end>begin,'extract only the gate, never execute updater top level');
    const fixture=path.join(dir,'gate-fixture.ps1');
    fs.writeFileSync(fixture,[
      "$ErrorActionPreference='Stop'",
      "$script:QualificationCommit='46655c5ae7d5504956959dfc7f2126fcc6824b6a'",
      "$LogDir=Join-Path $PSScriptRoot 'logs'",
      "function Log([string]$Message){[IO.File]::AppendAllText((Join-Path $PSScriptRoot 'gate.log'),$Message+[Environment]::NewLine)}",
      "function Record-QualificationFailure([string]$Commit,[string]$Name,[string]$Message){[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'failure.json'),(@{commit=$Commit;gate=$Name;message=$Message}|ConvertTo-Json -Compress))}",
      source.slice(begin,end),
      "try{Run-Gate $PSScriptRoot 'check' @('run','probe');exit 0}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}"
    ].join('\n'));
    const result=spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',fixture],{cwd:dir,encoding:'utf8',timeout:55000,windowsHide:true,maxBuffer:1024*1024});
    const diagnostic=[result.stdout,result.stderr,...fs.readdirSync(path.join(dir,'logs')).map(f=>f+': '+fs.readFileSync(path.join(dir,'logs',f),'utf8').slice(0,2500))].join('\n');
    assert.ifError(result.error);
    assert.equal(result.status,expectedCode===0?0:1,diagnostic);
    const logs=fs.readdirSync(path.join(dir,'logs'));
    const stdout=logs.filter(f=>f.endsWith('.stdout.log')),stderr=logs.filter(f=>f.endsWith('.stderr.log'));
    assert.equal(stdout.length,1,'retain one stdout file per gate');
    assert.equal(stderr.length,1,'retain one stderr file per gate');
    assert.match(fs.readFileSync(path.join(dir,'logs',stdout[0]),'utf8'),/RC_QUAL_STDOUT/,diagnostic);
    assert.match(fs.readFileSync(path.join(dir,'logs',stderr[0]),'utf8'),/RC_QUAL_STDERR/,diagnostic);
    const audit=fs.readFileSync(path.join(dir,'gate.log'),'utf8');
    assert.match(audit,/GATE_OUTPUT_FILES/);
    assert.match(audit,/GATE_OUTPUT_HASH .*stdoutSha256=[0-9A-Fa-f]{64} .*stderrSha256=[0-9A-Fa-f]{64}/);
    if(expectedCode!==0){
      const failure=JSON.parse(fs.readFileSync(path.join(dir,'failure.json'),'utf8'));
      assert.match(failure.message,new RegExp(`GATE_FAIL check exit=${expectedCode} `));
      assert.ok(failure.message.includes(stdout[0])&&failure.message.includes(stderr[0]));
      assert.doesNotMatch(audit,/GATE_PASS/,'a captured failure must never be promoted to success');
    }else{
      assert.match(audit,/GATE_PASS check/);
      assert.equal(fs.existsSync(path.join(dir,'failure.json')),false);
    }
    if(scenario!=='runner-failure'){
      const report=JSON.parse(fs.readFileSync(path.join(dir,'logs',logs.find(f=>f.startsWith('qualification-job-'))),'utf8'));
      assert.equal(report.childExitCode,expectedCode);
      assert.equal(report.activeAfterCleanup,0);
      assert.deepEqual(report.leakedProcesses,[]);
    }
  });
}

test('R234 Linux work-plugin updater preserves arbitrary owner data and retains only one previous snapshot',t=>{
  const source=read('auto-update-linux.sh');
  const begin=source.indexOf('sync_work_plugin_projection(){');
  const end=source.indexOf('\ncleanup_releases(){',begin);
  assert.ok(begin>=0&&end>begin,'must identify the exact plugin projection function');
  const func=source.slice(begin,end);
  for(const marker of [
    'WORK_PLUGIN_RETIREMENT_PENDING reason=OWNER_ACCEPTANCE_REQUIRED',
    'WORK_PLUGIN_SOURCE_SYNC_BLOCK reason=prior-snapshot-or-quarantine-awaiting-owner',
    'WORK_PLUGIN_SOURCE_SYNC_BLOCK reason=unknown-special-node',
    'cp -a "$plugin_root/." "$stage/"'
  ])assert.ok(func.includes(marker),'missing safety guard '+marker);
  assert.doesNotMatch(func,/\brm\s+-rf\b/,'no plugin tree can be silently deleted in the update function');
  if(process.platform!=='linux')return t.skip('native Bash+Node work-plugin fixture is Linux-only');
  const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'rc-r234-workplugin-'));
  t.after(()=>{
    assert.match(path.basename(sandbox),/^rc-r234-workplugin-/);
    assert.equal(path.dirname(path.resolve(sandbox)),path.resolve(os.tmpdir()));
    fs.rmSync(sandbox,{recursive:true,force:true});
  });
  const project=path.join(sandbox,'source'),template=path.join(project,'plugin-template');
  const data=path.join(sandbox,'data'),backup=path.join(sandbox,'backup');
  const version='0.10.21',commit='a'.repeat(40);
  const projection=path.join(data,'ChatGPTRemoteCommander','work-plugin','marketplace','plugins','chatgpt-remote-commander');
  fs.mkdirSync(path.join(template,'.codex-plugin'),{recursive:true});
  fs.mkdirSync(path.join(projection,'owner-notes'),{recursive:true});
  fs.writeFileSync(path.join(template,'plugin.json'),JSON.stringify({name:'chatgpt-remote-commander',version}));
  fs.writeFileSync(path.join(template,'.codex-plugin','plugin.json'),JSON.stringify({name:'chatgpt-remote-commander',version}));
  fs.writeFileSync(path.join(projection,'plugin.json'),JSON.stringify({name:'chatgpt-remote-commander',version:'0.10.20'}));
  fs.writeFileSync(path.join(projection,'.app.json'),JSON.stringify({apps:{'remote-commander':{id:'asdk_app_R234_fixture'}}}));
  fs.writeFileSync(path.join(projection,'owner-notes','custom.txt'),'OWNER_R234_MUST_PRESERVE');
  const bash=[
    'set -Eeuo pipefail',
    'BACKUP_ROOT="$1"',
    'export XDG_DATA_HOME="$2"',
    'log(){ printf "%s\\n" "$1"; }',
    func,
    'sync_work_plugin_projection "$3" "$4" "$5"'
  ].join('\n');
  const invoke=()=>runPrivateBashFixture(bash,[backup,data,project,version,commit],{encoding:'utf8',timeout:15000},sandbox);
  const first=invoke();
  assert.equal(first.error,undefined,first.error?.message);
  assert.equal(first.status,0,first.stderr+' '+first.stdout);
  assert.match(first.stdout,/WORK_PLUGIN_RETIREMENT_PENDING reason=OWNER_ACCEPTANCE_REQUIRED/);
  const parent=path.dirname(projection);
  const retained=fs.readdirSync(parent).filter(name=>name.startsWith('.chatgpt-remote-commander.prev-'));
  assert.equal(retained.length,1,'one inactive predecessor is retained');
  const custom=path.join('owner-notes','custom.txt');
  assert.equal(fs.readFileSync(path.join(projection,custom),'utf8'),'OWNER_R234_MUST_PRESERVE');
  assert.equal(fs.readFileSync(path.join(parent,retained[0],custom),'utf8'),'OWNER_R234_MUST_PRESERVE');
  assert.equal(fs.readFileSync(path.join(backup,commit,'work-plugin','chatgpt-remote-commander',custom),'utf8'),'OWNER_R234_MUST_PRESERVE');
  assert.equal(JSON.parse(fs.readFileSync(path.join(projection,'plugin.json'),'utf8')).version,version);
  const second=invoke();
  assert.notEqual(second.status,0,'re-update must fail closed while prior snapshot is retained');
  assert.match(second.stdout,/prior-snapshot-or-quarantine-awaiting-owner/);
  assert.equal(fs.readdirSync(parent).filter(name=>name.startsWith('.chatgpt-remote-commander.prev-')).length,1);
  assert.equal(fs.readFileSync(path.join(projection,custom),'utf8'),'OWNER_R234_MUST_PRESERVE');
});

test('R254 Linux plugin post-verify failure preserves owner data and quarantines only failed projection', t=>{
 const source=read('auto-update-linux.sh');
 const begin=source.indexOf('sync_work_plugin_projection(){'),end=source.indexOf('\ncleanup_releases(){',begin);
 assert.ok(begin>=0&&end>begin);
 const func=source.slice(begin,end);
 assert.match(func,/failed-\$\{BASHPID\}-\$\{RANDOM\}-\$\{RANDOM\}/);
 assert.ok(func.includes('mv -T -- "$retired" "$plugin_root"'));
 assert.ok(func.includes('prior-snapshot-or-quarantine-awaiting-owner'));
 assert.doesNotMatch(func,/\brm\s+-rf\b/);
 if(process.platform!=='linux')return t.skip('requires isolated Linux Bash and Node');
 const box=fs.mkdtempSync(path.join(os.tmpdir(),'rc-r254-plugin-'));
 t.after(()=>{assert.match(path.basename(box),/^rc-r254-plugin-/);assert.equal(path.dirname(path.resolve(box)),path.resolve(os.tmpdir()));fs.rmSync(box,{recursive:true,force:true});});
 const project=path.join(box,'source'),tmpl=path.join(project,'plugin-template'),data=path.join(box,'data'),backup=path.join(box,'backup');
 const version='0.10.21',commit='a'.repeat(40);
 const parent=path.join(data,'ChatGPTRemoteCommander','work-plugin','marketplace','plugins');
 const projection=path.join(parent,'chatgpt-remote-commander');
 fs.mkdirSync(path.join(tmpl,'.codex-plugin'),{recursive:true});
 fs.mkdirSync(path.join(projection,'owner-notes'),{recursive:true});
 fs.writeFileSync(path.join(tmpl,'plugin.json'),JSON.stringify({name:'chatgpt-remote-commander',version}));
 fs.writeFileSync(path.join(tmpl,'.codex-plugin','plugin.json'),JSON.stringify({name:'chatgpt-remote-commander',version}));
 fs.writeFileSync(path.join(projection,'plugin.json'),JSON.stringify({name:'chatgpt-remote-commander',version:'0.10.20'}));
 fs.writeFileSync(path.join(projection,'.app.json'),JSON.stringify({apps:{'remote-commander':{id:'asdk_app_R254_fixture'}}}));
 fs.writeFileSync(path.join(projection,'owner-notes','private.txt'),'R254_PRIVATE_OWNER_DATA');
 const origBinding=fs.readFileSync(path.join(projection,'.app.json'),'utf8');
 const script=[
 'set -Eeuo pipefail',
 'BACKUP_ROOT="$1"',
 'export XDG_DATA_HOME="$2"',
 'log(){ printf "%s\\n" "$1"; }',
 'R254_calls=0',
 'node(){ R254_calls=$((R254_calls+1)); if [[ "$R254_calls" -eq 3 ]];then return 41;fi; command node "$@"; }',
 func,
 'sync_work_plugin_projection "$3" "$4" "$5"'
 ].join('\n');
 const invoke=()=>runPrivateBashFixture(script,[backup,data,project,version,commit],{encoding:'utf8',timeout:15000},box);
 const result=invoke();
 assert.equal(result.error,undefined,result.error?.message);
 assert.notEqual(result.status,0,'fault-injected post-verify must fail closed');
 assert.match(result.stdout,/post-verify-failed/);
 assert.equal(fs.readFileSync(path.join(projection,'owner-notes','private.txt'),'utf8'),'R254_PRIVATE_OWNER_DATA');
 assert.equal(fs.readFileSync(path.join(projection,'.app.json'),'utf8'),origBinding);
 assert.equal(JSON.parse(fs.readFileSync(path.join(projection,'plugin.json'),'utf8')).version,'0.10.20');
 const failed=fs.readdirSync(parent).filter(n=>n.startsWith('.chatgpt-remote-commander.failed-'));
 assert.equal(failed.length,1);
 assert.match(failed[0],/^\.chatgpt-remote-commander\.failed-[0-9]+-[0-9]+-[0-9]+$/);
 assert.equal(fs.readFileSync(path.join(parent,failed[0],'owner-notes','private.txt'),'utf8'),'R254_PRIVATE_OWNER_DATA');
 assert.equal(JSON.parse(fs.readFileSync(path.join(parent,failed[0],'plugin.json'),'utf8')).version,version);
 assert.equal(fs.readdirSync(parent).filter(n=>n.startsWith('.chatgpt-remote-commander.prev-')).length,0);
 assert.equal(fs.readFileSync(path.join(backup,commit,'work-plugin','chatgpt-remote-commander','owner-notes','private.txt'),'utf8'),'R254_PRIVATE_OWNER_DATA');
 const retry=invoke();
 assert.notEqual(retry.status,0);
 assert.match(retry.stdout,/prior-snapshot-or-quarantine-awaiting-owner/);
 assert.equal(fs.readdirSync(parent).filter(n=>n.startsWith('.chatgpt-remote-commander.failed-')).length,1);
});

test('R157 staged release lookup uses the pinned source version, not a fixed old tag',()=>{
 const workflow=read('.github/workflows/windows-updater-e2e-r157.yml');
 const version=JSON.parse(read('package.json')).version;
 assert.match(version,/^\d+\.\d+\.\d+$/);
 for(const requirement of [
  "Join-Path $env:GITHUB_WORKSPACE 'package.json'",
  "R157_SOURCE_PACKAGE_MISSING",
  "R157_SOURCE_VERSION_INVALID",
  "('releases\\v'+$sourceVersion+'-'+$sha.Substring(0,12))",
  "(git -C $stage rev-parse HEAD).Trim() -ne $sha",
  "R157_EXACT_STAGE_MISSING",
  "R157_UNEXPECTED_ROUTE_PROMOTION",
  "R157_JOB_NOT_ACCEPTED_"
 ]) assert.ok(workflow.includes(requirement),'missing exact NoPromote safeguard: '+requirement);
 assert.equal(workflow.includes("('releases\\v0.10.24-'+$sha.Substring(0,12))"),false);
 assert.equal('releases\\v'+version+'-'+'f'.repeat(12),'releases\\v0.10.25-'+'f'.repeat(12));
});
