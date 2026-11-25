// G1 private-tunnel candidate: one owner-scoped V2 dispatcher, native session
// binding and an independently pinned local tunnel-client mTLS listener.
// No automatic listener, tunnel-client launch, OAuth provisioning or OS grants.
import path from 'node:path';
import {createV2PlatformSessionProofAuthority} from './v2-platform-session-proof.mjs';
import {createWindowsV101OwnerSecurityStack} from './v101-windows-owner-security-bootstrap.mjs';
import {createLinuxV101OwnerSecurityStack} from './v101-linux-owner-security-bootstrap.mjs';
import {createV101V2ProtectedDispatcherFactory} from './v101-v2-protected-dispatcher.mjs';
import {createV2CandidatePrivateTunnelHttpsGateway} from './v2-private-tunnel-https-gateway.mjs';

export function createV101PrivateTunnelOwnerHost({
  platform=process.platform,directory,resource,authorizationServers,scopes,
  certificatePem,privateKeyPem,clientCaPem,expectedClientLeafDerSha256,
  resolveTransportIdentity,hostId,profileId,issuer,audience,
  verifyAccessToken,resolvePrincipal,resolveOwnerRoute,
  authorizeExactInvocation,createTrustedDispatcher,now=Date.now,
  ownerSessionOptions={}
}={}){
  const effectiveScopes=scopes??['commander.workflow'];
  if(platform!==process.platform||!['win32','linux'].includes(platform)
    ||typeof directory!=='string'||!path.isAbsolute(directory)
    ||typeof resource!=='string'||audience!==resource
    ||typeof issuer!=='string'||!Array.isArray(authorizationServers)
    ||!authorizationServers.includes(issuer)
    ||!Array.isArray(effectiveScopes)||!effectiveScopes.includes('commander.workflow')
    ||typeof resolveTransportIdentity!=='function'
    ||typeof verifyAccessToken!=='function'
    ||typeof resolvePrincipal!=='function'
    ||typeof resolveOwnerRoute!=='function'
    ||typeof authorizeExactInvocation!=='function'
    ||typeof createTrustedDispatcher!=='function'||typeof now!=='function'
    ||!ownerSessionOptions||typeof ownerSessionOptions!=='object'
    ||Array.isArray(ownerSessionOptions))
    throw new TypeError('V101_PRIVATE_TUNNEL_OWNER_BOOTSTRAP_REQUIRED');
  const platformSessionProofAuthority=createV2PlatformSessionProofAuthority();
  const stackFactory=platform==='win32'
    ?createWindowsV101OwnerSecurityStack
    :createLinuxV101OwnerSecurityStack;
  const ownerStack=stackFactory({
    directory,attestPlatformSession:platformSessionProofAuthority.consume,
    resolveOwnerRoute,now,ownerSessionOptions
  });
  try{
    const dispatcherFactory=createV101V2ProtectedDispatcherFactory({
      hostId,profileId,issuer,audience,verifyAccessToken,resolvePrincipal,
      resolveAttestedTokenBinding:ownerStack.nativeSessionBindings.resolveAttestedTokenBinding,
      nativeSessionBindings:ownerStack.nativeSessionBindings,
      grantRegistry:ownerStack.grantRegistry,
      authorizeExactInvocation,createTrustedDispatcher,resolveOwnerRoute,
      platformSessionProofAuthority,now
    });
    const gateway=createV2CandidatePrivateTunnelHttpsGateway({
      resource,authorizationServers,scopes:effectiveScopes,
      certificatePem,privateKeyPem,clientCaPem,expectedClientLeafDerSha256,
      resolveTransportIdentity,profileId,
      dispatcherFactory,platformSessionProofAuthority,now
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
