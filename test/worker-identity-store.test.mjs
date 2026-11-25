import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WorkflowStore } from '../src/workflow-store.mjs';
import { createWorkflowStoreWorkerIdentityRegistry } from '../src/worker-identity-store.mjs';
import { createWorkerIdentityAuthority, deriveWorkerId } from '../src/worker-identity-authority.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const DOMAIN = 'commander.worker.identity.v1';
const CLAIMS = [
  'issuer','audience','hostId','profileId','principalId','conversationId',
  'bindingId','workerId','ownerSidHash','deviceProvider','deviceIdHash',
  'tunnelProvider','tunnelIdHash','capabilityPolicyDigest','grantRevision',
  'issuedAtMs','expiresAtMs','nonce'
];
const A='a'.repeat(64), B='b'.repeat(64), C='c'.repeat(64), D='d'.repeat(64);
const bindingA='1'.repeat(32), bindingB='2'.repeat(32);
const pair=()=>generateKeyPairSync('ed25519');

function fixture({profileId='emad',sharedRoot=null}={}) {
  const root = sharedRoot ?? fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-worker-identity-')));
  const options = {
    directory:path.join(root,'profile-'+profileId),
    rootLeaseDirectory:path.join(root,'shared','root-leases'),
    allowedRoots:[root], device:'worker-identity-test',
    configSha256:'1'.repeat(64), authority:{profileId}
  };
  const store = new WorkflowStore(options);
  return {
    root, options, store, registry:createWorkflowStoreWorkerIdentityRegistry(store),
    reopen() {
      store.close();
      const next = new WorkflowStore(options);
      return {store:next,registry:createWorkflowStoreWorkerIdentityRegistry(next)};
    },
    dispose() {
      try { store.close(); } catch {}
      fs.rmSync(root,{recursive:true,force:true});
    }
  };
}

function signedEnvelope(keys=pair(), bindingId=bindingA, ttlMs=120_000) {
  const publicDer=keys.publicKey.export({type:'spki',format:'der'});
  const keyId=sha(publicDer);
  const hostId='host-1', profileId='emad', ownerSidHash=B;
  const deviceProvider='native-key-store', deviceIdHash=A;
  const workerId=deriveWorkerId({hostId,profileId,ownerSidHash,deviceProvider,deviceIdHash,keyId});
  const now=Date.now();
  const claims={
    issuer:'commander.local',audience:'remote-commander',hostId,profileId,
    principalId:'owner-1',conversationId:'chat-1',bindingId,workerId,
    ownerSidHash,deviceProvider,deviceIdHash,
    tunnelProvider:'openai-secure-mcp-tunnel',tunnelIdHash:C,
    capabilityPolicyDigest:D,grantRevision:1,issuedAtMs:now-1,expiresAtMs:now+ttlMs,
    nonce:randomBytes(16).toString('hex')
  };
  const signedBytes=Buffer.from(JSON.stringify([DOMAIN,keyId,...CLAIMS.map(k=>claims[k])]),'utf8');
  const envelope={
    schema:1,keyId,publicKey:publicDer.toString('base64url'),claims,
    signature:sign(null,signedBytes,keys.privateKey).toString('base64url')
  };
  return {keys,envelope,workerId};
}

function authorityFor(store,state) {
  const registry=createWorkflowStoreWorkerIdentityRegistry(store);
  return createWorkerIdentityAuthority({
    hostId:'host-1',profileId:'emad',issuer:'commander.local',audience:'remote-commander',
    resolveDeviceIdentity:async()=>({
      source:'native-device-attestor',provider:'native-key-store',deviceIdHash:A,
      ownerSidHash:B,verified:true,attestedAtMs:state.now-1000,expiresAtMs:state.now+300000
    }),
    resolveTransportIdentity:async()=>({
      source:'native-tunnel-attestor',provider:'openai-secure-mcp-tunnel',
      profileId:'emad',tunnelIdHash:C,ownerSidHash:B,authenticated:true,
      controlPlanePollOk:true,healthzStatus:200,readyzStatus:200,
      lastPollAtMs:state.now-1000,expiresAtMs:state.now+60000
    }),
    resolveOwnerContext:async()=>({
      source:'native-owner-attested',hostId:'host-1',profileId:'emad',
      principalId:'owner-1',conversationId:'chat-1',bindingId:state.bindingId,
      ownerSidHash:B,expiresAtMs:state.now+120000
    }),
    resolveOwnerGrant:async request=>({
      source:'native-owner-attested',hostId:request.hostId,profileId:request.profileId,
      principalId:request.principalId,conversationId:request.conversationId,
      bindingId:request.bindingId,workerId:request.workerId,keyId:request.keyId,
      ownerSidHash:request.ownerSidHash,deviceProvider:request.deviceProvider,
      deviceIdHash:request.deviceIdHash,tunnelProvider:request.tunnelProvider,
      tunnelIdHash:request.tunnelIdHash,capabilityPolicyDigest:state.policyDigest,
      revision:state.grantRevision??1,
      issuedAtMs:state.now-1000,expiresAtMs:state.now+120000,status:'ACTIVE'
    }),
    resolveCapabilityPolicyDigest:async()=>state.policyDigest,
    authorizeExactInvocation:async(_route,invocation)=>state.allowedTools.has(invocation.tool),
    registry,now:()=>state.now
  });
}

function registerInSeparateProcess(root,profileId,envelope) {
  const script=fileURLToPath(new URL('./worker-identity-store-worker.mjs',import.meta.url));
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script],{
      cwd:process.cwd(),windowsHide:true,stdio:['pipe','pipe','pipe']
    });
    let stdout='',stderr='',settled=false;
    const failOnce=error=>{if(settled)return;settled=true;reject(error);};
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('error',failOnce);
    child.once('close',(code,signal)=>{
      if(settled)return;
      if(code!==0){failOnce(new Error('WORKER_IDENTITY_CHILD_FAILED:'+String(code)+':'+String(signal)+':'+stderr));return;}
      try{settled=true;resolve(JSON.parse(stdout));}
      catch(error){failOnce(new Error('WORKER_IDENTITY_CHILD_RESULT_INVALID:'+error.message+':'+stderr));}
    });
    child.stdin.end(JSON.stringify({root,profileId,envelope}));
  });
}

test('WorkflowStore-backed worker registry persists signed public identity in the shared root-lease database',()=>{
  const f=fixture();
  try {
    const item=signedEnvelope();
    assert.equal(f.registry.get(item.workerId),null);
    assert.equal(f.registry.register(item.envelope,{expectedPreviousBindingId:null,expectedPreviousState:'EMPTY'}),true);
    assert.deepEqual(f.registry.get(item.workerId),item.envelope);
    assert.equal(f.registry.isRevoked(item.workerId,bindingA),false);
    const status=f.store.workerIdentityJournalStatus();
    assert.equal(status.eventCount,1);
    assert.equal(status.registrations,1);
    const dbPath=path.join(f.root,'shared','root-leases','root-leases.sqlite');
    assert.ok(fs.existsSync(dbPath));
    const db=new DatabaseSync(dbPath,{readOnly:true});
    try {
      const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
      assert.ok(names.includes('root_leases'));
      assert.ok(names.includes('worker_identity_events'));
      assert.ok(names.includes('worker_identity_registry'));
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM worker_identity_events').get().n,1);
    } finally { db.close(); }
    const privateDer=item.keys.privateKey.export({type:'pkcs8',format:'der'});
    assert.equal(fs.readFileSync(dbPath).includes(privateDer),false);
    const reopened=f.reopen();
    try {
      assert.deepEqual(reopened.registry.get(item.workerId),item.envelope);
      assert.equal(reopened.store.workerIdentityJournalStatus().eventCount,1);
    } finally { reopened.store.close(); }
  } finally { f.dispose(); }
});

test('machine-global registry is shared by separate WorkflowStore profiles',()=>{
  const f=fixture({profileId:'emad'});
  let second;
  try {
    const item=signedEnvelope();
    assert.equal(f.registry.register(item.envelope,{expectedPreviousBindingId:null,expectedPreviousState:'EMPTY'}),true);
    const secondOptions={
      ...f.options,directory:path.join(f.root,'profile-saeed'),
      authority:{profileId:'saeed'}
    };
    second=new WorkflowStore(secondOptions);
    const registry=createWorkflowStoreWorkerIdentityRegistry(second);
    assert.deepEqual(registry.get(item.workerId),item.envelope);
  } finally { try{second?.close();}catch{} f.dispose(); }
});

test('registration CAS rejects active overwrite and allows only a new binding after revocation',()=>{
  const f=fixture();
  try {
    const first=signedEnvelope();
    const second=signedEnvelope(first.keys,bindingB);
    assert.equal(f.registry.register(first.envelope,{expectedPreviousBindingId:null,expectedPreviousState:'EMPTY'}),true);
    assert.equal(f.registry.register(second.envelope,{expectedPreviousBindingId:null,expectedPreviousState:'EMPTY'}),false);
    const receipt={revocationId:'00000000-0000-4000-8000-000000000000',revokedAtMs:Date.now(),reasonCode:'owner-revoked'};
    assert.equal(f.registry.revoke(first.workerId,bindingA,receipt,{expectedSignature:'A'.repeat(86)}),false);
    assert.equal(f.registry.revoke(first.workerId,bindingA,receipt,{expectedSignature:first.envelope.signature}),true);
    assert.equal(f.registry.isRevoked(first.workerId,bindingA),true);
    assert.equal(f.registry.register(second.envelope,{expectedPreviousBindingId:bindingA,expectedPreviousState:'REVOKED'}),true);
    assert.equal(f.registry.isRevoked(first.workerId,bindingB),false);
    assert.equal(f.registry.get(first.workerId).claims.bindingId,bindingB);
    assert.equal(f.store.workerIdentityJournalStatus().eventCount,3);
  } finally { f.dispose(); }
});

test('expired registration can be replaced only with a different binding epoch',async()=>{
  const f=fixture();
  try {
    const first=signedEnvelope(pair(),bindingA,20);
    const second=signedEnvelope(first.keys,bindingB,120_000);
    assert.equal(f.registry.register(first.envelope,{expectedPreviousBindingId:null,expectedPreviousState:'EMPTY'}),true);
    await new Promise(resolve=>setTimeout(resolve,35));
    assert.equal(f.registry.register(second.envelope,{expectedPreviousBindingId:bindingA,expectedPreviousState:'EXPIRED'}),true);
    assert.equal(f.registry.get(first.workerId).claims.bindingId,bindingB);
    assert.equal(f.store.workerIdentityJournalStatus().eventCount,2);
  } finally { f.dispose(); }
});

test('durable registry verifies Ed25519 signature and key-derived worker identity before first write',()=>{
  const f=fixture();
  try {
    const item=signedEnvelope();
    const badSignature=structuredClone(item.envelope);
    badSignature.signature=Buffer.alloc(64,0).toString('base64url');
    assert.throws(()=>f.registry.register(badSignature,{expectedPreviousBindingId:null,expectedPreviousState:'EMPTY'}),/WORKER_IDENTITY_SIGNATURE_INVALID/);
    const badWorker=structuredClone(item.envelope);
    badWorker.claims.workerId='cw_'+'f'.repeat(64);
    assert.throws(()=>f.registry.register(badWorker,{expectedPreviousBindingId:null,expectedPreviousState:'EMPTY'}),/WORKER_IDENTITY_CLAIMS_INVALID/);
    assert.equal(f.store.workerIdentityJournalStatus().eventCount,0);
  } finally { f.dispose(); }
});

test('durable registry rejects proxy and accessor-backed envelopes, options and receipts without invoking getters',()=>{
  const f=fixture();
  try{
    const item=signedEnvelope();
    let getterCalls=0;
    const accessorEnvelope={};
    for(const key of Object.keys(item.envelope)){
      Object.defineProperty(accessorEnvelope,key,{
        enumerable:true,get(){getterCalls++;return item.envelope[key];}
      });
    }
    const expected={expectedPreviousBindingId:null,expectedPreviousState:'EMPTY'};
    assert.throws(()=>f.registry.register(accessorEnvelope,expected),/WORKER_IDENTITY_ENVELOPE_INVALID/);
    assert.equal(getterCalls,0);
    assert.throws(()=>f.registry.register(new Proxy(item.envelope,{}),expected),/WORKER_IDENTITY_ENVELOPE_INVALID/);
    const accessorOptions={};
    Object.defineProperty(accessorOptions,'expectedPreviousState',{
      enumerable:true,get(){getterCalls++;return 'EMPTY';}
    });
    assert.throws(()=>f.registry.register(item.envelope,accessorOptions),/WORKER_IDENTITY_REGISTRY_CAS_INVALID/);
    assert.equal(getterCalls,0);
    assert.equal(f.registry.register(item.envelope,expected),true);
    const receipt={};
    Object.defineProperty(receipt,'reasonCode',{
      enumerable:true,get(){getterCalls++;return 'owner-revoked';}
    });
    Object.defineProperty(receipt,'revocationId',{enumerable:true,value:'00000000-0000-4000-8000-000000000000'});
    Object.defineProperty(receipt,'revokedAtMs',{enumerable:true,value:Date.now()});
    assert.throws(()=>f.registry.revoke(item.workerId,bindingA,receipt,{
      expectedSignature:item.envelope.signature
    }),/WORKER_IDENTITY_REGISTRY_REVOCATION_INVALID/);
    assert.equal(getterCalls,0);
    assert.equal(f.store.workerIdentityJournalStatus().eventCount,1);
    assert.equal(f.registry.isRevoked(item.workerId,bindingA),false);
  }finally{f.dispose();}
});

test('durable registry bounds enrollment TTL and validates revocation receipt identity and time',()=>{
  const f=fixture();
  try {
    const overlong=signedEnvelope(pair(),bindingA,86_400_001);
    assert.throws(()=>f.registry.register(overlong.envelope,{
      expectedPreviousBindingId:null,expectedPreviousState:'EMPTY'
    }),/WORKER_IDENTITY_CLAIMS_INVALID/);
    const item=signedEnvelope();
    assert.equal(f.registry.register(item.envelope,{
      expectedPreviousBindingId:null,expectedPreviousState:'EMPTY'
    }),true);
    const expected={expectedSignature:item.envelope.signature};
    const base={revocationId:'00000000-0000-4000-8000-000000000000',
      revokedAtMs:Date.now(),reasonCode:'owner-revoked'};
    assert.throws(()=>f.registry.revoke(item.workerId,bindingA,{
      ...base,revocationId:'00000000-0000-0000-0000-000000000000'
    },expected),/WORKER_IDENTITY_REGISTRY_REVOCATION_INVALID/);
    assert.throws(()=>f.registry.revoke(item.workerId,bindingA,{
      ...base,revokedAtMs:Date.now()+60_000
    },expected),/WORKER_IDENTITY_REGISTRY_REVOCATION_INVALID/);
    assert.equal(f.store.workerIdentityJournalStatus().eventCount,1);
  } finally { f.dispose(); }
});

test('journal hash-chain tampering is detected on store restart',()=>{
  const f=fixture();
  try {
    const item=signedEnvelope();
    assert.equal(f.registry.register(item.envelope,{expectedPreviousBindingId:null,expectedPreviousState:'EMPTY'}),true);
    f.store.close();
    const dbPath=path.join(f.root,'shared','root-leases','root-leases.sqlite');
    const db=new DatabaseSync(dbPath);
    try {
      db.exec('DROP TRIGGER worker_identity_events_no_update');
      db.exec("UPDATE worker_identity_events SET body=body || ' '");
    } finally { db.close(); }
    assert.throws(()=>new WorkflowStore(f.options),/WORKER_IDENTITY_JOURNAL_CORRUPT/);
  } finally { f.dispose(); }
});

test('journal events are append-only and projection tampering fails closed',()=>{
  const f=fixture();
  try {
    const item=signedEnvelope();
    assert.equal(f.registry.register(item.envelope,{expectedPreviousBindingId:null,expectedPreviousState:'EMPTY'}),true);
    const dbPath=path.join(f.root,'shared','root-leases','root-leases.sqlite');
    const db=new DatabaseSync(dbPath);
    try {
      assert.throws(()=>db.exec('DELETE FROM worker_identity_events'),/APPEND_ONLY/);
      assert.throws(()=>db.exec("UPDATE worker_identity_events SET body='{}'"),/APPEND_ONLY/);
      db.exec("UPDATE worker_identity_registry SET state='REVOKED'");
    } finally { db.close(); }
    assert.throws(()=>f.registry.get(item.workerId),/WORKER_IDENTITY_PROJECTION_CORRUPT/);
  } finally { f.dispose(); }
});

test('separate Node processes cannot both win the machine-global initial registration CAS',async()=>{
  const f=fixture();
  try{
    const item=signedEnvelope();
    const results=await Promise.all([
      registerInSeparateProcess(f.root,'emad',item.envelope),
      registerInSeparateProcess(f.root,'saeed',item.envelope)
    ]);
    assert.deepEqual(results.map(x=>x.registered).sort(),[false,true]);
    assert.ok(results.every(x=>x.status.eventCount===1));
    assert.equal(f.store.workerIdentityJournalStatus().eventCount,1);
    assert.deepEqual(f.registry.get(item.workerId),item.envelope);
  }finally{f.dispose();}
});

test('durable registry works through the real authority contract across restart, authorization and revocation',async()=>{
  const f=fixture();
  let activeStore=f.store;
  try {
    const state={
      now:Date.now(),bindingId:bindingA,policyDigest:D,
      allowedTools:new Set(['worker.register','worker.revoke','read_text'])
    };
    const authority=authorityFor(activeStore,state);
    const keys=pair();
    const first=await authority.registerWorker({privateKey:keys.privateKey});
    assert.equal((await authority.authorizeWorker({
      workerId:first.claims.workerId,
      invocation:{tool:'read_text',arguments:{path:'README.md'}}
    })).authorized,true);
    const revoked=await authority.revokeWorker({workerId:first.claims.workerId,reasonCode:'owner-revoked'});
    assert.equal(revoked.revoked,true);
    assert.equal(f.registry.isRevoked(first.claims.workerId,bindingA),true);
    state.bindingId=bindingB;
    const second=await authority.registerWorker({privateKey:keys.privateKey});
    assert.equal(second.claims.workerId,first.claims.workerId);
    assert.notEqual(second.claims.bindingId,first.claims.bindingId);
    activeStore.close();
    activeStore=new WorkflowStore(f.options);
    const resumed=authorityFor(activeStore,state);
    assert.equal((await resumed.authorizeWorker({
      workerId:second.claims.workerId,
      invocation:{tool:'read_text',arguments:{path:'README.md'}}
    })).authorized,true);
    assert.equal(activeStore.workerIdentityJournalStatus().eventCount,3);
  } finally {
    try{activeStore.close();}catch{}
    f.dispose();
  }
});
