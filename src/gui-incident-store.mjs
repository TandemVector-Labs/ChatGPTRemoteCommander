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
  async function pending(){
    assertUnredirectedDirectoryAncestors(folder,'GUI_INCIDENT_STORAGE_UNAVAILABLE');
    try{assertPrivateFolder(await fs.lstat(folder));}
    catch(e){if(e.code==='ENOENT')return null;throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');}
    // A symlink to a FIFO could block a read-only open before file identity
    // is checked. Preflight the named entry; re-validate after open as well.
    let before;
    try{before=await fs.lstat(file);}
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
    try{handle=await fs.open(file,flags);}
    catch{throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');}
    let record;
    try{
      const [st,named]=await Promise.all([handle.stat(),fs.lstat(file)]);
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
  async function begin(tool){
    assertUnredirectedDirectoryAncestors(folder,'GUI_INCIDENT_STORAGE_UNAVAILABLE');
    if(!INPUT_TOOLS.has(tool))throw fail('GUI_INCIDENT_TOOL_INVALID');
    const prior=await pending();
    if(prior)throw fail('GUI_INCIDENT_UNRESOLVED');
    try{
      await fs.mkdir(folder,{recursive:true,mode:0o700});
      const dir=await fs.lstat(folder);
      assertPrivateFolder(dir);
      const record={schema:SCHEMA,status:'PENDING_NATIVE_EFFECT',tool,id:id(),startedUtc:now()};
      const fd=await fs.open(file,'wx',0o600); // Exclusive across processes; never truncate an unresolved incident.
      try{
        await fd.writeFile(JSON.stringify(record)+'\n','utf8');
        await fd.sync();
      }finally{await fd.close();}
      return {id:record.id,tool:record.tool};
    }catch(e){
      if(e.guiCode)throw e;
      throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE'); // Fail before native input.
    }
  }
  async function resolve(handle){
    assertUnredirectedDirectoryAncestors(folder,'GUI_INCIDENT_STORAGE_UNAVAILABLE');
    if(!handle||typeof handle.id!=='string')throw fail('GUI_INCIDENT_HANDLE_INVALID');
    const prior=await pending();
    if(!prior||prior.id!==handle.id||prior.tool!==handle.tool)throw fail('GUI_INCIDENT_RESOLUTION_MISMATCH');
    try{await fs.unlink(file);}catch{throw fail('GUI_INCIDENT_STORAGE_UNAVAILABLE');}
  }
  return {pending,begin,resolve};
}
