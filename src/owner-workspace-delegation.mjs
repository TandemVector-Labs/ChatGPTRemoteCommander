import path from 'node:path';
import {readFile} from 'node:fs/promises';

// Optional, read-only CUA inventory from the existing same-owner Windows broker.
// Do not proxy mutation methods, browser state, screenshots, or raw window titles.
const AUTH=/^[a-f0-9]{64}$/;
const handle=/^[1-9][0-9]{0,18}$/;
const firefox=/^firefox(?:\.exe)?$/i;
const error=code=>{throw Error('OWNER_WORKSPACE_'+code);};
// Bound native fetch response bytes before allocating the full reply. The
// text-only injected response fallback preserves existing test doubles.
async function readBoundedOwnerInventoryReply(response){
 const body=response.body;
 if(typeof body?.getReader!=='function'){
  let text;
  try{text=await response.text();}catch{error('TRANSPORT_UNAVAILABLE');}
  if(typeof text!=='string'||text.length>192000)error('RESPONSE_TOO_LARGE');
  return text;
 }
 const reader=body.getReader();
 const decoder=new TextDecoder();
 const parts=[];
 let received=0,finished=false;
 try{
  while(true){
   const {done,value}=await reader.read();
   if(done){finished=true;break;}
   if(!(value instanceof Uint8Array))error('RESPONSE_INVALID');
   received+=value.byteLength;
   if(received>192000)error('RESPONSE_TOO_LARGE');
   parts.push(decoder.decode(value,{stream:true}));
  }
  parts.push(decoder.decode());
  return parts.join('');
 }catch(e){
  if(e?.message==='OWNER_WORKSPACE_RESPONSE_TOO_LARGE'
   ||e?.message==='OWNER_WORKSPACE_RESPONSE_INVALID')throw e;
  error('TRANSPORT_UNAVAILABLE');
 }finally{
  if(!finished){try{void reader.cancel().catch(()=>{});}catch{}}
  reader.releaseLock();
 }
}
export function createOwnerWorkspaceReadOnlyProxy({
 config,primaryStatus,platform=process.platform,fetchImpl=globalThis.fetch,readFileImpl=readFile
}={}){
 const policy=config?.ownerWorkspaceDelegation;
 if(policy?.enabled!==true)return null;
 if(platform!=='win32')error('WINDOWS_ONLY');
 if(config?.powerMode?.guiControl?.enabled!==true)error('CORE_GUI_DISABLED');
 if(policy.port!==48838&&policy.port!==48839)error('PORT_INVALID');
 if(typeof policy.authFile!=='string'||!path.win32.isAbsolute(policy.authFile))error('AUTH_PATH_INVALID');
 if(typeof primaryStatus!=='function'||typeof fetchImpl!=='function')error('DEPENDENCIES_INVALID');
 // Fixed reviewed owner agent endpoint; arbitrary local ports are refused before auth read.
 const endpoint=policy.port===48839
  ?'http://127.0.0.1:48839/mcp':'http://127.0.0.1:48838/mcp';
 return {
  async execute(name,args={}){
   if(name!=='workspace_target_list')return {handled:false};
   if(args?.application!==undefined&&!['all','firefox'].includes(args.application))error('FILTER_INVALID');
   // Do not bridge around a healthy, blocked, or uncertain primary GUI controller.
   let primary;
   try{primary=await primaryStatus();}catch{return {handled:false};}
   if(primary?.enabled!==true||primary.available!==false||
      primary.blocked===true||primary.uncertain===true||
      primary.incidentPending===true||primary.incidentStoreUnavailable===true||
      primary.reason==='NATIVE_OUTCOME_UNCERTAIN_RESTART_REQUIRED')
     return {handled:false};
   const secret=(await readFileImpl(policy.authFile,'utf8')).trim();
   if(!AUTH.test(secret))error('AUTH_INVALID');
   let response;
   try{
    response=await fetchImpl(endpoint,{
     method:'POST',redirect:'error',
     headers:{'content-type':'application/json','x-rc-owner-workspace-auth':secret},
     body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'workspace_list_windows',arguments:{}}}),
     signal:AbortSignal.timeout(4000)
    });
   }catch{error('TRANSPORT_UNAVAILABLE');}
   if(response.status!==200)error('TRANSPORT_REJECTED');
   const text=await readBoundedOwnerInventoryReply(response);
   let data;
   try{data=JSON.parse(text);}catch{error('RESPONSE_INVALID');}
   if(data?.jsonrpc!=='2.0'||data?.id!==1||data.error||data.result?.isError===true)
    error('RPC_REJECTED');
   const result=data?.result?.structuredContent;
   if(result?.ok!==true||result.mode!=='READ_ONLY'||result.focusChanged!==false||
      !Array.isArray(result.value?.windows)||result.value.windows.length>500)
    error('WINDOWS_INVALID');
   const windows=[];
   const seen=new Set();
   for(const w of result.value.windows){
    const pid=w?.pid,win=w?.window_id,app=w?.app_name;
    const raw=typeof win==='string'?win:Number.isSafeInteger(win)?String(win):'';
    if(!Number.isSafeInteger(pid)||pid<=0||pid>2147483647||
       !handle.test(raw)||typeof app!=='string'||app.length>120)error('WINDOW_ID_INVALID');
    const identity=pid+':'+raw;
    if(seen.has(identity))error('WINDOW_DUPLICATED');
    seen.add(identity);
    if(args.application==='firefox'&&!firefox.test(app))continue;
    windows.push({processId:pid,handle:raw,appName:app,focused:false});
   }
   return {handled:true,value:{ok:true,backend:'owner-cua-readonly',application:args.application||'all',
    windows,privateProfileAccess:false,focusChanged:false}};
  }
 };
}
