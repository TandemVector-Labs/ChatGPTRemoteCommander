import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWindowsOwnerGuiStatusProvider } from '../src/windows-owner-gui-status-provider.mjs';

const descriptor = 'C:\\ProgramData\\ChatGPTRemoteCommander\\owner-gui\\session.json';
const dll = 'C:\\Program Files\\TandemVector-Labs\\RemoteCommander\\OwnerSessionBridge.dll';
const dotnet = 'C:\\Program Files\\dotnet\\dotnet.exe';
const stubDll = Buffer.from('signed-pinned-native-fixture');
const digest = createHash('sha256').update(stubDll).digest('hex');
const payload={schema:1,pipe:'rcgui-1234567890abcdef12345678',
  ownerSid:'S-1-5-21-100-200-300-1001',
  keyFile:'C:\\ProgramData\\ChatGPTRemoteCommander\\owner-gui\\key.bin'};
const attestation={ok:true,protocol:1,backend:'windows-owner-session-namedpipe-readonly',
  authenticated:true,ownerSession:1,ownerDisplayWidth:3440,ownerDisplayHeight:1440,
  operations:['status'],screenshot:false,mouse:false,keyboard:false,focus:false};

function fixture(data=payload,{bytes=200,kind='file',real=null,expectedSha=digest,dllPath=dll,
  dllBytes=stubDll,run=async()=>({stdout:JSON.stringify(attestation)})}={}) {
  let calls=0;
  const provider=createWindowsOwnerGuiStatusProvider({
    platform:'win32',descriptorPath:descriptor,dllPath,expectedDllSha256:expectedSha,
    dotnetExe:dotnet,
    stat:async p=>({size:p===descriptor?bytes:dllBytes.length,
      isFile:()=>kind==='file',isSymbolicLink:()=>kind==='link'}),
    canonical:async p=>real||p,
    read:async p=>p===descriptor?JSON.stringify(data):dllBytes,
    run:async(...args)=>{calls++;return run(...args);}
  });
  return {provider,calls:()=>calls};
}
test('only a hash-pinned trusted Program Files DLL can be called for status',async()=>{
  let observed;
  const f=fixture(payload,{run:async(file,args,opts)=>{
    observed={file,args,opts};return {stdout:JSON.stringify(attestation)};
  }});
  assert.deepEqual(await f.provider(),attestation);
  assert.equal(f.calls(),1);
  assert.equal(observed.file,dotnet);
  assert.deepEqual(observed.args,[dll,'probe','--pipe',payload.pipe,'--key-file',payload.keyFile,'--owner-sid',payload.ownerSid]);
  assert.equal(observed.opts.windowsHide,true);
  assert.ok(observed.opts.timeout<=7000);
  assert.ok(observed.opts.maxBuffer<=4096);
});
test('provider is completely disabled before protected binary hash enrollment',()=>{
  assert.equal(createWindowsOwnerGuiStatusProvider({platform:'linux',descriptorPath:descriptor,dllPath:dll,expectedDllSha256:digest}),null);
  assert.equal(createWindowsOwnerGuiStatusProvider({platform:'win32',descriptorPath:null,dllPath:dll,expectedDllSha256:digest}),null);
  assert.equal(createWindowsOwnerGuiStatusProvider({platform:'win32',descriptorPath:descriptor,dllPath:dll}),null);
  assert.equal(createWindowsOwnerGuiStatusProvider({platform:'win32',descriptorPath:descriptor,dllPath:dll,expectedDllSha256:'forged'}),null);
  assert.equal(createWindowsOwnerGuiStatusProvider({
    platform:'win32',descriptorPath:descriptor,
    dllPath:'C:\\Users\\Aa.Emad\\source\\repos\\OwnerSessionBridge.dll',
    expectedDllSha256:digest
  }),null);
});
test('fake binary, bad descriptors and symlinks fail closed before client execution',async()=>{
  for(const data of [
    {...payload,pipe:'\\\\.\\pipe\\arbitrary'}, {...payload,pipe:'rcgui-valid;calc.exe'},
    {...payload,keyFile:'..\\secrets'}, {...payload,ownerSid:'S-1-5-18'},
    {...payload,screenshot:true}, {...payload,schema:2}, null
  ]) {
    const f=fixture(data);assert.equal(await f.provider(),null);assert.equal(f.calls(),0);
  }
  for(const options of [
    {bytes:9000},{kind:'link'},{real:'C:\\elsewhere\\redirect.json'},
    {expectedSha:'0'.repeat(64)}, {dllBytes:Buffer.from('tampered native executable')}
  ]) {
    const f=fixture(payload,options);assert.equal(await f.provider(),null);assert.equal(f.calls(),0);
  }
});
test('child errors, oversize output and invalid JSON fail closed without private text',async()=>{
  for(const run of [
    async()=>{throw new Error('credential path must not leak');},
    async()=>({stdout:'NOT_JSON'}),
    async()=>({stdout:'x'.repeat(5000)}),
    async()=>({stdout:12})
  ]) {
    const f=fixture(payload,{run});
    assert.equal(await f.provider(),null);
  }
});
