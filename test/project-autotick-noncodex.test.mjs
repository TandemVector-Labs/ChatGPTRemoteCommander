import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createWorkflowTools} from '../src/workflow-tools.mjs';
import {applyProjectRunnerConfig} from '../src/project-runner-config.mjs';

const sha=raw=>createHash('sha256').update(raw).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const NEWLINE='\n';

function fixture(t,{stepId='inspect',stepTitle='Read exact owner-approved scratch receipt',maxActions=1,maxPlannerCalls=2}={}){
 const parent=fs.realpathSync.native(os.tmpdir());
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(parent,'rc-safe-autotick-')));
 const project=path.join(root,'project');
 fs.mkdirSync(project);
 const file=path.join(project,'proof.txt');
 const bytes=Buffer.from('VERIFIED_OWNER_APPROVED_READONLY_PROOF'+NEWLINE);
 fs.writeFileSync(file,bytes,{flag:'wx'});
 const initialMtime=fs.statSync(file,{bigint:true}).mtimeNs;
 const plannerPath=path.join(root,'trusted-plan.cjs');
 const code=[
  '"use strict";',
  'let text="";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data",b=>{text+=b;if(text.length>524288)process.exit(3)});',
  'process.stdin.on("end",()=>{',
  'const fallback={action:"block",tool:"",argumentsJson:JSON.stringify({request:{question:"Owner approval required for unknown project step"}}),summary:"Waiting for owner scope"};',
  'let proposal=fallback;',
  'try{const c=JSON.parse(text);',
  'if(c.workflowId==="autopilot"&&c.currentStep?.id==="inspect"&&',
  'c.currentStep?.title==="Read exact owner-approved scratch receipt"&&',
  'Array.isArray(c.tools)&&c.tools.some(x=>x.name==="read_text"))',
  'proposal={action:"call",tool:"read_text",',
  'argumentsJson:JSON.stringify({path:process.argv[2]}),',
  'summary:"Read only the explicitly approved scratch receipt"};',
  '}catch{}',
  'process.stdout.write(JSON.stringify(proposal));',
  '});'
 ].join(NEWLINE);
 fs.writeFileSync(plannerPath,code,{flag:'wx'});
 const config={
  capabilityProfile:{id:'owner-safe-scratch',tier:'FULL_POWER',explicitlyAuthorized:true},
  powerMode:{enabled:true,fullFilesystem:false,allowShell:false,
             allowProcessControl:false,codexControl:{allowLaunch:false},
             guiControl:{enabled:false}},
  durableWorkflows:{
   enabled:true,directory:path.join(root,'sqlite'),executionTools:['read_text'],
   scheduler:{enabled:true,intervalMs:1100,leaseMs:20000,maxConcurrentProjects:1,oneWriterPerRoot:true},
   runner:{enabled:true,autoTick:true,
     provider:{kind:'command',executable:process.execPath,args:[plannerPath,file],
               timeoutMs:5000,maxOutputBytes:4096},
     allowedTools:['read_text'],maxActions,maxDurationMs:25000,maxPlannerCalls,
     adaptive:{enabled:false,maxExtensions:0},worker:{enabled:false},
     team:{workers:[{id:'reviewer',role:'Verify the single owner-approved scratch read only'}],maxParallel:1}}
  }
 };
 const admitted=applyProjectRunnerConfig(config,{platform:process.platform});
 assert.equal(admitted.status,'PRESERVED_EXPLICIT_NON_CODEX_PROVIDER');
 assert.equal(admitted.config.durableWorkflows.runner.autoTick,true);
 const dispatched=[];
 let api=null;
 const build=()=>createWorkflowTools({
  config:admitted.config,roots:[root],device:'owner-safe-runner-test',
  configSha256:'0'.repeat(64),
  lookup:name=>({name,description:'Read one approved test fixture',
                inputSchema:{type:'object'}}),
  validateSchema:()=>[],
  dispatch:async(name,args)=>{
   assert.equal(name,'read_text');
   assert.equal(args.path,file);
   assert.ok(path.resolve(args.path).startsWith(path.resolve(project)+path.sep));
   dispatched.push({name,sha256:sha(fs.readFileSync(file))});
   return {ok:true,sha256:sha(fs.readFileSync(file))};
  }
 });
 api=build();
 t.after(async()=>{
  if(api)await api.close();
  fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 });
 return {root,project,file,bytes,initialMtime,config:admitted.config,
  planSha:sha(Buffer.from(code)),dispatched,build,
  get api(){return api;},async restart(){await api.close();api=build();}
 };
}
async function awaitTerminal(api,runId,timeoutMs=17000){
 const until=Date.now()+timeoutMs;
 let last;
 while(Date.now()<until){
  last=await api.execute('workflow_run_status',{runId});
  if(['COMPLETED','BLOCKED','EXHAUSTED','WAITING_INPUT','FAILED','CANCELLED'].includes(last.status))
   return last;
  await delay(225);
 }
 throw Error('RUNNER_NO_TERMINAL_WITHIN_BUDGET:'+(last?.status??'UNKNOWN'));
}

test('native non-Codex command provider auto-ticks exactly one read-only step and preserves receipt after restart',
 {timeout:45000},async t=>{
 const f=fixture(t);
 const s=await f.api.execute('workflow_status');
 assert.equal(s.runnerConfigured,true);
 assert.equal(s.automaticExecution,true);
 assert.deepEqual(s.executionTools,['read_text']);
 assert.equal(s.schedulerState.automaticContinuationScope,'ENROLLED_PROJECT_EXECUTION');
 const created=await f.api.execute('workflow_create',{
  id:'autopilot',root:f.project,goal:'Verify a previously approved scratch artifact',
  acceptance:['Pinned proof SHA unchanged'],
  steps:[{id:'inspect',title:'Read exact owner-approved scratch receipt'}]
 });
 assert.equal(created.state.revision,1);
 const req={id:'autopilot',runId:'runone',expectedRevision:1,
    maxActions:1,maxPlannerCalls:2,durationMs:24000,
    checks:[{criterion:0,type:'file_sha256',path:'proof.txt',sha256:sha(f.bytes)}]};
 const queued=await f.api.execute('workflow_run_start',req);
 assert.equal(queued.status,'QUEUED');
 // NEVER call manual workflow_run_tick; wait for native scheduler only.
 const final=await awaitTerminal(f.api,'runone');
 assert.equal(final.status,'COMPLETED',JSON.stringify(final));
 const operations=await f.api.execute('workflow_operations',{id:'autopilot'});
 assert.equal(operations.operations.length,1);
 assert.equal(operations.operations[0].tool,'read_text');
 assert.equal(f.dispatched.length,1);
 assert.deepEqual(fs.readFileSync(f.file),f.bytes);
 assert.equal(fs.statSync(f.file,{bigint:true}).mtimeNs,f.initialMtime);
 await delay(1500);
 assert.equal(f.dispatched.length,1,'scheduler must not replay effects');
 await f.restart();
 const readback=await f.api.execute('workflow_run_status',{runId:'runone'});
 assert.equal(readback.status,'COMPLETED');
 const workflow=await f.api.execute('workflow_get',{id:'autopilot'});
 assert.equal(workflow.state.lifecycleState,'COMPLETED');
 const after=await f.api.execute('workflow_status');
 assert.equal(after.runnerConfigured,true);
 assert.equal(after.automaticExecution,true);
 assert.equal(f.dispatched.length,1);
});

test('unrecognized natural-language task is suspended for owner instead of executed',
 {timeout:35000},async t=>{
 // Allow one unused proposal/action budget while the owner request is pending.
 // Separate engine budget tests still verify fail-closed EXHAUSTED on an overrun.
 const f=fixture(t,{stepId:'unknown',stepTitle:'Run a broad unspecified command',maxActions:2,maxPlannerCalls:4});
 const workflow=await f.api.execute('workflow_create',{
  id:'autopilot',root:f.project,goal:'Review an untrusted new instruction',
  acceptance:['Owner scope is clarified'],
  steps:[{id:'unknown',title:'Run a broad unspecified command'}]
 });
 const enqueued=await f.api.execute('workflow_run_start',{
  id:'autopilot',runId:'unknownrun',expectedRevision:workflow.state.revision,
  maxActions:2,maxPlannerCalls:4,durationMs:24000,
  checks:[{criterion:0,type:'file_sha256',path:'proof.txt',sha256:sha(f.bytes)}]
 });
 assert.equal(enqueued.status,'QUEUED');
 const result=await awaitTerminal(f.api,'unknownrun');
 assert.equal(result.status,'WAITING_INPUT',JSON.stringify(result));
 assert.ok(result.pendingRequest?.question?.includes('Owner approval'));
 // The auto-scheduler must not burn available budget or dispatch while waiting.
 await delay(1450);
 const stable=await f.api.execute('workflow_run_status',{runId:'unknownrun'});
 assert.equal(stable.status,'WAITING_INPUT',JSON.stringify(stable));
 assert.equal(stable.attempts,1);
 assert.equal(stable.plannerCalls,2);
 assert.equal(stable.pendingRequest.requestId,result.pendingRequest.requestId);
 assert.equal(f.dispatched.length,0);
 const state=await f.api.execute('workflow_get',{id:'autopilot'});
 assert.equal(state.state.steps[0].status,'pending');
 assert.deepEqual(fs.readFileSync(f.file),f.bytes);
});

test('owner-only runner policy never turns Codex provider or an unapproved scope on',
 t=>{
 const f=fixture(t);
 const c=structuredClone(f.config);
 c.durableWorkflows.runner.provider={
  kind:'codex',executable:'/nowhere/codex',args:[]};
 assert.equal(applyProjectRunnerConfig(c).status,'CODEX_FORBIDDEN');
 c.durableWorkflows.runner.provider={
  kind:'command',executable:process.execPath,args:[]};
 c.capabilityProfile.explicitlyAuthorized=false;
 assert.equal(applyProjectRunnerConfig(c).status,'AUTHORITY_DISABLED');
});
