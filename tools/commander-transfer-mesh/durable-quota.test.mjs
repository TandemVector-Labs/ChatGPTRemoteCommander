import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('./durable-send.mjs',import.meta.url));
const call=(root,...args)=>execFileSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:12000,env:{...process.env,COMMANDER_TRANSFER_HOME:root}});
test('limits fail closed before queue admission and do not leave admission locks',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-quota-'));
 try{
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'PC'}));
  const allowed=path.join(root,'allowed');fs.mkdirSync(allowed);
  const source=path.join(allowed,'payload.dat');fs.writeFileSync(source,Buffer.alloc(8192,0x23));
  const args=['enqueue','--peer','Linux','--path',source,'--source-root',allowed,'--id','quota-test-001'];
  assert.throws(()=>call(root,...args,'--max-source-bytes','4096'),/TRANSFER_SOURCE_SIZE_QUOTA/);
  assert.equal(fs.existsSync(path.join(root,'jobs','Linux','quota-test-001.json')),false);
  const qdir=path.join(root,'jobs','Linux');
  const pending=path.join(qdir,'old.json');fs.writeFileSync(pending,JSON.stringify({schema:'ctmesh-durable-v1',bytes:16384,status:'QUEUED'}));
  assert.throws(()=>call(root,...args,'--max-source-bytes','16000','--max-pending-bytes','20000','--max-active-jobs','2'),/TRANSFER_PENDING_BYTES_QUOTA/);
  assert.throws(()=>call(root,...args,'--max-active-jobs','1'),/TRANSFER_CONCURRENT_JOBS_QUOTA/);
  assert.throws(()=>call(root,...args,'--max-active-jobs','0'),/QUOTA_INVALID_maxActiveJobs/);
  assert.equal(fs.existsSync(path.join(root,'jobs','.admission.lock')),false);
  fs.writeFileSync(pending,JSON.stringify({schema:'ctmesh-durable-v1',bytes:16384,status:'CANCELLED'}));
  const queued=JSON.parse(call(root,...args,'--max-source-bytes','32768','--max-pending-bytes','32768','--max-active-jobs','1'));
  assert.equal(queued.status,'QUEUED');
  let state;for(let i=0;i<200;i++){
   // Journal replacement is atomic: an in-flight status read may correctly
   // fail closed on the inode/metadata race. Retry that explicit transient
   // error, but never treat an unverified record as a successful status.
   try{
    state=JSON.parse(call(root,'job-status','--peer','Linux','--id','quota-test-001'));
   }catch(e){
    if(!/CTMESH_DURABLE_ERROR:UNTRUSTED_JOB_RECORD/.test(String(e.stderr)))throw e;
    await new Promise(r=>setTimeout(r,30));
    continue;
   }
   if(state.status==='PUBLISHED'||state.status==='FAILED')break;
   await new Promise(r=>setTimeout(r,30));
  }
  assert.equal(state.status,'PUBLISHED',JSON.stringify(state));
 }finally{
  await new Promise(r=>setTimeout(r,200));
  fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:150});
 }
});

test('disk admission reserves all existing unfinished bytes, even if jobs have not copied yet',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-capacity-'));
 try{
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'PC'}));
  const src=path.join(root,'allowed');fs.mkdirSync(src);
  const f=path.join(src,'sample.bin');fs.writeFileSync(f,Buffer.alloc(1024));
  const dir=path.join(root,'jobs','Linux');fs.mkdirSync(dir,{recursive:true});
  const stats=fs.statfsSync(root,{bigint:true});
  const free=stats.bavail*stats.bsize;
  if(free>BigInt(Number.MAX_SAFE_INTEGER-4096))return;
  fs.writeFileSync(path.join(dir,'reserved.json'),JSON.stringify({schema:'ctmesh-durable-v1',bytes:Number(free),status:'FAILED'}));
  assert.throws(()=>call(root,'enqueue','--peer','Linux','--path',f,'--source-root',src,'--id','space-guard-001',
   '--max-source-bytes','4096','--max-pending-bytes',String(Number(free)+4096),'--max-active-jobs','3'),/TRANSFER_DISK_SPACE_QUOTA/);
  assert.equal(fs.existsSync(path.join(dir,'space-guard-001.json')),false);
  assert.equal(fs.existsSync(path.join(root,'jobs','.admission.lock')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
