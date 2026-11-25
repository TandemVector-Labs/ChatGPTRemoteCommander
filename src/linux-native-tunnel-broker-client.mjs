// Read-only signed Unix-socket transport witness for hardened Linux Core.
// The witness is NOT a ChatGPT conversation binding, worker grant or tool token.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {verifyLinuxNativeTunnelProof}
  from './linux-native-tunnel-broker-proof.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH=/^[a-f0-9]{64}$/;
const digest=b=>createHash('sha256').update(b).digest('hex');
function privateOwnerPath(file,uid,kind,max=8192){
  if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))
    fail('RC012_NATIVE_WITNESS_PATH_INVALID');
  const dir=path.dirname(file),folder=fs.lstatSync(dir);
  if(!folder.isDirectory()||folder.isSymbolicLink()
    ||folder.uid!==uid||(folder.mode&0o077)!==0)
    fail('RC012_NATIVE_WITNESS_DIRECTORY_UNSAFE');
  const stat=fs.lstatSync(file);
  if(stat.isSymbolicLink()||stat.uid!==uid||(stat.mode&0o077)!==0
    ||(kind==='socket'&&!stat.isSocket())
    ||(kind==='file'&&(!stat.isFile()||stat.nlink!==1
      ||stat.size<1||stat.size>max)))
    fail('RC012_NATIVE_WITNESS_PATH_UNSAFE');
  return kind==='file'?fs.readFileSync(file):true;
}
function proofRequest(socketPath,nonce,profileId){
  return new Promise((resolve,reject)=>{
    let length=0,body='',done=false;
    const req=http.request({
      socketPath,path:'/attest',method:'POST',timeout:3300,
      headers:{'content-type':'application/json','accept':'application/json'}
    },res=>{
      if(res.statusCode!==200){
        res.resume();return reject(Error('RC012_NATIVE_WITNESS_DENIED'));
      }
      res.on('data',chunk=>{
        length+=chunk.length;
        if(length>4096){
          done=true;req.destroy(Error('RC012_NATIVE_WITNESS_RESPONSE_TOO_LARGE'));
        }else body+=chunk.toString('utf8');
      });
      res.on('end',()=>{
        if(done)return;
        try{resolve(JSON.parse(body));}
        catch{reject(Error('RC012_NATIVE_WITNESS_RESPONSE_INVALID'));}
      });
      res.on('error',reject);
    });
    req.on('timeout',()=>req.destroy(Error('RC012_NATIVE_WITNESS_TIMEOUT')));
    req.on('error',reject);
    req.end(JSON.stringify({nonce,profile:profileId}));
  });
}
export async function createLinuxSignedBrokerTransport({
  hostId,profileId,expectedOwnerSidHash,expectedClientLeafDerSha256,
  expectedExecutableSha256,pinFile,socketPath,publicKeyPath,
  resolveOwnerSidHash,now=Date.now
}={}){
  if(process.platform!=='linux'||![hostId,profileId].every(
    x=>typeof x==='string'&&ID.test(x)&&x!=='.'&&x!=='..')
    ||![expectedOwnerSidHash,expectedClientLeafDerSha256,
      expectedExecutableSha256].every(x=>typeof x==='string'&&HASH.test(x))
    ||typeof resolveOwnerSidHash!=='function'||typeof now!=='function')
    fail('RC012_NATIVE_WITNESS_CONFIG_INVALID');
  const uid=process.getuid();
  const trustedKey=privateOwnerPath(publicKeyPath,uid,'file',8192)
    .toString('utf8');
  const trustedPin=digest(privateOwnerPath(pinFile,uid,'file',4096));
  const expected=Object.freeze({
    hostId,profileId,ownerSidHash:expectedOwnerSidHash,
    clientLeafDerSha256:expectedClientLeafDerSha256,
    executableSha256:expectedExecutableSha256,pinSha256:trustedPin
  });
  async function fetchWitness(){
    privateOwnerPath(socketPath,uid,'socket');
    if(digest(privateOwnerPath(pinFile,uid,'file',4096))!==trustedPin)
      fail('RC012_NATIVE_WITNESS_PIN_CHANGED');
    const ownerBefore=await resolveOwnerSidHash();
    if(ownerBefore!==expectedOwnerSidHash)
      fail('RC012_NATIVE_WITNESS_OWNER_CHANGED');
    const nonce=randomBytes(32).toString('hex');
    const packet=await proofRequest(socketPath,nonce,profileId);
    const claims=verifyLinuxNativeTunnelProof({
      packet,publicKeyPem:trustedKey,
      expected:{nonce,...expected},now:now()
    });
    if(await resolveOwnerSidHash()!==ownerBefore)
      fail('RC012_NATIVE_WITNESS_OWNER_CHANGED');
    return claims;
  }
  const first=await fetchWitness();
  const expectedTunnelIdHash=first.tunnelIdHash;
  async function resolveTransportIdentity(){
    const current=await fetchWitness();
    if(current.tunnelIdHash!==expectedTunnelIdHash)
      fail('RC012_NATIVE_WITNESS_TUNNEL_INSTANCE_CHANGED');
    return Object.freeze({
      source:'native-tunnel-attestor',
      provider:'openai-secure-mcp-tunnel',
      profileId,ownerSidHash:expectedOwnerSidHash,
      tunnelIdHash:expectedTunnelIdHash,
      authenticated:true,controlPlanePollOk:true,
      healthzStatus:200,readyzStatus:200,
      lastPollAtMs:current.lastPollAtMs,expiresAtMs:current.expiresAtMs
    });
  }
  return Object.freeze({expectedTunnelIdHash,resolveTransportIdentity});
}
