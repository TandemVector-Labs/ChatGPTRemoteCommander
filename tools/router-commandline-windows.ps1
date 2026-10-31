param(
  [Parameter(Mandatory=$true)]
  [ValidateRange(1,2147483647)]
  [int]$ProcessId
)
$ErrorActionPreference='Stop'
# Read-only, fail-closed fallback when Windows CIM account/SID resolution is broken.
# Native ProcessCommandLineInformation (60) may be unsupported on future Windows.
$source=@'
using System;
using System.Runtime.InteropServices;
public static class RcRouterNativeCommandLine {
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
 [DllImport("ntdll.dll", ExactSpelling=true)] static extern int NtQueryInformationProcess(IntPtr h,int info,IntPtr buffer,int length,out int returned);
 public static string Read(int pid) {
   IntPtr h=OpenProcess(0x1000,false,(uint)pid);
   if(h==IntPtr.Zero) throw new InvalidOperationException("ROUTER_NATIVE_OPEN_DENIED");
   IntPtr ptr=Marshal.AllocHGlobal(65536);
   try {
     int length;
     int code=NtQueryInformationProcess(h,60,ptr,65536,out length);
     if(code<0) throw new InvalidOperationException("ROUTER_NATIVE_QUERY_FAILED");
     int size=(ushort)Marshal.ReadInt16(ptr,0);
     IntPtr value=Marshal.ReadIntPtr(ptr,8);
     if(size<=0 || size%2!=0 || size>60000) throw new InvalidOperationException("ROUTER_NATIVE_BAD_LENGTH");
     long start=ptr.ToInt64(), offset=value.ToInt64();
     if(offset<start || offset+size>start+65536) throw new InvalidOperationException("ROUTER_NATIVE_BAD_ADDRESS");
     string text=Marshal.PtrToStringUni(value,size/2);
     if(String.IsNullOrWhiteSpace(text)) throw new InvalidOperationException("ROUTER_NATIVE_EMPTY");
     return text;
   } finally { Marshal.FreeHGlobal(ptr); CloseHandle(h); }
 }
}
'@
Add-Type -TypeDefinition $source -ErrorAction Stop | Out-Null
[Console]::Out.Write([RcRouterNativeCommandLine]::Read($ProcessId))
