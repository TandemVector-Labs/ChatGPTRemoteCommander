Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$ErrorActionPreference='Stop'
$StateRoot=Join-Path $env:LOCALAPPDATA 'ChatGPTRemoteCommander'
$CoreRoot=Join-Path $StateRoot 'app'
$RoutingRoot=Join-Path $StateRoot 'routing'
$InstanceRoot=Join-Path $StateRoot 'instances'
$ProfileDir=Join-Path $env:APPDATA 'tunnel-client'

function Read-Json([string]$Path){
  if(-not(Test-Path -LiteralPath $Path -PathType Leaf)){return $null}
  try{return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json}catch{return $null}
}
function Read-ProfilePort([string]$Profile){
  $file=Join-Path $ProfileDir "$Profile.yaml"
  if(-not(Test-Path -LiteralPath $file -PathType Leaf)){return 0}
  $m=[regex]::Match((Get-Content -LiteralPath $file -Raw),'listen_addr:\s*["'']?127\.0\.0\.1:(\d+)')
  if($m.Success){return [int]$m.Groups[1].Value}
  return 0
}
function Read-TunnelBackendPort([string]$Profile){
  $file=Join-Path $ProfileDir "$Profile.yaml"
  if(-not(Test-Path -LiteralPath $file -PathType Leaf)){return 0}
  try{
    $raw=Get-Content -LiteralPath $file -Raw
    $m=[regex]::Match($raw,'url:\s*["'']?http://127\.0\.0\.1:(\d+)/mcp')
    if($m.Success){return [int]$m.Groups[1].Value}
  }catch{}
  return 0
}
function Get-ConfigForProfile([string]$Profile,[object]$Route,[object]$Instance){
  $candidates=@()
  if($Route -and $Route.active -and $Route.active.configPath){$candidates+=[string]$Route.active.configPath}
  if($Instance -and $Instance.configPath){$candidates+=[string]$Instance.configPath}
  if($Profile -eq 'default'){$candidates+=Join-Path $CoreRoot 'config.local.json';$candidates+=Join-Path $CoreRoot 'config.json'}
  foreach($p in $candidates){if($p -and (Test-Path -LiteralPath $p -PathType Leaf)){return Read-Json $p}}
  return $null
}
function Test-Cap([object]$Config,[string]$Cap){
  if(-not $Config){return $false}
  return @($Config.capabilityProfile.grantedCapabilities) -contains $Cap
}
function Get-Profiles{
  $names=[System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  [void]$names.Add('default')
  if(Test-Path $ProfileDir){Get-ChildItem $ProfileDir -Filter '*.yaml' -File -ErrorAction SilentlyContinue|ForEach-Object{[void]$names.Add($_.BaseName)}}
  if(Test-Path $RoutingRoot){Get-ChildItem $RoutingRoot -Filter '*.json' -File -ErrorAction SilentlyContinue|Where-Object{$_.Name -notlike '*.runtime.json'}|ForEach-Object{[void]$names.Add($_.BaseName)}}
  if(Test-Path $InstanceRoot){Get-ChildItem $InstanceRoot -Directory -ErrorAction SilentlyContinue|ForEach-Object{[void]$names.Add($_.Name)}}
  foreach($name in @($names|Sort-Object)){
    $route=Read-Json (Join-Path $RoutingRoot "$name.json")
    $instance=Read-Json (Join-Path (Join-Path $InstanceRoot $name) 'instance.json')
    $cfg=Get-ConfigForProfile $name $route $instance
    $isInherited=$false;$baseRoute=$null
    $tunnelPort=Read-TunnelBackendPort $name
    # Shared account tunnels that point to default cannot have separate access policy.
    if(-not $cfg -and -not $route -and -not $instance -and $name -ne 'default' -and $tunnelPort -eq 47831){
      $baseRoute=Read-Json (Join-Path $RoutingRoot 'default.json')
      $base=Get-ConfigForProfile 'default' $baseRoute $null
      if($base -and $baseRoute.active.configPath){
        $cfg=$base;$isInherited=$true
      }
    }
    $health=Read-ProfilePort $name
    $port=if($route -and $route.active){[int]$route.active.port}elseif($instance){[int]$instance.mcpPort}elseif($isInherited){$tunnelPort}else{0}
    $version=if($route -and $route.active){[string]$route.active.version}elseif($isInherited){[string]$baseRoute.active.version}else{'UNVERIFIED'}
    $gen=if($route){[int]$route.generation}else{0}
    $type=if($name -eq 'default'){'Primary'}elseif($instance){'Isolated'}elseif($isInherited){'Shared (inherited)'}else{'Shared (unverified)'}
    $caps=@($cfg.capabilityProfile.grantedCapabilities)
    [pscustomobject]@{
      Profile=$name;Type=$type;McpPort=$port;HealthPort=$health;Version=$version;Generation=$gen
      Access=if(-not $cfg){'UNVERIFIED'}elseif($isInherited){if($cfg.powerMode.enabled){'Inherited Full Power'}else{'Inherited Standard'}}elseif($cfg.powerMode.enabled){'Full Power'}else{'Standard'}
      Gui=[bool]$cfg.powerMode.guiControl.enabled
      Capabilities=($caps -join ',')
      ConfigPath=if($route -and $route.active){[string]$route.active.configPath}elseif($instance){[string]$instance.configPath}elseif($isInherited){[string]$baseRoute.active.configPath}else{''}
      ProjectDir=if($route -and $route.active){[string]$route.active.projectDir}else{$CoreRoot}
      Commit=if($route -and $route.active){[string]$route.active.commit}else{''}
      RouteVersion=$version
      IsPrimary=($name -eq 'default')
      IsIsolated=[bool]$instance
    }
  }
  # Independent headless worker is neither an account tunnel nor an editable profile.
  foreach($dir in @('C:\ProgramData\ChatGPTRemoteCommander\server-headless-v1',(Join-Path $StateRoot 'server-headless-v1'))){
    $config=Join-Path $dir 'config.json'
    $worker=Read-Json $config
    if($worker -and $worker.instance.profile -eq 'server-headless' -and [int]$worker.port -eq 48971){
      [pscustomobject]@{
        Profile='server-headless';Type='Headless worker (read-only)'
        McpPort=48971;HealthPort=0;Version='INDEPENDENT';Generation=0
        Access=if($worker.powerMode.enabled){'Worker Full Power'}else{'Worker Restricted'}
        Gui=$false;Capabilities=(@($worker.capabilityProfile.grantedCapabilities) -join ',')
        ConfigPath=$config;ProjectDir=$dir;Commit='';RouteVersion='INDEPENDENT'
        IsPrimary=$false;IsIsolated=$false
      }
      break
    }
  }
}

# A disabled GUI button is not an authorization boundary. Re-evaluate the
# account ownership and config fingerprint before invoking any mutating tool.
function Assert-EditableSelection([object]$Selection,[object[]]$Rows,[string]$ExpectedHash){
  if(-not $Selection -or -not ($Selection.IsPrimary -or $Selection.IsIsolated)){
    throw 'Shared account, headless worker, or unknown profile is read-only.'
  }
  $matches=@($Rows|Where-Object {$_.Profile -eq $Selection.Profile})
  if($matches.Count -ne 1){throw 'Selected profile is no longer uniquely present.'}
  $fresh=$matches[0]
  if(-not ($fresh.IsPrimary -or $fresh.IsIsolated) -or
     [bool]$fresh.IsPrimary -ne [bool]$Selection.IsPrimary -or
     [bool]$fresh.IsIsolated -ne [bool]$Selection.IsIsolated -or
     [string]$fresh.ConfigPath -ne [string]$Selection.ConfigPath -or
     [string]$fresh.Commit -ne [string]$Selection.Commit -or
     [int]$fresh.Generation -ne [int]$Selection.Generation){
    throw 'Profile route or permission boundary changed. Refresh first.'
  }
  $file=[string]$fresh.ConfigPath
  if(-not $file -or -not(Test-Path -LiteralPath $file -PathType Leaf) -or
     (Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint){
    throw 'Profile config path is missing or redirected.'
  }
  if(-not $ExpectedHash -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $ExpectedHash){
    throw 'Profile policy changed after selection. Refresh first.'
  }
  return $true
}
$form=New-Object Windows.Forms.Form
$form.Text='Remote Commander — Profiles & Access'
$form.StartPosition='CenterScreen'
$form.Size=New-Object Drawing.Size(1180,780)
$form.MinimumSize=New-Object Drawing.Size(1040,680)
$form.BackColor=[Drawing.Color]::FromArgb(16,23,34)
$form.ForeColor=[Drawing.Color]::Gainsboro
$form.Font=New-Object Drawing.Font('Segoe UI',10)

$title=New-Object Windows.Forms.Label
$title.Text='Profiles, permissions and runtime authority'
$title.Font=New-Object Drawing.Font('Segoe UI Semibold',18)
$title.AutoSize=$true;$title.Location=New-Object Drawing.Point(24,20);$form.Controls.Add($title)
$subtitle=New-Object Windows.Forms.Label
$subtitle.Text='Primary changes use qualified candidate cutover. Isolated profiles use transactional reconfigure + rollback.'
$subtitle.AutoSize=$true;$subtitle.ForeColor=[Drawing.Color]::FromArgb(155,170,190);$subtitle.Location=New-Object Drawing.Point(26,58);$form.Controls.Add($subtitle)

$grid=New-Object Windows.Forms.DataGridView
$grid.Location=New-Object Drawing.Point(24,92);$grid.Size=New-Object Drawing.Size(1120,245)
$grid.Anchor='Top,Left,Right'
$grid.ReadOnly=$true;$grid.AllowUserToAddRows=$false;$grid.AllowUserToDeleteRows=$false
$grid.SelectionMode='FullRowSelect';$grid.MultiSelect=$false;$grid.AutoSizeColumnsMode='Fill'
$grid.BackgroundColor=[Drawing.Color]::FromArgb(20,29,43);$grid.BorderStyle='FixedSingle'
$grid.EnableHeadersVisualStyles=$false
$grid.ColumnHeadersDefaultCellStyle.BackColor=[Drawing.Color]::FromArgb(35,50,70)
$grid.ColumnHeadersDefaultCellStyle.ForeColor=[Drawing.Color]::White
$grid.DefaultCellStyle.BackColor=[Drawing.Color]::FromArgb(24,35,50)
$grid.DefaultCellStyle.ForeColor=[Drawing.Color]::Gainsboro
$grid.DefaultCellStyle.SelectionBackColor=[Drawing.Color]::FromArgb(45,101,160)
$grid.DefaultCellStyle.SelectionForeColor=[Drawing.Color]::White
$grid.AlternatingRowsDefaultCellStyle.BackColor=[Drawing.Color]::FromArgb(28,42,58)
$grid.RowHeadersDefaultCellStyle.BackColor=[Drawing.Color]::FromArgb(35,50,70)
$grid.RowHeadersDefaultCellStyle.ForeColor=[Drawing.Color]::White
$grid.GridColor=[Drawing.Color]::FromArgb(60,75,93)
$form.Controls.Add($grid)

$access=New-Object Windows.Forms.GroupBox
$access.Text='Selected profile access';$access.Location=New-Object Drawing.Point(24,350);$access.Size=New-Object Drawing.Size(760,300)
$access.Anchor='Top,Left,Right';$form.Controls.Add($access)

$power=New-Object Windows.Forms.CheckBox;$power.Text='Full Power';$power.Location=New-Object Drawing.Point(20,34);$power.AutoSize=$true;$access.Controls.Add($power)
$gui=New-Object Windows.Forms.CheckBox;$gui.Text='GUI control';$gui.Location=New-Object Drawing.Point(150,34);$gui.AutoSize=$true;$access.Controls.Add($gui)

$defs=@(
  @('Full filesystem','filesystem.full'),
  @('Shell execute','shell.execute'),
  @('Process control','process.control'),
  @('Permanent delete','filesystem.permanent_delete'),
  @('Browser automation','browser.background'),
  @('Browser navigation','browser.navigate'),
  @('Browser input','browser.input'),
  @('Browser screenshots','browser.screenshot'),
  @('Workflow scheduler','workflow.scheduler'),
  @('Project engine','workflow.project_engine'),
  @('Auto update','lifecycle.auto_update'),
  @('Zero-downtime update','lifecycle.zero_downtime_update')
)
$capBoxes=@{}
for($i=0;$i -lt $defs.Count;$i++){
  $box=New-Object Windows.Forms.CheckBox
  $box.Text=$defs[$i][0];$box.Tag=$defs[$i][1];$box.AutoSize=$true
  $col=$i%3;$row=[math]::Floor($i/3)
  $box.Location=New-Object Drawing.Point((20+$col*235),(76+$row*38))
  $access.Controls.Add($box);$capBoxes[$defs[$i][1]]=$box
}

$rootsLabel=New-Object Windows.Forms.Label;$rootsLabel.Text='Allowed roots (one per line)';$rootsLabel.AutoSize=$true;$rootsLabel.Location=New-Object Drawing.Point(20,230);$access.Controls.Add($rootsLabel)
$roots=New-Object Windows.Forms.TextBox;$roots.Multiline=$true;$roots.ScrollBars='Vertical';$roots.Location=New-Object Drawing.Point(210,226);$roots.Size=New-Object Drawing.Size(525,55);$access.Controls.Add($roots)

$actions=New-Object Windows.Forms.GroupBox
$actions.Text='Actions';$actions.Location=New-Object Drawing.Point(800,350);$actions.Size=New-Object Drawing.Size(344,300);$actions.Anchor='Top,Right';$form.Controls.Add($actions)
function Add-Button([string]$Text,[int]$Y){
  $b=New-Object Windows.Forms.Button;$b.Text=$Text;$b.Location=New-Object Drawing.Point(20,$Y);$b.Size=New-Object Drawing.Size(304,36);$b.FlatStyle='Flat'
  $b.BackColor=[Drawing.Color]::FromArgb(34,48,70);$b.ForeColor=[Drawing.Color]::White;$actions.Controls.Add($b);return $b
}
$apply=Add-Button 'Apply selected access policy' 30
$add=Add-Button 'Add / isolate profile' 74
$open=Add-Button 'Open profile data' 118
$monitor=Add-Button 'Operations monitor' 162
$admin=Add-Button 'Admin runtime' 206
$refresh=Add-Button 'Refresh' 250

$status=New-Object Windows.Forms.Label
$status.Text='Ready';$status.AutoSize=$false;$status.Location=New-Object Drawing.Point(24,668);$status.Size=New-Object Drawing.Size(1120,60);$status.Anchor='Left,Right,Bottom'
$status.ForeColor=[Drawing.Color]::FromArgb(140,190,245);$form.Controls.Add($status)

$script:selected=$null
function Update-Editor{
  if(-not $grid.CurrentRow){return}
  $script:selected=$grid.CurrentRow.DataBoundItem
  if(-not $script:selected){return}
  $cfg=if($script:selected.ConfigPath){Read-Json $script:selected.ConfigPath}else{$null}
  $script:selectedFingerprint=if($script:selected.ConfigPath -and (Test-Path -LiteralPath $script:selected.ConfigPath -PathType Leaf)){(Get-FileHash -LiteralPath $script:selected.ConfigPath -Algorithm SHA256).Hash}else{""}
  $power.Checked=[bool]$cfg.powerMode.enabled
  $gui.Checked=[bool]$cfg.powerMode.guiControl.enabled
  foreach($cap in $capBoxes.Keys){$capBoxes[$cap].Checked=Test-Cap $cfg $cap}
  $roots.Text=(@($cfg.allowedRoots)-join [Environment]::NewLine)
  $canEdit=$script:selected.IsPrimary -or $script:selected.IsIsolated
  $power.Enabled=$canEdit;$gui.Enabled=$canEdit;$roots.Enabled=$canEdit;$apply.Enabled=$canEdit
  foreach($b in $capBoxes.Values){$b.Enabled=$canEdit -and $power.Checked}
  $status.Text="Selected $($script:selected.Profile) [$($script:selected.Type)] — $($script:selected.Access), v$($script:selected.Version), generation $($script:selected.Generation)"
}
$power.Add_CheckedChanged({foreach($b in $capBoxes.Values){$b.Enabled=$power.Enabled -and $power.Checked}})

function Refresh-Grid{
  try{
    $items=@(Get-Profiles)
    $grid.DataSource=$null;$grid.DataSource=[Collections.ArrayList]$items
    foreach($name in @('Capabilities','ConfigPath','ProjectDir','Commit','RouteVersion','IsPrimary','IsIsolated','Gui')){if($grid.Columns[$name]){$grid.Columns[$name].Visible=$false}}
    if($grid.Rows.Count -gt 0){
      $pick=0
      if($script:selected -and $script:selected.Profile){
        for($j=0;$j -lt $grid.Rows.Count;$j++){
          if([string]$grid.Rows[$j].Cells['Profile'].Value -eq [string]$script:selected.Profile){$pick=$j;break}
        }
      }
      $grid.Rows[$pick].Selected=$true;$grid.CurrentCell=$grid.Rows[$pick].Cells[0]
    }
    Update-Editor
    $status.Text="Profiles discovered: $($items.Count). Live profile inventory is authoritative; stale version labels are not treated as profiles."
  }catch{$status.Text="Refresh failed: $($_.Exception.Message)"}
}
$grid.Add_SelectionChanged({Update-Editor})

function Build-CapabilityChanges([object]$Cfg){
  $enable=@();$disable=@()
  foreach($cap in $capBoxes.Keys){
    $want=[bool]$capBoxes[$cap].Checked
    $has=Test-Cap $Cfg $cap
    if($want -and -not $has){$enable+=$cap}
    elseif(-not $want -and $has){$disable+=$cap}
  }
  return [pscustomobject]@{Enable=$enable;Disable=$disable}
}
function Invoke-HiddenPwsh([string]$Script,[string[]]$Arguments){
  $pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source
  $cmdArgs=@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$Script)+@($Arguments)
  $psi=[Diagnostics.ProcessStartInfo]::new()
  $psi.FileName=$pwsh;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
  $psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
  foreach($arg in $cmdArgs){[void]$psi.ArgumentList.Add([string]$arg)}
  $p=[Diagnostics.Process]::Start($psi)
  try{
    $stdoutTask=$p.StandardOutput.ReadToEndAsync()
    $stderrTask=$p.StandardError.ReadToEndAsync()
    $p.WaitForExit()
    $stdout=$stdoutTask.GetAwaiter().GetResult()
    $stderr=$stderrTask.GetAwaiter().GetResult()
    if($p.ExitCode -ne 0){
      $detail=if([string]::IsNullOrWhiteSpace($stderr)){$stdout}else{$stderr}
      $detail=($detail -split '\r?\n'|Where-Object {$_ -and $_.Trim()}|Select-Object -Last 4) -join ' | '
      if($detail.Length -gt 900){$detail=$detail.Substring($detail.Length-900)}
      throw "Profile command failed (exit $($p.ExitCode)): $detail"
    }
    return $p.ExitCode
  }finally{$p.Dispose()}
}

$apply.Add_Click({
  if(-not $script:selected){return}
  try{
    # Do not let an inherited account tunnel be edited via a stale form.
    [void](Assert-EditableSelection $script:selected @(Get-Profiles) $script:selectedFingerprint)
    $cfg=if($script:selected.ConfigPath){Read-Json $script:selected.ConfigPath}else{$null}
  $script:selectedFingerprint=if($script:selected.ConfigPath -and (Test-Path -LiteralPath $script:selected.ConfigPath -PathType Leaf)){(Get-FileHash -LiteralPath $script:selected.ConfigPath -Algorithm SHA256).Hash}else{""}
    if(-not $cfg){throw 'Selected profile config is unavailable.'}
    $changes=Build-CapabilityChanges $cfg
    $rootList=@($roots.Lines|ForEach-Object{[Environment]::ExpandEnvironmentVariables($_.Trim())}|Where-Object{$_})
    if($rootList.Count -eq 0){throw 'At least one allowed root is required.'}
    foreach($r in $rootList){if(-not [IO.Path]::IsPathFullyQualified($r)){throw "Allowed root must be an absolute path: $r"}}
    if($script:selected.IsPrimary){
      $updater=Join-Path $CoreRoot 'auto-update-windows.ps1'
      if(-not(Test-Path $updater)){throw 'Primary safe updater is unavailable.'}
      if(-not $script:selected.Commit){throw 'Primary route commit is unavailable.'}
      $ref=if([string]$script:selected.RouteVersion -match '^v'){$script:selected.RouteVersion}else{"v$($script:selected.RouteVersion)"}
      $args=@('-SourceRef',$ref,'-ExpectedCommit',$script:selected.Commit,'-Force','-TargetProfile','default')
      $args+=if($power.Checked){@('-PowerMode')}else{@('-StandardMode')}
      $args+=if($gui.Checked){@('-GuiControl')}else{@('-DisableGuiControl')}
      foreach($c in $changes.Enable){$args+=@('-EnableCapability',$c)}
      foreach($c in $changes.Disable){$args+=@('-DisableCapability',$c)}
      $status.Text='Applying primary access policy through qualified candidate cutover...'
      $form.Refresh()
      $rc=Invoke-HiddenPwsh $updater $args
      if($rc -ne 0){throw "Primary access update failed (exit $rc). See update logs."}
    }else{
      $script=Join-Path $CoreRoot 'reconfigure-profile-instance.ps1'
      if(-not(Test-Path $script)){throw 'Profile reconfigure script is unavailable.'}
      $args=@('-Profile',$script:selected.Profile)
      foreach($r in $rootList){$args+=@('-AllowedRoot',$r)}
      $args+=if($power.Checked){@('-PowerMode')}else{@('-StandardMode')}
      $args+=if($gui.Checked){@('-GuiControl')}else{@('-DisableGuiControl')}
      foreach($c in $changes.Enable){$args+=@('-EnableCapability',$c)}
      foreach($c in $changes.Disable){$args+=@('-DisableCapability',$c)}
      $status.Text='Applying isolated profile policy with rollback protection...';$form.Refresh()
      $rc=Invoke-HiddenPwsh $script $args
      if($rc -ne 0){throw "Profile reconfigure failed (exit $rc)."}
    }
    Refresh-Grid
    $status.Text="Access policy applied and read back for $($script:selected.Profile)."
  }catch{$status.Text="Apply failed: $($_.Exception.Message)"}
})

$add.Add_Click({
  try{
    $name=[Microsoft.VisualBasic.Interaction]::InputBox('Existing enrolled tunnel profile name to isolate:','Add / isolate profile','')
    if([string]::IsNullOrWhiteSpace($name)){return}
    if($name -eq 'default'){throw 'The primary profile is already managed.'}
    $script=Join-Path $CoreRoot 'configure-profile-instance.ps1'
    if(-not(Test-Path $script)){throw 'Isolation script is unavailable.'}
    $args=@('-Profile',$name)
    if($power.Checked){$args+='-PowerMode'}
    if($gui.Checked){$args+='-GuiControl'}
    $rc=Invoke-HiddenPwsh $script $args
    if($rc -ne 0){throw "Isolation failed (exit $rc)."}
    Refresh-Grid
  }catch{$status.Text="Isolation failed: $($_.Exception.Message)"}
})
$open.Add_Click({
  if(-not $script:selected){return}
  $p=if($script:selected.IsPrimary){$StateRoot}else{Join-Path $InstanceRoot $script:selected.Profile}
  if(Test-Path $p){Start-Process explorer.exe -ArgumentList @($p)}
})
$monitor.Add_Click({
  $p=Join-Path $PSScriptRoot 'operations-monitor-windows.ps1'
  if(Test-Path $p){Start-Process pwsh.exe -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$p)}
  else{$status.Text='Operations monitor is not installed.'}
})
$admin.Add_Click({
  $p=Join-Path $PSScriptRoot 'admin-runtime-windows.ps1'
  if(Test-Path $p){Start-Process pwsh.exe -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$p)}
  else{$status.Text='Admin runtime manager is not installed.'}
})
$refresh.Add_Click({Refresh-Grid})

Add-Type -AssemblyName Microsoft.VisualBasic
Refresh-Grid
[void]$form.ShowDialog()
