import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {createSignedCurrentChatBindingAdapter} from '../src/delivery-chat-context-verified.mjs';
import {createAuthenticatedDeliveryTools} from '../src/delivery-authenticated.mjs';
import {DeliveryStore} from '../src/delivery-store.mjs';

const DOMAIN = 'commander.delivery.current-chat.v1';
const CLAIMS = [
  'issuer','audience','source','hostId','principalId','profileId',
  'conversationId','correlationId','bindingId','sessionId',
  'issuedAtMs','expiresAtMs','challenge'
];
const EPOCH = 'a'.repeat(32);
const NOW = Date.UTC(2026,10,8,3,0,0);
const {publicKey,privateKey} = generateKeyPairSync('ed25519');
const rogue = generateKeyPairSync('ed25519');
const trustedKeys = new Map([['host-key',publicKey]]);
const base = Object.freeze({
  issuer:'host-issuer', audience:'commander-delivery',
  source:'HOST_SIGNED_CURRENT_CHAT_CONTEXT',
  hostId:'host-1',principalId:'alice',profileId:'profile-a',
  conversationId:'chat-a',correlationId:'route-a',
  bindingId:EPOCH,sessionId:'session-a'
});
function signEnvelope(claims,{keyId='host-key',signingKey=privateKey}={}) {
  const bytes=Buffer.from(JSON.stringify([
    DOMAIN,keyId,...CLAIMS.map(k=>claims[k])
  ]),'utf8');
  return {
    schema:1,keyId,claims,
    signature:sign(null,bytes,signingKey).toString('base64url')
  };
}
function fixture() {
  const state={
    now:NOW,claims:{...base},allow:true,callCount:0,seen:[],
    mutate:null,wrongKey:false,corruptSignature:false
  };
  const adapter=createSignedCurrentChatBindingAdapter({
    issuer:'host-issuer',audience:'commander-delivery',
    expectedHostId:'host-1',expectedProfileId:'profile-a',
    publicKeys:trustedKeys,now:()=>state.now,maxAgeMs:15000,
    fetchSignedContext:async request=>{
      state.callCount++;
      state.seen.push(request.challenge);
      const claims={
        ...state.claims,
        issuedAtMs:state.now-1000,expiresAtMs:state.now+10000,
        challenge:request.challenge
      };
      if (state.mutate) state.mutate(claims);
      const envelope=signEnvelope(claims,{
        signingKey:state.wrongKey?rogue.privateKey:privateKey
      });
      if (state.corruptSignature) envelope.signature='A'.repeat(86);
      return envelope;
    },
    isBindingCurrent:async context=>{
      assert.equal(context.bindingId,state.claims.bindingId);
      return state.allow;
    }
  });
  return {state,adapter};
}
async function rejectsCode(action,pattern) {
  await assert.rejects(action,pattern);
}
test('current chat trust requires pinned Ed25519 public keys and native grant checks',()=>{
  assert.throws(()=>createSignedCurrentChatBindingAdapter(),
    /DELIVERY_CHAT_CONTEXT_TRUST_REQUIRED/);
  assert.throws(()=>createSignedCurrentChatBindingAdapter({
    issuer:'host-issuer',audience:'commander-delivery',
    expectedHostId:'host-1',expectedProfileId:'profile-a',
    publicKeys:new Map([['host-key',privateKey]]),
    fetchSignedContext:async()=>{},isBindingCurrent:async()=>true
  }),/DELIVERY_CHAT_CONTEXT_TRUST_REQUIRED/);
  assert.throws(()=>createSignedCurrentChatBindingAdapter({
    issuer:'host-issuer',audience:'commander-delivery',
    expectedHostId:'host-1',expectedProfileId:'profile-a',
    publicKeys:trustedKeys,fetchSignedContext:async()=>{}
  }),/DELIVERY_CHAT_CONTEXT_TRUST_REQUIRED/);
});
test('independent signed current-chat context binds identity, route and consent epoch',async()=>{
  const f=fixture();
  const caller=await f.adapter.observeCaller();
  assert.deepEqual(caller,{
    hostId:'host-1',principalId:'alice',
    profileId:'profile-a',conversationId:'chat-a',sessionId:'session-a'
  });
  assert.equal(Object.isFrozen(caller),true);
  const binding=await f.adapter.resolveBinding(caller);
  assert.equal(binding.correlationId,'route-a');
  assert.equal(binding.bindingId,EPOCH);
  assert.equal(binding.sessionId,'session-a');
  assert.equal(Object.isFrozen(binding),true);
  assert.equal(f.state.callCount,2);
  assert.notEqual(f.state.seen[0],f.state.seen[1],
    'each native attestation must answer a fresh challenge');
  assert.equal(f.state.seen.every(x=>/^[A-Za-z0-9_-]{32}$/.test(x)),true);
});
test('forged signature, unavailable key and invalid encoding all fail closed',async()=>{
  const f=fixture();
  f.state.wrongKey=true;
  await rejectsCode(()=>f.adapter.observeCaller(),
    /DELIVERY_CHAT_CONTEXT_SIGNATURE_INVALID/);
  f.state.wrongKey=false;
  f.state.corruptSignature=true;
  await rejectsCode(()=>f.adapter.observeCaller(),
    /DELIVERY_CHAT_CONTEXT_SIGNATURE_INVALID/);
  f.state.corruptSignature=false;
  const switched=createSignedCurrentChatBindingAdapter({
    issuer:'host-issuer',audience:'commander-delivery',
    expectedHostId:'host-1',expectedProfileId:'profile-a',
    publicKeys:trustedKeys,now:()=>NOW,
    isBindingCurrent:async()=>true,
    fetchSignedContext:async ({challenge})=>signEnvelope({
      ...base,issuedAtMs:NOW-1000,expiresAtMs:NOW+10000,challenge
    },{keyId:'retired-key'})
  });
  await rejectsCode(()=>switched.observeCaller(),
    /DELIVERY_CHAT_CONTEXT_KEY_UNTRUSTED/);
});
test('reused signed reply fails its fresh nonce challenge',async()=>{
  const claims={
    ...base,issuedAtMs:NOW-1000,expiresAtMs:NOW+10000,
    challenge:'A'.repeat(32)
  };
  const signed=signEnvelope(claims);
  const adapter=createSignedCurrentChatBindingAdapter({
    issuer:'host-issuer',audience:'commander-delivery',
    expectedHostId:'host-1',expectedProfileId:'profile-a',
    publicKeys:trustedKeys,now:()=>NOW,
    fetchSignedContext:async()=>signed,isBindingCurrent:async()=>true
  });
  await rejectsCode(()=>adapter.observeCaller(),
    /DELIVERY_CHAT_CONTEXT_SCOPE_MISMATCH/);
});
for (const [name,key,value] of [
  ['wrong issuer','issuer','foreign-issuer'],
  ['wrong audience','audience','foreign-audience'],
  ['wrong Host','hostId','host-2'],
  ['wrong profile','profileId','profile-b'],
  ['untrusted source','source','CALLER_HEADER'],
  ['invalid epoch','bindingId','not-an-epoch'],
  ['missing session','sessionId','']
]) {
  test('signed context rejects '+name,async()=>{
    const f=fixture();
    f.state.claims[key]=value;
    await rejectsCode(()=>f.adapter.observeCaller(),
      /DELIVERY_CHAT_CONTEXT_SCOPE_MISMATCH/);
  });
}
test('expired, overlong, future-dated and stale contexts are never trusted',async()=>{
  const f=fixture();
  for (const mutate of [
    c=>{c.expiresAtMs=NOW-1;},
    c=>{c.expiresAtMs=c.issuedAtMs+30001;},
    c=>{c.issuedAtMs=NOW+100;},
    c=>{c.issuedAtMs=NOW-16000;c.expiresAtMs=NOW+1000;}
  ]) {
    f.state.mutate=mutate;
    await rejectsCode(()=>f.adapter.observeCaller(),
      /DELIVERY_CHAT_CONTEXT_EXPIRED/);
  }
});
test('revoked grant and swapped active chat fail closed during independent re-attestation',async()=>{
  const f=fixture();
  const caller=await f.adapter.observeCaller();
  f.state.allow=false;
  await rejectsCode(()=>f.adapter.resolveBinding(caller),
    /DELIVERY_CHAT_CONTEXT_BINDING_REVOKED/);
  f.state.allow=true;
  f.state.claims.conversationId='chat-b';
  await rejectsCode(()=>f.adapter.resolveBinding(caller),
    /DELIVERY_CHAT_CONTEXT_CALLER_CHANGED/);
});
test('integrated protected Delivery claim requires current signed host context, never MCP caller fields',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'v106-host-signed-'));
  const store=new DeliveryStore({directory:path.join(root,'delivery'),scope:'profile-a'});
  const f=fixture();
  let grant=true;
  try {
    const item=store.publish({
      eventKey:'operation:signed:COMPLETED',source:'operation',sourceId:'signed',
      kind:'COMPLETED',correlationId:'route-a',bindingId:EPOCH
    });
    const protectedTools=createAuthenticatedDeliveryTools({
      store,observeCaller:f.adapter.observeCaller,resolveBinding:f.adapter.resolveBinding,
      authorizeDelivery:async()=>grant,
      attestPresentation:async input=>({...input,verified:true,presentationId:'host-presented'})
    });
    const listed=await protectedTools.execute('delivery_list',{limit:5});
    assert.equal(listed.items.length,1);
    await rejectsCode(()=>protectedTools.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'fake',conversationId:'chat-a'
    }),/DELIVERY_AUTH_UNTRUSTED_IDENTITY/);
    f.state.allow=false;
    await rejectsCode(()=>protectedTools.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'revoked'
    }),/DELIVERY_CHAT_CONTEXT_BINDING_REVOKED/);
    assert.equal(store.get(item.deliveryId,'route-a').attempts,0);
    f.state.allow=true;
    grant=false;
    await rejectsCode(()=>protectedTools.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'denied'
    }),/DELIVERY_AUTH_GRANT_REQUIRED/);
    grant=true;
    const claim=await protectedTools.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'host-attempt'
    });
    assert.equal(claim.state,'DELIVERY_PENDING');
    const acknowledged=await protectedTools.execute('delivery_ack',{
      deliveryId:item.deliveryId,attemptId:'host-attempt'
    });
    assert.equal(acknowledged.state,'DELIVERED');
    // Synthetic presentation in this test is deliberately NOT a native
    // ChatGPT display receipt or an installed host acceptance test.
  } finally {
    store.close();
    rmSync(root,{recursive:true,force:true});
  }
});


test('signed identity and presentation compose into the protected MCP Host runtime',async()=>{
  const {DeliveryEventSubscriptionStore}=await import(
    '../src/delivery-mcp-subscription-store.mjs');
  const {createProtectedDeliveryMcpEventsRuntimeWithSignedChatIdentity}=
    await import('../src/delivery-mcp-host-runtime.mjs');
  const root=mkdtempSync(path.join(os.tmpdir(),'v106-chat-runtime-'));
  const store=new DeliveryStore({directory:path.join(root,'delivery'),scope:'profile-a'});
  const subscriptionStore=new DeliveryEventSubscriptionStore({
    directory:path.join(root,'subscriptions'),profileScope:'c'.repeat(64)
  });
  const f=fixture();
  try {
    const identityOptions={
      issuer:'host-issuer',audience:'commander-delivery',
      expectedHostId:'host-1',expectedProfileId:'profile-a',
      publicKeys:trustedKeys,now:()=>f.state.now,
      fetchSignedContext:async request=>{
        const claims={
          ...f.state.claims,issuedAtMs:f.state.now-1000,
          expiresAtMs:f.state.now+10000,challenge:request.challenge
        };
        return signEnvelope(claims);
      },
      isBindingCurrent:async()=>f.state.allow
    };
    const runtime=createProtectedDeliveryMcpEventsRuntimeWithSignedChatIdentity({
      chatContext:identityOptions,deliveryStore:store,subscriptionStore,
      authorizeDelivery:async()=>true,
      authorizeSubscription:async()=>true,
      authorizeSend:async()=>true,
      sealSecret:async()=> 'sealed',
      unsealSecret:async()=> 'whsec_'+Buffer.alloc(32,5).toString('base64'),
      verifiedHttpsTransport:{postVerifiedHttps:async()=>({status:200,body:'{}'})},
      presentationIssuer:'host-issuer',
      presentationAudience:'commander-delivery',
      presentationPublicKeys:trustedKeys,
      assertWorkerIdentityCurrent:async()=>true,
      fetchSignedPresentationReceipt:async()=>{throw Error('NATIVE_PRESENTATION_UNAVAILABLE');},
      now:()=>f.state.now
    });
    const catalog=await runtime.methods['events/list']({});
    assert.equal(catalog.events.length,1);
    const entry=store.publish({
      eventKey:'operation:signed-chat:complete',source:'operation',sourceId:'signed-chat',
      kind:'COMPLETED',correlationId:'route-a',bindingId:EPOCH
    });
    const listed=await runtime.protectedDelivery.execute('delivery_list',{limit:5});
    assert.equal(listed.items[0].deliveryId,entry.deliveryId);
    f.state.allow=false;
    await rejectsCode(()=>runtime.protectedDelivery.execute('delivery_claim',{
      deliveryId:entry.deliveryId,attemptId:'revoked-chat'
    }),/DELIVERY_CHAT_CONTEXT_BINDING_REVOKED/);
    assert.equal(store.get(entry.deliveryId,'route-a').attempts,0);
    assert.equal(Object.keys(runtime.methods).includes('dispatchHostEvent'),false);
    assert.equal(Object.keys(runtime.methods).includes('delivery_ack'),false);
    assert.throws(()=>createProtectedDeliveryMcpEventsRuntimeWithSignedChatIdentity({
      chatContext:identityOptions,observeCaller:async()=>({})
    }),/DELIVERY_CHAT_CONTEXT_CONFIG_AMBIGUOUS/);
  }finally{
    store.close();subscriptionStore.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('safe MCP boundary never leaks signed context tokens or errors',async()=>{
  const {callProtectedDeliveryMcpTool}=await import(
    '../src/delivery-mcp-host-runtime.mjs');
  const classes=[
    ['DELIVERY_CHAT_CONTEXT_SIGNATURE_INVALID','AUTHENTICATED_HOST_REQUIRED'],
    ['DELIVERY_CHAT_CONTEXT_BINDING_REVOKED','OWNER_CONSENT_REQUIRED'],
    ['DELIVERY_CHAT_CONTEXT_CALLER_CHANGED','CHAT_SESSION_CHANGED'],
    ['DELIVERY_CHAT_CONTEXT_EXPIRED','CHAT_BINDING_CHANGED'],
    ['DELIVERY_AUTH_BINDING_SESSION_INVALID','CHAT_SESSION_CHANGED'],
    ['DELIVERY_SEND_BINDING_SESSION_INVALID','CHAT_SESSION_CHANGED'],
    ['DELIVERY_EVENTS_BINDING_SESSION_INVALID','CHAT_SESSION_CHANGED']
  ];
  for (const [internal,publicCode] of classes) {
    const e=Object.assign(new Error('secret-session-token'),{code:internal});
    const result=await callProtectedDeliveryMcpTool(async()=>{throw e;});
    assert.equal(result.isError,true);
    assert.equal(result.structuredContent.code,publicCode);
    assert.equal(JSON.stringify(result).includes('secret-session-token'),false);
  }
});


test('native signed-context issuance and revocation callbacks have bounded fail-closed deadlines',async()=>{
  const common={
    issuer:'host-issuer',audience:'commander-delivery',
    expectedHostId:'host-1',expectedProfileId:'profile-a',
    publicKeys:trustedKeys,now:()=>NOW,maxNativeWaitMs:100
  };
  const never=()=>new Promise(()=>{});
  const blockedIssue=createSignedCurrentChatBindingAdapter({
    ...common,fetchSignedContext:never,isBindingCurrent:async()=>true
  });
  await rejectsCode(()=>blockedIssue.observeCaller(),
    /DELIVERY_CHAT_CONTEXT_NATIVE_TIMEOUT/);
  const blockedGrant=createSignedCurrentChatBindingAdapter({
    ...common,
    fetchSignedContext:async ({challenge})=>signEnvelope({
      ...base,issuedAtMs:NOW-1000,expiresAtMs:NOW+10000,challenge
    }),
    isBindingCurrent:never
  });
  await rejectsCode(()=>blockedGrant.observeCaller(),
    /DELIVERY_CHAT_CONTEXT_NATIVE_TIMEOUT/);
});

test('signed caller key rotation rejects retired signatures and forbids downgrade to unverified Host callbacks',async()=>{
  const {DeliveryEventSubscriptionStore}=await import(
    '../src/delivery-mcp-subscription-store.mjs');
  const {createRotatingProtectedDeliveryMcpEventsRuntime}=await import(
    '../src/delivery-mcp-runtime-manager.mjs');
  const root=mkdtempSync(path.join(os.tmpdir(),'v106-chat-rotation-'));
  const deliveryStore=new DeliveryStore({directory:path.join(root,'delivery'),scope:'profile-a'});
  const subscriptionStore=new DeliveryEventSubscriptionStore({
    directory:path.join(root,'subscriptions'),profileScope:'f'.repeat(64)
  });
  const newKeyPair=generateKeyPairSync('ed25519');
  let signer={id:'host-key',key:privateKey};
  let bindingActive=true;
  const makeOptions=(keys)=>({
    chatContext:{
      issuer:'host-issuer',audience:'commander-delivery',
      expectedHostId:'host-1',expectedProfileId:'profile-a',
      publicKeys:keys,now:()=>NOW,
      fetchSignedContext:async ({challenge})=>signEnvelope({
        ...base,issuedAtMs:NOW-1000,expiresAtMs:NOW+10000,challenge
      },{keyId:signer.id,signingKey:signer.key}),
      isBindingCurrent:async()=>bindingActive
    },
    deliveryStore,subscriptionStore,
    authorizeDelivery:async()=>bindingActive,
    authorizeSubscription:async()=>bindingActive,
    authorizeSend:async()=>bindingActive,
    sealSecret:async()=> 'sealed',
    unsealSecret:async()=> 'whsec_'+Buffer.alloc(32,5).toString('base64'),
    verifiedHttpsTransport:{postVerifiedHttps:async()=>({status:200,body:'{}'})},
    presentationIssuer:'host-issuer',presentationAudience:'commander-delivery',
    presentationPublicKeys:trustedKeys,
    assertWorkerIdentityCurrent:async()=>true,
    fetchSignedPresentationReceipt:async()=>{throw Error('NOT_NATIVE');},
    now:()=>NOW
  });
  const manager=createRotatingProtectedDeliveryMcpEventsRuntime(
    makeOptions(trustedKeys));
  try{
    assert.equal((await manager.methods['events/list']({})).events.length,1);
    assert.equal(manager.status().generation,1);
    const rotated=await manager.rotate(makeOptions(new Map([
      ['new-key',newKeyPair.publicKey]
    ])));
    assert.equal(rotated.previousGeneration,1);
    assert.equal(rotated.generation,2);
    await rejectsCode(()=>manager.methods['events/list']({}),
      /DELIVERY_CHAT_CONTEXT_KEY_UNTRUSTED/);
    signer={id:'new-key',key:newKeyPair.privateKey};
    assert.equal((await manager.methods['events/list']({})).events.length,1);
    const downgraded=makeOptions(trustedKeys);
    delete downgraded.chatContext;
    downgraded.observeCaller=async()=>base;
    downgraded.resolveBinding=async()=>base;
    assert.throws(()=>manager.rotate(downgraded),
      /DELIVERY_EVENTS_RUNTIME_TRUST_DOWNGRADE_FORBIDDEN/);
    assert.equal(manager.status().generation,2);
    bindingActive=false;
    await rejectsCode(()=>manager.methods['events/list']({}),
      /DELIVERY_CHAT_CONTEXT_BINDING_REVOKED/);
  }finally{
    await manager.close();
    deliveryStore.close();subscriptionStore.close();
    rmSync(root,{recursive:true,force:true});
  }
});


test('signed current-chat session switch with unchanged identity and epoch denies claim before any mutation',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'v106-chat-session-claim-'));
  const store=new DeliveryStore({directory:path.join(root,'delivery'),scope:'profile-a'});
  const f=fixture();
  try{
    const item=store.publish({
      eventKey:'operation:session-fence-claim:complete',
      source:'operation',sourceId:'session-fence-claim',kind:'COMPLETED',
      correlationId:'route-a',bindingId:EPOCH
    });
    let authorizations=0;
    const adapter=createAuthenticatedDeliveryTools({
      store,observeCaller:f.adapter.observeCaller,resolveBinding:f.adapter.resolveBinding,
      authorizeDelivery:async()=>{
        if(++authorizations===1)f.state.claims.sessionId='session-b';
        return true;
      }
    });
    await rejectsCode(()=>adapter.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'attempt-switched'
    }),/DELIVERY_AUTH_SESSION_CHANGED/);
    assert.equal(store.get(item.deliveryId,'route-a').state,'COMPLETED_UNDELIVERED');
    assert.equal(store.get(item.deliveryId,'route-a').attempts,0);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('signed session swap during presentation proof denies ACK for exact attempt and result',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'v106-chat-session-ack-'));
  const store=new DeliveryStore({directory:path.join(root,'delivery'),scope:'profile-a'});
  const f=fixture();
  try{
    const item=store.publish({
      eventKey:'operation:session-fence-ack:complete',
      source:'operation',sourceId:'session-fence-ack',kind:'COMPLETED',
      correlationId:'route-a',bindingId:EPOCH
    });
    const adapter=createAuthenticatedDeliveryTools({
      store,observeCaller:f.adapter.observeCaller,resolveBinding:f.adapter.resolveBinding,
      authorizeDelivery:async()=>true,
      // Synthetic trusted callback in QA; installed ChatGPT display remains unverified.
      attestPresentation:async request=>{
        f.state.claims.sessionId='session-b';
        return {...request,verified:true,presentationId:'native-test'};
      }
    });
    await adapter.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'attempt-original'
    });
    await rejectsCode(()=>adapter.execute('delivery_ack',{
      deliveryId:item.deliveryId,attemptId:'attempt-original'
    }),/DELIVERY_AUTH_SESSION_CHANGED/);
    const after=store.get(item.deliveryId,'route-a');
    assert.equal(after.state,'DELIVERY_PENDING');
    assert.equal(after.receiptId,null);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});


test('signed Host current-chat subscriptions register and session swap during callback denies a new registration',async()=>{
  const {DeliveryEventSubscriptionStore}=await import(
    '../src/delivery-mcp-subscription-store.mjs');
  const {createProtectedDeliveryMcpEventsRuntimeWithSignedChatIdentity}=
    await import('../src/delivery-mcp-host-runtime.mjs');
  const {DELIVERY_MCP_EVENT}=await import('../src/delivery-mcp-events.mjs');
  const root=mkdtempSync(path.join(os.tmpdir(),'v106-chat-subscription-'));
  const store=new DeliveryStore({directory:path.join(root,'delivery'),scope:'profile-a'});
  const subscriptionStore=new DeliveryEventSubscriptionStore({
    directory:path.join(root,'subscriptions'),profileScope:'d'.repeat(64)
  });
  const f=fixture();
  const secret='whsec_'+Buffer.alloc(32,13).toString('base64');
  const sealed=new Map();
  let switchDuringChallenge=false;
  let switchDuringOutgoing=false;
  let switchDuringDiscovery=false;
  const runtime=createProtectedDeliveryMcpEventsRuntimeWithSignedChatIdentity({
    chatContext:{
      issuer:'host-issuer',audience:'commander-delivery',
      expectedHostId:'host-1',expectedProfileId:'profile-a',
      publicKeys:trustedKeys,now:()=>f.state.now,
      fetchSignedContext:async ({challenge})=>signEnvelope({
        ...f.state.claims,issuedAtMs:f.state.now-1000,
        expiresAtMs:f.state.now+10000,challenge
      }),
      isBindingCurrent:async()=>f.state.allow
    },
    deliveryStore:store,subscriptionStore,
    authorizeDelivery:async()=>true,
    authorizeSubscription:async claim=>{
      if(switchDuringDiscovery&&claim.action==='list')
        f.state.claims.sessionId='session-b';
      return true;
    },
    authorizeSend:async()=>true,
    sealSecret:async value=>{sealed.set('opaque',value);return 'opaque';},
    unsealSecret:async key=>sealed.get(key),
    verifiedHttpsTransport:{
      postVerifiedHttps:async request=>{
        const body=JSON.parse(request.body);
        if(body.type==='verification'){
          if(switchDuringChallenge)f.state.claims.sessionId='session-b';
          return {status:200,body:JSON.stringify({challenge:body.challenge})};
        }
        if(switchDuringOutgoing)f.state.claims.sessionId='session-b';
        return {status:202,body:''};
      }
    },
    presentationIssuer:'host-issuer',presentationAudience:'commander-delivery',
    presentationPublicKeys:trustedKeys,
      assertWorkerIdentityCurrent:async()=>true,
    fetchSignedPresentationReceipt:async()=>{throw Error('NATIVE_DISPLAY_UNAVAILABLE');},
    now:()=>f.state.now
  });
  const request=url=>({
    name:DELIVERY_MCP_EVENT,arguments:{},
    delivery:{mode:'webhook',url,secret},cursor:null
  });
  try{
    const url='https://callbacks.example.net/signed-chat-a';
    assert.equal((await runtime.methods['events/list']({})).events.length,1);
    const registered=await runtime.methods['events/subscribe'](request(url));
    assert.equal(registered.id.startsWith('sub_'),true);
    assert.equal(subscriptionStore.status().total,1);
    const sentItem=store.publish({
      eventKey:'operation:signed-subscriber:complete',
      source:'operation',sourceId:'signed-subscriber',kind:'COMPLETED',
      correlationId:'route-a',bindingId:EPOCH
    });
    const transport=await runtime.dispatchHostEvent({
      deliveryId:sentItem.deliveryId,subscriptionId:registered.id
    });
    assert.equal(transport.webhookAccepted,true);
    assert.equal(transport.resultDeliveryAcknowledged,false);
    assert.equal(store.get(sentItem.deliveryId,'route-a').state,'COMPLETED_UNDELIVERED');
    const secondItem=store.publish({
      eventKey:'operation:signed-subscriber:second',
      source:'operation',sourceId:'signed-subscriber-second',kind:'COMPLETED',
      correlationId:'route-a',bindingId:EPOCH
    });
    switchDuringOutgoing=true;
    await rejectsCode(()=>runtime.dispatchHostEvent({
      deliveryId:secondItem.deliveryId,subscriptionId:registered.id
    }),/DELIVERY_SEND_SESSION_CHANGED/);
    assert.equal(store.get(secondItem.deliveryId,'route-a').state,'COMPLETED_UNDELIVERED');
    switchDuringOutgoing=false;
    f.state.claims.sessionId='session-a';
    await runtime.methods['events/unsubscribe']({
      name:DELIVERY_MCP_EVENT,arguments:{},
      delivery:{mode:'webhook',url}
    });
    assert.equal(subscriptionStore.status().total,0);
    switchDuringDiscovery=true;
    await rejectsCode(()=>runtime.methods['events/list']({}),
      /DELIVERY_EVENTS_DISCOVERY_SESSION_CHANGED/);
    switchDuringDiscovery=false;
    f.state.claims.sessionId='session-a';
    switchDuringChallenge=true;
    await rejectsCode(()=>runtime.methods['events/subscribe'](
      request('https://callbacks.example.net/signed-chat-b')
    ),/DELIVERY_EVENTS_SESSION_CHANGED/);
    assert.equal(subscriptionStore.status().total,0,
      'a switched native session must not install a durable subscription');
  }finally{
    store.close();subscriptionStore.close();
    rmSync(root,{recursive:true,force:true});
  }
});


test('new signed session can resume an existing claim across separate calls without re-executing work',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'v106-reconnect-session-'));
  const store=new DeliveryStore({directory:path.join(root,'delivery'),scope:'profile-a'});
  const f=fixture();
  try{
    const item=store.publish({
      eventKey:'operation:reconnect:complete',source:'operation',
      sourceId:'reconnect',kind:'COMPLETED',correlationId:'route-a',bindingId:EPOCH
    });
    const adapter=createAuthenticatedDeliveryTools({
      store,observeCaller:f.adapter.observeCaller,resolveBinding:f.adapter.resolveBinding,
      authorizeDelivery:async()=>true,
      // Test-only receipt: production requires native signed display evidence.
      attestPresentation:async request=>({
        ...request,verified:true,presentationId:'simulated-presentation'
      })
    });
    const first=await adapter.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'reconnect-attempt'
    });
    assert.equal(first.state,'DELIVERY_PENDING');
    f.state.claims.sessionId='session-after-reconnect';
    const resumed=await adapter.execute('delivery_ack',{
      deliveryId:item.deliveryId,attemptId:'reconnect-attempt'
    });
    assert.equal(resumed.state,'DELIVERED');
    const repeated=await adapter.execute('delivery_ack',{
      deliveryId:item.deliveryId,attemptId:'reconnect-attempt'
    });
    assert.equal(repeated.receiptId,resumed.receiptId);
    assert.equal(store.get(item.deliveryId,'route-a').attempts,1);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});


test('signed session swap between the first caller observation and binding resolution must fail closed',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'v106-observe-resolve-race-'));
  const store=new DeliveryStore({directory:path.join(root,'delivery'),scope:'profile-a'});
  const f=fixture();
  try{
    const oldCaller=await f.adapter.observeCaller();
    f.state.claims.sessionId='session-after-observation';
    await rejectsCode(()=>f.adapter.resolveBinding(oldCaller),
      /DELIVERY_CHAT_CONTEXT_CALLER_CHANGED/);
    f.state.claims.sessionId='session-a';
    const event=store.publish({
      eventKey:'operation:race:COMPLETED',source:'operation',sourceId:'race',
      kind:'COMPLETED',correlationId:'route-a',bindingId:EPOCH
    });
    let first=true;
    const protectedTools=createAuthenticatedDeliveryTools({
      store,
      observeCaller:async()=>{
        const c=await f.adapter.observeCaller();
        if(first){first=false;f.state.claims.sessionId='session-after-observation';}
        return c;
      },
      resolveBinding:f.adapter.resolveBinding,
      authorizeDelivery:async()=>true
    });
    await rejectsCode(()=>protectedTools.execute('delivery_claim',{
      deliveryId:event.deliveryId,attemptId:'race-claim'
    }),/DELIVERY_CHAT_CONTEXT_CALLER_CHANGED/);
    const item=store.get(event.deliveryId,'route-a');
    assert.equal(item.state,'COMPLETED_UNDELIVERED');
    assert.equal(item.attempts,0);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});


test('signed chat proof expiring during native grant verification is never returned as authenticated',async()=>{
  for(const clockShift of [101,1100]){
    let current=NOW;
    const expiry=clockShift===101 ? NOW+100 : NOW+5000;
    const adapter=createSignedCurrentChatBindingAdapter({
      issuer:'host-issuer',audience:'commander-delivery',
      expectedHostId:'host-1',expectedProfileId:'profile-a',
      publicKeys:trustedKeys,maxAgeMs:1000,now:()=>current,
      fetchSignedContext:async ({challenge})=>signEnvelope({
        ...base,issuedAtMs:NOW-950,expiresAtMs:expiry,challenge
      }),
      isBindingCurrent:async()=>{
        // Independently authorized native callback took time; its reply
        // must not turn an expired/stale Host signature into access.
        current=NOW+clockShift;
        return true;
      }
    });
    await rejectsCode(()=>adapter.observeCaller(),
      /DELIVERY_CHAT_CONTEXT_EXPIRED/);
  }
});
