// V2-G1: narrow JWT access-token verifier for an operator-configured OAuth issuer.
// Do not accept JWKS URIs or issuer settings from MCP requests or model content.
// Opaque tokens require a separate trusted RFC7662 introspection adapter.
// JWKS is public key material only; no refresh/client credentials are stored here.
import { createPublicKey } from 'node:crypto';
import { createLocalJWKSet, jwtVerify } from '../vendor/jose/dist/webapi/index.js';

const ALGS=new Set(['RS256','ES256','EdDSA']);
const TOKEN_TYPES=new Set(['at+jwt','JWT']);
const UNKNOWN_KID_REFRESH_MIN_MS=30000;
function fail(code){throw Object.assign(new Error(code),{code});}
const cleanUri=(s)=>{
  if(typeof s!=='string'||s.length>2048)fail('V2_JWKS_CONFIG_REQUIRED');
  let u;
  try{u=new URL(s);}catch{fail('V2_JWKS_CONFIG_REQUIRED');}
  if(u.protocol!=='https:'||!u.hostname||u.username||u.password||u.hash||u.search
    ||u.port && u.port!=='443')fail('V2_JWKS_CONFIG_REQUIRED');
  // OAuth issuer/audience are exact identifiers; adding a trailing slash changes aud/iss.
  return s;
};
function audienceMatches(value,expected){
  if(value===expected)return true;
  if(!Array.isArray(value)||value.length<1||value.length>8)return false;
  const seen=new Set();
  for(const item of value){
    if(typeof item!=='string'||!item||item.length>2048||seen.has(item))return false;
    seen.add(item);
  }
  return seen.has(expected);
}
const parse=(part)=>{
  if(typeof part!=='string'||part.length>16384
    ||!/^[A-Za-z0-9_-]+$/.test(part))fail('V2_JWT_MALFORMED');
  try{
    const buf=Buffer.from(part,'base64url');
    if(buf.toString('base64url')!==part)fail('V2_JWT_MALFORMED');
    const out=JSON.parse(buf.toString('utf8'));
    if(!out||typeof out!=='object'||Array.isArray(out))fail('V2_JWT_MALFORMED');
    return out;
  }catch{fail('V2_JWT_MALFORMED');}
};
const chooseKey=(keys,header)=>{
  if(!keys||!Array.isArray(keys.keys)||keys.keys.length>100)fail('V2_JWKS_INVALID');
  const matches=keys.keys.filter(k=>k&&typeof k==='object'&&k.kid===header.kid);
  if(matches.length!==1)fail('V2_JWKS_KEY_AMBIGUOUS_OR_MISSING');
  const jwk=matches[0],alg=header.alg;
  if(jwk.use!==undefined&&jwk.use!=='sig')fail('V2_JWKS_KEY_REJECTED');
  if(jwk.key_ops!==undefined&&(!Array.isArray(jwk.key_ops)||!jwk.key_ops.includes('verify')))fail('V2_JWKS_KEY_REJECTED');
  if(jwk.alg!==undefined&&jwk.alg!==alg)fail('V2_JWKS_KEY_REJECTED');
  if(['d','p','q','dp','dq','qi','oth','k'].some(k=>Object.hasOwn(jwk,k)))
    fail('V2_JWKS_PRIVATE_KEY_REJECTED');
  if(alg==='EdDSA'&&(jwk.kty!=='OKP'||jwk.crv!=='Ed25519')
    ||alg==='ES256'&&(jwk.kty!=='EC'||jwk.crv!=='P-256')
    ||alg==='RS256'&&jwk.kty!=='RSA')fail('V2_JWKS_KEY_REJECTED');
  let key;
  try{key=createPublicKey({key:jwk,format:'jwk'});}catch{fail('V2_JWKS_KEY_REJECTED');}
  if(key.type!=='public')fail('V2_JWKS_KEY_REJECTED');
  if(alg==='RS256'&&(key.asymmetricKeyDetails?.modulusLength??0)<2048)
    fail('V2_JWKS_KEY_REJECTED');
  return key;
};
/** Use HTTPS without redirect and a bounded body to prevent SSRF and memory abuse. */
export async function fetchV2Jwks(uri,{request=fetch,timeoutMs=5000}={}){
  const canonical=cleanUri(uri);
  if(typeof request!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)
    fail('V2_JWKS_FETCH_CONFIG_INVALID');
  let response;
  try{response=await request(canonical,{method:'GET',redirect:'error',
      headers:{accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)});}
  catch{fail('V2_JWKS_FETCH_FAILED');}
  if(response.status!==200||!response.ok)fail('V2_JWKS_FETCH_FAILED');
  if(response.url && new URL(response.url).href!==new URL(canonical).href)fail('V2_JWKS_REDIRECT_NOT_ALLOWED');
  const length=Number(response.headers?.get?.('content-length'));
  if(Number.isFinite(length)&&length>65536)fail('V2_JWKS_TOO_LARGE');
  let bytes;
  try{
    if(!response.body?.getReader)fail('V2_JWKS_FETCH_FAILED');
    const reader=response.body.getReader();
    const chunks=[];let total=0;
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.length;
      if(total>65536){await reader.cancel();fail('V2_JWKS_TOO_LARGE');}
      chunks.push(value);
    }
    bytes=Buffer.concat(chunks,total);
  }catch(e){if(e.code==='V2_JWKS_TOO_LARGE')throw e;fail('V2_JWKS_FETCH_FAILED');}
  try{
    const parsed=JSON.parse(bytes.toString('utf8'));
    if(!parsed||!Array.isArray(parsed.keys)||parsed.keys.length>100)fail('V2_JWKS_INVALID');
    return parsed;
  }catch(e){if(e.code==='V2_JWKS_INVALID')throw e;fail('V2_JWKS_INVALID');}
}
/**
 * Verifies a signed access-token JWT using one pinned issuer JWKS.
 * tokenType is an operator-selected exact JOSE typ: at+jwt (preferred) or JWT
 * (explicit Keycloak compatibility). It never accepts ID tokens by audience:
 * the configured Commander resource audience and workflow scope remain exact.
 * The returned shape plugs into createV2OAuthObservedCaller and still requires
 * the actual OAuth server, trusted chat binding and native owner consent.
 */
export function createV2JwksTokenVerifier({
  issuer,audience,jwksUri,request=fetch,now=Date.now,cacheMs=60000,
  tokenType='at+jwt'
}){
  const configuredIssuer=cleanUri(issuer),configuredAudience=cleanUri(audience),
    configuredJwks=cleanUri(jwksUri);
  if(typeof now!=='function'||!Number.isSafeInteger(cacheMs)||cacheMs<0||cacheMs>300000
    ||!TOKEN_TYPES.has(tokenType))
    fail('V2_JWKS_CONFIG_REQUIRED');
  let cache=null,loaded=0,inFlight=null,lastUnknownKidRefresh=-Infinity;
  async function keys(force=false){
    const t=now();
    if(!force&&cache&&t>=loaded&&t-loaded<cacheMs)return cache;
    if(!inFlight){
      inFlight=fetchV2Jwks(configuredJwks,{request})
        .then(k=>{cache=k;loaded=now();return k;})
        .finally(()=>{inFlight=null;});
    }
    return inFlight;
  }
  return async(token)=>{
    if(typeof token!=='string'||token.length<20||token.length>16384)
      fail('V2_JWT_MALFORMED');
    const parts=token.split('.');
    if(parts.length!==3||parts.some(p=>!p))fail('V2_JWT_MALFORMED');
    const header=parse(parts[0]),payload=parse(parts[1]);
    if(!ALGS.has(header.alg)||typeof header.kid!=='string'||!header.kid
      ||header.kid.length>128||header.typ!==tokenType
      ||['crit','b64','jku','jwk','x5u'].some(name=>Object.hasOwn(header,name)))
      fail('V2_JWT_HEADER_REJECTED');
    const nowMs=now();
    if(!Number.isSafeInteger(nowMs))fail('V2_JWT_CLOCK_INVALID');
    if(payload.iss!==configuredIssuer||!audienceMatches(payload.aud,configuredAudience))
      fail('V2_JWT_ISSUER_OR_AUDIENCE_MISMATCH');
    if(typeof payload.sub!=='string'||!payload.sub||payload.sub.length>1024)
      fail('V2_JWT_SUBJECT_INVALID');
    for(const k of ['exp','nbf']){
      if(k==='exp'&&(!Number.isSafeInteger(payload.exp)||payload.exp<1))fail('V2_JWT_TIME_INVALID');
      if(k==='nbf'&&payload.nbf!==undefined&&!Number.isSafeInteger(payload.nbf))fail('V2_JWT_TIME_INVALID');
    }
    if(!Number.isSafeInteger(payload.exp*1000)
      ||!Number.isSafeInteger((payload.nbf??0)*1000))fail('V2_JWT_TIME_INVALID');
    if(payload.exp*1000<=nowMs||(payload.nbf??0)*1000>nowMs)
      fail('V2_JWT_NOT_CURRENT');
    const scopes=typeof payload.scope==='string'
      ?payload.scope.trim().split(/\s+/).filter(Boolean):null;
    if(!scopes||!scopes.length||scopes.length>128||scopes.some(s=>s.length>256))
      fail('V2_JWT_SCOPES_INVALID');
    let jwks=await keys(),key;
    try{key=chooseKey(jwks,header);}
    catch(e){
      if(e.code!=='V2_JWKS_KEY_AMBIGUOUS_OR_MISSING')throw e;
      // An untrusted bearer must not trigger unlimited network JWKS fetches
      // by presenting a different arbitrary key ID on every request.
      const refreshAt=now();
      if(refreshAt-lastUnknownKidRefresh<UNKNOWN_KID_REFRESH_MIN_MS)
        fail('V2_JWKS_KEY_AMBIGUOUS_OR_MISSING');
      lastUnknownKidRefresh=refreshAt;
      jwks=await keys(true);key=chooseKey(jwks,header);
    }
    const signature=Buffer.from(parts[2],'base64url');
    if(signature.toString('base64url')!==parts[2])fail('V2_JWT_MALFORMED');
    // Keep the original explicit JWKS key policy and bounded fetch/cache.
    // Delegate JWS cryptographic validation to the maintained jose library.
    // A token may expire while JWKS is in flight: preserve the existing
    // NOT_CURRENT failure rather than relabel it as a signature failure.
    const verifyNowMs=now();
    if(!Number.isSafeInteger(verifyNowMs)||payload.exp*1000<=verifyNowMs
      ||(payload.nbf??0)*1000>verifyNowMs)fail('V2_JWT_NOT_CURRENT');
    try{
      await jwtVerify(token,createLocalJWKSet({
        keys:[jwks.keys.find(k=>k.kid===header.kid)]
      }),{
        issuer:configuredIssuer,audience:configuredAudience,
        typ:tokenType,algorithms:[header.alg],
        currentDate:new Date(verifyNowMs)
      });
    }catch{fail('V2_JWT_SIGNATURE_INVALID');}
    // Authentication is not valid if the token expires during a slow JWKS
    // fetch or immediately after the signature check.
    const afterVerifyMs=now();
    if(!Number.isSafeInteger(afterVerifyMs)||payload.exp*1000<=afterVerifyMs
      ||(payload.nbf??0)*1000>afterVerifyMs)fail('V2_JWT_NOT_CURRENT');
    return Object.freeze({
      // Normalize an RFC 7519 string-or-array aud claim only after the exact
      // configured resource audience has been cryptographically verified.
      issuer:payload.iss,audience:configuredAudience,subject:payload.sub,
      scopes:Object.freeze(scopes),
      expiresAtMs:payload.exp*1000,notBeforeMs:(payload.nbf??0)*1000
    });
  };
}
