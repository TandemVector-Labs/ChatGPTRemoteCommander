import {createHash,timingSafeEqual,X509Certificate} from 'node:crypto';
import https from 'node:https';
// Validate Syncthing's authenticated local REST identity without child processes.
export function verifySyncthingDaemon(status,version,expectedId){
 if(typeof expectedId!=='string'||!/^[A-Z2-7]{7}(?:-[A-Z2-7]{7}){7}$/.test(expectedId))
  throw new Error('Expected device ID invalid');
 if(!status||status.myID!==expectedId)throw new Error('Daemon identity mismatch');
 const release=version?.version;
 if(typeof release!=='string'||!/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(release))
  throw new Error('Daemon version invalid');
 return 'syncthing '+release;
}


// Bind the REST destination and API key to the same local Syncthing GUI config.
// The unauthenticated /rest/noauth/health response is never destination authority.
export function configuredLoopbackRest(xml,runtimeAddress){
 if(typeof xml!=='string')throw new Error('Syncthing GUI config unavailable');
 const gui=[...xml.matchAll(/<gui\b([^>]*)>([\s\S]*?)<\/gui>/gi)];
 if(gui.length!==1)throw new Error('Exactly one Syncthing GUI config required');
 const attrs=gui[0][1],body=gui[0][2];
 if(/\benabled\s*=\s*["']false["']/i.test(attrs))throw new Error('Syncthing GUI is disabled');
 // HTTPS is available even when the Syncthing GUI does not force TLS.
 // The client always uses a pinned HTTPS certificate and never falls back to HTTP.
 const addresses=[...body.matchAll(/<address>([^<]*)<\/address>/gi)];
 const keys=[...body.matchAll(/<apikey>([^<]+)<\/apikey>/gi)];
 if(addresses.length!==1||keys.length!==1)throw new Error('Syncthing GUI address/API key missing or ambiguous');
 const declaredAddress=addresses[0][1].trim();
 const effectiveAddress=runtimeAddress===undefined?declaredAddress:runtimeAddress;
 // An explicit, host-pinned Syncthing CLI GUI override may differ from config.xml.
 // Validate BOTH addresses, never probe a health endpoint to choose a destination.
 for(const addr of [declaredAddress,effectiveAddress]){
  const match=typeof addr==='string'&&/^(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/.exec(addr);
  if(!match||Number(match[2])>65535)throw new Error('Syncthing GUI address must be an explicit loopback IP and valid port');
 }
 return {base:'https://'+effectiveAddress,apiKey:keys[0][1]};
}


// Optional pilot peer is accepted only when its full ID matches a pinned digest.
// This permits topology growth without publishing a participant's raw device ID.
export function pinnedOptionalDevice(devices,name,digest){
 if(!Array.isArray(devices)||typeof name!=='string'||!name||
    typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))
  throw new Error('Optional peer trust configuration invalid');
 const matches=devices.filter(d=>d?.name===name);
 if(matches.length===0)return null;
 if(matches.length!==1)throw new Error('Optional peer name ambiguous');
 const id=matches[0].deviceID;
 if(typeof id!=='string'||!/^[A-Z2-7]{7}(?:-[A-Z2-7]{7}){7}$/.test(id))
  throw new Error('Optional peer device ID malformed');
 const actual=createHash('sha256').update(id,'utf8').digest();
 if(!timingSafeEqual(actual,Buffer.from(digest,'hex')))
  throw new Error('Optional peer identity is not pinned');
 return id;
}


const ALLOWED_LOCAL_REST_PATHS=new Set([
 '/rest/noauth/health','/rest/system/status','/rest/system/version',
 '/rest/config/devices','/rest/config/folders','/rest/system/connections'
]);

// Use the Syncthing GUI public certificate as the exact HTTPS trust anchor.
// If the daemon is replaced on its loopback port, reject the TLS handshake
// BEFORE sending X-API-Key. Never disable certificate verification or use HTTP.
export async function fetchPinnedSyncthingJson(base,route,certificatePem,apiKey,authenticated=true){
 const match=typeof base==='string' && /^https:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/.exec(base);
 if(!match||Number(match[2])>65535)throw new Error('Pinned Syncthing HTTPS requires explicit loopback address');
 if(!ALLOWED_LOCAL_REST_PATHS.has(route))throw new Error('Unapproved local Syncthing REST route');
 if(typeof certificatePem!=='string'||certificatePem.length>65536)throw new Error('Syncthing GUI public certificate unavailable');
 if(authenticated&&(typeof apiKey!=='string'||!apiKey))throw new Error('Syncthing REST API key unavailable');
 let pinned;
 try{pinned=createHash('sha256').update(new X509Certificate(certificatePem).raw).digest();}
 catch{throw new Error('Syncthing GUI public certificate invalid');}
 return await new Promise((resolve,reject)=>{
  const req=https.get(base+route,{
   ca:certificatePem,rejectUnauthorized:true,agent:false,timeout:2600,
   checkServerIdentity(_host,peer){
    if(!peer?.raw)return new Error('Syncthing GUI TLS peer certificate absent');
    const actual=createHash('sha256').update(peer.raw).digest();
    if(actual.length!==pinned.length||!timingSafeEqual(actual,pinned))
     return new Error('Syncthing GUI TLS peer certificate mismatch');
   },
   headers:authenticated?{'X-API-Key':apiKey,Accept:'application/json'}:{Accept:'application/json'}
  },res=>{
   if(res.statusCode!==200){
    res.resume();
    reject(new Error('Local HTTPS API status '+res.statusCode));
    return;
   }
   let body='',bytes=0;
   res.setEncoding('utf8');
   res.on('data',chunk=>{
    bytes+=Buffer.byteLength(chunk);
    if(bytes>2*1024*1024){req.destroy(new Error('Syncthing REST JSON response too large'));return;}
    body+=chunk;
   });
   res.on('end',()=>{
    try{resolve(JSON.parse(body));}
    catch{reject(new Error('Syncthing REST response JSON invalid'));}
   });
   res.on('error',reject);
  });
  req.on('timeout',()=>req.destroy(new Error('Syncthing HTTPS request timed out')));
  req.on('error',reject);
 });
}
