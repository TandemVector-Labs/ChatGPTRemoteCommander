# Read-only admission for SYSTEM-only encrypted credential storage.
# DPAPI LocalMachine alone is not authorization: every local user could decrypt
# a readable blob. Actual readers must still use the protected machine path.
# The parent DACL must not grant any non-privileged SID the ability to
# delete/replace the protected child, or rewrite its security descriptor.
# Do not rely on a fixed list of well-known user groups: local/custom SIDs
# can have the same dangerous rights.
function Assert-RcCredentialParentAcl($acl) {
  $trustedSids = @('S-1-5-18','S-1-5-32-544')
  $dangerMask = [int64]([Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership -bor
    0x10000000) # GenericAll is dangerous even before Windows expands it.
  foreach($ace in $acl.Access){
    # InheritOnly does not apply to the ProgramData directory itself; the
    # separately checked machine children disable ACL inheritance.
    if(($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0){continue}
    if($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){continue}
    try{$sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}
    catch{throw 'BOOT_RECOVERY_CREDENTIAL_ACL_UNREADABLE'}
    if($sid -notin $trustedSids -and (([int64]$ace.FileSystemRights -band $dangerMask) -ne 0)){
      throw 'BOOT_RECOVERY_CREDENTIAL_PARENT_DELETE_OR_DAC'
    }
  }
}

function Assert-RcMachineCredentialStore {
  $base = [IO.Path]::GetFullPath([Environment]::GetFolderPath('CommonApplicationData'))
  $parent = Join-Path $base 'ChatGPTRemoteCommander'
  $root = Join-Path $parent 'machine-credentials'
  if(-not(Test-Path -LiteralPath $root -PathType Container)){
    throw 'BOOT_RECOVERY_PROTECTED_CREDENTIAL_ROOT_MISSING'
  }
  $allowSids = @('S-1-5-18','S-1-5-32-544')
  $ancestor = Get-Item -LiteralPath $base -Force -ErrorAction Stop
  if(($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
    throw 'BOOT_RECOVERY_CREDENTIAL_PARENT_REPARSE'
  }
  $ancestorAcl = Get-Acl -LiteralPath $base -ErrorAction Stop
  Assert-RcCredentialParentAcl $ancestorAcl
  foreach($entryPath in @($parent,$root)){
    $entry = Get-Item -LiteralPath $entryPath -Force -ErrorAction Stop
    if(-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
      throw 'BOOT_RECOVERY_CREDENTIAL_ROOT_REPARSE'
    }
    $acl=Get-Acl -LiteralPath $entryPath -ErrorAction Stop
    if(-not $acl.AreAccessRulesProtected){
      throw 'BOOT_RECOVERY_CREDENTIAL_ROOT_INHERITS'
    }
    try{$ownerSid=([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value}
    catch{throw 'BOOT_RECOVERY_CREDENTIAL_ROOT_OWNER_UNRESOLVED'}
    if($ownerSid -notin $allowSids){throw 'BOOT_RECOVERY_CREDENTIAL_ROOT_OWNER'}
    foreach($ace in $acl.Access){
      if($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){continue}
      try{$sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}
      catch{throw 'BOOT_RECOVERY_CREDENTIAL_ACL_UNREADABLE'}
      if($sid -notin $allowSids){throw 'BOOT_RECOVERY_CREDENTIAL_ROOT_UNTRUSTED_ACE'}
    }
  }
  foreach($entry in (Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop)){
    if($entry.PSIsContainer -or $entry.Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.machine\.dpapi$' -or
       $entry.Name -match '\.\.' -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
      throw 'BOOT_RECOVERY_CREDENTIAL_ENTRY_INVALID'
    }
    $acl=Get-Acl -LiteralPath $entry.FullName -ErrorAction Stop
    if(-not $acl.AreAccessRulesProtected){throw 'BOOT_RECOVERY_CREDENTIAL_FILE_INHERITS'}
    try{$ownerSid=([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value}
    catch{throw 'BOOT_RECOVERY_CREDENTIAL_FILE_OWNER_UNRESOLVED'}
    if($ownerSid -notin $allowSids){throw 'BOOT_RECOVERY_CREDENTIAL_FILE_OWNER'}
    foreach($ace in $acl.Access){
      if($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){continue}
      try{$sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}
      catch{throw 'BOOT_RECOVERY_CREDENTIAL_ACL_UNREADABLE'}
      if($sid -notin $allowSids){throw 'BOOT_RECOVERY_CREDENTIAL_FILE_UNTRUSTED_ACE'}
    }
  }
  return $root
}
