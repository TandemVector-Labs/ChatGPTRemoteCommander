param(
  [string]$Profile = 'chatgpt-remote-commander',
  [string]$TunnelId,
  [Security.SecureString]$RuntimeApiKey,
  [ValidateRange(0,65535)][int]$HealthPort = 0,
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($Profile -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or $Profile -match '\.\.' -or $Profile -in @('.','..')) {
  throw 'Profile must be 1-64 characters using letters, digits, dot, underscore or dash, without ..'
}

$ProfileDir = Join-Path $env:APPDATA 'tunnel-client'
$ProfileFile = Join-Path $ProfileDir "$Profile.yaml"
$CredDir = Join-Path $env:LOCALAPPDATA 'ChatGPTRemoteCommander\credentials'
$CredFile = Join-Path $CredDir "$Profile.dpapi"
$McpUrl = 'http://127.0.0.1:47831/mcp'
$HealthUrl = 'http://127.0.0.1:47831/health'

function Find-TunnelExe {
  $stateFile = Join-Path $Root 'var\tunnel-client.json'
  if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) {
    throw 'Pinned tunnel-client state is missing. Re-run install.ps1.'
  }
  $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
  $exe = [IO.Path]::GetFullPath([string]$state.path)
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw 'Pinned tunnel-client executable is missing. Re-run install.ps1.'
  }
  $actual = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne ([string]$state.sha256).ToLowerInvariant()) {
    throw 'Pinned tunnel-client SHA256 mismatch. Re-run install.ps1.'
  }
  return $exe
}

function Find-FreeHealthPort {
  foreach ($candidate in 47832..47931) {
    if (-not (Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue)) {
      return $candidate
    }
  }
  throw 'No free tunnel health port found in 47832..47931.'
}

function Test-McpHealth {
  try {
    $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
    return [bool]($health.ok -and $health.name -eq 'chatgpt-remote-commander')
  } catch {
    return $false
  }
}

function Ensure-McpHealth {
  if (Test-McpHealth) { return }

  $listener = Get-NetTCPConnection -State Listen -LocalPort 47831 -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    throw 'Port 47831 is already in use but Remote Commander health is unavailable. Refusing to stop an unknown process.'
  }

  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  $varDir = Join-Path $Root 'var'
  New-Item -ItemType Directory -Force -Path $varDir | Out-Null
  Start-Process -FilePath $npm -ArgumentList @('start','--silent') -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $varDir 'mcp-connect.out.log') -RedirectStandardError (Join-Path $varDir 'mcp-connect.err.log') | Out-Null

  foreach ($i in 1..30) {
    Start-Sleep -Milliseconds 500
    if (Test-McpHealth) {
      Write-Host 'MCP was not running; it has been started automatically.'
      return
    }
  }
  throw "Remote Commander MCP did not become healthy at $HealthUrl. Check var/mcp-connect.err.log."
}

function Test-ProfileProcess([string]$Exe, [string]$Name) {
  $expected = [IO.Path]::GetFullPath($Exe)
  $escaped = [regex]::Escape($Name)
  $profileRegex = '--profile(?:=|\s+)["'']?' + $escaped + '["'']?(?:\s|$)'
  return Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ExecutablePath -and
      [IO.Path]::GetFullPath([string]$_.ExecutablePath) -eq $expected -and
      $_.CommandLine -match $profileRegex
    } |
    Select-Object -First 1
}

function Test-AnyProfileProcess([string]$Name) {
  $escaped = [regex]::Escape($Name)
  $profileRegex = '--profile(?:=|\s+)["'']?' + $escaped + '["'']?(?:\s|$)'
  return Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $profileRegex } |
    Select-Object -First 1
}

function Test-TunnelReady([int]$Port) {
  if ($Port -le 0) { return $false }
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/readyz" -UseBasicParsing -TimeoutSec 2
    return ($response.StatusCode -eq 200 -and $response.Content.Trim() -eq 'ready')
  } catch {
    return $false
  }
}

Ensure-McpHealth
$TunnelExe = Find-TunnelExe

$ProfileExists = Test-Path -LiteralPath $ProfileFile -PathType Leaf
$CreatedProfile = $false
if (-not $ProfileExists) {
  if (-not $TunnelId) {
    $TunnelId = Read-Host 'Paste OpenAI tunnel_id for this account'
  }
  if ($TunnelId -notmatch '^tunnel_[0-9a-f]{32}$') {
    throw 'Invalid tunnel_id format.'
  }
  if ($HealthPort -eq 0) {
    $HealthPort = Find-FreeHealthPort
  }
} else {
  $raw = Get-Content -LiteralPath $ProfileFile -Raw
  $tm = [regex]::Match($raw, '(?m)^\s*tunnel_id:\s*["'']?([^"''\s#]+)')
  $hm = [regex]::Match($raw, 'listen_addr:\s*["'']?127\.0\.0\.1:(\d+)')
  if (-not $tm.Success -or -not $hm.Success) {
    throw 'Existing tunnel profile is missing tunnel_id or loopback health port.'
  }

  $existingTunnelId = $tm.Groups[1].Value
  $existingHealthPort = [int]$hm.Groups[1].Value
  if ($TunnelId -and $TunnelId -ne $existingTunnelId) {
    throw 'TunnelId does not match the existing profile; use a different profile name.'
  }
  if ($HealthPort -ne 0 -and $HealthPort -ne $existingHealthPort) {
    throw 'HealthPort does not match the existing profile; use a different profile name.'
  }
  $TunnelId = $existingTunnelId
  $HealthPort = $existingHealthPort
}

New-Item -ItemType Directory -Force -Path $CredDir,$ProfileDir | Out-Null
$PersistCredential = $false
if (Test-Path -LiteralPath $CredFile -PathType Leaf) {
  $Encrypted = Get-Content -LiteralPath $CredFile -Raw
  $SecureKey = ConvertTo-SecureString $Encrypted
  Write-Host "Reusing existing DPAPI credential for profile $Profile."
} else {
  if ($RuntimeApiKey) {
    $SecureKey = $RuntimeApiKey
  } else {
    $SecureKey = Read-Host 'Paste Runtime API key once (input hidden; saved only after tunnel validation passes)' -AsSecureString
  }
  $PersistCredential = $true
}

$PlainKey = [System.Net.NetworkCredential]::new('', $SecureKey).Password
if ([string]::IsNullOrWhiteSpace($PlainKey)) {
  throw 'Runtime API key is empty.'
}

$HadAmbientOpenAiApiKey = Test-Path Env:OPENAI_API_KEY
$AmbientOpenAiApiKey = if ($HadAmbientOpenAiApiKey) { $env:OPENAI_API_KEY } else { $null }
$ValidationPassed = $false
try {
  Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
  $env:CONTROL_PLANE_API_KEY = $PlainKey

  if (-not $ProfileExists) {
    & $TunnelExe init --sample sample_mcp_remote_no_auth --profile $Profile --profile-dir $ProfileDir --tunnel-id $TunnelId --mcp-server-url $McpUrl --health-listen-addr "127.0.0.1:$HealthPort" --force
    if ($LASTEXITCODE -ne 0) {
      throw "tunnel-client init failed: $LASTEXITCODE"
    }
    $CreatedProfile = $true
  }

  $runningProfile = Test-ProfileProcess $TunnelExe $Profile
  if (-not $runningProfile) {
    $runningProfile = Test-AnyProfileProcess $Profile
  }
  $ready = [bool]($runningProfile -and (Test-TunnelReady $HealthPort))

  if ($ready -and -not $PersistCredential) {
    Write-Host "Existing tunnel profile $Profile is already ready on health port $HealthPort; doctor bind check skipped."
  } else {
    & $TunnelExe doctor --profile $Profile --profile-dir $ProfileDir --explain
    if ($LASTEXITCODE -ne 0) {
      throw "tunnel-client doctor failed: $LASTEXITCODE"
    }
  }

  if ($PersistCredential) {
    $Encrypted = ConvertFrom-SecureString $SecureKey
    $tmpCred = "$CredFile.tmp-$PID"
    [IO.File]::WriteAllText($tmpCred, $Encrypted, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tmpCred -Destination $CredFile -Force
  }

  $ValidationPassed = $true
} finally {
  Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
  if ($HadAmbientOpenAiApiKey) { $env:OPENAI_API_KEY = $AmbientOpenAiApiKey }
  else { Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue }
  $AmbientOpenAiApiKey = $null
  if (-not $ValidationPassed -and $CreatedProfile) {
    Remove-Item -LiteralPath $ProfileFile -Force -ErrorAction SilentlyContinue
  }
  $PlainKey = $null
  $SecureKey = $null
}

$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$supervisor = Join-Path $Root 'autostart-windows.ps1'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
New-Item -Path $runKey -Force | Out-Null
$launcher = Join-Path $Root 'launch-supervisor-hidden.vbs'
$pwshVbs = $pwsh.Replace('"','""')
$supervisorVbs = $supervisor.Replace('"','""')
$vbs = @(
  'Set sh = CreateObject("WScript.Shell")',
  ('cmd = Chr(34) & "{0}" & Chr(34) & " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & Chr(34) & "{1}" & Chr(34)' -f $pwshVbs,$supervisorVbs),
  'Call sh.Run(cmd, 0, False)'
)
[IO.File]::WriteAllLines($launcher,$vbs,[Text.UTF8Encoding]::new($false))
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$command = '"{0}" //B //NoLogo "{1}"' -f $wscript,$launcher
New-ItemProperty -Path $runKey -Name 'ChatGPTRemoteCommander' -Value $command -PropertyType String -Force | Out-Null

if (-not $NoStart) {
  $rootPattern = [regex]::Escape([IO.Path]::GetFullPath($Root))
  $existing = Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'autostart-windows\.ps1' -and $_.CommandLine -match $rootPattern } |
    Select-Object -First 1
  if (-not $existing) {
    Start-Process -FilePath $pwsh -ArgumentList @('-NoLogo','-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$supervisor) -WindowStyle Hidden | Out-Null
  }
}

Write-Host ''
Write-Host "AUTOSTART_ENROLL_PASS profile=$Profile credential=$CredFile healthPort=$HealthPort"
Write-Host 'Windows logon autostart is enabled. No Tunnel ID, IP/port, or Runtime API key is required on later logons.'
