import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=path.resolve(path.dirname(fileURLToPath(import.meta.url)),
 '../tools/commander-transfer-mesh/durable-send.mjs');
function exercise(mode){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-durable-gen-'+mode+'-'));
 const id='race-lifecycle-001',peer='Linux';
 const dir=path.join(root,'jobs',peer),lock=mode==='admission'
  ?path.join(root,'jobs','.admission.lock'):path.join(dir,id+'.lock');
 const preload=path.join(root,'rename-hook.cjs'),marker=path.join(root,'race-fired');
 try{
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'PC'})+'\n');
  fs.writeFileSync(preload,[
   "const fs=require('node:fs'),path=require('node:path'),mod=require('node:module');",
   "const orig=fs.renameSync;let fired=false;",
   "fs.renameSync=function(from,to,...rest){",
   " if(!fired&&path.resolve(String(from)).toLowerCase()===path.resolve(process.env.RC_GEN_LOCK).toLowerCase()){",
   "  fired=true;orig(from,String(from)+'.old');",
   "  fs.writeFileSync(from,JSON.stringify({pid:process.pid,kind:'new-generation'})+'\\n');",
   "  fs.writeFileSync(process.env.RC_GEN_MARKER,'FIRED');",
   " }",
   " return orig.call(this,from,to,...rest);",
   "};mod.syncBuiltinESMExports();"
  ].join('\n'));
  let args;
  if(mode==='admission'){
   const folder=path.join(root,'source');fs.mkdirSync(folder);
   const source=path.join(folder,'payload.dat');fs.writeFileSync(source,'disposable-data');
   args=['enqueue','--peer',peer,'--id',id,'--path',source,'--source-root',folder];
  }else{
   fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify({schema:'ctmesh-durable-v1',
    id,peer,status:'QUEUED',path:path.join(root,'missing.dat'),
    sourceRoot:root,createdAt:new Date().toISOString()})+'\n');
   args=['work','--peer',peer,'--id',id];
  }
  const proc=spawnSync(process.execPath,[cli,...args],{env:{...process.env,
   COMMANDER_TRANSFER_HOME:root,NODE_OPTIONS:'--require='+preload,
   RC_GEN_LOCK:lock,RC_GEN_MARKER:marker},timeout:8000,encoding:'utf8',windowsHide:true});
  assert.equal(fs.existsSync(marker),true,'real cleanup path must attempt removal');
  const preserved=fs.existsSync(lock);
  assert.equal(preserved,true,'new owner generation must remain discoverable');
  assert.equal(JSON.parse(fs.readFileSync(lock,'utf8')).kind,'new-generation');
  assert.notEqual(proc.status,0,'detect generation change instead of claiming success');
 }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:60});}
}
test('admission cleanup never removes a replaced lock generation',()=>exercise('admission'));
test('worker finally never removes a replaced lock generation',()=>exercise('worker'));
