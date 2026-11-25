param(
  [string]$Runtime = 'win-x64',
  [string]$OutputDir = ''
)
$ErrorActionPreference='Stop'
$Root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Version=((Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version)
function Convert-DesktopNumericVersion([string]$SourceVersion) {
  $match=[regex]::Match($SourceVersion,'^(?<major>0|[1-9][0-9]*)\.(?<minor>0|[1-9][0-9]*)\.(?<patch>0|[1-9][0-9]*)(?:-(?:dev|rc)\.(?<revision>[1-9][0-9]*))?$')
  if(-not $match.Success){throw 'DESKTOP_BUILD_SOURCE_VERSION_INVALID'}
  $parts=@($match.Groups['major'].Value,$match.Groups['minor'].Value,$match.Groups['patch'].Value)
  $parts+=if($match.Groups['revision'].Success){$match.Groups['revision'].Value}else{'0'}
  foreach($part in $parts){
    $number=[uint32]0
    if(-not [uint32]::TryParse($part,[ref]$number) -or $number -gt 65535){throw 'DESKTOP_BUILD_FILE_VERSION_RANGE_INVALID'}
  }
  return ($parts -join '.')
}
$FileVersion=Convert-DesktopNumericVersion $Version
if(-not $OutputDir){$OutputDir=Join-Path $Root 'dist\desktop\remote-commander-windows-x64'}
$OutputDir=[IO.Path]::GetFullPath($OutputDir)
if(Test-Path -LiteralPath $OutputDir){throw 'DESKTOP_BUILD_OUTPUT_EXISTS_NO_DESTRUCTIVE_CLEANUP'}
dotnet publish (Join-Path $Root 'desktop\RemoteCommanderDashboard\RemoteCommanderDashboard.csproj') -c Release -r $Runtime --self-contained true -p:PublishSingleFile=true -p:DebugType=None -p:DebugSymbols=false -p:Version=$Version -p:FileVersion=$FileVersion -p:AssemblyVersion=$FileVersion -o $OutputDir
if($LASTEXITCODE -ne 0){throw "dotnet publish failed: $LASTEXITCODE"}
foreach($name in @('profile-manager-windows.ps1','profile-enrollment-windows.ps1','profile-display-names.ps1','operations-monitor-windows.ps1','admin-runtime-windows.ps1')){
  $source=Join-Path $Root (Join-Path 'desktop' $name)
  if(-not(Test-Path -LiteralPath $source -PathType Leaf)){throw "Desktop tool missing: $name"}
  Copy-Item -LiteralPath $source -Destination (Join-Path $OutputDir $name) -Force
}
$Exe=Join-Path $OutputDir 'RemoteCommander.exe'
if(-not (Test-Path -LiteralPath $Exe -PathType Leaf)){throw 'RemoteCommander.exe missing after publish'}
$Sha=(Get-FileHash -Algorithm SHA256 -LiteralPath $Exe).Hash.ToLowerInvariant()
Write-Output "REMOTE_COMMANDER_DESKTOP_BUILD_PASS version=$Version exe=$Exe sha256=$Sha"
