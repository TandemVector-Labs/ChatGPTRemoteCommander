import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createWindowsNativeOwnerSessionProvider} from '../src/native-owner-session-provider-windows.mjs';
import {createV2CandidatePrivateTunnelHttpsGateway} from '../src/v2-private-tunnel-https-gateway.mjs';
import {createV2PlatformSessionProofAuthority} from '../src/v2-platform-session-proof.mjs';
import {createV101G1PrivateTunnelRuntime,createV101G1PrivatePairRuntime} from '../src/v101-g1-loopback-runtime.mjs';
import './v2-private-pair-mcp-http-ingress.test.mjs';

import {createV101PrivatePairNativeOwnerStack} from '../src/v101-private-pair-native-owner-stack.mjs';
import {createV2OwnerPinnedPrivatePairAttestor} from '../src/v2-private-tunnel-mtls-attestor.mjs';
import {createV2PrivatePairOperationGate} from '../src/v2-private-pair-operation-gate.mjs';
import {createV2PrivateSignedWorkerGrantAdapter} from '../src/v2-private-signed-worker-grant-adapter.mjs';
import {MutationIdempotencyStore} from '../src/mutation-idempotency.mjs';
import {readText} from '../src/tools-v0.3.mjs';
import {createV012PrivateCoreRuntime} from '../src/v012-private-core-runtime.mjs';
import {deriveWorkerId} from '../src/worker-identity-authority.mjs';
import {generateKeyPairSync,sign} from 'node:crypto';

const RESOURCE='https://commander.example.invalid/mcp-v2';
const ISSUER='https://idp.example.invalid';
const QA_TOKEN=['synthetic','tunnel','qa','token','1234'].join('-');
function openssl(args,cwd){
  const result=spawnSync('openssl',args,{
    cwd,encoding:'utf8',timeout:9000,windowsHide:true
  });
  if(result.error||result.status!==0)throw Error(
    'FIXTURE_OPENSSL_ERROR '+(result.error?.code??result.status));
}
function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-v012-tunnel-mtls-'));
  const cfg=process.platform==='win32'?'NUL':'/dev/null';
  try{
    const req=(name,ca)=>openssl([
      'req','-x509','-newkey','rsa:2048','-nodes','-sha256',
      '-config',cfg,'-days','1','-keyout',name+'.key','-out',name+'.crt',
      '-subj','/CN='+name,...(ca?['-addext','basicConstraints=critical,CA:TRUE',
      '-addext','keyUsage=critical,keyCertSign,cRLSign']:[])
    ],dir);
    req('ca',true);
    // The e2e client also validates its server certificate, not merely the
    // incoming tunnel-client leaf. Sign server with the fixture CA and pin
    // its loopback IP subjectAltName rather than disabling TLS verification.
    openssl(['req','-newkey','rsa:2048','-nodes','-sha256',
      '-config',cfg,'-keyout','server.key','-out','server.csr',
      '-subj','/CN=127.0.0.1'],dir);
    fs.writeFileSync(path.join(dir,'server.ext'),
      'basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n'
      +'extendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n');
    openssl(['x509','-req','-in','server.csr','-CA','ca.crt',
      '-CAkey','ca.key','-CAcreateserial','-out','server.crt',
      '-days','1','-sha256','-extfile','server.ext'],dir);
    function client(name){
      openssl(['req','-newkey','rsa:2048','-nodes','-sha256',
        '-config',cfg,'-keyout',name+'.key','-out',name+'.csr',
        '-subj','/CN='+name],dir);
      const ext=path.join(dir,name+'.ext');
      fs.writeFileSync(ext,'basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=clientAuth\n');
      openssl(['x509','-req','-in',name+'.csr','-CA','ca.crt',
        '-CAkey','ca.key','-CAcreateserial','-out',name+'.crt',
        '-days','1','-sha256','-extfile',name+'.ext'],dir);
    }
    client('tunnel');client('unrecognized');
    const file=name=>fs.readFileSync(path.join(dir,name),'utf8');
    const tunnelCert=file('tunnel.crt');
    const tunnelDer=requireDer(tunnelCert);
    return {
      ca:file('ca.crt'),serverCert:file('server.crt'),serverKey:file('server.key'),
      clientCert:tunnelCert,clientKey:file('tunnel.key'),
      alienCert:file('unrecognized.crt'),alienKey:file('unrecognized.key'),
      clientSha:createHash('sha256').update(tunnelDer).digest('hex'),
      dispose(){fs.rmSync(dir,{recursive:true,force:true});}
    };
  }catch(e){fs.rmSync(dir,{recursive:true,force:true});throw e;}
}
function requireDer(pem){
  return Buffer.from(pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/)[1].replace(/\s+/g,''),'base64');
}
const tdata=now=>({
  source:'native-tunnel-attestor',provider:'openai-secure-mcp-tunnel',
  profileId:'emad',tunnelIdHash:'a'.repeat(64),ownerSidHash:'b'.repeat(64),
  authenticated:true,controlPlanePollOk:true,healthzStatus:200,readyzStatus:200,
  lastPollAtMs:now-100,expiresAtMs:now+60000
});
function createGateway(f,identity){
  const authority=createV2PlatformSessionProofAuthority();
  const seen=[];
  const now=Date.now();
  const gateway=createV2CandidatePrivateTunnelHttpsGateway({
    resource:RESOURCE,authorizationServers:[ISSUER],
    certificatePem:f.serverCert,privateKeyPem:f.serverKey,clientCaPem:f.ca,
    expectedClientLeafDerSha256:f.clientSha,
    profileId:'emad',resolveTransportIdentity:async()=>identity??tdata(now),
    platformSessionProofAuthority:authority,now:()=>now,
    dispatcherFactory:async value=>{
      seen.push(value);
      return {protectedResource:gateway.protectedResource,
        async handleRpc(){return {jsonrpc:'2.0',id:1,result:{ok:true}};}};
    }
  });
  return {gateway,authority,seen};
}
async function request(port,cert,key,ca){
  return new Promise(resolve=>{
    const body=Buffer.from(JSON.stringify({
      jsonrpc:'2.0',id:1,method:'tools/call',
      params:{name:'v2_workflow_step',arguments:{},_meta:{'openai/session':'chat-1'}}
    }));
    const req=https.request({
      host:'127.0.0.1',port,path:'/mcp-v2',method:'POST',
      ca,
      ...(cert?{cert,key}:{})
    },res=>{
      let data='';res.on('data',c=>data+=c);
      res.on('end',()=>resolve({status:res.statusCode,body:data}));
    });
    req.on('error',e=>resolve({code:e.code??'TLS_DENIED'}));
    req.setTimeout(2500,()=>req.destroy());
    req.setHeader('content-type','application/json');
    req.setHeader('authorization','Bearer '+QA_TOKEN);
    req.end(body);
  });
}
test('tunnel HTTPS endpoint is unbound, client-cert-only and rejects unknown client',async t=>{
  let f;
  try{f=fixture();}catch{return t.skip('OpenSSL fixture generator unavailable');}
  let server;
  try{
    const x=createGateway(f);
    server=x.gateway.createUnboundTlsServer();
    assert.equal(server.listening,false);
    assert.equal(server.requestCert,true);
    assert.equal(server.rejectUnauthorized,true);
    await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
    const port=server.address().port;
    const none=await request(port,null,null,f.ca);
    assert.equal(none.status,undefined);
    assert.ok(none.code,'No client certificate must not complete TLS');
    const alien=await request(port,f.alienCert,f.alienKey,f.ca);
    assert.equal(alien.status,403,'Other CA-signed clients are not the pinned tunnel process');
    const ok=await request(port,f.clientCert,f.clientKey,f.ca);
    assert.equal(ok.status,200);
    assert.equal(x.seen.length,1);
    assert.deepEqual({...x.authority.inspect(x.seen[0].platformSessionProof)},{
      peerType:'openai-tunnel-client-mtls',sessionSource:'openai/session',
      sessionHandle:'chat-1',
      tokenSha256:createHash('sha256').update(QA_TOKEN).digest('hex')
    });
  }finally{
    if(server?.listening)await new Promise(resolve=>server.close(resolve));
    f.dispose();
  }
});
test('stale tunnel control-plane identity rejects authenticated TLS requests',async t=>{
  let f;try{f=fixture();}catch{return t.skip('OpenSSL fixture generator unavailable');}
  let server;
  try{
    const now=Date.now();const x=createGateway(f,{...tdata(now),controlPlanePollOk:false});
    server=x.gateway.createUnboundTlsServer();
    await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
    const reply=await request(server.address().port,f.clientCert,f.clientKey,f.ca);
    assert.equal(reply.status,403);
    assert.equal(x.seen.length,0);
  }finally{
    if(server?.listening)await new Promise(resolve=>server.close(resolve));
    f.dispose();
  }
});
test('tunnel gateway refuses missing CA, unmatched key and missing trusted process callback',async t=>{
  let f;try{f=fixture();}catch{return t.skip('OpenSSL fixture generator unavailable');}
  try{
    const options={
      resource:RESOURCE,authorizationServers:[ISSUER],
      certificatePem:f.serverCert,privateKeyPem:f.serverKey,
      clientCaPem:f.ca,expectedClientLeafDerSha256:f.clientSha,
      profileId:'emad',resolveTransportIdentity:async()=>tdata(Date.now()),
      dispatcherFactory:async()=>({})
    };
    for(const patch of [
      {clientCaPem:''},{privateKeyPem:f.alienKey},
      {resolveTransportIdentity:undefined},{expectedClientLeafDerSha256:'bad'}
    ])assert.throws(()=>createV2CandidatePrivateTunnelHttpsGateway({...options,...patch}));
  }finally{f.dispose();}
});

test('full owner-scoped tunnel Runtime stays closed until explicit start and cannot grant Full Access',async t=>{
  let f;try{f=fixture();}catch{return t.skip('OpenSSL fixture generator unavailable');}
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rc-v012-owner-stack-'));
  let runtime;
  const attempts={oauth:0,owner:0,dispatch:0};
  try{
    const now=Date.now();
    const hostOptions={
      directory,resource:RESOURCE,authorizationServers:[ISSUER],
      certificatePem:f.serverCert,privateKeyPem:f.serverKey,clientCaPem:f.ca,
      expectedClientLeafDerSha256:f.clientSha,
      resolveTransportIdentity:async()=>tdata(now),
      hostId:'host-1',profileId:'emad',issuer:ISSUER,audience:RESOURCE,
      verifyAccessToken:async()=>{attempts.oauth++;throw Error('QA_NO_OAUTH');},
      resolvePrincipal:async()=>{attempts.owner++;return 'owner-1';},
      resolveOwnerRoute:async()=>{attempts.owner++;throw Error('NO_REAL_OWNER_PROOF');},
      authorizeExactInvocation:async()=>{attempts.dispatch++;return false;},
      createTrustedDispatcher:async()=>({
        protectedResource:{
          metadataUrl:new URL('/.well-known/oauth-protected-resource/mcp-v2',RESOURCE).href
        },
        handleRpc:async()=>({jsonrpc:'2.0',id:1,result:{isError:true}})
      })
    };
    runtime=createV101G1PrivateTunnelRuntime({port:0,hostOptions});
    assert.equal(runtime.status.phase,'CONSTRUCTED');
    assert.equal(runtime.status.port,null);
    assert.equal(runtime.status.protectedTransport,'private-tunnel-client-mtls');
    assert.equal(runtime.status.fullAccessActive,false);
    assert.equal(runtime.status.authenticatedCurrentChatAccepted,false);
    const live=await runtime.start();
    assert.equal(live.phase,'LISTENING');
    const bad=await request(live.port,f.alienCert,f.alienKey,f.ca);
    assert.equal(bad.status,403);
    const acceptedClient=await request(live.port,f.clientCert,f.clientKey,f.ca);
    assert.equal(acceptedClient.status,200);
    assert.equal(JSON.parse(acceptedClient.body).result?.isError,true);
    assert.equal(attempts.dispatch,0);
    await runtime.close();
    assert.equal(runtime.status.phase,'CLOSED');
    assert.equal(runtime.status.releaseAccepted,false);
  }finally{
    await runtime?.close();
    f.dispose();
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

async function privatePairRequest(port,cert,key,message,extraHeaders={},serverCa=null){
  return new Promise(resolve=>{
    const bytes=Buffer.from(JSON.stringify(message));
    const req=https.request({
      host:'127.0.0.1',port,path:'/mcp',method:'POST',
      rejectUnauthorized:serverCa!==null,
      ...(serverCa?{ca:serverCa}:{}),
      ...(cert?{cert,key}:{})
    },res=>{
      let data='';res.on('data',c=>data+=c);
      res.on('end',()=>resolve({status:res.statusCode,
        body:data?JSON.parse(data):null}));
    });
    req.setHeader('content-type','application/json');
    for(const [field,value] of Object.entries(extraHeaders))req.setHeader(field,value);
    req.on('error',error=>resolve({code:error.code??'TLS_DENIED'}));
    req.setTimeout(2500,()=>req.destroy());
    req.end(bytes);
  });
}
test('PRIVATE pair HTTPS authenticates a pinned tunnel without OAuth and still requires native owner action',async t=>{
  let f;try{f=fixture();}catch{return t.skip('OpenSSL fixture generator unavailable');}
  const now=Date.now();
  let server;const actions={bind:0,work:0};
  try{
    const gateway=createV2CandidatePrivateTunnelHttpsGateway({
      certificatePem:f.serverCert,privateKeyPem:f.serverKey,
      clientCaPem:f.ca,expectedClientLeafDerSha256:f.clientSha,
      profileId:'emad',resolveTransportIdentity:async()=>tdata(now),now:()=>now,
      privateOwnerPair:{
        expectedTunnelIdHash:'a'.repeat(64),expectedOwnerSidHash:'b'.repeat(64),
        resolveCurrentOwnerSidHash:async()=> 'b'.repeat(64),
        ownerStack:{resolveTrustedConversation:async()=>({
          source:'native-conversation-attested',sessionHandle:'chat-1'
        }),requestOwnerBinding:async()=>{actions.bind++;},
          nativeSessionBindings:{resolveNativeRoute:async session=>{
            assert.equal(session,'chat-1');
            return {hostId:'host-1',profileId:'emad',principalId:'owner-1',
              conversationId:'chat-1',operationId:'step-2',
              target:{kind:'workflow-root',id:'root-1'}};
          }}},
        operationGate:{execute:async()=>{actions.work++;return {ok:true};}},
        trustedToolCatalog:[{name:'read_text',description:'Read an owner-approved file',
          inputSchema:{type:'object',required:['path'],properties:{path:{type:'string'}}}}],
        validateToolInput:async(name,args)=>name==='read_text'&&args?.path==='README.md',
        resolveTrustedToolRoute:async({sessionHandle,nativeRoute,tool})=>{
          assert.equal(sessionHandle,'chat-1');assert.equal(tool,'read_text');
          return {...nativeRoute,operationId:'exact-read-1'};
        }
      }
    });
    assert.equal(gateway.requiredTransport,'owner-pinned-private-tunnel-mtls');
    assert.equal(gateway.protectedResource,null,'PRIVATE has no OAuth issuer');
    server=gateway.createUnboundTlsServer();
    assert.equal(server.listening,false);
    assert.equal(server.requestCert,true);
    assert.equal(server.rejectUnauthorized,true);
    await new Promise((resolve,reject)=>
      server.listen(0,'127.0.0.1',resolve).once('error',reject));
    const port=server.address().port;
    const listMessage={jsonrpc:'2.0',id:1,method:'tools/list',params:{}};
    const noCert=await privatePairRequest(port,null,null,listMessage);
    assert.equal(noCert.status,undefined);
    assert.ok(noCert.code);
    const other=await privatePairRequest(port,f.alienCert,f.alienKey,listMessage);
    assert.equal(other.status,403);
    const known=await privatePairRequest(port,f.clientCert,f.clientKey,listMessage);
    assert.equal(known.status,200);
    assert.deepEqual(known.body.result.tools.map(x=>x.name),
      ['v2_private_owner_bind','v2_workflow_step','read_text']);
    assert.equal(actions.bind,0);
    assert.equal(actions.work,0);
    const discovery={
      jsonrpc:'2.0',id:'discover',method:'server/discover',
      params:{_meta:{
        'io.modelcontextprotocol/protocolVersion':'2026-07-28',
        'io.modelcontextprotocol/clientInfo':{name:'qa',version:'1.0.0'},
        'io.modelcontextprotocol/clientCapabilities':{}
      }}
    };
    const modern=await privatePairRequest(port,f.clientCert,f.clientKey,discovery,{
      'MCP-Protocol-Version':'2026-07-28','Mcp-Method':'server/discover'
    });
    assert.equal(modern.status,200);
    assert.equal(modern.body.result.resultType,'complete');
    assert.ok(modern.body.result.supportedVersions.includes('2026-07-28'));
    assert.equal(actions.bind,0);
    assert.equal(actions.work,0);
    const binding=await privatePairRequest(port,f.clientCert,f.clientKey,{
      jsonrpc:'2.0',id:2,method:'tools/call',
      params:{name:'v2_private_owner_bind',arguments:{},
        _meta:{'openai/session':'chat-1'}}
    });
    assert.equal(binding.status,200);
    assert.equal(actions.bind,1);
    assert.equal(actions.work,0);
    const work=await privatePairRequest(port,f.clientCert,f.clientKey,{
      jsonrpc:'2.0',id:3,method:'tools/call',
      params:{name:'v2_workflow_step',arguments:{
        route:{hostId:'host-1',profileId:'emad',principalId:'owner-1',
          conversationId:'chat-1',operationId:'step-1',
          target:{kind:'workflow-root',id:'root-1'}},
        tool:'read_text',arguments:{path:'README.md'}
      },_meta:{'openai/session':'chat-1'}}
    });
    assert.equal(work.status,200);
    assert.equal(actions.work,1);
    const direct=await privatePairRequest(port,f.clientCert,f.clientKey,{
      jsonrpc:'2.0',id:4,method:'tools/call',
      params:{name:'read_text',arguments:{path:'README.md'},
        _meta:{'openai/session':'chat-1'}}
    });
    assert.equal(direct.status,200);
    assert.equal(direct.body.result.isError,false);
    assert.equal(actions.work,2);
  }finally{
    if(server?.listening)await new Promise(resolve=>server.close(resolve));
    f.dispose();
  }
});

test('PRIVATE tunnel mTLS rejects mismatched native owner or unusable pair bootstrap',async t=>{
  let f;try{f=fixture();}catch{return t.skip('OpenSSL fixture generator unavailable');}
  let server;
  try{
    const now=Date.now();
    const options={
      certificatePem:f.serverCert,privateKeyPem:f.serverKey,
      clientCaPem:f.ca,expectedClientLeafDerSha256:f.clientSha,
      profileId:'emad',resolveTransportIdentity:async()=>tdata(now),
      now:()=>now,
      privateOwnerPair:{
        resolveTrustedConversation:async()=>({
          source:'native-conversation-attested',sessionHandle:'chat-1'
        }),
        expectedTunnelIdHash:'a'.repeat(64),expectedOwnerSidHash:'b'.repeat(64),
        resolveCurrentOwnerSidHash:async()=> 'f'.repeat(64),
        ownerStack:{resolveTrustedConversation:async()=>({
          source:'native-conversation-attested',sessionHandle:'chat-1'
        }),requestOwnerBinding:async()=>{throw Error('not authorized');}},
        operationGate:{execute:async()=>{throw Error('not authorized');}}
      }
    };
    assert.throws(()=>createV2CandidatePrivateTunnelHttpsGateway({
      ...options,dispatcherFactory:async()=>({})
    }),{code:'V2_TUNNEL_PRIVATE_PAIR_MODE_CONFLICT'});
    assert.throws(()=>createV2CandidatePrivateTunnelHttpsGateway({
      ...options,privateOwnerPair:{
        ...options.privateOwnerPair,resolveTrustedConversation:undefined,
        ownerStack:{...options.privateOwnerPair.ownerStack,
          resolveTrustedConversation:undefined}
      }
    }),{code:'V2_TUNNEL_PRIVATE_PAIR_BOOTSTRAP_REQUIRED'});

    server=createV2CandidatePrivateTunnelHttpsGateway(options)
      .createUnboundTlsServer();
    await new Promise((resolve,reject)=>
      server.listen(0,'127.0.0.1',resolve).once('error',reject));
    const reply=await privatePairRequest(server.address().port,
      f.clientCert,f.clientKey,{jsonrpc:'2.0',id:1,method:'tools/list'});
    assert.equal(reply.status,403);
  }finally{
    if(server?.listening)await new Promise(resolve=>server.close(resolve));
    f.dispose();
  }
});

test('PRIVATE pair runtime opens only on explicit owner start and retains NO_PROMOTE status',async t=>{
  let f;try{f=fixture();}catch{return t.skip('OpenSSL fixture unavailable');}
  let runtime,closed=0;
  const now=Date.now();
  try{
    const hostOptions={
      certificatePem:f.serverCert,privateKeyPem:f.serverKey,clientCaPem:f.ca,
      expectedClientLeafDerSha256:f.clientSha,profileId:'emad',
      resolveTransportIdentity:async()=>tdata(now),now:()=>now,
      privateOwnerPair:{
        resolveTrustedConversation:async()=>({
          source:'native-conversation-attested',sessionHandle:'chat-1'
        }),
        expectedTunnelIdHash:'a'.repeat(64),expectedOwnerSidHash:'b'.repeat(64),
        resolveCurrentOwnerSidHash:async()=> 'b'.repeat(64),
        ownerStack:{resolveTrustedConversation:async()=>({
          source:'native-conversation-attested',sessionHandle:'chat-1'
        }),requestOwnerBinding:async()=>{},close:()=>{closed++;}},
        operationGate:{execute:async()=>{throw Error('no owner grants');}}
      }
    };
    runtime=createV101G1PrivatePairRuntime({port:0,hostOptions});
    assert.equal(runtime.status.phase,'CONSTRUCTED');
    assert.equal(runtime.status.port,null);
    assert.equal(runtime.status.fullAccessActive,false);
    assert.equal(runtime.status.releaseAccepted,false);
    const live=await runtime.start();
    assert.equal(live.phase,'LISTENING');
    assert.equal(live.protectedTransport,'owner-pinned-private-tunnel-mtls');
    const noCertificate=await privatePairRequest(live.port,null,null,
      {jsonrpc:'2.0',id:1,method:'tools/list'});
    assert.ok(noCertificate.code);
    const known=await privatePairRequest(live.port,f.clientCert,f.clientKey,
      {jsonrpc:'2.0',id:1,method:'tools/list'});
    assert.equal(known.status,200);
    assert.equal(runtime.status.fullAccessActive,false);
    await runtime.close();
    assert.equal(runtime.status.phase,'CLOSED');
    assert.equal(closed,1);
  }finally{
    await runtime?.close();
    f.dispose();
  }
});

test('full isolated mTLS to signed Worker and real Core readText denies replays after J01 revoke',{
  skip:process.platform!=='win32'
},async t=>{
  let f;try{f=fixture();}catch{return t.skip('OpenSSL fixture unavailable');}
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc012-mtls-real-core-')));
  const approvedFile=path.join(root,'approved.txt');
  fs.writeFileSync(approvedFile,'private-core-mtls-read-only\n');
  const OWNER_SID='S-1-5-21-111-222-333-1001';
  const OWNER_HASH=createHash('sha256').update(
    'commander.os-owner.sid.v1\0win32\0sid='+OWNER_SID).digest('hex');
  const TUNNEL_HASH='a'.repeat(64);
  const context={roots:[root],auditLog:path.join(root,'audit.jsonl'),config:{
    allowedRoots:[root],maxReadBytes:524288,
    powerMode:{enabled:false,fullFilesystem:false}
  }};
  const now=Date.now(),state={effects:0,consents:0,allow:true,worker:null};
  const receiptStore=new MutationIdempotencyStore({
    directory:path.join(root,'receipts'),scope:'rc012-mtls-to-real-core'
  });
  let nativeStack,server;
  const route=conversationId=>({
    hostId:'host-1',profileId:'emad',principalId:'account-1',
    conversationId,operationId:'owner-enroll',
    target:{kind:'workflow-root',id:'project-1'}
  });
  const liveRoute=conversationId=>({
    ...route(conversationId),operationId:'read-1'
  });
  const nativeExec=(file,args,_options,callback)=>{
    assert.equal(file,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    const mode=args[args.indexOf('-Mode')+1];
    if(mode==='Snapshot')return callback(null,JSON.stringify({
      schema:1,ownerSid:OWNER_SID,sessionId:7,active:true,interactive:true
    })+'\n','');
    if(mode==='Consent'){
      state.consents++;
      return callback(null,JSON.stringify({approved:true})+'\n','');
    }
    return callback(Error('unknown mode'),'','');
  };
  const transportIdentity=()=>({
    ...tdata(now),ownerSidHash:OWNER_HASH,tunnelIdHash:TUNNEL_HASH
  });
  const peerAttestor=createV2OwnerPinnedPrivatePairAttestor({
    expectedClientLeafDerSha256:f.clientSha,
    profileId:'emad',expectedTunnelIdHash:TUNNEL_HASH,
    expectedOwnerSidHash:OWNER_HASH,
    resolveCurrentOwnerSidHash:async()=>nativeStack.readCurrentOwnerSidHash(),
    resolveTransportIdentity:async()=>transportIdentity(),now:()=>now
  });
  const FIELDS=['issuer','audience','hostId','profileId','principalId',
    'conversationId','bindingId','workerId','ownerSidHash','deviceProvider',
    'deviceIdHash','tunnelProvider','tunnelIdHash','capabilityPolicyDigest',
    'grantRevision','issuedAtMs','expiresAtMs','nonce'];
  try{
    nativeStack=createV101PrivatePairNativeOwnerStack({
      directory:path.join(root,'owner-grants'),profileId:'emad',
      expectedTunnelIdHash:TUNNEL_HASH,expectedOwnerSidHash:OWNER_HASH,
      attestTransport:peerAttestor,resolveOwnerRoute:async h=>route(h),
      now:()=>now,
      ownerSessionOptions:{
        platform:'win32',
        powershell:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        script:'C:\\Commander\\src\native-owner-session-windows.ps1',
        execFileImpl:nativeExec,verifyFile:()=>{},
        snapshotTimeoutMs:1000,dialogTimeoutMs:5000
      }
    });
    const {privateKey,publicKey}=generateKeyPairSync('ed25519');
    const der=publicKey.export({type:'spki',format:'der'});
    const keyId=createHash('sha256').update(der).digest('hex');
    const workerId=deriveWorkerId({
      hostId:'host-1',profileId:'emad',ownerSidHash:OWNER_HASH,
      deviceProvider:'native-key-store',deviceIdHash:'d'.repeat(64),keyId
    });
    const POLICY='e'.repeat(64);
    const workerRegistry={get:async()=>state.worker};
    const workerAuthority={authorizeWorker:async({workerId:id,invocation})=>{
      if(!state.allow||id!==workerId||invocation.tool!=='read_text'
        ||invocation.arguments.path!==approvedFile)return null;
      const claims=state.worker?.claims;
      return {authorized:true,workerId,keyId,
        bindingId:claims.bindingId,capabilityPolicyDigest:POLICY,
        grantRevision:1,expiresAtMs:claims.expiresAtMs};
    }};
    const verifyExactNativeGrant=createV2PrivateSignedWorkerGrantAdapter({
      hostId:'host-1',profileId:'emad',principalId:'account-1',
      expectedTunnelIdHash:TUNNEL_HASH,expectedOwnerSidHash:OWNER_HASH,
      issuer:'commander.local',audience:'remote-commander',
      workerRegistry,workerAuthority,
      resolveCurrentWorkerId:async()=>workerId,
      resolveCurrentOwnerRoute:async owner=>liveRoute(owner.conversationId),
      now:()=>now
    });
    const gate=createV2PrivatePairOperationGate({
      hostId:'host-1',profileId:'emad',principalId:'account-1',
      expectedTunnelIdHash:TUNNEL_HASH,expectedOwnerSidHash:OWNER_HASH,
      attestTransport:peerAttestor,
      resolveOwnerContext:async r=>nativeStack.resolveOwnerContext(r.conversationId),
      readCurrentOwnerSidHash:async()=>nativeStack.readCurrentOwnerSidHash(),
      verifyExactNativeGrant,now:()=>now,receiptStore,
      // No live server locks in this disposable one-file QA; production must
      // replace this with the machine-global WorkflowStore lease.
      withLease:async(_resource,work)=>work(),
      execute:async(_r,args,tool)=>{
        assert.equal(tool,'read_text');
        state.effects++;
        return readText(context,args);
      }
    });
    const gateway=createV2CandidatePrivateTunnelHttpsGateway({
      certificatePem:f.serverCert,privateKeyPem:f.serverKey,clientCaPem:f.ca,
      expectedClientLeafDerSha256:f.clientSha,
      profileId:'emad',resolveTransportIdentity:async()=>transportIdentity(),
      now:()=>now,privateOwnerPair:{
        expectedTunnelIdHash:TUNNEL_HASH,expectedOwnerSidHash:OWNER_HASH,
        resolveCurrentOwnerSidHash:()=>nativeStack.readCurrentOwnerSidHash(),
        ownerStack:nativeStack,operationGate:gate,
        trustedToolCatalog:[{name:'read_text',description:'Exact approved Core read',
          inputSchema:{type:'object',required:['path'],additionalProperties:false,
            properties:{path:{type:'string',minLength:1}}}}],
        validateToolInput:async(name,args)=>
          name==='read_text'&&args.path===approvedFile,
        resolveTrustedToolRoute:async({nativeRoute})=>({
          ...nativeRoute,operationId:'read-1'
        })
      }
    });
    server=gateway.createUnboundTlsServer();
    await new Promise((resolve,reject)=>
      server.listen(0,'127.0.0.1',resolve).once('error',reject));
    const port=server.address().port;
    const list={jsonrpc:'2.0',id:0,method:'tools/list',params:{}};
    const untrustedServer=await privatePairRequest(port,f.clientCert,
      f.clientKey,list,{},f.clientCert);
    assert.ok(untrustedServer.code,
      'the client must reject a server not signed by its pinned server CA');
    const alienPair=await privatePairRequest(port,f.alienCert,
      f.alienKey,list,{},f.ca);
    assert.equal(alienPair.status,403,
      'a client signed by the CA but with the wrong leaf is not the tunnel');
    assert.equal(state.effects,0);
    const send=(id,name,args,hint='chat-a')=>privatePairRequest(
      port,f.clientCert,f.clientKey,{jsonrpc:'2.0',id,method:'tools/call',
        params:{name,arguments:args,
          _meta:{'openai/session':hint}}},{},f.ca);
    const before=await send(1,'read_text',{path:approvedFile});
    assert.equal(before.status,503);
    assert.equal(state.effects,0);
    const binding=await send(2,'v2_private_owner_bind',{});
    assert.equal(binding.status,200);
    assert.equal(binding.body.result.isError,false);
    assert.equal(state.consents,1);
    const pair=await nativeStack.resolveTrustedConversation({
      authenticated:true,peerType:'owner-pinned-private-tunnel-mtls',
      sessionSource:'native-owner-private-pair'
    });
    const owner=await nativeStack.resolveOwnerContext(pair.sessionHandle);
    const claims={issuer:'commander.local',audience:'remote-commander',
      hostId:'host-1',profileId:'emad',principalId:'account-1',
      conversationId:pair.sessionHandle,bindingId:owner.bindingId,
      workerId,ownerSidHash:OWNER_HASH,deviceProvider:'native-key-store',
      deviceIdHash:'d'.repeat(64),tunnelProvider:'openai-secure-mcp-tunnel',
      tunnelIdHash:TUNNEL_HASH,capabilityPolicyDigest:POLICY,
      grantRevision:1,issuedAtMs:now-1000,expiresAtMs:now+60000,
      nonce:'f'.repeat(32)};
    const bytes=Buffer.from(JSON.stringify([
      'commander.worker.identity.v1',keyId,...FIELDS.map(field=>claims[field])
    ]));
    state.worker={schema:1,keyId,publicKey:der.toString('base64url'),
      claims,signature:sign(null,bytes,privateKey).toString('base64url')};
    const first=await send(3,'read_text',{path:approvedFile});
    assert.equal(first.status,200);
    assert.equal(first.body.result.isError,false);
    assert.equal(JSON.parse(first.body.result.content[0].text).text,
      'private-core-mtls-read-only\n');
    assert.equal(state.effects,1);
    const second=await send(4,'read_text',{path:approvedFile},'chat-b');
    assert.equal(second.status,200);
    assert.equal(second.body.result.isError,false);
    assert.equal(state.effects,1,'durable repeat must NOT rerun Core');
    const bad=await send(5,'read_text',{path:path.join(root,'other.txt')});
    assert.equal(bad.status,200);
    assert.equal(bad.body.result.isError,true);
    assert.equal(state.effects,1);
    assert.equal(await nativeStack.nativeSessionBindings.revokeTrusted({
      sessionHandle:pair.sessionHandle,adminProof:null
    }),true);
    const revoked=await send(6,'read_text',{path:approvedFile});
    assert.equal(revoked.status,503);
    assert.equal(state.effects,1);
    const rebind=await send(7,'v2_private_owner_bind',{},'chat-c');
    assert.equal(rebind.status,200);
    const refreshed=await nativeStack.resolveOwnerContext(pair.sessionHandle);
    assert.notEqual(refreshed.bindingId,owner.bindingId);
    const staleWorker=await send(8,'read_text',{path:approvedFile});
    assert.equal(staleWorker.status,503);
    assert.equal(state.effects,1);
    assert.equal(state.consents,3,'bind + revoke + rebind need separate prompts');
  }finally{
    if(server?.listening)await new Promise(resolve=>server.close(resolve));
    receiptStore.close();
    nativeStack?.close();
    f.dispose();
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('v0.12 private native Worker bootstrap rejects missing or competing authorities before any listener',()=>{
  const security={
    directory:path.join(os.tmpdir(),'unused-v012-owner-native-worker'),
    issuer:'commander.local',audience:'remote-commander',
    resolveOwnerRoute:async()=>null,
    bindWorkerToNativeOwner:()=>({})
  };
  const setup={
    port:0,
    identity:{hostId:'host-1',profileId:'emad',principalId:'account-1',
      expectedTunnelIdHash:'a'.repeat(64),expectedOwnerSidHash:'b'.repeat(64),
      resolveTransportIdentity:async()=>null},
    tls:{},security,
    core:{catalog:[{name:'read_text',inputSchema:{type:'object'}}],
      dispatch:async()=>null}
  };
  for(const patch of [
    {bindWorkerToNativeOwner:null},
    {bindWorkerToNativeOwner:undefined},
    {resolveCurrentWorkerId:async()=>null},
    {workerRegistry:{get:async()=>null}},
    {withLease:async()=>null}
  ])assert.throws(()=>createV012PrivateCoreRuntime({
    ...setup,security:{...security,...patch}
  }),{code:'V012_PRIVATE_CORE_WORKER_BOOTSTRAP_AMBIGUOUS_OR_MISSING'});
});

test('v0.12 protected Core composition uses J01 and signed worker before real readText',{
  skip:process.platform!=='win32'
},async t=>{
  let fixtureFiles;
  try{fixtureFiles=fixture();}catch{return t.skip('OpenSSL fixture unavailable');}
  const f=fixtureFiles;
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc012-private-core-compose-')));
  const approved=path.join(root,'approved.txt');
  fs.writeFileSync(approved,'private-core-composition-verified\n');
  const OWNER_SID='S-1-5-21-111-222-333-1001';
  const ownerHash=createHash('sha256').update(
    'commander.os-owner.sid.v1\0win32\0sid='+OWNER_SID).digest('hex');
  const tunnelHash='a'.repeat(64),now=Date.now();
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const der=publicKey.export({type:'spki',format:'der'});
  const keyId=createHash('sha256').update(der).digest('hex');
  const workerId=deriveWorkerId({
    hostId:'host-1',profileId:'emad',ownerSidHash:ownerHash,
    deviceProvider:'native-key-store',deviceIdHash:'d'.repeat(64),keyId
  });
  const policy='e'.repeat(64);
  const fields=['issuer','audience','hostId','profileId','principalId',
    'conversationId','bindingId','workerId','ownerSidHash','deviceProvider',
    'deviceIdHash','tunnelProvider','tunnelIdHash','capabilityPolicyDigest',
    'grantRevision','issuedAtMs','expiresAtMs','nonce'];
  const route=conversationId=>({
    hostId:'host-1',profileId:'emad',principalId:'account-1',
    conversationId,operationId:'bind-1',
    target:{kind:'workflow-root',id:'root-1'}
  });
  const liveRoute=conversationId=>({...route(conversationId),operationId:'read-1'});
  const state={consents:0,effects:0,allow:true,worker:null};
  const receiptStore=new MutationIdempotencyStore({
    directory:path.join(root,'receipts'),scope:'private-composition'
  });
  const context={roots:[root],auditLog:path.join(root,'audit.jsonl'),
    config:{allowedRoots:[root],maxReadBytes:524288,
      powerMode:{enabled:false,fullFilesystem:false}}};
  const nativeExec=(_file,args,_opts,callback)=>{
    const mode=args[args.indexOf('-Mode')+1];
    if(mode==='Snapshot')return callback(null,JSON.stringify({
      schema:1,ownerSid:OWNER_SID,sessionId:7,active:true,interactive:true
    })+'\n','');
    if(mode==='Consent'){
      state.consents++;
      return callback(null,JSON.stringify({approved:true})+'\n','');
    }
    return callback(Error('unknown fixture mode'),'','');
  };
  let runtime;
  try{
    runtime=createV012PrivateCoreRuntime({
      port:0,now:()=>now,
      identity:{
        hostId:'host-1',profileId:'emad',principalId:'account-1',
        expectedOwnerSidHash:ownerHash,expectedTunnelIdHash:tunnelHash,
        resolveTransportIdentity:async()=>({
          ...tdata(now),ownerSidHash:ownerHash,tunnelIdHash:tunnelHash
        })
      },
      tls:{certificatePem:f.serverCert,privateKeyPem:f.serverKey,
        clientCaPem:f.ca,expectedClientLeafDerSha256:f.clientSha},
      security:{
        directory:path.join(root,'owner-grants'),
        issuer:'commander.local',audience:'remote-commander',
        resolveOwnerRoute:async handle=>route(handle),
        bindWorkerToNativeOwner:({ownerStack,identity})=>{
          assert.equal(ownerStack.nativeSessionBindings.size,0);
          assert.equal(typeof ownerStack.grantRegistry.readWorkerGrant,'function');
          assert.equal(identity.hostId,'host-1');
          assert.equal(identity.profileId,'emad');
          assert.equal(identity.expectedTunnelIdHash,tunnelHash);
          // Trust only the same native owner and bootstrap-provided grants.
          return {
            resolveTrustedToolRoute:async({nativeRoute})=>({
              ...nativeRoute,operationId:'read-1'
            }),
            resolveCurrentOwnerRoute:async owner=>{
              // The same native J01 state established by HTTPS owner binding.
              const current=await ownerStack.nativeSessionBindings
                .resolveNativeRoute(owner.conversationId);
              assert.equal(current.conversationId,owner.conversationId);
              return liveRoute(current.conversationId);
            },
            resolveCurrentWorkerId:async owner=>{
              if(state.worker?.claims?.bindingId!==owner.bindingId){
                const claims={
                  issuer:'commander.local',audience:'remote-commander',
                  hostId:'host-1',profileId:'emad',principalId:'account-1',
                  conversationId:owner.conversationId,bindingId:owner.bindingId,
                  workerId,ownerSidHash:ownerHash,deviceProvider:'native-key-store',
                  deviceIdHash:'d'.repeat(64),
                  tunnelProvider:'openai-secure-mcp-tunnel',tunnelIdHash:tunnelHash,
                  capabilityPolicyDigest:policy,grantRevision:1,
                  issuedAtMs:now-1000,expiresAtMs:now+60000,
                  nonce:'f'.repeat(32)
                };
                const bytes=Buffer.from(JSON.stringify([
                  'commander.worker.identity.v1',keyId,
                  ...fields.map(field=>claims[field])
                ]));
                state.worker={schema:1,keyId,publicKey:der.toString('base64url'),
                  claims,signature:sign(null,bytes,privateKey).toString('base64url')};
              }
              return workerId;
            },
            workerRegistry:{get:async()=>state.worker},
            workerAuthority:{authorizeWorker:async({workerId:id,invocation})=>{
              if(!state.allow||id!==workerId||invocation.tool!=='read_text'
                ||invocation.arguments.path!==approved)return null;
              const claims=state.worker.claims;
              return {authorized:true,workerId,keyId,bindingId:claims.bindingId,
                capabilityPolicyDigest:policy,grantRevision:1,
                expiresAtMs:claims.expiresAtMs};
            }},
            // Disposable one-file QA only; production supplies a machine-global lease.
            withLease:async(_resource,work)=>work(),receiptStore,
          };
        },
        ownerSessionOptions:{
          platform:'win32',
          powershell:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          script:'C:\\Commander\\src\\native-owner-session-windows.ps1',
          execFileImpl:nativeExec,verifyFile:()=>{},
          snapshotTimeoutMs:1000,dialogTimeoutMs:5000
        }
      },
      core:{
        catalog:[{name:'read_text',description:'Real Core readText',
          inputSchema:{type:'object',additionalProperties:false,
            required:['path'],properties:{path:{type:'string',minLength:1}}}}],
        dispatch:async(name,args)=>{
          assert.equal(name,'read_text');
          state.effects++;
          return readText(context,args);
        }
      }
    });
    assert.equal(runtime.status.phase,'CONSTRUCTED');
    const live=await runtime.start();
    const send=(id,name,args)=>privatePairRequest(live.port,
      f.clientCert,f.clientKey,{jsonrpc:'2.0',id,method:'tools/call',
        params:{name,arguments:args}}, {},f.ca);
    const before=await send(1,'read_text',{path:approved});
    assert.equal(before.status,503);
    assert.equal(state.effects,0);
    const bound=await send(2,'v2_private_owner_bind',{});
    assert.equal(bound.status,200);
    assert.equal(state.consents,1);
    const first=await send(3,'read_text',{path:approved});
    assert.equal(first.status,200);
    assert.equal(first.body.result.isError,false);
    assert.equal(JSON.parse(first.body.result.content[0].text).text,
      'private-core-composition-verified\n');
    assert.equal(state.effects,1);
    const replay=await send(4,'read_text',{path:approved});
    assert.equal(replay.status,200);
    assert.equal(state.effects,1,'same operation must be at-most-once');
    state.allow=false;
    const revoked=await send(5,'read_text',{path:approved});
    assert.equal(revoked.status,503);
    assert.equal(state.effects,1);
    assert.equal(runtime.status.releaseAccepted,false);
  }finally{
    await runtime?.close();
    receiptStore.close();
    f.dispose();
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('real full-catalog 0.12 owner-local protected boot stays fail-closed without native grants',{
  timeout:30000
},async t=>{
  // Probe a real interactive WTS seat from this test process. The
  // standard-user isolated updater may deliberately drop GitHub environment
  // flags, so environment variables cannot classify headless CI reliably.
  let nativeWindowsSeatAvailable=true;
  if(process.platform==='win32'){
    try{await createWindowsNativeOwnerSessionProvider().getOwnerSessionSnapshot();}
    catch{nativeWindowsSeatAvailable=false;}
  }
  let f;
  try{f=fixture();}catch{return t.skip('OpenSSL fixture generator unavailable');}
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc012-real-core-tls-ci-'));
  try{
    fs.chmodSync(dir,0o700);
    const data={
      'ca.crt':f.ca,'server.crt':f.serverCert,
      'server.key':f.serverKey,'client.crt':f.clientCert,
      'client.key':f.clientKey
    };
    for(const [name,value] of Object.entries(data))
      fs.writeFileSync(path.join(dir,name),value,{mode:0o600});
    const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
    const result=spawnSync(process.execPath,[
      path.join(root,'tools/owner-pair-private-source-canary.mjs'),dir
    ],{cwd:root,encoding:'utf8',windowsHide:true,timeout:20000,
      maxBuffer:8192});
    assert.equal(result.error,undefined,result.error?.message);
    // A Windows process without an OS-confirmed interactive WTS seat MUST
    // reject native J01 bootstrap before any private tool can run. This is a
    // negative host acceptance test, never a simulated owner grant.
    const headlessWindows=process.platform==='win32'
      &&!nativeWindowsSeatAvailable
      &&result.status!==0;
    if(headlessWindows){
      assert.equal(result.status,1);
      assert.equal((result.stderr||'').trim(),
        'RC012_PROTECTED_INGRESS_FAILED_NATIVE_OWNER_WINDOWS_SNAPSHOT_FAILED');
      assert.equal((result.stdout||'').trim(),'');
      return;
    }
    assert.equal(result.status,0,(result.stderr||'').slice(-1024));
    const proof=JSON.parse((result.stdout||'').trim());
    assert.equal(proof.result,'RC012_OWNER_LOCAL_PROTECTED_SOURCE_CANARY_PASS');
    assert.equal(proof.version,'0.12.0-dev.9');
    assert.equal(proof.protectedIngressWired,true);
    assert.equal(proof.protectedIngressReady,false);
    assert.equal(proof.tlsClientAuthenticated,true);
    assert.equal(proof.anonymousClientDenied,true);
    assert.equal(proof.legacyHttpQuarantined,true);
    assert.equal(proof.nativeGrantIssued,false);
    assert.equal(proof.existingTunnelChanged,false);
    assert.equal(proof.installedCoreChanged,false);
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
    f.dispose();
  }
});
