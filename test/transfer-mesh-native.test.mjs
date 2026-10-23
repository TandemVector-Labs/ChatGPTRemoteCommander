import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createTransferMeshTools, transferMeshToolDefinitions } from '../src/transfer-tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../tools/commander-transfer-mesh/pilot-cli.mjs');
function setup(alias) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-native-'));
 fs.copyFileSync(CLI,path.join(root,'transfer.mjs'));
 fs.writeFileSync(path.join(root,'node.json'), JSON.stringify({alias, schema:'ctmesh-node-v1'}));
 const src=path.join(root,'inputs'),dest=path.join(root,'outputs');
 fs.mkdirSync(src); fs.mkdirSync(dest);
 const tools=createTransferMeshTools({config:{powerMode:{enabled:true},transferMesh:{
  enabled:true,root,sourceRoots:[src],destinationRoots:[dest]
 }}});
 return {root,tools,src,dest};
}
async function fixture(fn) {
 const a=setup('PC'),b=setup('Linux');
 try { await fn(a,b); } finally {fs.rmSync(a.root,{recursive:true,force:true});fs.rmSync(b.root,{recursive:true,force:true});}
}
test('feature is hidden unless explicit enable and Power Mode', ()=>{
 assert.equal(createTransferMeshTools({config:{}}).definitions.length,0);
 assert.equal(createTransferMeshTools({config:{powerMode:{enabled:false},transferMesh:{enabled:true}}}).definitions.length,0);
 assert.equal(transferMeshToolDefinitions.length,4);
 assert.deepEqual(transferMeshToolDefinitions.map(x=>x.name),['transfer_mesh_info','transfer_mesh_send','transfer_mesh_status','transfer_mesh_receive']);
});
test('native adapter sends, reads status and receives safely without overwrite',async()=>{
 await fixture(async(a,b)=>{
  assert.equal(a.tools.enabled,true);
  const file=path.join(a.src,'input.dat');
  fs.writeFileSync(file,Buffer.from('12345678912345'));
  const info=await a.tools.execute('transfer_mesh_info');
  assert.equal(info.device,'PC');
  const sent=await a.tools.execute('transfer_mesh_send',{peer:'Linux',path:file,id:'native-001'});
  assert.equal(sent.status,'QUEUED');
  const incoming=path.join(b.root,'pairs','PC','transfers','native-001');
  fs.mkdirSync(path.dirname(incoming),{recursive:true});
  fs.cpSync(path.join(a.root,'pairs','Linux','transfers','native-001'),incoming,{recursive:true});
  assert.equal((await b.tools.execute('transfer_mesh_status',{peer:'PC',id:'native-001'})).status,'RECEIVED_HASH_VERIFIED');
  const complete=await b.tools.execute('transfer_mesh_receive',{peer:'PC',id:'native-001',dest:b.dest});
  assert.equal(complete.status,'DELIVERED_HASH_VERIFIED');
  assert.deepEqual(fs.readFileSync(path.join(b.dest,'input.dat')),fs.readFileSync(file));
  await assert.rejects(b.tools.execute('transfer_mesh_receive',{peer:'PC',id:'native-001',dest:b.dest}),/Destination exists/);
 });
});
test('linked lock fails closed and verified stale receive lock is safely reclaimed',async()=>{
 await fixture(async(a,b)=>{
  const id='native-stale-001',source=path.join(a.src,'stale-lock-source.dat');
  fs.writeFileSync(source,'safe-stale-recovery-fixture');
  const sent=await a.tools.execute('transfer_mesh_send',{peer:'Linux',path:source,id});
  assert.equal(sent.status,'QUEUED');
  const incoming=path.join(b.root,'pairs','PC','transfers',id);
  fs.mkdirSync(path.dirname(incoming),{recursive:true});
  fs.cpSync(path.join(a.root,'pairs','Linux','transfers',id),incoming,{recursive:true});
  const manifest=JSON.parse(fs.readFileSync(path.join(incoming,'manifest.json'),'utf8'));
  const lock=path.join(b.dest,'.ctmesh-'+id+'.lock');
  const unrelated=path.join(b.root,'unrelated-lock.json');
  fs.writeFileSync(unrelated,'untrusted and must not be read');
  fs.linkSync(unrelated,lock);
  await assert.rejects(
   b.tools.execute('transfer_mesh_receive',{peer:'PC',id,dest:b.dest}),
   /Untrusted receive lock/
  );
  assert.equal(fs.readFileSync(unrelated,'utf8'),'untrusted and must not be read');
  assert.equal(fs.existsSync(path.join(b.dest,'stale-lock-source.dat')),false);
  fs.unlinkSync(lock);
  // The lock belongs to this exact received item, but the recorded owner PID
  // is absent. A verified regular file may be reclaimed without overwriting.
  fs.writeFileSync(lock,JSON.stringify({
   schema:'ctmesh-receive-lock-v1',host:os.hostname(),peer:'PC',
   id,sha256:manifest.sha256,pid:2147483647
  })+'\n');
  const completed=await b.tools.execute('transfer_mesh_receive',{peer:'PC',id,dest:b.dest});
  assert.equal(completed.status,'DELIVERED_HASH_VERIFIED');
  assert.equal(fs.readFileSync(path.join(b.dest,'stale-lock-source.dat'),'utf8'),'safe-stale-recovery-fixture');
  assert.equal(fs.existsSync(lock),false);
 });
});

test('root allowlists deny unauthorized paths and other peers',async()=>{
 await fixture(async(a)=>{
  const file=path.join(a.root,'other.dat');
  fs.writeFileSync(file,'private');
  await assert.rejects(a.tools.execute('transfer_mesh_send',{peer:'Linux',path:file,id:'native-002'}),/TRANSFER_PATH_NOT_ALLOWED/);
  await assert.rejects(a.tools.execute('transfer_mesh_send',{peer:'NotARealDevice',path:file,id:'native-003'}),/TRANSFER_UNKNOWN_PEER/);
  await assert.rejects(a.tools.execute('transfer_mesh_send',{peer:'Linux',path:file,id:'..'}),/TRANSFER_ID_INVALID/);
  await assert.rejects(a.tools.execute('transfer_mesh_receive',{peer:'Linux',id:'native-003',dest:a.src}),/TRANSFER_PATH_NOT_ALLOWED/);
 });
});
test('failed config and blocked symlink path',async(t)=>{
 await fixture(async(a)=>{
  assert.throws(()=>createTransferMeshTools({config:{powerMode:{enabled:true},transferMesh:{enabled:true,root:'relative'}}}),/TRANSFER_MESH_ROOT_INVALID/);
  const file=path.join(a.src,'real.dat'),sym=path.join(a.src,'alias.dat');
  fs.writeFileSync(file,'sample');
  try {fs.symlinkSync(file,sym);}catch(e){if(e.code==='EPERM'){t.diagnostic('Windows symlink creation unavailable');return;}throw e;}
  await assert.rejects(a.tools.execute('transfer_mesh_send',{peer:'Linux',path:sym,id:'native-004'}),/TRANSFER_SYMLINK_DENIED/);
 });
});

test('synchronous send obeys source size limit even when durable backend is disabled',async()=>{
 await fixture(async(a)=>{
  const file=path.join(a.src,'too-large.dat');
  fs.writeFileSync(file,Buffer.alloc(4096,0x51));
  const tools=createTransferMeshTools({config:{powerMode:{enabled:true},transferMesh:{
   enabled:true,durableEnabled:false,root:a.root,sourceRoots:[a.src],destinationRoots:[a.dest],
   maxSourceBytes:1024,maxPendingBytes:8192,maxActiveJobs:1
  }}});
  await assert.rejects(tools.execute('transfer_mesh_send',{peer:'Linux',path:file,id:'synchronous-quota-001'}),/TRANSFER_SOURCE_SIZE_QUOTA/);
  assert.equal(fs.existsSync(path.join(a.root,'pairs','Linux','transfers','synchronous-quota-001')),false);
 });
});

test('stale receive-lock reclamation never removes an atomically replaced active lock',async()=>{
 await fixture(async(a,b)=>{
  const id='race-lock-001',source=path.join(a.src,'race-lock-source.dat');
  fs.writeFileSync(source,'known-source-bytes');
  assert.equal((await a.tools.execute('transfer_mesh_send',{peer:'Linux',path:source,id})).status,'QUEUED');
  const incoming=path.join(b.root,'pairs','PC','transfers',id);
  fs.mkdirSync(path.dirname(incoming),{recursive:true});
  fs.cpSync(path.join(a.root,'pairs','Linux','transfers',id),incoming,{recursive:true});
  const manifest=JSON.parse(fs.readFileSync(path.join(incoming,'manifest.json'),'utf8'));
  const lock=path.join(b.dest,'.ctmesh-'+id+'.lock'),hook=path.join(b.root,'attack-preload.cjs');
  const marker=path.join(b.root,'race-hook-fired');
  fs.writeFileSync(lock,JSON.stringify({
   schema:'ctmesh-receive-lock-v1',host:os.hostname(),peer:'PC',id,
   sha256:manifest.sha256,pid:2147483647
  })+'\n');
  fs.writeFileSync(hook,[
   "const fs=require('node:fs'),mod=require('node:module'),path=require('node:path');",
   "const original=fs.unlinkSync,oldRename=fs.renameSync;let fired=false;",
   "fs.writeFileSync(process.env.CTMESH_LOCK_RACE_MARKER+'.loaded','YES');",
   "const matchLock=file=>String(file)===process.env.CTMESH_LOCK_RACE_FILE||(process.platform==='linux'&&String(file).startsWith('/proc/self/fd/')&&path.basename(String(file))===path.basename(process.env.CTMESH_LOCK_RACE_FILE));",
   "function substitute(file){fired=true;oldRename.call(fs,file,String(file)+'.reclaimed-old');",
   " const record=JSON.parse(fs.readFileSync(String(file)+'.reclaimed-old','utf8'));",
   " fs.writeFileSync(file,JSON.stringify({...record,pid:process.pid})+'\\n');",
   " fs.writeFileSync(process.env.CTMESH_LOCK_RACE_MARKER,'FRESH_LOCK_REPLACED');}",
   "fs.unlinkSync=function(file,...args){",
   " if(!fired&&matchLock(file))substitute(file);",
   " return original.call(this,file,...args);};",
   "fs.renameSync=function(from,to,...args){",
   " if(!fired&&matchLock(from)&&",
   " String(to).includes('.stale-reclaim-'))substitute(from);",
   " return oldRename.call(this,from,to,...args);};",
   "mod.syncBuiltinESMExports();"
  ].join('\n'));
  const result=spawnSync(process.execPath,[
   '--require',hook,path.join(b.root,'transfer.mjs'),
   'receive','--peer','PC','--id',id,'--dest',b.dest
  ],{encoding:'utf8',timeout:15000,env:{...process.env,
   COMMANDER_TRANSFER_HOME:b.root,
   CTMESH_LOCK_RACE_FILE:lock,
   CTMESH_LOCK_RACE_MARKER:marker}});
  assert.equal(fs.existsSync(marker+'.loaded'),true,'Preload must actually execute');
  assert.equal(fs.existsSync(marker),true,'Race injection must run at actual lock mutation');
  assert.notEqual(result.status,0,'Changed live lock must fail-closed: '+result.stdout);
  assert.match(result.stderr,/Receive already owned|Untrusted receive lock|Receive lock changed/);
  assert.equal(fs.existsSync(lock),true,'Fresh active receive lock must not be deleted');
 });
});

test('receive completion cannot unlink a fresh replacement owner lock',async()=>{
 await fixture(async(a,b)=>{
  const id='race-release-001',source=path.join(a.src,'release-lock-source.dat');
  fs.writeFileSync(source,'verified-receive-content');
  assert.equal((await a.tools.execute('transfer_mesh_send',{peer:'Linux',path:source,id})).status,'QUEUED');
  const dir=path.join(b.root,'pairs','PC','transfers',id);
  fs.mkdirSync(path.dirname(dir),{recursive:true});
  fs.cpSync(path.join(a.root,'pairs','Linux','transfers',id),dir,{recursive:true});
  const lock=path.join(b.dest,'.ctmesh-'+id+'.lock'),marker=path.join(b.root,'release-injection-fired');
  const hook=path.join(b.root,'release-lock-hook.cjs');
  fs.writeFileSync(hook,[
   "const fs=require('node:fs'),mod=require('node:module'),path=require('node:path');",
   "const oldUnlink=fs.unlinkSync,oldRename=fs.renameSync;let fired=false;",
   "fs.writeFileSync(process.env.CTMESH_RELEASE_RACE_MARKER+'.loaded','YES');",
   "const matchLock=file=>String(file)===process.env.CTMESH_RELEASE_RACE_LOCK||(process.platform==='linux'&&String(file).startsWith('/proc/self/fd/')&&path.basename(String(file))===path.basename(process.env.CTMESH_RELEASE_RACE_LOCK));",
   "function swap(file){fired=true;oldRename.call(fs,file,file+'.prior-owner');",
   " const record=JSON.parse(fs.readFileSync(file+'.prior-owner','utf8'));",
   " fs.writeFileSync(file,JSON.stringify({...record,pid:process.pid})+'\\n');",
   " fs.writeFileSync(process.env.CTMESH_RELEASE_RACE_MARKER,'REPLACED');}",
   "fs.unlinkSync=function(file,...args){",
   " if(!fired&&matchLock(file))swap(String(file));",
   " return oldUnlink.call(this,file,...args);};",
   "fs.renameSync=function(from,to,...args){",
   " if(!fired&&matchLock(from)&&",
   " String(to).includes('.release-retire-'))swap(String(from));",
   " return oldRename.call(this,from,to,...args);};",
   "mod.syncBuiltinESMExports();"
  ].join('\n'));
  const result=spawnSync(process.execPath,[
   '--require',hook,path.join(b.root,'transfer.mjs'),
   'receive','--peer','PC','--id',id,'--dest',b.dest
  ],{encoding:'utf8',timeout:15000,env:{...process.env,
   COMMANDER_TRANSFER_HOME:b.root,
   CTMESH_RELEASE_RACE_LOCK:lock,
   CTMESH_RELEASE_RACE_MARKER:marker}});
  assert.equal(fs.existsSync(marker+'.loaded'),true,'Child preload must run');
  assert.equal(fs.existsSync(marker),true,'Race must trigger at actual release boundary');
  assert.equal(fs.existsSync(lock),true,'Fresh active lock B must be preserved');
  assert.notEqual(result.status,0,'Released owner cannot claim success after its lock was replaced');
  assert.match(result.stderr,/Receive lock changed|Untrusted receive lock/);
 });
});
