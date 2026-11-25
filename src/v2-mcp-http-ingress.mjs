// V2-G1 candidate HTTP ingress for the existing MCP/WorkflowStore dispatcher.
// This is NOT wired to the live V1 listener. Importing it opens no port.
// The caller must supply a trusted transport attestor and protected dispatcher.
// In owner-admission mode, direct mTLS plus a bearer digest and the documented
// openai/session correlator produce a one-shot in-process capability; the dispatcher
// verifies OAuth and the canonical route before requesting native owner consent.
// NEVER treat user JSON, x-chat-id headers, or openai/session alone as identity proof.
import http from 'node:http';
import https from 'node:https';
import {createHash} from 'node:crypto';
import { createV2ProtectedResourceMetadata } from './v2-oauth-resource-metadata.mjs';
import { createV2DirectMtlsTransportAttestor } from './v2-direct-mtls-attestor.mjs';
import { createV2OpenAiClientTlsOptions, V2_OPENAI_CONNECTORS_CA_PIN } from './v2-openai-mtls-trust.mjs';

const ERROR_HEADERS=Object.freeze({
  'cache-control':'no-store','content-type':'application/json; charset=utf-8'
});
const SESSION=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LEGACY=new Set(['2025-11-25','2025-06-18','2025-03-26']);
function fail(code){throw Object.assign(new Error(code),{code});}
function record(v){return v!==null&&typeof v==='object'&&!Array.isArray(v)
  &&[Object.prototype,null].includes(Object.getPrototypeOf(v));}
function headerValues(req,name){
  const raw=req.rawHeaders;
  if(!Array.isArray(raw)||raw.length%2!==0)fail('V2_HTTP_RAW_HEADERS_INVALID');
  const found=[];
  for(let i=0;i<raw.length;i+=2){
    if(typeof raw[i]!=='string'||typeof raw[i+1]!=='string')fail('V2_HTTP_RAW_HEADERS_INVALID');
    if(raw[i].toLowerCase()===name)found.push(raw[i+1]);
  }
  if(found.length>1)fail('V2_HTTP_DUPLICATE_HEADER');
  return found[0]??null;
}
function json(res,status,body,headers={}){
  const encoded=Buffer.from(JSON.stringify(body));
  res.writeHead(status,{...ERROR_HEADERS,'content-length':encoded.length,...headers});
  res.end(encoded);
}
async function boundedJson(req,maxBodyBytes){
  const length=req.headers['content-length'];
  if(length!==undefined){
    if(typeof length!=='string'||!/^\d{1,12}$/.test(length)
      ||Number(length)>maxBodyBytes)fail('V2_HTTP_BODY_TOO_LARGE');
  }
  const contentType=headerValues(req,'content-type');
  if(contentType===null||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType))
    fail('V2_HTTP_CONTENT_TYPE_REQUIRED');
  let total=0;const chunks=[];
  for await (const chunk of req){
    total+=chunk.length;
    if(total>maxBodyBytes)fail('V2_HTTP_BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if(total===0)fail('V2_HTTP_BODY_MALFORMED');
  try{
    const obj=JSON.parse(Buffer.concat(chunks,total).toString('utf8'));
    if(!record(obj))fail('V2_HTTP_BODY_MALFORMED');
    return obj;
  }catch{fail('V2_HTTP_BODY_MALFORMED');}
}
/** Build but do not start an isolated candidate HTTP listener. */
export function createV2CandidateHttpIngress({
  resource,authorizationServers,scopes=['commander.workflow'],
  attestTransport,dispatcherFactory,platformSessionProofAuthority,maxBodyBytes=65536
}){
  if(typeof attestTransport!=='function'||typeof dispatcherFactory!=='function')
    fail('V2_HTTP_TRUSTED_BOOTSTRAP_REQUIRED');
  if(platformSessionProofAuthority!==undefined
    &&typeof platformSessionProofAuthority?.issue!=='function')
    fail('V2_HTTP_PLATFORM_PROOF_AUTHORITY_REQUIRED');
  if(!Number.isSafeInteger(maxBodyBytes)||maxBodyBytes<1024||maxBodyBytes>262144)
    fail('V2_HTTP_BODY_LIMIT_INVALID');
  const discovery=createV2ProtectedResourceMetadata({resource,authorizationServers,scopes});
  const rpcPath=new URL(resource).pathname;
  async function handle(req,res){
    try{
      // A direct-origin request target must not be a proxy-style absolute URL.
      if(typeof req.url!=='string'||!req.url.startsWith('/')||req.url.startsWith('//')){
        json(res,400,{error:'invalid_request_target'});return;
      }
      const fullUrl=new URL(req.url,'http://127.0.0.1');
      if(fullUrl.search||fullUrl.hash||!fullUrl.pathname.startsWith('/')){
        json(res,404,{error:'not_found'});return;
      }
      if(req.method==='GET'&&fullUrl.pathname===discovery.metadataPath){
        json(res,200,discovery.body);return;
      }
      if(fullUrl.pathname!==rpcPath){
        json(res,404,{error:'not_found'});return;
      }
      if(req.method!=='POST'){
        json(res,405,{error:'method_not_allowed'},{allow:'POST'});return;
      }
      // All RPC requests require an authenticated transport. No source
      // headers may self-declare ChatGPT or an owner session.
      const attested=await attestTransport(req);
      // Distinct allowed transport modes:
      // 1. Native owner has already established a trusted session binding.
      // 2. Direct OpenAI mTLS or owner-pinned private tunnel-client mTLS
      //    with fresh native tunnel process verification.'s official client CA + SAN + EKU,
      //    allowing its documented tool-call metadata to name the namespace.
      const known=record(attested)&&attested.authenticated===true
        &&attested.sessionSource!=='openai/session'
        &&typeof attested.sessionHandle==='string'
        &&SESSION.test(attested.sessionHandle);
      const trustedMeta=record(attested)&&attested.authenticated===true
        &&['openai-chatgpt-mtls','openai-tunnel-client-mtls'].includes(attested.peerType)
        &&attested.sessionSource==='openai/session';
      if(!known&&!trustedMeta){
        json(res,403,{error:'trusted_transport_required'});return;
      }
      const authorization=headerValues(req,'authorization');
      const msg=await boundedJson(req,maxBodyBytes);
      const metaSession=msg.params?._meta?.['openai/session'];
      let sessionHandle;
      if(trustedMeta){
        // ChatGPT inserts openai/session into TOOL CALLS, not necessarily
        // initialize/list/discover. Discovery is never given execution rights.
        if(msg.method==='tools/call'){
          if(msg.params?.name==='v2_profile'&&metaSession===undefined){
            // ChatGPT may read the authenticated connection profile before it
            // has a conversation ID. Only the OAuth-verified read-only tool
            // may use this discovery namespace. Never allow workflow effects.
            sessionHandle='mcp-profile-only';
          }else{
            if(typeof metaSession!=='string'||!SESSION.test(metaSession)){
              json(res,403,{error:'platform_session_required'});return;
            }
            sessionHandle=metaSession;
          }
        }else{
          sessionHandle='mcp-discovery-only';
        }
      }else{
        // For a native trust source, optional metadata may corroborate but
        // never replace the independently authenticated session.
        if(metaSession!==undefined&&metaSession!==attested.sessionHandle){
          json(res,403,{error:'platform_session_mismatch'});return;
        }
        sessionHandle=attested.sessionHandle;
      }
      const version=msg.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
      const headerVersion=headerValues(req,'mcp-protocol-version');
      // Legacy clients may use a version HEADER without the newer body
      // metadata; modern clients must agree on version in both locations.
      if((version!==undefined&&version!==headerVersion)
        ||(version===undefined&&headerVersion!==null&&!LEGACY.has(headerVersion))){
        json(res,400,{error:'protocol_version_mismatch'});return;
      }
      if(version==='2026-07-28'){
        if(headerValues(req,'mcp-method')!==msg.method
          ||(msg.method==='tools/call'
             &&headerValues(req,'mcp-name')!==msg.params?.name)){
          json(res,400,{error:'protocol_method_mismatch'});return;
        }
      }
      // Trusted callback produces a preconfigured dispatcher bound to the
      // attested transport session from the server-side verification process.
      // Avoid giving it the raw user message or authorization header.
      // The OpenAI session field is only a conversation correlator, never
      // identity proof. Issue an in-process capability only after this request
      // has passed direct mTLS, carries that exact session, and has one bearer
      // token whose digest is bound to the owner-consent operation.
      let platformSessionProof;
      if(trustedMeta&&msg.method==='tools/call'
        &&msg.params?.name==='v2_workflow_step'
        &&sessionHandle===metaSession&&platformSessionProofAuthority){
        const bearer=/^Bearer ([A-Za-z0-9._~+\/=:-]{16,16384})$/.exec(authorization??'');
        if(bearer){
          platformSessionProof=platformSessionProofAuthority.issue({
            peerType:attested.peerType,sessionSource:attested.sessionSource,
            sessionHandle,tokenSha256:createHash('sha256').update(bearer[1]).digest('hex')
          });
        }
      }
      const dispatcher=await dispatcherFactory(Object.freeze({
        authenticated:true,sessionHandle,
        ...(platformSessionProof?{platformSessionProof}:{})
      }));
      if(!dispatcher||typeof dispatcher.handleRpc!=='function'
        ||dispatcher.protectedResource?.metadataUrl!==discovery.metadataUrl){
        json(res,503,{error:'trusted_dispatcher_unavailable'});return;
      }
      const reply=await dispatcher.handleRpc({authorization,message:msg});
      if(reply===null){res.writeHead(202,{'cache-control':'no-store'});res.end();return;}
      json(res,200,reply);
    }catch(error){
      const code=error?.code;
      if(code==='V2_HTTP_BODY_TOO_LARGE'){json(res,413,{error:'request_too_large'});return;}
      if(code==='V2_HTTP_CONTENT_TYPE_REQUIRED'){json(res,415,{error:'unsupported_media_type'});return;}
      if(code==='V2_HTTP_DUPLICATE_HEADER'){json(res,400,{error:'duplicate_header'});return;}
      if(code==='V2_HTTP_BODY_MALFORMED'){json(res,400,{error:'malformed_json'});return;}
      // No stack traces, unexpected error text or token details leave the host.
      json(res,503,{error:'candidate_unavailable'});
    }
  }
  return Object.freeze({
    handle,
    // Returned server is deliberately UNBOUND. The caller chooses loopback/
    // TLS/proxy and must not expose it before G1 source-of-truth acceptance.
    createUnboundServer:()=>http.createServer(handle),
    protectedResource:discovery,
    requiredTransport: 'authenticated-mtls-or-trusted-proxy'
  });
}

/**
 * Compose the existing candidate MCP HTTP handler behind a direct OpenAI mTLS
 * HTTPS listener, without opening a port or downgrading to plaintext HTTP.
 * It remains a candidate: the owner supplies protected server key/cert,
 * configured OAuth identity, canonical route resolver and V2 dispatcher. The
 * first protected call must pass OAuth validation and explicit native owner
 * consent; mTLS alone cannot authorize a workflow operation.
 */
export function createV2CandidateDirectHttpsGateway({
  resource,authorizationServers,scopes=['commander.workflow'],
  certificatePem,privateKeyPem,dispatcherFactory,
  sessionSource='openai/session',resolveTrustedSession,platformSessionProofAuthority,
  now=Date.now,maxBodyBytes=65536
}={}){
  if(typeof now!=='function')fail('V2_HTTPS_TRUSTED_CLOCK_REQUIRED');
  const tlsOptions=createV2OpenAiClientTlsOptions({
    certificatePem,privateKeyPem,now:now()
  });
  const attestTransport=createV2DirectMtlsTransportAttestor({
    intermediateDerSha256:V2_OPENAI_CONNECTORS_CA_PIN,
    sessionSource,resolveTrustedSession,now
  });
  const ingress=createV2CandidateHttpIngress({
    resource,authorizationServers,scopes,attestTransport,
    dispatcherFactory,platformSessionProofAuthority,maxBodyBytes
  });
  return Object.freeze({
    protectedResource:ingress.protectedResource,
    requiredTransport:'direct-openai-mtls',
    // The returned server is not listening: binding or deployment is a
    // separate, explicitly authorized operation after live OAuth acceptance.
    createUnboundTlsServer:()=>https.createServer(tlsOptions,ingress.handle)
  });
}
