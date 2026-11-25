// PRIVATE v0.12 native J01 composition for the EXISTING per-pair Tunnel.
// This is an unbound, owner-controlled source candidate; it does not listen,
// enable Full Access, issue system privileges or modify installed services.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createWindowsV101OwnerSecurityStack}
  from './v101-windows-owner-security-bootstrap.mjs';
import {createLinuxV101OwnerSecurityStack}
  from './v101-linux-owner-security-bootstrap.mjs';
import {createV2PrivateOwnerSessionProofAuthority}
  from './v2-private-owner-session-proof.mjs';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH=/^[a-f0-9]{64}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};

/** Canonical signed-out pair correlation only; NOT an individual ChatGPT chat. */
export function deriveV101PrivatePairSessionHandle({
  profileId,expectedTunnelIdHash,expectedOwnerSidHash
}={}){
  if(typeof profileId!=='string'||!ID.test(profileId)
    ||profileId==='.'||profileId==='..'
    ||![expectedTunnelIdHash,expectedOwnerSidHash].every(v=>
      typeof v==='string'&&HASH.test(v)))
    fail('V101_PRIVATE_PAIR_SCOPE_INVALID');
  return 'pair-'+createHash('sha256')
    .update(JSON.stringify(['commander.private.pair-scope.v1',profileId,
      expectedTunnelIdHash,expectedOwnerSidHash]))
    .digest('hex').slice(0,32);
}


/**
 * This composes mTLS-to-J01 proof with the actual Windows/Linux native
 * owner-session provider, existing V2NativeOwnerSessionBindings and the
 * existing durable V2GrantRegistry. Native consent, not a self-reported
 * ChatGPT session, decides whether a binding may be persisted in memory.
 *
 * resolveOwnerRoute MUST be an owner-controlled mapping, not MCP JSON.
 * A separate signed worker authority + exact tool grant and protected
 * ingress are still required before any privileged command can run.
 */
export function createV101PrivatePairNativeOwnerStack({
  platform=process.platform,directory,profileId,expectedTunnelIdHash,
  expectedOwnerSidHash,attestTransport,resolveOwnerRoute,now=Date.now,
  ownerSessionOptions={}
}={}){
  if(platform!==process.platform||!['win32','linux'].includes(platform)
    ||typeof directory!=='string'||!path.isAbsolute(directory)
    ||typeof profileId!=='string'||!ID.test(profileId)
    ||typeof expectedTunnelIdHash!=='string'||!HASH.test(expectedTunnelIdHash)
    ||typeof expectedOwnerSidHash!=='string'||!HASH.test(expectedOwnerSidHash)
    ||typeof attestTransport!=='function'||typeof resolveOwnerRoute!=='function'
    ||typeof now!=='function'||!ownerSessionOptions
    ||typeof ownerSessionOptions!=='object'||Array.isArray(ownerSessionOptions))
    fail('V101_PRIVATE_OWNER_STACK_BOOTSTRAP_REQUIRED');
  // Stable owner-controlled authorization scope for the ONE exclusive
  // account+host Tunnel. The hash is a non-secret routing label, never a
  // bearer token, ChatGPT identity assertion or grant.
  const pairHandle=deriveV101PrivatePairSessionHandle({
    profileId,expectedTunnelIdHash,expectedOwnerSidHash
  });
  let stack;
  const proof=createV2PrivateOwnerSessionProofAuthority({
    profileId,expectedTunnelIdHash,expectedOwnerSidHash,attestTransport,now,
    resolveCurrentOwnerSidHash:async()=>{
      if(!stack)fail('V101_PRIVATE_OWNER_STACK_NOT_READY');
      return stack.ownerSession.resolveOwnerSidHash();
    }
  });
  try{
    const factory=platform==='win32'
      ?createWindowsV101OwnerSecurityStack
      :createLinuxV101OwnerSecurityStack;
    stack=factory({directory,attestPlatformSession:proof.consume,
      resolveOwnerRoute,now,ownerSessionOptions});
    let closed=false;
    let pendingPairBinding=null;
    const issueBinding=async(request,sessionHandle)=>{
      const capability=await proof.issue({request,sessionHandle});
      // Existing single-use Native J01 and OS SID checks remain authoritative.
      return stack.nativeSessionBindings.bindTrusted(capability);
    };
    return Object.freeze({
      async resolveTrustedConversation(transport){
        if(closed)fail('V101_PRIVATE_OWNER_STACK_CLOSED');
        // Called only AFTER the gateway's independently pinned mTLS
        // attestation of the exclusive pair. Re-sample the native owner:
        // pair session labels must never outlive an OS owner switch.
        if(transport?.authenticated!==true
          ||transport.peerType!=='owner-pinned-private-tunnel-mtls'
          ||transport.sessionSource!=='native-owner-private-pair')
          fail('V101_PRIVATE_OWNER_PAIR_TRANSPORT_REQUIRED');
        const owner=await stack.ownerSession.resolveOwnerSidHash();
        if(owner!==expectedOwnerSidHash)
          fail('V101_PRIVATE_OWNER_PAIR_OWNER_CHANGED');
        return Object.freeze({
          source:'native-owner-pair-attested',sessionHandle:pairHandle
        });
      },
      async requestOwnerBinding({request,sessionHandle}={}){
        if(closed)fail('V101_PRIVATE_OWNER_STACK_CLOSED');
        if(sessionHandle!==pairHandle)return issueBinding(request,sessionHandle);
        // Multiple ChatGPT chats on the SAME account+host pair share the
        // owner-approved pair binding. Never re-prompt while its native OS
        // owner, route, binding epoch and expiry still validate.
        try{
          const current=await stack.nativeSessionBindings
            .resolveNativeOwnerContext(pairHandle);
          return Object.freeze({
            sessionHandle:pairHandle,bindingId:current.bindingId,
            expiresAtMs:current.expiresAtMs,alreadyBound:true
          });
        }catch(error){
          if(!['V2_SESSION_NOT_BOUND','V2_SESSION_BINDING_EXPIRED']
            .includes(error?.code))throw error;
        }
        // A concurrent chat may be awaiting the native consent dialog; keep
        // one owner prompt and one binding insertion for this pair.
        if(pendingPairBinding)return pendingPairBinding;
        const work=issueBinding(request,pairHandle);
        pendingPairBinding=work;
        try{return await work;}
        finally{if(pendingPairBinding===work)pendingPairBinding=null;}
      },
      async resolveOwnerContext(sessionHandle){
        if(closed)fail('V101_PRIVATE_OWNER_STACK_CLOSED');
        const native=await stack.nativeSessionBindings.resolveNativeOwnerContext(sessionHandle);
        return Object.freeze({...native,tunnelIdHash:expectedTunnelIdHash});
      },
      readCurrentOwnerSidHash:()=>stack.ownerSession.resolveOwnerSidHash(),
      nativeSessionBindings:stack.nativeSessionBindings,
      grantRegistry:stack.grantRegistry,
      close(){
        if(closed)return;
        closed=true;
        proof.close();
        stack.close();
      }
    });
  }catch(error){proof.close();stack?.close();throw error;}
}
