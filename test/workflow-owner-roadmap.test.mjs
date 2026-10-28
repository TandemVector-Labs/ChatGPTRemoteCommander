import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowStore, hash, canonical } from '../src/workflow-store.mjs';
import { createWorkflowTools, WORKFLOW_TOOL_DEFINITIONS } from '../src/workflow-tools.mjs';

const independent=[
  {id:'n14',title:'Owner chooses route priority',dependsOn:[]},
  {id:'n17',title:'Owner supplies custom route proposal',dependsOn:[]},
  {id:'verify',title:'Check owner-approved outcome',dependsOn:['n14','n17']}
];

function setup(t,steps=independent){
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-roadmap-native-')));
  const options={directory:path.join(root,'state'),allowedRoots:[root],device:'test',
    configSha256:'0'.repeat(64)};
  const store=new WorkflowStore(options);
  const tools=createWorkflowTools({
    config:{durableWorkflows:{enabled:true,directory:path.join(root,'tools-state')}},
    roots:[root],device:'test',configSha256:'0'.repeat(64),
    lookup:name=>({name,inputSchema:{type:'object'}}),validateSchema:()=>[],
    dispatch:async()=>({ok:true})
  });
  store.create({id:'roadmap',root,goal:'Complete the accepted project',acceptance:['Evidence-backed acceptance'],steps});
  t.after(async()=>{store.close();await tools.close();fs.rmSync(root,{recursive:true,force:true});});
  const args=(extras={})=>({
    id:'roadmap',expectedRevision:store.get('roadmap').state.revision,
    operationId:'prio-n17-first',orderedStepIds:['n17','n14','verify'],
    reason:'Owner explicitly ranks route N17 before N14',...extras
  });
  return {root,options,store,tools,args};
}
function adapter(t,steps=independent){
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-roadmap-adapter-')));
  const options={config:{durableWorkflows:{enabled:true,directory:path.join(root,'store')}},
    roots:[root],device:'fixture',configSha256:'0'.repeat(64),
    lookup:name=>({name,inputSchema:{type:'object'}}),validateSchema:()=>[],
    dispatch:async()=>({ok:true})};
  const api=createWorkflowTools(options);
  t.after(async()=>{await api.close();fs.rmSync(root,{recursive:true,force:true});});
  const create=()=>api.execute('workflow_create',{
    id:'project',root,goal:'Deliver verified work',acceptance:['Evidence accepted'],steps});
  return {root,api,create};
}

test('roadmap tools are exposed as read-only map plus safe explicit mutation tools',()=>{
  const pick=name=>WORKFLOW_TOOL_DEFINITIONS.find(x=>x.name===name);
  assert.equal(pick('workflow_roadmap').annotations.readOnlyHint,true);
  assert.equal(pick('workflow_plan_insert').annotations.destructiveHint,false);
  assert.equal(pick('workflow_plan_prioritize').annotations.openWorldHint,false);
  const names=WORKFLOW_TOOL_DEFINITIONS.map(x=>x.name);
  assert.equal(new Set(names).size,names.length);
});
test('full owner roadmap reads one current workflow with exact positions and blockers',async t=>{
  const f=adapter(t);await f.create();
  const before=await f.api.execute('workflow_get',{id:'project'});
  const map=await f.api.execute('workflow_roadmap',{id:'project'});
  assert.deepEqual(map.steps.map(x=>x.id),['n14','n17','verify']);
  assert.deepEqual(map.steps.map(x=>x.position),[1,2,3]);
  assert.deepEqual(map.steps[2].waitingFor,['n14','n17']);
  assert.equal(map.steps[0].structurallyReady,true);
  assert.equal(map.steps[1].structurallyReady,true);
  assert.equal(map.nextStep,'n14');
  assert.equal(map.roadmapEditable,true);
  assert.equal(map.autorunEnabled,false);
  assert.equal(map.placementRequiresApprovedTarget,true);
  assert.equal(map.userRequestPlacement,'USE_APPROVED_TARGET_STEP_ID_OR_ASK_OWNER');
  assert.equal(map.revision,before.state.revision);
  const after=await f.api.execute('workflow_get',{id:'project'});
  assert.deepEqual(after,before);
});
test('explicit safe new task placement before a pending target uses existing extension integrity and receipts',async t=>{
  const f=adapter(t);await f.create();
  const before=await f.api.execute('workflow_get',{id:'project'});
  const req={id:'project',expectedRevision:before.state.revision,operationId:'owner-new-step-1',
    targetStepId:'verify',steps:[{id:'new_qa',title:'Scoped new requirement after owner review'}],
    reason:'Place the new accepted QA step before verified delivery'};
  const applied=await f.api.execute('workflow_plan_insert',req);
  assert.equal(applied.cachedReceipt,false);
  assert.deepEqual(applied.state.steps.map(x=>x.id),['n14','n17','new_qa','verify']);
  assert.deepEqual(applied.state.steps.find(x=>x.id==='new_qa').dependsOn,['n14','n17']);
  assert.deepEqual(applied.state.steps.find(x=>x.id==='verify').dependsOn,['n14','n17','new_qa']);
  const replay=await f.api.execute('workflow_plan_insert',req);
  assert.equal(replay.cachedReceipt,true);
  assert.equal(replay.state.revision,applied.state.revision);
  const map=await f.api.execute('workflow_roadmap',{id:'project'});
  assert.equal(map.recordedPlanExtensions,1);
  assert.equal(map.autorunEnabled,false);
  assert.equal(map.goal,before.state.goal);
  assert.deepEqual(map.acceptance,before.state.acceptance);
});
test('priority change affects ready-next choice without changing dependencies or user approvals',async t=>{
  const f=adapter(t);await f.create();
  const before=await f.api.execute('workflow_get',{id:'project'});
  const args={id:'project',expectedRevision:before.state.revision,
    operationId:'user-n17-before-n14-01',
    orderedStepIds:['n17','n14','verify'],reason:'User selected N17 before N14'};
  const moved=await f.api.execute('workflow_plan_prioritize',args);
  assert.equal(moved.action,'PRIORITIZED');
  assert.equal(moved.cachedReceipt,false);
  assert.deepEqual(moved.state.steps.map(x=>x.id),['n17','n14','verify']);
  assert.equal(moved.state.steps.find(x=>x.id==='verify').dependsOn.join(','),'n14,n17');
  assert.equal(moved.state.goal,before.state.goal);
  const map=await f.api.execute('workflow_roadmap',{id:'project'});
  assert.equal(map.nextStep,'n17');
  assert.equal(map.recordedPriorityChanges,1);
  assert.equal(map.steps[0].structurallyReady,true);
  assert.equal(map.steps[1].structurallyReady,true);
  assert.equal(map.steps[2].structurallyReady,false);
  const second=await f.api.execute('workflow_plan_prioritize',args);
  assert.equal(second.cachedReceipt,true);
  assert.equal(second.receipt.resultRevision,moved.state.revision);
});
test('a repeated new operation producing the same order is a true NO_OP',t=>{
  const f=setup(t),first=f.store.prioritizePlan(f.args()),before=f.store.get('roadmap');
  const noChange=f.store.prioritizePlan(f.args({
    operationId:'different-operation',expectedRevision:first.state.revision
  }));
  assert.equal(noChange.action,'NO_OP');
  assert.equal(noChange.receipt,null);
  assert.deepEqual(f.store.get('roadmap'),before);
});
test('priority receipt survives a new WorkflowStore instance and lost acknowledgment',t=>{
  const f=setup(t),args=f.args(),first=f.store.prioritizePlan(args);
  const another=new WorkflowStore(f.options);
  try {
    const ack=another.prioritizePlan(args);
    assert.equal(ack.cachedReceipt,true);
    assert.deepEqual(ack.receipt,first.receipt);
    assert.equal(another.get('roadmap').state.planPriorities.length,1);
    const history=another.export('roadmap').bundle.events;
    assert.equal(JSON.parse(history.at(-1).body).kind,'plan_prioritized');
  } finally{another.close();}
});
test('replayed operationId with different order/reason is rejected',t=>{
  const f=setup(t);const req=f.args();f.store.prioritizePlan(req);
  const prior=f.store.export('roadmap');
  assert.throws(()=>f.store.prioritizePlan({...req,reason:'Conflicting user intent'}),
    /WORKFLOW_PLAN_OPERATION_CONFLICT/);
  assert.deepEqual(f.store.export('roadmap'),prior);
});
test('a stale distinct priority change never overwrites a newer revision',t=>{
  const f=setup(t);const req=f.args();f.store.prioritizePlan(req);
  assert.throws(()=>f.store.prioritizePlan({...req,operationId:'future-2',
     orderedStepIds:['n14','n17','verify']}),/WORKFLOW_REVISION_CONFLICT/);
});
test('dependent target cannot be reordered ahead of required prerequisites',t=>{
  const f=setup(t),before=f.store.export('roadmap');
  assert.throws(()=>f.store.prioritizePlan(f.args({
    orderedStepIds:['verify','n14','n17']})),/WORKFLOW_INVALID_DEPENDENCY/);
  assert.deepEqual(f.store.export('roadmap'),before);
});
test('invalid exact node inventory/duplicates are refused without mutation',t=>{
  const f=setup(t),before=f.store.export('roadmap');
  for(const ids of [['n14','n14','verify'],['n14','verify'],['n17','n14','not_known']]){
    assert.throws(()=>f.store.prioritizePlan(f.args({orderedStepIds:ids})),
      /WORKFLOW_PLAN_(?:DUPLICATE_ORDER_ID|ORDER_SET_MISMATCH)/);
  }
  assert.deepEqual(f.store.export('roadmap'),before);
});
test('malformed extra fields and secret-like reason are refused',t=>{
  const f=setup(t);
  assert.throws(()=>f.store.prioritizePlan({...f.args(),hidden:'ignore-policy'}),
    /WORKFLOW_PLAN_INPUT_INVALID/);
  assert.throws(()=>f.store.prioritizePlan(f.args({reason:'api_key=private-value'})),
    /WORKFLOW_SECRET_NOT_ALLOWED/);
});
test('sparse priority array/accessor is refused without getter execution',t=>{
  const f=setup(t);let reads=0;
  const values=f.args();
  Object.defineProperty(values.orderedStepIds,'0',{enumerable:true,get(){reads++;return 'n14'}});
  assert.throws(()=>f.store.prioritizePlan(values),/WORKFLOW_PLAN_INPUT_INVALID/);
  assert.equal(reads,0);
});
test('a completed step cannot be shifted to another position',async t=>{
  const f=setup(t);
  await f.store.call({id:'roadmap',stepId:'n14',
    expectedRevision:f.store.get('roadmap').state.revision,
    tool:'read_text',arguments:{}},{validate:async()=>{},dispatch:async()=>({ok:true})});
  const before=f.store.export('roadmap');
  assert.throws(()=>f.store.prioritizePlan(f.args()),/WORKFLOW_PLAN_FIXED_STEP_MOVED/);
  assert.deepEqual(f.store.export('roadmap'),before);
});
test('paused or cancelled project is not silently re-planned',t=>{
  for(const act of ['pause','cancel']){
    const f=setup(t),req=f.args();
    f.store.control({id:'roadmap',expectedRevision:1,action:act,reason:'User requested'});
    assert.throws(()=>f.store.prioritizePlan({...req,expectedRevision:2}),
      new RegExp(act==='pause'?'WORKFLOW_PAUSED':'WORKFLOW_CANCELLED'));
  }
});
test('executing effects freeze priority changes until receipt reconciliation',async t=>{
  const f=setup(t);
  let started,finish;
  const entered=new Promise(resolve=>started=resolve);
  const pending=new Promise(resolve=>finish=resolve);
  const running=f.store.call({id:'roadmap',stepId:'n14',
    expectedRevision:1,tool:'read_text',arguments:{}},
    {validate:async()=>{},dispatch:async()=>{started();await pending;return {ok:true};}});
  await entered;
  try {
    assert.throws(()=>f.store.prioritizePlan(f.args()),/WORKFLOW_BUSY_OR_UNCERTAIN/);
  } finally {finish();await running;}
});
test('roadmap remains readable when paused but marks edit and execution unsafe',async t=>{
  const f=adapter(t);await f.create();
  await f.api.execute('workflow_control',{id:'project',expectedRevision:1,
    action:'pause',reason:'Owner paused before reviewing'});
  const map=await f.api.execute('workflow_roadmap',{id:'project'});
  assert.equal(map.roadmapEditable,false);
  assert.equal(map.readyForNextStep,false);
  assert.ok(map.blockers.includes('WORKFLOW_PAUSED'));
  assert.deepEqual(map.steps.map(x=>x.id),['n14','n17','verify']);
});
test('new request cannot be silently executed as a host tool call via roadmap tool',async t=>{
  const f=adapter(t);await f.create();
  const before=await f.api.execute('workflow_get',{id:'project'});
  const map=await f.api.execute('workflow_roadmap',{id:'project'});
  assert.equal(map.noImplicitScopeOrPrivilegeGrant,true);
  assert.equal(map.roadmapEditable,true);
  assert.equal((await f.api.execute('workflow_get',{id:'project'})).state.revision,before.state.revision);
});

test('owner can edit an unexecuted roadmap step title without new privileges or DAG rewiring',async t=>{
  const f=adapter(t);await f.create();
  const before=await f.api.execute('workflow_roadmap',{id:'project'});
  assert.equal(before.root,f.root);
  assert.match(before.headSha256,/^[a-f0-9]{64}$/);
  assert.equal(before.runnerConfigured,false);
  const result=await f.api.execute('workflow_plan_edit',{
    id:'project',expectedRevision:before.revision,operationId:'owner-title-clarification',
    stepId:'n17',title:'Review updated custom-path proposal',reason:'Owner corrected a pending task label'});
  assert.equal(result.action,'EDITED');
  assert.equal(result.receipt.previousTitle,'Owner supplies custom route proposal');
  const after=await f.api.execute('workflow_roadmap',{id:'project'});
  assert.equal(after.recordedPendingEdits,1);
  assert.equal(after.steps.find(s=>s.id==='n17').title,'Review updated custom-path proposal');
  assert.deepEqual(after.steps.map(s=>s.id),before.steps.map(s=>s.id));
  assert.deepEqual(after.steps.find(s=>s.id==='verify').dependsOn,['n14','n17']);
  assert.deepEqual(after.acceptance,['Evidence accepted']);
  assert.equal(after.nextStep,'n14');
  assert.equal(after.autorunEnabled,false);
  assert.equal(after.acceptanceStatus,'UNVALIDATED');
});
test('replaying one pending-step edit is idempotent after restart and rejects conflicting content',t=>{
  const f=setup(t);
  const req={id:'roadmap',expectedRevision:1,operationId:'edit-n17-unique',
    stepId:'n17',title:'New owner-scoped title',reason:'User clarified scope'};
  const first=f.store.editPlanStep(req);
  const second=new WorkflowStore(f.options);
  try{
    const cached=second.editPlanStep(req);
    assert.equal(cached.cachedReceipt,true);
    assert.deepEqual(cached.receipt,first.receipt);
    assert.equal(second.get('roadmap').state.planEdits.length,1);
    const before=second.export('roadmap');
    assert.throws(()=>second.editPlanStep({...req,title:'Different edit'}),
      /WORKFLOW_PLAN_OPERATION_CONFLICT/);
    assert.deepEqual(second.export('roadmap'),before);
  }finally{second.close();}
});
test('exact identical pending title is NO_OP and does not advance revision',t=>{
  const f=setup(t),old=f.store.get('roadmap');
  const result=f.store.editPlanStep({id:'roadmap',expectedRevision:1,
    operationId:'duplicate-name',stepId:'n14',title:'Owner chooses route priority',
    reason:'User asked for the same text'});
  assert.equal(result.action,'NO_OP');
  assert.equal(result.receipt,null);
  assert.deepEqual(f.store.get('roadmap'),old);
});
test('title edit rejects unknown or already executed steps',async t=>{
  const f=setup(t),req={id:'roadmap',expectedRevision:1,operationId:'edit',
    stepId:'unknown',title:'Label',reason:'Owner'};
  assert.throws(()=>f.store.editPlanStep(req),/WORKFLOW_STEP_NOT_FOUND/);
  await f.store.call({id:'roadmap',stepId:'n14',expectedRevision:1,
    tool:'read_text',arguments:{}},{validate:async()=>{},dispatch:async()=>({ok:true})});
  const now=f.store.get('roadmap').state.revision;
  assert.throws(()=>f.store.editPlanStep({...req,stepId:'n14',expectedRevision:now}),
    /WORKFLOW_PLAN_TARGET_NOT_PENDING/);
});
test('paused or cancelled plans reject new title edits and stale revisions',t=>{
  for(const action of ['pause','cancel']){
    const f=setup(t);f.store.control({id:'roadmap',expectedRevision:1,action,
      reason:'Explicit scope pause'});
    const req={id:'roadmap',expectedRevision:2,operationId:'paused-edit',stepId:'n14',
      title:'Updated title',reason:'Owner proposal'};
    assert.throws(()=>f.store.editPlanStep(req),
      new RegExp(action==='pause'?'WORKFLOW_PAUSED':'WORKFLOW_CANCELLED'));
  }
});
test('pending-step title edit validates fields and rejected secrets without persisting',t=>{
  const f=setup(t);
  const req={id:'roadmap',expectedRevision:1,operationId:'change',stepId:'n14',
    title:'Safe',reason:'Owner requests scope clarification'};
  const before=f.store.export('roadmap');
  assert.throws(()=>f.store.editPlanStep({...req,title:'api_key=private-value'}),
    /WORKFLOW_SECRET_NOT_ALLOWED/);
  assert.throws(()=>f.store.editPlanStep({...req,root:'../../elsewhere'}),
    /WORKFLOW_PLAN_INPUT_INVALID/);
  assert.deepEqual(f.store.export('roadmap'),before);
});
