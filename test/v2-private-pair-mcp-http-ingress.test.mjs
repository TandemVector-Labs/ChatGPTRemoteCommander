import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createV2PrivatePairMcpIngress} from '../src/v2-private-pair-mcp-http-ingress.mjs';

const route=()=>({hostId:'pc1',profileId:'profileA',
  principalId:'accountA',conversationId:'chat1',operationId:'step1',
  target:{kind:'workflow-root',id:'project1'}});
const envelope=(method,params={},id=1)=>({jsonrpc:'2.0',id,method,params});
const tool=(name,argumentsValue)=>envelope('tools/call',{
  name,arguments:argumentsValue,_meta:{'openai/session':'chat1'}
});
function makeRequest(message,{tls=true,authorized=true,headers=[],url='/mcp',
  method='POST',raw=null}={}){
  const body=raw??JSON.stringify(message);
  const contents=Buffer.from(body);
  let delivered=false;
  const req=new Readable({read(){
    if(delivered)return;
    delivered=true;this.push(contents);this.push(null);
  }});
  req.socket={encrypted:tls,authorized};
  req.url=url;req.method=method;
  req.rawHeaders=['Content-Type','application/json',...headers];
  return req;
}
function response(){
  const r={status:null,headers:null,buffer:null};
  r.writeHead=(status,headers)=>{r.status=status;r.headers=headers;};
  r.end=data=>{r.buffer=data??'';};
  return r;
}
function fixture(){
  const state={attested:0,bound:0,operations:0};
  const ingress=createV2PrivatePairMcpIngress({
    resolveTrustedConversation:async()=>({source:'native-conversation-attested',sessionHandle:'chat1'}),
    attestTransport:async()=>{state.attested++;return {
      authenticated:true,peerType:'owner-pinned-private-tunnel-mtls',
      sessionSource:'native-owner-private-pair'
    };},
    ownerStack:{requestOwnerBinding:async({sessionHandle})=>{
      assert.equal(sessionHandle,'chat1');state.bound++;return {bindingId:'secret'};
    }},
    operationGate:{execute:async({route:r,tool,arguments:args})=>{
      state.operations++;
      assert.equal(r.conversationId,'chat1');
      assert.equal(tool,'run_shell');assert.equal(args.command,'echo safe');
      return {ok:true};
    }}
  });
  const send=async(msg,options={})=>{
    const res=response();
    await ingress.handle(makeRequest(msg,options),res);
    return {status:res.status,data:res.buffer?JSON.parse(String(res.buffer)):null,
      headers:res.headers};
  };
  return {state,ingress,send};
}

test('PRIVATE MCP exposes discovery only over independently trusted mTLS',async()=>{
  const f=fixture();
  const noTLS=await f.send(envelope('tools/list'),{tls:false});
  assert.equal(noTLS.status,403);
  assert.equal(f.state.attested,0);
  const badClient=await f.send(envelope('tools/list'),{authorized:false});
  assert.equal(badClient.status,403);
  const list=await f.send(envelope('tools/list'));
  assert.equal(list.status,200);
  assert.deepEqual(list.data.result.tools.map(t=>t.name),
    ['v2_private_owner_bind','v2_workflow_step']);
  assert.equal(f.state.bound,0);
  assert.equal(f.state.operations,0);
  assert.equal(list.headers['cache-control'],'no-store');
});

test('PRIVATE MCP only explicitly prompts J01 on owner_bind and does not leak the native token',async()=>{
  const f=fixture();
  const denied=await f.send(tool('v2_private_owner_bind',{extra:1}));
  assert.equal(denied.data.result.isError,true);
  assert.equal(f.state.bound,0);
  const accepted=await f.send(tool('v2_private_owner_bind',{}));
  assert.equal(accepted.status,200);
  assert.equal(accepted.data.result.isError,false);
  assert.equal(f.state.bound,1);
  assert.equal(f.state.operations,0);
  assert.doesNotMatch(JSON.stringify(accepted.data),/bindingId|secret/);
});

test('PRIVATE MCP workflow calls pass exact route and arguments only to native owner gate',async()=>{
  const f=fixture();
  const correct=await f.send(tool('v2_workflow_step',{
    route:route(),tool:'run_shell',arguments:{command:'echo safe'}
  }));
  assert.equal(correct.data.result.isError,false);
  assert.equal(f.state.operations,1);
  const otherChat=await f.send(tool('v2_workflow_step',{
    route:{...route(),conversationId:'chat2'},
    tool:'run_shell',arguments:{command:'echo safe'}
  }));
  assert.equal(otherChat.data.result.isError,true);
  assert.equal(f.state.operations,1);
  const missingSession=await f.send(envelope('tools/call',{
    name:'v2_workflow_step',arguments:{
      route:route(),tool:'run_shell',arguments:{command:'echo safe'}
    }
  }));
  assert.equal(missingSession.status,200);
  assert.equal(f.state.operations,2,
    'an absent caller session hint is valid when native sideband independently attests the chat');
});

test('private gateway refuses Authorization bearer, duplicate header, plain HTTP and unknown tools',async()=>{
  const f=fixture();
  const request=tool('v2_workflow_step',{
    route:route(),tool:'run_shell',arguments:{command:'echo safe'}
  });
  for(const config of [
    {headers:['Authorization','Bearer forged']},
    {headers:['Content-Type','application/json']},
    {url:'/mcp?tool=run_shell'}, {tls:false}
  ]){
    const out=await f.send(request,config);
    assert.notEqual(out.status,200);
  }
  const unknown=await f.send(tool('power_shell',{}));
  assert.equal(unknown.data.result.isError,true);
  assert.equal(f.state.operations,0);
});

test('failed native grant or consent must not become a successful MCP result',async()=>{
  const ingress=createV2PrivatePairMcpIngress({
    resolveTrustedConversation:async()=>({source:'native-conversation-attested',sessionHandle:'chat1'}),
    attestTransport:async()=>({authenticated:true,
      peerType:'owner-pinned-private-tunnel-mtls',
      sessionSource:'native-owner-private-pair'}),
    ownerStack:{requestOwnerBinding:async()=>{throw Error('no native owner consent');}},
    operationGate:{execute:async()=>{throw Error('no signed current grant');}}
  });
  for(const msg of [
    tool('v2_private_owner_bind',{}),
    tool('v2_workflow_step',{
      route:route(),tool:'run_shell',arguments:{command:'echo safe'}
    })
  ]){
    const res=response();
    await ingress.handle(makeRequest(msg),res);
    assert.equal(res.status,503);
    assert.deepEqual(JSON.parse(String(res.buffer)),
      {error:'private_owner_admission_unavailable'});
  }
});

test('malformed bodies, oversized requests, unknown methods and missing TLS fail closed',async()=>{
  const f=fixture();
  const broken=await f.send(null,{raw:'{invalid'});
  assert.equal(broken.status,503);
  const large=await f.send(null,{raw:JSON.stringify({
    jsonrpc:'2.0',id:1,method:'tools/list',padding:'x'.repeat(67000)
  })});
  assert.equal(large.status,503);
  const unknown=await f.send(envelope('resources/list'));
  assert.equal(unknown.data.result.isError,true);
  assert.equal(f.state.operations,0);
  assert.throws(()=>createV2PrivatePairMcpIngress({}),
    {code:'V2_PRIVATE_MCP_TRUSTED_BOOTSTRAP_REQUIRED'});
});

test('one private Tunnel advertises multiple Core tools and resolves native route independently',async()=>{
  const log={canonical:0,validated:0,executed:0};
  const catalog=['read_text','gui_click','browser_navigate'].map(name=>({
    name,description:'Owner-scoped '+name,
    inputSchema:{type:'object',additionalProperties:false,properties:{
      path:{type:'string'},url:{type:'string'}
    }}
  }));
  const ingress=createV2PrivatePairMcpIngress({
    resolveTrustedConversation:async()=>({source:'native-conversation-attested',sessionHandle:'chat1'}),
    attestTransport:async()=>({
      authenticated:true,peerType:'owner-pinned-private-tunnel-mtls',
      sessionSource:'native-owner-private-pair'
    }),
    ownerStack:{
      requestOwnerBinding:async()=>{},
      nativeSessionBindings:{resolveNativeRoute:async session=>{
        log.canonical++;
        assert.equal(session,'chat1');
        return route();
      }}
    },
    operationGate:{execute:async command=>{
      log.executed++;
      assert.equal(command.route.operationId,'exact-read-1');
      assert.equal(command.route.conversationId,'chat1');
      assert.equal(command.tool,'read_text');
      assert.equal(command.arguments.path,'README.md');
      return {content:'ok'};
    }},
    trustedToolCatalog:catalog,
    validateToolInput:async(name,args)=>{
      log.validated++;
      return name==='read_text'&&args?.path==='README.md';
    },
    resolveTrustedToolRoute:async({sessionHandle,nativeRoute,tool})=>{
      assert.equal(sessionHandle,'chat1');
      assert.equal(tool,'read_text');
      return {...nativeRoute,operationId:'exact-read-1'};
    }
  });
  const send=async msg=>{
    const res=response();
    await ingress.handle(makeRequest(msg),res);
    return {status:res.status,data:JSON.parse(String(res.buffer))};
  };
  const listed=await send(envelope('tools/list'));
  assert.equal(listed.status,200);
  assert.deepEqual(listed.data.result.tools.map(t=>t.name),[
    'v2_private_owner_bind','v2_workflow_step',
    'read_text','gui_click','browser_navigate'
  ]);
  assert.equal(log.canonical,0);
  const invalid=await send(tool('read_text',{path:'/invalid'}));
  assert.equal(invalid.data.result.isError,true);
  assert.equal(log.executed,0);
  const accepted=await send(tool('read_text',{path:'README.md'}));
  assert.equal(accepted.data.result.isError,false);
  assert.equal(log.canonical,1);
  assert.equal(log.executed,1);
  assert.equal(log.validated,2);
});

test('a full Core catalog requires a trusted native route and input validator',()=>{
  const trustedToolCatalog=[{
    name:'read_text',description:'read one file',
    inputSchema:{type:'object',properties:{path:{type:'string'}}}
  }];
  const deps={
    resolveTrustedConversation:async()=>({source:'native-conversation-attested',sessionHandle:'chat1'}),
    attestTransport:async()=>({authenticated:true}),
    ownerStack:{requestOwnerBinding:async()=>{}},
    operationGate:{execute:async()=>({})},trustedToolCatalog
  };
  assert.throws(()=>createV2PrivatePairMcpIngress(deps),
    {code:'V2_PRIVATE_MCP_CANONICAL_ROUTE_REQUIRED'});
  deps.ownerStack.nativeSessionBindings={resolveNativeRoute:async()=>route()};
  assert.throws(()=>createV2PrivatePairMcpIngress(deps),
    {code:'V2_PRIVATE_MCP_INPUT_VALIDATOR_REQUIRED'});
  deps.validateToolInput=async()=>true;
  assert.throws(()=>createV2PrivatePairMcpIngress(deps),
    {code:'V2_PRIVATE_MCP_TRUSTED_OPERATION_ROUTE_REQUIRED'});
  deps.resolveTrustedToolRoute=async({nativeRoute})=>({...nativeRoute,operationId:'action-1'});
  for(const invalid of [
    [{...trustedToolCatalog[0],name:'v2_workflow_step'}],
    [trustedToolCatalog[0],trustedToolCatalog[0]],
    [{...trustedToolCatalog[0],name:'ReadText'}],
    [new Proxy(trustedToolCatalog[0],{})],
    [Object.defineProperty({...trustedToolCatalog[0]},'name',{
      enumerable:true,get(){throw Error('getter');}
    })]
  ])assert.throws(()=>createV2PrivatePairMcpIngress({
    ...deps,trustedToolCatalog:invalid
  }),{code:'V2_PRIVATE_MCP_CATALOG_INVALID'});
});

test('native resolver cannot redirect a private Core tool to a different chat',async()=>{
  let executed=0;
  const ingress=createV2PrivatePairMcpIngress({
    resolveTrustedConversation:async()=>({source:'native-conversation-attested',sessionHandle:'chat1'}),
    attestTransport:async()=>({authenticated:true,
      peerType:'owner-pinned-private-tunnel-mtls',
      sessionSource:'native-owner-private-pair'}),
    ownerStack:{
      requestOwnerBinding:async()=>{},
      nativeSessionBindings:{resolveNativeRoute:async()=>({
        ...route(),conversationId:'other-chat'
      })}
    },
    operationGate:{execute:async()=>{executed++;return {ok:true};}},
    trustedToolCatalog:[{
      name:'read_text',description:'owner read',
      inputSchema:{type:'object',properties:{path:{type:'string'}}}
    }],
    validateToolInput:async()=>true,
    resolveTrustedToolRoute:async({nativeRoute})=>({...nativeRoute,operationId:'action-1'})
  });
  const res=response();
  await ingress.handle(makeRequest(tool('read_text',{path:'README.md'})),res);
  assert.equal(res.status,403);
  assert.equal(JSON.parse(String(res.buffer)).error,'private_session_route_mismatch');
  assert.equal(executed,0);
});

test('large owner-approved Core catalog remains available on one PRIVATE Tunnel',async()=>{
  const catalog=Array.from({length:48},(_,i)=>({
    name:'core_tool_'+i,description:'owner scoped '+('x'.repeat(1600)),
    inputSchema:{type:'object',additionalProperties:false,properties:{}}
  }));
  const ingress=createV2PrivatePairMcpIngress({
    resolveTrustedConversation:async()=>({source:'native-conversation-attested',sessionHandle:'chat1'}),
    attestTransport:async()=>({authenticated:true,
      peerType:'owner-pinned-private-tunnel-mtls',
      sessionSource:'native-owner-private-pair'}),
    ownerStack:{requestOwnerBinding:async()=>{},
      nativeSessionBindings:{resolveNativeRoute:async()=>route()}},
    operationGate:{execute:async()=>({ok:true})},
    trustedToolCatalog:catalog,validateToolInput:async()=>false,
    resolveTrustedToolRoute:async({nativeRoute})=>({...nativeRoute,operationId:'action-1'})
  });
  const res=response();
  await ingress.handle(makeRequest(envelope('tools/list')),res);
  assert.equal(res.status,200);
  assert.ok(Number(res.headers['content-length'])>65536);
  assert.equal(JSON.parse(String(res.buffer)).result.tools.length,50);
});

test('direct operations require distinct owner-issued routes, not a reused J01 enrollment or JSON-RPC id',async()=>{
  const seen=[];
  const ingress=createV2PrivatePairMcpIngress({
    resolveTrustedConversation:async()=>({source:'native-conversation-attested',sessionHandle:'chat1'}),
    attestTransport:async()=>({authenticated:true,
      peerType:'owner-pinned-private-tunnel-mtls',sessionSource:'native-owner-private-pair'}),
    ownerStack:{requestOwnerBinding:async()=>{},
      nativeSessionBindings:{resolveNativeRoute:async()=>route()}},
    operationGate:{execute:async({route:r})=>{
      seen.push(r.operationId);return {done:r.operationId};
    }},
    trustedToolCatalog:[{name:'read_text',description:'owner read',
      inputSchema:{type:'object',properties:{requestId:{type:'string'}}}}],
    validateToolInput:async(_tool,args)=>args?.requestId==='action1'||args?.requestId==='action2',
    // Only a trusted owner worker can select the exact operation route.
    resolveTrustedToolRoute:async({nativeRoute,tool,arguments:args})=>{
      assert.equal(tool,'read_text');assert.equal(nativeRoute.operationId,'step1');
      return {...nativeRoute,operationId:args.requestId};
    }
  });
  for(const action of ['action1','action2']){
    const res=response();
    // Deliberately same JSON-RPC ID on both completed requests:
    // the current MCP specification does not promise lifetime uniqueness.
    await ingress.handle(makeRequest(tool('read_text',{requestId:action})),res);
    assert.equal(res.status,200);
    assert.equal(JSON.parse(String(res.buffer)).result.isError,false);
  }
  assert.deepEqual(seen,['action1','action2']);
});

test('trusted operation route cannot change native owner host, profile or chat',async()=>{
  for(const changed of [
    {hostId:'otherHost'},{profileId:'otherProfile'},
    {principalId:'otherPrincipal'},{conversationId:'otherChat'}
  ]){
    let effects=0;
    const ingress=createV2PrivatePairMcpIngress({
      resolveTrustedConversation:async()=>({source:'native-conversation-attested',sessionHandle:'chat1'}),
      attestTransport:async()=>({authenticated:true,
        peerType:'owner-pinned-private-tunnel-mtls',sessionSource:'native-owner-private-pair'}),
      ownerStack:{requestOwnerBinding:async()=>{},
        nativeSessionBindings:{resolveNativeRoute:async()=>route()}},
      operationGate:{execute:async()=>{effects++;return {ok:true};}},
      trustedToolCatalog:[{name:'read_text',description:'owner read',
        inputSchema:{type:'object',properties:{path:{type:'string'}}}}],
      validateToolInput:async()=>true,
      resolveTrustedToolRoute:async({nativeRoute})=>({...nativeRoute,
        operationId:'action1',...changed})
    });
    const res=response();
    await ingress.handle(makeRequest(tool('read_text',{path:'README.md'})),res);
    assert.equal(res.status,403);
    assert.equal(JSON.parse(String(res.buffer)).error,'private_operation_route_mismatch');
    assert.equal(effects,0);
  }
});

const currentMeta=()=>({
  'io.modelcontextprotocol/protocolVersion':'2026-07-28',
  'io.modelcontextprotocol/clientCapabilities':{},
  'io.modelcontextprotocol/clientInfo':{name:'private-qa',version:'1.0.0'},
  'openai/session':'chat1'
});
function modernMessage(method,params={},id=1){
  return envelope(method,{...params,_meta:{...currentMeta(),...params._meta}},id);
}
function modernOptions(message){
  return {headers:[
    'MCP-Protocol-Version','2026-07-28',
    'Mcp-Method',message.method,
    ...(message.method==='tools/call'?['Mcp-Name',message.params.name]:[])
  ]};
}

test('PRIVATE MCP supports stateless modern 2026-07-28 discovery, list and exact owner-authorized tools',async()=>{
  const f=fixture();
  const discovery=modernMessage('server/discover');
  const found=await f.send(discovery,modernOptions(discovery));
  assert.equal(found.status,200);
  assert.equal(found.data.result.resultType,'complete');
  assert.ok(found.data.result.supportedVersions.includes('2026-07-28'));
  assert.equal(found.data.result.cacheScope,'private');
  assert.equal(found.data.result._meta['io.modelcontextprotocol/serverInfo'].version,'0.12.0-dev.9');
  assert.equal(f.state.bound,0);
  const list=modernMessage('tools/list');
  const tools=await f.send(list,modernOptions(list));
  assert.equal(tools.status,200);
  assert.equal(tools.data.result.resultType,'complete');
  assert.equal(tools.data.result.tools.length,2);
  assert.equal(tools.data.result.cacheScope,'private');
  assert.equal(f.state.bound,0);
  const bind=modernMessage('tools/call',{name:'v2_private_owner_bind',arguments:{}});
  const bound=await f.send(bind,modernOptions(bind));
  assert.equal(bound.status,200);
  assert.equal(bound.data.result.resultType,'complete');
  assert.equal(bound.data.result.isError,false);
  assert.equal(f.state.bound,1);
  assert.doesNotMatch(JSON.stringify(bound.data),/bindingId|secret/);
  const action=modernMessage('tools/call',{name:'v2_workflow_step',
    arguments:{route:route(),tool:'run_shell',arguments:{command:'echo safe'}}});
  const effect=await f.send(action,modernOptions(action));
  assert.equal(effect.status,200);
  assert.equal(effect.data.result.resultType,'complete');
  assert.equal(effect.data.result.isError,false);
  assert.equal(f.state.operations,1);
});

test('modern version, mirrored headers and capabilities fail closed with typed JSON-RPC errors',async()=>{
  const f=fixture();
  const valid=modernMessage('tools/list');
  const cases=[
    [valid,{headers:['Mcp-Method','tools/list']},-32020],
    [valid,{headers:['MCP-Protocol-Version','2025-11-25','Mcp-Method','tools/list']},-32020],
    [modernMessage('tools/list',{_meta:{
      'io.modelcontextprotocol/protocolVersion':'2040-01-01'
    }}),{headers:['MCP-Protocol-Version','2040-01-01','Mcp-Method','tools/list']},-32022],
    [modernMessage('tools/list',{_meta:{
      'io.modelcontextprotocol/clientCapabilities':null
    }}),modernOptions(valid),-32021],
    [modernMessage('tools/call',{name:'v2_private_owner_bind',arguments:{}}),
      {headers:['MCP-Protocol-Version','2026-07-28','Mcp-Method','tools/call',
        'Mcp-Name','v2_workflow_step']},-32020]
  ];
  for(const [message,config,code] of cases){
    const result=await f.send(message,config);
    assert.equal(result.status,400);
    assert.equal(result.data.jsonrpc,'2.0');
    assert.equal(result.data.error.code,code);
    assert.equal(result.data.result,undefined);
  }
  const unsupported=modernMessage('resources/list');
  const unknown=await f.send(unsupported,modernOptions(unsupported));
  assert.equal(unknown.status,404);
  assert.equal(unknown.data.error.code,-32601);
  assert.equal(f.state.bound,0);
  assert.equal(f.state.operations,0);
});

test('direct Core tools validate actual advertised schema even if host validator blindly approves',async()=>{
  const calls={validation:0,native:0,operation:0,effect:0};
  const ingress=createV2PrivatePairMcpIngress({
    resolveTrustedConversation:async()=>({source:'native-conversation-attested',sessionHandle:'chat1'}),
    attestTransport:async()=>({
      authenticated:true,peerType:'owner-pinned-private-tunnel-mtls',
      sessionSource:'native-owner-private-pair'
    }),
    ownerStack:{requestOwnerBinding:async()=>{},
      nativeSessionBindings:{resolveNativeRoute:async()=>{
        calls.native++;return route();
      }}},
    operationGate:{execute:async ({arguments:args})=>{
      calls.effect++;assert.equal(args.path,'README.md');return {ok:true};
    }},
    trustedToolCatalog:[{
      name:'read_text',description:'Read file via Core',
      inputSchema:{type:'object',additionalProperties:false,
        required:['path'],properties:{
          path:{type:'string',minLength:2},
          maxBytes:{type:'integer',minimum:1,maximum:4096}
        }}
    }],
    // This callback alone MUST NOT bypass the source Core schema.
    validateToolInput:async()=>{calls.validation++;return true;},
    resolveTrustedToolRoute:async({nativeRoute})=>{
      calls.operation++;return {...nativeRoute,operationId:'schema-test-1'};
    }
  });
  for(const bad of [
    {},{path:3},{path:'x'},{path:'README.md',other:'not-allowed'},
    {path:'README.md',maxBytes:0},{path:'README.md',maxBytes:4097},
    {path:'README.md',maxBytes:'1024'},[],false
  ]){
    const res=response();
    await ingress.handle(makeRequest(tool('read_text',bad)),res);
    assert.equal(res.status,200);
    assert.equal(JSON.parse(String(res.buffer)).result.isError,true);
  }
  assert.deepEqual(calls,{validation:0,native:0,operation:0,effect:0});
  const valid=response();
  await ingress.handle(makeRequest(tool('read_text',{
    path:'README.md',maxBytes:100
  })),valid);
  assert.equal(valid.status,200);
  assert.equal(JSON.parse(String(valid.buffer)).result.isError,false);
  assert.deepEqual(calls,{validation:1,native:1,operation:1,effect:1});
});

test('direct Core no-argument tool canonicalizes absent arguments before both callbacks',async()=>{
  let validated=null,received=null;
  const ingress=createV2PrivatePairMcpIngress({
    resolveTrustedConversation:async()=>({source:'native-conversation-attested',sessionHandle:'chat1'}),
    attestTransport:async()=>({
      authenticated:true,peerType:'owner-pinned-private-tunnel-mtls',
      sessionSource:'native-owner-private-pair'
    }),
    ownerStack:{requestOwnerBinding:async()=>{},
      nativeSessionBindings:{resolveNativeRoute:async()=>route()}},
    operationGate:{execute:async ({arguments:args})=>{
      received=args;return {ok:true};
    }},
    trustedToolCatalog:[{
      name:'system_status',description:'read-only',
      inputSchema:{type:'object',additionalProperties:false,properties:{}}
    }],
    validateToolInput:async(_name,args)=>{
      validated=args;return true;
    },
    resolveTrustedToolRoute:async({nativeRoute})=>({
      ...nativeRoute,operationId:'status-test-1'
    })
  });
  const res=response();
  await ingress.handle(makeRequest(tool('system_status',undefined)),res);
  assert.equal(res.status,200);
  assert.equal(JSON.parse(String(res.buffer)).result.isError,false);
  assert.equal(validated,received,
    'validator and operation gate must see the same immutable snapshot');
  assert.equal(Object.getPrototypeOf(validated),null);
  assert.equal(Object.isFrozen(validated),true);
  assert.deepEqual(Object.keys(received),[]);
});

test('immutable schema snapshot rejects mutation between validation and signed execution',async()=>{
  let effects=0,routeLookups=0;
  const ingress=createV2PrivatePairMcpIngress({
    resolveTrustedConversation:async()=>({source:'native-conversation-attested',sessionHandle:'chat1'}),
    attestTransport:async()=>({authenticated:true,
      peerType:'owner-pinned-private-tunnel-mtls',sessionSource:'native-owner-private-pair'}),
    ownerStack:{requestOwnerBinding:async()=>{},
      nativeSessionBindings:{resolveNativeRoute:async()=>{routeLookups++;return route();}}},
    operationGate:{execute:async()=>{effects++;return {ok:true};}},
    trustedToolCatalog:[{name:'read_text',description:'read one approved path',
      inputSchema:{type:'object',additionalProperties:false,required:['path','options'],
        properties:{
          path:{type:'string',enum:['README.md']},
          options:{type:'object',additionalProperties:false,required:['safe'],
            properties:{safe:{type:'boolean',enum:[true]}}}
        }}}],
    // A buggy / compromised trusted validator MUST NOT change what was
    // accepted by the original trusted Core schema before the effect.
    validateToolInput:async(_tool,args)=>{
      args.options.safe=false;
      return true;
    },
    resolveTrustedToolRoute:async({nativeRoute})=>({...nativeRoute,operationId:'mutated-1'})
  });
  const res=response();
  await ingress.handle(makeRequest(tool('read_text',{
    path:'README.md',options:{safe:true}
  })),res);
  assert.equal(effects,0,'mutation of validated nested args must never execute');
  assert.equal(routeLookups,0,'mutation must be rejected before native lookup');
  assert.ok(res.status===200||res.status===503);
});

test('a trusted route resolver cannot mutate the exact operation arguments before the grant',async()=>{
  let effects=0;
  const ingress=createV2PrivatePairMcpIngress({
    resolveTrustedConversation:async()=>({source:'native-conversation-attested',sessionHandle:'chat1'}),
    attestTransport:async()=>({authenticated:true,
      peerType:'owner-pinned-private-tunnel-mtls',sessionSource:'native-owner-private-pair'}),
    ownerStack:{requestOwnerBinding:async()=>{},
      nativeSessionBindings:{resolveNativeRoute:async()=>route()}},
    operationGate:{execute:async()=>{effects++;return {ok:true};}},
    trustedToolCatalog:[{name:'read_text',description:'read one approved path',
      inputSchema:{type:'object',additionalProperties:false,required:['path'],
        properties:{path:{type:'string',enum:['README.md']}}}}],
    validateToolInput:async()=>true,
    resolveTrustedToolRoute:async({arguments:args,nativeRoute})=>{
      args.path='forbidden.txt';
      return {...nativeRoute,operationId:'mutated-2'};
    }
  });
  const res=response();
  await ingress.handle(makeRequest(tool('read_text',{path:'README.md'})),res);
  assert.equal(effects,0);
});

test('caller metadata never establishes the real conversation without trusted sideband',async()=>{
  let effects=0,bindings=0,selected=0;
  const ingress=createV2PrivatePairMcpIngress({
    attestTransport:async()=>({authenticated:true,peerType:'owner-pinned-private-tunnel-mtls',
      sessionSource:'native-owner-private-pair'}),
    resolveTrustedConversation:async()=>{selected++;return {
      source:'native-conversation-attested',sessionHandle:'chat2'
    };},
    ownerStack:{requestOwnerBinding:async()=>{bindings++;},
      nativeSessionBindings:{resolveNativeRoute:async()=>route()}},
    operationGate:{execute:async()=>{effects++;return {ok:true};}}
  });
  // The existing pair client can claim another chat in JSON, but cannot
  // change a different owner-side independently attested conversation.
  for(const request of [
    tool('v2_private_owner_bind',{}),
    tool('v2_workflow_step',{route:route(),tool:'run_shell',
      arguments:{command:'echo unauthorized'}})
  ]){
    const res=response();
    await ingress.handle(makeRequest(request),res);
    assert.equal(res.status,403);
    assert.equal(JSON.parse(String(res.buffer)).error,'private_session_mismatch');
  }
  assert.equal(effects,0);
  assert.equal(bindings,0);
  assert.equal(selected,2);
});

test('a missing independently trusted conversation resolver cannot be masked by MCP metadata',()=>{
  assert.throws(()=>createV2PrivatePairMcpIngress({
    attestTransport:async()=>({authenticated:true,
      peerType:'owner-pinned-private-tunnel-mtls',sessionSource:'native-owner-private-pair'}),
    ownerStack:{requestOwnerBinding:async()=>{}},
    operationGate:{execute:async()=>{}}
  }),{code:'V2_PRIVATE_MCP_TRUSTED_CONVERSATION_REQUIRED'});
});

test('resolver result must be independently authenticated, not a forged object or optional MCP hint',async()=>{
  let effects=0,binds=0;
  const invalid=[
    null,{},'chat1',
    {source:'mcp-body',sessionHandle:'chat1'},
    {source:'native-conversation-attested',sessionHandle:'mcp-forged'},
    {source:'native-conversation-attested',sessionHandle:'chat1',extra:true},
    new Proxy({source:'native-conversation-attested',sessionHandle:'chat1'},{}),
    Object.defineProperty({source:'native-conversation-attested'},'sessionHandle',{
      enumerable:true,get(){throw Error('must not call accessors');}
    })
  ];
  for(const observed of invalid){
    const ingress=createV2PrivatePairMcpIngress({
      attestTransport:async()=>({authenticated:true,
        peerType:'owner-pinned-private-tunnel-mtls',
        sessionSource:'native-owner-private-pair'}),
      resolveTrustedConversation:async transport=>{
        assert.equal(transport.peerType,'owner-pinned-private-tunnel-mtls');
        return observed;
      },
      ownerStack:{requestOwnerBinding:async()=>{binds++;}},
      operationGate:{execute:async()=>{effects++;return {ok:true};}}
    });
    const res=response();
    await ingress.handle(makeRequest(tool('v2_private_owner_bind',{})),res);
    assert.equal(res.status,403);
    assert.equal(JSON.parse(String(res.buffer)).error,'private_session_required');
  }
  assert.equal(binds,0);
  assert.equal(effects,0);
});

test('owner-pinned pair consent is shared safely across multiple ChatGPT chat hints',async()=>{
  const pairHandle='owner-pair-1';
  const saved=[],effect=[];
  const ownerRoute=()=>({
    hostId:'pc1',profileId:'profileA',principalId:'accountA',
    conversationId:pairHandle,operationId:'enroll',
    target:{kind:'workflow-root',id:'project1'}
  });
  let grants=0;
  const ingress=createV2PrivatePairMcpIngress({
    attestTransport:async()=>({authenticated:true,
      peerType:'owner-pinned-private-tunnel-mtls',
      sessionSource:'native-owner-private-pair'}),
    resolveTrustedConversation:async()=>({
      source:'native-owner-pair-attested',sessionHandle:pairHandle
    }),
    ownerStack:{requestOwnerBinding:async ({sessionHandle})=>{
      assert.equal(sessionHandle,pairHandle);grants++;return {ok:true};
    },nativeSessionBindings:{resolveNativeRoute:async sessionHandle=>{
      assert.equal(sessionHandle,pairHandle);return ownerRoute();
    }}},
    operationGate:{execute:async({route:r,tool,arguments:args})=>{
      assert.equal(r.conversationId,pairHandle);
      assert.equal(tool,'read_text');
      effect.push(args.path);return {ok:true};
    }},
    trustedToolCatalog:[{name:'read_text',description:'read exact file',
      inputSchema:{type:'object',required:['path'],
        properties:{path:{type:'string',enum:['README.md']}},
        additionalProperties:false}}],
    validateToolInput:async()=>true,
    resolveTrustedToolRoute:async({sessionHandle,nativeRoute,tool})=>{
      assert.equal(sessionHandle,pairHandle);
      assert.equal(tool,'read_text');
      const operationId='pair-op-'+(saved.length+1);
      saved.push(operationId);
      return {...nativeRoute,operationId};
    }
  });
  const ownerBind=tool('v2_private_owner_bind',{});
  ownerBind.params._meta['openai/session']='chatC';
  const consent=response();
  await ingress.handle(makeRequest(ownerBind),consent);
  assert.equal(consent.status,200);
  assert.equal(grants,1);
  for(const chatHint of ['chatA','chatB']){
    const request=tool('read_text',{path:'README.md'});
    request.params._meta['openai/session']=chatHint;
    const res=response();
    await ingress.handle(makeRequest(request),res);
    assert.equal(res.status,200);
    assert.equal(JSON.parse(String(res.buffer)).result.isError,false);
  }
  assert.deepEqual(saved,['pair-op-1','pair-op-2']);
  assert.deepEqual(effect,['README.md','README.md']);
});

test('pair-attested identity still denies an invalid owner-side binding',async()=>{
  let effects=0;
  const ingress=createV2PrivatePairMcpIngress({
    attestTransport:async()=>({authenticated:true,
      peerType:'owner-pinned-private-tunnel-mtls',sessionSource:'native-owner-private-pair'}),
    resolveTrustedConversation:async()=>({
      source:'native-owner-pair-attested',sessionHandle:'invalid/host'
    }),
    ownerStack:{requestOwnerBinding:async()=>{effects++;}},
    operationGate:{execute:async()=>{effects++;}}
  });
  const res=response();
  await ingress.handle(makeRequest(tool('v2_private_owner_bind',{})),res);
  assert.equal(res.status,403);
  assert.equal(effects,0);
});
