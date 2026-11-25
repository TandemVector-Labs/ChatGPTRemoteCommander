import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { V2GrantRegistry } from '../src/v2-grant-registry.mjs';
import { createV101WorkerIdentityGrantAdapter } from '../src/v101-worker-identity-grant-adapter.mjs';

const processWorker=fileURLToPath(new URL('./v2-worker-grant-process-worker.mjs',import.meta.url));
const H1='1'.repeat(64),H2='2'.repeat(64),H3='3'.repeat(64),H4='4'.repeat(64);
const B1='a'.repeat(64),B2='b'.repeat(64);
const WORKER='cw_'+'5'.repeat(64);
const route=(target='root-a',conversationId='chat-1',operationId='write-step')=>({
  hostId:'host-1',principalId:'owner-1',profileId:'emad',conversationId,
  operationId,target:{kind:'workflow-root',id:target}
});
const workerContext=(bindingId=B1,changes={})=>Object.freeze({
  hostId:'host-1',profileId:'emad',principalId:'owner-1',conversationId:'chat-1',
  bindingId,workerId:WORKER,keyId:H1,ownerSidHash:H2,deviceProvider:'native-key-store',
  deviceIdHash:H3,tunnelProvider:'openai-secure-mcp-tunnel',tunnelIdHash:H4,
  capabilityPolicyDigest:'6'.repeat(64),...changes
});
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v2-worker-grants-'));
  const state={now:Date.now(),adminAllowed:true,adminCalls:[]};
  const registry=new V2GrantRegistry({
    directory:path.join(root,'secure'),now:()=>state.now,
    authorizeAdministration:request=>{state.adminCalls.push(request);return state.adminAllowed;}
  });
  return {
    root,state,registry,context:workerContext(),
    close(){try{registry.close();}catch{}fs.rmSync(root,{recursive:true,force:true});}
  };
}
function grantEnrollment(f,context=f.context,revision=0,expiresAtMs=f.state.now+60_000){
  return f.registry.changeWorkerGrant({
    workerContext:context,status:'ACTIVE',expectedRevision:revision,
    actor:'owner-1',reason:'owner approved worker',expiresAtMs
  });
}
function grantTool(f,context=f.context,routeValue=route(),tool='read_text',revision=0,expiresAtMs=f.state.now+30_000){
  return f.registry.changeWorkerToolGrant({
    route:routeValue,workerContext:context,tool,status:'ENABLED',
    expectedRevision:revision,actor:'owner-1',reason:'owner approved exact tool',expiresAtMs
  });
}
function ownerRequest(context,expiresAtMs){
  return Object.freeze({source:'native-owner-attested',...context,expiresAtMs});
}
function routeContext(context){
  return Object.freeze({
    hostId:context.hostId,profileId:context.profileId,
    principalId:context.principalId,conversationId:context.conversationId
  });
}

test('worker enrollment grants are durable, exact, default-deny and stored in the existing host registry',async()=>{
  const f=fixture();
  try{
    assert.equal(f.registry.readWorkerGrant(f.context),null);
    assert.equal(f.registry.isWorkerAllowed(route(),f.context,'read_text'),false);
    const grant=await grantEnrollment(f);
    assert.equal(f.state.adminCalls[0].kind,'worker-enrollment-grant');
    assert.equal(f.state.adminCalls[0].status,'ACTIVE');
    assert.equal(f.state.adminCalls[0].workerContext.workerId,WORKER);
    assert.deepEqual(Object.keys(grant).sort(),[
      'source','hostId','profileId','principalId','conversationId','bindingId',
      'workerId','keyId','ownerSidHash','deviceProvider','deviceIdHash',
      'tunnelProvider','tunnelIdHash','capabilityPolicyDigest','revision',
      'issuedAtMs','expiresAtMs','status'
    ].sort());
    assert.equal(grant.source,'native-owner-attested');
    assert.equal(grant.status,'ACTIVE');
    assert.equal(grant.revision,1);
    assert.deepEqual(f.registry.readWorkerGrant(f.context),grant);
    assert.equal(f.registry.workerGrantEvents(f.context).length,1);
    const db=new DatabaseSync(path.join(f.root,'secure','v2-access.sqlite'),{readOnly:true});
    try{
      assert.equal(db.prepare('PRAGMA user_version').get().user_version,3);
      for(const name of ['v2_grants','v2_grant_events','v2_worker_grants',
        'v2_worker_grant_events','v2_worker_tool_grants','v2_worker_tool_grant_events']){
        assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
      }
    }finally{db.close();}
  }finally{f.close();}
});

test('worker enrollment CAS prevents active replacement and requires a fresh owner binding after revoke',async()=>{
  const f=fixture();
  try{
    await grantEnrollment(f);
    await assert.rejects(grantEnrollment(f,workerContext(B2),1),/V2_WORKER_GRANT_ACTIVE_EPOCH_CONFLICT/);
    await assert.rejects(grantEnrollment(f,f.context,0),/V2_WORKER_GRANT_REVISION_CONFLICT/);
    const revoked=await f.registry.changeWorkerGrant({
      workerContext:f.context,status:'REVOKED',expectedRevision:1,
      actor:'owner-1',reason:'owner revoked worker'
    });
    assert.equal(revoked.status,'REVOKED');
    assert.equal(revoked.revision,2);
    assert.equal(f.registry.isWorkerAllowed(route(),f.context,'read_text'),false);
    await assert.rejects(grantEnrollment(f,f.context,2),/V2_WORKER_GRANT_EPOCH_REUSE/);
    const regrant=await grantEnrollment(f,workerContext(B2),2);
    assert.equal(regrant.status,'ACTIVE');
    assert.equal(regrant.revision,3);
    assert.equal(regrant.bindingId,B2);
    assert.equal(f.registry.readWorkerGrant(f.context).bindingId,B2);
    assert.equal(f.registry.workerGrantEvents(workerContext(B2)).length,3);
  }finally{f.close();}
});

test('worker enrollment requires the exact key/device owner tuple and bounded expiry',async()=>{
  const f=fixture();
  try{
    f.state.adminAllowed=false;
    await assert.rejects(grantEnrollment(f),/V2_WORKER_GRANT_ADMIN_AUTH_REQUIRED/);
    f.state.adminAllowed=true;
    await assert.rejects(grantEnrollment(f,f.context,0,f.state.now+86_400_001),
      /V2_WORKER_GRANT_EXPIRY_INVALID/);
    await grantEnrollment(f);
    await assert.rejects(grantEnrollment(f,workerContext(B2,{deviceIdHash:'9'.repeat(64)}),1),
      /V2_WORKER_GRANT_WORKER_IDENTITY_CHANGED/);
    const getter=Object.create(null);
    for(const [k,v] of Object.entries(f.context))Object.defineProperty(getter,k,{
      enumerable:true,get(){throw Error('getter must not execute');}
    });
    assert.throws(()=>f.registry.readWorkerGrant(getter),/V2_WORKER_GRANT_IDENTITY_INVALID/);
    assert.throws(()=>f.registry.readWorkerGrant(new Proxy(f.context,{})),
      /V2_WORKER_GRANT_IDENTITY_INVALID/);
    assert.equal(f.registry.readWorkerGrant(f.context).status,'ACTIVE');
  }finally{f.close();}
});

test('per-worker tool grants bind exact chat, root, tool, key, device, tunnel, policy and binding',async()=>{
  const f=fixture();
  try{
    await grantEnrollment(f);
    assert.equal(f.registry.isWorkerAllowed(route(),f.context,'read_text'),false);
    await grantTool(f);
    assert.equal(f.registry.isWorkerAllowed(route(),f.context,'read_text'),true);
    assert.equal(f.registry.workerToolGrantEvents(route(),f.context,'read_text').length,1);
    assert.equal(f.registry.isWorkerAllowed(route('root-a','chat-1','other-step'),f.context,'read_text'),false);
    await assert.rejects(grantTool(f,workerContext(B1,{keyId:'9'.repeat(64)})),
      /V2_WORKER_GRANT_NOT_ACTIVE/);
    assert.equal(f.registry.isWorkerAllowed(route(),workerContext(B1,{keyId:'9'.repeat(64)}),'read_text'),false);
    assert.equal(f.registry.isWorkerAllowed(route('root-b'),f.context,'read_text'),false);
    assert.equal(f.registry.isWorkerAllowed(route(),f.context,'write_text'),false);
    assert.equal(f.registry.isWorkerAllowed(route('root-a','chat-other'),f.context,'read_text'),false);
    assert.equal(f.registry.isWorkerAllowed(route(),workerContext(B2),'read_text'),false);
    assert.equal(f.registry.isWorkerAllowed(route(),workerContext(B1,{keyId:'9'.repeat(64)}),'read_text'),false);
    assert.equal(f.registry.isWorkerAllowed(route(),workerContext(B1,{deviceIdHash:'9'.repeat(64)}),'read_text'),false);
    assert.equal(f.registry.isWorkerAllowed(route(),workerContext(B1,{tunnelIdHash:'9'.repeat(64)}),'read_text'),false);
    assert.equal(f.registry.isWorkerAllowed(route(),workerContext(B1,{capabilityPolicyDigest:'9'.repeat(64)}),'read_text'),false);
  }finally{f.close();}
});

test('per-worker tool grants require active enrollment, bounded expiry, CAS and revocation',async()=>{
  const f=fixture();
  try{
    await assert.rejects(grantTool(f),/V2_WORKER_GRANT_NOT_ACTIVE/);
    await grantEnrollment(f);
    await assert.rejects(grantTool(f,f.context,route(),'read_text',0,f.state.now+60_001),
      /V2_WORKER_TOOL_GRANT_EXPIRY_INVALID/);
    await grantTool(f);
    const toolAdmin=f.state.adminCalls.find(x=>x.kind==='worker-tool-grant');
    assert.equal(toolAdmin.status,'ENABLED');
    assert.equal(toolAdmin.tool,'read_text');
    assert.equal(toolAdmin.route.operationId,'write-step');
    assert.equal(toolAdmin.workerContext.workerId,WORKER);
    assert.equal(f.registry.isWorkerAllowed(route(),f.context,'read_text'),true);
    await assert.rejects(grantTool(f,f.context,route(),'read_text',0),
      /V2_WORKER_TOOL_GRANT_REVISION_CONFLICT/);
    const revoked=await f.registry.changeWorkerToolGrant({
      route:route(),workerContext:f.context,tool:'read_text',status:'REVOKED',
      expectedRevision:1,actor:'owner-1',reason:'owner revoked tool'
    });
    assert.equal(revoked.status,'REVOKED');
    assert.equal(f.registry.isWorkerAllowed(route(),f.context,'read_text'),false);
    const renewed=await grantTool(f,f.context,route(),'read_text',2,f.state.now+25_000);
    assert.equal(renewed.status,'ENABLED');
    assert.equal(renewed.revision,3);
    assert.equal(f.registry.isWorkerAllowed(route(),f.context,'read_text'),true);
    f.state.now+=26_000;
    assert.equal(f.registry.isWorkerAllowed(route(),f.context,'read_text'),false);
  }finally{f.close();}
});

test('expired worker enrollment invalidates old task grants and re-enrollment needs a new binding',async()=>{
  const f=fixture();
  try{
    await grantEnrollment(f,f.context,0,f.state.now+1000);
    await grantTool(f,f.context,route(),'read_text',0,f.state.now+1000);
    assert.equal(f.registry.isWorkerAllowed(route(),f.context,'read_text'),true);
    f.state.now+=1001;
    assert.equal(f.registry.isWorkerAllowed(route(),f.context,'read_text'),false);
    await assert.rejects(grantEnrollment(f,f.context,1,f.state.now+30_000),
      /V2_WORKER_GRANT_EPOCH_REUSE/);
    const next=workerContext(B2);
    await grantEnrollment(f,next,1,f.state.now+30_000);
    assert.equal(f.registry.isWorkerAllowed(route(),next,'read_text'),false);
    await grantTool(f,next,route(),'read_text',1,f.state.now+20_000);
    assert.equal(f.registry.isWorkerAllowed(route(),next,'read_text'),true);
  }finally{f.close();}
});

test('worker grant event history is append-only and owner admin rejection has no side effects',async()=>{
  const f=fixture();
  try{
    f.state.adminAllowed=false;
    await assert.rejects(grantEnrollment(f),/V2_WORKER_GRANT_ADMIN_AUTH_REQUIRED/);
    f.state.adminAllowed=true;
    await grantEnrollment(f);
    await grantTool(f);
    const db=new DatabaseSync(path.join(f.root,'secure','v2-access.sqlite'));
    try{
      assert.throws(()=>db.exec('DELETE FROM v2_worker_grant_events'),/APPEND_ONLY/);
      assert.throws(()=>db.exec("UPDATE v2_worker_tool_grant_events SET reason='changed'"),/APPEND_ONLY/);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_worker_grant_events').get().n,1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_worker_tool_grant_events').get().n,1);
    }finally{db.close();}
    assert.equal(f.registry.workerGrantEvents(f.context).length,1);
  }finally{f.close();}
});

test('V1-07 adapter returns the exact owner grant and composes owner, base and worker grants',async()=>{
  const f=fixture();
  try{
    await grantEnrollment(f);
    await grantTool(f);
    await grantTool(f,f.context,route(),'worker.register');
    await grantTool(f,f.context,route(),'worker.revoke');
    let target='root-a';
    const bridge={
      verifyCaller:async()=>Object.freeze({verified:true,source:'v1-01-trusted-ingress'}),
      resolveOwnerContext:async()=>Object.freeze({
        source:'native-owner-attested',hostId:f.context.hostId,
        profileId:f.context.profileId,principalId:f.context.principalId,
        conversationId:f.context.conversationId,bindingId:f.context.bindingId,
        ownerSidHash:f.context.ownerSidHash,expiresAtMs:f.state.now+120_000
      }),
      resolveOwnerRoute:async()=>({...route(),target:{kind:'workflow-root',id:target}}),
      authorizeTool:async(_actor,call)=>['read_text','worker.register','worker.revoke'].includes(call.tool),
      usesGrantRegistry:candidate=>candidate===f.registry
    };
    const adapter=createV101WorkerIdentityGrantAdapter({
      grantRegistry:f.registry,bridge,
      resolveCurrentAccessToken:()=> 'QA_FAKE_BEARER_TOKEN_123456789',
      now:()=>f.state.now
    });
    const resolved=await adapter.resolveOwnerGrant(ownerRequest(f.context,f.state.now+120_000));
    assert.deepEqual(resolved,f.registry.readWorkerGrant(f.context));
    assert.equal(resolved.status,'ACTIVE');
    const invocation=Object.freeze({tool:'read_text',arguments:Object.freeze({path:'safe.txt'})});
    const authorizationContext=Object.freeze({...f.context,grantRevision:resolved.revision});
    assert.equal(await adapter.authorizeExactInvocation(routeContext(f.context),invocation,authorizationContext),true);
    assert.equal(await adapter.authorizeExactInvocation(routeContext(f.context),
      Object.freeze({tool:'worker.register',arguments:Object.freeze({workerId:WORKER})}),authorizationContext),true);
    assert.equal(await adapter.authorizeExactInvocation(routeContext(f.context),
      Object.freeze({tool:'worker.revoke',arguments:Object.freeze({workerId:WORKER})}),authorizationContext),true);
    target='root-b';
    assert.equal(await adapter.authorizeExactInvocation(routeContext(f.context),invocation,authorizationContext),false);
    target='root-a';
    assert.equal(await adapter.authorizeExactInvocation(routeContext(f.context),
      invocation,Object.freeze({...f.context,conversationId:'chat-other',grantRevision:resolved.revision})),false);
    assert.equal(await adapter.resolveOwnerGrant(ownerRequest(f.context,f.state.now-1)),null);
    assert.equal(await adapter.resolveOwnerGrant({...ownerRequest(f.context,f.state.now+1),extra:true}),null);
    await f.registry.changeWorkerGrant({
      workerContext:f.context,status:'REVOKED',expectedRevision:1,
      actor:'owner-1',reason:'owner revoked worker'
    });
    assert.equal((await adapter.resolveOwnerGrant(ownerRequest(f.context,f.state.now+120_000))).status,'REVOKED');
    assert.equal(await adapter.authorizeExactInvocation(routeContext(f.context),invocation,authorizationContext),false);
  }finally{f.close();}
});

test('unsupported V2 grant schemas fail closed without rewriting the database',async()=>{
  for(const version of [1,4]){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'v2-worker-grants-schema-'));
    const directory=path.join(root,'secure');fs.mkdirSync(directory,{recursive:true});
    const db=new DatabaseSync(path.join(directory,'v2-access.sqlite'));
    try{db.exec('PRAGMA user_version='+version+';');}finally{db.close();}
    assert.throws(()=>new V2GrantRegistry({directory,authorizeAdministration:()=>true}),
      version===1?/V2_GRANT_SCHEMA_MIGRATION_REQUIRED/:/V2_GRANT_SCHEMA_TOO_NEW/);
    const check=new DatabaseSync(path.join(directory,'v2-access.sqlite'),{readOnly:true});
    try{assert.equal(check.prepare('PRAGMA user_version').get().user_version,version);}
    finally{check.close();fs.rmSync(root,{recursive:true,force:true});}
  }
});

test('V2 schema v2 upgrades additively to v3 and preserves existing route grants',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v2-worker-grants-migrate-'));
  const directory=path.join(root,'secure');fs.mkdirSync(directory,{recursive:true});
  const location=path.join(directory,'v2-access.sqlite');
  const db=new DatabaseSync(location);
  try{
    db.exec('CREATE TABLE v2_grants (host TEXT NOT NULL,principal TEXT NOT NULL,profile TEXT NOT NULL,'+
      'conversation TEXT NOT NULL,kind TEXT NOT NULL,target TEXT NOT NULL,tool TEXT NOT NULL,'+
      "status TEXT NOT NULL CHECK(status IN ('ENABLED','REVOKED')),revision INTEGER NOT NULL CHECK(revision>=1),"+
      'actor TEXT NOT NULL,updated_at TEXT NOT NULL,'+
      'PRIMARY KEY(host,principal,profile,conversation,kind,target,tool));'+
      'CREATE TABLE v2_grant_events (seq INTEGER PRIMARY KEY AUTOINCREMENT,host TEXT NOT NULL,'+
      'principal TEXT NOT NULL,profile TEXT NOT NULL,conversation TEXT NOT NULL,kind TEXT NOT NULL,'+
      'target TEXT NOT NULL,tool TEXT NOT NULL,from_status TEXT,to_status TEXT NOT NULL,'+
      'revision INTEGER NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,occurred_at TEXT NOT NULL);'+
      'PRAGMA user_version=2;');
    db.prepare('INSERT INTO v2_grants VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('host-1','owner-1','emad','chat-1','workflow-root','root-a','read_text','ENABLED',1,'owner-1','2026-01-01T00:00:00.000Z');
  }finally{db.close();}
  const registry=new V2GrantRegistry({directory,authorizeAdministration:()=>true});
  try{
    assert.equal(registry.isAllowed(route(),'read_text'),true);
    assert.equal(registry.db.prepare('PRAGMA user_version').get().user_version,3);
    assert.equal(registry.readWorkerGrant(workerContext()),null);
  }finally{registry.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('transient SQLite journal disappearance does not fail grant admission or relax alias checks',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v2-grant-journal-race-'));
  const directory=path.join(root,'secure');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const journal=path.join(directory,'v2-access.sqlite-journal');
  const originalExists=fs.existsSync;
  const create=()=>new V2GrantRegistry({directory,authorizeAdministration:()=>true});
  try{
    // Deterministic stale presence result: the rollback journal is gone at
    // lstat time, as observed during two-process CI concurrency.
    fs.existsSync=(entry)=>entry===journal ? true : originalExists(entry);
    let registry;
    try{
      registry=create();
      assert.equal(registry.db.prepare('PRAGMA journal_mode').get().journal_mode,'delete');
    }finally{
      registry?.close();
      fs.existsSync=originalExists;
    }
    // A present non-regular journal still fails closed.
    fs.mkdirSync(journal);
    assert.throws(create,/V2_GRANT_ALIAS_NOT_ALLOWED/);
  }finally{
    fs.existsSync=originalExists;
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('separate Node processes cannot both win the same initial worker-grant revision',async()=>{
  const f=fixture();
  try{
    const input={directory:path.join(f.root,'secure'),now:f.state.now,
      workerContext:f.context,expiresAtMs:f.state.now+60_000};
    const run=()=>new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[processWorker],{stdio:['pipe','pipe','pipe']});
      let stdout='',stderr='';
      child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
      child.once('error',reject);
      child.once('close',code=>{
        if(code!==0)return reject(new Error('grant process failed '+code+': '+stderr));
        try{resolve(JSON.parse(stdout));}catch(error){reject(error);}
      });
      child.stdin.end(JSON.stringify(input));
    });
    const results=await Promise.all([run(),run()]);
    assert.deepEqual(results.map(x=>x.status).sort(),['conflict','won']);
    assert.equal(f.registry.readWorkerGrant(f.context).revision,1);
    assert.equal(f.registry.workerGrantEvents(f.context).length,1);
  }finally{f.close();}
});

test('V1-07 adapter rejects a grant registry different from the native bridge registry',async()=>{
  const f=fixture();
  try{
    const bridge={
      verifyCaller:async()=>null,resolveOwnerContext:async()=>null,
      resolveOwnerRoute:async()=>null,authorizeTool:async()=>false,
      usesGrantRegistry:()=>false
    };
    assert.throws(()=>createV101WorkerIdentityGrantAdapter({
      grantRegistry:f.registry,bridge,
      resolveCurrentAccessToken:()=> 'QA_FAKE_BEARER_TOKEN_123456789',
      now:()=>f.state.now
    }),/V101_WORKER_GRANT_REGISTRY_MISMATCH/);
  }finally{f.close();}
});

test('V1-07 adapter requires exact current grantRevision and rechecks after asynchronous host authorization',async()=>{
  const f=fixture();
  try{
    await grantEnrollment(f);
    await grantTool(f);
    const base=f.registry.readWorkerGrant(f.context);
    let observedRevision=base.revision,changeDuringAuthorize=false;
    const grantRegistry={
      readWorkerGrant:context=>{
        const current=f.registry.readWorkerGrant(context);
        return current?Object.freeze({...current,revision:observedRevision}):null;
      },
      isWorkerAllowed:(...args)=>f.registry.isWorkerAllowed(...args)
    };
    const bridge={
      verifyCaller:async()=>Object.freeze({verified:true,source:'v1-01-trusted-ingress'}),
      resolveOwnerContext:async()=>Object.freeze({
        source:'native-owner-attested',hostId:f.context.hostId,
        profileId:f.context.profileId,principalId:f.context.principalId,
        conversationId:f.context.conversationId,bindingId:f.context.bindingId,
        ownerSidHash:f.context.ownerSidHash,expiresAtMs:f.state.now+120_000
      }),
      resolveOwnerRoute:async()=>route(),
      authorizeTool:async()=>{if(changeDuringAuthorize)observedRevision=base.revision+1;return true;},
      usesGrantRegistry:candidate=>candidate===grantRegistry
    };
    const adapter=createV101WorkerIdentityGrantAdapter({
      grantRegistry,bridge,resolveCurrentAccessToken:()=> 'QA_FAKE_BEARER_TOKEN_123456789',
      now:()=>f.state.now
    });
    const invocation=Object.freeze({tool:'read_text',arguments:Object.freeze({path:'safe.txt'})});
    assert.equal(await adapter.authorizeExactInvocation(routeContext(f.context),invocation,f.context),false);
    assert.equal(await adapter.authorizeExactInvocation(routeContext(f.context),invocation,
      Object.freeze({...f.context,grantRevision:0})),false);
    const authorizationContext=Object.freeze({...f.context,grantRevision:base.revision});
    assert.equal(await adapter.authorizeExactInvocation(routeContext(f.context),invocation,authorizationContext),true);
    observedRevision=base.revision+1;
    assert.equal(await adapter.authorizeExactInvocation(routeContext(f.context),invocation,authorizationContext),false);
    observedRevision=base.revision;changeDuringAuthorize=true;
    assert.equal(await adapter.authorizeExactInvocation(routeContext(f.context),invocation,authorizationContext),false);
  }finally{f.close();}
});
