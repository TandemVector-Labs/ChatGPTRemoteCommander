import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createGuiInputIncidentStore} from '../src/gui-incident-store.mjs';
import {assertUnredirectedDirectoryAncestors} from '../src/managed-path-anchor.mjs';
import {pinnedSyncthingJson} from '../tools/commander-transfer-mesh/doctor-rest-identity.mjs';
const pilot=fileURLToPath(new URL('../tools/commander-transfer-mesh/pilot-cli.mjs',import.meta.url));
const durable=fileURLToPath(new URL('../tools/commander-transfer-mesh/durable-send.mjs',import.meta.url));
const doctor=fileURLToPath(new URL('../tools/commander-transfer-mesh/doctor.mjs',import.meta.url));
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

test('Windows operator roots deny network and device namespace paths without I/O',
 {skip:process.platform!=='win32'},async()=>{
 const sep=String.fromCharCode(92);
 const roots=[sep+sep+'unreachable.invalid'+sep+'untrusted'+sep+'operator',
              sep+sep+'?'+sep+'C:'+sep+'untrusted'+sep+'operator'];
 for(const root of roots){
   assert.throws(()=>assertUnredirectedDirectoryAncestors(root),/MANAGED_PATH_UNSAFE/);
   const p=call(pilot,root,'info');
   assert.notEqual(p.status,0);assert.match(p.stderr,/CTMESH_MANAGED_PATH_UNSAFE/);
   const d=call(durable,root,'job-status','--peer','Linux','--id','unc-probe');
   assert.notEqual(d.status,0);assert.match(d.stderr,/TRANSFER_MANAGED_PATH_UNSAFE/);
   const host=spawnSync(process.execPath,[doctor],{encoding:'utf8',timeout:5000,
     env:{...process.env,COMMANDER_TRANSFER_HOME:root}});
   assert.notEqual(host.status,0);
   const receipt=JSON.parse(host.stdout);
   assert.equal(receipt.ok,false);
   assert.ok(receipt.errors.some(x=>x.includes('Untrusted operator state root namespace')));
   await assert.rejects(pinnedSyncthingJson(root,'http://127.0.0.1:18384',
     'test-only','/rest/system/status'),/Syncthing HTTPS identity certificate unavailable/);
 }
});

test('standalone Pilot and Durable refuse explicit relative operator-state roots',()=>{
 const selected=['relative-operator-root'];
 if(process.platform==='win32')selected.push('C:drive-relative-root');
 for(const root of selected){
  const p=call(pilot,root,'info');
  assert.notEqual(p.status,0);
  assert.match(p.stderr,/CTMESH_MANAGED_PATH_UNSAFE/);
  const d=call(durable,root,'job-status','--peer','Linux','--id','probe-rel');
  assert.notEqual(d.status,0);
  assert.match(d.stderr,/TRANSFER_MANAGED_PATH_UNSAFE/);
  assert.ok(!d.stdout.includes('PUBLISHED'));
 }
});
test('Doctor rejects relative operator root before touching files',async()=>{
 const result=spawnSync(process.execPath,[doctor],{encoding:'utf8',timeout:5000,
   env:{...process.env,COMMANDER_TRANSFER_HOME:'relative-operator-root'}});
 assert.notEqual(result.status,0);
 const report=JSON.parse(result.stdout);
 assert.equal(report.ok,false);
 assert.ok(report.errors.some(x=>x.includes('Untrusted operator state root namespace')));
 await assert.rejects(pinnedSyncthingJson('relative-operator-root',
   'http://127.0.0.1:18384','test-only','/rest/system/status'),
   /Syncthing HTTPS identity certificate unavailable/);
});

test('standalone transfer workers reject a group-readable POSIX state root before identity access',
 {skip:process.platform==='win32'||typeof process.getuid!=='function'},()=>{
 const root=temp();
 try{
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'PC'}));
  fs.chmodSync(root,0o750);
  const info=call(pilot,root,'info');
  assert.notEqual(info.status,0);
  assert.match(info.stderr,/CTMESH_MANAGED_PATH_UNSAFE/);
  assert.equal(info.stdout.includes('PC'),false);
  const job=call(durable,root,'job-status','--peer','Linux','--id','private-root-001');
  assert.notEqual(job.status,0);
  assert.match(job.stderr,/TRANSFER_MANAGED_PATH_UNSAFE/);
  fs.chmodSync(root,0o700);
  const accepted=call(pilot,root,'info');
  assert.equal(accepted.status,0,accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).device,'PC');
 }finally{fs.chmodSync(root,0o700);fs.rmSync(root,{recursive:true,force:true});}
});

test('pilot creates private transfer and staging directories regardless of caller umask',
 {skip:process.platform==='win32'||typeof process.getuid!=='function'},()=>{
 const root=temp(),old=process.umask(0o022);
 try{
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'PC'}));
  const source=path.join(root,'source.txt');
  fs.writeFileSync(source,'non-secret test content');
  const sent=call(pilot,root,'send','--peer','Linux','--path',source,'--id','private-mode-001');
  assert.equal(sent.status,0,sent.stderr);
  const dirs=['pairs','pairs/Linux','pairs/Linux/transfers',
   'pairs/Linux/transfers/private-mode-001','staging','staging/Linux'];
  for(const rel of dirs){
   const st=fs.statSync(path.join(root,rel));
   assert.equal(st.mode&0o077,0,'group/other permissions for '+rel);
  }
 }finally{process.umask(old);fs.rmSync(root,{recursive:true,force:true});}
});
