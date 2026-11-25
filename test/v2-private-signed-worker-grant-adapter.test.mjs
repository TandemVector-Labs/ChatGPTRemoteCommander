import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {deriveWorkerId} from '../src/worker-identity-authority.mjs';
import {createV2PrivateSignedWorkerGrantAdapter} from '../src/v2-private-signed-worker-grant-adapter.mjs';
import {createV2PrivatePairOperationGate} from '../src/v2-private-pair-operation-gate.mjs';

const NOW=1794475200000;
const OWNER='a'.repeat(64),TUNNEL='b'.repeat(64),BINDING='c'.repeat(64);
const DEVICE='d'.repeat(64),POLICY='e'.repeat(64);
const FIELDS=['issuer','audience','hostId','profileId','principalId',
  'conversationId','bindingId','workerId','ownerSidHash','deviceProvider',
  'deviceIdHash','tunnelProvider','tunnelIdHash','capabilityPolicyDigest',
  'grantRevision','issuedAtMs','expiresAtMs','nonce'];
const route=()=>({hostId:'pc1',profileId:'profileA',principalId:'accountA',
  conversationId:'chat1',operationId:'step1',target:{kind:'workflow-root',id:'project1'}});
const owner=()=>({source:'native-owner-attested',
  hostId:'pc1',profileId:'profileA',principalId:'accountA',conversationId:'chat1',
  bindingId:BINDING,ownerSidHash:OWNER,tunnelIdHash:TUNNEL,expiresAtMs:NOW+40000});

function fixture(patch={}){
  const state={currentRoute:route(),now:NOW,permission:true,
    calls:0,reads:0,identities:0,currentWorker:null};
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const der=publicKey.export({type:'spki',format:'der'});
  const keyId=createHash('sha256').update(der).digest('hex');
  const workerId=deriveWorkerId({hostId:'pc1',profileId:'profileA',
    ownerSidHash:OWNER,deviceProvider:'native-key-store',deviceIdHash:DEVICE,keyId});
  state.currentWorker=workerId;
  function register(changes={}){
    const claims={issuer:'commander.local',audience:'remote-commander',
      hostId:'pc1',profileId:'profileA',principalId:'accountA',conversationId:'chat1',
      bindingId:BINDING,workerId,ownerSidHash:OWNER,
      deviceProvider:'native-key-store',deviceIdHash:DEVICE,
      tunnelProvider:'openai-secure-mcp-tunnel',tunnelIdHash:TUNNEL,
      capabilityPolicyDigest:POLICY,grantRevision:1,
      issuedAtMs:NOW-1000,expiresAtMs:NOW+60000,nonce:'f'.repeat(32),...changes};
    const bytes=Buffer.from(JSON.stringify([
      'commander.worker.identity.v1',keyId,...FIELDS.map(k=>claims[k])]));
    return {schema:1,keyId,publicKey:der.toString('base64url'),claims,
      signature:sign(null,bytes,privateKey).toString('base64url')};
  }
  state.envelope=register();
  const dependency={
    hostId:'pc1',profileId:'profileA',principalId:'accountA',
    expectedTunnelIdHash:TUNNEL,expectedOwnerSidHash:OWNER,
    issuer:'commander.local',audience:'remote-commander',now:()=>state.now,
    workerRegistry:{get:async()=>{state.reads++;return state.envelope;}},
    workerAuthority:{authorizeWorker:async()=>{
      state.calls++;
      return state.permission?{authorized:true,workerId,keyId,bindingId:BINDING,
        capabilityPolicyDigest:POLICY,grantRevision:1,expiresAtMs:NOW+60000}:null;
    }},
    resolveCurrentWorkerId:async()=>{state.identities++;return state.currentWorker;},
    resolveCurrentOwnerRoute:async()=>state.currentRoute,...patch
  };
  const verify=createV2PrivateSignedWorkerGrantAdapter(dependency);
  const request=()=>({route:route(),tool:'run_shell',arguments:{cmd:'echo safe'},
    ownerContext:owner()});
  return {state,register,verify,request,dependency,workerId};
}

test('real Ed25519 enrollment and current worker binding allow only exact owner action',async()=>{
  const f=fixture();
  assert.equal(await f.verify(f.request()),true);
  assert.equal(f.state.calls,1);
  assert.ok(f.state.reads>=2);
  assert.ok(f.state.identities>=2);
});

test('signed envelope, native scope, epoch and revocation are fail closed',async t=>{
  for(const [name,edit] of [
    ['wrong signed tunnel',f=>f.state.envelope=f.register({tunnelIdHash:'1'.repeat(64)})],
    ['wrong signed owner',f=>f.state.envelope=f.register({ownerSidHash:'1'.repeat(64)})],
    ['different account',f=>f.state.envelope=f.register({principalId:'accountB'})],
    ['different signed binding',f=>f.state.envelope=f.register({bindingId:'1'.repeat(64)})],
    ['expired signature',f=>f.state.envelope=f.register({expiresAtMs:NOW-1})],
    ['forged signature',f=>f.state.envelope={...f.state.envelope,signature:'A'.repeat(86)}],
    ['revoked worker',f=>f.state.permission=false],
    ['different canonical target',f=>f.state.currentRoute={...route(),target:{kind:'workflow-root',id:'other'}}],
    ['different caller worker',f=>f.state.currentWorker='cw_'+'2'.repeat(64)],
    ['wrong owner context',f=>{const previous=f.request;f.request=()=>({...previous(),ownerContext:{...owner(),ownerSidHash:'1'.repeat(64)}});}]
  ])await t.test(name,async()=>{
    const f=fixture();edit(f);
    assert.equal(await f.verify(f.request()),false);
  });
});

test('changing route or durable signed registration during authorization fails closed',async()=>{
  const f=fixture();
  f.dependency.workerAuthority.authorizeWorker=async()=>{
    f.state.currentRoute={...route(),operationId:'step2'};
    return {authorized:true,workerId:f.workerId,keyId:f.state.envelope.keyId,
      bindingId:BINDING,capabilityPolicyDigest:POLICY,grantRevision:1,
      expiresAtMs:NOW+60000};
  };
  const check=createV2PrivateSignedWorkerGrantAdapter(f.dependency);
  assert.equal(await check(f.request()),false);
});

test('signed worker adapter composes with exact private operation gate, lease and receipt',async()=>{
  const f=fixture();
  let effects=0,grants=0;
  const check=async input=>{grants++;return f.verify(input);};
  const gate=createV2PrivatePairOperationGate({
    hostId:'pc1',profileId:'profileA',principalId:'accountA',
    expectedTunnelIdHash:TUNNEL,expectedOwnerSidHash:OWNER,now:()=>NOW,
    attestTransport:async()=>({authenticated:true,
      peerType:'owner-pinned-private-tunnel-mtls',
      sessionSource:'native-owner-private-pair'}),
    readCurrentOwnerSidHash:async()=>OWNER,
    resolveOwnerContext:async()=>owner(),
    verifyExactNativeGrant:check,
    withLease:async(_resource,work)=>work(),
    receiptStore:{execute:async(_receipt,work)=>work()},
    execute:async(_route,args)=>{effects++;return args.cmd;}
  });
  assert.equal(await gate.execute({request:{},route:route(),
    tool:'run_shell',arguments:{cmd:'echo safe'}}),'echo safe');
  assert.equal(grants,3);
  assert.equal(effects,1);
  f.state.permission=false;
  await assert.rejects(gate.execute({request:{},route:route(),
    tool:'run_shell',arguments:{cmd:'echo safe'}}),{code:'V2_GRANT_REQUIRED'});
  assert.equal(effects,1);
});

test('signed private worker verifier requires trusted authority and canonical registry',()=>{
  const f=fixture();
  for(const p of [
    {workerAuthority:null},{workerRegistry:null},
    {resolveCurrentWorkerId:null},{resolveCurrentOwnerRoute:null},
    {expectedTunnelIdHash:null},{expectedOwnerSidHash:null}
  ])assert.throws(()=>createV2PrivateSignedWorkerGrantAdapter({...f.dependency,...p}),
    {code:'V2_PRIVATE_SIGNED_WORKER_BOOTSTRAP_REQUIRED'});
});

test('current worker and owner route callbacks receive the independently verified native chat context',async()=>{
  const f=fixture();
  let routeChecks=0,workerChecks=0;
  const check=createV2PrivateSignedWorkerGrantAdapter({
    ...f.dependency,
    resolveCurrentOwnerRoute:async native=>{
      routeChecks++;
      assert.equal(native.source,'native-owner-attested');
      assert.equal(native.conversationId,'chat1');
      assert.equal(native.bindingId,BINDING);
      return route();
    },
    resolveCurrentWorkerId:async native=>{
      workerChecks++;
      assert.equal(native.conversationId,'chat1');
      assert.equal(native.bindingId,BINDING);
      return f.workerId;
    }
  });
  assert.equal(await check(f.request()),true);
  assert.equal(routeChecks,2);
  assert.equal(workerChecks,2);
});
