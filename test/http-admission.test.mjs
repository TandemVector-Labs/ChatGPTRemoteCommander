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

test('privileged candidate blocks anonymous/forged legacy JSON RPC and browser-origin attacks', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-http-test-'));
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
  const port=listener.address().port;await new Promise(r=>listener.close(r));
  let child;
  try {
    await fs.mkdir(path.join(root,'src'));
    for(const f of ['server-v0.3.mjs','file-write-guard.mjs','transport-guard.mjs','full-access-http-quarantine.mjs','full-access-status.mjs','effective-power-mode.mjs','capability-profile.mjs','privilege-client.mjs','windows-admin-token.mjs','gui-universal-policy.mjs','gui-native-session-provider.mjs','gui-windows-native-provider.mjs','gui-linux-input-capture-provider.mjs','gui-tools-windows.mjs','gui-owner-delegation.mjs','owner-workspace-delegation.mjs','workspace-target-tools.mjs','workspace-accessibility-tools.mjs','owner-workspace-proxy.mjs','workspace-tools.mjs','workspace-routing.mjs','workspace-target-journal.mjs','gui-target-only-policy.mjs','gui-incident-store.mjs','gui-contract.mjs','gui-process.mjs','browser-tools.mjs','browser-contract.mjs','browser-process.mjs','browser-owned-processes.mjs','browser-lease-store.mjs','browser-existing-session-route.mjs','browser-owner-window-inventory.mjs','browser-profile-inventory.mjs','browser-file-transfer-guard.mjs','browser-companion-monitor.mjs','schema-validator.mjs','async-operations.mjs','retry-guard.mjs','agent-extensions.mjs','optional-event-hook.mjs','no-codex-policy.mjs','conversation-store.mjs','conversation-continuation.mjs']) await fs.copyFile(new URL('../src/'+f,import.meta.url),path.join(root,'src',f));
    await fs.writeFile(path.join(root,'src','security-v0.3.mjs'),'export const canonicalizeRoots = async x=>x;');
    await fs.writeFile(path.join(root,'src','tools-v0.3.mjs'),'export const audit=async()=>{}; export const listDirectory=async()=>({stub:true}); export const readText=listDirectory; export const runProjectCommand=listDirectory; export const writeText=listDirectory; export const prepareProjectCommand=async()=>({file:process.execPath,args:[],cwd:process.cwd(),timeoutMs:1000,outputLimit:4096});');
    await fs.writeFile(path.join(root,'src','power-tools-v0.3.mjs'),'export const powerToolDefinitions=[]; export const executePowerTool=async()=>({stub:true}); export const prepareShellCommand=async()=>({file:process.execPath,args:[],cwd:process.cwd(),timeoutMs:1000,outputLimit:4096}); export const prepareDeferredPowerMutation=async()=>({kind:"power-tool",timeoutMs:86400000});');
    await fs.writeFile(path.join(root,'src','locks.mjs'),'export const lockStats=()=>({stub:true});');
    await fs.writeFile(path.join(root,'src','platform.mjs'),'export const expandPathValue=x=>x; export const shellName=()=>"stub";');
    await fs.writeFile(path.join(root,'src','delivery-store.mjs'),'import path from "node:path"; export const deliveryLocation=()=>({directory:path.join(path.dirname(process.env.REMOTE_COMMANDER_CONFIG),".delivery"),scope:"stub",forbiddenRoots:[]}); export class DeliveryStore { constructor(location){this.directory=location.directory;this.scope=location.scope;} health(){return {durable:true,schema:1,pending:0,deadLetter:0};} beacon(){return {pending:0,deadLetter:0,items:[],hostWakeAvailable:false,identityBoundary:"TRUSTED_PROFILE_NOT_AUTHENTICATED_CHAT"};} }');
    await fs.writeFile(path.join(root,'src','delivery-tools.mjs'),'export const createDeliveryTools=store=>({definitions:[],status:()=>store.health(),execute:async()=>({stub:true})});');
    await fs.writeFile(path.join(root,'src','mutation-idempotency.mjs'),'export class MutationIdempotencyStore { constructor(){} status(){return {enabled:true,durable:true,rawArgumentsStored:false,states:{}};} async execute(_request,effect){return effect();} }');
    await fs.writeFile(path.join(root,'config.json'),JSON.stringify({host:'127.0.0.1',port,allowedRoots:[root],allowedPrograms:[],asyncOperations:{enabled:true,stateDir:path.join(root,'operations'),deliveryReconcileMs:60000,deliveryReconcileBatch:1},capabilityProfile:{id:'qa-http',tier:'FULL_POWER',explicitlyAuthorized:true,disabledCapabilities:[]},powerMode:{enabled:true,fullFilesystem:true,allowShell:true,allowProcessControl:true,blockedShellPatterns:[],guiControl:{enabled:true}}}));
    child=spawn(process.execPath,[path.join(root,'src','server-v0.3.mjs')],{env:{...process.env,REMOTE_COMMANDER_CONFIG:path.join(root,'config.json')},stdio:['ignore','pipe','pipe']});
    let stderr='';child.stderr.on('data',c=>stderr+=c);
    let alive=false;
    for(let i=0;i<400;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok){alive=true;break;}}catch{}await wait(25);}
    assert.equal(alive,true,stderr);
    const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'system_status',arguments:{}}});
    const send=headers=>fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers,body});
    const health=await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.privilegedLegacyHttpQuarantined,true);
    assert.equal(health.access.configuredTier,'FULL_POWER');
    assert.notEqual(health.access.effectiveTier,'FULL_ACCESS');
    assert.equal(health.access.fullAccessActive,false);
    assert.equal(health.protectedIngress.required,true);
    assert.equal(health.protectedIngress.ready,false);
    assert.equal(health.protectedIngress.code,'V2_G1_INGRESS_NOT_WIRED');
    for(const request of [
      {jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'system_status',arguments:{}}},
      {jsonrpc:'2.0',id:2,method:'tools/list',params:{}},
      {jsonrpc:'2.0',id:3,method:'initialize',params:{protocolVersion:'2025-06-18'}}
    ]){
      for(const header of [
        {'Content-Type':'application/json'},
        {'Content-Type':'application/json',authorization:'Bearer forged','x-chat-id':'forged'}
      ]){
        const denied=await send(header);
        // The request body must match the candidate RPC method under test.
        const reply=await fetch(`http://127.0.0.1:${port}/mcp`,{
          method:'POST',headers:header,body:JSON.stringify(request)
        });
        assert.equal(reply.status,403);
        assert.deepEqual(await reply.json(),{error:'trusted_transport_required'});
        assert.equal(denied.status,403);
      }
    }
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
    assert.equal(unknown.status,403);
    assert.deepEqual(await unknown.json(),{error:'trusted_transport_required'});
  } finally {
    if(child){child.kill();await Promise.race([once(child,'close'),wait(2000)]);}
    await fs.rm(root,{recursive:true,force:true});
  }
});
