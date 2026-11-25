import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){
  const s=createServer();
  await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve);});
  const port=s.address().port;
  await new Promise(resolve=>s.close(resolve));
  return port;
}
test('isolated 0.12 standard Core dispatches real read_text without authorizing protected Power', {timeout:30000},async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'rc-v012-core-tool-'));
  let child,stderr='';
  try{
    const fixture=path.join(temp,'fixture.txt');
    const marker='rc-v012-core-dispatch-fixture';
    await writeFile(fixture,marker);
    const config=JSON.parse(await readFile(path.join(root,'config.json'),'utf8'));
    config.host='127.0.0.1';
    config.port=await freePort();
    config.allowedRoots=[temp];
    config.auditLog=path.join(temp,'audit.jsonl');
    config.runtimeState=path.join(temp,'runtime.json');
    config.capabilityProfile={schemaVersion:4,id:'standard-core-canary',tier:'STANDARD',
      explicitlyAuthorized:false,persistAcrossUpdates:false};
    config.powerMode={...config.powerMode,enabled:false,fullFilesystem:false,
      allowShell:false,allowProcessControl:false,
      guiControl:{...config.powerMode.guiControl,enabled:false},
      browserControl:{...config.powerMode.browserControl,enabled:false}};
    config.requireTrustedIngress=false;
    config.trustedIngressConfigured=false;
    config.autoUpdate={...config.autoUpdate,enabled:false};
    const configFile=path.join(temp,'config.json');
    await writeFile(configFile,JSON.stringify(config));
    child=spawn(process.execPath,[path.join(root,'src','server-v0.3.mjs')],{
      cwd:root,env:{...process.env,REMOTE_COMMANDER_CONFIG:configFile,COMMANDER_ONE_REQUIRE_TRUSTED_INGRESS:'0'},
      windowsHide:true,stdio:['ignore','ignore','pipe']
    });
    child.stderr.on('data',data=>{stderr=(stderr+data.toString()).slice(-1500);});
    const base='http://127.0.0.1:'+config.port;
    let health;
    for(let i=0;i<100;i++){
      if(child.exitCode!==null)throw Error('CORE_EXITED '+child.exitCode+' '+stderr);
      try{const res=await fetch(base+'/health',{signal:AbortSignal.timeout(250)});
        if(res.ok){health=await res.json();break;}}catch{}
      await pause(100);
    }
    assert.ok(health,'CORE_HEALTH_TIMEOUT '+stderr);
    assert.equal(health.version,'0.12.0-dev.9');
    assert.equal(health.access.effectiveTier,'STANDARD');
    const rpc=async(id,method,params)=> {
      const res=await fetch(base+'/mcp',{method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
      assert.equal(res.status,200);
      return res.json();
    };
    const catalog=await rpc(1,'tools/list',{});
    assert.ok(catalog.result.tools.some(t=>t.name==='read_text'));
    const read=await rpc(2,'tools/call',{name:'read_text',arguments:{path:fixture}});
    assert.equal(read.result.isError,false,JSON.stringify(read));
    assert.match(JSON.stringify(read.result),/rc-v012-core-dispatch-fixture/);
  }finally{
    if(child&&child.exitCode===null){
      child.kill();
      await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(3000)]);
    }
    await rm(temp,{recursive:true,force:true});
  }
});
