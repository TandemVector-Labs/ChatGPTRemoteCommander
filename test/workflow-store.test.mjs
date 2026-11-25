import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowStore, canonical, hash } from '../src/workflow-store.mjs';
import { classifyTool, reconciliationPlan } from '../src/workflow-autonomy.mjs';
import { powerToolDefinitions } from '../src/power-tools-v0.3.mjs';
import { agentExtensionToolDefinitions } from '../src/agent-extensions.mjs';
import { runContainedProjectCommand, processContainmentAvailable } from '../src/process-containment.mjs';
const worker = fileURLToPath(new URL('./workflow-worker.mjs', import.meta.url));
const fixture = (overrides = {}) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-memory-')));
  // Spawned workers reopen the same workflow with the exact same owner tier.
  const authority={profileId:'default',tier:'FULL_POWER',
    capabilities:['filesystem.full','workflow.durable','workflow.scheduler']};
  const options = { directory: path.join(root, 'memory'), allowedRoots: [root],
    device: 'fixture', configSha256: '1'.repeat(64), authority, ...overrides };
  const s = new WorkflowStore(options);
  const create = (id='sample') => s.create({ id, root, goal: 'Resume safely', acceptance: ['Validate visible outcome'], steps: [{ id: 'first', title: 'Inspect' }, { id: 'second', title: 'Act' }] });
  return { root, options, s, create, dispose() { s.close(); fs.rmSync(root, { recursive: true, force: true }); } };
};
function runWorker(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [worker, ...args], { stdio: ['ignore','pipe','pipe'] });
    let out='', err=''; p.stdout.on('data',d=>out+=d); p.stderr.on('data',d=>err+=d);
    const timer = setTimeout(()=>{p.kill();reject(new Error('worker timeout'));},15000);
    p.once('error',reject); p.once('close',code=>{clearTimeout(timer);resolve({code,out,err});});
  });
}
const host = dispatch => ({ validate: async()=>{}, dispatch });
function expireRootLease(f){
  const db=new DatabaseSync(path.join(f.options.directory,'root-leases.sqlite'));
  try{
    const key=process.platform==='win32'?path.resolve(f.root).toLowerCase():path.resolve(f.root);
    const row=db.prepare('SELECT root FROM root_leases WHERE root=?').get(key);
    assert.ok(row,'uncertain operation must retain its exact root lease');
    db.prepare('UPDATE root_leases SET expires_at=? WHERE root=?').run('2000-01-01T00:00:00.000Z',row.root);
  }finally{db.close();}
}

const call = (f, extra={}) => f.s.call({ id:'sample',stepId:'first',expectedRevision:1,tool:'read_text',arguments:{path:'x'},...extra },host(async()=>({ok:true})));

test('host-declared read-only inspection tools have safe-retry receipts and verified workflow status',async()=>{
  for(const tool of ['search_files','system_info','list_processes']){
    assert.equal(classifyTool(tool,{}),'READ_ONLY');
    assert.deepEqual(reconciliationPlan(tool,{}),{strategy:'SAFE_RETRY',classification:'READ_ONLY'});
    const f=fixture();
    try{
      f.create();
      let dispatches=0;
      const result=await f.s.call({
        id:'sample',stepId:'first',expectedRevision:1,tool,arguments:{}
      },host(async()=>{dispatches++;return {ok:true};}));
      assert.equal(dispatches,1);
      assert.equal(result.operation.classification,'READ_ONLY');
      assert.equal(result.operation.status,'VERIFIED');
      assert.equal(f.s.get('sample').state.steps[0].status,'verified');
      assert.equal(f.s.operations('sample')[0].status,'VERIFIED');
      assert.equal(f.s.schedulerStatus().currentLeases,0);
    }finally{f.dispose();}
  }
});

test('Host catalog and durable effect classifier remain aligned for Power tools',()=>{
  const names=new Set();
  for(const definition of powerToolDefinitions){
    assert.ok(!names.has(definition.name),'duplicate Host tool definition '+definition.name);
    names.add(definition.name);
    const readOnly=definition.annotations?.readOnlyHint===true;
    const actual=classifyTool(definition.name,{});
    assert.equal(actual==='READ_ONLY',readOnly,
      'Host annotation and workflow classification disagree for '+definition.name);
  }
  const terminal=powerToolDefinitions.find(x=>x.name==='read_terminal');
  assert.ok(terminal,'read_terminal must remain in the Host catalog');
  assert.equal(terminal.annotations.readOnlyHint,false,
    'default read_terminal advances its output cursor and is not safely read-only');
  assert.equal(classifyTool('read_terminal',{}),'NON_IDEMPOTENT_MUTATION');
  assert.equal(classifyTool('read_terminal',{consume:true}),'NON_IDEMPOTENT_MUTATION');
  assert.equal(classifyTool('read_terminal',{consume:false}),'READ_ONLY');
  assert.deepEqual(reconciliationPlan('read_terminal',{consume:false}),
    {strategy:'SAFE_RETRY',classification:'READ_ONLY'});
});

test('whole-token destructive verbs do not mistake agent skill metadata for a kill operation',()=>{
  const readOnlyAgentTools=agentExtensionToolDefinitions.filter(x=>x.annotations?.readOnlyHint===true);
  assert.ok(readOnlyAgentTools.some(x=>x.name==='agent_extension_skill'));
  for(const definition of readOnlyAgentTools){
    assert.notEqual(classifyTool(definition.name,{}),'DESTRUCTIVE',
      'read-only Host tool must not be classified destructive: '+definition.name);
  }
  assert.equal(classifyTool('agent_extension_skill',{}),'NON_IDEMPOTENT_MUTATION');
  assert.equal(classifyTool('skill_repository',{}),'NON_IDEMPOTENT_MUTATION');
  for(const tool of ['delete_path','kill_process','remove_entry','terminate_job','worker_kill_process']){
    assert.equal(classifyTool(tool,{}),'DESTRUCTIVE',tool+' must remain destructive');
  }
});

test('shell execution retains external-effect classification rather than safe retry',()=>{
  assert.equal(classifyTool('run_shell',{command:'echo hello'}),'EXTERNAL_SIDE_EFFECT');
  assert.deepEqual(reconciliationPlan('run_shell',{command:'echo hello'}),{
    strategy:'MANUAL_OR_REMOTE_STATE',classification:'EXTERNAL_SIDE_EFFECT'
  });
});

test('creation, restart, typed notes and scoped search retain exact state',()=>{
  const f=fixture();try {
    f.create(); f.s.note({id:'sample',expectedRevision:1,kind:'fact',text:'سلام project memory'});
    const before=f.s.get('sample'); f.s.close(); const s=new WorkflowStore(f.options);
    try {assert.deepEqual(s.get('sample'),before);assert.equal(s.search({id:'sample',query:'سلام'}).matches.length,1);assert.equal(s.get('sample').state.notes[0].verification,'UNVERIFIED');}finally{s.close();}
  }finally{f.dispose();}
});
test('Brain path is validated before workflow persistence; relative path synchronizes',()=>{
  const f=fixture();try {
    const details={id:'brainpath',root:f.root,goal:'Keep evidence',acceptance:['Brain written'],steps:[{id:'record',title:'Record'}]};
    for(const brainPath of [path.join(f.root,'absolute.md'),'../escape.md','C:\\outside\\PROJECT_BRAIN.md']){
      assert.throws(()=>f.s.create({...details,brainPath}),/WORKFLOW_BRAIN_PATH_INVALID/);
      assert.equal(f.s.list().length,0);
    }
    f.s.create({...details,brainPath:'brain/PROJECT_BRAIN.md'});
    fs.writeFileSync(path.join(f.root,'proof.txt'),'evidence');
    const cp=f.s.checkpoint({id:'brainpath',expectedRevision:1,files:['proof.txt'],nextAction:'Verify',summary:'Checkpoint'});
    assert.equal(cp.brainError,null);
    assert.ok(fs.existsSync(path.join(f.root,'brain','PROJECT_BRAIN.md')));
  }finally{f.dispose();}
});
test('scheduler status distinguishes persisted nonterminal records from active leases',()=>{const f=fixture({schedulerPolicy:{enabled:true}});try{
 f.create();const st=f.s.schedulerStatus();
 assert.equal(st.pending,1);assert.equal(st.persistedNonterminal,1);
 assert.equal(st.pendingMeaning,'PERSISTED_NONTERMINAL_RECORDS_NOT_LIVE_QUEUE');
 assert.equal(st.currentLeases,0);assert.equal(st.hasActiveLease,false);
}finally{f.dispose();}});
test('store scales beyond the legacy 1000-workflow ceiling and exposes bounded pages',()=>{const f=fixture({schedulerPolicy:{enabled:true}});let s=null;try{
  f.s.close();
  const db=new DatabaseSync(path.join(f.options.directory,'workflows.sqlite'));
  try{
    db.exec('BEGIN IMMEDIATE');
    const ins=db.prepare("INSERT INTO workflows(id,revision,head,snapshot) VALUES(?,0,?,?)");
    const sched=db.prepare("INSERT OR REPLACE INTO scheduler_jobs(workflow,lifecycle,enabled,next_run_at,lease_owner,lease_until,retry_count,last_failure,updated_at) VALUES(?,?,?,?,?,?,?,?,?)");
    const now=new Date().toISOString();
    for(let i=0;i<1001;i++){const id='seed'+String(i).padStart(4,'0');ins.run(id,'0'.repeat(64),'{}');sched.run(id,'CREATED',1,null,null,null,0,null,now);}
    db.exec('COMMIT');
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
  s=new WorkflowStore(f.options);
  s.create({id:'overflowok',root:f.root,goal:'Persist after legacy cap',acceptance:['created'],steps:[{id:'one',title:'Create'}]});
  const first=s.listPage({limit:100});
  assert.equal(first.workflows.length,100);assert.equal(first.hasMore,true);assert.ok(first.nextAfter);
  const second=s.listPage({after:first.nextAfter,limit:100});
  assert.equal(second.workflows.length,100);assert.notEqual(second.workflows[0].id,first.workflows[0].id);
  const batch=s.schedulerBatch({limit:25});
  assert.equal(batch.workflows.length,25);assert.ok(batch.nextAfter);
  assert.equal(s.get('overflowok').state.id,'overflowok');
}finally{try{s?.close();}catch{}f.dispose();}});
test('startup recovery scans beyond the legacy first 25 stale workflow candidates',()=>{const f=fixture({schedulerPolicy:{enabled:false}});let s=null;try{
  for(let i=0;i<60;i++)f.create('stale'+String(i).padStart(3,'0'));
  f.s.close();
  const db=new DatabaseSync(path.join(f.options.directory,'workflows.sqlite'));
  try{db.exec("UPDATE scheduler_jobs SET lifecycle='RUNNING',enabled=0");}finally{db.close();}
  s=new WorkflowStore(f.options);
  const recovery=s.schedulerStatus().startupRecovery;
  assert.equal(recovery.scanned,60);
  assert.equal(recovery.truncated,false);
  assert.equal(recovery.remaining,0);
  assert.equal(recovery.limit,2000);
}finally{try{s?.close();}catch{}f.dispose();}});

test('scheduler store installs indexes for bounded large-history recovery',()=>{const f=fixture({schedulerPolicy:{enabled:true}});try{
  const db=new DatabaseSync(path.join(f.options.directory,'workflows.sqlite'),{readOnly:true});
  try{
    const names=db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'scheduler_jobs_%' ORDER BY name").all().map(x=>x.name);
    assert.ok(names.includes('scheduler_jobs_enabled_workflow'));
    assert.ok(names.includes('scheduler_jobs_lifecycle_updated_workflow'));
  }finally{db.close();}
}finally{f.dispose();}});

test('stale revision cannot overwrite new memory',()=>{const f=fixture();try{f.create();f.s.note({id:'sample',expectedRevision:1,kind:'decision',text:'A'});assert.throws(()=>f.s.note({id:'sample',expectedRevision:1,kind:'decision',text:'B'}),/REVISION_CONFLICT/);}finally{f.dispose();}});
test('workflow call binds canonical root lease and step identity to Host dispatch and durable receipts',async()=>{
 const f=fixture();try{
  f.create();let dispatched=null;
  const result=await f.s.call({
    id:'sample',stepId:'first',expectedRevision:1,tool:'read_text',arguments:{path:'x'}
  },host(async(_tool,_args,_state,scope)=>{
    dispatched=scope;
    assert.ok(Object.isFrozen(scope));
    return {ok:true};
  }));
  const scope=result.receipt.workflowScope;
  assert.ok(scope);
  assert.deepEqual(Object.keys(scope).sort(),[
    'fencingToken','leaseId','operationId','revision','rootFingerprint','stepId','workflowId'
  ]);
  assert.deepEqual(dispatched,scope);
  assert.deepEqual(result.operation.workflowScope,scope);
  const step=f.s.get('sample').state.steps[0];
  assert.deepEqual(step.workflowScope,scope);
  assert.equal(step.leaseRevision,1);
  assert.equal(step.leaseId,scope.leaseId);
  assert.equal(step.rootFingerprint,scope.rootFingerprint);
  assert.equal(scope.workflowId,'sample');
  assert.equal(scope.stepId,'first');
  assert.equal(scope.operationId,result.operation.operationId);
  assert.equal(scope.revision,1);
  assert.equal(scope.fencingToken,result.operation.fencingToken);
  assert.equal(scope.rootFingerprint,hash(canonical({device:'fixture',root:f.root})));
  assert.match(scope.leaseId,/^[a-f0-9]{64}$/);
  assert.notEqual(scope.leaseId,scope.operationId);
 }finally{f.dispose();}
});
test('workflow calls omit lease-bound scope when one-writer-per-root is explicitly disabled',async()=>{
 const f=fixture({schedulerPolicy:{oneWriterPerRoot:false}});try{
  f.create();let dispatched='unset';
  const result=await f.s.call({
    id:'sample',stepId:'first',expectedRevision:1,tool:'read_text',arguments:{path:'x'}
  },host(async(_tool,_args,_state,scope)=>{dispatched=scope;return{ok:true};}));
  assert.equal(dispatched,null);
  assert.equal(Object.hasOwn(result.receipt,'workflowScope'),false);
  assert.equal(Object.hasOwn(result.operation,'workflowScope'),false);
  assert.equal(Object.hasOwn(f.s.get('sample').state.steps[0],'workflowScope'),false);
 }finally{f.dispose();}
});
test('exact duplicate returns receipt and never executes twice',async()=>{const f=fixture();try{
 f.create();let n=0;const h=host(async()=>{n++;return{ok:true};});const a={id:'sample',stepId:'first',expectedRevision:1,tool:'read_text',arguments:{path:'x'}};
 await f.s.call(a,h); const b=await f.s.call(a,h);assert.equal(b.cachedReceipt,true);assert.equal(n,1);assert.equal(f.s.get('sample').state.revision,3);
}finally{f.dispose();}});
test('changed inputs cannot reuse an already executed step',async()=>{const f=fixture();try{f.create();await call(f);await assert.rejects(call(f,{arguments:{path:'y'}}),/REQUIRES_RECONCILIATION/);}finally{f.dispose();}});
test('tool exception remains uncertain; no blind retry',async()=>{const f=fixture();try{
 f.create();let n=0;const a={id:'sample',stepId:'first',expectedRevision:1,tool:'write_text',arguments:{}};
 const h=host(async()=>{n++;throw new Error('sensitive failure detail');});const r=await f.s.call(a,h);
 assert.equal(r.outcome,'UNCERTAIN');assert.ok(f.s.resume('sample').blockers.includes('WORKFLOW_OUTCOME_UNCERTAIN'));
 await assert.rejects(f.s.call(a,h),/REQUIRES_RECONCILIATION/);assert.equal(n,1);assert.ok(!canonical(f.s.export('sample')).includes('sensitive failure detail'));
}finally{f.dispose();}});
for(const result of [{exitCode:7},{timedOut:true},{isError:true},{ok:false},{exitCode:null}]) test('non-success result is not validated '+JSON.stringify(result),async()=>{const f=fixture();try{f.create();const r=await f.s.call({id:'sample',stepId:'first',expectedRevision:1,tool:'run_project_command',arguments:{}},host(async()=>result));assert.equal(r.outcome,'UNCERTAIN');}finally{f.dispose();}});
test('raw arguments and output never reach exported memory',async()=>{const f=fixture();try{f.create();const marker='private_'+Date.now();await f.s.call({id:'sample',stepId:'first',expectedRevision:1,tool:'read_text',arguments:{secret:marker}},host(async()=>({text:marker})));assert.ok(!canonical(f.s.export('sample')).includes(marker));}finally{f.dispose();}});
test('dependency gate rejects out-of-order action without invoking host',async()=>{const f=fixture();try{f.create();let n=0;await assert.rejects(f.s.call({id:'sample',stepId:'second',expectedRevision:1,tool:'read_text',arguments:{}},host(async()=>{n++;})),/DEPENDENCY/);assert.equal(n,0);}finally{f.dispose();}});
test('host policy failure occurs before durable intent',async()=>{const f=fixture();try{f.create();await assert.rejects(f.s.call({id:'sample',stepId:'first',expectedRevision:1,tool:'x',arguments:{}},{validate:async()=>{throw Error('DENY');},dispatch:async()=>{throw Error('unexpected');}}),/DENY/);assert.equal(f.s.get('sample').state.revision,1);}finally{f.dispose();}});
test('checkpoint detects changed and missing evidence, stops next action',()=>{const f=fixture();try{
 f.create();fs.writeFileSync(path.join(f.root,'proof.txt'),'before');f.s.checkpoint({id:'sample',expectedRevision:1,files:['proof.txt'],nextAction:'Inspect',summary:'Recorded evidence'});
 const listed=f.s.list().find(x=>x.id==='sample'),snapshot=f.s.get('sample').state;assert.equal(listed.lifecycle,'WAITING');assert.equal(listed.schedulerEnabled,snapshot.scheduler.enabled);
 assert.equal(f.s.resume('sample').readyForNextStep,true);fs.writeFileSync(path.join(f.root,'proof.txt'),'after');assert.ok(f.s.resume('sample').blockers.includes('WORKFLOW_EVIDENCE_STALE'));
 fs.unlinkSync(path.join(f.root,'proof.txt'));assert.ok(f.s.resume('sample').blockers.includes('WORKFLOW_EVIDENCE_UNAVAILABLE'));
}finally{f.dispose();}});
test('device drift blocks but config hash drift with preserved authority is update-safe',()=>{const f=fixture();try{f.create();const s=new WorkflowStore({...f.options,device:'other'});try{assert.ok(s.resume('sample').blockers.includes('WORKFLOW_IDENTITY_CHANGED'));}finally{s.close();}const c=new WorkflowStore({...f.options,configSha256:'2'.repeat(64)});try{const r=c.resume('sample');assert.deepEqual(r.blockers,[]);assert.equal(r.configDrift,true);assert.equal(r.currentConfigSha256,'2'.repeat(64));}finally{c.close();}}finally{f.dispose();}});
test('project evidence stays scoped while private local memory may live outside project roots',()=>{const f=fixture();const privateDir=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-private-memory-')));try{f.create();assert.throws(()=>f.s.evidence(f.root,['../outside']),/OUT_OF_SCOPE/);const s=new WorkflowStore({...f.options,directory:privateDir});try{assert.equal(s.capabilities().privateLocalStorage,true);assert.throws(()=>s.create({id:'outside',root:path.dirname(f.root),goal:'x',acceptance:['x'],steps:[{id:'one',title:'x'}]}),/ROOT_OUT_OF_SCOPE/);}finally{s.close();}}finally{f.dispose();fs.rmSync(privateDir,{recursive:true,force:true});}});
test('symlink and hardlink evidence rejected',t=>{const f=fixture();try{
 const target=path.join(f.root,'proof.txt');fs.writeFileSync(target,'x');
 fs.linkSync(target,path.join(f.root,'hard.txt'));assert.throws(()=>f.s.evidence(f.root,['hard.txt']),/INVALID_FILE/);fs.unlinkSync(path.join(f.root,'hard.txt'));
 try{fs.symlinkSync(target,path.join(f.root,'soft.txt'));}catch(e){if(e.code==='EPERM'){t.diagnostic('OS symlink privilege unavailable; hardlink guard tested');return;}throw e;}
 assert.throws(()=>f.s.evidence(f.root,['soft.txt']),/LINK/);
}finally{f.dispose();}});
test('credential-shaped strings and malformed IDs rejected without persisting',()=>{const f=fixture();try{f.create();assert.throws(()=>f.s.note({id:'sample',expectedRevision:1,kind:'fact',text:['sk','x'.repeat(40)].join('-')}),/SECRET/);assert.throws(()=>f.s.get('../x'),/INVALID_ID/);assert.equal(f.s.get('sample').state.revision,1);}finally{f.dispose();}});
test('invalid DAG and duplicate IDs fail at create',()=>{const f=fixture();try{assert.throws(()=>f.s.create({id:'bad',root:f.root,goal:'Test',acceptance:['x'],steps:[{id:'a',title:'x',dependsOn:['b']}]}),/DEPENDENCY/);assert.throws(()=>f.s.create({id:'bad',root:f.root,goal:'Test',acceptance:['x'],steps:[{id:'a',title:'x'},{id:'a',title:'y'}]}),/DUPLICATE/);}finally{f.dispose();}});
test('history triggers enforce append-only and projection tampering fails closed',()=>{const f=fixture();try{
 f.create();const db=new DatabaseSync(f.s.location);try{assert.throws(()=>db.exec("DELETE FROM events"),/APPEND_ONLY/);db.exec("UPDATE workflows SET snapshot='{}' WHERE id='sample'");}finally{db.close();}
 assert.throws(()=>f.s.get('sample'),/CORRUPT/);
}finally{f.dispose();}});
test('export has verifiable canonical digest and excludes foreign project',()=>{const f=fixture();try{f.create();f.create('other');const b=f.s.export('sample');assert.equal(b.sha256,hash(canonical(b.bundle)));assert.equal(b.bundle.state.id,'sample');assert.equal(b.bundle.events.length,1);assert.equal(f.s.list().length,2);}finally{f.dispose();}});
test('WorkflowStore accepts only the contained runner proof bound to its acquired root lease',async t=>{
  if(!(await processContainmentAvailable())) return t.skip('host-local process containment provider unavailable');
  const f=fixture();
  try{
    f.create();
    const result=await f.s.call({
      id:'sample',stepId:'first',expectedRevision:1,tool:'run_project_command',
      arguments:{program:process.execPath,args:['-e',"process.stdout.write('workflow-bound')"]}
    },{
      validate:async()=>{},
      dispatch:async(_name,_args,_state,binding)=>runContainedProjectCommand({
        program:process.execPath,args:['-e',"process.stdout.write('workflow-bound')"],cwd:f.root,
        timeoutMs:10000,outputLimit:4096,env:process.env,binding
      })
    });
    assert.equal(result.outcome,'RECORDED_NOT_VALIDATED');
    assert.equal(result.receipt.processCessationProof.workflowId,'sample');
    assert.equal(result.receipt.processCessationProof.stepId,'first');
    assert.equal(result.receipt.processCessationProof.operationId,result.operation.operationId);
    assert.equal(result.receipt.processCessationProof.fencingToken,result.operation.fencingToken);
    assert.equal(result.receipt.processCessationProof.leaseId.length,64);
    assert.equal(f.s.get('sample').state.steps[0].status,'recorded');
    assert.equal(f.s.schedulerStatus().currentLeases,0);
  }finally{f.dispose();}
});

test('process-capable operation without a native cessation proof remains uncertain and cannot release its root lease',async()=>{
  const f=fixture();
  try{
    f.create();
    const result=await f.s.call({
      id:'sample',stepId:'first',expectedRevision:1,tool:'run_project_command',
      arguments:{program:process.execPath,args:['-e','process.exit(0)']}
    },host(async()=>({exitCode:0,stdout:'not-contained',stderr:''})));
    assert.equal(result.outcome,'UNCERTAIN');
    assert.equal(result.receipt.nativeCessationProofRequired,true);
    assert.equal(result.receipt.errorCode,'WORKFLOW_NATIVE_CESSATION_PROOF_MISSING_OR_UNTRUSTED');
    assert.equal(Object.hasOwn(result.receipt,'processCessationProof'),false);
    const db=new DatabaseSync(path.join(f.options.directory,'root-leases.sqlite'));
    try{assert.equal(db.prepare('SELECT count(*) AS n FROM root_leases').get().n,1);}finally{db.close();}
    expireRootLease(f);
    assert.throws(()=>f.s.reconcile({
      id:'sample',stepId:'first',expectedRevision:f.s.get('sample').state.revision,
      outcome:'not_applied',files:[],explanation:'No host-verified cessation proof exists.'
    }),/WORKFLOW_CESSATION_PROOF_REQUIRED_OR_INVALID/);
    const verify=new DatabaseSync(path.join(f.options.directory,'root-leases.sqlite'));
    try{assert.equal(verify.prepare('SELECT count(*) AS n FROM root_leases').get().n,1);}finally{verify.close();}
  }finally{f.dispose();}
});

test('trusted process-cessation receipt reconciles and releases only the expired matching root lease',async t=>{
  if(!(await processContainmentAvailable())) return t.skip('host-local process containment provider unavailable');
  const f=fixture();
  try{
    f.create();
    fs.writeFileSync(path.join(f.root,'observed.txt'),'no side effect');
    const args=['-e','process.exit(17)'];
    const result=await f.s.call({
      id:'sample',stepId:'first',expectedRevision:1,tool:'run_project_command',
      arguments:{program:process.execPath,args}
    },host(async(_name,_args,_state,binding)=>runContainedProjectCommand({
      program:process.execPath,args,cwd:f.root,timeoutMs:10000,
      outputLimit:4096,env:process.env,binding
    })));
    assert.equal(result.outcome,'UNCERTAIN');
    assert.equal(result.receipt.processCessationProof.operationId,result.operation.operationId);
    assert.equal(result.receipt.processCessationProof.leaseId.length,64);
    assert.equal(result.receipt.processCessationProof.fencingToken,result.operation.fencingToken);
    expireRootLease(f);
    const reconciled=f.s.reconcile({
      id:'sample',stepId:'first',expectedRevision:f.s.get('sample').state.revision,outcome:'not_applied',
      files:['observed.txt'],explanation:'Contained process tree ceased; independent inspection found no effect.'
    });
    assert.equal(reconciled.state.steps[0].status,'reconciled_not_applied');
    assert.equal(reconciled.state.steps[0].reconciliation.leaseReleaseStatus,'RELEASED');
    const db=new DatabaseSync(path.join(f.options.directory,'root-leases.sqlite'));
    try{assert.equal(db.prepare('SELECT count(*) AS n FROM root_leases').get().n,0);}finally{db.close();}
    const replay=f.s.reconcile({
      id:'sample',stepId:'first',expectedRevision:reconciled.revision,outcome:'not_applied',
      files:['observed.txt'],explanation:'Contained process tree ceased; independent inspection found no effect.'
    });
    assert.equal(replay.replayed,true);
    assert.equal(replay.leaseRelease.status,'ALREADY_RELEASED');
  }finally{f.dispose();}
});
test('second live process cannot reconcile another process in-flight',async()=>{const f=fixture();try{
 f.create();fs.writeFileSync(path.join(f.root,'proof.txt'),'inspect');let release;const wait=new Promise(r=>release=r);
 const action=f.s.call({id:'sample',stepId:'first',expectedRevision:1,tool:'read_text',arguments:{}},host(async()=>{await wait;return{ok:true};}));
 await new Promise(r=>setTimeout(r,30));const s=new WorkflowStore(f.options);
 try{assert.throws(()=>s.reconcile({id:'sample',stepId:'first',expectedRevision:2,outcome:'applied',files:['proof.txt'],explanation:'Reviewed'}),/STILL_RUNNING/);}finally{s.close();release();await action;}
}finally{f.dispose();}});
test('process crash after external effect preserves uncertain intent and never repeats it',async()=>{const f=fixture();try{
 f.create();const r=await runWorker(['crash',f.root]);assert.equal(r.code,73,r.err);assert.equal(fs.readFileSync(path.join(f.root,'effect.txt'),'utf8'),'once');
 assert.ok(f.s.resume('sample').blockers.includes('WORKFLOW_OUTCOME_UNCERTAIN'));
 await assert.rejects(call(f),/REQUIRES_RECONCILIATION/);
 const proof=f.s.reconcile({id:'sample',stepId:'first',expectedRevision:2,outcome:'applied',files:['effect.txt'],explanation:'One marker was independently observed after child exit'});
 assert.equal(proof.state.steps[0].status,'reconciled_applied');assert.equal(f.s.resume('sample').nextStep,'second');
}finally{f.dispose();}});
test('two processes contend for same revision: exactly one records intent/action',async()=>{const f=fixture();try{
 f.create();const r=await Promise.all([runWorker(['race',f.root]),runWorker(['race',f.root])]);
 assert.ok(r.some(x=>x.code===0),JSON.stringify(r));assert.equal(fs.readFileSync(path.join(f.root,'effects.txt'),'utf8').split('\n').filter(Boolean).length,1);
 assert.equal(f.s.get('sample').state.steps[0].status,'verified');
}finally{f.dispose();}});
test('crash inside an uncommitted transaction is rolled back on reopen',async()=>{const f=fixture();try{
 f.create();const r=await runWorker(['transaction-crash',f.root]);assert.equal(r.code,74,r.err);assert.equal(f.s.get('sample').state.revision,1);
}finally{f.dispose();}});
test('large and deeply nested inputs are bounded',()=>{const f=fixture();try{f.create();assert.throws(()=>f.s.note({id:'sample',expectedRevision:1,kind:'fact',text:'x'.repeat(9000)}),/INVALID_TEXT/);let v={};for(let i=0;i<30;i++)v={nested:v};assert.throws(()=>canonical(v),/DEPTH/);}finally{f.dispose();}});
test('not-applied attestation does not create an automatic retry',async()=>{const f=fixture();try{
 f.create();fs.writeFileSync(path.join(f.root,'proof.txt'),'not applied');await f.s.call({id:'sample',stepId:'first',expectedRevision:1,tool:'write_text',arguments:{path:'proof.txt',content:'unused'}},host(async()=>{throw Error('failed');}));
 f.s.reconcile({id:'sample',stepId:'first',expectedRevision:3,outcome:'not_applied',files:['proof.txt'],explanation:'Independent target inspection'});
 assert.ok(f.s.resume('sample').blockers.includes('WORKFLOW_REPLAN_REQUIRED'));await assert.rejects(call(f),/REQUIRES_RECONCILIATION/);
}finally{f.dispose();}});
