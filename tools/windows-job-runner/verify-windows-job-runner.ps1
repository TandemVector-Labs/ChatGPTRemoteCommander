[CmdletBinding()]
param([switch]$Ensure,[switch]$VerifyOnly)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($Ensure -and $VerifyOnly){throw 'WIN_JOB_RUNNER_EXCLUSIVE_MODE_REQUIRED'}
$root=$PSScriptRoot
$manifestPath=Join-Path $root 'release-manifest.json'
$manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if($manifest.schema -ne 1 -or $manifest.platform -ne 'win32' -or
   $manifest.arch -ne 'x64' -or $manifest.runtime -ne 'self-contained' -or
   $manifest.singleFile -ne $true -or
   $manifest.runner -cne 'dist/win-x64/CommanderWindowsJobRunner.exe'){
  throw 'WIN_JOB_RUNNER_RELEASE_MANIFEST_INVALID'
}
function Verify-Hash([string]$Target,[string]$Expected) {
  if($Expected -cnotmatch '^[a-f0-9]{64}$' -or
     -not (Test-Path -LiteralPath $Target -PathType Leaf)){
    throw ('WIN_JOB_RUNNER_SOURCE_OR_ARTIFACT_MISSING: '+$Target)
  }
  $file=Get-Item -LiteralPath $Target -Force
  if($file.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'WIN_JOB_RUNNER_REPARSE_TARGET_REJECTED'
  }
  $actual=(Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant()
  if($actual -cne $Expected) {
    throw ('WIN_JOB_RUNNER_RELEASE_SHA_MISMATCH: '+$Target)
  }
}
Verify-Hash (Join-Path $root 'Program.cs') $manifest.sourceSha256
Verify-Hash (Join-Path $root 'CommanderWindowsJobRunner.csproj') $manifest.projectSha256
$runner=Join-Path $root 'dist\win-x64\CommanderWindowsJobRunner.exe'
if(-not(Test-Path -LiteralPath $runner -PathType Leaf) -and $Ensure){
  $dotnet=Get-Command dotnet -ErrorAction SilentlyContinue
  if(-not $dotnet) {throw 'WIN_JOB_RUNNER_PREBUILT_ASSET_OR_DOTNET_SDK_REQUIRED'}
  Push-Location $root
  try {
    if((& $dotnet.Source --version).Trim() -ne '8.0.427'){throw 'WIN_JOB_RUNNER_PINNED_SDK8_REQUIRED'}
    & $dotnet.Source publish (Join-Path $root 'CommanderWindowsJobRunner.csproj') -c Release -r win-x64 --self-contained true '-p:PublishSingleFile=true' '-p:PublishTrimmed=true' '-p:Deterministic=true' '-p:ContinuousIntegrationBuild=true' '-p:DebugType=none' '-p:IncludeSourceRevisionInInformationalVersion=false' -o (Join-Path $root 'dist\win-x64') --nologo
  } finally { Pop-Location }
  if($LASTEXITCODE -ne 0){throw 'WIN_JOB_RUNNER_BUILD_FAILED'}
}
Verify-Hash $runner $manifest.runnerSha256
$command=Get-Command node -ErrorAction Stop
# Only a benign read-only version probe; executable hash is checked beforehand.
$runnerExitCode=-1
$previousErrorActionPreference=$ErrorActionPreference
try {
  # The runner deliberately writes its receipt to stderr; capture it as data,
  # not as a terminating PowerShell NativeCommandError under Stop mode.
  $ErrorActionPreference='Continue'
  $probe=& $runner --timeout-ms 4000 --cwd $root -- node --version 2>&1
  $runnerExitCode=$LASTEXITCODE
} finally {
  $ErrorActionPreference=$previousErrorActionPreference
}
if($runnerExitCode -ne 0 -or -not ($probe -match 'RC_JOB_RESULT_JSON:.*"timedOut":false') -or
   -not ($probe -match '^v\d+\.')){
  throw 'WIN_JOB_RUNNER_NATIVE_PROBE_FAILED'
}
Write-Output ('WIN_JOB_RUNNER_VERIFIED sha256='+$manifest.runnerSha256+' selfContained=true')
