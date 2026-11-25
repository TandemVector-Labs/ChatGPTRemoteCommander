$ErrorActionPreference='Stop'
$path=Join-Path (Split-Path -Parent $PSScriptRoot) 'handoff-user-session-windows.ps1'
$scriptText=Get-Content -LiteralPath $path -Raw
$tok=$null
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($scriptText,[ref]$tok,[ref]$errors)
if($errors.Count -ne 0){throw 'HANDOFF_NATIVE_SOURCE_PARSE_FAILED'}
$fn=$ast.Find({
  param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-CommanderBusy'
},$true)
if(-not $fn){throw 'HANDOFF_NATIVE_GUARD_FUNCTION_MISSING'}
. ([scriptblock]::Create($fn.Extent.Text))

$script:mode='healthy'
$script:active=0
$script:queued=0
$script:leases=0
$script:guiLeased=$false
$script:browserUncertain=$false

# Isolated RPC replacement. No localhost network request or production process action.
function Invoke-RestMethod {
  [CmdletBinding()]
  param([string]$Uri,[string]$Method,[string]$ContentType,[string]$Body,[int]$TimeoutSec)
  if($script:mode -eq 'unauthorized'){throw [UnauthorizedAccessException]::new('synthetic denied request')}
  if($Uri -ne 'http://127.0.0.1:47831/mcp'){throw 'HANDOFF_NATIVE_UNEXPECTED_ENDPOINT'}
  $request=ConvertFrom-Json $Body
  switch($request.params.name){
    'system_status' {
      $state=[pscustomobject]@{
        concurrency=[pscustomobject]@{activeOperations=$script:active;queued=$script:queued}
        durableWorkflows=[pscustomobject]@{schedulerState=[pscustomobject]@{currentLeases=$script:leases}}
      }
      if($script:mode -eq 'missing_queued'){$state.concurrency.PSObject.Properties.Remove('queued')}
      return [pscustomobject]@{result=[pscustomobject]@{isError=$false;structuredContent=$state}}
    }
    'gui_status' {
      return [pscustomobject]@{result=[pscustomobject]@{
        isError=$false
        structuredContent=[pscustomobject]@{leased=$script:guiLeased;busy=$false}
      }}
    }
    'browser_status' {
      return [pscustomobject]@{result=[pscustomobject]@{
        isError=$false
        structuredContent=[pscustomobject]@{active=$false;busy=$false;leased=$false;uncertain=$script:browserUncertain}
      }}
    }
    default {throw 'HANDOFF_NATIVE_UNKNOWN_RPC'}
  }
}

$cases=@(
  @{name='healthy_idle';mode='healthy';active=0;queued=0;leases=0;gui=$false;browser=$false;expect='0/0/0'},
  @{name='queued_work';mode='healthy';active=0;queued=2;leases=0;gui=$false;browser=$false;expect='0/2/0'},
  @{name='active_operation';mode='healthy';active=1;queued=0;leases=0;gui=$false;browser=$false;expect='1/0/0'},
  @{name='gui_lease';mode='healthy';active=0;queued=0;leases=0;gui=$true;browser=$false;expect='0/0/1'},
  @{name='browser_uncertain';mode='healthy';active=0;queued=0;leases=0;gui=$false;browser=$true;expect='0/0/1'},
  @{name='malformed_queued';mode='missing_queued';active=0;queued=0;leases=0;gui=$false;browser=$false;expect='1/1/1'},
  @{name='unauthorized_403';mode='unauthorized';active=0;queued=0;leases=0;gui=$false;browser=$false;expect='1/1/1'}
)

$results=@()
foreach($item in $cases){
  $script:mode=$item.mode
  $script:active=$item.active
  $script:queued=$item.queued
  $script:leases=$item.leases
  $script:guiLeased=$item.gui
  $script:browserUncertain=$item.browser
  $response=Get-CommanderBusy
  $actual="$($response.active)/$($response.queued)/$($response.leases)"
  $results += [pscustomobject]@{name=$item.name;actual=$actual;expected=$item.expect;pass=($actual -eq $item.expect)}
}
$failed=@($results|Where-Object{-not $_.pass})
if($failed.Count -gt 0){throw ('HANDOFF_NATIVE_CASE_FAILURE: '+($failed.name -join ','))}
Write-Output ('HANDOFF_NATIVE_FAILCLOSED_PASS cases='+$results.Count)
