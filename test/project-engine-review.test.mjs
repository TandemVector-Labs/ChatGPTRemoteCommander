import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createWorkflowTools } from '../src/workflow-tools.mjs';
import { validateJsonSchema } from '../src/schema-validator.mjs';
import { listDirectory, readText, writeText } from '../src/tools-v0.3.mjs';

const proposal=(tool,args)=>({action:'call',tool,argumentsJson:JSON.stringify(args),summary:'Perform the scoped operation'});
const definitions={
  write_text:{name:'write_text',inputSchema:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content'],additionalProperties:false}},
  read_text:{name:'read_text',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}},
  list_directory:{name:'list_directory',inputSchema:{type:'object',properties:{path:{type:'string'}},additionalProperties:false}}
};
function fixture(t,plan,extra={}) {
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-engine-review-')));
  let api,plans=0;const dispatches=[];
  t.after(async()=>{await api?.close();fs.rmSync(root,{recursive:true,force:true});});
  const config={allowedRoots:[root],maxWriteBytes:524288,maxReadBytes:524288,auditLog:path.join(root,'audit.jsonl'),durableWorkflows:{
    enabled:true,directory:path.join(root,'state'),executionTools:['write_text','read_text','list_directory'],
    scheduler:{enabled:false,...extra.scheduler},runner:{enabled:true,allowedTools:['write_text','read_text','list_directory'],maxActions:10,maxDurationMs:30000,...extra.runner}}};
  const ctx={config,roots:[root],auditLog:config.auditLog};
  const options={config,roots:[root],device:'fixture',configSha256:'1'.repeat(64),lookup:n=>definitions[n],validateSchema:validateJsonSchema,
    planner:{describe:()=>({kind:'fixture',available:true,model:'model-a',reasoningEffort:'high',...extra.provider}),plan:async(...args)=>{plans++;return plan(...args);}},
    dispatch:async(tool,args)=>{
      dispatches.push({tool,args});
      if(tool==='read_text')return readText(ctx,args);
      if(tool==='write_text')return writeText(ctx,args);
      if(tool==='list_directory')return listDirectory(ctx,args);
      throw new Error('Unexpected tool');
    }};
  api=createWorkflowTools(options);
  const state=async(id='project')=>(await api.execute('workflow_get',{id})).state;
  return {root,options,dispatches,get api(){return api;},get plans(){return plans;},state,
    create:async(id='project',extra={})=>api.execute('workflow_create',{id,root,goal:'Derive a verified artifact from observed input',
      acceptance:['The artifact meets the configured check'],steps:[{id:'write',title:'Write an artifact'}],...extra}),
    start:async(id='project',extra={})=>api.execute('workflow_run_start',{id,runId:'run-'+id,expectedRevision:(await state(id)).revision,
      checks:[{criterion:0,type:'text_includes',path:id+'.txt',text:'verified output'}],...extra}),
    tick:async(id='project')=>api.execute('workflow_run_tick',id===null?{}:{runId:'run-'+id}),
    control:async(id,action)=>api.execute('workflow_control',{id,expectedRevision:(await state(id)).revision,action,reason:'Explicit review control'}),
    reopen:async()=>{await api.close();api=createWorkflowTools(options);}
  };
}

test('read observations survive restart by rereading current scoped bytes without persisting raw content',async t=>{
  const first='observation_'+randomUUID(),latest='observation_'+randomUUID();let observed;
  const f=fixture(t,async context=>{
    if(context.currentStep.id==='read')return proposal('read_text',{path:'source.txt'});
    const result=context.observations.find(x=>x.tool==='read_text')?.result;
    observed=result?.preview;
    assert.equal(observed,latest);
    assert.equal(result.bytes,Buffer.byteLength(latest,'utf8'));
    assert.equal(result.previewTruncated,false);
    assert.equal(Object.hasOwn(result,'text'),false);
    return proposal('write_text',{path:'project.txt',content:'verified output: '+observed});
  });
  fs.writeFileSync(path.join(f.root,'source.txt'),first);
  await f.create('project',{steps:[{id:'read',title:'Observe the input'},{id:'write',title:'Use the observed input'}]});
  await f.start();assert.equal((await f.tick()).status,'QUEUED');
  await f.reopen();fs.writeFileSync(path.join(f.root,'source.txt'),latest);
  assert.equal((await f.tick()).status,'QUEUED');
  assert.equal((await f.tick()).status,'COMPLETED');
  assert.equal(observed,latest);
  for(const file of [path.join(f.root,'state','workflows.sqlite'),path.join(f.root,'state','project-engine','project-runs.sqlite')]) {
    const bytes=fs.readFileSync(file);
    assert.equal(bytes.includes(Buffer.from(first)),false);
    assert.equal(bytes.includes(Buffer.from(latest)),false);
  }
});

test('directory observations supply filenames to the next proposal',async t=>{
  const filename='unknown-'+randomUUID()+'.txt';let seen=false;
  const f=fixture(t,async context=>{
    if(context.currentStep.id==='list')return proposal('list_directory',{path:'input'});
    seen=context.observations.some(o=>o.tool==='list_directory'&&o.result.entries.some(e=>e.path===filename));
    assert.equal(seen,true);return proposal('write_text',{path:'project.txt',content:'verified output'});
  });
  fs.mkdirSync(path.join(f.root,'input'));fs.writeFileSync(path.join(f.root,'input',filename),'input');
  await f.create('project',{steps:[{id:'list',title:'Find the input filename'},{id:'write',title:'Use the listing'}]});await f.start();
  await f.tick();assert.equal((await f.tick()).status,'QUEUED');assert.equal(seen,true);
});

test('large read observations expose a bounded preview and full-file digest metadata',async t=>{
  const content='x'.repeat(20000);let observed;
  const f=fixture(t,async context=>{
    if(context.currentStep.id==='read')return proposal('read_text',{path:'large.txt'});
    observed=context.observations.find(o=>o.tool==='read_text')?.result;
    assert.equal(observed.bytes,Buffer.byteLength(content,'utf8'));
    assert.equal(observed.preview,content.slice(0,1024));
    assert.equal(observed.previewTruncated,true);
    assert.equal(Object.hasOwn(observed,'text'),false);
    assert.ok(Buffer.byteLength(JSON.stringify(context.observations),'utf8')<=4096);
    assert.equal(context.observationsOmitted,0);
    const completed=context.steps.find(s=>s.id==='read');
    assert.equal(completed?.status,'verified');
    assert.deepEqual(Object.keys(completed).sort(),['dependsOn','id','status','title']);
    assert.equal('receipt' in completed,false);
    assert.equal('idempotencyKey' in completed,false);
    return {action:'block',tool:'',argumentsJson:'{}',summary:'Bounded observation assertions passed'};
  });
  fs.writeFileSync(path.join(f.root,'large.txt'),content);
  await f.create('project',{steps:[{id:'read',title:'Read large source'},{id:'inspect',title:'Inspect bounded observation'}]});
  await f.start();
  assert.equal((await f.tick()).status,'QUEUED');
  const result=await f.tick();
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.lastCode,'PROJECT_PLANNER_BLOCKED');
});

test('large directory observations retain a bounded filename sample',async t=>{
  let observed;
  const f=fixture(t,async context=>{
    if(context.currentStep.id==='list')return proposal('list_directory',{path:'input'});
    observed=context.observations.find(o=>o.tool==='list_directory')?.result;
    assert.equal(observed.entries.length,24);
    assert.equal(observed.returnedEntries,24);
    assert.equal(observed.truncated,true);
    assert.equal(observed.entries.every(e=>Object.keys(e).sort().join(',')==='path,type'),true);
    assert.ok(Buffer.byteLength(JSON.stringify(context.observations),'utf8')<=4096);
    return {action:'block',tool:'',argumentsJson:'{}',summary:'Bounded directory assertions passed'};
  });
  fs.mkdirSync(path.join(f.root,'input'));
  for(let i=0;i<40;i++)fs.writeFileSync(path.join(f.root,'input',`entry-${String(i).padStart(2,'0')}.txt`),'x');
  await f.create('project',{steps:[{id:'list',title:'List source directory'},{id:'inspect',title:'Inspect bounded listing'}]});
  await f.start();
  assert.equal((await f.tick()).status,'QUEUED');
  const result=await f.tick();
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.lastCode,'PROJECT_PLANNER_BLOCKED');
});

test('crash after a durable read receipt retains the reference needed by the next planner',async t=>{
  const marker='crash_observation_'+randomUUID();let observed;
  const f=fixture(t,async context=>{
    observed=context.observations.find(o=>o.tool==='read_text')?.result.preview;
    assert.equal(observed,marker);
    return proposal('write_text',{path:'project.txt',content:'verified output'});
  });
  fs.writeFileSync(path.join(f.root,'source.txt'),marker);
  await f.create('project',{steps:[{id:'read',title:'Read source'},{id:'write',title:'Use source'}]});await f.start();
  await f.api.close();
  const urls=Object.fromEntries(['workflow-tools','project-engine','schema-validator','tools-v0.3'].map(name=>[name,new URL('../src/'+name+'.mjs',import.meta.url).href]));
  const script=`import {createWorkflowTools} from ${JSON.stringify(urls['workflow-tools'])};
    import {createProjectEngine} from ${JSON.stringify(urls['project-engine'])};
    import {validateJsonSchema} from ${JSON.stringify(urls['schema-validator'])};
    import {readText} from ${JSON.stringify(urls['tools-v0.3'])};
    import path from 'node:path';
    const config=JSON.parse(process.argv[1]);const defs=JSON.parse(process.argv[2]);const root=config.allowedRoots[0];
    const policy=config.durableWorkflows.runner;config.durableWorkflows.runner={enabled:false};
    const core=createWorkflowTools({config,roots:[root],device:'fixture',configSha256:'1'.repeat(64),
      lookup:n=>defs[n],validateSchema:validateJsonSchema,dispatch:async(n,a)=>readText({config,roots:[root],auditLog:config.auditLog},a)});
    const engine=createProjectEngine({directory:path.join(config.durableWorkflows.directory,'project-engine'),policy,lookup:n=>defs[n],
      planner:{describe:()=>({kind:'fixture',available:true,model:'model-a',reasoningEffort:'high'}),
        plan:async()=>({action:'call',tool:'read_text',argumentsJson:JSON.stringify({path:'source.txt'}),summary:'Read source'})},
      execute:async(n,a)=>{const result=await core.execute(n,a);if(n==='workflow_call')process.exit(73);return result;}});
    await engine.tick('run-project');`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script,JSON.stringify(f.options.config),JSON.stringify(definitions)],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,73,result.stderr);
  await f.reopen();assert.equal((await f.state()).steps[0].status,'verified');
  const continued=await f.tick();assert.equal(continued.status,'QUEUED',continued.lastCode);assert.equal(observed,marker);
});

async function manualCompletion(f,content) {
  await f.api.execute('workflow_call',{id:'project',stepId:'write',expectedRevision:(await f.state()).revision,
    tool:'write_text',arguments:{path:'project.txt',content}});
  return f.api.execute('workflow_finalize',{id:'project',expectedRevision:(await f.state()).revision,
    acceptanceResults:[true],files:['project.txt'],summary:'Caller-attested completion'});
}
test('caller-attested workflow completion cannot bypass enrolled deterministic checks',async t=>{
  const f=fixture(t,async()=>{throw Error('Planning not expected');});await f.create();await f.start();
  await manualCompletion(f,'incorrect result');const result=await f.tick();
  assert.equal(result.status,'BLOCKED');assert.equal(result.lastCode,'PROJECT_ACCEPTANCE_FAILED');assert.equal(f.plans,0);
});
test('reverified completion requires a match with recorded final evidence',async t=>{
  const f=fixture(t,async()=>{throw Error('Planning not expected');});await f.create();await f.start();
  await manualCompletion(f,'verified output original');
  fs.writeFileSync(path.join(f.root,'project.txt'),'verified output changed');
  const result=await f.tick();assert.equal(result.status,'BLOCKED');assert.equal(result.lastCode,'PROJECT_COMPLETION_EVIDENCE_CHANGED');
});
test('unchanged independently reverified manual completion is recognized',async t=>{
  const f=fixture(t,async()=>{throw Error('Planning not expected');});await f.create();await f.start();
  await manualCompletion(f,'verified output');const result=await f.tick();
  assert.equal(result.status,'COMPLETED');assert.equal(result.lastCode,'PROJECT_ACCEPTANCE_REVERIFIED');assert.equal(f.plans,0);
});

test('global selection skips a paused first run and honors its later resume',async t=>{
  const selected=[];const f=fixture(t,async context=>{selected.push(context.workflowId);return proposal('write_text',{path:context.workflowId+'.txt',content:'verified output'});});
  await f.create('a');await f.start('a');await f.create('b');await f.start('b');await f.control('a','pause');
  const active=await f.tick(null);assert.equal(active.runId,'run-b');assert.equal(active.status,'QUEUED');assert.deepEqual(selected,['b']);
  await f.control('a','resume');const resumed=await f.tick(null);
  assert.equal(resumed.runId,'run-a');assert.equal(resumed.status,'QUEUED');assert.deepEqual(selected,['b','a']);
});

for(const autoTick of [false,true]) test(`scheduler metadata describes its actual effects when autoTick=${autoTick}`,async t=>{
  const f=fixture(t,async()=>{throw Error('No enrolled project');},{runner:{autoTick}});
  const definition=f.api.definitions.find(d=>d.name==='workflow_scheduler_tick');
  assert.equal(definition.annotations.readOnlyHint,false);
  assert.equal(definition.annotations.destructiveHint,autoTick);
  assert.equal(definition.annotations.openWorldHint,autoTick);
  if(autoTick)assert.match(definition.description,/execute|mutate|provider/i);
});

for(const enabled of [false,true]) for(const autoTick of [false,true]) {
  test(`status, health and scheduler agree for enabled=${enabled}, autoTick=${autoTick}`,async t=>{
    const f=fixture(t,async()=>{throw Error('No enrolled project');},{scheduler:{enabled,intervalMs:60000},runner:{autoTick}});
    const status=await f.api.execute('workflow_status',{});
    const health=await f.api.execute('workflow_health',{});
    const tick=await f.api.execute('workflow_scheduler_tick',{});
    assert.equal(status.automaticExecution,enabled&&autoTick);
    for(const flags of [status.schedulerState,health.scheduler,tick,tick.status]) {
      assert.equal(flags.runnerConfigured,status.runnerConfigured);
      assert.equal(flags.automaticExecution,status.automaticExecution);
      assert.equal(flags.automaticContinuationScope,status.automaticContinuationScope);
    }
  });
}

test('known unavailable provider fails before registering an executor',t=>{
  assert.throws(()=>fixture(t,async()=>{throw Error('Unavailable provider');},{provider:{available:false}}),/PROJECT_PROVIDER_UNAVAILABLE/);
});
test('exact model mismatch fails enrollment without reserving a run or invoking the provider',async t=>{
  const f=fixture(t,async()=>{throw Error('Wrong model');});
  await f.create('project',{executionProfile:{modelVariant:'model-b',fallbackPolicy:'exact-only'}});
  await assert.rejects(f.start(),/PROJECT_MODEL_PROFILE_UNAVAILABLE/);
  assert.equal((await f.api.execute('workflow_run_status',{})).runs.length,0);assert.equal(f.plans,0);
});
test('model-family mismatch fails even when the model variant string matches',async t=>{
  const f=fixture(t,async()=>{throw Error('Wrong model family');});
  await f.create('project',{executionProfile:{modelFamily:'gemma4',modelVariant:'model-a'}});
  await assert.rejects(f.start(),/PROJECT_MODEL_PROFILE_UNAVAILABLE/);
  assert.equal(f.plans,0);
});
test('execution mode and profile version are enforced against the provider descriptor',async t=>{
  const f=fixture(t,async()=>{throw Error('Wrong execution profile');});
  await f.create('project',{executionProfile:{modelVariant:'model-a',executionMode:'remote-agent',profileVersion:'2'}});
  await assert.rejects(f.start(),/PROJECT_MODEL_PROFILE_UNAVAILABLE/);
  assert.equal(f.plans,0);
});
test('equivalent-or-better fails closed without a qualified provider equivalence',async t=>{
  const f=fixture(t,async()=>{throw Error('Unqualified fallback');});
  await f.create('project',{executionProfile:{modelVariant:'model-b',fallbackPolicy:'equivalent-or-better'}});
  await assert.rejects(f.start(),/PROJECT_MODEL_PROFILE_UNAVAILABLE/);
  assert.equal(f.plans,0);
});
test('exact matching full model profile and explicitly permissive fallback are usable',async t=>{
  const f=fixture(t,async context=>proposal('write_text',{path:context.workflowId+'.txt',content:'verified output'}),{provider:{modelFamily:'fixture'}});
  await f.create('a',{executionProfile:{modelFamily:'fixture',modelVariant:'model-a',reasoningEffort:'high',
    executionMode:'project-agent',profileVersion:'1',fallbackPolicy:'exact-only'}});await f.start('a');
  assert.equal((await f.tick('a')).status,'QUEUED');
  await f.create('b',{executionProfile:{modelVariant:'different-model',fallbackPolicy:'allow-any'}});await f.start('b');
  assert.equal((await f.tick('b')).status,'QUEUED');
});


test('provider model-family drift after enrollment blocks before the next planner call or effect',async t=>{
  const provider={modelFamily:'fixture'};
  const f=fixture(t,async context=>context.currentStep.id==='read'
    ?proposal('read_text',{path:'source.txt'})
    :proposal('write_text',{path:'project.txt',content:'verified output'}),{provider});
  fs.writeFileSync(path.join(f.root,'source.txt'),'approved source');
  await f.create('project',{
    executionProfile:{modelFamily:'fixture',modelVariant:'model-a',fallbackPolicy:'exact-only'},
    steps:[{id:'read',title:'Read the approved source'},{id:'write',title:'Write the verified artifact',dependsOn:['read']}]
  });
  await f.start();
  assert.equal((await f.tick()).status,'QUEUED');
  assert.equal(f.plans,1);
  provider.modelFamily='unqualified-family';
  const blocked=await f.tick();
  assert.equal(blocked.status,'BLOCKED');
  assert.equal(blocked.lastCode,'PROJECT_MODEL_PROFILE_UNAVAILABLE');
  assert.equal(f.plans,1,'the drifted provider must not be called');
  assert.deepEqual(f.dispatches.map(x=>x.tool),['read_text']);
  assert.equal(fs.existsSync(path.join(f.root,'project.txt')),false);
});
