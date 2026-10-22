param(
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$ExpectedCommit,
  [ValidateSet('READ_ONLY_HOSTED_NOPROMOTE_QUALIFICATION_FAILURE',
    'READ_ONLY_HOSTED_V025W_ROLLBACK_QUALIFICATION_FAILURE')]
  [string]$Scope='READ_ONLY_HOSTED_NOPROMOTE_QUALIFICATION_FAILURE',
  [ValidateSet('test','check')][string]$Gate='test'
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
$sourceSha=$null
$sourceBytes=0
$status='LOG_MISSING'
$count=0
if(Test-Path -LiteralPath $logRoot -PathType Container){
  $rootAttributes=(Get-Item -LiteralPath $logRoot -Force).Attributes
  if(($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'R470_LOG_ROOT_REPARSE_REFUSED'}
  $prefix=$ExpectedCommit.Substring(0,12)
  $sources=@(Get-ChildItem -LiteralPath $logRoot -File -Filter "qualification-output-qualification-$Gate-$prefix-*.stdout.log" -ErrorAction Stop)
  $count=$sources.Count
  if($count -eq 1){
    $source=$sources[0]
    if(($source.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'R470_LOG_REPARSE_REFUSED'}
    $sourceBytes=$source.Length
    if($sourceBytes -gt 8388608){$status='LOG_TOO_LARGE'}
    else {
      $sourceSha=(Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      $status='NON_TAP_FAILURE_UNCLASSIFIED'
      foreach($line in [IO.File]::ReadLines($source.FullName)){
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
  schema=1;revision='R470';status=$status;commit=$ExpectedCommit;gate=$Gate
  scope=$Scope
  matchingLogCount=$count;sourceBytes=$sourceBytes;sourceSha256=$sourceSha
  failureTests=$failures;failureTypes=$types;tapCounts=$totals
  specFailureTests=$specNames;specCounts=$specTotals
  phaseMarkersObserved=$phaseStarted.Count;phasePassMarkersObserved=$phasePassed.Count
  failurePhaseIndex=$failedPhaseIndex
  rawLogIncluded=$false;secretsIncluded=$false;absolutePathsIncluded=$false
  stablePromoted=$false;historicalFailureJob=$(if($Scope -eq 'READ_ONLY_HOSTED_NOPROMOTE_QUALIFICATION_FAILURE'){115292112191}else{$null})
}
[IO.File]::WriteAllText($out,($report|ConvertTo-Json -Depth 9),[Text.UTF8Encoding]::new($false))
Write-Output ('R470_DIAG_RESULT='+$status+' failureTests='+$failures.Count+' sourceBytes='+$sourceBytes)
Write-Output ('R470_DIAG_SHA256='+(Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash)
