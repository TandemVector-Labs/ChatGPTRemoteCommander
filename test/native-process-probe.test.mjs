import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,symlinkSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAllowlistedNativeProcessProbe} from '../src/native-process-probe.mjs';
import {createNativeTailscaleDeviceAttestor} from '../src/native-tailscale-device-attestor.mjs';

const PLATFORM = process.platform === 'win32' ? 'win32' : 'linux';
const INVALID_EXECUTABLE = PLATFORM === 'win32' ? join(tmpdir(),'invalid-native-test.exe') : '/usr/bin/false';

const OWNER='a'.repeat(64);
const OTHER='b'.repeat(64);
const STATUS=JSON.stringify({
  BackendState:'Running',HaveNodeKey:true,Health:[],
  Self:{ID:'12345678901234567890',PublicKey:'nodekey:valid-public-key',Online:true}
});
function fixture(options={}){
  const directory=mkdtempSync(join(tmpdir(),'rc-v107-native-process-'));
  const file=join(directory,'tailscale-native-test');
  writeFileSync(file,'synthetic native executable fixture',{mode:0o700});
  const executablePath=realpathSync(file);
  const executableSha256=createHash('sha256').update('synthetic native executable fixture').digest('hex');
  let owner=OWNER,clockValue=1000,execCalls=0,verifyCalls=0,observed;
  const program={
    programId:'tailscale-status',executablePath,executableSha256,
    args:['status','--json'],timeoutMs:4000,maxBufferBytes:2048
  };
  const p=createAllowlistedNativeProcessProbe({
    platform:PLATFORM,allowedProgram:options.allowedProgram??program,
    resolveOwnerSidHash:async()=>{owner=options.ownerSequence?.length?options.ownerSequence.shift():owner;return owner;},
    verifyExecutable:async input=>{verifyCalls++;observed=input;return options.verifyResult??true;},
    now:()=>options.clock?options.clock():clockValue++,
    execFileImpl:(file,args,opts,callback)=>{
      execCalls++;
      options.onExecute?.({file,args,opts});
      queueMicrotask(()=>callback(options.error??null,options.stdout??STATUS,'private stderr suppressed'));
      return {pid:4321};
    }
  });
  return {
    p,directory,file,program,executablePath,executableSha256,
    get owner(){return owner;},get execCalls(){return execCalls;},
    get verifyCalls(){return verifyCalls;},get observed(){return observed;},
    cleanup(){rmSync(directory,{recursive:true,force:true});}
  };
}
test('allowlisted native process probe executes only the pinned Tailscale status vector without a shell',async()=>{
  const f=fixture();
  try{
    const receipt=await f.p.run();
    assert.equal(receipt.source,'native-tailscale-cli-probe');
    assert.equal(receipt.pid,4321);
    assert.equal(receipt.ownerSidHash,OWNER);
    assert.equal(receipt.executablePath,f.executablePath);
    assert.equal(receipt.executableSha256,f.executableSha256);
    assert.equal(receipt.startedAtMs,1000);
    assert.equal(receipt.finishedAtMs,1001);
    assert.equal(receipt.exitCode,0);
    assert.equal(receipt.stdout,STATUS);
    assert.equal(f.execCalls,1);
    assert.equal(f.verifyCalls,2);
  }finally{f.cleanup();}
});

test('native process probe supplies a minimal environment and explicit shell=false',async()=>{
  process.env.RC_V107_TEST_SECRET='must-not-inherit';
  const f=fixture({onExecute:({file,args,opts})=>{
    assert.equal(file,f.executablePath);
    assert.deepEqual(args,['status','--json']);
    assert.equal(opts.shell,false);
    assert.equal(opts.windowsHide,true);
    assert.equal(opts.timeout,4000);
    assert.equal(opts.maxBuffer,2048);
    assert.equal(opts.env.RC_V107_TEST_SECRET,undefined);
    if(PLATFORM==='linux') assert.equal(opts.env.HOME,process.env.HOME);
    else {
      assert.equal(opts.env.USERPROFILE,process.env.USERPROFILE);
      assert.equal(opts.env.HOME,undefined);
    }
  }});
  try{await f.p.run();}finally{delete process.env.RC_V107_TEST_SECRET;f.cleanup();}
});

test('native process probe rejects a different program ID or argument vector before execution',async()=>{
  for(const allowedProgram of [
    {programId:'arbitrary-command',executablePath:INVALID_EXECUTABLE,executableSha256:'a'.repeat(64),args:['-c','whoami'],timeoutMs:1000,maxBufferBytes:1024},
    {programId:'tailscale-status',executablePath:INVALID_EXECUTABLE,executableSha256:'a'.repeat(64),args:['status','--json','--verbose'],timeoutMs:1000,maxBufferBytes:1024}
  ]){
    assert.throws(()=>createAllowlistedNativeProcessProbe({
      platform:PLATFORM,allowedProgram,resolveOwnerSidHash:async()=>OWNER,
      verifyExecutable:async()=>true
    }),e=>e.code==='NATIVE_PROCESS_ALLOWLIST_ENTRY_INVALID');
  }
});

test('native process probe rejects an executable fingerprint mismatch before launch',async()=>{
  const f=fixture();
  const p=createAllowlistedNativeProcessProbe({
    platform:PLATFORM,allowedProgram:{...f.program,executableSha256:'c'.repeat(64)},
    resolveOwnerSidHash:async()=>OWNER,verifyExecutable:async()=>true,
    execFileImpl:()=>{f.execCalls++;throw new Error('must not execute');}
  });
  try{await assert.rejects(p.run(),e=>e.code==='NATIVE_PROCESS_EXECUTABLE_HASH_MISMATCH');assert.equal(f.execCalls,0);}
  finally{f.cleanup();}
});

test('native process probe rejects untrusted executable policy before launch',async()=>{
  const f=fixture({verifyResult:false});
  try{await assert.rejects(f.p.run(),e=>e.code==='NATIVE_PROCESS_EXECUTABLE_UNTRUSTED');assert.equal(f.execCalls,0);}
  finally{f.cleanup();}
});

test('native process probe rejects owner changes while the process is running',async()=>{
  const f=fixture({ownerSequence:[OWNER,OTHER]});
  try{await assert.rejects(f.p.run(),e=>e.code==='NATIVE_PROCESS_OWNER_CHANGED');}
  finally{f.cleanup();}
});

test('native process probe rejects executable mutation during the process call',async()=>{
  const f=fixture({onExecute:({file})=>writeFileSync(file,'changed binary content',{mode:0o700})});
  try{await assert.rejects(f.p.run(),e=>e.code==='NATIVE_PROCESS_EXECUTABLE_CHANGED');}
  finally{f.cleanup();}
});

test('native process probe rejects symlinked executables and invalid path normalization',async()=>{
  const f=fixture();
  const link=join(f.directory,'tailscale-link');
  symlinkSync(f.directory,link,PLATFORM==='win32'?'junction':'dir');
  const linked={...f.program,executablePath:join(link,'tailscale-native-test')};
  const p=createAllowlistedNativeProcessProbe({
    platform:PLATFORM,allowedProgram:linked,resolveOwnerSidHash:async()=>OWNER,
    verifyExecutable:async()=>true,execFileImpl:()=>{throw new Error('must not execute');}
  });
  try{
    await assert.rejects(p.run(),e=>e.code==='NATIVE_PROCESS_EXECUTABLE_UNTRUSTED');
    const bad={...f.program,executablePath:f.directory+'/../bad'};
    assert.throws(()=>createAllowlistedNativeProcessProbe({
      platform:PLATFORM,allowedProgram:bad,resolveOwnerSidHash:async()=>OWNER,
      verifyExecutable:async()=>true
    }),e=>e.code==='NATIVE_PROCESS_PATH_INVALID');
  }finally{f.cleanup();}
});

test('native process probe returns a failed exit receipt without exposing stderr',async()=>{
  const f=fixture({error:Object.assign(new Error('secret stderr'),{code:'ENOENT'}),stdout:''});
  try{
    const receipt=await f.p.run();
    assert.equal(receipt.exitCode,-1);
    assert.equal(receipt.stdout,'');
    assert.equal(Object.hasOwn(receipt,'stderr'),false);
  }finally{f.cleanup();}
});

test('native process probe rejects oversized output and invalid owner identity',async()=>{
  const oversized=fixture({stdout:'x'.repeat(2049)});
  try{await assert.rejects(oversized.p.run(),e=>e.code==='NATIVE_PROCESS_OUTPUT_TOO_LARGE');}
  finally{oversized.cleanup();}
  const invalid=fixture({ownerSequence:['not-a-hash']});
  try{await assert.rejects(invalid.p.run(),e=>e.code==='NATIVE_PROCESS_OWNER_UNVERIFIED');assert.equal(invalid.execCalls,0);}
  finally{invalid.cleanup();}
});


test('allowlisted native process receipt is accepted by the Tailscale device attestor',async()=>{
  const f=fixture();
  let now=1002;
  try{
    const attestor=createNativeTailscaleDeviceAttestor({
      hostId:'native-process-test-host',
      expectedExecutablePath:f.executablePath,
      expectedExecutableSha256:f.executableSha256,
      resolveOwnerSidHash:async()=>OWNER,
      readTailscaleStatus:f.p.run,
      now:()=>now++
    });
    const identity=await attestor.resolveDeviceIdentity();
    assert.equal(identity.verified,true);
    assert.equal(identity.provider,'tailscale');
    assert.equal(identity.ownerSidHash,OWNER);
    assert.match(identity.deviceIdHash,/^[a-f0-9]{64}$/);
  }finally{f.cleanup();}
});
