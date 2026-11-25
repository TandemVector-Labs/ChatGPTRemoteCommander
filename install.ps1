param(
  [string]$InstallDir = '',
  [switch]$InstallPrerequisites,
  [switch]$PowerMode,
  [switch]$StandardMode,
  [switch]$GuiControl,
  [switch]$DisableGuiControl,
  [string[]]$DisableCapability = @(),
  [string[]]$EnableCapability = @(),
  [switch]$StartServer,
  [switch]$SkipTunnelClient,
  [string]$TunnelClientVersion = '0.0.15',
  [string]$SourceRef = 'v0.12.0',
  [string]$ExpectedCommit = '',
  [string]$SourceBundle = '',
  [string]$SourceBundleSha256 = '',
  [string]$SourceSnapshot = '',
  [string]$SourceSnapshotSha256 = '',
  [string]$WindowsJobRunnerPath = ''
)
$ErrorActionPreference = 'Stop'

$Repo = 'https://github.com/GOD13emad/ChatGPTRemoteCommander.git'

if ($PowerMode -and $StandardMode) {
  throw 'Use only one of -PowerMode or -StandardMode.'
}
if ($GuiControl -and $DisableGuiControl) {
  throw 'Use only one of -GuiControl or -DisableGuiControl.'
}
if ($GuiControl -and $StandardMode) {
  throw '-GuiControl cannot be combined with -StandardMode.'
}
if ($SourceRef -notmatch '^[A-Za-z0-9._/-]{1,128}$') {
  throw 'Invalid -SourceRef.'
}
if ($ExpectedCommit -and $ExpectedCommit -notmatch '^[0-9a-fA-F]{40}$') {
  throw 'Invalid -ExpectedCommit SHA.'
}
# Verify SHA and archive paths before prerequisites; helper owns the detail.
if($SourceSnapshot){if($SourceBundle){throw 'SHALLOW_SOURCE_AND_BUNDLE_MUTUALLY_EXCLUSIVE'};$sourceHelper=Join-Path $PSScriptRoot 'offline-shallow-source.ps1';if(-not(Test-Path -LiteralPath $sourceHelper -PathType Leaf)){$sourceHelper=Join-Path $PSScriptRoot 'tools\offline-shallow-source.ps1'};& pwsh.exe -NoLogo -NoProfile -NonInteractive -File $sourceHelper -Mode Preflight -SourceRef $SourceRef -ExpectedCommit $ExpectedCommit -Archive $SourceSnapshot -ArchiveSha256 $SourceSnapshotSha256 | Out-Null;if($LASTEXITCODE -ne 0){throw 'SHALLOW_SOURCE_PREFLIGHT_FAILED'}}elseif($SourceSnapshotSha256){throw 'SHALLOW_SOURCE_SHA_WITHOUT_ARCHIVE'}
# Persist an exact-commit source bundle at one stable per-user path. The installer
# temp directory is ephemeral; the Git remote must remain usable for later updates.
if($SourceBundle){
  if($SourceBundleSha256 -notmatch '^[0-9a-fA-F]{64}$'){throw 'Source bundle SHA-256 is required.'}
  if(-not $ExpectedCommit -or $ExpectedCommit -notmatch '^[0-9a-fA-F]{40}$'){throw 'Source bundle requires an exact ExpectedCommit.'}
  if(-not [IO.Path]::IsPathFullyQualified($SourceBundle)){throw 'Source bundle path must be absolute.'}
  if(-not(Get-Command git.exe -ErrorAction SilentlyContinue)){throw 'GIT_REQUIRED_FOR_SOURCE_BUNDLE'}
  $file=Get-Item -LiteralPath $SourceBundle -ErrorAction Stop
  if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      [IO.Path]::GetExtension($file.FullName) -ne '.bundle'){throw 'SOURCE_BUNDLE_PATH_UNTRUSTED'}
  $digest=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  if($digest -ne $SourceBundleSha256.ToLowerInvariant()){throw 'SOURCE_BUNDLE_SHA256_MISMATCH'}
  $heads=@(& git.exe bundle list-heads $file.FullName)
  if($LASTEXITCODE -ne 0 -or -not($heads|Where-Object{$_ -match ('^'+[regex]::Escape($ExpectedCommit.ToLowerInvariant())+'\s+refs/heads/')})){
    throw 'SOURCE_BUNDLE_EXPECTED_COMMIT_MISSING'
  }
  $bundleRoot=Join-Path $env:LOCALAPPDATA 'ChatGPTRemoteCommander\source-bundles'
  if(-not(Test-Path -LiteralPath $bundleRoot)){New-Item -ItemType Directory -Force -Path $bundleRoot|Out-Null}
  $bundleRootItem=Get-Item -LiteralPath $bundleRoot -Force
  if(($bundleRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'SOURCE_BUNDLE_STORE_REPARSE_REJECTED'}
  $persistentBundle=Join-Path $bundleRoot 'core.bundle'
  $storedSha=''
  if(Test-Path -LiteralPath $persistentBundle -PathType Leaf){
    $stored=Get-Item -LiteralPath $persistentBundle -Force
    if(($stored.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'SOURCE_BUNDLE_STORE_FILE_REPARSE_REJECTED'}
    $storedSha=(Get-FileHash -LiteralPath $persistentBundle -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  if($storedSha -cne $digest){
    $bundleTemp=$persistentBundle+'.stage-'+$PID
    if(Test-Path -LiteralPath $bundleTemp){throw 'SOURCE_BUNDLE_STAGE_COLLISION'}
    try{
      Copy-Item -LiteralPath $file.FullName -Destination $bundleTemp
      $stagedSha=(Get-FileHash -LiteralPath $bundleTemp -Algorithm SHA256).Hash.ToLowerInvariant()
      if($stagedSha -cne $digest){throw 'SOURCE_BUNDLE_STAGE_SHA_MISMATCH'}
      Move-Item -LiteralPath $bundleTemp -Destination $persistentBundle -Force
    }finally{
      if(Test-Path -LiteralPath $bundleTemp){Remove-Item -LiteralPath $bundleTemp -Force -ErrorAction SilentlyContinue}
    }
  }
  $storedSha=(Get-FileHash -LiteralPath $persistentBundle -Algorithm SHA256).Hash.ToLowerInvariant()
  if($storedSha -cne $digest){throw 'SOURCE_BUNDLE_PERSISTED_SHA_MISMATCH'}
  $Repo=$persistentBundle
  Write-Host ('SOURCE_BUNDLE_PERSISTED path='+$Repo+' sha256='+$digest)
}elseif($SourceBundleSha256){throw 'SOURCE_BUNDLE_SHA_WITHOUT_FILE'}
function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path','Machine')
  $user = [Environment]::GetEnvironmentVariable('Path','User')
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $segments = foreach ($raw in @($env:Path, $machine, $user)) {
    if ([string]::IsNullOrWhiteSpace($raw)) { continue }
    foreach ($segment in ($raw -split ';')) {
      $trimmed = $segment.Trim()
      if ($trimmed -and $seen.Add($trimmed)) { $trimmed }
    }
  }
  $env:Path = $segments -join ';'
}

function Require-Windows {
  if ([string]::IsNullOrWhiteSpace($env:WINDIR)) {
    throw 'This installer currently supports Windows only.'
  }
}

function Resolve-InstallDir {
  if (-not [string]::IsNullOrWhiteSpace($InstallDir)) {
    return [IO.Path]::GetFullPath($InstallDir)
  }

  $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $runValue = (Get-ItemProperty -Path $runKey -Name 'ChatGPTRemoteCommander' -ErrorAction SilentlyContinue).ChatGPTRemoteCommander
  if ($runValue) {
    $match = [regex]::Match([string]$runValue, '-File\s+"([^"]*autostart-windows\.ps1)"', 'IgnoreCase')
    if (-not $match.Success) {
      $match = [regex]::Match([string]$runValue, '-File\s+([^\s]+autostart-windows\.ps1)', 'IgnoreCase')
    }
    if ($match.Success) {
      $candidate = Split-Path -Parent $match.Groups[1].Value
      if (Test-Path -LiteralPath (Join-Path $candidate '.git')) {
        $resolved = [IO.Path]::GetFullPath($candidate)
        Write-Host "Detected active installation from Windows autostart: $resolved"
        return $resolved
      }
    }
  }

  $stateRoot = Join-Path $env:LOCALAPPDATA 'ChatGPTRemoteCommander'
  if (Test-Path -LiteralPath (Join-Path $stateRoot '.git')) {
    $resolved = [IO.Path]::GetFullPath($stateRoot)
    Write-Host "Detected legacy installation: $resolved"
    return $resolved
  }

  $resolved = Join-Path $stateRoot 'app'
  Write-Host "Using application directory: $resolved"
  return $resolved
}

function Ensure-Command([string]$Name, [string]$WingetId) {
  if (Get-Command $Name -ErrorAction SilentlyContinue) {
    return
  }
  if (-not $InstallPrerequisites) {
    throw "$Name is required. Re-run with -InstallPrerequisites or install $WingetId manually."
  }
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw "winget is required to auto-install $Name."
  }

  Write-Host "Installing $Name via winget ($WingetId)..."
  & winget.exe install --id $WingetId -e --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "winget failed installing $WingetId ($LASTEXITCODE)"
  }

  Refresh-Path
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name was installed but is not yet visible on PATH. Open a new terminal and re-run the installer."
  }
}

function Test-PatchedNodeVersion([string]$Version) {
  if ($Version -notmatch '^v(22|24|26)\.[0-9]{1,3}\.[0-9]{1,3}$') { return $false }
  try { $parsed = [version]::Parse($Version.Substring(1)) } catch { return $false }
  switch ($parsed.Major) {
    22 { return ($parsed -ge [version]'22.23.4') }
    24 { return ($parsed -ge [version]'24.22.1') }
    26 { return ($parsed -ge [version]'26.12.1') }
    default { return $false }
  }
}

function Ensure-Prerequisites {
  Ensure-Command 'git.exe' 'Git.Git'
  Ensure-Command 'node.exe' 'OpenJS.NodeJS.LTS'
  Ensure-Command 'pwsh.exe' 'Microsoft.PowerShell'

  $nodeVersion = (& node.exe --version).Trim()
  if (-not (Test-PatchedNodeVersion $nodeVersion)) {
    throw "Patched supported Node.js LTS is required (22.23.4+, 24.22.1+, or 26.12.1+); found $nodeVersion."
  }
}

function Invoke-ExistingSafeUpdate {
  $temp = Join-Path $env:TEMP ("ChatGPTRemoteCommander-updater-" + $PID + "-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temp | Out-Null
  try {
    & git.exe -C $temp init | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'updater git init failed' }
    & git.exe -C $temp remote add origin $Repo
    if ($LASTEXITCODE -ne 0) { throw 'updater git remote failed' }
    & git.exe -C $temp fetch --depth 1 --no-tags origin $SourceRef
    if ($LASTEXITCODE -ne 0) { throw "updater fetch failed for $SourceRef" }
    $commit = (& git.exe -C $temp rev-parse 'FETCH_HEAD^{commit}').Trim().ToLowerInvariant()
    if ($commit -notmatch '^[0-9a-f]{40}$') { throw 'updater fetched commit invalid' }
    if ($ExpectedCommit -and $commit -ne $ExpectedCommit.ToLowerInvariant()) {
      throw "updater commit $commit does not match ExpectedCommit $ExpectedCommit"
    }
    & git.exe -C $temp checkout --detach $commit | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'updater checkout failed' }
    $candidatePackage=Get-Content -LiteralPath (Join-Path $temp 'package.json') -Raw | ConvertFrom-Json
    if([string]$candidatePackage.version -like '0.12.*'){
      Push-Location $temp
      try{
        & node.exe '.\tools\verify-v012-publish-readiness.mjs' ([string]$candidatePackage.version) $SourceRef | Out-Null
        $admissionExit=$LASTEXITCODE
        if($admissionExit -ne 0){throw 'V012_INSTALL_RELEASE_TRAIN_NOT_APPROVED'}
      }finally{Pop-Location}
    }

    $updater = Join-Path $temp 'auto-update-windows.ps1'
    if (-not (Test-Path -LiteralPath $updater -PathType Leaf)) { throw 'candidate auto-update-windows.ps1 missing' }
    $args = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$updater,'-InstallDir',$InstallDir,'-SourceRef',$SourceRef,'-ExpectedCommit',$commit,'-Force')
    if ($SourceBundle) { $args += @('-SourceBundle',$Repo,'-SourceBundleSha256',$SourceBundleSha256) }
    if ($SourceSnapshot) { $args += @('-SourceSnapshotRepo',$Repo) }
    if ($WindowsJobRunnerPath) { $args += @('-WindowsJobRunnerPath',$WindowsJobRunnerPath) }
    if ($PowerMode) { $args += '-PowerMode' }
    if ($StandardMode) { $args += '-StandardMode' }
    if ($GuiControl) { $args += '-GuiControl' }
    if ($DisableGuiControl) { $args += '-DisableGuiControl' }
    if ($DisableCapability.Count -gt 0) { $args += '-DisableCapability'; $args += $DisableCapability }
    if ($EnableCapability.Count -gt 0) { $args += '-EnableCapability'; $args += $EnableCapability }

    & pwsh.exe @args
    if ($LASTEXITCODE -ne 0) { throw "candidate-first update failed: $LASTEXITCODE" }
    & git.exe -C $InstallDir remote set-url origin $Repo
    if ($LASTEXITCODE -ne 0) { throw 'SOURCE_REMOTE_UPDATE_FAILED' }
    if ($WindowsJobRunnerPath) {
      Install-WindowsJobRunner -SourcePath $WindowsJobRunnerPath -ManifestRoot $temp
    }
    Write-Host "SAFE_UPDATE_PASS commit=$commit"
  } finally {
    if (Test-Path -LiteralPath $temp) {
      try {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction Stop
      } catch {
        Write-Warning ("UPDATER_TEMP_CLEANUP_DEFER path={0} error={1}" -f $temp,$_.Exception.Message)
      }
    }
  }
}

function Ensure-ProjectProvider {
  Write-Host 'PROJECT_PROVIDER_DISABLED policy=NO_CODEX_VIA_COMMANDER'
}

function Install-Source {
  $parent = Split-Path -Parent $InstallDir
  New-Item -ItemType Directory -Force -Path $parent | Out-Null

  if (Test-Path -LiteralPath (Join-Path $InstallDir '.git')) {
    $dirty = & git.exe -C $InstallDir status --porcelain --untracked-files=no
    if ($LASTEXITCODE -ne 0) {
      throw 'git status failed'
    }
    if ($dirty) {
      throw 'Tracked local changes exist in InstallDir. Commit or stash them before update; installer will not overwrite them.'
    }

    Write-Host "Fetching source ref '$SourceRef' for existing installation: $InstallDir"
    & git.exe -C $InstallDir fetch --no-tags origin $SourceRef
    if ($LASTEXITCODE -ne 0) {
      throw "git fetch failed for SourceRef $SourceRef"
    }

    $resolved = (& git.exe -C $InstallDir rev-parse 'FETCH_HEAD^{commit}').Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $resolved -notmatch '^[0-9a-f]{40}$') {
      throw 'Could not peel fetched source ref to a commit.'
    }
    if ($ExpectedCommit -and $resolved -ne $ExpectedCommit.ToLowerInvariant()) {
      throw "Fetched commit $resolved does not match ExpectedCommit $ExpectedCommit."
    }

    $currentRaw = & git.exe -C $InstallDir rev-parse HEAD 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($currentRaw)) {
      throw 'InstallDir contains an incomplete Git checkout with no HEAD. Move/remove that failed installation and retry.'
    }
    $current = $currentRaw.Trim().ToLowerInvariant()
    if ($current -ne $resolved) {
      & git.exe -C $InstallDir merge-base --is-ancestor $current $resolved
      if ($LASTEXITCODE -ne 0) {
        throw 'Refusing non-fast-forward update or downgrade of active installation.'
      }
      & git.exe -C $InstallDir merge --ff-only $resolved
      if ($LASTEXITCODE -ne 0) {
        throw 'git fast-forward update failed'
      }
    }
  } elseif (Test-Path -LiteralPath $InstallDir) {
    throw "InstallDir exists but is not a Git checkout: $InstallDir"
  } else {
    Write-Host "Installing source ref '$SourceRef' to $InstallDir"
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $sourceReady = $false
    try {
      & git.exe -C $InstallDir init
      if ($LASTEXITCODE -ne 0) { throw 'git init failed' }
      & git.exe -C $InstallDir remote add origin $Repo
      if ($LASTEXITCODE -ne 0) { throw 'git remote add failed' }
      & git.exe -C $InstallDir fetch --depth 1 --no-tags origin $SourceRef
      if ($LASTEXITCODE -ne 0) { throw "git fetch failed for SourceRef $SourceRef" }

      $resolved = (& git.exe -C $InstallDir rev-parse 'FETCH_HEAD^{commit}').Trim().ToLowerInvariant()
      if ($LASTEXITCODE -ne 0 -or $resolved -notmatch '^[0-9a-f]{40}$') {
        throw 'Could not peel fetched source ref to a commit.'
      }
      if ($ExpectedCommit -and $resolved -ne $ExpectedCommit.ToLowerInvariant()) {
        throw "Fetched commit $resolved does not match ExpectedCommit $ExpectedCommit."
      }

      & git.exe -C $InstallDir checkout --detach $resolved
      if ($LASTEXITCODE -ne 0) { throw 'git checkout failed' }
      $sourceReady = $true
    } finally {
      if (-not $sourceReady -and (Test-Path -LiteralPath $InstallDir)) {
        Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
  }

  $head = (& git.exe -C $InstallDir rev-parse HEAD).Trim().ToLowerInvariant()
  if ($ExpectedCommit -and $head -ne $ExpectedCommit.ToLowerInvariant()) {
    throw "Installed HEAD $head does not match ExpectedCommit $ExpectedCommit."
  }
  Write-Host "Source commit: $head"
}

function Install-WindowsJobRunner([string]$SourcePath = '', [string]$ManifestRoot = $InstallDir) {
  $helper=Join-Path $ManifestRoot 'tools\windows-job-runner\install-windows-job-runner.ps1'
  if(-not(Test-Path -LiteralPath $helper -PathType Leaf)){throw 'WINDOWS_JOB_RUNNER_INSTALL_HELPER_MISSING'}
  . $helper
  Install-CommanderWindowsJobRunner -InstallDir $InstallDir -SourcePath $SourcePath -ManifestRoot $ManifestRoot
}

function Write-TunnelClientState([string]$ExePath) {
  $varDir = Join-Path $InstallDir 'var'
  New-Item -ItemType Directory -Force -Path $varDir | Out-Null

  $state = [ordered]@{
    version = $TunnelClientVersion
    path = [IO.Path]::GetFullPath($ExePath)
    sha256 = (Get-FileHash -LiteralPath $ExePath -Algorithm SHA256).Hash.ToLowerInvariant()
    recordedAt = (Get-Date).ToUniversalTime().ToString('o')
  }

  $target = Join-Path $varDir 'tunnel-client.json'
  $tmp = "$target.tmp-$PID"
  [IO.File]::WriteAllText($tmp, ($state | ConvertTo-Json -Depth 4) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $tmp -Destination $target -Force
}

function Install-TunnelClient {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -match 'ARM64') { 'arm64' } else { 'amd64' }
  $toolDir = Join-Path $InstallDir "tools\tunnel-client-v$TunnelClientVersion-windows-$arch"
  $exe = Join-Path $toolDir 'tunnel-client.exe'

  if ($SkipTunnelClient) {
    if (Test-Path -LiteralPath $exe -PathType Leaf) {
      Write-TunnelClientState $exe
      Write-Host "Reusing pinned tunnel client: $exe"
      return
    }
    Write-Host "Skipping tunnel-client installation as requested; no pinned client exists in this fresh/custom install."
    return
  }

  if (Test-Path -LiteralPath $exe -PathType Leaf) {
    Write-TunnelClientState $exe
    Write-Host "Tunnel client already installed and pinned: $exe"
    return
  }

  $tag = "v$TunnelClientVersion"
  $file = "tunnel-client-v$TunnelClientVersion-windows-$arch.zip"
  $base = "https://github.com/openai/tunnel-client/releases/download/$tag"
  $tmp = Join-Path $env:LOCALAPPDATA "ChatGPTRemoteCommander\downloads\$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null

  try {
    Write-Host "Downloading official OpenAI tunnel-client $tag..."
    Invoke-WebRequest "$base/$file" -OutFile (Join-Path $tmp $file)
    Invoke-WebRequest "$base/SHA256SUMS.txt" -OutFile (Join-Path $tmp 'SHA256SUMS.txt')

    $line = Get-Content (Join-Path $tmp 'SHA256SUMS.txt') |
      Where-Object { $_ -match [regex]::Escape($file) } |
      Select-Object -First 1

    if (-not $line) {
      throw 'Could not find tunnel-client archive in SHA256SUMS.txt'
    }

    $expected = ($line -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash (Join-Path $tmp $file) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -ne $actual) {
      throw "Tunnel client checksum mismatch: expected $expected actual $actual"
    }

    New-Item -ItemType Directory -Force -Path $toolDir | Out-Null
    Expand-Archive -LiteralPath (Join-Path $tmp $file) -DestinationPath $toolDir -Force
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
      throw 'tunnel-client.exe missing after extraction'
    }

    Write-TunnelClientState $exe
    Write-Host "Tunnel client verified, installed and pinned: $exe"
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Configure-LocalPolicy {
  $defaultRoot = Join-Path $env:USERPROFILE 'source\repos'
  New-Item -ItemType Directory -Force -Path $defaultRoot | Out-Null

  $localConfig = Join-Path $InstallDir 'config.local.json'
  $publicConfig = Join-Path $InstallDir 'config.json'
  $migrator = Join-Path $InstallDir 'tools\capability-migrate.mjs'
  if (-not (Test-Path -LiteralPath $migrator -PathType Leaf)) {
    throw 'capability-migrate.mjs is missing.'
  }

  $args = @(
    $migrator,
    '--default', $publicConfig,
    '--output', $localConfig,
    '--profile-id', 'default',
    '--backup-root', (Join-Path $InstallDir 'var\update-backups'),
    '--workflow-dir', (Join-Path $env:LOCALAPPDATA 'ChatGPTRemoteCommander\instances\default\workflows')
  )
  if ($isCanonicalLiveInstall -or $StartServer) { $args += @('--provider-root', $stateRoot) }
  if (Test-Path -LiteralPath $localConfig -PathType Leaf) { $args += @('--existing', $localConfig) }
  if ($PowerMode) { $args += '--request-power' }
  if ($StandardMode) { $args += '--request-standard' }
  if ($GuiControl) { $args += '--gui-on' }
  if ($DisableGuiControl) { $args += '--gui-off' }
  foreach($cap in $DisableCapability){ $args += @('--disable-capability',$cap) }
  foreach($cap in $EnableCapability){ $args += @('--enable-capability',$cap) }

  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $raw = & $node @args
  if ($LASTEXITCODE -ne 0) { throw 'Capability/config migration failed.' }
  try { $migration = $raw | ConvertFrom-Json } catch { throw 'Capability/config migration returned invalid JSON.' }
  if ($migration.status -ne 'CAPABILITY_MIGRATION_PASS' -or $migration.selfTest.code -ne 'OK') { throw 'CONFIG_REGRESSION' }

  $effective = Get-Content -LiteralPath $localConfig -Raw | ConvertFrom-Json
  Write-Host "Local policy active: $localConfig"
  Write-Host "Capability profile: $($migration.tier) explicit=$($migration.explicitlyAuthorized) persistent=$($migration.persistAcrossUpdates)"
  Write-Host "GUI Control: $(if ($effective.powerMode.guiControl.enabled) {'ENABLED'} else {'disabled'})"
  Write-Host "Permanent delete: $(if ($effective.powerMode.allowPermanentDelete) {'ENABLED'} else {'disabled'})"
  Write-Host "Capability self-test: $($migration.selfTest.code)"
}
function Test-Installation {
  Push-Location -LiteralPath $InstallDir
  try {
    & npm.cmd run check:qualification
    if ($LASTEXITCODE -ne 0) {
      throw 'npm run check:qualification failed'
    }
    & npm.cmd run test:qualification
    if ($LASTEXITCODE -ne 0) {
      throw 'npm run test:qualification failed'
    }
    & npm.cmd run audit
    if ($LASTEXITCODE -ne 0) {
      throw 'security audit failed'
    }
  } finally {
    Pop-Location
  }
}

function Get-ExpectedConfigHash {
  $local = Join-Path $InstallDir 'config.local.json'
  $active = if (Test-Path -LiteralPath $local -PathType Leaf) { $local } else { Join-Path $InstallDir 'config.json' }
  return (Get-FileHash -LiteralPath $active -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-OwnedMcpProcess([object]$Health) {
  $listener = Get-NetTCPConnection -State Listen -LocalPort 47831 -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $listener) {
    return $null
  }

  $stateFile = Join-Path $InstallDir 'var\mcp-runtime.json'
  if (Test-Path -LiteralPath $stateFile -PathType Leaf) {
    try {
      $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
      if ($listener.OwningProcess -eq [int]$state.pid -and
          [IO.Path]::GetFullPath([string]$state.projectDir) -eq [IO.Path]::GetFullPath($InstallDir)) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
        if ($proc.Name -eq 'node.exe' -and $proc.CommandLine -match 'src[\\/]server-v0\.3\.mjs') {
          return $proc
        }
      }
    } catch {
    }
  }

  if ($Health -and $Health.ok -and $Health.name -eq 'chatgpt-remote-commander') {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($proc.Name -eq 'node.exe' -and $proc.CommandLine -match 'src[\\/]server-v0\.3\.mjs') {
      Write-Host 'Using legacy MCP ownership migration check for pre-v0.5 runtime.'
      return $proc
    }
  }

  return $null
}

function Start-LocalServer {
  if (-not $StartServer) {
    return
  }

  $expectedVersion = (Get-Content -LiteralPath (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json).version
  $expectedConfig = Get-ExpectedConfigHash
  $health = $null
  try {
    $health = Invoke-RestMethod 'http://127.0.0.1:47831/health' -TimeoutSec 2
  } catch {
  }

  if ($health.ok -and $health.version -eq $expectedVersion -and $health.configSha256 -eq $expectedConfig) {
    Write-Host "MCP server is already healthy at version $expectedVersion with matching config."
    return
  }

  $listener = Get-NetTCPConnection -State Listen -LocalPort 47831 -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $owned = Get-OwnedMcpProcess $health
    if (-not $owned) {
      throw 'Port 47831 is not owned by this installation; refusing automatic stop.'
    }
    Write-Host 'Restarting owned MCP for version or configuration change...'
    Stop-Process -Id $owned.ProcessId -Force
  }

  $rootPattern = [regex]::Escape([IO.Path]::GetFullPath($InstallDir))
  $supervisor = Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'autostart-windows\.ps1' -and $_.CommandLine -match $rootPattern } |
    Select-Object -First 1

  if (-not $supervisor) {
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    $out = Join-Path $InstallDir 'var\mcp-install.out.log'
    $err = Join-Path $InstallDir 'var\mcp-install.err.log'
    New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'var') | Out-Null
    Start-Process -FilePath $npm -ArgumentList @('start','--silent') -WorkingDirectory $InstallDir -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err | Out-Null
  }

  foreach ($i in 1..40) {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-RestMethod 'http://127.0.0.1:47831/health' -TimeoutSec 1
      if ($health.ok -and $health.version -eq $expectedVersion -and $health.configSha256 -eq $expectedConfig) {
        Write-Host "Server ready at version $expectedVersion with matching configuration."
        return
      }
    } catch {
    }
  }

  throw 'Server startup did not reach expected version/configuration.'
}

Require-Windows
Refresh-Path
$InstallDir = Resolve-InstallDir
$canonicalLiveInstall=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'ChatGPTRemoteCommander\app'))
$isCanonicalLiveInstall=([IO.Path]::GetFullPath($InstallDir).TrimEnd('\') -ieq $canonicalLiveInstall.TrimEnd('\'))
Ensure-Prerequisites
if($SourceSnapshot){$store=Join-Path $env:LOCALAPPDATA 'ChatGPTRemoteCommander\source-snapshots';$receipt=@(& pwsh.exe -NoLogo -NoProfile -NonInteractive -File $sourceHelper -Mode Import -SourceRef $SourceRef -ExpectedCommit $ExpectedCommit -Archive $SourceSnapshot -ArchiveSha256 $SourceSnapshotSha256 -StoreRoot $store);if($LASTEXITCODE -ne 0){throw 'SHALLOW_SOURCE_IMPORT_FAILED'};$record=$receipt|Select-Object -Last 1|ConvertFrom-Json;if($record.status -notin @('SHALLOW_SOURCE_IMPORTED','SHALLOW_SOURCE_ALREADY_IMPORTED') -or -not $record.repoRoot){throw 'SHALLOW_SOURCE_IMPORT_RECEIPT_INVALID'};$Repo=[string]$record.repoRoot}

$existingInstall = Test-Path -LiteralPath (Join-Path $InstallDir '.git')
if ($existingInstall -and $isCanonicalLiveInstall) {
  Invoke-ExistingSafeUpdate
  $effectivePath = Join-Path $InstallDir 'config.local.json'
  $route = Join-Path $env:LOCALAPPDATA 'ChatGPTRemoteCommander\routing\default.json'
  if (Test-Path -LiteralPath $route -PathType Leaf) {
    try {
      $routeState = Get-Content -LiteralPath $route -Raw | ConvertFrom-Json
      if ($routeState.active.configPath -and (Test-Path -LiteralPath ([string]$routeState.active.configPath) -PathType Leaf)) {
        $effectivePath = [string]$routeState.active.configPath
      }
    } catch {}
  }
  $effective = Get-Content -LiteralPath $effectivePath -Raw | ConvertFrom-Json
} else {
  if ($existingInstall -and -not $isCanonicalLiveInstall) {
    Write-Host "Updating isolated/custom checkout in place without global routing mutation: $InstallDir"
  }
  if ($GuiControl -and -not $PowerMode) { throw '-GuiControl requires -PowerMode for a fresh installation.' }
  Install-Source
  if($StartServer){
    $candidatePackage=Get-Content -LiteralPath (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json
    if([string]$candidatePackage.version -like '0.12.*'){
      Push-Location $InstallDir
      try{
        & node.exe '.\tools\verify-v012-publish-readiness.mjs' ([string]$candidatePackage.version) $SourceRef | Out-Null
        $admissionExit=$LASTEXITCODE
        if($admissionExit -ne 0){throw 'V012_INSTALL_RELEASE_TRAIN_NOT_APPROVED'}
      }finally{Pop-Location}
    }
  }
  Install-WindowsJobRunner -SourcePath $WindowsJobRunnerPath
  Install-TunnelClient
  Ensure-ProjectProvider
  Configure-LocalPolicy
  Test-Installation
  Start-LocalServer
  $effective = Get-Content -LiteralPath (Join-Path $InstallDir 'config.local.json') -Raw | ConvertFrom-Json

  if ($StartServer) {
    $head = (& git.exe -C $InstallDir rev-parse HEAD).Trim().ToLowerInvariant()
    $updater = Join-Path $InstallDir 'auto-update-windows.ps1'
    $args = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$updater,'-InstallDir',$InstallDir,'-SourceRef',$SourceRef,'-ExpectedCommit',$head,'-Force')
    if ($SourceBundle) { $args += @('-SourceBundle',$Repo,'-SourceBundleSha256',$SourceBundleSha256) }
    if ($SourceSnapshot) { $args += @('-SourceSnapshotRepo',$Repo) }
    if ($PowerMode) { $args += '-PowerMode' }
    if ($StandardMode) { $args += '-StandardMode' }
    if ($GuiControl) { $args += '-GuiControl' }
    if ($DisableGuiControl) { $args += '-DisableGuiControl' }
    if ($DisableCapability.Count -gt 0) { $args += '-DisableCapability'; $args += $DisableCapability }
    if ($EnableCapability.Count -gt 0) { $args += '-EnableCapability'; $args += $EnableCapability }
    & pwsh.exe @args
    if ($LASTEXITCODE -ne 0) { throw 'fresh-install routing/bootstrap validation failed' }

    $route = Join-Path $env:LOCALAPPDATA 'ChatGPTRemoteCommander\routing\default.json'
    if (Test-Path -LiteralPath $route -PathType Leaf) {
      $routeState = Get-Content -LiteralPath $route -Raw | ConvertFrom-Json
      if ($routeState.active.configPath -and (Test-Path -LiteralPath ([string]$routeState.active.configPath) -PathType Leaf)) {
        $effective = Get-Content -LiteralPath ([string]$routeState.active.configPath) -Raw | ConvertFrom-Json
      }
    }
  }
}

Write-Host ''
Write-Host 'INSTALL_PASS'
Write-Host "Installed at: $InstallDir"
Write-Host "Source commit: $((& git.exe -C $InstallDir rev-parse HEAD).Trim())"
Write-Host "Mode: $(if ($effective.powerMode.enabled) { if ($effective.powerMode.guiControl.enabled) {'POWER + GUI'} else {'POWER'} } else {'STANDARD'})"
Write-Host ''
Write-Host 'Next: create or reuse your OpenAI Secure MCP Tunnel and run once:'
Write-Host ('  pwsh.exe -NoProfile -File "{0}\connect-chatgpt.ps1"' -f $InstallDir)
Write-Host 'Persistent enrollment manages MCP + tunnel automatically; no repeated Tunnel ID/port/key entry is needed.'
Write-Host 'Do not share the Runtime API key. It is entered locally and stored with Windows DPAPI for this user.'
