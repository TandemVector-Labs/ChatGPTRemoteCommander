import test from 'node:test';
const EPOCH='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DeliveryStore} from '../src/delivery-store.mjs';
import {DeliveryEventSubscriptionStore} from '../src/delivery-mcp-subscription-store.mjs';
import {createProtectedDeliveryMcpEventsRuntime} from '../src/delivery-mcp-host-runtime.mjs';
import {DELIVERY_MCP_EVENT} from '../src/delivery-mcp-events.mjs';
const A={hostId:'host',principalId:'alice',profileId:'profile',conversationId:'chat-a'};
const B={hostId:'host',principalId:'bob',profileId:'profile',conversationId:'chat-b'};
const secret='whsec_'+Buffer.alloc(32,5).toString('base64');
const endpoint='https://callbacks.example.net/mcp-events';
const subscribeInput={name:DELIVERY_MCP_EVENT,arguments:{},
  delivery:{mode:'webhook',url:endpoint,secret},cursor:null};
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v106-runtime-'));
  const deliveryStore=new DeliveryStore({directory:path.join(root,'delivery'),scope:'profile'});
  const subscriptionStore=new DeliveryEventSubscriptionStore({
    directory:path.join(root,'subscriptions'),profileScope:'c'.repeat(64)
  });
  const a=deliveryStore.publish({bindingId:EPOCH,eventKey:'operation:alice:complete',
    source:'operation',sourceId:'alice',correlationId:'route-a',kind:'COMPLETED'});
  const b=deliveryStore.publish({bindingId:EPOCH,eventKey:'operation:bob:failed',
    source:'operation',sourceId:'bob',correlationId:'route-b',kind:'FAILED'});
  const state={caller:A,route:'route-a',grant:true,listChangesCaller:false,
    listGrantChecks:0,listRevokesDuringBindingRecheck:false,listSwitchesAtSecondCheck:false,
    requests:[]};
  const sealed=new Map();
  const runtime=createProtectedDeliveryMcpEventsRuntime({
    deliveryStore,subscriptionStore,
    observeCaller:async()=>state.caller,
    resolveBinding:async caller=>{
      // Simulate revocation during the awaitable native Host binding refresh.
      if(state.listRevokesDuringBindingRecheck&&state.listGrantChecks===1)
        state.grant=false;
      return {...caller,correlationId:state.route,bindingId:EPOCH};
    },
    authorizeDelivery:async()=>state.grant,
    attestPresentation:async request=>({...request,presentationId:'native',verified:true}),
    authorizeSubscription:async operation=>{
      if(operation.action==='list'){
        state.listGrantChecks++;
        if(state.listChangesCaller
          ||(state.listSwitchesAtSecondCheck&&state.listGrantChecks===2)){
          state.caller=B;state.route='route-b';
        }
      }
      return state.grant;
    },
    authorizeSend:async()=>state.grant,
    sealSecret:async value=>{
      const key='sealed:'+createHash('sha256').update(value).digest('hex');
      sealed.set(key,value);
      return key;
    },
    unsealSecret:async value=>sealed.get(value),
    verifiedHttpsTransport:{
      postVerifiedHttps:async request=>{
        state.requests.push(request);
        const body=JSON.parse(request.body);
        if(body.type==='verification')
          return {status:200,body:JSON.stringify({challenge:body.challenge})};
        return {status:202,body:''};
      }
    },
    now:()=>Date.UTC(2026,10,6,2,0,1)
  });
  return {state,runtime,deliveryStore,subscriptionStore,a,b,root,close(){
    deliveryStore.close();subscriptionStore.close();fs.rmSync(root,{recursive:true,force:true});
  }};
}
test('runtime refuses to initialize without authenticated host-only callbacks',()=>{
  assert.throws(()=>createProtectedDeliveryMcpEventsRuntime(),
    /DELIVERY_EVENTS_INTEGRATION_UNAVAILABLE/);
});
test('end-to-end source composition advertises, verifies subscription, signs and dispatches without ACK',async()=>{
  const f=fixture();
  try{
    const list=await f.runtime.methods['events/list']({});
    assert.equal(list.events.length,1);
    assert.equal(list.events[0].name,DELIVERY_MCP_EVENT);
    const receipt=await f.runtime.methods['events/subscribe'](subscribeInput);
    assert.equal(receipt.id.startsWith('sub_'),true);
    assert.equal(f.subscriptionStore.status().total,1);
    assert.equal(f.state.requests.length,1);
    assert.equal(f.state.requests[0].headers['X-MCP-Subscription-Id'],receipt.id);
    const result=await f.runtime.dispatchHostEvent({
      deliveryId:f.a.deliveryId,subscriptionId:receipt.id
    });
    assert.equal(result.webhookAccepted,true);
    assert.equal(result.resultDeliveryAcknowledged,false);
    assert.equal(f.state.requests.length,2);
    assert.equal(JSON.parse(f.state.requests[1].body).data.deliveryId,f.a.deliveryId);
    assert.equal(f.deliveryStore.get(f.a.deliveryId,'route-a').state,'COMPLETED_UNDELIVERED');
    assert.equal(f.deliveryStore.get(f.a.deliveryId,'route-a').receiptId,null);
    const db=fs.readFileSync(path.join(f.root,'subscriptions','event-subscriptions.sqlite'));
    assert.equal(db.includes(Buffer.from(secret)),false);
    assert.equal(Object.keys(f.runtime.methods).includes('dispatchHostEvent'),false);
    await f.runtime.methods['events/unsubscribe']({
      name:DELIVERY_MCP_EVENT,arguments:{},delivery:{mode:'webhook',url:endpoint}
    });
    assert.equal(f.subscriptionStore.status().total,0);
  }finally{f.close();}
});
test('two authenticated chats share a host but cannot see or dispatch each other’s results',async()=>{
  const f=fixture();
  try{
    const a=await f.runtime.methods['events/subscribe'](subscribeInput);
    f.state.caller=B;f.state.route='route-b';
    const b=await f.runtime.methods['events/subscribe'](subscribeInput);
    assert.notEqual(a.id,b.id);
    await assert.rejects(()=>f.runtime.dispatchHostEvent({
      deliveryId:f.a.deliveryId,subscriptionId:b.id
    }),/DELIVERY_CORRELATION_MISMATCH/);
    const sent=await f.runtime.dispatchHostEvent({
      deliveryId:f.b.deliveryId,subscriptionId:b.id
    });
    assert.equal(sent.webhookAccepted,true);
    assert.equal(f.deliveryStore.get(f.a.deliveryId,'route-a').receiptId,null);
    assert.equal(f.deliveryStore.get(f.b.deliveryId,'route-b').receiptId,null);
  }finally{f.close();}
});
test('catalog access is denied when owner grant is missing or caller switches',async()=>{
  const f=fixture();
  try{
    f.state.grant=false;
    await assert.rejects(()=>f.runtime.methods['events/list']({}),
      /DELIVERY_EVENTS_DISCOVERY_DENIED/);
    f.state.grant=true;f.state.listChangesCaller=true;
    await assert.rejects(()=>f.runtime.methods['events/list']({}),
      /DELIVERY_EVENTS_DISCOVERY_SESSION_CHANGED/);
  }finally{f.close();}
});


test('event discovery revocation during independent binding recheck fails closed',async()=>{
  const f=fixture();
  try{
    f.state.listRevokesDuringBindingRecheck=true;
    await assert.rejects(
      ()=>f.runtime.methods['events/list']({}),
      /DELIVERY_EVENTS_DISCOVERY_DENIED/);
    assert.equal(f.state.listGrantChecks,2,
      'authorization must be repeated after the asynchronous binding recheck');
  }finally{f.close();}
});

test('event discovery rejects a chat switch during the final grant await',async()=>{
  const f=fixture();
  try{
    f.state.listSwitchesAtSecondCheck=true;
    await assert.rejects(
      ()=>f.runtime.methods['events/list']({}),
      /DELIVERY_EVENTS_DISCOVERY_SESSION_CHANGED/);
  }finally{f.close();}
});

test('host runtime rejects stores missing durable cross-process cancellation fencing',()=>{
  const fake={
    getActive(){return null;},upsert(){},remove(){}
  };
  assert.throws(()=>createProtectedDeliveryMcpEventsRuntime({
    deliveryStore:{},subscriptionStore:fake,
    observeCaller:async()=>A,resolveBinding:async()=>({...A,correlationId:'route-a',bindingId:EPOCH}),
    authorizeDelivery:async()=>true,authorizeSubscription:async()=>true,
    authorizeSend:async()=>true,attestPresentation:async()=>true,
    sealSecret:async()=> 'sealed',unsealSecret:async()=> 'whsec_xxx'
  }),/DELIVERY_EVENTS_INTEGRATION_UNAVAILABLE/);
});


test('event discovery rejects injected or accessor-backed list params before host observation',async()=>{
  const f=fixture();
  try{
    const accessor={};
    Object.defineProperty(accessor,'cursor',{enumerable:true,get(){throw new Error('ACCESSOR_MUST_NOT_RUN');}});
    const withSymbol={[Symbol('unexpected')]:true};
    for(const input of [null,[],42,{cursor:'unknown-page'},
      {principalId:'other-user'},{cursor:null,conversationId:'other-chat'},
      Object.create({cursor:null}),accessor,withSymbol]){
      await assert.rejects(()=>f.runtime.methods['events/list'](input),
        /DELIVERY_EVENTS_LIST_ARGUMENTS_INVALID/);
    }
    assert.equal(f.state.listGrantChecks,0);
    const result=await f.runtime.methods['events/list']({cursor:null});
    assert.equal(result.events[0].name,DELIVERY_MCP_EVENT);
    assert.equal(f.state.listGrantChecks,2);
  }finally{f.close();}
});


import {
  toProtectedDeliveryMcpErrorResult,
  callProtectedDeliveryMcpTool
} from '../src/delivery-mcp-host-runtime.mjs';

test('MCP error contract exposes a safe owner-consent reason without exception details',()=>{
  const error=Object.assign(new Error('secret callback URL and bearer must never escape'),{
    code:'DELIVERY_AUTH_GRANT_REQUIRED'
  });
  const result=toProtectedDeliveryMcpErrorResult(error);
  assert.equal(result.isError,true);
  assert.deepEqual(result.structuredContent,{ok:false,code:'OWNER_CONSENT_REQUIRED'});
  assert.match(result.content[0].text,/current owner grant is required/i);
  assert.equal(JSON.stringify(result).includes('secret'),false);
  assert.equal(JSON.stringify(result).includes('bearer'),false);
});

test('MCP error contract accepts trusted deliveryCode and maps presentation requirements',()=>{
  const error=Object.assign(new Error('private host detail'),{
    deliveryCode:'DELIVERY_AUTH_PRESENTATION_REQUIRED'
  });
  const result=toProtectedDeliveryMcpErrorResult(error);
  assert.deepEqual(result.structuredContent,{ok:false,code:'PRESENTATION_PROOF_REQUIRED'});
  assert.match(result.content[0].text,/independently verified host presentation receipt/i);
  assert.equal(JSON.stringify(result).includes('private host detail'),false);
});

test('MCP error contract hides unknown codes and ignores accessor-backed code fields',()=>{
  let touched=false;
  const error=new Error('private internal detail');
  Object.defineProperty(error,'code',{
    enumerable:true,
    get(){touched=true;throw new Error('ACCESSOR_MUST_NOT_RUN');}
  });
  const result=toProtectedDeliveryMcpErrorResult(error);
  assert.equal(touched,false);
  assert.deepEqual(result.structuredContent,{ok:false,code:'DELIVERY_INTEGRATION_FAILED'});
  assert.equal(JSON.stringify(result).includes('private internal detail'),false);
  assert.equal(JSON.stringify(result).includes('ACCESSOR_MUST_NOT_RUN'),false);
});

test('MCP wrapper preserves successful results and converts callback failures to safe tool errors',async()=>{
  const success=await callProtectedDeliveryMcpTool(async value=>({value}),7);
  assert.deepEqual(success,{value:7});
  const failure=await callProtectedDeliveryMcpTool(async()=>{
    throw Object.assign(new Error('do not expose this host response'),{
      code:'DELIVERY_EVENTS_DISCOVERY_DENIED'
    });
  });
  assert.equal(failure.isError,true);
  assert.deepEqual(failure.structuredContent,{ok:false,code:'OWNER_CONSENT_REQUIRED'});
  assert.equal(JSON.stringify(failure).includes('do not expose'),false);
});


test('worker-current revocation failures map to a bounded MCP error',()=>{
  const result=toProtectedDeliveryMcpErrorResult(Object.assign(
    new Error('private worker registry details'),
    {code:'DELIVERY_PRESENTATION_WORKER_NOT_CURRENT'}
  ));
  assert.equal(result.isError,true);
  assert.deepEqual(result.structuredContent,{
    ok:false,code:'WORKER_IDENTITY_NOT_CURRENT'
  });
  assert.equal(JSON.stringify(result).includes('private worker registry details'),false);
});
test('MCP error contract preserves consent-epoch and authenticated-caller failure classes',()=>{
  const epoch=toProtectedDeliveryMcpErrorResult(Object.assign(new Error('private'),{
    code:'DELIVERY_AUTH_RESULT_EPOCH_MISMATCH'
  }));
  assert.deepEqual(epoch.structuredContent,{ok:false,code:'CONSENT_EPOCH_MISMATCH'});
  const caller=toProtectedDeliveryMcpErrorResult(Object.assign(new Error('private'),{
    code:'DELIVERY_EVENTS_CALLER_UNVERIFIED'
  }));
  assert.deepEqual(caller.structuredContent,{ok:false,code:'AUTHENTICATED_HOST_REQUIRED'});
  for(const result of [epoch,caller]){
    assert.equal(result.isError,true);
    assert.equal(JSON.stringify(result).includes('private'),false);
  }
});


test('public MCP callbacks expose exactly five protected delivery tools with no internal sender', async()=>{
  const {createProtectedDeliveryMcpToolCallbacks}=await import('../src/delivery-mcp-host-runtime.mjs');
  const f=fixture();
  try{
    const callbacks=createProtectedDeliveryMcpToolCallbacks(f.runtime);
    assert.equal(Object.isFrozen(callbacks),true);
    assert.deepEqual(Object.keys(callbacks),[
      'delivery_list','delivery_get','delivery_claim','delivery_ack','delivery_read_artifact'
    ]);
    assert.equal(Object.hasOwn(callbacks,'dispatchHostEvent'),false);
    assert.equal(Object.hasOwn(callbacks,'events/subscribe'),false);
    const listed=await callbacks.delivery_list({limit:10});
    assert.equal(listed.items.length,1);
    assert.equal(listed.items[0].deliveryId,f.a.deliveryId);
    // Model-supplied identities cannot create or acknowledge a receipt.
    const spoof=await callbacks.delivery_ack({
      deliveryId:f.a.deliveryId,attemptId:'attempt-spoofed',principalId:'attacker'
    });
    assert.equal(spoof.isError,true);
    assert.equal(spoof.structuredContent.code,'AUTHENTICATED_HOST_REQUIRED');
    assert.equal(f.deliveryStore.get(f.a.deliveryId,'route-a').state,'COMPLETED_UNDELIVERED');
    f.state.grant=false;
    const denied=await callbacks.delivery_claim({
      deliveryId:f.a.deliveryId,attemptId:'attempt-denied'
    });
    assert.equal(denied.isError,true);
    assert.equal(denied.structuredContent.code,'OWNER_CONSENT_REQUIRED');
    assert.equal(f.deliveryStore.get(f.a.deliveryId,'route-a').attempts,0);
  }finally{f.close();}
});

test('all public MCP callbacks sanitize unknown Host errors and fail closed without runtime',async()=>{
  const {createProtectedDeliveryMcpToolCallbacks}=await import('../src/delivery-mcp-host-runtime.mjs');
  assert.throws(()=>createProtectedDeliveryMcpToolCallbacks(),
    /DELIVERY_EVENTS_INTEGRATION_UNAVAILABLE/);
  assert.throws(()=>createProtectedDeliveryMcpToolCallbacks({protectedDelivery:{}}),
    /DELIVERY_EVENTS_INTEGRATION_UNAVAILABLE/);
  const leaked='owner-secret-should-never-appear';
  let invoked=0;
  const callbacks=createProtectedDeliveryMcpToolCallbacks({
    protectedDelivery:{execute:async()=>{invoked++;throw new Error(leaked);}}
  });
  for(const [name,callback] of Object.entries(callbacks)){
    const result=await callback({});
    assert.equal(result.isError,true,name);
    assert.equal(result.structuredContent.code,'DELIVERY_INTEGRATION_FAILED',name);
    assert.equal(JSON.stringify(result).includes(leaked),false,name);
  }
  assert.equal(invoked,5);
});
