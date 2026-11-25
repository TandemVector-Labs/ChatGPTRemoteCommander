import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  fetchV2OAuthProviderMetadata,
  createV2OAuthProviderBootstrap
} from '../src/v2-oauth-provider-discovery.mjs';

const issuer='https://idp.example.test/realms/commander';
const resource='https://commander.example.test/mcp-v2';
const discovery=issuer+'/.well-known/openid-configuration';
const jwksUri=issuer+'/protocol/openid-connect/certs';
const pair=generateKeyPairSync('ed25519');
const jwk={
  ...pair.publicKey.export({format:'jwk'}),
  kid:'keycloak-test-key',alg:'EdDSA',use:'sig',key_ops:['verify']
};
const metadata={
  issuer,
  authorization_endpoint:issuer+'/protocol/openid-connect/auth',
  token_endpoint:issuer+'/protocol/openid-connect/token',
  jwks_uri:jwksUri,
  response_types_supported:['code'],
  grant_types_supported:['authorization_code'],
  code_challenge_methods_supported:['S256'],
  scopes_supported:['openid','profile','commander.workflow'],
  token_endpoint_auth_methods_supported:['none','client_secret_basic'],
  authorization_response_iss_parameter_supported:true
};
const json=(value)=>new Response(JSON.stringify(value),{
  status:200,headers:{'content-type':'application/json; charset=utf-8'}
});
function jwt({iss=issuer,aud=resource,typ='at+jwt'}={}){
  const now=Math.floor(Date.now()/1000);
  const header=Buffer.from(JSON.stringify({
    alg:'EdDSA',kid:'keycloak-test-key',typ
  })).toString('base64url');
  const payload=Buffer.from(JSON.stringify({
    iss,aud,sub:'commander-user-1',exp:now+300,nbf:now-1,
    scope:'commander.workflow'
  })).toString('base64url');
  const input=header+'.'+payload;
  return input+'.'+sign(null,Buffer.from(input),pair.privateKey).toString('base64url');
}

test('live OIDC discovery bootstraps the pinned Keycloak verifier and verifies a real signed access token',async()=>{
  const calls=[];
  const request=async(url,init)=>{
    calls.push({url,method:init.method,redirect:init.redirect,hasAbortSignal:init.signal instanceof AbortSignal});
    if(url===discovery)return json(metadata);
    if(url===jwksUri)return json({keys:[jwk]});
    throw Error('unconfigured endpoint');
  };
  const provider=await createV2OAuthProviderBootstrap({
    issuer,resource,request,tokenType:'at+jwt',
    requiredScopes:['commander.workflow']
  });
  const claims=await provider.verifyAccessToken(jwt());
  assert.equal(claims.issuer,issuer);
  assert.equal(claims.audience,resource);
  assert.equal(claims.subject,'commander-user-1');
  assert.deepEqual(claims.scopes,['commander.workflow']);
  assert.equal(provider.preflight.tokenType,'at+jwt');
  assert.equal(provider.preflight.issuerResponseIdentificationAdvertised,true);
  assert.deepEqual(calls.map(x=>x.url),[discovery,jwksUri]);
  assert.ok(calls.every(x=>x.method==='GET'&&x.redirect==='error'&&x.hasAbortSignal));
});

test('the configured Keycloak issuer, resource audience and token typ remain independently pinned',async()=>{
  const request=async(url)=>{
    if(url===discovery)return json(metadata);
    if(url===jwksUri)return json({keys:[jwk]});
    throw Error('unconfigured endpoint');
  };
  const provider=await createV2OAuthProviderBootstrap({issuer,resource,request});
  await assert.rejects(provider.verifyAccessToken(jwt({
    iss:'https://tenant.eu.auth0.com/'
  })),{code:'V2_JWT_ISSUER_OR_AUDIENCE_MISMATCH'});
  await assert.rejects(provider.verifyAccessToken(jwt({
    aud:'https://other.example.test/mcp-v2'
  })),{code:'V2_JWT_ISSUER_OR_AUDIENCE_MISMATCH'});
  await assert.rejects(provider.verifyAccessToken(jwt({typ:'JWT'})),{
    code:'V2_JWT_HEADER_REJECTED'
  });
});

test('discovery refuses insecure issuers, redirects, wrong content type and oversized metadata',async()=>{
  let calls=0;
  await assert.rejects(fetchV2OAuthProviderMetadata({
    issuer:'http://idp.example.test/realms/commander',resource,
    request:async()=>{calls++;return json(metadata);}
  }),{code:'V2_PROVIDER_HTTPS_REQUIRED'});
  assert.equal(calls,0);

  await assert.rejects(fetchV2OAuthProviderMetadata({
    issuer,resource,request:async(url,init)=>{
      assert.equal(url,discovery);assert.equal(init.redirect,'error');
      return new Response('redirect',{status:302,headers:{location:'https://evil.example.test'}});
    }
  }),{code:'V2_PROVIDER_DISCOVERY_HTTP_ERROR'});

  await assert.rejects(fetchV2OAuthProviderMetadata({
    issuer,resource,request:async()=>new Response(JSON.stringify(metadata),{
      status:200,headers:{'content-type':'text/html'}
    })
  }),{code:'V2_PROVIDER_DISCOVERY_CONTENT_TYPE_INVALID'});

  await assert.rejects(fetchV2OAuthProviderMetadata({
    issuer,resource,request:async()=>new Response('x'.repeat(65537),{
      status:200,headers:{'content-type':'application/json'}
    })
  }),{code:'V2_PROVIDER_DISCOVERY_TOO_LARGE'});
});

test('discovery refuses issuer substitution and providers without PKCE S256',async()=>{
  await assert.rejects(fetchV2OAuthProviderMetadata({
    issuer,resource,request:async()=>json({...metadata,issuer:'https://evil.example.test'})
  }),{code:'V2_PROVIDER_ISSUER_MISMATCH'});
  await assert.rejects(fetchV2OAuthProviderMetadata({
    issuer,resource,request:async()=>json({
      ...metadata,code_challenge_methods_supported:['plain']
    })
  }),{code:'V2_PROVIDER_PKCE_S256_REQUIRED'});
});

test('discovery rejects a final response URL different from the pinned endpoint',async()=>{
  const response={
    status:200,ok:true,url:'https://evil.example.test/.well-known/openid-configuration',
    headers:new Headers({'content-type':'application/json'}),
    body:new Blob([JSON.stringify(metadata)]).stream()
  };
  await assert.rejects(fetchV2OAuthProviderMetadata({
    issuer,resource,request:async()=>response
  }),{code:'V2_PROVIDER_DISCOVERY_REDIRECT'});
});
