[CmdletBinding()]
param(
  [string]$ManifestPath = '',
  [string]$ConfigPath = '',
  [switch]$SelfTest
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$StateRoot = Join-Path $env:LOCALAPPDATA 'ChatGPTRemoteCommander'
$OwnerRoot = Join-Path $StateRoot 'owner-workspace-v1'
if (-not $ManifestPath) { $ManifestPath = Join-Path $OwnerRoot 'active.json' }
if (-not $ConfigPath) { $ConfigPath = Join-Path $OwnerRoot 'config.json' }
$ManifestPath = [IO.Path]::GetFullPath($ManifestPath)
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
$ownerSid = [string]$identity.User.Value
if ($identity.IsSystem -or $session -le 0 -or $identity.Name -notmatch '^[^\\]+\\[^\\]+$' -or
    $ownerSid -notmatch '^S-1-[0-9]+(?:-[0-9]+)+$') {
  throw 'OWNER_WORKSPACE_INTERACTIVE_ACCOUNT_REQUIRED'
}
if ($env:SESSIONNAME -eq 'Services') { throw 'OWNER_WORKSPACE_SESSION0_FORBIDDEN' }
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw 'OWNER_WORKSPACE_MANIFEST_MISSING' }
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'OWNER_WORKSPACE_CONFIG_MISSING' }

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$thisLauncher = [IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
$actualLauncherHash = (Get-FileHash -LiteralPath $thisLauncher -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualLauncherHash -cne ([string]$manifest.launcherSha256).ToLowerInvariant()) {
  throw 'OWNER_WORKSPACE_LAUNCHER_HASH_MISMATCH'
}
if ([int]$manifest.schema -ne 1 -or [string]$manifest.channel -notin @('active','candidate')) {
  throw 'OWNER_WORKSPACE_MANIFEST_INVALID'
}
if ([string]$manifest.ownerName -cne $identity.Name -or [string]$config.ownerName -cne $identity.Name) {
  throw 'OWNER_WORKSPACE_OWNER_MISMATCH'
}
if ([string]$manifest.ownerSid -cne $ownerSid -or [string]$config.ownerSid -cne $ownerSid) {
  throw 'OWNER_WORKSPACE_OWNER_SID_MISMATCH'
}
if ([string]$manifest.host -cne '127.0.0.1' -or [int]$manifest.port -lt 1024 -or [int]$manifest.port -gt 65535) {
  throw 'OWNER_WORKSPACE_BINDING_INVALID'
}
if ([string]$config.host -cne [string]$manifest.host -or [int]$config.port -ne [int]$manifest.port) {
  throw 'OWNER_WORKSPACE_CONFIG_BINDING_MISMATCH'
}
if ([string]$config.profile -cne [string]$manifest.profile) { throw 'OWNER_WORKSPACE_PROFILE_MISMATCH' }

$releaseRoot = [IO.Path]::GetFullPath((Join-Path $StateRoot 'releases'))
$releaseDir = [IO.Path]::GetFullPath((Join-Path $releaseRoot ([string]$manifest.releaseDirectory)))
if (-not $releaseDir.StartsWith($releaseRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {
  throw 'OWNER_WORKSPACE_RELEASE_PATH_ESCAPE'
}
$releasePackage = Get-Content -LiteralPath (Join-Path $releaseDir 'package.json') -Raw | ConvertFrom-Json
if ([string]$releasePackage.version -cne [string]$manifest.version) {
  throw 'OWNER_WORKSPACE_RELEASE_VERSION_MISMATCH'
}
$entry = Join-Path $releaseDir 'tools\workspace-owner-broker.mjs'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'OWNER_WORKSPACE_BROKER_MISSING' }
$actualBrokerHash = (Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualBrokerHash -cne ([string]$manifest.brokerSha256).ToLowerInvariant() -or
    $actualBrokerHash -notmatch '^[a-f0-9]{64}$') {
  throw 'OWNER_WORKSPACE_BROKER_HASH_MISMATCH'
}

$node = [IO.Path]::GetFullPath([string]$manifest.nodePath)
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'OWNER_WORKSPACE_NODE_MISSING' }
$actualNodeHash = (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualNodeHash -cne ([string]$manifest.nodeSha256).ToLowerInvariant()) {
  throw 'OWNER_WORKSPACE_NODE_HASH_MISMATCH'
}
$nodeVersion = (& $node --version).Trim()
if ($nodeVersion -cne [string]$manifest.nodeVersion -or $nodeVersion -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') {
  throw 'OWNER_WORKSPACE_NODE_VERSION_MISMATCH'
}
if ([version]($nodeVersion.TrimStart('v')) -lt [version]'22.0.0') {
  throw 'OWNER_WORKSPACE_NODE_TOO_OLD'
}

$authFile = [IO.Path]::GetFullPath([string]$config.authFile)
if ([IO.Path]::GetDirectoryName($authFile) -ne [IO.Path]::GetDirectoryName($ConfigPath)) {
  throw 'OWNER_WORKSPACE_AUTH_PATH_INVALID'
}
if (-not (Test-Path -LiteralPath $authFile -PathType Leaf)) { throw 'OWNER_WORKSPACE_AUTH_MISSING' }
if ((Get-Content -LiteralPath $authFile -Raw).Trim() -notmatch '^[a-f0-9]{64}$') {
  throw 'OWNER_WORKSPACE_AUTH_INVALID'
}

$cua = [IO.Path]::GetFullPath([string]$manifest.cuaDriverPath)
$expectedCua = [IO.Path]::GetFullPath((Join-Path $StateRoot 'adapters\cua-driver\v0.38.0\cua-driver.exe'))
if ($cua -cne $expectedCua -or -not (Test-Path -LiteralPath $cua -PathType Leaf)) {
  throw 'OWNER_WORKSPACE_CUA_PATH_INVALID'
}
$cuaHash = (Get-FileHash -LiteralPath $cua -Algorithm SHA256).Hash.ToLowerInvariant()
if ($cuaHash -cne ([string]$manifest.cuaDriverSha256).ToLowerInvariant()) {
  throw 'OWNER_WORKSPACE_CUA_HASH_MISMATCH'
}

$listeners = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$manifest.port) -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) { throw 'OWNER_WORKSPACE_PORT_IN_USE' }

$pipeName = 'rc-workspace-cua-v038-' + [string]$manifest.channel
$pipe = '\\.\pipe\' + $pipeName
$driverProcess = $null
$ownerStdout = Join-Path $OwnerRoot ('cua-' + [string]$manifest.channel + '.stdout.log')
$ownerStderr = Join-Path $OwnerRoot ('cua-' + [string]$manifest.channel + '.stderr.log')
$parsed = $null
$cuaPipeReady = $false

if (-not $SelfTest) {
  $existing = @(Get-CimInstance Win32_Process -Filter "Name='cua-driver.exe'" |
    Where-Object {
      $_.SessionId -eq $session -and $_.ExecutablePath -eq $cua -and
      $_.CommandLine -like ('*' + $pipeName + '*')
    })
  if ($existing.Count -gt 1) { throw 'OWNER_WORKSPACE_CUA_PIPE_AMBIGUOUS' }
  if ($existing.Count -eq 1) {
    # Never terminate or adopt a process whose lifecycle belongs to another invocation.
    throw 'OWNER_WORKSPACE_CUA_PIPE_ORPHAN_REQUIRES_RECONCILIATION'
  }
  try {
    $driverProcess = Start-Process -FilePath $cua -ArgumentList @(
      'serve','--socket',$pipe,'--no-overlay','--permission-mode','standard','--grant','existing-profile'
    ) -WindowStyle Hidden -PassThru -RedirectStandardOutput $ownerStdout -RedirectStandardError $ownerStderr
    Start-Sleep -Seconds 2
    if ($driverProcess.HasExited) { throw 'OWNER_WORKSPACE_CUA_START_FAILED' }

    $owned = Get-CimInstance Win32_Process -Filter "ProcessId=$($driverProcess.Id)" -ErrorAction SilentlyContinue
    if (-not $owned -or $owned.SessionId -ne $session -or $owned.ExecutablePath -cne $cua -or
        $owned.CommandLine -notlike ('*' + $pipeName + '*')) {
      throw 'OWNER_WORKSPACE_CUA_PROCESS_IDENTITY_MISMATCH'
    }
    $probe = & $cua call --socket $pipe list_windows '{}'
    if ($LASTEXITCODE -ne 0) { throw 'OWNER_WORKSPACE_CUA_PIPE_NOT_READY' }
    $parsed = $probe | Out-String | ConvertFrom-Json
    if ($null -eq $parsed.windows) { throw 'OWNER_WORKSPACE_CUA_WINDOWS_INVALID' }
    $cuaPipeReady = $true
  } catch {
    if ($driverProcess -and -not $driverProcess.HasExited) {
      Stop-Process -Id $driverProcess.Id -Force -ErrorAction SilentlyContinue
    }
    throw
  }
} else {
  # Candidate preparation is intentionally task-neutral and performs no CUA start or window discovery.
  $parsed = [pscustomobject]@{ windows = @() }
}

$evidence = [ordered]@{
  ok = $true
  schema = 1
  channel = [string]$manifest.channel
  version = [string]$manifest.version
  releaseDirectory = [string]$manifest.releaseDirectory
  brokerSha256 = $actualBrokerHash
  launcherSha256 = $actualLauncherHash
  owner = $identity.Name
  ownerSid = $ownerSid
  session = $session
  host = [string]$manifest.host
  port = [int]$manifest.port
  nodeVersion = $nodeVersion
  nodeSha256 = $actualNodeHash
  cuaPipeReady = $cuaPipeReady
  windowCount = @($parsed.windows).Count
}

if ($SelfTest) {
  $evidence | ConvertTo-Json -Compress
  exit 0
}

$env:RC_WORKSPACE_OWNER_CONFIG = $ConfigPath
$env:RC_WORKSPACE_CUA_OWNER_PIPE = '1'
$env:RC_WORKSPACE_CUA_PIPE = $pipe
$stdout = Join-Path $OwnerRoot ('broker-' + [string]$manifest.channel + '.stdout.log')
$stderr = Join-Path $OwnerRoot ('broker-' + [string]$manifest.channel + '.stderr.log')
Push-Location $releaseDir
try {
  & $node $entry 1>> $stdout 2>> $stderr
  if ($LASTEXITCODE -ne 0) { throw "OWNER_WORKSPACE_BROKER_EXIT_$LASTEXITCODE" }
} finally {
  Pop-Location
  if ($driverProcess -and -not $driverProcess.HasExited) {
    Stop-Process -Id $driverProcess.Id -Force -ErrorAction SilentlyContinue
  }
}
