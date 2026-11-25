import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserController} from '../src/browser-tools.mjs';

const ctx={config:{powerMode:{enabled:true,browserControl:{enabled:true}}}};
const requested='https://intended.example';
const different='https://other-account.example';
const principal='uid:1000';
function exactReceipt(origin,now){
  return {browser:'firefox',provider:'browser-extension-owner',tabRef:'owner-tab-001234',
    ownerPrincipal:principal,origin,source:'INTERNAL_OWNER_TARGET_OBSERVER',
    sameOwnerSession:true,nativeConsentGranted:true,accountSessionVerified:true,
    effectUncertain:false,observedAtMs:now-400,expiresAtMs:now+5000};
}
test('attestation cannot override the caller-requested origin and select a different site',async()=>{
  const now=Date.now();
  const ctl=createBrowserController({closeInvoke:()=>{},ownerWindowObserver:async()=>[],
    ownerRouteAttestation:async()=>({
      requestedOrigin:different,
      ownerSession:true,ownerPrincipal:principal,nowMs:now,
      receipts:[exactReceipt(different,now)],
      verifyReceipt:async()=>true
    })});
  try{
    const plan=await ctl.execute(ctx,'browser_owner_route_plan',{targetUrl:requested+'/document'});
    assert.equal(plan.targetOrigin,requested);
    assert.equal(plan.status,'BLOCKED');
    assert.equal(plan.code,'EXISTING_OWNER_SESSION_NOT_ATTESTED');
    assert.equal(plan.selectedTabRef,null);
    assert.equal(plan.credentialsRead,false);
    assert.equal(plan.noImplicitOwnedBrowserFallback,true);
  }finally{ctl.close();}
});
test('matching native receipt still selects exact intended origin without browser launch',async()=>{
  const now=Date.now(),native=[];
  const ctl=createBrowserController({invoke:async call=>{native.push(call);throw Error('NO_BROWSER_LAUNCH_EXPECTED');},
    closeInvoke:()=>{},ownerWindowObserver:async()=>[],
    ownerRouteAttestation:async()=>({
      requestedOrigin:different,
      ownerSession:true,ownerPrincipal:principal,nowMs:now,
      receipts:[exactReceipt(requested,now)],
      verifyReceipt:async()=>true
    })});
  try{
    const plan=await ctl.execute(ctx,'browser_owner_route_plan',{targetUrl:requested+'/document'});
    assert.equal(plan.targetOrigin,requested);
    assert.equal(plan.status,'READY');
    assert.equal(plan.selectedTabRef,'owner-tab-001234');
    assert.equal(plan.requiresExecutionReverification,true);
    assert.deepEqual(native,[]);
  }finally{ctl.close();}
});
