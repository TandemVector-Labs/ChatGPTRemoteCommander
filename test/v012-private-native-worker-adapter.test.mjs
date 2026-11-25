import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {V2GrantRegistry} from '../src/v2-grant-registry.mjs';
import {WorkflowStore} from '../src/workflow-store.mjs';
import {createWorkflowStoreWorkerIdentityRegistry}
  from '../src/worker-identity-store.mjs';
import {deriveWorkerId,createWorkerIdentityAuthority}
  from '../src/worker-identity-authority.mjs';
import {createV012PrivateNativeWorkerGrantAdapter}
  from '../src/v012-private-native-worker-adapter.mjs';
import {deriveV101PrivatePairSessionHandle}
  from '../src/v101-private-pair-native-owner-stack.mjs';

const OWNER='a'.repeat(64),TUNNEL='b'.repeat(64);
const DEVICE='c'.repeat(64),POLICY='d'.repeat(64);
const sha=data=>createHash('sha256').update(data).digest('hex');

function fixture(){
  // ALL consent and device/tunnel attestation fixtures below are synthetic.
  // Never claim this test enrolls the live ChatGPT account or OS key.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc012-native-worker-'));
  const state={now:Date.now(),ownerSidHash:OWNER,bound:true,
    bindingId:'e'.repeat(64),allow:true,routeVersion:1};
  const identity={
    hostId:'qa-host',profileId:'qa-profile',principalId:'qa-account',
    expectedTunnelIdHash:TUNNEL,expectedOwnerSidHash:OWNER
  };
  const pair=deriveV101PrivatePairSessionHandle({
    profileId:identity.profileId,expectedTunnelIdHash:TUNNEL,
    expectedOwnerSidHash:OWNER
  });
  const owner=()=>({
    source:'native-owner-attested',hostId:identity.hostId,
    profileId:identity.profileId,principalId:identity.principalId,
    conversationId:pair,bindingId:state.bindingId,
    ownerSidHash:OWNER,expiresAtMs:state.now+120000
  });
  const nativeRoute=()=>({
    hostId:identity.hostId,profileId:identity.profileId,
    principalId:identity.principalId,conversationId:pair,
    operationId:'owner-bind',
    target:{kind:'desktop-seat',id:'current-owner'}
  });
  const route=()=>({...nativeRoute(),operationId:'qa-operation',
    target:{kind:'workflow-root',id:'qa-disposable-fixture'}});
  const grants=new V2GrantRegistry({
    directory:path.join(root,'grants'),now:()=>state.now,
    authorizeAdministration:async()=>true
  });
  const workflow=new WorkflowStore({
    directory:path.join(root,'workflow'),
    rootLeaseDirectory:path.join(root,'global-root-leases'),
    allowedRoots:[root],device:'qa-owned-fixture',
    configSha256:'1'.repeat(64),authority:{profileId:'qa-profile'}
  });
  const workerRegistry=createWorkflowStoreWorkerIdentityRegistry(workflow);
  const readBound=async()=>{
    if(!state.bound)throw Error('NATIVE_J01_NOT_BOUND');
    return owner();
  };
  const stack={
    nativeSessionBindings:{
      resolveNativeOwnerContext:readBound,
      resolveNativeRoute:async()=>{await readBound();return nativeRoute();}
    },
    resolveOwnerContext:async()=>({...await readBound(),tunnelIdHash:TUNNEL}),
    readCurrentOwnerSidHash:async()=>state.ownerSidHash,
    grantRegistry:grants
  };
  const adapter=createV012PrivateNativeWorkerGrantAdapter({
    ownerStack:stack,identity,now:()=>state.now,
    resolveTrustedToolRoute:async({nativeRoute:r})=>({
      ...r,operationId:state.routeVersion===1?'qa-operation':'changed-operation',
      target:{kind:'workflow-root',id:'qa-disposable-fixture'}
    }),
    authorizeExactArguments:async({tool,arguments:args})=>
      state.allow&&['worker.register','worker.revoke','read_text'].includes(tool)
      &&(tool!=='read_text'||args.path==='qa-fixture.txt')
  });
  const keys=generateKeyPairSync('ed25519');
  const publicDer=keys.publicKey.export({type:'spki',format:'der'});
  const keyId=sha(publicDer);
  const workerId=deriveWorkerId({
    hostId:identity.hostId,profileId:identity.profileId,
    ownerSidHash:OWNER,deviceProvider:'native-key-store',
    deviceIdHash:DEVICE,keyId
  });
  const workerContext={
    hostId:identity.hostId,profileId:identity.profileId,
    principalId:identity.principalId,conversationId:pair,
    bindingId:state.bindingId,workerId,keyId,ownerSidHash:OWNER,
    deviceProvider:'native-key-store',deviceIdHash:DEVICE,
    tunnelProvider:'openai-secure-mcp-tunnel',tunnelIdHash:TUNNEL,
    capabilityPolicyDigest:POLICY
  };
  const authority=createWorkerIdentityAuthority({
    hostId:identity.hostId,profileId:identity.profileId,
    issuer:'commander.local',audience:'remote-commander',
    resolveOwnerContext:adapter.resolveOwnerContext,
    resolveOwnerGrant:adapter.resolveOwnerGrant,
    authorizeExactInvocation:adapter.authorizeExactInvocation,
    resolveCapabilityPolicyDigest:async()=>POLICY,
    resolveDeviceIdentity:async()=>({
      source:'native-device-attestor',provider:'native-key-store',
      deviceIdHash:DEVICE,ownerSidHash:OWNER,verified:true,
      attestedAtMs:state.now-1000,expiresAtMs:state.now+100000
    }),
    resolveTransportIdentity:async()=>({
      source:'native-tunnel-attestor',provider:'openai-secure-mcp-tunnel',
      profileId:identity.profileId,tunnelIdHash:TUNNEL,ownerSidHash:OWNER,
      authenticated:true,controlPlanePollOk:true,healthzStatus:200,
      readyzStatus:200,lastPollAtMs:state.now-1000,
      expiresAtMs:state.now+100000
    }),
    registry:workerRegistry,now:()=>state.now
  });
  async function enable(){
    await grants.changeWorkerGrant({
      workerContext,status:'ACTIVE',expectedRevision:0,actor:identity.principalId,
      reason:'synthetic owner QA consent only',expiresAtMs:state.now+110000
    });
    for(const tool of ['worker.register','read_text','worker.revoke']){
      await grants.change({route:route(),tool,status:'ENABLED',
        expectedRevision:0,actor:identity.principalId,
        reason:'synthetic QA exact scope only'});
      await grants.changeWorkerToolGrant({
        route:route(),workerContext,tool,status:'ENABLED',
        expectedRevision:0,actor:identity.principalId,
        reason:'synthetic QA worker exact tool only',
        expiresAtMs:state.now+110000
      });
    }
  }
  const close=()=>{
    workflow.close();grants.close();
    fs.rmSync(root,{recursive:true,force:true});
  };
  return {state,identity,adapter,grants,workflow,workerRegistry,authority,
    keys,workerId,workerContext,pair,route,enable,close};
}

test('one-Tunnel private pair registers a real Ed25519 worker in durable registry after exact native owner grants, then revokes',async()=>{
  const f=fixture();
  try{
    assert.match(f.pair,/^pair-[a-f0-9]{32}$/);
    assert.equal(f.adapter.pairSessionHandle,f.pair);
    await assert.rejects(f.authority.registerWorker({privateKey:f.keys.privateKey}));
    assert.equal(f.workflow.workerIdentityJournalStatus().eventCount,0);
    await f.enable();
    const enrolled=await f.authority.registerWorker({privateKey:f.keys.privateKey});
    assert.equal(enrolled.claims.workerId,f.workerId);
    assert.equal(enrolled.claims.conversationId,f.pair);
    assert.equal(f.workflow.workerIdentityJournalStatus().eventCount,1);
    const action={workerId:f.workerId,
      invocation:{tool:'read_text',arguments:{path:'qa-fixture.txt'}}};
    const authorized=await f.authority.authorizeWorker(action);
    assert.equal(authorized.authorized,true);
    assert.equal(authorized.grantRevision,1);
    const revoked=await f.authority.revokeWorker({
      workerId:f.workerId,reasonCode:'qa-owner-revoke'
    });
    assert.equal(revoked.revoked,true);
    assert.equal(f.workflow.workerIdentityJournalStatus().eventCount,2);
    await assert.rejects(f.authority.authorizeWorker(action),
      {code:'WORKER_IDENTITY_REVOKED'});
  }finally{f.close();}
});

test('pair J01 owner epoch, exact tool policy, pair source and operation target are mandatory on every action',async()=>{
  for(const kind of ['no-j01','owner-changed','wrong-tool-args',
    'policy-denied','operation-changed','binding-rotated']){
    const f=fixture();
    try{
      await f.enable();
      const registration=await f.authority.registerWorker({
        privateKey:f.keys.privateKey
      });
      assert.equal(registration.claims.bindingId,f.state.bindingId);
      if(kind==='no-j01')f.state.bound=false;
      if(kind==='owner-changed')f.state.ownerSidHash='f'.repeat(64);
      if(kind==='policy-denied')f.state.allow=false;
      if(kind==='operation-changed')f.state.routeVersion=2;
      if(kind==='binding-rotated')f.state.bindingId='f'.repeat(64);
      const action={workerId:f.workerId,invocation:{
        tool:'read_text',arguments:{
          path:kind==='wrong-tool-args'?'ungranted.txt':'qa-fixture.txt'
        }
      }};
      await assert.rejects(f.authority.authorizeWorker(action),
        /WORKER_IDENTITY_|V012_NATIVE_WORKER_/);
    }finally{f.close();}
  }
});
