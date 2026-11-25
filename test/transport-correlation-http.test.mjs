import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { probeWindowsAdministrator } from '../src/windows-admin-token.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){
  const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');
  const port=s.address().port;await new Promise(resolve=>s.close(resolve));return port;
}
async function startServer(serverRoot,configPath,fixturePort){
  if (!Number.isSafeInteger(fixturePort) || fixturePort < 1 || fixturePort > 65535)
    throw new Error('HTTP_FIXTURE_PORT_INVALID');
  const healthUrl = 'http://127.0.0.1:' + fixturePort + '/health';
  const child=spawn(process.execPath,[path.join(serverRoot,'src','server-v0.3.mjs')],{
    cwd:serverRoot,env:{...process.env,REMOTE_COMMANDER_CONFIG:configPath},stdio:['ignore','pipe','pipe']
  });
  let stderr='';child.stderr.on('data',c=>{stderr+=c.toString('utf8');});

  const startupDeadline=Date.now()+30000;
  while(Date.now()<startupDeadline){
    if(child.exitCode!==null)throw new Error(`server exited before healthy: exitCode=${child.exitCode}; stderr=${stderr}`);
    try{const r=await fetch(healthUrl);if(r.ok)return {child,stderr:()=>stderr};}catch{}
    await wait(25);
  }
  child.kill();throw new Error(`server did not become healthy within 30000ms: stderr=${stderr}`);
}
async function stop(child){if(child&&child.exitCode===null){child.kill();await Promise.race([once(child,'exit'),wait(2000)]);}}

test('accepted tool audit maps forwarded transport request ID to durable correlation identity without raw arguments',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-transport-correlation-'));
  const serverRoot=path.join(root,'server'),dataRoot=path.join(root,'data'),deliveryRoot=path.join(root,'delivery');
  let running;
  try{
    await fs.mkdir(serverRoot,{recursive:true});await fs.mkdir(dataRoot,{recursive:true});
    await fs.cp(new URL('../src/',import.meta.url),path.join(serverRoot,'src'),{recursive:true});
    const canonical=await fs.realpath(dataRoot);
    const target=path.join(canonical,'trace.txt');
    const port=await freePort();
    const config={
      host:'127.0.0.1',port,allowedRoots:[canonical],allowedPrograms:['node'],
      maxReadBytes:1024*1024,maxWriteBytes:1024*1024,maxCommandMs:300000,
      auditLog:'var/audit.jsonl',durableDelivery:{directory:deliveryRoot},
      asyncOperations:{enabled:false},
      capabilityProfile:{tier:'STANDARD'},
      capabilityProfile:{tier:'STANDARD'},
      powerMode:{enabled:false,fullFilesystem:false,allowShell:false,allowProcessControl:false,allowPermanentDelete:false,
        guiControl:{enabled:false},browserControl:{enabled:false}}
    };
    const configPath=path.join(serverRoot,'config.json');
    await fs.writeFile(configPath,JSON.stringify(config,null,2));
    running=await startServer(serverRoot,configPath,port);

    const secret='RAW_CONTENT_MUST_NOT_ENTER_TOOL_ACCEPT';
    const authMarker='audit-must-not-store-this';
    const authorization=['Be','arer ',authMarker].join('');
    const transportRequestId='cp-request-123';
    const requestId='corr-request-1';
    const response=await fetch(`http://127.0.0.1:${port}/mcp`,{
      method:'POST',
      headers:{'content-type':'application/json','x-request-id':transportRequestId,'authorization':authorization},
      body:JSON.stringify({jsonrpc:'2.0',id:'rpc-42',method:'tools/call',params:{name:'write_text',arguments:{requestId,path:target,content:secret,mode:'overwrite'}}})
    });
    const body=await response.json();
    // Hosted Windows Actions can run an elevated token. The unauthenticated
    // loopback dispatcher must then reject writes regardless of forged headers.
    const nativeToken=process.platform==='win32'
      ? await probeWindowsAdministrator() : null;
    if(process.platform==='win32' &&
       !(nativeToken?.ok===true && nativeToken.isAdmin===false &&
         nativeToken.isSystem===false && nativeToken.elevation==='standard')){
      const health=await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      assert.equal(health.privilegedLegacyHttpQuarantined,true);
      assert.equal(response.status,403);
      assert.deepEqual(body,{error:'trusted_transport_required'});
      await assert.rejects(fs.access(target));
      const auditPath=path.join(serverRoot,'var','audit.jsonl');
      try{
        const auditText=await fs.readFile(auditPath,'utf8');
        assert.equal(auditText.includes('tool_accept'),false,'no audit should record an accepted write');
        assert.equal(auditText.includes(secret),false);
        assert.equal(auditText.includes(authMarker),false);
      }catch(error){if(error.code!=='ENOENT')throw error;}
      return t.skip('elevated/unverified Windows token: safe 403 verified; positive requires non-admin process');
    }
    assert.equal(response.status,200);
    assert.equal(body.result.isError,false);
    assert.equal(await fs.readFile(target,'utf8'),secret);

    const auditPath=path.join(serverRoot,'var','audit.jsonl');
    const rows=(await fs.readFile(auditPath,'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const accepted=rows.find(row=>row.action==='tool_accept'&&row.requestId===requestId);
    assert.ok(accepted,'tool_accept audit record missing');
    assert.deepEqual({
      action:accepted.action,ok:accepted.ok,tool:accepted.tool,
      transportRequestId:accepted.transportRequestId,rpcRequestId:accepted.rpcRequestId,
      requestId:accepted.requestId,correlationId:accepted.correlationId
    },{
      action:'tool_accept',ok:true,tool:'write_text',
      transportRequestId,rpcRequestId:'rpc-42',requestId,correlationId:requestId
    });
    const encoded=JSON.stringify(accepted);
    assert.equal(encoded.includes(secret),false,'tool_accept leaked raw content');
    assert.equal(encoded.includes(target),false,'tool_accept leaked raw path');
    assert.equal(encoded.includes(authMarker),false,'tool_accept leaked Authorization');
  }finally{
    if(running)await stop(running.child);
    await fs.rm(root,{recursive:true,force:true});
  }
});


// Durable transport retry behavior remains tested through the trusted operation manager
// in test/async-operations.test.mjs. The legacy FULL_POWER HTTP listener must not
// admit those actions without independently authenticated V2 ingress.
test('legacy FULL_POWER HTTP cannot mint transport retries, execute file mutations or claim delivery',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-transport-denied-'));
  const serverRoot=path.join(root,'server'),dataRoot=path.join(root,'data');
  let running;
  try{
    await fs.mkdir(serverRoot,{recursive:true});
    await fs.mkdir(dataRoot,{recursive:true});
    await fs.cp(new URL('../src/',import.meta.url),path.join(serverRoot,'src'),{recursive:true});
    // This HTTP quarantine fixture only needs the durable worker script.
    // Do not traverse unrelated installer-private files under tools/:
    // a root-owned installed tunnel/license artifact may be intentionally 0600.
    await fs.mkdir(path.join(serverRoot,'tools'),{recursive:true});
    await fs.copyFile(new URL('../tools/operation-worker.mjs',import.meta.url),
      path.join(serverRoot,'tools','operation-worker.mjs'));
    const canonical=await fs.realpath(dataRoot);
    const source=path.join(canonical,'source.txt');
    const destination=path.join(canonical,'copy.txt');
    await fs.writeFile(source,'payload');
    const port=await freePort();
    const config={
      host:'127.0.0.1',port,allowedRoots:[canonical],allowedPrograms:['node'],
      maxReadBytes:1024*1024,maxWriteBytes:1024*1024,maxCommandMs:300000,
      auditLog:path.join(root,'audit.jsonl'),durableDelivery:{directory:path.join(root,'delivery')},
      asyncOperations:{enabled:true,stateDir:path.join(root,'ops')},
      powerMode:{enabled:true,fullFilesystem:false,allowShell:false,allowProcessControl:false,
        allowPermanentDelete:false,guiControl:{enabled:false},browserControl:{enabled:false}},
      capabilityProfile:{tier:'FULL_POWER',explicitlyAuthorized:true}
    };
    const configPath=path.join(serverRoot,'config.json');
    await fs.writeFile(configPath,JSON.stringify(config,null,2));
    running=await startServer(serverRoot,configPath,port);
    const health=await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.privilegedLegacyHttpQuarantined,true);
    for(const [method,params] of [
      ['tools/list',{}],
      ['tools/call',{name:'copy_path',arguments:{source,destination}}],
      ['tools/call',{name:'delivery_status',arguments:{}}],
      ['tools/call',{name:'operation_status',arguments:{operationId:'00000000-0000-4000-8000-000000000000'}}]
    ]){
      for(const headers of [
        {'content-type':'application/json'},
        {'content-type':'application/json','x-request-id':'transport-copy-http-1',
         authorization:'Bearer forged','x-chat-id':'forged'}
      ]){
        const response=await fetch(`http://127.0.0.1:${port}/mcp`,{
          method:'POST',headers,
          body:JSON.stringify({jsonrpc:'2.0',id:100,method,params})
        });
        assert.equal(response.status,403,method);
        assert.deepEqual(await response.json(),{error:'trusted_transport_required'});
      }
    }
    await assert.rejects(fs.access(destination));
    assert.equal(await fs.readFile(source,'utf8'),'payload');
    await stop(running.child);running=null;
    running=await startServer(serverRoot,configPath,port);
    const afterRestart=await fetch(`http://127.0.0.1:${port}/mcp`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:101,method:'tools/call',
        params:{name:'copy_path',arguments:{source,destination}}})
    });
    assert.equal(afterRestart.status,403);
    await assert.rejects(fs.access(destination));
  }finally{
    if(running)await stop(running.child);
    await fs.rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});
  }
});

test('test-only health probe refuses invalid port before any fixture config read', async () => {
  await assert.rejects(
    startServer('not-a-server', 'not-a-fixture-config.json', 0),
    /HTTP_FIXTURE_PORT_INVALID/
  );
});