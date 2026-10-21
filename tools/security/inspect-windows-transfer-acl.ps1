# Read-only admission evidence for the operator-owned Windows transfer state root.
# Does NOT set ACLs, modify data, validate descendant DACLs, or prove race immunity.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$Root)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$report=[ordered]@{
 schema='rc-windows-transfer-root-acl-audit-v1'
 status='UNAVAILABLE'
 ownerIsCaller=$false
 inheritanceProtected=$false
 reparseAncestorDetected=$false
 unapprovedAllowAceCount=0
 ownerSidPresent=$false
 examined='ROOT_DACL_ONLY'
}
try {
 if (-not [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) {
  throw 'WINDOWS_REQUIRED'
 }
 $full=[IO.Path]::GetFullPath($Root)
 $entry=Get-Item -LiteralPath $full -Force -ErrorAction Stop
 if(-not $entry.PSIsContainer){throw 'DIRECTORY_REQUIRED'}
 $walk=$entry
 while($null -ne $walk){
  if(($walk.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
   $report.reparseAncestorDetected=$true
   break
  }
  $walk=$walk.Parent
 }
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
 if($null -eq $identity.User){throw 'CALLER_SID_UNAVAILABLE'}
 $current=$identity.User.Value
 $acl=Get-Acl -LiteralPath $full -ErrorAction Stop
 $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
 $report.ownerIsCaller=($owner -eq $current)
 $report.ownerSidPresent=($null -ne $owner -and $owner.Length -gt 0)
 $report.inheritanceProtected=[bool]$acl.AreAccessRulesProtected
 $allow=@($current,'S-1-5-18','S-1-5-32-544')
 foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
  if($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
    $allow -cnotcontains $ace.IdentityReference.Value){
   $report.unapprovedAllowAceCount++
  }
 }
 $report.status=if($report.ownerIsCaller -and $report.inheritanceProtected -and
     -not $report.reparseAncestorDetected -and $report.unapprovedAllowAceCount -eq 0){
   'ROOT_DACL_RESTRICTED'
  }else{'REVIEW_REQUIRED'}
}catch{
 $report.status='UNAVAILABLE'
}
$report | ConvertTo-Json -Compress
if($report.status -eq 'ROOT_DACL_RESTRICTED'){exit 0}
if($report.status -eq 'REVIEW_REQUIRED'){exit 2}
exit 3