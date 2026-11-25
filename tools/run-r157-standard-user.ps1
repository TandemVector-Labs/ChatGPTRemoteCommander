[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Root,
  [Parameter(Mandatory)][string]$Workspace,
  [Parameter(Mandatory)][string]$ExpectedCommit,
  [Parameter(Mandatory)][string]$InstallDir,
  [Parameter(Mandatory)][string]$WindowsJobRunnerPath,
  [switch]$Child,
  [switch]$RunR173Rollback
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

function Get-CurrentTokenClass {
  $probe='C:\Program Files\PowerShell\7\pwsh.exe'
  $tempDir=Join-Path $Root 'TEMP'
  if(-not(Test-Path -LiteralPath $probe -PathType Leaf) -or -not(Test-Path -LiteralPath $tempDir -PathType Container)){return 'UNVERIFIED'}
  $suffix=[guid]::NewGuid().ToString('N')
  $stdoutFile=Join-Path $tempDir ('r157-token-probe-'+$suffix+'.stdout')
  $stderrFile=Join-Path $tempDir ('r157-token-probe-'+$suffix+'.stderr')
  $tokenCheck='$ErrorActionPreference=''Stop'';$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=[Security.Principal.WindowsPrincipal]::new($identity);if([string]$identity.User.Value -eq ''S-1-5-18''){[Console]::Out.Write(''RC_SYSTEM_TOKEN'')}elseif($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){[Console]::Out.Write(''RC_ELEVATED_ADMIN_TOKEN'')}else{[Console]::Out.Write(''RC_NON_ELEVATED_USER_TOKEN'')}'
  try{
    $arguments=@('-NoLogo','-NoProfile','-NonInteractive','-Command',('"'+$tokenCheck+'"'))
    $process=Start-Process -FilePath $probe -ArgumentList $arguments -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile -PassThru -WindowStyle Hidden
    if(-not $process.WaitForExit(3000)){
      try{Stop-Process -Id $process.Id -Force -ErrorAction Stop}catch{}
      return 'UNVERIFIED'
    }
    $stdout=if(Test-Path -LiteralPath $stdoutFile -PathType Leaf){[IO.File]::ReadAllText($stdoutFile)}else{''}
    $stderr=if(Test-Path -LiteralPath $stderrFile -PathType Leaf){[IO.File]::ReadAllText($stderrFile)}else{''}
    if($process.ExitCode -ne 0 -or $stderr.Trim().Length -gt 0 -or $stdout.Length -gt 1024){return 'UNVERIFIED'}
    switch($stdout.Trim()){
      'RC_SYSTEM_TOKEN' {return 'SYSTEM'}
      'RC_ELEVATED_ADMIN_TOKEN' {return 'ELEVATED_ADMIN'}
      'RC_NON_ELEVATED_USER_TOKEN' {return 'STANDARD'}
      default {return 'UNVERIFIED'}
    }
  }catch{
    return 'UNVERIFIED'
  }finally{
    Remove-Item -LiteralPath $stdoutFile,$stderrFile -Force -ErrorAction SilentlyContinue
  }
}


function Write-R157CleanupReceipt {
  param(
    [Parameter(Mandatory)][ValidateSet('PASS','NOT_REQUIRED_STANDARD_PARENT','FAIL')][string]$Status,
    [Parameter(Mandatory)][bool]$AccountCreated,
    [Parameter(Mandatory)][bool]$UserRemoved,
    [Parameter(Mandatory)][int]$OwnedProcesses,
    [string]$FileName='R157_STANDARD_USER_CLEANUP.json',
    [string]$Revision='R157_STANDARD_USER_CLEANUP'
  )
  $receipt=[ordered]@{
    schema=1
    revision=$Revision
    status=$Status
    accountCreated=$AccountCreated
    userRemoved=$UserRemoved
    ownedProcesses=$OwnedProcesses
    verifiedUtc=[DateTime]::UtcNow.ToString('o')
  }
  $path=Join-Path $Root $FileName
  [IO.File]::WriteAllText($path,(ConvertTo-Json -InputObject $receipt -Depth 4)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
}

function Assert-R173StandardUserScope {
  if(-not $RunR173Rollback){return}
  if($env:GITHUB_ACTIONS -ne 'true' -or $env:CI -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not $env:RUNNER_TEMP){
    throw 'R173_STANDARD_USER_GITHUB_HOSTED_ONLY'
  }
  $expectedRoot=[IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP 'remote-commander-rollback-r173'))
  $actualRoot=[IO.Path]::GetFullPath($Root)
  if($actualRoot.TrimEnd([char[]]@('\','/')) -cne $expectedRoot.TrimEnd([char[]]@('\','/'))){throw 'R173_STANDARD_USER_ROOT_SCOPE_MISMATCH'}
  $expectedInstall=[IO.Path]::GetFullPath((Join-Path $expectedRoot 'INSTALL'))
  if([IO.Path]::GetFullPath($InstallDir).TrimEnd([char[]]@('\','/')) -cne $expectedInstall.TrimEnd([char[]]@('\','/'))){throw 'R173_STANDARD_USER_INSTALL_SCOPE_MISMATCH'}
  if($ExpectedCommit -notmatch '^[0-9a-f]{40}$'){throw 'R173_STANDARD_USER_COMMIT_INVALID'}
  if(-not(Test-Path -LiteralPath (Join-Path $Workspace 'test\release-rollback-windows-r173.ps1') -PathType Leaf)){throw 'R173_STANDARD_USER_SCRIPT_MISSING'}
}
function Set-R157PrivateHome {
  $homePath=Join-Path $Root 'USERPROFILE'
  if(Test-Path -LiteralPath $homePath){
    $item=Get-Item -LiteralPath $homePath -Force -ErrorAction Stop
    if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'R157_PRIVATE_HOME_UNSAFE'}
  }else{
    New-Item -ItemType Directory -Path $homePath -ErrorAction Stop|Out-Null
  }
  $privateHome=[IO.Path]::GetFullPath($homePath)
  $drive=[IO.Path]::GetPathRoot($privateHome).TrimEnd([char[]]@('\','/'))
  if(-not $drive -or $privateHome.Length -le $drive.Length){throw 'R157_PRIVATE_HOME_INVALID'}
  $env:USERPROFILE=$privateHome
  $env:HOME=$privateHome
  $env:HOMEDRIVE=$drive
  $env:HOMEPATH=$privateHome.Substring($drive.Length)
  if(-not(Test-Path -LiteralPath $env:USERPROFILE -PathType Container)){throw 'R157_PRIVATE_HOME_NOT_WRITABLE'}
}

function Invoke-R173RollbackScript {
  $env:RUNNER_TEMP=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Root))
  Assert-R173StandardUserScope
  $script=Join-Path $Workspace 'test\release-rollback-windows-r173.ps1'
  if(-not(Test-Path -LiteralPath $script -PathType Leaf)){throw 'R173_STANDARD_USER_SCRIPT_MISSING'}
  $pathFile=Join-Path $Root 'R157_STANDARD_USER.path'
  if(Test-Path -LiteralPath $pathFile -PathType Leaf){$env:PATH=[IO.File]::ReadAllText($pathFile)}
  Set-R157PrivateHome
  $env:GITHUB_WORKSPACE=$Workspace
  $env:LOCALAPPDATA=Join-Path $Root 'STATE'
  $env:APPDATA=Join-Path $Root 'ROAMING'
  $env:TEMP=Join-Path $Root 'TEMP'
  $env:TMP=$env:TEMP
  Set-Location -LiteralPath $Workspace
  $arguments=@('-NoLogo','-NoProfile','-NonInteractive','-File',$script,'-ExpectedCommit',$ExpectedCommit,'-WindowsJobRunnerPath',$WindowsJobRunnerPath)
  $childOutput=& pwsh.exe @arguments
  $childExit=[int]$LASTEXITCODE
  if($childOutput){[Console]::Out.WriteLine(($childOutput -join [Environment]::NewLine))}
  return $childExit
}
function Invoke-R157Updater {
  if(-not(Test-Path -LiteralPath $Workspace -PathType Container)){throw 'R157_STANDARD_WORKSPACE_MISSING'}
  if(-not(Test-Path -LiteralPath $WindowsJobRunnerPath -PathType Leaf)){throw 'R157_STANDARD_RUNNER_MISSING'}
  foreach($dir in @((Join-Path $Root 'STATE'),(Join-Path $Root 'ROAMING'),(Join-Path $Root 'TEMP'))){
    if(-not(Test-Path -LiteralPath $dir -PathType Container)){throw 'R157_STANDARD_PRIVATE_STATE_MISSING'}
  }
  Set-R157PrivateHome
  $env:LOCALAPPDATA=Join-Path $Root 'STATE'
  $env:APPDATA=Join-Path $Root 'ROAMING'
  $env:TEMP=Join-Path $Root 'TEMP'
  $env:TMP=$env:TEMP
  $env:GITHUB_WORKSPACE=$Workspace
  Set-Location -LiteralPath $Workspace
  if(-not(Get-Command node.exe -ErrorAction SilentlyContinue) -or -not(Get-Command git.exe -ErrorAction SilentlyContinue)){throw 'R157_STANDARD_USER_TOOL_PATH_MISSING'}
  $tokenProbe=Join-Path $Workspace 'tools\r157-standard-token-probe.mjs'
  if(-not(Test-Path -LiteralPath $tokenProbe -PathType Leaf)){throw 'R157_STANDARD_USER_NODE_TOKEN_PROBE_MISSING'}
  $tokenProbeOutput=& node.exe $tokenProbe
  $tokenProbeExit=[int]$LASTEXITCODE
  if($tokenProbeOutput){[Console]::Out.WriteLine([string]$tokenProbeOutput)}
  if($tokenProbeExit -ne 0){throw 'R157_STANDARD_USER_NODE_TOKEN_PROBE_FAILED'}
  $pwsh=Join-Path $PSHOME 'pwsh.exe'
  if(-not(Test-Path -LiteralPath $pwsh -PathType Leaf)){throw 'R157_STANDARD_USER_PWSH_MISSING'}
  $stdout=Join-Path $Root 'R157_UPDATER.stdout.log'
  $stderr=Join-Path $Root 'R157_UPDATER.stderr.log'
  $arguments=@('-NoLogo','-NoProfile','-NonInteractive','-File',(Join-Path $Workspace 'auto-update-windows.ps1'),'-InstallDir',$InstallDir,'-SourceRef',$ExpectedCommit,'-ExpectedCommit',$ExpectedCommit,'-TargetProfile','default','-WindowsJobRunnerPath',$WindowsJobRunnerPath,'-NoPromote')
  $process=Start-Process -FilePath $pwsh -ArgumentList $arguments -WorkingDirectory $Workspace -RedirectStandardOutput $stdout -RedirectStandardError $stderr -Wait -PassThru -WindowStyle Hidden
  if(Test-Path -LiteralPath $stdout -PathType Leaf){
    $outText=Get-Content -LiteralPath $stdout -Raw -ErrorAction Stop
    if($outText){[Console]::Out.WriteLine($outText.TrimEnd())}
  }
  if(Test-Path -LiteralPath $stderr -PathType Leaf){
    $errText=Get-Content -LiteralPath $stderr -Raw -ErrorAction Stop
    if($errText){[Console]::Error.WriteLine($errText.TrimEnd())}
  }
  return [int]$process.ExitCode
}

if($Child){
  try{
    if((Get-CurrentTokenClass) -ne 'STANDARD'){throw 'R157_STANDARD_TOKEN_ASSERTION_FAILED'}
    foreach($path in @($Root,$Workspace,$InstallDir,$WindowsJobRunnerPath)){
      if(-not [IO.Path]::IsPathFullyQualified($path)){throw 'R157_STANDARD_PATH_NOT_ABSOLUTE'}
    }
    if($RunR173Rollback){
      $env:RUNNER_TEMP=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Root))
      Assert-R173StandardUserScope
      Write-Output 'R173_STANDARD_USER_TOKEN_PASS'
      $code=Invoke-R173RollbackScript
      Write-Output "R173_STANDARD_USER_SCRIPT_EXIT=$code"
      exit $code
    }
    $pathFile=Join-Path $Root 'R157_STANDARD_USER.path'
    if(Test-Path -LiteralPath $pathFile -PathType Leaf){$env:PATH=[IO.File]::ReadAllText($pathFile)}
    Write-Output 'R157_STANDARD_USER_TOKEN_PASS'
    $code=Invoke-R157Updater
    Write-Output "R157_STANDARD_USER_UPDATER_EXIT=$code"
    exit $code
  }catch{
    [Console]::Error.WriteLine("R157_STANDARD_USER_CHILD_FAIL: $($_.Exception.Message)")
    exit 1
  }
}

$created=$false
$user=$null
$userName=$null
try{
  if($ExpectedCommit -notmatch '^[0-9a-f]{40}$'){throw 'R157_STANDARD_EXPECTED_COMMIT_INVALID'}
  foreach($path in @($Root,$Workspace,$InstallDir,$WindowsJobRunnerPath)){
    if(-not [IO.Path]::IsPathFullyQualified($path)){throw 'R157_STANDARD_PATH_NOT_ABSOLUTE'}
  }
  Assert-R173StandardUserScope
  if($RunR173Rollback){
    if(Test-Path -LiteralPath $Root){throw 'R173_STANDARD_USER_NO_BLIND_RERUN'}
    New-Item -ItemType Directory -Path $Root -ErrorAction Stop|Out-Null
    [IO.File]::WriteAllText((Join-Path $Root 'R173_STANDARD_USER_SANDBOX.txt'),'R173_STANDARD_USER_SANDBOX_V1',[Text.UTF8Encoding]::new($false))
  }else{
    if(!(Test-Path -LiteralPath $Root -PathType Container)){throw 'R157_STANDARD_ROOT_MISSING'}
  }
  if(-not(Test-Path -LiteralPath $Workspace -PathType Container)){throw 'R157_STANDARD_WORKSPACE_MISSING'}
  if(-not(Test-Path -LiteralPath $WindowsJobRunnerPath -PathType Leaf)){throw 'R157_STANDARD_RUNNER_MISSING'}
  New-Item -ItemType Directory -Force -Path (Join-Path $Root 'TEMP')|Out-Null
  $parentToken=Get-CurrentTokenClass
  Write-Output "R157_PARENT_TOKEN_CLASS=$parentToken"
  if($parentToken -eq 'UNVERIFIED'){throw 'R157_PARENT_TOKEN_UNVERIFIED'}
  if($parentToken -eq 'STANDARD'){
    if($RunR173Rollback){
      Write-Output 'R173_STANDARD_USER_CURRENT_TOKEN_PASS'
      $code=Invoke-R173RollbackScript
      if($code -ne 0){throw "R173_STANDARD_USER_SCRIPT_EXIT_$code"}
      Write-R157CleanupReceipt -Status 'NOT_REQUIRED_STANDARD_PARENT' -AccountCreated $false -UserRemoved $false -OwnedProcesses 0 -FileName 'R173_STANDARD_USER_CLEANUP.json' -Revision 'R173_STANDARD_USER_CLEANUP'
      Write-Output 'R173_STANDARD_USER_SCRIPT_PASS'
      exit 0
    }
    Write-R157CleanupReceipt -Status 'NOT_REQUIRED_STANDARD_PARENT' -AccountCreated $false -UserRemoved $false -OwnedProcesses 0
    Write-Output 'R157_STANDARD_USER_CURRENT_TOKEN_PASS'
    $code=Invoke-R157Updater
    if($code -ne 0){throw "R157_STANDARD_USER_UPDATER_EXIT_$code"}
    Write-Output 'R157_STANDARD_USER_UPDATER_PASS'
    exit 0
  }

  Import-Module Microsoft.PowerShell.LocalAccounts -ErrorAction Stop
  $runId=if([string]$env:GITHUB_RUN_ID -match '^\d+$'){[string]$env:GITHUB_RUN_ID}else{[guid]::NewGuid().ToString('N').Substring(0,10)}
  $userName=('rc157'+$runId)
  if($userName.Length -gt 20){$userName=$userName.Substring(0,20)}
  if(Get-LocalUser -Name $userName -ErrorAction SilentlyContinue){throw 'R157_STANDARD_USER_COLLISION'}
  $passwordText=[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))+'Aa1!'
  $securePassword=ConvertTo-SecureString $passwordText -AsPlainText -Force
  $passwordText=$null
  $user=New-LocalUser -Name $userName -Password $securePassword -Description 'Ephemeral R157 non-admin test identity' -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -ErrorAction Stop
  $created=$true
  $account="$env:COMPUTERNAME\$userName"
  $admins=@(Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop)
  if(@($admins|Where-Object{$_.SID.Value -eq $user.SID.Value}).Count -ne 0){throw 'R157_STANDARD_USER_ADMIN_MEMBERSHIP'}
  $members=@(Get-LocalGroupMember -Group 'Users' -ErrorAction Stop)
  if(@($members|Where-Object{$_.SID.Value -eq $user.SID.Value}).Count -eq 0){Add-LocalGroupMember -Group 'Users' -Member $userName -ErrorAction Stop}
  foreach($grant in @(
    @{Path=$Workspace;Rule=($account+':(OI)(CI)RX')},
    @{Path=$Root;Rule=($account+':(OI)(CI)F')}
  )){
    & icacls.exe $grant.Path /grant $grant.Rule /T /C /Q | Out-Null
    if($LASTEXITCODE -ne 0){throw 'R157_STANDARD_USER_ACL_GRANT_FAILED'}
  }
  $pwsh=Join-Path $PSHOME 'pwsh.exe'
  if(-not(Test-Path -LiteralPath $pwsh -PathType Leaf)){throw 'R157_STANDARD_USER_PWSH_MISSING'}
  [IO.File]::WriteAllText((Join-Path $Root 'R157_STANDARD_USER.path'),[string]$env:PATH,[Text.UTF8Encoding]::new($false))
  $stdout=Join-Path $Root 'R157_STANDARD_USER.stdout.log'
  $stderr=Join-Path $Root 'R157_STANDARD_USER.stderr.log'
  $credential=[PSCredential]::new($account,$securePassword)
  $arguments=@('-NoLogo','-NoProfile','-NonInteractive','-File',$PSCommandPath,'-Child','-Root',$Root,'-Workspace',$Workspace,'-ExpectedCommit',$ExpectedCommit,'-InstallDir',$InstallDir,'-WindowsJobRunnerPath',$WindowsJobRunnerPath)
  if($RunR173Rollback){$arguments+= '-RunR173Rollback'}
  $childProcess=Start-Process -FilePath $pwsh -ArgumentList $arguments -Credential $credential -LoadUserProfile -WorkingDirectory $Workspace -RedirectStandardOutput $stdout -RedirectStandardError $stderr -Wait -PassThru -WindowStyle Hidden
  if(Test-Path -LiteralPath $stdout -PathType Leaf){
    $outText=Get-Content -LiteralPath $stdout -Raw -ErrorAction Stop
    if($outText){Write-Output $outText.TrimEnd()}
  }
  if(Test-Path -LiteralPath $stderr -PathType Leaf){
    $errText=Get-Content -LiteralPath $stderr -Raw -ErrorAction Stop
    if($errText){Write-Output ("R157_STANDARD_USER_STDERR: "+$errText.TrimEnd())}
  }
  if($childProcess.ExitCode -ne 0){throw "R157_STANDARD_USER_CHILD_EXIT_$($childProcess.ExitCode)"}
  Write-Output 'R157_STANDARD_USER_UPDATER_PASS'
}catch{
  [Console]::Error.WriteLine("R157_STANDARD_USER_FAIL: $($_.Exception.Message)")
  throw
}finally{
  if($created -and $user){
    $cleanupError=$null
    $leakCount=0
    $userRemoved=$false
    try{
      $leaks=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop | Where-Object{$_.CommandLine -and ([string]$_.CommandLine).Contains($Root)})
      $leakCount=$leaks.Count
      if($leakCount -ne 0){throw 'R157_STANDARD_USER_CLEANUP_DEFERRED_NODE_PROCESS_REMAINS'}
      Remove-LocalUser -Name $userName -ErrorAction Stop
      if(Get-LocalUser -Name $userName -ErrorAction SilentlyContinue){throw 'R157_STANDARD_USER_ACCOUNT_STILL_PRESENT'}
      $userRemoved=$true
      $profiles=@(Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue | Where-Object{$_.SID -eq $user.SID.Value})
      foreach($profile in $profiles){
        if($profile.Loaded){throw 'R157_STANDARD_USER_PROFILE_STILL_LOADED'}
        $profile|Remove-CimInstance -ErrorAction Stop
      }
      $profilesRemaining=@(Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue | Where-Object{$_.SID -eq $user.SID.Value})
      if($profilesRemaining.Count -ne 0){throw 'R157_STANDARD_USER_PROFILE_STILL_PRESENT'}
    }catch{
      $cleanupError=$_.Exception.Message
    }
    if($cleanupError){
      $receiptName=if($RunR173Rollback){'R173_STANDARD_USER_CLEANUP.json'}else{'R157_STANDARD_USER_CLEANUP.json'}
      Write-R157CleanupReceipt -Status 'FAIL' -AccountCreated $true -UserRemoved $userRemoved -OwnedProcesses $leakCount -FileName $receiptName -Revision $(if($RunR173Rollback){'R173_STANDARD_USER_CLEANUP'}else{'R157_STANDARD_USER_CLEANUP'})
      Write-Output 'R157_STANDARD_USER_CLEANUP_FAIL'
      throw 'R157_STANDARD_USER_CLEANUP_FAIL'
    }
    $receiptName=if($RunR173Rollback){'R173_STANDARD_USER_CLEANUP.json'}else{'R157_STANDARD_USER_CLEANUP.json'}
    Write-R157CleanupReceipt -Status 'PASS' -AccountCreated $true -UserRemoved $true -OwnedProcesses 0 -FileName $receiptName -Revision $(if($RunR173Rollback){'R173_STANDARD_USER_CLEANUP'}else{'R157_STANDARD_USER_CLEANUP'})
    Write-Output 'R157_STANDARD_USER_CLEANUP_PASS'
  }
}
