import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('./durable-send.mjs',import.meta.url));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
function call(root,...args){const o=execFileSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:12000,env:{...process.env,COMMANDER_TRANSFER_HOME:root}});return JSON.parse(o);}
async function until(root,id,states,timeout=25000){
 const f=path.join(root,'jobs','Linux',id+'.json');const start=Date.now();
 let last;
 while(Date.now()-start<timeout){
  last=JSON.parse(fs.readFileSync(f,'utf8'));
  if(states.includes(last.status))return last;
  await wait(20);
 }
 // Preserve a bounded, nonsecret diagnostic: a real worker stall must remain
 // a failed test, not be silently skipped or excused by a longer timeout.
 throw Error('TIMED_OUT_WAITING_FOR_'+states.join(',')+
  '_STATUS_'+String(last?.status??'UNKNOWN')+
  '_COPIED_'+String(last?.copiedBytes??'UNKNOWN')+
  '_EXPECTED_'+String(last?.bytes??'UNKNOWN'));
}
// Hosted Windows runners can take longer than 30s to copy and hash 512 MiB
// after process termination. Keep the full payload and all integrity assertions;
// increase only the test wait budget and fail on an actually stalled worker.
test('real worker termination during partial copy can be resumed and hash-verified', {timeout:150000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-kill-resume-'));
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
  while(Date.now()-started<20000){
   const state=JSON.parse(fs.readFileSync(record,'utf8'));
   if(state.status==='COPYING'&&state.copiedBytes>=16*1024*1024&&state.copiedBytes<state.bytes){
    copying=state;break;
   }
   if(state.status==='PUBLISHED')break;
   await wait(10);
  }
  if(!copying){
   const state=JSON.parse(fs.readFileSync(record,'utf8'));
   if(state.status==='PUBLISHED'){
    t.skip('Worker finished before controlled crash could be observed');return;
   }
   assert.fail('Worker never reached a crashable COPY state; status='+state.status+
     ' bytes='+state.copiedBytes+'/'+state.bytes);
  }
  workerPid=copying.pid;
  assert.equal(Number.isInteger(workerPid),true);
  process.kill(workerPid,'SIGTERM');
  for(let i=0;i<500&&alive(workerPid);i++)await wait(15);
  assert.equal(alive(workerPid),false,'Worker must terminate before resume');
  const interrupted=call(root,'job-status','--peer','Linux','--id','kill-test-001');
  assert.equal(interrupted.status,'INTERRUPTED');
  assert.ok(interrupted.copiedBytes>=16*1024*1024);
  const resumed=call(root,'resume','--peer','Linux','--id','kill-test-001');
  assert.equal(resumed.status,'QUEUED');
  const finished=await until(root,'kill-test-001',['PUBLISHED','FAILED'],90000);
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
