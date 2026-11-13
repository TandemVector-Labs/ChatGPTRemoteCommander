import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { BROWSER_RULES, browserError, browserToolDefinitions, validateBrowserInput } from './browser-contract.mjs';
import { createBrowserProcessClient } from './browser-process.mjs';
import { writeBrowserLeaseMarker, removeBrowserLeaseMarker, reapOrphanedIsolatedBrowserProfiles } from './browser-lease-store.mjs';
export { browserToolDefinitions };

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const chromiumHelper=path.join(project,'tools','browser-control.mjs');
const firefoxHelper=path.join(project,'tools','browser-control-firefox.mjs');
const chromiumClient=createBrowserProcessClient({file:process.execPath,args:[chromiumHelper,'--server']});
const firefoxClient=createBrowserProcessClient({file:process.execPath,args:[firefoxHelper,'--server']});
let defaultBrowserBackend=null;
const isFirefoxExecutable=value=>typeof value==='string'&&/firefox/i.test(path.basename(value));
const defaultInvoke=async req=>{
 const kind=req.action==='status'
  ? (isFirefoxExecutable(req.executable)?'firefox':'chromium')
  : req.action==='start'
    ? (defaultBrowserBackend=isFirefoxExecutable(req.executable)?'firefox':'chromium')
    : (defaultBrowserBackend??'chromium');
 const client=kind==='firefox'?firefoxClient:chromiumClient;
 try{return await client.invoke(req);}
 finally{if(req.action==='end')defaultBrowserBackend=null;}
};
const defaultClose=()=>{defaultBrowserBackend=null;chromiumClient.close();firefoxClient.close();};
const sameToken=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const safeSegment=value=>typeof value==='string'&&/^[a-z][a-z0-9_-]{0,31}$/.test(value)?value:'default';
const instanceSegment=value=>{const raw=typeof value==='string'&&value?value:'default';return raw==='default'?'default':'instance-'+Buffer.from(raw,'utf8').toString('hex');};
function defaultProfileRoot(){
 if(process.platform==='win32')return path.join(process.env.LOCALAPPDATA||os.homedir(),'ChatGPTRemoteCommander','browser-profiles');
 return path.join(os.homedir(),'.local','state','chatgpt-remote-commander','browser-profiles');
}
function resolveProfileRoot(cfg){
 const raw=typeof cfg.profileRoot==='string'&&cfg.profileRoot.trim()?cfg.profileRoot.trim():defaultProfileRoot();
 return path.resolve(raw.replace(/%([^%]+)%/g,(_,k)=>process.env[k]??process.env[k.toUpperCase()]??''));
}
export function reapBrowserOrphans(ctx){
 const cfg=ctx.config?.powerMode?.browserControl??{};
 const root=resolveProfileRoot(cfg),instance=instanceSegment(ctx.config?.instance?.profile??'default');
 return reapOrphanedIsolatedBrowserProfiles({instanceRoot:path.join(root,instance)});
}
export function createBrowserController({invoke=defaultInvoke,closeInvoke=defaultClose,now=()=>performance.now(),wallNow=()=>Date.now(),token=()=>randomBytes(24).toString('hex'),scheduleTimeout=setTimeout,cancelTimeout=clearTimeout}={}){
 let session=null,uncertain=false,chatMutationUncertain=false,timer=null,busy=false,expiryRequested=false,expiredProfile=null;
 const clearTimer=()=>{if(timer)cancelTimeout(timer);timer=null;};
 const cleanupExpired=async()=>{
  if(!expiryRequested||busy)return;
  expiryRequested=false;
  const profile=expiredProfile;expiredProfile=null;
  try{await invoke({action:'end'});if(profile)removeBrowserLeaseMarker(profile);}
  catch{closeInvoke();}
 };
 const expireSession=()=>{
  if(!session)return;
  expiredProfile=session.profileDir;
  session=null;uncertain=false;chatMutationUncertain=false;timer=null;expiryRequested=true;
  if(!busy)queueMicrotask(()=>cleanupExpired().catch(()=>{}));
 };
 const current=()=>{
  if(session&&session.expires<=now())expireSession();
  return session;
 };
 const arm=ttl=>{
  clearTimer();
  timer=scheduleTimeout(expireSession,ttl*1000);
  timer.unref?.();
 };
 const owns=value=>{
  const active=current();
  if(!active||!sameToken(value,active.id))throw browserError('BROWSER_LEASE_REQUIRED_OR_EXPIRED');
 };
 const execute=async(ctx,name,raw={})=>{
  const input=validateBrowserInput(name,raw);
  const cfg=ctx.config?.powerMode?.browserControl??{};
  const enabled=ctx.config?.powerMode?.enabled===true&&cfg.enabled===true;
  if(name==='browser_status'){
   let native={ok:true,available:false,backend:null,active:false};
   try{native=await invoke({action:'status',executable:cfg.executable});}catch(error){native={ok:false,available:false,backend:null,active:false,reason:error.browserCode??'BROWSER_HELPER_UNAVAILABLE'};}
   current();
   return {...native,enabled,busy,leased:!!session,uncertain,sessionResetRequired:chatMutationUncertain,policy:{
    backgroundFirst:true,headlessOwnedProfileOnly:true,userDesktopTouchedByDefault:false,
    savedPasswordExtraction:false,userBrowserProfileReuse:false,
    foregroundFallback:'explicit-current-request-only',workflowBrowserAllowed:false,
    allowForegroundFallback:cfg.allowForegroundFallback===true,
    allowNavigate:cfg.allowNavigate===true,allowInput:cfg.allowInput===true,allowScreenshot:cfg.allowScreenshot===true
   }};
  }
  if(!enabled)throw browserError('BROWSER_DISABLED');
  if(busy)throw browserError('BROWSER_BUSY');
  busy=true;
  try{
   if(name==='browser_session_begin'){
    if(current())throw browserError('BROWSER_LEASE_BUSY');
    const ttl=input.ttlSeconds??300,mode=input.mode??'persistent',profile=input.profile??'default';
    const root=resolveProfileRoot(cfg),instance=instanceSegment(ctx.config?.instance?.profile??'default');
    const dir=mode==='isolated'
      ? path.join(root,instance,'isolated-'+Date.now().toString(36)+'-'+token().slice(0,12))
      : path.join(root,instance,safeSegment(profile));
    const native=await invoke({action:'start',profileDir:dir,isolated:mode==='isolated',executable:cfg.executable});
    const createdAt=wallNow(),expiresAt=createdAt+ttl*1000;
    try{
      writeBrowserLeaseMarker({profileDir:dir,instance:ctx.config?.instance?.profile??'default',isolated:mode==='isolated',createdAt,expiresAt,ownerPid:process.pid});
    }catch{
      try{await invoke({action:'end'});}catch{closeInvoke();}
      throw browserError('BROWSER_LEASE_STATE_FAILED');
    }
    session={id:token(),expires:now()+ttl*1000,ttl,mode,profile,profileDir:dir,isolated:mode==='isolated',
      executable:cfg.executable,foreground:false,createdAtEpochMs:createdAt,expiresAtEpochMs:expiresAt};
    uncertain=false;chatMutationUncertain=false;expiryRequested=false;arm(ttl);
    return {ok:true,lease:session.id,ttlSeconds:ttl,profile,mode,background:true,headless:true,
      userDesktopTouched:false,savedPasswordStoreAccess:false,browserProduct:native.browserProduct??null,backend:native.backend??'browser-headless'};
   }
   owns(input.lease);
   if(name==='browser_chat_tabs'){
     const native=await invoke({action:'chat_tabs'});
     return {...native,sessionResetRequired:chatMutationUncertain,background:true,userDesktopTouched:false};
   }
   if(name==='browser_session_renew'){
    const ttl=input.ttlSeconds??300,expiresAt=wallNow()+ttl*1000;
    writeBrowserLeaseMarker({profileDir:session.profileDir,instance:ctx.config?.instance?.profile??'default',isolated:session.isolated,createdAt:session.createdAtEpochMs,expiresAt,ownerPid:process.pid});
    session.expires=now()+ttl*1000;session.expiresAtEpochMs=expiresAt;session.ttl=ttl;arm(ttl);return {ok:true,ttlSeconds:ttl};
   }
   if(name==='browser_session_end'){
    const profileDir=session.profileDir;
    clearTimer();session=null;uncertain=false;chatMutationUncertain=false;expiryRequested=false;expiredProfile=null;
    const r=await invoke({action:'end'});removeBrowserLeaseMarker(profileDir);return {ok:true,closed:r.closed===true};
   }
   if(chatMutationUncertain&&name==='browser_foreground_begin')throw browserError('BROWSER_CHAT_OUTCOME_UNCERTAIN_SESSION_RESET_REQUIRED');
   if(name==='browser_foreground_requirement'){
    return {ok:true,approvalRequired:true,reason:input.reason,targetHost:input.targetHost??null,detail:input.detail??null,
      backgroundSessionPreserved:true,desktopTakenOver:false,
      authorizationPolicy:'explicit-current-request-only',
      nextStep:'Ask only if the current user request did not already authorize foreground interaction. After approval call browser_foreground_begin with that current-task authorization, then gui_session_begin(mode="takeover", explicitUserAuthorization=<same approval>) for the minimum interaction. End the GUI lease and call browser_foreground_end to resume the same profile headlessly.'};
   }
   if(name==='browser_foreground_begin'){
    if(cfg.foregroundFallback!=='explicit-current-request-only'||cfg.allowForegroundFallback!==true)throw browserError('BROWSER_FOREGROUND_FALLBACK_DISABLED');
    if(session.foreground)throw browserError('BROWSER_FOREGROUND_ALREADY_ACTIVE');
    const native=await invoke({action:'relaunch',headless:false});
    session.foreground=true;
    return {ok:true,foreground:true,headless:false,userDesktopTouched:true,explicitlyAuthorized:true,
      sameOwnedProfile:true,browserProduct:native.browserProduct??null,
      nextStep:'Use a separately authorized GUI takeover only for the minimum required interaction, then end the GUI lease and call browser_foreground_end.'};
   }
   if(name==='browser_foreground_end'){
    if(!session.foreground)throw browserError('BROWSER_FOREGROUND_NOT_ACTIVE');
    let native;
    try{native=await invoke({action:'relaunch',headless:true});}
    catch(error){session.foreground=false;uncertain=true;throw error;}
    session.foreground=false;
    return {ok:true,foreground:false,headless:true,userDesktopTouched:false,sameOwnedProfile:true,
      browserProduct:native.browserProduct??null,backgroundResumed:true,resumeNavigationFailed:native.resumeNavigationFailed===true};
   }
   if(uncertain&&['browser_navigate','browser_fill','browser_click','browser_chat_tab_open','browser_chat_tab_close'].includes(name))throw browserError(chatMutationUncertain?'BROWSER_CHAT_OUTCOME_UNCERTAIN_SESSION_RESET_REQUIRED':'BROWSER_OUTCOME_UNCERTAIN_SNAPSHOT_REQUIRED');
   const rule=BROWSER_RULES.get(name);
   if(['browser_navigate','browser_chat_tab_open','browser_chat_tab_close'].includes(name)&&cfg.allowNavigate!==true)throw browserError('BROWSER_NAVIGATION_DISABLED');
   if(['browser_fill','browser_click'].includes(name)&&cfg.allowInput!==true)throw browserError('BROWSER_INPUT_DISABLED');
   if(name==='browser_screenshot'&&cfg.allowScreenshot!==true)throw browserError('BROWSER_SCREENSHOT_DISABLED');
   const mutation=['browser_navigate','browser_fill','browser_click','browser_chat_tab_open','browser_chat_tab_close'].includes(name);
   const foregroundAtDispatch=session.foreground===true;
   const activity={background:!foregroundAtDispatch,userDesktopTouched:foregroundAtDispatch};
   try{
    let result;
    if(name==='browser_chat_tab_open')result=await invoke({action:'chat_tab_open',url:input.url});
    else if(name==='browser_chat_tab_close')result=await invoke({action:'chat_tab_close',tabRef:input.tabRef});
    else if(name==='browser_navigate')result=await invoke({action:'navigate',url:input.url,timeoutMs:input.timeoutMs??30000});
    else if(name==='browser_snapshot')result=await invoke({action:'snapshot',maxTextChars:input.maxTextChars??20000,maxElements:input.maxElements??120});
    else if(name==='browser_screenshot')result=await invoke({action:'screenshot',format:input.format??'jpeg',quality:input.quality??70,maxBytes:input.maxBytes??2097152});
    else if(name==='browser_fill')result=await invoke({action:'fill',selector:input.selector,text:input.text});
    else if(name==='browser_click')result=await invoke({action:'click',selector:input.selector});
    else if(name==='browser_wait')result=await invoke({action:'wait',selector:input.selector,textIncludes:input.textIncludes,urlIncludes:input.urlIncludes,timeoutMs:input.timeoutMs??5000});
    else throw browserError('BROWSER_UNKNOWN_TOOL');
    if(name==='browser_snapshot'){
      if(!chatMutationUncertain)uncertain=false;
      result={...result,sessionResetRequired:chatMutationUncertain,passwordValuesReturned:false,cookiesReturned:false,savedPasswordStoreAccess:false};
    }
    if(name==='browser_screenshot'){
      const {data,mimeType,...meta}=result;
      if(!['image/jpeg','image/png'].includes(mimeType)||typeof data!=='string'||!data.length)throw browserError('BROWSER_INVALID_IMAGE');
      const bytes=Buffer.from(data,'base64');
      const sig=mimeType==='image/png'?bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff;
      if(!sig||bytes.length>(input.maxBytes??2097152))throw browserError('BROWSER_INVALID_IMAGE');
      const structured={...meta,bytes:bytes.length,mimeType,...activity};
      return {__mcpContent:[{type:'image',mimeType,data},{type:'text',text:JSON.stringify(structured)}],__structuredContent:structured};
    }
    return {...result,...activity,...(['browser_fill','browser_click'].includes(name)?{verificationRecommended:true}:{})};
   }catch(error){
    if(mutation){uncertain=true;if(name==='browser_chat_tab_open'||name==='browser_chat_tab_close')chatMutationUncertain=true;}
    throw error;
   }
  }finally{
   busy=false;
   if(expiryRequested)await cleanupExpired();
  }
 };
 const close=()=>{clearTimer();session=null;uncertain=false;chatMutationUncertain=false;expiryRequested=false;closeInvoke();};
 return {execute,close};
}
const controller=createBrowserController();
export async function executeBrowserTool(ctx,name,input){return controller.execute(ctx,name,input);}
export function closeBrowserController(){controller.close();}
