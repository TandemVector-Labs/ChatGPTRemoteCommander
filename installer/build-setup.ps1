param(
  [string]$VersionOverride = '',
  [string]$SourceRef = '',
  [string]$ExpectedCommit = '',
  [string]$BrowserInstaller = '',
  [string]$SourceBundle = '',
  [string]$SourceSnapshot = '',
  [switch]$AllowDirty
)
$ErrorActionPreference='Stop'
$Root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Package=Get-Content (Join-Path $Root 'package.json') -Raw|ConvertFrom-Json
$Version=if($VersionOverride){$VersionOverride}else{[string]$Package.version}
if($Version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?$'){throw "Invalid setup version: $Version"}
if($Version -cne [string]$Package.version){throw "SETUP_VERSION_MUST_MATCH_SOURCE_PACKAGE"}

$Head=(git -C $Root rev-parse HEAD).Trim()
if($Head -notmatch '^[0-9a-f]{40}$'){throw 'Could not resolve repository HEAD.'}
if($ExpectedCommit){
  if($ExpectedCommit.ToLowerInvariant() -ne $Head){throw "ExpectedCommit $ExpectedCommit does not equal HEAD $Head"}
}else{$ExpectedCommit=$Head}

if(-not $SourceRef){
  $SourceRef=(git -C $Root branch --show-current).Trim()
  if(-not $SourceRef){throw 'SourceRef is required for a detached HEAD.'}
}
if($SourceRef -notmatch '^[A-Za-z0-9._/-]{1,128}$'){throw "Invalid SourceRef: $SourceRef"}

if(-not $AllowDirty){
  $untracked=@(& git.exe -C $Root ls-files --others --exclude-standard)
  if($LASTEXITCODE -ne 0){throw 'Setup release build could not enumerate untracked files.'}
  if($untracked.Count -gt 0){throw "Setup release build refuses untracked files: $($untracked.Count)"}

  & git.exe -C $Root diff --cached --quiet --
  if($LASTEXITCODE -ne 0){throw 'Setup release build refuses staged tracked changes.'}

  & git.exe -C $Root diff --ignore-space-at-eol --exit-code -- | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Setup release build refuses substantive unstaged tracked changes.'}

  $trackedDirty=@(& git.exe -C $Root status --porcelain --untracked-files=no)
  if($LASTEXITCODE -ne 0){throw 'Setup release build could not inspect tracked worktree state.'}
  if($trackedDirty.Count -gt 0){
    Write-Output "SETUP_TRACKED_EOL_DRIFT_ACCEPTED count=$($trackedDirty.Count)"
  }
}

$RunnerVerifier=Join-Path $Root 'tools\windows-job-runner\verify-windows-job-runner.ps1'
if(-not(Test-Path -LiteralPath $RunnerVerifier -PathType Leaf)){throw 'WINDOWS_JOB_RUNNER_VERIFIER_MISSING'}
& pwsh.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $RunnerVerifier -Ensure
if($LASTEXITCODE -ne 0){throw 'WINDOWS_JOB_RUNNER_BUILD_OR_VERIFY_FAILED'}
$RunnerManifest=Get-Content -LiteralPath (Join-Path $Root 'tools\windows-job-runner\release-manifest.json') -Raw | ConvertFrom-Json
$RunnerPath=Join-Path $Root 'tools\windows-job-runner\dist\win-x64\CommanderWindowsJobRunner.exe'
if(-not(Test-Path -LiteralPath $RunnerPath -PathType Leaf)){throw 'WINDOWS_JOB_RUNNER_BUILD_OUTPUT_MISSING'}
$RunnerSha=(Get-FileHash -LiteralPath $RunnerPath -Algorithm SHA256).Hash.ToLowerInvariant()
if($RunnerSha -cne [string]$RunnerManifest.runnerSha256){throw 'WINDOWS_JOB_RUNNER_BUILD_HASH_MISMATCH'}

& (Join-Path $Root 'desktop\build-windows.ps1')
if($LASTEXITCODE -ne 0){throw 'Desktop payload build failed.'}

$isccCandidates=@(
  (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
  (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe')
)
$Iscc=$isccCandidates|Where-Object{$_ -and (Test-Path -LiteralPath $_ -PathType Leaf)}|Select-Object -First 1
if(-not $Iscc){
  $keys=@(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  $entry=Get-ItemProperty $keys -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName -like 'Inno Setup version *'}|Select-Object -First 1
  if($entry.InstallLocation){
    $candidate=Join-Path ([string]$entry.InstallLocation) 'ISCC.exe'
    if(Test-Path -LiteralPath $candidate -PathType Leaf){$Iscc=$candidate}
  }
}
if(-not $Iscc){throw 'Inno Setup 6 compiler (ISCC.exe) is required to build the single-file installer.'}

$args=@(
  ('/DMyVersion='+$Version),
  ('/DMyCommit='+$ExpectedCommit),
  ('/DMySourceRef='+$SourceRef),
  ('/DWindowsJobRunner='+$RunnerPath)
)
$BrowserSha=$null
if($BrowserInstaller){
  $BrowserInstaller=[IO.Path]::GetFullPath($BrowserInstaller)
  if(-not(Test-Path -LiteralPath $BrowserInstaller -PathType Leaf)){throw "Browser installer not found: $BrowserInstaller"}
  if([IO.Path]::GetExtension($BrowserInstaller) -ne '.exe'){throw 'Browser installer must be an .exe artifact.'}
  $BrowserSha=(Get-FileHash -LiteralPath $BrowserInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
  $args+=('/DBrowserSetup='+$BrowserInstaller)
}
$SnapshotSha=$null
if($SourceBundle){
  if($SourceSnapshot){throw 'CORE_SHALLOW_SNAPSHOT_AND_LEGACY_BUNDLE_CONFLICT'}
  if($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP){
    throw 'CORE_LEGACY_BUNDLE_DIRECT_USE_FORBIDDEN'
  }
  # Legacy CI still creates a historical .bundle but it must NEVER enter
  # a release payload. Recreate the exact pinned source as a one-commit
  # shallow bare Git snapshot from the trusted checkout instead.
  $SourceSnapshot=Join-Path $env:RUNNER_TEMP 'remote-commander-core-shallow.zip'
  if(Test-Path -LiteralPath $SourceSnapshot){throw 'CORE_SHALLOW_SNAPSHOT_OUTPUT_PREEXISTS'}
  $helper=Join-Path $Root 'tools\offline-shallow-source.ps1'
  $created=@(& pwsh.exe -NoLogo -NoProfile -NonInteractive -File $helper -Mode Create -SourceRoot $Root -SourceRef $SourceRef -ExpectedCommit $ExpectedCommit -Archive $SourceSnapshot)
  if($LASTEXITCODE -ne 0){throw 'CORE_SHALLOW_SNAPSHOT_BUILD_FAILED'}
  $createdRecord=($created|Select-Object -Last 1|ConvertFrom-Json)
  if($createdRecord.status -ne 'SHALLOW_SOURCE_SNAPSHOT_CREATED'){throw 'CORE_SHALLOW_SNAPSHOT_BUILD_RECEIPT_INVALID'}
  Write-Output 'LEGACY_GIT_BUNDLE_NEVER_EMBEDDED'
}
if($SourceSnapshot){
  $SourceSnapshot=[IO.Path]::GetFullPath($SourceSnapshot)
  if(-not(Test-Path -LiteralPath $SourceSnapshot -PathType Leaf) -or
     [IO.Path]::GetExtension($SourceSnapshot) -ne '.zip'){throw 'CORE_SHALLOW_SNAPSHOT_REQUIRED'}
  # An on-runner native regression proves the actual offline exact-commit
  # import and historical-object denial before compiling the Setup EXE.
  & node.exe --test (Join-Path $Root 'test/offline-shallow-source.test.mjs') | Out-Host
  if($LASTEXITCODE -ne 0){throw 'CORE_SHALLOW_SOURCE_NATIVE_REGRESSION_FAILED'}
  $helper=Join-Path $Root 'tools\offline-shallow-source.ps1'
  $receipt=@(& pwsh.exe -NoLogo -NoProfile -NonInteractive -File $helper -Mode Verify -SourceRef $SourceRef -ExpectedCommit $ExpectedCommit -Archive $SourceSnapshot)
  if($LASTEXITCODE -ne 0){throw 'CORE_SHALLOW_SNAPSHOT_VERIFICATION_FAILED'}
  $parsed=($receipt|Select-Object -Last 1|ConvertFrom-Json)
  if($parsed.status -ne 'SHALLOW_SOURCE_SNAPSHOT_VERIFIED'){throw 'CORE_SHALLOW_SNAPSHOT_NOT_VERIFIED'}
  $SnapshotSha=(Get-FileHash -LiteralPath $SourceSnapshot -Algorithm SHA256).Hash.ToLowerInvariant()
  $args+=('/DCoreSourceSnapshot='+$SourceSnapshot)
  $args+=('/DCoreSourceSnapshotSHA256='+$SnapshotSha)
}
$args+=(Join-Path $PSScriptRoot 'RemoteCommander.iss')

& $Iscc @args
if($LASTEXITCODE -ne 0){throw "Inno Setup compile failed: $LASTEXITCODE"}

$Setup=Join-Path $Root ("dist\installer\Remote-Commander-Setup-v$Version.exe")
if(-not(Test-Path -LiteralPath $Setup -PathType Leaf)){throw "Expected setup artifact missing: $Setup"}
$Sha=(Get-FileHash -LiteralPath $Setup -Algorithm SHA256).Hash.ToLowerInvariant()
$Signature=Get-AuthenticodeSignature -LiteralPath $Setup
$result=[ordered]@{
  status='REMOTE_COMMANDER_SETUP_BUILD_PASS'
  version=$Version
  sourceRef=$SourceRef
  commit=$ExpectedCommit
  setup=$Setup
  sha256=$Sha
  signatureStatus=[string]$Signature.Status
  browserBundled=[bool]$BrowserInstaller
  browserSha256=$BrowserSha
  windowsJobRunnerSha256=$RunnerSha
  coreBundled=[bool]$SourceSnapshot
  coreSourceSnapshotSha256=$SnapshotSha
}
$result|ConvertTo-Json -Depth 5
