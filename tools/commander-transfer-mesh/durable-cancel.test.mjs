import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('./durable-send.mjs',import.meta.url));
function installedCli(root){
 const target=path.join(root,'durable-send.mjs');
 if(!fs.existsSync(target))fs.copyFileSync(cli,target,fs.constants.COPYFILE_EXCL);
 return target;
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function cmd(root,...args){return JSON.parse(execFileSync(process.execPath,[installedCli(root),...args],{encoding:'utf8',timeout:10000,env:{...process.env,COMMANDER_TRANSFER_HOME:root}}));}
async function published(root,id){
 let state;
 for(let i=0;i<180;i++){
  state=cmd(root,'job-status','--peer','Linux','--id',id);
  if(state.status==='PUBLISHED')return state;
  assert.notEqual(state.status,'FAILED',JSON.stringify(state));
  await wait(40);
 }
 throw Error('PUBLISH_TIMEOUT '+JSON.stringify(state));
}
function makeRoot(id){
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-cancel-race-')));
 const allowed=path.join(root,'allowed');fs.mkdirSync(allowed);
 fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'PC'}));
 const file=path.join(allowed,'source.dat');const bytes=crypto.randomBytes(8192);fs.writeFileSync(file,bytes);
 const st=fs.statSync(file);
 const jobDir=path.join(root,'jobs','Linux');fs.mkdirSync(jobDir,{recursive:true});
 const dest=path.join(root,'pairs','Linux','transfers',id);
 const journal={schema:'ctmesh-durable-v1',id,peer:'Linux',from:'PC',path:file,sourceRoot:allowed,name:'source.dat',bytes:bytes.length,
  mtimeMs:st.mtimeMs,ino:st.ino,dev:st.dev,copiedBytes:bytes.length,status:'INTERRUPTED',createdAt:new Date().toISOString(),pid:null};
 fs.writeFileSync(path.join(jobDir,id+'.json'),JSON.stringify(journal));
 return {root,allowed,file,bytes,dest,journal,jobDir};
}
test('cancel after payload publication cannot erase delivery state; explicit resume repairs metadata',async()=>{
 const f=makeRoot('cancel-race-001');
 try{
  fs.mkdirSync(f.dest,{recursive:true});
  fs.copyFileSync(f.file,path.join(f.dest,'payload.bin'));
  const rec=path.join(f.jobDir,'cancel-race-001.json');
  fs.writeFileSync(rec,JSON.stringify({...f.journal,status:'CANCEL_REQUESTED',pid:9999999}));
  const status=cmd(f.root,'job-status','--peer','Linux','--id','cancel-race-001');
  assert.equal(status.status,'INTERRUPTED');
  assert.equal(status.errorCode,'PUBLISH_RECOVERY_REQUIRED');
  assert.throws(()=>cmd(f.root,'cancel','--peer','Linux','--id','cancel-race-001'),/TRANSFER_PUBLISHED_RECOVERY_REQUIRED/);
  assert.equal(cmd(f.root,'resume','--peer','Linux','--id','cancel-race-001').status,'QUEUED');
  const result=await published(f.root,'cancel-race-001');
  assert.equal(result.sha256,crypto.createHash('sha256').update(f.bytes).digest('hex'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dest,'manifest.json'),'utf8')).sha256,result.sha256);
 }finally{await wait(150);fs.rmSync(f.root,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});
test('power interruption between publication folder creation and rename is recoverable without overwrite',async()=>{
 const f=makeRoot('empty-dest-002');
 try{
  fs.mkdirSync(f.dest,{recursive:true});
  const stage=path.join(f.root,'staging','Linux');fs.mkdirSync(stage,{recursive:true});
  fs.writeFileSync(path.join(stage,'empty-dest-002.part'),f.bytes);
  assert.equal(cmd(f.root,'resume','--peer','Linux','--id','empty-dest-002').status,'QUEUED');
  const finished=await published(f.root,'empty-dest-002');
  assert.deepEqual(fs.readFileSync(path.join(f.dest,'payload.bin')),f.bytes);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dest,'manifest.json'),'utf8')).sha256,finished.sha256);
 }finally{await wait(150);fs.rmSync(f.root,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});
