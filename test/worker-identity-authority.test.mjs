import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  createWorkerIdentityAuthority, deriveWorkerId, verifyWorkerRegistration
} from '../src/worker-identity-authority.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64),E='e'.repeat(64);
const bindingA='1'.repeat(32),bindingB='2'.repeat(32);
const pair=()=>generateKeyPairSync('ed25519');

function fixture(options={}){
  const state={
    now:1_800_000_000_000,
    context:{
      source:'native-owner-attested',hostId:'aliemad-labtop',profileId:'emad',
      principalId:'owner-1',conversationId:'chat-1',bindingId:bindingA,
      ownerSidHash:B,expiresAtMs:1_800_000_120_000
    },
    device:{
      source:'native-device-attestor',provider:'native-key-store',deviceIdHash:A,
      ownerSidHash:B,verified:true,attestedAtMs:1_799_999_999_000,
      expiresAtMs:1_800_000_300_000,attestedAtMsOverride:null
    },
    transport:{
      source:'native-tunnel-attestor',provider:'openai-secure-mcp-tunnel',
      profileId:'emad',tunnelIdHash:C,ownerSidHash:B,authenticated:true,
      controlPlanePollOk:true,healthzStatus:200,readyzStatus:200,
      lastPollAtMs:1_799_999_999_000,expiresAtMs:1_800_000_060_000,lastPollAtMsOverride:null
    },
    policyDigest:D,grantRevoked:false,grantRevision:1,grantMissingRevision:false,grantPolicyDigest:null,grantExpiresAtMs:null,
    allowedTools:new Set(['worker.register','worker.revoke','read_text']),
    onAuthorize:null
  };
  const records=new Map(),revocations=new Map();
  const registry={
    async get(workerId){return records.get(workerId)??null;},
    async isRevoked(workerId,bindingId){return revocations.has(workerId+':'+bindingId);},
    async register(envelope,{expectedPreviousBindingId,expectedPreviousState}){
      const workerId=envelope.claims.workerId,old=records.get(workerId);
      if(!old){
        if(expectedPreviousState!=='EMPTY'||expectedPreviousBindingId!==null)return false;
      }else{
        const oldBindingId=old.claims.bindingId;
        const revoked=revocations.has(workerId+':'+oldBindingId);
        const expired=old.claims.expiresAtMs<=state.now;
        const currentState=revoked?'REVOKED':expired?'EXPIRED':'ACTIVE';
        if(oldBindingId!==expectedPreviousBindingId||currentState!==expectedPreviousState)return false;
      }
      records.set(workerId,envelope);
      return true;
    },
    async revoke(workerId,bindingId,receipt,{expectedSignature}){
      const old=records.get(workerId);
      if(!old||old.claims.bindingId!==bindingId||old.signature!==expectedSignature)return false;
      revocations.set(workerId+':'+bindingId,receipt);
      return true;
    },
    inspect(){return{records,revocations};}
  };
  const ownerGrant=request=>{
    const grant={
      source:'native-owner-attested',
      hostId:request.hostId,profileId:request.profileId,
      principalId:request.principalId,conversationId:request.conversationId,
      bindingId:request.bindingId,workerId:request.workerId,keyId:request.keyId,
      ownerSidHash:request.ownerSidHash,deviceProvider:request.deviceProvider,
      deviceIdHash:request.deviceIdHash,tunnelProvider:request.tunnelProvider,
      tunnelIdHash:request.tunnelIdHash,
      capabilityPolicyDigest:state.grantPolicyDigest??request.capabilityPolicyDigest,
      revision:state.grantRevision,
      issuedAtMs:state.now-1000,expiresAtMs:state.grantExpiresAtMs??state.context.expiresAtMs,
      status:state.grantRevoked?'REVOKED':'ACTIVE'
    };
    if(state.grantMissingRevision)delete grant.revision;
    return grant;
  };
  const authority=createWorkerIdentityAuthority({
    hostId:'aliemad-labtop',profileId:'emad',issuer:'commander.local',audience:'remote-commander',
    resolveDeviceIdentity:async()=>{const {attestedAtMsOverride,...device}=state.device;return{...device,attestedAtMs:attestedAtMsOverride??state.now-1000,expiresAtMs:state.now+300000};},
    resolveTransportIdentity:async()=>{const {lastPollAtMsOverride,...transport}=state.transport;return{...transport,lastPollAtMs:lastPollAtMsOverride??state.now-1000,expiresAtMs:state.now+60000};},
    resolveOwnerContext:async()=>({...state.context}),
    resolveOwnerGrant:async request=>ownerGrant(request),
    resolveCapabilityPolicyDigest:async()=>state.policyDigest,
    authorizeExactInvocation:async(route,invocation,workerContext)=>{
      if(state.onAuthorize)await state.onAuthorize(route,invocation,workerContext);
      return state.allowedTools.has(invocation.tool);
    },
    registry,now:()=>state.now,
    maxEnrollmentTtlMs:900000,maxDeviceAgeMs:300000,maxTransportAgeMs:120000
  });
  return{state,registry,authority,ownerGrant};
}
function codeIs(code){
  return error=>error?.workerIdentityCode===code;
}
async function rejectsCode(promise,code){
  await assert.rejects(promise,codeIs(code));
}
async function enroll(f,p=pair()){
  const envelope=await f.authority.registerWorker({privateKey:p.privateKey});
  return{envelope,pair:p,workerId:envelope.claims.workerId};
}

test('registers a stable Ed25519 worker identity without storing private or tunnel credentials',async()=>{
  const f=fixture(),keys=pair();
  const {envelope,workerId}=await enroll(f,keys);
  const verified=f.authority.verifyRegistration(envelope);
  assert.equal(verified.keyId,envelope.keyId);
  assert.equal(verified.claims.workerId,workerId);
  assert.match(workerId,/^cw_[a-f0-9]{64}$/);
  assert.equal(envelope.claims.deviceProvider,'native-key-store');
  assert.equal(envelope.claims.tunnelProvider,'openai-secure-mcp-tunnel');
  assert.equal(envelope.claims.tunnelIdHash,C);
  assert.equal(Object.hasOwn(envelope,'privateKey'),false);
  assert.equal(JSON.stringify(envelope).includes('CONTROL_PLANE_API_KEY'),false);
  assert.equal(JSON.stringify(envelope).includes('tunnel_'),false);
  assert.equal(f.registry.inspect().records.size,1);
});

test('workerId is stable across chat grants but changes with key, device, profile or OS owner',()=>{
  const keys=pair(),keyId=sha(Buffer.from('not-used'));
  const publicDer=keys.publicKey.export({type:'spki',format:'der'});
  const actualKeyId=sha(publicDer);
  const base={hostId:'aliemad-labtop',profileId:'emad',ownerSidHash:B,
    deviceProvider:'native-key-store',deviceIdHash:A,keyId:actualKeyId};
  const workerId=deriveWorkerId(base);
  assert.equal(deriveWorkerId({...base}),workerId);
  assert.notEqual(deriveWorkerId({...base,deviceIdHash:E}),workerId);
  assert.notEqual(deriveWorkerId({...base,ownerSidHash:E}),workerId);
  assert.notEqual(deriveWorkerId({...base,profileId:'saeed'}),workerId);
  assert.notEqual(deriveWorkerId({...base,keyId:keyId}),workerId);
});

test('same active binding registration is idempotent and does not rotate the signed envelope',async()=>{
  const f=fixture(),keys=pair();
  const first=await f.authority.registerWorker({privateKey:keys.privateKey});
  const second=await f.authority.registerWorker({privateKey:keys.privateKey});
  assert.equal(second.signature,first.signature);
  assert.equal(f.registry.inspect().records.size,1);
});

test('does not silently replace an active registration with a different owner binding',async()=>{
  const f=fixture(),keys=pair();
  const first=await f.authority.registerWorker({privateKey:keys.privateKey});
  f.state.context={...f.state.context,bindingId:bindingB};
  await rejectsCode(f.authority.registerWorker({privateKey:keys.privateKey}),
    'WORKER_IDENTITY_ACTIVE_BINDING_CONFLICT');
  assert.equal((await f.registry.get(first.claims.workerId)).signature,first.signature);
});

test('re-enrolls the same stable worker only after revocation and a new owner binding epoch',async()=>{
  const f=fixture(),keys=pair();
  const first=await f.authority.registerWorker({privateKey:keys.privateKey});
  const revoked=await f.authority.revokeWorker({workerId:first.claims.workerId,reasonCode:'owner-revoked'});
  assert.equal(revoked.revoked,true);
  f.state.context={...f.state.context,bindingId:bindingB};
  const second=await f.authority.registerWorker({privateKey:keys.privateKey});
  assert.equal(second.claims.workerId,first.claims.workerId);
  assert.notEqual(second.claims.bindingId,first.claims.bindingId);
});

test('replaces an expired registration only under a new owner binding epoch',async()=>{
  const f=fixture(),keys=pair();
  const authority=createWorkerIdentityAuthorityForShortTtl(f);
  const first=await authority.registerWorker({privateKey:keys.privateKey});
  f.state.now+=2000;
  f.state.context={...f.state.context,bindingId:bindingB,expiresAtMs:f.state.now+120000};
  const second=await authority.registerWorker({privateKey:keys.privateKey});
  assert.equal(second.claims.workerId,first.claims.workerId);
  assert.notEqual(second.claims.bindingId,first.claims.bindingId);
});

function createWorkerIdentityAuthorityForShortTtl(f){
  return createWorkerIdentityAuthority({
    hostId:'aliemad-labtop',profileId:'emad',issuer:'commander.local',audience:'remote-commander',
    resolveDeviceIdentity:async()=>{const {attestedAtMsOverride,...device}=f.state.device;return{...device,attestedAtMs:attestedAtMsOverride??f.state.now-1000,expiresAtMs:f.state.now+300000};},
    resolveTransportIdentity:async()=>{const {lastPollAtMsOverride,...transport}=f.state.transport;return{...transport,lastPollAtMs:lastPollAtMsOverride??f.state.now-1000,expiresAtMs:f.state.now+60000};},
    resolveOwnerContext:async()=>({...f.state.context}),
    resolveOwnerGrant:async request=>f.ownerGrant(request),
    resolveCapabilityPolicyDigest:async()=>f.state.policyDigest,
    authorizeExactInvocation:async(route,invocation)=>f.state.allowedTools.has(invocation.tool),
    registry:f.registry,now:()=>f.state.now,maxEnrollmentTtlMs:1000,
    maxDeviceAgeMs:300000,maxTransportAgeMs:120000
  });
}

test('requires fresh device attestation and same OS owner SID across device and tunnel',async()=>{
  const f=fixture();
  f.state.device={...f.state.device,attestedAtMsOverride:f.state.now-600000};
  await rejectsCode(f.authority.registerWorker({privateKey:pair().privateKey}),
    'WORKER_IDENTITY_DEVICE_UNVERIFIED');
  const g=fixture();
  g.state.transport={...g.state.transport,ownerSidHash:E};
  await rejectsCode(g.authority.registerWorker({privateKey:pair().privateKey}),
    'WORKER_IDENTITY_TUNNEL_UNVERIFIED');
});

test('requires ownerSidHash in native owner context and exact equality with device/tunnel identity',async t=>{
  await t.test('missing owner SID',async()=>{
    const f=fixture();
    delete f.state.context.ownerSidHash;
    await rejectsCode(f.authority.registerWorker({privateKey:pair().privateKey}),
      'WORKER_IDENTITY_OWNER_CONTEXT_INVALID');
  });
  await t.test('malformed owner SID',async()=>{
    const f=fixture();
    f.state.context={...f.state.context,ownerSidHash:'not-a-digest'};
    await rejectsCode(f.authority.registerWorker({privateKey:pair().privateKey}),
      'WORKER_IDENTITY_OWNER_CONTEXT_INVALID');
  });
  await t.test('owner context SID differs from device SID',async()=>{
    const f=fixture();
    f.state.context={...f.state.context,ownerSidHash:E};
    await rejectsCode(f.authority.registerWorker({privateKey:pair().privateKey}),
      'WORKER_IDENTITY_OWNER_SID_MISMATCH');
  });
});

test('rechecks native owner SID binding after asynchronous worker authorization',async()=>{
  const f=fixture(),{workerId}=await enroll(f);
  f.state.onAuthorize=async(_route,invocation)=>{
    if(invocation.tool==='read_text')
      f.state.context={...f.state.context,ownerSidHash:E};
  };
  await rejectsCode(f.authority.authorizeWorker({
    workerId,invocation:{tool:'read_text',arguments:{path:'README.md'}}
  }),'WORKER_IDENTITY_OWNER_SID_MISMATCH');
});

test('requires authenticated tunnel health and a fresh successful control-plane poll',async()=>{
  for(const change of [
    {controlPlanePollOk:false},
    {healthzStatus:503},
    {readyzStatus:503},
    {lastPollAtMsOverride:1_799_999_000_000},
    {authenticated:false}
  ]){
    const f=fixture();f.state.transport={...f.state.transport,...change};
    await rejectsCode(f.authority.registerWorker({privateKey:pair().privateKey}),
      'WORKER_IDENTITY_TUNNEL_UNVERIFIED');
  }
});

test('rejects missing, expired, revoked or scope-mismatched native owner grants',async()=>{
  for(const change of [
    {grantRevoked:true},
    {grantExpiresAtMs:1_799_999_999_000},
    {grantPolicyDigest:E},
    {grantRevision:0},
    {grantRevision:1.5},
    {grantMissingRevision:true}
  ]){
    const f=fixture();
    if(change.grantRevoked)f.state.grantRevoked=true;
    if(change.grantExpiresAtMs)f.state.grantExpiresAtMs=change.grantExpiresAtMs;
    if(change.grantPolicyDigest)f.state.grantPolicyDigest=change.grantPolicyDigest;
    if(Object.hasOwn(change,'grantRevision'))f.state.grantRevision=change.grantRevision;
    if(change.grantMissingRevision)f.state.grantMissingRevision=true;
    await rejectsCode(f.authority.registerWorker({privateKey:pair().privateKey}),
      'WORKER_IDENTITY_OWNER_GRANT_INVALID');
  }
});

test('requires the explicit worker.register owner action before registry write',async()=>{
  const f=fixture();f.state.allowedTools.delete('worker.register');
  await rejectsCode(f.authority.registerWorker({privateKey:pair().privateKey}),
    'WORKER_IDENTITY_REGISTER_NOT_AUTHORIZED');
  assert.equal(f.registry.inspect().records.size,0);
});

test('authorization rechecks exact chat, owner binding, device, tunnel, policy and grant on every call',async()=>{
  const f=fixture(),{workerId}=await enroll(f);
  const allowed=await f.authority.authorizeWorker({
    workerId,invocation:{tool:'read_text',arguments:{path:'docs/PROJECT_ENGINE.md'}}
  });
  assert.equal(allowed.authorized,true);
  const cases=[
    [s=>{s.context={...s.context,conversationId:'chat-other'};},'WORKER_IDENTITY_SCOPE_MISMATCH'],
    [s=>{s.context={...s.context,bindingId:bindingB};},'WORKER_IDENTITY_SCOPE_MISMATCH'],
    [s=>{s.device={...s.device,deviceIdHash:E};},'WORKER_IDENTITY_SCOPE_MISMATCH'],
    [s=>{s.transport={...s.transport,tunnelIdHash:E};},'WORKER_IDENTITY_SCOPE_MISMATCH'],
    [s=>{s.policyDigest=E;},'WORKER_IDENTITY_SCOPE_MISMATCH'],
    [s=>{s.grantRevoked=true;},'WORKER_IDENTITY_OWNER_GRANT_INVALID']
  ];
  for(const [mutate,expected] of cases){
    const g=fixture(),{workerId:id}=await enroll(g);
    mutate(g.state);
    await rejectsCode(g.authority.authorizeWorker({
      workerId:id,invocation:{tool:'read_text',arguments:{path:'docs/PROJECT_ENGINE.md'}}
    }),expected);
  }
});

test('exact tool grants receive the verified worker identity and current owner binding epoch',async()=>{
  const f=fixture(),observed=[];
  f.state.onAuthorize=async(route,invocation,workerContext)=>{
    observed.push({route,invocation,workerContext});
  };
  const {workerId,envelope}=await enroll(f);
  await f.authority.authorizeWorker({
    workerId,invocation:{tool:'read_text',arguments:{path:'README.md'}}
  });
  await f.authority.revokeWorker({workerId,reasonCode:'owner-request'});
  assert.deepEqual(observed.map(x=>x.invocation.tool),['worker.register','read_text','worker.revoke']);
  for(const item of observed){
    const c=item.workerContext;
    assert.equal(c.hostId,'aliemad-labtop');
    assert.equal(c.profileId,'emad');
    assert.equal(c.principalId,'owner-1');
    assert.equal(c.conversationId,'chat-1');
    assert.equal(c.bindingId,envelope.claims.bindingId);
    assert.equal(c.workerId,workerId);
    assert.equal(c.keyId,envelope.keyId);
    assert.equal(c.ownerSidHash,B);
    assert.equal(c.deviceProvider,'native-key-store');
    assert.equal(c.deviceIdHash,A);
    assert.equal(c.tunnelProvider,'openai-secure-mcp-tunnel');
    assert.equal(c.tunnelIdHash,C);
    assert.equal(c.capabilityPolicyDigest,D);
    assert.equal(item.route.conversationId,c.conversationId);
  }
});

test('signed worker registration is bound to the exact owner-grant revision',async()=>{
  const f=fixture(),keys=pair();
  const envelope=await f.authority.registerWorker({privateKey:keys.privateKey});
  const workerId=envelope.claims.workerId;
  f.state.grantRevision++;
  await rejectsCode(f.authority.authorizeWorker({
    workerId,invocation:{tool:'read_text',arguments:{path:'README.md'}}
  }),'WORKER_IDENTITY_OWNER_GRANT_CHANGED');
  await rejectsCode(f.authority.registerWorker({privateKey:keys.privateKey}),
    'WORKER_IDENTITY_ACTIVE_BINDING_CONFLICT');
});

test('passes the exact owner-grant revision into V1-01 invocation context',async()=>{
  const f=fixture();let observed=null;
  f.state.onAuthorize=async(_route,invocation,workerContext)=>{
    if(invocation.tool==='worker.register')observed=workerContext;
  };
  await enroll(f);
  assert.equal(observed?.workerId?.startsWith('cw_'),true);
  assert.equal(observed?.bindingId,bindingA);
  assert.equal(observed?.grantRevision,1);
});

test('the owner exact-invocation callback remains the final tool authority',async()=>{
  const f=fixture(),{workerId}=await enroll(f);
  await rejectsCode(f.authority.authorizeWorker({
    workerId,invocation:{tool:'run_shell',arguments:{command:'whoami'}}
  }),'WORKER_IDENTITY_ACTION_NOT_AUTHORIZED');
});

test('rechecks owner context after an asynchronous authorization to prevent TOCTOU',async()=>{
  const f=fixture(),{workerId}=await enroll(f);
  f.state.onAuthorize=async(_route,invocation)=>{
    if(invocation.tool==='read_text')
      f.state.context={...f.state.context,bindingId:'f'.repeat(32)};
  };
  await rejectsCode(f.authority.authorizeWorker({
    workerId,invocation:{tool:'read_text',arguments:{path:'README.md'}}
  }),'WORKER_IDENTITY_TRUST_CHANGED');
});

test('rechecks owner grant after registration authorization before writing',async()=>{
  const f=fixture();
  f.state.onAuthorize=async(_route,invocation)=>{
    if(invocation.tool==='worker.register')f.state.grantRevoked=true;
  };
  await rejectsCode(f.authority.registerWorker({privateKey:pair().privateKey}),
    'WORKER_IDENTITY_OWNER_GRANT_INVALID');
  assert.equal(f.registry.inspect().records.size,0);
});

test('rechecks the durable worker-grant revision after asynchronous owner authorization',async()=>{
  const f=fixture(),{workerId}=await enroll(f);
  f.state.onAuthorize=async(_route,invocation)=>{
    if(invocation.tool==='read_text')f.state.grantRevision++;
  };
  await rejectsCode(f.authority.authorizeWorker({
    workerId,invocation:{tool:'read_text',arguments:{path:'README.md'}}
  }),'WORKER_IDENTITY_OWNER_GRANT_CHANGED');
});

test('revocation requires exact owner authorization and blocks later execution',async()=>{
  const f=fixture(),{workerId}=await enroll(f);
  f.state.allowedTools.delete('worker.revoke');
  await rejectsCode(f.authority.revokeWorker({workerId,reasonCode:'operator-request'}),
    'WORKER_IDENTITY_REVOKE_NOT_AUTHORIZED');
  f.state.allowedTools.add('worker.revoke');
  const receipt=await f.authority.revokeWorker({workerId,reasonCode:'operator-request'});
  assert.equal(receipt.revoked,true);
  assert.equal(await f.registry.isRevoked(workerId,bindingA),true);
  await rejectsCode(f.authority.authorizeWorker({
    workerId,invocation:{tool:'read_text',arguments:{path:'README.md'}}
  }),'WORKER_IDENTITY_REVOKED');
  const again=await f.authority.revokeWorker({workerId,reasonCode:'operator-request'});
  assert.equal(again.alreadyRevoked,true);
});

test('idempotent revoke still requires current exact worker.revoke authorization',async()=>{
  const f=fixture(),{workerId}=await enroll(f);
  const first=await f.authority.revokeWorker({workerId,reasonCode:'operator-request'});
  assert.equal(first.revoked,true);
  f.state.allowedTools.delete('worker.revoke');
  await rejectsCode(f.authority.revokeWorker({workerId,reasonCode:'operator-request'}),
    'WORKER_IDENTITY_REVOKE_NOT_AUTHORIZED');
  assert.equal(await f.registry.isRevoked(workerId,bindingA),true);
});

test('idempotent revoke rejects a changed originating chat or owner binding',async()=>{
  for(const change of [
    state=>{state.context={...state.context,conversationId:'chat-other'};},
    state=>{state.context={...state.context,bindingId:bindingB};}
  ]){
    const f=fixture(),{workerId}=await enroll(f);
    assert.equal((await f.authority.revokeWorker({workerId,reasonCode:'operator-request'})).revoked,true);
    change(f.state);
    await rejectsCode(f.authority.revokeWorker({workerId,reasonCode:'operator-request'}),
      'WORKER_IDENTITY_SCOPE_MISMATCH');
  }
});

test('rejects malformed Ed25519 key, extra request fields, proxies and accessor arguments',async()=>{
  const f=fixture(),rsa=generateKeyPairSync('rsa',{modulusLength:2048});
  await rejectsCode(f.authority.registerWorker({privateKey:rsa.privateKey}),
    'WORKER_IDENTITY_ED25519_PRIVATE_KEY_REQUIRED');
  await rejectsCode(f.authority.registerWorker({privateKey:pair().privateKey,workerId:'spoofed'}),
    'WORKER_IDENTITY_REGISTER_REQUEST_INVALID');
  const g=fixture(),{workerId}=await enroll(g);
  const args={};Object.defineProperty(args,'path',{enumerable:true,get(){return 'README.md';}});
  await rejectsCode(g.authority.authorizeWorker({
    workerId,invocation:{tool:'read_text',arguments:args}
  }),'WORKER_IDENTITY_INVOCATION_NOT_JSON');
  await rejectsCode(g.authority.authorizeWorker({
    workerId,invocation:{tool:'read_text',arguments:new Proxy({path:'README.md'},{})}
  }),'WORKER_IDENTITY_INVOCATION_INVALID');
});

test('rejects tampered signatures, public keys, claims and unknown schema fields',async()=>{
  const f=fixture(),{envelope}=await enroll(f);
  const tampered=structuredClone(envelope);
  tampered.claims.conversationId='chat-other';
  await rejectsCode(Promise.resolve().then(()=>verifyWorkerRegistration(tampered,{
    issuer:'commander.local',audience:'remote-commander',now:()=>f.state.now
  })),'WORKER_IDENTITY_SIGNATURE_INVALID');
  const badKey=structuredClone(envelope);badKey.publicKey='AA';
  await rejectsCode(Promise.resolve().then(()=>verifyWorkerRegistration(badKey,{
    issuer:'commander.local',audience:'remote-commander',now:()=>f.state.now
  })),'WORKER_IDENTITY_PUBLIC_KEY_INVALID');
  const extra=structuredClone(envelope);extra.claims.extra='unexpected';
  await rejectsCode(Promise.resolve().then(()=>verifyWorkerRegistration(extra,{
    issuer:'commander.local',audience:'remote-commander',now:()=>f.state.now
  })),'WORKER_IDENTITY_CLAIMS_INVALID');
  const badGrantRevision=structuredClone(envelope);badGrantRevision.claims.grantRevision=0;
  await rejectsCode(Promise.resolve().then(()=>verifyWorkerRegistration(badGrantRevision,{
    issuer:'commander.local',audience:'remote-commander',now:()=>f.state.now
  })),'WORKER_IDENTITY_CLAIMS_INVALID');
});

test('does not trust a caller-supplied workerId or public-key identity tuple',async()=>{
  const f=fixture(),keys=pair();
  const envelope=await f.authority.registerWorker({privateKey:keys.privateKey});
  const forged=structuredClone(envelope);
  forged.claims.workerId='cw_'+'9'.repeat(64);
  await rejectsCode(Promise.resolve().then(()=>verifyWorkerRegistration(forged,{
    issuer:'commander.local',audience:'remote-commander',now:()=>f.state.now
  })),'WORKER_IDENTITY_CLAIMS_INVALID');
});

test('rejects non-string binding identifiers without invoking attacker-controlled coercion',async()=>{
  let coercions=0;
  const hostile={[Symbol.toPrimitive](){coercions++;return bindingA;}};
  const f=fixture();f.state.context={...f.state.context,bindingId:hostile};
  await rejectsCode(f.authority.registerWorker({privateKey:pair().privateKey}),
    'WORKER_IDENTITY_OWNER_CONTEXT_INVALID');
  assert.equal(coercions,0);
  const h=fixture(),{envelope}=await enroll(h);
  const tampered=structuredClone(envelope);tampered.claims.bindingId=hostile;
  await rejectsCode(Promise.resolve().then(()=>verifyWorkerRegistration(tampered,{
    issuer:'commander.local',audience:'remote-commander',now:()=>h.state.now
  })),'WORKER_IDENTITY_CLAIMS_INVALID');
  assert.equal(coercions,0);
});

test('derivation rejects accessor-backed and proxy input without executing getters',()=>{
  let reads=0;
  const input={profileId:'emad',ownerSidHash:B,deviceProvider:'native-key-store',deviceIdHash:A,keyId:C};
  Object.defineProperty(input,'hostId',{enumerable:true,get(){reads++;return'aliemad-labtop';}});
  assert.throws(()=>deriveWorkerId(input),codeIs('WORKER_IDENTITY_DERIVATION_INPUT_INVALID'));
  assert.equal(reads,0);
  assert.throws(()=>deriveWorkerId(new Proxy({},{})),codeIs('WORKER_IDENTITY_DERIVATION_INPUT_INVALID'));
});

test('counts JSON object keys toward the invocation byte budget',async()=>{
  const f=fixture(),{workerId}=await enroll(f);
  const args={};args['k'.repeat(65537)]='x';
  await rejectsCode(f.authority.authorizeWorker({workerId,invocation:{tool:'read_text',arguments:args}}),
    'WORKER_IDENTITY_INVOCATION_BOUNDS');
});

test('rejects invalid expected issuer and audience values instead of skipping their checks',async()=>{
  const f=fixture(),{envelope}=await enroll(f);
  for(const options of [
    {issuer:{},audience:'remote-commander'},
    {issuer:'commander.local',audience:null}
  ]){
    await rejectsCode(Promise.resolve().then(()=>verifyWorkerRegistration(envelope,{
      ...options,now:()=>f.state.now
    })),'WORKER_IDENTITY_ENVELOPE_INVALID');
  }
});

test('requires a durable registry contract and every trusted provider at bootstrap',()=>{
  assert.throws(()=>createWorkerIdentityAuthority({hostId:'host',profileId:'profile'}),
    codeIs('WORKER_IDENTITY_TRUSTED_BOOTSTRAP_REQUIRED'));
});

test('expired registrations can be verified for replacement but never authorized',async()=>{
  const f=fixture(),keys=pair(),authority=createWorkerIdentityAuthorityForShortTtl(f);
  const first=await authority.registerWorker({privateKey:keys.privateKey});
  f.state.now+=2000;
  await rejectsCode(Promise.resolve().then(()=>verifyWorkerRegistration(first,{
    issuer:'commander.local',audience:'remote-commander',now:()=>f.state.now
  })),'WORKER_IDENTITY_EXPIRED');
  const old=verifyWorkerRegistration(first,{
    issuer:'commander.local',audience:'remote-commander',now:()=>f.state.now,allowExpired:true
  });
  assert.equal(old.claims.workerId,first.claims.workerId);
});
