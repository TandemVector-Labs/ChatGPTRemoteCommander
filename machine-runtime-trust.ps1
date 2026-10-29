# Admission-only trust boundary for the SYSTEM BootCore runtime. Do not create or
# migrate data here: operator-staged machine state must preexist and be sealed.
function Assert-RcMachineRuntimeStore {
  $allowed=@('S-1-5-18','S-1-5-32-544')
  $base=[IO.Path]::GetFullPath([Environment]::GetFolderPath('CommonApplicationData'))
  $parent=Join-Path $base 'ChatGPTRemoteCommander'
  $root=Join-Path $parent 'machine-runtime'
  Assert-RcCredentialParentAcl (Get-Acl -LiteralPath $base -ErrorAction Stop)
  if(-not(Test-Path -LiteralPath $root -PathType Container)){
    throw 'BOOT_RECOVERY_MACHINE_RUNTIME_MISSING'
  }
  $items=@(Get-Item -LiteralPath $parent -Force)
  $items+=@(Get-Item -LiteralPath $root -Force)
  $items+=@(Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction Stop)
  if($items.Count -gt 2048){throw 'BOOT_RECOVERY_MACHINE_RUNTIME_AUDIT_TOO_LARGE'}
  foreach($item in $items){
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
      throw 'BOOT_RECOVERY_MACHINE_RUNTIME_REPARSE'
    }
    $acl=Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
    try{$owner=([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value}
    catch{throw 'BOOT_RECOVERY_MACHINE_RUNTIME_OWNER_UNRESOLVED'}
    if($owner -notin $allowed){throw 'BOOT_RECOVERY_MACHINE_RUNTIME_OWNER_UNTRUSTED'}
    if($item.FullName -in @($parent,$root) -and -not $acl.AreAccessRulesProtected){
      throw 'BOOT_RECOVERY_MACHINE_RUNTIME_ROOT_INHERITS'
    }
    foreach($ace in $acl.Access){
      if($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){continue}
      try{$sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}
      catch{throw 'BOOT_RECOVERY_MACHINE_RUNTIME_ACL_UNREADABLE'}
      if($sid -notin $allowed){throw 'BOOT_RECOVERY_MACHINE_RUNTIME_UNTRUSTED_ACE'}
    }
  }
  foreach($dir in @('profiles','instances','primary','routing','local','var')){
    if(-not(Test-Path -LiteralPath (Join-Path $root $dir) -PathType Container)){
      throw 'BOOT_RECOVERY_MACHINE_RUNTIME_LAYOUT_INCOMPLETE'
    }
  }
  $profiles=@(Get-ChildItem -LiteralPath (Join-Path $root 'profiles') -Filter '*.yaml' -File -ErrorAction Stop)
  if($profiles.Count -lt 1){throw 'BOOT_RECOVERY_MACHINE_RUNTIME_NO_PROFILES'}
  $primary=Join-Path $root 'primary\config.json'
  if(-not(Test-Path -LiteralPath $primary -PathType Leaf)){throw 'BOOT_RECOVERY_MACHINE_PRIMARY_MISSING'}
  $config=Get-Content -LiteralPath $primary -Raw -ErrorAction Stop|ConvertFrom-Json -ErrorAction Stop
  if([int]$config.port -ne 47831 -or [string]$config.host -ne '127.0.0.1' -or
     @($config.allowedRoots).Count -gt 0 -or @($config.allowedPrograms).Count -gt 0 -or
     $config.autoUpdate.enabled -ne $false){
    throw 'BOOT_RECOVERY_MACHINE_PRIMARY_UNSAFE'
  }
  foreach($flag in $config.powerMode.PSObject.Properties){
    if($flag.Value -eq $true){throw 'BOOT_RECOVERY_MACHINE_PRIMARY_PRIVILEGED'}
  }
  foreach($profile in $profiles){
    $name=[IO.Path]::GetFileNameWithoutExtension($profile.Name)
    if($name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or
       $name -match '\.\.' -or $name -in @('.','..')){
      throw 'BOOT_RECOVERY_MACHINE_PROFILE_INVALID'
    }
    $instanceRoot=Join-Path (Join-Path $root 'instances') $name
    $record=Join-Path $instanceRoot 'instance.json'
    if(-not(Test-Path -LiteralPath $record -PathType Leaf)){continue}
    $inst=Get-Content -LiteralPath $record -Raw -ErrorAction Stop|ConvertFrom-Json -ErrorAction Stop
    $configPath=Join-Path $instanceRoot 'config.json'
    if([int]$inst.schema -ne 1 -or [string]$inst.profile -ne $name -or
       $inst.enabled -ne $true -or $inst.isolated -ne $true -or
       [IO.Path]::GetFullPath([string]$inst.configPath) -ine [IO.Path]::GetFullPath($configPath) -or
       [int]$inst.mcpPort -lt 1024 -or [int]$inst.mcpPort -gt 65535 -or
       -not(Test-Path -LiteralPath $configPath -PathType Leaf)){
      throw 'BOOT_RECOVERY_MACHINE_INSTANCE_INVALID'
    }
    $hash=(Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if($hash -ne ([string]$inst.configSha256).ToLowerInvariant()){
      throw 'BOOT_RECOVERY_MACHINE_INSTANCE_HASH_MISMATCH'
    }
    $cfg=Get-Content -LiteralPath $configPath -Raw -ErrorAction Stop|ConvertFrom-Json -ErrorAction Stop
    if([int]$cfg.port -ne [int]$inst.mcpPort -or
       [string]$cfg.instance.profile -ne $name -or
       @($cfg.allowedRoots).Count -gt 0 -or @($cfg.allowedPrograms).Count -gt 0 -or
       $cfg.autoUpdate.enabled -ne $false -or $cfg.powerMode.enabled -ne $false -or
       $cfg.durableWorkflows.enabled -ne $false){
      throw 'BOOT_RECOVERY_MACHINE_INSTANCE_UNSAFE'
    }
  }
  return $root
}

# Trust the OS-known Program Files location and its complete ACL ancestry.
function Assert-RcMachineTrustedBinaryPath([string]$Candidate){
  $pf=[IO.Path]::GetFullPath([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)).TrimEnd('\')
  if([IO.Path]::GetFullPath($env:ProgramFiles).TrimEnd('\') -ine $pf){
    throw 'BOOT_RECOVERY_PROGRAMFILES_ENV_MISMATCH'
  }
  $path=[IO.Path]::GetFullPath($Candidate).TrimEnd('\')
  if(-not $path.StartsWith($pf+'\',[StringComparison]::OrdinalIgnoreCase)){
    throw 'BOOT_RECOVERY_MACHINE_TUNNEL_PATH_UNTRUSTED'
  }
  $trusted=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $mask=[int64]([Security.AccessControl.FileSystemRights]::WriteData -bor
    [Security.AccessControl.FileSystemRights]::AppendData -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership -bor
    [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor 0x50000000)
  $current=$path
  while($current.Length -ge $pf.Length){
    $item=Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
      throw 'BOOT_RECOVERY_MACHINE_TUNNEL_REPARSE'
    }
    $acl=Get-Acl -LiteralPath $current -ErrorAction Stop
    try{$owner=([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value}
    catch{throw 'BOOT_RECOVERY_MACHINE_TUNNEL_OWNER_UNRESOLVED'}
    if($owner -notin $trusted){throw 'BOOT_RECOVERY_MACHINE_TUNNEL_OWNER_UNTRUSTED'}
    foreach($ace in $acl.Access){
      if($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
         ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0){continue}
      if((([int64]$ace.FileSystemRights) -band $mask) -eq 0){continue}
      try{$sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}
      catch{throw 'BOOT_RECOVERY_MACHINE_TUNNEL_ACL_UNREADABLE'}
      if($sid -notin $trusted){
        throw 'BOOT_RECOVERY_MACHINE_TUNNEL_WRITABLE'
      }
    }
    if($current -ieq $pf){break}
    $current=Split-Path -Parent $current
  }
}

function Get-RcMachineTunnelExecutable {
  $root=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)) 'ChatGPTRemoteCommander\machine-bin'
  $exe=Join-Path $root 'tunnel-client.exe'
  $pin=Join-Path $root 'tunnel-client.sha256'
  foreach($file in @($exe,$pin)){Assert-RcMachineTrustedBinaryPath $file}
  $expected=(Get-Content -LiteralPath $pin -Raw -ErrorAction Stop).Trim().ToLowerInvariant()
  if($expected -notmatch '^[0-9a-f]{64}$'){throw 'BOOT_RECOVERY_MACHINE_TUNNEL_PIN_INVALID'}
  $actual=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
  if($expected -ne $actual){throw 'BOOT_RECOVERY_MACHINE_TUNNEL_PIN_MISMATCH'}
  return $exe
}
