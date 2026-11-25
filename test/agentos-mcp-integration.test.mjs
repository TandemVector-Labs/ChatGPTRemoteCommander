import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createWorkspaceController,workspaceToolDefinitions,assertWorkspaceToolPolicy} from '../src/workspace-tools.mjs';
import {createMemoryWorkspaceJournal} from '../src/workspace-target-journal.mjs';
const allow={powerMode:{enabled:true,guiControl:{enabled:true,allowMouse:true,allowWindowFocus:true}}};
const target={pid:3401,windowId:80302,application:'brave'};
const fp='0123456789abcdef01234567';
const element={name:'Send',fingerprint:fp,enabled:true,invokeAvailable:true,valueAvailable:false,controlType:'ControlType.Button'};
const composer={name:'Message ChatGPT',fingerprint:'fedcba9876543210fedcba98',enabled:true,
 invokeAvailable:false,valueAvailable:true,valueProvider:'ValuePattern',controlType:'ControlType.Edit'};
function mockController(history,{owner=true,failMutation=false,focus='PRESERVED'}={}){
 return createWorkspaceController({platform:'win32',env:{SESSIONNAME:'RDP-Tcp#2'},
  now:()=>1000,ownerSession:async()=>owner,journal:createMemoryWorkspaceJournal(),
  nativeCall:async(op,args)=>{
   history.push({op,args});
   if(op==='Observe')return {ok:true,pid:args.pid,windowHandle:args.windowId,application:args.application,
    elements:[composer,element],foregroundStatus:'PRESERVED',foregroundTouched:false};
   if(failMutation)throw Error('transport-lost');
   const measured=focus==='PRESERVED'
    ?{foregroundStatus:'PRESERVED',foregroundTouched:false,foregroundBeforeWindowHandle:target.windowId,foregroundBeforeProcessId:target.pid,foregroundAfterWindowHandle:target.windowId,foregroundAfterProcessId:target.pid}
    :focus==='CHANGED'
    ?{foregroundStatus:'CHANGED',foregroundTouched:true,foregroundBeforeWindowHandle:target.windowId+1,
      foregroundBeforeProcessId:target.pid,
      foregroundAfterWindowHandle:history.at(-1)?.args?.foregroundChangeAuthorized===true?target.windowId:target.windowId+1,
      foregroundAfterProcessId:target.pid}
    :{foregroundStatus:'UNOBSERVABLE',foregroundTouched:null,foregroundBeforeWindowHandle:null,foregroundBeforeProcessId:null,foregroundAfterWindowHandle:null,foregroundAfterProcessId:null};
   const before=measured;
   if(op==='SetValue')return {...before,mode:'NATIVE_UIA_SET_VALUE',pid:3401,windowHandle:80302,
    application:'brave',requestId:args.requestId,valueApplied:true,readBackVerified:true,
    valueLength:args.value.length,valueSha256:createHash('sha256').update(args.value).digest('hex'),
    valueProvider:'ValuePattern'};
   return {...before,mode:'NATIVE_UIA_INVOKE',pid:3401,windowHandle:80302,application:'brave',
    requestId:args.requestId,invocationIssued:true,userGoalVerified:false};
  }});
}
test('tools advertised in shared MCP catalog with read-only vs mutation annotations',()=>{
 for(const name of ['workspace_agentos_plan','workspace_native_ui_observe','workspace_native_ui_set_value','workspace_native_ui_invoke'])
  assert.ok(workspaceToolDefinitions.some(t=>t.name===name));
 assert.equal(workspaceToolDefinitions.find(t=>t.name==='workspace_native_ui_observe').annotations.readOnlyHint,true);
 assert.equal(workspaceToolDefinitions.find(t=>t.name==='workspace_native_ui_invoke').annotations.readOnlyHint,false);
 assert.doesNotThrow(()=>assertWorkspaceToolPolicy(allow,'workspace_native_ui_invoke'));
 assert.doesNotThrow(()=>assertWorkspaceToolPolicy({powerMode:{enabled:true,guiControl:{enabled:true,allowMouse:false}}},'workspace_native_ui_set_value'));
 assert.throws(()=>assertWorkspaceToolPolicy({powerMode:{enabled:true,guiControl:{enabled:false}}},'workspace_native_ui_set_value'),/WORKSPACE_GUI_CONTROL_DISABLED/);
 assert.throws(()=>assertWorkspaceToolPolicy({powerMode:{enabled:true,guiControl:{enabled:true,allowWindowFocus:false}}},'workspace_native_ui_invoke',{foregroundChangeAuthorized:true}),/WORKSPACE_GUI_WINDOW_FOCUS_POLICY_DENIED/);
 const ownerObserveOnly={powerMode:{enabled:true,guiControl:{enabled:true,allowMouse:false,allowKeyboard:false,allowWindowFocus:false}}};
 assert.doesNotThrow(()=>assertWorkspaceToolPolicy(ownerObserveOnly,'workspace_native_ui_set_value'));
 assert.doesNotThrow(()=>assertWorkspaceToolPolicy(ownerObserveOnly,'workspace_native_ui_invoke',{foregroundChangeAuthorized:false}));
 assert.throws(()=>assertWorkspaceToolPolicy(ownerObserveOnly,'workspace_native_ui_invoke',{foregroundChangeAuthorized:true}),/WORKSPACE_GUI_WINDOW_FOCUS_POLICY_DENIED/);
});
test('native UIA observe -> exact single invoke -> no replay and no goal overclaim',async()=>{
 const calls=[];const ctl=mockController(calls);
 const observed=await ctl.execute('workspace_native_ui_observe',target);
 assert.equal(observed.ok,true);assert.equal(observed.provider,'windows-uia-native');
 const action={...target,fingerprint:fp,controlName:'Send',foregroundChangeAuthorized:false,requestId:'rc011-native-test-e2e-01',
  explicitUserAuthorization:'Owner allows No in own isolated test dialog only'};
 const click=await ctl.execute('workspace_native_ui_invoke',action);
 assert.equal(click.ok,true);
 assert.equal(click.decision.status,'INVOKE_ACKNOWLEDGED');
 assert.equal(click.decision.userGoalVerified,false);
 assert.deepEqual(calls.map(c=>c.op),['Observe','Invoke']);
 await assert.rejects(ctl.execute('workspace_native_ui_invoke',action),/WORKSPACE_DUPLICATE_REQUEST_NO_REPLAY/);
 assert.equal(calls.length,2);
});
test('native UIA wrong fingerprint, name or missing request id never invokes',async()=>{
 const calls=[];const ctl=mockController(calls);
 await ctl.execute('workspace_native_ui_observe',target);
 const base={...target,requestId:'rc011-native-test-guard-01',
  explicitUserAuthorization:'Owner allows a single temporary test control only',
  fingerprint:fp,controlName:'Send',application:'brave',foregroundChangeAuthorized:false};
 for(const patch of [{fingerprint:'111111111111111111111111'},{controlName:'Yes'},{requestId:null},{explicitUserAuthorization:'no'}])
  await assert.rejects(ctl.execute('workspace_native_ui_invoke',{...base,...patch}),/AGENTOS_/);
 assert.equal(calls.length,1);
});
test('no owner session cannot use native Win32 action from SYSTEM context',async()=>{
 const calls=[];const ctl=mockController(calls,{owner:false});
 await assert.rejects(ctl.execute('workspace_native_ui_observe',target),/WORKSPACE_OWNER_SESSION_REQUIRED/);
 assert.equal(calls.length,0);
});
test('lost native mutation is pending and cannot be retried with different id',async()=>{
 const calls=[];const ctl=mockController(calls,{failMutation:true});
 await ctl.execute('workspace_native_ui_observe',target);
 const a={...target,fingerprint:fp,controlName:'Send',foregroundChangeAuthorized:false,requestId:'rc011-native-unknown-01',
 explicitUserAuthorization:'Owner allows the exact disposable native GUI button'};
 const first=await ctl.execute('workspace_native_ui_invoke',a);
 assert.equal(first.ok,false);assert.equal(first.mode,'NATIVE_UIA_OUTCOME_UNCERTAIN');
 await ctl.execute('workspace_native_ui_observe',target);
 await assert.rejects(ctl.execute('workspace_native_ui_invoke',{...a,requestId:'rc011-native-unknown-02'}),/WORKSPACE_TARGET_RECONCILIATION_REQUIRED/);
 assert.equal(calls.filter(c=>c.op==='Invoke').length,1);
});
test('agent plan does not confer owner privileges and respects the OS',async()=>{
 const calls=[];const ctl=mockController(calls,{owner:false});
 const route=await ctl.execute('workspace_agentos_plan',{target:'existing-app'});
 assert.equal(route.status,'BLOCKED');assert.equal(route.code,'OWNER_SESSION_REQUIRED');
 assert.equal(route.autoElevate,false);
 assert.equal(calls.length,0);
});

test('measured foreground change makes native action a non-PASS with acknowledged effect',async()=>{
 const calls=[];const ctl=mockController(calls,{focus:'CHANGED'});
 await ctl.execute('workspace_native_ui_observe',target);
 const result=await ctl.execute('workspace_native_ui_invoke',{...target,fingerprint:fp,controlName:'Send',foregroundChangeAuthorized:false,
 requestId:'rc011-focus-changed-native-01',explicitUserAuthorization:'Owner scoped No-button invoke only on a disposable test'});
 assert.equal(result.ok,false);
 assert.equal(result.invocationIssued,true);
 assert.equal(result.focusChanged,true);
 assert.equal(result.mode,'NATIVE_UIA_FOCUS_CHANGED');
 assert.equal(result.decision.status,'FOREGROUND_CHANGE_NOT_ACCEPTED');
 assert.equal(result.decision.userGoalVerified,false);
});
test('unobservable foreground is never claimed as preserved',async()=>{
 const calls=[];const ctl=mockController(calls,{focus:'UNOBSERVABLE'});
 await ctl.execute('workspace_native_ui_observe',target);
 const result=await ctl.execute('workspace_native_ui_invoke',{...target,fingerprint:fp,controlName:'Send',foregroundChangeAuthorized:false,
 requestId:'rc011-focus-unknown-native-01',explicitUserAuthorization:'Owner scoped one diagnostic No invoke within owner test application'});
 assert.equal(result.ok,false);
 assert.equal(result.focusChanged,null);
 assert.equal(result.focusStatus,'UNOBSERVABLE');
 assert.equal(result.decision.status,'FOREGROUND_UNOBSERVABLE');
});


test('Brave composer uses ValuePattern text set with readback; send is a separate fresh one-shot UIA Invoke',async()=>{
 const calls=[];const ctl=mockController(calls);
 const observed=await ctl.execute('workspace_native_ui_observe',target);
 assert.equal(observed.ok,true);
 const text='Please continue the independent qualification for the exact private candidate.';
 const typed=await ctl.execute('workspace_native_ui_set_value',{...target,
  fingerprint:composer.fingerprint,controlName:composer.name,value:text,foregroundChangeAuthorized:false,
  requestId:'rc-brave-uia-set-value-0001',
  explicitUserAuthorization:'Owner authorizes one literal value set in the exact Brave composer'});
 assert.equal(typed.ok,true);
 assert.equal(typed.mode,'NATIVE_UIA_SET_VALUE_VERIFIED');
 assert.equal(typed.readBackVerified,true);
 assert.equal(typed.valueLength,text.length);
 assert.equal(Object.hasOwn(typed,'value'),false);
 assert.equal(calls[1].op,'SetValue');
 assert.equal(calls[1].args.value,text);
 const second=await ctl.execute('workspace_native_ui_observe',target);
 assert.equal(second.ok,true);
 const sent=await ctl.execute('workspace_native_ui_invoke',{...target,
  fingerprint:fp,controlName:'Send',foregroundChangeAuthorized:false,
  requestId:'rc-brave-uia-send-0001',
  explicitUserAuthorization:'Owner authorizes exactly one send button invocation in the same Brave window'});
 assert.equal(sent.ok,true);
 assert.equal(sent.mode,'NATIVE_UIA_INVOKE_ISSUED');
 assert.deepEqual(calls.map(x=>x.op),['Observe','SetValue','Observe','Invoke']);
 assert.equal(sent.decision.userGoalVerified,false);
});

test('ValuePattern set-value rejects stale button fingerprints, oversized text and unauthorised focus change',async()=>{
 const calls=[];const ctl=mockController(calls);
 await ctl.execute('workspace_native_ui_observe',target);
 const base={...target,fingerprint:composer.fingerprint,controlName:composer.name,
  value:'x',requestId:'rc-brave-value-guard-0001',foregroundChangeAuthorized:false,
  explicitUserAuthorization:'Owner permits one exact value pattern write'};
 await assert.rejects(ctl.execute('workspace_native_ui_set_value',{...base,fingerprint:fp}),/AGENTOS_FRESH_EXACT_UIA_ELEMENT_REQUIRED/);
 await assert.rejects(ctl.execute('workspace_native_ui_set_value',{...base,value:'x'.repeat(1025),requestId:'rc-brave-value-guard-0002'}),/AGENTOS_NATIVE_SET_VALUE_CONTRACT_INVALID/);
 assert.equal(calls.filter(x=>x.op==='SetValue').length,0);
 assert.equal(calls.length,1);
});

test('UIA foreground switch is accepted only when the authorised exact target became foreground',async()=>{
 const calls=[];const ctl=mockController(calls,{focus:'CHANGED'});
 await ctl.execute('workspace_native_ui_observe',target);
 const action={...target,fingerprint:fp,controlName:'Send',foregroundChangeAuthorized:true,
  requestId:'rc-brave-authorized-focus-0001',
  explicitUserAuthorization:'Owner explicitly authorizes this one target foreground change'};
 const result=await ctl.execute('workspace_native_ui_invoke',action);
 // The controller accepts only target HWND/PID equality; the mocked native adapter
 // returns the default target identity for this scenario.
 assert.equal(result.ok,true);
 assert.equal(result.focusTargetVerified,true);
 assert.equal(result.focusChanged,true);
});
