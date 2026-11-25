import test from 'node:test';
import assert from 'node:assert/strict';
import {createV2PlatformSessionProofAuthority} from '../src/v2-platform-session-proof.mjs';

const SHA='a'.repeat(64);

test('platform proof is an in-process capability, exact to mTLS session and bearer digest, and one-shot',()=>{
  const authority=createV2PlatformSessionProofAuthority();
  const proof=authority.issue({
    peerType:'openai-chatgpt-mtls',sessionSource:'openai/session',
    sessionHandle:'chat-1',tokenSha256:SHA
  });
  assert.equal(Object.isFrozen(proof),true);
  assert.deepEqual({...authority.inspect(proof)},{
    peerType:'openai-chatgpt-mtls',sessionSource:'openai/session',
    sessionHandle:'chat-1',tokenSha256:SHA
  });
  assert.equal(authority.inspect({...proof}),null);
  assert.equal(authority.inspect(new Proxy(proof,{})),null);
  assert.deepEqual(authority.consume(proof),{
    source:'native-platform-session',sessionHandle:'chat-1',tokenSha256:SHA
  });
  assert.equal(authority.inspect(proof),null);
  assert.throws(()=>authority.consume(proof),{code:'V2_PLATFORM_SESSION_PROOF_REQUIRED'});
});

test('platform proof issuer rejects non-mTLS, untrusted namespaces and malformed or extended records',()=>{
  const authority=createV2PlatformSessionProofAuthority();
  const base={
    peerType:'openai-chatgpt-mtls',sessionSource:'openai/session',
    sessionHandle:'chat-1',tokenSha256:SHA
  };
  for(const value of [
    {...base,peerType:'reverse-proxy'},
    {...base,sessionSource:'x-chat-id'},
    {...base,sessionHandle:'mcp-profile-only'},
    {...base,tokenSha256:'bad'},
    {...base,accessToken:'must-not-be-carried'}
  ])assert.throws(()=>authority.issue(value));
  const getter={...base};
  Object.defineProperty(getter,'tokenSha256',{enumerable:true,get(){throw Error('getter executed');}});
  assert.throws(()=>authority.issue(getter));
  assert.throws(()=>authority.issue(new Proxy(base,{})));
});

test('private tunnel has distinct in-process proof and one-time consumption',()=>{
  const authority=createV2PlatformSessionProofAuthority();
  const proof=authority.issue({
    peerType:'openai-tunnel-client-mtls',sessionSource:'openai/session',
    sessionHandle:'chat-tunnel-1',tokenSha256:SHA
  });
  assert.equal(authority.inspect(proof).peerType,'openai-tunnel-client-mtls');
  assert.deepEqual(authority.consume(proof),{
    source:'native-platform-session',
    sessionHandle:'chat-tunnel-1',tokenSha256:SHA
  });
  assert.equal(authority.inspect(proof),null);
  assert.throws(()=>authority.issue({
    peerType:'openai-tunnel-unknown-proxy',sessionSource:'openai/session',
    sessionHandle:'chat-tunnel-1',tokenSha256:SHA
  }),{code:'V2_PLATFORM_SESSION_PROOF_INVALID'});
});
