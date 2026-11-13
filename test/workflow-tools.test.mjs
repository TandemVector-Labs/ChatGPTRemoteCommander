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
