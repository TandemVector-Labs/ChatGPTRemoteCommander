import { spawnSync } from 'node:child_process';
import { resolvePython3Runner } from '../tools/resolve-python3-runner.mjs';
import { readFileSync } from 'node:fs';

const windowsInstaller = readFileSync('install.ps1', 'utf8');
const capabilityPolicy = readFileSync('src/capability-profile.mjs', 'utf8');
const windowsServerInstaller = readFileSync('server-install-windows.ps1','utf8');
const linuxServerInstaller = readFileSync('server-install-linux.sh','utf8');
for (const required of ['[switch]$GuiControl','[switch]$DisableGuiControl','capability-migrate.mjs','Invoke-ExistingSafeUpdate','auto-update-windows.ps1']) {
  if (!windowsInstaller.includes(required)) throw new Error(`install.ps1 missing delegated capability/update behavior: ${required}`);
}
for (const required of ['guiControl','allowScreenshot','allowMouse','allowKeyboard','allowWindowFocus','allowPermanentDelete','autoEnableNewCapabilities','disabledCapabilities']) {
  if (!capabilityPolicy.includes(required)) throw new Error(`capability-profile.mjs missing Full Power behavior: ${required}`);
}
for (const required of [
  "Join-Path $stateRoot 'app'",
  'Detected active installation from Windows autostart',
  '$InstallDir = Resolve-InstallDir',
  'Tracked local changes exist in InstallDir',
  "[string]$SourceRef = 'v0.12.0'",
  'ExpectedCommit',
  "rev-parse 'FETCH_HEAD^{commit}'",
  'incomplete Git checkout with no HEAD',
  'Remove-Item -LiteralPath $InstallDir -Recurse -Force',
  'Get-ExpectedConfigHash',
  'mcp-runtime.json',
  'tunnel-client.json',
  'Skipping tunnel-client installation as requested',
  'update-backups',
  'SAFE_UPDATE_PASS',
  '$isCanonicalLiveInstall',
  'Updating isolated/custom checkout in place without global routing mutation',
  'fresh-install routing/bootstrap validation failed',
  'Capability self-test:',
  'Ensure-ProjectProvider',
  'PROJECT_PROVIDER_DISABLED policy=NO_CODEX_VIA_COMMANDER',
  'Mode: $(if ($effective.powerMode.enabled)',
  'if (Test-Path -LiteralPath $temp) {',
  'Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction Stop',
  'UPDATER_TEMP_CLEANUP_DEFER'
]) {
  if (!windowsInstaller.includes(required)) {
    throw new Error(`install.ps1 missing required release behavior: ${required}`);
  }
}

if (!windowsInstaller.includes('@($env:Path, $machine, $user)')) throw new Error('Refresh-Path must preserve validated process-local tool paths while merging refreshed machine/user PATH');
if (!windowsInstaller.includes('[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)')) throw new Error('Refresh-Path must deduplicate merged PATH entries case-insensitively');
if (!windowsInstaller.includes('Write-Warning ("UPDATER_TEMP_CLEANUP_DEFER')) throw new Error('existing-update temp cleanup must be best-effort after update outcome is known');
if (windowsInstaller.includes('if (Test-Path -LiteralPath $temp) { throw }')) throw new Error('temp cleanup must not convert a successful update into installer failure');
if (windowsInstaller.includes('@openai/codex@')) throw new Error('install.ps1 must not provision Codex');
for (const required of [
  "PowerShell-$version-win-x64.msi",
  '958838FF55091E1C8705D89EFED0CC7E8245A3A6EF6C0CCFAE20015227108AD8',
  "node-v$version-x64.msi",
  'SHASUMS256.txt',
  'Get-AuthenticodeSignature',
  'Get-FileHash',
  "Join-Path $env:ProgramFiles 'nodejs\\node.exe'",
  "Join-Path $env:ProgramFiles 'Git\\cmd\\git.exe'",
  "Add-ArtifactEvidence 'Node.js' $existing 'existing-installation'",
  "Add-ArtifactEvidence 'Git for Windows' $existing 'existing-installation'",
  "$env:Path = @((Split-Path -Parent $node),(Split-Path -Parent $git),$env:Path) -join ';'",
  'git-for-windows/git/releases/latest',
  "InstallationType",
  "Server Core",
  'server-install-allowlist.json',
  'antivirusExclusionsAdded=$false',
  "rev-parse 'FETCH_HEAD^{commit}'",
  "'-ExpectedCommit',$resolved",
  'SERVER_INSTALL_WINDOWS_PASS'
]) if (!windowsServerInstaller.includes(required)) throw new Error(`server-install-windows.ps1 missing secure bootstrap behavior: ${required}`);
for (const forbidden of ['Add-MpPreference','Set-MpPreference','Remove-MpPreference']) {
  if (windowsServerInstaller.includes(forbidden)) throw new Error(`server installer must not mutate Defender exclusions/settings: ${forbidden}`);
}
if (!windowsServerInstaller.includes("[string]$SourceRef = 'v0.12.0'")) throw new Error('server-install-windows.ps1 default SourceRef must match current release');
if (!windowsServerInstaller.includes('ChatGPTRemoteCommander-ServerInstaller/0.10.24')) throw new Error('server-install-windows.ps1 User-Agent must match current release');
for (const required of [
  "[string]$GuiControl = 'Off'",
  "$guiEnabled = $false # Server installer defaults headless regardless of Windows SKU or RDP."
]) if (!windowsServerInstaller.includes(required)) throw new Error('Server install must select headless by default even on Client-SKU hosts: '+required);
const serverCanaryWorkflow = readFileSync('.github/workflows/server-install-canary.yml','utf8');
for (const required of [
  "$script:BootstrapGitHubToken = [Environment]::GetEnvironmentVariable('RC_GITHUB_API_TOKEN','Process')",
  "[Environment]::SetEnvironmentVariable('RC_GITHUB_API_TOKEN',$null,'Process')",
  "['Authorization'] = 'Bearer ' + $script:BootstrapGitHubToken",
  "Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers $headers -TimeoutSec 30",
  "$script:BootstrapGitHubToken = $null",
  "Assert-Sha256 $path $expected",
  "Assert-Authenticode $path",
]) if (!windowsServerInstaller.includes(required)) throw new Error('server installer missing bounded authenticated Git metadata gate: '+required);
for (const required of [
  "contents: read",
  "github.event.pull_request.head.repo.full_name == github.repository",
  "RC_GITHUB_API_TOKEN: ${{ github.token }}",
  "RC_SOURCE_REF: ${{ github.event.pull_request.head.sha || github.sha }}",
]) if (!serverCanaryWorkflow.includes(required)) throw new Error('server canary missing least-privilege same-repo token guard: '+required);

if (!linuxServerInstaller.includes('SOURCE_REF="${REMOTE_COMMANDER_SOURCE_REF:-v0.12.0}"')) throw new Error('server-install-linux.sh default SourceRef must match current release');
if (!linuxServerInstaller.includes('default: v0.12.0')) throw new Error('server-install-linux.sh usage default must match current release');
for (const token of [
  String.raw`^0\.(11|12)\.0-dev\.[1-9][0-9]*$`,
  'release-train-0.${dev_minor}.json',
  "assert train['train']==sys.argv[3]",
  "assert train['sourceVersion']==sys.argv[2]",
  "assert train['releaseTag'] is None",
  "'isStable','publishApproved','autoupdateApproved','installedPromotionApproved'"
]) if (!linuxServerInstaller.includes(token)) throw new Error('Linux V0.12 dev bootstrap must match a non-promotable release train: '+token);
const linuxDevTrainValidator = linuxServerInstaller.match(/<<'PY'\n([\s\S]*?)\nPY/);
if (!linuxDevTrainValidator) throw new Error('Linux staged release-train validator not found');
const pythonRunner=process.platform==='linux'?resolvePython3Runner():null;
function validateTrainInNode(minor,version){
  let train;
  try{train=JSON.parse(readFileSync('docs/release-train-0.'+minor+'.json','utf8'));}
  catch{return false;}
  return train!==null&&typeof train==='object'&&!Array.isArray(train)
    &&train.train==='0.'+minor&&train.sourceVersion===version
    &&train.status==='INTEGRATION_CANDIDATE_NOT_FINAL'
    &&train.channel==='development'&&train.releaseTag===null
    &&['isStable','publishApproved','autoupdateApproved','installedPromotionApproved']
      .every(key=>train[key]===false);
}
// On Windows the installer bootstraps portable Node/Git but not Python. Validate
// the Linux-only release-train predicates in Node without another dependency.
// Linux additionally executes the actual embedded Python validator, preserving
// its independent runtime admission check.
for (const [minor,version,accepted] of [
  ['11','0.11.0-dev.105',true],
  ['12','0.12.0-dev.9',true],
  ['12','0.12.0-dev.8',false],
  ['12','0.12.0-dev.2',false],
  ['11','0.12.0-dev.1',false]
]){
  if(validateTrainInNode(minor,version)!==accepted)
    throw new Error('Linux V0.12 train/source Node parity wrong: '+minor+' '+version);
  if(pythonRunner){
    const result=spawnSync(pythonRunner.command,
      [...pythonRunner.prefixArgs,'-','docs/release-train-0.'+minor+'.json',version,'0.'+minor],
      {input:linuxDevTrainValidator[1]+'\n',encoding:'utf8',windowsHide:true,timeout:8000});
    if((result.status===0)!==accepted)
      throw new Error('Linux V0.12 embedded Python admission wrong: '+minor+' '+version);
  }
}
for (const [label,script] of [['server-install-windows.ps1',windowsServerInstaller],
                               ['server-install-canary.yml',serverCanaryWorkflow]]) {
  for (const token of ['(?<minor>11|12)','release-train-$trainVersion.json',
                       '$train.train -cne $trainVersion',
                       "INTEGRATION_CANDIDATE_NOT_FINAL",
                       '$train.publishApproved -ne $false',
                       '$train.autoupdateApproved -ne $false',
                       '$train.installedPromotionApproved -ne $false']) {
    if (!script.includes(token)) throw new Error('WINDOWS_V012_DEV_SERVER_CANARY_DENIED '+label+' '+token);
  }
}
if (!serverCanaryWorkflow.includes('SERVER_CANARY_UNKNOWN_VERSION_DENIED')) {
  throw new Error('UNKNOWN_DEVELOPMENT_SERVER_VERSION_MUST_FAIL_CLOSED');
}

for (const path of ['docs/release-train-0.11.json','docs/release-train-0.12.json']) {
  if (!serverCanaryWorkflow.includes("      - '"+path+"'")) {
    throw new Error('SERVER_CANARY_MUST_RETEST_WHEN_TRAIN_CHANGED '+path);
  }
}

const publicConfig = JSON.parse(readFileSync('config.json','utf8'));
if (publicConfig.auditMaxBytes !== 8388608 || publicConfig.auditKeepFiles !== 3) {
  throw new Error('config.json missing bounded audit defaults');
}
if (publicConfig.autoUpdate?.enabled !== true || publicConfig.autoUpdate?.zeroDowntime !== true) {
  throw new Error('config.json missing automatic update defaults');
}

const linuxInstaller = readFileSync('install.sh', 'utf8');
if (linuxInstaller.includes('@openai/codex@')) throw new Error('install.sh must not provision Codex');
for (const [label, text] of [['install.sh',linuxInstaller],['server-install-linux.sh',linuxServerInstaller]]) {
  for (const required of ['python3','sha256sum','readlink']) {
    if (!text.includes(required)) throw new Error(`${label} missing required fresh-Linux prerequisite contract: ${required}`);
  }
}
if (!linuxInstaller.includes('for cmd in git curl unzip tar sha256sum readlink python3; do')) throw new Error('install.sh must require python3 before qualification');
if (!linuxInstaller.includes('npm run check:qualification')) throw new Error('install.sh must use bounded qualification check path');
if (!windowsInstaller.includes('& npm.cmd run check:qualification')) throw new Error('install.ps1 must use bounded qualification check path');
if (!linuxInstaller.includes('npm run test:qualification')) throw new Error('install.sh must use bounded qualification test path');
if (!windowsInstaller.includes('& npm.cmd run test:qualification')) throw new Error('install.ps1 must use bounded qualification test path');
if (!linuxServerInstaller.includes('for cmd in git curl unzip tar sha256sum readlink python3; do')) throw new Error('server-install-linux.sh must require python3 before handoff');
if (!linuxServerInstaller.includes('REMOTE_COMMANDER_HEADLESS_VALIDATE=1 /bin/bash "$installer" "${args[@]}"')) throw new Error('headless server install must scope native GUI validation skip to the child installer');
const linuxGuiContract = readFileSync('test/linux-gui-contract.mjs','utf8');
if (!linuxGuiContract.includes("process.env.REMOTE_COMMANDER_HEADLESS_VALIDATE === '1'")) throw new Error('Linux GUI contract must recognize explicit headless validation mode');


const linuxEnrollment = readFileSync('enable-autostart-linux.sh', 'utf8');
const linuxPluginInstaller = readFileSync('install-work-plugin.sh', 'utf8');
const linuxAccountConnector = readFileSync('connect-chatgpt-account.sh', 'utf8');
for (const required of [
  'apt-get','dnf','yum','zypper','pacman',
  '--expected-commit "$resolved"',
  '--disable-capability gui.screenshot',
  '--disable-capability gui.mouse',
  '--disable-capability gui.keyboard',
  '--disable-capability gui.window_focus',
  'SERVER_INSTALL_LINUX_PASS',
  'Alpine/musl is not qualified'
]) if (!linuxServerInstaller.includes(required)) throw new Error(`server-install-linux.sh missing server bootstrap behavior: ${required}`);
for (const required of ['attempt <= 3','Acquire::Retries=3 update','Acquire::Retries=3 install','APT_BOOTSTRAP_PREREQUISITES_FAILED_AFTER_3_ATTEMPTS']) {
  if (!linuxInstaller.includes(required)) throw new Error(`install.sh missing bounded apt retry behavior: ${required}`);
}
for (const required of ['attempt <= 3','Acquire::Retries=3 update','Acquire::Retries=3 install','APT_BOOTSTRAP_PREREQUISITES_FAILED_AFTER_3_ATTEMPTS']) {
  if (!linuxServerInstaller.includes(required)) throw new Error(`server-install-linux.sh missing bounded apt retry behavior: ${required}`);
}
for (const required of [
  'SOURCE_REF="${REMOTE_COMMANDER_SOURCE_REF:-v0.12.0}"',
  '--source-ref',
  '--skip-tunnel-client',
  '--expected-commit',
  'REMOTE_COMMANDER_EXPECTED_COMMIT',
  "rev-parse 'FETCH_HEAD^{commit}'",
  'incomplete staging checkout removed',
  'Tracked local changes exist in InstallDir',
  'fetch --no-tags origin "$SOURCE_REF"',
  'checkout --detach',
  'Source commit:',
  'Updating running MCP from version',
  'enable-autostart-linux.sh',
  'invoke_existing_safe_update',
  'SAFE_UPDATE_PASS',
  'build-candidate-config.mjs',
  '--provider-root',
  'ensure_project_provider',
  'PROJECT_PROVIDER_DISABLED policy=NO_CODEX_VIA_COMMANDER',
  'auto-update-linux.sh',
  'supervisor-routing-linux.sh',
  '--disable-capability',
  '--enable-capability',
  'capabilityProfile.tier',
  'REMOTE_COMMANDER_CURL_CONNECT_TIMEOUT',
  'REMOTE_COMMANDER_CURL_MAX_TIME',
  '--connect-timeout "$CURL_CONNECT_TIMEOUT"',
  '--max-time "$CURL_MAX_TIME"',
  'curl_fetch https://nodejs.org/dist/index.json',
  'curl -fsS --connect-timeout 1 --max-time 2 http://127.0.0.1:47831/health',
  'TUNNEL_CLIENT_REQUIRED_MISSING',
  'Reusing existing pinned tunnel-client while skip was requested'
]) {
  if (!linuxInstaller.includes(required)) {
    throw new Error(`install.sh missing required release behavior: ${required}`);
  }
}
for (const required of ['--connect-timeout "$CURL_CONNECT_TIMEOUT"', '--max-time "$CURL_MAX_TIME"']) {
  if (!linuxPluginInstaller.includes(required)) {
    throw new Error(`install-work-plugin.sh missing bounded download behavior: ${required}`);
  }
}
for (const required of ['--connect-timeout 1 --max-time 3']) {
  if (!linuxAccountConnector.includes(required)) {
    throw new Error(`connect-chatgpt-account.sh missing bounded health behavior: ${required}`);
  }
}
for (const required of ['Reusing existing local credential', 'doctor bind check skipped']) {
  if (!linuxEnrollment.includes(required)) {
    throw new Error(`enable-autostart-linux.sh missing required v0.3.3 behavior: ${required}`);
  }
}

function run(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true });
  if (result.error?.code === 'ENOENT') return { skipped: true };
  if (result.status !== 0) {
    throw new Error(`${file} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
  return { skipped: false };
}

if (process.platform === 'linux') {
  const files = [
    'install.sh', 'connect-chatgpt-account.sh', 'run-server.sh',
    'autostart-linux.sh', 'supervisor-routing-linux.sh', 'auto-update-linux.sh',
    'enable-autostart-linux.sh', 'disable-autostart-linux.sh', 'install-work-plugin.sh',
    'tools/install-gnome-gui-extension.sh', 'server-install-linux.sh'
  ];
  for (const file of files) {
    const outcome = run('bash', ['-n', file]);
    if (outcome.skipped) throw new Error('bash parser is required on Linux');
  }
  const py = run('python3', ['-c',"import ast,pathlib; ast.parse(pathlib.Path('tools/gui-control-linux.py').read_text())"]);
  if (py.skipped) throw new Error('python3 is required for the Linux GUI helper');
  console.log('INSTALLER_CHECK_PASS platform=linux bash=true python=true');
} else if (process.platform === 'win32') {
  const files = [
    'install.ps1', 'connect-chatgpt-account.ps1', 'connect-chatgpt.ps1',
    'autostart-windows.ps1', 'supervisor-routing.ps1', 'auto-update-windows.ps1', 'enable-autostart.ps1', 'disable-autostart.ps1',
    'install-work-plugin.ps1', 'tools/gui-control.ps1', 'server-install-windows.ps1'
  ];
  for (const file of files) {
    const escaped = file.replaceAll("'", "''");
    const command = `$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('${escaped}',[ref]$null,[ref]$e)>$null; if($e.Count){$e|% Message; exit 1}`;
    const outcome = run('pwsh.exe', ['-NoProfile', '-Command', command]);
    if (outcome.skipped) throw new Error('PowerShell 7 parser is required on Windows');
  }
  console.log('INSTALLER_CHECK_PASS platform=win32 powershell=true');
} else {
  console.log(`INSTALLER_CHECK_SKIP platform=${process.platform}`);
}

if (windowsInstaller.includes('throw "SkipTunnelClient was requested but expected executable is missing')) {
  throw new Error('SkipTunnelClient missing-client path must not throw');
}


// Security regression: October 2026 Node.js LTS patch floors must apply across
// both Windows installers and the Linux source installer. Evaluate only the pure
// helper function; never execute an installer or grant a new capability here.
for (const file of ['install.ps1','server-install-windows.ps1']) {
  const code = readFileSync(file,'utf8');
  for (const required of ["function Test-PatchedNodeVersion([string]$Version)","22.23.4","24.22.1","26.12.1","Test-PatchedNodeVersion $nodeVersion"]) {
    if (!code.includes(required) && !(file==='server-install-windows.ps1' && required==='Test-PatchedNodeVersion $nodeVersion')) {
      throw new Error('Missing patched Node LTS floor in '+file+': '+required);
    }
  }
  if (code.includes('if ($major -ge 22)') || code.includes('if ($nodeMajor -lt 22)')) {
    throw new Error('Unsafe major-only Node runtime gate in '+file);
  }
}
if (!readFileSync('server-install-windows.ps1','utf8').includes("$version = '22.23.4'")) {
  throw new Error('Windows server bootstrap must download patched Node 22');
}
const linuxNodePolicy=readFileSync('install.sh','utf8');
for (const required of ['node_version_patched() {','node_version_patched ||','node_version_patched "$version"']) {
  if (!linuxNodePolicy.includes(required)) throw new Error('Linux installer missing patched Node guard: '+required);
}
if (process.platform === 'win32') {
  const ps=[
    "$ErrorActionPreference='Stop'",
    "$allowed=@('v22.23.4','v22.23.5','v24.22.1','v24.22.2','v26.12.1','v26.13.0')",
    "$denied=@('v22.23.3','v22.22.99','v24.22.0','v26.12.0','v23.99.99','v25.99.99','v27.0.0','v22.23.4-rc.1','22.23.4','v22.23.4.1')",
    "foreach($path in @('install.ps1','server-install-windows.ps1')) {",
    "  $errors=$null;$tokens=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)",
    "  if($errors.Count){exit 51}",
    "  $fn=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-PatchedNodeVersion'},$true))",
    "  if($fn.Count -ne 1){exit 52}",
    "  . ([scriptblock]::Create($fn[0].Extent.Text))",
    "  foreach($v in $allowed){if(!(Test-PatchedNodeVersion $v)){exit 53}}",
    "  foreach($v in $denied){if(Test-PatchedNodeVersion $v){exit 54}}",
    "}"
  ].join('; ');
  const result=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',ps],{encoding:'utf8',timeout:12000,windowsHide:true});
  if(result.status!==0) throw new Error('Windows patched Node runtime predicate failed: '+result.stderr);
}
if (process.platform === 'linux') {
  const fn=linuxNodePolicy.replaceAll('\r\n','\n').match(/^node_version_patched\(\) \{[\s\S]*?^\}/m)?.[0];
  if(!fn) throw new Error('Missing isolated Linux patched-node version predicate');
  const shell=[
    fn,
    'for v in v22.23.4 v22.23.5 v24.22.1 v24.22.2 v26.12.1 v26.13.0; do node_version_patched "$v" || exit 61; done',
    'for v in v22.23.3 v22.22.99 v24.22.0 v26.12.0 v23.99.99 v25.99.99 v27.0.0 v22.23.4-rc.1 22.23.4 v22.23.4.1; do node_version_patched "$v" && exit 62; done',
    'true'
  ].join('\n');
  const result=spawnSync('bash',['-s'],{input:shell,encoding:'utf8',timeout:12000});
  if(result.status!==0) throw new Error('Linux patched Node runtime predicate failed: '+result.stderr);
}
console.log('PATCHED_NODE_LTS_POLICY_PASS');
