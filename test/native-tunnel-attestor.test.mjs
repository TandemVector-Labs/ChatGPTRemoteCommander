import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createNativeTunnelAttestor } from '../src/native-tunnel-attestor.mjs';

const HOST='host-labtop';
const PROFILE='mmz-emad-laptop';
const OWNER='a'.repeat(64);
const OTHER_OWNER='b'.repeat(64);
const EXEC_SHA='c'.repeat(64);
const EXEC_PATH='/opt/commander/tunnel-client';
const INSTANCE='ci_0123456789abcdef';
const NOW=1_000_000;
const processRecord=(changes={})=>({
  source:'native-process-attestor',pid:2556,profileId:PROFILE,
  profileArgumentVerified:true,matchCount:1,running:true,ownerSidHash:OWNER,
  executablePath:EXEC_PATH,executableSha256:EXEC_SHA,startedAtMs:900_000,...changes
});
const healthRecord=(changes={})=>({
  source:'native-tunnel-health-probe',pid:2556,profileId:PROFILE,
  ownerSidHash:OWNER,executablePath:EXEC_PATH,executableSha256:EXEC_SHA,
  startedAtMs:900_000,clientInstanceId:INSTANCE,authenticated:true,
  controlPlanePollOk:true,healthzStatus:200,readyzStatus:200,
  lastPollAtMs:999_000,...changes
});
function fixture(overrides={}){
  const state={
    now:NOW,owner:OWNER,process:processRecord(),health:healthRecord(),
    ownerCalls:0,processCalls:0,healthCalls:0,probeInput:null
  };
  const options={
    hostId:HOST,profileId:PROFILE,expectedExecutablePath:EXEC_PATH,
    expectedExecutableSha256:EXEC_SHA,
    resolveOwnerSidHash:async()=>{state.ownerCalls++;return state.owner;},
    resolveOwnedTunnelProcess:async()=>{state.processCalls++;return state.process;},
    probeTunnelHealth:async p=>{state.healthCalls++;state.probeInput=p;return state.health;},
    now:()=>state.now,maxAgeMs:120_000,attestationTtlMs:60_000,
    ...overrides
  };
  return {state,attestor:createNativeTunnelAttestor(options)};
}
function expectedTunnelHash(process=processRecord(),clientInstanceId=INSTANCE){
  return createHash('sha256').update(JSON.stringify([
    'commander.native-tunnel-attestor.v1',HOST,PROFILE,OWNER,process.executableSha256,
    process.pid,process.startedAtMs,clientInstanceId
  ]),'utf8').digest('hex');
}

test('returns only the V1-07 transport projection after exact process and authenticated poll checks',async()=>{
  const f=fixture();
  const value=await f.attestor.resolveTransportIdentity();
  assert.deepEqual(Object.keys(value).sort(),[
    'source','provider','profileId','tunnelIdHash','ownerSidHash','authenticated',
    'controlPlanePollOk','healthzStatus','readyzStatus','lastPollAtMs','expiresAtMs'
  ].sort());
  assert.equal(value.source,'native-tunnel-attestor');
  assert.equal(value.provider,'openai-secure-mcp-tunnel');
  assert.equal(value.profileId,PROFILE);
  assert.equal(value.tunnelIdHash,expectedTunnelHash());
  assert.equal(value.ownerSidHash,OWNER);
  assert.equal(value.authenticated,true);
  assert.equal(value.controlPlanePollOk,true);
  assert.equal(value.healthzStatus,200);
  assert.equal(value.readyzStatus,200);
  assert.equal(value.lastPollAtMs,999_000);
  assert.equal(value.expiresAtMs,1_060_000);
  assert.equal(JSON.stringify(value).includes(INSTANCE),false);
  assert.equal(f.state.ownerCalls,2);
  assert.equal(f.state.processCalls,2);
  assert.equal(f.state.healthCalls,1);
});

test('passes only the validated exact process identity to the health probe',async()=>{
  const f=fixture();
  await f.attestor.resolveTransportIdentity();
  assert.deepEqual(Object.keys(f.state.probeInput).sort(),[
    'source','pid','profileId','profileArgumentVerified','matchCount','running',
    'ownerSidHash','executablePath','executableSha256','startedAtMs'
  ].sort());
  assert.equal(f.state.probeInput.pid,2556);
  assert.equal(f.state.probeInput.profileId,PROFILE);
});

test('rejects a missing, ambiguous, stopped, or profile-unverified process',async t=>{
  for(const [name,changes] of [
    ['missing process',null],
    ['ambiguous profile', {matchCount:2}],
    ['stopped process',{running:false}],
    ['unverified profile argument',{profileArgumentVerified:false}],
    ['wrong profile',{profileId:'other-profile'}]
  ]){
    await t.test(name,async()=>{
      const f=fixture({resolveOwnedTunnelProcess:async()=>changes===null?null:processRecord(changes)});
      await assert.rejects(f.attestor.resolveTransportIdentity(),/NATIVE_TUNNEL_PROCESS_UNVERIFIED/);
      assert.equal(f.state.healthCalls,0);
    });
  }
});

test('rejects an untrusted owner or executable mismatch before probing health',async t=>{
  for(const [name,changes] of [
    ['owner mismatch',{ownerSidHash:OTHER_OWNER}],
    ['path mismatch',{executablePath:'/tmp/untrusted-tunnel-client'}],
    ['binary hash mismatch',{executableSha256:'d'.repeat(64)}]
  ]){
    await t.test(name,async()=>{
      const f=fixture({resolveOwnedTunnelProcess:async()=>processRecord(changes)});
      await assert.rejects(f.attestor.resolveTransportIdentity(),/NATIVE_TUNNEL_PROCESS_UNVERIFIED/);
      assert.equal(f.state.healthCalls,0);
    });
  }
});

test('rejects a health response bound to another PID, process start, profile, or owner',async t=>{
  for(const [name,changes] of [
    ['wrong PID',{pid:999}],
    ['wrong start time',{startedAtMs:900_001}],
    ['wrong profile',{profileId:'other-profile'}],
    ['wrong owner',{ownerSidHash:OTHER_OWNER}],
    ['wrong executable',{executablePath:'/tmp/other-client'}]
  ]){
    await t.test(name,async()=>{
      const f=fixture({probeTunnelHealth:async()=>healthRecord(changes)});
      await assert.rejects(f.attestor.resolveTransportIdentity(),/NATIVE_TUNNEL_HEALTH_UNVERIFIED/);
    });
  }
});

test('fails closed when authentication, control-plane poll, or health/readiness is not successful',async t=>{
  for(const [name,changes] of [
    ['unauthenticated',{authenticated:false}],
    ['poll failed',{controlPlanePollOk:false}],
    ['health unavailable',{healthzStatus:503}],
    ['readiness unavailable',{readyzStatus:404}]
  ]){
    await t.test(name,async()=>{
      const f=fixture({probeTunnelHealth:async()=>healthRecord(changes)});
      await assert.rejects(f.attestor.resolveTransportIdentity(),/NATIVE_TUNNEL_HEALTH_UNVERIFIED/);
    });
  }
});

test('rejects stale or future control-plane poll timestamps',async t=>{
  for(const [name,lastPollAtMs] of [
    ['stale',NOW-120_001],['future',NOW+1]
  ]){
    await t.test(name,async()=>{
      const f=fixture({probeTunnelHealth:async()=>healthRecord({lastPollAtMs})});
      await assert.rejects(f.attestor.resolveTransportIdentity(),/NATIVE_TUNNEL_HEALTH_STALE/);
    });
  }
});

test('rechecks process identity after the asynchronous health probe to defeat PID reuse',async()=>{
  let calls=0;
  const f=fixture({
    resolveOwnedTunnelProcess:async()=>{
      calls++;
      return calls===1?processRecord():processRecord({pid:2557,startedAtMs:900_001});
    }
  });
  await assert.rejects(f.attestor.resolveTransportIdentity(),/NATIVE_TUNNEL_PROCESS_CHANGED/);
});

test('rechecks OS owner identity after the asynchronous health probe',async()=>{
  let calls=0;
  const f=fixture({resolveOwnerSidHash:async()=>++calls===1?OWNER:OTHER_OWNER});
  await assert.rejects(f.attestor.resolveTransportIdentity(),/NATIVE_TUNNEL_OWNER_CHANGED/);
});

test('requires a bounded opaque client instance identifier and rejects credential-shaped extras',async t=>{
  for(const [name,changes] of [
    ['missing client instance',{clientInstanceId:undefined}],
    ['short client instance',{clientInstanceId:'short'}],
    ['whitespace client instance',{clientInstanceId:'not a valid instance'}],
    ['unexpected runtime API key',{runtimeApiKey:'must-not-be-accepted'}]
  ]){
    await t.test(name,async()=>{
      const f=fixture({probeTunnelHealth:async()=>healthRecord(changes)});
      await assert.rejects(f.attestor.resolveTransportIdentity(),/NATIVE_TUNNEL_HEALTH_UNVERIFIED/);
    });
  }
});

test('tunnel instance hash is stable across fresh polls but changes when the process instance changes',async()=>{
  const f=fixture();
  const first=await f.attestor.resolveTransportIdentity();
  f.state.health=healthRecord({lastPollAtMs:999_500});
  const second=await f.attestor.resolveTransportIdentity();
  assert.equal(first.tunnelIdHash,second.tunnelIdHash);
  f.state.health=healthRecord({clientInstanceId:'ci_fedcba9876543210',lastPollAtMs:999_600});
  const third=await f.attestor.resolveTransportIdentity();
  assert.notEqual(first.tunnelIdHash,third.tunnelIdHash);
});

test('clips attestation expiry to the last successful poll freshness window',async()=>{
  const f=fixture({attestationTtlMs:60_000,maxAgeMs:120_000});
  f.state.health=healthRecord({lastPollAtMs:NOW-110_000});
  const value=await f.attestor.resolveTransportIdentity();
  assert.equal(value.expiresAtMs,NOW+10_000);
});

test('rejects getter and Proxy process/health records without executing accessors',async t=>{
  await t.test('getter',async()=>{
    let touched=false;
    const value=processRecord();
    Object.defineProperty(value,'pid',{enumerable:true,get(){touched=true;return 2556;}});
    const f=fixture({resolveOwnedTunnelProcess:async()=>value});
    await assert.rejects(f.attestor.resolveTransportIdentity(),/NATIVE_TUNNEL_PROCESS_UNVERIFIED/);
    assert.equal(touched,false);
  });
  await t.test('Proxy',async()=>{
    const f=fixture({resolveOwnedTunnelProcess:async()=>new Proxy(processRecord(),{})});
    await assert.rejects(f.attestor.resolveTransportIdentity(),/NATIVE_TUNNEL_PROCESS_UNVERIFIED/);
  });
});

test('rejects invalid clock and invalid attestor configuration',async()=>{
  const f=fixture({now:()=>-1});
  await assert.rejects(f.attestor.resolveTransportIdentity(),/NATIVE_TUNNEL_CLOCK_INVALID/);
  assert.throws(()=>createNativeTunnelAttestor({
    hostId:HOST,profileId:PROFILE,expectedExecutablePath:'relative/tunnel-client',
    expectedExecutableSha256:EXEC_SHA,resolveOwnerSidHash:async()=>OWNER,
    resolveOwnedTunnelProcess:async()=>processRecord(),
    probeTunnelHealth:async()=>healthRecord()
  }),/NATIVE_TUNNEL_ATTESTOR_CONFIG_INVALID/);
});
