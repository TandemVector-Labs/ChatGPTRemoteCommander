import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { startRouter, writeRouterStateAtomic } from '../src/stable-router.mjs';

const MODERN='2026-07-28';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function temp(){return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-schema-router-')));}
let portCursor=20000+(process.pid%20000);
async function listen(server){
  for(let attempt=0;attempt<500;attempt+=1){
    const port=portCursor++;
    if(portCursor>45000)portCursor=20000;
    try{
      await new Promise((resolve,reject)=>{
        const cleanup=()=>{server.off('error',onError);server.off('listening',onListening);};
        const onError=error=>{cleanup();reject(error);};
        const onListening=()=>{cleanup();resolve();};
        server.once('error',onError);server.once('listening',onListening);server.listen(port,'127.0.0.1');
      });
      return port;
    }catch(error){
      if(error?.code!=='EADDRINUSE' && !(process.platform==='win32'&&error?.code==='EACCES'))throw error;
    }
  }
  throw new Error('SAFE_TEST_PORT_UNAVAILABLE');
}
function close(server){return new Promise(resolve=>server.close(resolve));}
async function freePort(){const s=http.createServer();const p=await listen(s);await close(s);return p;}
function backend(label){
  return http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    let msg={};try{msg=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}
    let body;
    if(msg.method==='server/discover') body={jsonrpc:'2.0',id:msg.id,result:{resultType:'complete',supportedVersions:[MODERN],capabilities:{tools:{}},backend:label}};
    else body={jsonrpc:'2.0',id:msg.id,result:{resultType:'complete',tools:[],backend:label}};
    const data=Buffer.from(JSON.stringify(body));
    res.writeHead(200,{'content-type':'application/json','content-length':data.length});res.end(data);
  });
}
function meta(){return {'io.modelcontextprotocol/protocolVersion':MODERN,'io.modelcontextprotocol/clientInfo':{name:'schema-test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}};}
function headers(method){return {'content-type':'application/json','accept':'application/json, text/event-stream','mcp-protocol-version':MODERN,'mcp-method':method};}
async function post(port,msg,method){
  const r=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:headers(method),body:JSON.stringify(msg)});
  return {status:r.status,body:await r.json()};
}
async function openSubscription(port,id='listen-1'){
  const controller=new AbortController();
  const response=await fetch(`http://127.0.0.1:${port}/mcp`,{
    method:'POST',headers:headers('subscriptions/listen'),signal:controller.signal,
    body:JSON.stringify({jsonrpc:'2.0',id,method:'subscriptions/listen',params:{notifications:{toolsListChanged:true},_meta:meta()}})
  });
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type')||'',/text\/event-stream/);
  const reader=response.body.getReader();let buffer='';
  async function nextFrame(timeoutMs=2500){
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
      const split=buffer.indexOf('\n\n');
      if(split>=0){
        const raw=buffer.slice(0,split);buffer=buffer.slice(split+2);
        const line=raw.split(/\r?\n/).find(x=>x.startsWith('data: '));
        if(line)return JSON.parse(line.slice(6));
      }
      const remain=Math.max(1,deadline-Date.now());
      const item=await Promise.race([reader.read(),wait(remain).then(()=>({timeout:true}))]);
      if(item.timeout)break;
      if(item.done)break;
      buffer+=Buffer.from(item.value).toString('utf8').replace(/\r\n/g,'\n');
    }
    throw new Error('SSE_FRAME_TIMEOUT');
  }
  return {controller,nextFrame};
}

test('stable router owns modern tools-list subscription across generation cutover',async()=>{
  const root=temp();let router,a,b,sub;
  try{
    a=backend('A');b=backend('B');
    const aPort=await listen(a),bPort=await listen(b),routerPort=await freePort();
    const stateFile=path.join(root,'router.json');
    const base={schema:1,profile:'default',generation:1,active:{port:aPort,version:'0.9.4',commit:'a'.repeat(40),configSha256:'1'.repeat(64)},updatedAt:new Date().toISOString()};
    writeRouterStateAtomic(stateFile,base);
    router=await startRouter({listenPort:routerPort,stateFile});

    const discover=await post(routerPort,{jsonrpc:'2.0',id:1,method:'server/discover',params:{_meta:meta()}},'server/discover');
    assert.equal(discover.status,200);
    assert.equal(discover.body.result.capabilities.tools.listChanged,true);

    sub=await openSubscription(routerPort);
    const ack=await sub.nextFrame();
    assert.equal(ack.method,'notifications/subscriptions/acknowledged');
    assert.equal(ack.params.notifications.toolsListChanged,true);
    assert.equal(ack.params._meta['io.modelcontextprotocol/subscriptionId'],'listen-1');
    assert.equal(router.status().schemaContinuity.toolsListSubscribers,1);
    assert.equal(router.status().schemaContinuity.modernMcpSeen,true);
    assert.deepEqual(router.status().inflightByPort,{});

    writeRouterStateAtomic(stateFile,{...base,generation:2,active:{port:bPort,version:'0.9.5',commit:'b'.repeat(40),configSha256:'2'.repeat(64)},updatedAt:new Date().toISOString()},1);
    const changed=await sub.nextFrame();
    assert.equal(changed.method,'notifications/tools/list_changed');
    assert.equal(changed.params._meta['io.modelcontextprotocol/subscriptionId'],'listen-1');
    for(let i=0;i<30&&router.status().schemaContinuity.observedGeneration!==2;i++)await wait(20);
    assert.equal(router.status().schemaContinuity.observedGeneration,2);

    sub.controller.abort();
    for(let i=0;i<50&&router.status().schemaContinuity.totalSubscriptions!==0;i++)await wait(20);
    assert.equal(router.status().schemaContinuity.totalSubscriptions,0);
  }finally{
    sub?.controller.abort();
    if(router)await router.close();
    if(a)await close(a);
    if(b)await close(b);
    fs.rmSync(root,{recursive:true,force:true});
  }
});
