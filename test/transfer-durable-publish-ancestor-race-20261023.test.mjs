import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../tools/commander-transfer-mesh/durable-send.mjs');
test('Linux published durable payload must not escape after destination ancestor swap',t=>{
 if(process.platform!=='linux'){t.skip('Linux only');return;}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-dest-race-'));
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-dest-outside-'));
 const peer='Linux',id='durable-publish-race-001',data=Buffer.from('synthetic-publication-race-fixture');
 const parent=path.join(root,'pairs',peer),parentDir=path.join(parent,'transfers');
 const dest=path.join(parentDir,id),mark=path.join(root,'destination-hook.mark'),hook=path.join(root,'destination-hook.cjs');
 try{
  fs.mkdirSync(path.join(root,'jobs',peer),{recursive:true,mode:0o700});
  fs.mkdirSync(parentDir,{recursive:true,mode:0o700});
  // Pre-create only the external folder, so an unpinned final rename can
  // visibly redirect its synthetic payload even without an earlier mkdir.
  fs.mkdirSync(path.join(outside,'transfers',id),{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'PC'}));
  const source=path.join(root,'sample.dat');fs.writeFileSync(source,data);const s=fs.statSync(source);
  fs.writeFileSync(path.join(root,'jobs',peer,id+'.json'),JSON.stringify({
   schema:'ctmesh-durable-v1',id,peer,from:'PC',status:'QUEUED',
   path:source,sourceRoot:root,name:'sample.dat',bytes:s.size,mtimeMs:s.mtimeMs,
   dev:s.dev,ino:s.ino,copiedBytes:0,createdAt:new Date().toISOString()
  })+'\n');
  fs.writeFileSync(hook,[
   "const fs=require('node:fs'),path=require('node:path'),m=require('node:module');",
   "const rename=fs.renameSync;let swapped=false;",
   "fs.renameSync=function(from,to,...args){",
   "if(!swapped&&path.basename(String(to))==='payload.bin'){swapped=true;",
   "rename(process.env.RC_PARENT,process.env.RC_PARENT+'.original');",
   "fs.symlinkSync(process.env.RC_OUTSIDE,process.env.RC_PARENT,'dir');",
   "fs.writeFileSync(process.env.RC_MARK,'swapped');",
   "}return rename.call(this,from,to,...args);",
   "};m.syncBuiltinESMExports();"
  ].join('\n'));
  const res=spawnSync(process.execPath,[cli,'work','--peer',peer,'--id',id],{
   env:{...process.env,NODE_OPTIONS:'--require='+hook,COMMANDER_TRANSFER_HOME:root,
    RC_DEST_PARENT:parentDir,RC_PARENT:parent,RC_OUTSIDE:outside,RC_MARK:mark},
   encoding:'utf8',timeout:10000
  });
  assert.equal(fs.existsSync(mark),true,'actual worker must reach post-copy publication hook; '+res.stderr);
  assert.equal(fs.existsSync(path.join(outside,'transfers',id,'payload.bin')),false,
    'worker must not publish outside operator trust root');
  assert.deepEqual(fs.readdirSync(path.join(outside,'transfers',id)),[],
    'no synthetic transfer bytes may reach the pre-existing external destination');
 }finally{
  fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  fs.rmSync(outside,{recursive:true,force:true,maxRetries:5,retryDelay:50});
 }
});