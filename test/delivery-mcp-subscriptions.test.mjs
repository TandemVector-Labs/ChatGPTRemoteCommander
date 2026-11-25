import test from 'node:test';
const EPOCH='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAuthenticatedMcpEventSubscriptions} from '../src/delivery-mcp-subscriptions.mjs';
import {DELIVERY_MCP_EVENT} from '../src/delivery-mcp-events.mjs';

const A={hostId:'host1',principalId:'alice',profileId:'profile1',conversationId:'alice-chat'};
const B={hostId:'host1',principalId:'bob',profileId:'profile1',conversationId:'bob-chat'};
const secret='whsec_'+Buffer.alloc(32,7).toString('base64');
const url='https://events.example.com/callback';
const input=(overrides={})=>({
  name:DELIVERY_MCP_EVENT,arguments:{},
  delivery:{mode:'webhook',url,secret},...overrides
});
function fixture(){
  const records=new Map(),verifications=[],operations=[];
  const state={caller:A,binding:{...A,correlationId:'route-alice',bindingId:EPOCH},
    grant:true,goodChallenge:true,switchAfterChallenge:false};
  const secureStore={
    async upsert(v){records.set(v.id,v);},
    async remove(v){const saved=records.get(v.id);if(saved?.scope===v.scope&&saved.bindingKey===v.bindingKey)records.delete(v.id);}
  };
  const manager=createAuthenticatedMcpEventSubscriptions({
    observeCaller:async()=>state.caller,
    resolveBinding:async()=>state.binding,
    authorizeSubscription:async op=>{operations.push(op);return state.grant;},
    verifyCallback:async q=>{
      verifications.push(q);
      if(state.switchAfterChallenge){state.caller=B;state.binding={...B,correlationId:'route-bob',bindingId:EPOCH};}
      return {verified:true,challenge:state.goodChallenge?q.challenge:'wrong-challenge'};
    },
    sealSecret:async s=>'sealed:'+createHash('sha256').update(s).digest('hex'),
    secureStore,now:()=>Date.UTC(2026,10,6,1,10,0)
  });
  return {records,verifications,operations,state,manager};
}
test('host callbacks and private durable store are required',()=>{
  assert.throws(()=>createAuthenticatedMcpEventSubscriptions(),/DELIVERY_EVENTS_TRUSTED_HOST_REQUIRED/);
  assert.throws(()=>createAuthenticatedMcpEventSubscriptions({secureStore:{}}),/DELIVERY_EVENTS_TRUSTED_HOST_REQUIRED/);
});
test('subscription id is idempotent, verified and never exposes signing secret',async()=>{
  const f=fixture();
  const a=await f.manager.subscribe(input());
  const b=await f.manager.subscribe(input());
  assert.deepEqual(a,b);
  assert.equal(a.id.startsWith('sub_'),true);
  assert.equal(a.refreshBefore,'2026-11-06T02:10:00.000Z');
  assert.deepEqual(a.cursor,null);
  assert.equal(f.records.size,1);
  assert.equal(f.verifications.length,2);
  assert.equal(f.verifications[0].url,url);
  const only=[...f.records.values()][0];
  assert.equal(only.callbackUrl,url);
  assert.equal(only.sealedSecret.startsWith('sealed:'),true);
  assert.equal(JSON.stringify(only).includes(secret),false);
  assert.equal(JSON.stringify(a).includes(secret),false);
  assert.equal(f.operations.every(x=>x.caller.principalId==='alice'),true);
});
test('same webhook URL in two independently authenticated chats has distinct subscription ids',async()=>{
  const f=fixture();
  const first=await f.manager.subscribe(input());
  f.state.caller=B; f.state.binding={...B,correlationId:'route-bob',bindingId:EPOCH};
  const second=await f.manager.subscribe(input());
  assert.notEqual(first.id,second.id);
  assert.equal(f.records.size,2);
  assert.notEqual([...f.records.values()][0].scope,[...f.records.values()][1].scope);
});
test('unsubscription is scoped and idempotent and does not require signing secret',async()=>{
  const f=fixture();
  const a=await f.manager.subscribe(input());
  const unsub={name:DELIVERY_MCP_EVENT,arguments:{},delivery:{mode:'webhook',url}};
  assert.deepEqual(await f.manager.unsubscribe(unsub),{});
  assert.equal(f.records.has(a.id),false);
  assert.deepEqual(await f.manager.unsubscribe(unsub),{});
});
test('unauthorized subscribe/unsubscribe cannot change persistent subscriptions',async()=>{
  const f=fixture();
  f.state.grant=false;
  await assert.rejects(()=>f.manager.subscribe(input()),/DELIVERY_EVENTS_SUBSCRIPTION_DENIED/);
  assert.equal(f.records.size,0);
  f.state.grant=true;
  const a=await f.manager.subscribe(input());
  f.state.grant=false;
  await assert.rejects(()=>f.manager.unsubscribe({
    name:DELIVERY_MCP_EVENT,arguments:{},delivery:{mode:'webhook',url}
  }),/DELIVERY_EVENTS_SUBSCRIPTION_DENIED/);
  assert.equal(f.records.has(a.id),true);
});
test('bad or changed callback challenge fails closed before persistence',async()=>{
  const f=fixture();
  f.state.goodChallenge=false;
  await assert.rejects(()=>f.manager.subscribe(input()),/DELIVERY_EVENTS_CALLBACK_UNVERIFIED/);
  assert.equal(f.records.size,0);
});
test('session switch during callback verification fails closed',async()=>{
  const f=fixture();
  f.state.switchAfterChallenge=true;
  await assert.rejects(()=>f.manager.subscribe(input()),/DELIVERY_EVENTS_SESSION_CHANGED/);
  assert.equal(f.records.size,0);
});
test('revocation before sealing blocks persistent subscription',async()=>{
  const f=fixture();
  const state=f.state;
  const m=createAuthenticatedMcpEventSubscriptions({
    observeCaller:async()=>state.caller,
    resolveBinding:async()=>state.binding,
    authorizeSubscription:async()=>state.grant,
    verifyCallback:async q=>{state.grant=false;return {verified:true,challenge:q.challenge};},
    sealSecret:async()=>{throw Error('should not seal when permission revoked');},
    secureStore:{upsert:async()=>{throw Error('should not upsert');},remove:async()=>{}}
  });
  await assert.rejects(()=>m.subscribe(input()),/DELIVERY_EVENTS_SUBSCRIPTION_DENIED/);
});
test('invalid webhook destinations are refused before verification',async()=>{
  for(const bad of ['http://events.example.com/x','https://127.0.0.1/cb',
    'https://localhost/cb','https://api.local/cb','https://api.internal/cb',
    'https://bob:pass@events.example.com/cb','https://events.example.com/cb#fragment',
    'https://[::1]/cb']){
    const f=fixture();
    await assert.rejects(()=>f.manager.subscribe(input({delivery:{mode:'webhook',url:bad,secret}})),
      /DELIVERY_EVENTS_CALLBACK_INVALID/,bad);
    assert.equal(f.verifications.length,0);
    assert.equal(f.records.size,0);
  }
});
test('invalid signing secrets and extra fields are rejected before trust hooks',async()=>{
  const wrong=['whsec_bad','whsec_'+Buffer.alloc(2,1).toString('base64'),
    'whsec_'+Buffer.alloc(100,1).toString('base64'),'plain-secret'];
  for(const s of wrong){
    const f=fixture();
    await assert.rejects(()=>f.manager.subscribe(input({delivery:{mode:'webhook',url,secret:s}})),
      /DELIVERY_EVENTS_SECRET_INVALID/);
    assert.equal(f.verifications.length,0);
  }
  const f=fixture();
  await assert.rejects(()=>f.manager.subscribe({...input(),principalId:'alice'}),
    /DELIVERY_EVENTS_SUBSCRIPTION_INVALID/);
  await assert.rejects(()=>f.manager.subscribe(input({arguments:{conversationId:'alice-chat'}})),
    /DELIVERY_EVENTS_SUBSCRIPTION_INVALID/);
  assert.equal(f.verifications.length,0);
});
test('legacy cursor and unbounded TTL fail before callback registration',async()=>{
  const f=fixture();
  await assert.rejects(()=>f.manager.subscribe(input({cursor:'123'})),/DELIVERY_EVENTS_CURSOR_UNSUPPORTED/);
  await assert.rejects(()=>f.manager.subscribe(input({ttlMs:0})),/DELIVERY_EVENTS_TTL_INVALID/);
  await assert.rejects(()=>f.manager.subscribe(input({ttlMs:999999999})),/DELIVERY_EVENTS_TTL_INVALID/);
  assert.equal(f.verifications.length,0);
});

test('grant revoked during asynchronous secret sealing blocks persistence',async()=>{
  const f=fixture(),state=f.state;
  const mgr=createAuthenticatedMcpEventSubscriptions({
    observeCaller:async()=>state.caller,
    resolveBinding:async()=>state.binding,
    authorizeSubscription:async()=>state.grant,
    verifyCallback:async q=>({verified:true,challenge:q.challenge}),
    sealSecret:async s=>{
      state.grant=false;
      return 'sealed:'+createHash('sha256').update(s).digest('hex');
    },
    secureStore:{
      upsert:async()=>{throw Error('MUST_NOT_PERSIST_AFTER_REVOKE');},
      remove:async()=>{}
    }
  });
  await assert.rejects(()=>mgr.subscribe(input()),/DELIVERY_EVENTS_SUBSCRIPTION_DENIED/);
});

test('ttlMs null requests no expiry but the server grants its bounded one-hour default',async()=>{
  const f=fixture();
  const granted=await f.manager.subscribe(input({ttlMs:null,cursor:null}));
  assert.equal(granted.refreshBefore,'2026-11-06T02:10:00.000Z');
  assert.equal(granted.cursor,null);
  assert.equal(f.records.size,1);
  assert.equal(f.verifications.length,1);
});
test('a shorter positive ttlMs is respected without increasing the server maximum',async()=>{
  const f=fixture();
  const granted=await f.manager.subscribe(input({ttlMs:120000}));
  assert.equal(granted.refreshBefore,'2026-11-06T01:12:00.000Z');
  assert.equal(f.records.size,1);
});

test('unsubscribe during a pending callback challenge cannot resurrect a deleted subscription',async()=>{
  const f=fixture();
  const first=await f.manager.subscribe(input());
  let releaseVerification,challengeStarted;
  const started=new Promise(resolve=>{challengeStarted=resolve;});
  const waitForVerification=new Promise(resolve=>{releaseVerification=resolve;});
  const manager=createAuthenticatedMcpEventSubscriptions({
    observeCaller:async()=>f.state.caller,
    resolveBinding:async()=>f.state.binding,
    authorizeSubscription:async()=>true,
    verifyCallback:async q=>{
      challengeStarted();
      await waitForVerification;
      return {verified:true,challenge:q.challenge};
    },
    sealSecret:async s=>'sealed:'+createHash('sha256').update(s).digest('hex'),
    secureStore:{
      upsert:async row=>{f.records.set(row.id,row);},
      remove:async row=>{
        const current=f.records.get(row.id);
        if(current?.scope===row.scope&&current.bindingKey===row.bindingKey)
          f.records.delete(row.id);
      }
    },
    now:()=>Date.UTC(2026,10,6,1,10,0)
  });
  const subscribed=manager.subscribe(input());
  await started;
  const unsubscribe=manager.unsubscribe({
    name:DELIVERY_MCP_EVENT,arguments:{},delivery:{mode:'webhook',url}
  });
  const revocation=await unsubscribe;
  assert.deepEqual(revocation,{});
  assert.equal(f.records.has(first.id),false);
  releaseVerification();
  await assert.rejects(subscribed,/DELIVERY_EVENTS_SUBSCRIPTION_SUPERSEDED/);
  assert.equal(f.records.has(first.id),false);
});

test('unsubscribe wins over an already-started asynchronous subscription upsert',async()=>{
  const records=new Map();
  let upsertStarted,releaseUpsert,revocationChecked;
  const inUpsert=new Promise(resolve=>{upsertStarted=resolve;});
  const allowUpsert=new Promise(resolve=>{releaseUpsert=resolve;});
  const inRevocation=new Promise(resolve=>{revocationChecked=resolve;});
  const mgr=createAuthenticatedMcpEventSubscriptions({
    observeCaller:async()=>A,
    resolveBinding:async()=>({...A,correlationId:'route-alice',bindingId:EPOCH}),
    authorizeSubscription:async operation=>{
      if(operation.action==='unsubscribe')revocationChecked();
      return true;
    },
    verifyCallback:async q=>({verified:true,challenge:q.challenge}),
    sealSecret:async s=>'sealed:'+createHash('sha256').update(s).digest('hex'),
    secureStore:{
      upsert:async row=>{
        upsertStarted();
        await allowUpsert;
        records.set(row.id,row);
      },
      remove:async row=>{
        const item=records.get(row.id);
        if(item?.scope===row.scope&&item.bindingKey===row.bindingKey)
          records.delete(row.id);
      }
    },
    now:()=>Date.UTC(2026,10,6,1,10,0)
  });
  const subscription=mgr.subscribe(input());
  await inUpsert;
  const revocation=mgr.unsubscribe({
    name:DELIVERY_MCP_EVENT,arguments:{},delivery:{mode:'webhook',url}
  });
  await inRevocation;
  // Allow the unsubscribe caller's asynchronous authorization and binding
  // checks to reach its cancellation fence before releasing the store write.
  await new Promise(resolve=>setImmediate(resolve));
  releaseUpsert();
  await assert.rejects(subscription,/DELIVERY_EVENTS_SUBSCRIPTION_SUPERSEDED/);
  assert.deepEqual(await revocation,{});
  assert.equal(records.size,0);
});
test('cancelling one callback URL does not supersede an independent subscription',async()=>{
  const f=fixture();
  const first=await f.manager.subscribe(input());
  const alternate='https://events.example.com/alternate';
  const second=await f.manager.subscribe(input({
    delivery:{mode:'webhook',url:alternate,secret}
  }));
  await f.manager.unsubscribe({
    name:DELIVERY_MCP_EVENT,arguments:{},
    delivery:{mode:'webhook',url}
  });
  assert.equal(f.records.has(first.id),false);
  assert.equal(f.records.has(second.id),true);
  assert.equal(f.records.size,1);
});

test('same-chat regrant during callback verification denies stale registration',async()=>{
  const f=fixture();
  f.state.switchAfterChallenge=false;
  const manager=createAuthenticatedMcpEventSubscriptions({
    observeCaller:async()=>f.state.caller,
    resolveBinding:async()=>f.state.binding,
    authorizeSubscription:async()=>true,
    verifyCallback:async q=>{
      f.state.binding={...f.state.binding,bindingId:'c'.repeat(32)};
      return {verified:true,challenge:q.challenge};
    },
    sealSecret:async()=> 'sealed:secret',
    secureStore:{upsert:async()=>{throw new Error('MUST_NOT_WRITE');},remove:async()=>{}}
  });
  await assert.rejects(()=>manager.subscribe(input()),/DELIVERY_EVENTS_BINDING_CHANGED/);
});

test('new consent epoch on same chat creates a new owner-scoped webhook subscription id',async()=>{
  const f=fixture();
  const previous=await f.manager.subscribe(input());
  f.state.binding={...f.state.binding,bindingId:'c'.repeat(32)};
  const current=await f.manager.subscribe(input());
  assert.notEqual(previous.id,current.id);
  assert.equal(f.records.size,2);
});
