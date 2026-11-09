$RoutingRoot = Join-Path $env:LOCALAPPDATA 'ChatGPTRemoteCommander\routing'
$UpdateStateRoot = Join-Path $env:LOCALAPPDATA 'ChatGPTRemoteCommander'
New-Item -ItemType Directory -Force -Path $RoutingRoot | Out-Null
$script:NextAutoUpdateCheck = Get-Date
$script:RoutedBackendHealthMisses = @{}
$script:RoutingNotices = @{}
$script:RoutedBackendHealthFailureThreshold = 3
$script:RoutedBackendStaleInflightMs = 60000

function Write-RoutingNotice([string]$Key,[string]$Message) {
  if ([string]$script:RoutingNotices[$Key] -eq $Message) { return }
  $script:RoutingNotices[$Key] = $Message
  Write-SupervisorLog $Message
}

function Clear-RoutingNotice([string]$Key) {
  [void]$script:RoutingNotices.Remove($Key)
}

function Clear-RoutedBackendMisses([string]$Profile,[int]$Port) {
  $prefix = "$Profile|$Port|"
  foreach ($key in @($script:RoutedBackendHealthMisses.Keys)) {
    if ([string]$key -like "$prefix*") { [void]$script:RoutedBackendHealthMisses.Remove($key) }
  }
}


function Get-RouteState([string]$Profile) {
  if (-not (Test-RcProfileName $Profile)) { throw "invalid route profile $Profile" }
  $file = Join-Path $RoutingRoot "$Profile.json"
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
  $state = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
  if ([int]$state.schema -ne 1 -or [string]$state.profile -ne $Profile -or [int]$state.generation -lt 1) { throw "invalid route state $Profile" }
  $active = $state.active
  if (-not $active -or [int]$active.port -lt 1024 -or [int]$active.port -gt 65535) { throw "invalid active route $Profile" }
  foreach ($key in @('version','commit','configSha256','configPath','projectDir')) {
    if ([string]::IsNullOrWhiteSpace([string]$active.$key)) { throw "route active field missing $Profile/$key" }
  }
  if ([string]$active.commit -notmatch '^[0-9a-f]{40}$' -or [string]$active.configSha256 -notmatch '^[0-9a-f]{64}$') { throw "invalid route hashes $Profile" }
  if (-not (Test-Path -LiteralPath ([string]$active.configPath) -PathType Leaf) -or -not (Test-Path -LiteralPath ([string]$active.projectDir) -PathType Container)) { throw "route path missing $Profile" }
  if($BootCore){
    $source=[IO.Path]::GetFullPath([string]$active.projectDir).TrimEnd('\')
    if($source -ine [IO.Path]::GetFullPath($Root).TrimEnd('\')){
      throw 'BOOT_RECOVERY_MACHINE_ROUTE_PROJECT_UNTRUSTED'
    }
    $base=[IO.Path]::GetFullPath((Join-Path $script:MachineRuntimeRoot 'instances')).TrimEnd('\')+'\'
    $configPath=[IO.Path]::GetFullPath([string]$active.configPath)
    if(-not $configPath.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)){
      throw 'BOOT_RECOVERY_MACHINE_ROUTE_CONFIG_UNTRUSTED'
    }
  }
  return [pscustomobject]@{ File=$file; State=$state; Active=$active }
}

function Get-RouterStatusSafe([int]$Port,[string]$Profile) {
  try {
    $status = Invoke-RestMethod "http://127.0.0.1:$Port/router/status" -TimeoutSec 2
    if(-not($status.ok -and $status.router -and [string]$status.state.profile -eq $Profile)){return $null}
    return $status
  } catch { return $null }
}

function Test-RouterReady([int]$Port,[string]$Profile,[string]$ExpectedSourceSha='') {
  $status = Get-RouterStatusSafe $Port $Profile
  if(-not $status){return $false}
  if($ExpectedSourceSha -and [string]$status.sourceSha256 -ne $ExpectedSourceSha){return $false}
  return $true
}

function Get-RouterBackendActivity($Status,[int]$BackendPort) {
  if(-not $Status -or -not $Status.PSObject.Properties['inflightByPort']) {
    return [pscustomobject]@{Known=$false;Count=-1;OldestAgeMs=-1}
  }
  $container=$Status.inflightByPort
  if(-not $container){return [pscustomobject]@{Known=$true;Count=0;OldestAgeMs=0}}
  $prop=$container.PSObject.Properties[[string]$BackendPort]
  $count=if($prop){[int]$prop.Value}else{0}
  $oldestAge=0
  if($count-gt0 -and $Status.PSObject.Properties['inflightDetailsByPort'] -and $Status.inflightDetailsByPort){
    $detailsProp=$Status.inflightDetailsByPort.PSObject.Properties[[string]$BackendPort]
    if($detailsProp){
      $now=[DateTimeOffset]::UtcNow
      foreach($detail in @($detailsProp.Value)){
        try{
          $started=[DateTimeOffset]::Parse([string]$detail.startedAt).ToUniversalTime()
          $age=[int][Math]::Max(0,($now-$started).TotalMilliseconds)
          if($age-gt$oldestAge){$oldestAge=$age}
        }catch{}
      }
    }
  }
  return [pscustomobject]@{Known=$true;Count=$count;OldestAgeMs=$oldestAge}
}

function Get-RoutedBackendRecoveryDecision([bool]$HealthOk,[int]$ConsecutiveMisses,[bool]$RouterKnown,[int]$InflightCount,[int]$OldestAgeMs=0) {
  if($HealthOk){return 'HEALTHY'}
  if(-not $RouterKnown){return 'DEFER_UNPROVEN'}
  if($InflightCount -gt 0 -and $OldestAgeMs-lt $script:RoutedBackendStaleInflightMs){return 'DEFER_BUSY'}
  if($ConsecutiveMisses -lt $script:RoutedBackendHealthFailureThreshold){return 'DEFER_TRANSIENT'}
  if($InflightCount -gt 0){return 'RECYCLE_STALE'}
  return 'RECYCLE'
}

function Stop-OwnedRouter([string]$Profile,[int]$CanonicalPort,[string]$RouteFile,[int]$ListenerPid) {
  $runtime=Join-Path $RoutingRoot "$Profile.runtime.json"
  if(-not(Test-Path -LiteralPath $runtime -PathType Leaf)){throw "router runtime marker missing $Profile"}
  $marker=Get-Content -LiteralPath $runtime -Raw|ConvertFrom-Json
  if([int]$marker.pid-ne $ListenerPid -or [int]$marker.port-ne $CanonicalPort -or [string]$marker.host-ne '127.0.0.1' -or
      [IO.Path]::GetFullPath([string]$marker.stateFile)-ne [IO.Path]::GetFullPath($RouteFile)){throw "router ownership mismatch $Profile"}
  $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$ListenerPid" -ErrorAction SilentlyContinue
  if(-not $proc -or [string]$proc.CommandLine -notmatch 'stable-router\.mjs'){throw "router process identity mismatch $Profile"}
  Stop-Process -Id $ListenerPid -Force -ErrorAction Stop
  foreach($i in 1..40){
    Start-Sleep -Milliseconds 100
    if(-not(Get-NetTCPConnection -State Listen -LocalPort $CanonicalPort -ErrorAction SilentlyContinue)){return}
  }
  throw "router recycle port did not clear $Profile"
}

function Stop-OwnedRoutedBackend($Route,[int]$ListenerPid) {
  $cfg = Get-Content -LiteralPath ([string]$Route.Active.configPath) -Raw | ConvertFrom-Json
  $markerFile = [string]$cfg.runtimeState
  if (-not $markerFile -or -not (Test-Path -LiteralPath $markerFile -PathType Leaf)) { throw "routed runtime marker missing $($Route.State.profile)" }
  $marker = Get-Content -LiteralPath $markerFile -Raw | ConvertFrom-Json
  if ([int]$marker.pid -ne $ListenerPid -or [int]$marker.port -ne [int]$Route.Active.port -or
      [string]$marker.instance.profile -ne [string]$Route.State.profile -or
      [IO.Path]::GetFullPath([string]$marker.projectDir) -ne [IO.Path]::GetFullPath([string]$Route.Active.projectDir)) {
    throw "routed backend ownership mismatch $($Route.State.profile)"
  }
  Stop-Process -Id $ListenerPid -Force -ErrorAction Stop
}

function Start-RoutedBackend($Route,[int]$CanonicalPort) {
  $profile = [string]$Route.State.profile
  $port = [int]$Route.Active.port
  $noticeKey="backend|$profile|$port"
  if (Test-McpHealth $port ([string]$Route.Active.configSha256) $profile) {
    Clear-RoutedBackendMisses $profile $port
    Clear-RoutingNotice $noticeKey
    return $true
  }
  $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $listenerPid=[int]$listener.OwningProcess
    $missKey="$profile|$port|$listenerPid"
    $misses=1+[int]($script:RoutedBackendHealthMisses[$missKey] ?? 0)
    $script:RoutedBackendHealthMisses[$missKey]=$misses
    $routerStatus=Get-RouterStatusSafe $CanonicalPort $profile
    $activity=Get-RouterBackendActivity $routerStatus $port
    $decision=Get-RoutedBackendRecoveryDecision $false $misses $activity.Known $activity.Count $activity.OldestAgeMs
    if($decision -notmatch '^RECYCLE'){
      Write-RoutingNotice $noticeKey "ROUTED_BACKEND_RECYCLE_$decision profile=$profile pid=$listenerPid port=$port misses=$misses inflight=$($activity.Count) oldestAgeMs=$($activity.OldestAgeMs)"
      return $false
    }

    Start-Sleep -Milliseconds 500
    if(Test-McpHealth $port ([string]$Route.Active.configSha256) $profile){
      Clear-RoutedBackendMisses $profile $port
      Write-RoutingNotice $noticeKey "ROUTED_BACKEND_RECOVERED profile=$profile pid=$listenerPid port=$port"
      return $true
    }
    $routerStatus=Get-RouterStatusSafe $CanonicalPort $profile
    $activity=Get-RouterBackendActivity $routerStatus $port
    $finalDecision=Get-RoutedBackendRecoveryDecision $false $misses $activity.Known $activity.Count $activity.OldestAgeMs
    if($finalDecision -notmatch '^RECYCLE'){
      Write-RoutingNotice $noticeKey "ROUTED_BACKEND_RECYCLE_$finalDecision profile=$profile pid=$listenerPid port=$port misses=$misses inflight=$($activity.Count) oldestAgeMs=$($activity.OldestAgeMs)"
      return $false
    }

    Stop-OwnedRoutedBackend $Route $listenerPid
    Clear-RoutedBackendMisses $profile $port
    Write-SupervisorLog "ROUTED_BACKEND_RECYCLE_CONFIRMED profile=$profile oldPid=$listenerPid port=$port misses=$misses inflight=$($activity.Count) oldestAgeMs=$($activity.OldestAgeMs) decision=$finalDecision"
  }
  $node = if($NodePath){[IO.Path]::GetFullPath($NodePath)}else{(Get-Command node.exe -ErrorAction Stop).Source}
  $server = Join-Path ([string]$Route.Active.projectDir) 'src\server-v0.3.mjs'
  $psi = [Diagnostics.ProcessStartInfo]::new()
  $psi.FileName=$node;$psi.WorkingDirectory=[string]$Route.Active.projectDir;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
  [void]$psi.ArgumentList.Add($server)
  $psi.Environment['REMOTE_COMMANDER_CONFIG']=[string]$Route.Active.configPath
  $p=[Diagnostics.Process]::Start($psi)
  foreach($i in 1..40){
    Start-Sleep -Milliseconds 500
    if(Test-McpHealth $port ([string]$Route.Active.configSha256) $profile){
      Clear-RoutedBackendMisses $profile $port
      Clear-RoutingNotice $noticeKey
      Write-SupervisorLog "ROUTED_BACKEND_READY profile=$profile pid=$($p.Id) port=$port"
      return $true
    }
    if($p.HasExited){break}
  }
  if(-not $p.HasExited){Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue}
  throw "routed backend readiness failed $profile"
}

function Start-RouterForRoute($Route,[int]$CanonicalPort) {
  $profile=[string]$Route.State.profile
  $noticeKey="router-source|$profile|$CanonicalPort"
  $router=Join-Path $Root 'src\stable-router.mjs'
  if(-not(Test-Path -LiteralPath $router -PathType Leaf)){$router=Join-Path ([string]$Route.Active.projectDir) 'src\stable-router.mjs'}
  $expectedSha=(Get-FileHash -LiteralPath $router -Algorithm SHA256).Hash.ToLowerInvariant()
  $status=Get-RouterStatusSafe $CanonicalPort $profile
  if($status -and [string]$status.sourceSha256 -eq $expectedSha){
    Clear-RoutingNotice $noticeKey
    return $true
  }
  $listener=Get-NetTCPConnection -State Listen -LocalPort $CanonicalPort -ErrorAction SilentlyContinue|Select-Object -First 1
  if($listener){
    if($status){
      $currentSha=[string]$status.sourceSha256
      $inflight=0
      if($status.PSObject.Properties['inflightByPort'] -and $status.inflightByPort){
        foreach($prop in $status.inflightByPort.PSObject.Properties){$inflight += [int]$prop.Value}
      }
      Write-RoutingNotice $noticeKey "ROUTER_SOURCE_ACTIVATION_DEFERRED profile=$profile pid=$($listener.OwningProcess) port=$CanonicalPort currentSha=$currentSha expectedSha=$expectedSha inflight=$inflight"
      return $true
    }
    Write-RoutingNotice $noticeKey "ROUTER_RECOVERY_DEFER_UNPROVEN profile=$profile pid=$($listener.OwningProcess) port=$CanonicalPort expectedSha=$expectedSha"
    return $false
  }
  $runtime=Join-Path $RoutingRoot "$profile.runtime.json"
  $node=if($NodePath){[IO.Path]::GetFullPath($NodePath)}else{(Get-Command node.exe -ErrorAction Stop).Source}
  $psi=[Diagnostics.ProcessStartInfo]::new()
  $psi.FileName=$node;$psi.WorkingDirectory=$UpdateStateRoot;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
  foreach($x in @($router,'--listen-port',[string]$CanonicalPort,'--state-file',$Route.File,'--runtime-file',$runtime)){[void]$psi.ArgumentList.Add($x)}
  $p=[Diagnostics.Process]::Start($psi)
  foreach($i in 1..40){
    Start-Sleep -Milliseconds 250
    if(Test-RouterReady $CanonicalPort $profile $expectedSha){
      Clear-RoutingNotice $noticeKey
      Write-SupervisorLog "ROUTER_READY profile=$profile pid=$($p.Id) port=$CanonicalPort sourceSha=$expectedSha"
      return $true
    }
    if($p.HasExited){break}
  }
  if(-not $p.HasExited){Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue}
  throw "router readiness failed $profile"
}

function Ensure-RoutedProfile([string]$Profile,[int]$CanonicalPort) {
  $route=Get-RouteState $Profile
  if(-not $route){return $false}
  $backendReady=Start-RoutedBackend $route $CanonicalPort
  if(-not $backendReady){return $true}
  $routerReady=Start-RouterForRoute $route $CanonicalPort
  if(-not $routerReady){return $true}
  if(-not(Test-McpHealth $CanonicalPort ([string]$route.Active.configSha256) $Profile)){throw "canonical routed MCP unhealthy $Profile"}
  return $true
}

function Get-ActivePrimaryConfig {
  if($BootCore){return (Join-Path $script:MachineRuntimeRoot 'primary\config.json')}
  $route=Get-RouteState 'default'
  if($route){return [string]$route.Active.configPath}
  $local=Join-Path $Root 'config.local.json'
  if(Test-Path -LiteralPath $local){return $local}
  return (Join-Path $Root 'config.json')
}

function Start-AutoUpdateIfDue {
  if($BootCore){return} # never self-update under SYSTEM
  if((Get-Date)-lt $script:NextAutoUpdateCheck){return}
  $config=Get-Content -LiteralPath (Get-ActivePrimaryConfig) -Raw|ConvertFrom-Json
  $minutes=[int]($config.autoUpdate.intervalMinutes ?? 15)
  if($minutes-lt 1){$minutes=15}
  $script:NextAutoUpdateCheck=(Get-Date).AddMinutes($minutes)
  if($config.autoUpdate.enabled-ne $true){return}
  $scriptPath=Join-Path $Root 'auto-update-windows.ps1'
  if(-not(Test-Path -LiteralPath $scriptPath -PathType Leaf)){Write-SupervisorLog 'AUTO_UPDATE_SCRIPT_MISSING';return}
  $pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source
  $args=@('-NoLogo','-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$scriptPath,'-InstallDir',$Root)
  $sourceRef=[string]($config.autoUpdate.sourceRef ?? '')
  if($sourceRef){$args+=@('-SourceRef',$sourceRef)}
  Start-Process -FilePath $pwsh -ArgumentList $args -WindowStyle Hidden | Out-Null
  Write-SupervisorLog "AUTO_UPDATE_CHECK_STARTED sourceRef=$sourceRef next=$($script:NextAutoUpdateCheck.ToString('o'))"
}
