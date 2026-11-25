// Private per-(account,host) MCP source candidate. Does NOT bind a port.
import {isProxy} from 'node:util/types';
import {normalizeV2Route} from './v2-routing-contract.mjs';
import {validateJsonSchema} from './schema-validator.mjs';
import {snapshotV2PrivateOperationArguments}
  from './v2-private-pair-operation-gate.mjs';
// On a protected TLS/mTLS host the exact pair is independently attested.
// No Authorization bearer, public OAuth issuer, per-service tunnel or legacy
// privileged HTTP fallback. Never grants OS rights: Native J01 and exact signed
// worker action grants remain mandatory at every protected tools/call.
const SESSION=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOOL=/^[a-z][a-z0-9_]{0,79}$/;
const RESERVED=new Set(['v2_private_owner_bind','v2_workflow_step']);
const MODERN_VERSION='2026-07-28';
const LEGACY_VERSIONS=Object.freeze(['2025-11-25']);
const SERVER_INFO=Object.freeze({name:'commander-v012-private-candidate',version:'0.12.0-dev.9'});
const SERVER_META=Object.freeze({'io.modelcontextprotocol/serverInfo':SERVER_INFO});
function snapshotTrustedCatalog(value){
  if(!Array.isArray(value)||isProxy(value)||value.length>512)
    fail('V2_PRIVATE_MCP_CATALOG_INVALID');
  const names=new Set([...RESERVED]);
  let bytes=0;
  const items=[];
  for(const item of value){
    if(!item||typeof item!=='object'||Array.isArray(item)||isProxy(item)
      ||![Object.prototype,null].includes(Object.getPrototypeOf(item)))
      fail('V2_PRIVATE_MCP_CATALOG_INVALID');
    for(const field of Reflect.ownKeys(item)){
      if(typeof field!=='string'||!['name','description','inputSchema',
        'annotations','outputSchema'].includes(field))
        fail('V2_PRIVATE_MCP_CATALOG_INVALID');
      const d=Object.getOwnPropertyDescriptor(item,field);
      if(!d||!d.enumerable||!Object.hasOwn(d,'value'))
        fail('V2_PRIVATE_MCP_CATALOG_INVALID');
    }
    if(typeof item.name!=='string'||!TOOL.test(item.name)
      ||names.has(item.name)||typeof item.description!=='string'
      ||item.description.length>4000
      ||!item.inputSchema||typeof item.inputSchema!=='object'
      ||Array.isArray(item.inputSchema)||isProxy(item.inputSchema)
      ||item.inputSchema.type!=='object')
      fail('V2_PRIVATE_MCP_CATALOG_INVALID');
    let serialized;
    try{serialized=JSON.stringify(item);}catch{fail('V2_PRIVATE_MCP_CATALOG_INVALID');}
    if(typeof serialized!=='string'||serialized.length>16384)
      fail('V2_PRIVATE_MCP_CATALOG_INVALID');
    bytes+=Buffer.byteLength(serialized);
    if(bytes>240000)fail('V2_PRIVATE_MCP_CATALOG_INVALID');
    const descriptor=JSON.parse(serialized);
    items.push(Object.freeze(descriptor));
    names.add(item.name);
  }
  return Object.freeze(items);
}

const fail=code=>{throw Object.assign(new Error(code),{code});};
function json(res,status,data,maxBytes=65536){
  let bytes;
  try{bytes=Buffer.from(JSON.stringify(data));}
  catch{bytes=Buffer.from('{"error":"candidate_unavailable"}');status=503;}
  if(bytes.length>maxBytes){
    bytes=Buffer.from('{"error":"result_too_large"}');
    status=503;
  }
  res.writeHead(status,{'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store','content-length':bytes.length});
  res.end(bytes);
}
function rpc(id,result,modern=false){
  return {jsonrpc:'2.0',id,result:modern
    ?{resultType:'complete',...result,_meta:SERVER_META}
    :result};
}
function error(id,modern=false){return rpc(id,{isError:true,content:[
  {type:'text',text:'Native owner and exact-action authorization required.'}
]},modern);}
function protocolFailure(status,code,message,data){
  const e=Object.assign(new Error(message),{httpStatus:status,rpcCode:code});
  if(data!==undefined)e.rpcData=data;
  throw e;
}
function header(req,name){
  let found=null;
  const raw=req.rawHeaders;
  if(!Array.isArray(raw)||raw.length%2!==0)fail('PRIVATE_MCP_HEADERS_INVALID');
  for(let i=0;i<raw.length;i+=2){
    const field=raw[i],value=raw[i+1];
    if(typeof field!=='string'||typeof value!=='string')
      fail('PRIVATE_MCP_HEADERS_INVALID');
    const key=field.toLowerCase();
    if(key===name){
      if(found!==null)fail('PRIVATE_MCP_DUPLICATE_HEADER');
      found=value;
    }
  }
  return found;
}
function classifyProtocol(req,message){
  const hv=header(req,'mcp-protocol-version');
  const meta=message?.params?._meta;
  const bv=meta?.['io.modelcontextprotocol/protocolVersion'];
  // 2026-07-28 requires matching per-request versions and mirrored headers;
  // only the old explicit handshake remains for legacy clients.
  if(bv!==undefined||hv===MODERN_VERSION){
    if(hv!==bv)
      protocolFailure(400,-32020,'MCP protocol header/body mismatch');
    if(bv!==MODERN_VERSION)
      protocolFailure(400,-32022,'Unsupported MCP protocol version',
        {supported:[MODERN_VERSION,...LEGACY_VERSIONS],requested:String(bv)});
    if(!meta||typeof meta!=='object'||Array.isArray(meta))
      protocolFailure(400,-32021,'Missing required modern MCP client capabilities');
    const caps=meta['io.modelcontextprotocol/clientCapabilities'];
    if(!caps||typeof caps!=='object'||Array.isArray(caps))
      protocolFailure(400,-32021,'Missing required modern MCP client capabilities');
    const info=meta['io.modelcontextprotocol/clientInfo'];
    if(info!==undefined&&(!info||typeof info!=='object'||Array.isArray(info)
        ||typeof info.name!=='string'||typeof info.version!=='string'))
      protocolFailure(400,-32602,'Malformed modern MCP clientInfo');
    if(header(req,'mcp-method')!==message.method)
      protocolFailure(400,-32020,'Mcp-Method header/body mismatch');
    if(message.method==='tools/call'
      &&header(req,'mcp-name')!==message.params?.name)
      protocolFailure(400,-32020,'Mcp-Name header/body mismatch');
    if(typeof message.id!=='string'&&!Number.isSafeInteger(message.id))
      protocolFailure(400,-32600,'Invalid JSON-RPC request id');
    return true;
  }
  if(hv!==null&&!LEGACY_VERSIONS.includes(hv))
    protocolFailure(400,-32022,'Unsupported MCP protocol version',
      {supported:[MODERN_VERSION,...LEGACY_VERSIONS],requested:String(hv)});
  return false;
}
function exactTrustedConversation(value){
  // Only the owner-side transport/session provider may supply this value.
  // MCP body _meta and caller-controlled headers are NEVER identity proofs.
  const fields=['source','sessionHandle'];
  if(!value||typeof value!=='object'||Array.isArray(value)||isProxy(value)
    ||![Object.prototype,null].includes(Object.getPrototypeOf(value))
    ||Reflect.ownKeys(value).length!==fields.length)
    return null;
  const out=Object.create(null);
  for(const field of fields){
    const d=Object.getOwnPropertyDescriptor(value,field);
    if(!d||!d.enumerable||!Object.hasOwn(d,'value'))return null;
    out[field]=d.value;
  }
  // Either a true owner-attested per-conversation handle, OR the stable
  // owner-attested account+host PAIR scope. A pair cannot claim to authenticate
  // its individual ChatGPT chats; only signed native per-action grants authorize
  // effects for every chat using that same exclusive Tunnel.
  if(!['native-conversation-attested','native-owner-pair-attested']
    .includes(out.source)
    ||typeof out.sessionHandle!=='string'||!SESSION.test(out.sessionHandle)
    ||out.sessionHandle==='.'||out.sessionHandle==='..'
    ||out.sessionHandle.startsWith('mcp-'))return null;
  return Object.freeze({
    sessionHandle:out.sessionHandle,
    scope:out.source==='native-owner-pair-attested'?'pair':'conversation'
  });
}
async function payload(req,limit){
  const type=header(req,'content-type');
  if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(type??''))
    fail('PRIVATE_MCP_CONTENT_TYPE');
  if(header(req,'authorization')!==null)
    fail('PRIVATE_MCP_AUTH_BEARER_NOT_ACCEPTED');
  const length=header(req,'content-length');
  if(length!==null&&(!/^\d{1,10}$/.test(length)||Number(length)>limit))
    fail('PRIVATE_MCP_BODY_BOUNDS');
  let lengthSeen=0;
  const chunks=[];
  for await(const chunk of req){
    lengthSeen+=chunk.length;
    if(lengthSeen>limit)fail('PRIVATE_MCP_BODY_BOUNDS');
    chunks.push(chunk);
  }
  if(lengthSeen<2)fail('PRIVATE_MCP_JSON_REQUIRED');
  let parsed;
  try{parsed=JSON.parse(Buffer.concat(chunks,lengthSeen).toString('utf8'));}
  catch{fail('PRIVATE_MCP_JSON_REQUIRED');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)
    ||parsed.jsonrpc!=='2.0'||typeof parsed.method!=='string')
    fail('PRIVATE_MCP_RPC_INVALID');
  return parsed;
}

const TOOLS=Object.freeze([
  Object.freeze({
    name:'v2_private_owner_bind',
    description:'Request native OS-owner approval for this exact private conversation; grants no tool privileges.',
    inputSchema:{type:'object',additionalProperties:false,properties:{}}
  }),
  Object.freeze({
    name:'v2_workflow_step',
    description:'Execute one owner-authorized, revocable workflow action on this exact host and private pair.',
    inputSchema:{type:'object',additionalProperties:false,
      required:['route','tool','arguments'],
      properties:{
        route:{type:'object'},tool:{type:'string'},arguments:{type:'object'}
      }}
  })
]);

export function createV2PrivatePairMcpIngress({
  attestTransport,resolveTrustedConversation,ownerStack,operationGate,
  trustedToolCatalog=[],validateToolInput,resolveTrustedToolRoute,
  maxBodyBytes=65536
}={}){
  if(typeof attestTransport!=='function'
    ||typeof ownerStack?.requestOwnerBinding!=='function'
    ||typeof operationGate?.execute!=='function'
    ||!Number.isSafeInteger(maxBodyBytes)||maxBodyBytes<1024
    ||maxBodyBytes>262144)
    fail('V2_PRIVATE_MCP_TRUSTED_BOOTSTRAP_REQUIRED');
  if(typeof resolveTrustedConversation!=='function')
    fail('V2_PRIVATE_MCP_TRUSTED_CONVERSATION_REQUIRED');
  const catalog=snapshotTrustedCatalog(trustedToolCatalog);
  if(catalog.length>0&&typeof ownerStack?.nativeSessionBindings?.resolveNativeRoute!=='function')
    fail('V2_PRIVATE_MCP_CANONICAL_ROUTE_REQUIRED');
  if(catalog.length>0&&typeof validateToolInput!=='function')
    fail('V2_PRIVATE_MCP_INPUT_VALIDATOR_REQUIRED');
  if(catalog.length>0&&typeof resolveTrustedToolRoute!=='function')
    fail('V2_PRIVATE_MCP_TRUSTED_OPERATION_ROUTE_REQUIRED');
  const schemas=new Map(catalog.map(item=>[item.name,item.inputSchema]));
  const names=new Set([...RESERVED,...catalog.map(x=>x.name)]);
  const availableTools=Object.freeze([...TOOLS,...catalog]);
  async function handle(req,res){
    let rpcId=null;
    try{
      // There is intentionally no createUnboundServer, plaintext fallback,
      // proxy scheme or OAuth route in this source candidate.
      if(!req?.socket||req.socket.encrypted!==true
        ||req.socket.authorized!==true){
        json(res,403,{error:'trusted_transport_required'});return;
      }
      if(req.url!=='/mcp'){
        json(res,404,{error:'not_found'});return;
      }
      if(req.method!=='POST'){
        json(res,405,{error:'method_not_allowed'});return;
      }
      const attested=await attestTransport(req);
      if(attested?.authenticated!==true
        ||attested.peerType!=='owner-pinned-private-tunnel-mtls'
        ||attested.sessionSource!=='native-owner-private-pair'){
        json(res,403,{error:'trusted_transport_required'});return;
      }
      const message=await payload(req,maxBodyBytes);
      const id=(typeof message.id==='string'&&message.id.length<=256)
        ||Number.isSafeInteger(message.id)?message.id:null;
      rpcId=id;
      const modern=classifyProtocol(req,message);
      if(modern&&message.method==='server/discover'){
        json(res,200,rpc(id,{
          supportedVersions:[MODERN_VERSION,...LEGACY_VERSIONS],
          capabilities:{tools:{listChanged:false}},
          ttlMs:30000,cacheScope:'private'
        },true));return;
      }
      if(message.method==='initialize'&&!modern){
        json(res,200,rpc(id,{
          protocolVersion:'2025-11-25',
          capabilities:{tools:{listChanged:false}},
          serverInfo:SERVER_INFO
        }));return;
      }
      if(message.method==='notifications/initialized'&&!modern){
        res.writeHead(202,{'cache-control':'no-store'});res.end();return;
      }
      if(message.method==='tools/list'){
        // Discovery can legitimately exceed a single tool-result limit when
        // the one private Tunnel exposes the installed Core catalog.
        // Request/effect bodies retain the original smaller bound.
        json(res,200,rpc(id,{tools:availableTools,ttlMs:30000,cacheScope:'private'},modern),262144);return;
      }
      if(message.method!=='tools/call'){
        if(modern)protocolFailure(404,-32601,'Method not found');
        json(res,200,error(id,modern));return;
      }
      if(!message.params||typeof message.params!=='object'
        ||Array.isArray(message.params)||!names.has(message.params.name)){
        if(modern)protocolFailure(200,-32602,'Unknown or invalid tool');
        json(res,200,error(id,modern));return;
      }
      const name=message.params.name;
      // The mTLS cert authenticates the PAIR, not a particular ChatGPT chat.
      // This owner-controlled resolver gets ONLY the independently attested
      // transport, never the MCP body or the user-selected session hint.
      let trustedSession=null;
      try{trustedSession=exactTrustedConversation(
        await resolveTrustedConversation(attested));}
      catch{trustedSession=null;}
      if(!trustedSession){
        json(res,403,{error:'private_session_required'});return;
      }
      // The caller hint only selects a correlation label. Under the owner
      // PAIR scope, no ChatGPT chat becomes an authorization principal; all
      // chats share independently approved pair-binding + signed action grants.
      const session=trustedSession.sessionHandle;
      const hinted=message.params._meta?.['openai/session'];
      if(trustedSession.scope==='conversation'
        &&hinted!==undefined&&hinted!==session){
        json(res,403,{error:'private_session_mismatch'});return;
      }
      if(name==='v2_private_owner_bind'){
        // Explicit native owner action, never automatic on tools/list.
        // A successful binding still does not grant tools or OS privileges.
        if(message.params.arguments===null
          ||typeof message.params.arguments!=='object'
          ||Array.isArray(message.params.arguments)
          ||Object.keys(message.params.arguments).length!==0){
          json(res,200,error(id,modern));return;
        }
        await ownerStack.requestOwnerBinding({request:req,sessionHandle:session});
        json(res,200,rpc(id,{isError:false,content:[
          {type:'text',text:'Native owner session approved. Exact tool grants are still required.'}
        ]},modern));return;
      }
      if(!RESERVED.has(name)){
        // A direct Core tool never receives a caller-supplied routing target.
        // Native J01 independently resolves the CURRENT exact owner route.
        // Use the SAME source Core JSON-schema validator before native route,
        // worker-grant lookup or any execution callback. Never trust an
        // optional owner callback alone to enforce the advertised schema.
        // Freeze a bounded, deep, data-only JSON snapshot BEFORE handing it
        // to any asynchronous validator. A trusted callback cannot mutate
        // either nested fields or primitive values after schema acceptance.
        let args;
        try{args=snapshotV2PrivateOperationArguments(
          message.params.arguments??{});}
        catch{json(res,200,error(id,modern));return;}
        if(validateJsonSchema(args,schemas.get(name)).length!==0){
          json(res,200,error(id,modern));return;
        }
        let inputAllowed=false;
        try{inputAllowed=await validateToolInput(name,args)===true;}
        catch{inputAllowed=false;}
        if(!inputAllowed){
          json(res,200,error(id,modern));return;
        }
        const nativeRoute=normalizeV2Route(
          await ownerStack.nativeSessionBindings.resolveNativeRoute(session));
        // Native J01 establishes only the owner pair and conversation.
        // It is NOT a reusable operationId for multiple distinct tools.
        if(nativeRoute.conversationId!==session){
          json(res,403,{error:'private_session_route_mismatch'});return;
        }
        // Owner-controlled worker creates the exact operation route for THIS
        // invocation. Never infer a durable operation ID from JSON-RPC id:
        // MCP 2026-07-28 only forbids reuse while a request is outstanding.
        const route=normalizeV2Route(await resolveTrustedToolRoute(Object.freeze({
          sessionHandle:session,nativeRoute,tool:name,
          arguments:args
        })));
        if(route.hostId!==nativeRoute.hostId
          ||route.profileId!==nativeRoute.profileId
          ||route.principalId!==nativeRoute.principalId
          ||route.conversationId!==nativeRoute.conversationId){
          json(res,403,{error:'private_operation_route_mismatch'});return;
        }
        const result=await operationGate.execute({
          request:req,route,tool:name,arguments:args
        });
        json(res,200,rpc(id,{isError:false,content:[
          {type:'text',text:JSON.stringify(result)}
        ]},modern));return;
      }
      const action=message.params.arguments;
      if(!action||typeof action!=='object'||Array.isArray(action)
        ||Object.keys(action).length!==3
        ||!Object.hasOwn(action,'route')||!Object.hasOwn(action,'tool')
        ||!Object.hasOwn(action,'arguments')
        ||action.route?.conversationId!==session){
        json(res,200,error(id,modern));return;
      }
      const result=await operationGate.execute({
        request:req,route:action.route,tool:action.tool,
        arguments:action.arguments
      });
      json(res,200,rpc(id,{isError:false,content:[
        {type:'text',text:JSON.stringify(result)}
      ]},modern));
    }catch(e){
      if(Number.isSafeInteger(e?.rpcCode)){
        json(res,e.httpStatus??400,{jsonrpc:'2.0',id:rpcId,error:{
          code:e.rpcCode,message:e.message,
          ...(e.rpcData!==undefined?{data:e.rpcData}:{})
        }});return;
      }
      // No stack traces, access keys, raw arguments, native dialogs or
      // Windows owner paths are reflected to remote callers.
      json(res,503,{error:'private_owner_admission_unavailable'});
    }
  }
  return Object.freeze({
    requiredTransport:'owner-pinned-private-tunnel-mtls',
    handle,allowedTools:availableTools.map(t=>t.name)
  });
}
