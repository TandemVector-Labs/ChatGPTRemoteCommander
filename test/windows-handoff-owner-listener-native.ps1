$ErrorActionPreference='Stop'
$sourcePath=Join-Path (Split-Path -Parent $PSScriptRoot) 'handoff-user-session-windows.ps1'
$sourceText=Get-Content -LiteralPath $sourcePath -Raw
$tokens=$null
$parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseInput($sourceText,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count -ne 0){throw 'HANDOFF_OWNER_NATIVE_SOURCE_PARSE_FAILED'}
foreach($name in @('Get-OwnerProfileSid','Test-OwnerListener')){
  $fn=$ast.Find({
    param($n)
    $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $n.Name -eq $name
  },$true)
  if(-not $fn){throw "HANDOFF_OWNER_NATIVE_MISSING_$name"}
  . ([scriptblock]::Create($fn.Extent.Text))
}
$OwnerUserProfile='C:\Users\V107-TestUser'
$script:testSid='S-1-5-21-101-202-303-1001'
$script:profileMode='valid'
$script:listenerMode='valid'
$script:processMode='router'
$script:ownerMode='valid'

# Fixture-only replacements: no real registry, process or socket is mutated.
function Get-ChildItem {
  [CmdletBinding()]param([string]$LiteralPath)
  if($LiteralPath -notmatch 'ProfileList'){throw 'UNEXPECTED_REGISTRY_PATH'}
  $items=@([pscustomobject]@{PSPath='REGISTRY::V107Profile';PSChildName=$script:testSid})
  if($script:profileMode -eq 'duplicate'){$items+=([pscustomobject]@{PSPath='REGISTRY::Duplicate';PSChildName='S-1-5-21-101-202-303-1002'})}
  return $items
}
function Get-ItemProperty {
  [CmdletBinding()]param([string]$LiteralPath,[string]$Name)
  if($Name -ne 'ProfileImagePath'){throw 'UNEXPECTED_PROPERTY'}
  if($script:profileMode -eq 'wrong'){return [pscustomobject]@{ProfileImagePath='C:\Users\Other'}}
  return [pscustomobject]@{ProfileImagePath=$OwnerUserProfile}
}
function Get-NetTCPConnection {
  [CmdletBinding()]param([string]$LocalAddress,[int]$LocalPort)
  if($LocalAddress -ne '127.0.0.1'){throw 'LOOPBACK_SCOPE_FAILED'}
  if($script:listenerMode -eq 'missing'){throw 'SYNTHETIC_NO_LISTENER'}
  $state='Listen'
  $remote='0.0.0.0'
  $remotePort=0
  if($script:listenerMode -eq 'nullState'){$state=$null}
  if($script:listenerMode -eq 'nullForeign'){$state=$null;$remote='127.0.0.1';$remotePort=1200}
  if($script:listenerMode -eq 'nullWrongPort'){$state=$null;$remotePort=1200}
  if($script:listenerMode -eq 'established'){$state='Established';$remote='127.0.0.1';$remotePort=1200}
  if($script:listenerMode -eq 'timeWait'){$state='TimeWait';$remote='127.0.0.1';$remotePort=1200}
  if($script:listenerMode -eq 'closedSentinel'){$state='Closed'}
  $processPid=if($script:listenerMode -eq 'invalidPid'){0}else{4321}
  $entry=[pscustomobject]@{LocalAddress='127.0.0.1';OwningProcess=$processPid;State=$state;RemoteAddress=$remote;RemotePort=$remotePort}
  if($script:listenerMode -eq 'duplicate'){return @($entry,$entry)}
  return $entry
}
function Get-CimInstance {
  [CmdletBinding()]param([string]$ClassName,[string]$Filter)
  if($ClassName -ne 'Win32_Process' -or $Filter -ne 'ProcessId=4321'){throw 'UNEXPECTED_CIM_TARGET'}
  if($script:processMode -eq 'other'){return [pscustomobject]@{Name='pwsh.exe';CommandLine='-File maintenance.ps1'}}
  if($script:processMode -eq 'wrongCommand'){return [pscustomobject]@{Name='node.exe';CommandLine='node.exe unrelated.mjs'}}
  if($script:processMode -eq 'tunnel'){return [pscustomobject]@{Name='tunnel-client.exe';CommandLine='tunnel-client.exe --profile default'}}
  return [pscustomobject]@{Name='node.exe';CommandLine='node.exe C:\Users\V107-TestUser\AppData\Local\ChatGPTRemoteCommander\src\stable-router.mjs'}
}
function Invoke-CimMethod {
  [CmdletBinding()]param($InputObject,[string]$MethodName)
  if($MethodName -ne 'GetOwnerSid'){throw 'UNEXPECTED_CIM_METHOD'}
  if($script:ownerMode -eq 'failed'){throw 'SYNTHETIC_OWNER_LOOKUP_FAILURE'}
  if($script:ownerMode -eq 'system'){return [pscustomobject]@{ReturnValue=0;Sid='S-1-5-18'}}
  if($script:ownerMode -eq 'badReturn'){return [pscustomobject]@{ReturnValue=5;Sid=$script:testSid}}
  return [pscustomobject]@{ReturnValue=0;Sid=$script:testSid}
}

$cases=@()
function Add-Result([string]$Name,[bool]$Actual,[bool]$Expected){
  $script:cases += [pscustomobject]@{name=$Name;actual=$Actual;expected=$Expected;pass=($Actual -eq $Expected)}
}
$sid=Get-OwnerProfileSid
Add-Result 'unique_owner_profile' ([bool]($sid -eq $script:testSid)) $true
Add-Result 'owner_router' (Test-OwnerListener 47831 $sid 'node.exe' 'stable-router\.mjs') $true
$script:processMode='tunnel'
Add-Result 'owner_tunnel' (Test-OwnerListener 47832 $sid 'tunnel-client.exe' '--profile(?:=|\s+)') $true
$script:processMode='router'
Add-Result 'missing_owner_sid' (Test-OwnerListener 47831 $null 'node.exe' 'stable-router\.mjs') $false
Add-Result 'wrong_owner_sid' (Test-OwnerListener 47831 'S-1-5-21-1-2-3-9999' 'node.exe' 'stable-router\.mjs') $false
$script:ownerMode='system'
Add-Result 'system_owner_denied' (Test-OwnerListener 47831 $sid 'node.exe' 'stable-router\.mjs') $false
$script:ownerMode='failed'
Add-Result 'owner_lookup_failed' (Test-OwnerListener 47831 $sid 'node.exe' 'stable-router\.mjs') $false
$script:ownerMode='badReturn'
Add-Result 'owner_error_code' (Test-OwnerListener 47831 $sid 'node.exe' 'stable-router\.mjs') $false
$script:ownerMode='valid'
$script:processMode='other'
Add-Result 'unexpected_process' (Test-OwnerListener 47831 $sid 'node.exe' 'stable-router\.mjs') $false
$script:processMode='wrongCommand'
Add-Result 'wrong_command' (Test-OwnerListener 47831 $sid 'node.exe' 'stable-router\.mjs') $false
$script:processMode='router'
$script:listenerMode='missing'
Add-Result 'missing_listener' (Test-OwnerListener 47831 $sid 'node.exe' 'stable-router\.mjs') $false
$script:listenerMode='duplicate'
Add-Result 'ambiguous_listener' (Test-OwnerListener 47831 $sid 'node.exe' 'stable-router\.mjs') $false
$script:listenerMode='invalidPid'
Add-Result 'invalid_pid' (Test-OwnerListener 47831 $sid 'node.exe' 'stable-router\.mjs') $false
$script:listenerMode='nullState'
Add-Result 'null_state_wildcard_listener_accepted' (Test-OwnerListener 47831 $sid 'node.exe' 'stable-router\.mjs') $true
$script:listenerMode='nullForeign'
Add-Result 'null_state_foreign_remote_denied' (Test-OwnerListener 47831 $sid 'node.exe' 'stable-router\.mjs') $false
$script:listenerMode='nullWrongPort'
Add-Result 'null_state_remote_port_denied' (Test-OwnerListener 47831 $sid 'node.exe' 'stable-router\.mjs') $false
$script:listenerMode='established'
Add-Result 'established_not_listener' (Test-OwnerListener 47831 $sid 'node.exe' 'stable-router\.mjs') $false
$script:listenerMode='timeWait'
Add-Result 'timewait_not_listener' (Test-OwnerListener 47831 $sid 'node.exe' 'stable-router\.mjs') $false
$script:listenerMode='closedSentinel'
Add-Result 'closed_wildcard_not_listener' (Test-OwnerListener 47831 $sid 'node.exe' 'stable-router\.mjs') $false
$script:listenerMode='valid'
$script:profileMode='wrong'
Add-Result 'wrong_profile_path' ([bool](Get-OwnerProfileSid)) $false
$script:profileMode='duplicate'
Add-Result 'ambiguous_profile_path' ([bool](Get-OwnerProfileSid)) $false
$bad=@($cases|Where-Object {-not $_.pass})
if($bad.Count -gt 0){throw ('HANDOFF_OWNER_NATIVE_FAILED: '+($bad.name -join ','))}
Write-Output ('HANDOFF_OWNER_NATIVE_PASS cases='+$cases.Count)
