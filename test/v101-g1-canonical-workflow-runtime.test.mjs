import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {spawnSync} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {createV2NativeOwnerAssertionIssuer} from '../src/v2-caller-assertion.mjs';
import {createV101CanonicalWorkflowDispatcherFactory,
  createV101G1CanonicalWorkflowRuntime
} from '../src/v101-g1-canonical-workflow-runtime.mjs';

const RESOURCE='https://commander.example.invalid/mcp-v2';
// Build a noncredential test bearer at runtime; never store a bearer-shaped literal.
const SYNTHETIC_AUTHORIZATION='Bearer ' + 'QA_SIGNED_FIXTURE_0123456789012345';
const ISSUER='https://idp.example.invalid';
const route=(conversationId='owner-chat-1',hostId='host-a',profileId='profile-a')=>({
  hostId,profileId,principalId:'principal-1',conversationId,
  operationId:'step-1',target:{kind:'workflow-root',id:'root-1'}
});
function fixture(overrides={}){
  const calls={trusted:0,dispatch:0,authorize:0,access:0,principal:0};
  const deps={
    hostId:'host-a',profileId:'profile-a',resource:RESOURCE,
    authorizationServers:[ISSUER],issuer:ISSUER,audience:RESOURCE,
    verifyAccessToken:async()=>{
      calls.access++;
      return {issuer:ISSUER,audience:RESOURCE,subject:'owner-1',
        notBeforeMs:Date.now()-1000,expiresAtMs:Date.now()+60000,
        scopes:['commander.workflow']};
    },
    resolvePrincipal:async()=>{calls.principal++;return 'principal-1';},
    assertionTrust:{},observedNativeSession:async()=>null,
    resolveTrustedInvocation:async()=>{
      calls.trusted++;
      return {route:route('different-chat'),assertion:{kind:'untrusted-qa'}};
    },
    workflowStore:{},grantRegistry:{},
    authorizeTool:async()=>{calls.authorize++;return false;},
    dispatch:async()=>{calls.dispatch++;throw Error('UNEXPECTED_EXECUTION');},
    ...overrides
  };
  return {calls,deps};
}
const action={
  tool:'read_text',arguments:{path:'README.md'},
  stepId:'step-1',expectedRevision:1
};
const message={jsonrpc:'2.0',id:1,method:'tools/call',
  params:{name:'v2_workflow_step',arguments:action}};

test('canonical G1 composition rejects missing trust, mismatched audience and caller-selected host factory',()=>{
  const {deps}=fixture();
  assert.throws(()=>createV101CanonicalWorkflowDispatcherFactory({}),
    /V101_G1_CANONICAL_WORKFLOW_BOOTSTRAP_REQUIRED/);
  assert.throws(()=>createV101CanonicalWorkflowDispatcherFactory({
    ...deps,audience:'https://other.example.invalid/mcp-v2'
  }),/V101_G1_CANONICAL_WORKFLOW_BOOTSTRAP_REQUIRED/);
  assert.throws(()=>createV101CanonicalWorkflowDispatcherFactory({
    ...deps,resolveTrustedInvocation:undefined
  }),/V101_G1_CANONICAL_WORKFLOW_BOOTSTRAP_REQUIRED/);
  assert.throws(()=>createV101G1CanonicalWorkflowRuntime({
    transport:'legacy-http',port:0,hostOptions:deps,workflow:deps
  }),/V101_G1_CANONICAL_RUNTIME_BOOTSTRAP_REQUIRED/);
  assert.throws(()=>createV101G1CanonicalWorkflowRuntime({
    transport:'direct-openai-mtls',port:0,
    hostOptions:{...deps,createTrustedDispatcher:()=>({})},workflow:deps
  }),/V101_G1_CANONICAL_RUNTIME_BOOTSTRAP_REQUIRED/);
});

test('canonical V2 descriptor is discoverable only inside authenticated transport and has no direct dispatch',async()=>{
  const {deps,calls}=fixture();
  const create=createV101CanonicalWorkflowDispatcherFactory(deps);
  await assert.rejects(create({authenticated:false,sessionHandle:'owner-chat-1'}),
    /V101_G1_AUTHENTICATED_SESSION_REQUIRED/);
  await assert.rejects(create({authenticated:true,sessionHandle:'../other'}),
    /V101_G1_AUTHENTICATED_SESSION_REQUIRED/);
  const dispatcher=await create({authenticated:true,sessionHandle:'owner-chat-1'});
  assert.equal(dispatcher.protectedResource.metadataUrl,
    'https://commander.example.invalid/.well-known/oauth-protected-resource/mcp-v2');
  const found=await dispatcher.handleRpc({authorization:null,
    message:{jsonrpc:'2.0',id:2,method:'tools/list',params:{}}});
  assert.deepEqual(found.result.tools.map(x=>x.name),['v2_workflow_step']);
  assert.deepEqual(calls,{trusted:0,dispatch:0,authorize:0,access:0,principal:0});
});

test('missing OAuth bearer never consults native resolver and cannot mutate WorkflowStore',async()=>{
  const {deps,calls}=fixture();
  const dispatcher=await createV101CanonicalWorkflowDispatcherFactory(deps)(
    {authenticated:true,sessionHandle:'owner-chat-1'});
  const result=await dispatcher.handleRpc({authorization:null,message});
  assert.equal(result.jsonrpc,'2.0');
  assert.deepEqual(calls,{trusted:0,dispatch:0,authorize:0,access:0,principal:0});
});

test('verified bearer cannot redirect a signed native invocation to another conversation',async()=>{
  const {deps,calls}=fixture();
  const dispatcher=await createV101CanonicalWorkflowDispatcherFactory(deps)(
    {authenticated:true,sessionHandle:'owner-chat-1'});
  const reply=await dispatcher.handleRpc({
    authorization:SYNTHETIC_AUTHORIZATION,message
  });
  assert.equal(reply.result.isError,true);
  assert.match(reply.result.content[0].text,/CHAT_ATTESTATION_REQUIRED/);
  assert.deepEqual({trusted:calls.trusted,dispatch:calls.dispatch,authorize:calls.authorize},
    {trusted:1,dispatch:0,authorize:0});
});

test('verified bearer cannot redirect to another host or profile',async()=>{
  for(const wrongRoute of [route('owner-chat-1','other-host','profile-a'),
    route('owner-chat-1','host-a','other-profile')]){
    const {deps,calls}=fixture({resolveTrustedInvocation:async()=>{
      calls.trusted++;return {route:wrongRoute,assertion:{kind:'qa'}};
    }});
    const dispatcher=await createV101CanonicalWorkflowDispatcherFactory(deps)(
      {authenticated:true,sessionHandle:'owner-chat-1'});
    const reply=await dispatcher.handleRpc({
      authorization:SYNTHETIC_AUTHORIZATION,message
    });
    assert.equal(reply.result.isError,true);
    assert.equal(calls.dispatch,0);
    assert.equal(calls.authorize,0);
  }
});

test('invalid trusted-route shape rejects before assertion or dispatch',async()=>{
  const {deps,calls}=fixture({resolveTrustedInvocation:async()=>({
    route:{hostId:'host-a'},assertion:'fake'
  })});
  const dispatcher=await createV101CanonicalWorkflowDispatcherFactory(deps)(
    {authenticated:true,sessionHandle:'owner-chat-1'});
  const reply=await dispatcher.handleRpc({
    authorization:SYNTHETIC_AUTHORIZATION,message
  });
  assert.equal(reply.result.isError,true);
  assert.equal(calls.dispatch,0);
});

test('integrated G1 opens only an owner-scoped mTLS TLS listener with no anonymous dispatch',{
  skip:!['win32','linux'].includes(process.platform)
},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'v012-g1-canonical-'));
  let runtime;
  try{
    const cert=path.join(directory,'tls.crt'),key=path.join(directory,'tls.key');
    const generated=spawnSync('openssl',[
      'req','-x509','-newkey','rsa:2048','-nodes','-sha256',
      '-config',process.platform==='win32'?'NUL':'/dev/null',
      '-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'
    ],{encoding:'utf8',windowsHide:true,timeout:8000});
    if(generated.error||generated.status!==0)
      return t.skip('OpenSSL fixture generator unavailable');
    const {deps,calls}=fixture();
    const hostOptions={
      directory:path.join(directory,'grants'),resource:RESOURCE,
      authorizationServers:[ISSUER],certificatePem:fs.readFileSync(cert,'utf8'),
      privateKeyPem:fs.readFileSync(key,'utf8'),
      hostId:deps.hostId,profileId:deps.profileId,issuer:ISSUER,audience:RESOURCE,
      verifyAccessToken:deps.verifyAccessToken,resolvePrincipal:deps.resolvePrincipal,
      resolveOwnerRoute:async()=>{throw Error('NATIVE_OWNER_NOT_AUTHORIZED');},
      authorizeExactInvocation:async()=>{throw Error('OWNER_GRANT_NOT_PRESENT');},
      ownerSessionOptions:{execFileImpl:()=>{throw Error('GUI_PROMPT_NOT_ALLOWED');}}
    };
    const workflow={
      assertionTrust:deps.assertionTrust,
      observedNativeSession:deps.observedNativeSession,
      resolveTrustedInvocation:deps.resolveTrustedInvocation,
      workflowStore:deps.workflowStore,grantRegistry:deps.grantRegistry,
      authorizeTool:deps.authorizeTool,dispatch:deps.dispatch
    };
    runtime=createV101G1CanonicalWorkflowRuntime({
      port:0,transport:'direct-openai-mtls',hostOptions,workflow
    });
    assert.equal(runtime.status.phase,'CONSTRUCTED');
    const live=await runtime.start();
    assert.equal(live.phase,'LISTENING');
    assert.equal(live.bindAddress,'127.0.0.1');
    assert.equal(live.authenticatedCurrentChatAccepted,false);
    assert.equal(live.fullAccessActive,false);
    const answer=await new Promise(resolve=>{
      const req=https.get({host:'127.0.0.1',port:live.port,
        path:'/.well-known/oauth-protected-resource/mcp-v2',
        ca:fs.readFileSync(cert,'utf8'),servername:'localhost',timeout:1500},res=>{
        res.resume();res.on('end',()=>resolve({status:res.statusCode}));
      });
      req.on('error',error=>resolve({error:error.code||'SSL_DENIED'}));
      req.on('timeout',()=>{req.destroy();resolve({error:'TIMEOUT'});});
    });
    assert.notEqual(answer.status,200);
    assert.ok(answer.error,'no HTTP response without authenticated client mTLS');
    assert.deepEqual(calls,{trusted:0,dispatch:0,authorize:0,access:0,principal:0});
  }finally{
    await runtime?.close();
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('runtime rejects workflow attempts to override OAuth identity or authority',()=>{
  const {deps}=fixture();
  const hostOptions={
    hostId:deps.hostId,profileId:deps.profileId,issuer:ISSUER,
    audience:RESOURCE,resource:RESOURCE,authorizationServers:[ISSUER],
    verifyAccessToken:deps.verifyAccessToken,resolvePrincipal:deps.resolvePrincipal
  };
  assert.throws(()=>createV101G1CanonicalWorkflowRuntime({
    port:0,transport:'direct-openai-mtls',hostOptions,
    workflow:{...deps,hostId:'other-host'}
  }),/V101_G1_CANONICAL_RUNTIME_BOOTSTRAP_REQUIRED/);
});

test('signed native owner assertion completes one authorized canonical WorkflowStore action',async()=>{
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const signed=createV2NativeOwnerAssertionIssuer({
    issuer:'native-owner-issuer',audience:'commander-native',
    keyId:'qa-identity-key',privateKey,
    resolveNativeRoute:async()=>route(),
    observedNativeSession:async()=> 'windows-wts-2',
    authorizeIssue:async request=>request.route.conversationId==='owner-chat-1',
    now:Date.now,nonce:()=> 'qa-nonce-1'
  });
  const mutableRoute=route();
  let stateCalls=0,effects=0,acceptedFrozen=false;
  const trusted=async request=>{
    const grant=await signed({
      sessionHandle:'owner-chat-1',tool:request.tool,args:request.arguments
    });
    return {route:mutableRoute,assertion:grant.assertion};
  };
  const state={id:'root-1',device:'host-a',authority:{profileId:'profile-a'}};
  const {deps}=fixture({
    assertionTrust:{issuer:'native-owner-issuer',audience:'commander-native',
      publicKeys:new Map([['qa-identity-key',publicKey]])},
    observedNativeSession:async()=> 'windows-wts-2',
    resolveTrustedInvocation:trusted,
    workflowStore:{
      get(id){stateCalls++;assert.equal(id,'root-1');return {state};},
      async call(input,{validate,dispatch}){
        assert.equal(input.stepId,'step-1');
        await validate(input.tool,input.arguments,state);
        const outcome=await dispatch(input.tool,input.arguments,state);
        return {outcome,cachedReceipt:false};
      }
    },
    grantRegistry:{isAllowed:()=>true},
    authorizeTool:async()=>true,
    dispatch:async()=>{effects++;return {executed:true};}
  });
  const factory=createV101CanonicalWorkflowDispatcherFactory(deps);
  const dispatcher=await factory({authenticated:true,sessionHandle:'owner-chat-1'});
  const result=await dispatcher.handleRpc({
    authorization:SYNTHETIC_AUTHORIZATION,message
  });
  assert.equal(result.result.structuredContent.outcome.executed,true);
  assert.equal(effects,1);
  assert.ok(stateCalls>=3);
  // Native resolver can retain a mutable record; the canonical boundary must
  // never mutate that record or pass it downstream as an alias.
  assert.equal(Object.isFrozen(mutableRoute),false);
  mutableRoute.conversationId='tampered-chat';
  acceptedFrozen=Object.isFrozen(mutableRoute)===false;
  assert.equal(acceptedFrozen,true);
  const second=await dispatcher.handleRpc({
    authorization:SYNTHETIC_AUTHORIZATION,message
  });
  assert.equal(second.result.isError,true);
  assert.equal(effects,1);
});
