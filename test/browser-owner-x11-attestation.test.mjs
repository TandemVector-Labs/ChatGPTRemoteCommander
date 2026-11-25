import test from 'node:test';import assert from 'node:assert/strict';
import {probeLinuxX11OwnerBrowser} from '../src/browser-owner-x11-attestation.mjs';
import {verifyBoundOwnerTargetReceipt} from '../src/hybrid-capability-discovery.mjs';
const env={XDG_SESSION_TYPE:'x11',DISPLAY:':0',XAUTHORITY:'/tmp/owner-auth'};
const out=(pid=6061,klass='firefox_firefox',title='ChatGPT - Mozilla Firefox')=>
 '_NET_WM_PID(CARDINAL) = '+pid+'\nWM_CLASS(STRING) = "Navigator", "'+klass+
 '"\n_NET_WM_NAME(UTF8_STRING) = "'+title+'"\n';
const base={platform:'linux',env,ownerSession:true,pid:6061,windowId:81788951,
 browserFamily:'firefox',userId:()=>1000,fileStat:async()=>({uid:1000}),
 runXprop:async()=>({stdout:out()}),
 readSnapshot:async()=>({ok:true,valuesRead:false,controls:[{name:'New chat'}]})};
test('attests exact same-owner browser with nontransferable PID/HWND scoped receipt',async()=>{
 const r=await probeLinuxX11OwnerBrowser(base);
 assert.equal(r.ready,true);assert.equal(r.ownerPrincipal,'uid:1000');
 assert.equal(verifyBoundOwnerTargetReceipt({receipt:r,providerId:'linux-atspi-native',
  target:'existing-browser',selector:{pid:6061,windowId:81788951},ownerPrincipal:'uid:1000'}).valid,true);
 assert.equal(verifyBoundOwnerTargetReceipt({receipt:r,providerId:'linux-atspi-native',
  target:'existing-browser',selector:{pid:6061,windowId:81788952},ownerPrincipal:'uid:1000'}).valid,false);
});
test('fails closed on Wayland, wrong browser, different PID, UID, or empty accessible tree',async()=>{
 for(const mod of [
  {env:{...env,XDG_SESSION_TYPE:'wayland'}},{ownerSession:false},{browserFamily:'brave'},
  {runXprop:async()=>({stdout:out(6062)})},{fileStat:async()=>({uid:1001})},
  {readSnapshot:async()=>({ok:true,valuesRead:false,controls:[]})},
  {readSnapshot:async()=>({ok:true,valuesRead:true,controls:[{}]})}
 ])assert.equal((await probeLinuxX11OwnerBrowser({...base,...mod})).ready,false);
});
test('browser title changed during observation invalidates exact-owner receipt',async()=>{
 let i=0;const r=await probeLinuxX11OwnerBrowser({...base,
  runXprop:async()=>({stdout:out(6061,'firefox_firefox',++i===1?'ChatGPT - Mozilla Firefox':'Other tab - Mozilla Firefox')})});
 assert.equal(r.ready,false);assert.equal(r.status,'BROWSER_NATIVE_TARGET_CHANGED_DURING_PROBE');
});
