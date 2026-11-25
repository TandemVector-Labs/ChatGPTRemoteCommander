import test from 'node:test';
import assert from 'node:assert/strict';
import {qualifyNoPromoteQuarantine} from '../tools/qa-v012-no-promote-ingress.mjs';

const baseline=()=>({
  status:'BLOCKED',code:'V2_AUTHENTICATED_INGRESS_ABSENT',
  observations:{
    health:{status:200},legacyAnonymous:{status:403},
    legacyForged:{status:403},v2Anonymous:{status:404},
    v2Forged:{status:404},metadata:{status:404}
  }
});

test('v0.12 NoPromote accepts only protected candidate negative admission, never a positive G1/J01 grant',()=>{
 const a=qualifyNoPromoteQuarantine(baseline());
 assert.equal(a.status,'V012_NOPROMOTE_NEGATIVE_ONLY_PASS');
 assert.equal(a.positiveG1Proved,false);
 assert.equal(a.ownerJ01Proved,false);
 assert.equal(a.privilegedExecutionProved,false);
 assert.equal(a.publicReleaseApproved,false);
 assert.equal(a.activeRouteChanged,false);
});
test('NoPromote accepts fully negative v2 readiness separately from actual owner admission',()=>{
 const a=baseline();
 a.status='NEGATIVE_PREFLIGHT_PASS';a.code='ANONYMOUS_AND_FORGED_DENIAL_ONLY';
 a.observations.v2Anonymous.status=403;
 a.observations.v2Forged.status=403;
 a.observations.metadata.status=200;
 assert.equal(qualifyNoPromoteQuarantine(a).protectedV2State,'NEGATIVE_DENIAL_ONLY');
});
test('real protected v0.12 runtime denies every non-health route before V2 is wired',()=>{
 const a=baseline();
 a.code='V2_RESOURCE_METADATA_UNVERIFIED';
 a.observations.v2Anonymous.status=403;
 a.observations.v2Forged.status=403;
 a.observations.metadata.status=403;
 const out=qualifyNoPromoteQuarantine(a);
 assert.equal(out.protectedV2State,'ALL_ROUTES_QUARANTINED');
 assert.equal(out.positiveG1Proved,false);
 assert.equal(out.publicReleaseApproved,false);
 for(const [field,status] of [['metadata',404],['v2Anonymous',200],['v2Forged',200]]){
   const bad=structuredClone(a);
   bad.observations[field].status=status;
   assert.throws(()=>qualifyNoPromoteQuarantine(bad),/V012_NOPROMOTE_/);
 }
});

test('NoPromote rejects anonymous discovery, missing 403, missing health and inconsistent v2 metadata',()=>{
 for(const [field,value] of [
   ['legacyAnonymous',200],['legacyAnonymous',401],['legacyForged',200],
   ['health',404],['metadata',200],['v2Anonymous',403],['v2Forged',403]
 ]){
  const a=baseline();a.observations[field].status=value;
  assert.throws(()=>qualifyNoPromoteQuarantine(a),/V012_NOPROMOTE_/);
 }
 for(const edit of [
   a=>{a.status='NEGATIVE_PREFLIGHT_PASS';},
   a=>{a.code='LEGACY_ANONYMOUS_DISCOVERY_EXPOSED';},
   a=>{delete a.observations;},
   a=>{a.observations.v2Anonymous.status=200;}
 ]){
  const a=baseline();edit(a);
  assert.throws(()=>qualifyNoPromoteQuarantine(a),/V012_NOPROMOTE_/);
 }
});
