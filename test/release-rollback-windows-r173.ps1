#requires -Version 7.0
param(
 [Parameter(Mandatory=$true)][string]$ExpectedCommit,
 [Parameter(Mandatory=$true)][string]$WindowsJobRunnerPath
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(-not $IsWindows -or $env:CI -ne 'true' -or -not $env:RUNNER_TEMP -or -not $env:GITHUB_WORKSPACE){throw 'R173_WINDOWS_CI_ONLY'}
if($ExpectedCommit -notmatch '^[0-9a-f]{40}$'){throw 'R173_EXACT_COMMIT_REQUIRED'}
$Source=[IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
$Root=Join-Path ([IO.Path]::GetFullPath($env:RUNNER_TEMP)) 'remote-commander-rollback-r173'
$Install=Join-Path $Root 'INSTALL'
$Baseline='362375c464948be3001b307650c13fc3353ed05b'
$RollbackBaseline='8ccf0fd16355a4ab79844feec6c295366763df0d'
$RollbackVersion='0.11.0-dev.23'
$OldLocal=[string]$env:LOCALAPPDATA
$OldRoaming=[string]$env:APPDATA
$OldTemp=[string]$env:TEMP
$OldTmp=[string]$env:TMP
$Started=[DateTime]::UtcNow
$Ports=[System.Collections.Generic.HashSet[int]]::new()
$JobRunner=[IO.Path]::GetFullPath($WindowsJobRunnerPath)
$JobRunnerManifest=Join-Path $Source 'tools\windows-job-runner\release-manifest.json'
if(-not(Test-Path -LiteralPath $JobRunner -PathType Leaf) -or -not(Test-Path -LiteralPath $JobRunnerManifest -PathType Leaf)){throw 'R173_JOB_RUNNER_REQUIRED'}
$runnerMetadata=Get-Content -LiteralPath $JobRunnerManifest -Raw|ConvertFrom-Json
if($runnerMetadata.runner -cne 'dist/win-x64/CommanderWindowsJobRunner.exe' -or $runnerMetadata.runtime -cne 'self-contained' -or $runnerMetadata.arch -cne 'x64') {throw 'R173_JOB_RUNNER_MANIFEST_INVALID'}
$runnerHash=(Get-FileHash -LiteralPath $JobRunner -Algorithm SHA256).Hash.ToLowerInvariant()
if($runnerHash -cne [string]$runnerMetadata.runnerSha256){throw 'R173_JOB_RUNNER_SHA_MISMATCH'}
$JobRunnerVerified=$true
[void]$Ports.Add(47831)
$script:Stages=@()
$Failure=$null
. (Join-Path $Source 'test\router-ports-windows-r189.ps1')
function Assert-Head([string]$Dir,[string]$Want){
  $got=(& git.exe -C $Dir rev-parse HEAD).Trim()
  if($LASTEXITCODE -ne 0 -or $got -ne $Want){throw ('R173_HEAD_MISMATCH_'+$Dir+'_'+$got)}
}
function Readback([string]$Name,[string]$Sha,[string]$Version){
  $route=Join-Path $Root 'STATE\ChatGPTRemoteCommander\routing\default.json'
  if(-not(Test-Path -LiteralPath $route -PathType Leaf)){throw ('R173_NO_ROUTE_'+$Name)}
  $state=Get-Content $route -Raw|ConvertFrom-Json -AsHashtable
  $candidatePorts=@(Get-RouterPortsR189 -State $state)
  if($state['profile'] -ne 'default' -or $state['active']['commit'] -ne $Sha -or $state['active']['version'] -ne $Version){throw ('R173_ROUTE_WRONG_'+$Name)}
  foreach($port in $candidatePorts){[void]$Ports.Add([int]$port)}
  Copy-Item $route (Join-Path $Root ('ROUTE_'+$Name+'.json')) -ErrorAction Stop
  $health=Invoke-RestMethod 'http://127.0.0.1:47831/health' -TimeoutSec 6
  if($health.ok -ne $true -or [string]$health.version -ne $Version){throw ('R173_HEALTH_WRONG_'+$Name)}
  [IO.File]::WriteAllText((Join-Path $Root ('HEALTH_'+$Name+'.json')),(ConvertTo-Json $health -Depth 12)+[Environment]::NewLine)
  Write-Output ('R173_'+$Name+'_IDENTITY_PASS')
}
function Update([string]$Name,[string]$Sha){
  # R185: On Windows, PowerShell's native-command pipeline can remain open because
  # background router/backend processes inherit redirected stdout/stderr handles.
  # Start-Process without -Wait, then WaitForExit only on the exact updater PID.
  # Do not use -Wait (that waits for the process tree and deadlocks on healthy routers).
  $stdout=Join-Path $Root ($Name+'.stdout.log')
  $stderr=Join-Path $Root ($Name+'.stderr.log')
  if((Test-Path $stdout) -or (Test-Path $stderr)){throw ('R185_NO_BLIND_RERUN_'+$Name)}
  if($Source -match '\s' -or $Install -match '\s'){throw 'R185_UNSAFE_ARGUMENT_PATH_WHITESPACE'}
  $args=@('-NoLogo','-NoProfile','-NonInteractive','-File',(Join-Path $Source 'auto-update-windows.ps1'),'-InstallDir',$Install,'-SourceRef',$Sha,'-ExpectedCommit',$Sha,'-TargetProfile','default','-WindowsJobRunnerPath',$JobRunner,'-Force')
  if($Name -eq 'ROLLBACK'){$args+= '-PinnedLegacyRunnerOverlay'}
  $updater=Start-Process -FilePath 'pwsh.exe' -ArgumentList $args -NoNewWindow -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr -ErrorAction Stop
  if($null -eq $updater -or $updater.Id -le 0){throw 'R185_UPDATER_PID_UNAVAILABLE'}
  Write-Output ('R185_'+$Name+'_UPDATER_PID='+$updater.Id)
  $ended=$updater.WaitForExit(1100000)
  if(-not $ended){
    try{if(-not $updater.HasExited){$updater.Kill()}}catch{}
    throw ('R185_'+$Name+'_UPDATER_PID_TIMEOUT_AFTER_1100_SECONDS')
  }
  $updater.Refresh()
  $exitCode=[int]$updater.ExitCode
  $f=Join-Path $Root 'STATE\ChatGPTRemoteCommander\last-update.json'
  $result=if(Test-Path $f){Get-Content $f -Raw|ConvertFrom-Json}else{$null}
  $status=if($null -ne $result){[string]$result.status}else{'MISSING'}
  $script:Stages+=@{name=$Name;exit=$exitCode;status=$status;updaterPid=$updater.Id;stdoutPath=$stdout;stderrPath=$stderr}
  Write-Output ('R185_'+$Name+'_PROCESS_EXIT='+$exitCode+'_STATUS='+$status)
  # CI-only R252: retain exact hashed qualification failure names, no raw logs.
  if(($Name -eq 'PROMOTE' -or $Name -eq 'ROLLBACK') -and ($exitCode -ne 0 -or $status -ne 'PROMOTED')){
    try{
      $lines=Get-Content -LiteralPath $stdout -ErrorAction Stop
      $diagnosticCommit=if($Name -eq 'PROMOTE'){$ExpectedCommit}else{$RollbackBaseline}
      $rx='^GATE_OUTPUT_FILES runId=(qualification-test-'+$diagnosticCommit.Substring(0,12)+'-[0-9a-f]{32}) stdout=([^\r\n]+?) stderr='
      $matches=@($lines|Where-Object {$_ -match $rx})
      if($matches.Count -ne 1){throw 'NO_UNIQUE_TEST_OUTPUT'}
      $null=$matches[0] -match $rx
      $id=$Matches[1];$given=[IO.Path]::GetFullPath($Matches[2])
      $inner=Join-Path $Root ('STATE\ChatGPTRemoteCommander\update-logs\qualification-output-'+$id+'.stdout.log')
      if($given -cne [IO.Path]::GetFullPath($inner)){throw 'WRONG_LOG_PATH'}
      $size=(Get-Item -LiteralPath $inner -ErrorAction Stop).Length
      if($size -le 0 -or $size -gt 2097152){throw 'BAD_LOG_SIZE'}
      $sha=(Get-FileHash -LiteralPath $inner -Algorithm SHA256).Hash
      if(-not($lines|Where-Object {$_ -match ('^GATE_OUTPUT_HASH runId='+[regex]::Escape($id)+' stdoutSha256='+$sha+' ')})){
        throw 'LOG_HASH_UNATTESTED'
      }
      $found=0
      $sawFailure=$false
      foreach($line in [IO.File]::ReadLines($inner)){
        if($line -match '^\s*(?:not ok \d+ -|#\s*(?:fail|pass|tests)\s+\d+|.*\b(?:AssertionError|ERR_TEST_FAILURE)\b)'){
          $sawFailure=$true
          $safe=($line -replace '[^A-Za-z0-9 ._:(),/\[\]-]','?')
          if($safe.Length -gt 160){$safe=$safe.Substring(0,160)}
          Write-Output ('R252_QUAL_TEST_RESULT_'+$found+'='+$safe)
          $found++;if($found -ge 24){break}
        }elseif($sawFailure -and $line -match '[/\\](?<area>test|tools)[/\\](?<file>[A-Za-z0-9._-]+\.(?:mjs|js|ps1)):(?<row>\d+)'){
          $relative=$Matches['area']+'/'+$Matches['file']+':'+$Matches['row']
          Write-Output ('R252_QUAL_FAILURE_SOURCE_'+$found+'='+$relative)
          $found++;if($found -ge 24){break}
        }
      }
      Write-Output ('R252_QUAL_LOG_SHA_PASS='+$sha+' markers='+$found)
    }catch{Write-Output 'R252_QUAL_DIAG_UNAVAILABLE_FAIL_CLOSED'}
  }
  if($exitCode -ne 0 -or $status -ne 'PROMOTED'){throw ('R185_'+$Name+'_NOT_ACCEPTED')}
}
function Cleanup {
  $killed=@()
  foreach($port in @($Ports)){
    $listen=@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    foreach($row in $listen){
      $id=[int]$row.OwningProcess
      if($id -le 0 -or $killed -contains $id){continue}
      $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$id) -ErrorAction SilentlyContinue
      if($null -eq $p){continue}
      $name=[IO.Path]::GetFileName([string]$p.ExecutablePath)
      $args=[string]$p.CommandLine
      if($name -ne 'node.exe' -or $args -notmatch 'src[/\\](server-v0\.3|stable-router)\.mjs' -or $p.CreationDate.ToUniversalTime() -lt $Started.AddSeconds(-5)){
        throw ('R173_UNOWNED_LISTENER_port_'+$port+'_pid_'+$id)
      }
      Stop-Process -Id $id -ErrorAction Stop
      $killed+= $id
    }
  }
  Start-Sleep -Seconds 2
  $rem=@()
  foreach($port in @($Ports)){$rem+=@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)}
  return @{pass=($rem.Count -eq 0);remaining=$rem.Count;stoppedPids=$killed;guardedPorts=@($Ports)}
}
if((Get-NetTCPConnection -State Listen -LocalPort 47831 -ErrorAction SilentlyContinue)){throw 'R173_CANONICAL_PORT_IN_USE'}
$sandboxMarker=Join-Path $Root 'R173_STANDARD_USER_SANDBOX.txt'
if(-not(Test-Path -LiteralPath $Root -PathType Container) -or -not(Test-Path -LiteralPath $sandboxMarker -PathType Leaf) -or [IO.File]::ReadAllText($sandboxMarker) -cne 'R173_STANDARD_USER_SANDBOX_V1'){throw 'R173_STANDARD_USER_SANDBOX_MARKER_REQUIRED'}
$unexpectedRootItems=@(Get-ChildItem -LiteralPath $Root -Force|Where-Object{$_.Name -notin @('TEMP','USERPROFILE','R173_STANDARD_USER_SANDBOX.txt','R157_STANDARD_USER.path','R157_STANDARD_USER.stdout.log','R157_STANDARD_USER.stderr.log')})
if($unexpectedRootItems.Count -ne 0 -or -not(Test-Path -LiteralPath (Join-Path $Root 'TEMP') -PathType Container)){throw 'R173_STANDARD_USER_ROOT_NOT_FRESH'}
if(Test-Path -LiteralPath (Join-Path $OldLocal 'ChatGPTRemoteCommander')){throw 'R173_PREEXISTING_INSTALL'}
Assert-Head $Source $ExpectedCommit
$CandidateVersion=[string]((Get-Content (Join-Path $Source 'package.json') -Raw|ConvertFrom-Json).version)
& node.exe (Join-Path $Source 'tools/isolated-qa-policy.mjs')
 if($LASTEXITCODE -ne 0){throw 'R173_CANDIDATE_VERSION_POLICY'}
New-Item -ItemType Directory -Path (Join-Path $Root 'STATE'),(Join-Path $Root 'ROAMING'),(Join-Path $Root 'TEMP') -Force -ErrorAction Stop|Out-Null
& git.exe -c core.autocrlf=false clone --depth 1 --branch v0.10.20 https://github.com/GOD13emad/ChatGPTRemoteCommander.git $Install | Out-Host
if($LASTEXITCODE -ne 0){throw 'R173_CLONE_FAIL'}
Assert-Head $Install $Baseline
$changed=@(git -C $Install status --porcelain --untracked-files=no)
if($changed.Count -gt 0){
  if($changed.Count -ne 1 -or $changed[0] -ne ' M enable-boot-recovery.ps1'){throw 'R173_UNKNOWN_OLD_DIRTY'}
  & git.exe -C $Install diff --cached --quiet --;if($LASTEXITCODE){throw 'R173_STAGED_CHANGE'}
  & git.exe -C $Install diff --ignore-space-at-eol --quiet --;if($LASTEXITCODE){throw 'R173_SEMANTIC_CHANGE'}
  Write-Output 'R173_HISTORIC_EOL_ONLY_ACCEPTED'
}
$c=Get-Content (Join-Path $Source 'config.json') -Raw|ConvertFrom-Json
$c.allowedRoots=@($Source)
$c.autoUpdate.enabled=$true
$c.powerMode.enabled=$false
$c.powerMode.guiControl.enabled=$false
$c.powerMode.browserControl.enabled=$false
$c.asyncOperations.enabled=$true
[IO.File]::WriteAllText((Join-Path $Install 'config.local.json'),(ConvertTo-Json $c -Depth 30)+[Environment]::NewLine)
$env:LOCALAPPDATA=Join-Path $Root 'STATE'
$env:APPDATA=Join-Path $Root 'ROAMING'
$env:TEMP=Join-Path $Root 'TEMP'
$env:TMP=$env:TEMP
try {
  Update 'PROMOTE' $ExpectedCommit
  Assert-Head $Install $ExpectedCommit
  Readback 'PROMOTE' $ExpectedCommit $CandidateVersion
  Update 'ROLLBACK' $RollbackBaseline
  $overlayMarkers=@(Select-String -LiteralPath (Join-Path $Root 'ROLLBACK.stdout.log') -SimpleMatch 'R173_PINNED_LEGACY_RUNNER_OVERLAY_VERIFIED exactBaseline=8ccf0fd1')
  if($overlayMarkers.Count -ne 1){throw 'R173_LEGACY_RUNNER_OVERLAY_NOT_ATTESTED'}
  Assert-Head $Install $RollbackBaseline
  Readback 'ROLLBACK' $RollbackBaseline $RollbackVersion
}catch{$Failure=$_.Exception.Message}
finally{
  $env:LOCALAPPDATA=$OldLocal
  $env:APPDATA=$OldRoaming
  $env:TEMP=$OldTemp
  $env:TMP=$OldTmp
  $clean=$null
  try{$clean=Cleanup}catch{$Failure=if($Failure){$Failure+' | '+$_.Exception.Message}else{$_.Exception.Message}}
  $pass=($null -eq $Failure -and $script:Stages.Count -eq 2 -and $null -ne $clean -and $clean.pass)
  $rec=[ordered]@{
    schema=1;revision='R173';status=if($pass){'PASS_WINDOWS_REAL_PROMOTION_ROLLBACK_ZERO_OWNED'}else{'FAIL_CLOSED_WINDOWS_RELEASE_ROLLBACK'}
    candidateHead=$ExpectedCommit;baselineHead=$Baseline;rollbackHead=$RollbackBaseline;rollbackVersion=$RollbackVersion;stages=$script:Stages;cleanup=$clean
    error=$Failure;isolatedGithubRunner=$true;ownerMachineTouched=$false
    startedUtc=$Started.ToString('o');finishedUtc=[DateTime]::UtcNow.ToString('o')
    nativeOwnerUIAndSigning='OPEN'
  }
  $dest=Join-Path $Root 'RETURN_R173.json'
  [IO.File]::WriteAllText($dest,(ConvertTo-Json $rec -Depth 12)+[Environment]::NewLine)
  Write-Output ('R173_FINAL='+$rec.status+' receiptSHA='+(Get-FileHash $dest -Algorithm SHA256).Hash)
  if(-not $pass){throw ('R173_FAIL_CLOSED '+$Failure)}
}
