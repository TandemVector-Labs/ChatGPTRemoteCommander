# CI ONLY: on an ephemeral Windows runner, prove unsigned QA installer will
# refuse to install when a legacy Inno Commander registration is present.
$ErrorActionPreference='Stop'
if(-not $env:GITHUB_ACTIONS){throw 'RC012_GUARD_TEST_CI_ONLY'}
$key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\RemoteCommander'
if(Test-Path -LiteralPath $key){throw 'RC012_GUARD_TEST_EXISTING_OWNER_STATE_REFUSED'}
$installDir=Join-Path $env:LOCALAPPDATA 'Programs\Remote Commander'
if(Test-Path -LiteralPath $installDir){throw 'RC012_GUARD_TEST_EXISTING_INSTALL_REFUSED'}
$exe=@(Get-ChildItem -LiteralPath 'dist/unified' -File -Filter 'Remote-Commander-Unified-*-Windows-x64.exe')
if($exe.Count -ne 1){throw 'RC012_GUARD_TEST_EXACT_INSTALLER_REQUIRED'}
New-Item -Path $key -Force | Out-Null
try {
  New-ItemProperty -LiteralPath $key -Name UninstallString -PropertyType String -Value 'C:\RC012-fixture\unins000.exe' -Force | Out-Null
  $p=Start-Process -FilePath $exe[0].FullName -ArgumentList '/S' -PassThru -Wait -NoNewWindow
  if($p.ExitCode -eq 0){throw 'RC012_LEGACY_INNO_BLOCKER_NOT_ENFORCED'}
  if(Test-Path -LiteralPath $installDir){throw 'RC012_DUPLICATE_INSTALL_WAS_CREATED'}
  Write-Output ('RC012_LEGACY_INSTALL_GUARD_CI_PASS exit='+$p.ExitCode)
} finally {
  Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction Stop
}
