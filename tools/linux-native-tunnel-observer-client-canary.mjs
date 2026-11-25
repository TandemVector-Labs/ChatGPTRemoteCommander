// One-shot isolated v0.12 Core-side verification of read-only OS process proof.
// The nonce and Ed25519 signature do not grant J01/Worker or tools.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {createLinuxNativeOwnerSessionProvider}
  from '../src/native-owner-session-provider-linux.mjs';
import {readLinuxOwnerTunnelPin}
  from '../src/linux-private-tunnel-owner-pin.mjs';
import {verifyLinuxNativeTunnelProof}
  from '../src/linux-native-tunnel-broker-proof.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const sha=b=>createHash('sha256').update(b).digest('hex');
function privateFile(file,uid,max=8192){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==uid
    ||stat.nlink!==1||(stat.mode&0o077)!==0
    ||stat.size<1||stat.size>max)
    fail('RC012_NATIVE_WITNESS_FILE_UNSAFE');
  return fs.readFileSync(file);
}
async function request(socketPath,nonce,profile){
  return new Promise((resolve,reject)=>{
    let length=0,body='';
    const req=http.request({
      socketPath,path:'/attest',method:'POST',timeout:4500,
      headers:{'content-type':'application/json'}
    },res=>{
      if(res.statusCode!==200){res.resume();reject(Error('BROKER_DENIED'));return;}
      res.on('data',chunk=>{
        length+=chunk.length;
        if(length>4096){req.destroy(Error('RESPONSE_TOO_LARGE'));return;}
        body+=chunk.toString('utf8');
      });
      res.on('end',()=>{try{resolve(JSON.parse(body));}catch(e){reject(e);}});
    });
    req.on('timeout',()=>req.destroy(Error('BROKER_TIMEOUT')));
    req.on('error',reject);
    req.end(JSON.stringify({nonce,profile}));
  });
}
async function main(){
  if(process.platform!=='linux'||process.argv.length!==6
    ||process.env.RC012_NATIVE_WITNESS_CLIENT_SCOPE!=='NO_TOOL_GRANT')
    fail('RC012_NATIVE_WITNESS_CLIENT_SCOPE_REQUIRED');
  const [profile,pairDir,socketPath,publicKeyPath]=process.argv.slice(2);
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)
    ||![pairDir,socketPath,publicKeyPath].every(path.isAbsolute))
    fail('RC012_NATIVE_WITNESS_CLIENT_ARGS_INVALID');
  const uid=process.getuid(),pinFile=path.join(pairDir,'owner-tunnel-trust.json');
  const pin=readLinuxOwnerTunnelPin({directory:pairDir});
  if(pin.profileId!==profile)fail('RC012_NATIVE_WITNESS_PROFILE_MISMATCH');
  const owner=createLinuxNativeOwnerSessionProvider({
    ownerIdentityMode:'host-uid-v2'
  });
  const seat=await owner.getOwnerSessionSnapshot();
  const nonce=randomBytes(32).toString('hex');
  const publicKeyPem=privateFile(publicKeyPath,uid,8192).toString('utf8');
  const pinSha256=sha(privateFile(pinFile,uid,4096));
  const packet=await request(socketPath,nonce,profile);
  const claims=verifyLinuxNativeTunnelProof({
    packet,publicKeyPem,
    expected:{
      nonce,hostId:pin.hostId,profileId:pin.profileId,
      ownerSidHash:seat.ownerSidHash,
      clientLeafDerSha256:pin.expectedClientLeafDerSha256,
      executableSha256:pin.expectedExecutableSha256,
      pinSha256
    }
  });
  const again=await owner.getOwnerSessionSnapshot();
  if(again.ownerSidHash!==seat.ownerSidHash
    ||again.osSessionId!==seat.osSessionId
    ||again.leaderPid!==seat.leaderPid)
    fail('RC012_NATIVE_WITNESS_OWNER_EPOCH_CHANGED');
  console.log(JSON.stringify({
    result:'RC012_NATIVE_TUNNEL_BROKER_PROOF_VERIFIED_PASS',
    profileId:profile,hostId:pin.hostId,
    nativePid:claims.pid,signatureVerified:true,
    ownerSeatVerified:true,liveTunnelBound:true,
    challengeFresh:true,privilegedToolGrantIssued:false,
    liveServiceChanged:false
  }));
}
main().catch(error=>{
  console.error(error?.code??'RC012_NATIVE_WITNESS_CLIENT_FAILED');
  process.exitCode=2;
});
