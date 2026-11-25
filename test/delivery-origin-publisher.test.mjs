import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {DeliveryStore,stableJson} from '../src/delivery-store.mjs';
import {createTrustedDeliveryOriginPublisher} from '../src/delivery-origin-publisher.mjs';
import {createAuthenticatedDeliveryTools} from '../src/delivery-authenticated.mjs';

const caller=Object.freeze({
  hostId:'host-1',principalId:'owner-a',profileId:'profile-a',conversationId:'chat-a'
});
const bindingId='b'.repeat(32),inputHash='a'.repeat(64),nativeKey=Buffer.alloc(32,73);
const originAdmissionId='admit:job1';
const workerIdentity=Object.freeze({workerId:'cw_'+'c'.repeat(64),workerKeyId:'d'.repeat(64),workerGrantRevision:7});
const workflowScope=Object.freeze({
  workflowId:'sample',stepId:'first',
  operationId:'123e4567-e89b-42d3-a456-426614174000',
  rootFingerprint:'b'.repeat(64),revision:1,
  leaseId:'c'.repeat(64),fencingToken:2
});
const event=Object.freeze({
  eventKey:'operation:job1:complete',source:'operation',sourceId:'job1',
  kind:'COMPLETED',code:'SUCCEEDED',artifact:null,receiptId:'native-receipt1'
});
const originalBody=Object.freeze({
  receiptId:event.receiptId,sourceId:event.sourceId,
  ...caller,correlationId:'route-a',bindingId,inputHash,originAdmissionId,...workerIdentity
});
const expected=Object.freeze({inputHash,correlationId:'route-a',originAdmissionId});
const sign=body=>createHmac('sha256',nativeKey).update(stableJson(body)).digest('hex');
const digest=x=>createHash('sha256').update(stableJson(x)).digest('hex');
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v106-origin-'));
  const store=new DeliveryStore({directory:path.join(root,'delivery'),scope:'owner-a'});
  const signedRecord={...originalBody,
    eventDigest:digest({
      eventKey:event.eventKey,source:event.source,sourceId:event.sourceId,
      kind:event.kind,code:event.code,artifact:event.artifact
    })};
  const signatures=new Map([[event.receiptId,sign(signedRecord)]]);
  const originalRecords=new Map([[event.receiptId,signedRecord]]);
  let checked=0;
  const verifyExecutionReceipt=async request=>{
    checked++;
    const source=originalRecords.get(request.receiptId);
    if(!source||request.eventDigest!==source.eventDigest
      ||request.sourceId!==source.sourceId)return null;
    const expected=sign(source),actual=signatures.get(request.receiptId);
    if(typeof actual!=='string'||expected.length!==actual.length
      ||!timingSafeEqual(Buffer.from(expected),Buffer.from(actual)))return null;
    return Object.freeze({
      verified:true,source:'HOST_SIGNED_ORIGINAL_EXECUTION',
      ...source
    });
  };
  const publisher=createTrustedDeliveryOriginPublisher({store,verifyExecutionReceipt});
  const state={identity:caller,correlationId:'route-a',bindingId,grant:true};
  const protectedDelivery=createAuthenticatedDeliveryTools({
    store,
    observeCaller:async()=>state.identity,
    resolveBinding:async c=>({...c,correlationId:state.correlationId,bindingId:state.bindingId}),
    authorizeDelivery:async()=>state.grant,
    attestPresentation:async q=>({...q,verified:true,presentationId:'native-display-1'})
  });
  return {
    publisher,store,state,signatures,originalRecords,verifyExecutionReceipt,root,
    get checks(){return checked;},
    protectedDelivery,close(){store.close();fs.rmSync(root,{recursive:true,force:true});}
  };
}
test('publisher refuses missing independent native receipt verifier',()=>{
  assert.throws(()=>createTrustedDeliveryOriginPublisher(),
    /DELIVERY_ORIGIN_TRUSTED_HOST_REQUIRED/);
  assert.throws(()=>createTrustedDeliveryOriginPublisher({store:{publish(){}}}),
    /DELIVERY_ORIGIN_TRUSTED_HOST_REQUIRED/);
});
test('verified original receipt binds durable source result to originating consent epoch',async()=>{
  const f=fixture();
  try{
    const result=await f.publisher.publish(event,expected);
    assert.equal(result.bindingEpochHash,createHash('sha256').update(bindingId).digest('hex'));
    assert.equal(result.originReceiptHash,digest(Object.fromEntries([
      'receiptId','eventDigest','hostId','principalId','profileId',
      'conversationId','correlationId','bindingId','inputHash','sourceId','originAdmissionId',
      'workerId','workerKeyId','workerGrantRevision'
    ].map(k=>[k,f.originalRecords.get(event.receiptId)[k]]))));
    assert.equal(result.correlationId,'route-a');
    assert.deepEqual(result.workerIdentity,workerIdentity);
    assert.equal(JSON.stringify(result).includes(bindingId),false);
    assert.equal(f.checks,1);
    const list=await f.protectedDelivery.execute('delivery_list',{limit:3});
    assert.deepEqual(list.items.map(r=>r.deliveryId),[result.deliveryId]);
    const claim=await f.protectedDelivery.execute('delivery_claim',{
      deliveryId:result.deliveryId,attemptId:'native-attempt'
    });
    assert.equal(claim.state,'DELIVERY_PENDING');
    const ack=await f.protectedDelivery.execute('delivery_ack',{
      deliveryId:result.deliveryId,attemptId:'native-attempt'
    });
    assert.equal(ack.state,'DELIVERED');
    assert.equal((await f.publisher.publish(event,expected)).deliveryId,result.deliveryId);
    assert.equal((await f.protectedDelivery.execute('delivery_ack',{
      deliveryId:result.deliveryId,attemptId:'native-attempt'
    })).receiptId,ack.receiptId);
  }finally{f.close();}
});
test('forged, absent or altered signed native execution receipt never publishes',async()=>{
  const f=fixture();
  try{
    f.signatures.set(event.receiptId,'0'.repeat(64));
    await assert.rejects(()=>f.publisher.publish(event,expected),/DELIVERY_ORIGIN_RECEIPT_INVALID/);
    assert.equal(f.store.health().pending,0);
    f.signatures.set(event.receiptId,sign(f.originalRecords.get(event.receiptId)));
    await assert.rejects(()=>f.publisher.publish({...event,kind:'FAILED'},expected),/DELIVERY_ORIGIN_RECEIPT_INVALID/);
    await assert.rejects(()=>f.publisher.publish({...event,sourceId:'wrong-id'},expected),
      /DELIVERY_ORIGIN_RECEIPT_INVALID/);
    assert.equal(f.store.health().pending,0);
  }finally{f.close();}
});
test('original execution receipt must bind a well-formed worker identity and grant revision',async()=>{
  const f=fixture();
  try{
    const original=f.originalRecords.get(event.receiptId);
    const invalid={...original,workerId:'cw_invalid'};
    f.originalRecords.set(event.receiptId,invalid);
    f.signatures.set(event.receiptId,sign(invalid));
    await assert.rejects(()=>f.publisher.publish(event,expected),
      /DELIVERY_ORIGIN_RECEIPT_MISMATCH/);
    assert.equal(f.store.health().pending,0);
  }finally{f.close();}
});

test('untrusted client-supplied identity or consent fields are denied before verifier',async()=>{
  const f=fixture();
  try{
    for(const extra of [
      {bindingId},{correlationId:'route-a'},{caller},
      {verified:true},{resultHash:'a'.repeat(64)},{originReceiptHash:'b'.repeat(64)}
    ]){
      await assert.rejects(()=>f.publisher.publish({...event,...extra},expected),
        /DELIVERY_ORIGIN_EVENT_INVALID/);
    }
    assert.equal(f.checks,0);
    assert.equal(f.store.health().pending,0);
  }finally{f.close();}
});
test('same chat after native consent regrant cannot retrieve or ACK previous result',async()=>{
  const f=fixture();
  try{
    const old=await f.publisher.publish(event,expected);
    f.state.bindingId='c'.repeat(32);
    assert.deepEqual((await f.protectedDelivery.execute('delivery_list',{})).items,[]);
    await assert.rejects(()=>f.protectedDelivery.execute('delivery_get',{
      deliveryId:old.deliveryId
    }),/DELIVERY_AUTH_RESULT_EPOCH_MISMATCH/);
    await assert.rejects(()=>f.protectedDelivery.execute('delivery_claim',{
      deliveryId:old.deliveryId,attemptId:'new-epoch'
    }),/DELIVERY_AUTH_RESULT_EPOCH_MISMATCH/);
    assert.equal(f.store.get(old.deliveryId,'route-a').attempts,0);
  }finally{f.close();}
});
test('async verifier cannot change exact event bytes during native receipt resolution',async()=>{
  const f=fixture();
  try{
    const mutable={...event};
    const publisher=createTrustedDeliveryOriginPublisher({
      store:f.store,
      verifyExecutionReceipt:async request=>{
        mutable.kind='FAILED';mutable.code='DENIED';
        return f.verifyExecutionReceipt(request);
      }
    });
    const row=await publisher.publish(mutable,expected);
    assert.equal(row.kind,'COMPLETED');
    assert.equal(row.code,'SUCCEEDED');
    assert.equal(f.store.health().pending,1);
  }finally{f.close();}
});

test('authenticated result survives restart without becoming a new-chat result',async()=>{
  const f=fixture();
  let reopened;
  try{
    const item=await f.publisher.publish(event,expected);
    f.store.close();
    reopened=new DeliveryStore({directory:path.join(f.root,'delivery'),scope:'owner-a'});
    const persisted=reopened.get(item.deliveryId,'route-a');
    assert.equal(persisted.originReceiptHash,item.originReceiptHash);
    assert.equal(persisted.bindingEpochHash,item.bindingEpochHash);
    assert.equal(persisted.state,'COMPLETED_UNDELIVERED');
    const guard=createAuthenticatedDeliveryTools({
      store:reopened,observeCaller:async()=>f.state.identity,
      resolveBinding:async c=>({...c,correlationId:f.state.correlationId,bindingId:f.state.bindingId}),
      authorizeDelivery:async()=>true
    });
    const list=await guard.execute('delivery_list',{limit:2});
    assert.deepEqual(list.items.map(x=>x.deliveryId),[item.deliveryId]);
    f.state.identity={...caller,conversationId:'chat-b'};
    f.state.correlationId='route-b';
    assert.deepEqual((await guard.execute('delivery_list',{})).items,[]);
    await assert.rejects(()=>guard.execute('delivery_get',{deliveryId:item.deliveryId}),
      /DELIVERY_CORRELATION_MISMATCH/);
    assert.equal(reopened.get(item.deliveryId,'route-a').receiptId,null);
  }finally{reopened?.close();f.close();}
});

test('signed receipt for different input hash or originating chat cannot publish',async()=>{
  const f=fixture();
  try{
    const original=f.originalRecords.get(event.receiptId);
    for(const mismatch of [
      {...original,inputHash:'c'.repeat(64)},
      {...original,correlationId:'route-b'},
      {...original,originAdmissionId:'admit:other-job'}
    ]){
      f.originalRecords.set(event.receiptId,mismatch);
      f.signatures.set(event.receiptId,sign(mismatch));
      await assert.rejects(()=>f.publisher.publish(event,expected),
        /DELIVERY_ORIGIN_OPERATION_MISMATCH/);
      assert.equal(f.store.health().pending,0);
    }
  }finally{f.close();}
});

test('host must provide exact origin expectation; caller fields are not accepted',async()=>{
  const f=fixture();
  try{
    for(const context of [
      undefined,null,{inputHash},{correlationId:'route-a'},
      {...expected,chatId:'forged'}, {...expected,inputHash:'wrong'},
      {...expected,originAdmissionId:'bad admission'}
    ]){
      await assert.rejects(()=>f.publisher.publish(event,context),
        /DELIVERY_ORIGIN_EXPECTED_CONTEXT_REQUIRED/);
      assert.equal(f.store.health().pending,0);
    }
  }finally{f.close();}
});

test('signed Host origin binds exact WorkflowStore lease scope to durable result and ACK hash',async()=>{
  const f=fixture();let reopened=null;
  try{
    const record={...f.originalRecords.get(event.receiptId),workflowScope};
    f.originalRecords.set(event.receiptId,record);
    f.signatures.set(event.receiptId,sign(record));
    const expectedScope={...expected,workflowScope};
    const row=await f.publisher.publish(event,expectedScope);
    assert.deepEqual(row.workflowScope,workflowScope);
    assert.equal(row.originReceiptHash,digest(Object.fromEntries([
      'receiptId','eventDigest','hostId','principalId','profileId',
      'conversationId','correlationId','bindingId','inputHash','sourceId',
      'originAdmissionId','workerId','workerKeyId','workerGrantRevision',
      'workflowScope'
    ].map(k=>[k,record[k]]))));
    assert.equal((await f.publisher.publish(event,expectedScope)).deliveryId,row.deliveryId);
    assert.equal(f.store.get(row.deliveryId,'route-a').resultHash,row.resultHash);
    await f.protectedDelivery.execute('delivery_claim',{
      deliveryId:row.deliveryId,attemptId:'scoped-attempt'
    });
    const ack=await f.protectedDelivery.execute('delivery_ack',{
      deliveryId:row.deliveryId,attemptId:'scoped-attempt'
    });
    assert.equal(ack.state,'DELIVERED');
    reopened=new DeliveryStore({directory:path.join(f.root,'delivery'),scope:'owner-a'});
    const durable=reopened.get(row.deliveryId,'route-a');
    assert.deepEqual(durable.workflowScope,workflowScope);
    assert.equal(durable.originReceiptHash,row.originReceiptHash);
    assert.equal(durable.resultHash,row.resultHash);
    assert.equal(durable.receiptId,ack.receiptId);
  }finally{reopened?.close();f.close();}
});

test('signed workflow receipt fails closed on absent, mismatched or malformed Host lease context',async()=>{
  const f=fixture();
  try{
    const original=f.originalRecords.get(event.receiptId);
    const scoped={...original,workflowScope};
    f.originalRecords.set(event.receiptId,scoped);
    f.signatures.set(event.receiptId,sign(scoped));
    await assert.rejects(()=>f.publisher.publish(event,expected),
      /DELIVERY_ORIGIN_OPERATION_MISMATCH/);
    await assert.rejects(()=>f.publisher.publish(event,{...expected,
      workflowScope:{...workflowScope,fencingToken:3}}),
      /DELIVERY_ORIGIN_OPERATION_MISMATCH/);
    const getter={...workflowScope};
    Object.defineProperty(getter,'leaseId',{enumerable:true,get(){throw Error('UNTRUSTED_GETTER');}});
    await assert.rejects(()=>f.publisher.publish(event,{...expected,workflowScope:getter}),
      /DELIVERY_WORKFLOW_SCOPE_INVALID/);
    for(const bad of [
      {...workflowScope,rootFingerprint:'bad'},
      {...workflowScope,revision:-1},
      {...workflowScope,operationId:'not-an-operation-id'},
      {...workflowScope,extra:'injected'}
    ]){
      const forged={...original,workflowScope:bad};
      f.originalRecords.set(event.receiptId,forged);
      f.signatures.set(event.receiptId,sign(forged));
      await assert.rejects(()=>f.publisher.publish(event,{...expected,workflowScope}),
        /DELIVERY_WORKFLOW_SCOPE_INVALID/);
    }
    f.originalRecords.set(event.receiptId,original);
    f.signatures.set(event.receiptId,sign(original));
    await assert.rejects(()=>f.publisher.publish(event,{...expected,workflowScope}),
      /DELIVERY_ORIGIN_OPERATION_MISMATCH/);
    assert.equal(f.store.health().pending,0);
  }finally{f.close();}
});
