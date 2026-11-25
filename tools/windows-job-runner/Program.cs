// Commander V1 Windows Job Object runner.
// Child is created suspended, assigned to a kill-on-close job, then resumed.
// Never accepts a shell expression; parent Commander validates executable/args.
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

internal static class Program {
  private const uint CREATE_SUSPENDED = 0x00000004;
  private const uint CREATE_NO_WINDOW = 0x08000000;
  private const uint STARTF_USESTDHANDLES = 0x00000100;
  private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
  private const int JobObjectExtendedLimitInformation = 9;
  private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  private const uint WAIT_TIMEOUT = 258;
  private const uint WAIT_FAILED = 0xFFFFFFFF;
  private const uint INFINITE = 0xFFFFFFFF;

  [StructLayout(LayoutKind.Sequential)]
  private struct SECURITY_ATTRIBUTES {
    public uint nLength; public IntPtr lpSecurityDescriptor;
    [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
  }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
  private struct STARTUPINFO {
    public uint cb; public string? lpReserved; public string? lpDesktop; public string? lpTitle;
    public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize;
    public uint dwXCountChars; public uint dwYCountChars; public uint dwFillAttribute;
    public uint dwFlags; public ushort wShowWindow; public ushort cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_INFORMATION {
    public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit;
    public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)]
  [return:MarshalAs(UnmanagedType.Bool)]
  private static extern bool CreateProcessW(string? app, StringBuilder commandLine,
    IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)]bool inherit,
    uint flags, IntPtr environment, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll",SetLastError=true)]
  private static extern IntPtr CreateJobObjectW(IntPtr attributes,string? name);
  [DllImport("kernel32.dll",SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetInformationJobObject(IntPtr job,int jobClass,IntPtr info,uint length);
  [DllImport("kernel32.dll",SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)]
  private static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)]
  private static extern bool TerminateJobObject(IntPtr job,uint exitCode);
  [DllImport("kernel32.dll",SetLastError=true)]
  private static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)]
  private static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)]
  private static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll",SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)]
  private static extern bool DuplicateHandle(IntPtr source,IntPtr sourceHandle,IntPtr target,
    out IntPtr targetHandle,uint access,[MarshalAs(UnmanagedType.Bool)]bool inherit,uint options);
  [DllImport("kernel32.dll")]
  private static extern IntPtr GetCurrentProcess();

  private static void Must(bool ok,string operation) {
    if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error(),operation);
  }

  private static string Quote(string value) {
    if(value.IndexOfAny(new [] { ' ', '\t', '"' }) < 0 && value.Length>0) return value;
    var result = new StringBuilder("\"");
    int slashes=0;
    foreach(char ch in value) {
      if(ch=='\\') { slashes++;continue; }
      if(ch=='"') { result.Append('\\',slashes*2+1);result.Append('"');slashes=0;continue; }
      result.Append('\\',slashes);slashes=0;result.Append(ch);
    }
    result.Append('\\',slashes*2);result.Append('"');return result.ToString();
  }
  private static string ResolveExecutable(string value) {
    if(value.Length==0 || value.Contains('/') || value.Contains('\\') || value.Contains(':'))
      throw new ArgumentException("JOB_EXECUTABLE_MUST_BE_BARE_NAME");
    var candidate = value.EndsWith(".exe",StringComparison.OrdinalIgnoreCase)?value:value+".exe";
    foreach(var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)) {
      if(string.IsNullOrWhiteSpace(dir))continue;
      var full=Path.Combine(dir.Trim('"'),candidate);
      if(File.Exists(full))return Path.GetFullPath(full);
    }
    throw new FileNotFoundException("JOB_EXECUTABLE_NOT_FOUND",candidate);
  }
  private static IntPtr InheritableStdHandle(int index) {
    var handle=GetStdHandle(index);
    if(handle==IntPtr.Zero || handle==new IntPtr(-1))
      throw new InvalidOperationException("JOB_STD_HANDLE_UNAVAILABLE");
    Must(DuplicateHandle(GetCurrentProcess(),handle,GetCurrentProcess(),out var copy,0,true,DUPLICATE_SAME_ACCESS),
      "JOB_STD_HANDLE_DUPLICATION_FAILED");
    return copy;
  }

  private static int Run(string[] args) {
    if(args.Length<5 || args[0]!="--timeout-ms" || !int.TryParse(args[1],out int timeoutMs)
      || timeoutMs<100 || timeoutMs>300000 || args[2]!="--cwd")
      throw new ArgumentException("JOB_RUNNER_ARGUMENTS_INVALID");
    var cwd=Path.GetFullPath(args[3]);
    if(!Directory.Exists(cwd))throw new DirectoryNotFoundException("JOB_CWD_NOT_FOUND");
    int index=4;
    if(args[index]=="--")index++;
    if(index>=args.Length)throw new ArgumentException("JOB_EXECUTABLE_REQUIRED");
    var executable=ResolveExecutable(args[index]);
    var command = new StringBuilder(Quote(executable));
    for(int i=index+1;i<args.Length;i++)command.Append(' ').Append(Quote(args[i]));
    IntPtr job=IntPtr.Zero,input=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero;
    PROCESS_INFORMATION child=default;
    bool created=false,assigned=false;
    try {
      job=CreateJobObjectW(IntPtr.Zero,null);
      if(job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(),"JOB_CREATE_FAILED");
      var limits=new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int size=Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
      IntPtr data=Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(limits,data,false);
        Must(SetInformationJobObject(job,JobObjectExtendedLimitInformation,data,(uint)size),"JOB_LIMIT_FAILED");
      } finally {Marshal.FreeHGlobal(data);}
      input=InheritableStdHandle(-10);
      output=InheritableStdHandle(-11);
      error=InheritableStdHandle(-12);
      var startup = new STARTUPINFO { cb=(uint)Marshal.SizeOf<STARTUPINFO>(),
        dwFlags=STARTF_USESTDHANDLES, hStdInput=input,hStdOutput=output,hStdError=error };
      Must(CreateProcessW(executable,command,IntPtr.Zero,IntPtr.Zero,true,
        CREATE_SUSPENDED|CREATE_NO_WINDOW,IntPtr.Zero,cwd,ref startup,out child),"JOB_CREATE_PROCESS_FAILED");
      created=true;
      Must(AssignProcessToJobObject(job,child.hProcess),"JOB_ASSIGN_FAILED");
      assigned=true;
      if(ResumeThread(child.hThread)==WAIT_FAILED)
        throw new Win32Exception(Marshal.GetLastWin32Error(),"JOB_RESUME_FAILED");
      uint wait=WaitForSingleObject(child.hProcess,(uint)timeoutMs);
      if(wait==WAIT_TIMEOUT) {
        Must(TerminateJobObject(job,124),"JOB_TIMEOUT_TERMINATION_FAILED");
        WaitForSingleObject(child.hProcess,5000);
        Console.Error.WriteLine($"RC_JOB_RESULT_JSON:{{\"timedOut\":true,\"termination\":\"job-object\",\"processId\":{child.dwProcessId}}}");
        return 124;
      }
      if(wait!=0)throw new Win32Exception(Marshal.GetLastWin32Error(),"JOB_WAIT_FAILED");
      Must(GetExitCodeProcess(child.hProcess,out uint code),"JOB_EXIT_CODE_FAILED");
      Console.Error.WriteLine($"RC_JOB_RESULT_JSON:{{\"timedOut\":false,\"termination\":\"job-object\",\"processId\":{child.dwProcessId},\"exitCode\":{code}}}");
      return code>255 ? 1 : (int)code;
    } finally {
      // TerminateJobObject is synchronous for the associated process group.
      if(created && !assigned && child.hProcess!=IntPtr.Zero) {
        try {System.Diagnostics.Process.GetProcessById((int)child.dwProcessId).Kill(true);} catch {}
      }
      if(child.hThread!=IntPtr.Zero)CloseHandle(child.hThread);
      if(child.hProcess!=IntPtr.Zero)CloseHandle(child.hProcess);
      if(job!=IntPtr.Zero)CloseHandle(job); // KILL_ON_JOB_CLOSE covers stray children.
      if(input!=IntPtr.Zero)CloseHandle(input);
      if(output!=IntPtr.Zero)CloseHandle(output);
      if(error!=IntPtr.Zero)CloseHandle(error);
    }
  }
  private static int Main(string[] args) {
    try{return Run(args);}
    catch(Exception e) {
      Console.Error.WriteLine("RC_JOB_FAILURE:"+e.GetType().Name+":"+e.Message);
      return 125;
    }
  }
}
