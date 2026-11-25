// Owner-local signed Worker grant adapter for the existing one-Tunnel pair.
// No OAuth, second Tunnel, network listener, synthetic ChatGPT chat identity,
// auto-enrollment, credential generation, OS privilege, or default tool grant.
// The protected HTTPS/mTLS operation gate authenticates the request separately;
// this adapter binds WorkerIdentityAuthority to the SAME native owner/grant epoch.
import {isProxy} from 'node:util/types';
import {normalizeV2Route} from './v2-routing-contract.mjs';
import {deriveV101PrivatePairSessionHandle}
  from './v101-private-pair-native-owner-stack.mjs';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH=/^[a-f0-9]{64}$/;
const BINDING=/^[a-f0-9]{32,64}$/;
const WORKER=/^cw_[a-f0-9]{64}$/;
const TOOL=/^(?=.{1,80}$)[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const OWNER_FIELDS=['source','hostId','profileId','principalId',
  'conversationId','bindingId','ownerSidHash','expiresAtMs'];
const CONTEXT_FIELDS=['hostId','profileId','principalId','conversationId',
  'bindingId','workerId','keyId','ownerSidHash','deviceProvider',
  'deviceIdHash','tunnelProvider','tunnelIdHash','capabilityPolicyDigest'];
const EXTRA_FIELDS=['workerId','keyId','deviceProvider','deviceIdHash',
  'tunnelProvider','tunnelIdHash','capabilityPolicyDigest'];
const fail=code=>{throw Object.assign(new Error(code),{code});};
const safeId=x=>typeof x==='string'&&ID.test(x)&&x!=='.'&&x!=='..';
const digest=x=>typeof x==='string'&&HASH.test(x);
const plain=x=>!!x&&typeof x==='object'&&!Array.isArray(x)
  &&!isProxy(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
function exact(x,keys){
  if(!plain(x)||Reflect.ownKeys(x).length!==keys.length)
    fail('V012_NATIVE_WORKER_CONTEXT_INVALID');
  const out=Object.create(null);
  for(const key of keys){
    const d=Object.getOwnPropertyDescriptor(x,key);
    if(!d||!d.enumerable||!Object.hasOwn(d,'value'))
      fail('V012_NATIVE_WORKER_CONTEXT_INVALID');
    out[key]=d.value;
  }
  return Object.freeze(out);
}
function context(x){
  const c=exact(x,CONTEXT_FIELDS);
  if(![c.hostId,c.profileId,c.principalId,c.conversationId].every(safeId)
    ||!BINDING.test(c.bindingId)||!WORKER.test(c.workerId)
    ||![c.keyId,c.ownerSidHash,c.deviceIdHash,c.tunnelIdHash,
      c.capabilityPolicyDigest].every(digest)
    ||!['tailscale','native-key-store'].includes(c.deviceProvider)
    ||c.tunnelProvider!=='openai-secure-mcp-tunnel')
    fail('V012_NATIVE_WORKER_CONTEXT_INVALID');
  return c;
}
const sameOwner=(a,b)=>OWNER_FIELDS.every(key=>a[key]===b[key]);
const sameRoute=(a,b)=>a.hostId===b.hostId&&a.profileId===b.profileId
  &&a.principalId===b.principalId&&a.conversationId===b.conversationId
  &&a.operationId===b.operationId&&a.target.kind===b.target.kind
  &&a.target.id===b.target.id;
const matchingGrant=(grant,c,revision,t)=>
  !!grant&&grant.status==='ACTIVE'&&grant.source==='native-owner-attested'
  &&Number.isSafeInteger(revision)&&revision>=1
  &&grant.revision===revision&&grant.expiresAtMs>t
  &&CONTEXT_FIELDS.every(key=>grant[key]===c[key]);

/**
 * Native owner and the exact account+host mTLS pair are *already* attested.
 * The owner-provisioned resolver chooses a unique operation target; raw MCP
 * route or caller chat hints are NEVER trusted as an authorization principal.
 *
 * Intended as three callbacks for createWorkerIdentityAuthority:
 * resolveOwnerContext, resolveOwnerGrant, authorizeExactInvocation.
 * Neither this adapter nor a successful J01 pair bind creates a grant.
 */
export function createV012PrivateNativeWorkerGrantAdapter({
  ownerStack,identity,resolveTrustedToolRoute,
  authorizeExactArguments,now=Date.now
}={}){
  const i=exact(identity,['hostId','profileId','principalId',
    'expectedTunnelIdHash','expectedOwnerSidHash']);
  if(![i.hostId,i.profileId,i.principalId].every(safeId)
    ||![i.expectedTunnelIdHash,i.expectedOwnerSidHash].every(digest)
    ||typeof ownerStack?.nativeSessionBindings?.resolveNativeOwnerContext!=='function'
    ||typeof ownerStack?.nativeSessionBindings?.resolveNativeRoute!=='function'
    ||typeof ownerStack?.resolveOwnerContext!=='function'
    ||typeof ownerStack?.readCurrentOwnerSidHash!=='function'
    ||typeof ownerStack?.grantRegistry?.readWorkerGrant!=='function'
    ||typeof ownerStack?.grantRegistry?.isWorkerAllowed!=='function'
    ||typeof resolveTrustedToolRoute!=='function'
    ||typeof authorizeExactArguments!=='function'||typeof now!=='function')
    fail('V012_NATIVE_WORKER_TRUSTED_BOOTSTRAP_REQUIRED');
  const pair=deriveV101PrivatePairSessionHandle({
    profileId:i.profileId,expectedTunnelIdHash:i.expectedTunnelIdHash,
    expectedOwnerSidHash:i.expectedOwnerSidHash
  });
  const registry=ownerStack.grantRegistry;
  function clock(){
    const t=now();
    if(!Number.isSafeInteger(t)||t<0)
      fail('V012_NATIVE_WORKER_CLOCK_INVALID');
    return t;
  }
  async function owner(){
    const before=await ownerStack.readCurrentOwnerSidHash();
    if(before!==i.expectedOwnerSidHash)
      fail('V012_NATIVE_WORKER_OWNER_CHANGED');
    const raw=await ownerStack.nativeSessionBindings
      .resolveNativeOwnerContext(pair);
    const o=exact(raw,OWNER_FIELDS);
    const pairOwner=await ownerStack.resolveOwnerContext(pair);
    const nativeRoute=normalizeV2Route(
      await ownerStack.nativeSessionBindings.resolveNativeRoute(pair));
    const after=await ownerStack.readCurrentOwnerSidHash();
    if(after!==before||o.source!=='native-owner-attested'
      ||o.hostId!==i.hostId||o.profileId!==i.profileId
      ||o.principalId!==i.principalId||o.conversationId!==pair
      ||!BINDING.test(o.bindingId)
      ||o.ownerSidHash!==before||!Number.isSafeInteger(o.expiresAtMs)
      ||o.expiresAtMs<=clock()
      ||!pairOwner||pairOwner.tunnelIdHash!==i.expectedTunnelIdHash
      ||!OWNER_FIELDS.every(key=>pairOwner[key]===o[key])
      ||nativeRoute.hostId!==o.hostId||nativeRoute.profileId!==o.profileId
      ||nativeRoute.principalId!==o.principalId
      ||nativeRoute.conversationId!==o.conversationId)
      fail('V012_NATIVE_WORKER_OWNER_CONTEXT_REQUIRED');
    return Object.freeze({context:o,nativeRoute});
  }
  function workerFromRequest(value){
    const raw=exact(value,[...OWNER_FIELDS,...EXTRA_FIELDS]);
    const c=context(Object.fromEntries(
      CONTEXT_FIELDS.map(key=>[key,raw[key]])));
    return Object.freeze({owner:raw,worker:c});
  }
  async function readOwnerGrant(request){
    const r=workerFromRequest(request);
    const live=await owner();
    if(!sameOwner(live.context,r.owner))return null;
    const grant=registry.readWorkerGrant(r.worker);
    if(!matchingGrant(grant,r.worker,grant?.revision,clock()))return null;
    const after=await owner();
    return sameOwner(live.context,after.context)?grant:null;
  }
  async function authorizeExactInvocation(rawRoute,rawCall,rawWorker){
    try{
      const r=exact(rawRoute,['hostId','profileId','principalId','conversationId']);
      const call=exact(rawCall,['tool','arguments']);
      if(typeof call.tool!=='string'||!TOOL.test(call.tool)
        ||!plain(call.arguments))return false;
      const raw=exact(rawWorker,[...CONTEXT_FIELDS,'grantRevision']);
      const c=context(Object.fromEntries(CONTEXT_FIELDS.map(k=>[k,raw[k]])));
      if(!Number.isSafeInteger(raw.grantRevision)||raw.grantRevision<1)
        return false;
      const first=await owner();
      if(![r.hostId,r.profileId,r.principalId,r.conversationId]
        .every((value,index)=>value===[
          first.context.hostId,first.context.profileId,
          first.context.principalId,first.context.conversationId
        ][index]))return false;
      if(!['hostId','profileId','principalId','conversationId',
        'bindingId','ownerSidHash'].every(key=>c[key]===first.context[key]))
        return false;
      // Existing native registry must authorize the exact worker epoch and
      // exact operation/tool. No self-issued or blanket Full Access grants.
      const route=normalizeV2Route(await resolveTrustedToolRoute(
        Object.freeze({nativeRoute:first.nativeRoute,
          ownerContext:first.context,tool:call.tool,arguments:call.arguments})));
      if(route.hostId!==first.context.hostId
        ||route.profileId!==first.context.profileId
        ||route.principalId!==first.context.principalId
        ||route.conversationId!==first.context.conversationId)return false;
      const initial=registry.readWorkerGrant(c),revision=raw.grantRevision;
      if(!matchingGrant(initial,c,revision,clock())
        ||registry.isWorkerAllowed(route,c,call.tool)!==true)return false;
      if(await authorizeExactArguments(Object.freeze({
        route,tool:call.tool,arguments:call.arguments,ownerContext:first.context
      }))!==true)return false;
      const last=await owner();
      if(!sameOwner(first.context,last.context)
        ||!sameRoute(first.nativeRoute,last.nativeRoute))return false;
      const currentRoute=normalizeV2Route(await resolveTrustedToolRoute(
        Object.freeze({nativeRoute:last.nativeRoute,
          ownerContext:last.context,tool:call.tool,arguments:call.arguments})));
      const latest=registry.readWorkerGrant(c);
      return sameRoute(route,currentRoute)
        &&matchingGrant(latest,c,revision,clock())
        &&registry.isWorkerAllowed(route,c,call.tool)===true;
    }catch{return false;}
  }
  return Object.freeze({
    pairSessionHandle:pair,
    resolveOwnerContext:async()=>{
      // Never leak native seat, tunnel or owner probe failure details to a
      // caller of the signed Worker authority. Absence remains a hard deny.
      try{return (await owner()).context;}
      catch{fail('V012_NATIVE_WORKER_OWNER_CONTEXT_REQUIRED');}
    },
    resolveOwnerGrant:async request=>{
      try{return await readOwnerGrant(request);}catch{return null;}
    },
    authorizeExactInvocation
  });
}
