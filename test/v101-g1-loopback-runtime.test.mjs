import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {createV101G1LoopbackRuntime} from '../src/v101-g1-loopback-runtime.mjs';

const route=()=>({
  hostId:'host-1',profileId:'emad',principalId:'owner-1',
  conversationId:'chat-1',operationId:'step-1',
  target:{kind:'workflow-root',id:'root-a'}
});
function opts(dir,cert,key,counts){
  return {
    directory:path.join(dir,'grants'),
    resource:'https://commander.example.invalid/mcp-v2',
    authorizationServers:['https://idp.example.invalid'],
    certificatePem:cert,privateKeyPem:key,
    hostId:'host-1',profileId:'emad',issuer:'https://idp.example.invalid',
    audience:'https://commander.example.invalid/mcp-v2',
    verifyAccessToken:async()=>{counts.auth++;throw Error('UNEXPECTED_TOKEN');},
    resolvePrincipal:async()=>{counts.principal++;return null;},
    resolveOwnerRoute:async()=>{counts.owner++;return route();},
    authorizeExactInvocation:async()=>{counts.grant++;return false;},
    createTrustedDispatcher:async()=>{counts.dispatch++;throw Error('UNEXPECTED_DISPATCH');},
    ownerSessionOptions:process.platform==='win32'
      ?{execFileImpl:()=>{counts.native++;throw Error('NO_NATIVE_PROMPT');}}
      :{execFileImpl:()=>{counts.native++;throw Error('NO_NATIVE_PROMPT');}}
  };
}
function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-g1-loopback-'));
  const cert=path.join(dir,'cert.pem'),key=path.join(dir,'key.pem');
  const generate=spawnSync('openssl',[
    'req','-x509','-newkey','rsa:2048','-nodes','-sha256',
    '-config',process.platform==='win32'?'NUL':'/dev/null',
    '-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'
  ],{encoding:'utf8',timeout:8000,windowsHide:true});
  if(generate.error||generate.status!==0){
    fs.rmSync(dir,{recursive:true,force:true});
    return null;
  }
  return {dir,cert:fs.readFileSync(cert,'utf8'),
    key:fs.readFileSync(key,'utf8'),cleanup(){
      fs.rmSync(dir,{recursive:true,force:true});
    }};
}

test('G1 runtime denies missing trusted callbacks, wrong OS and invalid ports',()=>{
  for(const [port,platform,hostOptions] of [
    [443,process.platform,{}],
    [443,'darwin',{}],
    [-1,process.platform,{}],
    [65536,process.platform,{}],
    [443,process.platform,{issuer:'untrusted'}],
  ]){
    assert.throws(()=>createV101G1LoopbackRuntime({
      port,platform,hostOptions
    }),/BOOTSTRAP_REQUIRED/);
  }
});

test('G1 loopback opens only a client-authenticated TLS listener and never grants anonymous MCP',{
  skip:!['win32','linux'].includes(process.platform)
},async t=>{
  const f=fixture();
  if(!f)return t.skip('OpenSSL fixture generator unavailable');
  const calls={auth:0,principal:0,owner:0,grant:0,dispatch:0,native:0};
  let runtime;
  try{
    runtime=createV101G1LoopbackRuntime({
      port:0,hostOptions:opts(f.dir,f.cert,f.key,calls)
    });
    assert.equal(runtime.status.phase,'CONSTRUCTED');
    assert.equal(runtime.status.port,null);
    assert.equal(runtime.status.releaseAccepted,false);
    assert.equal(runtime.status.fullAccessActive,false);
    const live=await runtime.start();
    assert.equal(live.phase,'LISTENING');
    assert.equal(live.bindAddress,'127.0.0.1');
    assert.ok(live.port>0);
    assert.equal(live.tlsClientCertificateRequired,true);
    assert.equal(live.authenticatedCurrentChatAccepted,false);
    await assert.rejects(runtime.start(),/ALREADY_STARTED_OR_CLOSED/);
    const result=await new Promise(resolve=>{
      const req=https.get({
        host:'127.0.0.1',port:live.port,
        path:'/.well-known/oauth-protected-resource/mcp-v2',
        ca:f.cert,servername:'localhost',timeout:1500
      },response=>{
        response.resume();
        response.on('end',()=>resolve({status:response.statusCode}));
      });
      req.on('error',error=>resolve({code:error.code??'SSL_DENIED'}));
      req.on('timeout',()=>{req.destroy();resolve({code:'TIMEOUT'});});
    });
    assert.notEqual(result.status,200,'unauthenticated client TLS must not be accepted');
    assert.ok(result.code,'no successful HTTP exchange is expected without client mTLS');
    assert.deepEqual(calls,{auth:0,principal:0,owner:0,grant:0,dispatch:0,native:0});
    await runtime.close();await runtime.close();
    assert.equal(runtime.status.phase,'CLOSED');
    assert.equal(runtime.status.port,null);
  }finally{
    await runtime?.close();
    f.cleanup();
  }
});

test('G1 port conflicts fail closed without changing any existing listener',{
  skip:!['win32','linux'].includes(process.platform)
},async t=>{
  const f=fixture();
  if(!f)return t.skip('OpenSSL fixture generator unavailable');
  const calls={auth:0,principal:0,owner:0,grant:0,dispatch:0,native:0};
  const original=net.createServer();
  let runtime;
  try{
    await new Promise((resolve,reject)=>
      original.listen(0,'127.0.0.1',resolve).once('error',reject));
    const port=original.address().port;
    runtime=createV101G1LoopbackRuntime({
      port,hostOptions:opts(f.dir,f.cert,f.key,calls)
    });
    await assert.rejects(runtime.start(),{code:'EADDRINUSE'});
    assert.equal(runtime.status.phase,'CLOSED');
    assert.equal(original.listening,true);
    assert.deepEqual(calls,{auth:0,principal:0,owner:0,grant:0,dispatch:0,native:0});
  }finally{
    await runtime?.close();
    await new Promise(resolve=>original.close(()=>resolve()));
    f.cleanup();
  }
});

test('G1 startup and close race cannot leave a late authenticated listener',{
  skip:!['win32','linux'].includes(process.platform)
},async t=>{
  const f=fixture();
  if(!f)return t.skip('OpenSSL fixture generator unavailable');
  const calls={auth:0,principal:0,owner:0,grant:0,dispatch:0,native:0};
  const runtime=createV101G1LoopbackRuntime({
    port:0,hostOptions:opts(f.dir,f.cert,f.key,calls)
  });
  try{
    const starting=runtime.start();
    const closing=runtime.close();
    await assert.rejects(starting,/CLOSED_DURING_START/);
    await closing;
    assert.equal(runtime.status.phase,'CLOSED');
    assert.equal(runtime.status.port,null);
    assert.deepEqual(calls,{auth:0,principal:0,owner:0,grant:0,dispatch:0,native:0});
  }finally{
    await runtime.close();
    f.cleanup();
  }
});
