// Owner-local v0.12 reusable worker-key provisioning. One EXISTING account/Tunnel
// and one native owner at a time. No API key, second Tunnel, OS elevation,
// executable grant, installed-Core mutation, or automatic migration.
// The persistent 32-byte Ed25519 seed exists ONLY as an encrypted
// systemd-credentials blob, under a private per-pair directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  createHash,createPrivateKey,createPublicKey,randomBytes
} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createLinuxNativeOwnerSessionProvider}
  from '../src/native-owner-session-provider-linux.mjs';
import {createPinnedLinuxPrivateTunnelIdentity}
  from '../src/linux-private-tunnel-owner-pin.mjs';
import {assertTrustedLinuxMappedRootExecutable}
  from '../src/native-linux-host-owner-identity.mjs';

const PROFILE=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA=/^[a-f0-9]{64}$/;
const CRED_NAME='worker-ed25519-seed';
const CRYPTO='/usr/bin/systemd-creds';
const FILES=['worker-ed25519-seed.cred','worker-key-id.json'];
const MANIFEST_V1=[
  'schema','hostId','profileId','ownerSidHash','tunnelIdHash',
  'keyId','cipherSha256'
];
const MANIFEST_V2=[
  'schema','hostId','profileId','ownerSidHash','clientLeafDerSha256',
  'keyId','cipherSha256'
];

const fail=code=>{throw Object.assign(new Error(code),{code});};
const hash=b=>createHash('sha256').update(b).digest('hex');
function privateDir(p,uid){
  const s=fs.lstatSync(p);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid
    ||(s.mode&0o077)!==0||fs.realpathSync.native(p)!==p)
    fail('RC012_WORKER_KEY_DIRECTORY_NOT_PRIVATE');
}
function privateFile(p,uid,max=262144){
  const s=fs.lstatSync(p);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==uid
    ||(s.mode&0o077)!==0||s.size<1||s.size>max)
    fail('RC012_WORKER_KEY_FILE_NOT_PRIVATE');
  return fs.readFileSync(p);
}
export function keyIdForSeed(seed){
  if(!Buffer.isBuffer(seed)||seed.length!==32)
    fail('RC012_WORKER_KEY_SEED_INVALID');
  const der=Buffer.concat([
    Buffer.from('302e020100300506032b657004220420','hex'),seed
  ]);
  try{
    const privateKey=createPrivateKey({key:der,format:'der',type:'pkcs8'});
    return hash(createPublicKey(privateKey).export({type:'spki',format:'der'}));
  }finally{der.fill(0);}
}
function systemdCreds(args,{input=null,stdoutBytes=512}={}){
  assertTrustedLinuxMappedRootExecutable(CRYPTO);
  const result=spawnSync(CRYPTO,args,{
    input,encoding:null,timeout:12000,maxBuffer:Math.max(stdoutBytes,1024),
    stdio:['pipe','pipe','ignore'],windowsHide:true
  });
  if(result.error||result.signal||result.status!==0)
    fail('RC012_WORKER_KEY_SYSTEMD_CREDS_FAILED');
  if((result.stdout?.length??0)>stdoutBytes)
    fail('RC012_WORKER_KEY_CREDENTIAL_OUTPUT_BOUNDS');
  return result.stdout;
}
function decrypt(file){
  const raw=systemdCreds(['decrypt','--user','--refuse-null',
    '--name='+CRED_NAME,file,'-'],{stdoutBytes:64});
  if(!Buffer.isBuffer(raw)||raw.length!==32){
    raw?.fill(0);fail('RC012_WORKER_KEY_DECRYPT_INVALID');
  }
  return raw;
}
function readVerifiedWorkerCapsule({
  directory,profile,identity,ownerUid=process.getuid?.(),
  unseal=decrypt,allowLegacyTunnelChange=false
}={}){
  if(typeof profile!=='string'||!PROFILE.test(profile)
    ||!identity||typeof identity!=='object'
    ||!Number.isSafeInteger(ownerUid)||ownerUid<1
    ||typeof unseal!=='function')
    fail('RC012_WORKER_KEY_CAPSULE_INSPECT_ARGS_INVALID');
  privateDir(directory,ownerUid);
  const existing=fs.readdirSync(directory).sort();
  if(existing.length!==FILES.length
    ||FILES.some(x=>!existing.includes(x)))
    fail('RC012_WORKER_KEY_CAPSULE_UNEXPECTED_FILES');
  const credential=path.join(directory,FILES[0]);
  const metaFile=path.join(directory,FILES[1]);
  const ciphertext=privateFile(credential,ownerUid);
  const metadata=privateFile(metaFile,ownerUid,4096);
  const content=metadata.toString('utf8');
  let m;
  try{m=JSON.parse(content);}catch{fail('RC012_WORKER_KEY_RECEIPT_INVALID');}
  const expectedKeys=m?.schema===1?MANIFEST_V1:MANIFEST_V2;
  if(!m||typeof m!=='object'||Array.isArray(m)
    ||![1,2].includes(m.schema)
    ||Object.keys(m).sort().join(',')!==[...expectedKeys].sort().join(',')
    ||m.hostId!==identity.hostId||m.profileId!==profile
    ||m.ownerSidHash!==identity.expectedOwnerSidHash
    ||(m.schema===1
      ? (!SHA.test(m.tunnelIdHash)
        ||(!allowLegacyTunnelChange
          &&m.tunnelIdHash!==identity.expectedTunnelIdHash))
      : (!SHA.test(m.clientLeafDerSha256)
        ||m.clientLeafDerSha256!==identity.expectedClientLeafDerSha256))
    ||!SHA.test(m.keyId)||m.cipherSha256!==hash(ciphertext)
    ||content!==JSON.stringify(m)+'\n')
    fail('RC012_WORKER_KEY_RECEIPT_INVALID');
  const seed=unseal(credential);
  try{
    if(!Buffer.isBuffer(seed)||seed.length!==32)
      fail('RC012_WORKER_KEY_DECRYPT_INVALID');
    if(keyIdForSeed(seed)!==m.keyId)
      fail('RC012_WORKER_KEY_IDENTITY_MISMATCH');
  }finally{
    if(Buffer.isBuffer(seed))seed.fill(0);
    ciphertext.fill(0);metadata.fill(0);
  }
  return Object.freeze({profileId:profile,keyId:m.keyId,verified:true,
    receiptSchema:m.schema,legacyTunnelIdHash:m.schema===1?m.tunnelIdHash:null,
    receiptSha256:hash(Buffer.from(content,'utf8'))});
}
export function inspectOwnerWorkerKeyCapsule(args={}){
  const p=readVerifiedWorkerCapsule(args);
  return Object.freeze({profileId:p.profileId,keyId:p.keyId,verified:true,
    receiptSchema:p.receiptSchema});
}
// One owner-consented transition; the 32-byte encrypted signing seed is
// never copied, decrypted into logs, regenerated or re-enrolled.
export async function rebindOwnerWorkerKeyCapsule({
  directory,profile,identity,ownerUid=process.getuid?.(),
  unseal=decrypt,authorizeOwner,verifyCurrent
}={}){
  if(typeof authorizeOwner!=='function'||typeof verifyCurrent!=='function'
    ||!identity||!SHA.test(identity.expectedClientLeafDerSha256??''))
    fail('RC012_WORKER_KEY_REBIND_AUTH_REQUIRED');
  const args={directory,profile,identity,ownerUid,unseal};
  const previous=readVerifiedWorkerCapsule({
    ...args,allowLegacyTunnelChange:true
  });
  if(previous.receiptSchema===2){
    inspectOwnerWorkerKeyCapsule(args);
    return Object.freeze({rebound:false,receiptSchema:2});
  }
  if(await authorizeOwner({profile,
    previousTunnelIdHashPrefix:previous.legacyTunnelIdHash.slice(0,12)})!==true)
    fail('RC012_WORKER_KEY_REBIND_OWNER_CONSENT_REQUIRED');
  if(await verifyCurrent()!==true)
    fail('RC012_WORKER_KEY_REBIND_TUNNEL_CHANGED');
  const parent=path.dirname(directory);
  privateDir(parent,ownerUid);
  const lock=path.join(parent,'.worker-key-rebind.lock');
  let fd,temp=null,committed=false,archive=null;
  try{
    fd=fs.openSync(lock,fs.constants.O_WRONLY|fs.constants.O_CREAT
      |fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    fs.writeFileSync(fd,'RC012_OWNER_KEY_REBIND\n');fs.fsyncSync(fd);
    const reread=readVerifiedWorkerCapsule({...args,allowLegacyTunnelChange:true});
    if(reread.receiptSchema!==1
      ||reread.receiptSha256!==previous.receiptSha256
      ||reread.keyId!==previous.keyId)
      fail('RC012_WORKER_KEY_REBIND_RECEIPT_CHANGED');
    const receipt=path.join(directory,FILES[1]);
    const previousBytes=privateFile(receipt,ownerUid,4096);
    if(hash(previousBytes)!==previous.receiptSha256)
      fail('RC012_WORKER_KEY_REBIND_RECEIPT_CHANGED');
    const m=JSON.parse(previousBytes.toString('utf8'));
    const updated={schema:2,hostId:m.hostId,profileId:m.profileId,
      ownerSidHash:m.ownerSidHash,
      clientLeafDerSha256:identity.expectedClientLeafDerSha256,
      keyId:m.keyId,cipherSha256:m.cipherSha256};
    const history=path.join(parent,'worker-identity-receipt-history');
    fs.mkdirSync(history,{recursive:true,mode:0o700});
    privateDir(history,ownerUid);
    archive=path.join(history,'v1-'+previous.receiptSha256+'.json');
    if(fs.existsSync(archive)){
      if(hash(privateFile(archive,ownerUid,4096))!==previous.receiptSha256)
        fail('RC012_WORKER_KEY_REBIND_ARCHIVE_CONFLICT');
    }else{
      const af=fs.openSync(archive,fs.constants.O_WRONLY
        |fs.constants.O_CREAT|fs.constants.O_EXCL
        |fs.constants.O_NOFOLLOW,0o600);
      try{fs.writeFileSync(af,previousBytes);fs.fsyncSync(af);}
      finally{fs.closeSync(af);}
    }
    // The archive directory entry must be durable BEFORE replacing the
    // active owner receipt. A crash must not erase the only v1 rollback copy.
    const historyFd=fs.openSync(history,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
    try{fs.fsyncSync(historyFd);}finally{fs.closeSync(historyFd);}
    previousBytes.fill(0);
    if(await verifyCurrent()!==true)
      fail('RC012_WORKER_KEY_REBIND_TUNNEL_CHANGED');
    if(hash(privateFile(receipt,ownerUid,4096))!==previous.receiptSha256)
      fail('RC012_WORKER_KEY_REBIND_RECEIPT_CHANGED');
    temp=path.join(parent,'.worker-key-rebind-'
      +randomBytes(12).toString('hex')+'.tmp');
    const f=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT
      |fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    try{fs.writeFileSync(f,JSON.stringify(updated)+'\n');fs.fsyncSync(f);}
    finally{fs.closeSync(f);}
    fs.renameSync(temp,receipt);temp=null;committed=true;
    const result=inspectOwnerWorkerKeyCapsule(args);
    if(result.receiptSchema!==2||result.keyId!==previous.keyId)
      fail('RC012_WORKER_KEY_REBIND_READBACK_INVALID');
    const dir=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
    try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
    return Object.freeze({rebound:true,receiptSchema:2});
  }catch(e){
    // Reconstitute the original verified v1 receipt if readback failed.
    if(committed&&archive&&fs.existsSync(archive)){
      const restore=path.join(parent,'.worker-key-restore-'
        +randomBytes(12).toString('hex')+'.tmp');
      const raw=privateFile(archive,ownerUid,4096);
      const out=fs.openSync(restore,fs.constants.O_WRONLY|fs.constants.O_CREAT
        |fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
      try{fs.writeFileSync(out,raw);fs.fsyncSync(out);}
      finally{fs.closeSync(out);raw.fill(0);}
      fs.renameSync(restore,path.join(directory,FILES[1]));
    }
    throw e;
  }finally{
    if(temp&&fs.existsSync(temp))fs.unlinkSync(temp);
    if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock);}
  }
}
function sameSeat(a,b){
  return ['ownerSidHash','osSessionId','seatId','displayId',
    'sessionType','leaderPid'].every(k=>a?.[k]===b?.[k]);
}
function sameTunnel(a,b){
  return a?.authenticated===true&&b?.authenticated===true
    &&a?.controlPlanePollOk===true&&b?.controlPlanePollOk===true
    &&['profileId','tunnelIdHash','ownerSidHash'].every(k=>a[k]===b[k]);
}
async function main(){
  if(process.platform!=='linux'||typeof process.getuid!=='function'
    ||process.getuid()===0||process.argv.length!==4
    ||!['--preflight','--enroll','--rebind'].includes(process.argv[2])
    ||!PROFILE.test(process.argv[3])||process.argv[3].includes('..'))
    fail('RC012_WORKER_KEY_OWNER_ARGS_REQUIRED');
  const mode=process.argv[2],profile=process.argv[3],uid=process.getuid();
  const home=os.homedir(),base=path.join(home,'.local','state',
    'chatgpt-remote-commander');
  const security=path.join(base,'private-pair-security-'+profile);
  privateDir(base,uid);privateDir(security,uid);
  const pinnedDirectory=path.join(home,'.config',
    'chatgpt-remote-commander','private-pair',
    profile==='chatgpt-remote-commander'?'default':profile);
  const native=createLinuxNativeOwnerSessionProvider({
    ownerIdentityMode:'host-uid-v2'
  });
  const seat=await native.getOwnerSessionSnapshot();
  const identity=await createPinnedLinuxPrivateTunnelIdentity({
    directory:pinnedDirectory,resolveOwnerSidHash:native.resolveOwnerSidHash
  });
  const first=await identity.resolveTransportIdentity();
  if(!sameTunnel(first,first)
    ||first.ownerSidHash!==seat.ownerSidHash
    ||identity.profileId!==profile)
    fail('RC012_WORKER_KEY_PINNED_TUNNEL_REQUIRED');
  const directory=path.join(security,'worker-identity');
  const existing=fs.existsSync(directory);
  let legacyReceipt=false;
  if(existing){
    try{
      const proof=inspectOwnerWorkerKeyCapsule({
        directory,profile,identity,ownerUid:uid
      });
      legacyReceipt=proof.receiptSchema===1;
    }catch(e){
      if(e.code!=='RC012_WORKER_KEY_RECEIPT_INVALID')throw e;
      // Only a stale v1 Tunnel *instance* hash may be diagnosed.
      // A corrupt seed/owner/profile/ciphertext still fails closed.
      const legacy=readVerifiedWorkerCapsule({
        directory,profile,identity,ownerUid:uid,
        allowLegacyTunnelChange:true
      });
      if(legacy.receiptSchema!==1)throw e;
      legacyReceipt=true;
    }
  }
  if(mode==='--rebind'){
    if(!existing)fail('RC012_WORKER_KEY_REBIND_EXISTING_REQUIRED');
    const result=await rebindOwnerWorkerKeyCapsule({
      directory,profile,identity,ownerUid:uid,
      authorizeOwner:async({previousTunnelIdHashPrefix})=>
        native.requestConsent({
          title:'Commander 0.12 — preserve Worker key across Tunnel restarts',
          message:[
            'Approve making the EXISTING encrypted signing key durable across',
            'restarts of the SAME pinned owner Tunnel and client certificate?',
            'Profile: '+profile,'Native session: '+seat.osSessionId,
            'Old Tunnel instance prefix: '+previousTunnelIdHashPrefix,
            'Current Tunnel instance prefix: '+
              identity.expectedTunnelIdHash.slice(0,12),
            'Current pinned certificate prefix: '+
              identity.expectedClientLeafDerSha256.slice(0,12),
            '',
            'The old encrypted seed is NOT regenerated or exported.',
            'This does not grant a Worker, tool action, or OS privilege.',
            'Old signed grants remain invalid after Tunnel restarts.'
          ].join('\n'),
          expectedOwnerSidHash:seat.ownerSidHash,
          expectedOsSessionId:seat.osSessionId
        }),
      verifyCurrent:async()=>{
        const seatNow=await native.getOwnerSessionSnapshot();
        const tunnelNow=await identity.resolveTransportIdentity();
        return sameSeat(seat,seatNow)&&sameTunnel(first,tunnelNow);
      }
    });
    console.log(JSON.stringify({
      result:result.rebound?'RC012_NATIVE_WORKER_KEY_RECEIPT_REBOUND':
        'RC012_NATIVE_WORKER_KEY_RECEIPT_ALREADY_STABLE',
      profile,receiptSchema:2,credentialProvisioned:true,
      ownerConsentRequested:result.rebound,
      workerGrantIssued:false,fullAccessActive:false
    }));
    return;
  }
  if(mode==='--preflight'||existing){
    console.log(JSON.stringify({
      result:legacyReceipt?'RC012_NATIVE_WORKER_KEY_REBIND_REQUIRED':
        existing?'RC012_NATIVE_WORKER_KEY_EXISTING_VERIFIED':
        'RC012_NATIVE_WORKER_KEY_PREFLIGHT_PASS',
      profile,ownerSeatVerified:true,oneTunnelPinned:true,
      credentialProvisioned:existing,durableReceiptReady:existing&&!legacyReceipt,
      ownerConsentRequested:false,
      workerGrantIssued:false,fullAccessActive:false
    }));
    // A legacy v1 receipt must not be interpreted as successful, reusable
    // Worker enrollment merely because the encrypted seed still exists.
    if(legacyReceipt)process.exitCode=3;
    return;
  }
  const secret=randomBytes(32);
  const keyId=keyIdForSeed(secret);
  let stage=null,locked=false,lockFd;
  const lockFile=path.join(security,'.worker-identity-provision.lock');
  try{
    const message=[
      'Approve one local encrypted Commander Ed25519 Worker signing key?',
      'Existing host: '+identity.hostId,
      'Existing ChatGPT account Tunnel profile: '+profile,
      'Current native owner session: '+seat.osSessionId,
      'Pinned Tunnel hash (prefix): '+identity.expectedTunnelIdHash.slice(0,12),
      'New signing key ID (prefix): '+keyId.slice(0,12),
      '',
      'The encrypted key is saved only for this OS owner and existing profile.',
      'This does NOT register a Worker, grant tool execution, change the',
      'existing Tunnel, enable Full Access, or elevate OS privileges.',
      'Deny unless this local key provisioning was requested.'
    ].join('\n');
    const approved=await native.requestConsent({
      title:'Commander 0.12 — Provision local Worker signing key',
      message,expectedOwnerSidHash:seat.ownerSidHash,
      expectedOsSessionId:seat.osSessionId
    });
    if(!approved)fail('RC012_WORKER_KEY_NATIVE_OWNER_CONSENT_REQUIRED');
    const secondSeat=await native.getOwnerSessionSnapshot();
    const second=await identity.resolveTransportIdentity();
    if(!sameSeat(seat,secondSeat)||!sameTunnel(first,second)
      ||fs.existsSync(directory))
      fail('RC012_WORKER_KEY_OWNER_OR_PROFILE_CHANGED');
    lockFd=fs.openSync(lockFile,fs.constants.O_CREAT|fs.constants.O_EXCL
      |fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
    locked=true;
    fs.writeFileSync(lockFd,'RC012_OWNER_WORKER_KEY_PROVISION\n');
    fs.fsyncSync(lockFd);fs.closeSync(lockFd);lockFd=undefined;
    const name='.worker-key-stage-'+randomBytes(12).toString('hex');
    stage=path.join(security,name);
    fs.mkdirSync(stage,{mode:0o700});
    privateDir(stage,uid);
    const sealed=path.join(stage,FILES[0]);
    systemdCreds(['encrypt','--user','--with-key=host',
      '--name='+CRED_NAME,'-',sealed],{input:secret,stdoutBytes:256});
    fs.chmodSync(sealed,0o600);
    const ciphertext=privateFile(sealed,uid);
    const digest=hash(ciphertext);
    ciphertext.fill(0);
    const result=decrypt(sealed);
    try{
      if(keyIdForSeed(result)!==keyId)
        fail('RC012_WORKER_KEY_ENCRYPTION_READBACK_MISMATCH');
    }finally{result.fill(0);}
    // A signing seed is owner-and-pinned-certificate persistent. The current
    // Tunnel *instance* is still required and rechecked separately for every
    // J01 binding and signed operation, but cannot define durable key custody.
    const manifest={schema:2,hostId:identity.hostId,profileId:profile,
      ownerSidHash:identity.expectedOwnerSidHash,
      clientLeafDerSha256:identity.expectedClientLeafDerSha256,keyId,
      cipherSha256:digest};
    const manifestFile=path.join(stage,FILES[1]);
    const fd=fs.openSync(manifestFile,fs.constants.O_CREAT|fs.constants.O_EXCL
      |fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
    try{fs.writeFileSync(fd,JSON.stringify(manifest)+'\n');fs.fsyncSync(fd);}
    finally{fs.closeSync(fd);}
    inspectOwnerWorkerKeyCapsule({directory:stage,profile,identity,ownerUid:uid});
    const finalSeat=await native.getOwnerSessionSnapshot();
    const finalTunnel=await identity.resolveTransportIdentity();
    if(!sameSeat(seat,finalSeat)||!sameTunnel(first,finalTunnel)
      ||fs.existsSync(directory))
      fail('RC012_WORKER_KEY_OWNER_OR_PROFILE_CHANGED');
    fs.renameSync(stage,directory);stage=null;
    const parent=fs.openSync(security,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
    try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
    inspectOwnerWorkerKeyCapsule({directory,profile,identity,ownerUid:uid});
    console.log(JSON.stringify({
      result:'RC012_NATIVE_OWNER_ENCRYPTED_WORKER_KEY_STAGED_PASS',
      profile,encryptedCurrentUser:true,ownerConsentRequested:true,
      ownerAndTunnelRechecked:true,workerGrantIssued:false,
      nativeServiceChanged:false,fullAccessActive:false
    }));
  }finally{
    secret.fill(0);
    if(lockFd!==undefined)fs.closeSync(lockFd);
    if(stage&&fs.existsSync(stage))fs.rmSync(stage,{recursive:true,force:false});
    if(locked)fs.unlinkSync(lockFile);
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{
    console.error(error?.code??'RC012_NATIVE_WORKER_KEY_STAGE_FAILED');
    process.exitCode=2;
  });
