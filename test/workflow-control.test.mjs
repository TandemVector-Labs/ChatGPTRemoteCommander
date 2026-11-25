import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorkflowStore } from '../src/workflow-store.mjs';

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-workflow-control-')));
  const options = { directory:path.join(root,'memory'), allowedRoots:[root], device:'fixture', configSha256:'1'.repeat(64) };
  const store = new WorkflowStore(options);
  t.after(() => { store.close(); fs.rmSync(root,{recursive:true,force:true}); });
  const create = (id='sample', steps=[{id:'first',title:'One effect'},{id:'second',title:'Next effect'}]) =>
    store.create({id,root,goal:'Preserve explicit control',acceptance:['Verified result'],steps});
  const call = (id='sample', stepId='first', host={validate:async()=>{},dispatch:async()=>({ok:true})}) =>
    store.call({id,stepId,expectedRevision:store.get(id).state.revision,tool:'read_text',arguments:{}},host);
  const control = action => store.control({id:'sample',expectedRevision:store.get('sample').state.revision,action,reason:'Explicit test control'});
  fs.writeFileSync(path.join(root,'proof.txt'),'verified');
  return {root,options,store,create,call,control};
}
function deferred() { let resolve; const promise=new Promise(r=>{resolve=r;}); return {promise,resolve}; }
const finalArgs = store => ({id:'sample',expectedRevision:store.get('sample').state.revision,acceptanceResults:[true],files:['proof.txt'],summary:'Independent verification'});

test('scheduler disabled permits explicit calls; explicit pause persists and resume releases the gate',async t=>{
  const f=fixture(t);f.create();
  assert.equal(f.store.get('sample').state.scheduler.enabled,false);
  assert.equal(f.store.get('sample').state.control.intent,'ACTIVE');
  await f.call();
  f.control('pause');
  const reopened=new WorkflowStore(f.options);
  try {
    assert.equal(reopened.get('sample').state.control.intent,'PAUSED');
    assert.equal(reopened.resume('sample').readyForNextStep,false);
    assert.ok(reopened.resume('sample').blockers.includes('WORKFLOW_PAUSED'));
  } finally { reopened.close(); }
  await assert.rejects(f.call('sample','second'),/WORKFLOW_PAUSED/);
  assert.throws(()=>f.store.finalize(finalArgs(f.store)),/WORKFLOW_PAUSED/);
  f.control('resume');
  assert.equal(f.store.get('sample').state.control.generation,2);
  assert.equal(f.store.resume('sample').readyForNextStep,true);
  await f.call('sample','second');
});

for (const action of ['pause','cancel']) for (const success of [true,false]) {
  test(`${action} during dispatch preserves lease and survives ${success?'successful':'uncertain'} late receipt`,async t=>{
    const f=fixture(t);f.create();f.create('other');
    const started=deferred(),finish=deferred();
    const pending=f.call('sample','first',{validate:async()=>{},dispatch:async()=>{started.resolve();await finish.promise;return{ok:success};}});
    await started.promise;
    const other=new WorkflowStore(f.options);
    try {
      f.control(action);
      assert.equal(f.store.schedulerStatus().currentLeases,1);
      let overlaps=0;
      await assert.rejects(other.call({id:'other',stepId:'first',expectedRevision:1,tool:'read_text',arguments:{}},
        {validate:async()=>{},dispatch:async()=>{overlaps++;return{ok:true};}}),/WORKFLOW_ROOT_LEASED/);
      assert.equal(overlaps,0);
      finish.resolve();await pending;
      const state=f.store.get('sample').state;
      assert.equal(state.control.intent,action==='pause'?'PAUSED':'CANCELLED');
      assert.equal(state.lifecycleState,action==='pause'?'WAITING':'CANCELLED');
      assert.equal(state.scheduler.enabled,false);
      assert.equal(f.store.list().find(x=>x.id==='sample').lifecycle,state.lifecycleState);
      assert.equal(f.store.resume('sample').readyForNextStep,false);
      await assert.rejects(f.call('sample','second'),action==='pause'?/WORKFLOW_PAUSED/:/WORKFLOW_CANCELLED/);
      assert.equal(f.store.schedulerStatus().currentLeases,success?0:1);
      if(!success) assert.equal(f.store.get('sample').state.steps[0].status,'uncertain');
    } finally { finish.resolve();await pending;other.close(); }
  });
}

test('pause while asynchronous validation is pending prevents the effect',async t=>{
  const f=fixture(t);f.create();const validating=deferred(),finish=deferred();let effects=0;
  const pending=f.call('sample','first',{validate:async()=>{validating.resolve();await finish.promise;},dispatch:async()=>{effects++;return{ok:true};}});
  await validating.promise;f.control('pause');finish.resolve();
  await assert.rejects(pending,/WORKFLOW_REVISION_CONFLICT|WORKFLOW_PAUSED/);
  assert.equal(effects,0);assert.equal(f.store.get('sample').state.steps[0].status,'pending');
});

for (const action of ['pause','cancel']) for (const automatic of [true,false]) {
  test(`${action} survives ${automatic?'automatic':'manual'} reconciliation and checkpoint`,async t=>{
    const f=fixture(t);f.create();
    await f.call('sample','first',{validate:async()=>{},dispatch:async()=>({ok:false})});
    f.control(action);
    if(automatic) await f.store.reconcileAutomatically('sample',{verify:async()=>({status:'APPLIED',summary:'Observed independently'})});
    else f.store.reconcile({id:'sample',stepId:'first',expectedRevision:f.store.get('sample').state.revision,outcome:'applied',files:['proof.txt'],explanation:'Observed independently'});
    f.store.checkpoint({id:'sample',expectedRevision:f.store.get('sample').state.revision,files:['proof.txt'],nextAction:'Await user control',summary:'Recorded recovery'});
    const state=f.store.get('sample').state;
    assert.equal(state.control.intent,action==='pause'?'PAUSED':'CANCELLED');
    assert.equal(state.lifecycleState,action==='pause'?'WAITING':'CANCELLED');
    assert.equal(state.scheduler.enabled,false);
    assert.equal(f.store.resume('sample').readyForNextStep,false);
    if(action==='cancel') {
      assert.throws(()=>f.control('resume'),/WORKFLOW_CANCELLED/);
      assert.throws(()=>f.control('pause'),/WORKFLOW_CANCELLED/);
      assert.throws(()=>f.store.finalize(finalArgs(f.store)),/WORKFLOW_CANCELLED/);
    }
  });
}

for (const action of ['pause','cancel']) {
  test(`restart recovers a crashed effect without clearing ${action}`,t=>{
    const f=fixture(t);f.create();
    const moduleUrl=new URL('../src/workflow-store.mjs',import.meta.url).href;
    const script=`import {WorkflowStore} from ${JSON.stringify(moduleUrl)};
      const options=JSON.parse(process.argv[1]);const action=process.argv[2];const s=new WorkflowStore(options);
      await s.call({id:'sample',stepId:'first',expectedRevision:1,tool:'read_text',arguments:{}},{validate:async()=>{},dispatch:async()=>{
        s.control({id:'sample',expectedRevision:s.get('sample').state.revision,action,reason:'Explicit control before crash'});process.exit(73);
      }});`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script,JSON.stringify(f.options),action],{encoding:'utf8',timeout:15000});
    assert.equal(child.status,73,child.stderr);
    const reopened=new WorkflowStore(f.options);
    try {
      const state=reopened.get('sample').state;
      assert.equal(state.steps[0].status,'uncertain');
      assert.equal(state.control.intent,action==='pause'?'PAUSED':'CANCELLED');
      assert.equal(state.lifecycleState,action==='pause'?'WAITING':'CANCELLED');
      assert.equal(reopened.resume('sample').readyForNextStep,false);
      assert.equal(reopened.list()[0].lifecycle,state.lifecycleState);
    } finally { reopened.close(); }
  });
}

test('finalization binds fresh file bytes to verifier evidence and completed work cannot dispatch',async t=>{
  const f=fixture(t);f.create('sample',[{id:'first',title:'Effect'}]);await f.call();
  const verified=f.store.evidence(f.root,['proof.txt']);
  fs.writeFileSync(path.join(f.root,'proof.txt'),'changed after verification');
  assert.throws(()=>f.store.finalize({...finalArgs(f.store),expectedEvidence:verified}),/WORKFLOW_EVIDENCE_CHANGED/);
  assert.notEqual(f.store.get('sample').state.lifecycleState,'COMPLETED');
  const fresh=f.store.evidence(f.root,['proof.txt']);
  assert.throws(()=>f.store.finalize({...finalArgs(f.store),expectedEvidence:[{...fresh[0],bytes:fresh[0].bytes+1}]}),/WORKFLOW_EVIDENCE_CHANGED/);
  const done=f.store.finalize({...finalArgs(f.store),expectedEvidence:fresh});
  assert.equal(done.state.lifecycleState,'COMPLETED');
  assert.equal(f.store.resume('sample').readyForNextStep,false);
  await assert.rejects(f.call(),/WORKFLOW_ALREADY_COMPLETED/);
});

test('resuming interrupted finalization records the evidence actually reverified',async t=>{
  const f=fixture(t);f.create('sample',[{id:'first',title:'Effect'}]);await f.call();
  const brain=path.join(f.root,'PROJECT_BRAIN.md');
  fs.mkdirSync(brain);
  assert.throws(()=>f.store.finalize({...finalArgs(f.store),expectedEvidence:f.store.evidence(f.root,['proof.txt'])}));
  assert.equal(f.store.get('sample').state.lifecycleState,'FINALIZING');
  fs.rmdirSync(brain);
  fs.writeFileSync(path.join(f.root,'proof.txt'),'new independently verified evidence');
  const expectedEvidence=f.store.evidence(f.root,['proof.txt']);
  const done=f.store.finalize({...finalArgs(f.store),expectedEvidence});
  assert.equal(done.state.lifecycleState,'COMPLETED');
  assert.deepEqual(done.state.finalization.evidence,expectedEvidence);
});
