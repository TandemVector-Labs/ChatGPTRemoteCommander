import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fsModule from 'node:fs';
import osModule from 'node:os';
import {createOllamaGenerate} from './ollama-provider.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url));
const call=args=>{
 const r=spawnSync(process.execPath,[path.join(dir,'cli.mjs'),...args],
  {cwd:dir,encoding:'utf8',timeout:15000,windowsHide:true,maxBuffer:1024*1024});
 return {status:r.status,out:JSON.parse((r.stdout||r.stderr).trim())};
};
test('doctor reports usable managed backend candidates without personal-session claim',()=>{
 const {status,out}=call(['doctor']);
 assert.equal(status,0);assert.equal(out.status,'PASS');
 assert.ok(out.backends.some(e=>e.requested==='auto'));
 assert.equal(out.personalSessionAttach,false);
 assert.equal(out.ownerConsentRequired,true);
 assert.equal(out.stagehandInstalled,true);
 assert.ok(out.backends.some(e=>e.requested==='stagehand'&&e.selected==='stagehand-chromium'));

});
test('invalid requested engine fails without opening a browser',()=>{
 const {status,out}=call(['run','--engine=personal-profile','--url=https://example.com']);
 assert.equal(status,1);assert.equal(out.status,'FAIL');assert.match(out.reason,/ENGINE_INVALID/);
});
test('invalid URL scheme and URL userinfo fail closed before browser startup',()=>{
 for(const uri of ['file:///etc/passwd','https://user:secret@example.com/']){
  const {status,out}=call(['run','--url='+uri]);
  assert.equal(status,1);assert.match(out.reason,/HTTP_URL_REQUIRED/);
 }
});
test('missing URL fails before browser startup',()=>{
 const {status,out}=call(['run']);
 assert.equal(status,1);assert.match(out.reason,/URL_REQUIRED/);
});

test('untrusted workflow cannot execute arbitrary code or access filesystem URLs',()=>{
 const fs=fsModule, os=osModule;
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'v104-workflow-deny-'));
 const workflow=path.join(folder,'rejected.json');
 try{
  fs.writeFileSync(workflow,JSON.stringify([{action:'evaluate',script:'process.exit(1)'}]),{flag:'wx'});
  const {status,out}=call(['run','--engine=stagehand','--url=https://example.com','--steps='+workflow]);
  assert.equal(status,1);assert.equal(out.status,'FAIL');assert.match(out.reason,/ACTION_DENIED/);
 }finally{fs.rmSync(folder,{recursive:true,force:true})}
});

test('Ollama Stagehand adapter forbids non-loopback destinations and untrusted content',async()=>{
 for(const url of ['https://ollama.example/api/chat','http://192.168.0.1:11434/api/chat',
  'http://127.0.0.1:11435/api/chat','http://127.0.0.1:11434/api/generate'])
  assert.throws(()=>createOllamaGenerate({url}),/OLLAMA_ONLY_HOST_LOCAL_LOOPBACK/);
 const g=createOllamaGenerate({fetchFn:async()=>{throw Error('UNEXPECTED_NETWORK')}});
 await assert.rejects(g({messages:[],responseFormat:{type:'text'}}),/STAGEHAND_STRUCTURED_ONLY/);
 await assert.rejects(g({messages:[{role:'user',content:{type:'image',data:'fake'}}],
  responseFormat:{type:'json_schema',schema:{type:'object'}}}),/OLLAMA_TEXT_ONLY_NO_IMAGES/);
});
test('Ollama adapter sends bounded schema to localhost and returns structured content',async()=>{
 let called=0,body=null;
 const g=createOllamaGenerate({fetchFn:async(_url,init)=>{
  called++;body=JSON.parse(init.body);
  return {ok:true,json:async()=>({message:{content:'{"selector":"#v104-email"}'}})};
 }});
 const schema={type:'object',properties:{selector:{type:'string'}},required:['selector']};
 const x=await g({systemPrompt:'Return only a CSS selector',messages:[{role:'user',content:{type:'text',text:'Visible input'}}],
  responseFormat:{type:'json_schema',name:'test',schema}});
 assert.equal(called,1);assert.equal(body.model,'qwen3:4b-instruct');assert.deepEqual(body.format,schema);
 assert.equal(x.structuredContent.selector,'#v104-email');
});


test('real AI CLI rejects missing explicit scope, cross-origin or insecure scopes before browser effects',()=>{
 const cases=[
  {args:['run','--engine=stagehand','--url=https://example.com','--ai-model=qwen3:4b-instruct'],match:/AI_MODEL_AND_ORIGIN_REQUIRED/},
  {args:['run','--engine=auto','--url=https://example.com','--ai-model=qwen3:4b-instruct','--allow-origin=https://example.com'],match:/AI_REQUIRES_EXPLICIT_STAGEHAND_RUN/},
  {args:['run','--engine=stagehand','--url=https://example.com','--ai-model=qwen3:4b-instruct','--allow-origin=https://wrong.example'],match:/AI_NAVIGATION_ORIGIN_DENIED/},
  {args:['run','--engine=stagehand','--url=http://example.com','--ai-model=qwen3:4b-instruct','--allow-origin=http://example.com'],match:/AI_ORIGIN_REQUIRES_HTTPS_OR_LOOPBACK/}
 ];
 for(const {args,match} of cases){
  const {status,out}=call(args);
  assert.equal(status,1);
  assert.match(out.reason,match);
 }
});
test('observed selectors require a prior bounded model observation, fail before session start',()=>{
 const fs=fsModule,os=osModule;
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'v104-ai-selector-deny-'));
 const workflow=path.join(folder,'invalid.json');
 try{
  fs.writeFileSync(workflow,JSON.stringify([{action:'fill',selector:'@observed',text:'test'}]),{flag:'wx'});
  const {status,out}=call(['run','--engine=stagehand','--url=https://example.com',
   '--ai-model=qwen3:4b-instruct','--allow-origin=https://example.com','--steps='+workflow]);
  assert.equal(status,1);
  assert.match(out.reason,/OBSERVED_SELECTOR_NOT_READY/);
 }finally{fs.rmSync(folder,{recursive:true,force:true})}
});

test('only observe steps may carry bounded deterministic selector fallback',()=>{
 const fs=fsModule,os=osModule;
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'v104-ai-fallback-deny-'));
 const workflow=path.join(folder,'invalid.json');
 try{
  fs.writeFileSync(workflow,JSON.stringify([{action:'click',selector:'a',fallbackSelector:'a'}]),{flag:'wx'});
  const {status,out}=call(['run','--engine=stagehand','--url=https://example.com',
   '--ai-model=qwen3:4b-instruct','--allow-origin=https://example.com','--steps='+workflow]);
  assert.equal(status,1);
  assert.match(out.reason,/OBSERVE_FALLBACK_INVALID/);
 }finally{fs.rmSync(folder,{recursive:true,force:true})}
});
