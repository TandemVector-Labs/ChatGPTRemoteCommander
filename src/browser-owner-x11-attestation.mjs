// Exact same-owner Linux X11 browser attestation, no cookies, CDP or input.
import {stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const command=promisify(execFile);
const browserFromClass=(str)=>{
 const c=str.toLowerCase();
 for(const [re,name] of [[/firefox/,'firefox'],[/brave/,'brave'],[/vivaldi/,'vivaldi'],[/opera/,'opera'],
  [/msedge|microsoft.edge/,'edge'],[/chromium/,'chromium'],[/chrome/,'chrome']]){
  if(re.test(c))return name;
 }
 return null;
};
function parseXprop(out){
 if(typeof out!=='string'||out.length>8192)return null;
 const pid=/^_NET_WM_PID\(CARDINAL\)\s*=\s*(\d+)$/m.exec(out);
 const klass=/^WM_CLASS\(STRING\)\s*=\s*(.+)$/m.exec(out);
 const title=/^_NET_WM_NAME\(UTF8_STRING\)\s*=\s*"([^"\r\n]{4,300})"$/m.exec(out);
 if(!pid||!klass||!title)return null;
 return {pid:Number(pid[1]),family:browserFromClass(klass[1]),title:title[1]};
}
export async function probeLinuxX11OwnerBrowser({
 platform=process.platform,env=process.env,ownerSession=false,pid,windowId,browserFamily,
 nowMs=Date.now(),runXprop=null,readSnapshot=null,fileStat=stat,userId=()=>process.getuid()
}={}){
 const blocked=status=>Object.freeze({providerId:'linux-atspi-native',scope:'CURRENT_HOST',
  ownerSession:ownerSession===true,ready:false,status});
 if(platform!=='linux'||ownerSession!==true||env.XDG_SESSION_TYPE!=='x11'||
  !/^:[0-9]{1,3}(?:\.[0-9])?$/.test(env.DISPLAY??'')||
  typeof env.XAUTHORITY!=='string'||!env.XAUTHORITY.startsWith('/')||
  !Number.isSafeInteger(pid)||pid<=0||!Number.isSafeInteger(windowId)||windowId<=0||
  !Number.isSafeInteger(nowMs)||nowMs<0)return blocked('BROWSER_NATIVE_OWNER_SESSION_UNVERIFIED');
 try{
  const uid=userId();
  if(!Number.isSafeInteger(uid)||uid===0)return blocked('BROWSER_NATIVE_OWNER_USER_UNVERIFIED');
  const [proc,auth]=await Promise.all([fileStat('/proc/'+pid),fileStat(env.XAUTHORITY)]);
  if(proc.uid!==uid||auth.uid!==uid)return blocked('BROWSER_NATIVE_UID_MISMATCH');
  const query=runXprop??(async()=>command('xprop',['-id',String(windowId),
   '_NET_WM_PID','WM_CLASS','_NET_WM_NAME'],{
   timeout:2500,maxBuffer:8192,encoding:'utf8',env:{...env,LC_ALL:'C.UTF-8'}}));
  const read=async()=>parseXprop((await query()).stdout);
  const before=await read();
  if(!before||before.pid!==pid||!before.family||
    (browserFamily&&browserFamily!=='other'&&before.family!==browserFamily))
   return blocked('BROWSER_NATIVE_EXACT_WINDOW_MISMATCH');
  const snapshot=readSnapshot??(async()=>{
   const {nativeAtspi}=await import('./workspace-accessibility-tools.mjs');
   return nativeAtspi({command:'snapshot',pid,windowTitle:before.title},{timeoutMs:9000});
  });
  const result=await snapshot({pid,title:before.title});
  if(result?.ok!==true||result.valuesRead!==false||
    !Array.isArray(result.controls)||result.controls.length<1||result.controls.length>80)
   return blocked('BROWSER_NATIVE_ACTIONABLE_CONTROLS_UNVERIFIED');
  const after=await read();
  if(!after||after.pid!==pid||after.family!==before.family||after.title!==before.title)
   return blocked('BROWSER_NATIVE_TARGET_CHANGED_DURING_PROBE');
  const observedAtMs=Date.now();
  return Object.freeze({source:'INTERNAL_OWNER_TARGET_OBSERVER',providerId:'linux-atspi-native',
    target:'existing-browser',scope:'CURRENT_HOST',ownerSession:true,ready:true,
    ownerPrincipal:'uid:'+uid,pid,windowId,browserFamily:before.family,
    observedAtMs,expiresAtMs:observedAtMs+12000,
    targetIdentityVerified:true,effectUncertain:false,controlsObserved:result.controls.length});
 }catch{return blocked('BROWSER_NATIVE_OWNER_PROBE_UNAVAILABLE');}
}
