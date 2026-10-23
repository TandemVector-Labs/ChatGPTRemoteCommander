import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('./durable-send.mjs',import.meta.url));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function call(root,...args){const raw=execFileSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10000,env:{...process.env,COMMANDER_TRANSFER_HOME:root}}).trim();return JSON.parse(raw);}
async function done(root,peer,id){
 for(let i=0;i<200;i++){
  const r=call(root,'job-status','--peer',peer,'--id',id);
  if(r.status==='PUBLISHED')return r;
  if(r.status==='FAILED'||r.status==='CANCELLED')throw Error(JSON.stringify(r));
  await sleep(60);
 }
 throw Error('JOB_TIMEOUT');
}
test('durable job stages multi-MiB file without synchronous RPC timeout and publishes verified manifest',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-durable-'));
 try{
  const allowed=path.join(root,'source');fs.mkdirSync(allowed);
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'PC'}));
  const file=path.join(allowed,'durable-test.bin');
  const payload=crypto.randomBytes(24*1024*1024);
  fs.writeFileSync(file,payload);
  const start=Date.now();
  const enqueue=call(root,'enqueue','--peer','Linux','--path',file,'--source-root',allowed,'--id','durable-001');
  assert.equal(enqueue.status,'QUEUED');
  assert.ok(Date.now()-start<7000);
  const result=await done(root,'Linux','durable-001');
  assert.equal(result.bytes,payload.length);
  assert.equal(result.sha256,crypto.createHash('sha256').update(payload).digest('hex'));
  const destination=path.join(root,'pairs','Linux','transfers','durable-001');
  assert.deepEqual(fs.readFileSync(path.join(destination,'payload.bin')),payload);
  const manifest=JSON.parse(fs.readFileSync(path.join(destination,'manifest.json'),'utf8'));
  assert.equal(manifest.sha256,result.sha256);
  assert.throws(()=>call(root,'enqueue','--peer','Linux','--path',file,'--source-root',allowed,'--id','durable-001'));
  // Deterministic simulated crash: partial exists, journal is interrupted.
  const jobDir=path.join(root,'jobs','Linux');
  const original=JSON.parse(fs.readFileSync(path.join(jobDir,'durable-001.json'),'utf8'));
  const resume={...original,id:'durable-resume-002',sha256:null,status:'INTERRUPTED',copiedBytes:1024*1024,pid:null};
  fs.writeFileSync(path.join(jobDir,'durable-resume-002.json'),JSON.stringify(resume));
  const staging=path.join(root,'staging','Linux','durable-resume-002.part');
  fs.writeFileSync(staging,payload.subarray(0,1024*1024));
  const restarted=call(root,'resume','--peer','Linux','--id','durable-resume-002');
  assert.equal(restarted.status,'QUEUED');
  const finished=await done(root,'Linux','durable-resume-002');
  assert.equal(finished.sha256,result.sha256);
  // Crash at publish boundary: payload exists, journal incomplete, manifest absent.
  const recover={...original,id:'durable-boundary-003',sha256:null,status:'INTERRUPTED',copiedBytes:payload.length,pid:null};
  fs.writeFileSync(path.join(jobDir,'durable-boundary-003.json'),JSON.stringify(recover));
  const partialDest=path.join(root,'pairs','Linux','transfers','durable-boundary-003');fs.mkdirSync(partialDest,{mode:0o700});
  fs.copyFileSync(file,path.join(partialDest,'payload.bin'));
  call(root,'resume','--peer','Linux','--id','durable-boundary-003');
  const repaired=await done(root,'Linux','durable-boundary-003');
  assert.equal(repaired.sha256,result.sha256);
  assert.equal(JSON.parse(fs.readFileSync(path.join(partialDest,'manifest.json'),'utf8')).sha256,result.sha256);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('durable enqueue refuses source outside allowlisted root',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-durable-deny-'));
 try{
  const allow=path.join(root,'allowed');fs.mkdirSync(allow);
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'PC'}));
  const outside=path.join(root,'outside.txt');fs.writeFileSync(outside,'secret');
  assert.throws(()=>call(root,'enqueue','--peer','Linux','--path',outside,'--source-root',allow,'--id','durable-unsafe-001'));
  assert.equal(fs.existsSync(path.join(root,'jobs','Linux','durable-unsafe-001.json')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('durable job-status rejects symlinks escaping its private managed tree',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-symlink-reject-'));
 try{
  const home=path.join(root,'home'),outside=path.join(root,'out');
  fs.mkdirSync(home);fs.mkdirSync(outside);fs.mkdirSync(path.join(home,'jobs'));
  fs.writeFileSync(path.join(home,'node.json'),JSON.stringify({alias:'PC'}));
  const id='audit-safe-id',external=path.join(outside,id+'.json');
  const marker={schema:'ctmesh-durable-v1',id,peer:'Linux',status:'PUBLISHED',bytes:11,copiedBytes:11,sha256:'a'.repeat(64)};
  fs.writeFileSync(external,JSON.stringify(marker));
  try{fs.symlinkSync(outside,path.join(home,'jobs','Linux'),'dir');}
  catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('Symlink creation not permitted');return;}throw e;}
  const result=spawnSync(process.execPath,[cli,'job-status','--peer','Linux','--id',id],{encoding:'utf8',timeout:4000,env:{...process.env,COMMANDER_TRANSFER_HOME:home}});
  assert.equal(result.status,1);
  assert.match(result.stderr,/TRANSFER_MANAGED_PATH_UNSAFE/);
  assert.equal(result.stdout,'');
  assert.equal(fs.readFileSync(external,'utf8'),JSON.stringify(marker));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('durable job-status rejects a symlinked record even under a normal directory',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-symlink-record-'));
 try{
  const home=path.join(root,'home'),outside=path.join(root,'outside.json');
  fs.mkdirSync(home);fs.mkdirSync(path.join(home,'jobs'));fs.mkdirSync(path.join(home,'jobs','Linux'));
  fs.writeFileSync(outside,JSON.stringify({id:'audit-record',status:'PUBLISHED'}));
  try{fs.symlinkSync(outside,path.join(home,'jobs','Linux','audit-record.json'),'file');}
  catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('Symlink creation not permitted');return;}throw e;}
  const result=spawnSync(process.execPath,[cli,'job-status','--peer','Linux','--id','audit-record'],{encoding:'utf8',timeout:4000,env:{...process.env,COMMANDER_TRANSFER_HOME:home}});
  assert.equal(result.status,1);
  assert.match(result.stderr,/TRANSFER_MANAGED_PATH_UNSAFE/);
  assert.equal(fs.readFileSync(outside,'utf8'),JSON.stringify({id:'audit-record',status:'PUBLISHED'}));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('durable worker refuses a staging symlink swapped at descriptor open',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-stage-swap-'));
 try{
  const sourceDir=path.join(root,'source'),jobs=path.join(root,'jobs','Linux'),
    stageDir=path.join(root,'staging','Linux'),id='race-stage-001';
  fs.mkdirSync(sourceDir);fs.mkdirSync(jobs,{recursive:true});
  fs.mkdirSync(stageDir,{recursive:true});
  const external=path.join(root,'outside.bin'),probe=path.join(root,'probe-link');
  fs.writeFileSync(external,'OUTSIDE_UNCHANGED');
  try{fs.symlinkSync(external,probe,'file');fs.unlinkSync(probe);}
  catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('Symlink creation not permitted');return;}throw e;}
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'PC'}));
  const source=path.join(sourceDir,'data.bin'),bytes=Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  fs.writeFileSync(source,bytes);
  const stat=fs.statSync(source),part=path.join(stageDir,id+'.part');
  fs.writeFileSync(part,'');
  const record=path.join(jobs,id+'.json');
  const j={schema:'ctmesh-durable-v1',id,peer:'Linux',from:'PC',path:source,
    sourceRoot:sourceDir,name:'data.bin',bytes:bytes.length,mtimeMs:stat.mtimeMs,
    ino:stat.ino,dev:stat.dev,copiedBytes:0,status:'QUEUED',createdAt:new Date().toISOString()};
  fs.writeFileSync(record,JSON.stringify(j));
  const hookPath=path.join(root,'swap-hook.cjs');
  fs.writeFileSync(hookPath,[
   "const fs=require('node:fs'),path=require('node:path');",
   "const orig=fs.openSync;",
   "let swapped=false;",
   "fs.openSync=function(file,flags,...rest){",
   " const rw=flags==='r+'||(typeof flags==='number'&&(flags&fs.constants.O_RDWR)===fs.constants.O_RDWR);",
   " if(!swapped&&rw&&path.basename(String(file))===path.basename(process.env.RC_SWAP_PART)){",
   "   swapped=true;",
   "   fs.renameSync(file,file+'.checked');",
   "   fs.symlinkSync(process.env.RC_SWAP_TARGET,file,'file');",
   " }",
   " return orig.call(this,file,flags,...rest);",
   "};"
  ].join('\n'));
  const r=spawnSync(process.execPath,[cli,'work','--peer','Linux','--id',id],{
   encoding:'utf8',timeout:6000,
   env:{...process.env,NODE_OPTIONS:'--require '+hookPath,COMMANDER_TRANSFER_HOME:root,
    RC_SWAP_PART:part,RC_SWAP_TARGET:external}});
  assert.equal(r.status,0,r.stderr);
  assert.equal(fs.readFileSync(external,'utf8'),'OUTSIDE_UNCHANGED',
    'No data may be written through a post-check symlink replacement');
  assert.equal(JSON.parse(fs.readFileSync(record,'utf8')).status,'FAILED');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('job-status never consumes a post-check substituted record symlink',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-record-swap-'));
 try{
  const jobDir=path.join(root,'jobs','Linux'),id='record-swap-001';
  fs.mkdirSync(jobDir,{recursive:true});
  const record=path.join(jobDir,id+'.json'),outside=path.join(root,'outside.json'),probe=path.join(root,'link-probe');
  const safe={schema:'ctmesh-durable-v1',id,peer:'Linux',status:'QUEUED',bytes:4,createdAt:new Date().toISOString()};
  const fake={...safe,status:'PUBLISHED'};
  fs.writeFileSync(record,JSON.stringify(safe));
  fs.writeFileSync(outside,JSON.stringify(fake));
  try{fs.symlinkSync(outside,probe,'file');fs.unlinkSync(probe);}
  catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('Symlink creation unavailable');return;}throw e;}
  const hook=path.join(root,'swap-hook.cjs');
  fs.writeFileSync(hook,[
   "const fs=require('node:fs');",
   "const rd=fs.readFileSync,op=fs.openSync;",
   "let swapped=false;",
   "function replace(file){if(!swapped&&(String(file)===process.env.RC_RECORD||(String(file).startsWith('/proc/self/fd/')&&String(file).endsWith('/'+require('node:path').basename(process.env.RC_RECORD))))){",
   " swapped=true; fs.renameSync(file,file+'.checked');",
   " fs.symlinkSync(process.env.RC_OUTSIDE,file,'file');",
   "}}",
   "fs.readFileSync=function(file,...rest){replace(file);return rd.call(this,file,...rest);};",
   "fs.openSync=function(file,...rest){replace(file);return op.call(this,file,...rest);};"
  ].join('\n'));
  const r=spawnSync(process.execPath,[cli,'job-status','--peer','Linux','--id',id],{
   encoding:'utf8',timeout:6000,
   env:{...process.env,NODE_OPTIONS:'--require '+hook,COMMANDER_TRANSFER_HOME:root,
    RC_RECORD:record,RC_OUTSIDE:outside}});
  assert.notEqual(r.status,0,'A substituted record must fail closed, not return forged PUBLISHED state: '+r.stdout);
  assert.equal(fs.readFileSync(outside,'utf8'),JSON.stringify(fake));
  assert.deepEqual(JSON.parse(fs.readFileSync(record+'.checked','utf8')),safe);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('job-status refuses an oversized journal without reading or parsing it',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-record-bounds-'));
 try{
  const jobDir=path.join(root,'jobs','Linux');
  fs.mkdirSync(jobDir,{recursive:true});
  const record=path.join(jobDir,'oversized-001.json');
  fs.writeFileSync(record,' '.repeat(131073));
  const r=spawnSync(process.execPath,[cli,'job-status','--peer','Linux','--id','oversized-001'],{
   encoding:'utf8',timeout:6000,env:{...process.env,COMMANDER_TRANSFER_HOME:root}});
  assert.notEqual(r.status,0,r.stdout);
  assert.match(r.stderr,/UNTRUSTED_JOB_RECORD/);
  assert.equal(fs.statSync(record).size,131073);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('enqueue admission rejects a queued journal swapped for an external symlink after directory listing',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-queue-swap-'));
 try{
  const sourceDir=path.join(root,'source'),jobDir=path.join(root,'jobs','Linux');
  fs.mkdirSync(sourceDir);fs.mkdirSync(jobDir,{recursive:true});
  const source=path.join(sourceDir,'input.bin');fs.writeFileSync(source,'abc');
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'PC'}));
  const record=path.join(jobDir,'existing-001.json');
  const queued={schema:'ctmesh-durable-v1',id:'existing-001',peer:'Linux',status:'QUEUED',bytes:4};
  const external=path.join(root,'synthetic-outside.json');
  fs.writeFileSync(record,JSON.stringify(queued));
  fs.writeFileSync(external,JSON.stringify({...queued,status:'PUBLISHED'}));
  const probe=path.join(root,'probe-symlink');
  try{fs.symlinkSync(external,probe,'file');fs.unlinkSync(probe);}
  catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('Symlink creation unavailable');return;}throw e;}
  const hook=path.join(root,'swap-hook.cjs');
  fs.writeFileSync(hook,[
   "const fs=require('node:fs');",
   "const read=fs.readFileSync,open=fs.openSync;",
   "let swapped=false;",
   "function swap(file){if(!swapped&&(String(file)===process.env.RC_RECORD||(String(file).startsWith('/proc/self/fd/')&&String(file).endsWith('/'+require('node:path').basename(process.env.RC_RECORD))))){",
   " swapped=true;fs.renameSync(file,file+'.checked');",
   " fs.symlinkSync(process.env.RC_EXTERNAL,file,'file');",
   "}}",
   "fs.readFileSync=function(file,...args){swap(file);return read.call(this,file,...args);};",
   "fs.openSync=function(file,...args){swap(file);return open.call(this,file,...args);};"
  ].join('\n'));
  const r=spawnSync(process.execPath,[cli,'enqueue','--peer','Linux',
   '--id','new-queue-002','--path',source,'--source-root',sourceDir,
   '--max-source-bytes','4','--max-pending-bytes','4'],{
    encoding:'utf8',timeout:6500,env:{...process.env,COMMANDER_TRANSFER_HOME:root,
    NODE_OPTIONS:'--require '+hook,RC_RECORD:record,RC_EXTERNAL:external}
   });
  assert.notEqual(r.status,0,'Enqueue must not accept a swapped queue entry: '+r.stdout);
  assert.match(r.stderr,/QUEUE_RECORD_UNSAFE|UNTRUSTED_JOB_RECORD|ELOOP/);
  assert.equal(fs.readFileSync(external,'utf8'),JSON.stringify({...queued,status:'PUBLISHED'}));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('enqueue admission rejects an oversized existing queue journal before parsing',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-queue-bound-'));
 try{
  const sourceDir=path.join(root,'source'),jobDir=path.join(root,'jobs','Linux');
  fs.mkdirSync(sourceDir);fs.mkdirSync(jobDir,{recursive:true});
  const source=path.join(sourceDir,'input.bin');fs.writeFileSync(source,'abc');
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'PC'}));
  const record=path.join(jobDir,'existing-001.json');
  fs.writeFileSync(record,JSON.stringify({schema:'ctmesh-durable-v1',status:'PUBLISHED',bytes:0})+
   ' '.repeat(131073));
  const r=spawnSync(process.execPath,[cli,'enqueue','--peer','Linux',
    '--id','new-queue-002','--path',source,'--source-root',sourceDir],{
      encoding:'utf8',timeout:6500,env:{...process.env,COMMANDER_TRANSFER_HOME:root}});
  assert.notEqual(r.status,0,'Oversized existing journal must not be accepted: '+r.stdout);
  assert.match(r.stderr,/QUEUE_RECORD_UNSAFE|UNTRUSTED_JOB_RECORD/);
  assert.equal(fs.statSync(record).size>131072,true);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('enqueue rejects a swapped node identity symlink instead of adopting forged peer authority',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-node-swap-'));
 try{
  const srcDir=path.join(root,'source');fs.mkdirSync(srcDir);
  const source=path.join(srcDir,'input.dat');fs.writeFileSync(source,'INPUT');
  const node=path.join(root,'node.json'),outside=path.join(root,'outside-node.json');
  fs.writeFileSync(node,JSON.stringify({alias:'PC'}));
  fs.writeFileSync(outside,JSON.stringify({alias:'EmadServer'}));
  const probe=path.join(root,'probe');
  try{fs.symlinkSync(outside,probe,'file');fs.unlinkSync(probe);}
  catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('Symlink unavailable');return;}throw e;}
  const hook=path.join(root,'node-hook.cjs');
  fs.writeFileSync(hook,[
   "const fs=require('node:fs');",
   "const rd=fs.readFileSync,open=fs.openSync;",
   "let used=false;",
   "function swap(file){if(!used&&(String(file)===process.env.RC_NODE||(String(file).startsWith('/proc/self/fd/')&&String(file).endsWith('/'+require('node:path').basename(process.env.RC_NODE))))){",
   "used=true;fs.renameSync(file,file+'.checked');",
   "fs.symlinkSync(process.env.RC_EXTERNAL,file,'file');",
   "}}",
   "fs.readFileSync=function(file,...args){swap(file);return rd.call(this,file,...args);};",
   "fs.openSync=function(file,...args){swap(file);return open.call(this,file,...args);};"
  ].join('\n'));
  const r=spawnSync(process.execPath,[cli,'enqueue','--peer','Linux','--id','node-swap-001',
    '--path',source,'--source-root',srcDir],{encoding:'utf8',timeout:6000,
    env:{...process.env,NODE_OPTIONS:'--require '+hook,COMMANDER_TRANSFER_HOME:root,
      RC_NODE:node,RC_EXTERNAL:outside}});
  assert.notEqual(r.status,0,'Swapped local identity must fail before admission: '+r.stdout);
  assert.match(r.stderr,/UNTRUSTED_JOB_RECORD|ELOOP|TRANSFER_MANAGED_PATH_UNSAFE/);
  assert.equal(fs.readFileSync(outside,'utf8'),JSON.stringify({alias:'EmadServer'}));
  assert.equal(fs.existsSync(path.join(root,'jobs','Linux','node-swap-001.json')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('job-status rejects a substituted stale-worker lock symlink after safePaths preflight',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-lock-swap-'));
 try{
  const jobs=path.join(root,'jobs','Linux'),id='lock-swap-001';
  fs.mkdirSync(jobs,{recursive:true});
  const record=path.join(jobs,id+'.json');
  fs.writeFileSync(record,JSON.stringify({schema:'ctmesh-durable-v1',id,peer:'Linux',
    bytes:3,status:'QUEUED',createdAt:new Date(Date.now()-90000).toISOString()}));
  const lock=path.join(jobs,id+'.lock'),outside=path.join(root,'outside-lock.json');
  fs.writeFileSync(lock,JSON.stringify({pid:0}));
  fs.writeFileSync(outside,JSON.stringify({pid:process.pid}));
  const probe=path.join(root,'probe');
  try{fs.symlinkSync(outside,probe,'file');fs.unlinkSync(probe);}
  catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('Symlink unavailable');return;}throw e;}
  const hook=path.join(root,'lock-hook.cjs');
  fs.writeFileSync(hook,[
   "const fs=require('node:fs');",
   "const rd=fs.readFileSync,open=fs.openSync;",
   "let used=false;",
   "function swap(file){if(!used&&(String(file)===process.env.RC_LOCK||(String(file).startsWith('/proc/self/fd/')&&String(file).endsWith('/'+require('node:path').basename(process.env.RC_LOCK))))){",
   "used=true;fs.renameSync(file,file+'.checked');",
   "fs.symlinkSync(process.env.RC_EXTERNAL,file,'file');",
   "}}",
   "fs.readFileSync=function(file,...args){swap(file);return rd.call(this,file,...args);};",
   "fs.openSync=function(file,...args){swap(file);return open.call(this,file,...args);};"
  ].join('\n'));
  const r=spawnSync(process.execPath,[cli,'job-status','--peer','Linux','--id',id],{
    encoding:'utf8',timeout:6000,env:{...process.env,NODE_OPTIONS:'--require '+hook,
      COMMANDER_TRANSFER_HOME:root,RC_LOCK:lock,RC_EXTERNAL:outside}});
  assert.notEqual(r.status,0,'Swapped worker lock must fail closed: '+r.stdout);
  assert.match(r.stderr,/UNTRUSTED_JOB_RECORD|ELOOP|TRANSFER_MANAGED_PATH_UNSAFE/);
  assert.equal(fs.readFileSync(outside,'utf8'),JSON.stringify({pid:process.pid}));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('publish recovery never consumes a swapped external manifest symlink',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-manifest-swap-'));
 try{
  const id='manifest-race-001', peer='Linux';
  const dir=path.join(root,'pairs',peer,'transfers',id);
  const jobs=path.join(root,'jobs',peer),sourceDir=path.join(root,'source');
  fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(jobs,{recursive:true});fs.mkdirSync(sourceDir);
  const source=path.join(sourceDir,'sample.bin'),data=Buffer.from('EXPECTED_BYTES');
  fs.writeFileSync(source,data);fs.writeFileSync(path.join(dir,'payload.bin'),data);
  const st=fs.statSync(source),createdAt='2026-10-22T00:00:00.000Z';
  const j={schema:'ctmesh-durable-v1',id,peer,from:'PC',path:source,sourceRoot:sourceDir,
   name:'sample.bin',bytes:st.size,mtimeMs:st.mtimeMs,ino:st.ino,dev:st.dev,
   copiedBytes:0,status:'INTERRUPTED',createdAt};
  fs.writeFileSync(path.join(jobs,id+'.json'),JSON.stringify(j));
  const manifest=path.join(dir,'manifest.json'),outside=path.join(root,'outside-manifest.json');
  const expected={schema:'ctmesh-v1',id,from:'PC',to:peer,name:'sample.bin',
   bytes:st.size,sha256:crypto.createHash('sha256').update(data).digest('hex'),createdAt};
  fs.writeFileSync(manifest,'{"schema":"ctmesh-test-nonmatching"}\n');
  fs.writeFileSync(outside,JSON.stringify(expected));
  const probe=path.join(root,'probe');
  try{fs.symlinkSync(outside,probe,'file');fs.unlinkSync(probe);}
  catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('Symlinks unavailable');return;}throw e;}
  const hook=path.join(root,'manifest-hook.cjs');
  fs.writeFileSync(hook,[
   "const fs=require('node:fs');",
   "const oldRead=fs.readFileSync,oldOpen=fs.openSync;",
   "let swapped=false;",
   "function swap(file){if(!swapped&&String(file)===process.env.RC_MANIFEST){",
   "swapped=true;fs.renameSync(file,file+'.checked');",
   "fs.symlinkSync(process.env.RC_OUTSIDE,file,'file');}}",
   "fs.readFileSync=function(file,...args){swap(file);return oldRead.call(this,file,...args);};",
   "fs.openSync=function(file,...args){swap(file);return oldOpen.call(this,file,...args);};"
  ].join('\n'));
  const r=spawnSync(process.execPath,[cli,'work','--peer',peer,'--id',id],{
   encoding:'utf8',timeout:6500,env:{...process.env,COMMANDER_TRANSFER_HOME:root,
    NODE_OPTIONS:'--require '+hook,RC_MANIFEST:manifest,RC_OUTSIDE:outside}});
  assert.equal(r.status,0,r.stderr);
  const state=JSON.parse(fs.readFileSync(path.join(jobs,id+'.json'),'utf8'));
  assert.equal(state.status,'FAILED','Recovered worker must refuse swapped external manifest');
  assert.equal(fs.readFileSync(outside,'utf8'),JSON.stringify(expected));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('publish recovery refuses an oversized existing manifest before parsing',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-manifest-size-'));
 try{
  const id='manifest-large-001',peer='Linux';
  const dir=path.join(root,'pairs',peer,'transfers',id),jobs=path.join(root,'jobs',peer),
   sourceDir=path.join(root,'source');
  fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(jobs,{recursive:true});fs.mkdirSync(sourceDir);
  const source=path.join(sourceDir,'sample.bin'),data=Buffer.from('EXPECTED_BYTES');
  fs.writeFileSync(source,data);fs.writeFileSync(path.join(dir,'payload.bin'),data);
  const st=fs.statSync(source),createdAt='2026-10-22T00:00:00.000Z';
  const j={schema:'ctmesh-durable-v1',id,peer,from:'PC',path:source,sourceRoot:sourceDir,
   name:'sample.bin',bytes:st.size,mtimeMs:st.mtimeMs,ino:st.ino,dev:st.dev,
   copiedBytes:0,status:'INTERRUPTED',createdAt};
  fs.writeFileSync(path.join(jobs,id+'.json'),JSON.stringify(j));
  const expected={schema:'ctmesh-v1',id,from:'PC',to:peer,name:'sample.bin',
   bytes:st.size,sha256:crypto.createHash('sha256').update(data).digest('hex'),createdAt};
  const manifest=path.join(dir,'manifest.json');
  fs.writeFileSync(manifest,JSON.stringify(expected)+' '.repeat(131073));
  const r=spawnSync(process.execPath,[cli,'work','--peer',peer,'--id',id],{
   encoding:'utf8',timeout:6500,env:{...process.env,COMMANDER_TRANSFER_HOME:root}});
  assert.equal(r.status,0,r.stderr);
  const state=JSON.parse(fs.readFileSync(path.join(jobs,id+'.json'),'utf8'));
  assert.equal(state.status,'FAILED','Recovered worker must refuse oversized existing manifest');
  assert.ok(fs.statSync(manifest).size>131072);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('recovery must not hash a post-preflight swapped external published payload',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-payload-hash-swap-'));
 try{
  const id='payload-swap-001',peer='Linux',
    destination=path.join(root,'pairs',peer,'transfers',id),
    jobs=path.join(root,'jobs',peer),
    sourceDir=path.join(root,'source');
  fs.mkdirSync(destination,{recursive:true});
  fs.mkdirSync(jobs,{recursive:true});fs.mkdirSync(sourceDir);
  const source=path.join(sourceDir,'input.bin');
  const bytes=Buffer.from('TRUSTED_SOURCE_PAYLOAD');
  fs.writeFileSync(source,bytes);
  const published=path.join(destination,'payload.bin');
  fs.writeFileSync(published,Buffer.from('UNTRUSTED_PAYLOAD_DATA'));
  const external=path.join(root,'external-payload.bin');
  fs.writeFileSync(external,bytes);
  const probe=path.join(root,'symlink-probe');
  try{fs.symlinkSync(external,probe,'file');fs.unlinkSync(probe);}
  catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('Symlinks unavailable');return;}throw e;}
  const info=fs.statSync(source);
  const journal={schema:'ctmesh-durable-v1',id,peer,from:'PC',path:source,
    sourceRoot:sourceDir,name:path.basename(source),bytes:info.size,
    mtimeMs:info.mtimeMs,ino:info.ino,dev:info.dev,
    copiedBytes:0,status:'INTERRUPTED',createdAt:new Date().toISOString()};
  const rec=path.join(jobs,id+'.json');fs.writeFileSync(rec,JSON.stringify(journal));
  const hook=path.join(root,'payload-hash-hook.cjs');
  fs.writeFileSync(hook,[
   "const fs=require('node:fs');",
   "const open=fs.openSync;",
   "let swapped=false;",
   "fs.openSync=function(file,flags,...rest){",
   "if(!swapped&&String(file)===process.env.RC_PAYLOAD){",
   " swapped=true;fs.renameSync(file,file+'.checked');",
   " fs.symlinkSync(process.env.RC_EXTERNAL,file,'file');",
   "}",
   "return open.call(this,file,flags,...rest);",
   "};"
  ].join('\n'));
  const r=spawnSync(process.execPath,[cli,'work','--peer',peer,'--id',id],{
   encoding:'utf8',timeout:6500,env:{...process.env,NODE_OPTIONS:'--require '+hook,
    COMMANDER_TRANSFER_HOME:root,RC_PAYLOAD:published,RC_EXTERNAL:external}});
  assert.equal(r.status,0,r.stderr);
  const after=JSON.parse(fs.readFileSync(rec,'utf8'));
  assert.equal(after.status,'FAILED',
    'Swapped outside payload may not be treated as a verified published artifact');
  assert.deepEqual(fs.readFileSync(external),bytes);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Linux journal read rejects job-directory ancestor swap after preflight', {skip:process.platform!=='linux'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-linux-parent-fd-'));
 try{
  const peer='Linux',id='parent-swap-001',dir=path.join(root,'jobs',peer),outside=path.join(root,'external');
  fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(outside);
  const queued={schema:'ctmesh-durable-v1',id,peer,status:'QUEUED',bytes:3,createdAt:new Date().toISOString()};
  const record=path.join(dir,id+'.json'),external=path.join(outside,id+'.json');
  fs.writeFileSync(record,JSON.stringify(queued));
  fs.writeFileSync(external,JSON.stringify({...queued,status:'PUBLISHED'}));
  const hook=path.join(root,'ancestor-open-hook.cjs');
  fs.writeFileSync(hook,[
   "const fs=require('node:fs'),open=fs.openSync,lstat=fs.lstatSync;",
   "let changed=false,n=0;",
   "function swap(){if(changed)return;changed=true;",
   "fs.renameSync(process.env.RC_JOB,process.env.RC_JOB+'.original');",
   "fs.symlinkSync(process.env.RC_OUTSIDE,process.env.RC_JOB,'dir');}",
   "fs.lstatSync=function(file,...rest){",
   "if((String(file)===process.env.RC_RECORD||(String(file).startsWith('/proc/self/fd/')&&String(file).endsWith('/'+require('node:path').basename(process.env.RC_RECORD))))&&++n===2)swap();",
   "return lstat.call(this,file,...rest);};",
   "fs.openSync=function(file,...rest){",
   "if(String(file)===process.env.RC_ROOT)swap();",
   "return open.call(this,file,...rest);};"
  ].join('\n'));
  const r=spawnSync(process.execPath,[cli,'job-status','--peer',peer,'--id',id],{
   encoding:'utf8',timeout:6500,env:{...process.env,COMMANDER_TRANSFER_HOME:root,
    NODE_OPTIONS:'--require '+hook,RC_RECORD:record,RC_JOB:dir,RC_OUTSIDE:outside,RC_ROOT:root}});
  assert.notEqual(r.status,0,'No external job-status after ancestor redirected: '+r.stdout);
  assert.equal(fs.readFileSync(external,'utf8'),JSON.stringify({...queued,status:'PUBLISHED'}));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Linux job-status tolerates a safe atomic journal generation replacement without accepting symlinks',t=>{
 if(process.platform!=='linux'){t.skip('Linux-only pinned-journal rotation regression');return;}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-journal-generation-'));
 try{
  const dir=path.join(root,'jobs','Linux');fs.mkdirSync(dir,{recursive:true});
  const id='atomic-generation-001',record=path.join(dir,id+'.json'),next=path.join(dir,'next.tmp');
  const marker=path.join(root,'generation-swapped'),hook=path.join(root,'journal-hook.cjs');
  const original={schema:'ctmesh-durable-v1',id,peer:'Linux',status:'QUEUED',bytes:64,copiedBytes:0,createdAt:new Date().toISOString()};
  fs.writeFileSync(record,JSON.stringify(original)+'\n',{mode:0o600});
  fs.writeFileSync(next,JSON.stringify({...original,status:'PUBLISHED',copiedBytes:64,sha256:'a'.repeat(64)})+'\n',{mode:0o600});
  fs.writeFileSync(hook,[
   "const fs=require('node:fs'),mod=require('node:module');",
   "const old=fs.lstatSync;let n=0;",
   "fs.lstatSync=function(file,...args){",
   " if(String(file).startsWith('/proc/self/fd/')&&String(file).endsWith('/'+process.env.RC_NAME)&&++n===2){",
   "  fs.renameSync(process.env.RC_NEXT,process.env.RC_RECORD);",
   "  fs.writeFileSync(process.env.RC_MARKER,'ATOMIC_RENAME');",
   " }",
   " return old.call(this,file,...args);",
   "};mod.syncBuiltinESMExports();"
  ].join('\n'));
  const result=spawnSync(process.execPath,['--require',hook,cli,'job-status','--peer','Linux','--id',id],{
   encoding:'utf8',timeout:6000,env:{...process.env,COMMANDER_TRANSFER_HOME:root,
    RC_RECORD:record,RC_NEXT:next,RC_NAME:id+'.json',RC_MARKER:marker}
  });
  assert.equal(fs.existsSync(marker),true,'Journal generation race hook must execute');
  assert.equal(result.status,0,'A safe regular-file atomic generation replacement must be reread: '+result.stderr);
  assert.equal(JSON.parse(result.stdout).status,'PUBLISHED');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Linux job-status accepts safely replaced journal inode unlinked between open and fstat',t=>{
 if(process.platform!=='linux'){t.skip('Linux inode-unlink generation race');return;}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-journal-nlink-'));
 try{
  const dir=path.join(root,'jobs','Linux');fs.mkdirSync(dir,{recursive:true});
  const id='fd-unlink-001',record=path.join(dir,id+'.json'),next=path.join(dir,'fresh.tmp');
  const marker=path.join(root,'rotation-fired'),hook=path.join(root,'unlink-hook.cjs');
  const previous={schema:'ctmesh-durable-v1',id,peer:'Linux',status:'QUEUED',bytes:64,copiedBytes:0,createdAt:new Date().toISOString()};
  fs.writeFileSync(record,JSON.stringify(previous)+'\n',{mode:0o600});
  fs.writeFileSync(next,JSON.stringify({...previous,status:'PUBLISHED',copiedBytes:64,sha256:'b'.repeat(64)})+'\n',{mode:0o600});
  fs.writeFileSync(hook,[
   "const fs=require('node:fs'),mod=require('node:module');",
   "const oldOpen=fs.openSync,oldStat=fs.fstatSync;let target=null,fired=false;",
   "fs.openSync=function(name,...args){const fd=oldOpen.call(this,name,...args);",
   " if(String(name).endsWith('/'+process.env.RC_NAME))target=fd;return fd;};",
   "fs.fstatSync=function(fd,...args){",
   " if(!fired&&fd===target){fired=true;fs.renameSync(process.env.RC_NEXT,process.env.RC_RECORD);",
   " fs.writeFileSync(process.env.RC_MARKER,'RENAME_AFTER_OPEN');}",
   " return oldStat.call(this,fd,...args);};",
   "mod.syncBuiltinESMExports();"
  ].join('\n'));
  const res=spawnSync(process.execPath,['--require',hook,cli,'job-status','--peer','Linux','--id',id],{
   encoding:'utf8',timeout:6000,env:{...process.env,COMMANDER_TRANSFER_HOME:root,
    RC_RECORD:record,RC_NEXT:next,RC_NAME:id+'.json',RC_MARKER:marker}
  });
  assert.equal(fs.existsSync(marker),true,'Controlled rename after file opening must fire');
  assert.equal(res.status,0,'Old unlinked FD must be discarded and valid new generation reread: '+res.stderr);
  assert.equal(JSON.parse(res.stdout).status,'PUBLISHED');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
