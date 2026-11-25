import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {
  createLinuxNativeTunnelClaims,signLinuxNativeTunnelProof,
  verifyLinuxNativeTunnelProof
} from '../src/linux-native-tunnel-broker-proof.mjs';

const keys=generateKeyPairSync('ed25519');
const priv=keys.privateKey.export({format:'pem',type:'pkcs8'});
const pub=keys.publicKey.export({format:'pem',type:'spki'});
const base=now=>({
  nonce:'a'.repeat(64),hostId:'mmz-host',profileId:'mmz-linux',
  ownerSidHash:'b'.repeat(64),tunnelIdHash:'c'.repeat(64),
  clientLeafDerSha256:'d'.repeat(64),executableSha256:'e'.repeat(64),
  pinSha256:'f'.repeat(64),pid:1234,lastPollAtMs:now-100,now
});
const expected=()=>({
  nonce:'a'.repeat(64),hostId:'mmz-host',profileId:'mmz-linux',
  ownerSidHash:'b'.repeat(64),clientLeafDerSha256:'d'.repeat(64),
  executableSha256:'e'.repeat(64),pinSha256:'f'.repeat(64)
});
test('fresh Ed25519 native witness binds exact pair, process and challenge',()=>{
  const now=Date.now(),claims=createLinuxNativeTunnelClaims(base(now));
  const packet=signLinuxNativeTunnelProof({claims,privateKeyPem:priv,now});
  const result=verifyLinuxNativeTunnelProof({
    packet,publicKeyPem:pub,expected:expected(),now:now+100
  });
  assert.equal(result.tunnelIdHash,'c'.repeat(64));
  assert.equal(result.pid,1234);
});
test('tampering signature or fact fails with no execution',()=>{
  const now=Date.now(),claims=createLinuxNativeTunnelClaims(base(now));
  const p=signLinuxNativeTunnelProof({claims,privateKeyPem:priv,now});
  for(const packet of [
    {...p,claims:{...p.claims,pid:999}},
    {...p,signature:'A'+p.signature.slice(1)},
    {...p,extra:'untrusted'},
    {...p,claims:{...p.claims,extra:'untrusted'}}
  ])assert.throws(()=>verifyLinuxNativeTunnelProof({
    packet,publicKeyPem:pub,expected:expected(),now:now+100
  }));
});
test('wrong native host, owner, profile, pin or nonce cannot replay proof',()=>{
  const now=Date.now(),claims=createLinuxNativeTunnelClaims(base(now));
  const p=signLinuxNativeTunnelProof({claims,privateKeyPem:priv,now});
  for(const patch of [
    {nonce:'1'.repeat(64)},{hostId:'foreign-host'},
    {profileId:'saeid-mmz'},{ownerSidHash:'0'.repeat(64)},
    {pinSha256:'2'.repeat(64)},{clientLeafDerSha256:'3'.repeat(64)},
    {executableSha256:'4'.repeat(64)}
  ])assert.throws(()=>verifyLinuxNativeTunnelProof({
    packet:p,publicKeyPem:pub,expected:{...expected(),...patch},now:now+100
  }));
});
test('replayed or future-dated proofs fail freshness',()=>{
  const now=Date.now(),claims=createLinuxNativeTunnelClaims(base(now));
  const p=signLinuxNativeTunnelProof({claims,privateKeyPem:priv,now});
  for(const t of [now-2000,now+6000])assert.throws(
    ()=>verifyLinuxNativeTunnelProof({
      packet:p,publicKeyPem:pub,expected:expected(),now:t
    })
  );
});
test('proxies and accessors never become trusted claims',()=>{
  const now=Date.now(),claims=createLinuxNativeTunnelClaims(base(now));
  const injected=Object.create(null);
  for(const [k,v] of Object.entries(claims))
    Object.defineProperty(injected,k,{enumerable:true,get(){throw Error('GETTER_EXECUTED')}});
  assert.throws(()=>signLinuxNativeTunnelProof({
    claims:injected,privateKeyPem:priv,now
  }),{code:'RC012_BROKER_NATIVE_PROOF_INVALID'});
  assert.throws(()=>signLinuxNativeTunnelProof({
    claims:new Proxy(claims,{}),privateKeyPem:priv,now
  }),{code:'RC012_BROKER_NATIVE_PROOF_INVALID'});
});
