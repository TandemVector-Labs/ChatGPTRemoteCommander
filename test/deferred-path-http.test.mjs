import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';

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

test('unbounded path mutations auto-defer, survive retry, and publish exact results', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-deferred-path-'));
  const serverRoot=path.join(root,'server');
  const dataRoot=path.join(root,'data');
  const toolsRoot=path.join(serverRoot,'tools');
  const stateRoot=path.join(root,'operations');
  const backupRoot=path.join(root,'backups');
  const port=await freePort();
  let running;
  try {
    await fs.mkdir(serverRoot,{recursive:true});
    await fs.mkdir(dataRoot,{recursive:true});
    await fs.mkdir(toolsRoot,{recursive:true});
    await fs.cp(new URL('../src/',import.meta.url),path.join(serverRoot,'src'),{recursive:true});
    await fs.copyFile(new URL('../tools/operation-worker.mjs',import.meta.url),path.join(toolsRoot,'operation-worker.mjs'));
    const canonicalDataRoot=await fs.realpath(dataRoot);
    const config={
      host:'127.0.0.1',port,allowedRoots:[canonicalDataRoot],allowedPrograms:['node'],
      maxReadBytes:1024*1024,maxWriteBytes:1024*1024,maxCommandMs:10000,auditLog:'var/audit.jsonl',
      asyncOperations:{enabled:true,backgroundFirst:true,stateDir:stateRoot,maxOutputBytes:65536},
      powerMode:{enabled:true,fullFilesystem:true,allowShell:true,allowProcessControl:true,allowPermanentDelete:true,
        backupRoot,guiControl:{enabled:false},browserControl:{enabled:false}}
    };
    const configPath=path.join(serverRoot,'config.json');
    await fs.writeFile(configPath,JSON.stringify(config,null,2));
    running=await startServer(serverRoot,configPath,port);

    const source=path.join(canonicalDataRoot,'source');
    const copied=path.join(canonicalDataRoot,'copied');
    const moved=path.join(canonicalDataRoot,'moved');
    await fs.mkdir(source,{recursive:true});
    await fs.writeFile(path.join(source,'a.txt'),'alpha');

    const unboundDestination=path.join(canonicalDataRoot,'unbound-copy');
    await assert.rejects(
      post(port,99,'copy_path',{
        requestId:'deferred-copy-unbound-continuation',
        source,destination:unboundDestination,
        continuation:{projectId:'missing-chat',eventKey:'copy:unbound',root:canonicalDataRoot,summary:'must fail before worker creation'}
      }),
      /CONVERSATION_NOT_BOUND/
    );
    await assert.rejects(fs.access(unboundDestination));

    const copyArgs={requestId:'deferred-copy-1',source,destination:copied};
    const started=Date.now();
    const copy=await post(port,1,'copy_path',copyArgs);
    assert.ok(Date.now()-started<1000,'copy_path did not return a durable handle promptly');
    assert.match(copy.operationId,/^[a-f0-9-]{36}$/);
    const copyRetry=await post(port,2,'copy_path',copyArgs);
    assert.equal(copyRetry.operationId,copy.operationId);
    assert.equal(copyRetry.duplicate,true);
    assert.equal((await waitTerminal(port,copy.operationId)).status,'SUCCEEDED');
    assert.equal(await fs.readFile(path.join(copied,'a.txt'),'utf8'),'alpha');
    const copyResult=await post(port,3,'operation_result',{operationId:copy.operationId,tailBytes:256});
    assert.equal(copyResult.result.toolResult.destination,copied);

    const move=await post(port,4,'move_path',{requestId:'deferred-move-1',source:copied,destination:moved});
    assert.match(move.operationId,/^[a-f0-9-]{36}$/);
    assert.equal((await waitTerminal(port,move.operationId)).status,'SUCCEEDED');
    await assert.rejects(fs.access(copied));
    assert.equal(await fs.readFile(path.join(moved,'a.txt'),'utf8'),'alpha');

    const del=await post(port,5,'delete_path',{requestId:'deferred-delete-1',path:moved,permanent:false});
    assert.match(del.operationId,/^[a-f0-9-]{36}$/);
    assert.equal((await waitTerminal(port,del.operationId)).status,'SUCCEEDED');
    await assert.rejects(fs.access(moved));
    const delResult=await post(port,6,'operation_result',{operationId:del.operationId,tailBytes:256});
    assert.equal(delResult.result.toolResult.permanent,false);
    assert.equal(typeof delResult.result.toolResult.backupPath,'string');
    assert.equal(await fs.readFile(path.join(delResult.result.toolResult.backupPath,'a.txt'),'utf8'),'alpha');

    const stateText=await fs.readFile(path.join(stateRoot,'operations',copy.operationId,'state.json'),'utf8');
    const requestFiles=await fs.readdir(path.join(stateRoot,'requests'));
    const requestText=(await Promise.all(requestFiles.map(f=>fs.readFile(path.join(stateRoot,'requests',f),'utf8')))).join('\n');
    assert.equal(stateText.includes(source),false);
    assert.equal(stateText.includes(copied),false);
    assert.equal(requestText.includes(source),false);
    assert.equal(requestText.includes(copied),false);
  } finally {
    if(running?.child && running.child.exitCode===null) {
      running.child.kill();
      await Promise.race([once(running.child,'close'),wait(4000)]);
    }
    await fs.rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});
  }
});
