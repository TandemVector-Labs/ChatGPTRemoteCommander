import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// A live Windows runner can take longer than 5s to initialize the isolated
// server under concurrent test load. Use a monotonic 20s deadline, per-probe
// timeout, and fail early if the child exits. No production health gate changes.
async function waitForHealth(port,child,{now=()=>performance.now(),sleep=wait,request=fetch,timeoutMs=20_000,retryMs=50}={}){
 const deadline=now()+timeoutMs;
 let attempts=0;
 while(now()<deadline){
  if(child.exitCode!==null || child.signalCode!==null)
   return {ready:false,reason:'CHILD_EXITED',attempts};
  const remaining=deadline-now();
  if(remaining<=0)break;
  try{
   const result=await request('http://127.0.0.1:'+port+'/health',
    {signal:AbortSignal.timeout(Math.max(1,Math.min(1500,Math.ceil(remaining))))});
   attempts++;
   if(result.ok)return {ready:true,attempts};
  }catch{attempts++;}
  const next=deadline-now();
  if(next<=0)break;
  await sleep(Math.min(retryMs,next));
 }
 return {ready:false,reason:'STARTUP_DEADLINE_EXCEEDED',attempts};
}
test('bounded transfer HTTP readiness tolerates slow startup but stops on deadline or child exit',async()=>{
 const child={exitCode:null,signalCode:null};
 let probes=0, clock=0;
 const ready=await waitForHealth(8080,child,{
  now:()=>clock,sleep:async ms=>{clock+=ms;},
  request:async()=>({ok:++probes===5}),timeoutMs:300,retryMs:50,
 });
 assert.deepEqual(ready,{ready:true,attempts:5});
 assert.equal(clock,200);
 const exhausted=await waitForHealth(8080,child,{
  now:()=>clock,sleep:async ms=>{clock+=ms;},
  request:async()=>{throw Error('connection refused');},timeoutMs:120,retryMs:50,
 });
 assert.deepEqual(exhausted,{ready:false,reason:'STARTUP_DEADLINE_EXCEEDED',attempts:3});
 const dead={exitCode:1,signalCode:null};
 const stopped=await waitForHealth(8080,dead,{request:()=>{throw Error('not allowed');}});
 assert.deepEqual(stopped,{ready:false,reason:'CHILD_EXITED',attempts:0});
});

async function port(){const l=net.createServer();l.listen(0,'127.0.0.1');await once(l,'listening');const p=l.address().port;await new Promise(r=>l.close(r));return p;}
async function req(p,name,args={},id=1){const res=await fetch('http://127.0.0.1:'+p+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method:name==='__list'?'tools/list':'tools/call',params:name==='__list'?{}:{name,arguments:args}})});const body=await res.json();assert.equal(res.status,200);return body.result;}
test('MCP native transfer tools opt in, expose narrowly scoped schemas and execute authentic local send',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'ctmesh-native-http-'));
 const server=path.join(home,'server'),input=path.join(home,'inputs'),received=path.join(home,'received'),pilot=path.join(home,'pilot');
 const serverPort=await port();
 let child,stderr='';
 try{
  await fs.mkdir(server);await fs.mkdir(input);await fs.mkdir(received);await fs.mkdir(pilot,{mode:0o700});
  await fs.cp(new URL('../src/',import.meta.url),path.join(server,'src'),{recursive:true});
  await fs.copyFile(new URL('../tools/commander-transfer-mesh/pilot-cli.mjs',import.meta.url),path.join(pilot,'transfer.mjs'));
  await fs.copyFile(new URL('../tools/commander-transfer-mesh/durable-send.mjs',import.meta.url),path.join(pilot,'durable-send.mjs'));
  await fs.writeFile(path.join(pilot,'node.json'),JSON.stringify({alias:'PC',schema:'ctmesh-node-v1'}));
  const dataRoot=path.join(home,'data');await fs.mkdir(dataRoot);
  const cfg={host:'127.0.0.1',port:serverPort,allowedRoots:[dataRoot],allowedPrograms:['node'],maxReadBytes:1048576,maxWriteBytes:1048576,maxCommandMs:10000,
   auditLog:'var/audit.jsonl',durableDelivery:{directory:path.join(home,'delivery')},
   powerMode:{enabled:true,fullFilesystem:false,allowShell:false,allowProcessControl:false,allowPermanentDelete:false,backupRoot:path.join(home,'backups'),maxFileBytes:1048576,maxCommandMs:10000,maxOutputBytes:1048576,maxTerminalBufferBytes:1048576,blockedShellPatterns:[],guiControl:{enabled:false}},
   transferMesh:{enabled:true,durableEnabled:true,root:pilot,sourceRoots:[input],destinationRoots:[received]}};
  const configPath=path.join(server,'config.json');
  await fs.writeFile(configPath,JSON.stringify(cfg));
  child=spawn(process.execPath,[path.join(server,'src/server-v0.3.mjs')],{cwd:server,env:{...process.env,REMOTE_COMMANDER_CONFIG:configPath},stdio:['ignore','pipe','pipe']});
  child.stderr.on('data',x=>stderr+=x);
  const startup=await waitForHealth(serverPort,child);
  assert.equal(startup.ready,true,
   'transfer mesh fixture '+(startup.reason??'not ready')+
   ' after '+startup.attempts+' probes; stderr tail: '+stderr.slice(-1600));
  const list=await req(serverPort,'__list');const defs=list.tools.filter(x=>x.name.startsWith('transfer_mesh_'));
  assert.equal(defs.length,8);
  assert.equal(defs.find(x=>x.name==='transfer_mesh_send').annotations.readOnlyHint,false);
  const info=await req(serverPort,'transfer_mesh_info');
  assert.equal(info.isError,false);
  const testFile=path.join(input,'fixture.txt');await fs.writeFile(testFile,'transfer suite hello');
  const denied=await req(serverPort,'transfer_mesh_send',{peer:'Linux',path:path.join(home,'config.json'),id:'http-no-001',requestId:'fixed-http-deny-001'});
  assert.equal(denied.isError,true);
  assert.match(JSON.stringify(denied),/TRANSFER_PATH_NOT_ALLOWED|ENOENT/);
  const sent=await req(serverPort,'transfer_mesh_send',{peer:'Linux',path:testFile,id:'http-good-001',requestId:'fixed-http-send-001'});
  assert.equal(sent.isError,false,JSON.stringify(sent));
  assert.equal((await fs.stat(path.join(pilot,'pairs','Linux','transfers','http-good-001','payload.bin'))).isFile(),true);
  const replay=await req(serverPort,'transfer_mesh_send',{peer:'Linux',path:testFile,id:'http-good-001',requestId:'fixed-http-send-001'});
  assert.equal(replay.isError,false,JSON.stringify(replay));
  const conflict=await req(serverPort,'transfer_mesh_send',{peer:'Linux',path:testFile,id:'http-good-001',requestId:'different-http-send-002'});
  assert.equal(conflict.isError,true);
  const large=path.join(input,'long-file.dat');await fs.writeFile(large,Buffer.alloc(12*1024*1024,0x63));
  const queued=await req(serverPort,'transfer_mesh_enqueue',{peer:'Linux',path:large,id:'http-durable-001',requestId:'fixed-http-durable-001'});
  assert.equal(queued.isError,false,JSON.stringify(queued));
  let progress=null;
  for(let i=0;i<100;i++){
    progress=await req(serverPort,'transfer_mesh_job_status',{peer:'Linux',id:'http-durable-001'});
    if(JSON.stringify(progress).includes('"PUBLISHED"'))break;
    await wait(70);
  }
  assert.equal(progress.isError,false,JSON.stringify(progress));
  assert.match(JSON.stringify(progress),/"PUBLISHED"/);
  assert.equal((await fs.stat(path.join(pilot,'pairs','Linux','transfers','http-durable-001','payload.bin'))).size,12*1024*1024);
  await wait(350);
 }finally{
  if(child){child.kill();await Promise.race([once(child,'exit').catch(()=>{}),wait(1500)]);}
  await fs.rm(home,{recursive:true,force:true});
 }
});
