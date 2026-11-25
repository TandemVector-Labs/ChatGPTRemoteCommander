import test from 'node:test';
const EPOCH='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,createHmac} from 'node:crypto';
import {DeliveryStore} from '../src/delivery-store.mjs';
import {createAuthenticatedDeliveryTools} from '../src/delivery-authenticated.mjs';
import {createDeliveryMcpEventProjection} from '../src/delivery-mcp-events.mjs';
import {DeliveryEventSubscriptionStore} from '../src/delivery-mcp-subscription-store.mjs';
import {createDeliveryWebhookSender} from '../src/delivery-mcp-send.mjs';
import {EventEmitter} from 'node:events';
import {createVerifiedWebhookHttpsTransport} from '../src/delivery-mcp-verified-https.mjs';
const A={hostId:'host1',principalId:'alice',profileId:'profile1',conversationId:'chat-1'};
const B={hostId:'host1',principalId:'bob',profileId:'profile1',conversationId:'chat-2'};
const profileScope='a'.repeat(64),subscriptionId='sub_'+'d'.repeat(64);
const callback='https://events.example.net/callback';
const secret='whsec_'+Buffer.alloc(32,7).toString('base64');
const digest=text=>createHash('sha256').update(text).digest('hex');
const scope=digest(JSON.stringify(['host1','alice','profile1','chat-1']));
const bindingKey=digest(JSON.stringify(['alice-route',EPOCH]));
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v106-sender-'));
  const delivery=new DeliveryStore({directory:path.join(root,'delivery'),scope:'profile'});
  const subscriptions=new DeliveryEventSubscriptionStore({
    directory:path.join(root,'sub'),profileScope
  });
  const state={caller:A,binding:{...A,correlationId:'alice-route',bindingId:EPOCH},
    grant:true,responses:[200],posts:[],checks:[],onPost:null,time:Date.UTC(2026,10,6,1,0,0)};
  const item=delivery.publish({bindingId:EPOCH,eventKey:'operation:ready:completed',
    correlationId:'alice-route',source:'operation',sourceId:'ready',kind:'COMPLETED'});
  const authenticatedDelivery=createAuthenticatedDeliveryTools({
    store:delivery,observeCaller:async()=>state.caller,
    resolveBinding:async()=>state.binding,authorizeDelivery:async()=>state.grant,
    attestPresentation:async q=>({...q,verified:true,presentationId:'native'})
  });
  const projection=createDeliveryMcpEventProjection({authenticatedDelivery});
  subscriptions.upsert({id:subscriptionId,scope,bindingKey,name:'commander.delivery.ready',
    callbackUrl:callback,sealedSecret:'host-sealed-key',
    refreshBefore:'2026-11-07T01:00:00.000Z',verifiedAt:'2026-11-06T01:00:00.000Z'});
  const sender=createDeliveryWebhookSender({
    projection,subscriptions,observeCaller:async()=>state.caller,
    resolveBinding:async()=>state.binding,
    authorizeSend:async a=>{state.checks.push(a);return state.grant;},
    unsealSecret:async()=>secret,
    postVerifiedHttps:async request=>{
      state.posts.push(request);
      if(state.onPost)await state.onPost(request);
      const status=state.responses.shift()??503;
      return {status};
    },
    now:()=>state.time,
    sleep:async()=>{state.time+=1000;}
  });
  return {root,delivery,subscriptions,state,item,sender,close(){
    delivery.close();subscriptions.close();fs.rmSync(root,{recursive:true,force:true});
  }};
}
test('verified HTTPS handoff reports receipt without synthesizing ChatGPT delivery ACK',async()=>{
  const f=fixture();
  try{
    const result=await f.sender.send({deliveryId:f.item.deliveryId,subscriptionId});
    assert.equal(result.webhookAccepted,true);
    assert.equal(result.resultDeliveryAcknowledged,false);
    assert.equal(result.attempts,1);
    assert.equal(f.state.posts.length,1);
    const sent=f.state.posts[0];
    assert.equal(sent.url,callback);
    assert.equal(sent.noRedirects,true);
    assert.equal(sent.headers['X-MCP-Subscription-Id'],subscriptionId);
    const bytes=sent.headers['webhook-id']+'.'+sent.headers['webhook-timestamp']+'.'+sent.body;
    const mac=createHmac('sha256',Buffer.alloc(32,7)).update(bytes).digest('base64');
    assert.equal(sent.headers['webhook-signature'],'v1,'+mac);
    assert.equal(f.delivery.get(f.item.deliveryId,'alice-route').state,'COMPLETED_UNDELIVERED');
    assert.equal(f.delivery.get(f.item.deliveryId,'alice-route').receiptId,null);
  }finally{f.close();}
});
test('retryable responses preserve event ID and regenerate signing timestamp',async()=>{
  const f=fixture();
  try{
    f.state.responses=[503,429,202];
    const result=await f.sender.send({deliveryId:f.item.deliveryId,subscriptionId});
    assert.equal(result.webhookAccepted,true);
    assert.equal(result.attempts,3);
    assert.equal(f.state.posts.length,3);
    assert.equal(new Set(f.state.posts.map(p=>p.headers['webhook-id'])).size,1);
    assert.equal(new Set(f.state.posts.map(p=>p.headers['webhook-timestamp'])).size,3);
    assert.equal(f.delivery.health().counts.DELIVERED??0,0);
  }finally{f.close();}
});
test('terminal response 410 or 413 never triggers retry or ACK',async()=>{
  for(const status of [410,413,403]){
    const f=fixture();
    try{
      f.state.responses=[status,200];
      const r=await f.sender.send({deliveryId:f.item.deliveryId,subscriptionId});
      assert.equal(r.webhookAccepted,false);
      assert.equal(r.terminal,true);
      assert.equal(r.attempts,1);
      assert.equal(f.state.posts.length,1);
      assert.equal(f.delivery.get(f.item.deliveryId,'alice-route').state,'COMPLETED_UNDELIVERED');
    }finally{f.close();}
  }
});
test('exhausted transient responses preserve pending delivery and report no success',async()=>{
  const f=fixture();
  try{
    f.state.responses=[503,503,503];
    const r=await f.sender.send({deliveryId:f.item.deliveryId,subscriptionId});
    assert.equal(r.webhookAccepted,false);
    assert.equal(r.retryExhausted,true);
    assert.equal(r.attempts,3);
    assert.equal(f.delivery.get(f.item.deliveryId,'alice-route').state,'COMPLETED_UNDELIVERED');
  }finally{f.close();}
});
test('revoked grant or cross-chat identity prevents network transmission',async()=>{
  const f=fixture();
  try{
    f.state.grant=false;
    await assert.rejects(()=>f.sender.send({deliveryId:f.item.deliveryId,subscriptionId}),
      /DELIVERY_AUTH_GRANT_REQUIRED|DELIVERY_SEND_GRANT_REQUIRED/);
    assert.equal(f.state.posts.length,0);
    f.state.grant=true;
    f.state.caller=B;
    f.state.binding={...B,correlationId:'bob-route',bindingId:EPOCH};
    await assert.rejects(()=>f.sender.send({deliveryId:f.item.deliveryId,subscriptionId}),
      /DELIVERY_CORRELATION_MISMATCH/);
    assert.equal(f.state.posts.length,0);
  }finally{f.close();}
});
test('disconnected or expired subscription blocks sending before outbound I/O',async()=>{
  const f=fixture();
  try{
    f.subscriptions.remove({id:subscriptionId,scope,bindingKey});
    await assert.rejects(()=>f.sender.send({deliveryId:f.item.deliveryId,subscriptionId}),
      /DELIVERY_SEND_SUBSCRIPTION_INACTIVE/);
    assert.equal(f.state.posts.length,0);
  }finally{f.close();}
});
test('a changed desktop session while awaiting HTTPS result blocks claiming success',async()=>{
  const f=fixture();
  try{
    f.state.onPost=async()=>{f.state.caller=B;f.state.binding={...B,correlationId:'bob-route',bindingId:EPOCH};};
    await assert.rejects(()=>f.sender.send({deliveryId:f.item.deliveryId,subscriptionId}),
      /DELIVERY_SEND_SESSION_CHANGED/);
    assert.equal(f.state.posts.length,1);
    assert.equal(f.delivery.get(f.item.deliveryId,'alice-route').receiptId,null);
  }finally{f.close();}
});
test('unsubscription between transient attempts blocks retrying a revoked endpoint',async()=>{
  const f=fixture();
  try{
    f.state.responses=[503,200];
    f.state.onPost=async()=>{
      f.subscriptions.remove({id:subscriptionId,scope,bindingKey});
    };
    await assert.rejects(()=>f.sender.send({deliveryId:f.item.deliveryId,subscriptionId}),
      /DELIVERY_SEND_SUBSCRIPTION_INACTIVE/);
    assert.equal(f.state.posts.length,1);
  }finally{f.close();}
});
test('invalid subscription or delivery identifiers cannot cause effects',async()=>{
  const f=fixture();
  try{
    await assert.rejects(()=>f.sender.send({deliveryId:'made-up',subscriptionId}),
      /DELIVERY_SEND_ID_INVALID/);
    await assert.rejects(()=>f.sender.send({deliveryId:f.item.deliveryId,subscriptionId:'sub_bad'}),
      /DELIVERY_SEND_ID_INVALID/);
    assert.equal(f.state.posts.length,0);
  }finally{f.close();}
});

test('grant revoked during secret-unsealing prevents outbound network I/O',async()=>{
  const f=fixture();
  try{
    const projection=createDeliveryMcpEventProjection({
      authenticatedDelivery:createAuthenticatedDeliveryTools({
        store:f.delivery,observeCaller:async()=>f.state.caller,
        resolveBinding:async()=>f.state.binding,authorizeDelivery:async()=>f.state.grant,
        attestPresentation:async q=>({...q,verified:true,presentationId:'native'})
      })
    });
    let networkAttempts=0;
    const sender=createDeliveryWebhookSender({
      projection,subscriptions:f.subscriptions,
      observeCaller:async()=>f.state.caller,resolveBinding:async()=>f.state.binding,
      authorizeSend:async()=>f.state.grant,
      unsealSecret:async()=>{f.state.grant=false;return secret;},
      postVerifiedHttps:async()=>{networkAttempts++;return {status:200};},
      now:()=>f.state.time,sleep:async()=>{}
    });
    await assert.rejects(()=>sender.send({deliveryId:f.item.deliveryId,subscriptionId}),
      /DELIVERY_SEND_GRANT_REQUIRED/);
    assert.equal(networkAttempts,0);
  }finally{f.close();}
});

test('TLS certificate or DNS policy failure is never retried or reported as webhook acceptance',async()=>{
  for(const code of ['DELIVERY_EGRESS_DNS_UNSAFE','DELIVERY_EGRESS_URL_INVALID',
    'ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED']){
    const f=fixture();
    try{
      let effects=0;
      const authenticatedDelivery=createAuthenticatedDeliveryTools({
        store:f.delivery,observeCaller:async()=>f.state.caller,
        resolveBinding:async()=>f.state.binding,authorizeDelivery:async()=>f.state.grant,
        attestPresentation:async q=>({...q,verified:true,presentationId:'native'})
      });
      const sender=createDeliveryWebhookSender({
        projection:createDeliveryMcpEventProjection({authenticatedDelivery}),
        subscriptions:f.subscriptions,observeCaller:async()=>f.state.caller,
        resolveBinding:async()=>f.state.binding,
        authorizeSend:async()=>true,unsealSecret:async()=>secret,
        postVerifiedHttps:async()=>{effects++;throw Object.assign(new Error(code),{code});},
        now:()=>f.state.time,sleep:async()=>{throw Error('MUST_NOT_RETRY');}
      });
      await assert.rejects(()=>sender.send({deliveryId:f.item.deliveryId,subscriptionId}),
        error=>error.code===code);
      assert.equal(effects,1,code);
      assert.equal(f.delivery.get(f.item.deliveryId,'alice-route').receiptId,null);
    }finally{f.close();}
  }
});

test('retry does not resend an event that was delivered and ACKed after a transient response',async()=>{
  const f=fixture();
  try{
    f.state.responses=[503,200];
    let postCount=0;
    f.state.onPost=async()=>{
      postCount++;
      if(postCount===1){
        f.delivery.claim({deliveryId:f.item.deliveryId,correlationId:'alice-route',
          attemptId:'confirmed-elsewhere'});
        f.delivery.ack({deliveryId:f.item.deliveryId,correlationId:'alice-route',
          attemptId:'confirmed-elsewhere'});
      }
    };
    await assert.rejects(()=>f.sender.send({deliveryId:f.item.deliveryId,subscriptionId}),
      /DELIVERY_EVENTS_NOT_PENDING|DELIVERY_SEND_EVENT_STALE/);
    assert.equal(postCount,1);
    assert.equal(f.delivery.get(f.item.deliveryId,'alice-route').state,'DELIVERED');
  }finally{f.close();}
});
test('late ACK during secret unsealing prevents initial webhook transmission',async()=>{
  const f=fixture();
  try{
    const projection=createDeliveryMcpEventProjection({
      authenticatedDelivery:createAuthenticatedDeliveryTools({
        store:f.delivery,observeCaller:async()=>f.state.caller,
        resolveBinding:async()=>f.state.binding,authorizeDelivery:async()=>f.state.grant,
        attestPresentation:async r=>({...r,verified:true,presentationId:'native'})
      })
    });
    let networkAttempts=0;
    const sender=createDeliveryWebhookSender({
      projection,subscriptions:f.subscriptions,
      observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,
      authorizeSend:async()=>f.state.grant,
      unsealSecret:async()=>{
        f.delivery.claim({deliveryId:f.item.deliveryId,correlationId:'alice-route',
          attemptId:'ack-during-unseal'});
        f.delivery.ack({deliveryId:f.item.deliveryId,correlationId:'alice-route',
          attemptId:'ack-during-unseal'});
        return secret;
      },
      postVerifiedHttps:async()=>{networkAttempts++;return {status:200};},
      now:()=>f.state.time,sleep:async()=>{}
    });
    await assert.rejects(()=>sender.send({deliveryId:f.item.deliveryId,subscriptionId}),
      /DELIVERY_EVENTS_NOT_PENDING|DELIVERY_SEND_EVENT_STALE/);
    assert.equal(networkAttempts,0);
  }finally{f.close();}
});

test('signed deliveries accept current and prior key only within a short refresh window',async()=>{
  const f=fixture();
  try{
    const newKey=Buffer.alloc(32,8);
    const rotated='whsec_'+newKey.toString('base64');
    f.subscriptions.upsert({
      id:subscriptionId,scope,bindingKey,name:'commander.delivery.ready',
      callbackUrl:callback,sealedSecret:'host-rotated',
      verifiedAt:'2026-11-06T01:00:00.000Z',
      refreshBefore:'2026-11-07T01:00:00.000Z'
    });
    const projection=createDeliveryMcpEventProjection({
      authenticatedDelivery:createAuthenticatedDeliveryTools({
        store:f.delivery,observeCaller:async()=>f.state.caller,
        resolveBinding:async()=>f.state.binding,authorizeDelivery:async()=>f.state.grant,
        attestPresentation:async r=>({...r,verified:true,presentationId:'native'})
      })
    });
    let posts=[];
    const sender=createDeliveryWebhookSender({
      projection,subscriptions:f.subscriptions,
      observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,authorizeSend:async()=>true,
      unsealSecret:async sealed=>sealed==='host-rotated'?rotated:secret,
      postVerifiedHttps:async request=>{posts.push(request);return {status:202};},
      now:()=>f.state.time,sleep:async()=>{}
    });
    let result=await sender.send({deliveryId:f.item.deliveryId,subscriptionId});
    assert.equal(result.webhookAccepted,true);
    const entry=posts[0],msg=entry.headers['webhook-id']+'.'
      +entry.headers['webhook-timestamp']+'.'+entry.body;
    const sig=entry.headers['webhook-signature'].split(' ');
    assert.equal(sig.length,2);
    assert.equal(sig[0],'v1,'+createHmac('sha256',newKey).update(msg).digest('base64'));
    assert.equal(sig[1],'v1,'+createHmac('sha256',Buffer.alloc(32,7))
      .update(msg).digest('base64'));
    f.state.time=Date.parse('2026-11-06T01:05:01.000Z');
    posts=[];
    result=await sender.send({deliveryId:f.item.deliveryId,subscriptionId});
    assert.equal(result.webhookAccepted,true);
    assert.equal(posts.length,1);
    assert.equal(posts[0].headers['webhook-signature'].split(' ').length,1);
  }finally{f.close();}
});
test('subscription revoked while unsealing key must not initiate an outbound request',async()=>{
  const f=fixture();
  try{
    const projection=createDeliveryMcpEventProjection({
      authenticatedDelivery:createAuthenticatedDeliveryTools({
        store:f.delivery,observeCaller:async()=>f.state.caller,
        resolveBinding:async()=>f.state.binding,authorizeDelivery:async()=>f.state.grant,
        attestPresentation:async r=>({...r,verified:true,presentationId:'native'})
      })
    });
    let outbound=0;
    const sender=createDeliveryWebhookSender({
      projection,subscriptions:f.subscriptions,
      observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,
      authorizeSend:async()=>true,
      unsealSecret:async()=>{
        f.subscriptions.remove({id:subscriptionId,scope,bindingKey});
        return secret;
      },
      postVerifiedHttps:async()=>{outbound++;return {status:202};},
      now:()=>f.state.time,sleep:async()=>{}
    });
    await assert.rejects(()=>sender.send({deliveryId:f.item.deliveryId,subscriptionId}),
      /DELIVERY_SEND_SUBSCRIPTION_CHANGED|DELIVERY_SEND_SUBSCRIPTION_INACTIVE/);
    assert.equal(outbound,0);
  }finally{f.close();}
});

test('TLS protocol errors and unclassified transport exceptions are never retried',async()=>{
  for(const code of ['EPROTO','ERR_SSL_WRONG_VERSION_NUMBER',
    'SELF_SIGNED_CERT_IN_CHAIN','UNEXPECTED_TRANSPORT_EXCEPTION']){
    const f=fixture();
    try{
      const projection=createDeliveryMcpEventProjection({
        authenticatedDelivery:createAuthenticatedDeliveryTools({
          store:f.delivery,observeCaller:async()=>f.state.caller,
          resolveBinding:async()=>f.state.binding,authorizeDelivery:async()=>true,
          attestPresentation:async req=>({...req,verified:true,presentationId:'native'})
        })
      });
      let attempts=0;
      const sender=createDeliveryWebhookSender({
        projection,subscriptions:f.subscriptions,
        observeCaller:async()=>f.state.caller,
        resolveBinding:async()=>f.state.binding,
        authorizeSend:async()=>true,
        unsealSecret:async()=>secret,
        postVerifiedHttps:async()=>{
          attempts++;
          throw Object.assign(new Error(code),{code});
        },
        now:()=>f.state.time,sleep:async()=>{throw Error('UNSAFE_RETRY');}
      });
      await assert.rejects(()=>sender.send({deliveryId:f.item.deliveryId,subscriptionId}),
        error=>error.code===code,code);
      assert.equal(attempts,1,code);
      assert.equal(f.delivery.get(f.item.deliveryId,'alice-route').receiptId,null);
    }finally{f.close();}
  }
});
test('known transient network errors receive bounded retries without ACK',async()=>{
  const f=fixture();
  try{
    let attempts=0;
    const projection=createDeliveryMcpEventProjection({
      authenticatedDelivery:createAuthenticatedDeliveryTools({
        store:f.delivery,observeCaller:async()=>f.state.caller,
        resolveBinding:async()=>f.state.binding,authorizeDelivery:async()=>true,
        attestPresentation:async req=>({...req,verified:true,presentationId:'native'})
      })
    });
    const sender=createDeliveryWebhookSender({
      projection,subscriptions:f.subscriptions,
      observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,
      authorizeSend:async()=>true,unsealSecret:async()=>secret,
      postVerifiedHttps:async()=>{
        attempts++;
        if(attempts<3)throw Object.assign(new Error('transient'),{code:'ECONNRESET'});
        return {status:202};
      },
      now:()=>f.state.time,sleep:async()=>{f.state.time+=1000;}
    });
    const result=await sender.send({deliveryId:f.item.deliveryId,subscriptionId});
    assert.equal(attempts,3);
    assert.equal(result.webhookAccepted,true);
    assert.equal(result.resultDeliveryAcknowledged,false);
    assert.equal(f.delivery.get(f.item.deliveryId,'alice-route').state,'COMPLETED_UNDELIVERED');
  }finally{f.close();}
});

test('valid subscription beyond first 100 owner subscriptions remains deliverable',async()=>{
  const f=fixture();
  try{
    for(let i=0;i<110;i++){
      f.subscriptions.upsert({
        id:'sub_'+i.toString(16).padStart(64,'0'),scope,bindingKey,
        name:'commander.delivery.ready',callbackUrl:callback,
        sealedSecret:'host-sealed-key',
        refreshBefore:'2026-11-07T01:00:00.000Z',
        verifiedAt:'2026-11-06T01:00:00.000Z'
      });
    }
    const result=await f.sender.send({deliveryId:f.item.deliveryId,subscriptionId});
    assert.equal(result.webhookAccepted,true);
    assert.equal(result.attempts,1);
    assert.equal(f.state.posts.length,1);
    assert.equal(f.delivery.get(f.item.deliveryId,'alice-route').receiptId,null);
  }finally{f.close();}
});

test('second authorization round cannot send after callback subscription was revoked or rekeyed',async()=>{
  for(const change of ['revoke','rekey']){
    const f=fixture();
    try{
      const authenticatedDelivery=createAuthenticatedDeliveryTools({
        store:f.delivery,observeCaller:async()=>f.state.caller,
        resolveBinding:async()=>f.state.binding,authorizeDelivery:async()=>true,
        attestPresentation:async receipt=>({...receipt,verified:true,presentationId:'native'})
      });
      let grantChecks=0,networkAttempts=0;
      const sender=createDeliveryWebhookSender({
        projection:createDeliveryMcpEventProjection({authenticatedDelivery}),
        subscriptions:f.subscriptions,
        observeCaller:async()=>f.state.caller,
        resolveBinding:async()=>f.state.binding,
        authorizeSend:async()=>{
          if(++grantChecks===2){
            if(change==='revoke'){
              f.subscriptions.remove({id:subscriptionId,scope,bindingKey});
            }else{
              f.subscriptions.upsert({
                id:subscriptionId,scope,bindingKey,
                name:'commander.delivery.ready',callbackUrl:callback,
                sealedSecret:'rotated-sealed-key',
                refreshBefore:'2026-11-07T01:00:00.000Z',
                verifiedAt:'2026-11-06T01:00:01.000Z'
              });
            }
          }
          return true;
        },
        unsealSecret:async()=>secret,
        postVerifiedHttps:async()=>{networkAttempts++;return {status:202};},
        now:()=>f.state.time,sleep:async()=>{}
      });
      await assert.rejects(
        ()=>sender.send({deliveryId:f.item.deliveryId,subscriptionId}),
        /DELIVERY_SEND_SUBSCRIPTION_CHANGED|DELIVERY_SEND_SUBSCRIPTION_INACTIVE/,
        change
      );
      assert.equal(grantChecks>=2,true,change);
      assert.equal(networkAttempts,0,change);
      assert.equal(f.delivery.get(f.item.deliveryId,'alice-route').receiptId,null);
    }finally{f.close();}
  }
});

test('grant revoked during the last sender binding verification cannot transmit a webhook',async()=>{
  const f=fixture();
  try{
    let bindingChecks=0,grantChecks=0,networkAttempts=0;
    const adapter=createAuthenticatedDeliveryTools({
      store:f.delivery,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,
      authorizeDelivery:async()=>true
    });
    const sender=createDeliveryWebhookSender({
      projection:createDeliveryMcpEventProjection({authenticatedDelivery:adapter}),
      subscriptions:f.subscriptions,
      observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>{
        // This last awaited binding check executes after the second grant.
        if(++bindingChecks===7)f.state.grant=false;
        return f.state.binding;
      },
      authorizeSend:async()=>{grantChecks++;return f.state.grant;},
      unsealSecret:async()=>secret,
      postVerifiedHttps:async()=>{networkAttempts++;return {status:202};},
      now:()=>f.state.time,sleep:async()=>{}
    });
    await assert.rejects(()=>sender.send({deliveryId:f.item.deliveryId,subscriptionId}),
      /DELIVERY_SEND_GRANT_REQUIRED/);
    assert.equal(bindingChecks>=7,true);
    assert.equal(grantChecks>=2,true);
    assert.equal(networkAttempts,0);
    assert.equal(f.delivery.get(f.item.deliveryId,'alice-route').receiptId,null);
  }finally{f.close();}
});

test('delivery ACKed by a peer during the final grant cannot be sent as pending',async()=>{
  const f=fixture();
  try{
    let grantChecks=0,networkAttempts=0;
    const adapter=createAuthenticatedDeliveryTools({
      store:f.delivery,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,authorizeDelivery:async()=>true
    });
    const sender=createDeliveryWebhookSender({
      projection:createDeliveryMcpEventProjection({authenticatedDelivery:adapter}),
      subscriptions:f.subscriptions,
      observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,
      authorizeSend:async()=>{
        if(++grantChecks===3){
          f.delivery.claim({deliveryId:f.item.deliveryId,
            correlationId:'alice-route',attemptId:'ack-by-peer'});
          f.delivery.ack({deliveryId:f.item.deliveryId,
            correlationId:'alice-route',attemptId:'ack-by-peer'});
        }
        return true;
      },
      unsealSecret:async()=>secret,
      postVerifiedHttps:async()=>{networkAttempts++;return {status:202};},
      now:()=>f.state.time,sleep:async()=>{}
    });
    await assert.rejects(()=>sender.send({deliveryId:f.item.deliveryId,subscriptionId}),
      /DELIVERY_EVENTS_NOT_PENDING|DELIVERY_SEND_EVENT_STALE/);
    assert.equal(grantChecks>=3,true);
    assert.equal(networkAttempts,0);
    assert.equal(f.delivery.get(f.item.deliveryId,'alice-route').state,'DELIVERED');
  }finally{f.close();}
});

test('owner consent regrant with same chat and correlation cannot reuse old webhook subscription',async()=>{
  const f=fixture();
  try {
    f.state.binding={...f.state.binding,bindingId:'c'.repeat(32)};
    await assert.rejects(()=>f.sender.send({
      deliveryId:f.item.deliveryId,subscriptionId
    }),/DELIVERY_AUTH_RESULT_EPOCH_MISMATCH|DELIVERY_SEND_SUBSCRIPTION_INACTIVE/);
    assert.equal(f.state.posts.length,0);
  } finally {f.close();}
});

test('owner consent epoch rotation during sender grant prevents outbound request',async()=>{
  const f=fixture();
  try {
    let changed=false;
    const projection=createDeliveryMcpEventProjection({
      authenticatedDelivery:createAuthenticatedDeliveryTools({
        store:f.delivery,observeCaller:async()=>f.state.caller,
        resolveBinding:async()=>f.state.binding,authorizeDelivery:async()=>true,
        attestPresentation:async q=>({...q,verified:true,presentationId:'native'})
      })
    });
    const sender=createDeliveryWebhookSender({
      projection,subscriptions:f.subscriptions,
      observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,
      authorizeSend:async()=> {
        if(!changed) {changed=true;f.state.binding={...f.state.binding,bindingId:'c'.repeat(32)};}
        return true;
      },
      unsealSecret:async()=>secret,
      postVerifiedHttps:async req=>{f.state.posts.push(req);return {status:200};},
      now:()=>f.state.time
    });
    await assert.rejects(()=>sender.send({
      deliveryId:f.item.deliveryId,subscriptionId
    }),/DELIVERY_SEND_BINDING_CHANGED/);
    assert.equal(f.state.posts.length,0);
  } finally {f.close();}
});

test('regrant inside final authorizeSend cannot transmit a webhook for stale consent',async()=>{
  const f=fixture();
  try {
    let checks=0,network=0;
    const adapter=createAuthenticatedDeliveryTools({
      store:f.delivery,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,authorizeDelivery:async()=>true
    });
    const sender=createDeliveryWebhookSender({
      projection:createDeliveryMcpEventProjection({authenticatedDelivery:adapter}),
      subscriptions:f.subscriptions,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,
      authorizeSend:async()=>{
        if(++checks===3) f.state.binding={...f.state.binding,bindingId:'c'.repeat(32)};
        return true;
      },
      unsealSecret:async()=>secret,
      postVerifiedHttps:async()=>{network++;return {status:202};},
      now:()=>f.state.time,sleep:async()=>{}
    });
    await assert.rejects(()=>sender.send({
      deliveryId:f.item.deliveryId,subscriptionId
    }),/DELIVERY_SEND_BINDING_CHANGED|DELIVERY_AUTH_RESULT_EPOCH_MISMATCH/);
    assert.equal(checks>=3,true);
    assert.equal(network,0);
    assert.equal(f.delivery.get(f.item.deliveryId,'alice-route').receiptId,null);
  }finally{f.close();}
});

test('chat identity switched during final sender grant cannot transmit even if route hash remains unchanged',async()=>{
  const f=fixture();
  try{
    let grantChecks=0,networkAttempts=0;
    // The old consent epoch and correlation are deliberately reused here:
    // sender must pin the original authenticated chat, independently of a
    // weaker legacy route equality check inside event projection.
    const adapter=createAuthenticatedDeliveryTools({
      store:f.delivery,observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,authorizeDelivery:async()=>true
    });
    const sender=createDeliveryWebhookSender({
      projection:createDeliveryMcpEventProjection({authenticatedDelivery:adapter}),
      subscriptions:f.subscriptions,
      observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,
      authorizeSend:async()=>{
        if(++grantChecks===3){
          f.state.caller=B;
          f.state.binding={...B,correlationId:'alice-route',bindingId:EPOCH};
        }
        return true;
      },
      unsealSecret:async()=>secret,
      postVerifiedHttps:async()=>{networkAttempts++;return {status:202};},
      now:()=>f.state.time,sleep:async()=>{}
    });
    await assert.rejects(()=>sender.send({
      deliveryId:f.item.deliveryId,subscriptionId
    }),/DELIVERY_SEND_SESSION_CHANGED/);
    assert.equal(grantChecks>=3,true);
    assert.equal(networkAttempts,0);
    assert.equal(f.delivery.get(f.item.deliveryId,'alice-route').receiptId,null);
  }finally{f.close();}
});

test('DNS resolution revoked consent before HTTPS creation never opens a connection',async()=>{
  const f=fixture();
  try{
    let connects=0, lookups=0;
    const transport=createVerifiedWebhookHttpsTransport({
      resolveAddresses:async()=> {
        lookups++;
        f.state.grant=false; // Native consent expires while DNS is awaited.
        return [{address:'8.8.8.8',family:4}];
      },
      requestHttps:(_url,_options,callback)=>{
        connects++;
        const req=new EventEmitter();
        req.end=()=>{
          const response=new EventEmitter();
          response.statusCode=202;
          queueMicrotask(()=>{callback(response);response.emit('end');});
        };
        req.destroy=()=>{};
        return req;
      }
    });
    const sender=createDeliveryWebhookSender({
      projection:createDeliveryMcpEventProjection({
        authenticatedDelivery:createAuthenticatedDeliveryTools({
          store:f.delivery,observeCaller:async()=>f.state.caller,
          resolveBinding:async()=>f.state.binding,
          authorizeDelivery:async()=>true
        })
      }),
      subscriptions:f.subscriptions,
      observeCaller:async()=>f.state.caller,
      resolveBinding:async()=>f.state.binding,
      authorizeSend:async()=>f.state.grant,
      unsealSecret:async()=>secret,
      postVerifiedHttps:transport.postVerifiedHttps,
      now:()=>f.state.time,sleep:async()=>{}
    });
    await assert.rejects(()=>sender.send({
      deliveryId:f.item.deliveryId,subscriptionId
    }),/DELIVERY_SEND_GRANT_REQUIRED|DELIVERY_EGRESS_AUTHORIZATION_DENIED/);
    assert.equal(lookups,1);
    assert.equal(connects,0);
    assert.equal(f.delivery.get(f.item.deliveryId,'alice-route').receiptId,null);
  }finally{f.close();}
});
