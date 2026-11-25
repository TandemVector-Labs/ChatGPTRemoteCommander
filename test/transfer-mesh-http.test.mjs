import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function port(){const l=net.createServer();l.listen(0,'127.0.0.1');await once(l,'listening');const p=l.address().port;await new Promise(r=>l.close(r));return p;}
async function req(p,name,args={},id=1){const res=await fetch('http://127.0.0.1:'+p+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method:name==='__list'?'tools/list':'tools/call',params:name==='__list'?{}:{name,arguments:args}})});const body=await res.json();assert.equal(res.status,200);return body.result;}
test('privileged MCP transfer tools reject anonymous and forged transport before any send',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'ctmesh-native-http-'));
 const server=path.join(home,'server'),input=path.join(home,'inputs'),received=path.join(home,'received'),pilot=path.join(home,'pilot');
 const serverPort=await port();
 let child,stderr='';
 try{
  await fs.mkdir(server);await fs.mkdir(input);await fs.mkdir(received);await fs.mkdir(pilot);
  await fs.cp(new URL('../src/',import.meta.url),path.join(server,'src'),{recursive:true});
  await fs.copyFile(new URL('../tools/commander-transfer-mesh/pilot-cli.mjs',import.meta.url),path.join(pilot,'transfer.mjs'));
  await fs.copyFile(new URL('../tools/commander-transfer-mesh/durable-send.mjs',import.meta.url),path.join(pilot,'durable-send.mjs'));
  await fs.writeFile(path.join(pilot,'node.json'),JSON.stringify({alias:'PC',schema:'ctmesh-node-v1'}));
  const dataRoot=path.join(home,'data');await fs.mkdir(dataRoot);
  const cfg={host:'127.0.0.1',port:serverPort,deviceName:'transfer-mesh-http-test',instance:{profile:'transfer-mesh-http-test',isolated:true},allowedRoots:[dataRoot],allowedPrograms:['node'],maxReadBytes:1048576,maxWriteBytes:1048576,maxCommandMs:10000,
   auditLog:'var/audit.jsonl',durableDelivery:{directory:path.join(home,'delivery')},
   powerMode:{enabled:true,fullFilesystem:false,allowShell:false,allowProcessControl:false,allowPermanentDelete:false,backupRoot:path.join(home,'backups'),maxFileBytes:1048576,maxCommandMs:10000,maxOutputBytes:1048576,maxTerminalBufferBytes:1048576,blockedShellPatterns:[],guiControl:{enabled:false}},
   transferMesh:{enabled:true,durableEnabled:true,root:pilot,sourceRoots:[input],destinationRoots:[received]}};
  const configPath=path.join(server,'config.json');
  await fs.writeFile(configPath,JSON.stringify(cfg));
  child=spawn(process.execPath,[path.join(server,'src/server-v0.3.mjs')],{cwd:server,env:{...process.env,REMOTE_COMMANDER_CONFIG:configPath},stdio:['ignore','pipe','pipe']});
  child.stderr.on('data',x=>{stderr=(stderr+Buffer.from(x).toString('utf8')).slice(-8000);});
  let healthy=false,lastHealthError='not_attempted';
  const startupDeadline=Date.now()+30000;
  while(Date.now()<startupDeadline){
    if(child.exitCode!==null||child.signalCode!==null)throw new Error(`transfer-mesh fixture exited before health: exitCode=${child.exitCode}; signal=${child.signalCode}; stderr=${stderr}`);
    try{
      const response=await fetch('http://127.0.0.1:'+serverPort+'/health',{signal:AbortSignal.timeout(300)});
      if(response.ok){healthy=true;break;}
      lastHealthError='HTTP_'+response.status;
    }catch(error){lastHealthError=String(error?.cause?.code??error?.name??error).slice(0,160);}
    await wait(50);
  }
  assert.equal(healthy,true,`transfer-mesh fixture did not become healthy within 30000ms; last=${lastHealthError}; stderr=${stderr}`);
  assert.equal(child.exitCode,null,'transfer-mesh fixture exited after health readiness');
  const health=await (await fetch('http://127.0.0.1:'+serverPort+'/health',{signal:AbortSignal.timeout(1000)})).json();
  assert.equal(health.version,'0.12.0-dev.9');
  assert.equal(health.instance.profile,'transfer-mesh-http-test');
  assert.equal(health.instance.isolated,true);
  assert.equal(health.privilegedLegacyHttpQuarantined,true);
  const file=path.join(input,'fixture.txt');await fs.writeFile(file,'transfer suite hello');
  const blocked=[
    {method:'tools/list',params:{}},
    {method:'tools/call',params:{name:'transfer_mesh_info',arguments:{}}},
    {method:'tools/call',params:{name:'transfer_mesh_send',arguments:{
      peer:'Linux',path:file,id:'http-denied-001',requestId:'http-denied-transfer-001'
    }}},
    {method:'tools/call',params:{name:'transfer_mesh_enqueue',arguments:{
      peer:'Linux',path:file,id:'http-denied-002',requestId:'http-denied-transfer-002'
    }}}
  ];
  for(const headers of [
    {'Content-Type':'application/json'},
    {'Content-Type':'application/json',authorization:'Bearer forged','x-chat-id':'forged'}
  ]){
    for(const [index,request] of blocked.entries()){
      const response=await fetch('http://127.0.0.1:'+serverPort+'/mcp',{
        method:'POST',headers,
        body:JSON.stringify({jsonrpc:'2.0',id:index+1,...request})
      });
      assert.equal(response.status,403);
      assert.deepEqual(await response.json(),{error:'trusted_transport_required'});
    }
  }
  await assert.rejects(fs.access(path.join(pilot,'pairs','Linux','transfers','http-denied-001','payload.bin')));
  await assert.rejects(fs.access(path.join(pilot,'pairs','Linux','transfers','http-denied-002','payload.bin')));
 }finally{
  if(child){child.kill();await Promise.race([once(child,'exit').catch(()=>{}),wait(1500)]);}
  await fs.rm(home,{recursive:true,force:true});
 }
});
