param(
  [Parameter(Mandatory=$true)][string]$AppId,
  [string]$DeviceName = $env:COMPUTERNAME,
  [string]$Profile = 'chatgpt-remote-commander',
  [string]$IdentityMap = '',
  [string]$HostId = '',
  [string]$AccountId = '',
  [string]$OutputDirectory = '',
  [switch]$KeepDirectory
)
$ErrorActionPreference='Stop'
$Root=Split-Path -Parent $MyInvocation.MyCommand.Path
$Generator=Join-Path $Root 'tools\generate-device-plugin.mjs'
$Template=Join-Path $Root 'plugin-template'
if(-not(Test-Path -LiteralPath $Generator -PathType Leaf)){throw 'generate-device-plugin.mjs is missing; update Remote Commander.'}
if(-not(Test-Path -LiteralPath (Join-Path $Template 'plugin.json') -PathType Leaf)){throw 'plugin-template is missing; update Remote Commander.'}
$node=(Get-Command node.exe -ErrorAction SilentlyContinue)
if(-not $node){$node=Get-Command node -ErrorAction Stop}

if([string]::IsNullOrWhiteSpace($DeviceName)){$DeviceName=$env:COMPUTERNAME}
if([string]::IsNullOrWhiteSpace($OutputDirectory)){
  $downloads=Join-Path $env:USERPROFILE 'Downloads'
  $OutputDirectory=if(Test-Path -LiteralPath $downloads){Join-Path $downloads 'RemoteCommander-Plugins'}else{Join-Path $env:USERPROFILE 'RemoteCommander-Plugins'}
}
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$machineGuid=''
try{$machineGuid=[string](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid}catch{}
if([string]::IsNullOrWhiteSpace($machineGuid)){$machineGuid="$env:COMPUTERNAME|$env:PROCESSOR_IDENTIFIER"}
$sha=[Security.Cryptography.SHA256]::Create()
try{
  $fingerprintSeed=if($IdentityMap){$AccountId}else{$Profile}
  $seedText=([string]$machineGuid)+[char]0+([string]$fingerprintSeed)
  $bytes=[Text.Encoding]::UTF8.GetBytes($seedText)
  $digest=$sha.ComputeHash($bytes)
  $fingerprint=([Convert]::ToHexString($digest)).ToLowerInvariant().Substring(0,10)
}finally{$sha.Dispose()}

$temp=Join-Path ([IO.Path]::GetTempPath()) ('remote-commander-plugin-'+[guid]::NewGuid().ToString('N'))
$stage=Join-Path $temp 'plugin'
New-Item -ItemType Directory -Force -Path $temp | Out-Null
try{
  $preZip=Join-Path $temp 'device-plugin.zip'
  $generatorArgs=@('--template',$Template,'--output',$stage,'--zip',$preZip,
    '--app-id',$AppId,'--profile',$Profile,'--fingerprint',$fingerprint)
  if($IdentityMap -or $HostId -or $AccountId){
    if(-not($IdentityMap -and $HostId -and $AccountId)){
      throw 'IdentityMap, HostId and AccountId are required together'
    }
    $generatorArgs+=@('--identity-map',$IdentityMap,'--host-id',$HostId,'--account-id',$AccountId)
    if($PSBoundParameters.ContainsKey('DeviceName')){$generatorArgs+=@('--device-name',$DeviceName)}
  }else{
    $generatorArgs+=@('--device-name',$DeviceName)
  }
  $json=& $node.Source $Generator @generatorArgs
  if($LASTEXITCODE -ne 0){throw "device plugin generator failed: $LASTEXITCODE"}
  $result=$json | ConvertFrom-Json
  if(-not $result.ok){throw 'device plugin generator returned non-PASS result'}
  $safeName=[string]$result.pluginName
  if($safeName -notmatch '^[a-z0-9][a-z0-9-]{1,62}$'){throw 'generated plugin name is invalid'}
  $zip=Join-Path $OutputDirectory ($safeName+'.zip')
  Copy-Item -LiteralPath $preZip -Destination $zip -Force
  $hash=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  if($hash -ne [string]$result.zipSha256){throw 'generated ZIP hash changed during copy'}

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive=[IO.Compression.ZipFile]::OpenRead($zip)
  try{
    $names=@($archive.Entries | ForEach-Object {$_.FullName})
    foreach($required in @('plugin.json','.app.json','.codex-plugin/plugin.json','assets/icon.png','assets/logo.png','skills/remote-commander/SKILL.md','DEVICE_PLUGIN.json')){
      if($required -notin $names){throw "generated plugin ZIP missing $required"}
    }
  }finally{$archive.Dispose()}

  if($KeepDirectory){
    $dir=Join-Path $OutputDirectory $safeName
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $stage -Destination $dir -Recurse -Force
  }
  [ordered]@{
    ok=$true
    pluginName=$safeName
    displayName=[string]$result.displayName
    deviceName=[string]$result.deviceName
    profile=[string]$result.profile
    fingerprint=[string]$result.fingerprint
    brandColor=[string]$result.brandColor
    zip=$zip
    sha256=$hash
    bytes=(Get-Item -LiteralPath $zip).Length
    appId=[string]$result.appId
    secretsIncluded=$false
  } | ConvertTo-Json -Compress
  Write-Host "DEVICE_PLUGIN_ZIP_PASS path=$zip sha256=$hash name=$safeName"
}finally{
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
