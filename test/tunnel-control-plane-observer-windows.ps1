$ErrorActionPreference='Stop'
$source=Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\autostart-windows.ps1') -Raw
$start=$source.IndexOf('$script:TunnelControlPlaneNextCheck = @{}')
$end=$source.IndexOf('function Get-TunnelProcess',$start)
if($start -lt 0 -or $end -le $start){throw 'OBSERVER_SOURCE_NOT_FOUND'}

$script:MockStatus='degraded'
$script:MockHttp=403
$script:LogLines=[System.Collections.Generic.List[string]]::new()
function Write-SupervisorLog([string]$Message) { $script:LogLines.Add($Message) }
function Invoke-RestMethod {
  [CmdletBinding()]
  param([string]$Uri,[int]$TimeoutSec)
  if($Uri -ne 'http://127.0.0.1:47832/health/control-plane'){throw 'UNEXPECTED_ENDPOINT'}
  if($script:MockStatus -eq 'unsupported'){throw 'HTTP_404'}
  return [pscustomobject]@{
    status=$script:MockStatus
    details=[pscustomobject]@{failure_category='http_error';http_status=$script:MockHttp}
  }
}
Invoke-Expression $source.Substring($start,$end-$start)
Observe-TunnelControlPlane 'primary' 47832
if($script:LogLines.Count -ne 1 -or $script:LogLines[0] -notmatch 'http=403'){throw 'FIRST_403_NOT_LOGGED'}
$script:TunnelControlPlaneNextCheck['primary']=[DateTimeOffset]::MinValue
Observe-TunnelControlPlane 'primary' 47832
if($script:LogLines.Count -ne 1){throw 'DUPLICATE_403_EVENT'}
$script:MockStatus='ok'
$script:TunnelControlPlaneNextCheck['primary']=[DateTimeOffset]::MinValue
Observe-TunnelControlPlane 'primary' 47832
if($script:LogLines.Count -ne 2 -or $script:LogLines[1] -notmatch 'RECOVERED'){throw 'RECOVERY_NOT_LOGGED'}
$script:MockStatus='unsupported'
$script:TunnelControlPlaneNextCheck['primary']=[DateTimeOffset]::MinValue
Observe-TunnelControlPlane 'primary' 47832
if($script:LogLines.Count -ne 2){throw 'UNSUPPORTED_ENDPOINT_LOGGED_FALSE_OUTAGE'}
$script:MockStatus='degraded'
$script:TunnelControlPlaneNextCheck['primary']=[DateTimeOffset]::MinValue
Observe-TunnelControlPlane 'primary' 47832
if($script:LogLines.Count -ne 3 -or $script:LogLines[2] -notmatch 'DEGRADED'){throw 'RECURRENT_OUTAGE_NOT_LOGGED'}
Write-Output 'TUNNEL_POLL_OBSERVER_PASS'
