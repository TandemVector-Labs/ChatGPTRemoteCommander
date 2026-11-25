# Owner-local presentation metadata only. Never modify Runtime, Tunnel, identity,
# routing, permission grants, installed Plugins, or recovery capsules.
$script:ProfileDisplayRoot=Join-Path $env:LOCALAPPDATA 'ChatGPTRemoteCommander'
$script:ProfileDisplayFile=Join-Path $script:ProfileDisplayRoot 'profile-display-names.json'

function Assert-ProfileTechnicalName([string]$Profile) {
  if($Profile -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or $Profile.Contains('..')){
    throw 'PROFILE_DISPLAY_TECHNICAL_NAME_INVALID'
  }
}
function Assert-ProfileDisplayLabel([string]$DisplayName) {
  if([string]::IsNullOrWhiteSpace($DisplayName) -or $DisplayName.Length -gt 80 -or
     $DisplayName -cne $DisplayName.Trim() -or
     [regex]::IsMatch($DisplayName,'[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]')){
    throw 'PROFILE_DISPLAY_LABEL_INVALID'
  }
}
function Read-ProfileDisplayMap {
  $result=@{}
  $file=$script:ProfileDisplayFile
  if(-not(Test-Path -LiteralPath $file)){return $result}
  $item=Get-Item -LiteralPath $file -Force -ErrorAction Stop
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
     $item.Length -gt 32768){throw 'PROFILE_DISPLAY_STORE_UNTRUSTED'}
  $obj=([IO.File]::ReadAllText($file,[Text.Encoding]::UTF8) | ConvertFrom-Json -AsHashtable)
  if(-not $obj -or $obj.schema -ne 1 -or $obj.Count -ne 2 -or
     -not ($obj.profiles -is [System.Collections.IDictionary]) -or $obj.profiles.Count -gt 128){
    throw 'PROFILE_DISPLAY_STORE_SCHEMA_INVALID'
  }
  $labels=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($profile in $obj.profiles.Keys){
    $name=[string]$profile;$label=[string]$obj.profiles[$profile]
    Assert-ProfileTechnicalName $name
    Assert-ProfileDisplayLabel $label
    if(-not $labels.Add($label) -or $result.ContainsKey($name.ToLowerInvariant())){
      throw 'PROFILE_DISPLAY_STORE_COLLISION'
    }
    $result[$name.ToLowerInvariant()]=$label
  }
  return $result
}
function Get-ProfileDisplayName([string]$Profile) {
  Assert-ProfileTechnicalName $Profile
  $map=Read-ProfileDisplayMap
  $key=$Profile.ToLowerInvariant()
  if($map.ContainsKey($key)){return [string]$map[$key]}
  return $Profile
}
function Assert-ProfileDisplayAvailable([string]$Profile,[string]$DisplayName) {
  Assert-ProfileTechnicalName $Profile
  Assert-ProfileDisplayLabel $DisplayName
  $map=Read-ProfileDisplayMap
  foreach($key in $map.Keys){
    if($key -ne $Profile.ToLowerInvariant() -and
       [string]::Equals([string]$map[$key],$DisplayName,[StringComparison]::OrdinalIgnoreCase)){
      throw 'PROFILE_DISPLAY_LABEL_COLLISION'
    }
  }
  return $true
}
function Set-ProfileDisplayName([string]$Profile,[string]$DisplayName) {
  Assert-ProfileTechnicalName $Profile
  Assert-ProfileDisplayLabel $DisplayName
  $root=$script:ProfileDisplayRoot
  if(-not(Test-Path -LiteralPath $root)){[void](New-Item -ItemType Directory -Path $root -Force)}
  $directory=Get-Item -LiteralPath $root -Force
  if(-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)){
    throw 'PROFILE_DISPLAY_DIRECTORY_UNTRUSTED'
  }
  $lockFile=$script:ProfileDisplayFile+'.lock'
  if(Test-Path -LiteralPath $lockFile){
    if((Get-Item -LiteralPath $lockFile -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){
      throw 'PROFILE_DISPLAY_LOCK_UNTRUSTED'
    }
  }
  $lock=[IO.FileStream]::new($lockFile,[IO.FileMode]::OpenOrCreate,
                           [IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{
    [void](Assert-ProfileDisplayAvailable $Profile $DisplayName)
    $map=Read-ProfileDisplayMap
    $map[$Profile.ToLowerInvariant()]=$DisplayName
    $json=ConvertTo-Json -InputObject @{schema=1;profiles=$map} -Depth 5 -Compress
    $tmp=Join-Path $root ('.profile-display-'+[guid]::NewGuid().ToString('N')+'.tmp')
    try{
      $bytes=[Text.UTF8Encoding]::new($false).GetBytes($json+[Environment]::NewLine)
      $stream=[IO.FileStream]::new($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,
                                    [IO.FileShare]::None)
      try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
      [IO.File]::Move($tmp,$script:ProfileDisplayFile,$true)
    }finally{
      if(Test-Path -LiteralPath $tmp){Remove-Item -LiteralPath $tmp -Force}
    }
    if((Get-ProfileDisplayName $Profile) -cne $DisplayName){
      throw 'PROFILE_DISPLAY_READBACK_FAILED'
    }
    return 'PROFILE_DISPLAY_NAME_SAVED'
  }finally{$lock.Dispose()}
}
