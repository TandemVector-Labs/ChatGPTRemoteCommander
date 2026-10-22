param(
  [string]$VersionOverride = '',
  [string]$SourceRef = '',
  [ValidateSet('upstream','organization')][string]$SourceRepository = 'upstream',
  [string]$ExpectedCommit = '',
  [string]$BrowserInstaller = '',
  [switch]$AllowDirty
)
$ErrorActionPreference='Stop'
$Root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Package=Get-Content (Join-Path $Root 'package.json') -Raw|ConvertFrom-Json
$Version=if($VersionOverride){$VersionOverride}else{[string]$Package.version}
if($Version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?$'){throw "Invalid setup version: $Version"}

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
if($SourceRepository -eq 'organization') {
  if($ExpectedCommit -notmatch '^[0-9a-f]{40}$'){throw 'ORGANIZATION_SOURCE_REQUIRES_PINNED_COMMIT'}
  # Never compile a "working" preview if the actual runtime installer cannot fetch its ref.
  $origin='https://github.com/TandemVector-Labs/ChatGPTRemoteCommander.git'
  $advertised=@(& git -c credential.interactive=never ls-remote --exit-code --heads $origin $SourceRef 2>$null)
  if($LASTEXITCODE -ne 0 -or $advertised.Count -ne 1){throw 'ORGANIZATION_SOURCE_REF_NOT_ADVERTISED'}
  $advertisedSha=($advertised[0] -split '\s+')[0].ToLowerInvariant()
  if($advertisedSha -ne $ExpectedCommit){throw 'ORGANIZATION_SOURCE_REF_SHA_MISMATCH'}
}

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
  ('/DMySourceRepository='+$SourceRepository)
)
$BrowserSha=$null
if($BrowserInstaller){
  $BrowserInstaller=[IO.Path]::GetFullPath($BrowserInstaller)
  if(-not(Test-Path -LiteralPath $BrowserInstaller -PathType Leaf)){throw "Browser installer not found: $BrowserInstaller"}
  if([IO.Path]::GetExtension($BrowserInstaller) -ne '.exe'){throw 'Browser installer must be an .exe artifact.'}
  $BrowserSha=(Get-FileHash -LiteralPath $BrowserInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
  $args+=('/DBrowserSetup='+$BrowserInstaller)
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
  sourceRepository=$SourceRepository
  commit=$ExpectedCommit
  setup=$Setup
  sha256=$Sha
  signatureStatus=[string]$Signature.Status
  browserBundled=[bool]$BrowserInstaller
  browserSha256=$BrowserSha
}
$result|ConvertTo-Json -Depth 5
