# Native J01 owner-session snapshot and explicit challenge. No elevation or secrets.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('Snapshot','Consent')][string]$Mode,
  [string]$ExpectedSid = '',
  [int]$ExpectedSession = -1,
  [string]$TitleBase64 = '',
  [string]$MessageBase64 = '',
  [string]$Challenge = ''
)
$ErrorActionPreference = 'Stop'
# WTSQuerySessionInformation class 8 = WTSConnectState; 0 = WTSActive.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CommanderOwnerWts {
  [DllImport("wtsapi32.dll", SetLastError=true)]
  private static extern bool WTSQuerySessionInformationW(IntPtr server, int sessionId, int infoClass, out IntPtr data, out int length);
  [DllImport("wtsapi32.dll")]
  private static extern void WTSFreeMemory(IntPtr buffer);
  public static bool Active(int sessionId) {
    IntPtr data = IntPtr.Zero;
    int length = 0;
    if (!WTSQuerySessionInformationW(IntPtr.Zero, sessionId, 8, out data, out length)) return false;
    try { return length >= 4 && Marshal.ReadInt32(data) == 0; }
    finally { if (data != IntPtr.Zero) WTSFreeMemory(data); }
  }
}
'@ -ErrorAction Stop
function Current-Owner {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = [string]$identity.User.Value
  $sidPattern = '^S-1-5-21-(?:[0-9]+-){3}[0-9]+$'
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  $admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
  $active = $session -gt 0 -and [CommanderOwnerWts]::Active([int]$session)
  if (-not $identity.IsAuthenticated -or $identity.IsSystem -or $admin -or
      $sid -notmatch $sidPattern -or -not $active) {
    throw 'NATIVE_OWNER_WINDOWS_ACTIVE_USER_REQUIRED'
  }
  return [pscustomobject]@{schema=1;ownerSid=$sid;sessionId=[int]$session;active=$true;interactive=$true}
}
$before = Current-Owner
if ($Mode -eq 'Snapshot') {
  $before | ConvertTo-Json -Compress -Depth 2
  exit 0
}
if (($ExpectedSid -and $ExpectedSid -ne $before.ownerSid) -or $ExpectedSession -ne $before.sessionId -or
    $Challenge -notmatch '^[0-9]{8}$') {
  throw 'NATIVE_OWNER_WINDOWS_EXPECTATION_MISMATCH'
}
$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TitleBase64))
$message = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($MessageBase64))
if ($title.Length -lt 1 -or $title.Length -gt 120 -or
    $message.Length -lt 1 -or $message.Length -gt 5000 -or
    $title -match '[\x00-\x1f\x7f]' -or
    $message -match '[\x00-\x08\x0b-\x1f\x7f]') {
  throw 'NATIVE_OWNER_WINDOWS_MESSAGE_INVALID'
}
# InputBox starts blank; dismiss, timeout, empty and incorrect input all deny.
Add-Type -AssemblyName Microsoft.VisualBasic -ErrorAction Stop
$answer = [Microsoft.VisualBasic.Interaction]::InputBox(
  ($message + "`n`nType this one-time code to approve:`n" + $Challenge),
  $title, '')
$after = Current-Owner
$approved = [string]::Equals($answer,$Challenge,[StringComparison]::Ordinal) -and
  $after.ownerSid -eq $before.ownerSid -and $after.sessionId -eq $before.sessionId
[pscustomobject]@{approved=[bool]$approved} | ConvertTo-Json -Compress
