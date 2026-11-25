// G1 candidate: ChatGPT per-tool OAuth discovery/error contract.
// Does not authenticate callers or activate tools; never mutates V1 TOOLS.
// Native owner/authorization checks remain required on every actual invocation.
// Sources: OpenAI Plugins authentication (securitySchemes + mcp/www_authenticate).
import { createV2ProtectedResourceMetadata } from './v2-oauth-resource-metadata.mjs';

const ID=/^[a-z][a-z0-9_]{0,79}$/;
const SCOPE=/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const ERRORS=new Set(['invalid_token','insufficient_scope']);
function fail(code){throw Object.assign(new Error(code),{code});}
function plainRecord(v){return !!v&&typeof v==='object'&&!Array.isArray(v)
  &&[Object.prototype,null].includes(Object.getPrototypeOf(v));}
function exactKeys(obj,names){
  return plainRecord(obj)&&Object.keys(obj).length===names.length
    &&Object.keys(obj).every(k=>names.includes(k));
}
function normalizeScopes(scopes){
  if(!Array.isArray(scopes)||scopes.length<1||scopes.length>32
    ||new Set(scopes).size!==scopes.length
    ||scopes.some(x=>typeof x!=='string'||!SCOPE.test(x)))
    fail('V2_MCP_OAUTH_SCOPES_INVALID');
  return Object.freeze([...scopes]);
}
function sanitizeText(s){
  // Error descriptions must be fixed server messages, not request-supplied.
  if(typeof s!=='string'||s.length<1||s.length>160||/["\\\r\n]/.test(s))
    fail('V2_MCP_AUTH_ERROR_DESCRIPTION_INVALID');
  return s;
}
export function createV2McpOAuthContract({
  resource,authorizationServers,scopes=['commander.workflow'],
  allowedTools=['v2_workflow_step']
}){
  const grantedScopes=normalizeScopes(scopes);
  if(!Array.isArray(allowedTools)||allowedTools.length<1||allowedTools.length>32
    ||new Set(allowedTools).size!==allowedTools.length
    ||allowedTools.some(x=>typeof x!=='string'||!ID.test(x)||!x.startsWith('v2_')))
    fail('V2_MCP_AUTH_TOOLS_INVALID');
  const allowed=new Set(allowedTools);
  const protectedResource=createV2ProtectedResourceMetadata({
    resource,authorizationServers,scopes:grantedScopes
  });
  function toolDescriptor(descriptor){
    if(!plainRecord(descriptor)||typeof descriptor.name!=='string'
      ||!allowed.has(descriptor.name))
      fail('V2_MCP_AUTH_TOOL_NOT_APPROVED');
    if(Object.hasOwn(descriptor,'securitySchemes'))
      fail('V2_MCP_AUTH_SCHEME_CONFLICT');
    const policy=Object.freeze({type:'oauth2',scopes:grantedScopes});
    return Object.freeze({...descriptor,securitySchemes:Object.freeze([policy])});
  }
  function challenge({error='invalid_token',description='Authentication required'}={}){
    if(!ERRORS.has(error))fail('V2_MCP_AUTH_ERROR_INVALID');
    const message=sanitizeText(description);
    return 'Bearer resource_metadata="'+protectedResource.metadataUrl
      +'", error="'+error+'", error_description="'+message+'"';
  }
  function toolAuthRequired({
    error='invalid_token',description='Authentication required'
  }={}){
    const header=challenge({error,description});
    return Object.freeze({
      content:Object.freeze([Object.freeze({
        type:'text',text:'Authentication required for this Commander V2 tool.'
      })]),
      isError:true,
      _meta:Object.freeze({'mcp/www_authenticate':Object.freeze([header])})
    });
  }
  return Object.freeze({
    protectedResource,
    toolDescriptor,
    challenge,
    toolAuthRequired
  });
}
