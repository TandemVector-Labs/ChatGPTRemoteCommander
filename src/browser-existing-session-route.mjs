// Browser-neutral route planning for an *already authenticated* owner target.
// This module never attaches, reads a password database or grants its own permission.
// A trusted host must independently attest an exact owner+tab and enforce consent
// again when executing the resulting plan.
const FAMILIES=new Set(['chrome','brave','edge','chromium','firefox','vivaldi','opera','opera-gx','librewolf','other']);
const PROVIDERS=new Set(['browser-extension-owner','webdriver-bidi-native',
  'playwright-mcp','chrome-devtools-mcp','windows-uia-native',
  'linux-atspi-native','cua-last-resort']);
const validObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const VERIFIED_FIELDS=['browser','provider','tabRef','ownerPrincipal','origin','source',
  'sameOwnerSession','nativeConsentGranted','accountSessionVerified','effectUncertain',
  'observedAtMs','expiresAtMs'];
const blocked=(code,next)=>Object.freeze({
  status:'BLOCKED',code,next,provider:null,defaultBrowser:null,
  ownerSessionSelected:false,credentialsRead:false,ownedBrowserStarted:false
});
const principal=value=>typeof value==='string'&&
  (/^uid:[0-9]{1,12}$/.test(value)||/^sid:S-1-[0-9]+(?:-[0-9]+){2,15}$/.test(value));
const ref=value=>typeof value==='string'&&/^[a-zA-Z0-9:_-]{8,128}$/.test(value);
const origin=value=>{
  try{
    const parsed=new URL(value);
    return parsed.protocol==='https:'||parsed.protocol==='http:'?parsed.origin:null;
  }catch{return null;}
};
/**
 * A planner, not an authorization service. verifyReceipt MUST be wired to a trusted,
 * same-owner native broker; a public caller-provided boolean is not proof.
 *
 * A unique exact browser tab can only be selected after a trusted attestation.
 * If two candidates are equally valid, refuse to guess between user accounts.
 */
export async function planOwnerBrowserRoute({
  requestedOrigin,ownerPrincipal,ownerSession=false,receipts=[],
  verifyReceipt=async()=>false,nowMs=Date.now(),allowOwnedFallback=false
}={}){
  const targetOrigin=origin(requestedOrigin);
  if(!targetOrigin||!principal(ownerPrincipal)||!Array.isArray(receipts)||
    receipts.length>64||typeof verifyReceipt!=='function'||
    !Number.isSafeInteger(nowMs)||nowMs<0||
    typeof allowOwnedFallback!=='boolean')
    throw new TypeError('BROWSER_OWNER_ROUTE_INVALID_INPUT');
  if(ownerSession!==true)
    return blocked('OWNER_SESSION_REQUIRED','Use a verified owning desktop session');
  const verificationStart=performance.now();
  const matches=[];
  for(const receipt of receipts){
    if(!validObject(receipt)||!FAMILIES.has(receipt.browser)||
      !PROVIDERS.has(receipt.provider)||!ref(receipt.tabRef)||
      receipt.ownerPrincipal!==ownerPrincipal||receipt.origin!==targetOrigin||
      receipt.source!=='INTERNAL_OWNER_TARGET_OBSERVER'||
      receipt.sameOwnerSession!==true||receipt.nativeConsentGranted!==true||
      receipt.accountSessionVerified!==true||receipt.effectUncertain!==false||
      !Number.isSafeInteger(receipt.observedAtMs)||receipt.observedAtMs>nowMs||
      nowMs-receipt.observedAtMs>15000||
      !Number.isSafeInteger(receipt.expiresAtMs)||receipt.expiresAtMs<=nowMs||
      receipt.expiresAtMs-receipt.observedAtMs>15000)continue;
    // Preserve the exact identity/consent fields that were checked. The async
    // verifier receives the original receipt, which must not be allowed to
    // replace the tab, origin or consent while its promise is pending.
    const checked=Object.fromEntries(VERIFIED_FIELDS.map(key=>[key,receipt[key]]));
    let trusted=false;
    try{trusted=await verifyReceipt(receipt)===true;}catch{/* unverified never becomes selected */}
    if(!trusted||VERIFIED_FIELDS.some(key=>receipt[key]!==checked[key]))continue;
    const afterVerification=nowMs+Math.max(0,Math.ceil(performance.now()-verificationStart));
    if(checked.expiresAtMs<=afterVerification||
       afterVerification-checked.observedAtMs>15000)continue;
    matches.push(Object.freeze(checked));
  }
  if(matches.length>1){
    return blocked('MULTIPLE_AUTHORIZED_OWNER_TABS',
      'Choose an exact intended account/tab; never guess between signed-in sessions');
  }
  if(matches.length===1){
    const selected=matches[0];
    // A later verifier may have consumed the remaining consent TTL.
    const atSelection=nowMs+Math.max(0,Math.ceil(performance.now()-verificationStart));
    if(selected.expiresAtMs<=atSelection||
       atSelection-selected.observedAtMs>15000)
      return blocked('EXISTING_OWNER_SESSION_NOT_ATTESTED',
        'Owner tab receipt expired during verification; obtain fresh native consent');
    return Object.freeze({status:'READY',code:'EXACT_OWNER_TAB_VERIFIED',
      browser:selected.browser,provider:selected.provider,tabRef:selected.tabRef,
      observedAtMs:selected.observedAtMs,expiresAtMs:selected.expiresAtMs,
      ownerSessionSelected:true,defaultBrowser:null,
      credentialsRead:false,ownedBrowserStarted:false,
      requiresExecutionReverification:true});
  }
  if(allowOwnedFallback===true)
    return Object.freeze({...blocked('EXPLICIT_OWNED_FALLBACK_ONLY',
      'No verified signed-in owner session; caller explicitly chose a new isolated browser'),
      ownedFallbackAllowed:true});
  return blocked('EXISTING_OWNER_SESSION_NOT_ATTESTED',
    'Discover exact owner browser windows, obtain browser-native consent, verify account state and retry; never use an implicit Chromium fallback');
}
