import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {syncthingDeviceIdFromPem,assertSyncthingRuntimeIdentity} from '../tools/commander-transfer-mesh/device-id.mjs';
import {runDoctor} from '../tools/commander-transfer-mesh/doctor.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const doctor=path.join(project,'tools','commander-transfer-mesh','doctor.mjs');
const cert=fs.readFileSync(path.join(project,'test','fixtures','ctmesh-public-qa-cert.pem'),'utf8');
const expected=fs.readFileSync(path.join(project,'test','fixtures','ctmesh-public-qa-cert.id'),'utf8').trim();

test('certificate-derived Syncthing ID matches independently computed public QA vector',()=>{
  assert.equal(syncthingDeviceIdFromPem(cert),expected);
  assert.match(expected,/^[A-Z2-7]{7}(?:-[A-Z2-7]{7}){7}$/);
  assert.throws(()=>syncthingDeviceIdFromPem('not a certificate'));
});

test('running service identity is bound to the installed certificate and version is constrained',()=>{
  const id=syncthingDeviceIdFromPem(cert);
  assert.equal(assertSyncthingRuntimeIdentity(id,id,{myID:id},{version:'v2.1.0'}),'syncthing v2.1.0');
  assert.equal(assertSyncthingRuntimeIdentity(id,id,{myID:id},{version:'v2.1.0-9-gabcd'}),'syncthing v2.1.0-9-gabcd');
  assert.throws(()=>assertSyncthingRuntimeIdentity('WRONG',id,{myID:id},{version:'v2.1.0'}),/Certificate identity mismatch/);
  assert.throws(()=>assertSyncthingRuntimeIdentity(id,id,{myID:'SPOOFED'},{version:'v2.1.0'}),/Running device identity mismatch/);
  assert.throws(()=>assertSyncthingRuntimeIdentity(id,id,{myID:id},{version:'../../bad'}),/Syncthing version unavailable/);
  assert.throws(()=>assertSyncthingRuntimeIdentity(id,id,{myID:id},null),/Syncthing version unavailable/);
});

test('transfer doctor never uses an environment-selected root or launches a root-selected executable',async()=>{
  const source=fs.readFileSync(doctor,'utf8');
  assert.equal(source.includes('COMMANDER_TRANSFER_HOME'),false);
  assert.equal(source.includes('execFileSync('),false);
  assert.equal(source.includes('spawnSync('),false);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-doctor-deny-'));
  const marker=path.join(root,'unexpected-execution');
  try{
    fs.mkdirSync(path.join(root,'state'));
    fs.mkdirSync(path.join(root,'bin'));
    fs.writeFileSync(path.join(root,'state','cert.pem'),cert);
    fs.writeFileSync(path.join(root,'state','config.xml'),'<gui><apikey>synthetic-qa-key</apikey></gui>');
    fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({
      alias:'PC',deviceID:'EFE6R4U-O3B6JVV-N4OKZFL-7X4U24W-A5GFD4G-TM4OPRK-AXBDALA-OCJUBQ6'
    }));
    const fake=path.join(root,'bin',process.platform==='win32'?'syncthing.exe':'syncthing');
    fs.writeFileSync(fake,'#!/bin/sh\necho UNSAFE_EXECUTED > "$CTMESH_NEGATIVE_MARKER"\n');
    if(process.platform!=='win32')fs.chmodSync(fake,0o755);
    const run=await runDoctor({root,fetchImpl:async()=>{throw Error('synthetic offline API');},writeOutput:()=>{}});
    assert.equal(run.exitCode,1);
    assert.ok(run.output.errors.some(e=>e.includes('Certificate identity mismatch')));
    assert.equal(fs.existsSync(marker),false,'no environment-root executable may run');
  } finally {
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('transfer doctor rejects roots outside the home and OS temporary directories',async()=>{
  const run=await runDoctor({root:path.parse(os.tmpdir()).root,fetchImpl:async()=>{throw Error('unexpected network');},writeOutput:()=>{}});
  assert.equal(run.exitCode,1);
  assert.ok(run.output.errors.some(e=>e.includes('outside allowed locations')));
});

test('transfer doctor rejects a root-file symlink that escapes the accepted root',async(t)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-doctor-symlink-'));
  const outside=path.join(path.dirname(root),path.basename(root)+'-outside.json');
  try{
    fs.writeFileSync(outside,'{}');
    try{fs.symlinkSync(outside,path.join(root,'node.json'),'file');}
    catch(error){
      if(process.platform==='win32'&&['EPERM','EACCES'].includes(error.code)){t.skip('Windows symlink creation is unavailable');return;}
      throw error;
    }
    const run=await runDoctor({root,fetchImpl:async()=>{throw Error('unexpected network');},writeOutput:()=>{}});
    assert.equal(run.exitCode,1);
    assert.ok(run.output.errors.some(e=>e.includes('escapes its root directory')));
  }finally{
    fs.rmSync(root,{recursive:true,force:true});
    fs.rmSync(outside,{force:true});
  }
});
