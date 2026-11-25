# RC012 owner-local private migration capsule for the exact existing Windows
# Tunnel profile + mTLS client material. User DPAPI CurrentUser encrypted.
# Stage/Verify only. No restore, service change, profile mutation, or key output.
[CmdletBinding()]
param(
  [ValidateSet('Stage','Verify','TestRestore')][string]$Mode='Stage',
  [string]$ProfileName
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(-not [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
  [Runtime.InteropServices.OSPlatform]::Windows)){throw 'RC012_DPAPI_WINDOWS_ONLY'}
if(-not [IO.Path]::IsPathRooted($env:APPDATA)){throw 'RC012_OWNER_APPDATA_REQUIRED'}
$owner=[Security.Principal.WindowsIdentity]::GetCurrent()
if(-not $owner.User){throw 'RC012_OWNER_SID_UNAVAILABLE'}
$sid=$owner.User.Value
$sourceRoot=$env:APPDATA
$backupRoot=Join-Path $sourceRoot 'ChatGPTRemoteCommander\owner-recovery'
# Legacy no-ProfileName capsule remains unchanged, explicit owner profiles
# get their own namespaced encrypted backup and same-owner TLS private pair.
$profileExplicit=$PSBoundParameters.ContainsKey('ProfileName')
if($profileExplicit){
 if([string]::IsNullOrWhiteSpace($ProfileName) -or
    $ProfileName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or
    $ProfileName -in @('.','..')){throw 'RC012_DPAPI_OWNER_PROFILE_INVALID'}
}else{$ProfileName='chatgpt-remote-commander'}
$pairName=if($ProfileName -ceq 'chatgpt-remote-commander'){'default'}else{$ProfileName}
$capsuleName=if($profileExplicit){'rc012-native-pair-dpapi-'+$ProfileName}
             else{'rc012-native-pair-dpapi'}
$target=Join-Path $backupRoot $capsuleName
$files=@(
 ('tunnel-client\'+$ProfileName+'.yaml'),
 ('ChatGPTRemoteCommander\private-pair\'+$pairName+'\ca.crt'),
 ('ChatGPTRemoteCommander\private-pair\'+$pairName+'\client.crt'),
 ('ChatGPTRemoteCommander\private-pair\'+$pairName+'\client.key'),
 ('ChatGPTRemoteCommander\private-pair\'+$pairName+'\server.crt'),
 ('ChatGPTRemoteCommander\private-pair\'+$pairName+'\server.key')
)
function Assert-PrivateFile([string]$File){
 $item=Get-Item -LiteralPath $File -Force -ErrorAction Stop
 if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -le 0 -or $item.Length -gt 262144){
   throw 'RC012_DPAPI_UNSAFE_SOURCE_FILE'
 }
 return $item
}
function Hash([byte[]]$bytes){
 return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
function Ensure-PrivateDirectory([string]$File,[bool]$Create){
 if(-not(Test-Path -LiteralPath $File)){
   if(-not $Create){throw 'RC012_DPAPI_PRIVATE_DIRECTORY_MISSING'}
   [void](New-Item -ItemType Directory -Path $File -ErrorAction Stop)
 }
 $item=Get-Item -LiteralPath $File -Force -ErrorAction Stop
 if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){
   throw 'RC012_DPAPI_DIRECTORY_ALIAS'
 }
 if($Create){
   # Windows CI/admin tokens can create a new directory with Administrators
   # as its owner AND with explicit non-owner Allow ACEs. icacls /grant:r
   # replaces only the owner ACE and does not remove those existing ACEs.
   # Rebuild the DACL on this *new* capsule directory only. For a previously
   # existing directory, the strict checks below reject it without mutation.
   $privateAcl=Get-Acl -LiteralPath $File
   $ownerSid=[Security.Principal.SecurityIdentifier]::new($sid)
   $privateAcl.SetOwner($ownerSid)
   $privateAcl.SetAccessRuleProtection($true,$false)
   foreach($rule in @($privateAcl.Access)){
     [void]$privateAcl.RemoveAccessRuleSpecific($rule)
   }
   $inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
     [Security.AccessControl.InheritanceFlags]::ObjectInherit
   $rule=[Security.AccessControl.FileSystemAccessRule]::new(
     $ownerSid,[Security.AccessControl.FileSystemRights]::FullControl,
     $inherit,[Security.AccessControl.PropagationFlags]::None,
     [Security.AccessControl.AccessControlType]::Allow)
   $privateAcl.AddAccessRule($rule)
   Set-Acl -LiteralPath $File -AclObject $privateAcl -ErrorAction Stop
 }
 $acl=Get-Acl -LiteralPath $File
 $ownerSid=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
 if($ownerSid -ne $sid){throw 'RC012_DPAPI_BACKUP_OWNER_CHANGED'}
 if(-not $acl.AreAccessRulesProtected){throw 'RC012_DPAPI_ACL_INHERITANCE'}
 $other=@($acl.Access|Where-Object {
   $_.AccessControlType -eq 'Allow' -and
   ($_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid)
 })
 if($other.Count -gt 0){throw 'RC012_DPAPI_BACKUP_EXTRA_ACL'}
}
function Read-Sources{
 $entries=@();$total=0
 foreach($rel in $files){
   $full=Join-Path $sourceRoot $rel
   [void](Assert-PrivateFile $full)
   $content=[IO.File]::ReadAllBytes($full)
   $total+=$content.Length
   if($total -gt 524288){throw 'RC012_DPAPI_TOTAL_SOURCE_LIMIT'}
   [void](Assert-PrivateFile $full)
   $second=[IO.File]::ReadAllBytes($full)
   if((Hash $content) -cne (Hash $second)){
     throw 'RC012_DPAPI_SOURCE_CHANGED'
   }
   $entries+=@{name=$rel;length=$content.Length;sha256=(Hash $content);
      data=[Convert]::ToBase64String($content)}
 }
 return ,$entries
}
function Verify-Capsule([string]$Directory,[bool]$TestRestore=$false){
 Ensure-PrivateDirectory $Directory $false
 $blob=Join-Path $Directory 'owner-capsule.dpapi'
 $receipt=Join-Path $Directory 'receipt.json'
 [void](Assert-PrivateFile $blob)
 [void](Assert-PrivateFile $receipt)
 $cipher=[IO.File]::ReadAllBytes($blob)
 $meta=Get-Content -LiteralPath $receipt -Raw -Encoding UTF8 | ConvertFrom-Json
 if($meta.schema -ne 1 -or $meta.mode -ne 'DPAPI_CURRENT_USER' -or $meta.cipherSha256 -cne (Hash $cipher) -or $meta.entries -ne $files.Count){throw 'RC012_DPAPI_RECEIPT_INVALID'}
 # Existing owner-scoped schema-1 capsules predate profileName metadata.
 # Their signed-by-DPAPI file list and current SID still bind the exact six
 # sources; a new scoped capsule must agree in BOTH receipt and ciphertext.
 $receiptScoped=@($meta.PSObject.Properties.Name) -ccontains 'profileName'
 if($receiptScoped -and $meta.profileName -cne $ProfileName){
   throw 'RC012_DPAPI_PROFILE_BINDING_INVALID'
 }
 try{
   $raw=[Security.Cryptography.ProtectedData]::Unprotect(
      $cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 }catch{throw 'RC012_DPAPI_CURRENT_USER_DECRYPT_FAILED'}
 $obj=[Text.Encoding]::UTF8.GetString($raw)|ConvertFrom-Json
 if($obj.schema -ne 1 -or $obj.ownerSid -ne $sid -or @($obj.files).Count -ne $files.Count){throw 'RC012_DPAPI_CONTENT_INVALID'}
 $payloadScoped=@($obj.PSObject.Properties.Name) -ccontains 'profileName'
 if($payloadScoped -ne $receiptScoped -or
    ($payloadScoped -and $obj.profileName -cne $ProfileName)){
   throw 'RC012_DPAPI_PROFILE_BINDING_INVALID'
 }
 $total=0
 $restoreDir=$null
 if($TestRestore){
   $restoreDir=Join-Path $backupRoot ('.restore-test-'+[guid]::NewGuid().ToString('N'))
   Ensure-PrivateDirectory $restoreDir $true
 }
 try{
 for($i=0;$i -lt $files.Count;$i++){
   $entry=$obj.files[$i]
   if($entry.name -cne $files[$i]){throw 'RC012_DPAPI_FILE_LIST_CHANGED'}
   $data=[Convert]::FromBase64String([string]$entry.data)
   $total+=$data.Length
   if($data.Length -ne $entry.length -or
      (Hash $data) -cne $entry.sha256 -or $total -gt 524288){
      throw 'RC012_DPAPI_ENTRY_MISMATCH'
   }
   if($TestRestore){
     $copy=Join-Path $restoreDir $files[$i]
     [void](New-Item -ItemType Directory -Path (Split-Path -Parent $copy) -Force)
     [IO.File]::WriteAllBytes($copy,$data)
     $again=[IO.File]::ReadAllBytes($copy)
     if((Hash $again) -cne $entry.sha256){throw 'RC012_DPAPI_DRY_RESTORE_MISMATCH'}
   }
 }
 }finally{
   if($restoreDir -and (Test-Path -LiteralPath $restoreDir)){
     Remove-Item -LiteralPath $restoreDir -Force -Recurse -ErrorAction Stop
   }
 }
 return @{verified=$true;fileCount=$files.Count;bytes=$total;
   sourceDigest=(Hash ([Text.Encoding]::UTF8.GetBytes(
       (($obj.files|ForEach-Object {$_.name+':'+$_.sha256}) -join '|'))))}
}
if($Mode -in @('Verify','TestRestore')){
 $report=Verify-Capsule $target ($Mode -eq 'TestRestore')
 $marker=if($Mode -eq 'TestRestore'){'RC012_WINDOWS_OWNER_DPAPI_RESTORE_SIMULATION_PASS'}else{'RC012_WINDOWS_OWNER_DPAPI_BACKUP_VERIFY_PASS'}
 Write-Output ($marker+' files='+$report.fileCount+
   ' encrypted=true originalProfileUnchanged=true actualRestoreNotExecuted=true')
 exit 0
}
$entries=Read-Sources
if(Test-Path -LiteralPath $target){
 $prior=Verify-Capsule $target
 $currentDigest=Hash ([Text.Encoding]::UTF8.GetBytes(
   (($entries|ForEach-Object {$_.name+':'+$_.sha256}) -join '|')))
 if($currentDigest -cne $prior.sourceDigest){
   throw 'RC012_DPAPI_EXISTING_BASELINE_CHANGED'
 }
 Write-Output ('RC012_WINDOWS_OWNER_DPAPI_BACKUP_REUSED files='+
  $prior.fileCount+' encrypted=true originalProfileUnchanged=true')
 exit 0
}
if(-not(Test-Path -LiteralPath $backupRoot)){
 Ensure-PrivateDirectory $backupRoot $true
}else{
 Ensure-PrivateDirectory $backupRoot $false
}
$stage=Join-Path $backupRoot ('.stage-'+[guid]::NewGuid().ToString('N'))
try{
 Ensure-PrivateDirectory $stage $true
 $payload=[Text.Encoding]::UTF8.GetBytes((@{
   schema=1;ownerSid=$sid;files=$entries;profileName=$ProfileName
 }|ConvertTo-Json -Depth 6 -Compress))
 $sealed=[Security.Cryptography.ProtectedData]::Protect(
   $payload,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 [IO.File]::WriteAllBytes((Join-Path $stage 'owner-capsule.dpapi'),$sealed)
 $meta=@{schema=1;mode='DPAPI_CURRENT_USER';entries=$files.Count;
   cipherSha256=(Hash $sealed);profileName=$ProfileName}
 [IO.File]::WriteAllText((Join-Path $stage 'receipt.json'),
   ($meta|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
 [void](Verify-Capsule $stage)
 Move-Item -LiteralPath $stage -Destination $target -ErrorAction Stop
 $stage=$null
 $result=Verify-Capsule $target
 Write-Output ('RC012_WINDOWS_OWNER_DPAPI_BACKUP_STAGE_PASS files='+
    $result.fileCount+' encrypted=true originalProfileUnchanged=true')
}finally{
 if($stage -and (Test-Path -LiteralPath $stage)){
    Remove-Item -LiteralPath $stage -Force -Recurse -ErrorAction SilentlyContinue
 }
}
