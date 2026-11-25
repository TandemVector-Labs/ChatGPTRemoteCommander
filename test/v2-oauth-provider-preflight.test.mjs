import test from 'node:test';
import assert from 'node:assert/strict';
import { validateV2OAuthProvider } from '../src/v2-oauth-provider-preflight.mjs';
import { createV2ProtectedResourceMetadata } from '../src/v2-oauth-resource-metadata.mjs';

const issuer='https://sso.commander.example/realms/commander';
const resource='https://commander.example/mcp-v2';
const metadata={
  issuer,
  authorization_endpoint:issuer+'/protocol/openid-connect/auth',
  token_endpoint:issuer+'/protocol/openid-connect/token',
  jwks_uri:issuer+'/protocol/openid-connect/certs',
  response_types_supported:['code'],
  grant_types_supported:['authorization_code'],
  code_challenge_methods_supported:['S256'],
  scopes_supported:['commander.workflow'],
  token_endpoint_auth_methods_supported:['client_secret_basic','none'],
  authorization_response_iss_parameter_supported:true
};

test('hybrid broker preflight accepts the single Keycloak resource issuer with either explicitly configured JWT type',()=>{
  for(const tokenType of ['at+jwt','JWT']){
    const result=validateV2OAuthProvider({
      issuer,resource,metadata,tokenType,
      requiredScopes:['commander.workflow']
    });
    assert.equal(result.issuer,issuer);
    assert.equal(result.audience,resource);
    assert.equal(result.tokenType,tokenType);
    assert.equal(result.claimOfAuthenticatedChat,false);
    assert.equal(result.issuerResponseIdentificationAdvertised,true);
  }
});

test('hybrid broker preflight refuses an implicit or unsupported token type',()=>{
  assert.throws(()=>validateV2OAuthProvider({
    issuer,resource,metadata,tokenType:'dpop+jwt'
  }),{code:'V2_PROVIDER_TOKEN_TYPE_INVALID'});
});

test('hybrid broker preflight retains strict issuer, HTTPS, PKCE and scope checks',()=>{
  assert.throws(()=>validateV2OAuthProvider({
    issuer:'https://wrong.example/realms/commander',resource,metadata
  }),{code:'V2_PROVIDER_ISSUER_MISMATCH'});
  assert.throws(()=>validateV2OAuthProvider({
    issuer,resource,metadata:{...metadata,code_challenge_methods_supported:['plain']}
  }),{code:'V2_PROVIDER_PKCE_S256_REQUIRED'});
  assert.throws(()=>validateV2OAuthProvider({
    issuer,resource,metadata:{...metadata,scopes_supported:['openid']}
  }),{code:'V2_PROVIDER_SCOPE_NOT_ADVERTISED'});
});

test('Commander publishes one Keycloak issuer; Auth0 remains an upstream brokered identity provider',()=>{
  const result=validateV2OAuthProvider({issuer,resource,metadata});
  const protectedResource=createV2ProtectedResourceMetadata({
    resource,authorizationServers:[issuer]
  });
  assert.equal(result.issuer,issuer);
  assert.equal(result.audience,resource);
  assert.deepEqual(protectedResource.body.authorization_servers,[issuer]);
  assert.throws(()=>createV2ProtectedResourceMetadata({
    resource,authorizationServers:[issuer,'https://tenant.eu.auth0.com/']
  }),{code:'V2_RESOURCE_AUTHORIZATION_SERVER_REQUIRED'});
});
