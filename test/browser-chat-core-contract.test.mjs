import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createBrowserController} from '../src/browser-tools.mjs';
import {BROWSER_RULES,validateBrowserInput} from '../src/browser-contract.mjs';

test('native Chat observer is a built-in lease-bound Browser Core read-only tool',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-native-chat-core-'));
 try{
  const calls=[];
  const controller=createBrowserController({invoke:async req=>{
   calls.push(req.action);
   if(req.action==='start')return {ok:true,browserProduct:'Chrome/154',backend:'chromium-cdp'};
   if(req.action==='chat_tabs')return {ok:true,source:'COMMANDER_OWNED_BROWSER_CORE',ready:true,
     chatAuthentication:'NOT_VERIFIED',actionAuthorization:false,
     cookiesRead:false,domRead:false,urlContentsReturned:false,conversations:[]};
   if(req.action==='end')return {ok:true,closed:true};
   if(req.action==='status')return {ok:true,available:true,backend:'chromium-cdp'};
   throw Error('UNEXPECTED_'+req.action);
  },token:()=> 'b'.repeat(48)});
  const ctx={config:{instance:{profile:'native_pilot'},powerMode:{
   enabled:true,browserControl:{enabled:true,profileRoot:root,allowNavigate:true,allowInput:false,
     allowScreenshot:false,allowForegroundFallback:false}}}};
  assert.ok(BROWSER_RULES.has('browser_chat_tabs'));
  assert.equal(BROWSER_RULES.get('browser_chat_tabs').annotations.readOnlyHint,true);
  await assert.rejects(controller.execute(ctx,'browser_chat_tabs',{}),/BROWSER_INVALID_ARGUMENTS/);
  await assert.rejects(controller.execute(ctx,'browser_chat_tabs',{lease:'bad'}),/BROWSER_LEASE_REQUIRED_OR_EXPIRED/);
  const lease=await controller.execute(ctx,'browser_session_begin',{mode:'isolated'});
  const snapshot=await controller.execute(ctx,'browser_chat_tabs',{lease:lease.lease});
  assert.equal(snapshot.source,'COMMANDER_OWNED_BROWSER_CORE');
  assert.equal(snapshot.actionAuthorization,false);
  assert.equal(snapshot.userDesktopTouched,false);
  assert.ok(calls.includes('chat_tabs'));
  await controller.execute(ctx,'browser_session_end',{lease:lease.lease});
  await assert.rejects(controller.execute(ctx,'browser_chat_tabs',{lease:lease.lease}),/BROWSER_LEASE_REQUIRED_OR_EXPIRED/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('native observer input forbids uncontrolled executable/URL/options',()=>{
 assert.deepEqual(validateBrowserInput('browser_chat_tabs',{lease:'l'}),{lease:'l'});
 for(const input of [{},{lease:'x',url:'https://chatgpt.com/'},{lease:'x',command:'sh'},{lease:23}]){
  assert.throws(()=>validateBrowserInput('browser_chat_tabs',input),/BROWSER_INVALID_ARGUMENTS/);
 }
});
