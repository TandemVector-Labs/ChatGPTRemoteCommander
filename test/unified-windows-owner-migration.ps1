#requires -Version 7.0
# Hosted isolated Windows runner only: synthetic legacy -> real NSIS -> rollback.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP -or -not $env:GITHUB_WORKSPACE){
 throw 'RC012_WINDOWS_MIGRATION_CI_ONLY'
}
$installer=@(Get-ChildItem -LiteralPath (Join-Path $env:GITHUB_WORKSPACE 'dist/unified') -File -Filter 'Remote-Commander-Unified-*-Windows-x64.exe')
if($installer.Count -ne 1){throw 'RC012_MIGRATION_ONE_EXACT_INSTALLER_REQUIRED'}
$exe=$installer[0].FullName
$sha=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
$version='0.12.0-dev.9'
$script=Join-Path $env:GITHUB_WORKSPACE 'packaging/unified/owner-windows-legacy-migrate.ps1'
$legacyKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\RemoteCommander'
$install=Join-Path $env:LOCALAPPDATA 'Programs\Remote Commander'
$state=Join-Path $env:LOCALAPPDATA 'ChatGPTRemoteCommander\migration\unified-owner'
if((Test-Path -LiteralPath $legacyKey) -or (Test-Path -LiteralPath $install) -or
 (Test-Path -LiteralPath $state)){throw 'RC012_CI_HOST_NOT_EMPTY'}
New-Item -ItemType Directory -Path (Join-Path $install 'v0.12.0-dev.1-synthetic') -Force|Out-Null
$sentinel=Join-Path $install 'v0.12.0-dev.1-synthetic\user-original.txt'
[IO.File]::WriteAllText($sentinel,'OWNER_PRESERVE_UNTOUCHED',[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $install 'uninstall.ps1'),'throw "LEGACY_UNINSTALL_REFUSED"',[Text.UTF8Encoding]::new($false))
New-Item -Path $legacyKey -Force|Out-Null
foreach($x in @{
 DisplayName='Remote Commander';DisplayVersion='0.12.0-dev.1';
 InstallLocation=$install;Publisher='TandemVector Labs';
 UninstallString=('pwsh -NoProfile -File "'+(Join-Path $install 'uninstall.ps1')+'"')
}.GetEnumerator()){
 New-ItemProperty -LiteralPath $legacyKey -Name $x.Key -Value $x.Value -PropertyType String -Force|Out-Null
}
try {
 $out=(& $script -Mode Plan -InstallerPath $exe -InstallerSha256 $sha -ExpectedVersion $version|Out-String)
 if($out -notmatch 'RC012_OWNER_LEGACY_GUI_MIGRATION_READY'){throw 'RC012_PLAN_FAILED'}
 Write-Output 'RC012_WINDOWS_LEGACY_TO_NSIS_PREPARED_PASS'
 $bad=$false
 try{& $script -Mode Plan -InstallerPath $exe -InstallerSha256 ('0'*64) -ExpectedVersion $version|Out-Null}catch{$bad=$true}
 if(-not $bad){throw 'RC012_TAMPERED_INSTALLER_WAS_ACCEPTED'}
 Write-Output 'RC012_WINDOWS_MIGRATOR_TAMPER_DENIAL_PASS'
 & $script -Mode Apply -InstallerPath $exe -InstallerSha256 $sha -ExpectedVersion $version
 $r=Get-Content -LiteralPath (Join-Path $state 'receipt.json') -Raw|ConvertFrom-Json
 if($r.phase -ne 'INSTALLED'){throw 'RC012_MIGRATION_NOT_COMMITTED'}
 if(Test-Path -LiteralPath $legacyKey){throw 'RC012_DUPLICATE_UNINSTALL_REGISTRATION'}
 $saved=Join-Path $state 'legacy-install\v0.12.0-dev.1-synthetic\user-original.txt'
 if(-not(Test-Path $saved) -or [IO.File]::ReadAllText($saved) -ne 'OWNER_PRESERVE_UNTOUCHED'){
  throw 'RC012_LEGACY_SNAPSHOT_CONTENT_MISMATCH'
 }
 Write-Output 'RC012_WINDOWS_LEGACY_TO_NSIS_SINGLE_INSTALL_PASS'
 & $script -Mode Recover -ExpectedVersion $version
 if(-not(Test-Path -LiteralPath $legacyKey)){throw 'RC012_LEGACY_REGISTRY_NOT_RESTORED'}
 if(-not(Test-Path -LiteralPath $sentinel) -or [IO.File]::ReadAllText($sentinel) -ne 'OWNER_PRESERVE_UNTOUCHED'){
  throw 'RC012_ROLLBACK_SOURCE_NOT_RESTORED'
 }
 $r=Get-Content -LiteralPath (Join-Path $state 'receipt.json') -Raw|ConvertFrom-Json
 if($r.phase -ne 'ROLLED_BACK'){throw 'RC012_ROLLBACK_NOT_RECORDED'}
 Write-Output 'RC012_WINDOWS_UNIFIED_TXN_ROLLBACK_PASS'
 $receiptPath=Join-Path $state 'receipt.json'
 $firstReceiptSha=(Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash
 $secondPlan=(& $script -Mode Plan -InstallerPath $exe -InstallerSha256 $sha -ExpectedVersion $version|Out-String)
 if($secondPlan -notmatch '"repeatAfterVerifiedRollback":true'){
  throw 'RC012_CANNOT_PLAN_SECOND_UPGRADE_AFTER_ROLLBACK'
 }
 Write-Output 'RC012_WINDOWS_SECOND_UPGRADE_READONLY_PLAN_PASS'
 # Two owner agents must never mutate one machine's install concurrently.
 $lockPath=Join-Path $state 'migration.lock'
 $lease=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,
   [IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try{
  $busyRefused=$false
  try{& $script -Mode Apply -InstallerPath $exe -InstallerSha256 $sha -ExpectedVersion $version|Out-Null}
  catch{$busyRefused=$_.Exception.Message -match 'RC012_MIGRATION_LOCK_BUSY'}
  if(-not $busyRefused){throw 'RC012_LOCKED_CONCURRENT_INSTALL_NOT_REFUSED'}
 }finally{$lease.Dispose()}
 if((Get-FileHash $receiptPath -Algorithm SHA256).Hash -ne $firstReceiptSha){
  throw 'RC012_LOCKED_ATTEMPT_CHANGED_PREVIOUS_RECEIPT'
 }
 Write-Output 'RC012_WINDOWS_CONCURRENT_MIGRATION_LOCK_NEGATIVE_PASS'
 # Any mismatch in restored HKCU owner baseline must refuse re-enrollment.
 Set-ItemProperty -LiteralPath $legacyKey -Name DisplayVersion -Value '0.12.0-dev.99'
 try{
  $staleRefused=$false
  try{& $script -Mode Plan -InstallerPath $exe -InstallerSha256 $sha -ExpectedVersion $version|Out-Null}
  catch{$staleRefused=$_.Exception.Message -match 'RC012_ROLLBACK_OWNER_BASELINE_CHANGED'}
  if(-not $staleRefused){throw 'RC012_STALE_OWNER_BASELINE_NOT_REFUSED'}
 }finally{Set-ItemProperty -LiteralPath $legacyKey -Name DisplayVersion -Value '0.12.0-dev.1'}
 Write-Output 'RC012_WINDOWS_STALE_RESTORED_OWNER_NEGATIVE_PASS'
 & $script -Mode Apply -InstallerPath $exe -InstallerSha256 $sha -ExpectedVersion $version
 $r=Get-Content $receiptPath -Raw|ConvertFrom-Json
 if($r.phase -ne 'INSTALLED'){throw 'RC012_SECOND_NSIS_INSTALL_NOT_COMMITTED'}
 $history=@(Get-ChildItem (Join-Path $state 'history') -File -Filter 'rollback-receipt-*.json')
 if($history.Count -ne 1 -or (Get-FileHash $history[0].FullName -Algorithm SHA256).Hash -ne $firstReceiptSha){
  throw 'RC012_PREVIOUS_ROLLBACK_RECEIPT_NOT_PRESERVED'
 }
 if(Test-Path -LiteralPath $legacyKey){throw 'RC012_SECOND_NSIS_DUPLICATE_LEGACY_REGISTRATION'}
 Write-Output 'RC012_WINDOWS_SECOND_NSIS_INSTALL_AND_PRIOR_RECEIPT_ARCHIVE_PASS'
 & $script -Mode Recover -ExpectedVersion $version
 $final=Get-Content $receiptPath -Raw|ConvertFrom-Json
 if($final.phase -ne 'ROLLED_BACK' -or -not(Test-Path -LiteralPath $legacyKey)){
  throw 'RC012_SECOND_ROLLBACK_NOT_COMMITTED'
 }
 if([IO.File]::ReadAllText($sentinel) -ne 'OWNER_PRESERVE_UNTOUCHED'){
  throw 'RC012_SECOND_ROLLBACK_ORIGINAL_DATA_CHANGED'
 }
 Write-Output 'RC012_WINDOWS_REPEATABLE_MIGRATION_AND_HISTORY_ROLLBACK_PASS'
}finally{
 # Runner is ephemeral. Remove only the synthetic fixture after proving the
 # original marker has come back. Never run this fixture on the owner machine.
 if(Test-Path -LiteralPath $sentinel){
  if([IO.File]::ReadAllText($sentinel) -eq 'OWNER_PRESERVE_UNTOUCHED'){
   Remove-Item -LiteralPath $legacyKey -Recurse -Force -ErrorAction SilentlyContinue
   Remove-Item -LiteralPath $install -Recurse -Force -ErrorAction SilentlyContinue
  }
 }
}
