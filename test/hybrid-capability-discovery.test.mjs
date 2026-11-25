import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverHybridCapabilities} from '../src/hybrid-capability-discovery.mjs';
import {createWorkspaceController} from '../src/workspace-tools.mjs';
import {createMemoryWorkspaceJournal} from '../src/workspace-target-journal.mjs';
const now=1800000000000;
const installed={nativeWindowsUIA:true,linuxATSPI:true,ownedBrowser:true,visualFallback:true};
const receipt=(id)=>({providerId:id,ready:true,ownerSession:true,scope:'CURRENT_HOST',
 observedAtMs:now-1000,expiresAtMs:now+10000});
test('installed native/owned browser scripts alone cannot assert live readiness',async()=>{
 const r=await discoverHybridCapabilities({platform:'win32',ownerSession:true,installed,nowMs:now});
 assert.equal(r.capabilities.windowsUIA,false);
 assert.equal(r.capabilities.commanderOwnedBrowser,false);
 assert.equal(r.evidence['windows-uia-native'].status,'INSTALLED_NOT_ATTESTED');
 assert.equal(r.defaultFallback,'NO_UNVERIFIED_PROVIDER');
});
test('a fresh internal exact-provider owner receipt enables only that provider',async()=>{
 const r=await discoverHybridCapabilities({platform:'win32',ownerSession:true,installed,nowMs:now,
   verify:async(id)=>id==='windows-uia-native'?receipt(id):null});
 assert.equal(r.capabilities.windowsUIA,true);
 assert.equal(r.capabilities.commanderOwnedBrowser,false);
 assert.equal(r.capabilities.cuaVerifiedOwnerTarget,false);
});
test('Linux semantic adapter requires actual session, evidence and matching platform',async()=>{
 const missing=await discoverHybridCapabilities({platform:'linux',ownerSession:false,installed,nowMs:now,
   verify:async(id)=>receipt(id)});
 assert.equal(missing.capabilities.linuxATSPI,false);
 assert.equal(missing.evidence['linux-atspi-native'].status,'OWNER_SESSION_REQUIRED');
 const yes=await discoverHybridCapabilities({platform:'linux',ownerSession:true,installed,nowMs:now,
   verify:async(id)=>receipt(id)});
 assert.equal(yes.capabilities.linuxATSPI,true);
 assert.equal(yes.capabilities.windowsUIA,false);
});
test('expired, future, wrong identity, wrong scope and malformed probes fail closed',async()=>{
 for(const patch of [
   {expiresAtMs:now},{observedAtMs:now+1},{observedAtMs:now-31000},
   {scope:'OTHER_HOST'},{providerId:'windows-uia-native'},{ownerSession:false},
   {ready:1},{observedAtMs:'now'},null
 ]){
   const x=patch===null?null:{...receipt('linux-atspi-native'),...patch};
   const r=await discoverHybridCapabilities({platform:'linux',ownerSession:true,installed,nowMs:now,
     verify:async()=>x});
   assert.equal(r.capabilities.linuxATSPI,false,JSON.stringify(patch));
 }
});
test('uninstalled provider and probe exceptions cannot become ready',async()=>{
 const no=await discoverHybridCapabilities({platform:'win32',ownerSession:true,installed:{},nowMs:now,
   verify:async()=>{throw Error('should not run');}});
 assert.equal(no.evidence['windows-uia-native'].status,'BACKEND_NOT_INSTALLED');
 const crash=await discoverHybridCapabilities({platform:'win32',ownerSession:true,installed,nowMs:now,
   verify:async()=>{throw Error('driver timeout');}});
 assert.equal(crash.capabilities.windowsUIA,false);
});
test('Cua visual path needs exact current verified target, not merely feature flag',async()=>{
 const r=await discoverHybridCapabilities({platform:'linux',ownerSession:true,installed,nowMs:now,
   verify:async(id)=>id==='cua-last-resort'?receipt(id):null});
 assert.equal(r.capabilities.cuaVerifiedOwnerTarget,true);
 assert.equal(r.capabilities.linuxATSPI,false);
});
test('planner never claims browser READY from installed but unverified helper',async()=>{
 const ctl=createWorkspaceController({platform:'linux',env:{XDG_RUNTIME_DIR:'/run/user/1000',
   DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus'},ownerSession:async()=>true,
   hybridProbe:async()=>({capabilities:{commanderWorkflow:true,commanderOwnedBrowser:false,
    windowsUIA:false,linuxATSPI:false,cuaVerifiedOwnerTarget:false},
    evidence:{'commander-owned-browser':{status:'INSTALLED_NOT_ATTESTED'}}}),
   journal:createMemoryWorkspaceJournal()});
 const out=await ctl.execute('workspace_agentos_plan',{target:'new-browser'});
 assert.equal(out.status,'BLOCKED');
 assert.equal(out.code,'OWNED_BROWSER_UNAVAILABLE');
 assert.equal(out.evidence['commander-owned-browser'].status,'INSTALLED_NOT_ATTESTED');
 assert.equal(out.autoElevate,false);
});
test('planner may choose owner-verified native semantic route without changing execution authorization',async()=>{
 const ctl=createWorkspaceController({platform:'win32',env:{},ownerSession:async()=>true,
   hybridProbe:async()=>({capabilities:{commanderWorkflow:true,commanderOwnedBrowser:false,
    windowsUIA:true,linuxATSPI:false,cuaVerifiedOwnerTarget:false},evidence:{'windows-uia-native':{status:'VERIFIED_READY'}}}),
   journal:createMemoryWorkspaceJournal()});
 const out=await ctl.execute('workspace_agentos_plan',{target:'existing-app'});
 assert.equal(out.status,'BLOCKED');assert.equal(out.providerCandidate,'windows-uia-native');
 assert.equal(out.code,'EXACT_OWNER_TARGET_ATTESTATION_REQUIRED');
 assert.equal(out.evidence['windows-uia-native'].status,'VERIFIED_READY');
 assert.equal(out.execution,'COMMANDER_POLICY_ENFORCED');
 assert.equal(out.autoElevate,false);
});
test('malformed inputs cannot spoof discovery receipts',async()=>{
 for(const x of [{platform:'darwin'},{platform:'linux',installed:[]},{platform:'linux',verify:1},{platform:'win32',nowMs:NaN}])
   await assert.rejects(discoverHybridCapabilities(x),/HYBRID_DISCOVERY_INPUT_INVALID/);
});

import {chooseAgentOSProvider} from '../src/agentos-provider-router.mjs';
test('hybrid browser fallbacks only list explicitly available alternatives in priority order',()=>{
 const r=chooseAgentOSProvider({platform:'linux',ownerSession:true,target:'new-browser',
  capabilities:{playwrightOwned:true,chromeDevtoolsOwned:true,commanderOwnedBrowser:true},
  application:{purpose:'chatgpt-connection'}});
 assert.equal(r.provider,'playwright-mcp');
 assert.deepEqual(r.fallbackProviders,['chrome-devtools-mcp','commander-owned-browser']);
 assert.equal(r.fallbackAllowed,true);
 assert.equal(r.fallbackMode,'REPLAN_ONLY_AFTER_FRESH_OBSERVATION');
 assert.equal(r.uncertainEffectsNeverAutoRetried,true);
});
test('native Windows GUI alternatives require a separate verified exact CUA fallback grant',()=>{
 const input={platform:'win32',ownerSession:true,target:'existing-app',
  application:{nativeAPI:true},capabilities:{ufo2AppAgent:true,windowsUIA:true,cuaVerifiedOwnerTarget:true},
  grants:{nativeApplication:true}};
 const no=chooseAgentOSProvider(input);
 assert.deepEqual(no.fallbackProviders,['windows-uia-native']);
 const yes=chooseAgentOSProvider({...input,grants:{...input.grants,visualFallback:true}});
 assert.deepEqual(yes.fallbackProviders,['windows-uia-native','cua-last-resort']);
});
test('single ready backend does not imply a backup path exists',()=>{
 const a=chooseAgentOSProvider({platform:'linux',ownerSession:true,target:'new-browser',
  capabilities:{commanderOwnedBrowser:true},application:{purpose:'chatgpt-connection'}});
 assert.equal(a.status,'READY');assert.equal(a.fallbackAllowed,false);
 assert.deepEqual(a.fallbackProviders,[]);
 assert.equal(a.uncertainEffectsNeverAutoRetried,true);
});
test('blocked project and unowned browser cannot suggest or execute fallback',()=>{
 for(const x of [
  {platform:'linux',target:'project',capabilities:{}},
  {platform:'win32',target:'existing-browser',ownerSession:false,capabilities:{chromeDevtoolsExistingAuthorized:true}}
 ]){
  const r=chooseAgentOSProvider(x);
  assert.equal(r.status,'BLOCKED');assert.equal(r.fallbackAllowed,false);
  assert.deepEqual(r.fallbackProviders,[]);
 }
});

import {probeLinuxAtspiSession,classifyOwnedBrowserStatus} from '../src/hybrid-capability-discovery.mjs';
test('live read-only AT-SPI status distinguishes enabled session from actionable target',async()=>{
 const on=await probeLinuxAtspiSession({platform:'linux',ownerSession:true,
  env:{XDG_RUNTIME_DIR:'/run/user/1000',DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus'},
  nowMs:now,run:async()=>({stdout:'b true\n'})});
 assert.equal(on.status,'AT_SPI_SESSION_BUS_ENABLED_TARGET_UNVERIFIED');
 assert.equal(on.sessionBusReady,true);assert.equal(on.ready,false);
 const off=await probeLinuxAtspiSession({platform:'linux',ownerSession:true,
  env:{XDG_RUNTIME_DIR:'/run/user/1000',DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus'},
  nowMs:now,run:async()=>({stdout:'b false\n'})});
 assert.equal(off.status,'AT_SPI_SESSION_BUS_DISABLED');assert.equal(off.ready,false);
});
test('AT-SPI probe rejects missing owner, session, invalid output and transport failure',async()=>{
 for(const args of [
  {ownerSession:false,env:{XDG_RUNTIME_DIR:'/run/user/1000',DBUS_SESSION_BUS_ADDRESS:'a'}},
  {ownerSession:true,env:{}},
  {ownerSession:true,env:{XDG_RUNTIME_DIR:'/tmp/fake',DBUS_SESSION_BUS_ADDRESS:'a'}}
 ]){
  const a=await probeLinuxAtspiSession({platform:'linux',nowMs:now,...args,run:async()=>{throw Error('must not run')}});
  assert.equal(a.ready,false);assert.equal(a.status,'AT_SPI_OWNER_SESSION_MISSING');
 }
 for(const stub of [async()=>{throw Error('unreachable')},async()=>({stdout:'b any\n'})]){
  const a=await probeLinuxAtspiSession({platform:'linux',ownerSession:true,nowMs:now,
    env:{XDG_RUNTIME_DIR:'/run/user/1000',DBUS_SESSION_BUS_ADDRESS:'a'},run:stub});
  assert.equal(a.status,'AT_SPI_SESSION_BUS_UNAVAILABLE');
 }
});
test('read-only browser status preserves launchable vs leased vs uncertain without inventing auth',()=>{
 const idle=classifyOwnedBrowserStatus({ok:true,enabled:true,available:true,active:false});
 assert.equal(idle.status,'BROWSER_AVAILABLE_IDLE');assert.equal(idle.ready,false);
 const leased=classifyOwnedBrowserStatus({ok:true,enabled:true,available:true,active:true,leased:true,
   backgroundOnly:true,userDesktopTouched:false});
 assert.equal(leased.status,'BROWSER_SESSION_EXISTS_OWNER_LEASE_REQUIRED');
 assert.equal(leased.ready,false);
 const uncertain=classifyOwnedBrowserStatus({ok:true,enabled:true,available:true,
   uncertain:true});
 assert.equal(uncertain.status,'BROWSER_OUTCOME_RECONCILIATION_REQUIRED');
 assert.equal(uncertain.ready,false);
 assert.equal(classifyOwnedBrowserStatus({ok:true,available:true,enabled:false}).status,'BROWSER_HELPER_UNAVAILABLE');
});

import {createBrowserController} from '../src/browser-tools.mjs';
test('browser-readiness snapshot is pure state inspection and never starts helper',()=>{
 let invoked=0;
 const c=createBrowserController({invoke:async()=>{invoked++;return {ok:true};},
   closeInvoke:()=>{},now:()=>1000,scheduleTimeout:()=>({unref(){}})});
 const cfg={config:{powerMode:{enabled:true,browserControl:{enabled:true}}}};
 const before=c.readinessSnapshot(cfg);
 assert.equal(before.source,'CONTROLLER_MEMORY');
 assert.equal(before.active,false);
 assert.equal(before.available,false);
 assert.equal(before.leased,false);
 assert.equal(before.enabled,true);
 assert.equal(invoked,0);
 assert.equal(classifyOwnedBrowserStatus(before).status,'BROWSER_NO_ACTIVE_OWNER_LEASE');
 c.close();assert.equal(invoked,0);
});

import {verifyBoundOwnerTargetReceipt} from '../src/hybrid-capability-discovery.mjs';
const boundReceipt=(overrides={})=>({
 source:'INTERNAL_OWNER_TARGET_OBSERVER',providerId:'linux-atspi-native',
 target:'existing-app',ownerPrincipal:'uid:1000',scope:'CURRENT_HOST',
 ownerSession:true,ready:true,targetIdentityVerified:true,effectUncertain:false,
 observedAtMs:now-1000,expiresAtMs:now+7000,pid:2345,windowId:4567,...overrides
});
test('exact owner-target receipt validates matching PID/HWND/principal/provider within 15s',()=>{
 const r=verifyBoundOwnerTargetReceipt({receipt:boundReceipt(),providerId:'linux-atspi-native',
   target:'existing-app',selector:{pid:2345,windowId:4567},ownerPrincipal:'uid:1000',nowMs:now});
 assert.equal(r.valid,true);
});
test('owner target receipt rejects cross-process/window/user/provider and replay/clock mismatch',()=>{
 const baseline={providerId:'linux-atspi-native',target:'existing-app',
  selector:{pid:2345,windowId:4567},ownerPrincipal:'uid:1000',nowMs:now};
 for(const mod of [
  {receipt:boundReceipt({pid:2346})},{receipt:boundReceipt({windowId:9999})},
  {receipt:boundReceipt({providerId:'windows-uia-native'})},
  {receipt:boundReceipt({ownerPrincipal:'uid:1001'})},
  {receipt:boundReceipt({source:'CALLER_SUPPLIED'})},
  {receipt:boundReceipt({scope:'OTHER_HOST'})},
  {receipt:boundReceipt({effectUncertain:true})},
  {receipt:boundReceipt({targetIdentityVerified:false})},
  {receipt:boundReceipt({observedAtMs:now+1})},
  {receipt:boundReceipt({expiresAtMs:now})},
  {receipt:boundReceipt({observedAtMs:now-16000})},
  {selector:{pid:2345,windowId:4568}},
  {ownerPrincipal:'uid:1001'},
  {receipt:null}
 ]){
  const r=verifyBoundOwnerTargetReceipt({...baseline,...mod});
  assert.equal(r.valid,false,JSON.stringify(mod));
 }
});
test('exact tabRef browser owner binding cannot be reused for another tab or app',()=>{
 const receipt=boundReceipt({providerId:'chrome-devtools-mcp',target:'existing-browser',tabRef:'ownerTab_123456'});
 const base={receipt,providerId:'chrome-devtools-mcp',target:'existing-browser',ownerPrincipal:'uid:1000',nowMs:now};
 assert.equal(verifyBoundOwnerTargetReceipt({...base,selector:{tabRef:'ownerTab_123456'}}).valid,true);
 assert.equal(verifyBoundOwnerTargetReceipt({...base,selector:{tabRef:'ownerTab_654321'}}).valid,false);
 assert.equal(verifyBoundOwnerTargetReceipt({...base,target:'existing-app',selector:{pid:2345,windowId:4567}}).valid,false);
});
test('workspace planner refuses generic ready provider when exact existing app is not matched',async()=>{
 const ctl=createWorkspaceController({platform:'linux',ownerSession:async()=>true,
  hybridProbe:async()=>({capabilities:{commanderWorkflow:true,linuxATSPI:true},
   evidence:{'linux-atspi-native':{status:'VERIFIED_READY'}}})});
 const r=await ctl.execute('workspace_agentos_plan',{target:'existing-app',pid:2345,windowId:4567});
 assert.equal(r.status,'BLOCKED');assert.equal(r.code,'EXACT_OWNER_TARGET_ATTESTATION_REQUIRED');
 assert.deepEqual(r.fallbackProviders,[]);assert.equal(r.autoElevate,false);
});
test('workspace planner selects exact owner target only from bound internal observation',async()=>{
 const owner='uid:'+process.getuid();
 const ctl=createWorkspaceController({platform:'linux',ownerSession:async()=>true,
  hybridProbe:async()=>({capabilities:{commanderWorkflow:true,linuxATSPI:true},
   evidence:{'linux-atspi-native':{status:'VERIFIED_READY'}},
   targetReceipt:boundReceipt({ownerPrincipal:owner,observedAtMs:Date.now()-1000,expiresAtMs:Date.now()+7000})})});
 const r=await ctl.execute('workspace_agentos_plan',{target:'existing-app',pid:2345,windowId:4567});
 assert.equal(r.status,'READY');assert.equal(r.provider,'linux-atspi-native');
 assert.equal(r.targetBound,true);assert.equal(r.autoElevate,false);
});

test('real native owner observer memory issues a short-lived exact Windows UIA target plan',async()=>{
 let time=1800000000000,calls=0;
 const ctl=createWorkspaceController({
  platform:'win32',ownerSession:async()=>true,now:()=>time,
  nativeCall:async(op,input)=>{
   calls++;
   assert.equal(op,'Observe');
   return {ok:true,provider:'windows-uia-native',pid:input.pid,
     windowHandle:input.windowId,principalSid:'S-1-5-21-12345-67890-123456-1001',
     physicalInputTouched:false,foregroundTouched:false,elements:[]};
  }
 });
 const selector={target:'existing-app',pid:2345,windowId:4567};
 const before=await ctl.execute('workspace_agentos_plan',selector);
 assert.equal(before.status,'BLOCKED');
 const observed=await ctl.execute('workspace_native_ui_observe',{
   pid:2345,windowId:4567,application:'brave'});
 assert.equal(observed.ok,true);
 const after=await ctl.execute('workspace_agentos_plan',selector);
 assert.equal(after.status,'READY');
 assert.equal(after.provider,'windows-uia-native');
 assert.equal(after.targetBound,true);
 assert.equal(after.readOnlyPlan,true);
 assert.equal(calls,1);
 const wrongWindow=await ctl.execute('workspace_agentos_plan',{...selector,windowId:4568});
 assert.equal(wrongWindow.status,'BLOCKED');
 time+=15001;
 const expired=await ctl.execute('workspace_agentos_plan',selector);
 assert.equal(expired.status,'BLOCKED');
});
test('native observe lacking target-token SID or preserved desktop state never issues plan readiness',async()=>{
 for(const sample of [
   {principalSid:null,foregroundTouched:false},
   {principalSid:'S-1-5-21-111-222-333-1001',foregroundTouched:true},
   {principalSid:'not-a-SID',foregroundTouched:false}
 ]){
   const ctl=createWorkspaceController({platform:'win32',ownerSession:async()=>true,
     nativeCall:async()=>({ok:true,provider:'windows-uia-native',pid:2345,windowHandle:4567,
       physicalInputTouched:false,elements:[],...sample})});
   await ctl.execute('workspace_native_ui_observe',{pid:2345,windowId:4567,application:'brave'});
   const outcome=await ctl.execute('workspace_agentos_plan',{target:'existing-app',pid:2345,windowId:4567});
   assert.equal(outcome.status,'BLOCKED',JSON.stringify(sample));
 }
});
