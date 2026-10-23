import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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