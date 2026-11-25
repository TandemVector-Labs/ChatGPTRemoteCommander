import test from 'node:test';
import assert from 'node:assert/strict';
import {proposeWithLocalOllama,proposeWithLocalLlamaCpp,validateLocalProposal} from '../tools/local-ollama-planner.mjs';
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

test('existing local llama.cpp OpenAI-compatible server returns only validated proposals',async()=>{
 let sent;const fakeKey='NONPRODUCTION_QA_KEY_12345678';
 const p=await proposeWithLocalLlamaCpp(context,{model:'qwen3-06b-q8',
  readOwnerKey:async()=>fakeKey,fetchImpl:async(url,options)=>{
    assert.equal(url,'http://127.0.0.1:8080/v1/chat/completions');
    assert.equal(options.headers.authorization,'Bearer '+fakeKey);
    sent=JSON.parse(options.body);
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(call)}}]}),{status:200});
  }
 });
 assert.deepEqual(p,call);
 assert.equal(sent.stream,false);
 assert.deepEqual(sent.response_format,{type:'json_object'});
 assert.equal(Object.hasOwn(sent,'tools'),false);
 assert.equal(Object.hasOwn(sent,'tool_choice'),false);
 assert.equal(sent.messages.length,2);
});
test('llama.cpp owner key, network and untrusted model output fail closed',async()=>{
 let used=false;
 await assert.rejects(proposeWithLocalLlamaCpp(context,{
  model:'qwen3-06b-q8',readOwnerKey:async()=>'short',fetchImpl:async()=>{
    used=true;return new Response('{}',{status:200});
  }
 }),/OWNER_KEY_INVALID/);
 assert.equal(used,false);
 await assert.rejects(proposeWithLocalLlamaCpp(context,{
  model:'qwen3-06b-q8',readOwnerKey:async()=>'NONPRODUCTION_QA_KEY_12345678',
  fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({...call,tool:'run_shell'})}}]}),{status:200})
 }),/TOOL_NOT_ADMITTED/);
 await assert.rejects(proposeWithLocalLlamaCpp(context,{
  model:'qwen3-06b-q8',readOwnerKey:async()=>'NONPRODUCTION_QA_KEY_12345678',
  fetchImpl:async()=>new Response('{}',{status:401})
 }),/HTTP_UNAVAILABLE/);
 await assert.rejects(proposeWithLocalLlamaCpp(context,{
  model:'qwen3-06b-q8',readOwnerKey:async()=>'NONPRODUCTION_QA_KEY_12345678',
  fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'not-json'}}]}))
 }),/INVALID_MODEL_JSON/);
});

test('llama.cpp refusal drops any suggested tool and arguments before validation',async()=>{
 const p=await proposeWithLocalLlamaCpp(context,{
  model:'qwen3-06b-q8',readOwnerKey:async()=>'NONPRODUCTION_QA_KEY_12345678',
  fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({
   action:'block',tool:'run_shell',argumentsJson:'{"command":"must never run"}',summary:'Need more evidence'
  })}}]}))
 });
 assert.deepEqual(p,{action:'block',tool:'',argumentsJson:'{}',summary:'Need more evidence'});
});
