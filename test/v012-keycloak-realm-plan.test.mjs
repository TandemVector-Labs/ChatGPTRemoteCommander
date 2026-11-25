import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createV012KeycloakRealmPlan,assessV012KeycloakRealmPlan
} from '../tools/v012-keycloak-realm-plan.mjs';
import {validateV2OAuthProvider} from '../src/v2-oauth-provider-preflight.mjs';

const issuer='https://qa-issuer.example/realms/commander-v012';
const resource='https://qa-mcp.example/mcp';
const redirect='https://qa-callback.example/oauth/callback';

test('Keycloak 26 import template is disabled and has no issuer/user secrets',()=>{
  const p=createV012KeycloakRealmPlan({issuer,resource,redirectUris:[redirect]});
  assert.equal(p.realm,'commander-v012');
  assert.equal(p.registrationAllowed,false);
  assert.equal(p.bruteForceProtected,true);
  assert.equal(p.clients.length,1);
  assert.equal(p.clients[0].enabled,false);
  assert.equal(p.clients[0].publicClient,true);
  assert.equal(p.clients[0].standardFlowEnabled,true);
  assert.equal(p.clients[0].implicitFlowEnabled,false);
  assert.equal(p.clients[0].directAccessGrantsEnabled,false);
  assert.equal(p.clients[0].serviceAccountsEnabled,false);
  assert.equal(p.clients[0].attributes['pkce.code.challenge.method'],'S256');
  assert.deepEqual(p.clients[0].redirectUris,[redirect]);
  assert.deepEqual(p.clients[0].webOrigins,[]);
  assert.deepEqual(p.users,[]);
  assert.deepEqual(p.roles.realm.map(r=>r.name),['commander-operator']);
  assert.deepEqual(p.clients[0].optionalClientScopes,['commander.workflow']);
  assert.equal(p.clientScopes[0].protocolMappers[0].config['included.custom.audience'],resource);
  assert.equal(p.clientScopes[0].protocolMappers[0].config['access.token.claim'],'true');
  const dump=JSON.stringify(p);
  assert.doesNotMatch(dump,/"secret"\s*:|"password"\s*:|"credential"\s*:|\*\/\*/i);
  assert.deepEqual(assessV012KeycloakRealmPlan(p,{issuer,resource}),{
    importableTemplate:true,oauthClientEnabled:false,ownerAccountsCreated:false,
    ownerConsentIssued:false,chatAuthenticated:false,publicEndpointPublished:false,
    resourceAudiencePinned:true,pkceS256Required:true
  });
});
test('public issuer, exact callback and exact resource must be explicit',()=>{
  for(const bad of [
    'http://qa-issuer.example/realms/commander-v012',
    'https://localhost/realms/commander-v012',
    'https://127.0.0.1/realms/commander-v012',
    'https://qa-issuer.example:18443/realms/commander-v012',
    'https://qa-issuer.example/realms/master',
    'https://qa-issuer.example/realms/commander-v012?x=1',
    'https://qa-issuer.example/realms/commander-v012#fragment',
    'https://user:pass@qa-issuer.example/realms/commander-v012'
  ])assert.throws(()=>createV012KeycloakRealmPlan({issuer:bad,resource}),{code:/^RC012_/});
  for(const bad of [
    'http://qa-mcp.example/mcp','https://qa-mcp.example:8443/mcp',
    'https://qa-mcp.example/*','https://localhost/mcp'
  ])assert.throws(()=>createV012KeycloakRealmPlan({issuer,resource:bad}),{code:/^RC012_/});
  for(const bad of [
    'http://qa-callback.example/oauth/callback','https://qa-callback.example/*',
    'https://qa-callback.example:8443/oauth/callback'
  ])assert.throws(()=>createV012KeycloakRealmPlan({issuer,resource,redirectUris:[bad]}),{code:/^RC012_/});
  assert.throws(()=>createV012KeycloakRealmPlan({issuer,resource,
    redirectUris:[redirect,redirect]}),{code:'RC012_REDIRECT_URIS_INVALID'});
});
test('modifying import plan to enable a client never becomes accepted configuration',()=>{
  const p=createV012KeycloakRealmPlan({issuer,resource});
  p.clients[0].enabled=true;
  assert.throws(()=>assessV012KeycloakRealmPlan(p,{issuer,resource}),{
    code:'RC012_REALM_PLAN_NOT_CANONICAL'});
});
test('G1 production provider validation still requires real HTTPS discovery and scopes',()=>{
  const metadata={
    issuer,authorization_endpoint:issuer+'/protocol/openid-connect/auth',
    token_endpoint:issuer+'/protocol/openid-connect/token',
    jwks_uri:issuer+'/protocol/openid-connect/certs',
    response_types_supported:['code'],
    grant_types_supported:['authorization_code'],
    code_challenge_methods_supported:['S256'],
    scopes_supported:['openid','commander.workflow'],
    token_endpoint_auth_methods_supported:['client_secret_basic','none']
  };
  const verified=validateV2OAuthProvider({issuer,resource,metadata,
    requiredScopes:['commander.workflow']});
  assert.equal(verified.claimOfAuthenticatedChat,false);
  assert.equal(verified.issuer,issuer);
  assert.equal(verified.audience,resource);
  assert.throws(()=>validateV2OAuthProvider({issuer,resource,metadata:{
    ...metadata,issuer:'http://localhost/realms/commander-v012'
  }}),{code:'V2_PROVIDER_ISSUER_MISMATCH'});
});
