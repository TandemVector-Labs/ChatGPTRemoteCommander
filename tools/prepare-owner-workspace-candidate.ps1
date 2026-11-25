[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$ReleaseDirectory,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedBrokerSha256,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedLauncherSha256,
  [ValidateRange(1024,65535)][int]$CandidatePort = 48839,
  [string]$NodePath = ''
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'OWNER_WORKSPACE_CANDIDATE_POWERSHELL7_REQUIRED' }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
$ownerSid = [string]$identity.User.Value
if ($identity.IsSystem -or $session -le 0 -or $env:SESSIONNAME -eq 'Services') {
  throw 'OWNER_WORKSPACE_CANDIDATE_INTERACTIVE_SESSION_REQUIRED'
}
if ($ownerSid -notmatch '^S-1-[0-9]+(?:-[0-9]+)+$') { throw 'OWNER_WORKSPACE_CANDIDATE_OWNER_SID_INVALID' }

$stateRoot = Join-Path $env:LOCALAPPDATA 'ChatGPTRemoteCommander'
$ownerRoot = Join-Path $stateRoot 'owner-workspace-v1'
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $stateRoot 'releases'))
$releaseDir = [IO.Path]::GetFullPath($ReleaseDirectory)
if (-not $releaseDir.StartsWith($releaseRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {
  throw 'OWNER_WORKSPACE_CANDIDATE_RELEASE_PATH_ESCAPE'
}
if (-not (Test-Path -LiteralPath $releaseDir -PathType Container)) { throw 'OWNER_WORKSPACE_CANDIDATE_RELEASE_MISSING' }

$packagePath = Join-Path $releaseDir 'package.json'
$trainPath = Join-Path $releaseDir 'docs\release-train-0.11.json'
$brokerPath = Join-Path $releaseDir 'tools\workspace-owner-broker.mjs'
$launcherPath = Join-Path $releaseDir 'tools\launch-owner-workspace.ps1'
foreach ($file in @($packagePath,$trainPath,$brokerPath,$launcherPath)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'OWNER_WORKSPACE_CANDIDATE_RELEASE_INPUT_MISSING' }
}
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$train = Get-Content -LiteralPath $trainPath -Raw | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^0\.11\.0-dev\.[1-9][0-9]*$' -or [string]$train.sourceVersion -cne $version -or
    $train.publishApproved -ne $false -or $train.autoupdateApproved -ne $false -or $train.installedPromotionApproved -ne $false) {
  throw 'OWNER_WORKSPACE_CANDIDATE_NOT_NOPROMOTE'
}
$brokerHash = (Get-FileHash -LiteralPath $brokerPath -Algorithm SHA256).Hash.ToLowerInvariant()
$launcherHash = (Get-FileHash -LiteralPath $launcherPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($brokerHash -cne $ExpectedBrokerSha256.ToLowerInvariant()) { throw 'OWNER_WORKSPACE_CANDIDATE_BROKER_HASH_MISMATCH' }
if ($launcherHash -cne $ExpectedLauncherSha256.ToLowerInvariant()) { throw 'OWNER_WORKSPACE_CANDIDATE_LAUNCHER_HASH_MISMATCH' }

$configPath = Join-Path $ownerRoot 'config.json'
$authFile = Join-Path $ownerRoot 'auth.key'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf) -or -not (Test-Path -LiteralPath $authFile -PathType Leaf)) {
  throw 'OWNER_WORKSPACE_CANDIDATE_ACTIVE_CONFIG_MISSING'
}
$current = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ([string]$current.ownerName -cne $identity.Name -or [IO.Path]::GetFullPath([string]$current.authFile) -cne [IO.Path]::GetFullPath($authFile)) {
  throw 'OWNER_WORKSPACE_CANDIDATE_ACTIVE_CONFIG_MISMATCH'
}
if ((Get-Content -LiteralPath $authFile -Raw).Trim() -notmatch '^[a-f0-9]{64}$') {
  throw 'OWNER_WORKSPACE_CANDIDATE_AUTH_INVALID'
}
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $CandidatePort -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) { throw 'OWNER_WORKSPACE_CANDIDATE_PORT_IN_USE' }

if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$node = [IO.Path]::GetFullPath($NodePath)
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'OWNER_WORKSPACE_CANDIDATE_NODE_MISSING' }
$nodeVersion = (& $node --version).Trim()
if ($nodeVersion -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$' -or [version]($nodeVersion.TrimStart('v')) -lt [version]'22.0.0') {
  throw 'OWNER_WORKSPACE_CANDIDATE_NODE_VERSION_INVALID'
}
$nodeHash = (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant()

$cua = Join-Path $stateRoot 'adapters\cua-driver\v0.38.0\cua-driver.exe'
if (-not (Test-Path -LiteralPath $cua -PathType Leaf)) { throw 'OWNER_WORKSPACE_CANDIDATE_CUA_MISSING' }
$cuaHash = (Get-FileHash -LiteralPath $cua -Algorithm SHA256).Hash.ToLowerInvariant()

$profile = 'emad-owner-candidate'
$candidateConfig = [ordered]@{}
foreach ($property in $current.PSObject.Properties) { $candidateConfig[$property.Name] = $property.Value }
$candidateConfig['profile'] = $profile
$candidateConfig['port'] = $CandidatePort
$candidateConfig['ownerName'] = $identity.Name
$candidateConfig['ownerSid'] = $ownerSid
$candidateConfig['host'] = '127.0.0.1'
$candidateConfig['authFile'] = $authFile
$configText = ($candidateConfig | ConvertTo-Json -Depth 40) + [Environment]::NewLine
$configCandidatePath = Join-Path $ownerRoot ("candidate-" + $version + "-config.json")

$manifest = [ordered]@{
  schema = 1
  channel = 'candidate'
  version = $version
  releaseDirectory = [IO.Path]::GetFileName($releaseDir)
  brokerSha256 = $brokerHash
  launcherSha256 = $launcherHash
  ownerName = $identity.Name
  ownerSid = $ownerSid
  profile = $profile
  host = '127.0.0.1'
  port = $CandidatePort
  nodePath = $node
  nodeVersion = $nodeVersion
  nodeSha256 = $nodeHash
  cuaDriverPath = [IO.Path]::GetFullPath($cua)
  cuaDriverSha256 = $cuaHash
}
$manifestText = ($manifest | ConvertTo-Json -Depth 10) + [Environment]::NewLine
$manifestPath = Join-Path $ownerRoot ("candidate-" + $version + ".json")
$launcherCandidatePath = Join-Path $ownerRoot ("launch-owner-workspace-candidate-" + $version + ".ps1")

# Same-input reruns are NO-OP; a stale/conflicting candidate is never overwritten.
foreach ($item in @(
  @{Path=$configCandidatePath;Text=$configText},
  @{Path=$manifestPath;Text=$manifestText}
)) {
  if (Test-Path -LiteralPath $item.Path -PathType Leaf) {
    if ([IO.File]::ReadAllText($item.Path) -cne $item.Text) { throw 'OWNER_WORKSPACE_CANDIDATE_STATE_CONFLICT' }
  } else {
    $stream = [IO.File]::Open($item.Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
      $bytes = [Text.UTF8Encoding]::new($false).GetBytes($item.Text)
      $stream.Write($bytes,0,$bytes.Length)
      $stream.Flush($true)
    } finally { $stream.Dispose() }
  }
}
if (Test-Path -LiteralPath $launcherCandidatePath -PathType Leaf) {
  if ((Get-FileHash -LiteralPath $launcherCandidatePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $launcherHash) {
    throw 'OWNER_WORKSPACE_CANDIDATE_LAUNCHER_CONFLICT'
  }
} else {
  [IO.File]::Copy($launcherPath,$launcherCandidatePath,$false)
}

foreach ($file in @($PSCommandPath,$launcherCandidatePath)) {
  $tokens = $null
  $parseErrors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$parseErrors) | Out-Null
  if ($parseErrors.Count -gt 0) { throw 'OWNER_WORKSPACE_CANDIDATE_POWERSHELL_PARSE_FAILED' }
}
$pwsh = Join-Path $PSHOME 'pwsh.exe'
$result = & $pwsh -NoLogo -NoProfile -NonInteractive -File $launcherCandidatePath -ManifestPath $manifestPath -ConfigPath $configCandidatePath -SelfTest
if ($LASTEXITCODE -ne 0) { throw 'OWNER_WORKSPACE_CANDIDATE_SELFTEST_FAILED' }
$receipt = $result | Out-String | ConvertFrom-Json
if ($receipt.ok -ne $true -or $receipt.channel -ne 'candidate' -or [int]$receipt.port -ne $CandidatePort -or
    [string]$receipt.ownerSid -cne $ownerSid -or [string]$receipt.brokerSha256 -cne $brokerHash -or
    [string]$receipt.launcherSha256 -cne $launcherHash -or
    [string]$receipt.nodeVersion -cne $nodeVersion -or [string]$receipt.nodeSha256 -cne $nodeHash) {
  throw 'OWNER_WORKSPACE_CANDIDATE_SELFTEST_RECEIPT_MISMATCH'
}
[ordered]@{
  status = 'OWNER_WORKSPACE_CANDIDATE_STAGED_SELFTEST_PASS'
  version = $version
  profile = $profile
  port = $CandidatePort
  ownerSid = $ownerSid
  brokerSha256 = $brokerHash
  launcherSha256 = $launcherHash
  manifestPath = $manifestPath
  configPath = $configCandidatePath
  launcherPath = $launcherCandidatePath
  brokerStarted = $false
  scheduledTaskChanged = $false
  activeConfigChanged = $false
} | ConvertTo-Json -Compress
