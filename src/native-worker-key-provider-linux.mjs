// V1-07 Linux Ed25519 key adapter for a trusted systemd LoadCredentialEncrypted host bootstrap.
// systemd decrypts/authenticates the credential before exposing its read-only file.
// This adapter only converts a provisioned 32-byte Ed25519 seed into a KeyObject;
// it never generates, persists, exports, logs, or enrolls a production key.
import { createHash, createPrivateKey, createPublicKey, KeyObject } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const PROFILE=/^[A-Za-z0-9_-]{1,64}$/;
const HASH=/^[a-f0-9]{64}$/;
const PKCS8_ED25519_SEED_PREFIX=Buffer.from('302e020100300506032b657004220420','hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};

const CREDENTIAL_NAME=/^[A-Za-z0-9_.-]{1,80}$/;

export function createSystemdCredentialDirectoryLoader({
  credentialsDirectory=process.env.CREDENTIALS_DIRECTORY,
  credentialName='worker-ed25519-seed'
}={}){
  if(process.platform!=='linux'||typeof process.geteuid!=='function'
    ||typeof credentialsDirectory!=='string'||!isAbsolute(credentialsDirectory)
    ||!CREDENTIAL_NAME.test(credentialName)||credentialName==='.'||credentialName==='..')
    fail('NATIVE_WORKER_CREDENTIAL_DIRECTORY_CONFIGURATION_REQUIRED');
  const directory=credentialsDirectory;
  const uid=process.geteuid();
  const flags=fsConstants.O_RDONLY|fsConstants.O_DIRECTORY|fsConstants.O_NOFOLLOW;
  const fileFlags=fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW;
  return async function loadSystemdCredential(profileId){
    if(typeof profileId!=='string'||!PROFILE.test(profileId))
      fail('NATIVE_WORKER_KEY_CREDENTIAL_INVALID');
    let dirHandle,fileHandle,data;
    try{
      // Pin the read-only systemd credential directory by descriptor, then
      // resolve the credential beneath that descriptor to avoid directory swaps.
      dirHandle=await open(directory,flags);
      const directoryStat=await dirHandle.stat();
      if(!directoryStat.isDirectory()||directoryStat.uid!==uid
        ||(directoryStat.mode&0o077)!==0||(directoryStat.mode&0o222)!==0
        ||(directoryStat.mode&0o500)!==0o500)
        fail('NATIVE_WORKER_KEY_CREDENTIAL_DIRECTORY_UNTRUSTED');
      fileHandle=await open(`/proc/self/fd/${dirHandle.fd}/${credentialName}`,fileFlags);
      const before=await fileHandle.stat();
      if(!before.isFile()||before.uid!==uid||before.nlink!==1||before.size!==32
        ||(before.mode&0o077)!==0||(before.mode&0o222)!==0
        ||(before.mode&0o400)===0)
        fail('NATIVE_WORKER_KEY_CREDENTIAL_INVALID');
      data=await fileHandle.readFile();
      const after=await fileHandle.stat();
      if(data.length!==32||before.dev!==after.dev||before.ino!==after.ino
        ||before.size!==after.size||after.size!==32)
        fail('NATIVE_WORKER_KEY_CREDENTIAL_CHANGED');
      const result=Buffer.from(data);
      data.fill(0);
      data=null;
      return result;
    }catch(error){
      data?.fill(0);
      if(error?.code?.startsWith?.('NATIVE_WORKER_KEY_'))throw error;
      fail('NATIVE_WORKER_KEY_CREDENTIAL_UNAVAILABLE');
    }finally{
      await fileHandle?.close().catch(()=>{});
      await dirHandle?.close().catch(()=>{});
    }
  };
}

export function createSystemdWorkerKeyProvider({
  profileId,expectedKeyId,loadCredential,credentialsDirectory
}={}){
  if(typeof profileId!=='string'||!PROFILE.test(profileId)
    ||typeof expectedKeyId!=='string'||!HASH.test(expectedKeyId)
    ||(typeof loadCredential!=='function'
      &&typeof (credentialsDirectory??process.env.CREDENTIALS_DIRECTORY)!=='string'))
    fail('NATIVE_WORKER_KEY_PROVIDER_CONFIGURATION_REQUIRED');
  const readCredential=typeof loadCredential==='function'
    ?loadCredential
    :createSystemdCredentialDirectoryLoader({credentialsDirectory});

  async function loadPrivateKey(){
    let supplied;
    try{supplied=await readCredential(profileId);}
    catch(error){
      if(error?.code?.startsWith?.('NATIVE_WORKER_KEY_'))throw error;
      fail('NATIVE_WORKER_KEY_CREDENTIAL_UNAVAILABLE');
    }
    if(!Buffer.isBuffer(supplied)){
      fail('NATIVE_WORKER_KEY_CREDENTIAL_INVALID');
    }
    let seed,der;
    try{
      if(supplied.length!==32)fail('NATIVE_WORKER_KEY_CREDENTIAL_INVALID');
      // The loader transfers ownership of the plaintext credential buffer.
      // Zero both the supplied buffer and this local copy on every exit path.
      seed=Buffer.from(supplied);
      der=Buffer.concat([PKCS8_ED25519_SEED_PREFIX,seed]);
      const privateKey=createPrivateKey({key:der,format:'der',type:'pkcs8'});
      if(!(privateKey instanceof KeyObject)||privateKey.type!=='private'
        ||privateKey.asymmetricKeyType!=='ed25519')
        fail('NATIVE_WORKER_KEY_ED25519_REQUIRED');
      const publicKey=createPublicKey(privateKey);
      const publicDer=publicKey.export({type:'spki',format:'der'});
      const keyId=createHash('sha256').update(publicDer).digest('hex');
      if(keyId!==expectedKeyId)fail('NATIVE_WORKER_KEY_ID_MISMATCH');
      return privateKey;
    }catch(error){
      if(error?.code?.startsWith?.('NATIVE_WORKER_KEY_'))throw error;
      fail('NATIVE_WORKER_KEY_MATERIAL_INVALID');
    }finally{
      supplied.fill(0);
      seed?.fill(0);
      der?.fill(0);
    }
  }

  return Object.freeze({
    source:'systemd-load-credential-encrypted',
    profileId,
    keyId:expectedKeyId,
    loadPrivateKey
  });
}
