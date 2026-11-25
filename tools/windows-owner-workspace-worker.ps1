# Owner-session Workspace worker. Read-only discovery and evidence, never GUI input.
# Launched only by an existing authorized InteractiveToken task of this OS account.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$')][string]$RequestId,
  [ValidateSet('Probe','ListWindows')][string]$Action='ListWindows',
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$DriverSha256
)
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$proc=[Diagnostics.Process]::GetCurrentProcess()
if($identity.IsSystem -or $proc.SessionId -le 0) { throw 'OWNER_WORKSPACE_INTERACTIVE_ACCOUNT_REQUIRED' }
$root=Join-Path $env:LOCALAPPDATA 'ChatGPTRemoteCommander'
$driver=Join-Path $root 'adapters\cua-driver\v0.38.0\cua-driver.exe'
if(-not(Test-Path -LiteralPath $driver -PathType Leaf)){throw 'OWNER_WORKSPACE_CUA_MISSING'}
$actual=(Get-FileHash -LiteralPath $driver -Algorithm SHA256).Hash.ToLowerInvariant()
if($actual -cne $DriverSha256.ToLowerInvariant()){throw 'OWNER_WORKSPACE_DRIVER_HASH_MISMATCH'}
$receipts=Join-Path $root 'owner-workspace\receipts'
New-Item -ItemType Directory -Path $receipts -Force | Out-Null
$receipt=Join-Path $receipts ($RequestId+'.json')
if(Test-Path -LiteralPath $receipt){throw 'OWNER_WORKSPACE_REQUEST_ALREADY_PROCESSED'}
# This socket is scoped by the existing CUA daemon to the same interactive Windows SID.
$socket='\\.\pipe\rc-workspace-cua-v038'
if($Action -eq 'Probe'){
  $payload=[ordered]@{schema=1;requestId=$RequestId;status='OWNER_INTERACTIVE_PROBE_PASS';action=$Action;sessionId=$proc.SessionId;identity=$identity.Name}
} else {
  # No shell expression, arbitrary command, GUI focus, click, key or file-reading primitives.
  $raw=& $driver call --socket $socket list_windows '{}' 2>&1
  if($LASTEXITCODE -ne 0){throw 'OWNER_WORKSPACE_CUA_READ_FAILED'}
  try{$result=($raw | Out-String | ConvertFrom-Json -ErrorAction Stop)}catch{throw 'OWNER_WORKSPACE_CUA_JSON_INVALID'}
  if($null -eq $result.windows){throw 'OWNER_WORKSPACE_CUA_WINDOWS_MISSING'}
  $entries=@($result.windows | ForEach-Object {
    [ordered]@{processId=[int]$_.pid;handle=[string]$_.window_id;application=[string]$_.app_name}
  })
  if($entries.Count -gt 500){throw 'OWNER_WORKSPACE_TOO_MANY_WINDOWS'}
  $payload=[ordered]@{schema=1;requestId=$RequestId;status='OWNER_WINDOWS_ENUMERATED';action=$Action;sessionId=$proc.SessionId;identity=$identity.Name;windows=$entries}
}
# Machine accounts may read the receipt for dispatch; no passwords, cookies, titles or tokens.
# CreateNew is atomic: concurrent calls with the same RequestId can never overwrite a receipt.
# Preserve an incomplete receipt on a write failure; a retry must be reconciled, not replayed.
$json=$payload | ConvertTo-Json -Compress -Depth 6
$bytes=[Text.UTF8Encoding]::new($false).GetBytes($json)
$file=[IO.File]::Open($receipt,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try {
  $file.Write($bytes,0,$bytes.Length)
  $file.Flush($true)
} finally {
  $file.Dispose()
}
Write-Output "OWNER_WORKSPACE_RECEIPT_CREATED"
