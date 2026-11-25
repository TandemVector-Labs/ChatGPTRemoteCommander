import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createV101PrivatePairNativeOwnerStack,deriveV101PrivatePairSessionHandle}
  from '../src/v101-private-pair-native-owner-stack.mjs';
import {createV012OwnerPairBindingRoute}
  from '../src/rc012-owner-enrolled-no-grant-bootstrap-linux.mjs';

const SID='S-1-5-21-111-222-333-1001';
const OWNER=createHash('sha256').update(
  'commander.os-owner.sid.v1\0win32\0sid='+SID).digest('hex');
const TUNNEL='b'.repeat(64);
const WIN_PS='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const WIN_SCRIPT='C:\\Commander\\src\\native-owner-session-windows.ps1';
const route=conversationId=>({
  hostId:'pc1',profileId:'profileA',principalId:'accountA',
  conversationId,operationId:'owner-enroll',
  target:{kind:'workflow-root',id:'project1'}
});
function fixture(approve=true){
  const state={now:Date.now(),approve,ownerSid:SID};
  const calls=[],root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-private-native-stack-'));
  const fakeExec=(file,args,_options,callback)=>{
    calls.push(args);
    assert.equal(file,WIN_PS);
    const mode=args.at(args.indexOf('-Mode')+1);
    if(mode==='Snapshot')return callback(null,JSON.stringify({
      schema:1,ownerSid:state.ownerSid,sessionId:7,active:true,interactive:true
    })+'\n','');
    if(mode==='Consent')return callback(null,JSON.stringify({approved:state.approve})+'\n','');
    callback(new Error('unknown mode'),'','');
  };
  const stack=createV101PrivatePairNativeOwnerStack({
    directory:path.join(root,'grants'),profileId:'profileA',
    expectedTunnelIdHash:TUNNEL,expectedOwnerSidHash:OWNER,
    attestTransport:async()=>({authenticated:true,
      peerType:'owner-pinned-private-tunnel-mtls',
      sessionSource:'native-owner-private-pair'}),
    resolveOwnerRoute:async session=>route(session),
    now:()=>state.now,
    ownerSessionOptions:{
      platform:'win32',powershell:WIN_PS,script:WIN_SCRIPT,
      verifyFile:()=>{},execFileImpl:fakeExec,
      snapshotTimeoutMs:1000,dialogTimeoutMs:5000
    }
  });
  return {calls,root,stack,state,close(){
    stack.close();fs.rmSync(root,{recursive:true,force:true});
  }};
}

test('PRIVATE native Windows composition uses existing owner consent, binding and revocation',{
  skip:process.platform!=='win32'
},async()=>{
  const f=fixture();
  try{
    assert.equal(f.stack.nativeSessionBindings.size,0);
    const grant=await f.stack.requestOwnerBinding({request:{},sessionHandle:'chat1'});
    assert.equal(grant.sessionHandle,'chat1');
    assert.equal(f.stack.nativeSessionBindings.size,1);
    assert.equal(f.calls.some(args=>args.includes('Consent')),true);
    const c=await f.stack.resolveOwnerContext('chat1');
    assert.equal(c.source,'native-owner-attested');
    assert.equal(c.tunnelIdHash,TUNNEL);
    assert.equal(c.ownerSidHash,OWNER);
    assert.equal(await f.stack.readCurrentOwnerSidHash(),OWNER);
    assert.equal(f.stack.grantRegistry.read(route('chat1'),'run_shell'),null);
    await f.stack.nativeSessionBindings.revokeTrusted({
      sessionHandle:'chat1',adminProof:null
    });
    assert.equal(f.stack.nativeSessionBindings.size,0);
    f.stack.close();
    await assert.rejects(f.stack.requestOwnerBinding({request:{},sessionHandle:'chat2'}),
      {code:'V101_PRIVATE_OWNER_STACK_CLOSED'});
  }finally{f.close();}
});

test('native owner denial never creates PRIVATE binding or grant',{
  skip:process.platform!=='win32'
},async()=>{
  const f=fixture(false);
  try{
    await assert.rejects(f.stack.requestOwnerBinding({request:{},sessionHandle:'chat1'}),
      {code:'V2_SESSION_OWNER_CONSENT_REQUIRED'});
    assert.equal(f.stack.nativeSessionBindings.size,0);
    assert.equal(f.stack.grantRegistry.read(route('chat1'),'run_shell'),null);
  }finally{f.close();}
});

test('private native stack rejects invalid platform and missing pinned trust',()=>{
  for(const p of [
    {platform:'something-else'}, {profileId:null},
    {expectedTunnelIdHash:'bad'}, {expectedOwnerSidHash:null},
    {attestTransport:null}, {resolveOwnerRoute:null}
  ])assert.throws(()=>createV101PrivatePairNativeOwnerStack({
    directory:path.resolve(os.tmpdir(),'nonexistent-private-pair-owner'),
    profileId:'profileA',expectedTunnelIdHash:TUNNEL,expectedOwnerSidHash:OWNER,
    attestTransport:async()=>({authenticated:true}),
    resolveOwnerRoute:async()=>route('chat1'),...p
  }),{code:'V101_PRIVATE_OWNER_STACK_BOOTSTRAP_REQUIRED'});
});

test('owner-pinned pair session is deterministic, OS-scoped and supports one consent for all chats',{
  skip:process.platform!=='win32'
},async()=>{
  const f=fixture();
  const peer={authenticated:true,
    peerType:'owner-pinned-private-tunnel-mtls',
    sessionSource:'native-owner-private-pair'};
  try{
    const p1=await f.stack.resolveTrustedConversation(peer);
    const p2=await f.stack.resolveTrustedConversation(peer);
    assert.deepEqual(p1,p2);
    assert.equal(p1.source,'native-owner-pair-attested');
    assert.match(p1.sessionHandle,/^pair-[a-f0-9]{32}$/);
    const approved=await f.stack.requestOwnerBinding({
      request:{},sessionHandle:p1.sessionHandle
    });
    assert.equal(approved.sessionHandle,p1.sessionHandle);
    const native=await f.stack.nativeSessionBindings.resolveNativeRoute(p1.sessionHandle);
    assert.equal(native.conversationId,p1.sessionHandle);
    assert.equal(f.calls.filter(args=>args.includes('Consent')).length,1);
    await assert.rejects(f.stack.resolveTrustedConversation({
      ...peer,authenticated:false
    }),{code:'V101_PRIVATE_OWNER_PAIR_TRANSPORT_REQUIRED'});
    await assert.rejects(f.stack.resolveTrustedConversation({
      ...peer,sessionSource:'openai/session'
    }),{code:'V101_PRIVATE_OWNER_PAIR_TRANSPORT_REQUIRED'});
  }finally{f.close();}
});

test('concurrent chats cannot issue duplicate Native J01 prompts on the same owner pair',{
  skip:process.platform!=='win32'
},async()=>{
  const f=fixture();
  const peer={authenticated:true,peerType:'owner-pinned-private-tunnel-mtls',
    sessionSource:'native-owner-private-pair'};
  try{
    const pair=await f.stack.resolveTrustedConversation(peer);
    const [first,second]=await Promise.all([
      f.stack.requestOwnerBinding({request:{},sessionHandle:pair.sessionHandle}),
      f.stack.requestOwnerBinding({request:{},sessionHandle:pair.sessionHandle})
    ]);
    assert.equal(first.bindingId,second.bindingId);
    assert.equal(f.stack.nativeSessionBindings.size,1);
    assert.equal(f.calls.filter(args=>args.includes('Consent')).length,1);
    const third=await f.stack.requestOwnerBinding({
      request:{},sessionHandle:pair.sessionHandle
    });
    assert.equal(third.alreadyBound,true);
    assert.equal(third.bindingId,first.bindingId);
    assert.equal(f.calls.filter(args=>args.includes('Consent')).length,1);
    assert.equal(f.stack.grantRegistry.read(
      route(pair.sessionHandle),'run_shell'),null,
      'reusing J01 must not issue an automatic tool grant');
    await f.stack.nativeSessionBindings.revokeTrusted({
      sessionHandle:pair.sessionHandle,adminProof:null
    });
    assert.equal(f.calls.filter(args=>args.includes('Consent')).length,2,
      'revocation itself has a distinct native approval');
    const regrant=await f.stack.requestOwnerBinding({
      request:{},sessionHandle:pair.sessionHandle
    });
    assert.notEqual(regrant.bindingId,first.bindingId,
      'revocation must never reuse an earlier owner consent epoch');
    assert.equal(f.calls.filter(args=>args.includes('Consent')).length,3,
      'new owner epoch requires another native approval after revocation');
  }finally{f.close();}
});

test('pair binding validity expires and requires a new owner consent epoch',{
  skip:process.platform!=='win32'
},async()=>{
  const f=fixture();
  const attested={authenticated:true,peerType:'owner-pinned-private-tunnel-mtls',
    sessionSource:'native-owner-private-pair'};
  try{
    const pair=await f.stack.resolveTrustedConversation(attested);
    const first=await f.stack.requestOwnerBinding({
      request:{},sessionHandle:pair.sessionHandle
    });
    assert.equal(f.calls.filter(args=>args.includes('Consent')).length,1);
    f.state.now=first.expiresAtMs-1;
    const reused=await f.stack.requestOwnerBinding({
      request:{},sessionHandle:pair.sessionHandle
    });
    assert.equal(reused.bindingId,first.bindingId);
    assert.equal(reused.alreadyBound,true);
    assert.equal(f.calls.filter(args=>args.includes('Consent')).length,1);
    // No external expiry cleanup: requestOwnerBinding itself must detect
    // and retire an expired pair epoch before opening a NEW native dialog.
    f.state.now=first.expiresAtMs;
    const second=await f.stack.requestOwnerBinding({
      request:{},sessionHandle:pair.sessionHandle
    });
    assert.notEqual(second.bindingId,first.bindingId);
    assert.equal(f.calls.filter(args=>args.includes('Consent')).length,2);
    assert.equal(second.alreadyBound,undefined);
  }finally{f.close();}
});

test('failed pair consent may be retried but never creates a cached positive binding',{
  skip:process.platform!=='win32'
},async()=>{
  const f=fixture(false);
  const attested={authenticated:true,peerType:'owner-pinned-private-tunnel-mtls',
    sessionSource:'native-owner-private-pair'};
  try{
    const pair=await f.stack.resolveTrustedConversation(attested);
    const requests=[{request:{},sessionHandle:pair.sessionHandle},
      {request:{},sessionHandle:pair.sessionHandle}];
    const attempts=await Promise.allSettled(
      requests.map(x=>f.stack.requestOwnerBinding(x))
    );
    assert.equal(attempts.filter(x=>x.status==='rejected').length,2);
    assert.equal(f.calls.filter(args=>args.includes('Consent')).length,1);
    assert.equal(f.stack.nativeSessionBindings.size,0);
    f.state.approve=true;
    const newBinding=await f.stack.requestOwnerBinding(requests[0]);
    assert.match(newBinding.bindingId,/^[a-f0-9]{64}$/);
    assert.equal(f.calls.filter(args=>args.includes('Consent')).length,2);
  }finally{f.close();}
});

test('pair owner switch revokes existing session and cannot reuse consent',{
  skip:process.platform!=='win32'
},async()=>{
  const f=fixture();
  const attested={authenticated:true,peerType:'owner-pinned-private-tunnel-mtls',
    sessionSource:'native-owner-private-pair'};
  try{
    const pair=await f.stack.resolveTrustedConversation(attested);
    const bound=await f.stack.requestOwnerBinding({
      request:{},sessionHandle:pair.sessionHandle
    });
    f.state.ownerSid='S-1-5-21-111-222-333-2002';
    await assert.rejects(f.stack.resolveTrustedConversation(attested),
      {code:'V101_PRIVATE_OWNER_PAIR_OWNER_CHANGED'});
    await assert.rejects(f.stack.requestOwnerBinding({
      request:{},sessionHandle:pair.sessionHandle
    }),{code:'V2_SESSION_TRUST_LOST'});
    assert.equal(f.stack.nativeSessionBindings.size,0);
    assert.equal(f.calls.filter(args=>args.includes('Consent')).length,1);
    f.state.ownerSid=SID;
    const fresh=await f.stack.requestOwnerBinding({
      request:{},sessionHandle:pair.sessionHandle
    });
    assert.notEqual(fresh.bindingId,bound.bindingId);
    assert.equal(f.calls.filter(args=>args.includes('Consent')).length,2);
  }finally{f.close();}
});


test('one real owner-pair session maps to one native J01 route; never binds another account or chat',async()=>{
  const enrolled={
    hostId:'labtop-owner',profileId:'mmz-emad-laptop',
    tunnelIdHash:'b'.repeat(64),ownerSidHash:'c'.repeat(64)
  };
  const r=createV012OwnerPairBindingRoute(enrolled);
  const expected=deriveV101PrivatePairSessionHandle({
    profileId:enrolled.profileId,
    expectedTunnelIdHash:enrolled.tunnelIdHash,
    expectedOwnerSidHash:enrolled.ownerSidHash
  });
  assert.equal(r.sessionHandle,expected);
  assert.match(expected,/^pair-[a-f0-9]{32}$/);
  const route=await r.resolveOwnerRoute(expected);
  assert.deepEqual(route,{
    hostId:'labtop-owner',profileId:'mmz-emad-laptop',
    principalId:'owner-not-enrolled',conversationId:expected,
    operationId:'owner-bind',
    target:{kind:'desktop-seat',id:'current-owner'}
  });
  assert.equal(Object.isFrozen(route),true);
  assert.equal(Object.isFrozen(route.target),true);
  const alternate=createV012OwnerPairBindingRoute({
    ...enrolled,profileId:'saeed-emad-laptop'
  });
  assert.notEqual(alternate.sessionHandle,expected);
  await assert.rejects(r.resolveOwnerRoute(alternate.sessionHandle),
    {code:'RC012_OWNER_PAIR_BINDING_ROUTE_MISMATCH'});
  await assert.rejects(r.resolveOwnerRoute('chat-one'),
    {code:'RC012_OWNER_PAIR_BINDING_ROUTE_MISMATCH'});
  await assert.rejects(r.resolveOwnerRoute(null),
    {code:'RC012_OWNER_PAIR_BINDING_ROUTE_MISMATCH'});
  assert.throws(()=>createV012OwnerPairBindingRoute({
    ...enrolled,tunnelIdHash:'unverified'
  }),{code:'RC012_OWNER_PAIR_BINDING_SCOPE_INVALID'});
});
test('owner-pair J01 binding does not enable signed Worker, native lease or Core effect',()=>{
  const fsText=fs.readFileSync(new URL('../src/rc012-owner-enrolled-no-grant-bootstrap-linux.mjs',
    import.meta.url),'utf8');
  for(const sink of [
    'resolveTrustedToolRoute:denied','resolveCurrentOwnerRoute:denied',
    'resolveCurrentWorkerId:denied','workerAuthority:{authorizeWorker:denied}',
    'workerRegistry:{get:denied}','withLease:denied'
  ])assert.ok(fsText.includes(sink),sink);
  assert.ok(fsText.includes('resolveOwnerRoute:pairBinding.resolveOwnerRoute'));
  for(const file of ['src/native-owner-session-provider-windows.mjs',
    'src/native-owner-session-provider-linux.mjs']){
    const source=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
    assert.ok(source.includes('Individual ChatGPT chats')||
      source.includes('individual ChatGPT chats'));
    assert.ok(source.includes('Pair session:'));
  }
});
