import test from 'node:test';
import assert from 'node:assert/strict';
import { planOwnerBrowserRoute } from '../src/browser-existing-session-route.mjs';

const now=1770000000000;
const owner='sid:S-1-5-21-1234-5678-91011-1000';
const base=()=>({
  requestedOrigin:'https://example.com/some/path?token=excluded',
  ownerPrincipal:owner,ownerSession:true,nowMs:now
});
const verified=(patch={})=>({
  browser:'brave',provider:'browser-extension-owner',
  tabRef:'owner-tab-abc123',ownerPrincipal:owner,
  origin:'https://example.com',source:'INTERNAL_OWNER_TARGET_OBSERVER',
  sameOwnerSession:true,nativeConsentGranted:true,accountSessionVerified:true,
  effectUncertain:false,observedAtMs:now-1000,expiresAtMs:now+6000,
  ...patch
});
test('never silently falls back to Chromium when no authenticated owner receipt exists', async()=>{
  const r=await planOwnerBrowserRoute(base());
  assert.equal(r.status,'BLOCKED');
  assert.equal(r.code,'EXISTING_OWNER_SESSION_NOT_ATTESTED');
  assert.equal(r.defaultBrowser,null);
  assert.equal(r.credentialsRead,false);
  assert.equal(r.ownedBrowserStarted,false);
});
test('an installed profile or forged ready flag cannot authorize a route',async()=>{
  const r=await planOwnerBrowserRoute({...base(),receipts:[verified({ready:true})]});
  assert.equal(r.status,'BLOCKED');
});
test('a verified, fresh exact Brave tab may be planned without reading credentials',async()=>{
  let calls=0;
  const r=await planOwnerBrowserRoute({...base(),receipts:[verified()],
    verifyReceipt:async x=>{calls++;return x.tabRef==='owner-tab-abc123';}});
  assert.equal(calls,1);
  assert.equal(r.status,'READY');
  assert.equal(r.browser,'brave');
  assert.equal(r.provider,'browser-extension-owner');
  assert.equal(r.requiresExecutionReverification,true);
  assert.equal(r.credentialsRead,false);
});
test('Firefox BiDi is a first-class equal browser family, not a Chromium fallback',async()=>{
  const r=await planOwnerBrowserRoute({...base(),
    receipts:[verified({browser:'firefox',provider:'webdriver-bidi-native'})],
    verifyReceipt:async()=>true});
  assert.equal(r.status,'READY');
  assert.equal(r.browser,'firefox');
  assert.equal(r.provider,'webdriver-bidi-native');
});
test('multiple different verified accounts never choose a default',async()=>{
  const r=await planOwnerBrowserRoute({...base(),
    receipts:[verified(),verified({browser:'firefox',provider:'webdriver-bidi-native',
      tabRef:'owner-tab-xyz456'})],verifyReceipt:async()=>true});
  assert.equal(r.status,'BLOCKED');
  assert.equal(r.code,'MULTIPLE_AUTHORIZED_OWNER_TABS');
});
test('expiry, stale observation, wrong owner and wrong origin are all rejected',async()=>{
  const variants=[
    {expiresAtMs:now},
    {observedAtMs:now-16000,expiresAtMs:now-1000},
    {ownerPrincipal:'sid:S-1-5-21-1-1-1-1000'},
    {origin:'https://other.example.com'},
    {nativeConsentGranted:false},
    {accountSessionVerified:false},
    {sameOwnerSession:false},
    {effectUncertain:true},
    {source:'PUBLIC_CALLER_ASSERTION'}
  ];
  for(const patch of variants){
    const r=await planOwnerBrowserRoute({...base(),receipts:[verified(patch)],
      verifyReceipt:async()=>true});
    assert.equal(r.status,'BLOCKED',JSON.stringify(patch));
  }
});
test('no owner session fails closed even with a purported valid receipt',async()=>{
  const r=await planOwnerBrowserRoute({...base(),ownerSession:false,
    receipts:[verified()],verifyReceipt:async()=>true});
  assert.equal(r.code,'OWNER_SESSION_REQUIRED');
});
test('a denied or failed native verifier cannot result in READY',async()=>{
  const r=await planOwnerBrowserRoute({...base(),receipts:[verified()],
    verifyReceipt:async()=>{throw Error('BROWSER_CONSENT_DENIED');}});
  assert.equal(r.code,'EXISTING_OWNER_SESSION_NOT_ATTESTED');
});
test('explicit isolated fallback is reported as opt-in, not executed',async()=>{
  const r=await planOwnerBrowserRoute({...base(),allowOwnedFallback:true});
  assert.equal(r.code,'EXPLICIT_OWNED_FALLBACK_ONLY');
  assert.equal(r.ownedFallbackAllowed,true);
  assert.equal(r.ownedBrowserStarted,false);
  assert.equal(r.status,'BLOCKED');
});
test('rejects unsupported origin schemes and invalid owner inputs',async()=>{
  await assert.rejects(planOwnerBrowserRoute({...base(),requestedOrigin:'file:///etc/passwd'}),
    /BROWSER_OWNER_ROUTE_INVALID_INPUT/);
  await assert.rejects(planOwnerBrowserRoute({...base(),ownerPrincipal:'user'}),
    /BROWSER_OWNER_ROUTE_INVALID_INPUT/);
  await assert.rejects(planOwnerBrowserRoute({...base(),receipts:new Array(65).fill({})}),
    /BROWSER_OWNER_ROUTE_INVALID_INPUT/);
});

test('browser controller exposes verified owner-first route without launching Chromium',async()=>{
  const { createBrowserController }=await import('../src/browser-tools.mjs');
  const calls=[];
  const ctl=createBrowserController({invoke:async req=>{
    calls.push(req);return {ok:true,available:true,active:false};},closeInvoke:()=>{}});
  try{
    const r=await ctl.planExistingSession({...base(),receipts:[verified()],
      verifyReceipt:async()=>true});
    assert.equal(r.status,'READY');
    assert.equal(r.provider,'browser-extension-owner');
    assert.equal(calls.length,0,'planning must not spawn a Chromium helper');
  }finally{ctl.close();}
});
