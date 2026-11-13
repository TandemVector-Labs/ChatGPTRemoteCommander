import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ensureRouterSource, assertRouterStatusUrl } from '../tools/router-source-bootstrap.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function freePort(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function waitStatus(url,expected){
  const deadline=Date.now()+12000;
  while(Date.now()<deadline){
    try{const r=await fetch(url,{signal:AbortSignal.timeout(1500)});if(r.ok){const x=await r.json();if(!expected||x.sourceSha256===expected)return x;}}catch{}
    await sleep(50);
  }
  throw new Error('TEST_ROUTER_READY_TIMEOUT');
}
const alive = pid => { try { process.kill(Number(pid),0); return true; } catch { return false; } };
async function killRuntime(runtime){
  let pid=null;
  try{const x=JSON.parse(await fsp.readFile(runtime,'utf8'));pid=Number(x.pid||0);}catch{}
  if(pid && alive(pid)){try{process.kill(pid,'SIGKILL');}catch{}}
  for(let i=0;i<50&&pid&&alive(pid);i+=1)await sleep(100);
}
async function fixture(candidateBody){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'rc-router-bootstrap-'));
  const oldProject=path.join(root,'old'), candidateProject=path.join(root,'candidate');
  await fsp.mkdir(path.join(oldProject,'src'),{recursive:true});await fsp.mkdir(path.join(candidateProject,'src'),{recursive:true});
  const source=await fsp.readFile(new URL('../src/stable-router.mjs',import.meta.url),'utf8');
  const oldSource=path.join(oldProject,'src','stable-router.mjs'), candidateSource=path.join(candidateProject,'src','stable-router.mjs');
  await fsp.writeFile(oldSource,source);await fsp.writeFile(candidateSource,candidateBody(source));
  const port=await freePort(), backendPort=await freePort();
  const stateFile=path.join(root,'route.json'),runtimeFile=path.join(root,'router.runtime.json'),logFile=path.join(root,'router.log');
  const route={schema:1,profile:'default',generation:7,active:{port:backendPort,version:'1',commit:'a'.repeat(40),configSha256:'1'.repeat(64),projectDir:oldProject,configPath:path.join(root,'config.json')},updatedAt:new Date().toISOString()};
  await fsp.writeFile(stateFile,JSON.stringify(route,null,2)+'\n');
  const child=spawn(process.execPath,[oldSource,'--listen-port',String(port),'--state-file',stateFile,'--runtime-file',runtimeFile],{cwd:oldProject,stdio:'ignore',windowsHide:true});
  try{
    await waitStatus('http://127.0.0.1:' + port + '/router/status',sha(oldSource));
  }catch(error){
    // A readiness failure must not leak a fixture router or unbounded test.
    await killRuntime(runtimeFile);
    if(alive(child.pid)){try{child.kill('SIGKILL');}catch{}}
    await fsp.rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
    throw error;
  }
  return {root,oldProject,candidateProject,oldSource,candidateSource,port,stateFile,runtimeFile,logFile,child,routeBytes:await fsp.readFile(stateFile)};
}
test('router source bootstrap replaces owned router and preserves route bytes',async()=>{
  const f=await fixture(source=>source+'\n// candidate-source\n');
  try{
    const result=await ensureRouterSource({url:`http://127.0.0.1:${f.port}/router/status`,stateFile:f.stateFile,runtimeFile:f.runtimeFile,candidateSource:f.candidateSource,logFile:f.logFile});
    assert.equal(result.ok,true);assert.equal(result.changed,true);assert.equal(result.sourceSha256,sha(f.candidateSource));
    const st=await waitStatus(`http://127.0.0.1:${f.port}/router/status`,sha(f.candidateSource));assert.equal(st.state.generation,7);
    assert.deepEqual(await fsp.readFile(f.stateFile),f.routeBytes);
    const second=await ensureRouterSource({url:`http://127.0.0.1:${f.port}/router/status`,stateFile:f.stateFile,runtimeFile:f.runtimeFile,candidateSource:f.candidateSource,logFile:f.logFile});
    assert.equal(second.changed,false);
  }finally{await killRuntime(f.runtimeFile);await fsp.rm(f.root,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});
test('failed candidate router rolls back to exact old source and route',async()=>{
  const f=await fixture(()=> 'this is not valid javascript !!!\n');
  try{
    await assert.rejects(()=>ensureRouterSource({url:`http://127.0.0.1:${f.port}/router/status`,stateFile:f.stateFile,runtimeFile:f.runtimeFile,candidateSource:f.candidateSource,logFile:f.logFile}),/ROUTER_BOOTSTRAP_FAIL/);
    await waitStatus(`http://127.0.0.1:${f.port}/router/status`,sha(f.oldSource));
    assert.deepEqual(await fsp.readFile(f.stateFile),f.routeBytes);
  }finally{await killRuntime(f.runtimeFile);await fsp.rm(f.root,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});

test('router source URL must target the exact owned local status port without credentials or redirects', () => {
  const port = 47831;
  assert.equal(assertRouterStatusUrl('http://127.0.0.1:47831/router/status', port), 'http://127.0.0.1:47831/router/status');
  assert.equal(assertRouterStatusUrl('http://[::1]:47831/router/status', port), 'http://[::1]:47831/router/status');
  for (const url of [
    'https://127.0.0.1:47831/router/status',
    'http://example.invalid:47831/router/status',
    'http://localhost:47831/router/status',
    'http://127.0.0.1:12345/router/status',
    'http://127.0.0.1:47831/private',
    'http://127.0.0.1:47831/router/status?url=http://evil.invalid/',
    'http://127.0.0.1:47831/router/status#fragment',
    'http://user@127.0.0.1:47831/router/status',
    'http://127.0.0.1:47831@evil.invalid/router/status',
    'http://127.0.0.1:47831/router/%73tatus',
    'http://127.0.0.1:47831/router/status/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    null, undefined
  ]) {
    assert.throws(() => assertRouterStatusUrl(url, port), /ROUTER_STATUS_URL_DENIED/, String(url));
  }
  assert.throws(() => assertRouterStatusUrl('http://127.0.0.1:47831/router/status', 1), /ROUTER_STATUS_URL_DENIED/);
});

test('router bootstrap rejects an untrusted URL before making a network request or affecting the router', async () => {
  const f = await fixture(source => source + '\n// trusted fixture candidate\n');
  try {
    const before = JSON.parse(await fsp.readFile(f.runtimeFile, 'utf8'));
    await assert.rejects(
      () => ensureRouterSource({url: 'http://127.0.0.1:47832/router/status', stateFile:f.stateFile,
        runtimeFile:f.runtimeFile,candidateSource:f.candidateSource,logFile:f.logFile}),
      /ROUTER_STATUS_URL_DENIED/
    );
    assert.deepEqual(JSON.parse(await fsp.readFile(f.runtimeFile,'utf8')), before);
    const status = await waitStatus('http://127.0.0.1:' + f.port + '/router/status', sha(f.oldSource));
    assert.equal(status.sourceSha256, sha(f.oldSource));
    assert.deepEqual(await fsp.readFile(f.stateFile), f.routeBytes);
  } finally { await killRuntime(f.runtimeFile); await fsp.rm(f.root,{recursive:true,force:true,maxRetries:20,retryDelay:100}); }
});

test('spoofed local Router status cannot bypass runtime-file and PID ownership checks', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'rc-router-identity-negative-'));
  const stateFile = path.join(root, 'route.json');
  const runtimeFile = path.join(root, 'router.runtime.json');
  const candidateSource = path.join(root, 'candidate-router.mjs');
  const logFile = path.join(root, 'router.log');
  await fsp.writeFile(candidateSource, '// synthetic candidate only\n');
  await fsp.writeFile(stateFile, JSON.stringify({ schema: 1, active: { projectDir: root } }));
  const sourceHash = sha(candidateSource);
  let requests = 0;
  const responder = http.createServer((_req, res) => {
    requests += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, router: true, sourceSha256: sourceHash }));
  });
  try {
    await new Promise((resolve, reject) => {
      responder.once('error', reject);
      responder.listen(0, '127.0.0.1', resolve);
    });
    const port = responder.address().port;
    const url = `http://127.0.0.1:${port}/router/status`;
    const opts = { url, stateFile, runtimeFile, candidateSource, logFile };

    // The old no-op fast path accepted this spoofed responder even when the
    // on-disk routing identity did not belong to the requested state file.
    await fsp.writeFile(runtimeFile, JSON.stringify({
      pid: 999999999, port, stateFile: path.join(root, 'other-route.json'),
      sourceSha256: sourceHash
    }));
    await assert.rejects(() => ensureRouterSource(opts), /ROUTER_RUNTIME_IDENTITY_MISMATCH/);
    assert.equal(requests, 0, 'a wrong runtime state file must fail before HTTP');

    // A correctly named state file is not enough: its recorded process must
    // be alive and match the actual Router launch command.
    await fsp.writeFile(runtimeFile, JSON.stringify({
      pid: 999999999, port, stateFile, sourceSha256: sourceHash
    }));
    await assert.rejects(() => ensureRouterSource(opts), /ROUTER_PROCESS_MISSING/);
    assert.equal(requests, 0, 'a stale runtime PID must fail before HTTP');
  } finally {
    if (responder.listening) {
      await new Promise(resolve => responder.close(resolve));
    }
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('matching Router status alone cannot override an inconsistent runtime source hash', async () => {
  const f = await fixture(source => source); // unchanged candidate exercises the no-op path
  try {
    const runtime = JSON.parse(await fsp.readFile(f.runtimeFile, 'utf8'));
    runtime.sourceSha256 = 'f'.repeat(64);
    await fsp.writeFile(f.runtimeFile, JSON.stringify(runtime));
    await assert.rejects(
      () => ensureRouterSource({
        url: `http://127.0.0.1:${f.port}/router/status`,
        stateFile: f.stateFile, runtimeFile: f.runtimeFile,
        candidateSource: f.candidateSource, logFile: f.logFile
      }),
      /ROUTER_RUNTIME_IDENTITY_MISMATCH/
    );
    await waitStatus(`http://127.0.0.1:${f.port}/router/status`, sha(f.oldSource));
  } finally {
    await killRuntime(f.runtimeFile);
    await fsp.rm(f.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
