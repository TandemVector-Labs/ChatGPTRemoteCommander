// V2-G1 candidate: join OAuth, ChatGPT tool auth, trusted native conversation
// attestation, grants and the EXISTING WorkflowStore. No listening socket or
// legacy MCP mutation route is installed here.
//
// IMPORTANT: resolveTrustedInvocation is an OWNER-WORKER trusted callback,
// never a remote MCP body/header lookup. OAuth sub does not prove a ChatGPT chat.
// Missing a platform-attested conversation MUST fail closed.
import { createV2McpOAuthContract } from './v2-mcp-oauth-contract.mjs';
import { createV2OAuthObservedCaller } from './v2-oauth-caller.mjs';
import { executeV2WorkflowStep } from './v2-workflow-gateway.mjs';
import { normalizeV2Route } from './v2-routing-contract.mjs';

const STEP_TOOL='v2_workflow_step';
const PROFILE_TOOL='v2_profile';
const LEGACY_VERSIONS=Object.freeze(['2025-11-25','2025-06-18','2025-03-26']);
const MODERN_VERSION='2026-07-28';
const SERVER_IDENTITY=Object.freeze({name:'chatgpt-remote-commander-v2-candidate',version:'0.11.0-candidate'});
const SERVER_META=Object.freeze({'io.modelcontextprotocol/serverInfo':SERVER_IDENTITY});
const EXPECTED=Object.freeze(['tool','arguments','stepId','expectedRevision']);
function fail(code){throw Object.assign(new Error(code),{code});}
function record(v){return v!==null&&typeof v==='object'&&!Array.isArray(v)
  &&[Object.prototype,null].includes(Object.getPrototypeOf(v));}
function exact(v,fields){return record(v)&&Object.keys(v).length===fields.length
  &&Object.keys(v).every(k=>fields.includes(k));}
const inputSchema=Object.freeze({
  type:'object',
  properties:{
    tool:{type:'string'},arguments:{type:'object'},
    stepId:{type:'string'},expectedRevision:{type:'integer',minimum:1}
  },
  required:[...EXPECTED],additionalProperties:false
});
export function createV2CandidateMcpDispatcher({
  resource,authorizationServers,issuer,audience,scopes=['commander.workflow'],
  assertionTrust,verifyAccessToken,resolvePrincipal,observedNativeSession,
  resolveTrustedInvocation,workflowStore,grantRegistry,authorizeTool,dispatch,
  loadAuthenticatedProfile,now=Date.now
}){
  for(const candidate of [
    verifyAccessToken,resolvePrincipal,observedNativeSession,
    resolveTrustedInvocation,authorizeTool,dispatch,now
  ]){
    if(typeof candidate!=='function')fail('V2_MCP_TRUSTED_BOOTSTRAP_REQUIRED');
  }
  if(!workflowStore||!grantRegistry||!assertionTrust)
    fail('V2_MCP_TRUSTED_BOOTSTRAP_REQUIRED');
  if(loadAuthenticatedProfile!==undefined&&typeof loadAuthenticatedProfile!=='function')
    fail('V2_MCP_PROFILE_RESOLVER_REQUIRED');
  const auth=createV2McpOAuthContract({
    resource,authorizationServers,scopes,allowedTools:[STEP_TOOL]
  });
  const descriptor=auth.toolDescriptor({
    name:STEP_TOOL,
    description:'Execute one authorized durable WorkflowStore step for a natively attested conversation.',
    inputSchema,
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}
  });
  const enforcedScopes=descriptor.securitySchemes[0].scopes;
  // Optional and read-only: do NOT derive stable profile IDs from a JWT,
  // OAuth subject, email, chat, OS session or grant. The trusted provider
  // must load an already-persisted immutable opaque ID for these credentials.
  const profileDescriptor=loadAuthenticatedProfile===undefined?null:Object.freeze({
    name:PROFILE_TOOL,
    description:'Read the stable profile identity of this verified OAuth connection; no host action.',
    inputSchema:Object.freeze({type:'object',properties:{},additionalProperties:false}),
    outputSchema:Object.freeze({type:'object',properties:Object.freeze({
      id:{type:'string'},name:{type:'string'},email:{type:'string'},
      nickname:{type:'string'}
    }),required:Object.freeze(['id']),additionalProperties:false}),
    securitySchemes:Object.freeze([Object.freeze({type:'oauth2',scopes:Object.freeze([])})]),
    _meta:Object.freeze({'openai/profile':true}),
    annotations:Object.freeze({readOnlyHint:true,destructiveHint:false,openWorldHint:false})
  });
  const PROFILE_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  function checkedProfile(value){
    if(!record(value)||typeof value.id!=='string'
      ||!PROFILE_ID.test(value.id)||value.id==='.'||value.id==='..'
      ||Object.keys(value).some(k=>!['id','name','email','nickname'].includes(k)))
      fail('V2_MCP_PROFILE_IDENTITY_UNAVAILABLE');
    const result={id:value.id};
    for(const key of ['name','email','nickname']){
      if(value[key]!==undefined){
        if(typeof value[key]!=='string'||value[key].length>160
          ||[...value[key]].some(ch=>ch.charCodeAt(0)<32||ch.charCodeAt(0)===127))
          fail('V2_MCP_PROFILE_IDENTITY_UNAVAILABLE');
        result[key]=value[key];
      }
    }
    return Object.freeze(result);
  }
  async function callProfile({authorization,args}){
    if(args!==undefined&&(!record(args)||Object.keys(args).length>0))
      return denied('V2_MCP_PROFILE_INPUT_INVALID');
    if(typeof authorization!=='string'||authorization.length>8192
       ||!authorization.startsWith('Bearer ')
       ||!/^[A-Za-z0-9._~+=:-]+$/.test(authorization.slice(7).replaceAll('/','')))
      return auth.toolAuthRequired();
    try{
      const bearer=authorization.slice(7);
      const verify=async()=>{
        const claims=await verifyAccessToken(bearer);
        const current=now();
        if(!record(claims)||claims.issuer!==issuer||claims.audience!==audience
          ||typeof claims.subject!=='string'||!PROFILE_ID.test(claims.subject)
          ||!Array.isArray(claims.scopes)
          ||!Number.isSafeInteger(current)||!Number.isSafeInteger(claims.expiresAtMs)
          ||!Number.isSafeInteger(claims.notBeforeMs)
          ||claims.expiresAtMs<=current||claims.notBeforeMs>current)
          fail('V2_OAUTH_VERIFICATION_REQUIRED');
        const principalId=await resolvePrincipal(claims.subject);
        if(typeof principalId!=='string'||!PROFILE_ID.test(principalId))
          fail('V2_OAUTH_PRINCIPAL_MISMATCH');
        return {subject:claims.subject,principalId};
      };
      const before=await verify();
      const profile=checkedProfile(await loadAuthenticatedProfile(
        Object.freeze({...before})
      ));
      const after=await verify();
      if(before.subject!==after.subject||before.principalId!==after.principalId)
        fail('V2_OAUTH_PRINCIPAL_MISMATCH');
      return Object.freeze({
        content:Object.freeze([Object.freeze({
          type:'text',text:'Authenticated Commander V2 profile identified.'
        })]),
        structuredContent:profile
      });
    }catch(error){
      const code=String(error?.code??'');
      if(code.startsWith('V2_OAUTH_')||code.startsWith('V2_JWT_')
        ||code.startsWith('V2_JWKS_'))return auth.toolAuthRequired();
      return denied('V2_MCP_PROFILE_IDENTITY_UNAVAILABLE');
    }
  }
  const denied=(code='V2_MCP_OPERATION_DENIED')=>Object.freeze({
    isError:true,content:Object.freeze([Object.freeze({
      type:'text',text:'Commander V2 request denied: '+code
    })])
  });
  const outcome=(result)=>Object.freeze({
    content:Object.freeze([Object.freeze({
      type:'text',text:'Commander V2 workflow request completed.'
    })]),
    structuredContent:Object.freeze({
      outcome:result.outcome,
      cachedReceipt:result.cachedReceipt===true
    })
  });
  async function call({authorization,toolName,args}){
    if(toolName===PROFILE_TOOL&&profileDescriptor)
      return callProfile({authorization,args});
    if(toolName!==STEP_TOOL)return denied('V2_MCP_TOOL_UNKNOWN');
    if(!exact(args,EXPECTED)||!record(args.arguments)
      ||typeof args.stepId!=='string'||typeof args.tool!=='string'
      ||!Number.isSafeInteger(args.expectedRevision)||args.expectedRevision<1)
      return denied('V2_MCP_INPUT_INVALID');
    if(typeof authorization!=='string'||!authorization.startsWith('Bearer '))
      return auth.toolAuthRequired();
    let trusted;
    try{
      // Verify the OAuth bearer cryptographically before consulting any
      // owner-native chat resolver. A forged bearer cannot enumerate sessions.
      const bearer=authorization.slice(7);
      const claims=await verifyAccessToken(bearer);
      const validClaims=record(claims)&&claims.issuer===issuer
        &&claims.audience===audience
        &&Number.isSafeInteger(claims.expiresAtMs)
        &&Number.isSafeInteger(claims.notBeforeMs)
        &&Number.isSafeInteger(now())
        &&claims.notBeforeMs<=now()&&claims.expiresAtMs>now()
        &&typeof claims.subject==='string'&&claims.subject.length>0
        &&Array.isArray(claims.scopes);
      if(!validClaims)fail('V2_OAUTH_VERIFICATION_REQUIRED');
      // Every scope advertised for this operation must be present in the
      // verified access token, not only the first scope in the array.
      if(!enforcedScopes.every(scope=>claims.scopes.includes(scope)))
        fail('V2_OAUTH_SCOPE_OR_SUBJECT_REQUIRED');
      // Resolution is intentionally independent of any caller-controlled
      // route, conversation ID, profile, device, or MCP session handle.
      // The owner may sign the exact requested action, but the selected
      // conversation/host/profile/seat remain private to its native resolver.
      // Supply no OAuth bearer, platform session, or caller-selected route.
      const ownerAction=Object.freeze({
        tool:args.tool,arguments:structuredClone(args.arguments),
        stepId:args.stepId,expectedRevision:args.expectedRevision
      });
      trusted=await resolveTrustedInvocation(ownerAction);
      if(!exact(trusted,['route','assertion']))
        fail('V2_MCP_CHAT_ATTESTATION_REQUIRED');
      const r=normalizeV2Route(trusted.route);
      if(r.operationId!==args.stepId||r.target.kind!=='workflow-root')
        fail('V2_MCP_BOUND_OPERATION_MISMATCH');
      const observed=createV2OAuthObservedCaller({
        route:r,tool:args.tool,args:args.arguments,
        assertion:trusted.assertion,assertionTrust,
        readAuthorization:async()=>authorization,
        verifyAccessToken,resolvePrincipal,observedNativeSession,
        issuer,audience,requiredScopes:enforcedScopes,now
      });
      const result=await executeV2WorkflowStep({
        route:r,stepId:args.stepId,expectedRevision:args.expectedRevision,
        tool:args.tool,arguments:args.arguments,
        workflowStore,grantRegistry,observedCaller:observed,
        authorizeTool,dispatch
      });
      return outcome(result);
    }catch(error){
      const code=String(error?.code??'V2_MCP_OPERATION_DENIED');
      if(code.startsWith('V2_OAUTH_')||code.startsWith('V2_JWT_')
        ||code.startsWith('V2_JWKS_'))
        return auth.toolAuthRequired({
          error:code==='V2_OAUTH_SCOPE_OR_SUBJECT_REQUIRED'?'insufficient_scope':'invalid_token'
        });
      // Platform-specific chat binding failures must NOT trigger a re-login,
      // which cannot provide a ChatGPT conversation attestation.
      const allowed=new Set([
        'V2_MCP_CHAT_ATTESTATION_REQUIRED','V2_MCP_BOUND_OPERATION_MISMATCH',
        'V2_GRANT_REQUIRED','V2_WORKFLOW_TOOL_AUTH_REQUIRED',
        'V2_ROUTE_CALLER_MISMATCH','V2_WORKFLOW_STATE_AUTHORITY_MISMATCH',
        'V2_ASSERTION_ROUTE_MISMATCH','V2_ASSERTION_ACTION_MISMATCH',
        'V2_ASSERTION_BAD_SIGNATURE','V2_ASSERTION_NATIVE_SESSION_MISMATCH',
        'V2_ASSERTION_EXPIRED_OR_INVALID_TIME'
      ]);
      return denied(allowed.has(code)?code:'V2_MCP_OPERATION_DENIED');
    }
  }
  async function handleRpc({authorization,message}){
    if(!record(message)||message.jsonrpc!=='2.0'
      ||(typeof message.id!=='string'
        && (!Number.isSafeInteger(message.id)||message.id<0))
      ||(typeof message.id==='string'
        && (!message.id.length||message.id.length>128))
      ||typeof message.method!=='string'){
      // Modern and legacy notifications are not JSON-RPC requests.
      if(record(message)&&message.jsonrpc==='2.0'
         &&message.method==='notifications/initialized'
         &&!Object.hasOwn(message,'id'))return null;
      return {jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid Request'}};
    }
    const version=message.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
    if(version!==undefined && version!==MODERN_VERSION){
      return {jsonrpc:'2.0',id:message.id,
        error:{code:-32022,message:'Unsupported MCP protocol version'}};
    }
    const modern=version===MODERN_VERSION;
    if(modern && !record(message.params?._meta?.['io.modelcontextprotocol/clientCapabilities'])){
      return {jsonrpc:'2.0',id:message.id,
        error:{code:-32021,message:'Modern MCP client capabilities required'}};
    }
    const rpc=(payload)=>({jsonrpc:'2.0',id:message.id,
      result:modern?{resultType:'complete',...payload,_meta:{...SERVER_META,...(record(payload._meta)?payload._meta:{})}}:payload});
    if(!modern&&message.method==='initialize'){
      const preferred=message.params?.protocolVersion;
      return rpc({protocolVersion:LEGACY_VERSIONS.includes(preferred)
          ?preferred:LEGACY_VERSIONS[0],
        capabilities:{tools:{}},serverInfo:SERVER_IDENTITY,
        instructions:'V2 candidate: OAuth user and independent owner-worker chat attestation are mandatory.'});
    }
    if(modern&&message.method==='server/discover'){
      return rpc({supportedVersions:[MODERN_VERSION],
        capabilities:{tools:{}},
        instructions:'V2 candidate requires verified OAuth and independently attested chat identity.',
        ttlMs:30000,cacheScope:'private'});
    }
    if(message.method==='tools/list'){
      return rpc({tools:profileDescriptor?[descriptor,profileDescriptor]:[descriptor]});
    }
    if(message.method==='tools/call'){
      const params=message.params;
      const result=await call({
        authorization,toolName:params?.name,args:params?.arguments
      });
      return rpc(result);
    }
    return {jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}};
  }
  return Object.freeze({
    descriptor,profileDescriptor,
    protectedResource:auth.protectedResource,
    handleRpc,
    call
  });
}
