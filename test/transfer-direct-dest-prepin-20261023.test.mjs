import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const cli=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../tools/commander-transfer-mesh/pilot-cli.mjs');
test('direct receive refuses missing destination before any unpinned mkdir or write',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-direct-dest-'));
 const id='direct-no-mkdir-001',data=Buffer.from('verified disposable fixture');
 const inbound=path.join(root,'pairs','PC','transfers',id),dest=path.join(root,'missing','nested','inbox');
 try{
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'Linux',schema:'ctmesh-node-v1'}));
  fs.mkdirSync(inbound,{recursive:true});
  fs.writeFileSync(path.join(inbound,'payload.bin'),data);
  fs.writeFileSync(path.join(inbound,'manifest.json'),JSON.stringify({
   schema:'ctmesh-v1',id,from:'PC',to:'Linux',name:'sample.bin',
   bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex'),
   createdAt:new Date().toISOString()
  })+'\n');
  const result=spawnSync(process.execPath,[cli,'receive','--peer','PC','--id',id,'--dest',dest],
   {env:{...process.env,COMMANDER_TRANSFER_HOME:root},encoding:'utf8',timeout:12000,windowsHide:true});
  assert.notEqual(result.status,0,'direct CLI must not implicitly create a destination before pinned boundary');
  assert.match(result.stderr,/DESTINATION_MUST_EXIST/);
  assert.equal(fs.existsSync(path.join(root,'missing')),false,'no ancestor may be created');
  assert.deepEqual(fs.readFileSync(path.join(inbound,'payload.bin')),data);
 }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});

test('direct receive rejects existing symlink or junction destination',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-prepin-alias-'));
 const id='prepin-symlink-001',data=Buffer.from('disposable checked payload');
 const inbound=path.join(root,'pairs','PC','transfers',id);
 const outside=path.join(root,'outside'),dest=path.join(root,'alias');
 try{
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'Linux',schema:'ctmesh-node-v1'}));
  fs.mkdirSync(inbound,{recursive:true});
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(inbound,'payload.bin'),data);
  fs.writeFileSync(path.join(inbound,'manifest.json'),JSON.stringify({
   schema:'ctmesh-v1',id,from:'PC',to:'Linux',name:'sample.bin',
   bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex'),
   createdAt:new Date().toISOString()
  })+'\n');
  try{fs.symlinkSync(outside,dest,process.platform==='win32'?'junction':'dir');}
  catch(e){if(e.code==='EPERM' || e.code==='EACCES'){t.skip('Host cannot create disposable symlink/junction');return;}throw e;}
  const result=spawnSync(process.execPath,[cli,'receive','--peer','PC','--id',id,'--dest',dest],
   {env:{...process.env,COMMANDER_TRANSFER_HOME:root},encoding:'utf8',timeout:12000,windowsHide:true});
  assert.notEqual(result.status,0,'symlinked destination must be refused');
  assert.match(result.stderr,/DESTINATION_NOT_DIRECTORY/);
  assert.equal(fs.existsSync(path.join(outside,'sample.bin')),false,'must not materialize outside target');
 }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});
