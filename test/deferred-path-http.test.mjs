import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { executePowerTool,prepareDeferredPowerMutation } from '../src/power-tools-v0.3.mjs';
import { withFullPowerAccess } from './helpers/access-mode-fixtures.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function post(port,id,name,args) {
  const response=await fetch(`http://127.0.0.1:${port}/mcp`,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})
  });
  const body=await response.json();
  assert.equal(response.status,200);
  if(body.error) throw new Error(body.error.message);
  if(body.result?.isError) throw new Error(body.result.content?.[0]?.text||'tool error');
  return body.result.structuredContent;
}
async function waitTerminal(port,operationId) {
  const deadline=Date.now()+15000;
  let id=100;
  while(Date.now()<deadline) {
    const state=await post(port,id++,'operation_status',{operationId});
    if(['SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','UNCERTAIN'].includes(state.status)) return state;
    await wait(40);
  }
  throw new Error('operation did not reach terminal state');
}
// An unrelated listener can win the freePort() release-to-bind race.
// A successful HTTP response alone is not proof that the fixture server owns the port.
function matchesFixtureHealth(status, expectedConfigSha256) {
  return status?.ok === true &&
    status?.name === 'chatgpt-remote-commander' &&
    status?.configSha256 === expectedConfigSha256;
}
async function startServer(serverRoot,configPath,port) {
  const configSha256=createHash('sha256').update(await fs.readFile(configPath)).digest('hex');
  const child=spawn(process.execPath,[path.join(serverRoot,'src','server-v0.3.mjs')],{
    cwd:serverRoot,env:{...process.env,REMOTE_COMMANDER_CONFIG:configPath},stdio:['ignore','pipe','pipe']
  });
  let stderr=''; child.stderr.on('data',c=>{stderr+=c.toString('utf8');});
  let foreignListener=false;
  const readinessDeadline=Date.now()+10000;
  while(Date.now()<readinessDeadline) {
    if(child.exitCode!==null) break;
    try {
      const response=await fetch(`http://127.0.0.1:${port}/health`,{
        signal:AbortSignal.timeout(Math.max(1,Math.min(1000,readinessDeadline-Date.now())))
      });
      if(response.ok) {
        const health=await response.json();
        if(matchesFixtureHealth(health,configSha256) && child.exitCode===null)
          return {child,stderr:()=>stderr};
        foreignListener=true;
      }
    } catch {}
    await wait(25);
  }
  if(child.exitCode===null) child.kill();
  throw new Error('fixture server did not become healthy with its own config identity'+
    (foreignListener?' (unexpected listener on reserved port)':'')+': '+stderr);
}

test('fixture readiness rejects healthy but unrelated local listeners', () => {
  const expected='a'.repeat(64);
  const exact={ok:true,name:'chatgpt-remote-commander',configSha256:expected};
  assert.equal(matchesFixtureHealth(exact,expected),true);
  assert.equal(matchesFixtureHealth({...exact,configSha256:'b'.repeat(64)},expected),false);
  assert.equal(matchesFixtureHealth({...exact,name:'other-mcp-server'},expected),false);
  assert.equal(matchesFixtureHealth({...exact,ok:false},expected),false);
  assert.equal(matchesFixtureHealth({ok:true},expected),false);
});

test('untrusted FULL_POWER legacy HTTP cannot copy, move, delete or start detached mutations', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-deferred-legacy-denied-'));
  const serverRoot=path.join(root,'server'),dataRoot=path.join(root,'data');
  const port=await freePort();let running;
  try{
    await fs.mkdir(serverRoot,{recursive:true});
    await fs.mkdir(dataRoot,{recursive:true});
    await fs.cp(new URL('../src/',import.meta.url),path.join(serverRoot,'src'),{recursive:true});
    const canonical=await fs.realpath(dataRoot);
    const source=path.join(canonical,'source');
    const destination=path.join(canonical,'destination');
    await fs.mkdir(source,{recursive:true});
    await fs.writeFile(path.join(source,'alpha.txt'),'alpha');
    const config={
      host:'127.0.0.1',port,allowedRoots:[canonical],allowedPrograms:['node'],
      maxReadBytes:1024*1024,maxWriteBytes:1024*1024,maxCommandMs:10000,
      auditLog:'var/audit.jsonl',
      asyncOperations:{enabled:true,backgroundFirst:true,stateDir:path.join(root,'operations')},
      capabilityProfile:{tier:'FULL_POWER',explicitlyAuthorized:true},
      powerMode:{enabled:true,fullFilesystem:true,allowShell:true,
        allowProcessControl:true,allowPermanentDelete:true,
        backupRoot:path.join(root,'backups'),guiControl:{enabled:false},
        browserControl:{enabled:false}}
    };
    const configPath=path.join(serverRoot,'config.json');
    await fs.writeFile(configPath,JSON.stringify(config,null,2));
    running=await startServer(serverRoot,configPath,port);
    const health=await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.privilegedLegacyHttpQuarantined,true);
    const attempts=[
      ['tools/list',{}],
      ['tools/call',{name:'copy_path',arguments:{requestId:'copy-denied',source,destination}}],
      ['tools/call',{name:'move_path',arguments:{requestId:'move-denied',source,destination}}],
      ['tools/call',{name:'delete_path',arguments:{requestId:'delete-denied',path:source,permanent:false}}],
      ['tools/call',{name:'operation_start',arguments:{requestId:'op-denied',tool:'copy_path',arguments:{source,destination}}}]
    ];
    for(const [method,params] of attempts){
      for(const headers of [
        {'content-type':'application/json'},
        {'content-type':'application/json','x-request-id':'forged-legacy',
          authorization:'Bearer forged','x-chat-id':'forged'}
      ]){
        const response=await fetch(`http://127.0.0.1:${port}/mcp`,{
          method:'POST',headers,
          body:JSON.stringify({jsonrpc:'2.0',id:42,method,params})
        });
        assert.equal(response.status,403,method);
        assert.deepEqual(await response.json(),{error:'trusted_transport_required'});
      }
    }
    await assert.rejects(fs.access(destination),{code:'ENOENT'});
    assert.equal(await fs.readFile(path.join(source,'alpha.txt'),'utf8'),'alpha');
  }finally{
    if(running?.child&&running.child.exitCode===null){
      running.child.kill();
      await Promise.race([once(running.child,'close'),wait(4000)]);
    }
    await fs.rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});
  }
});

test('Host-authorized native copy, move and recoverable delete still execute with receipts', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-deferred-native-host-'));
  try {
    const canonical=await fs.realpath(root);
    const source=path.join(canonical,'source');
    const copied=path.join(canonical,'copied');
    const moved=path.join(canonical,'moved');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source,'alpha.txt'),'alpha');
    const ctx={
      roots:[canonical],
      config:{
        powerMode:{enabled:true,fullFilesystem:false,
          allowPermanentDelete:false,backupRoot:path.join(canonical,'backups'),
          backupRetentionSnapshots:2},
        executionAccess:{required:true}
      }
    };
    withFullPowerAccess(ctx);
    assert.deepEqual(await prepareDeferredPowerMutation(ctx,'copy_path',{source,destination:copied}),
      {kind:'power-tool',timeoutMs:24*60*60*1000});
    await assert.rejects(executePowerTool(ctx,'copy_path',{source,destination:copied}),
      error=>error?.code==='V102_EXECUTION_ACCESS_REQUIRED');
    await assert.rejects(fs.access(copied),{code:'ENOENT'});
    const calls=[];
    ctx.executionAccess={run:async(action,execute)=>{
      calls.push(action.tool);
      const result=await execute();
      return {result,authorization:{grantId:'test-native-host-grant',authorized:true}};
    }};
    const copy=await executePowerTool(ctx,'copy_path',{source,destination:copied});
    assert.equal(copy.transactional,true);
    assert.equal(await fs.readFile(path.join(copied,'alpha.txt'),'utf8'),'alpha');
    assert.equal(await fs.readFile(path.join(source,'alpha.txt'),'utf8'),'alpha');
    assert.deepEqual(await prepareDeferredPowerMutation(ctx,'move_path',{source:copied,destination:moved}),
      {kind:'power-tool',timeoutMs:24*60*60*1000});
    const move=await executePowerTool(ctx,'move_path',{source:copied,destination:moved});
    assert.equal(move.transactional,true);
    await assert.rejects(fs.access(copied),{code:'ENOENT'});
    assert.equal(await fs.readFile(path.join(moved,'alpha.txt'),'utf8'),'alpha');
    await assert.rejects(executePowerTool(ctx,'delete_path',{path:moved,permanent:true}),
      /permanent delete is disabled/);
    assert.equal(await fs.readFile(path.join(moved,'alpha.txt'),'utf8'),'alpha');
    const deletion=await executePowerTool(ctx,'delete_path',{path:moved,permanent:false});
    assert.equal(deletion.permanent,false);
    assert.equal(await fs.readFile(path.join(deletion.backupPath,'alpha.txt'),'utf8'),'alpha');
    await assert.rejects(fs.access(moved),{code:'ENOENT'});
    assert.deepEqual(calls,['copy_path','move_path','delete_path','delete_path']);
  }finally{
    await fs.rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});
  }
});
