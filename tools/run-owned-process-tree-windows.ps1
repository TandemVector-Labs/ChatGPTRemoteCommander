param(
  [Parameter(Mandatory=$true)][string]$Program,
  [Parameter(Mandatory=$true)][string]$WorkingDirectory,
  [Parameter(Mandatory=$true)][string]$ArgumentsJson,
  [Parameter(Mandatory=$true)][string]$RunId,
  [ValidateRange(1,86400)][int]$TimeoutSeconds = 1200,
  [ValidateRange(0,30000)][int]$DrainGraceMs = 2000,
  [string]$ReportPath = ''
)

$ErrorActionPreference='Stop'
if(-not $IsWindows){ throw 'OWNED_PROCESS_TREE_WINDOWS_ONLY' }
if($RunId -notmatch '^[A-Za-z0-9._:-]{1,160}$'){ throw 'OWNED_PROCESS_TREE_RUN_ID_INVALID' }
if(-not(Test-Path -LiteralPath $WorkingDirectory -PathType Container)){ throw 'OWNED_PROCESS_TREE_CWD_MISSING' }

$arguments=@()
if($ArgumentsJson){
  $parsed=$ArgumentsJson|ConvertFrom-Json
  if($null-ne$parsed){$arguments=@($parsed|ForEach-Object{[string]$_})}
}

if(-not('RcQualificationJobNative' -as [type])){
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class RcQualificationJobNative {
  public const uint CREATE_SUSPENDED = 0x00000004;
  public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  public const uint STARTF_USESTDHANDLES = 0x00000100;
  public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  public const uint WAIT_OBJECT_0 = 0x00000000;
  public const uint WAIT_TIMEOUT = 0x00000102;
  public const int JobObjectExtendedLimitInformation = 9;
  public const int JobObjectBasicProcessIdList = 3;

  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public UInt64 ReadOperationCount;
    public UInt64 WriteOperationCount;
    public UInt64 OtherOperationCount;
    public UInt64 ReadTransferCount;
    public UInt64 WriteTransferCount;
    public UInt64 OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public Int64 PerProcessUserTimeLimit;
    public Int64 PerJobUserTimeLimit;
    public UInt32 LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public UInt32 ActiveProcessLimit;
    public UIntPtr Affinity;
    public UInt32 PriorityClass;
    public UInt32 SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct STARTUPINFO {
    public UInt32 cb;
    public IntPtr lpReserved;
    public IntPtr lpDesktop;
    public IntPtr lpTitle;
    public UInt32 dwX;
    public UInt32 dwY;
    public UInt32 dwXSize;
    public UInt32 dwYSize;
    public UInt32 dwXCountChars;
    public UInt32 dwYCountChars;
    public UInt32 dwFillAttribute;
    public UInt32 dwFlags;
    public UInt16 wShowWindow;
    public UInt16 cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public UInt32 dwProcessId;
    public UInt32 dwThreadId;
  }

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpJobObjectInfo, UInt32 cbJobObjectInfoLength);

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcessW(
    string lpApplicationName,
    StringBuilder lpCommandLine,
    IntPtr lpProcessAttributes,
    IntPtr lpThreadAttributes,
    bool bInheritHandles,
    UInt32 dwCreationFlags,
    IntPtr lpEnvironment,
    string lpCurrentDirectory,
    ref STARTUPINFO lpStartupInfo,
    out PROCESS_INFORMATION lpProcessInformation);

  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

  [DllImport("kernel32.dll", SetLastError=true)]
  static extern UInt32 ResumeThread(IntPtr hThread);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern UInt32 WaitForSingleObject(IntPtr hHandle, UInt32 dwMilliseconds);

  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetExitCodeProcess(IntPtr hProcess, out UInt32 lpExitCode);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool TerminateJobObject(IntPtr hJob, UInt32 uExitCode);

  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool TerminateProcess(IntPtr hProcess, UInt32 uExitCode);

  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool QueryInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpJobObjectInfo, UInt32 cbJobObjectInfoLength, out UInt32 lpReturnLength);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr hObject);

  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr GetStdHandle(Int32 nStdHandle);

  static void Check(bool ok, string name) {
    if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), name);
  }

  public static IntPtr CreateKillOnCloseJob() {
    var job=CreateJobObjectW(IntPtr.Zero,null);
    if(job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(),"CreateJobObjectW");
    var info=new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    int size=Marshal.SizeOf(info);
    IntPtr mem=Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(info,mem,false);
      Check(SetInformationJobObject(job,JobObjectExtendedLimitInformation,mem,(UInt32)size),"SetInformationJobObject");
      return job;
    } catch {
      CloseHandle(job);
      throw;
    } finally {
      Marshal.FreeHGlobal(mem);
    }
  }

  public static PROCESS_INFORMATION CreateSuspended(string application, string commandLine, string cwd) {
    var si=new STARTUPINFO();
    si.cb=(UInt32)Marshal.SizeOf(si);
    si.dwFlags=STARTF_USESTDHANDLES;
    si.hStdInput=GetStdHandle(-10);
    si.hStdOutput=GetStdHandle(-11);
    si.hStdError=GetStdHandle(-12);
    PROCESS_INFORMATION pi;
    var cmd=new StringBuilder(commandLine);
    Check(CreateProcessW(application,cmd,IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT,IntPtr.Zero,cwd,ref si,out pi),"CreateProcessW");
    return pi;
  }

  public static void Assign(IntPtr job, IntPtr process) {
    Check(AssignProcessToJobObject(job,process),"AssignProcessToJobObject");
  }

  public static void Resume(IntPtr thread) {
    UInt32 value=ResumeThread(thread);
    if(value==0xFFFFFFFF) throw new Win32Exception(Marshal.GetLastWin32Error(),"ResumeThread");
  }

  public static UInt32 ExitCode(IntPtr process) {
    UInt32 code;
    Check(GetExitCodeProcess(process,out code),"GetExitCodeProcess");
    return code;
  }

  public static void TerminateProcessHandle(IntPtr process, UInt32 exitCode) {
    Check(TerminateProcess(process,exitCode),"TerminateProcess");
  }

  public static UInt64[] ActiveProcessIds(IntPtr job) {
    int capacity=64;
    int headerBytes=8;
    for(int attempt=0;attempt<7;attempt++,capacity*=2) {
      int bytes=headerBytes+(IntPtr.Size*capacity);
      IntPtr mem=Marshal.AllocHGlobal(bytes);
      try {
        for(int i=0;i<bytes;i++) Marshal.WriteByte(mem,i,0);
        UInt32 returned;
        bool ok=QueryInformationJobObject(job,JobObjectBasicProcessIdList,mem,(UInt32)bytes,out returned);
        UInt32 assigned=unchecked((UInt32)Marshal.ReadInt32(mem,0));
        UInt32 count=unchecked((UInt32)Marshal.ReadInt32(mem,4));
        if(ok) {
          // Win32 declares both count fields as DWORD and only the PID array
          // as ULONG_PTR. The header remains 8 bytes on x64; each PID is 8.
          // Never accept a partial list as proof that the job is empty.
          if(count!=assigned || count>(UInt32)capacity) {
            if(assigned>(UInt32)capacity) continue;
            throw new InvalidOperationException("JOB_PROCESS_LIST_COUNT_MISMATCH");
          }
          var result=new List<UInt64>();
          for(int i=0;i<(int)count;i++) {
            IntPtr value=Marshal.ReadIntPtr(mem,headerBytes+(i*IntPtr.Size));
            result.Add(unchecked((UInt64)value.ToInt64()));
          }
          return result.ToArray();
        }
        int err=Marshal.GetLastWin32Error();
        if(err!=234 && err!=122) throw new Win32Exception(err,"QueryInformationJobObject");
      } finally {
        Marshal.FreeHGlobal(mem);
      }
    }
    throw new InvalidOperationException("JOB_PROCESS_LIST_TOO_LARGE");
  }
}
'@
}

function Quote-WindowsArgument([string]$Value){
  if($null-eq$Value){return '""'}
  if($Value.Length-gt0 -and $Value -notmatch '[\s"]'){return $Value}
  $sb=[Text.StringBuilder]::new()
  [void]$sb.Append('"')
  $slashes=0
  foreach($ch in $Value.ToCharArray()){
    if($ch -eq '\'){
      $slashes++
      continue
    }
    if($ch -eq '"'){
      [void]$sb.Append(('\' * (($slashes*2)+1)))
      [void]$sb.Append('"')
      $slashes=0
      continue
    }
    if($slashes){[void]$sb.Append(('\' * $slashes));$slashes=0}
    [void]$sb.Append($ch)
  }
  if($slashes){[void]$sb.Append(('\' * ($slashes*2)))}
  [void]$sb.Append('"')
  return $sb.ToString()
}

$report=[ordered]@{
  schema=1
  runId=$RunId
  startedAt=(Get-Date).ToUniversalTime().ToString('o')
  program=$Program
  workingDirectory=$WorkingDirectory
  timeoutSeconds=$TimeoutSeconds
  drainGraceMs=$DrainGraceMs
  rootPid=$null
  childExitCode=$null
  timedOut=$false
  cleanupRequired=$false
  activeBeforeCleanup=0
  activeAfterCleanup=$null
  cleanupVerified=$false
  leakedProcesses=@()
  status='STARTING'
  completedAt=$null
}
$job=[IntPtr]::Zero
$pi=$null
$previousRunId=$env:RC_QUALIFICATION_RUN_ID
$hadRunId=Test-Path Env:RC_QUALIFICATION_RUN_ID
$exitCode=1
try{
  $env:RC_QUALIFICATION_RUN_ID=$RunId

  # Launch executables directly and suspended so the kill-on-close Job owns descendants.
  $resolved=(Get-Command $Program -ErrorAction Stop).Source
  if([IO.Path]::GetExtension($resolved).ToLowerInvariant() -eq '.exe'){
    $app=$resolved
    $commandParts=@(Quote-WindowsArgument $app)
    foreach($arg in $arguments){$commandParts+=Quote-WindowsArgument ([string]$arg)}
  }elseif([IO.Path]::GetFileName($resolved).ToLowerInvariant() -eq 'npm.cmd'){
    # NPM's Windows .cmd shim normally adds another process-launching shell.
    # Resolve the supported local Node npm CLI and execute it inside the Job.
    $npmCli=Join-Path (Split-Path -Parent $resolved) 'node_modules\npm\bin\npm-cli.js'
    if(-not(Test-Path -LiteralPath $npmCli -PathType Leaf)){throw 'NPM_NATIVE_CLI_MISSING'}
    $app=(Get-Command node.exe -ErrorAction Stop).Source
    $commandParts=@()
    $commandParts+=Quote-WindowsArgument $app
    $commandParts+=Quote-WindowsArgument $npmCli
    foreach($arg in $arguments){$commandParts+=Quote-WindowsArgument ([string]$arg)}
  }else{
    throw 'QUALIFICATION_UNSUPPORTED_SHELL_WRAPPER_FAIL_CLOSED'
  }
  $commandLine=$commandParts -join ' '

  $job=[RcQualificationJobNative]::CreateKillOnCloseJob()
  $pi=[RcQualificationJobNative]::CreateSuspended($app,$commandLine,$WorkingDirectory)
  $report.rootPid=[int]$pi.dwProcessId
  try{
    [RcQualificationJobNative]::Assign($job,$pi.hProcess)
    [RcQualificationJobNative]::Resume($pi.hThread)
  }catch{
    try{[RcQualificationJobNative]::TerminateJobObject($job,126)|Out-Null}catch{}
    try{[RcQualificationJobNative]::TerminateProcessHandle($pi.hProcess,126)}catch{}
    throw
  }

  $wait=[RcQualificationJobNative]::WaitForSingleObject($pi.hProcess,[uint32]($TimeoutSeconds*1000))
  if($wait -eq [RcQualificationJobNative]::WAIT_TIMEOUT){
    $report.timedOut=$true
    $report.status='TIMEOUT'
    $exitCode=124
  }elseif($wait -eq [RcQualificationJobNative]::WAIT_OBJECT_0){
    $childCode=[RcQualificationJobNative]::ExitCode($pi.hProcess)
    $report.childExitCode=[uint32]$childCode
    $exitCode=[int]$childCode
    $report.status=if($exitCode-eq0){'CHILD_EXITED_SUCCESS'}else{'CHILD_EXITED_FAILURE'}
  }else{
    throw ("OWNED_PROCESS_TREE_WAIT_FAILED code="+$wait)
  }

  # A timeout requires immediate termination; do not spend the drain grace
  # or perform slow WMI/CIM inspection while an untrusted child can still mutate.
  if(-not $report.timedOut){
    $deadline=[DateTime]::UtcNow.AddMilliseconds($DrainGraceMs)
    do{
      $active=@([RcQualificationJobNative]::ActiveProcessIds($job))
      if($active.Count-eq0){break}
      Start-Sleep -Milliseconds 50
    }while([DateTime]::UtcNow-lt$deadline)
  }

  $active=@([RcQualificationJobNative]::ActiveProcessIds($job))
  $report.activeBeforeCleanup=$active.Count
  if($active.Count-gt0){
    $report.cleanupRequired=$true
    # Capture PIDs only before termination. CIM/WMI queries here can block long
    # enough for a descendant to finish an unwanted delayed mutation.
    $report.leakedProcesses=@($active|ForEach-Object{[ordered]@{pid=[UInt64]$_}})
    $terminated=[RcQualificationJobNative]::TerminateJobObject($job,[uint32]125)
    if(-not $terminated){
      $win32=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw ("OWNED_PROCESS_TREE_TERMINATE_JOB_FAILED win32="+$win32)
    }
    $cleanupDeadline=[DateTime]::UtcNow.AddSeconds(5)
    $remaining=@([RcQualificationJobNative]::ActiveProcessIds($job))
    do{
      if($remaining.Count-eq0){break}
      Start-Sleep -Milliseconds 50
      $remaining=@([RcQualificationJobNative]::ActiveProcessIds($job))
    }while([DateTime]::UtcNow-lt$cleanupDeadline)
    $report.activeAfterCleanup=$remaining.Count
    if($remaining.Count-gt0){throw 'OWNED_PROCESS_TREE_CLEANUP_FAILED'}
    $report.cleanupVerified=$true
    if(-not $report.timedOut -and $exitCode-eq0){
      $report.status='DESCENDANT_LEAK_CLEANED'
      $exitCode=125
    }
  }else{
    $report.activeAfterCleanup=0
    $report.cleanupVerified=$true
  }

  if($report.timedOut){
    $report.status='TIMEOUT_CLEANED'
  }elseif($exitCode-eq0){
    $report.status='PASS'
  }elseif($report.status-ne'DESCENDANT_LEAK_CLEANED'){
    $report.status=if($report.cleanupRequired){'FAIL_CLEANED'}else{'FAIL'}
  }
}catch{
  $report.status='RUNNER_ERROR'
  $report.error=$_.Exception.Message
  $exitCode=126
  if($job-ne[IntPtr]::Zero){
    try{
      $active=@([RcQualificationJobNative]::ActiveProcessIds($job))
      $report.activeBeforeCleanup=$active.Count
      if($active.Count){
        $report.cleanupRequired=$true
        $report.leakedProcesses=@($active|ForEach-Object{[ordered]@{pid=[UInt64]$_}})
        $terminated=[RcQualificationJobNative]::TerminateJobObject($job,[uint32]126)
        if(-not $terminated){
          $win32=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
          throw ("OWNED_PROCESS_TREE_TERMINATE_JOB_FAILED win32="+$win32)
        }
        $cleanupDeadline=[DateTime]::UtcNow.AddSeconds(5)
        $remaining=@([RcQualificationJobNative]::ActiveProcessIds($job))
        do{
          if($remaining.Count-eq0){break}
          Start-Sleep -Milliseconds 50
          $remaining=@([RcQualificationJobNative]::ActiveProcessIds($job))
        }while([DateTime]::UtcNow-lt$cleanupDeadline)
        $report.activeAfterCleanup=$remaining.Count
        if($remaining.Count-gt0){throw 'OWNED_PROCESS_TREE_CLEANUP_FAILED'}
        $report.cleanupVerified=$true
      }else{
        $report.activeAfterCleanup=0
        $report.cleanupVerified=$true
      }
    }catch{
      $report.cleanupVerified=$false
      $report.cleanupError=$_.Exception.Message
    }
  }
}finally{
  $report.completedAt=(Get-Date).ToUniversalTime().ToString('o')
  if($ReportPath){
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReportPath)|Out-Null
    [IO.File]::WriteAllText($ReportPath,($report|ConvertTo-Json -Depth 12)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
  }
  Write-Output ("QUALIFICATION_JOB_RESULT "+($report|ConvertTo-Json -Depth 12 -Compress))
  if($pi){
    if($pi.hThread-ne[IntPtr]::Zero){[RcQualificationJobNative]::CloseHandle($pi.hThread)|Out-Null}
    if($pi.hProcess-ne[IntPtr]::Zero){[RcQualificationJobNative]::CloseHandle($pi.hProcess)|Out-Null}
  }
  if($job-ne[IntPtr]::Zero){[RcQualificationJobNative]::CloseHandle($job)|Out-Null}
  if($hadRunId){$env:RC_QUALIFICATION_RUN_ID=$previousRunId}else{Remove-Item Env:RC_QUALIFICATION_RUN_ID -ErrorAction SilentlyContinue}
}
exit $exitCode
