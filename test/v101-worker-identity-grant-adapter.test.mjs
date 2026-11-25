import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { V2GrantRegistry } from '../src/v2-grant-registry.mjs';
import { createV101ProtectedRouterBridge } from '../src/full-access-protected-router-bridge.mjs';
import { createV101WorkerIdentityGrantAdapter } from '../src/v101-worker-identity-grant-adapter.mjs';
import { createWorkerIdentityAuthority, deriveWorkerId } from '../src/worker-identity-authority.mjs';
import { WorkflowStore } from '../src/workflow-store.mjs';
import { createWorkflowStoreWorkerIdentityRegistry } from '../src/worker-identity-store.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const ISSUER='https://idp.qa.invalid';
const AUDIENCE='https://commander.qa.invalid/mcp';
const TOKEN='QA_ONLY_BEARER_TOKEN_FOR_WORKER_IDENTITY_0123456789';
const BINDING='a'.repeat(64);
const OWNER_SID='b'.repeat(64);
const DEVICE_ID='c'.repeat(64);
const TUNNEL_ID='d'.repeat(64);
const POLICY='e'.repeat(64);
const WORKER_TOOLS=['worker.register','read_text','worker.revoke'];

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v101-v107-worker-adapter-'));
  const state={
    now:Date.now(),token:TOKEN,bindingId:BINDING,ownerSidHash:OWNER_SID,
    route:{
      hostId:'qa-host',principalId:'qa-principal',profileId:'qa-profile',
      conversationId:'qa-chat',operationId:'worker-lifecycle',
      target:{kind:'workflow-root',id:'root-a'}
    },
    allowed:new Set(WORKER_TOOLS),ownerAuthorization:true
  };
  const tokenHash=sha(TOKEN);
  const registry=new V2GrantRegistry({
    directory:path.join(root,'v2-grants'),now:()=>state.now,
    authorizeAdministration:()=>true
  });
  const store=new WorkflowStore({
    directory:path.join(root,'profile-qa'),
    rootLeaseDirectory:path.join(root,'shared','root-leases'),
    allowedRoots:[root],device:'v101-v107-integration-test',
    configSha256:'1'.repeat(64),authority:{profileId:'qa-profile'}
  });
  const workerRegistry=createWorkflowStoreWorkerIdentityRegistry(store);
  const bridge=createV101ProtectedRouterBridge({
    hostId:'qa-host',profileId:'qa-profile',issuer:ISSUER,audience:AUDIENCE,
    now:()=>state.now,
    verifyAccessToken:async token=>token===state.token?{
      issuer:ISSUER,audience:AUDIENCE,subject:'qa-subject',
      notBeforeMs:state.now-1000,expiresAtMs:state.now+120_000,
      scopes:['commander.workflow']
    }:null,
    resolvePrincipal:async subject=>subject==='qa-subject'?'qa-principal':null,
    resolveAttestedTokenBinding:async digest=>digest===tokenHash?{
      source:'native-owner-attested',tokenSha256:tokenHash,
      sessionHandle:'qa-chat',bindingId:state.bindingId,ownerSidHash:state.ownerSidHash,
      expiresAtMs:state.now+120_000
    }:null,
    nativeSessionBindings:{
      resolveNativeRoute:async session=>session==='qa-chat'?state.route:null,
      resolveNativeOwnerContext:async session=>session==='qa-chat'?{
        source:'native-owner-attested',hostId:'qa-host',profileId:'qa-profile',
        principalId:'qa-principal',conversationId:'qa-chat',bindingId:state.bindingId,
        ownerSidHash:state.ownerSidHash,expiresAtMs:state.now+120_000
      }:null
    },
    grantRegistry:registry,
    authorizeExactInvocation:async(_route,call)=>typeof state.ownerAuthorization==='function'
      ?state.ownerAuthorization(call)
      :state.ownerAuthorization&&state.allowed.has(call.tool)
  });
  const adapter=createV101WorkerIdentityGrantAdapter({
    grantRegistry:registry,bridge,resolveCurrentAccessToken:()=>state.token,
    now:()=>state.now
  });
  const authority=createWorkerIdentityAuthority({
    hostId:'qa-host',profileId:'qa-profile',issuer:'commander.local',
    audience:'remote-commander',resolveOwnerContext:adapter.resolveOwnerContext,
    resolveOwnerGrant:adapter.resolveOwnerGrant,
    resolveDeviceIdentity:async()=>({
      source:'native-device-attestor',provider:'native-key-store',
      deviceIdHash:DEVICE_ID,ownerSidHash:OWNER_SID,verified:true,
      attestedAtMs:state.now-1000,expiresAtMs:state.now+120_000
    }),
    resolveTransportIdentity:async()=>({
      source:'native-tunnel-attestor',provider:'openai-secure-mcp-tunnel',
      profileId:'qa-profile',tunnelIdHash:TUNNEL_ID,ownerSidHash:OWNER_SID,
      authenticated:true,controlPlanePollOk:true,healthzStatus:200,readyzStatus:200,
      lastPollAtMs:state.now-1000,expiresAtMs:state.now+60_000
    }),
    resolveCapabilityPolicyDigest:async()=>POLICY,
    authorizeExactInvocation:adapter.authorizeExactInvocation,
    registry:workerRegistry,now:()=>state.now,
    maxEnrollmentTtlMs:900_000,maxDeviceAgeMs:300_000,maxTransportAgeMs:120_000
  });
  async function addBaseGrants(tools=WORKER_TOOLS){
    for(const tool of tools)await registry.change({
      route:state.route,tool,status:'ENABLED',expectedRevision:0,
      actor:'qa-owner',reason:'owner approved worker action'
    });
  }
  async function addWorkerGrants(context,tools=WORKER_TOOLS,expiresAtMs=state.now+110_000){
    for(const tool of tools)await registry.changeWorkerToolGrant({
      route:state.route,workerContext:context,tool,status:'ENABLED',
      expectedRevision:0,actor:'qa-owner',reason:'owner approved exact worker tool',
      expiresAtMs
    });
  }
  function close(){
    bridge.close();registry.close();store.close();fs.rmSync(root,{recursive:true,force:true});
  }
  return{state,registry,store,workerRegistry,bridge,adapter,authority,addBaseGrants,addWorkerGrants,close};
}
function makeIdentity(){
  const pair=generateKeyPairSync('ed25519');
  const der=pair.publicKey.export({type:'spki',format:'der'});
  const keyId=sha(der);
  const workerId=deriveWorkerId({
    hostId:'qa-host',profileId:'qa-profile',ownerSidHash:OWNER_SID,
    deviceProvider:'native-key-store',deviceIdHash:DEVICE_ID,keyId
  });
  const context={
    hostId:'qa-host',profileId:'qa-profile',principalId:'qa-principal',
    conversationId:'qa-chat',bindingId:BINDING,workerId,keyId,
    ownerSidHash:OWNER_SID,deviceProvider:'native-key-store',deviceIdHash:DEVICE_ID,
    tunnelProvider:'openai-secure-mcp-tunnel',tunnelIdHash:TUNNEL_ID,
    capabilityPolicyDigest:POLICY
  };
  return{pair,context,workerId};
}

test('V1-07 enrollment, exact action, grant revision and revocation compose with the native V1-01 bridge',async()=>{
  const f=fixture();
  try{
    const identity=makeIdentity();
    await f.registry.changeWorkerGrant({
      workerContext:identity.context,status:'ACTIVE',expectedRevision:0,
      actor:'qa-owner',reason:'owner approved worker identity',
      expiresAtMs:f.state.now+110_000
    });
    await f.addBaseGrants();
    await f.addWorkerGrants(identity.context);
    const owner=await f.adapter.resolveOwnerContext();
    assert.equal(owner.source,'native-owner-attested');
    assert.equal(owner.bindingId,BINDING);
    assert.equal(owner.ownerSidHash,OWNER_SID);
    const grant=await f.adapter.resolveOwnerGrant({
      source:'native-owner-attested',...owner,...identity.context
    });
    assert.equal(grant.status,'ACTIVE');
    assert.equal(grant.revision,1);
    const envelope=await f.authority.registerWorker({privateKey:identity.pair.privateKey});
    assert.equal(envelope.claims.workerId,identity.workerId);
    assert.equal(envelope.claims.grantRevision,grant.revision);
    assert.deepEqual(f.workerRegistry.get(identity.workerId),envelope);
    assert.equal(f.store.workerIdentityJournalStatus().eventCount,1);
    const allowed=await f.authority.authorizeWorker({
      workerId:identity.workerId,
      invocation:{tool:'read_text',arguments:{path:'README.md'}}
    });
    assert.equal(allowed.authorized,true);
    assert.equal(allowed.grantRevision,1);
    const revoked=await f.authority.revokeWorker({
      workerId:identity.workerId,reasonCode:'qa-owner-request'
    });
    assert.equal(revoked.revoked,true);
    assert.equal(f.workerRegistry.isRevoked(identity.workerId,BINDING),true);
    assert.equal(f.store.workerIdentityJournalStatus().eventCount,2);
    await assert.rejects(f.authority.authorizeWorker({
      workerId:identity.workerId,invocation:{tool:'read_text',arguments:{path:'README.md'}}
    }),error=>error?.workerIdentityCode==='WORKER_IDENTITY_REVOKED');
  }finally{f.close();}
});


test('V1-01 grant adapter binds worker identity to the independently native owner SID',async t=>{
  await t.test('owner grant lookup rejects a different native owner SID',async()=>{
    const f=fixture();
    try{
      const identity=makeIdentity();
      await f.registry.changeWorkerGrant({
        workerContext:identity.context,status:'ACTIVE',expectedRevision:0,
        actor:'qa-owner',reason:'owner approved worker identity',
        expiresAtMs:f.state.now+110_000
      });
      f.state.ownerSidHash='f'.repeat(64);
      assert.equal(await f.adapter.resolveOwnerGrant({
        source:'native-owner-attested',
        hostId:identity.context.hostId,profileId:identity.context.profileId,
        principalId:identity.context.principalId,conversationId:identity.context.conversationId,
        bindingId:identity.context.bindingId,ownerSidHash:identity.context.ownerSidHash,
        expiresAtMs:f.state.now+120_000,...identity.context
      }),null);
    }finally{f.close();}
  });
  await t.test('owner SID rotation during awaited exact policy denies worker action',async()=>{
    const f=fixture();
    try{
      const identity=makeIdentity();
      await f.registry.changeWorkerGrant({
        workerContext:identity.context,status:'ACTIVE',expectedRevision:0,
        actor:'qa-owner',reason:'owner approved worker identity',
        expiresAtMs:f.state.now+110_000
      });
      await f.addBaseGrants();await f.addWorkerGrants(identity.context);
      f.state.ownerAuthorization=async()=>{
        f.state.ownerSidHash='f'.repeat(64);
        return true;
      };
      const authorized=await f.adapter.authorizeExactInvocation(
        {hostId:'qa-host',profileId:'qa-profile',principalId:'qa-principal',conversationId:'qa-chat'},
        {tool:'read_text',arguments:{path:'README.md'}},
        {...identity.context,grantRevision:1}
      );
      assert.equal(authorized,false);
    }finally{f.close();}
  });
});

test('V1-01 denies worker calls when the exact worker grant, base route grant, owner epoch or target changes',async()=>{
  const f=fixture();
  try{
    const identity=makeIdentity();
    await f.registry.changeWorkerGrant({
      workerContext:identity.context,status:'ACTIVE',expectedRevision:0,
      actor:'qa-owner',reason:'owner approved worker identity',
      expiresAtMs:f.state.now+110_000
    });
    await f.addBaseGrants();await f.addWorkerGrants(identity.context);
    await f.authority.registerWorker({privateKey:identity.pair.privateKey});
    const request={workerId:identity.workerId,
      invocation:{tool:'read_text',arguments:{path:'README.md'}}};
    assert.equal((await f.authority.authorizeWorker(request)).authorized,true);
    const taskGrant=f.registry.readWorkerToolGrant(f.state.route,identity.context,'read_text');
    await f.registry.changeWorkerToolGrant({
      route:f.state.route,workerContext:identity.context,tool:'read_text',
      status:'REVOKED',expectedRevision:taskGrant.revision,actor:'qa-owner',
      reason:'owner revoked worker tool'
    });
    await assert.rejects(f.authority.authorizeWorker(request),
      error=>error?.workerIdentityCode==='WORKER_IDENTITY_ACTION_NOT_AUTHORIZED');
    const fresh=fixture();
    try{
      const id=makeIdentity();
      await fresh.registry.changeWorkerGrant({
        workerContext:id.context,status:'ACTIVE',expectedRevision:0,
        actor:'qa-owner',reason:'owner approved worker identity',
        expiresAtMs:fresh.state.now+110_000
      });
      await fresh.addBaseGrants();await fresh.addWorkerGrants(id.context);
      await fresh.authority.registerWorker({privateKey:id.pair.privateKey});
      fresh.state.route={...fresh.state.route,target:{kind:'workflow-root',id:'root-b'}};
      await assert.rejects(fresh.authority.authorizeWorker({
        workerId:id.workerId,invocation:{tool:'read_text',arguments:{path:'README.md'}}
      }),error=>error?.workerIdentityCode==='WORKER_IDENTITY_ACTION_NOT_AUTHORIZED');
    }finally{fresh.close();}
  }finally{f.close();}
});

test('V1-01 owner binding rotation invalidates the old signed worker epoch and old grants',async()=>{
  const f=fixture();
  try{
    const identity=makeIdentity();
    await f.registry.changeWorkerGrant({
      workerContext:identity.context,status:'ACTIVE',expectedRevision:0,
      actor:'qa-owner',reason:'owner approved worker identity',
      expiresAtMs:f.state.now+110_000
    });
    await f.addBaseGrants();await f.addWorkerGrants(identity.context);
    await f.authority.registerWorker({privateKey:identity.pair.privateKey});
    f.state.bindingId='f'.repeat(64);
    const result=await f.authority.authorizeWorker({
      workerId:identity.workerId,invocation:{tool:'read_text',arguments:{path:'README.md'}}
    }).catch(error=>error);
    assert.equal(result?.workerIdentityCode,'WORKER_IDENTITY_SCOPE_MISMATCH');
  }finally{f.close();}
});
