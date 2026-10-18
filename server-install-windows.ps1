param(
  [string]$SourceRef = 'v0.10.23',
  [string]$ExpectedCommit = '',
  [ValidateSet('Power','Standard')][string]$AccessMode = 'Power',
  [ValidateSet('Auto','On','Off')][string]$GuiControl = 'Auto',
  [string]$InstallDir = '',
  [switch]$NoStartServer,
  [switch]$PrerequisitesOnly,
  [switch]$KeepDownloads
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
# A short-lived CI token is held only in the installer process memory. Remove the
# environment copy before any child installer/Git/Node process can inherit it.
$script:BootstrapGitHubToken = [Environment]::GetEnvironmentVariable('RC_GITHUB_API_TOKEN','Process')
[Environment]::SetEnvironmentVariable('RC_GITHUB_API_TOKEN',$null,'Process')
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = 'https://github.com/GOD13emad/ChatGPTRemoteCommander.git'
$BootstrapRoot = Join-Path $env:ProgramData 'ChatGPTRemoteCommander\bootstrap'
$ManifestPath = Join-Path $env:ProgramData 'ChatGPTRemoteCommander\server-install-allowlist.json'
$Downloads = Join-Path $BootstrapRoot ('downloads-' + [guid]::NewGuid().ToString('N'))
$Artifacts = New-Object System.Collections.ArrayList
$RebootRecommended = $false

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path','Machine')
  $user = [Environment]::GetEnvironmentVariable('Path','User')
  $env:Path = (($machine,$user) | Where-Object { $_ }) -join ';'
}

function Invoke-Download([string]$Url,[string]$Destination) {
  Write-Host "Downloading $Url"
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination -Headers @{'User-Agent'='ChatGPTRemoteCommander-ServerInstaller/0.10.23'}
  if (-not (Test-Path -LiteralPath $Destination -PathType Leaf)) { throw "Download did not create $Destination" }
}

function Assert-Sha256([string]$Path,[string]$Expected) {
  if ($Expected -notmatch '^[0-9a-fA-F]{64}$') { throw "Invalid expected SHA256 for $Path" }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) { throw "SHA256 mismatch for $Path" }
  return $actual
}

function Assert-Authenticode([string]$Path) {
  $sig = Get-AuthenticodeSignature -LiteralPath $Path
  if ([string]$sig.Status -ne 'Valid') { throw "Authenticode signature is not valid for $Path (status=$($sig.Status))" }
  return [string]$sig.SignerCertificate.Subject
}

function Add-ArtifactEvidence([string]$Name,[string]$Path,[string]$Source,[string]$Sha,[string]$Signer) {
  [void]$Artifacts.Add([ordered]@{
    name=$Name
    source=$Source
    sha256=$Sha
    signer=$Signer
    fileName=[IO.Path]::GetFileName($Path)
  })
}

function Invoke-Msi([string]$Path) {
  $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', $Path, '/qn', '/norestart') -Wait -PassThru
  if ($p.ExitCode -eq 3010) {
    $script:RebootRecommended = $true
    return
  }
  if ($p.ExitCode -ne 0) { throw "MSI install failed with exit code $($p.ExitCode): $Path" }
}

function Get-Architecture {
  $arch = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE')
  if ($arch -eq 'AMD64') { return 'x64' }
  if ($arch -eq 'ARM64') { return 'arm64' }
  throw "Unsupported Windows architecture: $arch"
}

function Ensure-PowerShell7([string]$Arch) {
  $cmd = Get-Command pwsh.exe -ErrorAction SilentlyContinue
  if ($cmd) {
    try {
      $major = [int]((& $cmd.Source -NoLogo -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.Major').Trim())
      if ($major -ge 7) { return $cmd.Source }
    } catch {}
  }

  $version = '7.6.6'
  if ($Arch -eq 'x64') {
    $asset = "PowerShell-$version-win-x64.msi"
    $expected = '958838FF55091E1C8705D89EFED0CC7E8245A3A6EF6C0CCFAE20015227108AD8'
  } else {
    $asset = "PowerShell-$version-win-arm64.msi"
    $expected = '387D0AF8E92BA97F73616C91FA8F29A284E8F82EE6C40FE12DADE971BB05BAC4'
  }
  $url = "https://github.com/PowerShell/PowerShell/releases/download/v$version/$asset"
  $path = Join-Path $Downloads $asset
  Invoke-Download $url $path
  $sha = Assert-Sha256 $path $expected
  $signer = Assert-Authenticode $path
  Add-ArtifactEvidence 'PowerShell' $path $url $sha $signer
  Invoke-Msi $path
  Refresh-Path
  $candidate = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw 'PowerShell 7 installation completed but pwsh.exe was not found.' }
  return $candidate
}

function Ensure-Node([string]$Arch) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) {
    try {
      $major = [int]((& $cmd.Source --version).Trim().TrimStart('v').Split('.')[0])
      if ($major -ge 22) { return $cmd.Source }
    } catch {}
  }

  $existing = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path -LiteralPath $existing -PathType Leaf) {
    try {
      $major = [int]((& $existing --version).Trim().TrimStart('v').Split('.')[0])
      if ($major -ge 22) {
        $sha = (Get-FileHash -LiteralPath $existing -Algorithm SHA256).Hash.ToLowerInvariant()
        $signer = Assert-Authenticode $existing
        Add-ArtifactEvidence 'Node.js' $existing 'existing-installation' $sha $signer
        Write-Host "Reusing verified existing Node.js outside PATH: $existing"
        return $existing
      }
    } catch {
      Write-Host "Existing Node.js outside PATH was not reusable: $($_.Exception.Message)"
    }
  }

  $version = '22.23.3'
  $asset = if ($Arch -eq 'x64') { "node-v$version-x64.msi" } else { "node-v$version-arm64.msi" }
  $base = "https://nodejs.org/dist/v$version"
  $sumsPath = Join-Path $Downloads 'node-SHASUMS256.txt'
  $msiPath = Join-Path $Downloads $asset
  Invoke-Download "$base/SHASUMS256.txt" $sumsPath
  $line = Get-Content -LiteralPath $sumsPath | Where-Object { $_ -match ('\s' + [regex]::Escape($asset) + '$') } | Select-Object -First 1
  if (-not $line -or $line -notmatch '^([0-9a-fA-F]{64})\s+') { throw "Node SHA256 entry not found for $asset" }
  $expected = $Matches[1]
  Invoke-Download "$base/$asset" $msiPath
  $sha = Assert-Sha256 $msiPath $expected
  $signer = Assert-Authenticode $msiPath
  Add-ArtifactEvidence 'Node.js' $msiPath "$base/$asset" $sha $signer
  Invoke-Msi $msiPath
  Refresh-Path
  $candidate = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw 'Node.js installation completed but node.exe was not found.' }
  return $candidate
}

function Ensure-Git([string]$Arch) {
  $cmd = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $existing = Join-Path $env:ProgramFiles 'Git\cmd\git.exe'
  if (Test-Path -LiteralPath $existing -PathType Leaf) {
    try {
      $sha = (Get-FileHash -LiteralPath $existing -Algorithm SHA256).Hash.ToLowerInvariant()
      $signer = Assert-Authenticode $existing
      Add-ArtifactEvidence 'Git for Windows' $existing 'existing-installation' $sha $signer
      Write-Host "Reusing verified existing Git for Windows outside PATH: $existing"
      return $existing
    } catch {
      Write-Host "Existing Git for Windows outside PATH was not reusable: $($_.Exception.Message)"
    }
  }

  # Public GitHub shared runner IPs can exhaust the unauthenticated REST limit.
  # Authentication is optional, fixed to this release-metadata endpoint only.
  $headers = @{
    'User-Agent'='ChatGPTRemoteCommander-ServerInstaller/0.10.23'
    'X-GitHub-Api-Version'='2022-11-28'
  }
  if ($script:BootstrapGitHubToken) {
    $headers['Authorization'] = 'Bearer ' + $script:BootstrapGitHubToken
  }
  try {
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers $headers -TimeoutSec 30
  } finally {
    $script:BootstrapGitHubToken = $null
    [void]$headers.Remove('Authorization')
  }
  if ($release.draft -or $release.prerelease) { throw 'Git for Windows latest release is not stable.' }
  $pattern = if ($Arch -eq 'x64') { '^Git-.*-64-bit\.exe$' } else { '^Git-.*-arm64\.exe$' }
  $asset = @($release.assets | Where-Object { $_.name -match $pattern }) | Select-Object -First 1
  if (-not $asset) { throw "Git for Windows release has no installer for $Arch" }
  $digest = [string]$asset.digest
  if ($digest -notmatch '^sha256:([0-9a-fA-F]{64})$') { throw 'Git for Windows release asset has no usable SHA256 digest.' }
  $expected = $Matches[1]
  $path = Join-Path $Downloads ([string]$asset.name)
  Invoke-Download ([string]$asset.browser_download_url) $path
  $sha = Assert-Sha256 $path $expected
  $signer = Assert-Authenticode $path
  Add-ArtifactEvidence 'Git for Windows' $path ([string]$asset.browser_download_url) $sha $signer
  $p = Start-Process -FilePath $path -ArgumentList @('/VERYSILENT','/NORESTART','/NOCANCEL','/SP-','/CLOSEAPPLICATIONS') -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "Git for Windows installer failed with exit code $($p.ExitCode)" }
  Refresh-Path
  $candidate = Join-Path $env:ProgramFiles 'Git\cmd\git.exe'
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw 'Git installation completed but git.exe was not found.' }
  return $candidate
}

function Get-ServerCoreState {
  try {
    $type = [string](Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name InstallationType -ErrorAction Stop).InstallationType
  } catch {
    $type = 'Unknown'
  }
  return [ordered]@{ installationType=$type; isServerCore=($type -eq 'Server Core') }
}

function Get-DefenderState {
  $available = [bool](Get-Command Get-MpComputerStatus -ErrorAction SilentlyContinue)
  if (-not $available) { return [ordered]@{ available=$false } }
  try {
    $s = Get-MpComputerStatus
    return [ordered]@{
      available=$true
      antivirusEnabled=[bool]$s.AntivirusEnabled
      realTimeProtectionEnabled=[bool]$s.RealTimeProtectionEnabled
      antispywareEnabled=[bool]$s.AntispywareEnabled
    }
  } catch {
    return [ordered]@{ available=$true; queryError=$_.Exception.Message }
  }
}

function Write-AllowlistManifest([string]$Commit,[object]$Server,[object]$Defender) {
  $dir = Split-Path -Parent $ManifestPath
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $doc = [ordered]@{
    schema=1
    generatedAt=(Get-Date).ToUniversalTime().ToString('o')
    releaseRef=$SourceRef
    resolvedCommit=$Commit
    server=$Server
    defender=$Defender
    antivirusExclusionsAdded=$false
    note='No antivirus exclusions are created. Use publisher/hash allowlisting or an administrator-approved narrow exception if enterprise policy blocks a verified artifact.'
    artifacts=@($Artifacts)
  }
  [IO.File]::WriteAllText($ManifestPath,($doc | ConvertTo-Json -Depth 12)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
}

if (-not (Test-Administrator)) { throw 'Run this server installer from an elevated Administrator shell.' }
if ($SourceRef -notmatch '^[A-Za-z0-9._/-]{1,128}$') { throw 'Invalid SourceRef.' }
if ($ExpectedCommit -and $ExpectedCommit -notmatch '^[0-9a-fA-F]{40}$') { throw 'ExpectedCommit must be a 40-hex SHA.' }
if ($AccessMode -eq 'Standard' -and $GuiControl -eq 'On') { throw 'GuiControl On requires AccessMode Power.' }

New-Item -ItemType Directory -Force -Path $Downloads | Out-Null
$server = Get-ServerCoreState
$defender = Get-DefenderState
$arch = Get-Architecture
$stage = Join-Path $env:TEMP ('ChatGPTRemoteCommander-server-stage-' + [guid]::NewGuid().ToString('N'))

try {
  Write-Host "Windows installation type: $($server.installationType); architecture: $arch"
  Write-Host 'Security policy: verified downloads only; no Microsoft Defender exclusions are added.'

  $pwsh = Ensure-PowerShell7 $arch
  $node = Ensure-Node $arch
  $git = Ensure-Git $arch
  Refresh-Path
  $env:Path = @((Split-Path -Parent $node),(Split-Path -Parent $git),$env:Path) -join ';'

  if ($PrerequisitesOnly) {
    Write-AllowlistManifest 'PREREQUISITES_ONLY' $server $defender
    Write-Host "SERVER_PREREQUISITES_PASS pwsh=$pwsh node=$node git=$git"
    return
  }

  New-Item -ItemType Directory -Path $stage | Out-Null
  & $git -C $stage init | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'git init failed in staging directory.' }
  & $git -C $stage remote add origin $Repo
  if ($LASTEXITCODE -ne 0) { throw 'git remote add failed.' }
  & $git -C $stage fetch --depth 1 --no-tags origin $SourceRef
  if ($LASTEXITCODE -ne 0) { throw "git fetch failed for $SourceRef" }
  $resolved = (& $git -C $stage rev-parse 'FETCH_HEAD^{commit}').Trim().ToLowerInvariant()
  if ($resolved -notmatch '^[0-9a-f]{40}$') { throw 'Fetched source did not resolve to a commit.' }
  if ($ExpectedCommit -and $resolved -ne $ExpectedCommit.ToLowerInvariant()) { throw "Resolved commit $resolved does not match ExpectedCommit $ExpectedCommit" }
  & $git -C $stage checkout --detach $resolved | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'git checkout failed.' }
  $package = Get-Content -LiteralPath (Join-Path $stage 'package.json') -Raw | ConvertFrom-Json
  $expectedVersion = [string]$package.version
  if ($expectedVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Staged package version is invalid.' }

  $guiEnabled = $false
  if ($GuiControl -eq 'On') {
    if ($server.isServerCore) { throw 'GUI control cannot be enabled on Windows Server Core. Use -GuiControl Off or Auto.' }
    $guiEnabled = $true
  } elseif ($GuiControl -eq 'Auto') {
    $guiEnabled = -not [bool]$server.isServerCore
  }

  $installer = Join-Path $stage 'install.ps1'
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'Staged install.ps1 is missing.' }
  $args = @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$installer,'-SourceRef',$SourceRef,'-ExpectedCommit',$resolved)
  if ($AccessMode -eq 'Power') { $args += '-PowerMode' } else { $args += '-StandardMode' }
  if ($InstallDir) { $args += @('-InstallDir',$InstallDir) }
  if (-not $NoStartServer) { $args += '-StartServer' }
  if ($guiEnabled -and $AccessMode -eq 'Power') { $args += '-GuiControl' } else { $args += '-DisableGuiControl' }

  & $pwsh @args
  if ($LASTEXITCODE -ne 0) { throw "Remote Commander install.ps1 failed with exit code $LASTEXITCODE" }

  if (-not $NoStartServer) {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:47831/health' -TimeoutSec 5
    if (-not $health.ok -or [string]$health.version -ne $expectedVersion) { throw "Installed MCP health/version validation failed; expected $expectedVersion." }
  }

  Write-AllowlistManifest $resolved $server $defender
  Write-Host ''
  Write-Host 'SERVER_INSTALL_WINDOWS_PASS'
  Write-Host "Source commit: $resolved"
  Write-Host "GUI control: $guiEnabled"
  Write-Host "Allowlist evidence: $ManifestPath"
  Write-Host "Reboot recommended by prerequisite installer: $RebootRecommended"
  Write-Host 'No antivirus exclusions were added.'
} catch {
  Write-AllowlistManifest '' $server $defender
  Write-Error ("SERVER_INSTALL_WINDOWS_FAIL: " + $_.Exception.Message)
  throw
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
  if (-not $KeepDownloads -and (Test-Path -LiteralPath $Downloads)) { Remove-Item -LiteralPath $Downloads -Recurse -Force -ErrorAction SilentlyContinue }
}
