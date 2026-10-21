import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {X509Certificate} from 'node:crypto';

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


// A configured loopback listener and public /noauth/health response are not
// identity proofs. Never write any Syncthing API key before pinned TLS confirms
// the remote endpoint owns the HTTPS certificate in the operator-owned state.
const allowlistedRoutes=new Set([
 '/rest/noauth/health','/rest/system/status','/rest/system/version',
 '/rest/config/folders','/rest/system/connections'
]);
export async function pinnedSyncthingJson(stateRoot,base,apiKey,endpoint,authenticated=true){
 if(!allowlistedRoutes.has(endpoint))throw Error('Syncthing REST route not allowlisted');
 if(authenticated&&endpoint==='/rest/noauth/health')throw Error('Health must omit API key');
 const match=/^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/.exec(base);
 if(!match||Number(match[2])>65535)throw Error('Syncthing REST endpoint not explicit loopback');
 const certPath=path.join(stateRoot,'state','https-cert.pem');
 let cert,st;
 try{
  st=fs.lstatSync(certPath);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size<100||st.size>32768)
    throw Error('unsafe certificate entry');
  cert=fs.readFileSync(certPath);
 }catch{throw Error('Syncthing HTTPS identity certificate unavailable or unsafe');}
 let fingerprint;
 try{fingerprint=new X509Certificate(cert).fingerprint256;}
 catch{throw Error('Syncthing HTTPS identity certificate invalid');}
 const hostname=match[1]==='127.0.0.1'?'127.0.0.1':'::1';
 const port=Number(match[2]);
 return await new Promise((resolve,reject)=>{
  const request=https.request({
   hostname,port,path:endpoint,method:'GET',agent:false,
   ca:cert,rejectUnauthorized:true,
   checkServerIdentity:(_host,peer)=>peer.fingerprint256===fingerprint
    ?undefined:new Error('Syncthing HTTPS certificate identity mismatch'),
   headers:authenticated?{'X-API-Key':apiKey}:{},
   timeout:2600
  },response=>{
   if(response.statusCode!==200){response.resume();reject(Error('Local API HTTP '+response.statusCode));return;}
   const chunks=[];let count=0;
   response.on('data',part=>{
    count+=part.length;
    if(count>262144){response.destroy(Error('Syncthing REST response too large'));return;}
    chunks.push(part);
   });
   response.on('error',reject);
   response.on('end',()=>{
    try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
    catch{reject(Error('Syncthing REST JSON invalid'));}
   });
  });
  request.on('timeout',()=>request.destroy(Error('Syncthing REST request timed out')));
  request.on('error',reject);
  request.end();
 });
}
