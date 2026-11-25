import path from 'node:path';
import {V2GrantRegistry} from './v2-grant-registry.mjs';
import {createV2NativeOwnerSessionBindings} from './v2-native-owner-session-bindings.mjs';
import {createLinuxNativeOwnerSessionProvider} from './native-owner-session-provider-linux.mjs';
import {createNativeOwnerAdministrationAuthorizer} from './native-owner-administration-authorizer.mjs';
import {createV2PlatformSessionProofAuthority} from './v2-platform-session-proof.mjs';
import {createV2CandidateDirectHttpsGateway} from './v2-mcp-http-ingress.mjs';
import {createV101V2ProtectedDispatcherFactory} from './v101-v2-protected-dispatcher.mjs';

/**
 * Compose Linux native owner identity/session, visible consent and the existing
 * V2 grant registry. The caller must still supply independently trusted
 * platform-session attestation and canonical owner-route resolution.
 * This factory opens no HTTP listener, performs no enrollment and elevates no OS
 * privileges; the returned owner binding remains short-lived/in-memory.
 */
export function createLinuxV101OwnerSecurityStack({
  directory,attestPlatformSession,resolveOwnerRoute,now=Date.now,
  ownerSessionOptions={}
}={}){
  if(typeof directory!=='string'||!path.isAbsolute(directory)
    ||typeof attestPlatformSession!=='function'
    ||typeof resolveOwnerRoute!=='function'||typeof now!=='function'
    ||!ownerSessionOptions||typeof ownerSessionOptions!=='object'
    ||Array.isArray(ownerSessionOptions))
    throw new TypeError('V101_LINUX_OWNER_STACK_BOOTSTRAP_REQUIRED');
  const ownerSession=createLinuxNativeOwnerSessionProvider(ownerSessionOptions);
  const nativeSessionBindings=createV2NativeOwnerSessionBindings({
    attestPlatformSession,resolveOwnerRoute,
    observedNativeSession:ownerSession.observedNativeSession,
    resolveOwnerSidHash:ownerSession.resolveOwnerSidHash,
    authorizeBinding:ownerSession.authorizeBinding,
    authorizeRevocation:ownerSession.authorizeRevocation,
    now
  });
  try{
    const authorizeAdministration=createNativeOwnerAdministrationAuthorizer({
      ownerSessionProvider:ownerSession,nativeSessionBindings,now
    });
    const grantRegistry=new V2GrantRegistry({
      directory,authorizeAdministration,now
    });
    let closed=false;
    return Object.freeze({
      ownerSession,nativeSessionBindings,grantRegistry,
      close(){
        if(closed)return;
        closed=true;
        try{nativeSessionBindings.close();}finally{grantRegistry.close();}
      }
    });
  }catch(error){
    nativeSessionBindings.close();
    throw error;
  }
}


/**
 * Compose the Linux V1-01 owner/session/grant stack with the candidate direct
 * OpenAI-mTLS MCP gateway. OAuth verification, principal mapping, canonical
 * route resolution, exact argument policy, server certificate/key and the
 * canonical V2 dispatcher remain trusted host dependencies.
 *
 * This factory opens no listener and performs no enrollment. The first valid
 * protected tool call must pass OAuth verification, then receive explicit
 * native Linux owner consent before its token/session binding is created.
 */
export function createLinuxV101V2CandidateHost({
  directory,resource,authorizationServers,scopes,
  certificatePem,privateKeyPem,hostId,profileId,issuer,audience,
  verifyAccessToken,resolvePrincipal,resolveOwnerRoute,
  authorizeExactInvocation,createTrustedDispatcher,now=Date.now,
  ownerSessionOptions={}
}={}){
  const effectiveScopes=scopes??['commander.workflow'];
  if(typeof directory!=='string'||!path.isAbsolute(directory)
    ||typeof resource!=='string'||audience!==resource
    ||typeof issuer!=='string'||!Array.isArray(authorizationServers)
    ||!authorizationServers.includes(issuer)
    ||!Array.isArray(effectiveScopes)||!effectiveScopes.includes('commander.workflow')
    ||typeof verifyAccessToken!=='function'||typeof resolvePrincipal!=='function'
    ||typeof resolveOwnerRoute!=='function'
    ||typeof authorizeExactInvocation!=='function'
    ||typeof createTrustedDispatcher!=='function'||typeof now!=='function'
    ||!ownerSessionOptions||typeof ownerSessionOptions!=='object'
    ||Array.isArray(ownerSessionOptions))
    throw new TypeError('V101_LINUX_V2_HOST_BOOTSTRAP_REQUIRED');

  const platformSessionProofAuthority=createV2PlatformSessionProofAuthority();
  const ownerStack=createLinuxV101OwnerSecurityStack({
    directory,attestPlatformSession:platformSessionProofAuthority.consume,
    resolveOwnerRoute,now,ownerSessionOptions
  });
  try{
    const dispatcherFactory=createV101V2ProtectedDispatcherFactory({
      hostId,profileId,issuer,audience,verifyAccessToken,resolvePrincipal,
      resolveAttestedTokenBinding:ownerStack.nativeSessionBindings.resolveAttestedTokenBinding,
      nativeSessionBindings:ownerStack.nativeSessionBindings,
      grantRegistry:ownerStack.grantRegistry,authorizeExactInvocation,
      createTrustedDispatcher,resolveOwnerRoute,
      platformSessionProofAuthority,now
    });
    const gateway=createV2CandidateDirectHttpsGateway({
      resource,authorizationServers,scopes:effectiveScopes,certificatePem,privateKeyPem,
      dispatcherFactory,sessionSource:'openai/session',
      platformSessionProofAuthority,now
    });
    let closed=false;
    return Object.freeze({
      gateway,ownerSession:ownerStack.ownerSession,
      nativeSessionBindings:ownerStack.nativeSessionBindings,
      grantRegistry:ownerStack.grantRegistry,
      createUnboundTlsServer:gateway.createUnboundTlsServer,
      close(){
        if(closed)return;
        closed=true;
        ownerStack.close();
      }
    });
  }catch(error){
    ownerStack.close();
    throw error;
  }
}
