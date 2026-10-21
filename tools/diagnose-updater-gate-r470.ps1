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
$signals=@()
$sourceSha=$null
$sourceBytes=0
$status='LOG_MISSING'
$count=0
if(Test-Path -LiteralPath $logRoot -PathType Container){
  $rootAttributes=(Get-Item -LiteralPath $logRoot -Force).Attributes
  if(($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'R470_LOG_ROOT_REPARSE_REFUSED'}
  $prefix=$ExpectedCommit.Substring(0,12)
  $sources=@(Get-ChildItem -LiteralPath $logRoot -File -Filter "qualification-output-qualification-test-$prefix-*.stdout.log" -ErrorAction Stop)
  $count=$sources.Count
  if($count -eq 1){
    $source=$sources[0]
    if(($source.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'R470_LOG_REPARSE_REFUSED'}
    $sourceBytes=$source.Length
    if($sourceBytes -gt 8388608){$status='LOG_TOO_LARGE'}
    else {
      $sourceSha=(Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      $status='TAP_SUMMARY_EXTRACTED'
      foreach($line in [IO.File]::ReadLines($source.FullName)){
        # Classify failures without including raw logs, paths, or credentials.
        $clean=[regex]::Replace([string]$line,'\x1b\[[0-9;]*m','')
        $clean=[regex]::Replace($clean,'^\s*#\s*(?=not ok\s+|tests\s+|pass\s+|fail\s+|cancelled\s+|skipped\s+|todo\s+|duration_ms\s+)','')
        if($clean -match '^\s*not ok\s+([0-9]+)\s+-\s+([^\r\n]+)$'){
          $number=[int]$Matches[1]
          $label=[string]$Matches[2]
          if($label -match '(?i)bearer|password|secret|cookie|token|private.?key|authorization|api.?key'){ $label='REDACTED_TEST_NAME' }
          $label=[regex]::Replace($label,'[^A-Za-z0-9 _().:/+\-]','?')
          if($label.Length -gt 112){$label=$label.Substring(0,112)}
          if($failures.Count -lt 24){$failures+=([pscustomobject]@{index=$number;publicTestName=$label})}
        } elseif($clean -match '^\s*(tests|pass|fail|cancelled|skipped|todo|duration_ms)\s+([0-9]+(?:\.[0-9]+)?)\s*$') {
          $totals[[string]$Matches[1]]=[string]$Matches[2]
        } elseif($clean -match 'failureType:.*?(testTimeoutFailure|assertionFailure|uncaughtException|testCodeFailure|hookFailed|subtestsFailed)'){
          if($types.Count -lt 20){$types+=([string]$Matches[1])}
        }
        # Only fixed, allowlisted error classes can enter the public artifact.
        $signal=$null
        if($clean -match 'SECURITY_AUDIT_FAIL'){$signal='SECURITY_AUDIT_FAIL'}
        elseif($clean -match 'server did not become healthy'){$signal='SERVER_READINESS_TIMEOUT'}
        elseif($clean -match 'Timed out waiting for bounded integration result'){$signal='BOUNDED_INTEGRATION_TIMEOUT'}
        elseif($clean -match 'testCodeFailure|ERR_ASSERTION'){$signal='TEST_ASSERTION_FAILURE'}
        elseif($clean -match 'node:internal/.*?test_runner|testTimeoutFailure'){$signal='NODE_TEST_RUNNER_ERROR'}
        elseif($clean -match 'CI_TEST_SIGNAL_|CI_TEST_CONCURRENCY_INVALID'){$signal='QUALIFICATION_RUNNER_ERROR'}
        if($signal -and $signals.Count -lt 48){$signals+=$signal}
      }
    }
  } elseif($count -gt 1) {$status='AMBIGUOUS_MULTIPLE_MATCHING_LOGS'}
}
$report=[ordered]@{
  schema=1;revision='R470';status=$status;commit=$ExpectedCommit
  scope='READ_ONLY_HOSTED_NOPROMOTE_QUALIFICATION_FAILURE'
  matchingLogCount=$count;sourceBytes=$sourceBytes;sourceSha256=$sourceSha
  failureTests=$failures;failureTypes=@($types|Select-Object -Unique);tapCounts=$totals
  classifiedSignals=@($signals|Select-Object -Unique)
  rawLogIncluded=$false;secretsIncluded=$false;absolutePathsIncluded=$false
  stablePromoted=$false;historicalFailureJob=115292112191
}
[IO.File]::WriteAllText($out,($report|ConvertTo-Json -Depth 9),[Text.UTF8Encoding]::new($false))
Write-Output ('R470_DIAG_RESULT='+$status+' failureTests='+$failures.Count+' sourceBytes='+$sourceBytes)
Write-Output ('R470_DIAG_SHA256='+(Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash)
