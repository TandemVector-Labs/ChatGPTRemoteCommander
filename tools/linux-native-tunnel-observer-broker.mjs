// Read-only owner-native Unix-socket Tunnel witness for hardened v0.12 Core.
// NOT a Core executor, owner J01 binding, Full Access grant, or Tunnel launcher.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,X509Certificate} from 'node:crypto';
import {createLinuxNativeOwnerSessionProvider}
  from '../src/native-owner-session-provider-linux.mjs';
import {createPinnedLinuxPrivateTunnelIdentity,readLinuxOwnerTunnelPin}
  from '../src/linux-private-tunnel-owner-pin.mjs';
import {createLinuxTunnelClientObserver}
  from '../src/native-tunnel-client-observer-linux.mjs';
import {createNativeTunnelAttestor}
  from '../src/native-tunnel-attestor.mjs';
import {createLinuxNativeTunnelClaims,signLinuxNativeTunnelProof}
  from '../src/linux-native-tunnel-broker-proof.mjs';
import {resolveLinuxNativeWitnessEnrollmentMode}
  from '../src/linux-native-witness-enrollment-mode.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const sha=b=>createHash('sha256').update(b).digest('hex');
function privateFile(file,uid,max=8192){
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.uid!==uid||st.nlink!==1
    ||(st.mode&0o077)!==0||st.size<1||st.size>max)
    fail('RC012_NATIVE_BROKER_OWNER_FILE_INVALID');
  return fs.readFileSync(file);
}
function privateDir(dir,uid){
  const st=fs.lstatSync(dir);
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==uid
    ||(st.mode&0o077)!==0)
    fail('RC012_NATIVE_BROKER_OWNER_DIRECTORY_INVALID');
}
async function main(){
  if(process.platform!=='linux'||process.argv.length!==6
    ||process.env.RC012_NATIVE_BROKER_SCOPE!=='READ_ONLY_OWNER_WITNESS')
    fail('RC012_NATIVE_BROKER_SCOPE_REQUIRED');
  const [profile,pairDir,socketPath,keyFile]=process.argv.slice(2);
  if(!ID.test(profile)||!path.isAbsolute(pairDir)
    ||!path.isAbsolute(socketPath)||!path.isAbsolute(keyFile))
    fail('RC012_NATIVE_BROKER_ARGS_INVALID');
  const uid=process.getuid();
  privateDir(pairDir,uid);
  privateDir(path.dirname(socketPath),uid);
  privateDir(path.dirname(keyFile),uid);
  if(fs.existsSync(socketPath))fail('RC012_NATIVE_BROKER_SOCKET_ALREADY_USED');
  const signingKey=privateFile(keyFile,uid,8192).toString('utf8');
  const pinFile=path.join(pairDir,'owner-tunnel-trust.json');
  const pin=readLinuxOwnerTunnelPin({directory:pairDir});
  if(pin.profileId!==profile)fail('RC012_NATIVE_BROKER_PIN_PROFILE_MISMATCH');
  const firstPinSha=sha(privateFile(pinFile,uid,4096));
  const certSha=sha(new X509Certificate(
    privateFile(path.join(pairDir,'client.crt'),uid,65536)).raw);
  if(certSha!==pin.expectedClientLeafDerSha256)
    fail('RC012_NATIVE_BROKER_CERT_MISMATCH');
  const ownerV1=createLinuxNativeOwnerSessionProvider();
  const ownerV2=createLinuxNativeOwnerSessionProvider({
    ownerIdentityMode:'host-uid-v2'
  });
  const [s1,s2]=await Promise.all([
    ownerV1.getOwnerSessionSnapshot(),ownerV2.getOwnerSessionSnapshot()
  ]);
  const enrollment=resolveLinuxNativeWitnessEnrollmentMode({
    pinnedOwnerSidHash:pin.ownerSidHash,v1:s1,v2:s2
  });
  // Migration to stable v2 may have been separately approved already.
  // Always verify the enrolled PIN with its exact owner identity. The
  // short-lived signed broker witness itself is host-UID-v2, for parity
  // inside a hardened rootless Core namespace.
  const ownerForPin=enrollment.mode==='host-uid-v2'?ownerV2:ownerV1;
  const pinned=await createPinnedLinuxPrivateTunnelIdentity({
    directory:pairDir,resolveOwnerSidHash:ownerForPin.resolveOwnerSidHash
  });
  const v2Observer=createLinuxTunnelClientObserver({
    profileId:pin.profileId,expectedExecutablePath:pin.expectedExecutablePath,
    expectedExecutableSha256:pin.expectedExecutableSha256,
    healthPort:pin.healthPort,resolveOwnerSidHash:ownerV2.resolveOwnerSidHash
  });
  const v2=createNativeTunnelAttestor({
    hostId:pin.hostId,profileId:pin.profileId,
    expectedExecutablePath:pin.expectedExecutablePath,
    expectedExecutableSha256:pin.expectedExecutableSha256,
    resolveOwnerSidHash:ownerV2.resolveOwnerSidHash,
    ...v2Observer
  });
  let busy=false;
  const respond=(res,status,obj)=>{
    res.writeHead(status,{'content-type':'application/json',
      'cache-control':'no-store','x-content-type-options':'nosniff'});
    res.end(JSON.stringify(obj));
  };
  const server=http.createServer(async(req,res)=>{
    if(req.method!=='POST'||req.url!=='/attest'
      ||req.headers.origin!==undefined
      ||req.headers['content-type']!=='application/json')
      return respond(res,403,{error:'DENIED'});
    if(busy)return respond(res,429,{error:'BUSY'});
    busy=true;
    try{
      let data='',bytes=0;
      for await(const chunk of req){
        bytes+=chunk.length;
        if(bytes>512)fail('RC012_NATIVE_BROKER_REQUEST_BOUNDS');
        data+=chunk.toString('utf8');
      }
      let request;try{request=JSON.parse(data);}
      catch{fail('RC012_NATIVE_BROKER_REQUEST_INVALID');}
      if(!request||Object.keys(request).length!==2
        ||typeof request.nonce!=='string'
        ||!/^[a-f0-9]{64}$/.test(request.nonce)
        ||request.profile!==profile)
        fail('RC012_NATIVE_BROKER_REQUEST_INVALID');
      if(sha(privateFile(pinFile,uid,4096))!==firstPinSha)
        fail('RC012_NATIVE_BROKER_PIN_CHANGED');
      const [old,newProof,snapshot]=await Promise.all([
        pinned.resolveTransportIdentity(),v2.resolveTransportIdentity(),
        ownerV2.getOwnerSessionSnapshot()
      ]);
      if(!old.authenticated||!old.controlPlanePollOk
        ||!newProof.authenticated||!newProof.controlPlanePollOk
        ||snapshot.ownerSidHash!==s2.ownerSidHash
        ||snapshot.osSessionId!==s2.osSessionId
        ||snapshot.leaderPid!==s2.leaderPid)
        fail('RC012_NATIVE_BROKER_OWNER_OR_TUNNEL_CHANGED');
      const proc=await v2Observer.resolveOwnedTunnelProcess();
      const health=await v2Observer.probeTunnelHealth(proc);
      const claims=createLinuxNativeTunnelClaims({
        nonce:request.nonce,hostId:pin.hostId,profileId:pin.profileId,
        ownerSidHash:s2.ownerSidHash,tunnelIdHash:newProof.tunnelIdHash,
        clientLeafDerSha256:certSha,
        executableSha256:pin.expectedExecutableSha256,
        pinSha256:firstPinSha,pid:proc.pid,
        lastPollAtMs:health.lastPollAtMs
      });
      const packet=signLinuxNativeTunnelProof({
        claims,privateKeyPem:signingKey
      });
      return respond(res,200,packet);
    }catch(error){
      return respond(res,403,{error:'ATTESTATION_REFUSED'});
    }finally{busy=false;}
  });
  server.on('clientError',(_err,socket)=>socket.destroy());
  process.umask(0o077);
  server.listen(socketPath,()=>{
    fs.chmodSync(socketPath,0o600);
    console.log('RC012_OWNER_NATIVE_WITNESS_LISTENING_READ_ONLY',profile);
  });
  const stat=()=>{try{return fs.lstatSync(socketPath);}catch{return null;}};
  process.on('SIGTERM',()=>{
    const before=stat();
    server.close(()=>{
      const after=stat();
      if(before&&after&&before.ino===after.ino&&after.isSocket())
        fs.unlinkSync(socketPath);
    });
  });
}
main().catch(error=>{
  console.error(error?.code??'RC012_OWNER_NATIVE_WITNESS_START_FAILED');
  process.exitCode=2;
});
