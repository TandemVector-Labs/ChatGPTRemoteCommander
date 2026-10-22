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
  const config=path.join(dir,'openssl-fixture.cnf');
  fs.writeFileSync(config,'[req]\n'+
   'distinguished_name=dn\n'+
   'prompt=no\n'+
   'x509_extensions=v3\n'+
   '[dn]\n'+
   'CN=SyncthingFixture\n'+
   '[v3]\n'+
   'subjectAltName=IP:127.0.0.1\n');
  const x=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes',
   '-keyout',key,'-out',crt,'-days','1','-config',config],
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

test('refuses linked certificate and linked parent before contacting any API listener',async t=>{
 const root=temp(),outside=temp();
 try{
  fs.mkdirSync(path.join(root,'state'));
  // A symlink to a valid PEM is not a trusted certificate from the configured
  // operator state, even if the content parses as X.509.
  const dummyPath=path.join(outside,'pem');
  fs.writeFileSync(dummyPath,'X'.repeat(128));
  const certPath=path.join(root,'state','https-cert.pem');
  try{fs.symlinkSync(dummyPath,certPath,'file');}
  catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){
   t.skip('No permission to create a test symbolic link');return;
  }throw e;}
  await assert.rejects(pinnedSyncthingJson(root,'http://127.0.0.1:18384',KEY,
   '/rest/system/status'),/certificate unavailable or unsafe/);
  fs.unlinkSync(certPath);
  fs.rmdirSync(path.join(root,'state'));
  fs.mkdirSync(path.join(outside,'state'));
  fs.symlinkSync(path.join(outside,'state'),path.join(root,'state'),
   process.platform==='win32'?'junction':'dir');
  await assert.rejects(pinnedSyncthingJson(root,'http://127.0.0.1:18384',KEY,
   '/rest/system/status'),/certificate unavailable or unsafe/);
 }finally{
  fs.rmSync(root,{recursive:true,force:true});
  fs.rmSync(outside,{recursive:true,force:true});
 }
});


test('certificate growth cannot force unbounded descriptor read or credential delivery',async()=>{
 const root=temp(),pem=path.join(root,'state','https-cert.pem');
 const originalLstat=fs.lstatSync;
 const originalRead=fs.readSync;
 const originalReadFile=fs.readFileSync;
 const originalRequest=https.request;
 let mutated=false,readBytes=0,unboundedReads=0,networkCalls=0;
 try {
  fs.mkdirSync(path.dirname(pem),{mode:0o700});
  fs.writeFileSync(pem,Buffer.alloc(180,0x41),{mode:0o600});
  // Mutate the exact inode after the first file identity check, while the
  // descriptor is open but before the certificate bytes are read.
  fs.lstatSync=function(target,...args){
   const st=originalLstat.call(fs,target,...args);
   if(target===pem&&!mutated){
    mutated=true;
    fs.appendFileSync(pem,Buffer.alloc(1024*1024,0x42));
   }
   return st;
  };
  fs.readSync=function(fd,buffer,offset,length,position){
   const n=originalRead.call(fs,fd,buffer,offset,length,position);
   readBytes+=n;
   return n;
  };
  fs.readFileSync=function(target,...args){
   if(typeof target==='number')unboundedReads++;
   return originalReadFile.call(fs,target,...args);
  };
  https.request=function(){
   networkCalls++;
   throw Error('UNEXPECTED_TLS_REQUEST');
  };
  await assert.rejects(
   pinnedSyncthingJson(root,'http://127.0.0.1:8384',KEY,'/rest/system/status'),
   /certificate unavailable or unsafe/
  );
  assert.equal(mutated,true);
  assert.equal(unboundedReads,0,'never use readFileSync on mutable descriptor');
  assert.ok(readBytes<=32768,'read must never exceed validated PEM cap');
  assert.equal(readBytes,180,'exactly the initial trusted file length can be read');
  assert.equal(networkCalls,0,'rejected certificate cannot emit an API request');
 } finally {
  fs.lstatSync=originalLstat;
  fs.readSync=originalRead;
  fs.readFileSync=originalReadFile;
  https.request=originalRequest;
  fs.rmSync(root,{recursive:true,force:true});
 }
});

test('certificate shrink during descriptor read is denied without TLS',async()=>{
 const root=temp(),pem=path.join(root,'state','https-cert.pem');
 const originalLstat=fs.lstatSync;
 const originalRequest=https.request;
 let mutated=false,networkCalls=0;
 try{
  fs.mkdirSync(path.dirname(pem),{mode:0o700});
  fs.writeFileSync(pem,Buffer.alloc(200,0x41),{mode:0o600});
  fs.lstatSync=function(target,...args){
   const st=originalLstat.call(fs,target,...args);
   if(target===pem&&!mutated){
    mutated=true;
    fs.truncateSync(pem,120);
   }
   return st;
  };
  https.request=function(){networkCalls++;throw Error('UNEXPECTED_TLS_REQUEST');};
  await assert.rejects(
   pinnedSyncthingJson(root,'http://127.0.0.1:8384',KEY,'/rest/system/status'),
   /certificate unavailable or unsafe/
  );
  assert.equal(mutated,true);
  assert.equal(networkCalls,0);
 }finally{
  fs.lstatSync=originalLstat;
  https.request=originalRequest;
  fs.rmSync(root,{recursive:true,force:true});
 }
});
