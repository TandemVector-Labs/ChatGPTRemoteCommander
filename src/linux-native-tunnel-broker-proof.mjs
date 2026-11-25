// Read-only Linux native tunnel process attestation bridge.
// An owner-native broker signs exact, ephemeral process+health facts for a
// sandboxed Core. This signature is NOT a J01 consent, Worker or tool grant.
import {createPrivateKey,createPublicKey,sign,verify} from 'node:crypto';
import {isProxy} from 'node:util/types';

const DOMAIN='commander.native-owner-tunnel-broker-proof.v1';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH=/^[a-f0-9]{64}$/;
const KEYS=['schema','kind','nonce','hostId','profileId','ownerSidHash',
  'tunnelIdHash','clientLeafDerSha256','executableSha256','pinSha256',
  'pid','observedAtMs','expiresAtMs','lastPollAtMs','healthzStatus',
  'readyzStatus'];
const fail=code=>{throw Object.assign(new Error(code),{code});};
const isExactRecord=(record,keys)=>{
  if(!record||typeof record!=='object'||Array.isArray(record)||isProxy(record)
    ||![Object.prototype,null].includes(Object.getPrototypeOf(record)))
    return false;
  const actual=Reflect.ownKeys(record);
  return actual.length===keys.length&&actual.every(k=>{
    const d=Object.getOwnPropertyDescriptor(record,k);
    return typeof k==='string'&&keys.includes(k)
      &&d?.enumerable===true&&Object.hasOwn(d,'value');
  });
};
const fresh=(claims,now)=>{
  return Number.isSafeInteger(claims.observedAtMs)
    &&Number.isSafeInteger(claims.expiresAtMs)
    &&Number.isSafeInteger(claims.lastPollAtMs)
    &&claims.observedAtMs<=now+1000
    &&now-claims.observedAtMs<=5000
    &&claims.expiresAtMs>now
    &&claims.expiresAtMs-claims.observedAtMs<=5000
    &&claims.lastPollAtMs<=claims.observedAtMs
    &&claims.observedAtMs-claims.lastPollAtMs<120000;
};
export function validateLinuxNativeTunnelClaims(claims,{now=Date.now()}={}){
  if(!isExactRecord(claims,KEYS)
    ||claims.schema!==1||claims.kind!==DOMAIN
    ||![claims.hostId,claims.profileId].every(x=>typeof x==='string'
      &&ID.test(x)&&x!=='.'&&x!=='..')
    ||![claims.nonce,claims.ownerSidHash,claims.tunnelIdHash,
      claims.clientLeafDerSha256,claims.executableSha256,claims.pinSha256]
      .every(x=>typeof x==='string'&&HASH.test(x))
    ||!Number.isSafeInteger(claims.pid)||claims.pid<=1
    ||claims.healthzStatus!==200||claims.readyzStatus!==200
    ||!fresh(claims,now))
    fail('RC012_BROKER_NATIVE_PROOF_INVALID');
  return claims;
}
export function createLinuxNativeTunnelClaims({
  nonce,hostId,profileId,ownerSidHash,tunnelIdHash,clientLeafDerSha256,
  executableSha256,pinSha256,pid,lastPollAtMs,now=Date.now()
}={}){
  const claims={schema:1,kind:DOMAIN,nonce,hostId,profileId,
    ownerSidHash,tunnelIdHash,clientLeafDerSha256,executableSha256,
    pinSha256,pid,observedAtMs:now,expiresAtMs:now+4000,
    lastPollAtMs,healthzStatus:200,readyzStatus:200};
  validateLinuxNativeTunnelClaims(claims,{now});
  return Object.freeze(claims);
}
export function signLinuxNativeTunnelProof({claims,privateKeyPem,now=Date.now()}={}){
  validateLinuxNativeTunnelClaims(claims,{now});
  const key=createPrivateKey(privateKeyPem);
  if(key.asymmetricKeyType!=='ed25519')fail('RC012_BROKER_KEY_INVALID');
  const signature=sign(null,Buffer.from(JSON.stringify(claims)),key);
  return Object.freeze({claims,signature:signature.toString('base64')});
}
export function verifyLinuxNativeTunnelProof({
  packet,publicKeyPem,expected,now=Date.now()
}={}){
  try{
    if(!isExactRecord(packet,['claims','signature'])
      ||!isExactRecord(expected,[
        'nonce','hostId','profileId','ownerSidHash','clientLeafDerSha256',
        'executableSha256','pinSha256'
      ])||typeof packet.signature!=='string'
      ||!/^[A-Za-z0-9+/]{86}==$/.test(packet.signature))
      fail('RC012_BROKER_PACKET_INVALID');
    const claims=validateLinuxNativeTunnelClaims(packet.claims,{now});
    for(const [key,value] of Object.entries(expected)){
      if(claims[key]!==value)fail('RC012_BROKER_EXPECTED_IDENTITY_MISMATCH');
    }
    const key=createPublicKey(publicKeyPem);
    if(key.asymmetricKeyType!=='ed25519')fail('RC012_BROKER_KEY_INVALID');
    const binary=Buffer.from(packet.signature,'base64');
    if(binary.length!==64
      ||!verify(null,Buffer.from(JSON.stringify(claims)),key,binary))
      fail('RC012_BROKER_SIGNATURE_INVALID');
    return Object.freeze({...claims});
  }catch(error){
    if(String(error?.code??'').startsWith('RC012_BROKER_'))throw error;
    fail('RC012_BROKER_PROOF_UNVERIFIED');
  }
}
