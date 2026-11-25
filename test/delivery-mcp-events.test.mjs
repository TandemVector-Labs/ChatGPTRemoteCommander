import test from 'node:test';
const EPOCH='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DeliveryStore} from '../src/delivery-store.mjs';
import {createAuthenticatedDeliveryTools} from '../src/delivery-authenticated.mjs';
import {createDeliveryMcpEventProjection,DELIVERY_MCP_EVENT} from '../src/delivery-mcp-events.mjs';
const A={hostId:'host',principalId:'alice',profileId:'p',conversationId:'chat-a'};
const B={hostId:'host',principalId:'bob',profileId:'p',conversationId:'chat-b'};
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v106-events-'));
  const store=new DeliveryStore({directory:path.join(root,'state'),scope:'p'});
  const state={caller:A,binding:{...A,correlationId:'route-a',bindingId:EPOCH},grant:true};
  const tools=createAuthenticatedDeliveryTools({store,
    observeCaller:async()=>state.caller,resolveBinding:async()=>state.binding,
    authorizeDelivery:async()=>state.grant,
    attestPresentation:async r=>({...r,verified:true,presentationId:'actual-native-receipt'})
  });
  const projector=createDeliveryMcpEventProjection({authenticatedDelivery:tools});
  return {root,store,tools,projector,state,close(){store.close();fs.rmSync(root,{recursive:true,force:true});}};
}
test('catalog advertises one webhook-only event with no caller-chosen filter',()=>{
  assert.throws(()=>createDeliveryMcpEventProjection(),/DELIVERY_EVENTS_TRUSTED_ADAPTER_REQUIRED/);
  const f=fixture();
  try{
    const c=f.projector.list();
    assert.equal(c.events.length,1);
    assert.equal(c.events[0].name,DELIVERY_MCP_EVENT);
    assert.deepEqual(c.events[0].delivery,['webhook']);
    assert.deepEqual(c.events[0].inputSchema,{type:'object',properties:{},additionalProperties:false});
    assert.deepEqual(c.events[0].payloadSchema.required,['deliveryId','kind','status']);
    assert.equal(Object.isFrozen(c.events[0].payloadSchema),true);
    assert.equal(Object.isFrozen(c.events[0].payloadSchema.required),true);
    assert.throws(()=>c.events[0].payloadSchema.required.push('secret'));
    assert.deepEqual(f.projector.list().events[0].payloadSchema.required,['deliveryId','kind','status']);
  }finally{f.close();}
});
test('only authenticated scoped retrieval builds stable bounded event metadata',async()=>{
  const f=fixture();
  try{
    const secret={text:'SECRET_VALUE_MUST_NOT_LEAK',authorization:'top-secret'};
    const artifact=f.store.writeArtifact(secret);
    const item=f.store.publish({bindingId:EPOCH,eventKey:'tool:e1:complete',correlationId:'route-a',source:'tool',
      sourceId:'e1',kind:'COMPLETED',artifact});
    const first=await f.projector.project({deliveryId:item.deliveryId});
    const second=await f.projector.project({deliveryId:item.deliveryId});
    assert.deepEqual(first,second);
    assert.equal(first.name,DELIVERY_MCP_EVENT);
    assert.equal(first.eventId.length,68);
    assert.equal(first.timestamp,item.createdAt);
    assert.deepEqual(first.data,{deliveryId:item.deliveryId,kind:'COMPLETED',status:'pending'});
    assert.equal(first.cursor,null);
    assert.ok(JSON.stringify(first).length<500);
    assert.doesNotMatch(JSON.stringify(first),/SECRET_VALUE|authorization|route-a|principal|sha256|chat-a/);
    assert.equal(f.store.get(item.deliveryId,'route-a').state,'COMPLETED_UNDELIVERED');
    assert.equal(f.store.get(item.deliveryId,'route-a').receiptId,null);
  }finally{f.close();}
});
test('two identities cannot project one another’s pending results',async()=>{
  const f=fixture();
  try{
    const a=f.store.publish({bindingId:EPOCH,eventKey:'tool:alice:event',correlationId:'route-a',source:'tool',
      sourceId:'alice',kind:'COMPLETED'});
    const b=f.store.publish({bindingId:EPOCH,eventKey:'tool:bob:event',correlationId:'route-b',source:'tool',
      sourceId:'bob',kind:'FAILED'});
    assert.equal((await f.projector.project({deliveryId:a.deliveryId})).data.kind,'COMPLETED');
    f.state.caller=B;f.state.binding={...B,correlationId:'route-b',bindingId:EPOCH};
    await assert.rejects(()=>f.projector.project({deliveryId:a.deliveryId}),/DELIVERY_CORRELATION_MISMATCH/);
    assert.equal((await f.projector.project({deliveryId:b.deliveryId})).data.kind,'FAILED');
    assert.equal(f.store.get(a.deliveryId,'route-a').state,'COMPLETED_UNDELIVERED');
    assert.equal(f.store.get(b.deliveryId,'route-b').state,'COMPLETED_UNDELIVERED');
  }finally{f.close();}
});
test('projection refuses unapproved caller, invalid ID, claimed or delivered state',async()=>{
  const f=fixture();
  try{
    const item=f.store.publish({bindingId:EPOCH,eventKey:'tool:test:ready',correlationId:'route-a',
      source:'tool',sourceId:'test',kind:'COMPLETED'});
    await assert.rejects(()=>f.projector.project({deliveryId:'invalid'}),/DELIVERY_EVENTS_ID_INVALID/);
    f.state.grant=false;
    await assert.rejects(()=>f.projector.project({deliveryId:item.deliveryId}),/DELIVERY_AUTH_GRANT_REQUIRED/);
    f.state.grant=true;
    f.store.claim({deliveryId:item.deliveryId,correlationId:'route-a',attemptId:'the-attempt'});
    await assert.rejects(()=>f.projector.project({deliveryId:item.deliveryId}),/DELIVERY_EVENTS_NOT_PENDING/);
    f.store.ack({deliveryId:item.deliveryId,correlationId:'route-a',attemptId:'the-attempt'});
    await assert.rejects(()=>f.projector.project({deliveryId:item.deliveryId}),/DELIVERY_EVENTS_NOT_PENDING/);
  }finally{f.close();}
});
test('projection is pure metadata and does not consume claims, invoke ACK or make webhook requests',async()=>{
  const f=fixture();
  try{
    const a=f.store.publish({bindingId:EPOCH,eventKey:'tool:queued:event',correlationId:'route-a',source:'tool',
      sourceId:'queued',kind:'UNCERTAIN'});
    const before=f.store.get(a.deliveryId,'route-a');
    for(let i=0;i<3;i++)assert.equal((await f.projector.project({deliveryId:a.deliveryId})).data.kind,'UNCERTAIN');
    const after=f.store.get(a.deliveryId,'route-a');
    assert.deepEqual(after,before);
    assert.equal(f.store.health().counts.DELIVERED??0,0);
  }finally{f.close();}
});
