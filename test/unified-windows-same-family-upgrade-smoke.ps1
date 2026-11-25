#requires -Version 7.0
# Disposable GitHub-hosted Windows ONLY: real NSIS dev.8 -> dev.9 -> dev.8.
param(
 [Parameter(Mandatory)][string]$OldInstaller,
 [Parameter(Mandatory)][string]$CandidateInstaller
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
 $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:CI -ne 'true' -or
 [string]::IsNullOrWhiteSpace($env:GITHUB_WORKSPACE) -or
 [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)){
 throw 'RC012_NSIS_SAME_FAMILY_HOSTED_ONLY'
}
if((git -C $env:GITHUB_WORKSPACE rev-parse HEAD).Trim() -cne $env:GITHUB_SHA){
 throw 'RC012_NSIS_EXACT_SOURCE_CHANGED'
}
$oldVersion='0.12.0-dev.8'
$newVersion=(node -p 'require(process.argv[1]).version' (Join-Path $env:GITHUB_WORKSPACE 'package.json')).Trim()
if($newVersion -cne '0.12.0-dev.9'){throw 'RC012_NSIS_EXPECTED_CANDIDATE_CHANGED'}
$old=Get-Item -LiteralPath $OldInstaller -ErrorAction Stop
$new=Get-Item -LiteralPath $CandidateInstaller -ErrorAction Stop
if($old.FullName -ceq $new.FullName -or
 $old.Name -cne "Remote-Commander-Unified-$oldVersion-Windows-x64.exe" -or
 $new.Name -cne "Remote-Commander-Unified-$newVersion-Windows-x64.exe" -or
 $old.Length -ne 122081565 -or $new.Length -lt 80000000){
 throw 'RC012_NSIS_NATIVE_ASSET_SET_INVALID'
}
$oldHash=(Get-FileHash $old.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$newHash=(Get-FileHash $new.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
if($oldHash -cne '57c0d5f895b0b051857af03a8196ba968866a64637adb024cd4b261fbc5e5272' -or
 $newHash -eq $oldHash){throw 'RC012_NSIS_SOURCE_BYTES_UNVERIFIED'}
$install=Join-Path $env:LOCALAPPDATA 'Programs\remote-commander-unified'
$exe=Join-Path $install 'Remote Commander.exe'
$uninstallExe=Join-Path $install 'Uninstall Remote Commander.exe'
$registry='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
$owner=Join-Path $env:LOCALAPPDATA 'ChatGPTRemoteCommander'
$tunnels=Join-Path $env:APPDATA 'tunnel-client'
$marker=Join-Path $owner 'RC012_CI_PRESERVE.txt'
$tunnelMarker=Join-Path $tunnels 'RC012_CI_SYNTHETIC_NO_SECRET.txt'
$baseline='RC012-CI-SYNTHETIC-OWNER-PRESERVE-NO-SECRETS'
function Read-Registrations {
 return @(Get-ItemProperty $registry -ErrorAction SilentlyContinue |
  Where-Object {$_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like 'Remote Commander 0.12.0*'})
}
if(@(Read-Registrations).Count -ne 0 -or (Test-Path $install) -or
 (Test-Path $owner) -or (Test-Path $tunnels) -or
 @(Get-Process tunnel-client -ErrorAction SilentlyContinue).Count -ne 0){
 throw 'RC012_NSIS_DISPOSABLE_HOST_NOT_EMPTY'
}
New-Item -ItemType Directory -Path $owner,$tunnels -ErrorAction Stop | Out-Null
[IO.File]::WriteAllText($marker,$baseline,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($tunnelMarker,$baseline,[Text.UTF8Encoding]::new($false))
$markerSha=(Get-FileHash $marker -Algorithm SHA256).Hash
function Assert-OwnerState {
 foreach($f in @($marker,$tunnelMarker)){
  if(!(Test-Path -LiteralPath $f -PathType Leaf) -or
   (Get-FileHash $f -Algorithm SHA256).Hash -ne $markerSha){
   throw 'RC012_NSIS_OWNER_SYNTHETIC_STATE_CHANGED'
  }
 }
 if(@(Get-Process tunnel-client -ErrorAction SilentlyContinue).Count -ne 0){
  throw 'RC012_NSIS_TUNNEL_PROCESS_UNEXPECTED'
 }
}
function Assert-Version([string]$version) {
 $installed=@(Read-Registrations)
 if($installed.Count -ne 1 -or $installed[0].DisplayVersion -cne $version -or
  !(Test-Path $exe -PathType Leaf) -or
  !(Test-Path $uninstallExe -PathType Leaf) -or
  !(Test-Path (Join-Path $install 'resources\core') -PathType Container)){
  throw "RC012_NSIS_INSTALLED_IDENTITY_OR_NATIVE_CORE_FAILED_$version"
 }
 Assert-OwnerState
}
function Invoke-Installer([string]$file,[string]$version) {
 $proc=Start-Process -FilePath $file -ArgumentList '/S' -PassThru -NoNewWindow
 try {
  if(!$proc.WaitForExit(180000)){
   Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
   throw "RC012_NSIS_INSTALLER_TIMEOUT_$version"
  }
  if($proc.ExitCode -ne 0){throw "RC012_NSIS_INSTALLER_FAILED_$version"}
 } finally {$proc.Dispose()}
 Assert-Version $version
}
# No production identity, no user sign-in, no tunnel or Full Access grant.
# The hosted runner is disposable; real host process/installer never touched.
Invoke-Installer $old.FullName $oldVersion
$oldExeSha=(Get-FileHash $exe -Algorithm SHA256).Hash
Write-Output 'RC012_NSIS_INSTALLED_OLD_NATIVE_VERSION_PASS'
Invoke-Installer $new.FullName $newVersion
Write-Output 'RC012_NSIS_REAL_SAME_FAMILY_UPGRADE_OWNER_PRESERVE_PASS'
Invoke-Installer $old.FullName $oldVersion
if((Get-FileHash $exe -Algorithm SHA256).Hash -ne $oldExeSha){
 throw 'RC012_NSIS_OLD_BINARY_NOT_RESTORED'
}
Write-Output 'RC012_NSIS_REAL_SAME_FAMILY_DOWNGRADE_AND_OWNER_PRESERVE_PASS'
Write-Output ('RC012_NSIS_QA_DIGESTS old='+$oldHash+' new='+$newHash)
Write-Output 'RC012_NSIS_NATIVE_CYCLE_QA_PASS_NO_PROMOTE'
