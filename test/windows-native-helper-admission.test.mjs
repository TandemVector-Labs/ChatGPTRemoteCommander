import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const worker=path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../tools/commander-transfer-mesh/durable-send.mjs');

test('copied transfer worker must not launch an operator-selected native executable',()=>{
 const source=fs.readFileSync(worker,'utf8');
 for(const name of ['COMMANDER_TRANSFER_NATIVE_READER',
                     'COMMANDER_TRANSFER_NATIVE_READER_SHA256'])
  assert.equal(source.includes(name),false,'Unreviewed external executable selector: '+name);
 assert.doesNotMatch(source,/\bspawnSync\s*\(/,
   'Sync native executable launch reintroduces post-hash path-race authority');
});

test('Windows runtime ignores unadmitted executable environment selectors',
 {skip:process.platform!=='win32'},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-helper-admission-'));
 try{
  const job=path.join(dir,'jobs','Linux');
  fs.mkdirSync(job,{recursive:true});
  const id='admission-guard-001';
  const state={schema:'ctmesh-durable-v1',peer:'Linux',id,status:'QUEUED',bytes:3,
   createdAt:new Date().toISOString()};
  fs.writeFileSync(path.join(job,id+'.json'),JSON.stringify(state));
  const binary=process.execPath;
  const sha=crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  const env={...process.env,COMMANDER_TRANSFER_HOME:dir,
   COMMANDER_TRANSFER_NATIVE_READER:binary,
   COMMANDER_TRANSFER_NATIVE_READER_SHA256:sha};
  const r=spawnSync(process.execPath,[worker,'job-status','--peer','Linux','--id',id],
   {encoding:'utf8',timeout:10000,env});
  assert.equal(r.status,0,
   'Unapproved environment must not activate a native executable: '+r.stderr);
  assert.equal(JSON.parse(r.stdout).status,'QUEUED');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
