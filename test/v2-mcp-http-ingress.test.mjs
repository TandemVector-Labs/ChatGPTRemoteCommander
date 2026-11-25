import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createV2CandidateHttpIngress} from '../src/v2-mcp-http-ingress.mjs';
import {createV2PlatformSessionProofAuthority} from '../src/v2-platform-session-proof.mjs';

const RESOURCE='https://commander.example.invalid/mcp-v2';
const ISSUER='https://idp.example.invalid';
const TOKEN='synthetic-ingress-bearer-token-123456789';
const SESSION='chat-2026-11';

async function invoke({attestation,authorization='Bearer '+TOKEN,session=SESSION,name='v2_workflow_step'}={}){
  const authority=createV2PlatformSessionProofAuthority();
  let received=null;
  let ingress;
  ingress=createV2CandidateHttpIngress({
    resource:RESOURCE,authorizationServers:[ISSUER],
    attestTransport:async()=>attestation,
    platformSessionProofAuthority:authority,
    dispatcherFactory:async transport=>{
      received=transport;
      return {
        protectedResource:ingress.protectedResource,
        handleRpc:async()=>({jsonrpc:'2.0',id:1,result:{ok:true}})
      };
    }
  });
  const message={
    jsonrpc:'2.0',id:1,method:'tools/call',
    params:{name,arguments:{},_meta:{'openai/session':session}}
  };
  const body=Buffer.from(JSON.stringify(message));
  const rawHeaders=['content-type','application/json'];
  if(authorization!==null)rawHeaders.push('authorization',authorization);
  const req={
    method:'POST',url:'/mcp-v2',headers:{'content-length':String(body.length)},
    rawHeaders,
    async *[Symbol.asyncIterator](){yield body;}
  };
  const res={
    writeHead(status,headers){this.status=status;this.headers=headers;},
    end(value){this.body=value;}
  };
  await ingress.handle(req,res);
  return {authority,received,res};
}

test('only a direct mTLS v2_workflow_step call issues a digest-bound owner capability',async()=>{
  const result=await invoke({
    attestation:{authenticated:true,peerType:'openai-chatgpt-mtls',sessionSource:'openai/session'}
  });
  assert.equal(result.res.status,200);
  assert.equal(result.received.authenticated,true);
  assert.equal(result.received.sessionHandle,SESSION);
  const proof=result.authority.inspect(result.received.platformSessionProof);
  assert.deepEqual({...proof},{
    peerType:'openai-chatgpt-mtls',sessionSource:'openai/session',
    sessionHandle:SESSION,
    tokenSha256:createHash('sha256').update(TOKEN).digest('hex')
  });
});

test('untrusted transport, missing bearer, wrong tool and invalid session never issue owner proof',async t=>{
  const cases=[
    ['untrusted transport',{attestation:{authenticated:false,peerType:'openai-chatgpt-mtls',sessionSource:'openai/session'}}],
    ['missing bearer',{attestation:{authenticated:true,peerType:'openai-chatgpt-mtls',sessionSource:'openai/session'},authorization:null}],
    ['wrong tool',{attestation:{authenticated:true,peerType:'openai-chatgpt-mtls',sessionSource:'openai/session'},name:'future_admin_tool'}],
    ['wrong session source',{attestation:{authenticated:true,peerType:'openai-chatgpt-mtls',sessionSource:'x-chat-id'}}]
  ];
  for(const [name,args] of cases)await t.test(name,async()=>{
    const result=await invoke(args);
    assert.equal(result.received?.platformSessionProof,undefined);
  });
});

test('ingress never gives the raw bearer token to the dispatcher factory',async()=>{
  const result=await invoke({
    attestation:{authenticated:true,peerType:'openai-chatgpt-mtls',sessionSource:'openai/session'}
  });
  assert.equal(Object.hasOwn(result.received,'authorization'),false);
  assert.equal(Object.hasOwn(result.received,'token'),false);
  assert.equal(Object.hasOwn(result.received.platformSessionProof,'tokenSha256'),false);
});

test('private tunnel mTLS attestation can mint one-shot owner proof for exact chat and bearer',async()=>{
  const x=await invoke({
    attestation:{authenticated:true,peerType:'openai-tunnel-client-mtls',
      sessionSource:'openai/session'}
  });
  assert.equal(x.res.status,200);
  const proof=x.authority.inspect(x.received.platformSessionProof);
  assert.deepEqual({...proof},{
    peerType:'openai-tunnel-client-mtls',sessionSource:'openai/session',
    sessionHandle:SESSION,
    tokenSha256:createHash('sha256').update(TOKEN).digest('hex')
  });
});
test('unsupported tunnel/proxy identity cannot introduce a platform session',async()=>{
  const x=await invoke({
    attestation:{authenticated:true,peerType:'unverified-proxy',
      sessionSource:'openai/session'}
  });
  assert.equal(x.res.status,403);
  assert.equal(x.received,null);
});
