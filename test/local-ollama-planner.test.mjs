import test from 'node:test';
import assert from 'node:assert/strict';
import {proposeWithLocalOllama,validateLocalProposal} from '../tools/local-ollama-planner.mjs';
const context={workflowId:'owner-approved-fixture',currentStep:{id:'inspect'},tools:[{name:'read_text'}]};
const call={action:'call',tool:'read_text',argumentsJson:'{"path":"proof.txt"}',summary:'Inspect only'};
const block={action:'block',tool:'',argumentsJson:'{}',summary:'Needs owner approval'};
const response=obj=>new Response(JSON.stringify({message:{content:JSON.stringify(obj)}}),{status:200});
test('local-only endpoint and exact structured no-effect proposal',async()=>{
 let sent;
 const p=await proposeWithLocalOllama(context,{model:'qwen3:4b-instruct',fetchImpl:async(url,init)=>{
  assert.equal(url,'http://127.0.0.1:11434/api/chat');sent=JSON.parse(init.body);return response(call);
 }});
 assert.deepEqual(p,call);
 assert.equal(sent.stream,false);assert.equal(sent.format,'json');
 assert.equal(Object.hasOwn(sent,'tools'),false);
});
test('explicit block without tool accepted',()=>assert.deepEqual(validateLocalProposal(block,context),block));
test('model cannot nominate unlisted tool or scope expansion',()=>{
 assert.throws(()=>validateLocalProposal({...call,tool:'run_shell'},context),/TOOL_NOT_ADMITTED/);
 assert.throws(()=>validateLocalProposal({...call,action:'delegate'},context),/INVALID_PROPOSAL/);
 assert.throws(()=>validateLocalProposal({...block,tool:'read_text'},context),/BLOCK_WITH_TOOL/);
 assert.throws(()=>validateLocalProposal({...call,extra:'sudo'},context),/INVALID_PROPOSAL/);
});
test('reject array/invalid JSON argument and invalid model',async()=>{
 assert.throws(()=>validateLocalProposal({...call,argumentsJson:'[]'},context),/INVALID_ARGUMENTS/);
 assert.throws(()=>validateLocalProposal({...call,argumentsJson:'{'},context),/INVALID_ARGUMENTS/);
 await assert.rejects(proposeWithLocalOllama(context,{model:'',fetchImpl:async()=>response(block)}),/MODEL_NOT_CONFIGURED/);
});
test('network errors and non-200 responses are fail-closed',async()=>{
 await assert.rejects(proposeWithLocalOllama(context,{model:'test',fetchImpl:async()=>{throw Error('private-data');}}),/HTTP_UNAVAILABLE/);
 await assert.rejects(proposeWithLocalOllama(context,{model:'test',fetchImpl:async()=>new Response('x',{status:500})}),/HTTP_UNAVAILABLE/);
});
test('oversized model body and unauthorized JSON fail closed',async()=>{
 await assert.rejects(proposeWithLocalOllama(context,{model:'test',fetchImpl:async()=>new Response('x'.repeat(128*1024+1))}),/RESPONSE_TOO_LARGE/);
 await assert.rejects(proposeWithLocalOllama(context,{model:'test',fetchImpl:async()=>new Response('{}')}),/INVALID_CONTENT/);
});
test('proposal is one bounded scope-owned action, not execution',async()=>{
 const r=await proposeWithLocalOllama(context,{model:'test',fetchImpl:async()=>response(block)});
 assert.equal(r.action,'block');assert.equal(r.tool,'');
});
