import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {spawnSync} from 'node:child_process';
import {pinnedSyncthingJson} from './doctor-rest-identity.mjs';
const KEY='DUMMY-NOT-REAL-SECRET-NEVER-IN-PRODUCTION';
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'pinned-rest-'));
const listen=s=>new Promise((resolve,reject)=>{
 s.once('error',reject);s.listen(0,'127.0.0.1',()=>resolve(s.address().port));
});
const close=s=>new Promise(resolve=>s.close(resolve));
test('no REST key reaches a fake plaintext listener',async()=>{
 const root=temp();let requests=0;let keySeen=false;
 const server=http.createServer((req,res)=>{
  requests++;keySeen ||= req.headers['x-api-key']===KEY;
  res.writeHead(200,{'content-type':'application/json'});
  res.end('{"status":"OK"}');
 });
 try{
  fs.mkdirSync(path.join(root,'state'));
  const port=await listen(server);
  await assert.rejects(pinnedSyncthingJson(root,'http://127.0.0.1:'+port,KEY,
   '/rest/system/status'),/HTTPS identity certificate unavailable/);
  assert.equal(requests,0);assert.equal(keySeen,false);
 }finally{await close(server);fs.rmSync(root,{recursive:true,force:true});}
});
test('pinned HTTPS sends dummy key only to trusted certificate, rejects impersonator',async t=>{
 const can=spawnSync('openssl',['version'],{encoding:'utf8'});
 if(can.status!==0){t.skip('openssl unavailable');return;}
 const root=temp(),other=temp();
 let trustedServer,impostorServer;
 let goodCount=0,badCount=0,badKey=false;
 const cert=dir=>{
  const crt=path.join(dir,'https-cert.pem'),key=path.join(dir,'https-key.pem');
  const x=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes',
   '-keyout',key,'-out',crt,'-subj','/CN=SyncthingFixture','-days','1'],
   {stdio:'ignore',timeout:10000});
  assert.equal(x.status,0);
  return {cert:fs.readFileSync(crt),key:fs.readFileSync(key)};
 };
 try{
  const good=cert(root),bad=cert(other);
  fs.mkdirSync(path.join(root,'state'));
  fs.copyFileSync(path.join(root,'https-cert.pem'),path.join(root,'state','https-cert.pem'));
  trustedServer=https.createServer(good,(req,res)=>{
   goodCount++;assert.equal(req.headers['x-api-key'],KEY);
   res.writeHead(200,{'content-type':'application/json'});
   res.end('{"myID":"TRUSTED_TEST_ONLY"}');
  });
  const goodPort=await listen(trustedServer);
  const result=await pinnedSyncthingJson(root,'http://127.0.0.1:'+goodPort,KEY,
   '/rest/system/status');
  assert.equal(result.myID,'TRUSTED_TEST_ONLY');
  assert.equal(goodCount,1);
  impostorServer=https.createServer(bad,(req,res)=>{
   badCount++;badKey ||= req.headers['x-api-key']===KEY;
   res.end('{}');
  });
  const badPort=await listen(impostorServer);
  await assert.rejects(pinnedSyncthingJson(root,'http://127.0.0.1:'+badPort,KEY,
   '/rest/system/status'));
  assert.equal(badCount,0);assert.equal(badKey,false);
  await assert.rejects(pinnedSyncthingJson(root,'http://127.0.0.1:'+goodPort,KEY,
   '/rest/not-allowed'),/not allowlisted/);
 }finally{
  if(trustedServer)await close(trustedServer);
  if(impostorServer)await close(impostorServer);
  fs.rmSync(root,{recursive:true,force:true});
  fs.rmSync(other,{recursive:true,force:true});
 }
});
