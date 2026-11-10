// Syncthing's local GUI API is authenticated only after TLS peer verification.
// The GUI's public certificate is the trust anchor; no HTTP probing/fallback.
import https from 'node:https';
import {createHash, timingSafeEqual, X509Certificate} from 'node:crypto';

const ALLOWED_ROUTES=new Set([
  '/rest/noauth/health','/rest/system/status','/rest/system/version',
  '/rest/config/folders','/rest/system/connections'
]);

function loopbackAddress(value){
  const match=typeof value==='string'&&/^(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/.exec(value);
  if(!match||Number(match[2])>65535)throw new Error('Syncthing GUI requires an explicit loopback address');
  return value;
}

export function configuredLoopbackRest(xml,hostOverride){
  if(typeof xml!=='string'||xml.length>1024*1024)throw new Error('Syncthing GUI config invalid');
  const gui=[...xml.matchAll(/<gui\b([^>]*)>([\s\S]*?)<\/gui>/gi)];
  if(gui.length!==1)throw new Error('Exactly one Syncthing GUI config required');
  if(/\benabled\s*=\s*["']false["']/i.test(gui[0][1]))
    throw new Error('Syncthing GUI disabled');
  const addresses=[...gui[0][2].matchAll(/<address>([^<]*)<\/address>/gi)];
  const keys=[...gui[0][2].matchAll(/<apikey>([^<]+)<\/apikey>/gi)];
  if(addresses.length!==1||keys.length!==1)throw new Error('Syncthing GUI address/API key missing or ambiguous');
  const configured=loopbackAddress(addresses[0][1].trim());
  const effective=hostOverride===undefined?configured:loopbackAddress(hostOverride);
  return {base:'https://'+effective,apiKey:keys[0][1]};
}

// Only the fixed paths the read-only Doctor uses are reachable.
// Node sends request headers after TLS authorization, not during the handshake.
export async function fetchPinnedSyncthingJson(base,route,certificatePem,apiKey,authenticated=true){
  if(typeof base!=='string'||!base.startsWith('https://'))
    throw new Error('Pinned Syncthing HTTPS required');
  loopbackAddress(base.slice(8));
  if(!ALLOWED_ROUTES.has(route))throw new Error('Unapproved Syncthing REST route');
  if(typeof certificatePem!=='string'||certificatePem.length===0||certificatePem.length>65536)
    throw new Error('Syncthing GUI public certificate invalid');
  if(authenticated&&(typeof apiKey!=='string'||apiKey.length===0))
    throw new Error('Syncthing REST API key unavailable');
  let pinned;
  try{pinned=createHash('sha256').update(new X509Certificate(certificatePem).raw).digest();}
  catch{throw new Error('Syncthing GUI public certificate invalid');}
  return await new Promise((resolve,reject)=>{
    const req=https.get(base+route,{
      ca:certificatePem,
      rejectUnauthorized:true,
      agent:false,
      timeout:2600,
      checkServerIdentity(_host,peer){
        if(!peer?.raw)return new Error('Syncthing TLS peer certificate absent');
        const actual=createHash('sha256').update(peer.raw).digest();
        if(!timingSafeEqual(actual,pinned))
          return new Error('Syncthing TLS peer certificate mismatch');
      },
      headers:authenticated?{'X-API-Key':apiKey,Accept:'application/json'}:{Accept:'application/json'}
    },res=>{
      if(res.statusCode!==200){
        res.resume();reject(new Error('Local Syncthing HTTPS API status '+res.statusCode));return;
      }
      let json='',bytes=0;
      res.setEncoding('utf8');
      res.on('data',chunk=>{
        bytes+=Buffer.byteLength(chunk);
        if(bytes>2*1024*1024){req.destroy(new Error('Syncthing REST JSON response too large'));return;}
        json+=chunk;
      });
      res.on('end',()=>{try{resolve(JSON.parse(json));}catch{reject(new Error('Syncthing REST response JSON invalid'));}});
      res.on('error',reject);
    });
    req.on('timeout',()=>req.destroy(new Error('Syncthing HTTPS timeout')));
    req.on('error',reject);
  });
}
