param(
  [Parameter(Mandatory=$true)][string]$SourcePath
)
$ErrorActionPreference='Stop'
$source=[IO.Path]::GetFullPath($SourcePath)
if(-not(Test-Path -LiteralPath $source -PathType Leaf)){throw 'HANDOFF_FIXTURE_SOURCE_MISSING'}
$text=[IO.File]::ReadAllText($source)
$tokens=$null; $parseErrors=$null
[void][System.Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'HANDOFF_FIXTURE_SOURCE_PARSE_FAILED'}
$selector=[regex]::Match($text,'(?ms)^\$ownerCommanderRoot=.*?(?=^foreach\(\$p in \$nodes\))')
if(-not$selector.Success -or $selector.Value -notmatch 'headlessSupervisorPids'){throw 'HANDOFF_FIXTURE_SELECTOR_NOT_FOUND'}
$busyFunction=[regex]::Match($text,'(?ms)^function Get-CommanderBusy \{.*?^\}')
if(-not$busyFunction.Success -or $busyFunction.Value -notmatch 'HANDOFF_BUSY_STATE_UNVERIFIED'){throw 'HANDOFF_FIXTURE_BUSY_FUNCTION_NOT_FOUND'}

$priorProgramData=$env:ProgramData
try {
  $env:ProgramData='C:\ProgramData'
  $OwnerLocal='C:\Users\Case\AppData\Local'
  $ownerRoot=Join-Path $OwnerLocal 'ChatGPTRemoteCommander'
  $fixtures=@(
    [pscustomobject]@{ProcessId=111;ParentProcessId=55;CommandLine="node.exe $ownerRoot\releases\v0.11.0-dev.23\src\server-v0.3.mjs"},
    [pscustomobject]@{ProcessId=222;ParentProcessId=55;CommandLine="node.exe $ownerRoot\releases\v0.11.0-dev.23\src\stable-router.mjs"},
    [pscustomobject]@{ProcessId=333;ParentProcessId=900;CommandLine="node.exe $ownerRoot\releases\v0.11.0-dev.23\src\server-v0.3.mjs"},
    [pscustomobject]@{ProcessId=444;ParentProcessId=55;CommandLine="node.exe --require C:\ProgramData\ChatGPTRemoteCommander\server-headless-v1\auth-preload.cjs $ownerRoot\releases\v0.11.0-dev.23\src\server-v0.3.mjs"},
    [pscustomobject]@{ProcessId=555;ParentProcessId=55;CommandLine="node.exe C:\Users\Other\AppData\Local\ChatGPTRemoteCommander\releases\src\server-v0.3.mjs"},
    [pscustomobject]@{ProcessId=666;ParentProcessId=55;CommandLine="node.exe $ownerRoot-other\src\server-v0.3.mjs"},
    [pscustomobject]@{ProcessId=777;ParentProcessId=55;CommandLine="node.exe $ownerRoot\src\unrelated-tool.mjs"},
    [pscustomobject]@{ProcessId=888;ParentProcessId=55;CommandLine="node.exe C:\ProgramData\ChatGPTRemoteCommander\server-headless-v1\src\server-v0.3.mjs"}
  )
  $supervisors=@(
    [pscustomobject]@{ProcessId=900;CommandLine='pwsh -File "C:\ProgramData\ChatGPTRemoteCommander\server-headless-v1\run-headless.ps1"'},
    [pscustomobject]@{ProcessId=901;CommandLine='pwsh -File "C:\Users\Case\AppData\Local\ChatGPTRemoteCommander\app\autostart-windows.ps1"'}
  )
  function Get-CimInstance {
    [CmdletBinding()]
    param([Parameter(Position=0)][string]$ClassName,[string]$Filter)
    if($ClassName -cne 'Win32_Process'){throw 'HANDOFF_FIXTURE_UNEXPECTED_CLASS'}
    if($Filter -ceq "Name='pwsh.exe'"){return $supervisors}
    if($Filter -ceq "Name='node.exe'"){return $fixtures}
    throw 'HANDOFF_FIXTURE_UNEXPECTED_PROCESS_FILTER'
  }
  . ([scriptblock]::Create($selector.Value))
  $selected=@($nodes|ForEach-Object {[int]$_.ProcessId}|Sort-Object)
  if(($selected -join ',') -cne '111,222'){
    throw ('HANDOFF_FIXTURE_WRONG_SELECTION '+($selected -join ','))
  }
  . ([scriptblock]::Create($busyFunction.Value))
  $script:FixtureMode='unavailable'
  function Invoke-RestMethod {
    [CmdletBinding()]
    param([string]$Uri,[string]$Method,[string]$ContentType,[string]$Body,[int]$TimeoutSec)
    if($script:FixtureMode -eq 'unavailable'){throw 'HANDOFF_FIXTURE_OFFLINE'}
    $call=($Body|ConvertFrom-Json).params.name
    switch($call){
      'system_status' {
        $queued=if($script:FixtureMode -eq 'incomplete'){$null}else{0}
        return [pscustomobject]@{result=[pscustomobject]@{isError=$false;structuredContent=[pscustomobject]@{
          concurrency=[pscustomobject]@{activeOperations=0;queued=$queued};
          durableWorkflows=[pscustomobject]@{schedulerState=[pscustomobject]@{currentLeases=0}}
        }}}
      }
      'gui_status' {return [pscustomobject]@{result=[pscustomobject]@{isError=$false;structuredContent=[pscustomobject]@{leased=$false;busy=$false}}}}
      'browser_status' {return [pscustomobject]@{result=[pscustomobject]@{isError=$false;structuredContent=[pscustomobject]@{active=$false;busy=$false;leased=$false;uncertain=$false}}}}
      default {throw 'HANDOFF_FIXTURE_UNEXPECTED_TOOL'}
    }
  }
  $offline=Get-CommanderBusy
  if($offline.active -ne 1 -or $offline.queued -ne 1 -or $offline.leases -ne 1){throw 'HANDOFF_FIXTURE_OFFLINE_MUST_DEFER'}
  $script:FixtureMode='incomplete'
  $partial=Get-CommanderBusy
  if($partial.active -ne 1 -or $partial.queued -ne 1 -or $partial.leases -ne 1){throw 'HANDOFF_FIXTURE_MISSING_STATUS_MUST_DEFER'}
  $script:FixtureMode='idle'
  $idle=Get-CommanderBusy
  if($idle.active -ne 0 -or $idle.queued -ne 0 -or $idle.leases -ne 0){throw 'HANDOFF_FIXTURE_VALID_IDLE_REJECTED'}
  Write-Output 'HANDOFF_HEADLESS_PROTECTION_PASS selected=2 protected=6 offlineDeferred=true malformedDeferred=true idleAccepted=true realProcessesChanged=false'
} finally {
  $env:ProgramData=$priorProgramData
}
