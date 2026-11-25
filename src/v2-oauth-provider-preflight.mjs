// V2-G1: pure validation of the single operator-approved Keycloak issuer's
// RFC8414/OIDC metadata before ChatGPT MCP activation. In hybrid mode Auth0 is
// federated upstream through Keycloak; its bearer tokens are never accepted here.
// No token issuance,
// user consent, HTTP listener, client credentials, or live discovery occurs here.
// The issuer and expected resource audience MUST be pinned out of band.
function fail(code){throw Object.assign(new Error(code),{code});}
function https(value){
  if(typeof value!=='string'||value.length>2048||/[\u0000-\u001f\\]/.test(value))
    fail('V2_PROVIDER_HTTPS_REQUIRED');
  let url;
  try{url=new URL(value);}catch{fail('V2_PROVIDER_HTTPS_REQUIRED');}
  if(url.protocol!=='https:'||!url.hostname||url.username||url.password
    ||url.search||url.hash||url.port && url.port!=='443')
    fail('V2_PROVIDER_HTTPS_REQUIRED');
  return value; // preserve exact issuer identity, including optional slash
}
function includesString(values,required){
  return Array.isArray(values)&&values.includes(required)&&values.every(v=>typeof v==='string');
}
const TOKEN_AUTH_METHODS=new Set(['none','private_key_jwt','client_secret_basic','client_secret_post']);
/** Returns only the verified public metadata needed by the OAuth JWT boundary. */
export function validateV2OAuthProvider({
  issuer,resource,metadata,requiredScope='commander.workflow',
  requiredScopes,clientRegistration='pre-registered',tokenType='at+jwt'
}){
  const trustedIssuer=https(issuer),audience=https(resource);
  if(!['at+jwt','JWT'].includes(tokenType))fail('V2_PROVIDER_TOKEN_TYPE_INVALID');
  // The dispatcher enforces every advertised scope. Preflight must not accept
  // an IdP advertising only the first scope of a multi-scope V2 tool.
  const requestedScopes=requiredScopes===undefined?[requiredScope]:requiredScopes;
  const SCOPE=/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
  if(!Array.isArray(requestedScopes)||requestedScopes.length<1
    ||requestedScopes.length>32||new Set(requestedScopes).size!==requestedScopes.length
    ||requestedScopes.some(s=>typeof s!=='string'||!SCOPE.test(s)))
    fail('V2_PROVIDER_SCOPE_INVALID');
  if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))
    fail('V2_PROVIDER_METADATA_REQUIRED');
  if(metadata.issuer!==trustedIssuer)fail('V2_PROVIDER_ISSUER_MISMATCH');
  const authorizationEndpoint=https(metadata.authorization_endpoint);
  const tokenEndpoint=https(metadata.token_endpoint);
  const jwksUri=https(metadata.jwks_uri);
  if(!includesString(metadata.response_types_supported,'code'))
    fail('V2_PROVIDER_CODE_FLOW_REQUIRED');
  if(metadata.grant_types_supported!==undefined
    && !includesString(metadata.grant_types_supported,'authorization_code'))
    fail('V2_PROVIDER_CODE_FLOW_REQUIRED');
  // MCP clients require an explicit S256 capability; absence is a hard failure.
  if(!includesString(metadata.code_challenge_methods_supported,'S256'))
    fail('V2_PROVIDER_PKCE_S256_REQUIRED');
  if(metadata.scopes_supported!==undefined
    && requestedScopes.some(scope=>!includesString(metadata.scopes_supported,scope)))
    fail('V2_PROVIDER_SCOPE_NOT_ADVERTISED');
  if(!['pre-registered','client-id-metadata','dynamic'].includes(clientRegistration))
    fail('V2_PROVIDER_CLIENT_REGISTRATION_REQUIRED');
  // ChatGPT cannot exchange a PKCE authorization code unless the issuer
  // advertises at least one supported token-endpoint client-auth method.
  const tokenMethods=metadata.token_endpoint_auth_methods_supported;
  if(!Array.isArray(tokenMethods)||tokenMethods.length<1||tokenMethods.length>16
    ||tokenMethods.some(m=>typeof m!=='string')
    ||!tokenMethods.some(m=>TOKEN_AUTH_METHODS.has(m)))
    fail('V2_PROVIDER_TOKEN_AUTH_METHOD_UNSUPPORTED');
  if(clientRegistration==='client-id-metadata'
    &&!tokenMethods.some(m=>m==='none'||m==='private_key_jwt'))
    fail('V2_PROVIDER_CIMD_TOKEN_AUTH_METHOD_UNSUPPORTED');

  if(clientRegistration==='client-id-metadata'
    && metadata.client_id_metadata_document_supported!==true)
    fail('V2_PROVIDER_CIMD_UNSUPPORTED');
  if(clientRegistration==='dynamic'&&typeof metadata.registration_endpoint!=='string')
    fail('V2_PROVIDER_REGISTRATION_UNAVAILABLE');
  if(clientRegistration==='dynamic')https(metadata.registration_endpoint);
  // RFC 9207 response issuer identification allows ChatGPT's stable OAuth
  // callback and CIMD client ID when the authorization response actually
  // echoes the pinned issuer (including error responses). Metadata alone
  // cannot prove that runtime behavior or a completed user login.
  if(metadata.authorization_response_iss_parameter_supported!==undefined
    && typeof metadata.authorization_response_iss_parameter_supported!=='boolean')
    fail('V2_PROVIDER_RESPONSE_ISS_FLAG_INVALID');
  const issuerResponseIdentificationAdvertised=
    metadata.authorization_response_iss_parameter_supported===true;
  return Object.freeze({
    issuer:trustedIssuer,audience,tokenType,
    authorizationEndpoint,tokenEndpoint,jwksUri,
    scope:requestedScopes[0],scopes:Object.freeze([...requestedScopes]),clientRegistration,
    issuerResponseIdentificationAdvertised,
    stableCallbackMetadataEligible:issuerResponseIdentificationAdvertised,
    stableCimdClientIdMetadataEligible:issuerResponseIdentificationAdvertised
      &&clientRegistration==='client-id-metadata',
    tokenEndpointAuthMethods:Object.freeze([...new Set(tokenMethods.filter(m=>TOKEN_AUTH_METHODS.has(m)))]),
    // A positive preflight is not user authorization or authenticated chat identity.
    claimOfAuthenticatedChat:false
  });
}
