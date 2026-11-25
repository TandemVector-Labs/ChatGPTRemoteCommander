// G1 private Secure MCP Tunnel: independently pins the *local* tunnel-client
// mTLS leaf, not OpenAI's direct connector CA. No socket opened on import.
// The host must additionally attest the exact running tunnel-client instance;
// neither bearer headers nor model-supplied session metadata prove transport.
import {createHash} from 'node:crypto';
import {isProxy} from 'node:util/types';

const SHA=/^[a-f0-9]{64}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CLIENT_AUTH_OID='1.3.6.1.5.5.7.3.2';
const DENIED=Object.freeze({authenticated:false});
const fail=code=>{throw Object.assign(new Error(code),{code});};

export function createV2PrivateTunnelMtlsAttestor({
  expectedClientLeafDerSha256,profileId,resolveTransportIdentity,now=Date.now
}={}){
  if(typeof expectedClientLeafDerSha256!=='string'
    ||!SHA.test(expectedClientLeafDerSha256)||typeof profileId!=='string'
    ||!ID.test(profileId)||typeof resolveTransportIdentity!=='function'
    ||typeof now!=='function')
    fail('V2_TUNNEL_MTLS_TRUSTED_BOOTSTRAP_REQUIRED');
  return async request=>{
    const socket=request?.socket;
    if(!socket||socket.encrypted!==true||socket.authorized!==true
      ||typeof socket.getPeerCertificate!=='function')return DENIED;
    let cert;
    try{cert=socket.getPeerCertificate(true);}catch{return DENIED;}
    if(!cert||!Buffer.isBuffer(cert.raw)
      ||cert.ca!==false
      ||!Array.isArray(cert.ext_key_usage)
      ||!cert.ext_key_usage.includes(CLIENT_AUTH_OID)
      ||createHash('sha256').update(cert.raw).digest('hex')!==expectedClientLeafDerSha256)
      return DENIED;
    const timestamp=now();
    const notBefore=Date.parse(cert.valid_from),notAfter=Date.parse(cert.valid_to);
    if(!Number.isSafeInteger(timestamp)||!Number.isFinite(notBefore)
      ||!Number.isFinite(notAfter)
      ||notBefore>timestamp||notAfter<=timestamp)return DENIED;
    let t;
    try{t=await resolveTransportIdentity();}catch{return DENIED;}
    const after=now();
    if(!Number.isSafeInteger(after)||after<timestamp
      ||t?.source!=='native-tunnel-attestor'
      ||t.provider!=='openai-secure-mcp-tunnel'
      ||t.profileId!==profileId
      ||typeof t.ownerSidHash!=='string'||!SHA.test(t.ownerSidHash)
      ||typeof t.tunnelIdHash!=='string'||!SHA.test(t.tunnelIdHash)
      ||t.authenticated!==true||t.controlPlanePollOk!==true
      ||t.healthzStatus!==200||t.readyzStatus!==200
      ||!Number.isSafeInteger(t.lastPollAtMs)||t.lastPollAtMs>after
      ||after-t.lastPollAtMs>120000
      ||!Number.isSafeInteger(t.expiresAtMs)||t.expiresAtMs<=after)
      return DENIED;
    return Object.freeze({
      authenticated:true,peerType:'openai-tunnel-client-mtls',
      sessionSource:'openai/session'
    });
  };
}


/**
 * PRIVATE per-(ChatGPT account, host) tunnel admission, distinct from
 * optional public OAuth / G1. This is an identity precondition only:
 * it does NOT issue an owner grant, authorize tools, or open an ingress.
 *
 * Expected hashes are loaded from owner-enrolled local configuration. The
 * current OS owner is sampled independently on both sides of each awaited
 * native tunnel observation to reject owner switches / stale pair bindings.
 */
export function createV2OwnerPinnedPrivatePairAttestor({
  expectedClientLeafDerSha256,profileId,expectedTunnelIdHash,
  expectedOwnerSidHash,resolveTransportIdentity,resolveCurrentOwnerSidHash,
  now=Date.now
}={}){
  if(typeof expectedTunnelIdHash!=='string'||!SHA.test(expectedTunnelIdHash)
    ||typeof expectedOwnerSidHash!=='string'||!SHA.test(expectedOwnerSidHash)
    ||typeof resolveTransportIdentity!=='function'
    ||typeof resolveCurrentOwnerSidHash!=='function')
    fail('V2_PRIVATE_PAIR_TRUSTED_BOOTSTRAP_REQUIRED');
  const attest=createV2PrivateTunnelMtlsAttestor({
    expectedClientLeafDerSha256,profileId,now,
    resolveTransportIdentity:async()=>{
      try{
        const before=await resolveCurrentOwnerSidHash();
        if(before!==expectedOwnerSidHash)return null;
        const observed=await resolveTransportIdentity();
        // Native sources are trusted providers, but avoid invoking accessor
        // properties or Proxy traps when checking their output.
        if(!observed||typeof observed!=='object'||Array.isArray(observed)
          ||isProxy(observed)
          ||![Object.prototype,null].includes(Object.getPrototypeOf(observed)))
          return null;
        for(const field of Reflect.ownKeys(observed)){
          if(typeof field!=='string')return null;
          const d=Object.getOwnPropertyDescriptor(observed,field);
          if(!d||!Object.hasOwn(d,'value'))return null;
        }
        const after=await resolveCurrentOwnerSidHash();
        if(after!==before||observed.tunnelIdHash!==expectedTunnelIdHash
          ||observed.ownerSidHash!==expectedOwnerSidHash)return null;
        return observed;
      }catch{return null;}
    }
  });
  return async request=>{
    const result=await attest(request);
    if(result.authenticated!==true)return result;
    // Deliberately NOT the older G1 peerType: until native J01, per-action
    // grants and revocation are wired, existing privileged ingress must deny.
    return Object.freeze({
      authenticated:true,peerType:'owner-pinned-private-tunnel-mtls',
      sessionSource:'native-owner-private-pair'
    });
  };
}
