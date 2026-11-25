// V2-G1: operator-configured Keycloak discovery and token-verifier bootstrap.
// Auth0 is an upstream brokered OIDC identity provider; only the Keycloak
// realm issuer is discovered and trusted by Commander. No client secrets,
// user-consent callbacks, ChatGPT transport attestation or HTTP listener live here.
import { validateV2OAuthProvider } from './v2-oauth-provider-preflight.mjs';
import { createV2JwksTokenVerifier } from './v2-oauth-jwks.mjs';

const MAX_METADATA_BYTES=65536;
function fail(code){throw Object.assign(new Error(code),{code});}
function secureHttps(value){
  if(typeof value!=='string'||value.length>2048||/[\u0000-\u001f\\]/.test(value))
    fail('V2_PROVIDER_HTTPS_REQUIRED');
  let url;
  try{url=new URL(value);}catch{fail('V2_PROVIDER_HTTPS_REQUIRED');}
  if(url.protocol!=='https:'||!url.hostname||url.username||url.password
    ||url.search||url.hash||url.port&&url.port!=='443')
    fail('V2_PROVIDER_HTTPS_REQUIRED');
  return value;
}
function discoveryEndpoint(issuer){
  const url=new URL(issuer);
  const base=url.pathname.replace(/\/+$/,'');
  url.pathname=base+'/.well-known/openid-configuration';
  return url.href;
}
async function boundedText(response,maximum){
  if(!response.body?.getReader){
    let value;
    try{value=await response.text();}catch{fail('V2_PROVIDER_DISCOVERY_BODY_INVALID');}
    if(Buffer.byteLength(value)>maximum)fail('V2_PROVIDER_DISCOVERY_TOO_LARGE');
    return value;
  }
  const reader=response.body.getReader();
  const chunks=[];let total=0;
  try{
    for(;;){
      let item;
      try{item=await reader.read();}catch{fail('V2_PROVIDER_DISCOVERY_BODY_INVALID');}
      if(item.done)break;
      total+=item.value.byteLength;
      if(total>maximum){
        try{await reader.cancel();}catch{}
        fail('V2_PROVIDER_DISCOVERY_TOO_LARGE');
      }
      chunks.push(item.value);
    }
    return Buffer.concat(chunks,total).toString('utf8');
  }finally{try{reader.releaseLock();}catch{}}
}
function freezeJson(value){
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const item of Object.values(value))freezeJson(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * Fetches and validates the single configured Keycloak OIDC discovery document.
 * The issuer/resource must come from trusted operator configuration, never from
 * an MCP request, Authorization header, model output or untrusted file.
 */
export async function fetchV2OAuthProviderMetadata({
  issuer,resource,request=fetch,timeoutMs=5000,maxBytes=MAX_METADATA_BYTES,
  requiredScopes=['commander.workflow'],clientRegistration='pre-registered',
  tokenType='at+jwt'
}){
  const trustedIssuer=secureHttps(issuer),audience=secureHttps(resource);
  if(typeof request!=='function'||!Number.isSafeInteger(timeoutMs)
    ||timeoutMs<1||timeoutMs>10000||!Number.isSafeInteger(maxBytes)
    ||maxBytes<1024||maxBytes>MAX_METADATA_BYTES)
    fail('V2_PROVIDER_DISCOVERY_CONFIG_INVALID');
  const endpoint=discoveryEndpoint(trustedIssuer);
  let response;
  try{
    response=await request(endpoint,{
      method:'GET',redirect:'error',headers:{accept:'application/json'},
      signal:AbortSignal.timeout(timeoutMs)
    });
  }catch{fail('V2_PROVIDER_DISCOVERY_FAILED');}
  if(response.status!==200||!response.ok)fail('V2_PROVIDER_DISCOVERY_HTTP_ERROR');
  if(response.url){
    let actual;
    try{actual=new URL(response.url).href;}catch{fail('V2_PROVIDER_DISCOVERY_REDIRECT');}
    if(actual!==new URL(endpoint).href)fail('V2_PROVIDER_DISCOVERY_REDIRECT');
  }
  const contentType=String(response.headers?.get?.('content-type')??'')
    .split(';',1)[0].trim().toLowerCase();
  if(contentType!=='application/json'&&!contentType.endsWith('+json'))
    fail('V2_PROVIDER_DISCOVERY_CONTENT_TYPE_INVALID');
  const contentLength=Number(response.headers?.get?.('content-length'));
  if(Number.isFinite(contentLength)&&contentLength>maxBytes)
    fail('V2_PROVIDER_DISCOVERY_TOO_LARGE');
  const raw=await boundedText(response,maxBytes);
  let metadata;
  try{metadata=JSON.parse(raw);}catch{fail('V2_PROVIDER_DISCOVERY_JSON_INVALID');}
  if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))
    fail('V2_PROVIDER_DISCOVERY_JSON_INVALID');
  const preflight=validateV2OAuthProvider({
    issuer:trustedIssuer,resource:audience,metadata,
    requiredScopes,clientRegistration,tokenType
  });
  return Object.freeze({
    discoveryEndpoint:endpoint,
    metadata:freezeJson(metadata),
    preflight
  });
}

/**
 * Creates the issuer-pinned JWKS verifier from validated live discovery.
 * This is only the OAuth provider adapter; G1 still requires native owner/chat
 * attestation, V1-01 grants, trusted Host callbacks and the protected listener.
 */
export async function createV2OAuthProviderBootstrap(options={}){
  const discovered=await fetchV2OAuthProviderMetadata(options);
  const request=options.request??fetch;
  const verifyAccessToken=createV2JwksTokenVerifier({
    issuer:discovered.preflight.issuer,
    audience:discovered.preflight.audience,
    jwksUri:discovered.preflight.jwksUri,
    tokenType:discovered.preflight.tokenType,
    request,
    now:options.now??Date.now,
    cacheMs:options.cacheMs??60000
  });
  return Object.freeze({...discovered,verifyAccessToken});
}
