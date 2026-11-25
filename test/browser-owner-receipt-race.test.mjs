import test from 'node:test';
import assert from 'node:assert/strict';
import {planOwnerBrowserRoute} from '../src/browser-existing-session-route.mjs';

const owner='uid:1000';
const origin='https://owner-dashboard.example';
function good(nowMs,change={}) {
 return {browser:'firefox',provider:'browser-extension-owner',
  tabRef:'owner-legitimate-tab-1',ownerPrincipal:owner,
  origin,source:'INTERNAL_OWNER_TARGET_OBSERVER',
  sameOwnerSession:true,nativeConsentGranted:true,accountSessionVerified:true,
  effectUncertain:false,observedAtMs:nowMs-10,
  expiresAtMs:nowMs+5000,...change};
}
function input(nowMs,receipts,verifyReceipt) {
 return {requestedOrigin:origin,ownerPrincipal:owner,ownerSession:true,nowMs,
  receipts,verifyReceipt};
}
test('async verifier cannot switch the selected owner tab after prevalidation',async()=>{
 const t=Date.now();
 const r=good(t);
 const result=await planOwnerBrowserRoute(input(t,[r],async target=>{
  target.tabRef='attacker-other-tab-99';
  target.origin='https://other-account.example';
  return true;
 }));
 assert.equal(result.status,'BLOCKED');
 assert.equal(result.selectedTabRef??null,null);
 assert.equal(result.code,'EXISTING_OWNER_SESSION_NOT_ATTESTED');
});
test('receipt expiring during async verifier must not return a READY plan',async()=>{
 const t=Date.now();
 const r=good(t,{expiresAtMs:t+900});
 let entered=false;
 const result=await planOwnerBrowserRoute(input(t,[r],async()=>{
  entered=true;
  await new Promise(resolve=>setTimeout(resolve,1100));
  return true;
 }));
 assert.equal(entered,true,'verifier must have been reached before expiry');
 assert.equal(result.status,'BLOCKED');
 assert.equal(result.code,'EXISTING_OWNER_SESSION_NOT_ATTESTED');
});
test('stable timely native attestation remains selectable and immutable',async()=>{
 const t=Date.now();
 const r=good(t);
 const result=await planOwnerBrowserRoute(input(t,[r],async()=>true));
 assert.equal(result.status,'READY');
 assert.equal(result.tabRef,'owner-legitimate-tab-1');
 assert.equal(result.ownerSessionSelected,true);
 assert.equal(Object.isFrozen(result),true);
});
test('a verifier modifying consent and expiry after initial checks cannot authorize a tab',async()=>{
 const t=Date.now();
 const r=good(t);
 const result=await planOwnerBrowserRoute(input(t,[r],async target=>{
  target.nativeConsentGranted=false;
  target.expiresAtMs=t-1;
  return true;
 }));
 assert.equal(result.status,'BLOCKED');
});
