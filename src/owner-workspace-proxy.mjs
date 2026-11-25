// Owner-bound workspace broker: never crosses the Windows interactive SID boundary.
// The existing authenticated owner agent must expose the same workspace tool and
// authorize it under its own effective policy. Legacy GUI global locks are not
// consulted for per-window/background tools.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const ALLOWED=new Set([
 'workspace_plan','workspace_list_windows','workspace_window_observe','workspace_window_preview',
 'workspace_window_click','workspace_browser_inspect','workspace_browser_attach',
 'workspace_browser_click','workspace_target_reconcile',
 'workspace_agentos_plan','workspace_native_ui_observe','workspace_native_ui_set_value','workspace_native_ui_invoke'
]);
const MUTATIONS=new Set(['workspace_window_click','workspace_browser_attach',
 'workspace_browser_click','workspace_target_reconcile','workspace_native_ui_set_value','workspace_native_ui_invoke']);
const AUTH=/^[a-f0-9]{64}$/;
const REQ=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const fail=(c)=>Object.assign(new Error(c),{code:c});
// Enforce the reply cap while bytes arrive. A post-response.text() check
// protects the JSON parser but still allows an oversized local reply to be
// fully allocated in memory before rejection.
async function readBoundedOwnerReply(response) {
 const body=response.body;
 if(typeof body?.getReader!=='function'){
  // Preserve support for injected text-only response mocks. Node fetch uses
  // streaming Response.body for nonempty network replies.
  const text=await response.text();
  if(text.length>8_000_000)throw fail('WORKSPACE_OWNER_REPLY_LIMIT');
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
   if(!(value instanceof Uint8Array))throw fail('WORKSPACE_OWNER_INVALID_RESPONSE');
   received+=value.byteLength;
   if(received>8_000_000)throw fail('WORKSPACE_OWNER_REPLY_LIMIT');
   parts.push(decoder.decode(value,{stream:true}));
  }
  parts.push(decoder.decode());
  return parts.join('');
 }finally{
  if(!finished){
   try{void reader.cancel().catch(()=>{});}catch{}
  }
  reader.releaseLock();
 }
}
export function createOwnerWorkspaceProxy({config,fetchImpl=globalThis.fetch,readFileImpl=readFile,timeoutSignal=AbortSignal.timeout}={}){
 const policy=config?.ownerWorkspaceDelegation;
 if(policy?.enabled!==true)return null;
 if((policy.port!==48838&&policy.port!==48839)||
    typeof policy.authFile!=='string'||!path.isAbsolute(policy.authFile))
    throw fail('WORKSPACE_OWNER_PROXY_CONFIG_INVALID');
 // The owner credential must never reach an arbitrary other loopback listener.
 const endpoint=policy.port===48839
  ?'http://127.0.0.1:48839/mcp':'http://127.0.0.1:48838/mcp';
 return {async execute(name,args={},context={}){
  if(!ALLOWED.has(name))return {handled:false};
  if(MUTATIONS.has(name)){
   if(!REQ.test(context.requestId??''))throw fail('WORKSPACE_OWNER_REQUEST_ID_REQUIRED');
   if(name!=='workspace_target_reconcile'&&
      (typeof args.explicitUserAuthorization!=='string'||
      args.explicitUserAuthorization.trim().length<12))
     throw fail('WORKSPACE_EXPLICIT_AUTHORIZATION_REQUIRED');
  }
  const raw=(await readFileImpl(policy.authFile,'utf8')).trim();
  if(!AUTH.test(raw))throw fail('WORKSPACE_OWNER_CREDENTIAL_INVALID');
  const hash=MUTATIONS.has(name)?
   createHash('sha256').update('workspace-v1:'+name+':'+context.requestId).digest('hex'):null;
  const rekey=(name==='workspace_window_click'||name==='workspace_browser_click'||name==='workspace_native_ui_set_value'||name==='workspace_native_ui_invoke');
  const payload={...args,...(hash&&rekey?{requestId:'owrk-'+hash.slice(0,48)}:{})};
  // No fallback from owner-agent rejection to SYSTEM/Session 0 injection.
  let response;
  try{response=await fetchImpl(endpoint,{method:'POST',redirect:'error',headers:{
   'content-type':'application/json','x-rc-owner-workspace-auth':raw
  },body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',
     params:{name,arguments:payload}}),signal:timeoutSignal(
      name==='workspace_browser_attach'?31000:
      name==='workspace_browser_inspect'?21000:
      name==='workspace_browser_click'?15000:
      name==='workspace_native_ui_observe'?14000:
      (name==='workspace_native_ui_set_value'||name==='workspace_native_ui_invoke')?22000:6500)});}
  catch{throw fail('WORKSPACE_OWNER_AGENT_UNAVAILABLE');}
  if(response.status!==200)throw fail('WORKSPACE_OWNER_AGENT_DENIED');
  const txt=await readBoundedOwnerReply(response);
  let body;
  try{body=JSON.parse(txt);}catch{throw fail('WORKSPACE_OWNER_INVALID_RESPONSE');}
  if(body.jsonrpc!=='2.0'||body.id!==1||!body.result||body.error||
     body.result.isError===true)throw fail('WORKSPACE_OWNER_REJECTED');
  const result=body.result;
  if(!result.structuredContent||typeof result.structuredContent!=='object')
    throw fail('WORKSPACE_OWNER_STRUCTURED_RESULT_REQUIRED');
  if(Array.isArray(result.content)&&result.content.some(c=>c?.type==='image'))
    return {handled:true,value:{__mcpContent:result.content,__structuredContent:result.structuredContent}};
  return {handled:true,value:result.structuredContent};
 }};
}
