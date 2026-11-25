import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createNativeTailscaleDeviceAttestor} from '../src/native-tailscale-device-attestor.mjs';

const OWNER='a'.repeat(64),OTHER='b'.repeat(64),BINARY='c'.repeat(64);
const now=1_800_000_000_000;
const status=(changes={})=>({
  Version:'1.90.0',BackendState:'Running',HaveNodeKey:true,Health:[],
  Self:{ID:'n123456789',PublicKey:'nodekey:0123456789abcdef',Online:true},
  ...changes
});
function fixture(overrides={}){
  let owner=OWNER,clock=now,probe=status(),receipt={};
  const calls={owner:0,probe:0};
  const config={
    hostId:'aliemad-labtop',expectedExecutablePath:'/usr/bin/tailscale',
    expectedExecutableSha256:BINARY,now:()=>clock,
    resolveOwnerSidHash:async()=>{calls.owner++;return owner;},
    readTailscaleStatus:async()=>{
      calls.probe++;
      return{
        source:'native-tailscale-cli-probe',pid:4200,ownerSidHash:OWNER,
        executablePath:'/usr/bin/tailscale',executableSha256:BINARY,
        startedAtMs:clock-100,finishedAtMs:clock-50,exitCode:0,
        stdout:JSON.stringify(probe),...receipt
      };
    },...overrides
  };
  return{
    attestor:createNativeTailscaleDeviceAttestor(config),calls,
    setOwner:value=>{owner=value;},
    setClock:value=>{clock=value;},
    setStatus:value=>{probe=value;},
    setReceipt:value=>{receipt=value;}
  };
}
const hash=id=>createHash('sha256')
  .update(JSON.stringify(['commander.native-tailscale-device-attestor.v1','aliemad-labtop',id]),'utf8')
  .digest('hex');

test('attests the online local Tailscale node without returning its raw node ID or key',async()=>{
  const f=fixture(),result=await f.attestor.resolveDeviceIdentity();
  assert.deepEqual(result,{
    source:'native-device-attestor',provider:'tailscale',
    deviceIdHash:hash('n123456789'),ownerSidHash:OWNER,verified:true,
    attestedAtMs:now-50,expiresAtMs:now+60000
  });
  assert.equal(Object.hasOwn(result,'deviceId'),false);
  assert.equal(Object.hasOwn(result,'publicKey'),false);
  assert.equal(f.calls.owner,2);
  assert.equal(f.calls.probe,1);
});

test('accepts a native probe completed after attestation starts when the clock advances',async()=>{
  let clock=now;
  const f=fixture({
    now:()=>clock,
    readTailscaleStatus:async()=>{
      const startedAtMs=clock;
      clock+=25;
      return{
        source:'native-tailscale-cli-probe',pid:4200,ownerSidHash:OWNER,
        executablePath:'/usr/bin/tailscale',executableSha256:BINARY,
        startedAtMs,finishedAtMs:clock,exitCode:0,
        stdout:JSON.stringify(status())
      };
    }
  });
  const result=await f.attestor.resolveDeviceIdentity();
  assert.equal(result.verified,true);
  assert.equal(result.attestedAtMs,now+25);
  assert.equal(result.expiresAtMs,now+60025);
});

test('stable Tailscale node identity survives node public-key rotation',async()=>{
  const f=fixture();
  const first=await f.attestor.resolveDeviceIdentity();
  f.setClock(now+1000);
  f.setStatus({...status(),Self:{...status().Self,PublicKey:'nodekey:fedcba9876543210'}});
  const second=await f.attestor.resolveDeviceIdentity();
  assert.equal(second.deviceIdHash,first.deviceIdHash);
});

test('accepts a nil Health slice as the documented empty-health state',async()=>{
  const f=fixture();f.setStatus(status({Health:null}));
  const result=await f.attestor.resolveDeviceIdentity();
  assert.equal(result.verified,true);
});

test('fails closed when the local Tailscale backend is not ready or healthy',async t=>{
  for(const [name,change,code] of [
    ['backend stopped',{BackendState:'Stopped'},'NATIVE_TAILSCALE_BACKEND_NOT_READY'],
    ['missing node key',{HaveNodeKey:false},'NATIVE_TAILSCALE_BACKEND_NOT_READY'],
    ['health warning',{Health:['control-plane unavailable']},'NATIVE_TAILSCALE_HEALTH_NOT_CLEAN']
  ]){
    await t.test(name,async()=>{
      const f=fixture();f.setStatus(status(change));
      await assert.rejects(f.attestor.resolveDeviceIdentity(),new RegExp(code));
    });
  }
});

test('rejects offline, expired or malformed local self identity',async t=>{
  for(const [name,self,code] of [
    ['offline',{ID:'n123456789',PublicKey:'nodekey:0123456789abcdef',Online:false},'NATIVE_TAILSCALE_SELF_NOT_ONLINE'],
    ['expired',{ID:'n123456789',PublicKey:'nodekey:0123456789abcdef',Online:true,Expired:true},'NATIVE_TAILSCALE_SELF_EXPIRED'],
    ['missing stable ID',{PublicKey:'nodekey:0123456789abcdef',Online:true},'NATIVE_TAILSCALE_SELF_INVALID'],
    ['missing public key',{ID:'n123456789',Online:true},'NATIVE_TAILSCALE_SELF_INVALID']
  ]){
    await t.test(name,async()=>{
      const f=fixture();f.setStatus(status({Self:self}));
      await assert.rejects(f.attestor.resolveDeviceIdentity(),new RegExp(code));
    });
  }
});

test('rejects a nonzero CLI result, wrong owner or executable identity',async t=>{
  for(const [name,receipt,code] of [
    ['nonzero exit',{exitCode:1},'NATIVE_TAILSCALE_PROBE_UNVERIFIED'],
    ['wrong owner',{ownerSidHash:OTHER},'NATIVE_TAILSCALE_PROBE_UNVERIFIED'],
    ['wrong executable path',{executablePath:'/tmp/tailscale'},'NATIVE_TAILSCALE_PROBE_UNVERIFIED'],
    ['wrong executable hash',{executableSha256:'d'.repeat(64)},'NATIVE_TAILSCALE_PROBE_UNVERIFIED'],
    ['ambiguous process receipt',{extra:'not allowed'},'NATIVE_TAILSCALE_PROBE_UNVERIFIED']
  ]){
    await t.test(name,async()=>{
      const f=fixture();f.setReceipt(receipt);
      await assert.rejects(f.attestor.resolveDeviceIdentity(),new RegExp(code));
    });
  }
});

test('rejects malformed JSON and unexpected Tailscale schema drift',async t=>{
  await t.test('malformed JSON',async()=>{
    const f=fixture();
    f.setReceipt({stdout:'not-json'});
    await assert.rejects(f.attestor.resolveDeviceIdentity(),/NATIVE_TAILSCALE_STATUS_INVALID_JSON/);
  });
  await t.test('unknown backend state',async()=>{
    const f=fixture();f.setStatus({...status(),BackendState:'NewState'});
    await assert.rejects(f.attestor.resolveDeviceIdentity(),/NATIVE_TAILSCALE_BACKEND_NOT_READY/);
  });
  await t.test('missing Health field',async()=>{
    const f=fixture();const value=status();delete value.Health;f.setStatus(value);
    await assert.rejects(f.attestor.resolveDeviceIdentity(),/NATIVE_TAILSCALE_STATUS_INVALID/);
  });
});

test('rejects stale, future-dated, overlong and oversized CLI evidence',async t=>{
  await t.test('stale process receipt',async()=>{
    const f=fixture();f.setReceipt({finishedAtMs:now-200000,startedAtMs:now-200100});
    await assert.rejects(f.attestor.resolveDeviceIdentity(),/NATIVE_TAILSCALE_STATUS_STALE/);
  });
  await t.test('future process receipt',async()=>{
    const f=fixture();f.setReceipt({finishedAtMs:now+1});
    await assert.rejects(f.attestor.resolveDeviceIdentity(),/NATIVE_TAILSCALE_PROBE_UNVERIFIED/);
  });
  await t.test('overlong process receipt',async()=>{
    const f=fixture();f.setReceipt({startedAtMs:now-20000,finishedAtMs:now-50});
    await assert.rejects(f.attestor.resolveDeviceIdentity(),/NATIVE_TAILSCALE_PROBE_UNVERIFIED/);
  });
  await t.test('oversized stdout',async()=>{
    const f=fixture();f.setReceipt({stdout:'x'.repeat(1048577)});
    await assert.rejects(f.attestor.resolveDeviceIdentity(),/NATIVE_TAILSCALE_PROBE_UNVERIFIED/);
  });
});

test('rechecks the OS owner after the asynchronous native CLI probe',async()=>{
  let owner=OWNER;
  const f=fixture({resolveOwnerSidHash:async()=>owner});
  const original=f.attestor;
  // Replace the fixture's probe with a callback that changes owner mid-probe.
  const g=createNativeTailscaleDeviceAttestor({
    hostId:'aliemad-labtop',expectedExecutablePath:'/usr/bin/tailscale',
    expectedExecutableSha256:BINARY,now:()=>now,
    resolveOwnerSidHash:async()=>owner,
    readTailscaleStatus:async()=>{
      owner=OTHER;
      return{
        source:'native-tailscale-cli-probe',pid:4200,ownerSidHash:OWNER,
        executablePath:'/usr/bin/tailscale',executableSha256:BINARY,
        startedAtMs:now-100,finishedAtMs:now-50,exitCode:0,
        stdout:JSON.stringify(status())
      };
    }
  });
  await assert.rejects(g.resolveDeviceIdentity(),/NATIVE_TAILSCALE_OWNER_CHANGED/);
  assert.ok(original);
});

test('requires a pinned executable and trusted owner/probe callbacks',()=>{
  const valid={
    hostId:'aliemad-labtop',expectedExecutablePath:'/usr/bin/tailscale',
    expectedExecutableSha256:BINARY,resolveOwnerSidHash:async()=>OWNER,
    readTailscaleStatus:async()=>({})
  };
  assert.throws(()=>createNativeTailscaleDeviceAttestor({...valid,expectedExecutablePath:'relative'}),/NATIVE_TAILSCALE_ATTESTOR_CONFIG_INVALID/);
  assert.throws(()=>createNativeTailscaleDeviceAttestor({...valid,expectedExecutableSha256:'bad'}),/NATIVE_TAILSCALE_ATTESTOR_CONFIG_INVALID/);
  assert.throws(()=>createNativeTailscaleDeviceAttestor({...valid,resolveOwnerSidHash:null}),/NATIVE_TAILSCALE_ATTESTOR_CONFIG_INVALID/);
  assert.throws(()=>createNativeTailscaleDeviceAttestor({...valid,readTailscaleStatus:null}),/NATIVE_TAILSCALE_ATTESTOR_CONFIG_INVALID/);
});
