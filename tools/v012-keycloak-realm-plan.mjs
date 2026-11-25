// v0.12 / G1: deterministic non-credential Keycloak 26.x realm template.
// This is configuration for an owner-reviewed *future* issuer, NOT enrollment.
// Security baseline: the browser client is disabled by design. Never import
// an enabled OAuth client, owner identity, secret, or wildcard redirect here.
function fail(code){throw Object.assign(new Error(code),{code});}
function https(value,kind){
  if(typeof value!=='string'||value.length>2048||/[\u0000-\u001f\\*]/.test(value))
    fail('RC012_'+kind+'_HTTPS_REQUIRED');
  let url;
  try{url=new URL(value);}catch{fail('RC012_'+kind+'_HTTPS_REQUIRED');}
  if(url.protocol!=='https:'||!url.hostname||!url.hostname.includes('.')
    ||url.hostname==='localhost'||url.hostname.endsWith('.localhost')
    ||url.hostname==='127.0.0.1'||url.username||url.password||url.search||url.hash
    ||url.port&&url.port!=='443'
    ||url.pathname.includes('//')||url.pathname.includes('/../')
    ||url.href!==value)
    fail('RC012_'+kind+'_HTTPS_REQUIRED');
  return value;
}
const ID=/^[a-z][a-z0-9-]{2,63}$/;
/** No credentials and no users. Client stays disabled until explicit owner approval. */
export function createV012KeycloakRealmPlan({
  issuer,resource,clientId='commander-chatgpt',redirectUris=[]
}={}){
  const realm='commander-v012';
  const pinnedIssuer=https(issuer,'ISSUER');
  const url=new URL(pinnedIssuer);
  if(url.pathname!=='/realms/'+realm)fail('RC012_ISSUER_REALM_MISMATCH');
  const audience=https(resource,'RESOURCE');
  if(!ID.test(clientId))fail('RC012_CLIENT_ID_INVALID');
  if(!Array.isArray(redirectUris)||redirectUris.length>8
    ||new Set(redirectUris).size!==redirectUris.length)
    fail('RC012_REDIRECT_URIS_INVALID');
  const redirects=redirectUris.map(u=>https(u,'REDIRECT_URI'));
  // Separate consent and current-chat native attestation are mandatory in
  // Commander: none of those authorities may be implied by this realm.
  return {
    realm,enabled:true,displayName:'Commander v0.12',
    registrationAllowed:false,registrationEmailAsUsername:false,
    resetPasswordAllowed:false,rememberMe:false,
    loginWithEmailAllowed:false,duplicateEmailsAllowed:false,
    editUsernameAllowed:false,bruteForceProtected:true,
    roles:{realm:[{name:'commander-operator',
      description:'Owner-reviewed role; no accounts or role grants in this plan'}]},
    clientScopes:[{
      name:'commander.workflow',protocol:'openid-connect',
      attributes:{'include.in.token.scope':'true',
        'display.on.consent.screen':'true'},
      protocolMappers:[{
        name:'commander-resource-audience',protocol:'openid-connect',
        protocolMapper:'oidc-audience-mapper',consentRequired:false,
        config:{'included.custom.audience':audience,
          'access.token.claim':'true','id.token.claim':'false'}
      }]
    }],
    clients:[{
      clientId,enabled:false,protocol:'openid-connect',
      publicClient:true,bearerOnly:false,
      standardFlowEnabled:true,implicitFlowEnabled:false,
      directAccessGrantsEnabled:false,serviceAccountsEnabled:false,
      authorizationServicesEnabled:false,
      redirectUris:redirects,webOrigins:[],
      optionalClientScopes:['commander.workflow'],
      attributes:{'pkce.code.challenge.method':'S256',
        'oauth2.device.authorization.grant.enabled':'false'}
    }],
    users:[],
    // Audit-only metadata outside of realm import: keep operator constraints in
    // a companion plan, never treat this JSON as consent or authentication.
  };
}

/** Pure safety introspection for CI; does not open network or write files. */
export function assessV012KeycloakRealmPlan(realmPlan,{issuer,resource}={}){
  const expected=createV012KeycloakRealmPlan({issuer,resource,
    clientId:realmPlan?.clients?.[0]?.clientId,
    redirectUris:realmPlan?.clients?.[0]?.redirectUris});
  if(JSON.stringify(realmPlan)!==JSON.stringify(expected))
    fail('RC012_REALM_PLAN_NOT_CANONICAL');
  return Object.freeze({importableTemplate:true,
    oauthClientEnabled:false,ownerAccountsCreated:false,
    ownerConsentIssued:false,chatAuthenticated:false,
    publicEndpointPublished:false,resourceAudiencePinned:true,
    pkceS256Required:true});
}
