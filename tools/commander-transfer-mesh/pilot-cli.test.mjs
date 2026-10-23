import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const cli=path.resolve(import.meta.dirname,'pilot-cli.mjs');
function create(alias){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-fixture-'));
 fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias,schema:'ctmesh-node-v1'}));
 return root;
}
function run(root,...args){
 return spawnSync(process.execPath,[cli,...args],{
  encoding:'utf8',env:{...process.env,COMMANDER_TRANSFER_HOME:root},timeout:15000
 });
}
function withFixtures(fn){
 const src=create('PC'),dst=create('Linux');
 try{fn(src,dst)}finally{fs.rmSync(src,{recursive:true,force:true});fs.rmSync(dst,{recursive:true,force:true})}
}
function send(src,id,data){
 const file=path.join(src,'sample.bin');
 fs.writeFileSync(file,data);
 const r=run(src,'send','--peer','Linux','--path',file,'--id',id);
 assert.equal(r.status,0,r.stderr);
 return {file,receipt:JSON.parse(r.stdout)};
}
function mirror(src,dst,id){
 const srcDir=path.join(src,'pairs','Linux','transfers',id);
 const dstDir=path.join(dst,'pairs','PC','transfers',id);
 fs.mkdirSync(path.dirname(dstDir),{recursive:true});
 fs.cpSync(srcDir,dstDir,{recursive:true,errorOnExist:true,force:false});
 return dstDir;
}
test('send -> mirror -> receive validates bytes and hash and no overwrite',()=>{
 withFixtures((src,dst)=>{
  const input=crypto.randomBytes(128*1024);
  const {receipt}=send(src,'test-hash-001',input);
  assert.equal(receipt.sha256,crypto.createHash('sha256').update(input).digest('hex'));
  mirror(src,dst,'test-hash-001');
  const st=run(dst,'status','--peer','PC','--id','test-hash-001');
  assert.equal(JSON.parse(st.stdout).status,'RECEIVED_HASH_VERIFIED');
  const dest=path.join(dst,'inbox');
  fs.mkdirSync(dest);
  const recv=run(dst,'receive','--peer','PC','--id','test-hash-001','--dest',dest);
  assert.equal(recv.status,0,recv.stderr);
  assert.deepEqual(fs.readFileSync(path.join(dest,'sample.bin')),input);
  assert.equal(JSON.parse(recv.stdout).status,'DELIVERED_HASH_VERIFIED');
  const repeated=run(dst,'receive','--peer','PC','--id','test-hash-001','--dest',dest);
  assert.notEqual(repeated.status,0);
  assert.match(repeated.stderr,/Destination exists/);
 });
});
test('Linux rejects staging ancestor swapped to outside directory before outgoing copy',t=>{
 if(process.platform!=='linux'){t.skip('Linux pinned staging path only');return;}
 const root=create('PC'),outside=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-staging-outside-'));
 try{
  const source=path.join(root,'source.bin'),id='staging-ancestor-001';
  fs.writeFileSync(source,Buffer.from('outgoing staged bytes must remain inside owner root'));
  const staging=path.join(root,'staging','Linux'),part=path.join(staging,id+'.part');
  const marker=path.join(root,'staging-swap.marker'),preload=path.join(root,'staging-swap.cjs');
  fs.writeFileSync(preload,[
   "const fs=require('node:fs'),mod=require('node:module');",
   "const old=fs.lstatSync;let seen=0,fired=false;",
   "fs.lstatSync=function(file,...args){",
   "if(!fired&&String(file)===process.env.RC_PART&&++seen===2){fired=true;",
   "fs.renameSync(process.env.RC_STAGING,process.env.RC_STAGING+'.original');",
   "fs.symlinkSync(process.env.RC_OUTSIDE,process.env.RC_STAGING,'dir');",
   "fs.writeFileSync(process.env.RC_MARKER,'ACTUAL_ANCESTOR_SWAP');",
   "}return old.call(this,file,...args);};",
   "mod.syncBuiltinESMExports();"
  ].join('\n'));
  const result=spawnSync(process.execPath,['--require',preload,cli,'send',
   '--peer','Linux','--path',source,'--id',id],{encoding:'utf8',timeout:15000,
   env:{...process.env,COMMANDER_TRANSFER_HOME:root,RC_PART:part,
    RC_STAGING:staging,RC_OUTSIDE:outside,RC_MARKER:marker}});
  assert.equal(fs.existsSync(marker),true,'The post-preflight staging swap must fire');
  assert.notEqual(result.status,0,'A symlink outside the managed staging tree must not be a copy destination');
  assert.deepEqual(fs.readdirSync(outside),[],'No external staged file may be written');
 }finally{
  fs.rmSync(root,{recursive:true,force:true});
  fs.rmSync(outside,{recursive:true,force:true});
 }
});

test('same transfer ID cannot be silently reused',()=>{
 withFixtures((src)=>{
  send(src,'test-unique-001',Buffer.from('a'));
  const failed=run(src,'send','--peer','Linux','--path',path.join(src,'sample.bin'),'--id','test-unique-001');
  assert.notEqual(failed.status,0);
  assert.match(failed.stderr,/EEXIST/);
 });
});
test('corrupt incoming payload never reaches inbox',()=>{
 withFixtures((src,dst)=>{
  send(src,'test-corrupt-001',crypto.randomBytes(1024));
  const folder=mirror(src,dst,'test-corrupt-001');
  fs.writeFileSync(path.join(folder,'payload.bin'),'not the intended content');
  const result=run(dst,'receive','--peer','PC','--id','test-corrupt-001','--dest',path.join(dst,'inbox'));
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/SHA256\/size mismatch/);
  assert.equal(fs.existsSync(path.join(dst,'inbox','sample.bin')),false);
 });
});
test('untrusted peer and malformed transfer ID rejected',()=>{
 withFixtures((src)=>{
  const input=path.join(src,'source.bin');
  fs.writeFileSync(input,'a');
  for(const opts of [
   ['--peer','Unknown','--path',input,'--id','valid-id'],
   ['--peer','Linux','--path',input,'--id','../escape'],
   ['--peer','PC','--path',input,'--id','valid-id']
  ]){
   const r=run(src,'send',...opts);
   assert.notEqual(r.status,0);
  }
 });
});
test('node identity cannot switch to external symlink after preflight',t=>{
 const root=create('PC');
 try{
  const node=path.join(root,'node.json'),outside=path.join(root,'outside-identity.json');
  fs.writeFileSync(outside,JSON.stringify({schema:'ctmesh-node-v1',alias:'Linux'}));
  const trial=path.join(root,'node-link-probe');
  try{fs.symlinkSync(outside,trial,'file');fs.unlinkSync(trial);}
  catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('File symlinks unavailable');return;}throw e;}
  const marker=path.join(root,'identity-race.marker'),preload=path.join(root,'identity-race-hook.cjs');
  fs.writeFileSync(preload,[
   "const fs=require('node:fs'),mod=require('node:module');",
   "const old=fs.readFileSync;let fired=false;",
   "fs.readFileSync=function(file,...args){",
   "if(!fired&&String(file)===process.env.RC_NODE){fired=true;",
   "fs.renameSync(file,file+'.original');",
   "fs.symlinkSync(process.env.RC_EXTERNAL,file,'file');",
   "fs.writeFileSync(process.env.RC_MARKER,'ATTACK_EXECUTED');",
   "}return old.call(this,file,...args);};",
   "mod.syncBuiltinESMExports();"
  ].join('\n'));
  const result=spawnSync(process.execPath,['--require',preload,cli,'info'],{
   encoding:'utf8',timeout:15000,env:{...process.env,COMMANDER_TRANSFER_HOME:root,
    RC_NODE:node,RC_EXTERNAL:outside,RC_MARKER:marker}});
  if(fs.existsSync(marker)){
   assert.notEqual(result.status,0,'Outside alias must not become CLI identity');
   assert.match(result.stderr,/Untrusted node identity|ELOOP/);
  }else{
   assert.equal(result.status,0,result.stderr);
   assert.equal(JSON.parse(result.stdout).device,'PC');
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Linux rejects transfer ancestor symlink swapped after managed preflight',t=>{
 if(process.platform!=='linux'){t.skip('Linux descriptor-relative path hardening only');return;}
 withFixtures((src,dst)=>{
  const id='ancestor-race-001',data=Buffer.from('external peer record with equal hash');
  send(src,id,data);
  const dir=mirror(src,dst,id),manifest=path.join(dir,'manifest.json');
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-ancestor-outside-'));
  try{
   fs.cpSync(dir,outside,{recursive:true,force:true});
   const forged=path.join(outside,'manifest.json');
   const original=JSON.parse(fs.readFileSync(forged,'utf8'));
   fs.writeFileSync(forged,JSON.stringify({...original,name:'outside-ancestor-selected.bin'}));
   const marker=path.join(dst,'ancestor-race-fired.marker');
   const preload=path.join(dst,'ancestor-race-hook.cjs');
   fs.writeFileSync(preload,[
    "const fs=require('node:fs'),mod=require('node:module');",
    "const old=fs.lstatSync;let fired=false,seen=0;",
    "fs.lstatSync=function(file,...args){",
    "if(!fired&&String(file)===process.env.RC_MANIFEST&&++seen===2){fired=true;",
    "fs.renameSync(process.env.RC_DIRECTORY,process.env.RC_DIRECTORY+'.original');",
    "fs.symlinkSync(process.env.RC_EXTERNAL,process.env.RC_DIRECTORY,'dir');",
    "fs.writeFileSync(process.env.RC_MARKER,'ATTACK_FIRED');",
    "}return old.call(this,file,...args);};",
    "mod.syncBuiltinESMExports();"
   ].join('\n'));
   const result=spawnSync(process.execPath,['--require',preload,cli,'status',
    '--peer','PC','--id',id],{encoding:'utf8',timeout:15000,
    env:{...process.env,COMMANDER_TRANSFER_HOME:dst,RC_MANIFEST:manifest,
     RC_DIRECTORY:dir,RC_EXTERNAL:outside,RC_MARKER:marker}});
   assert.equal(fs.existsSync(marker),true,'Ancestor substitution must actually execute');
   assert.notEqual(result.status,0,
    'A post-preflight symlink ancestor must never import an outside manifest');
   assert.match(result.stderr,/UNTRUSTED_MANAGED_ANCESTOR|ELOOP|Unsafe|Untrusted/);
   assert.equal(JSON.parse(fs.readFileSync(forged,'utf8')).name,'outside-ancestor-selected.bin');
  }finally{fs.rmSync(outside,{recursive:true,force:true});}
 });
});

test('oversized untrusted incoming manifest is rejected before parsing',()=>{
 withFixtures((src,dst)=>{
  const id='oversize-manifest-001';send(src,id,Buffer.from('legitimate payload'));
  const folder=mirror(src,dst,id);
  fs.writeFileSync(path.join(folder,'manifest.json'),'x'.repeat(16385));
  const r=run(dst,'status','--peer','PC','--id',id);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/Untrusted transfer manifest/);
 });
});

test('incoming manifest cannot be swapped to external symlink before JSON read',t=>{
 withFixtures((src,dst)=>{
  const id='manifest-race-read-001';
  send(src,id,Buffer.from('valid signed-by-hash payload'));
  const folder=mirror(src,dst,id),manifest=path.join(folder,'manifest.json');
  const outside=path.join(dst,'outside-fake-manifest.json');
  const original=JSON.parse(fs.readFileSync(manifest,'utf8'));
  fs.writeFileSync(outside,JSON.stringify({...original,name:'attacker-forged.bin'}));
  const testLink=path.join(dst,'manifest-symlink-probe');
  try{fs.symlinkSync(outside,testLink,'file');fs.unlinkSync(testLink);}
  catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('File symlinks unavailable');return;}throw e;}
  const marker=path.join(dst,'manifest-race.marker'),preload=path.join(dst,'manifest-race-hook.cjs');
  fs.writeFileSync(preload,[
   "const fs=require('node:fs'),mod=require('node:module');",
   "const old=fs.readFileSync;let done=false;",
   "fs.readFileSync=function(file,...args){",
   "if(!done&&String(file)===process.env.RC_MANIFEST){done=true;",
   "fs.renameSync(file,file+'.original');",
   "fs.symlinkSync(process.env.RC_EXTERNAL,file,'file');",
   "fs.writeFileSync(process.env.RC_MARKER,'SWAP_FIRED');",
   "}return old.call(this,file,...args);};",
   "mod.syncBuiltinESMExports();"
  ].join('\n'));
  const result=spawnSync(process.execPath,['--require',preload,cli,'status',
    '--peer','PC','--id',id],{encoding:'utf8',timeout:15000,env:{...process.env,
    COMMANDER_TRANSFER_HOME:dst,RC_MANIFEST:manifest,RC_EXTERNAL:outside,RC_MARKER:marker}});
  if(fs.existsSync(marker)){
   assert.notEqual(result.status,0,'An external valid-looking manifest cannot choose received filename');
   assert.match(result.stderr,/Untrusted transfer manifest|ELOOP|Untrusted manifest/);
  }else{
   // A descriptor-bound implementation never calls the pathname-based
   // readFileSync hook, so the malicious replacement cannot be performed.
   assert.equal(result.status,0,result.stderr);
   assert.equal(JSON.parse(result.stdout).name,original.name);
  }
  assert.equal(JSON.parse(fs.readFileSync(outside,'utf8')).name,'attacker-forged.bin');
 });
});

test('incoming payload cannot be swapped to external symlink just before hash opens it',t=>{
 withFixtures((src,dst)=>{
  const id='hash-race-payload-001',data=Buffer.from('same payload but external authority');
  send(src,id,data);
  const folder=mirror(src,dst,id),payload=path.join(folder,'payload.bin');
  const external=path.join(dst,'outside-hash-race.bin');
  fs.writeFileSync(external,data);
  // Validate the host can create file links before attempting the adversarial case.
  const trial=path.join(dst,'symlink-capability-check');
  try{fs.symlinkSync(external,trial,'file');fs.unlinkSync(trial);}
  catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('File symlinks unavailable');return;}throw e;}
  const marker=path.join(dst,'race-fired.marker'),preload=path.join(dst,'hash-race-preload.cjs');
  fs.writeFileSync(preload,[
   "const fs=require('node:fs'),mod=require('node:module');",
   "const old=fs.openSync;let once=false;",
   "fs.openSync=function(file,...rest){",
   "if(!once&&String(file)===process.env.RC_PAYLOAD){once=true;",
   "fs.renameSync(file,file+'.original');",
   "fs.symlinkSync(process.env.RC_EXTERNAL,file,'file');",
   "fs.writeFileSync(process.env.RC_MARKER,'ATTACK_ACTUALLY_FIRED');",
   "}return old.call(this,file,...rest);};",
   "mod.syncBuiltinESMExports();"
  ].join('\n'));
  const result=spawnSync(process.execPath,['--require',preload,cli,'status',
    '--peer','PC','--id',id],{encoding:'utf8',timeout:15000,env:{...process.env,
    COMMANDER_TRANSFER_HOME:dst,RC_PAYLOAD:payload,RC_EXTERNAL:external,RC_MARKER:marker}});
  if(fs.existsSync(marker)){
   // On Windows the final pathname may still be opened; the same-digest
   // substitution must fail closed by handle identity or O_NOFOLLOW.
   assert.notEqual(result.status,0,'External symlink with same digest must never authorize payload');
   assert.match(result.stderr,/Untrusted hashed file|ELOOP|Unsafe source/);
  }else{
   // Linux now hashes through a pinned /proc/self/fd parent: the old absolute
   // pathname open hook is not invoked and no substitution takes place.
   assert.equal(process.platform,'linux');
   assert.equal(result.status,0,result.stderr);
   assert.equal(JSON.parse(result.stdout).status,'RECEIVED_HASH_VERIFIED');
  }
  assert.deepEqual(fs.readFileSync(external),data);
 });
});

test('symlink input cannot be transferred as a regular file',(t)=>{
 withFixtures((src)=>{
  const file=path.join(src,'secret.bin'),link=path.join(src,'link.bin');
  fs.writeFileSync(file,'data');
  try{fs.symlinkSync(file,link);}catch(e){if(e.code==='EPERM'){t.skip('Windows symlink creation requires privilege');return;}throw e;}
  const r=run(src,'send','--peer','Linux','--path',link,'--id','test-link-001');
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/Unsafe source/);
 });
});


test('interrupted final copy resumes only after byte-exact prefix verification',()=>{
 withFixtures((src,dst)=>{
  const data=crypto.randomBytes(512*1024+47),id='resume-prefix-001';
  send(src,id,data);mirror(src,dst,id);
  const folder=path.join(dst,'inbox');fs.mkdirSync(folder);
  const part=path.join(folder,'.ctmesh-'+id+'.part');
  fs.writeFileSync(part,data.subarray(0,131099));
  const result=run(dst,'receive','--peer','PC','--id',id,'--dest',folder);
  assert.equal(result.status,0,result.stderr);
  const receipt=JSON.parse(result.stdout);
  assert.equal(receipt.resumedBytes,131099);
  assert.deepEqual(fs.readFileSync(path.join(folder,'sample.bin')),data);
  assert.equal(fs.existsSync(part),false);
  assert.equal(fs.existsSync(path.join(folder,'.ctmesh-'+id+'.lock')),false);
 });
});
test('corrupt partial prefix fails closed and preserves bytes',()=>{
 withFixtures((src,dst)=>{
  const data=crypto.randomBytes(128*1024),id='resume-corrupt-001';
  send(src,id,data);mirror(src,dst,id);
  const folder=path.join(dst,'inbox');fs.mkdirSync(folder);
  const part=path.join(folder,'.ctmesh-'+id+'.part');
  const bad=Buffer.alloc(7000,0xaa);fs.writeFileSync(part,bad);
  const result=run(dst,'receive','--peer','PC','--id',id,'--dest',folder);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Partial prefix failed source verification/);
  assert.deepEqual(fs.readFileSync(part),bad);
  assert.equal(fs.existsSync(path.join(folder,'sample.bin')),false);
 });
});
test('oversized partial is retained and never truncated',()=>{
 withFixtures((src,dst)=>{
  const data=crypto.randomBytes(4096),id='resume-oversize-001';
  send(src,id,data);mirror(src,dst,id);
  const folder=path.join(dst,'inbox');fs.mkdirSync(folder);
  const part=path.join(folder,'.ctmesh-'+id+'.part');
  fs.writeFileSync(part,Buffer.alloc(data.length+1,0xbb));
  const result=run(dst,'receive','--peer','PC','--id',id,'--dest',folder);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Untrusted or oversized partial/);
  assert.equal(fs.statSync(part).size,data.length+1);
  assert.equal(fs.existsSync(path.join(folder,'sample.bin')),false);
 });
});
test('live owner lock blocks concurrent receive without modifying destination',()=>{
 withFixtures((src,dst)=>{
  const data=crypto.randomBytes(8192),id='lock-live-001';
  const {receipt}=send(src,id,data);mirror(src,dst,id);
  const folder=path.join(dst,'inbox');fs.mkdirSync(folder);
  const lock=path.join(folder,'.ctmesh-'+id+'.lock');
  const owner={schema:'ctmesh-receive-lock-v1',host:os.hostname(),peer:'PC',id,
    sha256:receipt.sha256,pid:process.pid};
  fs.writeFileSync(lock,JSON.stringify(owner)+'\n');
  const result=run(dst,'receive','--peer','PC','--id',id,'--dest',folder);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/live or unverified process/);
  assert.deepEqual(JSON.parse(fs.readFileSync(lock,'utf8')),owner);
  assert.equal(fs.existsSync(path.join(folder,'sample.bin')),false);
 });
});
test('verified dead-owner lock is reclaimed, foreign lock is never deleted',()=>{
 withFixtures((src,dst)=>{
  const data=crypto.randomBytes(16*1024),id='lock-stale-001';
  const {receipt}=send(src,id,data);mirror(src,dst,id);
  const folder=path.join(dst,'inbox');fs.mkdirSync(folder);
  const lock=path.join(folder,'.ctmesh-'+id+'.lock');
  const foreign={schema:'ctmesh-receive-lock-v1',host:'another-host',peer:'PC',id,
    sha256:receipt.sha256,pid:2147483647};
  fs.writeFileSync(lock,JSON.stringify(foreign)+'\n');
  let result=run(dst,'receive','--peer','PC','--id',id,'--dest',folder);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Untrusted receive lock/);
  assert.equal(fs.existsSync(lock),true);
  fs.writeFileSync(lock,JSON.stringify({...foreign,host:os.hostname()})+'\n');
  result=run(dst,'receive','--peer','PC','--id',id,'--dest',folder);
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(folder,'sample.bin')),data);
  assert.equal(fs.existsSync(lock),false);
 });
});


test('real child-process kill during final receive safely resumes a verified prefix',()=>{
 withFixtures((src,dst)=>{
  const id='killmid-finalcopy-001',data=crypto.randomBytes(8*1024*1024);
  const {receipt}=send(src,id,data);mirror(src,dst,id);
  const dest=path.join(dst,'inbox');fs.mkdirSync(dest);
  const preload=path.join(dst,'killmid.cjs');
  fs.writeFileSync(preload,[
   "const fs=require('node:fs');",
   "const original=fs.writeSync;",
   "fs.writeSync=function(fd,buffer,offset,length,position){",
   " const count=original.apply(this,arguments);",
   " if(Buffer.isBuffer(buffer)&&length>=1048576&&count>0)process.kill(process.pid,'SIGKILL');",
   " return count;",
   "};"
  ].join('\n'));
  const killed=spawnSync(process.execPath,['--require',preload,cli,'receive','--peer','PC','--id',id,'--dest',dest],{
   cwd:src,encoding:'utf8',env:{...process.env,COMMANDER_TRANSFER_HOME:dst},timeout:15000
  });
  const part=path.join(dest,'.ctmesh-'+id+'.part'),lock=path.join(dest,'.ctmesh-'+id+'.lock');
  assert.notEqual(killed.status,0);
  assert.equal(fs.existsSync(part),true);
  assert.equal(fs.existsSync(lock),true);
  const partialSize=fs.statSync(part).size;
  assert.ok(partialSize>=1048576&&partialSize<data.length);
  assert.equal(fs.existsSync(path.join(dest,'sample.bin')),false);
  const done=run(dst,'receive','--peer','PC','--id',id,'--dest',dest);
  assert.equal(done.status,0,done.stderr);
  const verified=JSON.parse(done.stdout);
  assert.equal(verified.status,'DELIVERED_HASH_VERIFIED');
  assert.equal(verified.resumedBytes,partialSize);
  assert.equal(verified.sha256,receipt.sha256);
  assert.deepEqual(fs.readFileSync(path.join(dest,'sample.bin')),data);
  assert.equal(fs.existsSync(part),false);
  assert.equal(fs.existsSync(lock),false);
  const repeated=run(dst,'receive','--peer','PC','--id',id,'--dest',dest);
  assert.notEqual(repeated.status,0);
  assert.match(repeated.stderr,/Destination exists/);
 });
});

test('managed pairs ancestor symlink cannot read or write outside pilot root',t=>{
 withFixtures(src=>{
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-pilot-outside-'));
  try{
   fs.mkdirSync(path.join(src,'pairs'));
   try{fs.symlinkSync(outside,path.join(src,'pairs','Linux'),'dir');}
   catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('Symlinks unavailable');return;}throw e;}
   const file=path.join(src,'sender.txt');fs.writeFileSync(file,'sensitive outside write check');
   const write=run(src,'send','--peer','Linux','--id','outside-write-001','--path',file);
   assert.notEqual(write.status,0);
   assert.match(write.stderr,/CTMESH_MANAGED_PATH_UNSAFE/);
   assert.deepEqual(fs.readdirSync(outside),[]);
   const read=run(src,'status','--peer','Linux','--id','outside-read-001');
   assert.notEqual(read.status,0);
   assert.match(read.stderr,/CTMESH_MANAGED_PATH_UNSAFE/);
  }finally{fs.rmSync(outside,{recursive:true,force:true});}
 });
});
test('managed manifest symlink cannot be used as an incoming transfer',t=>{
 withFixtures((src,dst)=>{
  const id='manifest-link-001';send(src,id,Buffer.from('allowed'));
  const incoming=mirror(src,dst,id),outside=path.join(dst,'external-manifest.json');
  fs.copyFileSync(path.join(incoming,'manifest.json'),outside);
  fs.unlinkSync(path.join(incoming,'manifest.json'));
  try{fs.symlinkSync(outside,path.join(incoming,'manifest.json'),'file');}
  catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('Symlinks unavailable');return;}throw e;}
  const read=run(dst,'status','--peer','PC','--id',id);
  assert.notEqual(read.status,0);
  assert.match(read.stderr,/CTMESH_MANAGED_PATH_UNSAFE/);
  assert.equal(fs.existsSync(path.join(dst,'received')),false);
 });
});
test('managed staging symlink rejects outgoing transfer before touching external folder',t=>{
 withFixtures(src=>{
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-stage-outside-'));
  try{
   fs.mkdirSync(path.join(src,'staging'));
   try{fs.symlinkSync(outside,path.join(src,'staging','Linux'),'dir');}
   catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('Symlinks unavailable');return;}throw e;}
   const file=path.join(src,'input.bin');fs.writeFileSync(file,'sample');
   const sendResult=run(src,'send','--peer','Linux','--id','stage-path-001','--path',file);
   assert.notEqual(sendResult.status,0);
   assert.match(sendResult.stderr,/CTMESH_MANAGED_PATH_UNSAFE/);
   assert.deepEqual(fs.readdirSync(outside),[]);
  }finally{fs.rmSync(outside,{recursive:true,force:true});}
 });
});
