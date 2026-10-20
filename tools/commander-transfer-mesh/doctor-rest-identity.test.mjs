import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {verifySyncthingDaemon} from './doctor-rest-identity.mjs';

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
test('doctor uses authenticated local REST checks, not executable paths',()=>{
 const src=fs.readFileSync(new URL('./doctor.mjs',import.meta.url),'utf8');
 assert.ok(!src.includes('child_process')&&!src.includes('execFileSync('));
 for(const endpoint of ['/rest/system/status','/rest/system/version','/rest/config/folders','/rest/system/connections'])
  assert.ok(src.includes("'"+endpoint+"'"));
 assert.ok(src.includes("redirect:'error'"));
 assert.ok(src.includes('verifySyncthingDaemon(status,version,IDS[node.alias])'));
});

test('mocked local REST doctor works without launching a substituted binary',async(t)=>{
 if(process.platform!=='linux'){t.skip('Linux executable fixture');return;}
 const os=await import('node:os');
 const path=await import('node:path');
 const {spawnSync}=await import('node:child_process');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-rest-doctor-'));
 try{
  fs.mkdirSync(path.join(root,'state'),{recursive:true});
  fs.mkdirSync(path.join(root,'bin'));
  const ids={
   PC:'EFE6R4U-O3B6JVV-N4OKZFL-7X4U24W-A5GFD4G-TM4OPRK-AXBDALA-OCJUBQ6',
   Linux:'6YUIRAM-GDPWPT4-XXX2DD7-K2M7G23-F246XXK-ENQQ3G2-RHIQI2Y-TDRJGAB',
   EmadServer:'YMR5MPK-PW254V4-UX6FHRA-IYBRSN6-BGJMRNO-TTKJGX7-MQEOL3R-LP2VOQF',
   Amirreza:'X6EKTD2-6ZF3WUF-L2AQAHU-VYIQACY-A5BXTIP-F5U5UJE-AT6EREF-2PG6UA6'
  };
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'Linux',deviceID:ids.Linux}));
  fs.writeFileSync(path.join(root,'state','config.xml'),'<config><apikey>fake-local-fixture-key</apikey></config>');
  const marker=path.join(root,'binary-was-executed'),fake=path.join(root,'bin','syncthing');
  fs.writeFileSync(fake,'#!/bin/sh\ntouch "'+marker+'"\nexit 0\n');
  fs.chmodSync(fake,0o700);
  const preload=path.join(root,'fake-fetch.mjs');
  fs.writeFileSync(preload,[
    'const ROOT=process.env.COMMANDER_TRANSFER_HOME;',
    'const ids='+JSON.stringify(ids)+';',
    "const name='Linux';",
    "const folders=Object.entries(ids).filter(([other])=>other!==name).map(([other,id])=>({",
    "id:'ctmesh-v1-'+[name,other].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase())).join('-').toLowerCase(),",
    "path:ROOT+'/pairs/'+other,paused:false,devices:[{deviceID:ids.Linux},{deviceID:id}]}));",
    "folders.push({id:'ctmesh-pilot-20261013',paused:true});",
    "globalThis.fetch=async(url,opts)=>{",
    " if(!String(url).startsWith('http://127.0.0.1:')||opts?.redirect!=='error')throw Error('UNSAFE_FETCH_TARGET');",
    " const p=new URL(url).pathname;",
    " const body={",
    "  '/rest/noauth/health':{status:'OK'},",
    "  '/rest/system/status':{myID:process.env.FAKE_BAD_ID?'WRONG':ids.Linux},",
    "  '/rest/system/version':{version:process.env.FAKE_BAD_VERSION?'BAD':'v2.1.6'},",
    "  '/rest/config/folders':folders,",
    "  '/rest/system/connections':{connections:{}}",
    " }[p];",
    " if(body===undefined)throw Error('UNEXPECTED_ENDPOINT');",
    " return {ok:true,status:200,json:async()=>body};",
    "};"
  ].join('\n')+'\n');
  const doctor=new URL('./doctor.mjs',import.meta.url).pathname;
  const run=(extra={})=>spawnSync(process.execPath,['--import',preload,doctor],{
   encoding:'utf8',timeout:7000,env:{...process.env,COMMANDER_TRANSFER_HOME:root,...extra}
  });
  const pass=run();
  assert.equal(pass.status,0,pass.stderr+' '+pass.stdout);
  const result=JSON.parse(pass.stdout);
  assert.equal(result.ok,true);
  assert.equal(result.version,'syncthing v2.1.6');
  assert.equal(result.activePairCount,3);
  assert.equal(result.legacyBroadcastPaused,true);
  assert.equal(fs.existsSync(marker),false);
  for(const item of [{FAKE_BAD_ID:'1',expected:/Daemon identity mismatch/},
                    {FAKE_BAD_VERSION:'1',expected:/Daemon version invalid/}]){
   const {expected,...env}=item;
   const out=run(env);
   assert.equal(out.status,1);
   assert.match(out.stdout,expected);
  }
  assert.equal(fs.existsSync(marker),false,'unexpected binary launch');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
