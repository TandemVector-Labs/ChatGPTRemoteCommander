import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {syncthingDeviceIdFromPem,assertSyncthingRuntimeIdentity} from '../tools/commander-transfer-mesh/device-id.mjs';

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

test('transfer doctor never invokes an executable selected by COMMANDER_TRANSFER_HOME',()=>{
  const source=fs.readFileSync(doctor,'utf8');
  assert.equal(source.includes('execFileSync('),false);
  assert.equal(source.includes('spawnSync('),false);
  assert.match(source,/syncthingDeviceIdFromPem\(/);
  assert.match(source,/fetchLocal\(base,'\/rest\/system\/status'\)/);
  assert.match(source,/assertSyncthingRuntimeIdentity\(IDS\[node.alias\],id,status,runtimeVersion\)/);
  assert.match(source,/fetchLocal\(base,'\/rest\/system\/version'\)/);

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
    const run=spawnSync(process.execPath,[doctor],{
      encoding:'utf8',timeout:10000,
      env:{...process.env,COMMANDER_TRANSFER_HOME:root,CTMESH_NEGATIVE_MARKER:marker}
    });
    assert.equal(run.error,undefined);
    assert.equal(run.status,1,'synthetic certificate must not match the hard-coded operational identity');
    const response=JSON.parse(run.stdout);
    assert.equal(response.ok,false);
    assert.ok(response.errors.some(e=>e.includes('Certificate identity mismatch')));
    assert.equal(fs.existsSync(marker),false,'no environment-root executable may run');
  } finally {
    fs.rmSync(root,{recursive:true,force:true});
  }
});
