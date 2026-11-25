param(
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$ExpectedCommit
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($ExpectedCommit -cnotmatch '^[a-f0-9]{40}$'){throw 'R470_EXPECTED_COMMIT_INVALID'}
$canonical=[IO.Path]::GetFullPath($Root)
if(!(Test-Path -LiteralPath $canonical -PathType Container)){throw 'R470_ROOT_MISSING'}
$out=Join-Path $canonical 'DIAGNOSTIC_R470.json'
if(Test-Path -LiteralPath $out){throw 'UNSAFE_RERUN_DIAGNOSTIC_ALREADY_EXISTS'}
$logRoot=Join-Path $canonical 'STATE\ChatGPTRemoteCommander\update-logs'
$failures=@()
$totals=@{}
$types=@()
$specNames=@()
$specTotals=@{}
$phaseStarted=@()
$phasePassed=@()
$failedPhaseIndex=$null
$nativeTokenProbe=$null
$httpQuarantine=$null
$asyncHttpFailurePhase=$null
$asyncHttpFailureName=$null
$asyncHttpFailureCode=$null
$asyncHttpServerStartup=$null
$mcpTasksFailurePhase=$null
$mcpTasksFailureName=$null
$mcpTasksFailureCode=$null
$mcpTasksFailureAssertion=$null
$mcpTasksLongPollStatus=$null
$mcpTasksLongPollElapsedMs=$null
$sourceSha=$null
$sourceBytes=0
$status='LOG_MISSING'
$count=0
$failedGate=$null
if(Test-Path -LiteralPath $logRoot -PathType Container){
  $rootAttributes=(Get-Item -LiteralPath $logRoot -Force).Attributes
  if(($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'R470_LOG_ROOT_REPARSE_REFUSED'}
  $prefix=$ExpectedCommit.Substring(0,12)
  # A failed updater can stop at 'check' without producing any test log.
  # Prefer a unique exact-head test log, else a unique exact-head check log.
  # Multiple logs in the chosen gate are ambiguous and must never be guessed.
  $testSources=@(Get-ChildItem -LiteralPath $logRoot -File -Filter "qualification-output-qualification-test-$prefix-*.stdout.log" -ErrorAction Stop)
  $checkSources=@(Get-ChildItem -LiteralPath $logRoot -File -Filter "qualification-output-qualification-check-$prefix-*.stdout.log" -ErrorAction Stop)
  $failedGate=if($testSources.Count -gt 0){'test'}elseif($checkSources.Count -gt 0){'check'}else{$null}
  $sources=if($failedGate -eq 'test'){$testSources}else{$checkSources}
  $count=@($sources).Count
  if($count -eq 1){
    $source=$sources[0]
    if(($source.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'R470_LOG_REPARSE_REFUSED'}
    $sourceBytes=$source.Length
    if($sourceBytes -gt 8388608){$status='LOG_TOO_LARGE'}
    else {
      $sourceSha=(Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      $status='NON_TAP_FAILURE_UNCLASSIFIED'
      foreach($line in [IO.File]::ReadLines($source.FullName)){
        if($line -match '^R157_ASYNC_HTTP_FAILURE_PHASE=([a-z0-9-]{1,64})$'){
          $asyncHttpFailurePhase=[string]$Matches[1]
        } elseif($line -match '^R157_ASYNC_HTTP_FAILURE_NAME=([A-Za-z0-9_]{1,48})$'){
          $asyncHttpFailureName=[string]$Matches[1]
        } elseif($line -match '^R157_ASYNC_HTTP_FAILURE_CODE=([A-Z0-9_]{1,64})$'){
          $asyncHttpFailureCode=[string]$Matches[1]
        } elseif($line -match '^R157_ASYNC_HTTP_SERVER_STARTUP=(\{.*\})$'){
          try{
            $raw=ConvertFrom-Json -InputObject $Matches[1] -ErrorAction Stop
            $known=@('ERR_MODULE_NOT_FOUND','ERR_INVALID_ARG_TYPE','ERR_UNKNOWN_FILE_EXTENSION','EACCES','EPERM','ENOENT','EADDRINUSE','SyntaxError','ReferenceError','TypeError','Error','UNCLASSIFIED')
            $kind=if([string]$raw.stderrClass -cin $known){[string]$raw.stderrClass}else{'UNCLASSIFIED'}
            $exit=if($null -ne $raw.exitCode -and [int]$raw.exitCode -ge 0 -and [int]$raw.exitCode -le 255){[int]$raw.exitCode}else{$null}
            $stderrBytes=if([int64]$raw.stderrBytes -ge 0 -and [int64]$raw.stderrBytes -le 8192){[int64]$raw.stderrBytes}else{$null}
            $stdoutBytes=if([int64]$raw.stdoutBytes -ge 0 -and [int64]$raw.stdoutBytes -le 100000000){[int64]$raw.stdoutBytes}else{$null}
            $asyncHttpServerStartup=[ordered]@{exitCode=$exit;stderrClass=$kind;stderrBytes=$stderrBytes;stdoutBytes=$stdoutBytes}
          }catch{$asyncHttpServerStartup=$null}
        } elseif($line -match '^R157_MCP_TASKS_LONG_POLL_STATUS=(QUEUED|RUNNING|SUCCEEDED|FAILED|TIMED_OUT|CANCELLED|UNCERTAIN|UNVERIFIED)$'){
          $mcpTasksLongPollStatus=[string]$Matches[1]
        } elseif($line -match '^R157_MCP_TASKS_LONG_POLL_ELAPSED_MS=([0-9]{1,5})$'){
          $mcpTasksLongPollElapsedMs=[int]$Matches[1]
        } elseif($line -match '^R157_MCP_TASKS_FAILURE_PHASE=([a-z0-9-]{1,64})$'){
          $mcpTasksFailurePhase=[string]$Matches[1]
        } elseif($line -match '^R157_MCP_TASKS_FAILURE_NAME=([A-Za-z0-9_]{1,48})$'){
          $mcpTasksFailureName=[string]$Matches[1]
        } elseif($line -match '^R157_MCP_TASKS_FAILURE_CODE=([A-Z0-9_]{1,64})$'){
          $mcpTasksFailureCode=[string]$Matches[1]
        } elseif($line -match '^R157_MCP_TASKS_FAILURE_ASSERTION=(\{.*\})$'){
          try{
            $raw=ConvertFrom-Json -InputObject $Matches[1] -ErrorAction Stop
            $operator=if([string]$raw.operator -match '^[A-Za-z]{1,24}$'){[string]$raw.operator}else{$null}
            $actual=$raw.actual;$expected=$raw.expected
            foreach($key in @('actual','expected')){
              $value=if($key -eq 'actual'){$actual}else{$expected}
              if($value -is [string]){
                if($value -notmatch '^[A-Za-z0-9_ .:-]{1,64}$'){$value=$null}
              }elseif($value -isnot [bool] -and $value -isnot [byte] -and $value -isnot [int16] -and $value -isnot [int32] -and $value -isnot [int64] -and $value -isnot [double]){
                $value=$null
              }
              if($key -eq 'actual'){$actual=$value}else{$expected=$value}
            }
            $mcpTasksFailureAssertion=[ordered]@{operator=$operator;actual=$actual;expected=$expected}
          }catch{$mcpTasksFailureAssertion=$null}
        } elseif($line -match '^R157_ASYNC_HTTP_TOKEN_PROBE=(\{.*\})$'){
          try{
            $token=ConvertFrom-Json -InputObject $Matches[1] -ErrorAction Stop
            $nativeTokenProbe=[ordered]@{
              ok=[bool]$token.ok
              isAdmin=[bool]$token.isAdmin
              isSystem=[bool]$token.isSystem
              elevation=if($token.elevation -in @('standard','high','system')){[string]$token.elevation}else{$null}
              source=if($token.source -eq 'local-process-token'){[string]$token.source}else{$null}
              code=if($token.code -match '^WINDOWS_TOKEN_PROBE_[A-Z_]+$'){[string]$token.code}else{$null}
            }
          }catch{$nativeTokenProbe=$null}
        } elseif($line -match '^R157_ASYNC_HTTP_QUARANTINE=(true|false)$'){
          $httpQuarantine=([string]$Matches[1] -eq 'true')
        }
        if($line -match '^RC_QUAL_PHASE_START_([0-9]{2})\s*$'){
          if($phaseStarted.Count -lt 90){$phaseStarted+=([int]$Matches[1])}
        } elseif($line -match '^RC_QUAL_PHASE_PASS_([0-9]{2})\s*$'){
          if($phasePassed.Count -lt 90){$phasePassed+=([int]$Matches[1])}
        } elseif($line -match '^\s*not ok\s+([0-9]+)\s+-\s+([^\r\n]+)$'){
          $number=[int]$Matches[1]
          $label=[string]$Matches[2]
          if($label -match '(?i)bearer|password|secret|cookie|token|private.?key|authorization|api.?key'){ $label='REDACTED_TEST_NAME' }
          $label=[regex]::Replace($label,'[^A-Za-z0-9 _().:/+\-]','?')
          if($label.Length -gt 112){$label=$label.Substring(0,112)}
          if($failures.Count -lt 24){$failures+=([pscustomobject]@{index=$number;publicTestName=$label})}
        } elseif($line -match '^\s*#\s*(tests|pass|fail|cancelled|skipped|todo|duration_ms)\s+([0-9]+(?:\.[0-9]+)?)\s*$'){
          $totals[[string]$Matches[1]]=[string]$Matches[2]
        } elseif($line -match '^\s*✖\s+(.+?)\s*$'){
          # Node 24 uses the spec reporter by default, not TAP.
          $label=[regex]::Replace(([string]$Matches[1]).Trim(),'\s+\([0-9]+(?:\.[0-9]+)?ms\)$','')
          if($label -ne 'failing tests:' -and $label.Length -gt 0){
            if($label -match '(?i)bearer|password|secret|cookie|token|private.?key|authorization|api.?key|[A-Za-z]:[\\/]|\\\\|/home/'){
              $label='REDACTED_TEST_NAME'
            }
            $label=[regex]::Replace($label,'[^A-Za-z0-9 _()./+\\-]','?')
            if($label.Length -gt 112){$label=$label.Substring(0,112)}
            if($specNames.Count -lt 24 -and $specNames -notcontains $label){$specNames+=($label)}
          }
        } elseif($line -match '^\s*ℹ\s+(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+([0-9]+(?:\.[0-9]+)?)\s*$'){
          $specTotals[[string]$Matches[1]]=[string]$Matches[2]
        } elseif($line -match 'failureType:.*?(testTimeoutFailure|assertionFailure|uncaughtException|testCodeFailure|hookFailed|subtestsFailed)'){
          if($types.Count -lt 20){$types+=([string]$Matches[1])}
        }
      }
      if($failures.Count -gt 0 -or $types.Count -gt 0 -or
          ($totals.ContainsKey('fail') -and [double]$totals['fail'] -gt 0)){
        $status='TAP_SUMMARY_EXTRACTED'
      } elseif($specNames.Count -gt 0 -or ($specTotals.ContainsKey('fail') -and [double]$specTotals['fail'] -gt 0)){
        $status='SPEC_SUMMARY_EXTRACTED'
      } elseif($phaseStarted.Count -gt 0){
        $lastStarted=[int]$phaseStarted[-1]
        if($phasePassed.Count -eq ($phaseStarted.Count-1) -and
           ($phasePassed -notcontains $lastStarted)){
          $failedPhaseIndex=$lastStarted
          $status='NON_TAP_FAILURE_PHASE_IDENTIFIED'
        } elseif($phasePassed.Count -eq $phaseStarted.Count){
          $status='FAILURE_OUTSIDE_MARKED_PHASES'
        } else {
          $status='PHASE_MARKERS_AMBIGUOUS'
        }
      }
    }
  } elseif($count -gt 1) {$status='AMBIGUOUS_MULTIPLE_MATCHING_LOGS'}
}
$report=[ordered]@{
  schema=1;revision='R470';status=$status;commit=$ExpectedCommit;failedGate=$failedGate
  scope='READ_ONLY_HOSTED_NOPROMOTE_QUALIFICATION_FAILURE'
  matchingLogCount=$count;sourceBytes=$sourceBytes;sourceSha256=$sourceSha
  failureTests=$failures;failureTypes=$types;tapCounts=$totals
  nativeTokenProbe=$nativeTokenProbe;httpPrivilegedLegacyHttpQuarantined=$httpQuarantine
  asyncHttpFailurePhase=$asyncHttpFailurePhase;asyncHttpFailureName=$asyncHttpFailureName;asyncHttpFailureCode=$asyncHttpFailureCode
  asyncHttpServerStartup=$asyncHttpServerStartup
  mcpTasksFailurePhase=$mcpTasksFailurePhase;mcpTasksFailureName=$mcpTasksFailureName;mcpTasksFailureCode=$mcpTasksFailureCode
  mcpTasksFailureAssertion=$mcpTasksFailureAssertion
  mcpTasksLongPollStatus=$mcpTasksLongPollStatus;mcpTasksLongPollElapsedMs=$mcpTasksLongPollElapsedMs
  specFailureTests=$specNames;specCounts=$specTotals
  phaseMarkersObserved=$phaseStarted.Count;phasePassMarkersObserved=$phasePassed.Count
  failurePhaseIndex=$failedPhaseIndex
  rawLogIncluded=$false;secretsIncluded=$false;absolutePathsIncluded=$false
  stablePromoted=$false;historicalFailureJob=115292112191
}
[IO.File]::WriteAllText($out,($report|ConvertTo-Json -Depth 9),[Text.UTF8Encoding]::new($false))
Write-Output ('R470_DIAG_RESULT='+$status+' failureTests='+$failures.Count+' sourceBytes='+$sourceBytes)
Write-Output ('R470_DIAG_SHA256='+(Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash)
# The hosted updater hides raw qualification output to avoid leaking keys.
# Report only the already redacted bounded test names and numerical counts,
# so a fresh CI failure has a decision-grade, non-secret root-cause signal.
if($failedGate -eq 'test'){
  Write-Output ('R470_SAFE_TEST_SUMMARY_KIND='+$status)
  if($specTotals.ContainsKey('fail')){
    Write-Output ('R470_SAFE_SPEC_FAIL_COUNT='+$specTotals['fail'])
  }
  if($totals.ContainsKey('fail')){
    Write-Output ('R470_SAFE_TAP_FAIL_COUNT='+$totals['fail'])
  }
  $limit=0
  foreach($name in $specNames){
    if($limit -ge 12){break}
    Write-Output ('R470_SAFE_SPEC_FAILURE_'+$limit+'='+$name)
    $limit++
  }
  $limit=0
  foreach($failed in $failures){
    if($limit -ge 12){break}
    Write-Output ('R470_SAFE_TAP_FAILURE_'+$limit+'='+$failed.publicTestName)
    $limit++
  }
  if($null -ne $failedPhaseIndex){
    Write-Output ('R470_SAFE_FAILURE_PHASE='+$failedPhaseIndex)
  }
}
