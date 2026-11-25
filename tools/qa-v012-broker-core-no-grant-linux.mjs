// Staged source acceptance only: uses the INSTALLED v0.12 private Core runtime
// and a short-lived owner-signed broker to prove HTTPS/mTLS LIST vs DENY.
// Opt-in owner-visible native J01 is permitted, but NO signed Worker, tool
// route, privileged effect or live service/tunnel can be granted or changed.
import fs from 'node:fs';
import https from 'node:https';
import {createHash} from 'node:crypto';
import {createOwnerPrivatePairBootstrap}
  from '../src/rc012-owner-enrolled-no-grant-bootstrap-linux.mjs';
import {createV012PrivateCoreRuntime}
  from '/usr/lib/chatgpt-remote-commander/app/src/v012-private-core-runtime.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
function post({port,ca,cert,key,method,name,timeoutMs=5000}){
  return new Promise(resolve=>{
    const req=https.request({
      host:'127.0.0.1',port,path:'/mcp',method:'POST',
      ca,cert,key,rejectUnauthorized:true,minVersion:'TLSv1.3',
      maxVersion:'TLSv1.3',timeout:timeoutMs,
      headers:{'content-type':'application/json'}
    },res=>{
      let bytes=0,body='';
      const result={kind:'http',status:res.statusCode,
        authorized:res.socket.authorized===true,
        protocol:res.socket.getProtocol()};
      res.on('data',c=>{bytes+=c.length;if(bytes<=1024)body+=c;});
      res.on('end',()=>resolve({...result,errorCode:body.includes('private_session_required')
        ?'PRIVATE_SESSION_REQUIRED':body.includes('trusted_transport_required')
        ?'TRUSTED_TRANSPORT_REQUIRED':body.includes('private_owner_admission_unavailable')
        ?'PRIVATE_OWNER_ADMISSION_UNAVAILABLE':null}));
    });
    req.on('error',e=>resolve({kind:'error',code:e.code??'SSL_ERROR'}));
    req.on('timeout',()=>req.destroy(Error('TIMEOUT')));
    req.end(JSON.stringify({
      jsonrpc:'2.0',id:1,method,
      params:method==='tools/call'?{name,arguments:{}}:{}
    }));
  });
}
async function main(){
  if(process.platform!=='linux'
    ||process.env.RC012_CORE_BROKER_QA_SCOPE!=='NO_EFFECTS')
    fail('RC012_PRIVATE_CORE_QA_SCOPE_REQUIRED');
  const raw=fs.readFileSync(process.env.REMOTE_COMMANDER_CONFIG);
  const configSha256=createHash('sha256').update(raw).digest('hex');
  const profile=JSON.parse(raw).instance.profile;
  const opts=await createOwnerPrivatePairBootstrap({profileId:profile,configSha256});
  const before=await opts.identity.resolveTransportIdentity();
  if(before.authenticated!==true
    ||before.tunnelIdHash!==opts.identity.expectedTunnelIdHash)
    fail('RC012_PRIVATE_CORE_QA_BROKER_NOT_VERIFIED');
  const denied=async()=>fail('RC012_OWNER_BOOTSTRAP_NO_GRANT');
  const name='qa_never_executed';
  const core={catalog:[{name,
    description:'No-grant read-only private Core TLS integration test.',
    inputSchema:{type:'object',properties:{},additionalProperties:false}
  }],dispatch:denied};
  const security={...opts.security,receiptStore:{execute:denied}};
  const runtime=createV012PrivateCoreRuntime({...opts,core,security});
  const dir=process.env.RC012_OWNER_PAIR_DIR;
  const ca=fs.readFileSync(dir+'/ca.crt'),
    cert=fs.readFileSync(dir+'/client.crt'),
    key=fs.readFileSync(dir+'/client.key');
  try{
    const status=await runtime.start();
    if(status.phase!=='LISTENING'||status.port!==opts.port
      ||status.fullAccessActive!==false
      ||status.authenticatedCurrentChatAccepted!==false)
      fail('RC012_PRIVATE_CORE_QA_LISTENER_NOT_RESTRICTED');
    const list=await post({port:opts.port,ca,cert,key,method:'tools/list'});
    const call=await post({port:opts.port,ca,cert,key,method:'tools/call',name});
    const anonymous=await post({port:opts.port,ca,method:'tools/list'});
    console.log('RC012_CORE_QA_OBSERVED',JSON.stringify({list,call,anonymous}));
    if(list.kind!=='http'||list.status!==200
      ||list.authorized!==true||list.protocol!=='TLSv1.3'
      ||call.kind!=='http'
      ||!((call.status===403&&call.errorCode==='PRIVATE_SESSION_REQUIRED')
        ||(call.status===503&&call.errorCode==='PRIVATE_OWNER_ADMISSION_UNAVAILABLE'))
      ||(anonymous.kind==='http'&&anonymous.status<400))
      fail('RC012_PRIVATE_CORE_QA_AUTH_DENIAL_MISMATCH');
    // Explicit one-time owner-visible diagnostic; no prompt by default.
    if(process.env.RC012_CORE_BROKER_J01_BIND_REQUEST==='OWNER_VISIBLE_J01_BIND_ONLY'){
      const bind=await post({port:opts.port,ca,cert,key,
        method:'tools/call',name:'v2_private_owner_bind',timeoutMs:40000});
      console.log('RC012_NATIVE_OWNER_J01_PAIR_BIND_PROBE',JSON.stringify({
        status:bind.kind==='http'?bind.status:null,
        tlsAuthorized:bind.authorized===true,
        pairScopeOnly:true,workerGrantIssued:false,coreToolDispatched:false
      }));
      if(bind.kind!=='http'||bind.status!==200||bind.authorized!==true)
        fail('RC012_NATIVE_OWNER_J01_NOT_APPROVED');
      const afterBind=await post({port:opts.port,ca,cert,key,
        method:'tools/call',name});
      if(afterBind.kind!=='http'||afterBind.status!==503
        ||afterBind.errorCode!=='PRIVATE_OWNER_ADMISSION_UNAVAILABLE')
        fail('RC012_NATIVE_OWNER_J01_BYPASSED_NO_GRANT');
    }
    try{await opts.security.withLease();fail('RC012_UNEXPECTED_GRANT');}
    catch(e){if(e.code!=='RC012_OWNER_BOOTSTRAP_NO_GRANT')throw e;}
    console.log(JSON.stringify({
      result:'RC012_ACTUAL_V012_PRIVATE_CORE_TLS_NO_GRANT_PASS',
      profileId:profile,port:opts.port,
      discoveryStatus:list.status,
      deniedToolStatus:call.status,denial:call.errorCode,
      unauthorizedClient:anonymous.kind,
      tls:list.protocol,fullAccessActive:false,
      workerGrantIssued:false,installedCoreToolDispatched:false
    }));
  }finally{await runtime.close();}
}
main().catch(e=>{
  console.error(e.code??'RC012_PRIVATE_CORE_QA_FAILED');
  process.exitCode=2;
});
