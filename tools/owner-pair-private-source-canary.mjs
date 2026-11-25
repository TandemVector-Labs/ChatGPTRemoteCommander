// Real owner-local v0.12 HTTPS/mTLS canary, never a live Tunnel rebind.
// The candidate boots the actual Core with the installed owner's staged certs.
// Crucially, it intentionally has NO signed Worker or J01 grant; tool admission
// must remain closed. Secrets never enter project files, output or fixtures.
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import net from 'node:net';
import https from 'node:https';
import {X509Certificate,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createWindowsNativeOwnerSessionProvider}
  from '../src/native-owner-session-provider-windows.mjs';
import {createLinuxNativeOwnerSessionProvider}
  from '../src/native-owner-session-provider-linux.mjs';

const file=fileURLToPath(import.meta.url);
const root=path.resolve(path.dirname(file),'..');
const fail=code=>{throw Object.assign(new Error(code),{code});};
function ownerProvider(){
  if(process.platform==='win32')return createWindowsNativeOwnerSessionProvider();
  if(process.platform==='linux')return createLinuxNativeOwnerSessionProvider();
  fail('RC012_PROTECTED_CANARY_OS_UNSUPPORTED');
}
function validPath(v){
  return typeof v==='string'&&path.isAbsolute(v)&&!v.includes('\0');
}
async function configState(){
  if(process.env.RC012_PROTECTED_CANARY_SCOPE!=='OWNER_LOCAL_NO_GRANT'
     ||!validPath(process.env.RC012_PROTECTED_CANARY_STATE))
    fail('RC012_PROTECTED_CANARY_SCOPE_REQUIRED');
  const parsed=JSON.parse(await readFile(process.env.RC012_PROTECTED_CANARY_STATE,'utf8'));
  if(!Number.isInteger(parsed.tlsPort)||parsed.tlsPort<1024||parsed.tlsPort>65535
    ||!validPath(parsed.ownerCertDir)||!validPath(parsed.securityDir)
    ||!validPath(parsed.temporaryRoot))
    fail('RC012_PROTECTED_CANARY_STATE_INVALID');
  return parsed;
}
// Dynamically imported by src/server-v0.3.mjs only when explicitly selected
// by the temporary owner-controlled test child process.
export async function createOwnerPrivatePairBootstrap({profileId}={}){
  const s=await configState();
  const [certificatePem,privateKeyPem,clientCaPem,clientPem]=await Promise.all([
    readFile(path.join(s.ownerCertDir,'server.crt'),'utf8'),
    readFile(path.join(s.ownerCertDir,'server.key'),'utf8'),
    readFile(path.join(s.ownerCertDir,'ca.crt'),'utf8'),
    readFile(path.join(s.ownerCertDir,'client.crt'),'utf8')
  ]);
  const expectedClientLeafDerSha256=createHash('sha256')
    .update(new X509Certificate(clientPem).raw).digest('hex');
  const expectedOwnerSidHash=await ownerProvider().resolveOwnerSidHash();
  const hostId='qa-local-core',principalId='qa-private-local',dummyTunnelHash='a'.repeat(64);
  // All callbacks that would authorize actions are deliberately fail-closed.
  const denied=async()=>fail('RC012_NO_OWNER_WORKER_GRANT_IN_CANARY');
  return {
    port:s.tlsPort,
    identity:{
      hostId,profileId,principalId,
      expectedTunnelIdHash:dummyTunnelHash,expectedOwnerSidHash,
      resolveTransportIdentity:async()=>null
    },
    tls:{certificatePem,privateKeyPem,clientCaPem,expectedClientLeafDerSha256},
    security:{
      directory:s.securityDir,issuer:'commander.local',
      audience:'remote-commander',
      resolveOwnerRoute:denied,
      resolveTrustedToolRoute:denied,
      resolveCurrentOwnerRoute:denied,
      resolveCurrentWorkerId:denied,
      workerAuthority:{authorizeWorker:async()=>null},
      workerRegistry:{get:async()=>null},
      withLease:denied
    }
  };
}
async function freePort(){
  return new Promise((resolve,reject)=>{
    const socket=net.createServer();
    socket.once('error',reject);
    socket.listen(0,'127.0.0.1',()=>{
      const port=socket.address().port;
      socket.close(error=>error?reject(error):resolve(port));
    });
  });
}
async function probeTls(port,ownerCertDir,withClient=true){
  const ca=await readFile(path.join(ownerCertDir,'ca.crt'));
  const credentials=withClient?{
    cert:await readFile(path.join(ownerCertDir,'client.crt')),
    key:await readFile(path.join(ownerCertDir,'client.key'))
  }:{};
  return new Promise(resolve=>{
    const req=https.request({
      host:'127.0.0.1',port,path:'/mcp',method:'POST',minVersion:'TLSv1.3',
      ca,...credentials,
      headers:{'content-type':'application/json'}
    },res=>{
      const tlsAuthorized=res.socket?.authorized===true;
      const chunks=[];
      res.on('data',c=>chunks.push(c));
      res.on('end',()=>resolve({connected:true,tlsAuthorized,status:res.statusCode,
        body:Buffer.concat(chunks).toString().slice(0,4096)}));
    });
    req.setTimeout(3500,()=>req.destroy());
    req.on('error',()=>resolve({connected:false,tlsAuthorized:false}));
    req.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}}));
  });
}
async function main(){
  if(process.argv.length!==3||!validPath(process.argv[2]))
    fail('RC012_OWNER_CERT_DIR_REQUIRED');
  const temp=await mkdtemp(path.join(os.tmpdir(),'rc012-real-protected-core-'));
  const tlsPort=await freePort();
  let plainPort=await freePort();
  while(tlsPort===plainPort)plainPort=await freePort();
  const securityDir=path.join(temp,'native-security');
  let child,stderr='',removed=false;
  try{
    await import('node:fs/promises').then(({mkdir})=>mkdir(securityDir,{mode:0o700}));
    const ownerCertDir=process.argv[2];
    const ownerStat=await import('node:fs/promises').then(({lstat})=>lstat(ownerCertDir));
    if(!ownerStat.isDirectory()||ownerStat.isSymbolicLink())
      fail('RC012_PROTECTED_OWNER_CERT_DIRECTORY_UNSAFE');
    const state=path.join(temp,'state.json'),configPath=path.join(temp,'config.json');
    await writeFile(state,JSON.stringify({tlsPort,ownerCertDir,securityDir,
      temporaryRoot:temp}),{mode:0o600});
    const config=JSON.parse(await readFile(path.join(root,'config.json'),'utf8'));
    config.host='127.0.0.1';
    config.port=plainPort;
    config.allowedRoots=[temp];
    config.auditLog=path.join(temp,'audit.jsonl');
    config.capabilityProfile={
      schemaVersion:4,id:'qa-owner-private',tier:'FULL_POWER',
      explicitlyAuthorized:true,persistAcrossUpdates:false,
      autoEnableNewCapabilities:false,disabledCapabilities:[],source:'local-test'
    };
    config.powerMode={...config.powerMode,enabled:true,fullFilesystem:true,
      allowShell:true,allowProcessControl:true,allowPermanentDelete:false,
      guiControl:{...config.powerMode.guiControl,enabled:true},
      browserControl:{...config.powerMode.browserControl,enabled:true}};
    config.requireTrustedIngress=true;
    config.trustedIngressConfigured=false;
    config.autoUpdate={...config.autoUpdate,enabled:false};
    config.durableWorkflows={...config.durableWorkflows,enabled:false};
    await writeFile(configPath,JSON.stringify(config),{mode:0o600});
    child=spawn(process.execPath,[path.join(root,'src','server-v0.3.mjs')],{
      cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe'],
      env:{...process.env,REMOTE_COMMANDER_CONFIG:configPath,
        REMOTE_COMMANDER_PRIVATE_BOOTSTRAP_MODULE:file,
        RC012_PROTECTED_CANARY_SCOPE:'OWNER_LOCAL_NO_GRANT',
        RC012_PROTECTED_CANARY_STATE:state}
    });
    child.stderr.on('data',c=>stderr=(stderr+c.toString()).slice(-700));
    let health=null;
    for(let i=0;i<100;i++){
      if(child.exitCode!==null)fail('RC012_PROTECTED_CORE_CHILD_EXITED');
      try{
        const res=await fetch('http://127.0.0.1:'+plainPort+'/health',
          {signal:AbortSignal.timeout(300)});
        if(res.ok){health=await res.json();if(health.protectedIngress?.wired)break;}
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!health?.protectedIngress?.wired)
      fail('RC012_PROTECTED_INGRESS_FAILED_'+String(health?.protectedIngress?.code??'UNAVAILABLE'));
    assert.equal(health.version,'0.12.0-dev.9');
    assert.equal(health.protectedIngress.ready,false);
    assert.equal(health.privilegedLegacyHttpQuarantined,true);
    const old=await fetch('http://127.0.0.1:'+plainPort+'/mcp',{
      method:'POST',headers:{'content-type':'application/json'},
      body:'{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      signal:AbortSignal.timeout(2500)
    });
    assert.equal(old.status,403);
    const tlsWithClient=await probeTls(tlsPort,ownerCertDir,true);
    const tlsAnonymous=await probeTls(tlsPort,ownerCertDir,false);
    assert.equal(tlsWithClient.connected,true);
    assert.equal(tlsWithClient.tlsAuthorized,true);
    assert.notEqual(tlsWithClient.status,200,'No native J01/Worker grant was issued');
    assert.notEqual(tlsAnonymous.status,200,'Uncredentialed client must never be accepted');
    process.stdout.write(JSON.stringify({
      result:'RC012_OWNER_LOCAL_PROTECTED_SOURCE_CANARY_PASS',
      version:health.version,configuredAccess:health.access?.configuredTier,
      effectiveAccess:health.access?.effectiveTier,
      protectedIngressWired:true,protectedIngressReady:false,
      tlsClientAuthenticated:true,anonymousClientDenied:true,
      legacyHttpQuarantined:true,nativeGrantIssued:false,
      existingTunnelChanged:false,installedCoreChanged:false
    })+'\n');
  }finally{
    if(child&&child.exitCode===null){
      const stopped=new Promise(resolve=>child.once('exit',resolve));
      child.kill();
      await Promise.race([stopped,new Promise(resolve=>setTimeout(resolve,3000))]);
    }
    await rm(temp,{recursive:true,force:true});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===file)
  main().catch(error=>{
    console.error(error?.code??'RC012_PROTECTED_CANARY_FAILED');
    process.exitCode=1;
  });
