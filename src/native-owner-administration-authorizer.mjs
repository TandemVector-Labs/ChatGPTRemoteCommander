import {isProxy} from 'node:util/types';
import {normalizeV2Route} from './v2-routing-contract.mjs';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH=/^[a-f0-9]{64}$/;
const BINDING=/^[a-f0-9]{32,64}$/;
const WORKER=/^cw_[a-f0-9]{64}$/;
const TOOL=/^(?=.{1,80}$)[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const OWNER_FIELDS=Object.freeze([
  'source','hostId','profileId','principalId','conversationId',
  'bindingId','ownerSidHash','expiresAtMs'
]);
const WORKER_FIELDS=Object.freeze([
  'hostId','principalId','profileId','conversationId','bindingId','workerId',
  'keyId','ownerSidHash','deviceProvider','deviceIdHash','tunnelProvider',
  'tunnelIdHash','capabilityPolicyDigest'
]);
const fail=code=>{throw Object.assign(new Error(code),{code});};

function exact(value,fields,code){
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
function safeId(value){return typeof value==='string'&&ID.test(value)&&value!=='.'&&value!=='..';}
function ownerOf(value){
  const o=exact(value,OWNER_FIELDS,'NATIVE_OWNER_ADMIN_CONTEXT_INVALID');
  if(o.source!=='native-owner-attested'
    ||!safeId(o.hostId)||!safeId(o.profileId)||!safeId(o.principalId)
    ||!safeId(o.conversationId)||!BINDING.test(o.bindingId)
    ||!HASH.test(o.ownerSidHash)||!Number.isSafeInteger(o.expiresAtMs))
    fail('NATIVE_OWNER_ADMIN_CONTEXT_INVALID');
  return Object.freeze(o);
}
function workerOf(value){
  const w=exact(value,WORKER_FIELDS,'NATIVE_OWNER_ADMIN_WORKER_INVALID');
  for(const key of ['hostId','profileId','principalId','conversationId'])
    if(!safeId(w[key]))fail('NATIVE_OWNER_ADMIN_WORKER_INVALID');
  if(!BINDING.test(w.bindingId)||!WORKER.test(w.workerId)
    ||!HASH.test(w.keyId)||!HASH.test(w.ownerSidHash)
    ||!['tailscale','native-key-store'].includes(w.deviceProvider)
    ||!HASH.test(w.deviceIdHash)||w.tunnelProvider!=='openai-secure-mcp-tunnel'
    ||!HASH.test(w.tunnelIdHash)||!HASH.test(w.capabilityPolicyDigest))
    fail('NATIVE_OWNER_ADMIN_WORKER_INVALID');
  return Object.freeze(w);
}
function sameOwner(a,b){
  return a.source===b.source&&a.hostId===b.hostId&&a.profileId===b.profileId
    &&a.principalId===b.principalId&&a.conversationId===b.conversationId
    &&a.bindingId===b.bindingId&&a.ownerSidHash===b.ownerSidHash
    &&a.expiresAtMs===b.expiresAtMs;
}
function routeMatchesOwner(route,owner){
  return route.hostId===owner.hostId&&route.profileId===owner.profileId
    &&route.principalId===owner.principalId
    &&route.conversationId===owner.conversationId;
}
function normalizeRequest(value,now){
  if(!value||typeof value!=='object'||Array.isArray(value)||isProxy(value))fail('NATIVE_OWNER_ADMIN_REQUEST_INVALID');
  if(!Object.hasOwn(value,'kind')){
    const r=exact(value,['actor','route','tool','status'],'NATIVE_OWNER_ADMIN_REQUEST_INVALID');
    const route=normalizeV2Route(r.route);
    if(!safeId(r.actor)||r.actor!==route.principalId||typeof r.tool!=='string'
      ||!TOOL.test(r.tool)||!['ENABLED','REVOKED'].includes(r.status))
      fail('NATIVE_OWNER_ADMIN_REQUEST_INVALID');
    return Object.freeze({kind:'base-route-tool-grant',actor:r.actor,route,tool:r.tool,
      status:r.status,reason:null,expiresAtMs:null,workerContext:null});
  }
  if(value.kind==='worker-enrollment-grant'){
    const r=exact(value,[
      'kind','action','status','actor','workerContext','reason','expiresAtMs'
    ],'NATIVE_OWNER_ADMIN_REQUEST_INVALID');
    const workerContext=workerOf(r.workerContext);
    if(r.action!==r.status||!['ACTIVE','REVOKED'].includes(r.status)
      ||!safeId(r.actor)||r.actor!==workerContext.principalId
      ||typeof r.reason!=='string'||r.reason.trim().length<5||r.reason.length>400
      ||(r.status==='ACTIVE'
        ?!Number.isSafeInteger(r.expiresAtMs)||r.expiresAtMs<=now
        :r.expiresAtMs!==null))
      fail('NATIVE_OWNER_ADMIN_REQUEST_INVALID');
    return Object.freeze({kind:r.kind,actor:r.actor,status:r.status,
      reason:r.reason.trim(),expiresAtMs:r.expiresAtMs,workerContext,route:null,tool:null});
  }
  if(value.kind==='worker-tool-grant'){
    const r=exact(value,[
      'kind','action','status','actor','route','tool','workerContext','reason','expiresAtMs'
    ],'NATIVE_OWNER_ADMIN_REQUEST_INVALID');
    const route=normalizeV2Route(r.route),workerContext=workerOf(r.workerContext);
    if(r.action!==r.status||!['ENABLED','REVOKED'].includes(r.status)
      ||!safeId(r.actor)||r.actor!==workerContext.principalId
      ||!routeMatchesOwner(route,workerContext)||typeof r.tool!=='string'||!TOOL.test(r.tool)
      ||typeof r.reason!=='string'||r.reason.trim().length<5||r.reason.length>400
      ||(r.status==='ENABLED'
        ?!Number.isSafeInteger(r.expiresAtMs)||r.expiresAtMs<=now
        :r.expiresAtMs!==null))
      fail('NATIVE_OWNER_ADMIN_REQUEST_INVALID');
    return Object.freeze({kind:r.kind,actor:r.actor,status:r.status,
      reason:r.reason.trim(),expiresAtMs:r.expiresAtMs,workerContext,route,tool:r.tool});
  }
  fail('NATIVE_OWNER_ADMIN_REQUEST_INVALID');
}
function promptFor(request,owner,snapshot){
  const lines=[
    'Approve this exact Commander authorization change?',
    'Kind: '+request.kind,
    'Action: '+request.status,
    'Actor: '+request.actor,
    'Host: '+owner.hostId,
    'Profile: '+owner.profileId,
    'Principal: '+owner.principalId,
    'Conversation: '+owner.conversationId,
    'OS session: '+snapshot.osSessionId+' / '+snapshot.seatId,
    'Owner binding: '+owner.bindingId.slice(0,12),
    'Owner identity: '+owner.ownerSidHash.slice(0,12)
  ];
  if(request.route){
    lines.push('Operation: '+request.route.operationId);
    lines.push('Target: '+request.route.target.kind+'/'+request.route.target.id);
  }
  if(request.tool)lines.push('Tool: '+request.tool);
  if(request.workerContext){
    const w=request.workerContext;
    lines.push('Worker: '+w.workerId);
    lines.push('Key: '+w.keyId.slice(0,12));
    lines.push('Device: '+w.deviceProvider+' '+w.deviceIdHash.slice(0,12));
    lines.push('Tunnel: '+w.tunnelProvider+' '+w.tunnelIdHash.slice(0,12));
    lines.push('Policy: '+w.capabilityPolicyDigest.slice(0,12));
  }
  if(request.expiresAtMs!==null)lines.push('Expires at (UTC ms): '+request.expiresAtMs);
  if(request.reason)lines.push('Reason: '+request.reason);
  lines.push('','This is an app-level grant only; it does not elevate OS privileges.',
    'Deny if you did not initiate this exact change.');
  return lines.join('\n');
}

/** Async native owner consent for V2GrantRegistry's grant mutations. */
export function createNativeOwnerAdministrationAuthorizer({
  ownerSessionProvider,nativeSessionBindings,now=Date.now
}={}){
  if(typeof ownerSessionProvider?.getOwnerSessionSnapshot!=='function'
    ||typeof ownerSessionProvider?.requestConsent!=='function'
    ||typeof nativeSessionBindings?.resolveNativeOwnerContext!=='function'
    ||typeof now!=='function')fail('NATIVE_OWNER_ADMIN_BOOTSTRAP_REQUIRED');
  return async function authorizeAdministration(raw){
    try{
      const t=now();
      if(!Number.isSafeInteger(t)||t<0)return false;
      const request=normalizeRequest(raw,t);
      const conversationId=request.workerContext?.conversationId
        ??request.route?.conversationId;
      if(!safeId(conversationId))return false;
      const before=ownerOf(await nativeSessionBindings.resolveNativeOwnerContext(conversationId));
      const snapshot=await ownerSessionProvider.getOwnerSessionSnapshot();
      if(before.expiresAtMs<=t||before.ownerSidHash!==snapshot.ownerSidHash
        ||(request.workerContext&&(
          request.workerContext.hostId!==before.hostId
          ||request.workerContext.profileId!==before.profileId
          ||request.workerContext.principalId!==before.principalId
          ||request.workerContext.conversationId!==before.conversationId
          ||request.workerContext.bindingId!==before.bindingId
          ||request.workerContext.ownerSidHash!==before.ownerSidHash
        ))||(request.route&&!routeMatchesOwner(request.route,before)))
        return false;
      if(request.expiresAtMs!==null&&request.expiresAtMs>before.expiresAtMs)return false;
      const approved=await ownerSessionProvider.requestConsent({
        title:'Commander — Confirm exact access grant',
        message:promptFor(request,before,snapshot),
        expectedOwnerSidHash:before.ownerSidHash,
        expectedOsSessionId:snapshot.osSessionId
      });
      if(approved!==true)return false;
      const after=ownerOf(await nativeSessionBindings.resolveNativeOwnerContext(conversationId));
      const afterSnapshot=await ownerSessionProvider.getOwnerSessionSnapshot();
      return sameOwner(before,after)
        &&afterSnapshot.ownerSidHash===snapshot.ownerSidHash
        &&afterSnapshot.osSessionId===snapshot.osSessionId
        &&afterSnapshot.seatId===snapshot.seatId
        &&afterSnapshot.displayId===snapshot.displayId
        &&afterSnapshot.sessionType===snapshot.sessionType
        &&afterSnapshot.leaderPid===snapshot.leaderPid;
    }catch{return false;}
  };
}
