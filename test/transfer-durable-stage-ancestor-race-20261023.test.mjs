import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const cli=path.resolve(path.dirname(fileURLToPath(import.meta.url)),
 '../tools/commander-transfer-mesh/durable-send.mjs');
test('Linux durable worker cannot stage bytes through a substituted ancestor symlink',t=>{
 if(process.platform!=='linux'){t.skip('Linux descriptor-relative race fixture');return;}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-durable-stage-race-'));
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'rc-durable-outside-'));
 const id='durable-stage-race-001',peer='Linux',data=Buffer.from('synthetic test-only transfer payload');
 const stage=path.join(root,'staging',peer),part=path.join(stage,id+'.part');
 const marker=path.join(root,'hook-fired'),proof=path.join(root,'outside-bytes');
 const hook=path.join(root,'stage-race-hook.cjs');
 try{
  const source=path.join(root,'test-input.dat'),jobs=path.join(root,'jobs',peer);
  fs.mkdirSync(jobs,{recursive:true});fs.writeFileSync(source,data);
  const s=fs.lstatSync(source);
  fs.writeFileSync(path.join(jobs,id+'.json'),JSON.stringify({
   schema:'ctmesh-durable-v1',id,peer,from:'PC',status:'QUEUED',name:'test-input.dat',
   path:source,sourceRoot:root,bytes:s.size,mtimeMs:s.mtimeMs,
   ino:s.ino,dev:s.dev,copiedBytes:0,createdAt:new Date().toISOString()
  })+'\n');
  fs.writeFileSync(hook,[
   "const fs=require('node:fs'),p=require('node:path'),m=require('node:module');",
   "const open=fs.openSync,rename=fs.renameSync;let swapped=false;",
   "fs.openSync=function(name,...args){",
   " if(!swapped&&p.basename(String(name))===p.basename(process.env.RC_STAGE_PART)){swapped=true;",
   "  rename(process.env.RC_STAGE,process.env.RC_STAGE+'.original');",
   "  fs.symlinkSync(process.env.RC_OUTSIDE,process.env.RC_STAGE,'dir');",
   "  fs.writeFileSync(process.env.RC_HOOK_MARKER,'swapped');",
   " }return open.call(this,name,...args);",
   "};",
   "fs.renameSync=function(from,to,...args){",
   " if(String(from)===process.env.RC_STAGE_PART){",
   "  const redirected=p.join(process.env.RC_OUTSIDE,p.basename(String(from)));",
   "  if(fs.existsSync(redirected))fs.writeFileSync(process.env.RC_PROOF,fs.readFileSync(redirected));",
   "  throw new Error('PROBE_ABORT_BEFORE_PUBLICATION');",
   " }return rename.call(this,from,to,...args);",
   "};m.syncBuiltinESMExports();"
  ].join('\n'));
  const r=spawnSync(process.execPath,[cli,'work','--peer',peer,'--id',id],{
   env:{...process.env,COMMANDER_TRANSFER_HOME:root,NODE_OPTIONS:'--require='+hook,
    RC_STAGE:stage,RC_STAGE_PART:part,RC_OUTSIDE:outside,
    RC_HOOK_MARKER:marker,RC_PROOF:proof},
   encoding:'utf8',timeout:9000
  });
  assert.equal(fs.existsSync(marker),true,'real worker must reach race hook');
  assert.equal(fs.existsSync(proof),false,
    'synthetic source bytes must never be staged via a redirected parent');
  assert.deepEqual(fs.readdirSync(outside),[],'no external partial may survive');
 }finally{
  fs.rmSync(root,{recursive:true,force:true,maxRetries:4,retryDelay:40});
  fs.rmSync(outside,{recursive:true,force:true,maxRetries:4,retryDelay:40});
 }
});
