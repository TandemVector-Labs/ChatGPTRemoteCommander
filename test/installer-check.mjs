import { spawnSync } from 'node:child_process';
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
  "[string]$SourceRef = 'v0.10.24'",
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
if (!windowsServerInstaller.includes("[string]$SourceRef = 'v0.10.24'")) throw new Error('server-install-windows.ps1 default SourceRef must match current release');
if (!windowsServerInstaller.includes('ChatGPTRemoteCommander-ServerInstaller/0.10.24')) throw new Error('server-install-windows.ps1 User-Agent must match current release');
for (const required of [
  "[string]$GuiControl = 'Off'",
  "$guiEnabled = $false # Server installer defaults headless regardless of Windows SKU or RDP."
]) if (!windowsServerInstaller.includes(required)) throw new Error('Server install must select headless by default even on Client-SKU hosts: '+required);
const serverCanaryWorkflow = readFileSync('.github/workflows/server-install-canary.yml','utf8');
// Only the two approved official GitHub source repositories may be selected on Windows.
for (const [label, installer] of [['install.ps1', windowsInstaller], ['server-install-windows.ps1', windowsServerInstaller]]) {
  for (const required of ['$env:REMOTE_COMMANDER_REPO_URL', '^https://github[.]com/(?:GOD13emad|TandemVector-Labs)/ChatGPTRemoteCommander[.]git
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
]) if (!serverCanaryWorkflow.includes(required)) throw new Error('server canary missing least-privilege same-repo token guard: '+required);

if (!linuxServerInstaller.includes('SOURCE_REF="${REMOTE_COMMANDER_SOURCE_REF:-v0.10.24}"')) throw new Error('server-install-linux.sh default SourceRef must match current release');
if (!linuxServerInstaller.includes('default: v0.10.24')) throw new Error('server-install-linux.sh usage default must match current release');
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
for (const required of [
  'SOURCE_REF="${REMOTE_COMMANDER_SOURCE_REF:-v0.10.24}"',
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
  'Skipping tunnel-client installation as requested',
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
, 'Unapproved source repository URL']) {
    if (!installer.includes(required)) throw new Error(`${label} missing bounded source override: ${required}`);
  }
}
for (const required of ['REMOTE_COMMANDER_REPO_URL: https://github.com/${{ github.repository }}.git', '-e REMOTE_COMMANDER_REPO_URL="$REMOTE_COMMANDER_REPO_URL"']) {
  if (!serverCanaryWorkflow.includes(required)) throw new Error(`Canary must test its own checkout's immutable source: ${required}`);
}
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
]) if (!serverCanaryWorkflow.includes(required)) throw new Error('server canary missing least-privilege same-repo token guard: '+required);

if (!linuxServerInstaller.includes('SOURCE_REF="${REMOTE_COMMANDER_SOURCE_REF:-v0.10.24}"')) throw new Error('server-install-linux.sh default SourceRef must match current release');
if (!linuxServerInstaller.includes('default: v0.10.24')) throw new Error('server-install-linux.sh usage default must match current release');
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
for (const required of [
  'SOURCE_REF="${REMOTE_COMMANDER_SOURCE_REF:-v0.10.24}"',
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
  'Skipping tunnel-client installation as requested',
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
