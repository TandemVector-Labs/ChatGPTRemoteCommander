// V1-01 handoff adapter for an independently authenticated V2 MCP ingress.
// This module does NOT open a port, enroll native owners, issue access tokens,
// or grant Full Access. A real transport attestor and OAuth provider are required.
// The installed V2 dispatcher still independently enforces the signed action,
// grant registry, workflow revision/lease and exact dispatch at execution.
import {isProxy} from 'node:util/types';
import {createHash} from 'node:crypto';
import {normalizeV2Route} from './v2-routing-contract.mjs';
import {createV2McpOAuthContract} from './v2-mcp-oauth-contract.mjs';
import {createV101ProtectedRouterBridge} from './full-access-protected-router-bridge.mjs';

const SESSION=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Only invalid credentials may trigger re-link; provider/network outages and
// native owner/session failures are NOT authentication failures.
const REAUTH_ERRORS=new Set([
  'V2_OAUTH_BEARER_REQUIRED','V2_OAUTH_VERIFICATION_REQUIRED',
  'V2_OAUTH_TOKEN_NOT_CURRENT','V2_JWT_MALFORMED',
  'V2_JWT_NOT_CURRENT','V2_JWT_SIGNATURE_INVALID',
  'V2_JWT_ISSUER_OR_AUDIENCE_MISMATCH','V2_JWT_SCOPES_INVALID',
  'V2_JWT_SUBJECT_INVALID','V2_JWT_TIME_INVALID','V2_JWT_HEADER_REJECTED'
]);
// Only protocol bootstrap/read-only discovery may bypass owner-action admission.
// Additional MCP method families (including resources, prompts or tasks)
// require an explicit scoped policy review, not a future V2 default passthrough.
const UNPRIVILEGED_RPC_METHODS=new Set([
  'initialize','notifications/initialized','ping','tools/list','server/discover'
]);
function fail(code){throw Object.assign(new Error(code),{code});}
function record(x){return x!==null&&typeof x==='object'&&!Array.isArray(x)
  &&!isProxy(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));}

// Ingress normally supplies JSON.parse data bounded to 64 KiB. Reject
// programmatic/synthetic inputs with getters, Symbols, Proxy or cycles,
// and freeze the *same* message used by the downstream V2 dispatcher.
// A JSON stringify/parse clone is NOT safe for exact +0/-0 semantics.
function freezeJson(value,state={seen:new WeakSet(),nodes:0},depth=0){
  if(++state.nodes>10000||depth>32)fail('V101_V2_PAYLOAD_BOUNDS');
  if(value===null||typeof value==='boolean'||typeof value==='string')return value;
  if(typeof value==='number'){
    if(!Number.isFinite(value))fail('V101_V2_PAYLOAD_NOT_JSON');
    return value;
  }
  if(typeof value!=='object'||isProxy(value)||state.seen.has(value))
    fail('V101_V2_PAYLOAD_NOT_JSON');
  state.seen.add(value);
  if(Array.isArray(value)){
    if(Object.getPrototypeOf(value)!==Array.prototype||value.length>10000
       ||Reflect.ownKeys(value).length!==value.length+1)
      fail('V101_V2_PAYLOAD_NOT_JSON');
    for(let i=0;i<value.length;i++){
      const d=Object.getOwnPropertyDescriptor(value,String(i));
      if(!d||!Object.hasOwn(d,'value')||d.enumerable!==true)
        fail('V101_V2_PAYLOAD_NOT_JSON');
      freezeJson(d.value,state,depth+1);
    }
  }else if(record(value)){
    const keys=Object.keys(value);
    if(keys.length>10000||keys.length!==Reflect.ownKeys(value).length)
      fail('V101_V2_PAYLOAD_NOT_JSON');
    for(const key of keys){
      if(['__proto__','constructor','prototype'].includes(key))
        fail('V101_V2_PAYLOAD_NOT_JSON');
      const d=Object.getOwnPropertyDescriptor(value,key);
      if(!d||!Object.hasOwn(d,'value')||d.enumerable!==true)
        fail('V101_V2_PAYLOAD_NOT_JSON');
      freezeJson(d.value,state,depth+1);
    }
  }else fail('V101_V2_PAYLOAD_NOT_JSON');
  Object.freeze(value);
  return value;
}

function denied(id){return Object.freeze({
  jsonrpc:'2.0',id:typeof id==='string'||Number.isSafeInteger(id)?id:null,
  result:{isError:true,content:[{type:'text',text:'V1-01 native owner authorization required.'}]}
});}

/**
 * Wrap V2's trusted dispatcher factory without changing installed routing.
 * Input dependencies MUST originate from owner-controlled bootstrap, not from
 * HTTP bodies, headers, caller-selected module paths, or model tool arguments.
 * The factory is intended for createV2CandidateHttpIngress.dispatcherFactory.
 * On each protected tool call, verify OAuth + independently owner-attested
 * token/session epoch + grant + exact action before delegating the SAME frozen
 * message to the canonical V2 dispatcher for its own authorizations.
 */
export function createV101V2ProtectedDispatcherFactory({
  hostId,profileId,issuer,audience,verifyAccessToken,resolvePrincipal,
  resolveAttestedTokenBinding,nativeSessionBindings,grantRegistry,
  authorizeExactInvocation,createTrustedDispatcher,
  resolveOwnerRoute,platformSessionProofAuthority,now=Date.now
}={}){
  if(typeof createTrustedDispatcher!=='function')
    fail('V101_V2_TRUSTED_DISPATCHER_FACTORY_REQUIRED');
  // Let the underlying Bridge validate exact fixed trust provider contracts.
  const config={hostId,profileId,issuer,audience,verifyAccessToken,
    resolvePrincipal,resolveAttestedTokenBinding,nativeSessionBindings,
    grantRegistry,authorizeExactInvocation,now};
  const sanity=createV101ProtectedRouterBridge(config);
  sanity.close();
  const ownerAdmission=resolveOwnerRoute!==undefined
    ||platformSessionProofAuthority!==undefined;
  if(ownerAdmission&&(typeof resolveOwnerRoute!=='function'
    ||typeof platformSessionProofAuthority?.inspect!=='function'
    ||typeof nativeSessionBindings?.bindTrusted!=='function'
    ||resolveAttestedTokenBinding!==nativeSessionBindings.resolveAttestedTokenBinding))
    fail('V101_V2_OWNER_ADMISSION_BOOTSTRAP_REQUIRED');
  // Only OAuth failure triggers ChatGPT re-link. Native session/route denial
  // must remain a generic deny: signing in again cannot attest a chat.
  const oauth=ownerAdmission?createV2McpOAuthContract({
    resource:audience,authorizationServers:[issuer],scopes:['commander.workflow']
  }):null;
  const pendingAdmissions=new Map();

  async function preflightOwnerOAuth(token,sessionHandle){
    const t=now();
    if(!Number.isSafeInteger(t)||t<0)return null;
    let claims;
    try{claims=await verifyAccessToken(token);}
    catch(error){
      if(REAUTH_ERRORS.has(error?.code))
        return Object.freeze({oauthFailure:'invalid_token'});
      throw error;
    }
    if(!record(claims))return Object.freeze({oauthFailure:'invalid_token'});
    // Pin verified claims before awaiting the principal and route providers.
    const signedIssuer=claims.issuer,signedAudience=claims.audience;
    const subject=claims.subject,notBeforeMs=claims.notBeforeMs;
    const expiresAtMs=claims.expiresAtMs;
    const scopes=Array.isArray(claims.scopes)?[...claims.scopes]:null;
    if(signedIssuer!==issuer||signedAudience!==audience
      ||typeof subject!=='string'||!SESSION.test(subject)
      ||!Number.isSafeInteger(notBeforeMs)||!Number.isSafeInteger(expiresAtMs)
      ||notBeforeMs>t||expiresAtMs<=t||!scopes)
      return Object.freeze({oauthFailure:'invalid_token'});
    if(!scopes.includes('commander.workflow'))
      return Object.freeze({oauthFailure:'insufficient_scope'});
    const principal=await resolvePrincipal(subject);
    if(typeof principal!=='string'||!SESSION.test(principal))return null;
    const ownerRouteValue=await resolveOwnerRoute(sessionHandle);
    const route=normalizeV2Route(ownerRouteValue);
    const checkedAt=now();
    if(!Number.isSafeInteger(checkedAt)||checkedAt<0||expiresAtMs<=checkedAt
      ||route.hostId!==hostId||route.profileId!==profileId
      ||route.principalId!==principal||route.conversationId!==sessionHandle)
      return null;
    return Object.freeze({principal,route,expiresAtMs});
  }

  function matchesOwnerBinding(binding,sessionHandle,tokenSha256){
    return record(binding)&&binding.source==='native-owner-attested'
      &&binding.sessionHandle===sessionHandle&&binding.tokenSha256===tokenSha256
      &&typeof binding.bindingId==='string'&&/^[0-9a-f]{32,64}$/.test(binding.bindingId)
      &&typeof binding.ownerSidHash==='string'&&/^[a-f0-9]{64}$/.test(binding.ownerSidHash)
      &&Number.isSafeInteger(binding.expiresAtMs)&&binding.expiresAtMs>now();
  }

  async function ensureOwnerBinding(platformProof,sessionHandle,tokenSha256){
    const proof=platformSessionProofAuthority.inspect(platformProof);
    if(!record(proof)||!['openai-chatgpt-mtls','openai-tunnel-client-mtls'].includes(proof.peerType)
      ||proof.sessionSource!=='openai/session'
      ||proof.sessionHandle!==sessionHandle||proof.tokenSha256!==tokenSha256)
      return false;
    const existing=await resolveAttestedTokenBinding(tokenSha256);
    if(existing!==null)return matchesOwnerBinding(existing,sessionHandle,tokenSha256);
    const pending=pendingAdmissions.get(tokenSha256);
    if(pending){
      if(pending.sessionHandle!==sessionHandle)return false;
      await pending.promise;
      return matchesOwnerBinding(
        await resolveAttestedTokenBinding(tokenSha256),sessionHandle,tokenSha256);
    }
    const entry={sessionHandle,promise:null};
    entry.promise=Promise.resolve().then(()=>nativeSessionBindings.bindTrusted(platformProof));
    pendingAdmissions.set(tokenSha256,entry);
    try{await entry.promise;}
    finally{if(pendingAdmissions.get(tokenSha256)===entry)pendingAdmissions.delete(tokenSha256);}
    return matchesOwnerBinding(
      await resolveAttestedTokenBinding(tokenSha256),sessionHandle,tokenSha256);
  }

  return async function ownerBoundDispatcherFactory(transport){
    if(!record(transport)||transport.authenticated!==true||
      typeof transport.sessionHandle!=='string'||
      !SESSION.test(transport.sessionHandle))
      fail('V101_V2_TRUSTED_TRANSPORT_REQUIRED');
    const proof=Object.freeze({authenticated:true,
      sessionHandle:transport.sessionHandle});
    const platformSessionProof=transport.platformSessionProof;
    const underlying=await createTrustedDispatcher(proof);
    if(!underlying||typeof underlying.handleRpc!=='function'
      ||typeof underlying.protectedResource?.metadataUrl!=='string')
      fail('V101_V2_TRUSTED_DISPATCHER_UNAVAILABLE');
    return Object.freeze({
      protectedResource:underlying.protectedResource,
      async handleRpc({authorization,message}={}){
        let bridge;
        let safeId=null;
        try{
          // Freeze BEFORE inspecting even the RPC method. This rejects
          // accessor/Proxy method switching and pins the exact message
          // subsequently forwarded to the canonical V2 dispatcher.
          freezeJson(message);
          if(!record(message))return denied(null);
          safeId=message.id;
          if(message.method!=='tools/call'){
            if(!UNPRIVILEGED_RPC_METHODS.has(message.method))
              return denied(safeId);
            return await underlying.handleRpc({authorization,message});
          }
          // Future or renamed tools cannot bypass V1-01 owner policy via
          // a default passthrough path. Explicitly allowlist new tools
          // only after a separate scoped native-owner policy review.
          if(!record(message.params)
             ||message.params.name!=='v2_workflow_step')
            return denied(safeId);
          // Missing bearer goes only to the canonical V2 OAuth challenge.
          if(typeof authorization!=='string'
            ||!authorization.startsWith('Bearer '))
            return await underlying.handleRpc({authorization,message});
          const bearer=/^Bearer ([A-Za-z0-9._~+\/=:-]{16,16384})$/.exec(authorization);
          if(!bearer)return denied(message.id);
          const token=bearer[1];
          if(ownerAdmission){
            const digest=createHash('sha256').update(token).digest('hex');
            const metaSession=message.params?._meta?.['openai/session'];
            if(metaSession!==proof.sessionHandle
              ||!platformSessionProofAuthority.inspect(platformSessionProof))
              return denied(message.id);
            const preflight=await preflightOwnerOAuth(token,proof.sessionHandle);
            if(preflight?.oauthFailure){
              return Object.freeze({jsonrpc:'2.0',id:message.id,
                result:oauth.toolAuthRequired({error:preflight.oauthFailure})});
            }
            if(!preflight)return denied(message.id);
            const ensured=await ensureOwnerBinding(platformSessionProof,proof.sessionHandle,digest);
            if(!ensured)return denied(message.id);
          }
          const action=message.params.arguments;
          if(!record(action)||!record(action.arguments))
            return denied(message.id);
          bridge=createV101ProtectedRouterBridge(config);
          const actor=await bridge.verifyCaller(token);
          if(!actor||actor.conversationId!==proof.sessionHandle
            ||!await bridge.authorizeTool(actor,{
              rpcMethod:'tools/call',tool:action.tool,arguments:action.arguments
            }))
            return denied(message.id);
          // No other await before handing the exact same frozen request to V2.
          return await underlying.handleRpc({authorization,message});
        }catch{
          // Never read an untrusted getter in the rejection path.
          return denied(safeId);
        }finally{bridge?.close();}
      }
    });
  };
}
