// V2-G2: owner-process-only, short-lived ChatGPT conversation to OS seat binding.
// The OS owner identity is read independently on every admission and is never
// accepted from platform proof, HTTP/MCP input, model arguments or browser data.
// This table is deliberately non-durable: restart requires fresh native owner
// attestation and consent. It does not replace OAuth, V2GrantRegistry or leases.
import { randomBytes } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { normalizeV2Route } from './v2-routing-contract.mjs';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH=/^[a-f0-9]{64}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const valid=v=>typeof v==='string'&&ID.test(v)&&v!=='.'&&v!=='..';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function exactPlatformSession(value){
  const fields=['source','sessionHandle','tokenSha256'];
  if(value===null||typeof value!=='object'||Array.isArray(value)||isProxy(value)
    ||Object.getPrototypeOf(value)!==Object.prototype
    ||Reflect.ownKeys(value).length!==fields.length)
    fail('V2_SESSION_PLATFORM_ATTESTATION_REQUIRED');
  const out=Object.create(null);
  for(const field of fields){
    const descriptor=Object.getOwnPropertyDescriptor(value,field);
    if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))
      fail('V2_SESSION_PLATFORM_ATTESTATION_REQUIRED');
    out[field]=descriptor.value;
  }
  if(out.source!=='native-platform-session'||!valid(out.sessionHandle)
    ||typeof out.tokenSha256!=='string'||!HASH.test(out.tokenSha256))
    fail('V2_SESSION_PLATFORM_ATTESTATION_REQUIRED');
  return Object.freeze(out);
}

export function createV2NativeOwnerSessionBindings({
  attestPlatformSession,resolveOwnerRoute,observedNativeSession,
  resolveOwnerSidHash,authorizeBinding,authorizeRevocation,now=Date.now,
  ttlMs=300000,maxBindings=256
}={}){
  if([attestPlatformSession,resolveOwnerRoute,observedNativeSession,
      resolveOwnerSidHash,authorizeBinding,authorizeRevocation,now]
      .some(v=>typeof v!=='function')
    ||!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>3600000
    ||!Number.isSafeInteger(maxBindings)||maxBindings<1||maxBindings>10000)
    fail('V2_SESSION_OWNER_BOOTSTRAP_REQUIRED');
  const active=new Map();
  function timestamp(){
    const t=now();
    if(!Number.isSafeInteger(t)||t<0)fail('V2_SESSION_CLOCK_INVALID');
    return t;
  }
  async function trustedState(handle){
    // Read identity on both sides of the route/seat observation. A user switch
    // during any awaited lookup invalidates the entire native snapshot.
    const ownerBefore=await resolveOwnerSidHash();
    if(typeof ownerBefore!=='string'||!HASH.test(ownerBefore))
      fail('V2_SESSION_OWNER_IDENTITY_REQUIRED');
    const route=normalizeV2Route(await resolveOwnerRoute(handle));
    const seat=await observedNativeSession(route);
    if(!valid(seat))fail('V2_SESSION_NATIVE_SEAT_REQUIRED');
    const ownerAfter=await resolveOwnerSidHash();
    if(ownerAfter!==ownerBefore)fail('V2_SESSION_OWNER_CHANGED');
    return Object.freeze({route,seat,ownerSidHash:ownerBefore});
  }
  function expire(handle,record,t){
    if(record.expiresAtMs<=t){
      if(active.get(handle)===record)active.delete(handle);
      fail('V2_SESSION_BINDING_EXPIRED');
    }
  }
  async function current(handle){
    if(!valid(handle))fail('V2_SESSION_HANDLE_REQUIRED');
    const record=active.get(handle);
    if(!record)fail('V2_SESSION_NOT_BOUND');
    expire(handle,record,timestamp());
    let observed;
    try{observed=await trustedState(handle);}
    catch{
      if(active.get(handle)===record)active.delete(handle);
      fail('V2_SESSION_TRUST_LOST');
    }
    if(active.get(handle)!==record)fail('V2_SESSION_BINDING_REVOKED');
    expire(handle,record,timestamp());
    if(!same(observed.route,record.route)||observed.seat!==record.seat
      ||observed.ownerSidHash!==record.ownerSidHash){
      active.delete(handle);
      fail('V2_SESSION_TRUST_LOST');
    }
    return Object.freeze({record,observed});
  }
  function ownerContext(record){
    const route=record.route;
    return Object.freeze({
      source:'native-owner-attested',hostId:route.hostId,profileId:route.profileId,
      principalId:route.principalId,conversationId:route.conversationId,
      bindingId:record.bindingId,ownerSidHash:record.ownerSidHash,
      expiresAtMs:record.expiresAtMs
    });
  }
  return Object.freeze({
    async bindTrusted(platformProof){
      // The platform adapter authenticates the transport/session handle.
      // It does not supply the OS owner identity or the binding epoch.
      const platform=exactPlatformSession(await attestPlatformSession(platformProof));
      const handle=platform.sessionHandle,tokenSha256=platform.tokenSha256;
      const first=await trustedState(handle),start=timestamp();
      for(const [existingHandle,existing] of active){
        if(existing.tokenSha256===tokenSha256&&existing.expiresAtMs>start)
          fail('V2_SESSION_TOKEN_BINDING_EXISTS');
        if(existing.expiresAtMs<=start)active.delete(existingHandle);
      }
      if(active.has(handle)){
        const existing=active.get(handle);
        if(existing.expiresAtMs>start)fail('V2_SESSION_BINDING_EXISTS');
        active.delete(handle);
      }
      const bindingId=randomBytes(32).toString('hex');
      const approved=await authorizeBinding(Object.freeze({
        sessionHandle:handle,tokenSha256,route:first.route,osSessionId:first.seat,
        ownerSidHash:first.ownerSidHash,bindingId
      }));
      if(approved!==true)fail('V2_SESSION_OWNER_CONSENT_REQUIRED');
      // Owner, route and seat must still match after native consent returns.
      const second=await trustedState(handle),end=timestamp();
      if(!same(first.route,second.route)||first.seat!==second.seat
        ||first.ownerSidHash!==second.ownerSidHash)
        fail('V2_SESSION_BINDING_CHANGED_DURING_CONSENT');
      for(const [oldHandle,oldRecord] of active)
        if(oldRecord.expiresAtMs<=end)active.delete(oldHandle);
      // Consent is asynchronous: another distinct session may have completed
      // a binding for this same bearer while this owner prompt was open.
      // Enforce digest uniqueness again at the commit point, not only before
      // asking for consent, so a bearer cannot resolve ambiguously.
      for(const [otherHandle,otherRecord] of active)
        if(otherHandle!==handle&&otherRecord.tokenSha256===tokenSha256
          &&otherRecord.expiresAtMs>end)
          fail('V2_SESSION_TOKEN_BINDING_EXISTS');
      if(active.has(handle))fail('V2_SESSION_BINDING_EXISTS');
      if(active.size>=maxBindings)fail('V2_SESSION_CAPACITY_REACHED');
      if(!Number.isSafeInteger(end+ttlMs))fail('V2_SESSION_CLOCK_INVALID');
      const record=Object.freeze({
        route:second.route,seat:second.seat,ownerSidHash:second.ownerSidHash,
        tokenSha256,bindingId,expiresAtMs:end+ttlMs
      });
      active.set(handle,record);
      return Object.freeze({
        sessionHandle:handle,tokenSha256,bindingId,ownerSidHash:record.ownerSidHash,
        expiresAtMs:record.expiresAtMs
      });
    },
    async resolveAttestedTokenBinding(tokenSha256){
      if(typeof tokenSha256!=='string'||!HASH.test(tokenSha256))return null;
      const candidates=[...active.entries()].filter(([,record])=>
        record.tokenSha256===tokenSha256);
      if(candidates.length!==1)return null;
      const [sessionHandle,expected]=candidates[0];
      try{
        const {record}=await current(sessionHandle);
        if(record!==expected||record.tokenSha256!==tokenSha256)return null;
        return Object.freeze({
          source:'native-owner-attested',tokenSha256,sessionHandle,
          bindingId:record.bindingId,ownerSidHash:record.ownerSidHash,
          expiresAtMs:record.expiresAtMs
        });
      }catch{return null;}
    },
    async resolveNativeOwnerContext(sessionHandle){
      const {record}=await current(sessionHandle);
      return ownerContext(record);
    },
    async resolveNativeRoute(sessionHandle){
      const {record}=await current(sessionHandle);
      return record.route;
    },
    async revokeTrusted({sessionHandle,adminProof}={}){
      const {record}=await current(sessionHandle);
      const approved=await authorizeRevocation(Object.freeze({
        sessionHandle,route:record.route,osSessionId:record.seat,
        ownerSidHash:record.ownerSidHash,bindingId:record.bindingId,adminProof
      }));
      if(approved!==true)fail('V2_SESSION_REVOKE_AUTH_REQUIRED');
      const latest=await trustedState(sessionHandle);
      if(active.get(sessionHandle)!==record||!same(latest.route,record.route)
        ||latest.seat!==record.seat||latest.ownerSidHash!==record.ownerSidHash)
        fail('V2_SESSION_BINDING_CHANGED');
      active.delete(sessionHandle);
      return true;
    },
    get size(){return active.size;},
    close(){active.clear();}
  });
}
