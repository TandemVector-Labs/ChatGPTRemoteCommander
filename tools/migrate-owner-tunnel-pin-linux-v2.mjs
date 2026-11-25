// Native owner-approved v1 -> v2 stable-host-UID trust pin migration.
// One existing profile only. Fail-closed; no Tunnel/client/API key or grant change.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,X509Certificate,randomBytes} from 'node:crypto';
import {createLinuxNativeOwnerSessionProvider}
  from '../src/native-owner-session-provider-linux.mjs';
import {readLinuxOwnerTunnelPin,createPinnedLinuxPrivateTunnelIdentity}
  from '../src/linux-private-tunnel-owner-pin.mjs';
import {createLinuxTunnelClientObserver}
  from '../src/native-tunnel-client-observer-linux.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const digest=b=>createHash('sha256').update(b).digest('hex');

function privateDirectory(dir,uid){
  const stat=fs.lstatSync(dir);
  if(!stat.isDirectory()||stat.isSymbolicLink()
    ||stat.uid!==uid||(stat.mode&0o077)!==0)
    fail('RC012_V2_PIN_OWNER_DIRECTORY_INVALID');
}
function readPrivate(file,uid,max=65536){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1
    ||stat.uid!==uid||(stat.mode&0o077)!==0
    ||stat.size<1||stat.size>max)
    fail('RC012_V2_PIN_OWNER_FILE_INVALID');
  return fs.readFileSync(file);
}
function atomicOwnerWrite(dest,blob,uid){
  const dir=path.dirname(dest);
  privateDirectory(dir,uid);
  const temporary=path.join(dir,'.rc012-v2-'+process.pid+'-'+randomBytes(8).toString('hex'));
  let fd;
  try{
    fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT
      |fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    fs.writeFileSync(fd,blob);fs.fsyncSync(fd);
    fs.closeSync(fd);fd=undefined;
    fs.renameSync(temporary,dest);
    const parent=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
    try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
  }finally{
    if(fd!==undefined)fs.closeSync(fd);
    if(fs.existsSync(temporary))fs.unlinkSync(temporary);
  }
}
function createBackupOnce(file,blob,uid){
  const dir=path.dirname(file);
  privateDirectory(dir,uid);
  try{
    const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT
      |fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    try{fs.writeFileSync(fd,blob);fs.fsyncSync(fd);}
    finally{fs.closeSync(fd);}
  }catch(error){
    if(error.code!=='EEXIST'
      ||digest(readPrivate(file,uid,4096))!==digest(blob))
      fail('RC012_V2_OWNER_PIN_BACKUP_CONFLICT');
  }
}
function sameNativeSeat(a,b){
  return a.osSessionId===b.osSessionId&&a.seatId===b.seatId
    &&a.displayId===b.displayId&&a.leaderPid===b.leaderPid
    &&a.sessionType===b.sessionType;
}
async function main(){
  if(process.platform!=='linux'
    ||!['--preflight','--enroll'].includes(process.argv[2])
    ||process.argv.length!==4
    ||!ID.test(process.argv[3]))
    fail('RC012_V2_OWNER_PIN_MIGRATION_ARGS_INVALID');
  const mode=process.argv[2],profile=process.argv[3],uid=process.getuid();
  const home=os.homedir();
  const dir=path.join(home,'.config','chatgpt-remote-commander',
    'private-pair',profile==='chatgpt-remote-commander'?'default':profile);
  privateDirectory(dir,uid);
  const pinPath=path.join(dir,'owner-tunnel-trust.json');
  const raw=readPrivate(pinPath,uid,4096);
  const old=readLinuxOwnerTunnelPin({directory:dir});
  if(old.profileId!==profile)fail('RC012_V2_PIN_PROFILE_MISMATCH');
  const providerV1=createLinuxNativeOwnerSessionProvider();
  const providerV2=createLinuxNativeOwnerSessionProvider({
    ownerIdentityMode:'host-uid-v2'
  });
  const nativeV1=await providerV1.getOwnerSessionSnapshot();
  const nativeV2=await providerV2.getOwnerSessionSnapshot();
  if(!sameNativeSeat(nativeV1,nativeV2))
    fail('RC012_V2_PIN_NATIVE_SESSION_CHANGED');
  const originalAlreadyV2=old.ownerSidHash===nativeV2.ownerSidHash;
  if(!originalAlreadyV2&&old.ownerSidHash!==nativeV1.ownerSidHash)
    fail('RC012_V2_PIN_OLD_OWNER_NOT_ATTESTED');
  const beforeObserver=createLinuxTunnelClientObserver({
    profileId:old.profileId,expectedExecutablePath:old.expectedExecutablePath,
    expectedExecutableSha256:old.expectedExecutableSha256,
    healthPort:old.healthPort,resolveOwnerSidHash:providerV1.resolveOwnerSidHash
  });
  const firstProcess=await beforeObserver.resolveOwnedTunnelProcess();
  const firstHealth=await beforeObserver.probeTunnelHealth(firstProcess);
  const certSha=digest(new X509Certificate(
    readPrivate(path.join(dir,'client.crt'),uid)).raw);
  if(certSha!==old.expectedClientLeafDerSha256)
    fail('RC012_V2_PIN_CERT_DRIFT');
  if(!originalAlreadyV2){
    const v1=await createPinnedLinuxPrivateTunnelIdentity({
      directory:dir,resolveOwnerSidHash:providerV1.resolveOwnerSidHash
    });
    const live=await v1.resolveTransportIdentity();
    if(!live.authenticated||!live.controlPlanePollOk)
      fail('RC012_V2_PIN_OLD_TRANSPORT_UNVERIFIED');
  }
  if(mode==='--preflight'){
    console.log(JSON.stringify({
      result:'RC012_V2_PIN_NATIVE_MIGRATION_PREFLIGHT_PASS',profile,
      ownerSessionVerified:true,currentTunnelPinned:true,
      hostUidV2Ready:true,alreadyV2:originalAlreadyV2,approvalRequested:false
    }));
    return;
  }
  if(!originalAlreadyV2){
    const message=[
      'Approve upgrade of this exact local Tunnel owner identity to v0.12?',
      'Existing account profile: '+profile,'Host: '+old.hostId,
      'Tunnel PID: '+firstProcess.pid,'Health port: '+old.healthPort,
      'Native owner: '+nativeV2.osSessionId,
      'Previous owner ID: '+nativeV1.ownerSidHash.slice(0,12),
      'Stable owner ID: '+nativeV2.ownerSidHash.slice(0,12),
      '',
      'This keeps the same existing Tunnel executable, profile, client',
      'certificate and API key; changes only a local non-secret owner PIN.',
      'It does NOT grant ChatGPT access, execute tools, or change services.'
    ].join('\n');
    const approved=await providerV2.requestConsent({
      title:'Commander 0.12 - migrate verified owner Tunnel identity',
      message,expectedOwnerSidHash:nativeV2.ownerSidHash,
      expectedOsSessionId:nativeV2.osSessionId
    });
    if(!approved)fail('RC012_V2_PIN_OWNER_CONSENT_REQUIRED');
  }
  const nowV1=await providerV1.getOwnerSessionSnapshot();
  const nowV2=await providerV2.getOwnerSessionSnapshot();
  const afterProcess=await beforeObserver.resolveOwnedTunnelProcess();
  const afterHealth=await beforeObserver.probeTunnelHealth(afterProcess);
  if(!sameNativeSeat(nativeV1,nowV1)||!sameNativeSeat(nativeV2,nowV2)
    ||nowV2.ownerSidHash!==nativeV2.ownerSidHash
    ||digest(readPrivate(pinPath,uid,4096))!==digest(raw)
    ||afterProcess.pid!==firstProcess.pid
    ||afterProcess.startedAtMs!==firstProcess.startedAtMs
    ||afterProcess.executableSha256!==firstProcess.executableSha256
    ||afterHealth.clientInstanceId!==firstHealth.clientInstanceId
    ||digest(new X509Certificate(
      readPrivate(path.join(dir,'client.crt'),uid)).raw)!==certSha)
    fail('RC012_V2_PIN_CHANGED_DURING_APPROVAL');
  if(!originalAlreadyV2){
    const backupDir=path.join(home,'.local','state',
      'chatgpt-remote-commander','owner-recovery',
      'rc012-native-pair-systemd-creds-'+profile);
    privateDirectory(backupDir,uid);
    const backup=path.join(backupDir,'owner-tunnel-trust-v1.json');
    createBackupOnce(backup,raw,uid);
    const next=Buffer.from(JSON.stringify({
      ...old,ownerSidHash:nativeV2.ownerSidHash,enrolledAtMs:Date.now()
    })+'\n');
    try{
      atomicOwnerWrite(pinPath,next,uid);
      const pinned=await createPinnedLinuxPrivateTunnelIdentity({
        directory:dir,resolveOwnerSidHash:providerV2.resolveOwnerSidHash
      });
      const current=await pinned.resolveTransportIdentity();
      if(!current.authenticated||!current.controlPlanePollOk)
        fail('RC012_V2_PIN_NEW_TRANSPORT_INVALID');
    }catch(error){
      // Roll back exact original PIN. Neither Tunnel nor Core was touched.
      try{atomicOwnerWrite(pinPath,readPrivate(backup,uid,4096),uid);}
      catch(restoreError){fail('RC012_V2_PIN_ROLLBACK_FAILED');}
      throw error;
    }
  }else{
    const pinned=await createPinnedLinuxPrivateTunnelIdentity({
      directory:dir,resolveOwnerSidHash:providerV2.resolveOwnerSidHash
    });
    await pinned.resolveTransportIdentity();
  }
  console.log(JSON.stringify({
    result:'RC012_V2_OWNER_PIN_MIGRATED_PASS',
    profile,reused:originalAlreadyV2,ownerConsentRequested:!originalAlreadyV2,
    osSessionRechecked:true,liveTunnelAttested:true,privateBackup:true,
    activeTunnelChanged:false,coreChanged:false,workerGrantIssued:false
  }));
}
main().catch(error=>{
  console.error(error.code??'RC012_V2_OWNER_PIN_MIGRATION_FAILED');
  process.exitCode=2;
});
