// Owner-approved, non-secret trust pins for the ONE existing Linux Tunnel.
// No tunnel ID, API key, private key, service mutation or grant is stored.
// This is an input to the existing native-tunnel-attestor, not authorization
// by itself. The caller must supply real OS owner consent and a live recheck.
import fs from 'node:fs';
import path from 'node:path';
import {isProxy} from 'node:util/types';
import {createLinuxTunnelClientObserver}
  from './native-tunnel-client-observer-linux.mjs';
import {createNativeTunnelAttestor}
  from './native-tunnel-attestor.mjs';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH=/^[a-f0-9]{64}$/;
const FILE='owner-tunnel-trust.json';
const KEYS=Object.freeze(['schema','kind','hostId','profileId','ownerSidHash',
  'expectedExecutablePath','expectedExecutableSha256','healthPort',
  'expectedClientLeafDerSha256','enrolledAtMs']);
const fail=code=>{throw Object.assign(new Error(code),{code});};

function safeDirectory(dir,uid){
  if(process.platform!=='linux'||typeof dir!=='string'||!path.isAbsolute(dir)
    ||dir.includes('\0')||dir.length>4096)fail('RC012_LINUX_OWNER_TRUST_DIRECTORY_REQUIRED');
  const stat=fs.lstatSync(dir);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==uid
    ||(stat.mode&0o077)!==0)
    fail('RC012_LINUX_OWNER_TRUST_DIRECTORY_UNSAFE');
}

export function normalizeLinuxOwnerTunnelPin(value,{nowMs=Date.now()}={}){
  if(!value||typeof value!=='object'||Array.isArray(value)||isProxy(value)
    ||![Object.prototype,null].includes(Object.getPrototypeOf(value)))
    fail('RC012_LINUX_OWNER_TRUST_RECORD_INVALID');
  const keys=Reflect.ownKeys(value);
  if(keys.length!==KEYS.length||keys.some(k=>typeof k!=='string'||!KEYS.includes(k)))
    fail('RC012_LINUX_OWNER_TRUST_RECORD_INVALID');
  const out=Object.create(null);
  for(const k of KEYS){
    const d=Object.getOwnPropertyDescriptor(value,k);
    if(!d||!d.enumerable||!Object.hasOwn(d,'value'))
      fail('RC012_LINUX_OWNER_TRUST_RECORD_INVALID');
    out[k]=d.value;
  }
  if(out.schema!==1||out.kind!=='linux-owner-private-one-tunnel'
    ||![out.hostId,out.profileId].every(v=>typeof v==='string'
      &&ID.test(v)&&v!=='.'&&v!=='..')
    ||![out.ownerSidHash,out.expectedExecutableSha256,
      out.expectedClientLeafDerSha256].every(v=>typeof v==='string'&&HASH.test(v))
    ||typeof out.expectedExecutablePath!=='string'
    ||!path.posix.isAbsolute(out.expectedExecutablePath)
    ||out.expectedExecutablePath.includes('\0')
    ||out.expectedExecutablePath.length>4096
    ||!Number.isSafeInteger(out.healthPort)||out.healthPort<1024
    ||out.healthPort>65535
    ||!Number.isSafeInteger(out.enrolledAtMs)
    ||out.enrolledAtMs<=0||out.enrolledAtMs>nowMs+1000
    ||nowMs-out.enrolledAtMs>10*365*24*60*60*1000)
    fail('RC012_LINUX_OWNER_TRUST_RECORD_INVALID');
  return Object.freeze({...out});
}

export function readLinuxOwnerTunnelPin({
  directory,ownerUid=process.getuid?.(),nowMs=Date.now()
}={}){
  if(!Number.isSafeInteger(ownerUid)||ownerUid<0)
    fail('RC012_LINUX_OWNER_TRUST_OWNER_INVALID');
  safeDirectory(directory,ownerUid);
  const filename=path.join(directory,FILE);
  const before=fs.lstatSync(filename);
  if(!before.isFile()||before.isSymbolicLink()||before.uid!==ownerUid
    ||before.nlink!==1||(before.mode&0o077)!==0
    ||before.size<10||before.size>4096)
    fail('RC012_LINUX_OWNER_TRUST_FILE_UNSAFE');
  let fd,contents;
  try{
    fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const snap=fs.fstatSync(fd);
    if(!snap.isFile()||snap.uid!==ownerUid||snap.nlink!==1
      ||(snap.mode&0o077)!==0||snap.dev!==before.dev||snap.ino!==before.ino
      ||snap.size!==before.size)
      fail('RC012_LINUX_OWNER_TRUST_FILE_CHANGED');
    contents=fs.readFileSync(fd,{encoding:'utf8'});
    const after=fs.fstatSync(fd);
    if(snap.dev!==after.dev||snap.ino!==after.ino||snap.size!==after.size
      ||snap.mtimeMs!==after.mtimeMs)
      fail('RC012_LINUX_OWNER_TRUST_FILE_CHANGED');
  }finally{if(fd!==undefined)fs.closeSync(fd);}
  let parsed;try{parsed=JSON.parse(contents);}
  catch{fail('RC012_LINUX_OWNER_TRUST_JSON_INVALID');}
  return normalizeLinuxOwnerTunnelPin(parsed,{nowMs});
}

export async function enrollLinuxOwnerTunnelPin({
  directory,record,authorizeOwner,verifyCurrent,
  ownerUid=process.getuid?.(),nowMs=Date.now()
}={}){
  if(!Number.isSafeInteger(ownerUid)||ownerUid<0
    ||typeof authorizeOwner!=='function'||typeof verifyCurrent!=='function')
    fail('RC012_LINUX_OWNER_TRUST_ENROLLMENT_REQUIRED');
  const normalized=normalizeLinuxOwnerTunnelPin(record,{nowMs});
  safeDirectory(directory,ownerUid);
  const dest=path.join(directory,FILE);
  if(fs.existsSync(dest)){
    const existing=readLinuxOwnerTunnelPin({directory,ownerUid,nowMs});
    if(JSON.stringify(existing)!==JSON.stringify(normalized))
      fail('RC012_LINUX_OWNER_TRUST_ALREADY_ENROLLED');
    return Object.freeze({record:existing,reused:true,ownerConsentRequested:false});
  }
  // Consent must be a visible, real native owner authorization in production,
  // not a command-line flag. Caller enforces unchanged owner/pid/health epoch.
  if(await authorizeOwner(normalized)!==true)
    fail('RC012_LINUX_OWNER_TRUST_CONSENT_REQUIRED');
  if(await verifyCurrent(normalized)!==true)
    fail('RC012_LINUX_OWNER_TRUST_CHANGED_DURING_CONSENT');
  safeDirectory(directory,ownerUid);
  const blob=JSON.stringify(normalized)+'\n';
  if(Buffer.byteLength(blob)>4096)fail('RC012_LINUX_OWNER_TRUST_FILE_BOUNDS');
  let fd,created=false;
  try{
    fd=fs.openSync(dest,fs.constants.O_WRONLY|fs.constants.O_CREAT
      |fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    created=true;
    fs.writeFileSync(fd,blob,{encoding:'utf8'});
    fs.fsyncSync(fd);
    fs.closeSync(fd);fd=undefined;
    const reread=readLinuxOwnerTunnelPin({directory,ownerUid,nowMs});
    if(JSON.stringify(reread)!==JSON.stringify(normalized))
      fail('RC012_LINUX_OWNER_TRUST_READBACK_MISMATCH');
    return Object.freeze({record:reread,reused:false,ownerConsentRequested:true});
  }catch(error){
    if(created){
      try{if(fd!==undefined)fs.closeSync(fd);}catch{}
      try{fs.unlinkSync(dest);}catch{}
    }
    throw error;
  }
}

/**
 * Actual production-bootstrap identity source for an already owner-enrolled
 * private Linux Tunnel. An approved static file pins binary/profile/owner,
 * while the current OS process, PID epoch, health socket and control-plane
 * poll authenticate the one *current* Tunnel instance at runtime.
 *
 * Does not enroll or authorize a tool. A Tunnel restart invalidates the
 * instance epoch until a trusted Core bootstrap reinitializes J01 bindings.
 */
export async function createPinnedLinuxPrivateTunnelIdentity({
  directory,resolveOwnerSidHash,now=Date.now
}={}){
  if(typeof resolveOwnerSidHash!=='function'||typeof now!=='function')
    fail('RC012_LINUX_OWNER_TRUST_BOOTSTRAP_REQUIRED');
  const pin=readLinuxOwnerTunnelPin({directory,nowMs:now()});
  const ownerBefore=await resolveOwnerSidHash();
  if(ownerBefore!==pin.ownerSidHash)
    fail('RC012_LINUX_OWNER_TRUST_CURRENT_OWNER_MISMATCH');
  const params={
    profileId:pin.profileId,
    expectedExecutablePath:pin.expectedExecutablePath,
    expectedExecutableSha256:pin.expectedExecutableSha256,
    resolveOwnerSidHash,now
  };
  const observer=createLinuxTunnelClientObserver({
    ...params,healthPort:pin.healthPort
  });
  const native=createNativeTunnelAttestor({
    hostId:pin.hostId,...params,
    resolveOwnedTunnelProcess:observer.resolveOwnedTunnelProcess,
    probeTunnelHealth:observer.probeTunnelHealth
  });
  const first=await native.resolveTransportIdentity();
  if(first.ownerSidHash!==pin.ownerSidHash||first.authenticated!==true)
    fail('RC012_LINUX_OWNER_TRUST_NATIVE_TUNNEL_MISMATCH');
  const baseline=JSON.stringify(pin);
  const expectedTunnelIdHash=first.tunnelIdHash;
  return Object.freeze({
    source:'owner-enrolled-linux-private-tunnel',
    hostId:pin.hostId,profileId:pin.profileId,
    expectedOwnerSidHash:pin.ownerSidHash,
    expectedClientLeafDerSha256:pin.expectedClientLeafDerSha256,
    expectedTunnelIdHash,
    async resolveTransportIdentity(){
      const current=readLinuxOwnerTunnelPin({directory,nowMs:now()});
      if(JSON.stringify(current)!==baseline)
        fail('RC012_LINUX_OWNER_TRUST_PIN_CHANGED');
      if(await resolveOwnerSidHash()!==pin.ownerSidHash)
        fail('RC012_LINUX_OWNER_TRUST_CURRENT_OWNER_MISMATCH');
      const observed=await native.resolveTransportIdentity();
      if(observed.tunnelIdHash!==expectedTunnelIdHash
        ||observed.ownerSidHash!==pin.ownerSidHash)
        fail('RC012_LINUX_OWNER_TRUST_TUNNEL_INSTANCE_CHANGED');
      return observed;
    }
  });
}
