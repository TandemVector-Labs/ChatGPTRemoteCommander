// PRIVATE mTLS pair -> native owner consent proof (NOT ChatGPT user identity).
// This proof merely establishes an independently pinned LOCAL tunnel instance
// and an untrusted conversation correlator before an explicit OS-owner prompt.
// No public OAuth, new tunnel, credential exposure, OS elevation or tool grants.
import {createHmac,randomBytes} from 'node:crypto';
import {isProxy} from 'node:util/types';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH=/^[a-f0-9]{64}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};

export function createV2PrivateOwnerSessionProofAuthority({
  profileId,expectedTunnelIdHash,expectedOwnerSidHash,
  attestTransport,resolveCurrentOwnerSidHash,now=Date.now
}={}){
  if(typeof profileId!=='string'||!ID.test(profileId)
    ||typeof expectedTunnelIdHash!=='string'||!HASH.test(expectedTunnelIdHash)
    ||typeof expectedOwnerSidHash!=='string'||!HASH.test(expectedOwnerSidHash)
    ||typeof attestTransport!=='function'
    ||typeof resolveCurrentOwnerSidHash!=='function'
    ||typeof now!=='function')
    fail('V2_PRIVATE_OWNER_PROOF_BOOTSTRAP_REQUIRED');
  const secret=randomBytes(32);
  const issued=new WeakMap();
  let closed=false;
  async function issue({request,sessionHandle}={}){
    if(closed)fail('V2_PRIVATE_OWNER_PROOF_CLOSED');
    // Session field is a correlation hint from the existing per-pair Plugin.
    // The native OS owner must still consent to the selected exact route.
    if(typeof sessionHandle!=='string'||!ID.test(sessionHandle)
      ||sessionHandle==='.'||sessionHandle==='..'
      ||sessionHandle.startsWith('mcp-'))
      fail('V2_PRIVATE_OWNER_PROOF_SESSION_INVALID');
    const before=await resolveCurrentOwnerSidHash();
    if(before!==expectedOwnerSidHash)fail('V2_PRIVATE_OWNER_PROOF_OWNER_CHANGED');
    const transport=await attestTransport(request);
    if(transport?.authenticated!==true
      ||transport.peerType!=='owner-pinned-private-tunnel-mtls'
      ||transport.sessionSource!=='native-owner-private-pair')
      fail('V2_PRIVATE_OWNER_PROOF_TRANSPORT_REQUIRED');
    const after=await resolveCurrentOwnerSidHash();
    const timestamp=now();
    if(closed||before!==after||after!==expectedOwnerSidHash
      ||!Number.isSafeInteger(timestamp)||timestamp<0)
      fail('V2_PRIVATE_OWNER_PROOF_OWNER_CHANGED');
    // A single-use capability needs a fresh digest for EACH owner-consent
    // attempt. A deterministic digest for one chat would ambiguously identify
    // an earlier revoked binding after re-enrollment of that same chat.
    const nonce=randomBytes(32);
    const tokenSha256=createHmac('sha256',secret)
      .update(JSON.stringify(['commander.private.owner.session.v2',
        profileId,expectedTunnelIdHash,expectedOwnerSidHash,sessionHandle]))
      .update(nonce)
      .digest('hex');
    nonce.fill(0);
    const capability=Object.freeze(Object.create(null));
    issued.set(capability,Object.freeze({source:'native-platform-session',
      sessionHandle,tokenSha256}));
    return capability;
  }
  function inspect(value){
    if(closed||!value||typeof value!=='object'||Array.isArray(value)
      ||isProxy(value))return null;
    return issued.get(value)??null;
  }
  function consume(value){
    const result=inspect(value);
    if(!result)fail('V2_PRIVATE_OWNER_PROOF_REQUIRED');
    issued.delete(value);
    return result;
  }
  return Object.freeze({issue,consume,inspect,
    close(){closed=true;secret.fill(0);}});
}
