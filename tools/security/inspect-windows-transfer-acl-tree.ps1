# Bounded, read-only audit of the operator's Windows transfer root and descendants.
# Never reads file bodies or changes ACLs; names and SIDs are deliberately omitted.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$Root,
  [ValidateRange(1,4096)][int]$MaxEntries=256,
  [ValidatePattern('^S-1-(?:[0-9]+-)+[0-9]+$')][string]$ExpectedOwnerSid
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$report=[ordered]@{
  schema='rc-windows-transfer-tree-acl-audit-v1'
  status='UNAVAILABLE'
  inspected='ROOT_AND_DESCENDANTS_ACL_ONLY'
  inspectedEntries=0
  inspectedFiles=0
  inspectedDirectories=0
  observerIsSystem=$false
  rootOwnerIsObserver=$false
  rootOwnerIsExpected=$false
  rootInheritanceProtected=$false
  inheritedScopeCount=0
  ownersOutsideAllowedCount=0
  unapprovedAllowAceCount=0
  unapprovedReadAceCount=0
  unapprovedMutationAceCount=0
  reparseEntryCount=0
  truncated=$false
}
try {
  if(-not [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
      [Runtime.InteropServices.OSPlatform]::Windows)){throw 'WINDOWS_REQUIRED'}
  if($Root -notmatch '^[A-Za-z]:[\\/]'){throw 'LOCAL_DRIVE_ABSOLUTE_REQUIRED'}
  $full=[IO.Path]::GetFullPath($Root)
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  if($null -eq $identity.User){throw 'OBSERVER_SID_MISSING'}
  $sid=$identity.User.Value
  # An observing SYSTEM service can verify a separate pinned operator owner.
  $expectedSid=$sid
  if($PSBoundParameters.ContainsKey('ExpectedOwnerSid')){
    $expectedSid=([Security.Principal.SecurityIdentifier]::new($ExpectedOwnerSid)).Value
  }
  $report.observerIsSystem=($sid -eq 'S-1-5-18')
  # Check each lexical component BEFORE touching the caller-selected root.
  # Get-Item(...).Parent may refer to the target of a redirected path.
  $driveRoot=[IO.Path]::GetPathRoot($full)
  $walk=$driveRoot
  foreach($segment in ($full.Substring($driveRoot.Length) -split '[\\/]')){
    if(-not $segment){continue}
    $walk=[IO.Path]::Combine($walk,$segment)
    $ancestor=Get-Item -LiteralPath $walk -Force -ErrorAction Stop
    if(($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
      $report.reparseEntryCount++
      break
    }
  }
  if($report.reparseEntryCount -eq 0) {
    $rootItem=Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if(-not $rootItem.PSIsContainer){throw 'ROOT_NOT_DIRECTORY'}
    # The observed root owner cannot expand its own trusted-principal list.
    $allowed=@($expectedSid,'S-1-5-18','S-1-5-32-544')
  }
  $writeRights=([Security.AccessControl.FileSystemRights]::WriteData -bor
    [Security.AccessControl.FileSystemRights]::AppendData -bor
    [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership)
  $readRights=([Security.AccessControl.FileSystemRights]::ReadData -bor
    [Security.AccessControl.FileSystemRights]::ReadAttributes -bor
    [Security.AccessControl.FileSystemRights]::ReadExtendedAttributes -bor
    [Security.AccessControl.FileSystemRights]::ReadPermissions -bor
    [Security.AccessControl.FileSystemRights]::ExecuteFile)
  # If any ancestor is redirected, stop BEFORE enumerating anything under it.
  if($report.reparseEntryCount -eq 0){
    $queue=[Collections.Generic.Stack[string]]::new()
    $queue.Push($full)
    while($queue.Count -gt 0) {
    if($report.inspectedEntries -ge $MaxEntries){$report.truncated=$true;break}
    $current=$queue.Pop()
    $entry=Get-Item -LiteralPath $current -Force -ErrorAction Stop
    $report.inspectedEntries++
    if($entry.PSIsContainer){$report.inspectedDirectories++}
    else{$report.inspectedFiles++}
    if(($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
      $report.reparseEntryCount++
      continue # never enumerate a junction, even on a nested child
    }
    $acl=Get-Acl -LiteralPath $current -ErrorAction Stop
    if(-not $acl.AreAccessRulesProtected){$report.inheritedScopeCount++}
    $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if($report.inspectedEntries -eq 1) {
      $report.rootOwnerIsObserver=($owner -eq $sid)
      $report.rootOwnerIsExpected=($owner -eq $expectedSid)
      $report.rootInheritanceProtected=[bool]$acl.AreAccessRulesProtected
    }
    if($allowed -cnotcontains $owner){$report.ownersOutsideAllowedCount++}
    foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
      if($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){continue}
      if($allowed -ccontains $ace.IdentityReference.Value){continue}
      $report.unapprovedAllowAceCount++
      $mask=[long]$ace.FileSystemRights
      if(($mask -band [long]$writeRights) -ne 0){$report.unapprovedMutationAceCount++}
      if(($mask -band [long]$readRights) -ne 0){$report.unapprovedReadAceCount++}
    }
    if($entry.PSIsContainer){
      $children=@(Get-ChildItem -LiteralPath $current -Force -ErrorAction Stop)
      foreach($child in $children){$queue.Push($child.FullName)}
    }
  }
  }
  $unsafeObserved=(-not $report.rootOwnerIsExpected -or
    -not $report.rootInheritanceProtected -or
    $report.unapprovedAllowAceCount -gt 0 -or
    $report.ownersOutsideAllowedCount -gt 0 -or
    $report.reparseEntryCount -gt 0)
  $report.status=if($unsafeObserved){'REVIEW_REQUIRED'}
    elseif($report.truncated){'UNAVAILABLE'}
    else{'TREE_DACL_RESTRICTED'}
}catch{
  $report.status='UNAVAILABLE' # never treat failed traversal as clean
}
$report | ConvertTo-Json -Compress
if($report.status -eq 'TREE_DACL_RESTRICTED'){exit 0}
if($report.status -eq 'REVIEW_REQUIRED'){exit 2}
exit 3