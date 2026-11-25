import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {createSignedDeliveryPresentationAttestor} from '../src/delivery-presentation-verified.mjs';
import {createAuthenticatedDeliveryTools} from '../src/delivery-authenticated.mjs';
import {DeliveryStore} from '../src/delivery-store.mjs';
import {createHash} from 'node:crypto';
import {DeliveryEventSubscriptionStore} from '../src/delivery-mcp-subscription-store.mjs';
import {createProtectedDeliveryMcpEventsRuntimeWithSignedPresentation} from '../src/delivery-mcp-host-runtime.mjs';
import {DELIVERY_MCP_EVENT} from '../src/delivery-mcp-events.mjs';

const TIME=Date.UTC(2026,10,7,3,0,0);
const DOMAIN_V1='commander.delivery.presentation.v1';
const DOMAIN_V2='commander.delivery.presentation.v2';
const FIELDS_V1=[
  'issuer','audience','hostId','principalId','profileId','conversationId',
  'bindingId','deliveryId','correlationId','attemptId','resultHash',
  'presentationId','issuedAtMs','expiresAtMs','nonce'
];
const FIELDS_V2=[
  'issuer','audience','hostId','principalId','profileId','conversationId',
  'bindingId','workerId','workerKeyId','workerGrantRevision',
  'deliveryId','correlationId','attemptId','resultHash',
  'presentationId','issuedAtMs','expiresAtMs','nonce'
];
const EPOCH='b'.repeat(32);
const WORKER_IDENTITY=Object.freeze({workerId:'cw_'+'c'.repeat(64),workerKeyId:'d'.repeat(64),workerGrantRevision:7});
const CALLER=Object.freeze({
  hostId:'host-one',principalId:'owner-one',
  profileId:'profile-one',conversationId:'chat-one'
});
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v106-present-proof-'));
  const store=new DeliveryStore({directory:path.join(root,'db'),scope:'profile-one'});
  const keys=generateKeyPairSync('ed25519');
  const trust=new Map([['host-key-1',keys.publicKey]]);
  const state={caller:CALLER,correlationId:'route-one',bindingId:EPOCH,grant:true,workerCurrent:true,workerChecks:[],proof:null};
  const item=store.publish({
    eventKey:'operation:job-one:complete',correlationId:'route-one',
    source:'operation',sourceId:'job-one',kind:'COMPLETED',bindingId:EPOCH,
    originReceiptHash:'e'.repeat(64),workerIdentity:WORKER_IDENTITY
  });
  const signProof=(request,change={},privateKey=keys.privateKey,keyId='host-key-1')=>{
    const claims={
      issuer:'native-owner-service',audience:'commander-delivery',
      ...request,presentationId:'host-display-1',
      issuedAtMs:TIME-1000,expiresAtMs:TIME+10000,nonce:'nonce-1',...change
    };
    const workerBound=Object.hasOwn(request,'workerId');
    const fields=workerBound?FIELDS_V2:FIELDS_V1;
    const domain=workerBound?DOMAIN_V2:DOMAIN_V1;
    const message=Buffer.from(JSON.stringify([
      domain,keyId,...fields.map(k=>claims[k])
    ]));
    return {schema:workerBound?2:1,keyId,claims,
      signature:sign(null,message,privateKey).toString('base64url')};
  };
  let signer=({request})=>signProof(request);
  const verifier=createSignedDeliveryPresentationAttestor({
    issuer:'native-owner-service',audience:'commander-delivery',
    publicKeys:trust,now:()=>TIME,
    assertWorkerIdentityCurrent:async identity=>{
      state.workerChecks.push(identity);return state.workerCurrent;
    },
    fetchSignedReceipt:async request=>state.proof??signer({request})
  });
  const adapter=createAuthenticatedDeliveryTools({
    store,observeCaller:async()=>state.caller,
    resolveBinding:async()=>({...state.caller,
      correlationId:state.correlationId,bindingId:state.bindingId}),
    authorizeDelivery:async()=>state.grant,attestPresentation:verifier
  });
  return {state,item,store,adapter,trust,keys,signProof,
    setSigner:fn=>{signer=fn;},
    close(){store.close();fs.rmSync(root,{force:true,recursive:true});}
  };
}
const ackInput=f=>({deliveryId:f.item.deliveryId,attemptId:'attempt-one'});
async function claim(f){await f.adapter.execute('delivery_claim',ackInput(f));}
test('signed Host presentation is required to ACK, and a lost ACK response is idempotent',async()=>{
  const f=fixture();
  try{
    await claim(f);
    const first=await f.adapter.execute('delivery_ack',ackInput(f));
    const retry=await f.adapter.execute('delivery_ack',ackInput(f));
    assert.equal(first.state,'DELIVERED');
    assert.equal(retry.receiptId,first.receiptId);
    assert.equal(retry.attempts,1);
    assert.equal(f.state.workerChecks.length,2);
    assert.equal(f.state.workerChecks[0].workerId,WORKER_IDENTITY.workerId);
    assert.equal(f.state.workerChecks[0].workerKeyId,WORKER_IDENTITY.workerKeyId);
    assert.equal(f.state.workerChecks[0].workerGrantRevision,WORKER_IDENTITY.workerGrantRevision);
    assert.equal(f.store.get(f.item.deliveryId,'route-one').receiptId,first.receiptId);
  }finally{f.close();}
});
test('legacy pre-identity delivery rows retain the isolated v1 presentation protocol',async()=>{
  const f=fixture();
  try{
    const legacy=f.store.publish({
      eventKey:'operation:legacy-presentation',correlationId:'route-one',
      source:'operation',sourceId:'legacy-presentation',kind:'COMPLETED',bindingId:EPOCH
    });
    let received;
    const verifier=createSignedDeliveryPresentationAttestor({
      issuer:'native-owner-service',audience:'commander-delivery',
      publicKeys:f.trust,now:()=>TIME,
      fetchSignedReceipt:async request=>{
        received=request;
        assert.equal(Object.hasOwn(request,'workerId'),false);
        return f.signProof(request);
      }
    });
    const adapter=createAuthenticatedDeliveryTools({
      store:f.store,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>({...f.state.caller,
        correlationId:f.state.correlationId,bindingId:EPOCH}),
      authorizeDelivery:async()=>f.state.grant,attestPresentation:verifier
    });
    await adapter.execute('delivery_claim',{
      deliveryId:legacy.deliveryId,attemptId:'legacy-attempt'
    });
    const ack=await adapter.execute('delivery_ack',{
      deliveryId:legacy.deliveryId,attemptId:'legacy-attempt'
    });
    assert.equal(ack.state,'DELIVERED');
    assert.equal(received.workerId,undefined);
    assert.equal(f.store.get(legacy.deliveryId,'route-one').receiptId,ack.receiptId);
  }finally{f.close();}
});
test('legacy v1 presentation signatures cannot ACK a worker-bound v2 result',async()=>{
  const f=fixture();
  try{
    await claim(f);
    f.setSigner(({request})=>{
      const legacyRequest=Object.fromEntries(FIELDS_V1.map(k=>[k,request[k]]));
      return f.signProof(legacyRequest);
    });
    await assert.rejects(()=>f.adapter.execute('delivery_ack',ackInput(f)),
      /DELIVERY_PRESENTATION_ENVELOPE_INVALID/);
    assert.equal(f.store.get(f.item.deliveryId,'route-one').state,'DELIVERY_PENDING');
    assert.equal(f.store.get(f.item.deliveryId,'route-one').receiptId,null);
  }finally{f.close();}
});
test('revoked or regranted worker identity cannot ACK a worker-bound result',async()=>{
  const f=fixture();
  try{
    await claim(f);
    f.state.workerCurrent=false;
    await assert.rejects(()=>f.adapter.execute('delivery_ack',ackInput(f)),
      /DELIVERY_PRESENTATION_WORKER_NOT_CURRENT/);
    const after=f.store.get(f.item.deliveryId,'route-one');
    assert.equal(after.state,'DELIVERY_PENDING');
    assert.equal(after.receiptId,null);
    assert.equal(f.state.workerChecks.length,1);
  }finally{f.close();}
});
test('worker-bound v2 presentation fails closed when the Host omits its live registry check',async()=>{
  const f=fixture();
  try{
    await claim(f);
    const verifier=createSignedDeliveryPresentationAttestor({
      issuer:'native-owner-service',audience:'commander-delivery',
      publicKeys:f.trust,now:()=>TIME,
      fetchSignedReceipt:async request=>f.signProof(request)
    });
    const adapter=createAuthenticatedDeliveryTools({
      store:f.store,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>({...f.state.caller,
        correlationId:f.state.correlationId,bindingId:EPOCH}),
      authorizeDelivery:async()=>f.state.grant,attestPresentation:verifier
    });
    await assert.rejects(()=>adapter.execute('delivery_ack',ackInput(f)),
      /DELIVERY_PRESENTATION_WORKER_NOT_CURRENT/);
    assert.equal(f.store.get(f.item.deliveryId,'route-one').state,'DELIVERY_PENDING');
    assert.equal(f.store.get(f.item.deliveryId,'route-one').receiptId,null);
  }finally{f.close();}
});
test('presentation that expires during the asynchronous worker-current check cannot ACK',async()=>{
  const f=fixture();
  try{
    await claim(f);
    let clock=TIME;
    const verifier=createSignedDeliveryPresentationAttestor({
      issuer:'native-owner-service',audience:'commander-delivery',
      publicKeys:f.trust,now:()=>clock,
      fetchSignedReceipt:async request=>f.signProof(request),
      assertWorkerIdentityCurrent:async()=>{clock=TIME+10001;return true;}
    });
    const adapter=createAuthenticatedDeliveryTools({
      store:f.store,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>({...f.state.caller,
        correlationId:f.state.correlationId,bindingId:EPOCH}),
      authorizeDelivery:async()=>f.state.grant,attestPresentation:verifier
    });
    await assert.rejects(()=>adapter.execute('delivery_ack',ackInput(f)),
      /DELIVERY_PRESENTATION_EXPIRED/);
    assert.equal(f.store.get(f.item.deliveryId,'route-one').state,'DELIVERY_PENDING');
    assert.equal(f.store.get(f.item.deliveryId,'route-one').receiptId,null);
  }finally{f.close();}
});
test('forged signature cannot ACK even with valid-looking Host claims',async()=>{
  const f=fixture();
  try{
    await claim(f);
    const attacker=generateKeyPairSync('ed25519');
    f.setSigner(({request})=>f.signProof(request,{},attacker.privateKey));
    await assert.rejects(()=>f.adapter.execute('delivery_ack',ackInput(f)),
      /DELIVERY_PRESENTATION_SIGNATURE_INVALID/);
    assert.equal(f.store.get(f.item.deliveryId,'route-one').receiptId,null);
  }finally{f.close();}
});
test('properly signed wrong original chat, attempt, result or consent epoch cannot ACK',async()=>{
  const f=fixture();
  try{
    await claim(f);
    for(const change of [
      {conversationId:'chat-other'}, {principalId:'owner-other'},
      {attemptId:'attempt-other'}, {resultHash:'f'.repeat(64)},
      {bindingId:'c'.repeat(32)}, {deliveryId:'f'.repeat(36)},
      {correlationId:'route-other'},
      {workerId:'cw_'+'f'.repeat(64)}, {workerKeyId:'f'.repeat(64)},
      {workerGrantRevision:99}
    ]){
      f.setSigner(({request})=>f.signProof(request,change));
      await assert.rejects(()=>f.adapter.execute('delivery_ack',ackInput(f)),
        /DELIVERY_PRESENTATION_SCOPE_MISMATCH/);
      assert.equal(f.store.get(f.item.deliveryId,'route-one').receiptId,null);
    }
  }finally{f.close();}
});
test('unknown key, issuer and audience are not trusted even when cryptographically valid',async()=>{
  const f=fixture();
  try{
    await claim(f);
    f.setSigner(({request})=>f.signProof(request,{},f.keys.privateKey,'different-key'));
    await assert.rejects(()=>f.adapter.execute('delivery_ack',ackInput(f)),
      /DELIVERY_PRESENTATION_KEY_UNTRUSTED/);
    for(const change of [{issuer:'unauthorized-issuer'},{audience:'wrong-audience'}]){
      f.setSigner(({request})=>f.signProof(request,change));
      await assert.rejects(()=>f.adapter.execute('delivery_ack',ackInput(f)),
        /DELIVERY_PRESENTATION_ISSUER_MISMATCH/);
    }
    assert.equal(f.store.get(f.item.deliveryId,'route-one').receiptId,null);
  }finally{f.close();}
});
test('expired, future-dated or overlong signed Host presentations fail closed',async()=>{
  const f=fixture();
  try{
    await claim(f);
    for(const change of [
      {issuedAtMs:TIME-100000,expiresAtMs:TIME+1000},
      {issuedAtMs:TIME+1,expiresAtMs:TIME+10000},
      {issuedAtMs:TIME-1000,expiresAtMs:TIME},
      {issuedAtMs:TIME-1000,expiresAtMs:TIME+121000}
    ]){
      f.setSigner(({request})=>f.signProof(request,change));
      await assert.rejects(()=>f.adapter.execute('delivery_ack',ackInput(f)),
        /DELIVERY_PRESENTATION_EXPIRED/);
    }
    assert.equal(f.store.get(f.item.deliveryId,'route-one').receiptId,null);
  }finally{f.close();}
});
test('untrusted receipt fields, getters, noncanonical signatures and unsigned booleans never ACK',async()=>{
  const f=fixture();
  try{
    await claim(f);
    const examples=[
      {verified:true,presentationId:'fake'},
      {schema:1,keyId:'host-key-1',claims:{},signature:'0'},
      null
    ];
    for(const value of examples){
      f.state.proof=value;
      if(value===null)continue; // Null clears override; test separately below.
      await assert.rejects(()=>f.adapter.execute('delivery_ack',ackInput(f)),
        /DELIVERY_PRESENTATION_ENVELOPE_INVALID|DELIVERY_PRESENTATION_CLAIMS_INVALID/);
    }
    f.state.proof={schema:1,keyId:'host-key-1',claims:{},signature:'a'.repeat(86),extra:'injected'};
    await assert.rejects(()=>f.adapter.execute('delivery_ack',ackInput(f)),
      /DELIVERY_PRESENTATION_ENVELOPE_INVALID/);
    const invalid={schema:1,keyId:'host-key-1',claims:{},signature:'a'.repeat(86)};
    Object.defineProperty(invalid,'claims',{get(){throw Error('GETTER_EXECUTED');},enumerable:true});
    f.state.proof=invalid;
    await assert.rejects(()=>f.adapter.execute('delivery_ack',ackInput(f)),
      /DELIVERY_PRESENTATION_ENVELOPE_INVALID/);
    assert.equal(f.store.get(f.item.deliveryId,'route-one').receiptId,null);
  }finally{f.close();}
});
test('owner grant revoked while native proof awaits cannot commit ACK',async()=>{
  const f=fixture();
  try{
    await claim(f);
    let cached;
    const signed=createSignedDeliveryPresentationAttestor({
      issuer:'native-owner-service',audience:'commander-delivery',
      publicKeys:f.trust,now:()=>TIME,assertWorkerIdentityCurrent:async()=>true,
      fetchSignedReceipt:async request=>{
        cached=f.signProof(request);
        f.state.grant=false;
        return cached;
      }
    });
    const adapter=createAuthenticatedDeliveryTools({
      store:f.store,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>({...f.state.caller,correlationId:f.state.correlationId,bindingId:EPOCH}),
      authorizeDelivery:async()=>f.state.grant,attestPresentation:signed
    });
    await assert.rejects(()=>adapter.execute('delivery_ack',ackInput(f)),
      /DELIVERY_AUTH_GRANT_REQUIRED/);
    assert.equal(f.store.get(f.item.deliveryId,'route-one').state,'DELIVERY_PENDING');
    assert.equal(f.store.get(f.item.deliveryId,'route-one').receiptId,null);
  }finally{f.close();}
});
test('verifier requires independent trusted Ed25519 key, issuer and Host proof callback',()=>{
  const key=generateKeyPairSync('ed25519');
  assert.throws(()=>createSignedDeliveryPresentationAttestor(),
    /DELIVERY_PRESENTATION_TRUST_REQUIRED/);
  assert.throws(()=>createSignedDeliveryPresentationAttestor({
    issuer:'native-owner-service',audience:'commander-delivery',
    publicKeys:new Map([['host-key-1',key.privateKey]]),
    fetchSignedReceipt:async()=>({})
  }),/DELIVERY_PRESENTATION_TRUST_REQUIRED/);
  assert.throws(()=>createSignedDeliveryPresentationAttestor({
    issuer:'native-owner-service',audience:'commander-delivery',
    publicKeys:new Map([['host-key-1',key.publicKey]])
  }),/DELIVERY_PRESENTATION_TRUST_REQUIRED/);
});


test('trusted Host key rotation supports overlap and revocation removes the retired key',async()=>{
  const f=fixture();
  try{
    const rotated=generateKeyPairSync('ed25519');
    const overlapItem=f.store.publish({
      eventKey:'operation:key-rotation-overlap',correlationId:'route-one',
      source:'operation',sourceId:'key-rotation-overlap',kind:'COMPLETED',bindingId:EPOCH,
       originReceiptHash:'e'.repeat(64),workerIdentity:WORKER_IDENTITY
    });
    await f.adapter.execute('delivery_claim',{
      deliveryId:overlapItem.deliveryId,attemptId:'attempt-overlap'
    });
    const overlapVerifier=createSignedDeliveryPresentationAttestor({
      issuer:'native-owner-service',audience:'commander-delivery',
      publicKeys:new Map([
        ['host-key-1',f.keys.publicKey],['host-key-2',rotated.publicKey]
      ]),
      now:()=>TIME,assertWorkerIdentityCurrent:async()=>true,
      fetchSignedReceipt:async request=>
        f.signProof(request,{},rotated.privateKey,'host-key-2')
    });
    const overlapAdapter=createAuthenticatedDeliveryTools({
      store:f.store,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>({...f.state.caller,
        correlationId:f.state.correlationId,bindingId:f.state.bindingId}),
      authorizeDelivery:async()=>f.state.grant,attestPresentation:overlapVerifier
    });
    const rotatedAck=await overlapAdapter.execute('delivery_ack',{
      deliveryId:overlapItem.deliveryId,attemptId:'attempt-overlap'
    });
    assert.equal(rotatedAck.state,'DELIVERED');
    assert.equal(f.store.get(overlapItem.deliveryId,'route-one').receiptId,
      rotatedAck.receiptId);

    const revokedItem=f.store.publish({
      eventKey:'operation:key-rotation-revoked',correlationId:'route-one',
      source:'operation',sourceId:'key-rotation-revoked',kind:'COMPLETED',bindingId:EPOCH,
       originReceiptHash:'e'.repeat(64),workerIdentity:WORKER_IDENTITY
    });
    await f.adapter.execute('delivery_claim',{
      deliveryId:revokedItem.deliveryId,attemptId:'attempt-revoked'
    });
    const revokedVerifier=createSignedDeliveryPresentationAttestor({
      issuer:'native-owner-service',audience:'commander-delivery',
      publicKeys:new Map([['host-key-2',rotated.publicKey]]),
      now:()=>TIME,
      fetchSignedReceipt:async request=>
        f.signProof(request,{},f.keys.privateKey,'host-key-1')
    });
    const revokedAdapter=createAuthenticatedDeliveryTools({
      store:f.store,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>({...f.state.caller,
        correlationId:f.state.correlationId,bindingId:f.state.bindingId}),
      authorizeDelivery:async()=>f.state.grant,attestPresentation:revokedVerifier
    });
    await assert.rejects(()=>revokedAdapter.execute('delivery_ack',{
      deliveryId:revokedItem.deliveryId,attemptId:'attempt-revoked'
    }),/DELIVERY_PRESENTATION_KEY_UNTRUSTED/);
    const after=f.store.get(revokedItem.deliveryId,'route-one');
    assert.equal(after.state,'DELIVERY_PENDING');
    assert.equal(after.receiptId,null);
  }finally{f.close();}
});

test('runtime composition refuses injected presentation attestators and missing owner trust',()=>{
  assert.throws(()=>createProtectedDeliveryMcpEventsRuntimeWithSignedPresentation({
    attestPresentation:async()=>({verified:true,presentationId:'client'})
  }),/DELIVERY_EVENTS_PRESENTATION_CONFIG_AMBIGUOUS/);
  assert.throws(()=>createProtectedDeliveryMcpEventsRuntimeWithSignedPresentation({}),
    /DELIVERY_PRESENTATION_TRUST_REQUIRED/);
  const key=generateKeyPairSync('ed25519');
  assert.throws(()=>createProtectedDeliveryMcpEventsRuntimeWithSignedPresentation({
    presentationIssuer:'native-owner-service',presentationAudience:'commander-delivery',
    presentationPublicKeys:new Map([['host-key-1',key.publicKey]]),
    fetchSignedPresentationReceipt:async()=>({})
  }),/DELIVERY_PRESENTATION_TRUST_REQUIRED/);
});

test('runtime composes the signed Host verifier; webhook 2xx never ACKs presentation',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v106-signed-runtime-'));
  const deliveryStore=new DeliveryStore({directory:path.join(root,'delivery'),scope:'profile-one'});
  const subscriptionStore=new DeliveryEventSubscriptionStore({
    directory:path.join(root,'subscriptions'),profileScope:'d'.repeat(64)
  });
  const keys=generateKeyPairSync('ed25519');
  const caller=CALLER,correlationId='route-runtime',bindingId=EPOCH;
  const endpoint='https://callbacks.example.net/mcp-events';
  const secret='whsec_'+Buffer.alloc(32,9).toString('base64');
  const sealed=new Map(),requests=[];
  const item=deliveryStore.publish({
    bindingId,eventKey:'operation:runtime:complete',source:'operation',
    sourceId:'runtime',correlationId,kind:'COMPLETED',
     originReceiptHash:'e'.repeat(64),workerIdentity:WORKER_IDENTITY
  });
  const runtime=createProtectedDeliveryMcpEventsRuntimeWithSignedPresentation({
    deliveryStore,subscriptionStore,
    observeCaller:async()=>caller,
    resolveBinding:async()=>({...caller,correlationId,bindingId}),
    authorizeDelivery:async()=>true,
    authorizeSubscription:async()=>true,
    authorizeSend:async()=>true,
    sealSecret:async value=>{
      const id='sealed:'+createHash('sha256').update(value).digest('hex');
      sealed.set(id,value);return id;
    },
    unsealSecret:async id=>sealed.get(id),
    verifiedHttpsTransport:{
      postVerifiedHttps:async request=>{
        requests.push(request);
        const body=JSON.parse(request.body);
        if(body.type==='verification')
          return {status:200,body:JSON.stringify({challenge:body.challenge})};
        return {status:202,body:''};
      }
    },
    now:()=>TIME,
    presentationIssuer:'native-owner-service',
    presentationAudience:'commander-delivery',
    presentationPublicKeys:new Map([['host-key-1',keys.publicKey]]),
    assertWorkerIdentityCurrent:async()=>true,
    fetchSignedPresentationReceipt:async request=>{
      const claims={
        issuer:'native-owner-service',audience:'commander-delivery',
        ...request,presentationId:'native-display-runtime',
        issuedAtMs:TIME-1000,expiresAtMs:TIME+10000,nonce:'runtime-nonce'
      };
      const workerBound=Object.hasOwn(request,'workerId');
      const fields=workerBound?FIELDS_V2:FIELDS_V1;
      const domain=workerBound?DOMAIN_V2:DOMAIN_V1;
      const keyId='host-key-1';
      const bytes=Buffer.from(JSON.stringify([
        domain,keyId,...fields.map(k=>claims[k])
      ]));
      return {schema:workerBound?2:1,keyId,claims,
        signature:sign(null,bytes,keys.privateKey).toString('base64url')};
    }
  });
  try{
    const subscription=await runtime.methods['events/subscribe']({
      name:DELIVERY_MCP_EVENT,arguments:{},
      delivery:{mode:'webhook',url:endpoint,secret},cursor:null
    });
    const transport=await runtime.dispatchHostEvent({
      deliveryId:item.deliveryId,subscriptionId:subscription.id
    });
    assert.equal(transport.webhookAccepted,true);
    assert.equal(transport.resultDeliveryAcknowledged,false);
    assert.equal(deliveryStore.get(item.deliveryId,correlationId).state,
      'COMPLETED_UNDELIVERED');
    assert.equal(deliveryStore.get(item.deliveryId,correlationId).receiptId,null);
    assert.equal(requests.length,2);
    await runtime.protectedDelivery.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'runtime-attempt'
    });
    const ack=await runtime.protectedDelivery.execute('delivery_ack',{
      deliveryId:item.deliveryId,attemptId:'runtime-attempt'
    });
    assert.equal(ack.state,'DELIVERED');
    assert.equal(deliveryStore.get(item.deliveryId,correlationId).receiptId,ack.receiptId);
    assert.equal(requests.length,2,'presentation receipt is a distinct native Host callback, not a webhook response');
  }finally{
    deliveryStore.close();subscriptionStore.close();
    fs.rmSync(root,{recursive:true,force:true});
  }
});
