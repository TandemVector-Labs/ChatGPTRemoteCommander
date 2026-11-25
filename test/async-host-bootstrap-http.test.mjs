import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function availablePort(){
  const socket=net.createServer();
  socket.listen(0,'127.0.0.1');
  await once(socket,'listening');
  const port=socket.address().port;
  await new Promise(resolve=>socket.close(resolve));
  return port;
}

async function isolatedServer(requireHostSignedOrigin,{tier='STANDARD',requireTrustedIngress=false,legacyPowerModeEnabled=false}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'v106-host-bootstrap-'));
  let child=null;
  try{
    const serverRoot=path.join(root,'server');
    const dataRoot=path.join(root,'data');
    await fs.mkdir(serverRoot,{recursive:true});
    await fs.mkdir(dataRoot,{recursive:true});
    await fs.cp(new URL('../src/',import.meta.url),path.join(serverRoot,'src'),{recursive:true});
    const port=await availablePort();
    const config={
      capabilityProfile:{tier},requireTrustedIngress,
      host:'127.0.0.1',port,allowedRoots:[await fs.realpath(dataRoot)],
      allowedPrograms:['node'],maxReadBytes:65536,maxWriteBytes:65536,
      maxCommandMs:10000,auditLog:'var/audit.jsonl',
      durableDelivery:{directory:path.join(root,'delivery')},
      asyncOperations:{
        enabled:true,stateDir:path.join(root,'operations'),
        maxOutputBytes:65536,requireHostSignedOrigin
      },
      powerMode:{enabled:legacyPowerModeEnabled,fullFilesystem:false,allowShell:false,
        allowProcessControl:false,allowPermanentDelete:false,
        guiControl:{enabled:false},browserControl:{enabled:false}}
    };
    const configPath=path.join(serverRoot,'config.json');
    await fs.writeFile(configPath,JSON.stringify(config,null,2));
    child=spawn(process.execPath,[path.join(serverRoot,'src','server-v0.3.mjs')],{
      cwd:serverRoot,
      env:{...process.env,REMOTE_COMMANDER_CONFIG:configPath},
      stdio:['ignore','pipe','pipe']
    });
    let stderr='';
    child.stderr.on('data',data=>{stderr+=data.toString('utf8');});
    return {root,child,port,stderr:()=>stderr};
  }catch(error){
    if(child&&child.exitCode===null)child.kill();
    await fs.rm(root,{recursive:true,force:true});
    throw error;
  }
}

async function stop(fixture){
  if(fixture.child.exitCode===null && !fixture.child.killed){
    fixture.child.kill();
    await Promise.race([once(fixture.child,'exit'),sleep(3000)]);
  }
  await fs.rm(fixture.root,{recursive:true,force:true,maxRetries:10,retryDelay:50});
}

async function boundedExit(child){
  if(child.exitCode!==null)return {code:child.exitCode};
  let deadline;
  return Promise.race([
    once(child,'exit').then(([code])=>({code})),
    new Promise(resolve=>{deadline=setTimeout(()=>resolve({timeout:true}),10000);})
  ]).finally(()=>clearTimeout(deadline));
}

test('real MCP bootstrap refuses signed-origin-required mode without an independent Host issuer',async()=>{
  const f=await isolatedServer(true);
  try{
    const terminated=await boundedExit(f.child);
    assert.equal(terminated.timeout,undefined,'protected bootstrap must exit instead of waiting');
    assert.notEqual(terminated.code,0,'a missing Host issuer must not start an MCP listener');
    assert.match(f.stderr(),/ASYNC_DELIVERY_SIGNED_ORIGIN_HOST_REQUIRED/);
    await assert.rejects(
      fetch(`http://127.0.0.1:${f.port}/health`,{signal:AbortSignal.timeout(1000)}),
      /fetch failed|ECONNREFUSED|ETIMEDOUT|AbortError/i
    );
    // A rejected startup may create a private store, but no operation is admitted.
    await assert.rejects(fs.access(path.join(f.root,'operations','requests')));
  }finally{await stop(f);}
});

test('malformed signed-origin policy cannot silently downgrade an MCP listener',async()=>{
  for(const value of ['true',1,null]){
    const f=await isolatedServer(value);
    try{
      const terminated=await boundedExit(f.child);
      assert.equal(terminated.timeout,undefined,
        'invalid policy must not leave the protected server running');
      assert.notEqual(terminated.code,0,'invalid policy accepted: '+String(value));
      assert.match(f.stderr(),/ASYNC_DELIVERY_SIGNED_ORIGIN_POLICY_INVALID/);
      await assert.rejects(
        fetch(`http://127.0.0.1:${f.port}/health`,{signal:AbortSignal.timeout(1000)}),
        /fetch failed|ECONNREFUSED|ETIMEDOUT|AbortError/i
      );
    }finally{await stop(f);}
  }
});

test('legacy MCP bootstrap discloses unverified origin and cannot claim ChatGPT ACK',async()=>{
  const f=await isolatedServer(false);
  try{
    let healthy=false;
    for(let i=0;i<400;i++){
      if(f.child.exitCode!==null)break;
      try{
        const r=await fetch(`http://127.0.0.1:${f.port}/health`);
        if(r.ok){healthy=true;break;}
      }catch{}
      await sleep(25);
    }
    assert.equal(healthy,true,f.stderr()||'legacy test server unavailable');
    const r=await fetch(`http://127.0.0.1:${f.port}/mcp`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',
        params:{name:'system_status',arguments:{}}})
    });
    const health=await (await fetch(`http://127.0.0.1:${f.port}/health`)).json();
    if(health.privilegedLegacyHttpQuarantined){
      assert.equal(r.status,403);
      assert.equal((await r.json()).error,'trusted_transport_required');
      return;
    }
    assert.equal(r.status,200);
    const body=await r.json();
    assert.equal(body.result?.isError,false);
    const status=body.result.structuredContent;
    assert.deepEqual(status.asyncOperations.originHostIntegration,{
      required:false,callbacksConfigured:false,
      trustBoundary:'LEGACY_PROFILE_NOT_AUTHENTICATED_CHAT',
      originatingChatAckVerified:false
    });
    assert.equal(status.durableDelivery.identityBoundary,
      'TRUSTED_PROFILE_NOT_AUTHENTICATED_CHAT');
  }finally{await stop(f);}
});

test('strict ingress and privileged tiers deny forged and anonymous legacy RPC in a real listener',async()=>{
  for(const policy of [
    {tier:'STANDARD',requireTrustedIngress:true},
    {tier:'STANDARD',requireTrustedIngress:false,legacyPowerModeEnabled:true},
    {tier:'FULL_POWER',requireTrustedIngress:false},
    {tier:'FULL_ACCESS',requireTrustedIngress:false}
  ]){
    const f=await isolatedServer(false,policy);
    try{
      let health=null;
      for(let i=0;i<300;i++){
        if(f.child.exitCode!==null)break;
        try{
          const res=await fetch(`http://127.0.0.1:${f.port}/health`);
          if(res.ok){health=await res.json();break;}
        }catch{}
        await sleep(25);
      }
      assert.ok(health,f.stderr()||'listener did not start');
      assert.equal(health.privilegedLegacyHttpQuarantined,true,JSON.stringify(policy));
      for(const method of ['tools/list','tools/call']){
        for(const forged of [false,true]){
          const res=await fetch(`http://127.0.0.1:${f.port}/mcp`,{
            method:'POST',
            headers:forged
              ? {'content-type':'application/json',authorization:'Bearer forged','x-commander-trusted':'true'}
              : {'content-type':'application/json'},
            body:JSON.stringify({jsonrpc:'2.0',id:1,method,
              params:method==='tools/call'?{name:'system_status',arguments:{}}:{}})
          });
          assert.equal(res.status,403,`${policy.tier}/${method}/${forged}`);
          assert.equal((await res.json()).error,'trusted_transport_required');
        }
      }
    }finally{await stop(f);}
  }
});
