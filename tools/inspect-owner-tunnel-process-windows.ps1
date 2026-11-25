# Exact read-only Windows owner Tunnel-client process/loopback health-port proof.
# No credentials, environment, private key, API requests or process mutation.
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')][string]$Profile,
 [Parameter(Mandatory=$true)][ValidateRange(1024,65535)][int]$HealthPort
)
$ErrorActionPreference='Stop'
$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$all=@(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'")
$matched=@()
foreach($p in $all){
 $matchesProfile=[regex]::Matches([string]$p.CommandLine,'(?:^|\s)--profile\s+["'']?([A-Za-z0-9._-]+)')
 if($matchesProfile.Count -ne 1){continue}
 if($matchesProfile[0].Groups[1].Value -cne $Profile){continue}
 $matched+=,$p
}
if($matched.Count -ne 1){throw 'RC012_WINDOWS_TUNNEL_PROCESS_AMBIGUOUS'}
$p=$matched[0]
$owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid
if($owner.ReturnValue -ne 0 -or $owner.Sid -cne $me){throw 'RC012_WINDOWS_TUNNEL_OS_OWNER_MISMATCH'}
$tcp=@(Get-NetTCPConnection -State Listen -LocalPort $HealthPort -ErrorAction Stop |
 Where-Object {$_.LocalAddress -eq '127.0.0.1'})
if($tcp.Count -ne 1 -or $tcp[0].OwningProcess -ne $p.ProcessId){
 throw 'RC012_WINDOWS_TUNNEL_HEALTH_SOCKET_NOT_PINN'
}
$exe=[string]$p.ExecutablePath
if(-not [IO.Path]::IsPathRooted($exe)){throw 'RC012_WINDOWS_TUNNEL_EXE_UNAVAILABLE'}
$file=Get-Item -LiteralPath $exe -ErrorAction Stop
if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)){
 throw 'RC012_WINDOWS_TUNNEL_EXE_UNTRUSTED'
}
$sha=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
$started=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()
if($started -le 0){throw 'RC012_WINDOWS_TUNNEL_STARTED_AT_INVALID'}
[pscustomobject]@{
 schema=1; source='windows-native-owner-cim-tcp'; profileId=$Profile
 pid=[int]$p.ProcessId; startedAtMs=[long]$started
 executablePath=$file.FullName; executableSha256=$sha
 healthPort=$HealthPort; socketOwned=$true; processOwned=$true
 matchCount=1
} | ConvertTo-Json -Compress -Depth 3
