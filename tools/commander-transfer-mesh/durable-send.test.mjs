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
  const partialDest=path.join(root,'pairs','Linux','transfers','durable-boundary-003');fs.mkdirSync(partialDest);
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
   "const fs=require('node:fs');",
   "const orig=fs.openSync;",
   "let swapped=false;",
   "fs.openSync=function(file,flags,...rest){",
   " const rw=flags==='r+'||(typeof flags==='number'&&(flags&fs.constants.O_RDWR)===fs.constants.O_RDWR);",
   " if(!swapped&&rw&&String(file)===process.env.RC_SWAP_PART){",
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
   "function replace(file){if(!swapped&&String(file)===process.env.RC_RECORD){",
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

test('enqueue rejects a queue journal swapped after directory enumeration',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-queue-swap-'));
 try{
  const sourceDir=path.join(root,'source'),jobDir=path.join(root,'jobs','Linux');
  fs.mkdirSync(sourceDir);fs.mkdirSync(jobDir,{recursive:true});
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'PC'}));
  const source=path.join(sourceDir,'payload.bin');fs.writeFileSync(source,Buffer.alloc(50,7));
  const checked=path.join(jobDir,'older-001.json'),external=path.join(root,'fake-published.json');
  const probe=path.join(root,'probe-link');
  const active={schema:'ctmesh-durable-v1',id:'older-001',peer:'Linux',status:'QUEUED',bytes:100,createdAt:new Date().toISOString()};
  fs.writeFileSync(checked,JSON.stringify(active));
  fs.writeFileSync(external,JSON.stringify({...active,status:'PUBLISHED'}));
  try{fs.symlinkSync(external,probe,'file');fs.unlinkSync(probe);}
  catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('Symlink creation unavailable');return;}throw e;}
  const hook=path.join(root,'swap-queue.cjs');
  fs.writeFileSync(hook,[
   "const fs=require('node:fs');",
   "const read=fs.readFileSync,open=fs.openSync,stat=fs.lstatSync;",
   "let once=false;",
   "function swap(file){if(!once&&String(file)===process.env.RC_QUEUED){",
   " once=true;fs.renameSync(file,file+'.checked');fs.symlinkSync(process.env.RC_FAKE,file,'file');",
   "}}",
   "fs.readFileSync=function(file,...args){swap(file);return read.call(this,file,...args);};",
   "fs.openSync=function(file,...args){swap(file);return open.call(this,file,...args);};",
   "fs.lstatSync=function(file,...args){swap(file);return stat.call(this,file,...args);};"
  ].join('\n'));
  const newId='newjob-002';
  const result=spawnSync(process.execPath,[cli,'enqueue','--peer','Linux','--id',newId,
   '--path',source,'--source-root',sourceDir,'--max-source-bytes','64','--max-pending-bytes','128'],{
   encoding:'utf8',timeout:6000,
   env:{...process.env,NODE_OPTIONS:'--require '+hook,COMMANDER_TRANSFER_HOME:root,
    RC_QUEUED:checked,RC_FAKE:external}});
  assert.notEqual(result.status,0,'Queue quota must not be bypassed by a substituted PUBLISHED record: '+result.stdout);
  assert.equal(fs.existsSync(path.join(jobDir,newId+'.json')),false);
  assert.equal(fs.readFileSync(external,'utf8'),JSON.stringify({...active,status:'PUBLISHED'}));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
