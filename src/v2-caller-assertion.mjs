// V2-G1: verify a caller assertion from a separately trusted identity provider.
// This file DOES NOT issue credentials or attest the provenance of ChatGPT IDs.
// The issuer must independently authenticate the user, native OS session, and
// conversation; ordinary MCP headers, bodies, handles and URL parameters are
// never a trusted issuer. Do not wire into unauthenticated legacy HTTP.
import { verify, sign, KeyObject, createHash, randomUUID } from 'node:crypto';
import { normalizeV2Route } from './v2-routing-contract.mjs';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CLAIM_FIELDS=Object.freeze([
  'issuer','audience','hostId','principalId','profileId','conversationId',
  'operationId','targetKind','targetId','osSessionId','tool','argumentsHash',
  'issuedAtMs','expiresAtMs','nonce'
]);
const ENVELOPE_FIELDS=Object.freeze(['schema','keyId','claims','signature']);
const MAX_LIFETIME_MS=120000;
const TOOL=/^[a-z][a-z0-9_]{0,79}$/;
const DIGEST=/^[a-f0-9]{64}$/;
function fail(code){throw Object.assign(new Error(code),{code});}
function own(value,names,code){
  if(!value||typeof value!=='object'||Array.isArray(value)
    ||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(code);
  const keys=Object.keys(value);
  if(keys.length!==names.length||keys.some(k=>!names.includes(k)))fail(code);
}
function safe(value){return typeof value==='string'&&ID.test(value)&&value!=='.'&&value!=='..';}
function canonical(value,seen=new WeakSet(),depth=0){
  if(depth>24)fail('V2_ASSERTION_ARGUMENTS_INVALID');
  if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
  if(typeof value==='number'){
    if(!Number.isFinite(value))fail('V2_ASSERTION_ARGUMENTS_INVALID');
    return JSON.stringify(value);
  }
  if(typeof value!=='object'||seen.has(value))fail('V2_ASSERTION_ARGUMENTS_INVALID');
  const proto=Object.getPrototypeOf(value);
  if(!Array.isArray(value)&&proto!==Object.prototype&&proto!==null)fail('V2_ASSERTION_ARGUMENTS_INVALID');
  seen.add(value);
  let out;
  if(Array.isArray(value)){
    if(value.length>5000||Object.keys(value).length!==value.length)fail('V2_ASSERTION_ARGUMENTS_INVALID');
    out='['+value.map(v=>canonical(v,seen,depth+1)).join(',')+']';
  }else{
    const keys=Object.keys(value).sort();
    if(keys.length>5000)fail('V2_ASSERTION_ARGUMENTS_INVALID');
    out='{'+keys.map(key=>{
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(!descriptor||!('value' in descriptor)||['__proto__','constructor','prototype'].includes(key))
        fail('V2_ASSERTION_ARGUMENTS_INVALID');
      return JSON.stringify(key)+':'+canonical(descriptor.value,seen,depth+1);
    }).join(',')+'}';
  }
  seen.delete(value);
  return out;
}
/** Hash the precise action, not just its workflow ID; never sign raw tokens. */
export function v2ActionDigest(tool,args){
  if(typeof tool!=='string'||!TOOL.test(tool))fail('V2_ASSERTION_ACTION_INVALID');
  if(!args||typeof args!=='object'||Array.isArray(args)
    ||![Object.prototype,null].includes(Object.getPrototypeOf(args)))fail('V2_ASSERTION_ARGUMENTS_INVALID');
  const payload=canonical(args);
  if(Buffer.byteLength(payload,'utf8')>256*1024)fail('V2_ASSERTION_ARGUMENTS_INVALID');
  return createHash('sha256').update(JSON.stringify([2,tool,payload])).digest('hex');
}
function serialize(keyId,claims){
  // Revision 2 signature includes exact tool/arguments digest.
  return Buffer.from(JSON.stringify([2,keyId,...CLAIM_FIELDS.map(key=>claims[key])]),'utf8');
}
function signatureBytes(value){
  if(typeof value!=='string'||value.length!==86||!/^[A-Za-z0-9_-]{85}[AQgw]$/.test(value))fail('V2_ASSERTION_SIGNATURE_INVALID');
  const bytes=Buffer.from(value,'base64url');
  if(bytes.length!==64||bytes.toString('base64url')!==value)fail('V2_ASSERTION_SIGNATURE_INVALID');
  return bytes;
}
export function verifyV2CallerAssertion({route,assertion,trust,tool,args,nowMs=Date.now()}){
  const r=normalizeV2Route(route);
  if(!trust||typeof trust!=='object'||!safe(trust.issuer)||!safe(trust.audience)
    ||!(trust.publicKeys instanceof Map))fail('V2_ASSERTION_TRUST_REQUIRED');
  own(assertion,ENVELOPE_FIELDS,'V2_ASSERTION_INVALID');
  if(assertion.schema!==2||!safe(assertion.keyId))fail('V2_ASSERTION_INVALID');
  own(assertion.claims,CLAIM_FIELDS,'V2_ASSERTION_CLAIMS_INVALID');
  const c=assertion.claims;
  for(const name of CLAIM_FIELDS.slice(0,11).concat(['nonce'])){
    if(!safe(c[name]))fail('V2_ASSERTION_CLAIMS_INVALID');
  }
  if(!DIGEST.test(c.argumentsHash)||c.tool!==tool||c.argumentsHash!==v2ActionDigest(tool,args))
    fail('V2_ASSERTION_ACTION_MISMATCH');
  if(!Number.isSafeInteger(c.issuedAtMs)||!Number.isSafeInteger(c.expiresAtMs)
    ||!Number.isSafeInteger(nowMs)||c.expiresAtMs<=c.issuedAtMs
    ||c.expiresAtMs-c.issuedAtMs>MAX_LIFETIME_MS
    ||c.issuedAtMs>nowMs||c.expiresAtMs<=nowMs)fail('V2_ASSERTION_EXPIRED_OR_INVALID_TIME');
  if(c.issuer!==trust.issuer||c.audience!==trust.audience)fail('V2_ASSERTION_WRONG_ISSUER_OR_AUDIENCE');
  const publicKey=trust.publicKeys.get(assertion.keyId);
  if(!(publicKey instanceof KeyObject)||publicKey.type!=='public'
     ||publicKey.asymmetricKeyType!=='ed25519')fail('V2_ASSERTION_TRUSTED_KEY_REQUIRED');
  const signed=serialize(assertion.keyId,c);
  if(!verify(null,signed,publicKey,signatureBytes(assertion.signature)))fail('V2_ASSERTION_BAD_SIGNATURE');
  for(const key of ['hostId','principalId','profileId','conversationId','operationId']){
    if(c[key]!==r[key])fail('V2_ASSERTION_ROUTE_MISMATCH');
  }
  if(c.targetKind!==r.target.kind||c.targetId!==r.target.id)fail('V2_ASSERTION_ROUTE_MISMATCH');
  return Object.freeze({
    hostId:c.hostId,principalId:c.principalId,
    profileId:c.profileId,conversationId:c.conversationId,
    osSessionId:c.osSessionId
  });
}
/**
 * Only a native owner-service constructs this function; its argument sources
 * MUST be trusted. It checks expiry and native session on EVERY invocation,
 * including Gateway's pre-dispatch check (no cached positive result).
 */
export function createV2VerifiedObservedCaller({
  route,assertion,trust,tool,args,observedNativeSession,now=Date.now
}){
  const r=normalizeV2Route(route);
  if(typeof observedNativeSession!=='function'||typeof now!=='function')fail('V2_ASSERTION_NATIVE_OBSERVER_REQUIRED');
  return async()=>{
    const caller=verifyV2CallerAssertion({route:r,assertion,trust,tool,args,nowMs:now()});
    const actual=await observedNativeSession();
    if(!safe(actual)||actual!==caller.osSessionId)fail('V2_ASSERTION_NATIVE_SESSION_MISMATCH');
    return Object.freeze({
      hostId:caller.hostId,principalId:caller.principalId,
      profileId:caller.profileId,conversationId:caller.conversationId
    });
  };
}

/**
 * Owner-worker-only producer for the exact assertion that the V2 verifier
 * already consumes. Never export an RPC tool or expose this private-key
 * capability to the MCP dispatcher or the HTTP request. The resolver must
 * read an independently attested session-to-route map owned by the host,
 * not route information from tool arguments, chat text or HTTP headers.
 *
 * The authorizeIssue callback must positively authenticate the native owner
 * and its consent for this session/route/action before any signature exists.
 * OAuth user validation and grant checks remain separate mandatory gates.
 */
export function createV2NativeOwnerAssertionIssuer({
  issuer,audience,keyId,privateKey,resolveNativeRoute,observedNativeSession,
  authorizeIssue,now=Date.now,nonce=randomUUID,ttlMs=30000
}={}){
  if(!safe(issuer)||!safe(audience)||!safe(keyId)
    ||!(privateKey instanceof KeyObject)||privateKey.type!=='private'
    ||privateKey.asymmetricKeyType!=='ed25519'
    ||typeof resolveNativeRoute!=='function'
    ||typeof observedNativeSession!=='function'
    ||typeof authorizeIssue!=='function'
    ||typeof now!=='function'||typeof nonce!=='function'
    ||!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>MAX_LIFETIME_MS)
    fail('V2_ASSERTION_OWNER_ISSUER_CONFIG_REQUIRED');
  return async({sessionHandle,tool,args}={})=>{
    if(!safe(sessionHandle))fail('V2_ASSERTION_ATTESTED_SESSION_REQUIRED');
    // All route/OS identity values are produced by private native callbacks.
    // An unauthenticated caller must never supply them to the signing API.
    const route=normalizeV2Route(await resolveNativeRoute(sessionHandle));
    const session=await observedNativeSession(route);
    if(!safe(session))fail('V2_ASSERTION_NATIVE_SESSION_MISMATCH');
    const argumentsHash=v2ActionDigest(tool,args),issuedAtMs=now(),freshNonce=nonce();
    if(!Number.isSafeInteger(issuedAtMs)
      ||!Number.isSafeInteger(issuedAtMs+ttlMs)
      ||!safe(freshNonce))fail('V2_ASSERTION_ISSUER_CLOCK_OR_NONCE_INVALID');
    const permission=await authorizeIssue(Object.freeze({
      sessionHandle,route,osSessionId:session,tool,argumentsHash
    }));
    if(permission!==true)fail('V2_ASSERTION_OWNER_CONSENT_REQUIRED');
    // The user can switch desktop sessions, revoke a binding or reassign a
    // conversation while the owner's async consent check is pending. Never
    // sign an identity that the trusted native resolver no longer observes.
    const verifiedRoute=normalizeV2Route(await resolveNativeRoute(sessionHandle));
    if(JSON.stringify(verifiedRoute)!==JSON.stringify(route))
      fail('V2_ASSERTION_NATIVE_ROUTE_CHANGED');
    if(await observedNativeSession(verifiedRoute)!==session)
      fail('V2_ASSERTION_NATIVE_SESSION_MISMATCH');
    // Reject mutation of the requested action during the async checks.
    if(v2ActionDigest(tool,args)!==argumentsHash)
      fail('V2_ASSERTION_ACTION_MISMATCH');
    const claims=Object.freeze({
      issuer,audience,hostId:route.hostId,principalId:route.principalId,
      profileId:route.profileId,conversationId:route.conversationId,
      operationId:route.operationId,targetKind:route.target.kind,
      targetId:route.target.id,osSessionId:session,tool,argumentsHash,
      issuedAtMs,expiresAtMs:issuedAtMs+ttlMs,nonce:freshNonce
    });
    const signature=sign(null,serialize(keyId,claims),privateKey).toString('base64url');
    const assertion=Object.freeze({schema:2,keyId,claims,signature});
    return Object.freeze({route,assertion});
  };
}
