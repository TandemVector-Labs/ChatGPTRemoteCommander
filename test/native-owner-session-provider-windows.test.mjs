import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createWindowsNativeOwnerSessionProvider} from '../src/native-owner-session-provider-windows.mjs';
import {
  createWindowsV101OwnerSecurityStack,
  createWindowsV101V2CandidateHost
} from '../src/v101-windows-owner-security-bootstrap.mjs';

const SID='S-1-5-21-111-222-333-1001';
const POWERSHELL='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const SCRIPT='C:\\Commander\\src\\native-owner-session-windows.ps1';
const HASH='a'.repeat(64),BINDING='b'.repeat(64);
const route=()=>({
  hostId:'host-1',profileId:'profile-1',principalId:'owner-1',
  conversationId:'chat-1',operationId:'step-1',
  target:{kind:'workflow-root',id:'root-1'}
});
const snapshot=(values={})=>JSON.stringify({
  schema:1,ownerSid:SID,sessionId:2,active:true,interactive:true,...values
})+'\n';
const opts=(run,extra={})=>({
  platform:'win32',powershell:POWERSHELL,script:SCRIPT,
  verifyFile:file=>assert.ok([POWERSHELL,SCRIPT].includes(file)),
  execFileImpl:run,
  snapshotTimeoutMs:1000,dialogTimeoutMs:5000,
  ...extra
});
const mock=(onConsent=()=>({approved:false}),onSnapshot=()=>snapshot(),calls=[])=>(
  (file,args,options,callback)=>{
    calls.push({file,args,options});
    assert.equal(file,POWERSHELL);
    assert.ok(args.includes('-NoProfile'));
    assert.ok(args.includes('-NonInteractive'));
    assert.ok(!args.includes('-ExecutionPolicy'));
    const mode=args.at(args.indexOf('-Mode')+1);
    if(mode==='Snapshot')return callback(null,onSnapshot(), '');
    assert.equal(mode,'Consent');
    const value=onConsent(args);
    callback(null,JSON.stringify(value)+'\n','');
  }
);
function approveInput(before){
  return {
    title:'Confirm owner',message:'Approve exact binding',
    expectedOwnerSidHash:before.ownerSidHash,
    expectedOsSessionId:before.osSessionId
  };
}

test('Windows snapshot pins active WTS session, OS SID digest, and no GUI prompt',async()=>{
  const calls=[];
  const p=createWindowsNativeOwnerSessionProvider(opts(mock(undefined,undefined,calls)));
  const observed=await p.getOwnerSessionSnapshot();
  assert.equal(observed.source,'native-windows-owner-session');
  assert.equal(observed.osSessionId,'windows-wts-2');
  assert.equal(observed.seatId,'wts-2');
  assert.equal(observed.ownerSidHash,createHash('sha256').update(
    'commander.os-owner.sid.v1\0win32\0sid='+SID).digest('hex'));
  assert.equal(await p.resolveOwnerSidHash(),observed.ownerSidHash);
  assert.equal(await p.observedNativeSession(route()),'windows-wts-2');
  assert.equal(calls.length,3);
  assert.ok(calls.every(x=>x.args.includes('Snapshot')));
});

test('Windows owner snapshot fail-closes on service, inactive, forged, unknown or changed token',async t=>{
  for(const [name,payload] of [
    ['session zero',{sessionId:0}],['inactive',{active:false}],
    ['noninteractive',{interactive:false}],['service SID',{ownerSid:'S-1-5-18'}],
    ['untrusted owner SID',{ownerSid:'test'}],['wrong schema',{schema:2}],
    ['missing SID',{ownerSid:undefined}],['noninteger',{sessionId:'2'}]
  ]){
    await t.test(name,async()=>{
      const p=createWindowsNativeOwnerSessionProvider(opts(mock(
        undefined,()=>snapshot(payload))));
      await assert.rejects(p.getOwnerSessionSnapshot());
    });
  }
  const p=createWindowsNativeOwnerSessionProvider(opts(
    (file,args,options,callback)=>callback(new Error('unavailable'),'','')));
  await assert.rejects(p.getOwnerSessionSnapshot());
  assert.throws(()=>createWindowsNativeOwnerSessionProvider(opts(mock(),{
    platform:'linux'
  })),/BOOTSTRAP_REQUIRED/);
});

test('Windows consent demands fresh typed challenge and rechecks WTS/SID',async()=>{
  const calls=[];
  const p=createWindowsNativeOwnerSessionProvider(opts(mock(args=>{
    const code=args.at(args.indexOf('-Challenge')+1);
    assert.match(code,/^[0-9]{8}$/);
    assert.ok(args.includes('-ExpectedSession'));
    assert.equal(args.at(args.indexOf('-ExpectedSession')+1),'2');
    assert.equal(args.at(args.indexOf('-TitleBase64')+1),
      Buffer.from('Confirm owner').toString('base64'));
    assert.equal(args.at(args.indexOf('-MessageBase64')+1),
      Buffer.from('Approve exact binding').toString('base64'));
    return {approved:true};
  },undefined,calls)));
  const before=await p.getOwnerSessionSnapshot();
  assert.equal(await p.requestConsent(approveInput(before)),true);
  assert.deepEqual(calls.map(x=>x.args.at(x.args.indexOf('-Mode')+1)),
    ['Snapshot','Snapshot','Consent','Snapshot']);
  const n=calls.length;
  assert.equal(await p.requestConsent({...approveInput(before),
    expectedOwnerSidHash:'f'.repeat(64)}),false);
  assert.equal(calls.length,n+1,'invalid owner must never open a consent dialog');
});

test('Windows denies cancelled consent and a WTS/SID change after approval',async()=>{
  const deny=createWindowsNativeOwnerSessionProvider(opts(mock(
    ()=>({approved:false}))));
  const before=await deny.getOwnerSessionSnapshot();
  assert.equal(await deny.requestConsent(approveInput(before)),false);
  let snapshots=0;
  const switcher=createWindowsNativeOwnerSessionProvider(opts(mock(
    ()=>({approved:true}),()=>{
      snapshots++;return snapshot(snapshots>=3?{sessionId:3}:{});
    })));
  const first=await switcher.getOwnerSessionSnapshot();
  assert.equal(await switcher.requestConsent(approveInput(first)),false);
});

test('Windows owner-binding route and revocation reject cross-chat data',async()=>{
  const calls=[];
  const p=createWindowsNativeOwnerSessionProvider(opts(mock(
    ()=>({approved:true}),undefined,calls)));
  const before=await p.getOwnerSessionSnapshot();
  assert.equal(await p.authorizeBinding({
    sessionHandle:'different',tokenSha256:'9'.repeat(64),route:route(),
    osSessionId:before.osSessionId,
    ownerSidHash:before.ownerSidHash,bindingId:BINDING
  }),false);
  assert.equal(await p.authorizeBinding({
    sessionHandle:'chat-1',tokenSha256:'9'.repeat(64),route:route(),
    osSessionId:before.osSessionId,
    ownerSidHash:before.ownerSidHash,bindingId:BINDING
  }),true);
  const consent=calls.find(x=>x.args.includes('Consent'));
  const message=Buffer.from(consent.args.at(
    consent.args.indexOf('-MessageBase64')+1),'base64').toString();
  assert.match(message,/chat-1/);
  assert.doesNotMatch(message,/9{64}/);
  assert.equal(await p.authorizeRevocation({
    sessionHandle:'chat-1',route:route(),
    osSessionId:before.osSessionId,ownerSidHash:before.ownerSidHash,
    bindingId:BINDING,adminProof:null
  }),true);
});

test('Windows J01 native stack exists but never mints a grant or opens a listener',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rc-winj01-'));
  try{
    const stack=createWindowsV101OwnerSecurityStack({
      directory,attestPlatformSession:async()=>null,
      resolveOwnerRoute:async()=>route(),
      ownerSessionOptions:opts(mock())
    });
    assert.equal(stack.nativeSessionBindings.size,0);
    assert.equal(typeof stack.grantRegistry,'object');
    stack.close();stack.close();
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
  assert.throws(()=>createWindowsV101V2CandidateHost({}),
    /V101_WINDOWS_V2_HOST_BOOTSTRAP_REQUIRED/);
});

test('Windows native owner probe validates the real active user token (opt-in)',{
  skip:process.platform!=='win32'||process.env.COMMANDER_NATIVE_OWNER_INTERACTIVE_QA!=='1'
},async()=>{
  const p=createWindowsNativeOwnerSessionProvider();
  const a=await p.getOwnerSessionSnapshot();
  assert.match(a.ownerSidHash,/^[a-f0-9]{64}$/);
  assert.match(a.osSessionId,/^windows-wts-[1-9][0-9]*$/);
  assert.equal(await p.resolveOwnerSidHash(),a.ownerSidHash);
});

test('ambient SystemRoot cannot select the native owner PowerShell image or Windows child roots',async()=>{
  const previous=process.env.SystemRoot;
  let observed;
  try{
    process.env.SystemRoot='Z:\\untrusted-owner-image';
    const p=createWindowsNativeOwnerSessionProvider({
      platform:'win32',script:SCRIPT,verifyFile:()=>{},
      execFileImpl:(file,args,options,callback)=>{
        observed={file,options};
        callback(null,snapshot(),'');
      },snapshotTimeoutMs:1000,dialogTimeoutMs:5000
    });
    const state=await p.getOwnerSessionSnapshot();
    assert.equal(state.osSessionId,'windows-wts-2');
    assert.equal(observed.file,POWERSHELL);
    assert.equal(observed.options.env.SystemRoot.toLowerCase(),'c:\\windows');
    assert.equal(observed.options.env.WINDIR.toLowerCase(),'c:\\windows');
    assert.doesNotMatch(observed.options.env.PATH,/untrusted-owner-image/i);
  }finally{
    if(previous===undefined)delete process.env.SystemRoot;
    else process.env.SystemRoot=previous;
  }
});