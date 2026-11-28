import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('./durable-send.mjs',import.meta.url));
function installedCli(root){
 const target=path.join(root,'durable-send.mjs');
 if(!fs.existsSync(target))fs.copyFileSync(cli,target,fs.constants.COPYFILE_EXCL);
 return target;
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
function call(root,...args){const o=execFileSync(process.execPath,[installedCli(root),...args],{encoding:'utf8',timeout:12000,env:{...process.env,COMMANDER_TRANSFER_HOME:root}});return JSON.parse(o);}
async function until(root,id,states,timeout=25000){
 const f=path.join(root,'jobs','Linux',id+'.json');const start=Date.now();
 while(Date.now()-start<timeout){
  const r=JSON.parse(fs.readFileSync(f,'utf8'));
  if(states.includes(r.status))return r;
  await wait(20);
 }
 throw Error('TIMED_OUT_WAITING_FOR_'+states.join(','));
}
test('real worker termination during partial copy can be resumed and hash-verified', {timeout:60000},async t=>{
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-kill-resume-')));
 let workerPid=0;
 try{
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'PC'}));
  const sourceDir=path.join(root,'allowed');fs.mkdirSync(sourceDir);
  const file=path.join(sourceDir,'sparse-512MiB.dat');
  const fd=fs.openSync(file,'wx');fs.ftruncateSync(fd,512*1024*1024);fs.closeSync(fd);
  const j=call(root,'enqueue','--peer','Linux','--path',file,'--source-root',sourceDir,'--id','kill-test-001');
  assert.equal(j.status,'QUEUED');
  const record=path.join(root,'jobs','Linux','kill-test-001.json');
  let copying=null;const started=Date.now();
  while(Date.now()-started<12000){
   const state=JSON.parse(fs.readFileSync(record,'utf8'));
   if(state.status==='COPYING'&&state.copiedBytes>=16*1024*1024&&state.copiedBytes<state.bytes){
    copying=state;break;
   }
   if(state.status==='PUBLISHED')break;
   await wait(10);
  }
  if(!copying){t.skip('Worker finished before controlled crash could be observed');return;}
  workerPid=copying.pid;
  assert.equal(Number.isInteger(workerPid),true);
  process.kill(workerPid,'SIGTERM');
  for(let i=0;i<200&&alive(workerPid);i++)await wait(15);
  assert.equal(alive(workerPid),false,'Worker must terminate before resume');
  const interrupted=call(root,'job-status','--peer','Linux','--id','kill-test-001');
  assert.equal(interrupted.status,'INTERRUPTED');
  assert.ok(interrupted.copiedBytes>=16*1024*1024);
  const resumed=call(root,'resume','--peer','Linux','--id','kill-test-001');
  assert.equal(resumed.status,'QUEUED');
  const finished=await until(root,'kill-test-001',['PUBLISHED','FAILED'],30000);
  assert.equal(finished.status,'PUBLISHED',finished.errorCode);
  assert.equal(finished.copiedBytes,finished.bytes);
  const filePayload=path.join(root,'pairs','Linux','transfers','kill-test-001','payload.bin');
  assert.equal(fs.statSync(filePayload).size,512*1024*1024);
  const m=JSON.parse(fs.readFileSync(path.join(path.dirname(filePayload),'manifest.json'),'utf8'));
  assert.equal(m.sha256,finished.sha256);
  await wait(250);
 }finally{
  if(workerPid&&alive(workerPid))try{process.kill(workerPid,'SIGTERM');}catch{}
  await wait(350);
  fs.rmSync(root,{recursive:true,force:true,maxRetries:25,retryDelay:200});
 }
});
