import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const durable=path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../tools/commander-transfer-mesh/durable-send.mjs');

test('durable resume preserves a newly substituted owner lock',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-lock-generation-'));
 const id='race-durable-001',peer='Linux';
 const dir=path.join(root,'jobs',peer),lock=path.join(dir,id+'.lock');
 const marker=path.join(root,'race-marker'),preload=path.join(root,'race-hook.cjs');
 try{
  fs.mkdirSync(dir,{recursive:true});
  const record=path.join(dir,id+'.json');
  fs.writeFileSync(record,JSON.stringify({schema:'ctmesh-durable-v1',id,peer,
    status:'FAILED',path:path.join(root,'source-missing.dat'),
    sourceRoot:root,createdAt:new Date().toISOString()})+'\n');
  fs.writeFileSync(lock,JSON.stringify({pid:0,kind:'stale-owner'})+'\n');
  fs.writeFileSync(preload,[
   "const fs=require('node:fs'),path=require('node:path'),mod=require('node:module');",
   "const originalRemove=fs.rmSync,originalRename=fs.renameSync;let fired=false;",
   "function swap(file){",
   " if(!fired&&path.resolve(String(file)).toLowerCase()===path.resolve(process.env.RC_LOCK_RACE_TARGET).toLowerCase()){",
   "  fired=true;",
   "  originalRename(file,String(file)+'.old');",
   "  fs.writeFileSync(file,JSON.stringify({pid:process.pid,kind:'new-live-owner'})+'\\n');",
   "  fs.writeFileSync(process.env.RC_LOCK_RACE_MARKER,'SUBSTITUTED');",
   " }",
   "}",
   "fs.rmSync=function(file,...opts){swap(file);return originalRemove.call(this,file,...opts);};",
   "fs.renameSync=function(file,to,...opts){swap(file);return originalRename.call(this,file,to,...opts);};",
   "mod.syncBuiltinESMExports();"
  ].join('\n'));
  const child=spawnSync(process.execPath,[durable,'resume','--peer',peer,'--id',id],{
   env:{...process.env,COMMANDER_TRANSFER_HOME:root,
    NODE_OPTIONS:'--require='+preload,RC_LOCK_RACE_TARGET:lock,
    RC_LOCK_RACE_MARKER:marker},windowsHide:true,encoding:'utf8',timeout:8000
  });
  assert.equal(fs.existsSync(marker),true,'preload must reach real stale-lock unlink');
  const freshExists=fs.existsSync(lock);
  const retiredExists=fs.existsSync(lock+'.old');
  testContextDiagnostic({freshExists,retiredExists,childExit:child.status});
  assert.equal(freshExists,true,'fresh owner lock must never be deleted');
  assert.deepEqual(JSON.parse(fs.readFileSync(lock,'utf8')).kind,'new-live-owner');
 } finally {
  fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:60});
 }
});
function testContextDiagnostic(result){ process.stdout.write('DURABLE_LOCK_RACE_OBSERVATION '+JSON.stringify(result)+'\n'); }
