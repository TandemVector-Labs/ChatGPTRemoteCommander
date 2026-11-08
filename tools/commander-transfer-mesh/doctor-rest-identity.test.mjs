import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {verifySyncthingDaemon,configuredLoopbackRest,pinnedOptionalDevice,fetchPinnedSyncthingJson} from './doctor-rest-identity.mjs';

const id='EFE6R4U-O3B6JVV-N4OKZFL-7X4U24W-A5GFD4G-TM4OPRK-AXBDALA-OCJUBQ6';
test('authenticated Syncthing REST identity and version retain doctor output contract',()=>{
 assert.equal(verifySyncthingDaemon({myID:id},{version:'v2.1.6'},id),'syncthing v2.1.6');
});
test('fail closed for daemon mismatch, missing identity and bad version',()=>{
 for(const status of [{myID:'BAD'}, {},null])
  assert.throws(()=>verifySyncthingDaemon(status,{version:'v2.1.6'},id),/Daemon identity mismatch/);
 for(const version of [null,{}, {version:'2.1.6'}, {version:'v2.1.6;echo test'}])
  assert.throws(()=>verifySyncthingDaemon({myID:id},version,id),/Daemon version invalid/);
 assert.throws(()=>verifySyncthingDaemon({myID:id},{version:'v2.1.6'},'BAD'),/Expected device ID invalid/);
});


test('optional peer must match pinned digest; cannot substitute or duplicate device identity',()=>{
 const digest=createHash('sha256').update(id).digest('hex');
 assert.equal(pinnedOptionalDevice([{name:'MMZ',deviceID:id}],'MMZ',digest),id);
 assert.equal(pinnedOptionalDevice([{name:'Other',deviceID:id}],'MMZ',digest),null);
 assert.throws(()=>pinnedOptionalDevice([{name:'MMZ',deviceID:id}],'MMZ','0'.repeat(64)),/not pinned/);
 assert.throws(()=>pinnedOptionalDevice([{name:'MMZ',deviceID:id},{name:'MMZ',deviceID:id}],'MMZ',digest),/ambiguous/);
 assert.throws(()=>pinnedOptionalDevice([{name:'MMZ',deviceID:'BAD'}],'MMZ',digest),/malformed/);
 assert.throws(()=>pinnedOptionalDevice(null,'MMZ',digest),/configuration invalid/);
});

test('REST endpoint and key are bound to one explicit loopback GUI config',()=>{
 const config=(address,attrs='enabled="true" tls="false"')=>
  '<configuration><gui '+attrs+'><address>'+address+'</address>'+
  '<apikey>fixture-only-key</apikey></gui></configuration>';
 for(const [address,expected] of [
   ['127.0.0.1:8384','https://127.0.0.1:8384'],
   ['127.0.0.1:18384','https://127.0.0.1:18384'],
   ['[::1]:8384','https://[::1]:8384']
 ])assert.deepEqual(configuredLoopbackRest(config(address)),
   {base:expected,apiKey:'fixture-only-key'});
 for(const address of ['0.0.0.0:8384','localhost:8384','127.0.0.2:8384',
                       '127.0.0.1:0','127.0.0.1:65536','127.0.0.1:8384.evil'])
  assert.throws(()=>configuredLoopbackRest(config(address)),/loopback IP/);
 assert.throws(()=>configuredLoopbackRest(config('127.0.0.1:8384','enabled="false" tls="false"')),
  /disabled/);
 assert.equal(configuredLoopbackRest(config('127.0.0.1:8384','enabled="true" tls="true"')).base,
  'https://127.0.0.1:8384');
 assert.deepEqual(configuredLoopbackRest(config('127.0.0.1:8384'),'127.0.0.1:18384'),
   {base:'https://127.0.0.1:18384',apiKey:'fixture-only-key'});
 for(const bad of ['127.0.0.1:0','https://127.0.0.1:18384','127.0.0.1:70000','0.0.0.0:18384'])
  assert.throws(()=>configuredLoopbackRest(config('127.0.0.1:8384'),bad),/loopback IP/);
 assert.throws(()=>configuredLoopbackRest('<config/>'),/Exactly one/);
 assert.throws(()=>configuredLoopbackRest(config('127.0.0.1:8384')+config('127.0.0.1:18384')),
  /Exactly one/);
 assert.throws(()=>configuredLoopbackRest('<gui enabled="true" tls="false"><address>127.0.0.1:8384</address></gui>'),
  /address\/API key/);
});

test('doctor uses authenticated local REST checks, not executable paths',()=>{
 const src=fs.readFileSync(new URL('./doctor.mjs',import.meta.url),'utf8');
 assert.ok(!src.includes('child_process')&&!src.includes('execFileSync('));
 for(const endpoint of ['/rest/system/status','/rest/system/version','/rest/config/devices','/rest/config/folders','/rest/system/connections'])
  assert.ok(src.includes("'"+endpoint+"'"));
 assert.ok(src.includes('fetchPinnedSyncthingJson'));
 const helper=fs.readFileSync(new URL('./doctor-rest-identity.mjs',import.meta.url),'utf8');
 assert.ok(helper.includes('rejectUnauthorized:true'));
 assert.ok(helper.includes('checkServerIdentity'));
 assert.ok(helper.includes('ca:certificatePem'));
 assert.ok(!helper.includes('rejectUnauthorized:false'));
 assert.ok(!helper.includes("'http://'+effectiveAddress"));
 assert.ok(src.includes('verifySyncthingDaemon(status,version,trusted[node.alias])'));
 assert.ok(src.includes('configuredLoopbackRest(xml,GUI_OVERRIDES[node.alias])'));
 assert.ok(!src.includes('const candidates='));
 assert.ok(src.includes("const GUI_OVERRIDES={PC:'127.0.0.1:18384'}"));
});


test('pinned HTTPS validates real fixture identity and refuses an impostor before API key transfer',async(t)=>{
 if(process.platform!=='linux'){t.skip('Linux OpenSSL ephemeral TLS fixture');return;}
 const os=await import('node:os');
 const path=await import('node:path');
 const https=await import('node:https');
 const {spawn,spawnSync}=await import('node:child_process');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-https-doctor-'));
 const idMap={
  PC:'EFE6R4U-O3B6JVV-N4OKZFL-7X4U24W-A5GFD4G-TM4OPRK-AXBDALA-OCJUBQ6',
  Linux:'6YUIRAM-GDPWPT4-XXX2DD7-K2M7G23-F246XXK-ENQQ3G2-RHIQI2Y-TDRJGAB',
  EmadServer:'YMR5MPK-PW254V4-UX6FHRA-IYBRSN6-BGJMRNO-TTKJGX7-MQEOL3R-LP2VOQF',
  Amirreza:'X6EKTD2-6ZF3WUF-L2AQAHU-VYIQACY-A5BXTIP-F5U5UJE-AT6EREF-2PG6UA6'
 };
 const fakeKey='SYNTHETIC_PINNING_TEST_KEY';
 const state=path.join(root,'state');
 fs.mkdirSync(state,{mode:0o700});
 let server,impostor;
 const start=server=>new Promise((ok,bad)=>{server.once('error',bad);server.listen(0,'127.0.0.1',ok);});
 const close=server=>server?new Promise(ok=>server.close(()=>ok())):Promise.resolve();
 const generate=(cert,key)=>{
  const result=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes',
   '-days','1','-subj','/CN=127.0.0.1','-keyout',key,'-out',cert],{
   timeout:6500,encoding:'utf8'
  });
  assert.equal(result.status,0,'OpenSSL ephemeral fixture generation failed');
 };
 const run=async()=>{
  const child=spawn(process.execPath,[new URL('./doctor.mjs',import.meta.url).pathname],{
   cwd:root,env:{...process.env,COMMANDER_TRANSFER_HOME:root,NODE_OPTIONS:''},
   stdio:['ignore','pipe','pipe']
  });
  let stdout='',stderr='';
  child.stdout.on('data',buf=>{stdout+=buf.toString();});
  child.stderr.on('data',buf=>{stderr+=buf.toString();});
  const code=await new Promise((ok,bad)=>{
   const timer=setTimeout(()=>{child.kill('SIGKILL');bad(new Error('TLS_FIXTURE_DOCTOR_TIMEOUT'));},7200);
   child.once('error',e=>{clearTimeout(timer);bad(e)});
   child.once('close',c=>{clearTimeout(timer);ok(c)});
  });
  return {code,result:JSON.parse(stdout.trim()),stderr};
 };
 const setPort=port=>fs.writeFileSync(path.join(state,'config.xml'),
  '<configuration><gui enabled="true" tls="false"><address>127.0.0.1:'+port+
  '</address><apikey>'+fakeKey+'</apikey></gui></configuration>',{mode:0o600});
 try{
  const cert=path.join(state,'https-cert.pem'),key=path.join(state,'https-key.pem');
  generate(cert,key);
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'Linux',deviceID:idMap.Linux}),{mode:0o600});
  const marker=path.join(root,'substituted-binary-executed'),bin=path.join(root,'bin');
  fs.mkdirSync(bin,{mode:0o700});
  const fake=path.join(bin,'syncthing');
  fs.writeFileSync(fake,'#!/bin/sh\ntouch "'+marker+'"\nexit 0\n',{mode:0o700});
  let mode='ok',legitKeySeen=false,unauthLeaks=false;
  const folders=Object.entries(idMap).filter(([name])=>name!=='Linux').map(([name,id])=>({
   id:'ctmesh-v1-'+['Linux',name].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase())).join('-').toLowerCase(),
   path:path.join(root,'pairs',name),paused:false,
   devices:[{deviceID:idMap.Linux},{deviceID:id}]
  }));
  folders.push({id:'ctmesh-pilot-20261013',paused:true});
  server=https.createServer({cert:fs.readFileSync(cert),key:fs.readFileSync(key)},(req,res)=>{
   const authenticated=req.url!=='/rest/noauth/health';
   if(authenticated){
    legitKeySeen ||= req.headers['x-api-key']===fakeKey;
   }else if(req.headers['x-api-key'])unauthLeaks=true;
   const routes={
    '/rest/noauth/health':{status:mode==='badHealth'?'BROKEN':'OK'},
    '/rest/system/status':{myID:mode==='badId'?'WRONG':idMap.Linux},
    '/rest/system/version':{version:mode==='badVersion'?'BAD':'v2.1.6'},
    '/rest/config/folders':folders,
    '/rest/config/devices':Object.entries(idMap).map(([name,deviceID])=>({name,deviceID})),
    '/rest/system/connections':{connections:{}}
   };
   if(authenticated&&req.headers['x-api-key']!==fakeKey){res.writeHead(401);res.end();return;}
   if(!Object.hasOwn(routes,req.url)){res.writeHead(404);res.end();return;}
   res.writeHead(200,{'content-type':'application/json'});
   res.end(JSON.stringify(routes[req.url]));
  });
  await start(server);
  setPort(server.address().port);
  const good=await run();
  assert.equal(good.code,0,good.stderr);
  assert.equal(good.result.ok,true);
  assert.equal(good.result.activePairCount,3);
  assert.equal(legitKeySeen,true);
  assert.equal(unauthLeaks,false);
  assert.equal(fs.existsSync(marker),false,'local substituted executable must not run');
  for(const [bad,expected] of [['badId','Daemon identity mismatch'],['badVersion','Daemon version invalid'],
   ['badHealth','Configured local Syncthing REST health unavailable']]){
   mode=bad;
   const attempt=await run();
   assert.equal(attempt.code,1);
   assert.ok(attempt.result.errors.some(e=>e.includes(expected)));
  }
  const otherCert=path.join(root,'impostor-cert.pem'),otherKey=path.join(root,'impostor-key.pem');
  generate(otherCert,otherKey);
  let intercepted=0,interceptedKey=false;
  impostor=https.createServer({cert:fs.readFileSync(otherCert),key:fs.readFileSync(otherKey)},(req,res)=>{
   intercepted++;
   interceptedKey ||= req.headers['x-api-key']===fakeKey;
   res.writeHead(200,{'content-type':'application/json'});
   res.end('{"status":"OK"}');
  });
  await start(impostor);
  setPort(impostor.address().port);
  const attacked=await run();
  assert.equal(attacked.code,1);
  assert.equal(attacked.result.ok,false);
  assert.equal(intercepted,0,'impostor must not get an HTTP request when TLS pin fails');
  assert.equal(interceptedKey,false,'impostor must not receive API key');
 }finally{
  await close(impostor);
  await close(server);
  fs.rmSync(root,{recursive:true,force:true});
 }
});
