param(
  [string]$OwnerUserProfile = $env:USERPROFILE,
  [ValidateRange(30,900)][int]$WaitSeconds = 300
)
$ErrorActionPreference='Stop'
# A SYSTEM boot task must name the intended user explicitly; inheriting
# SYSTEM's environment profile could otherwise target a service account.
function Assert-HandoffOwnerContext([bool]$SystemContext,[bool]$ExplicitOwner,
                                    [string]$OwnerProfile,[string]$CurrentProfile) {
  if([string]::IsNullOrWhiteSpace($OwnerProfile)){throw 'HANDOFF_OWNER_PROFILE_MISSING'}
  if($SystemContext -and -not $ExplicitOwner){throw 'HANDOFF_OWNER_EXPLICIT_REQUIRED_FOR_SYSTEM'}
  if($SystemContext -and -not [string]::IsNullOrWhiteSpace($CurrentProfile)){
    $target=[IO.Path]::GetFullPath($OwnerProfile).TrimEnd('\')
    $systemProfile=[IO.Path]::GetFullPath($CurrentProfile).TrimEnd('\')
    if($target -ieq $systemProfile){throw 'HANDOFF_SYSTEM_PROFILE_CANNOT_OWN_USER_SESSION'}
  }
}
Assert-HandoffOwnerContext ([Security.Principal.WindowsIdentity]::GetCurrent().IsSystem) ($PSBoundParameters.ContainsKey('OwnerUserProfile')) $OwnerUserProfile $env:USERPROFILE
$Root=Split-Path -Parent $MyInvocation.MyCommand.Path
$OwnerUserProfile=[IO.Path]::GetFullPath($OwnerUserProfile)
$OwnerLocal=Join-Path $OwnerUserProfile 'AppData\Local'
$OwnerRoaming=Join-Path $OwnerUserProfile 'AppData\Roaming'
$VarDir=Join-Path $Root 'var'
$ProfileDir=Join-Path $OwnerRoaming 'tunnel-client'
$log=Join-Path $VarDir 'boot-handoff.log'
New-Item -ItemType Directory -Force -Path $VarDir | Out-Null

function Write-HandoffLog([string]$Message){
  Add-Content -LiteralPath $log -Value ("$(Get-Date -Format o) $Message") -Encoding utf8
}
function Test-SystemOwner($Process){
  try {
    $owner=Invoke-CimMethod -InputObject $Process -MethodName GetOwner -ErrorAction Stop
    return ([string]$owner.User -ieq 'SYSTEM')
  } catch { return $false }
}
function Get-CommanderBusy {
  try {
    $body=@{jsonrpc='2.0';id=1;method='tools/call';params=@{name='system_status';arguments=@{}}}|ConvertTo-Json -Depth 8 -Compress
    $r=Invoke-RestMethod -Uri 'http://127.0.0.1:47831/mcp' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 3
    $s=$r.result.structuredContent
    if($r.result.isError -or -not$s -or -not$s.concurrency -or
       ($null -eq $s.concurrency.activeOperations) -or ($null -eq $s.concurrency.queued) -or -not$s.durableWorkflows -or
       -not$s.durableWorkflows.schedulerState -or
       $null -eq $s.durableWorkflows.schedulerState.currentLeases){
      throw 'HANDOFF_BUSY_STATE_UNVERIFIED'
    }
    $active=[int]$s.concurrency.activeOperations
    $queued=[int]$s.concurrency.queued
    $leases=[int]$s.durableWorkflows.schedulerState.currentLeases
    if($active -lt 0 -or $queued -lt 0 -or $leases -lt 0){throw 'HANDOFF_BUSY_STATE_INVALID'}
    foreach($tool in @('gui_status','browser_status')){
      $probeBody=@{jsonrpc='2.0';id=2;method='tools/call';params=@{name=$tool;arguments=@{}}}|ConvertTo-Json -Depth 8 -Compress
      $probe=Invoke-RestMethod -Uri 'http://127.0.0.1:47831/mcp' -Method Post -ContentType 'application/json' -Body $probeBody -TimeoutSec 3
      $flags=$probe.result.structuredContent
      if($probe.result.isError -or -not$flags){throw 'HANDOFF_RESOURCE_STATE_UNVERIFIED'}
      if($tool -eq 'gui_status'){
        if($null -eq$flags.leased -or $null -eq$flags.busy){throw 'HANDOFF_GUI_STATE_UNVERIFIED'}
        if($flags.leased -or $flags.busy){$leases++}
      } else {
        if($null -eq$flags.active -or $null -eq$flags.busy -or
           $null -eq$flags.leased -or $null -eq$flags.uncertain){
          throw 'HANDOFF_BROWSER_STATE_UNVERIFIED'
        }
        if($flags.active -or $flags.busy -or $flags.leased -or $flags.uncertain){$leases++}
      }
    }
    return [pscustomobject]@{active=$active;queued=$queued;leases=$leases}
  } catch {
    # Losing status cannot authorize terminating a running SYSTEM core.
    return [pscustomobject]@{active=1;queued=1;leases=1}
  }
}

function Stop-ExactProcess($Process,[string]$Label){
  if(-not(Test-SystemOwner $Process)){return}
  try {
    Stop-Process -Id ([int]$Process.ProcessId) -Force -ErrorAction Stop
    Write-HandoffLog "STOPPED $Label pid=$($Process.ProcessId)"
  } catch {
    Write-HandoffLog "STOP_FAILED $Label pid=$($Process.ProcessId) type=$($_.Exception.GetType().Name)"
  }
}

$deadline=(Get-Date).AddSeconds($WaitSeconds)
do {
  $busy=Get-CommanderBusy
  if($busy.active -eq 0 -and $busy.queued -eq 0 -and $busy.leases -eq 0){break}
  Write-HandoffLog "WAIT_BUSY active=$($busy.active) queued=$($busy.queued) leases=$($busy.leases)"
  Start-Sleep -Seconds 5
} while((Get-Date)-lt$deadline)
if($busy.active -ne 0 -or $busy.queued -ne 0 -or $busy.leases -ne 0){
  Write-HandoffLog "HANDOFF_DEFERRED_BUSY active=$($busy.active) queued=$($busy.queued) leases=$($busy.leases)"
  exit 75
}

$ownerEsc=[regex]::Escape($OwnerUserProfile)
$supervisors=@(Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and $_.CommandLine -match 'autostart-windows\.ps1' -and
  $_.CommandLine -match '(?:^|\s)-BootCore(?:\s|$)' -and
  $_.CommandLine -match $ownerEsc
})
foreach($p in $supervisors){Stop-ExactProcess $p 'boot-supervisor'}
Start-Sleep -Milliseconds 500

$stableAppRoot=Join-Path (Join-Path $OwnerUserProfile 'AppData\Local') 'ChatGPTRemoteCommander\app'
$pin=Join-Path $stableAppRoot 'var\tunnel-client.json'
$expectedTunnel=$null
if(Test-Path -LiteralPath $pin -PathType Leaf){
  try{$expectedTunnel=[IO.Path]::GetFullPath([string](Get-Content -LiteralPath $pin -Raw|ConvertFrom-Json).path)}catch{}
}
if($expectedTunnel){
  $tunnels=@(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and [IO.Path]::GetFullPath([string]$_.ExecutablePath) -eq $expectedTunnel -and
    $_.CommandLine -match '--profile(?:=|\s+)'
  })
  foreach($p in $tunnels){Stop-ExactProcess $p 'system-tunnel'}
}

$ownerCommanderRoot=[IO.Path]::GetFullPath((Join-Path $OwnerLocal 'ChatGPTRemoteCommander'))
$ownerCommanderPrefix=[regex]::Escape($ownerCommanderRoot+'\')
$headlessPreload=[IO.Path]::GetFullPath((Join-Path $env:ProgramData 'ChatGPTRemoteCommander\server-headless-v1\auth-preload.cjs'))
$headlessRunScript=[IO.Path]::GetFullPath((Join-Path $env:ProgramData 'ChatGPTRemoteCommander\server-headless-v1\run-headless.ps1'))
$headlessSupervisorPids=@(Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and $_.CommandLine -match [regex]::Escape($headlessRunScript)
} | ForEach-Object { [int]$_.ProcessId })
# Protect the independent ProgramData browser-only service even if its Node
# entrypoint belongs to an older Commander release tree under the user profile.
$nodes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and $_.CommandLine -match $ownerCommanderPrefix -and
  $_.CommandLine -match '(?:server-v0\.3\.mjs|stable-router\.mjs)' -and
  $_.CommandLine -notmatch [regex]::Escape($headlessPreload) -and
  $_.ParentProcessId -notin $headlessSupervisorPids
})
foreach($p in $nodes){Stop-ExactProcess $p 'system-mcp'}

Start-Sleep -Seconds 1

function Test-Ready([int]$Port){
  if($Port-le0){return $false}
  try{
    $r=Invoke-WebRequest -Uri "http://127.0.0.1:$Port/readyz" -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode-eq200 -and $r.Content.Trim()-eq'ready')
  }catch{return $false}
}
function ManagedTunnelProfiles {
  $profiles=@()
  if(Test-Path -LiteralPath $ProfileDir -PathType Container){
    foreach($f in Get-ChildItem -LiteralPath $ProfileDir -Filter '*.yaml' -File -ErrorAction SilentlyContinue){
      # Never infer success from one valid file while silently skipping an
      # invalid profile. A missing or duplicate endpoint is not a handoff.
      if([string]$f.BaseName -cnotmatch '^[A-Za-z0-9._-]+$'){return @()}
      $config=Get-Content -LiteralPath $f.FullName -Raw
      # Count every declared listen_addr first, not only valid loopback
      # matches. Otherwise an extra nonlocal or malformed key is ignored.
      $declarations=[regex]::Matches($config,'(?m)^[ \t]*listen_addr:[ \t]*([^\r\n]*)')
      if($declarations.Count -ne 1){return @()}
      $value=[string]$declarations[0].Groups[1].Value
      $match=[regex]::Match($value,'^[ \t]*(["'']?)127\.0\.0\.1:(\d+)\1[ \t]*(?:#.*)?$')
      if(-not $match.Success){return @()}
      $port=[int]$match.Groups[2].Value
      if($port -le 0 -or $port -gt 65535){return @()}
      $profiles += [pscustomobject]@{Name=[string]$f.BaseName;Port=$port}
    }
  }
  $uniquePorts=@($profiles|Select-Object -ExpandProperty Port -Unique)
  if($uniquePorts.Count -ne $profiles.Count){return @()}
  return @($profiles)
}

# The recovery check must prove that the *intended user* owns the listening
# processes. HTTP 200 alone may still be served by an orphaned SYSTEM BootCore.
function Get-OwnerProfileSid {
  try {
    $expected=[IO.Path]::GetFullPath($OwnerUserProfile).TrimEnd('\')
    $profileList='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
    $matches=@(
      foreach($entry in Get-ChildItem -LiteralPath $profileList -ErrorAction Stop){
        $item=Get-ItemProperty -LiteralPath $entry.PSPath -Name ProfileImagePath -ErrorAction SilentlyContinue
        if(-not $item -or -not $item.ProfileImagePath){continue}
        $actual=[IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$item.ProfileImagePath)).TrimEnd('\')
        if($actual -ieq $expected){[string]$entry.PSChildName}
      }
    )
    if($matches.Count -eq 1){return [string]$matches[0]}
  } catch {}
  return $null
}

function Test-OwnerListener([int]$Port,[string]$OwnerSid,[string]$ProcessName,[string]$CommandPattern) {
  if($Port -le 0 -or -not $OwnerSid){return $false}
  try {
    # Some Windows builds report State=$null for a listening endpoint.
    # Accept that case only with the kernel's explicit wildcard remote
    # sentinel (0.0.0.0:0), never an Established/TimeWait data socket.
    $connections=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -ErrorAction Stop)
    $listeners=@($connections|Where-Object {
      [string]$_.LocalAddress -eq '127.0.0.1' -and
      (($_.State -eq 'Listen') -or
       ($null -eq $_.State -and [string]$_.RemoteAddress -eq '0.0.0.0' -and
        $null -ne $_.RemotePort -and [int]$_.RemotePort -eq 0))
    })
    if($listeners.Count -ne 1){return $false}
    $pidValue=[int]$listeners[0].OwningProcess
    if($pidValue -le 0){return $false}
    $process=Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction Stop
    if(-not $process -or $process.Name -ine $ProcessName -or
       -not $process.CommandLine -or $process.CommandLine -notmatch $CommandPattern){return $false}
    $owner=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
    return ($owner.ReturnValue -eq 0 -and [string]$owner.Sid -eq $OwnerSid)
  } catch {return $false}
}

$recoverDeadline=(Get-Date).AddSeconds(75)
$ok=$false
do{
  # Resolve from the approved Windows profile registry; a same-name account
  # in a different domain or SYSTEM must never satisfy this handoff.
  $ownerSid=Get-OwnerProfileSid
  $mcp=$false
  try{$h=Invoke-RestMethod 'http://127.0.0.1:47831/health' -TimeoutSec 2;$mcp=[bool]($h.ok -and $h.name-eq'chatgpt-remote-commander')}catch{}
  if($mcp){
    $mcp=Test-OwnerListener 47831 $ownerSid 'node.exe' '(?:stable-router\.mjs|server-v0\.3\.mjs)'
  }
  $profiles=@(ManagedTunnelProfiles)
  $tunnelOk=($profiles.Count-gt0 -and -not [string]::IsNullOrEmpty($ownerSid))
  foreach($entry in $profiles){
    $port=[int]$entry.Port
    $profilePattern='(?:^|\s)--profile(?:=|\s+)"?'+[regex]::Escape([string]$entry.Name)+'"?(?:\s|$)'
    if(-not(Test-Ready $port) -or
       -not(Test-OwnerListener $port $ownerSid 'tunnel-client.exe' $profilePattern)){
      $tunnelOk=$false
      break
    }
  }
  if($mcp -and $tunnelOk){$ok=$true;break}
  Start-Sleep -Seconds 2
}while((Get-Date)-lt$recoverDeadline)

if($ok){
  Write-HandoffLog 'USER_SESSION_HANDOFF_PASS'
  exit 0
}
Write-HandoffLog 'USER_SESSION_HANDOFF_RECOVERY_PENDING'
exit 76
