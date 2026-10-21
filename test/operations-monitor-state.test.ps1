$ErrorActionPreference='Stop'
$script:passed=0
function Assert-Monitor([bool]$Condition,[string]$Label){if(-not $Condition){throw ('MONITOR_TEST_FAIL: '+$Label)};$script:passed++}
$monitor=Join-Path $PSScriptRoot '..\desktop\operations-monitor-windows.ps1'
$tok=$null;$parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $monitor),[ref]$tok,[ref]$parseErrors)
Assert-Monitor ($parseErrors.Count -eq 0) 'production PowerShell syntax'
$definitions=@($ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true))
foreach($name in @('Read-Json','Apply-Filter','Refresh-Monitor')){
  $matches=@($definitions | Where-Object {$_.Name -eq $name})
  Assert-Monitor ($matches.Count -eq 1) ('single production function '+$name)
  . ([scriptblock]::Create($matches[0].Extent.Text))
}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('rc-monitor-fixture-'+[guid]::NewGuid().ToString('N'))
$script:RoutingRoot=Join-Path $temp 'routes'
$script:all=@();$script:monitorIssues=@()
$script:grid=[pscustomobject]@{DataSource=$null}
$script:status=[pscustomobject]@{Text=''}
$script:summary=[pscustomobject]@{Text=''}
$script:filter=[pscustomobject]@{Text=''}
function Invoke-Cli([string]$Config,[string]$Action){
  if($Config -like '*broken*'){throw 'synthetic CLI failure'}
  if($Action -eq 'status'){return [pscustomobject]@{automaticExecution=$false;runnerConfigured=$false;schedulerState=[pscustomobject]@{enabled=$true;persistedNonterminal=1;interrupted=0;reconciliationRequired=0;currentLeases=0}}}
  if($Action -eq 'list'){return [pscustomobject]@{id='fixture-workflow';lifecycle='RUNNING';revision=2;schedulerEnabled=$true;lastFailure=''}}
  throw 'unknown mock action'
}
try{
  New-Item -ItemType Directory -Path $script:RoutingRoot -Force|Out-Null
  Refresh-Monitor
  Assert-Monitor ($status.Text -match '^DEGRADED') 'empty profiles fail closed'
  Assert-Monitor ($summary.Text -match 'NO_PROFILES') 'empty reason visible'
  $brokenConfig=Join-Path $temp 'missing.config.json'
  @{profile='missing';active=@{configPath=$brokenConfig}}|ConvertTo-Json -Depth 4|Set-Content (Join-Path $script:RoutingRoot 'missing.json')
  Refresh-Monitor
  Assert-Monitor ($status.Text -match '^DEGRADED') 'missing config fail closed'
  Assert-Monitor ($summary.Text -match 'missing workflow config') 'missing reason visible'
  Set-Content (Join-Path $script:RoutingRoot 'missing.json') '{malformed'
  Refresh-Monitor
  Assert-Monitor ($summary.Text -match 'invalid route JSON') 'malformed route visible'
  Remove-Item (Join-Path $script:RoutingRoot 'missing.json')
  $config=Join-Path $temp 'healthy.config.json';Set-Content $config '{}'
  @{profile='healthy';active=@{configPath=$config}}|ConvertTo-Json -Depth 4|Set-Content (Join-Path $script:RoutingRoot 'healthy.json')
  Refresh-Monitor
  Assert-Monitor ($status.Text -notmatch '^DEGRADED') 'healthy route no false alarm'
  Assert-Monitor ($script:all.Count -eq 1 -and $script:all[0].Lifecycle -eq 'RUNNING') 'workflow record rendered'
  Assert-Monitor ($status.Text -match 'not proof of a live process') 'persisted not live disclaimer retained'
  $filter.Text='absent';Apply-Filter
  Assert-Monitor ($status.Text -match 'Showing 0 of 1' -and $status.Text -notmatch 'DEGRADED') 'healthy filter works'
  $filter.Text='';$failConfig=Join-Path $temp 'broken.config.json';Set-Content $failConfig '{}'
  @{profile='failing';active=@{configPath=$failConfig}}|ConvertTo-Json -Depth 4|Set-Content (Join-Path $script:RoutingRoot 'failing.json')
  Refresh-Monitor
  Assert-Monitor ($status.Text -match '^DEGRADED' -and $script:all.Count -eq 1) 'partial read visible as degraded'
  $filter.Text='absent';Apply-Filter
  Assert-Monitor ($status.Text -match '^DEGRADED') 'filter retains degraded warning'
  Remove-Item $script:RoutingRoot -Recurse -Force
  Refresh-Monitor
  Assert-Monitor ($status.Text -match '^DEGRADED: Refresh failed') 'root outage visible'
  Assert-Monitor ($script:all.Count -eq 0 -and $null -eq $grid.DataSource) 'stale records cleared after root outage'
  Write-Output ('OPERATIONS_MONITOR_BEHAVIOR_PASS checks='+$script:passed)
}finally{if(Test-Path $temp){Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue}}
