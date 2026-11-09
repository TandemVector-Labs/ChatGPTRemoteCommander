#!/usr/bin/env node
// Integration acceptance: owned Chromium/CDP Browser Core with 12 synthetic ChatGPT tabs.
// No Brave add-on, Native Messaging, real account or ChatGPT network access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp,writeFile,chmod,readFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {createInterface} from 'node:readline';

const here=path.resolve(import.meta.dirname,'..');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=22000){
 const stop=Date.now()+timeout;
 while(Date.now()<stop){
  try{const v=await fn();if(v)return v;}catch{}
  await sleep(230);
 }
 throw Error('WAIT_TIMEOUT');
}
async function run(){
 const base=await mkdtemp(path.join(os.tmpdir(),'rc-owned-browser-12chat-'));
 const wrapper=path.join(base,'chromium-isolated');
 const profile=path.join(base,'owned-profile');
 const lines=[],waiters=[],errors=[];
 let proc=null;
 try{
  const binary=fs.existsSync('/usr/bin/google-chrome')?'/usr/bin/google-chrome':'/usr/bin/brave-browser';
  if(!fs.existsSync(binary))throw Error('OWNED_CHROMIUM_BINARY_MISSING');
  await writeFile(wrapper,'#!/bin/sh\nexec '+binary+' --disable-background-networking --disable-gpu --disable-dev-shm-usage --host-resolver-rules="MAP chatgpt.com ~NOTFOUND, MAP chat.openai.com ~NOTFOUND" "$@"\n',{mode:0o700});
  await chmod(wrapper,0o700);
  proc=spawn(process.execPath,[path.join(here,'tools/browser-control.mjs'),'--server'],
       {cwd:here,stdio:['pipe','pipe','pipe'],env:{...process.env,HOME:process.env.HOME}});
  const stdout=createInterface({input:proc.stdout,crlfDelay:Infinity});
  stdout.on('line',line=>{let v;try{v=JSON.parse(line)}catch{return};if(waiters.length)waiters.shift()(v);else lines.push(v)});
  proc.stderr.on('data',data=>{if(errors.join('').length<1500)errors.push(String(data).slice(0,500))});
  function recv(timeout=18000){
   if(lines.length)return Promise.resolve(lines.shift());
   return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('HELPER_RESPONSE_TIMEOUT')),timeout);
    waiters.push(v=>{clearTimeout(timer);resolve(v)});
   });
  }
  async function call(msg,timeout=20000){
   if(!proc||proc.exitCode!==null)throw Error('HELPER_NOT_RUNNING');
   proc.stdin.write(JSON.stringify(msg)+'\n');
   const v=await recv(timeout);
   if(!v.ok)throw Error('HELPER_ACTION_FAILED_'+String(v.error||'UNKNOWN'));
   return v;
  }
  assert.equal((await recv()).ready,true,'helper must be ready');
  const begun=await call({action:'start',profileDir:profile,isolated:true,executable:wrapper},30000);
  assert.equal(begun.headless,true);
  const tabs=[];
  for(let i=0;i<12;i++){
   const id='00000000-0000-4000-8000-'+String(i).padStart(12,'0');
   const opened=await call({action:'chat_tab_open',url:'https://chatgpt.com/c/'+id});
   assert.match(opened.tabRef,/^[a-f0-9]{32}$/);
   tabs.push(opened.tabRef);
  }
  await assert.rejects(()=>call({action:'chat_tab_open',url:'https://evil.test/'}),
    /BROWSER_CHAT_URL_NOT_ALLOWED/);
  await assert.rejects(()=>call({action:'relaunch',headless:false}),
    /BROWSER_MULTITAB_RELAUNCH_UNSUPPORTED/);
  const snapshot=await until(async()=>{
   const s=await call({action:'chat_tabs'});
   return s.ready===true&&s.counts?.OPEN===12&&s.conversations?.length===12?s:null;
  },28000);
  assert.equal(snapshot.source,'COMMANDER_OWNED_BROWSER_CORE');
  assert.equal(snapshot.cookiesRead,false);
  assert.equal(snapshot.chatAuthentication,'NOT_VERIFIED');
  assert.equal(snapshot.actionAuthorization,false);
  assert.equal(snapshot.urlContentsReturned,false);
  assert.equal(snapshot.observedTabs,12);
  assert.equal(snapshot.conversations.some(x=>x.localRef.includes('00000000')),false);
  const closed=await call({action:'chat_tab_close',tabRef:tabs[5]});
  assert.equal(closed.closed,true,'close exactly one owned tab');
  await assert.rejects(()=>call({action:'chat_tab_close',tabRef:tabs[5]}),
    /BROWSER_CHAT_TAB_NOT_OWNED/);
  const after=await until(async()=>{
    const s=await call({action:'chat_tabs'});
    return s.counts?.OPEN===11&&s.counts?.CLOSED===1?s:null;
  },18000);
  assert.equal(after.conversations.length,12);
  assert.equal(after.managedTabs.length,11);
  assert.equal(after.managedTabs.some(x=>x.tabRef===tabs[5]),false);
  for(let i=12;i<17;i++){
    const id='00000000-0000-4000-8000-'+String(i).padStart(12,'0');
    const opened=await call({action:'chat_tab_open',url:'https://chatgpt.com/c/'+id});
    assert.match(opened.tabRef,/^[a-f0-9]{32}$/);
  }
  const atLimit=await until(async()=>{
    const state=await call({action:'chat_tabs'});
    return state.counts?.OPEN===16&&state.managedTabs?.length===16?state:null;
  },16000);
  assert.equal(atLimit.counts.OPEN,16);
  await assert.rejects(()=>call({action:'chat_tab_open',url:'https://chatgpt.com/'}),
    /BROWSER_CHAT_TABS_LIMIT/);
  await call({action:'end'});
  console.log(JSON.stringify({result:'COMMANDER_NATIVE_CDP_MANAGED_12_TAB_E2E_PASS',
    beforeOpen:snapshot.counts.OPEN,afterOpen:after.counts.OPEN,closed:after.counts.CLOSED,maxManagedTabsVerified:atLimit.managedTabs.length,
    authenticatedChats:0,addonsUsed:0,primaryProfileTouched:false}));
 }finally{
  if(proc){
   try{proc.stdin.end()}catch{}
   await Promise.race([new Promise(r=>proc.once('close',r)),sleep(2500)]);
   if(proc.exitCode===null)proc.kill('SIGTERM');
   await Promise.race([new Promise(r=>proc.once('close',r)),sleep(2200)]);
   if(proc.exitCode===null)proc.kill('SIGKILL');
  }
  await rm(base,{recursive:true,force:true,maxRetries:4,retryDelay:150});
 }
}
run().catch(error=>{console.error('NATIVE_CDP_12TAB_E2E_FAILED:'+String(error.message).slice(0,320));process.exitCode=3});
