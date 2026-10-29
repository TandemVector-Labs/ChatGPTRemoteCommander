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

# No SYSTEM task may execute code that a medium-integrity owner process can
# replace. This is an admission guard, NOT a migration of existing live tasks.
# Only SYSTEM, local Administrators and Windows TrustedInstaller may own or
# mutate privileged executable files/ancestors. ACL checks are read-only and
# intentionally fail closed for custom and unresolvable privileged SIDs.
function Assert-RcSystemExecutableAcl($Acl) {
  $trustedSids=@('S-1-5-18','S-1-5-32-544',
    'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  try {$ownerSid=([Security.Principal.NTAccount]$Acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value}
  catch {throw 'BOOT_RECOVERY_SYSTEM_EXECUTABLE_OWNER_UNRESOLVED'}
  if($ownerSid -notin $trustedSids){throw 'BOOT_RECOVERY_SYSTEM_EXECUTABLE_OWNER_UNTRUSTED'}
  $writeMask=[int64]([Security.AccessControl.FileSystemRights]::WriteData -bor
    [Security.AccessControl.FileSystemRights]::AppendData -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership -bor
    [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    0x50000000) # GenericAll and GenericWrite, even before access-mask expansion.
  foreach($ace in $Acl.Access){
    if($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){continue}
    # InheritOnly is not effective on this directory; independently audit
    # all descendants of the machine app before accepting the SYSTEM task.
    if(($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0){continue}
    if((([int64]$ace.FileSystemRights) -band $writeMask) -eq 0){continue}
    try {$sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}
    catch {throw 'BOOT_RECOVERY_SYSTEM_EXECUTABLE_ACL_UNREADABLE'}
    if($sid -notin $trustedSids){throw 'BOOT_RECOVERY_SYSTEM_EXECUTABLE_WRITABLE'}
  }
}

# Resolve the OS-known machine Program Files root rather than trusting an
# owner-modifiable environment variable or PATH for privileged task admission.
function Get-RcMachineProgramFiles {
  $known=[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
  if([string]::IsNullOrWhiteSpace($known) -or [string]::IsNullOrWhiteSpace($env:ProgramFiles)){
    throw 'BOOT_RECOVERY_PROGRAMFILES_UNRESOLVED'
  }
  $actual=[IO.Path]::GetFullPath($known).TrimEnd('\')
  $fromEnv=[IO.Path]::GetFullPath($env:ProgramFiles).TrimEnd('\')
  if($actual -ine $fromEnv){throw 'BOOT_RECOVERY_PROGRAMFILES_ENV_MISMATCH'}
  return $actual
}

function Assert-RcProtectedMachinePath([string]$Candidate, [string]$OwnerProfile) {
  $programFiles = Get-RcMachineProgramFiles
  $target = [IO.Path]::GetFullPath($Candidate).TrimEnd('\')
  if (-not $target.StartsWith($programFiles + '\',[StringComparison]::OrdinalIgnoreCase)) {
    throw 'BOOT_RECOVERY_SYSTEM_EXECUTABLE_UNTRUSTED_LOCATION'
  }
  $current = $target
  while ($current.Length -ge $programFiles.Length) {
    $item=Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'BOOT_RECOVERY_SYSTEM_EXECUTABLE_REPARSE_POINT'
    }
    $acl=Get-Acl -LiteralPath $current -ErrorAction Stop
    Assert-RcSystemExecutableAcl $acl
    if($current -ieq $programFiles){break}
    $parent=Split-Path -Parent $current
    if($parent -eq $current -or -not $parent){throw 'BOOT_RECOVERY_SYSTEM_ROOT_ESCAPE'}
    $current=$parent
  }
}

function Assert-RcSystemTaskInstallTrust([string]$RuntimeRoot, [string]$OwnerProfile) {
  $requiredRoot=[IO.Path]::GetFullPath((Join-Path (Get-RcMachineProgramFiles) 'ChatGPTRemoteCommander\machine-app')).TrimEnd('\')
  if([IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\') -ine $requiredRoot){
    throw 'BOOT_RECOVERY_MACHINE_APP_ROOT_REQUIRED'
  }
  if(-not(Test-Path -LiteralPath $requiredRoot -PathType Container)){
    throw 'BOOT_RECOVERY_MACHINE_APP_NOT_STAGED'
  }
  $items=@(Get-Item -LiteralPath $requiredRoot -Force)
  $items+=@(Get-ChildItem -LiteralPath $requiredRoot -Recurse -Force -ErrorAction Stop)
  if($items.Count -gt 20000){throw 'BOOT_RECOVERY_MACHINE_APP_AUDIT_TOO_LARGE'}
  foreach($item in $items){
    Assert-RcProtectedMachinePath $item.FullName $OwnerProfile
  }
  foreach($required in @('autostart-windows.ps1','handoff-user-session-windows.ps1',
      'windows-supervisor-runtime.ps1','supervisor-routing.ps1',
      'src\server-v0.3.mjs','tools\tunnel-log-runner.mjs')){
    if(-not(Test-Path -LiteralPath (Join-Path $requiredRoot $required) -PathType Leaf)){
      throw 'BOOT_RECOVERY_MACHINE_APP_INCOMPLETE'
    }
  }
}

# Explicitly bind privileged task and child runtime binaries to machine-only
# installations. A valid publisher signature is required for the two EXEs;
# npm.cmd and its adjacent npm-cli.js are protected by recursive path checks.
function Get-RcTrustedSystemBinaries([string]$OwnerProfile) {
  $pf=Get-RcMachineProgramFiles
  $pwsh=Join-Path $pf 'PowerShell\7\pwsh.exe'
  $node=Join-Path $pf 'nodejs\node.exe'
  $npm=Join-Path $pf 'nodejs\npm.cmd'
  $npmCli=Join-Path $pf 'nodejs\node_modules\npm\bin\npm-cli.js'
  foreach($binary in @($pwsh,$node,$npm,$npmCli)){
    Assert-RcProtectedMachinePath $binary $OwnerProfile
  }
  foreach($check in @(
    @{Path=$pwsh;Publisher='Microsoft Corporation'},
    @{Path=$node;Publisher='OpenJS Foundation'}
  )){
    $signature=Get-AuthenticodeSignature -LiteralPath $check.Path -ErrorAction Stop
    $publisher='^CN='+[regex]::Escape([string]$check.Publisher)+'(?:,|$)'
    if($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or
       [string]$signature.SignerCertificate.Subject -notmatch $publisher){
      throw 'BOOT_RECOVERY_SYSTEM_BINARY_SIGNATURE_UNTRUSTED'
    }
  }
  return [pscustomobject]@{Pwsh=$pwsh;Node=$node;Npm=$npm}
}

$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$OwnerUserProfile = [IO.Path]::GetFullPath($OwnerUserProfile)
if ([IO.Path]::GetFullPath($env:USERPROFILE) -ne $OwnerUserProfile) {
  throw 'BOOT_RECOVERY_OWNER_PROFILE_MUST_MATCH_CURRENT_USER'
}
$OwnerLocal = Join-Path $OwnerUserProfile 'AppData\Local'
$OwnerRoaming = Join-Path $OwnerUserProfile 'AppData\Roaming'
$MachineRoot = Join-Path (Get-RcMachineProgramFiles) 'ChatGPTRemoteCommander\machine-app'
$Root = $MachineRoot
# Before any directory creation, DPAPI conversion, probe task, registry or
# live task update, reject a user-writable SYSTEM execution graph.
Assert-RcSystemTaskInstallTrust $Root $OwnerUserProfile
$CredDir = Join-Path $OwnerLocal 'ChatGPTRemoteCommander\credentials'
# Read-only security attestation for separately staged machine-only storage.
# Do not activate boot tasks until the SYSTEM reader uses it and owner-profile
# dependencies are removed; this is not a credential migration or copy.
. (Join-Path $Root 'machine-credential-trust.ps1')
$MachineCredentialRoot = Assert-RcMachineCredentialStore
# The legacy LocalMachine-DPAPI blob sits below owner-writable ancestors.
# Do not register SYSTEM tasks until the reader and storage are migrated.
throw 'BOOT_RECOVERY_MACHINE_CREDENTIAL_STORAGE_MIGRATION_REQUIRED'
$ProfileDir = Join-Path $OwnerRoaming 'tunnel-client'
$VarDir = Join-Path $Root 'var'
New-Item -ItemType Directory -Force -Path $VarDir | Out-Null
$Supervisor = Join-Path $Root 'autostart-windows.ps1'
$Handoff = Join-Path $Root 'handoff-user-session-windows.ps1'
foreach($p in @($CredDir,$ProfileDir,$Supervisor,$Handoff)){
  if(-not(Test-Path -LiteralPath $p)){throw "BOOT_RECOVERY_REQUIRED_PATH_MISSING $p"}
}

$trustedRuntime = Get-RcTrustedSystemBinaries $OwnerUserProfile
$pwsh = $trustedRuntime.Pwsh
$node = $trustedRuntime.Node
$npm = $trustedRuntime.Npm
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
  if(-not(Test-Path -LiteralPath $source -PathType Leaf)){throw "BOOT_RECOVERY_SOURCE_CREDENTIAL_MISSING $Profile"}
  $target=Join-Path $CredDir "$Profile.machine.dpapi"
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

$bootArgs='-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -CredentialScope LocalMachine -BootCore -OwnerUserProfile "{1}" -NodePath "{2}" -NpmPath "{3}"' -f $Supervisor,$OwnerUserProfile,$node,$npm
$bootAction=New-ScheduledTaskAction -Execute $pwsh -Argument $bootArgs -WorkingDirectory $Root
$bootTrigger=New-ScheduledTaskTrigger -AtStartup
$bootSettings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $BootTaskName -Action $bootAction -Trigger $bootTrigger -Principal $systemPrincipal -Settings $bootSettings -Force | Out-Null

$handoffArgs='-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -OwnerUserProfile "{1}"' -f $Handoff,$OwnerUserProfile
$handoffAction=New-ScheduledTaskAction -Execute $pwsh -Argument $handoffArgs -WorkingDirectory $Root
$handoffTrigger=New-ScheduledTaskTrigger -AtLogOn -User $ownerName
$handoffTrigger.Delay='PT30S'
$handoffSettings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 12 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Minutes 12) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $HandoffTaskName -Action $handoffAction -Trigger $handoffTrigger -Principal $systemPrincipal -Settings $handoffSettings -Force | Out-Null

$runKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
New-Item -Path $runKey -Force | Out-Null
$launcher=Join-Path $Root 'launch-supervisor-hidden.vbs'
$pwshVbs=$pwsh.Replace('"','""')
$supervisorVbs=$Supervisor.Replace('"','""')
$vbs=@(
  'Set sh = CreateObject("WScript.Shell")',
  ('cmd = Chr(34) & "{0}" & Chr(34) & " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & Chr(34) & "{1}" & Chr(34)' -f $pwshVbs,$supervisorVbs),
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
