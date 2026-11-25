function Install-CommanderWindowsJobRunner([string]$InstallDir, [string]$SourcePath = '', [string]$ManifestRoot = $InstallDir) {
  $runnerRoot=Join-Path $ManifestRoot 'tools\windows-job-runner'
  $manifestPath=Join-Path $runnerRoot 'release-manifest.json'
  if(-not(Test-Path -LiteralPath $manifestPath -PathType Leaf)){throw 'WINDOWS_JOB_RUNNER_MANIFEST_MISSING'}
  $manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if($manifest.schema -ne 1 -or $manifest.platform -ne 'win32' -or
     $manifest.arch -ne 'x64' -or $manifest.runtime -ne 'self-contained' -or
     $manifest.singleFile -ne $true -or
     $manifest.runner -cne 'dist/win-x64/CommanderWindowsJobRunner.exe' -or
     [string]$manifest.runnerSha256 -cnotmatch '^[a-f0-9]{64}$'){
    throw 'WINDOWS_JOB_RUNNER_RELEASE_MANIFEST_INVALID'
  }
  $verifiedTarget=Join-Path $runnerRoot 'dist\win-x64\CommanderWindowsJobRunner.exe'
  $installedTarget=Join-Path $InstallDir 'tools\windows-job-runner\dist\win-x64\CommanderWindowsJobRunner.exe'
  $source=$SourcePath
  if(-not $source -and (Test-Path -LiteralPath $installedTarget -PathType Leaf)){$source=$installedTarget}
  if($source){
    $source=[IO.Path]::GetFullPath($source)
    $file=Get-Item -LiteralPath $source -ErrorAction Stop
    if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
       $file.Extension -ine '.exe'){throw 'WINDOWS_JOB_RUNNER_SOURCE_UNTRUSTED'}
    $actual=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    if($actual -cne [string]$manifest.runnerSha256){throw 'WINDOWS_JOB_RUNNER_SOURCE_SHA_MISMATCH'}
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $verifiedTarget) | Out-Null
    if([IO.Path]::GetFullPath($source) -ine [IO.Path]::GetFullPath($verifiedTarget)){
      Copy-Item -LiteralPath $source -Destination $verifiedTarget -Force
    }
  }
  $verifier=Join-Path $runnerRoot 'verify-windows-job-runner.ps1'
  if(-not(Test-Path -LiteralPath $verifiedTarget -PathType Leaf)){
    & pwsh.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $verifier -Ensure
  }else{
    & pwsh.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $verifier -VerifyOnly
  }
  if($LASTEXITCODE -ne 0){throw 'WINDOWS_JOB_RUNNER_INSTALL_OR_VERIFY_FAILED'}
  $verifiedSha=(Get-FileHash -LiteralPath $verifiedTarget -Algorithm SHA256).Hash.ToLowerInvariant()
  if($verifiedSha -cne [string]$manifest.runnerSha256){throw 'WINDOWS_JOB_RUNNER_VERIFIED_SHA_MISMATCH'}
  $installedSha=''
  if(Test-Path -LiteralPath $installedTarget -PathType Leaf){
    $installedSha=(Get-FileHash -LiteralPath $installedTarget -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  if($installedSha -cne [string]$manifest.runnerSha256){
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $installedTarget) | Out-Null
    $installTemp=$installedTarget+'.stage-'+$PID
    try{
      Copy-Item -LiteralPath $verifiedTarget -Destination $installTemp -Force
      $tempSha=(Get-FileHash -LiteralPath $installTemp -Algorithm SHA256).Hash.ToLowerInvariant()
      if($tempSha -cne [string]$manifest.runnerSha256){throw 'WINDOWS_JOB_RUNNER_INSTALL_TEMP_SHA_MISMATCH'}
      Move-Item -LiteralPath $installTemp -Destination $installedTarget -Force
    }finally{
      if(Test-Path -LiteralPath $installTemp){Remove-Item -LiteralPath $installTemp -Force -ErrorAction SilentlyContinue}
    }
    $installedSha=(Get-FileHash -LiteralPath $installedTarget -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  if($installedSha -cne [string]$manifest.runnerSha256){throw 'WINDOWS_JOB_RUNNER_INSTALL_SHA_MISMATCH'}
  Write-Host ('WINDOWS_JOB_RUNNER_INSTALL_PASS sha256='+[string]$manifest.runnerSha256)
}
