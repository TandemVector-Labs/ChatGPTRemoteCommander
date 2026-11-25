import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {activeHealthPort} from '../tools/enroll-owner-private-tunnel-linux.mjs';
import {
  normalizeLinuxOwnerTunnelPin,readLinuxOwnerTunnelPin,
  enrollLinuxOwnerTunnelPin,createPinnedLinuxPrivateTunnelIdentity
} from '../src/linux-private-tunnel-owner-pin.mjs';

const now=Date.now();
test('existing v1/v2 Linux owner PIN is selected by native attested seat, never overwritten',()=>{
 const source=fs.readFileSync(new URL('../tools/enroll-owner-private-tunnel-linux.mjs',import.meta.url),'utf8');
 assert.match(source,/resolveLinuxNativeWitnessEnrollmentMode/);
 assert.match(source,/pinnedOwnerSidHash:enrolledPin\.ownerSidHash/);
 assert.match(source,/v1:await v1Owner\.getOwnerSessionSnapshot\(\)/);
 assert.match(source,/v2:await v2Owner\.getOwnerSessionSnapshot\(\)/);
 assert.match(source,/selection\.mode==='host-uid-v2'\?v2Owner:v1Owner/);
 assert.match(source,/if\(enrolledPin\)\{\s*const enrolled=enrolledPin/);
});

const base=()=>({
  schema:1,kind:'linux-owner-private-one-tunnel',
  hostId:'emad-linux',profileId:'Emad',
  ownerSidHash:'a'.repeat(64),
  expectedExecutablePath:'/home/owner/bin/tunnel-client',
  expectedExecutableSha256:'b'.repeat(64),
  healthPort:47832,expectedClientLeafDerSha256:'c'.repeat(64),
  enrolledAtMs:now
});

test('Linux one-Tunnel owner record contains only bounded, exact non-secret pins',()=>{
  const record=base();
  assert.deepEqual({...normalizeLinuxOwnerTunnelPin(record,{nowMs:now})},record);
  for(const patch of [
    {schema:2},{kind:'shared-tunnel'},{profileId:'../Emad'},
    {hostId:'host with spaces'},{ownerSidHash:'x'},
    {expectedExecutablePath:'relative/tunnel-client'},
    {expectedExecutableSha256:'not-hash'},
    {expectedClientLeafDerSha256:'short'},
    {healthPort:0},{healthPort:65536},{enrolledAtMs:now+100_000},
    {enrolledAtMs:1}
  ])assert.throws(()=>normalizeLinuxOwnerTunnelPin({...record,...patch},{nowMs:now}),
    {code:'RC012_LINUX_OWNER_TRUST_RECORD_INVALID'});
  assert.throws(()=>normalizeLinuxOwnerTunnelPin({...record,apiKey:'secret'},{nowMs:now}),
    {code:'RC012_LINUX_OWNER_TRUST_RECORD_INVALID'});
  const trap={};
  for(const key of Object.keys(record))Object.defineProperty(trap,key,{
    enumerable:true,get(){throw Error('SHOULD_NOT_RUN');}
  });
  assert.throws(()=>normalizeLinuxOwnerTunnelPin(trap,{nowMs:now}),
    {code:'RC012_LINUX_OWNER_TRUST_RECORD_INVALID'});
  assert.throws(()=>normalizeLinuxOwnerTunnelPin(new Proxy(record,{}),{nowMs:now}),
    {code:'RC012_LINUX_OWNER_TRUST_RECORD_INVALID'});
});

test('Linux one-Tunnel owner enrollment requires explicit approval, stable process and exact readback',{
  skip:process.platform!=='linux'
},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc012-native-owner-tunnel-pin-'));
  const uid=process.getuid(),record=base();
  let approved=0,checked=0;
  try{
    fs.chmodSync(root,0o700);
    const denied=await enrollLinuxOwnerTunnelPin({
      directory:root,record,authorizeOwner:async()=>{approved++;return false;},
      verifyCurrent:async()=>{checked++;return true;}
    }).catch(error=>error);
    assert.equal(denied.code,'RC012_LINUX_OWNER_TRUST_CONSENT_REQUIRED');
    assert.equal(approved,1);
    assert.equal(checked,0);
    assert.equal(fs.existsSync(path.join(root,'owner-tunnel-trust.json')),false);
    const changed=await enrollLinuxOwnerTunnelPin({
      directory:root,record,authorizeOwner:async()=>{approved++;return true;},
      verifyCurrent:async()=>{checked++;return false;}
    }).catch(error=>error);
    assert.equal(changed.code,'RC012_LINUX_OWNER_TRUST_CHANGED_DURING_CONSENT');
    assert.equal(checked,1);
    assert.equal(fs.existsSync(path.join(root,'owner-tunnel-trust.json')),false);
    const a=await enrollLinuxOwnerTunnelPin({
      directory:root,record,authorizeOwner:async()=>{approved++;return true;},
      verifyCurrent:async()=>{checked++;return true;}
    });
    assert.equal(a.reused,false);
    assert.equal(a.ownerConsentRequested,true);
    assert.equal(approved,3);
    assert.equal(checked,2);
    const filename=path.join(root,'owner-tunnel-trust.json');
    assert.equal(fs.lstatSync(filename).mode&0o777,0o600);
    assert.equal(fs.lstatSync(filename).uid,uid);
    assert.deepEqual({...readLinuxOwnerTunnelPin({directory:root})},record);
    assert.doesNotMatch(fs.readFileSync(filename,'utf8'),/apiKey|tunnel_id|private_key/);
    const repeated=await enrollLinuxOwnerTunnelPin({
      directory:root,record,authorizeOwner:async()=>{throw Error('SPURIOUS_CONSENT');},
      verifyCurrent:async()=>{throw Error('SPURIOUS_RECHECK');}
    });
    assert.equal(repeated.reused,true);
    const drift=await enrollLinuxOwnerTunnelPin({
      directory:root,record:{...record,expectedExecutableSha256:'d'.repeat(64)},
      authorizeOwner:async()=>true,verifyCurrent:async()=>true
    }).catch(error=>error);
    assert.equal(drift.code,'RC012_LINUX_OWNER_TRUST_ALREADY_ENROLLED');
    fs.chmodSync(filename,0o644);
    assert.throws(()=>readLinuxOwnerTunnelPin({directory:root}),
      {code:'RC012_LINUX_OWNER_TRUST_FILE_UNSAFE'});
    fs.chmodSync(filename,0o600);
    fs.unlinkSync(filename);
    fs.symlinkSync(path.join(root,'valid-data'),filename);
    assert.throws(()=>readLinuxOwnerTunnelPin({directory:root}),
      {code:'RC012_LINUX_OWNER_TRUST_FILE_UNSAFE'});
    fs.unlinkSync(filename);
    fs.chmodSync(root,0o755);
    await assert.rejects(enrollLinuxOwnerTunnelPin({
      directory:root,record,authorizeOwner:async()=>true,
      verifyCurrent:async()=>true
    }),{code:'RC012_LINUX_OWNER_TRUST_DIRECTORY_UNSAFE'});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('approved Linux pin cannot bootstrap another native OS owner',{
  skip:process.platform!=='linux'
},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc012-owner-pin-bootstrap-'));
  const record=base();
  try{
    fs.chmodSync(root,0o700);
    await enrollLinuxOwnerTunnelPin({
      directory:root,record,authorizeOwner:async()=>true,
      verifyCurrent:async()=>true
    });
    await assert.rejects(createPinnedLinuxPrivateTunnelIdentity({
      directory:root,resolveOwnerSidHash:async()=>('d'.repeat(64))
    }),{code:'RC012_LINUX_OWNER_TRUST_CURRENT_OWNER_MISMATCH'});
    await assert.rejects(createPinnedLinuxPrivateTunnelIdentity({
      directory:root,resolveOwnerSidHash:null
    }),{code:'RC012_LINUX_OWNER_TRUST_BOOTSTRAP_REQUIRED'});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('selected YAML in a multi-profile directory is never borrowed from another owner profile',{
  skip:process.platform!=='linux'
},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc012-profile-selection-'));
  try{
    fs.chmodSync(root,0o700);
    const file=(name,port)=>{
      fs.writeFileSync(path.join(root,name+'.yaml'),
        'control_plane:\n  api_key: env:SYNTHETIC_TEST_ONLY\n'
        +'health:\n  listen_addr: "127.0.0.1:'+port+'"\n'
        +'mcp:\n  target_url: "http://127.0.0.1:49999"\n',
        {mode:0o600});
    };
    file('emad-mmz',47834);
    file('mmz-linux',47832);
    file('saeid-mmz',47833);
    const uid=process.getuid();
    assert.equal(activeHealthPort('mmz-linux',uid,root).port,47832);
    assert.equal(activeHealthPort('saeid-mmz',uid,root).port,47833);
    assert.equal(activeHealthPort('emad-mmz',uid,root).port,47834);
    assert.throws(()=>activeHealthPort('../emad-mmz',uid,root),
      {code:'RC012_SELECTED_OWNER_TUNNEL_PROFILE_REQUIRED'});
    assert.throws(()=>activeHealthPort('unknown',uid,root),
      {code:'RC012_SELECTED_OWNER_TUNNEL_PROFILE_REQUIRED'});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
