import test from 'node:test';
const EPOCH='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DeliveryStore} from '../src/delivery-store.mjs';
import {createAuthenticatedDeliveryTools} from '../src/delivery-authenticated.mjs';

const A = Object.freeze({hostId:'host-1',principalId:'alice',profileId:'owner',
  conversationId:'conversation-alice'});
const B = Object.freeze({hostId:'host-1',principalId:'bob',profileId:'owner',
  conversationId:'conversation-bob'});

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v106-protected-'));
  const store=new DeliveryStore({directory:path.join(root,'state'),scope:'owner'});
  const state={caller:A,binding:{...A,correlationId:'route-alice',bindingId:EPOCH},grant:true};
  const calls=[];
  const adapter=createAuthenticatedDeliveryTools({
    store,
    observeCaller:async()=>state.caller,
    resolveBinding:async()=>state.binding,
    authorizeDelivery:async operation=>{calls.push(operation); return state.grant;},
    // Simulated independent native presenter; real production integration must
    // provide an authenticated host receipt, never caller-supplied status.
    attestPresentation:async request=>({
      ...request,verified:true,presentationId:'verified-owner-presentation'
    })
  });
  const publish=(id='one',correlationId='route-alice')=>store.publish({bindingId:EPOCH,
    eventKey:'operation:'+id+':complete',correlationId,source:'operation',sourceId:id,kind:'COMPLETED'
  });
  return {root,store,state,calls,adapter,publish,close(){
    store.close();fs.rmSync(root,{recursive:true,force:true});
  }};
}

test('protected adapter requires independently supplied identity, route and grant hooks',()=>{
  assert.throws(()=>createAuthenticatedDeliveryTools(),/DELIVERY_AUTH_TRUSTED_INTEGRATION_REQUIRED/);
  assert.throws(()=>createAuthenticatedDeliveryTools({store:{}}),/DELIVERY_AUTH_TRUSTED_INTEGRATION_REQUIRED/);
});

test('authorized delivery is claimed and acknowledged exactly once with trusted routing',async()=>{
  const f=fixture();
  try{
    const item=f.publish();
    const list=await f.adapter.execute('delivery_list',{limit:2});
    assert.equal(list.items.length,1);
    const claimed=await f.adapter.execute('delivery_claim',{deliveryId:item.deliveryId,attemptId:'attempt-one'});
    assert.equal(claimed.state,'DELIVERY_PENDING');
    const ack=await f.adapter.execute('delivery_ack',{deliveryId:item.deliveryId,attemptId:'attempt-one'});
    assert.equal(ack.state,'DELIVERED');
    const retry=await f.adapter.execute('delivery_ack',{deliveryId:item.deliveryId,attemptId:'attempt-one'});
    assert.equal(retry.receiptId,ack.receiptId);
    assert.ok(f.calls.every(v=>v.caller.principalId==='alice'&&v.correlationId==='route-alice'));
  }finally{f.close();}
});

test('unknown identity is rejected before any store mutation',async()=>{
  const f=fixture();
  try{
    const item=f.publish();f.state.caller=null;
    await assert.rejects(()=>f.adapter.execute('delivery_claim',{deliveryId:item.deliveryId,attemptId:'x'}),/DELIVERY_AUTH_CALLER_REQUIRED/);
    assert.equal(f.store.get(item.deliveryId,'route-alice').attempts,0);
    assert.equal(f.calls.length,0);
  }finally{f.close();}
});

test('caller-provided identity and arbitrary correlation cannot grant another chat access',async()=>{
  const f=fixture();
  try{
    const item=f.publish();f.state.caller=B;f.state.binding={...B,correlationId:'route-bob',bindingId:EPOCH};
    await assert.rejects(()=>f.adapter.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'spoof',correlationId:'route-alice'
    }),/DELIVERY_AUTH_CORRELATION_MISMATCH/);
    await assert.rejects(()=>f.adapter.execute('delivery_ack',{
      deliveryId:item.deliveryId,attemptId:'spoof',principalId:'alice'
    }),/DELIVERY_AUTH_UNTRUSTED_IDENTITY/);
    await assert.rejects(()=>f.adapter.execute('delivery_get',{deliveryId:item.deliveryId}),/DELIVERY_CORRELATION_MISMATCH/);
    assert.equal(f.store.get(item.deliveryId,'route-alice').state,'COMPLETED_UNDELIVERED');
  }finally{f.close();}
});

test('forged trusted binding identity cannot bypass matching chat route',async()=>{
  const f=fixture();
  try{
    const item=f.publish();
    f.state.binding={...B,correlationId:'route-alice',bindingId:EPOCH};
    await assert.rejects(()=>f.adapter.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'spoof'
    }),/DELIVERY_AUTH_BINDING_MISMATCH/);
    f.state.binding={...A};
    await assert.rejects(()=>f.adapter.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'spoof'
    }),/DELIVERY_AUTH_BINDING_MISMATCH/);
    assert.equal(f.store.get(item.deliveryId,'route-alice').attempts,0);
  }finally{f.close();}
});

test('explicit grant denial cannot claim or acknowledge an event',async()=>{
  const f=fixture();
  try{
    const item=f.publish();f.state.grant=false;
    await assert.rejects(()=>f.adapter.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'attempt-x'
    }),/DELIVERY_AUTH_GRANT_REQUIRED/);
    assert.equal(f.store.get(item.deliveryId,'route-alice').state,'COMPLETED_UNDELIVERED');
  }finally{f.close();}
});

test('session switch during asynchronous authorization rejects without effects',async()=>{
  const f=fixture();
  try{
    const item=f.publish();
    const adapter=createAuthenticatedDeliveryTools({
      store:f.store,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,
      authorizeDelivery:async()=>{f.state.caller=B;return true;}
    });
    await assert.rejects(()=>adapter.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'attempt-x'
    }),/DELIVERY_AUTH_SESSION_CHANGED/);
    assert.equal(f.store.get(item.deliveryId,'route-alice').attempts,0);
  }finally{f.close();}
});

test('rebound chat route during asynchronous grant check rejects without effects',async()=>{
  const f=fixture();
  try{
    const item=f.publish();
    const adapter=createAuthenticatedDeliveryTools({
      store:f.store,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,
      authorizeDelivery:async()=>{f.state.binding={...A,correlationId:'route-new',bindingId:EPOCH};return true;}
    });
    await assert.rejects(()=>adapter.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'attempt-x'
    }),/DELIVERY_AUTH_BINDING_CHANGED/);
    assert.equal(f.store.get(item.deliveryId,'route-alice').state,'COMPLETED_UNDELIVERED');
  }finally{f.close();}
});

test('protected adapter does not expose owner maintenance or unknown operations',async()=>{
  const f=fixture();
  try{
    await assert.rejects(()=>f.adapter.execute('delivery_compact',{minAgeMs:0}),/DELIVERY_AUTH_OPERATION_NOT_ALLOWED/);
    await assert.rejects(()=>f.adapter.execute('delivery_reclassify_transport_receipts',{}),/DELIVERY_AUTH_OPERATION_NOT_ALLOWED/);
    await assert.rejects(()=>f.adapter.execute('run_shell',{}),/DELIVERY_AUTH_OPERATION_NOT_ALLOWED/);
  }finally{f.close();}
});

test('scoped artifact retrieval rejects cross-conversation delivery and preserves bytes',async()=>{
  const f=fixture();
  try{
    const artifact=f.store.writeArtifact({text:'secret for alice'});
    const a=f.store.publish({bindingId:EPOCH,eventKey:'tool:artifact:final',correlationId:'route-alice',
      source:'tool',sourceId:'artifact',kind:'COMPLETED',artifact});
    const received=await f.adapter.execute('delivery_read_artifact',{
      deliveryId:a.deliveryId,maxBytes:1024
    });
    assert.equal(JSON.parse(Buffer.from(received.data,'base64').toString()).text,'secret for alice');
    f.state.caller=B;f.state.binding={...B,correlationId:'route-bob',bindingId:EPOCH};
    await assert.rejects(()=>f.adapter.execute('delivery_read_artifact',{
      deliveryId:a.deliveryId,maxBytes:1024
    }),/DELIVERY_CORRELATION_MISMATCH/);
  }finally{f.close();}
});

test('authorization sees every operation input and rejects tampering after await',async()=>{
  const f=fixture();
  try{
    const item=f.publish();
    const input={deliveryId:item.deliveryId,attemptId:'original-attempt'};
    const operations=[];
    const adapter=createAuthenticatedDeliveryTools({
      store:f.store,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,
      authorizeDelivery:async operation=>{
        operations.push(operation);
        input.attemptId='altered-attempt';
        return true;
      }
    });
    const claimed=await adapter.execute('delivery_claim',input);
    assert.equal(claimed.attemptId,'original-attempt');
    assert.equal(operations[0].args.attemptId,'original-attempt');
    assert.equal(Object.isFrozen(operations[0].args),true);
  }finally{f.close();}
});

test('unexpected fields and accessors are refused before caller observation',async()=>{
  const f=fixture();
  try{
    const item=f.publish();
    await assert.rejects(()=>f.adapter.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'one',anyFuturePermission:true
    }),/DELIVERY_AUTH_ARGUMENTS_INVALID/);
    const accessor={deliveryId:item.deliveryId};
    Object.defineProperty(accessor,'attemptId',{enumerable:true,get(){throw Error('ACCESSOR_EXECUTED');}});
    await assert.rejects(()=>f.adapter.execute('delivery_claim',accessor),/DELIVERY_AUTH_ARGUMENTS_INVALID/);
    assert.equal(f.calls.length,0);
    assert.equal(f.store.get(item.deliveryId,'route-alice').attempts,0);
  }finally{f.close();}
});

test('range-specific policy must receive immutable exact bounded read input',async()=>{
  const f=fixture();
  try{
    const payload={text:'range-owner'};
    const artifact=f.store.writeArtifact(payload);
    const item=f.store.publish({bindingId:EPOCH,eventKey:'tool:ranged:final',correlationId:'route-alice',
      source:'tool',sourceId:'ranged',kind:'COMPLETED',artifact});
    const adapter=createAuthenticatedDeliveryTools({
      store:f.store,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,
      authorizeDelivery:async operation=>
        operation.name==='delivery_read_artifact'
        &&operation.args.offset===0&&operation.args.maxBytes===2048
        &&Object.isFrozen(operation.args)
    });
    const chunk=await adapter.execute('delivery_read_artifact',{
      deliveryId:item.deliveryId,offset:0,maxBytes:2048
    });
    assert.equal(JSON.parse(Buffer.from(chunk.data,'base64').toString()).text,'range-owner');
    await assert.rejects(()=>adapter.execute('delivery_read_artifact',{
      deliveryId:item.deliveryId,offset:1,maxBytes:2048
    }),/DELIVERY_AUTH_GRANT_REQUIRED/);
  }finally{f.close();}
});

test('restricted list operation cannot turn into unbounded or hidden option',async()=>{
  const f=fixture();
  try{
    f.publish();
    const policies=[];
    const adapter=createAuthenticatedDeliveryTools({
      store:f.store,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,
      authorizeDelivery:async op=>{policies.push(op);return op.args.limit===1;}
    });
    const result=await adapter.execute('delivery_list',{limit:1});
    assert.equal(result.items.length,1);
    await assert.rejects(()=>adapter.execute('delivery_list',{limit:50}),/DELIVERY_AUTH_GRANT_REQUIRED/);
    await assert.rejects(()=>adapter.execute('delivery_list',{limit:1,includeEverything:true}),/DELIVERY_AUTH_ARGUMENTS_INVALID/);
    // Successful requests now require a second grant after native binding
    // re-attestation; the rejected request stops at the first denial.
    assert.equal(policies.length,3);
    assert.equal(policies.filter(x=>x.args.limit===1).length,2);
    assert.equal(policies.filter(x=>x.args.limit===50).length,1);
  }finally{f.close();}
});

test('ACK is rejected without independently verified presentation receipt',async()=>{
  const f=fixture();
  try{
    const item=f.publish('no-presentation');
    const adapter=createAuthenticatedDeliveryTools({
      store:f.store,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,authorizeDelivery:async()=>true
    });
    await adapter.execute('delivery_claim',{deliveryId:item.deliveryId,attemptId:'attempt-nop'});
    await assert.rejects(()=>adapter.execute('delivery_ack',{
      deliveryId:item.deliveryId,attemptId:'attempt-nop'
    }),/DELIVERY_AUTH_PRESENTATION_REQUIRED/);
    assert.equal(f.store.get(item.deliveryId,'route-alice').state,'DELIVERY_PENDING');
  }finally{f.close();}
});

test('ACK rejects mismatched native presentation identity without writing a receipt',async()=>{
  const f=fixture();
  try{
    const item=f.publish('bad-presentation');
    const adapter=createAuthenticatedDeliveryTools({
      store:f.store,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,authorizeDelivery:async()=>true,
      attestPresentation:async request=>({
        ...request,verified:true,presentationId:'native-proof',
        principalId:'bob'
      })
    });
    await adapter.execute('delivery_claim',{deliveryId:item.deliveryId,attemptId:'attempt-bad'});
    await assert.rejects(()=>adapter.execute('delivery_ack',{
      deliveryId:item.deliveryId,attemptId:'attempt-bad'
    }),/DELIVERY_AUTH_PRESENTATION_MISMATCH/);
    assert.equal(f.store.get(item.deliveryId,'route-alice').receiptId,null);
  }finally{f.close();}
});

test('ACK rejects presentation proof from a stale or re-bound session',async()=>{
  const f=fixture();
  try{
    const item=f.publish('rebind-presentation');
    const adapter=createAuthenticatedDeliveryTools({
      store:f.store,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,authorizeDelivery:async()=>true,
      attestPresentation:async request=>{
        f.state.binding={...A,correlationId:'route-new',bindingId:EPOCH};
        return {...request,verified:true,presentationId:'native-proof'};
      }
    });
    await adapter.execute('delivery_claim',{deliveryId:item.deliveryId,attemptId:'attempt-rebind'});
    await assert.rejects(()=>adapter.execute('delivery_ack',{
      deliveryId:item.deliveryId,attemptId:'attempt-rebind'
    }),/DELIVERY_AUTH_BINDING_CHANGED/);
    assert.equal(f.store.get(item.deliveryId,'route-alice').receiptId,null);
  }finally{f.close();}
});

test('ACK cannot use client-supplied presentation proof',async()=>{
  const f=fixture();
  try{
    const item=f.publish('client-proof');
    await f.adapter.execute('delivery_claim',{deliveryId:item.deliveryId,attemptId:'attempt-client'});
    await assert.rejects(()=>f.adapter.execute('delivery_ack',{
      deliveryId:item.deliveryId,attemptId:'attempt-client',presentationId:'client-made'
    }),/DELIVERY_AUTH_ARGUMENTS_INVALID/);
    assert.equal(f.store.get(item.deliveryId,'route-alice').receiptId,null);
  }finally{f.close();}
});

test('ACK rejects grant revoked while trusted presentation is being verified',async()=>{
  const f=fixture();
  try{
    const item=f.publish('revoked-before-ack');
    const adapter=createAuthenticatedDeliveryTools({
      store:f.store,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,
      authorizeDelivery:async()=>f.state.grant,
      attestPresentation:async request=>{
        f.state.grant=false;
        return {...request,verified:true,presentationId:'native-receipt-revoked'};
      }
    });
    await adapter.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'attempt-before-revoke'
    });
    await assert.rejects(()=>adapter.execute('delivery_ack',{
      deliveryId:item.deliveryId,attemptId:'attempt-before-revoke'
    }),/DELIVERY_AUTH_GRANT_REQUIRED/);
    assert.equal(f.store.get(item.deliveryId,'route-alice').state,'DELIVERY_PENDING');
    assert.equal(f.store.get(item.deliveryId,'route-alice').receiptId,null);
  }finally{f.close();}
});

test('two independently attested chats deliver concurrently without cross-chat leakage',async()=>{
  const f=fixture();
  try{
    const a=f.publish('alice-parallel','route-alice');
    const b=f.publish('bob-parallel','route-bob');
    const make=(caller,correlationId)=>createAuthenticatedDeliveryTools({
      store:f.store,observeCaller:async()=>caller,
      resolveBinding:async()=>({...caller,correlationId,bindingId:EPOCH}),
      authorizeDelivery:async()=>true,
      attestPresentation:async request=>({
        ...request,verified:true,presentationId:'native-'+caller.principalId
      })
    });
    const alice=make(A,'route-alice');
    const bob=make(B,'route-bob');
    const [aList,bList]=await Promise.all([
      alice.execute('delivery_list',{limit:5}),
      bob.execute('delivery_list',{limit:5})
    ]);
    assert.deepEqual(aList.items.map(x=>x.deliveryId),[a.deliveryId]);
    assert.deepEqual(bList.items.map(x=>x.deliveryId),[b.deliveryId]);
    await assert.rejects(()=>bob.execute('delivery_claim',{
      deliveryId:a.deliveryId,attemptId:'bob-foreign'
    }),/DELIVERY_CORRELATION_MISMATCH/);
    const [aClaim,bClaim]=await Promise.all([
      alice.execute('delivery_claim',{deliveryId:a.deliveryId,attemptId:'alice-owned'}),
      bob.execute('delivery_claim',{deliveryId:b.deliveryId,attemptId:'bob-owned'})
    ]);
    assert.equal(aClaim.state,'DELIVERY_PENDING');
    assert.equal(bClaim.state,'DELIVERY_PENDING');
    const [aAck,bAck]=await Promise.all([
      alice.execute('delivery_ack',{deliveryId:a.deliveryId,attemptId:'alice-owned'}),
      bob.execute('delivery_ack',{deliveryId:b.deliveryId,attemptId:'bob-owned'})
    ]);
    assert.equal(aAck.state,'DELIVERED');
    assert.equal(bAck.state,'DELIVERED');
    assert.notEqual(aAck.receiptId,bAck.receiptId);
    assert.equal(f.store.get(a.deliveryId,'route-alice').attempts,1);
    assert.equal(f.store.get(b.deliveryId,'route-bob').attempts,1);
  }finally{f.close();}
});

test('lost ACK response replays the same durable receipt without repeating presentation',async()=>{
  const f=fixture();
  try{
    const item=f.publish('ack-lost');
    let loseResponse=true;let actualStoreAcks=0;
    const storeWithLostResponse={
      list:x=>f.store.list(x),get:(id,correlation)=>f.store.get(id,correlation),
      claim:x=>f.store.claim(x),readArtifact:x=>f.store.readArtifact(x),
      ack:args=>{
        actualStoreAcks+=1;
        const receipt=f.store.ack(args);
        if(loseResponse){loseResponse=false;throw Error('SIMULATED_LOST_ACK');}
        return receipt;
      }
    };
    const adapter=createAuthenticatedDeliveryTools({
      store:storeWithLostResponse,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,authorizeDelivery:async()=>true,
      attestPresentation:async request=>({
        ...request,verified:true,presentationId:'stable-native-presentation'
      })
    });
    await adapter.execute('delivery_claim',{deliveryId:item.deliveryId,attemptId:'ack-same'});
    await assert.rejects(()=>adapter.execute('delivery_ack',{
      deliveryId:item.deliveryId,attemptId:'ack-same'
    }),/SIMULATED_LOST_ACK/);
    const committed=f.store.get(item.deliveryId,'route-alice');
    assert.equal(committed.state,'DELIVERED');
    const replayed=await adapter.execute('delivery_ack',{
      deliveryId:item.deliveryId,attemptId:'ack-same'
    });
    assert.equal(replayed.receiptId,committed.receiptId);
    assert.equal(replayed.attempts,1);
    assert.equal(actualStoreAcks,2);
  }finally{f.close();}
});

test('grant revoked by final claim binding recheck cannot claim a delivery',async()=>{
  const f=fixture();
  try{
    const item=f.publish('claim-final-grant');
    let checks=0;
    const protectedAdapter=createAuthenticatedDeliveryTools({
      store:f.store,
      observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>{
        if(++checks===2)f.state.grant=false;
        return f.state.binding;
      },
      authorizeDelivery:async()=>f.state.grant
    });
    await assert.rejects(()=>protectedAdapter.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'claim-final-grant'
    }),/DELIVERY_AUTH_GRANT_REQUIRED/);
    assert.equal(f.store.get(item.deliveryId,'route-alice').state,'COMPLETED_UNDELIVERED');
    assert.equal(f.store.get(item.deliveryId,'route-alice').attempts,0);
  }finally{f.close();}
});
test('grant revoked by final ACK binding recheck cannot commit a receipt',async()=>{
  const f=fixture();
  try{
    const item=f.publish('ack-final-grant');
    await f.adapter.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'ack-final-grant'
    });
    let checks=0;
    const protectedAdapter=createAuthenticatedDeliveryTools({
      store:f.store,
      observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>{
        if(++checks===4)f.state.grant=false;
        return f.state.binding;
      },
      authorizeDelivery:async()=>f.state.grant,
      attestPresentation:async request=>({
        ...request,verified:true,presentationId:'verified-final-grant'
      })
    });
    await assert.rejects(()=>protectedAdapter.execute('delivery_ack',{
      deliveryId:item.deliveryId,attemptId:'ack-final-grant'
    }),/DELIVERY_AUTH_GRANT_REQUIRED/);
    assert.equal(f.store.get(item.deliveryId,'route-alice').receiptId,null);
    assert.equal(f.store.get(item.deliveryId,'route-alice').state,'DELIVERY_PENDING');
  }finally{f.close();}
});

test('artifact bytes remain unread when owner grant is revoked during final binding check',async()=>{
  const f=fixture();
  try{
    const artifact=f.store.writeArtifact({text:'private artifact'});
    const item=f.store.publish({bindingId:EPOCH,
      eventKey:'tool:artifact-final-grant:final',correlationId:'route-alice',
      source:'tool',sourceId:'artifact-final-grant',kind:'COMPLETED',artifact
    });
    let bindingChecks=0,artifactReads=0;
    const guardedStore={
      list:args=>f.store.list(args),
      get:(id,correlation)=>f.store.get(id,correlation),
      claim:args=>f.store.claim(args),
      ack:args=>f.store.ack(args),
      readArtifact:args=>{artifactReads++;return f.store.readArtifact(args);}
    };
    const adapter=createAuthenticatedDeliveryTools({
      store:guardedStore,
      observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>{
        if(++bindingChecks===2)f.state.grant=false;
        return f.state.binding;
      },
      authorizeDelivery:async()=>f.state.grant
    });
    await assert.rejects(()=>adapter.execute('delivery_read_artifact',{
      deliveryId:item.deliveryId,offset:0,maxBytes:1024
    }),/DELIVERY_AUTH_GRANT_REQUIRED/);
    assert.equal(artifactReads,0);
  }finally{f.close();}
});

test('same-chat consent epoch rotation during grant denies old claim',async()=>{
  const f=fixture();
  try {
    const item=f.publish('epoch-regrant-claim');
    let calls=0;
    const adapter=createAuthenticatedDeliveryTools({
      store:f.store,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,
      authorizeDelivery:async()=> {
        if(++calls===1) f.state.binding={...f.state.binding,bindingId:'c'.repeat(32)};
        return true;
      }
    });
    await assert.rejects(()=>adapter.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'stale-epoch'
    }),/DELIVERY_AUTH_BINDING_CHANGED/);
    assert.equal(f.store.get(item.deliveryId,'route-alice').attempts,0);
  } finally {f.close();}
});

test('same-chat owner regrant during native presentation cannot ACK old receipt',async()=>{
  const f=fixture();
  try {
    const item=f.publish('epoch-regrant-ack');
    await f.adapter.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'epoch-ack'
    });
    const adapter=createAuthenticatedDeliveryTools({
      store:f.store,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,authorizeDelivery:async()=>true,
      attestPresentation:async request=>{
        f.state.binding={...f.state.binding,bindingId:'c'.repeat(32)};
        return {...request,verified:true,presentationId:'old-epoch-native'};
      }
    });
    await assert.rejects(()=>adapter.execute('delivery_ack',{
      deliveryId:item.deliveryId,attemptId:'epoch-ack'
    }),/DELIVERY_AUTH_BINDING_CHANGED/);
    assert.equal(f.store.get(item.deliveryId,'route-alice').receiptId,null);
  } finally {f.close();}
});

test('protected retrieval ignores legacy and prior-consent deliveries despite identical chat route',async()=>{
  const f=fixture();
  try {
    const active=f.publish('current-epoch');
    const old=f.store.publish({eventKey:'operation:prior-epoch:complete',
      bindingId:'a'.repeat(32),correlationId:'route-alice',source:'operation',
      sourceId:'prior-epoch',kind:'COMPLETED'});
    const legacy=f.store.publish({eventKey:'operation:legacy-unbound:complete',
      correlationId:'route-alice',source:'operation',
      sourceId:'legacy-unbound',kind:'COMPLETED'});
    const list=await f.adapter.execute('delivery_list',{limit:50});
    assert.deepEqual(list.items.map(item=>item.deliveryId),[active.deliveryId]);
    for(const record of [old,legacy]){
      await assert.rejects(()=>f.adapter.execute('delivery_get',{
        deliveryId:record.deliveryId
      }),/DELIVERY_AUTH_RESULT_EPOCH_MISMATCH/);
      await assert.rejects(()=>f.adapter.execute('delivery_claim',{
        deliveryId:record.deliveryId,attemptId:'wrong-epoch'
      }),/DELIVERY_AUTH_RESULT_EPOCH_MISMATCH/);
      assert.equal(f.store.get(record.deliveryId,'route-alice').attempts,0);
    }
  } finally {f.close();}
});

test('final claim authorization callback cannot revive an old consent epoch',async()=>{
  const f=fixture();
  try {
    const item=f.publish('epoch-final-claim');
    let decisions=0;
    const adapter=createAuthenticatedDeliveryTools({
      store:f.store,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,
      authorizeDelivery:async()=> {
        if(++decisions===2) f.state.binding={...f.state.binding,bindingId:'c'.repeat(32)};
        return true;
      }
    });
    await assert.rejects(()=>adapter.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'final-old-epoch'
    }),/DELIVERY_AUTH_BINDING_CHANGED/);
    assert.equal(f.store.get(item.deliveryId,'route-alice').attempts,0);
  } finally {f.close();}
});

test('final ACK authorization callback cannot commit an earlier consent epoch',async()=>{
  const f=fixture();
  try {
    const item=f.publish('epoch-final-ack');
    await f.adapter.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'final-old-ack'
    });
    let decisions=0;
    const adapter=createAuthenticatedDeliveryTools({
      store:f.store,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,
      authorizeDelivery:async()=> {
        if(++decisions===4) f.state.binding={...f.state.binding,bindingId:'c'.repeat(32)};
        return true;
      },
      attestPresentation:async req=>({...req,verified:true,presentationId:'native-final-epoch'})
    });
    await assert.rejects(()=>adapter.execute('delivery_ack',{
      deliveryId:item.deliveryId,attemptId:'final-old-ack'
    }),/DELIVERY_AUTH_BINDING_CHANGED/);
    assert.equal(f.store.get(item.deliveryId,'route-alice').receiptId,null);
  } finally {f.close();}
});
