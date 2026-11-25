# Native Windows UI Automation semantic executor.
# Uses only exact same-owner HWND + fresh UIA fingerprint; no SendInput/SendKeys/CUA.
[CmdletBinding()]
param(
 [Parameter(Mandatory)][ValidateSet('Observe','SetValue','Invoke')][string]$Operation,
 [Parameter(Mandatory)][ValidateRange(1,2147483647)][int]$TargetPid,
 [Parameter(Mandatory)][ValidateRange(1,9223372036854775807)][long]$WindowHandle,
 [Parameter(Mandatory)][ValidateSet('brave','chrome','msedge','firefox')][string]$ExpectedProcessName,
 [ValidateRange(1,100)][int]$MaxElements=70,
 [string]$Fingerprint='',
 [string]$ControlName='',
 [string]$RequestId='',
 [string]$ExplicitUserAuthorization='',
 [switch]$ForegroundChangeAuthorized
)
$ErrorActionPreference='Stop'
function Refuse([string]$code){throw $code}
if(-not $IsWindows){Refuse 'AGENTOS_WINDOWS_REQUIRED'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($identity.IsSystem -or (Get-Process -Id $PID).SessionId -eq 0){Refuse 'AGENTOS_INTERACTIVE_OWNER_REQUIRED'}
$targetProcess=Get-Process -Id $TargetPid -ErrorAction Stop
if($targetProcess.ProcessName -ine $ExpectedProcessName){Refuse 'AGENTOS_EXPECTED_APPLICATION_MISMATCH'}
if($targetProcess.SessionId -ne (Get-Process -Id $PID).SessionId){Refuse 'AGENTOS_OWNER_SESSION_MISMATCH'}
# Verify the target process token belongs to the exact current Windows principal.
$wmiProcess=Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $TargetPid" -ErrorAction Stop
$owner=Invoke-CimMethod -InputObject $wmiProcess -MethodName GetOwnerSid -ErrorAction Stop
if($owner.ReturnValue -ne 0 -or $owner.Sid -ne $identity.User.Value){Refuse 'AGENTOS_TARGET_OWNER_SID_MISMATCH'}
$Value=$null
if($Operation -eq 'SetValue'){
 [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
 $stdinLine=[Console]::In.ReadLine()
 if([string]::IsNullOrEmpty($stdinLine)){Refuse 'AGENTOS_SET_VALUE_STDIN_REQUIRED'}
 try{$stdinPayload=$stdinLine|ConvertFrom-Json -ErrorAction Stop}catch{Refuse 'AGENTOS_SET_VALUE_STDIN_INVALID'}
 $Value=[string]$stdinPayload.value
 if($Value.Length -lt 1 -or $Value.Length -gt 1024 -or $Value.Contains([char]0)){Refuse 'AGENTOS_SET_VALUE_LENGTH_INVALID'}
}
if($Operation -ne 'Observe'){
 if($RequestId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' -or
   $ExplicitUserAuthorization.Trim().Length -lt 12 -or
   $Fingerprint -cnotmatch '^[a-f0-9]{24}$' -or
   $ControlName.Length -lt 1 -or $ControlName.Length -gt 150){
  Refuse 'AGENTOS_EXPLICIT_MUTATION_CONTRACT_REQUIRED'
 }
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
if(-not ('RcAgentOSWindows' -as [type])){
 Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RcAgentOSWindows {
 [DllImport("user32.dll", SetLastError=true)]
 public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
 [DllImport("user32.dll")]
 public static extern IntPtr GetForegroundWindow();
}
'@
}
function Get-WindowIdentity([IntPtr]$handle){
 if($handle -eq [IntPtr]::Zero){return @{windowHandle=$null;processId=$null}}
 $processId=[uint32]0
 [void][RcAgentOSWindows]::GetWindowThreadProcessId($handle,[ref]$processId)
 if($processId -lt 1){return @{windowHandle=$null;processId=$null}}
 return @{windowHandle=[long]$handle.ToInt64();processId=[int]$processId}
}
function Get-ForegroundEvidence([IntPtr]$before,[IntPtr]$after){
 $b=Get-WindowIdentity $before
 $a=Get-WindowIdentity $after
 if($null -eq $b.windowHandle -or $null -eq $a.windowHandle){
  $state='UNOBSERVABLE';$touched=$null
 }else{
  $changed=($b.windowHandle -ne $a.windowHandle -or $b.processId -ne $a.processId)
  $state=$(if($changed){'CHANGED'}else{'PRESERVED'})
  $touched=$changed
 }
 return @{
  state=$state;touched=$touched
  beforeWindowHandle=$b.windowHandle;beforeProcessId=$b.processId
  afterWindowHandle=$a.windowHandle;afterProcessId=$a.processId
 }
}
function Fingerprint([System.Windows.Automation.AutomationElement]$element){
 $c=$element.Current
 $runtime=@($element.GetRuntimeId()) -join '.'
 $key="$TargetPid|$WindowHandle|$runtime|$($c.AutomationId)|$($c.ControlType.ProgrammaticName)|$($c.Name)"
 $hasher=[System.Security.Cryptography.SHA256]::Create()
 try{
  $bytes=$hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($key))
  return [Convert]::ToHexString($bytes).Substring(0,24).ToLowerInvariant()
 }finally{$hasher.Dispose()}
}
function Get-SettableValueProvider([System.Windows.Automation.AutomationElement]$element){
 $vp=$null
 if($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$vp)){
  if(-not $vp.Current.IsReadOnly){return @{pattern=$vp;provider='ValuePattern'}}
 }
 return $null
}
$foregroundBefore=[RcAgentOSWindows]::GetForegroundWindow()
$hwnd=[IntPtr]$WindowHandle
$nativePid=[uint32]0
[void][RcAgentOSWindows]::GetWindowThreadProcessId($hwnd,[ref]$nativePid)
if($nativePid -ne $TargetPid){Refuse 'AGENTOS_EXACT_WINDOW_PID_MISMATCH'}
$root=[System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
if($null -eq $root -or $root.Current.ProcessId -ne $TargetPid){Refuse 'AGENTOS_WINDOW_OWNER_INVALID'}
if($root.Current.IsPassword){Refuse 'AGENTOS_PROTECTED_TARGET'}
$children=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
if($children.Count -gt 3000){Refuse 'AGENTOS_ACCESSIBILITY_TREE_OVERSIZED'}
$elements=[System.Collections.Generic.List[object]]::new()
$observedCandidates=[System.Collections.Generic.List[object]]::new()
$matchedControls=[System.Collections.Generic.List[object]]::new()
for($i=0;$i -lt $children.Count;$i++){
 $element=$children.Item($i)
 try{
  $c=$element.Current
  if($c.ProcessId -ne $TargetPid -or $c.IsPassword){continue}
  $kind=[string]$c.ControlType.ProgrammaticName
  if($kind -notin @('ControlType.Edit','ControlType.Document','ControlType.Button')){continue}
  $name=[string]$c.Name
  if($name.Length -gt 150){$name=$name.Substring(0,150)}
  $canInvoke=$false;$invokePattern=$null
  if($Operation -ne 'SetValue'){
   $canInvoke=$element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$invokePattern)
  }
  $settable=$null
  if($kind -eq 'ControlType.Edit' -or $kind -eq 'ControlType.Document'){
   $settable=Get-SettableValueProvider $element
  }
  $canSetValue=$null -ne $settable
  if($Operation -eq 'Observe'){
   if(-not $canInvoke -and -not $canSetValue){continue}
   $finger=Fingerprint $element
   $observedCandidates.Add([pscustomobject]@{
    name=$name;automationId=[string]$c.AutomationId;controlType=$kind
    enabled=[bool]$c.IsEnabled;fingerprint=$finger
    invokeAvailable=[bool]$canInvoke;valueAvailable=[bool]$canSetValue
    valueProvider=$(if($settable){$settable.provider}else{$null})
   })
  }elseif($fingerprint -ceq (Fingerprint $element) -and $name -ceq $ControlName -and $c.IsEnabled){
   if($Operation -eq 'Invoke' -and $canInvoke){
    $matchedControls.Add([pscustomobject]@{element=$element;pattern=$invokePattern})
   }elseif($Operation -eq 'SetValue' -and $canSetValue){
    $matchedControls.Add([pscustomobject]@{element=$element;pattern=$settable.pattern;provider=$settable.provider})
   }
  }
 }catch [System.Windows.Automation.ElementNotAvailableException]{continue}
}
if($Operation -eq 'Observe'){
 # Prefer text-capable Edit/Document controls over generic actions when the bounded
 # response is truncated; a crowded browser tree must not hide its compose field.
 $ranked=@($observedCandidates | Sort-Object @{Expression={if($_.controlType -in @('ControlType.Edit','ControlType.Document')){0}else{1}}}, @{Expression={if($_.enabled){0}else{1}}})
 $selected=@($ranked | Select-Object -First $MaxElements)
 foreach($item in $selected){$elements.Add($item)}
 $foregroundEvidence=Get-ForegroundEvidence $foregroundBefore ([RcAgentOSWindows]::GetForegroundWindow())
 [pscustomobject]@{
  ok=$true;mode='NATIVE_UIA_OBSERVE';provider='windows-uia-native'
  application=$ExpectedProcessName;pid=$TargetPid;windowHandle=$WindowHandle
  totalScanned=$children.Count;elements=$elements.ToArray()
  truncated=$observedCandidates.Count -gt $MaxElements;principalSid=$identity.User.Value
  foregroundStatus=$foregroundEvidence.state;foregroundTouched=$foregroundEvidence.touched
  foregroundBeforeWindowHandle=$foregroundEvidence.beforeWindowHandle
  foregroundBeforeProcessId=$foregroundEvidence.beforeProcessId
  foregroundAfterWindowHandle=$foregroundEvidence.afterWindowHandle
  foregroundAfterProcessId=$foregroundEvidence.afterProcessId
  physicalInputTouched=$false
 }|ConvertTo-Json -Depth 6 -Compress
 exit 0
}
if($matchedControls.Count -ne 1){Refuse 'AGENTOS_FRESH_EXACT_UIA_ELEMENT_REQUIRED'}
$foregroundImmediatelyBefore=[RcAgentOSWindows]::GetForegroundWindow()
if($Operation -eq 'Invoke' -and -not $ForegroundChangeAuthorized){
 $currentForeground=Get-WindowIdentity $foregroundImmediatelyBefore
 if($currentForeground.windowHandle -ne $WindowHandle -or $currentForeground.processId -ne $TargetPid){
  Refuse 'AGENTOS_FOREGROUND_TARGET_NOT_ACTIVE'
 }
}
if($Operation -eq 'SetValue'){
 $provider=$matchedControls[0].provider
 $pattern=$matchedControls[0].pattern
 if($provider -eq 'ValuePattern'){
  ([System.Windows.Automation.ValuePattern]$pattern).SetValue($Value)
 }else{Refuse 'AGENTOS_VALUE_PROVIDER_UNSUPPORTED'}
 Start-Sleep -Milliseconds 100
 $verified=$false
 $actual=$null
 if($provider -eq 'ValuePattern'){
  $check=$null
  if($matchedControls[0].element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$check)){
   $actual=[string]$check.Current.Value
  }
 }
 $verified=($actual -ceq $Value)
 if(-not $verified){Refuse 'AGENTOS_SET_VALUE_READBACK_MISMATCH'}
 $hasher=[System.Security.Cryptography.SHA256]::Create()
 try{$valueSha=[Convert]::ToHexString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).ToLowerInvariant()}
 finally{$hasher.Dispose()}
 $foregroundEvidence=Get-ForegroundEvidence $foregroundImmediatelyBefore ([RcAgentOSWindows]::GetForegroundWindow())
 [pscustomobject]@{
  ok=$true;mode='NATIVE_UIA_SET_VALUE';provider='windows-uia-native'
  application=$ExpectedProcessName;pid=$TargetPid;windowHandle=$WindowHandle
  requestId=$RequestId;valueApplied=$true;readBackVerified=$true
  valueLength=$Value.Length;valueSha256=$valueSha;valueProvider=$provider
  foregroundStatus=$foregroundEvidence.state;foregroundTouched=$foregroundEvidence.touched
  foregroundBeforeWindowHandle=$foregroundEvidence.beforeWindowHandle
  foregroundBeforeProcessId=$foregroundEvidence.beforeProcessId
  foregroundAfterWindowHandle=$foregroundEvidence.afterWindowHandle
  foregroundAfterProcessId=$foregroundEvidence.afterProcessId
  physicalInputTouched=$false
 }|ConvertTo-Json -Compress
 exit 0
}
# UIA InvokePattern may activate its parent window. Measure and report the exact foreground HWND.
([System.Windows.Automation.InvokePattern]$matchedControls[0].pattern).Invoke()
Start-Sleep -Milliseconds 130
$foregroundEvidence=Get-ForegroundEvidence $foregroundImmediatelyBefore ([RcAgentOSWindows]::GetForegroundWindow())
[pscustomobject]@{
 ok=$true;mode='NATIVE_UIA_INVOKE';provider='windows-uia-native'
 application=$ExpectedProcessName;pid=$TargetPid;windowHandle=$WindowHandle
 requestId=$RequestId;invocationIssued=$true;userGoalVerified=$false
 foregroundStatus=$foregroundEvidence.state;foregroundTouched=$foregroundEvidence.touched
 foregroundBeforeWindowHandle=$foregroundEvidence.beforeWindowHandle
 foregroundBeforeProcessId=$foregroundEvidence.beforeProcessId
 foregroundAfterWindowHandle=$foregroundEvidence.afterWindowHandle
 foregroundAfterProcessId=$foregroundEvidence.afterProcessId
 physicalInputTouched=$false
}|ConvertTo-Json -Compress
