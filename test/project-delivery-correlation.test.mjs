import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkflowTools } from '../src/workflow-tools.mjs';
import { validateJsonSchema } from '../src/schema-validator.mjs';
import { DeliveryStore } from '../src/delivery-store.mjs';

test('project run persists caller correlation id and rejects invalid correlation', async () => {
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-project-corr-')));
  const config={
    allowedRoots:[root],
    durableWorkflows:{
      enabled:true,directory:path.join(root,'state'),executionTools:['read_text'],
      runner:{enabled:true,allowedTools:['read_text'],maxActions:2,maxDurationMs:5000}
    }
  };
  const definition={name:'read_text',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}};
  const api=createWorkflowTools({
    config,roots:[root],device:'fixture',configSha256:'1'.repeat(64),
    lookup:name=>name==='read_text'?definition:null,
    validateSchema:validateJsonSchema,
    planner:{describe:()=>({kind:'fixture',available:true,callsPerPlan:1}),plan:async()=>({action:'block',tool:'',argumentsJson:'{}',summary:'stop'})},
    dispatch:async()=>({})
  });
  try{
    const created=await api.execute('workflow_create',{
      id:'project',root,goal:'Persist correlation',acceptance:['Evidence exists'],
      steps:[{id:'step',title:'Inspect evidence'}]
    });
    const state=(await api.execute('workflow_get',{id:'project'})).state;
    const started=await api.execute('workflow_run_start',{
      id:'project',runId:'run-one',correlationId:'chat-a',expectedRevision:state.revision,
      checks:[{criterion:0,type:'text_includes',path:'evidence.txt',text:'evidence'}]
    });
    assert.equal(started.correlationId,'chat-a');
    assert.equal((await api.execute('workflow_run_status',{runId:'run-one'})).correlationId,'chat-a');
    await assert.rejects(
      api.execute('workflow_run_start',{
        id:'project',runId:'bad',correlationId:'bad space',expectedRevision:state.revision,
        checks:[{criterion:0,type:'text_includes',path:'evidence.txt',text:'evidence'}]
      }),
      /PROJECT_CORRELATION_ID_INVALID|schema validation failed/i
    );
  } finally {
    await api.close();
    fs.rmSync(root,{recursive:true,force:true});
  }
});


test('WAITING_INPUT and BLOCKED project states become idempotent correlation-scoped deliveries', async () => {
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-project-delivery-')));
  const deliveryRoot=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-project-delivery-private-')));
  const deliveryStore=new DeliveryStore({directory:deliveryRoot,scope:'profile-a',forbiddenRoots:[root]});
  let plans=0;
  const config={
    allowedRoots:[root],
    durableWorkflows:{
      enabled:true,directory:path.join(root,'state'),executionTools:['read_text'],
      runner:{enabled:true,allowedTools:['read_text'],maxActions:4,maxDurationMs:10000}
    }
  };
  const definition={name:'read_text',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}};
  const api=createWorkflowTools({
    config,roots:[root],device:'fixture',configSha256:'2'.repeat(64),deliveryStore,
    lookup:name=>name==='read_text'?definition:null,validateSchema:validateJsonSchema,
    planner:{
      describe:()=>({kind:'fixture',available:true,callsPerPlan:1}),
      plan:async()=>++plans===1
        ? {action:'block',tool:'',argumentsJson:JSON.stringify({request:{question:'Choose mode',options:['A','B']}}),summary:'input needed'}
        : {action:'block',tool:'',argumentsJson:'{}',summary:'cannot proceed'}
    },
    dispatch:async()=>({})
  });
  try{
    await api.execute('workflow_create',{
      id:'project',root,goal:'Exercise delivery states',acceptance:['Evidence exists'],
      steps:[{id:'step',title:'Inspect evidence'}]
    });
    const state=(await api.execute('workflow_get',{id:'project'})).state;
    await api.execute('workflow_run_start',{
      id:'project',runId:'run-one',correlationId:'chat-a',expectedRevision:state.revision,
      checks:[{criterion:0,type:'text_includes',path:'evidence.txt',text:'evidence'}]
    });
    const waiting=await api.execute('workflow_run_tick',{runId:'run-one'});
    assert.equal(waiting.status,'WAITING_INPUT');
    let items=deliveryStore.list({correlationId:'chat-a',includeDelivered:true}).items;
    assert.equal(items.length,1);
    assert.equal(items[0].kind,'WAITING_INPUT');
    assert.equal(items[0].sourceId,'run-one');
    assert.equal(deliveryStore.list({correlationId:'chat-b',includeDelivered:true}).items.length,0);
    await api.execute('workflow_run_status',{runId:'run-one'});
    assert.equal(deliveryStore.list({correlationId:'chat-a',includeDelivered:true}).items.length,1);
    assert.throws(
      ()=>deliveryStore.claim({deliveryId:items[0].deliveryId,correlationId:'chat-b',attemptId:'attempt-b'}),
      /DELIVERY_CORRELATION_MISMATCH/
    );
    const workflow=(await api.execute('workflow_get',{id:'project'})).state;
    await api.execute('workflow_run_resolve',{
      runId:'run-one',requestId:waiting.pendingRequest.requestId,expectedRevision:workflow.revision,response:'A'
    });
    const blocked=await api.execute('workflow_run_tick',{runId:'run-one'});
    assert.equal(blocked.status,'BLOCKED');
    items=deliveryStore.list({correlationId:'chat-a',includeDelivered:true}).items;
    assert.equal(items.length,2);
    assert.deepEqual(items.map(x=>x.kind).sort(),['BLOCKED','WAITING_INPUT']);
  } finally {
    await api.close();
    deliveryStore.close();
    fs.rmSync(root,{recursive:true,force:true});
    fs.rmSync(deliveryRoot,{recursive:true,force:true});
  }
});


for (const controlAction of ['pause','cancel']) test(controlAction+' project state becomes a durable delivery event', async () => {
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-project-delivery-control-')));
  const deliveryRoot=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-project-delivery-control-private-')));
  const deliveryStore=new DeliveryStore({directory:deliveryRoot,scope:'profile-control',forbiddenRoots:[root]});
  const config={allowedRoots:[root],durableWorkflows:{enabled:true,directory:path.join(root,'state'),executionTools:['read_text'],
    runner:{enabled:true,allowedTools:['read_text'],maxActions:2,maxDurationMs:10000}}};
  const definition={name:'read_text',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}};
  const api=createWorkflowTools({config,roots:[root],device:'fixture',configSha256:'3'.repeat(64),deliveryStore,
    lookup:name=>name==='read_text'?definition:null,validateSchema:validateJsonSchema,
    planner:{describe:()=>({kind:'fixture',available:true,callsPerPlan:1}),plan:async()=>({action:'call',tool:'read_text',argumentsJson:'{"path":"x.txt"}',summary:'read'})},
    dispatch:async()=>({text:'x'})});
  try{
    await api.execute('workflow_create',{id:'project',root,goal:'Control delivery',acceptance:['Evidence exists'],steps:[{id:'step',title:'Read'}]});
    let state=(await api.execute('workflow_get',{id:'project'})).state;
    await api.execute('workflow_run_start',{id:'project',runId:'run-one',correlationId:'chat-'+controlAction,expectedRevision:state.revision,
      checks:[{criterion:0,type:'text_includes',path:'evidence.txt',text:'evidence'}]});
    state=(await api.execute('workflow_get',{id:'project'})).state;
    await api.execute('workflow_control',{id:'project',expectedRevision:state.revision,action:controlAction,reason:'test control'});
    const terminal=await api.execute('workflow_run_tick',{runId:'run-one'});
    assert.equal(terminal.status,controlAction==='pause'?'PAUSED':'CANCELLED');
    const items=deliveryStore.list({correlationId:'chat-'+controlAction,includeDelivered:true}).items;
    assert.equal(items.length,1);
    assert.equal(items[0].kind,controlAction==='pause'?'PAUSED':'CANCELLED');
  } finally {
    await api.close(); deliveryStore.close();
    fs.rmSync(root,{recursive:true,force:true}); fs.rmSync(deliveryRoot,{recursive:true,force:true});
  }
});

test('EXHAUSTED project state becomes a durable delivery event', async () => {
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-project-delivery-exhausted-')));
  const deliveryRoot=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-project-delivery-exhausted-private-')));
  const deliveryStore=new DeliveryStore({directory:deliveryRoot,scope:'profile-exhausted',forbiddenRoots:[root]});
  // This fixture tests action exhaustion, not elapsed-time expiry. Keep the
  // existing 30s test-policy maximum so Windows runner contention cannot
  // exhaust the wall clock before the second bounded workflow tick.
  const config={allowedRoots:[root],durableWorkflows:{enabled:true,directory:path.join(root,'state'),executionTools:['read_text'],
    runner:{enabled:true,allowedTools:['read_text'],maxActions:4,maxDurationMs:30000}}};
  const definition={name:'read_text',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}};
  const api=createWorkflowTools({config,roots:[root],device:'fixture',configSha256:'4'.repeat(64),deliveryStore,
    lookup:name=>name==='read_text'?definition:null,validateSchema:validateJsonSchema,
    planner:{describe:()=>({kind:'fixture',available:true,callsPerPlan:1}),plan:async()=>({action:'call',tool:'read_text',argumentsJson:'{"path":"source.txt"}',summary:'read'})},
    dispatch:async()=>({text:'source'})});
  try{
    await api.execute('workflow_create',{id:'project',root,goal:'Exhaust action budget',acceptance:['Evidence exists'],
      steps:[{id:'a',title:'First read'},{id:'b',title:'Second read'}]});
    const state=(await api.execute('workflow_get',{id:'project'})).state;
    await api.execute('workflow_run_start',{id:'project',runId:'run-one',correlationId:'chat-exhausted',expectedRevision:state.revision,maxActions:1,
      checks:[{criterion:0,type:'text_includes',path:'evidence.txt',text:'evidence'}]});
    await api.execute('workflow_run_tick',{runId:'run-one'});
    const terminal=await api.execute('workflow_run_tick',{runId:'run-one'});
    assert.equal(terminal.status,'EXHAUSTED');
    const items=deliveryStore.list({correlationId:'chat-exhausted',includeDelivered:true}).items;
    assert.equal(items.length,1); assert.equal(items[0].kind,'EXHAUSTED');
  } finally {
    await api.close(); deliveryStore.close();
    fs.rmSync(root,{recursive:true,force:true}); fs.rmSync(deliveryRoot,{recursive:true,force:true});
  }
});

test('COMPLETED project state becomes a durable delivery event', async () => {
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-project-delivery-completed-')));
  const deliveryRoot=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-project-delivery-completed-private-')));
  const deliveryStore=new DeliveryStore({directory:deliveryRoot,scope:'profile-completed',forbiddenRoots:[root]});
  const config={allowedRoots:[root],durableWorkflows:{enabled:true,directory:path.join(root,'state'),executionTools:['write_text'],
    runner:{enabled:true,allowedTools:['write_text'],maxActions:2,maxDurationMs:10000}}};
  const definition={name:'write_text',inputSchema:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content'],additionalProperties:false}};
  const api=createWorkflowTools({config,roots:[root],device:'fixture',configSha256:'5'.repeat(64),deliveryStore,
    lookup:name=>name==='write_text'?definition:null,validateSchema:validateJsonSchema,
    planner:{describe:()=>({kind:'fixture',available:true,callsPerPlan:1}),plan:async()=>({action:'call',tool:'write_text',argumentsJson:'{"path":"result.txt","content":"verified evidence"}',summary:'write'})},
    dispatch:async(_name,args)=>{fs.writeFileSync(path.join(root,args.path),args.content);return {ok:true};}});
  try{
    await api.execute('workflow_create',{id:'project',root,goal:'Complete with evidence',acceptance:['Evidence exists'],steps:[{id:'write',title:'Write evidence'}]});
    const state=(await api.execute('workflow_get',{id:'project'})).state;
    await api.execute('workflow_run_start',{id:'project',runId:'run-one',correlationId:'chat-completed',expectedRevision:state.revision,
      checks:[{criterion:0,type:'text_includes',path:'result.txt',text:'verified evidence'}]});
    await api.execute('workflow_run_tick',{runId:'run-one'});
    const terminal=await api.execute('workflow_run_tick',{runId:'run-one'});
    assert.equal(terminal.status,'COMPLETED');
    const items=deliveryStore.list({correlationId:'chat-completed',includeDelivered:true}).items;
    assert.equal(items.length,1); assert.equal(items[0].kind,'COMPLETED');
  } finally {
    await api.close(); deliveryStore.close();
    fs.rmSync(root,{recursive:true,force:true}); fs.rmSync(deliveryRoot,{recursive:true,force:true});
  }
});
