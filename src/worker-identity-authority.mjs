// V1-07 source contract: stable Commander worker identity and owner-bound enrollment.
// This module never reads OS secrets, tunnel API keys, or HTTP-supplied identity.
// Trusted native adapters and a durable registry must be supplied by bootstrap.
import {
  KeyObject, createHash, createPublicKey, randomBytes, randomUUID, sign, verify
} from 'node:crypto';
import { isProxy } from 'node:util/types';

const DOMAIN='commander.worker.identity.v1';
const CLAIMS=Object.freeze([
  'issuer','audience','hostId','profileId','principalId','conversationId',
  'bindingId','workerId','ownerSidHash','deviceProvider','deviceIdHash',
  'tunnelProvider','tunnelIdHash','capabilityPolicyDigest','grantRevision',
  'issuedAtMs','expiresAtMs','nonce'
]);
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX64=/^[a-f0-9]{64}$/;
const BINDING=/^[a-f0-9]{32,64}$/;
const fail=code=>{throw Object.assign(new Error(code),{workerIdentityCode:code,code});};
const hash=value=>createHash('sha256').update(value).digest('hex');
const isPlain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
  &&!isProxy(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));

function exact(value,fields,code){
  if(!isPlain(value)||Reflect.ownKeys(value).length!==fields.length)fail(code);
  const out=Object.create(null);
  for(const field of fields){
    const d=Object.getOwnPropertyDescriptor(value,field);
    if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail(code);
    out[field]=d.value;
  }
  return Object.freeze(out);
}
function safeId(value){return typeof value==='string'&&ID.test(value)&&value!=='.'&&value!=='..';}
function safeBindingId(value){return typeof value==='string'&&BINDING.test(value);}
function timestamp(value){return Number.isSafeInteger(value)&&value>=0;}
function digest(value){return typeof value==='string'&&HEX64.test(value);}
function clock(now){
  const value=now();
  if(!timestamp(value))fail('WORKER_IDENTITY_CLOCK_INVALID');
  return value;
}
function snapshotJson(value,state={seen:new WeakSet(),nodes:0},depth=0){
  if(++state.nodes>10000||depth>32)fail('WORKER_IDENTITY_INVOCATION_BOUNDS');
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='string'){
    state.bytes=(state.bytes??0)+Buffer.byteLength(value,'utf8');
    if(state.bytes>65536)fail('WORKER_IDENTITY_INVOCATION_BOUNDS');
    return value;
  }
  if(typeof value==='number'){
    if(!Number.isFinite(value))fail('WORKER_IDENTITY_INVOCATION_NOT_JSON');
    return value;
  }
  if(typeof value!=='object'||isProxy(value)||state.seen.has(value))
    fail('WORKER_IDENTITY_INVOCATION_NOT_JSON');
  state.seen.add(value);
  if(Array.isArray(value)){
    if(Object.getPrototypeOf(value)!==Array.prototype
      ||value.length>10000||Reflect.ownKeys(value).length!==value.length+1)
      fail('WORKER_IDENTITY_INVOCATION_NOT_JSON');
    const out=[];
    for(let i=0;i<value.length;i++){
      const d=Object.getOwnPropertyDescriptor(value,String(i));
      if(!d||!d.enumerable||!Object.hasOwn(d,'value'))
        fail('WORKER_IDENTITY_INVOCATION_NOT_JSON');
      out.push(snapshotJson(d.value,state,depth+1));
    }
    return Object.freeze(out);
  }
  if(!isPlain(value))fail('WORKER_IDENTITY_INVOCATION_NOT_JSON');
  const keys=Object.keys(value);
  if(keys.length>10000||keys.length!==Reflect.ownKeys(value).length)
    fail('WORKER_IDENTITY_INVOCATION_NOT_JSON');
  const out=Object.create(null);
  for(const key of keys){
    state.bytes=(state.bytes??0)+Buffer.byteLength(key,'utf8');
    if(state.bytes>65536)fail('WORKER_IDENTITY_INVOCATION_BOUNDS');
    if(['__proto__','constructor','prototype'].includes(key))
      fail('WORKER_IDENTITY_INVOCATION_NOT_JSON');
    const d=Object.getOwnPropertyDescriptor(value,key);
    if(!d||!d.enumerable||!Object.hasOwn(d,'value'))
      fail('WORKER_IDENTITY_INVOCATION_NOT_JSON');
    out[key]=snapshotJson(d.value,state,depth+1);
  }
  return Object.freeze(out);
}
function publicKeyFor(privateKey){
  if(!(privateKey instanceof KeyObject)||privateKey.type!=='private'
    ||privateKey.asymmetricKeyType!=='ed25519')
    fail('WORKER_IDENTITY_ED25519_PRIVATE_KEY_REQUIRED');
  const publicKey=createPublicKey(privateKey);
  const der=publicKey.export({type:'spki',format:'der'});
  return {publicKey,der,keyId:hash(der)};
}
export function deriveWorkerId(value={}){
  const input=exact(value,['hostId','profileId','ownerSidHash','deviceProvider','deviceIdHash','keyId'],
    'WORKER_IDENTITY_DERIVATION_INPUT_INVALID');
  const {hostId,profileId,ownerSidHash,deviceProvider,deviceIdHash,keyId}=input;
  if(!safeId(hostId)||!safeId(profileId)||!digest(ownerSidHash)
    ||!['tailscale','native-key-store'].includes(deviceProvider)
    ||!digest(deviceIdHash)||!digest(keyId))
    fail('WORKER_IDENTITY_DERIVATION_INPUT_INVALID');
  const tuple=[DOMAIN,hostId,profileId,ownerSidHash,deviceProvider,deviceIdHash,keyId];
  return 'cw_'+hash(Buffer.from(JSON.stringify(tuple),'utf8'));
}
function signedBytes(keyId,claims){
  return Buffer.from(JSON.stringify([DOMAIN,keyId,...CLAIMS.map(k=>claims[k])]),'utf8');
}
function decodeBase64Url(value,length,code){
  if(typeof value!=='string'||value.length<1||value.length>4096
    ||!/^[A-Za-z0-9_-]+$/.test(value))fail(code);
  const bytes=Buffer.from(value,'base64url');
  if(bytes.length!==length||bytes.toString('base64url')!==value)fail(code);
  return bytes;
}
function routeOf(context){
  return Object.freeze({
    hostId:context.hostId,profileId:context.profileId,
    principalId:context.principalId,conversationId:context.conversationId
  });
}
function authorizationContext(context,identity,grantRevision){
  // V1-01 must bind every exact tool decision to the registered worker AND
  // the current owner-consent epoch. A route alone is insufficient: multiple
  // workers may be attached to the same chat with different grants.
  return Object.freeze({
    hostId:context.hostId,profileId:context.profileId,
    principalId:context.principalId,conversationId:context.conversationId,
    bindingId:context.bindingId,workerId:identity.workerId,keyId:identity.keyId,
    ownerSidHash:identity.ownerSidHash,deviceProvider:identity.deviceProvider,
    deviceIdHash:identity.deviceIdHash,tunnelProvider:identity.tunnelProvider,
    tunnelIdHash:identity.tunnelIdHash,
    capabilityPolicyDigest:identity.capabilityPolicyDigest,grantRevision
  });
}
function validateInvocation(value){
  const input=exact(value,['tool','arguments'],'WORKER_IDENTITY_INVOCATION_INVALID');
  if(!safeId(input.tool)||!isPlain(input.arguments))
    fail('WORKER_IDENTITY_INVOCATION_INVALID');
  return Object.freeze({tool:input.tool,arguments:snapshotJson(input.arguments)});
}
function validateContext(value,hostId,profileId,now){
  const c=exact(value,[
    'source','hostId','profileId','principalId','conversationId','bindingId','ownerSidHash','expiresAtMs'
  ],'WORKER_IDENTITY_OWNER_CONTEXT_INVALID');
  if(c.source!=='native-owner-attested'||c.hostId!==hostId||c.profileId!==profileId
    ||!safeId(c.principalId)||!safeId(c.conversationId)||!safeBindingId(c.bindingId)
    ||!digest(c.ownerSidHash)||!timestamp(c.expiresAtMs)||c.expiresAtMs<=now)
    fail('WORKER_IDENTITY_OWNER_CONTEXT_INVALID');
  return c;
}
function validateDevice(value,now,maxAgeMs){
  const d=exact(value,[
    'source','provider','deviceIdHash','ownerSidHash','verified','attestedAtMs','expiresAtMs'
  ],'WORKER_IDENTITY_DEVICE_UNVERIFIED');
  if(d.source!=='native-device-attestor'
    ||!['tailscale','native-key-store'].includes(d.provider)
    ||!digest(d.deviceIdHash)||!digest(d.ownerSidHash)||d.verified!==true
    ||!timestamp(d.attestedAtMs)||d.attestedAtMs>now
    ||now-d.attestedAtMs>maxAgeMs||!timestamp(d.expiresAtMs)||d.expiresAtMs<=now)
    fail('WORKER_IDENTITY_DEVICE_UNVERIFIED');
  return d;
}
function validateTransport(value,profileId,ownerSidHash,now,maxAgeMs){
  const t=exact(value,[
    'source','provider','profileId','tunnelIdHash','ownerSidHash','authenticated',
    'controlPlanePollOk','healthzStatus','readyzStatus','lastPollAtMs','expiresAtMs'
  ],'WORKER_IDENTITY_TUNNEL_UNVERIFIED');
  if(t.source!=='native-tunnel-attestor'||t.provider!=='openai-secure-mcp-tunnel'
    ||t.profileId!==profileId||!digest(t.tunnelIdHash)||t.ownerSidHash!==ownerSidHash
    ||t.authenticated!==true||t.controlPlanePollOk!==true
    ||t.healthzStatus!==200||t.readyzStatus!==200
    ||!timestamp(t.lastPollAtMs)||t.lastPollAtMs>now
    ||now-t.lastPollAtMs>maxAgeMs||!timestamp(t.expiresAtMs)||t.expiresAtMs<=now)
    fail('WORKER_IDENTITY_TUNNEL_UNVERIFIED');
  return t;
}
function validateOwnerGrant(value,context,identity,now){
  const g=exact(value,[
    'source','hostId','profileId','principalId','conversationId','bindingId',
    'workerId','keyId','ownerSidHash','deviceProvider','deviceIdHash',
    'tunnelProvider','tunnelIdHash','capabilityPolicyDigest','revision','issuedAtMs','expiresAtMs','status'
  ],'WORKER_IDENTITY_OWNER_GRANT_INVALID');
  if(g.source!=='native-owner-attested'||g.hostId!==context.hostId
    ||g.profileId!==context.profileId||g.principalId!==context.principalId
    ||g.conversationId!==context.conversationId||g.bindingId!==context.bindingId
    ||g.workerId!==identity.workerId||g.keyId!==identity.keyId
    ||g.ownerSidHash!==identity.ownerSidHash||g.deviceProvider!==identity.deviceProvider
    ||g.deviceIdHash!==identity.deviceIdHash||g.tunnelProvider!==identity.tunnelProvider
    ||g.tunnelIdHash!==identity.tunnelIdHash
    ||g.capabilityPolicyDigest!==identity.capabilityPolicyDigest
    ||!Number.isSafeInteger(g.revision)||g.revision<1
    ||!timestamp(g.issuedAtMs)||g.issuedAtMs>now
    ||!timestamp(g.expiresAtMs)||g.expiresAtMs<=now||g.status!=='ACTIVE')
    fail('WORKER_IDENTITY_OWNER_GRANT_INVALID');
  return g;
}
function sameContext(a,b){
  return a.source===b.source&&a.hostId===b.hostId&&a.profileId===b.profileId
    &&a.principalId===b.principalId&&a.conversationId===b.conversationId
    &&a.bindingId===b.bindingId&&a.ownerSidHash===b.ownerSidHash
    &&a.expiresAtMs===b.expiresAtMs;
}
function sameDevice(a,b){
  return a.provider===b.provider&&a.deviceIdHash===b.deviceIdHash
    &&a.ownerSidHash===b.ownerSidHash&&a.verified===b.verified;
}
function sameTransport(a,b){
  return a.provider===b.provider&&a.profileId===b.profileId
    &&a.tunnelIdHash===b.tunnelIdHash&&a.ownerSidHash===b.ownerSidHash
    &&a.authenticated===b.authenticated&&a.controlPlanePollOk===b.controlPlanePollOk;
}
function sameGrant(a,b){
  return Object.keys(a).every(k=>a[k]===b[k]);
}
function claimsMatch(claims,snapshot,identity){
  const {context,device,transport,capabilityPolicyDigest}=snapshot;
  return claims.hostId===context.hostId&&claims.profileId===context.profileId
    &&claims.principalId===context.principalId
    &&claims.conversationId===context.conversationId
    &&claims.bindingId===context.bindingId
    &&claims.ownerSidHash===device.ownerSidHash
    &&claims.deviceProvider===device.provider
    &&claims.deviceIdHash===device.deviceIdHash
    &&claims.tunnelProvider===transport.provider
    &&claims.tunnelIdHash===transport.tunnelIdHash
    &&claims.capabilityPolicyDigest===capabilityPolicyDigest
    &&claims.workerId===identity.workerId;
}
function validateClaims(claims,keyId){
  if(!safeId(claims.issuer)||!safeId(claims.audience)
    ||!safeId(claims.hostId)||!safeId(claims.profileId)
    ||!safeId(claims.principalId)||!safeId(claims.conversationId)
    ||!safeBindingId(claims.bindingId)||!safeId(claims.workerId)
    ||!digest(claims.ownerSidHash)||!['tailscale','native-key-store'].includes(claims.deviceProvider)
    ||!digest(claims.deviceIdHash)||claims.tunnelProvider!=='openai-secure-mcp-tunnel'
    ||!digest(claims.tunnelIdHash)||!digest(claims.capabilityPolicyDigest)
    ||!Number.isSafeInteger(claims.grantRevision)||claims.grantRevision<1
    ||!timestamp(claims.issuedAtMs)||!timestamp(claims.expiresAtMs)
    ||claims.expiresAtMs<=claims.issuedAtMs
    ||typeof claims.nonce!=='string'||!/^[a-f0-9]{32}$/.test(claims.nonce)
    ||claims.workerId!==deriveWorkerId({
      hostId:claims.hostId,profileId:claims.profileId,ownerSidHash:claims.ownerSidHash,
      deviceProvider:claims.deviceProvider,deviceIdHash:claims.deviceIdHash,keyId
    }))fail('WORKER_IDENTITY_CLAIMS_INVALID');
}
export function verifyWorkerRegistration(value,{issuer,audience,now=Date.now,maxTtlMs=900000,allowExpired=false}={}){
  const envelope=exact(value,['schema','keyId','publicKey','claims','signature'],
    'WORKER_IDENTITY_ENVELOPE_INVALID');
  if(envelope.schema!==1||!digest(envelope.keyId)||typeof now!=='function'
    ||typeof allowExpired!=='boolean'||!Number.isSafeInteger(maxTtlMs)
    ||maxTtlMs<1000||maxTtlMs>86400000)
    fail('WORKER_IDENTITY_ENVELOPE_INVALID');
  const publicDer=decodeBase64Url(envelope.publicKey,44,'WORKER_IDENTITY_PUBLIC_KEY_INVALID');
  const signature=decodeBase64Url(envelope.signature,64,'WORKER_IDENTITY_SIGNATURE_INVALID');
  let publicKey;
  try{publicKey=createPublicKey({key:publicDer,type:'spki',format:'der'});}
  catch{fail('WORKER_IDENTITY_PUBLIC_KEY_INVALID');}
  if(publicKey.type!=='public'||publicKey.asymmetricKeyType!=='ed25519'
    ||hash(publicDer)!==envelope.keyId)fail('WORKER_IDENTITY_PUBLIC_KEY_INVALID');
  const claims=exact(envelope.claims,CLAIMS,'WORKER_IDENTITY_CLAIMS_INVALID');
  if(issuer!==undefined&&(!safeId(issuer)||claims.issuer!==issuer)
    ||audience!==undefined&&(!safeId(audience)||claims.audience!==audience))
    fail('WORKER_IDENTITY_ENVELOPE_INVALID');
  validateClaims(claims,envelope.keyId);
  const t=now();
  if(!timestamp(t)||claims.issuedAtMs>t||claims.expiresAtMs<=claims.issuedAtMs
    ||claims.expiresAtMs-claims.issuedAtMs>maxTtlMs
    ||(!allowExpired&&claims.expiresAtMs<=t))
    fail('WORKER_IDENTITY_EXPIRED');
  if(!verify(null,signedBytes(envelope.keyId,claims),publicKey,signature))
    fail('WORKER_IDENTITY_SIGNATURE_INVALID');
  return Object.freeze({keyId:envelope.keyId,publicKey:envelope.publicKey,claims});
}

export function createWorkerIdentityAuthority({
  hostId,profileId,issuer,audience,resolveDeviceIdentity,resolveTransportIdentity,
  resolveOwnerContext,resolveOwnerGrant,resolveCapabilityPolicyDigest,
  authorizeExactInvocation,registry,now=Date.now,
  maxEnrollmentTtlMs=900000,maxDeviceAgeMs=300000,maxTransportAgeMs=120000
}={}){
  if(!safeId(hostId)||!safeId(profileId)||!safeId(issuer)||!safeId(audience)
    ||[resolveDeviceIdentity,resolveTransportIdentity,resolveOwnerContext,
      resolveOwnerGrant,resolveCapabilityPolicyDigest,authorizeExactInvocation,now]
      .some(x=>typeof x!=='function')
    ||typeof registry?.get!=='function'||typeof registry?.register!=='function'
    ||typeof registry?.revoke!=='function'||typeof registry?.isRevoked!=='function'
    ||!Number.isSafeInteger(maxEnrollmentTtlMs)||maxEnrollmentTtlMs<1000||maxEnrollmentTtlMs>86400000
    ||!Number.isSafeInteger(maxDeviceAgeMs)||maxDeviceAgeMs<1000||maxDeviceAgeMs>3600000
    ||!Number.isSafeInteger(maxTransportAgeMs)||maxTransportAgeMs<1000||maxTransportAgeMs>3600000)
    fail('WORKER_IDENTITY_TRUSTED_BOOTSTRAP_REQUIRED');

  const getTime=()=>clock(now);
  async function readTrust(){
    const t=getTime();
    const [contextRaw,deviceRaw,transportRaw,policyRaw]=await Promise.all([
      resolveOwnerContext(),resolveDeviceIdentity(),resolveTransportIdentity(),resolveCapabilityPolicyDigest()
    ]);
    const context=validateContext(contextRaw,hostId,profileId,t);
    const device=validateDevice(deviceRaw,t,maxDeviceAgeMs);
    const transport=validateTransport(transportRaw,profileId,device.ownerSidHash,t,maxTransportAgeMs);
    if(context.ownerSidHash!==device.ownerSidHash
      ||device.ownerSidHash!==transport.ownerSidHash)
      fail('WORKER_IDENTITY_OWNER_SID_MISMATCH');
    if(!digest(policyRaw))fail('WORKER_IDENTITY_POLICY_DIGEST_INVALID');
    return Object.freeze({context,device,transport,capabilityPolicyDigest:policyRaw});
  }
  function identityFor(snapshot,keyId){
    return Object.freeze({
      workerId:deriveWorkerId({
        hostId,profileId,ownerSidHash:snapshot.device.ownerSidHash,
        deviceProvider:snapshot.device.provider,deviceIdHash:snapshot.device.deviceIdHash,keyId
      }),
      keyId,ownerSidHash:snapshot.device.ownerSidHash,
      deviceProvider:snapshot.device.provider,deviceIdHash:snapshot.device.deviceIdHash,
      tunnelProvider:snapshot.transport.provider,tunnelIdHash:snapshot.transport.tunnelIdHash,
      capabilityPolicyDigest:snapshot.capabilityPolicyDigest
    });
  }
  async function readGrant(snapshot,identity){
    const request=Object.freeze({
      ...snapshot.context,...identity
    });
    return validateOwnerGrant(await resolveOwnerGrant(request),snapshot.context,identity,getTime());
  }
  async function stableRecheck(first,identity,grant){
    const second=await readTrust();
    if(!sameContext(first.context,second.context)||!sameDevice(first.device,second.device)
      ||!sameTransport(first.transport,second.transport)
      ||first.capabilityPolicyDigest!==second.capabilityPolicyDigest)
      fail('WORKER_IDENTITY_TRUST_CHANGED');
    const currentGrant=await readGrant(second,identity);
    if(!sameGrant(grant,currentGrant))fail('WORKER_IDENTITY_OWNER_GRANT_CHANGED');
    return second;
  }
  function envelopeFor(privateKey,identity,snapshot,grant){
    const issuedAtMs=getTime();
    const expiresAtMs=Math.min(
      issuedAtMs+maxEnrollmentTtlMs,snapshot.context.expiresAtMs,
      snapshot.device.expiresAtMs,snapshot.transport.expiresAtMs,grant.expiresAtMs
    );
    if(expiresAtMs<=issuedAtMs)fail('WORKER_IDENTITY_ENROLLMENT_WINDOW_INVALID');
    const claims=Object.freeze({
      issuer,audience,hostId,profileId,
      principalId:snapshot.context.principalId,
      conversationId:snapshot.context.conversationId,
      bindingId:snapshot.context.bindingId,
      workerId:identity.workerId,ownerSidHash:identity.ownerSidHash,
      deviceProvider:identity.deviceProvider,deviceIdHash:identity.deviceIdHash,
      tunnelProvider:identity.tunnelProvider,tunnelIdHash:identity.tunnelIdHash,
      capabilityPolicyDigest:identity.capabilityPolicyDigest,
      grantRevision:grant.revision,
      issuedAtMs,expiresAtMs,nonce:randomBytes(16).toString('hex')
    });
    const {publicKey,der,keyId}=publicKeyFor(privateKey);
    if(keyId!==identity.keyId)fail('WORKER_IDENTITY_KEY_CHANGED');
    return Object.freeze({
      schema:1,keyId,publicKey:der.toString('base64url'),claims,
      signature:sign(null,signedBytes(keyId,claims),privateKey).toString('base64url')
    });
  }
  async function registerWorker(input){
    const request=exact(input,['privateKey'],'WORKER_IDENTITY_REGISTER_REQUEST_INVALID');
    const {publicKey,der,keyId}=publicKeyFor(request.privateKey);
    const first=await readTrust();
    const identity=identityFor(first,keyId);
    const grant=await readGrant(first,identity);
    const invocation=Object.freeze({tool:'worker.register',arguments:Object.freeze({
      workerId:identity.workerId,keyId,deviceProvider:identity.deviceProvider,
      deviceIdHash:identity.deviceIdHash,tunnelProvider:identity.tunnelProvider,
      tunnelIdHash:identity.tunnelIdHash,capabilityPolicyDigest:identity.capabilityPolicyDigest,
      grantRevision:grant.revision
    })});
    if(await authorizeExactInvocation(routeOf(first.context),invocation,authorizationContext(first.context,identity,grant.revision))!==true)
      fail('WORKER_IDENTITY_REGISTER_NOT_AUTHORIZED');
    const stable=await stableRecheck(first,identity,grant);
    const currentGrant=await readGrant(stable,identity);
    const existing=await registry.get(identity.workerId);
    let expectedPreviousBindingId=null;
    let expectedPreviousState='EMPTY';
    if(existing){
      const old=verifyWorkerRegistration(existing,{
        issuer,audience,now,maxTtlMs:maxEnrollmentTtlMs,allowExpired:true
      });
      const oldRevoked=await registry.isRevoked(identity.workerId,old.claims.bindingId);
      const oldExpired=old.claims.expiresAtMs<=getTime();
      if(!oldRevoked&&!oldExpired){
        if(old.claims.bindingId===stable.context.bindingId
          &&old.keyId===keyId&&claimsMatch(old.claims,stable,identity)
          &&old.claims.grantRevision===currentGrant.revision)
          return existing;
        fail('WORKER_IDENTITY_ACTIVE_BINDING_CONFLICT');
      }
      if(old.claims.bindingId===stable.context.bindingId)
        fail('WORKER_IDENTITY_REENROLLMENT_EPOCH_REQUIRED');
      expectedPreviousBindingId=old.claims.bindingId;
      expectedPreviousState=oldRevoked?'REVOKED':'EXPIRED';
    }
    const finalGrant=await readGrant(stable,identity);
    if(!sameGrant(grant,finalGrant))fail('WORKER_IDENTITY_OWNER_GRANT_CHANGED');
    const envelope=envelopeFor(request.privateKey,identity,stable,finalGrant);
    const stored=await registry.register(envelope,{
      expectedPreviousBindingId,expectedPreviousState
    });
    if(stored!==true)fail('WORKER_IDENTITY_REGISTRY_WRITE_FAILED');
    const persisted=await registry.get(identity.workerId);
    if(!persisted||persisted.signature!==envelope.signature)
      fail('WORKER_IDENTITY_REGISTRY_READBACK_FAILED');
    return persisted;
  }
  async function authorizeWorker(input){
    const request=exact(input,['workerId','invocation'],'WORKER_IDENTITY_AUTHORIZE_REQUEST_INVALID');
    if(!safeId(request.workerId))fail('WORKER_IDENTITY_AUTHORIZE_REQUEST_INVALID');
    const invocation=validateInvocation(request.invocation);
    const envelope=await registry.get(request.workerId);
    if(!envelope)fail('WORKER_IDENTITY_NOT_REGISTERED');
    const verified=verifyWorkerRegistration(envelope,{issuer,audience,now,maxTtlMs:maxEnrollmentTtlMs});
    const {claims}=verified;
    if(claims.workerId!==request.workerId
      ||await registry.isRevoked(request.workerId,claims.bindingId))
      fail('WORKER_IDENTITY_REVOKED');
    const first=await readTrust();
    const identity=Object.freeze({
      workerId:claims.workerId,keyId:verified.keyId,ownerSidHash:claims.ownerSidHash,
      deviceProvider:claims.deviceProvider,deviceIdHash:claims.deviceIdHash,
      tunnelProvider:claims.tunnelProvider,tunnelIdHash:claims.tunnelIdHash,
      capabilityPolicyDigest:claims.capabilityPolicyDigest
    });
    if(!claimsMatch(claims,first,identity))fail('WORKER_IDENTITY_SCOPE_MISMATCH');
    const grant=await readGrant(first,identity);
    if(grant.bindingId!==claims.bindingId||grant.revision!==claims.grantRevision)
      fail('WORKER_IDENTITY_OWNER_GRANT_CHANGED');
    if(await authorizeExactInvocation(routeOf(first.context),invocation,authorizationContext(first.context,identity,grant.revision))!==true)
      fail('WORKER_IDENTITY_ACTION_NOT_AUTHORIZED');
    await stableRecheck(first,identity,grant);
    if(await registry.isRevoked(request.workerId,claims.bindingId))
      fail('WORKER_IDENTITY_REVOKED');
    const latest=await registry.get(request.workerId);
    if(!latest||latest.signature!==envelope.signature)
      fail('WORKER_IDENTITY_REGISTRATION_CHANGED');
    return Object.freeze({
      authorized:true,workerId:claims.workerId,keyId:verified.keyId,
      bindingId:claims.bindingId,capabilityPolicyDigest:claims.capabilityPolicyDigest,
      grantRevision:claims.grantRevision,expiresAtMs:claims.expiresAtMs
    });
  }
  async function revokeWorker(input){
    const request=exact(input,['workerId','reasonCode'],'WORKER_IDENTITY_REVOKE_REQUEST_INVALID');
    if(!safeId(request.workerId)||!safeId(request.reasonCode))
      fail('WORKER_IDENTITY_REVOKE_REQUEST_INVALID');
    const envelope=await registry.get(request.workerId);
    if(!envelope)fail('WORKER_IDENTITY_NOT_REGISTERED');
    const verified=verifyWorkerRegistration(envelope,{issuer,audience,now,maxTtlMs:maxEnrollmentTtlMs,allowExpired:true});
    const claims=verified.claims;
    // Idempotency is not an authorization bypass: always revalidate current owner,
    // chat binding, grant and exact worker.revoke action before returning alreadyRevoked.
    const first=await readTrust();
    const identity=Object.freeze({
      workerId:claims.workerId,keyId:verified.keyId,ownerSidHash:claims.ownerSidHash,
      deviceProvider:claims.deviceProvider,deviceIdHash:claims.deviceIdHash,
      tunnelProvider:claims.tunnelProvider,tunnelIdHash:claims.tunnelIdHash,
      capabilityPolicyDigest:claims.capabilityPolicyDigest
    });
    if(!claimsMatch(claims,first,identity))fail('WORKER_IDENTITY_SCOPE_MISMATCH');
    const grant=await readGrant(first,identity);
    if(grant.bindingId!==claims.bindingId||grant.revision!==claims.grantRevision)
      fail('WORKER_IDENTITY_OWNER_GRANT_CHANGED');
    const invocation=Object.freeze({tool:'worker.revoke',arguments:Object.freeze({
      workerId:request.workerId,reasonCode:request.reasonCode,grantRevision:grant.revision
    })});
    if(await authorizeExactInvocation(routeOf(first.context),invocation,authorizationContext(first.context,identity,grant.revision))!==true)
      fail('WORKER_IDENTITY_REVOKE_NOT_AUTHORIZED');
    await stableRecheck(first,identity,grant);
    if(await registry.isRevoked(request.workerId,claims.bindingId))
      return Object.freeze({revoked:true,alreadyRevoked:true,workerId:request.workerId,bindingId:claims.bindingId});
    const receipt=Object.freeze({
      revocationId:randomUUID(),revokedAtMs:getTime(),reasonCode:request.reasonCode
    });
    if(await registry.revoke(request.workerId,claims.bindingId,receipt,{expectedSignature:envelope.signature})!==true
      ||await registry.isRevoked(request.workerId,claims.bindingId)!==true)
      fail('WORKER_IDENTITY_REVOCATION_NOT_DURABLE');
    return Object.freeze({
      revoked:true,alreadyRevoked:false,workerId:request.workerId,
      bindingId:claims.bindingId,...receipt
    });
  }
  return Object.freeze({
    registerWorker,authorizeWorker,revokeWorker,
    verifyRegistration:value=>verifyWorkerRegistration(value,{issuer,audience,now,maxTtlMs:maxEnrollmentTtlMs})
  });
}
