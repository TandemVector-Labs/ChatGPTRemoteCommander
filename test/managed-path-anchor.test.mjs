import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createGuiInputIncidentStore,assertUnredirectedDirectoryAncestors} from '../src/gui-incident-store.mjs';
const pilot=fileURLToPath(new URL('../tools/commander-transfer-mesh/pilot-cli.mjs',import.meta.url));
const durable=fileURLToPath(new URL('../tools/commander-transfer-mesh/durable-send.mjs',import.meta.url));
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'root-ancestor-guard-'));
const call=(cli,root,...args)=>spawnSync(process.execPath,[cli,...args],{env:{...process.env,COMMANDER_TRANSFER_HOME:root},encoding:'utf8',timeout:8000});
test('nonlinked private roots remain usable',async()=>{
 const root=temp();
 try{
  fs.writeFileSync(path.join(root,'node.json'),'{"alias":"PC"}');
  assert.doesNotThrow(()=>assertUnredirectedDirectoryAncestors(root));
  const p=call(pilot,root,'info');
  assert.equal(p.status,0,p.stderr);
  assert.equal(JSON.parse(p.stdout).device,'PC');
  const d=call(durable,root,'capabilities');
  assert.equal(d.status,0,d.stderr);
  const f=path.join(root,'gui','incident.json'),g=createGuiInputIncidentStore({file:f});
  const receipt=await g.begin('gui_key_press');
  assert.equal((await g.pending()).id,receipt.id);
  await g.resolve(receipt);
  assert.equal(fs.existsSync(f),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('linked root and parent cannot access external identity, queue or GUI data',async t=>{
 const root=temp(),ext=path.join(root,'external'),alias=path.join(root,'alias');
 try{
  fs.mkdirSync(path.join(ext,'jobs','Linux'),{recursive:true});
  fs.mkdirSync(path.join(ext,'gui','inner'),{recursive:true});
  fs.writeFileSync(path.join(ext,'node.json'),'{"alias":"PC"}');
  fs.writeFileSync(path.join(ext,'jobs','Linux','audit-id.json'),'{"schema":"ctmesh-durable-v1","id":"audit-id","peer":"Linux","status":"PUBLISHED","bytes":0,"copiedBytes":0}');
  try{fs.symlinkSync(ext,alias,process.platform==='win32'?'junction':'dir');}
  catch(e){if(['EPERM','EACCES','ENOTSUP','EOPNOTSUPP'].includes(e.code)){t.skip('Cannot create test junction');return;}throw e;}
  assert.throws(()=>assertUnredirectedDirectoryAncestors(alias),/MANAGED_PATH_UNSAFE/);
  assert.throws(()=>assertUnredirectedDirectoryAncestors(path.join(alias,'gui','inner')),/MANAGED_PATH_UNSAFE/);
  const p=call(pilot,alias,'info');
  assert.notEqual(p.status,0);assert.match(p.stderr,/CTMESH_MANAGED_PATH_UNSAFE/);
  const d=call(durable,alias,'job-status','--peer','Linux','--id','audit-id');
  assert.notEqual(d.status,0);assert.match(d.stderr,/TRANSFER_MANAGED_PATH_UNSAFE/);
  assert.ok(!d.stdout.includes('PUBLISHED'));
  const f=path.join(alias,'gui','inner','incident.json');
  await assert.rejects(createGuiInputIncidentStore({file:f}).begin('gui_key_press'),/GUI_INCIDENT_STORAGE_UNAVAILABLE/);
  assert.equal(fs.existsSync(path.join(ext,'gui','inner','incident.json')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
