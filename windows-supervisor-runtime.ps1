. (Join-Path $PSScriptRoot 'machine-credential-trust.ps1')
. (Join-Path $PSScriptRoot 'machine-runtime-trust.ps1')

function Initialize-WindowsSupervisorRuntime(
  [string]$Root,
  [string]$OwnerUserProfile,
  [bool]$BootCore,
  [string]$CredentialScope = 'CurrentUser'
) {
  if ([string]::IsNullOrWhiteSpace($OwnerUserProfile)) { $OwnerUserProfile = $env:USERPROFILE }
  $OwnerUserProfile = [IO.Path]::GetFullPath($OwnerUserProfile)
  $local = Join-Path $OwnerUserProfile 'AppData\Local'
  $roaming = Join-Path $OwnerUserProfile 'AppData\Roaming'
  $machineRuntime = $null
  if ($BootCore) {
    $requiredRoot=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)) 'ChatGPTRemoteCommander\machine-app'
    if([IO.Path]::GetFullPath($Root).TrimEnd('\') -ine [IO.Path]::GetFullPath($requiredRoot).TrimEnd('\')){
      throw 'BOOT_RECOVERY_MACHINE_APP_ROOT_REQUIRED'
    }
    $machineRuntime = Assert-RcMachineRuntimeStore
    $env:USERPROFILE = $machineRuntime
    $env:LOCALAPPDATA = Join-Path $machineRuntime 'local'
    $env:APPDATA = $machineRuntime
    $env:HOME = $machineRuntime
  } else {
    $env:USERPROFILE = $OwnerUserProfile
    $env:LOCALAPPDATA = $local
    $env:APPDATA = $roaming
    $env:HOME = $OwnerUserProfile
  }
  $credentials = Join-Path $local 'ChatGPTRemoteCommander\credentials'
  if($BootCore){
    if($CredentialScope -ne 'LocalMachine'){
      throw 'BOOT_RECOVERY_MACHINE_CREDENTIAL_SCOPE_REQUIRED'
    }
    # Machine-scope credential blobs are never read from owner-writable
    # ancestors. Verify every entry's ACL and refuse missing/unsafe roots.
    . (Join-Path $Root 'machine-credential-trust.ps1')
    $credentials = Assert-RcMachineCredentialStore
  }
  return [pscustomobject]@{
    OwnerUserProfile=$OwnerUserProfile
    MachineRuntimeRoot=$machineRuntime
    CredDir=$credentials
    ProfileDir=$(if($BootCore){Join-Path $machineRuntime 'profiles'}else{Join-Path $roaming 'tunnel-client'})
    InstanceRoot=$(if($BootCore){Join-Path $machineRuntime 'instances'}else{Join-Path $local 'ChatGPTRemoteCommander\instances'})
  }
}

function Test-RcProfileName([string]$Name) {
  return ($Name -match '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -and $Name -notmatch '\.\.' -and $Name -notin @('.','..'))
}

function Get-RcProfileHealthPort([string]$ProfileFile) {
  $text=Get-Content -LiteralPath $ProfileFile -Raw
  $m=[regex]::Match($text,'listen_addr:\s*["'']?127\.0\.0\.1:(\d+)')
  if($m.Success){return [int]$m.Groups[1].Value}
  return 0
}

function Get-RcProfileMcpPort([string]$ProfileFile) {
  $text=Get-Content -LiteralPath $ProfileFile -Raw
  $m=[regex]::Match($text,'url:\s*["'']?http://127\.0\.0\.1:(\d+)/mcp')
  if($m.Success){return [int]$m.Groups[1].Value}
  return 0
}

function Get-RcCredentialPath([string]$CredDir,[string]$Profile,[string]$CredentialScope) {
  $suffix=if($CredentialScope -eq 'LocalMachine'){'.machine.dpapi'}else{'.dpapi'}
  return Join-Path $CredDir ($Profile+$suffix)
}

function Read-RcCredentialPlainText([string]$Path,[string]$CredentialScope) {
  $raw=(Get-Content -LiteralPath $Path -Raw).Trim()
  if($CredentialScope -eq 'CurrentUser'){
    $secure=ConvertTo-SecureString $raw
    try{return [System.Net.NetworkCredential]::new('',$secure).Password}
    finally{$secure=$null}
  }
  $cipher=[Convert]::FromBase64String($raw)
  $clear=[Security.Cryptography.ProtectedData]::Unprotect(
    $cipher,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
  try{return [Text.Encoding]::UTF8.GetString($clear)}
  finally{
    if($cipher){[Array]::Clear($cipher,0,$cipher.Length)}
    if($clear){[Array]::Clear($clear,0,$clear.Length)}
  }
}

function Test-RcCredential([string]$Path,[string]$CredentialScope) {
  if(-not(Test-Path -LiteralPath $Path -PathType Leaf)){return $false}
  $plain=$null
  try{
    $plain=Read-RcCredentialPlainText $Path $CredentialScope
    return -not [string]::IsNullOrWhiteSpace($plain)
  }catch{return $false}
  finally{$plain=$null}
}

function Start-RcTunnelWithRotatingLog(
  [string]$Node,
  [string]$Runner,
  [string]$TunnelExe,
  [string]$WorkingDirectory,
  [string]$Profile,
  [string]$ProfileDir,
  [string]$LogFile,
  [string]$StatusFile,
  [string]$ApiKey
) {
  foreach($pair in @(
    @('node',$Node),@('runner',$Runner),@('tunnel',$TunnelExe)
  )){
    if(-not(Test-Path -LiteralPath $pair[1] -PathType Leaf)){throw "$($pair[0]) executable/file missing for tunnel log runner"}
  }
  $psi=[Diagnostics.ProcessStartInfo]::new()
  $psi.FileName=$Node
  $psi.WorkingDirectory=$WorkingDirectory
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  foreach($arg in @(
    $Runner,
    '--log-file',$LogFile,
    '--status-file',$StatusFile,
    '--max-bytes','8388608',
    '--max-files','3',
    '--',
    $TunnelExe,'run',
    '--profile',$Profile,
    '--profile-dir',$ProfileDir,
    '--log.file','stdout'
  )){[void]$psi.ArgumentList.Add([string]$arg)}
  $psi.Environment['CONTROL_PLANE_API_KEY']=$ApiKey
  [void]$psi.Environment.Remove('OPENAI_API_KEY')
  return [Diagnostics.Process]::Start($psi)
}

function Get-OwnedPrimaryMcpProcess([string]$Root,[string]$ConfigPath) {
  try {
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { return $null }
    $cfg=Get-Content -LiteralPath $ConfigPath -Raw|ConvertFrom-Json
    $markerPath=[string]$cfg.runtimeState
    if(-not $markerPath){$markerPath=Join-Path $Root 'var\mcp-runtime.json'}
    $markerPath=[Environment]::ExpandEnvironmentVariables($markerPath)
    if(-not[IO.Path]::IsPathRooted($markerPath)){$markerPath=Join-Path $Root $markerPath}
    if(-not(Test-Path -LiteralPath $markerPath -PathType Leaf)){return $null}
    $m=Get-Content -LiteralPath $markerPath -Raw|ConvertFrom-Json
    if([int]$m.port-ne47831 -or [string]$m.instance.profile-ne'default'){return $null}
    if([IO.Path]::GetFullPath([string]$m.projectDir)-ne[IO.Path]::GetFullPath($Root)){return $null}
    $p=Get-CimInstance Win32_Process -Filter ("ProcessId="+[int]$m.pid) -ErrorAction SilentlyContinue
    if(-not$p -or [string]$p.Name -ine'node.exe' -or [string]$p.CommandLine -notmatch'server-v0\.3\.mjs'){return $null}
    return $p
  }catch{return $null}
}

function Start-PrimaryMcp {
  if (Test-McpHealth 47831) { $script:PrimaryHealthFailures = 0; return $true }
  $script:PrimaryHealthFailures += 1
  $owned = Get-OwnedPrimaryMcpProcess $Root (Get-ActivePrimaryConfig)
  if ($owned) {
    Write-SupervisorLog "MCP_HEALTH_MISS profile=default pid=$($owned.ProcessId) count=$script:PrimaryHealthFailures"
    if ($script:PrimaryHealthFailures -lt 3) { return $false }
    Stop-Process -Id ([int]$owned.ProcessId) -Force -ErrorAction Stop
    Write-SupervisorLog "MCP_STALLED_OWNED_RESTART profile=default pid=$($owned.ProcessId)"
    Start-Sleep -Milliseconds 750
    $script:PrimaryHealthFailures = 0
  } else {
    $listener = $null
    try { $listener = Get-NetTCPConnection -State Listen -LocalPort 47831 -ErrorAction Stop | Select-Object -First 1 } catch {}
    if ($listener) { throw 'Port 47831 is occupied but primary Remote Commander health is unavailable; refusing unknown process.' }
  }
  $npm = if ($NpmPath) { [IO.Path]::GetFullPath($NpmPath) } else { (Get-Command npm.cmd -ErrorAction Stop).Source }
  if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) { throw 'npm executable missing for supervisor.' }
  $out = Join-Path $VarDir 'mcp-autostart.out.log'
  $err = Join-Path $VarDir 'mcp-autostart.err.log'
  Start-Process -FilePath $npm -ArgumentList @('start','--silent') -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err | Out-Null
  foreach ($i in 1..30) {
    Start-Sleep -Milliseconds 500
    if (Test-McpHealth 47831) { Write-SupervisorLog 'MCP_STARTED port=47831 profile=default'; return $true }
  }
  throw 'MCP_START_TIMEOUT port=47831'
}
