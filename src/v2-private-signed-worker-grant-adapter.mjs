// PRIVATE v0.12 bridge to the EXISTING Ed25519 V1-07 worker authority.
// Never issues owner consent, access grants, tunnel keys or an OS privilege.
// A valid signed worker identity is necessary, but J01 native owner consent,
// revocation and the exact-action registry remain independently mandatory.
import {isProxy} from 'node:util/types';
import {normalizeV2Route} from './v2-routing-contract.mjs';
import {verifyWorkerRegistration} from './worker-identity-authority.mjs';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH=/^[a-f0-9]{64}$/;
const WORKER=/^cw_[a-f0-9]{64}$/;
function fail(code){throw Object.assign(new Error(code),{code});}
function record(v){
  return v!==null&&typeof v==='object'&&!Array.isArray(v)&&!isProxy(v)
    &&[Object.prototype,null].includes(Object.getPrototypeOf(v));
}
function sameRoute(a,b){
  return a.hostId===b.hostId&&a.profileId===b.profileId
    &&a.principalId===b.principalId&&a.conversationId===b.conversationId
    &&a.operationId===b.operationId&&a.target.kind===b.target.kind
    &&a.target.id===b.target.id;
}
function readPlainFields(value,fields){
  if(!record(value)||Reflect.ownKeys(value).length!==fields.length)return null;
  const obj=Object.create(null);
  for(const key of fields){
    const d=Object.getOwnPropertyDescriptor(value,key);
    if(!d||!d.enumerable||!Object.hasOwn(d,'value'))return null;
    obj[key]=d.value;
  }
  return Object.freeze(obj);
}

/**
 * Creates a concrete exact-action grant verifier for
 * createV2PrivatePairOperationGate.verifyExactNativeGrant.
 *
 * resolveCurrentWorkerId/resolveCurrentOwnerRoute are owner-controlled,
 * independently bound to the currently attested PRIVATE pair. Neither may
 * read the worker or route identity from a caller's MCP JSON payload.
 * workerAuthority owns genuine signature, native binding, action scope and
 * revocation checks; workerRegistry owns durable signed enrollment.
 */
export function createV2PrivateSignedWorkerGrantAdapter({
  hostId,profileId,principalId,expectedTunnelIdHash,expectedOwnerSidHash,
  issuer,audience,workerAuthority,workerRegistry,
  resolveCurrentWorkerId,resolveCurrentOwnerRoute,now=Date.now
}={}){
  if(![hostId,profileId,principalId,issuer,audience].every(v=>
      typeof v==='string'&&ID.test(v)&&v!=='.'&&v!=='..')
    ||![expectedTunnelIdHash,expectedOwnerSidHash].every(v=>
      typeof v==='string'&&HASH.test(v))
    ||typeof workerAuthority?.authorizeWorker!=='function'
    ||typeof workerRegistry?.get!=='function'
    ||[resolveCurrentWorkerId,resolveCurrentOwnerRoute,now].some(v=>
      typeof v!=='function'))
    fail('V2_PRIVATE_SIGNED_WORKER_BOOTSTRAP_REQUIRED');

  return async function verifyExactNativeGrant(input){
    try{
      const req=readPlainFields(input,
        ['route','tool','arguments','ownerContext']);
      if(!req||!record(req.arguments)||typeof req.tool!=='string'
        ||!/^[a-z][a-z0-9_]{0,79}$/.test(req.tool))return false;
      const r=normalizeV2Route(req.route);
      const owner=readPlainFields(req.ownerContext,[
        'source','hostId','profileId','principalId','conversationId',
        'bindingId','ownerSidHash','tunnelIdHash','expiresAtMs'
      ]);
      if(!owner||owner.source!=='native-owner-attested'
        ||r.hostId!==hostId||r.profileId!==profileId
        ||r.principalId!==principalId
        ||owner.hostId!==hostId||owner.profileId!==profileId
        ||owner.principalId!==principalId
        ||owner.conversationId!==r.conversationId
        ||owner.ownerSidHash!==expectedOwnerSidHash
        ||owner.tunnelIdHash!==expectedTunnelIdHash
        ||typeof owner.bindingId!=='string'
        ||!/^[a-f0-9]{32,64}$/.test(owner.bindingId)
        ||!Number.isSafeInteger(owner.expiresAtMs)
        ||owner.expiresAtMs<=now())return false;
      const current=normalizeV2Route(await resolveCurrentOwnerRoute(owner));
      if(!sameRoute(r,current))return false;
      const workerId=await resolveCurrentWorkerId(owner);
      if(typeof workerId!=='string'||!WORKER.test(workerId))return false;
      const signed=await workerRegistry.get(workerId);
      const verified=verifyWorkerRegistration(signed,{issuer,audience,now});
      const c=verified.claims;
      if(c.workerId!==workerId||c.hostId!==hostId
        ||c.profileId!==profileId||c.principalId!==principalId
        ||c.conversationId!==r.conversationId
        ||c.bindingId!==owner.bindingId
        ||c.ownerSidHash!==expectedOwnerSidHash
        ||c.tunnelIdHash!==expectedTunnelIdHash)return false;
      const decision=await workerAuthority.authorizeWorker({
        workerId,invocation:{tool:req.tool,arguments:req.arguments}
      });
      const d=readPlainFields(decision,[
        'authorized','workerId','keyId','bindingId',
        'capabilityPolicyDigest','grantRevision','expiresAtMs'
      ]);
      if(!d||d.authorized!==true||d.workerId!==workerId
        ||d.keyId!==verified.keyId||d.bindingId!==owner.bindingId
        ||d.capabilityPolicyDigest!==c.capabilityPolicyDigest
        ||d.grantRevision!==c.grantRevision
        ||d.expiresAtMs!==c.expiresAtMs||d.expiresAtMs<=now())return false;
      // Rule out route/worker switches while native authorization awaited.
      const finalRoute=normalizeV2Route(await resolveCurrentOwnerRoute(owner));
      const finalWorker=await resolveCurrentWorkerId(owner);
      const finalSigned=await workerRegistry.get(workerId);
      return sameRoute(r,finalRoute)&&finalWorker===workerId
        &&finalSigned?.signature===signed.signature
        &&owner.expiresAtMs>now();
    }catch{return false;}
  };
}
