# Native Windows isolated Start Menu shortcut contract; never invokes installer or changes public shortcuts.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(-not $IsWindows){throw 'WINDOWS_SHORTCUT_QA_REQUIRES_WINDOWS'}
$installer=Join-Path $PSScriptRoot '..\desktop\install-windows.ps1'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($installer,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw 'WINDOWS_SHORTCUT_INSTALLER_PARSE_FAILED'}
$functionNodes=@($ast.FindAll({
  param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Assert-CoreStartMenuShortcut'
},$true))
if($functionNodes.Count -ne 1){throw 'WINDOWS_SHORTCUT_CONTRACT_FUNCTION_MISSING'}
. ([scriptblock]::Create($functionNodes[0].Extent.Text))
$contextFns=@($ast.FindAll({
  param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Assert-CorePublicInstallContext'
},$true))
if($contextFns.Count -ne 1){throw 'CORE_PUBLIC_CONTEXT_CONTRACT_MISSING'}
. ([scriptblock]::Create($contextFns[0].Extent.Text))
Assert-CorePublicInstallContext -IdentitySid 'S-1-5-21-100-200-300-1001' -ProfilePath 'C:\Users\TestUser' -RoamingAppData 'C:\Users\TestUser\AppData\Roaming' -LocalAppData 'C:\Users\TestUser\AppData\Local' -SessionId 1
'PASS_NORMAL_USER_CONTEXT'
function Assert-ContextRejected([string]$Name,[string]$Expected,[scriptblock]$Action) {
  $failed=$false
  try { & $Action } catch { if($_.Exception.Message -ne $Expected){throw ('WRONG_CONTEXT_REJECTION_'+$Name+':'+$_.Exception.Message)}; $failed=$true }
  if(-not $failed){throw ('UNSAFE_CONTEXT_ACCEPTED_'+$Name)}
  "PASS_REJECT_$Name"
}
Assert-ContextRejected 'SYSTEM_SID_REDIRECTED_PROFILE' 'CORE_PUBLIC_INSTALL_SYSTEM_CONTEXT' {
  Assert-CorePublicInstallContext -IdentitySid 'S-1-5-18' -ProfilePath 'C:\Users\TestUser' -RoamingAppData 'C:\Users\TestUser\AppData\Roaming' -LocalAppData 'C:\Users\TestUser\AppData\Local' -SessionId 1
}
Assert-ContextRejected 'SYSTEMPROFILE_ROAMING_APPDATA' 'CORE_PUBLIC_INSTALL_SYSTEMPROFILE_PATH' {
  Assert-CorePublicInstallContext -IdentitySid 'S-1-5-21-100-200-300-1001' -ProfilePath 'C:\Users\TestUser' -RoamingAppData 'C:\Windows\System32\config\systemprofile\AppData\Roaming' -LocalAppData 'C:\Users\TestUser\AppData\Local' -SessionId 1
}
Assert-ContextRejected 'MISSING_USER_IDENTITY' 'CORE_PUBLIC_INSTALL_IDENTITY_INCOMPLETE' {
  Assert-CorePublicInstallContext -IdentitySid '' -ProfilePath 'C:\Users\TestUser' -RoamingAppData 'C:\Users\TestUser\AppData\Roaming' -LocalAppData 'C:\Users\TestUser\AppData\Local' -SessionId 1
}


Assert-ContextRejected 'LOCALSERVICE_SID' 'CORE_PUBLIC_INSTALL_SERVICE_CONTEXT' {
  Assert-CorePublicInstallContext -IdentitySid 'S-1-5-19' -ProfilePath 'C:\Users\TestUser' -RoamingAppData 'C:\Users\TestUser\AppData\Roaming' -LocalAppData 'C:\Users\TestUser\AppData\Local' -SessionId 1
}
Assert-ContextRejected 'NETWORKSERVICE_SID' 'CORE_PUBLIC_INSTALL_SERVICE_CONTEXT' {
  Assert-CorePublicInstallContext -IdentitySid 'S-1-5-20' -ProfilePath 'C:\Users\TestUser' -RoamingAppData 'C:\Users\TestUser\AppData\Roaming' -LocalAppData 'C:\Users\TestUser\AppData\Local' -SessionId 1
}
Assert-ContextRejected 'SERVICEPROFILE_PATH' 'CORE_PUBLIC_INSTALL_SERVICEPROFILE_PATH' {
  Assert-CorePublicInstallContext -IdentitySid 'S-1-5-21-100-200-300-1001' -ProfilePath 'C:\Windows\ServiceProfiles\LocalService' -RoamingAppData 'C:\Users\TestUser\AppData\Roaming' -LocalAppData 'C:\Users\TestUser\AppData\Local' -SessionId 1
}
Assert-ContextRejected 'SESSION0_USER_REDIRECT' 'CORE_PUBLIC_INSTALL_NONINTERACTIVE_SESSION' {
  Assert-CorePublicInstallContext -IdentitySid 'S-1-5-21-100-200-300-1001' -ProfilePath 'C:\Users\TestUser' -RoamingAppData 'C:\Users\TestUser\AppData\Roaming' -LocalAppData 'C:\Users\TestUser\AppData\Local' -SessionId 0
}
Assert-ContextRejected 'SESSION_OMITTED' 'CORE_PUBLIC_INSTALL_NONINTERACTIVE_SESSION' {
  Assert-CorePublicInstallContext -IdentitySid 'S-1-5-21-100-200-300-1001' -ProfilePath 'C:\Users\TestUser' -RoamingAppData 'C:\Users\TestUser\AppData\Roaming' -LocalAppData 'C:\Users\TestUser\AppData\Local'
}
$qa=Join-Path ([IO.Path]::GetTempPath()) ('rc-shortcut-contract-'+[guid]::NewGuid().ToString('N'))
$exe=Join-Path $qa 'bin\RemoteCommander.exe'
$other=Join-Path $qa 'bin\other.exe'
$link=Join-Path $qa 'shortcuts\Remote Commander.lnk'
$workdir=Split-Path $exe -Parent
$icon=$exe+',0'
function Assert-ExpectedFailure([string]$Name,[string]$Expected,[scriptblock]$Action) {
  $rejected=$false
  try { & $Action } catch {
    if($_.Exception.Message -ne $Expected){throw ('WRONG_REJECTION_'+$Name+':'+$_.Exception.Message)}
    $rejected=$true
  }
  if(-not $rejected){throw ('UNSAFE_SHORTCUT_ACCEPTED_'+$Name)}
  "PASS_REJECT_$Name"
}
if(Test-Path -LiteralPath $qa){throw 'QA_GUID_COLLISION'}
try {
  [void](New-Item -ItemType Directory -Path $workdir -Force)
  [void](New-Item -ItemType Directory -Path (Split-Path $link -Parent) -Force)
  [IO.File]::WriteAllText($exe,'private fixture; never executed')
  [IO.File]::WriteAllText($other,'private alternate fixture; never executed')
  $w=New-Object -ComObject WScript.Shell
  $s=$w.CreateShortcut($link)
  $s.TargetPath=$exe
  $s.WorkingDirectory=$workdir
  $s.IconLocation=$icon
  $s.Description='Isolated QA shortcut'
  $s.Save()
  Assert-CoreStartMenuShortcut $link $exe $workdir $icon $w
  'PASS_VALID_SHORTCUT'
  $s=$w.CreateShortcut($link); $s.TargetPath=$other; $s.Save()
  Assert-ExpectedFailure 'WRONG_TARGET' 'CORE_SHORTCUT_TARGET_MISMATCH' { Assert-CoreStartMenuShortcut $link $exe $workdir $icon $w }
  $s=$w.CreateShortcut($link); $s.TargetPath=$exe; $s.WorkingDirectory=$qa; $s.Save()
  Assert-ExpectedFailure 'WRONG_WORKDIR' 'CORE_SHORTCUT_WORKDIR_MISMATCH' { Assert-CoreStartMenuShortcut $link $exe $workdir $icon $w }
  $s=$w.CreateShortcut($link); $s.WorkingDirectory=$workdir; $s.IconLocation=$other+',0'; $s.Save()
  Assert-ExpectedFailure 'WRONG_ICON' 'CORE_SHORTCUT_ICON_MISMATCH' { Assert-CoreStartMenuShortcut $link $exe $workdir $icon $w }
  $s=$w.CreateShortcut($link); $s.IconLocation=$icon; $s.Arguments='--unexpected'; $s.Save()
  Assert-ExpectedFailure 'UNEXPECTED_ARGS' 'CORE_SHORTCUT_UNEXPECTED_ARGUMENTS' { Assert-CoreStartMenuShortcut $link $exe $workdir $icon $w }
  $s=$w.CreateShortcut($link); $s.Arguments=''; $s.Save()
  Remove-Item -LiteralPath $exe -Force
  Assert-ExpectedFailure 'MISSING_EXE' 'CORE_SHORTCUT_EXE_MISSING' { Assert-CoreStartMenuShortcut $link $exe $workdir $icon $w }
  Remove-Item -LiteralPath $link -Force
  Assert-ExpectedFailure 'MISSING_LINK' 'CORE_SHORTCUT_MISSING' { Assert-CoreStartMenuShortcut $link $exe $workdir $icon $w }
  'WINDOWS_CORE_SHORTCUT_TARGET_CONTRACT_PASS'
} finally {
  if(Test-Path -LiteralPath $qa){Remove-Item -LiteralPath $qa -Force -Recurse}
}
