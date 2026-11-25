param(
  [Parameter(Mandatory=$true)][string]$SourcePath
)
$ErrorActionPreference='Stop'
$path=[IO.Path]::GetFullPath($SourcePath)
if(-not(Test-Path -LiteralPath $path -PathType Leaf)){throw 'DESKTOP_VERSION_SOURCE_MISSING'}
$source=[IO.File]::ReadAllText($path)
$tokens=$null; $parseErrors=$null
[void][System.Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw ('DESKTOP_VERSION_SOURCE_PARSE_FAILED '+($parseErrors|ForEach-Object Message -join ';'))}
$function=[regex]::Match($source,'(?ms)^function Convert-DesktopNumericVersion\([^\r\n]*\)\s*\{.*?^\}')
if(-not$function.Success){throw 'DESKTOP_VERSION_FUNCTION_NOT_FOUND'}
. ([scriptblock]::Create($function.Value))
$expected=@(
  [pscustomobject]@{source='0.12.0-dev.9';file='0.12.0.9'},
  [pscustomobject]@{source='0.11.0-dev.105';file='0.11.0.105'},
  [pscustomobject]@{source='0.12.0-rc.9';file='0.12.0.9'},
  [pscustomobject]@{source='1.0.0';file='1.0.0.0'},
  [pscustomobject]@{source='1.3.4-dev.65535';file='1.3.4.65535'}
)
foreach($case in $expected){
  $actual=Convert-DesktopNumericVersion $case.source
  if($actual -cne $case.file){throw "DESKTOP_NUMERIC_VERSION_MISMATCH $($case.source) $actual"}
}
$invalid=@('0.12.0-dev.0','0.12.0-dev.01','0.12.0-dev.65536',
           '65536.0.0','1.2.65536','1.2.3-preview.1','1.2','v1.0.0','1.2.3.4','01.2.3')
foreach($inputVersion in $invalid){
  $rejected=$false
  try{[void](Convert-DesktopNumericVersion $inputVersion)}
  catch{$rejected=($_.Exception.Message -match '^DESKTOP_BUILD_(?:SOURCE_VERSION|FILE_VERSION_RANGE)_INVALID$')}
  if(-not$rejected){throw "DESKTOP_INVALID_VERSION_ACCEPTED $inputVersion"}
}
foreach($needle in @(
  '-p:Version=$Version',
  '-p:FileVersion=$FileVersion',
  '-p:AssemblyVersion=$FileVersion',
  "throw 'DESKTOP_BUILD_OUTPUT_EXISTS_NO_DESTRUCTIVE_CLEANUP'"
)){
  if(-not$source.Contains($needle)){throw "DESKTOP_BUILD_CONTRACT_MISSING $needle"}
}
if($source -match 'Remove-Item\s+-LiteralPath\s+\$OutputDir\s+-Recurse' -or
   $source.Contains('FileVersion="$Version.0"')){
  throw 'DESKTOP_BUILD_LEGACY_UNSAFE_PATH'
}
Write-Output ('DESKTOP_BUILD_VERSION_PASS valid='+$expected.Count+' invalid='+$invalid.Count+' safeOutput=true')
