import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {DeliveryStore} from '../src/delivery-store.mjs';
import {DeliveryEventSubscriptionStore} from '../src/delivery-mcp-subscription-store.mjs';
import {createRotatingProtectedDeliveryMcpEventsRuntime}
  from '../src/delivery-mcp-runtime-manager.mjs';
import {DELIVERY_MCP_EVENT} from '../src/delivery-mcp-events.mjs';

const TIME=Date.UTC(2026,10,7,5,0,0);
const DOMAIN='commander.delivery.presentation.v1';
const FIELDS=[
  'issuer','audience','hostId','principalId','profileId','conversationId',
  'bindingId','deliveryId','correlationId','attemptId','resultHash',
  'presentationId','issuedAtMs','expiresAtMs','nonce'
];
const EPOCH='b'.repeat(32);
const CALLER=Object.freeze({
  hostId:'host-one',principalId:'owner-one',
  profileId:'profile-one',conversationId:'chat-one'
});
const endpoint='https://callbacks.example.net/mcp-events';
const secret='whsec_'+Buffer.alloc(32,9).toString('base64');
function deferred(){
  let resolve;
  const promise=new Promise(r=>{resolve=r;});
  return {promise,resolve};
}
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v106-runtime-rotation-'));
  const deliveryStore=new DeliveryStore({directory:path.join(root,'delivery'),scope:'profile-one'});
  const subscriptionStore=new DeliveryEventSubscriptionStore({
    directory:path.join(root,'subscriptions'),profileScope:'d'.repeat(64)
  });
  const oldKeys=generateKeyPairSync('ed25519');
  const newKeys=generateKeyPairSync('ed25519');
  const sealed=new Map();
  const signProof=(request,keyPair,keyId)=>{
    const claims={
      issuer:'native-owner-service',audience:'commander-delivery',
      ...request,presentationId:'host-display-'+keyId,
      issuedAtMs:TIME-1000,expiresAtMs:TIME+10000,nonce:'nonce-'+keyId
    };
    const bytes=Buffer.from(JSON.stringify([DOMAIN,keyId,...FIELDS.map(k=>claims[k])]));
    return {schema:1,keyId,claims,signature:sign(null,bytes,keyPair.privateKey).toString('base64url')};
  };
  const options=({trustedKeys,signer,proofGate=null}={})=>({
    deliveryStore,subscriptionStore,
    observeCaller:async()=>CALLER,
    resolveBinding:async()=>({...CALLER,correlationId:'route-one',bindingId:EPOCH}),
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
        const body=JSON.parse(request.body);
        if(body.type==='verification')
          return {status:200,body:JSON.stringify({challenge:body.challenge})};
        return {status:202,body:''};
      }
    },
    now:()=>TIME,
    presentationIssuer:'native-owner-service',
    presentationAudience:'commander-delivery',
    presentationPublicKeys:trustedKeys,
    assertWorkerIdentityCurrent:async()=>true,
    fetchSignedPresentationReceipt:async request=>{
      if(proofGate)await proofGate(request);
      return signProof(request,signer.keyPair,signer.keyId);
    }
  });
  const publish=sourceId=>deliveryStore.publish({
    eventKey:'operation:'+sourceId,correlationId:'route-one',
    source:'operation',sourceId,kind:'COMPLETED',bindingId:EPOCH
  });
  const claim=async(runtime,item,attemptId)=>runtime.protectedDelivery.execute('delivery_claim',{
    deliveryId:item.deliveryId,correlationId:'route-one',attemptId
  });
  const ackInput=(item,attemptId)=>({
    deliveryId:item.deliveryId,correlationId:'route-one',attemptId
  });
  const manager=createRotatingProtectedDeliveryMcpEventsRuntime(options({
    trustedKeys:new Map([['host-key-1',oldKeys.publicKey]]),
    signer:{keyPair:oldKeys,keyId:'host-key-1'}
  }));
  return {
    root,deliveryStore,subscriptionStore,oldKeys,newKeys,manager,options,publish,claim,ackInput,
    close:async()=>{
      await manager.close();
      deliveryStore.close();subscriptionStore.close();
      fs.rmSync(root,{recursive:true,force:true});
    }
  };
}

test('runtime rotation drains, swaps trust and preserves durable delivery and subscription stores',async()=>{
  const f=fixture();
  try{
    const subscription=await f.manager.methods['events/subscribe']({
      name:DELIVERY_MCP_EVENT,arguments:{},
      delivery:{mode:'webhook',url:endpoint,secret},cursor:null
    });
    assert.equal(subscription.id.startsWith('sub_'),true);
    assert.equal(f.subscriptionStore.status().total,1);

    const item=f.publish('rotation-overlap');
    await f.claim(f.manager,item,'attempt-overlap');
    const savedExecute=f.manager.protectedDelivery.execute;
    const overlap=await f.manager.rotate(f.options({
      trustedKeys:new Map([
        ['host-key-1',f.oldKeys.publicKey],['host-key-2',f.newKeys.publicKey]
      ]),
      signer:{keyPair:f.newKeys,keyId:'host-key-2'}
    }));
    assert.deepEqual(overlap,{previousGeneration:1,generation:2,drainedCalls:0});
    const delivered=await savedExecute('delivery_ack',f.ackInput(item,'attempt-overlap'));
    assert.equal(delivered.state,'DELIVERED');
    assert.equal(f.deliveryStore.get(item.deliveryId,'route-one').receiptId,delivered.receiptId);
    assert.equal(f.subscriptionStore.status().total,1,
      'rotation must retain the existing subscription database and records');

    const revoked=f.publish('rotation-retired-key');
    await f.claim(f.manager,revoked,'attempt-retired');
    await f.manager.rotate(f.options({
      trustedKeys:new Map([['host-key-2',f.newKeys.publicKey]]),
      signer:{keyPair:f.oldKeys,keyId:'host-key-1'}
    }));
    await assert.rejects(
      ()=>savedExecute('delivery_ack',f.ackInput(revoked,'attempt-retired')),
      /DELIVERY_PRESENTATION_KEY_UNTRUSTED/
    );
    assert.equal(f.deliveryStore.get(revoked.deliveryId,'route-one').state,'DELIVERY_PENDING');
    assert.equal(f.deliveryStore.get(revoked.deliveryId,'route-one').receiptId,null);

    const current=await f.manager.rotate(f.options({
      trustedKeys:new Map([['host-key-2',f.newKeys.publicKey]]),
      signer:{keyPair:f.newKeys,keyId:'host-key-2'}
    }));
    assert.equal(current.generation,4);
    const finalAck=await savedExecute('delivery_ack',f.ackInput(revoked,'attempt-retired'));
    assert.equal(finalAck.state,'DELIVERED');
    assert.equal(f.subscriptionStore.status().total,1);
  }finally{await f.close();}
});

test('rotation blocks new calls and waits for old-generation ACK to drain before reporting retirement',async()=>{
  const f=fixture();
  const entered=deferred(),releaseProof=deferred();
  try{
    const item=f.publish('rotation-drain');
    await f.claim(f.manager,item,'attempt-drain');
    const oldRuntime=f.options({
      trustedKeys:new Map([['host-key-1',f.oldKeys.publicKey]]),
      signer:{keyPair:f.oldKeys,keyId:'host-key-1'},
      proofGate:async()=>{entered.resolve();await releaseProof.promise;}
    });
    // Install a controlled old verifier before starting the in-flight ACK.
    await f.manager.rotate(oldRuntime);
    const ack=f.manager.protectedDelivery.execute('delivery_ack',f.ackInput(item,'attempt-drain'));
    await entered.promise;
    const rotation=f.manager.rotate(f.options({
      trustedKeys:new Map([['host-key-2',f.newKeys.publicKey]]),
      signer:{keyPair:f.newKeys,keyId:'host-key-2'}
    }));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.manager.status().activeCalls,1);
    assert.equal(f.manager.status().pendingRotations,1);
    let readerCompleted=false;
    const reader=f.manager.methods['events/list']({}).then(()=>{readerCompleted=true;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(readerCompleted,false,'new calls must wait behind the retirement barrier');
    releaseProof.resolve();
    const oldAck=await ack;
    const result=await rotation;
    await reader;
    assert.equal(oldAck.state,'DELIVERED');
    assert.equal(result.generation,3);
    assert.equal(result.drainedCalls,1);
    assert.equal(readerCompleted,true);
    assert.equal(f.manager.status().activeCalls,0);
    assert.equal(f.manager.status().rotationInProgress,false);
  }finally{
    releaseProof.resolve();
    await f.close();
  }
});

test('rotation cannot replace durable stores and close retires runtime without closing Host-owned stores',async()=>{
  const f=fixture();
  try{
    const next=f.options({
      trustedKeys:new Map([['host-key-2',f.newKeys.publicKey]]),
      signer:{keyPair:f.newKeys,keyId:'host-key-2'}
    });
    assert.throws(()=>f.manager.rotate({...next,presentationPublicKeys:new Map()}),
      /DELIVERY_PRESENTATION_TRUST_REQUIRED/);
    assert.equal(f.manager.status().generation,1,
      'invalid trust material must leave the current runtime active');
    const stillLive=f.publish('rotation-invalid-next-trust');
    await f.claim(f.manager,stillLive,'attempt-still-live');
    const liveAck=await f.manager.protectedDelivery.execute('delivery_ack',
      f.ackInput(stillLive,'attempt-still-live'));
    assert.equal(liveAck.state,'DELIVERED');

    assert.throws(()=>f.manager.rotate({...next,deliveryStore:{}}),
      /DELIVERY_EVENTS_RUNTIME_STORE_REPLACEMENT_FORBIDDEN/);
    assert.equal(f.manager.status().generation,1);
    const closed=await f.manager.close();
    assert.equal(closed.closed,true);
    await assert.rejects(()=>f.manager.methods['events/list']({}),
      /DELIVERY_EVENTS_RUNTIME_CLOSED/);
    assert.equal(f.subscriptionStore.status().durable,true);
    assert.equal(f.deliveryStore.health().pending,0);
  }finally{
    // close() is idempotent; the fixture remains the owner of both SQLite stores.
    await f.close();
  }
});


test('queued rotations remain FIFO and readers cannot observe an intermediate overlap generation',async()=>{
  const f=fixture();
  const entered=deferred(),releaseProof=deferred();
  try{
    const first=f.publish('rotation-fifo-drain');
    const second=f.publish('rotation-fifo-reader');
    await f.claim(f.manager,first,'attempt-fifo-drain');
    await f.claim(f.manager,second,'attempt-fifo-reader');
    await f.manager.rotate(f.options({
      trustedKeys:new Map([['host-key-1',f.oldKeys.publicKey]]),
      signer:{keyPair:f.oldKeys,keyId:'host-key-1'},
      proofGate:async()=>{entered.resolve();await releaseProof.promise;}
    }));
    const oldAck=f.manager.protectedDelivery.execute(
      'delivery_ack',f.ackInput(first,'attempt-fifo-drain')
    );
    await entered.promise;
    const overlap=f.manager.rotate(f.options({
      trustedKeys:new Map([
        ['host-key-1',f.oldKeys.publicKey],['host-key-2',f.newKeys.publicKey]
      ]),
      signer:{keyPair:f.newKeys,keyId:'host-key-2'}
    }));
    const retirement=f.manager.rotate(f.options({
      trustedKeys:new Map([['host-key-2',f.newKeys.publicKey]]),
      signer:{keyPair:f.oldKeys,keyId:'host-key-1'}
    }));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.manager.status().activeCalls,1);
    assert.equal(f.manager.status().pendingRotations,2);
    let readerSettled=false;
    const reader=f.manager.protectedDelivery.execute(
      'delivery_ack',f.ackInput(second,'attempt-fifo-reader')
    ).finally(()=>{readerSettled=true;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(readerSettled,false,
      'reader must not enter the temporary old+new trust overlap generation');
    releaseProof.resolve();
    assert.equal((await oldAck).state,'DELIVERED');
    const firstRotation=await overlap;
    const finalRotation=await retirement;
    assert.equal(firstRotation.generation,3);
    assert.equal(firstRotation.drainedCalls,1);
    assert.equal(finalRotation.previousGeneration,3);
    assert.equal(finalRotation.generation,4);
    assert.equal(finalRotation.drainedCalls,0);
    await assert.rejects(reader,/DELIVERY_PRESENTATION_KEY_UNTRUSTED/);
    assert.equal(f.deliveryStore.get(second.deliveryId,'route-one').state,'DELIVERY_PENDING');
    assert.equal(f.manager.status().generation,4);
    assert.equal(f.manager.status().pendingRotations,0);
  }finally{
    releaseProof.resolve();
    await f.close();
  }
});

test('close is idempotent, drains an active ACK and rejects readers queued behind retirement',async()=>{
  const f=fixture();
  const entered=deferred(),releaseProof=deferred();
  try{
    const item=f.publish('runtime-close-drain');
    await f.claim(f.manager,item,'attempt-close-drain');
    await f.manager.rotate(f.options({
      trustedKeys:new Map([['host-key-1',f.oldKeys.publicKey]]),
      signer:{keyPair:f.oldKeys,keyId:'host-key-1'},
      proofGate:async()=>{entered.resolve();await releaseProof.promise;}
    }));
    const ack=f.manager.protectedDelivery.execute(
      'delivery_ack',f.ackInput(item,'attempt-close-drain')
    );
    await entered.promise;
    const closing=f.manager.close();
    assert.equal(f.manager.close(),closing,'concurrent close calls share one retirement promise');
    const lateRotation=f.manager.rotate(f.options({
      trustedKeys:new Map([['host-key-2',f.newKeys.publicKey]]),
      signer:{keyPair:f.newKeys,keyId:'host-key-2'}
    }));
    let closeSettled=false;
    closing.then(()=>{closeSettled=true;});
    const waitingReader=f.manager.methods['events/list']({}).then(
      ()=>({resolved:true}),error=>({resolved:false,code:error.code})
    );
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.manager.status().activeCalls,1);
    assert.equal(f.manager.status().pendingRotations,2,
      'close retirement and the late rotation are both queued behind the active ACK');
    assert.equal(closeSettled,false);
    releaseProof.resolve();
    assert.equal((await ack).state,'DELIVERED');
    assert.deepEqual(await closing,{closed:true,generation:2});
    await assert.rejects(lateRotation,/DELIVERY_EVENTS_RUNTIME_CLOSED/);
    assert.deepEqual(await waitingReader,{resolved:false,code:'DELIVERY_EVENTS_RUNTIME_CLOSED'});
    assert.deepEqual(f.manager.status(),{
      generation:2,activeCalls:0,pendingRotations:0,rotationInProgress:false,closed:true
    });
    assert.equal(f.deliveryStore.health().pending,0);
    assert.equal(f.subscriptionStore.status().durable,true,
      'closing the runtime must not close Host-owned SQLite stores');
  }finally{
    releaseProof.resolve();
    await f.close();
  }
});


test('queued trust upgrade cannot later downgrade protected chat identity even when rotation was queued first',async()=>{
  const f=fixture();
  try{
    const oldOptions=f.options({
      trustedKeys:new Map([['host-key-1',f.oldKeys.publicKey]]),
      signer:{keyPair:f.oldKeys,keyId:'host-key-1'}
    });
    const signedOptions={
      ...oldOptions,
      chatContext:{
        issuer:'trusted-host',audience:'commander-delivery',
        expectedHostId:'host-one',expectedProfileId:'profile-one',
        publicKeys:new Map([['chat-key',f.newKeys.publicKey]]),
        fetchSignedContext:async()=>{throw new Error('NO_NATIVE_ISSUER_IN_QA');},
        isBindingCurrent:async()=>true
      }
    };
    // The signed mode intentionally forbids inherited legacy identity callbacks.
    delete signedOptions.observeCaller;
    delete signedOptions.resolveBinding;
    const upgrade=f.manager.rotate(signedOptions);
    const queuedDowngrade=f.manager.rotate(oldOptions);
    assert.equal((await upgrade).generation,2);
    await assert.rejects(queuedDowngrade,
      /DELIVERY_EVENTS_RUNTIME_TRUST_DOWNGRADE_FORBIDDEN/);
    assert.equal(f.manager.status().generation,2);
    assert.throws(()=>f.manager.rotate(oldOptions),
      /DELIVERY_EVENTS_RUNTIME_TRUST_DOWNGRADE_FORBIDDEN/);
    assert.equal(f.manager.status().generation,2);
  }finally{await f.close();}
});
