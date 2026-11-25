/**
 * V1-01 G1 installed-readiness probe: loopback-only, read-only, no credentials.
 * Never starts/stops services or reports production authorization.
 * Run on the intended host: node tools/v1-01/installed-g1-readonly-probe.mjs --port=48834
 */
import http from 'node:http';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const MAX_RESPONSE_BYTES=8192;
const MAX_TIMEOUT_MS=3000;
const RPC=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}});
const HTTP_JSON=/^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const REQUIRED=['health','legacyAnonymous','legacyForged','v2Anonymous','v2Forged','metadata'];
const RESULT_BASE=Object.freeze({
  gate:'V101_INSTALLED_G1_INGRESS_PREFLIGHT',
  authenticatedCallerProved:false,
  signedChatIdentityProved:false,
  nativeOwnerGrantProved:false,
  authorizedEffectProved:false,
  rollbackProved:false,
  productionReleaseAuthorized:false,
  operationalFullAccessProved:false
});

export function parsePortArgs(args){
  if(!Array.isArray(args)||args.length!==1||typeof args[0]!=='string'
     ||!/^--port=[1-9][0-9]{0,4}$/.test(args[0]))
    throw Error('EXACT_LOOPBACK_PORT_REQUIRED');
  const port=Number(args[0].slice(7));
  if(!Number.isSafeInteger(port)||port<1024||port>65535)
    throw Error('PORT_SCOPE_INVALID');
  return port;
}

export function classifyInstalledIngress(observations){
  const failure=code=>({...RESULT_BASE,status:'BLOCKED',code});
  if(!observations||typeof observations!=='object'||Array.isArray(observations)
    ||REQUIRED.some(k=>!Object.hasOwn(observations,k)))
    return failure('OBSERVATIONS_INCOMPLETE');
  const o=observations;
  if(o.health?.status!==200) return failure('EXPECTED_HEALTH_UNAVAILABLE');
  const validDenied=r=>r?.status===403&&r.json===true
    &&r.noStore===true&&r.body?.error==='trusted_transport_required';
  const legacyRetired=o.legacyAnonymous?.status===404&&o.legacyForged?.status===404;
  const legacyDenied=validDenied(o.legacyAnonymous)&&validDenied(o.legacyForged);
  // Anonymous tool enumeration is a security failure, even when file_info is denied.
  if([o.legacyAnonymous,o.legacyForged].some(r=>r?.status===200))
    return failure('LEGACY_ANONYMOUS_DISCOVERY_EXPOSED');
  if(!legacyDenied&&!legacyRetired)
    return failure('LEGACY_NEGATIVE_ADMISSION_UNPROVED');
  if(o.metadata?.status===404||o.v2Anonymous?.status===404)
    return failure('V2_AUTHENTICATED_INGRESS_ABSENT');
  if(o.metadata?.status!==200||!o.metadata.json||!validMetadata(o.metadata.body))
    return failure('V2_RESOURCE_METADATA_UNVERIFIED');
  if(!validDenied(o.v2Anonymous)||!validDenied(o.v2Forged))
    return failure('V2_NEGATIVE_ADMISSION_UNPROVED');
  return {...RESULT_BASE,status:'NEGATIVE_PREFLIGHT_PASS',
    code:'ANONYMOUS_AND_FORGED_DENIAL_ONLY',
    legacyMode:legacyRetired?'retired':'quarantined'};
}

function validMetadata(m){
  if(!m||typeof m!=='object'||Array.isArray(m))return false;
  if(typeof m.resource!=='string')return false;
  try{
    const r=new URL(m.resource);
    if(r.protocol!=='https:'||!r.hostname||r.pathname!=='/mcp-v2'
      ||r.search||r.hash||r.username||r.password)return false;
    return Array.isArray(m.authorization_servers)
      &&m.authorization_servers.length>0&&m.authorization_servers.length<=16
      &&m.authorization_servers.every(x=>{
        if(typeof x!=='string')return false;
        try{
          const u=new URL(x);
          return u.protocol==='https:'&&!!u.hostname&&
            !u.username&&!u.password&&!u.hash;
        }catch{return false;}
      });
  }catch{return false;}
}

export function observeLocalHttp({port,pathname,method='GET',forged=false,timeoutMs=1500}){
  if(!Number.isSafeInteger(port)||port<1024||port>65535
    ||!['/health','/mcp','/mcp-v2',
      '/.well-known/oauth-protected-resource/mcp-v2'].includes(pathname)
    ||!['GET','POST'].includes(method)
    ||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>MAX_TIMEOUT_MS)
    throw Error('PROBE_SCOPE_INVALID');
  const body=method==='POST'?Buffer.from(RPC):null;
  return new Promise(resolve=>{
    let completed=false,bytes=0;
    const finish=(observation)=>{
      if(completed)return;
      completed=true;
      resolve(observation);
    };
    const req=http.request({
      hostname:'127.0.0.1',family:4,port,path:pathname,method,
      timeout:timeoutMs,
      headers:{
        'host':'127.0.0.1:'+port,
        ...(body?{'content-type':'application/json',
          'content-length':String(body.length)}:{}),
        ...(forged?{
          authorization:'Bearer '+'deliberately-invalid-g1-probe',
          'x-mtls-verified':'true','x-chat-id':'forged-g1-probe'
        }:{})
      }
    },res=>{
      let overLimit=false;
      const chunks=[];
      res.on('data',chunk=>{
        bytes+=chunk.length;
        if(bytes>MAX_RESPONSE_BYTES){
          // A large unauthenticated tools/list body is not "unknown":
          // preserve its HTTP status, discard contents, and flag exposure.
          // Never copy the potentially sensitive response into evidence.
          overLimit=true;
          finish({status:res.statusCode,error:'RESPONSE_TOO_LARGE'});
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end',()=>{
        if(overLimit)return finish({status:null,error:'RESPONSE_TOO_LARGE'});
        const contentType=String(res.headers['content-type']??'');
        const json=HTTP_JSON.test(contentType);
        let parsed=null;
        if(json){
          try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
          catch{ /* invalid response cannot count as a verified denial */ }
        }
        const noStore=String(res.headers['cache-control']??'')
          .split(',').map(x=>x.trim().toLowerCase()).includes('no-store');
        // Never return arbitrary response content, headers or credentials.
        let bodyShape=null;
        if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)){
          if(pathname==='/mcp'||pathname==='/mcp-v2'){
            bodyShape={error:parsed.error};
          }else if(pathname.endsWith('/mcp-v2')){
            bodyShape={resource:parsed.resource,
              authorization_servers:parsed.authorization_servers};
          }
        }
        finish({status:res.statusCode,json,noStore,body:bodyShape});
      });
      res.on('error',()=>finish({status:null,error:'RESPONSE_INTERRUPTED'}));
    });
    req.on('timeout',()=>req.destroy(new Error('timeout')));
    req.on('error',()=>finish({status:null,error:'CONNECTION_UNAVAILABLE'}));
    if(body)req.end(body);
    else req.end();
  });
}

export async function probeInstalledG1(port,options={}){
  const request=options.request??observeLocalHttp;
  if(typeof request!=='function'||!Number.isSafeInteger(port)||port<1024||port>65535)
    throw Error('PROBE_SCOPE_INVALID');
  // Sequential, bounded, and effect-free: only tools/list (no tools/call).
  const specs={
    health:{pathname:'/health'},
    legacyAnonymous:{pathname:'/mcp',method:'POST'},
    legacyForged:{pathname:'/mcp',method:'POST',forged:true},
    v2Anonymous:{pathname:'/mcp-v2',method:'POST'},
    v2Forged:{pathname:'/mcp-v2',method:'POST',forged:true},
    metadata:{pathname:'/.well-known/oauth-protected-resource/mcp-v2'}
  };
  const observations={};
  for(const key of REQUIRED){
    try{observations[key]=await request({port,...specs[key]});}
    catch{observations[key]={status:null,error:'PROBE_FAILED'};}
  }
  return {port,observations: Object.fromEntries(REQUIRED.map(key=>
      [key,{status:observations[key]?.status??null}])),
    ...classifyInstalledIngress(observations)};
}

export async function main(args=process.argv.slice(2)){
  try{
    const result=await probeInstalledG1(parsePortArgs(args));
    process.stdout.write(JSON.stringify(result)+'\n');
    return result.status==='NEGATIVE_PREFLIGHT_PASS'?0:3;
  }catch{
    process.stdout.write(JSON.stringify({...RESULT_BASE,
      status:'BLOCKED',code:'PROBE_ARGUMENT_OR_INTERNAL_ERROR'})+'\n');
    return 2;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)
  process.exitCode=await main();
