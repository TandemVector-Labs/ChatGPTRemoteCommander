import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createTransferMeshTools} from '../src/transfer-tools.mjs';
test('Windows pinned destination refuses rename while received file is published',async t=>{
 if(process.platform!=='win32')return t.skip('Win32 share-delete security invariant');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-active-dest-pin-'));
 const a=path.join(tmp,'a'),b=path.join(tmp,'b');
 const src=path.join(a,'in'),dest=path.join(b,'out'),marker=path.join(tmp,'pin-rename-marker');
 const saved=process.env.NODE_OPTIONS;
 try{
  for(const p of [src,dest])fs.mkdirSync(p,{recursive:true});
  const original=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../tools/commander-transfer-mesh/pilot-cli.mjs');
  for(const [root,alias] of [[a,'PC'],[b,'Linux']]){
   fs.copyFileSync(original,path.join(root,'transfer.mjs'));
   fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias,schema:'ctmesh-node-v1'}));
  }
  const mkTools=(root,source,destination)=>createTransferMeshTools({config:{powerMode:{enabled:true},
   transferMesh:{enabled:true,root,sourceRoots:[source],destinationRoots:[destination]}}});
  const input=path.join(src,'valid-pin-guard.dat');
  fs.writeFileSync(input,'private-disposable-fixture');
  const sender=mkTools(a,src,src);
  assert.equal((await sender.execute('transfer_mesh_send',{peer:'Linux',path:input,id:'active-dir-pin-001'})).status,'QUEUED');
  const incoming=path.join(b,'pairs','PC','transfers','active-dir-pin-001');
  fs.mkdirSync(path.dirname(incoming),{recursive:true});
  fs.cpSync(path.join(a,'pairs','Linux','transfers','active-dir-pin-001'),incoming,{recursive:true});
  const preload=path.join(tmp,'rename-hook.cjs');
  fs.writeFileSync(preload,[
   "const fs=require('node:fs'),mod=require('node:module');",
   "const oldLink=fs.linkSync,oldRename=fs.renameSync;",
   "fs.linkSync=function(from,to,...args){",
   " if(String(to).endsWith('valid-pin-guard.dat')){",
   "  let outcome='MOVED';",
   "  try{oldRename(process.env.RC_PIN_TEST_DEST,process.env.RC_PIN_TEST_DEST+'.outside');}",
   "  catch(e){outcome='BLOCKED_'+String(e.code||'ERROR');}",
   "  fs.writeFileSync(process.env.RC_PIN_TEST_MARKER,outcome);",
   " }",
   " return oldLink.call(this,from,to,...args);",
   "};mod.syncBuiltinESMExports();"
  ].join('\n'));
  process.env.NODE_OPTIONS='--require='+preload;
  process.env.RC_PIN_TEST_DEST=dest;
  process.env.RC_PIN_TEST_MARKER=marker;
  const receiver=mkTools(b,dest,dest);
  const result=await receiver.execute('transfer_mesh_receive',{peer:'PC',id:'active-dir-pin-001',dest});
  assert.equal(result.status,'DELIVERED_HASH_VERIFIED');
  assert.ok(fs.existsSync(marker),'actual publish path was reached');
  assert.match(fs.readFileSync(marker,'utf8'),/^BLOCKED_/,'directory mutation must be denied while native handle is held');
  assert.equal(fs.readFileSync(path.join(dest,'valid-pin-guard.dat'),'utf8'),'private-disposable-fixture');
  assert.equal(fs.existsSync(dest+'.outside'),false);
 }finally{
  if(saved===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=saved;
  delete process.env.RC_PIN_TEST_DEST;delete process.env.RC_PIN_TEST_MARKER;
  fs.rmSync(tmp,{recursive:true,force:true});
 }
});

test('Windows receiving process retains directory pins after guardian termination',t=>{
 if(process.platform!=='win32')return t.skip('Win32 duplicated no-delete handle');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-parent-pinned-'));
 const dest=path.join(root,'admitted'),outside=path.join(root,'outside'),id='guard-death-qa-001';
 const incoming=path.join(root,'pairs','PC','transfers',id),data=Buffer.from('only-disposable-pin-fixture');
 const hook=path.join(root,'hook.cjs'),killed=path.join(root,'killed'),attempt=path.join(root,'attempt');
 try{
  fs.mkdirSync(dest);fs.mkdirSync(outside);fs.mkdirSync(incoming,{recursive:true});
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'Linux',schema:'ctmesh-node-v1'}));
  fs.writeFileSync(path.join(incoming,'payload.bin'),data);
  fs.writeFileSync(path.join(incoming,'manifest.json'),JSON.stringify({
   schema:'ctmesh-v1',id,from:'PC',to:'Linux',name:'sample.bin',bytes:data.length,
   sha256:crypto.createHash('sha256').update(data).digest('hex'),createdAt:new Date().toISOString()
  })+'\n');
  fs.writeFileSync(hook,[
   "const fs=require('node:fs'),cp=require('node:child_process'),mod=require('node:module');",
   "const oldSpawn=cp.spawn,oldExists=fs.existsSync;let guardKilled=false,attempted=false;",
   "cp.spawn=function(cmd,...args){const child=oldSpawn.apply(this,arguments);",
   " if(String(cmd).toLowerCase().endsWith('pwsh.exe')&&process.argv.includes('receive')){",
   "  child.stdout.on('data',b=>{if(!guardKilled&&String(b).includes('CTMESH_PIN_READY')){",
   "   cp.execFileSync('taskkill.exe',['/PID',String(child.pid),'/F'],{timeout:8000,windowsHide:true});",
   "   guardKilled=true;fs.writeFileSync(process.env.TVL_KILLED,'GUARD_TERMINATED');",
   "  }});",
   " }return child;};",
   "fs.existsSync=function(p,...args){",
   " if(guardKilled&&!attempted&&process.argv.includes('receive')&&String(p).endsWith('sample.bin')&&String(p).includes('admitted')){",
   "  attempted=true;let result='SWAPPED';",
   "  try{fs.renameSync(process.env.TVL_DEST,process.env.TVL_DEST+'.original');",
   "      fs.symlinkSync(process.env.TVL_OUTSIDE,process.env.TVL_DEST,'junction');}",
   "  catch(e){result='BLOCKED_'+String(e.code||'ERROR');}",
   "  fs.writeFileSync(process.env.TVL_ATTEMPT,result);",
   " }return oldExists.call(this,p,...args);",
   "};mod.syncBuiltinESMExports();"
  ].join('\n'));
  const stat=fs.lstatSync(dest,{bigint:true});
  const original=path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    '../tools/commander-transfer-mesh/pilot-cli.mjs');
  const result=spawnSync(process.execPath,[original,'receive','--peer','PC','--id',id,'--dest',dest,
    '--dest-dev',String(stat.dev),'--dest-ino',String(stat.ino)],{
    encoding:'utf8',timeout:18000,windowsHide:true,
    env:{...process.env,COMMANDER_TRANSFER_HOME:root,NODE_OPTIONS:'--require='+hook,
      TVL_DEST:dest,TVL_OUTSIDE:outside,TVL_KILLED:killed,TVL_ATTEMPT:attempt}
  });
  assert.equal(result.error,undefined,result.error?.message);
  assert.equal(fs.existsSync(killed),true,'actual helper must die after READY');
  assert.equal(fs.existsSync(attempt),true,'attack must hit native publication path');
  assert.match(fs.readFileSync(attempt,'utf8'),/^BLOCKED_/,
    'the receiver-held handle must deny moving the destination after helper exit');
  assert.equal(fs.existsSync(path.join(outside,'sample.bin')),false,
    'payload must never materialize in attacker-selected directory');
  assert.equal(fs.existsSync(dest+'.original'),false);
 }finally{
  try{if(fs.lstatSync(dest).isSymbolicLink())fs.rmdirSync(dest);}catch{}
  fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
 }
});
