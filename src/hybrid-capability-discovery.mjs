// Evidence-based hybrid provider discovery; never equate installed scripts with live authority.
// Only an internal host verifier can produce scoped, fresh readiness receipts.
const PROVIDERS=Object.freeze([
  ['windowsUIA','windows-uia-native','win32','nativeWindowsUIA'],
  ['linuxATSPI','linux-atspi-native','linux','linuxATSPI'],
  ['commanderOwnedBrowser','commander-owned-browser','cross','ownedBrowser'],
  ['cuaVerifiedOwnerTarget','cua-last-resort','cross','visualFallback']
]);
const validObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
export async function discoverHybridCapabilities({
  platform,ownerSession=false,installed={},verify=async()=>null,nowMs=Date.now()
}={}){
  if(!['win32','linux'].includes(platform)||!validObject(installed)||
    typeof verify!=='function'||!Number.isSafeInteger(nowMs)||nowMs<0)
    throw Error('HYBRID_DISCOVERY_INPUT_INVALID');
  const hasOwner=ownerSession===true;
  const cap={windowsUIA:false,linuxATSPI:false,commanderOwnedBrowser:false,
    cuaVerifiedOwnerTarget:false,commanderWorkflow:true};
  const observations={};
  for(const [key,id,os,installedKey] of PROVIDERS){
    const supported=os==='cross'||os===platform;
    const exists=installed[installedKey]===true;
    let status=!supported?'UNSUPPORTED_PLATFORM':!hasOwner?'OWNER_SESSION_REQUIRED':
      !exists?'BACKEND_NOT_INSTALLED':'INSTALLED_NOT_ATTESTED';
    if(supported&&hasOwner&&exists){
      let r=null;
      try{r=await verify(id);}catch{/* probe failure is not a successful receipt */}
      if(validObject(r)&&r.providerId===id&&r.ready===true&&
        r.ownerSession===true&&r.scope==='CURRENT_HOST'&&
        Number.isSafeInteger(r.observedAtMs)&&r.observedAtMs<=nowMs&&
        nowMs-r.observedAtMs<=30000&&Number.isSafeInteger(r.expiresAtMs)&&r.expiresAtMs>nowMs){
        status='VERIFIED_READY';cap[key]=true;
      }else if(validObject(r)&&r.providerId===id&&r.ready===false){
        const specific=['AT_SPI_SESSION_BUS_ENABLED_TARGET_UNVERIFIED',
          'AT_SPI_SESSION_BUS_DISABLED','AT_SPI_SESSION_BUS_UNAVAILABLE',
          'AT_SPI_OWNER_SESSION_MISSING','BROWSER_HELPER_UNAVAILABLE',
          'BROWSER_AVAILABLE_IDLE','BROWSER_NO_ACTIVE_OWNER_LEASE',
          'BROWSER_SESSION_EXISTS_OWNER_LEASE_REQUIRED',
          'BROWSER_OUTCOME_RECONCILIATION_REQUIRED'];
        status=specific.includes(r.status)?r.status:'VERIFIED_UNAVAILABLE';
      }
    }
    observations[id]=Object.freeze({status,installed:exists&&supported,usable:cap[key]});
  }
  return Object.freeze({capabilities:Object.freeze(cap),evidence:Object.freeze(observations),
    defaultFallback:'NO_UNVERIFIED_PROVIDER',ownerSession:hasOwner,probeReadOnly:true});
}

const A11Y_CODES=new Set(['AT_SPI_SESSION_BUS_ENABLED_TARGET_UNVERIFIED','AT_SPI_SESSION_BUS_DISABLED',
  'AT_SPI_SESSION_BUS_UNAVAILABLE','AT_SPI_OWNER_SESSION_MISSING']);
// Read-only owner-session feature discovery. It never claims a particular application.
export async function probeLinuxAtspiSession({
  ownerSession=false,platform='linux',env=process.env,
  run=null,nowMs=Date.now()
}={}){
  const result=(status,enabled)=>Object.freeze({providerId:'linux-atspi-native',
    ready:false,sessionBusReady:enabled,status,scope:'CURRENT_HOST',
    ownerSession:ownerSession===true,observedAtMs:nowMs});
  if(platform!=='linux'||ownerSession!==true||
     typeof env.XDG_RUNTIME_DIR!=='string'||!/^\/run\/user\/[0-9]+$/.test(env.XDG_RUNTIME_DIR)||
     !env.DBUS_SESSION_BUS_ADDRESS)return result('AT_SPI_OWNER_SESSION_MISSING',false);
  try{
    const call=run??(async()=>{
      const {execFile}=await import('node:child_process');
      const {promisify}=await import('node:util');
      return promisify(execFile)('busctl',['--user','get-property','org.a11y.Bus',
        '/org/a11y/bus','org.a11y.Status','IsEnabled'],{
          timeout:2000,maxBuffer:2048,encoding:'utf8',env
        });
    });
    const value=await call();
    if(value?.stdout?.trim()==='b true')
      return result('AT_SPI_SESSION_BUS_ENABLED_TARGET_UNVERIFIED',true);
    if(value?.stdout?.trim()==='b false')return result('AT_SPI_SESSION_BUS_DISABLED',false);
  }catch{/* no proof on bus error */}
  return result('AT_SPI_SESSION_BUS_UNAVAILABLE',false);
}
// Browser helper availability != an active, owned, authorized browser lease.
export function classifyOwnedBrowserStatus(status){
  const base={providerId:'commander-owned-browser',ready:false,scope:'CURRENT_HOST',
    ownerSession:false,sessionBusReady:false};
  if(status?.source==='CONTROLLER_MEMORY'&&status.ok===true&&status.active===false)
    return Object.freeze({...base,status:'BROWSER_NO_ACTIVE_OWNER_LEASE'});
  if(!validObject(status)||status.ok!==true||status.enabled!==true||
     status.available!==true)return Object.freeze({...base,status:'BROWSER_HELPER_UNAVAILABLE'});
  if(status.uncertain===true||status.sessionResetRequired===true)
    return Object.freeze({...base,status:'BROWSER_OUTCOME_RECONCILIATION_REQUIRED'});
  if(status.active===true&&status.leased===true&&status.backgroundOnly===true&&
     status.userDesktopTouched===false)
    return Object.freeze({...base,status:'BROWSER_SESSION_EXISTS_OWNER_LEASE_REQUIRED'});
  return Object.freeze({...base,status:'BROWSER_AVAILABLE_IDLE'});
}

export function verifyBoundOwnerTargetReceipt({
 receipt,providerId,target,selector,ownerPrincipal,nowMs=Date.now()
}={}){
 const blocked=reason=>Object.freeze({valid:false,reason});
 if(!validObject(receipt)||!validObject(selector)||typeof providerId!=='string'||
    !['existing-app','existing-browser'].includes(target)||
    typeof ownerPrincipal!=='string'||!(/^(?:uid:[0-9]{1,12}|sid:S-1-[0-9]+(?:-[0-9]+){2,15})$/.test(ownerPrincipal))||
    !Number.isSafeInteger(nowMs)||nowMs<0)return blocked('BOUND_TARGET_INPUT_INVALID');
 if(receipt.providerId!==providerId||receipt.target!==target||
    receipt.scope!=='CURRENT_HOST'||receipt.ownerSession!==true||
    receipt.ready!==true||receipt.ownerPrincipal!==ownerPrincipal||
    receipt.source!=='INTERNAL_OWNER_TARGET_OBSERVER')return blocked('BOUND_TARGET_IDENTITY_MISMATCH');
 if(!Number.isSafeInteger(receipt.observedAtMs)||receipt.observedAtMs>nowMs||
   nowMs-receipt.observedAtMs>15000||
   !Number.isSafeInteger(receipt.expiresAtMs)||receipt.expiresAtMs<=nowMs||
   receipt.expiresAtMs-receipt.observedAtMs>15000)
   return blocked('BOUND_TARGET_RECEIPT_STALE');
 if(target==='existing-app'||(target==='existing-browser'&&
    ['linux-atspi-native','windows-uia-native','cua-last-resort'].includes(providerId))){
   if(!Number.isSafeInteger(selector.pid)||selector.pid<1||
      !Number.isSafeInteger(selector.windowId)||selector.windowId<1||
      receipt.pid!==selector.pid||receipt.windowId!==selector.windowId)
     return blocked('BOUND_TARGET_SELECTOR_MISMATCH');
 }else{
   if(typeof selector.tabRef!=='string'||!/^[-_a-zA-Z0-9]{8,128}$/.test(selector.tabRef)||
      receipt.tabRef!==selector.tabRef)return blocked('BOUND_TARGET_SELECTOR_MISMATCH');
 }
 if(receipt.effectUncertain!==false||receipt.targetIdentityVerified!==true)
   return blocked('BOUND_TARGET_UNVERIFIED_EFFECT');
 return Object.freeze({valid:true,reason:'BOUND_TARGET_OBSERVER_MATCH',providerId,target});
}
