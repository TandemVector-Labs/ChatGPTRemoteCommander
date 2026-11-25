import test from 'node:test';
const EPOCH='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import {createAuthenticatedMcpEventSubscriptions} from '../src/delivery-mcp-subscriptions.mjs';
import {DeliveryEventSubscriptionStore} from '../src/delivery-mcp-subscription-store.mjs';
import {DELIVERY_MCP_EVENT} from '../src/delivery-mcp-events.mjs';
const A={hostId:'host1',principalId:'alice',profileId:'profile1',conversationId:'chat-1'};
const scope='a'.repeat(64);
const secret='whsec_'+Buffer.alloc(32,42).toString('base64');
const url='https://events.example.net/callback';
const input={name:DELIVERY_MCP_EVENT,arguments:{},delivery:{mode:'webhook',url,secret}};
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v106-sub-int-'));
  const directory=path.join(root,'private');
  const nativeKey=randomBytes(32);
  let binding={...A,correlationId:'alice-route',bindingId:EPOCH},caller=A,approved=true;
  let store=new DeliveryEventSubscriptionStore({directory,profileScope:scope});
  const manager=()=>createAuthenticatedMcpEventSubscriptions({
    observeCaller:async()=>caller,resolveBinding:async()=>binding,
    authorizeSubscription:async()=>approved,
    verifyCallback:async challenge=>({verified:true,challenge:challenge.challenge}),
    sealSecret:async text=>{
      const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',nativeKey,iv);
      const ciphertext=Buffer.concat([c.update(text,'utf8'),c.final()]);
      return 'aesgcm:'+iv.toString('base64')+':'+c.getAuthTag().toString('base64')
        +':'+ciphertext.toString('base64');
    },
    secureStore:store,now:()=>Date.UTC(2026,10,6,1,0,0)
  });
  return {root,directory,nativeKey,get store(){return store;},get approved(){return approved;},
    set approved(v){approved=v;},manager,open(){
      store.close();store=new DeliveryEventSubscriptionStore({directory,profileScope:scope});
    },close(){store.close();fs.rmSync(root,{recursive:true,force:true});}};
}
test('real private subscription store survives restart with AES-GCM sealed secret and scoped unsubscribe',async()=>{
  const f=fixture();
  try{
    const result=await f.manager().subscribe(input);
    assert.equal(result.id.startsWith('sub_'),true);
    const db=fs.readFileSync(path.join(f.directory,'event-subscriptions.sqlite'));
    assert.equal(db.includes(Buffer.from(secret)),false,'raw signing key must not be persisted');
    f.open();
    const items=f.store.listActive({
      scope:await import('node:crypto').then(m=>m.createHash('sha256')
        .update(JSON.stringify(['host1','alice','profile1','chat-1'])).digest('hex')),
      bindingKey:await import('node:crypto').then(m=>m.createHash('sha256')
        .update(JSON.stringify(['alice-route',EPOCH])).digest('hex')),
      at:Date.UTC(2026,10,6,1,1,0)
    });
    assert.equal(items.length,1);
    const sealed=items[0].sealedSecret;
    const [,iv,tag,cipher]=sealed.split(':');
    const d=createDecipheriv('aes-256-gcm',f.nativeKey,Buffer.from(iv,'base64'));
    d.setAuthTag(Buffer.from(tag,'base64'));
    const unsealed=Buffer.concat([d.update(Buffer.from(cipher,'base64')),d.final()]).toString();
    assert.equal(unsealed,secret);
    await f.manager().unsubscribe({
      name:DELIVERY_MCP_EVENT,arguments:{},delivery:{mode:'webhook',url}
    });
    assert.equal(f.store.status().total,0);
  }finally{f.close();}
});
test('a denied owner cannot refresh an existing persisted subscription',async()=>{
  const f=fixture();
  try{
    const r=await f.manager().subscribe(input);
    f.approved=false;f.open();
    await assert.rejects(()=>f.manager().subscribe(input),/DELIVERY_EVENTS_SUBSCRIPTION_DENIED/);
    assert.equal(f.store.status().total,1);
    assert.equal(f.store.listActive({scope:'f'.repeat(64),bindingKey:'f'.repeat(64),
      at:Date.UTC(2026,10,6,1,0,1)}).length,0);
  }finally{f.close();}
});

test('two coordinators sharing SQLite cannot resurrect a removed subscription after delayed verification',async()=>{
  const f=fixture();
  const other=new DeliveryEventSubscriptionStore({
    directory:f.directory,profileScope:scope
  });
  let started,release;
  const verificationStarted=new Promise(resolve=>{started=resolve;});
  const verificationReleased=new Promise(resolve=>{release=resolve;});
  const createManager=(secureStore,slow=false)=>createAuthenticatedMcpEventSubscriptions({
    observeCaller:async()=>A,
    resolveBinding:async()=>({...A,correlationId:'alice-route',bindingId:EPOCH}),
    authorizeSubscription:async()=>true,
    verifyCallback:async q=>{
      if(slow){started();await verificationReleased;}
      return {verified:true,challenge:q.challenge};
    },
    sealSecret:async text=>{
      const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',f.nativeKey,iv);
      const sealed=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
      return 'aesgcm:'+iv.toString('base64')+':'+cipher.getAuthTag().toString('base64')
        +':'+sealed.toString('base64');
    },
    secureStore,now:()=>Date.UTC(2026,10,6,1,0,0)
  });
  try{
    await createManager(f.store).subscribe(input);
    const delayedSecret='whsec_'+Buffer.alloc(32,44).toString('base64');
    const delayedInput={...input,delivery:{mode:'webhook',url,secret:delayedSecret}};
    const registration=createManager(f.store,true).subscribe(delayedInput);
    await verificationStarted;
    await createManager(other).unsubscribe({
      name:DELIVERY_MCP_EVENT,arguments:{},
      delivery:{mode:'webhook',url}
    });
    assert.equal(other.status().total,0);
    release();
    await assert.rejects(registration,
      /DELIVERY_EVENTS_SUBSCRIPTION_SUPERSEDED|DELIVERY_SUBSCRIPTIONS_STALE_REGISTRATION/);
    const staleScope=createHash('sha256')
      .update(JSON.stringify(['host1','alice','profile1','chat-1'])).digest('hex');
    const staleCallbackHash=createHash('sha256').update(url).digest('hex');
    const staleSecretHash=createHash('sha256').update(delayedSecret).digest('hex');
    assert.equal(f.store.hasCallbackVerification({
      scope:staleScope,callbackHash:staleCallbackHash,secretHash:staleSecretHash,
      at:Date.UTC(2026,10,6,1,0,0)
    }),false,'a revoked in-flight registration must not cache its endpoint proof');
    assert.equal(f.store.status().total,0);
    assert.equal(other.status().total,0);
  }finally{release?.();other.close();f.close();}
});

test('fresh verified subscribe after an authenticated unsubscribe is accepted at new durable generation',async()=>{
  const f=fixture();
  try{
    const initial=await f.manager().subscribe(input);
    await f.manager().unsubscribe({
      name:DELIVERY_MCP_EVENT,arguments:{},delivery:{mode:'webhook',url}
    });
    assert.equal(f.store.status().total,0);
    f.open();
    const renewed=await f.manager().subscribe(input);
    assert.equal(renewed.id,initial.id);
    assert.equal(f.store.status().total,1);
    const again=await f.manager().subscribe(input);
    assert.deepEqual(again,renewed);
    assert.equal(f.store.status().total,1);
  }finally{f.close();}
});

test('callback verification is cached durably by owner, URL and secret with bounded expiry',async()=>{
  const f=fixture();
  let time=Date.UTC(2026,10,6,1,0,0),verifyCount=0;
  const ownerB={hostId:'host1',principalId:'bob',profileId:'profile1',conversationId:'chat-2'};
  const managerFor=(caller=A,correlationId='alice-route')=>createAuthenticatedMcpEventSubscriptions({
    observeCaller:async()=>caller,
    resolveBinding:async()=>({...caller,correlationId,bindingId:EPOCH}),
    authorizeSubscription:async()=>true,
    verifyCallback:async q=>{verifyCount++;return {verified:true,challenge:q.challenge};},
    sealSecret:async value=>'sealed:'+createHash('sha256').update(value).digest('hex'),
    secureStore:f.store,now:()=>time
  });
  try{
    const first=await managerFor().subscribe(input);
    assert.equal(verifyCount,1);
    await managerFor().subscribe(input);
    assert.equal(verifyCount,1,'refresh must reuse a fresh endpoint proof');
    f.open();
    await managerFor().subscribe(input);
    assert.equal(verifyCount,1,'callback proof must survive a store restart');

    const rotatedSecret='whsec_'+Buffer.alloc(32,43).toString('base64');
    await managerFor().subscribe({...input,delivery:{mode:'webhook',url,secret:rotatedSecret}});
    assert.equal(verifyCount,2,'secret rotation must require a new callback proof');

    const alternateUrl='https://events.example.net/alternate';
    await managerFor().subscribe({...input,delivery:{mode:'webhook',url:alternateUrl,secret}});
    assert.equal(verifyCount,3,'a different callback URL must require a new proof');

    await managerFor(ownerB,'bob-route').subscribe(input);
    assert.equal(verifyCount,4,'callback proof must not cross authenticated principals');

    time+=5*60*1000+1;
    await managerFor().subscribe(input);
    assert.equal(verifyCount,5,'expired callback proof must be challenged again');
    assert.equal(first.id.startsWith('sub_'),true);
  }finally{f.close();}
});

test('subscription schema v3 migrates to v4 without losing owner records or revocation fences',async()=>{
  const f=fixture();
  const ownerScope=createHash('sha256')
    .update(JSON.stringify(['host1','alice','profile1','chat-1'])).digest('hex');
  const bindingKey=createHash('sha256')
    .update(JSON.stringify(['alice-route',EPOCH])).digest('hex');
  const callbackHash=createHash('sha256').update(url).digest('hex');
  const secretHash=createHash('sha256').update(secret).digest('hex');
  try{
    const first=await f.manager().subscribe(input);
    assert.equal(f.store.status().total,1);
    assert.equal(f.store.hasCallbackVerification({
      scope:ownerScope,callbackHash,secretHash,at:Date.UTC(2026,10,6,1,0,0)
    }),true);
    f.store.close();
    const {DatabaseSync}=await import('node:sqlite');
    const legacy=new DatabaseSync(path.join(f.directory,'event-subscriptions.sqlite'));
    legacy.exec('DROP TABLE callback_verifications; PRAGMA user_version=3;');
    legacy.close();
    f.open();
    assert.equal(f.store.status().total,1);
    assert.ok(f.store.getActive({
      id:first.id,scope:ownerScope,bindingKey,at:Date.UTC(2026,10,6,1,0,1)
    }));
    assert.equal(f.store.hasCallbackVerification({
      scope:ownerScope,callbackHash,secretHash,at:Date.UTC(2026,10,6,1,0,1)
    }),false,'v3 has no callback-proof cache; migration must not invent one');
    const refreshed=await f.manager().subscribe(input);
    assert.deepEqual(refreshed,first);
    assert.equal(f.store.hasCallbackVerification({
      scope:ownerScope,callbackHash,secretHash,at:Date.UTC(2026,10,6,1,0,1)
    }),true);
    const migrated=new DatabaseSync(path.join(f.directory,'event-subscriptions.sqlite'));
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version,4);
    migrated.close();
  }finally{f.close();}
});
