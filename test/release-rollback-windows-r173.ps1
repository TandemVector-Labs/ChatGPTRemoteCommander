#requires -Version 7.0
param([Parameter(Mandatory=$true)][string]$ExpectedCommit)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(-not $IsWindows -or $env:CI -ne 'true' -or -not $env:RUNNER_TEMP -or -not $env:GITHUB_WORKSPACE){throw 'R173_WINDOWS_CI_ONLY'}
if($ExpectedCommit -notmatch '^[0-9a-f]{40}$'){throw 'R173_EXACT_COMMIT_REQUIRED'}
$Source=[IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
$Root=Join-Path ([IO.Path]::GetFullPath($env:RUNNER_TEMP)) 'remote-commander-rollback-r173'
$Install=Join-Path $Root 'INSTALL'
$Baseline='362375c464948be3001b307650c13fc3353ed05b'
$OldLocal=[string]$env:LOCALAPPDATA
$OldRoaming=[string]$env:APPDATA
$Started=[DateTime]::UtcNow
$Ports=[System.Collections.Generic.HashSet[int]]::new()
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
  $args=@('-NoLogo','-NoProfile','-NonInteractive','-File',(Join-Path $Source 'auto-update-windows.ps1'),'-InstallDir',$Install,'-SourceRef',$Sha,'-ExpectedCommit',$Sha,'-TargetProfile','default','-Force')
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
      $diagnosticCommit=if($Name -eq 'PROMOTE'){$ExpectedCommit}else{$Baseline}
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
if((Test-Path -LiteralPath $Root) -or (Test-Path -LiteralPath (Join-Path $OldLocal 'ChatGPTRemoteCommander'))){throw 'R173_NOT_ISOLATED'}
Assert-Head $Source $ExpectedCommit
if((Get-Content (Join-Path $Source 'package.json') -Raw|ConvertFrom-Json).version -ne '0.10.24'){throw 'R173_CANDIDATE_VERSION'}
New-Item -ItemType Directory -Path (Join-Path $Root 'STATE'),(Join-Path $Root 'ROAMING') -ErrorAction Stop|Out-Null
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
try {
  Update 'PROMOTE' $ExpectedCommit
  Assert-Head $Install $ExpectedCommit
  Readback 'PROMOTE' $ExpectedCommit '0.10.24'
  Update 'ROLLBACK' $Baseline
  Assert-Head $Install $Baseline
  Readback 'ROLLBACK' $Baseline '0.10.20'
}catch{$Failure=$_.Exception.Message}
finally{
  $env:LOCALAPPDATA=$OldLocal
  $env:APPDATA=$OldRoaming
  $clean=$null
  try{$clean=Cleanup}catch{$Failure=if($Failure){$Failure+' | '+$_.Exception.Message}else{$_.Exception.Message}}
  $pass=($null -eq $Failure -and $script:Stages.Count -eq 2 -and $null -ne $clean -and $clean.pass)
  $rec=[ordered]@{
    schema=1;revision='R173';status=if($pass){'PASS_WINDOWS_REAL_PROMOTION_ROLLBACK_ZERO_OWNED'}else{'FAIL_CLOSED_WINDOWS_RELEASE_ROLLBACK'}
    candidateHead=$ExpectedCommit;baselineHead=$Baseline;stages=$script:Stages;cleanup=$clean
    error=$Failure;isolatedGithubRunner=$true;ownerMachineTouched=$false
    startedUtc=$Started.ToString('o');finishedUtc=[DateTime]::UtcNow.ToString('o')
    nativeOwnerUIAndSigning='OPEN'
  }
  $dest=Join-Path $Root 'RETURN_R173.json'
  [IO.File]::WriteAllText($dest,(ConvertTo-Json $rec -Depth 12)+[Environment]::NewLine)
  Write-Output ('R173_FINAL='+$rec.status+' receiptSHA='+(Get-FileHash $dest -Algorithm SHA256).Hash)
  if(-not $pass){throw ('R173_FAIL_CLOSED '+$Failure)}
}
