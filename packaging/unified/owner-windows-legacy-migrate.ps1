#requires -Version 7.0
# Per-user Legacy InPlace -> Unified NSIS. Explicitly separate Plan/Apply/Recover.
# Never escalates privileges, touches V1 Core, or installs a second GUI silently.
[CmdletBinding()]
param(
 [ValidateSet('Plan','Apply','Recover')][string]$Mode='Plan',
 [string]$InstallerPath='',
 [string]$InstallerSha256='',
 [string]$ExpectedVersion='0.12.0-dev.9'
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$legacyKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\RemoteCommander'
$uninstallRoot='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$local=[IO.Path]::GetFullPath($env:LOCALAPPDATA)
$legacy=[IO.Path]::GetFullPath((Join-Path $local 'Programs\Remote Commander'))
$state=Join-Path $local 'ChatGPTRemoteCommander\migration\unified-owner'
$receipt=Join-Path $state 'receipt.json'
$backup=Join-Path $state 'legacy-install'
$failed=Join-Path $state 'failed-new-install'
function Fail([string]$code){throw $code}
function SamePath([string]$a,[string]$b){
 return [IO.Path]::GetFullPath($a).TrimEnd('\') -ieq [IO.Path]::GetFullPath($b).TrimEnd('\')
}
function Read-Receipt {
 if(-not(Test-Path -LiteralPath $receipt)){return $null}
 $item=Get-Item -LiteralPath $receipt -Force
 if($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){Fail 'RC012_RECEIPT_REPARSE_REFUSED'}
 $r=Get-Content -LiteralPath $receipt -Raw -Encoding UTF8|ConvertFrom-Json
 if($r.schema -ne 1 -or -not(SamePath $r.legacy $legacy) -or -not(SamePath $r.backup $backup)){
  Fail 'RC012_RECEIPT_INVALID'
 }
 return $r
}
function Save-Receipt($r){
 New-Item -ItemType Directory -Path $state -Force|Out-Null
 $temp=Join-Path $state ('receipt-'+[guid]::NewGuid().ToString('N')+'.tmp')
 try{
  [IO.File]::WriteAllText($temp,($r|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
  # File.Replace rejects a null backup path on hosted Windows PowerShell/.NET.
  # Same-volume Move(overwrite) updates the single active receipt atomically.
  if(Test-Path -LiteralPath $receipt){[IO.File]::Move($temp,$receipt,$true)}
  else{[IO.File]::Move($temp,$receipt)}
 }finally{if(Test-Path -LiteralPath $temp){Remove-Item -LiteralPath $temp -Force}}
}
function Read-OldRegistration {
 if(-not(Test-Path -LiteralPath $legacyKey)){return $null}
 $r=Get-ItemProperty -LiteralPath $legacyKey
 if($r.DisplayName -ne 'Remote Commander' -or -not $r.DisplayVersion -or
  -not $r.InstallLocation -or -not(SamePath $r.InstallLocation $legacy)){
  Fail 'RC012_UNRECOGNIZED_LEGACY_REGISTRATION'
 }
 $props=@{}
 foreach($p in $r.PSObject.Properties){
  if($p.Name -notmatch '^PS' -and $p.Value -is [string]){$props[$p.Name]=$p.Value}
 }
 if(-not $props.ContainsKey('UninstallString') -or $props.UninstallString -notmatch 'uninstall\.ps1'){
  Fail 'RC012_LEGACY_UNINSTALL_KIND_UNSUPPORTED'
 }
 return [pscustomobject]@{version=$r.DisplayVersion;properties=$props}
}
function Assert-Previous-Rollback($prior,$old){
 if($prior.phase -ne 'ROLLED_BACK'){Fail 'RC012_PREVIOUS_TRANSACTION_NOT_ROLLED_BACK'}
 if(Test-Path -LiteralPath $backup){Fail 'RC012_PRIOR_BACKUP_PATH_NOT_RELEASED'}
 if(Test-Path -LiteralPath $failed){Fail 'RC012_PRIOR_FAILED_INSTALL_QUARANTINE_PRESENT'}
 if(Test-Path -LiteralPath (Join-Path $local 'Programs\remote-commander-unified')){
  Fail 'RC012_PREVIOUS_NSIS_DIRECTORY_STILL_PRESENT'
 }
 if([string]$prior.old.version -ne [string]$old.version){
  Fail 'RC012_ROLLBACK_OWNER_BASELINE_CHANGED'
 }
 foreach($key in @('DisplayName','DisplayVersion','InstallLocation','UninstallString')){
  $v=$prior.old.properties.PSObject.Properties[$key]
  if(-not $v -or -not $old.properties.ContainsKey($key) -or
    [string]$v.Value -cne [string]$old.properties[$key]){
   Fail 'RC012_ROLLBACK_OWNER_BASELINE_CHANGED'
  }
 }
}
function Find-NewRegistration {
 $matches=@(Get-ItemProperty -Path ($uninstallRoot+'\*') -ErrorAction SilentlyContinue |
  Where-Object {$_.PSObject.Properties['DisplayName'] -and $_.PSObject.Properties['DisplayVersion'] -and
   $_.DisplayName -in @('Remote Commander',('Remote Commander '+$ExpectedVersion)) -and
   $_.DisplayVersion -eq $ExpectedVersion})
 if($matches.Count -gt 1){Fail 'RC012_DUPLICATE_NEW_REGISTRATIONS'}
 if($matches.Count -eq 0){return $null}
 return $matches[0]
}
function Assert-NoOwnerGui {
 $running=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
  $_.ExecutablePath -and
   $_.ExecutablePath.StartsWith($legacy+'\',[StringComparison]::OrdinalIgnoreCase)
 })
 if($running.Count){Fail 'RC012_LEGACY_GUI_RUNNING'}
}
function Assert-Installer {
 if(-not $InstallerPath -or $InstallerSha256 -notmatch '^[a-fA-F0-9]{64}$'){
  Fail 'RC012_EXACT_INSTALLER_AND_SHA_REQUIRED'
 }
 $file=Get-Item -LiteralPath $InstallerPath -ErrorAction Stop
 if($file.PSIsContainer -or $file.Length -lt 20000000 -or
  $file.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -or
  $file.Name -ne ('Remote-Commander-Unified-'+$ExpectedVersion+'-Windows-x64.exe')){
  Fail 'RC012_INSTALLER_FORMAT_UNEXPECTED'
 }
 $sha=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
 if($sha -ine $InstallerSha256){Fail 'RC012_INSTALLER_SHA256_MISMATCH'}
 if($file.VersionInfo.ProductVersion -ne $ExpectedVersion){
  Fail 'RC012_INSTALLER_VERSION_MISMATCH'
 }
 return $file.FullName
}
function Assert-MachineLegacyAbsent {
 foreach($p in @(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\RemoteCommander',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\RemoteCommander')){
  if(Test-Path -LiteralPath $p){Fail 'RC012_MACHINE_WIDE_LEGACY_ADMIN_REQUIRED'}
 }
}
function Restore-Legacy($r){
 if(Test-Path -LiteralPath $legacy){Fail 'RC012_RESTORE_CONFLICT_LEGACY_PATH_OCCUPIED'}
 if(-not(Test-Path -LiteralPath $backup)){Fail 'RC012_RESTORE_BACKUP_MISSING'}
 Move-Item -LiteralPath $backup -Destination $legacy -ErrorAction Stop
 New-Item -Path $legacyKey -Force -ErrorAction Stop|Out-Null
 foreach($p in $r.old.properties.PSObject.Properties){
  New-ItemProperty -LiteralPath $legacyKey -Name $p.Name -Value ([string]$p.Value) -PropertyType String -Force -ErrorAction Stop|Out-Null
 }
 if(-not(Test-Path -LiteralPath (Join-Path $legacy 'uninstall.ps1'))){
  Fail 'RC012_RESTORED_UNINSTALL_FILE_MISSING'
 }
 $r.phase='ROLLED_BACK';Save-Receipt $r
}
function Assert-NewInstalled($new){
 if(-not $new){Fail 'RC012_NSIS_INSTALL_NOT_REGISTERED'}
 # electron-builder v26 per-user NSIS sets the GUID uninstall key and
 # DisplayName='Remote Commander <version>', but omits InstallLocation.
 # Resolve only the package-name-derived owner-local installer directory.
 $expected=[IO.Path]::GetFullPath((Join-Path $local 'Programs\remote-commander-unified'))
 $folder=$expected
 if($new.PSObject.Properties['InstallLocation'] -and $new.InstallLocation){
  $folder=[IO.Path]::GetFullPath([string]$new.InstallLocation)
 }
 if(-not(SamePath $folder $expected)){Fail 'RC012_NSIS_INSTALL_PATH_MISMATCH'}
 if(-not(Test-Path -LiteralPath $folder -PathType Container)){
  Fail 'RC012_NSIS_INSTALL_LOCATION_NOT_READY'
 }
 if((Get-Item -LiteralPath $folder -Force).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){
  Fail 'RC012_NSIS_INSTALL_SYMLINK_REFUSED'
 }
 $resources=Join-Path $folder 'resources'
 if(-not(Test-Path -LiteralPath (Join-Path $resources 'app.asar')) -or
  -not(Test-Path -LiteralPath (Join-Path $resources 'core\src\server-v0.3.mjs'))){
  Fail 'RC012_NSIS_INSTALLED_CORE_MISSING'
 }
 return $folder
}
function Assert-NewUninstaller($new,[string]$ownerInstallRoot){
 if(-not $new.PSObject.Properties['UninstallString']){Fail 'RC012_NSIS_UNINSTALLER_NOT_REGISTERED'}
 $command=[string]$new.UninstallString
 if($command -notmatch '^"(?<file>[A-Za-z]:\\[^"]+\.exe)"(?:\s+.*)?$'){
  Fail 'RC012_NSIS_UNINSTALLER_COMMAND_UNRECOGNIZED'
 }
 $file=[IO.Path]::GetFullPath($Matches['file'])
 $dir=[IO.Path]::GetFullPath($ownerInstallRoot)
 if(-not $file.StartsWith($dir+'\',[StringComparison]::OrdinalIgnoreCase) -or
  [IO.Path]::GetFileName($file) -notmatch '^(Uninstall|unins).*\.exe$' -or
  -not(Test-Path -LiteralPath $file -PathType Leaf)){
  Fail 'RC012_NSIS_UNINSTALLER_NOT_OWNER_LOCAL'
 }
 return $file
}
$migrationLock=$null
if($Mode -ne 'Plan'){
 New-Item -ItemType Directory -Path $state -Force|Out-Null
 if((Get-Item -LiteralPath $state -Force).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){
  Fail 'RC012_MIGRATION_STATE_REPARSE_REFUSED'
 }
 $lockPath=Join-Path $state 'migration.lock'
 try{
  $migrationLock=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 }catch [System.IO.IOException]{
  Fail 'RC012_MIGRATION_LOCK_BUSY'
 }
}
try {
if($Mode -eq 'Recover'){
 $r=Read-Receipt
 if(-not $r){Fail 'RC012_NO_RECOVERY_RECEIPT'}
 if($r.phase -eq 'ROLLED_BACK'){Write-Output 'RC012_ALREADY_ROLLED_BACK';return}
 if($r.phase -eq 'PREPARED' -and (Test-Path -LiteralPath $legacy)){
  if(-not(Read-OldRegistration)){Fail 'RC012_PREPARED_STATE_INCONSISTENT'}
  $r.phase='ROLLED_BACK';Save-Receipt $r
  Write-Output 'RC012_NO_CHANGES_TO_ROLLBACK';return
 }
 $new=Find-NewRegistration
 if($new){
  if($r.phase -notin @('INSTALLED','RECOVERY_REQUIRED_NEW_INSTALL_REGISTERED')){
   Fail 'RC012_UNEXPECTED_NEW_INSTALL_REGISTERED'
  }
  $root=Assert-NewInstalled $new
  $uninstaller=Assert-NewUninstaller $new $root
  Assert-NoOwnerGui
  $p=Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait
  if($p.ExitCode -ne 0){Fail ('RC012_NSIS_ROLLBACK_UNINSTALL_FAILED_'+$p.ExitCode)}
  if(Find-NewRegistration){Fail 'RC012_NSIS_UNINSTALL_REGISTRATION_STILL_ACTIVE'}
 }
 if(Test-Path -LiteralPath $legacy){
  if(Test-Path -LiteralPath $failed){Fail 'RC012_RECOVERY_STAGING_PATH_OCCUPIED'}
  Move-Item -LiteralPath $legacy -Destination $failed -ErrorAction Stop
 }
 Restore-Legacy $r
 Write-Output 'RC012_OWNER_LEGACY_GUI_ROLLBACK_PASS';return
}
Assert-MachineLegacyAbsent
$old=Read-OldRegistration
if(-not $old){Fail 'RC012_LEGACY_OWNER_REGISTRATION_NOT_FOUND'}
if(-not(Test-Path -LiteralPath $legacy -PathType Container) -or
 -not(Test-Path -LiteralPath (Join-Path $legacy 'uninstall.ps1') -PathType Leaf)){
 Fail 'RC012_LEGACY_INSTALL_BASELINE_INVALID'
}
Assert-NoOwnerGui
$installer=Assert-Installer
if(Find-NewRegistration){Fail 'RC012_UNIFIED_ALREADY_REGISTERED'}
$otherNsis=@(Get-ItemProperty -Path ($uninstallRoot+'\*') -ErrorAction SilentlyContinue |
 Where-Object {$_.PSObject.Properties['DisplayName'] -and
   $_.DisplayName -match '^Remote Commander [0-9]'})
if($otherNsis.Count){Fail 'RC012_OTHER_NSIS_VERSION_REGISTERED'}
$previous=Read-Receipt
if($previous){Assert-Previous-Rollback $previous $old}
if(Test-Path -LiteralPath $backup){Fail 'RC012_BACKUP_PATH_IN_USE'}
if(Test-Path -LiteralPath $failed){Fail 'RC012_FAILED_INSTALL_QUARANTINE_PRESENT'}
if(Test-Path -LiteralPath (Join-Path $local 'Programs\remote-commander-unified')){
 Fail 'RC012_NSIS_DIRECTORY_ALREADY_PRESENT'
}
$report=[ordered]@{
 result='RC012_OWNER_LEGACY_GUI_MIGRATION_READY';version=$old.version
 targetVersion=$ExpectedVersion;installerSha256=$InstallerSha256.ToLowerInvariant()
 machineWideLegacyPresent=$false;existingGuiRunning=$false
 installerFamily='NSIS';currentFamily='Legacy-owner-inplace'
 repeatAfterVerifiedRollback=[bool]$previous
 rollbackKind='same-volume atomic directory move + exact owner HKCU registry restore'
}
if($Mode -eq 'Plan'){$report|ConvertTo-Json -Compress;return}
New-Item -ItemType Directory -Path $state -Force|Out-Null
if($previous){
 # Existing accepted owner state was restored; preserve its receipt in an
 # immutable hash-addressed journal instead of making every next upgrade fail.
 $history=Join-Path $state 'history'
 New-Item -ItemType Directory -Path $history -Force|Out-Null
 $previousSha=(Get-FileHash -LiteralPath $receipt -Algorithm SHA256).Hash.ToLowerInvariant()
 $destination=Join-Path $history ('rollback-receipt-'+$previousSha+'.json')
 if(Test-Path -LiteralPath $destination){Fail 'RC012_ROLLBACK_RECEIPT_ARCHIVE_COLLISION'}
 [IO.File]::Move($receipt,$destination)
 if((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ine $previousSha){
  Fail 'RC012_ROLLBACK_RECEIPT_ARCHIVE_SHA_MISMATCH'
 }
 Write-Output 'RC012_PRIOR_ROLLBACK_RECEIPT_ARCHIVED'
}
$r=[pscustomobject]@{
 schema=1;phase='PREPARED';legacy=$legacy;backup=$backup;old=$old
 newInstaller=$installer;newSha256=$InstallerSha256.ToLowerInvariant()
 targetVersion=$ExpectedVersion;at=(Get-Date -Format o);newInstallLocation=$null
}
Save-Receipt $r
try{
 Move-Item -LiteralPath $legacy -Destination $backup -ErrorAction Stop
 $r.phase='LEGACY_BACKED_UP';Save-Receipt $r
 Remove-Item -LiteralPath $legacyKey -Recurse -Force -ErrorAction Stop
 $r.phase='REGISTRY_REMOVED';Save-Receipt $r
 $p=Start-Process -FilePath $installer -ArgumentList '/S' -PassThru -Wait
 if($p.ExitCode -ne 0){Fail ('RC012_NSIS_INSTALLER_EXIT_'+$p.ExitCode)}
 $new=Find-NewRegistration
 if(-not $new){
  if($env:GITHUB_ACTIONS -eq 'true'){
   $candidates=@(Get-ItemProperty -Path ($uninstallRoot+'\*') -ErrorAction SilentlyContinue |
     Where-Object {$_.PSObject.Properties['DisplayName'] -and $_.DisplayName -match 'Commander'} |
     Select-Object DisplayName,DisplayVersion,PSChildName,InstallLocation)
   Write-Output ('RC012_NSIS_CI_UNINSTALL_REGISTRATION_DIAG '+($candidates|ConvertTo-Json -Compress -Depth 4))
   $d=Join-Path $local 'Programs'
   $names=@(Get-ChildItem -LiteralPath $d -Directory -ErrorAction SilentlyContinue |
     Where-Object {$_.Name -match 'Commander'}|Select-Object -ExpandProperty Name)
   Write-Output ('RC012_NSIS_CI_PROGRAM_DIRECTORY_DIAG '+($names -join '|'))
  }
  Fail 'RC012_NSIS_REGISTERED_INSTALL_NOT_FOUND'
 }
 $newRoot=Assert-NewInstalled $new
 $r.phase='INSTALLED';$r.newInstallLocation=$newRoot;Save-Receipt $r
 Write-Output 'RC012_OWNER_GUI_TRANSACTIONAL_MIGRATION_INSTALL_PASS'
}catch{
 $errorCode=$_.Exception.Message
 if(Find-NewRegistration){
  $r.phase='RECOVERY_REQUIRED_NEW_INSTALL_REGISTERED';Save-Receipt $r
  throw ('RC012_MIGRATION_FAILED_NEW_INSTALL_NEEDS_SAFE_UNINSTALL: '+$errorCode)
 }
 if(Test-Path -LiteralPath $legacy){
  if(Test-Path -LiteralPath $failed){Fail 'RC012_FAILED_INSTALL_RECOVERY_PATH_CONFLICT'}
  Move-Item -LiteralPath $legacy -Destination $failed
 }
 Restore-Legacy $r
 Write-Output 'RC012_MIGRATION_INSTALL_FAILED_LEGACY_ROLLBACK_PASS'
 throw $errorCode
}
} finally {
 if($migrationLock){$migrationLock.Dispose()}
}
