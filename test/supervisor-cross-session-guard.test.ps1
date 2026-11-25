$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$source=Get-Content -LiteralPath (Join-Path $root 'autostart-windows.ps1') -Raw
$pattern='(?ms)^          \$process = Get-TunnelProcess \$item\.Profile \$exe\r?\n.*?^          if \(-not \$process -or -not \$ready\) \{ Start-TunnelProfile \$item \}'
$m=[regex]::Matches($source,$pattern)
if($m.Count -ne 1){throw "GUARD_SNIPPET_NOT_UNIQUE count=$($m.Count)"}
$snippet=$m[0].Value
if($snippet -notmatch '\bcontinue\b' -or $snippet -notmatch 'TUNNEL_OWNER_UNVERIFIED' -or $snippet -match 'Stop-Process|Remove-Item|Start-ScheduledTask'){
  throw 'GUARD_SNIPPET_UNSAFE_OR_INCOMPLETE'
}
# In this isolated test function only, 'return' models the loop's original 'continue'.
$isolated=$snippet.Replace('            continue','            return')
if($isolated -eq $snippet){throw 'CONTINUE_REWRITE_NOT_APPLIED'}
$script:branch=[ScriptBlock]::Create($isolated)
$script:fakeProcess=$null
$script:fakeReady=$false
$script:starts=0
$script:checks=0
$script:observes=0
$script:logs=[Collections.Generic.List[string]]::new()
$ownerUnknownLogged=@{}
$exe='C:\QA\not-a-real-tunnel.exe'
$item=[pscustomobject]@{Profile='saeed-emad';HealthPort=47833}
function Get-TunnelProcess {param($Profile,$Exe);return $script:fakeProcess}
function Test-TunnelReady {param($Port);$script:checks++;return [bool]$script:fakeReady}
function Observe-TunnelControlPlane {param($Profile,$Port);$script:observes++}
function Start-TunnelProfile {param($ProfileItem);$script:starts++}
function Write-SupervisorLog {param($Message);[void]$script:logs.Add([string]$Message)}
function Assert-Case([string]$Name,[object]$Process,[bool]$Ready,[int]$WantStarts,[int]$WantLogCount,[bool]$WantCached) {
  $script:fakeProcess=$Process
  $script:fakeReady=$Ready
  $beforeCheck=$script:checks
  $beforeObserve=$script:observes
  & $script:branch
  if($script:starts -ne $WantStarts -or $script:logs.Count -ne $WantLogCount -or
      $ownerUnknownLogged.ContainsKey('saeed-emad') -ne $WantCached -or
      $script:checks -ne ($beforeCheck+1) -or $script:observes -ne ($beforeObserve+1)){
    throw "CASE_FAIL name=$Name starts=$($script:starts) logs=$($script:logs.Count) cache=$($ownerUnknownLogged.ContainsKey('saeed-emad')) checks=$($script:checks-$beforeCheck)"
  }
}
Assert-Case 'foreign-ready-1' $null $true 0 1 $true
Assert-Case 'foreign-ready-2-no-spam' $null $true 0 1 $true
Assert-Case 'owned-ready-reset' ([pscustomobject]@{ProcessId=123}) $true 0 1 $false
Assert-Case 'foreign-ready-again' $null $true 0 2 $true
Assert-Case 'missing-notready-launch' $null $false 1 2 $false
Assert-Case 'owned-notready-recovery' ([pscustomobject]@{ProcessId=124}) $false 2 2 $false
Assert-Case 'owned-ready' ([pscustomobject]@{ProcessId=125}) $true 2 2 $false
if($script:logs[0] -notmatch 'TUNNEL_OWNER_UNVERIFIED'){throw 'WARN_MISSING'}
'REGRESSION_PASS cases=7 no_native_input=true no_process_stop=true'