# Windows receive destination guard. Standalone Pilot must distribute this exact file.
# Hold directory handles without FILE_SHARE_DELETE until Pilot finishes writing.
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CtMeshWinDirectoryGuard {
 [StructLayout(LayoutKind.Sequential)] struct Tag { public uint Attributes; public uint ReparseTag; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true,EntryPoint="CreateFileW")]
 static extern SafeFileHandle Open(string name,uint access,uint share,IntPtr sec,uint create,uint flags,IntPtr template);
 [DllImport("kernel32.dll", SetLastError=true)]
 static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int infoClass,out Tag info,uint size);
 public static List<SafeFileHandle> Pin(string input){
  if(String.IsNullOrWhiteSpace(input)||input.Length<3||!Char.IsLetter(input[0])||
    input[1]!=':'||(input[2]!='\\'&&input[2]!='/')||input.StartsWith(@"\\"))
   throw new IOException("LOCAL_DRIVE_DESTINATION_REQUIRED");
  var full=Path.GetFullPath(input);
  var handles=new List<SafeFileHandle>();
  try{
   var current=full.Substring(0,2)+@"\";
   var components=new List<string>{current};
   foreach(var part in full.Substring(3).Split(new[]{'\\','/'},StringSplitOptions.RemoveEmptyEntries)){
    if(part=="."||part==".."||part.Contains(':'))throw new IOException("INVALID_DESTINATION_COMPONENT");
    current=Path.Combine(current,part);components.Add(current);
   }
   foreach(var path in components){
    // FILE_READ_ATTRIBUTES | SYNCHRONIZE. Share read/write but deny delete/rename.
    // FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT.
    var h=Open(path,0x100080,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
    if(h.IsInvalid){h.Dispose();throw new IOException("PIN_OPEN_FAILED");}
    handles.Add(h);
    if(!GetFileInformationByHandleEx(h,9,out Tag tag,(uint)Marshal.SizeOf<Tag>())||
       (tag.Attributes&0x410)!=0x10)throw new IOException("REPARSE_OR_NON_DIRECTORY");
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
