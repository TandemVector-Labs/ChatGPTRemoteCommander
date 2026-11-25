// V2-G1 candidate OAuth-to-owner-session boundary, not a token issuer or server.
// The verifyAccessToken callback MUST be supplied by a trusted OAuth 2.1 resource
// server / standard SDK that actually validates the token signature or introspection.
// Simply decoding JWT claims or trusting a model argument is NOT authentication.
// No live port, login or credentials are installed by this module.
import { normalizeV2Route } from './v2-routing-contract.mjs';
import { createV2VerifiedObservedCaller } from './v2-caller-assertion.mjs';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function fail(code){throw Object.assign(new Error(code),{code});}
function isId(v){return typeof v==='string'&&ID.test(v)&&v!=='.'&&v!=='..';}
function requireCallback(v){if(typeof v!=='function')fail('V2_OAUTH_TRUSTED_CALLBACK_REQUIRED');}
export function createV2OAuthObservedCaller({
  route,tool,args,assertion,assertionTrust,readAuthorization,
  verifyAccessToken,resolvePrincipal,observedNativeSession,
  issuer,audience,requiredScope='commander.workflow',requiredScopes,now=Date.now
}){
  const r=normalizeV2Route(route);
  for(const v of [readAuthorization,verifyAccessToken,resolvePrincipal,observedNativeSession,now])requireCallback(v);
  const enforcedScopes=requiredScopes===undefined?[requiredScope]:requiredScopes;
  if(!Array.isArray(enforcedScopes)||enforcedScopes.length<1
    ||enforcedScopes.length>32||new Set(enforcedScopes).size!==enforcedScopes.length
    ||enforcedScopes.some(scope=>!isId(scope))
    ||typeof issuer!=='string'||!issuer.startsWith('https://')
    ||typeof audience!=='string'||!audience.startsWith('https://'))
    fail('V2_OAUTH_RESOURCE_CONFIG_REQUIRED');
  const scopeSnapshot=Object.freeze([...enforcedScopes]);
  const observedAssertion=createV2VerifiedObservedCaller({
    route:r,tool,args,assertion,trust:assertionTrust,observedNativeSession,now
  });
  return async()=>{
    // This string is provided by the trusted HTTP boundary, NOT by tool parameters.
    const header=await readAuthorization();
    if(typeof header!=='string'||header.length>8192
      ||!/^Bearer [A-Za-z0-9._~+\/=:-]+$/.test(header))
      fail('V2_OAUTH_BEARER_REQUIRED');
    // OAuth cryptographic verification, token audience and PKCE setup belong to
    // the configured IDP and its established resource-server SDK.
    const claims=await verifyAccessToken(header.slice(7));
    if(!claims||typeof claims!=='object'||Array.isArray(claims))
      fail('V2_OAUTH_VERIFICATION_REQUIRED');
    const nowMs=now();
    if(!Number.isSafeInteger(nowMs)||!Number.isSafeInteger(claims.expiresAtMs)
      ||!Number.isSafeInteger(claims.notBeforeMs)
      ||claims.notBeforeMs>nowMs||claims.expiresAtMs<=nowMs)
      fail('V2_OAUTH_TOKEN_NOT_CURRENT');
    if(claims.issuer!==issuer||claims.audience!==audience)
      fail('V2_OAUTH_ISSUER_OR_AUDIENCE_MISMATCH');
    if(!isId(claims.subject)||!Array.isArray(claims.scopes)
      ||!scopeSnapshot.every(scope=>claims.scopes.includes(scope)))
      fail('V2_OAUTH_SCOPE_OR_SUBJECT_REQUIRED');
    const principal=await resolvePrincipal(claims.subject);
    if(!isId(principal)||principal!==r.principalId)
      fail('V2_OAUTH_PRINCIPAL_MISMATCH');
    // The signature also binds exact chat, target, tool and payload to the
    // native owner session. OAuth subject alone does not identify a chat.
    return observedAssertion();
  };
}
