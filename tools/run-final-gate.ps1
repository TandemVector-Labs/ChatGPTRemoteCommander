$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$log = Join-Path $root 'var\final-gate-v0.10.23.log'
New-Item -ItemType Directory -Force (Split-Path -Parent $log) | Out-Null
"FINAL_GATE_START $(Get-Date -Format o)" | Set-Content $log
function Invoke-Gate([string]$Name,[scriptblock]$Block) {
  "== $Name ==" | Tee-Object -FilePath $log -Append
  & $Block 2>&1 | Tee-Object -FilePath $log -Append
  if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit $LASTEXITCODE" }
}
Invoke-Gate 'FOCUSED_PROJECT_ENGINE' { npm run test:project-engine }
Invoke-Gate 'CHECK' { npm run check }
Invoke-Gate 'FULL_TEST' { npm test }
Invoke-Gate 'SECURITY_AUDIT' { npm run audit }
Invoke-Gate 'DIFF_CHECK' { git diff --check }
"FINAL_GATE_PASS $(Get-Date -Format o)" | Tee-Object -FilePath $log -Append
