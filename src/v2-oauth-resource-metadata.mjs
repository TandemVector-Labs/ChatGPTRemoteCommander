// V2-G1 OAuth discovery contract for a protected MCP HTTP resource.
// No listener, HTTP route or live authentication flow is installed by this file.
// Config is pinned by the operator, never derived from MCP request arguments.
const SCOPE=/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
function fail(code){throw Object.assign(new Error(code),{code});}
function httpsUri(value){
  if(typeof value!=='string'||value.length>2048||value.includes('\\'))fail('V2_RESOURCE_URI_INVALID');
  let u;
  try{u=new URL(value);}catch{fail('V2_RESOURCE_URI_INVALID');}
  if(u.protocol!=='https:'||!u.hostname||u.username||u.password||u.search||u.hash
    ||(u.port&&u.port!=='443'))fail('V2_RESOURCE_URI_INVALID');
  if(u.pathname.includes('//'))fail('V2_RESOURCE_URI_INVALID');
  return u;
}
/**
 * Expose metadata at the RFC9728 well-known path and a 401 Bearer challenge
 * through the existing HTTPS front door only AFTER a real issuer is configured.
 */
export function createV2ProtectedResourceMetadata({
  resource,authorizationServers,scopes=['commander.workflow']
}){
  const target=httpsUri(resource);
  if(!Array.isArray(authorizationServers)||authorizationServers.length!==1)
    fail('V2_RESOURCE_AUTHORIZATION_SERVER_REQUIRED');
  const provider=httpsUri(authorizationServers[0]);
  if(!Array.isArray(scopes)||!scopes.length||scopes.length>32
    ||scopes.some(s=>typeof s!=='string'||!SCOPE.test(s))
    ||new Set(scopes).size!==scopes.length)fail('V2_RESOURCE_SCOPES_INVALID');
  const origin=target.origin;
  const suffix=target.pathname.replace(/\/$/,'');
  const metadataPath='/.well-known/oauth-protected-resource'+(suffix==='/'?'':suffix);
  const metadataUrl=origin+metadataPath;
  const payload=Object.freeze({
    resource:resource,
    authorization_servers:Object.freeze([authorizationServers[0]]),
    scopes_supported:Object.freeze([...scopes]),
    bearer_methods_supported:Object.freeze(['header'])
  });
  return Object.freeze({
    metadataPath,metadataUrl,body:payload,
    // Scope value is syntax-restricted above and cannot inject header fields.
    challenge:'Bearer resource_metadata="'+metadataUrl+'", scope="'+scopes.join(' ')+'"'
  });
}
