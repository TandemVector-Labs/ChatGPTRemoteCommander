import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DeliveryStore} from '../src/delivery-store.mjs';
import {readDeliveryHealth} from '../tools/delivery-health-readonly.mjs';
const sha='a'.repeat(40);
const linuxOnly={skip:process.platform!=='linux'};
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-delivery-health-ro-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const profile='default',scope='private-test';
  const dir=path.join(root,'delivery',scope);
  fs.mkdirSync(path.join(root,'routing'),{recursive:true});
  fs.mkdirSync(path.join(root,'runtimes','current'),{recursive:true});
  const configPath=path.join(root,'runtimes','current','config.json');
  fs.writeFileSync(configPath,JSON.stringify({instance:{profile},durableDelivery:{directory:dir,scope}}),{mode:0o600});
  fs.writeFileSync(path.join(root,'routing','default.json'),JSON.stringify({
    schema:1,profile,active:{commit:sha,configPath},previous:null
  }),{mode:0o600});
  const store=new DeliveryStore({directory:dir,scope});
  store.publish({eventKey:'operation:secret-a',correlationId:'secret-chat-id',source:'operation',sourceId:'secret-a',kind:'COMPLETED'});
  store.publish({eventKey:'project:secret-b',correlationId:'secret-project',source:'project',sourceId:'secret-b',kind:'FAILED'});
  store.close();
  return {root,dir,configPath,profile,scope,params:{stateRoot:root,profile,expectedActiveCommit:sha}};
}
function shaFile(p){return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}
test('read-only report is aggregate and never changes database contents',linuxOnly,t=>{
  const f=fixture(t),db=path.join(f.dir,'delivery.sqlite');
  const before=shaFile(db);
  const r=readDeliveryHealth({...f.params,now:Date.now()});
  assert.equal(r.status,'READ_ONLY_AGGREGATE');
  assert.equal(r.counts.COMPLETED_UNDELIVERED,2);
  assert.equal(r.pending,2);
  assert.deepEqual(r.pendingBySource,{operation:1,project:1});
  assert.deepEqual(r.pendingByKind,{COMPLETED:1,FAILED:1});
  assert.equal(r.pendingNeverClaimed,2);
  assert.equal(r.strictTransportReclassificationEligible,0);
  assert.equal(r.identityBoundary,'TRUSTED_PROFILE_NOT_AUTHENTICATED_CHAT');
  assert.equal(r.mutationPerformed,false);
  assert.equal(shaFile(db),before);
  const serialized=JSON.stringify(r);
  for(const secret of ['secret-chat-id','secret-project','private-test','secret-a','secret-b','delivery.sqlite'])
    assert.equal(serialized.includes(secret),false,secret);
});
test('fail closed on expected active commit and route rollback drift',linuxOnly,t=>{
  const f=fixture(t);
  assert.throws(()=>readDeliveryHealth({...f.params,expectedActiveCommit:'b'.repeat(40)}),/DELIVERY_HEALTH_ROUTE_DRIFT/);
  const p=path.join(f.root,'routing','default.json'),r=JSON.parse(fs.readFileSync(p));
  r.previous={commit:'b'.repeat(40)};
  fs.writeFileSync(p,JSON.stringify(r));
  assert.throws(()=>readDeliveryHealth(f.params),/DELIVERY_HEALTH_ROUTE_DRIFT/);
});
test('reject missing database and any symlink substitute',linuxOnly,t=>{
  const f=fixture(t),db=path.join(f.dir,'delivery.sqlite'),other=db+'.private';
  fs.renameSync(db,other);
  assert.throws(()=>readDeliveryHealth(f.params),/ENOENT/);
  fs.symlinkSync(other,db);
  assert.throws(()=>readDeliveryHealth(f.params),/DELIVERY_HEALTH_FILE_INVALID/);
});
test('reject database visible to other users',linuxOnly,t=>{
  const f=fixture(t),db=path.join(f.dir,'delivery.sqlite');
  fs.chmodSync(db,0o644);
  assert.throws(()=>readDeliveryHealth(f.params),/DELIVERY_HEALTH_DB_PERMISSIONS/);
});
test('CLI accepts no raw-output or mutating options',linuxOnly,t=>{
  const f=fixture(t);
  const tool=path.join(process.cwd(),'tools','delivery-health-readonly.mjs');
  const args=['--state-root',f.root,'--profile','default','--expected-active-commit',sha];
  const valid=spawnSync(process.execPath,[tool,...args],{encoding:'utf8'});
  assert.equal(valid.status,0,valid.stderr);
  assert.equal(JSON.parse(valid.stdout).pending,2);
  const bad=spawnSync(process.execPath,[tool,...args,'--ack','all'],{encoding:'utf8'});
  assert.notEqual(bad.status,0);
});

test('reject arbitrary external database directory, even with matching scope',linuxOnly,t=>{
 const f=fixture(t);
 const p=f.configPath,c=JSON.parse(fs.readFileSync(p));
 c.durableDelivery.directory=path.join(os.tmpdir(),'not-a-trusted-delivery-root','private-test');
 fs.writeFileSync(p,JSON.stringify(c));
 assert.throws(()=>readDeliveryHealth(f.params),/DELIVERY_HEALTH_OUTSIDE_TRUSTED_DELIVERY_ROOT/);
});

test('CLI never prints private paths even when database is unavailable',linuxOnly,t=>{
 const f=fixture(t),db=path.join(f.dir,'delivery.sqlite');
 fs.unlinkSync(db);
 const tool=path.join(process.cwd(),'tools','delivery-health-readonly.mjs');
 const args=['--state-root',f.root,'--profile','default','--expected-active-commit',sha];
 const r=spawnSync(process.execPath,[tool,...args],{encoding:'utf8'});
 assert.notEqual(r.status,0);
 assert.match(r.stderr,/DELIVERY_HEALTH_FAILED/);
 assert.equal(r.stderr.includes(f.root),false);
 assert.equal(r.stdout,'');
});
test('reject symlinked configuration ancestry outside state root',linuxOnly,t=>{
 const f=fixture(t),real=path.join(f.root,'runtimes','current'),linked=path.join(f.root,'linked');
 fs.symlinkSync(real,linked);
 const router=path.join(f.root,'routing','default.json'),doc=JSON.parse(fs.readFileSync(router));
 doc.active.configPath=path.join(linked,'config.json');
 fs.writeFileSync(router,JSON.stringify(doc));
 assert.throws(()=>readDeliveryHealth(f.params),/DELIVERY_HEALTH_LINKED_METADATA/);
});

test('non-Linux delivery snapshot fails closed without pretending POSIX mode is an ACL',
 {skip:process.platform==='linux'},()=>{
   assert.throws(()=>readDeliveryHealth({
     stateRoot:'not-authorized',profile:'default',expectedActiveCommit:sha
   }),/DELIVERY_HEALTH_LINUX_ONLY/);
 });

test('reject state-relative delivery directory with symlinked parent escaping private root',
 linuxOnly,t=>{
  const f=fixture(t),link=path.join(f.root,'redirected'),c=JSON.parse(fs.readFileSync(f.configPath));
  fs.symlinkSync(path.dirname(f.dir),link);
  c.durableDelivery.directory=path.join(link,path.basename(f.dir));
  fs.writeFileSync(f.configPath,JSON.stringify(c));
  assert.throws(()=>readDeliveryHealth(f.params),/DELIVERY_HEALTH_LINKED_STORAGE/);
});
