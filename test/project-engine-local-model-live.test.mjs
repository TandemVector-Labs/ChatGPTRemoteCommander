import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createWorkflowTools } from '../src/workflow-tools.mjs';
import { createCommandPlanner } from '../src/project-planner.mjs';
import { validateJsonSchema } from '../src/schema-validator.mjs';
import { readText } from '../src/tools-v0.3.mjs';

// Deliberately excluded from default unit-suite execution. An operator must
// supply a reviewed local proposal-only adapter and explicitly opt in.
// The only Project Engine host tool admitted here is read_text.
const enabled=process.env.RC_TEST_LIVE_LOCAL_MODEL==='1';
const digest=data=>createHash('sha256').update(data).digest('hex');
const content='V1-05 read-only large-input qualification fixture.\n'
  +'One workflow step must not leak its raw file content into the next planner input.\n'
  +('Stable read-only input, independently verified after the tool receipt.\n'.repeat(320));
const manifest=JSON.stringify({name:'v105-local-model-qa',type:'module',private:true},null,2)+'\n';

test('real local-model planner completes two guarded read-only steps using bounded observations',
  {skip:!enabled,timeout:120000},async t=>{
    const adapter=process.env.RC_TEST_LOCAL_PLANNER_ADAPTER;
    const model=process.env.RC_LOCAL_AI_MODEL;
    assert.ok(typeof adapter==='string'&&path.isAbsolute(adapter),
      'RC_TEST_LOCAL_PLANNER_ADAPTER must be an absolute reviewed local adapter path');
    assert.ok(typeof model==='string'&&model.length>0,'RC_LOCAL_AI_MODEL must be set');
    const modelFamily=model.split(':',1)[0];
    const stat=fs.lstatSync(adapter);
    assert.ok(stat.isFile()&&!stat.isSymbolicLink(),'Adapter must be a regular file');
    const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'v105-model-qa-')));
    let api;
    const observations=[];
    try{
      fs.mkdirSync(path.join(root,'docs'));
      fs.writeFileSync(path.join(root,'docs','PROJECT_ENGINE.md'),content);
      fs.writeFileSync(path.join(root,'package.json'),manifest);
      const config={
        allowedRoots:[root],maxWriteBytes:524288,maxReadBytes:524288,
        auditLog:path.join(root,'audit.jsonl'),
        durableWorkflows:{enabled:true,directory:path.join(root,'state'),
          executionTools:['read_text'],
          scheduler:{enabled:false,intervalMs:1000,oneWriterPerRoot:true},
          runner:{enabled:true,allowedTools:['read_text'],
            maxActions:2,maxPlannerCalls:2,maxDurationMs:120000}}
      };
      const tools={
        read_text:{name:'read_text',description:'Read an approved UTF-8 project file (read-only).',
          inputSchema:{type:'object',properties:{
            path:{type:'string',minLength:1},
            offset:{type:'integer',minimum:0},
            maxBytes:{type:'integer',minimum:1,maximum:262144}
          },required:['path'],additionalProperties:false}}
      };
      const planner=createCommandPlanner({kind:'command',model,modelFamily,reasoningEffort:'none',
        executionMode:'project-agent',profileVersion:'1',
        executable:process.execPath,args:[adapter],timeoutMs:30000,maxOutputBytes:4096});
      api=createWorkflowTools({
        config,roots:[root],device:'v105-real-local-model-qa',configSha256:'7'.repeat(64),
        lookup:name=>tools[name],validateSchema:validateJsonSchema,planner,
        dispatch:async(name,args,workflow)=>{
          assert.equal(name,'read_text');
          const context={roots:[workflow.root],auditLog:config.auditLog,
            config:{...config,allowedRoots:[workflow.root],
              powerMode:{enabled:false,fullFilesystem:false}}};
          const result=await readText(context,args);
          observations.push({path:path.relative(root,result.path).split(path.sep).join('/'),sha256:result.sha256,
            pageBytes:result.bytes,fileBytes:result.fileBytes});
          return result;
        }
      });
      await api.execute('workflow_create',{
        id:'project',root,
        goal:'Read exactly docs/PROJECT_ENGINE.md, then package.json, using only read_text. No writes or shell actions. Independently verify both file hashes.',
        acceptance:['docs/PROJECT_ENGINE.md full SHA256 matches baseline',
          'package.json full SHA256 matches baseline'],
        executionProfile:{modelFamily,modelVariant:model,reasoningEffort:'none',
          executionMode:'project-agent',profileVersion:'1',fallbackPolicy:'exact-only'},
        steps:[
          {id:'read_spec',title:'Use read_text to inspect exactly docs/PROJECT_ENGINE.md'},
          {id:'read_manifest',title:'After read_spec, use read_text to inspect exactly package.json',dependsOn:['read_spec']}
        ]
      });
      const state=(await api.execute('workflow_get',{id:'project'})).state;
      await api.execute('workflow_run_start',{
        id:'project',runId:'local_model_qa',expectedRevision:state.revision,
        correlationId:'v105-real-local-model-qa',maxActions:2,maxPlannerCalls:2,
        durationMs:120000,checks:[
          {criterion:0,type:'file_sha256',path:'docs/PROJECT_ENGINE.md',sha256:digest(content)},
          {criterion:1,type:'file_sha256',path:'package.json',sha256:digest(manifest)}
        ]
      });
      const ticks=[];
      for(let n=0;n<3;n++){
        const step=await api.execute('workflow_run_tick',{runId:'local_model_qa'});
        ticks.push({status:step.status,lastCode:step.lastCode});
        if(['COMPLETED','BLOCKED','EXHAUSTED','CANCELLED'].includes(step.status))break;
      }
      const final=await api.execute('workflow_run_status',{runId:'local_model_qa'});
      const workflow=(await api.execute('workflow_get',{id:'project'})).state;
      assert.equal(final.status,'COMPLETED',JSON.stringify({ticks,code:final.lastCode}));
      assert.equal(final.lastCode,'PROJECT_ACCEPTANCE_VERIFIED');
      assert.equal(final.actions,2);
      assert.equal(final.plannerCalls,2);
      assert.equal(workflow.lifecycleState,'COMPLETED');
      assert.deepEqual(workflow.steps.map(s=>s.status),['verified','verified']);
      assert.equal(final.verification.length,2);
      assert.ok(final.verification.every(v=>v.code==='PASS'&&v.passed===true));
      assert.deepEqual(observations.map(o=>o.path),[
        'docs/PROJECT_ENGINE.md','docs/PROJECT_ENGINE.md','package.json'
      ]);
      assert.equal(observations[1].pageBytes,1024);
      assert.equal(observations[1].fileBytes,Buffer.byteLength(content));
      assert.equal(observations[1].sha256,digest(content));
      t.diagnostic(JSON.stringify({model,ticks,actions:final.actions,
        plannerCalls:final.plannerCalls,verification:final.verification.map(v=>({path:v.path,code:v.code})),
        specBytes:Buffer.byteLength(content)}));
    } finally {
      await api?.close();
      fs.rmSync(root,{recursive:true,force:true});
    }
  });
