$ErrorActionPreference='Stop'
$sourcePath=Join-Path (Split-Path -Parent $PSScriptRoot) 'handoff-user-session-windows.ps1'
$sourceText=Get-Content -LiteralPath $sourcePath -Raw
$tok=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($sourceText,[ref]$tok,[ref]$errors)
if($errors.Count -ne 0){throw 'HANDOFF_OWNER_CONTEXT_PARSE_FAILED'}
$fn=$ast.Find({param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
  $node.Name -eq 'Assert-HandoffOwnerContext'
},$true)
if(-not $fn){throw 'HANDOFF_OWNER_CONTEXT_FUNCTION_MISSING'}
. ([scriptblock]::Create($fn.Extent.Text))
function Reject([bool]$SystemContext,[bool]$ExplicitOwner,[string]$Owner,[string]$Current){
  try{Assert-HandoffOwnerContext $SystemContext $ExplicitOwner $Owner $Current;return $false}
  catch{return $true}
}
$cases=@(
  [pscustomobject]@{Name='user_default';Accepted=(-not(Reject $false $false 'C:\Users\Owner' 'C:\Users\Owner'));Expected=$true},
  [pscustomobject]@{Name='user_explicit';Accepted=(-not(Reject $false $true 'C:\Users\Other' 'C:\Users\Owner'));Expected=$true},
  [pscustomobject]@{Name='system_explicit_user';Accepted=(-not(Reject $true $true 'C:\Users\Owner' 'C:\Windows\System32\config\systemprofile'));Expected=$true},
  [pscustomobject]@{Name='system_implicit_rejected';Accepted=(-not(Reject $true $false 'C:\Windows\System32\config\systemprofile' 'C:\Windows\System32\config\systemprofile'));Expected=$false},
  [pscustomobject]@{Name='system_self_rejected';Accepted=(-not(Reject $true $true 'C:\Windows\System32\config\systemprofile' 'C:\Windows\System32\config\systemprofile'));Expected=$false},
  [pscustomobject]@{Name='missing_user_profile_rejected';Accepted=(-not(Reject $false $true '' 'C:\Users\Owner'));Expected=$false},
  [pscustomobject]@{Name='missing_system_profile_rejected';Accepted=(-not(Reject $true $true ' ' 'C:\Windows\System32\config\systemprofile'));Expected=$false}
)
$failed=@($cases | Where-Object{$_.Accepted -ne $_.Expected})
if($failed.Count -gt 0){throw ('HANDOFF_OWNER_CONTEXT_FAILED: '+($failed.Name -join ','))}
Write-Output ('HANDOFF_OWNER_CONTEXT_NATIVE_PASS cases='+$cases.Count)
