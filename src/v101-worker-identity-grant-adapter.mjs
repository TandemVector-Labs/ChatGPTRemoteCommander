import { isProxy } from 'node:util/types';
import { normalizeV2Route } from './v2-routing-contract.mjs';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BINDING=/^[a-f0-9]{32,64}$/;
const WORKER_ID=/^cw_[a-f0-9]{64}$/;
const HASH=/^[a-f0-9]{64}$/;
const TOOL=/^(?=.{1,80}$)[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const CONTEXT_FIELDS=Object.freeze([
  'hostId','profileId','principalId','conversationId','bindingId','workerId',
  'keyId','ownerSidHash','deviceProvider','deviceIdHash','tunnelProvider',
  'tunnelIdHash','capabilityPolicyDigest'
]);
const AUTH_CONTEXT_FIELDS=Object.freeze([...CONTEXT_FIELDS,'grantRevision']);
const OWNER_CONTEXT_FIELDS=Object.freeze([
  'source','hostId','profileId','principalId','conversationId','bindingId','ownerSidHash','expiresAtMs'
]);
const OWNER_REQUEST_FIELDS=Object.freeze([
  ...OWNER_CONTEXT_FIELDS.slice(0,6),'expiresAtMs','workerId','keyId','ownerSidHash',
  'deviceProvider','deviceIdHash','tunnelProvider','tunnelIdHash','capabilityPolicyDigest'
]);
const ROUTE_CONTEXT_FIELDS=Object.freeze(['hostId','profileId','principalId','conversationId']);

function fail(code){throw Object.assign(new Error(code),{code});}
function exactRecord(value,fields,code){
  if(!value||typeof value!=='object'||Array.isArray(value)||isProxy(value)
    ||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(code);
  const keys=Reflect.ownKeys(value);
  if(keys.length!==fields.length||keys.some(k=>typeof k!=='string'||!fields.includes(k)))fail(code);
  const out=Object.create(null);
  for(const key of fields){
    const d=Object.getOwnPropertyDescriptor(value,key);
    if(!d||!Object.hasOwn(d,'value')||d.enumerable!==true)fail(code);
    out[key]=d.value;
  }
  return out;
}
function contextOf(value){
  const c=exactRecord(value,CONTEXT_FIELDS,'V101_WORKER_GRANT_CONTEXT_INVALID');
  for(const k of ['hostId','profileId','principalId','conversationId'])
    if(typeof c[k]!=='string'||!ID.test(c[k])||c[k]==='.'||c[k]==='..')
      fail('V101_WORKER_GRANT_CONTEXT_INVALID');
  if(typeof c.bindingId!=='string'||!BINDING.test(c.bindingId)
    ||typeof c.workerId!=='string'||!WORKER_ID.test(c.workerId)
    ||typeof c.keyId!=='string'||!HASH.test(c.keyId)
    ||typeof c.ownerSidHash!=='string'||!HASH.test(c.ownerSidHash)
    ||typeof c.deviceProvider!=='string'||!['tailscale','native-key-store'].includes(c.deviceProvider)
    ||typeof c.deviceIdHash!=='string'||!HASH.test(c.deviceIdHash)
    ||c.tunnelProvider!=='openai-secure-mcp-tunnel'
    ||typeof c.tunnelIdHash!=='string'||!HASH.test(c.tunnelIdHash)
    ||typeof c.capabilityPolicyDigest!=='string'||!HASH.test(c.capabilityPolicyDigest))
    fail('V101_WORKER_GRANT_CONTEXT_INVALID');
  return Object.freeze(c);
}
function authorizationContextOf(value){
  const raw=exactRecord(value,AUTH_CONTEXT_FIELDS,'V101_WORKER_GRANT_CONTEXT_INVALID');
  if(!Number.isSafeInteger(raw.grantRevision)||raw.grantRevision<1)
    fail('V101_WORKER_GRANT_REVISION_INVALID');
  const context=contextOf(Object.fromEntries(CONTEXT_FIELDS.map(k=>[k,raw[k]])));
  return Object.freeze({context,grantRevision:raw.grantRevision});
}
function ownerContextOf(value){
  const c=exactRecord(value,OWNER_CONTEXT_FIELDS,'V101_WORKER_OWNER_CONTEXT_INVALID');
  for(const k of ['hostId','profileId','principalId','conversationId'])
    if(typeof c[k]!=='string'||!ID.test(c[k])||c[k]==='.'||c[k]==='..')
      fail('V101_WORKER_OWNER_CONTEXT_INVALID');
  if(c.source!=='native-owner-attested'||typeof c.bindingId!=='string'
    ||!BINDING.test(c.bindingId)||typeof c.ownerSidHash!=='string'
    ||!HASH.test(c.ownerSidHash)||!Number.isSafeInteger(c.expiresAtMs)||c.expiresAtMs<0)
    fail('V101_WORKER_OWNER_CONTEXT_INVALID');
  return Object.freeze(c);
}
function routeContextOf(value){
  const r=exactRecord(value,ROUTE_CONTEXT_FIELDS,'V101_WORKER_GRANT_ROUTE_INVALID');
  for(const k of ROUTE_CONTEXT_FIELDS)
    if(typeof r[k]!=='string'||!ID.test(r[k])||r[k]==='.'||r[k]==='..')
      fail('V101_WORKER_GRANT_ROUTE_INVALID');
  return Object.freeze(r);
}
function matches(a,b){
  return a.hostId===b.hostId&&a.profileId===b.profileId
    &&a.principalId===b.principalId&&a.conversationId===b.conversationId;
}
function ownerMatchesContext(owner,c){
  return owner.source==='native-owner-attested'&&owner.hostId===c.hostId
    &&owner.profileId===c.profileId&&owner.principalId===c.principalId
    &&owner.conversationId===c.conversationId&&owner.bindingId===c.bindingId
    &&owner.ownerSidHash===c.ownerSidHash;
}
function ownerGrantMatchesContext(g,c){
  return !!g&&g.source==='native-owner-attested'&&g.hostId===c.hostId
    &&g.profileId===c.profileId&&g.principalId===c.principalId
    &&g.conversationId===c.conversationId&&g.bindingId===c.bindingId
    &&g.workerId===c.workerId&&g.keyId===c.keyId
    &&g.ownerSidHash===c.ownerSidHash&&g.deviceProvider===c.deviceProvider
    &&g.deviceIdHash===c.deviceIdHash&&g.tunnelProvider===c.tunnelProvider
    &&g.tunnelIdHash===c.tunnelIdHash
    &&g.capabilityPolicyDigest===c.capabilityPolicyDigest;
}
function sameRoute(a,b){
  return a.hostId===b.hostId&&a.profileId===b.profileId
    &&a.principalId===b.principalId&&a.conversationId===b.conversationId
    &&a.operationId===b.operationId&&a.target.kind===b.target.kind
    &&a.target.id===b.target.id;
}
function currentTokenOf(value){
  if(typeof value!=='string'||value.length<16||value.length>16384)
    fail('V101_WORKER_ACCESS_TOKEN_UNAVAILABLE');
  return value;
}

/**
 * Connects V1-07's signed worker authority to the V1-01 native owner bridge
 * and V2GrantRegistry. resolveCurrentAccessToken MUST read the current bearer
 * from the trusted transport/session, never from model arguments or a project
 * file. The same V2GrantRegistry instance must be used by the native bridge.
 *
 * The bridge's resolveOwnerRoute is the canonical owner-selected operation
 * target. It is not accepted from the worker invocation. The bridge separately
 * enforces the base route/tool grant and exact argument policy; this adapter
 * additionally enforces the exact worker/key/device/tunnel/policy/binding grant.
 */
export function createV101WorkerIdentityGrantAdapter({
  grantRegistry,bridge,resolveCurrentAccessToken,now=Date.now
}={}){
  if(typeof grantRegistry?.readWorkerGrant!=='function'
    ||typeof grantRegistry?.isWorkerAllowed!=='function'
    ||typeof resolveCurrentAccessToken!=='function'||typeof now!=='function'
    ||typeof bridge?.verifyCaller!=='function'
    ||typeof bridge?.resolveOwnerContext!=='function'
    ||typeof bridge?.resolveOwnerRoute!=='function'
    ||typeof bridge?.authorizeTool!=='function'
    ||typeof bridge?.usesGrantRegistry!=='function')
    fail('V101_WORKER_GRANT_TRUSTED_BOOTSTRAP_REQUIRED');
  if(bridge.usesGrantRegistry(grantRegistry)!==true)
    fail('V101_WORKER_GRANT_REGISTRY_MISMATCH');
  const clock=()=>{
    const t=now();
    if(!Number.isSafeInteger(t)||t<0)fail('V101_WORKER_GRANT_CLOCK_INVALID');
    return t;
  };
  async function token(){return currentTokenOf(await resolveCurrentAccessToken());}
  async function readOwner(){
    const current=await token();
    const owner=ownerContextOf(await bridge.resolveOwnerContext(current));
    if(owner.expiresAtMs<=clock())return null;
    return owner;
  }
  async function resolveOwnerContext(){
    try{return await readOwner();}catch{return null;}
  }
  async function resolveOwnerGrant(request){
    try{
      const r=exactRecord(request,OWNER_REQUEST_FIELDS,'V101_WORKER_GRANT_OWNER_REQUEST_INVALID');
      if(r.source!=='native-owner-attested'||!Number.isSafeInteger(r.expiresAtMs)
        ||r.expiresAtMs<=clock())return null;
      const c=contextOf(Object.fromEntries(CONTEXT_FIELDS.map(k=>[k,r[k]])));
      const owner=await readOwner();
      if(!owner||!ownerMatchesContext(owner,c)||owner.expiresAtMs!==r.expiresAtMs)return null;
      return grantRegistry.readWorkerGrant(c);
    }catch{return null;}
  }
  async function authorizeExactInvocation(route,invocation,workerContext){
    try{
      const r=routeContextOf(route);
      const {context:c,grantRevision}=authorizationContextOf(workerContext);
      if(!matches(r,c))return false;
      const call=exactRecord(invocation,['tool','arguments'],'V101_WORKER_GRANT_INVOCATION_INVALID');
      if(typeof call.tool!=='string'||!TOOL.test(call.tool)
        ||!call.arguments||typeof call.arguments!=='object'||Array.isArray(call.arguments)
        ||isProxy(call.arguments))return false;
      const bearer=await token();
      const actor=await bridge.verifyCaller(bearer);
      if(!actor)return false;
      const owner=ownerContextOf(await bridge.resolveOwnerContext(bearer));
      const resolved=normalizeV2Route(await bridge.resolveOwnerRoute(bearer));
      if(owner.expiresAtMs<=clock()||!ownerMatchesContext(owner,c)
        ||!matches(resolved,c))return false;
      const grant=grantRegistry.readWorkerGrant(c);
      if(!ownerGrantMatchesContext(grant,c)||grant.status!=='ACTIVE'
        ||grant.revision!==grantRevision||grant.expiresAtMs<=clock()
        ||!grantRegistry.isWorkerAllowed(resolved,c,call.tool))return false;
      if(await bridge.authorizeTool(actor,Object.freeze({
        rpcMethod:'tools/call',tool:call.tool,arguments:call.arguments
      }))!==true)return false;
      // Re-read the native owner epoch, canonical target and grant after the
      // asynchronous argument policy. A changed grant/revocation is a deny.
      const bearerAfter=await token();
      const ownerAfter=ownerContextOf(await bridge.resolveOwnerContext(bearerAfter));
      const routeAfter=normalizeV2Route(await bridge.resolveOwnerRoute(bearerAfter));
      const grantAfter=grantRegistry.readWorkerGrant(c);
      return ownerAfter.expiresAtMs>clock()&&ownerMatchesContext(ownerAfter,c)
        &&sameRoute(resolved,routeAfter)&&ownerGrantMatchesContext(grantAfter,c)
        &&grantAfter.status==='ACTIVE'&&grantAfter.revision===grantRevision
        &&grantAfter.expiresAtMs>clock()
        &&grantRegistry.isWorkerAllowed(routeAfter,c,call.tool)===true;
    }catch{return false;}
  }
  return Object.freeze({resolveOwnerContext,resolveOwnerGrant,authorizeExactInvocation});
}
