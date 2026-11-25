import test from 'node:test';
import assert from 'node:assert/strict';
import { createV2NativeOwnerSessionBindings } from '../src/v2-native-owner-session-bindings.mjs';

const OWNER='a'.repeat(64),OTHER='b'.repeat(64),TOKEN_SHA='c'.repeat(64);
const route={
  hostId:'qa-host',profileId:'qa-profile',principalId:'qa-owner',
  conversationId:'qa-chat',operationId:'qa-operation',
  target:{kind:'desktop-seat',id:'qa-seat'}
};
function fixture(overrides={}){
  const state={now:1_800_000_000_000,ownerSidHash:OWNER,seat:'qa-seat',
    allowBind:true,allowRevoke:true,bindRequests:[],revokeRequests:[],...overrides};
  const bindings=createV2NativeOwnerSessionBindings({
    attestPlatformSession:async proof=>proof==='platform-proof'?{
      source:'native-platform-session',sessionHandle:'qa-chat',tokenSha256:TOKEN_SHA
    }:null,
    resolveOwnerRoute:async handle=>handle==='qa-chat'?route:null,
    observedNativeSession:async()=>state.seat,
    resolveOwnerSidHash:async()=>state.ownerSidHash,
    authorizeBinding:async request=>{state.bindRequests.push(request);return state.allowBind;},
    authorizeRevocation:async request=>{state.revokeRequests.push(request);return state.allowRevoke;},
    now:()=>state.now,ttlMs:60_000
  });
  return{state,bindings,close:()=>bindings.close()};
}

test('native owner binding projects a fresh binding epoch and OS owner SID hash',async()=>{
  const f=fixture();
  try{
    const admitted=await f.bindings.bindTrusted('platform-proof');
    assert.match(admitted.bindingId,/^[a-f0-9]{64}$/);
    assert.equal(admitted.ownerSidHash,OWNER);
    assert.equal(admitted.tokenSha256,TOKEN_SHA);
    assert.equal(f.state.bindRequests[0].ownerSidHash,OWNER);
    assert.equal(f.state.bindRequests[0].tokenSha256,TOKEN_SHA);
    assert.equal(f.state.bindRequests[0].bindingId,admitted.bindingId);
    const context=await f.bindings.resolveNativeOwnerContext('qa-chat');
    assert.deepEqual(context,{
      source:'native-owner-attested',hostId:'qa-host',profileId:'qa-profile',
      principalId:'qa-owner',conversationId:'qa-chat',bindingId:admitted.bindingId,
      ownerSidHash:OWNER,expiresAtMs:admitted.expiresAtMs
    });
    assert.equal((await f.bindings.resolveNativeRoute('qa-chat')).conversationId,'qa-chat');
  }finally{f.close();}
});


test('native owner session binding resolves only the exact verified token digest',async()=>{
  const f=fixture();
  try{
    const admitted=await f.bindings.bindTrusted('platform-proof');
    assert.deepEqual(await f.bindings.resolveAttestedTokenBinding(TOKEN_SHA),{
      source:'native-owner-attested',tokenSha256:TOKEN_SHA,sessionHandle:'qa-chat',
      bindingId:admitted.bindingId,ownerSidHash:OWNER,expiresAtMs:admitted.expiresAtMs
    });
    assert.equal(await f.bindings.resolveAttestedTokenBinding('d'.repeat(64)),null);
    assert.equal(await f.bindings.resolveAttestedTokenBinding('not-a-digest'),null);
  }finally{f.close();}
});

test('concurrent owner approvals cannot bind one bearer digest to two native sessions',async()=>{
  const tokenSha256='e'.repeat(64);
  const now=1_800_000_000_000;
  let approvals=0,release;
  const barrier=new Promise(resolve=>{release=resolve;});
  const bindings=createV2NativeOwnerSessionBindings({
    attestPlatformSession:async sessionHandle=>({
      source:'native-platform-session',sessionHandle,tokenSha256
    }),
    resolveOwnerRoute:async sessionHandle=>({
      ...route,conversationId:sessionHandle,
      target:{kind:'desktop-seat',id:'qa-seat'}
    }),
    observedNativeSession:async()=> 'qa-seat',
    resolveOwnerSidHash:async()=>OWNER,
    authorizeBinding:async()=>{
      approvals++;
      if(approvals===2)release();
      await barrier;
      return true;
    },
    authorizeRevocation:async()=>true,
    now:()=>now,ttlMs:60_000,maxBindings:2
  });
  try{
    const results=await Promise.allSettled([
      bindings.bindTrusted('qa-chat-one'),
      bindings.bindTrusted('qa-chat-two')
    ]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(results.filter(x=>x.status==='rejected').length,1);
    const denied=results.find(x=>x.status==='rejected');
    assert.match(denied.reason?.message??'',/V2_SESSION_TOKEN_BINDING_EXISTS/);
    assert.equal(bindings.size,1);
    const resolved=await bindings.resolveAttestedTokenBinding(tokenSha256);
    assert.ok(resolved);
    assert.ok(['qa-chat-one','qa-chat-two'].includes(resolved.sessionHandle));
  }finally{bindings.close();}
});

test('owner identity loss removes the token-to-session binding before Router admission',async()=>{
  const f=fixture();
  try{
    await f.bindings.bindTrusted('platform-proof');
    f.state.ownerSidHash=OTHER;
    assert.equal(await f.bindings.resolveAttestedTokenBinding(TOKEN_SHA),null);
    assert.equal(f.bindings.size,0);
  }finally{f.close();}
});

test('platform token binding rejects malformed, accessor and Proxy attestations',async t=>{
  for(const [name,attest] of [
    ['legacy string',async()=> 'qa-chat'],
    ['wrong digest',async()=>({source:'native-platform-session',sessionHandle:'qa-chat',tokenSha256:'bad'})],
    ['extra field',async()=>({source:'native-platform-session',sessionHandle:'qa-chat',tokenSha256:TOKEN_SHA,accessToken:'secret'})],
    ['accessor',async()=>{
      const value={source:'native-platform-session',sessionHandle:'qa-chat',tokenSha256:TOKEN_SHA};
      Object.defineProperty(value,'tokenSha256',{enumerable:true,get(){throw new Error('must not execute');}});
      return value;
    }],
    ['Proxy',async()=>new Proxy({source:'native-platform-session',sessionHandle:'qa-chat',tokenSha256:TOKEN_SHA},{})]
  ]){
    await t.test(name,async()=>{
      const f=fixture();
      const b=createV2NativeOwnerSessionBindings({
        attestPlatformSession:attest,resolveOwnerRoute:async()=>route,
        observedNativeSession:async()=>f.state.seat,
        resolveOwnerSidHash:async()=>f.state.ownerSidHash,
        authorizeBinding:async()=>true,authorizeRevocation:async()=>true,
        now:()=>f.state.now,ttlMs:60_000
      });
      try{
        await assert.rejects(b.bindTrusted('platform-proof'),/V2_SESSION_PLATFORM_ATTESTATION_REQUIRED/);
        assert.equal(b.size,0);
      }finally{b.close();f.close();}
    });
  }
});

test('owner identity change while native consent awaits prevents binding creation',async()=>{
  const f=fixture();
  try{
    f.state.allowBind=true;
    f.state.bindRequests=[];
    const original=f.state.ownerSidHash;
    // Change owner after the first native snapshot but during the approval callback.
    f.state.allowBind='change';
    const {bindings,state}=f;
    bindings.close();
    const changed=createV2NativeOwnerSessionBindings({
      attestPlatformSession:async()=>({source:'native-platform-session',sessionHandle:'qa-chat',tokenSha256:TOKEN_SHA}),
      resolveOwnerRoute:async()=>route,
      observedNativeSession:async()=>state.seat,
      resolveOwnerSidHash:async()=>state.ownerSidHash,
      authorizeBinding:async()=>{state.ownerSidHash=OTHER;return true;},
      authorizeRevocation:async()=>true,now:()=>state.now,ttlMs:60_000
    });
    await assert.rejects(changed.bindTrusted('platform-proof'),/V2_SESSION_BINDING_CHANGED_DURING_CONSENT/);
    assert.equal(changed.size,0);
    assert.notEqual(state.ownerSidHash,original);
    changed.close();
  }finally{f.close();}
});

test('owner SID rotation after admission revokes native owner context and route',async()=>{
  const f=fixture();
  try{
    await f.bindings.bindTrusted('platform-proof');
    f.state.ownerSidHash=OTHER;
    await assert.rejects(f.bindings.resolveNativeOwnerContext('qa-chat'),/V2_SESSION_TRUST_LOST/);
    assert.equal(f.bindings.size,0);
    await assert.rejects(f.bindings.resolveNativeRoute('qa-chat'),/V2_SESSION_NOT_BOUND/);
  }finally{f.close();}
});

test('revocation requires native authorization and every regrant gets a new binding epoch',async()=>{
  const f=fixture();
  try{
    const first=await f.bindings.bindTrusted('platform-proof');
    f.state.allowRevoke=false;
    await assert.rejects(f.bindings.revokeTrusted({sessionHandle:'qa-chat'}),/V2_SESSION_REVOKE_AUTH_REQUIRED/);
    assert.equal(f.bindings.size,1);
    f.state.allowRevoke=true;
    assert.equal(await f.bindings.revokeTrusted({sessionHandle:'qa-chat'}),true);
    const second=await f.bindings.bindTrusted('platform-proof');
    assert.notEqual(second.bindingId,first.bindingId);
    assert.equal(f.bindings.size,1);
  }finally{f.close();}
});

test('missing or malformed native owner SID identity fails closed',async()=>{
  const f=fixture({ownerSidHash:'not-a-digest'});
  try{
    await assert.rejects(f.bindings.bindTrusted('platform-proof'),/V2_SESSION_OWNER_IDENTITY_REQUIRED/);
    assert.equal(f.bindings.size,0);
  }finally{f.close();}
});

test('native owner binding bootstrap requires an independent OS identity provider',()=>{
  assert.throws(()=>createV2NativeOwnerSessionBindings({
    attestPlatformSession:async()=> 'qa-chat',
    resolveOwnerRoute:async()=>route,observedNativeSession:async()=> 'qa-seat',
    authorizeBinding:async()=>true,authorizeRevocation:async()=>true
  }),/V2_SESSION_OWNER_BOOTSTRAP_REQUIRED/);
});
