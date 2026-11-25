import test from 'node:test';
import assert from 'node:assert/strict';
import {agentosProviders,chooseAgentOSProvider} from '../src/agentos-provider-router.mjs';
import {GUI_UNIVERSAL_POLICY,validateGuiProviderDescriptor,evaluateGuiTakeover,mustReleaseGuiLease,classifyGuiActionOutcome} from '../src/gui-universal-policy.mjs';
import {createGuiNativeSessionProvider} from '../src/gui-native-session-provider.mjs';
import './gui-libei-receiver.test.mjs';
import './gui-linux-input-capture-provider.test.mjs';
const base={platform:'win32',ownerSession:true,target:'existing-app',capabilities:{windowsUIA:true}};
test('native UIA chosen ahead of CUA for exact owner Windows application',()=>{
 const r=chooseAgentOSProvider({...base,capabilities:{windowsUIA:true,cuaVerifiedOwnerTarget:true},grants:{visualFallback:true}});
 assert.equal(r.provider,'windows-uia-native');assert.equal(r.mode,'SEMANTIC_UI');assert.equal(r.autoElevate,false);
});
test('native Windows app API UFO2 outranks UIA when application-specific consent exists',()=>{
 const r=chooseAgentOSProvider({...base,application:{nativeAPI:true},grants:{nativeApplication:true},
  capabilities:{ufo2AppAgent:true,windowsUIA:true}});
 assert.equal(r.provider,'ufo2-app-native');
});
test('ungranted UFO2 app API falls back to native UIA without privilege escalation',()=>{
 const r=chooseAgentOSProvider({...base,application:{nativeAPI:true},capabilities:{ufo2AppAgent:true,windowsUIA:true}});
 assert.equal(r.provider,'windows-uia-native');assert.equal(r.autoElevate,false);
});
test('existing user session cannot be borrowed from Windows SYSTEM or other owner',()=>{
 const r=chooseAgentOSProvider({...base,ownerSession:false,capabilities:{windowsUIA:true,cuaVerifiedOwnerTarget:true},grants:{visualFallback:true}});
 assert.equal(r.code,'OWNER_SESSION_REQUIRED');assert.equal(r.status,'BLOCKED');
});
test('Linux AT-SPI chosen ahead of CUA',()=>{
 const r=chooseAgentOSProvider({platform:'linux',ownerSession:true,target:'existing-app',capabilities:{linuxATSPI:true,cuaVerifiedOwnerTarget:true},grants:{visualFallback:true}});
 assert.equal(r.provider,'linux-atspi-native');
});
test('Cua visual requires separate precise target grant and is last resort',()=>{
 const input={...base,capabilities:{cuaVerifiedOwnerTarget:true}};
 assert.equal(chooseAgentOSProvider(input).code,'SEMANTIC_PROVIDER_UNAVAILABLE');
 assert.equal(chooseAgentOSProvider({...input,grants:{visualFallback:true}}).provider,'cua-last-resort');
});
test('existing browser explicitly protects personal profile and requires browser native consent',()=>{
 const input={...base,target:'existing-browser',application:{browserFamily:'chrome',profileKind:'custom'},capabilities:{chromeDevtoolsExistingAuthorized:true}};
 assert.equal(chooseAgentOSProvider(input).code,'BROWSER_OWNER_CONSENT_REQUIRED');
 assert.equal(chooseAgentOSProvider({...input,grants:{browserProfileAttach:true}}).provider,'chrome-devtools-mcp');
 assert.equal(chooseAgentOSProvider({...input,grants:{browserProfileAttach:true},capabilities:{}}).code,'BROWSER_EXISTING_PROFILE_ROUTE_UNAVAILABLE');
});
test('Playwright has priority for authorized DOM and Commander existing fallback for owned browser',()=>{
 const input={...base,target:'new-browser',application:{purpose:'chatgpt-connection'},capabilities:{playwrightOwned:true,chromeDevtoolsOwned:true,commanderOwnedBrowser:true}};
 assert.equal(chooseAgentOSProvider(input).provider,'playwright-mcp');
 assert.equal(chooseAgentOSProvider({...input,capabilities:{commanderOwnedBrowser:true}}).provider,'commander-owned-browser');
});
test('Codex app-server is planner not a magic OS permission',()=>{
 const r=chooseAgentOSProvider({...base,ownerSession:false,capabilities:{codexAppServer:true,codexAuthenticated:true,windowsUIA:true}});
 assert.equal(r.planner,'codex-app-server');assert.equal(r.code,'OWNER_SESSION_REQUIRED');
});
test('Commander workflow remains the orchestrator for general projects',()=>{
 const r=chooseAgentOSProvider({...base,target:'project',capabilities:{commanderWorkflow:true,codexAppServer:true,codexAuthenticated:true}});
 assert.equal(r.provider,'commander-workflow');assert.equal(r.planner,'codex-app-server');
});
test('safety and metadata contract is stable',()=>{
 for(const x of Object.values(agentosProviders))assert.ok(x.transport&&x.kind);
 for(const target of ['existing-browser','new-browser','existing-app','new-app','project']){
  for(const platform of ['win32','linux']){
   const r=chooseAgentOSProvider({target,platform,ownerSession:true});
   assert.equal(r.autoElevate,false);assert.equal(r.credentials,'NEVER_COPY');assert.equal(r.foreground,'PRESERVE');
  }
 }
});
test('fail closed for invalid or malformed request',()=>{
 for(const x of [{target:'x',platform:'win32'},{target:'new-app',platform:'darwin'},{target:'new-app',platform:'linux',capabilities:[]}]){
  assert.throws(()=>chooseAgentOSProvider(x),/AGENTOS_INPUT_INVALID/);
 }
});

const nowMs=1_800_000_000_000;
const session={ownerPrincipal:'uid:1000',sessionId:'session-7',seatId:'seat-0',displayId:'display-0',interactive:true,ownerAuthenticated:true};
const provider={providerId:'test-native-provider',platform:'linux',transport:'test-native',session,
 activityEvidenceSource:'physical',activityEvidenceIncludesSynthetic:false,isolationAuthority:null,
 capabilities:{observe:true,screenshot:true,activityDetection:true,physicalInputProtection:true,emergencyRelease:true,
 pointer:true,keyboard:true,semanticInvoke:true,isolatedDesktop:false}};
const activity=(idleMs=10_000,extra={})=>({source:'physical',reliable:true,excludesSyntheticInput:true,observedAtMs:nowMs,idleMs,...extra});
const input=(overrides={})=>({nowMs,provider,expectedSession:session,currentTaskExplicit:true,
 requestedInput:{pointer:true,keyboard:true},activityEvidence:activity(),approvalPromptVisible:false,
 approvalPromptElapsedMs:0,approvalDenied:false,physicalActivityAfterPrompt:false,
 explicitOwnerApproval:false,incidentPending:false,localStopActive:false,ownerRevoked:false,leaseTtlSeconds:120,
 inputProtectionReceipt:{active:true,kind:'NATIVE_PHYSICAL_INPUT_PROTECTION',providerId:provider.providerId,sessionId:session.sessionId,leaseId:'fixture-protection-lease',releaseOnAgentExit:true,releaseOnEmergency:true,expiresAtMs:nowMs+120000},...overrides});

test('policy constants preserve 60 second rule and bounded lease',()=>{assert.equal(GUI_UNIVERSAL_POLICY.ownerIdleAutoApprovalMs,60000);assert.equal(GUI_UNIVERSAL_POLICY.approvalPromptAutoApprovalMs,60000);assert.equal(GUI_UNIVERSAL_POLICY.maximumLeaseSeconds,120);});
test('same provider contract accepts Windows, Linux, macOS and future POSIX labels',()=>{for(const platform of ['win32','linux','darwin','freebsd'])assert.equal(validateGuiProviderDescriptor({...provider,platform}).status,'VALID');});
test('malformed descriptors and non-interactive sessions are rejected',()=>{assert.equal(validateGuiProviderDescriptor(null).code,'GUI_PROVIDER_DESCRIPTOR_INVALID');assert.equal(validateGuiProviderDescriptor({...provider,session:{...session,interactive:false}}).code,'GUI_PROVIDER_DESCRIPTOR_INVALID');assert.equal(validateGuiProviderDescriptor({...provider,capabilities:{...provider.capabilities,pointer:1}}).code,'GUI_PROVIDER_CAPABILITY_INVALID');});
test('provider cannot claim physical activity when its source includes synthetic events',()=>{assert.equal(validateGuiProviderDescriptor({...provider,activityEvidenceIncludesSynthetic:true}).code,'GUI_ACTIVITY_EVIDENCE_NOT_PHYSICAL');});
test('isolated desktop requires explicit owner authority',()=>{const p={...provider,isolationAuthority:'',capabilities:{...provider.capabilities,physicalInputProtection:false,isolatedDesktop:true}};assert.equal(validateGuiProviderDescriptor(p).code,'GUI_ISOLATION_NOT_OWNER_AUTHORIZED');});
test('current task must explicitly request GUI',()=>{assert.equal(evaluateGuiTakeover(input({currentTaskExplicit:false})).code,'GUI_CURRENT_TASK_AUTHORIZATION_REQUIRED');});
test('exact owner principal, OS session, seat and display are bound',()=>{assert.equal(evaluateGuiTakeover(input({expectedSession:{...session,sessionId:'other'}})).code,'GUI_OWNER_SESSION_MISMATCH');assert.equal(evaluateGuiTakeover(input({expectedSession:{...session,ownerPrincipal:'uid:2000'}})).code,'GUI_OWNER_SESSION_MISMATCH');});
test('pending incident blocks all new takeover',()=>{assert.equal(evaluateGuiTakeover(input({incidentPending:true})).code,'GUI_INCIDENT_REVIEW_REQUIRED');});
test('local stop, owner revoke and denial are hard stops',()=>{assert.equal(evaluateGuiTakeover(input({localStopActive:true})).code,'GUI_LOCAL_STOP');assert.equal(evaluateGuiTakeover(input({ownerRevoked:true})).code,'GUI_OWNER_REVOKED');assert.equal(evaluateGuiTakeover(input({approvalDenied:true})).code,'GUI_OWNER_DENIED');});
test('stale, absent or synthetic activity evidence cannot become consent',()=>{assert.equal(evaluateGuiTakeover(input({activityEvidence:null})).code,'GUI_ACTIVITY_EVIDENCE_UNAVAILABLE_OR_STALE');assert.equal(evaluateGuiTakeover(input({activityEvidence:activity(80000,{observedAtMs:nowMs-6000})})).code,'GUI_ACTIVITY_EVIDENCE_UNAVAILABLE_OR_STALE');assert.equal(evaluateGuiTakeover(input({activityEvidence:activity(80000,{source:'synthetic'})})).code,'GUI_ACTIVITY_EVIDENCE_UNAVAILABLE_OR_STALE');});
test('60s reliable physical inactivity admits bounded lease',()=>{const r=evaluateGuiTakeover(input({activityEvidence:activity(60000)}));assert.equal(r.status,'GRANTED');assert.equal(r.approvalMode,'AUTO_IDLE_60S');assert.equal(r.expiresAtMs,nowMs+120000);assert.equal(r.autoReplay,false);});
test('59,999ms idle remains waiting for owner',()=>{assert.equal(evaluateGuiTakeover(input({activityEvidence:activity(59999)})).status,'WAITING_OWNER');});
test('unrejected approval prompt auto-approves at 60 seconds',()=>{const r=evaluateGuiTakeover(input({approvalPromptVisible:true,approvalPromptElapsedMs:60000}));assert.equal(r.status,'GRANTED');assert.equal(r.approvalMode,'AUTO_UNREJECTED_PROMPT_60S');});
test('an unrejected 60-second approval prompt admits even when the owner remains physically active',()=>{const r=evaluateGuiTakeover(input({approvalPromptVisible:true,approvalPromptElapsedMs:60000,physicalActivityAfterPrompt:true,activityEvidence:activity(1000)}));assert.equal(r.status,'GRANTED');assert.equal(r.approvalMode,'AUTO_UNREJECTED_PROMPT_60S');});
test('explicit approval admits immediately',()=>{const r=evaluateGuiTakeover(input({explicitOwnerApproval:true}));assert.equal(r.status,'GRANTED');assert.equal(r.approvalMode,'EXPLICIT');});
test('shared desktop takeover requires physical-input protection',()=>{const p={...provider,capabilities:{...provider.capabilities,physicalInputProtection:false,isolatedDesktop:false}};assert.equal(evaluateGuiTakeover(input({provider:p})).code,'GUI_PHYSICAL_INPUT_PROTECTION_UNAVAILABLE');});
test('owner-authorized isolated desktop can replace input blocking',()=>{const p={...provider,isolationAuthority:'owner-approved',capabilities:{...provider.capabilities,physicalInputProtection:false,isolatedDesktop:true}};const r=evaluateGuiTakeover(input({provider:p,explicitOwnerApproval:true,inputProtectionReceipt:{active:true,kind:'OWNER_APPROVED_ISOLATED_DESKTOP',providerId:provider.providerId,sessionId:session.sessionId,leaseId:'isolated-fixture-lease',releaseOnAgentExit:true,releaseOnEmergency:true,expiresAtMs:nowMs+120000}}));assert.equal(r.status,'GRANTED');assert.equal(r.inputProtection,'OWNER_APPROVED_ISOLATED_DESKTOP');});
test('missing emergency release or requested input capability blocks takeover',()=>{const p={...provider,capabilities:{...provider.capabilities,emergencyRelease:false}};assert.equal(evaluateGuiTakeover(input({provider:p})).code,'GUI_REQUIRED_PROVIDER_CAPABILITY_UNAVAILABLE');const p2={...provider,capabilities:{...provider.capabilities,keyboard:false}};assert.equal(evaluateGuiTakeover(input({provider:p2})).code,'GUI_KEYBOARD_UNAVAILABLE');});
test('semantic UI alone does not substitute for input protection',()=>{const p={...provider,capabilities:{...provider.capabilities,physicalInputProtection:false,isolatedDesktop:false,semanticInvoke:true}};assert.equal(evaluateGuiTakeover(input({provider:p})).code,'GUI_PHYSICAL_INPUT_PROTECTION_UNAVAILABLE');});
test('activity timestamp cannot be in the future',()=>{assert.equal(evaluateGuiTakeover(input({activityEvidence:activity(65000,{observedAtMs:nowMs+1})})).code,'GUI_ACTIVITY_EVIDENCE_UNAVAILABLE_OR_STALE');});
test('lease TTL is bounded',()=>{assert.equal(evaluateGuiTakeover(input({leaseTtlSeconds:121,activityEvidence:activity(65000)})).code,'GUI_LEASE_TTL_INVALID');assert.equal(evaluateGuiTakeover(input({leaseTtlSeconds:9,explicitOwnerApproval:true})).code,'GUI_LEASE_TTL_INVALID');});
test('emergency events revoke a GUI lease',()=>{for(const event of GUI_UNIVERSAL_POLICY.emergencyEvents)assert.equal(mustReleaseGuiLease(event),true,event);assert.equal(mustReleaseGuiLease('NORMAL_SCREENSHOT'),false);});
test('native acknowledgement alone is not completion',()=>{const r=classifyGuiActionOutcome({actionIssued:true,nativeAcknowledged:true,foregroundStatus:'PRESERVED',independentVerification:false});assert.equal(r.status,'ACKNOWLEDGED_UNVERIFIED');assert.equal(r.autoReplay,false);});
test('changed and unobservable foreground are never a non-interference pass',()=>{for(const foregroundStatus of ['CHANGED','UNOBSERVABLE']){const r=classifyGuiActionOutcome({actionIssued:true,nativeAcknowledged:true,foregroundStatus,independentVerification:true});assert.equal(r.status,'UNCERTAIN');assert.equal(r.autoReplay,false);}});
test('unknown effect or lost acknowledgement is never replayed',()=>{const r=classifyGuiActionOutcome({actionIssued:true,nativeAcknowledged:false,foregroundStatus:'UNOBSERVABLE'});assert.equal(r.status,'UNCERTAIN');assert.equal(r.retryPolicy,'OWNER_RECONCILIATION_REQUIRED');assert.equal(r.autoReplay,false);});
test('only independently verified preserved foreground is VERIFIED',()=>{const r=classifyGuiActionOutcome({actionIssued:true,nativeAcknowledged:true,foregroundStatus:'PRESERVED',independentVerification:true});assert.equal(r.status,'VERIFIED');assert.equal(r.autoReplay,false);});

test('direct physical approval is accepted even though the owner acted during the prompt',()=>{const r=evaluateGuiTakeover(input({explicitOwnerApproval:true,physicalActivityAfterPrompt:true}));assert.equal(r.status,'GRANTED');assert.equal(r.approvalMode,'EXPLICIT');});

test('provider capability alone is insufficient without an active owner-session protection receipt',()=>{
 const r=evaluateGuiTakeover(input({explicitOwnerApproval:true,inputProtectionReceipt:null}));
 assert.equal(r.status,'BLOCKED');assert.equal(r.code,'GUI_INPUT_PROTECTION_NOT_ACQUIRED');
});
test('input protection receipt must match exact provider and owner session and release on exit',()=>{
 for(const receipt of [
  {...input().inputProtectionReceipt,providerId:'different'},
  {...input().inputProtectionReceipt,sessionId:'different'},
  {...input().inputProtectionReceipt,releaseOnAgentExit:false},
  {...input().inputProtectionReceipt,releaseOnEmergency:false},
  {...input().inputProtectionReceipt,expiresAtMs:nowMs}
 ]) assert.equal(evaluateGuiTakeover(input({explicitOwnerApproval:true,inputProtectionReceipt:receipt})).code,'GUI_INPUT_PROTECTION_NOT_ACQUIRED');
});
test('protection receipt cannot outlive the bounded GUI lease',()=>{
 assert.equal(evaluateGuiTakeover(input({explicitOwnerApproval:true,inputProtectionReceipt:{...input().inputProtectionReceipt,expiresAtMs:nowMs+121000}})).code,'GUI_INPUT_PROTECTION_NOT_ACQUIRED');
});
test('empty input scope is rejected rather than acquiring an unused protected lease',()=>{
 assert.equal(evaluateGuiTakeover(input({requestedInput:{pointer:false,keyboard:false}})).code,'GUI_INPUT_SCOPE_EMPTY');
});

const adapterSession={ownerPrincipal:'uid:1000',sessionId:'native-session-1',seatId:'seat-0',displayId:'display-0',interactive:true,ownerAuthenticated:true};
function makeNativeAdapter(overrides={}) {
 const state={activity:{source:'physical',reliable:true,excludesSyntheticInput:true,observedAtMs:Date.now(),idleMs:65000},
  prompt:{explicitOwnerApproval:false,approvalDenied:false,approvalPromptVisible:true,approvalPromptElapsedMs:60000,physicalActivityAfterPrompt:false},
  acquireCalls:0,releaseCalls:0,subscribe:null,receipt:null};
 const descriptor={providerId:'native-adapter-fixture',platform:'linux',transport:'fixture-native-api',session:adapterSession,
  activityEvidenceSource:'physical',activityEvidenceIncludesSynthetic:false,isolationAuthority:null,
  capabilities:{observe:true,screenshot:true,activityDetection:true,physicalInputProtection:true,emergencyRelease:true,
   pointer:true,keyboard:true,semanticInvoke:true,isolatedDesktop:false}};
 const adapter={
  describeSession:async()=>descriptor,
  getPhysicalActivityEvidence:async()=>({...state.activity,observedAtMs:Date.now()}),
  requestOwnerApproval:async()=>state.prompt,
  acquireProtection:async({ttlSeconds})=>{
   state.acquireCalls++;
   const nowMs=Date.now();
   const receipt=state.receipt??{active:true,kind:'NATIVE_PHYSICAL_INPUT_PROTECTION',
    providerId:descriptor.providerId,sessionId:adapterSession.sessionId,leaseId:'native-adapter-lease',
    releaseOnAgentExit:true,releaseOnEmergency:true,expiresAtMs:nowMs+ttlSeconds*1000};
   return {ok:true,receipt,activityEvidence:{...state.activity,observedAtMs:Date.now()}};
  },
  releaseProtection:async()=>{state.releaseCalls++;return {ok:true};},
  subscribeEmergency:callback=>{state.subscribe=callback;return ()=>{state.subscribe=null;}}
 };
 Object.assign(adapter,overrides);
 return {adapter,state,descriptor};
}
test('native provider factory requires all owner-session and emergency lifecycle methods',()=>{
 assert.throws(()=>createGuiNativeSessionProvider({describeSession:async()=>({})}),/GUI_NATIVE_PROVIDER_ADAPTER_INCOMPLETE/);
});
test('native provider factory builds one OS-neutral grant from authenticated session and active protection receipt',async()=>{
 const {adapter}=makeNativeAdapter();
 const provider=createGuiNativeSessionProvider(adapter);
 const grant=await provider({platform:'linux',currentTaskExplicit:true,requestedInput:{pointer:true,keyboard:true},ttlSeconds:60});
 assert.equal(grant.ok,true);
 assert.equal(grant.takeoverEvidence.provider.providerId,'native-adapter-fixture');
 assert.equal(grant.inputProtectionReceipt.active,true);
 assert.equal(grant.admission.status,'GRANTED');
 assert.equal(grant.admission.approvalMode,'AUTO_IDLE_60S');
});
test('native provider never silently grants before the 60-second prompt deadline',async()=>{
 const {adapter,state}=makeNativeAdapter();
 state.activity.idleMs=1000;
 state.prompt={explicitOwnerApproval:false,approvalDenied:false,approvalPromptVisible:true,approvalPromptElapsedMs:59999,physicalActivityAfterPrompt:false};
 const provider=createGuiNativeSessionProvider(adapter);
 const grant=await provider({platform:'linux',currentTaskExplicit:true,requestedInput:{pointer:true,keyboard:true},ttlSeconds:60});
 assert.equal(grant.ok,false);assert.equal(grant.error,'GUI_OWNER_APPROVAL_PENDING');
 assert.equal(state.acquireCalls,0);
});
test('native provider accepts an explicitly owner-approved prompt and still needs native protection',async()=>{
 const {adapter,state}=makeNativeAdapter();
 state.activity.idleMs=5000;
 state.prompt={explicitOwnerApproval:true,approvalDenied:false,approvalPromptVisible:true,approvalPromptElapsedMs:1000,physicalActivityAfterPrompt:true};
 const provider=createGuiNativeSessionProvider(adapter);
 const grant=await provider({platform:'linux',currentTaskExplicit:true,requestedInput:{pointer:true,keyboard:true},ttlSeconds:60});
 assert.equal(grant.ok,true);assert.equal(grant.admission.approvalMode,'EXPLICIT');
});
test('an unrejected 60-second approval prompt grants even after owner activity',async()=>{
 const {adapter,state}=makeNativeAdapter();
 state.activity.idleMs=5000;
 state.prompt={explicitOwnerApproval:false,approvalDenied:false,approvalPromptVisible:true,approvalPromptElapsedMs:60000,physicalActivityAfterPrompt:true};
 const provider=createGuiNativeSessionProvider(adapter);
 const grant=await provider({platform:'linux',currentTaskExplicit:true,requestedInput:{pointer:true,keyboard:true},ttlSeconds:60});
 assert.equal(grant.ok,true);assert.equal(grant.admission.approvalMode,'AUTO_UNREJECTED_PROMPT_60S');
 assert.equal(state.acquireCalls,1);assert.equal(state.releaseCalls,0);
});
test('fresh physical activity detected during native protection acquisition prevents the idle-only auto-approval path',async()=>{
 const {adapter,state}=makeNativeAdapter();
 const acquire=adapter.acquireProtection;
 adapter.acquireProtection=async args=>{const result=await acquire(args);return {...result,activityEvidence:{...result.activityEvidence,idleMs:1000,observedAtMs:Date.now()}};};
 const provider=createGuiNativeSessionProvider(adapter);
 const grant=await provider({platform:'linux',currentTaskExplicit:true,requestedInput:{pointer:true,keyboard:true},ttlSeconds:60});
 assert.equal(grant.ok,false);assert.equal(grant.error,'GUI_OWNER_APPROVAL_PENDING');assert.equal(state.releaseCalls,1);
});
test('missing pre-capture idle sensor requires the visible 60-second prompt and fresh physical capture evidence',async()=>{
 const {adapter,state}=makeNativeAdapter();
 adapter.getPhysicalActivityEvidence=async()=>{throw new Error('PHYSICAL_IDLE_SENSOR_UNAVAILABLE');};
 state.activity.idleMs=1000; // Fresh physical EIS activity that crossed the capture barrier.
 state.prompt={explicitOwnerApproval:false,approvalDenied:false,approvalPromptVisible:true,approvalPromptElapsedMs:60000,physicalActivityAfterPrompt:true};
 const provider=createGuiNativeSessionProvider(adapter);
 const grant=await provider({platform:'linux',currentTaskExplicit:true,requestedInput:{pointer:true,keyboard:true},ttlSeconds:60});
 assert.equal(grant.ok,true);
 assert.equal(grant.admission.approvalMode,'AUTO_UNREJECTED_PROMPT_60S');
 assert.equal(state.acquireCalls,1);
});
test('synthetic or stale pre-capture evidence can never take the 60-second idle auto-approval route',async()=>{
 const {adapter,state}=makeNativeAdapter();
 state.activity={source:'synthetic',reliable:true,excludesSyntheticInput:false,observedAtMs:Date.now(),idleMs:120000};
 state.prompt={explicitOwnerApproval:false,approvalDenied:false,approvalPromptVisible:true,approvalPromptElapsedMs:59999,physicalActivityAfterPrompt:false};
 const provider=createGuiNativeSessionProvider(adapter);
 const grant=await provider({platform:'linux',currentTaskExplicit:true,requestedInput:{pointer:true,keyboard:true},ttlSeconds:60});
 assert.equal(grant.ok,false);assert.equal(grant.error,'GUI_OWNER_APPROVAL_PENDING');
 assert.equal(state.acquireCalls,0);
});
test('a backend cannot advertise a platform other than the live adapter platform',async()=>{
 const {adapter}=makeNativeAdapter();
 const provider=createGuiNativeSessionProvider(adapter);
 const grant=await provider({platform:'win32',currentTaskExplicit:true,requestedInput:{pointer:true,keyboard:true},ttlSeconds:60});
 assert.equal(grant.error,'GUI_PROVIDER_PLATFORM_MISMATCH');
});
test('native adapter must return an active protection receipt for the exact session',async()=>{
 const {adapter,state}=makeNativeAdapter();
 state.receipt={active:false,kind:'NATIVE_PHYSICAL_INPUT_PROTECTION',providerId:'native-adapter-fixture',
  sessionId:adapterSession.sessionId,leaseId:'inactive-lease',releaseOnAgentExit:true,releaseOnEmergency:true,expiresAtMs:Date.now()+60000};
 const provider=createGuiNativeSessionProvider(adapter);
 const grant=await provider({platform:'linux',currentTaskExplicit:true,requestedInput:{pointer:true,keyboard:true},ttlSeconds:60});
 assert.equal(grant.ok,false);assert.equal(grant.error,'GUI_INPUT_PROTECTION_NOT_ACQUIRED');
 assert.equal(state.releaseCalls,1);
});
test('native adapter emergency subscription and release are forwarded unchanged',async()=>{
 const {adapter,state}=makeNativeAdapter();
 const provider=createGuiNativeSessionProvider(adapter);
 let seen=null;provider.subscribeEmergency(event=>{seen=event;});
 state.subscribe('SESSION_LOCKED');
 assert.equal(seen,'SESSION_LOCKED');
 const released=await provider.release({leaseId:'native-adapter-lease',reason:'SESSION_LOCKED'});
 assert.equal(released.ok,true);assert.equal(state.releaseCalls,1);
});
test('no current task or empty input scope can reach native protection acquisition',async()=>{
 const {adapter,state}=makeNativeAdapter();
 const provider=createGuiNativeSessionProvider(adapter);
 assert.equal((await provider({platform:'linux',currentTaskExplicit:false,requestedInput:{pointer:true,keyboard:true}})).error,'GUI_CURRENT_TASK_AUTHORIZATION_REQUIRED');
 assert.equal((await provider({platform:'linux',currentTaskExplicit:true,requestedInput:{pointer:false,keyboard:false}})).error,'GUI_INPUT_SCOPE_INVALID');
 assert.equal(state.acquireCalls,0);
});

test('native provider exposes only sanitized adapter error codes for actionable diagnostics',async()=>{
 const valid=makeNativeAdapter();
 valid.adapter.acquireProtection=async()=>{throw Object.assign(new Error('private D-Bus detail must not escape'),{code:'GUI_PORTAL_PERMISSION_DENIED'});};
 const first=await createGuiNativeSessionProvider(valid.adapter)({
  platform:'linux',currentTaskExplicit:true,requestedInput:{pointer:true,keyboard:true},ttlSeconds:60
 });
 assert.equal(first.error,'GUI_PORTAL_PERMISSION_DENIED');
 assert.equal(JSON.stringify(first).includes('private D-Bus detail'),false);

 const invalid=makeNativeAdapter();
 invalid.adapter.acquireProtection=async()=>{throw Object.assign(new Error('raw detail'),{code:'../../private'});};
 const second=await createGuiNativeSessionProvider(invalid.adapter)({
  platform:'linux',currentTaskExplicit:true,requestedInput:{pointer:true,keyboard:true},ttlSeconds:60
 });
 assert.equal(second.error,'GUI_INPUT_PROTECTION_ACQUISITION_FAILED');
 assert.equal(JSON.stringify(second).includes('raw detail'),false);
});
