// Owner-local staged HTTPS/mTLS bootstrap for the existing Linux account+tunnel.
// NO_GRANT mode: proves owner-enrolled transport and permits only the actual
// OS-owner's explicit, revocable J01 pair-session approval. It can NEVER
// enroll signed Workers, issue exact action grants or execute Core effects.
// A pair scope does NOT independently authenticate any individual ChatGPT chat.
// Do not use this staging bootstrap as the final Full Access promotion.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,X509Certificate} from 'node:crypto';
import {createLinuxNativeOwnerSessionProvider}
  from './native-owner-session-provider-linux.mjs';
import {readLinuxOwnerTunnelPin}
  from './linux-private-tunnel-owner-pin.mjs';
import {createLinuxSignedBrokerTransport}
  from './linux-native-tunnel-broker-client.mjs';
import {deriveV101PrivatePairSessionHandle}
  from './v101-private-pair-native-owner-stack.mjs';

const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
function privateDirectory(dir,uid){
  const s=fs.lstatSync(dir);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid
    ||(s.mode&0o077)!==0||fs.realpathSync.native(dir)!==dir)
    fail('RC012_OWNER_BOOTSTRAP_DIRECTORY_NOT_PRIVATE');
}
function privateFile(p,uid,maxBytes=65536){
  const s=fs.lstatSync(p);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1
    ||s.uid!==uid||(s.mode&0o077)!==0||s.size<1||s.size>maxBytes)
    fail('RC012_OWNER_BOOTSTRAP_FILE_NOT_PRIVATE');
  return fs.readFileSync(p,'utf8');
}
const denied=async()=>fail('RC012_OWNER_BOOTSTRAP_NO_GRANT');

/**
 * The existing exact owner-pinned Tunnel and current OS-owner hash determine
 * ONE stable, independently derived pair handle. An incoming MCP _meta value
 * cannot change host/profile/seat; every nonmatching session is rejected.
 * This is a native J01 binding route, NEVER a tool execution route/grant.
 */
export function createV012OwnerPairBindingRoute({
  hostId,profileId,ownerSidHash,tunnelIdHash
}={}){
  if(typeof hostId!=='string'||!ID.test(hostId)
    ||typeof profileId!=='string'||!ID.test(profileId)
    ||typeof ownerSidHash!=='string'||!/^[a-f0-9]{64}$/.test(ownerSidHash)
    ||typeof tunnelIdHash!=='string'||!/^[a-f0-9]{64}$/.test(tunnelIdHash))
    fail('RC012_OWNER_PAIR_BINDING_SCOPE_INVALID');
  const sessionHandle=deriveV101PrivatePairSessionHandle({
    profileId,expectedTunnelIdHash:tunnelIdHash,
    expectedOwnerSidHash:ownerSidHash
  });
  const route=Object.freeze({
    hostId,profileId,principalId:'owner-not-enrolled',
    conversationId:sessionHandle,operationId:'owner-bind',
    target:Object.freeze({kind:'desktop-seat',id:'current-owner'})
  });
  return Object.freeze({
    sessionHandle,
    async resolveOwnerRoute(handle){
      if(handle!==sessionHandle)fail('RC012_OWNER_PAIR_BINDING_ROUTE_MISMATCH');
      return route;
    }
  });
}

export async function createOwnerPrivatePairBootstrap({profileId,configSha256}={}){
  if(process.platform!=='linux'
    ||process.env.RC012_OWNER_BOOTSTRAP_SCOPE!=='OWNER_ENROLLED_NO_GRANT'
    ||typeof profileId!=='string'||!ID.test(profileId)
    ||typeof configSha256!=='string'||!/^[a-f0-9]{64}$/.test(configSha256))
    fail('RC012_OWNER_BOOTSTRAP_SCOPE_REQUIRED');
  const selected=process.env.RC012_OWNER_TUNNEL_PROFILE;
  const port=Number(process.env.RC012_OWNER_PRIVATE_HTTPS_PORT);
  if(typeof selected!=='string'||!ID.test(selected)
    ||!Number.isSafeInteger(port)||port<1024||port>65535)
    fail('RC012_OWNER_BOOTSTRAP_PROFILE_PORT_REQUIRED');
  const uid=process.getuid(),home=os.homedir();
  const configPath=process.env.REMOTE_COMMANDER_CONFIG;
  const configDir=path.join(home,'.local','state','chatgpt-remote-commander',
    'profiles',profileId);
  privateDirectory(configDir,uid);
  if(configPath!==path.join(configDir,'config.json'))
    fail('RC012_OWNER_BOOTSTRAP_CONFIG_NOT_PINNED');
  const raw=privateFile(configPath,uid,131072);
  if(createHash('sha256').update(raw).digest('hex')!==configSha256)
    fail('RC012_OWNER_BOOTSTRAP_CONFIG_CHANGED');
  const config=JSON.parse(raw);
  if(config.instance?.profile!==profileId||config.host!=='127.0.0.1')
    fail('RC012_OWNER_BOOTSTRAP_CORE_PROFILE_MISMATCH');
  const pairDir=path.join(home,'.config','chatgpt-remote-commander',
    'private-pair',selected==='chatgpt-remote-commander'?'default':selected);
  privateDirectory(pairDir,uid);
  const enrolled=readLinuxOwnerTunnelPin({directory:pairDir});
  if(enrolled.profileId!==selected||enrolled.hostId!==config.deviceName)
    fail('RC012_OWNER_BOOTSTRAP_TUNNEL_PROFILE_MISMATCH');
  const cert=privateFile(path.join(pairDir,'client.crt'),uid);
  const clientSha=createHash('sha256')
    .update(new X509Certificate(cert).raw).digest('hex');
  if(clientSha!==enrolled.expectedClientLeafDerSha256)
    fail('RC012_OWNER_BOOTSTRAP_CLIENT_CERT_CHANGED');
  const owner=createLinuxNativeOwnerSessionProvider({ownerIdentityMode:'host-uid-v2'});
  const ownerV2Hash=await owner.resolveOwnerSidHash();
  // The live v1 Tunnel enrollment remains owner-approved. Its real process
  // must be witnessed by the unsandboxed owner-native broker and its signed
  // v2 host-UID claim validated inside the protected Core namespace.
  const signedBroker=await createLinuxSignedBrokerTransport({
    hostId:enrolled.hostId,profileId:enrolled.profileId,
    expectedOwnerSidHash:ownerV2Hash,
    expectedClientLeafDerSha256:clientSha,
    expectedExecutableSha256:enrolled.expectedExecutableSha256,
    pinFile:path.join(pairDir,'owner-tunnel-trust.json'),
    socketPath:process.env.RC012_OWNER_WITNESS_SOCKET_PATH,
    publicKeyPath:process.env.RC012_OWNER_WITNESS_PUBLIC_KEY_PATH,
    resolveOwnerSidHash:owner.resolveOwnerSidHash
  });
  const pairBinding=createV012OwnerPairBindingRoute({
    hostId:enrolled.hostId,profileId:enrolled.profileId,
    ownerSidHash:ownerV2Hash,
    tunnelIdHash:signedBroker.expectedTunnelIdHash
  });
  const securityParent=path.join(home,'.local','state','chatgpt-remote-commander');
  const securityDir=path.join(securityParent,'private-pair-security-'+selected);
  fs.mkdirSync(securityDir,{recursive:true,mode:0o700});
  privateDirectory(securityDir,uid);
  return {
    port,
    identity:{
      hostId:enrolled.hostId,profileId:enrolled.profileId,
      principalId:'owner-not-enrolled',
      expectedTunnelIdHash:signedBroker.expectedTunnelIdHash,
      expectedOwnerSidHash:ownerV2Hash,
      resolveTransportIdentity:signedBroker.resolveTransportIdentity
    },
    tls:{
      certificatePem:privateFile(path.join(pairDir,'server.crt'),uid),
      privateKeyPem:privateFile(path.join(pairDir,'server.key'),uid),
      clientCaPem:privateFile(path.join(pairDir,'ca.crt'),uid),
      expectedClientLeafDerSha256:clientSha
    },
    security:{
      directory:securityDir,
      ownerSessionOptions:{ownerIdentityMode:'host-uid-v2'},
      issuer:'commander.local',audience:'remote-commander',
      resolveOwnerRoute:pairBinding.resolveOwnerRoute,
      resolveTrustedToolRoute:denied,
      resolveCurrentOwnerRoute:denied,resolveCurrentWorkerId:denied,
      workerAuthority:{authorizeWorker:denied},
      workerRegistry:{get:denied},withLease:denied
    }
  };
}
