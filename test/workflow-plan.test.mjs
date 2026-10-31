import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WorkflowStore, canonical, hash } from '../src/workflow-store.mjs';

const moduleUrl = new URL('../src/workflow-store.mjs', import.meta.url).href;
const structuralHash = steps => hash(canonical(steps.map(({id,title,dependsOn})=>({id,title,dependsOn}))));
function fixture(t, steps=[{id:'first',title:'Inspect'},{id:'target',title:'Deliver'}]) {
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-workflow-plan-')));
  const options={directory:path.join(root,'memory'),allowedRoots:[root],device:'fixture',configSha256:'1'.repeat(64)};
  const store=new WorkflowStore(options);
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  store.create({id:'sample',root,goal:'Deliver the enrolled project',acceptance:['Independent proof'],steps});
  fs.writeFileSync(path.join(root,'proof.txt'),'verified');
  const request=(extra={})=>({id:'sample',expectedRevision:store.get('sample').state.revision,
    operationId:'extension-1',targetStepId:'target',steps:[{id:'prerequisite',title:'Inspect prerequisite'}],reason:'Resolve missing prerequisite',...extra});
  const call=(stepId,dispatch=async()=>({ok:true}))=>store.call({id:'sample',expectedRevision:store.get('sample').state.revision,
    stepId,tool:'read_text',arguments:{}},{validate:async()=>{},dispatch});
  return {root,options,store,request,call};
}
function deferred() { let resolve; const promise=new Promise(r=>{resolve=r;});return {promise,resolve}; }
function runChild(options,request,exitAfterCommit=false) {
  const script=`import {WorkflowStore} from ${JSON.stringify(moduleUrl)};
    const store=new WorkflowStore(JSON.parse(process.argv[1]));
    try {const result=store.extendPlan(JSON.parse(process.argv[2]));
      if(process.argv[3]==='crash')process.exit(73);
      process.stdout.write(JSON.stringify(result));store.close();}
    catch(e){process.stdout.write(e.workflowCode??e.message);store.close();process.exitCode=2;}`;
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',script,JSON.stringify(options),JSON.stringify(request),exitAfterCommit?'crash':'normal'],{stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
    const timer=setTimeout(()=>{child.kill();reject(new Error('extension worker timeout'));},15000);
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('close',code=>{clearTimeout(timer);resolve({code,out,err});});
  });
}

test('insertion preserves enrolled scope, receipts, notes, checkpoint, Brain and append-only history',async t=>{
  const f=fixture(t);await f.call('first');
  f.store.note({id:'sample',expectedRevision:f.store.get('sample').state.revision,kind:'decision',text:'Keep the accepted scope'});
  const brain=path.join(f.root,'PROJECT_BRAIN.md');fs.writeFileSync(brain,'User-authored instructions\n');
  f.store.checkpoint({id:'sample',expectedRevision:f.store.get('sample').state.revision,files:['proof.txt'],nextAction:'Deliver',summary:'Observed initial evidence'});
  const before=f.store.get('sample').state,history=f.store.export('sample').bundle.events;
  const brainBefore=fs.readFileSync(brain),jsonBefore=fs.readFileSync(path.join(f.root,'project-brain.sample.json'));
  const request=f.request({steps:[{id:'inspect_more',title:'Inspect another input'},{id:'prepare',title:'Prepare delivery'}]});
  const result=f.store.extendPlan(request),after=result.state;
  assert.equal(result.cachedReceipt,false);assert.equal(after.revision,before.revision+1);
  for(const [key,value] of Object.entries(before)) if(!['steps','planExtensions','revision','updatedAt'].includes(key)) assert.deepEqual(after[key],value,key);
  assert.deepEqual(after.steps[0],before.steps[0]);
  assert.deepEqual(after.steps.map(s=>s.id),['first','inspect_more','prepare','target']);
  assert.deepEqual(after.steps[1].dependsOn,['first']);assert.deepEqual(after.steps[2].dependsOn,['inspect_more']);
  assert.deepEqual(after.steps[3],{...before.steps[1],dependsOn:['first','prepare']});
  assert.deepEqual(result.receipt,{operationId:request.operationId,targetStepId:'target',sourceRevision:before.revision,
    resultRevision:after.revision,addedStepIds:['inspect_more','prepare'],
    payloadHash:hash(canonical({targetStepId:request.targetStepId,steps:request.steps,reason:request.reason})),
    sourcePlanHash:structuralHash(before.steps),resultPlanHash:structuralHash(after.steps)});
  assert.deepEqual(after.planExtensions,[result.receipt]);
  assert.deepEqual(f.store.export('sample').bundle.events.slice(0,-1),history);
  const event=f.store.export('sample').bundle.events.at(-1);
  assert.equal(JSON.parse(event.body).kind,'plan_extended');assert.equal(event.sha256,hash(event.body));
  assert.deepEqual(JSON.parse(event.body).data.receipt,result.receipt);
  assert.deepEqual(fs.readFileSync(brain),brainBefore);assert.deepEqual(fs.readFileSync(path.join(f.root,'project-brain.sample.json')),jsonBefore);
  assert.equal(f.store.resume('sample').nextStep,'inspect_more');
  await assert.rejects(f.call('target'),/WORKFLOW_DEPENDENCY/);
  await f.call('inspect_more');await f.call('prepare');await f.call('target');
  const final=f.store.finalize({id:'sample',expectedRevision:f.store.get('sample').state.revision,files:['proof.txt'],acceptanceResults:[true],summary:'Verified every prerequisite'});
  assert.equal(final.state.lifecycleState,'COMPLETED');assert.match(fs.readFileSync(brain,'utf8'),/User-authored instructions/);
});

test('explicit branches can depend on transitive target ancestors and all new sinks gate the target',t=>{
  const f=fixture(t,[{id:'ancestor',title:'Ancestor'},{id:'parent',title:'Parent'},
    {id:'sibling',title:'Independent branch',dependsOn:[]},{id:'target',title:'Deliver',dependsOn:['parent']}]);
  const result=f.store.extendPlan(f.request({steps:[{id:'left',title:'Left',dependsOn:['ancestor']},
    {id:'right',title:'Right',dependsOn:[]},{id:'joined',title:'Join left',dependsOn:['left','parent']}]}));
  assert.deepEqual(result.state.steps.at(-1).dependsOn,['parent','right','joined']);
  assert.deepEqual(result.state.steps.find(s=>s.id==='sibling').dependsOn,[]);
});

test('exact replay is durable and immutable at source or current revision, including after pause',t=>{
  const f=fixture(t),request=f.request(),first=f.store.extendPlan(request);
  const second=new WorkflowStore(f.options);
  try {
    const duplicate=second.extendPlan(request);assert.equal(duplicate.cachedReceipt,true);assert.deepEqual(duplicate.receipt,first.receipt);
    second.note({id:'sample',expectedRevision:2,kind:'fact',text:'Later independent observation'});
    assert.equal(second.extendPlan(request).state.revision,3);
    assert.deepEqual(second.extendPlan({...request,expectedRevision:3}).receipt,first.receipt);
    assert.throws(()=>second.extendPlan({...request,expectedRevision:2}),/WORKFLOW_REVISION_CONFLICT/);
    second.control({id:'sample',expectedRevision:3,action:'pause',reason:'Explicit pause'});
    assert.equal(second.extendPlan(request).cachedReceipt,true);
    assert.equal(second.get('sample').state.planExtensions.length,1);
    assert.throws(()=>second.extendPlan({...request,reason:'Different requested reason'}),/WORKFLOW_PLAN_OPERATION_CONFLICT/);
    assert.throws(()=>second.extendPlan({...request,steps:[{...request.steps[0],dependsOn:['first']}]}),/WORKFLOW_PLAN_OPERATION_CONFLICT/);
  } finally {second.close();}
});

test('transient SQLite journal disappearance is benign but persistent aliases fail closed',t=>{
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-workflow-journal-race-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,'memory');
  const opts={directory,allowedRoots:[root],device:'fixture',configSha256:'1'.repeat(64)};
  fs.mkdirSync(directory,{recursive:true});
  const transient=new Set([path.join(directory,'workflows.sqlite-journal'),path.join(directory,'root-leases.sqlite-journal')]);
  const exists=fs.existsSync,lstat=fs.lstatSync;
  let simulated=0;
  try {
    // Reproduce the old check-then-lstat TOCTOU deterministically.
    fs.existsSync=function(file){if(transient.has(String(file)))return true;return exists.call(fs,file);};
    fs.lstatSync=function(file,...args){
      if(transient.has(String(file))){simulated++;const err=new Error('simulated SQLite journal deletion');err.code='ENOENT';throw err;}
      return lstat.call(fs,file,...args);
    };
    const store=new WorkflowStore(opts);store.close();
  } finally {fs.existsSync=exists;fs.lstatSync=lstat;}
  assert.ok(simulated>=2,'both SQLite stores inspected');
  const journal=path.join(directory,'workflows.sqlite-journal');
  try {
    fs.symlinkSync(path.join(root,'missing-target'),journal);
    assert.throws(()=>new WorkflowStore(opts),/WORKFLOW_LINK_NOT_ALLOWED|WORKFLOW_DATABASE_ALIAS/);
    fs.unlinkSync(journal);
  } catch(error) {
    if(!['EPERM','EACCES','ENOTSUP'].includes(error.code))throw error;
    t.diagnostic('OS denied symlink creation; hardlink guard is still tested');
  }
  // Existing hardlinks must remain rejected even if they look like plain files.
  const source=path.join(root,'plain.txt');fs.writeFileSync(source,'a');
  fs.linkSync(source,journal);
  assert.throws(()=>new WorkflowStore(opts),/WORKFLOW_DATABASE_ALIAS/);
});

test('two processes with the same source revision commit exactly one different extension',async t=>{
  const f=fixture(t),one=f.request(),two=f.request({operationId:'extension-2',steps:[{id:'other',title:'Other'}]});
  const results=await Promise.all([runChild(f.options,one),runChild(f.options,two)]);
  assert.equal(results.filter(r=>r.code===0).length,1,JSON.stringify(results));
  assert.equal(results.filter(r=>r.code===2&&r.out==='WORKFLOW_REVISION_CONFLICT').length,1,JSON.stringify(results));
  assert.equal(f.store.get('sample').state.revision,2);assert.equal(f.store.get('sample').state.planExtensions.length,1);
});

test('vanishing SQLite rollback journal is tolerated during concurrent store startup',t=>{
  const f=fixture(t);
  const journal=path.join(f.options.directory,'workflows.sqlite-journal');
  const realLstat=fs.lstatSync;
  const realExists=fs.existsSync;
  let transientJournalChecks=0;
  // Force the historical existsSync/lstatSync time-of-check/time-of-use race.
  // A successful startup must not rely on the journal remaining present.
  t.mock.method(fs,'existsSync',(candidate,...rest)=>
    candidate===journal?true:realExists(candidate,...rest));
  t.mock.method(fs,'lstatSync',(candidate,...rest)=>{
    if(candidate===journal){
      transientJournalChecks++;
      const error=new Error('SQLite completed and removed rollback journal');
      error.code='ENOENT';
      throw error;
    }
    return realLstat(candidate,...rest);
  });
  const reopened=new WorkflowStore(f.options);
  try {
    assert.ok(transientJournalChecks>0,'transient SQLite journal must be inspected');
    assert.equal(reopened.get('sample').state.revision,1);
  } finally {reopened.close();}
});

test('two processes replaying one operation commit once and receive identical receipts',async t=>{
  const f=fixture(t),request=f.request();const results=await Promise.all([runChild(f.options,request),runChild(f.options,request)]);
  for(const r of results)assert.equal(r.code,0,r.out+r.err);
  const [a,b]=results.map(r=>JSON.parse(r.out));assert.deepEqual(a.receipt,b.receipt);
  assert.notEqual(a.cachedReceipt,b.cachedReceipt);assert.equal(f.store.get('sample').state.revision,2);
});

test('commit followed by process exit remains recoverable without replaying the mutation',async t=>{
  const f=fixture(t),request=f.request();const child=await runChild(f.options,request,true);assert.equal(child.code,73,child.err);
  const reopened=new WorkflowStore(f.options);
  try {const result=reopened.extendPlan(request);assert.equal(result.cachedReceipt,true);assert.equal(result.state.revision,2);
    assert.equal(result.receipt.resultPlanHash,structuralHash(result.state.steps));assert.equal(result.state.steps.length,3);}
  finally{reopened.close();}
});

const invalidRequests=[
  ['unknown top-level field',r=>({...r,root:'C:\\outside'}),/WORKFLOW_PLAN_INPUT_INVALID/],
  ['unknown step field',r=>({...r,steps:[{id:'extra',title:'Extra',tool:'write_text'}]}),/WORKFLOW_PLAN_INPUT_INVALID/],
  ['missing reason',r=>{delete r.reason;return r;},/WORKFLOW_PLAN_INPUT_INVALID/],
  ['non-object request',()=>null,/WORKFLOW_PLAN_INPUT_INVALID/],
  ['path step identifier',r=>({...r,steps:[{id:'../escape',title:'Extra'}]}),/WORKFLOW_INVALID_ID/],
  ['invalid operation identifier',r=>({...r,operationId:'../operation'}),/WORKFLOW_PLAN_OPERATION_ID/],
  ['zero revision',r=>({...r,expectedRevision:0}),/WORKFLOW_REVISION_REQUIRED/],
  ['stale revision',r=>({...r,expectedRevision:7}),/WORKFLOW_REVISION_CONFLICT/],
  ['no steps',r=>({...r,steps:[]}),/WORKFLOW_PLAN_STEP_LIMIT/],
  ['more than twenty steps',r=>({...r,steps:Array.from({length:21},(_,i)=>({id:`added_${i}`,title:'Extra'}))}),/WORKFLOW_PLAN_STEP_LIMIT/],
  ['existing identifier',r=>({...r,steps:[{id:'first',title:'Extra'}]}),/WORKFLOW_DUPLICATE_STEP/],
  ['duplicate inserted identifier',r=>({...r,steps:[{id:'extra',title:'Extra'},{id:'extra',title:'Again'}]}),/WORKFLOW_DUPLICATE_STEP/],
  ['target dependency',r=>({...r,steps:[{id:'extra',title:'Extra',dependsOn:['target']}]}),/WORKFLOW_INVALID_DEPENDENCY/],
  ['self dependency',r=>({...r,steps:[{id:'extra',title:'Extra',dependsOn:['extra']}]}),/WORKFLOW_INVALID_DEPENDENCY/],
  ['forward dependency',r=>({...r,steps:[{id:'extra',title:'Extra',dependsOn:['later']},{id:'later',title:'Later'}]}),/WORKFLOW_INVALID_DEPENDENCY/],
  ['duplicate dependency',r=>({...r,steps:[{id:'extra',title:'Extra',dependsOn:['first','first']}]}),/WORKFLOW_INVALID_DEPENDENCY/],
  ['null dependency list',r=>({...r,steps:[{id:'extra',title:'Extra',dependsOn:null}]}),/WORKFLOW_INVALID_DEPENDENCY/],
  ['secret-shaped reason',r=>({...r,reason:'password=private-value'}),/WORKFLOW_SECRET_NOT_ALLOWED/],
  ['secret-shaped title',r=>({...r,steps:[{id:'extra',title:'api_key=private-value'}]}),/WORKFLOW_SECRET_NOT_ALLOWED/],
  ['control character',r=>({...r,reason:'unsafe\u0000text'}),/WORKFLOW_INVALID_TEXT/],
  ['oversized title',r=>({...r,steps:[{id:'extra',title:'x'.repeat(501)}]}),/WORKFLOW_INVALID_TEXT/],
  ['oversized reason',r=>({...r,reason:'x'.repeat(1001)}),/WORKFLOW_INVALID_TEXT/],
  ['unknown target',r=>({...r,targetStepId:'missing'}),/WORKFLOW_STEP_NOT_FOUND/],
  ['sparse steps',r=>({...r,steps:new Array(1)}),/WORKFLOW_PLAN_INPUT_INVALID/],
  ['extra array field',r=>{r.steps.hidden='unknown';return r;},/WORKFLOW_PLAN_INPUT_INVALID/],
  ['array subclass',r=>{r.steps=Object.setPrototypeOf(r.steps,{});return r;},/WORKFLOW_PLAN_INPUT_INVALID/]
];
for(const [name,change,error] of invalidRequests)test(`rejects ${name} without changing durable state`,t=>{
  const f=fixture(t),before=f.store.export('sample');assert.throws(()=>f.store.extendPlan(change(f.request())),error);
  assert.deepEqual(f.store.export('sample'),before);
});

test('input accessors are rejected without evaluating them',t=>{
  const f=fixture(t);let reads=0;const getter={enumerable:true,get(){reads++;return 'Unexpected';}};
  const a=f.request();Object.defineProperty(a,'reason',getter);
  const b=f.request();Object.defineProperty(b.steps[0],'title',getter);
  const c=f.request();Object.defineProperty(c.steps,'0',getter);
  const d=f.request({steps:[{id:'extra',title:'Extra',dependsOn:['first']}]});Object.defineProperty(d.steps[0].dependsOn,'0',getter);
  for(const r of [a,b,c,d])assert.throws(()=>f.store.extendPlan(r),/WORKFLOW_PLAN_INPUT_INVALID/);
  assert.equal(reads,0);assert.equal(f.store.get('sample').state.revision,1);
});

test('unrelated existing branches cannot be injected as prerequisite dependencies',t=>{
  const f=fixture(t,[{id:'first',title:'First'},{id:'sibling',title:'Sibling',dependsOn:[]},{id:'target',title:'Target',dependsOn:['first']}]);
  assert.throws(()=>f.store.extendPlan(f.request({steps:[{id:'extra',title:'Extra',dependsOn:['sibling']}]})),/WORKFLOW_INVALID_DEPENDENCY/);
});

test('one hundred total steps is a hard ceiling',t=>{
  const f=fixture(t,Array.from({length:99},(_,i)=>({id:i===98?'target':`original_${i}`,title:'Original'})));
  f.store.extendPlan(f.request());assert.equal(f.store.get('sample').state.steps.length,100);
  const before=f.store.export('sample');assert.throws(()=>f.store.extendPlan(f.request({operationId:'overflow',steps:[{id:'overflow',title:'Overflow'}]})),/WORKFLOW_PLAN_STEP_LIMIT/);
  assert.deepEqual(f.store.export('sample'),before);
});

for(const action of ['pause','cancel'])test(`explicit ${action} blocks a new extension`,t=>{
  const f=fixture(t);f.store.control({id:'sample',expectedRevision:1,action,reason:'Explicit test control'});
  const before=f.store.export('sample');assert.throws(()=>f.store.extendPlan(f.request()),action==='pause'?/WORKFLOW_PAUSED/:/WORKFLOW_CANCELLED/);
  assert.deepEqual(f.store.export('sample'),before);
});

test('an in-flight action blocks topology changes and a successful receipt permits extension afterward',async t=>{
  const f=fixture(t),started=deferred(),finish=deferred();
  const pending=f.call('first',async()=>{started.resolve();await finish.promise;return {ok:true};});await started.promise;
  try{assert.throws(()=>f.store.extendPlan(f.request()),/WORKFLOW_BUSY_OR_UNCERTAIN/);}
  finally{finish.resolve();await pending;}
  assert.equal(f.store.get('sample').state.lifecycleState,'RUNNING');
  assert.equal(f.store.extendPlan(f.request()).state.steps.length,3);
});

test('uncertain effects block extension until independent reconciliation',async t=>{
  const f=fixture(t);await f.call('first',async()=>({ok:false}));
  assert.throws(()=>f.store.extendPlan(f.request()),/WORKFLOW_BUSY_OR_UNCERTAIN/);
  f.store.reconcile({id:'sample',stepId:'first',expectedRevision:f.store.get('sample').state.revision,outcome:'applied',files:['proof.txt'],explanation:'Independent effect evidence'});
  assert.equal(f.store.extendPlan(f.request()).state.steps.length,3);
});

test('already executed target cannot be reused as a new plan slot',async t=>{
  const f=fixture(t);await f.call('first');await f.call('target');
  assert.throws(()=>f.store.extendPlan(f.request()),/WORKFLOW_PLAN_TARGET_NOT_PENDING/);
});

test('interrupted finalization and completed workflow both deny new extensions',async t=>{
  const f=fixture(t);await f.call('first');await f.call('target');
  const brain=path.join(f.root,'PROJECT_BRAIN.md');fs.mkdirSync(brain);
  const args=()=>({id:'sample',expectedRevision:f.store.get('sample').state.revision,files:['proof.txt'],acceptanceResults:[true],summary:'Final proof'});
  assert.throws(()=>f.store.finalize(args()));assert.equal(f.store.get('sample').state.lifecycleState,'FINALIZING');
  assert.throws(()=>f.store.extendPlan(f.request()),/WORKFLOW_PLAN_STATE_BLOCKED/);
  fs.rmdirSync(brain);f.store.finalize(args());
  assert.throws(()=>f.store.extendPlan(f.request()),/WORKFLOW_ALREADY_COMPLETED/);
});

test('device identity drift denies even an exact receipt replay',t=>{
  const f=fixture(t),request=f.request();f.store.extendPlan(request);
  const changed=new WorkflowStore({...f.options,device:'other'});
  try{assert.throws(()=>changed.extendPlan(request),/WORKFLOW_IDENTITY_CHANGED/);}finally{changed.close();}
});
