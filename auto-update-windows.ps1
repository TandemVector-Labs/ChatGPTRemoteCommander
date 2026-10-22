param(
  [string]$InstallDir = '',
  [string]$SourceRef = '',
  [string]$ExpectedCommit = '',
  [switch]$Force,
  [switch]$PowerMode,
  [switch]$StandardMode,
  [switch]$GuiControl,
  [switch]$DisableGuiControl,
  [string[]]$DisableCapability = @(),
  [string[]]$EnableCapability = @(),
  [string[]]$TargetProfile = @(),
  [switch]$SelfTest,
  [switch]$NoPromote,
  [ValidateRange(5,300)][int]$DrainTimeoutSeconds = 60
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'tools\stale-drain-policy.ps1')
if($PowerMode -and $StandardMode){throw 'PowerMode and StandardMode are mutually exclusive.'}
if($GuiControl -and $DisableGuiControl){throw 'GuiControl and DisableGuiControl are mutually exclusive.'}
if($GuiControl -and $StandardMode){throw 'GuiControl cannot be combined with StandardMode.'}
foreach($requestedProfile in $TargetProfile){
  if($requestedProfile -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or $requestedProfile -match '\.\.' -or $requestedProfile -in @('.','..')){throw "Invalid TargetProfile: $requestedProfile"}
}
$TargetProfile=@($TargetProfile|Select-Object -Unique)

$Repo='https://github.com/GOD13emad/ChatGPTRemoteCommander.git'
# CI-only, exact-repository source selection. The installed updater keeps
# the legacy release repository unless this is TandemVector's hosted QA.
if($env:GITHUB_ACTIONS -ceq 'true' -and
   $env:GITHUB_REPOSITORY -ceq 'TandemVector-Labs/ChatGPTRemoteCommander' -and
   $env:REMOTE_COMMANDER_REPO_URL -ceq 'https://github.com/TandemVector-Labs/ChatGPTRemoteCommander.git' -and
   $ExpectedCommit -cmatch '^[0-9a-f]{40}$'){
  $Repo=$env:REMOTE_COMMANDER_REPO_URL
}
$StateRoot=Join-Path $env:LOCALAPPDATA 'ChatGPTRemoteCommander'
$PauseFile=Join-Path $StateRoot 'maintenance\auto-update-paused.json'
if(-not $Force -and (Test-Path -LiteralPath $PauseFile -PathType Leaf)){
  Write-Output "AUTO_UPDATE_PAUSED file=$PauseFile"
  exit 0
}
if([string]::IsNullOrWhiteSpace($InstallDir)){ $InstallDir=Join-Path $StateRoot 'app' }
$InstallDir=[IO.Path]::GetFullPath($InstallDir)
$ReleaseRoot=Join-Path $StateRoot 'releases'
$RoutingRoot=Join-Path $StateRoot 'routing'
$RuntimeRoot=Join-Path $StateRoot 'runtimes'
$InstanceRoot=Join-Path $StateRoot 'instances'
$ProfileDir=Join-Path $env:APPDATA 'tunnel-client'
$LogDir=Join-Path $StateRoot 'update-logs'
$ResultFile=Join-Path $StateRoot 'last-update.json'
$RetainedFile=Join-Path $StateRoot 'retained-backends.json'
$QualificationFailureFile=Join-Path $StateRoot 'qualification-failure.json'
New-Item -ItemType Directory -Force -Path $ReleaseRoot,$RoutingRoot,$RuntimeRoot,$LogDir | Out-Null

function Log([string]$Message){
  $line="$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath (Join-Path $LogDir 'auto-update.log') -Value $line -Encoding utf8
  if(-not $SelfTest){ Write-Host $Message }
}
function Atomic-Json([string]$Path,[object]$Value){
  $tmp="$Path.tmp-$PID"
  [IO.File]::WriteAllText($tmp,($Value|ConvertTo-Json -Depth 30)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}function Get-QualificationFailureState {
  if(-not(Test-Path -LiteralPath $QualificationFailureFile -PathType Leaf)){return $null}
  try{return Read-Json $QualificationFailureFile}catch{Log "QUALIFICATION_BACKOFF_READ_WARN $($_.Exception.Message)";return $null}
}
function Get-QualificationBackoffMinutes([int]$Count){
  $steps=@(15,30,60,120,240,360)
  $index=[Math]::Max(0,[Math]::Min($steps.Count-1,$Count-1))
  return [int]$steps[$index]
}
function Get-ActiveQualificationBackoff([string]$Commit){
  if($Force){return $null}
  $state=Get-QualificationFailureState
  if(-not $state -or [string]$state.commit-ne$Commit){return $null}
  try{
    $next=[DateTimeOffset]::Parse([string]$state.nextRetryAt).ToUniversalTime()
    if($next-gt[DateTimeOffset]::UtcNow){return $state}
  }catch{}
  return $null
}
function Record-QualificationFailure([string]$Commit,[string]$Gate,[string]$Code){
  if(-not $Commit){return}
  $old=Get-QualificationFailureState
  $count=1
  if($old -and [string]$old.commit-eq$Commit -and [string]$old.gate-eq$Gate){$count=[int]$old.count+1}
  $minutes=Get-QualificationBackoffMinutes $count
  $now=[DateTimeOffset]::UtcNow
  $state=[ordered]@{
    schema=1;commit=$Commit;gate=$Gate;count=$count;code=$Code;
    failedAt=$now.ToString('o');nextRetryAt=$now.AddMinutes($minutes).ToString('o');backoffMinutes=$minutes
  }
  Atomic-Json $QualificationFailureFile $state
  Log "QUALIFICATION_FAILURE_RECORDED commit=$Commit gate=$Gate count=$count backoffMinutes=$minutes code=$Code"
}
function Clear-QualificationFailure([string]$Commit){
  $state=Get-QualificationFailureState
  if($state -and [string]$state.commit-eq$Commit){
    Remove-Item -LiteralPath $QualificationFailureFile -Force -ErrorAction SilentlyContinue
    Log "QUALIFICATION_FAILURE_CLEARED commit=$Commit"
  }
}
function Get-RetainedBackends {
  if(-not(Test-Path -LiteralPath $RetainedFile -PathType Leaf)){return @()}
  try{
    $doc=Read-Json $RetainedFile
    if($doc -and $doc.PSObject.Properties.Name -contains 'items'){return @($doc.items)}
  }catch{Log "RETAINED_BACKEND_READ_WARN $($_.Exception.Message)"}
  return @()
}
function Save-RetainedBackends([object[]]$Items){
  Atomic-Json $RetainedFile ([ordered]@{schema=1;items=@($Items);updatedAt=(Get-Date).ToUniversalTime().ToString('o')})
}
function Test-BackendReferencedInRoutes([object]$Backend){
  foreach($f in Get-ChildItem -LiteralPath $RoutingRoot -Filter '*.json' -File -ErrorAction SilentlyContinue){
    if($f.Name -like '*.runtime.json'){continue}
    try{
      $r=Read-Json $f.FullName
      foreach($slot in @($r.active,$r.previous)){
        if($slot -and [int]$slot.port-eq[int]$Backend.port -and [string]$slot.commit-eq[string]$Backend.commit){return $true}
      }
    }catch{}
  }
  return $false
}
function Add-RetainedBackend([string]$Profile,[object]$Backend,[object[]]$TerminalChildren){
  $items=@(Get-RetainedBackends)
  $exists=@($items|Where-Object{[string]$_.profile-eq$Profile -and [int]$_.port-eq[int]$Backend.port -and [string]$_.commit-eq[string]$Backend.commit}).Count-gt0
  if(-not $exists){
    $entry=[ordered]@{
      profile=$Profile;port=[int]$Backend.port;version=[string]$Backend.version;commit=[string]$Backend.commit;
      configSha256=[string]$Backend.configSha256;configPath=[string]$Backend.configPath;projectDir=[string]$Backend.projectDir;
      terminalPids=@($TerminalChildren|ForEach-Object{[int]$_.ProcessId});
      retainedAt=(Get-Date).ToUniversalTime().ToString('o')
    }
    $items+= [pscustomobject]$entry
    Save-RetainedBackends $items
  }
}
function Complete-RetainedBackends {
  $items=@(Get-RetainedBackends)
  if($items.Count-eq0){return}
  $keep=@()
  foreach($entry in $items){
    if(Test-BackendReferencedInRoutes $entry){$keep+=$entry;continue}
    if(-not(Test-OwnedOldBackend $entry)){Log "RETAINED_BACKEND_GONE profile=$($entry.profile) port=$($entry.port)";continue}
    $terms=@(Get-PersistentTerminalChildren $entry)
    if($terms.Count-gt0){
      $entry.terminalPids=@($terms|ForEach-Object{[int]$_.ProcessId})
      $keep+=$entry
      continue
    }
    $canonical=Get-CanonicalPortForProfile ([string]$entry.profile)
    $ev=Get-StaleDrainEvidence $entry $canonical
    if($ev.safe -and (Stop-StaleBackendTree $entry $canonical)){
      Log "RETAINED_BACKEND_REAPED profile=$($entry.profile) port=$($entry.port)"
      continue
    }
    Log "RETAINED_BACKEND_REAP_DEFER profile=$($entry.profile) port=$($entry.port) decision=$($ev.decision)"
    $keep+=$entry
  }
  Save-RetainedBackends $keep
}
function Get-ProtectedReleasePaths {
  $protected=@{}
  foreach($f in Get-ChildItem -LiteralPath $RoutingRoot -Filter '*.json' -File -ErrorAction SilentlyContinue){
    if($f.Name -like '*.runtime.json'){continue}
    try{
      $r=Read-Json $f.FullName
      foreach($slot in @($r.active,$r.previous)){
        if($slot -and $slot.projectDir){$protected[[IO.Path]::GetFullPath([string]$slot.projectDir).ToLowerInvariant()]=$true}
      }
    }catch{}
  }
  foreach($entry in @(Get-RetainedBackends)){
    if($entry.projectDir){$protected[[IO.Path]::GetFullPath([string]$entry.projectDir).ToLowerInvariant()]=$true}
  }
  return $protected
}
function Retain-PreviousBackend([string]$RoutePath,[object]$Old,[string]$Profile,[int]$Canonical,[object[]]$RetentionRoots,[string]$Kind='terminal'){
  $st=Get-DrainStatus $Canonical ([int]$Old.port)
  if(-not $st.ok){return $false}
  if($st.count-gt0){
    $first=Get-TerminalRetentionEvidence $Old $Canonical $RetentionRoots
    if(-not $first.safe){if($Kind-eq'command'){Log "DRAIN_COMMAND_RETAIN_DEFER profile=$Profile decision=$($first.decision)"}else{Log "DRAIN_TERMINAL_RETAIN_DEFER profile=$Profile decision=$($first.decision)"};return $false}
    Start-Sleep -Milliseconds 500
    $final=Get-TerminalRetentionEvidence $Old $Canonical $RetentionRoots
    if(-not $final.safe){if($Kind-eq'command'){Log "DRAIN_COMMAND_RETAIN_RECHECK_DEFER profile=$Profile decision=$($final.decision)"}else{Log "DRAIN_TERMINAL_RETAIN_RECHECK_DEFER profile=$Profile decision=$($final.decision)"};return $false}
    if($Kind-eq'command'){Log "DRAIN_COMMAND_ROUTER_ACCOUNTING profile=$Profile inflight=$($st.count)"}else{Log "DRAIN_TERMINAL_STALE_ROUTER_ACCOUNTING profile=$Profile inflight=$($st.count)"}
  }
  Add-RetainedBackend $Profile $Old $RetentionRoots
  Retire-PreviousRoute $RoutePath $Old $Profile
  if($Kind-eq'command'){Log "DRAIN_COMMAND_RETAINED profile=$Profile port=$($Old.port) pids=$(@($RetentionRoots|ForEach-Object{[int]$_.ProcessId}) -join ',')"}else{Log "DRAIN_TERMINAL_RETAINED profile=$Profile port=$($Old.port) pids=$(@($RetentionRoots|ForEach-Object{[int]$_.ProcessId}) -join ',')"}
  return $true
}
function Test-ProfileName([string]$Name){
  return ($Name -match '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -and $Name -notmatch '\.\.' -and $Name -notin @('.','..'))
}
function Get-RoutePath([string]$Profile){ Join-Path $RoutingRoot "$Profile.json" }
function Read-Json([string]$Path){ Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
function Merge-OwnerPolicyConfig([string]$Active,[string]$Canonical,[string]$Profile){
  if(-not($Active -and (Test-Path -LiteralPath $Active -PathType Leaf))){return $Canonical}
  $activePath=[IO.Path]::GetFullPath($Active)
  if(-not($Canonical -and (Test-Path -LiteralPath $Canonical -PathType Leaf))){return $activePath}
  $mergeTool=Join-Path $PSScriptRoot 'tools\merge-primary-policy.mjs'
  if(-not(Test-Path -LiteralPath $mergeTool -PathType Leaf)){return $activePath}
  $safeProfile=if($Profile){$Profile}else{'default'}
  $effective=Join-Path $StateRoot ("owner-policy-effective-{0}.json" -f $safeProfile)
  $raw=@(& node.exe $mergeTool --active $activePath --local ([IO.Path]::GetFullPath($Canonical)) --output $effective)
  if($LASTEXITCODE-ne 0){throw "PRIMARY_POLICY_MERGE_FAIL profile=$safeProfile"}
  try{$summary=([string]($raw|Select-Object -Last 1))|ConvertFrom-Json}catch{throw "PRIMARY_POLICY_MERGE_RESULT_INVALID profile=$safeProfile"}
  if($summary.merged-eq $true){
    Log "PRIMARY_POLICY_OVERLAY profile=$safeProfile status=$($summary.status)"
    return $effective
  }
  return $activePath
}
function Get-PrimaryConfig {
  $route=Get-RoutePath 'default'
  $local=Join-Path $InstallDir 'config.local.json'
  if(Test-Path $route){
    $r=Read-Json $route
    if($r.active.configPath -and (Test-Path -LiteralPath $r.active.configPath -PathType Leaf)){
      return (Merge-OwnerPolicyConfig ([string]$r.active.configPath) $local 'default')
    }
  }
  if(Test-Path -LiteralPath $local -PathType Leaf){ return [IO.Path]::GetFullPath($local) }
  return (Join-Path $InstallDir 'config.json')
}
function Invoke-Mcp([int]$Port,[string]$Name,[hashtable]$Arguments=@{}){
  $body=@{jsonrpc='2.0';id=1;method='tools/call';params=@{name=$Name;arguments=$Arguments;_meta=@{'io.modelcontextprotocol/protocolVersion'='2026-07-28';'io.modelcontextprotocol/clientCapabilities'=@{};'io.modelcontextprotocol/clientInfo'=@{name='remote-commander-updater';version='0.9.10'}}}}|ConvertTo-Json -Depth 20 -Compress
  $headers=@{'MCP-Protocol-Version'='2026-07-28';'Mcp-Method'='tools/call';'Mcp-Name'=$Name}
  $r=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/mcp" -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 30
  if($r.error){ throw "MCP_RPC_ERROR $($r.error.message)" }
  if($r.result.isError){ throw "MCP_TOOL_ERROR $Name $($r.result.content[0].text)" }
  return $r.result.structuredContent
}
function Wait-Health([int]$Port,[string]$Version,[string]$ConfigSha,[string]$Profile,[int]$Seconds=30){
  foreach($i in 1..($Seconds*2)){
    try{
      $h=Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2
      if($h.ok -and [string]$h.version -eq $Version -and [string]$h.configSha256 -eq $ConfigSha -and [string]$h.instance.profile -eq $Profile){ return $h }
    }catch{}
    Start-Sleep -Milliseconds 500
  }
  throw "CANDIDATE_HEALTH_TIMEOUT profile=$Profile port=$Port"
}
function Get-FreePort([System.Collections.Generic.HashSet[int]]$Used){
  foreach($p in 48831..51999){
    if($Used.Contains($p)){ continue }
    if(-not(Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)){
      [void]$Used.Add($p);return $p
    }
  }
  throw 'NO_PRIVATE_BACKEND_PORT'
}
function Test-VersionGreater([string]$Left,[string]$Right){
  try{return ([version]$Left -gt [version]$Right)}catch{throw "AUTO_UPDATE_VERSION_COMPARE_INVALID left=$Left right=$Right"}
}
function Get-LatestTag {
  if($SourceRef){ return $SourceRef }
  $tag=''
  try{
    $latest=Invoke-WebRequest -Method Head -Uri 'https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/latest' -MaximumRedirection 5 -TimeoutSec 20 -Headers @{'User-Agent'='ChatGPTRemoteCommander-Updater'}
    $effective=[string]$latest.BaseResponse.RequestMessage.RequestUri.AbsoluteUri
    if($effective -match '/releases/tag/(v\d+\.\d+\.\d+)$'){ $tag=[string]$Matches[1] }
  }catch{}
  if($tag -match '^v\d+\.\d+\.\d+$'){ return $tag }
  $release=Invoke-RestMethod 'https://api.github.com/repos/GOD13emad/ChatGPTRemoteCommander/releases/latest' -Headers @{'User-Agent'='ChatGPTRemoteCommander-Updater'} -TimeoutSec 20
  if($release.draft -or $release.prerelease){ throw 'LATEST_RELEASE_NOT_STABLE' }
  $tag=[string]$release.tag_name
  if($tag -notmatch '^v\d+\.\d+\.\d+$'){ throw 'LATEST_RELEASE_TAG_INVALID' }
  return $tag
}
function Ensure-ProjectProvider([string]$ConfigPath){
  if($NoPromote){
    Log 'PROJECT_PROVIDER_CLEANUP_SKIPPED reason=no-promote'
    return
  }
  # R230: a disabled, unknown legacy tool projection is not an owner-accepted
  # retired release. Do not inspect or delete its contents during a Core upgrade.
  $legacyRoot=Join-Path $StateRoot 'tools\codex-cli'
  if(Test-Path -LiteralPath $legacyRoot){
    Log 'LEGACY_CODEX_PROVIDER_CLEANUP_PENDING reason=OWNER_ACCEPTANCE_REQUIRED'
  }
  Log 'PROJECT_PROVIDER_DISABLED policy=NO_CODEX_VIA_COMMANDER'
}
function Stage-Release([string]$Ref){
  $tmp=Join-Path $ReleaseRoot ("stage-{0}-{1}" -f ($Ref -replace '[^A-Za-z0-9._-]','_'),$PID)
  if(Test-Path $tmp){Remove-Item $tmp -Recurse -Force}
  New-Item -ItemType Directory -Path $tmp|Out-Null
  & git.exe -C $tmp init | Out-Null
  if($LASTEXITCODE-ne 0){throw 'STAGE_GIT_INIT'}
  & git.exe -C $tmp remote add origin $Repo
  & git.exe -C $tmp fetch --depth 1 --no-tags origin $Ref
  if($LASTEXITCODE-ne 0){throw 'STAGE_GIT_FETCH'}
  $commit=(& git.exe -C $tmp rev-parse 'FETCH_HEAD^{commit}').Trim().ToLowerInvariant()
  if($commit -notmatch '^[0-9a-f]{40}$'){throw 'STAGE_COMMIT_INVALID'}
  if($ExpectedCommit -and $commit-ne $ExpectedCommit.ToLowerInvariant()){throw 'STAGE_EXPECTED_COMMIT_MISMATCH'}
  & git.exe -C $tmp checkout --detach $commit | Out-Null
  if($LASTEXITCODE-ne 0){throw 'STAGE_CHECKOUT'}
  $pkg=Read-Json (Join-Path $tmp 'package.json')
  $version=[string]$pkg.version
  if($Ref -match '^v(\d+\.\d+\.\d+)$' -and $Matches[1]-ne $version){throw 'STAGE_TAG_VERSION_MISMATCH'}
  $final=Join-Path $ReleaseRoot ("v{0}-{1}" -f $version,$commit.Substring(0,12))
  if(Test-Path $final){
    $head=(& git.exe -C $final rev-parse HEAD 2>$null).Trim().ToLowerInvariant()
    if($head-ne $commit){throw 'RELEASE_DIRECTORY_COLLISION'}
    Remove-Item $tmp -Recurse -Force
  }else{
    Move-Item $tmp $final
  }
  return [pscustomobject]@{Ref=$Ref;Commit=$commit;Version=$version;Dir=$final}
}
function Run-Gate([string]$Candidate,[string]$Name,[string[]]$CommandArgs){
  Log "GATE_START $Name"
  if(-not $CommandArgs -or $CommandArgs.Count -lt 1){throw "GATE_ARGUMENTS_MISSING $Name"}
  $commit=[string]$script:QualificationCommit
  if($commit -notmatch '^[0-9a-f]{40}$'){throw "GATE_COMMIT_MISSING $Name"}
  $runner=Join-Path $Candidate 'tools\run-owned-process-tree-windows.ps1'
  if(-not(Test-Path -LiteralPath $runner -PathType Leaf)){throw "GATE_JOB_RUNNER_MISSING $Name"}
  $npm=(Get-Command npm.cmd -ErrorAction Stop).Source
  $runId=("qualification-{0}-{1}-{2}" -f $Name,$commit.Substring(0,12),([guid]::NewGuid().ToString('N')))
  $reportPath=Join-Path $LogDir ("qualification-job-{0}.json" -f $runId)
  $argumentsJson=@($CommandArgs)|ConvertTo-Json -Compress
  $stdoutPath=Join-Path $LogDir ("qualification-output-{0}.stdout.log" -f $runId)
  $stderrPath=Join-Path $LogDir ("qualification-output-{0}.stderr.log" -f $runId)
  Log "GATE_OUTPUT_FILES runId=$runId stdout=$stdoutPath stderr=$stderrPath"
  try{
    & pwsh.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runner -Program $npm -WorkingDirectory $Candidate -ArgumentsJson $argumentsJson -RunId $runId -TimeoutSeconds 1200 -DrainGraceMs 2000 -ReportPath $reportPath 1> $stdoutPath 2> $stderrPath
    $code=$LASTEXITCODE
    $stdoutSha=(Get-FileHash -LiteralPath $stdoutPath -Algorithm SHA256).Hash
    $stderrSha=(Get-FileHash -LiteralPath $stderrPath -Algorithm SHA256).Hash
    Log "GATE_OUTPUT_HASH runId=$runId stdoutSha256=$stdoutSha stderrSha256=$stderrSha"
    if($code-ne 0){throw "GATE_FAIL $Name exit=$code runId=$runId stdout=$stdoutPath stderr=$stderrPath"}
    Log "GATE_PASS $Name runId=$runId"
  }catch{
    Record-QualificationFailure $commit $Name $_.Exception.Message
    throw
  }
}
function Run-GuiNativeSelfTest([string]$Candidate){
  Log "GATE_START gui-native-selftest"
  $helper=Join-Path $Candidate 'tools\gui-control.ps1'
  if(-not(Test-Path -LiteralPath $helper -PathType Leaf)){throw 'GATE_GUI_HELPER_MISSING'}
  & pwsh.exe -NoLogo -NoProfile -NonInteractive -File $helper -SelfTest
  if($LASTEXITCODE-ne 0){throw 'GATE_FAIL gui-native-selftest'}
  Log "GATE_PASS gui-native-selftest"
}
function Start-Backend([string]$ProjectDir,[string]$ConfigPath,[string]$StateDir){
  New-Item -ItemType Directory -Force -Path $StateDir|Out-Null
  $node=(Get-Command node.exe -ErrorAction Stop).Source
  $hadConfig=Test-Path Env:REMOTE_COMMANDER_CONFIG
  $previousConfig=$env:REMOTE_COMMANDER_CONFIG
  try{
    $env:REMOTE_COMMANDER_CONFIG=$ConfigPath
    # Use Start-Process without stdio redirection. In a piped MCP run_shell parent,
    # redirected long-lived children can retain inherited pipe handles and prevent
    # the caller from observing EOF after the updater itself exits.
    return Start-Process -FilePath $node -ArgumentList @((Join-Path $ProjectDir 'src\server-v0.3.mjs')) -WorkingDirectory $ProjectDir -WindowStyle Hidden -PassThru
  }finally{
    if($hadConfig){$env:REMOTE_COMMANDER_CONFIG=$previousConfig}else{Remove-Item Env:REMOTE_COMMANDER_CONFIG -ErrorAction SilentlyContinue}
  }
}
function Stop-OwnedCandidate([object]$Candidate,[switch]$Strict){
  if(-not $Candidate){return}
  $proc=$Candidate.Process
  if(-not $proc -or $proc.HasExited){return}
  $listener=Get-NetTCPConnection -State Listen -LocalPort ([int]$Candidate.Port) -ErrorAction SilentlyContinue|Select-Object -First 1
  $cfg=Read-Json $Candidate.ConfigPath
  $markerFile=[string]$cfg.runtimeState
  $marker=if($markerFile -and (Test-Path -LiteralPath $markerFile -PathType Leaf)){Read-Json $markerFile}else{$null}
  $owned=$listener -and $marker -and
    [int]$listener.OwningProcess-eq [int]$proc.Id -and
    [int]$marker.pid-eq [int]$proc.Id -and
    [int]$marker.port-eq [int]$Candidate.Port -and
    [string]$marker.instance.profile-eq [string]$Candidate.Profile
  if(-not $owned){
    $msg="CANDIDATE_CLEANUP_OWNERSHIP_MISMATCH profile=$($Candidate.Profile) port=$($Candidate.Port) pid=$($proc.Id)"
    if($Strict){throw $msg}
    Log $msg
    return
  }
  Stop-Process -Id $proc.Id -Force -ErrorAction Stop
  foreach($i in 1..40){Start-Sleep -Milliseconds 100;if(-not(Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)){return}}
  $msg="CANDIDATE_CLEANUP_TIMEOUT profile=$($Candidate.Profile) port=$($Candidate.Port) pid=$($proc.Id)"
  if($Strict){throw $msg}
  Log $msg
}
function Get-Targets {
  $items=@()
  $primary=Get-PrimaryConfig
  $items+=[pscustomobject]@{Profile='default';CanonicalPort=47831;ExistingConfig=$primary;RoutePath=(Get-RoutePath 'default');InstanceDir=(Join-Path $InstanceRoot 'default')}
  if(Test-Path $InstanceRoot){
    foreach($profileDir in Get-ChildItem -LiteralPath $InstanceRoot -Directory -ErrorAction SilentlyContinue){
      $recordFile=Join-Path $profileDir.FullName 'instance.json'
      if(-not(Test-Path -LiteralPath $recordFile -PathType Leaf)){continue}
      try{
        $record=Read-Json $recordFile
        $profile=[string]$record.profile
        if(-not(Test-ProfileName $profile) -or $profile-eq 'default' -or $record.enabled-ne $true){continue}
        if($profileDir.Name-ne $profile){throw "PROFILE_DIRECTORY_MISMATCH expected=$profile actual=$($profileDir.Name)"}
        $route=Get-RoutePath $profile
        $canonical=[string]$record.configPath
        $cfg=$canonical
        if(Test-Path $route){
          $rr=Read-Json $route
          if($rr.active.configPath -and (Test-Path -LiteralPath $rr.active.configPath -PathType Leaf)){
            $cfg=Merge-OwnerPolicyConfig ([string]$rr.active.configPath) $canonical $profile
          }
        }
        if(-not($cfg -and (Test-Path -LiteralPath $cfg -PathType Leaf))){throw "PROFILE_CONFIG_MISSING profile=$profile"}
        $items+=[pscustomobject]@{Profile=$profile;CanonicalPort=[int]$record.mcpPort;ExistingConfig=[IO.Path]::GetFullPath($cfg);RoutePath=$route;InstanceDir=$profileDir.FullName}
      }catch{throw "TARGET_DISCOVERY_FAIL $recordFile $($_.Exception.Message)"}
    }
  }
  if($TargetProfile.Count -gt 0){
    $found=@($items|Where-Object { $TargetProfile -contains $_.Profile })
    $missing=@($TargetProfile|Where-Object { $_ -notin @($found.Profile) })
    if($missing.Count -gt 0){throw "TARGET_PROFILE_NOT_FOUND profiles=$($missing -join ',')"}
    $items=$found
  }
  return @($items|Sort-Object CanonicalPort,Profile)
}
function Start-Router([int]$CanonicalPort,[string]$RoutePath,[string]$RouterSource,[string]$Profile){
  try{
    $st=Invoke-RestMethod "http://127.0.0.1:$CanonicalPort/router/status" -TimeoutSec 2
    if($st.ok -and $st.router){return $null}
  }catch{}
  $listener=Get-NetTCPConnection -State Listen -LocalPort $CanonicalPort -ErrorAction SilentlyContinue|Select-Object -First 1
  if($listener){throw "ROUTER_PORT_OCCUPIED profile=$Profile port=$CanonicalPort pid=$($listener.OwningProcess)"}
  $node=(Get-Command node.exe -ErrorAction Stop).Source
  $runtime=Join-Path $RoutingRoot "$Profile.runtime.json"
  $psi=[Diagnostics.ProcessStartInfo]::new()
  $psi.FileName=$node;$psi.WorkingDirectory=$StateRoot;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
  foreach($x in @($RouterSource,'--listen-port',[string]$CanonicalPort,'--state-file',$RoutePath,'--runtime-file',$runtime)){[void]$psi.ArgumentList.Add($x)}
  $p=[Diagnostics.Process]::Start($psi)
  foreach($i in 1..40){
    Start-Sleep -Milliseconds 250
    try{$st=Invoke-RestMethod "http://127.0.0.1:$CanonicalPort/router/status" -TimeoutSec 1;if($st.ok -and $st.router){return $p}}catch{}
    if($p.HasExited){break}
  }
  if(-not $p.HasExited){Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue}
  throw "ROUTER_START_FAIL profile=$Profile"
}
function Get-SchemaContinuityProbe([string]$StageDir,[int]$OldPort,[int]$CandidatePort,[int]$CanonicalPort){
  $raw=@(& node.exe (Join-Path $StageDir 'tools\schema-continuity-gate.mjs') --old-url ("http://127.0.0.1:{0}/mcp" -f $OldPort) --candidate-url ("http://127.0.0.1:{0}/mcp" -f $CandidatePort) --router-url ("http://127.0.0.1:{0}/router/status" -f $CanonicalPort) 2>$null)
  $rc=$LASTEXITCODE
  try{$v=([string]($raw|Select-Object -Last 1))|ConvertFrom-Json}catch{throw "SCHEMA_CONTINUITY_PROBE_INVALID port=$CanonicalPort rc=$rc"}
  return [pscustomobject]@{ok=[bool]$v.ok;changed=[bool]$v.changed;decision=[string]$v.decision;exitCode=[int]$rc}
}
function Ensure-RouterCandidateSource([object]$Target,[string]$StageDir){
  $runtime=Join-Path $RoutingRoot "$($Target.Profile).runtime.json"
  $raw=@(& node.exe (Join-Path $StageDir 'tools\router-source-bootstrap.mjs') --url ("http://127.0.0.1:{0}/router/status" -f [int]$Target.CanonicalPort) --state $Target.RoutePath --runtime $runtime --candidate-source (Join-Path $StageDir 'src\stable-router.mjs') --log (Join-Path $StateRoot 'router.log'))
  if($LASTEXITCODE-ne 0){throw "ROUTER_SOURCE_BOOTSTRAP_FAIL profile=$($Target.Profile)"}
  try{return ([string]($raw|Select-Object -Last 1))|ConvertFrom-Json}catch{throw "ROUTER_SOURCE_BOOTSTRAP_RESULT_INVALID profile=$($Target.Profile)"}
}

function Stop-OwnedDirect([object]$Target){
  $listener=Get-NetTCPConnection -State Listen -LocalPort $Target.CanonicalPort -ErrorAction SilentlyContinue|Select-Object -First 1
  if(-not $listener){return $null}
  $marker=if($Target.Profile-eq 'default'){Join-Path $InstallDir 'var\mcp-runtime.json'}else{Join-Path $Target.InstanceDir 'mcp-runtime.json'}
  if(-not(Test-Path -LiteralPath $marker)){throw "DIRECT_MARKER_MISSING profile=$($Target.Profile)"}
  $m=Read-Json $marker
  if([int]$m.pid-ne [int]$listener.OwningProcess -or [int]$m.port-ne $Target.CanonicalPort -or [string]$m.instance.profile-ne $Target.Profile){throw "DIRECT_OWNERSHIP_MISMATCH profile=$($Target.Profile)"}
  Stop-Process -Id $listener.OwningProcess -Force
  foreach($i in 1..40){Start-Sleep -Milliseconds 100;if(-not(Get-NetTCPConnection -State Listen -LocalPort $Target.CanonicalPort -ErrorAction SilentlyContinue)){return $m}}
  throw "DIRECT_STOP_TIMEOUT profile=$($Target.Profile)"
}
function Write-InitialRoute([object]$Target,[object]$Candidate){
  $state=[ordered]@{
    schema=1;profile=$Target.Profile;generation=1
    active=[ordered]@{port=$Candidate.Port;version=$Candidate.Version;commit=$Candidate.Commit;configSha256=$Candidate.ConfigSha;configPath=$Candidate.ConfigPath;projectDir=$Candidate.ProjectDir}
    previous=$null;updatedAt=(Get-Date).ToUniversalTime().ToString('o')
  }
  Atomic-Json $Target.RoutePath $state
}
function Switch-Route([object]$Target,[object]$Candidate){
  $state=Read-Json $Target.RoutePath
  & node.exe (Join-Path $Candidate.ProjectDir 'tools\router-switch.mjs') --state $Target.RoutePath --expected-generation ([string]$state.generation) --profile $Target.Profile --port ([string]$Candidate.Port) --version $Candidate.Version --commit $Candidate.Commit --config-sha $Candidate.ConfigSha --config-path $Candidate.ConfigPath --project-dir $Candidate.ProjectDir
  if($LASTEXITCODE-ne 0){throw "ROUTER_SWITCH_FAIL profile=$($Target.Profile)"}
}
function Verify-Canonical([object]$Target,[object]$Candidate){
  $status=Invoke-Mcp $Target.CanonicalPort 'system_status'
  if([string]$status.version-ne $Candidate.Version -or [string]$status.configSha256-ne $Candidate.ConfigSha -or [string]$status.instance.profile-ne $Target.Profile){throw "CANONICAL_VERIFY_FAIL profile=$($Target.Profile)"}
}
function Verify-Tunnels {
  if(-not(Test-Path $ProfileDir)){return}
  foreach($f in Get-ChildItem -LiteralPath $ProfileDir -Filter '*.yaml' -File -ErrorAction SilentlyContinue){
    $raw=Get-Content -LiteralPath $f.FullName -Raw
    $m=[regex]::Match($raw,'listen_addr:\s*["'']?127\.0\.0\.1:(\d+)')
    if(-not $m.Success){continue}
    $port=[int]$m.Groups[1].Value
    $ready=$false
    foreach($i in 1..20){try{$x=Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/readyz" -TimeoutSec 1;if($x.StatusCode-eq 200 -and $x.Content.Trim()-eq 'ready'){$ready=$true;break}}catch{};Start-Sleep -Milliseconds 250}
    if(-not $ready){throw "TUNNEL_NOT_READY profile=$([IO.Path]::GetFileNameWithoutExtension($f.Name)) port=$port"}
  }
}
function Stop-OldBackend([object]$Active){
  if(-not $Active -or -not $Active.configPath){return}
  try{
    $cfg=Read-Json ([string]$Active.configPath)
    $marker=[string]$cfg.runtimeState
    if(-not $marker -or -not(Test-Path -LiteralPath $marker)){return}
    $m=Read-Json $marker
    $listener=Get-NetTCPConnection -State Listen -LocalPort ([int]$Active.port) -ErrorAction SilentlyContinue|Select-Object -First 1
    if($listener -and [int]$listener.OwningProcess-eq [int]$m.pid -and [string]$m.projectDir-eq [string]$Active.projectDir){Stop-Process -Id $m.pid -Force -ErrorAction Stop}
  }catch{Log "OLD_BACKEND_STOP_WARN $($_.Exception.Message)"}
}
function Get-CanonicalPortForProfile([string]$Profile){
  if($Profile-eq 'default'){return 47831}
  if(-not(Test-ProfileName $Profile)){throw 'DRAIN_PROFILE_INVALID'}
  $instancePath=Join-Path (Join-Path $InstanceRoot $Profile) 'instance.json'
  if(-not(Test-Path -LiteralPath $instancePath -PathType Leaf)){throw "DRAIN_INSTANCE_MISSING profile=$Profile"}
  $instance=Read-Json $instancePath
  if([string]$instance.profile-ne $Profile -or [int]$instance.mcpPort-lt 1024 -or [int]$instance.mcpPort-gt 65535){throw "DRAIN_INSTANCE_INVALID profile=$Profile"}
  return [int]$instance.mcpPort
}
function Test-OwnedOldBackend([object]$OldActive){
  if(-not $OldActive -or -not $OldActive.configPath){return $false}
  try{
    $cfg=Read-Json ([string]$OldActive.configPath)
    $marker=[string]$cfg.runtimeState
    if(-not $marker -or -not(Test-Path -LiteralPath $marker -PathType Leaf)){return $false}
    $m=Read-Json $marker
    $listener=Get-NetTCPConnection -State Listen -LocalPort ([int]$OldActive.port) -ErrorAction SilentlyContinue|Select-Object -First 1
    return [bool]($listener -and [int]$listener.OwningProcess-eq [int]$m.pid -and [string]$m.projectDir-eq [string]$OldActive.projectDir)
  }catch{return $false}
}
function Get-BackendDescendants([int]$RootPid){
  $all=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $set=New-Object 'System.Collections.Generic.HashSet[int]'
  [void]$set.Add($RootPid)
  $changed=$true
  while($changed){
    $changed=$false
    foreach($p in $all){
      if($set.Contains([int]$p.ParentProcessId)-and -not $set.Contains([int]$p.ProcessId)){
        [void]$set.Add([int]$p.ProcessId)
        $changed=$true
      }
    }
  }
  return @($all|Where-Object {$_.ProcessId-ne$RootPid -and $set.Contains([int]$_.ProcessId)})
}
function Get-PersistentTerminalChildren([object]$Active){
  $found=@()
  if(-not(Test-OwnedOldBackend $Active)){return @($found)}
  try{
    $cfg=Read-Json ([string]$Active.configPath)
    $marker=Read-Json ([string]$cfg.runtimeState)
    $backendPid=[int]$marker.pid
    foreach($p in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue|Where-Object {[int]$_.ParentProcessId-eq$backendPid})){
      $cmd=([string]$p.CommandLine).Trim().ToLowerInvariant()
      $interactive=($cmd -eq 'pwsh.exe -nologo -noprofile' -or $cmd.EndsWith('\\pwsh.exe" -nologo -noprofile'))
      if([string]$p.Name -ieq 'pwsh.exe' -and $interactive){$found+=$p}
    }
  }catch{}
  return @($found|Select-Object ProcessId,ParentProcessId,Name,CommandLine)
}
function Get-RetainableLongCommandRoots([object]$Active,[int]$CanonicalPort){
  $found=@()
  if(-not(Test-OwnedOldBackend $Active)){return @($found)}
  try{
    $st=Get-DrainStatus $CanonicalPort ([int]$Active.port)
    if(-not $st.ok -or $st.count-lt1 -or @($st.details).Count-ne$st.count){return @($found)}
    $commandDetails=@($st.details|Where-Object{
      $_.cancellable-ne$true -and [string]$_.rpcMethod-eq'tools/call' -and [string]$_.rpcName-in@('run_shell','run_project_command')
    })
    if($commandDetails.Count-ne$st.count){return @($found)}
    $cfg=Read-Json ([string]$Active.configPath)
    $marker=Read-Json ([string]$cfg.runtimeState)
    $backendPid=[int]$marker.pid
    $now=Get-Date
    foreach($p in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue|Where-Object{[int]$_.ParentProcessId-eq$backendPid})){
      $norm=([string]$p.CommandLine).Trim().ToLowerInvariant()
      if([string]$p.Name -ine 'pwsh.exe' -or -not $norm.Contains('-noninteractive') -or $norm.Contains('tools\gui-control.ps1 -server')){continue}
      try{$age=($now-[datetime]$p.CreationDate).TotalSeconds}catch{continue}
      if($age-lt60){continue}
      $found+=$p
    }
    if($found.Count-ne$st.count){return @()}
  }catch{return @()}
  return @($found|Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate)
}
function Get-StaleDrainEvidence([object]$OldActive,[int]$CanonicalPort){
  $result=[ordered]@{safe=$false;decision='DEFER_UNPROVEN';activeOperations=-1;queued=-1;unexpectedConnections=-1;guiBusy=$true;guiLeased=$true;browserActive=$true;browserBusy=$true;browserLeased=$true;browserUncertain=$true;unsafeDescendants=@();safeDescendants=@()}
  if(-not(Test-OwnedOldBackend $OldActive)){$result.decision='NOT_OWNED';return [pscustomobject]$result}
  try{
    $status=Invoke-Mcp ([int]$OldActive.port) 'system_status'
    if([string]$status.version-ne[string]$OldActive.version){$result.decision='DEFER_IDENTITY';return [pscustomobject]$result}
    $cfg=Read-Json ([string]$OldActive.configPath)
    if([string]$status.instance.profile-ne[string]$cfg.instance.profile){$result.decision='DEFER_IDENTITY';return [pscustomobject]$result}
    $result.activeOperations=[int]$status.concurrency.activeOperations
    $result.queued=[int]$status.concurrency.queued
    $gui=Invoke-Mcp ([int]$OldActive.port) 'gui_status'
    $result.guiBusy=[bool]$gui.busy
    $result.guiLeased=[bool]$gui.leased
    $browser=Invoke-Mcp ([int]$OldActive.port) 'browser_status'
    $result.browserActive=[bool]$browser.active
    $result.browserBusy=[bool]$browser.busy
    $result.browserLeased=[bool]$browser.leased
    $result.browserUncertain=[bool]$browser.uncertain
  }catch{
    $result.decision='DEFER_STATUS';return [pscustomobject]$result
  }
  Start-Sleep -Milliseconds 100
  try{
    $cfg=Read-Json ([string]$OldActive.configPath)
    $marker=Read-Json ([string]$cfg.runtimeState)
    $routerListener=Get-NetTCPConnection -State Listen -LocalPort $CanonicalPort -ErrorAction SilentlyContinue|Select-Object -First 1
    if(-not $routerListener){$result.decision='DEFER_ROUTER';return [pscustomobject]$result}
    $backendPid=[int]$marker.pid
    $routerPid=[int]$routerListener.OwningProcess
    $connections=@(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue|Where-Object {
      $_.LocalPort-eq[int]$OldActive.port -or $_.RemotePort-eq[int]$OldActive.port
    })
    $unexpected=@($connections|Where-Object {$_.OwningProcess-ne$backendPid -and $_.OwningProcess-ne$routerPid})
    $result.unexpectedConnections=$unexpected.Count
    $desc=@(Get-BackendDescendants $backendPid)
    $unsafe=@();$safe=@()
    foreach($p in $desc){
      $cmd=[string]$p.CommandLine
      $norm=$cmd.Trim().ToLowerInvariant()
      $isConhost=([string]$p.Name -ieq 'conhost.exe')
      $isGuiHelper=([string]$p.Name -ieq 'pwsh.exe' -and $norm.Contains('tools\gui-control.ps1 -server') -and -not$result.guiBusy -and -not$result.guiLeased)
      $isBrowserHelper=([string]$p.Name -ieq 'node.exe' -and $norm.Contains('tools\browser-control.mjs --server') -and -not$result.browserActive -and -not$result.browserBusy -and -not$result.browserLeased -and -not$result.browserUncertain)
      if($isConhost -or $isGuiHelper -or $isBrowserHelper){$safe+=$p}else{$unsafe+=$p}
    }
    $result.unsafeDescendants=@($unsafe|Select-Object ProcessId,ParentProcessId,Name,CommandLine)
    $result.safeDescendants=@($safe|Select-Object ProcessId,ParentProcessId,Name,CommandLine)
  }catch{
    $result.decision='DEFER_PROCESS_TREE';return [pscustomobject]$result
  }
  $result.decision=Get-StaleDrainDecision -ActiveOperations $result.activeOperations -Queued $result.queued -UnexpectedConnections $result.unexpectedConnections -UnsafeDescendants @($result.unsafeDescendants).Count -GuiBusy $result.guiBusy -GuiLeased $result.guiLeased
  $result.safe=($result.decision-eq'ALLOW')
  return [pscustomobject]$result
}
function Get-TerminalRetentionEvidence([object]$OldActive,[int]$CanonicalPort,[object[]]$TerminalChildren){
  $result=[ordered]@{safe=$false;decision='DEFER_UNPROVEN';activeOperations=-1;queued=-1;unexpectedConnections=-1;guiBusy=$true;guiLeased=$true;browserActive=$true;browserBusy=$true;browserLeased=$true;browserUncertain=$true;unsafeDescendants=@()}
  if(-not(Test-OwnedOldBackend $OldActive)){$result.decision='NOT_OWNED';return [pscustomobject]$result}
  if(@($TerminalChildren).Count-eq0){$result.decision='DEFER_NO_TERMINAL';return [pscustomobject]$result}
  try{
    $status=Invoke-Mcp ([int]$OldActive.port) 'system_status'
    if([string]$status.version-ne[string]$OldActive.version){$result.decision='DEFER_IDENTITY';return [pscustomobject]$result}
    $cfg=Read-Json ([string]$OldActive.configPath)
    if([string]$status.instance.profile-ne[string]$cfg.instance.profile){$result.decision='DEFER_IDENTITY';return [pscustomobject]$result}
    $result.activeOperations=[int]$status.concurrency.activeOperations
    $result.queued=[int]$status.concurrency.queued
    $gui=Invoke-Mcp ([int]$OldActive.port) 'gui_status'
    $result.guiBusy=[bool]$gui.busy
    $result.guiLeased=[bool]$gui.leased
    $browser=Invoke-Mcp ([int]$OldActive.port) 'browser_status'
    $result.browserActive=[bool]$browser.active
    $result.browserBusy=[bool]$browser.busy
    $result.browserLeased=[bool]$browser.leased
    $result.browserUncertain=[bool]$browser.uncertain
  }catch{$result.decision='DEFER_STATUS';return [pscustomobject]$result}
  try{
    $cfg=Read-Json ([string]$OldActive.configPath)
    $marker=Read-Json ([string]$cfg.runtimeState)
    $backendPid=[int]$marker.pid
    $routerListener=Get-NetTCPConnection -State Listen -LocalPort $CanonicalPort -ErrorAction SilentlyContinue|Select-Object -First 1
    if(-not $routerListener){$result.decision='DEFER_ROUTER';return [pscustomobject]$result}
    $routerPid=[int]$routerListener.OwningProcess
    $connections=@(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue|Where-Object{$_.LocalPort-eq[int]$OldActive.port -or $_.RemotePort-eq[int]$OldActive.port})
    $result.unexpectedConnections=@($connections|Where-Object{$_.OwningProcess-ne$backendPid -and $_.OwningProcess-ne$routerPid}).Count
    $desc=@(Get-BackendDescendants $backendPid)
    $byId=@{}; foreach($p in $desc){$byId[[int]$p.ProcessId]=$p}
    $allowedRoots=@{}; foreach($t in @($TerminalChildren)){$allowedRoots[[int]$t.ProcessId]=$true}
    if(-not$result.guiBusy -and -not$result.guiLeased){
      foreach($p in $desc){
        $norm=([string]$p.CommandLine).Trim().ToLowerInvariant()
        if([string]$p.Name -ieq 'pwsh.exe' -and $norm.Contains('tools\gui-control.ps1 -server')){$allowedRoots[[int]$p.ProcessId]=$true}
      }
    }
    if(-not$result.browserActive -and -not$result.browserBusy -and -not$result.browserLeased -and -not$result.browserUncertain){
      foreach($p in $desc){
        $norm=([string]$p.CommandLine).Trim().ToLowerInvariant()
        if([string]$p.Name -ieq 'node.exe' -and $norm.Contains('tools\browser-control.mjs --server')){$allowedRoots[[int]$p.ProcessId]=$true}
      }
    }
    $unsafe=@()
    foreach($p in $desc){
      $processId=[int]$p.ProcessId
      $allowed=$allowedRoots.ContainsKey($processId)
      $cursor=$p;$guard=0
      while(-not $allowed -and $cursor -and $guard-lt64){
        $guard++;$parent=[int]$cursor.ParentProcessId
        if($allowedRoots.ContainsKey($parent)){$allowed=$true;break}
        if($parent-eq$backendPid){break}
        if($byId.ContainsKey($parent)){$cursor=$byId[$parent]}else{break}
      }
      $isDirectConhost=([string]$p.Name -ieq 'conhost.exe' -and [int]$p.ParentProcessId-eq$backendPid)
      if(-not($allowed -or $isDirectConhost)){$unsafe+=$p}
    }
    $result.unsafeDescendants=@($unsafe|Select-Object ProcessId,ParentProcessId,Name,CommandLine)
  }catch{$result.decision='DEFER_PROCESS_TREE';return [pscustomobject]$result}
  $result.decision=Get-StaleDrainDecision -ActiveOperations $result.activeOperations -Queued $result.queued -UnexpectedConnections $result.unexpectedConnections -UnsafeDescendants @($result.unsafeDescendants).Count -GuiBusy $result.guiBusy -GuiLeased $result.guiLeased
  $result.safe=($result.decision-eq'ALLOW')
  return [pscustomobject]$result
}
function Stop-StaleBackendTree([object]$OldActive,[int]$CanonicalPort){
  $first=Get-StaleDrainEvidence $OldActive $CanonicalPort
  if(-not $first.safe){return $false}
  Start-Sleep -Milliseconds 500
  $final=Get-StaleDrainEvidence $OldActive $CanonicalPort
  if(-not $final.safe){Log "DRAIN_STALE_RECHECK_DEFER version=$($OldActive.version) decision=$($final.decision)";return $false}
  foreach($p in @($final.safeDescendants)){Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue}
  Stop-OldBackend $OldActive
  return (-not(Test-OwnedOldBackend $OldActive))
}
function Retire-PreviousRoute([string]$RoutePath,[object]$OldActive,[string]$Profile){
  if(-not(Test-Path -LiteralPath $RoutePath -PathType Leaf)){return}
  $state=Read-Json $RoutePath
  if(-not $state.previous){return}
  if([int]$state.previous.port-ne[int]$OldActive.port -or [string]$state.previous.commit-ne[string]$OldActive.commit){throw "ROUTER_RETIRE_IDENTITY_MISMATCH profile=$Profile"}
  & node.exe (Join-Path $PSScriptRoot 'tools\router-retire.mjs') --state $RoutePath --expected-generation ([string]$state.generation) --profile $Profile --previous-port ([string]$OldActive.port) --previous-commit ([string]$OldActive.commit) | Out-Null
  if($LASTEXITCODE -ne 0){throw "ROUTER_RETIRE_FAIL profile=$Profile"}
  Log "ROUTER_PREVIOUS_RETIRED profile=$Profile port=$($OldActive.port) commit=$($OldActive.commit)"
}
function Get-DrainStatus([int]$CanonicalPort,[int]$OldPort){
  try{
    $st=Invoke-RestMethod "http://127.0.0.1:$CanonicalPort/router/status" -TimeoutSec 2
    $n=0
    if($st.inflightByPort.PSObject.Properties.Name -contains ([string]$OldPort)){$n=[int]$st.inflightByPort.([string]$OldPort)}
    $details=@()
    if($st.PSObject.Properties.Name -contains 'inflightDetailsByPort'){
      $groups=$st.inflightDetailsByPort
      if($groups -and $groups.PSObject.Properties.Name -contains ([string]$OldPort)){$details=@($groups.([string]$OldPort))}
    }
    $cancellableOnly=($n-gt 0 -and $details.Count-eq $n -and @($details|Where-Object{$_.cancellable-ne $true}).Count-eq 0)
    return [pscustomobject]@{ok=$true;count=$n;cancellableOnly=$cancellableOnly;details=$details}
  }catch{
    return [pscustomobject]@{ok=$false;count=-1;cancellableOnly=$false;details=@()}
  }
}
function Drain-Previous([object]$Target,[object]$OldActive){
  if(-not $OldActive){return $true}
  if(-not(Test-OwnedOldBackend $OldActive)){Retire-PreviousRoute $Target.RoutePath $OldActive $Target.Profile;return $true}
  $terminalChildren=@(Get-PersistentTerminalChildren $OldActive)
  if($terminalChildren.Count-gt0){
    Log "DRAIN_PERSISTENT_TERMINAL_DEFER profile=$($Target.Profile) pids=$(@($terminalChildren|ForEach-Object{[int]$_.ProcessId}) -join ',')"
    return $false
  }
  $deadline=(Get-Date).AddSeconds($DrainTimeoutSeconds)
  $last=[pscustomobject]@{ok=$false;count=-1;cancellableOnly=$false;details=@()}
  while((Get-Date)-lt $deadline){
    $last=Get-DrainStatus $Target.CanonicalPort ([int]$OldActive.port)
    if($last.ok -and $last.count-eq 0){
      Stop-OldBackend $OldActive
      if(-not(Test-OwnedOldBackend $OldActive)){Retire-PreviousRoute $Target.RoutePath $OldActive $Target.Profile;return $true}
    }
    Start-Sleep -Milliseconds 250
  }
  $last=Get-DrainStatus $Target.CanonicalPort ([int]$OldActive.port)
  if($last.ok -and $last.count-gt 0 -and $last.cancellableOnly){
    Log "DRAIN_CANCEL_SAFE profile=$($Target.Profile) inflight=$($last.count)"
    Stop-OldBackend $OldActive
    if(-not(Test-OwnedOldBackend $OldActive)){Retire-PreviousRoute $Target.RoutePath $OldActive $Target.Profile;return $true}
  }
  if($last.ok -and $last.count-gt 0){
    $legacy=Get-StaleDrainEvidence $OldActive $Target.CanonicalPort
    if($legacy.safe){
      Log "DRAIN_STALE_CONFIRMED profile=$($Target.Profile) version=$($OldActive.version) inflight=$($last.count)"
      if(Stop-StaleBackendTree $OldActive $Target.CanonicalPort){
        Retire-PreviousRoute $Target.RoutePath $OldActive $Target.Profile
        return $true
      }
    }else{
      Log "DRAIN_STALE_DEFER profile=$($Target.Profile) version=$($OldActive.version) decision=$($legacy.decision)"
    }
  }
  Log "DRAIN_DEFERRED profile=$($Target.Profile) inflight=$($last.count)"
  return $false
}
function Complete-DeferredDrains {
  $pending=@()
  foreach($rf in Get-ChildItem -LiteralPath $RoutingRoot -Filter '*.json' -File -ErrorAction SilentlyContinue){
    if($rf.Name -like '*.runtime.json'){continue}
    try{
      $route=Read-Json $rf.FullName
      $old=$route.previous
      if(-not $old){continue}
      if(-not(Test-OwnedOldBackend $old)){
        Retire-PreviousRoute $rf.FullName $old ([string]$route.profile)
        continue
      }
      $canonical=Get-CanonicalPortForProfile ([string]$route.profile)
      $terminalChildren=@(Get-PersistentTerminalChildren $old)
      if($terminalChildren.Count-gt0){
        if(Retain-PreviousBackend $rf.FullName $old ([string]$route.profile) $canonical $terminalChildren 'terminal'){continue}
        Log "DRAIN_PERSISTENT_TERMINAL_DEFER profile=$($route.profile) pids=$(@($terminalChildren|ForEach-Object{[int]$_.ProcessId}) -join ',')"
        $pending+=[string]$route.profile
        continue
      }
      $commandRoots=@(Get-RetainableLongCommandRoots $old $canonical)
      if($commandRoots.Count-gt0){
        if(Retain-PreviousBackend $rf.FullName $old ([string]$route.profile) $canonical $commandRoots 'command'){continue}
        Log "DRAIN_LONG_COMMAND_DEFER profile=$($route.profile) pids=$(@($commandRoots|ForEach-Object{[int]$_.ProcessId}) -join ',')"
        $pending+=[string]$route.profile
        continue
      }
      $st=Get-DrainStatus $canonical ([int]$old.port)
      if($st.ok -and ($st.count-eq 0 -or $st.cancellableOnly)){
        if($st.count-gt 0){Log "DRAIN_CANCEL_SAFE profile=$($route.profile) inflight=$($st.count)"}
        Stop-OldBackend $old
        if(-not(Test-OwnedOldBackend $old)){
          Retire-PreviousRoute $rf.FullName $old ([string]$route.profile)
          continue
        }
      }
      if($st.ok -and $st.count-gt 0){
        $legacy=Get-StaleDrainEvidence $old $canonical
        if($legacy.safe){
          Log "DRAIN_STALE_CONFIRMED profile=$($route.profile) version=$($old.version) inflight=$($st.count)"
          if(Stop-StaleBackendTree $old $canonical){
            Retire-PreviousRoute $rf.FullName $old ([string]$route.profile)
            continue
          }
        }else{
          Log "DRAIN_STALE_DEFER profile=$($route.profile) version=$($old.version) decision=$($legacy.decision)"
        }
      }
      $pending+=[string]$route.profile
    }catch{
      Log "DRAIN_RECHECK_WARN profile=$($rf.BaseName) $($_.Exception.Message)"
      $pending+=[string]$rf.BaseName
    }
  }
  return @($pending)
}
function Has-SupersededRelease {
  $protected=Get-ProtectedReleasePaths
  foreach($dir in Get-ChildItem -LiteralPath $ReleaseRoot -Directory -ErrorAction SilentlyContinue){
    $key=[IO.Path]::GetFullPath($dir.FullName).ToLowerInvariant()
    if(-not $protected.ContainsKey($key)){return $true}
  }
  return $false
}
function Promote-Control([string]$Commit,[string]$Ref){
  $dirty=& git.exe -C $InstallDir status --porcelain --untracked-files=no
  if($LASTEXITCODE-ne 0){throw 'CONTROL_GIT_STATUS_FAIL'}
  if($dirty){
    & git.exe -C $InstallDir diff --cached --quiet --
    if($LASTEXITCODE-ne 0){throw 'CONTROL_TRACKED_DIRTY'}
    & git.exe -C $InstallDir diff --ignore-space-at-eol --exit-code -- | Out-Null
    if($LASTEXITCODE-ne 0){throw 'CONTROL_TRACKED_DIRTY'}
    Log 'CONTROL_TRACKED_EOL_DRIFT_ACCEPTED'
  }
  & git.exe -C $InstallDir fetch --no-tags origin $Ref
  if($LASTEXITCODE-ne 0){throw 'CONTROL_FETCH_FAIL'}
  $resolved=(& git.exe -C $InstallDir rev-parse 'FETCH_HEAD^{commit}').Trim().ToLowerInvariant()
  if($resolved-ne $Commit){throw 'CONTROL_COMMIT_MISMATCH'}
  & git.exe -C $InstallDir checkout --detach --force $Commit | Out-Null
  if($LASTEXITCODE-ne 0){throw 'CONTROL_CHECKOUT_FAIL'}
}
function Recycle-ControlSupervisor {
  $runKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $runValue=(Get-ItemProperty -Path $runKey -Name 'ChatGPTRemoteCommander' -ErrorAction SilentlyContinue).ChatGPTRemoteCommander
  $rootPattern=[regex]::Escape($InstallDir)
  $existing=@(Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match 'autostart-windows\.ps1' -and $_.CommandLine -match $rootPattern })
  if(-not $runValue -and $existing.Count -eq 0){return}
  foreach($proc in $existing){
    try{Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop;Log "SUPERVISOR_RECYCLE_STOP pid=$($proc.ProcessId)"}catch{Log "SUPERVISOR_RECYCLE_STOP_WARN pid=$($proc.ProcessId) $($_.Exception.Message)"}
  }
  $script=Join-Path $InstallDir 'autostart-windows.ps1'
  if(-not(Test-Path -LiteralPath $script -PathType Leaf)){throw 'SUPERVISOR_SCRIPT_MISSING_AFTER_PROMOTION'}
  $pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source
  $proc=Start-Process -FilePath $pwsh -ArgumentList @('-NoLogo','-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$script) -WindowStyle Hidden -PassThru
  foreach($i in 1..40){
    Start-Sleep -Milliseconds 250
    if(-not $proc.HasExited){
      try{
        $h=Invoke-RestMethod 'http://127.0.0.1:47831/health' -TimeoutSec 1
        if($h.ok){Log "SUPERVISOR_RECYCLE_PASS pid=$($proc.Id)";return}
      }catch{}
    }else{break}
  }
  throw 'SUPERVISOR_RECYCLE_FAIL'
}

function Get-ReleaseCleanupLockEvidence([string]$ReleasePath){
  $full=[IO.Path]::GetFullPath($ReleasePath)
  $rows=@()
  try{
    foreach($p in @(Get-CimInstance Win32_Process -ErrorAction Stop)){
      $exe=[string]$p.ExecutablePath;$cmd=[string]$p.CommandLine
      $match=($exe -and $exe.StartsWith($full,[StringComparison]::OrdinalIgnoreCase)) -or
        ($cmd -and $cmd.IndexOf($full,[StringComparison]::OrdinalIgnoreCase)-ge0)
      if($match){
        $rows += [pscustomobject]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;name=[string]$p.Name;executable=$exe}
      }
      if($rows.Count-ge20){break}
    }
  }catch{throw 'RELEASE_PROCESS_ENUMERATION_UNVERIFIED'}
  return @($rows)
}
function Cleanup-Releases {
  $protected=Get-ProtectedReleasePaths
  $remaining=@()
  foreach($d in Get-ChildItem -LiteralPath $ReleaseRoot -Directory -ErrorAction SilentlyContinue){
    $key=[IO.Path]::GetFullPath($d.FullName).ToLowerInvariant()
    if($protected.ContainsKey($key)){continue}
    # R205: preserve any directory lacking exact post-acceptance proof.
    $retireGuard=Join-Path $InstallDir 'tools\release-retirement-gate-r205.mjs'
    if(-not(Test-Path -LiteralPath $retireGuard -PathType Leaf)){
      Log "RELEASE_RETIRE_DEFER name=$($d.Name) reason=GUARD_NOT_INSTALLED"
      $remaining+=$d.Name;continue
    }
    try{
      $owners=@(Get-ReleaseCleanupLockEvidence $d.FullName)
      if($owners.Count-gt0){
        Log "RELEASE_RETIRE_DEFER name=$($d.Name) reason=OWNED_PROCESS_RUNNING"
        $remaining+=$d.Name;continue
      }
      $args=@('--state-root',$StateRoot,'--release-root',$ReleaseRoot,'--candidate',$d.FullName,'--install-dir',$InstallDir)
      $lines=@(& node.exe $retireGuard @args 2>&1)
      $exit=[int]$LASTEXITCODE
      $json=if($lines.Count){[string]$lines[-1]}else{''}
      if($exit-ne0){
        Log "RELEASE_RETIRE_DEFER name=$($d.Name) reason=GUARD_REJECTED evidence=$json"
        $remaining+=$d.Name;continue
      }
      $gate=$json|ConvertFrom-Json
      if($gate.status-ne'ALLOW' -or [string]$gate.candidateName-ne[string]$d.Name){
        Log "RELEASE_RETIRE_DEFER name=$($d.Name) reason=INVALID_GUARD_RESULT"
        $remaining+=$d.Name;continue
      }
      Log "RELEASE_RETIRE_AUTHORIZED name=$($d.Name) commit=$($gate.candidateHead)"
    }catch{
      Log "RELEASE_RETIRE_DEFER name=$($d.Name) reason=GUARD_OR_PROCESS_EVIDENCE_UNVERIFIED"
      $remaining+=$d.Name;continue
    }
    $removed=$false;$lastError=''
    foreach($attempt in 1..3){
      try{
        Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction Stop
        Log "RELEASE_CLEANUP_PASS name=$($d.Name) attempt=$attempt"
        $removed=$true;break
      }catch{
        $lastError=$_.Exception.Message
        if($attempt-lt3){Start-Sleep -Milliseconds (250*$attempt)}
      }
    }
    if($removed){continue}
    $remaining+=$d.Name
    $evidence=@(Get-ReleaseCleanupLockEvidence $d.FullName)
    if($evidence.Count){
      $owners=@($evidence|ForEach-Object{"$($_.pid):$($_.name)"}) -join ','
      Log "RELEASE_CLEANUP_LOCK_EVIDENCE name=$($d.Name) owners=$owners"
    }else{
      Log "RELEASE_CLEANUP_LOCK_EVIDENCE name=$($d.Name) owners=UNVERIFIED"
    }
    Log "RELEASE_CLEANUP_DEFER name=$($d.Name) attempts=3 error=$lastError"
  }
  return @($remaining)
}
if($SelfTest){
  [pscustomobject]@{ok=$true;installDir=$InstallDir;stateRoot=$StateRoot;releaseRoot=$ReleaseRoot;routingRoot=$RoutingRoot}|ConvertTo-Json -Compress
  exit 0
}

$created=$false
$mutex=[Threading.Mutex]::new($false,'Local\ChatGPTRemoteCommanderAutoUpdater',[ref]$created)
if(-not $created){Log 'AUTO_UPDATE_ALREADY_RUNNING';exit 0}

$candidates=@();$currentCandidate=$null;$routeBackups=@{};$initialDirect=@{};$cutoverCommitted=$false;$report=[ordered]@{startedAt=(Get-Date).ToUniversalTime().ToString('o');status='RUNNING';gates=@();profiles=@()}
try{
  $primaryConfig=Read-Json (Get-PrimaryConfig)
  if(-not $Force -and $primaryConfig.autoUpdate.enabled-ne $true){Log 'AUTO_UPDATE_DISABLED';$report.status='DISABLED';Atomic-Json $ResultFile $report;exit 0}
  $ref=Get-LatestTag
  $stage=Stage-Release $ref
  $report.ref=$ref;$report.commit=$stage.Commit;$report.version=$stage.Version
  $script:QualificationCommit=$stage.Commit
  # R-fleet: An accepted newer route is a durable version authority even when
  # the canonical MCP is temporarily unavailable during a restart. An unattended
  # Stable check must not silently replace a newer approved preview with Stable.
  # An explicit -Force remains the deliberate rollback escape hatch.
  if(-not $Force){
    $persistedRoutePath=Get-RoutePath 'default'
    if(Test-Path -LiteralPath $persistedRoutePath -PathType Leaf){
      $persistedRoute=Read-Json $persistedRoutePath
      $persistedVersion=[string]$persistedRoute.active.version
      if(-not $persistedVersion){throw 'AUTO_UPDATE_PERSISTED_ROUTE_VERSION_MISSING'}
      if(Test-VersionGreater $persistedVersion $stage.Version){
        $report.status='NEWER_CURRENT'
        $report.currentVersion=$persistedVersion
        $report.authoritySource='PERSISTED_ROUTE'
        $report.completedAt=(Get-Date).ToUniversalTime().ToString('o')
        Atomic-Json $ResultFile $report
        Log "AUTO_UPDATE_NEWER_PERSISTED_ROUTE current=$persistedVersion target=$($stage.Version)"
        exit 0
      }
    }
  }
  $currentStatus=$null
  try{$currentStatus=Invoke-Mcp 47831 'system_status'}catch{}
  if(-not $Force -and $currentStatus -and (Test-VersionGreater ([string]$currentStatus.version) $stage.Version)){
    $report.status='NEWER_CURRENT';$report.currentVersion=[string]$currentStatus.version;$report.completedAt=(Get-Date).ToUniversalTime().ToString('o')
    Atomic-Json $ResultFile $report
    Log "AUTO_UPDATE_NEWER_CURRENT current=$($currentStatus.version) latest=$($stage.Version)"
    exit 0
  }
  if(-not $Force -and $currentStatus -and [string]$currentStatus.version-eq $stage.Version){
    $route=Get-RoutePath 'default'
    $controlHead=''
    try{$controlHead=(& git.exe -C $InstallDir rev-parse HEAD).Trim().ToLowerInvariant()}catch{}
    if(-not(Test-Path $route) -and $controlHead-eq $stage.Commit){
      Complete-RetainedBackends
      $report.status='CURRENT';$report.currentVersion=[string]$currentStatus.version;$report.completedAt=(Get-Date).ToUniversalTime().ToString('o')
      Atomic-Json $ResultFile $report
      Log "AUTO_UPDATE_CURRENT direct=true commit=$controlHead version=$($currentStatus.version)"
      exit 0
    }
    if(Test-Path $route){
      $rs=Read-Json $route
      if([string]$rs.active.commit-eq $stage.Commit){
        $controlHead=''
        try{$controlHead=(& git.exe -C $InstallDir rev-parse HEAD).Trim().ToLowerInvariant()}catch{}
        Complete-RetainedBackends
        $pendingDrains=@(Complete-DeferredDrains)
        if($pendingDrains.Count-gt 0){
          if($controlHead-ne $stage.Commit){
            Log "AUTO_UPDATE_MAINTENANCE controlHead=$controlHead target=$($stage.Commit)"
            Promote-Control $stage.Commit $ref
          }
          $report.status='DRAIN_PENDING';$report.pendingDrains=@($pendingDrains);$report.completedAt=(Get-Date).ToUniversalTime().ToString('o')
          Atomic-Json $ResultFile $report
          Log "AUTO_UPDATE_DRAIN_PENDING profiles=$($pendingDrains -join ',')"
          exit 0
        }
        $controlMismatch=($controlHead-ne $stage.Commit)
        if($controlMismatch){
          Log "AUTO_UPDATE_MAINTENANCE controlHead=$controlHead target=$($stage.Commit)"
          foreach($rf in Get-ChildItem -LiteralPath $RoutingRoot -Filter '*.json' -File -ErrorAction SilentlyContinue){
            if($rf.Name -like '*.runtime.json'){continue}
            try{
              $rr=Read-Json $rf.FullName
              $cfg=Read-Json ([string]$rr.active.configPath)
              $wfDir=[string]$cfg.durableWorkflows.directory
              if($wfDir){
                & node.exe (Join-Path $stage.Dir 'tools\finalize-workflow-schema.mjs') --directory $wfDir
                if($LASTEXITCODE-ne 0){throw "MAINTENANCE_SCHEMA_FINALIZE_FAIL profile=$($rr.profile)"}
              }
            }catch{throw}
          }
          Promote-Control $stage.Commit $ref
          Recycle-ControlSupervisor
          $cleanupPending=@(Cleanup-Releases)
          $report.status=if($cleanupPending.Count-gt0){'MAINTENANCE_REPAIRED_CLEANUP_PENDING'}else{'MAINTENANCE_REPAIRED'}
          $report.cleanupPending=@($cleanupPending)
          $report.completedAt=(Get-Date).ToUniversalTime().ToString('o')
          Atomic-Json $ResultFile $report
          Log "AUTO_UPDATE_MAINTENANCE_PASS version=$($stage.Version) cleanupPending=$($cleanupPending.Count)"
          exit 0
        }
        $cleanupPending=@(Cleanup-Releases)
        if($cleanupPending.Count-gt0){
          $report.status='CLEANUP_PENDING';$report.cleanupPending=@($cleanupPending);$report.completedAt=(Get-Date).ToUniversalTime().ToString('o')
          Atomic-Json $ResultFile $report
          Log "AUTO_UPDATE_CLEANUP_PENDING releases=$($cleanupPending -join ',')"
          exit 0
        }
        Log "AUTO_UPDATE_CURRENT version=$($stage.Version)"
        $report.status='CURRENT';$report.completedAt=(Get-Date).ToUniversalTime().ToString('o');Atomic-Json $ResultFile $report;exit 0
      }
    }
  }

  $backoff=Get-ActiveQualificationBackoff $stage.Commit
  if($backoff){
    $report.status='QUALIFICATION_BACKOFF'
    $report.qualificationBackoff=$backoff
    $report.completedAt=(Get-Date).ToUniversalTime().ToString('o')
    Atomic-Json $ResultFile $report
    Log "AUTO_UPDATE_QUALIFICATION_BACKOFF commit=$($stage.Commit) gate=$($backoff.gate) count=$($backoff.count) nextRetryAt=$($backoff.nextRetryAt)"
    exit 0
  }

  Push-Location $stage.Dir
  try{
    Run-Gate $stage.Dir 'check' @('run','check:qualification')
    Run-Gate $stage.Dir 'test' @('run','test:qualification')
    Run-Gate $stage.Dir 'audit' @('run','audit')
    Ensure-ProjectProvider (Get-PrimaryConfig)
    if($primaryConfig.powerMode.enabled-eq $true -and $primaryConfig.powerMode.guiControl.enabled-eq $true){
      # Unattended updates must not steal desktop focus. Full interactive GUI E2E
      # remains a release gate; candidate hardware validation later requires gui_status.
      Run-GuiNativeSelfTest $stage.Dir
    }
  }finally{Pop-Location}
  Clear-QualificationFailure $stage.Commit

  $targets=Get-Targets
  $used=[System.Collections.Generic.HashSet[int]]::new()
  foreach($t in $targets){[void]$used.Add([int]$t.CanonicalPort)}
  if(Test-Path $ProfileDir){
    foreach($f in Get-ChildItem $ProfileDir -Filter '*.yaml' -File -ErrorAction SilentlyContinue){
      $raw=Get-Content $f.FullName -Raw
      foreach($rx in @('listen_addr:\s*["'']?127\.0\.0\.1:(\d+)','url:\s*["'']?http://127\.0\.0\.1:(\d+)/mcp')){
        $m=[regex]::Match($raw,$rx);if($m.Success){[void]$used.Add([int]$m.Groups[1].Value)}
      }
    }
  }
  $device=if($currentStatus){[string]$currentStatus.deviceName}else{$env:COMPUTERNAME}
  $explicitProfileMutation=[bool]($Force -or $PowerMode -or $StandardMode -or $GuiControl -or $DisableGuiControl -or @($DisableCapability).Count-gt0 -or @($EnableCapability).Count-gt0)
  foreach($t in $targets){
    if(-not $explicitProfileMutation -and (Test-Path -LiteralPath $t.RoutePath -PathType Leaf)){
      try{
        $liveRoute=Read-Json $t.RoutePath
        if($liveRoute.active -and [string]$liveRoute.active.commit-eq[string]$stage.Commit -and -not $liveRoute.previous){
          Log "AUTO_UPDATE_PROFILE_CURRENT_SKIP profile=$($t.Profile) commit=$($stage.Commit)"
          continue
        }
      }catch{throw "PROFILE_CURRENT_CHECK_FAIL profile=$($t.Profile) $($_.Exception.Message)"}
    }
    $port=Get-FreePort $used
    $runtimeLeaf="port-$port"
    $stateDir=Join-Path $RuntimeRoot (Join-Path $stage.Commit (Join-Path $t.Profile $runtimeLeaf))
    New-Item -ItemType Directory -Force -Path $stateDir|Out-Null
    $existingPolicy=Read-Json $t.ExistingConfig
    $liveWorkflowDir=[string]$existingPolicy.durableWorkflows.directory
    $backupDir=Join-Path $StateRoot (Join-Path 'update-backups' (Join-Path $stage.Commit (Join-Path $t.Profile $runtimeLeaf)))
    $shadowWorkflowDir=Join-Path $backupDir 'workflow-shadow'
    New-Item -ItemType Directory -Force -Path $backupDir|Out-Null
    Copy-Item -LiteralPath $t.ExistingConfig -Destination (Join-Path $backupDir 'config.before.json') -Force
    if($liveWorkflowDir){
      & node.exe (Join-Path $stage.Dir 'tools\copy-workflow-store.mjs') --source-dir $liveWorkflowDir --dest-dir $shadowWorkflowDir
      if($LASTEXITCODE-ne 0){throw "WORKFLOW_SHADOW_COPY_FAIL profile=$($t.Profile)"}
    }

    $cfg=Join-Path $stateDir 'diagnostic-config.json'
    $buildArgs=@((Join-Path $stage.Dir 'tools\build-candidate-config.mjs'),'--default',(Join-Path $stage.Dir 'config.json'),'--existing',$t.ExistingConfig,'--output',$cfg,'--profile-id',$t.Profile,'--port',[string]$port,'--state-dir',$stateDir,'--workflow-dir',$shadowWorkflowDir,'--provider-root',$StateRoot)
    if($PowerMode){$buildArgs+=@('--mode','full')}elseif($StandardMode){$buildArgs+=@('--mode','standard')}else{$buildArgs+=@('--mode','preserve')}
    if($GuiControl){$buildArgs+=@('--gui','on')}elseif($DisableGuiControl){$buildArgs+=@('--gui','off')}
    foreach($cap in $DisableCapability){$buildArgs+=@('--disable-capability',$cap)}
    foreach($cap in $EnableCapability){$buildArgs+=@('--enable-capability',$cap)}
    & node.exe @buildArgs
    if($LASTEXITCODE-ne 0){throw "CANDIDATE_CONFIG_FAIL profile=$($t.Profile)"}
    $sha=(Get-FileHash -LiteralPath $cfg -Algorithm SHA256).Hash.ToLowerInvariant()
    $p=Start-Backend $stage.Dir $cfg $stateDir
    $currentCandidate=[pscustomobject]@{Profile=$t.Profile;Port=$port;Process=$p;ConfigPath=$cfg}
    $h=Wait-Health $port $stage.Version $sha $t.Profile
    & node.exe (Join-Path $stage.Dir 'tools\doctor.mjs') --url "http://127.0.0.1:$port/mcp" --expected-device $device --expected-version $stage.Version --config $cfg --json
    if($LASTEXITCODE-ne 0){throw "CANDIDATE_DOCTOR_FAIL profile=$($t.Profile)"}
    $status=Invoke-Mcp $port 'system_status'
    $expected=Read-Json $cfg
    if($expected.capabilityProfile.tier-eq 'FULL_POWER'){
      if($status.capabilityProfile.tier-ne 'FULL_POWER' -or $status.capabilityProfile.autoEnableNewCapabilities-ne $true){throw "FULL_POWER_PROFILE_FAIL profile=$($t.Profile)"}
      $disabled=@($expected.capabilityProfile.disabledCapabilities)
      if(-not($disabled -contains 'filesystem.full') -and $status.powerMode.fullFilesystem-ne $true){throw 'FULL_POWER_FILESYSTEM_FAIL'}
      if(-not($disabled -contains 'shell.execute') -and $status.powerMode.allowShell-ne $true){throw 'FULL_POWER_SHELL_FAIL'}
      if(-not($disabled -contains 'process.control') -and $status.powerMode.allowProcessControl-ne $true){throw 'FULL_POWER_PROCESS_FAIL'}
      if(-not($disabled -contains 'filesystem.permanent_delete') -and $status.powerMode.allowPermanentDelete-ne $true){throw 'FULL_POWER_DELETE_FAIL'}
      [void](Invoke-Mcp $port 'file_info' @{path=$env:TEMP})
      [void](Invoke-Mcp $port 'system_info')
      [void](Invoke-Mcp $port 'list_processes')
      if(-not($disabled -contains 'shell.execute')){
        $shell=Invoke-Mcp $port 'run_shell' @{requestId=("autoupdate-shell-{0}-{1}" -f $t.Profile,$port);command='Write-Output RC_AUTOUPDATE_SHELL_PASS';timeoutMs=10000}
        if([string]$shell.stdout -notmatch 'RC_AUTOUPDATE_SHELL_PASS'){throw 'FULL_POWER_SHELL_E2E_FAIL'}
      }
      if($expected.powerMode.guiControl.enabled-eq $true){
        if($status.guiControl.backendSupported-ne $true -or $status.guiControl.enabled-ne $true){throw "GUI_POLICY_STATUS_FAIL profile=$($t.Profile)"}
      }
    }
    if($expected.durableWorkflows.enabled-eq $true){
      $wf=Invoke-Mcp $port 'workflow_health'
      if($wf.ok-ne $true -or [string]$wf.databaseIntegrity-ne 'ok'){throw "WORKFLOW_HEALTH_FAIL profile=$($t.Profile)"}
    }

    # Diagnostic backend passed on a shadow store. Rebuild against the live durable
    # store while its DB is still v1-compatible, then run identity/doctor once more.
    Stop-OwnedCandidate $currentCandidate -Strict
    $currentCandidate=$null
    foreach($i in 1..40){Start-Sleep -Milliseconds 100;if(-not(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)){break}}
    $finalCfg=Join-Path $stateDir 'config.json'
    $finalArgs=@((Join-Path $stage.Dir 'tools\build-candidate-config.mjs'),'--default',(Join-Path $stage.Dir 'config.json'),'--existing',$t.ExistingConfig,'--output',$finalCfg,'--profile-id',$t.Profile,'--port',[string]$port,'--state-dir',$stateDir,'--provider-root',$StateRoot)
    if($liveWorkflowDir){$finalArgs+=@('--workflow-dir',$liveWorkflowDir)}
    if($PowerMode){$finalArgs+=@('--mode','full')}elseif($StandardMode){$finalArgs+=@('--mode','standard')}else{$finalArgs+=@('--mode','preserve')}
    if($GuiControl){$finalArgs+=@('--gui','on')}elseif($DisableGuiControl){$finalArgs+=@('--gui','off')}
    foreach($cap in $DisableCapability){$finalArgs+=@('--disable-capability',$cap)}
    foreach($cap in $EnableCapability){$finalArgs+=@('--enable-capability',$cap)}
    & node.exe @finalArgs
    if($LASTEXITCODE-ne 0){throw "FINAL_CONFIG_FAIL profile=$($t.Profile)"}
    $finalSha=(Get-FileHash -LiteralPath $finalCfg -Algorithm SHA256).Hash.ToLowerInvariant()
    $p=Start-Backend $stage.Dir $finalCfg $stateDir
    $currentCandidate=[pscustomobject]@{Profile=$t.Profile;Port=$port;Process=$p;ConfigPath=$finalCfg}
    [void](Wait-Health $port $stage.Version $finalSha $t.Profile)
    & node.exe (Join-Path $stage.Dir 'tools\doctor.mjs') --url "http://127.0.0.1:$port/mcp" --expected-device $device --expected-version $stage.Version --config $finalCfg --json
    if($LASTEXITCODE-ne 0){throw "FINAL_CANDIDATE_DOCTOR_FAIL profile=$($t.Profile)"}
    if((Read-Json $finalCfg).durableWorkflows.enabled-eq $true){
      $wf=Invoke-Mcp $port 'workflow_health'
      if($wf.ok-ne $true -or [string]$wf.databaseIntegrity-ne 'ok'){throw "FINAL_WORKFLOW_HEALTH_FAIL profile=$($t.Profile)"}
    }
    $c=[pscustomobject]@{Profile=$t.Profile;CanonicalPort=$t.CanonicalPort;Port=$port;Version=$stage.Version;Commit=$stage.Commit;ConfigSha=$finalSha;ConfigPath=$finalCfg;ProjectDir=$stage.Dir;Process=$p;Target=$t;WorkflowDir=$liveWorkflowDir;BackupDir=$backupDir}
    $candidates+=$c
    $currentCandidate=$null
    $report.profiles+=@{profile=$t.Profile;candidatePort=$port;configSha256=$finalSha;doctor='PASS';hardware='PASS';shadowStore='PASS';liveStoreCompatibility='PASS'}
  }

  if($NoPromote){
    foreach($c in $candidates){Stop-OwnedCandidate $c -Strict}
    $report.status='CANDIDATE_PASS';$report.completedAt=(Get-Date).ToUniversalTime().ToString('o')
    Atomic-Json $ResultFile $report
    Log 'AUTO_UPDATE_CANDIDATE_PASS'
    exit 0
  }

  $routerBootstrapDeferred=@()
  foreach($c in $candidates){
    $t=$c.Target
    if(-not(Test-Path -LiteralPath $t.RoutePath -PathType Leaf)){continue}
    $liveRoute=Read-Json $t.RoutePath
    if(-not($liveRoute.active -and $liveRoute.active.port)){continue}
    $pre=Get-SchemaContinuityProbe $stage.Dir ([int]$liveRoute.active.port) ([int]$c.Port) ([int]$t.CanonicalPort)
    $bootstrap=Ensure-RouterCandidateSource $t $stage.Dir
    if($bootstrap.changed -eq $true -and $pre.changed -eq $true){
      $routerBootstrapDeferred+=[string]$t.Profile
      continue
    }
    $gate=Get-SchemaContinuityProbe $stage.Dir ([int]$liveRoute.active.port) ([int]$c.Port) ([int]$t.CanonicalPort)
    if(-not $gate.ok){throw "SCHEMA_CONTINUITY_GATE_FAIL profile=$($t.Profile) decision=$($gate.decision)"}
    Log "SCHEMA_CONTINUITY_GATE_PASS profile=$($t.Profile) decision=$($gate.decision)"
  }
  if($routerBootstrapDeferred.Count-gt0){
    foreach($c in $candidates){Stop-OwnedCandidate $c -Strict}
    $report.status='ROUTER_BOOTSTRAPPED_RETRY_REQUIRED'
    $report.routerBootstrapProfiles=@($routerBootstrapDeferred)
    $report.completedAt=(Get-Date).ToUniversalTime().ToString('o')
    Atomic-Json $ResultFile $report
    Log "AUTO_UPDATE_ROUTER_BOOTSTRAPPED_RETRY_REQUIRED profiles=$($routerBootstrapDeferred -join ',')"
    exit 0
  }
  # Admission is profile-scoped. One account may have a legitimate long-lived
  # previous backend while another account is safe to promote independently.
  $deferredProfiles=@()
  Complete-RetainedBackends
  $existingDrainBlocks=@(Complete-DeferredDrains)
  if($existingDrainBlocks.Count-gt0){
    foreach($profile in $existingDrainBlocks){
      foreach($c in @($candidates|Where-Object{$_.Profile-eq$profile})){Stop-OwnedCandidate $c -Strict}
      if(-not($deferredProfiles -contains [string]$profile)){$deferredProfiles+=[string]$profile}
    }
    $candidates=@($candidates|Where-Object{$deferredProfiles -notcontains [string]$_.Profile})
    $report.pendingDrains=@($existingDrainBlocks)
    Log "AUTO_UPDATE_EXISTING_DRAIN_DEFER profiles=$($existingDrainBlocks -join ',')"
    if($candidates.Count-eq0){
      $report.status='BLOCKED_EXISTING_DRAIN'
      $report.completedAt=(Get-Date).ToUniversalTime().ToString('o')
      Atomic-Json $ResultFile $report
      Log "AUTO_UPDATE_EXISTING_DRAIN_BLOCK profiles=$($existingDrainBlocks -join ',')"
      exit 0
    }
  }

  $terminalPreserve=@()
  foreach($c in $candidates){
    $t=$c.Target
    if(-not(Test-Path -LiteralPath $t.RoutePath -PathType Leaf)){continue}
    $liveRoute=Read-Json $t.RoutePath
    if(-not $liveRoute.active){continue}
    $terms=@(Get-PersistentTerminalChildren $liveRoute.active)
    if($terms.Count-gt0){
      $terminalPreserve+=[pscustomobject]@{profile=$t.Profile;pids=@($terms|ForEach-Object{[int]$_.ProcessId})}
      Log "AUTO_UPDATE_ACTIVE_TERMINALS_PRESERVE profile=$($t.Profile) pids=$(@($terms|ForEach-Object{[int]$_.ProcessId}) -join ',')"
    }
  }
  if($terminalPreserve.Count-gt0){$report.terminalPreserve=@($terminalPreserve)}

  foreach($c in $candidates){
    $t=$c.Target
    if(Test-Path $t.RoutePath){
      $routeBackups[$t.Profile]=Get-Content -LiteralPath $t.RoutePath -Raw
      Switch-Route $t $c
    }else{
      $initialDirect[$t.Profile]=Stop-OwnedDirect $t
      Write-InitialRoute $t $c
      [void](Start-Router $t.CanonicalPort $t.RoutePath (Join-Path $stage.Dir 'src\stable-router.mjs') $t.Profile)
    }
  }

  foreach($c in $candidates){Verify-Canonical $c.Target $c}
  Verify-Tunnels
  $cutoverCommitted=$true
  $report.cutoverCommittedAt=(Get-Date).ToUniversalTime().ToString('o')

  $pendingDrains=@()
  foreach($c in $candidates){
    if($routeBackups.ContainsKey($c.Profile)){
      $old=($routeBackups[$c.Profile]|ConvertFrom-Json).active
      if(-not(Drain-Previous $c.Target $old)){$pendingDrains+=[string]$c.Profile}
    }
  }
  if($pendingDrains.Count-gt 0 -or $deferredProfiles.Count-gt 0){
    Promote-Control $stage.Commit $ref
    $allPending=@($pendingDrains)+@($deferredProfiles)|Select-Object -Unique
    $report.pendingDrains=@($allPending)
    $report.deferredProfiles=@($deferredProfiles)
    $report.status=if($deferredProfiles.Count-gt0){'PROMOTED_PARTIAL'}else{'PROMOTED_DRAIN_PENDING'}
    $report.completedAt=(Get-Date).ToUniversalTime().ToString('o')
    Atomic-Json $ResultFile $report
    if($deferredProfiles.Count-gt0){Log "AUTO_UPDATE_PROFILE_DEFER profiles=$($deferredProfiles -join ',')"}
    if($pendingDrains.Count-gt0){Log "AUTO_UPDATE_DRAIN_PENDING profiles=$($pendingDrains -join ',')"}
    exit 0
  }

  foreach($c in $candidates){
    if($c.WorkflowDir){
      & node.exe (Join-Path $stage.Dir 'tools\finalize-workflow-schema.mjs') --directory $c.WorkflowDir
      if($LASTEXITCODE-ne 0){throw "WORKFLOW_SCHEMA_FINALIZE_FAIL profile=$($c.Profile)"}
      $wf=Invoke-Mcp $c.CanonicalPort 'workflow_health'
      if([int]$wf.databaseSchemaVersion-ne 2){throw "WORKFLOW_SCHEMA_FINALIZE_VERIFY_FAIL profile=$($c.Profile)"}
    }
  }

  Promote-Control $stage.Commit $ref
  Recycle-ControlSupervisor
  Cleanup-Releases
  $report.status='PROMOTED';$report.completedAt=(Get-Date).ToUniversalTime().ToString('o')
  Atomic-Json $ResultFile $report
  Log "AUTO_UPDATE_PASS version=$($stage.Version) commit=$($stage.Commit)"
}catch{
  $report.status='FAILED';$report.error=$_.Exception.Message;$report.completedAt=(Get-Date).ToUniversalTime().ToString('o')
  try{Atomic-Json $ResultFile $report}catch{}
  Log "AUTO_UPDATE_FAIL $($_.Exception.Message)"
  if(-not $cutoverCommitted){
    try{Stop-OwnedCandidate $currentCandidate}catch{}
    foreach($c in $candidates){try{Stop-OwnedCandidate $c}catch{}}
    foreach($profile in @($routeBackups.Keys)){
      try{[IO.File]::WriteAllText((Get-RoutePath $profile),[string]$routeBackups[$profile],[Text.UTF8Encoding]::new($false))}catch{}
    }
  }else{
    $report.status='PROMOTED_MAINTENANCE_REQUIRED'
    try{Atomic-Json $ResultFile $report}catch{}
    Log 'AUTO_UPDATE_POST_COMMIT_MAINTENANCE_REQUIRED'
  }
  throw
}finally{
  try{$mutex.ReleaseMutex()}catch{}
  $mutex.Dispose()
}
