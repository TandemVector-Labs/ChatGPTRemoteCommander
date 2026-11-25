$ErrorActionPreference='Stop'
if(-not $env:RC_BROWSER_CORE){
 $candidates=@(
  (Join-Path $PSScriptRoot '..\..\src\browser-tools.mjs'),
  (Join-Path $HOME 'source\repos\ChatGPTRemoteCommander\src\browser-tools.mjs')
 )
 foreach($c in $candidates){if(Test-Path -LiteralPath $c){$env:RC_BROWSER_CORE=(Resolve-Path -LiteralPath $c).Path;break}}
}
& node (Join-Path $PSScriptRoot 'cli.mjs') @args
exit $LASTEXITCODE
