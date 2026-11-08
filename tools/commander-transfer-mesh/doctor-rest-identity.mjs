import {createHash,timingSafeEqual} from 'node:crypto';
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
 if(/\btls\s*=\s*["']true["']/i.test(attrs))throw new Error('Syncthing GUI TLS requires a verified HTTPS client');
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
 return {base:'http://'+effectiveAddress,apiKey:keys[0][1]};
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
