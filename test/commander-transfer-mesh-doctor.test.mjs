import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {evaluatePeerConnectivity,assessDaemonIdentity} from '../tools/commander-transfer-mesh/doctor.mjs';

const peers={
 PC:'EFE6R4U-O3B6JVV-N4OKZFL-7X4U24W-A5GFD4G-TM4OPRK-AXBDALA-OCJUBQ6',
 Linux:'6YUIRAM-GDPWPT4-XXX2DD7-K2M7G23-F246XXK-ENQQ3G2-RHIQI2Y-TDRJGAB',
 MMZ:'SHNJRDO-UUT55KW-GKFAAYO-X7QB33A-VNRTY4H-ES3H3PD-KB5TMCW-GSYEDAR',
 EmadServer:'YMR5MPK-PW254V4-UX6FHRA-IYBRSN6-BGJMRNO-TTKJGX7-MQEOL3R-LP2VOQF',
 Amirreza:'X6EKTD2-6ZF3WUF-L2AQAHU-VYIQACY-A5BXTIP-F5U5UJE-AT6EREF-2PG6UA6'
};
const online=()=>Object.fromEntries(Object.values(peers).map(id=>[id,{connected:true,type:'relay-client'}]));
test('four exact expected remote peers give readiness without counting self',()=>{
 const x=evaluatePeerConnectivity({connections:online()},'MMZ');
 assert.deepEqual({ready:x.allConnected,connected:x.connectedPeers,expected:x.expectedPeers,offline:x.disconnectedPeers},
  {ready:true,connected:4,expected:4,offline:[]});
 assert.deepEqual(x.transports,{'relay-client':4});
});
test('a missing peer remains a failed connectivity gate even with healthy config',()=>{
 const rows=online();rows[peers.EmadServer]={connected:false,type:''};
 const x=evaluatePeerConnectivity({connections:rows},'MMZ');
 assert.equal(x.allConnected,false);
 assert.equal(x.connectedPeers,3);
 assert.deepEqual(x.disconnectedPeers,['EmadServer']);
});
test('absent peer, unknown connected ID and self ID cannot fake full topology',()=>{
 const rows=online();delete rows[peers.PC];
 rows['ATTACKER-UNKNOWN-ID']={connected:true,type:'tcp-client'};
 const x=evaluatePeerConnectivity({connections:rows},'Linux');
 assert.equal(x.allConnected,false);
 assert.equal(x.connectedPeers,3);
 assert.deepEqual(x.disconnectedPeers,['PC']);
});
test('missing or invalid connection API responses fail closed',()=>{
 for(const payload of [null,{}, {connections:null},{connections:[]},{connections:''}]){
  assert.throws(()=>evaluatePeerConnectivity(payload,'PC'),/Invalid connection response/);
 }
 assert.throws(()=>evaluatePeerConnectivity({connections:online()},'invalid'),/Unknown local peer/);
});
test('truthy nonboolean connected flags do not claim online',()=>{
 const rows=online();rows[peers.EmadServer]={connected:'true',type:'tcp-client'};
 assert.equal(evaluatePeerConnectivity({connections:rows},'MMZ').allConnected,false);
});

test('standalone doctor fails closed on unconfigured installation',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-doctor-offline-'));
 try{
  const script=fileURLToPath(new URL('../tools/commander-transfer-mesh/doctor.mjs',import.meta.url));
  const r=spawnSync(process.execPath,[script],{
   env:{...process.env,COMMANDER_TRANSFER_HOME:tmp},encoding:'utf8',timeout:5000
  });
  assert.equal(r.status,1,r.stderr);
  const body=JSON.parse(r.stdout);
  assert.equal(body.ok,false);
  assert.equal(body.connectivityReady,false);
  assert.equal(body.expectedPeers,4);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('the doctor never launches the untrusted daemon binary in an environment-selected pilot root', {
  skip:process.platform!=='linux'
},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-doctor-untrusted-bin-'));
  const marker=path.join(root,'binary-was-launched');
  try{
    fs.mkdirSync(path.join(root,'bin'));
    fs.mkdirSync(path.join(root,'state'));
    fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'PC',deviceID:peers.PC}));
    fs.writeFileSync(path.join(root,'state','config.xml'),'<configuration><gui><apikey>synthetic-doctor-only</apikey></gui></configuration>');
    const exe=path.join(root,'bin','syncthing');
    fs.writeFileSync(exe,'#!/bin/sh\nprintf executed > "$CTMESH_TEST_MARKER"\nprintf "%s\n" "'+peers.PC+'"\n',{mode:0o700});
    const script=fileURLToPath(new URL('../tools/commander-transfer-mesh/doctor.mjs',import.meta.url));
    const r=spawnSync(process.execPath,[script],{
      env:{...process.env,COMMANDER_TRANSFER_HOME:root,CTMESH_TEST_MARKER:marker},
      encoding:'utf8',timeout:10000
    });
    assert.equal(r.error,undefined,String(r.error));
    assert.equal(r.status,1,r.stderr);
    const report=JSON.parse(r.stdout);
    assert.equal(report.ok,false);
    assert.equal(report.connectivityReady,false);
    assert.equal(fs.existsSync(marker),false,'diagnostic must not run an executable supplied by pilot root');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('authenticated Syncthing REST status and version preserve doctor identity and version semantics',()=>{
  assert.equal(assessDaemonIdentity({status:{myID:peers.PC},version:{version:'v1.29.6'},alias:'PC'}),'syncthing v1.29.6');
  assert.equal(assessDaemonIdentity({status:{myID:peers.MMZ},version:{version:'v2.0.0-rc.1'},alias:'MMZ'}),'syncthing v2.0.0-rc.1');
});
test('doctor rejects forged daemon identity, wrong alias and malformed version',()=>{
  const valid={status:{myID:peers.PC},version:{version:'v1.29.6'},alias:'PC'};
  for(const changed of [
    {status:{myID:peers.MMZ}},
    {status:{myID:undefined}},
    {alias:'unknown'},
    {version:{version:'v1.29.6\nmalicious'}},
    {version:{version:undefined}},
    {version:{version:'../../bad'}}
  ]){
    assert.throws(()=>assessDaemonIdentity({...valid,...changed}),/identity mismatch|Invalid Syncthing version/);
  }
});