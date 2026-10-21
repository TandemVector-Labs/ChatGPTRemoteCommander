import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){
  const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=server.address().port;await new Promise(r=>server.close(r));return port;
}
async function rpc(port,id,method,params={}){
  const response=await fetch(`http://127.0.0.1:${port}/mcp`,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id,method,params})
  });
  const body=await response.json();
  assert.equal(response.status,200);
  if(body.error)throw new Error(body.error.message);
  return body.result;
}
async function call(port,id,name,args){
  const result=await rpc(port,id,'tools/call',{name,arguments:args});
  if(result.isError)throw new Error(result.content?.[0]?.text??'tool error');
  return result.structuredContent;
}

test('HTTP conversation continuation binds without opening a tab and queues terminal handoff safely',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-conversation-http-'));
  const serverRoot=path.join(root,'server'),dataRoot=path.join(root,'data'),toolsRoot=path.join(serverRoot,'tools');
  const stateRoot=path.join(root,'operations');
  const port=await freePort();let child;
  try{
    await fs.mkdir(serverRoot,{recursive:true});await fs.mkdir(dataRoot,{recursive:true});await fs.mkdir(toolsRoot,{recursive:true});
    const canonical=await fs.realpath(dataRoot);
    await fs.cp(new URL('../src/',import.meta.url),path.join(serverRoot,'src'),{recursive:true});
    await fs.copyFile(new URL('../tools/operation-worker.mjs',import.meta.url),path.join(toolsRoot,'operation-worker.mjs'));
    await fs.copyFile(new URL('../tools/conversation-uia.ps1',import.meta.url),path.join(toolsRoot,'conversation-uia.ps1'));
    const fixture=path.join(canonical,'fixture.mjs');
    await fs.copyFile(new URL('./async-operation-fixture.mjs',import.meta.url),fixture);
    const config={
      host:'127.0.0.1',port,allowedRoots:[canonical],allowedPrograms:['node'],
      maxReadBytes:1024*1024,maxWriteBytes:1024*1024,maxCommandMs:10000,auditLog:'var/audit.jsonl',
      asyncOperations:{enabled:true,backgroundFirst:true,stateDir:stateRoot,maxOutputBytes:65536},
      powerMode:{enabled:false,fullFilesystem:false,allowShell:false,allowProcessControl:false,allowPermanentDelete:false,
        guiControl:{enabled:false},browserControl:{enabled:false}}
    };
    const configPath=path.join(serverRoot,'config.json');await fs.writeFile(configPath,JSON.stringify(config,null,2));
    child=spawn(process.execPath,[path.join(serverRoot,'src','server-v0.3.mjs')],{
      cwd:serverRoot,env:{...process.env,REMOTE_COMMANDER_CONFIG:configPath},stdio:['ignore','pipe','pipe']
    });
    let stderr='';child.stderr.on('data',d=>{stderr+=d.toString('utf8');});
    // Busy Windows qualification runners can delay the copied test server.
    // Bound only fixture readiness; preserve the real health/exit check.
    const readinessDeadline=performance.now()+(process.platform==='win32'?45000:15000);
    let healthy=false;
    while(performance.now()<readinessDeadline){
      if(child.exitCode!==null)break;
      try{
        const r=await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(1500)});
        if(r.ok){healthy=true;break;}
      }catch{}
      await wait(25);
    }
    assert.equal(healthy,true,stderr||('server exit='+child.exitCode));

    const listed=await rpc(port,1,'tools/list',{});
    const names=listed.tools.map(x=>x.name);
    for(const name of ['conversation_bind','conversation_status','conversation_handoff','conversation_unbind'])assert.ok(names.includes(name),name);

    const tabTitle='__RC_NO_SUCH_CHAT_TAB_'+randomUUID()+'__';
    const binding=await call(port,2,'conversation_bind',{
      requestId:'bind-http-1',projectId:'p1',root:canonical,browser:'chrome',tabTitle
    });
    assert.equal(binding.projectId,'p1');
    assert.equal(binding.deliveryAvailable,false);
    assert.ok(['WAITING_FOR_CHAT_TAB','WINDOWS_UIA_REQUIRED','UIA_HELPER_TIMEOUT'].includes(binding.code),binding.code);

    const started=await call(port,3,'operation_start',{
      requestId:'op-http-1',tool:'run_project_command',
      arguments:{program:'node',args:[fixture,'sleep','120'],cwd:canonical,timeoutMs:5000},
      continuation:{projectId:'p1',eventKey:'http:op:1',root:canonical,phase:'test',summary:'test terminal event'}
    });
    assert.equal(started.continuationAttached,true);

    let handoff=null;
    for(let i=0;i<160;i++){
      const status=await call(port,100+i,'conversation_status',{projectId:'p1'});
      handoff=status.pending.find(x=>x.eventKey==='http:op:1:SUCCEEDED')??null;
      if(handoff)break;
      await wait(25);
    }
    assert.ok(handoff,'terminal continuation was not queued');
    assert.ok(['QUEUED','CLAIMED','DEFERRED'].includes(handoff.state),handoff.state);

    if(handoff.state==='DEFERRED'){
      const expected=process.platform==='win32'?'WAITING_FOR_CHAT_TAB':'WAITING_FOR_WINDOWS_CHAT_HOST';
      assert.equal(handoff.lastCode,expected);
    }
  }finally{
    if(child&&child.exitCode===null){child.kill();await Promise.race([once(child,'exit'),wait(2000)]);}
    await fs.rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});
