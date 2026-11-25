// V1-06 source-only adapter: verify a native Host presentation receipt before
// letting createAuthenticatedDeliveryTools() ACK a result. This is NOT an MCP
// Events receipt, ChatGPT identity provider, signed issuer or browser attestor.
// Only the embedding owner Host can supply trusted issuer keys and obtain a
// signed proof from its independently authorized native presentation service.
import {KeyObject,verify} from 'node:crypto';

const DOMAIN_V1='commander.delivery.presentation.v1';
const DOMAIN_V2='commander.delivery.presentation.v2';
const CLAIMS_V1=Object.freeze([
  'issuer','audience','hostId','principalId','profileId','conversationId',
  'bindingId','deliveryId','correlationId','attemptId','resultHash',
  'presentationId','issuedAtMs','expiresAtMs','nonce'
]);
const CLAIMS_V2=Object.freeze([
  'issuer','audience','hostId','principalId','profileId','conversationId',
  'bindingId','workerId','workerKeyId','workerGrantRevision',
  'deliveryId','correlationId','attemptId','resultHash',
  'presentationId','issuedAtMs','expiresAtMs','nonce'
]);
const REQUEST_V1=Object.freeze([
  'hostId','principalId','profileId','conversationId','bindingId',
  'deliveryId','correlationId','attemptId','resultHash'
]);
const REQUEST_V2=Object.freeze([
  'hostId','principalId','profileId','conversationId','bindingId',
  'workerId','workerKeyId','workerGrantRevision',
  'deliveryId','correlationId','attemptId','resultHash'
]);
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EPOCH=/^[a-f0-9]{32,64}$/;
const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9-]{36}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const safe=value=>typeof value==='string'&&ID.test(value)&&value!=='.'&&value!=='..';
function exact(input,fields,code){
  if(!input||typeof input!=='object'||Array.isArray(input)
    ||Object.getPrototypeOf(input)!==Object.prototype
    ||Reflect.ownKeys(input).length!==fields.length)fail(code);
  const output={};
  for(const field of fields){
    const d=Object.getOwnPropertyDescriptor(input,field);
    if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail(code);
    output[field]=d.value;
  }
  return Object.freeze(output);
}
function receiptRequest(value){
  const workerBound=value!==null&&typeof value==='object'&&!Array.isArray(value)
    &&Object.hasOwn(value,'workerId');
  const fields=workerBound?REQUEST_V2:REQUEST_V1;
  const request=exact(value,fields,'DELIVERY_PRESENTATION_REQUEST_INVALID');
  if(fields.slice(0,4).some(k=>!safe(request[k]))
    ||!EPOCH.test(request.bindingId)||!UUID.test(request.deliveryId)
    ||!safe(request.correlationId)||!safe(request.attemptId)
    ||typeof request.resultHash!=='string'||!SHA.test(request.resultHash))
    fail('DELIVERY_PRESENTATION_REQUEST_INVALID');
  if(workerBound&&(!/^cw_[a-f0-9]{64}$/.test(request.workerId)
    ||typeof request.workerKeyId!=='string'||!SHA.test(request.workerKeyId)
    ||!Number.isSafeInteger(request.workerGrantRevision)||request.workerGrantRevision<1))
    fail('DELIVERY_PRESENTATION_REQUEST_INVALID');
  return Object.freeze({request,workerBound});
}
function decodeSignature(value){
  if(typeof value!=='string'||value.length!==86
    ||!/^[A-Za-z0-9_-]{86}$/.test(value))
    fail('DELIVERY_PRESENTATION_SIGNATURE_INVALID');
  const bytes=Buffer.from(value,'base64url');
  if(bytes.length!==64||bytes.toString('base64url')!==value)
    fail('DELIVERY_PRESENTATION_SIGNATURE_INVALID');
  return bytes;
}
function signedBytes(domain,keyId,claims,fields){
  // Protocol owned by the native Host issuer; keyId and protocol version are
  // signed so a recipient cannot reinterpret a legacy proof as worker-bound.
  return Buffer.from(JSON.stringify([domain,keyId,...fields.map(k=>claims[k])]),'utf8');
}
/**
 * Bind this callback only to the host-only attestPresentation slot.
 * No MCP input may provide the signing keys or fetchSignedReceipt implementation.
 * Protocol v1 is retained only for pre-identity legacy rows. New origin-bound
 * results require protocol v2, which signs the enrolled worker ID, key ID and
 * exact grant revision. A v1 proof can never ACK a v2 worker-bound result.
 * Every v2 ACK also requires a Host-only live worker-registry check; missing,
 * revoked, expired or regranted identities fail closed before durable ACK.
 */
export function createSignedDeliveryPresentationAttestor({
  issuer,audience,publicKeys,fetchSignedReceipt,assertWorkerIdentityCurrent,
  now=Date.now,maxAgeMs=30000
}={}){
  if(!safe(issuer)||!safe(audience)||!(publicKeys instanceof Map)
    ||publicKeys.size<1||publicKeys.size>32||typeof fetchSignedReceipt!=='function'
    ||typeof now!=='function'
    ||(assertWorkerIdentityCurrent!==undefined
      &&typeof assertWorkerIdentityCurrent!=='function')
    ||!Number.isSafeInteger(maxAgeMs)||maxAgeMs<1000||maxAgeMs>120000)
    fail('DELIVERY_PRESENTATION_TRUST_REQUIRED');
  const keys=new Map();
  for(const [id,key] of publicKeys){
    if(!safe(id)||!(key instanceof KeyObject)||key.type!=='public'
      ||key.asymmetricKeyType!=='ed25519')
      fail('DELIVERY_PRESENTATION_TRUST_REQUIRED');
    keys.set(id,key);
  }
  return async input=>{
    const {request,workerBound}=receiptRequest(input);
    const domain=workerBound?DOMAIN_V2:DOMAIN_V1;
    const requestFields=workerBound?REQUEST_V2:REQUEST_V1;
    const claimFields=workerBound?CLAIMS_V2:CLAIMS_V1;
    const schema=workerBound?2:1;
    const signed=await fetchSignedReceipt(request);
    const envelope=exact(signed,['schema','keyId','claims','signature'],
      'DELIVERY_PRESENTATION_ENVELOPE_INVALID');
    if(envelope.schema!==schema||!safe(envelope.keyId))
      fail('DELIVERY_PRESENTATION_ENVELOPE_INVALID');
    const key=keys.get(envelope.keyId);
    if(!key)fail('DELIVERY_PRESENTATION_KEY_UNTRUSTED');
    const claims=exact(envelope.claims,claimFields,'DELIVERY_PRESENTATION_CLAIMS_INVALID');
    if(claims.issuer!==issuer||claims.audience!==audience)
      fail('DELIVERY_PRESENTATION_ISSUER_MISMATCH');
    if(requestFields.some(k=>claims[k]!==request[k])||!safe(claims.presentationId)
      ||!safe(claims.nonce))
      fail('DELIVERY_PRESENTATION_SCOPE_MISMATCH');
    const t=now();
    if(!Number.isSafeInteger(t)||!Number.isSafeInteger(claims.issuedAtMs)
      ||!Number.isSafeInteger(claims.expiresAtMs)
      ||claims.expiresAtMs<=claims.issuedAtMs
      ||claims.expiresAtMs-claims.issuedAtMs>120000
      ||claims.issuedAtMs>t||claims.issuedAtMs<t-maxAgeMs
      ||claims.expiresAtMs<=t)
      fail('DELIVERY_PRESENTATION_EXPIRED');
    if(!verify(null,signedBytes(domain,envelope.keyId,claims,claimFields),key,
      decodeSignature(envelope.signature)))
      fail('DELIVERY_PRESENTATION_SIGNATURE_INVALID');
    if(workerBound){
      if(typeof assertWorkerIdentityCurrent!=='function')
        fail('DELIVERY_PRESENTATION_WORKER_NOT_CURRENT');
      let current=false;
      try{
        current=await assertWorkerIdentityCurrent(Object.freeze({
          hostId:claims.hostId,principalId:claims.principalId,
          profileId:claims.profileId,conversationId:claims.conversationId,
          bindingId:claims.bindingId,workerId:claims.workerId,
          workerKeyId:claims.workerKeyId,
          workerGrantRevision:claims.workerGrantRevision,
          issuedAtMs:claims.issuedAtMs,expiresAtMs:claims.expiresAtMs,
          presentationId:claims.presentationId,nonce:claims.nonce
        }))===true;
      }catch{
        fail('DELIVERY_PRESENTATION_WORKER_NOT_CURRENT');
      }
      if(!current)fail('DELIVERY_PRESENTATION_WORKER_NOT_CURRENT');
      // The worker registry/current-grant check is asynchronous. A proof that
      // expired while it ran must not cross the durable ACK boundary.
      const checkedAt=now();
      if(!Number.isSafeInteger(checkedAt)||claims.issuedAtMs>checkedAt
        ||claims.issuedAtMs<checkedAt-maxAgeMs||claims.expiresAtMs<=checkedAt)
        fail('DELIVERY_PRESENTATION_EXPIRED');
    }
    return Object.freeze({...request,verified:true,presentationId:claims.presentationId});
  };
}
