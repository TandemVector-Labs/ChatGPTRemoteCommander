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
      $status='OUTPUT_FORMAT_UNRECOGNIZED'
      foreach($line in [IO.File]::ReadLines($source.FullName)){
        # Both Node spec and TAP output occur in qualification logs; only
        # retain bounded public test labels and summary counters.
        if($line -match '^\s*[\u2716\u2717\u00d7]\s+(.+?)\s*$'){
          $label=[regex]::Replace([string]$Matches[1],'\s+\([0-9]+(?:\.[0-9]+)?ms\)\s*$','')
          if($label -match '(?i)bearer|password|secret|cookie|token|private.?key|authorization|api.?key' -or $label -match '(?i)(?:[a-z]:[\\/]|\\\\[^\\/\s]+[\\/]|(?<![a-z0-9:/])/[^\s]+|(?:^|[\s=])~[\\/])'){$label='REDACTED_TEST_NAME'}
          $label=[regex]::Replace($label,'[^A-Za-z0-9 _().:/+\-]','?')
          if($label.Length -gt 112){$label=$label.Substring(0,112)}
          if($label -match '^(?i:failing tests?):?\s*$'){continue}
          $alreadySeen=@($failures|Where-Object { $null -eq $_.index -and $_.publicTestName -ceq $label }).Count -gt 0
          if(-not $alreadySeen -and $failures.Count -lt 24){$failures+=([pscustomobject]@{index=$null;publicTestName=$label})}
          $status='SPEC_SUMMARY_EXTRACTED'
          continue
        }
        if($line -match '^\s*[\u2139]\s+(tests|pass|fail|cancelled|skipped|todo|duration_ms)\s+([0-9]+(?:\.[0-9]+)?)\s*$'){
          $totals[[string]$Matches[1]]=[string]$Matches[2]
          $status='SPEC_SUMMARY_EXTRACTED'
          continue
        }
        if($line -match '^\s*(?:not ok\s+\d+\s+-|#\s*(?:tests|pass|fail|cancelled|skipped|todo|duration_ms)\s+\d+)'){
          if($status -ne 'SPEC_SUMMARY_EXTRACTED'){$status='TAP_SUMMARY_EXTRACTED'}
        }
        if($line -match '^\s*not ok\s+([0-9]+)\s+-\s+([^\r\n]+)$'){
          $number=[int]$Matches[1]
          $label=[string]$Matches[2]
          if($label -match '(?i)bearer|password|secret|cookie|token|private.?key|authorization|api.?key' -or $label -match '(?i)(?:[a-z]:[\\/]|\\\\[^\\/\s]+[\\/]|(?<![a-z0-9:/])/[^\s]+|(?:^|[\s=])~[\\/])'){ $label='REDACTED_TEST_NAME' }
          $label=[regex]::Replace($label,'[^A-Za-z0-9 _().:/+\-]','?')
          if($label.Length -gt 112){$label=$label.Substring(0,112)}
          if($failures.Count -lt 24){$failures+=([pscustomobject]@{index=$number;publicTestName=$label})}
        } elseif($line -match '^\s*#\s*(tests|pass|fail|cancelled|skipped|todo|duration_ms)\s+([0-9]+(?:\.[0-9]+)?)\s*$') {
          $totals[[string]$Matches[1]]=[string]$Matches[2]
        } elseif($line -match 'failureType:.*?(testTimeoutFailure|assertionFailure|uncaughtException|testCodeFailure|hookFailed|subtestsFailed)'){
          if($types.Count -lt 20){$types+=([string]$Matches[1])}
        }
      }
    }
  } elseif($count -gt 1) {$status='AMBIGUOUS_MULTIPLE_MATCHING_LOGS'}
}
$report=[ordered]@{
  schema=1;revision='R470';status=$status;commit=$ExpectedCommit
  scope='READ_ONLY_HOSTED_NOPROMOTE_QUALIFICATION_FAILURE'
  matchingLogCount=$count;sourceBytes=$sourceBytes;sourceSha256=$sourceSha
  failureTests=$failures;failureTypes=$types;tapCounts=$totals
  rawLogIncluded=$false;secretsIncluded=$false;absolutePathsIncluded=$false
  stablePromoted=$false;historicalFailureJob=115292112191
}
[IO.File]::WriteAllText($out,($report|ConvertTo-Json -Depth 9),[Text.UTF8Encoding]::new($false))
Write-Output ('R470_DIAG_RESULT='+$status+' failureTests='+$failures.Count+' sourceBytes='+$sourceBytes)
Write-Output ('R470_DIAG_SHA256='+(Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash)
