// Bind the existing V2 WorkflowStore dispatcher to an owner-controlled G1
// mTLS runtime. Importing this module opens no listener and grants no authority.
// Real OAuth, current-chat attestation and native owner consent are mandatory.
import {createV2CandidateMcpDispatcher} from './v2-mcp-workflow-dispatcher.mjs';
import {normalizeV2Route} from './v2-routing-contract.mjs';
import {
  createV101G1LoopbackRuntime,createV101G1PrivateTunnelRuntime
} from './v101-g1-loopback-runtime.mjs';

const SESSION=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TRANSPORTS=Object.freeze({
  'direct-openai-mtls':createV101G1LoopbackRuntime,
  'private-tunnel-client-mtls':createV101G1PrivateTunnelRuntime
});
function fail(code){throw Object.assign(new Error(code),{code});}
function record(v){return v!==null&&typeof v==='object'&&!Array.isArray(v)
  &&[Object.prototype,null].includes(Object.getPrototypeOf(v));}

/**
 * Canonical WorkflowStore adapter. The authenticated mTLS transport's
 * conversation is fixed before any OAuth/owner callback. Independently signed
 * native invocation proof must name that SAME host, profile and conversation;
 * a permissive or mistaken resolver cannot dispatch to a different chat.
 */
export function createV101CanonicalWorkflowDispatcherFactory({
  hostId,profileId,resource,authorizationServers,issuer,audience,
  verifyAccessToken,resolvePrincipal,now=Date.now,
  assertionTrust,observedNativeSession,resolveTrustedInvocation,
  workflowStore,grantRegistry,authorizeTool,dispatch,loadAuthenticatedProfile
}={}){
  if(typeof hostId!=='string'||!SESSION.test(hostId)
    ||typeof profileId!=='string'||!SESSION.test(profileId)
    ||typeof resource!=='string'||resource!==audience
    ||typeof issuer!=='string'||!Array.isArray(authorizationServers)
    ||!authorizationServers.includes(issuer)
    ||typeof verifyAccessToken!=='function'
    ||typeof resolvePrincipal!=='function'
    ||typeof observedNativeSession!=='function'
    ||typeof resolveTrustedInvocation!=='function'
    ||typeof authorizeTool!=='function'||typeof dispatch!=='function'
    ||typeof now!=='function'
    ||!assertionTrust||!workflowStore||!grantRegistry
    ||(loadAuthenticatedProfile!==undefined
      &&typeof loadAuthenticatedProfile!=='function'))
    fail('V101_G1_CANONICAL_WORKFLOW_BOOTSTRAP_REQUIRED');
  return async function createTrustedDispatcher(transport){
    if(!record(transport)||transport.authenticated!==true
      ||typeof transport.sessionHandle!=='string'
      ||!SESSION.test(transport.sessionHandle))
      fail('V101_G1_AUTHENTICATED_SESSION_REQUIRED');
    const sessionHandle=transport.sessionHandle;
    return createV2CandidateMcpDispatcher({
      resource,authorizationServers,issuer,audience,
      verifyAccessToken,resolvePrincipal,now,
      assertionTrust,observedNativeSession,
      resolveTrustedInvocation:async action=>{
        const trusted=await resolveTrustedInvocation(action);
        if(!record(trusted)||!Object.hasOwn(trusted,'route')
          ||!Object.hasOwn(trusted,'assertion'))
          fail('V2_MCP_CHAT_ATTESTATION_REQUIRED');
        let route;
        try{route=normalizeV2Route(trusted.route);}
        catch{fail('V2_MCP_CHAT_ATTESTATION_REQUIRED');}
        if(route.hostId!==hostId||route.profileId!==profileId
          ||route.conversationId!==sessionHandle)
          fail('V2_MCP_CHAT_ATTESTATION_REQUIRED');
        // Forward the independently normalized immutable route, never the
        // resolver-owned mutable object across this async V2 boundary.
        return Object.freeze({route,assertion:trusted.assertion});
      },
      workflowStore,grantRegistry,authorizeTool,dispatch,
      ...(loadAuthenticatedProfile?{loadAuthenticatedProfile}:{})
    });
  };
}

/**
 * Explicit protected transport selection; never falls back to legacy HTTP.
 * The native owner host validates the TLS peer, owner route and grant stack.
 * This launcher requires trusted in-process callbacks, not JSON/env grants.
 */
export function createV101G1CanonicalWorkflowRuntime({
  port,platform=process.platform,transport,hostOptions,workflow
}={}){
  const makeRuntime=TRANSPORTS[transport];
  const workflowKeys=new Set(['assertionTrust','observedNativeSession',
    'resolveTrustedInvocation','workflowStore','grantRegistry','authorizeTool',
    'dispatch','loadAuthenticatedProfile']);
  if(!makeRuntime||!record(hostOptions)||!record(workflow)
    ||Object.hasOwn(hostOptions,'createTrustedDispatcher')
    ||Object.keys(workflow).some(key=>!workflowKeys.has(key)))
    fail('V101_G1_CANONICAL_RUNTIME_BOOTSTRAP_REQUIRED');
  const createTrustedDispatcher=createV101CanonicalWorkflowDispatcherFactory({
    ...workflow,
    hostId:hostOptions.hostId,profileId:hostOptions.profileId,
    resource:hostOptions.resource,authorizationServers:hostOptions.authorizationServers,
    issuer:hostOptions.issuer,audience:hostOptions.audience,
    verifyAccessToken:hostOptions.verifyAccessToken,
    resolvePrincipal:hostOptions.resolvePrincipal,now:hostOptions.now??Date.now
  });
  return makeRuntime({
    port,platform,hostOptions:{...hostOptions,createTrustedDispatcher}
  });
}
