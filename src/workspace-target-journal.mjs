// Private durable target-scoped journal. Never a global desktop input latch.
// One unresolved effect affects only its exact target key, across process restarts.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
const SCHEMA='rc-workspace-target-effect-v1';
const EFFECTS=new Set(['workspace_window_click','workspace_browser_click','workspace_native_ui_set_value','workspace_native_ui_invoke']);
const safeTarget=(v)=>typeof v==='string'&&/^(?:(?:browser:)?(?:[ab]:)?|native:)[0-9]{1,12}:[0-9]{1,12}$/.test(v);
const err=(name)=>Object.assign(new Error(name),{code:name});
const key=(str)=>createHash('sha256').update(str,'utf8').digest('hex');
const defaultDir=()=>path.join(process.platform==='win32'
 ?(process.env.LOCALAPPDATA??path.join(os.homedir(),'AppData','Local'))
 :(process.env.XDG_STATE_HOME??path.join(os.homedir(),'.local','state')),
 'chatgpt-remote-commander','workspace-pending-v1');
export function createWorkspaceTargetJournal({dir=defaultDir(),id=randomUUID,now=()=>new Date().toISOString()}={}){
 if(!path.isAbsolute(dir))throw err('WORKSPACE_JOURNAL_DIR_INVALID');
 const file=target=>{
  if(!safeTarget(target))throw err('WORKSPACE_JOURNAL_TARGET_INVALID');
  return path.join(dir,key(target)+'.json');
 };
 async function pending(target){
  const f=file(target);
  let info;
  try{info=await fs.lstat(f);}
  catch(e){if(e?.code==='ENOENT')return null;throw err('WORKSPACE_JOURNAL_UNAVAILABLE');}
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size<1||info.size>1600)
    throw err('WORKSPACE_JOURNAL_UNAVAILABLE');
  let value;
  try{value=JSON.parse(await fs.readFile(f,'utf8'));}
  catch{throw err('WORKSPACE_JOURNAL_UNAVAILABLE');}
  if(!value||value.schema!==SCHEMA||value.status!=='PENDING_TARGET_EFFECT'||
      value.targetHash!==key(target)||!EFFECTS.has(value.action)||
      typeof value.id!=='string'||!/^[0-9a-f-]{36}$/.test(value.id)||
      !/^[a-f0-9]{64}$/.test(value.requestHash??'')||
      typeof value.startedUtc!=='string'||value.startedUtc.length>48)
    throw err('WORKSPACE_JOURNAL_UNAVAILABLE');
  return Object.freeze({id:value.id,action:value.action,
    requestHash:value.requestHash,startedUtc:value.startedUtc});
 }
 async function begin(target,action,requestId){
  if(!EFFECTS.has(action)||typeof requestId!=='string'||requestId.length>128)
    throw err('WORKSPACE_JOURNAL_INPUT_INVALID');
  if(await pending(target))throw err('WORKSPACE_TARGET_RECONCILIATION_REQUIRED');
  try{
   await fs.mkdir(dir,{recursive:true,mode:0o700});
   const st=await fs.lstat(dir);
   if(!st.isDirectory()||st.isSymbolicLink()||
     (process.platform!=='win32'&&(st.mode&0o077)!==0))
     throw err('WORKSPACE_JOURNAL_UNAVAILABLE');
   const record={schema:SCHEMA,status:'PENDING_TARGET_EFFECT',
     targetHash:key(target),action,id:id(),requestHash:key(requestId),startedUtc:now()};
   const handle=await fs.open(file(target),'wx',0o600);
   try{await handle.writeFile(JSON.stringify(record)+'\n','utf8');await handle.sync();}
   finally{await handle.close();}
   return {id:record.id,action:record.action,requestHash:record.requestHash};
  }catch(e){
   if(e?.code==='EEXIST')throw err('WORKSPACE_TARGET_RECONCILIATION_REQUIRED');
   if(e?.code?.startsWith('WORKSPACE_'))throw e;
   throw err('WORKSPACE_JOURNAL_UNAVAILABLE');
  }
 }
 async function resolve(target,handle){
  const existing=await pending(target);
  if(!existing||!handle||existing.id!==handle.id||
    existing.action!==handle.action||existing.requestHash!==handle.requestHash)
     throw err('WORKSPACE_JOURNAL_RESOLUTION_MISMATCH');
  try{await fs.unlink(file(target));}
  catch{throw err('WORKSPACE_JOURNAL_UNAVAILABLE');}
 }
 return {pending,begin,resolve};
}
export function createMemoryWorkspaceJournal(){
 const entries=new Map();
 return {
  pending:async target=>entries.get(target)??null,
  begin:async (target,action,requestId)=>{
   if(entries.has(target))throw err('WORKSPACE_TARGET_RECONCILIATION_REQUIRED');
   const item={id:randomUUID(),action,requestHash:key(requestId)};
   entries.set(target,item);return item;
  },
  resolve:async(target,handle)=>{
   if(entries.get(target)?.id!==handle?.id)throw err('WORKSPACE_JOURNAL_RESOLUTION_MISMATCH');
   entries.delete(target);
  }
 };
}
