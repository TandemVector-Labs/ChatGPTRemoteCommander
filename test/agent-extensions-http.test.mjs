import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const wait=ms=>new Promise(r=>setTimeout(r,ms));

test('agent extension tools are exposed read-only and return validated manifests',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-agent-http-'));
  const extensionRoot=path.join(root,'extensions');
  const extensionDir=path.join(extensionRoot,'fixture-extension');
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
  const port=listener.address().port;await new Promise(r=>listener.close(r));
  let child;
  try {
    await fs.mkdir(path.join(root,'src'),{recursive:true});
    for(const f of ['server-v0.3.mjs','transport-guard.mjs','gui-tools-windows.mjs','gui-incident-store.mjs','managed-path-anchor.mjs','gui-contract.mjs','gui-process.mjs','browser-tools.mjs','browser-contract.mjs','browser-process.mjs','browser-owned-processes.mjs','browser-lease-store.mjs','browser-companion-monitor.mjs','schema-validator.mjs','async-operations.mjs','retry-guard.mjs','agent-extensions.mjs','coucou-bridge.mjs','no-codex-policy.mjs','conversation-store.mjs','conversation-continuation.mjs']) {
      await fs.copyFile(new URL('../src/'+f,import.meta.url),path.join(root,'src',f));
    }
    await fs.writeFile(path.join(root,'src','security-v0.3.mjs'),'export const canonicalizeRoots = async x=>x;');
    await fs.writeFile(path.join(root,'src','tools-v0.3.mjs'),'export const audit=async()=>{}; export const listDirectory=async()=>({stub:true}); export const readText=listDirectory; export const runProjectCommand=listDirectory; export const writeText=listDirectory; export const prepareProjectCommand=async()=>({file:process.execPath,args:[],cwd:process.cwd(),timeoutMs:1000,outputLimit:4096});');
    await fs.writeFile(path.join(root,'src','power-tools-v0.3.mjs'),'export const powerToolDefinitions=[]; export const executePowerTool=async()=>({stub:true}); export const prepareShellCommand=async()=>({file:process.execPath,args:[],cwd:process.cwd(),timeoutMs:1000,outputLimit:4096}); export const prepareDeferredPowerMutation=async()=>({kind:"power-tool",timeoutMs:86400000});');
    await fs.writeFile(path.join(root,'src','locks.mjs'),'export const lockStats=()=>({stub:true});');
    await fs.writeFile(path.join(root,'src','platform.mjs'),'export const expandPathValue=x=>x; export const shellName=()=>"stub";');
    await fs.writeFile(path.join(root,'src','delivery-store.mjs'),'import path from "node:path"; export const deliveryLocation=()=>({directory:path.join(path.dirname(process.env.REMOTE_COMMANDER_CONFIG),".delivery"),scope:"stub",forbiddenRoots:[]}); export class DeliveryStore { constructor(location){this.directory=location.directory;this.scope=location.scope;} health(){return {durable:true,schema:1,pending:0,deadLetter:0};} beacon(){return {pending:0,deadLetter:0,items:[],hostWakeAvailable:false,identityBoundary:"TRUSTED_PROFILE_NOT_AUTHENTICATED_CHAT"};} }');
    await fs.writeFile(path.join(root,'src','delivery-tools.mjs'),'export const createDeliveryTools=store=>({definitions:[],status:()=>store.health(),execute:async()=>({stub:true})});');
    await fs.writeFile(path.join(root,'src','mutation-idempotency.mjs'),'export class MutationIdempotencyStore { constructor(){} status(){return {enabled:true,durable:true,rawArgumentsStored:false,states:{}};} async execute(_request,effect){return effect();} }');

    await fs.mkdir(extensionDir,{recursive:true});
    await fs.writeFile(path.join(extensionDir,'SKILL.md'),'# Fixture Extension\n');
    await fs.writeFile(path.join(extensionDir,'agent.json'),JSON.stringify({
      schemaVersion:1,id:'fixture-extension',version:'1.0.0',displayName:'Fixture Extension',
      description:'Generic reusable capability-pack fixture.',
      capabilities:['fixture.capability.alpha','fixture.capability.beta'],triggers:['fixture task','sample extension'],skill:'SKILL.md',
      safetyGates:['fixture.approval-required'],artifacts:['result.bin']
    }));

    await fs.writeFile(path.join(root,'config.json'),JSON.stringify({
      host:'127.0.0.1',port,allowedRoots:[root],allowedPrograms:[],
      agentExtensions:{directories:[extensionRoot]},
      powerMode:{enabled:true,fullFilesystem:true,guiControl:{enabled:false}}
    }));
    child=spawn(process.execPath,[path.join(root,'src','server-v0.3.mjs')],{
      env:{...process.env,REMOTE_COMMANDER_CONFIG:path.join(root,'config.json')},stdio:['ignore','pipe','pipe']
    });
    let stderr='';child.stderr.on('data',c=>stderr+=c);
    let alive=false;
    for(let i=0;i<400;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok){alive=true;break;}}catch{}await wait(25);}
    assert.equal(alive,true,stderr);
    const call=async(name,args={})=>{
      const res=await fetch(`http://127.0.0.1:${port}/mcp`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:name,method:'tools/call',params:{name,arguments:args}})
      });
      return res.json();
    };
    const listRes=await fetch(`http://127.0.0.1:${port}/mcp`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})
    });
    const listed=await listRes.json();
    for(const name of ['agent_extension_list','agent_extension_get','agent_extension_match','agent_extension_route','agent_extension_skill']){
      const def=listed.result.tools.find(x=>x.name===name);
      assert.ok(def,name+' missing');
      assert.equal(def.annotations.readOnlyHint,true);
    }
    const status=(await call('system_status')).result.structuredContent;
    assert.equal(status.configSchema.agentExtensions,1);
    assert.equal(status.agentExtensions.count,1);
    const extList=(await call('agent_extension_list')).result.structuredContent;
    assert.deepEqual(extList.items.map(x=>x.id),['fixture-extension']);
    const ext=(await call('agent_extension_get',{id:'fixture-extension'})).result.structuredContent;
    assert.equal(ext.safetyGates[0],'fixture.approval-required');
    const match=(await call('agent_extension_match',{capabilities:['fixture.capability.beta']})).result.structuredContent;
    assert.deepEqual(match.items.map(x=>x.id),['fixture-extension']);
    const routed=(await call('agent_extension_route',{task:'fixture task'})).result.structuredContent;
    assert.deepEqual(routed.items.map(x=>x.id),['fixture-extension']);
    const skill=(await call('agent_extension_skill',{id:'fixture-extension'})).result.structuredContent;
    assert.equal(skill.id,'fixture-extension');
    assert.match(skill.sha256,/^[0-9a-f]{64}$/);
    assert.match(skill.skill,/Fixture Extension/);
  } finally {
    if(child){child.kill();await Promise.race([once(child,'close'),wait(5000)]);}
    await fs.rm(root,{recursive:true,force:true});
  }
});
