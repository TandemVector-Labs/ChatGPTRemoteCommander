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
