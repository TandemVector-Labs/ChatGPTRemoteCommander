import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {syncthingDeviceIdFromPem,assertSyncthingRuntimeIdentity,isPinnedOptionalMmzPair,inspectOptionalMmzPairs,OPTIONAL_MMZ_CORE_ALIASES,PINNED_MMZ_DEVICE_HASH} from '../tools/commander-transfer-mesh/device-id.mjs';
import {createHash} from 'node:crypto';
import {runDoctor} from '../tools/commander-transfer-mesh/doctor.mjs';
import {configuredLoopbackRest,fetchPinnedSyncthingJson} from '../tools/commander-transfer-mesh/pinned-rest.mjs';

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


test('all four Core roles accept only one exactly pinned optional MMZ pair',()=>{
  assert.equal(PINNED_MMZ_DEVICE_HASH,'c51ff1c36a87da050b1f320e302cfd1a9bf69570efad6be68d2bf5a165724af8');
  assert.deepEqual(OPTIONAL_MMZ_CORE_ALIASES,['PC','Linux','EmadServer','Amirreza']);
  const root=path.join(os.tmpdir(),'ctmesh-pinned-roster-fixture');
  const local='LOCAL-QA-DEVICE';
  const peer='SYNTHETIC-MMZ-QA-DEVICE';
  const expectedPeerHash=createHash('sha256').update(peer).digest('hex');
  const inspect=(alias,folders,additional={})=>
    inspectOptionalMmzPairs({alias,localDeviceId:local,root,folders,expectedPeerHash,...additional});
  for(const alias of OPTIONAL_MMZ_CORE_ALIASES){
    const id='ctmesh-v1-'+[alias,'MMZ'].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase())).join('-').toLowerCase();
    const folder={id,paused:false,type:'sendreceive',path:path.join(root,'pairs','MMZ'),
      devices:[{deviceID:local},{deviceID:peer}]};
    const candidate={alias,localDeviceId:local,root,folder,expectedPeerHash};
    assert.equal(isPinnedOptionalMmzPair(candidate),true,'strict '+alias+' pair');
    assert.deepEqual(inspect(alias,[folder]),{count:1,error:null},'trusted '+alias+' optional pair');
    assert.deepEqual(inspect(alias,[]),{count:0,error:null},'absence remains optional');
    assert.deepEqual(inspect(alias,[{...folder,paused:true}]),{count:0,error:null},'paused pair remains inactive');
    assert.deepEqual(inspect(alias,[folder,folder]),{count:0,error:'Duplicate optional MMZ pair'},
      'duplicate IDs must fail closed even when one is valid');
    assert.deepEqual(inspect(alias,[folder,{...folder,paused:true}]),
      {count:0,error:'Duplicate optional MMZ pair'},'paused duplicate must also fail closed');
    assert.equal(isPinnedOptionalMmzPair({...candidate,expectedPeerHash:PINNED_MMZ_DEVICE_HASH}),false,
      'unknown QA peer must not equal production pin');
    assert.deepEqual(inspect(alias,[folder],{expectedPeerHash:PINNED_MMZ_DEVICE_HASH}),
      {count:0,error:'Untrusted optional MMZ pair'},'wrong pin must fail closed');
    for(const edited of [
      {...folder,id:'ctmesh-v1-similar-mmz'},
      {...folder,path:path.join(root,'pairs','Other')},
      {...folder,type:'sendonly'},
      {...folder,paused:true},
      {...folder,devices:[{deviceID:local},{deviceID:'UNTRUSTED'}]},
      {...folder,devices:[{deviceID:local},{deviceID:local}]},
      {...folder,devices:[{deviceID:peer}]},
      {...folder,devices:[{deviceID:local},{deviceID:peer},{deviceID:'THIRD'}]}
    ])assert.equal(isPinnedOptionalMmzPair({...candidate,folder:edited}),false,'invalid optional pair must fail closed');
    for(const bad of [
      {...folder,path:path.join(root,'pairs','Other')},
      {...folder,type:'sendonly'},
      {...folder,devices:[{deviceID:local},{deviceID:'UNTRUSTED'}]},
      {...folder,devices:[{deviceID:local},{deviceID:peer},{deviceID:'THIRD'}]}
    ])assert.deepEqual(inspect(alias,[bad]),{count:0,error:'Untrusted optional MMZ pair'});
    for(const unknownAlias of ['MMZ','Unknown','PC ','pc',null,'__proto__']){
      assert.equal(isPinnedOptionalMmzPair({...candidate,alias:unknownAlias}),false,
        'no new owner or unlisted alias can acquire the MMZ pair');
      assert.deepEqual(inspect(unknownAlias,[folder]),{count:0,error:'Invalid optional MMZ context'});
    }
  }
});

test('pinned TLS Doctor selects exactly one configured GUI endpoint, not a health-probed port',()=>{
  const config=(address,enabled='true')=>'<configuration><gui enabled="'+enabled+'" tls="false">'+
    '<address>'+address+'</address><apikey>synthetic-fixture-key</apikey></gui></configuration>';
  assert.deepEqual(configuredLoopbackRest(config('127.0.0.1:8384')),
    {base:'https://127.0.0.1:8384',apiKey:'synthetic-fixture-key'});
  assert.deepEqual(configuredLoopbackRest(config('127.0.0.1:8384'),'127.0.0.1:18384'),
    {base:'https://127.0.0.1:18384',apiKey:'synthetic-fixture-key'});
  for(const address of ['localhost:8384','0.0.0.0:8384','127.0.0.2:8384',
    '127.0.0.1:0','127.0.0.1:65536','evil.test:8384','127.0.0.1:8384/path'])
    assert.throws(()=>configuredLoopbackRest(config(address)),/loopback/);
  assert.throws(()=>configuredLoopbackRest(config('127.0.0.1:8384','false')),/disabled/);
  assert.throws(()=>configuredLoopbackRest(config('127.0.0.1:8384'),'0.0.0.0:18384'),/loopback/);
  assert.throws(()=>configuredLoopbackRest('<configuration/>'),/Exactly one/);
  assert.throws(()=>configuredLoopbackRest(config('127.0.0.1:8384')+config('127.0.0.1:8384')),/Exactly one/);
  assert.throws(()=>configuredLoopbackRest('<gui><address>127.0.0.1:8384</address></gui>'),/API key/);
  const source=fs.readFileSync(doctor,'utf8');
  assert.ok(source.includes('fetchPinnedSyncthingJson'));
  assert.ok(source.includes("state/https-cert.pem"));
  assert.ok(source.includes("const GUI_OVERRIDES={PC:'127.0.0.1:18384'}"));
  assert.equal(source.includes('const candidates='),false);
  assert.equal(source.includes('fetchImpl'),false);
  assert.equal(source.includes("http://127.0.0.1:"),false);
});

test('pinned TLS helper rejects plaintext, untrusted hosts and arbitrary paths before I/O',async()=>{
  const key='SYNTHETIC_FIXTURE_KEY';
  for(const base of ['http://127.0.0.1:8384','https://evil.invalid:8384',
     'https://127.0.0.2:8384','https://127.0.0.1:0','https://127.0.0.1:65536'])
    await assert.rejects(fetchPinnedSyncthingJson(base,'/rest/system/status',cert,key),/HTTPS|loopback/);
  await assert.rejects(fetchPinnedSyncthingJson('https://127.0.0.1:8384','/rest/unknown',cert,key),/Unapproved/);
  await assert.rejects(fetchPinnedSyncthingJson('https://127.0.0.1:8384','/rest/system/status','invalid',key),/public certificate invalid/);
  await assert.rejects(fetchPinnedSyncthingJson('https://127.0.0.1:8384','/rest/system/status',cert,''),/API key unavailable/);
});

test('pinned HTTPS prevents impostor key capture and permits an exact certificate',async t=>{
  const {spawnSync}=await import('node:child_process');
  const openssl=spawnSync('openssl',['version'],{encoding:'utf8',timeout:2500});
  if(openssl.status!==0){t.skip('OpenSSL unavailable for synthetic TLS fixture');return;}
  const https=await import('node:https');
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-pinned-tls-fixture-'));
  const opensslConfig=path.join(scratch,'openssl.cnf');
  fs.writeFileSync(opensslConfig,'[req]\\ndistinguished_name=req_distinguished_name\\n[req_distinguished_name]\\n'.replaceAll('\\n','\n'));
  const generate=(which)=>{
    const pem=path.join(scratch,which+'.crt'),key=path.join(scratch,which+'.key');
    const result=spawnSync('openssl',['req','-config',opensslConfig,'-x509','-newkey','rsa:2048','-nodes',
      '-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1',
      '-keyout',key,'-out',pem],{encoding:'utf8',timeout:6500});
    assert.equal(result.status,0,'OpenSSL fixture failed: '+(result.stderr||'').slice(-150));
    return {pem:fs.readFileSync(pem,'utf8'),key:fs.readFileSync(key,'utf8')};
  };
  const start=server=>new Promise((resolve,reject)=>{
    server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));
  });
  const close=server=>server?new Promise(resolve=>server.close(resolve)):Promise.resolve();
  let legitimate,impostor;
  try{
    const trusted=generate('trusted'),untrusted=generate('impostor');
    let authenticated=0,unauthenticatedWithKey=0,impostorHits=0;
    const fixtureKey='SYNTHETIC_TLS_QA_TOKEN_NOT_REAL';
    legitimate=https.createServer({cert:trusted.pem,key:trusted.key},(req,res)=>{
      const hasKey=req.headers['x-api-key']===fixtureKey;
      if(req.url==='/rest/noauth/health' && hasKey)unauthenticatedWithKey++;
      if(req.url==='/rest/system/status'&&hasKey)authenticated++;
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify(req.url==='/rest/noauth/health'?{status:'OK'}:{myID:'SYNTHETIC'}));
    });
    const validPort=await start(legitimate);
    const validBase='https://127.0.0.1:'+validPort;
    assert.deepEqual(await fetchPinnedSyncthingJson(validBase,'/rest/noauth/health',trusted.pem,null,false),{status:'OK'});
    assert.deepEqual(await fetchPinnedSyncthingJson(validBase,'/rest/system/status',trusted.pem,fixtureKey),{myID:'SYNTHETIC'});
    assert.equal(authenticated,1);
    assert.equal(unauthenticatedWithKey,0);
    impostor=https.createServer({cert:untrusted.pem,key:untrusted.key},(req,res)=>{
      impostorHits++;
      res.writeHead(200,{'content-type':'application/json'});
      res.end('{"status":"OK"}');
    });
    const falsePort=await start(impostor);
    await assert.rejects(fetchPinnedSyncthingJson(
      'https://127.0.0.1:'+falsePort,'/rest/system/status',trusted.pem,fixtureKey));
    assert.equal(impostorHits,0,'wrong certificate must fail before any HTTP request or API key');
  }finally{
    await close(impostor);await close(legitimate);
    fs.rmSync(scratch,{recursive:true,force:true});
  }
});
