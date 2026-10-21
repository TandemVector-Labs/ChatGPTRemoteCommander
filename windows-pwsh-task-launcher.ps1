param(
  [ValidateSet('Boot','Handoff','UserSupervisor')][string]$Mode = 'Boot',
  [string]$OwnerUserProfile = $env:USERPROFILE,
  [string]$NodePath = '',
  [string]$NpmPath = '',
  [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 is a stable system-owned task entrypoint only.
# Always execute the actual Commander runtime using PowerShell 7.
function Resolve-InstalledPowerShell7 {
  $stable = @()
  foreach ($programFiles in @($env:ProgramFiles,[Environment]::GetEnvironmentVariable('ProgramW6432'))) {
    if (-not [string]::IsNullOrWhiteSpace($programFiles)) {
      $stable += Join-Path $programFiles 'PowerShell\7\pwsh.exe'
    }
  }
  $stable = @($stable | Select-Object -Unique)
  foreach ($candidate in $stable) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return [IO.Path]::GetFullPath($candidate)
    }
  }
  # The Microsoft Store changes its versioned WindowsApps directory on update.
  # Resolve the installed package identity at EACH task invocation, not at setup.
  $packages = @(Get-AppxPackage -AllUsers -Name 'Microsoft.PowerShell' -ErrorAction Stop |
    Where-Object { $_.Name -eq 'Microsoft.PowerShell' -and $_.Publisher -match 'Microsoft Corporation' } |
    Sort-Object Version -Descending)
  foreach ($package in $packages) {
    $install = [IO.Path]::GetFullPath([string]$package.InstallLocation)
    $prefix = Join-Path $env:ProgramFiles 'WindowsApps\Microsoft.PowerShell_'
    if (-not $install.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { continue }
    $candidate = Join-Path $install 'pwsh.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  throw 'BOOT_LAUNCHER_PWSH7_NOT_FOUND: install supported PowerShell 7; task not started.'
}
$pwsh = Resolve-InstalledPowerShell7
if ($SelfTest) {
  Write-Output "BOOT_LAUNCHER_SELFTEST_PASS mode=$Mode"
  exit 0
}
$OwnerUserProfile = [IO.Path]::GetFullPath($OwnerUserProfile)
$ownerLocal = Join-Path $OwnerUserProfile 'AppData\Local'
$ownerRoaming = Join-Path $OwnerUserProfile 'AppData\Roaming'
if ($Mode -eq 'UserSupervisor') {
  # The interactive supervisor cannot use SYSTEM-only machine DPAPI material.
  # Leave the SYSTEM boot supervisor in charge instead of tearing down its tunnel.
  $profiles = Join-Path $ownerRoaming 'tunnel-client'
  foreach ($profile in @(Get-ChildItem -LiteralPath $profiles -Filter '*.yaml' -File -ErrorAction SilentlyContinue)) {
    $credential = Join-Path (Join-Path $ownerLocal 'ChatGPTRemoteCommander\credentials') ($profile.BaseName + '.dpapi')
    if (-not (Test-Path -LiteralPath $credential -PathType Leaf)) {
      Write-Output 'USER_SUPERVISOR_DEFERRED_MACHINE_CREDENTIALS'
      exit 0
    }
    # A present but undecryptable user-scoped key is not usable for handoff.
    try {
      $secure = ConvertTo-SecureString (Get-Content -LiteralPath $credential -Raw)
      $isReady = -not [string]::IsNullOrWhiteSpace([System.Net.NetworkCredential]::new('',$secure).Password)
    } catch {
      $isReady = $false
    } finally {
      $secure = $null
    }
    if (-not $isReady) {
      Write-Output 'USER_SUPERVISOR_DEFERRED_INVALID_USER_CREDENTIAL'
      exit 0
    }
  }
}
$script = if ($Mode -eq 'Handoff') {
  Join-Path $PSScriptRoot 'handoff-user-session-windows.ps1'
} else {
  Join-Path $PSScriptRoot 'autostart-windows.ps1'
}
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw 'BOOT_LAUNCHER_TARGET_MISSING' }
$arguments = @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$script)
switch ($Mode) {
  'Boot' {
    $arguments += @('-CredentialScope','LocalMachine','-BootCore','-OwnerUserProfile',$OwnerUserProfile)
    if ($NodePath) { $arguments += @('-NodePath',$NodePath) }
    if ($NpmPath) { $arguments += @('-NpmPath',$NpmPath) }
  }
  'Handoff' { $arguments += @('-OwnerUserProfile',$OwnerUserProfile) }
}
& $pwsh @arguments
exit $LASTEXITCODE
