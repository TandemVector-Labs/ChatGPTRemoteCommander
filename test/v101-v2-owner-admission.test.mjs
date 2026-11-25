import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createV101V2ProtectedDispatcherFactory} from '../src/v101-v2-protected-dispatcher.mjs';
import {createV2PlatformSessionProofAuthority} from '../src/v2-platform-session-proof.mjs';

const TOKEN='synthetic-owner-admission-bearer-123456789';
const TOKEN_SHA=createHash('sha256').update(TOKEN).digest('hex');
const ISSUER='https://idp.example.invalid';
const AUDIENCE='https://commander.example.invalid/mcp-v2';
const METADATA='https://commander.example.invalid/.well-known/oauth-protected-resource/mcp-v2';
const NOW=1_800_000_000_000;
const ROUTE=Object.freeze({
  hostId:'host',profileId:'profile',principalId:'principal',
  conversationId:'chat-a',operationId:'step-a',
  target:Object.freeze({kind:'workflow-root',id:'workflow-a'})
});

function action(content='approved'){
  return {
    jsonrpc:'2.0',id:31,method:'tools/call',
    params:{
      name:'v2_workflow_step',
      arguments:{tool:'write_text',arguments:{path:'safe.txt',content},
        stepId:'step-a',expectedRevision:1},
      _meta:{'openai/session':'chat-a'}
    }
  };
}

function scenario(peerType='openai-chatgpt-mtls'){
  const state={
    clock:NOW,oauthValid:true,oauthErrorCode:null,oauthScopes:['commander.workflow'],consent:true,grantAllowed:true,
    route:ROUTE,binding:null,bindCalls:0,ownerCalls:0,callCount:0,
    verifyCalls:0,routeCalls:0,dispatcherProofs:[],lastAttested:null,
    bindGate:null,bindStarted:null,signalBindStarted:null
  };
  const authority=createV2PlatformSessionProofAuthority();
  const resolveAttestedTokenBinding=async digest=>
    state.binding?.tokenSha256===digest?state.binding:null;
  const nativeSessionBindings={
    resolveAttestedTokenBinding,
    async bindTrusted(proof){
      const attested=authority.consume(proof);
      state.bindCalls++;
      state.lastAttested=attested;
      state.signalBindStarted?.();
      if(state.bindGate)await state.bindGate;
      if(!state.consent)throw new Error('OWNER_DENIED');
      if(state.binding)throw new Error('BINDING_ALREADY_EXISTS');
      state.binding=Object.freeze({
        source:'native-owner-attested',sessionHandle:attested.sessionHandle,
        tokenSha256:attested.tokenSha256,bindingId:'b'.repeat(64),
        ownerSidHash:'c'.repeat(64),expiresAtMs:NOW+50_000
      });
      return state.binding;
    },
    async resolveNativeRoute(sessionHandle){
      if(sessionHandle!==state.route.conversationId)return null;
      return state.route;
    },
    async resolveNativeOwnerContext(sessionHandle){
      const binding=state.binding;
      if(!binding||sessionHandle!==binding.sessionHandle)return null;
      return Object.freeze({
        source:'native-owner-attested',hostId:state.route.hostId,
        profileId:state.route.profileId,principalId:state.route.principalId,
        conversationId:state.route.conversationId,bindingId:binding.bindingId,
        ownerSidHash:binding.ownerSidHash,expiresAtMs:binding.expiresAtMs
      });
    }
  };
  const factory=createV101V2ProtectedDispatcherFactory({
    hostId:'host',profileId:'profile',issuer:ISSUER,audience:AUDIENCE,
    now:()=>state.clock,
    verifyAccessToken:async token=>{
      state.verifyCalls++;
      if(state.oauthErrorCode)throw Object.assign(new Error('synthetic verifier failure'),{code:state.oauthErrorCode});
      if(token!==TOKEN||!state.oauthValid)return null;
      const claims={issuer:ISSUER,audience:AUDIENCE,subject:'user',
        notBeforeMs:NOW-1000,expiresAtMs:NOW+60_000,
        scopes:state.oauthScopes};
      return claims;
    },
    resolvePrincipal:async subject=>subject==='user'?'principal':null,
    resolveAttestedTokenBinding,nativeSessionBindings,
    grantRegistry:{isAllowed:()=>state.grantAllowed},
    authorizeExactInvocation:async(route,call)=>{
      state.ownerCalls++;
      return route.conversationId==='chat-a'
        &&call.tool==='write_text'&&call.arguments.path==='safe.txt'
        &&call.arguments.content==='approved';
    },
    createTrustedDispatcher:async proof=>{
      state.dispatcherProofs.push(proof);
      return {
        protectedResource:{metadataUrl:METADATA},
        handleRpc:async({message})=>{
          state.callCount++;
          assert.equal(Object.isFrozen(message),true);
          assert.equal(Object.isFrozen(message.params.arguments.arguments),true);
          return {jsonrpc:'2.0',id:message.id,result:{ok:true}};
        }
      };
    },
    resolveOwnerRoute:async sessionHandle=>{
      state.routeCalls++;
      return sessionHandle===state.route.conversationId?state.route:null;
    },
    platformSessionProofAuthority:authority
  });
  function platformProof(sessionHandle='chat-a',tokenSha256=TOKEN_SHA){
    return authority.issue({
      peerType,sessionSource:'openai/session',
      sessionHandle,tokenSha256
    });
  }
  return {state,authority,nativeSessionBindings,factory,platformProof};
}

async function dispatch(s,proof,{sessionHandle='chat-a',authorization='Bearer '+TOKEN,message=action()}={}){
  const dispatcher=await s.factory({
    authenticated:true,sessionHandle,platformSessionProof:proof
  });
  return dispatcher.handleRpc({authorization,message});
}

test('valid OAuth is verified before first native owner consent and exact V2 dispatch',async()=>{
  const s=scenario(),proof=s.platformProof();
  const result=await dispatch(s,proof);
  assert.equal(result.result.ok,true);
  assert.equal(s.state.bindCalls,1);
  assert.equal(s.state.verifyCalls,2); // pre-consent check + bridge admission
  assert.equal(s.state.ownerCalls,1);
  assert.equal(s.state.callCount,1);
  assert.equal(s.state.lastAttested.source,'native-platform-session');
  assert.equal(s.state.lastAttested.sessionHandle,'chat-a');
  assert.equal(s.authority.inspect(proof),null);
  assert.equal(s.state.dispatcherProofs[0].sessionHandle,'chat-a');
});

test('invalid OAuth, wrong proof digest, or canonical route mismatch cannot trigger owner consent',async t=>{
  await t.test('invalid OAuth',async()=>{
    const s=scenario();s.state.oauthValid=false;
    const result=await dispatch(s,s.platformProof());
    assert.equal(result.result.isError,true);
    assert.match(result.result._meta?.['mcp/www_authenticate']?.[0]??'',/error="invalid_token"/);
    assert.equal(s.state.bindCalls,0);
    assert.equal(s.state.callCount,0);
  });
  await t.test('recognized invalid-token verifier errors trigger OAuth re-link',async()=>{
    const s=scenario();s.state.oauthErrorCode='V2_JWT_SIGNATURE_INVALID';
    const result=await dispatch(s,s.platformProof());
    assert.equal(result.result.isError,true);
    assert.match(result.result._meta?.['mcp/www_authenticate']?.[0]??'',/error="invalid_token"/);
    assert.equal(s.state.bindCalls,0);
    assert.equal(s.state.callCount,0);
  });
  await t.test('identity-provider outage is denied without misleading re-link',async()=>{
    const s=scenario();s.state.oauthErrorCode='V2_JWKS_FETCH_FAILED';
    const result=await dispatch(s,s.platformProof());
    assert.equal(result.result.isError,true);
    assert.equal(result.result._meta,undefined);
    assert.equal(s.state.bindCalls,0);
    assert.equal(s.state.callCount,0);
  });
  await t.test('insufficient scope triggers OAuth re-link without native approval',async()=>{
    const s=scenario();s.state.oauthScopes=[];
    const result=await dispatch(s,s.platformProof());
    assert.equal(result.result.isError,true);
    assert.match(result.result._meta?.['mcp/www_authenticate']?.[0]??'',/error="insufficient_scope"/);
    assert.equal(s.state.bindCalls,0);
    assert.equal(s.state.callCount,0);
  });
  await t.test('proof bound to another bearer digest',async()=>{
    const s=scenario(),proof=s.platformProof('chat-a','d'.repeat(64));
    const result=await dispatch(s,proof);
    assert.equal(result.result.isError,true);
    assert.equal(result.result._meta,undefined);
    assert.equal(s.state.bindCalls,0);
    assert.equal(s.state.callCount,0);
  });
  await t.test('route belongs to another conversation',async()=>{
    const s=scenario();
    s.state.route=Object.freeze({...ROUTE,conversationId:'chat-other'});
    const result=await dispatch(s,s.platformProof());
    assert.equal(result.result.isError,true);
    assert.equal(result.result._meta,undefined);
    assert.equal(s.state.bindCalls,0);
    assert.equal(s.state.callCount,0);
  });
});

test('missing or mismatched mTLS capability fails closed before owner admission',async()=>{
  const s=scenario();
  const noProof=await dispatch(s,undefined);
  assert.equal(noProof.result.isError,true);
  const wrongSession=await dispatch(s,s.platformProof('chat-other'),{sessionHandle:'chat-a'});
  assert.equal(wrongSession.result.isError,true);
  assert.equal(s.state.bindCalls,0);
  assert.equal(s.state.callCount,0);
});

test('owner denial never creates a binding or reaches the V2 dispatcher',async()=>{
  const s=scenario();s.state.consent=false;
  const result=await dispatch(s,s.platformProof());
  assert.equal(result.result.isError,true);
  assert.equal(s.state.bindCalls,1);
  assert.equal(s.state.binding,null);
  assert.equal(s.state.callCount,0);
});

test('an existing valid owner binding is reused without a second consent prompt',async()=>{
  const s=scenario();
  assert.equal((await dispatch(s,s.platformProof())).result.ok,true);
  const secondProof=s.platformProof();
  assert.equal((await dispatch(s,secondProof)).result.ok,true);
  assert.equal(s.state.bindCalls,1);
  assert.equal(s.state.callCount,2);
  // The second proof was not needed because the current owner binding already existed.
  assert.ok(s.authority.inspect(secondProof));
});

test('concurrent calls for one token/session share one owner-consent operation',async()=>{
  const s=scenario();
  let release;
  s.state.bindGate=new Promise(resolve=>{release=resolve;});
  s.state.bindStarted=new Promise(resolve=>{s.state.signalBindStarted=resolve;});
  const firstProof=s.platformProof(),secondProof=s.platformProof();
  const first=dispatch(s,firstProof);
  await s.state.bindStarted;
  const second=dispatch(s,secondProof);
  release();
  const results=await Promise.all([first,second]);
  assert.equal(results.every(x=>x.result.ok===true),true);
  assert.equal(s.state.bindCalls,1);
  assert.equal(s.state.callCount,2);
});

test('private-tunnel client mTLS is admitted only with verified OAuth and owner binding',async()=>{
  const s=scenario('openai-tunnel-client-mtls');
  const proof=s.platformProof();
  const response=await dispatch(s,proof);
  assert.equal(response.result.ok,true);
  assert.equal(s.state.bindCalls,1);
  assert.equal(s.state.ownerCalls,1);
  assert.equal(s.state.callCount,1);
  assert.equal(s.state.lastAttested.source,'native-platform-session');
  assert.equal(s.authority.inspect(proof),null);
});
test('private-tunnel mTLS never skips denied J01 owner or invalid token',async()=>{
  const denied=scenario('openai-tunnel-client-mtls');
  denied.state.consent=false;
  const r=await dispatch(denied,denied.platformProof());
  assert.equal(r.result.isError,true);
  assert.equal(denied.state.callCount,0);
  assert.equal(denied.state.binding,null);
  const invalid=scenario('openai-tunnel-client-mtls');
  invalid.state.oauthValid=false;
  const z=await dispatch(invalid,invalid.platformProof());
  assert.equal(z.result.isError,true);
  assert.equal(invalid.state.bindCalls,0);
  assert.equal(invalid.state.callCount,0);
});
