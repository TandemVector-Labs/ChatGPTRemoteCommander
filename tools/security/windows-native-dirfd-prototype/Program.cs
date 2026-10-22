using Microsoft.Win32.SafeHandles;
using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;

static class Native
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct UnicodeString { internal ushort Length, MaximumLength; internal IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)]
    internal struct ObjectAttributes
    {
        internal uint Length;
        internal IntPtr RootDirectory, ObjectName;
        internal uint Attributes;
        internal IntPtr SecurityDescriptor, SecurityQualityOfService;
    }
    [StructLayout(LayoutKind.Sequential)]
    internal struct IoStatus { internal IntPtr Status, Information; }
    [StructLayout(LayoutKind.Sequential)]
    internal struct AttrTagInfo { internal uint Attributes, ReparseTag; }

    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="CreateFileW")]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("ntdll.dll", ExactSpelling=true)]
    static extern int NtCreateFile(out SafeFileHandle handle, uint desiredAccess, ref ObjectAttributes attributes, out IoStatus ioStatus, IntPtr allocationSize, uint fileAttributes, uint shareAccess, uint createDisposition, uint createOptions, IntPtr eaBuffer, uint eaLength);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, out AttrTagInfo info, uint size);

    const uint SYNCHRONIZE=0x100000, FILE_READ_ATTRIBUTES=0x80, FILE_TRAVERSE=0x20, FILE_READ_DATA=1;
    const uint SHARE_ALL=7, OPEN_EXISTING=3;
    const uint BACKUP_SEMANTICS=0x02000000, OPEN_REPARSE_POINT_WIN32=0x00200000;
    const uint DIR=1, NOT_DIR=0x40, OPEN_REPARSE_POINT=0x00200000, SYNC_NONALERT=0x20;
    const uint OBJ_CASE_INSENSITIVE=0x40;
    const uint FILE_ATTRIBUTE_REPARSE_POINT=0x400;
    internal static void SafeCheck(SafeFileHandle h, bool isDirectory)
    {
        if(h.IsInvalid || !GetFileInformationByHandleEx(h,9,out AttrTagInfo info,(uint)Marshal.SizeOf<AttrTagInfo>()))
            throw new IOException("INVALID_HANDLE_OR_FILE_METADATA");
        if((info.Attributes & FILE_ATTRIBUTE_REPARSE_POINT)!=0)
            throw new IOException("REPARSE_COMPONENT_REJECTED");
        var actualDir=(info.Attributes & 0x10)!=0;
        if(actualDir!=isDirectory)throw new IOException("WRONG_FILE_TYPE");
    }
    internal static SafeFileHandle OpenDriveRoot(string drive)
    {
        var h=CreateFileW(drive+@"\",FILE_TRAVERSE|FILE_READ_ATTRIBUTES|SYNCHRONIZE,SHARE_ALL,IntPtr.Zero,OPEN_EXISTING,
            BACKUP_SEMANTICS|OPEN_REPARSE_POINT_WIN32,IntPtr.Zero);
        SafeCheck(h,true);return h;
    }
    internal static SafeFileHandle OpenChild(SafeFileHandle parent,string name,bool isDir)
    {
        if(string.IsNullOrEmpty(name)||name=="."||name==".."||name.Contains('\\')||name.Contains('/')||name.Contains(':'))
            throw new ArgumentException("UNSAFE_COMPONENT");
        IntPtr namePtr=IntPtr.Zero, uPtr=IntPtr.Zero;
        try{
            namePtr=Marshal.StringToHGlobalUni(name);
            UnicodeString u=new(){Length=checked((ushort)(name.Length*2)),MaximumLength=checked((ushort)((name.Length+1)*2)),Buffer=namePtr};
            uPtr=Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeString>());
            Marshal.StructureToPtr(u,uPtr,false);
            var attrs=new ObjectAttributes{Length=(uint)Marshal.SizeOf<ObjectAttributes>(),RootDirectory=parent.DangerousGetHandle(),
                ObjectName=uPtr,Attributes=OBJ_CASE_INSENSITIVE};
            int status=NtCreateFile(out var h,
              (isDir?FILE_TRAVERSE:FILE_READ_DATA)|FILE_READ_ATTRIBUTES|SYNCHRONIZE,
              ref attrs,out _,IntPtr.Zero,0,SHARE_ALL,1,
              (isDir?DIR:NOT_DIR)|OPEN_REPARSE_POINT|SYNC_NONALERT,IntPtr.Zero,0);
            if(status<0){h?.Dispose();throw new IOException("NtCreateFile_STATUS_"+status.ToString("X8"));}
            try{SafeCheck(h,isDir);return h;}catch{h.Dispose();throw;}
        }finally{if(uPtr!=IntPtr.Zero)Marshal.FreeHGlobal(uPtr);if(namePtr!=IntPtr.Zero)Marshal.FreeHGlobal(namePtr);}
    }
}

class Program {
 static int Main(string[] args) {
  try {
#if CTMESH_TEST_RACE
   if(args.Length is not (2 or 3))throw new ArgumentException("Usage: RootAbsolute RelFile [test-marker]");
#else
   // Production binaries must never expose deterministic test pause hooks.
   if(args.Length!=2)throw new ArgumentException("Usage: RootAbsolute RelFile");
#endif
   if(!Path.IsPathFullyQualified(args[0])||args[0].StartsWith(@"\\"))throw new ArgumentException("DRIVE_ROOT_ONLY");
   string root=Path.GetFullPath(args[0]), rel=args[1];
   if(string.IsNullOrEmpty(rel)||Path.IsPathRooted(rel)||rel.Contains(':')||rel.StartsWith('\')||rel.StartsWith('/'))
       throw new ArgumentException("RELATIVE_COMPONENTS_ONLY");
   if(root.Length<3||!char.IsLetter(root[0])||root[1]!=':'||root[2]!='\\'||root.StartsWith(@"\\"))
       throw new ArgumentException("DRIVE_ROOT_ONLY");
   var parts=root[3..].Split('\\',StringSplitOptions.RemoveEmptyEntries)
     .Concat(rel.Split(new[]{'\\','/'},StringSplitOptions.RemoveEmptyEntries)).ToArray();
   if(parts.Length<1||parts.Any(p=>p==".."||p=="."||p.Contains(':')))throw new ArgumentException("INVALID_REL_PATH");
   using var drive=Native.OpenDriveRoot(root[..2]);var held=new System.Collections.Generic.List<SafeFileHandle>();
   try {
     var parent=drive;
     for(int i=0;i<parts.Length-1;i++){
      var dir=Native.OpenChild(parent,parts[i],true);
      held.Add(dir);parent=dir;
#if CTMESH_TEST_RACE
      // Never compiled into the ordinary Release binary. Test-only race hook.
      if(args.Length==3&&parts[i].Equals("Linux",StringComparison.OrdinalIgnoreCase)){
       File.WriteAllText(args[2],"PINNED");
       Thread.Sleep(550);
      }
#endif
     }
     using var h=Native.OpenChild(parent,parts[^1],false);
     using var stream=new FileStream(h,FileAccess.Read);
     if(stream.Length<1||stream.Length>131072)throw new IOException("BOUNDED_READ_REJECT");
     byte[] bytes=new byte[stream.Length];stream.ReadExactly(bytes);
     Console.WriteLine(Convert.ToBase64String(bytes));
   }finally { for(int i=held.Count-1;i>=0;i--)held[i].Dispose();}
   return 0;
  }catch(Exception ex){Console.Error.WriteLine(ex.GetType().Name+":"+ex.Message);return 2;}
 }
}