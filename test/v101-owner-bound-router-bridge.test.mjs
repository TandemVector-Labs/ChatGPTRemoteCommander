// V1-01 SOURCE QA ONLY: fake IdP and native owner providers are deliberate
// fixtures. PASS is not evidence of real ChatGPT OAuth, installed J01 signing,
// native broker enrollment, protected transport or operational Full Access.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createV101ProtectedRouterBridge} from '../src/full-access-protected-router-bridge.mjs';

const ISSUER='https://idp.example.invalid';
const AUDIENCE='https://commander.example.invalid/mcp-v2';
const TOKEN='FAKE_QA_OAUTH_TOKEN_NOT_SIGNED_OR_ENROLLED_1234';
const TOKEN_SHA256=createHash('sha256').update(TOKEN).digest('hex');
const T0=1000000000000;
const OWNER_SID_HASH='b'.repeat(64);
const invocation=(args={target:'read-only'})=>({
  rpcMethod:'tools/call',tool:'gui_cursor_position',arguments:args
});
const route=()=>({
  hostId:'qa-host',principalId:'qa-principal',profileId:'qa-profile',
  conversationId:'qa-chat',operationId:'qa-operation',
  target:{kind:'desktop-seat',id:'qa-seat'}
});
function scenario(t,overrides={}){
  const state={
    clock:T0,token:TOKEN,route:route(),binding:{
      source:'native-owner-attested',tokenSha256:TOKEN_SHA256,
      sessionHandle:'qa-chat',bindingId:'a'.repeat(64),ownerSidHash:OWNER_SID_HASH,expiresAtMs:T0+60000
    },grant:true,authorize:true,claims:{
      issuer:ISSUER,audience:AUDIENCE,subject:'qa-subject',
      notBeforeMs:T0-1000,expiresAtMs:T0+80000,
      scopes:['commander.workflow']
    },...overrides
  };
  const bridge=createV101ProtectedRouterBridge({
    hostId:'qa-host',profileId:'qa-profile',
    issuer:ISSUER,audience:AUDIENCE,now:()=>state.clock,
    verifyAccessToken:async token=>token===state.token?state.claims:null,
    resolvePrincipal:async subject=>typeof state.principalResolver==='function'
      ?state.principalResolver(subject)
      :subject==='qa-subject'?'qa-principal':null,
    resolveAttestedTokenBinding:async digest=>
      digest===TOKEN_SHA256?state.binding:null,
    nativeSessionBindings:{
      resolveNativeRoute:async session=>
        typeof state.nativeRouteResolver==='function'
          ?state.nativeRouteResolver(session):state.route,
      resolveNativeOwnerContext:async session=>{
        const binding=state.binding,route=state.route;
        if(!binding||session!==binding.sessionHandle)return null;
        return {source:'native-owner-attested',hostId:route.hostId,
          profileId:route.profileId,principalId:route.principalId,
          conversationId:route.conversationId,bindingId:binding.bindingId,
          ownerSidHash:binding.ownerSidHash,expiresAtMs:binding.expiresAtMs};
      }
    },
    grantRegistry:{isAllowed:()=>state.grant},
    authorizeExactInvocation:async(_r,call)=>typeof state.authorize==='function'
      ?state.authorize(call):state.authorize
  });
  t.after(()=>bridge.close());
  return {state,bridge};
}
test('trusted bootstrap rejects missing native route/issuer, not only invalid bearer',()=>{
  assert.throws(()=>createV101ProtectedRouterBridge({}),
    /V101_ROUTER_BRIDGE_TRUSTED_BOOTSTRAP_REQUIRED/);
  assert.throws(()=>createV101ProtectedRouterBridge({
    hostId:'qa-host',profileId:'qa-profile',issuer:'http://unsafe',
    audience:AUDIENCE
  }),/V101_ROUTER_BRIDGE_TRUSTED_BOOTSTRAP_REQUIRED/);
});
test('fixture OAuth claims plus independent native owner binding yield only a short-lived ticket',async t=>{
  const {state,bridge}=scenario(t);
  const actor=await bridge.verifyCaller(TOKEN);
  assert.equal(actor?.verified,true);
  assert.equal(actor?.source,'v1-01-trusted-ingress');
  assert.equal(actor?.conversationId,'qa-chat');
  assert.equal(actor?.hostId,'qa-host');
  assert.equal(await bridge.authorizeTool(actor,invocation()),true);
  assert.equal((await bridge.verifyCaller(TOKEN))?.ticket,actor.ticket);
  assert.equal(bridge.activeTickets,1);
  assert.equal(bridge.close(),undefined);
  assert.equal(bridge.activeTickets,0);
  assert.equal(await bridge.authorizeTool(actor,invocation()),false);
});
test('invalid OAuth principal, scope, signature callback or time never creates tickets',async t=>{
  const {bridge,state}=scenario(t);
  assert.equal(await bridge.verifyCaller('wrong token'),null);
  assert.equal(await bridge.verifyCaller('short'),null);
  state.claims={...state.claims,scopes:['unrelated']};
  assert.equal(await bridge.verifyCaller(TOKEN),null);
  state.claims={...state.claims,scopes:['commander.workflow'],issuer:'https://wrong.invalid'};
  assert.equal(await bridge.verifyCaller(TOKEN),null);
  state.claims={...state.claims,issuer:ISSUER,notBeforeMs:T0+1};
  assert.equal(await bridge.verifyCaller(TOKEN),null);
  state.claims={...state.claims,notBeforeMs:T0-1,expiresAtMs:T0};
  assert.equal(await bridge.verifyCaller(TOKEN),null);
  assert.equal(bridge.activeTickets,0);
});
test('owner attestation cannot be inferred from headers, chat strings, or a stale token digest',async t=>{
  const {state,bridge}=scenario(t);
  for(const binding of [
    null,{...state.binding,source:'mcp-header'},
    {...state.binding,tokenSha256:'b'.repeat(64)},
    {...state.binding,sessionHandle:'header-claimed-chat'},
    {...state.binding,bindingId:'not-owner-issued'},
    {...state.binding,expiresAtMs:T0}
  ]){
    state.binding=binding;
    assert.equal(await bridge.verifyCaller(TOKEN),null);
  }
  assert.equal(bridge.activeTickets,0);
});

test('native token/session binding requires a valid owner SID hash and rechecks it before ticket admission',async t=>{
  const valid={source:'native-owner-attested',tokenSha256:TOKEN_SHA256,
    sessionHandle:'qa-chat',bindingId:'a'.repeat(64),
    ownerSidHash:OWNER_SID_HASH,expiresAtMs:T0+60000};
  for(const binding of [
    {...valid,ownerSidHash:undefined},
    {...valid,ownerSidHash:'not-a-digest'}
  ]){
    const {bridge}=scenario(t,{binding});
    assert.equal(await bridge.verifyCaller(TOKEN),null);
    assert.equal(bridge.activeTickets,0);
  }
});

test('owner SID change during asynchronous route resolution or exact policy invalidates the ticket',async t=>{
  await t.test('changed before ticket issuance',async t=>{
    const {state,bridge}=scenario(t);
    state.nativeRouteResolver=async()=>{
      state.binding={...state.binding,ownerSidHash:'f'.repeat(64)};
      return state.route;
    };
    assert.equal(await bridge.verifyCaller(TOKEN),null);
    assert.equal(bridge.activeTickets,0);
  });
  await t.test('changed during exact invocation policy',async t=>{
    const {state,bridge}=scenario(t);
    const actor=await bridge.verifyCaller(TOKEN);
    state.authorize=async()=>{
      state.binding={...state.binding,ownerSidHash:'f'.repeat(64)};
      return true;
    };
    assert.equal(await bridge.authorizeTool(actor,invocation()),false);
  });
});

test('route identity must equal bound host/profile/principal/conversation',async t=>{
  const {state,bridge}=scenario(t);
  for(const bad of [
    {...route(),hostId:'other-host'},
    {...route(),profileId:'other-profile'},
    {...route(),principalId:'other-principal'},
    {...route(),conversationId:'other-chat'}
  ]){
    state.route=bad;
    assert.equal(await bridge.verifyCaller(TOKEN),null);
  }
  assert.equal(bridge.activeTickets,0);
});
test('ticket identity can never be widened by forging a principal, host or expiry',async t=>{
  const {bridge}=scenario(t),actor=await bridge.verifyCaller(TOKEN);
  for(const change of [
    {hostId:'other-host'},{profileId:'other-profile'},
    {principalId:'other-principal'},{conversationId:'other-chat'},
    {expiresAtMs:T0+999999},{ticket:'b'.repeat(64)},
    {source:'untrusted'},{verified:false}
  ])assert.equal(await bridge.authorizeTool({...actor,...change},invocation()),false);
  assert.equal(await bridge.authorizeTool(actor,invocation()),true);
});
test('owner revocation and regrant with new binding epoch immediately invalidate old ticket',async t=>{
  const {state,bridge}=scenario(t),old=await bridge.verifyCaller(TOKEN);
  assert.equal(await bridge.authorizeTool(old,invocation()),true);
  state.binding=null;
  assert.equal(await bridge.authorizeTool(old,invocation()),false);
  assert.equal(await bridge.verifyCaller(TOKEN),null);
  state.binding={
    source:'native-owner-attested',tokenSha256:TOKEN_SHA256,
    sessionHandle:'qa-chat',bindingId:'b'.repeat(64),ownerSidHash:OWNER_SID_HASH,expiresAtMs:T0+60000
  };
  const newer=await bridge.verifyCaller(TOKEN);
  assert.equal(newer?.verified,true);
  assert.notEqual(newer.ticket,old.ticket);
  assert.equal(await bridge.authorizeTool(old,invocation()),false);
  assert.equal(await bridge.authorizeTool(newer,invocation()),true);
});
test('expired consent revokes an existing ticket even if bearer token remains unexpired',async t=>{
  const {state,bridge}=scenario(t),actor=await bridge.verifyCaller(TOKEN);
  assert.equal(await bridge.authorizeTool(actor,invocation()),true);
  state.clock=T0+60001;
  assert.equal(await bridge.authorizeTool(actor,invocation()),false);
  assert.equal(await bridge.verifyCaller(TOKEN),null);
});
test('owner grant and exact invocation both fail closed on rejection',async t=>{
  const {state,bridge}=scenario(t),actor=await bridge.verifyCaller(TOKEN);
  state.grant=false;
  assert.equal(await bridge.authorizeTool(actor,invocation()),false);
  state.grant=true;
  state.authorize=false;
  assert.equal(await bridge.authorizeTool(actor,invocation()),false);
  state.authorize=true;
  assert.equal(await bridge.authorizeTool(actor,{rpcMethod:'tools/list',
    tool:'gui_cursor_position',arguments:{}}),false);
  assert.equal(await bridge.authorizeTool(actor,{rpcMethod:'tools/call',
    tool:'host-shell;unsafe',arguments:{}}),false);
});
test('revocation during asynchronous native owner callback never authorizes a mutation',async t=>{
  const {state,bridge}=scenario(t),actor=await bridge.verifyCaller(TOKEN);
  state.authorize=async()=>{
    state.binding=null;
    return true;
  };
  assert.equal(await bridge.authorizeTool(actor,invocation()),false);
});
test('grant revoked during asynchronous policy callback never authorizes an effect',async t=>{
  const {state,bridge}=scenario(t),actor=await bridge.verifyCaller(TOKEN);
  state.authorize=async()=>{
    state.grant=false;
    return true;
  };
  assert.equal(await bridge.authorizeTool(actor,invocation()),false);
});
test('native route change during asynchronous policy invalidates the original ticket',async t=>{
  const {state,bridge}=scenario(t),actor=await bridge.verifyCaller(TOKEN);
  state.authorize=async()=>{
    state.route={...route(),operationId:'new-operation'};
    return true;
  };
  assert.equal(await bridge.authorizeTool(actor,invocation()),false);
});
test('argument authorization sees frozen data-only JSON, never mutable caller objects',async t=>{
  const {state,bridge}=scenario(t),actor=await bridge.verifyCaller(TOKEN);
  const args={nested:{items:[{value:1}]}};
  state.authorize=call=>{
    assert.equal(Object.isFrozen(call.arguments),true);
    assert.equal(Object.isFrozen(call.arguments.nested.items[0]),true);
    assert.equal(call.arguments.nested.items[0].value,1);
    return true;
  };
  assert.equal(await bridge.authorizeTool(actor,invocation(args)),true);
});
test('owner policy cannot approve an argument snapshot then dispatch mutated raw arguments',async t=>{
  const {state,bridge}=scenario(t);
  const actor=await bridge.verifyCaller(TOKEN);
  const args={nested:{items:[{value:1}]}};
  state.authorize=async call=>{
    assert.equal(call.arguments.nested.items[0].value,1);
    args.nested.items[0].value=99; // untrusted mutation during await
    return true;
  };
  assert.equal(await bridge.authorizeTool(actor,invocation(args)),false);
});
test('cyclic, accessors, prototype keys, and non-finite invocation data are denied',async t=>{
  const {bridge}=scenario(t),actor=await bridge.verifyCaller(TOKEN);
  const cycle={};cycle.loop=cycle;
  const accessor={};Object.defineProperty(accessor,'value',{enumerable:true,get(){throw Error('getter must not execute');}});
  const prototypeKey=Object.create(null);prototypeKey.__proto__='malformed';
  for(const args of [
    cycle,accessor,prototypeKey,{value:Infinity},{value:NaN},
    {items:[,,,]},{value:()=>1}
  ])assert.equal(await bridge.authorizeTool(actor,invocation(args)),false);
});

test('native bridge enforces an encoded 64 KiB authorization-argument limit beyond node/depth caps',async t=>{
  const {bridge}=scenario(t);
  const actor=await bridge.verifyCaller(TOKEN);
  assert.equal(await bridge.authorizeTool(actor,invocation({value:'A'.repeat(60000)})),true);
  for(const args of [
    {value:'A'.repeat(70000)},
    {value:'\\u0000'.repeat(15000)},
    {partA:'a'.repeat(34000),partB:'b'.repeat(34000)}
  ])assert.equal(await bridge.authorizeTool(actor,invocation(args)),false);
});

test('owner policy cannot switch the tool or RPC method mid-flight',async t=>{
  const {state,bridge}=scenario(t);
  const actor=await bridge.verifyCaller(TOKEN);
  for(const mutation of [
    i=>{i.tool='gui_mouse_click';},
    i=>{i.rpcMethod='tools/list';}
  ]){
    const input=invocation({target:'qa-seat'});
    state.authorize=async()=>{mutation(input);return true;};
    assert.equal(await bridge.authorizeTool(actor,input),false);
  }
});

test('owner revocation during final asynchronous native-route read is denied',async t=>{
  const {state,bridge}=scenario(t);
  const actor=await bridge.verifyCaller(TOKEN);
  let routeReads=0;
  state.nativeRouteResolver=async()=>{
    routeReads++;
    if(routeReads===2)state.binding=null;
    return route();
  };
  assert.equal(await bridge.authorizeTool(actor,invocation()),false);
  assert.equal(routeReads,2);
});


test('hidden, symbol, or custom serialization fields cannot bypass owner JSON authorization', async t=>{
  const {bridge}=scenario(t),actor=await bridge.verifyCaller(TOKEN);
  const hidden={target:'read-only'};
  Object.defineProperty(hidden,'privileged',{value:true,enumerable:false});
  const symbol={target:'read-only'};
  symbol[Symbol('privileged')]=true;
  const nested={target:{safe:true}};
  Object.defineProperty(nested.target,'unsafe',{value:'effect',enumerable:false});
  const array={target:['safe']};
  Object.defineProperty(array.target,'hidden',{value:'effect',enumerable:false});
  const serializer={target:'read-only'};
  let called=0;
  Object.defineProperty(serializer,'toJSON',{value:()=>{
    called++;
    return {target:'privileged'};
  },enumerable:false});
  const disguised=new Proxy({target:'read-only'},{
    get(target,key,receiver){
      if(key==='target')return 'privileged';
      return Reflect.get(target,key,receiver);
    }
  });
  for(const args of [hidden,symbol,nested,array,serializer,disguised]){
    assert.equal(await bridge.authorizeTool(actor,invocation(args)),false);
  }
  assert.equal(called,0,'JSON accessors on raw arguments must not execute');
});


test('OAuth token expiry is pinned before awaited principal resolution',async t=>{
  const {state,bridge}=scenario(t);
  state.claims.expiresAtMs=T0+1000;
  state.principalResolver=async subject=>{
    state.claims.expiresAtMs=T0+80000;
    return subject==='qa-subject'?'qa-principal':null;
  };
  const actor=await bridge.verifyCaller(TOKEN);
  assert.equal(actor?.verified,true);
  assert.equal(actor?.expiresAtMs,T0+1000,
    'mutable verifier claim cannot lengthen signed token lifetime after await');
});

test('ticket reuse never returns an expired ticket when native lookup advances clock',async t=>{
  const {state,bridge}=scenario(t);
  const first=await bridge.verifyCaller(TOKEN);
  assert.equal(first.expiresAtMs,T0+30000);
  state.clock=T0+29999;
  state.nativeRouteResolver=async()=>{
    state.clock+=2;
    return route();
  };
  const second=await bridge.verifyCaller(TOKEN);
  assert.equal(second?.verified,true);
  assert.ok(second.expiresAtMs>state.clock,'reissued ticket must not already be expired');
  assert.notEqual(second.ticket,first.ticket,'expired ticket must never be reused');
});


test('owner approval compares numeric arguments without JSON negative-zero collision',async t=>{
  const {state,bridge}=scenario(t);
  const actor=await bridge.verifyCaller(TOKEN);
  for(const [prior,mutated] of [[0,-0],[-0,0]]){
    const original=invocation({position:{x:prior,y:5}});
    state.authorize=async call=>{
      assert.equal(Object.is(call.arguments.position.x,prior),true);
      original.arguments.position.x=mutated;
      return true;
    };
    assert.equal(await bridge.authorizeTool(actor,original),false,
      'JS payload changed although both values encode as JSON 0');
  }
});


test('expired ticket cannot succeed when the final awaited native route crosses the deadline',async t=>{
  const {state,bridge}=scenario(t);
  const actor=await bridge.verifyCaller(TOKEN);
  assert.equal(actor.expiresAtMs,T0+30000);
  state.clock=T0+29999;
  let reads=0;
  state.nativeRouteResolver=async()=>{
    reads++;
    if(reads===2)state.clock=T0+30001;
    return route();
  };
  assert.equal(await bridge.authorizeTool(actor,invocation()),false);
  assert.equal(reads,2,'authorization must reach and guard final native lookup');
});


test('closing the bridge during awaited owner policy immediately invalidates a checked ticket',async t=>{
  const {state,bridge}=scenario(t);
  const actor=await bridge.verifyCaller(TOKEN);
  state.authorize=async()=>{
    bridge.close();
    return true;
  };
  assert.equal(await bridge.authorizeTool(actor,invocation()),false);
  assert.equal(bridge.activeTickets,0);
});


test('closed Router bridge never reissues tickets even if owner grant remains valid',async t=>{
  const {bridge}=scenario(t);
  const first=await bridge.verifyCaller(TOKEN);
  assert.equal(first?.verified,true);
  bridge.close();
  assert.equal(await bridge.verifyCaller(TOKEN),null,
    'closed bridge must not mint fresh admission tickets');
  assert.equal(bridge.activeTickets,0);
  assert.equal(await bridge.authorizeTool(first,invocation()),false);
  bridge.close();
});

test('shutdown while OAuth principal resolution awaits cannot mint a new ticket',async t=>{
  const {state,bridge}=scenario(t);
  state.principalResolver=async subject=>{
    bridge.close();
    return subject==='qa-subject'?'qa-principal':null;
  };
  assert.equal(await bridge.verifyCaller(TOKEN),null);
  assert.equal(bridge.activeTickets,0);
});

test('read-only worker owner projection exposes exact native binding epoch and canonical route',async t=>{
  const {state,bridge}=scenario(t);
  const actor=await bridge.verifyCaller(TOKEN);
  const context=await bridge.resolveOwnerContext(TOKEN);
  const routeValue=await bridge.resolveOwnerRoute(TOKEN);
  assert.equal(context.source,'native-owner-attested');
  assert.equal(context.hostId,'qa-host');
  assert.equal(context.profileId,'qa-profile');
  assert.equal(context.principalId,'qa-principal');
  assert.equal(context.conversationId,'qa-chat');
  assert.equal(context.bindingId,'a'.repeat(64));
  assert.equal(context.ownerSidHash,OWNER_SID_HASH);
  assert.equal(context.expiresAtMs,actor.expiresAtMs);
  assert.equal(JSON.stringify(routeValue),JSON.stringify(state.route));
  assert.equal(Object.hasOwn(context,'tokenSha256'),false);
  assert.equal(Object.hasOwn(context,'sessionHandle'),false);
  assert.equal(Object.hasOwn(context,'accessToken'),false);
});

test('read-only worker owner projection fails closed after owner epoch revocation or bridge shutdown',async t=>{
  const {state,bridge}=scenario(t);
  assert.ok(await bridge.resolveOwnerContext(TOKEN));
  assert.ok(await bridge.resolveOwnerRoute(TOKEN));
  state.binding=null;
  assert.equal(await bridge.resolveOwnerContext(TOKEN),null);
  assert.equal(await bridge.resolveOwnerRoute(TOKEN),null);
  state.binding={
    source:'native-owner-attested',tokenSha256:TOKEN_SHA256,
    sessionHandle:'qa-chat',bindingId:'b'.repeat(64),
    ownerSidHash:OWNER_SID_HASH,expiresAtMs:T0+60000
  };
  assert.equal((await bridge.resolveOwnerContext(TOKEN)).bindingId,'b'.repeat(64));
  bridge.close();
  assert.equal(await bridge.resolveOwnerContext(TOKEN),null);
  assert.equal(await bridge.resolveOwnerRoute(TOKEN),null);
});
