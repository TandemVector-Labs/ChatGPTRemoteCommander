import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../tools/commander-transfer-mesh/pilot-cli.mjs');
test('Linux pinned destination refuses post-validation path redirection',t=>{
 if(process.platform!=='linux')return t.skip('Linux no-follow directory FD contract');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-native-fd-race-'));
 const dest=path.join(root,'allowed'),outside=path.join(root,'disposable-outside'),id='native-fd-race-001';
 const inbound=path.join(root,'pairs','PC','transfers',id),payload=Buffer.from('synthetic FD boundary fixture');
 try{
  fs.mkdirSync(dest);fs.mkdirSync(outside);fs.mkdirSync(inbound,{recursive:true});
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'Linux',schema:'ctmesh-node-v1'}));
  fs.writeFileSync(path.join(inbound,'payload.bin'),payload);
  fs.writeFileSync(path.join(inbound,'manifest.json'),JSON.stringify({
   schema:'ctmesh-v1',id,from:'PC',to:'Linux',name:'sample.bin',
   bytes:payload.length,sha256:crypto.createHash('sha256').update(payload).digest('hex'),
   createdAt:new Date().toISOString()
  })+'\n');
  const hook=path.join(root,'hook.cjs'),marker=path.join(root,'race-marker');
  fs.writeFileSync(hook,[
   "const fs=require('node:fs'),mod=require('node:module');",
   "const exists=fs.existsSync,rename=fs.renameSync;let done=false;",
   "fs.existsSync=function(file,...args){",
   " if(!done&&String(file).startsWith('/proc/self/fd/')&&String(file).endsWith('/sample.bin')&&process.argv.includes('receive')){",
   "  done=true;",
   "  rename(process.env.TVL_RACE_DEST,process.env.TVL_RACE_DEST+'.original');",
   "  fs.symlinkSync(process.env.TVL_RACE_OUTSIDE,process.env.TVL_RACE_DEST,'dir');",
   "  fs.writeFileSync(process.env.TVL_RACE_MARKER,'TRIGGERED');",
   " }return exists.call(fs,file,...args);",
   "};mod.syncBuiltinESMExports();"
  ].join('\n'));
  const st=fs.lstatSync(dest,{bigint:true});
  const result=spawnSync(process.execPath,[cli,'receive','--peer','PC','--id',id,'--dest',dest,
   '--dest-dev',String(st.dev),'--dest-ino',String(st.ino)],{
   encoding:'utf8',timeout:12000,windowsHide:true,
   env:{...process.env,COMMANDER_TRANSFER_HOME:root,NODE_OPTIONS:'--require='+hook,
    TVL_RACE_DEST:dest,TVL_RACE_OUTSIDE:outside,TVL_RACE_MARKER:marker}
  });
  assert.equal(fs.existsSync(marker),true,'Attack must reach post-FD-pinning step');
  assert.equal(fs.existsSync(path.join(outside,'sample.bin')),false,'No publication outside approved inode');
  assert.notEqual(result.status,0,'Moved destination must not yield delivered receipt');
  assert.match(result.stderr,/DESTINATION_IDENTITY_CHANGED/);
  assert.doesNotMatch(result.stdout,/DELIVERED_HASH_VERIFIED/);
 }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});
