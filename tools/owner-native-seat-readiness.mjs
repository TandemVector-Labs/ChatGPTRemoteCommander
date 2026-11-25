// Exact installed OS owner/session J01 readiness only: no consent prompt, tunnel,
 // grant, key, service mutation or ChatGPT identity assertion.
import {createWindowsNativeOwnerSessionProvider} from '../src/native-owner-session-provider-windows.mjs';
import {createLinuxNativeOwnerSessionProvider} from '../src/native-owner-session-provider-linux.mjs';
const fn=process.platform==='win32'?createWindowsNativeOwnerSessionProvider:
  process.platform==='linux'?createLinuxNativeOwnerSessionProvider:null;
if(!fn){console.error('RC012_OWNER_NATIVE_SEAT_UNSUPPORTED');process.exit(2);}
const route={hostId:'owner-host',profileId:'default',principalId:'owner-pair',
  conversationId:'owner-pair-local-readiness',operationId:'readiness-probe',
  target:{kind:'workflow-root',id:'owner-readiness'}};
try{
 const provider=fn();
 const owner=await provider.resolveOwnerSidHash();
 if(!/^[0-9a-f]{64}$/.test(owner))throw Error('OWNER_HASH_INVALID');
 const seat=await provider.observedNativeSession(route);
 if(typeof seat!=='string'||!seat)throw Error('OWNER_SEAT_INVALID');
 console.log(JSON.stringify({result:'RC012_NATIVE_OWNER_SEAT_READINESS_PASS',
   platform:process.platform,ownerSidHashPresent:true,
   seatPresent:true,ownerConsentRequested:false,workerGrantIssued:false,
   fullAccessConfirmed:false,configuredOnly:false}));
}catch(e){
 console.error('RC012_NATIVE_OWNER_SEAT_READINESS_BLOCKED '+String(e?.code||e?.message||'UNAVAILABLE').slice(0,160));
 process.exitCode=2;
}
