import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash,createPrivateKey,createPublicKey,sign,verify,randomBytes
} from 'node:crypto';
import {
  createWindowsDpapiWorkerKeyProvider,
  createWindowsDpapiSeedLoader,
  createWindowsNativeOwnerSidHashResolver
} from '../src/native-worker-key-provider-windows.mjs';

const OWNER='a'.repeat(64);
const OTHER='b'.repeat(64);
const PROFILE='emad';
const PATH='C:\\Users\\owner\\AppData\\Local\\Commander\\worker-keys\\emad.dpapi';
const POWERSHELL='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const PREFIX=Buffer.from('302e020100300506032b657004220420','hex');

function fixture(seed=randomBytes(32)){
  const privateKey=createPrivateKey({
    key:Buffer.concat([PREFIX,seed]),format:'der',type:'pkcs8'
  });
  const publicDer=createPublicKey(privateKey).export({type:'spki',format:'der'});
  const keyId=createHash('sha256').update(publicDer).digest('hex');
  return {seed,privateKey,keyId};
}
function provider(options={}){
  const f=fixture();
  let owner=OWNER,supplied;
  const p=createWindowsDpapiWorkerKeyProvider({
    platform:'win32',profileId:PROFILE,expectedKeyId:f.keyId,
    credentialPath:PATH,resolveOwnerSidHash:async()=>owner,
    readProtectedSeed:async()=>{supplied=Buffer.from(f.seed);return supplied;},
    ...options
  });
  return {p,f,get supplied(){return supplied;},setOwner:value=>{owner=value;}};
}
async function rejectsCode(promise,code){
  await assert.rejects(promise,error=>error?.code===code);
}

test('Windows DPAPI provider loads the pinned Ed25519 key and signs without exporting it',async()=>{
  const f=provider();
  assert.equal(f.p.source,'windows-dpapi-current-user');
  assert.equal(f.p.profileId,PROFILE);
  assert.equal(f.p.keyId,f.f.keyId);
  const key=await f.p.loadPrivateKey();
  const message=Buffer.from('windows-dpapi-worker-key-test');
  const signature=sign(null,message,key);
  assert.equal(verify(null,message,createPublicKey(key),signature),true);
  assert.deepEqual([...f.supplied],new Array(32).fill(0));
});

test('Windows DPAPI provider rejects an owner change during asynchronous key loading',async()=>{
  const f=fixture();
  let owner=OWNER,supplied;
  const p=createWindowsDpapiWorkerKeyProvider({
    platform:'win32',profileId:PROFILE,expectedKeyId:f.keyId,
    resolveOwnerSidHash:async()=>owner,
    readProtectedSeed:async()=>{supplied=Buffer.from(f.seed);owner=OTHER;return supplied;}
  });
  await rejectsCode(p.loadPrivateKey(),'NATIVE_WORKER_KEY_OWNER_CHANGED');
  assert.deepEqual([...supplied],new Array(32).fill(0));
});

test('Windows DPAPI provider rejects a key fingerprint mismatch and zeroes the supplied seed',async()=>{
  const f=fixture(),wrong=provider({expectedKeyId:'c'.repeat(64)});
  await rejectsCode(wrong.p.loadPrivateKey(),'NATIVE_WORKER_KEY_ID_MISMATCH');
  assert.deepEqual([...wrong.supplied],new Array(32).fill(0));
});

test('Windows DPAPI provider rejects missing, wrong-sized and non-Buffer credentials',async t=>{
  const f=fixture();
  for(const [name,readProtectedSeed] of [
    ['missing',async()=>{throw Object.assign(new Error('missing'),{code:'NATIVE_WORKER_KEY_CREDENTIAL_UNAVAILABLE'});}],
    ['wrong-size',async()=>Buffer.alloc(31)],
    ['non-buffer',async()=>new Uint8Array(32)]
  ]){
    await t.test(name,async()=>{
      const p=createWindowsDpapiWorkerKeyProvider({
        platform:'win32',profileId:PROFILE,expectedKeyId:f.keyId,
        resolveOwnerSidHash:async()=>OWNER,readProtectedSeed
      });
      await rejectsCode(p.loadPrivateKey(),name==='wrong-size'||name==='non-buffer'
        ?'NATIVE_WORKER_KEY_CREDENTIAL_INVALID':'NATIVE_WORKER_KEY_CREDENTIAL_UNAVAILABLE');
    });
  }
});

test('Windows DPAPI provider rejects owner hashes and configuration that are not exact',async()=>{
  const f=fixture();
  await rejectsCode(Promise.resolve().then(()=>createWindowsDpapiWorkerKeyProvider({
    platform:'win32',profileId:PROFILE,expectedKeyId:f.keyId,
    resolveOwnerSidHash:async()=>'not-a-hash',readProtectedSeed:async()=>Buffer.from(f.seed)
  })).then(p=>p.loadPrivateKey()),'NATIVE_WORKER_KEY_OWNER_UNAVAILABLE');
  assert.throws(()=>createWindowsDpapiWorkerKeyProvider({
    platform:'linux',profileId:PROFILE,expectedKeyId:f.keyId,
    resolveOwnerSidHash:async()=>OWNER,readProtectedSeed:async()=>Buffer.from(f.seed)
  }),/NATIVE_WORKER_KEY_PROVIDER_CONFIGURATION_REQUIRED/);
  assert.throws(()=>createWindowsDpapiWorkerKeyProvider({
    platform:'win32',profileId:'../bad',expectedKeyId:f.keyId,
    resolveOwnerSidHash:async()=>OWNER,readProtectedSeed:async()=>Buffer.from(f.seed)
  }),/NATIVE_WORKER_KEY_PROVIDER_CONFIGURATION_REQUIRED/);
});

test('DPAPI loader uses a fixed PowerShell executable, encoded non-shell script and CurrentUser scope',async()=>{
  const f=fixture();
  let observed;
  const loader=createWindowsDpapiSeedLoader({
    platform:'win32',credentialPath:PATH,profileId:PROFILE,powershellPath:POWERSHELL,
    verifyExecutable:()=>{},
    execFileImpl:(file,args,options,callback)=>{
      observed={file,args,options};
      const index=args.indexOf('-EncodedCommand');
      assert.notEqual(index,-1);
      const script=Buffer.from(args[index+1],'base64').toString('utf16le');
      assert.match(script,/ProtectedData\]::Unprotect/);
      assert.match(script,/DataProtectionScope\]::CurrentUser/);
      assert.match(script,/AreAccessRulesProtected/);
      assert.match(script,/ReparsePoint/);
      assert.match(script,/S-1-5-18/);
      assert.match(script,/S-1-5-32-544/);
      assert.doesNotMatch(script,/DataProtectionScope\]::LocalMachine/);
      assert.equal(options.encoding,null);
      assert.equal(options.windowsHide,true);
      assert.equal(options.timeout,8000);
      assert.equal(options.shell,undefined);
      assert.match(options.env.PSModulePath,/WindowsPowerShell/);
      assert.equal(options.env.SystemRoot.toLowerCase(),(process.env.SystemRoot||'C:\\Windows').toLowerCase());
      callback(null,Buffer.from(f.seed),Buffer.alloc(0));
    }
  });
  const loaded=await loader({ownerSidHash:OWNER});
  assert.deepEqual(loaded,f.seed);
  assert.equal(observed.file,POWERSHELL);
  assert.equal(observed.options.shell,undefined);
});

test('DPAPI loader rejects an invalid owner hash and unsafe credential paths before process launch',async()=>{
  let calls=0;
  const options={
    platform:'win32',credentialPath:PATH,profileId:PROFILE,powershellPath:POWERSHELL,
    verifyExecutable:()=>{},execFileImpl:()=>{calls++;}
  };
  const loader=createWindowsDpapiSeedLoader(options);
  await rejectsCode(loader({ownerSidHash:'invalid'}),'NATIVE_WORKER_KEY_OWNER_UNAVAILABLE');
  assert.throws(()=>createWindowsDpapiSeedLoader({...options,credentialPath:'\\\\server\\share\\key.dpapi'}),
    /NATIVE_WORKER_KEY_CREDENTIAL_PATH_INVALID/);
  assert.throws(()=>createWindowsDpapiSeedLoader({...options,credentialPath:'C:\\Users\\..\\key.dpapi'}),
    /NATIVE_WORKER_KEY_CREDENTIAL_PATH_INVALID/);
  assert.equal(calls,0);
});

test('native Windows owner resolver returns only a SHA-256 SID digest',async()=>{
  let observed;
  const resolver=createWindowsNativeOwnerSidHashResolver({
    platform:'win32',powershellPath:POWERSHELL,verifyExecutable:()=>{},
    execFileImpl:(file,args,options,callback)=>{
      observed={file,args,options};
      const script=Buffer.from(args[args.indexOf('-EncodedCommand')+1],'base64').toString('utf16le');
      assert.match(script,/WindowsIdentity/);
      assert.match(script,/SHA256/);
      callback(null,OWNER,'');
    }
  });
  assert.equal(await resolver(),OWNER);
  assert.equal(observed.file,POWERSHELL);
  assert.equal(observed.options.shell,undefined);
});

test('native Windows owner resolver rejects malformed SID output and PowerShell failure',async t=>{
  await t.test('malformed digest',async()=>{
    const resolver=createWindowsNativeOwnerSidHashResolver({
      platform:'win32',powershellPath:POWERSHELL,verifyExecutable:()=>{},
      execFileImpl:(_f,_a,_o,cb)=>cb(null,'not-a-hash','')
    });
    await rejectsCode(resolver(),'NATIVE_WORKER_KEY_OWNER_UNAVAILABLE');
  });
  await t.test('process failure',async()=>{
    const resolver=createWindowsNativeOwnerSidHashResolver({
      platform:'win32',powershellPath:POWERSHELL,verifyExecutable:()=>{},
      execFileImpl:(_f,_a,_o,cb)=>cb(new Error('private process detail'),'','sensitive stderr')
    });
    await rejectsCode(resolver(),'NATIVE_WORKER_KEY_OWNER_UNAVAILABLE');
  });
});

test('ambient SystemRoot and PSModulePath cannot redirect native worker SID PowerShell',async()=>{
  const previousRoot=process.env.SystemRoot;
  const previousModules=process.env.PSModulePath;
  let observed;
  try{
    process.env.SystemRoot='Z:\\untrusted-worker-image';
    process.env.PSModulePath='Z:\\untrusted-worker-modules';
    const resolver=createWindowsNativeOwnerSidHashResolver({
      platform:'win32',verifyExecutable:()=>{},
      execFileImpl:(file,args,options,callback)=>{
        observed={file,options};
        callback(null,OWNER,'');
      }
    });
    assert.equal(await resolver(),OWNER);
    assert.equal(observed.file,POWERSHELL);
    assert.equal(observed.options.env.SystemRoot.toLowerCase(),'c:\\windows');
    assert.doesNotMatch(observed.options.env.PATH,/untrusted-worker-image/i);
    assert.doesNotMatch(observed.options.env.PSModulePath,/untrusted-worker-modules/i);
  }finally{
    if(previousRoot===undefined)delete process.env.SystemRoot;
    else process.env.SystemRoot=previousRoot;
    if(previousModules===undefined)delete process.env.PSModulePath;
    else process.env.PSModulePath=previousModules;
  }
});