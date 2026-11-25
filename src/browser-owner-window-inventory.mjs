// Strictly read-only owner-session window metadata. No browser titles, tabs,
// cookies, passwords, browser storage, account identities or inferred login.
const CLASSIFIERS=Object.freeze([
  ['brave', /^(?:brave(?:[-_]browser)?)(?:\.exe)?$/i],
  ['firefox', /^(?:firefox(?:[-_]firefox)?)(?:\.exe)?$/i],
  ['chrome', /^(?:chrome|google-chrome(?:-stable)?)(?:\.exe)?$/i],
  ['edge', /^(?:msedge|microsoft-edge)(?:\.exe)?$/i],
  ['chromium', /^(?:chromium(?:-browser)?)(?:\.exe)?$/i],
  ['opera', /^(?:opera(?:-gx)?)(?:\.exe)?$/i],
  ['vivaldi', /^(?:vivaldi)(?:\.exe)?$/i],
  ['librewolf', /^(?:librewolf)(?:\.exe)?$/i]
]);
function classify(name) {
  if(typeof name!=='string'||name.length>120)return null;
  return CLASSIFIERS.find(([,re])=>re.test(name.trim()))?.[0]??null;
}
function id(value) {
  if(Number.isSafeInteger(value)&&value>0)return String(value);
  if(typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value))return value;
  return null;
}
export function summarizeOwnerBrowserWindows(windows,{maxWindows=48}={}) {
  if(!Array.isArray(windows)||windows.length>1000||!Number.isSafeInteger(maxWindows)||
    maxWindows<1||maxWindows>100)throw new TypeError('OWNER_BROWSER_WINDOW_INVENTORY_INVALID');
  const seen=new Set(),result=[];
  for(const w of windows){
    if(!w||typeof w!=='object'||Array.isArray(w))continue;
    const browser=classify(w.app_name??w.appName??w.application);
    const pid=w.pid??w.processId;
    const handle=id(w.window_id??w.windowId??w.handle);
    if(!browser||!Number.isSafeInteger(pid)||pid<1||pid>2147483647||!handle)continue;
    const key=pid+':'+handle;
    if(seen.has(key))continue;
    seen.add(key);
    if(result.length<maxWindows)result.push(Object.freeze({
      browser,pid,windowId:handle,accountState:'UNVERIFIED',
      sameOwnerNativeConsent:'NOT_ATTESTED',existingProfileAttached:false
    }));
  }
  return Object.freeze({
    windows:Object.freeze(result.sort((a,b)=>a.browser.localeCompare(b.browser)||a.pid-b.pid||
      a.windowId.localeCompare(b.windowId))),
    truncated:seen.size>result.length,windowCount:seen.size,
    source:'OWNER_WORKSPACE_READ_ONLY',titlesReturned:false,credentialsRead:false,
    authenticatedAccountsClaimed:false,preferredBrowser:null
  });
}
