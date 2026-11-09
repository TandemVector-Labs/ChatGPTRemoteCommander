// Exercise the REAL candidate HTTP dispatcher using stubbed filesystem/power
// backends. This is transport integration, not whole-product or native GUI V&V.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const wait = ms => new Promise(r=>setTimeout(r,ms));

test('real candidate HTTP dispatcher blocks browser origins and keeps local JSON RPC', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-http-test-'));
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
  const port=listener.address().port;await new Promise(r=>listener.close(r));
  let child;
  try {
    await fs.mkdir(path.join(root,'src'));
    for(const f of ['server-v0.3.mjs','transport-guard.mjs','gui-tools-windows.mjs','gui-owner-delegation.mjs','gui-incident-store.mjs','gui-contract.mjs','gui-process.mjs','browser-tools.mjs','browser-contract.mjs','browser-process.mjs','browser-owned-processes.mjs','browser-lease-store.mjs','browser-companion-monitor.mjs','schema-validator.mjs','async-operations.mjs','retry-guard.mjs','agent-extensions.mjs','coucou-bridge.mjs','no-codex-policy.mjs','conversation-store.mjs','conversation-continuation.mjs']) await fs.copyFile(new URL('../src/'+f,import.meta.url),path.join(root,'src',f));
    await fs.writeFile(path.join(root,'src','security-v0.3.mjs'),'export const canonicalizeRoots = async x=>x;');
    await fs.writeFile(path.join(root,'src','tools-v0.3.mjs'),'export const audit=async()=>{}; export const listDirectory=async()=>({stub:true}); export const readText=listDirectory; export const runProjectCommand=listDirectory; export const writeText=listDirectory; export const prepareProjectCommand=async()=>({file:process.execPath,args:[],cwd:process.cwd(),timeoutMs:1000,outputLimit:4096});');
    await fs.writeFile(path.join(root,'src','power-tools-v0.3.mjs'),'export const powerToolDefinitions=[]; export const executePowerTool=async()=>({stub:true}); export const prepareShellCommand=async()=>({file:process.execPath,args:[],cwd:process.cwd(),timeoutMs:1000,outputLimit:4096}); export const prepareDeferredPowerMutation=async()=>({kind:"power-tool",timeoutMs:86400000});');
    await fs.writeFile(path.join(root,'src','locks.mjs'),'export const lockStats=()=>({stub:true});');
    await fs.writeFile(path.join(root,'src','platform.mjs'),'export const expandPathValue=x=>x; export const shellName=()=>"stub";');
    await fs.writeFile(path.join(root,'src','delivery-store.mjs'),'import path from "node:path"; export const deliveryLocation=()=>({directory:path.join(path.dirname(process.env.REMOTE_COMMANDER_CONFIG),".delivery"),scope:"stub",forbiddenRoots:[]}); export class DeliveryStore { constructor(location){this.directory=location.directory;this.scope=location.scope;} health(){return {durable:true,schema:1,pending:0,deadLetter:0};} beacon(){return {pending:0,deadLetter:0,items:[],hostWakeAvailable:false,identityBoundary:"TRUSTED_PROFILE_NOT_AUTHENTICATED_CHAT"};} }');
    await fs.writeFile(path.join(root,'src','delivery-tools.mjs'),'export const createDeliveryTools=store=>({definitions:[],status:()=>store.health(),execute:async()=>({stub:true})});');
    await fs.writeFile(path.join(root,'src','mutation-idempotency.mjs'),'export class MutationIdempotencyStore { constructor(){} status(){return {enabled:true,durable:true,rawArgumentsStored:false,states:{}};} async execute(_request,effect){return effect();} }');
    await fs.writeFile(path.join(root,'config.json'),JSON.stringify({host:'127.0.0.1',port,allowedRoots:[root],allowedPrograms:[],asyncOperations:{enabled:true,stateDir:path.join(root,'operations'),deliveryReconcileMs:60000,deliveryReconcileBatch:1},powerMode:{enabled:true,fullFilesystem:true,guiControl:{enabled:false}}}));
    child=spawn(process.execPath,[path.join(root,'src','server-v0.3.mjs')],{env:{...process.env,REMOTE_COMMANDER_CONFIG:path.join(root,'config.json')},stdio:['ignore','pipe','pipe']});
    let stderr='';child.stderr.on('data',c=>stderr+=c);
    let alive=false;
    for(let i=0;i<400;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok){alive=true;break;}}catch{}await wait(25);}
    assert.equal(alive,true,stderr);
    const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'system_status',arguments:{}}});
    const send=headers=>fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers,body});
    const good=await send({'Content-Type':'application/json'});
    assert.equal(good.status,200);assert.equal(good.headers.get('cache-control'),'no-store');
    const data=await good.json();assert.equal(data.result.structuredContent.name,'chatgpt-remote-commander');
    assert.equal(data.result.structuredContent.guiControl.availability,'CHECK_gui_status');
    assert.equal(data.result.structuredContent.allowedRootsEnforced,false);
    assert.equal(data.result.structuredContent.effectiveAccess.filesystem,'full-filesystem');
    assert.equal(data.result.structuredContent.effectiveAccess.legacyFiveToolCompatibility,true);

    const listResponse=await fetch(`http://127.0.0.1:${port}/mcp`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:11,method:'tools/list',params:{}})
    });
    const listed=await listResponse.json();
    const legacyListTool=listed.result.tools.find(tool=>tool.name==='list_directory');
    const legacyRunTool=listed.result.tools.find(tool=>tool.name==='run_project_command');
    assert.match(legacyListTool.description,/outside configured allowedRoots/);
    assert.match(legacyRunTool.description,/outside configured allowedRoots/);

    const initResponse=await fetch(`http://127.0.0.1:${port}/mcp`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:12,method:'initialize',params:{protocolVersion:'2025-06-18'}})
    });
    const initialized=await initResponse.json();
    assert.match(initialized.result.instructions,/full-filesystem is enabled/);
    assert.match(initialized.result.instructions,/not an active filesystem boundary/);
    const evil=await send({'Content-Type':'application/json',Origin:'https://untrusted.invalid'});assert.equal(evil.status,403);
    const form=await send({'Content-Type':'text/plain'});assert.equal(form.status,415);
    // Node fetch normalizes Host; use raw http.request and assert the sent header.
    const badHost=await new Promise((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port,path:'/mcp',method:'POST',headers:{'Content-Type':'application/json',Host:'rebound.invalid:'+port}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
      assert.equal(req.getHeader('Host'),'rebound.invalid:'+port);
      req.on('error',reject);req.end(body);
    });
    assert.equal(badHost,403);
    const unknown=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:null}})});
    assert.equal((await unknown.json()).error.code,-32602);
  } finally {
    if(child){child.kill();await Promise.race([once(child,'close'),wait(2000)]);}
    await fs.rm(root,{recursive:true,force:true});
  }
});
