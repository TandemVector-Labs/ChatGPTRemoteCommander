// Private fail-closed evidence of a GUI input that may have reached the native desktop.
// No typed text, coordinates, window titles, screenshot or chat contents are stored.
// An unresolved record has NO automatic expiry or reset-on-restart path.
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import {assertUnredirectedDirectoryAncestors} from './managed-path-anchor.mjs';

const SCHEMA='rc-gui-pending-input-v1';
const INPUT_TOOLS=new Set([
  'gui_mouse_move','gui_mouse_delta','gui_mouse_scroll','gui_mouse_click',
  'gui_mouse_drag','gui_type_text','gui_key_press','gui_focus_window'
]);
const fail=(code)=>Object.assign(new Error(code),{guiCode:code});
const defaultFile=()=>{
  const base=process.platform==='win32'
    ?(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'))
    :(process.env.XDG_STATE_HOME||path.join(os.homedir(),'.local','state'));
  return path.join(base,'chatgpt-remote-commander','gui-pending-native-input-v1.json');
};
export function createGuiInputIncidentStore({file=defaultFile(),now=()=>new Date().toISOString(),id=()=>randomUUID()}={}){
  if(!path.isAbsolute(file))throw fail('GUI_INCIDENT_PATH_INVALID');
  const folder=path.dirname(file);
  // The incident directory is sensitive GUI state, not a shared scratch area.
  // POSIX callers must not be able to supply a foreign or group-accessible
  // directory as a writable/readable evidence store.
  function assertPrivateFolder(info){
    if(!info.isDirectory()||info.isSymbolicLink())throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');
    if(process.platform!=='win32'&&typeof process.getuid==='function'&&
       (info.uid!==process.getuid()||(info.mode&0o077)!==0))
      throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');
  }
  // The guard serializes BEGIN/RESOLVE across cooperating local processes.
  // A crashed operation leaves the guard on disk: never reset uncertain GUI
  // state automatically on restart.
  const guard=file+'.exclusive-incident-v1';
  // Keep all Linux ancestor directory FDs alive until the incident operation
  // finishes. A preflight-only pathname is not safe across concurrent rename.
  async function withPinnedFolder(operation,{create=false,missingOk=false}={}){
    if(process.platform!=='linux'){
      assertUnredirectedDirectoryAncestors(folder,'GUI_INCIDENT_STORAGE_UNAVAILABLE');
      if(create)await fs.mkdir(folder,{recursive:true,mode:0o700});
      let st;
      try{st=await fs.lstat(folder);}
      catch(e){if(missingOk&&e.code==='ENOENT')return operation(null);throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');}
      assertPrivateFolder(st);
      return operation({filePath:file,guardPath:guard,folderPath:folder,pinned:false});
    }
    const opened=[];
    try{
      assertUnredirectedDirectoryAncestors(folder,'GUI_INCIDENT_STORAGE_UNAVAILABLE');
      const root=path.parse(folder).root;
      const flags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
      let held=await fs.open(root,flags);
      opened.push(held);
      for(const part of path.relative(root,folder).split(path.sep).filter(Boolean)){
        const child=path.join('/proc/self/fd',String(held.fd),part);
        if(create){
          try{await fs.mkdir(child,{mode:0o700});}
          catch(e){if(e.code!=='EEXIST')throw e;}
        }
        held=await fs.open(child,flags);
        opened.push(held);
      }
      assertPrivateFolder(await held.stat());
      const pinned=path.join('/proc/self/fd',String(held.fd));
      return await operation({filePath:path.join(pinned,path.basename(file)),
        guardPath:path.join(pinned,path.basename(guard)),folderPath:pinned,pinned:true});
    }catch(e){
      if(missingOk&&e?.code==='ENOENT')return operation(null);
      if(e?.guiCode)throw e;
      throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');
    }finally{
      for(const held of opened.reverse()){
        try{await held.close();}catch{throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');}
      }
    }
  }
  async function withGuard(paths,operation){
    let held;
    try{
      assertPrivateFolder(await (paths.pinned?fs.stat(paths.folderPath):fs.lstat(paths.folderPath)));
      held=await fs.open(paths.guardPath,'wx',0o600);
      await held.sync();
    }catch{try{await held?.close();}catch{}throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');}
    let preserveGuard=false;
    try{return await operation(()=>{preserveGuard=true;});}
    finally{
      try{await held.close();}catch{preserveGuard=true;}
      if(!preserveGuard){
        try{await fs.unlink(paths.guardPath);}
        catch{throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');}
      }
    }
  }
  async function pendingInternal(paths,filename=paths.filePath){
    try{assertPrivateFolder(await (paths.pinned?fs.stat(paths.folderPath):fs.lstat(paths.folderPath)));}
    catch(e){if(e.code==='ENOENT')return null;throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');}
    // A symlink to a FIFO could block a read-only open before file identity
    // is checked. Preflight the named entry; re-validate after open as well.
    let before;
    try{before=await fs.lstat(filename);}
    catch(e){if(e.code==='ENOENT')return null;throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');}
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||
       before.size<1||before.size>2048)
      throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');
    // On POSIX, atomically refuse the final symlink and avoid blocking on
    // a swapped FIFO/device. Windows lacks these flags; the verified
    // descriptor plus before/after file identity checks still fail closed
    // for normal file swaps but do not prove a fully race-free open.
    const flags=constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0);
    let handle;
    try{handle=await fs.open(filename,flags);}
    catch{throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');}
    let record;
    try{
      const [st,named]=await Promise.all([handle.stat(),fs.lstat(filename)]);
      if(!st.isFile()||!named.isFile()||named.isSymbolicLink()||
        st.nlink!==1||named.nlink!==1||st.dev!==named.dev||st.ino!==named.ino||
        st.dev!==before.dev||st.ino!==before.ino||st.size!==before.size||
        st.size<1||st.size>2048)
        throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');
      // Read only through the verified descriptor, with a hard 2 KiB cap
      // even if another process grows the file after fstat.
      const buffer=Buffer.alloc(2049);
      let used=0;
      while(used<buffer.length){
        const {bytesRead}=await handle.read(buffer,used,buffer.length-used,used);
        if(bytesRead===0)break;
        used+=bytesRead;
      }
      if(used!==st.size||used<1||used>2048)throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');
      record=JSON.parse(buffer.subarray(0,used).toString('utf8'));
    }catch{throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');}
    finally{
      try{await handle.close();}
      catch{throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');}
    }
    if(record?.schema!==SCHEMA||record.status!=='PENDING_NATIVE_EFFECT'||
      !INPUT_TOOLS.has(record.tool)||typeof record.id!=='string'||
      !/^[a-zA-Z0-9-]{8,128}$/.test(record.id)||
      typeof record.startedUtc!=='string'||record.startedUtc.length>48)
      throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');
    return {id:record.id,tool:record.tool,startedUtc:record.startedUtc};
  }
  async function pending(){
    return withPinnedFolder(async paths=>{
      if(!paths)return null;
      try{await fs.lstat(paths.guardPath);}
      catch(e){if(e?.code==='ENOENT')return pendingInternal(paths);}
      throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');
    },{missingOk:true});
  }
  async function begin(tool){
    if(!INPUT_TOOLS.has(tool))throw fail('GUI_INCIDENT_TOOL_INVALID');
    return withPinnedFolder(paths=>withGuard(paths,async()=>{
      const prior=await pendingInternal(paths);
      if(prior)throw fail('GUI_INCIDENT_UNRESOLVED');
      try{
        const record={schema:SCHEMA,status:'PENDING_NATIVE_EFFECT',tool,id:id(),startedUtc:now()};
        const fd=await fs.open(paths.filePath,'wx',0o600);
        try{await fd.writeFile(JSON.stringify(record)+'\n','utf8');await fd.sync();}
        finally{await fd.close();}
        return {id:record.id,tool:record.tool};
      }catch(e){if(e.guiCode)throw e;throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');}
    }),{create:true});
  }
  async function resolve(handle){
    if(!handle||typeof handle.id!=='string')throw fail('GUI_INCIDENT_HANDLE_INVALID');
    return withPinnedFolder(paths=>withGuard(paths,async preserveGuard=>{
      const prior=await pendingInternal(paths);
      if(!prior||prior.id!==handle.id||prior.tool!==handle.tool)
        throw fail('GUI_INCIDENT_RESOLUTION_MISMATCH');
      const quarantine=path.join(paths.folderPath,'.gui-incident-resolving-'+randomUUID());
      try{await fs.rename(paths.filePath,quarantine);}
      catch{preserveGuard();throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');}
      let moved;
      try{moved=await pendingInternal(paths,quarantine);}
      catch{moved=null;}
      if(!moved||moved.id!==handle.id||moved.tool!==handle.tool){
        try{
          await fs.link(quarantine,paths.filePath);
          await fs.unlink(quarantine);
        }catch{preserveGuard();}
        throw fail('GUI_INCIDENT_RESOLUTION_MISMATCH');
      }
      try{await fs.unlink(quarantine);}
      catch{preserveGuard();throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');}
    }));
  }
  return {pending,begin,resolve};
}
