// v0.12 PRIVATE: owner-pinned per-(ChatGPT account, host) operation gate.
// No listener, tunnel change, OAuth requirement or OS privilege elevation.
// This gate is *not* wired to installed Core. Trusted providers come from the
// owner bootstrap, never MCP parameters, remote headers or model-supplied IDs.
import {isProxy} from 'node:util/types';
import {normalizeV2Route} from './v2-routing-contract.mjs';
import {executeV2BoundOperation} from './v2-authorized-operation.mjs';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH=/^[a-f0-9]{64}$/;
const BINDING=/^[a-f0-9]{32,64}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
function snapshotJson(value,state={nodes:0,bytes:0,seen:new WeakSet()},depth=0){
  if(++state.nodes>10000||depth>32)fail('V2_PRIVATE_OPERATION_ARGS_INVALID');
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='string'){
    state.bytes+=Buffer.byteLength(value,'utf8');
    if(state.bytes>65536)fail('V2_PRIVATE_OPERATION_ARGS_INVALID');
    return value;
  }
  if(typeof value==='number'){
    if(!Number.isFinite(value))fail('V2_PRIVATE_OPERATION_ARGS_INVALID');
    return value;
  }
  if(typeof value!=='object'||isProxy(value)||state.seen.has(value))
    fail('V2_PRIVATE_OPERATION_ARGS_INVALID');
  state.seen.add(value);
  if(Array.isArray(value)){
    if(Object.getPrototypeOf(value)!==Array.prototype||value.length>10000
      ||Reflect.ownKeys(value).length!==value.length+1)
      fail('V2_PRIVATE_OPERATION_ARGS_INVALID');
    const clone=[];
    for(let i=0;i<value.length;i++){
      const d=Object.getOwnPropertyDescriptor(value,String(i));
      if(!d||!Object.hasOwn(d,'value')||d.enumerable!==true)
        fail('V2_PRIVATE_OPERATION_ARGS_INVALID');
      clone.push(snapshotJson(d.value,state,depth+1));
    }
    return Object.freeze(clone);
  }
  const out=exact(value,Object.keys(value),'V2_PRIVATE_OPERATION_ARGS_INVALID');
  const clone=Object.create(null);
  for(const key of Object.keys(out)){
    if(['__proto__','constructor','prototype'].includes(key))
      fail('V2_PRIVATE_OPERATION_ARGS_INVALID');
    state.bytes+=Buffer.byteLength(key,'utf8');
    if(state.bytes>65536)fail('V2_PRIVATE_OPERATION_ARGS_INVALID');
    clone[key]=snapshotJson(out[key],state,depth+1);
  }
  return Object.freeze(clone);
}


// Shared by PRIVATE ingress and operation gate: no mutation is possible
// between the source Core schema check, signed grant and effect invocation.
export function snapshotV2PrivateOperationArguments(value){
  const immutable=snapshotJson(value);
  if(!immutable||typeof immutable!=='object'||Array.isArray(immutable))
    fail('V2_PRIVATE_OPERATION_ARGS_INVALID');
  return immutable;
}

function exact(value,fields,code){
  if(!value||typeof value!=='object'||Array.isArray(value)||isProxy(value)
    ||![Object.prototype,null].includes(Object.getPrototypeOf(value)))
    fail(code);
  const keys=Reflect.ownKeys(value);
  if(keys.length!==fields.length||keys.some(key=>
    typeof key!=='string'||!fields.includes(key)))fail(code);
  const out=Object.create(null);
  for(const key of fields){
    const d=Object.getOwnPropertyDescriptor(value,key);
    if(!d||d.enumerable!==true||!Object.hasOwn(d,'value'))fail(code);
    out[key]=d.value;
  }
  return Object.freeze(out);
}

function strictRoute(value){
  const v=exact(value,['hostId','principalId','profileId','conversationId',
    'operationId','target'],'V2_PRIVATE_ROUTE_REQUIRED');
  const target=exact(v.target,['kind','id'],'V2_PRIVATE_ROUTE_REQUIRED');
  return normalizeV2Route({...v,target:{...target}});
}

export function createV2PrivatePairOperationGate({
  hostId,profileId,principalId,expectedTunnelIdHash,expectedOwnerSidHash,
  attestTransport,resolveOwnerContext,readCurrentOwnerSidHash,
  verifyExactNativeGrant,withLease,receiptStore,execute,now=Date.now
}={}){
  if(![hostId,profileId,principalId].every(v=>typeof v==='string'
    &&ID.test(v)&&v!=='.'&&v!=='..')
    ||![expectedTunnelIdHash,expectedOwnerSidHash].every(v=>
      typeof v==='string'&&HASH.test(v))
    ||[attestTransport,resolveOwnerContext,readCurrentOwnerSidHash,
      verifyExactNativeGrant,withLease,execute,now].some(f=>typeof f!=='function')
    ||typeof receiptStore?.execute!=='function')
    fail('V2_PRIVATE_OPERATION_BOOTSTRAP_REQUIRED');

  async function verify(request,route){
    // A known TLS peer is not proof of human authority; require both the
    // independently owner-enrolled pair AND a fresh native owner binding.
    const transport=await attestTransport(request);
    if(transport?.authenticated!==true
      ||transport.peerType!=='owner-pinned-private-tunnel-mtls'
      ||transport.sessionSource!=='native-owner-private-pair')
      fail('V2_PRIVATE_OPERATION_TRANSPORT_REQUIRED');
    const before=await readCurrentOwnerSidHash();
    if(before!==expectedOwnerSidHash)
      fail('V2_PRIVATE_OPERATION_OWNER_CHANGED');
    let ownerContext;
    // Native owner resolver selects by the independently normalized route;
    // never a mutable global current-chat pointer shared across sessions.
    try{ownerContext=await resolveOwnerContext(route);}
    catch{fail('V2_PRIVATE_OPERATION_OWNER_CONTEXT_REQUIRED');}
    const c=exact(ownerContext,
      ['source','hostId','profileId','principalId','conversationId',
        'bindingId','ownerSidHash','tunnelIdHash','expiresAtMs'],
      'V2_PRIVATE_OPERATION_OWNER_CONTEXT_REQUIRED');
    const after=await readCurrentOwnerSidHash();
    const timestamp=now();
    if(before!==after||after!==expectedOwnerSidHash)
      fail('V2_PRIVATE_OPERATION_OWNER_CHANGED');
    if(c.source!=='native-owner-attested'||c.hostId!==hostId
      ||c.profileId!==profileId||c.principalId!==principalId
      ||c.conversationId!==route.conversationId
      ||c.ownerSidHash!==expectedOwnerSidHash
      ||c.tunnelIdHash!==expectedTunnelIdHash
      ||typeof c.bindingId!=='string'||!BINDING.test(c.bindingId)
      ||!Number.isSafeInteger(timestamp)||!Number.isSafeInteger(c.expiresAtMs)
      ||c.expiresAtMs<=timestamp)
      fail('V2_PRIVATE_OPERATION_BINDING_REQUIRED');
    return c;
  }

  return Object.freeze({
    async execute({request,route,tool,arguments:args={}}={}){
      const frozenArgs=snapshotV2PrivateOperationArguments(args);
      const r=strictRoute(route);
      if(r.hostId!==hostId||r.profileId!==profileId
        ||r.principalId!==principalId)
        fail('V2_PRIVATE_OPERATION_PAIR_MISMATCH');
      // Do not run any caller-selected tool until the exact pair and native
      // owner seat are reverified; a grant is *per action*, not per socket.
      await verify(request,r);
      return executeV2BoundOperation(r,{
        observedCaller:async()=>{
          await verify(request,r);
          return Object.freeze({hostId,profileId,principalId,
            conversationId:r.conversationId});
        },
        hasGrant:async(grantRoute,grantTool)=>{
          const c=await verify(request,r);
          // This callback must check native signature, exact route/action,
          // binding epoch, grant revision, expiry and revocation at each call.
          return await verifyExactNativeGrant(Object.freeze({
            route:grantRoute,tool:grantTool,arguments:frozenArgs,ownerContext:c
          }))===true;
        },
        withLease,receiptStore,
        // At-most-once must detect changed arguments for the SAME operationId.
        // Existing MutationIdempotencyStore retains only its input digest.
        receiptInput:Object.freeze({route:r,arguments:frozenArgs}),
        // The exact verified tool identity must reach the real Core effect
        // after admission; a mutable shared "currentTool" is never authority.
        // Third argument preserves existing (route,args) callbacks.
        execute:r=>execute(r,frozenArgs,tool)
      },tool);
    }
  });
}
