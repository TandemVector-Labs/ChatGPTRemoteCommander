$ErrorActionPreference='Stop'
$sourcePath=Join-Path (Split-Path -Parent $PSScriptRoot) 'handoff-user-session-windows.ps1'
$scriptText=Get-Content -LiteralPath $sourcePath -Raw
$tokens=$null
$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseInput($scriptText,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw 'PROFILE_NATIVE_PARSE_ERROR'}
$fn=$ast.Find({param($node)
 $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'ManagedTunnelProfiles'
},$true)
if(-not $fn){throw 'PROFILE_NATIVE_HELPER_MISSING'}
. ([scriptblock]::Create($fn.Extent.Text))

$ProfileDir='C:\V107-Synthetic\Roaming\tunnel-client'
$script:Configs=@{}
$script:ProfileDirExists=$true

function Test-Path {
  [CmdletBinding()]param([string]$LiteralPath,[string]$PathType)
  if($LiteralPath -ne $ProfileDir){throw 'UNEXPECTED_TEST_PATH'}
  return $script:ProfileDirExists
}
function Get-ChildItem {
  [CmdletBinding()]param([string]$LiteralPath,[string]$Filter,[switch]$File)
  if($LiteralPath -ne $ProfileDir -or $Filter -ne '*.yaml' -or -not$File){throw 'UNEXPECTED_PROFILE_INVENTORY'}
  foreach($name in $script:Configs.Keys){
    [pscustomobject]@{BaseName=$name;FullName=(Join-Path $ProfileDir ($name+'.yaml'))}
  }
}
function Get-Content {
  [CmdletBinding()]param([string]$LiteralPath,[switch]$Raw)
  if(-not $Raw){throw 'EXPECTED_RAW_CONFIG'}
  $name=[IO.Path]::GetFileNameWithoutExtension($LiteralPath)
  if(-not $script:Configs.ContainsKey($name)){throw 'MISSING_FAKE_CONFIG'}
  return [string]$script:Configs[$name]
}

$cases=@()
function Assert-Case([string]$Name,[bool]$Passed){
  $script:cases += [pscustomobject]@{name=$Name;pass=$Passed}
}
$script:Configs=@{
 'MMZ'='  listen_addr: "127.0.0.1:47834"'
 'saeid-secondary'='  listen_addr: "127.0.0.1:47833"'
 'chatgpt-remote-commander'='  listen_addr: "127.0.0.1:47832"'
}
$profiles=@(ManagedTunnelProfiles)
Assert-Case 'valid_three_unique_profiles' ($profiles.Count -eq 3 -and (@($profiles|Select-Object -ExpandProperty Port -Unique).Count -eq 3))
$entry=@($profiles|Where-Object {$_.Name -eq 'MMZ'})[0]
$profilePattern='(?:^|\s)--profile(?:=|\s+)"?'+[regex]::Escape([string]$entry.Name)+'"?(?:\s|$)'
Assert-Case 'exact_expected_profile' ([bool]('"tunnel-client.exe" --profile MMZ' -match $profilePattern))
Assert-Case 'quoted_expected_profile' ([bool]('"tunnel-client.exe" --profile "MMZ"' -match $profilePattern))
Assert-Case 'equals_expected_profile' ([bool]('"tunnel-client.exe" --profile=MMZ --config foo' -match $profilePattern))
Assert-Case 'wrong_profile_same_port' (-not ('"tunnel-client.exe" --profile default' -match $profilePattern))
Assert-Case 'prefix_collision' (-not ('"tunnel-client.exe" --profile MMZ-shadow' -match $profilePattern))
Assert-Case 'profile_argument_missing' (-not ('"tunnel-client.exe" --config default' -match $profilePattern))

$script:Configs['saeid-secondary']='  listen_addr: "127.0.0.1:47832"'
Assert-Case 'duplicate_tunnel_port_denied' (@(ManagedTunnelProfiles).Count -eq 0)
$script:Configs['saeid-secondary']='  listen_addr: "127.0.0.1:47833"'
$script:Configs['MMZ']='  listen_addr: "0.0.0.0:47834"'
Assert-Case 'non_loopback_port_denied' (@(ManagedTunnelProfiles).Count -eq 0)
$script:Configs['MMZ']=('  listen_addr: "127.0.0.1:47834"'+[Environment]::NewLine+'  listen_addr: "127.0.0.1:47835"')
Assert-Case 'multiple_listen_addresses_denied' (@(ManagedTunnelProfiles).Count -eq 0)
$script:Configs['MMZ']='  listen_addr: "127.0.0.1:47834"'
$script:Configs['bad profile']='  listen_addr: "127.0.0.1:47836"'
Assert-Case 'unqualified_profile_name_denied' (@(ManagedTunnelProfiles).Count -eq 0)
$script:Configs.Remove('bad profile')
$script:Configs['MMZ']='  listen_addr: "127.0.0.1:99999"'
Assert-Case 'invalid_port_denied' (@(ManagedTunnelProfiles).Count -eq 0)
$script:Configs['MMZ']=('  listen_addr: "127.0.0.1:47834"'+[Environment]::NewLine+'  listen_addr: "0.0.0.0:47835"')
Assert-Case 'mixed_local_and_nonlocal_listen_addr_denied' (@(ManagedTunnelProfiles).Count -eq 0)
$script:Configs['MMZ']=('  listen_addr: "127.0.0.1:47834"'+[Environment]::NewLine+'  listen_addr: "not-a-listener"')
Assert-Case 'mixed_local_and_malformed_listen_addr_denied' (@(ManagedTunnelProfiles).Count -eq 0)
$script:Configs['MMZ']='  listen_addr: "127.0.0.1:47834"garbage'
Assert-Case 'valid_listener_trailing_garbage_denied' (@(ManagedTunnelProfiles).Count -eq 0)
$script:Configs['MMZ']='  listen_addr: ''127.0.0.1:47834"'
Assert-Case 'mismatched_quotes_denied' (@(ManagedTunnelProfiles).Count -eq 0)
$script:Configs['MMZ']='  listen_addr: 127.0.0.1:47834 # expected local'
Assert-Case 'valid_unquoted_listener_comment_accepted' (@(ManagedTunnelProfiles).Count -eq 3)
$script:Configs['MMZ']='  listen_addr: "127.0.0.1:47834" # expected local'
Assert-Case 'valid_quoted_listener_comment_accepted' (@(ManagedTunnelProfiles).Count -eq 3)
$script:Configs['MMZ']='  listen_addr: "127.0.0.1:47834"'
$script:Configs.Clear()
Assert-Case 'no_profiles_denied' (@(ManagedTunnelProfiles).Count -eq 0)
$script:ProfileDirExists=$false
Assert-Case 'profile_directory_absent_denied' (@(ManagedTunnelProfiles).Count -eq 0)

$fail=@($cases | Where-Object {-not $_.pass})
if($fail.Count -gt 0){throw 'PROFILE_NATIVE_FAILED: '+($fail.name -join ',')}
Write-Output ('HANDOFF_PROFILE_NATIVE_PASS cases='+$cases.Count)
