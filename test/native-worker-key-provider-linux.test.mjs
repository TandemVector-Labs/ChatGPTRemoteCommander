import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash,generateKeyPairSync,createPublicKey,sign,verify
} from 'node:crypto';
import {mkdtemp,writeFile,chmod,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSystemdWorkerKeyProvider} from '../src/native-worker-key-provider-linux.mjs';

const linuxTest = process.platform === 'linux' ? test : test.skip;

async function withCredentialDirectory(fn){
  const directory=await mkdtemp(join(tmpdir(),'rc-v107-systemd-credential-'));
  try{return await fn(directory);}
  finally{
    await chmod(directory,0o700).catch(()=>{});
    await rm(directory,{recursive:true,force:true});
  }
}
function keyFixture(){
  const pair=generateKeyPairSync('ed25519');
  const pkcs8=pair.privateKey.export({type:'pkcs8',format:'der'});
  const seed=Buffer.from(pkcs8.subarray(-32));
  const publicDer=createPublicKey(pair.privateKey).export({type:'spki',format:'der'});
  const keyId=createHash('sha256').update(publicDer).digest('hex');
  return {seed,keyId,publicKey:pair.publicKey};
}

test('loads the pinned Ed25519 key from the trusted systemd credential callback',async()=>{
  const f=keyFixture(),originalSeed=Buffer.from(f.seed),supplied=Buffer.from(f.seed);
  let requestedProfile=null;
  const provider=createSystemdWorkerKeyProvider({
    profileId:'emad',expectedKeyId:f.keyId,
    loadCredential:async profile=>{requestedProfile=profile;return supplied;}
  });
  const privateKey=await provider.loadPrivateKey();
  const message=Buffer.from('commander-worker-key-provider-qa');
  const signature=sign(null,message,privateKey);
  assert.equal(verify(null,message,f.publicKey,signature),true);
  assert.equal(privateKey.type,'private');
  assert.equal(privateKey.asymmetricKeyType,'ed25519');
  assert.equal(provider.source,'systemd-load-credential-encrypted');
  assert.equal(provider.keyId,f.keyId);
  assert.equal(requestedProfile,'emad');
  assert.equal(supplied.every(byte=>byte===0),true);
  assert.deepEqual(f.seed,originalSeed);
  originalSeed.fill(0);
});


linuxTest('loads the pinned Ed25519 seed directly from a read-only systemd credential directory',async()=>{
  const f=keyFixture();
  await withCredentialDirectory(async directory=>{
    const credential=join(directory,'worker-ed25519-seed');
    await writeFile(credential,f.seed,{mode:0o400});
    await chmod(credential,0o400);
    await chmod(directory,0o500);
    const provider=createSystemdWorkerKeyProvider({
      profileId:'emad',expectedKeyId:f.keyId,credentialsDirectory:directory
    });
    const privateKey=await provider.loadPrivateKey();
    const message=Buffer.from('systemd-credential-directory-qa');
    assert.equal(verify(null,message,f.publicKey,sign(null,message,privateKey)),true);
  });
});


linuxTest('uses the systemd CREDENTIALS_DIRECTORY environment variable by default',async()=>{
  const f=keyFixture(),previous=process.env.CREDENTIALS_DIRECTORY;
  await withCredentialDirectory(async directory=>{
    const credential=join(directory,'worker-ed25519-seed');
    await writeFile(credential,f.seed,{mode:0o400});
    await chmod(credential,0o400);
    await chmod(directory,0o500);
    process.env.CREDENTIALS_DIRECTORY=directory;
    try{
      const provider=createSystemdWorkerKeyProvider({
        profileId:'emad',expectedKeyId:f.keyId
      });
      const privateKey=await provider.loadPrivateKey();
      const message=Buffer.from('systemd-environment-default-qa');
      assert.equal(verify(null,message,f.publicKey,sign(null,message,privateKey)),true);
    }finally{
      if(previous===undefined)delete process.env.CREDENTIALS_DIRECTORY;
      else process.env.CREDENTIALS_DIRECTORY=previous;
    }
  });
});

linuxTest('rejects writable systemd credential directories and non-private credential files',async()=>{
  const f=keyFixture();
  await withCredentialDirectory(async directory=>{
    const credential=join(directory,'worker-ed25519-seed');
    await writeFile(credential,f.seed,{mode:0o400});
    await chmod(credential,0o400);
    const provider=createSystemdWorkerKeyProvider({
      profileId:'emad',expectedKeyId:f.keyId,credentialsDirectory:directory
    });
    await assert.rejects(provider.loadPrivateKey(),/NATIVE_WORKER_KEY_CREDENTIAL_DIRECTORY_UNTRUSTED/);
  });
  await withCredentialDirectory(async directory=>{
    const credential=join(directory,'worker-ed25519-seed');
    await writeFile(credential,f.seed,{mode:0o440});
    await chmod(credential,0o440);
    await chmod(directory,0o500);
    const provider=createSystemdWorkerKeyProvider({
      profileId:'emad',expectedKeyId:f.keyId,credentialsDirectory:directory
    });
    await assert.rejects(provider.loadPrivateKey(),/NATIVE_WORKER_KEY_CREDENTIAL_INVALID/);
  });
});

linuxTest('rejects a symlinked credential file and a symlinked credential directory',async()=>{
  const f=keyFixture();
  await withCredentialDirectory(async directory=>{
    const target=join(directory,'target');
    const link=join(directory,'worker-ed25519-seed');
    await writeFile(target,f.seed,{mode:0o400});
    await chmod(target,0o400);
    await symlink(target,link);
    await chmod(directory,0o500);
    const provider=createSystemdWorkerKeyProvider({
      profileId:'emad',expectedKeyId:f.keyId,credentialsDirectory:directory
    });
    await assert.rejects(provider.loadPrivateKey(),/NATIVE_WORKER_KEY_CREDENTIAL_UNAVAILABLE/);
  });
  await withCredentialDirectory(async directory=>{
    const credential=join(directory,'worker-ed25519-seed');
    await writeFile(credential,f.seed,{mode:0o400});
    await chmod(credential,0o400);
    await chmod(directory,0o500);
    const parent=join(tmpdir(),`rc-v107-systemd-link-${process.pid}-${Date.now()}`);
    await symlink(directory,parent);
    try{
      const provider=createSystemdWorkerKeyProvider({
        profileId:'emad',expectedKeyId:f.keyId,credentialsDirectory:parent
      });
      await assert.rejects(provider.loadPrivateKey(),/NATIVE_WORKER_KEY_CREDENTIAL_UNAVAILABLE/);
    }finally{await rm(parent,{force:true});}
  });
});

test('rejects a credential that does not match the independently pinned key ID',async()=>{
  const f=keyFixture(),supplied=Buffer.from(f.seed);
  const provider=createSystemdWorkerKeyProvider({
    profileId:'emad',expectedKeyId:'f'.repeat(64),
    loadCredential:async()=>supplied
  });
  await assert.rejects(provider.loadPrivateKey(),/NATIVE_WORKER_KEY_ID_MISMATCH/);
  assert.equal(supplied.every(byte=>byte===0),true);
});

test('rejects missing, wrong-sized and non-Buffer credentials without fallback generation',async t=>{
  await t.test('missing credential',async()=>{
    const provider=createSystemdWorkerKeyProvider({
      profileId:'emad',expectedKeyId:'a'.repeat(64),
      loadCredential:async()=>{throw new Error('not delivered');}
    });
    await assert.rejects(provider.loadPrivateKey(),/NATIVE_WORKER_KEY_CREDENTIAL_UNAVAILABLE/);
  });
  await t.test('wrong-sized credential',async()=>{
    const supplied=Buffer.alloc(31,7);
    const provider=createSystemdWorkerKeyProvider({
      profileId:'emad',expectedKeyId:'a'.repeat(64),
      loadCredential:async()=>supplied
    });
    await assert.rejects(provider.loadPrivateKey(),/NATIVE_WORKER_KEY_CREDENTIAL_INVALID/);
    assert.equal(supplied.every(byte=>byte===0),true);
  });
  await t.test('non-Buffer credential',async()=>{
    const provider=createSystemdWorkerKeyProvider({
      profileId:'emad',expectedKeyId:'a'.repeat(64),
      loadCredential:async()=>new Uint8Array(32)
    });
    await assert.rejects(provider.loadPrivateKey(),/NATIVE_WORKER_KEY_CREDENTIAL_INVALID/);
  });
});

test('requires a trusted profile, pinned key fingerprint and credential loader',()=>{
  assert.throws(()=>createSystemdWorkerKeyProvider({
    expectedKeyId:'a'.repeat(64),loadCredential:async()=>Buffer.alloc(32)
  }),/NATIVE_WORKER_KEY_PROVIDER_CONFIGURATION_REQUIRED/);
  assert.throws(()=>createSystemdWorkerKeyProvider({
    profileId:'../emad',expectedKeyId:'a'.repeat(64),loadCredential:async()=>Buffer.alloc(32)
  }),/NATIVE_WORKER_KEY_PROVIDER_CONFIGURATION_REQUIRED/);
  assert.throws(()=>createSystemdWorkerKeyProvider({
    profileId:'emad',expectedKeyId:'not-a-hash',loadCredential:async()=>Buffer.alloc(32)
  }),/NATIVE_WORKER_KEY_PROVIDER_CONFIGURATION_REQUIRED/);
  assert.throws(()=>createSystemdWorkerKeyProvider({
    profileId:'emad',expectedKeyId:'a'.repeat(64)
  }),/NATIVE_WORKER_KEY_PROVIDER_CONFIGURATION_REQUIRED/);
});

test('an unpinned Ed25519 seed never returns a private key and its buffer is zeroed',async()=>{
  const supplied=Buffer.alloc(32,0xff);
  const provider=createSystemdWorkerKeyProvider({
    profileId:'emad',expectedKeyId:'a'.repeat(64),loadCredential:async()=>supplied
  });
  await assert.rejects(provider.loadPrivateKey(),/NATIVE_WORKER_KEY_ID_MISMATCH|NATIVE_WORKER_KEY_MATERIAL_INVALID/);
  assert.equal(supplied.every(byte=>byte===0),true);
});
