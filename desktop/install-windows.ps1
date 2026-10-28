param(
  [string]$SourceDir = '',
  [string]$InstallRoot = '',
  [ValidateSet('Core','ControlMonitoring')][string]$Mode = 'ControlMonitoring',
  [switch]$StageOnly,
  [switch]$NoPublicIntegration,
  [ValidateSet('None','AfterBaselineMove','AfterCandidateMove')][string]$TestFailurePoint='None'
)
$ErrorActionPreference='Stop'

function Assert-CorePublicInstallContext {
  param([string]$IdentitySid,[string]$ProfilePath,[string]$RoamingAppData,[string]$LocalAppData,[int]$SessionId)
  if($IdentitySid -eq 'S-1-5-18'){throw 'CORE_PUBLIC_INSTALL_SYSTEM_CONTEXT'}
  if($IdentitySid -in @('S-1-5-19','S-1-5-20')){throw 'CORE_PUBLIC_INSTALL_SERVICE_CONTEXT'}
  # Session 0 is reserved for services; omitted SessionId defaults to zero (fail closed).
  if($SessionId -le 0){throw 'CORE_PUBLIC_INSTALL_NONINTERACTIVE_SESSION'}
  if([string]::IsNullOrWhiteSpace($IdentitySid) -or [string]::IsNullOrWhiteSpace($ProfilePath) -or
     [string]::IsNullOrWhiteSpace($RoamingAppData) -or [string]::IsNullOrWhiteSpace($LocalAppData)){
    throw 'CORE_PUBLIC_INSTALL_IDENTITY_INCOMPLETE'
  }
  foreach($path in @($ProfilePath,$RoamingAppData,$LocalAppData)){
    if($path -match '(?i)(^|[\\/])ServiceProfiles([\\/]|$)'){
      throw 'CORE_PUBLIC_INSTALL_SERVICEPROFILE_PATH'
    }
    if($path -match '(?i)(^|[\\/])systemprofile([\\/]|$)'){
      throw 'CORE_PUBLIC_INSTALL_SYSTEMPROFILE_PATH'
    }
  }
}

if(-not $NoPublicIntegration -and -not $StageOnly){
  $CurrentWindowsIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
  Assert-CorePublicInstallContext -IdentitySid $CurrentWindowsIdentity.User.Value -ProfilePath $env:USERPROFILE -RoamingAppData $env:APPDATA -LocalAppData $env:LOCALAPPDATA -SessionId ([Diagnostics.Process]::GetCurrentProcess().SessionId)
}

$RepoRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Version=((Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json).version)
if(-not $SourceDir){$SourceDir=Join-Path $RepoRoot 'dist\desktop\remote-commander-windows-x64'}
$SourceDir=[IO.Path]::GetFullPath($SourceDir)
$SourceExe=Join-Path $SourceDir 'RemoteCommander.exe'
if(-not (Test-Path -LiteralPath $SourceExe -PathType Leaf)){throw "Desktop build missing: $SourceExe"}

$required=@('profile-manager-windows.ps1','profile-enrollment-windows.ps1')
if($Mode -eq 'ControlMonitoring'){$required+=@('operations-monitor-windows.ps1','admin-runtime-windows.ps1')}
foreach($tool in $required){
  if(-not(Test-Path -LiteralPath (Join-Path $SourceDir $tool) -PathType Leaf)){throw "Desktop tool missing: $tool"}
}

if(-not $InstallRoot){$InstallRoot=Join-Path $env:LOCALAPPDATA 'Programs\Remote Commander'}
$InstallRoot=[IO.Path]::GetFullPath($InstallRoot)
$selected=@('RemoteCommander.exe','profile-manager-windows.ps1','profile-enrollment-windows.ps1')
if($Mode -eq 'ControlMonitoring'){$selected+=@('operations-monitor-windows.ps1','admin-runtime-windows.ps1')}
$Entries = $selected | ForEach-Object {
  $full=Join-Path $SourceDir $_
  $h=(Get-FileHash -Algorithm SHA256 -LiteralPath $full).Hash.ToLowerInvariant()
  "$_|$h"
} | Sort-Object
$Manifest=$Entries -join "`n"
$PackageSha=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Manifest))).ToLowerInvariant()
$VersionDir=Join-Path $InstallRoot (("v"+$Version+"-")+$PackageSha.Substring(0,12))
$Current=Join-Path $InstallRoot 'current'
$StartMenu=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Remote Commander'
$Reg='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\RemoteCommander'

# R203: immutable update candidate, exactly one current, rollback alias until
# native owner acceptance. Private fault injection is development-root-only.
if($StageOnly -and ($NoPublicIntegration -or $TestFailurePoint -ne 'None')){throw 'R203_STAGE_ONLY_MODE_MIX'}
if($TestFailurePoint -ne 'None' -and -not $NoPublicIntegration){throw 'R203_FAULT_INJECTION_REQUIRES_ISOLATION'}
$developmentBase=[IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'source\repos')).TrimEnd([char]'\')+'\'
if($NoPublicIntegration){
  if(-not $PSBoundParameters.ContainsKey('InstallRoot') -or
     -not $InstallRoot.StartsWith($developmentBase,[StringComparison]::OrdinalIgnoreCase)){
    throw 'R203_ISOLATED_ROOT_OUTSIDE_DEVELOPMENT'
  }
}
# R198: Stage-Only is a narrowly scoped DEVELOPMENT installation. Never change
# a live current pointer, shortcuts, HKCU uninstall entry, or a prior version.
if($StageOnly){
  if(-not $PSBoundParameters.ContainsKey('InstallRoot')){throw 'R198_EXPLICIT_DEV_INSTALL_ROOT_REQUIRED'}
  $developmentBase=[IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'source\repos')).TrimEnd([char]'\')+'\'
  if(-not $InstallRoot.StartsWith($developmentBase,[StringComparison]::OrdinalIgnoreCase)){throw 'R198_STAGE_ROOT_OUTSIDE_DEVELOPMENT'}
  if(Test-Path -LiteralPath $InstallRoot){throw 'R198_STAGE_ROOT_MUST_BE_NEW'}
}
# R224: exact legacy v0.10.14 hash+path attestation. Pure read-only.
# Only the four SHA-pinned known files are accepted; no wildcards, no guessing.
function Assert-R224LegacyUiBaseline {
  param([string]$LegacyRoot,[string]$InstallBase,[string]$ExpectedName,[hashtable]$ExpectedHashes)
  $got=[IO.Path]::GetFullPath($LegacyRoot).TrimEnd([char]'\')
  $want=[IO.Path]::GetFullPath((Join-Path $InstallBase $ExpectedName)).TrimEnd([char]'\')
  if(-not $got.Equals($want,[StringComparison]::OrdinalIgnoreCase)){throw 'R224_LEGACY_ROOT_IDENTITY_MISMATCH'}
  $dir=Get-Item -LiteralPath $LegacyRoot -Force -ErrorAction Stop
  if(-not $dir.PSIsContainer -or ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'R224_LEGACY_DIR_NOT_PLAIN'}
  $items=@(Get-ChildItem -LiteralPath $LegacyRoot -Force -ErrorAction Stop)
  if($items.Count -ne $ExpectedHashes.Count){throw 'R224_LEGACY_FILE_COUNT_UNKNOWN_OR_EXTRA'}
  foreach($item in $items){
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'R224_LEGACY_REPARSE_OR_DIRECTORY'}
    if(-not $ExpectedHashes.ContainsKey($item.Name)){throw ('R224_LEGACY_UNKNOWN_FILE_'+$item.Name)}
    $actual=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
    if($actual -ne $ExpectedHashes[$item.Name]){throw ('R224_LEGACY_SHA_DRIFT_'+$item.Name)}
  }
  return $true
}
# R224_LEGACY_VERIFIER_END

$script:R224LegacyAccepted=$false
$priorCurrent=$null
$priorTarget=''
$pending=Join-Path $InstallRoot ('current.pending-'+$PackageSha.Substring(0,12))
$rollback=Join-Path $InstallRoot ('current.rollback-'+$PackageSha.Substring(0,12))
$failed=Join-Path $InstallRoot ('current.failed-'+$PackageSha.Substring(0,12))
$stage=Join-Path $InstallRoot ('.stage-v'+$Version+'-'+$PackageSha.Substring(0,12))
if(-not $StageOnly){
  $priorCurrent=Get-Item -LiteralPath $Current -Force -ErrorAction SilentlyContinue
  if($null -ne $priorCurrent){
    if($priorCurrent.LinkType -cne 'Junction'){throw 'R203_UNKNOWN_CURRENT_NOT_JUNCTION'}
    $priorTarget=[IO.Path]::GetFullPath([string](@($priorCurrent.Target)[0]))
    $inside=$InstallRoot.TrimEnd([char]'\')+'\'
    if(-not $priorTarget.StartsWith($inside,[StringComparison]::OrdinalIgnoreCase) -or
       -not(Test-Path -LiteralPath $priorTarget -PathType Container)){
      throw 'R203_CURRENT_TARGET_NOT_OWNED_INSTALL'
    }
    # R224: Only the exact independently-verified legacy Emad UI v0.10.14
    # (unmanifested) can be migrated IN PLACE; never accept an unknown legacy
    # install, an extra file, link, file-hash drift, or a different Mode.
    if(-not(Test-Path -LiteralPath (Join-Path $priorTarget 'product-install.json') -PathType Leaf)){
      if($Mode -cne 'ControlMonitoring'){throw 'R224_LEGACY_MODE_NOT_ACCEPTED'}
      $knownLegacy=@{
        'RemoteCommander.exe'='7AF21BBAA8036906B0483ECA89154460CD8B10219CD13E6615FCB475A655EA5B'
        'profile-manager-windows.ps1'='91EBF4A7BB2C363667D4427C8108ADC31A29E7BFC4CE41EDB2E5AC1AE92D27B9'
        'operations-monitor-windows.ps1'='CFE1E0503B8105ED53401CBF33747DCE838D12651CBAECF508309FB8CD7BA163'
        'admin-runtime-windows.ps1'='E993D3A8570B98EEEE71DC9AD9E24C4ED9120123A8303D0B436465FA7CDA18E8'
      }
      $script:R224LegacyAccepted=Assert-R224LegacyUiBaseline -LegacyRoot $priorTarget -InstallBase $InstallRoot -ExpectedName 'v0.10.14-d06f2162b54b' -ExpectedHashes $knownLegacy
      if(-not $script:R224LegacyAccepted){throw 'R224_LEGACY_ATTESTATION_NOT_ACCEPTED'}
      Write-Output 'R224_EXACT_UNMANIFESTED_LEGACY_UI_VERIFIED_IN_PLACE'
    }
  }
  if(Test-Path -LiteralPath $VersionDir){
    if($null -ne $priorCurrent -and
       $priorTarget.Equals($VersionDir,[StringComparison]::OrdinalIgnoreCase)){
      foreach($name in $selected){
        $installedFile=Join-Path $VersionDir $name
        if(-not(Test-Path $installedFile -PathType Leaf) -or
           (Get-FileHash $installedFile -Algorithm SHA256).Hash -cne (Get-FileHash (Join-Path $SourceDir $name) -Algorithm SHA256).Hash){
          throw 'R203_ALREADY_CURRENT_FILE_HASH_DRIFT'
        }
      }
      Write-Output ('REMOTE_COMMANDER_UI_ALREADY_CURRENT_VERIFIED version='+$Version+' root='+$VersionDir)
      return
    }
    throw 'R203_VERSION_PATH_ALREADY_EXISTS_NO_OVERWRITE'
  }
  foreach($p in @($stage,$pending,$rollback,$failed)){
    if(Test-Path -LiteralPath $p){throw ('R203_UNRESOLVED_PRIOR_TRANSACTION_'+$p)}
  }
}
if($StageOnly){
  New-Item -ItemType Directory -Path $VersionDir -ErrorAction Stop|Out-Null
  $payloadDir=$VersionDir
}else{
  New-Item -ItemType Directory -Path $InstallRoot -Force -ErrorAction Stop|Out-Null
  New-Item -ItemType Directory -Path $stage -ErrorAction Stop|Out-Null
  $payloadDir=$stage
}
foreach($name in $selected){
  Copy-Item -LiteralPath (Join-Path $SourceDir $name) -Destination (Join-Path $payloadDir $name) -ErrorAction Stop
}
foreach($name in $selected){
  if((Get-FileHash (Join-Path $payloadDir $name) -Algorithm SHA256).Hash -cne
     (Get-FileHash (Join-Path $SourceDir $name) -Algorithm SHA256).Hash){
    throw ('R203_STAGED_PAYLOAD_SHA_MISMATCH_'+$name)
  }
}
$InstallManifest=[ordered]@{
  schema=1
  product='Remote Commander'
  version=$Version
  mode=$Mode
  controlMonitoring=($Mode -eq 'ControlMonitoring')
  profilesUi=$true
  browserBundled=$false
  legacyUnmanifestedBaselineVerified=[bool]$script:R224LegacyAccepted
  installedAt=(Get-Date).ToUniversalTime().ToString('o')
}
[IO.File]::WriteAllText((Join-Path $payloadDir 'product-install.json'),(($InstallManifest|ConvertTo-Json -Depth 4)+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))
if($StageOnly){
  $stamp=[ordered]@{schema=1;revision='R198';status='STAGED_ONLY_NO_LIVE_INTEGRATION';sourceVersion=$Version;sourceManifestSHA256=$PackageSha;installRoot=$InstallRoot;versionDir=$VersionDir;currentPointerChanged=$false;startMenuChanged=$false;registryChanged=$false;sourceModified=$false}
  [IO.File]::WriteAllText((Join-Path $VersionDir 'STAGE_R198.json'),(($stamp|ConvertTo-Json -Depth 5)+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))
  Write-Output ('REMOTE_COMMANDER_UI_STAGE_ONLY_PASS version='+$Version+' root='+$VersionDir)
  return
}

# Commit immutable verified payload, then exchange only the current Junction.
# The prior binary directory is NOT copied, deleted, or made another active install.
Move-Item -LiteralPath $stage -Destination $VersionDir -ErrorAction Stop
New-Item -ItemType Junction -Path $pending -Target $VersionDir -ErrorAction Stop|Out-Null
$baselineMoved=$false
try{
  if($null -ne $priorCurrent){
    Move-Item -LiteralPath $Current -Destination $rollback -ErrorAction Stop
    $baselineMoved=$true
  }
  if($TestFailurePoint -eq 'AfterBaselineMove'){throw 'R203_SYNTHETIC_AFTER_BASELINE_MOVE'}
  Move-Item -LiteralPath $pending -Destination $Current -ErrorAction Stop
  if($TestFailurePoint -eq 'AfterCandidateMove'){throw 'R203_SYNTHETIC_AFTER_CANDIDATE_MOVE'}
  $check=Get-Item -LiteralPath $Current -Force -ErrorAction Stop
  if($check.LinkType -cne 'Junction' -or
     -not ([IO.Path]::GetFullPath([string](@($check.Target)[0]))).Equals($VersionDir,[StringComparison]::OrdinalIgnoreCase)){
    throw 'R203_CURRENT_COMMIT_POINTER_INVALID'
  }
}catch{
  $originalError=$_.Exception.Message
  try{
    $newLink=Get-Item -LiteralPath $Current -Force -ErrorAction SilentlyContinue
    if($null -ne $newLink){
      if($newLink.LinkType -cne 'Junction' -or
         -not([IO.Path]::GetFullPath([string](@($newLink.Target)[0]))).Equals($VersionDir,[StringComparison]::OrdinalIgnoreCase)){
        throw 'R203_UNRECOGNIZED_POINTER_DURING_ROLLBACK'
      }
      Move-Item -LiteralPath $Current -Destination $failed -ErrorAction Stop
    }
    if($baselineMoved){
      Move-Item -LiteralPath $rollback -Destination $Current -ErrorAction Stop
      $restored=Get-Item -LiteralPath $Current -Force -ErrorAction Stop
      if($restored.LinkType -cne 'Junction' -or
         -not([IO.Path]::GetFullPath([string](@($restored.Target)[0]))).Equals($priorTarget,[StringComparison]::OrdinalIgnoreCase)){
        throw 'R203_RESTORED_BASELINE_POINTER_MISMATCH'
      }
    }
  }catch{
    throw ('R203_TRANSACTION_DEGRADED_ROLLBACK_UNRESOLVED: '+$_.Exception.Message+'; original='+$originalError)
  }
  throw ('R203_SWAP_ABORTED_BASELINE_PRESERVED: '+$originalError)
}
if($NoPublicIntegration){
  Write-Output ('REMOTE_COMMANDER_UI_PRIVATE_TRANSACTION_PASS version='+$Version+' current='+$Current+' rollback='+$rollback)
  return
}

function Assert-CoreStartMenuShortcut {
  param(
    [string]$Path,
    [string]$ExpectedTarget,
    [string]$ExpectedWorkingDirectory,
    [string]$ExpectedIcon,
    [object]$Shell
  )
  if(-not(Test-Path -LiteralPath $Path -PathType Leaf)){throw 'CORE_SHORTCUT_MISSING'}
  if(-not(Test-Path -LiteralPath $ExpectedTarget -PathType Leaf)){throw 'CORE_SHORTCUT_EXE_MISSING'}
  $actual=$Shell.CreateShortcut($Path)
  $expected=[IO.Path]::GetFullPath($ExpectedTarget)
  if(-not $actual.TargetPath -or
     -not [string]::Equals([IO.Path]::GetFullPath($actual.TargetPath),$expected,[StringComparison]::OrdinalIgnoreCase)){
    throw 'CORE_SHORTCUT_TARGET_MISMATCH'
  }
  if(-not(Test-Path -LiteralPath $actual.TargetPath -PathType Leaf)){throw 'CORE_SHORTCUT_TARGET_MISSING'}
  if(-not [string]::Equals($actual.WorkingDirectory,$ExpectedWorkingDirectory,[StringComparison]::OrdinalIgnoreCase)){
    throw 'CORE_SHORTCUT_WORKDIR_MISMATCH'
  }
  if(-not [string]::Equals($actual.IconLocation,$ExpectedIcon,[StringComparison]::OrdinalIgnoreCase)){
    throw 'CORE_SHORTCUT_ICON_MISMATCH'
  }
  if($actual.Arguments){throw 'CORE_SHORTCUT_UNEXPECTED_ARGUMENTS'}
}

$Wsh=New-Object -ComObject WScript.Shell
$DashboardTarget=Join-Path $Current 'RemoteCommander.exe'
$Icon=$DashboardTarget+',0'
$DashboardShortcut=Join-Path $StartMenu 'Remote Commander.lnk'
$s=$Wsh.CreateShortcut($DashboardShortcut)
$s.TargetPath=$DashboardTarget
$s.Arguments=''
$s.WorkingDirectory=$Current
$s.IconLocation=$Icon
$s.Description='Remote Commander'
$s.Save()
Assert-CoreStartMenuShortcut $DashboardShortcut $DashboardTarget $Current $Icon $Wsh

# Historical internal tools are implementation details, not separate Start Menu applications.
foreach($legacy in @(
  'Remote Commander Profiles & Access.lnk',
  'Remote Commander Operations Monitor.lnk',
  'Remote Commander Admin Runtime.lnk'
)){
  Remove-Item -LiteralPath (Join-Path $StartMenu $legacy) -Force -ErrorAction SilentlyContinue
}

$Pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source
$Uninstall=Join-Path $InstallRoot 'uninstall.ps1'
# R219: An uninstaller must never blindly delete the versioned installation
# root, especially while a current Junction, rollback alias, unknown files
# or user-owned state may still exist. Updating is transactional in place.
# Until a separate independently approved exact-manifest retirement tool passes,
# the registered Uninstall entry fails BEFORE changing files/registry/shortcuts.
$UninstallText=@"
#requires -Version 7.0
`$ErrorActionPreference='Stop'
throw 'R219_UNINSTALL_REFUSED_NO_ACCEPTED_RETIREMENT_PLAN: Use transactional in-place Update. Explicit manifest, profile continuity, active-process, rollback and owner-acceptance evidence are required for a future safe uninstall; NOTHING WAS DELETED.'
"@
[IO.File]::WriteAllText($Uninstall,$UninstallText,(New-Object Text.UTF8Encoding($false)))

New-Item -Path $Reg -Force | Out-Null
New-ItemProperty -Path $Reg -Name DisplayName -Value 'Remote Commander' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $Reg -Name DisplayVersion -Value $Version -PropertyType String -Force | Out-Null
New-ItemProperty -Path $Reg -Name Publisher -Value 'TandemVector Labs' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $Reg -Name InstallLocation -Value $InstallRoot -PropertyType String -Force | Out-Null
New-ItemProperty -Path $Reg -Name DisplayIcon -Value $Icon -PropertyType String -Force | Out-Null
New-ItemProperty -Path $Reg -Name UninstallString -Value ('"'+$Pwsh+'" -NoProfile -File "'+$Uninstall+'"') -PropertyType String -Force | Out-Null
New-ItemProperty -Path $Reg -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $Reg -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null

# Check again after registry updates: link file existence alone cannot prove a valid launch target.
Assert-CoreStartMenuShortcut $DashboardShortcut $DashboardTarget $Current $Icon $Wsh
Write-Output "REMOTE_COMMANDER_DESKTOP_INSTALL_PASS version=$Version mode=$Mode install=$InstallRoot shortcuts=1 dashboard=$DashboardShortcut"
