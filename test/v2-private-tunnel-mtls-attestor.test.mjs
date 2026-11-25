import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createV2DirectMtlsTransportAttestor} from '../src/v2-direct-mtls-attestor.mjs';
import {createV2PrivateTunnelMtlsAttestor,createV2OwnerPinnedPrivatePairAttestor} from '../src/v2-private-tunnel-mtls-attestor.mjs';
// Mandatory v0.12 private mTLS source gate must also exercise exact-action owner/lease/receipt admission.
import './v2-private-pair-operation-gate.test.mjs';
import './v2-private-signed-worker-grant-adapter.test.mjs';
import './v2-private-owner-session-proof.test.mjs';
import './v101-private-pair-native-owner-stack.test.mjs';

const NOW=1794390000000;
const certBytes=Buffer.from('test-local-tunnel-certificate-opaque-bytes');
const sha=createHash('sha256').update(certBytes).digest('hex');
const profileId='emad';
const tunnel=()=>({
  source:'native-tunnel-attestor',provider:'openai-secure-mcp-tunnel',
  profileId,tunnelIdHash:'b'.repeat(64),ownerSidHash:'c'.repeat(64),
  authenticated:true,controlPlanePollOk:true,
  healthzStatus:200,readyzStatus:200,
  lastPollAtMs:NOW-100,expiresAtMs:NOW+60000
});
function socket(override={}){
  return {
    encrypted:true,authorized:true,
    getPeerCertificate:()=>({
      raw:certBytes,ca:false,ext_key_usage:['1.3.6.1.5.5.7.3.2'],
      valid_from:'Nov  1 00:00:00 2026 GMT',
      valid_to:'Dec  1 00:00:00 2026 GMT',
      ...override
    })
  };
}
const config=(overrides={})=>({
  profileId,expectedClientLeafDerSha256:sha,
  resolveTransportIdentity:async()=>tunnel(),now:()=>NOW,...overrides
});

test('tunnel mTLS authenticates only exact pinned local client and fresh native process',async()=>{
  const attest=createV2PrivateTunnelMtlsAttestor(config());
  assert.deepEqual(await attest({socket:socket()}),{
    authenticated:true,peerType:'openai-tunnel-client-mtls',
    sessionSource:'openai/session'
  });
  assert.equal(Object.keys(await attest({socket:socket()})).includes('ownerSidHash'),false);
});

test('untrusted local TLS, changed leaf and missing or stale tunnel status deny without grants',async t=>{
  for(const [name,options] of [
    ['no socket',{socket:null}],['not encrypted',{socket:{...socket(),encrypted:false}}],
    ['not authorized',{socket:{...socket(),authorized:false}}],
    ['changed leaf',{socket:socket({raw:Buffer.from('changed')})}],
    ['CA masquerading as leaf',{socket:socket({ca:true})}],
    ['non-client EKU',{socket:socket({ext_key_usage:[]})}],
    ['expired leaf',{socket:socket({valid_to:'Nov  2 00:00:00 2026 GMT'})}],
    ['not yet valid',{socket:socket({valid_from:'Dec  1 00:00:00 2026 GMT'})}]
  ])await t.test(name,async()=>{
    let native=0;
    const attestor=createV2PrivateTunnelMtlsAttestor(config({
      resolveTransportIdentity:async()=>{native++;return tunnel();}
    }));
    assert.deepEqual(await attestor({socket:options.socket}),{authenticated:false});
    assert.equal(native,0,'rejected client never triggers native tunnel lookup');
  });
  for(const [name,patch] of [
    ['wrong profile',{profileId:'other'}],['not authenticated',{authenticated:false}],
    ['not polling',{controlPlanePollOk:false}],['not ready',{readyzStatus:503}],
    ['expired',{expiresAtMs:NOW}],['missing identity',{ownerSidHash:null}],
    ['future last poll',{lastPollAtMs:NOW+10000}],
    ['stale last poll',{lastPollAtMs:NOW-300000}],['wrong provider',{provider:'fake'}]
  ])await t.test(name,async()=>{
    const attestor=createV2PrivateTunnelMtlsAttestor(config({
      resolveTransportIdentity:async()=>({...tunnel(),...patch})
    }));
    assert.deepEqual(await attestor({socket:socket()}),{authenticated:false});
  });
});

test('missing pinned certificate or native identity provider fails startup closed',()=>{
  for(const patch of [
    {expectedClientLeafDerSha256:undefined},
    {expectedClientLeafDerSha256:'x'.repeat(64)},
    {profileId:''},{resolveTransportIdentity:undefined},
    {now:null}
  ])assert.throws(()=>createV2PrivateTunnelMtlsAttestor(config(patch)),
    {code:'V2_TUNNEL_MTLS_TRUSTED_BOOTSTRAP_REQUIRED'});
});


test('private pair mTLS pins exact enrolled tunnel, native owner and current OS seat',async()=>{
  let sidChecks=0;
  const a=createV2OwnerPinnedPrivatePairAttestor({
    ...config(),expectedTunnelIdHash:'b'.repeat(64),
    expectedOwnerSidHash:'c'.repeat(64),
    resolveCurrentOwnerSidHash:async()=>{sidChecks++;return 'c'.repeat(64);}
  });
  assert.deepEqual(await a({socket:socket()}),{
    authenticated:true,peerType:'owner-pinned-private-tunnel-mtls',
    sessionSource:'native-owner-private-pair'
  });
  assert.equal(sidChecks,2);
});

test('private pair identity cannot be borrowed from another tunnel or owner',async t=>{
  for(const [name,overrides] of [
    ['different tunnel',{expectedTunnelIdHash:'d'.repeat(64)}],
    ['different enrolled owner',{expectedOwnerSidHash:'e'.repeat(64)}],
    ['changed live tunnel',{resolveTransportIdentity:async()=>({...tunnel(),tunnelIdHash:'d'.repeat(64)})}],
    ['changed live owner',{resolveTransportIdentity:async()=>({...tunnel(),ownerSidHash:'e'.repeat(64)})}],
    ['expired tunnel',{resolveTransportIdentity:async()=>({...tunnel(),expiresAtMs:NOW})}],
    ['wrong profile',{profileId:'another'}],
    ['wrong mTLS client',{expectedClientLeafDerSha256:'a'.repeat(64)}]
  ])await t.test(name,async()=>{
    const a=createV2OwnerPinnedPrivatePairAttestor({
      ...config(),expectedTunnelIdHash:'b'.repeat(64),
      expectedOwnerSidHash:'c'.repeat(64),
      resolveCurrentOwnerSidHash:async()=> 'c'.repeat(64),...overrides
    });
    assert.deepEqual(await a({socket:socket()}),{authenticated:false});
  });
});

test('private pair owner switching mid-admission and malicious native getters fail closed',async()=>{
  let checks=0;
  const sw=createV2OwnerPinnedPrivatePairAttestor({
    ...config(),expectedTunnelIdHash:'b'.repeat(64),
    expectedOwnerSidHash:'c'.repeat(64),
    resolveCurrentOwnerSidHash:async()=> (++checks===1?'c':'e').repeat(64)
  });
  assert.deepEqual(await sw({socket:socket()}),{authenticated:false});
  for(const observed of [
    Object.defineProperty(tunnel(),'tunnelIdHash',{get(){throw Error('untrusted getter');}}),
    new Proxy(tunnel(),{get(){throw Error('untrusted proxy');}})
  ]){
    const a=createV2OwnerPinnedPrivatePairAttestor({
      ...config(),expectedTunnelIdHash:'b'.repeat(64),
      expectedOwnerSidHash:'c'.repeat(64),
      resolveCurrentOwnerSidHash:async()=> 'c'.repeat(64),
      resolveTransportIdentity:async()=>observed
    });
    assert.deepEqual(await a({socket:socket()}),{authenticated:false});
  }
});

test('private pair bootstrap requires independently pinned hashes and native owner callback',()=>{
  for(const patch of [
    {expectedTunnelIdHash:undefined},{expectedTunnelIdHash:'x'.repeat(64)},
    {expectedOwnerSidHash:undefined},{expectedOwnerSidHash:'x'.repeat(64)},
    {resolveCurrentOwnerSidHash:undefined},
    {resolveTransportIdentity:undefined}
  ])assert.throws(()=>createV2OwnerPinnedPrivatePairAttestor({
    ...config(),expectedTunnelIdHash:'b'.repeat(64),
    expectedOwnerSidHash:'c'.repeat(64),
    resolveCurrentOwnerSidHash:async()=> 'c'.repeat(64),...patch
  }),{code:/^(V2_PRIVATE_PAIR_TRUSTED_BOOTSTRAP_REQUIRED|V2_TUNNEL_MTLS_TRUSTED_BOOTSTRAP_REQUIRED)$/});
});

test('direct ChatGPT mTLS SAN accepts only exact DNS entry, never a substring',async()=>{
  const issuerRaw=Buffer.from('isolated-test-issuer-der');
  const issuerDigest=createHash('sha256').update(issuerRaw).digest('hex');
  const attest=createV2DirectMtlsTransportAttestor({
    intermediateDerSha256:issuerDigest,sessionSource:'openai/session',now:()=>NOW
  });
  const request=san=>({socket:{
    encrypted:true,authorized:true,getPeerCertificate:()=>({
      raw:Buffer.from('isolated-test-leaf-der'),
      issuerCertificate:{raw:issuerRaw},
      subjectaltname:san,ext_key_usage:['1.3.6.1.5.5.7.3.2'],
      valid_from:'Nov  1 00:00:00 2026 GMT',
      valid_to:'Dec  1 00:00:00 2026 GMT'
    })
  }});
  const exact='mtls.prod.connectors.openai.com';
  assert.equal((await attest(request('DNS:'+exact))).authenticated,true);
  assert.equal((await attest(request('DNS:other.invalid, DNS:'+exact))).authenticated,true);
  for(const malformed of [
    'DNS:x.'+exact,'DNS:'+exact+'.attacker.invalid',
    'DNS:*.'+exact,'URI:https://'+exact,
    'DNS:evil.invalid, URI:https://'+exact,
    'DNS:other.invalid'
  ]){
    assert.deepEqual(await attest(request(malformed)),{authenticated:false},malformed);
  }
});
