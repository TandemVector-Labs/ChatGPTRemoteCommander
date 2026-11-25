// Compose the Windows owner-token J01 stack. No listener, elevation or grant
// is created without a separately trusted ChatGPT/OAuth route and native consent.
import path from 'node:path';
import {V2GrantRegistry} from './v2-grant-registry.mjs';
import {createV2NativeOwnerSessionBindings} from './v2-native-owner-session-bindings.mjs';
import {createWindowsNativeOwnerSessionProvider} from './native-owner-session-provider-windows.mjs';
import {createNativeOwnerAdministrationAuthorizer} from './native-owner-administration-authorizer.mjs';
import {createV2PlatformSessionProofAuthority} from './v2-platform-session-proof.mjs';
import {createV2CandidateDirectHttpsGateway} from './v2-mcp-http-ingress.mjs';
import {createV101V2ProtectedDispatcherFactory} from './v101-v2-protected-dispatcher.mjs';

export function createWindowsV101OwnerSecurityStack({
  directory,attestPlatformSession,resolveOwnerRoute,now=Date.now,
  ownerSessionOptions={}
}={}){
  if(typeof directory!=='string'||!path.isAbsolute(directory)
    ||typeof attestPlatformSession!=='function'
    ||typeof resolveOwnerRoute!=='function'||typeof now!=='function'
    ||!ownerSessionOptions||typeof ownerSessionOptions!=='object'
    ||Array.isArray(ownerSessionOptions))
    throw new TypeError('V101_WINDOWS_OWNER_STACK_BOOTSTRAP_REQUIRED');
  const ownerSession=createWindowsNativeOwnerSessionProvider(ownerSessionOptions);
  const nativeSessionBindings=createV2NativeOwnerSessionBindings({
    attestPlatformSession,resolveOwnerRoute,
    observedNativeSession:ownerSession.observedNativeSession,
    resolveOwnerSidHash:ownerSession.resolveOwnerSidHash,
    authorizeBinding:ownerSession.authorizeBinding,
    authorizeRevocation:ownerSession.authorizeRevocation,now
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
 * Direct HTTPS/OpenAI-mTLS composition only: the caller MUST inject genuine
 * server TLS credentials, verified OAuth issuer and session/owner route,
 * canonical dispatcher and exact invocation policy. Opens no port.
 */
export function createWindowsV101V2CandidateHost({
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
    ||!Array.isArray(effectiveScopes)
    ||!effectiveScopes.includes('commander.workflow')
    ||typeof verifyAccessToken!=='function'
    ||typeof resolvePrincipal!=='function'
    ||typeof resolveOwnerRoute!=='function'
    ||typeof authorizeExactInvocation!=='function'
    ||typeof createTrustedDispatcher!=='function'
    ||typeof now!=='function'
    ||!ownerSessionOptions||typeof ownerSessionOptions!=='object'
    ||Array.isArray(ownerSessionOptions))
    throw new TypeError('V101_WINDOWS_V2_HOST_BOOTSTRAP_REQUIRED');
  const platformSessionProofAuthority=createV2PlatformSessionProofAuthority();
  const ownerStack=createWindowsV101OwnerSecurityStack({
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
      resource,authorizationServers,scopes:effectiveScopes,
      certificatePem,privateKeyPem,dispatcherFactory,
      sessionSource:'openai/session',platformSessionProofAuthority,now
    });
    let closed=false;
    return Object.freeze({
      gateway,ownerSession:ownerStack.ownerSession,
      nativeSessionBindings:ownerStack.nativeSessionBindings,
      grantRegistry:ownerStack.grantRegistry,
      createUnboundTlsServer:gateway.createUnboundTlsServer,
      close(){
        if(closed)return;
        closed=true;ownerStack.close();
      }
    });
  }catch(error){ownerStack.close();throw error;}
}
