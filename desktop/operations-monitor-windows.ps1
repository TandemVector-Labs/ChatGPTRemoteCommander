Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$ErrorActionPreference='Stop'

$StateRoot=Join-Path $env:LOCALAPPDATA 'ChatGPTRemoteCommander'
$CoreRoot=Join-Path $StateRoot 'app'
$RoutingRoot=Join-Path $StateRoot 'routing'
$Cli=Join-Path $CoreRoot 'tools\workflow-cli.mjs'

$form=New-Object Windows.Forms.Form
$form.Text='Remote Commander — Operations Monitor'
$form.StartPosition='CenterScreen'
$form.Size=New-Object Drawing.Size(1220,760)
$form.MinimumSize=New-Object Drawing.Size(1000,620)
$form.BackColor=[Drawing.Color]::FromArgb(16,23,34)
$form.ForeColor=[Drawing.Color]::Gainsboro
$form.Font=New-Object Drawing.Font('Segoe UI',10)

$title=New-Object Windows.Forms.Label
$title.Text='Projects & durable workflow monitor'
$title.Font=New-Object Drawing.Font('Segoe UI Semibold',18);$title.AutoSize=$true;$title.Location=New-Object Drawing.Point(24,18);$form.Controls.Add($title)

$summary=New-Object Windows.Forms.Label
$summary.AutoSize=$false;$summary.Location=New-Object Drawing.Point(26,58);$summary.Size=New-Object Drawing.Size(1150,66)
$summary.ForeColor=[Drawing.Color]::FromArgb(155,180,210);$form.Controls.Add($summary)

$filterLabel=New-Object Windows.Forms.Label;$filterLabel.Text='Filter';$filterLabel.AutoSize=$true;$filterLabel.Location=New-Object Drawing.Point(24,136);$form.Controls.Add($filterLabel)
$filter=New-Object Windows.Forms.TextBox;$filter.Location=New-Object Drawing.Point(78,132);$filter.Size=New-Object Drawing.Size(370,30);$form.Controls.Add($filter)
$refresh=New-Object Windows.Forms.Button;$refresh.Text='Refresh';$refresh.Location=New-Object Drawing.Point(465,130);$refresh.Size=New-Object Drawing.Size(110,32);$refresh.FlatStyle='Flat';$form.Controls.Add($refresh)

$grid=New-Object Windows.Forms.DataGridView
$grid.Location=New-Object Drawing.Point(24,176);$grid.Size=New-Object Drawing.Size(1150,500)
$grid.Anchor='Top,Bottom,Left,Right';$grid.ReadOnly=$true;$grid.AllowUserToAddRows=$false;$grid.AllowUserToDeleteRows=$false
$grid.SelectionMode='FullRowSelect';$grid.MultiSelect=$false;$grid.AutoSizeColumnsMode='Fill'
$grid.BackgroundColor=[Drawing.Color]::FromArgb(20,29,43);$grid.BorderStyle='FixedSingle';$form.Controls.Add($grid)

$status=New-Object Windows.Forms.Label;$status.Text='Ready';$status.AutoSize=$false;$status.Location=New-Object Drawing.Point(24,690);$status.Size=New-Object Drawing.Size(1150,34)
$status.Anchor='Left,Right,Bottom';$status.ForeColor=[Drawing.Color]::FromArgb(120,195,245);$form.Controls.Add($status)

$script:all=@()
$script:monitorIssues=@()
function Read-Json([string]$Path){try{Get-Content -LiteralPath $Path -Raw|ConvertFrom-Json}catch{return $null}}
function Invoke-Cli([string]$Config,[string]$Action){
  if(-not(Test-Path -LiteralPath $Cli -PathType Leaf)){throw "workflow-cli missing: $Cli"}
  $stderrPath=[IO.Path]::GetTempFileName()
  try{
    $raw=@(& node.exe $Cli $Config $Action 2> $stderrPath)
    $exitCode=$LASTEXITCODE
    if($exitCode -ne 0){
      $diagnostic=Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue
      throw ("Workflow CLI exit ${exitCode}: "+(($raw|Out-String).Trim())+" "+$diagnostic)
    }
    return (($raw|Out-String)|ConvertFrom-Json)
  }finally{
    Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
  }
}
function Apply-Filter{
  $q=$filter.Text.Trim()
  $items=if($q){@($script:all|Where-Object{($_.Profile+' '+$_.Id+' '+$_.Lifecycle+' '+$_.LastFailure) -like "*$q*"})}else{@($script:all)}
  $grid.DataSource=$null
  $rows=[Collections.ArrayList]::new()
  foreach($item in @($items)){[void]$rows.Add($item)}
  $grid.DataSource=$rows
  $status.Text="Showing $($items.Count) of $($script:all.Count) persisted workflow records. 'RUNNING' is persisted lifecycle, not proof of a live process."
  if($script:monitorIssues.Count -gt 0){$status.Text="DEGRADED ($($script:monitorIssues.Count) issue(s)): "+$status.Text}
}
function Refresh-Monitor{
  try{
    $rows=@();$summaries=@()
    if(-not(Test-Path $RoutingRoot)){throw 'Routing state is unavailable.'}
    $routes=@(Get-ChildItem $RoutingRoot -Filter '*.json' -File|Where-Object{$_.Name -notlike '*.runtime.json'}|Sort-Object Name)
    foreach($f in $routes){
      $route=Read-Json $f.FullName
      if($null -eq $route -or [string]::IsNullOrWhiteSpace([string]$route.profile)){
        $summaries+=("$($f.BaseName): MONITOR_ERROR invalid route JSON or missing profile");continue
      }
      $profile=[string]$route.profile
      if([string]::IsNullOrWhiteSpace([string]$route.active.configPath) -or -not(Test-Path -LiteralPath ([string]$route.active.configPath) -PathType Leaf)){
        $summaries+=("${profile}: MONITOR_ERROR missing workflow config");continue
      }
      try{
        $st=Invoke-Cli ([string]$route.active.configPath) 'status'
        $list=@(Invoke-Cli ([string]$route.active.configPath) 'list')
        $ss=$st.schedulerState
        $summaries+=("${profile}: scheduler=$($ss.enabled), automaticExecution=$($st.automaticExecution), runner=$($st.runnerConfigured), nonterminal=$($ss.persistedNonterminal), interrupted=$($ss.interrupted), reconcile=$($ss.reconciliationRequired), leases=$($ss.currentLeases)")
        foreach($w in $list){
          $rows+=[pscustomobject]@{
            Profile=$profile;Id=[string]$w.id;Lifecycle=[string]$w.lifecycle;Revision=[int]$w.revision
            Scheduled=[bool]$w.schedulerEnabled;LastFailure=[string]$w.lastFailure
          }
        }
      }catch{
        $summaries+=("${profile}: MONITOR_ERROR $($_.Exception.Message)")
      }
    }
    if ($routes.Count -eq 0) { $summaries += 'NO_PROFILES: No routing profiles were discovered.' }
    $script:all=@($rows|Sort-Object Profile,Lifecycle,Id)
    $script:monitorIssues=@($summaries|Where-Object{$_ -match 'MONITOR_ERROR|NO_PROFILES'})
    $summary.Text=($summaries -join [Environment]::NewLine)
    Apply-Filter
  }catch{
    $script:all=@();$script:monitorIssues=@('MONITOR_ERROR')
    $grid.DataSource=$null;$summary.Text='MONITOR_ERROR: Refresh unavailable'
    $status.Text="DEGRADED: Refresh failed: $($_.Exception.Message)"
  }
}
$refresh.Add_Click({Refresh-Monitor})
$filter.Add_TextChanged({Apply-Filter})
Refresh-Monitor
[void]$form.ShowDialog()
