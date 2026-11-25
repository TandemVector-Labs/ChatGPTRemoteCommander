import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createWorkflowTools,WORKFLOW_TOOL_DEFINITIONS,PROJECT_ENGINE_TOOL_DEFINITIONS} from '../src/workflow-tools.mjs';
const fixture=()=>{
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-wf-adapter-')));
 const base={config:{durableWorkflows:{enabled:true,directory:path.join(root,'state')}},roots:[root],device:'fixture',configSha256:'0'.repeat(64),lookup:name=>({name,inputSchema:{type:'object'}}),validateSchema:()=>[],dispatch:async()=>({ok:true})};
 const tool=createWorkflowTools(base);
 return {root,base,tool,dispose(){tool.close();fs.rmSync(root,{recursive:true,force:true});}};
};
test('disabled adapter cannot silently create memory',()=>assert.throws(()=>createWorkflowTools({config:{}}),/DISABLED/));
test('catalog preserves original tools and adds autonomy controls with unique names',()=>{
 assert.equal(new Set(WORKFLOW_TOOL_DEFINITIONS.map(d=>d.name)).size,WORKFLOW_TOOL_DEFINITIONS.length);
 for(const name of ['workflow_status','workflow_create','workflow_get','workflow_roadmap','workflow_plan_insert','workflow_plan_edit','workflow_plan_prioritize','workflow_list','workflow_note','workflow_search','workflow_checkpoint','workflow_needs_chat','workflow_resume','workflow_call','workflow_reconcile','workflow_export'])assert.ok(WORKFLOW_TOOL_DEFINITIONS.some(d=>d.name===name),name);
 assert.equal(WORKFLOW_TOOL_DEFINITIONS.find(d=>d.name==='workflow_call').annotations.destructiveHint,true);
 assert.equal(WORKFLOW_TOOL_DEFINITIONS.find(d=>d.name==='workflow_needs_chat').annotations.openWorldHint,false);
});
test('project-engine tool schema stays stable when runner is disabled',async()=>{
 const f=fixture();try{
  for(const def of PROJECT_ENGINE_TOOL_DEFINITIONS)assert.ok(f.tool.definitions.some(x=>x.name===def.name),def.name);
  await assert.rejects(f.tool.execute('workflow_run_status',{runId:'disabled'}),/WORKFLOW_RUNNER_DISABLED/);
 }finally{f.dispose();}
});
test('workflow cannot write Host config through exact, relative, absent or aliased project paths',async()=>{
 const f=fixture();let guarded,dispatched=0;
 const active=path.join(f.root,'config.local.json');
 const fallback=path.join(f.root,'config.json');
 const initial='owner-config-must-stay-unchanged';
 fs.writeFileSync(active,initial);
 try{
  guarded=createWorkflowTools({...f.base,
   protectedHostConfigPaths:[active,fallback],
   config:{durableWorkflows:{enabled:true,directory:path.join(f.root,'guarded-state'),executionTools:['write_text']}},
   dispatch:async()=>{dispatched++;return {ok:true};}
  });
  await guarded.execute('workflow_create',{id:'p',root:f.root,goal:'Cannot self-edit host config',
   acceptance:['Owner configuration unchanged'],steps:[{id:'s',title:'Try a write'}]});
  const attempt=async target=>guarded.execute('workflow_call',{
   id:'p',stepId:'s',expectedRevision:1,tool:'write_text',arguments:{path:target,content:'wrong'}
  });
  for(const target of [active,'config.local.json',fallback,'config.json']){
   await assert.rejects(attempt(target),/WORKFLOW_HOST_CONFIG_WRITE_DENIED/);
  }
  assert.equal(dispatched,0);
  assert.equal(fs.readFileSync(active,'utf8'),initial);
  assert.equal(fs.existsSync(fallback),false);
  const alias=path.join(f.root,'cfg-alias');
  let symlinkCreated=false;
  try {fs.symlinkSync(f.root,alias,process.platform==='win32'?'junction':'dir');symlinkCreated=true;}
  catch(error){if(!['EPERM','EACCES','ENOTSUP'].includes(error?.code))throw error;}
  if(symlinkCreated){
   await assert.rejects(attempt(path.join(alias,'config.local.json')),
    /WORKFLOW_HOST_CONFIG_WRITE_DENIED/);
  }
  assert.equal(dispatched,0);
  assert.equal((await guarded.execute('workflow_get',{id:'p'})).state.revision,1);
  const allowed=await attempt('ordinary-output.txt');
  assert.ok(allowed);
  assert.equal(dispatched,1);
 }finally{guarded?.close();f.dispose();}
});

test('all workflow file mutation tools preserve Host config and containing directories',async()=>{
 const f=fixture();let guarded;
 const control=path.join(f.root,'control');
 const active=path.join(control,'config.local.json');
 const fallback=path.join(control,'missing','config.json');
 const envKey='RC_WF_CONFIG_GUARD_FIXTURE_ROOT';
 const prior=process.env[envKey];
 const dispatched=[];
 fs.mkdirSync(control);
 fs.writeFileSync(active,'owner config');
 fs.writeFileSync(path.join(f.root,'ordinary.txt'),'ordinary project data');
 try{
  process.env[envKey]=control;
  const tools=['write_text','write_file','create_directory','copy_path','move_path','delete_path'];
  guarded=createWorkflowTools({...f.base,protectedHostConfigPaths:[active,fallback],
   config:{durableWorkflows:{enabled:true,directory:path.join(f.root,'guarded-effects'),executionTools:tools}},
   dispatch:async(name,args)=>{dispatched.push({name,args});return {ok:true};}
  });
  await guarded.execute('workflow_create',{id:'effects',root:f.root,goal:'Preserve control plane',
   acceptance:['Owner configuration unchanged'],steps:[{id:'s',title:'File mutation'}]});
  const attempt=(tool,args)=>guarded.execute('workflow_call',{
   id:'effects',stepId:'s',expectedRevision:1,tool,arguments:args
  });
  const blocked=[
   ['write_file',{path:active,content:'wrong'}],
   ['write_file',{path:'%'+envKey+'%/config.local.json',content:'wrong'}],
   ['write_file',{path:path.join(fallback,'nested','file.txt'),content:'wrong'}],
   ['create_directory',{path:fallback}],
   ['create_directory',{path:path.join(fallback,'child')}],
   ['copy_path',{source:'ordinary.txt',destination:active,overwrite:true}],
   ['copy_path',{source:'ordinary.txt',destination:control,overwrite:true}],
   ['move_path',{source:active,destination:'other.json'}],
   ['move_path',{source:control,destination:'other'}],
   ['move_path',{source:'ordinary.txt',destination:control,overwrite:true}],
   ['delete_path',{path:active}],
   ['delete_path',{path:control}],
   ['delete_path',{path:'.'}]
  ];
  for(const [name,args] of blocked){
   await assert.rejects(attempt(name,args),/WORKFLOW_HOST_CONFIG_WRITE_DENIED/,name+':'+JSON.stringify(args));
  }
  const alias=path.join(f.root,'control-alias');
  fs.symlinkSync(control,alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(attempt('delete_path',{path:alias}),/WORKFLOW_HOST_CONFIG_WRITE_DENIED/);
  await assert.rejects(attempt('write_file',{path:path.join(alias,'missing','config.json','child'),content:'wrong'}),
   /WORKFLOW_HOST_CONFIG_WRITE_DENIED/);
  assert.equal(dispatched.length,0);
  assert.equal(fs.readFileSync(active,'utf8'),'owner config');
  assert.equal(fs.existsSync(fallback),false);
  assert.equal((await guarded.execute('workflow_get',{id:'effects'})).state.revision,1);
  // A sibling with a similar name is not the reserved file.
  await attempt('write_file',{path:path.join(control,'config.local.json.backup'),content:'ok'});
  assert.equal(dispatched.length,1);
 }finally{
  if(prior===undefined)delete process.env[envKey];else process.env[envKey]=prior;
  guarded?.close();f.dispose();
 }
});

test('default execution policy excludes shell, deletion, credentials and recursive workflow calls',async()=>{const f=fixture();try{
 await f.tool.execute('workflow_create',{id:'x',root:f.root,goal:'Goal',acceptance:['Observe'],steps:[{id:'a',title:'Step'}]});
 for(const name of ['run_shell','delete_path','kill_process','workflow_call'])await assert.rejects(f.tool.execute('workflow_call',{id:'x',stepId:'a',expectedRevision:1,tool:name,arguments:{}}),/NOT_APPROVED/);
 assert.equal((await f.tool.execute('workflow_get',{id:'x'})).state.revision,1);
}finally{f.dispose();}});
test('durable workflows cannot perform or acquire interactive desktop takeover',async()=>{const f=fixture();let tool;try{
 tool=createWorkflowTools({...f.base,config:{durableWorkflows:{enabled:true,directory:path.join(f.root,'gui-direct-only'),executionTools:['gui_session_begin','gui_screenshot','gui_mouse_click']}}});
 await tool.execute('workflow_create',{id:'x',root:f.root,goal:'Observe without takeover',acceptance:['No input'],steps:[{id:'a',title:'Step'}]});
 await assert.rejects(tool.execute('workflow_call',{id:'x',stepId:'a',expectedRevision:1,tool:'gui_session_begin',arguments:{mode:'takeover',explicitUserAuthorization:'old authorization'}}),/GUI_TAKEOVER_REQUIRES_DIRECT_USER_SESSION/);
 await assert.rejects(tool.execute('workflow_call',{id:'x',stepId:'a',expectedRevision:1,tool:'gui_mouse_click',arguments:{}}),/GUI_TAKEOVER_REQUIRES_DIRECT_USER_SESSION/);
 assert.equal((await tool.execute('workflow_get',{id:'x'})).state.revision,1);
}finally{tool?.close();f.dispose();}});
test('process management tools are denied even when explicitly allowlisted',async()=>{
 const f=fixture();let tool;
 try{
  tool=createWorkflowTools({...f.base,config:{durableWorkflows:{
   enabled:true,directory:path.join(f.root,'process-tools'),
   executionTools:['kill_process','start_terminal','send_terminal','stop_terminal']
  }}});
  await tool.execute('workflow_create',{id:'x',root:f.root,goal:'No process control',acceptance:['No unmanaged processes'],steps:[{id:'a',title:'Step'}]});
  for(const name of ['kill_process','start_terminal','send_terminal','stop_terminal']){
   await assert.rejects(tool.execute('workflow_call',{id:'x',stepId:'a',expectedRevision:1,tool:name,arguments:{}}),/WORKFLOW_PROCESS_TOOL_NOT_SUPPORTED/);
  }
  assert.equal((await tool.execute('workflow_get',{id:'x'})).state.revision,1);
 }finally{tool?.close();f.dispose();}
});
test('underlying schema is mandatory before invocation',async()=>{const f=fixture();let tool;try{
 tool=createWorkflowTools({...f.base,validateSchema:()=>['invalid']});await tool.execute('workflow_create',{id:'x',root:f.root,goal:'Goal',acceptance:['Observe'],steps:[{id:'a',title:'Step'}]});
 await assert.rejects(tool.execute('workflow_call',{id:'x',stepId:'a',expectedRevision:1,tool:'read_text',arguments:{}}),/ARGUMENTS_INVALID/);
}finally{tool?.close();f.dispose();}});
test('unsafe host policy rejected at initialization',()=>{const f=fixture();try{assert.throws(()=>createWorkflowTools({...f.base,config:{durableWorkflows:{enabled:true,directory:path.join(f.root,'other'),executionTools:['credential_dump']}}}),/INVALID_TOOL_POLICY/);}finally{f.dispose();}});
test('image observations preserve MCP content with durable receipt, never cache frame output',async()=>{const f=fixture();let tool;try{
 tool=createWorkflowTools({...f.base,config:{durableWorkflows:{enabled:true,directory:path.join(f.root,'images'),executionTools:['gui_screenshot']}},dispatch:async()=>({__mcpContent:[{type:'image',mimeType:'image/png',data:'ABCD'}],__structuredContent:{frame:'ephemeral'}})});
 await tool.execute('workflow_create',{id:'x',root:f.root,goal:'Image',acceptance:['Observe'],steps:[{id:'a',title:'Inspect'}]});
 const args={id:'x',stepId:'a',expectedRevision:1,tool:'gui_screenshot',arguments:{}};const a=await tool.execute('workflow_call',args);assert.equal(a.__mcpContent[0].type,'image');
 const b=await tool.execute('workflow_call',args);assert.equal(b.cachedReceipt,true);assert.equal(b.__mcpContent,undefined);
}finally{tool?.close();f.dispose();}});

test('workflow scheduler intervals stay finite and within Node timer bounds',()=>{
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-wf-timer-')));
 const create=(intervalMs)=>createWorkflowTools({
  config:{durableWorkflows:{enabled:true,directory:path.join(root,'state'),executionTools:['read_text'],
   scheduler:{enabled:true,intervalMs}}},
  roots:[root],device:'fixture',configSha256:'0'.repeat(64),
  lookup:name=>({name,inputSchema:{type:'object'}}),
  validateSchema:()=>[],dispatch:async()=>({ok:true})
 });
 try{
  let coercions=0;
  const trap={valueOf(){coercions++;throw Error('UNTRUSTED_COERCION');}};
  for(const value of [2147483648,Number.MAX_SAFE_INTEGER,NaN,Infinity,-Infinity,
    -1,0,999,1000.5,'5000',null,trap]){
   let tool=null;
   try{
    assert.throws(()=>{tool=create(value)},/WORKFLOW_SCHEDULER_INTERVAL_INVALID/);
   }finally{tool?.close();}
  }
  assert.equal(coercions,0,'untrusted valueOf must never execute');
  for(const value of [undefined,1000,5000,3_600_000]){
   const tool=create(value);
   try{assert.ok(tool.schedulerTick);}finally{tool.close();}
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
