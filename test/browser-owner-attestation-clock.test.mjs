import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserController} from '../src/browser-tools.mjs';

const ctx={config:{powerMode:{enabled:true,browserControl:{enabled:true}}}};
const origin='https://precise-owner.example';
const owner='uid:1000';
const tabRef='verified-owner-tab-0001';

function receipt({observedAtMs,expiresAtMs}) {
 return {browser:'firefox',provider:'browser-extension-owner',tabRef,
  ownerPrincipal:owner,origin,source:'INTERNAL_OWNER_TARGET_OBSERVER',
  sameOwnerSession:true,nativeConsentGranted:true,accountSessionVerified:true,
  effectUncertain:false,observedAtMs,expiresAtMs};
}
function controller(evidence) {
 const native=[];
 const ctl=createBrowserController({
  invoke:async x=>{native.push(x);throw Error('NATIVE_BROWSER_MUST_NOT_LAUNCH');},
  closeInvoke:()=>{},ownerWindowObserver:async()=>[],
  ownerRouteAttestation:async()=>evidence
 });
 return {ctl,native};
}
test('stale signed owner tab cannot be revived by a broker-supplied historical clock',async()=>{
 const actual=Date.now();
 const historical=actual-24*60*60*1000;
 const {ctl,native}=controller({
  ownerSession:true,ownerPrincipal:owner,nowMs:historical+1000,
  receipts:[receipt({observedAtMs:historical,expiresAtMs:historical+5000})],
  verifyReceipt:async()=>true
 });
 try{
  const plan=await ctl.execute(ctx,'browser_owner_route_plan',{targetUrl:origin+'/user'});
  assert.equal(plan.status,'BLOCKED');
  assert.equal(plan.code,'EXISTING_OWNER_SESSION_NOT_ATTESTED');
  assert.equal(plan.selectedTabRef,null);
  assert.equal(plan.nativeOwnerConsentAndAccountVerificationRequired,true);
  assert.deepEqual(native,[]);
 }finally{ctl.close();}
});
test('fresh signed owner tab is not rejected by a broker-supplied inaccurate clock',async()=>{
 const actual=Date.now();
 const {ctl,native}=controller({
  ownerSession:true,ownerPrincipal:owner,nowMs:actual-48*60*60*1000,
  receipts:[receipt({observedAtMs:actual-1000,expiresAtMs:actual+10_000})],
  verifyReceipt:async()=>true
 });
 try{
  const plan=await ctl.execute(ctx,'browser_owner_route_plan',{targetUrl:origin+'/user'});
  assert.equal(plan.status,'READY');
  assert.equal(plan.selectedTabRef,tabRef);
  assert.equal(plan.requiresExecutionReverification,true);
  assert.deepEqual(native,[]);
 }finally{ctl.close();}
});
