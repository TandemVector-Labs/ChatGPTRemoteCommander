// Target-scoped background workspace bridge. Never sends physical desktop input.
// CUA runs in the owning interactive account; an inaccessible owner daemon is a
// capability result, not a reason to bypass named-pipe ACL or alter GUI policy.
import os from 'node:os';
import fs from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chooseWorkspaceRoute,classifyWorkspaceOutcome} from './workspace-routing.mjs';
const defaultNativeUIACall=async (...args)=>{
 const {nativeWindowsUIACall}=await import('./agentos-native-win.mjs');
 return nativeWindowsUIACall(...args);
};
import {createWorkspaceTargetJournal} from './workspace-target-journal.mjs';
const execFileAsync=promisify(execFile);
const targetId=(pid,windowId)=>pid+':'+windowId;
const integer=(n)=>Number.isSafeInteger(n)&&n>0;
const TOKEN=/^s[0-9a-f]{8}:[0-9]+$/;
const REQUEST=/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const fail=(x)=>Object.assign(new Error(x),{code:x});
function desktopType(platform=process.platform,env=process.env){
 if(platform==='win32')return 'windows';
 if(platform==='linux')return env.XDG_SESSION_TYPE==='wayland'||!!env.WAYLAND_DISPLAY?'wayland':env.DISPLAY?'x11':'headless';
 return 'headless';
}
export function resolvePinnedWorkspaceDriverExecutable(platform=process.platform){
 // The owner profile is an OS identity; do not trust caller-supplied LOCALAPPDATA
 // to choose which executable Commander launches. Nonstandard layouts fail closed.
 if(platform==='win32')return path.win32.join(os.homedir(),'AppData','Local',
   'ChatGPTRemoteCommander','adapters','cua-driver','v0.38.0','cua-driver.exe');
 return path.join(os.homedir(),'.local','share',
   'chatgpt-remote-commander','adapters','cua-driver','v0.38.0','cua-driver');
}
export async function defaultOwnerSession({platform=process.platform,env=process.env}={}){
 if(platform==='win32'){
  let user;
  try{({stdout:user}=await execFileAsync('whoami.exe',[],{timeout:3000,windowsHide:true}));}
  catch{return false;}
  return !/\\system\s*$/i.test(user.trim())&&user.trim().includes('\\')&&
    env.SESSIONNAME!=='Services';
 }
 if(platform==='linux')return typeof process.getuid==='function'&&process.getuid()!==0&&
   typeof env.XDG_RUNTIME_DIR==='string'&&env.XDG_RUNTIME_DIR.startsWith('/run/user/');
 return false;
}
export function resolveOwnerCuaPipe(env=process.env){
 const prefix='\\\\.\\pipe\\rc-workspace-cua-v038-';
 const socket=env.RC_WORKSPACE_CUA_PIPE??(prefix+'active');
 if(typeof socket!=='string'||!socket.startsWith(prefix)||
   !['active','candidate'].includes(socket.slice(prefix.length)))throw fail('WORKSPACE_CUA_OWNER_PIPE_INVALID');
 return socket;
}
export async function defaultCuaCall(tool,args,{platform=process.platform,env=process.env,workspaceSeat=null,screenshotFile=null}={}){
 const executable=resolvePinnedWorkspaceDriverExecutable(platform);
 // Reject a symlink or non-file before executing the owner-local adapter.
 try{
  const st=await fs.lstat(executable);
  if(!st.isFile()||st.isSymbolicLink())throw fail('WORKSPACE_DRIVER_NOT_INSTALLED');
 }catch{throw fail('WORKSPACE_DRIVER_NOT_INSTALLED');}
 // This exact pinned adapter is provided by the verified local Commander install.
 // Never accept a caller-supplied executable, socket or CDP endpoint.
 let output;
 try{
  const argv=['call'];
  if(platform==='win32'&&env.RC_WORKSPACE_CUA_OWNER_PIPE==='1')
   argv.push('--socket',resolveOwnerCuaPipe(env));
  if(workspaceSeat){
   if(platform!=='linux'||!['a','b'].includes(workspaceSeat))throw fail('WORKSPACE_SEAT_INVALID');
   argv.push('--socket',path.join(env.XDG_RUNTIME_DIR,'rc-cua-workspace-'+workspaceSeat+'.sock'));
  }
  argv.push(tool,JSON.stringify(args));
  if(screenshotFile)argv.push('--screenshot-out-file',screenshotFile);
  ({stdout:output}=await execFileAsync(executable,argv,{
    encoding:'utf8',timeout:tool==='browser_prepare'?28000:tool==='get_browser_state'?18000:12000,maxBuffer:384*1024,windowsHide:true,env
  }));
 }catch(e){
  // Driver refusals are structured non-effects, not lost native acknowledgments.
  if(typeof e?.stdout==='string'&&e.stdout.length<32768){
   try{const refusal=JSON.parse(e.stdout);
    if(refusal?.status==='refused'&&typeof refusal?.refusal?.code==='string')return refusal;
   }catch{}
  }
  if(e?.code==='ENOENT')throw fail('WORKSPACE_DRIVER_NOT_INSTALLED');
  if(/Access is denied|Permission denied|os error 5/.test(e?.stderr??''))
    throw fail('WORKSPACE_OWNER_SESSION_REQUIRED');
  if(/not running|not reachable|Connection refused/.test(e?.stderr??''))
    throw fail('WORKSPACE_DRIVER_NOT_RUNNING');
  throw fail('WORKSPACE_DRIVER_UNAVAILABLE');
 }
 try{const body=JSON.parse(output);return body?.structuredContent??body;}
 catch{throw fail('WORKSPACE_DRIVER_INVALID_RESPONSE');}
}
export async function defaultCuaPreview(args,scope={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rc-workspace-view-'));
 const file=path.join(dir,'frame.png');
 try{
  const meta=await defaultCuaCall('get_window_state',{
   ...args,display_only:true,include_accessibility_tree:false,
   max_image_dimension:1200
  },{...scope,screenshotFile:file});
  const st=await fs.lstat(file);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size<24||st.size>2*1024*1024)
   throw fail('WORKSPACE_PREVIEW_INVALID_FRAME');
  const png=await fs.readFile(file);
  if(!png.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))
   throw fail('WORKSPACE_PREVIEW_INVALID_PNG');
  return {meta,imageBytes:png};
 }finally{await fs.rm(dir,{recursive:true,force:true});}
}
const exactWindow=(a)=>integer(a?.pid)&&integer(a?.windowId);
const readOnly={readOnlyHint:true,openWorldHint:false};
const mutating={readOnlyHint:false,destructiveHint:true,openWorldHint:false,idempotentHint:false};
export const workspaceToolDefinitions=[
 {name:'workspace_plan',description:'Select independent background/isolated control for an existing logged-in application or browser. This read-only plan never steals focus or copies credentials.',inputSchema:{
   type:'object',properties:{target:{type:'string',enum:['existing-browser','new-browser','existing-app','new-app']},
     existingProfileGrant:{type:'boolean'},backgroundCapability:{type:'boolean'}},
   required:['target'],additionalProperties:false},annotations:readOnly},
 {name:'workspace_agentos_plan',description:'Select the strongest locally available authorized AgentOS provider. Native API/semantic UI/DOM first; CUA only when no stronger route is available. Planning does not grant privileges.',inputSchema:{
   type:'object',properties:{target:{type:'string',enum:['existing-browser','new-browser','existing-app','new-app','project']},
     existingProfileGrant:{type:'boolean'},visualFallbackAuthorized:{type:'boolean'},
     nativeBrowserUIAuthorized:{type:'boolean'},browserExtensionAuthorized:{type:'boolean'},
     browserFamily:{type:'string',enum:['firefox','brave','chrome','edge','chromium','vivaldi','opera','safari','other']},
     purpose:{type:'string',enum:['chatgpt-connection','general-browser','project']},
     profileKind:{type:'string',enum:['default','custom','temporary','unknown']},
     pid:{type:'integer',minimum:1},windowId:{type:'integer',minimum:1},
     tabRef:{type:'string',pattern:'^[-_a-zA-Z0-9]{8,128}$'}},
   required:['target'],additionalProperties:false},annotations:readOnly},
 {name:'workspace_native_ui_observe',description:'Observe actionable native UIAutomation controls in one exact same-owner Brave/Chromium window. Reports only accessible labels, capabilities and fingerprints; never field values, messages, cookies or credentials.',inputSchema:{
   type:'object',properties:{pid:{type:'integer',minimum:1},windowId:{type:'integer',minimum:1},
     application:{type:'string',enum:['brave','chrome','msedge','firefox']},maxElements:{type:'integer',minimum:1,maximum:100}},
   required:['pid','windowId','application'],additionalProperties:false},annotations:readOnly},
 {name:'workspace_native_ui_set_value',description:'Set literal text in one freshly observed enabled Edit/Document control using UIA ValuePattern or LegacyIAccessiblePattern. Exact PID/HWND/application, owner session, fresh fingerprint, requestId and explicit authorization required. Text is sent over stdin, never argv/files/keyboard injection/output; returns only length/hash and native readback.',inputSchema:{
   type:'object',properties:{pid:{type:'integer',minimum:1},windowId:{type:'integer',minimum:1},
     application:{type:'string',enum:['brave','chrome','msedge','firefox']},
     fingerprint:{type:'string',pattern:'^[a-f0-9]{24}$'},controlName:{type:'string',minLength:1,maxLength:150},
     value:{type:'string',minLength:1,maxLength:1024},requestId:{type:'string',minLength:8,maxLength:128},
     foregroundChangeAuthorized:{type:'boolean'},explicitUserAuthorization:{type:'string',minLength:12,maxLength:512}},
   required:['pid','windowId','application','fingerprint','controlName','value','requestId','foregroundChangeAuthorized','explicitUserAuthorization'],additionalProperties:false},annotations:mutating},
 {name:'workspace_native_ui_invoke',description:'Invoke one freshly observed exact UIAutomation control using native InvokePattern. Exact PID/HWND/application, owner session, fingerprint, requestId and explicit authorization required. Any foreground change is measured and accepted only if the same authorized exact window becomes foreground. No CUA, SendInput, SendKeys or retry.',inputSchema:{
   type:'object',properties:{pid:{type:'integer',minimum:1},windowId:{type:'integer',minimum:1},
     application:{type:'string',enum:['brave','chrome','msedge','firefox']},
     fingerprint:{type:'string',pattern:'^[a-f0-9]{24}$'},controlName:{type:'string',minLength:1,maxLength:150},
     requestId:{type:'string',minLength:8,maxLength:128},foregroundChangeAuthorized:{type:'boolean'},
     explicitUserAuthorization:{type:'string',minLength:12,maxLength:512}},
   required:['pid','windowId','application','fingerprint','controlName','requestId','foregroundChangeAuthorized','explicitUserAuthorization'],additionalProperties:false},annotations:mutating},
 {name:'workspace_list_windows',description:'List existing same-user application windows through Cua Driver v0.38; no desktop takeover or global input.',inputSchema:{
   type:'object',properties:{pid:{type:'integer',minimum:1},workspaceSeat:{type:'string',enum:['a','b']}},additionalProperties:false},annotations:readOnly},
 {name:'workspace_window_observe',description:'Read accessibility snapshot of one exact existing window in the owning desktop; no click, focus or mouse movement.',inputSchema:{
   type:'object',properties:{pid:{type:'integer',minimum:1},windowId:{type:'integer',minimum:1},workspaceSeat:{type:'string',enum:['a','b']},maxElements:{type:'integer',minimum:1,maximum:150}},
   required:['pid','windowId'],additionalProperties:false},annotations:readOnly},
 {name:'workspace_window_preview',description:'Return one read-only captured frame of exactly one window for a spectator. The image is noninteractive and cannot steer mouse/keyboard or replace action snapshot.',inputSchema:{
   type:'object',properties:{pid:{type:'integer',minimum:1},windowId:{type:'integer',minimum:1},
     workspaceSeat:{type:'string',enum:['a','b']}},
   required:['pid','windowId'],additionalProperties:false},annotations:readOnly},
 {name:'workspace_window_click',description:'One element-bound background click on exact window via same-user Cua Driver. Never uses SendInput or foreground fallback. Unknown effect reconciles only that target; no blind retry.',inputSchema:{
   type:'object',properties:{pid:{type:'integer',minimum:1},windowId:{type:'integer',minimum:1},
     workspaceSeat:{type:'string',enum:['a','b']},elementToken:{type:'string',pattern:'^s[0-9a-f]{8}:[0-9]+$'},
     requestId:{type:'string',minLength:8,maxLength:128},explicitUserAuthorization:{type:'string',minLength:12,maxLength:512}},
   required:['pid','windowId','elementToken','requestId','explicitUserAuthorization'],additionalProperties:false},annotations:mutating},
{name:'workspace_window_type',description:'Type a bounded nonsecret literal into one freshly observed, named, enabled same-owner editable using CUA background input. Requires exact window, user authorization and requestId; unknown outcomes journaled, never replayed automatically.',inputSchema:{
   type:'object',properties:{pid:{type:'integer',minimum:1},windowId:{type:'integer',minimum:1},
     workspaceSeat:{type:'string',enum:['a','b']},elementToken:{type:'string',pattern:'^s[0-9a-f]{8}:[0-9]+$'},
     controlName:{type:'string',minLength:1,maxLength:150},text:{type:'string',minLength:1,maxLength:1024},
     requestId:{type:'string',minLength:8,maxLength:128},explicitUserAuthorization:{type:'string',minLength:12,maxLength:512}},
   required:['pid','windowId','elementToken','controlName','text','requestId','explicitUserAuthorization'],
   additionalProperties:false},annotations:mutating},
  {name:'workspace_browser_inspect',description:'Inspect one exactly-identified, already logged-in Chromium browser window using the owning user Cua Driver. Does not export cookies or passwords.',inputSchema:{
   type:'object',properties:{pid:{type:'integer',minimum:1},windowId:{type:'integer',minimum:1}},
   required:['pid','windowId'],additionalProperties:false},annotations:readOnly},
 {name:'workspace_browser_attach',description:'Request browser-native consent to attach the exact existing same-user browser window, in background only. Existing-profile Cua Driver launch authorization is still enforced; no profile copies.',inputSchema:{
   type:'object',properties:{pid:{type:'integer',minimum:1},windowId:{type:'integer',minimum:1},
    explicitUserAuthorization:{type:'string',minLength:12,maxLength:512}},
   required:['pid','windowId','explicitUserAuthorization'],additionalProperties:false},annotations:mutating},
 {name:'workspace_browser_click',description:'Background-only CDP click in one exact existing browser tab bound to a prior browser inspection. No focus change, user profile copy or forced foreground fallback.',inputSchema:{
   type:'object',properties:{pid:{type:'integer',minimum:1},windowId:{type:'integer',minimum:1},
    targetId:{type:'string',minLength:1,maxLength:128},tabId:{type:'string',minLength:1,maxLength:128},
    ref:{type:'string',minLength:2,maxLength:128},requestId:{type:'string',minLength:8,maxLength:128},
    explicitUserAuthorization:{type:'string',minLength:12,maxLength:512}},
   required:['pid','windowId','targetId','tabId','ref','requestId','explicitUserAuthorization'],
   additionalProperties:false},annotations:mutating},
 {name:'workspace_target_reconcile',description:'Acknowledge only one uncertain target after a fresh observation. No action is replayed and no other app is affected.',inputSchema:{
   type:'object',properties:{pid:{type:'integer',minimum:1},windowId:{type:'integer',minimum:1},
     snapshotId:{type:'string',pattern:'^[sb][0-9a-f]{8}$'},
     surface:{type:'string',enum:['window','browser','native']},workspaceSeat:{type:'string',enum:['a','b']},
     targetGoneVerified:{type:'boolean'},
     determination:{type:'string',enum:['EFFECT_OBSERVED','NO_EFFECT_OBSERVED']}},
   required:['pid','windowId','determination'],additionalProperties:false},annotations:mutating}
];
export function createWorkspaceController({callDriver=defaultCuaCall,nativeCall=defaultNativeUIACall,previewDriver=defaultCuaPreview,ownerSession=defaultOwnerSession,
  platform=process.platform,env=process.env,now=Date.now,journal=createWorkspaceTargetJournal(),hybridProbe=null}={}){
 const pending=new Map(),seen=new Set(),busy=new Set(),snapshots=new Map(),browserSnapshots=new Map(),nativeSnapshots=new Map();
 const needsOwner=async()=>{if(!await ownerSession({platform,env}))throw fail('WORKSPACE_OWNER_SESSION_REQUIRED');};
 async function execute(name,input={},runtimeContext=null){
  const seat=input.workspaceSeat??null;
  if(seat!==null&&(platform!=='linux'||!['a','b'].includes(seat)))throw fail('WORKSPACE_SEAT_INVALID');
  const call=(tool,args)=>callDriver(tool,args,{platform,env,workspaceSeat:seat});
  if(seat!==null&&name.startsWith('workspace_browser_'))throw fail('WORKSPACE_BROWSER_PRIVATE_SEAT_UNSUPPORTED');
  if(name==='workspace_plan'){
   const owner=await ownerSession({platform,env});
   return chooseWorkspaceRoute({...input,sameUserSession:owner,desktop:desktopType(platform,env)});
  }
  if(name==='workspace_agentos_plan'){
   const owner=await ownerSession({platform,env});
   let nativeAvailable=false;
   if(platform==='win32'){
    try{await fs.access(new URL('../tools/native-windows-uia.ps1',import.meta.url));nativeAvailable=true;}catch{}
   }
   const {chooseAgentOSProvider}=await import('./agentos-provider-router.mjs');
   const probe=hybridProbe??(async()=> {
     const {discoverHybridCapabilities,probeLinuxAtspiSession,classifyOwnedBrowserStatus}
       =await import('./hybrid-capability-discovery.mjs');
     const exists=async(path)=>{try{await fs.access(new URL(path,import.meta.url));return true;}catch{return false;}};
     const [linuxHelper,browserHelper]=await Promise.all([
       platform==='linux'?exists('../tools/owner-atspi-semantic.py'):false,
       exists('../tools/browser-control.mjs')
     ]);
     let browser=null;
     let nativeReceipt=null;
     if(platform==='linux'&&owner===true&&input.target==='existing-browser'&&
        input.nativeBrowserUIAuthorized===true&&linuxHelper&&integer(input.pid)&&integer(input.windowId)){
       const {probeLinuxX11OwnerBrowser}=await import('./browser-owner-x11-attestation.mjs');
       const verified=await probeLinuxX11OwnerBrowser({
         platform,env,ownerSession:owner,pid:input.pid,windowId:input.windowId,
         browserFamily:input.browserFamily,nowMs:now()});
       if(verified.ready===true)nativeReceipt=verified;
     }
     if(platform==='win32'&&owner===true&&input.target==='existing-app'&&
        integer(input.pid)&&integer(input.windowId)){
       const snap=nativeSnapshots.get(targetId(input.pid,input.windowId));
       if(snap&&snap.ownerVerified===true&&snap.pid===input.pid&&
          snap.windowId===input.windowId&&Number.isSafeInteger(snap.at)&&
          now()>=snap.at&&now()-snap.at<=15000&&
          typeof snap.ownerSid==='string'&&/^S-1-[0-9]+(?:-[0-9]+){2,15}$/.test(snap.ownerSid)){
         nativeReceipt=Object.freeze({source:'INTERNAL_OWNER_TARGET_OBSERVER',
           providerId:'windows-uia-native',target:'existing-app',scope:'CURRENT_HOST',
           ownerSession:true,ready:true,ownerPrincipal:'sid:'+snap.ownerSid,
           pid:input.pid,windowId:input.windowId,observedAtMs:snap.at,
           expiresAtMs:snap.at+15000,effectUncertain:false,targetIdentityVerified:true});
       }
     }
     if(browserHelper&&input.target.endsWith('browser')&&runtimeContext?.config?.powerMode?.browserControl?.enabled===true){
       try{
         const {getBrowserReadinessSnapshot}=await import('./browser-tools.mjs');
         browser=classifyOwnedBrowserStatus(getBrowserReadinessSnapshot(runtimeContext));
       }catch{browser=classifyOwnedBrowserStatus(null);}
     }
     const discovered=await discoverHybridCapabilities({platform,ownerSession:owner,installed:{
       nativeWindowsUIA:nativeAvailable,
       linuxATSPI:linuxHelper&&!!env.XDG_RUNTIME_DIR&&!!env.DBUS_SESSION_BUS_ADDRESS,
       ownedBrowser:browserHelper,visualFallback:false
     },verify:async providerId=>{
       if(providerId==='windows-uia-native')return nativeReceipt;
       if(providerId==='linux-atspi-native')
         return nativeReceipt?.providerId==='linux-atspi-native'
           ?nativeReceipt:probeLinuxAtspiSession({platform,ownerSession:owner,env});
       if(providerId==='commander-owned-browser')return browser;
       return null;
     },nowMs:now()});
     return {...discovered,targetReceipt:nativeReceipt};
   });
   const hybrid=await probe({platform,ownerSession:owner});
   const route=chooseAgentOSProvider({target:input.target,platform,ownerSession:owner,
     capabilities:hybrid.capabilities,
     grants:{browserProfileAttach:input.existingProfileGrant===true,
       nativeBrowserUI:input.nativeBrowserUIAuthorized===true,
       browserExtensionAttach:input.browserExtensionAuthorized===true,
       visualFallback:input.visualFallbackAuthorized===true},
     application:{browserFamily:input.browserFamily,purpose:input.purpose,profileKind:input.profileKind}});
   if(route.status==='READY'&&(input.target==='existing-app'||input.target==='existing-browser')){
     const {verifyBoundOwnerTargetReceipt}=await import('./hybrid-capability-discovery.mjs');
     // Linux current UID is local OS metadata. Windows SID comes exclusively from the
     // owner-session native UIA observer which has already checked the process token SID.
     // The MCP caller never supplies a principal or an observer receipt.
     const principal=platform==='linux'&&typeof process.getuid==='function'
       ?'uid:'+process.getuid()
       :platform==='win32'&&hybrid.targetReceipt?.providerId==='windows-uia-native'
         ?hybrid.targetReceipt.ownerPrincipal:null;
     const proof=verifyBoundOwnerTargetReceipt({
       receipt:hybrid.targetReceipt,providerId:route.provider,target:input.target,
       selector:input,ownerPrincipal:principal,nowMs:now()});
     if(!proof.valid)return Object.freeze({...route,status:'BLOCKED',
       code:'EXACT_OWNER_TARGET_ATTESTATION_REQUIRED',providerCandidate:route.provider,
       provider:null,fallbackAllowed:false,fallbackProviders:Object.freeze([]),
       evidence:hybrid.evidence,readinessScope:'EXACT_OWNER_TARGET_UNVERIFIED',
       attestationReason:proof.reason,readOnlyPlan:true});
     return Object.freeze({...route,evidence:hybrid.evidence,
       readinessScope:'EXACT_OWNER_TARGET_OBSERVER_MATCH',targetBound:true,readOnlyPlan:true});
   }
   return Object.freeze({...route,evidence:hybrid.evidence,
     readinessScope:'VERIFIED_BACKEND_ONLY',readOnlyPlan:true});
  }
  await needsOwner();
  if(name==='workspace_list_windows'){
   const request={};if(input.pid!==undefined){if(!integer(input.pid))throw fail('WORKSPACE_PID_INVALID');request.pid=input.pid;}
   const value=await call('list_windows',request);
   return {ok:true,mode:'READ_ONLY',focusChanged:false,value};
  }
  if(!exactWindow(input))throw fail('WORKSPACE_TARGET_INVALID');
  const id=(seat?seat+':':'')+targetId(input.pid,input.windowId);
  const session='rcws-'+(seat?seat+'-':'')+input.pid+'-'+input.windowId;
  if(name==='workspace_native_ui_observe'||name==='workspace_native_ui_set_value'||name==='workspace_native_ui_invoke'){
   if(seat!==null||platform!=='win32')throw fail('AGENTOS_NATIVE_OWNER_WINDOWS_REQUIRED');
   if(!['brave','chrome','msedge','firefox'].includes(input.application))
    throw fail('AGENTOS_NATIVE_APPLICATION_INVALID');
   if(name==='workspace_native_ui_observe'){
    const value=await nativeCall('Observe',input,{platform,env});
    const indexed=new Map();
    for(const e of value.elements??[]){
     if(e.enabled===true&&typeof e.fingerprint==='string'&&
        (e.invokeAvailable===true||e.valueAvailable===true)){
      indexed.set(e.fingerprint,{name:e.name,enabled:e.enabled,
       invokeAvailable:e.invokeAvailable===true,valueAvailable:e.valueAvailable===true,
       valueProvider:e.valueProvider??null,controlType:e.controlType??''});
     }
    }
    const snapshotId='n'+randomBytes(4).toString('hex');
    const ownerVerified=value.ok===true&&value.pid===input.pid&&
      value.windowHandle===input.windowId&&value.provider==='windows-uia-native'&&
      value.physicalInputTouched===false&&value.foregroundTouched===false&&
      typeof value.principalSid==='string'&&/^S-1-[0-9]+(?:-[0-9]+){2,15}$/.test(value.principalSid);
    nativeSnapshots.set(id,{at:now(),elements:indexed,snapshotId,application:input.application,
      ownerVerified,pid:input.pid,windowId:input.windowId,
      ownerSid:ownerVerified?value.principalSid:null});
    return {ok:true,mode:'NATIVE_UIA_READ_ONLY',target:id,application:input.application,
      provider:'windows-uia-native',snapshotId,
      targetUncertain:pending.has('native:'+id)||!!await journal.pending('native:'+id),
      physicalInputTouched:false,focusChanged:value.foregroundTouched??null,
      focusStatus:value.foregroundStatus,value};
   }
   const isSetValue=name==='workspace_native_ui_set_value';
   const operation=isSetValue?'SetValue':'Invoke';
   const contractOk=typeof input.requestId==='string'&&REQUEST.test(input.requestId)&&
      typeof input.fingerprint==='string'&&/^[a-f0-9]{24}$/.test(input.fingerprint)&&
      typeof input.controlName==='string'&&input.controlName.length>=1&&input.controlName.length<=150&&
      typeof input.explicitUserAuthorization==='string'&&input.explicitUserAuthorization.trim().length>=12&&
      typeof input.foregroundChangeAuthorized==='boolean'&&
      (!isSetValue||(typeof input.value==='string'&&input.value.length>=1&&input.value.length<=1024&&!input.value.includes('\0')));
   if(!contractOk)throw fail(isSetValue?'AGENTOS_NATIVE_SET_VALUE_CONTRACT_INVALID':'AGENTOS_NATIVE_INVOKE_CONTRACT_INVALID');
   if(seen.has(input.requestId))throw fail('WORKSPACE_DUPLICATE_REQUEST_NO_REPLAY');
   if(busy.has(id)||pending.has('native:'+id)||await journal.pending('native:'+id))
    throw fail('WORKSPACE_TARGET_RECONCILIATION_REQUIRED');
   const snap=nativeSnapshots.get(id);
   const entry=snap?.elements.get(input.fingerprint);
   if(!snap||snap.application!==input.application||now()-snap.at>60000||!entry||
     entry.name!==input.controlName||entry.enabled!==true||
     (isSetValue?!entry.valueAvailable:!entry.invokeAvailable))
    throw fail('AGENTOS_FRESH_EXACT_UIA_ELEMENT_REQUIRED');
   seen.add(input.requestId);busy.add(id);nativeSnapshots.delete(id);
   let handle=null;
   try{
    handle=await journal.begin('native:'+id,name,input.requestId);
    const result=await nativeCall(operation,input,{platform,env});
    const focusPreserved=result.foregroundStatus==='PRESERVED'&&result.foregroundTouched===false;
    const targetBecameForeground=result.foregroundStatus==='CHANGED'&&
      result.foregroundTouched===true&&input.foregroundChangeAuthorized===true&&
      result.foregroundAfterWindowHandle===input.windowId&&
      result.foregroundAfterProcessId===input.pid;
    const focusAccepted=focusPreserved||targetBecameForeground;
    const effectVerified=isSetValue
      ?result.valueApplied===true&&result.readBackVerified===true
      :result.invocationIssued===true&&result.userGoalVerified===false;
    const accepted=focusAccepted&&effectVerified;
    if(accepted)await journal.resolve('native:'+id,handle);
    else pending.set('native:'+id,{requestId:input.requestId,at:now()});
    const mode=isSetValue
      ?(accepted?'NATIVE_UIA_SET_VALUE_VERIFIED':result.foregroundStatus==='UNOBSERVABLE'?'NATIVE_UIA_FOCUS_UNOBSERVABLE':'NATIVE_UIA_SET_VALUE_UNCERTAIN')
      :(accepted?'NATIVE_UIA_INVOKE_ISSUED':result.foregroundStatus==='UNOBSERVABLE'?'NATIVE_UIA_FOCUS_UNOBSERVABLE':'NATIVE_UIA_FOCUS_CHANGED');
    return {ok:accepted,mode,target:id,application:input.application,
      provider:'windows-uia-native',replayed:false,physicalInputTouched:false,
      focusChanged:result.foregroundTouched??null,focusStatus:result.foregroundStatus,
      focusTargetVerified:targetBecameForeground,
      ...(isSetValue?{valueApplied:result.valueApplied===true,readBackVerified:result.readBackVerified===true,
       valueLength:result.valueLength,valueSha256:result.valueSha256,valueProvider:result.valueProvider}:{
       invocationIssued:result.invocationIssued===true}),
      decision:{status:accepted?(isSetValue?'VALUE_SET_AND_READBACK_VERIFIED':
        targetBecameForeground?'INVOKE_ACKNOWLEDGED_TARGET_FOCUSED':'INVOKE_ACKNOWLEDGED'):
        result.foregroundStatus==='UNOBSERVABLE'?'FOREGROUND_UNOBSERVABLE':'FOREGROUND_CHANGE_NOT_ACCEPTED',
       userGoalVerified:false,
       next:accepted?'Take a fresh native observation and verify the application-specific state before the next effect':
        'Reconcile this exact target before any retry; do not restore focus or replay automatically'}};
   }catch(error){
    if(!handle)throw error;
    pending.set('native:'+id,{requestId:input.requestId,at:now()});
    return {ok:false,mode:'NATIVE_UIA_OUTCOME_UNCERTAIN',target:id,application:input.application,
      replayed:false,physicalInputTouched:false,code:error?.code??'AGENTOS_NATIVE_OUTCOME_UNCERTAIN'};
   }finally{busy.delete(id);}
  }
  if(name==='workspace_window_preview'){
   const image=await previewDriver({pid:input.pid,window_id:input.windowId,
     session:'rcws-view-'+(seat?seat+'-':'')+input.pid+'-'+input.windowId},{platform,env,workspaceSeat:seat});
   const encoded=image.imageBytes.toString('base64');
   const details={ok:true,mode:'READ_ONLY_SPECTATOR',target:id,focusChanged:false,
     physicalInputTouched:false,interactiveInput:false,bytes:image.imageBytes.length};
   return {__mcpContent:[{type:'image',mimeType:'image/png',data:encoded},
     {type:'text',text:JSON.stringify(details)}],__structuredContent:details};
  }
  if(name==='workspace_window_observe'){
   const v=await call('get_window_state',{pid:input.pid,window_id:input.windowId,
     include_screenshot:false,tree_format:'elements',max_elements:Math.min(input.maxElements??50,150),timeout_ms:4000,
     session});
   const sid=v?.snapshot_id??v?.snapshotId;
   if(typeof sid==='string'&&/^s[0-9a-f]{8}$/.test(sid)){
    const editable=Array.isArray(v?.elements)?v.elements.filter(x=>
      (x?.role==='entry'||(x?.role==='text'&&Array.isArray(x?.actions)&&x.actions.includes('SetFocus')))&&
      typeof x?.element_token==='string'&&x.element_token.startsWith(sid+':')&&
      typeof x?.label==='string'&&x.label.length>0&&x.label.length<=150).map(x=>
      ({token:x.element_token,label:x.label,enabled:x.enabled!==false})):[];
    snapshots.set(id,{id:sid,at:now(),editable});
   }
   return {ok:true,mode:'READ_ONLY',focusChanged:false,targetUncertain:pending.has(id)||!!await journal.pending(id),
     snapshotId:sid??null,value:v};
  }
  if(name==='workspace_browser_inspect'){
   const session='rcws-'+input.pid+'-'+input.windowId;
   // A previously ended CUA lifecycle name cannot be silently reused.
   await call('start_session',{session});
   const v=await call('get_browser_state',{pid:input.pid,window_id:input.windowId,
     session});
   if(v?.status==='refused'||v?.refusal?.code)
    return {ok:false,mode:'BACKGROUND_READ_ONLY',scope:'TARGET_ONLY',
      code:v?.refusal?.code??'BROWSER_SETUP_REQUIRED',focusChanged:false,
      next:'AUTHORIZED_BROWSER_PREPARE_REQUIRED'};
   const stamp='b'+randomBytes(4).toString('hex');
   browserSnapshots.set(id,{at:now(),target:v?.target_id??v?.targetId??null,snapshotId:stamp});
   return {ok:true,mode:'BACKGROUND_READ_ONLY',focusChanged:false,snapshotId:stamp,
     targetUncertain:pending.has('browser:'+id)||!!await journal.pending('browser:'+id),value:v};
  }
  if(name==='workspace_browser_attach'){
   if(typeof input.explicitUserAuthorization!=='string'||input.explicitUserAuthorization.trim().length<12)
     throw fail('WORKSPACE_EXPLICIT_AUTHORIZATION_REQUIRED');
   try{
     const session='rcws-'+input.pid+'-'+input.windowId;
     await call('start_session',{session});
     const v=await call('browser_prepare',{pid:input.pid,window_id:input.windowId,
       strategy:{kind:'existing_profile'},delivery_mode:'background',
       session});
     if(v?.status==='refused'||v?.refusal?.code)
      return {ok:false,status:'PROFILE_ATTACH_NOT_READY',scope:'TARGET_ONLY',
       errorCode:v?.refusal?.code??'WORKSPACE_BROWSER_ATTACH_REFUSED',focusChanged:false};
     return {ok:true,mode:'OWNER_AUTHORIZED_EXISTING_PROFILE',focusChanged:false,
       physicalInputTouched:false,value:v};
   }catch(e){
     return {ok:false,status:'PROFILE_ATTACH_NOT_READY',scope:'TARGET_ONLY',
       errorCode:e?.code??'WORKSPACE_BROWSER_ATTACH_REFUSED',
       instruction:'Same-owner Cua Driver must have existing-profile grant and browser-native consent; no fallback to focus, copies or credentials'};
   }
  }
  if(name==='workspace_browser_click'){
   if(typeof input.explicitUserAuthorization!=='string'||input.explicitUserAuthorization.trim().length<12)
     throw fail('WORKSPACE_EXPLICIT_AUTHORIZATION_REQUIRED');
   if(typeof input.requestId!=='string'||!REQUEST.test(input.requestId)||typeof input.ref!=='string'||!/^p[A-Za-z0-9:_-]{2,127}$/.test(input.ref))
     throw fail('WORKSPACE_BINDING_INVALID');
   const key='browser:'+id;
   if(seen.has(input.requestId))throw fail('WORKSPACE_DUPLICATE_REQUEST_NO_REPLAY');
   if(pending.has(key)||await journal.pending(key))throw fail('WORKSPACE_TARGET_RECONCILIATION_REQUIRED');
   const b=browserSnapshots.get(id);
   if(!b||now()-b.at>60000||(b.target!==null&&b.target!==input.targetId))
     throw fail('WORKSPACE_FRESH_SNAPSHOT_REQUIRED');
   if(busy.has(key))throw fail('WORKSPACE_TARGET_BUSY');
   seen.add(input.requestId);busy.add(key);browserSnapshots.delete(id);
   let handle=null;
   try{
     handle=await journal.begin(key,'workspace_browser_click',input.requestId);
     const v=await call('browser_click',{target_id:input.targetId,tab_id:input.tabId,
       ref:input.ref,delivery_mode:'background',session:'rcws-'+input.pid+'-'+input.windowId});
     const refused=v?.status==='refused'&&typeof v?.refusal?.code==='string';
   if(refused){await journal.resolve(key,handle);return {ok:false,mode:'BACKGROUND_BROWSER_TARGETED',
     status:'REFUSED_NO_EFFECT',code:v.refusal.code,scope:'TARGET_ONLY',replayed:false,
     next:v.refusal.code==='stale_element_token'?'REFRESH_SNAPSHOT':'SELECT_NONFOREGROUND_ALTERNATIVE'};}
   const decision=classifyWorkspaceOutcome({effect:v?.effect,
       refusedCode:v?.code??v?.error,hasFreshObservation:v?.verified===true});
     if(decision.status==='RECONCILE_TARGET')pending.set(key,{requestId:input.requestId,at:now()});
     else await journal.resolve(key,handle);
     return {ok:v?.ok!==false,mode:'BACKGROUND_BROWSER_TARGETED',focusChanged:false,
       physicalInputTouched:false,decision,verified:v?.verified===true};
   }catch(e){
     if(!handle)throw e;
     pending.set(key,{requestId:input.requestId,at:now()});
     return {ok:false,target:key,errorCode:e?.code??'WORKSPACE_BROWSER_ACTION_UNKNOWN',
       status:'RECONCILE_TARGET',scope:'TARGET_ONLY',replayed:false,otherTargetsUnaffected:true};
   }finally{busy.delete(key);}
  }
  if(name==='workspace_target_reconcile'){
   const isBrowser=input.surface==='browser',isNative=input.surface==='native',key=isBrowser?'browser:'+id:isNative?'native:'+id:id;
   const p=await journal.pending(key),shot=isBrowser?browserSnapshots.get(id):isNative?nativeSnapshots.get(id):snapshots.get(id);
   if(!p)throw fail('WORKSPACE_NO_TARGET_INCIDENT');
   if(!['EFFECT_OBSERVED','NO_EFFECT_OBSERVED'].includes(input.determination))throw fail('WORKSPACE_DETERMINATION_INVALID');
   if(input.targetGoneVerified===true){
    // Only owner-private X11 seat: prove the former exact window is no longer
    // enumerated by the SAME live independent native driver; no input replay.
    if(isBrowser||isNative||(!seat&&platform!=='win32')||input.determination!=='EFFECT_OBSERVED')
     throw fail('WORKSPACE_TARGET_GONE_PROOF_DENIED');
    const native=await call('list_windows',{pid:input.pid});
    if(!Array.isArray(native?.windows)||
       native.windows.some(w=>w?.pid===input.pid&&w?.window_id===input.windowId))
     throw fail('WORKSPACE_TARGET_GONE_NOT_PROVEN');
   }else if(!shot||(isBrowser||isNative?shot.snapshotId:shot.id)!==input.snapshotId||
             now()-shot.at>60000)
    throw fail('WORKSPACE_FRESH_SNAPSHOT_REQUIRED');
   await journal.resolve(key,p);
   pending.delete(key);if(isNative)nativeSnapshots.delete(id);
    return {ok:true,target:key,determination:input.determination,replayed:false,
     noGlobalInputLock:true,otherTargetsUnaffected:true};
  }
  if(name!=='workspace_window_click'&&name!=='workspace_window_type')throw fail('WORKSPACE_TOOL_UNKNOWN');
  if(typeof input.explicitUserAuthorization!=='string'||input.explicitUserAuthorization.trim().length<12)
    throw fail('WORKSPACE_EXPLICIT_AUTHORIZATION_REQUIRED');
  if(!TOKEN.test(input.elementToken)||typeof input.requestId!=='string'||!REQUEST.test(input.requestId))throw fail('WORKSPACE_BINDING_INVALID');
  if(seen.has(input.requestId))throw fail('WORKSPACE_DUPLICATE_REQUEST_NO_REPLAY');
  if(pending.has(id)||await journal.pending(id))throw fail('WORKSPACE_TARGET_RECONCILIATION_REQUIRED');
  if(busy.has(id))throw fail('WORKSPACE_TARGET_BUSY');
  const shot=snapshots.get(id);
  if(!shot||now()-shot.at>60000||!input.elementToken.startsWith(shot.id+':'))
    throw fail('WORKSPACE_FRESH_SNAPSHOT_REQUIRED');
  const typing=name==='workspace_window_type';
  if(typing){
   if(typeof input.text!=='string'||input.text.length<1||input.text.length>1024||
      typeof input.controlName!=='string'||input.controlName.length<1||input.controlName.length>150)
    throw fail('WORKSPACE_TYPE_INPUT_INVALID');
   const field=shot.editable?.find(x=>x.token===input.elementToken);
   if(!field||field.label!==input.controlName||field.enabled===false||
      /password|passcode|one.time|verification|security code|otp|رمز|کد تأیید/i.test(field.label))
    throw fail('WORKSPACE_EDITABLE_TARGET_UNVERIFIED');
  }
  seen.add(input.requestId);busy.add(id);snapshots.delete(id);
  let handle=null;
  try{
   handle=await journal.begin(id,name,input.requestId);
   const effect=await call(typing?'type_text':'click',{target:{kind:'window',pid:input.pid,window_id:input.windowId},
     element_token:input.elementToken,...(typing?{text:input.text}:{}),delivery_mode:'background',
     session:'rcws-'+input.pid+'-'+input.windowId});
   const refused=effect?.status==='refused'&&typeof effect?.refusal?.code==='string';
   if(refused){await journal.resolve(id,handle);return {ok:false,mode:'BACKGROUND_TARGETED',status:'REFUSED_NO_EFFECT',
     code:effect.refusal.code,scope:'TARGET_ONLY',replayed:false,
     next:effect.refusal.code==='stale_element_token'?'REFRESH_SNAPSHOT':'SELECT_NONFOREGROUND_ALTERNATIVE'};}
   const decision=classifyWorkspaceOutcome({effect:effect?.effect,
      refusedCode:effect?.code??effect?.error,hasFreshObservation:effect?.verified===true});
   if(decision.status==='RECONCILE_TARGET'&&effect?.effect==='unverifiable'){
    // Independent exact-window read. Confirms target disappearance only,
    // not the higher-level user goal; never repeats the uncertain action.
    try{
     const native=await call('list_windows',{pid:input.pid});
     if(Array.isArray(native?.windows)&&
        !native.windows.some(w=>w?.pid===input.pid&&w?.window_id===input.windowId)){
      await journal.resolve(id,handle);
      return {ok:true,mode:'BACKGROUND_TARGETED',physicalInputTouched:false,
       focusChanged:false,target:id,replayed:false,verifiedTargetGone:true,
       decision:{status:'TARGET_GONE_VERIFIED',scope:'TARGET_ONLY',
        userGoalVerified:false,retry:'NOT_APPLICABLE_TARGET_GONE'},
       driverEffect:effect.effect};
     }
    }catch{ /* Fail closed for this target; other targets continue. */ }
   }
   if(decision.status==='RECONCILE_TARGET')pending.set(id,{requestId:input.requestId,at:now()});
   else await journal.resolve(id,handle);
   return {ok:true,mode:'BACKGROUND_TARGETED',physicalInputTouched:false,focusChanged:false,
     target:id,decision,driverEffect:effect?.effect??'unknown',verified:effect?.verified===true};
  }catch(error){
   if(!handle)throw error;
   pending.set(id,{requestId:input.requestId,at:now()});
   return {ok:false,target:id,decision:classifyWorkspaceOutcome(),errorCode:error?.code??'WORKSPACE_ACTION_UNKNOWN',
     noGlobalInputLock:true,otherTargetsUnaffected:true,replayed:false};
  }finally{busy.delete(id);}
 }
 return {execute};
}
const singleton=createWorkspaceController();
export function assertWorkspaceToolPolicy(config,name,args={}){
 const power=config?.powerMode;
 if(power?.enabled!==true)throw fail('WORKSPACE_POWER_MODE_DISABLED');
 if(name==='workspace_plan'||name==='workspace_agentos_plan')return;
 const browser=name.startsWith('workspace_browser_')||
  (name==='workspace_target_reconcile'&&args?.surface==='browser');
 if(browser){
  if(power.browserControl?.enabled!==true)throw fail('WORKSPACE_BROWSER_CONTROL_DISABLED');
  if(['workspace_browser_attach','workspace_browser_click','workspace_target_reconcile'].includes(name)&&
    power.browserControl?.allowInput!==true)throw fail('WORKSPACE_BROWSER_INPUT_POLICY_DENIED');
 }else{
  if(power.guiControl?.enabled!==true)throw fail('WORKSPACE_GUI_CONTROL_DISABLED');
  if(name==='workspace_window_preview'&&power.guiControl?.allowScreenshot!==true)
    throw fail('WORKSPACE_GUI_PREVIEW_POLICY_DENIED');
  if(name==='workspace_window_type'&&power.guiControl?.allowKeyboard!==true)
    throw fail('WORKSPACE_GUI_KEYBOARD_POLICY_DENIED');
  if(['workspace_window_click','workspace_target_reconcile'].includes(name)&&
    power.guiControl?.allowMouse!==true)throw fail('WORKSPACE_GUI_INPUT_POLICY_DENIED');
  // Native UIA uses semantic control patterns, not physical mouse/keyboard input.
  // Power Mode + GUI enabled, exact target checks and per-effect owner authorization remain mandatory.
  if(['workspace_native_ui_set_value','workspace_native_ui_invoke'].includes(name)&&
    power.guiControl?.enabled!==true)throw fail('WORKSPACE_GUI_INPUT_POLICY_DENIED');
  if(name==='workspace_native_ui_invoke'&&args.foregroundChangeAuthorized===true&&
    power.guiControl?.allowWindowFocus!==true)throw fail('WORKSPACE_GUI_WINDOW_FOCUS_POLICY_DENIED');
 }
}
export async function executeWorkspaceTool(ctx,name,args){
 assertWorkspaceToolPolicy(ctx?.config,name,args);
 return singleton.execute(name,args,ctx);
}
