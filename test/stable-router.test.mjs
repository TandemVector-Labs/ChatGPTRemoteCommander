import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startRouter, writeRouterStateAtomic } from '../src/stable-router.mjs';

function temp(){return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-router-')));}
function listen(server){return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});}
function close(server){return new Promise(resolve=>server.close(resolve));}
function requestLocal(port,pathname,options={}){
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port,path:pathname,method:options.method||'GET',headers:options.headers||{}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(Buffer.from(chunk)));res.once('error',reject);res.once('end',()=>{
    const body=Buffer.concat(chunks);
    resolve({status:res.statusCode||0,text:async()=>body.toString('utf8'),json:async()=>JSON.parse(body.toString('utf8'))});
   });
  });
  req.once('error',reject);
  if(options.body!==undefined)req.write(options.body);
  req.end();
 });
}
async function freePort(){
 const s=http.createServer();const p=await listen(s);await close(s);return p;
}
test('stable router switches atomically and drains in-flight request on old backend',async()=>{
 const root=temp();let router,a,b;try{
   let releaseA;const waitA=new Promise(r=>releaseA=r);
   a=http.createServer(async(req,res)=>{
     if(req.url==='/slow'){await waitA;res.writeHead(200,{'content-type':'text/plain'});res.end('A-slow');return;}
     res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({backend:'A',url:req.url}));
   });
   b=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({backend:'B',url:req.url}));});
   const aPort=await listen(a),bPort=await listen(b),listenPort=await freePort();
   const stateFile=path.join(root,'router.json');
   const baseState={schema:1,profile:'default',generation:1,active:{port:aPort,version:'1.0.0',commit:'a'.repeat(40),configSha256:'1'.repeat(64)},updatedAt:new Date().toISOString()};
   writeRouterStateAtomic(stateFile,baseState);
   router=await startRouter({listenPort,stateFile});
   let r=await requestLocal(listenPort,'/mcp');assert.equal((await r.json()).backend,'A');

   const slow=requestLocal(listenPort,'/slow').then(x=>x.text());
   for(let i=0;i<50;i++){const st=router.status();if(Number(st.inflightByPort[aPort]||0)>0)break;await new Promise(r=>setTimeout(r,10));}
   assert.equal(Number(router.status().inflightByPort[aPort]||0),1);

   writeRouterStateAtomic(stateFile,{...baseState,generation:2,active:{port:bPort,version:'2.0.0',commit:'b'.repeat(40),configSha256:'2'.repeat(64)},updatedAt:new Date().toISOString()},1);
   r=await requestLocal(listenPort,'/mcp');assert.equal((await r.json()).backend,'B');
   assert.equal(Number(router.status().inflightByPort[aPort]||0),1);

   releaseA();assert.equal(await slow,'A-slow');
   for(let i=0;i<50&&Number(router.status().inflightByPort[aPort]||0)>0;i++)await new Promise(r=>setTimeout(r,10));
   assert.equal(Number(router.status().inflightByPort[aPort]||0),0);
   assert.equal(router.status().state.generation,2);
 }finally{
   if(router)await router.close();
   if(a)await close(a);
   if(b)await close(b);
   fs.rmSync(root,{recursive:true,force:true});
 }
});
test('downstream disconnect drains completed upstream response without stranding inflight accounting',async()=>{
 const root=temp();let router,a;try{
   let release;const gate=new Promise(r=>release=r);let backendSaw=false;
   a=http.createServer(async(req,res)=>{
     backendSaw=true;await gate;res.writeHead(200,{'content-type':'application/octet-stream'});
     const chunk=Buffer.alloc(65536,1);
     for(let i=0;i<128;i++){if(!res.write(chunk))await new Promise(resolve=>res.once('drain',resolve));}
     res.end();
   });
   const aPort=await listen(a),listenPort=await freePort(),stateFile=path.join(root,'router.json');
   writeRouterStateAtomic(stateFile,{schema:1,profile:'default',generation:1,active:{port:aPort,version:'1',commit:'a'.repeat(40),configSha256:'1'.repeat(64)},updatedAt:new Date().toISOString()});
   router=await startRouter({listenPort,stateFile});
   const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'run_shell',arguments:{}}}));
   let clientClosed=false;
   const client=http.request({host:'127.0.0.1',port:listenPort,path:'/mcp',method:'POST',headers:{'content-type':'application/json','content-length':body.length}},res=>{
     res.once('data',()=>{clientClosed=true;res.destroy();});
   });
   client.on('error',()=>{});client.end(body);
   for(let i=0;i<100;i++){if(backendSaw&&Number(router.status().inflightByPort[aPort]||0)===1)break;await new Promise(r=>setTimeout(r,10));}
   assert.equal(backendSaw,true);assert.equal(Number(router.status().inflightByPort[aPort]||0),1);
   release();
   for(let i=0;i<200;i++){if(clientClosed&&Number(router.status().inflightByPort[aPort]||0)===0)break;await new Promise(r=>setTimeout(r,10));}
   assert.equal(clientClosed,true);assert.equal(Number(router.status().inflightByPort[aPort]||0),0);
 }finally{
   if(router)await router.close();
   if(a){a.closeAllConnections?.();await close(a);}
   fs.rmSync(root,{recursive:true,force:true});
 }
});

test('router exposes conservative per-request drain metadata',async()=>{
 const root=temp();let router,a;try{
   let release;const gate=new Promise(r=>release=r);
   a=http.createServer(async(req,res)=>{await gate;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true}));});
   const aPort=await listen(a),listenPort=await freePort(),stateFile=path.join(root,'router.json');
   writeRouterStateAtomic(stateFile,{schema:1,profile:'default',generation:1,active:{port:aPort,version:'1',commit:'a'.repeat(40),configSha256:'1'.repeat(64)},updatedAt:new Date().toISOString()});
   router=await startRouter({listenPort,stateFile});
   const sub=requestLocal(listenPort,'/mcp',{method:'POST',headers:{'content-type':'application/json','mcp-method':'subscriptions/listen'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'subscriptions/listen'})}).then(r=>r.json());
   const tool=requestLocal(listenPort,'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'run_shell',arguments:{command:'redacted'}}})}).then(r=>r.json());
   for(let i=0;i<80;i++){if(Number(router.status().inflightByPort[aPort]||0)===2)break;await new Promise(r=>setTimeout(r,10));}
   const st=router.status(),details=st.inflightDetailsByPort[aPort];assert.equal(details.length,2);
   const s=details.find(x=>x.rpcMethod==='subscriptions/listen'),m=details.find(x=>x.rpcMethod==='tools/call');
   assert.equal(s.cancellable,true);assert.equal(s.path,'/mcp');
   assert.equal(m.cancellable,false);assert.equal(m.rpcName,'run_shell');
   assert.ok(!JSON.stringify(details).includes('redacted'),'router status must never retain tool arguments');
   release();await Promise.all([sub,tool]);
   for(let i=0;i<50&&Number(router.status().inflightByPort[aPort]||0)>0;i++)await new Promise(r=>setTimeout(r,10));
   assert.equal(Number(router.status().inflightByPort[aPort]||0),0);assert.deepEqual(router.status().inflightDetailsByPort,{});
 }finally{if(router)await router.close();if(a)await close(a);fs.rmSync(root,{recursive:true,force:true});}
});

test('router status and runtime bind the exact loaded source hash',async()=>{
 const root=temp();let router;try{
   const listenPort=await freePort(),deadPort=await freePort(),stateFile=path.join(root,'router.json'),runtimeFile=path.join(root,'router.runtime.json');
   writeRouterStateAtomic(stateFile,{schema:1,profile:'default',generation:1,active:{port:deadPort,version:'1',commit:'a'.repeat(40),configSha256:'1'.repeat(64)},updatedAt:new Date().toISOString()});
   router=await startRouter({listenPort,stateFile,runtimeFile});
   const expected=createHash('sha256').update(fs.readFileSync(new URL('../src/stable-router.mjs',import.meta.url))).digest('hex');
   assert.equal(router.status().sourceSha256,expected);
   const status=await (await requestLocal(listenPort,'/router/status')).json();
   assert.equal(status.sourceSha256,expected);
   const runtime=JSON.parse(fs.readFileSync(runtimeFile,'utf8'));
   assert.equal(runtime.sourceSha256,expected);
   assert.equal(runtime.pid,process.pid);
   assert.equal(runtime.port,listenPort);
 }finally{if(router)await router.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('router generation conflict prevents stale cutover',async()=>{
 const root=temp();try{
   const stateFile=path.join(root,'router.json');
   const s={schema:1,profile:'x',generation:3,active:{port:48000,version:'1',commit:'a'.repeat(40),configSha256:'1'.repeat(64)},updatedAt:new Date().toISOString()};
   writeRouterStateAtomic(stateFile,s);
   assert.throws(()=>writeRouterStateAtomic(stateFile,{...s,generation:4},2),/GENERATION_CONFLICT/);
   assert.equal(JSON.parse(fs.readFileSync(stateFile,'utf8')).generation,3);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('upstream failure cannot underflow inflight accounting',async()=>{
 const root=temp();let router;try{
   const dead=await freePort(),listenPort=await freePort();
   const stateFile=path.join(root,'router.json');
   writeRouterStateAtomic(stateFile,{schema:1,profile:'default',generation:1,active:{port:dead,version:'1',commit:'a'.repeat(40),configSha256:'1'.repeat(64)},updatedAt:new Date().toISOString()});
   router=await startRouter({listenPort,stateFile});
   const r=await requestLocal(listenPort,'/mcp');
   assert.equal(r.status,502);
   for(let i=0;i<20&&Number(router.status().inflightByPort[dead]||0)!==0;i++)await new Promise(r=>setTimeout(r,10));
   assert.equal(Number(router.status().inflightByPort[dead]||0),0);
 }finally{if(router)await router.close();fs.rmSync(root,{recursive:true,force:true});}
});


test('router refuses pre-created temporary state paths without overwriting external data',()=>{
 const root=temp();
 const file=path.join(root,'router-state.json');
 const outside=path.join(root,'synthetic-owner-data.txt');
 const sentinel='SYNTHETIC_OWNER_DATA_UNTOUCHED';
 const state={schema:1,profile:'test',generation:1,active:{port:44000,version:'test',commit:'a'.repeat(40),configSha256:'b'.repeat(64)}};
 const originalOpen=fs.openSync;
 let trapped=false,tempName=null;
 try{
   fs.writeFileSync(outside,sentinel);
   fs.openSync=function(name,flags,mode){
     if(!trapped && typeof name==='string' && name.startsWith(file+'.tmp-') && flags==='wx'){
       trapped=true;tempName=name;
       if(process.platform==='win32'){
         const existing=originalOpen(name,'wx',0o600);
         try{fs.writeSync(existing,Buffer.from('SYNTHETIC_OCCUPIED'));}finally{fs.closeSync(existing);}
       }else fs.symlinkSync(outside,name);
     }
     return originalOpen(name,flags,mode);
   };
   assert.throws(()=>writeRouterStateAtomic(file,state),error=>error.code==='EEXIST');
   assert.equal(trapped,true);
   assert.equal(fs.readFileSync(outside,'utf8'),sentinel);
   assert.equal(fs.existsSync(file),false);
   assert.equal(fs.lstatSync(tempName).isSymbolicLink(),process.platform!=='win32');
 }finally{
   fs.openSync=originalOpen;
   fs.rmSync(root,{recursive:true,force:true});
 }
});

test('router cleans up exclusively created state temp if its write fails',()=>{
 const root=temp();
 const file=path.join(root,'router-state.json');
 const state={schema:1,profile:'test',generation:1,active:{port:44000,version:'test',commit:'a'.repeat(40),configSha256:'b'.repeat(64)}};
 const originalWrite=fs.writeFileSync;
 let triggered=false;
 try{
   writeRouterStateAtomic(file,state);
   fs.writeFileSync=function(target,...args){
     if(typeof target==='number' && !triggered){
       triggered=true;throw new Error('SYNTHETIC_IO_FAILURE');
     }
     return originalWrite(target,...args);
   };
   assert.throws(()=>writeRouterStateAtomic(file,{...state,generation:2},1),/SYNTHETIC_IO_FAILURE/);
   assert.equal(triggered,true);
   assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).generation,1);
   assert.deepEqual(fs.readdirSync(root).filter(name=>name.includes('.tmp-')),[]);
 }finally{
   fs.writeFileSync=originalWrite;
   fs.rmSync(root,{recursive:true,force:true});
 }
});


test('router runtime metadata refuses pre-created temporary path and releases listener',async()=>{
 const root=temp(),stateFile=path.join(root,'state.json'),runtimeFile=path.join(root,'runtime.json');
 const outside=path.join(root,'synthetic-external.txt'),sentinel='OWNER_SYNTHETIC_UNTOUCHED';
 const state={schema:1,profile:'test',generation:1,active:{port:45000,version:'1',commit:'a'.repeat(40),configSha256:'b'.repeat(64)}};
 const port=await freePort(),originalOpen=fs.openSync;
 let injected=false,alias=null;
 try{
   fs.writeFileSync(outside,sentinel);
   writeRouterStateAtomic(stateFile,state);
   fs.openSync=function(name,flags,mode){
     if(!injected && typeof name==='string' && name.startsWith(runtimeFile+'.tmp-') && flags==='wx'){
       injected=true;alias=name;
       if(process.platform==='win32'){
         const fd=originalOpen(name,'wx',0o600);
         try{fs.writeSync(fd,'SYNTHETIC_CONFLICT');}finally{fs.closeSync(fd);}
       }else fs.symlinkSync(outside,name);
     }
     return originalOpen(name,flags,mode);
   };
   await assert.rejects(()=>startRouter({listenPort:port,stateFile,runtimeFile}),error=>error.code==='EEXIST');
   assert.equal(injected,true);
   assert.equal(fs.readFileSync(outside,'utf8'),sentinel);
   assert.equal(fs.existsSync(runtimeFile),false);
   assert.equal(fs.lstatSync(alias).isSymbolicLink(),process.platform!=='win32');
   const fresh=http.createServer((_req,res)=>res.end('freed'));
   await new Promise((resolve,reject)=>{fresh.once('error',reject);fresh.listen(port,'127.0.0.1',resolve);});
   await close(fresh);
 }finally{
   fs.openSync=originalOpen;
   fs.rmSync(root,{recursive:true,force:true});
 }
});

test('router runtime metadata write failure releases listener and preserves state',async()=>{
 const root=temp(),stateFile=path.join(root,'state.json'),runtimeFile=path.join(root,'runtime.json');
 const state={schema:1,profile:'test',generation:1,active:{port:45000,version:'1',commit:'a'.repeat(40),configSha256:'b'.repeat(64)}};
 const port=await freePort(),originalWrite=fs.writeFileSync;
 let tripped=false;
 try{
   writeRouterStateAtomic(stateFile,state);
   fs.writeFileSync=function(destination,...args){
     if(typeof destination==='number'&&!tripped){tripped=true;throw new Error('SYNTHETIC_RUNTIME_IO_FAILURE');}
     return originalWrite(destination,...args);
   };
   await assert.rejects(()=>startRouter({listenPort:port,stateFile,runtimeFile}),/SYNTHETIC_RUNTIME_IO_FAILURE/);
   assert.equal(tripped,true);
   assert.equal(fs.existsSync(runtimeFile),false);
   assert.equal(JSON.parse(fs.readFileSync(stateFile,'utf8')).generation,1);
   assert.deepEqual(fs.readdirSync(root).filter(name=>name.includes('.tmp-')),[]);
   const fresh=http.createServer((_req,res)=>res.end('freed'));
   await new Promise((resolve,reject)=>{fresh.once('error',reject);fresh.listen(port,'127.0.0.1',resolve);});
   await close(fresh);
 }finally{
   fs.writeFileSync=originalWrite;
   fs.rmSync(root,{recursive:true,force:true});
 }
});

test('router CAS serializes separate processes and rejects concurrent stale generation',()=>{
 const root=temp(),file=path.join(root,'state.json'),oldRename=fs.renameSync;
 const state={schema:1,profile:'qa',generation:1,active:{port:41001,version:'qa',commit:'a'.repeat(40),configSha256:'b'.repeat(64)}};
 const next={...state,generation:2,active:{...state.active,port:41002}};
 const competing={...state,generation:2,active:{...state.active,port:41003}};
 const worker="import {writeRouterStateAtomic} from "+JSON.stringify(new URL('../src/stable-router.mjs',import.meta.url).href)+";\n"+
   "const file=process.env.ROUTER_QA_FILE, state="+JSON.stringify(competing)+";\n"+
   "try {writeRouterStateAtomic(file,state,1);process.exitCode=7;} catch(error) {process.exitCode=error?.message==='ROUTER_STATE_WRITE_LOCKED'?0:9;}\n";
 let seen=false,child;
 try {
   writeRouterStateAtomic(file,state);
   fs.renameSync=function(src,dst){
     if(!seen&&dst===file){
       seen=true;
       child=spawnSync(process.execPath,['--input-type=module','-e',worker],{
         env:{...process.env,ROUTER_QA_FILE:file},encoding:'utf8',timeout:5000
       });
     }
     return oldRename.apply(fs,arguments);
   };
   writeRouterStateAtomic(file,next,1);
   assert.equal(seen,true);
   assert.equal(child?.status,0,JSON.stringify({status:child?.status,signal:child?.signal,stderr:child?.stderr}));
   assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).active.port,41002);
   fs.renameSync=oldRename;
   assert.throws(()=>writeRouterStateAtomic(file,competing,1),/ROUTER_GENERATION_CONFLICT/);
   writeRouterStateAtomic(file,{...next,generation:3},2);
   assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).generation,3);
   assert.equal(fs.existsSync(file+'.write-lock'),false);
 }finally{fs.renameSync=oldRename;fs.rmSync(root,{recursive:true,force:true});}
});

test('router pre-existing lock is fail-closed and never removed by a losing writer',()=>{
 const root=temp(),file=path.join(root,'state.json'),lock=file+'.write-lock';
 const state={schema:1,profile:'qa',generation:1,active:{port:41001,version:'qa',commit:'a'.repeat(40),configSha256:'b'.repeat(64)}};
 try{
   fs.writeFileSync(lock,'SYNTHETIC_UNCERTAIN_LOCK',{mode:0o600,flag:'wx'});
   assert.throws(()=>writeRouterStateAtomic(file,state),/ROUTER_STATE_WRITE_LOCKED/);
   assert.equal(fs.readFileSync(lock,'utf8'),'SYNTHETIC_UNCERTAIN_LOCK');
   assert.equal(fs.existsSync(file),false);
   fs.unlinkSync(lock);
   writeRouterStateAtomic(file,state);
   assert.equal(fs.existsSync(lock),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('router refuses POSIX group-writable state parent', {skip:process.platform==='win32'},()=>{
 const root=temp(),file=path.join(root,'state.json');
 const state={schema:1,profile:'qa',generation:1,active:{port:41001,version:'qa',commit:'a'.repeat(40),configSha256:'b'.repeat(64)}};
 try{
   fs.chmodSync(root,0o770);
   assert.throws(()=>writeRouterStateAtomic(file,state),/ROUTER_STATE_UNTRUSTED_PARENT/);
   assert.equal(fs.existsSync(file),false);
 }finally{fs.chmodSync(root,0o700);fs.rmSync(root,{recursive:true,force:true});}
});


test('router rejects a group/world-writable nonsticky ancestor before first state write', {skip:process.platform==='win32'},()=>{
 const root=temp(),outer=path.join(root,'writable-ancestor'),privateDir=path.join(outer,'private');
 const file=path.join(privateDir,'state.json');
 const state={schema:1,profile:'qa',generation:1,active:{port:41001,version:'qa',commit:'a'.repeat(40),configSha256:'b'.repeat(64)}};
 try {
  fs.mkdirSync(privateDir,{recursive:true,mode:0o700});fs.chmodSync(outer,0o777);
  assert.throws(()=>writeRouterStateAtomic(file,state),/ROUTER_STATE_UNTRUSTED_ANCESTOR/);
  assert.equal(fs.existsSync(file),false);
  assert.equal(fs.existsSync(file+'.write-lock'),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('router rechecks its namespace after lock open to stop initial write ancestor swap', {skip:process.platform==='win32'},()=>{
 const root=temp(),outer=path.join(root,'controlled'),privateDir=path.join(outer,'private'),outside=path.join(root,'outside');
 const file=path.join(privateDir,'state.json'),outsideFile=path.join(outside,'state.json');
 const state={schema:1,profile:'qa',generation:1,active:{port:41001,version:'qa',commit:'a'.repeat(40),configSha256:'b'.repeat(64)}};
 const originalOpen=fs.openSync;let swapped=false;
 try{
  fs.mkdirSync(privateDir,{recursive:true,mode:0o700});fs.mkdirSync(outside,{mode:0o700});
  fs.writeFileSync(outsideFile,'OUTSIDE_SENTINEL');
  fs.openSync=function(p,...args){
   if(!swapped&&p===file+'.write-lock'){
    swapped=true;fs.renameSync(privateDir,privateDir+'-moved');fs.symlinkSync(outside,privateDir,'dir');
   }
   return originalOpen.call(fs,p,...args);
  };
  assert.throws(()=>writeRouterStateAtomic(file,state),/ROUTER_LINK_NOT_ALLOWED/);
  assert.equal(swapped,true);
  assert.equal(fs.readFileSync(outsideFile,'utf8'),'OUTSIDE_SENTINEL');
  assert.equal(fs.existsSync(path.join(privateDir+'-moved','state.json')),false);
  assert.equal(fs.existsSync(path.join(outside,'state.json.write-lock')),false);
 }finally{fs.openSync=originalOpen;fs.rmSync(root,{recursive:true,force:true});}
});
