# Native Windows receive destination guard. Embedded in standalone Pilot.
# Each directory component opens relative to its HELD parent NT handle, not via
# fresh absolute pathname lookup. No handle shares delete/rename access.
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CtMeshWinDirectoryGuard {
 [StructLayout(LayoutKind.Sequential)] struct UnicodeString {
  public ushort Length, MaximumLength; public IntPtr Buffer;
 }
 [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes {
  public uint Length; public IntPtr RootDirectory,ObjectName;
  public uint Attributes; public IntPtr SecurityDescriptor,SecurityQualityOfService;
 }
 [StructLayout(LayoutKind.Sequential)] struct IoStatus {public IntPtr Status,Information;}
 [StructLayout(LayoutKind.Sequential)] struct TagInfo {public uint Attributes, ReparseTag;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="CreateFileW")]
 static extern SafeFileHandle CreateFileW(string path,uint access,uint share,
   IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("ntdll.dll",ExactSpelling=true)]
 static extern int NtCreateFile(out SafeFileHandle handle,uint access,
   ref ObjectAttributes attrs,out IoStatus status,IntPtr allocation,
   uint fileAttributes,uint share,uint disposition,uint options,IntPtr ea,uint eaLength);
 [DllImport("kernel32.dll",SetLastError=true)]
 static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,
   int infoClass,out TagInfo info,uint length);
 static void Check(SafeFileHandle h) {
  if(h.IsInvalid || !GetFileInformationByHandleEx(h,9,out TagInfo info,
      (uint)Marshal.SizeOf<TagInfo>()) ||
     (info.Attributes & 0x410) != 0x10)
     throw new IOException("DESTINATION_DIRECTORY_UNTRUSTED");
 }
 static SafeFileHandle Child(SafeFileHandle parent,string component){
  if(String.IsNullOrWhiteSpace(component)||component=="."||component==".."||
     component.IndexOfAny(new[]{'\\','/',':'})>=0)
     throw new IOException("INVALID_DESTINATION_COMPONENT");
  IntPtr str=IntPtr.Zero, name=IntPtr.Zero;
  try{
   str=Marshal.StringToHGlobalUni(component);
   var us=new UnicodeString {
    Length=checked((ushort)(component.Length*2)),
    MaximumLength=checked((ushort)((component.Length+1)*2)),
    Buffer=str
   };
   name=Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeString>());
   Marshal.StructureToPtr(us,name,false);
   var attributes=new ObjectAttributes{
    Length=(uint)Marshal.SizeOf<ObjectAttributes>(),
    RootDirectory=parent.DangerousGetHandle(),ObjectName=name,Attributes=0x40
   };
   // FILE_TRAVERSE|FILE_READ_ATTRIBUTES|SYNCHRONIZE; share read/write only.
   // FILE_DIRECTORY_FILE|FILE_OPEN_REPARSE_POINT|FILE_SYNCHRONOUS_IO_NONALERT.
   int result=NtCreateFile(out SafeFileHandle h,0x1000A0,
      ref attributes,out _,IntPtr.Zero,0,3,1,0x200021,IntPtr.Zero,0);
   if(result<0){h?.Dispose();throw new IOException("DESTINATION_NATIVE_OPEN_FAILED");}
   try{Check(h);return h;}catch{h.Dispose();throw;}
  }finally{
   if(name!=IntPtr.Zero)Marshal.FreeHGlobal(name);
   if(str!=IntPtr.Zero)Marshal.FreeHGlobal(str);
  }
 }
 public static List<SafeFileHandle> Pin(string location){
  if(String.IsNullOrWhiteSpace(location)||location.Length<3||
      !Char.IsLetter(location[0])||location[1]!=':'||
      (location[2]!='\\'&&location[2]!='/')||location.StartsWith(@"\\"))
      throw new IOException("LOCAL_DRIVE_DESTINATION_REQUIRED");
  string full=Path.GetFullPath(location);
  var handles=new List<SafeFileHandle>();
  try{
   var drive=CreateFileW(full.Substring(0,2)+@"\",0x1000A0,3,
     IntPtr.Zero,3,0x02200000,IntPtr.Zero);
   handles.Add(drive);Check(drive);
   var parent=drive;
   foreach(var component in full.Substring(3).Split(new[]{'\\','/'},
      StringSplitOptions.RemoveEmptyEntries)){
    var next=Child(parent,component);
    handles.Add(next);parent=next;
   }
   return handles;
  }catch{foreach(var h in handles)h.Dispose();throw;}
 }
}
'@
$held=$null
try{
 $held=[CtMeshWinDirectoryGuard]::Pin($env:CTMESH_PIN_DEST)
 [Console]::Out.WriteLine('CTMESH_PIN_READY')
 [Console]::Out.Flush()
 $null=[Console]::ReadLine()
}catch{
 [Console]::Error.WriteLine('CTMESH_PIN_ERROR')
 exit 2
}finally{if($null -ne $held){foreach($h in $held){$h.Dispose()}}}
