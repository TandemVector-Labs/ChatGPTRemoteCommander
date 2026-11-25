import test from 'node:test';
import assert from 'node:assert/strict';
import {createV2PrivateOwnerSessionProofAuthority} from '../src/v2-private-owner-session-proof.mjs';
import {createV2NativeOwnerSessionBindings} from '../src/v2-native-owner-session-bindings.mjs';

const NOW=1794475200000;
const OWNER='a'.repeat(64),TUNNEL='b'.repeat(64);
const goodTransport=()=>({authenticated:true,
  peerType:'owner-pinned-private-tunnel-mtls',
  sessionSource:'native-owner-private-pair'});
const route=conversationId=>({hostId:'pc1',profileId:'profileA',
  principalId:'accountA',conversationId,operationId:'owner-enroll',
  target:{kind:'workflow-root',id:'project1'}});
function setup(patch={}){
  const state={owner:OWNER,transport:goodTransport(),seat:'windows-wts-7',
    consent:true,revocation:true,ownerPrompt:0,revokes:0,now:NOW};
  const authority=createV2PrivateOwnerSessionProofAuthority({
    profileId:'profileA',expectedTunnelIdHash:TUNNEL,expectedOwnerSidHash:OWNER,
    resolveCurrentOwnerSidHash:async()=>state.owner,
    attestTransport:async()=>state.transport,
    now:()=>state.now,...patch
  });
  const bindings=createV2NativeOwnerSessionBindings({
    attestPlatformSession:authority.consume,
    resolveOwnerRoute:async session=>route(session),
    observedNativeSession:async()=>state.seat,
    resolveOwnerSidHash:async()=>state.owner,
    authorizeBinding:async requested=>{
      state.ownerPrompt++;assert.equal(requested.route.profileId,'profileA');
      assert.equal(requested.ownerSidHash,OWNER);
      return state.consent;
    },
    authorizeRevocation:async()=>{state.revokes++;return state.revocation;},
    now:()=>state.now
  });
  return {state,authority,bindings};
}
test('PRIVATE pair mTLS proof is opaque, one-shot and cannot be forged or copied',async()=>{
  const f=setup();
  const token=await f.authority.issue({request:{},sessionHandle:'chat1'});
  assert.equal(Reflect.ownKeys(token).length,0);
  assert.equal(f.authority.inspect(token).sessionHandle,'chat1');
  assert.match(f.authority.consume(token).tokenSha256,/^[a-f0-9]{64}$/);
  assert.throws(()=>f.authority.consume(token),{code:'V2_PRIVATE_OWNER_PROOF_REQUIRED'});
  assert.throws(()=>f.authority.consume({}),{code:'V2_PRIVATE_OWNER_PROOF_REQUIRED'});
  f.bindings.close();f.authority.close();
});

test('each PRIVATE owner consent attempt mints a distinct attested digest for the same chat',async()=>{
  const f=setup();
  try{
    const first=await f.authority.issue({request:{},sessionHandle:'chat1'});
    const second=await f.authority.issue({request:{},sessionHandle:'chat1'});
    assert.notEqual(f.authority.inspect(first).tokenSha256,
      f.authority.inspect(second).tokenSha256);
    const one=await f.bindings.bindTrusted(first);
    assert.equal(f.state.ownerPrompt,1);
    assert.equal(await f.bindings.revokeTrusted({
      sessionHandle:'chat1',adminProof:'qa-owner'
    }),true);
    const reissued=await f.authority.issue({request:{},sessionHandle:'chat1'});
    const two=await f.bindings.bindTrusted(reissued);
    assert.notEqual(one.tokenSha256,two.tokenSha256);
    assert.notEqual(one.bindingId,two.bindingId);
    assert.equal(await f.bindings.resolveAttestedTokenBinding(one.tokenSha256),null);
    const current=await f.bindings.resolveAttestedTokenBinding(two.tokenSha256);
    assert.equal(current?.bindingId,two.bindingId);
    assert.equal(f.state.ownerPrompt,2);
  }finally{f.bindings.close();f.authority.close();}
});

test('explicit Native J01 owner consent binds and revokes PRIVATE session without public OAuth',async()=>{
  const f=setup();
  try{
    const token=await f.authority.issue({request:{},sessionHandle:'chat1'});
    const admitted=await f.bindings.bindTrusted(token);
    assert.equal(f.state.ownerPrompt,1);
    assert.equal(f.bindings.size,1);
    assert.equal(admitted.sessionHandle,'chat1');
    const context=await f.bindings.resolveNativeOwnerContext('chat1');
    assert.equal(context.source,'native-owner-attested');
    assert.equal(context.hostId,'pc1');
    assert.equal(context.profileId,'profileA');
    assert.equal(context.ownerSidHash,OWNER);
    assert.equal(await f.bindings.revokeTrusted({
      sessionHandle:'chat1',adminProof:'qa-owner'}),true);
    assert.equal(f.state.revokes,1);
    assert.equal(f.bindings.size,0);
    await assert.rejects(f.bindings.resolveNativeOwnerContext('chat1'),
      {code:'V2_SESSION_NOT_BOUND'});
  }finally{f.bindings.close();f.authority.close();}
});

test('deny PRIVATE session without explicit native consent, no grant side effect',async()=>{
  const f=setup();f.state.consent=false;
  try{
    const token=await f.authority.issue({request:{},sessionHandle:'chat1'});
    await assert.rejects(f.bindings.bindTrusted(token),
      {code:'V2_SESSION_OWNER_CONSENT_REQUIRED'});
    assert.equal(f.state.ownerPrompt,1);
    assert.equal(f.bindings.size,0);
  }finally{f.bindings.close();f.authority.close();}
});

test('lost tunnel mTLS, switched OS owner and missing profile trust fail closed',async()=>{
  const f=setup();
  for(const corrupted of [
    {authenticated:false}, {...goodTransport(),peerType:'openai-tunnel-client-mtls'},
    {...goodTransport(),sessionSource:'openai/session'}
  ]){
    f.state.transport=corrupted;
    await assert.rejects(f.authority.issue({request:{},sessionHandle:'chat1'}),
      {code:'V2_PRIVATE_OWNER_PROOF_TRANSPORT_REQUIRED'});
  }
  f.state.transport=goodTransport();f.state.owner='f'.repeat(64);
  await assert.rejects(f.authority.issue({request:{},sessionHandle:'chat1'}),
    {code:'V2_PRIVATE_OWNER_PROOF_OWNER_CHANGED'});
  f.state.owner=OWNER;
  const token=await f.authority.issue({request:{},sessionHandle:'chat1'});
  f.state.owner='f'.repeat(64);
  await assert.rejects(f.bindings.bindTrusted(token));
  assert.equal(f.bindings.size,0);
  f.authority.close();f.bindings.close();
});

test('private authority cannot consume another pair capability or accept bootstrap sessions',async()=>{
  const one=setup(),two=setup();
  try{
    const token=await one.authority.issue({request:{},sessionHandle:'chat1'});
    assert.throws(()=>two.authority.consume(token),
      {code:'V2_PRIVATE_OWNER_PROOF_REQUIRED'});
    await assert.rejects(one.authority.issue({request:{},sessionHandle:'mcp-discovery-only'}),
      {code:'V2_PRIVATE_OWNER_PROOF_SESSION_INVALID'});
    one.authority.close();
    assert.throws(()=>one.authority.consume(token),
      {code:'V2_PRIVATE_OWNER_PROOF_REQUIRED'});
  }finally{one.bindings.close();two.bindings.close();one.authority.close();two.authority.close();}
});

test('owner switch during async mTLS verification cannot mint a native proof',async()=>{
  let checks=0;
  const f=setup({
    resolveCurrentOwnerSidHash:async()=>++checks===1?OWNER:'c'.repeat(64)
  });
  try{
    await assert.rejects(f.authority.issue({request:{},sessionHandle:'chat1'}),
      {code:'V2_PRIVATE_OWNER_PROOF_OWNER_CHANGED'});
    assert.equal(f.bindings.size,0);
  }finally{f.bindings.close();f.authority.close();}
});

test('native proof bootstrap refuses missing independent mTLS and OS owner checks',()=>{
  for(const patch of [
    {attestTransport:undefined},{resolveCurrentOwnerSidHash:undefined},
    {profileId:''},{expectedTunnelIdHash:'invalid'},
    {expectedOwnerSidHash:null},{now:null}
  ])assert.throws(()=>createV2PrivateOwnerSessionProofAuthority({
    profileId:'profileA',expectedTunnelIdHash:TUNNEL,expectedOwnerSidHash:OWNER,
    attestTransport:async()=>goodTransport(),
    resolveCurrentOwnerSidHash:async()=>OWNER,now:()=>NOW,...patch
  }),{code:'V2_PRIVATE_OWNER_PROOF_BOOTSTRAP_REQUIRED'});
});
