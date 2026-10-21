param(
  [string]$OwnerUserProfile = $env:USERPROFILE,
  [string]$BootTaskName = 'ChatGPTRemoteCommander-BootRecovery',
  [string]$HandoffTaskName = 'ChatGPTRemoteCommander-UserSessionHandoff',
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'

function Test-Elevated {
  $id=[Security.Principal.WindowsIdentity]::GetCurrent()
  $p=[Security.Principal.WindowsPrincipal]::new($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (-not (Test-Elevated)) { throw 'BOOT_RECOVERY_ELEVATION_REQUIRED' }
if ([Security.Principal.WindowsIdentity]::GetCurrent().IsSystem) { throw 'BOOT_RECOVERY_RUN_AS_OWNER_ADMIN_REQUIRED' }

$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$OwnerUserProfile = [IO.Path]::GetFullPath($OwnerUserProfile)
if ([IO.Path]::GetFullPath($env:USERPROFILE) -ne $OwnerUserProfile) {
  throw 'BOOT_RECOVERY_OWNER_PROFILE_MUST_MATCH_CURRENT_USER'
}
$OwnerLocal = Join-Path $OwnerUserProfile 'AppData\Local'
$OwnerRoaming = Join-Path $OwnerUserProfile 'AppData\Roaming'
$StableRoot = Join-Path $OwnerLocal 'ChatGPTRemoteCommander\app'
$stableSupervisor = Join-Path $StableRoot 'autostart-windows.ps1'
$stableHandoff = Join-Path $StableRoot 'handoff-user-session-windows.ps1'
$stableLauncher = Join-Path $StableRoot 'windows-pwsh-task-launcher.ps1'
if ((Test-Path -LiteralPath $stableSupervisor -PathType Leaf) -and
    (Test-Path -LiteralPath $stableHandoff -PathType Leaf) -and
    -not (Test-Path -LiteralPath $stableLauncher -PathType Leaf) -and
    [IO.Path]::GetFullPath($SourceRoot) -ne [IO.Path]::GetFullPath($StableRoot)) {
  # Do not persist tasks pointing at an ephemeral update/staging checkout.
  # A qualified Core update must place its tracked launcher in StableRoot first.
  throw 'BOOT_RECOVERY_STABLE_LAUNCHER_UPDATE_REQUIRED'
}
$Root = if((Test-Path -LiteralPath $stableSupervisor -PathType Leaf) -and (Test-Path -LiteralPath $stableHandoff -PathType Leaf) -and (Test-Path -LiteralPath $stableLauncher -PathType Leaf)){$StableRoot}else{$SourceRoot}
$CredDir = Join-Path $OwnerLocal 'ChatGPTRemoteCommander\credentials'
$ProfileDir = Join-Path $OwnerRoaming 'tunnel-client'
$VarDir = Join-Path $Root 'var'
New-Item -ItemType Directory -Force -Path $VarDir | Out-Null
$Supervisor = Join-Path $Root 'autostart-windows.ps1'
$Handoff = Join-Path $Root 'handoff-user-session-windows.ps1'
$Launcher = Join-Path $Root 'windows-pwsh-task-launcher.ps1'
foreach($p in @($CredDir,$ProfileDir,$Supervisor,$Handoff,$Launcher)){
  if(-not(Test-Path -LiteralPath $p)){throw "BOOT_RECOVERY_REQUIRED_PATH_MISSING $p"}
}

$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$bootstrap = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if(-not(Test-Path -LiteralPath $bootstrap -PathType Leaf)){throw 'BOOT_RECOVERY_STABLE_BOOTSTRAP_MISSING'}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$ownerIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$ownerName = $ownerIdentity.Name

function Set-MachineCredentialAcl([string]$Path) {
  $acl = New-Object Security.AccessControl.FileSecurity
  $acl.SetAccessRuleProtection($true,$false)
  $inherit=[Security.AccessControl.InheritanceFlags]::None
  $prop=[Security.AccessControl.PropagationFlags]::None
  $allow=[Security.AccessControl.AccessControlType]::Allow
  foreach($sidText in @('S-1-5-18','S-1-5-32-544')){
    $sid=[Security.Principal.SecurityIdentifier]::new($sidText)
    $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,$prop,$allow)
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Convert-OneCredential([string]$Profile) {
  if($Profile -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or $Profile -match '\.\.' -or $Profile -in @('.','..')){
    throw "BOOT_RECOVERY_INVALID_PROFILE $Profile"
  }
  $source=Join-Path $CredDir "$Profile.dpapi"
  $target=Join-Path $CredDir "$Profile.machine.dpapi"
  if(-not(Test-Path -LiteralPath $source -PathType Leaf)){
    # A previously enrolled SYSTEM-only profile is valid: the probe below verifies
    # its protected machine DPAPI credential without granting owner read access.
    if(Test-Path -LiteralPath $target -PathType Leaf){return $target}
    throw "BOOT_RECOVERY_SOURCE_CREDENTIAL_MISSING $Profile"
  }
  $secure=$null
  $plain=$null
  $bytes=$null
  $cipher=$null
  try {
    $secure=ConvertTo-SecureString (Get-Content -LiteralPath $source -Raw)
    $plain=[System.Net.NetworkCredential]::new('',$secure).Password
    if([string]::IsNullOrWhiteSpace($plain)){throw "BOOT_RECOVERY_SOURCE_CREDENTIAL_EMPTY $Profile"}
    $bytes=[Text.Encoding]::UTF8.GetBytes($plain)
    $cipher=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
    $encoded=[Convert]::ToBase64String($cipher)
    $tmp="$target.tmp-$PID"
    [IO.File]::WriteAllText($tmp,$encoded+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
    Set-MachineCredentialAcl $tmp
    $roundCipher=[Convert]::FromBase64String((Get-Content -LiteralPath $tmp -Raw).Trim())
    $roundClear=[Security.Cryptography.ProtectedData]::Unprotect($roundCipher,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
    try {
      $round=[Text.Encoding]::UTF8.GetString($roundClear)
      if($round -ne $plain){throw "BOOT_RECOVERY_MACHINE_CREDENTIAL_VERIFY_FAIL $Profile"}
    } finally {
      if($roundCipher){[Array]::Clear($roundCipher,0,$roundCipher.Length)}
      if($roundClear){[Array]::Clear($roundClear,0,$roundClear.Length)}
      $round=$null
    }
    Move-Item -LiteralPath $tmp -Destination $target -Force
    Set-MachineCredentialAcl $target
    return $target
  } finally {
    if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}
    if($cipher){[Array]::Clear($cipher,0,$cipher.Length)}
    $plain=$null
    $secure=$null
  }
}

$profiles=@()
foreach($file in Get-ChildItem -LiteralPath $ProfileDir -Filter '*.yaml' -File){
  $profile=[IO.Path]::GetFileNameWithoutExtension($file.Name)
  if($profile -match '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -and $profile -notmatch '\.\.' -and $profile -notin @('.','..')){
    $profiles += $profile
  }
}
$profiles=@($profiles | Sort-Object -Unique)
if($profiles.Count -lt 1){throw 'BOOT_RECOVERY_NO_TUNNEL_PROFILES'}
$machineFiles=@()
foreach($profile in $profiles){$machineFiles += Convert-OneCredential $profile}

$probeName=$BootTaskName+'-Probe'
$probeResult=Join-Path $VarDir 'boot-recovery-system-probe.json'
Remove-Item -LiteralPath $probeResult -Force -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $probeName -Confirm:$false -ErrorAction SilentlyContinue
$probeArgs='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -SelfTest -CredentialSelfTest -CredentialScope LocalMachine -BootCore -OwnerUserProfile "{1}" -SelfTestOutput "{2}" -NodePath "{3}" -NpmPath "{4}"' -f $Supervisor,$OwnerUserProfile,$probeResult,$node,$npm
$probeAction=New-ScheduledTaskAction -Execute $pwsh -Argument $probeArgs -WorkingDirectory $Root
$systemPrincipal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$probeSettings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName $probeName -Action $probeAction -Principal $systemPrincipal -Settings $probeSettings -Force | Out-Null
try {
  Start-ScheduledTask -TaskName $probeName
  $deadline=(Get-Date).AddSeconds(20)
  while((Get-Date)-lt$deadline -and -not(Test-Path -LiteralPath $probeResult)){Start-Sleep -Milliseconds 250}
  if(-not(Test-Path -LiteralPath $probeResult)){
    $probeInfo=Get-ScheduledTaskInfo -TaskName $probeName -ErrorAction SilentlyContinue
    $probeState=(Get-ScheduledTask -TaskName $probeName -ErrorAction SilentlyContinue).State
    $lastResult=if($probeInfo){[int64]$probeInfo.LastTaskResult}else{-1}
    throw "BOOT_RECOVERY_SYSTEM_PROBE_NO_RESULT state=$probeState lastTaskResult=$lastResult"
  }
  $probe=Get-Content -LiteralPath $probeResult -Raw | ConvertFrom-Json
  if(-not $probe.ok -or -not $probe.bootCore -or [string]$probe.credentialScope -ne 'LocalMachine'){
    $detail=if($probe.PSObject.Properties.Name -contains 'error' -and -not [string]::IsNullOrWhiteSpace([string]$probe.error)){[string]$probe.error}else{'unspecified'}
    throw "BOOT_RECOVERY_SYSTEM_PROBE_FAIL error=$detail"
  }
  if(@($probe.profiles | Where-Object {-not $_.credentialReady}).Count -gt 0){throw 'BOOT_RECOVERY_SYSTEM_CREDENTIAL_PROBE_FAIL'}
} finally {
  Unregister-ScheduledTask -TaskName $probeName -Confirm:$false -ErrorAction SilentlyContinue
}

$bootArgs='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Mode Boot -OwnerUserProfile "{1}" -NodePath "{2}" -NpmPath "{3}"' -f $Launcher,$OwnerUserProfile,$node,$npm
$bootAction=New-ScheduledTaskAction -Execute $bootstrap -Argument $bootArgs -WorkingDirectory $Root
$bootTrigger=New-ScheduledTaskTrigger -AtStartup
$bootSettings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $BootTaskName -Action $bootAction -Trigger $bootTrigger -Principal $systemPrincipal -Settings $bootSettings -Force | Out-Null

$handoffArgs='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Mode Handoff -OwnerUserProfile "{1}"' -f $Launcher,$OwnerUserProfile
$handoffAction=New-ScheduledTaskAction -Execute $bootstrap -Argument $handoffArgs -WorkingDirectory $Root
$handoffTrigger=New-ScheduledTaskTrigger -AtLogOn -User $ownerName
$handoffTrigger.Delay='PT30S'
$handoffSettings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 12 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Minutes 12) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $HandoffTaskName -Action $handoffAction -Trigger $handoffTrigger -Principal $systemPrincipal -Settings $handoffSettings -Force | Out-Null

$runKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
New-Item -Path $runKey -Force | Out-Null
$launcher=Join-Path $Root 'launch-supervisor-hidden.vbs'
$pwshVbs=$bootstrap.Replace('"','""')
$supervisorVbs=$Launcher.Replace('"','""')
$ownerVbs=$OwnerUserProfile.Replace('"','""')
$vbs=@(
  'Set sh = CreateObject("WScript.Shell")',
  ('cmd = Chr(34) & "{0}" & Chr(34) & " -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & Chr(34) & "{1}" & Chr(34) & " -Mode UserSupervisor -OwnerUserProfile " & Chr(34) & "{2}" & Chr(34)' -f $pwshVbs,$supervisorVbs,$ownerVbs),
  'Call sh.Run(cmd, 0, False)'
)
[IO.File]::WriteAllLines($launcher,$vbs,[Text.UTF8Encoding]::new($false))
$wscript=Join-Path $env:WINDIR 'System32\wscript.exe'
$logonCommand='"{0}" //B //NoLogo "{1}"' -f $wscript,$launcher
New-ItemProperty -Path $runKey -Name 'ChatGPTRemoteCommander' -Value $logonCommand -PropertyType String -Force | Out-Null

if(-not $NoStart){
  Start-ScheduledTask -TaskName $BootTaskName
}

[ordered]@{
  ok=$true
  bootTask=$BootTaskName
  handoffTask=$HandoffTaskName
  owner=$ownerName
  ownerUserProfile=$OwnerUserProfile
  credentialScope='LocalMachine'
  machineCredentialCount=$machineFiles.Count
  systemProbe=$true
  autoAdminLogonRequired=$false
  plaintextCredentialPersisted=$false
  rebootPerformed=$false
  started=(-not $NoStart)
}|ConvertTo-Json -Compress
