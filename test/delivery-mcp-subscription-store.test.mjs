import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {DeliveryEventSubscriptionStore} from '../src/delivery-mcp-subscription-store.mjs';

const profile='a'.repeat(64),scope='b'.repeat(64),binding='c'.repeat(64),id='sub_'+'d'.repeat(64);
const date1='2026-11-06T02:00:00.000Z';
const date2='2026-11-06T03:00:00.000Z';
const record=()=>({id,scope,bindingKey:binding,name:'commander.delivery.ready',
  callbackUrl:'https://events.example.com/cb',sealedSecret:'host-encrypted:v1',
  refreshBefore:date2,verifiedAt:date1});
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v106-subs-store-'));
  const directory=path.join(root,'state');
  const open=(profileScope=profile)=>new DeliveryEventSubscriptionStore({directory,profileScope});
  return {root,directory,open,dispose(){fs.rmSync(root,{recursive:true,force:true});}};
}
test('persists encrypted-only subscriptions across restart with scoped retrieval',()=>{
  const f=fixture();
  try{
    let store=f.open();
    assert.deepEqual(store.upsert(record()),{id,stored:true});
    assert.equal(store.status().total,1);
    store.close();
    store=f.open();
    const items=store.listActive({scope,bindingKey:binding,at:Date.parse(date1)});
    assert.equal(items.length,1);
    assert.equal(items[0].sealedSecret,'host-encrypted:v1');
    assert.equal(items[0].callbackUrl,'https://events.example.com/cb');
    assert.equal(items[0].refreshBefore,date2);
    const bytes=fs.readFileSync(path.join(f.directory,'event-subscriptions.sqlite'));
    assert.equal(bytes.includes(Buffer.from('whsec_')),false);
    store.close();
  }finally{f.dispose();}
});
test('refresh updates the same subscription without duplication',()=>{
  const f=fixture(),store=f.open();
  try{
    store.upsert(record());
    store.upsert({...record(),refreshBefore:'2026-11-06T06:00:00.000Z',
      sealedSecret:'host-encrypted:rotated'});
    assert.equal(store.status().total,1);
    const item=store.listActive({scope,bindingKey:binding,at:Date.parse(date1)})[0];
    assert.equal(item.sealedSecret,'host-encrypted:rotated');
  }finally{store.close();f.dispose();}
});
test('records are strictly isolated by host profile and authenticated owner binding',()=>{
  const f=fixture(),one=f.open();
  try{
    one.upsert(record());
    assert.equal(one.listActive({scope,bindingKey:'f'.repeat(64),at:Date.parse(date1)}).length,0);
    assert.equal(one.listActive({scope:'e'.repeat(64),bindingKey:binding,at:Date.parse(date1)}).length,0);
    const two=f.open('9'.repeat(64));
    assert.equal(two.listActive({scope,bindingKey:binding,at:Date.parse(date1)}).length,0);
    assert.equal(two.status().total,0);
    two.close();
    assert.equal(one.status().total,1);
  }finally{one.close();f.dispose();}
});
test('expired subscriptions do not become active or signable after a restart',()=>{
  const f=fixture(),a=f.open();
  try{
    a.upsert(record());a.close();
    const store=f.open();
    assert.equal(store.listActive({scope,bindingKey:binding,at:Date.parse(date2)}).length,0);
    assert.equal(store.status().total,1);
    store.close();
  }finally{f.dispose();}
});
test('unsubscribe is identity-scoped and idempotent',()=>{
  const f=fixture(),store=f.open();
  try{
    store.upsert(record());
    assert.deepEqual(store.remove({id,scope:'f'.repeat(64),bindingKey:binding}),{deleted:false});
    assert.equal(store.status().total,1);
    assert.deepEqual(store.remove({id,scope,bindingKey:binding}),{deleted:true});
    assert.deepEqual(store.remove({id,scope,bindingKey:binding}),{deleted:false});
    assert.equal(store.status().total,0);
  }finally{store.close();f.dispose();}
});
test('id cannot be reassigned to a different conversation or callback',()=>{
  const f=fixture(),store=f.open();
  try{
    store.upsert(record());
    assert.throws(()=>store.upsert({...record(),scope:'e'.repeat(64)}),
      /DELIVERY_SUBSCRIPTIONS_ID_CONFLICT/);
    assert.throws(()=>store.upsert({...record(),callbackUrl:'https://attacker.example.net/cb'}),
      /DELIVERY_SUBSCRIPTIONS_ID_CONFLICT/);
    assert.equal(store.status().total,1);
  }finally{store.close();f.dispose();}
});
test('private store refuses invalid identifiers and plain signing secrets',()=>{
  const f=fixture(),store=f.open();
  try{
    assert.throws(()=>store.upsert({...record(),sealedSecret:'whsec_'+Buffer.alloc(32).toString('base64')}),
      /DELIVERY_SUBSCRIPTIONS_RECORD_INVALID/);
    assert.throws(()=>store.remove({id:'sub_bad',scope,bindingKey:binding}),
      /DELIVERY_SUBSCRIPTIONS_KEY_INVALID/);
    assert.throws(()=>store.listActive({scope,bindingKey:binding,limit:200}),
      /DELIVERY_SUBSCRIPTIONS_QUERY_INVALID/);
    assert.equal(store.status().total,0);
  }finally{store.close();f.dispose();}
});
test('hardlinked subscription database is rejected on reopen',()=>{
  const f=fixture(),store=f.open();
  try{
    store.upsert(record());store.close();
    const target=path.join(f.directory,'event-subscriptions.sqlite');
    fs.linkSync(target,path.join(f.directory,'alias.sqlite'));
    assert.throws(()=>f.open(),/DELIVERY_SUBSCRIPTIONS_ALIAS/);
  }finally{f.dispose();}
});
test('unknown future schema refuses downgrade',()=>{
  const f=fixture(),store=f.open();
  try{
    store.db.exec('PRAGMA user_version=5');
    store.close();
    assert.throws(()=>f.open(),/DELIVERY_SUBSCRIPTIONS_SCHEMA_TOO_NEW/);
  }finally{f.dispose();}
});

test('rotating an encrypted webhook key preserves the prior key for at most five minutes',()=>{
  const f=fixture(),store=f.open();
  try{
    store.upsert(record());
    store.upsert({...record(),refreshBefore:'2026-11-06T06:00:00.000Z',
      sealedSecret:'host-encrypted:new'});
    let active=store.listActive({scope,bindingKey:binding,at:Date.parse(date1)})[0];
    assert.equal(active.sealedSecret,'host-encrypted:new');
    assert.equal(active.previousSealedSecret,'host-encrypted:v1');
    assert.equal(active.previousUntil,'2026-11-06T02:05:00.000Z');
    store.close();
    const reopened=f.open();
    active=reopened.listActive({scope,bindingKey:binding,
      at:Date.parse('2026-11-06T02:04:59.000Z')})[0];
    assert.equal(active.previousSealedSecret,'host-encrypted:v1');
    active=reopened.listActive({scope,bindingKey:binding,
      at:Date.parse('2026-11-06T02:05:00.000Z')})[0];
    assert.equal(active.previousSealedSecret,null);
    assert.equal(active.previousUntil,null);
    assert.equal(active.sealedSecret,'host-encrypted:new');
    reopened.close();
  }finally{f.dispose();}
});
test('same-key refresh does not enlarge prior-key rotation window',()=>{
  const f=fixture(),store=f.open();
  try{
    store.upsert(record());
    store.upsert({...record(),sealedSecret:'host-encrypted:new',
      refreshBefore:'2026-11-06T06:00:00.000Z'});
    store.upsert({...record(),sealedSecret:'host-encrypted:new',
      verifiedAt:'2026-11-06T02:02:00.000Z',
      refreshBefore:'2026-11-06T06:00:00.000Z'});
    const row=store.listActive({scope,bindingKey:binding,
      at:Date.parse('2026-11-06T02:04:59.000Z')})[0];
    assert.equal(row.previousUntil,'2026-11-06T02:05:00.000Z');
    assert.throws(()=>store.upsert({...record(),
      verifiedAt:'2026-11-05T23:59:00.000Z'}),
      /DELIVERY_SUBSCRIPTIONS_STALE_REFRESH/);
  }finally{store.close();f.dispose();}
});
test('opens an existing schema-v1 store and upgrades without losing owner or encrypted secret',()=>{
  const f=fixture();
  try{
    fs.mkdirSync(f.directory,{recursive:true});
    const sqlitePath=path.join(f.directory,'event-subscriptions.sqlite');
    const oldDb=new DatabaseSync(sqlitePath);
    oldDb.exec(`CREATE TABLE subscriptions(
      profile_scope TEXT NOT NULL,id TEXT NOT NULL,owner_scope TEXT NOT NULL,
      binding_key TEXT NOT NULL,name TEXT NOT NULL,callback_url TEXT NOT NULL,
      sealed_secret TEXT NOT NULL,refresh_before TEXT NOT NULL,
      verified_at TEXT NOT NULL,PRIMARY KEY(profile_scope,id));
      PRAGMA user_version=1;`);
    oldDb.prepare(`INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(profile,id,scope,binding,'commander.delivery.ready',
        'https://events.example.com/cb','host-encrypted:v1',date2,date1);
    oldDb.close();
    const store=f.open();
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,4);
    const rows=store.listActive({scope,bindingKey:binding,at:Date.parse(date1)});
    assert.equal(rows.length,1);
    assert.equal(rows[0].sealedSecret,'host-encrypted:v1');
    assert.equal(rows[0].previousSealedSecret,null);
    store.close();
  }finally{f.dispose();}
});

test('exact subscription lookup does not truncate after 100 active owner-matched records',()=>{
  const f=fixture(),store=f.open();
  try{
    for(let i=0;i<120;i++){
      const rowId='sub_'+i.toString(16).padStart(64,'0');
      store.upsert({...record(),id:rowId,sealedSecret:'host-encrypted:'+i});
    }
    store.upsert(record());
    assert.equal(store.listActive({scope,bindingKey:binding,at:Date.parse(date1),limit:100}).length,100);
    const found=store.getActive({id,scope,bindingKey:binding,at:Date.parse(date1)});
    assert.equal(found.id,id);
    assert.equal(found.sealedSecret,'host-encrypted:v1');
    assert.equal(store.getActive({id,scope:'e'.repeat(64),bindingKey:binding,at:Date.parse(date1)}),null);
    assert.equal(store.getActive({id,scope,bindingKey:'f'.repeat(64),at:Date.parse(date1)}),null);
    assert.equal(store.getActive({id,scope,bindingKey:binding,at:Date.parse(date2)}),null);
  }finally{store.close();f.dispose();}
});

test('concurrent refresh never lets an older verified timestamp overwrite a newer writer',()=>{
  const f=fixture();
  let primary,secondary;
  try{
    primary=f.open();
    secondary=f.open();
    primary.upsert(record());
    const originalPrepare=primary.db.prepare.bind(primary.db);
    let raced=false,otherWriteSucceeded=false;
    primary.db.prepare=function(sql){
      const statement=originalPrepare(sql);
      if(!raced&&sql.includes('SELECT * FROM subscriptions WHERE profile_scope=? AND id=?')){
        return {
          get(...args){
            const observed=statement.get(...args);
            raced=true;
            try{
              secondary.upsert({...record(),sealedSecret:'host-encrypted:newest',
                verifiedAt:'2026-11-06T02:04:00.000Z',
                refreshBefore:'2026-11-06T06:00:00.000Z'});
              otherWriteSucceeded=true;
            }catch(error){
              assert.match(String(error.message??error),/SQLITE_BUSY|database is locked/i);
            }
            return observed;
          }
        };
      }
      return statement;
    };
    primary.upsert({...record(),sealedSecret:'host-encrypted:older',
      verifiedAt:'2026-11-06T02:02:00.000Z',
      refreshBefore:'2026-11-06T05:00:00.000Z'});
    assert.equal(raced,true);
    if(otherWriteSucceeded){
      const row=secondary.getActive({id,scope,bindingKey:binding,
        at:Date.parse('2026-11-06T02:05:00.000Z')});
      assert.equal(row.sealedSecret,'host-encrypted:newest');
    }else{
      secondary.upsert({...record(),sealedSecret:'host-encrypted:newest',
        verifiedAt:'2026-11-06T02:04:00.000Z',
        refreshBefore:'2026-11-06T06:00:00.000Z'});
      const row=secondary.getActive({id,scope,bindingKey:binding,
        at:Date.parse('2026-11-06T02:05:00.000Z')});
      assert.equal(row.sealedSecret,'host-encrypted:newest');
    }
    assert.equal(secondary.status().total,1);
  }finally{
    try{primary?.close();}catch{}
    try{secondary?.close();}catch{}
    f.dispose();
  }
});

test('durable revocation generation blocks stale registration across reopen and separate owners',()=>{
  const f=fixture(),primary=f.open(),other=f.open();
  try{
    const req={id,scope,bindingKey:binding};
    assert.equal(primary.registrationGeneration(req),0);
    assert.deepEqual(primary.upsert({...record(),expectedGeneration:0}),{id,stored:true});
    assert.equal(primary.remove({...req,scope:'e'.repeat(64)}).deleted,false);
    assert.equal(primary.registrationGeneration(req),0);
    assert.deepEqual(other.remove(req),{deleted:true});
    assert.equal(primary.registrationGeneration(req),1);
    assert.throws(
      ()=>primary.upsert({...record(),expectedGeneration:0}),
      /DELIVERY_SUBSCRIPTIONS_STALE_REGISTRATION/
    );
    assert.equal(primary.getActive({...req,at:Date.parse(date1)}),null);
    other.close();
    const reopened=f.open();
    assert.equal(reopened.registrationGeneration(req),1);
    assert.deepEqual(reopened.upsert({...record(),expectedGeneration:1}),{id,stored:true});
    assert.equal(primary.getActive({...req,at:Date.parse(date1)})?.sealedSecret,'host-encrypted:v1');
    reopened.close();
  }finally{
    primary.close();
    try{other.close();}catch{}
    f.dispose();
  }
});
test('schema-v2 migration retains rotation metadata and adds durable cancellation fences',()=>{
  const f=fixture();
  try{
    fs.mkdirSync(f.directory,{recursive:true});
    const db=new DatabaseSync(path.join(f.directory,'event-subscriptions.sqlite'));
    db.exec(`CREATE TABLE subscriptions(
      profile_scope TEXT NOT NULL,id TEXT NOT NULL,owner_scope TEXT NOT NULL,
      binding_key TEXT NOT NULL,name TEXT NOT NULL,callback_url TEXT NOT NULL,
      sealed_secret TEXT NOT NULL,refresh_before TEXT NOT NULL,
      verified_at TEXT NOT NULL,previous_sealed_secret TEXT,previous_until TEXT,
      PRIMARY KEY(profile_scope,id));
      PRAGMA user_version=2;`);
    db.prepare('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
      profile,id,scope,binding,'commander.delivery.ready',
      'https://events.example.com/cb','host-encrypted:rotated',date2,date1,
      'host-encrypted:previous','2026-11-06T02:05:00.000Z'
    );
    db.close();
    const store=f.open();
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,4);
    const row=store.getActive({id,scope,bindingKey:binding,at:Date.parse(date1)});
    assert.equal(row.sealedSecret,'host-encrypted:rotated');
    assert.equal(row.previousSealedSecret,'host-encrypted:previous');
    assert.equal(store.registrationGeneration({id,scope,bindingKey:binding}),0);
    store.close();
  }finally{f.dispose();}
});
