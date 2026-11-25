import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserController, browserToolDefinitions } from '../src/browser-tools.mjs';
import { summarizeOwnerBrowserWindows } from '../src/browser-owner-window-inventory.mjs';

const ctx={config:{powerMode:{enabled:true,browserControl:{enabled:true},guiControl:{enabled:true}}}};
const uri='https://example.test/private?secret=must-not-echo';
const windowFixture=()=>[
 {pid:900,window_id:4901,app_name:'Brave-browser',title:'private document 123'},
 {pid:901,window_id:4902,app_name:'firefox_firefox',title:'signed-in account name'},
 {pid:902,window_id:4903,app_name:'AnyDesk',title:'session'},
 {pid:900,window_id:4901,app_name:'Brave-browser',title:'duplicate'}
];
test('public tool declares non-mutating browser owner plan, never a Chrome default',()=>{
 const t=browserToolDefinitions.find(x=>x.name==='browser_owner_route_plan');
 assert.ok(t);
 assert.equal(t.annotations.readOnlyHint,true);
 assert.deepEqual(t.inputSchema.required,['targetUrl']);
 assert.equal(t.inputSchema.additionalProperties,false);
});
test('native browser discovery filters non-browser applications, titles and duplicates',()=>{
 const x=summarizeOwnerBrowserWindows(windowFixture());
 assert.equal(x.windowCount,2);
 assert.equal(x.windows.length,2);
 assert.deepEqual(x.windows.map(y=>y.browser),['brave','firefox']);
 assert.ok(!JSON.stringify(x).includes('private document'));
 assert.ok(!JSON.stringify(x).includes('signed-in account name'));
 assert.equal(x.preferredBrowser,null);
 assert.equal(x.credentialsRead,false);
});
test('public owner plan discovers exact windows without starting a new browser',async()=>{
 const invoked=[];
 const ctl=createBrowserController({
  invoke:async x=>{invoked.push(x);return {ok:true,available:true,backend:'chromium-cdp',active:false};},
  ownerWindowObserver:async()=>windowFixture(),closeInvoke:()=>{}
 });
 try{
  const x=await ctl.execute(ctx,'browser_owner_route_plan',{targetUrl:uri});
  assert.equal(x.ok,true);
  assert.equal(x.targetOrigin,'https://example.test');
  assert.equal(x.code,'EXISTING_OWNER_SESSION_NOT_ATTESTED');
  assert.equal(x.ownerWindowDiscovery,'OWNER_NATIVE_OBSERVED');
  assert.equal(x.ownerWindows.length,2);
  assert.equal(x.preferredBrowser,null);
  assert.equal(x.noImplicitOwnedBrowserFallback,true);
  assert.equal(x.nativeOwnerConsentAndAccountVerificationRequired,true);
  assert.equal(x.credentialsRead,false);
  assert.equal(x.userDesktopTouched,false);
  assert.ok(!JSON.stringify(x).includes('private document'));
  assert.ok(!JSON.stringify(x).includes('secret=must-not-echo'));
  assert.equal(invoked.length,0,'must not launch Chromium or read its session');
 }finally{ctl.close();}
});
test('missing owner observer fails closed without a synthetic sign-in claim',async()=>{
 const ctl=createBrowserController({ownerWindowObserver:async()=>{throw Object.assign(
  Error('owner unavailable'),{code:'WORKSPACE_OWNER_SESSION_REQUIRED'});},closeInvoke:()=>{}});
 try{
  const x=await ctl.execute(ctx,'browser_owner_route_plan',{targetUrl:'https://example.test/'});
  assert.equal(x.status,'BLOCKED');
  assert.equal(x.ownerWindowDiscovery,'UNAVAILABLE');
  assert.equal(x.windowCount,0);
  assert.equal(x.credentialsRead,false);
  assert.equal(x.selectedTabRef,null);
 }finally{ctl.close();}
});
test('native trusted verifier is required before selecting one exact authorized tab',async()=>{
 const now=Date.now();
 const owner='sid:S-1-5-21-1234-5678-91011-1000';
 const receipt={
  browser:'brave',provider:'browser-extension-owner',tabRef:'owner-brave-123456',
  ownerPrincipal:owner,origin:'https://example.test',
  source:'INTERNAL_OWNER_TARGET_OBSERVER',
  sameOwnerSession:true,nativeConsentGranted:true,accountSessionVerified:true,
  effectUncertain:false,observedAtMs:now-1000,expiresAtMs:now+5000
 };
 const ctl=createBrowserController({
  ownerWindowObserver:async()=>windowFixture(),
  ownerRouteAttestation:async()=>({
   ownerSession:true,ownerPrincipal:owner,receipts:[receipt],
   verifyReceipt:async r=>r===receipt,nowMs:now
  }),closeInvoke:()=>{}
 });
 try {
  const x=await ctl.execute(ctx,'browser_owner_route_plan',{targetUrl:'https://example.test/path'});
  assert.equal(x.status,'READY');
  assert.equal(x.provider,'browser-extension-owner');
  assert.equal(x.selectedTabRef,'owner-brave-123456');
  assert.equal(x.requiresExecutionReverification,true);
  assert.equal(x.credentialsRead,false);
 }finally{ctl.close();}
});
test('unverified native attestation and conflicting accounts are blocked',async()=>{
 const now=Date.now(),owner='uid:1000';
 const make=(tabRef)=>({browser:'firefox',provider:'webdriver-bidi-native',
  tabRef,ownerPrincipal:owner,origin:'https://example.test',
  source:'INTERNAL_OWNER_TARGET_OBSERVER',sameOwnerSession:true,
  nativeConsentGranted:true,accountSessionVerified:true,effectUncertain:false,
  observedAtMs:now-300,expiresAtMs:now+4000});
 for(const {attest,code} of [
  {attest:()=>({ownerSession:true,ownerPrincipal:owner,receipts:[make('firefox-tab-111111')],
    verifyReceipt:async()=>false,nowMs:now}),code:'EXISTING_OWNER_SESSION_NOT_ATTESTED'},
  {attest:()=>({ownerSession:true,ownerPrincipal:owner,
    receipts:[make('firefox-tab-111111'),make('firefox-tab-222222')],
    verifyReceipt:async()=>true,nowMs:now}),code:'MULTIPLE_AUTHORIZED_OWNER_TABS'}
 ]){
  const ctl=createBrowserController({ownerWindowObserver:async()=>windowFixture(),
    ownerRouteAttestation:attest,closeInvoke:()=>{}});
  try {
   const x=await ctl.execute(ctx,'browser_owner_route_plan',{targetUrl:'https://example.test'});
   assert.equal(x.status,'BLOCKED');
   assert.equal(x.code,code);
   assert.equal(x.selectedTabRef,null);
  }finally{ctl.close();}
 }
});
test('invalid website and disabled Commander browser control are refused before effects',async()=>{
 const ctl=createBrowserController({ownerWindowObserver:async()=>{throw Error('must not run');},
  closeInvoke:()=>{}});
 try{
  await assert.rejects(ctl.execute(ctx,'browser_owner_route_plan',
   {targetUrl:'file:///etc/passwd'}),/BROWSER_URL_NOT_ALLOWED/);
  await assert.rejects(ctl.execute({config:{powerMode:{enabled:false,browserControl:{enabled:true}}}},
   'browser_owner_route_plan',{targetUrl:'https://example.test'}),/BROWSER_DISABLED/);
 }finally{ctl.close();}
});

test('existing-session-first policy prevents an implicit owned browser start',async()=>{
 const fs=await import('node:fs');
 const os=await import('node:os');
 const path=await import('node:path');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-v1-r30-owned-optin-'));
 const effects=[];
 const ctl=createBrowserController({
  invoke:async request=>{
   effects.push(request.action);
   if(request.action==='status')return {ok:true,backend:'chromium-cdp',available:true};
   if(request.action==='start')return {ok:true,browserProduct:'QA-owned-only'};
   if(request.action==='end')return {ok:true,closed:true};
   throw Error('UNEXPECTED_NATIVE_EFFECT');
  },closeInvoke:()=>{}
 });
 const secured={config:{instance:{profile:'qa-r30'},powerMode:{enabled:true,
  browserControl:{enabled:true,requireExplicitOwnedMode:true,profileRoot:root}}}};
 try {
  await assert.rejects(ctl.execute(secured,'browser_session_begin',{}),
   /BROWSER_EXPLICIT_OWNED_MODE_REQUIRED/);
  assert.deepEqual(effects,[],'refusal must occur before owned browser spawn');
  const status=await ctl.execute(secured,'browser_status',{});
  assert.equal(status.policy.requireExplicitOwnedMode,true);
  const begin=await ctl.execute(secured,'browser_session_begin',{mode:'isolated',ttlSeconds:30,profile:'qasmoke'});
  assert.equal(begin.mode,'isolated');
  assert.equal(begin.userDesktopTouched,false);
  assert.ok(effects.includes('start'));
  const end=await ctl.execute(secured,'browser_session_end',{lease:begin.lease});
  assert.equal(end.closed,true);
  assert.ok(effects.includes('end'));
 }finally{ctl.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('legacy owned-browser semantics remain intact when the new opt-in policy is disabled',async()=>{
 const events=[];
 const root=(await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(),'rc-v1-r30-legacy-'));
 const ctl=createBrowserController({invoke:async x=>{
  events.push(x.action);return x.action==='end'?{closed:true}:{ok:true};
 },closeInvoke:()=>{}});
 const ctx={config:{instance:{profile:'qa'},powerMode:{enabled:true,
  browserControl:{enabled:true,profileRoot:root}}}};
 try{
  const begin=await ctl.execute(ctx,'browser_session_begin',{ttlSeconds:30,profile:'qa'});
  assert.equal(begin.mode,'persistent');
  await ctl.execute(ctx,'browser_session_end',{lease:begin.lease});
  assert.deepEqual(events,['start','end']);
 }finally{ctl.close();(await import('node:fs')).rmSync(root,{recursive:true,force:true});}
});
