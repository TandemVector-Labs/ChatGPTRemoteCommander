import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const MODERN='2026-07-28';
const TASKS='io.modelcontextprotocol/tasks';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function freePort(){
  const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');
  const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p;
}
function meta(tasks=false){
  return {
    'io.modelcontextprotocol/protocolVersion':MODERN,
    'io.modelcontextprotocol/clientInfo':{name:'tasks-extension-test',version:'1'},
    'io.modelcontextprotocol/clientCapabilities':tasks?{extensions:{[TASKS]:{}}}:{}
  };
}
function headers(method,name){
  const h={'MCP-Protocol-Version':MODERN,'Mcp-Method':method};
  if(name!==undefined)h['Mcp-Name']=name;
  return h;
}
async function rpc(port,id,method,params,name,signal){
  const response=await fetch(`http://127.0.0.1:${port}/mcp`,{
    method:'POST',headers:{'content-type':'application/json',...headers(method,name)},
    body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal
  });
  return {status:response.status,body:await response.json()};
}

test('MCP Tasks extension maps durable Commander operations without changing fallback behavior',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-mcp-tasks-'));
  const serverRoot=path.join(root,'server'),dataRoot=path.join(root,'data'),toolsRoot=path.join(serverRoot,'tools');
  const stateRoot=path.join(root,'operations'),port=await freePort();
  let child;
  try{
    await fs.mkdir(dataRoot,{recursive:true});await fs.mkdir(toolsRoot,{recursive:true});
    const canonical=await fs.realpath(dataRoot);
    await fs.cp(new URL('../src/',import.meta.url),path.join(serverRoot,'src'),{recursive:true});
    await fs.copyFile(new URL('../tools/operation-worker.mjs',import.meta.url),path.join(toolsRoot,'operation-worker.mjs'));
    const fixture=path.join(canonical,'async-fixture.mjs');
    await fs.copyFile(new URL('./async-operation-fixture.mjs',import.meta.url),fixture);
    const config={host:'127.0.0.1',port,allowedRoots:[canonical],allowedPrograms:['node'],maxReadBytes:1048576,maxWriteBytes:1048576,maxCommandMs:10000,auditLog:'var/audit.jsonl',
      asyncOperations:{enabled:true,backgroundFirst:true,stateDir:stateRoot,maxOutputBytes:65536},
      powerMode:{enabled:false,fullFilesystem:false,allowShell:false,allowProcessControl:false,allowPermanentDelete:false,guiControl:{enabled:false},browserControl:{enabled:false}}};
    const configPath=path.join(serverRoot,'config.json');await fs.writeFile(configPath,JSON.stringify(config,null,2));
    child=spawn(process.execPath,[path.join(serverRoot,'src','server-v0.3.mjs')],{cwd:serverRoot,env:{...process.env,REMOTE_COMMANDER_CONFIG:configPath},stdio:['ignore','pipe','pipe']});
    let stderr='';child.stderr.on('data',c=>{stderr=(stderr+c.toString('utf8')).slice(-4096);});
    // Hosted Windows may delay fixture startup under unrelated CI process load.
    // Use the accepted bounded 30-second readiness window; this is not a
    // production MCP response or worker timeout. Detect early exit explicitly.
    let healthy=false;
    const startupDeadline=Date.now()+30000;
    while(Date.now()<startupDeadline){
      if(child.exitCode!==null||child.signalCode!==null)break;
      try{
        const r=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(300)});
        if(r.ok){healthy=true;break;}
      }catch{}
      await wait(50);
    }
    assert.equal(healthy,true,`MCP_TASKS_FIXTURE_HEALTH_NOT_READY_WITHIN_30000MS exitCode=${child.exitCode} signal=${child.signalCode}; stderr=${stderr}`);

    const discover=await rpc(port,1,'server/discover',{_meta:meta(true)},undefined);
    assert.equal(discover.status,200);
    assert.deepEqual(discover.body.result.capabilities.extensions[TASKS],{});

    const effect1=path.join(canonical,'fallback.txt');
    const fallback=await rpc(port,2,'tools/call',{name:'operation_start',arguments:{requestId:'fallback-1',tool:'run_project_command',arguments:{program:'node',args:[fixture,'effect',effect1,'50'],cwd:canonical,timeoutMs:5000}},_meta:meta(false)},'operation_start');
    assert.equal(fallback.body.result.resultType,'complete');
    assert.match(fallback.body.result.structuredContent.operationId,/^[a-f0-9-]{36}$/);

    const effect2=path.join(canonical,'task.txt');
    const started=await rpc(port,3,'tools/call',{name:'operation_start',arguments:{requestId:'task-1',tool:'run_project_command',arguments:{program:'node',args:[fixture,'effect',effect2,'300'],cwd:canonical,timeoutMs:5000}},_meta:meta(true)},'operation_start');
    assert.equal(started.status,200);
    assert.equal(started.body.result.resultType,'task');
    assert.equal(started.body.result.status,'working');
    const taskId=started.body.result.taskId;
    assert.match(taskId,/^[a-f0-9-]{36}$/);
    assert.equal(started.body.result.pollIntervalMs,5000);

    const missingCapability=await rpc(port,4,'tasks/get',{taskId,_meta:meta(false)},taskId);
    assert.equal(missingCapability.body.error.code,-32003);

    const wrongHeader=await rpc(port,5,'tasks/get',{taskId,_meta:meta(true)},'wrong-task');
    assert.equal(wrongHeader.status,400);
    assert.equal(wrongHeader.body.error.code,-32020);

    const unknownTaskId='00000000-0000-4000-8000-000000000000';
    const unknownGet=await rpc(port,7,'tasks/get',{taskId:unknownTaskId,_meta:meta(true)},unknownTaskId);
    assert.equal(unknownGet.body.error.code,-32602);
    const unknownUpdate=await rpc(port,8,'tasks/update',{taskId:unknownTaskId,inputResponses:{ignored:{value:true}},_meta:meta(true)},unknownTaskId);
    assert.equal(unknownUpdate.body.error.code,-32602);
    const unknownCancel=await rpc(port,9,'tasks/cancel',{taskId:unknownTaskId,_meta:meta(true)},unknownTaskId);
    assert.equal(unknownCancel.body.error.code,-32602);

    const update=await rpc(port,6,'tasks/update',{taskId,inputResponses:{ignored:{value:true}},_meta:meta(true)},taskId);
    assert.equal(update.body.result.resultType,'complete');

    let terminal=null;
    for(let i=0;i<80;i++){
      const polled=await rpc(port,10+i,'tasks/get',{taskId,_meta:meta(true)},taskId);
      assert.equal(polled.body.result.resultType,'complete');
      if(polled.body.result.status==='completed'){terminal=polled.body.result;break;}
      assert.equal(polled.body.result.status,'working');
      await wait(50);
    }
    assert.ok(terminal,'task did not complete');
    assert.equal(terminal.result.structuredContent.state.status,'SUCCEEDED');
    assert.equal(await fs.readFile(effect2,'utf8'),'x');

    const effect3=path.join(canonical,'follow.txt');
    const followStart=await rpc(port,100,'tools/call',{name:'operation_start',arguments:{requestId:'follow-1',tool:'run_project_command',arguments:{program:'node',args:[fixture,'effect',effect3,'250'],cwd:canonical,timeoutMs:5000}},_meta:meta(false)},'operation_start');
    const followId=followStart.body.result.structuredContent.operationId;
    const before=Date.now();
    let followed=await rpc(port,101,'tools/call',{name:'operation_status',arguments:{operationId:followId,waitMs:1500},_meta:meta(false)},'operation_status',AbortSignal.timeout(4500));
    const elapsed=Date.now()-before;
    assert.ok(['RUNNING','SUCCEEDED'].includes(followed.body.result.structuredContent.status));
    assert.ok(elapsed<4500 && (elapsed>=100 || followed.body.result.structuredContent.status==='SUCCEEDED'),`bounded follow elapsed=${elapsed}`);
    for(let i=0;followed.body.result.structuredContent.status!=='SUCCEEDED'&&i<120;i++){
      await wait(50);
      followed=await rpc(port,102+i,'tools/call',{name:'operation_status',arguments:{operationId:followId,waitMs:0},_meta:meta(false)},'operation_status');
    }
    assert.equal(followed.body.result.structuredContent.status,'SUCCEEDED');

    const effect4=path.join(canonical,'cancel.txt');
    const cancelStart=await rpc(port,110,'tools/call',{name:'operation_start',arguments:{requestId:'cancel-task-1',tool:'run_project_command',arguments:{program:'node',args:[fixture,'effect',effect4,'3000'],cwd:canonical,timeoutMs:5000}},_meta:meta(true)},'operation_start');
    const cancelId=cancelStart.body.result.taskId;
    const cancel=await rpc(port,111,'tasks/cancel',{taskId:cancelId,_meta:meta(true)},cancelId);
    assert.equal(cancel.body.result.resultType,'complete');
    for(let i=0;i<100;i++){
      const afterCancel=await rpc(port,120+i,'tasks/get',{taskId:cancelId,_meta:meta(true)},cancelId);
      if(['cancelled','completed'].includes(afterCancel.body.result.status))break;
      await wait(50);
    }
    await wait(100);
  }finally{
    if(child&&child.exitCode===null){
      child.kill();
      await Promise.race([once(child,'exit'),wait(2000)]);
      if(child.exitCode===null){
        child.kill('SIGKILL');
        await Promise.race([once(child,'exit'),wait(2000)]);
      }
    }
    await fs.rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});
  }
});
