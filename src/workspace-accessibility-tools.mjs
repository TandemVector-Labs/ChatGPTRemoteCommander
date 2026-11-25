import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// A separate semantic route. Never feeds AT-SPI element paths to generic pointer,
// keyboard, focus, browser-profile or window-coordinate tools.
const obj=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const id={type:'integer',minimum:1,maximum:2147483647};
const handle={type:'string',pattern:'^[1-9][0-9]{0,18}$'};
const token={type:'string',minLength:1,maxLength:128};
const target={processId:id,handle};
const bounded={...target,lease:token};
const read={readOnlyHint:true,destructiveHint:false,openWorldHint:false};
const change={readOnlyHint:false,destructiveHint:true,openWorldHint:true};
const def=(name,description,inputSchema,annotations)=>({name,description,inputSchema,annotations});
export const workspaceAccessibilityDefinitions=[
 def('workspace_accessibility_open','Open a bounded Accessibility-only lease for an existing exact same-owner browser window. No monitor coordinates or login/profile access.',obj({...target,mode:{type:'string',enum:['observe','takeover']},explicitUserAuthorization:token},['processId','handle','mode']),change),
 def('workspace_accessibility_snapshot','List labeled, non-password accessible controls for the exact same-owner browser window. No values, DOM, cookies or credentials.',obj(bounded,['processId','handle','lease']),read),
 def('workspace_accessibility_type','Set literal text of a single fresh, labeled accessible field in the exact focused owner Firefox window.',obj({...bounded,elementId:token,text:{type:'string',minLength:1,maxLength:1024}},['processId','handle','lease','elementId','text']),change),
 def('workspace_accessibility_invoke','Invoke the single click/press action on a fresh labeled accessible button in the focused owner browser window.',obj({...bounded,elementId:token},['processId','handle','lease','elementId']),change),
 def('workspace_accessibility_end','Release the owner Accessibility lease without altering the browser.',obj({lease:token},['lease']),read)
];
function error(code){throw Object.assign(new Error('WORKSPACE_ACCESSIBILITY_'+code),{workspaceCode:code,rpcCode:-32602});}
const pidValid=p=>Number.isSafeInteger(p)&&p>0&&p<=2147483647;
const handleValid=h=>typeof h==='string'&&/^[1-9][0-9]{0,18}$/.test(h);
const identity=a=>{if(!pidValid(a.processId)||!handleValid(a.handle))error('IDENTITY_INVALID');};
const ownerBrowser=w=>/(?:firefox|brave|chrome|chromium|msedge|microsoft[ ._-]?edge|vivaldi|opera)/i
 .test(String(w.wmClass??'')+' '+String(w.appName??''));
const titleMatch=(a,b)=>a===b&&typeof a==='string'&&a.length>=4&&a.length<=300;

export async function nativeAtspi(request,{timeoutMs=7000}={}){
 if(process.platform!=='linux')error('LINUX_ONLY');
 const file=fileURLToPath(new URL('../tools/owner-atspi-semantic.py',import.meta.url));
 return new Promise((resolve,reject)=>{
  const child=spawn('/usr/bin/python3',[file],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{
   PATH:'/usr/bin:/bin',HOME:process.env.HOME??'',USER:process.env.USER??'',
   DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS??'',
   XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR??''
  }});
  let out='',err='',finished=false,expired=false;
  const timer=setTimeout(()=>{expired=true;child.kill('SIGKILL')},timeoutMs);
  child.stdout.on('data',x=>{out+=x.toString('utf8');if(out.length>45000)child.kill('SIGKILL')});
  child.stderr.on('data',x=>{err=(err+x.toString('utf8')).slice(-500)});
  child.on('error',e=>{if(!finished){finished=true;clearTimeout(timer);reject(e)}});
  child.on('close',code=>{
   clearTimeout(timer);if(finished)return;finished=true;
   if(expired)return reject(new Error('ATSPI_OPERATION_TIMEOUT_EFFECT_UNKNOWN'));
   let parsed;try{parsed=JSON.parse(out.trim())}catch{return reject(new Error('ATSPI_NATIVE_RESPONSE_UNVERIFIED'))}
   if(code!==0||parsed?.ok!==true)return reject(new Error(String(parsed?.error||'ATSPI_OPERATION_FAILED')));
   resolve(parsed);
  });
  child.stdin.on('error',()=>{});
  child.stdin.end(JSON.stringify(request));
 });
}

export function createWorkspaceAccessibilityTools({gui,transport=nativeAtspi,sessions=new Map(),now=()=>Date.now()}){
 if(typeof gui!=='function'||typeof transport!=='function'||!(sessions instanceof Map))error('BACKEND_INVALID');
 const clock=()=>now();
 const prune=()=>{for(const [lease,s] of sessions)if(clock()>s.expiresAt)sessions.delete(lease)};
 const session=(a,takeover=false)=>{
  identity(a);prune();
  const s=sessions.get(a.lease);
  if(!s||s.pid!==a.processId||s.handle!==a.handle)error('LEASE_UNBOUND');
  if(takeover&&s.mode!=='takeover')error('TAKEOVER_REQUIRED');
  return s;
 };
 const guiReady=async()=>{
  const s=await gui('gui_status',{});
  if(s?.ok!==true||s.available!==true)error('GUI_UNAVAILABLE');
 };
 const exact=async(s,lease,focused=false)=>{
  await guiReady();
  const rows=await gui('gui_list_windows',{lease});
  const windows=rows?.windows||[];
  const found=windows.filter(w=>(w.processId??w.ProcessId)===s.pid&&String(w.handle??w.Handle)===s.handle);
  if(found.length!==1||!ownerBrowser(found[0])||!titleMatch(s.title,found[0].title??found[0].Title))error('OWNER_BROWSER_CHANGED');
  if(focused&&found[0].focused!==true&&found[0].Focused!==true)error('FOCUS_NOT_CONFIRMED');
  return found[0];
 };
 const through=async(s,args,command,extra={})=>transport({command,pid:s.pid,windowTitle:s.title,...extra});
 return {definitions:workspaceAccessibilityDefinitions,execute:async(name,args={})=>{
  if(name==='workspace_accessibility_open'){
   identity(args);prune();if(sessions.size>=12)error('LEASE_CAPACITY');
   if(args.mode==='takeover'&&(!args.explicitUserAuthorization||args.explicitUserAuthorization.length<8))error('AUTHORIZATION_REQUIRED');
   await guiReady();
   const begin=await gui('gui_session_begin',{mode:args.mode,ttlSeconds:50,...(args.mode==='takeover'?{explicitUserAuthorization:args.explicitUserAuthorization}:{})});
   if(!begin?.lease||begin.mode!==args.mode)error('LEASE_NOT_GRANTED');
   try{
    const w={pid:args.processId,handle:args.handle,title:''};
    const rows=await gui('gui_list_windows',{lease:begin.lease});
    const matches=(rows?.windows||[]).filter(x=>(x.processId??x.ProcessId)===w.pid&&String(x.handle??x.Handle)===w.handle);
    if(matches.length!==1||!ownerBrowser(matches[0]))error('OWNER_BROWSER_UNVERIFIED');
    w.title=matches[0].title??matches[0].Title;
    if(!titleMatch(w.title,w.title))error('WINDOW_TITLE_UNVERIFIED');
    if(args.mode==='takeover'&&matches[0].focused!==true&&matches[0].Focused!==true)error('FOCUS_NOT_CONFIRMED');
    sessions.set(begin.lease,{...w,mode:args.mode,expiresAt:clock()+45000,elements:new Map()});
    return {ok:true,lease:begin.lease,mode:args.mode,processId:w.pid,handle:w.handle,semanticOnly:true,monitorCoordinatesUsed:false};
   }catch(e){await gui('gui_session_end',{lease:begin.lease});throw e}
  }
  if(name==='workspace_accessibility_end'){
   prune();const s=sessions.get(args.lease);if(!s)error('LEASE_UNBOUND');
   sessions.delete(args.lease);return gui('gui_session_end',{lease:args.lease});
  }
  const s=session(args,name==='workspace_accessibility_type'||name==='workspace_accessibility_invoke');
  await exact(s,args.lease,name==='workspace_accessibility_type'||name==='workspace_accessibility_invoke');
  if(name==='workspace_accessibility_snapshot'){
   const result=await through(s,args,'snapshot');
   if(!Array.isArray(result.controls)||result.controls.length>80)error('SNAPSHOT_INVALID');
   s.elements.clear();
   const controls=result.controls.map(c=>{
    if(!Array.isArray(c.path)||c.path.length>18||typeof c.name!=='string'||typeof c.role!=='string'||c.name.length<2)return null;
    const elementId=randomUUID();
    s.elements.set(elementId,{...c,issuedAt:clock()});
    return {elementId,name:c.name,role:c.role,editable:c.editable===true,clickable:c.action==='click'||c.action==='press'};
   }).filter(Boolean);
   return {ok:true,controls,truncated:result.truncated,nodesVisited:result.nodesVisited,valuesRead:false,semanticOnly:true};
  }
  if(name!=='workspace_accessibility_type'&&name!=='workspace_accessibility_invoke')error('UNKNOWN_TOOL');
  const element=s.elements.get(args.elementId);
  if(!element||clock()-element.issuedAt>20000)error('ELEMENT_STALE_OR_UNBOUND');
  if(name==='workspace_accessibility_type'&&element.editable!==true)error('ELEMENT_NOT_EDITABLE');
  if(name==='workspace_accessibility_invoke'&&!['click','press'].includes(element.action))error('ELEMENT_NOT_INVOKABLE');
  // Single-use element: no duplicate delivery after an ambiguous/timeout result.
  s.elements.delete(args.elementId);
  const result=await through(s,args,name==='workspace_accessibility_type'?'type':'invoke',
   {path:element.path,expectedRole:element.role,expectedName:element.name,
    ...(name==='workspace_accessibility_type'?{text:args.text}:{})});
  if(result.ok!==true)error('NATIVE_NOT_CONFIRMED');
  return {ok:true,effect:result.effect,semanticOnly:true,ownerPid:s.pid,monitorCoordinatesUsed:false};
 }};
}
