import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveLinuxNativeWitnessEnrollmentMode}
  from '../src/linux-native-witness-enrollment-mode.mjs';
const snap={
  osSessionId:'linux-logind-4',seatId:'seat0',
  displayId:':0',sessionType:'x11',leaderPid:1234
};
const one={...snap,ownerSidHash:'a'.repeat(64)};
const two={...snap,ownerSidHash:'b'.repeat(64)};
function select(pin,v1=one,v2=two){
  return resolveLinuxNativeWitnessEnrollmentMode({
    pinnedOwnerSidHash:pin,v1,v2
  });
}
test('existing namespace-v1 PIN is supported with a stable v2 witness',()=>{
  const x=select(one.ownerSidHash);
  assert.equal(x.mode,'namespace-v1');
  assert.equal(x.pinnedOwnerSidHash,one.ownerSidHash);
  assert.equal(x.signedOwnerSidHash,two.ownerSidHash);
});
test('owner-approved migrated host-uid-v2 PIN is supported without re-enrollment',()=>{
  const x=select(two.ownerSidHash);
  assert.equal(x.mode,'host-uid-v2');
  assert.equal(x.signedOwnerSidHash,two.ownerSidHash);
});
test('never accept an unbound or ambiguous owner or a changed native seat',()=>{
  for(const run of [
    ()=>select('c'.repeat(64)),
    ()=>select(one.ownerSidHash,one,{...two,ownerSidHash:one.ownerSidHash}),
    ()=>select(one.ownerSidHash,one,{...two,leaderPid:1235}),
    ()=>select(one.ownerSidHash,one,{...two,osSessionId:'linux-logind-5'}),
    ()=>select(one.ownerSidHash,one,{...two,seatId:'seat1'}),
    ()=>select(one.ownerSidHash,one,{...two,displayId:':1'}),
    ()=>select(one.ownerSidHash,one,{...two,sessionType:'wayland'}),
    ()=>select(one.ownerSidHash,{...one,leaderPid:0},two),
    ()=>select(one.ownerSidHash,{...one,displayId:''},{...two,displayId:''}),
    ()=>select('invalid'),
    ()=>select(one.ownerSidHash,null,two)
  ])assert.throws(run,/RC012_NATIVE_WITNESS_/);
});
test('fail closed if observer only knows one native identity snapshot',()=>{
  assert.throws(()=>resolveLinuxNativeWitnessEnrollmentMode({
    pinnedOwnerSidHash:one.ownerSidHash,v1:one
  }),{code:'RC012_NATIVE_WITNESS_OWNER_SNAPSHOT_INVALID'});
});
