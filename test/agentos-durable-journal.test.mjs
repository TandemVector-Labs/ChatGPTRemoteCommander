import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createWorkspaceController} from '../src/workspace-tools.mjs';
import {createWorkspaceTargetJournal} from '../src/workspace-target-journal.mjs';

const target={pid:3401,windowId:80302,application:'brave'};
const fp='0123456789abcdef01234567';
const action=(id)=>({...target,fingerprint:fp,controlName:'Send',requestId:id,
 foregroundChangeAuthorized:false,explicitUserAuthorization:'Owner approves this disposable exact-target native UIA unit-test only'});
function scenario(t,{focus='PRESERVED',throwAfterInvoke=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-native-journal-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const journal=createWorkspaceTargetJournal({dir});
 const calls=[];
 const controller=()=>createWorkspaceController({platform:'win32',ownerSession:async()=>true,
  journal,now:()=>1000,nativeCall:async (operation,args)=>{
   calls.push(operation);
   if(operation==='Observe') return {ok:true,provider:'windows-uia-native',pid:target.pid,windowHandle:target.windowId,
     elements:[{name:'Send',fingerprint:fp,enabled:true,invokeAvailable:true,valueAvailable:false,controlType:'ControlType.Button'},
      {name:'Message ChatGPT',fingerprint:'fedcba9876543210fedcba98',enabled:true,invokeAvailable:false,valueAvailable:true,valueProvider:'ValuePattern',controlType:'ControlType.Edit'}],
     foregroundStatus:'PRESERVED',foregroundTouched:false,physicalInputTouched:false};
   if(throwAfterInvoke)throw Error('SIMULATED_LOST_RECEIPT_AFTER_EFFECT');
   const foreground=focus==='PRESERVED'
    ?{foregroundStatus:'PRESERVED',foregroundTouched:false,foregroundBeforeWindowHandle:target.windowId,foregroundAfterWindowHandle:target.windowId,foregroundBeforeProcessId:target.pid,foregroundAfterProcessId:target.pid}
    :focus==='CHANGED'
    ?{foregroundStatus:'CHANGED',foregroundTouched:true,foregroundBeforeWindowHandle:target.windowId,foregroundAfterWindowHandle:target.windowId+1,foregroundBeforeProcessId:target.pid,foregroundAfterProcessId:target.pid+1}
    :{foregroundStatus:'UNOBSERVABLE',foregroundTouched:null,foregroundBeforeWindowHandle:null,foregroundAfterWindowHandle:null,foregroundBeforeProcessId:null,foregroundAfterProcessId:null};
   if(operation==='SetValue')return {ok:true,mode:'NATIVE_UIA_SET_VALUE',pid:target.pid,windowHandle:target.windowId,application:'brave',requestId:args.requestId,valueApplied:true,readBackVerified:true,valueLength:args.value.length,valueSha256:createHash('sha256').update(args.value).digest('hex'),valueProvider:'ValuePattern',...foreground,physicalInputTouched:false};
   return {ok:true,provider:'windows-uia-native',pid:target.pid,windowHandle:target.windowId,
     mode:'NATIVE_UIA_INVOKE',application:'brave',requestId:args.requestId,invocationIssued:true,userGoalVerified:false,
     foregroundStatus:focus,foregroundTouched:focus==='PRESERVED'?false:focus==='CHANGED'?true:null,
     foregroundBeforeWindowHandle:target.windowId,foregroundAfterWindowHandle:focus==='PRESERVED'?target.windowId:target.windowId+1,
     foregroundBeforeProcessId:target.pid,foregroundAfterProcessId:target.pid+1,
     physicalInputTouched:false};
  }});
 return {journal,calls,controller};
}
test('real file journal admits native receipt then resolves on preserved foreground',async t=>{
 const {journal,calls,controller}=scenario(t);
 const ctl=controller();
 await ctl.execute('workspace_native_ui_observe',target);
 const result=await ctl.execute('workspace_native_ui_invoke',action('native-persistent-0001'));
 assert.equal(result.ok,true);
 assert.equal(result.decision.status,'INVOKE_ACKNOWLEDGED');
 assert.deepEqual(calls,['Observe','Invoke']);
 assert.equal(await journal.pending('native:3401:80302'),null);
});
test('unknown native effect stays durably pending across controller restart',async t=>{
 const {journal,calls,controller}=scenario(t,{throwAfterInvoke:true});
 const first=controller();
 await first.execute('workspace_native_ui_observe',target);
 const result=await first.execute('workspace_native_ui_invoke',action('native-unknown-0001'));
 assert.equal(result.ok,false);
 assert.equal(result.mode,'NATIVE_UIA_OUTCOME_UNCERTAIN');
 assert.ok(await journal.pending('native:3401:80302'));
 const second=controller();
 await second.execute('workspace_native_ui_observe',target);
 await assert.rejects(second.execute('workspace_native_ui_invoke',action('native-unknown-0002')),
   /WORKSPACE_TARGET_RECONCILIATION_REQUIRED/);
 assert.deepEqual(calls,['Observe','Invoke','Observe']);
});
test('foreground changed cannot silently clear native journal before owner review',async t=>{
 const {journal,controller}=scenario(t,{focus:'CHANGED'});
 const ctl=controller();
 await ctl.execute('workspace_native_ui_observe',target);
 const result=await ctl.execute('workspace_native_ui_invoke',action('native-focus-change-0001'));
 assert.equal(result.ok,false);
 assert.equal(result.focusStatus,'CHANGED');
 assert.ok(await journal.pending('native:3401:80302'));
});
test('a changed native foreground requires fresh observed target and explicit reconciliation',async t=>{
 const {journal,calls,controller}=scenario(t,{focus:'CHANGED'});
 const ctl=controller();
 const old=await ctl.execute('workspace_native_ui_observe',target);
 await ctl.execute('workspace_native_ui_invoke',action('native-review-0001'));
 assert.ok(await journal.pending('native:3401:80302'));
 const current=await ctl.execute('workspace_native_ui_observe',target);
 assert.equal(current.targetUncertain,true);
 await assert.rejects(ctl.execute('workspace_target_reconcile',{
  ...target,surface:'native',snapshotId:old.snapshotId,determination:'EFFECT_OBSERVED'
 }),/WORKSPACE_FRESH_SNAPSHOT_REQUIRED/);
 await assert.rejects(ctl.execute('workspace_target_reconcile',{
  ...target,surface:'native',snapshotId:current.snapshotId,
  targetGoneVerified:true,determination:'EFFECT_OBSERVED'
 }),/WORKSPACE_TARGET_GONE_PROOF_DENIED/);
 const done=await ctl.execute('workspace_target_reconcile',{
  ...target,surface:'native',snapshotId:current.snapshotId,determination:'EFFECT_OBSERVED'
 });
 assert.equal(done.ok,true);
 assert.equal(done.replayed,false);
 assert.equal(await journal.pending('native:3401:80302'),null);
 await assert.rejects(ctl.execute('workspace_native_ui_invoke',action('native-review-0002')),
   /AGENTOS_FRESH_EXACT_UIA_ELEMENT_REQUIRED/);
 assert.deepEqual(calls,['Observe','Invoke','Observe']);
});
test('unobservable foreground is a persisted incident, never a successful native effect',async t=>{
 const {journal,controller}=scenario(t,{focus:'UNOBSERVABLE'});
 const ctl=controller();
 await ctl.execute('workspace_native_ui_observe',target);
 const result=await ctl.execute('workspace_native_ui_invoke',action('native-unobservable-0001'));
 assert.equal(result.ok,false);
 assert.equal(result.mode,'NATIVE_UIA_FOCUS_UNOBSERVABLE');
 assert.ok(await journal.pending('native:3401:80302'));
});

test('ValuePattern writes are durable one-shot journal effects across controller restarts',async t=>{
 const {journal,calls,controller}=scenario(t);
 const first=controller();
 await first.execute('workspace_native_ui_observe',target);
 const result=await first.execute('workspace_native_ui_set_value',{...target,
  fingerprint:'fedcba9876543210fedcba98',controlName:'Message ChatGPT',value:'one exact private prompt',
  requestId:'native-value-durable-0001',foregroundChangeAuthorized:false,
  explicitUserAuthorization:'Owner authorizes one exact composer set-value operation'});
 assert.equal(result.ok,true);
 assert.equal(result.readBackVerified,true);
 assert.equal(await journal.pending('native:3401:80302'),null);
 assert.deepEqual(calls,['Observe','SetValue']);
});

test('an uncertain SetValue receipt survives restart and prevents a second write',async t=>{
 const {journal,calls,controller}=scenario(t,{throwAfterInvoke:true});
 const first=controller();
 await first.execute('workspace_native_ui_observe',target);
 const value={...target,fingerprint:'fedcba9876543210fedcba98',controlName:'Message ChatGPT',value:'single text',
  requestId:'native-value-uncertain-0001',foregroundChangeAuthorized:false,
  explicitUserAuthorization:'Owner authorizes one exact composer operation'};
 const outcome=await first.execute('workspace_native_ui_set_value',value);
 assert.equal(outcome.ok,false);
 assert.equal(outcome.mode,'NATIVE_UIA_OUTCOME_UNCERTAIN');
 assert.ok(await journal.pending('native:3401:80302'));
 const second=controller();
 await second.execute('workspace_native_ui_observe',target);
 await assert.rejects(second.execute('workspace_native_ui_set_value',{...value,requestId:'native-value-uncertain-0002'}),
  /WORKSPACE_TARGET_RECONCILIATION_REQUIRED/);
 assert.deepEqual(calls,['Observe','SetValue','Observe']);
});
