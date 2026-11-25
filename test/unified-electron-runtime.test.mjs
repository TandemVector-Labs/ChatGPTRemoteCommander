import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const {preparePreviewCore,previewConfig}=require('../packaging/unified/pilot-runtime.cjs');
const unpacked=path.join(repo,'dist/unified',process.platform==='win32'?'win-unpacked':'linux-unpacked');
const exe=path.join(unpacked,process.platform==='win32'?'Remote Commander.exe':'remote-commander-unified');
const resources=path.join(unpacked,'resources/core');
const available=fs.existsSync(exe)&&fs.existsSync(resources);
function freePort(){
  return new Promise((resolve,reject)=>{
    const s=net.createServer();
    s.on('error',reject);
    s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(e=>e?reject(e):resolve(port));});
  });
}
test('bundled Electron Node starts exact Core via isolated loopback health', {skip:!available},async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-electron-runtime-'));
 let child=null;
 try{
   const {target,head}=preparePreviewCore(resources,temp);
   assert.match(head,/^[a-f0-9]{40}$/);
   const port=await freePort();
   const {file}=previewConfig(target,temp,port);
   child=spawn(exe,[path.join(target,'src/server-v0.3.mjs')],{
      cwd:target,windowsHide:true,stdio:['ignore','pipe','pipe'],
      env:{...process.env,ELECTRON_RUN_AS_NODE:'1',REMOTE_COMMANDER_CONFIG:file,COMMANDER_ONE_REQUIRE_TRUSTED_INGRESS:'0'}
   });
   let logs='';
   for(const stream of [child.stdout,child.stderr]) stream.on('data',d=>{logs=(logs+d.toString()).slice(-2800);});
   let passed=false;
   const start=Date.now();
   while(Date.now()-start<12000 && child.exitCode===null){
     passed=await new Promise(resolve=>{
       const req=http.get({hostname:'127.0.0.1',port,path:'/health',timeout:700},res=>{
         res.resume();resolve(res.statusCode===200);
       });
       req.on('error',()=>resolve(false));
       req.on('timeout',()=>{req.destroy();resolve(false);});
     });
     if(passed)break;
     await new Promise(resolve=>setTimeout(resolve,200));
   }
   assert.ok(passed,'embedded Electron Node Core health must pass: '+logs);
 }finally{
   if(child){
     child.kill();
     await new Promise(resolve=>{
       if(child.exitCode!==null)return resolve();
       child.once('exit',resolve);
       const t=setTimeout(resolve,1500);t.unref();
     });
   }
   fs.rmSync(temp,{recursive:true,force:true});
 }
});
