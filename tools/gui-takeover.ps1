param([switch]$Server,[int]$ParentPid=0)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(-not $IsWindows){throw 'GUI_WINDOWS_ONLY'}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Path @((Join-Path $PSScriptRoot 'gui-native.cs'),(Join-Path $PSScriptRoot 'gui-takeover-windows.cs'))
if($ParentPid -gt 0){[RcWindowsGuiTakeover]::SetParentProcess($ParentPid)}
$monitorReady=[RcWindowsGuiTakeover]::StartMonitor()

function New-OwnerApproval([int]$timeoutMs) {
  $form=[Windows.Forms.Form]::new()
  $form.Text='Commander — اجازه کنترل موقت دسکتاپ'
  $form.StartPosition='CenterScreen'
  $form.FormBorderStyle='FixedDialog'
  $form.MaximizeBox=$false
  $form.MinimizeBox=$false
  $form.ShowInTaskbar=$false
  $form.TopMost=$true
  $form.Width=520
  $form.Height=210
  $form.RightToLeft='Yes'
  $form.RightToLeftLayout=$true

  $label=[Windows.Forms.Label]::new()
  $label.AutoSize=$false
  $label.Left=20;$label.Top=20;$label.Width=465;$label.Height=64
  $label.Text='Commander برای انجام درخواست جاری به کنترل موقت Mouse و Keyboard نیاز دارد. در صورت عدم رد درخواست، پس از ۶۰ ثانیه کنترل به‌طور خودکار واگذار می‌شود.'
  $form.Controls.Add($label)

  $countdown=[Windows.Forms.Label]::new()
  $countdown.Left=20;$countdown.Top=90;$countdown.Width=465;$countdown.Height=24
  $countdown.Text='مهلت تصمیم: ۶۰ ثانیه'
  $form.Controls.Add($countdown)

  $approve=[Windows.Forms.Button]::new()
  $approve.Text='اجازه می‌دهم'
  $approve.Left=270;$approve.Top=125;$approve.Width=105;$approve.Height=32
  $approve.DialogResult=[Windows.Forms.DialogResult]::OK
  $form.Controls.Add($approve)

  $deny=[Windows.Forms.Button]::new()
  $deny.Text='رد درخواست'
  $deny.Left=385;$deny.Top=125;$deny.Width=105;$deny.Height=32
  $deny.DialogResult=[Windows.Forms.DialogResult]::Cancel
  $form.Controls.Add($deny)
  $form.AcceptButton=$approve
  $form.CancelButton=$deny

  $watch=[Diagnostics.Stopwatch]::StartNew()
  $timer=[Windows.Forms.Timer]::new()
  $timer.Interval=250
  $state=@{explicit=$false;denied=$false;automatic=$false;closed=$false}
  $approve.Add_Click({$state.explicit=$true;$state.closed=$true})
  $deny.Add_Click({$state.denied=$true;$state.closed=$true})
  $form.Add_FormClosing({
    if(-not $state.closed -and -not $state.automatic -and -not $state.explicit){$state.denied=$true}
  })
  $timer.Add_Tick({
    $remaining=[Math]::Max(0,[int][Math]::Ceiling(($timeoutMs-$watch.ElapsedMilliseconds)/1000.0))
    $countdown.Text="مهلت تصمیم: $remaining ثانیه"
    if($watch.ElapsedMilliseconds -ge $timeoutMs){
      $state.automatic=$true;$state.closed=$true
      $form.DialogResult=[Windows.Forms.DialogResult]::OK
      $form.Close()
    }
  })
  $timer.Start()
  try { [void]$form.ShowDialog() }
  finally { $timer.Stop();$timer.Dispose();$form.Dispose();$watch.Stop() }
  return @{
    explicitOwnerApproval=[bool]$state.explicit
    approvalDenied=[bool]$state.denied
    approvalPromptVisible=$true
    approvalPromptElapsedMs=[long]$watch.ElapsedMilliseconds
    physicalActivityAfterPrompt=$false
  }
}

function Invoke-Native([hashtable]$request) {
  switch([string]$request.action) {
    'describeSession' {
      [void][RcWindowsGuiTakeover]::StartMonitor()
      return @{ok=$true;descriptor=[RcWindowsGuiTakeover]::DescribeSession()}
    }
    'activity' {
      return @{ok=$true;activity=[RcWindowsGuiTakeover]::GetPhysicalActivityEvidence()}
    }
    'approval' {
      $timeout=60000
      if($request.timeoutMs -and [int]$request.timeoutMs -ne 60000){throw 'GUI_APPROVAL_TIMEOUT_POLICY'}
      $result=New-OwnerApproval $timeout
      return @{ok=$true;approval=$result}
    }
    'input' {
      $stop=Join-Path (Split-Path -Parent $PSScriptRoot) 'var\GUI_STOP'
      return [RcWindowsGuiTakeover]::InvokeInput([System.Collections.IDictionary]$request.input,$stop)
    }
    'acquire' {
      $ttl=[uint32]([Math]::Min(120000,[Math]::Max(10000,[int]$request.ttlMs)))
      $result=[RcWindowsGuiTakeover]::AcquireProtection($ttl)
      if(-not $result.ok){return $result}
      return @{ok=$true;receipt=$result.receipt;activityEvidence=[RcWindowsGuiTakeover]::GetPhysicalActivityEvidence()}
    }
    'release' { return [RcWindowsGuiTakeover]::ReleaseProtectionForLease([string]$request.leaseId) }
    'events' { return @{ok=$true;events=[RcWindowsGuiTakeover]::DrainEvents()} }
    'status' {
      return @{ok=$true;monitorReady=[RcWindowsGuiTakeover]::IsMonitorReady;protectionActive=[RcWindowsGuiTakeover]::IsProtectionActive;protectionUncertain=[RcWindowsGuiTakeover]::IsProtectionUncertain;descriptor=[RcWindowsGuiTakeover]::DescribeSession()}
    }
    'stop' {
      $result=[RcWindowsGuiTakeover]::ReleaseProtection()
      return @{ok=$result.ok;stopped=$true;release=$result}
    }
    default { throw 'GUI_NATIVE_PROVIDER_UNKNOWN_ACTION' }
  }
}

if($Server){
  [void][RcWindowsGuiTakeover]::StartMonitor()
  @{ready=$true;monitorReady=[RcWindowsGuiTakeover]::IsMonitorReady;session=[Diagnostics.Process]::GetCurrentProcess().SessionId} | ConvertTo-Json -Compress
  [Console]::Out.Flush()
  while(($line=[Console]::In.ReadLine()) -ne $null) {
    $request=@{id=''}
    try {
      if($line.Length -gt 8192){throw 'GUI_NATIVE_PROVIDER_REQUEST_LIMIT'}
      $request=$line|ConvertFrom-Json -AsHashtable
      if($request -isnot [hashtable]){throw 'GUI_NATIVE_PROVIDER_REQUEST_INVALID'}
      $id=[string]$request.id
      $result=Invoke-Native $request
      @{id=$id;result=$result;ok=$true}|ConvertTo-Json -Depth 12 -Compress
      [Console]::Out.Flush()
      if($request.action -eq 'stop'){break}
    } catch {
      $code=[regex]::Match(($_.Exception.Message+' '+$_),'GUI_[A-Z0-9_]+')
      $errorCode=if($code.Success){$code.Value}else{'GUI_NATIVE_PROVIDER_FAILED'}
      @{id=[string]$request.id;ok=$false;error=$errorCode}|ConvertTo-Json -Compress
      [Console]::Out.Flush()
    }
  }
  [void][RcWindowsGuiTakeover]::ReleaseProtection()
} else {
  $line=[Console]::In.ReadToEnd()
  $request=$line|ConvertFrom-Json -AsHashtable
  Invoke-Native $request|ConvertTo-Json -Depth 12 -Compress
}
