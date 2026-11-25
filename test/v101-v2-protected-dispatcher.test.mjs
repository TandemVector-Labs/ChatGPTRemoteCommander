// Contract QA for the V1-01 to installed V2 boundary. All tokens/owner
// attestations here are synthetic fixtures, never production enrollment.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createV101V2ProtectedDispatcherFactory} from '../src/v101-v2-protected-dispatcher.mjs';

const token='SYNTHETIC_SIGNED_JWT_QA_ONLY_123456789';
const tokenSha=createHash('sha256').update(token).digest('hex');
const ownerSidHash='c'.repeat(64);
const issuer='https://idp.example.invalid';
const audience='https://commander.example.invalid/mcp-v2';
const T=1000000000000;
const initialRoute={hostId:'host',profileId:'profile',principalId:'principal',
  conversationId:'chat-a',operationId:'step-a',
  target:{kind:'workflow-root',id:'workflow-a'}};
const action=(content='from-A')=>({
  jsonrpc:'2.0',id:31,method:'tools/call',params:{
    name:'v2_workflow_step',
    arguments:{tool:'write_text',arguments:{path:'safe.txt',content},
      stepId:'step-a',expectedRevision:1},
    _meta:{'openai/session':'chat-a'}
  }
});
function scenario(){
  const state={allow:true,consent:true,route:initialRoute,callCount:0,
    ownerCalls:0,clock:T,transport:'chat-a',mutate:null};
  const verifiedClaims=()=>({
    issuer,audience,subject:'user',notBeforeMs:T-1000,expiresAtMs:T+60000,
    scopes:['commander.workflow']
  });
  const factory=createV101V2ProtectedDispatcherFactory({
    hostId:'host',profileId:'profile',issuer,audience,
    now:()=>state.clock,
    verifyAccessToken:async received=>received===token?verifiedClaims():null,
    resolvePrincipal:async subject=>subject==='user'?'principal':null,
    resolveAttestedTokenBinding:async digest=>
      state.consent&&digest===tokenSha?{
        source:'native-owner-attested',tokenSha256:tokenSha,
        sessionHandle:'chat-a',bindingId:'b'.repeat(64),ownerSidHash,expiresAtMs:T+50000
      }:null,
    nativeSessionBindings:{
      resolveNativeRoute:async()=>state.route,
      resolveNativeOwnerContext:async session=>{
        if(!state.consent||session!=='chat-a')return null;
        const route=state.route;
        return {source:'native-owner-attested',
          hostId:route.hostId,profileId:route.profileId,
          principalId:route.principalId,conversationId:route.conversationId,
          bindingId:'b'.repeat(64),ownerSidHash,expiresAtMs:T+50000};
      }
    },
    grantRegistry:{isAllowed:()=>state.allow},
    authorizeExactInvocation:async(r,c)=>{
      state.ownerCalls++;
      if(typeof state.mutate==='function')await state.mutate();
      return r.conversationId==='chat-a'
        &&c.tool==='write_text'
        &&Object.keys(c.arguments).length===2
        &&c.arguments.path==='safe.txt'
        &&c.arguments.content==='from-A';
    },
    createTrustedDispatcher:async proof=>{
      assert.equal(proof.authenticated,true);
      assert.equal(typeof proof.sessionHandle,'string');
      return {
        protectedResource:{metadataUrl:'https://commander.example.invalid/.well-known/oauth-protected-resource/mcp-v2'},
        handleRpc:async({authorization,message})=>{
          if(!authorization)return {jsonrpc:'2.0',id:message.id,
            result:{isError:true,error:'oauth_required'}};
          state.callCount++;
          assert.equal(Object.isFrozen(message),true);
          if(message.method!=='tools/call')return {
            jsonrpc:'2.0',id:message.id,result:{ok:true,bootstrap:true}
          };
          assert.equal(Object.isFrozen(message.params.arguments.arguments),true);
          assert.equal(message.params.arguments.arguments.content,'from-A');
          return {jsonrpc:'2.0',id:message.id,result:{isError:false,ok:true}};
        }
      };
    }
  });
  return{state,factory};
}
const send=(d,authorization='Bearer '+token,m=action())=>
  d.handleRpc({authorization,message:m});

test('factory fails closed without independent owner, OAuth and V2 dispatch providers',async()=>{
  assert.throws(()=>createV101V2ProtectedDispatcherFactory({}),
    /V101_V2_TRUSTED_DISPATCHER_FACTORY_REQUIRED/);
  assert.throws(()=>createV101V2ProtectedDispatcherFactory({
    createTrustedDispatcher:async()=>({})
  }),/V101_ROUTER_BRIDGE_TRUSTED_BOOTSTRAP_REQUIRED/);
  const{factory}=scenario();
  await assert.rejects(()=>factory({authenticated:true,sessionHandle:'../escape'}),
    /V101_V2_TRUSTED_TRANSPORT_REQUIRED/);
  await assert.rejects(()=>factory({authenticated:false,sessionHandle:'chat-a'}),
    /V101_V2_TRUSTED_TRANSPORT_REQUIRED/);
});
test('trusted synthetic owner route authorizes exact frozen action once',async()=>{
  const{state,factory}=scenario(),dispatcher=await factory({authenticated:true,sessionHandle:'chat-a'});
  const msg=action();
  const result=await send(dispatcher,undefined,msg);
  assert.equal(result.result.ok,true);
  assert.equal(state.callCount,1);
  assert.equal(state.ownerCalls,1);
  assert.equal(Object.isFrozen(msg.params.arguments.arguments),true);
  assert.equal(Object.isFrozen(msg.params._meta),true);
});
test('missing OAuth goes to V2 challenge; invalid bearer or forged arguments fail before effects',async()=>{
  const{state,factory}=scenario(),dispatcher=await factory({authenticated:true,sessionHandle:'chat-a'});
  const oauth=await dispatcher.handleRpc({authorization:null,message:action()});
  assert.equal(oauth.result.error,'oauth_required');
  assert.equal(state.callCount,0);
  assert.equal((await send(dispatcher,'Bearer counterfeit')).result.isError,true);
  assert.equal((await send(dispatcher,undefined,action('forged'))).result.isError,true);
  assert.equal(state.callCount,0);
});
test('wrong owner conversation, revoked token epoch, revoked grant and expired token all deny',async()=>{
  const{state,factory}=scenario();
  const wrong=await factory({authenticated:true,sessionHandle:'chat-b'});
  assert.equal((await send(wrong)).result.isError,true);
  assert.equal(state.callCount,0);
  const right=await factory({authenticated:true,sessionHandle:'chat-a'});
  state.consent=false;
  assert.equal((await send(right)).result.isError,true);
  state.consent=true;state.allow=false;
  assert.equal((await send(right)).result.isError,true);
  state.allow=true;state.clock=T+80000;
  assert.equal((await send(right)).result.isError,true);
  assert.equal(state.callCount,0);
});
test('untrusted nested symbols/getters/proxies, cycles and signed zero are rejected',async()=>{
  const{state,factory}=scenario(),d=await factory({authenticated:true,sessionHandle:'chat-a'});
  const withSymbol=action();withSymbol.params.arguments.arguments[Symbol('shadow')]=true;
  const getter=action();
  Object.defineProperty(getter.params.arguments.arguments,'secret',{
    enumerable:false,get(){throw Error('must not run getter');}
  });
  const cycle=action();cycle.params.arguments.arguments.loop=cycle;
  const p=action();p.params.arguments.arguments=new Proxy(
    {path:'safe.txt',content:'from-A'}, {});
  const zero=action();zero.params.arguments.arguments.offset=-0;
  for(const m of [withSymbol,getter,cycle,p,zero])
    assert.equal((await send(d,undefined,m)).result.isError,true);
  assert.equal(state.callCount,0);
});
test('mutating request during awaited owner policy cannot authorize a changed dispatch',async()=>{
  const{state,factory}=scenario(),d=await factory({authenticated:true,sessionHandle:'chat-a'});
  const msg=action();
  state.mutate=async()=>{
    assert.throws(()=>{msg.params.arguments.arguments.content='FORGED';},TypeError);
  };
  assert.equal((await send(d,undefined,msg)).result.isError,false);
  assert.equal(state.callCount,1);
  assert.equal(msg.params.arguments.arguments.content,'from-A');
});
test('V2 response shape and downstream error are scoped to request; no unhandled exception escapes',async()=>{
  const{factory,state}=scenario();
  const d=await factory({authenticated:true,sessionHandle:'chat-a'});
  const result=await send(d);
  assert.equal(result.jsonrpc,'2.0');
  assert.equal(result.id,31);
  assert.equal(state.callCount,1);
});


// A future or renamed V2 tool must not silently bypass the V1-01 owner gate.
test('unknown tools/call is denied before touching a future backend tool',async()=>{
  const {state,factory}=scenario();
  const d=await factory({authenticated:true,sessionHandle:'chat-a'});
  const message=action();
  message.params.name='future_privileged_tool';
  const result=await send(d,undefined,message);
  assert.equal(result.result.isError,true);
  assert.equal(state.callCount,0);
  assert.equal(state.ownerCalls,0);
});


test('untrusted RPC method getter is never invoked before owner validation',async()=>{
  const {state,factory}=scenario();
  const d=await factory({authenticated:true,sessionHandle:'chat-a'});
  const message=action();
  let calls=0;
  Object.defineProperty(message,'method',{enumerable:true,
    get(){calls++;return 'tools/list';}
  });
  const result=await d.handleRpc({authorization:'Bearer '+token,message});
  assert.equal(result.result.isError,true);
  assert.equal(calls,0,'accessor must not execute even during rejection');
  assert.equal(state.callCount,0);
  assert.equal(state.ownerCalls,0);
});

// Unknown RPC methods can carry future effects, not just unknown tools/call.
test('unknown RPC method cannot invoke future unreviewed V2 methods',async()=>{
  const {state,factory}=scenario();
  const d=await factory({authenticated:true,sessionHandle:'chat-a'});
  for(const method of ['resources/read','prompts/get','tasks/cancel','future/privileged']){
    const message=action();message.method=method;
    assert.equal((await send(d,undefined,message)).result.isError,true);
    assert.equal(state.callCount,0,'unreviewed RPC method must not reach V2');
    assert.equal(state.ownerCalls,0);
  }
});

test('only reviewed protocol bootstrap RPC methods reach trusted V2 dispatcher',async()=>{
  const {state,factory}=scenario();
  const d=await factory({authenticated:true,sessionHandle:'chat-a'});
  for(const method of ['initialize','notifications/initialized','ping','tools/list','server/discover']){
    const message={jsonrpc:'2.0',id:17,method,params:{}};
    const result=await send(d,undefined,message);
    assert.equal(result.result.bootstrap,true);
  }
  assert.equal(state.callCount,5);
  assert.equal(state.ownerCalls,0);
});
